"""检索、私人候选、持久导入与 ACL 同步工作循环。"""
import asyncio
import base64
import copy
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import select, func
from .models import Paper, User, now
from .discovery_models import DiscoveryConfiguration, LiteratureCandidate, PaperExternalIdentifier, PaperImportTask, LiteratureSourceSyncTask
from .ai_secrets import SecretStore
from .reading_service import fail, ReadingError
from . import services as svc
from .pdf_ingest import ingest_file
from .literature_providers import SourceHTTP, RemoteSources, identifier
from .acl_index import ACLIndex


ACTIVE = {"queued", "running", "retrying"}


def own_candidate(db, user, candidate_id):
    item = db.scalar(select(LiteratureCandidate).where(LiteratureCandidate.id == candidate_id,
        LiteratureCandidate.workspace_id == user.workspace_id, LiteratureCandidate.user_id == user.id))
    if item is None:
        fail("候选论文不存在或无法访问。", "candidate_not_found", 404)
    return item


def own_task(db, user, task_id):
    task = db.scalar(select(PaperImportTask).where(PaperImportTask.id == task_id,
        PaperImportTask.workspace_id == user.workspace_id, PaperImportTask.user_id == user.id))
    if task is None:
        fail("导入任务不存在或无法访问。", "task_not_found", 404)
    return task


def linked_paper(db, workspace_id, record):
    return db.scalar(select(Paper).join(PaperExternalIdentifier, PaperExternalIdentifier.paper_id == Paper.id).where(
        Paper.workspace_id == workspace_id, PaperExternalIdentifier.provider == record["provider"],
        PaperExternalIdentifier.source_id == record["source_id"]).order_by(Paper.created_at).limit(1))


def attach_candidate(db, user, candidate, paper):
    if paper.workspace_id != user.workspace_id or candidate.user_id != user.id:
        fail("不能跨空间关联论文。", "candidate_forbidden", 403)
    previous = linked_paper(db, user.workspace_id, candidate.record)
    if previous and previous.id != paper.id:
        fail("该来源已有关联论文，请打开已有记录核对文件版本。", "source_version_conflict", 409)
    if not db.scalar(select(PaperExternalIdentifier.id).where(PaperExternalIdentifier.paper_id == paper.id,
            PaperExternalIdentifier.provider == candidate.provider, PaperExternalIdentifier.source_id == candidate.source_id)):
        db.add(PaperExternalIdentifier(paper_id=paper.id, provider=candidate.provider, source_id=candidate.source_id, record=candidate.record))
    candidate.paper_id = paper.id


def candidate_view(db, item):
    paper = db.get(Paper, item.paper_id) if item.paper_id else linked_paper(db, item.workspace_id, item.record)
    return {"id": item.id, "record": item.record, "direction_ids": item.direction_ids, "saved": item.saved,
            "paper_id": paper.id if paper else None, "in_trash": paper.deleted_at is not None if paper else False, "created_at": item.created_at}


def task_view(task):
    return {key: getattr(task, key) for key in ["id", "candidate_id", "status", "phase", "attempt", "retry_of", "downloaded_bytes", "paper_id", "error", "created_at", "finished_at"]} | {"title": task.record.get("title", "")}


