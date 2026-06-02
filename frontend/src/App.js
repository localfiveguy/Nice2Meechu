import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { Toaster, toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart, X, MapPin, Languages, ArrowRight, ArrowLeft, Sparkles,
  Send, MessageCircle, User as UserIcon, Video as VideoIcon, Camera,
  Globe, Check, LogOut, Pause, Share2, Copy,
} from "lucide-react";
import "@/App.css";
import { initAnalytics, pageview, track } from "./analytics";

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
    if (!u.handle || !u.first_name || !u.city || !u.age) setScreen("onboarding");
    else if (!u.agreed_to_rules_at) setScreen("community-rules");
    else if (!u.video_url) setScreen("video-pick");
    else setScreen("feed");
  }, []);

  // Capture ?ref=<handle> from URL on first load (referral attribution) and persist it
  // so it survives the round-trip through Google OAuth.
  useEffect(() => {
    // Initialise GA4 (no-op if REACT_APP_GA4_MEASUREMENT_ID isn't set)
    initAnalytics();
    try {
      const search = new URLSearchParams(window.location.search);
      const ref = search.get("ref");
      if (ref) {
        // Validate: only allow handle-safe chars and cap length to prevent localStorage abuse
        const safe = ref.toLowerCase().trim().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
        if (safe) {
          localStorage.setItem("n2m_ref", safe);
          track("referral_landed", { ref: safe });
        }
        // strip ?ref from URL so it doesn't pollute later navigation
        const url = new URL(window.location.href);
        url.searchParams.delete("ref");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
    } catch (e) {
      console.error("ref capture failed", e);
    }
  }, []);

  // Fire a GA pageview whenever the screen state changes
  useEffect(() => {
    if (screen) pageview(screen);
  }, [screen]);

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
        const ref = localStorage.getItem("n2m_ref") || undefined;
        const { data } = await api.post("/auth/session", { session_id: sessionId, ref });
        if (data.token) localStorage.setItem("n2m_token", data.token); // fallback for non-cookie envs
        localStorage.removeItem("n2m_ref"); // ref consumed
        track("sign_in_completed", { onboarded: !!data.onboarded, referred: !!ref });
        setUser(data.user);
        routeToNext(data.user);
      } catch (err) {
        console.error("session exchange failed", err);
        track("sign_in_failed");
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
            <Onboarding key="onb" user={user} onDone={(u) => { setUser(u); setScreen("community-rules"); }} />
          )}
          {screen === "community-rules" && user && (
            <CommunityRulesScreen key="rules" onDone={(u) => { setUser(u); setScreen("video-pick"); }} />
          )}
          {screen === "video-pick" && user && (
            <VideoPick key="vid" user={user} onDone={(u) => { setUser(u); setScreen("feed"); }} />
          )}
          {screen === "feed" && user && (
            <FeedScreen key="feed"
              user={user}
              setUser={setUser}
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
    track("sign_in_started", { method: "google" });
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

// ---------- Onboarding (Name → City → Age) ----------
function Onboarding({ user, onDone }) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null); // {lat, lng} when picked from autocomplete
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [loading, setLoading] = useState(false);

  const total = 3;
  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const ageNum = parseInt(age, 10);
  const canNext =
    (step === 0 && firstName.trim().length >= 1) ||
    (step === 1 && city.trim().length >= 2) ||
    (step === 2 && !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120);

  // detect browser language for auto-translation
  const browserLang = (typeof navigator !== "undefined" && navigator.language?.slice(0, 2)) || "en";

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language: browserLang,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      track("onboarding_completed", { age: ageNum, language: browserLang, has_city_coords: !!cityCoords });
      toast.success(`Hey ${data.user.first_name} ✨`);
      onDone(data.user);
    } catch (e) {
      track("onboarding_failed");
      toast.error(e?.response?.data?.detail || "Couldn't save profile");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-7 pt-10 pb-8 bg-grain"
      initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid="onboarding-screen"
    >
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

      <div>
        <h2 className="font-display text-3xl font-black leading-tight">Create your<br/>profile<span style={{ color: "#FF4D4D" }}>.</span></h2>
        <p className="mt-3 text-sm text-white/55">Just the basics. Your name stays hidden until you match.</p>
      </div>

      {step === 0 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">First name</p>
          <input
            autoFocus
            className="n2m-input"
            placeholder="e.g. Steven"
            value={firstName}
            maxLength={40}
            onChange={(e) => setFirstName(e.target.value)}
            data-testid="onboarding-name-input"
          />
        </div>
      )}

      {step === 1 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">City</p>
          <CityAutocomplete
            value={city}
            onChange={(v) => { setCity(v); setCityCoords(null); }}
            onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
          />
        </div>
      )}

      {step === 2 && (
        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D] mb-2">Age</p>
          <input
            autoFocus
            className="n2m-input"
            inputMode="numeric"
            placeholder="18+"
            value={age}
            maxLength={3}
            onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))}
            data-testid="onboarding-age-input"
          />
          <p className="mt-3 text-xs text-white/40">You must be at least 13 to use Nice2Meechu.</p>
        </div>
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
            Continue <ArrowRight size={18} />
          </button>
        ) : (
          <button
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={!canNext || loading}
            onClick={submit}
            data-testid="onboarding-finish"
          >
            {loading ? "Saving…" : (<>Continue <ArrowRight size={18} /></>)}
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ---------- City Autocomplete (Photon / OpenStreetMap) ----------
function CityAutocomplete({ value, onChange, onPick }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  const onInput = (e) => {
    const v = e.target.value;
    onChange(v);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v || v.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=5&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:suburb&osm_tag=place:hamlet`;
        const r = await fetch(url);
        const data = await r.json();
        const items = (data?.features || []).map((f) => {
          const p = f.properties || {};
          const parts = [p.name, p.state, p.country].filter(Boolean);
          const coords = f.geometry?.coordinates || []; // [lng, lat]
          return {
            label: parts.join(", "),
            value: p.name,
            lat: coords[1] ?? null,
            lng: coords[0] ?? null,
          };
        });
        setSuggestions(items);
      } catch (err) {
        console.error("city autocomplete failed", err);
      }
    }, 280);
  };

  const pick = (item) => {
    onChange(item.value || item.label);
    if (onPick) onPick(item);
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div className="relative" data-testid="city-autocomplete">
      <input
        autoFocus
        className="n2m-input"
        placeholder="Start typing your city…"
        value={value}
        onChange={onInput}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        data-testid="onboarding-city-input"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-2 rounded-2xl border border-white/10 bg-[#0c0c10] overflow-hidden shadow-2xl">
          {suggestions.map((s, i) => (
            <button
              key={`${s.label}-${i}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="w-full text-left px-4 py-3 hover:bg-white/8 active:bg-white/10 border-b border-white/5 last:border-none"
              data-testid={`city-suggestion-${i}`}
            >
              <div className="font-semibold text-sm">{s.value}</div>
              <div className="text-xs text-white/45 truncate">{s.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Community Rules screen ----------
const COMMUNITY_RULES = [
  "I confirm I am 18 years of age or older.",
  "I will not impersonate another person on my video or profile.",
  "I will treat every user with respect — no harassment or hate.",
  "I will not share illegal, sexual, or violent content.",
  "I will not use this app for spam, scams, or commercial solicitation.",
  "I understand my video may be reviewed for safety verification.",
  "I accept Nice2Meechu's full Terms of Service & Privacy Policy.",
];

function CommunityRulesScreen({ onDone }) {
  const [checked, setChecked] = useState(() => COMMUNITY_RULES.map(() => false));
  const [loading, setLoading] = useState(false);
  const [hasSig, setHasSig] = useState(false);
  const sigRef = useRef(null);

  const allChecked = checked.every(Boolean);

  const toggle = (i) => setChecked((arr) => arr.map((v, j) => (j === i ? !v : v)));

  const submit = async () => {
    if (!allChecked) return toast.error("Please check every box");
    if (!hasSig) return toast.error("Please sign to continue");
    setLoading(true);
    try {
      const dataUrl = sigRef.current.toDataURL("image/png");
      const { data } = await api.post("/users/community-rules", {
        accepted_items: COMMUNITY_RULES,
        signature_data_url: dataUrl,
      });
      track("community_rules_accepted");
      onDone(data.user);
    } catch (e) {
      track("community_rules_failed");
      toast.error(e?.response?.data?.detail || "Couldn't accept rules");
    } finally { setLoading(false); }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-6 pt-10 pb-6 bg-grain overflow-y-auto no-scrollbar"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="community-rules-screen"
    >
      <h2 className="font-display text-3xl font-black leading-tight">Community<br/>rules<span style={{ color: "#FF4D4D" }}>.</span></h2>
      <p className="mt-3 text-sm text-white/55">Check every box and sign below to continue.</p>

      <div className="mt-6 glass-dark rounded-2xl divide-y divide-white/8" data-testid="rules-list">
        {COMMUNITY_RULES.map((rule, i) => (
          <button
            key={`rule-${i}`}
            onClick={() => toggle(i)}
            className="w-full flex gap-3 items-start text-left px-4 py-4"
            data-testid={`rule-checkbox-${i}`}
          >
            <span
              className={`mt-0.5 w-6 h-6 flex-none rounded-md border flex items-center justify-center transition-colors ${checked[i] ? "bg-[#FF4D4D] border-[#FF4D4D]" : "border-white/25"}`}
            >
              {checked[i] && <Check size={14} className="text-white" />}
            </span>
            <span className="text-sm text-white/90 leading-snug">{rule}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 glass-dark rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs uppercase tracking-widest font-bold text-[#FF4D4D]">Sign here</span>
          <button
            onClick={() => { sigRef.current?.clear(); setHasSig(false); }}
            className="text-xs font-bold uppercase tracking-widest text-white/55 underline"
            data-testid="signature-clear-button"
          >
            Clear
          </button>
        </div>
        <SignaturePad ref={sigRef} onChange={(v) => setHasSig(v)} />
        <p className="mt-2 text-[11px] text-white/35 italic text-center">Draw your signature above</p>
      </div>

      <button
        className="btn-primary mt-5 w-full flex items-center justify-center gap-2"
        disabled={!allChecked || !hasSig || loading}
        onClick={submit}
        data-testid="rules-accept-button"
      >
        {loading ? "Saving…" : "Accept & Continue"}
      </button>
    </motion.div>
  );
}

// ---------- Signature Pad ----------
const SignaturePad = React.forwardRef(function SignaturePad({ onChange }, ref) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);

  React.useImperativeHandle(ref, () => ({
    toDataURL: (type) => canvasRef.current?.toDataURL(type || "image/png"),
    clear: () => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      dirtyRef.current = false;
      onChange?.(false);
    },
  }));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Crisp on retina
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "#FF4D4D";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches?.[0];
      const x = (t ? t.clientX : e.clientX) - r.left;
      const y = (t ? t.clientY : e.clientY) - r.top;
      return { x, y };
    };
    const start = (e) => {
      e.preventDefault();
      drawingRef.current = true;
      const { x, y } = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (e) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const { x, y } = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      if (!dirtyRef.current) { dirtyRef.current = true; onChange?.(true); }
    };
    const end = () => { drawingRef.current = false; };

    c.addEventListener("mousedown", start);
    c.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    c.addEventListener("touchstart", start, { passive: false });
    c.addEventListener("touchmove", move, { passive: false });
    c.addEventListener("touchend", end);

    return () => {
      c.removeEventListener("mousedown", start);
      c.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      c.removeEventListener("touchstart", start);
      c.removeEventListener("touchmove", move);
      c.removeEventListener("touchend", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="signature-canvas"
      className="w-full h-32 rounded-xl border-2 border-dashed border-[#FF4D4D]/40 bg-white/5 touch-none"
    />
  );
});

// ---------- Video Pick / Record ----------
function VideoPick({ user, onDone }) {
  const [samples, setSamples] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState("record"); // record-first; sample is fallback
  const [loading, setLoading] = useState(false);
  // null | 'verifying' | 'saving'  → drives the button label so users know the
  // AI is actively reviewing their video (builds trust in the safety promise)
  const [phase, setPhase] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const recorderRef = useRef(null);

  const firstName = user?.first_name || "there";
  const city = user?.city || "your city";
  // Dynamic script — pulls in entered name + city
  const scriptText = `"Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!"`;
  const scriptTranscript = `Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!`;

  useEffect(() => {
    api.get("/samples").then(({ data }) => setSamples(data.samples)).catch((e) => console.error(e));
  }, []);

  // Extract a single JPEG frame from the recorded blob via off-screen video + canvas.
  // Returns base64 (without the data: prefix) for the backend face-check.
  const captureFrameBase64 = (blob) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => {
      // seek slightly past the start so we don't grab a black frame
      try { v.currentTime = Math.min(0.6, (v.duration || 1) / 2); } catch { /* noop */ }
    };
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = Math.min(640, v.videoWidth || 480);
        c.height = Math.round(c.width * ((v.videoHeight || 360) / (v.videoWidth || 640)));
        const ctx = c.getContext("2d");
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL("image/jpeg", 0.72);
        URL.revokeObjectURL(url);
        resolve(dataUrl.split(",", 2)[1]);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    v.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
  });

  const save = async () => {
    setLoading(true);
    try {
      if (mode === "record" && recordedBlob) {
        // AI face / safety check on a captured frame BEFORE we accept the video
        setPhase("verifying");
        try {
          const b64 = await captureFrameBase64(recordedBlob);
          const { data: check } = await api.post("/video/face-check", { image_base64: b64 });
          track("face_check_done", { ok: !!check.ok });
          if (!check.ok) {
            const why = check.reason || "Please record a clearer video of just your face.";
            toast.error(`Video rejected: ${why}`);
            setLoading(false);
            setPhase(null);
            return;
          }
        } catch (err) {
          console.error("face check error", err);
          // Fail-open — if we can't extract a frame, allow save (rare)
        }

        setPhase("saving");
        const blobUrl = URL.createObjectURL(recordedBlob);
        await api.post("/users/video", {
          video_url: blobUrl,
          transcript: scriptTranscript,
          source_lang: (user?.language || "en"),
        });
        track("video_intro_set", { source: "recorded" });
        const me = await api.get("/users/me");
        onDone(me.data.user);
      } else {
        setPhase("saving");
        await api.post("/users/video", { sample_index: selectedIdx });
        track("video_intro_set", { source: "sample", sample_index: selectedIdx });
        const me = await api.get("/users/me");
        onDone(me.data.user);
      }
    } catch {
      toast.error("Couldn't save your intro");
    } finally {
      setLoading(false);
      setPhase(null);
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
      // auto-stop at 10 seconds
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
      className="absolute inset-0 flex flex-col px-6 pt-10 pb-6 bg-grain overflow-y-auto no-scrollbar"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="video-pick-screen"
    >
      <h2 className="font-display text-3xl font-black leading-tight">Intro<br/>video<span style={{ color: "#FF4D4D" }}>.</span></h2>
      <p className="mt-3 text-sm text-white/55">Keep it under 10 seconds. Use the script below word-for-word, or remix it.</p>

      {/* Dynamic script panel */}
      <div className="mt-5 rounded-2xl glass-dark border border-[#FF4D4D]/25 p-4" data-testid="intro-script">
        <p className="text-[10px] uppercase tracking-widest font-bold text-[#FF4D4D] flex items-center gap-1">
          <span aria-hidden="true">📜</span> Script for your 7-second intro video
        </p>
        <p className="mt-2 text-base italic font-medium leading-snug text-white">{scriptText}</p>
        <div className="mt-3 pt-3 border-t border-white/8 flex gap-2 items-start text-xs text-white/75 leading-snug">
          <span aria-hidden="true" className="text-base">⚠️</span>
          <span><span className="font-bold text-white">Keep it appropriate.</span> No nudity, hate speech, or harmful content. Videos that violate our community rules will be removed and may result in a ban.</span>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          className={`flex-1 px-4 py-2 rounded-full text-sm font-bold ${mode === "record" ? "bg-white text-black" : "bg-white/5 text-white/80"}`}
          onClick={() => setMode("record")}
          data-testid="video-mode-record"
        >Record now</button>
        <button
          className={`flex-1 px-4 py-2 rounded-full text-sm font-bold ${mode === "pick" ? "bg-white text-black" : "bg-white/5 text-white/80"}`}
          onClick={() => setMode("pick")}
          data-testid="video-mode-pick"
        >Use a sample</button>
      </div>

      {mode === "pick" ? (
        <div className="mt-4 grid grid-cols-2 gap-3 pb-2" data-testid="sample-grid">
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
        <div className="mt-4 relative aspect-[3/4] rounded-3xl overflow-hidden bg-black">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
          {!streamRef.current && !recordedBlob && (
            <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm">
              Press record to start
            </div>
          )}
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

      {phase === "verifying" && (
        <div className="mt-4 rounded-2xl glass-dark border border-[#00E5FF]/30 px-4 py-3 flex items-center gap-3" data-testid="face-check-status">
          <div className="relative w-5 h-5">
            <div className="absolute inset-0 rounded-full border-2 border-[#00E5FF]/30" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#00E5FF] animate-spin" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">✨ Verifying your video…</div>
            <div className="text-[11px] text-white/55">AI is checking it's just your face. Takes ~2 seconds.</div>
          </div>
        </div>
      )}

      <button
        className="btn-primary mt-4 flex items-center justify-center gap-2"
        onClick={save}
        disabled={loading || (mode === "record" && !recordedBlob)}
        data-testid="video-save-button"
      >
        {phase === "verifying" ? "Verifying your video…"
          : phase === "saving" ? "Saving…"
          : (<>Continue <ArrowRight size={18} /></>)}
      </button>
    </motion.div>
  );
}

// ---------- Feed ----------
function FeedScreen({ user, setUser, onMatch, onTab }) {
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const [locationOpen, setLocationOpen] = useState(false);
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
      track(`swipe_${action}`, { target_lang: item.source_lang });
      // remove from feed
      setFeed((f) => f.filter((x) => x.id !== item.id));
      if (data.match) {
        track("match_made");
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
          <p className="text-sm text-white/55">
            {user.city
              ? `You've seen everyone near ${user.city}. Switch cities to discover more.`
              : "You've seen everyone nearby. Come back later — new faces drop in all the time."}
          </p>
          <div className="flex gap-2 mt-4">
            <button className="btn-ghost" onClick={load} data-testid="feed-refresh">Refresh</button>
            <button className="btn-ghost" onClick={() => setLocationOpen(true)} data-testid="feed-change-location">
              <MapPin size={14} className="inline mr-1" /> Change city
            </button>
          </div>
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
              currentCity={user.city}
              onOpenLocation={() => setLocationOpen(true)}
              onLike={() => handleSwipe(i, "like")}
              onPass={() => handleSwipe(i, "pass")}
            />
          </div>
        ))}
      </div>

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

      <BottomNav active="feed" onTab={onTab} />
    </motion.div>
  );
}

// ---------- Change Location screen (full-screen modal) ----------
function ChangeLocationScreen({ user, onClose, onChanged }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [popular, setPopular] = useState([]);
  const [center, setCenter] = useState({
    lat: user.city_lat || user.lat || 40.7128,
    lng: user.city_lng || user.lng || -74.0060,
    label: user.city || "Drop a pin",
  });
  const [busy, setBusy] = useState(null); // "geo" | "save" | "tap" | null
  const debounceRef = useRef(null);
  const mapTapRef = useRef(null);

  // Load popular cities once on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/cities/popular");
        if (alive) setPopular(data.cities || []);
      } catch {
        if (alive) setPopular([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Debounced Photon city search
  const onQueryChange = (v) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=6&layer=city`);
        const j = await r.json();
        const items = (j.features || []).map((f) => ({
          value: `${f.properties.name}${f.properties.country ? ", " + f.properties.country : ""}`,
          city: f.properties.name,
          country: f.properties.country,
          country_code: (f.properties.countrycode || "").toLowerCase(),
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        }));
        setSuggestions(items);
      } catch { /* ignore */ }
    }, 220);
  };

  // Save the new location to backend, then notify parent to refresh feed
  const persist = async (lat, lng, cityLabel) => {
    setBusy("save");
    try {
      await api.post("/users/location", { lat, lng, city: cityLabel || null });
      const { data } = await api.get("/auth/me");
      track("location_changed", { city: cityLabel || "(coords only)" });
      toast.success(`Now exploring ${cityLabel || "nearby"} ✨`);
      onChanged(data.user);
    } catch (e) {
      toast.error("Couldn't update location");
    } finally {
      setBusy(null);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error("Geolocation isn't available"); return; }
    setBusy("geo");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // Reverse-geocode via Photon
        let cityLabel = null;
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
          const j = await r.json();
          const f = j.features?.[0]?.properties;
          if (f) cityLabel = `${f.city || f.name || ""}${f.country ? ", " + f.country : ""}`.trim().replace(/^,\s*/, "");
        } catch { /* ignore */ }
        setCenter({ lat, lng, label: cityLabel || "Your location" });
        await persist(lat, lng, cityLabel);
      },
      () => { toast.error("Couldn't access your location"); setBusy(null); },
      { timeout: 8000, maximumAge: 60_000 }
    );
  };

  const pickSuggestion = (item) => {
    setCenter({ lat: item.lat, lng: item.lng, label: item.value });
    setSuggestions([]);
    setQuery(item.value);
    persist(item.lat, item.lng, item.value);
  };

  const pickPopular = (c) => {
    const label = `${c.city}${c.country ? ", " + c.country : ""}`;
    setCenter({ lat: c.lat, lng: c.lng, label });
    persist(c.lat, c.lng, label);
  };

  // Tap anywhere on the map preview → convert pixel to lat/lng using the
  // currently-rendered bbox, reverse-geocode for a city label, then persist.
  const handleMapTap = async (e) => {
    if (busy) return;
    const el = mapTapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (rect.width <= 0 || rect.height <= 0) return;
    const lngMin = center.lng - D;
    const lngMax = center.lng + D;
    const latMin = center.lat - D / 2;
    const latMax = center.lat + D / 2;
    const lng = lngMin + (x / rect.width) * (lngMax - lngMin);
    const lat = latMax - (y / rect.height) * (latMax - latMin);

    setBusy("tap");
    let cityLabel = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
      const j = await r.json();
      const f = j.features?.[0]?.properties;
      if (f) {
        const name = f.city || f.name || f.county || f.state || "";
        if (name) {
          cityLabel = `${name}${f.country ? ", " + f.country : ""}`.trim().replace(/^,\s*/, "");
        }
      }
    } catch { /* ignore */ }
    setCenter({ lat, lng, label: cityLabel });
    track("location_map_tapped", { lat, lng });
    await persist(lat, lng, cityLabel);
  };

  // OSM embed bbox (~0.2° square around the point)
  const D = 0.12;
  const bbox = `${center.lng - D},${center.lat - D / 2},${center.lng + D},${center.lat + D / 2}`;
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${center.lat},${center.lng}`;

  return (
    <motion.div
      className="absolute inset-0 z-50 bg-black flex flex-col"
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      data-testid="change-location-screen"
    >
      <div className="flex items-center justify-between px-6 pt-12 pb-3">
        <h2 className="font-display text-2xl font-black">
          Change location<span style={{ color: "#FF4D4D" }}>.</span>
        </h2>
        <button
          onClick={onClose}
          className="text-white/60 hover:text-white p-2 -mr-2"
          aria-label="Close"
          data-testid="change-location-close"
        >
          <X size={22} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-10 flex flex-col gap-4">
        {/* Search input */}
        <div className="relative">
          <input
            className="n2m-input pr-10"
            placeholder="Search a city…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            data-testid="change-location-search-input"
            autoComplete="off"
          />
          <Sparkles size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 mt-1 glass-dark rounded-2xl border border-white/10 max-h-64 overflow-y-auto z-10 shadow-2xl">
              {suggestions.map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  onClick={() => pickSuggestion(s)}
                  className="w-full text-left px-4 py-2.5 hover:bg-white/8 flex items-center justify-between gap-2"
                  data-testid={`change-location-suggestion-${i}`}
                >
                  <span className="text-sm">{s.value}</span>
                  <MapPin size={12} className="text-white/40 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Use my current location */}
        <button
          onClick={useMyLocation}
          disabled={busy !== null}
          className="w-full flex items-center justify-center gap-2 rounded-2xl py-3 bg-gradient-to-r from-[#FF4D4D]/15 to-[#00E5FF]/10 border border-white/12 hover:border-white/25 transition disabled:opacity-50"
          data-testid="change-location-use-mine"
        >
          <span className="text-lg">📡</span>
          <span className="font-bold text-sm">
            {busy === "geo" ? "Locating…" : "Use my current location"}
          </span>
        </button>

        {/* Map preview — tap anywhere to pick that spot */}
        <div className="rounded-2xl overflow-hidden border border-white/10 bg-white/5 flex-shrink-0">
          <div className="relative" style={{ height: 200 }}>
            <iframe
              key={`${center.lat}-${center.lng}`}
              title="Map preview"
              src={mapUrl}
              className="absolute inset-0 w-full h-full"
              style={{ border: 0 }}
              data-testid="change-location-map"
            />
            <button
              ref={mapTapRef}
              type="button"
              onClick={handleMapTap}
              disabled={busy !== null}
              className="absolute inset-0 cursor-crosshair disabled:cursor-wait"
              aria-label="Tap to pick this spot"
              data-testid="change-location-map-tap"
            />
            <div className="absolute top-2 left-2 glass-dark px-2 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/85 pointer-events-none flex items-center gap-1">
              <MapPin size={10} className="text-[#FF4D4D]" />
              <span>{busy === "tap" ? "Resolving…" : "Tap map to pick"}</span>
            </div>
          </div>
          <div className="px-3 py-2 flex items-center gap-1.5 text-xs text-white/70">
            <MapPin size={12} className="text-[#FF4D4D]" />
            <span className="truncate">{center.label}</span>
          </div>
        </div>

        {/* Popular cities */}
        <div className="mt-1">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-base">🔥</span>
              <h3 className="font-display text-base font-black">Popular cities</h3>
            </div>
            <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">tap to jump</span>
          </div>

          <div className="flex flex-col gap-2">
            {popular.length === 0 && (
              <div className="text-xs text-white/40 py-3">Loading hotspots…</div>
            )}
            {popular.map((c, i) => (
              <button
                key={`${c.city}-${c.country}-${i}`}
                onClick={() => pickPopular(c)}
                disabled={busy !== null || c.lat == null}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5 bg-white/5 hover:bg-white/10 active:scale-[0.99] transition text-left disabled:opacity-50"
                data-testid={`change-location-popular-${i}`}
              >
                <div className="text-2xl shrink-0">{c.flag}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-display text-base font-black truncate">{c.city}</div>
                  <div className="text-xs text-white/45 truncate">{c.country || "—"}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded-full ${c.people > 0 ? "bg-[#FF4D4D]/20 text-white" : "bg-white/8 text-white/55"}`}>
                    {c.people === 1 ? "1 person" : `${c.people} people`}
                  </span>
                  <ArrowRight size={14} className="text-white/35" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function FeedCard({ item, isActive, myLang, onLike, onPass, currentCity, onOpenLocation }) {
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

      {/* distance / location pill — tap to change feed location */}
      <button
        type="button"
        onClick={onOpenLocation}
        className="absolute top-5 right-5 flex items-center gap-1.5 glass-dark px-3 py-1.5 rounded-full text-xs font-bold transition hover:bg-white/15 active:scale-95"
        data-testid="feed-distance-badge"
        aria-label="Change feed location"
      >
        <MapPin size={12} className="text-[#FF4D4D]" />
        <span>{item.distance_km < 100 ? `${item.distance_km} km` : "near you"}</span>
        {currentCity && (
          <span className="text-[9px] text-white/55 uppercase tracking-widest ml-0.5 max-w-[90px] truncate">
            · {currentCity.split(",")[0]}
          </span>
        )}
      </button>

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
      track("chat_message_sent", { length: text.trim().length });
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
          const hasTranslation = !mine && m.translated_text && m.translated_text !== m.text;
          return (
            <div
              key={m.id}
              className={`max-w-[78%] flex flex-col gap-1 ${mine ? "self-end items-end" : "self-start items-start"}`}
              data-testid={`chat-msg-${m.id}`}
            >
              <div
                className={`px-4 py-2.5 rounded-2xl text-[15px] font-medium leading-snug ${mine ? "bg-[#FF4D4D] text-white rounded-br-md" : "bg-white/10 text-white rounded-bl-md"}`}
              >
                {hasTranslation ? m.translated_text : m.text}
              </div>
              {hasTranslation && (
                <div
                  className="px-3 py-1 rounded-xl bg-white/4 border border-white/8 flex flex-col gap-0.5"
                  data-testid={`chat-msg-original-${m.id}`}
                >
                  <span className="inline-flex w-fit items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[#00E5FF]">
                    <Languages size={9} /> {m.source_lang}→{me.language || "en"}
                  </span>
                  <span className="text-[11px] italic text-white/50 leading-tight">{m.text}</span>
                </div>
              )}
            </div>
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

// ---------- Share card (referral) ----------
function ShareCard({ user }) {
  const [copied, setCopied] = useState(false);
  const handle = user.handle || user.codename?.toLowerCase().replace(/\s+/g, ".");
  const shareUrl = `${window.location.origin}/?ref=${encodeURIComponent(handle)}`;
  const shareText = `${user.codename} just invited you to Nice2Meechu — video-first, hyperlocal, anonymous until the spark.`;

  const onShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Nice2Meechu", text: shareText, url: shareUrl });
        track("share_started", { method: "web_share_api" });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      track("share_started", { method: "clipboard_fallback" });
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      if (e?.name !== "AbortError") {
        console.error("share failed", e);
        toast.error("Couldn't share — copy from the link below");
      }
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      track("referral_link_copied");
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.error("copy failed", e);
    }
  };

  const referralCount = user.referral_count || 0;

  return (
    <div className="mt-5 rounded-3xl overflow-hidden border border-white/10" data-testid="profile-share-card">
      {/* Preview strip */}
      <div className="relative px-5 py-4 flex items-center gap-3" style={{ background: "linear-gradient(135deg, rgba(255,77,77,0.18), rgba(0,229,255,0.12))" }}>
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-black/40 text-2xl">{user.avatar_emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest font-bold text-white/55">your invite card</div>
          <div className="font-display font-black text-lg leading-tight truncate">{user.codename}</div>
          {referralCount > 0 && (
            <div className="text-[10px] text-[#00E5FF] font-bold uppercase tracking-widest mt-0.5">
              +{referralCount} friend{referralCount > 1 ? "s" : ""} joined
            </div>
          )}
        </div>
        <Sparkles size={20} className="text-[#FF4D4D]" />
      </div>
      {/* Actions */}
      <div className="bg-black/40 px-4 py-3 flex gap-2">
        <button
          className="btn-primary flex-1 flex items-center justify-center gap-2 text-sm py-3"
          onClick={onShare}
          data-testid="profile-share-button"
        >
          <Share2 size={16} /> Share invite
        </button>
        <button
          className="px-4 rounded-full bg-white/8 text-white border border-white/10 active:scale-95 transition"
          onClick={onCopy}
          data-testid="profile-copy-link-button"
          aria-label="Copy invite link"
        >
          {copied ? <Check size={16} className="text-[#00E5FF]" /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

// ---------- Profile ----------
function ProfileScreen({ user, setUser, onTab, onLogout, onChangeVideo }) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(user.first_name || "");
  const [city, setCity] = useState(user.city || "");
  const [cityCoords, setCityCoords] = useState(null);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [language, setLanguage] = useState(user.language || "en");
  const [emoji, setEmoji] = useState(user.avatar_emoji || "🌙");
  const [saving, setSaving] = useState(false);

  const ageNum = parseInt(age, 10);
  const canSave =
    firstName.trim().length >= 1 &&
    city.trim().length >= 2 &&
    !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120;

  const save = async () => {
    if (!canSave) { toast.error("Check name, city, and age (13+)"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/users/onboarding", {
        first_name: firstName.trim(),
        city: city.trim(),
        age: ageNum,
        language,
        avatar_emoji: emoji,
        city_lat: cityCoords?.lat ?? null,
        city_lng: cityCoords?.lng ?? null,
      });
      setUser(data.user);
      setEditing(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save");
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
              <div className="mt-4 text-sm text-white/80">
                <span className="font-bold text-white">{user.first_name}</span>
                {user.age ? <span className="text-white/60"> · {user.age}</span> : null}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <MapPin size={12} /> {user.city || "Somewhere on Earth"}
              </div>
              <div className="mt-1 text-xs text-white/60 flex items-center gap-1.5">
                <Globe size={12} /> Native: {LANG_OPTIONS.find((l) => l.code === user.language)?.name || user.language}
              </div>

              <ShareCard user={user} />

              <div className="mt-3 grid grid-cols-2 gap-2">
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
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">First name</p>
                <input
                  className="n2m-input"
                  value={firstName}
                  maxLength={40}
                  onChange={(e) => setFirstName(e.target.value)}
                  data-testid="profile-firstname-input"
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">City</p>
                <CityAutocomplete
                  value={city}
                  onChange={(v) => { setCity(v); setCityCoords(null); }}
                  onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">Age</p>
                <input
                  className="n2m-input"
                  inputMode="numeric"
                  value={age}
                  maxLength={3}
                  onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))}
                  data-testid="profile-age-input"
                />
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
              <button className="btn-primary" onClick={save} disabled={saving || !canSave} data-testid="profile-save">
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
