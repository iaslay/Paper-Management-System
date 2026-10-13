"""使用模拟 HTTP 模型验证真实输入、预算、引用、版本及晚到结果。"""
import asyncio
import base64
import io
import json
import uuid
from unittest.mock import patch
import httpx
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import select, func
from app.config import Settings
from app.main import create_app
from app.models import ModelConfiguration, GenerationTask, ModelCall, PaperCard, CardVersion, DirectionDecision, User, Workspace, now
from app.ai_provider import VisionProvider, ProviderError, validate_url, pinned_address, strict_schema, normalize_options
from app.ai_schemas import ModelOptions, WireCard
from app import ai_service as service
from app import reading_service as reading
from test_management import upload, pdf, label, HEADERS, CREDENTIALS
from test_reading import create_note


def rid():
    return uuid.uuid4().hex


def wire(page=1, summary="模拟验收：这张卡片只验证处理流程。", suggestions=()):
    def claim(text, origin="paper_fact"):
        return {"text": text, "origin": origin, "evidence": [{"source_page": page, "note_id": None, "excerpt": "合成验证内容", "description": "流程验收"}]}
    return {"schema_version": "1.0", "summary": claim(summary), "research_question": claim("如何保存可靠的论文阅读卡片？"), "method": claim("通过合成模型验证页面输入、引用与版本。"), "contributions": [claim("作者主张：方便复读。", "author_claim")], "findings": [], "limitations": [claim("模拟结果不能用于论文事实判断。", "system_inference")], "paper_type": "other", "research_direction_suggestions": list(suggestions)}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, ai_worker_enabled=False))
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
        assert client.post("/api/v1/setup", json=CREDENTIALS).status_code == 200
        yield client


def configure(client, **changes):
    current = client.get("/api/v1/settings/model").json()
    options = ModelOptions(enabled=True, model="mock-vision", **changes).model_dump()
    response = client.put("/api/v1/settings/model", json={**options, "revision": current["revision"], "api_key": "private-test-key-2026"})
    assert response.status_code == 200, response.text
    with client.app.state.session_factory() as db:
        config = service.latest_config(db, 1); config.tested_mode = "pdf"; config.tested_at = now(); db.commit()
    return client.get("/api/v1/settings/model").json()


