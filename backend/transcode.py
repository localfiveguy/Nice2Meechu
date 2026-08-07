"""webm → H.264 mp4 transcoding. iOS Safari cannot decode webm (VP8/VP9),
so Chrome/Android-recorded intros must be re-encoded or iPhones see a black
card. Uses the static ffmpeg binary bundled with the imageio-ffmpeg wheel —
no system ffmpeg needed, works identically in the production image."""
import re
import subprocess

import imageio_ffmpeg

# Peak level below this = the mic was denied/muted (true silence is a flat
# -91 dB; even a whisper in a quiet room peaks well above -60 dB).
SILENCE_MAX_DB = -60.0


def transcode_to_mp4(src_path: str, dst_path: str) -> None:
    """Re-encode any input video to universally-playable H.264/AAC mp4.
    faststart moves the moov atom up so <video> can start before full download.
    Raises on failure (caller decides the fallback)."""
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run(
        [
            ffmpeg, "-y", "-i", src_path,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "96k",
            dst_path,
        ],
        check=True,
        capture_output=True,
        timeout=180,
    )


def measure_max_volume(src_path: str):
    """Peak audio level in dB via ffmpeg volumedetect. Returns:
    -999.0 when the file has NO audio stream at all (definitely silent),
    a float dB value when measured, or None when detection itself failed
    (caller should fail-open)."""
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    out = subprocess.run(
        [ffmpeg, "-i", src_path, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if "Audio:" not in out.stderr:
        return -999.0
    m = re.search(r"max_volume:\s*(-?[\d.]+)\s*dB", out.stderr)
    return float(m.group(1)) if m else None
