import html
import re
from urllib.parse import urljoin, urlparse, urlunparse

TITLE_REGEX = re.compile(r"<title[^>]*>(.*?)</title>", flags=re.IGNORECASE | re.DOTALL)
CANONICAL_REGEX = re.compile(
    r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']',
    flags=re.IGNORECASE,
)
JSONLD_SCRIPT_REGEX = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    flags=re.IGNORECASE | re.DOTALL,
)
ARTICLE_CONTAINER_REGEX = re.compile(
    r"<(article|main)[^>]*>(.*?)</\1>",
    flags=re.IGNORECASE | re.DOTALL,
)
BODY_REGEX = re.compile(r"<body[^>]*>(.*?)</body>", flags=re.IGNORECASE | re.DOTALL)
PARAGRAPH_REGEX = re.compile(r"<p[^>]*>.*?</p>", flags=re.IGNORECASE | re.DOTALL)
ARXIV_HTML_PATH_REGEX = re.compile(r"^/html/(?P<identifier>[^/?#]+)$", flags=re.IGNORECASE)
ARXIV_HTML_REFERENCE_REGEX = re.compile(
    r"/html/(?P<identifier>[^\"'\\s<>?#]+)",
    flags=re.IGNORECASE,
)
ARXIV_VERSION_SUFFIX_REGEX = re.compile(r"v\d+$", flags=re.IGNORECASE)


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_text_preserve_paragraphs(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    normalized_lines: list[str] = []

    for line in lines:
        cleaned = normalize_whitespace(html.unescape(line))
        if cleaned:
            normalized_lines.append(cleaned)
        elif normalized_lines and normalized_lines[-1] != "":
            normalized_lines.append("")

    while normalized_lines and normalized_lines[0] == "":
        normalized_lines.pop(0)
    while normalized_lines and normalized_lines[-1] == "":
        normalized_lines.pop()

    return "\n".join(normalized_lines)


def extract_title(page_html: str) -> str | None:
    match = TITLE_REGEX.search(page_html or "")
    if not match:
        return None
    value = normalize_whitespace(html.unescape(match.group(1)))
    return value or None


def _resolve_url_without_fragment(url: str, fallback_url: str) -> str:
    base_url = fallback_url.strip() or url.strip()
    resolved_url = urljoin(base_url, url.strip() or fallback_url)
    parsed = urlparse(resolved_url)
    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            parsed.query,
            "",
        )
    )


def _normalize_arxiv_canonical_url(page_html: str, fallback_url: str) -> str:
    parsed = urlparse(fallback_url)
    host = (parsed.netloc or "").lower().strip()
    if host != "arxiv.org" and not host.endswith(".arxiv.org"):
        return fallback_url

    path_match = ARXIV_HTML_PATH_REGEX.match(parsed.path or "")
    if not path_match:
        return fallback_url

    current_identifier = (path_match.group("identifier") or "").strip()
    if not current_identifier:
        return fallback_url

    if ARXIV_VERSION_SUFFIX_REGEX.search(current_identifier):
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))

    current_base_identifier = ARXIV_VERSION_SUFFIX_REGEX.sub("", current_identifier)
    for match in ARXIV_HTML_REFERENCE_REGEX.finditer(page_html or ""):
        candidate_identifier = (match.group("identifier") or "").strip()
        if not candidate_identifier:
            continue
        if ARXIV_VERSION_SUFFIX_REGEX.sub("", candidate_identifier) != current_base_identifier:
            continue
        if not ARXIV_VERSION_SUFFIX_REGEX.search(candidate_identifier):
            continue
        return urlunparse(
            (
                parsed.scheme,
                parsed.netloc,
                f"/html/{candidate_identifier}",
                "",
                "",
                "",
            )
        )

    return fallback_url


def extract_canonical_url(page_html: str, fallback_url: str) -> str:
    match = CANONICAL_REGEX.search(page_html or "")
    if match:
        value = (match.group(1) or "").strip()
        resolved_url = _resolve_url_without_fragment(value or fallback_url, fallback_url)
    else:
        resolved_url = _resolve_url_without_fragment(fallback_url, fallback_url)
    return _normalize_arxiv_canonical_url(page_html, resolved_url)


def strip_html_to_text(page_html: str) -> str:
    without_script = re.sub(
        r"<(script|style|svg|noscript)\b[^>]*>.*?</\1>",
        " ",
        page_html or "",
        flags=re.IGNORECASE | re.DOTALL,
    )
    without_comments = re.sub(r"<!--.*?-->", " ", without_script, flags=re.DOTALL)
    with_line_breaks = re.sub(
        r"</(p|div|li|h\d|br|tr|section|article|main|blockquote|pre)>",
        "\n",
        without_comments,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"<[^>]+>", " ", with_line_breaks)
    return normalize_text_preserve_paragraphs(text)


def extract_primary_html_candidates(page_html: str) -> list[str]:
    candidates: list[str] = []
    html_text = page_html or ""

    for match in ARTICLE_CONTAINER_REGEX.finditer(html_text):
        fragment = (match.group(2) or "").strip()
        if fragment:
            candidates.append(fragment)

    body_match = BODY_REGEX.search(html_text)
    if body_match and body_match.group(1):
        candidates.append(body_match.group(1))

    paragraph_block = "\n".join(PARAGRAPH_REGEX.findall(html_text))
    if paragraph_block:
        candidates.append(paragraph_block)

    if not candidates:
        candidates.append(html_text)

    return candidates


def build_reader_blocks(raw_content: str) -> list[dict[str, str]]:
    normalized = normalize_text_preserve_paragraphs(raw_content)
    if not normalized:
        return []

    chunks = [
        chunk.strip()
        for chunk in re.split(r"\n{2,}", normalized)
        if chunk and chunk.strip()
    ]
    blocks: list[dict[str, str]] = []
    for idx, chunk in enumerate(chunks, start=1):
        is_heading_like = (
            len(chunk) <= 90
            and not chunk.endswith(".")
            and not chunk.endswith("!")
            and not chunk.endswith("?")
        )
        blocks.append(
            {
                "id": f"b{idx}",
                "type": "heading" if is_heading_like else "paragraph",
                "text": chunk,
            }
        )
    return blocks
