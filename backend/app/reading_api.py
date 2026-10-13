"""阅读接口复用应用的会话、数据库与写入锁。"""

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from . import reading_service as svc
from .models import ReadingPosition, Annotation, Note, PageSource, now
from .schemas import PositionWrite, NoteCreate, NoteEdit, AnnotationCreate, AnnotationEdit, ReadingDelete, NoteType


def build_reading_router(database, require_user, write_lock, settings):
    router = APIRouter(prefix="/api/v1")

    @router.post("/papers/{paper_id}/reader-open")
    def reader_open(paper_id: str, user=Depends(require_user), db=Depends(database)):
        paper = svc.paper_for(db, user, paper_id)
        file_hash = paper.file_hash
        path = settings.data_dir / "files" / (file_hash + ".pdf")
        available = path.is_file()
        sources = svc.sources_for(db, paper)
        prepared = []
        if available and paper.deleted_at is None and len(sources) != paper.page_count:
            # 文件读取在锁外执行，提交前重新检查父论文状态。
            prepared = svc.inspect_sources(path)
        with write_lock:
            db.expire_all()
            paper = svc.paper_for(db, user, paper_id)
            svc.check_file(paper, file_hash)
            available = path.is_file()
            position = db.get(ReadingPosition, (user.id, paper.id))
            if available and paper.deleted_at is None:
                svc.insert_sources(db, paper, prepared)
                if position is None:
                    position = ReadingPosition(user_id=user.id, workspace_id=user.workspace_id, paper_id=paper.id, file_hash=file_hash)
                    db.add(position)
                position.last_opened_at = now()
                db.commit()
            sources = svc.sources_for(db, paper)
            return {"paper_id": paper.id, "file_hash": file_hash, "page_count": paper.page_count, "file_available": available,
                    "read_only": paper.deleted_at is not None, "page_map_status": "ready" if len(sources) == paper.page_count else "partial" if sources else "unavailable",
                    "position": svc.view(position), "page_sources": [svc.view(source) for source in sources]}

    @router.get("/papers/{paper_id}/position")
    def position(paper_id: str, user=Depends(require_user), db=Depends(database)):
        svc.paper_for(db, user, paper_id)
        return svc.view(db.get(ReadingPosition, (user.id, paper_id)))

    @router.put("/papers/{paper_id}/position")
    def save_position(paper_id: str, payload: PositionWrite, user=Depends(require_user), db=Depends(database)):
        def apply(paper, _):
            svc.check_file(paper, payload.file_hash)
            svc.check_page(paper, payload.page_number)
            record = db.get(ReadingPosition, (user.id, paper.id))
            if record is None:
                svc.fail("请先打开阅读器再保存位置。", "record_not_found", 404)
            values = payload.model_dump(exclude={"revision", "request_id", "file_hash"})
            return svc.view(svc.cas_update(db, user, record, payload.revision, values)), paper.id
        with write_lock:
            result, code = svc.mutation(db, user, "PUT/position/" + paper_id, payload, apply, "position", paper_id=paper_id)
            return JSONResponse(result, status_code=code)

    @router.get("/papers/{paper_id}/notes")
    def notes(paper_id: str, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100), note_type: NoteType | None = None,
              page_number: int | None = Query(None, ge=1), user=Depends(require_user), db=Depends(database)):
        paper = svc.paper_for(db, user, paper_id)
        return svc.list_records(db, user, paper, Note, page, page_size, note_type=note_type, page_number=page_number)

    @router.get("/notes/{note_id}")
    def note(note_id: str, user=Depends(require_user), db=Depends(database)):
        return svc.view(svc.own_record(db, user, Note, note_id))

    @router.post("/papers/{paper_id}/notes")
    def create_note(paper_id: str, payload: NoteCreate, user=Depends(require_user), db=Depends(database)):
        def apply(paper, _):
            svc.check_file(paper, payload.file_hash)
            record = svc.add_note(db, user, paper, payload.note_type, payload.content, payload.page_number, payload.annotation_id, payload.insight_kind)
            return svc.view(record), record.id
        with write_lock:
            result, code = svc.mutation(db, user, "POST/notes/" + paper_id, payload, apply, "note", paper_id=paper_id, status=201)
            return JSONResponse(result, status_code=code)

    @router.patch("/notes/{note_id}")
    def edit_note(note_id: str, payload: NoteEdit, user=Depends(require_user), db=Depends(database)):
        def apply(paper, record):
            values = payload.model_dump(exclude_unset=True, exclude={"revision", "request_id"})
            linked = svc.note_values(db, user, paper, record.note_type, values.get("page_number", record.page_number), record.annotation_id, values.get("insight_kind", record.insight_kind))
            values.update(linked)
            return svc.view(svc.cas_update(db, user, record, payload.revision, values)), record.id
        with write_lock:
            result, code = svc.mutation(db, user, "PATCH/note/" + note_id, payload, apply, "note", model=Note, record_id=note_id)
            return JSONResponse(result, status_code=code)

    @router.delete("/notes/{note_id}")
    def delete_note(note_id: str, payload: ReadingDelete, user=Depends(require_user), db=Depends(database)):
        def apply(_, record):
            svc.cas_delete(db, user, record, payload.revision)
            return {"ok": True}, record.id
        with write_lock:
            result, code = svc.mutation(db, user, "DELETE/note/" + note_id, payload, apply, "note", model=Note, record_id=note_id)
            return JSONResponse(result, status_code=code)

    @router.get("/papers/{paper_id}/annotations")
    def annotations(paper_id: str, page_number: int = Query(..., ge=1), page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=200),
                    user=Depends(require_user), db=Depends(database)):
        paper = svc.paper_for(db, user, paper_id)
        svc.check_page(paper, page_number)
        return svc.list_records(db, user, paper, Annotation, page, page_size, page_number=page_number)

    @router.get("/annotations/{annotation_id}")
    def annotation(annotation_id: str, user=Depends(require_user), db=Depends(database)):
        record = svc.own_record(db, user, Annotation, annotation_id)
        comment = db.scalar(select(Note).where(Note.annotation_id == record.id, Note.user_id == user.id))
        return {"annotation": svc.view(record), "note": svc.view(comment)}

    @router.post("/papers/{paper_id}/annotations")
    def create_annotation(paper_id: str, payload: AnnotationCreate, user=Depends(require_user), db=Depends(database)):
        def apply(paper, _):
            svc.check_file(paper, payload.file_hash)
            svc.check_page(paper, payload.page_number)
            svc.limit(db, user, paper, Annotation, 1000)
            source = db.get(PageSource, payload.page_source_id)
            if source is None or source.workspace_id != user.workspace_id or source.paper_id != paper.id or source.file_hash != paper.file_hash or source.page_number != payload.page_number:
                svc.fail("高亮需要同篇原文的可信页面来源，请重新准备页面。", "invalid_rects")
            box, rects = source.view_box, []
            for x0, y0, x1, y1 in payload.rects:
                if x0 >= x1 or y0 >= y1 or x0 < box[0] - .5 or y0 < box[1] - .5 or x1 > box[2] + .5 or y1 > box[3] + .5:
                    svc.fail("高亮坐标超出页面范围，请重新选择文字。", "invalid_rects")
                rects.append([max(box[0], x0), max(box[1], y0), min(box[2], x1), min(box[3], y1)])
                if rects[-1][0] >= rects[-1][2] or rects[-1][1] >= rects[-1][3]:
                    svc.fail("高亮区域为空，请重新选择文字。", "invalid_rects")
            record = Annotation(workspace_id=user.workspace_id, user_id=user.id, paper_id=paper.id, page_source_id=source.id, file_hash=paper.file_hash,
                                page_number=payload.page_number, quote=payload.quote, rects=rects, color=payload.color)
            db.add(record)
            db.flush()
            comment = svc.add_note(db, user, paper, "annotation_comment", payload.comment, annotation_id=record.id) if payload.comment else None
            return {"annotation": svc.view(record), "note": svc.view(comment)}, record.id
        with write_lock:
            result, code = svc.mutation(db, user, "POST/annotations/" + paper_id, payload, apply, "annotation", paper_id=paper_id, status=201)
            return JSONResponse(result, status_code=code)

    @router.patch("/annotations/{annotation_id}")
    def edit_annotation(annotation_id: str, payload: AnnotationEdit, user=Depends(require_user), db=Depends(database)):
        def apply(_, record):
            return svc.view(svc.cas_update(db, user, record, payload.revision, {"color": payload.color})), record.id
        with write_lock:
            result, code = svc.mutation(db, user, "PATCH/annotation/" + annotation_id, payload, apply, "annotation", model=Annotation, record_id=annotation_id)
            return JSONResponse(result, status_code=code)

    @router.delete("/annotations/{annotation_id}")
    def delete_annotation(annotation_id: str, payload: ReadingDelete, user=Depends(require_user), db=Depends(database)):
        def apply(_, record):
            svc.cas_delete(db, user, record, payload.revision)
            return {"ok": True}, record.id
        with write_lock:
            result, code = svc.mutation(db, user, "DELETE/annotation/" + annotation_id, payload, apply, "annotation", model=Annotation, record_id=annotation_id)
            return JSONResponse(result, status_code=code)

    return router
