"""Tests for /api/users/video/upload codec-suffixed Content-Type normalization.

Regression: iOS Safari MediaRecorder emits Content-Types like
'video/mp4;codecs=avc1.42E01E,mp4a.40.2' — backend must strip the codec
suffix and accept the base type, otherwise upload fails 415.

Uses real ffmpeg-generated clips WITH audio: the silence gate (2026-06)
rejects soundless/corrupt uploads with 422, so dummy byte payloads no
longer pass. Real webm now transcodes to mp4 on upload.
"""
import os
import subprocess

import imageio_ffmpeg
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL") or "https://hyperlocal-video.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
AUTH = {"Authorization": f"Bearer {TOKEN}"}
FF = imageio_ffmpeg.get_ffmpeg_exe()


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp("codec_clips")
    out = {}
    for ext, vcodec, acodec in (("mp4", "libx264", "aac"), ("webm", "libvpx", "libopus")):
        path = str(d / f"clip.{ext}")
        subprocess.run(
            [FF, "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2:r=15",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
             "-shortest", "-c:v", vcodec, "-pix_fmt", "yuv420p", "-c:a", acodec, path],
            check=True, capture_output=True, timeout=60,
        )
        out[ext] = open(path, "rb").read()
    return out


def _upload(payload: bytes, ctype: str):
    files = {"file": ("intro.bin", payload, ctype)}
    return requests.post(f"{BASE_URL}/api/users/video/upload", headers=AUTH, files=files, timeout=120)


def test_auth_token_valid():
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=AUTH, timeout=15)
    assert r.status_code == 200, f"seed token invalid: {r.status_code} {r.text[:200]}"


def test_upload_codec_suffixed_mp4(clips):
    """The exact regression: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' must return 200."""
    r = _upload(clips["mp4"], "video/mp4;codecs=avc1.42E01E,mp4a.40.2")
    assert r.status_code == 200, f"codec-suffixed mp4 rejected: {r.status_code} {r.text[:300]}"
    data = r.json()
    assert "video_url" in data
    assert ".mp4" in data["video_url"], f"expected .mp4 url, got {data['video_url']}"


def test_upload_plain_mp4(clips):
    r = _upload(clips["mp4"], "video/mp4")
    assert r.status_code == 200, f"plain mp4 rejected: {r.status_code} {r.text[:300]}"
    assert ".mp4" in r.json()["video_url"]


def test_upload_plain_webm(clips):
    r = _upload(clips["webm"], "video/webm")
    assert r.status_code == 200, f"plain webm rejected: {r.status_code} {r.text[:300]}"
    assert ".mp4" in r.json()["video_url"], "webm should transcode to mp4"


def test_upload_codec_suffixed_webm(clips):
    r = _upload(clips["webm"], "video/webm;codecs=vp8,opus")
    assert r.status_code == 200, f"codec-suffixed webm rejected: {r.status_code} {r.text[:300]}"
    assert ".mp4" in r.json()["video_url"], "webm should transcode to mp4"


def test_upload_rejects_bogus_type(clips):
    r = _upload(clips["mp4"], "video/x-matroska")
    assert r.status_code == 415, f"expected 415, got {r.status_code}: {r.text[:200]}"


def test_upload_rejects_corrupt_bytes():
    """Unparseable 'video' bytes now trip the silence gate → 422."""
    dummy = b"\x00\x00\x00\x18ftypmp42" + os.urandom(4096)
    r = _upload(dummy, "video/mp4")
    assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text[:200]}"
