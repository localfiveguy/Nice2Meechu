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
