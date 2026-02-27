from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from app.database.crud.base_crud import CRUDBase
from app.database.models import TranslationUsageLog
from app.schemas.user import CurrentUser
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session


class TranslationUsageBase(BaseModel):
    user_id: UUID
    paper_id: UUID
    selection_id: Optional[str] = None
    source_type: Optional[str] = None
    mode: str
    source_chars: int = 0
    context_chars: int = 0
    output_chars: int = 0
    credits_used: int = 0
    cached: bool = False


class TranslationUsageCreate(TranslationUsageBase):
    pass


class TranslationUsageUpdate(TranslationUsageBase):
    pass


class TranslationUsageCRUD(
    CRUDBase[TranslationUsageLog, TranslationUsageCreate, TranslationUsageUpdate]
):
    def create_usage(
        self,
        db: Session,
        *,
        user: CurrentUser,
        paper_id: UUID,
        mode: str,
        source_chars: int,
        context_chars: int,
        output_chars: int,
        cached: bool,
        selection_id: Optional[str] = None,
        source_type: Optional[str] = None,
    ) -> Optional[TranslationUsageLog]:
        total_chars = max(0, source_chars) + max(0, context_chars) + max(0, output_chars)
        credits_used = max(0, int(total_chars / 5))

        payload = TranslationUsageCreate(
            user_id=user.id,
            paper_id=paper_id,
            selection_id=selection_id,
            source_type=source_type,
            mode=mode,
            source_chars=max(0, source_chars),
            context_chars=max(0, context_chars),
            output_chars=max(0, output_chars),
            credits_used=credits_used,
            cached=cached,
        )
        return self.create(db, obj_in=payload, auto_commit=True)

    def get_translation_credits_used_this_week(
        self, db: Session, *, current_user: CurrentUser
    ) -> int:
        start_of_week = datetime.now(timezone.utc) - timedelta(
            days=datetime.now(timezone.utc).weekday()
        )
        start_of_week = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_week = start_of_week + timedelta(days=7)

        return (
            db.query(func.sum(TranslationUsageLog.credits_used))
            .filter(
                TranslationUsageLog.user_id == current_user.id,
                TranslationUsageLog.created_at >= start_of_week,
                TranslationUsageLog.created_at < end_of_week,
                TranslationUsageLog.cached == False,  # noqa: E712
            )
            .scalar()
            or 0
        )


translation_usage_crud = TranslationUsageCRUD(TranslationUsageLog)
