import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Camera, Pause, X } from "lucide-react";
import { api } from "../lib/api";
import { SAFETY_CONTACT_URL } from "../legal/LegalPages";
import { track } from "../analytics";

export function VideoPick({ user, onDone, onSkip }) {
  const [loading, setLoading] = useState(false);
  // null | 'verifying' | 'saving'  → drives the button label so users know the
  // AI is actively reviewing their video (builds trust in the safety promise)
  const [phase, setPhase] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  // State (not just the ref) so the preview re-renders once the camera stream
  // is live — the <video> ref-callback then attaches srcObject reliably.
  const [streamReady, setStreamReady] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);   // live countdown shown over the camera
  const recorderRef = useRef(null);
  const countdownRef = useRef(null);
  const [rejectReason, setRejectReason] = useState(null);
  const MAX_SECONDS = 7;

  const firstName = user?.first_name || "there";
  const city = user?.city || "your city";
  // Dynamic script — pulls in entered name + city
  const scriptText = `"Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!"`;
  const scriptTranscript = `Hello, my name is ${firstName}, and I live in ${city}. Nice to meet you!`;

  // Extract a single JPEG frame from the recorded blob via off-screen video + canvas.
  // Returns base64 (without the data: prefix) for the backend face-check.
  const captureFrameBase64 = (blob) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => {
      // seek slightly past the start so we don't grab a black frame
      try { v.currentTime = Math.min(0.6, (v.duration || 1) / 2); } catch (err) { console.warn("video seek failed", err); }
    };
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = Math.min(640, v.videoWidth || 480);
        c.height = Math.round(c.width * ((v.videoHeight || 360) / (v.videoWidth || 640)));
        const ctx = c.getContext("2d");
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL("image/jpeg", 0.72);
        URL.revokeObjectURL(url);
        resolve(dataUrl.split(",", 2)[1]);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    v.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
  });

  const save = async () => {
    setRejectReason(null);
    if (!recordedBlob) {
      toast.error("Record your intro first");
      return;
    }
    setLoading(true);
    try {
      // AI face / safety check on a captured frame BEFORE we accept the video
      setPhase("verifying");
      try {
        const b64 = await captureFrameBase64(recordedBlob);
        const { data: check } = await api.post("/video/face-check", { image_base64: b64 });
        track("face_check_done", { ok: !!check.ok });
        if (!check.ok) {
          const why = check.reason || "Please record a clearer video of just your face.";
          setRejectReason(why);
          setLoading(false);
          setPhase(null);
          return;
        }
      } catch (err) {
        console.error("face check error", err);
        // Fail-open — if we can't extract a frame, allow save (rare)
      }

      setPhase("saving");
      // Persist the recording to the backend so the URL survives tab close.
      // (Previously we used URL.createObjectURL(blob), which is in-memory and
      // dies when the tab/browser closes — the user effectively lost their
      // intro on every return visit.)
      const ext = (recordedBlob.type || "").includes("mp4") ? "mp4" : "webm";
      const form = new FormData();
      form.append("file", recordedBlob, `intro.${ext}`);
      const { data: up } = await api.post("/users/video/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      await api.post("/users/video", {
        video_url: up.video_url,
        transcript: scriptTranscript,
        source_lang: (user?.language || "en"),
      });
      track("video_intro_set", { source: "recorded" });
      const me = await api.get("/users/me");
      onDone(me.data.user);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 422 && detail) {
        setRejectReason(detail);
        track("video_upload_rejected", { reason: "silent_audio" });
      } else {
        toast.error("Couldn't save your intro");
      }
    } finally {
      setLoading(false);
      setPhase(null);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;
      setStreamReady(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // play() returns a Promise that REJECTS with AbortError if a new
        // load/srcObject swap happens before the first frame paints. Swallow
        // it — it's harmless but trips the dev-mode error overlay.
        videoRef.current.play().catch(() => {});
      }
    } catch {
      toast.error("Camera permission is needed to record your intro. Please enable it in your browser settings.");
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // iOS Safari's MediaRecorder cannot produce webm — it records H.264 mp4 and
  // throws NotSupportedError if webm is forced (which used to make the record
  // button silently do nothing on iPhones). Probe for the first container the
  // current browser actually supports; undefined lets the browser pick.
  const pickRecorderMime = () => {
    const candidates = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    for (const m of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return undefined;
  };

  const toggleRecord = () => {
    if (!streamRef.current) {
      toast.error("Camera isn't ready — allow camera access, then try again.");
      return;
    }
    if (!recording) {
      if (typeof window.MediaRecorder === "undefined") {
        toast.error("Video recording isn't supported in this browser. Please update iOS / Safari.");
        return;
      }
      const chunks = [];
      let r;
      try {
        const mime = pickRecorderMime();
        r = mime
          ? new MediaRecorder(streamRef.current, { mimeType: mime })
          : new MediaRecorder(streamRef.current);
      } catch (err) {
        console.error("MediaRecorder init failed", err);
        toast.error("Couldn't start recording on this device. Try updating your browser.");
        return;
      }
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        // Strip codec suffix (e.g. "video/mp4;codecs=avc1") so the upload
        // Content-Type matches the backend's allowed set.
        const baseType = (r.mimeType || "video/mp4").split(";")[0];
        const blob = new Blob(chunks, { type: baseType });
        setRecordedBlob(blob);
        setRejectReason(null);
      };
      r.start();
      recorderRef.current = r;
      setRecording(true);
      // Live countdown — show remaining seconds over the camera preview so
      // the user can pace themselves through the script. Ticks every 1s
      // until it reaches 0, then the auto-stop fires.
      setSecondsLeft(MAX_SECONDS);
      if (countdownRef.current) clearInterval(countdownRef.current);
      countdownRef.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
      // auto-stop at MAX_SECONDS (matches the "7-second intro" script copy)
      setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
          setRecording(false);
        }
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
        setSecondsLeft(0);
      }, MAX_SECONDS * 1000);
    } else {
      recorderRef.current?.stop();
      setRecording(false);
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      setSecondsLeft(0);
    }
  };

  return (
    <motion.div
      className="absolute inset-0 flex flex-col px-6 pt-10 pb-6 bg-grain overflow-y-auto no-scrollbar"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      data-testid="video-pick-screen"
    >
      {onSkip && (
        // Top-right close button — only rendered for signed-in users who've
        // already accepted community rules (i.e. not blocking primary onboarding).
        <button
          type="button"
          onClick={() => { try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* SAST: intentional — track.stop() may throw on already-ended tracks; nothing to recover */ } ; onSkip(); }}
          aria-label="Close and skip for now"
          className="absolute top-4 right-4 z-10 w-9 h-9 rounded-full glass-dark border border-white/15 text-white/85 hover:text-white hover:bg-white/10 active:scale-95 transition flex items-center justify-center text-lg leading-none"
          data-testid="video-pick-close"
        >
          ✕
        </button>
      )}
      <h2 className="font-display text-3xl font-black leading-tight">Intro<br/>video<span style={{ color: "#FF4D4D" }}>.</span></h2>
      <p className="mt-3 text-sm text-white/55">Keep it under 7 seconds. Use the script below word-for-word.</p>

      {/* Dynamic script panel */}
      <div className="mt-5 rounded-2xl glass-dark border border-[#FF4D4D]/25 p-4" data-testid="intro-script">
        <p className="text-[10px] uppercase tracking-widest font-bold text-[#FF4D4D] flex items-center gap-1">
          <span aria-hidden="true">📜</span> Script for your 7-second intro video
        </p>
        <p className="mt-2 text-base italic font-medium leading-snug text-white">{scriptText}</p>
        <div className="mt-3 pt-3 border-t border-white/8 flex gap-2 items-start text-xs text-white/75 leading-snug">
          <span aria-hidden="true" className="text-base">⚠️</span>
          <span><span className="font-bold text-white">Keep it appropriate.</span> No nudity, hate speech, or harmful content. Videos that violate our community rules will be removed and may result in a ban.</span>
        </div>
      </div>

      <div
        className="mt-4 relative aspect-[3/4] rounded-3xl overflow-hidden bg-black shrink-0"
        /* shrink-0: this page is a flex column — without it, small screens
           (iPhone SE et al) squeeze the camera box to a sliver to fit
           everything above the fold, crushing the record button. min-height
           is a belt-and-suspenders fallback. */
        style={{ minHeight: 360 }}
      >
        {/* Recording view: live camera feed until a clip is captured.
            Playback view: the captured blob with native HTML5 controls so
            the user can review (play/scrub/replay) before posting. */}
        {recordedBlob ? (
          <video
            key={recordedBlob.size /* force a fresh element when re-recorded */}
            src={URL.createObjectURL(recordedBlob)}
            className="w-full h-full object-cover"
            playsInline
            autoPlay
            loop
            controls
            data-testid="record-playback-video"
          />
        ) : (
          /* Ref callback re-attaches the active MediaStream whenever this
             element remounts — necessary after returning from the playback
             view via "Re-record", otherwise the new <video> has no srcObject
             and stays black even though MediaRecorder still has the stream. */
          <video
            ref={(el) => {
              videoRef.current = el;
              if (el && streamRef.current && el.srcObject !== streamRef.current) {
                el.srcObject = streamRef.current;
                el.play().catch(() => {});
              }
            }}
            className="w-full h-full object-cover"
            muted
            playsInline
            autoPlay
          />
        )}
        {!streamReady && !recordedBlob && (
          <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm">
            Waiting for camera…
          </div>
        )}
        {/* Action button: record (initial), pause (mid-recording), or
            re-record (after a clip is captured — pops the blob and brings
            the live camera back so the user can try again). */}
        <div className="absolute bottom-5 left-0 right-0 flex justify-center">
          {recordedBlob ? (
            <button
              onClick={() => { setRecordedBlob(null); setRejectReason(null); }}
              className="px-4 py-2 rounded-full glass-dark border border-white/15 text-white text-xs font-bold uppercase tracking-widest active:scale-95 transition flex items-center gap-1.5"
              data-testid="record-retake-button"
              aria-label="Re-record intro video"
            >
              <Camera size={14} /> Re-record
            </button>
          ) : (
            <button
              className={`btn-icon ${recording ? "record-ring" : ""}`}
              onClick={toggleRecord}
              data-testid="record-toggle-button"
              style={{ background: recording ? "#FF4D4D" : "rgba(255,255,255,0.15)" }}
            >
              {recording ? <Pause size={22} /> : <Camera size={22} />}
            </button>
          )}
        </div>
        {recordedBlob && (
          <div
            className="absolute top-3 left-3 text-xs glass-dark px-2 py-1 rounded-full font-bold flex items-center gap-1"
            data-testid="record-review-badge"
          >
            <span>👀</span><span>Review before posting</span>
          </div>
        )}
        {/* Live countdown overlay — only visible while actively recording.
            Big numeric so it's readable from arm's length while the user is
            reciting their script. */}
        {recording && !recordedBlob && (
          <div
            className="absolute top-3 right-3 px-3 py-1.5 rounded-full bg-[#FF4D4D]/90 text-white font-display font-black text-lg leading-none shadow-lg pointer-events-none flex items-center gap-1.5"
            data-testid="record-countdown"
            aria-live="polite"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <span>{secondsLeft}s</span>
          </div>
        )}
      </div>

      {phase === "verifying" && (
        <div className="mt-4 rounded-2xl glass-dark border border-[#00E5FF]/30 px-4 py-3 flex items-center gap-3" data-testid="face-check-status">
          <div className="relative w-5 h-5">
            <div className="absolute inset-0 rounded-full border-2 border-[#00E5FF]/30" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#00E5FF] animate-spin" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">✨ Verifying your video…</div>
            <div className="text-[11px] text-white/55">AI is checking it's just your face. Takes ~2 seconds.</div>
          </div>
        </div>
      )}

      {rejectReason && phase !== "verifying" && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-2xl bg-[#FF4D4D]/12 border border-[#FF4D4D]/45 px-4 py-3 flex items-start gap-3"
          data-testid="face-check-reject"
          role="alert"
        >
          <AlertTriangle size={18} className="text-[#FF4D4D] shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Video rejected</div>
            <div className="text-[11px] text-white/70 mt-0.5 leading-snug">{rejectReason}</div>
            <div className="text-[11px] text-white/55 mt-1">Tap the record button to try again.</div>
            <a
              href={SAFETY_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] text-[#00E5FF] hover:text-white underline mt-2"
              data-testid="face-check-reject-contact"
            >
              Looks wrong? Contact us →
            </a>
          </div>
          <button
            onClick={() => setRejectReason(null)}
            className="text-white/55 hover:text-white p-1 -mr-1 -mt-1"
            aria-label="Dismiss"
            data-testid="face-check-reject-dismiss"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}

      <button
        className="btn-primary mt-4 flex items-center justify-center gap-2"
        onClick={save}
        /* Not disabled when there's no recording — save() shows a "Record
           your intro first" toast instead, so users understand what's missing
           rather than facing a dead button. */
        disabled={loading}
        data-testid="video-save-button"
      >
        {phase === "verifying" ? "Verifying your video…"
          : phase === "saving" ? "Saving…"
          : (<>Continue <ArrowRight size={18} /></>)}
      </button>
    </motion.div>
  );
}
