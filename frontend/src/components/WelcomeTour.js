import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PlayCircle, Heart, MapPin } from "lucide-react";

const STEPS = [
  {
    icon: PlayCircle,
    title: "Meet people through video",
    body: "Real intros from people in your town. Tap a video to hear them — swipe up for the next person.",
  },
  {
    icon: Heart,
    title: "Like to match",
    body: "Tap the heart when you'd like to meet someone. If they like you back, it's a match — and the chat opens.",
  },
  {
    icon: MapPin,
    title: "Your town, your feed",
    body: "Your video only appears in your home town. Tap the city name up top any time to explore other places.",
  },
];

// One-time 3-step overlay for brand-new accounts (users without
// welcome_tour_done). Parent persists the flag via onDone.
export function WelcomeTour({ onDone }) {
  const [step, setStep] = useState(0);
  const { icon: Icon, title, body } = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center px-8 bg-black/85 backdrop-blur-md"
      data-testid="welcome-tour"
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          className="flex flex-col items-center text-center"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.25 }}
        >
          <div className="w-16 h-16 rounded-3xl bg-[#00E5FF]/15 flex items-center justify-center">
            <Icon size={30} className="text-[#00E5FF]" />
          </div>
          <h2 className="mt-6 font-display text-2xl font-black leading-tight text-white" data-testid="welcome-tour-title">
            {title}
          </h2>
          <p className="mt-3 text-sm text-white/60 font-medium leading-relaxed max-w-[280px]">
            {body}
          </p>
        </motion.div>
      </AnimatePresence>

      <div className="mt-8 flex gap-2" data-testid="welcome-tour-dots">
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-[#00E5FF]" : "w-1.5 bg-white/25"}`}
          />
        ))}
      </div>

      <button
        onClick={() => (last ? onDone() : setStep(step + 1))}
        className="mt-8 px-10 py-3.5 rounded-full bg-[#FF4D4D] text-white text-sm font-black tracking-wide transition active:scale-95 hover:brightness-110"
        data-testid="welcome-tour-next"
      >
        {last ? "Start exploring" : "Next"}
      </button>
      <button
        onClick={onDone}
        className="mt-4 text-xs text-white/40 underline underline-offset-4 hover:text-white/70 transition"
        data-testid="welcome-tour-skip"
      >
        Skip tour
      </button>
    </div>
  );
}
