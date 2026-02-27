import re
from dataclasses import dataclass

from src.web_extract.models import ExtractionCandidate


@dataclass
class ScoreResult:
    score: float
    confidence: float
    features: dict[str, float]


def _clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9_-]{1,}", (text or "").lower())


def _score_length(text: str) -> float:
    return _clamp(len(text) / 8000.0)


def _score_paragraph_density(text: str) -> float:
    paragraphs = [item for item in re.split(r"\n{2,}", text) if item.strip()]
    count = len(paragraphs)
    return _clamp(count / 18.0)


def _score_noise_ratio(text: str) -> float:
    tokens = _tokenize(text)
    if not tokens:
        return 0.0
    noisy = 0
    noise_markers = {"cookie", "subscribe", "javascript", "privacy", "advertisement"}
    for token in tokens:
        if token in noise_markers or token.startswith("http") or ".com" in token:
            noisy += 1
    ratio = noisy / max(1, len(tokens))
    return _clamp(1.0 - ratio * 3.0)


def _score_title_coherence(title: str | None, text: str) -> float:
    if not title:
        return 0.4
    title_tokens = set(_tokenize(title))
    if not title_tokens:
        return 0.4
    lead = text[:1200]
    lead_tokens = set(_tokenize(lead))
    overlap = len(title_tokens.intersection(lead_tokens))
    return _clamp(overlap / max(2, len(title_tokens)))


def _score_language_continuity(text: str) -> float:
    if not text:
        return 0.0
    ascii_letters = sum(1 for ch in text if ch.isalpha())
    printable = sum(1 for ch in text if ch.isprintable())
    ratio = ascii_letters / max(1, printable)
    return _clamp(ratio * 2.0)


def _score_dedup(text: str) -> float:
    paragraphs = [item.strip() for item in re.split(r"\n{2,}", text) if item.strip()]
    if not paragraphs:
        return 0.0
    unique_ratio = len(set(paragraphs)) / len(paragraphs)
    return _clamp(unique_ratio)


def _score_structure_diversity(candidate: ExtractionCandidate) -> float:
    if not candidate.blocks:
        return 0.25
    block_types = {block.get("type", "paragraph") for block in candidate.blocks}
    if len(block_types) >= 3:
        return 1.0
    if len(block_types) == 2:
        return 0.7
    return 0.45


def _penalty_for_blocked_content(text: str) -> float:
    lowered = text.lower()
    blocked_markers = [
        "verify you are human",
        "access denied",
        "captcha",
        "request blocked",
    ]
    if any(marker in lowered for marker in blocked_markers):
        return 0.35
    return 0.0


def score_candidate(candidate: ExtractionCandidate) -> ScoreResult:
    text = candidate.raw_content or ""
    features = {
        "length": _score_length(text),
        "paragraph_density": _score_paragraph_density(text),
        "noise_ratio": _score_noise_ratio(text),
        "title_coherence": _score_title_coherence(candidate.title, text),
        "language_continuity": _score_language_continuity(text),
        "deduplication": _score_dedup(text),
        "structure_diversity": _score_structure_diversity(candidate),
    }

    weighted = (
        0.20 * features["length"]
        + 0.15 * features["paragraph_density"]
        + 0.20 * features["noise_ratio"]
        + 0.15 * features["title_coherence"]
        + 0.10 * features["language_continuity"]
        + 0.10 * features["deduplication"]
        + 0.10 * features["structure_diversity"]
    )
    score = _clamp(weighted - _penalty_for_blocked_content(text))

    confidence = _clamp(
        0.40
        + 0.45 * score
        + 0.15 * max(features["length"], features["paragraph_density"])
    )
    return ScoreResult(score=score, confidence=confidence, features=features)
