"""验证真实 PDF、权限、分类事务与检索语义，不依赖外部模型。"""

import io
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from sqlalchemy import select
from app.config import Settings
from app.main import create_app
from app.models import User, Workspace, Paper, Tag

HEADERS = {"X-Paperboard-Request": "1"}
CREDENTIALS = {"username": "reader", "password": "test-reading-2026"}


def pdf(title="测试论文", pages=2, encrypted=False):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    writer.add_metadata({"/Title": title, "/Author": "测试作者"})
    if encrypted:
        writer.encrypt("private-test-password")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as http:
        yield http


@pytest.fixture
def signed(client):
    assert client.post("/api/v1/setup", json=CREDENTIALS).status_code == 200
    return client


def label(client, name, aliases=None, kind="research_direction"):
    result = client.post("/api/v1/tags", json={"name": name, "aliases": aliases or [], "kind": kind})
    assert result.status_code == 201, result.text
    return result.json()


def upload(client, title="测试论文", directions=None, content=None):
    import json
    result = client.post("/api/v1/papers", files={"file": (title + ".pdf", content or pdf(title), "application/pdf")}, data={"direction_ids": json.dumps(directions or [])})
    assert result.status_code in (200, 201), result.text
    return result.json()["paper"]


def test_setup_login_logout_and_private_access(client):
    assert client.get("/api/v1/status").json() == {"initialized": False, "user": None}
    assert client.get("/api/v1/papers").status_code == 401
    response = client.post("/api/v1/setup", json={**CREDENTIALS, "workspace_name": "测试空间"})
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "password" not in response.text
    with client.app.state.session_factory() as db:
        assert db.get(User, 1).password_hash.startswith("$argon2")
    assert client.post("/api/v1/setup", json=CREDENTIALS).status_code == 409
    paper = upload(client)
    assert client.delete("/api/v1/session").status_code == 200
    assert client.get(f"/api/v1/papers/{paper['id']}/file").status_code == 401
    assert client.post("/api/v1/session", json=CREDENTIALS).status_code == 200
    assert client.get(f"/api/v1/papers/{paper['id']}/file").status_code == 200


def test_cross_origin_and_missing_request_header_are_rejected(client):
    assert client.post("/api/v1/setup", json=CREDENTIALS, headers={"Origin": "https://foreign.example"}).status_code == 403
    client.headers.clear()
    assert client.post("/api/v1/setup", json=CREDENTIALS).status_code == 403


@pytest.mark.parametrize("username", ["   ", "  ab  "])
def test_trimmed_username_must_still_have_three_characters(client, username):
    response = client.post("/api/v1/setup", json={**CREDENTIALS, "username": username})
    assert response.status_code == 422
    assert client.get("/api/v1/status").json()["initialized"] is False


def test_login_rate_limit(signed):
    signed.delete("/api/v1/session")
    for _ in range(5):
        assert signed.post("/api/v1/session", json={**CREDENTIALS, "password": "wrong-password-2026"}).status_code == 401
    assert signed.post("/api/v1/session", json=CREDENTIALS).status_code == 429


def test_valid_pdf_metadata_dedup_and_range(signed):
    data = pdf("中文元信息")
    paper = upload(signed, "文件名称", content=data)
    assert paper["title"] == "中文元信息"
    assert paper["authors"] == ["测试作者"]
    assert paper["page_count"] == 2 and paper["year"] is None
    again = signed.post("/api/v1/papers", files={"file": ("不同名称.pdf", data, "application/pdf")})
    assert again.status_code == 200 and again.json()["duplicate"]
    assert signed.get("/api/v1/papers").json()["total"] == 1
    response = signed.get(f"/api/v1/papers/{paper['id']}/file", headers={"Range": "bytes=0-31"})
    assert response.status_code == 206 and len(response.content) == 32
    assert response.content == data[:32]


@pytest.mark.parametrize("name,content", [("错误.pdf", b"not a pdf"), ("伪装.pdf", b"%PDF-1.7\nbroken"), ("空.pdf", b""), ("扩展名.txt", pdf()), ("加密.pdf", pdf(encrypted=True))])
def test_invalid_uploads_leave_no_papers_or_temporary_files(signed, name, content):
    response = signed.post("/api/v1/papers", files={"file": (name, content, "application/pdf")})
    assert response.status_code == 422
    assert signed.get("/api/v1/papers").json()["total"] == 0
    assert not list((signed.app.state.settings.data_dir / "tmp").iterdir())


