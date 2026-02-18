import json
import os
import sys
import uuid
from dataclasses import dataclass
from typing import Callable
from unittest.mock import patch

from dotenv import load_dotenv
from fastapi.testclient import TestClient

from app.database.database import SessionLocal
from app.database.models import Paper, TranslationUsageLog, User
from app.llm.provider import LLMProvider
from app.main import app

TRANSLATION_GENERATE_PATCH_TARGET = (
    "app.llm.translation_operations.translation_operations.llm_client.generate_content_resilient"
)


@dataclass
class StepResult:
    name: str
    passed: bool
    details: str = ""


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _build_fake_llm_response() -> Callable:
    class DummyResponse:
        def __init__(self, text: str):
            self.text = text

    def fake_generate_content(*args, **kwargs):
        contents = kwargs.get("contents") if kwargs else None
        if contents is None and len(args) > 1:
            contents = args[1]
        prompt = str(contents or "")

        mode = "sentence"
        for marker in ("Mode: word", "Mode: term", "Mode: sentence", "Mode: formula"):
            if marker in prompt:
                mode = marker.split(": ")[1]
                break

        if mode in {"word", "term"}:
            payload = {
                "ipa_us": "/ˈmɪtəˌɡeɪt/",
                "ipa_uk": "/ˈmɪtɪɡeɪt/",
                "pos": "verb",
                "primary_translation_cn": "缓解",
                "context_translation_cn": "在本文中表示降低不利影响",
                "meaning_explainer_cn": "作者强调减少负面后果，不是彻底消除。",
                "usage_notes_cn": ["常搭配 risk / bias / impact"],
                "collocations": ["mitigate risk", "mitigate bias"],
                "example_context_en": "Our method mitigates domain shift.",
                "example_context_cn": "我们的方法能缓解域偏移。",
                "example_general_en": "Policies can mitigate climate risks.",
                "example_general_cn": "政策可以缓解气候风险。",
            }
        elif mode == "formula":
            payload = {
                "concise_translation_cn": "这是二次复杂度。",
                "formula_explain_cn": "当输入规模翻倍时，计算量约增加四倍。",
                "symbols_notes_cn": ["n 表示输入规模", "^2 表示平方关系"],
                "one_line_takeaway_cn": "复杂度随规模平方增长。",
            }
        else:
            payload = {
                "concise_translation_cn": "该方法在跨域测试中显著提高了泛化性能。",
                "literal_translation_cn": "该方法在跨域测试中明显提升了泛化表现。",
                "key_terms": [
                    {"en": "cross-domain", "cn": "跨域"},
                    {"en": "generalization", "cn": "泛化"},
                ],
                "one_line_explain_cn": "强调的是分布变化下的稳健提升。",
            }

        return DummyResponse(json.dumps(payload, ensure_ascii=False))

    return fake_generate_content


def _get_dev_user_and_paper_id(client: TestClient) -> tuple[str, str]:
    # Trigger dev auto-login bootstrap
    usage_resp = client.get("/api/subscription/usage")
    _assert(
        usage_resp.status_code == 200,
        f"Expected /api/subscription/usage=200, got {usage_resp.status_code}",
    )

    dev_email = os.getenv("DEV_USER_EMAIL", "dev@openpaper.local")
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == dev_email).first()
        _assert(user is not None, f"Dev user {dev_email} was not created")

        paper = (
            db.query(Paper)
            .filter(Paper.user_id == user.id, Paper.title == "E2E Translation Paper")
            .first()
        )
        if not paper:
            raw_content = (
                "We mitigate domain shift using adaptation layers. "
                "Our method improves cross-domain generalization. "
                "The cost is O(n^2) in the worst case."
            )
            paper = Paper(
                id=uuid.uuid4(),
                user_id=user.id,
                file_url="http://localhost/fake.pdf",
                title="E2E Translation Paper",
                abstract="test",
                raw_content=raw_content,
                page_offset_map={"1": [0, len(raw_content)]},
                status="reading",
            )
            db.add(paper)
            db.commit()
            db.refresh(paper)

        return str(user.id), str(paper.id)


def _get_or_create_ambiguous_paper_id(user_id: str) -> str:
    user_uuid = uuid.UUID(user_id)
    with SessionLocal() as db:
        paper = (
            db.query(Paper)
            .filter(
                Paper.user_id == user_uuid,
                Paper.title == "E2E Ambiguous Translation Paper",
            )
            .first()
        )
        if not paper:
            raw_content = (
                "First marker context: the river bank collapsed after heavy rain. "
                + (" filler" * 120)
                + " Second marker context: the finance committee opened a bank account "
                "to deposit grant funds safely."
            )
            paper = Paper(
                id=uuid.uuid4(),
                user_id=user_uuid,
                file_url="http://localhost/fake-ambiguous.pdf",
                title="E2E Ambiguous Translation Paper",
                abstract="test",
                raw_content=raw_content,
                page_offset_map={"1": [0, len(raw_content)]},
                status="reading",
            )
            db.add(paper)
            db.commit()
            db.refresh(paper)
        return str(paper.id)


