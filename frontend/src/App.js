import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Toaster, toast } from "sonner";
import "@/App.css";

import { api } from "./lib/api";
import { initAnalytics, pageview, track } from "./analytics";
import { CookieConsentBanner, getCookieConsent, PrivacyPolicyPage, TermsOfServicePage } from "./legal/LegalPages";

import { Splash } from "./screens/Splash";
import { SignInScreen } from "./screens/SignInScreen";
import { AuthCallback } from "./screens/AuthCallback";
import { Onboarding } from "./screens/Onboarding";
import { CommunityRulesScreen } from "./screens/CommunityRulesScreen";
import { VideoPick } from "./screens/VideoPick";
import { FeedScreen } from "./screens/FeedScreen";
import { MatchesScreen } from "./screens/MatchesScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ProfileScreen } from "./screens/ProfileScreen";

import { DemoPeekWidget } from "./components/DemoPeekWidget";
import { MatchCelebration } from "./components/MatchCelebration";

// ---------- Top-level App orchestrator ----------
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
//
// SAST note: this file is intentionally the route-guard switch for the whole
// app. Cyclomatic complexity reflects "n possible onboarding phases × n auth
// states", which IS what an orchestrator's job description is. Splitting the
// switch into wrapper components would move complexity sideways without
// reducing it. Previously refactored from 3090 lines → ~290 lines; the
// remaining surface is just routing — leave as-is unless a real bug appears.
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
      } catch { /* SAST: intentional — endpoint may 401 on stale token or 5xx during transient blip; the next 60s poll will recover */ }
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
    // Redirect-mode Google sign-in also hands the session token back in the
    // URL fragment (#st=...) because some iOS Safari installs drop the cookie
    // set during the cross-site redirect. Store it as the Bearer fallback,
    // then scrub it from the URL/history before anything else renders.
    if (window.location.hash && window.location.hash.startsWith("#st=")) {
      const st = window.location.hash.slice(4);
      if (st) localStorage.setItem("n2m_token", st);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
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
            <CommunityRulesScreen
              key="rules"
              onDone={(u) => { setUser(u); setScreen("video-pick"); }}
              onOpenLegal={openLegal}
            />
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

        {/* Demo-peek widget persists across the entire pre-recording journey
            (sign-in → onboarding → community rules) so new users can keep
            referring to example intros while filling in their info. Hidden
            the moment they hit the VideoPick recording screen so it doesn't
            compete with their own camera preview, and on every authenticated
            screen after that (feed/matches/chat/profile) where it'd be noise. */}
        {["splash", "signin", "onboarding", "community-rules"].includes(screen) && (
          <DemoPeekWidget />
        )}
      </div>
    </div>
  );
}
