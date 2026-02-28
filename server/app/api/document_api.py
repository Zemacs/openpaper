import logging
import uuid
from typing import Optional
from urllib.parse import urlparse

from app.api.paper_upload_api import upload_raw_file_microservice
from app.auth.dependencies import get_required_user
from app.database.crud.paper_crud import paper_crud
from app.database.crud.paper_upload_crud import (
    PaperUploadJobUpdate,
    paper_upload_job_crud,
)
from app.database.database import get_db
from app.database.models import JobStatus
from app.helpers.parser import validate_url_and_fetch_pdf
from app.helpers.pdf_jobs import jobs_client
from app.helpers.s3 import s3_service
from app.helpers.subscription_limits import (
    can_user_access_knowledge_base,
    can_user_upload_paper,
)
from app.helpers.url_safety import validate_public_http_url
from app.schemas.document import (
    DocumentImportRequest,
    DocumentImportResponse,
    DocumentImportStatusResponse,
    DocumentImportSourceType,
    DocumentReadResponse,
    DocumentSourceType,
)
from app.schemas.user import CurrentUser
from app.services.document_ingest_service import create_document_upload_job
from app.services.document_import_planner import resolve_document_import_plan
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

document_router = APIRouter()


def _check_document_import_limits(current_user: CurrentUser, db: Session) -> Optional[str]:
    can_upload, error_message = can_user_upload_paper(db, current_user)
    if not can_upload and error_message:
        return error_message

    can_access, error_message = can_user_access_knowledge_base(db, current_user)
    if not can_access and error_message:
        return error_message

    return None


def _filename_from_url(url: str) -> str:
    parsed = urlparse(url)
    candidate = parsed.path.split("/")[-1].strip()
    if not candidate:
        return "document.pdf"
    if not candidate.lower().endswith(".pdf"):
        return f"{candidate}.pdf"
    return candidate


def _recover_completed_import_paper(
    *,
    db: Session,
    current_user: CurrentUser,
    upload_job,
):
    if not upload_job.task_id or str(upload_job.status) != JobStatus.COMPLETED.value:
        return None

    celery_status = jobs_client.check_celery_task_status(str(upload_job.task_id))
    if celery_status.get("status") != "success":
        return None

    task_result = celery_status.get("result") or {}
    canonical_url = str(task_result.get("canonical_url") or "").strip()
    if canonical_url:
        recovered_paper = paper_crud.get_by_canonical_url(
            db=db,
            canonical_url=canonical_url,
            user=current_user,
        )
        if recovered_paper:
            return recovered_paper

    fallback_url = str(task_result.get("source_url") or "").strip()
    if fallback_url:
        return paper_crud.get_by_canonical_url(
            db=db,
            canonical_url=fallback_url,
            user=current_user,
        )
    return None


