import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { ArrowLeft, Languages, Send } from "lucide-react";
import { api } from "../lib/api";
import { VideoEl } from "../components/VideoEl";
import { track } from "../analytics";

export function ChatScreen({ me, match, onBack }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // Live translate-as-you-type preview toggle (off by default; persisted).
  const [previewOn, setPreviewOn] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("n2m_chat_preview") === "1";
  });
  const [preview, setPreview] = useState({ translating: false, text: "" });
  const previewDebounceRef = useRef(null);
  const previewSeqRef = useRef(0);
  const scrollRef = useRef(null);

  const myLang = me?.language || "en";
  const theirLang = match?.user?.language || "en";
  const needsTranslation = previewOn && theirLang && theirLang !== myLang;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/messages/${match.match_id}`);
      setMessages(data.messages);
    } finally { setLoading(false); }
  }, [match.match_id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 99999, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.post("/messages", { match_id: match.match_id, text: text.trim() });
      track("chat_message_sent", { length: text.trim().length, preview_used: previewOn });
      setText("");
      setPreview({ translating: false, text: "" });
      await load();
    } catch {
      toast.error("Send failed");
    } finally { setSending(false); }
  };

  // Live translate-as-you-type — debounced 400ms, race-safe via seq counter.
  useEffect(() => {
    if (!needsTranslation) {
      setPreview({ translating: false, text: "" });
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setPreview({ translating: false, text: "" });
      return;
    }
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    setPreview((p) => ({ ...p, translating: true }));
    const seq = ++previewSeqRef.current;
    previewDebounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post("/translate", {
          text: trimmed,
          target_lang: theirLang,
          source_lang: myLang,
        });
        if (seq === previewSeqRef.current) {
          setPreview({ translating: false, text: data.translation || data.translated || "" });
        }
      } catch (err) {
        if (seq === previewSeqRef.current) {
          setPreview({ translating: false, text: "" });
        }
      }
    }, 400);
    return () => previewDebounceRef.current && clearTimeout(previewDebounceRef.current);
  }, [text, needsTranslation, theirLang, myLang]);

  const togglePreview = () => {
    setPreviewOn((on) => {
      const next = !on;
      if (typeof window !== "undefined") {
        localStorage.setItem("n2m_chat_preview", next ? "1" : "0");
      }
      track("chat_preview_toggled", { on: next });
      return next;
    });
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-grain"
      initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
      data-testid="chat-screen"
    >
      {/* header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4 border-b border-white/8">
        <button onClick={onBack} className="text-white/70" data-testid="chat-back">
          <ArrowLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-full overflow-hidden bg-black ring-1 ring-white/10">
          <VideoEl src={match.user.video_url} autoPlay loop muted playsInline className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold leading-none truncate">@{match.user.handle || match.user.codename}</div>
          <div className="text-[10px] text-white/45 mt-1 uppercase tracking-widest font-bold">Matched · live</div>
        </div>
        {theirLang && theirLang !== myLang && (
          <button
            onClick={togglePreview}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] uppercase tracking-widest font-bold transition ${
              previewOn ? "bg-[#00E5FF]/20 text-[#00E5FF] ring-1 ring-[#00E5FF]/50" : "glass-dark text-white/55 hover:text-white"
            }`}
            data-testid="chat-preview-toggle"
            title={previewOn ? "Live translation preview ON" : "Live translation preview OFF"}
          >
            <Languages size={12} />
            <span>{previewOn ? "preview" : "preview"}</span>
            <span className={`text-[8px] ${previewOn ? "text-[#00E5FF]" : "text-white/40"}`}>{previewOn ? "ON" : "OFF"}</span>
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2 no-scrollbar">
        {loading && <div className="text-center text-xs text-white/40">…</div>}
        {messages.length === 0 && !loading && (
          <div className="text-center text-xs text-white/40 mt-10">Say hi! Translation is automatic.</div>
        )}
        {messages.map((m) => {
          const mine = m.from_user_id === me.id;
          const hasTranslation = !mine && m.translated_text && m.translated_text !== m.text;
          return (
            <div
              key={m.id}
              className={`max-w-[78%] flex flex-col gap-1 ${mine ? "self-end items-end" : "self-start items-start"}`}
              data-testid={`chat-msg-${m.id}`}
            >
              <div
                className={`px-4 py-2.5 rounded-2xl text-[15px] font-medium leading-snug ${mine ? "bg-[#FF4D4D] text-white rounded-br-md" : "bg-white/10 text-white rounded-bl-md"}`}
              >
                {hasTranslation ? m.translated_text : m.text}
              </div>
              {hasTranslation && (
                <div
                  className="px-3 py-1 rounded-xl bg-white/4 border border-white/8 flex flex-col gap-0.5"
                  data-testid={`chat-msg-original-${m.id}`}
                >
                  <span className="inline-flex w-fit items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[#00E5FF]">
                    <Languages size={9} /> {m.source_lang}→{me.language || "en"}
                  </span>
                  <span className="text-[11px] italic text-white/50 leading-tight">{m.text}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 pb-14 border-t border-white/8 relative z-40 bg-background">
        {needsTranslation && text.trim().length >= 2 && (
          <div
            className="mb-2 rounded-2xl bg-[#00E5FF]/8 border border-[#00E5FF]/25 px-3 py-2 flex items-start gap-2"
            data-testid="chat-preview-pill"
          >
            <Languages size={12} className="text-[#00E5FF] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[9px] uppercase tracking-widest font-bold text-[#00E5FF]/85 mb-0.5">
                they'll read · {myLang.toUpperCase()} → {theirLang.toUpperCase()}
              </div>
              {preview.translating && !preview.text ? (
                <div className="text-xs text-white/45 italic">translating…</div>
              ) : (
                <div className="text-sm text-white/90 leading-snug break-words">
                  {preview.text || <span className="text-white/35 italic">…</span>}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <input
            className="n2m-input flex-1"
            placeholder="say something nice…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            enterKeyHint="send"
            data-testid="chat-input"
          />
          <button
            className="btn-icon"
            style={{ width: 52, height: 52, background: "linear-gradient(180deg,#FF6B6B,#FF3D3D)" }}
            onClick={send}
            disabled={sending}
            data-testid="chat-send-button"
          >
            <Send size={18} fill="white" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
