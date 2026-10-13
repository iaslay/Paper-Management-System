"""新增按用户和论文隔离的讨论及持久消息，保留既有原文和卡片。"""
from alembic import op
import sqlalchemy as sa

revision = "0006_discussions"
down_revision = "0005_task_order"
branch_labels = depends_on = None


def upgrade():
    op.create_table("discussion_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("request_id", sa.String(32), nullable=False),
        sa.Column("title", sa.String(120), nullable=False), sa.Column("created_at", sa.BigInteger(), nullable=False), sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_discussion_request"))
    op.create_index("ix_discussion_paper", "discussion_sessions", ["paper_id", "user_id", "updated_at"])
    op.create_table("discussion_messages",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.String(32), sa.ForeignKey("discussion_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", sa.String(32), sa.ForeignKey("generation_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("role", sa.String(12), nullable=False),
        sa.Column("content", sa.Text(), nullable=False), sa.Column("status", sa.String(12), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False), sa.Column("context", sa.JSON(), nullable=False), sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("session_id", "sequence", name="uq_discussion_message_order"), sa.UniqueConstraint("task_id", "role", name="uq_discussion_task_role"))


def downgrade():
    op.drop_table("discussion_messages")
    op.drop_index("ix_discussion_paper", table_name="discussion_sessions")
    op.drop_table("discussion_sessions")
