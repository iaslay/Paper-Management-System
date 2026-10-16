"""本地上传与联网导入共用的隔离检查、容量和事务入库。"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from sqlalchemy import select, func
from .models import Paper, Workspace
from . import services as svc
from . import reading_service as reading


def inspect_file(path):
    try:
        result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("pdf_inspect.py")), str(path)],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        if result.returncode:
            svc.fail("PDF 检查失败，请检查文件后重试。")
        info = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, ValueError):
        svc.fail("PDF 检查超时或返回异常，请尝试较小的文件。")
    if "error" in info:
        svc.fail(info["error"])
    return info


def ingest_file(db, settings, lock, user, temporary, filename, directions, metadata=None, finish=None):
    size = temporary.stat().st_size
    if not size:
        svc.fail("文件为空，请重新选择 PDF。")
    if size > settings.max_file_bytes:
        svc.fail("文件超过 50 MiB，请压缩后重新上传。", 413)
    with temporary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    info = inspect_file(temporary)
    if info["page_count"] > settings.max_pages:
        svc.fail("论文超过 300 页，请拆分后重新上传。")
    with lock:
        db.expire_all()
        workspace = db.scalar(select(Workspace).where(Workspace.id == user.workspace_id).with_for_update())
        svc.validate_labels(db, user.workspace_id, directions, "research_direction")
        paper = db.scalar(select(Paper).where(Paper.workspace_id == user.workspace_id, Paper.file_hash == digest))
        if paper and paper.deleted_at is not None:
            svc.fail("这份文件位于回收站，请先恢复已有论文。", 409)
        duplicate = paper is not None
        moved = False
        target = settings.data_dir / "files" / (digest + ".pdf")
        try:
            if not duplicate:
                used = db.scalar(select(func.coalesce(func.sum(Paper.file_size), 0)).where(Paper.workspace_id == user.workspace_id))
                if used + size > workspace.quota_bytes:
                    svc.fail("个人空间容量不足，请先整理回收站或调整容量。", 413)
                source = metadata or {}
                authors = source.get("authors") or info["authors"]
                paper = Paper(workspace_id=user.workspace_id, title=source.get("title") or info["title"] or filename[:-4],
                              authors=authors, authors_search="\n".join(authors), year=source.get("year"), doi=source.get("doi"),
                              original_filename=filename[:255], file_hash=digest, file_size=size, page_count=info["page_count"])
                db.add(paper)
                db.flush()
                reading.insert_sources(db, paper, info.get("page_sources", []))
                svc.set_labels(db, paper, direction_ids=directions)
            # 在登记前检查取消及来源关联，确保任务状态与论文在同一事务中保存。
            if finish:
                finish(db, paper)
            if not duplicate and not target.exists():
                os.replace(temporary, target)
                moved = True
            db.commit()
            return paper, duplicate
        except BaseException:
            db.rollback()
            if moved and not db.scalar(select(Paper.id).where(Paper.file_hash == digest).limit(1)):
                target.unlink(missing_ok=True)
            raise
