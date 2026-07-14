"""Tests for adjustable nearby radius (10/25/50 km)."""
import os
import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

_client = MongoClient(os.environ["MONGO_URL"])
db = _client[os.environ["DB_NAME"]]


def _set_radius(km):
    return requests.post(
        f"{BASE_URL}/api/users/nearby-radius",
        json={"radius_km": km}, headers=HEADERS, timeout=15,
    )


def _set_location(lat, lng, city, set_home=False):
    r = requests.post(
        f"{BASE_URL}/api/users/location",
        json={"lat": lat, "lng": lng, "city": city, "set_home": set_home},
        headers=HEADERS, timeout=15,
    )
    assert r.status_code == 200, r.text


def _feed():
    r = requests.get(f"{BASE_URL}/api/feed", headers=HEADERS, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module", autouse=True)
def _snapshot_restore():
    snap = db.users.find_one({"id": "demo-00"})
    assert snap
    yield
    fields = {k: snap.get(k) for k in [
        "city", "home_city", "lat", "lng",
        "city_lat", "city_lng", "home_lat", "home_lng",
        "nearby_radius_km",
    ] if snap.get(k) is not None}
    db.users.update_one({"id": "demo-00"}, {"$set": fields})


class TestRadiusValidation:
    def test_invalid_radius_400(self):
        r = _set_radius(33)
        assert r.status_code == 400, r.text

    @pytest.mark.parametrize("km", [10, 25, 50])
    def test_valid_radius_200(self, km):
        r = _set_radius(km)
        assert r.status_code == 200, r.text
        # verify persisted
        u = db.users.find_one({"id": "demo-00"})
        assert u.get("nearby_radius_km") == km


class TestRadiusFeedCutoff:
    """Marlton browsing: Voorhees 3.1, Cherry Hill 10.5, Erial 15.2."""

    def setup_method(self):
        _set_location(39.891, -74.922, "Marlton, NJ, USA", set_home=False)

    def test_radius_10_excludes_beyond(self):
        assert _set_radius(10).status_code == 200
        feed = _feed()["feed"]
        nearby = [i for i in feed if i.get("near_km") is not None]
        # all nearby must be <= 10
        for it in nearby:
            assert it["near_km"] <= 10.0, it
        ids = [i["id"] for i in feed]
        assert "test-john-erial" not in ids, ids  # 15.2 excluded

    def test_radius_25_includes_all_three(self):
        assert _set_radius(25).status_code == 200
        feed = _feed()["feed"]
        ids = [i["id"] for i in feed]
        assert "test-john-erial" in ids, ids
        # near_km all <=25
        for it in feed:
            if it.get("near_km") is not None:
                assert it["near_km"] <= 25.0

    def test_radius_50_includes_all_three(self):
        assert _set_radius(50).status_code == 200
        feed = _feed()["feed"]
        ids = [i["id"] for i in feed]
        assert "test-john-erial" in ids, ids


class TestCleanup:
    """Restore state: radius=25, city=Tokyo home."""

    def test_cleanup(self):
        assert _set_radius(25).status_code == 200
        _set_location(35.6762, 139.6503, "Tokyo", set_home=True)
        feed = _feed()["feed"]
        assert len(feed) >= 12, f"Tokyo feed <12: {len(feed)}"