def mock_model(client, results=None, response_hook=None):
    requests = []
    def handler(request):
        body = json.loads(request.content); requests.append(body)
        if response_hook:
            return response_hook(request, body, len(requests))
        contents = body.get("input", body.get("messages"))[-1]["content"]
        limit = body.get("max_output_tokens", body.get("max_tokens"))
        if limit == 512:
            value = {"first": "PAPERBOARD_VISION_PAGE_ONE", "last": "PAPERBOARD_VISION_PAGE_TWO"} if len(contents) > 1 else {"ok": True}
        else:
            value = results.pop(0) if results else wire()
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        if "/messages" in str(request.url):
            response = {"content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "usage": {"input_tokens": 100, "output_tokens": 200}}
        elif "/chat/completions" in str(request.url):
            response = {"choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 200}}
        else:
            response = {"id": "response-check", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 100, "output_tokens": 200}}
        return httpx.Response(200, json=response)
    client.app.state.card_runner.provider_factory = lambda options, key, allow_local: VisionProvider(options, key, allow_local, transport=httpx.MockTransport(handler))
    return requests


def enqueue(client, paper, **changes):
    payload = {"request_id": rid(), **changes}
    response = client.post(f"/api/v1/papers/{paper['id']}/card-tasks", json=payload)
    assert response.status_code == 202, response.text
    return response.json(), payload


def run_task(client):
    runner = client.app.state.card_runner
    work = runner.claim(); assert work is not None
    asyncio.run(runner.execute(*work))
    return client.get(f"/api/v1/card-tasks/{work[0]}").json()


def card_state(client, paper):
    return client.get(f"/api/v1/papers/{paper['id']}/card").json()


def manual(client, paper, text="手工记录：论文方法仍需核对。", base=None, revision=None, **changes):
    state = card_state(client, paper)
    data = {"summary": {"text": text}, "research_question": {"text": "研究问题"}, "method": {"text": "研究方法"}, **changes}
    response = client.post(f"/api/v1/papers/{paper['id']}/card-versions", json={"request_id": rid(), "file_hash": paper["file_hash"], "card_revision": state["card_revision"] if revision is None else revision, "base_version_id": base, "data": data})
    assert response.status_code == 201, response.text
    return response.json()


def test_config_encryption_revisions_and_endpoint_key_isolation(client):
    config = configure(client)
    assert config["has_key"] and "api_key" not in config
    with client.app.state.session_factory() as db:
        saved = service.latest_config(db, 1)
        assert "private-test-key" not in saved.encrypted_key
        assert client.app.state.card_runner.secrets.decrypt(saved.encrypted_key) == "private-test-key-2026"
    wrong = client.put("/api/v1/settings/model", json={**ModelOptions(enabled=True,model="mock").model_dump(),"revision":0,"api_key":"new-test-key"})
    assert wrong.status_code == 409 and "private-test-key" not in wrong.text
    changed = client.put("/api/v1/settings/model", json={**ModelOptions(enabled=True,model="mock",base_url="https://different.example/v1").model_dump(),"revision":config["revision"]})
    assert changed.status_code == 422
    assert client.get("/api/v1/settings/model").json()["revision"] == config["revision"]


@pytest.mark.parametrize("url", ["http://public.example/v1", "https://user:password@public.example/v1", "https://public.example/v1?key=secret", "https://127.0.0.1/v1", "https://169.254.169.254/v1", "https://10.0.0.1/v1"])
def test_unsafe_model_addresses_are_rejected(url):
    with pytest.raises(reading.ReadingError):
        validate_url(url)


def test_dns_binding_is_checked_and_public_ip_is_pinned():
    with patch("app.ai_provider.socket.getaddrinfo", return_value=[(2,1,6,"",("127.0.0.1",443))]):
        with pytest.raises(ProviderError):
            pinned_address("https://public.example/v1/responses")
    with patch("app.ai_provider.socket.getaddrinfo", return_value=[(2,1,6,"",("8.8.8.8",443))]):
        url, authority, host = pinned_address("https://public.example/v1/responses")
        assert url.host == "8.8.8.8" and authority == host == "public.example"


@pytest.mark.parametrize("provider", ["responses", "claude", "chat"])
def test_connection_and_visual_input_protocols(client, provider):
    config = configure(client, provider=provider)
    requests = mock_model(client)
    response = client.post("/api/v1/settings/model/test", json={"revision":config["revision"]})
    assert response.status_code == 200, response.text
    assert response.json()["tested_mode"] == "pdf" and len(requests) == 2
    assert client.get("/api/v1/settings/model/usage").json()["connection_test_calls"] == 2
    assert client.get("/api/v1/papers").json()["total"] == 0


@pytest.mark.parametrize("provider,suffix", [("responses","/responses"),("claude","/messages"),("chat","/chat/completions")])
def test_complete_endpoint_is_not_appended_twice(client, provider, suffix):
    config = configure(client, provider=provider, base_url="https://public.example/v1" + suffix)
    assert config["base_url"] == "https://public.example/v1"
    targets = []
    def handler(request, body, number):
        targets.append(str(request.url))
        if provider == "responses": data = {"output":[{"type":"message","content":[{"type":"output_text","text":'{"ok":true}'}]}]}
        elif provider == "claude": data = {"content":[{"type":"text","text":'{"ok":true}'}]}
        else: data = {"choices":[{"message":{"content":'{"ok":true}'}}]}
        return httpx.Response(200,json=data)
    mock_model(client,response_hook=handler)
    with client.app.state.session_factory() as db:
        model = service.latest_config(db,1)
        result = asyncio.run(client.app.state.card_runner.provider(model).generate("测试", "测试", max_output=512))
    assert result.text == '{"ok":true}' and targets == ["https://public.example/v1" + suffix]


def test_legacy_endpoint_correction_keeps_key_for_same_service_only(client):
    config = configure(client,base_url="https://api.deepseek.com")
    with client.app.state.session_factory() as db:
        legacy = service.latest_config(db,1)
        legacy.settings_json = {**legacy.settings_json,"base_url":"https://api.deepseek.com/responses","model":"DeepSeek-V4.1-Flash"}; db.commit()
    payload = {**ModelOptions(enabled=True,model="DeepSeek-V4.1-Flash",base_url="https://api.deepseek.com/responses").model_dump(),"revision":config["revision"]}
    fixed = client.put("/api/v1/settings/model",json=payload)
    assert fixed.status_code == 200 and fixed.json()["base_url"] == "https://api.deepseek.com" and fixed.json()["model"] == "deepseek-flash" and fixed.json()["has_key"]
    with client.app.state.session_factory() as db:
        assert client.app.state.card_runner.secrets.decrypt(service.latest_config(db,1).encrypted_key) == "private-test-key-2026"
    changed = client.put("/api/v1/settings/model",json={**payload,"revision":fixed.json()["revision"],"base_url":"https://different.example"})
    assert changed.status_code == 422


def test_mismatched_endpoint_rejected_before_save(client):
    configure(client)
    current = client.get("/api/v1/settings/model").json()
    response = client.put("/api/v1/settings/model",json={**ModelOptions(enabled=True,model="vision",base_url="https://public.example/chat/completions").model_dump(),"revision":current["revision"]})
    assert response.status_code == 422 and response.json()["code"] == "endpoint_mismatch"
    assert client.get("/api/v1/settings/model").json()["revision"] == current["revision"]


def test_deepseek_auto_uses_images_and_probe_has_reasoning_disabled(client):
    config = configure(client,base_url="https://api.deepseek.com",input_mode="auto")
    requests = mock_model(client)
    response = client.post("/api/v1/settings/model/test",json={"revision":config["revision"]})
    assert response.status_code == 200 and response.json()["tested_mode"] == "images", response.text
    assert len(requests) == 2 and all(body["reasoning"] == {"effort":"none"} for body in requests)
    content = requests[-1]["input"][0]["content"]
    assert len([part for part in content if part["type"] == "input_image"]) == 2
    assert not any(part["type"] == "input_file" for part in content)


def test_deepseek_pdf_rejection_does_not_send_any_cloud_request(client):
    config = configure(client,base_url="https://api.deepseek.com",input_mode="pdf")
    requests = mock_model(client)
    response = client.post("/api/v1/settings/model/test",json={"revision":config["revision"]})
    assert response.status_code == 422 and "按页图片" in response.json()["detail"] and not requests


def test_deepseek_display_alias_does_not_change_other_services():
    options = ModelOptions(model="DeepSeek-V4.1-Flash").model_dump()
    assert normalize_options(options)["model"] == "DeepSeek-V4.1-Flash"


def test_deepseek_nullable_card_uses_json_mode_and_keeps_local_validation():
    options = ModelOptions(base_url="https://api.deepseek.com", model="deepseek-flash").model_dump()
    provider = VisionProvider(options, "test-key")
    body = provider.build("返回卡片 JSON", "中文论文助手", [], WireCard.model_json_schema())[2]
    assert body["text"]["format"] == {"type": "json_object"}
    assert body["reasoning"] == {"effort": "none"}
    WireCard.model_validate(wire())
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        WireCard.model_validate({"summary": "不符合卡片结构"})
    simple = {"type": "object", "properties": {"answer": {"type": "string"}}}
    assert provider.build("回答 JSON", "助手", [], simple)[2]["text"]["format"]["type"] == "json_schema"
    other = VisionProvider({**options, "base_url": "https://model.example.com"}, "test-key")
    assert other.build("卡片 JSON", "助手", [], WireCard.model_json_schema())[2]["text"]["format"]["type"] == "json_schema"


def test_endpoint_failure_shows_status_without_echoing_remote_secret(client):
    config = configure(client)
    mock_model(client,response_hook=lambda *args:httpx.Response(404,json={"error":{"message":"private-test-key-2026 敏感远端内容"}}))
    response = client.post("/api/v1/settings/model/test",json={"revision":config["revision"]})
    assert response.status_code == 422 and "HTTP 404" in response.json()["detail"]
    assert "private-test-key" not in response.text and "敏感远端" not in response.text


def test_visual_probe_has_two_image_pages_and_no_text_layer():
    from app.ai_worker import test_pdf as visual_probe
    import pypdfium2 as pdfium
    binary = visual_probe()
    document = PdfReader(io.BytesIO(binary))
    assert len(document.pages) == 2
    for page in document.pages:
        assert page.extract_text() == "" and len(page.images) == 1
    rendered = pdfium.PdfDocument(binary)
    try:
        for index in range(2):
            page = rendered[index]; bitmap = page.render(scale=1)
            try:
                image = bitmap.to_pil()
                assert image.convert("L").getextrema() == (0, 255)
                image.close()
            finally:
                bitmap.close(); page.close()
    finally:
        rendered.close()


def test_cleanup_removes_only_marked_old_inputs_and_retains_current_budget(client):
    import os
    configure(client); paper = upload(client); mock_model(client)
    task, _ = enqueue(client, paper); run_task(client)
    usage = client.get("/api/v1/settings/model/usage").json()["occupied_tokens"]
    with client.app.state.session_factory() as db:
        stored = db.get(GenerationTask, task["id"])
        stored.finished_at = now() - 32 * 86400; db.commit()
    root = client.app.state.settings.data_dir / "tmp"
    old_input = root / "card-input-stale"; old_input.mkdir()
    (old_input / ".paperboard-temporary").touch(); (old_input / "page.jpg").write_bytes(b"test")
    user_folder = root / "card-input-user"; user_folder.mkdir()
    (user_folder / "keep.txt").write_text("保留非系统目录", encoding="utf-8")
    recent = root / "model-test-recent"; recent.mkdir(); (recent / ".paperboard-temporary").touch()
    for path in (old_input, user_folder):
        os.utime(path, (now() - 7200, now() - 7200))
    client.app.state.cleanup()
    assert not old_input.exists() and user_folder.exists() and recent.exists()
    assert client.get("/api/v1/settings/model/usage").json()["occupied_tokens"] == usage
    assert len(card_state(client, paper)["versions"]) == 1
    with client.app.state.session_factory() as db:
        assert db.get(GenerationTask, task["id"]) is None
        assert db.scalar(select(ModelCall).where(ModelCall.task_id.is_(None))).input_tokens == 100


def test_queue_migration_preserves_finished_task_call_and_card(client):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    configure(client); paper = upload(client); mock_model(client)
    task, _ = enqueue(client, paper); run_task(client)
    state = card_state(client, paper)
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini")); config.set_main_option("script_location", str(backend / "migrations"))
    with client.app.state.engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "0004_ai_cards")
        command.upgrade(config, "head")
    with client.app.state.session_factory() as db:
        assert db.get(GenerationTask, task["id"]).queue_order == 1
        assert db.scalar(select(ModelCall).where(ModelCall.task_id == task["id"])).input_tokens == 100
    assert card_state(client, paper)["current_version_id"] == state["current_version_id"]


