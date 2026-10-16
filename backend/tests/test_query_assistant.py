"""自然语言检索词的真实队列、共享预算、权限和晚到结果回归。"""
import asyncio
import json
import threading
import uuid
import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.config import Settings
from app.main import create_app, PASSWORDS
from app.models import ModelCall, Paper, User, Workspace
from app.discovery_models import SearchQueryTask
from app.ai_provider import VisionProvider
from app import ai_service as ai
from app.query_assistant import year_filter, WireQuery
from pydantic import ValidationError
from test_management import CREDENTIALS, HEADERS
from test_ai_cards import configure


def rid():
    return uuid.uuid4().hex


def result():
    return {"intent": "查找多轮对话中长期记忆的更新方法", "keywords": [
        {"concept": "长期记忆", "terms": ["long term memory", "long-term memory"]},
        {"concept": "对话智能体", "terms": ["conversational agents"]}], "queries": [
        {"label": "主题聚焦", "q": '"long term memory" "conversational agents"', "reason": "用两个核心概念定位研究。"},
        {"label": "拓展方法", "q": '"memory update" dialogue', "reason": "补充更新方法的常用表达。"}], "notes": None}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, ai_worker_enabled=False, discovery_worker_enabled=False))
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as http:
        assert http.post("/api/v1/setup", json=CREDENTIALS).status_code == 200
        yield http


def wire(client, value=None, usage=True, hook=None):
    requests = []
    async def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        if hook:
            custom = await hook(request)
            if custom is not None:
                return custom
        content = value if isinstance(value, str) else json.dumps(value if value is not None else result(), ensure_ascii=False)
        if "/chat/completions" in str(request.url):
            response = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
            if usage: response["usage"] = {"prompt_tokens": 100, "completion_tokens": 200}
        elif str(request.url).endswith("/messages"):
            response = {"content": [{"type": "text", "text": content}], "stop_reason": "end_turn"}
            if usage: response["usage"] = {"input_tokens": 100, "output_tokens": 200}
        else:
            response = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": content}]}]}
            if usage: response["usage"] = {"input_tokens": 100, "output_tokens": 200}
        return httpx.Response(200, json=response)
    client.app.state.card_runner.provider_factory = lambda options, key, allow_local: VisionProvider(options, key, allow_local, transport=httpx.MockTransport(handle))
    return requests


def submit(client, text="想找近三年关于多轮对话长期记忆更新的论文", provider="acl", request=None):
    response = client.post("/api/v1/discovery/query-assists", json={"provider": provider, "text": text, "request_id": request or rid()})
    assert response.status_code == 202, response.text
    return response.json()


def perform(client, task):
    assert client.portal.call(client.app.state.query_assistant.process_one)
    return client.get("/api/v1/discovery/query-assists/" + task["id"]).json()


def test_disabled_model_does_not_block_manual_search_or_send_input(client):
    calls = wire(client)
    response = client.post("/api/v1/discovery/query-assists", json={"provider": "acl", "text": "长期记忆", "request_id": rid()})
    assert response.json()["code"] == "model_disabled" and not calls
    assert not client.get("/api/v1/discovery/query-assists/status").json()["enabled"]
    assert client.get("/api/v1/discovery/providers").status_code == 200


@pytest.mark.parametrize("provider", ["responses", "chat", "claude"])
def test_text_generation_reuses_model_without_visual_requirement_or_paper_context(client, provider):
    configure(client, provider=provider)
    with client.app.state.session_factory() as db:
        config = ai.latest_config(db, 1); config.tested_mode = None; db.commit()
    calls = wire(client)
    task = submit(client)
    before = client.get("/api/v1/settings/model/usage").json()
    assert task["status"] == "queued" and before["reserved_tokens"] > 0 and before["accounted_tokens"] == 0
    assert not calls
    final = perform(client, task)
    assert final["status"] == "succeeded", final
    assert final["result"]["year_filter"]["year_to"] == int(task["reference_date"][:4])
    assert final["result"]["queries"][0]["q"] == result()["queries"][0]["q"]
    contents = calls[0].get("messages", calls[0].get("input"))[-1]["content"]
    assert len(contents) == 1 and contents[0]["type"] in {"text", "input_text"}
    assert '"question": "' + task["text"] + '"' in contents[0]["text"]
    assert '"schema"' in contents[0]["text"] and '"queries"' in contents[0]["text"]
    assert "user_notes" not in contents[0]["text"] and "page_manifest" not in contents[0]["text"]
    used = client.get("/api/v1/settings/model/usage").json()
    assert used["accounted_tokens"] == 300 and used["reserved_tokens"] == 0
    assert used["search_query_calls"] == 1 and used["connection_test_calls"] == 0
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Paper)) == 0
        assert db.scalar(select(ModelCall)).task_id is None


