"""受会话保护的模型设置、任务、卡片与方向推荐接口。"""
import uuid
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select, update, or_
from .models import ModelConfiguration, GenerationTask, ModelCall, CardVersion, PaperCard, now
from .ai_schemas import ModelWrite, ModelTest, TaskCreate, MetadataTaskCreate, CardWrite, CardConfirm, DirectionAction
from .ai_provider import normalize_base_url, normalize_options, ProviderError
from . import ai_service as service
from . import reading_service as reading
from . import services as management
from . import ai_preview


def cancel_task(db, task):
    task.status = task.stage = "cancelled"; task.run_generation += 1; task.run_token = None; task.lease_until = None; task.finished_at = now()
    calls = db.scalars(select(ModelCall).where(ModelCall.task_id == task.id)).all()
    task.charged_tokens = sum(service.call_tokens(call) for call in calls)
    task.usage_unknown = any(call.status in {"started", "unknown"} or (call.status == "completed" and (call.input_tokens is None or call.output_tokens is None)) for call in calls)


def build_ai_router(database, require_user, lock, settings, runner):
    router = APIRouter(prefix="/api/v1")

    @router.get("/settings/model")
    def model_settings(user=Depends(require_user), db=Depends(database)):
        service.owner_only(db, user)
        return service.config_view(service.latest_config(db, user.workspace_id))

    @router.put("/settings/model")
    def save_model(payload: ModelWrite, user=Depends(require_user), db=Depends(database)):
        service.owner_only(db, user)
        options = normalize_options(payload.model_dump(exclude={"revision", "api_key"}), settings.allow_local_model)
        with lock:
            current = service.latest_config(db, user.workspace_id)
            if payload.revision != (current.revision if current else 0):
                reading.fail("模型设置已在其他页面更新，请重新加载后比较。", "config_conflict", 409, service.config_view(current))
            same_service = current is not None and current.settings_json["provider"] == payload.provider and normalize_base_url(current.settings_json["base_url"], payload.provider, settings.allow_local_model) == options["base_url"]
            key = runner.secrets.encrypt(payload.api_key) if payload.api_key is not None else current.encrypted_key if same_service else ""
            if payload.enabled and (not payload.model or not key):
                reading.fail("启用模型需要填写模型名称和密钥；更换服务地址时请重新填写密钥。", "model_incomplete")
            config = ModelConfiguration(workspace_id=user.workspace_id, revision=payload.revision + 1, settings_json=options, encrypted_key=key)
            # 仅预算与开关变化可以沿用原服务的能力测试，模型及输入变更必须重测。
            capability_fields = {"provider", "base_url", "model", "input_mode", "structured_output", "image_long_edge", "max_request_bytes"}
            if same_service and payload.api_key is None and all(current.settings_json[field] == options[field] for field in capability_fields):
                config.tested_mode = current.tested_mode; config.tested_at = current.tested_at; config.test_error = current.test_error
            db.add(config); db.flush()
            if not payload.enabled:
                for task in db.scalars(select(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.status.in_(service.ACTIVE))):
                    cancel_task(db, task)
            db.commit()
            return service.config_view(config)

    @router.post("/settings/model/test")
    async def test_model(payload: ModelTest, user=Depends(require_user), db=Depends(database)):
        service.owner_only(db, user)
        config = service.latest_config(db, user.workspace_id)
        if config is None or payload.revision != config.revision:
            reading.fail("请先保存当前模型配置，再测试已保存版本。", "config_conflict", 409)
        if not config.settings_json["enabled"]:
            reading.fail("请先启用云端模型，再明确启动连接测试。", "model_disabled", 409)
        if not config.settings_json["model"] or not config.encrypted_key:
            reading.fail("请先填写模型名称和密钥。", "model_incomplete")
        try:
            mode = await runner.test_configuration(config)
        except (ProviderError, reading.ReadingError) as error:
            message = str(error) if isinstance(error, ProviderError) else error.body["detail"]
            with lock:
                db.expire_all()
                saved = db.get(ModelConfiguration, config.id)
                saved.tested_mode = None; saved.test_error = message; saved.tested_at = now(); db.commit()
            if isinstance(error, ProviderError):
                reading.fail(message, error.code, 422)
            raise
        with lock:
            db.expire_all()
            latest = service.latest_config(db, user.workspace_id)
            if latest.id != config.id:
                reading.fail("测试期间模型配置发生变化，请测试最新版本。", "config_conflict", 409)
            latest.tested_mode = mode; latest.tested_at = now(); latest.test_error = None; db.commit()
            return service.config_view(latest)

    @router.get("/settings/model/usage")
    def usage(user=Depends(require_user), db=Depends(database)):
        service.owner_only(db, user)
        config = service.latest_config(db, user.workspace_id)
        return {**service.tasks_usage(db, user.workspace_id), "monthly_token_limit": config.settings_json["monthly_token_limit"] if config else 0, "calls": [reading.view(call) for call in db.scalars(select(ModelCall).where(ModelCall.workspace_id == user.workspace_id).order_by(ModelCall.created_at.desc(), ModelCall.id.desc()).limit(50))]}

    @router.post("/papers/{paper_id}/card-tasks")
    def generate(paper_id: str, payload: TaskCreate, user=Depends(require_user), db=Depends(database)):
        with lock:
            paper = reading.paper_for(db, user, paper_id, writable=True)
            task = service.enqueue(db, user, paper, payload, settings)
            db.commit()
            return JSONResponse(service.task_view(task), status_code=202)

    @router.get("/papers/{paper_id}/card-tasks")
    def tasks(paper_id: str, user=Depends(require_user), db=Depends(database)):
        paper = reading.paper_for(db, user, paper_id)
        return [service.task_view(task) for task in db.scalars(select(GenerationTask).where(GenerationTask.paper_id == paper.id, GenerationTask.workspace_id == user.workspace_id, or_(GenerationTask.input_snapshot["purpose"].as_string().is_(None), GenerationTask.input_snapshot["purpose"].as_string() == "card")).order_by(GenerationTask.queue_order.desc()).limit(50))]

    @router.post("/papers/{paper_id}/metadata-tasks")
    def identify_metadata(paper_id: str, payload: MetadataTaskCreate, user=Depends(require_user), db=Depends(database)):
        with lock:
            paper = reading.paper_for(db, user, paper_id, writable=True)
            task = service.enqueue(db, user, paper, payload, settings, purpose="metadata")
            db.commit()
            return JSONResponse(service.task_view(task), status_code=202)

    @router.post("/papers/{paper_id}/preview-tasks")
    def generate_preview(paper_id: str, payload: MetadataTaskCreate, user=Depends(require_user), db=Depends(database)):
        with lock:
            paper = reading.paper_for(db, user, paper_id, writable=True)
            task = ai_preview.enqueue(db, user, paper, payload, settings)
            db.commit()
            return JSONResponse(service.task_view(task), status_code=202)

    @router.get("/papers/{paper_id}/preview-tasks")
    def preview_tasks(paper_id: str, user=Depends(require_user), db=Depends(database)):
        paper = reading.paper_for(db, user, paper_id)
        return [service.task_view(task) for task in db.scalars(select(GenerationTask).where(GenerationTask.paper_id == paper.id, GenerationTask.workspace_id == user.workspace_id, GenerationTask.input_snapshot["purpose"].as_string() == "preview").order_by(GenerationTask.queue_order.desc()).limit(20))]

    @router.get("/papers/{paper_id}/metadata-tasks")
    def metadata_tasks(paper_id: str, user=Depends(require_user), db=Depends(database)):
        paper = reading.paper_for(db, user, paper_id)
        return [service.task_view(task) for task in db.scalars(select(GenerationTask).where(GenerationTask.paper_id == paper.id, GenerationTask.workspace_id == user.workspace_id, GenerationTask.input_snapshot["purpose"].as_string() == "metadata").order_by(GenerationTask.queue_order.desc()).limit(50))]

    @router.get("/card-tasks/{task_id}")
    def task_detail(task_id: str, user=Depends(require_user), db=Depends(database)):
        task = reading.own_record(db, user, GenerationTask, task_id)
        return service.task_view(task, db)

    @router.post("/card-tasks/{task_id}/cancel")
    def cancel(task_id: str, user=Depends(require_user), db=Depends(database)):
        with lock:
            task = reading.own_record(db, user, GenerationTask, task_id)
            if task.status in service.ACTIVE:
                cancel_task(db, task); db.commit()
            return service.task_view(task, db)

    @router.get("/papers/{paper_id}/card")
    def card(paper_id: str, user=Depends(require_user), db=Depends(database)):
        return service.card_state(db, reading.paper_for(db, user, paper_id))

    @router.get("/papers/{paper_id}/card-sources")
    def card_sources(paper_id: str, user=Depends(require_user), db=Depends(database)):
        paper = reading.paper_for(db, user, paper_id)
        return [reading.view(source) for source in reading.sources_for(db, paper)]

    @router.post("/papers/{paper_id}/card-versions")
    def save_card(paper_id: str, payload: CardWrite, user=Depends(require_user), db=Depends(database)):
        def apply(paper, _):
            reading.check_file(paper, payload.file_hash)
            service.root_revision(db, paper, payload.card_revision)
            base = reading.own_record(db, user, CardVersion, payload.base_version_id) if payload.base_version_id else None
            if base and base.paper_id != paper.id:
                reading.fail("编辑来源不属于这篇论文。", "invalid_card")
            data = payload.data.model_dump()
            service.validate_content(db, user, paper, data, base)
            version = service.append_version(db, user, paper, data, "manual", base=base)
            return {"version": reading.view(version), "card_revision": db.get(PaperCard, paper.id).revision}, version.id
        with lock:
            result, code = reading.mutation(db, user, "POST/card-version/" + paper_id, payload, apply, "card", paper_id=paper_id, status=201)
            return JSONResponse(result, status_code=code)

    @router.post("/card-versions/{version_id}/confirm")
    def confirm(version_id: str, payload: CardConfirm, user=Depends(require_user), db=Depends(database)):
        def apply(paper, version):
            root = service.root_revision(db, paper, payload.card_revision)
            service.validate_content(db, user, paper, version.data, version, confirming=True)
            updated = db.execute(update(PaperCard).where(PaperCard.paper_id == paper.id, PaperCard.revision == payload.card_revision).values(current_version_id=version.id, revision=PaperCard.revision + 1, updated_at=now()))
            if updated.rowcount != 1:
                reading.fail("当前卡片发生变化，请重新比较。", "card_conflict", 409)
            version.confirmed_at = version.confirmed_at or now(); db.flush(); db.refresh(root)
            return {"version": reading.view(version), "card_revision": root.revision}, version.id
        with lock:
            result, code = reading.mutation(db, user, "POST/card-confirm/" + version_id, payload, apply, "card", model=CardVersion, record_id=version_id)
            return JSONResponse(result, status_code=code)

    @router.post("/card-versions/{version_id}/direction-suggestions/{index}/accept")
    def accept(version_id: str, index: int, payload: DirectionAction, user=Depends(require_user), db=Depends(database)):
        return decision(version_id, index, payload, user, db, False)

    @router.post("/card-versions/{version_id}/direction-suggestions/{index}/ignore")
    def ignore(version_id: str, index: int, payload: DirectionAction, user=Depends(require_user), db=Depends(database)):
        return decision(version_id, index, payload, user, db, True)

    def decision(version_id, index, payload, user, db, ignore):
        def apply(paper, version):
            return service.apply_direction(db, user, paper, version, index, payload, ignore), version.id
        with lock:
            result, code = reading.mutation(db, user, f"POST/card-direction/{version_id}/{index}/{ignore}", payload, apply, "card_direction", model=CardVersion, record_id=version_id)
            return JSONResponse(result, status_code=code)

    return router
