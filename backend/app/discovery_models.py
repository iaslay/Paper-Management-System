"""检索来源配置、私人候选与独立持久导入任务。"""
import uuid
from sqlalchemy import ForeignKey, String, JSON, BigInteger, Integer, Boolean, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, now


class DiscoveryConfiguration(Base):
    __tablename__ = "discovery_configurations"
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    key_cipher: Mapped[str] = mapped_column(default="")
    revision: Mapped[int] = mapped_column(default=1)
    test_status: Mapped[str] = mapped_column(String(20), default="untested")
    tested_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error: Mapped[str] = mapped_column(default="")
    calls_day: Mapped[str] = mapped_column(String(10), default="")
    calls_count: Mapped[int] = mapped_column(default=0)
    daily_limit: Mapped[int] = mapped_column(default=200)


class InstitutionAccessProfile(Base):
    __tablename__ = "institution_access_profiles"
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    mode: Mapped[str] = mapped_column(String(20), default="webvpn")


class LiteratureCandidate(Base):
    __tablename__ = "literature_candidates"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", "provider", "source_id", name="uq_literature_candidate"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    provider: Mapped[str] = mapped_column(String(20))
    source_id: Mapped[str] = mapped_column(String(200))
    record: Mapped[dict] = mapped_column(JSON)
    direction_ids: Mapped[list] = mapped_column(JSON, default=list)
    saved: Mapped[bool] = mapped_column(Boolean, default=True)
    paper_id: Mapped[str | None] = mapped_column(ForeignKey("papers.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)


class PaperExternalIdentifier(Base):
    __tablename__ = "paper_external_identifiers"
    __table_args__ = (UniqueConstraint("paper_id", "provider", "source_id", name="uq_paper_external_identifier"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    source_id: Mapped[str] = mapped_column(String(200), index=True)
    record: Mapped[dict] = mapped_column(JSON)


class PaperImportTask(Base):
    __tablename__ = "paper_import_tasks"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_paper_import_request"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    candidate_id: Mapped[str] = mapped_column(ForeignKey("literature_candidates.id"))
    request_id: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    phase: Mapped[str] = mapped_column(String(30), default="queued")
    attempt: Mapped[int] = mapped_column(default=0)
    retry_of: Mapped[str | None] = mapped_column(String(32), nullable=True)
    downloaded_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    record: Mapped[dict] = mapped_column(JSON)
    direction_ids: Mapped[list] = mapped_column(JSON)
    paper_id: Mapped[str | None] = mapped_column(ForeignKey("papers.id", ondelete="SET NULL"), nullable=True)
    error: Mapped[str] = mapped_column(default="")
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class LiteratureSourceSyncTask(Base):
    __tablename__ = "literature_source_sync_tasks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    request_id: Mapped[str] = mapped_column(String(32), unique=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspaces.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    phase: Mapped[str] = mapped_column(default="queued")
    processed: Mapped[int] = mapped_column(default=0)
    source_revision: Mapped[str] = mapped_column(default="")
    error: Mapped[str] = mapped_column(default="")
    created_at: Mapped[int] = mapped_column(BigInteger, default=now)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
