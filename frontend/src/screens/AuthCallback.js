import React from "react";
import { motion } from "framer-motion";

export function AuthCallback() {
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
