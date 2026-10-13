"""验证免密钥翻译、权限、缓存、取消及错误，不在回归测试中调用远端。"""
import asyncio
import json
import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.translation import TranslationProvider, TranslationService, translation_base, AUTHORIZED_HTTP_BASE
from app.ai_provider import ProviderError, validate_url
from app.reading_service import ReadingError
from fastapi.testclient import TestClient
from test_management import upload, CREDENTIALS, HEADERS
from app.models import Paper, Workspace


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, ai_worker_enabled=False))
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as client:
        client.post("/api/v1/setup", json=CREDENTIALS)
        yield client


def body(paper, **changes):
    return {"quote": "Large language models use structured memory.", "page_number": 1, "file_hash": paper["file_hash"], **changes}


def mock(client, response=None):
    calls = []
    def handle(request):
        calls.append(request)
        return response or httpx.Response(200, json={"choices": [{"message": {"content": "大型语言模型使用结构化记忆。"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 50, "completion_tokens": 12}})
    settings = client.app.state.settings
    client.app.state.translation_service.provider_factory = lambda: TranslationProvider(settings, httpx.MockTransport(handle))
    return calls


def test_keyless_request_and_scoped_cache_do_not_change_records(client):
    paper = upload(client); calls = mock(client)
    config = client.get("/api/v1/settings/translation").json()
    assert config["enabled"] and not config["requires_api_key"] and config["model"] == "Qwen/Qwen3.5-9B"
    response = client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper))
    assert response.status_code == 200, response.text
    assert response.json()["translation"] == "大型语言模型使用结构化记忆。"
    assert not response.json()["cached"] and len(calls) == 1
    request = calls[0]; sent = json.loads(request.content)
    assert "authorization" not in request.headers and "x-api-key" not in request.headers
    assert str(request.url) == AUTHORIZED_HTTP_BASE + "/chat/completions"
    assert sent["model"] == config["model"] and sent["chat_template_kwargs"] == {"enable_thinking": False}
    assert sent["messages"][-1]["content"] == body(paper)["quote"]
    assert len(sent["messages"]) == 2 and not sent["stream"]
    second = client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper)).json()
    assert second["cached"] and len(calls) == 1
    client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper, page_number=2))
    assert len(calls) == 2
    assert client.get(f"/api/v1/papers/{paper['id']}/notes").json()["total"] == 0
    assert client.get(f"/api/v1/papers/{paper['id']}/position").json() is None
    assert "no-store" in response.headers["cache-control"]


@pytest.mark.parametrize("change", [{"quote": " "}, {"quote": "a" * 2001}, {"quote": "\x00"}, {"page_number": 9}, {"file_hash": "f" * 64}, {"base_url": "http://127.0.0.1"}])
def test_invalid_input_is_rejected_before_call(client, change):
    paper = upload(client); calls = mock(client)
    response = client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper, **change))
    assert response.status_code in {409, 422} and not calls


def test_authentication_origin_and_paper_ownership(client):
    paper = upload(client); calls = mock(client)
    assert client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper), headers={"origin": "https://foreign.example"}).status_code == 403
    assert client.post("/api/v1/papers/unknown/translation", json=body(paper)).status_code == 404
    client.delete("/api/v1/session")
    assert client.get("/api/v1/settings/translation").status_code == 401
    assert client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper)).status_code == 401
    assert not calls


def test_disabled_translation_does_not_call(client):
    paper = upload(client); calls = mock(client)
    client.app.state.settings.translation_enabled = False
    assert client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper)).status_code == 503
    assert not calls


def test_cached_translation_still_checks_workspace_ownership(client):
    paper = upload(client); calls = mock(client)
    assert client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper)).status_code == 200
    with client.app.state.session_factory() as db:
        foreign = Workspace(name="其他论文库", quota_bytes=10000000); db.add(foreign); db.flush()
        db.get(Paper, paper['id']).workspace_id = foreign.id; db.commit()
    assert client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper)).status_code == 404
    assert len(calls) == 1


@pytest.mark.parametrize("response,code", [(httpx.Response(429), "translation_rate_limited"), (httpx.Response(401), "translation_access_denied"), (httpx.Response(500), "translation_unavailable"), (httpx.Response(200, content=b'not-json'), "translation_invalid_response"), (httpx.Response(200, json={"choices": [{"message": {"content": "截断译文"}, "finish_reason": "length"}]}), "translation_incomplete")])
def test_provider_failure_is_clear_and_not_cached(client, response, code):
    paper = upload(client); calls = mock(client, response)
    for _ in range(2):
        result = client.post(f"/api/v1/papers/{paper['id']}/translation", json=body(paper))
        assert result.status_code == 502 and result.json()["code"] == code
    assert len(calls) == 2 and not client.app.state.translation_service.running


def test_scoped_http_exception_does_not_weaken_other_model_addresses():
    assert translation_base(AUTHORIZED_HTTP_BASE + "/chat/completions") == AUTHORIZED_HTTP_BASE
    for address in ["http://127.0.0.1/v1", "http://10.0.0.1/v1", "http://47.100.90.123:8009/v1", AUTHORIZED_HTTP_BASE + "?key=test"]:
        with pytest.raises(ReadingError): translation_base(address)
    with pytest.raises(ReadingError): validate_url(AUTHORIZED_HTTP_BASE)


def test_thinking_is_removed_and_timeout_is_reported(tmp_path):
    settings = Settings(data_dir=tmp_path)
    provider = TranslationProvider(settings, httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{"message": {"content": "<think>内部过程</think>正确译文"}, "finish_reason": "stop"}]})))
    assert asyncio.run(provider.generate("test"))["translation"] == "正确译文"
    def timeout(request): raise httpx.ReadTimeout("timeout", request=request)
    provider = TranslationProvider(settings, httpx.MockTransport(timeout))
    with pytest.raises(ProviderError) as error: asyncio.run(provider.generate("test"))
    assert error.value.code == "translation_timeout"


def test_disconnect_cancels_upstream_and_releases_busy_state(tmp_path):
    service = TranslationService(Settings(data_dir=tmp_path)); cancelled = []
    class Pending:
        async def generate(self, _):
            try: await asyncio.sleep(30)
            finally: cancelled.append(True)
    service.provider_factory = Pending
    async def disconnected(): return True
    with pytest.raises(ReadingError) as error:
        asyncio.run(service.translate((1, 1), ("paper", "hash", 1), "test", disconnected))
    assert error.value.body["code"] == "translation_cancelled" and cancelled and not service.running and not service.cache


def test_cache_is_user_scoped_and_rate_limit_is_bounded(tmp_path):
    service = TranslationService(Settings(data_dir=tmp_path)); calls = []
    class Echo:
        async def generate(self, text): calls.append(text); return {"translation": "译文", "model": "mock"}
    service.provider_factory = Echo
    async def connected(): return False
    async def run():
        await service.translate((1, 1), ("paper", "hash", 1), "test", connected)
        await service.translate((1, 2), ("paper", "hash", 1), "test", connected)
        for number in range(19): await service.translate((1, 1), ("paper", "hash", 1), str(number), connected)
        with pytest.raises(ReadingError) as error: await service.translate((1, 1), ("paper", "hash", 1), "too-many", connected)
        assert error.value.status == 429
        assert len(calls) == 21
        await service.close()
    asyncio.run(run())
