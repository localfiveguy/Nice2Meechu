import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Share, Plus, CheckCircle2 } from "lucide-react";
import { track } from "../analytics";

/**
 * Bottom-sheet modal that walks an iPhone user through Safari's
 * "Add to Home Screen" flow. Apple doesn't expose any programmatic install
 * prompt the way Chrome's `beforeinstallprompt` does, so a visual walkthrough
 * is the only real option.
 *
 * The modal is platform-agnostic — even Android/desktop users may open it
 * (we removed UA gating after that approach proved fragile). Non-iOS users
 * will still see useful instructions for installing the PWA in their own
 * browser if they want to.
 */
export function IOSInstallSheet({ open, onClose }) {
  useEffect(() => {
    if (open) track("ios_install_sheet_opened");
  }, [open]);

  // ESC closes on desktop.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-testid="ios-install-sheet"
        >
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
            data-testid="ios-install-sheet-backdrop"
          />

          {/* Sheet */}
          <motion.div
            className="relative w-full max-w-md mx-auto rounded-t-3xl border-t border-x border-white/10 bg-[#0a0a0a] px-6 pt-5 pb-8 z-10 shadow-2xl"
            initial={{ y: 60 }}
            animate={{ y: 0 }}
            exit={{ y: 80 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest font-bold text-[#5BE6C8]">
                  Install on iPhone
                </div>
                <h3 className="font-display text-2xl font-black leading-tight mt-1">
                  Add Nice2Meechu<br />to your Home Screen
                </h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-white/55 hover:text-white p-1 -m-1"
                aria-label="Close"
                data-testid="ios-install-sheet-close"
              >
                <X size={22} />
              </button>
            </div>

            <p className="mt-3 text-sm text-white/65 leading-relaxed">
              Apple doesn't allow a one-tap install — but Safari has a built-in
              way to make Nice2Meechu act like a full app on your iPhone, with
              its own icon, no browser bar, and instant launch.
            </p>

            <ol className="mt-5 space-y-4">
              <Step
                n="1"
                icon={<Share size={18} className="text-white" strokeWidth={2.4} />}
                title="Tap the Share button"
                body="In Safari's bottom toolbar — the square with an arrow pointing up."
              />
              <Step
                n="2"
                icon={<Plus size={18} className="text-white" strokeWidth={2.4} />}
                title='Choose "Add to Home Screen"'
                body="Scroll down the share menu if you don't see it right away."
              />
              <Step
                n="3"
                icon={<CheckCircle2 size={18} className="text-[#5BE6C8]" strokeWidth={2.4} />}
                title="Tap Add"
                body="The Nice2Meechu heart icon will appear on your Home Screen. Open it from there for the full-screen app experience."
              />
            </ol>

            <div className="mt-6 rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-xs text-white/55 leading-relaxed">
              <span className="text-white/80 font-semibold">Heads up:</span> only Safari can install
              it. If you're reading this in Chrome, Firefox, or an in-app browser
              (Instagram, Facebook, TikTok…), open <span className="font-mono text-white/80">nice2meechu.com</span> in
              Safari first.
            </div>

            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full btn-primary"
              data-testid="ios-install-sheet-got-it"
            >
              Got it
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Step({ n, icon, title, body }) {
  return (
    <li className="flex gap-3">
      <div className="shrink-0 w-9 h-9 rounded-full bg-white/8 border border-white/10 flex items-center justify-center font-display font-black text-white/80">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-white font-semibold text-sm">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-white/10 border border-white/10">
            {icon}
          </span>
          {title}
        </div>
        <p className="text-xs text-white/60 mt-1 leading-relaxed">{body}</p>
      </div>
    </li>
  );
}
