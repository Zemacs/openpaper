import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlparse

from src.web_extract.html_utils import (
    build_reader_blocks,
    extract_canonical_url,
    extract_title,
    normalize_text_preserve_paragraphs,
    strip_html_to_text,
)
from src.web_extract.models import ExtractionCandidate
from src.web_extract.rules_store import (
    get_generated_rule,
    get_promoted_adapter_for_host,
    get_replay_samples,
    record_replay_sample,
    save_generated_rule,
    save_promoted_adapter,
)
from src.web_extract.scoring import score_candidate

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %s", name, raw, default)
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %s", name, raw, default)
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


LLM_ADAPTER_ENABLED = _env_bool("WEB_EXTRACTION_LLM_ADAPTER_ENABLED", True)
LLM_ADAPTER_MODEL = os.getenv("WEB_EXTRACTION_RULE_MODEL", "gemini-2.5-flash")
LLM_ADAPTER_TIMEOUT_MS = _env_int("WEB_EXTRACTION_RULE_TIMEOUT_MS", 20_000)
LLM_ADAPTER_MAX_HTML_CHARS = _env_int("WEB_EXTRACTION_RULE_MAX_HTML_CHARS", 80_000)
LLM_ADAPTER_MIN_CONFIDENCE = _env_float("WEB_EXTRACTION_RULE_MIN_CONFIDENCE", 0.45)
LLM_ADAPTER_CACHE_SIZE = _env_int("WEB_EXTRACTION_RULE_CACHE_SIZE", 200)
LLM_ADAPTER_CACHE_TTL_SECONDS = _env_int("WEB_EXTRACTION_RULE_CACHE_TTL_SECONDS", 86_400)
LLM_PROMOTION_ENABLED = _env_bool("WEB_EXTRACTION_PROMOTION_ENABLED", True)
LLM_PROMOTION_MIN_SAMPLES = _env_int("WEB_EXTRACTION_PROMOTION_MIN_SAMPLES", 3)
LLM_PROMOTION_MAX_SAMPLES = _env_int("WEB_EXTRACTION_PROMOTION_MAX_SAMPLES", 6)
LLM_PROMOTION_MIN_SUCCESS_RATE = _env_float(
    "WEB_EXTRACTION_PROMOTION_MIN_SUCCESS_RATE", 0.8
)
LLM_PROMOTION_MIN_AVG_SCORE = _env_float("WEB_EXTRACTION_PROMOTION_MIN_AVG_SCORE", 0.72)
LLM_PROMOTION_MIN_SAMPLE_SCORE = _env_float(
    "WEB_EXTRACTION_PROMOTION_MIN_SAMPLE_SCORE", 0.60
)


@dataclass
class AdaptiveRule:
    host: str
    container_regexes: list[str]
    drop_text_patterns: list[str]
    confidence: float
    model: str
    generated_at: float


_RULE_CACHE: dict[str, AdaptiveRule] = {}


def _extract_json_block(raw: str) -> dict:
    payload = (raw or "").strip()
    if not payload:
        raise ValueError("empty model output")
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        pass

    fenced = re.findall(r"```(?:json)?\s*([\s\S]*?)```", payload, flags=re.IGNORECASE)
    for candidate in fenced:
        candidate = candidate.strip()
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("model did not return valid JSON")


def _cache_get(host: str) -> Optional[AdaptiveRule]:
    rule = _RULE_CACHE.get(host)
    if not rule:
        return None
    if (time.time() - rule.generated_at) > LLM_ADAPTER_CACHE_TTL_SECONDS:
        _RULE_CACHE.pop(host, None)
        return None
    return rule


def _from_payload(host: str, payload: dict[str, Any]) -> Optional[AdaptiveRule]:
    try:
        container_regexes = [
            item
            for item in payload.get("container_regexes", [])
            if isinstance(item, str) and item.strip()
        ][:5]
        if not container_regexes:
            return None

        drop_text_patterns = [
            item
            for item in payload.get("drop_text_patterns", [])
            if isinstance(item, str) and item.strip()
        ][:10]
        return AdaptiveRule(
            host=host,
            container_regexes=container_regexes,
            drop_text_patterns=drop_text_patterns,
            confidence=float(payload.get("confidence", payload.get("source_confidence", 0.0))),
            model=str(payload.get("model", payload.get("source_model", LLM_ADAPTER_MODEL))),
            generated_at=float(payload.get("generated_at", time.time())),
        )
    except Exception:
        return None