def run() -> int:
    load_dotenv(".env")
    client = TestClient(app)
    results: list[StepResult] = []

    def step(name: str, fn: Callable[[], None]) -> None:
        try:
            fn()
            results.append(StepResult(name=name, passed=True))
        except Exception as e:
            results.append(StepResult(name=name, passed=False, details=str(e)))

    user_id, paper_id = _get_dev_user_and_paper_id(client)
    ambiguous_paper_id = _get_or_create_ambiguous_paper_id(user_id)
    user_uuid = uuid.UUID(user_id)
    paper_uuid = uuid.UUID(paper_id)

    fake_generate_content = _build_fake_llm_response()

    def case_word_and_cache():
        with patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=fake_generate_content,
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "mitigate",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r1 = client.post("/api/translate/selection", json=payload)
            _assert(r1.status_code == 200, f"first call status={r1.status_code}")
            b1 = r1.json()
            _assert(b1["mode"] in ("word", "term"), f"unexpected mode {b1['mode']}")
            _assert(b1["meta"]["cached"] is False, "first call should not be cached")

            with SessionLocal() as db:
                n_logs_before = (
                    db.query(TranslationUsageLog)
                    .filter(
                        TranslationUsageLog.user_id == user_uuid,
                        TranslationUsageLog.paper_id == paper_uuid,
                    )
                    .count()
                )

            r2 = client.post("/api/translate/selection", json=payload)
            _assert(r2.status_code == 200, f"second call status={r2.status_code}")
            b2 = r2.json()
            _assert(b2["meta"]["cached"] is True, "second call should be cached")

            with SessionLocal() as db:
                n_logs_after = (
                    db.query(TranslationUsageLog)
                    .filter(
                        TranslationUsageLog.user_id == user_uuid,
                        TranslationUsageLog.paper_id == paper_uuid,
                    )
                    .count()
                )
            _assert(
                n_logs_after == n_logs_before,
                "cached response should not create extra usage log",
            )

    def case_sentence():
        with patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=fake_generate_content,
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "Our method improves cross-domain generalization.",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 200, f"sentence status={r.status_code}")
            body = r.json()
            _assert(body["mode"] == "sentence", f"expected sentence, got {body['mode']}")
            _assert(
                bool(body["result"]["concise_translation_cn"]),
                "concise sentence translation missing",
            )

    def case_formula():
        with patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=fake_generate_content,
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "O(n^2)",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 200, f"formula status={r.status_code}")
            body = r.json()
            _assert(body["mode"] == "formula", f"expected formula, got {body['mode']}")
            _assert(
                bool(body["result"]["formula_explain_cn"]),
                "formula explain missing",
            )

    def case_invalid_input():
        payload = {
            "paper_id": paper_id,
            "selected_text": "    ",
            "page_number": 1,
            "selection_type_hint": "auto",
            "target_language": "zh-CN",
        }
        r = client.post("/api/translate/selection", json=payload)
        _assert(r.status_code == 400, f"expected 400, got {r.status_code}")

    def case_quota_block():
        with patch("app.api.translation_api.can_user_run_chat", return_value=(False, "quota")):
            payload = {
                "paper_id": paper_id,
                "selected_text": "mitigate",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 429, f"expected 429, got {r.status_code}")

    def case_usage_aggregation():
        usage = client.get("/api/subscription/usage")
        _assert(usage.status_code == 200, f"usage status={usage.status_code}")
        body = usage.json()
        _assert(
            "chat_translation_credits_used" in body["usage"],
            "translation credits field missing in usage response",
        )
        _assert(
            body["usage"]["chat_translation_credits_used"] >= 0,
            "translation credits should be non-negative",
        )

    def case_llm_invalid_json_maps_to_503():
        class DummyResponse:
            def __init__(self, text: str):
                self.text = text

        with patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            return_value=DummyResponse("not-a-json-payload"),
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "illjsonprobe",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 503, f"expected 503, got {r.status_code}")
            body = r.json()
            _assert(
                "temporarily unavailable" in str(body.get("detail", "")).lower(),
                "provider-unavailable detail expected",
            )

    def case_openai_fallback():
        class DummyResponse:
            def __init__(self, text: str):
                self.text = text

        call_providers: list[LLMProvider | None] = []

        def flaky_primary_then_openai(*args, **kwargs):
            provider = kwargs.get("provider")
            call_providers.append(provider)
            if provider is None:
                raise RuntimeError("primary provider failed")
            if provider == LLMProvider.OPENAI:
                payload = {
                    "ipa_us": "/ˈfɔːlbæk/",
                    "ipa_uk": "/ˈfɔːlbæk/",
                    "pos": "noun",
                    "primary_translation_cn": "回退",
                    "context_translation_cn": "这里表示切换到备用模型",
                    "meaning_explainer_cn": "当主服务不可用时自动切换以保证可用性。",
                    "usage_notes_cn": ["常见于可靠性工程"],
                    "collocations": ["provider fallback"],
                    "example_context_en": "The service uses provider fallback.",
                    "example_context_cn": "该服务使用了模型回退机制。",
                    "example_general_en": "Fallback improves resilience.",
                    "example_general_cn": "回退机制提升系统韧性。",
                }
                return DummyResponse(json.dumps(payload, ensure_ascii=False))
            raise RuntimeError(f"unexpected provider: {provider}")

        with patch(
            "app.llm.translation_operations.translation_operations._can_use_openai_fallback",
            return_value=True,
        ), patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=flaky_primary_then_openai,
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "fallback",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 200, f"fallback status={r.status_code}")
            body = r.json()
            _assert(body["mode"] in ("word", "term"), "fallback mode should be word/term")
            _assert(
                call_providers == [None, LLMProvider.OPENAI],
                f"unexpected provider call order: {call_providers}",
            )

    def case_provider_failure_502():
        with patch(
            "app.llm.translation_operations.translation_operations._can_use_openai_fallback",
            return_value=False,
        ), patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=RuntimeError("provider down"),
        ):
            payload = {
                "paper_id": paper_id,
                "selected_text": "hardfailureprobe",
                "page_number": 1,
                "selection_type_hint": "auto",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 502, f"expected 502, got {r.status_code}")

    def case_paper_not_found_400():
        payload = {
            "paper_id": str(uuid.uuid4()),
            "selected_text": "mitigate",
            "page_number": 1,
            "selection_type_hint": "auto",
            "target_language": "zh-CN",
        }
        r = client.post("/api/translate/selection", json=payload)
        _assert(r.status_code == 400, f"expected 400, got {r.status_code}")

    def case_context_disambiguation_with_hints():
        captured_prompt: dict[str, str] = {}

        class DummyResponse:
            def __init__(self, text: str):
                self.text = text

        def fake_with_prompt_capture(*args, **kwargs):
            contents = kwargs.get("contents") if kwargs else None
            if contents is None and len(args) > 1:
                contents = args[1]
            captured_prompt["text"] = str(contents or "")

            payload = {
                "ipa_us": "/bæŋk/",
                "ipa_uk": "/bæŋk/",
                "pos": "noun",
                "primary_translation_cn": "银行",
                "context_translation_cn": "这里指金融机构",
                "meaning_explainer_cn": "结合上下文，bank 表示金融账户相关机构。",
                "usage_notes_cn": ["金融语境下常与 account 搭配"],
                "collocations": ["bank account"],
                "example_context_en": "The committee opened a bank account.",
                "example_context_cn": "委员会开设了一个银行账户。",
                "example_general_en": "I went to the bank yesterday.",
                "example_general_cn": "我昨天去了银行。",
            }
            return DummyResponse(json.dumps(payload, ensure_ascii=False))

        with patch(
            TRANSLATION_GENERATE_PATCH_TARGET,
            side_effect=fake_with_prompt_capture,
        ):
            payload = {
                "paper_id": ambiguous_paper_id,
                "selected_text": "bank",
                "page_number": 1,
                "selection_type_hint": "auto",
                "context_before": "the finance committee opened a",
                "context_after": "account to deposit grant funds",
                "target_language": "zh-CN",
            }
            r = client.post("/api/translate/selection", json=payload)
            _assert(r.status_code == 200, f"context disambiguation status={r.status_code}")
            body = r.json()
            _assert(body["mode"] in ("word", "term"), f"unexpected mode {body['mode']}")

            prompt_text = captured_prompt.get("text", "").lower()
            _assert("finance committee opened a" in prompt_text, "expected finance context")
            _assert("account to deposit grant funds" in prompt_text, "expected deposit context")
            _assert(
                body["meta"]["context_relevance_score"] >= 0.9,
                "context relevance should be high with disambiguation hints",
            )

    step("Word Translation + Cache", case_word_and_cache)
    step("Sentence Translation", case_sentence)
    step("Formula Translation", case_formula)
    step("Invalid Input Handling", case_invalid_input)
    step("Quota Block Handling", case_quota_block)
    step("Subscription Usage Aggregation", case_usage_aggregation)
    step("Invalid LLM JSON -> 503", case_llm_invalid_json_maps_to_503)
    step("Primary Failure -> OpenAI Fallback", case_openai_fallback)
    step("Provider Failure -> 502", case_provider_failure_502)
    step("Paper Not Found -> 400", case_paper_not_found_400)
    step("Context Disambiguation with Hints", case_context_disambiguation_with_hints)

    failed = [r for r in results if not r.passed]
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        print(f"[{status}] {r.name}")
        if r.details:
            print(f"       {r.details}")

    if failed:
        print(f"\nE2E failed: {len(failed)} step(s) failed.")
        return 1

    print("\nE2E passed: all translation feature steps succeeded.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
