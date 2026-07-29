"""Apple "Hide My Email" → Google account-linking endpoint guards.
The full merge path (apple_sub moved, relay deleted, session minted for the
target) is covered in-process with a mocked Google verifier — these HTTP tests
lock down the auth/safety guards that protect it."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


def test_link_google_requires_auth():
    r = requests.post(f"{BASE_URL}/api/auth/link-google", json={"credential": "x"}, timeout=15)
    assert r.status_code == 401, r.text


def test_link_google_rejects_non_relay_accounts():
    """QA user has a video (and no relay email) — merging must be refused
    BEFORE any Google verification happens."""
    r = requests.post(
        f"{BASE_URL}/api/auth/link-google", headers=HEADERS,
        json={"credential": "irrelevant"}, timeout=15,
    )
    assert r.status_code == 400, r.text


def test_link_google_bad_credential_rejected_for_relay_account():
    """A genuine empty relay account passes the merge guard but a forged
    Google credential must still be rejected with 401."""
    uid = f"t-relay-{uuid.uuid4().hex[:8]}"
    tok = f"sttest_relay_{uuid.uuid4().hex}"
    db.users.insert_one({
        "id": uid, "email": f"{uid}@privaterelay.appleid.com",
        "apple_sub": f"apple-{uid}", "codename": "Relay Test", "handle": None,
        "video_url": None, "created_at": datetime.now(timezone.utc).isoformat(),
    })
    db.user_sessions.insert_one({
        "user_id": uid, "session_token": tok,
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        "created_at": datetime.now(timezone.utc),
    })
    try:
        r = requests.post(
            f"{BASE_URL}/api/auth/link-google",
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
            json={"credential": "forged.jwt.credential"}, timeout=15,
        )
        assert r.status_code == 401, r.text
        assert db.users.find_one({"id": uid}) is not None, "relay account must survive a failed link"
    finally:
        db.users.delete_one({"id": uid})
        db.user_sessions.delete_many({"user_id": uid})
