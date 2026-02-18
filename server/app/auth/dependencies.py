import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Annotated, Optional

from app.database.crud.subscription_crud import SubscriptionCreate, subscription_crud
from app.database.crud.user_crud import user as user_crud
from app.database.database import get_db
from app.database.models import SubscriptionPlan, SubscriptionStatus
from app.schemas.user import CurrentUser
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader
from sqlalchemy.orm import Session

load_dotenv()

logger = logging.getLogger(__name__)

# Session cookie name
SESSION_COOKIE_NAME = "session_token"

# Setup header auth
api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

# ---------------------------------------------------------------------------
# Dev auto-login: skip OAuth/email auth and use a local dev account.
#
# Activate by setting DEV_AUTO_LOGIN=true in .env.
# As a safety net, it is forcibly disabled when ENV=production so that a
# stray env var cannot bypass authentication in a real deployment.
# ---------------------------------------------------------------------------
_ENV = os.getenv("ENV", "").lower()
_dev_auto_login_requested = os.getenv("DEV_AUTO_LOGIN", "false").lower() == "true"

if _dev_auto_login_requested and _ENV == "production":
    logger.error(
        "DEV_AUTO_LOGIN=true is set but ENV=production — "
        "auto-login has been DISABLED for security. "
        "Remove DEV_AUTO_LOGIN from your production config."
    )
    DEV_AUTO_LOGIN = False
else:
    DEV_AUTO_LOGIN = _dev_auto_login_requested

if DEV_AUTO_LOGIN:
    logger.warning(
        "⚠ DEV_AUTO_LOGIN is ENABLED — all requests will be authenticated "
        "as the dev user. Do NOT use this in production."
    )

DEV_USER_EMAIL = os.getenv("DEV_USER_EMAIL", "dev@openpaper.local")
DEV_USER_NAME = os.getenv("DEV_USER_NAME", "Dev User")

# Cache dev user with TTL to avoid DB lookups on every request
_dev_user_cache: Optional[CurrentUser] = None
_dev_user_cache_ts: float = 0.0
_DEV_CACHE_TTL_SECONDS = 300  # 5 minutes


def _get_or_create_dev_user(db: Session) -> CurrentUser:
    """Get or create a dev user with admin privileges and RESEARCHER subscription."""
    global _dev_user_cache, _dev_user_cache_ts

    now = time.monotonic()
    if _dev_user_cache is not None and (now - _dev_user_cache_ts) < _DEV_CACHE_TTL_SECONDS:
        return _dev_user_cache

    # Find or create user (handle race condition where another request already created it)
    db_user = user_crud.get_by_email(db, email=DEV_USER_EMAIL)
    if not db_user:
        try:
            db_user = user_crud.create_email_user(db, email=DEV_USER_EMAIL, name=DEV_USER_NAME)
            db_user.is_admin = True  # type: ignore
            db_user.is_email_verified = True  # type: ignore
            db.commit()
            db.refresh(db_user)
            logger.info(f"Created dev user: {DEV_USER_EMAIL}")
        except Exception:
            db.rollback()
            db_user = user_crud.get_by_email(db, email=DEV_USER_EMAIL)
            if not db_user:
                raise

    # Ensure admin + verified
    if not db_user.is_admin or not db_user.is_email_verified:
        db_user.is_admin = True  # type: ignore
        db_user.is_email_verified = True  # type: ignore
        db.commit()
        db.refresh(db_user)

    # Find or create RESEARCHER subscription
    subscription = subscription_crud.get_by_user_id(db, db_user.id)
    if not subscription:
        subscription = subscription_crud.create(
            db,
            obj_in=SubscriptionCreate(
                user_id=db_user.id,
                status=SubscriptionStatus.ACTIVE.value,
                current_period_start=datetime(2020, 1, 1, tzinfo=timezone.utc),
                current_period_end=datetime(2099, 12, 31, tzinfo=timezone.utc),
            ),
        )
        # Set plan to RESEARCHER (not in SubscriptionCreate schema)
        subscription.plan = SubscriptionPlan.RESEARCHER.value  # type: ignore
        db.commit()
        db.refresh(subscription)
        logger.info(f"Created RESEARCHER subscription for dev user: {DEV_USER_EMAIL}")

    # Ensure subscription is active RESEARCHER
    needs_update = False
    if str(subscription.plan) != SubscriptionPlan.RESEARCHER.value:
        subscription.plan = SubscriptionPlan.RESEARCHER.value  # type: ignore
        needs_update = True
    if str(subscription.status) != SubscriptionStatus.ACTIVE.value:
        subscription.status = SubscriptionStatus.ACTIVE.value  # type: ignore
        needs_update = True
    if not subscription.current_period_end or subscription.current_period_end < datetime.now(timezone.utc):
        subscription.current_period_end = datetime(2099, 12, 31, tzinfo=timezone.utc)  # type: ignore
        needs_update = True
    if needs_update:
        db.commit()
        db.refresh(subscription)

    dev_user = CurrentUser(
        id=uuid.UUID(str(db_user.id)),
        email=str(db_user.email),
        name=str(db_user.name),
        is_admin=True,
        picture=str(db_user.picture) if db_user.picture else None,
        is_email_verified=True,
        is_active=True,
    )
    _dev_user_cache = dev_user
    _dev_user_cache_ts = time.monotonic()
    return dev_user


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str = Depends(api_key_header),
) -> Optional[CurrentUser]:
    """
    Get the current user from session token in cookie or Authorization header.

    This is a FastAPI dependency that can be used in route functions.
    """
    # Dev auto-login: skip auth, return dev user directly
    if DEV_AUTO_LOGIN:
        return _get_or_create_dev_user(db)

    token = None

    # First try from Authorization header
    if authorization and authorization.startswith("Bearer "):
        token = authorization.replace("Bearer ", "")

    # Then try from cookie
    if not token:
        token = request.cookies.get(SESSION_COOKIE_NAME)

    if not token:
        return None

    # Get session from database
    db_session = user_crud.get_by_token(db=db, token=token)
    if not db_session:
        return None

    # Get user from session
    db_user = user_crud.get(db=db, id=db_session.user_id)
    if not db_user or not db_user.is_active:
        return None

    if not db_user.id:
        logger.error("User ID is missing in the database record.")
        return None

    id_as_uuid = uuid.UUID(str(db_user.id))

    is_user_active = subscription_crud.is_user_active(db, db_user)

    # Return CurrentUser model
    return CurrentUser(
        id=id_as_uuid,
        email=str(db_user.email),
        name=str(db_user.name),
        is_admin=bool(db_user.is_admin),
        picture=str(db_user.picture),
        is_email_verified=bool(db_user.is_email_verified),
        is_active=is_user_active,
    )


async def get_required_user(
    current_user: Annotated[Optional[CurrentUser], Depends(get_current_user)]
) -> CurrentUser:
    """
    Require a logged-in user for protected routes.
    Raises 401 Unauthorized if no user is found.
    """
    if not current_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return current_user


async def get_admin_user(
    current_user: Annotated[CurrentUser, Depends(get_required_user)]
) -> CurrentUser:
    """
    Require an admin user for admin-only routes.
    Raises 403 Forbidden if user is not admin.
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions",
        )
    return current_user
