"""Home-town-only feed (v1.6.6): a video appears ONLY in its home town —
matched by home_city label or by home coords within SAME_TOWN_KM (8 km) of
the browsed city's center. The old 10/25/50 km nearby system is removed."""
import os
import uuid
from datetime import datetime, timezone

import pytest
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

MARLTON = ("Marlton, NJ, USA", 39.9006, -74.9339)
EVESHAM = ("Evesham, NJ, USA", 39.8518, -74.8917)     # 6.5 km from Marlton center
CHERRY_HILL = ("Cherry Hill, NJ, USA", 39.9269, -75.0246)  # 9.5 km — different town
QA_ID = requests.get(f"{BASE_URL}/api/users/me", headers=HEADERS, timeout=15).json()["user"]["id"]


def _mk_user(uid, home_city, lat, lng):
    db.users.insert_one({
        "id": uid, "email": f"{uid}@example.com", "codename": "Town Test", "handle": None,
        "vibes": [], "language": "en", "avatar_emoji": "🏠",
        "city": home_city, "home_city": home_city,
        "lat": lat, "lng": lng, "home_lat": lat, "home_lng": lng,
        "city_lat": lat, "city_lng": lng,
        "video_url": "https://storage.googleapis.com/test-fixtures/intro.mp4",
        "transcript": "test", "source_lang": "en", "is_demo": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


def _browse(city, lat, lng):
    r = requests.post(
        f"{BASE_URL}/api/users/location", headers=HEADERS,
        json={"city": city, "lat": lat, "lng": lng, "set_home": False}, timeout=20,
    )
    assert r.status_code == 200, r.text
    r = requests.get(f"{BASE_URL}/api/feed", headers=HEADERS, timeout=25)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def residents():
    marlton_id = f"tt-marlton-{uuid.uuid4().hex[:8]}"
    ch_id = f"tt-cherryhill-{uuid.uuid4().hex[:8]}"
    _mk_user(marlton_id, *MARLTON)
    _mk_user(ch_id, *CHERRY_HILL)
    snap = db.users.find_one({"id": QA_ID}, {"city": 1, "city_lat": 1, "city_lng": 1, "lat": 1, "lng": 1})
    yield marlton_id, ch_id
    db.users.delete_many({"id": {"$in": [marlton_id, ch_id]}})
    db.users.update_one({"id": QA_ID}, {"$set": {k: v for k, v in snap.items() if k != "_id"}})


class TestHomeTownFeed:
    def test_marlton_browse_shows_marlton_resident(self, residents):
        marlton_id, _ = residents
        data = _browse(*MARLTON)
        ids = [it["id"] for it in data["feed"]]
        assert marlton_id in ids, ids

    def test_evesham_browse_absorbs_marlton_naming_variant(self, residents):
        """Marlton sits inside Evesham Township (centers 6.5 km apart) —
        the same-town coordinate tolerance must show the Marlton-homed video."""
        marlton_id, _ = residents
        data = _browse(*EVESHAM)
        ids = [it["id"] for it in data["feed"]]
        assert marlton_id in ids, ids

    def test_neighboring_towns_do_not_leak(self, residents):
        """Cherry Hill (9.5 km) and Erial (15 km) are DIFFERENT towns —
        their residents must never appear in the Marlton feed."""
        _, ch_id = residents
        data = _browse(*MARLTON)
        ids = [it["id"] for it in data["feed"]]
        assert ch_id not in ids, ids
        assert "test-john-erial" not in ids, ids
        assert "test-kathy-cherryhill" not in ids, ids

    def test_border_house_does_not_leak_into_neighbor_town(self):
        """Carlo case (owner decision): labeled Cherry Hill with a house pin
        7.5 km from Marlton's center — matching is by TOWN label, so he must
        NOT appear in the Marlton feed even though his pin is within 8 km."""
        uid = f"tt-border-{uuid.uuid4().hex[:8]}"
        _mk_user(uid, "Cherry Hill, NJ, USA", 39.91437, -75.02011)  # ~7.5 km from Marlton center
        try:
            data = _browse(*MARLTON)
            ids = [it["id"] for it in data["feed"]]
            assert uid not in ids, ids
        finally:
            db.users.delete_one({"id": uid})

    def test_no_radius_suggestion_in_response(self, residents):
        data = _browse(*MARLTON)
        assert "radius_suggestion" not in data, list(data.keys())

    def test_no_near_km_on_feed_items(self, residents):
        data = _browse(*MARLTON)
        for it in data["feed"]:
            assert "near_km" not in it, it

    def test_city_stats_match_visible_feed(self, residents):
        data = _browse(*MARLTON)
        assert data["city_stats"]["total"] == len(data["feed"])


class TestNearbyRadiusRemoved:
    def test_endpoint_gone(self):
        r = requests.post(
            f"{BASE_URL}/api/users/nearby-radius", headers=HEADERS,
            json={"radius_km": 25}, timeout=15,
        )
        assert r.status_code in (404, 405), r.status_code
