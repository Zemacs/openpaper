"""add translation usage logs

Revision ID: 8a9f31d0c2b7
Revises: 434c547bf196
Create Date: 2026-02-18 09:30:00.000000+00:00

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8a9f31d0c2b7"
down_revision: Union[str, None] = "434c547bf196"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "translation_usage_logs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("paper_id", sa.UUID(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("source_chars", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("context_chars", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_chars", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("credits_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cached", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["paper_id"], ["papers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_translation_usage_logs_user_id",
        "translation_usage_logs",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_translation_usage_logs_created_at",
        "translation_usage_logs",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_translation_usage_logs_created_at", table_name="translation_usage_logs")
    op.drop_index("ix_translation_usage_logs_user_id", table_name="translation_usage_logs")
    op.drop_table("translation_usage_logs")
