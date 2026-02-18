import os
from typing import Any, Optional

from app.database.crud.subscription_crud import subscription_crud
from app.database.database import get_db
from posthog import Posthog

POSTHOG_API_KEY = os.getenv("POSTHOG_API_KEY", None)
DEBUG = os.getenv("DEBUG", "False").lower() in ("true", "1", "t")

if POSTHOG_API_KEY:
    posthog = Posthog(
        POSTHOG_API_KEY,
        host="https://us.i.posthog.com",
        enable_exception_autocapture=True,
    )

    posthog_sync = Posthog(
        POSTHOG_API_KEY,
        host="https://us.i.posthog.com",
        sync_mode=True,
        enable_exception_autocapture=True,
    )
else:
    posthog = None
    posthog_sync = None

if DEBUG and posthog:
    posthog.debug = True


def track_event(
    event_name: str,
    properties: Optional[dict[str, Any]] = None,
    user_id=None,
    sync: bool = False,
):
    """
    Track an event with PostHog.

    :param event_name: Name of the event to track.
    :param properties: Optional dictionary of properties to associate with the event.
    """
    event_properties = dict(properties) if properties else {}

    if POSTHOG_API_KEY and not DEBUG:
        subscription = None
        if user_id is None:
            user_id = "anonymous"
        else:
            db_gen = get_db()
            db = next(db_gen)
            try:
                subscription = subscription_crud.get_by_user_id(db, user_id=user_id)
            finally:
                db_gen.close()

            if subscription:
                event_properties.update(
                    {
                        "subscription_plan": subscription.plan,
                        "subscription_status": subscription.status,
                    }
                )
            else:
                event_properties.update(
                    {
                        "subscription_plan": None,
                        "subscription_status": None,
                    }
                )

        if sync and posthog_sync:
            posthog_sync.capture(
                distinct_id=user_id, event=event_name, properties=event_properties
            )
        elif posthog:
            posthog.capture(
                distinct_id=user_id, event=event_name, properties=event_properties
            )
    else:
        print(
            f"PostHog tracking disabled. Event: {event_name}, Properties: {event_properties}"
        )
