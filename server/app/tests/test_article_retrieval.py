import unittest

from app.llm.article_retrieval import (
    build_article_snippet_block,
    select_relevant_article_snippets,
    split_article_into_snippets,
)
from app.llm.paper_operations import PaperOperations


class ArticleRetrievalTests(unittest.TestCase):
    def test_split_article_into_snippets_creates_multiple_chunks(self) -> None:
        raw_content = (
            "Section one discusses tokenization and vocabulary alignment in multilingual setup.\n\n"
            "Section two covers gradient clipping and optimizer stability for long context training.\n\n"
            "Section three reports final benchmark values with detailed ablations."
        )
        chunks = split_article_into_snippets(raw_content, chunk_chars=120, overlap_chars=20)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(all(chunk.strip() for chunk in chunks))

    def test_select_relevant_article_snippets_prefers_query_overlap(self) -> None:
        raw_content = (
            "The introduction describes dataset statistics and annotation protocol.\n\n"
            "We found that gradient clipping stabilizes training under long-sequence settings. "
            "This reduces exploding updates and improves convergence.\n\n"
            "The appendix includes hardware usage and additional implementation notes."
        )
        snippets = select_relevant_article_snippets(
            raw_content,
            query="Why does gradient clipping stabilize training?",
            chunk_chars=180,
            overlap_chars=30,
            top_k=2,
            max_total_chars=500,
        )
        self.assertGreaterEqual(len(snippets), 1)
        self.assertIn("gradient clipping", snippets[0].text.lower())

    def test_select_relevant_article_snippets_respects_total_context_budget(self) -> None:
        raw_content = "\n\n".join(
            f"Paragraph {idx}: this paragraph explains optimization behavior and batch scaling effects."
            for idx in range(1, 10)
        )
        snippets = select_relevant_article_snippets(
            raw_content,
            query="optimization behavior",
            chunk_chars=140,
            overlap_chars=20,
            top_k=6,
            max_total_chars=460,
        )
        total_chars = sum(len(snippet.text) for snippet in snippets)
        self.assertLessEqual(total_chars, 460)

    def test_build_article_snippet_block_has_expected_markers(self) -> None:
        snippets = select_relevant_article_snippets(
            "A paragraph about attention mechanisms.\n\nAnother paragraph about decoding.",
            query="attention",
            chunk_chars=100,
            overlap_chars=0,
            top_k=2,
            max_total_chars=300,
        )
        block = build_article_snippet_block(snippets)
        self.assertIn("---ARTICLE-SNIPPETS---", block)
        self.assertIn("[SNIPPET 1]", block)
        self.assertIn("---END-ARTICLE-SNIPPETS---", block)

    def test_normalize_article_evidence_prefers_snippet_map_text(self) -> None:
        snippet_map = {
            1: "Snippet one exact text from article.",
            2: "Snippet two exact text from article.",
        }
        citations = [
            {"key": 1, "reference": "Model paraphrase that should be replaced."},
            {"key": 2, "reference": "Another paraphrase."},
        ]
        normalized = PaperOperations._normalize_article_evidence(citations, snippet_map)
        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[0]["key"], 1)
        self.assertEqual(normalized[0]["snippet_id"], 1)
        self.assertIn("Snippet one exact text", normalized[0]["reference"])
        self.assertEqual(normalized[0]["source_type"], "web_article")

    def test_normalize_article_evidence_falls_back_to_first_snippets(self) -> None:
        snippet_map = {
            1: "First fallback snippet text.",
            2: "Second fallback snippet text.",
        }
        citations = [{"key": 99, "reference": ""}]
        normalized = PaperOperations._normalize_article_evidence(citations, snippet_map)
        self.assertGreaterEqual(len(normalized), 1)
        self.assertEqual(normalized[0]["key"], 1)
        self.assertIn("First fallback snippet", normalized[0]["reference"])


if __name__ == "__main__":
    unittest.main()
