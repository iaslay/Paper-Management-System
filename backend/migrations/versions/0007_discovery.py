"""增加检索配置、候选与持久导入，不修改已有论文和个人记录。"""
from alembic import op
import sqlalchemy as sa

revision = "0007_discovery"
down_revision = "0006_discussions"
branch_labels = depends_on = None


def scope():
    return [sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False)]


def upgrade():
    op.create_table("institution_access_profiles",
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), primary_key=True),
        sa.Column("mode", sa.String(20), nullable=False))
    op.create_table("discovery_configurations",
        sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), primary_key=True),
        sa.Column("key_cipher", sa.String(), nullable=False), sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("test_status", sa.String(20), nullable=False), sa.Column("tested_at", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.String(), nullable=False), sa.Column("calls_day", sa.String(10), nullable=False),
        sa.Column("calls_count", sa.Integer(), nullable=False), sa.Column("daily_limit", sa.Integer(), nullable=False))
    op.create_table("literature_candidates", sa.Column("id", sa.String(32), primary_key=True), *scope(),
        sa.Column("provider", sa.String(20), nullable=False), sa.Column("source_id", sa.String(200), nullable=False),
        sa.Column("record", sa.JSON(), nullable=False), sa.Column("direction_ids", sa.JSON(), nullable=False),
        sa.Column("saved", sa.Boolean(), nullable=False), sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("workspace_id", "user_id", "provider", "source_id", name="uq_literature_candidate"))
    op.create_table("paper_external_identifiers", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False), sa.Column("source_id", sa.String(200), nullable=False),
        sa.Column("record", sa.JSON(), nullable=False), sa.UniqueConstraint("paper_id", "provider", "source_id", name="uq_paper_external_identifier"))
    op.create_index("ix_paper_external_identifiers_paper_id", "paper_external_identifiers", ["paper_id"])
    op.create_index("ix_paper_external_identifiers_source_id", "paper_external_identifiers", ["source_id"])
    op.create_table("paper_import_tasks", sa.Column("id", sa.String(32), primary_key=True), *scope(),
        sa.Column("candidate_id", sa.String(32), sa.ForeignKey("literature_candidates.id"), nullable=False),
        sa.Column("request_id", sa.String(32), nullable=False), sa.Column("status", sa.String(20), nullable=False),
        sa.Column("phase", sa.String(30), nullable=False), sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("retry_of", sa.String(32), nullable=True), sa.Column("downloaded_bytes", sa.BigInteger(), nullable=False),
        sa.Column("record", sa.JSON(), nullable=False), sa.Column("direction_ids", sa.JSON(), nullable=False),
        sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("error", sa.String(), nullable=False), sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("finished_at", sa.BigInteger(), nullable=True), sa.UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_paper_import_request"))
    op.create_index("ix_paper_import_tasks_status", "paper_import_tasks", ["status"])
    op.create_table("literature_source_sync_tasks", sa.Column("id", sa.String(32), primary_key=True), *scope(),
        sa.Column("request_id", sa.String(32), nullable=False, unique=True), sa.Column("status", sa.String(20), nullable=False),
        sa.Column("phase", sa.String(), nullable=False), sa.Column("processed", sa.Integer(), nullable=False),
        sa.Column("source_revision", sa.String(), nullable=False), sa.Column("error", sa.String(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False), sa.Column("finished_at", sa.BigInteger(), nullable=True))
    op.create_index("ix_literature_source_sync_tasks_status", "literature_source_sync_tasks", ["status"])


def downgrade():
    for name in ["literature_source_sync_tasks", "paper_import_tasks", "paper_external_identifiers", "literature_candidates", "discovery_configurations", "institution_access_profiles"]:
        op.drop_table(name)