def test_reference_mapping_and_invalid_suggestions_are_independent(client):
    paper=upload(client); opened=client.post(f"/api/v1/papers/{paper['id']}/reader-open").json()
    source=opened["page_sources"][1]
    data,warnings=service.normalize_wire(wire(suggestions=[{"tag_id":9999,"name":None,"reason":"错误方向","source_pages":[1]}]),{1:source},[],[])
    assert data["summary"]["evidence"][0]["page_number"] == 2
    assert data["research_direction_suggestions"] == [] and warnings
    with pytest.raises(reading.ReadingError):
        service.normalize_wire(wire(page=2),{1:source},[],[])
    bad=wire();bad["method"]["evidence"]=[]
    with pytest.raises(reading.ReadingError):
        service.normalize_wire(bad,{1:source},[],[])


def test_default_notes_excluded_and_duplicate_generation_cached(client):
    configure(client);paper=upload(client);note=create_note(client,paper,content="不默认发送的私有笔记")
    task,payload=enqueue(client,paper)
    path=f"/api/v1/papers/{paper['id']}/card-tasks"
    assert client.post(path,json=payload).json()["id"] == task["id"]
    assert client.post(path,json={"request_id":rid()}).json()["id"] == task["id"]
    assert client.post(path,json={**payload,"note_ids":[note["id"]]}).status_code == 409
    with client.app.state.session_factory() as db:
        stored=db.get(GenerationTask,task["id"])
        assert stored.input_snapshot["notes"] == []
    assert len(client.get(path).json()) == 1


