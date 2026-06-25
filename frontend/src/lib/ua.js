// iOS Safari (and in-app webviews on iOS — they all use WebKit) blocks the
// popup-mode GIS flow under Intelligent Tracking Prevention. Detect those
// browsers and force GIS into redirect mode where Google form-POSTs the
// credential straight to our backend. Desktop + Android Chrome keep popup
// mode because it's a snappier UX.
export function isIosWebkit() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad on iPadOS 13+ reports as "MacIntel" with touch support — still WebKit.
  const isIpadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isIpadOs;
}

// Quick check for Android. Used to decide whether to show the "Install
// Android app" pill — we don't want to dangle an .apk download in front of
// iPhone / desktop users who can't use it.
export function isAndroid() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent || "");
}

// True when the page is running as a Home-Screen-installed PWA in
// standalone mode (no browser chrome). Used to surface the iOS Safari
// sign-in hand-off — Google OAuth cannot complete inside an iOS PWA
// sandbox because the redirect lands in Safari and never returns.
//
// `navigator.standalone` is Apple's legacy proprietary flag (still the only
// reliable signal on older iOS). `display-mode: standalone` is the
// W3C-standard media query that Chrome and modern Safari both honour.
export function isStandalonePwa() {
  if (typeof window === "undefined") return false;
  if (window.navigator && window.navigator.standalone === true) return true;
  try {
    return window.matchMedia?.("(display-mode: standalone)")?.matches === true;
  } catch {
    return false;
  }
}
