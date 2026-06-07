import React, { useEffect, useRef } from "react";

export const SignaturePad = React.forwardRef(function SignaturePad({ onChange }, ref) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);

  React.useImperativeHandle(ref, () => ({
    toDataURL: (type) => canvasRef.current?.toDataURL(type || "image/png"),
    clear: () => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      dirtyRef.current = false;
      onChange?.(false);
    },
  }));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Crisp on retina
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "#FF4D4D";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches?.[0];
      const x = (t ? t.clientX : e.clientX) - r.left;
      const y = (t ? t.clientY : e.clientY) - r.top;
      return { x, y };
    };
    const start = (e) => {
      e.preventDefault();
      drawingRef.current = true;
      const { x, y } = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (e) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const { x, y } = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      if (!dirtyRef.current) { dirtyRef.current = true; onChange?.(true); }
    };
    const end = () => { drawingRef.current = false; };

    c.addEventListener("mousedown", start);
    c.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    c.addEventListener("touchstart", start, { passive: false });
    c.addEventListener("touchmove", move, { passive: false });
    c.addEventListener("touchend", end);

    return () => {
      c.removeEventListener("mousedown", start);
      c.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      c.removeEventListener("touchstart", start);
      c.removeEventListener("touchmove", move);
      c.removeEventListener("touchend", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="signature-canvas"
      className="w-full h-32 rounded-xl border-2 border-dashed border-[#FF4D4D]/40 bg-white/5 touch-none"
    />
  );
});
