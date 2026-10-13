"""为作者添加可直接检索的 Unicode 文本，兼容已有 JSON 数据。"""

from alembic import op
import sqlalchemy as sa

revision = "0002_author_search"
down_revision = "34885075a58f"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("papers", sa.Column("authors_search", sa.Text(), nullable=False, server_default=""))
    papers = sa.table("papers", sa.column("id", sa.String()), sa.column("authors", sa.JSON()), sa.column("authors_search", sa.Text()))
    connection = op.get_bind()
    for row in connection.execute(sa.select(papers.c.id, papers.c.authors)).all():
        connection.execute(papers.update().where(papers.c.id == row.id).values(authors_search="\n".join(row.authors or [])))


def downgrade():
    with op.batch_alter_table("papers") as batch:
        batch.drop_column("authors_search")
