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

        {/* Video — tapping anywhere on the video advances to the next demo
            so a curious visitor can browse multiple examples quickly. */}
        <button
          type="button"
          onClick={advance}
          className="block w-full aspect-[9/16] relative active:scale-[0.99] transition"
          aria-label={`Example intro from ${current.codename}${cityShort ? " in " + cityShort : ""} — tap for next`}
          data-testid="demo-peek-video-button"
        >
          <VideoEl
            ref={vidRef}
            src={current.video_url}
            autoPlay
            loop={false}
            muted
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
      {/* Caption under the card — tells the visitor what they're looking at
          without taking up vertical space inside the card itself. */}
      <p
        className="mt-1.5 px-1 text-[9px] uppercase tracking-widest font-bold text-white/55 text-center leading-tight"
        data-testid="demo-peek-caption"
      >
        🎬 Example intro<br />tap for next
      </p>
    </motion.div>
  );
}
