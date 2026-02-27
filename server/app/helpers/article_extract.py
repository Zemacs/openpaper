import hashlib
import html
import logging
import os
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import requests

from app.helpers.url_safety import validate_public_http_url

logger = logging.getLogger(__name__)


@dataclass
class ArticleExtractionResult:
    title: Optional[str]
    canonical_url: str
    content_format: str
    raw_content: str
    content_sha256: str
    extraction_meta: dict


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _extract_title_from_html(page_html: str) -> Optional[str]:
    match = re.search(r"<title[^>]*>(.*?)</title>", page_html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    title = html.unescape(match.group(1))
    return _normalize_whitespace(title) or None


def _extract_canonical_url(page_html: str, fallback_url: str) -> str:
    match = re.search(
        r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']',
        page_html,
        flags=re.IGNORECASE,
    )
    if match and match.group(1):
        return match.group(1).strip()
    return fallback_url


def _strip_html_to_text(page_html: str) -> str:
    without_script = re.sub(
        r"<(script|style)\b[^>]*>.*?</\1>",
        " ",
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    without_comments = re.sub(r"<!--.*?-->", " ", without_script, flags=re.DOTALL)
    with_line_breaks = re.sub(r"</(p|div|li|h\d|br|tr)>", "\n", without_comments, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", with_line_breaks)
    text = html.unescape(text)
    return _normalize_whitespace(text)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _extract_with_firecrawl(url: str) -> Optional[ArticleExtractionResult]:
    api_key = (os.getenv("FIRECRAWL_API_KEY") or "").strip()
    if not api_key:
        return None

    try:
        from firecrawl import FirecrawlApp

        app = FirecrawlApp(api_key=api_key)
        response = app.scrape_url(url, formats=["markdown"])
        error = getattr(response, "error", None)
        markdown = getattr(response, "markdown", None)
        metadata = getattr(response, "metadata", None) or {}

        if error:
            logger.warning("Firecrawl scrape error for %s: %s", url, error)
            return None

        content = _normalize_whitespace(markdown or "")
        if len(content) < 120:
            logger.warning("Firecrawl returned insufficient content for %s", url)
            return None

        canonical_url = metadata.get("url") or metadata.get("canonicalUrl") or url
        title = metadata.get("title")

        return ArticleExtractionResult(
            title=_normalize_whitespace(title) if title else None,
            canonical_url=canonical_url,
            content_format="markdown",
            raw_content=content,
            content_sha256=_sha256_text(content),
            extraction_meta={
                "method": "firecrawl",
                "host": urlparse(url).netloc,
            },
        )
    except Exception as exc:
        logger.warning("Firecrawl extraction failed for %s: %s", url, exc)
        return None


def extract_article_from_url(url: str) -> ArticleExtractionResult:
    validate_public_http_url(url)

    firecrawl_result = _extract_with_firecrawl(url)
    if firecrawl_result:
        return firecrawl_result

    response = requests.get(
        url,
        timeout=30,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    response.raise_for_status()

    final_url = str(response.url or url)
    content_type = (response.headers.get("content-type") or "").lower()
    page_html = response.text

    if "text/html" in content_type or "<html" in page_html.lower():
        raw_text = _strip_html_to_text(page_html)
        title = _extract_title_from_html(page_html)
        canonical_url = _extract_canonical_url(page_html, final_url)
        content_format = "text"
    else:
        raw_text = _normalize_whitespace(response.text)
        title = None
        canonical_url = final_url
        content_format = "text"

    if len(raw_text) < 120:
        raise ValueError("Could not extract enough readable article content from the URL.")

    return ArticleExtractionResult(
        title=title,
        canonical_url=canonical_url,
        content_format=content_format,
        raw_content=raw_text,
        content_sha256=_sha256_text(raw_text),
        extraction_meta={
            "method": "requests_regex_fallback",
            "host": urlparse(final_url).netloc,
            "content_type": content_type,
        },
    )
