"""阅读记录的权限、版本、可信坐标和幂等事务规则。"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from sqlalchemy import select, func, update, delete
from .models import Paper, PageSource, ReadingPosition, Annotation, Note, ReadingMutationReceipt, now


class ReadingError(Exception):
    def __init__(self, message, code, status=422, current=None):
        self.status = status
        self.body = {"detail": message, "code": code}
        if current is not None:
            self.body["current"] = current


def fail(message, code, status=422, current=None):
    raise ReadingError(message, code, status, current)


def paper_for(db, user, paper_id, writable=False):
    paper = db.scalar(select(Paper).where(Paper.id == paper_id, Paper.workspace_id == user.workspace_id))
    if paper is None:
        fail("论文不存在或无法访问。", "record_not_found", 404)
    if writable and paper.deleted_at is not None:
        fail("这篇论文在回收站中，恢复后可以继续编辑记录。", "paper_trashed", 409)
    return paper


def own_record(db, user, model, record_id):
    record = db.scalar(select(model).where(model.id == record_id, model.workspace_id == user.workspace_id, model.user_id == user.id))
    if record is None:
        fail("记录不存在或无法访问，未保存内容可以复制后另存。", "record_not_found", 404)
    paper_for(db, user, record.paper_id)
    return record


def view(record):
    if record is None:
        return None
    return {column.name: getattr(record, column.name) for column in record.__table__.columns if column.name not in {"user_id", "workspace_id"}}


def check_file(paper, file_hash):
    if paper.file_hash != file_hash:
        fail("原文版本不一致，请重新加载论文信息。", "file_version_mismatch", 409)


def check_page(paper, page):
    if page is None or not 1 <= page <= paper.page_count:
        fail(f"请输入 1～{paper.page_count} 范围内的页码。", "invalid_page")


def limit(db, user, paper, model, maximum):
    count = db.scalar(select(func.count()).select_from(model).where(model.paper_id == paper.id, model.user_id == user.id))
    if count >= maximum:
        fail(f"这篇论文的记录达到 {maximum} 条上限，请整理后再添加。", "record_limit_reached")


def note_values(db, user, paper, note_type, page, annotation_id, insight):
    if note_type == "personal_insight":
        if page is not None or annotation_id is not None or insight is None:
            fail("个人心得需要选择理解、疑问或用途，不绑定页码或高亮。", "invalid_content")
    elif note_type == "annotation_comment":
        if annotation_id is None or insight is not None:
            fail("高亮评论需要关联有效高亮。", "invalid_content")
        annotation = own_record(db, user, Annotation, annotation_id)
        if annotation.paper_id != paper.id or annotation.file_hash != paper.file_hash or (page is not None and page != annotation.page_number):
            fail("评论必须关联同篇原文的高亮。", "invalid_content")
        page = annotation.page_number
    else:
        check_page(paper, page)
        if annotation_id is not None or insight is not None:
            fail("页码笔记不能关联其他类型的记录。", "invalid_content")
    return {"page_number": page, "annotation_id": annotation_id, "insight_kind": insight}


def add_note(db, user, paper, note_type, content, page=None, annotation_id=None, insight=None):
    limit(db, user, paper, Note, 500)
    values = note_values(db, user, paper, note_type, page, annotation_id, insight)
    if annotation_id and db.scalar(select(Note.id).where(Note.user_id == user.id, Note.annotation_id == annotation_id)):
        fail("这处高亮已有评论，请编辑原评论。", "annotation_has_comment", 409)
    note = Note(workspace_id=user.workspace_id, user_id=user.id, paper_id=paper.id, file_hash=paper.file_hash, note_type=note_type, content=content, **values)
    db.add(note)
    db.flush()
    return note


def cas_update(db, user, record, revision, values):
    model = type(record)
    identity = [model.user_id == user.id, model.workspace_id == user.workspace_id, model.paper_id == record.paper_id]
    if model is not ReadingPosition:
        identity.append(model.id == record.id)
    changed = db.execute(update(model).where(*identity, model.revision == revision).values(**values, revision=revision + 1, updated_at=now()).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        current = db.scalar(select(model).where(*identity).execution_options(populate_existing=True))
        if current is None:
            fail("记录已被删除，未保存内容可以复制后另存。", "record_not_found", 404)
        fail("其他页面已更新这条记录。你的编辑已保留，请比较后再保存。", "revision_conflict", 409, view(current))
    db.refresh(record)
    return record


def cas_delete(db, user, record, revision):
    model = type(record)
    changed = db.execute(delete(model).where(model.id == record.id, model.user_id == user.id, model.workspace_id == user.workspace_id, model.revision == revision).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        current = db.scalar(select(model).where(model.id == record.id, model.user_id == user.id, model.workspace_id == user.workspace_id).execution_options(populate_existing=True))
        if current is None:
            fail("记录已被删除。", "record_not_found", 404)
        fail("其他页面已更新这条记录，请比较后再删除。", "revision_conflict", 409, view(current))


def mutation(db, user, path, payload, operation, kind, paper_id=None, model=None, record_id=None, status=200):
    """回执与业务数据同事务写入，删除后的重试也能读取原成功回执。"""
    values = payload.model_dump(exclude_unset=True)
    values.pop("request_id", None)
    fingerprint = hashlib.sha256(json.dumps([path, values], ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    receipt = db.scalar(select(ReadingMutationReceipt).where(ReadingMutationReceipt.user_id == user.id, ReadingMutationReceipt.request_id == payload.request_id))
    if receipt:
        if receipt.workspace_id != user.workspace_id or receipt.fingerprint != fingerprint:
            fail("请求标识已用于不同操作，请重新尝试。", "request_id_reused", 409)
        paper_for(db, user, receipt.paper_id, writable=True)
        return receipt.response_json, receipt.status_code
    record = own_record(db, user, model, record_id) if model else None
    paper = paper_for(db, user, paper_id or record.paper_id, writable=True)
    result, result_id = operation(paper, record)
    db.add(ReadingMutationReceipt(workspace_id=user.workspace_id, user_id=user.id, paper_id=paper.id, request_id=payload.request_id,
                                 resource_kind=kind, resource_id=result_id, fingerprint=fingerprint, status_code=status, response_json=result))
    db.commit()
    return result, status


def sources_for(db, paper):
    return db.scalars(select(PageSource).where(PageSource.paper_id == paper.id, PageSource.file_hash == paper.file_hash).order_by(PageSource.page_number)).all()


def insert_sources(db, paper, sources):
    existing = {item.page_number for item in sources_for(db, paper)}
    for source in sources:
        if 1 <= source["page_number"] <= paper.page_count and source["page_number"] not in existing:
            db.add(PageSource(paper_id=paper.id, workspace_id=paper.workspace_id, file_hash=paper.file_hash, **source))
            existing.add(source["page_number"])
    db.flush()


def inspect_sources(path):
    try:
        result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("pdf_inspect.py")), str(path)], capture_output=True, text=True, encoding="utf-8", timeout=20)
        return json.loads(result.stdout).get("page_sources", []) if result.returncode == 0 else []
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return []


def list_records(db, user, paper, model, page, page_size, **filters):
    conditions = [model.workspace_id == user.workspace_id, model.user_id == user.id, model.paper_id == paper.id]
    for name, value in filters.items():
        if value is not None:
            conditions.append(getattr(model, name) == value)
    total = db.scalar(select(func.count()).select_from(model).where(*conditions))
    items = db.scalars(select(model).where(*conditions).order_by(model.created_at, model.id).offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [view(item) for item in items], "total": total, "page": page, "page_size": page_size}


def remove_paper(db, paper):
    """新增记录由外键级联删除，物理文件只在最后一个引用消失后清理。"""
    file_hash = paper.file_hash
    db.delete(paper)
    db.flush()
    return file_hash


def remove_unreferenced_files(db, data_dir, hashes):
    for file_hash in set(hashes):
        if db.scalar(select(Paper.id).where(Paper.file_hash == file_hash).limit(1)) is None:
            (data_dir / "files" / (file_hash + ".pdf")).unlink(missing_ok=True)
