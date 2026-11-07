// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Service worker: keeps a local copy of the app so repeat visits don't download MuPDF's
// ~10 MB WebAssembly again, and the app still opens when the network is slow or down.
//
// - On install, the whole app (the page plus every built file) is cached, so it works
//   offline after the first visit, not only after the second.
// - /assets/* files have a content hash in their name and never change: cache first.
// - Everything else (the HTML page, favicon): network first, cached copy when offline,
//   so a new deploy is picked up on the next visit.
// - On activate, files the current version no longer uses are deleted, so old versions
//   don't pile up.
// - Caching is best effort: if storage is full, responses are still served from the network.
//
// Only same-origin GET requests are handled. PDFs never pass through here: they are read
// from disk by the page and never fetched.

const CACHE = "pdfoctopus-v1";

// Every file the current build needs, written in by the build (see vite.config.ts). It also
// makes this file change on every deploy that changes the app, which is how the browser
// knows to install the new version.
const PRECACHE = /* __PRECACHE__ */ ["/"];
const PRECACHE_SET = new Set(PRECACHE);

// Match on the URL alone. Files are cached during install by a plain fetch, while the page
// later requests them as module scripts (with an Origin header). If the server sends
// "Vary: Origin", a normal match would miss and the app would fail to load offline.
const MATCH = { ignoreVary: true };

/** Store a response, ignoring failures (e.g. storage full): caching is only an optimisation. */
async function tryPut(cache, key, response) {
  try {
    await cache.put(key, response);
  } catch (err) {
    console.warn("Service worker: could not cache", typeof key === "string" ? key : key.url, err);
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (path) => {
          // Hashed files already cached from an earlier version don't need downloading again.
          if (path !== "/" && (await cache.match(path, MATCH))) return;
          try {
            const response = await fetch(path, { cache: "no-cache" });
            if (response.ok) await tryPut(cache, path, response);
          } catch {
            // Offline or blocked: it will be cached the first time it is used instead.
          }
        }),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("pdfoctopus-") && key !== CACHE) await caches.delete(key);
      }
      // Remove files from earlier versions that this one no longer uses.
      const cache = await caches.open(CACHE);
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/assets/") && !PRECACHE_SET.has(path)) await cache.delete(request);
      }
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, MATCH);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await tryPut(cache, request, response.clone());
  return response;
}

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cache.match(cacheKey, MATCH);
    if (cached) return cached;
    throw err;
  }
  if (response.ok) await tryPut(cache, cacheKey, response.clone());
  return response;
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
