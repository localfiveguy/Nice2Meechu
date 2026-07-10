"""Test the unlike swipe flow for Nice2Meechu."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com").rstrip("/")
TOKEN = "sttest_SUQD-bH3lyJJOBLw-llOftxhxupA_9nU"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
TARGET = "demo-01"


def _cleanup():
    requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "unlike"}, headers=HEADERS)


@pytest.fixture(autouse=True)
def cleanup_before_after():
    _cleanup()
    yield
    _cleanup()


def _get_feed_item(user_id):
    r = requests.get(f"{BASE_URL}/api/feed", headers=HEADERS)
    assert r.status_code == 200, f"feed failed: {r.status_code} {r.text}"
    data = r.json()
    items = data if isinstance(data, list) else data.get("items", data.get("feed", []))
    for it in items:
        # try common keys
        uid = it.get("user_id") or it.get("id") or (it.get("user") or {}).get("id")
        if uid == user_id:
            return it
    return None


def test_like_then_unlike_flow():
    # (a) Like
    r = requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "like"}, headers=HEADERS)
    assert r.status_code == 200, f"like failed: {r.status_code} {r.text}"

    # (b) Feed shows prior_action = 'like'
    item = _get_feed_item(TARGET)
    assert item is not None, "demo-01 not found in feed"
    assert item.get("prior_action") == "like", f"expected prior_action=like, got {item.get('prior_action')}"

    # (c) Unlike
    r = requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "unlike"}, headers=HEADERS)
    assert r.status_code == 200, f"unlike failed: {r.status_code} {r.text}"
    body = r.json()
    assert body.get("match") is False, f"expected match:false, got {body}"

    # (d) Feed prior_action absent/null
    item = _get_feed_item(TARGET)
    assert item is not None, "demo-01 vanished from feed"
    assert not item.get("prior_action"), f"expected null prior_action, got {item.get('prior_action')}"


def test_pass_then_unlike_no_500():
    r = requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "pass"}, headers=HEADERS)
    assert r.status_code == 200, f"pass failed: {r.status_code} {r.text}"

    r = requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "unlike"}, headers=HEADERS)
    assert r.status_code == 200, f"unlike after pass failed: {r.status_code} {r.text}"


def test_unlike_when_no_prior_swipe():
    _cleanup()
    r = requests.post(f"{BASE_URL}/api/swipe", json={"target_user_id": TARGET, "action": "unlike"}, headers=HEADERS)
    assert r.status_code == 200, f"unlike on no prior failed: {r.status_code} {r.text}"
    assert r.json().get("match") is False