def test_upload_size_page_and_space_limits(signed):
    settings = signed.app.state.settings
    settings.max_file_bytes = 600
    assert signed.post("/api/v1/papers", files={"file": ("大文件.pdf", b"x" * 601)}).status_code == 413
    settings.max_file_bytes = 50 * 1024 ** 2
    settings.max_pages = 1
    assert signed.post("/api/v1/papers", files={"file": ("两页.pdf", pdf())}).status_code == 422
    settings.max_pages = 300
    with signed.app.state.session_factory() as db:
        db.get(Workspace, 1).quota_bytes = 10
        db.commit()
    assert signed.post("/api/v1/papers", files={"file": ("容量.pdf", pdf())}).status_code == 413


def test_concurrent_duplicate_upload_has_one_record(signed):
    data = pdf("并发查重")
    def send(_):
        return signed.post("/api/v1/papers", files={"file": ("并发查重.pdf", data)}).status_code
    with ThreadPoolExecutor(max_workers=3) as executor:
        codes = list(executor.map(send, range(3)))
    assert codes.count(201) == 1 and codes.count(200) == 2
    result = signed.get("/api/v1/papers").json()
    assert result["total"] == 1 and result["stats"]["used_bytes"] == len(data)


def test_alias_normalization_conflicts_and_type_validation(signed):
    tag = label(signed, "检索增强生成", ["RAG"])
    assert signed.post("/api/v1/tags", json={"name": " ｒａｇ ", "kind": "research_direction"}).status_code == 409
    assert signed.post("/api/v1/tags", json={"name": "   ", "kind": "research_direction"}).status_code == 422
    assert signed.post("/api/v1/tags", json={"name": "RAG", "aliases": ["rag"]}).status_code == 422
    general = label(signed, "待复现", kind="general")
    invalid = signed.post("/api/v1/papers", files={"file": ("错误分类.pdf", pdf())}, data={"direction_ids": f"[{general['id']}]"})
    assert invalid.status_code == 422
    assert tag["aliases"] == ["RAG"]


def test_any_all_unclassified_alias_and_pagination(signed):
    rag = label(signed, "检索增强生成", ["RAG"])
    agent = label(signed, "智能体")
    both = upload(signed, "两个方向", [rag["id"], agent["id"]])
    upload(signed, "一个方向", [rag["id"]])
    upload(signed, "没有方向")
    query = [("research_direction_ids", rag["id"]), ("research_direction_ids", agent["id"])]
    assert signed.get("/api/v1/papers", params=query).json()["total"] == 2
    all_result = signed.get("/api/v1/papers", params=[*query, ("direction_match", "all")]).json()
    assert all_result["total"] == 1 and all_result["items"][0]["id"] == both["id"]
    assert signed.get("/api/v1/papers?q=rag").json()["total"] == 2
    assert signed.get("/api/v1/papers?unclassified_only=true").json()["total"] == 1
    assert signed.get("/api/v1/papers", params=[*query, ("unclassified_only", "true")]).status_code == 422
    first = signed.get("/api/v1/papers?page_size=1&page=1").json()
    second = signed.get("/api/v1/papers?page_size=1&page=2").json()
    assert first["total"] == second["total"] == 3
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert first["direction_counts"][str(rag["id"])] == 2


def test_revision_and_status_conditions(signed):
    paper = upload(signed)
    changed = signed.patch(f"/api/v1/papers/{paper['id']}", json={"revision": paper["revision"], "reading_status": "read", "is_favorite": True}).json()
    assert changed["completed_at"] is not None and changed["revision"] == 2
    assert signed.patch(f"/api/v1/papers/{paper['id']}", json={"revision": 1, "title": "过期覆盖"}).status_code == 409
    assert signed.get("/api/v1/papers?status=read&favorite=true").json()["total"] == 1
    updated = signed.patch(f"/api/v1/papers/{paper['id']}", json={"revision": 2, "reading_status": "reading"}).json()
    assert updated["completed_at"] is None
    assert signed.get("/api/v1/papers?status=read").json()["total"] == 0


def test_chinese_author_search_and_updates(signed):
    paper = upload(signed, "作者检索样本")
    assert signed.get("/api/v1/papers?q=测试作者").json()["total"] == 1
    assert signed.patch(f"/api/v1/papers/{paper['id']}", json={"revision": paper["revision"], "authors": ["张三", "Jane Researcher"]}).status_code == 200
    assert signed.get("/api/v1/papers?q=张三").json()["total"] == 1
    assert signed.get("/api/v1/papers?q=jane").json()["total"] == 1
    assert signed.get("/api/v1/papers?q=测试作者").json()["total"] == 0


