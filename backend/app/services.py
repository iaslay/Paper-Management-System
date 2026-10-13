"""论文、分类和检索的事务规则。"""

import unicodedata
from sqlalchemy import select, delete, func, or_
from fastapi import HTTPException
from .models import Paper, PaperTag, Tag, TagName, ReadingPosition, PaperCard, CardVersion, GenerationTask, now

KINDS = {"research_direction", "general", "topic"}


def fail(message, status=422):
    raise HTTPException(status, detail=message)


def normalize(value):
    return unicodedata.normalize("NFKC", value).strip().casefold()


def get_paper(db, workspace, paper_id, include_deleted=False):
    paper = db.scalar(select(Paper).where(Paper.id == paper_id, Paper.workspace_id == workspace))
    if paper is None or (paper.deleted_at is not None and not include_deleted):
        fail("论文不存在或已移入回收站。", 404)
    return paper


def get_tag(db, workspace, tag_id, archived=False):
    tag = db.scalar(select(Tag).where(Tag.id == tag_id, Tag.workspace_id == workspace))
    if tag is None or (tag.deleted_at is not None and not archived):
        fail("分类不存在或已归档，请刷新后重试。", 404)
    return tag


def check_revision(record, revision):
    if record.revision != revision:
        fail("其他页面已更新这条记录。请刷新并比较后重新保存。", 409)


def label_names(db, tag):
    return db.scalars(select(TagName).where(TagName.tag_id == tag.id).order_by(TagName.id)).all()


def tag_view(db, tag, count=None):
    if count is None:
        count = db.scalar(select(func.count(PaperTag.paper_id)).join(Paper, Paper.id == PaperTag.paper_id).where(PaperTag.tag_id == tag.id, Paper.deleted_at.is_(None)))
    return {
        "id": tag.id, "name": tag.name, "kind": tag.kind,
        "aliases": [item.name for item in label_names(db, tag) if not item.is_primary],
        "revision": tag.revision, "paper_count": count,
        "deleted_at": tag.deleted_at, "merged_into_id": tag.merged_into_id,
    }


def paper_view(db, paper, user_id=None, position=None):
    if user_id is not None and position is None:
        position = db.get(ReadingPosition, (user_id, paper.id))
    tags = db.scalars(select(Tag).join(PaperTag, PaperTag.tag_id == Tag.id).where(PaperTag.paper_id == paper.id, Tag.deleted_at.is_(None)).order_by(Tag.name)).all()
    card = db.get(PaperCard, paper.id)
    version = db.get(CardVersion, card.current_version_id) if card and card.current_version_id else None
    preview = version.data.get("preview") if version else None
    if version and not preview:
        task = db.scalar(select(GenerationTask).where(GenerationTask.paper_id == paper.id, GenerationTask.status == "succeeded", GenerationTask.input_snapshot["purpose"].as_string() == "preview", GenerationTask.input_snapshot["source_version"].as_string() == version.id).order_by(GenerationTask.queue_order.desc()).limit(1))
        if task:
            preview = next((chunk.get("preview") for chunk in task.chunks if chunk.get("complete")), None)
    brief = None
    if version:
        brief = {"problem": version.data["research_question"]["text"], "approach": version.data["method"]["text"], "benefit": version.data["findings"][0]["text"] if version.data["findings"] else "当前卡片未说明主要结果。"}
    return {
        "id": paper.id, "title": paper.title, "authors": paper.authors,
        "year": paper.year, "doi": paper.doi, "original_filename": paper.original_filename,
        "file_size": paper.file_size, "page_count": paper.page_count,
        "file_hash": paper.file_hash, "last_read_page": position.page_number if position else None,
        "last_opened_at": position.last_opened_at if position else None,
        "reading_status": paper.reading_status, "is_favorite": paper.is_favorite,
        "revision": paper.revision, "created_at": paper.created_at,
        "updated_at": paper.updated_at, "completed_at": paper.completed_at,
        "deleted_at": paper.deleted_at, "preparation_status": "ready",
        "card_summary": version.data["summary"]["text"] if version else None,
        "card_status": ("confirmed" if version.confirmed_at else "draft") if version else None,
        "card_preview": {"version_id": version.id, **preview} if version and preview else None,
        "card_brief": brief,
        "research_directions": [{"id": t.id, "name": t.name} for t in tags if t.kind == "research_direction"],
        "tags": [{"id": t.id, "name": t.name} for t in tags if t.kind == "general"],
        "topics": [{"id": t.id, "name": t.name} for t in tags if t.kind == "topic"],
    }


