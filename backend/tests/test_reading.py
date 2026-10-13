"""验证阅读记录、请求回执、并发保存及删除后的关联一致性。"""

import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import pytest
from sqlalchemy import select, func, delete
from pypdf import PdfWriter
from pypdf.generic import RectangleObject
from app.models import PageSource, ReadingPosition, Note, Annotation, ReadingMutationReceipt, Paper, User, Workspace, now
from app import reading_service
from test_management import client, signed, upload, pdf, CREDENTIALS, HEADERS


def request_id():
    return uuid.uuid4().hex


def opened(client, title="阅读测试"):
    paper = upload(client, title)
    response = client.post(f"/api/v1/papers/{paper['id']}/reader-open")
    assert response.status_code == 200, response.text
    return paper, response.json()


def note_input(paper, **changes):
    return {"request_id": request_id(), "file_hash": paper["file_hash"], "note_type": "page_note", "page_number": 1, "content": "需要继续核对实验条件。", **changes}


def position_input(paper, **changes):
    return {"request_id": request_id(), "file_hash": paper["file_hash"], "revision": 1, "page_number": 2, "zoom_mode": "custom", "zoom": 1.25, "view_rotation": 90, **changes}


def annotation_input(paper, session, **changes):
    return {"request_id": request_id(), "file_hash": paper["file_hash"], "page_source_id": session["page_sources"][0]["id"], "page_number": 1,
            "quote": "选取的原文", "rects": [[30, 30, 100, 50], [30, 55, 160, 70]], "color": "green", **changes}


def create_note(client, paper, **changes):
    response = client.post(f"/api/v1/papers/{paper['id']}/notes", json=note_input(paper, **changes))
    assert response.status_code == 201, response.text
    return response.json()


def test_position_is_independent_and_restored(signed):
    paper, session = opened(signed)
    assert session["page_map_status"] == "ready" and len(session["page_sources"]) == 2
    assert session["position"]["revision"] == 1
    saved = signed.put(f"/api/v1/papers/{paper['id']}/position", json=position_input(paper))
    assert saved.status_code == 200 and saved.json()["revision"] == 2
    assert signed.get(f"/api/v1/papers/{paper['id']}").json()["revision"] == paper["revision"]
    reopened = signed.post(f"/api/v1/papers/{paper['id']}/reader-open").json()["position"]
    assert reopened["page_number"] == 2 and reopened["zoom"] == 1.25 and reopened["view_rotation"] == 90 and reopened["revision"] == 2
    result = signed.get("/api/v1/papers?sort=recent_read").json()["items"][0]
    assert result["last_read_page"] == 2 and result["last_opened_at"] is not None


@pytest.mark.parametrize("changes", [{"page_number": 3}, {"page_number": 0}, {"page_number": True}, {"zoom": .1}, {"zoom": 4}, {"view_rotation": 45}, {"zoom_mode": "fit_width", "zoom": 1.25}, {"zoom": None}, {"file_hash": "f" * 64}])
def test_invalid_position_keeps_original(signed, changes):
    paper, _ = opened(signed)
    response = signed.put(f"/api/v1/papers/{paper['id']}/position", json=position_input(paper, **changes))
    assert response.status_code in (422, 409)
    assert signed.get(f"/api/v1/papers/{paper['id']}/position").json()["revision"] == 1


def test_position_and_note_conflicts_return_current(signed):
    paper, _ = opened(signed)
    path = f"/api/v1/papers/{paper['id']}/position"
    assert signed.put(path, json=position_input(paper)).status_code == 200
    conflict = signed.put(path, json=position_input(paper, page_number=1))
    assert conflict.status_code == 409 and conflict.json()["current"]["page_number"] == 2
    note = create_note(signed, paper)
    path = f"/api/v1/notes/{note['id']}"
    assert signed.patch(path, json={"request_id": request_id(), "revision": 1, "content": "服务器新内容"}).status_code == 200
    conflict = signed.patch(path, json={"request_id": request_id(), "revision": 1, "content": "另一标签页草稿"})
    assert conflict.status_code == 409 and conflict.json()["current"]["content"] == "服务器新内容"


def test_receipts_replay_create_update_and_delete(signed):
    paper, _ = opened(signed)
    payload = note_input(paper)
    path = f"/api/v1/papers/{paper['id']}/notes"
    first, retry = signed.post(path, json=payload), signed.post(path, json=payload)
    assert first.status_code == retry.status_code == 201 and first.json() == retry.json()
    assert signed.get(path).json()["total"] == 1
    assert signed.post(path, json={**payload, "content": "不能复用请求标识"}).json()["code"] == "request_id_reused"
    note = first.json()
    path = f"/api/v1/notes/{note['id']}"
    change = {"request_id": request_id(), "revision": 1, "content": "更新内容"}
    assert signed.patch(path, json=change).json() == signed.patch(path, json=change).json()
    removal = {"request_id": request_id(), "revision": 2}
    assert signed.request("DELETE", path, json=removal).status_code == 200
    assert signed.request("DELETE", path, json=removal).status_code == 200
    assert signed.get(path).status_code == 404
    # 服务端已删除的原记录不能被迟到的编辑重新创建。
    assert signed.patch(path, json={"request_id": request_id(), "revision": 2, "content": "已删除"}).status_code == 404