def get_cached_rule(host: str) -> Optional[AdaptiveRule]:
    lowered = (host or "").strip().lower()
    if not lowered:
        return None

    cached = _cache_get(lowered)
    if cached:
        return cached

    stored = get_generated_rule(lowered)
    if not stored:
        return None
    restored = _from_payload(lowered, stored)
    if restored:
        _cache_put(restored)
    return restored


def _cache_put(rule: AdaptiveRule) -> None:
    _RULE_CACHE[rule.host] = rule
    if len(_RULE_CACHE) <= LLM_ADAPTER_CACHE_SIZE:
        return
    oldest_key = min(_RULE_CACHE.keys(), key=lambda key: _RULE_CACHE[key].generated_at)
    _RULE_CACHE.pop(oldest_key, None)


def _generate_rule_prompt(url: str, host: str, html_sample: str) -> str:
    return f"""
You are an expert web content extraction engineer.
You need to create robust parsing rules for the host: {host}
URL: {url}

Return ONLY valid JSON with this exact schema:
{{
  "container_regexes": ["..."],
  "drop_text_patterns": ["..."],
  "confidence": 0.0
}}

Constraints:
- container_regexes: 1-5 regex patterns. Prefer non-greedy patterns. Include a capture group for main content.
- drop_text_patterns: 0-10 regex patterns to remove boilerplate.
- confidence: 0-1 float indicating reliability.
- Do NOT include explanation text.

The HTML sample is truncated:
{html_sample}
""".strip()


