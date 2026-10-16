"""增加独立检索词生成任务，不绑定或改写论文。"""
from alembic import op
import sqlalchemy as sa

revision = "0008_query_assists"
down_revision = "0007_discovery"
branch_labels = depends_on = None


def upgrade():
    op.create_table("search_query_tasks",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_id", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("text", sa.String(2000), nullable=False),
        sa.Column("reference_date", sa.String(10), nullable=False),
        sa.Column("config_id", sa.String(32), sa.ForeignKey("model_configurations.id"), nullable=False),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("model_calls.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error_code", sa.String(40), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("finished_at", sa.BigInteger(), nullable=True),
        sa.UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_search_query_request"))
    op.create_index("ix_search_query_tasks_status", "search_query_tasks", ["status"])


def downgrade():
    op.drop_table("search_query_tasks")
