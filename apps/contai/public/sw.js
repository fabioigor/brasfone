/* Cont.ai service worker: cache da casca da aplicacao para arranque offline. A API nunca e cacheada. */
const CACHE = "contai-shell-v3";
const SHELL = ["/", "/index.html", "/app.js", "/scan.js", "/styles.css", "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Partilha do Android ("Partilhar com... Cont.ai"): guarda os ficheiros e abre a digitalizacao.
  if (e.request.method === "POST" && url.pathname === "/share-target") {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const files = fd.getAll("files").filter((f) => f && f.size);
      const cache = await caches.open("contai-share");
      await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
      await Promise.all(files.map((f, i) => cache.put("/shared/" + i, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-filename": encodeURIComponent(f.name || "partilha-" + i) } }))));
      return Response.redirect("/#digitalizar?shared=" + files.length, 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
