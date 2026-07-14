"""Tests for /api/users/video/upload codec-suffixed Content-Type normalization.

Regression: iOS Safari MediaRecorder emits Content-Types like
'video/mp4;codecs=avc1.42E01E,mp4a.40.2' — backend must strip the codec
suffix and accept the base type, otherwise upload fails 415.
"""
import os
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL") or "https://hyperlocal-video.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# Dummy payload >1KB (backend rejects <1024 bytes as corrupt)
DUMMY = b"\x00\x00\x00\x18ftypmp42" + os.urandom(4096)


def _upload(ctype: str):
    files = {"file": ("intro.bin", DUMMY, ctype)}
    return requests.post(f"{BASE_URL}/api/users/video/upload", headers=AUTH, files=files, timeout=60)


def test_auth_token_valid():
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=AUTH, timeout=15)
    assert r.status_code == 200, f"seed token invalid: {r.status_code} {r.text[:200]}"


def test_upload_codec_suffixed_mp4():
    """The exact regression: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' must return 200."""
    r = _upload("video/mp4;codecs=avc1.42E01E,mp4a.40.2")
    assert r.status_code == 200, f"codec-suffixed mp4 rejected: {r.status_code} {r.text[:300]}"
    data = r.json()
    assert "video_url" in data
    assert ".mp4" in data["video_url"], f"expected .mp4 url, got {data['video_url']}"


def test_upload_plain_mp4():
    r = _upload("video/mp4")
    assert r.status_code == 200, f"plain mp4 rejected: {r.status_code} {r.text[:300]}"
    assert ".mp4" in r.json()["video_url"]


def test_upload_plain_webm():
    r = _upload("video/webm")
    assert r.status_code == 200, f"plain webm rejected: {r.status_code} {r.text[:300]}"
    assert ".webm" in r.json()["video_url"]


def test_upload_codec_suffixed_webm():
    r = _upload("video/webm;codecs=vp8,opus")
    assert r.status_code == 200, f"codec-suffixed webm rejected: {r.status_code} {r.text[:300]}"
    assert ".webm" in r.json()["video_url"]


def test_upload_rejects_bogus_type():
    r = _upload("video/x-matroska")
    assert r.status_code == 415, f"expected 415, got {r.status_code}: {r.text[:200]}"
