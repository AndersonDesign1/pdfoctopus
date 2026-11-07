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
// - A new version waits until every tab running the old one is closed (no skipWaiting), so
//   open tabs never lose files they still need. It then activates and deletes cached files
//   it doesn't use, so old versions don't pile up.
// - Caching is best effort: if storage is full, responses are still served from the network.
//
// Only same-origin GET requests are handled. PDFs never pass through here: they are read
// from disk by the page and never fetched.

// Every file the current build needs, written in by the build (see vite.config.ts). It also
// makes this file change on every deploy that changes the app, which is how the browser
// knows to install the new version.
const PRECACHE = /* __PRECACHE__ */ ["/"];

// A hash of this whole file as built, written in by the build. Each version of the service
// worker gets its own cache: a new version fills its cache during install without touching
// the one the running version serves from, and the switch happens only on activate. A
// failed install therefore can't leave a half-updated cache.
const VERSION = /* __VERSION__ */ "dev";
const CACHE = `pdfoctopus-${VERSION}`;

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
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await Promise.all(
          PRECACHE.map(async (path) => {
            // Hashed files never change, so one already cached by an earlier version is copied
            // instead of downloaded again (unless it is a stray copy of the HTML page). Other
            // files, like the page and the favicon, are always fetched fresh.
            if (path.startsWith("/assets/")) {
              const existing = await caches.match(path, MATCH);
              const type = existing?.headers.get("content-type") ?? "";
              if (existing && !type.includes("text/html")) return tryPut(cache, path, existing);
            }
            // A failed download fails the install: the browser keeps the current version
            // and tries again later, rather than activating one that can't work offline.
            const response = await fetch(path, { cache: "no-cache" });
            if (!response.ok) throw new Error(`Could not download ${path}: ${response.status}`);
            // With single-page-app fallback, a missing file comes back as the HTML page with
            // status 200. Never store that under an asset's name.
            const type = response.headers.get("content-type") ?? "";
            if (path.startsWith("/assets/") && type.includes("text/html")) {
              throw new Error(`Could not download ${path}: got an HTML page instead`);
            }
            // Storage being full is not a reason to fail: the app still works online.
            await tryPut(cache, path, response);
          }),
        );
      } catch (err) {
        await caches.delete(CACHE);
        throw err;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove earlier versions' caches. No tab runs an earlier version any more: this
      // worker only activates once they have all closed.
      for (const key of await caches.keys()) {
        if (key.startsWith("pdfoctopus-") && key !== CACHE) await caches.delete(key);
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
