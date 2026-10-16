"""卡片证据、不可变版本、生成快照、分类采纳与预算规则。"""
import hashlib
import json
import math
from datetime import datetime
from zoneinfo import ZoneInfo
from sqlalchemy import select, func
from pydantic import ValidationError
from .models import ModelConfiguration, GenerationTask, ModelCall, CardVersion, PaperCard, DirectionDecision, PageSource, Note, Tag, TagName, PaperTag, User, now
from .ai_schemas import ModelOptions, CardContent, WireCard, WireSuggestion, TaskCreate
from .schemas import TagInput
from . import services as management
from . import reading_service as reading

ACTIVE = {"queued", "running", "waiting_retry"}
CLAIMS = ("summary", "research_question", "method", "contributions", "findings", "limitations")
MISSING = ("原文未说明", "当前识读无法确认", "无法确认", "该页段未覆盖")
SCHEMA_VERSION = "1.0"
PROMPT_VERSION = "1.1"


def month_key():
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m")


def latest_config(db, workspace):
    return db.scalar(select(ModelConfiguration).where(ModelConfiguration.workspace_id == workspace).order_by(ModelConfiguration.revision.desc()).limit(1))


def owner_only(db, user):
    owner = db.scalar(select(func.min(User.id)).where(User.workspace_id == user.workspace_id))
    if owner != user.id:
        reading.fail("只有论文库所有者可以管理模型配置。", "owner_required", 403)


def config_view(config):
    return {"revision": config.revision if config else 0, **(config.settings_json if config else ModelOptions().model_dump()), "has_key": bool(config and config.encrypted_key), "tested_mode": config.tested_mode if config else None, "tested_at": config.tested_at if config else None, "test_error": config.test_error if config else None}


def tasks_usage(db, workspace, month=None):
    tasks = db.scalars(select(GenerationTask).where(GenerationTask.workspace_id == workspace, GenerationTask.budget_month == (month or month_key()))).all()
    tests = db.scalars(select(ModelCall).where(ModelCall.workspace_id == workspace, ModelCall.task_id.is_(None), ModelCall.budget_month == (month or month_key()))).all()
    reserved = sum(call_tokens(call) for call in tests if call.status == "reserved")
    test_tokens = sum(call_tokens(call) for call in tests if call.status != "reserved")
    return {"month": month or month_key(), "occupied_tokens": reserved + test_tokens + sum(max(task.reserved_tokens, task.charged_tokens) if task.status in ACTIVE else task.charged_tokens for task in tasks), "accounted_tokens": test_tokens + sum(task.charged_tokens for task in tasks), "reserved_tokens": reserved + sum(max(0, task.reserved_tokens - task.charged_tokens) for task in tasks if task.status in ACTIVE), "unknown_tasks": sum(task.usage_unknown for task in tasks), "task_count": len(tasks), "connection_test_calls": sum(call.stage in {"connection", "capability"} for call in tests), "search_query_calls": sum(call.stage == "search_query" and call.status != "reserved" for call in tests), "unknown_calls": sum(call.status in {"started", "unknown"} or call.status == "completed" and (call.input_tokens is None or call.output_tokens is None) for call in tests)}


def call_tokens(call):
    if call.input_tokens is not None and call.output_tokens is not None:
        return call.input_tokens + call.output_tokens
    if call.status == "failed":
        return 0
    return max(call.estimated_tokens, (call.input_tokens or 0) + (call.output_tokens or 0))


def task_view(task, db=None):
    keys = ("id", "paper_id", "status", "stage", "progress", "run_generation", "created_at", "started_at", "finished_at", "error_code", "error_message", "result_version_id", "reserved_tokens", "charged_tokens", "usage_unknown")
    result = {key: getattr(task, key) for key in keys}
    result["purpose"] = task.input_snapshot.get("purpose", "card")
    if result["purpose"] == "metadata":
        result["metadata"] = next((item["metadata"] for item in task.chunks if item.get("complete")), None) if task.status == "succeeded" else None
    elif result["purpose"] == "preview":
        result["preview"] = next((item["preview"] for item in task.chunks if item.get("complete")), None) if task.status == "succeeded" else None
    if db is not None:
        result["calls"] = [reading.view(call) for call in db.scalars(select(ModelCall).where(ModelCall.task_id == task.id).order_by(ModelCall.sequence))]
    return result


