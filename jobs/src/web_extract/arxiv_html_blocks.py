import re
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote_plus, urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup, NavigableString, Tag

from src.web_extract.html_utils import normalize_text_preserve_paragraphs

_HEADING_LEVEL_BY_TAG = {
    "h1": "h1",
    "h2": "h2",
    "h3": "h3",
    "h4": "h3",
    "h5": "h3",
    "h6": "h3",
}
_ARXIV_ROOT_SELECTORS = (
    "article.ltx_document",
    "article",
    "main",
    "body",
)
_PARAGRAPH_CONTAINER_CLASSES = {"ltx_para"}
_EQUATION_CLASSES = {
    "ltx_equation",
    "MathJax_Display",
    "math-display",
    "equation",
}
_MAX_TABLE_ROWS = 24
_MAX_TABLE_COLS = 10
_MAX_LIST_ITEMS = 20
_MAX_CODE_CHARS = 3000
_MAX_EQUATION_CHARS = 1200
_MAX_TABLE_CELL_CHARS = 280
_MAX_TABLE_NOTES = 8
_MAX_REFERENCE_CHARS = 1400
_REFERENCE_ITEM_CLASSES = {"ltx_bibitem"}


def _class_set(tag: Tag) -> set[str]:
    return {str(item).strip() for item in (tag.get("class") or []) if str(item).strip()}


@dataclass(frozen=True)
class ArxivStructuredContent:
    raw_content: str
    blocks: list[dict[str, Any]]
    block_counts: dict[str, int]


def _normalize_text(value: str) -> str:
    return normalize_text_preserve_paragraphs(value or "").replace("\n", " ").strip()


def _normalize_multiline_text(value: str) -> str:
    return normalize_text_preserve_paragraphs(value or "").strip()


def _normalize_inline_spacing(value: str) -> str:
    normalized = (
        str(value or "")
        .replace("\xa0", " ")
        .replace("\u200b", "")
        .replace("​", "")
        .replace("\ufeff", "")
    )
    normalized = re.sub(r"\s+", " ", normalized)
    normalized = re.sub(r"\s+([,.;:!?%)\]\}])", r"\1", normalized)
    normalized = re.sub(r"([(\[\{])\s+", r"\1", normalized)
    normalized = re.sub(r"\s+([’”])", r"\1", normalized)
    normalized = re.sub(r"([‘“])\s+", r"\1", normalized)
    return normalized.strip()


def _escape_markdown_link_label(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace("[", r"\[")
        .replace("]", r"\]")
    )


def _escape_markdown_text(value: str) -> str:
    escaped = str(value or "")
    for raw, replacement in (
        ("\\", "\\\\"),
        ("`", r"\`"),
        ("*", r"\*"),
        ("_", r"\_"),
        ("[", r"\["),
        ("]", r"\]"),
        ("<", r"\<"),
        (">", r"\>"),
        ("$", r"\$"),
    ):
        escaped = escaped.replace(raw, replacement)
    return escaped


def _sanitize_inline_text(value: str) -> str:
    return (
        str(value or "")
        .replace("\xa0", " ")
        .replace("\u200b", "")
        .replace("​", "")
        .replace("\ufeff", "")
    )


def _tag_has_class(tag: Tag, *candidates: str) -> bool:
    classes = _class_set(tag)
    return any(candidate in classes for candidate in candidates if candidate)


def _build_reference_anchor_id(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip()).strip("-").lower()
    return f"article-ref-{normalized or 'item'}"


def _normalize_inline_href(base_url: str, raw_href: str) -> str:
    href = str(raw_href or "").strip()
    if not href:
        return ""

    parsed_base = urlparse(base_url)
    parsed_href = urlparse(urljoin(base_url, href))
    if parsed_href.fragment and (
        href.startswith("#")
        or (
            parsed_base.scheme == parsed_href.scheme
            and parsed_base.netloc == parsed_href.netloc
            and parsed_base.path == parsed_href.path
        )
    ):
        return f"#{_build_reference_anchor_id(parsed_href.fragment)}"

    return parsed_href.geturl()


def _is_paragraph_tag(tag: Tag) -> bool:
    if tag.name == "p":
        return True
    if tag.name != "div":
        return False
    classes = _class_set(tag)
    return bool(classes.intersection(_PARAGRAPH_CONTAINER_CLASSES))


def _is_equation_tag(tag: Tag) -> bool:
    if tag.name == "math" and str(tag.get("display") or "").lower() == "block":
        return True
    classes = _class_set(tag)
    return bool(classes.intersection(_EQUATION_CLASSES))


def _is_data_table_tag(tag: Tag) -> bool:
    if tag.name != "table":
        return False
    classes = _class_set(tag)
    return "ltx_equation" not in classes


def _is_span_data_table_figure(tag: Tag) -> bool:
    return tag.name == "figure" and _tag_has_class(tag, "ltx_table")


def _is_reference_item_tag(tag: Tag) -> bool:
    if tag.name not in {"li", "div"}:
        return False
    return bool(_class_set(tag).intersection(_REFERENCE_ITEM_CLASSES))


def _is_structured_ancestor_selected(tag: Tag, selected_tag_ids: set[int]) -> bool:
    parent = tag.parent
    while isinstance(parent, Tag):
        if id(parent) in selected_tag_ids:
            return True
        parent = parent.parent
    return False


