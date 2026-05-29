// Lightweight Google Analytics 4 (gtag.js) wrapper.
// - Loads gtag.js dynamically only when REACT_APP_GA4_MEASUREMENT_ID is set.
// - Disables GA's automatic page_view (we fire them manually on screen changes).
// - Exposes `track(event, params)` and `pageview(screen)` helpers.
// - Safe no-ops when GA isn't configured or before the script has loaded.

const GA_ID = process.env.REACT_APP_GA4_MEASUREMENT_ID;
let _initialized = false;

export function initAnalytics() {
  if (_initialized || !GA_ID || typeof window === "undefined") return;
  _initialized = true;

  // 1) Inject the gtag.js loader
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);

  // 2) Bootstrap the dataLayer + gtag function (must run synchronously)
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag("js", new Date());
  // send_page_view: false → we control pageviews per-screen ourselves
  gtag("config", GA_ID, { send_page_view: false, anonymize_ip: true });
}

export function pageview(screen) {
  if (!GA_ID || typeof window === "undefined" || !window.gtag) return;
  window.gtag("event", "page_view", {
    page_title: screen,
    page_location: window.location.href,
    page_path: `/${screen}`,
  });
}

export function track(event, params = {}) {
  if (!GA_ID || typeof window === "undefined" || !window.gtag) return;
  try {
    window.gtag("event", event, params);
  } catch (e) {
    console.error("ga track failed", e);
  }
}
