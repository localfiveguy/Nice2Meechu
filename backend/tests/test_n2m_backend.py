"""Nice2Meechu backend test suite (Google-OAuth / Emergent auth).

Auth is now Emergent-managed Google OAuth. For tests we seed a user + session
directly into MongoDB (per /app/auth_testing.md) and authenticate via Bearer.
"""
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else None
if not BASE:
    with open("/app/frontend/.env") as f:
        for ln in f:
            if ln.startswith("REACT_APP_BACKEND_URL="):
                BASE = ln.split("=", 1)[1].strip().strip('"').rstrip("/")
API = f"{BASE}/api"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mongo():
    mc = MongoClient(MONGO_URL)
    yield mc[DB_NAME]
    mc.close()


@pytest.fixture(scope="module")
def auth(session, mongo):
    """Seed a fresh user + session directly into Mongo (mocks Google OAuth)."""
    uid = f"test-user-{uuid.uuid4().hex[:8]}"
    token = f"test_session_{uuid.uuid4().hex}"
    email = f"TEST_{uid}@example.com"
    mongo.users.insert_one({
        "id": uid, "email": email, "name": "Test User", "picture": None,
        "codename": "Velvet Fox", "handle": None, "vibes": [], "language": "en",
        "avatar_emoji": "🌙", "lat": None, "lng": None,
        "video_url": None, "transcript": None, "source_lang": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    mongo.user_sessions.insert_one({
        "user_id": uid, "session_token": token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    headers = {"Authorization": f"Bearer {token}"}

    # Onboard
    r = session.post(
        f"{API}/users/onboarding",
        json={"handle": f"test_{int(time.time())%10000}", "vibes": ["Coffee", "Vinyl"],
              "language": "en", "avatar_emoji": "🌙"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    session.post(f"{API}/users/location", json={"lat": 40.71, "lng": -74.00}, headers=headers)
    session.post(f"{API}/users/video", json={"sample_index": 0}, headers=headers)

    yield {"user_id": uid, "token": token, "user": user, "headers": headers}

    # Cleanup
    mongo.user_sessions.delete_many({"user_id": uid})
    mongo.users.delete_many({"id": uid})
    mongo.swipes.delete_many({"user_id": uid})


# ---------- root ----------
class TestRoot:
    def test_root_metadata(self, session):
        r = session.get(f"{API}/")
        assert r.status_code == 200
        d = r.json()
        assert d["app"] == "Nice2Meechu"
        assert d["auth"] == "google-emergent"


# ---------- auth ----------
class TestAuth:
    def test_me_unauth(self, session):
        r = session.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_session_exchange_bogus(self, session):
        r = session.post(f"{API}/auth/session", json={"session_id": "bogus-not-real-xyz"})
        assert r.status_code in (401, 502)

    def test_me_with_bearer(self, session, auth):
        r = session.get(f"{API}/auth/me", headers=auth["headers"])
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["id"] == auth["user_id"]
        assert d["onboarded"] is True

    def test_logout_deletes_session(self, session, mongo):
        # Seed a throwaway session
        uid = f"test-user-{uuid.uuid4().hex[:8]}"
        token = f"test_session_{uuid.uuid4().hex}"
        mongo.users.insert_one({"id": uid, "email": f"TEST_{uid}@x.com", "handle": None,
                                "vibes": [], "language": "en"})
        mongo.user_sessions.insert_one({
            "user_id": uid, "session_token": token,
            "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
            "created_at": datetime.now(timezone.utc),
        })
        r = session.post(f"{API}/auth/logout", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        # session should be gone
        assert mongo.user_sessions.find_one({"session_token": token}) is None
        # cleanup user
        mongo.users.delete_many({"id": uid})


# ---------- protected endpoints require auth ----------
class TestAuthGuard:
    @pytest.mark.parametrize("method,path,body", [
        ("GET", "/users/me", None),
        ("POST", "/users/onboarding", {"handle": "x", "vibes": [], "language": "en"}),
        ("POST", "/users/location", {"lat": 0, "lng": 0}),
        ("POST", "/users/video", {"sample_index": 0}),
        ("GET", "/feed", None),
        ("POST", "/swipe", {"target_user_id": "x", "action": "like"}),
        ("GET", "/matches", None),
        ("POST", "/messages", {"match_id": "x", "text": "hi"}),
        ("GET", "/messages/some-id", None),
    ])
    def test_requires_bearer(self, session, method, path, body):
        if method == "GET":
            r = session.get(f"{API}{path}")
        else:
            r = session.post(f"{API}{path}", json=body)
        assert r.status_code == 401, f"{path} should require auth, got {r.status_code}"


# ---------- onboarding / profile / video ----------
class TestProfile:
    def test_me_returns_current_user(self, session, auth):
        r = session.get(f"{API}/users/me", headers=auth["headers"])
        assert r.status_code == 200
        u = r.json()["user"]
        assert u["id"] == auth["user_id"]
        assert u["handle"] == auth["user"]["handle"]

    def test_onboarding_persisted(self, session, auth):
        r = session.post(
            f"{API}/users/onboarding",
            json={"handle": auth["user"]["handle"], "vibes": ["Foodie"], "language": "es", "avatar_emoji": "🔥"},
            headers=auth["headers"],
        )
        assert r.status_code == 200
        r = session.get(f"{API}/users/me", headers=auth["headers"])
        u = r.json()["user"]
        assert u["language"] == "es"
        assert u["avatar_emoji"] == "🔥"
        assert "Foodie" in u["vibes"]

    def test_location_persists(self, session, auth):
        r = session.post(f"{API}/users/location", json={"lat": 12.34, "lng": 56.78}, headers=auth["headers"])
        assert r.status_code == 200
        r = session.get(f"{API}/users/me", headers=auth["headers"])
        u = r.json()["user"]
        assert abs(u["lat"] - 12.34) < 0.01
        assert abs(u["lng"] - 56.78) < 0.01

    def test_video_sample_persists(self, session, auth):
        r = session.post(f"{API}/users/video", json={"sample_index": 2}, headers=auth["headers"])
        assert r.status_code == 200
        d = r.json()
        assert d["video_url"].startswith("/videos/") or d["video_url"].startswith("https://")
        assert d["transcript"]
        r = session.get(f"{API}/users/me", headers=auth["headers"])
        u = r.json()["user"]
        assert u["video_url"] == d["video_url"]


# ---------- samples ----------
class TestSamples:
    def test_samples_list(self, session):
        r = session.get(f"{API}/samples")
        assert r.status_code == 200
        d = r.json()
        assert len(d["samples"]) >= 6
        assert len(d["vibes"]) >= 6
        for s in d["samples"]:
            for k in ("index", "url", "transcript", "lang"):
                assert k in s


# ---------- feed / swipe / match / messages ----------
class TestFeedSwipeMatch:
    def test_feed_returns_demos(self, session, auth):
        r = session.get(f"{API}/feed", headers=auth["headers"])
        assert r.status_code == 200
        feed = r.json()["feed"]
        assert isinstance(feed, list)
        assert len(feed) >= 1
        first = feed[0]
        for k in ("id", "codename", "avatar_emoji", "vibes", "video_url", "transcript", "source_lang", "distance_km"):
            assert k in first
        assert all(c["id"] != auth["user_id"] for c in feed)

    def test_swipe_pass(self, session, auth):
        r = session.get(f"{API}/feed", headers=auth["headers"])
        feed = r.json()["feed"]
        target = next((c for c in feed if c["id"].startswith("demo-")), feed[0])
        r = session.post(f"{API}/swipe", json={"target_user_id": target["id"], "action": "pass"}, headers=auth["headers"])
        assert r.status_code == 200
        assert r.json() == {"match": False}

    def test_swipe_like_attempts_match_and_messages(self, session, auth):
        match_data = None
        for _ in range(20):
            r = session.get(f"{API}/feed", headers=auth["headers"])
            feed = r.json()["feed"]
            demos = [c for c in feed if c["id"].startswith("demo-")]
            if not demos:
                break
            target = demos[0]
            r = session.post(f"{API}/swipe", json={"target_user_id": target["id"], "action": "like"}, headers=auth["headers"])
            assert r.status_code == 200
            d = r.json()
            if d.get("match"):
                match_data = d
                assert "match_id" in d
                assert d["matched_user"]["id"] == target["id"]
                break
        assert match_data is not None, "Expected at least one match after 20 like attempts"

        r = session.get(f"{API}/matches", headers=auth["headers"])
        assert r.status_code == 200
        matches = r.json()["matches"]
        assert any(m["match_id"] == match_data["match_id"] for m in matches)

        mid = match_data["match_id"]
        r = session.post(f"{API}/messages", json={"match_id": mid, "text": "hi there!"}, headers=auth["headers"])
        assert r.status_code == 200
        time.sleep(0.6)
        r = session.get(f"{API}/messages/{mid}", headers=auth["headers"])
        assert r.status_code == 200
        msgs = r.json()["messages"]
        assert len(msgs) >= 2
        ats = [m["at"] for m in msgs]
        assert ats == sorted(ats)
        assert msgs[0]["text"] == "hi there!"
        assert msgs[0]["from_user_id"] == auth["user_id"]

    def test_messages_invalid_match(self, session, auth):
        r = session.post(f"{API}/messages", json={"match_id": "does-not-exist", "text": "hi"}, headers=auth["headers"])
        assert r.status_code == 404


# ---------- translation ----------
class TestTranslate:
    def test_translate_en_es(self, session):
        r = session.post(f"{API}/translate", json={"text": "Hello", "target_lang": "es", "source_lang": "en"})
        assert r.status_code == 200
        out = r.json()["translation"].strip().lower()
        assert out
        assert any(s in out for s in ["hola", "buen"]) or out != "hello"

    def test_translate_same_lang_unchanged(self, session):
        r = session.post(f"{API}/translate", json={"text": "Hello there", "target_lang": "en", "source_lang": "en"})
        assert r.status_code == 200
        assert r.json()["translation"] == "Hello there"
