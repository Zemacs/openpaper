import json
import re
from abc import ABC, abstractmethod
from typing import Any, Optional
from urllib.parse import urlparse

import requests

from src.web_extract.adapter_registry import get_adapter_for_host
from src.web_extract.arxiv_html_blocks import extract_arxiv_structured_content
from src.web_extract.fetcher import (
    fetch_page,
    is_binary_content_type,
    is_probably_blocked_page,
)
from src.web_extract.html_utils import (
    JSONLD_SCRIPT_REGEX,
    build_reader_blocks,
    extract_canonical_url,
    extract_primary_html_candidates,
    extract_title,
    normalize_text_preserve_paragraphs,
    strip_html_to_text,
)
from src.web_extract.models import ExtractionCandidate, ExtractionContext
from src.web_extract.llm_adaptive import (
    apply_rule,
    evaluate_and_promote_rule,
    get_cached_rule,
    record_rule_replay_sample,
    synthesize_rule,
)


class ExtractorStrategy(ABC):
    name: str

    @abstractmethod
    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        raise NotImplementedError

    def _get_page(self, context: ExtractionContext):
        if context.fetched_page is None:
            context.fetched_page = fetch_page(context.url, timeout_seconds=context.timeout_seconds)
        return context.fetched_page


X_STATUS_HOSTS = {
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.x.com",
    "mobile.twitter.com",
}

_ARXIV_HOST_SUFFIX = "arxiv.org"
_ARXIV_HTML_PATH_REGEX = re.compile(r"/html/", flags=re.IGNORECASE)


def _is_arxiv_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower().strip()
    return host == _ARXIV_HOST_SUFFIX or host.endswith(f".{_ARXIV_HOST_SUFFIX}")


def _extract_image_url_from_media_entity(media_entity: dict[str, Any]) -> str | None:
    media_info = media_entity.get("media_info")
    if isinstance(media_info, dict):
        for key in ("original_img_url", "url", "media_url_https", "media_url"):
            value = str(media_info.get(key) or "").strip()
            if value:
                return value

    for key in ("url", "media_url_https", "media_url", "image"):
        value = str(media_entity.get(key) or "").strip()
        if value:
            return value
    return None


def _normalize_draft_entity_map(entity_map: Any) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}

    entries: list[tuple[str, Any]] = []
    if isinstance(entity_map, dict):
        entries = [(str(key), value) for key, value in entity_map.items()]
    elif isinstance(entity_map, list):
        entries = [(str(index), value) for index, value in enumerate(entity_map)]

    for outer_key, raw_value in entries:
        if not isinstance(raw_value, dict):
            continue
        candidate = (
            raw_value.get("value")
            if isinstance(raw_value.get("value"), dict)
            else raw_value
        )
        if not isinstance(candidate, dict):
            continue

        normalized[outer_key] = candidate
        inner_key = str(raw_value.get("key") or "").strip()
        if inner_key:
            normalized[inner_key] = candidate

    return normalized