def test_explicit_notes_snapshot_and_cross_paper_notes_rejected(client):
    configure(client);paper=upload(client);note=create_note(client,paper,content="明确选择的记录")
    task,_=enqueue(client,paper,note_ids=[note["id"]])
    with client.app.state.session_factory() as db:
        assert db.get(GenerationTask,task["id"]).input_snapshot["notes"][0]["content"] == "明确选择的记录"
    other=upload(client,"其他论文")
    response=client.post(f"/api/v1/papers/{other['id']}/card-tasks",json={"request_id":rid(),"note_ids":[note["id"]]})
    assert response.status_code == 422


def test_budget_prevents_call_and_cannot_break_read_status(client):
    configure(client,max_task_tokens=10000,auto_on_read=True);paper=upload(client);requests=mock_model(client)
    response=client.post(f"/api/v1/papers/{paper['id']}/card-tasks",json={"request_id":rid()})
    assert response.status_code == 409 and response.json()["code"] == "task_budget_exceeded"
    updated=client.patch(f"/api/v1/papers/{paper['id']}",json={"revision":paper["revision"],"reading_status":"read"})
    assert updated.status_code == 200 and updated.json()["reading_status"] == "read"
    assert "卡片未启动" in updated.json()["card_generation_notice"]["message"] and not requests


