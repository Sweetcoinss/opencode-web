/**
 * sw.js — عامل الخدمة (Service Worker)
 *
 * كيخلي الموقع يتثبّت كتطبيق، وكيخلي الواجهة تحلّ بسرعة وبلا إنترنت.
 * ⚠️ ما كيكاشّش حتى طلب ديال /api/ — الدردشة خاصها الشبكة دايماً.
 */

const CACHE = "rtlai-v3";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon-32.png",
  "/logo-96.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // الأبيات: عمرو ما تتكاشّ
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin) return;

  // الصفحة: الشبكة أولاً (باش تكون آخر نسخة)، والكاش كخطة ب
  const isPage = req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html");
  if (isPage) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // الأصول: كاش أولاً + تحديث فالحلفية (stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
