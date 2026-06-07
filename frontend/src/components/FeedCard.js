import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Heart, X, MapPin, Languages, AlertTriangle, RotateCcw,
} from "lucide-react";
import { api, translate } from "../lib/api";
import { AvatarThumb } from "./AvatarThumb";
import { track } from "../analytics";

export function FeedCard({ item, isActive, myLang, onLike, onPass, currentCity, onOpenLocation, muted, setMuted, positionLabel, isLastInCity, onRestart, paused }) {
  const vidRef = useRef(null);
  const [translated, setTranslated] = useState("");
  const [showCaption, setShowCaption] = useState(false);
  const [revealed] = useState(false);
  // AI demos: briefly flash a "hear me say my name" hint when the card first
  // becomes active. Goes away after 2.4s so it doesn't crowd the badge stack.
  const [demoNameHint, setDemoNameHint] = useState(false);

  useEffect(() => {
    if (!vidRef.current) return;
    if (isActive) {
      vidRef.current.currentTime = 0;
      vidRef.current.muted = muted;
      if (!paused) vidRef.current.play().catch(() => {});
      // start translation
      setShowCaption(false);
      setTranslated("");
      // Show the demo "hear me say my name" pill on activation (AI demos only)
      // and auto-dismiss after a short read.
      if (item.is_demo) {
        setDemoNameHint(true);
        const hintT = setTimeout(() => setDemoNameHint(false), 2400);
        const t = setTimeout(async () => {
          const out = await translate(item.transcript, myLang, item.source_lang);
          setTranslated(out);
          setShowCaption(true);
        }, 600);
        return () => { clearTimeout(t); clearTimeout(hintT); };
      }
      const t = setTimeout(async () => {
        const out = await translate(item.transcript, myLang, item.source_lang);
        setTranslated(out);
        setShowCaption(true);
      }, 600);
      return () => clearTimeout(t);
    } else {
      vidRef.current.pause();
      setDemoNameHint(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, item.transcript, item.source_lang, myLang, muted, item.is_demo]);

  // Respond to pause/play toggles WITHOUT restarting the video from t=0.
  // This is a separate effect from the activation one above so that hitting
  // Pause then Resume on the same clip preserves the playhead.
  useEffect(() => {
    if (!vidRef.current || !isActive) return;
    if (paused) vidRef.current.pause();
    else vidRef.current.play().catch(() => {});
  }, [paused, isActive]);

  return (
    <div className="absolute inset-0">
      <video
        ref={vidRef}
        loop
        playsInline
        muted={muted}
        preload="metadata"
        className="w-full h-full object-cover bg-black"
        onClick={() => {
          // Toggle on state AND on the underlying element so the change is
          // applied immediately (boolean DOM props don't always re-sync via
          // React's diffing alone on mid-playback toggles).
          setMuted((m) => {
            const next = !m;
            if (vidRef.current) vidRef.current.muted = next;
            track("feed_video_mute_toggled", { muted: next });
            return next;
          });
        }}
        data-testid="feed-card-video"
        key={item.video_url}
      >
        {item.video_url && item.video_url.endsWith(".mp4") && (
          <source src={item.video_url.replace(".mp4", ".webm")} type="video/webm" />
        )}
        <source src={item.video_url} type={item.video_url?.endsWith(".webm") ? "video/webm" : "video/mp4"} />
      </video>
      {/* tap-to-unmute pill (top-center) — shown only while muted */}
      {muted && (
        <div
          className="absolute top-5 left-1/2 -translate-x-1/2 glass-dark px-3 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/85 pointer-events-none flex items-center gap-1"
          data-testid="feed-mute-hint"
        >
          <span>🔇</span><span>tap to unmute</span>
        </div>
      )}
      {/* gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-transparent pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent pointer-events-none" />

      {/* anonymity codename */}
      <div className="absolute top-5 left-5 flex items-center gap-2 glass-dark px-3 py-1.5 rounded-full" data-testid="feed-codename-badge">
        <div className={`w-8 h-8 rounded-full overflow-hidden ring-1 ring-white/15 ${revealed ? "identity-clear" : "identity-blur"}`}>
          <AvatarThumb videoUrl={item.video_url} fallback={item.codename} className="w-8 h-8 rounded-full" />
        </div>
        <span className="font-display font-bold text-sm tracking-tight">{item.codename}</span>
        {item.is_demo && (
          <span
            className="ml-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-full bg-[#00E5FF]/20 text-[#00E5FF] ring-1 ring-[#00E5FF]/40"
            title="This intro was generated by AI to seed the community. It is not a real person."
            data-testid="feed-ai-demo-badge"
          >
            ✨ AI demo
          </span>
        )}
      </div>

      {/* AI demo: "hear me say my name" hint — fades in for ~2.4s on activation
          to prime the viewer that the audio actually speaks the codename, which
          is a key differentiator from text-based dating apps. */}
      {item.is_demo && demoNameHint && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="absolute top-[3.4rem] left-5 px-2.5 py-1 rounded-full bg-[#00E5FF]/15 ring-1 ring-[#00E5FF]/40 text-[#00E5FF] text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 pointer-events-none shadow-lg"
          data-testid="feed-demo-name-hint"
        >
          <span aria-hidden>🎬</span>
          <span>hear me say my name</span>
        </motion.div>
      )}

      {/* distance / location pill — tap to change feed location */}
      <button
        type="button"
        onClick={onOpenLocation}
        className="absolute top-5 right-5 flex items-center gap-1.5 glass-dark px-3 py-1.5 rounded-full text-xs font-bold transition hover:bg-white/15 active:scale-95"
        data-testid="feed-distance-badge"
        aria-label="Change feed location"
      >
        <MapPin size={12} className="text-[#FF4D4D]" />
        <span className="uppercase tracking-widest text-[10px] max-w-[140px] truncate">
          {currentCity ? currentCity.split(",")[0] : "set location"}
        </span>
      </button>

      {/* Position counter — sits directly under the city pill so the viewer
          always knows where they are in the city's chronological list. */}
      {positionLabel && (
        <div
          className="absolute top-[3.5rem] right-5 px-2 py-0.5 rounded-full glass-dark text-[10px] uppercase tracking-widest font-bold text-white/75 pointer-events-none"
          data-testid="feed-position-counter"
        >
          {positionLabel}
        </div>
      )}

      {/* "you've seen this" pill — only renders when the viewer is rewatching
          a video they previously swiped on (via Back / Restart). Subtle so
          it doesn't compete with the codename, but obvious enough that the
          viewer knows their prior decision is on the record. */}
      {item.prior_action === "like" && (
        <div
          className="absolute top-[5rem] right-5 flex items-center gap-1 px-2 py-1 rounded-full bg-[#FF4D4D]/20 ring-1 ring-[#FF4D4D]/40 text-[#FF4D4D] text-[10px] uppercase tracking-widest font-bold"
          data-testid="feed-prior-action-badge"
        >
          <Heart size={10} fill="#FF4D4D" /> Liked
        </div>
      )}
      {item.prior_action === "pass" && (
        <div
          className="absolute top-[5rem] right-5 flex items-center gap-1 px-2 py-1 rounded-full bg-white/10 ring-1 ring-white/15 text-white/65 text-[10px] uppercase tracking-widest font-bold"
          data-testid="feed-prior-action-badge"
        >
          <X size={10} /> Passed
        </div>
      )}
      {/* vibes pills removed by request — they cluttered the badge stack and
          weren't meaningful enough (random sample from a small pool) to keep. */}

      {/* translation overlay */}
      {showCaption && (
        <div className="absolute bottom-32 left-4 right-24 glass-dark rounded-2xl p-3 flex flex-col gap-1.5" data-testid="translation-overlay">
          <span className="inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-md bg-[#00E5FF]/15 text-[#00E5FF] text-[10px] font-bold uppercase tracking-widest">
            <Languages size={10} /> translated · {item.source_lang}→{myLang}
          </span>
          {item.source_lang !== myLang && (
            <span className="text-white/50 text-xs italic line-clamp-1">{item.transcript}</span>
          )}
          <span className="text-white text-[15px] font-medium leading-snug translation-text">
            {translated || item.transcript}
          </span>
        </div>
      )}

      {/* action stack right */}
      <div className="absolute bottom-32 right-4 flex flex-col gap-3 items-center">
        <button
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/65 hover:text-white bg-black/35 hover:bg-black/55 transition"
          onClick={async () => {
            const reason = window.prompt(
              "Report this user. Type one of: impersonation, harassment, inappropriate, spam, underage, csam, other"
            );
            if (!reason) return;
            try {
              await api.post("/users/report", { target_user_id: item.id, reason: reason.toLowerCase().trim() });
              toast.success("Thanks for reporting. We won't show this user again.");
              onPass();
            } catch {
              toast.error("Couldn't submit report — please submit our safety form instead");
            }
          }}
          data-testid="feed-report-button"
          aria-label="Report this user"
          title="Report this user"
        >
          <AlertTriangle size={16} />
        </button>
        {/* On the final video in this city, the Skip button morphs into a
            "Restart from the top" button — passing on the last video has no
            "next" to go to anyway, so we repurpose the slot for the action
            most users actually want there (rewatch from #1). */}
        {isLastInCity ? (
          <button
            className="btn-icon"
            style={{ background: "rgba(255,255,255,0.12)" }}
            onClick={onRestart}
            data-testid="feed-end-restart-button"
            aria-label="Restart from the first video in this city"
            title="You've reached the end — tap to start over"
          >
            <RotateCcw size={22} />
          </button>
        ) : (
          <button className="btn-icon" style={{ background: "rgba(255,255,255,0.12)" }} onClick={onPass} data-testid="feed-pass-button">
            <X size={22} />
          </button>
        )}
        <button
          className="btn-icon"
          style={{ background: "linear-gradient(180deg,#FF6B6B,#FF3D3D)", boxShadow: "0 10px 30px -8px rgba(255,77,77,0.7)" }}
          onClick={onLike}
          data-testid="feed-like-button"
        >
          <Heart size={24} fill="white" />
        </button>
      </div>
    </div>
  );
}
