import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { Toaster, toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart, X, MapPin, Languages, ArrowRight, ArrowLeft, Sparkles,
  Send, MessageCircle, User as UserIcon, Video as VideoIcon, Camera,
  Globe, Check, LogOut, Pause, Play, Share2, Copy, AlertTriangle, RotateCcw,
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

import { CookieConsentBanner, getCookieConsent, PrivacyPolicyPage, SAFETY_CONTACT_URL, TermsOfServicePage } from "./legal/LegalPages";

// ---------- Share helpers ----------
// Robust copy that works even in cross-origin iframes (Emergent preview) where
// `navigator.clipboard.writeText` is blocked by the missing `clipboard-write`
// permission. Falls back to a hidden <textarea> + document.execCommand('copy'),
// which is deprecated but still the only thing that works in those sandboxes.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* permissions or insecure context — fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Tries Web Share first; on AbortError returns silently (user cancelled);
// otherwise falls back to clipboard. Returns "shared" | "copied" | "failed".
async function shareOrCopy({ title, text, url, copyText }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "shared"; // treat cancel as no-op
      console.warn("web share blocked, falling back to clipboard", err);
    }
  }
  const ok = await copyToClipboard(copyText || url || text);
  return ok ? "copied" : "failed";
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
  const [unreadMatches, setUnreadMatches] = useState(0);
  const callbackProcessed = useRef(false);

  // Poll for unread match count whenever the user is signed in. We refresh:
  // - once when the user object is first set,
  // - whenever the user navigates between Feed / Matches / Profile (cheap int call),
  // - every 60s in the background while the tab is open.
  // Visiting the Matches screen calls GET /api/matches which resets the
  // backend "last_matches_viewed_at" — so the count naturally returns to 0.
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const { data } = await api.get("/matches/unread");
        if (!cancelled) setUnreadMatches(data?.count || 0);
      } catch { /* not signed in or transient — ignore */ }
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user?.id, screen]);

  // Static legal pages — detect path so /privacy and /terms work as links from
  // cookie banner, emails, search engines, etc. Rendered as overlays so the
  // user can return to where they were without a full reload.
  const [legalPage, setLegalPage] = useState(() => {
    if (typeof window === "undefined") return null;
    if (window.location.pathname === "/privacy") return "privacy";
    if (window.location.pathname === "/terms") return "terms";
    return null;
  });
  const openLegal = (kind) => {
    setLegalPage(kind);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", `/${kind}`);
    }
  };
  const closeLegal = () => {
    setLegalPage(null);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/");
    }
  };

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
    // GA4 only loads after the user has explicitly accepted the cookie banner.
    if (getCookieConsent() === "accepted") initAnalytics();
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
    // Surface ?auth_error=... from the redirect-mode Google flow so the user
    // sees a toast instead of a silent failure. Strip it from the URL.
    const url = new URL(window.location.href);
    const authError = url.searchParams.get("auth_error");
    if (authError) {
      url.searchParams.delete("auth_error");
      window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
      const messages = {
        invalid_credential: "Sign-in failed — please try again.",
        email_unverified: "Your Google email isn't verified.",
      };
      toast.error(messages[authError] || "Sign-in failed. Try again.");
    }
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

      {legalPage === "privacy" && <PrivacyPolicyPage onBack={closeLegal} />}
      {legalPage === "terms" && <TermsOfServicePage onBack={closeLegal} />}

      <CookieConsentBanner onChange={(v) => {
        if (v === "accepted") initAnalytics();
        if (v === "__view_privacy") openLegal("privacy");
      }} />

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
            <VideoPick
              key="vid"
              user={user}
              onDone={(u) => { setUser(u); setScreen("feed"); }}
              onSkip={user?.agreed_to_rules_at ? () => setScreen("feed") : null}
            />
          )}
          {screen === "feed" && user && (
            <FeedScreen key="feed"
              user={user}
              setUser={setUser}
              unreadMatches={unreadMatches}
              onMatch={(m) => { setMatchState(m); setUnreadMatches((n) => n + 1); }}
              onTab={(s) => setScreen(s)}
            />
          )}
          {screen === "matches" && user && (
            <MatchesScreen key="matches"
              user={user}
              unreadMatches={unreadMatches}
              onTab={(s) => setScreen(s)}
              onLoaded={() => setUnreadMatches(0)}
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
              unreadMatches={unreadMatches}
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

// ---------- Google Sign-In (Direct Google Identity Services / GIS) ----------
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;

// iOS Safari (and in-app webviews on iOS — they all use WebKit) blocks the
// popup-mode GIS flow under Intelligent Tracking Prevention. Detect those
// browsers and force GIS into redirect mode where Google form-POSTs the
// credential straight to our backend. Desktop + Android Chrome keep popup
// mode because it's a snappier UX.
function isIosWebkit() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad on iPadOS 13+ reports as "MacIntel" with touch support — still WebKit.
  const isIpadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isIpadOs;
}

function SignInScreen() {
  const btnRef = useRef(null);
  const [gisError, setGisError] = useState(null);

  // Called by GIS when the user completes Google sign-in. The `response.credential`
  // is a Google-issued ID-token JWT we hand off to the backend for verification.
  const handleCredential = useCallback(async (response) => {
    track("sign_in_started", { method: "google" });
    try {
      const ref = localStorage.getItem("n2m_ref") || undefined;
      const { data } = await api.post("/auth/google", {
        credential: response.credential,
        ref,
      });
      if (data.token) localStorage.setItem("n2m_token", data.token);
      localStorage.removeItem("n2m_ref");
      track("sign_in_completed", { onboarded: !!data.onboarded, referred: !!ref });
      // App-level mount-time hydration will run, but to be snappy we reload
      // so /auth/me is re-fetched and routeToNext fires immediately.
      window.location.reload();
    } catch (err) {
      console.error("google sign-in failed", err);
      track("sign_in_failed");
      // Show the specific error from the server (audience mismatch, expired,
      // etc.) so users/testers can report exactly what's failing.
      const detail = err?.response?.data?.detail;
      toast.error(detail ? `Sign-in failed: ${detail}` : "Sign-in failed. Try again.");
    }
  }, []);

  // Initialize GIS and render the official Google button. We retry briefly
  // because the GIS script loads `async defer` and may not be ready on mount.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setGisError("Google Sign-In is not configured.");
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const tryInit = () => {
      if (cancelled) return;
      const gis = window.google?.accounts?.id;
      if (!gis) {
        if (attempts++ < 40) return setTimeout(tryInit, 100);
        setGisError("Couldn't load Google Sign-In. Check your connection.");
        return;
      }
      try {
        const apiBase = process.env.REACT_APP_BACKEND_URL || "";
        const useRedirect = isIosWebkit();
        // Persist a referral hint for the redirect-mode flow — `handleCredential`
        // pulls it from localStorage so the popup path keeps working, but the
        // redirect path can't pass it through Google so the backend reads it
        // from a query-string `state` we tack onto `login_uri` below.
        const ref = localStorage.getItem("n2m_ref") || "";
        const loginUri = ref
          ? `${apiBase}/api/auth/google-redirect?ref=${encodeURIComponent(ref)}`
          : `${apiBase}/api/auth/google-redirect`;
        gis.initialize({
          client_id: GOOGLE_CLIENT_ID,
          // Popup mode invokes `callback`; redirect mode ignores it and POSTs
          // straight to `login_uri` — Google requires callback to be defined
          // regardless, so we always pass it.
          callback: handleCredential,
          // iOS Safari blocks popup OAuth (ITP). Use redirect on iOS only;
          // desktop + Android stay on popup for the snappier UX.
          ux_mode: useRedirect ? "redirect" : "popup",
          login_uri: loginUri,
          auto_select: false,
          itp_support: true,
        });
        if (btnRef.current) {
          // .replaceChildren() instead of .innerHTML = "" — same effect (empty
          // the container before Google's SDK renders the official pill button
          // into it) but avoids any innerHTML usage so SAST tools don't flag
          // it as an XSS sink. There's no user input here regardless.
          btnRef.current.replaceChildren();
          gis.renderButton(btnRef.current, {
            type: "standard",
            theme: "filled_white",
            size: "large",
            text: "continue_with",
            shape: "pill",
            logo_alignment: "left",
            width: 280,
          });
        }
      } catch (e) {
        console.error("GIS init failed", e);
        setGisError("Sign-in unavailable. Refresh and try again.");
      }
    };
    tryInit();
    return () => { cancelled = true; };
  }, [handleCredential]);

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

      <div className="mt-auto flex flex-col items-center gap-3">
        <div
          ref={btnRef}
          className="flex justify-center"
          data-testid="signin-google-button"
          style={{ colorScheme: "light" }}
        />
        {gisError && (
          <p className="text-center text-xs text-red-400" data-testid="signin-error">
            {gisError}
          </p>
        )}
        <p className="text-center text-[11px] text-white/40 font-medium uppercase tracking-widest">
          By continuing you agree to be Nice
        </p>
      </div>
    </motion.div>
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
  const [autoCityTried, setAutoCityTried] = useState(false);
  const [autoCityLoading, setAutoCityLoading] = useState(false);
  const [age, setAge] = useState(user.age ? String(user.age) : "");
  const [loading, setLoading] = useState(false);

  // Try to auto-fill the city from the user's geolocation when they land on
  // the city step. Reverse-geocodes lat/lng → "City, Country" via Photon
  // (same provider as autocomplete, no extra dep). Only fires:
  //   - on first visit to step 1
  //   - if the city field is empty (don't overwrite a manual entry)
  //   - if we have user.lat/lng from the App-level geolocation grab
  // Best-effort: any failure is silent, the user can still type it.
  useEffect(() => {
    if (step !== 1 || autoCityTried || city.trim().length > 0) return;
    const lat = user.lat;
    const lng = user.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    setAutoCityTried(true);
    setAutoCityLoading(true);
    (async () => {
      try {
        const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`);
        const j = await r.json();
        const p = j?.features?.[0]?.properties;
        if (!p) return;
        // Photon's nearest feature for a coord is usually a building/POI —
        // pick the human-readable place fields we know exist: city / town /
        // village fallback chain. Country gets appended so the user sees the
        // full disambiguated label, matching what autocomplete returns.
        const placeName = p.city || p.town || p.village || p.county || p.name;
        const country = p.country;
        if (!placeName) return;
        const label = country ? `${placeName}, ${country}` : placeName;
        setCity(label);
        setCityCoords({ lat, lng });
        track("onboarding_city_auto_filled", { source: "reverse_geocode" });
      } catch {
        // network / parse failure — silently fall back to manual typing
      } finally {
        setAutoCityLoading(false);
      }
    })();
  }, [step, autoCityTried, city, user.lat, user.lng]);

  const total = 3;
  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const ageNum = parseInt(age, 10);
  const canNext =
    (step === 0 && firstName.trim().length >= 1) ||
    (step === 1 && city.trim().length >= 2) ||
    (step === 2 && !isNaN(ageNum) && ageNum >= 13 && ageNum <= 120);

  // Mobile keyboards bury the Continue button under the keyboard, so users
  // reach for the Enter key instead. Wire it up: Enter on any input runs the
  // same action as tapping Continue — next step on 0/1, submit on 2.
  const onEnterSubmit = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!canNext) return;
    if (step < total - 1) next();
    else if (!loading) submit();
  };

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
            onKeyDown={onEnterSubmit}
            enterKeyHint="next"
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
            biasLat={user.lat}
            biasLng={user.lng}
            onEnter={() => { if (canNext) next(); }}
          />
          {autoCityLoading && (
            <p className="mt-2 text-[11px] text-white/45 flex items-center gap-1" data-testid="onboarding-city-detecting">
              <MapPin size={11} className="text-white/45 animate-pulse" /> Detecting your city…
            </p>
          )}
          {!autoCityLoading && autoCityTried && cityCoords && (
            <p className="mt-2 text-[11px] text-white/55 flex items-center gap-1" data-testid="onboarding-city-detected">
              <MapPin size={11} className="text-[#00E5FF]" /> Detected from your location — change if wrong
            </p>
          )}
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
            onKeyDown={onEnterSubmit}
            enterKeyHint="done"
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
// Friendly short country names + state abbreviations for the US.
// Photon returns full state names ("New Jersey") and country names ("United States").
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return "";
  const A = 0x1f1e6;
  const c = cc.toLowerCase();
  return String.fromCodePoint(A + (c.charCodeAt(0) - 97), A + (c.charCodeAt(1) - 97));
}
const COUNTRY_SHORT = {
  "United States": "USA",
  "United States of America": "USA",
  "United Kingdom": "UK",
  "United Arab Emirates": "UAE",
  "Russian Federation": "Russia",
  "Republic of Korea": "South Korea",
  "Democratic Republic of the Congo": "DR Congo",
  "Bolivia (Plurinational State of)": "Bolivia",
  "Venezuela (Bolivarian Republic of)": "Venezuela",
  "Iran (Islamic Republic of)": "Iran",
  "Czechia": "Czechia",
  // Photon sometimes returns native country names — normalize the common ones.
  "Deutschland": "Germany",
  "España": "Spain",
  "Italia": "Italy",
  "Brasil": "Brazil",
  "México": "Mexico",
  "Polska": "Poland",
  "Türkiye": "Turkey",
  "Suomi": "Finland",
  "Sverige": "Sweden",
  "Norge": "Norway",
  "Nederland": "Netherlands",
  "Österreich": "Austria",
  "Schweiz": "Switzerland",
  "Magyarország": "Hungary",
  "Ελλάδα": "Greece",
  "日本": "Japan",
  "中国": "China",
  "대한민국": "South Korea",
};
const US_STATE_ABBR = {
  Alabama:"AL", Alaska:"AK", Arizona:"AZ", Arkansas:"AR", California:"CA", Colorado:"CO",
  Connecticut:"CT", Delaware:"DE", Florida:"FL", Georgia:"GA", Hawaii:"HI", Idaho:"ID",
  Illinois:"IL", Indiana:"IN", Iowa:"IA", Kansas:"KS", Kentucky:"KY", Louisiana:"LA",
  Maine:"ME", Maryland:"MD", Massachusetts:"MA", Michigan:"MI", Minnesota:"MN",
  Mississippi:"MS", Missouri:"MO", Montana:"MT", Nebraska:"NE", Nevada:"NV",
  "New Hampshire":"NH", "New Jersey":"NJ", "New Mexico":"NM", "New York":"NY",
  "North Carolina":"NC", "North Dakota":"ND", Ohio:"OH", Oklahoma:"OK", Oregon:"OR",
  Pennsylvania:"PA", "Rhode Island":"RI", "South Carolina":"SC", "South Dakota":"SD",
  Tennessee:"TN", Texas:"TX", Utah:"UT", Vermont:"VT", Virginia:"VA", Washington:"WA",
  "West Virginia":"WV", Wisconsin:"WI", Wyoming:"WY", "District of Columbia":"DC",
};

// Format Photon properties into "City, State, Country" — collapses
// "United States" → "USA", and US states into 2-letter abbreviations.
function formatCityLabel(p = {}) {
  const country = COUNTRY_SHORT[p.country] || p.country || "";
  let state = p.state || "";
  if (country === "USA" && US_STATE_ABBR[state]) state = US_STATE_ABBR[state];
  const parts = [p.name, state, country].filter(Boolean);
  return parts.join(", ");
}

function CityAutocomplete({ value, onChange, onPick, biasLat, biasLng, onEnter }) {
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
        // Geographic bias — if we have the user's coords (captured from
        // navigator.geolocation after sign-in, see App effect), pass them so
        // results near them rank first. e.g. typing "Berlin" in Brandenburg
        // surfaces Berlin, Germany; in New Hampshire surfaces Berlin, NH.
        // location_bias_scale=0.6 is a moderate bias (not exclusive), and
        // zoom=10 corresponds to roughly a city-region focus area.
        let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=5&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:suburb&osm_tag=place:hamlet`;
        if (typeof biasLat === "number" && typeof biasLng === "number") {
          url += `&lat=${biasLat}&lon=${biasLng}&location_bias_scale=0.6&zoom=10`;
        }
        const r = await fetch(url);
        const data = await r.json();
        const items = (data?.features || []).map((f) => {
          const p = f.properties || {};
          const coords = f.geometry?.coordinates || []; // [lng, lat]
          return {
            label: formatCityLabel(p),
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

  const hasBias = typeof biasLat === "number" && typeof biasLng === "number";

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
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Mobile-keyboard Enter behavior: prefer the top suggestion if the
          // autocomplete dropdown is open & has results, otherwise hand off
          // to the parent (advances the onboarding step).
          if (open && suggestions.length > 0) {
            pick(suggestions[0]);
          } else if (onEnter) {
            onEnter();
          }
        }}
        enterKeyHint="next"
        data-testid="onboarding-city-input"
      />
      {hasBias && (
        <p
          className="mt-1.5 text-[10px] text-white/45 flex items-center gap-1"
          data-testid="city-autocomplete-bias-hint"
        >
          <MapPin size={10} className="text-[#00E5FF]" /> Sorted by closest to you
        </p>
      )}
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
  "I consent to my face being briefly analysed by AI to verify my intro video, as described in the Privacy Policy.",
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
      <p className="mt-3 text-sm text-white/55">Read every line, check every box, and sign below to continue.</p>

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
function VideoPick({ user, onDone, onSkip }) {
  const [loading, setLoading] = useState(false);
  // null | 'verifying' | 'saving'  → drives the button label so users know the
  // AI is actively reviewing their video (builds trust in the safety promise)
  const [phase, setPhase] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const recorderRef = useRef(null);
  const [rejectReason, setRejectReason] = useState(null);

  const firstName = user?.first_name || "there";
  const city = user?.city || "your city";
  // Dynamic script — pulls in entered name + city
  const scriptText = `"Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!"`;
  const scriptTranscript = `Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!`;

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
      try { v.currentTime = Math.min(0.6, (v.duration || 1) / 2); } catch (err) { console.warn("video seek failed", err); }
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
    setRejectReason(null);
    if (!recordedBlob) {
      toast.error("Record your intro first");
      return;
    }
    setLoading(true);
    try {
      // AI face / safety check on a captured frame BEFORE we accept the video
      setPhase("verifying");
      try {
        const b64 = await captureFrameBase64(recordedBlob);
        const { data: check } = await api.post("/video/face-check", { image_base64: b64 });
        track("face_check_done", { ok: !!check.ok });
        if (!check.ok) {
          const why = check.reason || "Please record a clearer video of just your face.";
          setRejectReason(why);
          setLoading(false);
          setPhase(null);
          return;
        }
      } catch (err) {
        console.error("face check error", err);
        // Fail-open — if we can't extract a frame, allow save (rare)
      }

      setPhase("saving");
      // Persist the recording to the backend so the URL survives tab close.
      // (Previously we used URL.createObjectURL(blob), which is in-memory and
      // dies when the tab/browser closes — the user effectively lost their
      // intro on every return visit.)
      const ext = (recordedBlob.type || "").includes("mp4") ? "mp4" : "webm";
      const form = new FormData();
      form.append("file", recordedBlob, `intro.${ext}`);
      const { data: up } = await api.post("/users/video/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      await api.post("/users/video", {
        video_url: up.video_url,
        transcript: scriptTranscript,
        source_lang: (user?.language || "en"),
      });
      track("video_intro_set", { source: "recorded" });
      const me = await api.get("/users/me");
      onDone(me.data.user);
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
        // play() returns a Promise that REJECTS with AbortError if a new
        // load/srcObject swap happens before the first frame paints. Swallow
        // it — it's harmless but trips the dev-mode error overlay.
        videoRef.current.play().catch(() => {});
      }
    } catch {
      toast.error("Camera permission is needed to record your intro. Please enable it in your browser settings.");
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const toggleRecord = () => {
    if (!streamRef.current) return;
    if (!recording) {
      const chunks = [];
      const r = new MediaRecorder(streamRef.current, { mimeType: "video/webm" });
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        setRecordedBlob(blob);
        setRejectReason(null);
      };
      r.start();
      recorderRef.current = r;
      setRecording(true);
      // auto-stop at 7 seconds (matches the "7-second intro" script copy)
      setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
          setRecording(false);
        }
      }, 7000);
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
      {onSkip && (
        // Top-right close button — only rendered for signed-in users who've
        // already accepted community rules (i.e. not blocking primary onboarding).
        <button
          type="button"
          onClick={() => { try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch {} ; onSkip(); }}
          aria-label="Close and skip for now"
          className="absolute top-4 right-4 z-10 w-9 h-9 rounded-full glass-dark border border-white/15 text-white/85 hover:text-white hover:bg-white/10 active:scale-95 transition flex items-center justify-center text-lg leading-none"
          data-testid="video-pick-close"
        >
          ✕
        </button>
      )}
      <h2 className="font-display text-3xl font-black leading-tight">Intro<br/>video<span style={{ color: "#FF4D4D" }}>.</span></h2>
      <p className="mt-3 text-sm text-white/55">Keep it under 7 seconds. Use the script below word-for-word, or remix it.</p>

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

      {rejectReason && phase !== "verifying" && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-2xl bg-[#FF4D4D]/12 border border-[#FF4D4D]/45 px-4 py-3 flex items-start gap-3"
          data-testid="face-check-reject"
          role="alert"
        >
          <AlertTriangle size={18} className="text-[#FF4D4D] shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Video rejected</div>
            <div className="text-[11px] text-white/70 mt-0.5 leading-snug">{rejectReason}</div>
            <div className="text-[11px] text-white/55 mt-1">Tap the record button to try again.</div>
            <a
              href={SAFETY_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] text-[#00E5FF] hover:text-white underline mt-2"
              data-testid="face-check-reject-contact"
            >
              Looks wrong? Contact us →
            </a>
          </div>
          <button
            onClick={() => setRejectReason(null)}
            className="text-white/55 hover:text-white p-1 -mr-1 -mt-1"
            aria-label="Dismiss"
            data-testid="face-check-reject-dismiss"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}

      <button
        className="btn-primary mt-4 flex items-center justify-center gap-2"
        onClick={save}
        disabled={loading || !recordedBlob}
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
function FeedScreen({ user, setUser, unreadMatches, onMatch, onTab }) {
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
        const items = (j.features || []).map((f) => {
          const p = f.properties || {};
          return {
            value: formatCityLabel(p),
            city: p.name,
            state: p.state,
            country: p.country,
            country_code: (p.countrycode || "").toLowerCase(),
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
          };
        });
        setSuggestions(items);
      } catch (err) { console.warn("city autocomplete failed", err); }
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
    if (!navigator.geolocation) {
      toast.error("Geolocation isn't available in this browser");
      return;
    }
    // Detect the iframe sandbox case (Emergent Preview, etc.) — geolocation
    // requires the parent <iframe> to set allow="geolocation" which most
    // preview shells don't. The production site at nice2meechu.com is
    // top-level, so the API works fine there.
    const inIframe = (() => {
      try { return window.self !== window.top; } catch { return true; }
    })();

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
          if (f) {
            // Photon reverse uses `city` for the place name (instead of `name`).
            const p = { ...f, name: f.city || f.name };
            cityLabel = formatCityLabel(p);
          }
        } catch (err) { console.warn("reverse geocode failed", err); }
        setCenter({ lat, lng, label: cityLabel || "Your location" });
        await persist(lat, lng, cityLabel);
      },
      (err) => {
        const code = err && err.code;
        let msg = "Couldn't access your location";
        if (code === 1) {
          // PERMISSION_DENIED — could be user-blocked OR iframe sandboxing
          msg = inIframe
            ? "Geolocation is blocked in the preview window. It works on nice2meechu.com — or enter a city, tap the map, or pick a popular city below."
            : "Location permission denied. Enter a city, tap the map, or pick a popular city below.";
        } else if (code === 2) {
          msg = "Location unavailable right now. Enter a city, tap the map, or pick a popular city below.";
        } else if (code === 3) {
          msg = "Locating timed out. Enter a city, tap the map, or pick a popular city below.";
        }
        toast.error(msg);
        setBusy(null);
      },
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
          const p = { ...f, name };
          cityLabel = formatCityLabel(p);
        }
      }
    } catch (err) { console.warn("map-tap reverse geocode failed", err); }
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

function FeedCard({ item, isActive, myLang, onLike, onPass, currentCity, onOpenLocation, muted, setMuted, positionLabel, isLastInCity, onRestart, paused }) {
  const vidRef = useRef(null);
  const [translated, setTranslated] = useState("");
  const [showCaption, setShowCaption] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!vidRef.current) return;
    if (isActive) {
      vidRef.current.currentTime = 0;
      vidRef.current.muted = muted;
      if (!paused) vidRef.current.play().catch(() => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, item.transcript, item.source_lang, myLang, muted]);

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
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-white/10 text-lg">
          <span className={revealed ? "identity-clear" : "identity-blur"}>{item.avatar_emoji || "🌙"}</span>
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
function MatchesScreen({ user, unreadMatches, onTab, onOpenChat, onLoaded }) {
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

      <BottomNav active="matches" onTab={onTab} userPicture={user?.picture} unreadCount={unreadMatches} />
    </motion.div>
  );
}

