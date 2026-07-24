"""webm → H.264 mp4 transcoding. iOS Safari cannot decode webm (VP8/VP9),
so Chrome/Android-recorded intros must be re-encoded or iPhones see a black
card. Uses the static ffmpeg binary bundled with the imageio-ffmpeg wheel —
no system ffmpeg needed, works identically in the production image."""
import subprocess

import imageio_ffmpeg


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