def test_full_generation_creates_draft_and_preserves_notes_and_confirmed_version(client):
    configure(client);paper=upload(client);note=create_note(client,paper,content="个人理解不会覆盖")
    requests=mock_model(client)
    enqueue(client,paper);finished=run_task(client)
    assert finished["status"] == "succeeded", finished
    state=card_state(client,paper);version=state["versions"][0]
    assert state["current_version_id"] == version["id"] and version["confirmed_at"] is None
    confirm=client.post(f"/api/v1/card-versions/{version['id']}/confirm",json={"request_id":rid(),"card_revision":state["card_revision"]})
    assert confirm.status_code == 200
    enqueue(client,paper,regenerate=True);finished=run_task(client)
    state=card_state(client,paper)
    assert finished["status"] == "succeeded" and len(state["versions"]) == 2 and state["current_version_id"] == version["id"]
    assert client.get(f"/api/v1/notes/{note['id']}").json()["content"] == "个人理解不会覆盖"
    assert len(requests) == 2 and client.get(f"/api/v1/papers/{paper['id']}").json()["card_status"] == "confirmed"


def test_long_pdf_all_pages_are_processed_and_local_references_restored(client):
    configure(client,batch_pages=2,max_task_tokens=5000000,monthly_token_limit=10000000)
    paper=upload(client,content=pdf("长文",pages=5));pages=[]
    def handler(request,body,number):
        content=body["input"][0]["content"]
        for part in content:
            if part["type"]=="input_file":
                binary=base64.b64decode(part["file_data"].split(",",1)[1]);pages.append(len(PdfReader(io.BytesIO(binary)).pages))
        value=wire(page=3 if not any(part["type"]=="input_file" for part in content) else 1)
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(value,ensure_ascii=False)}]}],"usage":{"input_tokens":100,"output_tokens":200}})
    mock_model(client,response_hook=handler);enqueue(client,paper);finished=run_task(client)
    assert finished["status"]=="succeeded",finished
    assert pages == [2,2,1]
    evidence=card_state(client,paper)["versions"][0]["data"]["method"]["evidence"][0]
    assert evidence["page_number"]==3 and len(finished["calls"])==4


def test_format_repair_once_and_invalid_page_never_published(client):
    configure(client);paper=upload(client)
    requests=mock_model(client,results=["invalid-json",wire()]);enqueue(client,paper)
    assert run_task(client)["status"]=="succeeded" and len(requests)==2
    before=card_state(client,paper)["current_version_id"]
    requests=mock_model(client,results=[wire(page=999),wire(page=999)]);enqueue(client,paper,regenerate=True)
    failed=run_task(client)
    assert failed["status"]=="failed" and failed["error_code"]=="invalid_evidence" and len(requests)==2
    assert card_state(client,paper)["current_version_id"]==before