def _extract_heading_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    inline_runs = _extract_inline_runs(tag, base_url="")
    text = _normalize_inline_spacing(_inline_runs_to_text(inline_runs))
    if len(text) < 2:
        return None
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": _HEADING_LEVEL_BY_TAG.get(tag.name or "", "h3"),
        "text": text,
    }
    inline_markdown = _normalize_inline_spacing(_inline_runs_to_markdown(inline_runs))
    if inline_markdown and inline_markdown != text:
        block["inline_markdown"] = inline_markdown
    if _inline_runs_have_structure(inline_runs):
        block["inline_runs"] = inline_runs
    return block


def _extract_inline_math_text(tag: Tag) -> str:
    for annotation in tag.find_all("annotation"):
        encoding = str(annotation.get("encoding") or "").lower().strip()
        if encoding not in {"application/x-tex", "application/tex", "latex"}:
            continue
        tex_value = _clean_equation_tex(annotation.get_text(" ", strip=True))
        if tex_value:
            return tex_value

    alt_text = _clean_equation_tex(str(tag.get("alttext") or "").strip())
    if alt_text:
        return alt_text

    return _normalize_inline_spacing(tag.get_text("", strip=False))


def _text_run(value: str) -> Optional[dict[str, Any]]:
    text = _sanitize_inline_text(value)
    if not text:
        return None
    return {
        "type": "text",
        "text": text,
    }