def test_concurrent_same_request_creates_once(signed):
    paper, _ = opened(signed)
    payload = note_input(paper)
    path = f"/api/v1/papers/{paper['id']}/notes"
    with ThreadPoolExecutor(max_workers=3) as pool:
        responses = list(pool.map(lambda _: signed.post(path, json=payload), range(3)))
    assert {response.status_code for response in responses} == {201}
    assert len({response.json()["id"] for response in responses}) == 1
    assert signed.get(path).json()["total"] == 1


def test_concurrent_revision_writes_have_one_winner(signed):
    paper, _ = opened(signed)
    note = create_note(signed, paper)
    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = list(pool.map(lambda number: signed.patch(f"/api/v1/notes/{note['id']}", json={"request_id": request_id(), "revision": 1, "content": f"并发版本{number}"}).status_code, range(2)))
    assert sorted(codes) == [200, 409]


def test_annotation_comment_transaction_and_delete(signed):
    paper, session = opened(signed)
    payload = annotation_input(paper, session, comment="我的高亮评论")
    path = f"/api/v1/papers/{paper['id']}/annotations"
    first = signed.post(path, json=payload)
    assert first.status_code == 201, first.text
    result = first.json()
    assert signed.post(path, json=payload).json() == result
    assert result["note"]["page_number"] == 1 and result["note"]["annotation_id"] == result["annotation"]["id"]
    assert signed.get(path + "?page_number=1").json()["total"] == 1
    assert signed.get(f"/api/v1/annotations/{result['annotation']['id']}").json()["note"]["content"] == "我的高亮评论"
    deleted = signed.request("DELETE", f"/api/v1/annotations/{result['annotation']['id']}", json={"request_id": request_id(), "revision": 1})
    assert deleted.status_code == 200
    assert signed.get(f"/api/v1/notes/{result['note']['id']}").status_code == 404


def test_annotation_comment_failure_rolls_back(signed):
    paper, session = opened(signed)
    with patch.object(reading_service, "add_note", side_effect=reading_service.ReadingError("模拟写入失败", "test_failure")):
        response = signed.post(f"/api/v1/papers/{paper['id']}/annotations", json=annotation_input(paper, session, comment="同事务评论"))
    assert response.status_code == 422
    assert signed.get(f"/api/v1/papers/{paper['id']}/annotations?page_number=1").json()["total"] == 0


@pytest.mark.parametrize("rects", [[[1, 1, 0, 2]], [[-2, 20, 30, 40]], [[20, 20, 900, 30]], [], [[1, 2, 3]]])
def test_invalid_rectangles(signed, rects):
    paper, session = opened(signed)
    response = signed.post(f"/api/v1/papers/{paper['id']}/annotations", json=annotation_input(paper, session, rects=rects))
    assert response.status_code == 422


def test_nonzero_page_and_rotation_are_preserved(signed):
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    page.cropbox = RectangleObject([20, 30, 550, 760])
    page.rotate(90)
    output = io.BytesIO(); writer.write(output)
    paper = upload(signed, "旋转边界", content=output.getvalue())
    session = signed.post(f"/api/v1/papers/{paper['id']}/reader-open").json()
    source = session["page_sources"][0]
    assert source["view_box"] == [20, 30, 550, 760] and source["intrinsic_rotation"] == 90
    payload = annotation_input(paper, session, rects=[[20, 30, 100, 50]])
    response = signed.post(f"/api/v1/papers/{paper['id']}/annotations", json=payload)
    assert response.status_code == 201
    assert response.json()["annotation"]["rects"] == [[20, 30, 100, 50]]


@pytest.mark.parametrize("changes", [{"content": "  "}, {"content": "字" * 10001}, {"page_number": 3}, {"note_type": "personal_insight"}, {"annotation_id": "a" * 32}, {"insight_kind": "question"}])
def test_note_validation(signed, changes):
    paper, _ = opened(signed)
    assert signed.post(f"/api/v1/papers/{paper['id']}/notes", json=note_input(paper, **changes)).status_code in (422, 404)


