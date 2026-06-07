import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { MessageCircle } from "lucide-react";
import { VideoEl } from "./VideoEl";

export function MatchCelebration({ data, onClose, onChat }) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReveal(true), 250);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center px-8 text-center"
      style={{ background: "radial-gradient(circle at 50% 30%, rgba(255,77,77,0.45), rgba(0,229,255,0.2), #050507 70%)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="match-celebration"
    >
      <div className="font-display text-4xl font-black leading-tight">
        It's a<br/>
        <span style={{ background: "linear-gradient(90deg,#FF4D4D,#00E5FF)", WebkitBackgroundClip: "text", color: "transparent" }}>
          match.
        </span>
      </div>

      <div className="mt-8 w-44 h-44 rounded-full overflow-hidden relative ring-4 ring-white/10">
        <VideoEl src={data.matched_user?.video_url} autoPlay muted loop playsInline className={`w-full h-full object-cover ${reveal ? "identity-clear" : "identity-blur"}`} />
      </div>

      <div className={`mt-5 transition-all duration-700 ${reveal ? "opacity-100" : "opacity-0"}`}>
        <div className="text-white/55 text-xs uppercase tracking-widest font-bold">No longer anonymous</div>
        <div className="font-display text-3xl font-black mt-1">@{data.matched_user?.handle || data.matched_user?.codename}</div>
      </div>

      <div className="mt-10 flex flex-col gap-2 w-full max-w-xs">
        <button className="btn-primary flex items-center justify-center gap-2" onClick={onChat} data-testid="match-chat-button">
          <MessageCircle size={18} /> Say hi
        </button>
        <button className="btn-ghost" onClick={onClose} data-testid="match-close-button">Keep browsing</button>
      </div>
    </motion.div>
  );
}
