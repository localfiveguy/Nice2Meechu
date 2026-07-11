import React, { useState } from "react";
import { toast } from "sonner";
import { Bell, BellOff } from "lucide-react";
import { disablePush, enablePush, pushBlockedNeedsInstall, pushSupported } from "../lib/push";
import { track } from "../analytics";

// Opt-in toggle for "notify me when someone new joins nearby" web push.
// variant="pill" (feed empty state) | "row" (profile settings row).
export function NotifyMeButton({ user, setUser, variant = "pill" }) {
  const [busy, setBusy] = useState(false);
  const enabled = !!user?.notify_new_nearby;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setUser?.({ ...user, notify_new_nearby: false });
        track("push_disabled");
        toast("Notifications off", { duration: 1500 });
      } else {
        await enablePush();
        setUser?.({ ...user, notify_new_nearby: true });
        track("push_enabled");
        toast.success("You'll be notified when someone new joins nearby");
      }
    } catch (e) {
      if (e?.message === "needs-install") {
        toast.error("Install the app to your home screen first (Share → Add to Home Screen), then enable notifications.");
      } else if (e?.message === "denied") {
        toast.error("Notifications are blocked — allow them in your browser settings.");
      } else if (e?.message === "unsupported" || !pushSupported()) {
        toast.error("This browser doesn't support notifications.");
      } else {
        toast.error("Couldn't update notifications — try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (variant === "row") {
    return (
      <button
        type="button"
        className="mt-2 w-full flex items-center justify-between gap-3 rounded-full px-4 py-3 bg-white/8 hover:bg-white/12 border border-white/10 transition-colors"
        onClick={toggle}
        disabled={busy}
        data-testid="notify-me-toggle"
      >
        <div className="flex items-center gap-2">
          {enabled ? <Bell size={16} className="text-[#5BE6C8]" /> : <BellOff size={16} className="text-white/60" />}
          <div className="text-sm font-semibold text-white text-left">Notify when someone joins nearby</div>
        </div>
        <div className={`text-[10px] uppercase tracking-widest font-bold ${enabled ? "text-[#5BE6C8]" : "text-white/45"}`}>
          {busy ? "…" : enabled ? "On" : "Off"}
        </div>
      </button>
    );
  }

  return (
    <button
      className="btn-ghost flex items-center gap-2 mt-1"
      onClick={toggle}
      disabled={busy}
      data-testid="notify-me-btn"
    >
      {enabled ? <Bell size={16} className="text-[#5BE6C8]" /> : <Bell size={16} />}
      {busy ? "One sec…" : enabled ? "Notifications on ✓" : "Notify me when someone joins"}
    </button>
  );
}
