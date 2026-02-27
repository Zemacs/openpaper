"""add document v3 core fields

Revision ID: f9c4e2a1b7d3
Revises: 8a9f31d0c2b7
Create Date: 2026-02-26 18:00:00.000000+00:00

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "f9c4e2a1b7d3"
down_revision: Union[str, None] = "8a9f31d0c2b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "papers",
        sa.Column("source_type", sa.String(), nullable=False, server_default="pdf"),
    )
    op.add_column("papers", sa.Column("source_url", sa.String(), nullable=True))
    op.add_column("papers", sa.Column("canonical_url", sa.String(), nullable=True))
    op.add_column("papers", sa.Column("content_format", sa.String(), nullable=True))
    op.add_column("papers", sa.Column("content_sha256", sa.String(), nullable=True))
    op.add_column(
        "papers",
        sa.Column(
            "ingest_status",
            sa.String(),
            nullable=False,
            server_default="completed",
        ),
    )
    op.add_column(
        "papers",
        sa.Column("extraction_meta", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_index(
        "ix_papers_user_id_canonical_url",
        "papers",
        ["user_id", "canonical_url"],
        unique=False,
    )
    op.create_index(
        "ix_papers_content_sha256", "papers", ["content_sha256"], unique=False
    )

    op.add_column(
        "highlights",
        sa.Column("anchor", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    op.add_column(
        "translation_usage_logs",
        sa.Column("selection_id", sa.String(), nullable=True),
    )
    op.add_column(
        "translation_usage_logs",
        sa.Column("source_type", sa.String(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("translation_usage_logs", "source_type")
    op.drop_column("translation_usage_logs", "selection_id")

    op.drop_column("highlights", "anchor")

    op.drop_index("ix_papers_content_sha256", table_name="papers")
    op.drop_index("ix_papers_user_id_canonical_url", table_name="papers")
    op.drop_column("papers", "extraction_meta")
    op.drop_column("papers", "ingest_status")
    op.drop_column("papers", "content_sha256")
    op.drop_column("papers", "content_format")
    op.drop_column("papers", "canonical_url")
    op.drop_column("papers", "source_url")
    op.drop_column("papers", "source_type")