def validate_labels(db, workspace, ids, kind):
    ids = set(ids)
    if not ids:
        return ids
    valid = set(db.scalars(select(Tag.id).where(Tag.workspace_id == workspace, Tag.kind == kind, Tag.deleted_at.is_(None), Tag.id.in_(ids))).all())
    if valid != ids:
        fail("所选分类不存在、已归档或类型不匹配，请重新选择。")
    return ids


def set_labels(db, paper, direction_ids=None, general_ids=None, topic_ids=None):
    existing = db.execute(select(Tag.kind, Tag.id).join(PaperTag, PaperTag.tag_id == Tag.id).where(PaperTag.paper_id == paper.id, Tag.deleted_at.is_(None))).all()
    groups = {kind: {tag_id for tag_kind, tag_id in existing if tag_kind == kind} for kind in KINDS}
    changes = {"research_direction": direction_ids, "general": general_ids, "topic": topic_ids}
    for kind, supplied in changes.items():
        if supplied is not None:
            groups[kind] = validate_labels(db, paper.workspace_id, supplied, kind)
    if len(groups["research_direction"]) > 10 or len(groups["research_direction"]) + len(groups["general"]) > 20 or len(groups["topic"]) > 10:
        fail("每篇最多 10 个研究方向、10 个主题，研究方向与普通标签合计最多 20 个。")
    for kind, supplied in changes.items():
        if supplied is not None:
            kind_ids = select(Tag.id).where(Tag.workspace_id == paper.workspace_id, Tag.kind == kind)
            db.execute(delete(PaperTag).where(PaperTag.paper_id == paper.id, PaperTag.tag_id.in_(kind_ids)))
            for tag_id in groups[kind]:
                db.add(PaperTag(paper_id=paper.id, tag_id=tag_id))


def save_tag(db, workspace, payload, tag=None):
    limit = 50 if payload.kind == "topic" else 30
    names = [payload.name.strip(), *[value.strip() for value in payload.aliases]]
    if not names[0] or len(names[0]) > limit or any(not name or len(name) > 30 for name in names[1:]):
        fail(f"名称和别名需要为 1～{limit} 个字符。")
    normalized = [normalize(name) for name in names]
    if len(set(normalized)) != len(normalized):
        fail("名称与别名重复，请保留一种写法。")
    if tag and tag.kind != payload.kind:
        fail("不能改变已有分类的类型，请新建对应分类。")
    conflicts = select(TagName).where(TagName.workspace_id == workspace, TagName.kind == payload.kind, TagName.normalized_name.in_(normalized))
    if tag:
        conflicts = conflicts.where(TagName.tag_id != tag.id)
    conflict = db.scalar(conflicts)
    if conflict:
        owner = db.get(Tag, conflict.tag_id)
        fail("名称或别名已存在，请选择已有分类。" if owner.deleted_at is None else "该名称曾用于已归档分类，请在归档列表恢复或使用其他名称。", 409)
    if tag is None:
        tag = Tag(workspace_id=workspace, kind=payload.kind, name=names[0])
        db.add(tag)
        db.flush()
    else:
        check_revision(tag, payload.revision)
        tag.name = names[0]
        tag.revision += 1
        db.execute(delete(TagName).where(TagName.tag_id == tag.id))
        db.flush()
    for i, (name, normalized_name) in enumerate(zip(names, normalized)):
        db.add(TagName(tag_id=tag.id, workspace_id=workspace, kind=tag.kind, name=name, normalized_name=normalized_name, is_primary=i == 0))
    db.flush()
    return tag


def touch_associated_papers(db, tag_id):
    for paper in db.scalars(select(Paper).join(PaperTag, PaperTag.paper_id == Paper.id).where(PaperTag.tag_id == tag_id)).all():
        paper.revision += 1
        paper.updated_at = now()


def merge_preview(db, source, target):
    if source.id == target.id or source.kind != target.kind:
        fail("请选择另一个同类型分类作为合并目标。")
    aliases = {normalize(item.name) for item in [*label_names(db, source), *label_names(db, target)] if normalize(item.name) != normalize(target.name)}
    if len(aliases) > 10:
        fail("合并后别名超过 10 个，请先整理双方别名。")
    affected = db.scalar(select(func.count(func.distinct(PaperTag.paper_id))).where(PaperTag.tag_id == source.id))
    return {"source": tag_view(db, source), "target": tag_view(db, target), "affected_count": affected, "alias_count": len(aliases)}


def merge_tags(db, source, target):
    merge_preview(db, source, target)
    links = db.scalars(select(PaperTag).where(PaperTag.tag_id == source.id)).all()
    for link in links:
        paper = db.get(Paper, link.paper_id)
        if db.get(PaperTag, (link.paper_id, target.id)) is None:
            db.add(PaperTag(paper_id=link.paper_id, tag_id=target.id))
        paper.revision += 1
        paper.updated_at = now()
        db.delete(link)
    for item in label_names(db, source):
        item.tag_id = target.id
        item.is_primary = False
    source.deleted_at = now()
    source.merged_into_id = target.id
    source.revision += 1
    target.revision += 1


