// Postula – service worker : rend l'app installable et rapide au retour.
// Pages et fichiers du site : réseau d'abord (toujours à jour), cache en secours hors ligne.
// Bibliothèques versionnées (CDN) et polices : cache d'abord.
// Jamais mis en cache : API Supabase, paiement, captcha, requêtes non-GET.
const VERSION = "postula-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/config.js", "/icons/icon-192.png"];
const CDN = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.gstatic.com", "fonts.googleapis.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname === "/sw.js") return;
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: req.mode === "navigate" })
      .then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error()))));
    return;
  }
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
