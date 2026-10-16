"""联网发现 API；来源错误、私人候选与机构认证分别处理。"""
import hashlib
import json
import re
from datetime import date
from typing import Literal
from fastapi import APIRouter, Depends, Query, UploadFile, File
from pydantic import BaseModel, Field, SecretStr, StrictInt, field_validator
from sqlalchemy import select
from .models import now
from .discovery_models import DiscoveryConfiguration, InstitutionAccessProfile, LiteratureCandidate, PaperImportTask, LiteratureSourceSyncTask
from .discovery_service import own_candidate, own_task, candidate_view, task_view, ACTIVE
from .literature_providers import LiteratureRecord, text, year_of
from .reading_service import fail, ReadingError


class RequestId(BaseModel):
    request_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class CandidateCreate(BaseModel):
    provider: Literal["arxiv", "acl", "ieee", "citation"]
    source_id: str = Field(min_length=1, max_length=200)
    direction_ids: list[StrictInt] = Field(default_factory=list, max_length=10)
    record: LiteratureRecord | None = None

    @field_validator("direction_ids")
    @classmethod
    def directions(cls, values):
        if any(value < 1 for value in values) or len(set(values)) != len(values):
            raise ValueError("研究方向标识无效")
        return values


class ImportCreate(RequestId):
    candidate_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ConfigUpdate(BaseModel):
    revision: int = Field(ge=0)
    api_key: SecretStr | None = None
    clear_key: bool = False
    daily_limit: int = Field(default=200, ge=1, le=200)

    @field_validator("api_key")
    @classmethod
    def key_format(cls, value):
        if value and (len(value.get_secret_value()) > 4096 or any(c.isspace() for c in value.get_secret_value())):
            raise ValueError("密钥格式无效")
        return value


class InstitutionUpdate(BaseModel):
    mode: Literal["webvpn", "campus"]


def citation_records(content, filename):
    entries = []
    if filename.lower().endswith(".ris"):
        current = {}
        for line in content.splitlines():
            match = re.match(r"^([A-Z0-9]{2})  - ?(.*)$", line)
            if not match:
                continue
            key, value = match.groups()
            if key == "TY":
                current = {}
            elif key == "ER":
                if current:
                    entries.append(current)
                current = {}
            else:
                current.setdefault(key, []).append(value)
        if current:
            entries.append(current)
        entries = [{"title": (r.get("TI") or r.get("T1") or [""])[0], "author": r.get("AU", []),
                    "abstract": " ".join(r.get("AB", [])), "doi": (r.get("DO") or [""])[0], "year": (r.get("PY") or r.get("Y1") or [""])[0]} for r in entries]
    elif filename.lower().endswith((".bib", ".bibtex")):
        import bibtexparser
        parsed = bibtexparser.parse_string(content)
        if parsed.failed_blocks:
            fail("引文格式不完整，请重新导出 RIS 或 BibTeX。", "citation_invalid")
        def value(entry, name):
            field = entry.get(name)
            return field.value if field is not None else ""
        entries = [{"title": value(e, "title"), "author": value(e, "author").split(" and "), "abstract": value(e, "abstract"),
                    "doi": value(e, "doi"), "year": value(e, "year")} for e in parsed.entries]
    else:
        fail("请选择 RIS 或 BibTeX 引文文件。", "citation_invalid")
    if not entries or len(entries) > 20:
        fail("每份引文需要包含 1～20 条记录，请缩小导出范围。", "citation_limit")
    result = []
    for entry in entries:
        title = text(entry["title"], 500)
        if not title:
            fail("引文缺少标题，请核对后重新导出。", "citation_invalid")
        doi = text(entry["doi"], 200).removeprefix("https://doi.org/")
        if doi and not re.fullmatch(r"10\.\d{4,9}/\S+", doi):
            doi = ""
        record = LiteratureRecord(provider="citation", source_id=hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest(),
            title=title, authors=[text(a, 200) for a in entry["author"] if text(a)][:100], abstract=text(entry["abstract"]),
            doi=doi or None, year=year_of(entry["year"]), url="https://doi.org/" + doi if doi else "", access="manual")
        result.append(record.model_dump())
    return result


