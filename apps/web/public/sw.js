// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Service worker: keeps a local copy of the app so repeat visits don't download MuPDF's
// ~10 MB WebAssembly again, and the app still opens when the network is slow or down.
//
// - /assets/* files have a content hash in their name and never change: cache first.
// - Everything else (the HTML page, favicon): network first, cached copy when offline,
//   so a new deploy is picked up on the next visit.
//
// Only same-origin GET requests are handled. PDFs never pass through here: they are read
// from disk by the page and never fetched.

const CACHE = "pdfoctopus-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("pdfoctopus-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === "navigate") {
    // Every route of the single-page app is the same HTML, so keep one copy under "/".
    event.respondWith(networkFirst(request, "/"));
  } else {
    event.respondWith(networkFirst(request));
  }
});
