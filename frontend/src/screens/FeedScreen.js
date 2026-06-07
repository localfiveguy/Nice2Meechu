import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft, MapPin, Pause, Play, RotateCcw, Share2,
} from "lucide-react";
import { api, shareOrCopy } from "../lib/api";
import { BottomNav } from "../components/BottomNav";
import { FeedCard } from "../components/FeedCard";
import { ChangeLocationScreen } from "./ChangeLocationScreen";
import { track } from "../analytics";

export function FeedScreen({ user, setUser, unreadMatches, onMatch, onTab }) {
  // We now keep the FULL feed (including videos the viewer already swiped on)
  // so Back/Restart can navigate to them. `prior_action` on each item tracks
  // pass/like state; on initial mount we auto-scroll to the first unswiped.
  const [feed, setFeed] = useState([]);
  const [cityStats, setCityStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const [locationOpen, setLocationOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // Mute preference is feed-wide, not per-card. Persisted to localStorage so
  // the user's choice survives reloads / app re-opens. Defaults to muted
  // (true) because browsers won't autoplay audio unless the user first
  // explicitly tapped to unmute — we'd just produce silent video either way.
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("n2m_feed_muted") !== "0"; } catch { return true; }
  });
  const setMutedPersist = useCallback((nextOrFn) => {
    setMuted((prev) => {
      const next = typeof nextOrFn === "function" ? nextOrFn(prev) : nextOrFn;
      try { localStorage.setItem("n2m_feed_muted", next ? "1" : "0"); } catch { /* localStorage full / disabled */ }
      return next;
    });
  }, []);
  // Pause state applies to the active video only. Resets to playing whenever
  // the user swipes to a different video — TikTok/Reels behavior, where
  // pause is intentionally per-clip and you can't accidentally end up on
  // a silent paused feed without realizing.
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef(null);
  const itemRefs = useRef([]);
  const programmaticScrollUntil = useRef(0);
  // Stable lowercase city key for /users/me/city-position requests.
  const cityKey = (user?.city || "").split(",")[0].trim().toLowerCase();

  const scrollToIdx = useCallback((idx, behavior = "smooth") => {
    const el = itemRefs.current[idx];
    if (!el) return;
    // Lock out the intersection observer briefly so the active-index doesn't
    // chase the scroll animation past our destination.
    programmaticScrollUntil.current = Date.now() + 700;
    setActiveIdx(idx);
    setPaused(false);  // resume play on every navigation
    el.scrollIntoView({ behavior, block: "start" });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/feed");
      setFeed(data.feed);
      setCityStats(data.city_stats || null);
      // Pick the initial index in this priority order:
      //   1. Saved per-city position (where the viewer left off last time)
      //   2. First unswiped video (so you don't auto-rewatch by default)
      //   3. 0 (fallback)
      const total = (data.feed || []).length;
      let startIdx = 0;
      if (typeof data.saved_position === "number" && data.saved_position < total) {
        startIdx = data.saved_position;
      } else {
        const firstUnswiped = (data.feed || []).findIndex((it) => !it.prior_action);
        startIdx = firstUnswiped >= 0 ? firstUnswiped : 0;
      }
      // Defer until after render so item refs exist.
      setTimeout(() => scrollToIdx(startIdx, "auto"), 30);
    } catch {
      toast.error("Couldn't load feed");
    } finally {
      setLoading(false);
    }
  }, [scrollToIdx]);

  useEffect(() => { load(); }, [load]);

  // Persist the active index every time it changes (debounced via the swipe
  // / scroll handlers — this effect just fires once per landed index). Server
  // is idempotent so duplicate writes are fine.
  useEffect(() => {
    if (!cityKey || loading || !feed.length) return;
    const id = setTimeout(() => {
      api.post("/users/me/city-position", { city: cityKey, index: activeIdx }).catch(() => {});
    }, 600);
    return () => clearTimeout(id);
  }, [activeIdx, cityKey, loading, feed.length]);

  const handleLocationChanged = (updatedUser) => {
    setLocationOpen(false);
    if (updatedUser) setUser?.(updatedUser);
    load();
  };

  // intersection observer to detect which video is in view
  useEffect(() => {
    if (!scrollRef.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        // Ignore observer updates during a programmatic scroll so we don't
        // snap activeIdx around mid-animation.
        if (Date.now() < programmaticScrollUntil.current) return;
        entries.forEach((entry) => {
          const idx = Number(entry.target.dataset.idx);
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            setActiveIdx((prev) => {
              if (prev !== idx) setPaused(false);  // swipe→reset to playing
              return idx;
            });
          }
        });
      },
      { root: scrollRef.current, threshold: [0.6] }
    );
    itemRefs.current.forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, [feed]);

  const handleSwipe = async (idx, action) => {
    const item = feed[idx];
    if (!item) return;
    // Optimistic: mark the swipe action locally so the next render shows the
    // updated prior_action immediately (avoids a flash of "unliked" on Back).
    setFeed((f) => f.map((it, i) => (i === idx ? { ...it, prior_action: action } : it)));
    try {
      const { data } = await api.post("/swipe", { target_user_id: item.id, action });
      track(`swipe_${action}`, { target_lang: item.source_lang });
      if (data.match && !data.already_matched) {
        track("match_made");
        onMatch(data);
      } else if (action === "like" && !data.match) {
        toast("👋 Liked.", { duration: 1200 });
      }
    } catch {
      toast.error("Swipe failed");
      // Roll back the optimistic update.
      setFeed((f) => f.map((it, i) => (i === idx ? { ...it, prior_action: item.prior_action } : it)));
      return;
    }
    // Auto-advance to the next video, but only if we're currently AT this idx
    // — we don't want to scroll the user away if they're already deeper in
    // the feed (e.g. they hit Like on a previously-watched video via Back).
    if (activeIdx === idx && idx < feed.length - 1) {
      setTimeout(() => scrollToIdx(idx + 1), 200);
    }
  };

  const goBack = () => {
    if (activeIdx > 0) scrollToIdx(activeIdx - 1);
  };
  const restart = () => {
    if (feed.length === 0) return;
    setConfirmRestart(true);
  };
  const doRestart = () => {
    setConfirmRestart(false);
    scrollToIdx(0);
  };

  return (
    <motion.div
      className="absolute inset-0 bg-black"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="feed-screen"
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="font-display text-2xl text-white/70 splash-pulse">looking around…</div>
        </div>
      )}

      {!loading && feed.length === 0 && (
        <>
          {/* Persistent city pill in the empty state so the user always sees the
              control they need to discover content. */}
          {user.city && (
            <div className="absolute top-5 right-5 z-10 flex flex-col items-end gap-1">
              <button
                onClick={() => setLocationOpen(true)}
                className="flex items-center gap-1.5 glass-dark px-3 py-1.5 rounded-full text-xs font-bold transition hover:bg-white/15 active:scale-95"
                data-testid="feed-distance-badge"
                aria-label="Change feed location"
              >
                <MapPin size={12} className="text-[#FF4D4D]" />
                <span className="uppercase tracking-widest text-[10px] max-w-[140px] truncate">
                  {user.city.split(",")[0]}
                </span>
              </button>
              <div className="text-[10px] uppercase tracking-widest font-bold text-white/70 flex items-center gap-1 pr-1">
                <span>to change location</span>
                <span aria-hidden>☝️</span>
              </div>
            </div>
          )}

          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center gap-4">
            {user.city ? (
              cityStats && cityStats.total > 0 ? (
                // Exhausted state — viewer has swiped on everyone in this city.
                <>
                  <div className="text-6xl" aria-hidden>🏁</div>
                  <div className="font-display text-2xl font-black leading-tight">
                    That's everyone<br />
                    in {user.city.split(",")[0]}!
                  </div>
                  <p className="text-sm text-white/65 max-w-[290px] leading-snug">
                    You've seen all {cityStats.total} {cityStats.total === 1 ? "person" : "people"} here for now.
                    New intros will appear as people join. Try another city while you wait.
                  </p>
                  <button
                    className="btn-primary mt-2 flex items-center gap-2"
                    onClick={() => setLocationOpen(true)}
                    data-testid="feed-change-location"
                  >
                    <MapPin size={16} /> Explore another city
                  </button>
                  <button className="text-xs text-white/45 underline" onClick={load} data-testid="feed-refresh">
                    Check again
                  </button>
                </>
              ) : (
                // Truly first-in-city — no one else here yet.
                <>
                  <div className="text-6xl" aria-hidden>🎉</div>
                  <div className="font-display text-2xl font-black leading-tight">
                    You're the first<br />
                    in {user.city.split(",")[0]}!
                  </div>
                  <p className="text-sm text-white/65 max-w-[290px] leading-snug">
                    Congrats — your intro will be the very first face people see when they explore this city.
                    Share Nice2Meechu with friends nearby, or hop to a busier city while you wait.
                  </p>
                  <button
                    className="btn-primary mt-2 flex items-center gap-2"
                    onClick={() => setLocationOpen(true)}
                    data-testid="feed-change-location"
                  >
                    <MapPin size={16} /> Explore another city
                  </button>
                  <button
                    className="btn-ghost flex items-center gap-2 mt-1"
                    onClick={async () => {
                      const cityShort = (user.city || "").split(",")[0];
                      const shareUrl = `${window.location.origin}/?ref=${encodeURIComponent(user.handle || "")}`;
                      const shareText = `I'm the very first person on Nice2Meechu in ${cityShort}! Come meet people near you 👀 ${shareUrl}`;
                      track("first_in_city_share_clicked", { city: cityShort });
                      const result = await shareOrCopy({
                        title: "Nice2Meechu",
                        text: `I'm the first on Nice2Meechu in ${cityShort}! Join me 👀`,
                        url: shareUrl,
                        copyText: shareText,
                      });
                      if (result === "copied") toast.success("Invite link copied — paste it anywhere!");
                      else if (result === "failed") toast.error("Couldn't share. Link: " + shareUrl);
                    }}
                    data-testid="feed-first-share"
                  >
                    <Share2 size={16} /> Share this app
                  </button>
                  <button className="text-xs text-white/45 underline" onClick={load} data-testid="feed-refresh">
                    Check again
                  </button>
                </>
              )
            ) : (
              <>
                <div className="text-5xl" aria-hidden>📍</div>
                <div className="font-display text-2xl font-black leading-tight">Pick a city to begin</div>
                <p className="text-sm text-white/60 max-w-[280px] leading-snug">
                  Tell us where to look and we'll show you the people nearby.
                </p>
                <button
                  className="btn-primary mt-2 flex items-center gap-2"
                  onClick={() => setLocationOpen(true)}
                  data-testid="feed-change-location"
                >
                  <MapPin size={16} /> Set my city
                </button>
              </>
            )}
          </div>
        </>
      )}

      <div ref={scrollRef} className="n2m-feed" data-testid="feed-scroll">
        {feed.map((item, i) => (
          <div
            key={item.id}
            ref={(el) => (itemRefs.current[i] = el)}
            data-idx={i}
            className="n2m-feed-item"
            data-testid={`feed-card-${i}`}
          >
            <FeedCard
              item={item}
              isActive={activeIdx === i}
              myLang={user.language || "en"}
              currentCity={user.city}
              onOpenLocation={() => setLocationOpen(true)}
              onLike={() => handleSwipe(i, "like")}
              onPass={() => handleSwipe(i, "pass")}
              muted={muted}
              setMuted={setMutedPersist}
              positionLabel={`${i + 1}/${feed.length}`}
              isLastInCity={i === feed.length - 1}
              onRestart={restart}
              paused={paused}
            />
          </div>
        ))}
      </div>

      {/* Left-edge playback controls (Back + Restart) — vertical stack mirroring
          the right-edge action stack. Lives at mid-height so it never collides
          with the bottom-nav, Emergent's preview footer, or the captions card. */}
      {!loading && feed.length > 0 && (
        <div
          className="absolute left-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-3 pointer-events-none"
          data-testid="feed-playback-controls"
        >
          <button
            onClick={goBack}
            disabled={activeIdx === 0}
            className="pointer-events-auto w-12 h-12 rounded-full flex items-center justify-center bg-black/55 backdrop-blur-md text-white/85 hover:text-white disabled:opacity-30 active:scale-95 transition"
            aria-label="Previous video"
            data-testid="feed-back-button"
          >
            <ArrowLeft size={20} />
          </button>
          <button
            onClick={restart}
            disabled={activeIdx === 0}
            className="pointer-events-auto w-12 h-12 rounded-full flex items-center justify-center bg-black/55 backdrop-blur-md text-white/85 hover:text-white disabled:opacity-30 active:scale-95 transition"
            aria-label="Restart from first video"
            data-testid="feed-restart-button"
          >
            <RotateCcw size={18} />
          </button>
          <button
            onClick={() => setPaused((p) => !p)}
            className="pointer-events-auto w-12 h-12 rounded-full flex items-center justify-center bg-black/55 backdrop-blur-md text-white/85 hover:text-white active:scale-95 transition"
            aria-label={paused ? "Resume video" : "Pause video"}
            data-testid="feed-pause-button"
          >
            {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
          </button>
        </div>
      )}

      {confirmRestart && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm px-6"
          data-testid="feed-restart-confirm"
        >
          <div className="bg-[#0c0c10] border border-white/10 rounded-3xl p-6 max-w-[320px] w-full flex flex-col gap-3 shadow-2xl">
            <div className="font-display text-xl font-black">Restart {user.city?.split(",")[0]}?</div>
            <p className="text-sm text-white/65 leading-snug">
              Watch the city from the beginning again? This won't reset your likes or passes.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setConfirmRestart(false)}
                className="flex-1 btn-ghost"
                data-testid="feed-restart-cancel"
              >
                Cancel
              </button>
              <button
                onClick={doRestart}
                className="flex-1 btn-primary"
                data-testid="feed-restart-confirm-btn"
              >
                Restart
              </button>
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {locationOpen && (
          <ChangeLocationScreen
            key="change-location"
            user={user}
            onClose={() => setLocationOpen(false)}
            onChanged={handleLocationChanged}
          />
        )}
      </AnimatePresence>

      <BottomNav active="feed" onTab={onTab} userPicture={user?.picture} unreadCount={unreadMatches} />
    </motion.div>
  );
}
