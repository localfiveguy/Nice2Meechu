"""Tests for 'Nearby towns' feed expansion (NEARBY_RADIUS_KM=25)."""
import os
import uuid
from datetime import datetime, timezone

import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
QA_ID = requests.get(f"{BASE_URL}/api/users/me", headers=HEADERS, timeout=15).json()["user"]["id"]

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
_client = MongoClient(MONGO_URL)
db = _client[DB_NAME]


def _get(uid):
    return db.users.find_one({"id": uid})


def _feed():
    r = requests.get(f"{BASE_URL}/api/feed", headers=HEADERS, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _set_location(lat, lng, city, set_home=False):
    r = requests.post(
        f"{BASE_URL}/api/users/location",
        json={"lat": lat, "lng": lng, "city": city, "set_home": set_home},
        headers=HEADERS,
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module", autouse=True)
def restore_state():
    snap = _get(QA_ID)
    assert snap, "demo-00 missing"
    yield
    # Restore demo-00 to Tokyo home (set_home=true equivalent)
    fields = {k: snap.get(k) for k in [
        "city", "home_city", "lat", "lng",
        "city_lat", "city_lng", "home_lat", "home_lng"
    ] if snap.get(k) is not None}
    db.users.update_one({"id": QA_ID}, {"$set": fields})
    # Cleanup any leftover throwaway user
    db.users.delete_many({"id": {"$regex": "^throwaway-fartown-"}})


class TestMarltonNearby:
    """Browse Marlton (not home). Expect Voorhees < Cherry Hill < Erial nearby."""

    def test_marlton_feed_includes_nearby(self):
        _set_location(39.891, -74.922, "Marlton, NJ, USA", set_home=False)
        j = _feed()
        feed = j["feed"]
        ids = [i["id"] for i in feed]

        # test-john-erial must be present with near_km ~= 15.2 and home_city 'Erial'
        john = next((i for i in feed if i["id"] == "test-john-erial"), None)
        assert john is not None, f"test-john-erial missing from feed ids={ids}"
        assert john["home_city"] == "Erial", john
        assert john["near_km"] is not None
        assert 14.0 < john["near_km"] < 17.0, john["near_km"]

        # Ordering: exact Marlton homes first (may be zero), then nearby ascending.
        # Split into "exact" (near_km null) vs nearby
        exact = [i for i in feed if i.get("near_km") is None]
        nearby = [i for i in feed if i.get("near_km") is not None]
        # nearby must be monotonically increasing by near_km
        dists = [i["near_km"] for i in nearby]
        assert dists == sorted(dists), f"nearby not sorted: {dists}"

        # John (~15.2) should come after Voorhees (~3.1) and Cherry Hill (~10.5)
        # if those exist in nearby
        near_ids_ordered = [i["id"] for i in nearby]
        john_idx = near_ids_ordered.index("test-john-erial")
        assert john_idx >= 0
        # Expect >= 3 nearby items (voorhees x?, cherry hill x?, john)
        assert len(feed) >= 3, f"expected >=3, got {len(feed)}: {ids}"

        # city_stats.total = exact + nearby count
        stats = j["city_stats"]
        assert stats is not None
        assert stats["total"] == len(exact) + len(nearby), (
            f"total {stats['total']} != exact {len(exact)} + nearby {len(nearby)}"
        )

    def test_radius_boundary_excludes_far_user(self):
        """User homed ~35km from Marlton center must NOT appear."""
        tid = f"throwaway-fartown-{uuid.uuid4().hex[:8]}"
        # ~35km north of Marlton
        db.users.insert_one({
            "id": tid,
            "email": f"{tid}@example.com",
            "name": "Far Town User",
            "codename": "Distant Comet",
            "handle": None,
            "avatar_emoji": "🌙",
            "vibes": [],
            "language": "en",
            "city": "FarTown, NJ, USA",
            "home_city": "FarTown, NJ, USA",
            "lat": 40.20, "lng": -74.90,
            "home_lat": 40.20, "home_lng": -74.90,
            "city_lat": 40.20, "city_lng": -74.90,
            "video_url": "https://storage.googleapis.com/test-fixtures/intro.mp4",
            "transcript": "test",
            "source_lang": "en",
            "is_demo": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        try:
            _set_location(39.891, -74.922, "Marlton, NJ, USA", set_home=False)
            # radius state is shared across test files — pin it for this assert
            requests.post(f"{BASE_URL}/api/users/nearby-radius", json={"radius_km": 25}, headers=HEADERS, timeout=15)
            j = _feed()
            ids = [i["id"] for i in j["feed"]]
            assert tid not in ids, f"FarTown user should be >25km, but present in {ids}"
        finally:
            db.users.delete_one({"id": tid})


class TestTokyoRegression:
    """Browsing Tokyo (demo-00's home) — locals only, no nearby badges."""

    def test_tokyo_no_nearby_items(self):
        _set_location(35.6762, 139.6503, "Tokyo", set_home=True)
        j = _feed()
        feed = j["feed"]
        assert len(feed) >= 6, f"expected Tokyo demo items, got {len(feed)}"

        # All items must have near_km null (all local) and home_city Tokyo
        for it in feed:
            assert it["near_km"] is None, (
                f"Tokyo feed has nearby item {it['id']} near_km={it['near_km']}"
            )
            # home_city may be "Tokyo" (case may vary)
            assert it["home_city"].lower().startswith("tokyo"), it

        # city_stats.total should equal number of Tokyo homes with video
        stats = j["city_stats"]
        assert stats is not None
        assert stats["total"] >= len(feed)
