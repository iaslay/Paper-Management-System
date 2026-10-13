"""为同秒创建的任务增加稳定的队列顺序，保留原记录与调用关联。"""
from alembic import op
import sqlalchemy as sa

revision = "0005_task_order"
down_revision = "0004_ai_cards"
branch_labels = depends_on = None


def upgrade():
    op.add_column("generation_tasks", sa.Column("queue_order", sa.BigInteger(), nullable=False, server_default="0"))
    connection = op.get_bind()
    records = connection.execute(sa.text("SELECT id FROM generation_tasks ORDER BY created_at, id")).scalars().all()
    for sequence, record_id in enumerate(records, 1):
        connection.execute(sa.text("UPDATE generation_tasks SET queue_order=:sequence WHERE id=:record_id"), {"sequence": sequence, "record_id": record_id})
    op.create_index("uq_generation_queue_order", "generation_tasks", ["queue_order"], unique=True)


def downgrade():
    op.drop_index("uq_generation_queue_order", table_name="generation_tasks")
    op.drop_column("generation_tasks", "queue_order")
