"""Tests for the 'Likes you' feed hint feature.

Iteration 15: _check_mutual_match now short-circuits on a real reverse-like
row for ALL users (including demo). So liking-back demo-01 is a deterministic
instant match (no more 70% flake).
"""
import os
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://hyperlocal-video.preview.emergentagent.com').rstrip('/')
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
HEADERS = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}
QA_ID = requests.get(f"{BASE_URL}/api/users/me", headers=HEADERS, timeout=15).json()["user"]["id"]

MONGO_URL = 'mongodb://localhost:27017'
DB_NAME = 'test_database'


def get_feed():
    r = requests.get(f'{BASE_URL}/api/feed', headers=HEADERS, timeout=15)
    assert r.status_code == 200, r.text
    return r.json().get('feed', [])


def find_item(feed, uid):
    return next((i for i in feed if i['id'] == uid), None)


async def _cleanup():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    await db.matches.delete_many({'user_ids': {'$all': [QA_ID, 'demo-01']}})
    await db.swipes.delete_many({'user_id': QA_ID, 'target_user_id': 'demo-01'})
    seed = await db.swipes.find_one({'user_id': 'demo-01', 'target_user_id': QA_ID, 'action': 'like'})
    if not seed:
        await db.swipes.insert_one({'user_id': 'demo-01', 'target_user_id': QA_ID, 'action': 'like'})
    client.close()


def cleanup():
    asyncio.run(_cleanup())


@pytest.fixture(autouse=True)
def _reset():
    # demo-01/demo-02 are homed in Tokyo — browse Tokyo so they appear in feed.
    requests.post(
        f'{BASE_URL}/api/users/location', headers=HEADERS,
        json={'lat': 35.6762, 'lng': 139.6503, 'city': 'Tokyo, Japan', 'set_home': False},
    )
    cleanup()
    yield
    cleanup()


def test_seeded_state_likes_you():
    feed = get_feed()
    d01 = find_item(feed, 'demo-01')
    d02 = find_item(feed, 'demo-02')
    assert d01 is not None
    assert d01['likes_you'] is True
    assert d02['likes_you'] is False


def test_instant_match_is_deterministic():
    """Run 3 attempts back-to-back — every one must return match:true."""
    for attempt in range(3):
        cleanup()  # restore demo-01→demo-00 like, wipe any match
        r = requests.post(f'{BASE_URL}/api/swipe', headers=HEADERS,
                          json={'target_user_id': 'demo-01', 'action': 'like'}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get('match') is True, f'attempt {attempt}: expected match=true, got {body}'
        assert body.get('matched_user', {}).get('id') == 'demo-01'


def test_matched_pair_excluded_from_likes_you():
    r = requests.post(f'{BASE_URL}/api/swipe', headers=HEADERS,
                      json={'target_user_id': 'demo-01', 'action': 'like'}, timeout=15)
    assert r.json().get('match') is True
    feed = get_feed()
    d01 = find_item(feed, 'demo-01')
    if d01 is not None:
        assert d01['likes_you'] is False


def test_cleanup_restores_likes_you():
    requests.post(f'{BASE_URL}/api/swipe', headers=HEADERS,
                  json={'target_user_id': 'demo-01', 'action': 'like'}, timeout=15)
    cleanup()
    feed = get_feed()
    d01 = find_item(feed, 'demo-01')
    assert d01 is not None
    assert d01['likes_you'] is True
