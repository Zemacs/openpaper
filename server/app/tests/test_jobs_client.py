import unittest
from unittest.mock import MagicMock, patch

from app.helpers.pdf_jobs import JobsClient


class JobsClientTests(unittest.TestCase):
    @patch("app.helpers.pdf_jobs.Celery")
    def test_submit_web_document_import_job_with_project(self, celery_cls: MagicMock) -> None:
        mock_celery_app = MagicMock()
        mock_celery_app.send_task.return_value = MagicMock(id="task-123")
        celery_cls.return_value = mock_celery_app

        client = JobsClient(
            webhook_base_url="http://localhost:8000",
            celery_broker_url="pyamqp://guest@localhost:5672//",
        )
        task_id = client.submit_web_document_import_job(
            url="https://example.com/article",
            job_id="job-1",
            project_id="project-1",
        )

        self.assertEqual(task_id, "task-123")
        mock_celery_app.send_task.assert_called_once_with(
            "import_web_document",
            kwargs={
                "url": "https://example.com/article",
                "webhook_url": "http://localhost:8000/api/webhooks/document-import/job-1",
                "project_id": "project-1",
            },
        )

    @patch("app.helpers.pdf_jobs.Celery")
    def test_submit_web_document_import_job_without_project(self, celery_cls: MagicMock) -> None:
        mock_celery_app = MagicMock()
        mock_celery_app.send_task.return_value = MagicMock(id="task-456")
        celery_cls.return_value = mock_celery_app

        client = JobsClient(
            webhook_base_url="https://openpaper.example",
            celery_broker_url="pyamqp://guest@localhost:5672//",
        )
        task_id = client.submit_web_document_import_job(
            url="https://example.com/post",
            job_id="job-2",
        )

        self.assertEqual(task_id, "task-456")
        mock_celery_app.send_task.assert_called_once_with(
            "import_web_document",
            kwargs={
                "url": "https://example.com/post",
                "webhook_url": "https://openpaper.example/api/webhooks/document-import/job-2",
            },
        )

    def test_submit_web_document_import_job_requires_url(self) -> None:
        client = JobsClient()
        with self.assertRaises(ValueError):
            client.submit_web_document_import_job(url="", job_id="job-3")


if __name__ == "__main__":
    unittest.main()