def all_claims(data):
    for key in CLAIMS:
        values = data[key] if isinstance(data[key], list) else [data[key]]
        for index, value in enumerate(values):
            yield key, index, value


def normalize_wire(raw, pages, notes, directions):
    """局部页序只通过本次输入清单映射，推荐失败独立于正文。"""
    if not isinstance(raw, dict):
        reading.fail("模型卡片不是有效对象。", "invalid_card")
    raw = dict(raw)
    suggestions = raw.pop("research_direction_suggestions", [])
    try:
        parsed = WireCard.model_validate(raw).model_dump()
    except (ValidationError, UnicodeError):
        reading.fail("模型卡片字段格式不正确，需要修复后再保存。", "invalid_card")
    notes_by_id = {note["id"]: note for note in notes}
    def evidence(value):
        if value["note_id"] is not None:
            if value["note_id"] not in notes_by_id:
                reading.fail("模型引用了未授权的个人记录。", "invalid_evidence")
            return {"page_source_id": None, "page_number": None, "note_id": value["note_id"], "excerpt": value["excerpt"], "description": value["description"], "verification": "unverified"}
        page = value["source_page"]
        if type(page) is not int or page not in pages:
            reading.fail("模型来源页不在本次输入范围内。", "invalid_evidence")
        source = pages[page]
        return {"page_source_id": source["id"], "page_number": source["page_number"], "note_id": None, "excerpt": value["excerpt"], "description": value["description"], "verification": "unverified"}
    for _, _, claim in all_claims(parsed):
        claim["evidence"] = [evidence(value) for value in claim["evidence"]]
        if not claim["text"]:
            reading.fail("模型卡片存在空白正文。", "invalid_card")
        if claim["origin"] in {"paper_fact", "author_claim"} and not claim["text"].startswith(MISSING):
            if not claim["evidence"] or any(value["note_id"] for value in claim["evidence"]):
                reading.fail("原文事实或作者主张缺少有效页面来源。", "invalid_evidence")
        if claim["origin"] == "user_record" and not any(value["note_id"] for value in claim["evidence"]):
            reading.fail("用户记录需要明确引用已选择的笔记。", "invalid_evidence")
    warnings, accepted = [], []
    dictionary = {direction["id"]: direction for direction in directions}
    if not isinstance(suggestions, list):
        warnings.append("方向推荐格式无效，已保留正文并忽略推荐。")
        suggestions = []
    for candidate in suggestions[:5]:
        try:
            suggestion = WireSuggestion.model_validate(candidate).model_dump()
            tag_id = suggestion["tag_id"]
            if tag_id is not None and tag_id not in dictionary:
                raise ValueError("方向不在字典中")
            name = dictionary[tag_id]["name"] if tag_id is not None else suggestion["name"]
            if not name:
                raise ValueError("候选名称为空")
            refs = [evidence({"source_page": number, "note_id": None, "excerpt": "", "description": suggestion["reason"]}) for number in suggestion["source_pages"]]
            key = management.normalize(name)
            if not any(management.normalize(item["name"]) == key for item in accepted):
                accepted.append({"tag_id": tag_id, "name": name, "reason": suggestion["reason"], "evidence": refs})
        except (ValidationError, ValueError, reading.ReadingError):
            warnings.append("一项方向推荐无法验证，已忽略；正文保留。")
    parsed["research_direction_suggestions"] = accepted
    parsed["personal_value"] = ""
    try:
        return CardContent.model_validate(parsed).model_dump(), list(dict.fromkeys(warnings))
    except (ValidationError, UnicodeError):
        reading.fail("卡片正文超出字段或总量上限。", "invalid_card")


def merge_wire(data):
    result = json.loads(json.dumps(data, ensure_ascii=False))
    result.pop("personal_value", None)
    for _, _, claim in all_claims(result):
        claim["evidence"] = [{"source_page": ref["page_number"], "note_id": ref["note_id"], "excerpt": ref["excerpt"], "description": ref["description"]} for ref in claim["evidence"]]
    result["research_direction_suggestions"] = [{"tag_id": item["tag_id"], "name": item["name"], "reason": item["reason"], "source_pages": [ref["page_number"] for ref in item["evidence"]]} for item in result["research_direction_suggestions"]]
    return result


