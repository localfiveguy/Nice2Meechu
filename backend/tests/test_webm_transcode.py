"""Regression tests for build v1.6.5-webm-transcode.

iOS Safari cannot decode webm (VP8/VP9). Uploads that arrive as video/webm
must be transcoded to H.264/AAC mp4 server-side before storing in GCS.
"""
import os
import subprocess
import tempfile

import imageio_ffmpeg
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "sttest_SnTv9X5GmiggyZq5vKriLEqtcFmSMN4s")
AUTH = {"Authorization": f"Bearer {TOKEN}"}
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


# ---------- fixture helpers: real (small) media files ----------
def _make_webm(path: str) -> None:
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libvpx", "-c:a", "libopus", path],
        check=True, capture_output=True, timeout=60,
    )


def _make_mp4(path: str) -> None:
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-movflags", "+faststart", path],
        check=True, capture_output=True, timeout=60,
    )


@pytest.fixture(scope="module")
def webm_file(tmp_path_factory):
    p = str(tmp_path_factory.mktemp("m") / "in.webm")
    _make_webm(p)
    return p


@pytest.fixture(scope="module")
def mp4_file(tmp_path_factory):
    p = str(tmp_path_factory.mktemp("m") / "in.mp4")
    _make_mp4(p)
    return p


def _upload(path: str, ctype: str, filename: str = "intro.bin"):
    with open(path, "rb") as fh:
        return requests.post(
            f"{BASE_URL}/api/users/video/upload",
            headers=AUTH,
            files={"file": (filename, fh, ctype)},
            timeout=120,
        )


# ---------- auth sanity ----------
def test_auth_token_valid():
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=AUTH, timeout=15)
    assert r.status_code == 200, r.text[:300]


# ---------- upload: webm → must land as real mp4 in GCS ----------
def test_webm_upload_returns_mp4_url_and_serves_true_mp4(webm_file):
    r = _upload(webm_file, "video/webm", "gen.webm")
    assert r.status_code == 200, f"webm upload failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    url = data["video_url"]
    assert ".mp4?v=" in url, f"expected .mp4?v= url, got {url}"

    # HEAD: correct MIME + range support
    h = requests.head(url, timeout=30, allow_redirects=True)
    assert h.status_code == 200
    assert h.headers.get("content-type", "").startswith("video/mp4")
    assert h.headers.get("accept-ranges", "").lower() == "bytes"

    # GET bytes & assert real H.264 mp4 (not webm bytes served with mp4 header).
    body = requests.get(url, timeout=60).content
    assert len(body) > 1024
    # ISO BMFF signature: bytes 4..8 are 'ftyp'
    assert body[4:8] == b"ftyp", (
        f"URL served with .mp4 extension but bytes are NOT mp4/ISO-BMFF "
        f"(first 16 bytes: {body[:16].hex()}). iOS Safari will still fail."
    )

    # ffprobe: video codec MUST be h264 (not vp8/vp9)
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tf.write(body); tf.flush()
        probe = subprocess.run(
            [FFMPEG, "-i", tf.name], capture_output=True, text=True, timeout=30,
        )
    info = probe.stderr
    assert "h264" in info.lower(), f"expected h264 codec, ffprobe said:\n{info[:600]}"


# ---------- upload: mp4 → unchanged path ----------
def test_mp4_upload_returns_mp4_url(mp4_file):
    r = _upload(mp4_file, "video/mp4", "gen.mp4")
    assert r.status_code == 200, r.text[:300]
    assert ".mp4?v=" in r.json()["video_url"]


# ---------- validation regressions ----------
def test_upload_rejects_too_small():
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tf.write(b"x" * 100); tf.flush()
        r = _upload(tf.name, "video/mp4")
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"


def test_upload_rejects_wrong_mime():
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tf:
        tf.write(b"y" * 2048); tf.flush()
        r = _upload(tf.name, "text/plain")
    assert r.status_code == 415, f"expected 415, got {r.status_code}"


def test_upload_rejects_oversize(tmp_path):
    # 26 MB of zeros; server should reject before writing to GCS.
    big = tmp_path / "big.mp4"
    with open(big, "wb") as fh:
        fh.write(b"\x00" * (26 * 1024 * 1024))
    r = _upload(str(big), "video/mp4")
    assert r.status_code == 413, f"expected 413, got {r.status_code}"


# ---------- feed: Marlton user should only see mp4 URLs ----------
def test_marlton_feed_all_mp4():
    # reset QA user location to Marlton
    loc = requests.post(
        f"{BASE_URL}/api/users/location",
        headers={**AUTH, "Content-Type": "application/json"},
        json={"city": "Marlton, NJ, USA", "lat": 39.8912, "lng": -74.9218},
        timeout=15,
    )
    assert loc.status_code == 200

    r = requests.get(f"{BASE_URL}/api/feed", headers=AUTH, timeout=30)
    assert r.status_code == 200
    feed = r.json().get("feed", [])
    assert len(feed) >= 1, "expected at least one nearby user in Marlton"

    real = [u for u in feed if not u.get("is_demo")]
    assert real, "expected real (non-demo) users in Marlton feed"
    for u in real:
        vu = u.get("video_url") or ""
        # allow blob: placeholders for users who haven't uploaded to GCS yet,
        # but any GCS URL must be .mp4 (never .webm).
        if vu.startswith("http"):
            assert ".webm" not in vu.split("?")[0], f".webm URL still served: {u.get('codename')} {vu}"

    codenames = {u.get("codename") for u in real}
    # Expected fixtures + Cosmic Phoenix per review request
    assert "Cosmic Phoenix" in codenames, f"missing Cosmic Phoenix, got {codenames}"
