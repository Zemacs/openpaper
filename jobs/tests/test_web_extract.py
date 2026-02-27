import unittest
from unittest.mock import patch

from src.web_extract.llm_adaptive import AdaptiveRule, apply_rule
from src.web_extract.models import ExtractionCandidate, ExtractionContext
from src.web_extract.orchestrator import WebDocumentExtractionOrchestrator
from src.web_extract.scoring import score_candidate
from src.web_extract.strategies import (
    XStatusApiStrategy,
    _build_candidate_from_fxtwitter,
    _build_candidate_from_vxtwitter,
    _parse_x_status_url,
)


class _LowQualityStrategy:
    name = "low_quality"

    def extract(self, context):
        return ExtractionCandidate(
            strategy_name=self.name,
            url=context.url,
            canonical_url=context.url,
            title="Short",
            content_format="text",
            raw_content="Short content that is barely enough words to pass minimal checks.",
        )


class _HighQualityStrategy:
    name = "high_quality"

    def extract(self, context):
        text = (
            "Large language models are increasingly used for information extraction.\n\n"
            "This article describes robust strategy orchestration, fallback execution, and scoring.\n\n"
            "Empirical observations indicate higher reliability when extraction combines structure-aware signals.\n\n"
            "The method captures title coherence, language continuity, and low-noise paragraph density.\n\n"
            "Results show better readability and stronger downstream chat citation alignment."
        )
        return ExtractionCandidate(
            strategy_name=self.name,
            url=context.url,
            canonical_url=context.url,
            title="Robust Extraction",
            content_format="text",
            raw_content=text,
        )


