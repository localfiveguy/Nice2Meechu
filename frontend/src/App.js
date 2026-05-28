import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { Toaster, toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart, X, MapPin, Languages, ArrowRight, ArrowLeft, Sparkles,
  Send, MessageCircle, User as UserIcon, Video as VideoIcon, Camera,
  Globe, Check, LogOut, Pause,
} from "lucide-react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// withCredentials so the session cookie is sent on every request; Bearer header is also sent
// as a fallback (useful for automated testing playbook)
const api = axios.create({ baseURL: API, withCredentials: true });
api.interceptors.request.use((config) => {
  const t = localStorage.getItem("n2m_token");
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

const LANG_OPTIONS = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "hi", name: "Hindi" },
  { code: "ar", name: "Arabic" },
  { code: "ru", name: "Russian" },
];
const VIBES_POOL = ["Coffee", "Vinyl", "Skater", "Foodie", "Bookworm", "Gamer", "Hiker", "Artist", "Runner", "Night Owl"];
const EMOJIS = ["🌙", "✨", "🔥", "🌊", "🌸", "🪐", "🌈", "💫", "🍓", "🌶️"];

const VideoEl = React.forwardRef(function VideoEl({ src, className, ...rest }, ref) {
  const webm = src && src.endsWith(".mp4") ? src.replace(".mp4", ".webm") : null;
  return (
    <video ref={ref} className={className} {...rest} key={src}>
      {webm && <source src={webm} type="video/webm" />}
      <source src={src} type={src?.endsWith(".webm") ? "video/webm" : "video/mp4"} />
    </video>
  );
});

