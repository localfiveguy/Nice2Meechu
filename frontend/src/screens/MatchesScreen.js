import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowRight, Heart, Play, X } from "lucide-react";
import { api } from "../lib/api";
import { BottomNav } from "../components/BottomNav";
import { VideoEl } from "../components/VideoEl";
import { track } from "../analytics";

export function MatchesScreen({ user, unreadMatches, onTab, onOpenChat, onLoaded }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmUnmatch, setConfirmUnmatch] = useState(null); // {match_id, handle} | null
  const [previewVideo, setPreviewVideo] = useState(null); // {video_url, handle} | null
  useEffect(() => {
    api.get("/matches")
      .then(({ data }) => {
        setMatches(data.matches);
        // GET /api/matches resets last_matches_viewed_at server-side; mirror
        // that locally so the You-tab green dot disappears immediately.
        onLoaded?.();
      })
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doUnmatch = async () => {
    if (!confirmUnmatch) return;
    const { user_id: targetId, match_id } = confirmUnmatch;
    setConfirmUnmatch(null);
    // Optimistic: remove from local list immediately. Backend deletes the
    // match and records a block — if anything fails, we just refetch.
    setMatches((prev) => prev.filter((m) => m.match_id !== match_id));
    try {
      await api.post("/users/block", { target_user_id: targetId });
      track("match_unmatched", { match_id });
      toast.success("Unmatched. They can't message you anymore.");
    } catch {
      toast.error("Couldn't unmatch — please try again");
      // refresh to restore truth
      const { data } = await api.get("/matches");
      setMatches(data.matches);
    }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-6 pt-12 pb-32 bg-grain"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="matches-screen"
    >
      <h2 className="font-display text-3xl font-black">Matches.</h2>
      <p className="text-sm text-white/55 mt-2 mb-6">Mutual sparks only.</p>

      {loading && <div className="text-white/55 text-sm">Loading…</div>}
      {!loading && matches.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 text-white/55">
          <Heart size={32} className="text-[#FF4D4D]" />
          <p className="text-sm max-w-[220px]">No matches yet. Like a few intros in the feed.</p>
        </div>
      )}

      <div className="flex flex-col gap-3 overflow-y-auto no-scrollbar">
        {matches.map((m) => (
          <div
            key={m.match_id}
            className="glass-dark p-3 rounded-3xl flex items-center gap-2"
            data-testid={`match-row-${m.match_id}`}
          >
            {/* Left: unmatch toggle. Visually a pill switch (red dot = ON
                match active; tap to confirm-then-disable). We use a button
                + confirm-modal so an accidental swipe doesn't kill a match. */}
            <button
              onClick={() => setConfirmUnmatch({ match_id: m.match_id, user_id: m.user.id, handle: m.user.handle || m.user.codename })}
              className="shrink-0 w-10 h-6 rounded-full bg-[#FF4D4D]/30 ring-1 ring-[#FF4D4D]/60 relative active:scale-95 transition"
              aria-label={`Unmatch ${m.user.handle || m.user.codename}`}
              data-testid={`match-toggle-${m.match_id}`}
              title="Tap to unmatch"
            >
              <span className="absolute right-1 top-1 w-4 h-4 rounded-full bg-[#FF4D4D] shadow-md" />
            </button>

            {/* Center: avatar + play overlay. Tapping pops a modal that
                replays their intro video — the original "spark" moment. */}
            <button
              onClick={() => setPreviewVideo({ video_url: m.user.video_url, handle: m.user.handle || m.user.codename })}
              className="relative shrink-0 w-14 h-14 rounded-2xl overflow-hidden bg-black mx-auto active:scale-95 transition"
              aria-label={`Replay intro from ${m.user.handle || m.user.codename}`}
              data-testid={`match-replay-${m.match_id}`}
            >
              <VideoEl src={m.user.video_url} loop muted playsInline className="w-full h-full object-cover" />
              <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                <Play size={20} fill="white" className="text-white drop-shadow" />
              </span>
            </button>

            {/* Tap-to-chat — handle + arrow take the rest of the row. */}
            <button
              onClick={() => onOpenChat(m)}
              className="flex-1 flex items-center gap-2 text-left min-w-0"
              data-testid={`match-chat-${m.match_id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-display font-bold truncate">@{m.user.handle || m.user.codename}</div>
                <div className="text-xs text-white/50">Tap to chat</div>
              </div>
              <ArrowRight size={18} className="text-white/40 shrink-0" />
            </button>
          </div>
        ))}
      </div>

      {/* Intro-video replay modal. */}
      {previewVideo && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/85 backdrop-blur-sm p-6"
          onClick={() => setPreviewVideo(null)}
          data-testid="match-video-preview"
        >
          <div className="relative max-w-[340px] w-full aspect-[9/16] rounded-3xl overflow-hidden bg-black" onClick={(e) => e.stopPropagation()}>
            <VideoEl src={previewVideo.video_url} autoPlay loop playsInline controls className="w-full h-full object-cover" />
            <div className="absolute top-3 left-3 px-2 py-1 rounded-full glass-dark text-[10px] uppercase tracking-widest font-bold">@{previewVideo.handle}</div>
            <button
              onClick={() => setPreviewVideo(null)}
              aria-label="Close"
              className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/55 backdrop-blur-md flex items-center justify-center text-white/85 hover:text-white active:scale-95"
              data-testid="match-video-close"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Confirm unmatch modal. */}
      {confirmUnmatch && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm px-6"
          data-testid="match-unmatch-confirm"
        >
          <div className="bg-[#0c0c10] border border-white/10 rounded-3xl p-6 max-w-[320px] w-full flex flex-col gap-3 shadow-2xl">
            <div className="font-display text-xl font-black">Unmatch @{confirmUnmatch.handle}?</div>
            <p className="text-sm text-white/65 leading-snug">
              You won't be able to message each other anymore, and they won't appear in your feed.
              This is permanent.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setConfirmUnmatch(null)}
                className="flex-1 btn-ghost"
                data-testid="match-unmatch-cancel"
              >
                Cancel
              </button>
              <button
                onClick={doUnmatch}
                className="flex-1 btn-primary"
                style={{ background: "#FF4D4D" }}
                data-testid="match-unmatch-confirm-btn"
              >
                Unmatch
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav active="matches" onTab={onTab} userPicture={user?.picture} userHandle={user?.handle} unreadCount={unreadMatches} />
    </motion.div>
  );
}