def test_cancelled_late_response_records_usage_without_publishing(client):
    configure(client);paper=upload(client);task,_=enqueue(client,paper)
    async def verify():
        gate=asyncio.Event();arrived=asyncio.Event()
        async def handler(request):
            arrived.set();await gate.wait()
            return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(wire(),ensure_ascii=False)}]}],"usage":{"input_tokens":101,"output_tokens":202}})
        runner=client.app.state.card_runner
        runner.provider_factory=lambda options,key,local:VisionProvider(options,key,local,transport=httpx.MockTransport(handler))
        work=runner.claim();running=asyncio.create_task(runner.execute(*work));await asyncio.wait_for(arrived.wait(),10)
        assert client.post(f"/api/v1/card-tasks/{task['id']}/cancel").status_code==200
        gate.set();await running
    asyncio.run(verify())
    result=client.get(f"/api/v1/card-tasks/{task['id']}").json()
    assert result["status"]=="cancelled" and result["charged_tokens"]==303
    assert card_state(client,paper)["versions"]==[]


def test_restart_unknown_call_is_not_resent_and_remains_budgeted(client):
    configure(client);paper=upload(client);task,_=enqueue(client,paper)
    with client.app.state.session_factory() as db:
        stored=db.get(GenerationTask,task["id"]);stored.status="running";stored.lease_until=now()-1;stored.started_at=now()-20;stored.run_token=rid()
        db.add(ModelCall(task_id=stored.id,workspace_id=1,config_id=stored.config_id,budget_month=stored.budget_month,sequence=1,stage="analyzing",estimated_tokens=20000,pages=[1,2]));db.commit()
    client.app.state.card_runner.recover()
    result=client.get(f"/api/v1/card-tasks/{task['id']}").json()
    assert result["status"]=="failed" and result["error_code"]=="restart_uncertain" and result["charged_tokens"]==20000 and result["usage_unknown"]
    assert client.app.state.card_runner.claim() is None


def test_manual_versions_confirmation_and_immutable_history(client):
    paper=upload(client);first=manual(client,paper)
    path=f"/api/v1/card-versions/{first['version']['id']}/confirm"
    payload={"request_id":rid(),"card_revision":first["card_revision"]}
    confirmed=client.post(path,json=payload);assert confirmed.status_code==200
    assert client.post(path,json=payload).json()==confirmed.json()
    second=manual(client,paper,text="人工修订的新版本",base=first["version"]["id"])
    state=card_state(client,paper)
    assert state["current_version_id"]==first["version"]["id"] and len(state["versions"])==2
    old=next(version for version in state["versions"] if version["id"]==first["version"]["id"])
    assert old["data"]["summary"]["text"]=="手工记录：论文方法仍需核对。"
    stale=client.post(f"/api/v1/card-versions/{second['version']['id']}/confirm",json={"request_id":rid(),"card_revision":1})
    assert stale.status_code==409 and stale.json()["code"]=="card_conflict"


def test_auto_read_queues_once_and_cloud_disable_cancels(client):
    config=configure(client,auto_on_read=True);paper=upload(client)
    saved=client.patch(f"/api/v1/papers/{paper['id']}",json={"revision":1,"reading_status":"read"}).json()
    assert "task_id" in saved["card_generation_notice"]
    client.patch(f"/api/v1/papers/{paper['id']}",json={"revision":2,"reading_status":"reading"})
    client.patch(f"/api/v1/papers/{paper['id']}",json={"revision":3,"reading_status":"read"})
    assert len(client.get(f"/api/v1/papers/{paper['id']}/card-tasks").json())==1
    options=ModelOptions(enabled=False,model="mock-vision",auto_on_read=True).model_dump()
    response=client.put("/api/v1/settings/model",json={**options,"revision":config["revision"]})
    assert response.status_code==200
    assert client.get(f"/api/v1/card-tasks/{saved['card_generation_notice']['task_id']}").json()["status"]=="cancelled"


