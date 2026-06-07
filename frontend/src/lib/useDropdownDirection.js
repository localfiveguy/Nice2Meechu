import { useEffect, useState } from "react";

/**
 * Returns the optimal placement for a dropdown anchored to an input.
 *
 * Returns { direction, maxHeight } where:
 *   direction:  "up" | "down"  — which side of the anchor to open on
 *   maxHeight:  pixel count    — how tall the dropdown is allowed to grow
 *                                 in the chosen direction
 *
 * The maxHeight is the killer feature: on mobile, the keyboard takes ~50%
 * of the screen so the visible viewport is short. Without a maxHeight cap
 * the dropdown can overflow the visible viewport and clip its top items
 * (which is what users notice as "the closest match is missing"). With
 * the cap, the dropdown stays scrollable inside the visible area.
 *
 * Uses `visualViewport` when available (excludes the on-screen keyboard
 * from height calculations), falls back to `innerHeight` on older Safari.
 *
 * Use:
 *   const inputRef = useRef(null);
 *   const { direction, maxHeight } = useDropdownPlacement(inputRef, isOpen);
 *   return (
 *     <div
 *       className={direction === "up" ? "bottom-full mb-1" : "top-full mt-1"}
 *       style={{ maxHeight }}
 *     />
 *   );
 */
const PREFERRED_HEIGHT_PX = 320; // sweet-spot height for ~5 dropdown items
const MIN_USABLE_PX = 120;       // below this, room is too tight to be useful
const SAFETY_MARGIN_PX = 16;     // breathing room between dropdown and viewport edges

export function useDropdownPlacement(anchorRef, isOpen) {
  const [placement, setPlacement] = useState({
    direction: "down",
    maxHeight: PREFERRED_HEIGHT_PX,
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vv = typeof window !== "undefined" && window.visualViewport;
      const visibleHeight = vv ? vv.height : window.innerHeight;
      const visibleTop = vv ? vv.offsetTop : 0;
      const visibleBottom = visibleTop + visibleHeight;
      const roomBelow = visibleBottom - rect.bottom - SAFETY_MARGIN_PX;
      const roomAbove = rect.top - visibleTop - SAFETY_MARGIN_PX;

      // Pick the direction with more available room. Bias toward "down" by
      // a small amount (10px) because typing tends to push content further
      // up, so "down" remains usable longer.
      const preferDown = roomBelow + 10 >= roomAbove;
      const direction = preferDown ? "down" : "up";
      const room = preferDown ? roomBelow : roomAbove;

      // Clamp to a sensible band. If the chosen side is below the minimum,
      // try the other side — only stick with the original if the other side
      // is also too tight.
      let maxHeight = Math.min(PREFERRED_HEIGHT_PX, Math.max(room, MIN_USABLE_PX));
      let finalDirection = direction;
      if (room < MIN_USABLE_PX) {
        const otherRoom = preferDown ? roomAbove : roomBelow;
        if (otherRoom > room) {
          finalDirection = preferDown ? "up" : "down";
          maxHeight = Math.min(PREFERRED_HEIGHT_PX, Math.max(otherRoom, MIN_USABLE_PX));
        }
      }

      setPlacement((prev) =>
        prev.direction === finalDirection && prev.maxHeight === maxHeight
          ? prev
          : { direction: finalDirection, maxHeight }
      );
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
  }, [anchorRef, isOpen]);

  return placement;
}

/** Backwards-compat shim — older callers only needed the direction. */
export function useDropdownDirection(anchorRef, isOpen) {
  return useDropdownPlacement(anchorRef, isOpen).direction;
}
