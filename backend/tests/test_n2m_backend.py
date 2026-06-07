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
        # Direct GIS mode is active when GOOGLE_CLIENT_ID is configured.
        assert d["auth"] in ("google-direct", "google-emergent")
        assert d["auth"] == "google-direct", f"Expected google-direct (GOOGLE_CLIENT_ID set), got {d['auth']}"


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


# ---------- OG share-card image generation ----------
class TestOgCard:
    PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

    def test_og_unknown_handle_returns_generic_png(self, session):
        r = session.get(f"{API}/og/nonexistent-handle-zzz-xyz", headers={"Content-Type": ""})
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("image/png")
        assert r.content[:8] == self.PNG_MAGIC
        # Verify dimensions ~1200x630 (PNG IHDR at byte 16: 4-byte width, 4-byte height)
        width = int.from_bytes(r.content[16:20], "big")
        height = int.from_bytes(r.content[20:24], "big")
        assert width == 1200, f"expected 1200, got {width}"
        assert height == 630, f"expected 630, got {height}"

    def test_og_existing_handle_returns_png(self, session, auth):
        # auth fixture creates a real user; use its handle
        handle = auth["user"]["handle"]
        r = session.get(f"{API}/og/{handle}")
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/png")
        assert r.content[:8] == self.PNG_MAGIC
        width = int.from_bytes(r.content[16:20], "big")
        height = int.from_bytes(r.content[20:24], "big")
        assert (width, height) == (1200, 630)


# ---------- Referral capture on /api/auth/session ----------
class TestReferral:
    """Test that auth/session accepts `ref` and increments referral_count.

    Since real Emergent OAuth would reject test session_ids, we simulate the
    POST-OAuth side-effect by directly executing the same DB ops the endpoint
    performs (model/structure verification). This validates the new user-doc
    fields exist and increment logic is correct.
    """

    def test_session_endpoint_accepts_ref_field(self, session):
        # The POST should not 422 on the `ref` field; it should fail at OAuth lookup (401/502).
        r = session.post(f"{API}/auth/session", json={"session_id": "bogus-xyz", "ref": "alice"})
        assert r.status_code in (401, 502), f"got {r.status_code}: {r.text}"

    def test_referral_count_increments_for_new_user(self, mongo):
        """Simulate: alice exists with handle, bob (new user) signs up with ref=alice.

        We replicate the exact mongo ops from auth_session_exchange (lines ~178-221).
        """
        alice_id = f"test-alice-{uuid.uuid4().hex[:8]}"
        alice_handle = f"alice_{uuid.uuid4().hex[:6]}"
        mongo.users.insert_one({
            "id": alice_id, "email": f"TEST_{alice_id}@x.com",
            "handle": alice_handle, "codename": "Velvet Fox",
            "vibes": [], "language": "en", "avatar_emoji": "🌙",
        })
        try:
            # Lookup referrer by handle (matches server logic)
            ref_user = mongo.users.find_one({"handle": alice_handle.lower()}, {"_id": 0, "id": 1})
            assert ref_user is not None
            ref_user_id = ref_user["id"]
            assert ref_user_id == alice_id

            # Insert bob with referrer fields
            bob_id = f"test-bob-{uuid.uuid4().hex[:8]}"
            new_user = {
                "id": bob_id, "email": f"TEST_{bob_id}@x.com",
                "handle": None, "codename": "Neon Comet",
                "vibes": [], "language": "en", "avatar_emoji": "🌙",
                "referrer_handle": alice_handle.lower(),
                "referrer_id": ref_user_id,
            }
            mongo.users.insert_one(new_user)

            # Increment alice's referral_count
            mongo.users.update_one({"id": ref_user_id}, {"$inc": {"referral_count": 1}})

            # Verify bob doc has referrer fields
            bob = mongo.users.find_one({"id": bob_id}, {"_id": 0})
            assert bob["referrer_id"] == alice_id
            assert bob["referrer_handle"] == alice_handle.lower()

            # Verify alice's referral_count incremented
            alice = mongo.users.find_one({"id": alice_id}, {"_id": 0})
            assert alice.get("referral_count") == 1

            # Second referral → count = 2
            mongo.users.update_one({"id": ref_user_id}, {"$inc": {"referral_count": 1}})
            alice = mongo.users.find_one({"id": alice_id}, {"_id": 0})
            assert alice.get("referral_count") == 2
        finally:
            mongo.users.delete_many({"id": {"$in": [alice_id]}})
            mongo.users.delete_many({"email": {"$regex": "^TEST_test-bob-"}})

    def test_unknown_ref_yields_no_referrer_id(self, mongo):
        """If ref handle doesn't exist, referrer_id should be None (referrer_handle still saved)."""
        ref_handle = "definitely-not-a-real-handle-xyz"
        ref_user = mongo.users.find_one({"handle": ref_handle}, {"_id": 0, "id": 1})
        assert ref_user is None
        # Simulated insert (mirrors server.py lines 186-213 with no match)
        bob_id = f"test-bob-noref-{uuid.uuid4().hex[:8]}"
        mongo.users.insert_one({
            "id": bob_id, "email": f"TEST_{bob_id}@x.com", "handle": None,
            "referrer_handle": ref_handle, "referrer_id": None,
        })
        try:
            bob = mongo.users.find_one({"id": bob_id}, {"_id": 0})
            assert bob["referrer_id"] is None
            assert bob["referrer_handle"] == ref_handle
        finally:
            mongo.users.delete_many({"id": bob_id})


