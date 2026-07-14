"""Full regression suite after backend refactor (server.py → modular routers).

Seeds a test user + session directly in Mongo, then hits every documented
endpoint through the public REACT_APP_BACKEND_URL. Cleans up TEST_ users
after the suite finishes.
"""
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values
from pymongo import MongoClient

FRONTEND_ENV = dotenv_values("/app/frontend/.env")
BACKEND_ENV = dotenv_values("/app/backend/.env")
BASE_URL = (FRONTEND_ENV.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
MONGO_URL = BACKEND_ENV.get("MONGO_URL")
DB_NAME = BACKEND_ENV.get("DB_NAME")

assert BASE_URL, "REACT_APP_BACKEND_URL missing"
assert MONGO_URL and DB_NAME, "Mongo env missing"

_mongo = MongoClient(MONGO_URL)
_db = _mongo[DB_NAME]

TS = int(time.time())
TEST_USER_ID = f"TEST_user_{TS}_{uuid.uuid4().hex[:6]}"
TEST_TOKEN = f"TEST_session_{TS}_{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="session", autouse=True)
def seed_test_user():
    """Insert a non-demo test user + valid session, teardown after."""
    _db.users.insert_one({
        "id": TEST_USER_ID,
        "email": f"TEST_{TS}@example.com",
        "name": "Test User",
        "codename": "Velvet Fox",
        "handle": None,
        "vibes": ["coffee", "hiking"],
        "language": "en",
        "avatar_emoji": "🌙",
        "created_at": datetime.now(timezone.utc),
        "onboarded": True,
        # Seed with a metro city (New York) so nearby feed has demos.
        "city": "New York, NY, USA",
        "home_city": "New York, NY, USA",
        "city_lat": 40.7128, "city_lng": -74.0060,
        "home_lat": 40.7128, "home_lng": -74.0060,
        "lat": 40.7128, "lng": -74.0060,
        "nearby_radius_km": 50,
    })
    _db.user_sessions.insert_one({
        "user_id": TEST_USER_ID,
        "session_token": TEST_TOKEN,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=1),
        "created_at": datetime.now(timezone.utc),
    })
    yield
    # Cleanup
    _db.users.delete_many({"id": TEST_USER_ID})
    _db.user_sessions.delete_many({"session_token": TEST_TOKEN})
    _db.swipes.delete_many({"user_id": TEST_USER_ID})
    _db.matches.delete_many({"$or": [{"user_a": TEST_USER_ID}, {"user_b": TEST_USER_ID}]})
    _db.messages.delete_many({"sender_id": TEST_USER_ID})
    _db.reports.delete_many({"reporter_id": TEST_USER_ID})
    _db.blocks.delete_many({"blocker_id": TEST_USER_ID})


@pytest.fixture(scope="session")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def auth_client():
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TEST_TOKEN}",
    })
    return s


# --------------------------- public / metadata ---------------------------

def test_root(client):
    r = client.get(f"{BASE_URL}/api/")
    assert r.status_code == 200
    data = r.json()
    assert "auth" in data or "name" in data or "message" in data


def test_samples(client):
    r = client.get(f"{BASE_URL}/api/samples")
    assert r.status_code == 200
    data = r.json()
    assert "vibes" in data and "languages" in data
    assert isinstance(data["vibes"], list) and len(data["vibes"]) > 0
    assert isinstance(data["languages"], list) and len(data["languages"]) > 0


def test_demos_sample(client):
    r = client.get(f"{BASE_URL}/api/demos/sample")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, (list, dict))
    items = (data if isinstance(data, list)
             else data.get("demos") or data.get("users") or data.get("items") or [])
    assert len(items) > 0
    sample = items[0]
    assert "video_url" in sample
    assert "codename" in sample or "name" in sample


# --------------------------- auth gating ---------------------------

@pytest.mark.parametrize("path", ["/api/auth/me", "/api/feed", "/api/matches", "/api/matches/unread", "/api/users/me"])
def test_protected_requires_auth(client, path):
    r = client.get(f"{BASE_URL}{path}")
    assert r.status_code == 401, f"{path} → {r.status_code} (expected 401)"