def _normalize_inline_run_list(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        run_type = str(run.get("type") or "").strip().lower()
        if run_type == "text":
            text = _sanitize_inline_text(str(run.get("text") or ""))
            if not text:
                continue
            if normalized and normalized[-1].get("type") == "text":
                normalized[-1]["text"] = f"{normalized[-1].get('text', '')}{text}"
                continue
            normalized.append(
                {
                    "type": "text",
                    "text": text,
                }
            )
            continue

        normalized_children = _normalize_inline_run_list(
            [child for child in run.get("children") or [] if isinstance(child, dict)]
        )
        if run_type == "math":
            text = _clean_equation_tex(str(run.get("text") or ""))
            if not text:
                continue
            normalized.append(
                {
                    "type": "math",
                    "text": text,
                }
            )
            continue
        if run_type == "link":
            href = str(run.get("href") or "").strip()
            if not href:
                if normalized_children:
                    normalized.extend(normalized_children)
                continue
            if not normalized_children:
                label = _normalize_inline_spacing(str(run.get("text") or ""))
                if not label:
                    continue
                normalized_children = [{"type": "text", "text": label}]
            normalized.append(
                {
                    "type": "link",
                    "href": href,
                    "children": normalized_children,
                }
            )
            continue
        if run_type in {"em", "strong", "code", "sub", "sup", "underline", "strike", "smallcaps"}:
            if not normalized_children:
                text = _sanitize_inline_text(str(run.get("text") or ""))
                if text:
                    normalized_children = [{"type": "text", "text": text}]
            if not normalized_children:
                continue
            normalized.append(
                {
                    "type": run_type,
                    "children": normalized_children,
                }
            )
            continue

        text = _sanitize_inline_text(str(run.get("text") or ""))
        if text:
            if normalized and normalized[-1].get("type") == "text":
                normalized[-1]["text"] = f"{normalized[-1].get('text', '')}{text}"
            else:
                normalized.append({"type": "text", "text": text})
        elif normalized_children:
            normalized.extend(normalized_children)
    return normalized


def _wrap_citation_part_with_link(part: str, href: str) -> list[dict[str, Any]]:
    if not part.strip():
        text_run = _text_run(part)
        return [text_run] if text_run else []

    match = re.match(r"^(\s*[\(\[]?\s*)(.*?)(\s*[\)\]]?\s*)$", str(part))
    if match:
        prefix, label, suffix = match.groups()
    else:
        prefix, label, suffix = "", str(part).strip(), ""

    normalized_label = _normalize_inline_spacing(label)
    if not normalized_label:
        text_run = _text_run(part)
        return [text_run] if text_run else []

    runs: list[dict[str, Any]] = []
    prefix_run = _text_run(prefix)
    if prefix_run:
        runs.append(prefix_run)
    runs.append(
        {
            "type": "link",
            "href": href,
            "children": [{"type": "text", "text": normalized_label}],
        }
    )
    suffix_run = _text_run(suffix)
    if suffix_run:
        runs.append(suffix_run)
    return runs


def _extract_cite_runs(tag: Tag, *, base_url: str) -> list[dict[str, Any]]:
    plain_text = _normalize_inline_spacing(tag.get_text(" ", strip=False))
    if not plain_text:
        return []

    links: list[str] = []
    for anchor in tag.find_all("a"):
        href = str(anchor.get("href") or "").strip()
        resolved_href = _normalize_inline_href(base_url, href)
        if resolved_href:
            links.append(resolved_href)

    if not links:
        text_run = _text_run(plain_text)
        return [text_run] if text_run else []

    if len(links) == 1:
        return _wrap_citation_part_with_link(plain_text, links[0])

    citation_parts = plain_text.split(";")
    if len(citation_parts) != len(links):
        text_run = _text_run(plain_text)
        return [text_run] if text_run else []

    rendered_parts: list[dict[str, Any]] = []
    for index, (raw_part, href) in enumerate(zip(citation_parts, links)):
        rendered_parts.extend(_wrap_citation_part_with_link(raw_part, href))
        if index < len(citation_parts) - 1:
            separator = _text_run("; ")
            if separator:
                rendered_parts.append(separator)
    return _normalize_inline_run_list(rendered_parts)


def _extract_inline_runs_from_children(tag: Tag, *, base_url: str) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for child in tag.children:
        runs.extend(_extract_inline_runs_node(child, base_url=base_url))
    return _normalize_inline_run_list(runs)


def _extract_inline_runs_node(node: Any, *, base_url: str) -> list[dict[str, Any]]:
    if isinstance(node, NavigableString):
        text_run = _text_run(str(node))
        return [text_run] if text_run else []

    if not isinstance(node, Tag):
        return []

    if node.name in {"script", "style", "annotation"}:
        return []

    if node.name == "br":
        text_run = _text_run(" ")
        return [text_run] if text_run else []

    if node.name == "cite":
        return _extract_cite_runs(node, base_url=base_url)

    if node.name == "math" and str(node.get("display") or "").lower() != "block":
        inline_math = _extract_inline_math_text(node)
        if not inline_math:
            return []
        return [
            {
                "type": "math",
                "text": inline_math,
            }
        ]

    if node.name == "a":
        href = str(node.get("href") or "").strip()
        resolved_href = _normalize_inline_href(base_url, href)
        child_runs = _extract_inline_runs_from_children(node, base_url=base_url)
        if not resolved_href:
            return child_runs
        if not child_runs:
            label = _normalize_inline_spacing(node.get_text(" ", strip=False))
            if not label:
                return []
            child_runs = [{"type": "text", "text": label}]
        return [
            {
                "type": "link",
                "href": resolved_href,
                "children": child_runs,
            }
        ]

    child_runs = _extract_inline_runs_from_children(node, base_url=base_url)
    if not child_runs:
        return []

    is_italic = node.name in {"em", "i"} or _tag_has_class(node, "ltx_font_italic")
    is_bold = node.name in {"strong", "b"} or _tag_has_class(node, "ltx_font_bold")
    is_code = node.name in {"code", "tt"} or _tag_has_class(node, "ltx_font_typewriter")
    is_sub = node.name == "sub" or _tag_has_class(node, "ltx_font_subscript")
    is_sup = node.name == "sup" or _tag_has_class(node, "ltx_font_superscript")
    is_underline = node.name in {"u", "ins"} or _tag_has_class(node, "ltx_font_underline")
    is_strike = node.name in {"s", "strike", "del"} or _tag_has_class(
        node,
        "ltx_font_strike",
        "ltx_font_strikethrough",
    )
    is_smallcaps = _tag_has_class(node, "ltx_font_smallcaps", "ltx_font_smallcap")

    wrapped_runs = child_runs
    if is_italic:
        wrapped_runs = [{"type": "em", "children": wrapped_runs}]
    if is_bold:
        wrapped_runs = [{"type": "strong", "children": wrapped_runs}]
    if is_code:
        wrapped_runs = [{"type": "code", "children": wrapped_runs}]
    if is_underline:
        wrapped_runs = [{"type": "underline", "children": wrapped_runs}]
    if is_strike:
        wrapped_runs = [{"type": "strike", "children": wrapped_runs}]
    if is_smallcaps:
        wrapped_runs = [{"type": "smallcaps", "children": wrapped_runs}]
    if is_sub:
        wrapped_runs = [{"type": "sub", "children": wrapped_runs}]
    if is_sup:
        wrapped_runs = [{"type": "sup", "children": wrapped_runs}]
    return wrapped_runs


def _extract_inline_runs(tag: Tag, *, base_url: str) -> list[dict[str, Any]]:
    return _normalize_inline_run_list(_extract_inline_runs_from_children(tag, base_url=base_url))


def _inline_runs_to_text(runs: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        run_type = str(run.get("type") or "").strip().lower()
        if run_type == "text":
            parts.append(_sanitize_inline_text(str(run.get("text") or "")))
            continue
        if run_type == "math":
            parts.append(_clean_equation_tex(str(run.get("text") or "")))
            continue
        children = [child for child in run.get("children") or [] if isinstance(child, dict)]
        if children:
            parts.append(_inline_runs_to_text(children))
    return "".join(parts)


def _inline_runs_to_markdown(runs: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        run_type = str(run.get("type") or "").strip().lower()
        if run_type == "text":
            parts.append(_escape_markdown_text(str(run.get("text") or "")))
            continue
        if run_type == "math":
            value = _clean_equation_tex(str(run.get("text") or ""))
            if value:
                parts.append(f"${value}$")
            continue
        children = [child for child in run.get("children") or [] if isinstance(child, dict)]
        if run_type == "link":
            href = str(run.get("href") or "").strip()
            label = _normalize_inline_spacing(_inline_runs_to_text(children))
            if href and label:
                parts.append(
                    f"[{_escape_markdown_link_label(label)}](<{href}>)"
                )
            elif label:
                parts.append(_escape_markdown_text(label))
            continue
        content = _inline_runs_to_markdown(children)
        if not content:
            continue
        if run_type == "em":
            parts.append(f"*{content}*")
        elif run_type == "strong":
            parts.append(f"**{content}**")
        elif run_type == "code":
            parts.append(f"`{content.replace('`', r'\\`')}`")
        elif run_type == "strike":
            parts.append(f"~~{content}~~")
        elif run_type == "sub":
            parts.append(content)
        elif run_type == "sup":
            parts.append(content)
        else:
            parts.append(content)
    return "".join(parts)


def _extract_inline_text(tag: Tag, *, base_url: str) -> str:
    return _normalize_inline_spacing(_inline_runs_to_text(_extract_inline_runs(tag, base_url=base_url)))


def _extract_inline_markdown(tag: Tag, *, base_url: str) -> str:
    return _normalize_inline_spacing(_inline_runs_to_markdown(_extract_inline_runs(tag, base_url=base_url)))


def _inline_runs_have_structure(runs: list[dict[str, Any]]) -> bool:
    return any(str(run.get("type") or "").strip().lower() != "text" for run in runs)


def _extract_paragraph_block(
    tag: Tag,
    *,
    base_url: str,
    block_index: int,
) -> Optional[dict[str, Any]]:
    text_source: Tag = tag
    if tag.name == "div":
        for child in tag.find_all(["p", "div"], recursive=False):
            if isinstance(child, Tag) and _is_paragraph_tag(child):
                return None
        # Keep equation/table/list/media as separate structured blocks.
        sandbox = BeautifulSoup(str(tag), "html.parser")
        cloned_root = sandbox.find(tag.name)
        if isinstance(cloned_root, Tag):
            for nested in cloned_root.select(
                "figure, ul, ol, pre, blockquote, table, .ltx_equation, math[display='block']"
            ):
                nested.decompose()
            text_source = cloned_root

    inline_runs = _extract_inline_runs(text_source, base_url=base_url)
    text = _normalize_inline_spacing(_inline_runs_to_text(inline_runs))
    if len(text) < 20:
        return None
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "paragraph",
        "text": text,
    }
    inline_markdown = _normalize_inline_spacing(_inline_runs_to_markdown(inline_runs))
    if inline_markdown and inline_markdown != text:
        block["inline_markdown"] = inline_markdown
    if _inline_runs_have_structure(inline_runs):
        block["inline_runs"] = inline_runs
    return block


def _extract_list_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    for child in tag.find_all(["li", "div"], recursive=False):
        if isinstance(child, Tag) and _is_reference_item_tag(child):
            return None

    items: list[str] = []
    for item in tag.find_all("li", recursive=False):
        text = _extract_inline_text(item, base_url="")
        if not text:
            continue
        items.append(text)
        if len(items) >= _MAX_LIST_ITEMS:
            break
    if not items:
        return None
    return {
        "id": f"arxiv-{block_index}",
        "type": "list",
        "ordered": tag.name == "ol",
        "items": items,
    }


def _extract_figure_block(
    tag: Tag,
    *,
    base_url: str,
    block_index: int,
) -> Optional[dict[str, Any]]:
    image = tag.find("img")
    if image is None:
        return None
    src = str(image.get("src") or "").strip()
    if not src:
        return None
    image_url = _resolve_asset_url(base_url, src)
    if not image_url:
        return None
    lowered_url = image_url.lower()
    if any(marker in lowered_url for marker in ("logo", "icon", "badge", "favicon", "orcid")):
        return None

    caption_tag = tag.find("figcaption")
    caption = (
        _normalize_text(caption_tag.get_text(" ", strip=True))
        if isinstance(caption_tag, Tag)
        else ""
    )
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "image",
        "image_url": image_url,
        "source": "arxiv_html_figure",
    }
    if caption:
        block["caption"] = caption
    return block


def _detect_reference_links(reference_text: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    seen_hrefs: set[str] = set()
    normalized_text = str(reference_text or "").strip()
    if not normalized_text:
        return links

    def append_link(*, href: str, label: str, kind: str) -> None:
        normalized_href = str(href or "").strip()
        normalized_label = str(label or "").strip()
        if not normalized_href or not normalized_label:
            return
        if normalized_href in seen_hrefs:
            return
        seen_hrefs.add(normalized_href)
        links.append(
            {
                "href": normalized_href,
                "label": normalized_label,
                "kind": kind,
            }
        )

    arxiv_match = re.search(
        r"\barXiv:(?P<identifier>[A-Za-z\-]+/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b",
        normalized_text,
        re.IGNORECASE,
    )
    if arxiv_match:
        identifier = str(arxiv_match.group("identifier") or "").strip()
        if identifier:
            append_link(
                href=f"https://arxiv.org/abs/{identifier}",
                label=f"arXiv:{identifier}",
                kind="arxiv",
            )

    doi_match = re.search(
        r"\b(10\.\d{4,9}/[-._;()/:A-Z0-9]+)\b",
        normalized_text,
        re.IGNORECASE,
    )
    if doi_match:
        doi = str(doi_match.group(1) or "").rstrip(".,;)")
        if doi:
            append_link(
                href=f"https://doi.org/{doi}",
                label="DOI",
                kind="doi",
            )

    for url_match in re.finditer(
        r"https?://[^\s)>\]]+",
        normalized_text,
        re.IGNORECASE,
    ):
        url_value = str(url_match.group(0) or "").rstrip(".,;)")
        if url_value:
            append_link(
                href=url_value,
                label=url_value.replace("https://", "").replace("http://", "")[:72],
                kind="url",
            )

    if not links:
        append_link(
            href=f"https://scholar.google.com/scholar?q={quote_plus(normalized_text[:320])}",
            label="Scholar",
            kind="search",
        )

    return links


def _extract_reference_block(
    tag: Tag,
    *,
    block_index: int,
) -> Optional[dict[str, Any]]:
    reference_text = _normalize_text(tag.get_text(" ", strip=True))
    if not reference_text:
        return None
    if len(reference_text) > _MAX_REFERENCE_CHARS:
        reference_text = reference_text[:_MAX_REFERENCE_CHARS].rstrip()

    links = _detect_reference_links(reference_text)
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "reference",
        "text": reference_text,
    }
    raw_anchor_id = str(tag.get("id") or "").strip()
    if raw_anchor_id:
        block["anchor_id"] = _build_reference_anchor_id(raw_anchor_id)
    if links:
        block["links"] = links
    return block


def _resolve_asset_url(base_url: str, relative_url: str) -> str:
    normalized_relative_url = str(relative_url or "").strip()
    if not normalized_relative_url:
        return ""

    parsed_base_url = urlparse(base_url)
    asset_base_url = urlunparse(
        (
            parsed_base_url.scheme,
            parsed_base_url.netloc,
            f"{parsed_base_url.path.rstrip('/')}/",
            "",
            "",
            "",
        )
    )
    return urljoin(asset_base_url, normalized_relative_url)


def _clean_equation_tex(value: str) -> str:
    cleaned = (
        str(value or "")
        .replace("\u200b", "")
        .replace("​", "")
        .replace("\ufeff", "")
        .strip()
    )
    if cleaned.startswith("$$") and cleaned.endswith("$$") and len(cleaned) > 4:
        cleaned = cleaned[2:-2].strip()
    if cleaned.startswith("\\[") and cleaned.endswith("\\]") and len(cleaned) > 4:
        cleaned = cleaned[2:-2].strip()
    return cleaned


def _extract_equation_number(tag: Tag) -> str:
    for selector in (".ltx_tag_equation", ".ltx_eqn_tag", ".ltx_tag"):
        number_tag = tag.select_one(selector)
        if isinstance(number_tag, Tag):
            value = _normalize_text(number_tag.get_text(" ", strip=True))
            if value:
                return value
    return ""


def _extract_equation_text(tag: Tag) -> str:
    candidates: list[str] = []
    for math_tag in tag.find_all("math"):
        for annotation in math_tag.find_all("annotation"):
            encoding = str(annotation.get("encoding") or "").lower().strip()
            if encoding not in {"application/x-tex", "application/tex", "latex"}:
                continue
            tex_value = _clean_equation_tex(annotation.get_text(" ", strip=True))
            if tex_value:
                candidates.append(tex_value)

        alt_text = str(math_tag.get("alttext") or "").strip()
        if alt_text:
            candidates.append(_clean_equation_tex(alt_text))

    if candidates:
        unique_candidates: list[str] = []
        for item in candidates:
            if not item:
                continue
            if item not in unique_candidates:
                unique_candidates.append(item)
        if len(unique_candidates) == 1:
            return unique_candidates[0]
        return r" \\ ".join(unique_candidates)

    for attr in ("data-tex", "latex", "tex"):
        value = _clean_equation_tex(str(tag.get(attr) or ""))
        if value:
            return value

    fallback_text = _normalize_text(tag.get_text(" ", strip=True))
    number = _extract_equation_number(tag)
    if number and fallback_text.endswith(number):
        fallback_text = fallback_text[: -len(number)].strip()
    return _clean_equation_tex(fallback_text)


def _extract_equation_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    equation = _extract_equation_text(tag).strip()
    if not equation:
        return None
    if len(equation) > _MAX_EQUATION_CHARS:
        equation = equation[:_MAX_EQUATION_CHARS].rstrip()
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "equation",
        "equation_tex": equation,
    }
    number = _extract_equation_number(tag)
    if number:
        block["equation_number"] = number
    return block


