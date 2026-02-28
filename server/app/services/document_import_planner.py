import asyncio
from dataclasses import dataclass
from urllib.parse import urlparse

import requests

from app.schemas.document import DocumentImportSourceType

_ARXIV_HOST_SUFFIX = "arxiv.org"
_ARXIV_PATH_PREFIXES = ("/abs/", "/pdf/", "/html/")
_PROBE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
}


@dataclass(frozen=True)
class DocumentImportPlan:
    requested_source_type: DocumentImportSourceType
    resolved_source_type: DocumentImportSourceType
    resolved_url: str
    resolver: str


def _is_arxiv_host(host: str) -> bool:
    lowered = (host or "").lower().strip()
    return lowered == _ARXIV_HOST_SUFFIX or lowered.endswith(f".{_ARXIV_HOST_SUFFIX}")


def _extract_arxiv_identifier(path: str) -> str | None:
    normalized_path = (path or "").strip()
    for prefix in _ARXIV_PATH_PREFIXES:
        if not normalized_path.startswith(prefix):
            continue
        identifier = normalized_path[len(prefix) :].strip("/")
        if prefix == "/pdf/" and identifier.lower().endswith(".pdf"):
            identifier = identifier[:-4]
        return identifier or None
    return None


def _build_arxiv_html_url(identifier: str) -> str:
    return f"https://arxiv.org/html/{identifier}"


def _build_arxiv_pdf_url(identifier: str) -> str:
    return f"https://arxiv.org/pdf/{identifier}.pdf"


def _response_looks_like_html(response: requests.Response, *, allow_body_sniff: bool) -> bool:
    status_code = int(response.status_code or 0)
    if status_code < 200 or status_code >= 400:
        return False

    content_type = (response.headers.get("content-type") or "").lower()
    if "application/pdf" in content_type:
        return False
    if "text/html" in content_type or "application/xhtml+xml" in content_type:
        return True

    if not allow_body_sniff:
        return False
    lowered_body = (response.text or "")[:2400].lower()
    return "<html" in lowered_body or "<main" in lowered_body or "<article" in lowered_body


def _probe_arxiv_html_availability_sync(url: str, timeout_seconds: int = 8) -> bool:
    try:
        head_response = requests.head(
            url,
            timeout=timeout_seconds,
            allow_redirects=True,
            headers=_PROBE_HEADERS,
        )
        if _response_looks_like_html(head_response, allow_body_sniff=False):
            return True

        get_response = requests.get(
            url,
            timeout=timeout_seconds,
            allow_redirects=True,
            headers=_PROBE_HEADERS,
        )
        return _response_looks_like_html(get_response, allow_body_sniff=True)
    except requests.RequestException:
        return False


async def _probe_arxiv_html_availability(url: str, timeout_seconds: int = 8) -> bool:
    return await asyncio.to_thread(
        _probe_arxiv_html_availability_sync,
        url,
        timeout_seconds,
    )


def _looks_like_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    return (parsed.path or "").lower().endswith(".pdf")


async def resolve_document_import_plan(
    *,
    requested_source_type: DocumentImportSourceType,
    url: str,
) -> DocumentImportPlan:
    if requested_source_type == DocumentImportSourceType.PDF_URL:
        return DocumentImportPlan(
            requested_source_type=requested_source_type,
            resolved_source_type=DocumentImportSourceType.PDF_URL,
            resolved_url=url,
            resolver="explicit_pdf_url",
        )

    parsed = urlparse(url)
    if _is_arxiv_host(parsed.netloc):
        identifier = _extract_arxiv_identifier(parsed.path)
        if identifier:
            html_url = _build_arxiv_html_url(identifier)
            if await _probe_arxiv_html_availability(html_url):
                return DocumentImportPlan(
                    requested_source_type=requested_source_type,
                    resolved_source_type=DocumentImportSourceType.WEB_URL,
                    resolved_url=html_url,
                    resolver="arxiv_html_preferred",
                )
            return DocumentImportPlan(
                requested_source_type=requested_source_type,
                resolved_source_type=DocumentImportSourceType.PDF_URL,
                resolved_url=_build_arxiv_pdf_url(identifier),
                resolver="arxiv_pdf_fallback",
            )

    if requested_source_type == DocumentImportSourceType.AUTO_URL:
        resolved_source_type = (
            DocumentImportSourceType.PDF_URL
            if _looks_like_pdf_url(url)
            else DocumentImportSourceType.WEB_URL
        )
        return DocumentImportPlan(
            requested_source_type=requested_source_type,
            resolved_source_type=resolved_source_type,
            resolved_url=url,
            resolver="auto_by_suffix",
        )

    return DocumentImportPlan(
        requested_source_type=requested_source_type,
        resolved_source_type=DocumentImportSourceType.WEB_URL,
        resolved_url=url,
        resolver="explicit_web_url",
    )
