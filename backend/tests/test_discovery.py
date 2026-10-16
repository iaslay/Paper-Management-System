"""检索与导入的真实事务、隔离索引及故障回归；外部网络使用模拟响应。"""
import hashlib
import json
import uuid
from types import SimpleNamespace
import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.config import Settings
from app.main import create_app, PASSWORDS
from app.models import Paper, User, Workspace
from app.discovery_models import DiscoveryConfiguration, LiteratureCandidate, PaperImportTask
from app.literature_providers import LiteratureRecord
from app.reading_service import ReadingError, fail
from test_management import pdf, CREDENTIALS, HEADERS


def rid():
    return uuid.uuid4().hex


def atom(source_id="2601.05960v2", title="Long-term memory methods", total=1):
    entry = f'''<entry><id>https://arxiv.org/abs/{source_id}</id><title>{title}</title>
    <summary>Memory updates with $M_t$.</summary><author><name>Alice</name></author>
    <published>2026-01-10T00:00:00Z</published><updated>2026-02-10T00:00:00Z</updated><category term="cs.CL"/></entry>''' if total else ""
    return f'''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
    <opensearch:totalResults>{total}</opensearch:totalResults>{entry}</feed>'''


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, ai_worker_enabled=False, discovery_worker_enabled=False))
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as http:
        assert http.post("/api/v1/setup", json=CREDENTIALS).status_code == 200
        app.state.discovery_service.remote.arxiv_interval = 0
        yield http


def wire(client, hook=None, content=None):
    calls = []
    def response(request):
        calls.append(request)
        if hook:
            custom = hook(request)
            if custom is not None:
                return custom
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, text=atom(request.url.params.get("id_list", "2601.05960v2")))
        if request.url.host == "ieeexploreapi.ieee.org":
            return httpx.Response(200, json={"total_records": 1, "articles": [{"article_number": "8705689", "title": "External memory networks", "abstract": "An abstract.", "publication_year": 2020, "doi": "10.1109/test.123", "authors": {"authors": [{"full_name": "Alice"}]}, "pdf_url": "http://127.0.0.1/private"}]})
        return httpx.Response(200, content=content if content is not None else pdf("来源原文"))
    client.app.state.discovery_service.http.transport = httpx.MockTransport(response)
    return calls


def candidate(client, provider="arxiv", source_id="2601.05960v2", **extra):
    result = client.post("/api/v1/discovery/candidates", json={"provider": provider, "source_id": source_id, **extra})
    assert result.status_code == 200, result.text
    return result.json()


def enqueue(client, item, request=None):
    result = client.post("/api/v1/paper-imports", json={"candidate_id": item["id"], "request_id": request or rid()})
    assert result.status_code == 202, result.text
    return result.json()


def perform(client):
    assert client.portal.call(client.app.state.discovery_service.process_import)


def ieee_key(client, key="private-ieee-test-key", **extra):
    before = client.get("/api/v1/settings/discovery-providers").json()
    response = client.put("/api/v1/settings/discovery-providers/ieee", json={"revision": before["revision"], "api_key": key, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def fake_paper(source_id="2022.acl-long.220", title="Memory-based dialogue", collection="2022.acl", year=2022):
    return SimpleNamespace(full_id=source_id, title=title, authors=[SimpleNamespace(name="Alice")], abstract="A memory method.",
        is_frontmatter=False, is_deleted=False, parent=SimpleNamespace(venue_acronym="ACL", title="ACL", full_id="2022.acl-long"),
        year=year, doi="10.18653/v1/" + source_id, web_url="https://aclanthology.org/" + source_id + "/",
        pdf=SimpleNamespace(url="https://aclanthology.org/" + source_id + ".pdf"), collection_id=collection)


class AnthologySample:
    def __init__(self, papers):
        self.items = papers

    def papers(self):
        return iter(self.items)

    def get_collection(self, name):
        subset = [p for p in self.items if p.collection_id == name]
        return AnthologySample(subset) if subset else None


def index(client, papers=None, revision="sample-1", **options):
    return client.app.state.discovery_service.acl.build(AnthologySample(papers or [fake_paper()]), revision, lambda count: None, **options)


def test_sources_do_not_require_ieee_key_and_first_acl_has_distinct_state(client):
    calls = wire(client)
    result = client.get("/api/v1/discovery/providers").json()
    assert result["arxiv"]["ready"] and not result["acl"]["ready"] and not result["ieee"]["configured"]
    assert not calls
    assert client.get("/api/v1/discovery/search", params={"provider": "ieee", "q": "memory"}).json()["code"] == "provider_not_configured"
    assert client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "memory"}).json()["code"] == "source_not_ready"
    assert client.get("/api/v1/papers").json()["total"] == 0