@document_router.post("/import", response_model=DocumentImportResponse, status_code=202)
async def import_document(
    request: DocumentImportRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_required_user),
) -> DocumentImportResponse:
    error_message = _check_document_import_limits(current_user, db)
    if error_message:
        raise HTTPException(
            status_code=403,
            detail=error_message,
        )

    url = str(request.url)
    try:
        validate_public_http_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    import_plan = await resolve_document_import_plan(
        requested_source_type=request.source_type,
        url=url,
    )
    resolved_source_type = import_plan.resolved_source_type
    resolved_url = import_plan.resolved_url
    if resolved_source_type != request.source_type or resolved_url != url:
        logger.info(
            "Resolved document import plan request=%s resolved=%s resolver=%s url=%s resolved_url=%s",
            request.source_type.value,
            resolved_source_type.value,
            import_plan.resolver,
            url,
            resolved_url,
        )
    upload_job = None

    if resolved_source_type == DocumentImportSourceType.PDF_URL:
        is_valid, pdf_bytes, validation_error = await validate_url_and_fetch_pdf(resolved_url)
        if not is_valid:
            raise HTTPException(status_code=400, detail=validation_error)

        upload_job = create_document_upload_job(db, current_user)
        project_uuid = uuid.UUID(str(request.project_id)) if request.project_id else None
        background_tasks.add_task(
            upload_raw_file_microservice,
            file_contents=pdf_bytes,
            filename=_filename_from_url(resolved_url),
            paper_upload_job=upload_job,
            current_user=current_user,
            db=db,
            project_id=project_uuid,
        )
    elif resolved_source_type == DocumentImportSourceType.WEB_URL:
        upload_job = create_document_upload_job(db, current_user)
        running_job = paper_upload_job_crud.mark_as_running(
            db=db,
            job_id=str(upload_job.id),
            user=current_user,
        )
        if not running_job:
            paper_upload_job_crud.mark_as_failed(
                db=db,
                job_id=str(upload_job.id),
                user=current_user,
            )
            raise HTTPException(status_code=500, detail="Failed to initialize import job.")
        try:
            task_id = jobs_client.submit_web_document_import_job(
                url=resolved_url,
                job_id=str(upload_job.id),
                project_id=request.project_id,
            )
            paper_upload_job_crud.update(
                db=db,
                db_obj=running_job,
                obj_in=PaperUploadJobUpdate(task_id=task_id),
                user=current_user,
            )
        except Exception as exc:
            logger.error(
                "Failed to submit web document import job %s: %s",
                upload_job.id,
                exc,
                exc_info=True,
            )
            paper_upload_job_crud.mark_as_failed(
                db=db,
                job_id=str(upload_job.id),
                user=current_user,
            )
            raise HTTPException(
                status_code=502,
                detail="Failed to submit web import job to background queue.",
            ) from exc
    else:
        raise HTTPException(status_code=400, detail="Unsupported source_type.")

    if not upload_job:
        raise HTTPException(status_code=500, detail="Failed to create import job.")

    return DocumentImportResponse(
        job_id=str(upload_job.id),
        status=JobStatus.PENDING.value,
        source_type=resolved_source_type,
    )


@document_router.get(
    "/import/status/{job_id}",
    response_model=DocumentImportStatusResponse,
)
async def get_document_import_status(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_required_user),
) -> DocumentImportStatusResponse:
    upload_job = paper_upload_job_crud.get(db=db, id=job_id, user=current_user)
    if not upload_job:
        raise HTTPException(status_code=404, detail="Job not found.")

    paper = paper_crud.get_by_upload_job_id(
        db=db, upload_job_id=str(upload_job.id), user=current_user
    )
    if not paper:
        paper = _recover_completed_import_paper(
            db=db,
            current_user=current_user,
            upload_job=upload_job,
        )

    source_type = str(paper.source_type) if paper and paper.source_type else None

    if upload_job.task_id and upload_job.status not in (JobStatus.COMPLETED, JobStatus.FAILED):
        try:
            celery_status = jobs_client.check_celery_task_status(str(upload_job.task_id))
            if celery_status and celery_status.get("status") == "FAILURE":
                logger.warning(
                    "Celery task reported failure for import job %s: %s",
                    job_id,
                    celery_status.get("error"),
                )
        except Exception as exc:
            logger.warning("Failed to check celery status for job %s: %s", job_id, exc)

    return DocumentImportStatusResponse(
        job_id=str(upload_job.id),
        status=str(upload_job.status),
        source_type=source_type,
        task_id=str(upload_job.task_id) if upload_job.task_id else None,
        started_at=upload_job.started_at,
        completed_at=upload_job.completed_at,
        document_id=str(paper.id) if paper else None,
    )


@document_router.get("/{document_id}", response_model=DocumentReadResponse)
async def get_document(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_required_user),
) -> DocumentReadResponse:
    paper = paper_crud.get(
        db,
        id=document_id,
        user=current_user,
        update_last_accessed=True,
    )
    if not paper:
        raise HTTPException(status_code=404, detail="Document not found.")

    source_type = paper.source_type or DocumentSourceType.PDF.value
    viewer_type = "article" if source_type == DocumentSourceType.WEB_ARTICLE.value else "pdf"
    file_url: Optional[str] = None

    if viewer_type == "pdf":
        file_url = s3_service.get_cached_presigned_url(
            db,
            paper_id=str(paper.id),
            object_key=str(paper.s3_object_key),
            current_user=current_user,
        ) or paper.file_url

    return DocumentReadResponse(
        id=str(paper.id),
        source_type=source_type,
        viewer_type=viewer_type,
        title=paper.title,
        abstract=paper.abstract,
        authors=list(paper.authors or []),
        file_url=file_url,
        source_url=paper.source_url,
        canonical_url=paper.canonical_url,
        content_format=paper.content_format,
        raw_content=paper.raw_content if viewer_type == "article" else None,
    )