def test_insights_plain_text_and_pagination(signed):
    paper, _ = opened(signed)
    for category in ["understanding", "question", "application"]:
        note = create_note(signed, paper, note_type="personal_insight", page_number=None, insight_kind=category, content="<script>我的文字</script>😀")
        assert note["page_number"] is None and note["insight_kind"] == category
    path = f"/api/v1/papers/{paper['id']}/notes"
    page1, page2 = signed.get(path + "?page_size=1"), signed.get(path + "?page_size=1&page=2")
    assert page1.json()["total"] == 3 and page1.json()["items"][0]["id"] != page2.json()["items"][0]["id"]
    assert "<script>" in page1.json()["items"][0]["content"]


def test_limits_do_not_truncate_or_leave_annotation(signed):
    paper, session = opened(signed)
    with signed.app.state.session_factory() as db:
        for number in range(500):
            db.add(Note(workspace_id=1, user_id=1, paper_id=paper["id"], file_hash=paper["file_hash"], note_type="page_note", page_number=1, content=f"笔记{number}"))
        db.commit()
    assert signed.post(f"/api/v1/papers/{paper['id']}/notes", json=note_input(paper)).json()["code"] == "record_limit_reached"
    assert signed.post(f"/api/v1/papers/{paper['id']}/annotations", json=annotation_input(paper, session, comment="满额评论")).status_code == 422
    assert signed.get(f"/api/v1/papers/{paper['id']}/annotations?page_number=1").json()["total"] == 0


def test_trash_restore_and_cascading_cleanup(signed):
    paper, session = opened(signed)
    note = create_note(signed, paper)
    annotation = signed.post(f"/api/v1/papers/{paper['id']}/annotations", json=annotation_input(paper, session)).json()["annotation"]
    assert signed.delete(f"/api/v1/papers/{paper['id']}?revision=1").status_code == 200
    assert signed.post(f"/api/v1/papers/{paper['id']}/reader-open").json()["read_only"] is True
    assert signed.get(f"/api/v1/notes/{note['id']}").status_code == 200
    assert signed.patch(f"/api/v1/notes/{note['id']}", json={"request_id": request_id(), "revision": 1, "content": "迟到的修改"}).json()["code"] == "paper_trashed"
    assert signed.post(f"/api/v1/papers/{paper['id']}/restore?revision=2").status_code == 200
    assert signed.get(f"/api/v1/annotations/{annotation['id']}").status_code == 200
    signed.delete(f"/api/v1/papers/{paper['id']}?revision=3")
    signed.delete(f"/api/v1/papers/{paper['id']}/permanent?revision=4")
    with signed.app.state.session_factory() as db:
        for model in [PageSource, ReadingPosition, Annotation, Note, ReadingMutationReceipt]:
            assert db.scalar(select(func.count()).select_from(model)) == 0
    assert not (signed.app.state.settings.data_dir / "files" / (paper["file_hash"] + ".pdf")).exists()


def test_missing_file_and_page_preparation_failure_keep_notes(signed):
    paper, _ = opened(signed)
    note = create_note(signed, paper)
    with signed.app.state.session_factory() as db:
        db.execute(delete(PageSource)); db.commit()
    with patch.object(reading_service, "inspect_sources", return_value=[]):
        session = signed.post(f"/api/v1/papers/{paper['id']}/reader-open").json()
        assert session["page_map_status"] == "unavailable" and session["file_available"]
    (signed.app.state.settings.data_dir / "files" / (paper["file_hash"] + ".pdf")).unlink()
    assert signed.post(f"/api/v1/papers/{paper['id']}/reader-open").json()["file_available"] is False
    assert signed.get(f"/api/v1/notes/{note['id']}").json()["content"] == note["content"]


def test_other_users_notes_are_private_and_shared_hash_file_survives(signed):
    paper, _ = opened(signed)
    with signed.app.state.session_factory() as db:
        db.add(Workspace(id=2, name="其他空间", quota_bytes=100000)); db.flush()
        db.add(User(id=2, workspace_id=2, username="other", password_hash="unused")); db.flush()
        other = Paper(workspace_id=2, title="另一空间同文件", authors=[], original_filename="other.pdf", file_hash=paper["file_hash"], file_size=paper["file_size"], page_count=2)
        db.add(other); db.flush()
        private = Note(workspace_id=1, user_id=2, paper_id=paper["id"], file_hash=paper["file_hash"], note_type="page_note", content="另一个作者的笔记", page_number=1)
        db.add(private); db.commit(); other_id, note_id = other.id, private.id
    assert signed.get(f"/api/v1/notes/{note_id}").status_code == 404
    assert signed.post(f"/api/v1/papers/{other_id}/reader-open").status_code == 404
    assert signed.get(f"/api/v1/papers/{paper['id']}/notes").json()["total"] == 0
    signed.delete(f"/api/v1/papers/{paper['id']}?revision=1")
    assert signed.delete(f"/api/v1/papers/{paper['id']}/permanent?revision=2").status_code == 200
    assert (signed.app.state.settings.data_dir / "files" / (paper["file_hash"] + ".pdf")).exists()


