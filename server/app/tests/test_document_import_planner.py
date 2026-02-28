import unittest
from unittest.mock import AsyncMock, patch

from app.schemas.document import DocumentImportSourceType
from app.services.document_import_planner import (
    _extract_arxiv_identifier,
    _is_arxiv_host,
    resolve_document_import_plan,
)


class DocumentImportPlannerTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_pdf_url_is_preserved(self) -> None:
        plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.PDF_URL,
            url="https://example.com/paper.pdf",
        )
        self.assertEqual(plan.resolved_source_type, DocumentImportSourceType.PDF_URL)
        self.assertEqual(plan.resolved_url, "https://example.com/paper.pdf")

    async def test_auto_url_uses_suffix_for_non_arxiv(self) -> None:
        pdf_plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.AUTO_URL,
            url="https://example.com/assets/report.pdf",
        )
        self.assertEqual(pdf_plan.resolved_source_type, DocumentImportSourceType.PDF_URL)

        web_plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.AUTO_URL,
            url="https://example.com/blog/post-1",
        )
        self.assertEqual(web_plan.resolved_source_type, DocumentImportSourceType.WEB_URL)

    @patch(
        "app.services.document_import_planner._probe_arxiv_html_availability",
        new_callable=AsyncMock,
    )
    async def test_arxiv_prefers_html_when_available(self, probe_mock: AsyncMock) -> None:
        probe_mock.return_value = True
        plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.AUTO_URL,
            url="https://arxiv.org/pdf/2602.09024",
        )
        self.assertEqual(plan.resolved_source_type, DocumentImportSourceType.WEB_URL)
        self.assertEqual(plan.resolved_url, "https://arxiv.org/html/2602.09024")
        probe_mock.assert_awaited_once()

    @patch(
        "app.services.document_import_planner._probe_arxiv_html_availability",
        new_callable=AsyncMock,
    )
    async def test_arxiv_falls_back_to_pdf_when_html_missing(
        self,
        probe_mock: AsyncMock,
    ) -> None:
        probe_mock.return_value = False
        plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.AUTO_URL,
            url="https://arxiv.org/html/2602.09024v1",
        )
        self.assertEqual(plan.resolved_source_type, DocumentImportSourceType.PDF_URL)
        self.assertEqual(plan.resolved_url, "https://arxiv.org/pdf/2602.09024v1.pdf")

    @patch(
        "app.services.document_import_planner._probe_arxiv_html_availability",
        new_callable=AsyncMock,
    )
    async def test_explicit_web_url_still_upgrades_arxiv_pdf_link(
        self,
        probe_mock: AsyncMock,
    ) -> None:
        probe_mock.return_value = True
        plan = await resolve_document_import_plan(
            requested_source_type=DocumentImportSourceType.WEB_URL,
            url="https://arxiv.org/pdf/2602.09024v3.pdf",
        )
        self.assertEqual(plan.resolved_source_type, DocumentImportSourceType.WEB_URL)
        self.assertEqual(plan.resolved_url, "https://arxiv.org/html/2602.09024v3")

    def test_arxiv_identifier_and_host_helpers(self) -> None:
        self.assertTrue(_is_arxiv_host("arxiv.org"))
        self.assertTrue(_is_arxiv_host("www.arxiv.org"))
        self.assertFalse(_is_arxiv_host("example.org"))

        self.assertEqual(_extract_arxiv_identifier("/pdf/2602.09024v1.pdf"), "2602.09024v1")
        self.assertEqual(_extract_arxiv_identifier("/html/2602.09024"), "2602.09024")
        self.assertEqual(_extract_arxiv_identifier("/abs/math/0301234"), "math/0301234")


if __name__ == "__main__":
    unittest.main()
