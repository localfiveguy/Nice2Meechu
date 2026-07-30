import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { VideoEl } from "./VideoEl";

const CONFETTI_COLORS = ["#FF4D4D", "#00E5FF", "#FFD166", "#B388FF", "#7CFFB2"];

// CSS-only confetti rain — no library, ~40 pieces, self-cleaning (animation
// ends off-screen). Rendered only for the user's very first match.
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.9,
        dur: 2.2 + Math.random() * 1.8,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        size: 6 + Math.random() * 7,
        rot: Math.random() * 360,
      })),
    []
  );
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" data-testid="match-confetti">
      <style>{`@keyframes n2m-confetti-fall{0%{transform:translateY(-8vh) rotate(0deg)}100%{transform:translateY(108vh) rotate(720deg)}}`}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: 0,
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.45,
            background: p.color,
            borderRadius: 2,
            transform: `rotate(${p.rot}deg)`,
            animation: `n2m-confetti-fall ${p.dur}s linear ${p.delay}s both`,
            opacity: 0.9,
          }}
        />
      ))}
    </div>
  );
}

export function MatchCelebration({ data, onClose, onChat }) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReveal(true), 250);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center px-8 pt-10 pb-28 text-center overflow-y-auto"
      style={{ background: "radial-gradient(circle at 50% 30%, rgba(255,77,77,0.45), rgba(0,229,255,0.2), #050507 70%)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="match-celebration"
    >
      {data.first_match && <Confetti />}

      <div className="font-display text-4xl font-black leading-tight">
        It's a<br/>
        <span style={{ background: "linear-gradient(90deg,#FF4D4D,#00E5FF)", WebkitBackgroundClip: "text", color: "transparent" }}>
          match.
        </span>
      </div>

      <div className="mt-6 w-40 h-40 rounded-full overflow-hidden relative ring-4 ring-white/10 shrink-0">
        <VideoEl src={data.matched_user?.video_url} autoPlay muted loop playsInline className={`w-full h-full object-cover ${reveal ? "identity-clear" : "identity-blur"}`} />
      </div>

      <div className={`mt-4 transition-all duration-700 ${reveal ? "opacity-100" : "opacity-0"}`}>
        <div className="text-white/55 text-xs uppercase tracking-widest font-bold">No longer anonymous</div>
        <div className="font-display text-3xl font-black mt-1">@{data.matched_user?.handle || data.matched_user?.codename}</div>
      </div>

      {data.first_match && (
        <div
          className="mt-5 w-full max-w-xs rounded-2xl bg-white/5 border border-white/10 px-4 py-3 text-left"
          data-testid="first-match-tips"
        >
          <div className="text-[10px] uppercase tracking-widest font-bold text-[#00E5FF]">
            Your first match 🎉
          </div>
          <ul className="mt-2 space-y-1.5 text-xs text-white/70 font-medium">
            <li>👋 Say hi while it's fresh — one friendly line is plenty</li>
            <li>🎬 You've already seen each other's videos, so skip the small talk</li>
            <li>💬 Only you two can see this chat — not the whole town</li>
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2 w-full max-w-xs shrink-0">
        <button className="btn-primary flex items-center justify-center gap-2" onClick={onChat} data-testid="match-chat-button">
          <MessageCircle size={18} /> Say hi
        </button>
        <button className="btn-ghost" onClick={onClose} data-testid="match-close-button">Keep browsing</button>
      </div>
    </motion.div>
  );
}
