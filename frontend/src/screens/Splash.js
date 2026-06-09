import React from "react";
import { motion } from "framer-motion";

export function Splash() {
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
          Meet the world. Video-first. Anonymous until the spark.
        </p>
      </div>
    </motion.div>
  );
}
