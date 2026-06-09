import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MapPin, X } from "lucide-react";
import { api } from "../lib/api";
import { VideoEl } from "./VideoEl";

/**
 * Floating preview widget shown on the SignInScreen. Cycles through AI demo
 * intro videos so pre-signup visitors can see exactly what a "good" Nice2Meechu
 * intro looks like before recording their own. Hugely conversion-friendly:
 * removes the "what do I even do?" friction before they create an account.
 *
 * Behavior:
 *  - Fetches a shuffled batch of demos from /api/demos/sample (public; no auth)
 *  - Plays one at a time, auto-advances on `ended` (each Sora clip is ~7s)
 *  - Tap the video to manually advance to the next demo
 *  - Collapsible — dismissed state persists in sessionStorage so a returning
 *    visitor isn't forced to re-dismiss it on every page reload
 *  - Pinned to the bottom-right via fixed positioning so it never collides
 *    with the centered sign-in card
 */
export function DemoPeekWidget() {
  const [demos, setDemos] = useState([]);
  const [idx, setIdx] = useState(0);
  const [muted, setMuted] = useState(true);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem("n2m_demo_peek_dismissed") === "1";
  });
  const vidRef = useRef(null);

  // Fetch a random batch of demo videos once on mount. Public endpoint, so
  // we don't need an auth token. If the request fails (rare — backend would
  // have to be down), silently no-op: the widget just won't render.
  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get("/demos/sample?limit=15");
        if (cancelled) return;
        const list = (data?.demos || []).filter((d) => d.video_url);
        if (list.length === 0) return;
        setDemos(list);
      } catch (err) {
        console.warn("demo-peek fetch failed (widget hidden)", err);
      }
    })();
    return () => { cancelled = true; };
  }, [dismissed]);

  // Auto-advance to the next demo when the current video ends. Wrap the
  // index so the list cycles forever instead of stopping at the last item.
  const advance = useCallback(() => {
    setIdx((i) => (demos.length === 0 ? 0 : (i + 1) % demos.length));
  }, [demos.length]);
  const goPrev = useCallback(() => {
    setIdx((i) => (demos.length === 0 ? 0 : (i - 1 + demos.length) % demos.length));
  }, [demos.length]);

  // Toggle audio. The video element's `muted` boolean prop won't always
  // sync mid-playback via React's diffing alone, so we mirror the change
  // onto the underlying DOM node too — same belt-and-suspenders pattern
  // we use in FeedCard.
  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      if (vidRef.current) vidRef.current.muted = next;
      return next;
    });
  };

  // TikTok-style vertical swipe gestures on the preview card:
  //   swipe UP   → advance to next demo
  //   swipe DOWN → go back to previous demo
  //   tap       → toggle mute (handled by onClick below)
  // We track touchstart Y and decide on touchend: anything >30px vertical
  // movement is treated as a swipe (not a tap). Below the threshold falls
  // through to the click handler so a normal tap still toggles audio.
  const touchStartRef = useRef({ y: 0, t: 0, swiped: false });
  const onTouchStart = (e) => {
    touchStartRef.current = {
      y: e.touches?.[0]?.clientY ?? 0,
      t: Date.now(),
      swiped: false,
    };
  };
  const onTouchEnd = (e) => {
    const start = touchStartRef.current;
    const endY = e.changedTouches?.[0]?.clientY ?? start.y;
    const dy = endY - start.y;
    const dt = Date.now() - start.t;
    // Treat as swipe if >30px AND <500ms (fast flick) — slower long drags
    // are likely accidental scrolls and shouldn't trigger navigation.
    if (Math.abs(dy) > 30 && dt < 500) {
      touchStartRef.current.swiped = true;
      e.preventDefault();
      if (dy < 0) advance();   // finger moved UP → next
      else goPrev();           // finger moved DOWN → previous
    }
  };
  // Suppress the click handler when a swipe was just registered, so the
  // mute doesn't accidentally toggle at the end of a flick gesture.
  const onClick = () => {
    if (touchStartRef.current.swiped) {
      touchStartRef.current.swiped = false;
      return;
    }
    toggleMute();
  };

  const dismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("n2m_demo_peek_dismissed", "1");
    }
  };

  if (dismissed || demos.length === 0) return null;
  const current = demos[idx];
  if (!current) return null;
  const cityShort = (current.city || "").split(",")[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.6, type: "spring", stiffness: 240, damping: 26 }}
      className="fixed bottom-5 right-5 z-30 w-[136px]"
      data-testid="demo-peek-widget"
    >
      {/* Top label — invites the user to tap the video to enable audio.
          Switches to a "sound on" indicator once they've engaged so they
          can see the current state at a glance. */}
      <div
        className={`mb-1.5 px-2 py-1 rounded-full text-[9px] uppercase tracking-widest font-bold text-center flex items-center justify-center gap-1 ${
          muted
            ? "bg-[#00E5FF]/15 ring-1 ring-[#00E5FF]/45 text-[#00E5FF] animate-pulse"
            : "bg-white/8 ring-1 ring-white/20 text-white/70"
        }`}
        data-testid="demo-peek-label"
      >
        {muted ? <>🔊 Tap to hear</> : <>🔈 Sound on</>}
      </div>
      <div className="rounded-2xl overflow-hidden border border-white/15 bg-black shadow-2xl shadow-black/60 relative">
        {/* Dismiss button — small × in the top-left so it doesn't steal focus
            from the codename/city badges on the top-right. */}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide examples"
          className="absolute top-1 left-1 z-10 w-6 h-6 rounded-full bg-black/55 backdrop-blur-md text-white/85 hover:text-white active:scale-95 flex items-center justify-center"
          data-testid="demo-peek-dismiss"
        >
          <X size={12} />
        </button>

        {/* Video — tapping the video toggles audio. Auto-advances to the
            next demo when the current clip ends (via `onEnded`). */}
        <button
          type="button"
          onClick={onClick}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className="block w-full aspect-[9/16] relative active:scale-[0.99] transition touch-none"
          aria-label={muted ? "Tap to hear, swipe up for next, swipe down for previous" : "Tap to mute, swipe up for next, swipe down for previous"}
          data-testid="demo-peek-video-button"
        >
          <VideoEl
            ref={vidRef}
            src={current.video_url}
            autoPlay
            loop={false}
            muted={muted}
            playsInline
            preload="metadata"
            onEnded={advance}
            className="absolute inset-0 w-full h-full object-cover"
          />
          {/* Overlays */}
          <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-[#00E5FF]/25 ring-1 ring-[#00E5FF]/45 text-[#00E5FF] text-[8px] uppercase tracking-widest font-bold pointer-events-none">
            ✨ AI demo
          </div>
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/85 to-transparent pointer-events-none">
            <div className="font-display font-bold text-[11px] leading-tight truncate text-white">
              {current.codename}
            </div>
            {cityShort && (
              <div className="text-[9px] uppercase tracking-widest font-bold text-white/65 flex items-center gap-0.5 truncate">
                <MapPin size={8} className="text-[#FF4D4D] shrink-0" />
                <span className="truncate">{cityShort}</span>
              </div>
            )}
          </div>
        </button>
      </div>
    </motion.div>
  );
}