def synthesize_rule(host: str, url: str, payload: str) -> Optional[AdaptiveRule]:
    if not LLM_ADAPTER_ENABLED:
        return None

    lowered_host = (host or "").strip().lower()
    if not lowered_host:
        return None

    cached = get_cached_rule(lowered_host)
    if cached:
        return cached

    if not payload:
        return None

    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None

    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        logger.warning("LLM adaptive strategy unavailable: %s", exc)
        return None

    html_sample = (payload or "")[:LLM_ADAPTER_MAX_HTML_CHARS]
    prompt = _generate_rule_prompt(url=url, host=host, html_sample=html_sample)

    try:
        client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=LLM_ADAPTER_TIMEOUT_MS),
        )
        response = client.models.generate_content(  # type: ignore[attr-defined]
            model=LLM_ADAPTER_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
        text = getattr(response, "text", "") or ""
        parsed = _extract_json_block(text)

        container_regexes = [
            pattern.strip()
            for pattern in parsed.get("container_regexes", [])
            if isinstance(pattern, str) and pattern.strip()
        ][:5]
        drop_text_patterns = [
            pattern.strip()
            for pattern in parsed.get("drop_text_patterns", [])
            if isinstance(pattern, str) and pattern.strip()
        ][:10]
        confidence = float(parsed.get("confidence", 0.0))

        if not container_regexes:
            return None
        if confidence < LLM_ADAPTER_MIN_CONFIDENCE:
            logger.info("LLM adaptive rule for host %s rejected, confidence %.3f", lowered_host, confidence)
            return None

        rule = AdaptiveRule(
            host=lowered_host,
            container_regexes=container_regexes,
            drop_text_patterns=drop_text_patterns,
            confidence=confidence,
            model=LLM_ADAPTER_MODEL,
            generated_at=time.time(),
        )
        _cache_put(rule)
        save_generated_rule(
            lowered_host,
            {
                "container_regexes": rule.container_regexes,
                "drop_text_patterns": rule.drop_text_patterns,
                "confidence": rule.confidence,
                "model": rule.model,
                "generated_at": rule.generated_at,
            },
        )
        return rule
    except Exception as exc:
        logger.warning("Failed to synthesize adaptive rule for host %s: %s", lowered_host, exc)
        return None


def record_rule_replay_sample(host: str, *, url: str, content_type: str, payload: str) -> None:
    lowered = (host or "").strip().lower()
    if not lowered:
        return
    record_replay_sample(
        lowered,
        url=url,
        content_type=content_type or "",
        payload=payload or "",
    )


def evaluate_and_promote_rule(host: str, rule: AdaptiveRule, *, max_chars: int) -> dict[str, Any]:
    lowered = (host or "").strip().lower()
    if not lowered:
        return {"promoted": False, "reason": "invalid_host"}

    if not LLM_PROMOTION_ENABLED:
        return {"promoted": False, "reason": "promotion_disabled"}

    existing_promoted = get_promoted_adapter_for_host(lowered)
    if existing_promoted:
        return {"promoted": False, "reason": "already_promoted"}

    samples = get_replay_samples(lowered, limit=LLM_PROMOTION_MAX_SAMPLES)
    if len(samples) < LLM_PROMOTION_MIN_SAMPLES:
        return {
            "promoted": False,
            "reason": "insufficient_samples",
            "sample_count": len(samples),
        }

    successful = 0
    scores: list[float] = []
    errors = 0

    for sample in samples:
        try:
            candidate = apply_rule(
                url=str(sample.get("url", "")),
                payload=str(sample.get("payload", "")),
                content_type=str(sample.get("content_type", "")),
                rule=rule,
                generated=False,
                max_chars=max_chars,
            )
            score_result = score_candidate(candidate)
            scores.append(score_result.score)
            if score_result.score >= LLM_PROMOTION_MIN_SAMPLE_SCORE:
                successful += 1
        except Exception:
            errors += 1

    sample_count = len(samples)
    success_rate = successful / max(1, sample_count)
    avg_score = (sum(scores) / len(scores)) if scores else 0.0
    promoted = (
        success_rate >= LLM_PROMOTION_MIN_SUCCESS_RATE
        and avg_score >= LLM_PROMOTION_MIN_AVG_SCORE
    )

    evaluation = {
        "promoted": promoted,
        "sample_count": sample_count,
        "successful": successful,
        "errors": errors,
        "success_rate": success_rate,
        "avg_score": avg_score,
        "evaluated_at": time.time(),
    }

    if promoted:
        save_promoted_adapter(
            lowered,
            {
                "name": f"llm-promoted:{lowered}",
                "host_suffixes": [lowered],
                "container_regexes": rule.container_regexes,
                "drop_text_patterns": rule.drop_text_patterns,
                "source_model": rule.model,
                "source_confidence": rule.confidence,
                "generated_at": rule.generated_at,
                "evaluation": evaluation,
            },
        )
    return evaluation


def apply_rule(
    *,
    url: str,
    payload: str,
    content_type: str,
    rule: AdaptiveRule,
    generated: bool,
    max_chars: int,
) -> ExtractionCandidate:
    fragments: list[str] = []
    for pattern in rule.container_regexes:
        try:
            matches = re.finditer(pattern, payload, flags=re.IGNORECASE | re.DOTALL)
        except re.error:
            continue
        for match in matches:
            fragment = match.group(1) if match.lastindex else match.group(0)
            fragment = (fragment or "").strip()
            if fragment:
                fragments.append(fragment)

    if not fragments:
        raise ValueError("LLM rule produced no matching content fragments.")

    text_candidates = [strip_html_to_text(fragment) for fragment in fragments]
    raw_content = max(text_candidates, key=len).strip()
    for pattern in rule.drop_text_patterns:
        try:
            raw_content = re.sub(pattern, "", raw_content, flags=re.IGNORECASE)
        except re.error:
            continue

    raw_content = normalize_text_preserve_paragraphs(raw_content)
    if len(raw_content) < 120:
        raise ValueError("LLM rule content too short.")

    canonical_url = extract_canonical_url(payload, url)
    title = extract_title(payload)
    host = urlparse(canonical_url or url).netloc

    return ExtractionCandidate(
        strategy_name="llm_adaptive_generated" if generated else "llm_adaptive_cached",
        url=url,
        canonical_url=canonical_url,
        title=title,
        content_format="text",
        raw_content=raw_content[:max_chars],
        extraction_meta={
            "method": "llm_adaptive",
            "host": host,
            "content_type": content_type,
            "rule_confidence": rule.confidence,
            "rule_model": rule.model,
            "rule_generated": generated,
        },
        blocks=build_reader_blocks(raw_content),
    )
