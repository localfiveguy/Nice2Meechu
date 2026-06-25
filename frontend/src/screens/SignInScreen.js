import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Download, Share2 } from "lucide-react";
import { api, shareOrCopy } from "../lib/api";
import { GOOGLE_CLIENT_ID } from "../lib/constants";
import { isAndroid, isIosWebkit } from "../lib/ua";
import { track } from "../analytics";

// ---------- Google Sign-In (Direct Google Identity Services / GIS) ----------
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
export function SignInScreen() {
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
        Meet the world. Video-first. Anonymous until the spark.
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
        {isAndroid() ? (
          <a
            href="/nice2meechu.apk"
            onClick={() => track("apk_install_click", { surface: "signin" })}
            className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/70 hover:text-white border border-white/10 hover:border-white/25 active:scale-95 transition no-underline"
            data-testid="signin-install-apk"
          >
            <Download size={11} className="text-[#5BE6C8]" />
            <span>Install Android app · 1.6&nbsp;MB</span>
          </a>
        ) : null}
      </div>

      {/* Pre-signup share pill — mirrors the placement of the bottom-nav
          share button on authenticated screens (bottom-left), and visually
          balances the DemoPeekWidget pinned to the bottom-right. Pre-signup
          users have no handle yet, so the link is plain nice2meechu.com (no
          referral attribution) — once they sign in, the authenticated nav
          version automatically attributes referrals to their handle. */}
      <button
        type="button"
        onClick={async () => {
          track("share_app_button_tapped", { from: "signin_screen" });
          const shareText = "Come meet the world at Nice2meechu.com";
          const result = await shareOrCopy({
            title: "Nice2Meechu",
            text: shareText,
            copyText: shareText,
          });
          if (result === "copied") toast.success("Invite copied!");
          else if (result === "failed") toast.error("Couldn't share — copy manually: Nice2meechu.com");
        }}
        className="fixed bottom-5 left-5 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold text-white/65 hover:text-white border border-white/10 hover:border-white/25 active:scale-95 transition bg-black/45 backdrop-blur-md"
        data-testid="signin-share-pill"
        aria-label="Share Nice2Meechu with a friend"
      >
        <Share2 size={11} className="text-[#FF4D4D]" />
        <span>Share this app</span>
      </button>
    </motion.div>
  );
}
