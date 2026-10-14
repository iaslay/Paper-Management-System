"""个人论文库与阅读记录 API，原文和笔记通过同一会话保护。"""

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import FastAPI, Request, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, delete, func
from sqlalchemy.exc import IntegrityError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.concurrency import run_in_threadpool

from .config import Settings, PROJECT_ROOT
from .database import connect_database, migrate
from .models import Workspace, User, SessionToken, LoginAttempt, Paper, PaperTag, Tag, TagName, ReadingMutationReceipt, ModelCall, now
from .schemas import Setup, Credentials, PaperUpdate, TagInput, TagUpdate, MergeInput, BatchInput, DirectionInput
from . import services as svc
from . import reading_service as reading
from .reading_api import build_reading_router
from .ai_api import build_ai_router, cancel_task
from .ai_worker import CardRunner
from .ai_schemas import TaskCreate
from . import ai_service as ai
from . import ai_metadata
from .translation import TranslationService, build_translation_router
from .discussion import build_discussion_router

COOKIE = "paperboard_session"
PASSWORDS = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
DUMMY_HASH = PASSWORDS.hash(secrets.token_urlsafe(24))


def create_app(settings=None):
    settings = settings or Settings.from_env()
    engine, factory = connect_database(settings)
    write_lock = threading.RLock()
    card_runner = CardRunner(factory, write_lock, settings)
    translation_service = TranslationService(settings)

    def cleanup():
        with write_lock, factory() as db:
            expired = db.scalars(select(Paper).where(Paper.deleted_at.is_not(None), Paper.deleted_at < now() - 30 * 86400)).all()
            hashes = [paper.file_hash for paper in expired]
            for paper in expired:
                reading.remove_paper(db, paper)
            db.execute(delete(SessionToken).where(SessionToken.expires_at < now()))
            db.execute(delete(LoginAttempt).where(LoginAttempt.created_at < now() - 600))
            db.execute(delete(ReadingMutationReceipt).where(ReadingMutationReceipt.created_at < now() - 30 * 86400))
            db.execute(delete(ai.GenerationTask).where(ai.GenerationTask.status.not_in(ai.ACTIVE), ai.GenerationTask.finished_at < now() - 30 * 86400))
            db.execute(delete(ModelCall).where(ModelCall.task_id.is_(None), ModelCall.budget_month != ai.month_key(), ModelCall.created_at < now() - 31 * 86400))
            db.commit()
            with suppress(OSError):
                reading.remove_unreferenced_files(db, settings.data_dir, hashes)
        temporary_root = (settings.data_dir / "tmp").resolve()
        for temporary in temporary_root.iterdir():
            with suppress(OSError):
                # 只清理本系统的临时文件，递归删除前检查绝对路径和标记。
                if temporary.is_symlink() or temporary.resolve().parent != temporary_root or temporary.stat().st_mtime >= now() - 3600:
                    continue
                if temporary.is_file() and temporary.name.startswith("upload-") and temporary.suffix == ".pdf":
                    temporary.unlink()
                elif temporary.is_dir() and temporary.name.startswith(("card-input-", "model-test-")) and (temporary / ".paperboard-temporary").is_file():
                    shutil.rmtree(temporary)

    @asynccontextmanager
    async def lifespan(_):
        migrate(engine)
        await run_in_threadpool(cleanup)

        async def periodic_cleanup():
            while True:
                await asyncio.sleep(3600)
                await run_in_threadpool(cleanup)

        task = asyncio.create_task(periodic_cleanup())
        card_task = asyncio.create_task(card_runner.run()) if settings.ai_worker_enabled else None
        yield
        if card_task is not None:
            card_task.cancel()
            with suppress(asyncio.CancelledError):
                await card_task
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await translation_service.close()
        engine.dispose()

    app = FastAPI(title="研读 · 论文看板", version="0.4.1", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.card_runner = card_runner
    app.state.translation_service = translation_service
    app.state.settings = settings
    app.state.session_factory = factory
    app.state.engine = engine
    app.state.cleanup = cleanup
    hosts = {"localhost", "127.0.0.1", *[urlparse(origin).hostname for origin in settings.allowed_origins]}
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h for h in hosts if h])

    @app.middleware("http")
    async def guard_requests(request, call_next):
        if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("X-Paperboard-Request") != "1":
                return JSONResponse({"detail": "请求来源校验失败，请从论文看板重试。"}, status_code=403)
            origin = request.headers.get("origin")
            if origin and origin not in settings.allowed_origins:
                return JSONResponse({"detail": "不允许从其他网站修改个人论文库。"}, status_code=403)
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"detail": "请求长度无效。"}, status_code=400)
            if length > settings.max_file_bytes + 1024 * 1024:
                return JSONResponse({"detail": "文件超过允许大小，请压缩后重试。"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "private, no-store"
        if "text/html" in response.headers.get("content-type", ""):
            response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(_, exc):
        return JSONResponse({"detail": "输入格式或长度不符合要求，请检查页码、内容和显示设置后重试。", "code": "invalid_input"}, status_code=422)

    @app.exception_handler(reading.ReadingError)
    async def reading_error(_, exc):
        return JSONResponse(exc.body, status_code=exc.status)

    @app.exception_handler(IntegrityError)
    async def conflicting_write(_, exc):
        return JSONResponse({"detail": "记录或名称已存在，请刷新后重试。"}, status_code=409)

    def database():
        with factory() as db:
            yield db

    def current_user(request, db):
        token = request.cookies.get(COOKIE)
        if not token:
            return None
        session = db.get(SessionToken, hashlib.sha256(token.encode()).hexdigest())
        if session is None or session.expires_at <= now():
            return None
        return db.get(User, session.user_id)

    def require_user(request: Request, db=Depends(database)):
        user = current_user(request, db)
        if user is None:
            svc.fail("登录已过期，请重新登录后继续。", 401)
        return user

    app.include_router(build_reading_router(database, require_user, write_lock, settings))
    app.include_router(build_ai_router(database, require_user, write_lock, settings, card_runner))
    app.include_router(build_translation_router(database, require_user, translation_service))
    app.include_router(build_discussion_router(database, require_user, write_lock, settings))

    def user_view(db, user):
        workspace = db.get(Workspace, user.workspace_id)
        return {"username": user.username, "workspace_name": workspace.name, "quota_bytes": workspace.quota_bytes}

    def create_session(db, user, request):
        db.execute(delete(SessionToken).where(SessionToken.expires_at < now()))
        token = secrets.token_urlsafe(32)
        db.add(SessionToken(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id, expires_at=now() + settings.session_seconds))
        db.commit()
        response = JSONResponse({"user": user_view(db, user)})
        response.set_cookie(COOKIE, token, max_age=settings.session_seconds, httponly=True, samesite="lax", secure=settings.secure_cookie or request.url.scheme == "https")
        return response

    @app.get("/api/v1/health")
    def health():
        return {"status": "ok", "stage": "cards", "version": "0.4.1"}

    @app.get("/api/v1/status")
    def status(request: Request, db=Depends(database)):
        user = current_user(request, db)
        return {"initialized": db.get(User, 1) is not None, "user": user_view(db, user) if user else None}

    @app.post("/api/v1/setup")
    def setup(payload: Setup, request: Request, db=Depends(database)):
        with write_lock:
            if db.get(User, 1):
                svc.fail("论文库已初始化，请使用已有账号登录。", 409)
            workspace = Workspace(id=1, name=payload.workspace_name, quota_bytes=settings.quota_bytes)
            db.add(workspace)
            db.flush()
            user = User(id=1, workspace_id=1, username=payload.username, password_hash=PASSWORDS.hash(payload.password))
            db.add(user)
            db.flush()
            return create_session(db, user, request)

    @app.post("/api/v1/session")
    def login(payload: Credentials, request: Request, db=Depends(database)):
        with write_lock:
            address = hashlib.sha256((request.client.host if request.client else "local").encode()).hexdigest()
            attempts = db.scalar(select(func.count()).select_from(LoginAttempt).where(LoginAttempt.address_hash == address, LoginAttempt.created_at > now() - 600))
            if attempts >= 5:
                svc.fail("登录失败次数过多，请在 10 分钟后重试。", 429)
            user = db.scalar(select(User).where(User.username == payload.username))
            try:
                valid = PASSWORDS.verify(user.password_hash if user else DUMMY_HASH, payload.password) and user is not None
            except VerificationError:
                valid = False
            if not valid:
                db.add(LoginAttempt(address_hash=address))
                db.commit()
                svc.fail("登录失败，请检查用户名和密码。", 401)
            db.execute(delete(LoginAttempt).where(LoginAttempt.address_hash == address))
            return create_session(db, user, request)

    @app.delete("/api/v1/session")
    def logout(request: Request, db=Depends(database)):
        token = request.cookies.get(COOKIE)
        if token:
            db.execute(delete(SessionToken).where(SessionToken.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            db.commit()
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE)
        return response

    @app.get("/api/v1/papers")
    def papers(q: str = Query("", max_length=200), status: Literal["unread", "reading", "read"] | None = None,
               direction_ids: list[int] = Query(default=[], alias="research_direction_ids"), direction_match: Literal["any", "all"] = "any",
               unclassified_only: bool = False, topic_id: int | None = None, tag_id: int | None = None,
               favorite: bool = False, year: int | None = None, trash: bool = False,
               sort: Literal["updated", "created", "year", "title", "recent_read"] = "updated",
               page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), user=Depends(require_user), db=Depends(database)):
        return svc.list_papers(db, user.workspace_id, user_id=user.id, q=q, status=status, direction_ids=direction_ids, match=direction_match, unclassified=unclassified_only, topic_id=topic_id, tag_id=tag_id, favorite=favorite, year=year, trash=trash, sort=sort, page=page, page_size=page_size)

    @app.post("/api/v1/papers")
    async def upload(file: UploadFile = File(), direction_ids: str = Form("[]"), user=Depends(require_user), db=Depends(database)):
        filename = (file.filename or "论文.pdf").replace("\\", "/").split("/")[-1]
        if not filename.lower().endswith(".pdf") or len(filename) > 255:
            svc.fail("请选择文件名不超过 255 个字符的 PDF 文件。")
        try:
            ids = json.loads(direction_ids)
            if not isinstance(ids, list) or len(ids) > 10 or any(type(item) is not int or item < 1 for item in ids):
                raise ValueError()
        except (ValueError, TypeError):
            svc.fail("研究方向格式无效，请重新选择。")
        svc.validate_labels(db, user.workspace_id, ids, "research_direction")
        temporary = settings.data_dir / "tmp" / ("upload-" + uuid.uuid4().hex + ".pdf")
        size, digest = 0, hashlib.sha256()
        try:
            with temporary.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_file_bytes:
                        svc.fail("文件超过 50 MiB，请压缩后重新上传。", 413)
                    output.write(chunk)
                    digest.update(chunk)
            if size == 0:
                svc.fail("文件为空，请重新选择 PDF。")
            file_hash = digest.hexdigest()
            existing = db.scalar(select(Paper).where(Paper.workspace_id == user.workspace_id, Paper.file_hash == file_hash))
            if existing:
                if existing.deleted_at is not None:
                    svc.fail("这份文件位于回收站，请先恢复已有论文。", 409)
                return {"paper": svc.paper_view(db, existing), "duplicate": True}

            def inspect():
                try:
                    result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("pdf_inspect.py")), str(temporary)], capture_output=True, text=True, encoding="utf-8", timeout=20)
                    if result.returncode != 0:
                        return {"error": "PDF 检查失败，请检查文件后重试。"}
                    return json.loads(result.stdout)
                except (subprocess.TimeoutExpired, ValueError):
                    return {"error": "PDF 检查超时或返回异常，请尝试较小的文件。"}

            info = await run_in_threadpool(inspect)
            if "error" in info:
                svc.fail(info["error"])
            if info["page_count"] > settings.max_pages:
                svc.fail("论文超过 300 页，请拆分后重新上传。")
            with write_lock:
                db.expire_all()
                workspace = db.scalar(select(Workspace).where(Workspace.id == user.workspace_id).with_for_update())
                existing = db.scalar(select(Paper).where(Paper.workspace_id == user.workspace_id, Paper.file_hash == file_hash))
                if existing:
                    if existing.deleted_at is not None:
                        svc.fail("这份文件位于回收站，请先恢复已有论文。", 409)
                    return {"paper": svc.paper_view(db, existing), "duplicate": True}
                used = db.scalar(select(func.coalesce(func.sum(Paper.file_size), 0)).where(Paper.workspace_id == user.workspace_id))
                if used + size > workspace.quota_bytes:
                    svc.fail("个人空间容量不足，请先整理回收站或调整容量。", 413)
                svc.validate_labels(db, user.workspace_id, ids, "research_direction")
                target = settings.data_dir / "files" / (file_hash + ".pdf")
                os.replace(temporary, target)
                paper = Paper(workspace_id=user.workspace_id, title=info["title"] or filename[:-4], authors=info["authors"], authors_search="\n".join(info["authors"]), original_filename=filename, file_hash=file_hash, file_size=size, page_count=info["page_count"])
                db.add(paper)
                db.flush()
                reading.insert_sources(db, paper, info.get("page_sources", []))
                svc.set_labels(db, paper, direction_ids=ids)
                db.commit()
                return JSONResponse({"paper": svc.paper_view(db, paper), "duplicate": False}, status_code=201)
        finally:
            await file.close()
            temporary.unlink(missing_ok=True)

    @app.get("/api/v1/papers/{paper_id}")
    def paper_detail(paper_id: str, user=Depends(require_user), db=Depends(database)):
        return svc.paper_view(db, svc.get_paper(db, user.workspace_id, paper_id, True), user.id)

    @app.patch("/api/v1/papers/{paper_id}")
    def update_paper(paper_id: str, payload: PaperUpdate, user=Depends(require_user), db=Depends(database)):
        def apply(paper, _):
            previous_status = paper.reading_status
            svc.check_revision(paper, payload.revision)
            if payload.file_hash:
                reading.check_file(paper, payload.file_hash)
            supplied = payload.model_fields_set
            for field in ["title", "authors", "reading_status", "is_favorite"]:
                if field in supplied:
                    value = getattr(payload, field)
                    if value is None:
                        svc.fail("标题、作者、阅读状态和收藏状态不能设为空值。")
                    setattr(paper, field, value)
            if "authors" in supplied:
                paper.authors_search = "\n".join(paper.authors)
            for field in ["year", "doi"]:
                if field in supplied:
                    value = getattr(payload, field)
                    if field == "doi" and value:
                        value = value.strip().removeprefix("https://doi.org/").removeprefix("http://doi.org/")
                    setattr(paper, field, value or None)
            label_ids = {"research_direction": payload.research_direction_ids, "general": payload.tag_ids, "topic": payload.topic_ids}
            resolved = ai_metadata.resolve_new_labels(db, user.workspace_id, payload.new_labels)
            for kind, ids in resolved.items():
                if ids:
                    existing = label_ids[kind] if label_ids[kind] is not None else list(db.scalars(select(Tag.id).join(PaperTag, PaperTag.tag_id == Tag.id).where(PaperTag.paper_id == paper.id, Tag.kind == kind, Tag.deleted_at.is_(None))))
                    label_ids[kind] = list(set(existing) | set(ids))
            svc.set_labels(db, paper, label_ids["research_direction"], label_ids["general"], label_ids["topic"])
            if "reading_status" in supplied:
                paper.completed_at = (paper.completed_at or now()) if paper.reading_status == "read" else None
            paper.revision += 1
            paper.updated_at = now()
            generation_notice = None
            if previous_status != "read" and paper.reading_status == "read":
                configuration = ai.latest_config(db, user.workspace_id)
                if configuration and configuration.settings_json["enabled"] and configuration.settings_json["auto_on_read"] and db.get(ai.PaperCard, paper.id) is None:
                    try:
                        with db.begin_nested():
                            queued = ai.enqueue(db, user, paper, TaskCreate(request_id=uuid.uuid4().hex), settings, automatic=True)
                            generation_notice = {"task_id": queued.id, "message": "已读状态已保存，简介卡片已加入生成队列。"}
                    except reading.ReadingError as error:
                        generation_notice = {"message": "已读状态已保存；卡片未启动：" + error.body["detail"]}
            result = svc.paper_view(db, paper)
            result["resolved_labels"] = [{"kind": kind, "name": value.name, "id": tag_id} for kind, ids in resolved.items() for value, tag_id in zip([value for value in payload.new_labels if value.kind == kind], ids)]
            if generation_notice:
                result["card_generation_notice"] = generation_notice
            return result, paper.id

        with write_lock:
            if payload.request_id:
                result, code = reading.mutation(db, user, "PATCH/paper-info/" + paper_id, payload, apply, "paper_info", paper_id=paper_id)
                return JSONResponse(result, status_code=code)
            paper = svc.get_paper(db, user.workspace_id, paper_id)
            result, _ = apply(paper, None)
            db.commit()
            return result

    @app.put("/api/v1/papers/{paper_id}/research-directions")
    def update_directions(paper_id: str, payload: DirectionInput, user=Depends(require_user), db=Depends(database)):
        return update_paper(paper_id, PaperUpdate(revision=payload.revision, research_direction_ids=payload.research_direction_ids), user, db)

    @app.post("/api/v1/papers/research-direction-batches")
    def batch_directions(payload: BatchInput, user=Depends(require_user), db=Depends(database)):
        results = []
        with write_lock:
            chosen = svc.validate_labels(db, user.workspace_id, payload.direction_ids, "research_direction")
            for paper_id in dict.fromkeys(payload.paper_ids):
                try:
                    paper = svc.get_paper(db, user.workspace_id, paper_id)
                    existing = set(db.scalars(select(Tag.id).join(PaperTag, PaperTag.tag_id == Tag.id).where(PaperTag.paper_id == paper.id, Tag.kind == "research_direction")).all())
                    new_ids = existing | chosen if payload.operation == "add" else existing - chosen
                    svc.set_labels(db, paper, direction_ids=list(new_ids))
                    paper.revision += 1
                    paper.updated_at = now()
                    db.commit()
                    results.append({"id": paper_id, "ok": True})
                except HTTPException as error:
                    db.rollback()
                    results.append({"id": paper_id, "ok": False, "detail": error.detail})
        return {"results": results}

    @app.delete("/api/v1/papers/{paper_id}")
    def trash_paper(paper_id: str, revision: int, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            paper = svc.get_paper(db, user.workspace_id, paper_id)
            svc.check_revision(paper, revision)
            paper.deleted_at, paper.updated_at = now(), now()
            paper.revision += 1
            for task in db.scalars(select(ai.GenerationTask).where(ai.GenerationTask.paper_id == paper.id, ai.GenerationTask.status.in_(ai.ACTIVE))):
                cancel_task(db, task)
            db.commit()
        return {"ok": True}

    @app.post("/api/v1/papers/{paper_id}/restore")
    def restore_paper(paper_id: str, revision: int, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            paper = svc.get_paper(db, user.workspace_id, paper_id, True)
            svc.check_revision(paper, revision)
            paper.deleted_at, paper.updated_at = None, now()
            paper.revision += 1
            db.commit()
        return svc.paper_view(db, paper)

    @app.delete("/api/v1/papers/{paper_id}/permanent")
    def permanent_delete(paper_id: str, revision: int, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            paper = svc.get_paper(db, user.workspace_id, paper_id, True)
            svc.check_revision(paper, revision)
            if paper.deleted_at is None:
                svc.fail("请先将论文移入回收站，再进行彻底删除。")
            file_hash = reading.remove_paper(db, paper)
            db.commit()
            reading.remove_unreferenced_files(db, settings.data_dir, [file_hash])
        return {"ok": True}

    @app.get("/api/v1/papers/{paper_id}/file")
    def read_file(paper_id: str, download: bool = False, user=Depends(require_user), db=Depends(database)):
        paper = svc.get_paper(db, user.workspace_id, paper_id, True)
        path = settings.data_dir / "files" / (paper.file_hash + ".pdf")
        if not path.is_file():
            svc.fail("原文文件缺失，请检查数据目录或恢复备份。", 404)
        return FileResponse(path, media_type="application/pdf", filename=paper.original_filename, content_disposition_type="attachment" if download else "inline")

    @app.get("/api/v1/tags")
    def tags(kind: Literal["research_direction", "general", "topic"] | None = None, archived: bool = False, user=Depends(require_user), db=Depends(database)):
        query = select(Tag).where(Tag.workspace_id == user.workspace_id, Tag.deleted_at.is_not(None) if archived else Tag.deleted_at.is_(None))
        if kind:
            query = query.where(Tag.kind == kind)
        return [svc.tag_view(db, tag) for tag in db.scalars(query.order_by(Tag.id)).all()]

    @app.post("/api/v1/tags", status_code=201)
    def create_tag(payload: TagInput, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            tag = svc.save_tag(db, user.workspace_id, payload)
            db.commit()
            return svc.tag_view(db, tag)

    @app.patch("/api/v1/tags/{tag_id}")
    def rename_tag(tag_id: int, payload: TagUpdate, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            tag = svc.get_tag(db, user.workspace_id, tag_id)
            svc.touch_associated_papers(db, tag_id)
            tag = svc.save_tag(db, user.workspace_id, payload, tag)
            db.commit()
            return svc.tag_view(db, tag)

    @app.delete("/api/v1/tags/{tag_id}")
    def archive_tag(tag_id: int, revision: int, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            tag = svc.get_tag(db, user.workspace_id, tag_id)
            svc.check_revision(tag, revision)
            svc.touch_associated_papers(db, tag_id)
            db.execute(delete(PaperTag).where(PaperTag.tag_id == tag_id))
            tag.deleted_at = now()
            tag.revision += 1
            db.commit()
        return {"ok": True}

    @app.post("/api/v1/tags/{tag_id}/restore")
    def restore_tag(tag_id: int, revision: int, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            tag = svc.get_tag(db, user.workspace_id, tag_id, True)
            svc.check_revision(tag, revision)
            if tag.merged_into_id is not None:
                svc.fail("该分类已合并到其他分类，不能直接恢复。")
            tag.deleted_at = None
            tag.revision += 1
            db.commit()
            return svc.tag_view(db, tag)

    @app.post("/api/v1/tags/{tag_id}/merge-preview")
    def preview_merge(tag_id: int, payload: MergeInput, user=Depends(require_user), db=Depends(database)):
        source, target = svc.get_tag(db, user.workspace_id, tag_id), svc.get_tag(db, user.workspace_id, payload.target_id)
        svc.check_revision(source, payload.revision)
        svc.check_revision(target, payload.target_revision)
        return svc.merge_preview(db, source, target)

    @app.post("/api/v1/tags/{tag_id}/merge")
    def merge(tag_id: int, payload: MergeInput, user=Depends(require_user), db=Depends(database)):
        with write_lock:
            source, target = svc.get_tag(db, user.workspace_id, tag_id), svc.get_tag(db, user.workspace_id, payload.target_id)
            svc.check_revision(source, payload.revision)
            svc.check_revision(target, payload.target_revision)
            svc.merge_tags(db, source, target)
            db.commit()
            return svc.tag_view(db, target)

    dist = settings.frontend_dir
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/"):
            svc.fail("接口不存在。", 404)
        resolved = (dist / path).resolve()
        if not resolved.is_relative_to(dist.resolve()):
            svc.fail("路径无效。", 404)
        if path and resolved.is_file():
            return FileResponse(resolved)
        if (dist / "index.html").exists():
            return FileResponse(dist / "index.html")
        return JSONResponse({"detail": "前端尚未构建，请先运行 npm run build。"}, status_code=503)

    return app


app = create_app()
