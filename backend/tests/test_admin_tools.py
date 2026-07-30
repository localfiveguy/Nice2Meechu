"""Admin founder tools: /admin/find-user and /admin/delete-user.
The QA account is on ADMIN_EMAILS, so the endpoints are exercised for real."""
import os
import uuid
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
AUTH = {"Authorization": f"Bearer {TOKEN}"}
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


def _seed(uid):
    db.users.insert_one({
        "id": uid, "email": f"{uid}@example.com", "codename": "Dup Test Falcon",
        "first_name": "Duppy", "handle": None, "home_city": "Marlton, NJ, USA",
        "city": "Marlton, NJ, USA", "video_url": None, "is_demo": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


def test_find_and_delete_user_roundtrip():
    uid = f"tt-dup-{uuid.uuid4().hex[:8]}"
    _seed(uid)
    try:
        r = requests.get(f"{BASE_URL}/api/admin/find-user", params={"q": "Duppy"},
                         headers=AUTH, timeout=15)
        assert r.status_code == 200, r.text
        hits = [u for u in r.json()["users"] if u["id"] == uid]
        assert hits and hits[0]["delete_url"].endswith(f"id={uid}&confirm=DELETE")

        # missing confirm → refused, user survives
        r = requests.get(f"{BASE_URL}/api/admin/delete-user", params={"id": uid},
                         headers=AUTH, timeout=15)
        assert r.status_code == 400, r.text
        assert db.users.find_one({"id": uid}) is not None

        r = requests.get(f"{BASE_URL}/api/admin/delete-user",
                         params={"id": uid, "confirm": "DELETE"}, headers=AUTH, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["deleted"] == uid
        assert db.users.find_one({"id": uid}) is None
    finally:
        db.users.delete_one({"id": uid})


def test_delete_refuses_admin_and_demo_accounts():
    qa = db.users.find_one({"email": "qa-tester@nice2meechu.local"}, {"id": 1})
    r = requests.get(f"{BASE_URL}/api/admin/delete-user",
                     params={"id": qa["id"], "confirm": "DELETE"}, headers=AUTH, timeout=15)
    assert r.status_code == 403, r.text

    demo = db.users.find_one({"is_demo": True}, {"id": 1})
    if demo:
        r = requests.get(f"{BASE_URL}/api/admin/delete-user",
                         params={"id": demo["id"], "confirm": "DELETE"}, headers=AUTH, timeout=15)
        assert r.status_code == 403, r.text


def test_admin_tools_require_admin():
    r = requests.get(f"{BASE_URL}/api/admin/find-user", params={"q": "steve"}, timeout=15)
    assert r.status_code == 401, r.text
