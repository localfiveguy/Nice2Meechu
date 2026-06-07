import React, { useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { api } from "../lib/api";
import { COMMUNITY_RULES } from "../lib/constants";
import { SignaturePad } from "../components/SignaturePad";
import { track } from "../analytics";

export function CommunityRulesScreen({ onDone }) {
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