def test_arxiv_metadata_filters_cache_and_local_saved_status(client):
    calls = wire(client)
    params = {"provider": "arxiv", "q": "long-term memory", "field": "title", "year_from": 2025, "year_to": 2026, "category": "cs.CL"}
    first = client.get("/api/v1/discovery/search", params=params).json()
    assert first["items"][0]["source_id"] == "2601.05960v2" and first["items"][0]["version"] == "v2"
    assert first["items"][0]["authors"] == ["Alice"] and first["items"][0]["pdf_url"].endswith("2601.05960v2")
    saved = candidate(client)
    second = client.get("/api/v1/discovery/search", params=params).json()
    assert second["cached"] and second["items"][0]["candidate_id"] == saved["id"] and second["items"][0]["saved"]
    assert len(calls) == 1
    assert 'ti:"long-term"' in calls[0].url.params["search_query"] and 'submittedDate:[202501010000 TO 202612312359]' in calls[0].url.params["search_query"]


@pytest.mark.parametrize("params", [
    {"q": "   "}, {"q": "a", "year_from": 2026, "year_to": 2020}, {"q": "a", "date_from": "2026-99-10"},
    {"q": "a", "date_from": "2026-10-15", "date_to": "2026-01-01"}, {"q": "a", "cursor": "bad"}, {"q": "x" * 501},
])
def test_invalid_queries_do_not_send_network_requests(client, params):
    calls = wire(client)
    assert client.get("/api/v1/discovery/search", params={"provider": "arxiv", **params}).status_code == 422
    assert not calls


def test_source_zero_and_error_do_not_look_the_same(client):
    wire(client, hook=lambda request: httpx.Response(200, text=atom(total=0)))
    assert client.get("/api/v1/discovery/search", params={"provider": "arxiv", "q": "empty"}).json()["total"] == 0
    wire(client, hook=lambda request: httpx.Response(503, text="remote error contains private data"))
    response = client.get("/api/v1/discovery/search", params={"provider": "arxiv", "q": "other"})
    assert response.status_code == 502 and "remote error" not in response.text


@pytest.mark.parametrize("value", ["https://evil.example/abs/2601.05960v2", "https://arxiv.org@127.0.0.1/abs/2601.05960v2", "../../data/private", "http://127.0.0.1"])
def test_untrusted_identifier_cannot_start_a_download(client, value):
    calls = wire(client)
    assert client.post("/api/v1/discovery/candidates", json={"provider": "arxiv", "source_id": value}).status_code == 422
    assert not calls


def test_import_is_transactional_idempotent_and_keeps_source_metadata(client):
    wire(client)
    item = candidate(client)
    request = rid()
    task = enqueue(client, item, request)
    assert enqueue(client, item, request)["id"] == task["id"]
    perform(client)
    final = client.get("/api/v1/paper-imports/" + task["id"]).json()
    assert final["status"] == "succeeded" and final["paper_id"]
    paper = client.get("/api/v1/papers/" + final["paper_id"]).json()
    assert paper["title"] == "Long-term memory methods" and paper["authors"] == ["Alice"] and paper["reading_status"] == "unread"
    assert client.get("/api/v1/papers/" + paper["id"] + "/file").content.startswith(b"%PDF")
    assert client.get("/api/v1/papers").json()["total"] == 1
    assert enqueue(client, item, request)["status"] == "succeeded"
    assert not list((client.app.state.settings.data_dir / "tmp").iterdir())