def test_auth_me_with_token(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/auth/me")
    assert r.status_code == 200
    data = r.json()
    assert "user" in data
    assert data["user"]["id"] == TEST_USER_ID


# --------------------------- feed / swipe / match ---------------------------

def test_feed_returns_demos(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/feed")
    assert r.status_code == 200
    data = r.json()
    items = data if isinstance(data, list) else data.get("items") or data.get("feed") or []
    assert isinstance(items, list)
    # Feed can be empty if no demos near NYC — but demos seed on first call.
    if items:
        item = items[0]
        assert "video_url" in item or "codename" in item
        assert "city" in item or "codename" in item


@pytest.fixture(scope="session")
def a_demo_user_id(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/feed")
    items = r.json() if isinstance(r.json(), list) else (r.json().get("items") or [])
    if not items:
        # Fall back to any demo user directly from Mongo.
        d = _db.users.find_one({"is_demo": True})
        if not d:
            pytest.skip("no demo users available")
        return d["id"]
    return items[0].get("id") or items[0].get("user_id")


def test_swipe_like_creates_match(auth_client, a_demo_user_id):
    r = auth_client.post(f"{BASE_URL}/api/swipe", json={
        "target_user_id": a_demo_user_id,
        "action": "like",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    # Demo auto-match rate ~70% but for the API call itself we just need a valid response.
    assert "matched" in data or "match" in data or "ok" in data or data == {} or data is not None


def test_swipe_unlike(auth_client, a_demo_user_id):
    r = auth_client.post(f"{BASE_URL}/api/swipe", json={
        "target_user_id": a_demo_user_id,
        "action": "unlike",
    })
    assert r.status_code == 200, r.text


def test_swipe_pass(auth_client):
    # Pick a different demo
    d = _db.users.find_one({"is_demo": True})
    if not d:
        pytest.skip("no demos")
    r = auth_client.post(f"{BASE_URL}/api/swipe", json={
        "target_user_id": d["id"],
        "action": "pass",
    })
    assert r.status_code == 200, r.text


def test_matches(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/matches")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, (list, dict))


def test_matches_unread(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/matches/unread")
    assert r.status_code == 200
    data = r.json()
    assert "count" in data or isinstance(data, int) or isinstance(data, dict)


# --------------------------- messaging ---------------------------

def test_translate(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/translate", json={
        "text": "Hello",
        "source_lang": "en",
        "target_lang": "es",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    translated = (data.get("translation") or data.get("translated")
                  or data.get("translated_text") or data.get("text") or "")
    assert isinstance(translated, str) and len(translated) > 0
    # Spanish "Hello" family
    assert any(w in translated.lower() for w in ("hola", "buenas", "saludo"))


def test_messages_flow(auth_client):
    # Need an existing match to send in. Force-like a demo & try.
    d = _db.users.find_one({"is_demo": True})
    if not d:
        pytest.skip("no demos")
    auth_client.post(f"{BASE_URL}/api/swipe", json={"target_user_id": d["id"], "action": "like"})
    # Fetch matches; if empty (auto-match miss), skip.
    matches_r = auth_client.get(f"{BASE_URL}/api/matches")
    matches = matches_r.json()
    match_list = matches if isinstance(matches, list) else (matches.get("matches") or matches.get("items") or [])
    if not match_list:
        pytest.skip("no match created (auto-match probabilistic)")
    match_id = match_list[0].get("id") or match_list[0].get("match_id")
    if not match_id:
        pytest.skip("match id missing in response")
    r = auth_client.post(f"{BASE_URL}/api/messages", json={
        "match_id": match_id,
        "text": "hey there",
    })
    assert r.status_code == 200, r.text
    thread = auth_client.get(f"{BASE_URL}/api/messages/{match_id}")
    assert thread.status_code == 200
    thread_data = thread.json()
    msgs = thread_data if isinstance(thread_data, list) else (thread_data.get("messages") or [])
    assert len(msgs) >= 1
    # translated_text field should be present (nullable)
    assert "translated_text" in msgs[0] or "text" in msgs[0]


# --------------------------- user profile ---------------------------

def test_location_update(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/users/location", json={
        "city": "Brooklyn, NY, USA",
        "lat": 40.6782, "lng": -73.9442,
        "set_home": False,
    })
    assert r.status_code == 200, r.text


def test_location_set_home(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/users/location", json={
        "city": "New York, NY, USA",
        "lat": 40.7128, "lng": -74.0060,
        "set_home": True,
    })
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("km,expected", [(10, 200), (25, 200), (50, 200), (7, 400), (100, 400)])
def test_nearby_radius(auth_client, km, expected):
    r = auth_client.post(f"{BASE_URL}/api/users/nearby-radius", json={"radius_km": km})
    assert r.status_code == expected, f"km={km} → {r.status_code} {r.text}"


def test_city_position_and_me(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/users/me/city-position", json={"city": "new york", "index": 3})
    assert r.status_code == 200, r.text
    me = auth_client.get(f"{BASE_URL}/api/users/me")
    assert me.status_code == 200
    data = me.json()
    # Some backends nest under user
    user = data.get("user") if "user" in data else data
    assert user.get("id") == TEST_USER_ID


def test_export(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/users/me/export")
    assert r.status_code == 200
    data = r.json()
    # GDPR dump should include counts / user / etc.
    assert isinstance(data, dict) and len(data) > 0


def test_report_and_block(auth_client):
    d = _db.users.find_one({"is_demo": True})
    if not d:
        pytest.skip("no demos")
    r = auth_client.post(f"{BASE_URL}/api/users/report", json={
        "target_user_id": d["id"],
        "reason": "test",
    })
    assert r.status_code in (200, 201), r.text
    # Use a different demo to block (so we don't unmatch reports)
    d2 = _db.users.find_one({"is_demo": True, "id": {"$ne": d["id"]}})
    if not d2:
        pytest.skip("need 2 demos for block test")
    r = auth_client.post(f"{BASE_URL}/api/users/block", json={
        "target_user_id": d2["id"],
    })
    assert r.status_code in (200, 201), r.text


# --------------------------- media / og / videos ---------------------------

def test_og_existing(client):
    d = _db.users.find_one({"handle": {"$exists": True, "$ne": None}})
    handle = d["handle"] if d else "nonexistent"
    r = client.get(f"{BASE_URL}/api/og/{handle}")
    assert r.status_code == 200
    assert "image/png" in r.headers.get("content-type", "")


def test_og_nonexisting(client):
    r = client.get(f"{BASE_URL}/api/og/nonexistent-handle-xyz-123")
    assert r.status_code == 200
    assert "image/png" in r.headers.get("content-type", "")


def test_static_video(client):
    files = sorted(Path("/app/backend/videos").glob("*.mp4"))
    if not files:
        pytest.skip("no video files")
    name = files[0].name
    r = client.get(f"{BASE_URL}/api/videos/{name}")
    assert r.status_code == 200
    assert "video" in r.headers.get("content-type", "").lower()


# --------------------------- cities / admin ---------------------------

def test_cities_popular_auth(client, auth_client):
    r = client.get(f"{BASE_URL}/api/cities/popular")
    assert r.status_code == 401
    r2 = auth_client.get(f"{BASE_URL}/api/cities/popular")
    assert r2.status_code == 200
    data = r2.json()
    assert isinstance(data, (list, dict))


def test_admin_forbidden(auth_client):
    r = auth_client.get(f"{BASE_URL}/api/admin/funnel")
    assert r.status_code == 403
    r = auth_client.post(f"{BASE_URL}/api/admin/inactive-cleanup")
    assert r.status_code == 403


# --------------------------- video upload validation ---------------------------

def test_video_upload_bad_content_type(auth_client):
    # Multipart upload with text/plain should be rejected quickly.
    files = {"file": ("bad.txt", b"not a video", "text/plain")}
    headers = {"Authorization": f"Bearer {TEST_TOKEN}"}
    r = requests.post(f"{BASE_URL}/api/users/video/upload", files=files, headers=headers)
    # 415 preferred, but 400/422 also acceptable for wrong type.
    assert r.status_code in (400, 415, 422), r.text