def _extract_code_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    code_text = _normalize_multiline_text(tag.get_text("\n", strip=True))
    if not code_text:
        return None
    if len(code_text) > _MAX_CODE_CHARS:
        code_text = code_text[:_MAX_CODE_CHARS].rstrip()
    return {
        "id": f"arxiv-{block_index}",
        "type": "code",
        "text": code_text,
    }


def _extract_blockquote_block(
    tag: Tag,
    *,
    base_url: str,
    block_index: int,
) -> Optional[dict[str, Any]]:
    inline_runs = _extract_inline_runs(tag, base_url=base_url)
    text = _normalize_inline_spacing(_inline_runs_to_text(inline_runs))
    if len(text) < 10:
        return None
    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "blockquote",
        "text": text,
    }
    inline_markdown = _normalize_inline_spacing(_inline_runs_to_markdown(inline_runs))
    if inline_markdown and inline_markdown != text:
        block["inline_markdown"] = inline_markdown
    if _inline_runs_have_structure(inline_runs):
        block["inline_runs"] = inline_runs
    return block


def _parse_positive_int(raw_value: Any, default: int = 1) -> int:
    try:
        value = int(str(raw_value or default).strip())
    except (TypeError, ValueError):
        return default
    return max(1, value)


def _parse_class_span_value(classes: set[str], prefix: str, default: int = 1) -> int:
    for class_name in classes:
        match = re.fullmatch(rf"{re.escape(prefix)}_(\d+)", str(class_name or "").strip())
        if not match:
            continue
        return _parse_positive_int(match.group(1), default)
    return default