def test_deepseek_uses_json_mode_without_thinking_for_short_structured_request(client):
    configure(client, base_url="https://api.deepseek.com")
    calls = wire(client)
    assert perform(client, submit(client))["status"] == "succeeded"
    assert calls[0]["reasoning"] == {"effort": "none"}
    assert calls[0]["text"]["format"]["type"] == "json_object"
    assert calls[0]["max_output_tokens"] == 2048


def test_request_replay_does_not_call_again_and_conflicting_input_is_rejected(client):
    configure(client); calls = wire(client); request = rid()
    first = submit(client, request=request)
    assert submit(client, request=request)["id"] == first["id"]
    perform(client, first)
    assert submit(client, request=request)["status"] == "succeeded" and len(calls) == 1
    conflict = client.post("/api/v1/discovery/query-assists", json={"provider": "arxiv", "text": "不同的问题", "request_id": request})
    assert conflict.status_code == 409


@pytest.mark.parametrize("bad", ["{unfinished", {**result(), "year_from": 2024}, {**result(), "queries": []},
    {**result(), "queries": [{"label": "错误", "q": "memory OR agents", "reason": "包含布尔语法"}]},
    {**result(), "queries": [{"label": "错误", "q": "https://evil.example/", "reason": "不能生成链接"}]}], ids=["invalid-json", "invented-filter", "empty-query", "boolean-dsl", "invented-url"])
def test_invalid_output_does_not_become_a_search_or_retry_automatically(client, bad):
    configure(client); calls = wire(client, value=bad)
    task = submit(client)
    final = perform(client, task)
    assert final["status"] == "failed" and final["result"] is None
    assert final["error_code"] == "invalid_query_suggestions" and final["text"] == task["text"]
    assert final["input_tokens"] == 100 and final["output_tokens"] == 200 and len(calls) == 1


def test_missing_usage_remains_estimated_and_visible(client):
    configure(client); wire(client, usage=False)
    final = perform(client, submit(client))
    assert final["status"] == "succeeded" and final["usage_unknown"]
    used = client.get("/api/v1/settings/model/usage").json()
    assert used["accounted_tokens"] == final["estimated_tokens"] and used["unknown_calls"] == 1


def test_whitespace_only_required_model_fields_are_rejected():
    import copy
    for key in ["intent", "concept", "label", "reason"]:
        content = copy.deepcopy(result())
        if key == "intent": content["intent"] = "   "
        elif key == "concept": content["keywords"][0][key] = "   "
        else: content["queries"][0][key] = "   "
        with pytest.raises(ValidationError):
            WireQuery.model_validate(content)


@pytest.mark.parametrize("status,code", [(401, "authentication_failed"), (429, "rate_limited"), (503, "provider_unavailable")])
def test_provider_failure_is_redacted_and_not_retried(client, status, code):
    configure(client)
    async def error(_): return httpx.Response(status, text="private-test-key-2026")
    calls = wire(client, hook=error)
    final = perform(client, submit(client))
    assert final["status"] == "failed" and final["error_code"] == code
    assert "private-test-key" not in json.dumps(final) and len(calls) == 1


