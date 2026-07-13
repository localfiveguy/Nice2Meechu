import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Apple } from "lucide-react";
import { api } from "../lib/api";
import { APPLE_SERVICE_ID } from "../lib/constants";
import { track } from "../analytics";

const APPLE_JS_SRC =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

function loadAppleScript() {
  return new Promise((resolve, reject) => {
    if (window.AppleID?.auth) return resolve();
    let script = document.querySelector(`script[src="${APPLE_JS_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = APPLE_JS_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", reject, { once: true });
  });
}

// Sign in with Apple — required by App Store review because the app offers
// Google login. Uses Apple's JS SDK popup flow; the identity token is
// verified server-side at POST /api/auth/apple. Renders nothing until
// REACT_APP_APPLE_SERVICE_ID is configured.
export function AppleSignInButton() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!APPLE_SERVICE_ID) return;
    let cancelled = false;
    loadAppleScript()
      .then(() => {
        if (cancelled) return;
        window.AppleID.auth.init({
          clientId: APPLE_SERVICE_ID,
          scope: "name email",
          redirectURI: `${window.location.origin}/`,
          usePopup: true,
        });
        setReady(true);
      })
      .catch((e) => console.error("Apple JS SDK failed to load", e));
    return () => { cancelled = true; };
  }, []);

  const handleClick = useCallback(async () => {
    track("sign_in_started", { method: "apple" });
    let res;
    try {
      res = await window.AppleID.auth.signIn();
    } catch (err) {
      // User closed the popup — not an error worth toasting about.
      const code = err?.error;
      if (code === "popup_closed_by_user" || code === "user_cancelled_authorize") return;
      console.error("apple popup failed", err);
      track("sign_in_failed", { method: "apple", stage: "popup" });
      toast.error("Apple sign-in couldn't start. Try again.");
      return;
    }
    try {
      const idToken = res?.authorization?.id_token;
      // Apple only sends the user's name on the very first authorization.
      const n = res?.user?.name;
      const name = n ? `${n.firstName || ""} ${n.lastName || ""}`.trim() : undefined;
      const ref = localStorage.getItem("n2m_ref") || undefined;
      const { data } = await api.post("/auth/apple", { id_token: idToken, name, ref });
      if (data.token) localStorage.setItem("n2m_token", data.token);
      localStorage.removeItem("n2m_ref");
      track("sign_in_completed", { method: "apple", onboarded: !!data.onboarded, referred: !!ref });
      window.location.reload();
    } catch (err) {
      console.error("apple sign-in failed", err);
      track("sign_in_failed", { method: "apple", stage: "verify" });
      const detail = err?.response?.data?.detail;
      toast.error(detail ? `Apple sign-in failed: ${detail}` : "Apple sign-in failed. Try again.");
    }
  }, []);

  if (!APPLE_SERVICE_ID || !ready) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center justify-center gap-2 rounded-full bg-black text-white font-semibold text-sm border border-white/25 hover:border-white/50 active:scale-[0.98] transition"
      style={{ width: 280, height: 40 }}
      data-testid="signin-apple-button"
    >
      <Apple size={16} className="-mt-0.5" />
      Continue with Apple
    </button>
  );
}
