"""建立个人论文库与研究方向管理结构"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = '34885075a58f'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    # 初始数据库结构，由迁移工具生成。
    op.create_table('login_attempts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('address_hash', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.BigInteger(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('login_attempts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_login_attempts_address_hash'), ['address_hash'], unique=False)
        batch_op.create_index(batch_op.f('ix_login_attempts_created_at'), ['created_at'], unique=False)

    op.create_table('workspaces',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=50), nullable=False),
    sa.Column('quota_bytes', sa.BigInteger(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('papers',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('workspace_id', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=500), nullable=False),
    sa.Column('authors', sa.JSON(), nullable=False),
    sa.Column('year', sa.Integer(), nullable=True),
    sa.Column('doi', sa.String(length=200), nullable=True),
    sa.Column('original_filename', sa.String(length=255), nullable=False),
    sa.Column('file_hash', sa.String(length=64), nullable=False),
    sa.Column('file_size', sa.BigInteger(), nullable=False),
    sa.Column('page_count', sa.Integer(), nullable=False),
    sa.Column('reading_status', sa.String(length=20), nullable=False),
    sa.Column('is_favorite', sa.Boolean(), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.BigInteger(), nullable=False),
    sa.Column('updated_at', sa.BigInteger(), nullable=False),
    sa.Column('completed_at', sa.BigInteger(), nullable=True),
    sa.Column('deleted_at', sa.BigInteger(), nullable=True),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('workspace_id', 'file_hash', name='uq_paper_hash')
    )
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.create_index('ix_paper_workspace_status', ['workspace_id', 'reading_status', 'deleted_at'], unique=False)

    op.create_table('tags',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('workspace_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('name', sa.String(length=50), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('merged_into_id', sa.Integer(), nullable=True),
    sa.Column('deleted_at', sa.BigInteger(), nullable=True),
    sa.ForeignKeyConstraint(['merged_into_id'], ['tags.id'], ),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('tags', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_tags_workspace_id'), ['workspace_id'], unique=False)

    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('workspace_id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.BigInteger(), nullable=False),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('username')
    )
    op.create_table('paper_tags',
    sa.Column('paper_id', sa.String(length=32), nullable=False),
    sa.Column('tag_id', sa.Integer(), nullable=False),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.ForeignKeyConstraint(['paper_id'], ['papers.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tag_id'], ['tags.id'], ),
    sa.PrimaryKeyConstraint('paper_id', 'tag_id')
    )
    with op.batch_alter_table('paper_tags', schema=None) as batch_op:
        batch_op.create_index('ix_paper_tag_reverse', ['tag_id', 'paper_id'], unique=False)

    op.create_table('sessions',
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('expires_at', sa.BigInteger(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('token_hash')
    )
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_sessions_expires_at'), ['expires_at'], unique=False)

    op.create_table('tag_names',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('tag_id', sa.Integer(), nullable=False),
    sa.Column('workspace_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('name', sa.String(length=50), nullable=False),
    sa.Column('normalized_name', sa.String(length=100), nullable=False),
    sa.Column('is_primary', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['tag_id'], ['tags.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('workspace_id', 'kind', 'normalized_name', name='uq_tag_name')
    )
    with op.batch_alter_table('tag_names', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_tag_names_tag_id'), ['tag_id'], unique=False)

    # 本次迁移结束。

def downgrade() -> None:
    # 初始数据库结构，由迁移工具生成。
    with op.batch_alter_table('tag_names', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tag_names_tag_id'))

    op.drop_table('tag_names')
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_sessions_expires_at'))

    op.drop_table('sessions')
    with op.batch_alter_table('paper_tags', schema=None) as batch_op:
        batch_op.drop_index('ix_paper_tag_reverse')

    op.drop_table('paper_tags')
    op.drop_table('users')
    with op.batch_alter_table('tags', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tags_workspace_id'))

    op.drop_table('tags')
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.drop_index('ix_paper_workspace_status')

    op.drop_table('papers')
    op.drop_table('workspaces')
    with op.batch_alter_table('login_attempts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_login_attempts_created_at'))
        batch_op.drop_index(batch_op.f('ix_login_attempts_address_hash'))

    op.drop_table('login_attempts')
    # 本次迁移结束。