def build_discovery_router(database, require_user, lock, service):
    router = APIRouter(prefix="/api/v1")

    @router.get("/settings/discovery-providers")
    def configuration(user=Depends(require_user), db=Depends(database)):
        return service.config_view(db, user.workspace_id)

    @router.put("/settings/discovery-providers/ieee")
    def save_configuration(payload: ConfigUpdate, user=Depends(require_user), db=Depends(database)):
        with lock:
            item = db.get(DiscoveryConfiguration, user.workspace_id)
            if payload.revision != (item.revision if item else 0):
                fail("其他页面已修改检索设置，请刷新后重试。", "configuration_conflict", 409)
            if item is None:
                item = DiscoveryConfiguration(workspace_id=user.workspace_id)
                db.add(item)
                db.flush()
            if payload.clear_key or payload.api_key and payload.api_key.get_secret_value():
                item.key_cipher = "" if payload.clear_key else service.secrets.encrypt(payload.api_key.get_secret_value())
                item.test_status, item.tested_at, item.error = "untested", None, ""
            item.daily_limit, item.revision = payload.daily_limit, item.revision + 1
            db.commit()
            return service.config_view(db, user.workspace_id)

    @router.post("/settings/discovery-providers/ieee/test")
    async def test_configuration(user=Depends(require_user)):
        key, revision = service.reserve_ieee(user.workspace_id)
        error = None
        try:
            # 密钥仅在服务端传递，不写入测试结果和错误文本。
            await service.remote.ieee("memory", key, page=1)
        except ReadingError as exc:
            error = exc
        with lock, service.factory() as db:
            item = db.get(DiscoveryConfiguration, user.workspace_id)
            if item.revision != revision:
                fail("检索密钥已修改，请使用新配置重新测试。", "configuration_conflict", 409)
            item.test_status, item.tested_at, item.error = "failed" if error else "passed", now(), error.body["detail"] if error else ""
            db.commit()
            result = service.config_view(db, user.workspace_id)
        if error:
            raise error
        return result

    @router.get("/settings/institution-access")
    def institution(user=Depends(require_user), db=Depends(database)):
        item = db.get(InstitutionAccessProfile, user.workspace_id)
        mode = item.mode if item else "webvpn"
        return {"name": "电子科技大学", "mode": mode, "portal_url": "https://vpn.uestc.edu.cn/" if mode == "webvpn" else "https://ieeexplore.ieee.org/"}

    @router.put("/settings/institution-access")
    def update_institution(payload: InstitutionUpdate, user=Depends(require_user), db=Depends(database)):
        with lock:
            item = db.get(InstitutionAccessProfile, user.workspace_id)
            if item is None:
                item = InstitutionAccessProfile(workspace_id=user.workspace_id, mode=payload.mode)
                db.add(item)
            item.mode = payload.mode
            db.commit()
        return institution(user, db)

    @router.get("/discovery/providers")
    def providers(user=Depends(require_user), db=Depends(database)):
        return {"arxiv": {"ready": True}, "ieee": service.config_view(db, user.workspace_id), "acl": service.sync_status(db)}

    @router.get("/discovery/search")
    async def search(provider: Literal["arxiv", "acl", "ieee"], q: str = Query(min_length=1, max_length=500),
                     field: Literal["all", "title", "author", "abstract"] = "all", sort: Literal["relevance", "year_desc"] = "relevance",
                     year_from: int | None = Query(None, ge=1800, le=2100), year_to: int | None = Query(None, ge=1800, le=2100),
                     category: str = Query("", max_length=40), venue: str = Query("", max_length=500), volume_id: str = Query("", max_length=128),
                     date_from: str = Query("", max_length=10), date_to: str = Query("", max_length=10), cursor: str = Query("", max_length=500), user=Depends(require_user)):
        q = q.strip()
        if not q:
            fail("请输入关键词或来源标识。", "invalid_query")
        if year_from and year_to and year_from > year_to:
            fail("起始年份不能晚于结束年份。", "invalid_filter")
        try:
            dates = [date.fromisoformat(value) for value in [date_from, date_to] if value]
            if len(dates) == 2 and dates[0] > dates[1]:
                raise ValueError()
        except ValueError:
            fail("日期格式或起止顺序无效。", "invalid_filter")
        return await service.search(user, provider, q, field=field, sort=sort, year_from=year_from, year_to=year_to,
                                    category=category, venue=venue, volume_id=volume_id, date_from=date_from, date_to=date_to, cursor=cursor)

    @router.get("/discovery/providers/acl/status")
    def acl_status(user=Depends(require_user), db=Depends(database)):
        return service.sync_status(db)

    @router.post("/discovery/providers/acl/sync", status_code=202)
    def acl_sync(payload: RequestId, user=Depends(require_user), db=Depends(database)):
        # 个人版仅所有者可以触发公共源同步。
        if user.id != 1:
            fail("只有空间所有者可以更新来源索引。", "forbidden", 403)
        task = service.enqueue_sync(db, user, payload.request_id)
        return {"id": task.id, "status": task.status}

    @router.post("/discovery/candidates")
    async def save_candidate(payload: CandidateCreate, user=Depends(require_user), db=Depends(database)):
        if payload.provider == "citation":
            if not payload.record or payload.record.provider != "citation" or payload.source_id != payload.record.source_id:
                fail("引文记录无效，请重新预览。", "citation_invalid")
            record = payload.record.model_dump()
            record["url"] = "https://doi.org/" + record["doi"] if record.get("doi") and re.fullmatch(r"10\.\d{4,9}/\S+", record["doi"]) else ""
            record["pdf_url"], record["access"] = None, "manual"
        else:
            record = await service.get_record(user, payload.provider, payload.source_id)
        return service.save_candidate(db, user, record, payload.direction_ids)

    @router.get("/discovery/candidates")
    def candidates(user=Depends(require_user), db=Depends(database)):
        items = db.scalars(select(LiteratureCandidate).where(LiteratureCandidate.workspace_id == user.workspace_id,
            LiteratureCandidate.user_id == user.id, LiteratureCandidate.saved.is_(True)).order_by(LiteratureCandidate.created_at.desc()).limit(1000)).all()
        return [candidate_view(db, item) for item in items]

    @router.delete("/discovery/candidates/{candidate_id}")
    def remove_candidate(candidate_id: str, user=Depends(require_user), db=Depends(database)):
        with lock:
            item = own_candidate(db, user, candidate_id)
            item.saved = False
            db.commit()
        return {"ok": True}

    @router.post("/discovery/citation-previews")
    async def citation_preview(file: UploadFile = File(), user=Depends(require_user)):
        try:
            raw = await file.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                fail("引文文件不能超过 2 MiB。", "citation_limit", 413)
            try:
                content = raw.decode("utf-8-sig")
            except UnicodeError:
                fail("请选择 UTF-8 编码的引文文件。", "citation_encoding")
            return citation_records(content, file.filename or "")
        finally:
            await file.close()

    @router.post("/paper-imports", status_code=202)
    def import_paper(payload: ImportCreate, user=Depends(require_user), db=Depends(database)):
        candidate = own_candidate(db, user, payload.candidate_id)
        return task_view(service.enqueue_import(db, user, candidate, payload.request_id))

    @router.get("/paper-imports")
    def imports(user=Depends(require_user), db=Depends(database)):
        return [task_view(t) for t in db.scalars(select(PaperImportTask).where(PaperImportTask.workspace_id == user.workspace_id,
            PaperImportTask.user_id == user.id).order_by(PaperImportTask.created_at.desc()).limit(100))]

    @router.get("/paper-imports/{task_id}")
    def import_status(task_id: str, user=Depends(require_user), db=Depends(database)):
        return task_view(own_task(db, user, task_id))

    @router.post("/paper-imports/{task_id}/cancel")
    def cancel_import(task_id: str, user=Depends(require_user), db=Depends(database)):
        with lock:
            task = own_task(db, user, task_id)
            if task.status in ACTIVE:
                task.status, task.phase, task.finished_at = "cancelled", "cancelled", now()
                db.commit()
        return task_view(task)

    @router.post("/paper-imports/{task_id}/retry", status_code=202)
    def retry_import(task_id: str, payload: RequestId, user=Depends(require_user), db=Depends(database)):
        task = own_task(db, user, task_id)
        if task.status not in {"failed", "cancelled"}:
            return task_view(task)
        return task_view(service.enqueue_import(db, user, own_candidate(db, user, task.candidate_id), payload.request_id, task.id))

    return router
