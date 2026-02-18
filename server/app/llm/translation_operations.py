import difflib
import hashlib
import json
import logging
import os
import re
import threading
import time
from typing import Any, Optional, Type
from uuid import UUID

from app.database.crud.paper_crud import paper_crud
from app.database.crud.translation_usage_crud import translation_usage_crud
from app.database.models import Paper
from app.database.telemetry import track_event
from app.llm.base import BaseLLMClient, ModelType
from app.llm.json_parser import JSONParser
from app.llm.prompts import (
    SELECTION_TRANSLATION_FORMULA_USER_PROMPT,
    SELECTION_TRANSLATION_SENTENCE_USER_PROMPT,
    SELECTION_TRANSLATION_SYSTEM_PROMPT,
    SELECTION_TRANSLATION_WORD_USER_PROMPT,
)
from app.llm.provider import LLMProvider
from app.llm.utils import find_offsets
from pydantic import BaseModel
from app.schemas.translation import (
    FormulaTranslationOutput,
    SelectionTypeHint,
    SentenceTranslationOutput,
    TranslateSelectionResponse,
    TranslationMeta,
    TranslationMode,
    WordTranslationOutput,
)
from app.schemas.user import CurrentUser
from sqlalchemy.orm import Session

try:
    import redis
except ImportError:
    redis = None

logger = logging.getLogger(__name__)


class TranslationInputError(ValueError):
    """Raised for client-correctable translation request issues."""