def _extract_table_cell(cell: Tag) -> Optional[dict[str, Any]]:
    inline_runs = _extract_inline_runs(cell, base_url="")
    text = _normalize_inline_spacing(_inline_runs_to_text(inline_runs))
    if not text:
        text = _normalize_text(cell.get_text(" ", strip=True))
    text = text[:_MAX_TABLE_CELL_CHARS]
    classes = _class_set(cell)
    colspan = _parse_positive_int(cell.get("colspan"), 1)
    if colspan == 1:
        colspan = _parse_class_span_value(classes, "ltx_colspan", 1)
    rowspan = _parse_positive_int(cell.get("rowspan"), 1)
    if rowspan == 1:
        rowspan = _parse_class_span_value(classes, "ltx_rowspan", 1)
    is_header = cell.name == "th" or "ltx_th" in classes

    if not text and colspan == 1 and rowspan == 1:
        return None

    parsed: dict[str, Any] = {
        "text": text,
        "is_header": is_header,
    }
    inline_markdown = _normalize_inline_spacing(_inline_runs_to_markdown(inline_runs))
    if inline_markdown and inline_markdown != text:
        parsed["inline_markdown"] = inline_markdown
    if _inline_runs_have_structure(inline_runs):
        parsed["inline_runs"] = inline_runs
    if colspan > 1:
        parsed["colspan"] = colspan
    if rowspan > 1:
        parsed["rowspan"] = rowspan
    scope = str(cell.get("scope") or "").strip().lower()
    if not scope:
        if "ltx_th_row" in classes:
            scope = "row"
        elif "ltx_th_column" in classes:
            scope = "col"
    if scope:
        parsed["scope"] = scope
    return parsed