def test_queued_cancel_releases_shared_budget_and_never_calls_model(client):
    configure(client); calls = wire(client); task = submit(client)
    cancelled = client.post(f"/api/v1/discovery/query-assists/{task['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert not client.portal.call(client.app.state.query_assistant.process_one) and not calls
    assert client.get("/api/v1/settings/model/usage").json()["occupied_tokens"] == 0


def test_inflight_cancel_stops_waiting_without_publishing_late_result(client):
    configure(client); entered = threading.Event()
    async def delay(_):
        entered.set()
        await asyncio.sleep(30)
    wire(client, hook=delay)
    task = submit(client)
    pending = client.portal.start_task_soon(client.app.state.query_assistant.process_one)
    assert entered.wait(3)
    assert client.post(f"/api/v1/discovery/query-assists/{task['id']}/cancel").json()["status"] == "cancelled"
    assert pending.result(timeout=3)
    final = client.get(f"/api/v1/discovery/query-assists/{task['id']}").json()
    assert final["result"] is None and final["usage_unknown"]


def test_late_completed_response_after_cancel_preserves_known_usage(client):
    configure(client)
    task = submit(client)
    async def late(_):
        with client.app.state.session_factory() as db:
            saved = db.get(SearchQueryTask, task["id"]); saved.status = "cancelled"; db.commit()
    wire(client, hook=late)
    final = perform(client, task)
    assert final["status"] == "cancelled" and final["result"] is None
    assert final["input_tokens"] == 100 and not final["usage_unknown"]


def test_service_shutdown_exits_even_when_query_was_already_cancelled(client):
    configure(client); entered = threading.Event()
    async def delay(_):
        entered.set()
        await asyncio.sleep(30)
    wire(client, hook=delay)
    task = submit(client)
    service = client.app.state.query_assistant
    async def shutdown():
        worker = asyncio.create_task(service.process_one())
        while not entered.is_set():
            await asyncio.sleep(.01)
        with service.factory() as db:
            service.cancel(db, db.get(SearchQueryTask, task["id"]))
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(worker, 2)
    client.portal.call(shutdown)
    final = client.get(f"/api/v1/discovery/query-assists/{task['id']}").json()
    assert final["status"] == "cancelled" and final["usage_unknown"]


def test_disabling_model_cancels_queued_query_and_release_reservation(client):
    config = configure(client); calls = wire(client); task = submit(client)
    response = client.put("/api/v1/settings/model", json={**{key: value for key, value in config.items() if key not in {"has_key", "tested_at", "tested_mode", "test_error"}}, "enabled": False})
    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/discovery/query-assists/{task['id']}").json()["status"] == "cancelled"
    assert not client.portal.call(client.app.state.query_assistant.process_one) and not calls


def test_restart_does_not_resend_an_unknown_generation(client):
    configure(client); calls = wire(client); task = submit(client)
    with client.app.state.session_factory() as db:
        saved = db.get(SearchQueryTask, task["id"]); saved.status = "running"
        db.get(ModelCall, saved.call_id).status = "started"; db.commit()
    client.app.state.query_assistant.recover()
    final = client.get(f"/api/v1/discovery/query-assists/{task['id']}").json()
    assert final["status"] == "failed" and final["usage_unknown"]
    assert not client.portal.call(client.app.state.query_assistant.process_one) and not calls


def test_budget_reservations_are_shared_and_queue_is_bounded(client):
    configure(client); wire(client)
    for _ in range(3): submit(client)
    response = client.post("/api/v1/discovery/query-assists", json={"provider": "acl", "text": "另一个问题", "request_id": rid()})
    assert response.json()["code"] == "query_queue_full"
    with client.app.state.session_factory() as db:
        config = ai.latest_config(db, 1); config.settings_json = {**config.settings_json, "monthly_token_limit": 1}; db.commit()
    task = client.get("/api/v1/discovery/query-assists", params={"provider": "acl"}).json()[0]
    for _ in range(3):
        assert client.portal.call(client.app.state.query_assistant.process_one)
    assert client.get(f"/api/v1/discovery/query-assists/{task['id']}").json()["error_code"] == "monthly_budget_exceeded"


def test_private_questions_and_results_do_not_leak_to_another_workspace(client):
    configure(client); wire(client); task = submit(client)
    with client.app.state.session_factory() as db:
        db.add(Workspace(id=2, name="其他空间", quota_bytes=10000)); db.flush()
        db.add(User(id=2, workspace_id=2, username="other", password_hash=PASSWORDS.hash("other-password-2026"))); db.commit()
    client.delete("/api/v1/session")
    assert client.post("/api/v1/session", json={"username": "other", "password": "other-password-2026"}).status_code == 200
    assert client.get("/api/v1/discovery/query-assists?provider=acl").json() == []
    assert client.get(f"/api/v1/discovery/query-assists/{task['id']}").status_code == 404
    assert client.post(f"/api/v1/discovery/query-assists/{task['id']}/cancel").status_code == 404


@pytest.mark.parametrize("text,expected", [("长期记忆", None), ("近三年的记忆论文", (2024, 2026)), ("2020年至2024年", (2020, 2024)),
    ("2023年及以后", (2023, None)), ("2023年之前", (None, 2022)), ("2025年的文章", (2025, 2025)), ("去年发表", (2025, 2025)),
    ("2019年到2018年", None), ("2020年和2023年研究的区别", None)])
def test_year_suggestions_are_grounded_and_do_not_add_a_default_year(text, expected):
    actual = year_filter(text, "2026-10-16")
    assert (None if actual is None else (actual["year_from"], actual["year_to"])) == expected
