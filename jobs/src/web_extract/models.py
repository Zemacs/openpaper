from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class FetchedPage:
    requested_url: str
    final_url: str
    content_type: str
    payload: str
    status_code: int
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class ExtractionContext:
    url: str
    task_id: Optional[str] = None
    timeout_seconds: int = 30
    max_chars: int = 120_000
    fetched_page: Optional[FetchedPage] = None


@dataclass
class ExtractionCandidate:
    strategy_name: str
    url: str
    canonical_url: str
    title: Optional[str]
    content_format: str
    raw_content: str
    extraction_meta: dict[str, Any] = field(default_factory=dict)
    blocks: list[dict[str, Any]] = field(default_factory=list)
    quality_score: float = 0.0
    quality_confidence: float = 0.0


@dataclass
class ExtractionAttempt:
    strategy_name: str
    success: bool
    duration_ms: int
    score: Optional[float] = None
    confidence: Optional[float] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy_name": self.strategy_name,
            "success": self.success,
            "duration_ms": self.duration_ms,
            "score": self.score,
            "confidence": self.confidence,
            "reason": self.reason,
        }


@dataclass
class ExtractionDecision:
    candidate: ExtractionCandidate
    attempts: list[ExtractionAttempt]
    duration_seconds: float

    def to_webhook_result(self, project_id: Optional[str] = None) -> dict[str, Any]:
        result = {
            "success": True,
            "url": self.candidate.url,
            "canonical_url": self.candidate.canonical_url,
            "title": self.candidate.title,
            "content_format": self.candidate.content_format,
            "raw_content": self.candidate.raw_content,
            "blocks": self.candidate.blocks,
            "quality_score": self.candidate.quality_score,
            "quality_confidence": self.candidate.quality_confidence,
            "strategy_used": self.candidate.strategy_name,
            "extraction_trace": [attempt.to_dict() for attempt in self.attempts],
            "extraction_meta": self.candidate.extraction_meta,
            "duration": self.duration_seconds,
        }
        if project_id:
            result["project_id"] = project_id
        return result
