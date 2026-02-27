import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.web_extract.llm_adaptive import (
    AdaptiveRule,
    evaluate_and_promote_rule,
    record_rule_replay_sample,
)
from src.web_extract.rules_store import (
    get_generated_rule,
    get_promoted_adapter_for_host,
    save_generated_rule,
)


def _sample_html(seed: int) -> str:
    return f"""
    <html>
      <head><title>Example Article {seed}</title></head>
      <body>
        <article>
          <p>This is an article paragraph about robust extraction quality and scoring controls.</p>
          <p>It contains enough text to be considered high quality for replay evaluation and promotion.</p>
          <p>Sample id {seed} extends the replay corpus for host-based adaptation in production systems.</p>
          <p>The paragraph density is sufficient and noise ratio is low, improving quality score.</p>
        </article>
      </body>
    </html>
    """


class WebExtractPromotionTests(unittest.TestCase):
    def test_generated_rule_persisted_in_store(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store_path = str(Path(temp_dir) / "web_rules.json")
            with patch("src.web_extract.rules_store.STORE_FILE_PATH", store_path):
                save_generated_rule(
                    "example.com",
                    {
                        "container_regexes": [r"<article[^>]*>(.*?)</article>"],
                        "drop_text_patterns": [r"subscribe now"],
                        "confidence": 0.88,
                        "model": "gemini-test",
                        "generated_at": 123.0,
                    },
                )
                loaded = get_generated_rule("example.com")
                self.assertIsNotNone(loaded)
                self.assertEqual(loaded.get("model"), "gemini-test")
                self.assertEqual(loaded.get("confidence"), 0.88)

    def test_rule_replay_evaluation_promotes_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store_path = str(Path(temp_dir) / "web_rules.json")
            with patch("src.web_extract.rules_store.STORE_FILE_PATH", store_path), patch(
                "src.web_extract.llm_adaptive.LLM_PROMOTION_MIN_SAMPLES", 3
            ), patch("src.web_extract.llm_adaptive.LLM_PROMOTION_MAX_SAMPLES", 6), patch(
                "src.web_extract.llm_adaptive.LLM_PROMOTION_MIN_SAMPLE_SCORE", 0.30
            ), patch("src.web_extract.llm_adaptive.LLM_PROMOTION_MIN_AVG_SCORE", 0.30), patch(
                "src.web_extract.llm_adaptive.LLM_PROMOTION_MIN_SUCCESS_RATE", 0.60
            ):
                for idx in range(1, 4):
                    record_rule_replay_sample(
                        "example.com",
                        url=f"https://example.com/post-{idx}",
                        content_type="text/html",
                        payload=_sample_html(idx),
                    )

                rule = AdaptiveRule(
                    host="example.com",
                    container_regexes=[r"<article[^>]*>(.*?)</article>"],
                    drop_text_patterns=[],
                    confidence=0.91,
                    model="gemini-test",
                    generated_at=456.0,
                )
                evaluation = evaluate_and_promote_rule(
                    "example.com",
                    rule,
                    max_chars=80_000,
                )
                self.assertTrue(bool(evaluation.get("promoted")))
                promoted = get_promoted_adapter_for_host("example.com")
                self.assertIsNotNone(promoted)
                self.assertEqual(promoted.get("source_model"), "gemini-test")


if __name__ == "__main__":
    unittest.main()