def test_direction_alias_reuse_merge_and_explicit_new_name(client):
    configure(client);paper=upload(client);tag=label(client,"智能体",aliases=["Agent"])
    suggestions=[{"tag_id":None,"name":"Agent","reason":"与智能体相关","source_pages":[1]},{"tag_id":None,"name":"新研究方向","reason":"候选领域","source_pages":[1]}]
    mock_model(client,results=[wire(suggestions=suggestions)]);enqueue(client,paper);assert run_task(client)["status"]=="succeeded"
    version=card_state(client,paper)["versions"][0]
    path=f"/api/v1/card-versions/{version['id']}/direction-suggestions"
    accepted=client.post(path+"/0/accept",json={"request_id":rid(),"paper_revision":paper["revision"]})
    assert accepted.status_code==200 and accepted.json()["decision"]["tag_id"]==tag["id"]
    assert len(client.get("/api/v1/tags").json())==1
    current=accepted.json()["paper"]
    refused=client.post(path+"/1/accept",json={"request_id":rid(),"paper_revision":current["revision"]})
    assert refused.status_code==409
    accepted=client.post(path+"/1/accept",json={"request_id":rid(),"paper_revision":current["revision"],"create_new":True})
    assert accepted.status_code==200 and len(accepted.json()["paper"]["research_directions"])==2


def test_deleted_paper_preserves_billed_usage_but_removes_cards(client):
    configure(client);paper=upload(client);mock_model(client);enqueue(client,paper);assert run_task(client)["status"]=="succeeded"
    client.delete(f"/api/v1/papers/{paper['id']}?revision=1")
    assert client.delete(f"/api/v1/papers/{paper['id']}/permanent?revision=2").status_code==200
    usage=client.get("/api/v1/settings/model/usage").json()
    assert usage["accounted_tokens"]==300
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(CardVersion))==0
        assert db.scalar(select(func.count()).select_from(ModelCall))==1


def test_pdf_capability_can_fall_back_to_real_page_images(client):
    from PIL import Image
    config=configure(client);images=[]
    def handler(request,body,number):
        content=body["input"][0]["content"]
        if any(item["type"]=="input_file" for item in content):
            return httpx.Response(400,json={"error":"当前测试接口只接受图片"})
        for item in content:
            if item["type"]=="input_image":
                image=Image.open(io.BytesIO(base64.b64decode(item["image_url"].split(",",1)[1])))
                images.append(image.size)
        value={"first":"PAPERBOARD_VISION_PAGE_ONE","last":"PAPERBOARD_VISION_PAGE_TWO"} if images else {"ok":True}
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(value)}]}],"usage":{"input_tokens":10,"output_tokens":20}})
    requests=mock_model(client,response_hook=handler)
    response=client.post("/api/v1/settings/model/test",json={"revision":config["revision"]})
    assert response.status_code==200, response.text
    assert response.json()["tested_mode"]=="images" and len(images)==2 and len(requests)==3
    assert all(max(size)<=1000 for size in images)


def test_unknown_usage_is_accounted_and_refusal_usage_is_retained(client):
    configure(client);paper=upload(client)
    def missing_usage(request,body,number):
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(wire(),ensure_ascii=False)}]}]})
    mock_model(client,response_hook=missing_usage);enqueue(client,paper);result=run_task(client)
    assert result["status"]=="succeeded" and result["usage_unknown"] and result["charged_tokens"]>0
    current=card_state(client,paper)["current_version_id"]
    def refusal(request,body,number):
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"拒绝分析"}]}],"usage":{"input_tokens":77,"output_tokens":22}})
    requests=mock_model(client,response_hook=refusal);enqueue(client,paper,regenerate=True);result=run_task(client)
    assert result["status"]=="failed" and result["charged_tokens"]==99 and len(requests)==1
    assert card_state(client,paper)["current_version_id"]==current


def test_changing_model_cannot_change_queued_input_mode(client):
    configured=configure(client);paper=upload(client);task,_=enqueue(client,paper)
    with client.app.state.session_factory() as db:
        stored=db.get(GenerationTask,task["id"])
        assert stored.input_snapshot["input_mode"]=="pdf"
        config=db.get(ModelConfiguration,stored.config_id);config.tested_mode="images";db.commit()
    requests=mock_model(client);result=run_task(client)
    assert result["status"]=="succeeded"
    assert requests[0]["input"][0]["content"][0]["type"]=="input_file"
    version=card_state(client,paper)["versions"][0]
    assert version["model_info"]["input_mode"]=="pdf" and version["model_info"]["config_revision"]==configured["revision"]


