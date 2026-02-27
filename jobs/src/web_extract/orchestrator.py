import time
from typing import Callable, Optional

from src.web_extract.models import (
    ExtractionAttempt,
    ExtractionCandidate,
    ExtractionContext,
    ExtractionDecision,
)
from src.web_extract.safety import validate_public_http_url
from src.web_extract.scoring import score_candidate
from src.web_extract.strategies import (
    DomainAdapterStrategy,
    ExtractorStrategy,
    HttpReadabilityStrategy,
    JsonLdStrategy,
    LlmAdaptiveStrategy,
    XStatusApiStrategy,
)


class WebDocumentExtractionOrchestrator:
    def __init__(
        self,
        *,
        acceptance_threshold: float = 0.78,
        minimum_acceptable_score: float = 0.55,
        timeout_seconds: int = 30,
        max_chars: int = 120_000,
        strategies: Optional[list[ExtractorStrategy]] = None,
    ):
        self.acceptance_threshold = acceptance_threshold
        self.minimum_acceptable_score = minimum_acceptable_score
        self.timeout_seconds = timeout_seconds
        self.max_chars = max_chars
        self.strategies = strategies or [
            XStatusApiStrategy(),
            DomainAdapterStrategy(),
            JsonLdStrategy(),
            HttpReadabilityStrategy(),
            LlmAdaptiveStrategy(),
        ]

    def run(
        self,
        *,
        url: str,
        task_id: Optional[str] = None,
        project_id: Optional[str] = None,
        status_callback: Optional[Callable[[str], None]] = None,
    ) -> dict:
        validate_public_http_url(url)
        context = ExtractionContext(
            url=url,
            task_id=task_id,
            timeout_seconds=self.timeout_seconds,
            max_chars=self.max_chars,
        )

        attempts: list[ExtractionAttempt] = []
        best_candidate: Optional[ExtractionCandidate] = None
        started_at = time.perf_counter()

        for strategy in self.strategies:
            if status_callback:
                status_callback(f"Extracting content ({strategy.name})")

            strategy_started = time.perf_counter()
            try:
                candidate = strategy.extract(context)
                score_result = score_candidate(candidate)
                candidate.quality_score = score_result.score
                candidate.quality_confidence = score_result.confidence
                candidate.extraction_meta = {
                    **candidate.extraction_meta,
                    "quality_features": score_result.features,
                }

                duration_ms = int((time.perf_counter() - strategy_started) * 1000)
                attempts.append(
                    ExtractionAttempt(
                        strategy_name=strategy.name,
                        success=True,
                        duration_ms=duration_ms,
                        score=score_result.score,
                        confidence=score_result.confidence,
                    )
                )

                if not best_candidate or candidate.quality_score > best_candidate.quality_score:
                    best_candidate = candidate

                if candidate.quality_score >= self.acceptance_threshold:
                    break
            except Exception as exc:
                duration_ms = int((time.perf_counter() - strategy_started) * 1000)
                attempts.append(
                    ExtractionAttempt(
                        strategy_name=strategy.name,
                        success=False,
                        duration_ms=duration_ms,
                        reason=str(exc),
                    )
                )

        if not best_candidate:
            failure_reasons = "; ".join(
                f"{attempt.strategy_name}: {attempt.reason or 'unknown error'}"
                for attempt in attempts
                if not attempt.success
            )
            raise RuntimeError(f"Failed to extract readable article content. {failure_reasons}")
        if best_candidate.quality_score < self.minimum_acceptable_score:
            raise RuntimeError(
                "Extraction quality below acceptable threshold "
                f"({best_candidate.quality_score:.3f} < {self.minimum_acceptable_score:.3f})."
            )

        decision = ExtractionDecision(
            candidate=best_candidate,
            attempts=attempts,
            duration_seconds=(time.perf_counter() - started_at),
        )
        return decision.to_webhook_result(project_id=project_id)
