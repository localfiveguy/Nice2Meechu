"""Tests for the 'Likes you' feed hint feature.

NOTE: For demo users, backend _check_mutual_match uses random() < 0.7 rather
than the actual seeded like row, so the 'Likes you' hint is not a strict
guarantee for demo targets. Match-back tests retry to overcome the 70%.
"""
import os
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://hyperlocal-video.preview.emergentagent.com').rstrip('/')
TOKEN = 'sttest_SUQD-bH3lyJJOBLw-llOftxhxupA_9nU'
HEADERS = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}

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
    await db.matches.delete_many({'user_ids': {'$all': ['demo-00', 'demo-01']}})
    await db.swipes.delete_many({'user_id': 'demo-00', 'target_user_id': 'demo-01'})
    seed = await db.swipes.find_one({'user_id': 'demo-01', 'target_user_id': 'demo-00', 'action': 'like'})
    if not seed:
        await db.swipes.insert_one({'user_id': 'demo-01', 'target_user_id': 'demo-00', 'action': 'like'})
    client.close()


def cleanup():
    asyncio.run(_cleanup())


@pytest.fixture(autouse=True)
def _reset():
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
    others = [i for i in feed if i['id'] != 'demo-01']
    assert all(i['likes_you'] is False for i in others)


def _force_match():
    """Retry until demo _rng match fires (70%)."""
    for _ in range(15):
        cleanup()
        r = requests.post(f'{BASE_URL}/api/swipe', headers=HEADERS,
                          json={'target_user_id': 'demo-01', 'action': 'like'}, timeout=15)
        if r.status_code == 200 and r.json().get('match') is True:
            return r.json()
    return None


def test_instant_match_on_like_back():
    data = _force_match()
    assert data is not None, 'Match never triggered in 15 attempts'
    assert data.get('matched_user', {}).get('id') == 'demo-01'
    m = requests.get(f'{BASE_URL}/api/matches', headers=HEADERS, timeout=15)
    assert m.status_code == 200
    matches = m.json().get('matches', [])
    assert any(mm.get('user', {}).get('id') == 'demo-01' for mm in matches)


def test_matched_pair_excluded_from_likes_you():
    data = _force_match()
    assert data is not None
    feed = get_feed()
    d01 = find_item(feed, 'demo-01')
    if d01 is not None:
        assert d01['likes_you'] is False, 'Matched pair should not show likes_you'


def test_cleanup_restores_likes_you():
    _force_match()
    cleanup()
    feed = get_feed()
    d01 = find_item(feed, 'demo-01')
    assert d01 is not None
    assert d01['likes_you'] is True
