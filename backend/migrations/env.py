"""迁移可复用应用传入的连接，避免误操作其他数据库。"""

from alembic import context
from app.config import Settings
from app.database import connect_database
from app.models import Base

config = context.config


def execute(connection):
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=connection.dialect.name == "sqlite")
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    context.configure(url=Settings.from_env().database_url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    supplied = config.attributes.get("connection")
    if supplied is not None:
        execute(supplied)
    else:
        engine, _ = connect_database(Settings.from_env())
        with engine.connect() as connection:
            execute(connection)
        engine.dispose()