// ---------- helpers ----------
const translationCache = new Map();
async function translate(text, target_lang, source_lang) {
  if (!text) return "";
  if (target_lang === source_lang) return text;
  const key = `${source_lang || ""}|${target_lang}|${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  try {
    const { data } = await api.post("/translate", { text, target_lang, source_lang });
    translationCache.set(key, data.translation);
    return data.translation;
  } catch {
    return text;
  }
}

// ---------- Top-level App ----------
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
export default function App() {
  // Detect Google OAuth session_id in URL fragment SYNCHRONOUSLY (before any render decisions)
  // to avoid races between AuthCallback and the splash/signin screens.
  const initialHasSessionId =
    typeof window !== "undefined" && window.location.hash?.includes("session_id=");

  const [screen, setScreen] = useState(initialHasSessionId ? "auth-callback" : "splash");
  const [user, setUser] = useState(null);
  const [matchState, setMatchState] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const callbackProcessed = useRef(false);

  // Decide where to send the user based on their profile completeness
  const routeToNext = useCallback((u) => {
    if (!u) return setScreen("signin");
    if (!u.handle) setScreen("onboarding");
    else if (!u.video_url) setScreen("video-pick");
    else setScreen("feed");
  }, []);

  // Handle the OAuth callback (one-time: exchange session_id → session_token cookie)
  useEffect(() => {
    if (!initialHasSessionId) return;
    if (callbackProcessed.current) return;
    callbackProcessed.current = true;

    const hash = window.location.hash || "";
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const sessionId = params.get("session_id");
    // Clean the URL immediately so the token is never visible to user / history
    window.history.replaceState(null, "", window.location.pathname);

    if (!sessionId) {
      setScreen("signin");
      return;
    }
    (async () => {
      try {
        const { data } = await api.post("/auth/session", { session_id: sessionId });
        if (data.token) localStorage.setItem("n2m_token", data.token); // fallback for non-cookie envs
        setUser(data.user);
        routeToNext(data.user);
      } catch (err) {
        console.error("session exchange failed", err);
        toast.error("Sign-in failed. Try again.");
        setScreen("signin");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Standard mount-time hydration when NOT coming back from OAuth callback
  useEffect(() => {
    if (initialHasSessionId) return; // AuthCallback flow handles auth instead
    (async () => {
      try {
        const { data } = await api.get("/auth/me");
        setUser(data.user);
        routeToNext(data.user);
      } catch (err) {
        // not authenticated yet → show splash briefly, then sign-in
        setTimeout(() => setScreen("signin"), 1500);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // capture geolocation once logged in
  useEffect(() => {
    if (!user) return;
    if (user.lat && user.lng) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        try {
          await api.post("/users/location", { lat, lng });
          setUser((u) => ({ ...u, lat, lng }));
        } catch (err) {
          console.error("location update failed", err);
        }
      },
      () => {},
      { enableHighAccuracy: false, timeout: 6000 }
    );
  }, [user]);

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch (e) { console.error(e); }
    localStorage.removeItem("n2m_token");
    setUser(null);
    setScreen("signin");
  };

  return (
    <div className="n2m-stage">
      <Toaster position="top-center" theme="dark" richColors />
      <div className="n2m-phone" data-testid="app-shell">
        <AnimatePresence mode="wait">
          {screen === "splash" && <Splash key="splash" />}
          {screen === "auth-callback" && <AuthCallback key="auth-callback" />}
          {screen === "signin" && <SignInScreen key="signin" />}
          {screen === "onboarding" && user && (
            <Onboarding key="onb" user={user} onDone={(u) => { setUser(u); setScreen("video-pick"); }} />
          )}
          {screen === "video-pick" && user && (
            <VideoPick key="vid" onDone={(u) => { setUser(u); setScreen("feed"); }} />
          )}
          {screen === "feed" && user && (
            <FeedScreen key="feed"
              user={user}
              onMatch={(m) => setMatchState(m)}
              onTab={(s) => setScreen(s)}
            />
          )}
          {screen === "matches" && user && (
            <MatchesScreen key="matches"
              onTab={(s) => setScreen(s)}
              onOpenChat={(m) => { setActiveChat(m); setScreen("chat"); }}
            />
          )}
          {screen === "chat" && user && activeChat && (
            <ChatScreen key="chat" me={user} match={activeChat} onBack={() => setScreen("matches")} />
          )}
          {screen === "profile" && user && (
            <ProfileScreen key="profile"
              user={user}
              setUser={setUser}
              onTab={(s) => setScreen(s)}
              onLogout={logout}
              onChangeVideo={() => setScreen("video-pick")}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {matchState && (
            <MatchCelebration
              key="match"
              data={matchState}
              onClose={() => setMatchState(null)}
              onChat={() => {
                const m = matchState;
                setMatchState(null);
                setActiveChat({ match_id: m.match_id, user: m.matched_user });
                setScreen("chat");
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- Splash ----------
function Splash() {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center bg-grain"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="splash-screen"
    >
      <div className="text-center px-6">
        <div className="splash-pulse">
          <div className="font-display text-5xl font-black tracking-tighter leading-[0.95]">
            Nice<span style={{ color: "#FF4D4D" }}>2</span>
            <br/>Meechu<span style={{ color: "#00E5FF" }}>.</span>
          </div>
        </div>
        <p className="mt-6 text-sm text-white/55 font-medium max-w-[260px] mx-auto leading-relaxed">
          Hyperlocal. Video-first. Anonymous until the spark.
        </p>
      </div>
    </motion.div>
  );
}

// ---------- Google Sign-In ----------
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
function SignInScreen() {
  const startGoogle = () => {
    const redirectUrl = window.location.origin + "/";
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-7 pt-16 pb-8 bg-grain"
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid="signin-screen"
    >
      <div className="font-display text-4xl font-black leading-[0.95] tracking-tighter">
        Nice<span style={{ color: "#FF4D4D" }}>2</span>
        <br />Meechu<span style={{ color: "#00E5FF" }}>.</span>
      </div>
      <p className="mt-4 text-sm text-white/55 font-medium leading-relaxed max-w-[280px]">
        Hyperlocal. Video-first. Anonymous until the spark.
      </p>

      <div className="mt-auto flex flex-col gap-3">
        <button
          className="w-full flex items-center justify-center gap-3 rounded-full px-6 py-4 font-bold text-base bg-white text-black hover:bg-white/90 active:scale-[0.98] transition"
          onClick={startGoogle}
          data-testid="signin-google-button"
        >
          <GoogleGlyph />
          <span>Continue with Google</span>
        </button>
        <p className="text-center text-[11px] text-white/40 font-medium uppercase tracking-widest">
          By continuing you agree to be Nice
        </p>
      </div>
    </motion.div>
  );
}

function GoogleGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303C33.973 32.91 29.413 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.193l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.392 0-9.94-3.066-11.283-7.357l-6.54 5.036C9.51 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.793 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}

// ---------- Auth Callback (processes #session_id from URL fragment) ----------
function AuthCallback() {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center bg-grain"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="auth-callback-screen"
    >
      <div className="text-center px-6">
        <div className="font-display text-3xl font-black tracking-tighter splash-pulse">
          signing you in<span style={{ color: "#FF4D4D" }}>…</span>
        </div>
        <p className="mt-3 text-sm text-white/50">one sec</p>
      </div>
    </motion.div>
  );
}

// ---------- Onboarding (3 mini-steps) ----------
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0);
  const [handle, setHandle] = useState(user.handle || "");
  const [vibes, setVibes] = useState(user.vibes || []);
  const [language, setLanguage] = useState(user.language || "en");
  const [emoji, setEmoji] = useState(user.avatar_emoji || "🌙");
  const [loading, setLoading] = useState(false);

  const total = 3;
  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const canNext =
    (step === 0 && handle.trim().length >= 2) ||
    (step === 1 && vibes.length >= 1) ||
    (step === 2 && !!language);

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        handle: handle.trim(), vibes, language, avatar_emoji: emoji,
      });
      toast.success(`Hey ${data.user.handle} ✨`);
      onDone(data.user);
    } catch (e) {
      toast.error("Couldn't save profile");
    } finally {
      setLoading(false);
    }
  };

  const toggleVibe = (v) => {
    setVibes((arr) => {
      if (arr.includes(v)) return arr.filter((x) => x !== v);
      if (arr.length >= 5) return arr;
      return [...arr, v];
    });
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-7 pt-10 pb-8 bg-grain"
      initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid="onboarding-screen"
    >
      {/* progress */}
      <div className="flex gap-1.5 mb-6">
        {Array.from({ length: total }).map((_, i) => (
          <div key={`progress-${i}`} className="flex-1 h-1 rounded-full bg-white/8" data-testid={`onboarding-progress-${i}`}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: i <= step ? "100%" : "0%", background: "linear-gradient(90deg,#FF4D4D,#00E5FF)" }}
            />
          </div>
        ))}
      </div>

      {step === 0 && (
        <>
          <h2 className="font-display text-3xl font-black leading-tight">Choose a<br/>codename<span style={{ color: "#FF4D4D" }}>.</span></h2>
          <p className="mt-3 text-sm text-white/55">Stays hidden until you match.</p>

          <div className="mt-8">
            <input
              className="n2m-input"
              placeholder="moon.crab, sunset.kid…"
              value={handle}
              maxLength={20}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))}
              data-testid="onboarding-handle-input"
            />
          </div>

          <div className="mt-8">
            <p className="text-xs uppercase tracking-widest font-bold text-white/45 mb-3">Pick your aura</p>
            <div className="flex flex-wrap gap-2">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={`w-12 h-12 rounded-2xl text-xl flex items-center justify-center ${emoji === e ? "ring-2 ring-[#FF4D4D] bg-white/10" : "bg-white/5"}`}
                  data-testid={`onboarding-emoji-${e}`}
                >{e}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <h2 className="font-display text-3xl font-black leading-tight">Tag your<br/>vibes<span style={{ color: "#00E5FF" }}>.</span></h2>
          <p className="mt-3 text-sm text-white/55">Pick 1-5. Helps us find your people.</p>
          <div className="mt-8 flex flex-wrap gap-2">
            {VIBES_POOL.map((v) => (
              <button
                key={v}
                className="vibe-pill"
                data-active={vibes.includes(v)}
                onClick={() => toggleVibe(v)}
                data-testid={`onboarding-vibe-${v}`}
              >{v}</button>
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2 className="font-display text-3xl font-black leading-tight">Your native<br/>language<span style={{ color: "#FF4D4D" }}>.</span></h2>
          <p className="mt-3 text-sm text-white/55">We'll auto-translate intros into this for you.</p>
          <div className="mt-8 grid grid-cols-2 gap-2 max-h-[55vh] overflow-y-auto no-scrollbar">
            {LANG_OPTIONS.map((l) => (
              <button
                key={l.code}
                className={`px-4 py-4 rounded-2xl text-left ${language === l.code ? "bg-white/15 border border-[#FF4D4D]" : "bg-white/5 border border-white/8"}`}
                onClick={() => setLanguage(l.code)}
                data-testid={`onboarding-lang-${l.code}`}
              >
                <span className="text-xs uppercase tracking-widest text-white/40 block">{l.code}</span>
                <span className="font-semibold">{l.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-auto flex gap-3 pt-6">
        {step > 0 && (
          <button className="btn-ghost" onClick={back} data-testid="onboarding-back">
            <ArrowLeft size={18} />
          </button>
        )}
        {step < total - 1 ? (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext}
            onClick={next}
            data-testid="onboarding-next"
          >
            Next <ArrowRight size={18} />
          </button>
        ) : (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext || loading}
            onClick={submit}
            data-testid="onboarding-finish"
          >
            {loading ? "Saving…" : (<>Let's go <Sparkles size={18} /></>)}
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ---------- Video Pick / Record ----------
function VideoPick({ onDone }) {
  const [samples, setSamples] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState("pick"); // pick | record
  const [loading, setLoading] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const recorderRef = useRef(null);

  useEffect(() => {
    api.get("/samples").then(({ data }) => setSamples(data.samples)).catch((e) => console.error(e));
  }, []);

  const save = async () => {
    setLoading(true);
    try {
      if (mode === "record" && recordedBlob) {
        const blobUrl = URL.createObjectURL(recordedBlob);
        const { data } = await api.post("/users/video", {
          video_url: blobUrl,
          transcript: "Hey there! I just recorded my intro on Nice2Meechu.",
          source_lang: "en",
        });
        const me = await api.get("/users/me");
        onDone(me.data.user);
      } else {
        await api.post("/users/video", { sample_index: selectedIdx });
        const me = await api.get("/users/me");
        onDone(me.data.user);
      }
    } catch {
      toast.error("Couldn't save your intro");
    } finally {
      setLoading(false);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch {
      toast.error("Camera permission denied. Use a sample instead.");
      setMode("pick");
    }
  };

  useEffect(() => {
    if (mode === "record") startCamera();
    return () => {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  const toggleRecord = () => {
    if (!streamRef.current) return;
    if (!recording) {
      const chunks = [];
      const r = new MediaRecorder(streamRef.current, { mimeType: "video/webm" });
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        setRecordedBlob(blob);
      };
      r.start();
      recorderRef.current = r;
      setRecording(true);
      setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
          setRecording(false);
        }
      }, 10000);
    } else {
      recorderRef.current?.stop();
      setRecording(false);
    }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-6 pt-10 pb-6 bg-grain"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="video-pick-screen"
    >
      <h2 className="font-display text-3xl font-black leading-tight">Your<br/>video intro<span style={{ color: "#FF4D4D" }}>.</span></h2>
      <p className="mt-3 text-sm text-white/55">10-second clip. Make it weird, make it warm.</p>

      <div className="mt-5 flex gap-2">
        <button
          className={`flex-1 px-4 py-2 rounded-full text-sm font-bold ${mode === "pick" ? "bg-white text-black" : "bg-white/5 text-white/80"}`}
          onClick={() => setMode("pick")}
          data-testid="video-mode-pick"
        >Pick a sample</button>
        <button
          className={`flex-1 px-4 py-2 rounded-full text-sm font-bold ${mode === "record" ? "bg-white text-black" : "bg-white/5 text-white/80"}`}
          onClick={() => setMode("record")}
          data-testid="video-mode-record"
        >Record now</button>
      </div>

      {mode === "pick" ? (
        <div className="mt-5 grid grid-cols-2 gap-3 flex-1 overflow-y-auto no-scrollbar pb-4" data-testid="sample-grid">
          {samples.map((s, i) => (
            <button
              key={s.url}
              onClick={() => setSelectedIdx(i)}
              className={`relative aspect-[3/4] rounded-2xl overflow-hidden border-2 ${selectedIdx === i ? "border-[#FF4D4D]" : "border-white/8"}`}
              data-testid={`sample-card-${i}`}
            >
              <VideoEl
                src={s.url}
                muted
                loop
                playsInline
                autoPlay
                preload="metadata"
                className="w-full h-full object-cover bg-black"
              />
              <div className="absolute inset-x-0 bottom-0 p-2 text-[10px] font-bold uppercase tracking-widest text-white bg-gradient-to-t from-black/70 to-transparent">
                {s.lang}
              </div>
              {selectedIdx === i && (
                <div className="absolute top-2 right-2 w-7 h-7 rounded-full bg-[#FF4D4D] flex items-center justify-center">
                  <Check size={14} />
                </div>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-5 relative aspect-[3/4] rounded-3xl overflow-hidden bg-black flex-1">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
          <div className="absolute bottom-5 left-0 right-0 flex justify-center">
            <button
              className={`btn-icon ${recording ? "record-ring" : ""}`}
              onClick={toggleRecord}
              data-testid="record-toggle-button"
              style={{ background: recording ? "#FF4D4D" : "rgba(255,255,255,0.15)" }}
            >
              {recording ? <Pause size={22} /> : <Camera size={22} />}
            </button>
          </div>
          {recordedBlob && (
            <div className="absolute top-3 left-3 text-xs glass-dark px-2 py-1 rounded-full font-bold">
              Recorded ✓
            </div>
          )}
        </div>
      )}

      <button
        className="btn-primary mt-4 flex items-center justify-center gap-2"
        onClick={save}
        disabled={loading || (mode === "record" && !recordedBlob)}
        data-testid="video-save-button"
      >
        {loading ? "Saving…" : (<>Use this intro <ArrowRight size={18} /></>)}
      </button>
    </motion.div>
  );
}

// ---------- Feed ----------
function FeedScreen({ user, onMatch, onTab }) {
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const scrollRef = useRef(null);
  const itemRefs = useRef([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/feed");
      setFeed(data.feed);
    } catch (e) {
      toast.error("Couldn't load feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // intersection observer to detect which video is in view
  useEffect(() => {
    if (!scrollRef.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = Number(entry.target.dataset.idx);
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            setActiveIdx(idx);
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
    try {
      const { data } = await api.post("/swipe", { target_user_id: item.id, action });
      // remove from feed
      setFeed((f) => f.filter((x) => x.id !== item.id));
      if (data.match) {
        onMatch(data);
      } else if (action === "like") {
        toast("👋 Liked.", { duration: 1200 });
      }
    } catch {
      toast.error("Swipe failed");
    }
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
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center gap-3">
          <Sparkles size={32} className="text-[#00E5FF]" />
          <div className="font-display text-2xl font-black">All caught up</div>
          <p className="text-sm text-white/55">You've seen everyone nearby. Come back later — new faces drop in all the time.</p>
          <button className="btn-ghost mt-4" onClick={load} data-testid="feed-refresh">Refresh</button>
        </div>
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
              onLike={() => handleSwipe(i, "like")}
              onPass={() => handleSwipe(i, "pass")}
            />
          </div>
        ))}
      </div>

      <BottomNav active="feed" onTab={onTab} />
    </motion.div>
  );
}

function FeedCard({ item, isActive, myLang, onLike, onPass }) {
  const vidRef = useRef(null);
  const [translated, setTranslated] = useState("");
  const [showCaption, setShowCaption] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    if (!vidRef.current) return;
    if (isActive) {
      vidRef.current.currentTime = 0;
      vidRef.current.muted = muted;
      vidRef.current.play().catch(() => {});
      // start translation
      setShowCaption(false);
      setTranslated("");
      const t = setTimeout(async () => {
        const out = await translate(item.transcript, myLang, item.source_lang);
        setTranslated(out);
        setShowCaption(true);
      }, 600);
      return () => clearTimeout(t);
    } else {
      vidRef.current.pause();
    }
  }, [isActive, item.transcript, item.source_lang, myLang, muted]);

  return (
    <div className="absolute inset-0">
      <video
        ref={vidRef}
        loop
        playsInline
        muted
        preload="metadata"
        className="w-full h-full object-cover bg-black"
        onClick={() => setMuted((m) => !m)}
        data-testid="feed-card-video"
        key={item.video_url}
      >
        {item.video_url && item.video_url.endsWith(".mp4") && (
          <source src={item.video_url.replace(".mp4", ".webm")} type="video/webm" />
        )}
        <source src={item.video_url} type={item.video_url?.endsWith(".webm") ? "video/webm" : "video/mp4"} />
      </video>
      {/* gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-transparent pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent pointer-events-none" />

      {/* anonymity codename */}
      <div className="absolute top-5 left-5 flex items-center gap-2 glass-dark px-3 py-1.5 rounded-full" data-testid="feed-codename-badge">
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-white/10 text-lg">
          <span className={revealed ? "identity-clear" : "identity-blur"}>{item.avatar_emoji || "🌙"}</span>
        </div>
        <span className="font-display font-bold text-sm tracking-tight">{item.codename}</span>
      </div>

      {/* distance badge */}
      <div className="absolute top-5 right-5 flex items-center gap-1.5 glass-dark px-3 py-1.5 rounded-full text-xs font-bold" data-testid="feed-distance-badge">
        <MapPin size={12} className="text-[#FF4D4D]" />
        {item.distance_km < 100 ? `${item.distance_km} km` : "near you"}
      </div>

      {/* vibes */}
      <div className="absolute top-20 left-5 right-24 flex flex-wrap gap-1.5">
        {(item.vibes || []).slice(0, 4).map((v) => (
          <span key={v} className="text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded-full glass-dark text-white/80">{v}</span>
        ))}
      </div>

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
        <button className="btn-icon" style={{ background: "rgba(255,255,255,0.12)" }} onClick={onPass} data-testid="feed-pass-button">
          <X size={22} />
        </button>
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

// ---------- Match celebration ----------
function MatchCelebration({ data, onClose, onChat }) {
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

// ---------- Matches list ----------
function MatchesScreen({ onTab, onOpenChat }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api.get("/matches").then(({ data }) => setMatches(data.matches)).catch((e) => console.error(e)).finally(() => setLoading(false));
  }, []);

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
          <button
            key={m.match_id}
            onClick={() => onOpenChat(m)}
            className="glass-dark p-3 rounded-3xl flex items-center gap-3 text-left"
            data-testid={`match-row-${m.match_id}`}
          >
            <div className="w-14 h-14 rounded-2xl overflow-hidden bg-black">
              <VideoEl src={m.user.video_url} autoPlay loop muted playsInline className="w-full h-full object-cover" />
            </div>
            <div className="flex-1">
              <div className="font-display font-bold">@{m.user.handle || m.user.codename}</div>
              <div className="text-xs text-white/50">Tap to chat</div>
            </div>
            <ArrowRight size={18} className="text-white/40" />
          </button>
        ))}
      </div>

      <BottomNav active="matches" onTab={onTab} />
    </motion.div>
  );
}

// ---------- Chat ----------
function ChatScreen({ me, match, onBack }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const load = async () => {
    try {
      const { data } = await api.get(`/messages/${match.match_id}`);
      setMessages(data.messages);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 99999, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.post("/messages", { match_id: match.match_id, text: text.trim() });
      setText("");
      await load();
    } catch {
      toast.error("Send failed");
    } finally { setSending(false); }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-grain"
      initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
      data-testid="chat-screen"
    >
      {/* header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4 border-b border-white/8">
        <button onClick={onBack} className="text-white/70" data-testid="chat-back">
          <ArrowLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-full overflow-hidden bg-black ring-1 ring-white/10">
          <VideoEl src={match.user.video_url} autoPlay loop muted playsInline className="w-full h-full object-cover" />
        </div>
        <div>
          <div className="font-display font-bold leading-none">@{match.user.handle || match.user.codename}</div>
          <div className="text-[10px] text-white/45 mt-1 uppercase tracking-widest font-bold">Matched · live</div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2 no-scrollbar">
        {loading && <div className="text-center text-xs text-white/40">…</div>}
        {messages.length === 0 && !loading && (
          <div className="text-center text-xs text-white/40 mt-10">Say hi! Translation is automatic.</div>
        )}
        {messages.map((m) => {
          const mine = m.from_user_id === me.id;
          return (
            <div
              key={m.id}
              className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-[15px] font-medium leading-snug ${mine ? "self-end bg-[#FF4D4D] text-white rounded-br-md" : "self-start bg-white/10 text-white rounded-bl-md"}`}
              data-testid={`chat-msg-${m.id}`}
            >{m.text}</div>
          );
        })}
      </div>

      <div className="p-3 pb-14 border-t border-white/8 flex gap-2 relative z-40 bg-background">
        <input
          className="n2m-input flex-1"
          placeholder="say something nice…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          data-testid="chat-input"
        />
        <button
          className="btn-icon"
          style={{ width: 52, height: 52, background: "linear-gradient(180deg,#FF6B6B,#FF3D3D)" }}
          onClick={send}
          disabled={sending}
          data-testid="chat-send-button"
        >
          <Send size={18} fill="white" />
        </button>
      </div>
    </motion.div>
  );
}

