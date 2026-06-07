import React from "react";
import { VideoEl } from "./VideoEl";

/**
 * Tiny avatar that shows the first frame of a user's intro video.
 *
 * Replaces the legacy emoji avatars across Feed badges, Profile cards, and
 * the Share card. We render a `<video>` element without `autoPlay` —
 * browsers paint the first frame as a static poster, which gives us a real
 * face thumbnail at zero extra storage cost (no separate poster JPEG to
 * generate or host). `preload="metadata"` is enough to force the frame fetch
 * without pulling the whole clip.
 *
 * Fallback: when the user hasn't recorded an intro yet (pre-onboarding
 * completion edge cases), we paint a soft gradient with the first letter
 * of their codename/handle — quietly graceful instead of an empty black box.
 *
 * Props:
 *   videoUrl  - the user's intro video URL (may be null/empty)
 *   fallback  - string to use for the initial when videoUrl is missing
 *               (typically codename or handle)
 *   className - applied to the outer wrapper; size + shape live here
 *               (e.g. "w-8 h-8 rounded-full")
 */
export function AvatarThumb({ videoUrl, fallback = "?", className = "w-10 h-10 rounded-full" }) {
  const initial = (fallback || "?").trim().charAt(0).toUpperCase() || "?";
  // If we have a video, render the first frame. Otherwise, gradient + letter.
  if (videoUrl) {
    return (
      <div className={`overflow-hidden bg-black ${className}`} data-testid="avatar-thumb">
        <VideoEl
          src={videoUrl}
          loop
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }
  return (
    <div
      className={`flex items-center justify-center text-white font-display font-black ${className}`}
      style={{ background: "linear-gradient(135deg,#FF4D4D,#00E5FF)" }}
      data-testid="avatar-thumb-fallback"
      aria-label={`Avatar placeholder for ${fallback}`}
    >
      <span className="text-sm">{initial}</span>
    </div>
  );
}