class WebExtractTests(unittest.TestCase):
    def test_scoring_prefers_richer_content(self) -> None:
        short_candidate = ExtractionCandidate(
            strategy_name="short",
            url="https://example.com/a",
            canonical_url="https://example.com/a",
            title="Tiny",
            content_format="text",
            raw_content="hello world",
        )
        long_candidate = ExtractionCandidate(
            strategy_name="long",
            url="https://example.com/b",
            canonical_url="https://example.com/b",
            title="Long Content",
            content_format="text",
            raw_content=(
                "Paragraph one explains model behavior.\n\n"
                "Paragraph two covers evaluation methodology.\n\n"
                "Paragraph three discusses results and implications for production systems."
            ),
            blocks=[{"id": "1", "type": "paragraph", "text": "p"}],
        )

        short_score = score_candidate(short_candidate).score
        long_score = score_candidate(long_candidate).score
        self.assertGreater(long_score, short_score)

    def test_apply_rule_extracts_main_content(self) -> None:
        html_payload = """
        <html>
          <head><title>Test Article</title></head>
          <body>
            <div class="header">Subscribe now</div>
            <article>
              <p>First section of the article with meaningful information.</p>
              <p>Second section describing robust extraction and normalization.</p>
              <p>Third section includes conclusion and practical guidance.</p>
            </article>
            <footer>privacy policy</footer>
          </body>
        </html>
        """
        rule = AdaptiveRule(
            host="example.com",
            container_regexes=[r"<article[^>]*>(.*?)</article>"],
            drop_text_patterns=[r"subscribe now", r"privacy policy"],
            confidence=0.92,
            model="mock",
            generated_at=0.0,
        )

        candidate = apply_rule(
            url="https://example.com/post",
            payload=html_payload,
            content_type="text/html",
            rule=rule,
            generated=True,
            max_chars=10000,
        )
        self.assertIn("First section", candidate.raw_content)
        self.assertIn("robust extraction", candidate.raw_content.lower())
        self.assertEqual(candidate.extraction_meta.get("rule_generated"), True)

    def test_orchestrator_picks_best_strategy(self) -> None:
        orchestrator = WebDocumentExtractionOrchestrator(
            acceptance_threshold=0.60,
            strategies=[_LowQualityStrategy(), _HighQualityStrategy()],
        )

        with patch("src.web_extract.orchestrator.validate_public_http_url", return_value=None):
            result = orchestrator.run(url="https://example.com/article")
        self.assertEqual(result.get("success"), True)
        self.assertEqual(result.get("strategy_used"), "high_quality")
        self.assertGreaterEqual(float(result.get("quality_score", 0.0)), 0.60)
        self.assertGreaterEqual(len(result.get("extraction_trace", [])), 1)

    @patch("src.web_extract.strategies.requests.get")
    def test_x_status_api_strategy_extracts_article_blocks(self, mock_get) -> None:
        class _MockResponse:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "tweet": {
                        "url": "https://x.com/indigox/status/2026911299494449635",
                        "id": "2026911299494449635",
                        "author": {"screen_name": "indigox"},
                        "article": {
                            "title": "科学家的消亡 / AI 会终结科学，还是会引发一场新的革命？",
                            "preview_text": "这不是又一篇关于 AI 的空泛讨论。",
                            "content": {
                                "blocks": [
                                    {
                                        "key": "a1",
                                        "type": "unstyled",
                                        "text": "这不是又一篇关于 AI 的空泛讨论，而是关于科学方法本身的根本追问。作者从科学哲学和复杂系统角度提出，技术进步并不天然等于科学能力的自动复制。",
                                    },
                                    {
                                        "key": "a2",
                                        "type": "unstyled",
                                        "text": "如果我们连科学是什么都没有清楚定义，那么讨论 AI 是否能做科学会失焦。文章进一步讨论了观察、解释与可证伪性在科学实践中的作用，并提出更可操作的评估框架。",
                                    },
                                ]
                            },
                        },
                    }
                }

        mock_get.return_value = _MockResponse()

        strategy = XStatusApiStrategy()
        context = ExtractionContext(
            url="https://x.com/indigox/status/2026911299494449635?s=20",
            timeout_seconds=20,
            max_chars=20000,
        )
        candidate = strategy.extract(context)

        self.assertEqual(candidate.strategy_name, "x_status_api")
        self.assertIn("科学", candidate.raw_content)
        self.assertGreaterEqual(len(candidate.raw_content), 120)
        self.assertEqual(candidate.extraction_meta.get("provider"), "api.fxtwitter.com")

    def test_parse_x_status_url_supports_multiple_paths(self) -> None:
        self.assertEqual(
            _parse_x_status_url("https://x.com/indigox/status/2026911299494449635?s=20"),
            ("indigox", "2026911299494449635"),
        )
        self.assertEqual(
            _parse_x_status_url("https://x.com/status/2026911299494449635"),
            (None, "2026911299494449635"),
        )
        self.assertEqual(
            _parse_x_status_url("https://x.com/i/web/status/2026911299494449635"),
            (None, "2026911299494449635"),
        )
        self.assertEqual(
            _parse_x_status_url("https://twitter.com/i/status/2026911299494449635"),
            (None, "2026911299494449635"),
        )

    def test_fxtwitter_builder_skips_truncated_preview_when_blocks_exist(self) -> None:
        payload = {
            "tweet": {
                "url": "https://x.com/indigox/status/2026911299494449635",
                "id": "2026911299494449635",
                "author": {"screen_name": "indigox"},
                "text": "tweet fallback should not be preferred when article blocks are present",
                "article": {
                    "title": "Sample Title",
                    "preview_text": "This is a truncated lead that should not be duplicated",
                    "content": {
                        "blocks": [
                            {
                                "key": "a1",
                                "type": "unstyled",
                                "text": "This is a truncated lead that should not be duplicated because the full block content is already available in the article body and should be kept as canonical text.",
                            },
                            {
                                "key": "a2",
                                "type": "unstyled",
                                "text": "Second paragraph adds additional details and ensures the final content is long enough for quality checks and downstream reader rendering.",
                            },
                        ]
                    },
                },
            }
        }
        candidate = _build_candidate_from_fxtwitter(
            "https://x.com/indigox/status/2026911299494449635?s=20", payload
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        lead = "This is a truncated lead that should not be duplicated"
        self.assertEqual(candidate.raw_content.count(lead), 1)
        self.assertGreaterEqual(len(candidate.blocks), 2)

    def test_fxtwitter_builder_extracts_image_blocks_from_atomic_entities(self) -> None:
        payload = {
            "tweet": {
                "url": "https://x.com/indigox/status/2026911299494449635",
                "id": "2026911299494449635",
                "author": {"screen_name": "indigox"},
                "article": {
                    "title": "Sample Title",
                    "cover_media": {
                        "media_info": {
                            "original_img_url": "https://pbs.twimg.com/media/cover.jpg",
                            "original_img_width": 1200,
                            "original_img_height": 800,
                        }
                    },
                    "media_entities": {
                        1: {
                            "media_id": "2026698374985211906",
                            "media_info": {
                                "original_img_url": "https://pbs.twimg.com/media/body-1.jpg",
                                "original_img_width": 1600,
                                "original_img_height": 900,
                            },
                        }
                    },
                    "content": {
                        "entityMap": {
                            1: {
                                "key": "media-entity",
                                "value": {
                                    "type": "MEDIA",
                                    "data": {
                                        "mediaItems": [
                                            {"mediaId": "2026698374985211906"}
                                        ]
                                    },
                                },
                            }
                        },
                        "blocks": [
                            {
                                "key": "a1",
                                "type": "unstyled",
                                "text": (
                                    "The article includes a concrete paragraph long enough to satisfy minimum "
                                    "content checks before rendering embedded media in the reader."
                                ),
                            },
                            {
                                "key": "a2",
                                "type": "atomic",
                                "text": " ",
                                "entityRanges": [{"key": 1, "length": 1, "offset": 0}],
                            },
                        ],
                    },
                },
            }
        }
        candidate = _build_candidate_from_fxtwitter(
            "https://x.com/indigox/status/2026911299494449635?s=20",
            payload,
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        image_blocks = [block for block in candidate.blocks if block.get("type") == "image"]
        self.assertGreaterEqual(len(image_blocks), 2)
        urls = {str(block.get("image_url")) for block in image_blocks}
        self.assertIn("https://pbs.twimg.com/media/cover.jpg", urls)
        self.assertIn("https://pbs.twimg.com/media/body-1.jpg", urls)

    def test_vxtwitter_builder_keeps_article_cover_image_block(self) -> None:
        payload = {
            "tweetID": "2026911299494449635",
            "user_name": "indigox",
            "text": (
                "This payload still contains enough sentence content to satisfy quality checks while "
                "validating that the cover image is retained as a dedicated render block."
            ),
            "article": {
                "title": "Sample article",
                "preview_text": "Short preview.",
                "image": "https://pbs.twimg.com/media/vx-cover.jpg",
            },
        }
        candidate = _build_candidate_from_vxtwitter(
            "https://x.com/indigox/status/2026911299494449635?s=20",
            payload,
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.blocks[0].get("type"), "image")
        self.assertEqual(
            candidate.blocks[0].get("image_url"),
            "https://pbs.twimg.com/media/vx-cover.jpg",
        )


if __name__ == "__main__":
    unittest.main()
