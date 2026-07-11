"""Tests for HOME city vs BROWSING city split (Nice2Meechu bug fix)."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
TOKEN = "sttest_SUQD-bH3lyJJOBLw-llOftxhxupA_9nU"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
_client = MongoClient(MONGO_URL)
db = _client[DB_NAME]


def _me():
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=HEADERS, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["user"]


def _feed():
    r = requests.get(f"{BASE_URL}/api/feed", headers=HEADERS, timeout=20)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("feed", j.get("items", []))


def _get_user_doc(uid):
    return db.users.find_one({"id": uid})


@pytest.fixture(scope="module", autouse=True)
def restore_state():
    snap00 = _get_user_doc("demo-00")
    snap02 = _get_user_doc("demo-02")
    assert snap00 and snap02, "demo-00 or demo-02 not seeded"
    yield
    for snap in [snap00, snap02]:
        fields = {
            k: snap.get(k)
            for k in ["city", "home_city", "lat", "lng",
                      "city_lat", "city_lng", "home_lat", "home_lng"]
            if snap.get(k) is not None
        }
        db.users.update_one({"id": snap["id"]}, {"$set": fields})


class TestBackfillMigration:
    def test_users_with_city_have_home_city(self):
        missing = list(
            db.users.find(
                {
                    "city": {"$exists": True, "$nin": [None, ""]},
                    "$or": [{"home_city": {"$exists": False}},
                            {"home_city": None}, {"home_city": ""}],
                },
                {"id": 1, "city": 1, "home_city": 1},
            )
        )
        assert not missing, f"users with city but no home_city: {missing}"

    def test_demo00_home_is_tokyo(self):
        u = _get_user_doc("demo-00")
        assert "Tokyo" in (u.get("home_city") or ""), u.get("home_city")


class TestLocationSetHomeFlag:
    def test_a_browsing_change_does_not_move_home(self):
        r = requests.post(
            f"{BASE_URL}/api/users/location",
            headers=HEADERS,
            json={"lat": 48.8566, "lng": 2.3522, "city": "Paris, France", "set_home": False},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        me = _me()
        assert me["city"].startswith("Paris"), me["city"]
        assert "Tokyo" in me["home_city"], f"home moved! {me['home_city']}"
        doc = _get_user_doc("demo-00")
        assert "Tokyo" in (doc.get("home_city") or "")
        assert doc.get("home_lat") == pytest.approx(35.6762, abs=0.01)

    def test_b_set_home_true_restores_home(self):
        r = requests.post(
            f"{BASE_URL}/api/users/location",
            headers=HEADERS,
            json={"lat": 35.6762, "lng": 139.6503, "city": "Tokyo, Japan", "set_home": True},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        me = _me()
        assert "Tokyo" in me["city"] and "Tokyo" in me["home_city"], me
        doc = _get_user_doc("demo-00")
        assert doc.get("home_lat") == pytest.approx(35.6762, abs=0.01)

    def test_c_set_home_true_without_city_does_not_change_home(self):
        before = _get_user_doc("demo-00").get("home_city")
        r = requests.post(
            f"{BASE_URL}/api/users/location",
            headers=HEADERS,
            json={"lat": 40.0, "lng": -75.0, "set_home": True},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        after = _get_user_doc("demo-00").get("home_city")
        assert after == before, f"home changed from {before} to {after} without city"


class TestFeedUsesHomeCity:
    def test_feed_matches_target_home_city(self):
        requests.post(
            f"{BASE_URL}/api/users/location",
            headers=HEADERS,
            json={"lat": 35.6762, "lng": 139.6503, "city": "Tokyo, Japan", "set_home": True},
            timeout=15,
        )
        d02_orig = _get_user_doc("demo-02")
        assert "Tokyo" in (d02_orig.get("home_city") or "")

        db.users.update_one({"id": "demo-02"}, {"$set": {"city": "Paris, France"}})
        feed = _feed()
        ids = [it.get("id") for it in feed]
        assert "demo-02" in ids, f"demo-02 dropped after only-browsing change: {ids}"

        db.users.update_one({"id": "demo-02"}, {"$set": {"home_city": "Paris, France"}})
        feed = _feed()
        ids = [it.get("id") for it in feed]
        assert "demo-02" not in ids, f"demo-02 still in Tokyo feed after home moved: {ids}"

        db.users.update_one(
            {"id": "demo-02"},
            {"$set": {"city": d02_orig["city"], "home_city": d02_orig["home_city"]}},
        )


class TestPopularCitiesByResidents:
    def test_popular_counts_use_home_city(self):
        r = requests.get(f"{BASE_URL}/api/cities/popular", headers=HEADERS, timeout=15)
        assert r.status_code == 200, r.text
        base = {c["city"].lower(): c["people"] for c in r.json()["cities"]}

        d02 = _get_user_doc("demo-02")
        db.users.update_one({"id": "demo-02"}, {"$set": {"home_city": "Paris, France"}})
        try:
            r2 = requests.get(f"{BASE_URL}/api/cities/popular", headers=HEADERS, timeout=15)
            after = {c["city"].lower(): c["people"] for c in r2.json()["cities"]}
        finally:
            db.users.update_one({"id": "demo-02"}, {"$set": {"home_city": d02["home_city"]}})

        tb, ta = base.get("tokyo", 0), after.get("tokyo", 0)
        pb, pa = base.get("paris", 0), after.get("paris", 0)
        print(f"Tokyo {tb}->{ta}; Paris {pb}->{pa}")
        assert ta == tb - 1, f"Tokyo count didn't drop: {tb}->{ta}"
        assert pa == pb + 1, f"Paris count didn't rise: {pb}->{pa}"


class TestOnboardingSetsHome:
    def test_onboarding_sets_home_city(self):
        uid = f"throwaway-{uuid.uuid4().hex[:8]}"
        token = f"sttest_throw_{uuid.uuid4().hex[:16]}"
        db.users.insert_one({
            "id": uid,
            "handle": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        db.user_sessions.insert_one({
            "session_token": token,
            "user_id": uid,
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        })
        try:
            hdrs = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            r = requests.post(
                f"{BASE_URL}/api/users/onboarding",
                headers=hdrs,
                json={
                    "first_name": "Erial",
                    "age": 28,
                    "city": "Erial, NJ",
                    "city_lat": 39.8218,
                    "city_lng": -75.0271,
                    "vibes": ["Chill"],
                    "language": "en",
                    "avatar_emoji": "\ud83c\udf19",
                },
                timeout=15,
            )
            assert r.status_code == 200, r.text
            me = requests.get(f"{BASE_URL}/api/auth/me", headers=hdrs, timeout=15).json()["user"]
            assert me["city"] == "Erial, NJ", me["city"]
            assert me["home_city"] == "Erial, NJ", me["home_city"]
            doc = _get_user_doc(uid)
            assert doc.get("home_lat") == pytest.approx(39.8218, abs=0.001)
        finally:
            db.users.delete_one({"id": uid})
            db.user_sessions.delete_one({"session_token": token})


class TestRegressionFeed:
    def test_feed_returns_items_in_tokyo(self):
        requests.post(
            f"{BASE_URL}/api/users/location",
            headers=HEADERS,
            json={"lat": 35.6762, "lng": 139.6503, "city": "Tokyo, Japan", "set_home": True},
            timeout=15,
        )
        items = _feed()
        print(f"Tokyo feed count: {len(items)}")
        assert len(items) >= 10, f"expected >=10 items in Tokyo, got {len(items)}"
