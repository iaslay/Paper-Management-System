"""新增模型配置、持久任务、调用用量、卡片版本和推荐决策。"""
from alembic import op
import sqlalchemy as sa

revision = "0004_ai_cards"
down_revision = "0003_reading_records"
branch_labels = depends_on = None


def identity():
    return sa.Column("id", sa.String(32), primary_key=True)


def workspace():
    return sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id"), nullable=False)


def paper():
    return sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)


def user():
    return sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False)


def stamp(name, nullable=False):
    return sa.Column(name, sa.BigInteger(), nullable=nullable)


def upgrade():
    op.create_table("model_configurations", identity(), workspace(),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("settings_json", sa.JSON(), nullable=False),
        sa.Column("encrypted_key", sa.Text(), nullable=False), sa.Column("tested_mode", sa.String(10), nullable=True),
        stamp("tested_at", True), sa.Column("test_error", sa.Text(), nullable=True), stamp("created_at"),
        sa.UniqueConstraint("workspace_id", "revision", name="uq_model_config_revision"))
    op.create_table("generation_tasks", identity(), workspace(), user(), paper(),
        sa.Column("config_id", sa.String(32), sa.ForeignKey("model_configurations.id"), nullable=False),
        sa.Column("request_id", sa.String(32), nullable=False), sa.Column("request_json", sa.JSON(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False), sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False), sa.Column("stage", sa.String(30), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False), sa.Column("run_generation", sa.Integer(), nullable=False),
        sa.Column("run_token", sa.String(32), nullable=True), stamp("lease_until", True), stamp("next_run_at"),
        stamp("started_at", True), stamp("finished_at", True), sa.Column("error_code", sa.String(40), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True), sa.Column("result_version_id", sa.String(32), nullable=True),
        sa.Column("chunks", sa.JSON(), nullable=False), stamp("reserved_tokens"), stamp("charged_tokens"),
        sa.Column("usage_unknown", sa.Boolean(), nullable=False), sa.Column("budget_month", sa.String(7), nullable=False),
        stamp("created_at"), stamp("updated_at"),
        sa.UniqueConstraint("workspace_id", "user_id", "request_id", name="uq_card_task_request"),
        sa.UniqueConstraint("workspace_id", "fingerprint", name="uq_card_task_fingerprint"))
    op.create_index("ix_card_task_queue", "generation_tasks", ["status", "next_run_at"])
    op.create_table("model_calls", identity(), workspace(),
        sa.Column("task_id", sa.String(32), sa.ForeignKey("generation_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("config_id", sa.String(32), sa.ForeignKey("model_configurations.id"), nullable=False),
        sa.Column("budget_month", sa.String(7), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("stage", sa.String(30), nullable=False),
        sa.Column("status", sa.String(20), nullable=False), stamp("estimated_tokens"), stamp("input_tokens", True), stamp("output_tokens", True),
        sa.Column("provider_request_id", sa.String(200), nullable=True), sa.Column("error_code", sa.String(40), nullable=True),
        sa.Column("pages", sa.JSON(), nullable=False), stamp("created_at"), stamp("finished_at", True),
        sa.UniqueConstraint("task_id", "sequence", name="uq_model_call_sequence"))
    op.create_table("card_versions", identity(), workspace(), user(), paper(),
        sa.Column("file_hash", sa.String(64), nullable=False), sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("data", sa.JSON(), nullable=False), sa.Column("source", sa.String(12), nullable=False),
        sa.Column("config_id", sa.String(32), sa.ForeignKey("model_configurations.id"), nullable=True),
        sa.Column("base_version_id", sa.String(32), nullable=True), sa.Column("warnings", sa.JSON(), nullable=False), sa.Column("model_info", sa.JSON(), nullable=True),
        stamp("confirmed_at", True), stamp("created_at"), sa.UniqueConstraint("paper_id", "sequence", name="uq_card_version_sequence"))
    op.create_table("paper_cards", sa.Column("paper_id", sa.String(32), sa.ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True), workspace(),
        sa.Column("current_version_id", sa.String(32), sa.ForeignKey("card_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False), stamp("updated_at"))
    op.create_table("direction_decisions", identity(), workspace(), paper(), sa.Column("candidate_key", sa.String(100), nullable=False),
        sa.Column("status", sa.String(10), nullable=False), sa.Column("tag_id", sa.Integer(), sa.ForeignKey("tags.id", ondelete="SET NULL"), nullable=True),
        stamp("created_at"), sa.UniqueConstraint("paper_id", "candidate_key", name="uq_direction_decision"))


def downgrade():
    for table in ["direction_decisions", "paper_cards", "card_versions", "model_calls", "generation_tasks", "model_configurations"]:
        op.drop_table(table)
