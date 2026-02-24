import asyncio
import logging
import os
import re

from app.auth.dependencies import get_required_user
from app.database.database import get_db
from app.database.telemetry import track_event
from app.helpers.subscription_limits import can_user_run_chat
from app.llm.translation_operations import (
    TranslationInputError,
    translation_operations,
)
from app.llm.utils import (
    format_llm_error_for_client,
    get_llm_error_category,
    is_transient_llm_error,
)
from app.schemas.translation import (
    TranslateSelectionRequest,
    TranslateSelectionResponse,
)
from app.schemas.user import CurrentUser
from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

translation_router = APIRouter()
MAX_CONTEXT_CHARS = 300
MAX_SELECTED_TEXT_CHARS = int(os.getenv("TRANSLATION_MAX_SELECTED_TEXT_CHARS", "5000"))
ESTIMATED_OUTPUT_CHARS = 400
TRANSLATION_TIMEOUT_SECONDS = int(os.getenv("TRANSLATION_TIMEOUT_SECONDS", "12"))


def _normalize_context(text: str | None, keep_tail: bool) -> str:
    normalized = (text or "").strip()
    if len(normalized) <= MAX_CONTEXT_CHARS:
        return normalized
    if keep_tail:
        return normalized[-MAX_CONTEXT_CHARS:]
    return normalized[:MAX_CONTEXT_CHARS]


def _estimate_request_chars(
    selected_text: str,
    context_before: str,
    context_after: str,
) -> int:
    return len(selected_text) + len(context_before) + len(context_after) + ESTIMATED_OUTPUT_CHARS


def _normalize_selected_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _truncate_selected_text(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_SELECTED_TEXT_CHARS:
        return text, False
    return text[:MAX_SELECTED_TEXT_CHARS].rstrip(), True


@translation_router.post("/selection", response_model=TranslateSelectionResponse)
async def translate_selection(
    request: TranslateSelectionRequest,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_required_user),
) -> TranslateSelectionResponse:
    original_selection_len = len(request.selected_text or "")
    selected_text = _normalize_selected_text(request.selected_text)
    if not selected_text:
        raise HTTPException(status_code=400, detail="selected_text cannot be empty.")
    selected_text, was_truncated = _truncate_selected_text(selected_text)

    context_before = _normalize_context(request.context_before, keep_tail=True)
    context_after = _normalize_context(request.context_after, keep_tail=False)
    estimated_chars = _estimate_request_chars(selected_text, context_before, context_after)

    track_event(
        "selection_translation_requested",
        properties={
            "paper_id": request.paper_id,
            "selection_len": len(selected_text),
            "selection_len_raw": original_selection_len,
            "selection_truncated": was_truncated,
            "selection_type_hint": request.selection_type_hint.value,
            "target_language": request.target_language,
        },
        user_id=str(current_user.id),
    )

    can_chat, reason = can_user_run_chat(
        db, current_user, estimated_chars=estimated_chars
    )
    if not can_chat:
        track_event(
            "selection_translation_quota_exceeded",
            properties={"reason": reason},
            user_id=str(current_user.id),
        )
        raise HTTPException(status_code=429, detail=reason)

    try:
        return await asyncio.wait_for(
            run_in_threadpool(
                translation_operations.translate_selection,
                db=db,
                current_user=current_user,
                paper_id=request.paper_id,
                selected_text=selected_text,
                page_number=request.page_number,
                selection_type_hint=request.selection_type_hint,
                context_before=context_before or None,
                context_after=context_after or None,
                target_language=request.target_language,
            ),
            timeout=TRANSLATION_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Selection translation timed out after %ss", TRANSLATION_TIMEOUT_SECONDS
        )
        track_event(
            "selection_translation_timeout",
            properties={"timeout_seconds": TRANSLATION_TIMEOUT_SECONDS},
            user_id=str(current_user.id),
        )
        raise HTTPException(
            status_code=504,
            detail="Translation request timed out. Please retry with a shorter selection.",
        )
    except TranslationInputError as e:
        logger.warning(f"Translation request rejected: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to translate selection: {e}", exc_info=True)
        category = get_llm_error_category(e)
        track_event(
            "selection_translation_failed",
            properties={"error": str(e), "category": category},
            user_id=str(current_user.id),
        )
        if is_transient_llm_error(e):
            raise HTTPException(
                status_code=503,
                detail=format_llm_error_for_client(e),
            )
        raise HTTPException(
            status_code=502,
            detail=format_llm_error_for_client(e),
        )