def _extract_table_row_cells(tr: Tag) -> list[dict[str, Any]]:
    cells = tr.find_all(["th", "td"], recursive=False) or tr.find_all(["th", "td"])
    parsed: list[dict[str, Any]] = []
    column_budget = 0
    for cell in cells:
        if not isinstance(cell, Tag):
            continue
        parsed_cell = _extract_table_cell(cell)
        if not parsed_cell:
            continue
        span = int(parsed_cell.get("colspan") or 1)
        if column_budget + span > _MAX_TABLE_COLS:
            break
        parsed.append(parsed_cell)
        column_budget += span
    return parsed


def _extract_span_table_row_cells(row: Tag) -> list[dict[str, Any]]:
    cells = [
        child
        for child in row.find_all(True, recursive=False)
        if _tag_has_class(child, "ltx_td")
    ]
    if not cells:
        cells = [child for child in row.find_all(True) if _tag_has_class(child, "ltx_td")]

    parsed: list[dict[str, Any]] = []
    column_budget = 0
    for cell in cells:
        parsed_cell = _extract_table_cell(cell)
        if not parsed_cell:
            continue
        span = int(parsed_cell.get("colspan") or 1)
        if column_budget + span > _MAX_TABLE_COLS:
            break
        parsed.append(parsed_cell)
        column_budget += span
    return parsed


def _collect_table_rows(section: Optional[Tag], *, max_rows: int) -> list[list[dict[str, Any]]]:
    if not isinstance(section, Tag):
        return []
    rows: list[list[dict[str, Any]]] = []
    for tr in section.find_all("tr", recursive=False):
        parsed = _extract_table_row_cells(tr)
        if not parsed:
            continue
        rows.append(parsed)
        if len(rows) >= max_rows:
            break
    if rows:
        return rows
    for tr in section.find_all("tr"):
        parsed = _extract_table_row_cells(tr)
        if not parsed:
            continue
        rows.append(parsed)
        if len(rows) >= max_rows:
            break
    return rows


def _collect_span_table_rows(section: Optional[Tag], *, max_rows: int) -> list[list[dict[str, Any]]]:
    if not isinstance(section, Tag):
        return []
    row_tags = [
        child
        for child in section.find_all(True, recursive=False)
        if _tag_has_class(child, "ltx_tr")
    ]
    if not row_tags:
        row_tags = [child for child in section.find_all(True) if _tag_has_class(child, "ltx_tr")]

    rows: list[list[dict[str, Any]]] = []
    for row_tag in row_tags:
        parsed = _extract_span_table_row_cells(row_tag)
        if not parsed:
            continue
        rows.append(parsed)
        if len(rows) >= max_rows:
            break
    return rows


def _collect_span_table_section_rows(
    tabular: Optional[Tag],
    *,
    section_class: str,
    max_rows: int,
) -> list[list[dict[str, Any]]]:
    if not isinstance(tabular, Tag):
        return []
    sections = [
        child
        for child in tabular.find_all(True, recursive=False)
        if _tag_has_class(child, section_class)
    ]
    if not sections:
        sections = [child for child in tabular.find_all(True) if _tag_has_class(child, section_class)]

    rows: list[list[dict[str, Any]]] = []
    for section in sections:
        remaining = max_rows - len(rows)
        if remaining <= 0:
            break
        rows.extend(_collect_span_table_rows(section, max_rows=remaining))
    return rows


