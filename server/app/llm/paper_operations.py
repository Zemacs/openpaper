import asyncio
import contextlib
import logging
import os
import re
import time
import uuid
from functools import partial
from typing import AsyncGenerator, Literal, Optional, Sequence, Union

import requests as http_requests
from app.database.crud.paper_crud import paper_crud
from app.database.models import Paper
from app.llm.article_retrieval import (
    build_article_snippet_block,
    select_relevant_article_snippets,
)
from app.llm.base import BaseLLMClient
from app.llm.citation_handler import CitationHandler
from app.llm.json_parser import JSONParser
from app.llm.prompts import (
    ANSWER_PAPER_QUESTION_SYSTEM_PROMPT,
    ANSWER_PAPER_QUESTION_USER_MESSAGE,
    CONCISE_MODE_INSTRUCTIONS,
    DETAILED_MODE_INSTRUCTIONS,
    GENERATE_NARRATIVE_SUMMARY,
    NORMAL_MODE_INSTRUCTIONS,
)
from app.llm.provider import FileContent, LLMProvider, TextContent
from app.llm.utils import retry_llm_operation
from app.schemas.message import ResponseStyle
from app.schemas.responses import AudioOverviewForLLM
from app.schemas.user import CurrentUser
from fastapi import Depends
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.database.crud.message_crud import message_crud
from app.database.database import get_db
from app.helpers.s3 import s3_service

ARTICLE_EVIDENCE_REFERENCE_MAX_CHARS = max(
    180, int(os.getenv("ARTICLE_EVIDENCE_REFERENCE_MAX_CHARS", "420"))
)