def test_foreign_workspace_cannot_access_cards_tasks_or_config(client):
    configure(client);paper=upload(client);task,_=enqueue(client,paper);manual(client,paper)
    with client.app.state.session_factory() as db:
        db.add(Workspace(id=2,name="其他空间",quota_bytes=10000000))
        db.flush()
        db.add(User(id=2,workspace_id=2,username="other-reader",password_hash=db.get(User,1).password_hash));db.commit()
    client.delete("/api/v1/session")
    assert client.post("/api/v1/session",json={"username":"other-reader","password":CREDENTIALS["password"]}).status_code==200
    assert client.get(f"/api/v1/papers/{paper['id']}/card").status_code==404
    assert client.get(f"/api/v1/card-tasks/{task['id']}").status_code==404
    assert client.get("/api/v1/settings/model").json()["has_key"] is False


def test_user_rewrites_invalidate_evidence_checks(client):
    configure(client);paper=upload(client);mock_model(client);enqueue(client,paper);assert run_task(client)["status"]=="succeeded"
    state=card_state(client,paper);base=state["versions"][0];data=base["data"]
    data["summary"]["text"]="用户改写的简介";data["summary"]["evidence"][0]["verification"]="user_checked"
    result=client.post(f"/api/v1/papers/{paper['id']}/card-versions",json={"request_id":rid(),"file_hash":paper["file_hash"],"card_revision":state["card_revision"],"base_version_id":base["id"],"data":data})
    assert result.status_code==201, result.text
    saved=result.json()["version"]["data"]["summary"]
    assert saved["origin"]=="user_record" and saved["evidence"][0]["verification"]=="unverified"


def test_ignored_suggestions_are_not_auto_added_and_merge_target_is_resolved(client):
    configure(client);paper=upload(client);source=label(client,"旧方向");target=label(client,"新方向")
    suggestions=[{"tag_id":source["id"],"name":None,"reason":"模拟推荐","source_pages":[1]},{"tag_id":None,"name":"忽略方向","reason":"模拟推荐","source_pages":[1]}]
    mock_model(client,results=[wire(suggestions=suggestions)]);enqueue(client,paper);assert run_task(client)["status"]=="succeeded"
    version=card_state(client,paper)["versions"][0];path=f"/api/v1/card-versions/{version['id']}/direction-suggestions"
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["research_directions"]==[]
    merged=client.post(f"/api/v1/tags/{source['id']}/merge",json={"revision":1,"target_id":target["id"],"target_revision":1})
    assert merged.status_code==200
    response=client.post(path+"/0/accept",json={"request_id":rid(),"paper_revision":paper["revision"]})
    assert response.status_code==200 and response.json()["decision"]["tag_id"]==target["id"]
    current=response.json()["paper"]
    ignored=client.post(path+"/1/ignore",json={"request_id":rid(),"paper_revision":current["revision"]})
    assert ignored.status_code==200
    accepted=client.post(path+"/1/accept",json={"request_id":rid(),"paper_revision":current["revision"],"create_new":True})
    assert accepted.status_code==200 and accepted.json()["decision"]["status"]=="ignored"
    assert len(client.get("/api/v1/tags").json())==1


def test_same_second_tasks_keep_creation_order(client):
    configure(client);paper=upload(client)
    first,_=enqueue(client,paper)
    client.post(f"/api/v1/card-tasks/{first['id']}/cancel")
    second,_=enqueue(client,paper,regenerate=True)
    with client.app.state.session_factory() as db:
        one=db.get(GenerationTask,first["id"]);two=db.get(GenerationTask,second["id"])
        one.created_at=two.created_at=now();db.commit()
        assert one.queue_order < two.queue_order
    listed=client.get(f"/api/v1/papers/{paper['id']}/card-tasks").json()
    assert listed[0]["id"]==second["id"]
