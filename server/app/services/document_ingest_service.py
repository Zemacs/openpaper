import logging
import uuid
from hashlib import sha256
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from app.database.crud.paper_crud import PaperCreate, PaperUpdate, paper_crud
from app.database.crud.paper_upload_crud import (
    PaperUploadJobCreate,
    paper_upload_job_crud,
)
from app.database.crud.projects.project_paper_crud import (
    ProjectPaperCreate,
    project_paper_crud,
)
from app.database.models import Paper, PaperUploadJob
from app.helpers.article_extract import extract_article_from_url
from app.schemas.document import DocumentSourceType
from app.schemas.user import CurrentUser
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def create_document_upload_job(db: Session, user: CurrentUser) -> PaperUploadJob:
    job = paper_upload_job_crud.create(
        db=db,
        obj_in=PaperUploadJobCreate(started_at=datetime.now(timezone.utc)),
        user=user,
    )
    if not job:
        raise RuntimeError("Failed to create document upload job.")
    return job


def _attach_project_if_needed(
    db: Session,
    *,
    paper: Paper,
    project_id: Optional[str],
    user: CurrentUser,
) -> None:
    if not project_id:
        return

    project_uuid = uuid.UUID(str(project_id))
    project_paper_crud.create(
        db=db,
        obj_in=ProjectPaperCreate(paper_id=uuid.UUID(str(paper.id))),
        user=user,
        project_id=project_uuid,
    )


def _compute_content_sha256(raw_content: str) -> str:
    return sha256(raw_content.encode("utf-8")).hexdigest()


def ingest_web_article_document(
    *,
    job_id: str,
    source_url: str,
    title: Optional[str],
    canonical_url: Optional[str],
    content_format: Optional[str],
    raw_content: str,
    extraction_meta: Optional[dict[str, Any]],
    content_sha256: Optional[str],
    current_user: CurrentUser,
    db: Session,
    project_id: Optional[str] = None,
) -> Paper:
    normalized_raw_content = (raw_content or "").strip()
    if len(normalized_raw_content) < 120:
        raise ValueError("Could not extract enough readable article content from URL.")

    resolved_canonical_url = (canonical_url or source_url).strip()
    resolved_title = title.strip() if isinstance(title, str) and title.strip() else None
    resolved_content_format = (content_format or "text").strip() or "text"
    resolved_sha = (content_sha256 or "").strip() or _compute_content_sha256(
        normalized_raw_content
    )
    abstract_snippet = normalized_raw_content[:600]

    existing_paper = (
        db.query(Paper)
        .filter(
            Paper.user_id == current_user.id,
            Paper.canonical_url == resolved_canonical_url,
        )
        .order_by(Paper.updated_at.desc())
        .first()
    )

    if existing_paper:
        paper = paper_crud.update(
            db=db,
            db_obj=existing_paper,
            obj_in=PaperUpdate(
                source_type=DocumentSourceType.WEB_ARTICLE.value,
                source_url=source_url,
                canonical_url=resolved_canonical_url,
                content_format=resolved_content_format,
                content_sha256=resolved_sha,
                ingest_status="completed",
                extraction_meta=extraction_meta or {},
                title=resolved_title or existing_paper.title,
                abstract=existing_paper.abstract or abstract_snippet,
                raw_content=normalized_raw_content,
                upload_job_id=job_id,
                file_url=existing_paper.file_url or resolved_canonical_url,
            ),
            user=current_user,
        )
    else:
        paper = paper_crud.create(
            db=db,
            obj_in=PaperCreate(
                source_type=DocumentSourceType.WEB_ARTICLE.value,
                source_url=source_url,
                canonical_url=resolved_canonical_url,
                content_format=resolved_content_format,
                content_sha256=resolved_sha,
                ingest_status="completed",
                extraction_meta=extraction_meta or {},
                file_url=resolved_canonical_url,
                s3_object_key=None,
                title=resolved_title,
                abstract=abstract_snippet,
                raw_content=normalized_raw_content,
                upload_job_id=job_id,
            ),
            user=current_user,
        )

    if not paper:
        raise RuntimeError("Failed to create or update web article document.")

    _attach_project_if_needed(
        db,
        paper=paper,
        project_id=project_id,
        user=current_user,
    )
    return paper


def process_web_url_import_job(
    *,
    job_id: str,
    url: str,
    current_user: CurrentUser,
    db: Session,
    project_id: Optional[str] = None,
) -> None:
    """Background task: fetch article content and persist as a document."""
    job = paper_upload_job_crud.mark_as_running(db=db, job_id=job_id, user=current_user)
    if not job:
        logger.error("Web import job %s not found for user %s", job_id, current_user.id)
        return

    try:
        extraction = extract_article_from_url(url)
        ingest_web_article_document(
            job_id=job_id,
            source_url=url,
            title=extraction.title,
            canonical_url=extraction.canonical_url,
            content_format=extraction.content_format,
            raw_content=extraction.raw_content,
            extraction_meta=extraction.extraction_meta,
            content_sha256=extraction.content_sha256,
            current_user=current_user,
            db=db,
            project_id=project_id,
        )

        paper_upload_job_crud.mark_as_completed(db=db, job_id=job_id, user=current_user)
    except Exception as exc:
        parsed_url = urlparse(url)
        logger.error(
            "Web import failed for host=%s job=%s: %s",
            parsed_url.netloc,
            job_id,
            exc,
            exc_info=True,
        )
        paper_upload_job_crud.mark_as_failed(db=db, job_id=job_id, user=current_user)