// ---------- Profile ----------
function ProfileScreen({ user, setUser, onTab, onLogout, onChangeVideo }) {
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState(user.handle);
  const [vibes, setVibes] = useState(user.vibes);
  const [language, setLanguage] = useState(user.language);
  const [emoji, setEmoji] = useState(user.avatar_emoji);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        handle: handle.trim(), vibes, language, avatar_emoji: emoji,
      });
      setUser(data.user);
      setEditing(false);
      toast.success("Saved");
    } catch {
      toast.error("Couldn't save");
    } finally { setSaving(false); }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-black overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="profile-screen"
    >
      {user.video_url ? (
        <VideoEl src={user.video_url} autoPlay loop muted playsInline className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a0a0a] to-[#0a0a1a]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/90 pointer-events-none" />

      <div className="relative z-10 flex-1 flex flex-col px-6 pt-12 pb-36 overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-3xl font-black">You.</h2>
          <button className="text-white/60 text-sm font-bold uppercase tracking-widest" onClick={() => setEditing((v) => !v)} data-testid="profile-edit-toggle">
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        <div className="mt-auto glass-dark rounded-3xl p-5 mt-8">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/8 text-2xl">{user.avatar_emoji}</div>
            <div>
              <div className="text-xs uppercase tracking-widest font-bold text-white/50">codename · {user.codename}</div>
              <div className="font-display text-xl font-black">@{user.handle}</div>
            </div>
          </div>

          {!editing ? (
            <>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {(user.vibes || []).map((v) => (
                  <span key={v} className="text-[10px] uppercase tracking-widest font-bold px-2.5 py-1 rounded-full bg-white/10">{v}</span>
                ))}
              </div>
              <div className="mt-3 text-xs text-white/60 flex items-center gap-1.5">
                <Globe size={12} /> Native: {LANG_OPTIONS.find((l) => l.code === user.language)?.name || user.language}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button className="btn-ghost text-sm" onClick={onChangeVideo} data-testid="profile-change-video">
                  <VideoIcon size={14} className="inline mr-1" /> Change intro
                </button>
                <button className="btn-ghost text-sm" onClick={onLogout} data-testid="profile-logout">
                  <LogOut size={14} className="inline mr-1" /> Log out
                </button>
              </div>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <input className="n2m-input" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))} data-testid="profile-handle-input" />
              <div className="flex flex-wrap gap-1.5">
                {VIBES_POOL.map((v) => (
                  <button
                    key={v}
                    className="vibe-pill text-xs px-3 py-1.5"
                    data-active={vibes.includes(v)}
                    onClick={() => setVibes((arr) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])}
                    data-testid={`profile-vibe-${v}`}
                  >{v}</button>
                ))}
              </div>
              <select
                className="n2m-input"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                data-testid="profile-lang-select"
              >
                {LANG_OPTIONS.map((l) => <option key={l.code} value={l.code} className="bg-black">{l.name}</option>)}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setEmoji(e)}
                    className={`w-10 h-10 rounded-xl text-lg ${emoji === e ? "ring-2 ring-[#FF4D4D] bg-white/10" : "bg-white/5"}`}
                    data-testid={`profile-emoji-${e}`}
                  >{e}</button>
                ))}
              </div>
              <button className="btn-primary" onClick={save} disabled={saving} data-testid="profile-save">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>

      <BottomNav active="profile" onTab={onTab} />
    </motion.div>
  );
}

// ---------- Bottom Nav ----------
function BottomNav({ active, onTab }) {
  const Item = ({ id, icon: Icon, label }) => (
    <button
      onClick={() => onTab(id)}
      className="flex flex-col items-center gap-1 flex-1 py-2"
      data-testid={`nav-${id}`}
    >
      <Icon size={22} color={active === id ? "#FF4D4D" : "rgba(255,255,255,0.6)"} fill={active === id && id === "feed" ? "#FF4D4D" : "transparent"} />
      <span className={`text-[10px] uppercase tracking-widest font-bold ${active === id ? "text-white" : "text-white/45"}`}>{label}</span>
    </button>
  );
  return (
    <div className="absolute bottom-0 left-0 right-0 z-40 glass-dark border-t border-white/8 flex pb-10 pt-1 px-4" data-testid="bottom-nav">
      <Item id="feed" icon={VideoIcon} label="Feed" />
      <Item id="matches" icon={Heart} label="Matches" />
      <Item id="profile" icon={UserIcon} label="You" />
    </div>
  );
}
