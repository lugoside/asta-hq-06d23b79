// Service worker: NETWORK-FIRST con fallback su cache.
// Online → sempre l'ultima versione (app + dati). Offline → ultima copia salvata.
// Così ogni aggiornamento del codice arriva subito, mantenendo la resilienza offline.
const VERSION = "v25";
const CACHE = "fa-" + VERSION;
const SHELL_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./engine.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    // no-store: bypassa la cache HTTP del browser → online prendi SEMPRE l'ultima versione
    fetch(e.request, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
  );
});
