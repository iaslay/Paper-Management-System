"""从已有阅读卡片整理简明速览，不改写确认版本或发送个人记录。"""
import hashlib
import json
from sqlalchemy import select, func
from .models import GenerationTask, CardVersion, PaperCard
from .ai_schemas import ReadingPreview
from . import ai_service as ai
from . import reading_service as reading

RULES = "为不熟悉这篇论文的科研读者写中文速览，只改写输入卡片已有内容，不查询外部内容或编造结论。headline 是直白的中文短标题，≤40字符，说清楚论文要做什么；problem≤70字符，说明实际问题；approach≤90字符，用通俗语言说明核心做法；benefit≤70字符，说明卡片支持的价值或结果，未说明时明确写未说明。避免堆砌模型名、训练参数、缩写和原子操作名，专有名词最多保留一个并解释作用。不得夸大创新或效果，不引入输入没有的数字。origin=author_claim 的主张须用作者认为等措辞；origin=system_inference 的推测须用可能等措辞，不能改成已证实结论。四项都要有内容，只输出符合结构的 JSON。"
STYLE = "写给第一次接触该主题的人。标题建议15～24字，用动词说明实际用途，不以提出、框架、机制等抽象概念开头。problem建议25～45字，先说明谁在什么场景遇到什么困难，将技术抽象换成具体困扰。approach建议35～65字，只讲一到两个核心动作，说明用什么信息、如何处理；省略训练算法、奖励函数、操作名称和模型名称。benefit建议25～45字，先解释实验支持的具体改善，只有必要时才在末尾简短提示推测。不要照抄输入的长句，不丢失原有的不确定性。"


def source(version):
    values = {}
    for key in ("summary", "research_question", "method", "contributions", "findings", "limitations"):
        candidates = version.data.get(key, [])
        if not isinstance(candidates, list):
            candidates = [candidates]
        values[key] = [{"text": item["text"], "origin": item["origin"]} for item in candidates if item.get("origin") != "user_record" and item.get("text")]
    return values


def enqueue(db, user, paper, payload, settings):
    requested = payload.model_dump()
    existing = db.scalar(select(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.user_id == user.id, GenerationTask.request_id == payload.request_id))
    if existing:
        if existing.paper_id != paper.id or existing.request_json != requested or existing.input_snapshot.get("purpose") != "preview":
            reading.fail("请求标识已经用于其他处理。", "request_id_reused", 409)
        return existing
    root = db.get(PaperCard, paper.id)
    version = db.get(CardVersion, root.current_version_id) if root and root.current_version_id else None
    if version is None:
        reading.fail("请先生成或填写阅读卡片，再整理速览。", "card_missing", 409)
    content = source(version)
    if not any(content.values()):
        reading.fail("当前卡片只有个人记录，未发送给云端。可以手动完善卡片，或从原文生成新草稿。", "preview_source_missing", 409)
    config = ai.latest_config(db, user.workspace_id)
    if config is None or not config.settings_json["enabled"] or not config.tested_mode:
        reading.fail("请先在模型设置中启用并测试模型。", "model_not_tested", 409)
    snapshot = {"purpose": "preview", "file_hash": paper.file_hash, "title": paper.title, "source_version": version.id, "source": content, "prompt_version": "preview-1.1"}
    fingerprint = hashlib.sha256(json.dumps({**snapshot, "config_id": config.id, "run": payload.request_id if payload.regenerate else None}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    cached = db.scalar(select(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.fingerprint == fingerprint))
    if cached:
        return cached
    if db.scalar(select(GenerationTask.id).where(GenerationTask.paper_id == paper.id, GenerationTask.status.in_(ai.ACTIVE))):
        reading.fail("这篇论文已有 AI 任务，请等待完成或先取消。", "paper_task_active", 409)
    if db.scalar(select(func.count()).select_from(GenerationTask).where(GenerationTask.workspace_id == user.workspace_id, GenerationTask.status.in_(ai.ACTIVE))) >= 20:
        reading.fail("AI 队列已满，请稍后再试。", "queue_full", 409)
    reserve = ai.reservation(config.settings_json, 0, len(json.dumps(content, ensure_ascii=False)), batches=1)
    if config.settings_json["max_calls"] < 4 or reserve > config.settings_json["max_task_tokens"] or ai.tasks_usage(db, user.workspace_id)["occupied_tokens"] + reserve > config.settings_json["monthly_token_limit"]:
        reading.fail("整理速览的预算或调用上限不足，请检查模型设置。", "task_budget_exceeded", 409)
    order = (db.scalar(select(func.max(GenerationTask.queue_order))) or 0) + 1
    task = GenerationTask(workspace_id=user.workspace_id, user_id=user.id, paper_id=paper.id, config_id=config.id, request_id=payload.request_id, request_json=requested, fingerprint=fingerprint, queue_order=order, input_snapshot=snapshot, reserved_tokens=reserve, budget_month=ai.month_key())
    db.add(task); db.flush()
    return task


def prompt(snapshot):
    return RULES + STYLE + "\n输入卡片：" + json.dumps({"title": snapshot["title"], "source": snapshot["source"], "schema": ReadingPreview.model_json_schema()}, ensure_ascii=False, separators=(",", ":"))
