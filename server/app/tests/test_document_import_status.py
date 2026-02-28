import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.api.document_api import _recover_completed_import_paper
from app.database.models import JobStatus


class DocumentImportStatusTests(unittest.TestCase):
    @patch("app.api.document_api.jobs_client.check_celery_task_status")
    def test_recovery_skips_non_completed_jobs(self, status_mock: MagicMock) -> None:
        upload_job = SimpleNamespace(task_id="task-1", status=JobStatus.RUNNING.value)

        paper = _recover_completed_import_paper(
            db=MagicMock(),
            current_user=SimpleNamespace(id="user-1"),
            upload_job=upload_job,
        )

        self.assertIsNone(paper)
        status_mock.assert_not_called()

    @patch("app.api.document_api.paper_crud.get_by_canonical_url")
    @patch("app.api.document_api.jobs_client.check_celery_task_status")
    def test_recovery_uses_canonical_url_from_completed_task(
        self,
        status_mock: MagicMock,
        get_by_canonical_url_mock: MagicMock,
    ) -> None:
        recovered_paper = MagicMock()
        status_mock.return_value = {
            "status": "success",
            "result": {
                "canonical_url": "https://arxiv.org/html/2602.09024v1",
                "source_url": "https://arxiv.org/html/2602.09024",
            },
        }
        get_by_canonical_url_mock.return_value = recovered_paper
        upload_job = SimpleNamespace(task_id="task-2", status=JobStatus.COMPLETED.value)
        db = MagicMock()
        user = SimpleNamespace(id="user-1")

        paper = _recover_completed_import_paper(
            db=db,
            current_user=user,
            upload_job=upload_job,
        )

        self.assertIs(paper, recovered_paper)
        status_mock.assert_called_once_with("task-2")
        get_by_canonical_url_mock.assert_called_once_with(
            db=db,
            canonical_url="https://arxiv.org/html/2602.09024v1",
            user=user,
        )

    @patch("app.api.document_api.paper_crud.get_by_canonical_url")
    @patch("app.api.document_api.jobs_client.check_celery_task_status")
    def test_recovery_falls_back_to_source_url_when_canonical_lookup_misses(
        self,
        status_mock: MagicMock,
        get_by_canonical_url_mock: MagicMock,
    ) -> None:
        recovered_paper = MagicMock()
        status_mock.return_value = {
            "status": "success",
            "result": {
                "canonical_url": "https://arxiv.org/html/2602.09024v1",
                "source_url": "https://arxiv.org/html/2602.09024",
            },
        }
        get_by_canonical_url_mock.side_effect = [None, recovered_paper]
        upload_job = SimpleNamespace(task_id="task-3", status=JobStatus.COMPLETED.value)
        db = MagicMock()
        user = SimpleNamespace(id="user-1")

        paper = _recover_completed_import_paper(
            db=db,
            current_user=user,
            upload_job=upload_job,
        )

        self.assertIs(paper, recovered_paper)
        self.assertEqual(get_by_canonical_url_mock.call_count, 2)
        self.assertEqual(
            get_by_canonical_url_mock.call_args_list[1].kwargs["canonical_url"],
            "https://arxiv.org/html/2602.09024",
        )


if __name__ == "__main__":
    unittest.main()
