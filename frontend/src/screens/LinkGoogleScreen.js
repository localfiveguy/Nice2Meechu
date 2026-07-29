import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { api } from "../lib/api";
import { GOOGLE_CLIENT_ID } from "../lib/constants";
import { isIosWebkit } from "../lib/ua";
import { track } from "../analytics";

// Shown right after an Apple "Hide My Email" sign-in creates a brand-new
// account: offer to link an existing Google account so the user keeps their
// video and matches instead of ending up with a duplicate. Skipping simply
// continues onboarding as a new user.
// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
export default function LinkGoogleScreen({ onLinked, onSkip }) {
  const btnRef = useRef(null);
  const [gisError, setGisError] = useState(null);

  const handleCredential = useCallback(async (response) => {
    track("apple_link_google_started");
    try {
      const { data } = await api.post("/auth/link-google", { credential: response.credential });
      if (data.token) localStorage.setItem("n2m_token", data.token);
      sessionStorage.removeItem("n2m_link_token");
      track("apple_link_google_completed");
      toast.success("Accounts linked — welcome back!");
      onLinked?.();
    } catch (err) {
      console.error("account linking failed", err);
      track("apple_link_google_failed", { status: err?.response?.status });
      if (err?.response?.status === 404) {
        toast("No account found for that Google — continuing as new.");
        onSkip?.();
        return;
      }
      const detail = err?.response?.data?.detail;
      toast.error(detail || "Linking failed — you can continue as new.");
    }
  }, [onLinked, onSkip]);

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
        // iOS Safari blocks popup OAuth (ITP) — use redirect mode carrying
        // the one-time link token; the backend performs the merge during the
        // redirect (/api/auth/google-redirect?link=...). Desktop/Android use
        // the popup callback → POST /auth/link-google.
        const linkToken = sessionStorage.getItem("n2m_link_token") || "";
        gis.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredential,
          ux_mode: isIosWebkit() ? "redirect" : "popup",
          login_uri: `${window.location.origin}/api/auth/google-redirect?link=${encodeURIComponent(linkToken)}`,
          auto_select: false,
          itp_support: true,
        });
        if (btnRef.current) {
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
        setGisError("Google unavailable right now — you can continue as new.");
      }
    };
    tryInit();
    return () => { cancelled = true; };
  }, [handleCredential]);

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-7 pt-16 pb-10 bg-grain"
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid="link-google-screen"
    >
      <div className="w-11 h-11 rounded-2xl bg-[#00E5FF]/15 flex items-center justify-center">
        <Link2 size={20} className="text-[#00E5FF]" />
      </div>
      <h1 className="mt-5 font-display text-3xl font-black leading-tight tracking-tight">
        One account,
        <br />all your stuff<span style={{ color: "#FF4D4D" }}>.</span>
      </h1>
      <p className="mt-4 text-sm text-white/60 font-medium leading-relaxed max-w-[300px]">
        You hid your email, so we couldn't find you. Used Nice2Meechu with{" "}
        <span className="text-white font-semibold">Google</span> before? Link it now to
        keep your video and matches — no duplicate accounts.
      </p>

      <div className="mt-auto flex flex-col items-center gap-4">
        <div
          ref={btnRef}
          className="flex justify-center"
          data-testid="link-google-button"
          style={{ colorScheme: "light" }}
        />
        {gisError && (
          <p className="text-center text-xs text-red-400" data-testid="link-google-error">
            {gisError}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            track("apple_link_google_skipped");
            sessionStorage.removeItem("n2m_link_token");
            onSkip?.();
          }}
          className="text-sm text-white/50 underline underline-offset-4 hover:text-white transition"
          data-testid="link-google-skip"
        >
          I'm new here — continue
        </button>
      </div>
    </motion.div>
  );
}