class DiscoveryService:
    def __init__(self, factory, lock, settings):
        self.factory, self.lock, self.settings = factory, lock, settings
        self.http = SourceHTTP()
        self.remote = RemoteSources(self.http)
        self.acl = ACLIndex(settings.data_dir / "literature-cache" / "acl")
        self.secrets = SecretStore(settings.data_dir)
        self.cache, self.records = {}, {}
        self.stop = threading.Event()
        self.last_auto_check = 0

    def recover(self):
        with self.lock, self.factory() as db:
            for model in [PaperImportTask, LiteratureSourceSyncTask]:
                for task in db.scalars(select(model).where(model.status.in_({"running", "retrying"}))):
                    task.status, task.error, task.finished_at = "failed", "服务重启时任务中断，请重试；已有论文和索引已保留。", now()
            db.commit()

    async def thread_work(self, call):
        pending = asyncio.create_task(asyncio.to_thread(call))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            self.stop.set()
            await asyncio.gather(pending, return_exceptions=True)
            raise

    def config_view(self, db, workspace_id):
        item = db.get(DiscoveryConfiguration, workspace_id)
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return {"provider": "ieee", "configured": bool(item and item.key_cipher), "revision": item.revision if item else 0,
            "test_status": item.test_status if item else "unconfigured", "tested_at": item.tested_at if item else None,
            "error": item.error if item else "", "daily_limit": item.daily_limit if item else 200,
            "calls_today": item.calls_count if item and item.calls_day == day else 0, "counter_day": day}

    def reserve_ieee(self, workspace_id):
        with self.lock, self.factory() as db:
            item = db.get(DiscoveryConfiguration, workspace_id)
            if item is None or not item.key_cipher:
                fail("先配置 IEEE 检索密钥，即可在看板搜索。", "provider_not_configured", 409)
            day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if item.calls_day != day:
                item.calls_day, item.calls_count = day, 0
            if item.calls_count >= item.daily_limit:
                fail("本机今日 IEEE 请求已达到设置上限，缓存和已有候选仍可使用。", "local_daily_limit", 429)
            key = self.secrets.decrypt(item.key_cipher)
            item.calls_count += 1
            db.commit()
            return key, item.revision

    async def search(self, user, provider, q, **options):
        page = options.pop("page", 1)
        cursor = options.pop("cursor", "")
        generation = None
        if cursor:
            try:
                decoded = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                page, generation = decoded["page"], decoded.get("generation")
                if type(page) is not int or not 1 <= page <= 10:
                    raise ValueError()
            except (ValueError, KeyError, TypeError, UnicodeError):
                fail("分页标识无效，请重新检索。", "invalid_cursor")
        if provider == "acl":
            if options.get("category") or options.get("date_from") or options.get("date_to"):
                fail("ACL 首版使用年份和会议筛选，不支持精确日期或 arXiv 分类。", "unsupported_filter")
            accepted = {k: v for k, v in options.items() if k in {"field", "sort", "year_from", "year_to", "venue", "volume_id"}}
            result = await asyncio.to_thread(self.acl.search, q, page=page, generation=generation, **accepted)
        else:
            if options.get("venue") or options.get("volume_id"):
                fail("该来源不支持 ACL 的会议筛选。", "unsupported_filter")
            if provider == "ieee" and (options.get("category") or options.get("date_from") or options.get("date_to") or options.get("field") == "abstract"):
                fail("IEEE 当前支持全部字段、标题、作者及年份筛选。", "unsupported_filter")
            with self.factory() as db:
                configuration = db.get(DiscoveryConfiguration, user.workspace_id)
                revision = configuration.revision if configuration else 0
            cache_key = (user.workspace_id, provider, revision, q, page, json.dumps(options, sort_keys=True))
            entry = self.cache.get(cache_key)
            if entry and entry[0] > time.monotonic():
                result = copy.deepcopy(entry[1])
                result["cached"] = True
            else:
                accepted = {k: v for k, v in options.items() if k in {"field", "sort", "year_from", "year_to", "category", "date_from", "date_to"}}
                if provider == "arxiv":
                    result = await self.remote.arxiv(q, page=page, **accepted)
                else:
                    key, revision = self.reserve_ieee(user.workspace_id)
                    accepted = {k: v for k, v in accepted.items() if k not in {"category", "date_from", "date_to"}}
                    result = await self.remote.ieee(q, key, page=page, **accepted)
                result["data_time"] = now()
                if len(self.cache) >= 128:
                    self.cache.pop(next(iter(self.cache)))
                self.cache[cache_key] = (time.monotonic() + 900, copy.deepcopy(result))
        with self.factory() as db:
            for record in result["items"]:
                if len(self.records) >= 3000:
                    self.records.pop(next(iter(self.records)))
                self.records[(user.workspace_id, provider, record["source_id"])] = (time.monotonic() + 900, copy.deepcopy(record))
                candidate = db.scalar(select(LiteratureCandidate).where(LiteratureCandidate.workspace_id == user.workspace_id,
                    LiteratureCandidate.user_id == user.id, LiteratureCandidate.provider == provider, LiteratureCandidate.source_id == record["source_id"]))
                paper = linked_paper(db, user.workspace_id, record)
                record["candidate_id"] = candidate.id if candidate else None
                record["saved"] = candidate.saved if candidate else False
                record["paper_id"] = paper.id if paper else None
                record["in_trash"] = paper.deleted_at is not None if paper else False
        result.update(provider=provider, page=page)
        more = page < 10 and page * 20 < result["total"] and bool(result["items"])
        result["next_cursor"] = base64.urlsafe_b64encode(json.dumps({"page": page + 1, "generation": result.get("index_generation")}).encode()).decode() if more else None
        return result

    async def get_record(self, user, provider, source_id):
        source_id = identifier(provider, source_id)
        if provider == "acl":
            return await asyncio.to_thread(self.acl.get_record, source_id)
        cached = self.records.get((user.workspace_id, provider, source_id))
        if cached and cached[0] > time.monotonic():
            return copy.deepcopy(cached[1])
        if provider == "arxiv":
            result = await self.remote.arxiv(source_id, exact=True)
        else:
            key, _ = self.reserve_ieee(user.workspace_id)
            result = await self.remote.ieee(source_id, key, exact=True)
        for record in result["items"]:
            if record["source_id"] == source_id or (provider == "arxiv" and "v" not in source_id and record["source_id"].startswith(source_id + "v")):
                return record
        fail("来源没有返回对应论文，请核对标识后重试。", "source_not_found", 404)

    def save_candidate(self, db, user, record, directions):
        with self.lock:
            svc.validate_labels(db, user.workspace_id, directions, "research_direction")
            item = db.scalar(select(LiteratureCandidate).where(LiteratureCandidate.workspace_id == user.workspace_id,
                LiteratureCandidate.user_id == user.id, LiteratureCandidate.provider == record["provider"], LiteratureCandidate.source_id == record["source_id"]))
            if item is None:
                if db.scalar(select(func.count()).select_from(LiteratureCandidate).where(LiteratureCandidate.user_id == user.id, LiteratureCandidate.saved.is_(True))) >= 1000:
                    fail("待导入清单已达 1000 条，请先整理。", "candidate_limit", 409)
                item = LiteratureCandidate(workspace_id=user.workspace_id, user_id=user.id, provider=record["provider"], source_id=record["source_id"], record=record, direction_ids=directions)
                db.add(item)
            else:
                item.saved, item.direction_ids = True, directions
            db.commit()
            return candidate_view(db, item)

    def enqueue_import(self, db, user, candidate, request_id, retry_of=None):
        with self.lock:
            old = db.scalar(select(PaperImportTask).where(PaperImportTask.workspace_id == user.workspace_id, PaperImportTask.user_id == user.id, PaperImportTask.request_id == request_id))
            if old:
                if old.candidate_id != candidate.id or old.retry_of != retry_of:
                    fail("同一请求标识不能用于不同导入。", "request_conflict", 409)
                return old
            existing = linked_paper(db, user.workspace_id, candidate.record)
            if existing:
                if existing.deleted_at is not None:
                    fail("该来源论文位于回收站，请先恢复。", "paper_trashed", 409)
                fail("该来源论文已入库，请打开已有论文。", "already_imported", 409, {"paper_id": existing.id})
            active = db.scalar(select(PaperImportTask).where(PaperImportTask.candidate_id == candidate.id, PaperImportTask.status.in_(ACTIVE)))
            if active:
                return active
            if candidate.provider in {"ieee", "citation"} or not candidate.record.get("pdf_url"):
                fail("请先通过机构或来源获取 PDF，再向该候选补传。", "institution_required", 409)
            svc.validate_labels(db, user.workspace_id, candidate.direction_ids, "research_direction")
            task = PaperImportTask(workspace_id=user.workspace_id, user_id=user.id, candidate_id=candidate.id,
                request_id=request_id, record=candidate.record, direction_ids=candidate.direction_ids, retry_of=retry_of)
            db.add(task)
            db.commit()
            return task

    async def process_import(self):
        with self.lock, self.factory() as db:
            task = db.scalar(select(PaperImportTask).where(PaperImportTask.status == "queued").order_by(PaperImportTask.created_at, PaperImportTask.id).limit(1))
            if task is None:
                return False
            task.status, task.phase, task.attempt = "running", "source", task.attempt + 1
            user = db.get(User, task.user_id)
            task_id, record, directions = task.id, copy.deepcopy(task.record), list(task.direction_ids)
            db.commit()
        temporary = self.settings.data_dir / "tmp" / ("upload-import-" + task_id + ".pdf")
        try:
            latest = await self.get_record(user, record["provider"], record["source_id"])
            if not latest.get("pdf_url") or latest["provider"] not in {"arxiv", "acl"}:
                fail("该论文需要手工获取原文后补传。", "institution_required", 409)

            async def progress(size):
                with self.lock, self.factory() as db:
                    current = db.get(PaperImportTask, task_id)
                    if current.status != "running":
                        fail("导入已取消。", "import_cancelled", 409)
                    current.phase, current.downloaded_bytes = "download", size
                    db.commit()

            for attempt in range(3):
                try:
                    await progress(0)
                    with temporary.open("wb") as output:
                        async with asyncio.timeout(120):
                            await self.http.fetch(latest["pdf_url"], limit=self.settings.max_file_bytes, output=output, progress=progress)
                    break
                except ReadingError as exc:
                    if exc.body["code"] not in {"source_timeout", "source_connection_failed", "source_unavailable"} or attempt == 2:
                        raise
                    with self.lock, self.factory() as db:
                        current = db.get(PaperImportTask, task_id)
                        if current.status != "running":
                            raise
                        current.phase, current.attempt = "retry_wait", current.attempt + 1
                        db.commit()
                    await asyncio.sleep(2 ** attempt)
            with self.lock, self.factory() as db:
                current = db.get(PaperImportTask, task_id)
                if current.status != "running":
                    fail("导入已取消。", "import_cancelled", 409)
                current.phase = "inspect"
                db.commit()

            def register():
                with self.factory() as db:
                    def finish(db, paper):
                        current = db.get(PaperImportTask, task_id, populate_existing=True)
                        if self.stop.is_set() or current.status != "running":
                            fail("任务已停止，原文件不会被登记。", "import_cancelled", 409)
                        candidate = own_candidate(db, user, current.candidate_id)
                        attach_candidate(db, user, candidate, paper)
                        current.status, current.phase, current.paper_id, current.finished_at = "succeeded", "registered", paper.id, now()
                    ingest_file(db, self.settings, self.lock, user, temporary, record["source_id"].replace("/", "-") + ".pdf", directions, latest, finish)
            await self.thread_work(register)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            message = exc.body["detail"] if isinstance(exc, ReadingError) else "下载或文件检查未完成，请重试或补传 PDF。"
            with self.lock, self.factory() as db:
                current = db.get(PaperImportTask, task_id)
                if current.status == "running":
                    current.status, current.error, current.finished_at = "failed", message, now()
                    db.commit()
        finally:
            temporary.unlink(missing_ok=True)
        return True

    def sync_status(self, db):
        state = self.acl.state()
        task = db.scalar(select(LiteratureSourceSyncTask).order_by(LiteratureSourceSyncTask.created_at.desc(), LiteratureSourceSyncTask.id.desc()).limit(1))
        return {**state, "ready": bool(state), "venues": self.acl.facets(), "task": None if task is None else
            {k: getattr(task, k) for k in ["id", "status", "phase", "processed", "source_revision", "error", "created_at", "finished_at"]}}

    def enqueue_sync(self, db, user, request_id):
        with self.lock:
            existing = db.scalar(select(LiteratureSourceSyncTask).where(LiteratureSourceSyncTask.request_id == request_id))
            if existing:
                if existing.user_id != user.id or existing.workspace_id != user.workspace_id:
                    fail("同步请求标识冲突。", "request_conflict", 409)
                return existing
            active = db.scalar(select(LiteratureSourceSyncTask).where(LiteratureSourceSyncTask.status.in_(ACTIVE)))
            if active:
                return active
            task = LiteratureSourceSyncTask(workspace_id=user.workspace_id, user_id=user.id, request_id=request_id)
            db.add(task)
            db.commit()
            return task

    async def git(self, *args, timeout=600):
        process = await asyncio.create_subprocess_exec("git", *map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout)
        except BaseException:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise
        if process.returncode:
            fail("ACL 官方元数据同步失败，请检查 Git 与 GitHub 网络连接后重试。", "acl_sync_failed", 503)
        return output.decode("utf-8", errors="replace").strip()

    async def process_sync(self):
        with self.lock, self.factory() as db:
            task = db.scalar(select(LiteratureSourceSyncTask).where(LiteratureSourceSyncTask.status == "queued").order_by(LiteratureSourceSyncTask.created_at).limit(1))
            if task is None:
                return False
            task_id = task.id
            task.status, task.phase = "running", "fetch"
            db.commit()
        try:
            repo = self.acl.root / "repository"
            if not (repo / ".git").is_dir():
                if repo.exists() and any(repo.iterdir()):
                    # 只移动已核对位于当前索引缓存中的失败副本，保留文件供排查。
                    if repo.resolve().parent != self.acl.root.resolve() or repo.is_symlink():
                        fail("ACL 缓存路径异常，请检查数据目录。", "unsafe_cache_path", 409)
                    repo.rename(self.acl.root / ("incomplete-" + uuid.uuid4().hex))
                await self.git("clone", "--depth", "1", "--single-branch", "https://github.com/acl-org/acl-anthology.git", repo)
            else:
                await self.git("-c", "safe.directory=" + str(repo.resolve()), "-C", repo, "fetch", "--depth", "1", "origin", "master")
                await self.git("-c", "safe.directory=" + str(repo.resolve()), "-C", repo, "reset", "--hard", "FETCH_HEAD")
            revision = await self.git("-c", "safe.directory=" + str(repo.resolve()), "-C", repo, "rev-parse", "HEAD")
            changed = None
            previous = self.acl.state()
            if previous and previous["source_revision"] != revision:
                try:
                    changes = (await self.git("-c", "safe.directory=" + str(repo.resolve()), "-C", repo, "diff", "--name-only", previous["source_revision"], revision, "--", "data")).splitlines()
                    if changes and all(p.startswith("data/xml/") and p.endswith(".xml") for p in changes):
                        changed = {Path(p).stem for p in changes}
                except ReadingError:
                    pass

            def progress(count):
                if self.stop.is_set():
                    fail("同步已停止，旧索引保持可用。", "sync_stopped", 409)
                with self.lock, self.factory() as db:
                    current = db.get(LiteratureSourceSyncTask, task_id)
                    current.phase, current.processed, current.source_revision = "index", count, revision
                    db.commit()

            def build():
                from acl_anthology import Anthology
                anthology = Anthology(datadir=repo / "data", verbose=False)
                return self.acl.build(anthology, revision, progress, changed)
            await self.thread_work(build)
            with self.lock, self.factory() as db:
                current = db.get(LiteratureSourceSyncTask, task_id)
                current.status, current.phase, current.finished_at = "succeeded", "ready", now()
                db.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            with self.lock, self.factory() as db:
                current = db.get(LiteratureSourceSyncTask, task_id)
                current.status, current.error, current.finished_at = "failed", exc.body["detail"] if isinstance(exc, ReadingError) else "ACL 解析或索引失败，请检查依赖与磁盘后重试；旧索引已保留。", now()
                db.commit()
        return True

    async def run(self):
        self.recover()
        async def loop(sync):
            while True:
                if sync and self.acl.state() and time.monotonic() - self.last_auto_check > 3600:
                    self.last_auto_check = time.monotonic()
                    if self.acl.state().get("checked_at", 0) < now() - 86400:
                        with self.factory() as db:
                            user = db.get(User, 1)
                            if user:
                                self.enqueue_sync(db, user, uuid.uuid4().hex)
                worked = await (self.process_sync() if sync else self.process_import())
                await asyncio.sleep(.2 if worked else 1)
        tasks = [asyncio.create_task(loop(False)), asyncio.create_task(loop(True))]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