def validate_content(db, user, paper, data, base=None, confirming=False):
    def texts(content):
        return [(key, index, claim["text"], claim["origin"]) for key, index, claim in all_claims(content)]
    if base and data.get("preview") == base.data.get("preview") and texts(data) != texts(base.data):
        # 正文改动后不继续展示旧速览，避免看板和阅读卡片相互矛盾。
        data["preview"] = None
    sources = {source.id: source for source in reading.sources_for(db, paper)}
    old_claims = {(key, index): claim for key, index, claim in all_claims(base.data)} if base else {}
    for key, index, claim in all_claims(data):
        previous = old_claims.get((key, index))
        changed = previous is None or previous["text"] != claim["text"] or previous["origin"] != claim["origin"]
        if changed:
            claim["origin"] = "user_record"
        for ref_index, ref in enumerate(claim["evidence"]):
            if ref["note_id"]:
                note = db.get(Note, ref["note_id"])
                if ref["page_source_id"] is not None or ref["page_number"] is not None or note is None or note.paper_id != paper.id or note.user_id != user.id or note.workspace_id != user.workspace_id:
                    reading.fail("个人记录来源无效，请移除或重新选择来源。", "invalid_evidence")
            else:
                source = sources.get(ref["page_source_id"])
                if source is None or source.page_number != ref["page_number"] or source.file_hash != paper.file_hash:
                    reading.fail("卡片来源必须是同篇原文的有效页面。", "invalid_evidence")
            old_ref = previous["evidence"][ref_index] if previous and ref_index < len(previous["evidence"]) else None
            ref_changed = old_ref is None or any(old_ref.get(field) != ref.get(field) for field in ("page_source_id", "page_number", "note_id", "excerpt", "description"))
            if changed or ref_changed:
                ref["verification"] = "unverified"
        if confirming and claim["text"] and claim["origin"] in {"paper_fact", "author_claim"} and not claim["text"].startswith(MISSING) and (not claim["evidence"] or any(ref["note_id"] for ref in claim["evidence"])):
            reading.fail("确认前请为原文事实补充页面来源。", "invalid_evidence")
    for suggestion in data["research_direction_suggestions"]:
        for ref in suggestion["evidence"]:
            source = sources.get(ref["page_source_id"])
            if ref["note_id"] is not None or source is None or source.page_number != ref["page_number"]:
                reading.fail("推荐方向的来源页无效。", "invalid_evidence")
    if confirming and (not data["summary"]["text"] or not data["research_question"]["text"] or not data["method"]["text"]):
        reading.fail("确认前请填写简介、研究问题和方法；无法确认的内容请明确说明。", "incomplete_card")


def card_state(db, paper):
    root = db.get(PaperCard, paper.id)
    versions = db.scalars(select(CardVersion).where(CardVersion.paper_id == paper.id, CardVersion.workspace_id == paper.workspace_id).order_by(CardVersion.sequence.desc())).all()
    decisions = {item.candidate_key: {"status": item.status, "tag_id": item.tag_id} for item in db.scalars(select(DirectionDecision).where(DirectionDecision.paper_id == paper.id))}
    version_decisions = {version.id: {str(index): decisions[management.normalize(candidate["name"])] for index, candidate in enumerate(version.data["research_direction_suggestions"]) if management.normalize(candidate["name"]) in decisions} for version in versions}
    return {"paper_id": paper.id, "card_revision": root.revision if root else 0, "current_version_id": root.current_version_id if root else None, "versions": [reading.view(version) for version in versions], "decisions": decisions, "version_decisions": version_decisions}


def root_revision(db, paper, expected):
    root = db.get(PaperCard, paper.id)
    if (root.revision if root else 0) != expected:
        reading.fail("其他页面已更新当前卡片，请比较后再保存。", "card_conflict", 409, card_state(db, paper))
    return root


def append_version(db, user, paper, data, source, config_id=None, base=None, warnings=(), model_info=None):
    root = db.get(PaperCard, paper.id)
    if root is None:
        root = PaperCard(paper_id=paper.id, workspace_id=paper.workspace_id)
        db.add(root); db.flush()
    sequence = (db.scalar(select(func.max(CardVersion.sequence)).where(CardVersion.paper_id == paper.id)) or 0) + 1
    version = CardVersion(workspace_id=paper.workspace_id, user_id=user.id, paper_id=paper.id, file_hash=paper.file_hash, sequence=sequence, data=data, source=source, config_id=config_id or (base.config_id if base else None), base_version_id=base.id if base else None, warnings=list(warnings), model_info=model_info or (base.model_info if base else None))
    db.add(version); db.flush()
    if root.current_version_id is None:
        root.current_version_id = version.id
    root.updated_at = now()
    return version


