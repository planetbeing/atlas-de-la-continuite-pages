/* Atlas de la Continuité — hosted-edition host layer.
 * Loaded only by the hosted shell (dist/index.html), never by the standalone
 * offline file. It owns everything that touches the network or browser
 * storage, so app.js stays network-free:
 *  - loading the versioned data parts with progress, retry and clear errors;
 *  - registering the service worker (HTTPS or localhost only);
 *  - the explicit offline download of this edition into Cache Storage, with
 *    progress, cancel, verification, removal and a persistence request;
 *  - noticing a newer published edition without disrupting the open session.
 * It exposes window.AtlasHost; app.js uses it when present.
 */
(function () {
  "use strict";
  const bootEl = document.getElementById("atlas-boot");
  if (!bootEl) return;
  let CFG;
  try { CFG = JSON.parse(bootEl.textContent); } catch (err) { return; }
  const PREFIX = "atlas-offline-";
  const CACHE = PREFIX + CFG.version;
  const base = new URL(".", location.href);
  const abs = (rel) => new URL(rel, base).href;
  const secure = (location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) && location.protocol !== "file:";
  const swOK = secure && "serviceWorker" in navigator;
  const cachesOK = secure && "caches" in window;

  // ------------------------------------------------------------ data parts
  const parts = new Map();
  async function fetchJSON(url, bytes, onProgress, signal) {
    const res = await fetch(url, { signal, credentials: "same-origin" });
    if (!res.ok) {
      const e = new Error(res.status === 404 ? "This file is no longer on the server; a newer edition may have been published." : "The server answered " + res.status + ".");
      e.status = res.status;
      throw e;
    }
    if (!res.body || !onProgress) return res.json();
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(Math.min(1, bytes ? got / bytes : 0), got);
    }
    const all = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    chunks.length = 0;
    return JSON.parse(new TextDecoder().decode(all));
  }
  function loadPart(name, onProgress) {
    const file = CFG.data && CFG.data[name];
    if (!file) return Promise.reject(new Error("Unknown data part " + name));
    if (parts.has(name)) return parts.get(name);
    const attempt = async () => {
      let last;
      for (let k = 0; k < 3; k++) {
        try { return await fetchJSON(abs(file.url), file.bytes, onProgress); } catch (err) {
          last = err;
          if (err.status === 404 || err.name === "SyntaxError") break;
          await new Promise((r) => setTimeout(r, 400 * (k + 1)));
        }
      }
      throw last;
    };
    const p = attempt();
    parts.set(name, p);
    p.catch(() => parts.delete(name)); // a later call retries
    return p;
  }

  // ------------------------------------------------------ service worker
  let registration = null;
  const updateListeners = [];
  let updateReady = false;
  function notifyUpdate() { updateReady = true; for (const f of updateListeners) try { f(); } catch (err) { /* ignore */ } }
  if (swOK) {
    navigator.serviceWorker.register(abs("sw.js"), { scope: base.pathname }).then((reg) => {
      registration = reg;
      const hadController = !!navigator.serviceWorker.controller;
      const watch = (w) => w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) notifyUpdate(); });
      if (reg.waiting && hadController) notifyUpdate();
      reg.addEventListener("updatefound", () => watch(reg.installing));
    }).catch(() => { registration = null; });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloading) location.reload(); });
    window.__atlasReloadOnActivate = () => { reloading = true; };
  }
  function applyUpdate() {
    if (registration && registration.waiting) {
      if (window.__atlasReloadOnActivate) window.__atlasReloadOnActivate();
      registration.waiting.postMessage({ type: "atlas:activate" });
    } else location.reload();
  }
  // A published edition also changes index.html; check it on demand and when
  // the page becomes visible again, without touching the running session.
  async function checkForUpdate() {
    if (!secure) return false;
    try {
      if (registration) await registration.update();
      const res = await fetch(abs("index.html"), { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return false;
      const m = (await res.text()).match(/"version"\s*:\s*"([0-9a-f]+)"/);
      if (m && m[1] !== CFG.version) { notifyUpdate(); return true; }
    } catch (err) { /* offline: nothing to report */ }
    return false;
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

  // ----------------------------------------------------- offline edition
  const files = (CFG.offline && CFG.offline.files) || [];
  const totalBytes = files.reduce((n, f) => n + (f.bytes || 0), 0);
  async function offlineStatus() {
    if (!cachesOK) return { supported: false, reason: swOK ? "storage" : "insecure" };
    const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
    const others = [];
    let current = null;
    for (const n of names) {
      const c = await caches.open(n), mark = await c.match("__complete__");
      const info = mark ? await mark.json().catch(() => null) : null;
      if (n === CACHE) current = { complete: !!info, info, cached: (await c.keys()).length - (info ? 1 : 0) };
      else others.push({ name: n, complete: !!info, info });
    }
    const sw = !!(registration && registration.active) || !!navigator.serviceWorker.controller;
    return { supported: true, version: CFG.version, edition: CFG.edition, totalBytes, files: files.length, current, others, serviceWorker: sw, ready: !!(current && current.complete && sw) };
  }
  // Download every file of this edition. The edition becomes "complete" only
  // after each file is stored and re-verified; a cancelled or failed run
  // leaves no completion marker, and a retry reuses files already stored.
  async function downloadOffline(onProgress, signal) {
    if (!cachesOK) throw new Error("Offline storage needs the hosted (HTTPS) atlas.");
    const cache = await caches.open(CACHE);
    await cache.delete("__complete__");
    let done = 0;
    const report = (extra) => onProgress && onProgress({ bytes: done + (extra || 0), total: totalBytes });
    for (const f of files) {
      if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const url = abs(f.url);
      const have = await cache.match(url);
      if (have) { done += f.bytes || 0; report(); continue; }
      const res = await fetch(url, { cache: "no-cache", signal, credentials: "same-origin" });
      if (!res.ok) throw new Error(f.url + ": the server answered " + res.status + ".");
      let body;
      if (res.body) {
        const reader = res.body.getReader(), chunks = [];
        let got = 0;
        for (;;) {
          if (signal && signal.aborted) { reader.cancel(); throw new DOMException("Cancelled", "AbortError"); }
          const { done: end, value } = await reader.read();
          if (end) break;
          chunks.push(value); got += value.length; report(got);
        }
        body = new Blob(chunks, { type: res.headers.get("content-type") || "" });
      } else body = await res.blob();
      if (f.bytes && body.size !== f.bytes && f.url !== "index.html") throw new Error(f.url + ": expected " + f.bytes + " bytes, received " + body.size + ".");
      if (f.url === "index.html") {
        // The shell must belong to this edition; if a new edition was
        // published mid-download, its shell would point at other files.
        const v = ((await body.text()).match(/"version"\s*:\s*"([0-9a-f]+)"/) || [])[1];
        if (v !== CFG.version) { const e = new Error("A newer edition was published while downloading. Reload the page to download the new edition."); e.edition = v; throw e; }
      }
      const headers = new Headers({ "content-type": res.headers.get("content-type") || "" });
      await cache.put(url, new Response(body, { status: 200, headers }));
      done += f.bytes || body.size; report();
    }
    for (const f of files) if (!(await cache.match(abs(f.url)))) throw new Error("Verification failed: " + f.url + " is missing.");
    // The page's own address ("./") opens the shell when offline.
    const shell = await cache.match(abs("index.html"));
    if (shell) await cache.put(abs("./"), shell.clone());
    await cache.put("__complete__", new Response(JSON.stringify({ version: CFG.version, edition: CFG.edition, bytes: totalBytes, files: files.length, completedAt: new Date().toISOString() }), { headers: { "content-type": "application/json" } }));
    // Now that this edition is complete: drop unfinished downloads of other
    // editions, and keep only the most recent previous complete edition, so a
    // tab still showing it can finish loading its deferred parts.
    const prev = [];
    for (const n of await caches.keys()) {
      if (!n.startsWith(PREFIX) || n === CACHE) continue;
      const mark = await (await caches.open(n)).match("__complete__");
      if (!mark) { await caches.delete(n); continue; }
      prev.push({ n, at: String(((await mark.json().catch(() => ({}))) || {}).completedAt || "") });
    }
    prev.sort((a, b) => b.at.localeCompare(a.at));
    for (const p of prev.slice(1)) await caches.delete(p.n);
    return offlineStatus();
  }
  async function removeOffline() {
    if (!cachesOK) return;
    for (const n of await caches.keys()) if (n.startsWith(PREFIX)) await caches.delete(n);
  }
  async function persist() {
    if (!(navigator.storage && navigator.storage.persist)) return { supported: false };
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const granted = already || await navigator.storage.persist();
    return { supported: true, granted, already };
  }
  async function estimate() {
    if (!(navigator.storage && navigator.storage.estimate)) return null;
    try { return await navigator.storage.estimate(); } catch (err) { return null; }
  }

  window.AtlasHost = Object.freeze({
    mode: "hosted",
    version: CFG.version,
    edition: CFG.edition,
    secure,
    standalone: (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true,
    parts: Object.fromEntries(Object.entries(CFG.data || {}).map(([k, v]) => [k, v.bytes])),
    loadPart,
    onUpdate(f) { updateListeners.push(f); if (updateReady) f(); },
    checkForUpdate,
    applyUpdate,
    offline: Object.freeze({ supported: cachesOK && swOK, totalBytes, files: files.length, status: offlineStatus, download: downloadOffline, remove: removeOffline, persist, estimate }),
  });
})();
