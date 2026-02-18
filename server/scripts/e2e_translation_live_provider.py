import os
import sys
import time

from dotenv import load_dotenv
from fastapi.testclient import TestClient

from app.database.database import SessionLocal
from app.database.models import Paper, User
from app.main import app


def _is_enabled() -> bool:
    return os.getenv("E2E_LIVE_TRANSLATION", "false").lower() in {"1", "true", "yes"}


def _has_valid_gemini_key() -> bool:
    key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not key:
        return False
    if key.startswith("your-") or key.startswith("your_"):
        return False
    return True


def _get_dev_user_and_paper_id(client: TestClient) -> tuple[str, str]:
    usage_resp = client.get("/api/subscription/usage")
    if usage_resp.status_code != 200:
        raise RuntimeError(
            f"Expected /api/subscription/usage=200, got {usage_resp.status_code}"
        )

    dev_email = os.getenv("DEV_USER_EMAIL", "dev@openpaper.local")
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == dev_email).first()
        if user is None:
            raise RuntimeError(f"Dev user {dev_email} was not created")

        paper = (
            db.query(Paper)
            .filter(Paper.user_id == user.id, Paper.title == "E2E Translation Paper")
            .first()
        )
        if paper is None:
            raise RuntimeError(
                "E2E Translation Paper not found. Run e2e_translation_feature.py first."
            )

        return str(user.id), str(paper.id)


def run() -> int:
    load_dotenv(".env")

    if not _is_enabled():
        print("[SKIP] Live provider smoke is disabled. Set E2E_LIVE_TRANSLATION=true to enable.")
        return 0

    if not _has_valid_gemini_key():
        print("[SKIP] GEMINI_API_KEY missing or placeholder; skipping live provider smoke.")
        return 0

    client = TestClient(app)
    _, paper_id = _get_dev_user_and_paper_id(client)

    payload = {
        "paper_id": paper_id,
        "selected_text": "Our method improves cross-domain generalization.",
        "page_number": 1,
        "selection_type_hint": "auto",
        "target_language": "zh-CN",
    }

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        response = client.post("/api/translate/selection", json=payload)
        if response.status_code == 200:
            body = response.json()
            mode = body.get("mode")
            result = body.get("result") or {}
            concise = result.get("concise_translation_cn")
            if mode != "sentence":
                print(f"[FAIL] Expected sentence mode, got: {mode}")
                return 1
            if not concise:
                print("[FAIL] concise_translation_cn is empty in live response.")
                return 1
            print("[PASS] Live provider translation smoke succeeded.")
            return 0

        if response.status_code in {502, 503, 504} and attempt < max_attempts:
            print(
                f"[WARN] Attempt {attempt}/{max_attempts} failed with {response.status_code}, retrying..."
            )
            time.sleep(2)
            continue

        print(f"[FAIL] Live provider smoke failed with status={response.status_code}")
        print(response.text)
        return 1

    print("[FAIL] Live provider smoke exhausted retries.")
    return 1


if __name__ == "__main__":
    sys.exit(run())