@pytest.mark.parametrize("content", [b"<html>Login page</html>", b"not a PDF", pdf(encrypted=True), pdf(pages=301)], ids=["login-html", "invalid-pdf", "encrypted-pdf", "too-many-pages"])
def test_invalid_remote_files_leave_candidates_and_no_papers(client, content):
    wire(client, content=content)
    item = candidate(client)
    task = enqueue(client, item)
    perform(client)
    assert client.get("/api/v1/paper-imports/" + task["id"]).json()["status"] == "failed"
    assert client.get("/api/v1/papers").json()["total"] == 0
    assert client.get("/api/v1/discovery/candidates").json()[0]["id"] == item["id"]


def test_redirect_to_private_address_is_rejected(client):
    wire(client, hook=lambda request: httpx.Response(302, headers={"Location": "https://127.0.0.1/private"}) if request.url.host == "arxiv.org" else None)
    task = enqueue(client, candidate(client))
    perform(client)
    assert client.get("/api/v1/paper-imports/" + task["id"]).json()["status"] == "failed"
    assert client.get("/api/v1/papers").json()["total"] == 0


def test_cancelled_late_download_cannot_register_and_retry_has_new_request(client):
    def cancel(request):
        if request.url.host == "arxiv.org":
            with client.app.state.session_factory() as db:
                task = db.scalar(select(PaperImportTask).where(PaperImportTask.status == "running"))
                task.status = "cancelled"
                db.commit()
    wire(client, hook=cancel)
    task = enqueue(client, candidate(client))
    perform(client)
    assert client.get("/api/v1/paper-imports/" + task["id"]).json()["status"] == "cancelled"
    assert client.get("/api/v1/papers").json()["total"] == 0
    retry_id = rid()
    retried = client.post(f"/api/v1/paper-imports/{task['id']}/retry", json={"request_id": retry_id})
    again = client.post(f"/api/v1/paper-imports/{task['id']}/retry", json={"request_id": retry_id})
    assert retried.status_code == 202 and retried.json()["id"] == again.json()["id"] and retried.json()["id"] != task["id"]
    wire(client)
    perform(client)
    assert client.get("/api/v1/papers").json()["total"] == 1


def test_restart_does_not_resend_a_running_import(client):
    wire(client)
    task = enqueue(client, candidate(client))
    with client.app.state.session_factory() as db:
        db.get(PaperImportTask, task["id"]).status = "running"
        db.commit()
    client.app.state.discovery_service.recover()
    assert client.get("/api/v1/paper-imports/" + task["id"]).json()["status"] == "failed"
    assert not client.portal.call(client.app.state.discovery_service.process_import)


def test_ieee_secret_test_quota_and_missing_key_are_independent_from_models(client):
    calls = wire(client)
    config = ieee_key(client, daily_limit=2)
    assert config["configured"] and "private-ieee-test-key" not in json.dumps(config)
    with client.app.state.session_factory() as db:
        encrypted = db.get(DiscoveryConfiguration, 1).key_cipher
        assert "private-ieee-test-key" not in encrypted and client.app.state.discovery_service.secrets.decrypt(encrypted) == "private-ieee-test-key"
    assert client.post("/api/v1/settings/discovery-providers/ieee/test").json()["test_status"] == "passed"
    first = client.get("/api/v1/discovery/search", params={"provider": "ieee", "q": "memory"})
    assert first.status_code == 200 and first.json()["items"][0]["access"] == "institution"
    assert first.json()["items"][0]["pdf_url"] is None
    assert client.get("/api/v1/discovery/search", params={"provider": "ieee", "q": "memory"}).json()["cached"]
    assert client.get("/api/v1/discovery/search", params={"provider": "ieee", "q": "second"}).json()["code"] == "local_daily_limit"
    assert len(calls) == 2 and calls[0].url.params["apikey"] == "private-ieee-test-key"


