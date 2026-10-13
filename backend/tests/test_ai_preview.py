"""速览只重述已有卡片，验证隐私、不可变版本和晚到结果。"""
import copy
import json
import httpx
from sqlalchemy import select
from app.models import GenerationTask, CardVersion
from test_ai_cards import client, configure, mock_model, run_task, rid, wire, enqueue as enqueue_card, card_state, manual
from test_management import upload
from test_reading import create_note

PREVIEW = {"headline": "让对话系统持续记住用户", "problem": "对话变长后，系统难以记住用户的信息。", "approach": "分层保存用户信息，并随对话持续更新。", "benefit": "帮助系统提供更一致的个性化回答。"}


def setup_card(client, preview=None):
    configure(client); paper = upload(client)
    data = wire()
    if preview: data["preview"] = preview
    mock_model(client, [data]); enqueue_card(client, paper); assert run_task(client)["status"] == "succeeded"
    state = card_state(client, paper); version = state["versions"][0]
    response = client.post(f"/api/v1/card-versions/{version['id']}/confirm", json={"request_id": rid(), "card_revision": state["card_revision"]})
    assert response.status_code == 200, response.text
    return paper, card_state(client, paper)


def enqueue(client, paper, **changes):
    payload = {"request_id": rid(), **changes}
    result = client.post(f"/api/v1/papers/{paper['id']}/preview-tasks", json=payload)
    assert result.status_code == 202, result.text
    return result.json(), payload


def test_preview_preserves_confirmed_version_and_sends_no_pdf_or_personal_records(client):
    paper, state = setup_card(client)
    create_note(client, paper, content="绝不发送的私人笔记")
    with client.app.state.session_factory() as db:
        version = db.get(CardVersion, state["current_version_id"])
        data = copy.deepcopy(version.data)
        data["personal_value"] = "绝不发送的个人用途"
        data["limitations"].append({"text": "绝不发送的用户修改", "origin": "user_record", "evidence": []})
        version.data = data; db.commit()
    before = card_state(client, paper)
    requests = mock_model(client, [PREVIEW]); enqueue(client, paper)
    result = run_task(client)
    assert result["status"] == "succeeded" and result["preview"] == PREVIEW and result["result_version_id"] is None
    assert card_state(client, paper) == before
    body = json.dumps(requests, ensure_ascii=False)
    assert all(value not in body for value in ["绝不发送的私人笔记", "绝不发送的个人用途", "绝不发送的用户修改", "input_file", "input_image"])
    dto = client.get(f"/api/v1/papers/{paper['id']}").json()
    assert dto["card_status"] == "confirmed" and dto["card_preview"] == {**PREVIEW, "version_id": state["current_version_id"]}
    assert len(client.get(f"/api/v1/papers/{paper['id']}/card-tasks").json()) == 1
    assert len(client.get(f"/api/v1/papers/{paper['id']}/preview-tasks").json()) == 1


def test_preview_cache_and_request_id_are_isolated(client):
    paper, _ = setup_card(client)
    task, payload = enqueue(client, paper)
    assert client.post(f"/api/v1/papers/{paper['id']}/preview-tasks", json=payload).json()["id"] == task["id"]
    assert enqueue(client, paper)[0]["id"] == task["id"]
    reused = client.post(f"/api/v1/papers/{paper['id']}/card-tasks", json=payload)
    assert reused.status_code == 409 and reused.json()["code"] == "request_id_reused"


def test_preview_invalid_output_repairs_once_without_changing_card(client):
    paper, before = setup_card(client)
    requests = mock_model(client, [{**PREVIEW, "headline": "字" * 41}, "格式错误"])
    enqueue(client, paper); result = run_task(client)
    assert result["status"] == "failed" and result["preview"] is None and len(requests) == 2
    assert card_state(client, paper) == before
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["card_preview"] is None


def test_preview_cancellation_and_source_change_discard_late_result(client):
    paper, before = setup_card(client)
    task, _ = enqueue(client, paper)
    def cancel(request, body, number):
        assert client.post(f"/api/v1/card-tasks/{task['id']}/cancel").status_code == 200
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(PREVIEW)}]}], "usage": {"input_tokens": 100, "output_tokens": 100}})
    mock_model(client, response_hook=cancel); assert run_task(client)["status"] == "cancelled"
    assert card_state(client, paper) == before
    enqueue(client, paper, regenerate=True)
    def edit(request, body, number):
        saved = manual(client, paper)
        assert client.post(f"/api/v1/card-versions/{saved['version']['id']}/confirm", json={"request_id": rid(), "card_revision": saved["card_revision"]}).status_code == 200
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(PREVIEW)}]}], "usage": {"input_tokens": 100, "output_tokens": 100}})
    mock_model(client, response_hook=edit); result = run_task(client)
    assert result["status"] == "failed" and result["error_code"] == "preview_outdated"
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["card_preview"] is None


def test_new_card_preview_survives_confirm_but_expires_when_body_is_edited(client):
    paper, state = setup_card(client, PREVIEW)
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["card_preview"]["headline"] == PREVIEW["headline"]
    data = copy.deepcopy(state["versions"][0]["data"]); data["summary"]["text"] = "用户更新了研究问题的理解。"
    response = client.post(f"/api/v1/papers/{paper['id']}/card-versions", json={"request_id": rid(), "file_hash": paper["file_hash"], "card_revision": state["card_revision"], "base_version_id": state["current_version_id"], "data": data})
    assert response.status_code == 201, response.text
    assert response.json()["version"]["data"]["preview"] is None
    saved = response.json()
    assert client.post(f"/api/v1/card-versions/{saved['version']['id']}/confirm", json={"request_id": rid(), "card_revision": saved["card_revision"]}).status_code == 200
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["card_preview"] is None


def test_missing_or_all_private_card_is_not_sent(client):
    configure(client); paper = upload(client)
    assert client.post(f"/api/v1/papers/{paper['id']}/preview-tasks", json={"request_id": rid()}).json()["code"] == "card_missing"
    manual(client, paper)
    result = client.post(f"/api/v1/papers/{paper['id']}/preview-tasks", json={"request_id": rid()})
    assert result.status_code == 409 and result.json()["code"] == "preview_source_missing"
    with client.app.state.session_factory() as db:
        assert db.scalar(select(GenerationTask)) is None
