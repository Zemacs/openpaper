from dataclasses import dataclass, field
from typing import Optional

from src.web_extract.rules_store import get_promoted_adapter_for_host


@dataclass
class DomainAdapter:
    name: str
    host_suffixes: tuple[str, ...]
    html_container_patterns: tuple[str, ...] = field(default_factory=tuple)
    drop_text_patterns: tuple[str, ...] = field(default_factory=tuple)


ADAPTERS: tuple[DomainAdapter, ...] = (
    DomainAdapter(
        name="medium",
        host_suffixes=("medium.com",),
        html_container_patterns=(
            r"<article[^>]*>(.*?)</article>",
            r'<div[^>]+class=["\'][^"\']*section-content[^"\']*["\'][^>]*>(.*?)</div>',
        ),
        drop_text_patterns=(
            r"Follow\s+Me",
            r"Sign up",
            r"Get unlimited access",
        ),
    ),
    DomainAdapter(
        name="substack",
        host_suffixes=("substack.com",),
        html_container_patterns=(
            r"<article[^>]*>(.*?)</article>",
            r'<div[^>]+class=["\'][^"\']*body[^"\']*["\'][^>]*>(.*?)</div>',
        ),
    ),
    DomainAdapter(
        name="arxiv",
        host_suffixes=("arxiv.org",),
        html_container_patterns=(
            r'<main[^>]*>(.*?)</main>',
            r'<div[^>]+id=["\']abs["\'][^>]*>(.*?)</div>',
        ),
        drop_text_patterns=(
            r"Submitters?:.*",
            r"Subjects?:.*",
        ),
    ),
)


def get_adapter_for_host(host: str) -> Optional[DomainAdapter]:
    lowered = (host or "").lower()

    promoted = get_promoted_adapter_for_host(lowered)
    if promoted:
        promoted_patterns = tuple(promoted.get("container_regexes", []))
        if promoted_patterns:
            promoted_drop_patterns = tuple(promoted.get("drop_text_patterns", []))
            return DomainAdapter(
                name=str(promoted.get("name", f"llm-promoted:{lowered}")),
                host_suffixes=tuple(promoted.get("host_suffixes", [lowered])),
                html_container_patterns=promoted_patterns,
                drop_text_patterns=promoted_drop_patterns,
            )

    for adapter in ADAPTERS:
        if any(lowered.endswith(suffix) for suffix in adapter.host_suffixes):
            return adapter
    return None
