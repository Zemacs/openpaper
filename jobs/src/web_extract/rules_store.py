import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Optional

import fcntl


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


STORE_FILE_PATH = os.getenv(
    "WEB_EXTRACTION_RULE_STORE_PATH",
    str(Path(__file__).resolve().parents[2] / ".state" / "web_extract_rules.json"),
)
REPLAY_MAX_SAMPLES_PER_HOST = _env_int("WEB_EXTRACTION_REPLAY_MAX_SAMPLES", 20)
REPLAY_MAX_HTML_CHARS = _env_int("WEB_EXTRACTION_REPLAY_MAX_HTML_CHARS", 120_000)


def _default_state() -> dict[str, Any]:
    return {
        "version": 1,
        "generated_rules": {},
        "promoted_adapters": {},
        "replay_samples": {},
    }


def _store_path() -> Path:
    return Path(STORE_FILE_PATH)


def _ensure_store() -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(json.dumps(_default_state(), ensure_ascii=False), encoding="utf-8")


@contextmanager
def _locked_state() -> Any:
    _ensure_store()
    path = _store_path()
    with path.open("r+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            handle.seek(0)
            raw = handle.read().strip()
            if raw:
                try:
                    state = json.loads(raw)
                except json.JSONDecodeError:
                    state = _default_state()
            else:
                state = _default_state()

            for key, fallback in _default_state().items():
                state.setdefault(key, fallback.copy() if isinstance(fallback, dict) else fallback)

            yield state

            handle.seek(0)
            handle.truncate()
            handle.write(json.dumps(state, ensure_ascii=False))
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_state() -> dict[str, Any]:
    with _locked_state() as state:
        return json.loads(json.dumps(state))


def mutate_state(mutator: Callable[[dict[str, Any]], Any]) -> Any:
    with _locked_state() as state:
        return mutator(state)


def get_generated_rule(host: str) -> Optional[dict[str, Any]]:
    lowered = (host or "").strip().lower()
    if not lowered:
        return None
    state = read_state()
    rule = state.get("generated_rules", {}).get(lowered)
    return rule if isinstance(rule, dict) else None


def save_generated_rule(host: str, rule: dict[str, Any]) -> None:
    lowered = (host or "").strip().lower()
    if not lowered:
        return

    payload = {**rule, "host": lowered, "generated_at": float(rule.get("generated_at", time.time()))}

    def _mutate(state: dict[str, Any]) -> None:
        generated = state.setdefault("generated_rules", {})
        generated[lowered] = payload

    mutate_state(_mutate)


def save_promoted_adapter(host: str, adapter_payload: dict[str, Any]) -> None:
    lowered = (host or "").strip().lower()
    if not lowered:
        return

    promoted_payload = {
        **adapter_payload,
        "host": lowered,
        "promoted_at": float(adapter_payload.get("promoted_at", time.time())),
    }

    def _mutate(state: dict[str, Any]) -> None:
        promoted = state.setdefault("promoted_adapters", {})
        promoted[lowered] = promoted_payload

    mutate_state(_mutate)


def get_promoted_adapter_for_host(host: str) -> Optional[dict[str, Any]]:
    lowered = (host or "").strip().lower()
    if not lowered:
        return None

    state = read_state()
    promoted = state.get("promoted_adapters", {})
    if not isinstance(promoted, dict):
        return None

    direct = promoted.get(lowered)
    if isinstance(direct, dict):
        return direct

    # suffix match to support subdomains
    for key, value in promoted.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        if lowered == key or lowered.endswith(f".{key}"):
            return value
    return None


def record_replay_sample(host: str, *, url: str, content_type: str, payload: str) -> None:
    lowered = (host or "").strip().lower()
    if not lowered:
        return

    sample = {
        "url": url,
        "content_type": content_type,
        "payload": (payload or "")[:REPLAY_MAX_HTML_CHARS],
        "captured_at": time.time(),
    }

    def _mutate(state: dict[str, Any]) -> None:
        replay_samples = state.setdefault("replay_samples", {})
        samples = replay_samples.setdefault(lowered, [])
        samples.append(sample)
        # keep newest N
        if len(samples) > REPLAY_MAX_SAMPLES_PER_HOST:
            replay_samples[lowered] = samples[-REPLAY_MAX_SAMPLES_PER_HOST:]

    mutate_state(_mutate)


def get_replay_samples(host: str, *, limit: Optional[int] = None) -> list[dict[str, Any]]:
    lowered = (host or "").strip().lower()
    if not lowered:
        return []

    state = read_state()
    samples = state.get("replay_samples", {}).get(lowered, [])
    if not isinstance(samples, list):
        return []
    if limit is None or limit <= 0:
        return samples
    return samples[-limit:]