// ---------- Chat ----------
function ChatScreen({ me, match, onBack }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // Live translate-as-you-type preview toggle (off by default; persisted).
  const [previewOn, setPreviewOn] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("n2m_chat_preview") === "1";
  });
  const [preview, setPreview] = useState({ translating: false, text: "" });
  const previewDebounceRef = useRef(null);
  const previewSeqRef = useRef(0);
  const scrollRef = useRef(null);

  const myLang = me?.language || "en";
  const theirLang = match?.user?.language || "en";
  const needsTranslation = previewOn && theirLang && theirLang !== myLang;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/messages/${match.match_id}`);
      setMessages(data.messages);
    } finally { setLoading(false); }
  }, [match.match_id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 99999, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.post("/messages", { match_id: match.match_id, text: text.trim() });
      track("chat_message_sent", { length: text.trim().length, preview_used: previewOn });
      setText("");
      setPreview({ translating: false, text: "" });
      await load();
    } catch {
      toast.error("Send failed");
    } finally { setSending(false); }
  };

  // Live translate-as-you-type — debounced 400ms, race-safe via seq counter.
  useEffect(() => {
    if (!needsTranslation) {
      setPreview({ translating: false, text: "" });
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setPreview({ translating: false, text: "" });
      return;
    }
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    setPreview((p) => ({ ...p, translating: true }));
    const seq = ++previewSeqRef.current;
    previewDebounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post("/translate", {
          text: trimmed,
          target_lang: theirLang,
          source_lang: myLang,
        });
        if (seq === previewSeqRef.current) {
          setPreview({ translating: false, text: data.translation || data.translated || "" });
        }
      } catch (err) {
        if (seq === previewSeqRef.current) {
          setPreview({ translating: false, text: "" });
        }
      }
    }, 400);
    return () => previewDebounceRef.current && clearTimeout(previewDebounceRef.current);
  }, [text, needsTranslation, theirLang, myLang]);

  const togglePreview = () => {
    setPreviewOn((on) => {
      const next = !on;
      if (typeof window !== "undefined") {
        localStorage.setItem("n2m_chat_preview", next ? "1" : "0");
      }
      track("chat_preview_toggled", { on: next });
      return next;
    });
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
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold leading-none truncate">@{match.user.handle || match.user.codename}</div>
          <div className="text-[10px] text-white/45 mt-1 uppercase tracking-widest font-bold">Matched · live</div>
        </div>
        {theirLang && theirLang !== myLang && (
          <button
            onClick={togglePreview}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition ${
              previewOn ? "bg-[#00E5FF]/20 text-[#00E5FF] ring-1 ring-[#00E5FF]/50" : "glass-dark text-white/55 hover:text-white"
            }`}
            data-testid="chat-preview-toggle"
            title={previewOn ? "Live translation preview ON" : "Live translation preview OFF"}
          >
            <Languages size={12} />
            <span>{previewOn ? "preview" : "preview"}</span>
            <span className={`text-[8px] ${previewOn ? "text-[#00E5FF]" : "text-white/40"}`}>{previewOn ? "ON" : "OFF"}</span>
          </button>
        )}
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

      <div className="p-3 pb-14 border-t border-white/8 relative z-40 bg-background">
        {needsTranslation && text.trim().length >= 2 && (
          <div
            className="mb-2 rounded-2xl bg-[#00E5FF]/8 border border-[#00E5FF]/25 px-3 py-2 flex items-start gap-2"
            data-testid="chat-preview-pill"
          >
            <Languages size={12} className="text-[#00E5FF] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[9px] uppercase tracking-widest font-bold text-[#00E5FF]/85 mb-0.5">
                they'll read · {myLang.toUpperCase()} → {theirLang.toUpperCase()}
              </div>
              {preview.translating && !preview.text ? (
                <div className="text-xs text-white/45 italic">translating…</div>
              ) : (
                <div className="text-sm text-white/90 leading-snug break-words">
                  {preview.text || <span className="text-white/35 italic">…</span>}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex gap-2">
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
    const result = await shareOrCopy({
      title: "Nice2Meechu", text: shareText, url: shareUrl, copyText: shareUrl,
    });
    if (result === "shared") {
      track("share_started", { method: "web_share_api" });
    } else if (result === "copied") {
      track("share_started", { method: "clipboard_fallback" });
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error("Couldn't share — copy from the link below");
    }
  };

  const onCopy = async () => {
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      track("referral_link_copied");
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error("Couldn't copy");
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
function ProfileScreen({ user, setUser, unreadMatches, onTab, onLogout, onChangeVideo }) {
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

  // Mobile keyboards bury the Save button under the keyboard — let Enter
  // submit the form from any of the text inputs, same shortcut as onboarding.
  const onEnterSave = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!saving && canSave) save();
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

              <div className="mt-4 pt-4 border-t border-white/8 flex flex-col gap-2 text-xs text-white/55">
                <div className="flex gap-3 justify-center">
                  <a href="/privacy" className="hover:text-white underline" data-testid="profile-privacy-link">Privacy</a>
                  <span className="text-white/20">·</span>
                  <a href="/terms" className="hover:text-white underline" data-testid="profile-terms-link">Terms</a>
                  <span className="text-white/20">·</span>
                  <a href={SAFETY_CONTACT_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white underline" data-testid="profile-safety-link">Report safety</a>
                </div>
                <button
                  className="text-white/70 hover:text-white text-xs underline mt-1"
                  onClick={async () => {
                    // GDPR Art. 20 — give the user a full JSON dump.
                    try {
                      track("data_export_requested");
                      const { data } = await api.get("/users/me/export");
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `nice2meechu-data-${data.exported_for_user_id}-${data.exported_at.slice(0, 10)}.json`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                      toast.success("Your data was downloaded");
                    } catch (err) {
                      console.error(err);
                      toast.error("Couldn't export — please submit our privacy form instead");
                    }
                  }}
                  data-testid="profile-data-export"
                >
                  Download my data
                </button>
                <button
                  className="text-[#FF4D4D]/80 hover:text-[#FF4D4D] text-xs underline mt-1"
                  onClick={async () => {
                    const ok = window.confirm(
                      "Delete your account? This permanently removes your profile, intro video, matches, and chat messages. This cannot be undone."
                    );
                    if (!ok) return;
                    try {
                      await api.delete("/users/me");
                      toast.success("Account deleted");
                      localStorage.removeItem("n2m_token");
                      setTimeout(() => { window.location.href = "/"; }, 500);
                    } catch (e) {
                      toast.error("Couldn't delete account — please submit our privacy form instead");
                    }
                  }}
                  data-testid="profile-delete-account"
                >
                  Delete my account
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
                  onKeyDown={onEnterSave}
                  enterKeyHint="done"
                  data-testid="profile-firstname-input"
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-white/55 mb-1">City</p>
                <CityAutocomplete
                  value={city}
                  onChange={(v) => { setCity(v); setCityCoords(null); }}
                  onPick={(item) => { setCity(item.value || ""); setCityCoords({ lat: item.lat, lng: item.lng }); }}
                  biasLat={user.city_lat || user.lat}
                  biasLng={user.city_lng || user.lng}
                  onEnter={() => { if (!saving && canSave) save(); }}
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
                  onKeyDown={onEnterSave}
                  enterKeyHint="done"
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

      <BottomNav active="profile" onTab={onTab} userPicture={user?.picture} unreadCount={unreadMatches} />
    </motion.div>
  );
}

// ---------- Bottom Nav ----------
function BottomNav({ active, onTab, userPicture, unreadCount = 0 }) {
  const hasUnread = unreadCount > 0;
  const Item = ({ id, icon: Icon, label }) => {
    const isYouTabWithPic = id === "profile" && userPicture;
    const showDotHere = id === "profile" && hasUnread;
    return (
      <button
        onClick={() => onTab(id)}
        className="flex flex-col items-center gap-1 flex-1 py-2"
        data-testid={`nav-${id}`}
      >
        <div className="relative">
          {isYouTabWithPic ? (
            // Google profile picture as the "You" tab affordance — ringed when active.
            // referrerPolicy avoids Google CDN blocking the request from our origin.
            <img
              src={userPicture}
              alt=""
              referrerPolicy="no-referrer"
              data-testid="nav-profile-avatar"
              className={`w-[26px] h-[26px] rounded-full object-cover ${
                active === id ? "ring-2 ring-[#FF4D4D] ring-offset-2 ring-offset-black" : "opacity-70"
              }`}
            />
          ) : (
            <Icon size={22} color={active === id ? "#FF4D4D" : "rgba(255,255,255,0.6)"} fill={active === id && id === "feed" ? "#FF4D4D" : "transparent"} />
          )}
          {showDotHere && (
            <span
              data-testid="nav-profile-unread-dot"
              aria-label={`${unreadCount} new match${unreadCount === 1 ? "" : "es"}`}
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#22C55E] ring-2 ring-black animate-pulse"
            />
          )}
        </div>
        <span className={`text-[10px] uppercase tracking-widest font-bold ${active === id ? "text-white" : "text-white/45"}`}>{label}</span>
      </button>
    );
  };
  return (
    <div className="absolute bottom-0 left-0 right-0 z-40 glass-dark border-t border-white/8 flex pb-10 pt-1 px-4" data-testid="bottom-nav">
      <Item id="feed" icon={VideoIcon} label="Feed" />
      <Item id="matches" icon={Heart} label="Matches" />
      <Item id="profile" icon={UserIcon} label="You" />
    </div>
  );
}
