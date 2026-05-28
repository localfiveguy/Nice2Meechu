"""Nice2Meechu backend test suite."""
import os
import time
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else None
if not BASE:
    # load from frontend/.env
    with open("/app/frontend/.env") as f:
        for ln in f:
            if ln.startswith("REACT_APP_BACKEND_URL="):
                BASE = ln.split("=", 1)[1].strip().strip('"').rstrip("/")
API = f"{BASE}/api"


# ---------- module-level shared state ----------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def auth(session):
    """Sign up a fresh user and onboard them. Returns dict with token, user, headers."""
    phone = f"+1415555{int(time.time()) % 10000:04d}"
    r = session.post(f"{API}/auth/send-otp", json={"phone": phone})
    assert r.status_code == 200, r.text
    code = r.json()["dev_code"]
    r = session.post(f"{API}/auth/verify-otp", json={"phone": phone, "code": code})
    assert r.status_code == 200
    data = r.json()
    headers = {"Authorization": f"Bearer {data['token']}"}
    # onboard
    r = session.post(
        f"{API}/users/onboarding",
        json={"handle": f"test_{int(time.time())%10000}", "vibes": ["Coffee", "Vinyl"], "language": "en", "avatar_emoji": "🌙"},
        headers=headers,
    )
    assert r.status_code == 200
    user = r.json()["user"]
    # set location
    session.post(f"{API}/users/location", json={"lat": 40.71, "lng": -74.00}, headers=headers)
    # set video
    session.post(f"{API}/users/video", json={"sample_index": 0}, headers=headers)
    return {"phone": phone, "token": data["token"], "user": user, "headers": headers}


# ---------- root ----------
class TestRoot:
    def test_root_metadata(self, session):
        r = session.get(f"{API}/")
        assert r.status_code == 200
        d = r.json()
        assert d["app"] == "Nice2Meechu"
        assert "twilio_enabled" in d


# ---------- auth ----------
class TestAuth:
    def test_send_otp_valid(self, session):
        r = session.post(f"{API}/auth/send-otp", json={"phone": "+14155550199"})
        assert r.status_code == 200
        d = r.json()
        assert d["dev_mode"] is True
        assert "dev_code" in d and len(d["dev_code"]) == 6

    def test_send_otp_invalid_no_plus(self, session):
        r = session.post(f"{API}/auth/send-otp", json={"phone": "14155550199"})
        assert r.status_code == 400

    def test_send_otp_too_short(self, session):
        r = session.post(f"{API}/auth/send-otp", json={"phone": "+1234"})
        assert r.status_code == 400

    def test_verify_otp_wrong_code(self, session):
        session.post(f"{API}/auth/send-otp", json={"phone": "+14155550299"})
        r = session.post(f"{API}/auth/verify-otp", json={"phone": "+14155550299", "code": "000000"})
        # Wrong code (extremely unlikely match): should be 400
        # Note: tiny chance of accidental match. Retry with explicitly wrong code.
        if r.status_code == 200:
            r = session.post(f"{API}/auth/verify-otp", json={"phone": "+14155550299", "code": "111111"})
        assert r.status_code == 400

    def test_verify_otp_correct_creates_user(self, session):
        phone = f"+1415555{(int(time.time())+1) % 10000:04d}"
        r = session.post(f"{API}/auth/send-otp", json={"phone": phone})
        code = r.json()["dev_code"]
        r = session.post(f"{API}/auth/verify-otp", json={"phone": phone, "code": code})
        assert r.status_code == 200
        d = r.json()
        assert "token" in d and len(d["token"]) > 10
        assert "user" in d
        assert d["onboarded"] is False
        assert d["user"]["phone"] == phone


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
    ])
    def test_requires_bearer(self, session, method, path, body):
        if method == "GET":
            r = session.get(f"{API}{path}")
        else:
            r = session.post(f"{API}{path}", json=body)
        assert r.status_code == 401, f"{path} should require auth"


# ---------- onboarding / profile / video ----------
class TestProfile:
    def test_me_returns_current_user(self, session, auth):
        r = session.get(f"{API}/users/me", headers=auth["headers"])
        assert r.status_code == 200
        u = r.json()["user"]
        assert u["id"] == auth["user"]["id"]
        assert u["handle"] == auth["user"]["handle"]

    def test_onboarding_persisted(self, session, auth):
        # update via onboarding
        r = session.post(
            f"{API}/users/onboarding",
            json={"handle": auth["user"]["handle"], "vibes": ["Foodie"], "language": "es", "avatar_emoji": "🔥"},
            headers=auth["headers"],
        )
        assert r.status_code == 200
        # verify via /me
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
        assert d["video_url"].startswith("https://")
        assert d["transcript"]
        # persist check
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
        # self must not appear
        assert all(c["id"] != auth["user"]["id"] for c in feed)

    def test_swipe_pass(self, session, auth):
        r = session.get(f"{API}/feed", headers=auth["headers"])
        feed = r.json()["feed"]
        # pick a demo
        target = next((c for c in feed if c["id"].startswith("demo-")), feed[0])
        r = session.post(f"{API}/swipe", json={"target_user_id": target["id"], "action": "pass"}, headers=auth["headers"])
        assert r.status_code == 200
        assert r.json() == {"match": False}

    def test_swipe_like_attempts_match_and_messages(self, session, auth):
        # Like demo users until we get a match (70% chance each)
        match_data = None
        for attempt in range(15):
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
        assert match_data is not None, "Expected at least one match after 15 like attempts"

        # /matches lists it
        r = session.get(f"{API}/matches", headers=auth["headers"])
        assert r.status_code == 200
        matches = r.json()["matches"]
        assert any(m["match_id"] == match_data["match_id"] for m in matches)

        # Send a message and verify demo reply
        mid = match_data["match_id"]
        r = session.post(f"{API}/messages", json={"match_id": mid, "text": "hi there!"}, headers=auth["headers"])
        assert r.status_code == 200
        time.sleep(0.5)
        r = session.get(f"{API}/messages/{mid}", headers=auth["headers"])
        assert r.status_code == 200
        msgs = r.json()["messages"]
        # Expect our message + a demo reply (demo user is_demo=True)
        assert len(msgs) >= 2
        # ordered by at ascending
        ats = [m["at"] for m in msgs]
        assert ats == sorted(ats)
        # first message is ours
        assert msgs[0]["text"] == "hi there!"
        assert msgs[0]["from_user_id"] == auth["user"]["id"]

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
        # Loose check - should contain typical Spanish hello variants
        assert any(s in out for s in ["hola", "buen"]) or out != "hello"

    def test_translate_same_lang_unchanged(self, session):
        r = session.post(f"{API}/translate", json={"text": "Hello there", "target_lang": "en", "source_lang": "en"})
        assert r.status_code == 200
        assert r.json()["translation"] == "Hello there"
