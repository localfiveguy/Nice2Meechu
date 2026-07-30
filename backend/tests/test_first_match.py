"""first_match flag on /swipe — powers the confetti + first-timer tips."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
VID = "https://storage.googleapis.com/nicemeechu/user_videos/test-john-erial.mp4"


def _mk_user(uid):
    db.users.insert_one({
        "id": uid, "email": f"{uid}@example.com", "codename": f"FM {uid[-6:]}",
        "handle": f"fm.{uid[-6:]}", "home_city": "Marlton, NJ, USA",
        "city": "Marlton, NJ, USA", "video_url": VID, "is_demo": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


@pytest.fixture()
def trio():
    a = f"tt-fm-a-{uuid.uuid4().hex[:8]}"
    b = f"tt-fm-b-{uuid.uuid4().hex[:8]}"
    c = f"tt-fm-c-{uuid.uuid4().hex[:8]}"
    tok = f"sttest_fm_{uuid.uuid4().hex}"
    for u in (a, b, c):
        _mk_user(u)
    db.user_sessions.insert_one({
        "user_id": a, "session_token": tok,
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        "created_at": datetime.now(timezone.utc),
    })
    # b and c both already liked a → a's likes back become mutual matches
    for liker in (b, c):
        db.swipes.insert_one({
            "id": str(uuid.uuid4()), "user_id": liker, "target_user_id": a,
            "action": "like", "at": datetime.now(timezone.utc).isoformat(),
        })
    yield a, b, c, {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    db.users.delete_many({"id": {"$in": [a, b, c]}})
    db.user_sessions.delete_many({"user_id": a})
    db.swipes.delete_many({"$or": [{"user_id": {"$in": [a, b, c]}}, {"target_user_id": {"$in": [a, b, c]}}]})
    db.matches.delete_many({"user_ids": {"$in": [a, b, c]}})


def test_first_match_flag_true_then_false(trio):
    a, b, c, headers = trio
    r1 = requests.post(f"{BASE_URL}/api/swipe", headers=headers,
                       json={"target_user_id": b, "action": "like"}, timeout=20)
    assert r1.status_code == 200, r1.text
    d1 = r1.json()
    assert d1["match"] is True and d1["first_match"] is True, d1

    r2 = requests.post(f"{BASE_URL}/api/swipe", headers=headers,
                       json={"target_user_id": c, "action": "like"}, timeout=20)
    d2 = r2.json()
    assert d2["match"] is True and d2["first_match"] is False, d2
