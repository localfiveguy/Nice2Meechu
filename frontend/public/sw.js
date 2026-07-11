/* Nice2Meechu service worker — Web Push only (no caching / fetch interception,
   so CRA hot-reload and normal network behavior are untouched). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: "Nice2Meechu", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Nice2Meechu";
  const options = {
    body: payload.body || "",
    icon: "/icon-512.png",
    badge: "/icon-512.png",
    data: { url: payload.url || "/" },
  };
  // Per-thread tag (e.g. chat-<match_id>) collapses notifications from the
  // same conversation instead of stacking one per message.
  if (payload.tag) options.tag = payload.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          // Deep-link (e.g. /?chat=<match_id>) — navigate the existing tab so
          // the app opens straight into the right chat.
          if (targetUrl !== "/" && "navigate" in client) {
            return client.focus().then((c) => c.navigate(targetUrl).catch(() => c));
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

/* Browser rotated/expired the subscription — resubscribe and re-register with
   the backend. Auth rides on the session cookie (credentials: include). */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/public-key");
        const { public_key } = await res.json();
        const padding = "=".repeat((4 - (public_key.length % 4)) % 4);
        const b64 = (public_key + padding).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(b64);
        const key = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);

        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch (e) {
        /* best effort — user can re-enable from the app */
      }
    })()
  );
});