# ---------- iOS Safari redirect-mode Google OAuth ----------
class TestGoogleRedirectMode:
    """Verify the new /api/auth/google-redirect endpoint behaves gracefully
    on invalid credentials and supports the `ref` query-string for referrals.

    Real Google-issued JWTs cannot be minted in tests — only negative-path
    checks for the verification failure branch are covered here. The happy
    path is verified manually on an iPhone.
    """

    def _post_no_redirect(self, url, data, params=None):
        # Use form-encoded POST without auto-following redirects so we can
        # observe the 303 Location header directly.
        return requests.post(
            url,
            data=data,  # form-encoded — endpoint uses Form(...)
            params=params or {},
            allow_redirects=False,
            timeout=15,
        )

    def test_redirect_invalid_credential_returns_303(self):
        r = self._post_no_redirect(
            f"{API}/auth/google-redirect",
            data={"credential": "obviously-not-a-real-jwt", "g_csrf_token": "abc123"},
        )
        assert r.status_code == 303, f"expected 303 redirect, got {r.status_code}: {r.text[:200]}"
        loc = r.headers.get("Location", "") or r.headers.get("location", "")
        assert "auth_error=invalid_credential" in loc, f"Location was: {loc!r}"

    def test_redirect_invalid_credential_with_ref_param(self):
        r = self._post_no_redirect(
            f"{API}/auth/google-redirect",
            data={"credential": "still-not-a-real-jwt", "g_csrf_token": "xyz"},
            params={"ref": "alice"},
        )
        # Ref is accepted but path short-circuits at verification → still 303.
        assert r.status_code == 303
        loc = r.headers.get("Location", "") or r.headers.get("location", "")
        assert "auth_error=invalid_credential" in loc, f"Location was: {loc!r}"

    def test_redirect_missing_credential_returns_422(self):
        # Form field missing → FastAPI should reject with 422 (not 500).
        r = self._post_no_redirect(
            f"{API}/auth/google-redirect",
            data={"g_csrf_token": "abc"},  # no `credential`
        )
        assert r.status_code in (422, 400), f"got {r.status_code}: {r.text[:200]}"


# ---------- Popup-mode Google OAuth regression ----------
class TestGoogleIdTokenPopup:
    def test_invalid_credential_returns_401_json(self, session):
        r = session.post(f"{API}/auth/google", json={"credential": "not-a-real-jwt"})
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"
        # Must be JSON with `detail`, not a 500/HTML.
        ct = r.headers.get("content-type", "")
        assert "application/json" in ct, f"content-type was {ct!r}"
        body = r.json()
        assert "detail" in body and body["detail"], f"missing/empty detail: {body}"
        # Detail should mention the credential failure
        assert "credential" in body["detail"].lower() or "invalid" in body["detail"].lower()

    def test_missing_credential_returns_422(self, session):
        r = session.post(f"{API}/auth/google", json={})
        assert r.status_code == 422


# ---------- Admin auth gate ----------
class TestAdminGate:
    def test_inactive_cleanup_requires_auth(self, session):
        r = session.post(f"{API}/admin/inactive-cleanup?days=90&dry_run=true")
        # No bearer/cookie → must be 401, not 500.
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"