class PaperOperations(BaseLLMClient):
    """Operations related to paper analysis and chat functionality"""

    @staticmethod
    def _truncate_evidence_reference(text: str) -> str:
        normalized = re.sub(r"\s+", " ", text or "").strip()
        if len(normalized) <= ARTICLE_EVIDENCE_REFERENCE_MAX_CHARS:
            return normalized
        return f"{normalized[:ARTICLE_EVIDENCE_REFERENCE_MAX_CHARS].rstrip()}..."

    @classmethod
    def _normalize_article_evidence(
        cls,
        citations: list[dict],
        snippet_map: dict[int, str],
    ) -> list[dict]:
        normalized: list[dict] = []
        for citation in citations:
            raw_key = citation.get("key")
            snippet_id: int | None = None
            try:
                snippet_id = int(raw_key)
            except (TypeError, ValueError):
                snippet_id = None

            if snippet_id is not None and snippet_id in snippet_map:
                anchor_text = cls._truncate_evidence_reference(snippet_map[snippet_id])
                normalized.append(
                    {
                        "key": snippet_id,
                        "reference": anchor_text,
                        "anchor": anchor_text,
                        "snippet_id": snippet_id,
                        "source_type": "web_article",
                    }
                )
                continue

            fallback_reference = cls._truncate_evidence_reference(
                str(citation.get("reference", ""))
            )
            if not fallback_reference:
                continue
            normalized.append(
                {
                    "key": raw_key if raw_key is not None else len(normalized) + 1,
                    "reference": fallback_reference,
                    "anchor": fallback_reference,
                    "source_type": "web_article",
                }
            )

        if normalized:
            return normalized

        # If model failed to produce parseable evidence, fall back to first snippets.
        fallback_items = sorted(snippet_map.items(), key=lambda item: item[0])[:3]
        return [
            {
                "key": snippet_id,
                "reference": cls._truncate_evidence_reference(snippet_text),
                "anchor": cls._truncate_evidence_reference(snippet_text),
                "snippet_id": snippet_id,
                "source_type": "web_article",
            }
            for snippet_id, snippet_text in fallback_items
        ]

    @retry_llm_operation(max_retries=3, delay=1.0)
    def create_narrative_summary(
        self,
        paper_id: str,
        user: CurrentUser,
        length: Optional[Literal["short", "medium", "long"]] = "medium",
        additional_instructions: Optional[str] = None,
        db: Session = Depends(get_db),
    ) -> AudioOverviewForLLM:
        """
        Create a narrative summary of the paper using the specified model
        """
        paper = paper_crud.get(db, id=paper_id, user=user)

        if not paper:
            raise ValueError(f"Paper with ID {paper_id} not found.")

        audio_overview_schema = AudioOverviewForLLM.model_json_schema()

        # Word count targets for audio durations at ~150 words/min
        # short: ~3 min, medium: ~7 min, long: ~14 min
        word_count_map = {
            "short": 450,
            "medium": 1000,
            "long": 2000,
        }

        formatted_prompt = GENERATE_NARRATIVE_SUMMARY.format(
            additional_instructions=additional_instructions,
            length=word_count_map.get(str(length), word_count_map["medium"]),
            schema=audio_overview_schema,
        )

        signed_url = s3_service.get_cached_presigned_url(
            db,
            paper_id=str(paper.id),
            object_key=str(paper.s3_object_key),
            current_user=user,
        )

        if not signed_url:
            raise ValueError(
                f"Could not generate presigned URL for paper with ID {paper_id}."
            )

        # Retrieve and encode the PDF bytes
        response = http_requests.get(signed_url, timeout=60)
        response.raise_for_status()
        pdf_bytes = response.content

        message_content = [
            FileContent(
                data=pdf_bytes,
                mime_type="application/pdf",
                filename=f"{paper.title or 'paper'}.pdf",
            ),
            TextContent(text=formatted_prompt),
        ]

        # Generate narrative summary using the LLM
        response = self.generate_content(
            contents=message_content,
        )

        try:
            if response and response.text:
                # Parse the response text as JSON
                response_json = JSONParser.validate_and_extract_json(response.text)
                # Validate against the AudioOverview schema
                audio_overview = AudioOverviewForLLM.model_validate(response_json)
                return audio_overview
            else:
                raise ValueError("Empty response from LLM.")
        except ValueError as e:
            logger.error(f"Error parsing LLM response: {e}", exc_info=True)
            raise ValueError(f"Invalid response from LLM: {str(e)}")

    async def chat_with_paper(
        self,
        paper_id: str,
        conversation_id: str,
        question: str,
        current_user: CurrentUser,
        llm_provider: Optional[LLMProvider] = None,
        user_references: Optional[Sequence[str]] = None,
        response_style: Optional[str] = "normal",
        db: Session = Depends(get_db),
    ) -> AsyncGenerator[Union[str, dict], None]:
        """
        Chat with the paper using the specified model
        """

        user_citations = (
            CitationHandler.convert_references_to_citations(user_references)
            if user_references
            else None
        )

        paper: Paper = paper_crud.get(db, id=paper_id)

        if not paper:
            raise ValueError(f"Paper with ID {paper_id} not found.")

        casted_conversation_id = uuid.UUID(conversation_id)

        conversation_history = message_crud.get_conversation_messages(
            db, conversation_id=casted_conversation_id, current_user=current_user
        )

        additional_instructions = ""

        if response_style == ResponseStyle.DETAILED:
            additional_instructions = DETAILED_MODE_INSTRUCTIONS
        elif response_style == ResponseStyle.CONCISE:
            additional_instructions = CONCISE_MODE_INSTRUCTIONS
        else:
            additional_instructions = NORMAL_MODE_INSTRUCTIONS

        formatted_system_prompt = ANSWER_PAPER_QUESTION_SYSTEM_PROMPT.format(
            additional_instructions=additional_instructions,
        )

        formatted_prompt = ANSWER_PAPER_QUESTION_USER_MESSAGE.format(
            question=f"{question}\n\n{user_citations}" if user_citations else question,
        )

        evidence_buffer: list[str] = []
        text_buffer: str = ""
        in_evidence_section = False

        START_DELIMITER = "---EVIDENCE---"
        END_DELIMITER = "---END-EVIDENCE---"
        stream_chunk_timeout_seconds = max(
            5, int(os.getenv("LLM_STREAM_CHUNK_TIMEOUT_SECONDS", "30"))
        )
        stream_no_text_timeout_seconds = max(
            10, int(os.getenv("LLM_STREAM_NO_TEXT_TIMEOUT_SECONDS", "45"))
        )
        article_chunk_chars = max(
            400, int(os.getenv("ARTICLE_CHAT_RETRIEVAL_CHUNK_CHARS", "900"))
        )
        article_overlap_chars = max(
            0, int(os.getenv("ARTICLE_CHAT_RETRIEVAL_OVERLAP_CHARS", "140"))
        )
        article_top_k = max(
            3, int(os.getenv("ARTICLE_CHAT_RETRIEVAL_TOP_K", "8"))
        )
        article_max_context_chars = max(
            2500, int(os.getenv("ARTICLE_CHAT_RETRIEVAL_MAX_CONTEXT_CHARS", "7000"))
        )

        message_content = [TextContent(text=formatted_prompt)]
        stream_file: FileContent | None = None
        article_snippet_map: dict[int, str] = {}

        is_web_article = str(paper.source_type or "").lower() == "web_article"
        if is_web_article or not paper.s3_object_key:
            raw_content = (paper.raw_content or "").strip()
            if not raw_content:
                raise ValueError(
                    "No readable article content found for this document."
                )

            conversation_texts = [
                str(message.content or "")
                for message in conversation_history
                if getattr(message, "content", None)
            ]
            article_snippets = select_relevant_article_snippets(
                raw_content,
                query=question,
                conversation_messages=conversation_texts,
                user_references=list(user_references or []),
                chunk_chars=article_chunk_chars,
                overlap_chars=article_overlap_chars,
                top_k=article_top_k,
                max_total_chars=article_max_context_chars,
            )
            article_snippet_map = {
                int(snippet.snippet_id): str(snippet.text)
                for snippet in article_snippets
            }
            snippet_block = build_article_snippet_block(article_snippets)
            retrieval_instructions = (
                "Use ONLY the snippets below as evidence for your answer.\n"
                "When producing the ---EVIDENCE--- block, @cite[n] must map to [SNIPPET n].\n"
                "Do not cite content that is not present in the snippets.\n"
                "If the snippets are insufficient, explicitly say: 论文未明确给出。"
            )
            message_content = [
                TextContent(
                    text=(
                        f"{formatted_prompt}\n\n"
                        f"{retrieval_instructions}\n\n"
                        f"{snippet_block}"
                    )
                ),
            ]
        else:
            signed_url = s3_service.get_cached_presigned_url(
                db,
                paper_id=str(paper.id),
                object_key=str(paper.s3_object_key),
                current_user=current_user,
            )

            if not signed_url:
                raise ValueError(
                    f"Could not generate presigned URL for paper with ID {paper_id}."
                )

            # Retrieve PDF bytes off the event loop to avoid blocking
            response = await asyncio.to_thread(
                partial(http_requests.get, signed_url, timeout=60)
            )
            response.raise_for_status()
            pdf_bytes = response.content

            stream_file = FileContent(
                data=pdf_bytes,
                mime_type="application/pdf",
                filename=f"{paper.title or 'paper'}.pdf",
            )

        stream_queue: asyncio.Queue[object] = asyncio.Queue()
        stream_done = object()

        async def stream_reader() -> None:
            sentinel = object()

            def get_next_chunk(iterator):
                try:
                    return next(iterator)
                except StopIteration:
                    return sentinel

            try:
                blocking_iterator = self.send_message_stream(
                    message=message_content,
                    file=stream_file,
                    system_prompt=formatted_system_prompt,
                    history=conversation_history,
                    provider=llm_provider,
                )
                while True:
                    chunk = await asyncio.to_thread(get_next_chunk, blocking_iterator)
                    if chunk is sentinel:
                        break
                    await stream_queue.put(chunk)
            except Exception as exc:
                logger.warning(
                    "chat_with_paper stream reader failed: %s: %s",
                    type(exc).__name__,
                    str(exc)[:200],
                )
                await stream_queue.put(exc)
            finally:
                await stream_queue.put(stream_done)

        stream_reader_task = asyncio.create_task(stream_reader())
        last_text_chunk_time = time.monotonic()

        try:
            while True:
                try:
                    queued = await asyncio.wait_for(
                        stream_queue.get(),
                        timeout=stream_chunk_timeout_seconds,
                    )
                except asyncio.TimeoutError as exc:
                    raise TimeoutError("The read operation timed out") from exc

                if queued is stream_done:
                    break

                if isinstance(queued, Exception):
                    raise queued

                chunk = queued
                text = getattr(chunk, "text", "")
                logger.debug(f"Received chunk: {text}")

                if not text:
                    idle_seconds = time.monotonic() - last_text_chunk_time
                    if idle_seconds >= stream_no_text_timeout_seconds:
                        raise TimeoutError(
                            "The read operation timed out (no text chunk received)"
                        )
                    continue

                last_text_chunk_time = time.monotonic()
                text_buffer += text

                # Check for start delimiter
                if not in_evidence_section and START_DELIMITER in text_buffer:
                    in_evidence_section = True
                    # Split at delimiter and yield any content that came before
                    pre_evidence = text_buffer.split(START_DELIMITER)[0]
                    if pre_evidence:
                        yield {"type": "content", "content": pre_evidence}
                    # Start the evidence buffer
                    evidence_buffer = [text_buffer.split(START_DELIMITER)[1]]
                    # Clear the text buffer
                    text_buffer = ""
                    continue

                reconstructed_buffer = "".join(evidence_buffer + [text_buffer]).strip()

                if in_evidence_section and END_DELIMITER in reconstructed_buffer:
                    # Find the position of the delimiter in the reconstructed buffer
                    delimiter_pos = reconstructed_buffer.find(END_DELIMITER)
                    evidence_part = reconstructed_buffer[:delimiter_pos]
                    remaining = reconstructed_buffer[
                        delimiter_pos + len(END_DELIMITER) :
                    ]

                    # Parse the complete evidence block
                    structured_evidence = CitationHandler.parse_evidence_block(
                        evidence_part
                    )
                    if article_snippet_map:
                        structured_evidence = self._normalize_article_evidence(
                            citations=structured_evidence,
                            snippet_map=article_snippet_map,
                        )

                    # Yield both raw and structured evidence
                    yield {
                        "type": "references",
                        "content": {
                            "citations": structured_evidence,
                        },
                    }

                    # Reset buffers and state
                    in_evidence_section = False
                    evidence_buffer = []
                    text_buffer = remaining

                    # Yield any remaining content after evidence section
                    if remaining:
                        yield {"type": "content", "content": remaining}
                    continue

                # Handle normal streaming
                if in_evidence_section:
                    evidence_buffer.append(text)
                    text_buffer = ""
                else:
                    # Keep a reasonable buffer size for detecting delimiters
                    if len(text_buffer) > len(START_DELIMITER) * 2:
                        to_yield = text_buffer[: -len(START_DELIMITER)]
                        yield {"type": "content", "content": to_yield}
                        text_buffer = text_buffer[-len(START_DELIMITER) :]
        finally:
            if not stream_reader_task.done():
                stream_reader_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stream_reader_task

        if text_buffer:
            yield {"type": "content", "content": text_buffer}
