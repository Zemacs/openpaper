import re
from dataclasses import dataclass
from typing import Iterable, Sequence


TOKEN_PATTERN = re.compile(r"[a-z0-9][a-z0-9_+-]{1,}", re.IGNORECASE)


@dataclass
class ArticleSnippet:
    snippet_id: int
    text: str
    score: float


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text.replace("\r\n", "\n")).strip()


def _tokenize(text: str) -> set[str]:
    lowered = text.lower()
    return {match.group(0) for match in TOKEN_PATTERN.finditer(lowered)}


def split_article_into_snippets(
    raw_content: str,
    *,
    chunk_chars: int = 900,
    overlap_chars: int = 140,
) -> list[str]:
    text = _normalize_whitespace(raw_content)
    if not text:
        return []

    paragraphs = [
        _normalize_whitespace(part)
        for part in re.split(r"\n{2,}", text)
        if _normalize_whitespace(part)
    ]
    if not paragraphs:
        paragraphs = [text]

    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        if not current:
            current = paragraph
            continue

        candidate = f"{current}\n\n{paragraph}"
        if len(candidate) <= chunk_chars:
            current = candidate
            continue

        chunks.append(current)
        if overlap_chars > 0:
            tail = current[-overlap_chars:]
            current = f"{tail}\n\n{paragraph}".strip()
        else:
            current = paragraph

    if current:
        chunks.append(current)

    # Fallback: paragraph aggregation may still create giant chunks for very long lines.
    normalized_chunks: list[str] = []
    for chunk in chunks:
        if len(chunk) <= chunk_chars * 2:
            normalized_chunks.append(chunk)
            continue

        start = 0
        step = max(160, chunk_chars - overlap_chars)
        while start < len(chunk):
            end = min(len(chunk), start + chunk_chars)
            piece = chunk[start:end].strip()
            if piece:
                normalized_chunks.append(piece)
            if end >= len(chunk):
                break
            start += step

    return normalized_chunks


def _score_chunk(
    chunk: str,
    *,
    query_tokens: set[str],
    query_phrase: str,
    hint_tokens: set[str],
) -> float:
    chunk_lower = chunk.lower()
    chunk_tokens = _tokenize(chunk)

    overlap_query = len(chunk_tokens & query_tokens)
    overlap_hint = len(chunk_tokens & hint_tokens)

    phrase_boost = 0.0
    if query_phrase and len(query_phrase) >= 8 and query_phrase in chunk_lower:
        phrase_boost = 5.0

    tf_boost = 0.0
    for token in query_tokens:
        if len(token) < 3:
            continue
        tf_boost += min(3, chunk_lower.count(token)) * 0.35

    length_penalty = max(0.0, (len(chunk) - 1100) / 1100.0)
    return overlap_query * 3.0 + overlap_hint * 1.4 + phrase_boost + tf_boost - length_penalty


def select_relevant_article_snippets(
    raw_content: str,
    *,
    query: str,
    conversation_messages: Sequence[str] | None = None,
    user_references: Sequence[str] | None = None,
    chunk_chars: int = 900,
    overlap_chars: int = 140,
    top_k: int = 8,
    max_total_chars: int = 7000,
) -> list[ArticleSnippet]:
    chunks = split_article_into_snippets(
        raw_content,
        chunk_chars=chunk_chars,
        overlap_chars=overlap_chars,
    )
    if not chunks:
        return []

    query_norm = _normalize_whitespace(query).lower()
    query_tokens = _tokenize(query_norm)

    history_tail = " ".join((conversation_messages or [])[-6:])
    reference_text = " ".join(user_references or [])
    hints_tokens = _tokenize(f"{history_tail} {reference_text}")

    scored: list[ArticleSnippet] = []
    for idx, chunk in enumerate(chunks, start=1):
        score = _score_chunk(
            chunk,
            query_tokens=query_tokens,
            query_phrase=query_norm,
            hint_tokens=hints_tokens,
        )
        scored.append(ArticleSnippet(snippet_id=idx, text=chunk, score=score))

    scored.sort(key=lambda item: (item.score, -item.snippet_id), reverse=True)

    selected: list[ArticleSnippet] = []
    total_chars = 0
    for item in scored[: max(1, top_k * 2)]:
        if len(selected) >= max(1, top_k):
            break
        if item.score <= 0 and selected:
            continue

        next_total = total_chars + len(item.text)
        if next_total > max_total_chars and selected:
            continue
        selected.append(item)
        total_chars = next_total

    if not selected:
        selected = [scored[0]]

    reindexed: list[ArticleSnippet] = []
    for index, item in enumerate(selected, start=1):
        reindexed.append(
            ArticleSnippet(
                snippet_id=index,
                text=item.text,
                score=item.score,
            )
        )
    return reindexed


def build_article_snippet_block(snippets: Iterable[ArticleSnippet]) -> str:
    parts = ["---ARTICLE-SNIPPETS---"]
    for snippet in snippets:
        parts.append(f"[SNIPPET {snippet.snippet_id}]")
        parts.append(snippet.text)
    parts.append("---END-ARTICLE-SNIPPETS---")
    return "\n".join(parts)
