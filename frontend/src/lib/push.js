// Web Push helpers — opt-in "notify me when someone new joins nearby".
import { api } from "./api";
import { isIosWebkit, isStandalonePwa } from "./ua";

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// iOS only exposes Web Push inside an installed home-screen PWA (16.4+).
export function pushBlockedNeedsInstall() {
  return isIosWebkit() && !isStandalonePwa();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function enablePush() {
  if (pushBlockedNeedsInstall()) throw new Error("needs-install");
  if (!pushSupported()) throw new Error("unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("denied");
  const registration = await navigator.serviceWorker.ready;
  const { data } = await api.get("/push/public-key");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.public_key),
  });
  await api.post("/push/subscribe", { subscription: subscription.toJSON() });
}

export async function disablePush() {
  let endpoint = null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      endpoint = subscription.endpoint;
      await subscription.unsubscribe();
    }
  } catch { /* browser sub already gone — still clear server side */ }
  await api.post("/push/unsubscribe", endpoint ? { endpoint } : {});
}