def test_merge_preserves_papers_aliases_and_deduplicates(signed):
    source = label(signed, "检索生成", ["Retrieval"])
    target = label(signed, "检索增强生成", ["RAG"])
    upload(signed, "分类合并", [source["id"], target["id"]])
    payload = {"target_id": target["id"], "revision": source["revision"], "target_revision": target["revision"]}
    preview = signed.post(f"/api/v1/tags/{source['id']}/merge-preview", json=payload)
    assert preview.json()["affected_count"] == 1
    merged = signed.post(f"/api/v1/tags/{source['id']}/merge", json=payload)
    assert merged.status_code == 200
    assert set(merged.json()["aliases"]) == {"RAG", "Retrieval", "检索生成"}
    paper = signed.get("/api/v1/papers").json()["items"][0]
    assert paper["research_directions"] == [{"id": target["id"], "name": target["name"]}]
    assert signed.get("/api/v1/papers?q=Retrieval").json()["total"] == 1
    assert signed.get("/api/v1/tags?archived=true").json()[0]["merged_into_id"] == target["id"]


def test_archive_restore_tag_and_paper(signed):
    tag = label(signed, "视觉理解")
    paper = upload(signed, "回收与分类", [tag["id"]])
    assert signed.delete(f"/api/v1/tags/{tag['id']}?revision=1").status_code == 200
    current = signed.get(f"/api/v1/papers/{paper['id']}").json()
    assert current["research_directions"] == []
    assert signed.post("/api/v1/tags", json={"name": "视觉理解"}).status_code == 409
    assert signed.post(f"/api/v1/tags/{tag['id']}/restore?revision=2").status_code == 200
    assert signed.delete(f"/api/v1/papers/{paper['id']}?revision={current['revision']}").status_code == 200
    assert signed.get("/api/v1/papers").json()["total"] == 0
    trash = signed.get("/api/v1/papers?trash=true").json()["items"][0]
    assert signed.post("/api/v1/papers", files={"file": ("回收与分类.pdf", pdf("回收与分类"))}).status_code == 409
    restored = signed.post(f"/api/v1/papers/{paper['id']}/restore?revision={trash['revision']}").json()
    assert restored["deleted_at"] is None
    assert signed.delete(f"/api/v1/papers/{paper['id']}/permanent?revision={restored['revision']}").status_code == 422


def test_batch_reports_partial_failure_and_limit(signed):
    labels = [label(signed, f"方向{i}") for i in range(11)]
    full = upload(signed, "已经十个方向", [tag["id"] for tag in labels[:10]])
    empty = upload(signed, "批量分类")
    result = signed.post("/api/v1/papers/research-direction-batches", json={"paper_ids": [full["id"], empty["id"], "does-not-exist"], "direction_ids": [labels[-1]["id"]], "operation": "add"}).json()["results"]
    assert [row["ok"] for row in result] == [False, True, False]
    assert len(signed.get(f"/api/v1/papers/{full['id']}").json()["research_directions"]) == 10
    assert signed.get(f"/api/v1/papers/{empty['id']}").json()["research_directions"][0]["id"] == labels[-1]["id"]


def test_foreign_workspace_data_cannot_be_accessed(signed):
    with signed.app.state.session_factory() as db:
        db.add(Workspace(id=2, name="其他空间", quota_bytes=10000)); db.flush()
        other = Paper(workspace_id=2, title="其他人的论文", authors=[], original_filename="private.pdf", file_hash="f" * 64, file_size=200, page_count=2)
        tag = Tag(workspace_id=2, kind="research_direction", name="私有方向")
        db.add_all([other, tag]); db.commit(); paper_id, tag_id = other.id, tag.id
    assert signed.get(f"/api/v1/papers/{paper_id}/file").status_code == 404
    assert signed.get(f"/api/v1/papers/{paper_id}").status_code == 404
    assert signed.get(f"/api/v1/papers?research_direction_ids={tag_id}").status_code == 422
    assert signed.get("/api/v1/papers").json()["total"] == 0
    assert signed.get("/api/v1/tags").json() == []


def test_static_directory_traversal_is_rejected(signed):
    response = signed.get("/%2e%2e/%2e%2e/backend/requirements.txt")
    assert response.status_code == 404
