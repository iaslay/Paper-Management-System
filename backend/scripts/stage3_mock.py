"""仅供独立验收的模拟视觉服务；输出明确标记，不分析真实论文事实。"""
import asyncio
import json
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(docs_url=None, redoc_url=None)
app.state.mode = "valid"
app.state.calls = 0


@app.post("/__test/mode")
async def mode(request: Request):
    value = await request.json()
    if value.get("mode") not in {"valid", "invalid", "delay", "unauthorized", "missing_usage", "rate_limit_once"}:
        return JSONResponse({"detail": "模拟模式无效"}, status_code=422)
    app.state.mode = value["mode"]; app.state.calls = 0
    return {"mode": app.state.mode}


async def response(request, protocol):
    body = await request.json(); app.state.calls += 1
    if body.get("model") != "mock-vision" or request.headers.get("authorization") not in {None, "Bearer stage3-mock-key"}:
        return JSONResponse({"error": "仅接受模拟模型和测试密钥"}, status_code=401)
    if app.state.mode == "unauthorized":
        return JSONResponse({"error": "模拟鉴权失败"}, status_code=401)
    if app.state.mode == "rate_limit_once" and app.state.calls == 1:
        return JSONResponse({"error": "模拟限流"}, status_code=429, headers={"retry-after": "1"})
    if app.state.mode == "delay":
        await asyncio.sleep(6)
    content = body.get("input", body.get("messages"))[-1]["content"]
    prompt = content[-1]["text"]
    limit = body.get("max_output_tokens", body.get("max_tokens"))
    if limit == 512:
        value = {"ok": True} if len(content) == 1 else {"first": "PAPERBOARD_VISION_PAGE_ONE", "last": "PAPERBOARD_VISION_PAGE_TWO"}
    else:
        try:
            raw = prompt.split("输入数据：", 1)[1]
            snapshot, _ = json.JSONDecoder().raw_decode(raw)
        except (ValueError, IndexError):
            snapshot = {"page_manifest": [{"source_page": 1}], "direction_dictionary": []}
        page = snapshot["page_manifest"][0]["source_page"]
        def claim(text, origin="paper_fact"):
            return {"text": text, "origin": origin, "evidence": [{"source_page": page, "note_id": None, "excerpt": "模拟验收示例，不代表原文摘录。", "description": "只核验页面引用、版本与保存流程。"}]}
        value = {"schema_version": "1.0", "summary": claim("模拟验收：这张卡片演示论文简介、来源回跳和版本保存，不代表对原文的真实分析。"), "research_question": claim("如何把读过的论文整理成可回顾的研究记录？"), "method": claim("模拟流程展示研究问题、方法、贡献和证据页的结构。正文需用户配置真实模型后生成并核对。"), "contributions": [claim("模拟作者主张：减少重复整理资料的时间。", "author_claim")], "findings": [], "limitations": [claim("本次使用模拟 HTTP 服务，尚未评估真实模型的识读与事实准确率。", "system_inference")], "paper_type": "other", "research_direction_suggestions": []}
        dictionary = snapshot.get("direction_dictionary") or []
        if dictionary:
            direction = dictionary[0]
            value["research_direction_suggestions"].append({"tag_id": direction["id"], "name": None, "reason": "模拟推荐：用于验收已有方向的显式采纳。", "source_pages": [page]})
        value["research_direction_suggestions"].append({"tag_id": None, "name": "科研工具（模拟验收）", "reason": "模拟候选：用于验收新方向的确认与分类。", "source_pages": [page]})
    if limit != 512 and "classification_dictionary" in snapshot:
        def field(value):
            return {"value": value, "source_pages": [page] if value else []}
        value = {"title": field("模拟验收：AI 自动补全论文信息"), "authors": field(["Test Author One", "Test Author Two"]), "year": field(2026), "doi": field(None), "classifications": []}
        dictionary = snapshot["classification_dictionary"]
        existing = next((label for label in dictionary if label["kind"] == "research_direction"), None)
        if existing:
            value["classifications"].append({"tag_id": existing["id"], "kind": "research_direction", "name": existing["name"], "reason": "模拟：验证现有方向填入", "source_pages": [page]})
        value["classifications"] += [{"tag_id": None, "kind": kind, "name": name, "reason": "模拟：验证保存时创建分类", "source_pages": [page]} for kind, name in [("topic", "信息补全（模拟验收）"), ("general", "复读验证（模拟验收）")]]
    text = "模拟的无效 JSON" if app.state.mode == "invalid" and limit != 512 else json.dumps(value, ensure_ascii=False)
    if protocol == "responses":
        result = {"id": f"mock-{app.state.calls}", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 120, "output_tokens": 480}}
    elif protocol == "claude":
        result = {"id": f"mock-{app.state.calls}", "stop_reason": "end_turn", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 120, "output_tokens": 480}}
    else:
        result = {"id": f"mock-{app.state.calls}", "choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 120, "completion_tokens": 480}}
    if app.state.mode == "missing_usage":
        result.pop("usage")
    return result


@app.post("/v1/responses")
async def responses(request: Request):
    return await response(request, "responses")


@app.post("/v1/messages")
async def messages(request: Request):
    return await response(request, "claude")


@app.post("/v1/chat/completions")
async def chat(request: Request):
    return await response(request, "chat")
