"""Silent intro rejection — mic-denied recordings must never be accepted."""
import os
import subprocess
import sys

import imageio_ffmpeg
import pytest
import requests

sys.path.insert(0, "/app/backend")
from transcode import SILENCE_MAX_DB, measure_max_volume  # noqa: E402

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
AUTH = {"Authorization": f"Bearer {TOKEN}"}
FF = imageio_ffmpeg.get_ffmpeg_exe()


def _mk_clip(path, audio_src):
    subprocess.run(
        [FF, "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2:r=15",
         "-f", "lavfi", "-i", audio_src, "-shortest",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path],
        check=True, capture_output=True, timeout=60,
    )


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp("clips")
    silent = str(d / "silent.mp4")
    audible = str(d / "audible.mp4")
    _mk_clip(silent, "anullsrc=r=48000:cl=mono")
    _mk_clip(audible, "sine=frequency=440:sample_rate=48000:duration=2")
    return silent, audible


def test_measure_max_volume(clips):
    silent, audible = clips
    assert measure_max_volume(silent) < SILENCE_MAX_DB
    assert measure_max_volume(audible) > SILENCE_MAX_DB


def test_upload_rejects_silent_video(clips):
    silent, _ = clips
    with open(silent, "rb") as f:
        r = requests.post(f"{BASE_URL}/api/users/video/upload", headers=AUTH,
                          files={"file": ("intro.mp4", f, "video/mp4")}, timeout=60)
    assert r.status_code == 422, r.text
    assert "hear any sound" in r.json()["detail"]


def test_upload_accepts_audible_video(clips):
    _, audible = clips
    with open(audible, "rb") as f:
        r = requests.post(f"{BASE_URL}/api/users/video/upload", headers=AUTH,
                          files={"file": ("intro.mp4", f, "video/mp4")}, timeout=120)
    assert r.status_code == 200, r.text
    assert r.json()["video_url"].startswith("https://storage.googleapis.com/")


def test_upload_rejects_silent_webm(clips):
    silent_webm = os.path.join(os.path.dirname(clips[0]), "silent.webm")
    subprocess.run(
        [FF, "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2:r=15",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-shortest",
         "-c:v", "libvpx", "-c:a", "libopus", silent_webm],
        check=True, capture_output=True, timeout=60,
    )
    with open(silent_webm, "rb") as f:
        r = requests.post(f"{BASE_URL}/api/users/video/upload", headers=AUTH,
                          files={"file": ("intro.webm", f, "video/webm")}, timeout=60)
    assert r.status_code == 422, r.text
