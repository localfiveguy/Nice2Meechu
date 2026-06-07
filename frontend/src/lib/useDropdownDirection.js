import { useEffect, useState } from "react";

/**
 * Returns "up" or "down" telling a dropdown which direction to open based
 * on how much vertical room is available between the anchor element and
 * the visible viewport (which on mobile means *above* the open keyboard,
 * not the full window height — we use `visualViewport.height` when the
 * browser supports it).
 *
 * Use:
 *   const inputRef = useRef(null);
 *   const direction = useDropdownDirection(inputRef, isOpen);
 *   // direction === "up" → render dropdown above the input
 *
 * Re-measures whenever:
 *  - the dropdown opens (`isOpen` flips to true)
 *  - the keyboard shows/hides (`visualViewport.resize`)
 *  - the page scrolls (the input may have moved into a tight spot)
 */
export function useDropdownDirection(anchorRef, isOpen, estimatedDropdownPx = 280) {
  const [direction, setDirection] = useState("down");

  useEffect(() => {
    if (!isOpen) return undefined;
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // visualViewport gives us the height *excluding* the on-screen keyboard,
      // which is exactly what we need. Falls back to innerHeight on browsers
      // without the API (old Safari).
      const vv = typeof window !== "undefined" && window.visualViewport;
      const visibleHeight = vv ? vv.height : window.innerHeight;
      const visibleTop = vv ? vv.offsetTop : 0;
      const roomBelow = visibleTop + visibleHeight - rect.bottom;
      const roomAbove = rect.top - visibleTop;
      // Flip up if there's clearly more room above than below AND the room
      // below is too short to render the typical dropdown. Bias toward "down"
      // (the common case) by keeping a generous threshold.
      if (roomBelow < estimatedDropdownPx && roomAbove > roomBelow) {
        setDirection("up");
      } else {
        setDirection("down");
      }
    };
    compute();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", compute);
    vv?.addEventListener("scroll", compute);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      vv?.removeEventListener("resize", compute);
      vv?.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef, isOpen, estimatedDropdownPx]);

  return direction;
}