@pytest.mark.parametrize("status,code", [(403, "source_rejected"), (429, "source_rate_limited"), (503, "source_unavailable")])
def test_ieee_errors_are_redacted_and_do_not_trigger_scraping(client, status, code):
    calls = wire(client, hook=lambda request: httpx.Response(status, text="private-ieee-test-key should never be returned"))
    ieee_key(client)
    result = client.post("/api/v1/settings/discovery-providers/ieee/test")
    assert result.json()["code"] == code and "private-ieee-test-key" not in result.text
    assert len(calls) == 1
    assert client.get("/api/v1/settings/discovery-providers").json()["test_status"] == "failed"


def test_institution_pdf_upload_needs_explicit_correspondence_and_links_candidate(client):
    wire(client)
    ieee_key(client)
    item = candidate(client, "ieee", "8705689")
    assert client.post("/api/v1/paper-imports", json={"candidate_id": item["id"], "request_id": rid()}).json()["code"] == "institution_required"
    assert client.post("/api/v1/papers", files={"file": ("paper.pdf", pdf())}, data={"candidate_id": item["id"]}).status_code == 409
    response = client.post("/api/v1/papers", files={"file": ("paper.pdf", pdf())}, data={"candidate_id": item["id"], "candidate_confirmed": "true"})
    assert response.status_code == 201, response.text
    assert response.json()["paper"]["doi"] == "10.1109/test.123"
    assert client.get("/api/v1/discovery/candidates").json()[0]["paper_id"] == response.json()["paper"]["id"]
    assert "vpn.uestc.edu.cn" in client.get("/api/v1/settings/institution-access").json()["portal_url"]


def test_acl_index_is_separate_searchable_and_generation_is_consistent(client):
    papers = [fake_paper(f"2022.acl-long.{i}", f"Memory dialogue {i}") for i in range(1, 24)]
    first = index(client, papers)
    result = client.get("/api/v1/discovery/search", params={"provider": "acl", "q": '"Memory dialogue"', "year_from": 2022, "venue": "ACL"}).json()
    assert result["total"] == 23 and len(result["items"]) == 20 and result["next_cursor"]
    assert client.get("/api/v1/papers").json()["total"] == 0
    index(client, papers, revision="sample-2", changed={"2022.acl"})
    assert first["generation"] != client.app.state.discovery_service.acl.state()["generation"]
    response = client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "memory", "cursor": result["next_cursor"]})
    assert response.json()["code"] == "index_changed"
    assert client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "2022.acl-long.1"}).json()["items"][0]["source_id"] == "2022.acl-long.1"


def test_acl_failed_update_retains_old_index_and_missing_abstract_and_year(client):
    paper = fake_paper(year=None)
    paper.abstract = None
    original = index(client, [paper])
    def broken(_):
        fail("模拟更新失败", "sample_failure")
    with pytest.raises(ReadingError):
        client.app.state.discovery_service.acl.build(AnthologySample([fake_paper()]), "broken", broken)
    assert client.app.state.discovery_service.acl.state()["generation"] == original["generation"]
    found = client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "memory"}).json()["items"][0]
    assert found["year"] is None and found["abstract"] == "" and not found["version"]
    assert client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "memory", "date_from": "2026-01-01"}).status_code == 422