class TranslationOperations:
    def __init__(self):
        self.llm_client = BaseLLMClient(default_provider=LLMProvider.GEMINI)
        self._memory_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._cache_lock = threading.Lock()
        self.cache_ttl_seconds = int(os.getenv("TRANSLATION_CACHE_TTL_SECONDS", "86400"))
        self.redis_prefix = "translation:v2:"
        self._redis_client = self._build_redis_client()

    def _build_redis_client(self):
        redis_url = os.getenv("REDIS_URL")
        if not redis_url or redis is None:
            return None

        try:
            client = redis.Redis.from_url(redis_url, decode_responses=True)
            client.ping()
            return client
        except Exception as e:
            logger.warning(f"Redis not available for translation cache: {e}")
            return None

    def _can_use_openai_fallback(self) -> bool:
        api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        if not api_key:
            return False
        if api_key.startswith("your_"):
            return False
        return True

    def _normalize_for_cache(self, text: str) -> str:
        return re.sub(r"\s+", " ", text).strip().lower()

    def _cache_key(
        self,
        paper_id: str,
        selected_text: str,
        mode: TranslationMode,
        target_language: str,
        context_before: str,
        context_after: str,
    ) -> str:
        context_hash = hashlib.sha256(
            f"{context_before}|{context_after}".encode("utf-8")
        ).hexdigest()[:16]
        base = "|".join(
            [
                paper_id,
                self._normalize_for_cache(selected_text),
                mode.value,
                target_language,
                context_hash,
            ]
        )
        return hashlib.sha256(base.encode("utf-8")).hexdigest()

    def _get_cache(self, key: str) -> Optional[dict[str, Any]]:
        now = time.time()
        with self._cache_lock:
            payload = self._memory_cache.get(key)
            if payload:
                expires_at, data = payload
                if now < expires_at:
                    return data
                self._memory_cache.pop(key, None)

        if not self._redis_client:
            return None

        try:
            cached = self._redis_client.get(f"{self.redis_prefix}{key}")
            if not cached:
                return None
            data = json.loads(cached)
            with self._cache_lock:
                self._memory_cache[key] = (now + self.cache_ttl_seconds, data)
            return data
        except Exception as e:
            logger.warning(f"Failed to read translation cache: {e}")
            return None

    def _set_cache(self, key: str, value: dict[str, Any]) -> None:
        now = time.time()
        with self._cache_lock:
            self._memory_cache[key] = (now + self.cache_ttl_seconds, value)

        if not self._redis_client:
            return

        try:
            self._redis_client.set(
                f"{self.redis_prefix}{key}",
                json.dumps(value, ensure_ascii=False),
                ex=self.cache_ttl_seconds,
            )
        except Exception as e:
            logger.warning(f"Failed to write translation cache: {e}")

    def _is_formula(self, text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return False

        # Common explicit math/formula patterns should be treated as formula directly.
        if re.match(r"^[Oo]\s*\([^)]*\)$", stripped):
            return True
        if re.search(r"(\\[a-zA-Z]+)|(_\{?.+\}?|\^\{?.+\}?)", stripped):
            return True

        math_chars = len(
            re.findall(r"[=+\-*/^_{}\\[\]<>≈≤≥∑∫√∞→←×÷]", stripped)
        )
        alnum_chars = len(re.findall(r"[A-Za-z0-9]", text))
        if math_chars >= 2 and math_chars >= max(1, alnum_chars // 3):
            return True
        return False

    def _classify_mode(
        self, text: str, selection_type_hint: SelectionTypeHint
    ) -> TranslationMode:
        if selection_type_hint != SelectionTypeHint.AUTO:
            return TranslationMode(selection_type_hint.value)

        normalized = text.strip()
        if self._is_formula(normalized):
            return TranslationMode.FORMULA

        tokens = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+", normalized)
        has_terminal_punct = bool(re.search(r"[.!?;:]$", normalized))

        if len(tokens) == 1 and not has_terminal_punct and len(normalized) <= 40:
            return TranslationMode.WORD

        if len(tokens) <= 4 and not has_terminal_punct and len(normalized) <= 60:
            return TranslationMode.TERM

        return TranslationMode.SENTENCE

    def _page_range(
        self, paper: Paper, page_number: Optional[int]
    ) -> Optional[tuple[int, int]]:
        if not page_number or not paper.page_offset_map:
            return None

        page_key = str(page_number)
        offsets = paper.page_offset_map.get(page_key) or paper.page_offset_map.get(
            page_number
        )
        if not offsets or not isinstance(offsets, list) or len(offsets) != 2:
            return None

        start, end = offsets
        if not isinstance(start, int) or not isinstance(end, int):
            return None
        if start < 0 or end <= start:
            return None
        return start, end

    def _match_selected_text(
        self,
        full_text: str,
        selected_text: str,
        span_hint: Optional[tuple[int, int]],
        context_before_hint: Optional[str],
        context_after_hint: Optional[str],
    ) -> tuple[int, int, float, dict[str, Any]]:
        if not full_text or not selected_text:
            return -1, -1, 0.0, {
                "strategy": "empty_input",
                "candidate_count": 0,
                "best_context_match": 0.0,
            }

        query = selected_text.strip()
        if not query:
            return -1, -1, 0.0, {
                "strategy": "empty_query",
                "candidate_count": 0,
                "best_context_match": 0.0,
            }

        normalized_before_hint = self._normalize_for_cache(context_before_hint or "")
        normalized_after_hint = self._normalize_for_cache(context_after_hint or "")

        def find_all(text: str, needle: str, ignore_case: bool = False) -> list[int]:
            if not text or not needle:
                return []
            working = text.lower() if ignore_case else text
            target = needle.lower() if ignore_case else needle
            starts: list[int] = []
            cursor = 0
            while True:
                idx = working.find(target, cursor)
                if idx < 0:
                    break
                starts.append(idx)
                cursor = idx + max(1, len(target))
                if len(starts) >= 64:
                    break
            return starts

        def suffix_similarity(candidate_before: str, hint_before: str) -> float:
            if not hint_before:
                return 0.0
            candidate = self._normalize_for_cache(candidate_before)
            hint = self._normalize_for_cache(hint_before)
            if not candidate or not hint:
                return 0.0
            candidate_tail = candidate[-180:]
            hint_tail = hint[-180:]
            if not candidate_tail or not hint_tail:
                return 0.0
            return difflib.SequenceMatcher(None, candidate_tail, hint_tail).ratio()

        def prefix_similarity(candidate_after: str, hint_after: str) -> float:
            if not hint_after:
                return 0.0
            candidate = self._normalize_for_cache(candidate_after)
            hint = self._normalize_for_cache(hint_after)
            if not candidate or not hint:
                return 0.0
            candidate_head = candidate[:180]
            hint_head = hint[:180]
            if not candidate_head or not hint_head:
                return 0.0
            return difflib.SequenceMatcher(None, candidate_head, hint_head).ratio()

        candidate_scores: dict[int, tuple[float, str]] = {}

        def add_candidates(
            starts: list[int], offset: int, base_quality: float, source: str
        ) -> None:
            for start in starts:
                absolute_start = offset + start
                previous = candidate_scores.get(absolute_start)
                if not previous or base_quality > previous[0]:
                    candidate_scores[absolute_start] = (base_quality, source)

        if span_hint:
            start_hint, end_hint = span_hint
            scoped_text = full_text[start_hint:end_hint]
            add_candidates(
                find_all(scoped_text, query),
                start_hint,
                0.97,
                "scoped_exact",
            )
            add_candidates(
                find_all(scoped_text, query, ignore_case=True),
                start_hint,
                0.93,
                "scoped_case_insensitive",
            )

        add_candidates(find_all(full_text, query), 0, 0.9, "global_exact")
        add_candidates(
            find_all(full_text, query, ignore_case=True), 0, 0.86, "global_case_insensitive"
        )

        if candidate_scores:
            best_start = -1
            best_end = -1
            best_quality = 0.0
            best_context_match = 0.0
            best_source = "unknown"
            context_window = 240
            for start, (base_quality, source) in candidate_scores.items():
                end = start + len(query)
                candidate_before = full_text[max(0, start - context_window) : start]
                candidate_after = full_text[end : min(len(full_text), end + context_window)]

                context_points = 0.0
                context_weights = 0.0
                if normalized_before_hint:
                    context_points += suffix_similarity(candidate_before, normalized_before_hint)
                    context_weights += 1.0
                if normalized_after_hint:
                    context_points += prefix_similarity(candidate_after, normalized_after_hint)
                    context_weights += 1.0
                context_match = (
                    (context_points / context_weights) if context_weights > 0 else 0.0
                )
                context_bonus = context_match * 0.18

                quality = min(0.99, base_quality + context_bonus)
                if quality > best_quality + 1e-6 or (
                    abs(quality - best_quality) <= 1e-6
                    and context_match > best_context_match
                ):
                    best_quality = quality
                    best_context_match = context_match
                    best_source = source
                    best_start = start
                    best_end = end

            if best_start >= 0:
                return best_start, best_end, best_quality, {
                    "strategy": "candidate_selection",
                    "candidate_count": len(candidate_scores),
                    "best_context_match": round(best_context_match, 3),
                    "best_source": best_source,
                }

        # Fuzzy fallback for shorter papers where exact matching fails due formatting artifacts.
        if span_hint:
            start_hint, end_hint = span_hint
            scoped_text = full_text[start_hint:end_hint]
            fuzzy_start, fuzzy_end = find_offsets(query, scoped_text)
            if fuzzy_start >= 0 and fuzzy_end > fuzzy_start:
                return start_hint + fuzzy_start, start_hint + fuzzy_end, 0.72, {
                    "strategy": "scoped_fuzzy",
                    "candidate_count": len(candidate_scores),
                    "best_context_match": 0.0,
                }

        if len(full_text) <= 250_000:
            fuzzy_start, fuzzy_end = find_offsets(query, full_text)
            if fuzzy_start >= 0 and fuzzy_end > fuzzy_start:
                return fuzzy_start, fuzzy_end, 0.7, {
                    "strategy": "global_fuzzy",
                    "candidate_count": len(candidate_scores),
                    "best_context_match": 0.0,
                }

        return -1, -1, 0.0, {
            "strategy": "not_found",
            "candidate_count": len(candidate_scores),
            "best_context_match": 0.0,
        }

    def _resolve_context(
        self,
        paper: Paper,
        selected_text: str,
        page_number: Optional[int],
        mode: TranslationMode,
        fallback_before: Optional[str],
        fallback_after: Optional[str],
    ) -> tuple[str, str, float, dict[str, Any]]:
        raw_text = str(paper.raw_content or "")
        if not raw_text:
            return fallback_before or "", fallback_after or "", 0.2, {
                "strategy": "no_raw_text",
                "candidate_count": 0,
                "best_context_match": 0.0,
            }

        match_start, match_end, quality, match_meta = self._match_selected_text(
            raw_text,
            selected_text,
            self._page_range(paper, page_number),
            fallback_before,
            fallback_after,
        )

        if match_start < 0:
            return (
                fallback_before or "",
                fallback_after or "",
                max(quality, 0.25),
                match_meta,
            )

        window = 180 if mode in {TranslationMode.WORD, TranslationMode.TERM} else 320
        before = raw_text[max(0, match_start - window) : match_start].strip()
        after = raw_text[match_end : min(len(raw_text), match_end + window)].strip()
        return before, after, quality, match_meta

    def _build_prompt(
        self,
        mode: TranslationMode,
        selected_text: str,
        target_language: str,
        paper_title: str,
        context_before: str,
        context_after: str,
    ) -> tuple[str, Any]:
        if mode in {TranslationMode.WORD, TranslationMode.TERM}:
            prompt = SELECTION_TRANSLATION_WORD_USER_PROMPT.format(
                mode=mode.value,
                selected_text=selected_text,
                target_language=target_language,
                paper_title=paper_title or "",
                context_before=context_before or "",
                context_after=context_after or "",
            )
            return prompt, WordTranslationOutput

        if mode == TranslationMode.SENTENCE:
            prompt = SELECTION_TRANSLATION_SENTENCE_USER_PROMPT.format(
                mode=mode.value,
                selected_text=selected_text,
                target_language=target_language,
                paper_title=paper_title or "",
                context_before=context_before or "",
                context_after=context_after or "",
            )
            return prompt, SentenceTranslationOutput

        prompt = SELECTION_TRANSLATION_FORMULA_USER_PROMPT.format(
            mode=mode.value,
            selected_text=selected_text,
            target_language=target_language,
            paper_title=paper_title or "",
            context_before=context_before or "",
            context_after=context_after or "",
        )
        return prompt, FormulaTranslationOutput

    def _schema_for_llm(self, output_model: Type[BaseModel]) -> dict[str, Any]:
        """
        Build a provider-friendly JSON schema.
        Gemini's current schema parser rejects `additionalProperties`, so remove it
        recursively while keeping structural fields.
        """
        schema = output_model.model_json_schema()

        def clean(node: Any) -> Any:
            if isinstance(node, dict):
                cleaned: dict[str, Any] = {}
                for key, value in node.items():
                    if key == "additionalProperties":
                        continue
                    cleaned[key] = clean(value)
                return cleaned
            if isinstance(node, list):
                return [clean(item) for item in node]
            return node

        return clean(schema)

    def _confidence_from_mode_and_context(
        self, mode: TranslationMode, context_quality: float
    ) -> float:
        base = 0.78
        if mode == TranslationMode.SENTENCE:
            base = 0.82
        if mode == TranslationMode.FORMULA:
            base = 0.74
        return round(min(0.99, max(0.4, base + (context_quality - 0.5) * 0.3)), 2)

    def translate_selection(
        self,
        *,
        db: Session,
        current_user: CurrentUser,
        paper_id: str,
        selected_text: str,
        page_number: Optional[int],
        selection_type_hint: SelectionTypeHint,
        context_before: Optional[str],
        context_after: Optional[str],
        target_language: str,
    ) -> TranslateSelectionResponse:
        start_time = time.time()
        paper = paper_crud.get(db, id=paper_id, user=current_user)
        if not paper:
            raise TranslationInputError("Paper not found.")

        cleaned_text = re.sub(r"\s+", " ", selected_text).strip()
        mode = self._classify_mode(cleaned_text, selection_type_hint)
        resolved_before, resolved_after, context_quality, context_match_meta = (
            self._resolve_context(
            paper,
            cleaned_text,
            page_number,
            mode,
            context_before,
            context_after,
        ))
        cache_key = self._cache_key(
            paper_id=paper_id,
            selected_text=cleaned_text,
            mode=mode,
            target_language=target_language,
            context_before=resolved_before,
            context_after=resolved_after,
        )
        track_event(
            "selection_translation_context_resolved",
            properties={
                "mode": mode.value,
                "context_relevance_score": round(context_quality, 2),
                "match_strategy": context_match_meta.get("strategy"),
                "match_candidate_count": context_match_meta.get("candidate_count", 0),
                "match_best_source": context_match_meta.get("best_source"),
                "match_best_context": context_match_meta.get("best_context_match", 0.0),
            },
            user_id=str(current_user.id),
        )

        cached = self._get_cache(cache_key)
        if cached:
            elapsed = int((time.time() - start_time) * 1000)
            cached_meta = cached.get("meta", {})
            cached_meta["cached"] = True
            cached_meta["latency_ms"] = elapsed
            cached["meta"] = cached_meta
            track_event(
                "selection_translation_cache_hit",
                properties={
                    "mode": mode.value,
                    "latency_ms": elapsed,
                },
                user_id=str(current_user.id),
            )
            return TranslateSelectionResponse.model_validate(cached)

        user_prompt, output_model = self._build_prompt(
            mode=mode,
            selected_text=cleaned_text,
            target_language=target_language,
            paper_title=str(paper.title or ""),
            context_before=resolved_before,
            context_after=resolved_after,
        )

        try:
            llm_response = self.llm_client.generate_content_resilient(
                contents=user_prompt,
                system_prompt=SELECTION_TRANSLATION_SYSTEM_PROMPT,
                model_type=ModelType.FAST,
                enable_thinking=False,
                schema=self._schema_for_llm(output_model),
                max_retries=1,
            )
        except Exception:
            if not self._can_use_openai_fallback():
                raise

            logger.warning(
                "Primary translation provider failed; falling back to OpenAI provider."
            )
            llm_response = self.llm_client.generate_content_resilient(
                contents=user_prompt,
                system_prompt=SELECTION_TRANSLATION_SYSTEM_PROMPT,
                model_type=ModelType.FAST,
                enable_thinking=False,
                schema=self._schema_for_llm(output_model),
                provider=LLMProvider.OPENAI,
                max_retries=1,
            )

        parsed_json = JSONParser.validate_and_extract_json(llm_response.text)
        validated_output = output_model.model_validate(parsed_json)

        elapsed = int((time.time() - start_time) * 1000)
        response = TranslateSelectionResponse(
            mode=mode,
            detected_mode=mode,
            source_text=cleaned_text,
            target_language=target_language,
            result=validated_output.model_dump(),
            meta=TranslationMeta(
                confidence=self._confidence_from_mode_and_context(mode, context_quality),
                context_relevance_score=round(context_quality, 2),
                cached=False,
                latency_ms=elapsed,
            ),
        )

        payload = response.model_dump()
        try:
            translation_usage_crud.create_usage(
                db,
                user=current_user,
                paper_id=UUID(str(paper.id)),
                mode=mode.value,
                source_chars=len(cleaned_text),
                context_chars=len(resolved_before) + len(resolved_after),
                output_chars=len(
                    json.dumps(validated_output.model_dump(), ensure_ascii=False)
                ),
                cached=False,
            )
        except Exception as usage_error:
            logger.warning(f"Failed to record translation usage: {usage_error}")

        self._set_cache(cache_key, payload)
        track_event(
            "selection_translation_succeeded",
            properties={
                "mode": mode.value,
                "latency_ms": elapsed,
                "context_relevance_score": round(context_quality, 2),
                "target_language": target_language,
            },
            user_id=str(current_user.id),
        )
        return response


translation_operations = TranslationOperations()
