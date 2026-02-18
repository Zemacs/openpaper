import logging
import os
import time
from enum import Enum
from typing import Any, Dict, Iterator, List, Optional

from app.database.models import Message
from app.database.telemetry import track_event
from app.llm.provider import (
    BaseLLMProvider,
    FileContent,
    GeminiProvider,
    LLMProvider,
    LLMResponse,
    MessageParam,
    OpenAIProvider,
    StreamChunk,
    ToolCallResult,
)
from app.llm.utils import is_transient_llm_error, retry_llm_operation

logger = logging.getLogger(__name__)


class ModelType(Enum):
    DEFAULT = "default"
    FAST = "fast"


class BaseLLMClient:
    """Unified LLM client that supports multiple providers"""

    def __init__(self, default_provider: LLMProvider = LLMProvider.GEMINI):
        self.default_provider = default_provider
        self._providers: Dict[LLMProvider, BaseLLMProvider] = {}
        self.content_retry_max = max(
            0, int(os.getenv("LLM_CONTENT_RETRY_MAX", "1"))
        )
        self.stream_retry_max = max(
            0, int(os.getenv("LLM_STREAM_RETRY_MAX", "2"))
        )
        self.transient_retry_delay_seconds = max(
            0.1, float(os.getenv("LLM_TRANSIENT_RETRY_DELAY_SECONDS", "0.8"))
        )

        # Initialize the default provider; others are initialized on demand
        self._initialize_provider(default_provider)

    def get_chat_model_options(self) -> Dict[LLMProvider, str]:
        def _get_display_name(model_name: str) -> str:
            """Format model name for display"""
            split_by_dash = model_name.split("-")
            if len(split_by_dash) > 1:
                return "-".join([part.lower() for part in split_by_dash[:2]])
            return model_name.lower()

        """Get available models for each provider"""
        return {
            provider: _get_display_name(
                self._get_model_for_type(ModelType.DEFAULT, provider)
            )
            for provider in self._providers.keys()
        }

    def _initialize_provider(self, provider: LLMProvider) -> None:
        """Initialize a provider if not already done"""
        if provider not in self._providers:
            if provider == LLMProvider.GEMINI:
                self._providers[provider] = GeminiProvider()
            elif provider == LLMProvider.OPENAI:
                self._providers[provider] = OpenAIProvider()
            elif provider == LLMProvider.GROQ:
                # Custom OpenAI-compatible provider using a separate base URL and API key.
                # These can be configured via environment variables or another config layer.
                custom_api_key = os.getenv("GROQ_API_KEY")
                custom_base_url = os.getenv("GROQ_BASE_URL")

                self._providers[provider] = OpenAIProvider(
                    api_key=custom_api_key,
                    base_url=custom_base_url,
                    default_model="openai/gpt-oss-120b",
                    fast_model="moonshotai/kimi-k2-instruct-0905",
                )
            elif provider == LLMProvider.CEREBRAS:
                self._providers[provider] = OpenAIProvider(
                    api_key=os.getenv("CEREBRAS_API_KEY"),
                    base_url=os.getenv("CEREBRAS_BASE_URL"),
                    default_model="gpt-oss-120b",
                    fast_model="zai-glm-4.7",
                )
            else:
                raise ValueError(f"Unsupported LLM provider: {provider}")

    def _get_provider(self, provider: Optional[LLMProvider] = None) -> BaseLLMProvider:
        """Get the appropriate provider, initializing if necessary"""
        target_provider = provider or self.default_provider

        if target_provider not in self._providers:
            self._initialize_provider(target_provider)

        return self._providers[target_provider]

    def _get_model_for_type(
        self, model_type: ModelType, provider: Optional[LLMProvider] = None
    ) -> str:
        """Get the appropriate model string for the given type and provider"""
        provider_instance = self._get_provider(provider)

        if model_type == ModelType.DEFAULT:
            return provider_instance.get_default_model()
        elif model_type == ModelType.FAST:
            return provider_instance.get_fast_model()
        else:
            raise ValueError(f"Unsupported model type: {model_type}")

    def _generate_content_impl(
        self,
        contents: Any,
        system_prompt: Optional[str] = None,
        history: Optional[List[Message]] = None,
        function_declarations: Optional[List[Dict]] = None,
        tool_call_results: Optional[List[ToolCallResult]] = None,
        model_type: ModelType = ModelType.DEFAULT,
        provider: Optional[LLMProvider] = None,
        enable_thinking: bool = True,
        schema: Optional[Dict] = None,
        **kwargs,
    ) -> LLMResponse:
        """Generate content using the specified provider."""
        start_time = time.time()
        model = self._get_model_for_type(model_type, provider)
        target_provider = provider or self.default_provider

        try:
            response = self._get_provider(provider).generate_content(
                model,
                contents,
                system_prompt=system_prompt,
                function_declarations=function_declarations,
                tool_call_results=tool_call_results,
                history=history,
                enable_thinking=enable_thinking,
                schema=schema,
                **kwargs,
            )

            end_time = time.time()
            duration_ms = (end_time - start_time) * 1000

            # Track the event with model and timing information
            track_event(
                "llm_generate_content",
                {
                    "model": model,
                    "provider": target_provider.value,
                    "model_type": model_type.value,
                    "duration_ms": duration_ms,
                    "has_function_declarations": function_declarations is not None,
                    "enable_thinking": enable_thinking,
                },
            )

            logger.info(
                f"Generated content using {target_provider.value}/{model} in {duration_ms:.2f}ms"
            )

            return response
        except Exception as e:
            end_time = time.time()
            duration_ms = (end_time - start_time) * 1000

            # Track failures too
            track_event(
                "llm_generate_content_error",
                {
                    "model": model,
                    "provider": target_provider.value,
                    "model_type": model_type.value,
                    "duration_ms": duration_ms,
                    "error": str(e),
                },
            )

            logger.error(
                f"Error generating content with {target_provider.value}/{model}: {e}"
            )
            raise

    @retry_llm_operation(max_retries=3, delay=1.0)
    def generate_content(
        self,
        contents: Any,
        system_prompt: Optional[str] = None,
        history: Optional[List[Message]] = None,
        function_declarations: Optional[List[Dict]] = None,
        tool_call_results: Optional[List[ToolCallResult]] = None,
        model_type: ModelType = ModelType.DEFAULT,
        provider: Optional[LLMProvider] = None,
        enable_thinking: bool = True,
        schema: Optional[Dict] = None,
        **kwargs,
    ) -> LLMResponse:
        """Generate content using the specified provider. Automatically retries on transient errors.

        Args:
            schema: Optional JSON schema dict for structured output. When provided,
                the LLM response will be constrained to match this schema via
                the provider's native structured output support.
        """
        return self._generate_content_impl(
            contents=contents,
            system_prompt=system_prompt,
            history=history,
            function_declarations=function_declarations,
            tool_call_results=tool_call_results,
            model_type=model_type,
            provider=provider,
            enable_thinking=enable_thinking,
            schema=schema,
            **kwargs,
        )

    def generate_content_once(
        self,
        contents: Any,
        system_prompt: Optional[str] = None,
        history: Optional[List[Message]] = None,
        function_declarations: Optional[List[Dict]] = None,
        tool_call_results: Optional[List[ToolCallResult]] = None,
        model_type: ModelType = ModelType.DEFAULT,
        provider: Optional[LLMProvider] = None,
        enable_thinking: bool = True,
        schema: Optional[Dict] = None,
        **kwargs,
    ) -> LLMResponse:
        """Generate content once without retry policy."""
        return self._generate_content_impl(
            contents=contents,
            system_prompt=system_prompt,
            history=history,
            function_declarations=function_declarations,
            tool_call_results=tool_call_results,
            model_type=model_type,
            provider=provider,
            enable_thinking=enable_thinking,
            schema=schema,
            **kwargs,
        )

    def generate_content_resilient(
        self,
        contents: Any,
        system_prompt: Optional[str] = None,
        history: Optional[List[Message]] = None,
        function_declarations: Optional[List[Dict]] = None,
        tool_call_results: Optional[List[ToolCallResult]] = None,
        model_type: ModelType = ModelType.DEFAULT,
        provider: Optional[LLMProvider] = None,
        enable_thinking: bool = True,
        schema: Optional[Dict] = None,
        max_retries: Optional[int] = None,
        **kwargs,
    ) -> LLMResponse:
        retry_max = (
            self.content_retry_max if max_retries is None else max(0, max_retries)
        )
        attempt = 0

        while True:
            try:
                return self._generate_content_impl(
                    contents=contents,
                    system_prompt=system_prompt,
                    history=history,
                    function_declarations=function_declarations,
                    tool_call_results=tool_call_results,
                    model_type=model_type,
                    provider=provider,
                    enable_thinking=enable_thinking,
                    schema=schema,
                    **kwargs,
                )
            except Exception as e:
                if attempt >= retry_max or not is_transient_llm_error(e):
                    raise

                backoff = self.transient_retry_delay_seconds * (2**attempt)
                logger.warning(
                    f"Transient LLM error in generate_content_resilient (attempt {attempt + 1}/{retry_max + 1}): {type(e).__name__}: {str(e)[:120]}. Retrying in {backoff:.2f}s."
                )
                time.sleep(backoff)
                attempt += 1

    def send_message_stream(
        self,
        message: MessageParam,
        history: List[Message],
        system_prompt: str,
        file: FileContent | None = None,
        model_type: ModelType = ModelType.DEFAULT,
        provider: Optional[LLMProvider] = None,
        **kwargs,
    ) -> Iterator[StreamChunk]:
        """Send a message and stream the response with transient retry before first chunk."""
        model = self._get_model_for_type(model_type, provider)
        provider_instance = self._get_provider(provider)
        attempt = 0

        while True:
            emitted_chunk = False
            try:
                for chunk in provider_instance.send_message_stream(
                    model, message, history, system_prompt, file, **kwargs
                ):
                    emitted_chunk = True
                    yield chunk
                return
            except Exception as e:
                should_retry = (
                    attempt < self.stream_retry_max
                    and not emitted_chunk
                    and is_transient_llm_error(e)
                )
                if not should_retry:
                    raise

                backoff = self.transient_retry_delay_seconds * (2**attempt)
                logger.warning(
                    f"Transient stream error (attempt {attempt + 1}/{self.stream_retry_max + 1}): {type(e).__name__}: {str(e)[:120]}. Retrying in {backoff:.2f}s."
                )
                time.sleep(backoff)
                attempt += 1

    # Convenience properties for backward compatibility
    @property
    def default_model(self) -> str:
        return self._get_model_for_type(ModelType.DEFAULT)

    @property
    def fast_model(self) -> str:
        return self._get_model_for_type(ModelType.FAST)