def test_expired_trash_and_receipts_are_cleaned(signed):
    paper, _ = opened(signed)
    create_note(signed, paper)
    with signed.app.state.session_factory() as db:
        db.get(Paper, paper["id"]).deleted_at = now() - 31 * 86400
        db.commit()
    signed.app.state.cleanup()
    assert signed.get(f"/api/v1/papers/{paper['id']}").status_code == 404
    with signed.app.state.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Note)) == 0


def test_recent_read_filters_and_pagination(signed):
    unopened = upload(signed, "从未阅读")
    first, _ = opened(signed, "阅读第一篇")
    second, _ = opened(signed, "阅读第二篇")
    with signed.app.state.session_factory() as db:
        db.get(ReadingPosition, (1, first["id"])).last_opened_at = 100
        db.get(ReadingPosition, (1, second["id"])).last_opened_at = 200
        db.commit()
    result = signed.get("/api/v1/papers?sort=recent_read").json()
    assert [item["id"] for item in result["items"]] == [second["id"], first["id"], unopened["id"]]
    assert signed.get("/api/v1/papers?sort=recent_read&page_size=1&page=3").json()["items"][0]["last_read_page"] is None


def test_old_database_upgrade_preserves_files_and_records(tmp_path):
    from pathlib import Path
    import hashlib
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from sqlalchemy import inspect
    from app.config import Settings
    from app.main import create_app, PASSWORDS
    app = create_app(Settings(data_dir=tmp_path))
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "migrations"))
    with app.state.engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0002_author_search")
    assert "notes" not in inspect(app.state.engine).get_table_names()
    content = pdf("旧库原文")
    file_hash = hashlib.sha256(content).hexdigest()
    file_path = tmp_path / "files" / (file_hash + ".pdf")
    file_path.write_bytes(content)
    with app.state.session_factory() as db:
        db.add(Workspace(id=1, name="旧库", quota_bytes=100000)); db.flush()
        db.add(User(id=1, workspace_id=1, username=CREDENTIALS["username"], password_hash=PASSWORDS.hash(CREDENTIALS["password"]))); db.flush()
        old = Paper(workspace_id=1, title="保留人工修改的旧标题", authors=["旧作者"], authors_search="旧作者", original_filename="旧论文.pdf", file_hash=file_hash, file_size=len(content), page_count=2, reading_status="read")
        db.add(old); db.commit(); paper_id = old.id
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as http:
        assert http.post("/api/v1/session", json=CREDENTIALS).status_code == 200
        paper = http.get(f"/api/v1/papers/{paper_id}").json()
        assert paper["title"] == "保留人工修改的旧标题" and paper["reading_status"] == "read" and paper["file_hash"] == file_hash
        assert paper["last_read_page"] is None
        assert http.post(f"/api/v1/papers/{paper_id}/reader-open").json()["page_map_status"] == "ready"
        assert file_path.read_bytes() == content
        create_note(http, paper)
    with TestClient(app, base_url="http://localhost", headers=HEADERS) as http:
        assert http.post("/api/v1/session", json=CREDENTIALS).status_code == 200
        assert http.get(f"/api/v1/papers/{paper_id}/notes").json()["total"] == 1
        assert http.get(f"/api/v1/papers/{paper_id}/position").json()["revision"] == 1


def test_nonfinite_json_is_rejected(signed):
    import json
    paper, _ = opened(signed)
    payload = position_input(paper)
    body = json.dumps(payload).replace('1.25', 'NaN')
    assert signed.put(f"/api/v1/papers/{paper['id']}/position", content=body, headers={"Content-Type": "application/json"}).status_code == 422


def test_invalid_unicode_is_rejected_before_storage(signed):
    import json
    paper, _ = opened(signed)
    payload = note_input(paper, content="\ud800")
    response = signed.post(f"/api/v1/papers/{paper['id']}/notes", content=json.dumps(payload, ensure_ascii=True), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert signed.get(f"/api/v1/papers/{paper['id']}/notes").json()["total"] == 0


def test_delete_conflict_returns_current_without_deleting(signed):
    paper, _ = opened(signed)
    note = create_note(signed, paper)
    path = f"/api/v1/notes/{note['id']}"
    signed.patch(path, json={"revision": 1, "request_id": request_id(), "content": "服务器的第二版"})
    response = signed.request("DELETE", path, json={"revision": 1, "request_id": request_id()})
    assert response.status_code == 409 and response.json()["current"]["content"] == "服务器的第二版"
    assert signed.get(path).status_code == 200
