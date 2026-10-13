"""管理与阅读数据模型；个人记录始终绑定不可变原文。"""

import time
import uuid
from sqlalchemy import ForeignKey, String, Text, Integer, BigInteger, Boolean, JSON, Float, UniqueConstraint, Index
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> int:
    return int(time.time())


class Base(DeclarativeBase):
    pass


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    quota_bytes: Mapped[int] = mapped_column(BigInteger)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)


class SessionToken(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[int] = mapped_column(BigInteger, index=True)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(primary_key=True)
    address_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now, index=True)


class Paper(Base):
    __tablename__ = "papers"
    __table_args__ = (
        UniqueConstraint("workspace_id", "file_hash", name="uq_paper_hash"),
        Index("ix_paper_workspace_status", "workspace_id", "reading_status", "deleted_at"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    title: Mapped[str] = mapped_column(String(500))
    authors: Mapped[list] = mapped_column(JSON, default=list)
    authors_search: Mapped[str] = mapped_column(Text, default="")
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    doi: Mapped[str | None] = mapped_column(String(200), nullable=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    file_hash: Mapped[str] = mapped_column(String(64))
    file_size: Mapped[int] = mapped_column(BigInteger)
    page_count: Mapped[int] = mapped_column(Integer)
    reading_status: Mapped[str] = mapped_column(String(20), default="unread")
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)
    completed_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    name: Mapped[str] = mapped_column(String(50))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    merged_into_id: Mapped[int | None] = mapped_column(ForeignKey("tags.id"), nullable=True)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class TagName(Base):
    __tablename__ = "tag_names"
    __table_args__ = (
        UniqueConstraint("workspace_id", "kind", "normalized_name", name="uq_tag_name"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), index=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    kind: Mapped[str] = mapped_column(String(30))
    name: Mapped[str] = mapped_column(String(50))
    normalized_name: Mapped[str] = mapped_column(String(100))
    is_primary: Mapped[bool] = mapped_column(Boolean)


class PaperTag(Base):
    __tablename__ = "paper_tags"
    __table_args__ = (Index("ix_paper_tag_reverse", "tag_id", "paper_id"),)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), primary_key=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")


class PageSource(Base):
    __tablename__ = "page_sources"
    __table_args__ = (UniqueConstraint("paper_id", "page_number", name="uq_page_source"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    file_hash: Mapped[str] = mapped_column(String(64))
    page_number: Mapped[int] = mapped_column(Integer)
    view_box: Mapped[list] = mapped_column(JSON)
    intrinsic_rotation: Mapped[int] = mapped_column(Integer)
    user_unit: Mapped[float] = mapped_column(Float, default=1)


class ReadingPosition(Base):
    __tablename__ = "reading_positions"
    __table_args__ = (Index("ix_recent_read", "workspace_id", "user_id", "last_opened_at", "paper_id"),)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    file_hash: Mapped[str] = mapped_column(String(64))
    page_number: Mapped[int] = mapped_column(Integer, default=1)
    zoom_mode: Mapped[str] = mapped_column(String(20), default="fit_width")
    zoom: Mapped[float | None] = mapped_column(Float, nullable=True)
    view_rotation: Mapped[int] = mapped_column(Integer, default=0)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    last_opened_at: Mapped[int] = mapped_column(BigInteger, default=now)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (Index("ix_annotations_page", "paper_id", "user_id", "page_number"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    page_source_id: Mapped[str] = mapped_column(ForeignKey("page_sources.id", ondelete="CASCADE"))
    file_hash: Mapped[str] = mapped_column(String(64))
    page_number: Mapped[int] = mapped_column(Integer)
    quote: Mapped[str] = mapped_column(Text)
    rects: Mapped[list] = mapped_column(JSON)
    color: Mapped[str] = mapped_column(String(10), default="yellow")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (Index("ix_notes_paper", "paper_id", "user_id", "created_at", "id"), UniqueConstraint("user_id", "annotation_id", name="uq_annotation_comment"))
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    file_hash: Mapped[str] = mapped_column(String(64))
    note_type: Mapped[str] = mapped_column(String(30))
    content: Mapped[str] = mapped_column(Text)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    annotation_id: Mapped[str | None] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"), nullable=True)
    insight_kind: Mapped[str | None] = mapped_column(String(20), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)


class ReadingMutationReceipt(Base):
    __tablename__ = "reading_mutation_receipts"
    __table_args__ = (UniqueConstraint("user_id", "request_id", name="uq_reading_request"), Index("ix_reading_receipt_age", "created_at"))
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    request_id: Mapped[str] = mapped_column(String(32))
    resource_kind: Mapped[str] = mapped_column(String(30))
    resource_id: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int] = mapped_column(Integer)
    response_json: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)


class ModelConfiguration(Base):
    __tablename__ = "model_configurations"
    __table_args__ = (UniqueConstraint("workspace_id", "revision", name="uq_model_config_revision"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    revision: Mapped[int] = mapped_column(Integer)
    settings_json: Mapped[dict] = mapped_column(JSON)
    encrypted_key: Mapped[str] = mapped_column(Text, default="")
    tested_mode: Mapped[str | None] = mapped_column(String(10), nullable=True)
    tested_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    test_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)


class GenerationTask(Base):
    __tablename__ = "generation_tasks"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_card_task_request"), UniqueConstraint("workspace_id", "fingerprint", name="uq_card_task_fingerprint"), Index("ix_card_task_queue", "status", "next_run_at"), Index("uq_generation_queue_order", "queue_order", unique=True))
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    config_id: Mapped[str] = mapped_column(ForeignKey("model_configurations.id"))
    request_id: Mapped[str] = mapped_column(String(32))
    request_json: Mapped[dict] = mapped_column(JSON)
    fingerprint: Mapped[str] = mapped_column(String(64))
    queue_order: Mapped[int] = mapped_column(BigInteger, default=0)
    input_snapshot: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    stage: Mapped[str] = mapped_column(String(30), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    run_generation: Mapped[int] = mapped_column(Integer, default=0)
    run_token: Mapped[str | None] = mapped_column(String(32), nullable=True)
    lease_until: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    next_run_at: Mapped[int] = mapped_column(BigInteger, default=now)
    started_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_version_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    chunks: Mapped[list] = mapped_column(JSON, default=list)
    reserved_tokens: Mapped[int] = mapped_column(BigInteger)
    charged_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    usage_unknown: Mapped[bool] = mapped_column(Boolean, default=False)
    budget_month: Mapped[str] = mapped_column(String(7))
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)


class ModelCall(Base):
    __tablename__ = "model_calls"
    __table_args__ = (UniqueConstraint("task_id", "sequence", name="uq_model_call_sequence"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("generation_tasks.id", ondelete="SET NULL"), nullable=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    config_id: Mapped[str] = mapped_column(ForeignKey("model_configurations.id"))
    budget_month: Mapped[str] = mapped_column(String(7))
    sequence: Mapped[int] = mapped_column(Integer)
    stage: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20), default="started")
    estimated_tokens: Mapped[int] = mapped_column(BigInteger)
    input_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    pages: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class CardVersion(Base):
    __tablename__ = "card_versions"
    __table_args__ = (UniqueConstraint("paper_id", "sequence", name="uq_card_version_sequence"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    file_hash: Mapped[str] = mapped_column(String(64))
    sequence: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    data: Mapped[dict] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(String(12))
    config_id: Mapped[str | None] = mapped_column(ForeignKey("model_configurations.id"), nullable=True)
    base_version_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    model_info: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confirmed_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)


class PaperCard(Base):
    __tablename__ = "paper_cards"
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    current_version_id: Mapped[str | None] = mapped_column(ForeignKey("card_versions.id", ondelete="SET NULL"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now)


class DirectionDecision(Base):
    __tablename__ = "direction_decisions"
    __table_args__ = (UniqueConstraint("paper_id", "candidate_key", name="uq_direction_decision"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"))
    candidate_key: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(10))
    tag_id: Mapped[int | None] = mapped_column(ForeignKey("tags.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