def list_papers(db, workspace, *, user_id=None, q="", status=None, direction_ids=None, match="any", unclassified=False, topic_id=None, tag_id=None, favorite=False, year=None, trash=False, sort="updated", page=1, page_size=20):
    direction_ids = validate_labels(db, workspace, direction_ids or [], "research_direction")
    if direction_ids and unclassified:
        fail("未分类与指定研究方向不能同时筛选。")
    conditions = [Paper.workspace_id == workspace, Paper.deleted_at.is_not(None) if trash else Paper.deleted_at.is_(None)]
    if status:
        conditions.append(Paper.reading_status == status)
    if year is not None:
        conditions.append(Paper.year == year)
    if favorite:
        conditions.append(Paper.is_favorite.is_(True))
    for chosen, kind in [(topic_id, "topic"), (tag_id, "general")]:
        if chosen is not None:
            validate_labels(db, workspace, [chosen], kind)
            conditions.append(Paper.id.in_(select(PaperTag.paper_id).where(PaperTag.tag_id == chosen)))
    if q.strip():
        needle = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        name_needle = "%" + normalize(q).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        matches = select(PaperTag.paper_id).join(TagName, TagName.tag_id == PaperTag.tag_id).join(Tag, Tag.id == TagName.tag_id).where(Tag.workspace_id == workspace, Tag.deleted_at.is_(None), TagName.normalized_name.like(name_needle, escape="\\"))
        conditions.append(or_(Paper.title.ilike(needle, escape="\\"), Paper.original_filename.ilike(needle, escape="\\"), Paper.authors_search.ilike(needle, escape="\\"), Paper.id.in_(matches)))
    base_ids = select(Paper.id).where(*conditions)
    facet_rows = db.execute(select(PaperTag.tag_id, func.count(func.distinct(PaperTag.paper_id))).join(Tag, Tag.id == PaperTag.tag_id).where(PaperTag.paper_id.in_(base_ids), Tag.kind == "research_direction", Tag.deleted_at.is_(None)).group_by(PaperTag.tag_id)).all()
    direction_links = select(PaperTag.paper_id).join(Tag, Tag.id == PaperTag.tag_id).where(Tag.kind == "research_direction", Tag.deleted_at.is_(None))
    if unclassified:
        conditions.append(Paper.id.not_in(direction_links))
    if direction_ids:
        selected = select(PaperTag.paper_id).where(PaperTag.tag_id.in_(direction_ids))
        if match == "all":
            selected = selected.group_by(PaperTag.paper_id).having(func.count(func.distinct(PaperTag.tag_id)) == len(direction_ids))
        conditions.append(Paper.id.in_(selected))
    total = db.scalar(select(func.count()).select_from(Paper).where(*conditions))
    sort_column = select(ReadingPosition.last_opened_at).where(ReadingPosition.paper_id == Paper.id, ReadingPosition.user_id == user_id, ReadingPosition.workspace_id == workspace).scalar_subquery() if sort == "recent_read" else {"updated": Paper.updated_at, "created": Paper.created_at, "year": Paper.year, "title": Paper.title}[sort]
    ordered = sort_column.asc() if sort == "title" else sort_column.desc().nulls_last()
    papers = db.scalars(select(Paper).where(*conditions).order_by(ordered, Paper.id).offset((page - 1) * page_size).limit(page_size)).all()
    stats = {"total": 0, "unread": 0, "reading": 0, "read": 0, "favorite": 0, "trash": 0, "used_bytes": 0}
    for reading_status, deleted_at, count, size in db.execute(select(Paper.reading_status, Paper.deleted_at, func.count(), func.sum(Paper.file_size)).where(Paper.workspace_id == workspace).group_by(Paper.reading_status, Paper.deleted_at)).all():
        stats["used_bytes"] += size or 0
        if deleted_at is not None:
            stats["trash"] += count
        else:
            stats["total"] += count
            stats[reading_status] += count
    stats["favorite"] = db.scalar(select(func.count()).select_from(Paper).where(Paper.workspace_id == workspace, Paper.deleted_at.is_(None), Paper.is_favorite.is_(True)))
    positions = {p.paper_id: p for p in db.scalars(select(ReadingPosition).where(ReadingPosition.user_id == user_id, ReadingPosition.paper_id.in_([p.id for p in papers]))).all()} if user_id else {}
    return {"items": [paper_view(db, paper, position=positions.get(paper.id)) for paper in papers], "total": total, "page": page, "page_size": page_size, "stats": stats, "direction_counts": dict(facet_rows)}
