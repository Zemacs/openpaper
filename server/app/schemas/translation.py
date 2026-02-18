from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class SelectionTypeHint(str, Enum):
    AUTO = "auto"
    WORD = "word"
    TERM = "term"
    SENTENCE = "sentence"
    FORMULA = "formula"


class TranslationMode(str, Enum):
    WORD = "word"
    TERM = "term"
    SENTENCE = "sentence"
    FORMULA = "formula"


class TranslateSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    paper_id: str
    selected_text: str = Field(min_length=1, max_length=1200)
    page_number: Optional[int] = None
    selection_type_hint: SelectionTypeHint = SelectionTypeHint.AUTO
    context_before: Optional[str] = None
    context_after: Optional[str] = None
    target_language: str = "zh-CN"


class KeyTermPair(BaseModel):
    model_config = ConfigDict(extra="forbid")

    en: str
    cn: str


class WordTranslationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ipa_us: Optional[str] = None
    ipa_uk: Optional[str] = None
    pos: Optional[str] = None
    primary_translation_cn: str
    context_translation_cn: str
    meaning_explainer_cn: str
    usage_notes_cn: List[str] = Field(default_factory=list)
    collocations: List[str] = Field(default_factory=list)
    example_context_en: Optional[str] = None
    example_context_cn: Optional[str] = None
    example_general_en: Optional[str] = None
    example_general_cn: Optional[str] = None


class SentenceTranslationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concise_translation_cn: str
    literal_translation_cn: Optional[str] = None
    key_terms: List[KeyTermPair] = Field(default_factory=list)
    one_line_explain_cn: Optional[str] = None


class FormulaTranslationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concise_translation_cn: str
    formula_explain_cn: str
    symbols_notes_cn: List[str] = Field(default_factory=list)
    one_line_takeaway_cn: Optional[str] = None


class TranslationMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confidence: float
    context_relevance_score: float
    cached: bool
    latency_ms: int


class TranslateSelectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: TranslationMode
    detected_mode: TranslationMode
    source_text: str
    target_language: str
    result: dict
    meta: TranslationMeta
