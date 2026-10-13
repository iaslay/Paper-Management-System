"""新增阅读位置、可信页面、高亮、个人笔记和事务写入回执。"""

from alembic import op
import sqlalchemy as sa

revision = "0003_reading_records"
down_revision = "0002_author_search"
branch_labels = None
depends_on = None


def ownership():
    return [sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)]


def identity():
    return sa.Column("id", sa.String(32), primary_key=True)


def versioned():
    return [sa.Column("revision", sa.Integer(), nullable=False), sa.Column("created_at", sa.BigInteger(), nullable=False), sa.Column("updated_at", sa.BigInteger(), nullable=False)]


def upgrade():
    op.create_table("page_sources", identity(),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("view_box", sa.JSON(), nullable=False), sa.Column("intrinsic_rotation", sa.Integer(), nullable=False),
        sa.Column("user_unit", sa.Float(), nullable=False), sa.UniqueConstraint("paper_id", "page_number", name="uq_page_source"))
    op.create_table("reading_positions",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("zoom_mode", sa.String(20), nullable=False), sa.Column("zoom", sa.Float()),
        sa.Column("view_rotation", sa.Integer(), nullable=False), sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("last_opened_at", sa.BigInteger(), nullable=False), sa.Column("updated_at", sa.BigInteger(), nullable=False))
    op.create_index("ix_recent_read", "reading_positions", ["workspace_id", "user_id", "last_opened_at", "paper_id"])
    op.create_table("annotations", identity(), *ownership(),
        sa.Column("page_source_id", sa.String(32), sa.ForeignKey("page_sources.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False), sa.Column("rects", sa.JSON(), nullable=False),
        sa.Column("color", sa.String(10), nullable=False), *versioned())
    op.create_index("ix_annotations_page", "annotations", ["paper_id", "user_id", "page_number"])
    op.create_table("notes", identity(), *ownership(),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("note_type", sa.String(30), nullable=False),
        sa.Column("content", sa.Text(), nullable=False), sa.Column("page_number", sa.Integer()),
        sa.Column("annotation_id", sa.String(32), sa.ForeignKey("annotations.id", ondelete="CASCADE")),
        sa.Column("insight_kind", sa.String(20)), *versioned(), sa.UniqueConstraint("user_id", "annotation_id", name="uq_annotation_comment"))
    op.create_index("ix_notes_paper", "notes", ["paper_id", "user_id", "created_at", "id"])
    op.create_table("reading_mutation_receipts", identity(), *ownership(),
        sa.Column("request_id", sa.String(32), nullable=False), sa.Column("resource_kind", sa.String(30), nullable=False),
        sa.Column("resource_id", sa.String(32), nullable=False), sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False), sa.Column("response_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False), sa.UniqueConstraint("user_id", "request_id", name="uq_reading_request"))
    op.create_index("ix_reading_receipt_age", "reading_mutation_receipts", ["created_at"])


def downgrade():
    for name in ("reading_mutation_receipts", "notes", "annotations", "reading_positions", "page_sources"):
        op.drop_table(name)