def _build_fxtwitter_media_lookup(article: dict[str, Any]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    media_entities = article.get("media_entities")

    entries: list[tuple[str, Any]] = []
    if isinstance(media_entities, dict):
        entries = [(str(key), value) for key, value in media_entities.items()]
    elif isinstance(media_entities, list):
        entries = [(str(index), value) for index, value in enumerate(media_entities)]

    for key, value in entries:
        if not isinstance(value, dict):
            continue
        lookup[key] = value

        media_id = str(value.get("media_id") or "").strip()
        media_key = str(value.get("media_key") or "").strip()
        if media_id:
            lookup[media_id] = value
        if media_key:
            lookup[media_key] = value

    return lookup


def _append_unique_image_block(
    blocks: list[dict[str, Any]],
    seen_image_urls: set[str],
    *,
    block_id: str,
    image_url: str,
    caption: str | None = None,
    width: int | None = None,
    height: int | None = None,
    source: str | None = None,
) -> None:
    normalized_url = str(image_url or "").strip()
    if not normalized_url:
        return
    if normalized_url in seen_image_urls:
        return

    seen_image_urls.add(normalized_url)
    image_block: dict[str, Any] = {
        "id": block_id,
        "type": "image",
        "image_url": normalized_url,
    }
    if caption:
        image_block["caption"] = caption
    if width and width > 0:
        image_block["width"] = width
    if height and height > 0:
        image_block["height"] = height
    if source:
        image_block["source"] = source
    blocks.append(image_block)


def _extract_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _append_unique_text(text_blocks: list[str], text: str) -> None:
    normalized = normalize_text_preserve_paragraphs(text)
    if not normalized:
        return

    lowered = normalized.casefold()
    for existing in text_blocks:
        existing_lowered = existing.casefold()
        if lowered == existing_lowered:
            return
        if len(lowered) >= 32 and lowered in existing_lowered:
            return
        if len(existing_lowered) >= 32 and existing_lowered in lowered:
            return

    text_blocks.append(normalized)


def _parse_x_status_url(url: str) -> tuple[str | None, str] | None:
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    if host not in X_STATUS_HOSTS:
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    # /i/status/{id}
    if (
        len(segments) >= 3
        and segments[0] == "i"
        and segments[1] == "status"
        and segments[2].isdigit()
    ):
        return None, segments[2]

    # /i/web/status/{id}
    if (
        len(segments) >= 4
        and segments[0] == "i"
        and segments[1] == "web"
        and segments[2] == "status"
        and segments[3].isdigit()
    ):
        return None, segments[3]

    # /status/{id}
    if len(segments) >= 2 and segments[0] == "status" and segments[1].isdigit():
        return None, segments[1]

    # /{user}/status/{id}
    if len(segments) >= 3 and segments[1] == "status" and segments[2].isdigit():
        return segments[0], segments[2]

    return None


def _build_candidate_from_fxtwitter(
    source_url: str, payload: dict[str, Any]
) -> ExtractionCandidate | None:
    tweet = payload.get("tweet")
    if not isinstance(tweet, dict):
        return None

    article = tweet.get("article")
    text_blocks: list[str] = []
    blocks: list[dict[str, Any]] = []
    seen_image_urls: set[str] = set()
    title: str | None = None

    if isinstance(article, dict):
        title = str(article.get("title") or "").strip() or None
        media_lookup = _build_fxtwitter_media_lookup(article)
        entity_map = _normalize_draft_entity_map(
            (article.get("content") or {}).get("entityMap")
            if isinstance(article.get("content"), dict)
            else {}
        )

        cover_media = article.get("cover_media")
        if isinstance(cover_media, dict):
            cover_url = _extract_image_url_from_media_entity(cover_media)
            cover_info = cover_media.get("media_info")
            cover_width = _extract_int(
                (cover_info or {}).get("original_img_width")
                if isinstance(cover_info, dict)
                else None
            )
            cover_height = _extract_int(
                (cover_info or {}).get("original_img_height")
                if isinstance(cover_info, dict)
                else None
            )
            _append_unique_image_block(
                blocks,
                seen_image_urls,
                block_id="fx-cover",
                image_url=cover_url or "",
                caption=title,
                width=cover_width,
                height=cover_height,
                source="cover_media",
            )

        article_content = article.get("content")
        block_entries = (
            article_content.get("blocks", [])
            if isinstance(article_content, dict)
            else []
        )
        if isinstance(block_entries, list):
            for idx, entry in enumerate(block_entries, start=1):
                if not isinstance(entry, dict):
                    continue
                block_id = str(entry.get("key") or f"fx-{idx}")
                block_type = str(entry.get("type") or "paragraph").strip().lower()

                if block_type == "atomic":
                    entity_ranges = (
                        entry.get("entityRanges")
                        if isinstance(entry.get("entityRanges"), list)
                        else []
                    )
                    for entity_range in entity_ranges:
                        if not isinstance(entity_range, dict):
                            continue
                        entity_key = str(entity_range.get("key") or "").strip()
                        if not entity_key:
                            continue
                        entity = entity_map.get(entity_key)
                        if not isinstance(entity, dict):
                            continue
                        entity_type = str(entity.get("type") or "").strip().upper()
                        if entity_type != "MEDIA":
                            continue
                        entity_data = entity.get("data")
                        media_items = (
                            entity_data.get("mediaItems", [])
                            if isinstance(entity_data, dict)
                            else []
                        )
                        if not isinstance(media_items, list):
                            continue
                        for media_item in media_items:
                            if not isinstance(media_item, dict):
                                continue
                            media_id = str(
                                media_item.get("mediaId")
                                or media_item.get("media_id")
                                or ""
                            ).strip()
                            media_entity = media_lookup.get(media_id)
                            if not isinstance(media_entity, dict):
                                continue
                            image_url = _extract_image_url_from_media_entity(media_entity)
                            media_info = (
                                media_entity.get("media_info")
                                if isinstance(media_entity.get("media_info"), dict)
                                else {}
                            )
                            width = _extract_int(
                                media_info.get("original_img_width")
                                if isinstance(media_info, dict)
                                else None
                            )
                            height = _extract_int(
                                media_info.get("original_img_height")
                                if isinstance(media_info, dict)
                                else None
                            )
                            _append_unique_image_block(
                                blocks,
                                seen_image_urls,
                                block_id=f"{block_id}-img",
                                image_url=image_url or "",
                                width=width,
                                height=height,
                                source="media_entity",
                            )
                    continue

                text_value = str(entry.get("text") or "")
                before_count = len(text_blocks)
                _append_unique_text(text_blocks, text_value)
                if len(text_blocks) == before_count:
                    continue
                blocks.append(
                    {
                        "id": block_id,
                        "type": str(entry.get("type") or "paragraph"),
                        "text": text_blocks[-1],
                    }
                )

        # article.content.blocks is usually the highest-quality canonical body.
        # preview_text is often truncated and duplicates the first block.
        if not text_blocks:
            _append_unique_text(text_blocks, str(article.get("preview_text") or ""))

    raw_text = tweet.get("raw_text") if isinstance(tweet.get("raw_text"), dict) else {}
    if not text_blocks:
        _append_unique_text(text_blocks, str(tweet.get("text") or raw_text.get("text") or ""))

    raw_content = "\n\n".join(item for item in text_blocks if item).strip()
    if len(raw_content) < 120:
        return None

    canonical_url = str(tweet.get("url") or source_url)
    author = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
    author_name = str(author.get("screen_name") or author.get("name") or "").strip()
    if not title:
        title = f"X post by @{author_name}" if author_name else "X post"

    return ExtractionCandidate(
        strategy_name="x_status_api",
        url=source_url,
        canonical_url=canonical_url,
        title=title,
        content_format="text",
        raw_content=raw_content,
        extraction_meta={
            "method": "x_status_api",
            "provider": "api.fxtwitter.com",
            "tweet_id": str(tweet.get("id") or ""),
            "author": author_name,
        },
        blocks=blocks or build_reader_blocks(raw_content),
    )


def _build_candidate_from_vxtwitter(
    source_url: str, payload: dict[str, Any]
) -> ExtractionCandidate | None:
    article = payload.get("article")
    text = normalize_text_preserve_paragraphs(str(payload.get("text") or ""))
    if not isinstance(article, dict):
        if len(text) < 120:
            return None
        return ExtractionCandidate(
            strategy_name="x_status_api",
            url=source_url,
            canonical_url=source_url,
            title=f"X post by @{payload.get('user_name') or payload.get('user_screen_name') or 'unknown'}",
            content_format="text",
            raw_content=text,
            extraction_meta={
                "method": "x_status_api",
                "provider": "api.vxtwitter.com",
                "tweet_id": str(payload.get("tweetID") or ""),
            },
            blocks=build_reader_blocks(text),
        )

    preview = normalize_text_preserve_paragraphs(str(article.get("preview_text") or ""))
    title = normalize_text_preserve_paragraphs(str(article.get("title") or ""))
    parts = [item for item in [title, preview, text] if item]
    raw_content = "\n\n".join(parts).strip()
    if len(raw_content) < 120:
        return None

    blocks = build_reader_blocks(raw_content)
    image_url = normalize_text_preserve_paragraphs(str(article.get("image") or ""))
    if image_url:
        blocks.insert(0, {
            "id": "vx-cover",
            "type": "image",
            "image_url": image_url,
            "source": "article.image",
        })

    return ExtractionCandidate(
        strategy_name="x_status_api",
        url=source_url,
        canonical_url=source_url,
        title=title or f"X post by @{payload.get('user_name') or payload.get('user_screen_name') or 'unknown'}",
        content_format="text",
        raw_content=raw_content,
        extraction_meta={
            "method": "x_status_api",
            "provider": "api.vxtwitter.com",
            "tweet_id": str(payload.get("tweetID") or ""),
        },
        blocks=blocks,
    )


class XStatusApiStrategy(ExtractorStrategy):
    name = "x_status_api"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        parsed = _parse_x_status_url(context.url)
        if not parsed:
            raise ValueError("URL is not an X/Twitter status link.")

        user, status_id = parsed
        path_prefix = f"/{user}/status/{status_id}" if user else f"/status/{status_id}"
        providers = [
            (
                "api.fxtwitter.com",
                f"https://api.fxtwitter.com{path_prefix}",
                _build_candidate_from_fxtwitter,
            ),
            (
                "api.vxtwitter.com",
                f"https://api.vxtwitter.com{path_prefix}",
                _build_candidate_from_vxtwitter,
            ),
        ]

        last_error: str | None = None
        timeout = max(6, min(context.timeout_seconds, 20))
        for provider_name, provider_url, builder in providers:
            try:
                response = requests.get(
                    provider_url,
                    timeout=timeout,
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                response.raise_for_status()
                payload = response.json()
                candidate = builder(context.url, payload)
                if candidate:
                    candidate.raw_content = candidate.raw_content[: context.max_chars]
                    candidate.extraction_meta = {
                        **candidate.extraction_meta,
                        "provider_url": provider_url,
                    }
                    return candidate
                last_error = f"{provider_name} returned no usable content"
            except Exception as exc:
                last_error = f"{provider_name} failed: {exc}"

        raise ValueError(last_error or "X status API extraction failed.")


class DomainAdapterStrategy(ExtractorStrategy):
    name = "domain_adapter"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        page = self._get_page(context)
        host = urlparse(page.final_url or context.url).netloc.lower()
        adapter = get_adapter_for_host(host)
        if not adapter:
            raise ValueError("No domain adapter configured for host.")

        payload = page.payload or ""
        selected_fragments: list[str] = []
        for pattern in adapter.html_container_patterns:
            for match in re.finditer(pattern, payload, flags=re.IGNORECASE | re.DOTALL):
                fragment = (match.group(1) or "").strip()
                if fragment:
                    selected_fragments.append(fragment)

        if not selected_fragments:
            raise ValueError(f"Adapter {adapter.name} found no matching containers.")

        text_candidates = [strip_html_to_text(fragment) for fragment in selected_fragments]
        raw_content = max(text_candidates, key=len).strip()
        if not raw_content:
            raise ValueError(f"Adapter {adapter.name} produced empty content.")

        for pattern in adapter.drop_text_patterns:
            raw_content = re.sub(pattern, "", raw_content, flags=re.IGNORECASE)

        raw_content = normalize_text_preserve_paragraphs(raw_content)
        if len(raw_content) < 120:
            raise ValueError(f"Adapter {adapter.name} content too short.")

        title = extract_title(payload)
        canonical_url = extract_canonical_url(payload, page.final_url or context.url)
        return ExtractionCandidate(
            strategy_name=self.name,
            url=canonical_url,
            canonical_url=canonical_url,
            title=title,
            content_format="text",
            raw_content=raw_content[: context.max_chars],
            extraction_meta={
                "method": "domain_adapter",
                "adapter_name": adapter.name,
                "host": host,
                "content_type": page.content_type,
            },
            blocks=build_reader_blocks(raw_content),
        )


class ArxivHtmlStrategy(ExtractorStrategy):
    name = "arxiv_html"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        if not _is_arxiv_url(context.url):
            raise ValueError("URL is not an arXiv host.")

        page = self._get_page(context)
        final_url = page.final_url or context.url
        parsed = urlparse(final_url)
        if not _is_arxiv_url(final_url):
            raise ValueError("URL is not an arXiv host.")
        if not _ARXIV_HTML_PATH_REGEX.search(parsed.path or ""):
            raise ValueError("URL is not an arXiv HTML document path.")
        if is_binary_content_type(page.content_type):
            raise ValueError("arXiv URL returned binary content instead of HTML.")

        payload = page.payload or ""
        if "<html" not in payload.lower():
            raise ValueError("arXiv HTML payload is empty or malformed.")

        structured_content = extract_arxiv_structured_content(
            page_html=payload,
            base_url=final_url,
            max_chars=context.max_chars,
        )
        raw_content = structured_content.raw_content
        if len(raw_content) < 120:
            raise ValueError("arXiv HTML extraction produced insufficient readable content.")

        title = extract_title(payload)
        canonical_url = extract_canonical_url(payload, final_url)
        blocks = structured_content.blocks or build_reader_blocks(raw_content)

        return ExtractionCandidate(
            strategy_name=self.name,
            url=canonical_url,
            canonical_url=canonical_url,
            title=title,
            content_format="text",
            raw_content=raw_content[: context.max_chars],
            extraction_meta={
                "method": "arxiv_html",
                "host": parsed.netloc.lower(),
                "content_type": page.content_type,
                "block_counts": structured_content.block_counts,
            },
            blocks=blocks,
        )


def _iter_json_candidates(payload: str) -> list[dict[str, Any]]:
    decoded: list[dict[str, Any]] = []
    for match in JSONLD_SCRIPT_REGEX.finditer(payload or ""):
        script_body = (match.group(1) or "").strip()
        if not script_body:
            continue
        try:
            parsed = json.loads(script_body)
            if isinstance(parsed, dict):
                decoded.append(parsed)
            elif isinstance(parsed, list):
                decoded.extend(item for item in parsed if isinstance(item, dict))
        except json.JSONDecodeError:
            continue
    return decoded


def _find_long_text_field(node: Any) -> Optional[str]:
    if isinstance(node, dict):
        interesting_keys = ("articleBody", "text", "description")
        for key in interesting_keys:
            value = node.get(key)
            if isinstance(value, str) and len(value.strip()) >= 120:
                return value
        for value in node.values():
            nested = _find_long_text_field(value)
            if nested:
                return nested
    elif isinstance(node, list):
        for item in node:
            nested = _find_long_text_field(item)
            if nested:
                return nested
    return None


class JsonLdStrategy(ExtractorStrategy):
    name = "json_ld"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        page = self._get_page(context)
        payload = page.payload or ""

        json_candidates = _iter_json_candidates(payload)
        if not json_candidates:
            raise ValueError("No JSON-LD payload found.")

        best_text: Optional[str] = None
        title: Optional[str] = None
        for candidate in json_candidates:
            if not title:
                for title_key in ("headline", "name", "title"):
                    if isinstance(candidate.get(title_key), str):
                        title = str(candidate.get(title_key))
                        break
            text = _find_long_text_field(candidate)
            if text and (best_text is None or len(text) > len(best_text)):
                best_text = text

        if not best_text:
            raise ValueError("JSON-LD did not contain a usable article body.")

        raw_content = normalize_text_preserve_paragraphs(best_text)
        if len(raw_content) < 120:
            raise ValueError("JSON-LD content too short.")

        return ExtractionCandidate(
            strategy_name=self.name,
            url=context.url,
            canonical_url=extract_canonical_url(payload, page.final_url or context.url),
            title=title or extract_title(payload),
            content_format="text",
            raw_content=raw_content[: context.max_chars],
            extraction_meta={
                "method": "json_ld",
                "host": urlparse(page.final_url or context.url).netloc,
                "content_type": page.content_type,
            },
            blocks=build_reader_blocks(raw_content),
        )


class HttpReadabilityStrategy(ExtractorStrategy):
    name = "http_readability"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        page = self._get_page(context)
        payload = page.payload or ""
        content_type = page.content_type or ""

        if is_binary_content_type(content_type):
            raise ValueError("Binary payload cannot be extracted as readable article text.")

        if is_probably_blocked_page(payload, content_type):
            raise ValueError("Page appears to be blocked by anti-bot protections.")

        if "text/html" in content_type or "<html" in payload.lower():
            fragments = extract_primary_html_candidates(payload)
            text_candidates = [strip_html_to_text(fragment) for fragment in fragments]
            raw_content = max(text_candidates, key=len).strip() if text_candidates else ""
            title = extract_title(payload)
            canonical_url = extract_canonical_url(payload, page.final_url or context.url)
            content_format = "text"
        else:
            raw_content = normalize_text_preserve_paragraphs(payload)
            title = None
            canonical_url = page.final_url or context.url
            content_format = "text"

        if len(raw_content) < 120:
            raise ValueError("Could not extract enough readable article content from URL.")

        return ExtractionCandidate(
            strategy_name=self.name,
            url=context.url,
            canonical_url=canonical_url,
            title=title,
            content_format=content_format,
            raw_content=raw_content[: context.max_chars],
            extraction_meta={
                "method": "http_readability",
                "host": urlparse(page.final_url or context.url).netloc,
                "content_type": content_type,
            },
            blocks=build_reader_blocks(raw_content),
        )


class LlmAdaptiveStrategy(ExtractorStrategy):
    name = "llm_adaptive"

    def extract(self, context: ExtractionContext) -> ExtractionCandidate:
        page = self._get_page(context)
        payload = page.payload or ""
        host = urlparse(page.final_url or context.url).netloc.lower()
        content_type = page.content_type or ""

        record_rule_replay_sample(
            host,
            url=page.final_url or context.url,
            content_type=content_type,
            payload=payload,
        )

        cached_rule = get_cached_rule(host)
        if cached_rule:
            try:
                candidate = apply_rule(
                    url=context.url,
                    payload=payload,
                    content_type=content_type,
                    rule=cached_rule,
                    generated=False,
                    max_chars=context.max_chars,
                )
                return candidate
            except Exception:
                # Continue to generated-rule attempt below.
                pass

        generated_rule = synthesize_rule(host=host, url=context.url, payload=payload)
        if not generated_rule:
            raise ValueError("No valid LLM adaptive rule available.")

        candidate = apply_rule(
            url=context.url,
            payload=payload,
            content_type=content_type,
            rule=generated_rule,
            generated=True,
            max_chars=context.max_chars,
        )
        promotion = evaluate_and_promote_rule(host, generated_rule, max_chars=context.max_chars)
        candidate.extraction_meta = {
            **candidate.extraction_meta,
            "promotion": promotion,
        }
        return candidate
