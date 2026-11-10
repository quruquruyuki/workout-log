const CACHE = "wl-v7";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.hostname.endsWith("supabase.co")) return; // データ通信はキャッシュしない
  const isCdn = u.hostname === "cdn.jsdelivr.net" || u.hostname.startsWith("fonts.");
  if (u.origin !== location.origin && !isCdn) return;
  // 自サイト: ネット優先（更新をすぐ反映）、オフライン時はキャッシュ
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  // CDN: キャッシュ優先
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return res; })));
});