def _legacy_row_text(row: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for cell in row:
        text = str(cell.get("text") or "").strip()
        if text:
            values.append(text)
    return values[:_MAX_TABLE_COLS]


def _extract_table_notes(tag: Tag) -> list[str]:
    notes: list[str] = []

    tfoot = tag.find("tfoot")
    if isinstance(tfoot, Tag):
        for tr in tfoot.find_all("tr"):
            line = _normalize_text(tr.get_text(" ", strip=True))
            if not line:
                continue
            if line not in notes:
                notes.append(line)
            if len(notes) >= _MAX_TABLE_NOTES:
                break

    figure_parent = tag if tag.name == "figure" else tag.find_parent("figure")
    if isinstance(figure_parent, Tag):
        for selector in (".ltx_note", ".ltx_tablenote", ".ltx_note_outer"):
            for node in figure_parent.select(selector):
                line = _normalize_text(node.get_text(" ", strip=True))
                if not line:
                    continue
                if line not in notes:
                    notes.append(line)
                if len(notes) >= _MAX_TABLE_NOTES:
                    break
            if len(notes) >= _MAX_TABLE_NOTES:
                break

    return notes


def _extract_table_caption(tag: Tag) -> str:
    caption_tag = tag.find("caption")
    if isinstance(caption_tag, Tag):
        caption = _extract_inline_text(caption_tag, base_url="")
        if caption:
            return caption

    figure_parent = tag if tag.name == "figure" else tag.find_parent("figure")
    if isinstance(figure_parent, Tag):
        figcaption = figure_parent.find("figcaption")
        if isinstance(figcaption, Tag):
            caption = _extract_inline_text(figcaption, base_url="")
            if caption:
                return caption
    return ""


def _build_table_block(
    *,
    header_rows: list[list[dict[str, Any]]],
    body_rows: list[list[dict[str, Any]]],
    caption: str,
    notes: list[str],
    block_index: int,
) -> dict[str, Any]:
    legacy_columns = _legacy_row_text(header_rows[-1]) if header_rows else []
    legacy_rows: list[list[str]] = []
    for row in body_rows:
        legacy = _legacy_row_text(row)
        if legacy:
            legacy_rows.append(legacy)

    if not legacy_columns and legacy_rows:
        legacy_columns = legacy_rows[0]
        legacy_rows = legacy_rows[1:]

    block: dict[str, Any] = {
        "id": f"arxiv-{block_index}",
        "type": "table",
        "columns": legacy_columns,
        "rows": legacy_rows,
        "header_rows": header_rows,
        "body_rows": body_rows,
    }
    if caption:
        block["caption"] = caption
    if notes:
        block["notes"] = notes
    return block


def _extract_table_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    thead_rows = _collect_table_rows(tag.find("thead"), max_rows=4)
    body_rows = _collect_table_rows(tag.find("tbody"), max_rows=_MAX_TABLE_ROWS)

    if not thead_rows and not body_rows:
        all_rows = _collect_table_rows(tag, max_rows=_MAX_TABLE_ROWS + 4)
        for row in all_rows:
            has_header_cell = any(bool(cell.get("is_header")) for cell in row)
            if has_header_cell and not body_rows and len(thead_rows) < 4:
                thead_rows.append(row)
            else:
                body_rows.append(row)
            if len(body_rows) >= _MAX_TABLE_ROWS:
                break

    if not thead_rows and not body_rows:
        return None

    if not thead_rows and body_rows:
        first_row = body_rows[0]
        if any(bool(cell.get("is_header")) for cell in first_row):
            thead_rows = [first_row]
            body_rows = body_rows[1:]

    caption = _extract_table_caption(tag)
    notes = _extract_table_notes(tag)
    return _build_table_block(
        header_rows=thead_rows,
        body_rows=body_rows,
        caption=caption,
        notes=notes,
        block_index=block_index,
    )

def _extract_span_table_figure_block(tag: Tag, *, block_index: int) -> Optional[dict[str, Any]]:
    tabular = tag.select_one(".ltx_tabular")
    if not isinstance(tabular, Tag):
        return None

    thead_rows = _collect_span_table_section_rows(tabular, section_class="ltx_thead", max_rows=4)
    body_rows = _collect_span_table_section_rows(
        tabular,
        section_class="ltx_tbody",
        max_rows=_MAX_TABLE_ROWS,
    )

    if not thead_rows and not body_rows:
        all_rows = _collect_span_table_rows(tabular, max_rows=_MAX_TABLE_ROWS + 4)
        for row in all_rows:
            has_header_cell = any(bool(cell.get("is_header")) for cell in row)
            if has_header_cell and not body_rows and len(thead_rows) < 4:
                thead_rows.append(row)
            else:
                body_rows.append(row)
            if len(body_rows) >= _MAX_TABLE_ROWS:
                break

    if not thead_rows and not body_rows:
        return None

    if not thead_rows and body_rows:
        first_row = body_rows[0]
        if any(bool(cell.get("is_header")) for cell in first_row):
            thead_rows = [first_row]
            body_rows = body_rows[1:]

    caption = _extract_table_caption(tag)
    notes = _extract_table_notes(tag)
    return _build_table_block(
        header_rows=thead_rows,
        body_rows=body_rows,
        caption=caption,
        notes=notes,
        block_index=block_index,
    )


def _block_to_text(block: dict[str, Any]) -> str:
    block_type = str(block.get("type") or "")
    if block_type in {"h1", "h2", "h3", "paragraph", "blockquote", "code"}:
        return _normalize_multiline_text(str(block.get("text") or ""))
    if block_type == "reference":
        return _normalize_multiline_text(str(block.get("text") or ""))
    if block_type == "equation":
        return _normalize_multiline_text(str(block.get("equation_tex") or ""))
    if block_type == "list":
        items = [str(item).strip() for item in block.get("items") or [] if str(item).strip()]
        return _normalize_multiline_text("\n".join(f"- {item}" for item in items))
    if block_type == "table":
        table_lines: list[str] = []

        def row_to_line(cells: Any) -> str:
            if not isinstance(cells, list):
                return ""
            values: list[str] = []
            for cell in cells:
                if isinstance(cell, dict):
                    text = str(cell.get("text") or "").strip()
                    if text:
                        values.append(text)
                else:
                    text = str(cell or "").strip()
                    if text:
                        values.append(text)
            return " | ".join(values)

        header_rows = block.get("header_rows") or []
        body_rows = block.get("body_rows") or []
        columns = [str(value).strip() for value in block.get("columns") or [] if str(value).strip()]
        rows = [
            [str(value).strip() for value in row if str(value).strip()]
            for row in block.get("rows") or []
            if isinstance(row, list)
        ]

        if header_rows:
            for row in header_rows[:3]:
                line = row_to_line(row)
                if line:
                    table_lines.append(line)
        elif columns:
            table_lines.append(" | ".join(columns))

        if body_rows:
            for row in body_rows[:8]:
                line = row_to_line(row)
                if line:
                    table_lines.append(line)
        else:
            for row in rows[:8]:
                line = " | ".join(row)
                if line:
                    table_lines.append(line)

        parts: list[str] = []
        caption = str(block.get("caption") or "").strip()
        if caption:
            parts.append(caption)
        if table_lines:
            parts.extend(table_lines)
        notes = [
            str(note).strip()
            for note in (block.get("notes") or [])
            if str(note).strip()
        ]
        if notes:
            parts.extend(notes[:_MAX_TABLE_NOTES])
        return _normalize_multiline_text("\n".join(parts))
    if block_type == "image":
        return _normalize_multiline_text(str(block.get("caption") or ""))
    return ""


def _append_unique_segment(segments: list[str], text: str) -> None:
    normalized = _normalize_multiline_text(text)
    if not normalized:
        return
    lowered = normalized.casefold()
    for existing in segments:
        existing_lowered = existing.casefold()
        if lowered == existing_lowered:
            return
        if len(lowered) >= 64 and lowered in existing_lowered:
            return
        if len(existing_lowered) >= 64 and existing_lowered in lowered:
            return
    segments.append(normalized)


def _select_root(soup: BeautifulSoup) -> Tag:
    for selector in _ARXIV_ROOT_SELECTORS:
        node = soup.select_one(selector)
        if isinstance(node, Tag):
            return node
    return soup


def extract_arxiv_structured_content(
    *,
    page_html: str,
    base_url: str,
    max_chars: int,
) -> ArxivStructuredContent:
    soup = BeautifulSoup(page_html or "", "html.parser")
    root = _select_root(soup)

    selected_tag_ids: set[int] = set()
    blocks: list[dict[str, Any]] = []
    block_index = 1

    for tag in root.find_all(True):
        if _is_structured_ancestor_selected(tag, selected_tag_ids):
            continue

        block: Optional[dict[str, Any]] = None

        if tag.name in _HEADING_LEVEL_BY_TAG:
            block = _extract_heading_block(tag, block_index=block_index)
        elif _is_reference_item_tag(tag):
            block = _extract_reference_block(tag, block_index=block_index)
        elif _is_equation_tag(tag):
            block = _extract_equation_block(tag, block_index=block_index)
        elif _is_data_table_tag(tag):
            block = _extract_table_block(tag, block_index=block_index)
        elif _is_span_data_table_figure(tag):
            block = _extract_span_table_figure_block(tag, block_index=block_index)
        elif tag.name == "figure":
            block = _extract_figure_block(tag, base_url=base_url, block_index=block_index)
        elif tag.name in {"ul", "ol"}:
            block = _extract_list_block(tag, block_index=block_index)
        elif tag.name == "pre":
            block = _extract_code_block(tag, block_index=block_index)
        elif tag.name == "blockquote":
            block = _extract_blockquote_block(tag, base_url=base_url, block_index=block_index)
        elif _is_paragraph_tag(tag):
            block = _extract_paragraph_block(tag, base_url=base_url, block_index=block_index)

        if not block:
            continue

        is_non_exclusive_paragraph_container = (
            block.get("type") == "paragraph" and tag.name == "div"
        )
        if not is_non_exclusive_paragraph_container:
            selected_tag_ids.add(id(tag))
        blocks.append(block)
        block_index += 1

    text_segments: list[str] = []
    for block in blocks:
        text = _block_to_text(block)
        if text:
            _append_unique_segment(text_segments, text)

    raw_content = normalize_text_preserve_paragraphs("\n\n".join(text_segments))
    if len(raw_content) > max_chars:
        raw_content = raw_content[:max_chars].rstrip()

    block_counts: dict[str, int] = {}
    for block in blocks:
        key = str(block.get("type") or "unknown")
        block_counts[key] = block_counts.get(key, 0) + 1

    return ArxivStructuredContent(
        raw_content=raw_content,
        blocks=blocks,
        block_counts=block_counts,
    )