def test_acl_official_name_and_extra_venue_fields_are_compatible(client, tmp_path):
    from acl_anthology.people.name import Name
    paper = fake_paper()
    paper.authors = [SimpleNamespace(name=Name(first="James", last="Hammerton"))]
    paper.parent = SimpleNamespace(venue_ids=["acl"], title="ACL", full_id="2022.acl-long")
    anthology = AnthologySample([paper])
    anthology.datadir = tmp_path / "official-sample"
    (anthology.datadir / "json").mkdir(parents=True)
    (anthology.datadir / "json/venues.json").write_text(json.dumps({"acl": {"acronym": "ACL", "related_ids": []}}), encoding="utf-8")
    client.app.state.discovery_service.acl.build(anthology, "official-sample", lambda count: None)
    result = client.get("/api/v1/discovery/search", params={"provider": "acl", "q": "James", "field": "author"}).json()
    assert result["items"][0]["authors"] == ["James Hammerton"]
    assert result["items"][0]["venue"] == "ACL"


def test_acl_cache_cleanup_keeps_active_previous_and_unrelated_files(client):
    import os
    service = client.app.state.discovery_service
    first = index(client)
    stale = service.acl.root / (rid() + ".sqlite3")
    stale.write_bytes(b"old cache")
    os.utime(stale, (1, 1))
    unrelated = service.acl.root / "personal.sqlite3"
    unrelated.write_bytes(b"not a generated index")
    second = index(client, revision="next-version")
    assert not stale.exists() and unrelated.exists()
    assert (service.acl.root / (first["generation"] + ".sqlite3")).exists()
    assert service.acl.state()["generation"] == second["generation"]


def test_acl_sync_is_idempotent_and_import_uses_official_pdf(client):
    wire(client)
    request = rid()
    first = client.post("/api/v1/discovery/providers/acl/sync", json={"request_id": request})
    assert first.json()["id"] == client.post("/api/v1/discovery/providers/acl/sync", json={"request_id": request}).json()["id"]
    index(client)
    saved = candidate(client, "acl", "2022.acl-long.220")
    task = enqueue(client, saved)
    perform(client)
    assert client.get("/api/v1/paper-imports/" + task["id"]).json()["status"] == "succeeded"


@pytest.mark.parametrize("extension,content", [("ris", "TY  - JOUR\nTI  - Reading paper\nAU  - Alice\nDO  - 10.1109/sample\nER  - \n"), ("bib", "@article{sample,title={Reading paper},author={Alice and Bob},doi={10.1109/sample}}")])
def test_citation_preview_does_not_download_and_requires_manual_pdf(client, extension, content):
    calls = wire(client)
    response = client.post("/api/v1/discovery/citation-previews", files={"file": ("sample." + extension, content.encode())})
    assert response.status_code == 200, response.text
    record = response.json()[0]
    assert record["provider"] == "citation" and record["pdf_url"] is None and not calls
    saved = candidate(client, "citation", record["source_id"], record=record)
    assert client.post("/api/v1/paper-imports", json={"candidate_id": saved["id"], "request_id": rid()}).status_code == 409


def test_cross_user_candidates_tasks_and_sync_are_private(client):
    wire(client)
    item = candidate(client)
    task = enqueue(client, item)
    with client.app.state.session_factory() as db:
        db.add(Workspace(id=2, name="其他空间", quota_bytes=1000000))
        db.flush()
        db.add(User(id=2, workspace_id=2, username="other-reader", password_hash=PASSWORDS.hash("other-password-2026")))
        db.commit()
    client.delete("/api/v1/session")
    assert client.post("/api/v1/session", json={"username": "other-reader", "password": "other-password-2026"}).status_code == 200
    assert client.get("/api/v1/discovery/candidates").json() == []
    assert client.get("/api/v1/paper-imports/" + task["id"]).status_code == 404
    assert client.delete("/api/v1/discovery/candidates/" + item["id"]).status_code == 404
    assert client.post("/api/v1/discovery/providers/acl/sync", json={"request_id": rid()}).status_code == 403
    client.delete("/api/v1/session")
    assert client.get("/api/v1/discovery/providers").status_code == 401
