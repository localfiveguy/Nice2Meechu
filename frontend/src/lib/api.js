import axios from "axios";

// REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
export const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

// withCredentials so the session cookie is sent on every request; Bearer header is also sent
// as a fallback (useful for automated testing playbook).
export const api = axios.create({ baseURL: API, withCredentials: true });
api.interceptors.request.use((config) => {
  const t = localStorage.getItem("n2m_token");
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

const translationCache = new Map();
export async function translate(text, target_lang, source_lang) {
  if (!text) return "";
  if (target_lang === source_lang) return text;
  const key = `${source_lang || ""}|${target_lang}|${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  try {
    const { data } = await api.post("/translate", { text, target_lang, source_lang });
    translationCache.set(key, data.translation);
    return data.translation;
  } catch {
    return text;
  }
}

// Robust copy that works even in cross-origin iframes (Emergent preview) where
// `navigator.clipboard.writeText` is blocked by the missing `clipboard-write`
// permission. Falls back to a hidden <textarea> + document.execCommand('copy'),
// which is deprecated but still the only thing that works in those sandboxes.
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* SAST: intentional fallback — Clipboard API blocked in cross-origin iframes or insecure contexts; fall through to execCommand below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Tries Web Share first; on AbortError returns silently (user cancelled);
// otherwise falls back to clipboard. Returns "shared" | "copied" | "failed".
export async function shareOrCopy({ title, text, url, copyText }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "shared"; // treat cancel as no-op
      console.warn("web share blocked, falling back to clipboard", err);
    }
  }
  const ok = await copyToClipboard(copyText || url || text);
  return ok ? "copied" : "failed";
}
