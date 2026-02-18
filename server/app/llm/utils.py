import asyncio
import difflib
import functools
import json
import logging
import random
import time
from typing import Any, Callable, Tuple

import httpx
import openai

logger = logging.getLogger(__name__)

try:
    from google.genai import errors as genai_errors
except Exception:  # pragma: no cover - optional import safety
    genai_errors = None

_GENAI_RETRYABLE_EXCEPTIONS: tuple[type[BaseException], ...] = ()
if genai_errors:
    _GENAI_RETRYABLE_EXCEPTIONS = (
        genai_errors.ClientError,
        genai_errors.ServerError,
    )

# Exceptions that should trigger a retry with backoff
RETRYABLE_EXCEPTIONS = (
    ValueError,
    json.JSONDecodeError,
    httpx.HTTPError,
    httpx.RemoteProtocolError,
    openai.InternalServerError,  # 500, 503
    openai.RateLimitError,  # 429
    openai.APIConnectionError,  # Network issues
    openai.APITimeoutError,  # Timeouts
    *_GENAI_RETRYABLE_EXCEPTIONS,
)

_TRANSIENT_ERROR_HINTS = (
    "429",
    "too many requests",
    "resource exhausted",
    "rate limit",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "read operation timed out",
    "connect timeout",
    "connecterror",
    "connection reset",
    "connection aborted",
    "unexpected eof",
    "ssl",
    "tls",
    "service unavailable",
)


def is_transient_llm_error(error: BaseException) -> bool:
    if isinstance(error, RETRYABLE_EXCEPTIONS):
        return True

    message = str(error).lower()
    return any(marker in message for marker in _TRANSIENT_ERROR_HINTS)


def get_llm_error_category(error: BaseException) -> str:
    message = str(error).lower()
    if "429" in message or "too many requests" in message or "resource exhausted" in message:
        return "rate_limited"
    if "timed out" in message or "timeout" in message:
        return "timeout"
    if (
        "connect" in message
        or "connection" in message
        or "ssl" in message
        or "tls" in message
        or "eof" in message
    ):
        return "network"
    return "unknown"


def format_llm_error_for_client(error: BaseException) -> str:
    category = get_llm_error_category(error)
    if category == "rate_limited":
        return "LLM provider is busy. Please retry in a few seconds."
    if category == "timeout":
        return "LLM provider timed out. Please retry."
    if category == "network":
        return "LLM provider connection was interrupted. Please retry."
    return "LLM provider is temporarily unavailable. Please retry."


def retry_llm_operation(max_retries: int = 3, delay: float = 1.0):
    """
    Decorator to retry LLM operations that may fail due to API errors or validation issues.

    Args:
        max_retries: Maximum number of retry attempts (default: 3)
        delay: Base delay between retries in seconds (default: 1.0)
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exception: BaseException | None = None

            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except RETRYABLE_EXCEPTIONS as e:
                    last_exception = e
                    if attempt < max_retries:
                        # Calculate exponential backoff with jitter
                        backoff_time = (
                            delay * (2**attempt) * (0.5 + 0.5 * random.random())
                        )
                        logger.warning(
                            f"Retry {attempt+1}/{max_retries} for {func.__name__}: {type(e).__name__}: {str(e)[:100]}. Retrying in {backoff_time:.2f}s"
                        )
                        time.sleep(backoff_time)
                    else:
                        logger.warning(
                            f"All {max_retries} retries failed for {func.__name__}"
                        )

            # If we reach here, all retries failed
            if last_exception is not None:
                logger.error(
                    f"Final failure after {max_retries} retries for {func.__name__}: {str(last_exception)}"
                )
                raise last_exception

        # Create async version for async functions
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            last_exception: BaseException | None = None

            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except RETRYABLE_EXCEPTIONS as e:
                    last_exception = e
                    if attempt < max_retries:
                        # Calculate exponential backoff with jitter
                        backoff_time = (
                            delay * (2**attempt) * (0.5 + 0.5 * random.random())
                        )
                        logger.warning(
                            f"Retry {attempt+1}/{max_retries} for {func.__name__}: {type(e).__name__}: {str(e)[:100]}. Retrying in {backoff_time:.2f}s"
                        )
                        await asyncio.sleep(backoff_time)
                    else:
                        logger.warning(
                            f"All {max_retries} retries failed for {func.__name__}"
                        )

            # If we reach here, all retries failed
            if last_exception is not None:
                logger.error(
                    f"Final failure after {max_retries} retries for {func.__name__}: {str(last_exception)}"
                )
                raise last_exception

        # Return appropriate wrapper based on if the function is async or not
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return wrapper

    return decorator


def find_offsets(target: str, full_text: str) -> Tuple[int, int]:
    """
    Find the start and end offsets of a target string within a full text.
    Returns a tuple of (start_offset, end_offset), or (-1, -1) if not found.
    """
    if not target or not full_text:
        return -1, -1

    # Try exact match first
    start_offset = full_text.find(target)
    if start_offset != -1:
        return start_offset, start_offset + len(target)

    # Fall back to fuzzy search
    matcher = difflib.SequenceMatcher(None, full_text, target)
    match = matcher.find_longest_match(0, len(full_text), 0, len(target))
    if match.size == 0:
        return -1, -1

    # Reject weak partial matches to avoid pinning highlights
    # to unrelated short snippets (commonly in title/abstract area).
    min_match_len = min(len(target), max(20, int(len(target) * 0.6)))
    if match.size < min_match_len:
        return -1, -1

    return match.a, match.a + match.size
