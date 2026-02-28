from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class DocumentImportSourceType(str, Enum):
    AUTO_URL = "auto_url"
    PDF_URL = "pdf_url"
    WEB_URL = "web_url"


class DocumentSourceType(str, Enum):
    PDF = "pdf"
    WEB_ARTICLE = "web_article"


class DocumentImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_type: DocumentImportSourceType
    url: HttpUrl
    project_id: Optional[str] = None


class DocumentImportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    status: str
    source_type: DocumentImportSourceType


class DocumentImportStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    status: str
    source_type: Optional[str] = None
    task_id: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    document_id: Optional[str] = None


class DocumentReadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    source_type: str
    viewer_type: str
    title: Optional[str] = None
    abstract: Optional[str] = None
    authors: list[str] = Field(default_factory=list)
    file_url: Optional[str] = None
    source_url: Optional[str] = None
    canonical_url: Optional[str] = None
    content_format: Optional[str] = None
    raw_content: Optional[str] = None
