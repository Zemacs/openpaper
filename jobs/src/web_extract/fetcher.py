import time
from typing import Optional

import requests

from src.web_extract.models import FetchedPage

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}

FALLBACK_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,*/*;q=0.8",
    "Accept-Language": "en;q=0.8",
}


def fetch_page(url: str, timeout_seconds: int = 30) -> FetchedPage:
    errors: list[str] = []
    profiles = [DEFAULT_HEADERS, FALLBACK_HEADERS]

    for idx, headers in enumerate(profiles, start=1):
        try:
            response = requests.get(
                url,
                timeout=timeout_seconds,
                headers=headers,
                allow_redirects=True,
            )
            response.raise_for_status()
            return FetchedPage(
                requested_url=url,
                final_url=str(response.url or url),
                content_type=(response.headers.get("content-type") or "").lower(),
                payload=response.text,
                status_code=response.status_code,
                headers={k.lower(): v for k, v in response.headers.items()},
            )
        except Exception as exc:
            errors.append(f"attempt={idx}: {exc}")
            time.sleep(0.15 * idx)

    message = "; ".join(errors) if errors else "unknown fetch error"
    raise RuntimeError(f"Failed to fetch URL content. {message}")


def is_probably_blocked_page(payload: str, content_type: Optional[str] = None) -> bool:
    lowered = (payload or "").lower()
    if "text/html" not in (content_type or "") and "<html" not in lowered:
        return False

    blocked_markers = [
        "captcha",
        "verify you are human",
        "access denied",
        "request blocked",
        "cloudflare",
        "robot check",
        "are you a robot",
    ]
    return any(marker in lowered for marker in blocked_markers)
