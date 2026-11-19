/* Atlas de la Continuité — service worker (hosted edition only).
 * Offline copies are created explicitly by the page (host.js) into a cache
 * named atlas-offline-<version>, which becomes usable only once its
 * "__complete__" record is written. This worker:
 *  - serves content-hashed edition files from a cache when present (a cached
 *    copy is always the exact file), otherwise the network; stable URLs go to
 *    the network first and fall back to a complete offline edition;
 *  - for page navigations tries the network first and, when offline, falls
 *    back to the shell of the newest COMPLETE offline edition;
 *  - never takes over a running page by itself: a new edition waits until the
 *    page asks it to activate (the "update available" control) or all tabs close.
 */
"use strict";
const CONFIG = {"version":"1ffb5f2cc859","edition":"v4"};
const PREFIX = "atlas-offline-";

self.addEventListener("install", () => { /* nothing precached implicitly */ });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "atlas:activate") self.skipWaiting();
});

async function completeCaches() {
  const out = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const cache = await caches.open(name);
    const mark = await cache.match("__complete__");
    if (!mark) continue;
    try { out.push({ name, cache, info: await mark.json() }); } catch (err) { /* ignore a damaged marker */ }
  }
  return out.sort((a, b) => String(b.info.completedAt).localeCompare(String(a.info.completedAt)));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try { return await fetch(req); } catch (err) {
        for (const c of await completeCaches()) {
          const hit = (await c.cache.match(new URL("./", self.registration.scope).href)) || (await c.cache.match(new URL("index.html", self.registration.scope).href));
          if (hit) return hit;
        }
        throw err;
      }
    })());
    return;
  }
  // Content-hashed files (scripts, styles, data, illustrations) never change,
  // so a stored copy is the exact file whichever cache holds it: serve it
  // first. Stable URLs (manifest, icons) prefer the network and, offline,
  // come only from a COMPLETE edition, newest first.
  const hashed = /\.[0-9a-f]{10}\.(js|css|json|webp|png|jpe?g)$/.test(url.pathname);
  event.respondWith((async () => {
    if (hashed) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return fetch(req);
    }
    try { return await fetch(req); } catch (err) {
      for (const c of await completeCaches()) { const hit = await c.cache.match(req, { ignoreSearch: true }); if (hit) return hit; }
      throw err;
    }
  })());
});