def reservation(options, page_count, note_length=0, batches=None):
    batches = batches or math.ceil(page_count / options["batch_pages"])
    # 为分段、汇总、最多两次额外尝试及一次修复共同预占，而非只计算文本长度。
    base = page_count * options["input_tokens_per_page"] + (note_length + 12000) * batches + options["max_output_tokens"] * batches
    merge = batches * 24000 + options["max_output_tokens"] + note_length if batches > 1 else 0
    largest = max(min(page_count, options["batch_pages"]) * options["input_tokens_per_page"] + note_length + 12000 + options["max_output_tokens"], merge)
    return base + merge + 3 * largest


def enqueue(db, user, paper, payload, settings, automatic=False, purpose="card"):
    requested = payload.model_dump()
    existing = db.scalar(select(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.user_id == user.id, GenerationTask.request_id == payload.request_id))
    if existing:
        if existing.paper_id != paper.id or existing.request_json != requested or existing.input_snapshot.get("purpose", "card") != purpose:
            reading.fail("请求标识已经用于其他生成输入。", "request_id_reused", 409)
        return existing
    config = latest_config(db, user.workspace_id)
    if config is None or not config.settings_json["enabled"]:
        reading.fail("请先在模型设置中启用并测试视觉模型；也可以手工填写卡片。", "model_disabled", 409)
    if not config.tested_mode:
        reading.fail("当前模型尚未通过视觉输入测试，请先测试已保存配置。", "model_not_tested", 409)
    if not (settings.data_dir / "files" / (paper.file_hash + ".pdf")).is_file():
        reading.fail("原文文件缺失，不能生成卡片。", "file_unavailable", 409)
    notes = []
    for note_id in dict.fromkeys(getattr(payload, "note_ids", [])):
        note = reading.own_record(db, user, Note, note_id)
        if note.paper_id != paper.id:
            reading.fail("选中的笔记不属于这篇论文。", "invalid_note")
        notes.append({"id": note.id, "revision": note.revision, "content": note.content, "page_number": note.page_number, "note_type": note.note_type})
    notes.sort(key=lambda value: value["id"])
    directions = [{"id": tag.id, "name": tag.name, "revision": tag.revision, "aliases": [item.name for item in management.label_names(db, tag) if not item.is_primary]} for tag in db.scalars(select(Tag).where(Tag.workspace_id == user.workspace_id, Tag.kind == "research_direction", Tag.deleted_at.is_(None)).order_by(Tag.id))]
    if len(directions) > 300:
        reading.fail("方向字典过大，请整理至 300 项以内再生成。", "input_too_large")
    snapshot = {"file_hash": paper.file_hash, "page_count": paper.page_count, "title": paper.title, "notes": notes, "directions": directions, "schema_version": SCHEMA_VERSION, "prompt_version": PROMPT_VERSION, "input_mode": config.tested_mode, "automatic": automatic}
    selected_count = paper.page_count
    if purpose == "metadata":
        selected_pages = sorted(set(range(1, min(paper.page_count, 4) + 1)) | {paper.page_count})
        dictionary = [{"id": tag.id, "kind": tag.kind, "name": tag.name, "aliases": [name.name for name in management.label_names(db, tag) if not name.is_primary]} for tag in db.scalars(select(Tag).where(Tag.workspace_id == user.workspace_id, Tag.deleted_at.is_(None)).order_by(Tag.id))]
        if len(dictionary) > 300:
            reading.fail("分类字典过大，请整理至 300 项以内再识别。", "input_too_large")
        snapshot.update({"purpose": "metadata", "selected_pages": selected_pages, "classification_dictionary": dictionary, "prompt_version": "metadata-1.0"})
        selected_count = len(selected_pages)
    fingerprint = hashlib.sha256(json.dumps({**snapshot, "config_id": config.id, "run": payload.request_id if payload.regenerate else None}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    cached = db.scalar(select(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.fingerprint == fingerprint))
    if cached:
        return cached
    active = db.scalar(select(GenerationTask).where(GenerationTask.paper_id == paper.id, GenerationTask.status.in_(ACTIVE)))
    if active:
        reading.fail("这篇论文已有生成任务，请等待完成或先取消。", "paper_task_active", 409, task_view(active))
    if db.scalar(select(func.count()).select_from(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.status.in_(ACTIVE))) >= 20:
        reading.fail("待处理任务达到 20 个，请等待或取消后再生成。", "queue_full", 409)
    note_length = len(json.dumps(notes, ensure_ascii=False))
    if note_length > 80000:
        reading.fail("选中的笔记内容过多，请减少到 8 万字符以内。", "input_too_large")
    reserve = reservation(config.settings_json, selected_count, note_length)
    batches = math.ceil(selected_count / config.settings_json["batch_pages"])
    if batches + (1 if batches > 1 else 0) + 3 > config.settings_json["max_calls"]:
        reading.fail("全文处理需要更多调用次数，请调整每批页数或调用上限。", "call_limit", 409)
    if reserve > config.settings_json["max_task_tokens"]:
        reading.fail(f"本任务含重试的预占约 {reserve:,} token，超过单任务上限，请调整模型设置。", "task_budget_exceeded", 409)
    if tasks_usage(db, user.workspace_id)["occupied_tokens"] + reserve > config.settings_json["monthly_token_limit"]:
        reading.fail("月度 token 预算不足，请等待或调整模型设置。", "monthly_budget_exceeded", 409)
    queue_order = (db.scalar(select(func.max(GenerationTask.queue_order))) or 0) + 1
    task = GenerationTask(workspace_id=user.workspace_id, user_id=user.id, paper_id=paper.id, config_id=config.id, request_id=payload.request_id, request_json=requested, fingerprint=fingerprint, queue_order=queue_order, input_snapshot=snapshot, reserved_tokens=reserve, budget_month=month_key())
    db.add(task); db.flush()
    return task


def resolve_direction(db, workspace, tag_id):
    visited = set()
    while tag_id and tag_id not in visited:
        visited.add(tag_id)
        tag = db.get(Tag, tag_id)
        if tag is None or tag.workspace_id != workspace or tag.kind != "research_direction":
            break
        if tag.merged_into_id:
            tag_id = tag.merged_into_id; continue
        if tag.deleted_at is None:
            return tag
        reading.fail("推荐方向已归档，请先恢复或手动选择方向。", "direction_archived", 409)
    reading.fail("推荐方向不可用，请手动选择有效方向。", "invalid_direction", 409)


def apply_direction(db, user, paper, version, index, payload, ignore=False):
    candidates = version.data["research_direction_suggestions"]
    if index < 0 or index >= len(candidates):
        reading.fail("方向推荐不存在。", "record_not_found", 404)
    candidate = candidates[index]
    key = management.normalize(candidate["name"])
    decision = db.scalar(select(DirectionDecision).where(DirectionDecision.paper_id == paper.id, DirectionDecision.candidate_key == key))
    if decision and decision.status in {"accepted", "ignored"}:
        return {"paper": management.paper_view(db, paper, user.id), "decision": {"status": decision.status, "tag_id": decision.tag_id}}
    management.check_revision(paper, payload.paper_revision)
    tag = None
    if not ignore:
        if candidate["tag_id"]:
            tag = resolve_direction(db, user.workspace_id, candidate["tag_id"])
        else:
            name = db.scalar(select(TagName).where(TagName.workspace_id == user.workspace_id, TagName.kind == "research_direction", TagName.normalized_name == key))
            if name:
                tag = resolve_direction(db, user.workspace_id, name.tag_id)
            elif payload.create_new:
                tag = management.save_tag(db, user.workspace_id, TagInput(name=candidate["name"]))
            else:
                reading.fail("这是新方向候选，请明确选择“新建并添加”。", "new_direction_confirmation", 409)
        existing = set(db.scalars(select(Tag.id).join(PaperTag, PaperTag.tag_id == Tag.id).where(PaperTag.paper_id == paper.id, Tag.kind == "research_direction", Tag.deleted_at.is_(None))))
        management.set_labels(db, paper, direction_ids=list(existing | {tag.id}))
        paper.revision += 1; paper.updated_at = now()
    decision = DirectionDecision(workspace_id=user.workspace_id, paper_id=paper.id, candidate_key=key, status="ignored" if ignore else "accepted", tag_id=tag.id if tag else None)
    db.add(decision); db.flush()
    return {"paper": management.paper_view(db, paper, user.id), "decision": {"status": decision.status, "tag_id": decision.tag_id}}
