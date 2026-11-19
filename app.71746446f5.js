/* Atlas de la Continuité — interactive frontend (edition 4).
 * Consumes the evidence document either embedded in <script id="atlas-data">
 * (standalone offline file) or loaded in versioned parts through the hosted
 * shell's host layer (window.AtlasHost, src/host.js). This file never touches
 * the network itself. Nothing here invents places, dates or events:
 * every map position, owner, world class, story and date comes from that
 * document. v2 fields (DATA_CONTRACT.md "v2 additions") are optional; when one
 * is absent the v1 rendering is used.
 * Projection: screenX = -saveX, screenY = saveY (system x/y in the data are raw
 * save coordinates; the flip happens exactly once, when systems are loaded).
 */
(function () {
  "use strict";

  // ===================================================================== boot
  const $ = (sel, root) => (root || document).querySelector(sel);
  const HOST = window.AtlasHost || null;
  const bootBox = $("#boot");
  function bootState(msg, frac, error, retry) {
    if (!bootBox) return;
    bootBox.hidden = false;
    $("#bootMsg").textContent = msg;
    $("#bootBar").style.width = frac == null ? "0" : Math.round(frac * 100) + "%";
    bootBox.classList.toggle("err", !!error);
    const b = $("#bootRetry");
    b.hidden = !retry;
    b.onclick = retry || null;
  }
  const valid = (D) => D && Array.isArray(D.snapshots) && D.snapshots.length && Array.isArray(D.systems);
  function start(D, parts) {
    try { main(D, parts); if (bootBox) bootBox.hidden = true; } catch (err) { bootState("The atlas could not start: " + err.message, null, true, () => location.reload()); throw err; }
  }
  const embedded = document.getElementById("atlas-data");
  if (embedded) {
    // Standalone file: everything is embedded. The parsed objects are kept and
    // the multi-megabyte JSON text node is released.
    let D = null;
    try { D = JSON.parse(embedded.textContent); } catch (err) { D = null; }
    embedded.remove();
    if (!valid(D)) bootState("The atlas data embedded in this file could not be read, so the map cannot be drawn.", null, true);
    else start(D, { worlds: true, evidence: true });
  } else if (HOST) {
    const kb = (n) => (n / 1048576).toFixed(1) + " MB";
    const load = () => {
      bootState("Loading the atlas" + (HOST.parts.core ? " (" + kb(HOST.parts.core) + ")" : "") + "…", 0);
      HOST.loadPart("core", (f) => bootState("Loading the atlas… " + Math.round(f * 100) + "%", f))
        .then((D) => { if (!valid(D)) throw new Error("The atlas data is incomplete."); start(D, { worlds: false, evidence: false }); })
        .catch((err) => bootState("The atlas could not be loaded. " + ((err && err.message) || "") + (navigator.onLine === false ? " You appear to be offline." : ""), null, true, load));
    };
    load();
  } else bootState("This page is missing the atlas data.", null, true);

  function main(D, PARTS) {

  const META = D.meta || {};
  const S = D.snapshots.map(String);
  const N = S.length;
  const LAST = N - 1;
  const NONE = "4294967295";
  const dnum = (d) => { const p = String(d).split(".").map(Number); return p[0] * 360 + ((p[1] || 1) - 1) * 30 + ((p[2] || 1) - 1); };
  const SN = S.map(dnum);
  const SNAP = new Map(S.map((d, i) => [d, i]));
  const yearOf = (d) => String(d).slice(0, 4);
  const idxAtOrAfter = (d) => { const n = dnum(d); for (let i = 0; i < N; i++) if (SN[i] >= n) return i; return LAST; };
  const idxOfDate = (d) => (SNAP.has(String(d)) ? SNAP.get(String(d)) : idxAtOrAfter(d));
  const clampIdx = (i) => Math.max(0, Math.min(LAST, i | 0));
  const isIdx = (v) => Number.isInteger(v) && v >= 0 && v <= LAST;
  // Runs arrive either as [from, to, value] arrays or {from, to, value} objects.
  const normRuns = (runs) => (Array.isArray(runs) ? runs.map((r) => (Array.isArray(r) ? r : [r.from, r.to, r.value])) : null);
  const runAt = (runs, i) => { if (!runs) return null; for (const r of runs) if (r[0] <= i && i <= r[1]) return r; return null; };
  const valueAt = (runs, i, fallback) => {
    if (!runs || !runs.length) return fallback;
    const r = runAt(runs, i);
    if (r) return r[2];
    if (i < runs[0][0]) return runs[0][2];
    return runs[runs.length - 1][2];
  };

  const COUNTRIES = D.countries || {};
  const REP = (() => {
    for (const [id, c] of Object.entries(COUNTRIES)) if (c && META.campaign_name && c.n === META.campaign_name) return id;
    return "0";
  })();
  const ownerOk = (v) => (v == null || v === "" || String(v) === NONE ? null : String(v));
  const cName = (id) => (id ? (COUNTRIES[id] && COUNTRIES[id].n) || "an unrecorded empire" : "Unclaimed");
  const cColor = (id) => (id ? (COUNTRIES[id] && COUNTRIES[id].cd) || "#8d8778" : "rgba(239,230,210,0.5)");

  const SYSTEMS = D.systems.map((s) => ({
    id: String(s.i), name: s.n || "Unnamed system", x: +s.x, y: +s.y, star: s.s || null,
    o: normRuns(s.o) || [], p: normRuns(s.p) || [], b: s.b || [], bn: Array.isArray(s.b) ? s.b.length : s.bn || 0,
  }));
  for (const s of SYSTEMS) { s.wx = -s.x; s.wy = s.y; } // the single projection step
  const SYS = new Map(SYSTEMS.map((s) => [s.id, s]));
  const BODY = new Map();
  for (const s of SYSTEMS) for (const b of s.b) BODY.set(String(b[0]), { s, b });
  // ---- deferred parts (hosted edition): worlds and source evidence
  const pending = new Map();
  function ensurePart(name) {
    if (PARTS[name]) return Promise.resolve(true);
    if (!HOST) return Promise.reject(new Error("This part of the atlas is not available."));
    if (!pending.has(name)) {
      const p = HOST.loadPart(name).then((x) => { (name === "worlds" ? attachWorlds : attachEvidence)(x); PARTS[name] = true; pending.delete(name); return true; });
      p.catch(() => pending.delete(name));
      pending.set(name, p);
    }
    return pending.get(name);
  }
  function attachWorlds(w) {
    D.systems.forEach((raw, i) => { const slot = w.systems[i]; if (slot) { SYSTEMS[i].b = slot[0] || []; SYSTEMS[i].bn = SYSTEMS[i].b.length; } });
    for (const s of SYSTEMS) for (const b of s.b) BODY.set(String(b[0]), { s, b });
    addWorldSearch();
  }
  function attachEvidence(x) {
    D.entries.forEach((e, i) => {
      if (!e) return;
      (e.facts || []).forEach((f, k) => { const v = x.facts[i] && x.facts[i][k]; if (v) f.src = v[0]; });
      (e.body || []).forEach((p, k) => { const v = x.body[i] && x.body[i][k]; if (v) p.src = v[0]; });
      (e.chapters || []).forEach((c, k) => { const v = x.chapters[i] && x.chapters[i][k]; if (v) { if (v[0]) c.fx = v[0][0]; if (v[1]) c.options = v[1][0]; } });
    });
    D.events.forEach((raw, i) => { const v = x.events[i]; const e = raw && EVT.get(raw.id); if (v && e) e.src = v[0]; });
    for (const it of SEARCH) if (it.ent) it.units = unitsOf(it.ent);
  }
  const LANES = (D.lanes || []).map((l) => [SYS.get(String(l[0])), SYS.get(String(l[1]))]).filter((l) => l[0] && l[1]);
  const ADJ = new Map();
  for (const [a, b] of LANES) { if (!ADJ.has(a)) ADJ.set(a, []); if (!ADJ.has(b)) ADJ.set(b, []); ADJ.get(a).push(b); ADJ.get(b).push(a); }
  const ownerAt = (s, i) => ownerOk(runAt(s.o, i) && runAt(s.o, i)[2]);
  const presentAt = (s, i) => { for (const r of s.p) if (r[0] <= i && i <= r[1]) return true; return false; };
  const firstPresent = (s) => (s.p.length ? Math.min(...s.p.map((r) => r[0])) : null);

  const EXCERPTS = D.excerpts && typeof D.excerpts === "object" ? D.excerpts : {};
  const ENTRIES = (D.entries || []).filter((e) => e && e.id);
  for (const e of ENTRIES) {
    e.cats = Array.isArray(e.cats) ? e.cats : [];
    e.body = Array.isArray(e.body) ? e.body : [];
    e.facts = Array.isArray(e.facts) ? e.facts : [];
    e.links = Array.isArray(e.links) ? e.links.map(String) : [];
    e.related = Array.isArray(e.related) ? e.related : [];
    e.chapters = Array.isArray(e.chapters) ? e.chapters : [];
    e.aka = Array.isArray(e.aka) ? e.aka.filter(Boolean) : [];
    e.track = normRuns(e.track);
    if (e.system != null) e.system = String(e.system);
    if (e.planet != null) e.planet = String(e.planet);
  }
  const ENT = new Map(ENTRIES.map((e) => [e.id, e]));
  const isRecord = (e) => e.kind === "site" || e.kind === "rift";
  const isPerson = (e) => e.kind === "person" || e.kind === "institution";
  const curated = (e) => !isRecord(e);
  const EVENTS = (D.events || []).filter((e) => e && e.id).map((e) => ({ ...e, sys: (e.sys || []).map(String).filter((s) => SYS.has(s)), ent: (e.ent || []).filter((id) => ENT.has(id)) }));
  const EVT = new Map(EVENTS.map((e) => [e.id, e]));
  const JOURNEYS = (D.journeys || []).filter((j) => j && j.id && Array.isArray(j.steps));
  const JRN = new Map(JOURNEYS.map((j) => [j.id, j]));
  const THREADS = (Array.isArray(D.open_threads) ? D.open_threads : []).filter((t) => t && t.title);
  const DELTA = D.edition_delta && typeof D.edition_delta === "object" ? D.edition_delta : null;

  const entriesAt = new Map();
  const mentionsAt = new Map();
  const eventsAt = new Map();
  const relatedBy = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(v)) m.get(k).push(v); };
  for (const e of ENTRIES) {
    if (e.system && SYS.has(e.system)) push(entriesAt, e.system, e);
    for (const l of e.links) if (SYS.has(l) && l !== e.system) push(mentionsAt, l, e);
    if (e.track) for (const r of e.track) if (SYS.has(String(r[2])) && String(r[2]) !== e.system) push(mentionsAt, String(r[2]), e);
    for (const r of e.related) if (ENT.has(r)) push(relatedBy, r, e);
  }
  for (const ev of EVENTS) for (const s of ev.sys) push(eventsAt, s, ev);
  const KIND_ORDER = { story: 0, lore: 1, person: 2, institution: 3, site: 4, rift: 5 };
  for (const list of entriesAt.values()) list.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));

  // Where an entry sits at snapshot i: tracked (mobile) stories move with their track.
  function entryLoc(e, i) {
    if (e.track && e.track.length) {
      const r = runAt(e.track, i);
      if (r) return String(r[2]);
      if (i < e.track[0][0]) return null;
      return String(e.track[e.track.length - 1][2]);
    }
    return e.system && SYS.has(e.system) ? e.system : null;
  }

  // ============================================================ vocabulary
  const CATS = [
    { k: "archaeology", en: "Archaeology", fr: "Archéologie", c: "#d6a35c" },
    { k: "rifts", en: "Astral rifts", fr: "Failles astrales", c: "#a596f2" },
    { k: "unique", en: "Unique worlds", fr: "Mondes uniques", c: "#6fc2b8" },
    { k: "history", en: "History", fr: "Histoire", c: "#e6dcc4" },
    { k: "megastructures", en: "Megastructures", fr: "Mégastructures", c: "#8fb3e0" },
    { k: "lore", en: "Campaign lore", fr: "Mémoire de campagne", c: "#dc8fae" },
  ];
  const CAT = new Map(CATS.map((c) => [c.k, c]));
  const catColor = (k) => (CAT.get(k) ? CAT.get(k).c : "#b9b09c");
  const KIND = {
    story: { fr: "Récit", en: "Curated story" },
    lore: { fr: "Mémoire", en: "Campaign lore" },
    person: { fr: "Personnage", en: "Person" },
    institution: { fr: "Institution", en: "Institution" },
    site: { fr: "Site archéologique", en: "Dig site record" },
    rift: { fr: "Faille astrale", en: "Astral rift record" },
  };
  const kindOf = (e) => KIND[e.kind] || { fr: "Archive", en: "Record" };
  const BADGE = Object.assign({ save: "Save record", interval: "Inferred interval", lore: "Campaign lore", game: "Game context", proposal: "Proposal", discrepancy: "Source discrepancy", interpretation: "Thematic interpretation", inferred: "Inferred from game rules" }, META.badges || {});
  const BADGE_HELP = {
    save: "Read directly from a saved field: an exact date or value in a retained save or its report.",
    interval: "Inferred by comparing two consecutive saves; the change happened somewhere between them.",
    lore: "Campaign canon from the personality register and conversations, not a saved game record.",
    game: "Context from installed game definitions or localisation (what the game says such a thing is).",
    proposal: "Discussed or proposed, but not established as enacted in the saves.",
    discrepancy: "Two sources disagree; both are reported rather than silently reconciled.",
    interpretation: "A thematic reading of the record, offered as interpretation rather than fact.",
    inferred: "Inferred from how the game's rules work, not read from a saved value.",
  };
  const THREAD_KIND = {
    active_expedition: "Active expedition",
    available_investigation: "Available investigation",
    missing_transition: "Transition not observed",
    authored_proposal: "Authored proposal",
    missing_evidence: "Missing evidence",
    unresolved_choice: "Unresolved choice",
  };
  const BRANCH_STATUS = {
    chosen_index_ambiguous: "The saved option index is ambiguous, so the exact choice is uncertain.",
    no_choice_retained: "No choice is retained in the saves for this chapter.",
    not_republique: "This chapter belongs to another empire's expedition; it is not a République choice.",
  };
  function starLabel(k) {
    if (!k) return null;
    const m = /^sc_([a-z])$/.exec(k);
    if (m) return m[1].toUpperCase() + "-class star";
    if (k === "sc_m_giant") return "Red giant";
    if (k === "sc_black_hole") return "Black hole";
    if (k === "sc_neutron_star") return "Neutron star";
    if (k === "sc_pulsar") return "Pulsar";
    if (/^sc_binary/.test(k)) return "Binary system";
    if (/^sc_trinary/.test(k)) return "Trinary system";
    return null;
  }

  // ============================================================== helpers
  function h(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (let a = 2; a < arguments.length; a++) append(n, arguments[a]);
    return n;
  }
  function append(n, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) { for (const x of k) append(n, x); return; }
    n.append(k instanceof Node ? k : String(k));
  }
  function fill(node) { node.replaceChildren(); for (let a = 1; a < arguments.length; a++) append(node, arguments[a]); return node; }
  const dot = (color, cls) => h("i", { class: cls || null, style: "background:" + color, "aria-hidden": "true" });
  const ID_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
  // Snake_case identifiers inside prose render as code, never as words.
  function rich(t) {
    const s = String(t == null ? "" : t);
    const out = [];
    let last = 0;
    s.replace(ID_RE, (m, _g, off) => { if (off > last) out.push(s.slice(last, off)); out.push(h("code", null, m)); last = off + m.length; return m; });
    if (last < s.length) out.push(s.slice(last));
    return out;
  }
  function titleOf(t) {
    const s = String(t || "");
    let m = /^Flag (\S+) set$/.exec(s);
    if (m) return ["Timestamped save flag ", h("code", null, m[1])];
    m = /^Flag (\S+) first observed$/.exec(s);
    if (m) return ["Save flag first observed ", h("code", null, m[1])];
    return rich(s || "Untitled record");
  }
  // Accent-insensitive normalisation, with a map back to original offsets for snippets.
  function normMap(s) {
    s = String(s || "");
    let out = "";
    const map = [];
    for (let i = 0; i < s.length; i++) {
      let c = s[i].normalize("NFD").replace(/[̀-ͯ]/g, "");
      c = c.replace(/[’‘`´]/g, "'").replace(/œ/g, "oe").replace(/Œ/g, "oe").replace(/æ/g, "ae").replace(/Æ/g, "ae").toLowerCase();
      for (let k = 0; k < c.length; k++) { out += c[k]; map.push(i); }
    }
    return { n: out, map };
  }
  const norm = (s) => normMap(s).n;
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Phone layout (stacked map / reading sheet); small landscape screens use the
  // two-column layout instead. Kept in step with the same query in style.css.
  const PHONE_MQ = "(max-width: 860px) and (min-height: 501px), (max-width: 560px)";
  const isPhone = () => window.matchMedia(PHONE_MQ).matches;
  const isNarrow = isPhone;
  function live(msg) { const l = $("#live"); l.textContent = ""; setTimeout(() => { l.textContent = msg; }, 30); }

  // When does a fact/event sit in time, and which map observation shows it?
  function when(x) {
    if (!x || x.undated || (!x.d && !x.b)) return { kind: "undated", label: "Undated", badge: "Undated lore", note: "Campaign lore with no saved date; shown as background.", idx: null };
    if (x.d) {
      const n = dnum(x.d);
      if (n < SN[0]) return { kind: "pre", label: x.d, badge: "Before archive", note: "Exact saved date before the oldest retained save; the nearest available map observation is " + S[0] + ".", idx: 0 };
      const i = idxAtOrAfter(x.d);
      return { kind: "exact", label: x.d, badge: "Exact date", note: SN[i] === n ? "Exact saved date; a save exists on this day." : "Exact saved date; the map shows the next observation, " + S[i] + ".", idx: i };
    }
    const i = idxOfDate(x.b);
    if (x.a) return { kind: "interval", label: x.a + " – " + x.b, badge: "Interval", note: "Inferred: happened after the " + x.a + " save and is first seen in the " + x.b + " save.", idx: i };
    if (x.first || i === 0) return { kind: "first", label: "by " + x.b, badge: "Already present", note: "Already true in the earliest retained save (" + x.b + "); the actual date is earlier and not recorded.", idx: i };
    return { kind: "observed", label: "as of " + x.b, badge: "Observed", note: "State recorded in the " + x.b + " save.", idx: i };
  }

  // ================================================================ state
  const st = {
    idx: LAST, sys: null, planet: null, entry: null, event: null,
    journey: null, mode: "complete", allRec: false, follow: true, view: "stories",
    cats: new Set(), scope: "rep", records: false,
    tab: "story", local: false, terr: true, labels: true, hover: null,
    speed: 1, playMode: "linger", playGroup: null,
  };
  const through = () => st.mode === "through";
  const shownAt = (ix) => !through() || ix == null || ix <= st.idx;

  // ---------------------------------------------- dated availability (v2 gates)
  const factIdx = (f) => when(f).idx; // null for undated lore
  function chapterIdx(c) {
    if (isIdx(c.idx)) return c.idx;
    if (c.seen) return idxOfDate(c.seen);
    return null;
  }
  // A chapter's encounter, retained choice and recorded outcome can each enter
  // the archive at a different save.
  const choiceIdx = (c) => (isIdx(c.choice_idx) ? c.choice_idx : chapterIdx(c));
  const outcomeIdx = (c) => (isIdx(c.outcome_idx) ? c.outcome_idx : chapterIdx(c));
  function lifeOf(id) { const e = ENT.get(id); return e && e.life && typeof e.life === "object" ? e.life : null; }
  const firstCache = new Map(), lastCache = new Map();
  // First snapshot at which the archive holds anything about this entry (null = undated background).
  function entryFirstIdx(e) {
    if (firstCache.has(e.id)) return firstCache.get(e.id);
    const c = [];
    if (e.life && isIdx(e.life.first_idx)) c.push(e.life.first_idx);
    for (const r of e.life_refs || []) { const l = lifeOf(r); if (l && isIdx(l.first_idx)) c.push(l.first_idx); }
    for (const f of e.facts) { const i = factIdx(f); if (i != null) c.push(i); }
    for (const ch of e.chapters) { const i = chapterIdx(ch); if (i != null) c.push(i); }
    const v = c.length ? Math.min(...c) : null;
    firstCache.set(e.id, v);
    return v;
  }
  // Latest snapshot any of the entry's dated claims depends on.
  function entryLastIdx(e) {
    if (lastCache.has(e.id)) return lastCache.get(e.id);
    const c = [];
    for (const f of e.facts) { const i = factIdx(f); if (i != null) c.push(i); }
    for (const ch of e.chapters) { const i = chapterIdx(ch); if (i != null) c.push(i); }
    for (const p of e.body) if (p && isIdx(p.gate_idx)) c.push(p.gate_idx);
    for (const x of Array.isArray(e.status) ? e.status : []) if (x && (isIdx(x.gate_idx) || x.b === "save")) c.push(isIdx(x.gate_idx) ? x.gate_idx : LAST);
    const v = c.length ? Math.max(...c) : null;
    lastCache.set(e.id, v);
    return v;
  }
  // Gate for a body paragraph: its gate_idx (v2). A non-lore, non-game
  // paragraph without one may still summarise later records, so it is held
  // back until the entry's last dated record.
  function paraGate(p, e) {
    if (isIdx(p.gate_idx)) return p.gate_idx;
    if (p.b === "lore" || p.b === "game") return null;
    return entryLastIdx(e);
  }
  const notYet = (e) => through() && entryFirstIdx(e) != null && entryFirstIdx(e) > st.idx;
  // The lede summarises the whole record, so under through-date reading it is
  // shown only once everything it may summarise is established.
  function ledeShown(e) {
    if (!through()) return true;
    if (isIdx(e.lede_gate_idx)) return e.lede_gate_idx <= st.idx;
    const last = entryLastIdx(e);
    return last == null || last <= st.idx;
  }

  const inCats = (cats) => !st.cats.size || cats.some((c) => st.cats.has(c));
  function entryInScope(e, i) {
    if (st.scope === "all") return true;
    if (e.scope === "rep" || !e.scope) return true;
    const loc = entryLoc(e, i);
    return !!(loc && ownerAt(SYS.get(loc), i) === REP);
  }
  function eventInScope(ev, i) {
    if (st.scope === "all") return true;
    if (ev.scope === "rep" || !ev.scope) return true;
    return ev.sys.some((s) => ownerAt(SYS.get(s), i) === REP);
  }
  function entryVisible(e) {
    if (isRecord(e) && !st.records && !(st.cats.has("archaeology") && e.kind === "site") && !(st.cats.has("rifts") && e.kind === "rift")) return false;
    return inCats(e.cats) && entryInScope(e, st.idx);
  }
  // Filters shared by the ticks, the chronicle, next/previous event and counts.
  function eventFiltered(ev) {
    return (st.allRec || !ev.minor) && inCats([ev.cat]) && eventInScope(ev, st.idx);
  }
  const eventVisible = (ev) => eventFiltered(ev) && shownAt(when(ev).idx);

  // ================================================================== map
  const cv = $("#map");
  const ctx = cv.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  const view = { cx: 0, cy: 0, k: 1 };
  const GB = (() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of SYSTEMS) { x0 = Math.min(x0, s.wx); x1 = Math.max(x1, s.wx); y0 = Math.min(y0, s.wy); y1 = Math.max(y1, s.wy); }
    const m = 34;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m, x0, y0, x1, y1 };
  })();
  let K_MIN = 0.2;
  const K_MAX = 48;
  const toScreen = (wx, wy) => [(wx - view.cx) * view.k + W / 2, (wy - view.cy) * view.k + H / 2];
  const toWorld = (px, py) => [(px - W / 2) / view.k + view.cx, (py - H / 2) / view.k + view.cy];

  // Galaxy glow: a blurred density of the real systems (no invented stars).
  const glow = (() => {
    const size = 360, c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const sc = size / Math.max(GB.w, GB.h);
    g.globalCompositeOperation = "lighter";
    for (const s of SYSTEMS) {
      const x = (s.wx - GB.x) * sc, y = (s.wy - GB.y) * sc, r = 30 * sc;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(70,82,150,0.055)");
      gr.addColorStop(1, "rgba(70,82,150,0)");
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    return { c, s: size / sc };
  })();

  // Approximate territory: each cell takes the owner of the nearest present
  // system within R (unowned systems claim space for nobody). Not game borders.
  const TERR_R = 20;
  const rgbCache = new Map();
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function rgbOf(color) {
    if (rgbCache.has(color)) return rgbCache.get(color);
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data, v = [d[0], d[1], d[2]];
    rgbCache.set(color, v);
    return v;
  }
  // Territory rasters are cached LRU within a byte budget. Each entry is a
  // (1.5·G)² RGBA canvas; evicted canvases are shrunk to 0×0 so their backing
  // stores are released at once rather than at the next garbage collection.
  // Worst case resident: TERR_BUDGET, plus one build's transients (grid canvas
  // and ImageData G²·4 bytes each, ownership grid G²·2) = 10·G² bytes.
  const TERR_BUDGET = 16 * 1048576;
  const terrCache = new Map();
  let terrBytes = 0, terrG = 0, terrBuilds = 0;
  const release = (c) => { if (c) { c.width = 0; c.height = 0; } };
  function terrGrid() {
    const small = isPhone() || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    return Math.max(256, Math.min(small ? 384 : 512, Math.round(Math.max(W, H) * DPR / 2)));
  }
  function dropTerritory() { for (const t of terrCache.values()) release(t.c); terrCache.clear(); terrBytes = 0; }
  function territory(i, build) {
    const G = terrGrid();
    if (G !== terrG) { dropTerritory(); terrG = G; }
    if (terrCache.has(i)) { const t = terrCache.get(i); terrCache.delete(i); terrCache.set(i, t); return t; }
    if (build === false) return null;
    const cs = Math.max(GB.w, GB.h) / G, gw = Math.ceil(GB.w / cs), gh = Math.ceil(GB.h / cs);
    const B = TERR_R, nbx = Math.ceil(GB.w / B) + 2, nby = Math.ceil(GB.h / B) + 2, buckets = new Array(nbx * nby), owners = [], ownerIx = new Map();
    for (const s of SYSTEMS) {
      if (!presentAt(s, i)) continue;
      const o = ownerAt(s, i);
      let oi = -2;
      if (o) { if (!ownerIx.has(o)) { ownerIx.set(o, owners.length); owners.push(o); } oi = ownerIx.get(o); }
      const key = (Math.floor((s.wy - GB.y) / B) + 1) * nbx + Math.floor((s.wx - GB.x) / B) + 1;
      (buckets[key] || (buckets[key] = [])).push([s.wx, s.wy, oi]);
    }
    const own = new Int16Array(gw * gh).fill(-1), R2 = TERR_R * TERR_R;
    for (let cy = 0; cy < gh; cy++) {
      const wy = GB.y + (cy + 0.5) * cs, by = Math.floor((wy - GB.y) / B) + 1;
      for (let cx = 0; cx < gw; cx++) {
        const wxx = GB.x + (cx + 0.5) * cs, bx = Math.floor((wxx - GB.x) / B) + 1;
        let best = R2, bo = -1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const list = buckets[(by + dy) * nbx + bx + dx];
          if (!list) continue;
          for (const p of list) { const ddx = p[0] - wxx, ddy = p[1] - wy, d2 = ddx * ddx + ddy * ddy; if (d2 < best) { best = d2; bo = p[2]; } }
        }
        own[cy * gw + cx] = bo;
      }
    }
    const SM = 1.5, sw = Math.round(gw * SM), sh = Math.round(gh * SM), bytes = sw * sh * 4;
    for (const [k, t] of terrCache) { if (terrBytes + bytes <= TERR_BUDGET) break; release(t.c); terrBytes -= t.bytes; terrCache.delete(k); }
    const c = document.createElement("canvas");
    c.width = gw; c.height = gh;
    const g = c.getContext("2d"), img = g.createImageData(gw, gh), px = img.data;
    const rgbs = owners.map((o) => rgbOf(cColor(o)));
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const k = y * gw + x, o = own[k];
      if (o < 0) continue;
      const edge = (x > 0 && own[k - 1] !== o) || (x < gw - 1 && own[k + 1] !== o) || (y > 0 && own[k - gw] !== o) || (y < gh - 1 && own[k + gw] !== o);
      const rgb = rgbs[o], rep = owners[o] === REP;
      px[k * 4] = rgb[0]; px[k * 4 + 1] = rgb[1]; px[k * 4 + 2] = rgb[2];
      px[k * 4 + 3] = edge ? (rep ? 170 : 125) : (rep ? 52 : 38);
    }
    g.putImageData(img, 0, 0);
    // Soften the cell grid so borders stay smooth at deep zoom.
    const sm = document.createElement("canvas");
    sm.width = sw; sm.height = sh;
    const g2 = sm.getContext("2d");
    g2.imageSmoothingEnabled = true;
    if ("filter" in g2) g2.filter = "blur(1.2px)";
    g2.drawImage(c, 0, 0, sw, sh);
    release(c);
    const t = { c: sm, x: GB.x, y: GB.y, w: gw * cs, h: gh * cs, bytes };
    terrCache.set(i, t);
    terrBytes += bytes;
    terrBuilds++;
    return t;
  }

  let pendingFrame = null;
  let renderQueued = false;
  function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(draw); } }
  const sysRadius = () => Math.max(1.6, Math.min(4.6, 1.1 + view.k * 0.55));

  function markersAt(i) {
    // system id -> { stories: n, sites: n, rifts: n }
    const m = new Map();
    for (const e of ENTRIES) {
      if (!entryVisible(e) || notYet(e)) continue;
      const loc = entryLoc(e, i);
      if (!loc) continue;
      const s = SYS.get(loc);
      if (!s || !presentAt(s, i)) continue;
      if (!m.has(loc)) m.set(loc, { stories: 0, sites: 0, rifts: 0 });
      const r = m.get(loc);
      if (curated(e)) r.stories++; else if (e.kind === "site") r.sites++; else if (e.kind === "rift") r.rifts++;
    }
    return m;
  }
  let lastMarkers = new Map();

  function journeyPath() {
    const j = st.journey && JRN.get(st.journey);
    if (!j) return [];
    const pts = [];
    for (const step of stepsOf(j)) {
      const e = ENT.get(step.entry); if (!e) continue;
      const loc = entryLoc(e, isIdx(step.idx) ? step.idx : st.idx) || e.system;
      const s = loc && SYS.get(loc);
      if (s && (!pts.length || pts[pts.length - 1] !== s)) pts.push(s);
    }
    return pts;
  }

  function draw() {
    renderQueued = false;
    if (!W || !H) return;
    const i = st.idx, k = view.k;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(k, k); ctx.translate(-view.cx, -view.cy);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(glow.c, GB.x, GB.y, glow.s, glow.s);
    // While the timeline is being dragged, rasters are not built for every
    // intermediate save: dots and lanes still show the exact recorded owners,
    // and the shading is built once the slider settles.
    if (st.terr) { const t = territory(i, !scrubbing); if (t) ctx.drawImage(t.c, t.x, t.y, t.w, t.h); }
    ctx.restore();

    const pad = 30;
    const vis = (p) => p[0] > -pad && p[0] < W + pad && p[1] > -pad && p[1] < H + pad;
    const P = new Map();
    for (const s of SYSTEMS) if (presentAt(s, i)) P.set(s, toScreen(s.wx, s.wy));

    // hyperlanes
    const groups = new Map();
    for (const [a, b] of LANES) {
      const pa = P.get(a), pb = P.get(b);
      if (!pa || !pb || (!vis(pa) && !vis(pb))) continue;
      const oa = ownerAt(a, i), ob = ownerAt(b, i);
      const key = oa && oa === ob ? oa : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pa, pb);
    }
    ctx.lineCap = "round";
    for (const [key, pts] of groups) {
      ctx.beginPath();
      for (let q = 0; q < pts.length; q += 2) { ctx.moveTo(pts[q][0], pts[q][1]); ctx.lineTo(pts[q + 1][0], pts[q + 1][1]); }
      if (key) { ctx.strokeStyle = cColor(key); ctx.globalAlpha = key === REP ? 0.55 : 0.32; ctx.lineWidth = key === REP ? 1.2 : 0.9; }
      else { ctx.strokeStyle = "#efe6d2"; ctx.globalAlpha = 0.13; ctx.lineWidth = 0.7; }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // journey path
    const jp = journeyPath();
    if (jp.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = "rgba(111,139,214,0.85)";
      ctx.beginPath();
      jp.forEach((s, q) => { const p = toScreen(s.wx, s.wy); if (q) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
      ctx.restore();
    }

    // systems
    const r = sysRadius();
    const dimForeign = st.scope === "rep";
    for (const [s, p] of P) {
      if (!vis(p)) continue;
      const o = ownerAt(s, i);
      ctx.beginPath();
      ctx.arc(p[0], p[1], o ? r : r * 0.78, 0, Math.PI * 2);
      ctx.fillStyle = o ? cColor(o) : "#cfc6b2";
      ctx.globalAlpha = o ? (dimForeign && o !== REP ? 0.75 : 1) : 0.42;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // markers
    lastMarkers = markersAt(i);
    for (const [sid, m] of lastMarkers) {
      const s = SYS.get(sid), p = P.get(s);
      if (!p || !vis(p)) continue;
      if (m.stories) {
        ctx.beginPath(); ctx.arc(p[0], p[1], r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#e3cf94"; ctx.lineWidth = m.stories > 1 ? 2.2 : 1.5; ctx.stroke();
        if (k > 1.2) { ctx.beginPath(); ctx.moveTo(p[0], p[1] - r - 7.5); ctx.lineTo(p[0] + 2.6, p[1] - r - 4.5); ctx.lineTo(p[0], p[1] - r - 1.5); ctx.lineTo(p[0] - 2.6, p[1] - r - 4.5); ctx.closePath(); ctx.fillStyle = "#e3cf94"; ctx.fill(); }
      }
      if (m.sites) {
        const x = p[0] + r + 5, y = p[1] + r + 3;
        ctx.beginPath(); ctx.moveTo(x, y - 3.5); ctx.lineTo(x + 3.5, y); ctx.lineTo(x, y + 3.5); ctx.lineTo(x - 3.5, y); ctx.closePath();
        ctx.fillStyle = "#d6a35c"; ctx.fill();
      }
      if (m.rifts) {
        const x = p[0] - r - 5, y = p[1] + r + 3;
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.strokeStyle = "#a596f2"; ctx.lineWidth = 1.6; ctx.stroke();
      }
    }

    // event highlight (selected event, or the group a playback paused on)
    const hl = new Set();
    const ev = st.event && EVT.get(st.event);
    if (ev) for (const sid of ev.sys) hl.add(sid);
    if (st.playGroup) for (const e of st.playGroup.list) for (const sid of e.sys) hl.add(sid);
    for (const sid of hl) {
      const p = P.get(SYS.get(sid)); if (!p) continue;
      ctx.beginPath(); ctx.arc(p[0], p[1], r + 11, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(200,101,90,0.9)"; ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (st.hover && st.hover !== st.sys) {
      const p = P.get(SYS.get(st.hover));
      if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], r + 7, 0, Math.PI * 2); ctx.strokeStyle = "rgba(239,230,210,0.7)"; ctx.lineWidth = 1; ctx.stroke(); }
    }
    if (st.sys) {
      const s = SYS.get(st.sys), p = s && P.get(s);
      if (p) {
        const R = r + 9;
        ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, Math.PI * 2);
        ctx.strokeStyle = "#f3e2ad"; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(p[0] + dx * (R + 3), p[1] + dy * (R + 3)); ctx.lineTo(p[0] + dx * (R + 9), p[1] + dy * (R + 9)); }
        ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    if (st.labels) drawLabels(P, r);
  }

  function drawLabels(P, r) {
    const i = st.idx, k = view.k, placed = [];
    const cand = [];
    for (const [s, p] of P) {
      if (p[0] < -60 || p[0] > W + 60 || p[1] < -20 || p[1] > H + 20) continue;
      const o = ownerAt(s, i), m = lastMarkers.get(s.id);
      let pr;
      if (s.id === st.sys) pr = 0;
      else if (s.id === st.hover) pr = 1;
      else if (m && m.stories) pr = k >= 0.75 ? 2 : 99;
      else if (o === REP) pr = k >= 1.9 ? 3 : 99;
      else if (m && (m.sites || m.rifts)) pr = k >= 2.2 ? 4 : 99;
      else pr = k >= 3.4 ? 5 : 99;
      if (pr < 99) cand.push([pr, s, p]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    let count = 0;
    for (const [pr, s, p] of cand) {
      if (count > 260) break;
      const big = pr <= 2;
      ctx.font = big ? "600 13px " + SERIF : "11.5px " + SANS;
      const w = ctx.measureText(s.name).width, hgt = big ? 15 : 13;
      const x = p[0] + r + 6, y = p[1];
      const box = [x - 2, y - hgt / 2, x + w + 2, y + hgt / 2];
      if (pr > 1 && placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box);
      count++;
      ctx.strokeStyle = "rgba(5,6,11,0.88)"; ctx.lineWidth = 3.4;
      ctx.strokeText(s.name, x, y);
      ctx.fillStyle = pr === 0 ? "#f3e2ad" : big ? "#efe6d2" : ownerAt(s, i) === REP ? "#e0d5bb" : "rgba(214,206,188,0.78)";
      ctx.fillText(s.name, x, y);
    }
  }
  const SERIF = getComputedStyle(document.documentElement).getPropertyValue("--serif") || "Georgia, serif";
  const SANS = getComputedStyle(document.documentElement).getPropertyValue("--sans") || "sans-serif";

  // Short playback labels on narrow screens keep the timeline on one row.
  function playLabels() {
    const short = isNarrow();
    const L = { linger: ["Linger at events", "Linger"], stop: ["Stop at events", "Stop"], steady: ["Steady", "Steady"] };
    for (const o of $("#tlPlayMode").options) if (L[o.value]) o.textContent = L[o.value][short ? 1 : 0];
  }
  function resize() {
    playLabels();
    const box = cv.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) { W = 0; H = 0; return; } // map hidden (phone reading pane)
    if (!W && pendingFrame) setTimeout(pendingFrame, 0); // first time the map becomes visible
    const nw = Math.round(box.width), nh = Math.round(box.height);
    DPR = Math.min(2, window.devicePixelRatio || 1);
    if (nw !== W || nh !== H || cv.width !== Math.round(nw * DPR)) {
      W = nw; H = nh;
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      K_MIN = Math.min(W / GB.w, H / GB.h) * 0.55;
    }
    drawTicks();
    requestRender();
  }

  // ------------------------------------------------------------ navigation
  let anim = null;
  const clampK = (k) => Math.max(K_MIN, Math.min(K_MAX, k));
  function setView(cx, cy, k) { view.cx = cx; view.cy = cy; view.k = clampK(k); requestRender(); }
  function flyTo(cx, cy, k) {
    k = clampK(k);
    if (anim) cancelAnimationFrame(anim.raf);
    if (reduceMotion || !W) { setView(cx, cy, k); return; }
    const a = { cx: view.cx, cy: view.cy, k: view.k }, t0 = performance.now(), dur = 520;
    const step = (t) => {
      const u = Math.min(1, (t - t0) / dur), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      view.k = Math.exp(Math.log(a.k) + (Math.log(k) - Math.log(a.k)) * e);
      view.cx = a.cx + (cx - a.cx) * e; view.cy = a.cy + (cy - a.cy) * e;
      draw();
      anim = u < 1 ? { raf: requestAnimationFrame(step) } : null;
    };
    anim = { raf: requestAnimationFrame(step) };
  }
  function stopAnim() { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }
  function fitBox(x0, y0, x1, y1, padPx, maxK) {
    const pd = padPx == null ? 48 : padPx;
    const w = Math.max(1, x1 - x0), hh = Math.max(1, y1 - y0);
    const k = Math.min((W - 2 * pd) / w, (H - 2 * pd) / hh, maxK || K_MAX);
    flyTo((x0 + x1) / 2, (y0 + y1) / 2, k);
  }
  function fitSystems(list, maxK) {
    if (!list.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of list) { x0 = Math.min(x0, s.wx); x1 = Math.max(x1, s.wx); y0 = Math.min(y0, s.wy); y1 = Math.max(y1, s.wy); }
    fitBox(x0, y0, x1, y1, 56, maxK);
  }
  // The République's heartland: its hyperlane-connected space around the capital.
  function repCore(i) {
    const list = SYSTEMS.filter((s) => presentAt(s, i) && ownerAt(s, i) === REP);
    const cap = SYS.get("563") && list.includes(SYS.get("563")) ? SYS.get("563") : list[0];
    if (!cap || list.length < 8) return list;
    const own = new Set(list), seen = new Set([cap]), queue = [cap];
    while (queue.length) { const u = queue.shift(); for (const v of ADJ.get(u) || []) if (own.has(v) && !seen.has(v)) { seen.add(v); queue.push(v); } }
    return seen.size >= list.length * 0.3 ? [...seen] : list;
  }
  function fitRep() {
    const list = repCore(st.idx);
    if (list.length) fitSystems(list, 6); else fitGalaxy();
  }
  function fitGalaxy() { fitBox(GB.x0, GB.y0, GB.x1, GB.y1, 24); }
  function focusSystem(id, minK) {
    const s = SYS.get(id); if (!s) return;
    const k = Math.max(view.k, minK || 3);
    flyTo(s.wx, s.wy, Math.min(k, 9));
  }
  function focusSystems(ids) {
    const list = ids.map((id) => SYS.get(id)).filter(Boolean);
    if (list.length === 1) focusSystem(list[0].id, 3);
    else if (list.length > 1) fitSystems(list, 7);
  }

  function hitTest(px, py, touch) {
    const i = st.idx, thr = touch ? 26 : 16;
    let best = null, bd = thr * thr;
    for (const s of SYSTEMS) {
      if (!presentAt(s, i)) continue;
      const p = toScreen(s.wx, s.wy);
      let d2 = (p[0] - px) ** 2 + (p[1] - py) ** 2;
      if (lastMarkers.has(s.id)) d2 *= 0.6;
      if (d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }

  // pointer: pan, pinch, tap, hover
  const ptrs = new Map();
  let drag = null, pinch = null;
  const rel = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  cv.addEventListener("pointerdown", (e) => {
    if (e.button && e.button !== 0) return;
    stopAnim();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = rel(e);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 1) drag = { x: p[0], y: p[1], cx: view.cx, cy: view.cy, moved: false, touch: e.pointerType !== "mouse" };
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k: view.k, w: toWorld(mid[0], mid[1]) };
      if (drag) drag.moved = true;
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const p = rel(e);
    if (!ptrs.has(e.pointerId)) {
      if (e.pointerType === "mouse") hover(p);
      return;
    }
    ptrs.set(e.pointerId, p);
    if (ptrs.size >= 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.k = clampK(pinch.k * d / pinch.d);
      view.cx = pinch.w[0] - (mid[0] - W / 2) / view.k;
      view.cy = pinch.w[1] - (mid[1] - H / 2) / view.k;
      requestRender();
      return;
    }
    if (drag) {
      const dx = p[0] - drag.x, dy = p[1] - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > (drag.touch ? 8 : 4)) { drag.moved = true; cv.classList.add("dragging"); hideTip(); }
      if (drag.moved) { view.cx = drag.cx - dx / view.k; view.cy = drag.cy - dy / view.k; requestRender(); }
    }
  });
  function endPtr(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = rel(e);
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1) {
      const q = [...ptrs.values()][0];
      drag = { x: q[0], y: q[1], cx: view.cx, cy: view.cy, moved: true, touch: true };
      pinch = null;
      return;
    }
    if (ptrs.size === 0) {
      if (drag && !drag.moved && e.type === "pointerup") {
        const s = hitTest(p[0], p[1], drag.touch);
        if (s) selectSystem(s.id, { fly: false, from: "map" });
      }
      drag = null; pinch = null;
      cv.classList.remove("dragging");
    }
  }
  cv.addEventListener("pointerup", endPtr);
  cv.addEventListener("pointercancel", endPtr);
  cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !ptrs.size) { st.hover = null; hideTip(); requestRender(); } });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    stopAnim();
    const p = rel(e), f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.0018));
    zoomAt(p[0], p[1], f);
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => { const p = rel(e); zoomAt(p[0], p[1], 2); });
  function zoomAt(px, py, f) {
    const w = toWorld(px, py);
    view.k = clampK(view.k * f);
    view.cx = w[0] - (px - W / 2) / view.k;
    view.cy = w[1] - (py - H / 2) / view.k;
    requestRender();
  }
  cv.addEventListener("keydown", (e) => {
    const step = 80 / view.k;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft": stopAnim(); setView(view.cx - step, view.cy, view.k); break;
      case "ArrowRight": stopAnim(); setView(view.cx + step, view.cy, view.k); break;
      case "ArrowUp": stopAnim(); setView(view.cx, view.cy - step, view.k); break;
      case "ArrowDown": stopAnim(); setView(view.cx, view.cy + step, view.k); break;
      case "+": case "=": zoomAt(W / 2, H / 2, 1.4); break;
      case "-": case "_": zoomAt(W / 2, H / 2, 1 / 1.4); break;
      case "0": fitRep(); break;
      case "Enter": case " ": {
        const s = hitTest(W / 2, H / 2, true) || nearestToCentre();
        if (s) selectSystem(s.id, { fly: true, from: "key" });
        break;
      }
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });
  function nearestToCentre() {
    let best = null, bd = Infinity;
    for (const s of SYSTEMS) { if (!presentAt(s, st.idx)) continue; const d = (s.wx - view.cx) ** 2 + (s.wy - view.cy) ** 2; if (d < bd) { bd = d; best = s; } }
    return best;
  }
  const tip = $("#tip");
  function hover(p) {
    const s = hitTest(p[0], p[1], false);
    const id = s ? s.id : null;
    cv.classList.toggle("over", !!s);
    if (id !== st.hover) { st.hover = id; requestRender(); }
    if (!s) { hideTip(); return; }
    const o = ownerAt(s, st.idx), m = lastMarkers.get(s.id);
    const bits = [];
    if (m && m.stories) bits.push(plural(m.stories, "story", "stories"));
    if (m && m.sites) bits.push(plural(m.sites, "dig site"));
    if (m && m.rifts) bits.push(plural(m.rifts, "rift"));
    fill(tip, h("b", null, s.name), h("span", null, (o ? "Held by " + cName(o) : "Unclaimed") + " · " + S[st.idx]), bits.length ? h("span", null, bits.join(" · ")) : null);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(W - tw - 8, p[0] + 14) + "px";
    tip.style.top = Math.max(8, Math.min(H - th - 8, p[1] + 14)) + "px";
  }
  function hideTip() { tip.hidden = true; }

  $("#zin").addEventListener("click", () => zoomAt(W / 2, H / 2, 1.5));
  $("#zout").addEventListener("click", () => zoomAt(W / 2, H / 2, 1 / 1.5));
  $("#zrep").addEventListener("click", fitRep);
  $("#zgal").addEventListener("click", fitGalaxy);
  $("#tterr").addEventListener("click", (e) => { st.terr = !st.terr; e.currentTarget.setAttribute("aria-pressed", String(st.terr)); renderLegend(); requestRender(); });
  $("#tlab").addEventListener("click", (e) => { st.labels = !st.labels; e.currentTarget.setAttribute("aria-pressed", String(st.labels)); requestRender(); });

  // ============================================================ selection
  function selectSystem(id, opt) {
    opt = opt || {};
    if (!SYS.has(id)) return;
    if (opt.from === "panel" && opt.fly) showMapOnPhone();
    st.sys = id; st.planet = opt.planet || null;
    st.entry = null; st.event = null;
    if (opt.fly) focusSystem(id, 3);
    const s = SYS.get(id), list = (entriesAt.get(id) || []).filter((e) => !notYet(e));
    // A system with exactly one curated story opens that story directly.
    const cur = list.filter(curated);
    if (opt.from === "map" && cur.length === 1 && !opt.planet) st.entry = cur[0].id;
    live((st.entry ? ENT.get(st.entry).title + ", " : "") + s.name + " selected.");
    showTab("story", { focus: opt.from === "panel" });
    openSheet();
    update();
  }
  function openEntry(id, opt) {
    opt = opt || {};
    const e = ENT.get(id); if (!e) return;
    st.entry = id; st.planet = e.planet || null;
    if (!opt.keepEvent) st.event = null;
    if (opt.date != null) setIdx(opt.date, { quiet: true });
    else if (!opt.keepDate) {
      // If the place is not on the map at this date, move to the first save
      // that shows it (the place's own first observation, not a story milestone).
      const loc = entryLoc(e, st.idx);
      if (e.track && e.track.length && !loc) { setIdx(e.track[0][0], { quiet: true }); live("Map moved to " + S[st.idx] + ", the first save that records its position."); }
      else if (loc && !presentAt(SYS.get(loc), st.idx)) { const f = firstPresent(SYS.get(loc)); if (f != null) { setIdx(f, { quiet: true }); live("Map moved to " + S[f] + ", the first save in which " + SYS.get(loc).name + " appears."); } }
    }
    const loc = entryLoc(e, st.idx) || e.system;
    st.sys = loc && SYS.has(loc) ? loc : null;
    if (opt.fly !== false && !isPerson(e)) {
      const extra = e.links.filter((l) => SYS.has(l));
      if (st.sys && opt.fitLinks && extra.length) focusSystems([st.sys, ...extra]);
      else if (st.sys) focusSystem(st.sys, 2.6);
      else if (extra.length) focusSystems(extra);
    }
    if (opt.from !== "journey") live(e.title + " opened.");
    showTab("story", { focus: opt.from === "panel" });
    openSheet();
    update();
  }
  function selectEvent(id, opt) {
    const ev = EVT.get(id); if (!ev) return;
    const w = when(ev);
    st.playGroup = null;
    if (w.idx != null) setIdx(w.idx, { quiet: true });
    st.event = id;
    const entId = ev.ent[0];
    if (entId) {
      openEntry(entId, { keepEvent: true, fly: false, from: opt && opt.from, date: w.idx });
      const e = ENT.get(entId);
      if (ev.sys.length) st.sys = ev.sys.includes(entryLoc(e, st.idx)) ? entryLoc(e, st.idx) : ev.sys[0];
    } else {
      st.entry = null;
      st.sys = ev.sys[0] || null;
      showTab("story", { focus: opt && opt.from === "panel" });
      openSheet();
    }
    if (ev.sys.length) focusSystems(ev.sys);
    else if (st.sys) focusSystem(st.sys, 2.6);
    live("Event: " + (ev.t || "record") + ". " + w.note);
    update();
  }

  // ============================================================== timeline
  const range = $("#tlRange");
  range.max = String(LAST);
  let playTimer = null;
  function setIdx(i, opt) {
    i = clampIdx(i);
    if (i === st.idx && !(opt && opt.force)) return;
    st.idx = i;
    if (!(opt && opt.quiet)) update();
  }
  // A user scrub: any selected event or paused group that no longer matches the
  // map date is cleared, so the banner never describes a different save.
  function scrub(i) {
    i = clampIdx(i);
    const ev = st.event && EVT.get(st.event);
    if (ev && when(ev).idx !== i) st.event = null;
    if (st.playGroup && st.playGroup.idx !== i) st.playGroup = null;
    setIdx(i, { force: true });
  }
  // Dragging: readouts, ticks and the exact map update at once; the panel and
  // territory shading follow when the slider settles (release or a pause).
  let scrubbing = false, settleTimer = null;
  function settle() { clearTimeout(settleTimer); settleTimer = null; if (!scrubbing) return; scrubbing = false; update(); }
  range.addEventListener("input", () => { stopPlay(true); scrubbing = true; clearTimeout(settleTimer); settleTimer = setTimeout(settle, 220); scrub(+range.value); });
  range.addEventListener("change", settle);
  $("#tlPrev").addEventListener("click", () => { stopPlay(true); scrub(st.idx - 1); });
  $("#tlNext").addEventListener("click", () => { stopPlay(true); scrub(st.idx + 1); });
  $("#tlLatest").addEventListener("click", () => { stopPlay(true); scrub(LAST); });
  $("#tlPlay").addEventListener("click", () => { if (playTimer) stopPlay(); else startPlay(); });

  // Playback: steady stepping, or lingering/stopping at grouped headline events.
  const BASE_MS = 420;
  function playGroupAt(i) {
    const seen = new Set(), list = [];
    for (const e of EVENTS) {
      if (e.undated || e.minor || when(e).idx !== i || !eventFiltered(e)) continue;
      const key = norm(e.t);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(e);
    }
    list.sort((a, b) => (b.ent.some((id) => curated(ENT.get(id))) ? 1 : 0) - (a.ent.some((id) => curated(ENT.get(id))) ? 1 : 0));
    return list;
  }
  function setPlayButton(on) {
    const b = $("#tlPlay");
    b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "❚❚" : "▶";
    b.setAttribute("aria-label", on ? "Pause playback" : "Play through the saved observations");
  }
  function startPlay() {
    if (st.idx >= LAST) scrub(0);
    st.event = null;
    setPlayButton(true);
    const tick = () => {
      if (st.idx >= LAST) { stopPlay(); return; }
      const next = st.idx + 1;
      st.playGroup = null;
      st.event = null;
      const group = st.playMode === "steady" ? [] : playGroupAt(next);
      if (group.length) st.playGroup = { idx: next, list: group };
      setIdx(next, { force: true });
      if (group.length && st.playMode === "stop") { stopPlay(true); live("Paused at " + S[next] + ": " + group.map((e) => e.t).join("; ")); return; }
      const dwell = group.length ? Math.max(1500, BASE_MS * 3) / Math.sqrt(st.speed) : BASE_MS / st.speed;
      playTimer = setTimeout(tick, dwell);
    };
    playTimer = setTimeout(tick, 60);
  }
  function stopPlay(keepGroup) {
    if (!playTimer) return;
    clearTimeout(playTimer); playTimer = null;
    setPlayButton(false);
    if (!keepGroup) st.playGroup = null;
    update();
  }
  $("#tlSpeed").addEventListener("change", (e) => { st.speed = +e.target.value || 1; });
  $("#tlPlayMode").addEventListener("change", (e) => { st.playMode = e.target.value; });

  function stepEvent(dir) {
    const list = chronList().filter((e) => when(e).idx != null);
    if (!list.length) return;
    const cur = st.event ? list.findIndex((e) => e.id === st.event) : -1;
    let next;
    if (cur >= 0) next = list[cur + dir];
    else if (dir > 0) next = list.find((e) => when(e).idx > st.idx) || list.find((e) => when(e).idx >= st.idx);
    else next = [...list].reverse().find((e) => when(e).idx < st.idx);
    if (next) selectEvent(next.id, { from: "timeline" });
    else live(dir > 0 ? "No later event under the current filters." : "No earlier event under the current filters.");
  }
  $("#evPrev").addEventListener("click", () => { stopPlay(true); stepEvent(-1); });
  $("#evNext").addEventListener("click", () => { stopPlay(true); stepEvent(1); });
  $("#tlPreYear").textContent = yearOf(S[0]);
  function preCount() { return EVENTS.filter((e) => e.d && dnum(e.d) < SN[0] && eventFiltered(e)).length; }
  $("#tlPre").addEventListener("click", () => {
    stopPlay(true);
    scrub(0);
    showTab("chron");
    openSheet();
    const g = $("#chron-pre");
    if (g) g.scrollIntoView({ block: "start" });
    live("Showing events dated before " + S[0] + ". The map shows the earliest available observation, " + S[0] + ".");
  });

  // reading mode
  function setMode(m) {
    st.mode = m === "through" ? "through" : "complete";
    for (const b of document.querySelectorAll("#modeSeg [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === st.mode));
    live(st.mode === "through" ? "History through " + S[st.idx] + ": later records are held back." : "Complete history: every retained record is shown.");
    update();
  }
  $("#modeSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
  $("#modeSeg").addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = st.mode === "complete" ? "through" : "complete"; setMode(n); $("#modeSeg [data-mode=" + n + "]").focus(); }
  });

  const ticks = $("#tlTicks");
  const THUMB = 9;
  const xForDate = (n, w) => THUMB + (n - SN[0]) / Math.max(1, SN[LAST] - SN[0]) * (w - 2 * THUMB);
  function drawTicks() {
    const box = ticks.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width)), hh = Math.max(1, Math.round(box.height)), dpr = Math.min(2, window.devicePixelRatio || 1);
    ticks.width = w * dpr; ticks.height = hh * dpr;
    const g = ticks.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    g.fillStyle = "rgba(239,230,210,0.07)";
    g.fillRect(THUMB, hh / 2 - 1, w - 2 * THUMB, 2);
    if (through()) { // the part of the archive held back in this reading mode
      const x = xForDate(SN[st.idx], w);
      g.fillStyle = "rgba(5,6,11,0.55)";
      g.fillRect(x, 0, w - x, hh);
    }
    const local = st.sys ? new Set((eventsAt.get(st.sys) || []).map((e) => e.id)) : null;
    const list = EVENTS.filter((e) => !e.undated && (e.d ? dnum(e.d) >= SN[0] : e.b) && eventVisible(e));
    for (const pass of [0, 1]) for (const e of list) {
      const isLocal = local && local.has(e.id);
      if ((pass === 1) !== !!isLocal) continue;
      g.globalAlpha = local ? (isLocal ? 1 : 0.22) : e.minor ? 0.45 : 0.75;
      g.fillStyle = isLocal ? "#f3e2ad" : catColor(e.cat);
      if (e.d) { const x = xForDate(dnum(e.d), w); g.fillRect(x - 0.6, isLocal ? 2 : 5, isLocal ? 2 : 1.2, isLocal ? hh - 4 : hh - 10); }
      else {
        const xb = xForDate(dnum(e.b), w), xa = e.a ? xForDate(dnum(e.a), w) : xb - 2;
        g.fillRect(xa, isLocal ? hh - 7 : hh - 6, Math.max(1.5, xb - xa), isLocal ? 4 : 2.5);
      }
    }
    const mark = st.event ? EVT.get(st.event) : st.playGroup ? st.playGroup.list[0] : null;
    if (mark && (mark.d || mark.b)) {
      const n = mark.d ? Math.max(SN[0], dnum(mark.d)) : dnum(mark.b), x = xForDate(n, w);
      g.globalAlpha = 1; g.fillStyle = "#c8655a"; g.fillRect(x - 1, 0, 2, hh);
    }
    g.globalAlpha = 1;
    const years = $("#tlYears");
    years.replaceChildren();
    const y0 = Math.ceil(+yearOf(S[0]) / 20) * 20, y1 = +yearOf(S[LAST]);
    const stepY = w < 420 ? 40 : 20;
    for (let y = y0; y <= y1; y += stepY) years.append(h("span", { style: "left:" + xForDate(dnum(y + ".01.01"), w) + "px" }, String(y)));
    const pc = preCount();
    $("#tlPreN").textContent = pc ? plural(pc, "event") : "none";
  }

  // ================================================================ panels
  const TABS = ["story", "index", "chron", "journeys", "sources"];
  function showTab(tab, opt) {
    if (!TABS.includes(tab)) tab = "story";
    st.tab = tab;
    for (const t of TABS) {
      const b = $("#tab-" + t), p = $("#p-" + t);
      b.setAttribute("aria-selected", String(t === tab));
      b.tabIndex = t === tab ? 0 : -1;
      p.hidden = t !== tab;
    }
    $("#filters").hidden = !(tab === "index" || tab === "chron");
    renderFilters();
    renderPanel(tab);
    if (opt && opt.focus) {
      const target = $("#p-" + tab + " h2");
      if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
    }
    const panels = $("#panels");
    panels.scrollTop = 0;
    if (tab === "chron" && st.idx > 0) {
      const t = $("#p-chron [data-after]");
      if (t) panels.scrollTop = Math.max(0, t.offsetTop - panels.offsetTop - 60);
    }
    syncHash();
  }
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { showTab(b.dataset.tab); openSheet(); } });
  $("#tabs").addEventListener("keydown", (e) => {
    const ix = TABS.indexOf(st.tab);
    let n = null;
    if (e.key === "ArrowRight") n = TABS[(ix + 1) % TABS.length];
    else if (e.key === "ArrowLeft") n = TABS[(ix + TABS.length - 1) % TABS.length];
    else if (e.key === "Home") n = TABS[0];
    else if (e.key === "End") n = TABS[TABS.length - 1];
    if (n) { e.preventDefault(); showTab(n); $("#tab-" + n).focus(); }
  });
  function renderPanel(tab) {
    const p = $("#p-" + tab);
    if (tab === "story") fill(p, storyPanel());
    else if (tab === "index") fill(p, indexPanel());
    else if (tab === "chron") fill(p, chronPanel());
    else if (tab === "journeys") fill(p, journeysPanel());
    else if (tab === "sources") fill(p, sourcesPanel());
  }

  // mobile bottom sheet
  const drawer = $("#drawer");
  // Phone panes: "peek"/"half" keep the map in view; "full" is the reading
  // pane (map and timeline hidden, reading bar with a way back to the map).
  function setSheet(s) {
    drawer.dataset.sheet = s;
    document.body.classList.toggle("pane-read", s === "full" && isPhone());
    updateReadbar();
    syncHash();
    $("#sheetHandle").setAttribute("aria-expanded", String(s !== "peek"));
    $("#sheetHandle").setAttribute("aria-label", s === "full" ? "Shrink the story panel" : "Expand the story panel");
    setTimeout(resize, 260);
  }
  function openSheet() { if (isNarrow() && drawer.dataset.sheet === "peek") setSheet("half"); }
  const reading = () => isPhone() && drawer.dataset.sheet === "full";
  function showMapOnPhone() {
    if (!reading()) return;
    setSheet("half");
    if (st.sys) setTimeout(() => focusSystem(st.sys, 2.6), 280);
  }
  function updateReadbar() {
    const e = st.entry && ENT.get(st.entry), sys = st.sys && SYS.get(st.sys);
    const tabName = { story: "Récit", index: "Index", chron: "Chronique", journeys: "Parcours", sources: "Sources" }[st.tab];
    $("#rbTitle").textContent = st.tab === "story" ? (e ? e.title : sys ? sys.name : "Atlas de la Continuité") : tabName;
    $("#rbDate").textContent = S[st.idx];
    $("#rbDate").setAttribute("aria-label", "Map date " + S[st.idx] + ". Show the map");
  }
  $("#rbRead").addEventListener("click", () => { setSheet("full"); $("#panels").focus({ preventScroll: true }); });
  $("#rbMap").addEventListener("click", () => { setSheet("half"); if (st.sys) setTimeout(() => focusSystem(st.sys, 2.6), 280); $("#rbRead").focus({ preventScroll: true }); });
  $("#rbDate").addEventListener("click", () => { setSheet("half"); $("#tlRange").focus({ preventScroll: true }); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && reading() && document.activeElement !== q) { e.preventDefault(); setSheet("half"); $("#rbRead").focus({ preventScroll: true }); }
  });
  $("#tlMore").addEventListener("click", (e) => {
    const tl = $("#timeline"), open = !tl.classList.contains("opts-open");
    tl.classList.toggle("opts-open", open);
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  $("#sheetHandle").addEventListener("click", () => {
    const s = drawer.dataset.sheet;
    setSheet(s === "peek" ? "half" : s === "half" ? "full" : "peek");
  });
  (() => {
    let y0 = null;
    const hd = $("#sheetHandle");
    hd.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    hd.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0; y0 = null;
      if (Math.abs(dy) < 24) return;
      const order = ["peek", "half", "full"], ix = order.indexOf(drawer.dataset.sheet);
      setSheet(order[Math.max(0, Math.min(2, ix + (dy < 0 ? 1 : -1)))]);
    });
  })();

  // ---------------------------------------------------------- shared bits
  function placeButton(sid, opt) {
    const s = SYS.get(sid); if (!s) return null;
    const o = ownerAt(s, st.idx), pres = presentAt(s, st.idx);
    return h("button", { type: "button", class: "place", onclick: () => selectSystem(sid, { fly: true, from: "panel", planet: opt && opt.planet }), "aria-label": "Show " + s.name + " on the map" },
      dot(pres ? cColor(o) : "transparent"), (opt && opt.label) || s.name,
      h("em", null, pres ? (o ? cName(o) : "unclaimed") + " at " + S[st.idx] : "not in the saves at " + S[st.idx]));
  }
  function bodyAt(b, i) {
    const x = b[3] || {};
    const okName = (n) => n && !/^CONTFR_|^[A-Z0-9_]{6,}$/.test(n);
    let name = valueAt(normRuns(x.n), i, b[1]);
    if (!okName(name)) name = okName(b[1]) ? b[1] : "Unnamed world";
    const cls = valueAt(normRuns(x.c), i, b[2]) || "World";
    const or = runAt(normRuns(x.o), i);
    return { id: String(b[0]), name, cls, colony: or ? ownerOk(or[2]) : null, moon: !!x.m, changed: !!((x.c && x.c.length > 1) || (x.n && x.n.length > 1)), flags: x.f || [], hasColonyHistory: !!(x.o && x.o.length) };
  }
  // A details block whose content arrives with the deferred evidence part.
  function lazyDetails(summary, build) {
    const d = h("details", { class: "ev" }, h("summary", null, summary), h("p", { class: "note" }, "Loading the evidence…"));
    d.addEventListener("toggle", function load() {
      if (!d.open) return;
      d.removeEventListener("toggle", load);
      ensurePart("evidence").then(() => {
        const n = build();
        if (n) { n.open = true; d.replaceWith(n); } else d.remove();
      }).catch((err) => {
        fill(d, h("summary", null, summary), h("p", { class: "note" }, "The evidence could not be loaded" + (navigator.onLine === false ? " while offline" : "") + ". ", h("button", { type: "button", class: "linkish", onclick: () => { d.open = false; d.addEventListener("toggle", load); d.open = true; } }, "Try again")));
      });
    });
    return d;
  }
  function srcDetails(o, label) {
    if (!o) return null;
    if (o.src !== undefined || PARTS.evidence || !o.srcN) return sourcesDetails(o.src, label);
    return lazyDetails((label || "Evidence") + " (" + o.srcN + ")", () => sourcesDetails(o.src, label));
  }
  function sourcesDetails(src, label) {
    const items = (src || []).filter((s) => s != null && s !== "");
    if (!items.length) return null;
    return h("details", { class: "ev" }, h("summary", null, (label || "Evidence") + " (" + items.length + ")"),
      h("ul", null, items.map((s) => typeof s === "string" ? h("li", null, h("span", { class: "src-r" }, s)) : h("li", null, s.l ? h("span", { class: "src-l" }, s.l) : null, s.r ? h("span", { class: "src-r" }, s.r) : null))));
  }
  // "Why we say this": bounded source excerpts with their path/hash underneath.
  function excerptView(x) {
    if (!x) return null;
    const src = x.source || {};
    const partShown = (part) => {
      if (!through()) return true;
      if (isIdx(part.gate_idx)) return part.gate_idx <= st.idx;
      const dates = [part.snapshot || "", part.label || ""].join(" ").match(/\b\d{4}\.\d{2}\.\d{2}\b/g) || [];
      return dates.every((date) => dnum(date) <= dnum(S[st.idx]));
    };
    const allRows = Array.isArray(x.rows) ? x.rows : [];
    const rows = allRows.filter(partShown);
    const table = rows.length ? h("div", { class: "x-table" }, h("table", null,
      Array.isArray(x.columns) && x.columns.length ? h("thead", null, h("tr", null, h("th", null, ""), x.columns.map((c) => h("th", null, String(c))))) : null,
      h("tbody", null, rows.slice(0, 12).map((r) => h("tr", null, h("th", null, r.label != null ? String(r.label) : ""), (r.values || []).map((v) => h("td", null, v == null ? "—" : String(v)))))))) : null;
    const ba = (o, lab) => o && typeof o === "object" && partShown(o) ? h("div", { class: "x-ba" }, h("b", null, (o.label || lab) + (o.snapshot ? " · " + o.snapshot : "")),
      h("ul", null, Object.entries(o.values || {}).map(([k, v]) => h("li", null, h("code", null, k), " ", v == null ? "—" : String(v))))) : null;
    return h("div", { class: "excerpt" },
      x.title ? h("div", { class: "x-title" }, x.title) : null,
      x.note ? h("p", { class: "x-note" }, x.note) : null,
      x.text ? h("blockquote", null, x.text) : null,
      table, ba(x.before, "Before"), ba(x.after, "After"),
      rows.length < allRows.length ? h("p", { class: "x-note" }, plural(allRows.length - rows.length, "later evidence row") + " held back in this reading mode.") : null,
      h("p", { class: "x-src" }, src.path ? h("code", null, src.path) : null, src.snapshot ? " · save " + src.snapshot : null, src.field ? [" · ", h("code", null, src.field)] : null, src.sha256 ? " · sha256 " + String(src.sha256).slice(0, 12) + "…" : null));
  }
  // An excerpt is gated by its own gate_idx, else by the save it quotes.
  function excerptGate(x) {
    if (isIdx(x.gate_idx)) return x.gate_idx;
    const snap = x.source && x.source.snapshot;
    return snap && /^\d{4}\.\d\d\.\d\d$/.test(String(snap)) ? idxOfDate(snap) : null;
  }
  function whyDetails(ids, label, gateFor) {
    const list = (ids || []).map((id) => EXCERPTS[id]).filter((x) => x && shownAt(excerptGate(x)) && (!gateFor || shownAt(gateFor(x))));
    if (!list.length) return null;
    return h("details", { class: "ev why" }, h("summary", null, (label || "Why we say this") + (list.length > 1 ? " (" + list.length + ")" : "")), list.map(excerptView));
  }
  function badge(kind, text) { return h("span", { class: "badge b-" + kind }, text || BADGE[kind] || "Record"); }
  function catsLine(cats) {
    const list = cats.filter((c) => CAT.has(c));
    if (!list.length) return null;
    return h("p", { class: "cats" }, list.map((c) => h("span", null, dot(catColor(c)), CAT.get(c).en)));
  }
  function dateBox() {
    return h("p", { class: "datebox" },
      "Map date ", h("b", null, S[st.idx]), " · saved observation " + (st.idx + 1) + " of " + N + ". Ownership, world classes and presence are as of this save; ",
      through() ? "records after it are held back." : "the story text covers the whole archive.");
  }
  function throughNote() {
    if (!through()) return null;
    return h("div", { class: "modebar", role: "note" },
      h("b", null, h("span", { lang: "fr" }, "Lecture au " + S[st.idx]), " · History through this date"),
      h("p", null, "Only records the archive retains by this save are shown. This is the saved evidence, not exactly what the player knew at the time: some facts were recorded later than they happened, and the saves do not capture fog of war."),
      h("button", { type: "button", class: "linkish", onclick: () => setMode("complete") }, "Show the complete history"));
  }

  // --------------------------------------------------------------- story
  function storyPanel() {
    const out = [];
    const ev = st.event && EVT.get(st.event);
    if (ev) out.push(eventBar(ev));
    else if (st.playGroup) out.push(groupBar(st.playGroup));
    const jb = journeyBar();
    if (jb) out.push(jb);
    out.push(throughNote());
    if (st.entry && ENT.has(st.entry)) out.push(...entryView(ENT.get(st.entry)));
    else if (st.sys && SYS.has(st.sys)) out.push(...systemView(SYS.get(st.sys)));
    else out.push(...welcomeView());
    return out;
  }
  function eventBar(ev) {
    const w = when(ev);
    return h("div", { class: "evbar", role: "note" },
      h("div", { class: "eb-k" }, ev.minor ? "Chronicle record (routine)" : "Chronicle event"),
      h("div", { class: "eb-t" }, titleOf(ev.t)),
      h("div", { class: "eb-row" }, badge(ev.k === "interval" ? "interval" : ev.k === "lore" ? "lore" : "save", w.badge), h("b", null, w.label)),
      h("p", { class: "small muted", style: "margin:6px 0 0" }, w.note),
      whyDetails(ev.x),
      srcDetails(ev, "Event evidence"),
      h("div", { class: "eb-row" },
        h("button", { type: "button", class: "btn", onclick: () => showTab("chron") }, "Back to the chronicle"),
        h("button", { type: "button", class: "btn", onclick: () => { st.event = null; update(); } }, "Dismiss")));
  }
  function groupBar(g) {
    return h("div", { class: "evbar", role: "note" },
      h("div", { class: "eb-k" }, "Playback · " + S[g.idx]),
      h("ul", { class: "grp" }, g.list.slice(0, 6).map((e) => h("li", null, h("button", { type: "button", class: "linkish", onclick: () => { stopPlay(true); selectEvent(e.id, { from: "panel" }); } }, titleOf(e.t)), h("span", { class: "small muted" }, " · " + when(e).label)))),
      g.list.length > 6 ? h("p", { class: "small muted" }, "+" + (g.list.length - 6) + " more in the chronicle") : null,
      h("div", { class: "eb-row" },
        playTimer ? null : h("button", { type: "button", class: "btn primary", onclick: () => startPlay() }, "Continue playback"),
        h("button", { type: "button", class: "btn", onclick: () => { st.playGroup = null; update(); } }, "Dismiss")));
  }
  function journeyBar() {
    const j = st.journey && JRN.get(st.journey);
    if (!j) return null;
    const steps = stepsOf(j);
    const i = st.entry ? steps.findIndex((s) => s.entry === st.entry) : -1;
    if (i < 0) return null;
    const info = steps[i];
    return h("div", { class: "jbar", role: "navigation", "aria-label": "Journey" },
      h("div", { class: "jrow" },
        h("button", { type: "button", class: "btn", disabled: i === 0, "aria-label": "Previous step", onclick: () => journeyStep(i - 1) }, "‹"),
        h("div", { class: "jt" }, h("span", { class: "small muted" }, h("span", { lang: "fr" }, "Parcours"), " · step " + (i + 1) + " of " + steps.length), h("b", null, j.title)),
        h("button", { type: "button", class: "btn", disabled: i >= steps.length - 1, "aria-label": "Next step", onclick: () => journeyStep(i + 1) }, "›")),
      h("div", { class: "jrow small" }, stepDateLabel(info), followSeg()),
      info.note ? h("p", { class: "small muted", style: "margin:4px 0 0" }, shownAt(isIdx(info.idx) ? info.idx : null) ? info.note : "This step's later history is held back until " + S[info.idx] + ".") : null);
  }
  function followSeg() {
    return h("div", { class: "seg seg-sm", role: "radiogroup", "aria-label": "Journey date behaviour" },
      h("button", { type: "button", role: "radio", "aria-checked": String(st.follow), onclick: () => { st.follow = true; update(); } }, "Follow story dates"),
      h("button", { type: "button", role: "radio", "aria-checked": String(!st.follow), onclick: () => { st.follow = false; update(); } }, "Keep map date"));
  }

  function entryView(e) {
    const kind = kindOf(e);
    const loc = entryLoc(e, st.idx);
    const out = [];
    out.push(h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, kind.fr), " · " + kind.en));
    out.push(h("h2", { id: "entry-title" }, e.title || "Untitled"));
    if (e.fr) out.push(h("p", { class: "fr", lang: "fr" }, e.fr));
    if (notYet(e)) {
      const f = entryFirstIdx(e);
      out.push(h("div", { class: "datebox warn" },
        h("b", null, "Not yet observed"), " at " + S[st.idx] + ". The archive's first record of this " + (isRecord(e) ? "record" : "story") + " is in the " + S[f] + " save.",
        h("div", { class: "eb-row" }, h("button", { type: "button", class: "btn primary", onclick: () => scrub(f) }, "Go to " + S[f]), h("button", { type: "button", class: "btn", onclick: () => setMode("complete") }, "Read the complete history"))));
      return out;
    }
    const where = [];
    if (loc) where.push(placeButton(loc)); else if (e.system) where.push(placeButton(e.system));
    if (e.planet && BODY.has(e.planet)) {
      const { s, b } = BODY.get(e.planet), ba = bodyAt(b, st.idx);
      where.push(h("button", { type: "button", class: "place", onclick: () => selectSystem(s.id, { fly: true, from: "panel", planet: e.planet }), "aria-label": "Show " + ba.name + " in " + s.name },
        dot(ba.colony ? cColor(ba.colony) : "rgba(239,230,210,0.35)"), ba.name, h("em", null, ba.cls + " at " + S[st.idx])));
    }
    if (where.length) out.push(h("div", { class: "where" }, where));
    if (isPerson(e)) out.push(h("p", { class: "note" }, "No map location: this entry is about " + (e.kind === "person" ? "a person" : "an institution") + ", so the map is left as it is." + (e.links.length ? " Linked places are listed below." : "")));
    else if (!where.length && !e.links.length) out.push(h("p", { class: "note" }, "No map location is recorded for this entry."));
    if (e.track && !loc) out.push(h("p", { class: "note" }, "Not yet observed at " + S[st.idx] + "; its first recorded position is in the " + S[e.track[0][0]] + " save."));
    if (e.role) out.push(h("p", { class: "role" }, rich(e.role)));
    if (e.aka.length) out.push(h("p", { class: "note" }, "Also known as ", e.aka.map((a, k) => [k ? ", " : "", h("span", { class: "aka" }, a)])));
    out.push(catsLine(e.cats));
    if (e.illustration && typeof e.illustration === "object") out.push(illustration(e.illustration));
    if (e.lede) out.push(ledeShown(e) ? h("p", { class: "lede" }, rich(e.lede)) : h("p", { class: "note withheld" }, "Summary held back: it covers records after " + S[st.idx] + "."));
    out.push(dateBox());
    const status = statusBlock(e);
    if (status) out.push(status);
    // Person/institution status rows: save values describe a dated save
    // (latest by default), so they are held back before it.
    const statusGate = (x) => (isIdx(x.gate_idx) ? x.gate_idx : x.b === "save" ? idxOfDate(META.archive_cutoff || S[LAST]) : null);
    const statusRows = Array.isArray(e.status) ? e.status.filter((x) => x && x.label && shownAt(statusGate(x))) : [];
    if (Array.isArray(e.status) && e.status.length > statusRows.length) out.push(h("p", { class: "note withheld" }, plural(e.status.length - statusRows.length, "status value") + " from a later save held back."));
    if (statusRows.length) {
      out.push(h("dl", { class: "dl pstatus" }, statusRows.map((x) => [h("dt", null, x.label, x.b ? [" ", badge(x.b)] : null), h("dd", null, x.value == null ? "—" : String(x.value))])));
    }
    let held = 0;
    for (const p of e.body) {
      if (!p || !p.t) continue;
      const gate = paraGate(p, e);
      if (!shownAt(gate)) { held++; continue; }
      const k = BADGE[p.b] ? p.b : "save";
      out.push(h("div", { class: "para k-" + k },
        badge(k), k === "proposal" ? h("span", { class: "pnote" }, "not established as enacted") : null,
        k === "lore" && through() ? h("span", { class: "pnote bg" }, "background, not dated") : null,
        h("p", null, rich(p.t)),
        whyDetails(p.x),
        srcDetails(p, "Sources")));
    }
    if (held) out.push(h("p", { class: "note withheld" }, plural(held, "paragraph") + " describing later history " + (held === 1 ? "is" : "are") + " held back until the saves establish " + (held === 1 ? "it" : "them") + ". ", h("button", { type: "button", onclick: () => setMode("complete") }, "Show the complete history")));
    out.push(whyDetails(e.excerpts, "Why we say this"));
    if (e.track && e.track.length) out.push(trackSection(e));
    if (e.chapters.length) out.push(...choicesSection(e));
    if (e.facts.length) out.push(...factsSection(e));
    if (e.links.length) {
      out.push(h("h3", null, h("span", { lang: "fr" }, "Lieux"), h("small", null, "Places in this story")));
      out.push(h("div", { class: "where" }, e.links.map((l) => placeButton(l))));
      if (e.links.length > 1) out.push(h("p", { class: "note" }, h("button", { type: "button", onclick: () => focusSystems([...(loc ? [loc] : []), ...e.links]) }, "Frame all of these places on the map")));
    }
    const rel = e.related.map((r) => (String(r).startsWith("journey:") ? { j: JRN.get(String(r).slice(8)) } : { e: ENT.get(r) })).filter((x) => x.j || x.e);
    const back = (relatedBy.get(e.id) || []).filter((x) => !e.related.includes(x.id));
    if (rel.length) {
      out.push(h("h3", null, h("span", { lang: "fr" }, isPerson(e) ? "Épisodes" : "Récits liés"), h("small", null, isPerson(e) ? "Episodes and places" : "Related")));
      out.push(h("ul", { class: "cards" }, rel.map((x) => h("li", null, x.e ? entryCard(x.e) : journeyCard(x.j)))));
    }
    if (back.length) {
      out.push(h("h3", null, h("span", { lang: "fr" }, "Cité dans"), h("small", null, "Mentioned by")));
      out.push(h("ul", { class: "cards" }, back.map((x) => h("li", null, entryCard(x)))));
    }
    const sid = loc || e.system;
    if (sid && SYS.has(sid)) {
      const n = (eventsAt.get(sid) || []).filter(eventVisible).length;
      out.push(h("p", { class: "note", style: "margin-top:22px" },
        h("button", { type: "button", onclick: () => { st.entry = null; st.sys = sid; update(); } }, "About the " + SYS.get(sid).name + " system"),
        n ? [" · ", h("button", { type: "button", onclick: () => { st.sys = sid; st.local = true; showTab("chron"); } }, plural(n, "chronicle event") + " here")] : null));
    }
    const ids = [["Record", e.id]];
    if (e.ids) for (const [k, v] of Object.entries(e.ids)) if (v != null && v !== "") ids.push([k, v]);
    if (e.life && isIdx(e.life.first_idx)) ids.push(["First archive observation", S[e.life.first_idx]]);
    if (e.life && isIdx(e.life.last_idx)) ids.push(["Last archive observation", S[e.life.last_idx]]);
    out.push(h("details", { class: "ev" }, h("summary", null, "Record identifiers"), h("ul", null, ids.map(([k, v]) => h("li", null, h("span", { class: "src-l" }, k + ": "), h("code", null, String(v)))))));
    return out;
  }
  function illustration(il) {
    const src = String(il.src || "");
    // Only embedded images or files shipped beside the page; never a network URL.
    if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(src) && !/^(?![a-z][\w+.-]*:)(?!\/\/)[\w./%-]+\.(png|jpe?g|webp|gif|svg)$/i.test(src)) return null;
    if (!shownAt(isIdx(il.gate_idx) ? il.gate_idx : null)) return null;
    const fig = h("figure", { class: "illus" },
      h("img", { src, alt: il.alt || "", loading: "lazy", decoding: "async", width: il.width || null, height: il.height || null }),
      h("figcaption", null, h("span", { class: "badge b-interpretation" }, "Artistic interpretation"), il.caption ? " " + String(il.caption).replace(/^Artistic interpretation[.:]?\s*/i, "") : null));
    const img = fig.querySelector("img");
    img.addEventListener("error", () => fig.remove());
    return fig;
  }
  // Status at the selected save, from lifecycle runs (v2) or, for v1 data, the
  // latest dated fact available by then. Never a summary of later records.
  function statusBlock(e) {
    const refs = [e, ...(e.life_refs || []).map((r) => ENT.get(r)).filter(Boolean)];
    const rows = [];
    for (const r of refs) {
      const life = r.life;
      if (!life || !Array.isArray(life.runs)) continue;
      for (const run of life.runs) {
        if (!(run.from <= st.idx && st.idx <= run.to) || !run.label) continue;
        const field = { status: "Status", stage: "Stage", explorer: "Explorer", excavator: "Excavator", owner: "Holder" }[run.field] || "Record";
        const visibleTo = Math.min(run.to, through() ? st.idx : run.to);
        rows.push(h("li", null, refs.length > 1 ? h("b", null, r.title + " · ") : null, h("span", { class: "s-f" }, field + ": "), run.label, h("span", { class: "r-d" }, " · " + S[run.from] + (visibleTo !== run.from ? " → " + S[visibleTo] : ""))));
      }
      if (isIdx(life.first_idx) && st.idx < life.first_idx && r !== e) rows.push(h("li", null, h("b", null, r.title + ": "), "not yet observed (first archive observation " + S[life.first_idx] + ")"));
    }
    if (!rows.length) {
      if (!through()) return null;
      const avail = e.facts.filter((f) => !f.minor && factIdx(f) != null && factIdx(f) <= st.idx);
      const last = avail[avail.length - 1];
      if (!last) return null;
      rows.push(h("li", null, titleOf(last.t), h("span", { class: "r-d" }, " · " + when(last).label)));
      return h("section", { class: "status" }, h("div", { class: "eb-k" }, "Latest record by " + S[st.idx]), h("ul", null, rows));
    }
    return h("section", { class: "status" }, h("div", { class: "eb-k" }, "Status at " + S[st.idx]), h("ul", null, rows));
  }
  function trackSection(e) {
    const cur = runAt(e.track, st.idx);
    const runs = e.track.filter((r) => shownAt(r[0]));
    return h("section", null,
      h("h3", null, h("span", { lang: "fr" }, "Positions consignées"), h("small", null, "Recorded positions")),
      h("p", { class: "note" }, "Where the saves place it. Each row runs from the first to the last save that shows it there."),
      runs.length ? h("ul", { class: "runs" }, runs.map((r) => {
        const s = SYS.get(String(r[2]));
        const to = through() ? Math.min(r[1], st.idx) : r[1];
        return h("li", { class: cur === r ? "cur" : null },
          h("span", { class: "r-v" }, s ? h("button", { type: "button", class: "linkish", onclick: () => { scrub(r[0]); selectSystem(s.id, { fly: true, from: "panel" }); } }, s.name) : "Unknown system"),
          h("span", { class: "r-d" }, S[r[0]] + (to !== r[0] ? " → " + S[to] : "")));
      })) : h("p", { class: "note" }, "No position is recorded by " + S[st.idx] + "."));
  }
  function choicesSection(e) {
    const all = e.chapters;
    const vis = all.filter((c) => shownAt(chapterIdx(c)));
    const human = vis.filter((c) => (c.human || c.branch_status === "chosen") && shownAt(choiceIdx(c))).length;
    const out = [
      h("h3", null, h("span", { lang: "fr" }, "Chapitres et choix"), h("small", null, "Recorded chapters, choices and outcomes")),
      h("p", { class: "note" }, plural(vis.length, "chapter record") + (through() && vis.length < all.length ? " retained by " + S[st.idx] : " retained") + (human ? ", " + plural(human, "République choice") + " among them" : "") + ". Each is dated by the save that first retains it unless an exact completion date is recorded."),
    ];
    if (vis.length) out.push(h("ol", { class: "choices" }, vis.map(chapterItem)));
    if (vis.length < all.length) out.push(h("p", { class: "note withheld" }, plural(all.length - vis.length, "later chapter") + " held back until " + S[chapterIdx(all.find((c) => !shownAt(chapterIdx(c))))] + "."));
    return out;
  }
  function chapterItem(c) {
    const ix = chapterIdx(c);
    const ci = choiceIdx(c), oi = outcomeIdx(c);
    const choiceOn = shownAt(ci), outOn = shownAt(oi);
    const dateTxt = c.d ? "chapter completed " + c.d + " (exact)" : ix != null ? (c.a ? "between the " + c.a + " and " + S[ix] + " saves" : "first retained in the " + S[ix] + " save") : c.seen ? "first retained in the " + c.seen + " save" : "date not retained";
    const chosenText = !choiceOn ? null : c.branch || (c.human && c.optText ? "“" + String(c.optText).replace(/^["“]|["”]$/g, "") + "”" : null);
    const optionsBlock = () => {
      const opts = Array.isArray(c.options) ? c.options.filter((o) => o && o.text) : [];
      return opts.length ? h("details", { class: "ev" }, h("summary", null, "Options this event offers (" + opts.length + ")"),
        h("ul", null, opts.map((o) => h("li", { class: choiceOn && o.chosen ? "chosen" : null }, o.text, choiceOn && o.chosen ? h("b", null, " — chosen") : null, o.conditional ? h("span", { class: "muted" }, " (conditional)") : null)))) : null;
    };
    const evidenceBlock = () => h("details", { class: "ev" }, h("summary", null, "Evidence"),
      h("ul", null,
        outOn && c.fx ? h("li", null, h("span", { class: "src-l" }, "Saved effect tooltip"), h("pre", null, c.fx)) : null,
        c.id ? h("li", null, h("span", { class: "src-l" }, "Event "), h("code", null, c.id)) : null,
        c.key ? h("li", null, h("span", { class: "src-l" }, "Chapter key "), h("code", null, c.key)) : null,
        choiceOn && c.opt != null ? h("li", null, h("span", { class: "src-l" }, "Option index "), h("code", null, String(c.opt))) : null,
        c.pe ? h("li", null, h("span", { class: "src-l" }, "Player event record "), h("code", null, String(c.pe))) : null,
        choiceOn ? h("li", null, h("span", { class: "src-r" }, c.human ? "Selection marked human=1 in the save's player event selection history." : "Not marked as a human selection in the retained history.")) : null));
    // Options and effect tooltips arrive with the deferred evidence part.
    const optsLazy = !PARTS.evidence && c.options === undefined && c.optN;
    const fxLazy = !PARTS.evidence && c.fx === undefined && c.hasFx && outOn;
    return h("li", { class: "choice" },
      h("div", { class: "c-title" }, c.summary || c.t || "Untitled event"),
      h("div", { class: "c-meta" }, (c.where ? c.where + " · " : "") + dateTxt, ix != null ? [" · ", h("button", { type: "button", class: "linkish", onclick: () => { scrub(ix); showMapOnPhone(); } }, "show on map")] : null),
      c.context ? h("p", { class: "c-ctx" }, badge(c.context_badge || "game"), " ", c.context_kind === "excerpt" ? h("span", { class: "small muted" }, "From the installed definition (brief excerpt; the variant shown in game is not reconstructed): ") : null, rich(c.context)) : null,
      chosenText ? h("div", { class: "c-opt" }, h("span", { class: "c-lab" }, "Choice "), c.branch ? rich(c.branch) : chosenText, h("span", { class: "tag" }, BADGE[c.branch_badge || "save"] || "Save record")) : null,
      chosenText && ci != null && ci !== ix ? h("p", { class: "c-note" }, "Selection first retained in the " + S[ci] + " save" + (c.choice_a ? ", after " + c.choice_a : "") + ". ", h("button", { type: "button", class: "linkish", onclick: () => { scrub(ci); showMapOnPhone(); } }, "show decision on map")) : null,
      !choiceOn ? h("p", { class: "c-note pending" }, "No selection retained by " + S[st.idx] + "; the saves first retain one in " + (ci != null ? S[ci] : "a later save") + ".") : null,
      choiceOn && shownAt(isIdx(c.note_idx) ? c.note_idx : ci) && c.note ? h("p", { class: "c-note" }, rich(c.note)) : null,
      choiceOn && !chosenText && c.optText && !c.human ? h("div", { class: "c-opt auto" }, h("span", { class: "c-lab" }, "Recorded option "), "“" + String(c.optText).replace(/^["“]|["”]$/g, "") + "”", h("span", { class: "tag auto" }, "Not marked as a player choice")) : null,
      choiceOn && c.branch_status && BRANCH_STATUS[c.branch_status] ? h("p", { class: "c-note" }, BRANCH_STATUS[c.branch_status]) : null,
      outOn && c.outcome ? h("p", { class: "c-out" }, h("span", { class: "c-lab" }, "Outcome "), badge(c.outcome_badge || "save"), " ", rich(c.outcome)) : null,
      outOn && c.outcome_note ? h("p", { class: "c-note" }, c.outcome_note) : null,
      !outOn && (c.outcome || c.fx || c.hasFx) ? h("p", { class: "c-note pending" }, "No outcome retained by " + S[st.idx] + ".") : null,
      whyDetails(c.excerpts, null, (x) => (x.kind === "selection" ? ci : oi)),
      optsLazy ? lazyDetails("Options this event offers (" + c.optN + ")", optionsBlock) : optionsBlock(),
      fxLazy ? lazyDetails("Evidence", evidenceBlock) : evidenceBlock());
  }
  function factsSection(e) {
    const all = e.facts.slice().sort((a, b) => dnum(a.d || a.b || "9999.01.01") - dnum(b.d || b.b || "9999.01.01")).filter((f) => shownAt(factIdx(f)));
    const hiddenN = e.facts.length - all.length;
    const major = all.filter((f) => !f.minor), minor = all.filter((f) => f.minor);
    const row = (f) => {
      const w = when(f);
      const later = w.idx != null && w.idx > st.idx;
      return h("li", { class: "fact" + (later ? " later" : "") },
        h("div", { class: "f-date" },
          w.idx != null ? h("button", { type: "button", onclick: () => { scrub(w.idx); showMapOnPhone(); live("Map moved to " + S[w.idx] + ". " + w.note); }, "aria-label": "Show the map at " + S[w.idx] + " for " + w.label }, w.label) : h("span", null, w.label),
          badge(w.kind === "exact" ? "exact" : w.kind, w.badge)),
        h("div", null, h("div", { class: "f-text" }, titleOf(f.t)), h("div", { class: "f-note" }, w.note + (later ? " (after the current map date)" : ""))),
        h("div", { class: "f-ev" }, whyDetails(f.x), srcDetails(f, "Evidence")));
    };
    const out = [h("h3", null, h("span", { lang: "fr" }, "Faits datés"), h("small", null, "Dated facts computed from the saves"))];
    if (major.length) out.push(h("ol", { class: "facts" }, major.map(row)));
    if (minor.length) out.push(h("details", { class: "ev minor-toggle" }, h("summary", null, plural(minor.length, "routine record") + " (first sightings, renames, stage details)"), h("ol", { class: "facts" }, minor.map(row))));
    if (hiddenN) out.push(h("p", { class: "note withheld" }, plural(hiddenN, "later fact") + " held back in this reading mode."));
    return out;
  }

  function systemView(s) {
    const i = st.idx, o = ownerAt(s, i), pres = presentAt(s, i);
    const out = [];
    out.push(h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Système"), " · Star system"));
    out.push(h("h2", null, s.name));
    const star = starLabel(s.star);
    out.push(h("div", { class: "where" },
      h("span", { class: "place", style: "cursor:default" }, dot(pres ? cColor(o) : "transparent"), pres ? (o ? "Held by " + cName(o) : "Unclaimed") : "Not present at this date", h("em", null, "at " + S[i])),
      star ? h("span", { class: "place", style: "cursor:default" }, star) : null));
    if (!pres) { const f = firstPresent(s); out.push(h("p", { class: "datebox warn" }, "This system does not appear in the saves until " + (f != null ? S[f] : "later") + ". The map hides it before then rather than placing it early.")); }
    else out.push(dateBox());
    const here = entriesAt.get(s.id) || [];
    const later = here.filter(notYet);
    const avail = here.filter((e) => !notYet(e));
    const cur = avail.filter(curated), recs = avail.filter((e) => !curated(e));
    if (cur.length) { out.push(h("h3", null, h("span", { lang: "fr" }, "Récits"), h("small", null, "Stories here"))); out.push(h("ul", { class: "cards" }, cur.map((e) => h("li", null, entryCard(e))))); }
    const ment = (mentionsAt.get(s.id) || []).filter((e) => curated(e) && !notYet(e));
    if (ment.length) { out.push(h("h3", null, h("span", { lang: "fr" }, "Mentionné dans"), h("small", null, "Also part of"))); out.push(h("ul", { class: "cards" }, ment.map((e) => h("li", null, entryCard(e))))); }
    if (recs.length) { out.push(h("h3", null, h("span", { lang: "fr" }, "Archives"), h("small", null, "Dig site and rift records"))); out.push(h("ul", { class: "cards" }, recs.map((e) => h("li", null, entryCard(e))))); }
    if (later.length) out.push(h("p", { class: "note withheld" }, plural(later.length, "record") + " here " + (later.length === 1 ? "is" : "are") + " not yet observed at " + S[i] + "."));

    if (!PARTS.worlds && s.bn) {
      out.push(h("h3", null, h("span", { lang: "fr" }, "Mondes"), h("small", null, "Worlds as of " + S[i])));
      const box = h("p", { class: "note" }, "Loading this system's " + plural(s.bn, "world") + "…");
      out.push(box);
      ensurePart("worlds").then(() => { if (st.sys === s.id && !st.entry) update(); }).catch(() => fill(box, "The world details could not be loaded" + (navigator.onLine === false ? " while offline" : "") + ". ", h("button", { type: "button", class: "linkish", onclick: () => update() }, "Try again")));
    }
    const bodies = s.b.map((b) => bodyAt(b, i));
    const notable = bodies.filter((b) => b.colony || b.changed || b.hasColonyHistory || b.id === st.planet || ENTRIES.some((e) => e.planet === b.id));
    if (PARTS.worlds) out.push(h("h3", null, h("span", { lang: "fr" }, "Mondes"), h("small", null, "Worlds as of " + S[i])));
    const worldRow = (b) => h("li", { class: "world" + (b.id === st.planet ? " hl" : ""), id: "world-" + b.id },
      h("span", { class: "w-n" }, b.name + (b.moon ? " (moon)" : "")), h("span", { class: "w-c" }, b.cls),
      b.colony ? h("span", { class: "w-o" }, dot(cColor(b.colony)), "Colony of " + cName(b.colony)) : b.hasColonyHistory ? h("span", { class: "w-o" }, "No colony recorded at this date") : null);
    if (notable.length) out.push(h("ul", { class: "worlds" }, notable.map(worldRow)));
    else if (PARTS.worlds) out.push(h("p", { class: "note" }, "No colonised or changed worlds are recorded here."));
    const rest = bodies.filter((b) => !notable.includes(b));
    if (rest.length) out.push(h("details", { class: "ev" }, h("summary", null, "All other bodies (" + rest.length + ")"), h("ul", { class: "worlds" }, rest.map(worldRow))));

    const runs = s.o.filter((r) => shownAt(r[0]));
    if (runs.length) {
      out.push(h("h3", null, h("span", { lang: "fr" }, "Souveraineté"), h("small", null, "Ownership by saved observation")));
      out.push(h("ul", { class: "runs" }, runs.map((r) => {
        const id = ownerOk(r[2]), to = through() ? Math.min(r[1], i) : r[1];
        return h("li", { class: r[0] <= i && i <= r[1] ? "cur" : null },
          h("span", { class: "r-v" }, dot(cColor(id)), cName(id)),
          h("span", { class: "r-d" }, S[r[0]] + (to !== r[0] ? " → " + S[to] : "")));
      })));
      out.push(h("p", { class: "note" }, "Gaps between rows are saves where no owner is recorded. A change happened somewhere between the last save of one row and the first of the next."));
    } else out.push(h("p", { class: "note" }, through() ? "No owner is recorded here by " + S[i] + "." : "No owner is recorded for this system in any retained save."));

    const evs = (eventsAt.get(s.id) || []).filter(eventVisible);
    if (evs.length) {
      out.push(h("h3", null, h("span", { lang: "fr" }, "Chronique locale"), h("small", null, plural(evs.length, st.allRec ? "record" : "event") + " here")));
      out.push(h("ul", { class: "chron" }, evs.slice(0, 8).map((e) => h("li", null, eventButton(e)))));
      if (evs.length > 8) out.push(h("p", { class: "note" }, h("button", { type: "button", onclick: () => { st.local = true; showTab("chron"); } }, "All " + evs.length + " at " + s.name)));
    }
    out.push(h("details", { class: "ev" }, h("summary", null, "Record identifiers"), h("ul", null,
      h("li", null, h("span", { class: "src-l" }, "System "), h("code", null, s.id)),
      s.star ? h("li", null, h("span", { class: "src-l" }, "Star class "), h("code", null, s.star)) : null,
      h("li", null, h("span", { class: "src-l" }, "Saved coordinates "), h("code", null, "x " + s.x + ", y " + s.y), h("span", { class: "src-r" }, "Drawn at screen x = −x, y = y (" + ((META.projection && META.projection.rule) || "screenX = -saveX; screenY = saveY") + ")")),
      bodies.some((b) => b.flags.length) ? h("li", null, h("span", { class: "src-l" }, "Body flags at the latest save: "), bodies.filter((b) => b.flags.length).map((b) => [b.name + " ", ...b.flags.map((f) => [h("code", null, f), " "])])) : null)));
    if (st.planet) setTimeout(() => { const w = document.getElementById("world-" + st.planet); if (w) w.scrollIntoView({ block: "center" }); }, 0);
    return out;
  }

  function welcomeView() {
    const c = META.counts || {};
    return [
      h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Bienvenue"), " · Welcome"),
      h("h2", null, "Atlas de la Continuité"),
      h("p", { class: "lede" }, "Select a system on the map, search for a world, or open the index of curated stories. Move the timeline to see the galaxy as each of the " + N + " saved observations recorded it."),
      h("p", { class: "note" }, (c.stories != null ? plural(c.stories, "curated story", "curated stories") + ", " : "") + (c.lore != null ? plural(c.lore, "lore entry", "lore entries") + " and " : "") + plural(JOURNEYS.length, "journey") + "."),
      h("div", { class: "where" },
        h("button", { type: "button", class: "btn primary", onclick: () => showTab("index") }, "Open the story index"),
        h("button", { type: "button", class: "btn", onclick: () => showTab("journeys") }, "Follow a journey")),
    ];
  }

  function entryCard(e, onPick, pre) {
    const loc = entryLoc(e, st.idx) || e.system;
    const s = loc && SYS.get(loc);
    const ny = notYet(e);
    return h("button", { type: "button", class: "card" + (ny ? " dim" : ""), "aria-current": st.entry === e.id ? "true" : null, onclick: onPick || (() => openEntry(e.id, { from: "panel" })) },
      pre || null,
      h("div", { class: "t" }, e.title || "Untitled"),
      e.fr ? h("div", { class: "fr2", lang: "fr" }, e.fr) : null,
      h("div", { class: "loc" }, h("span", null, kindOf(e).en), s ? h("span", null, dot(cColor(presentAt(s, st.idx) ? ownerAt(s, st.idx) : null)), s.name) : null,
        e.cats.filter((c) => CAT.has(c)).map((c) => h("span", null, dot(catColor(c)), CAT.get(c).en))),
      ny ? h("div", { class: "l ny" }, "Not yet observed at " + S[st.idx] + " · first record " + S[entryFirstIdx(e)])
        : e.role && isPerson(e) ? h("div", { class: "l" }, e.role)
          : e.lede && ledeShown(e) ? h("div", { class: "l" }, e.lede) : null);
  }
  function journeyCard(j) {
    return h("button", { type: "button", class: "card", onclick: () => startJourney(j.id) },
      h("div", { class: "t" }, j.title), j.fr ? h("div", { class: "fr2", lang: "fr" }, j.fr) : null,
      h("div", { class: "loc" }, h("span", null, (j.theme ? "Thematic journey" : "Journey") + " · " + plural(stepsOf(j).length, "step"))),
      j.intro ? h("div", { class: "l" }, j.intro) : null);
  }

  // ------------------------------------------------------------ filters
  function renderFilters() {
    const f = $("#filters");
    if (f.hidden) return;
    const kids = CATS.map((c) => h("button", { type: "button", class: "chip", "aria-pressed": String(st.cats.has(c.k)), onclick: () => { if (st.cats.has(c.k)) st.cats.delete(c.k); else st.cats.add(c.k); update(); }, title: c.fr },
      dot(c.c), c.en));
    if (st.tab === "chron") kids.push(h("button", { type: "button", class: "chip", "aria-pressed": String(st.allRec), onclick: () => { st.allRec = !st.allRec; update(); }, title: "Include routine records: first sightings, relays, stage intervals" }, st.allRec ? "All records" : "Major events only"));
    if (st.tab === "chron" && st.sys && SYS.has(st.sys)) kids.push(h("button", { type: "button", class: "chip local", "aria-pressed": String(st.local), onclick: () => { st.local = !st.local; update(); } }, "Only " + SYS.get(st.sys).name));
    kids.push(h("div", { class: "seg", role: "radiogroup", "aria-label": "Scope" },
      h("button", { type: "button", role: "radio", "aria-checked": String(st.scope === "rep"), onclick: () => { st.scope = "rep"; update(); }, title: "République stories plus anything in République space at the map date" }, "République"),
      h("button", { type: "button", role: "radio", "aria-checked": String(st.scope === "all"), onclick: () => { st.scope = "all"; update(); } }, "Whole galaxy")));
    fill(f, kids);
  }

  // -------------------------------------------------------------- index
  function indexPanel() {
    const people = ENTRIES.filter(isPerson);
    const views = [["stories", "Récits", "Stories"], ["people", "Personnes", "People" + (people.length ? " (" + people.length + ")" : "")], ["threads", "Fils ouverts", "Open threads" + (THREADS.length ? " (" + THREADS.length + ")" : "")]];
    const out = [
      h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Index"), " · Stories, people and open threads"),
      h("h2", null, st.view === "people" ? "Personnes et institutions" : st.view === "threads" ? "Fils ouverts" : "Index des récits"),
      h("div", { class: "seg subview", role: "tablist", "aria-label": "Index view" }, views.map(([k, fr, en]) => h("button", { type: "button", role: "tab", "aria-selected": String(st.view === k), onclick: () => { st.view = k; update(); } }, h("span", { lang: "fr" }, fr), h("small", null, en)))),
    ];
    if (st.view === "people") return out.concat(peopleView(people));
    if (st.view === "threads") return out.concat(threadsView());
    const vis = ENTRIES.filter((e) => !isPerson(e) && entryVisible(e));
    const ready = vis.filter((e) => !notYet(e)), later = vis.filter(notYet);
    const hiddenForeign = ENTRIES.filter((e) => curated(e) && !isPerson(e) && inCats(e.cats) && !entryInScope(e, st.idx)).length;
    const groups = [["story", "Récits", "Curated stories"], ["lore", "Mémoire", "Campaign lore"], ["site", "Sites archéologiques", "Dig site records"], ["rift", "Failles astrales", "Astral rift records"]];
    const c = META.counts || {};
    out.push(h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: st.records ? true : null, onchange: (e) => { st.records = e.target.checked; update(); } }),
      "Include every dig site and astral rift record" + (c.sites_total != null ? " (" + c.sites_total + " sites, " + c.rifts_total + " rifts in the galaxy)" : "")));
    out.push(h("p", { class: "note" }, plural(ready.length, "entry", "entries") + " match the filters at " + S[st.idx] + ".",
      hiddenForeign > 0 && st.scope === "rep" ? [" " + plural(hiddenForeign, "story", "stories") + " lie outside République space. ", h("button", { type: "button", onclick: () => { st.scope = "all"; update(); } }, "Show the whole galaxy")] : null));
    for (const [k, fr, en] of groups) {
      const list = ready.filter((e) => e.kind === k);
      if (!list.length) continue;
      out.push(h("h3", { class: "group-h" }, h("span", { lang: "fr" }, fr), " ", h("span", null, "· " + en + " (" + list.length + ")")));
      out.push(h("ul", { class: "cards" }, list.map((e) => h("li", null, entryCard(e)))));
    }
    if (later.length) out.push(h("details", { class: "ev later-group" }, h("summary", null, plural(later.length, "entry", "entries") + " not yet observed at " + S[st.idx]), h("ul", { class: "cards" }, later.map((e) => h("li", null, entryCard(e))))));
    if (!vis.length) out.push(h("p", { class: "note" }, "Nothing matches these filters. Clear a category or widen the scope."));
    return out;
  }
  function peopleView(people) {
    if (!people.length) return [h("p", { class: "note" }, "This edition's data has no person or institution entries.")];
    const out = [h("p", { class: "note" }, "People and institutions of the République, from campaign canon and dated save facts. They have no map position; their episodes and places are cross-linked.")];
    for (const [k, fr, en] of [["person", "Personnages", "People"], ["institution", "Institutions", "Institutions"]]) {
      const list = people.filter((e) => e.kind === k);
      if (!list.length) continue;
      out.push(h("h3", { class: "group-h" }, h("span", { lang: "fr" }, fr), " ", h("span", null, "· " + en + " (" + list.length + ")")));
      out.push(h("ul", { class: "cards" }, list.map((e) => h("li", null, entryCard(e)))));
    }
    return out;
  }
  function threadsView() {
    if (!THREADS.length) return [h("p", { class: "note" }, "This edition's data records no open threads.")];
    const cut = META.archive_cutoff || S[LAST];
    const out = [h("p", { class: "note" }, "Unfinished business in the archive, each with a typed status. Statuses describe the archive as of " + cut + ".")];
    const order = Object.keys(THREAD_KIND);
    const list = THREADS.slice().sort((a, b) => (order.indexOf(a.kind) + 1 || 99) - (order.indexOf(b.kind) + 1 || 99));
    const asIdx = (t) => (t.as_of ? idxOfDate(t.as_of) : LAST);
    out.push(h("ul", { class: "cards threads" }, list.map((t) => {
      const e = t.entry && ENT.get(t.entry), s = t.system && SYS.get(String(t.system));
      const held = !shownAt(asIdx(t));
      return h("li", { class: "thread" },
        h("div", { class: "th-head" }, h("span", { class: "badge th-" + (t.kind || "other") }, THREAD_KIND[t.kind] || "Open thread"), t.badge && BADGE[t.badge] ? badge(t.badge) : null),
        h("div", { class: "t" }, t.title),
        held ? h("p", { class: "note withheld" }, "This thread describes the archive as of " + (t.as_of || cut) + ", after the map date.") : t.text ? h("p", { class: "l" }, rich(t.text)) : null,
        h("div", { class: "where" },
          t.as_of ? h("span", { class: "small muted" }, "As of " + t.as_of) : null,
          s ? placeButton(s.id) : null,
          e ? h("button", { type: "button", class: "place", onclick: () => openEntry(e.id, { from: "panel" }) }, e.title) : null,
          !s ? h("span", { class: "small muted" }, "No map location") : null),
        held ? null : whyDetails(t.excerpts));
    })));
    return out;
  }

  // ---------------------------------------------------------- chronicle
  function chronList() {
    const local = st.sys && st.local ? st.sys : null;
    return EVENTS.filter((e) => eventVisible(e) && (!local || e.sys.includes(local)));
  }
  function eventButton(e) {
    const w = when(e);
    const places = e.sys.slice(0, 3).map((sid) => SYS.get(sid).name);
    const here = st.sys && e.sys.includes(st.sys);
    return h("button", { type: "button", class: "evt" + (w.idx === st.idx && w.kind !== "undated" ? " now" : "") + (here ? " here" : "") + (e.minor ? " minor" : ""), "aria-current": st.event === e.id ? "true" : null, onclick: () => selectEvent(e.id, { from: "panel" }) },
      h("span", { class: "e-date" }, h("span", null, w.label), badge(w.kind === "exact" ? "exact" : w.kind, w.badge)),
      h("span", { class: "e-t" }, titleOf(e.t)),
      h("span", { class: "e-loc" }, here ? h("span", { class: "e-here" }, "◆ " + SYS.get(st.sys).name) : null, dot(catColor(e.cat)), CAT.has(e.cat) ? CAT.get(e.cat).en : null, e.minor ? " · routine" : null, places.length ? " · " + places.join(", ") + (e.sys.length > 3 ? " +" + (e.sys.length - 3) : "") : null));
  }
  function chronPanel() {
    const list = chronList();
    const local = st.sys && st.local ? SYS.get(st.sys) : null;
    const out = [h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Chronique"), " · Timeline of the archive"), h("h2", null, local ? "Chronique de " + local.name : "Chronique")];
    if (st.sys && SYS.has(st.sys) && !local) {
      const n = (eventsAt.get(st.sys) || []).filter(eventVisible).length;
      if (n) out.push(h("p", { class: "note" }, plural(n, st.allRec ? "record" : "event") + " at " + SYS.get(st.sys).name + " are marked ◆ here and in gold on the timeline. ", h("button", { type: "button", onclick: () => { st.local = true; update(); } }, "Show only these")));
    }
    const nEx = list.filter((e) => e.d).length, nIv = list.filter((e) => !e.d && e.b).length, nLo = list.filter((e) => !e.d && !e.b).length;
    const minorHidden = st.allRec ? 0 : EVENTS.filter((e) => e.minor && inCats([e.cat]) && eventInScope(e, st.idx) && shownAt(when(e).idx) && (!local || e.sys.includes(local.id))).length;
    const later = through() ? EVENTS.filter((e) => eventFiltered(e) && !shownAt(when(e).idx) && (!local || e.sys.includes(local.id))).length : 0;
    out.push(h("p", { class: "note" }, plural(list.length, st.allRec ? "record" : "major event") + ": " + nEx + " with an exact saved date, " + nIv + " inferred between two saves" + (nLo ? ", " + nLo + " undated campaign lore" : "") + ".",
      minorHidden ? [" " + plural(minorHidden, "routine record") + " hidden. ", h("button", { type: "button", onclick: () => { st.allRec = true; update(); } }, "Show all records")] : null,
      later ? " " + plural(later, "later record") + " held back (history through " + S[st.idx] + ")." : null));
    out.push(h("p", { class: "note" }, h("button", { type: "button", onclick: () => { const t = document.querySelector("#p-chron .evt.now, #p-chron [data-after]"); if (t) t.scrollIntoView({ block: "center" }); } }, "Scroll to the map date (" + S[st.idx] + ")")));
    const ol = h("ol", { class: "chron" });
    let lastY = null, markedAfter = false;
    const pre = list.filter((e) => e.d && dnum(e.d) < SN[0]);
    const dated = list.filter((e) => (e.d && dnum(e.d) >= SN[0]) || (!e.d && e.b));
    const undated = list.filter((e) => !e.d && !e.b);
    if (pre.length) {
      ol.append(h("li", { class: "yr", id: "chron-pre" }, h("span", { lang: "fr" }, "Avant les archives"), h("span", { class: "small muted" }, " · before " + S[0] + "; the map can only show the " + S[0] + " observation")));
      for (const e of pre) ol.append(h("li", null, eventButton(e)));
    }
    for (const e of dated) {
      const y = yearOf(e.d || e.b);
      if (y !== lastY) { ol.append(h("li", { class: "yr" }, y)); lastY = y; }
      const li = h("li", null, eventButton(e));
      if (!markedAfter && when(e).idx >= st.idx) { li.setAttribute("data-after", ""); markedAfter = true; }
      ol.append(li);
    }
    if (undated.length) {
      ol.append(h("li", { class: "yr" }, h("span", { lang: "fr" }, "Sans date"), h("span", { class: "small muted" }, " · established campaign lore without a saved date (background)")));
      for (const e of undated) ol.append(h("li", null, eventButton(e)));
    }
    out.push(ol);
    if (!list.length) out.push(h("p", { class: "note" }, local ? "No chronicle events are recorded at " + local.name + " under these filters." : "No events match these filters."));
    return out;
  }

  // ------------------------------------------------------------ journeys
  // Per-step metadata (v2 steps_v2) or bare entry ids (v1).
  function stepsOf(j) {
    if (Array.isArray(j.steps_v2) && j.steps_v2.length) return j.steps_v2.filter((s) => s && ENT.has(s.entry)).map((s) => ({ ...s, idx: isIdx(s.idx) ? s.idx : s.date ? idxAtOrAfter(s.date) : s.b ? idxOfDate(s.b) : null }));
    return j.steps.filter((id) => ENT.has(id)).map((id) => ({ entry: id, idx: null, precision: null }));
  }
  function stepDateLabel(s) {
    if (s.precision === "undated") return h("span", { class: "sdate" }, badge("lore", "Undated"), " campaign lore; the map date is kept");
    if (s.precision === "exact" && s.date) return h("span", { class: "sdate" }, badge("exact", "Exact date"), " " + s.date);
    if (s.precision === "interval" && s.b) return h("span", { class: "sdate" }, badge("interval", "Interval"), " " + (s.a ? s.a + " – " : "by ") + s.b);
    if (s.precision === "observed" && (s.b || s.date)) return h("span", { class: "sdate" }, badge("observed", "Observed"), " as of " + (s.b || s.date));
    if (isIdx(s.idx)) return h("span", { class: "sdate" }, badge("observed", "Step date"), " " + S[s.idx]);
    return h("span", { class: "sdate muted" }, "No step date in the data; the map date is kept");
  }
  function startJourney(id) {
    const j = JRN.get(id); if (!j) return;
    st.journey = id;
    journeyStep(0);
  }
  function journeyStep(i) {
    const j = JRN.get(st.journey); if (!j) return;
    const steps = stepsOf(j);
    i = Math.max(0, Math.min(steps.length - 1, i));
    const s = steps[i];
    st.event = null; st.playGroup = null;
    const moveDate = st.follow && isIdx(s.idx) && s.precision !== "undated";
    if (moveDate) setIdx(s.idx, { quiet: true });
    openEntry(s.entry, { from: "journey", keepDate: true });
    const e = ENT.get(s.entry);
    live("Step " + (i + 1) + " of " + steps.length + ": " + e.title + ". " + (moveDate ? "Map date " + S[st.idx] + "." : s.precision === "undated" ? "Undated step; map date kept at " + S[st.idx] + "." : "Map date kept at " + S[st.idx] + "."));
  }
  function journeysPanel() {
    const out = [h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Parcours"), " · Thematic journeys"), h("h2", null, "Parcours")];
    const j = st.journey && JRN.get(st.journey);
    out.push(h("div", { class: "jrow" }, h("span", { class: "small muted" }, "When stepping through a journey:"), followSeg()));
    if (j) {
      const steps = stepsOf(j);
      out.push(h("h3", null, h("span", null, j.title), j.fr ? h("small", { lang: "fr" }, j.fr) : null));
      if (j.intro) out.push(h("p", { class: "lede" }, j.intro));
      out.push(h("ol", { class: "cards" }, steps.map((s, k) => {
        const e = ENT.get(s.entry);
        return h("li", null, entryCard(e, () => journeyStep(k), h("div", { class: "small muted step-h" }, "Step " + (k + 1) + " of " + steps.length + " · ", stepDateLabel(s))));
      })));
      out.push(h("div", { class: "where" }, h("button", { type: "button", class: "btn", onclick: () => { st.journey = null; update(); } }, "Leave this journey")));
      out.push(h("h3", null, h("span", null, "Other journeys")));
    } else out.push(h("p", { class: "note" }, "Curated paths through the archive. The map draws each journey's route as a dashed blue line. With “Follow story dates”, each step moves the map to that step's own date; undated steps leave it unchanged."));
    out.push(h("ul", { class: "cards" }, JOURNEYS.filter((x) => x !== j).map((x) => h("li", null, journeyCard(x)))));
    return out;
  }

  // -------------------------------------------------------------- offline
  const OFF = { busy: false, ctrl: null, progress: null, error: null, status: null, persist: null, est: null, last: 0 };
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";
  function offlineSection() {
    const box = h("section", { class: "offline", id: "offlineBox", "aria-live": "polite" });
    renderOffline(box);
    if (HOST && HOST.offline.supported && !OFF.busy) refreshOffline();
    return [h("h3", null, h("span", { lang: "fr" }, "Hors ligne"), h("small", null, "Offline edition")), box];
  }
  async function refreshOffline() {
    try { OFF.status = await HOST.offline.status(); OFF.est = await HOST.offline.estimate(); } catch (err) { OFF.error = err.message; }
    const b = $("#offlineBox");
    if (b) renderOffline(b);
  }
  function renderOffline(box) {
    const file = META.downloads && META.downloads.offline;
    const single = file ? h("a", { class: "btn", href: file, download: "atlas-de-la-continuite-offline.html" }, "Save the single-file offline atlas") : null;
    if (!HOST) { fill(box, h("p", { class: "of-state ok" }, "This file is the offline edition"), h("p", null, "Everything, including the illustrations, is inside this one file. It opens without a connection and stores nothing in the browser.")); return; }
    if (!HOST.offline.supported) { fill(box, h("p", { class: "of-state" }, "Offline storage is not available here"), h("p", null, "Keeping an offline copy needs the published atlas over HTTPS in a browser with service workers. The single-file edition opens without a connection instead."), single ? h("div", { class: "of-row" }, single) : null); return; }
    const total = HOST.offline.totalBytes, s0 = OFF.status;
    const kids = [];
    const btn = (label, fn, primary) => h("button", { type: "button", class: "btn" + (primary ? " primary" : ""), onclick: fn }, label);
    if (OFF.busy) {
      const p = OFF.progress || { bytes: 0, total };
      kids.push(h("p", { class: "of-state" }, "Downloading this edition… " + mb(p.bytes) + " of " + mb(p.total)),
        h("div", { class: "of-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(p.total), "aria-valuenow": String(p.bytes), "aria-label": "Offline download" }, h("i", { style: "width:" + Math.round(100 * p.bytes / Math.max(1, p.total)) + "%" })),
        h("p", { class: "small muted" }, "It is not usable offline until every file is stored and checked."),
        h("div", { class: "of-row" }, btn("Cancel", () => OFF.ctrl && OFF.ctrl.abort())));
    } else if (!s0) kids.push(h("p", { class: "of-state" }, "Checking for an offline copy…"));
    else {
      const cur = s0.current;
      if (s0.ready) kids.push(h("p", { class: "of-state ok" }, "Ready offline"), h("p", null, "This edition (" + mb(total) + ", " + plural(s0.files, "file") + ") was stored on " + String(cur.info.completedAt || "").slice(0, 10) + ". Opening the atlas without a connection uses it, including the illustrations."));
      else if (cur && cur.complete) kids.push(h("p", { class: "of-state warn" }, "Downloaded, not yet active"), h("p", null, "Every file is stored, but offline start needs the atlas's service worker, which becomes active after the page is reloaded once while online."));
      else if (cur && cur.cached) kids.push(h("p", { class: "of-state warn" }, "Partly downloaded: not usable offline"), h("p", null, plural(cur.cached, "file") + " of " + s0.files + " are stored. Resume to finish; nothing incomplete is used offline."));
      else kids.push(h("p", { class: "of-state" }, "Not downloaded"), h("p", null, "Download this edition (" + mb(total) + ", " + plural(s0.files, "file") + ": map, stories, evidence and illustrations) to open the atlas without a connection."));
      if (OFF.error) kids.push(h("p", { class: "of-state bad" }, "Download stopped: " + OFF.error), h("p", { class: "small muted" }, "Files already stored are kept so that a retry resumes; nothing incomplete is used offline."));
      const row = [];
      if (!s0.ready) row.push(btn(cur && cur.cached ? "Resume download (" + mb(total) + ")" : "Download for offline use (" + mb(total) + ")", startOfflineDownload, true));
      if (s0.ready) row.push(btn(OFF.persist ? "Ask again to keep it" : "Ask the browser to keep it", askPersist));
      if (cur || (s0.others && s0.others.length)) row.push(btn("Remove offline copy", async () => { await HOST.offline.remove(); OFF.error = null; OFF.persist = null; live("Offline copy removed."); refreshOffline(); }));
      kids.push(h("div", { class: "of-row" }, row));
      if (OFF.persist) kids.push(h("p", { class: "small" }, OFF.persist));
      const prev = (s0.others || []).filter((o) => o.complete);
      if (prev.length) kids.push(h("p", { class: "small muted" }, "An earlier edition is also stored, so a tab still showing it keeps working. The next download or “Remove offline copy” clears it."));
      if (OFF.est && OFF.est.quota) kids.push(h("p", { class: "small muted" }, "Browser storage used by this site: " + mb(OFF.est.usage || 0) + " of about " + mb(OFF.est.quota) + "."));
    }
    kids.push(h("p", { class: "small muted" }, "On iPhone and iPad, Safari and an atlas added to the Home Screen keep separate storage: download from the one you will use offline."));
    if (single) kids.push(h("div", { class: "of-row" }, single));
    fill(box, kids);
  }
  async function startOfflineDownload() {
    if (OFF.busy) return;
    OFF.busy = true; OFF.error = null; OFF.ctrl = new AbortController(); OFF.progress = { bytes: 0, total: HOST.offline.totalBytes };
    const box = $("#offlineBox"); if (box) renderOffline(box);
    try {
      OFF.status = await HOST.offline.download((p) => {
        OFF.progress = p;
        const now = performance.now();
        if (now - OFF.last > 120) { OFF.last = now; const b = $("#offlineBox"); if (b) renderOffline(b); }
      }, OFF.ctrl.signal);
      live(OFF.status && OFF.status.ready ? "The offline edition is ready." : "Every file is stored; offline start becomes available after one reload.");
    } catch (err) {
      OFF.error = err && err.name === "AbortError" ? "cancelled." : (err && err.message) || "unknown error.";
      live("Offline download stopped: " + OFF.error);
    }
    OFF.busy = false;
    refreshOffline();
  }
  async function askPersist() {
    const r = await HOST.offline.persist();
    OFF.persist = !r.supported ? "This browser does not offer persistent storage; it may clear the offline copy when space runs low." : r.granted ? "The browser agreed to keep the offline copy unless you clear it." : "The browser did not promise to keep it; it may clear the offline copy when space runs low.";
    const b = $("#offlineBox"); if (b) renderOffline(b);
  }
  function showUpdate() {
    const bar = $("#updateBar");
    if (!bar || !bar.hidden) return;
    fill(bar, h("span", { class: "ub-t" }, h("b", { lang: "fr" }, "Nouvelle édition"), " · A newer edition of the atlas has been published. This page stays as it is until you reload."),
      h("button", { type: "button", class: "btn primary", onclick: () => HOST.applyUpdate() }, "Reload to update"),
      h("button", { type: "button", class: "btn", onclick: () => { bar.hidden = true; } }, "Later"));
    bar.hidden = false;
  }

  // -------------------------------------------------------------- sources
  function sourcesPanel() {
    const c = META.counts || {};
    const out = [h("p", { class: "kicker" }, h("span", { class: "k-kind", lang: "fr" }, "Sources"), " · Evidence and method"), h("h2", null, "Sources et méthode")];
    out.push(...offlineSection());
    out.push(h("div", { class: "prose" },
      h("p", null, "Everything in this atlas is read from the retained saves of the campaign " + (META.campaign_name || "") + " and the reports generated from them, plus curated prose. Each paragraph carries a badge saying what kind of evidence stands behind it, and every computed fact keeps its exact source reference."),
      h("p", null, "The map shows one saved observation at a time. A change detected by comparing two saves is given as an interval between them, never as an invented exact date. Dates the game itself records inside a save, such as timeline entries, dig chapter completions and timestamped flags, stay exact."),
      h("p", null, "“History through this date” shows only what the archive retains by the selected save. That is the saved evidence, not a reconstruction of what the player knew at the time.")));
    if (DELTA) out.push(...deltaSection());
    out.push(h("h3", null, h("span", { lang: "fr" }, "Badges"), h("small", null, "Evidence kinds")));
    out.push(h("ul", { class: "legend-badges" }, Object.keys(BADGE).map((k) => h("li", null, h("span", null, badge(k)), h("span", null, BADGE_HELP[k] || "")))));
    const row = (label, sub, val) => [h("dt", null, label, sub ? h("small", null, sub) : null), h("dd", null, val == null ? "—" : String(val))];
    out.push(h("h3", null, h("span", { lang: "fr" }, "Couverture"), h("small", null, "Coverage")));
    const dl = h("dl", { class: "dl" });
    const rows = [
      ["Saved observations", (META.snapshots ? META.snapshots.first + " → " + META.snapshots.last : S[0] + " → " + S[LAST]) + (META.snapshots && META.snapshots.cadence ? "; " + META.snapshots.cadence : ""), N],
      ["Star systems mapped", "shown only while present in the saves", c.systems],
      ["Hyperlanes", null, c.lanes],
      ["Curated stories", null, c.stories],
      ["Campaign lore entries", null, c.lore],
      ["People and institutions", null, ENTRIES.filter(isPerson).length || null],
      ["Thematic journeys", null, c.journeys != null ? c.journeys : JOURNEYS.length],
      ["Open threads", null, THREADS.length || null],
      ["Archaeological sites in the galaxy", "every dig site record, whoever worked it", c.sites_total],
      ["…with a chapter completed by the République", "sites the République excavated (chapters, not whole sites)", c.sites_republique_excavated],
      ["Astral rift records", c.rifts_typed != null ? c.rifts_typed + " with a revealed type, " + (c.rifts_total - c.rifts_typed) + " never revealed in any save" : null, c.rifts_total],
      ["République rift expeditions", c.rifts_republique_finished != null ? c.rifts_republique_finished + " finished, " + (c.rifts_republique_explored - c.rifts_republique_finished) + " not finished at the last save" : null, c.rifts_republique_explored],
      ["Retained République event choices", "marked as human selections", c.retained_choices_republique],
      ["République expedition chapters", "distinct chapters across the République's excavations and rifts", c.chapters_republique],
      ["Evidence excerpts", "bounded source records available under Why we say this", c.excerpts],
      ["Chronicle records", c.timeline_exact != null ? c.timeline_exact + " exact, " + c.timeline_interval + " interval, " + c.timeline_undated_lore + " undated lore; " + EVENTS.filter((e) => e.minor).length + " routine" : null, c.timeline_events],
      ["Verified flag timestamps", "used only when inside their bracketing save interval", c.verified_flag_dates],
    ];
    for (const r of rows) if (r[2] != null) dl.append(...row(r[0], r[1], r[2]));
    out.push(dl);
    out.push(h("h3", null, h("span", { lang: "fr" }, "Méthode"), h("small", null, "How the map is drawn")));
    const m = [];
    if (META.projection) m.push(["Projection", META.projection.rule + (META.projection.source ? " — " + META.projection.source : "")]);
    if (META.ownership) m.push(["Ownership", META.ownership]);
    m.push(["Territory shading", "Approximate. Each patch of space takes the owner of the nearest system present at the map date, within " + TERR_R + " units; unowned systems claim space for nobody. It is a reading aid, not the game's border geometry. System dots and lane colours show the recorded owners exactly."]);
    if (META.geometry) m.push(["Geometry", META.geometry]);
    if (META.flag_dates) m.push(["Flag dates", META.flag_dates]);
    if (META.choices) m.push(["Event choices", META.choices]);
    m.push(["Illustrations", "Any illustration is labelled as an artistic interpretation. It is not evidence."]);
    out.push(h("div", { class: "prose" }, m.map(([k, v]) => h("p", null, h("b", null, k + ". "), rich(v)))));
    out.push(h("h3", null, h("span", { lang: "fr" }, "Fabrication"), h("small", null, "Build")));
    const b = [["Edition", META.edition], ["Archive cutoff", META.archive_cutoff], ["Campaign", META.campaign_name], ["Game version", META.game_version], ["Mods", Array.isArray(META.mods) ? META.mods.join(", ") : null], ["Extracted", META.extracted_at], ["Built", META.built_at], ["Source revision", META.source_revision ? String(META.source_revision).slice(0, 12) + (META.source_tracked_changes === "yes" ? " (with uncommitted tracked changes)" : "") : null]];
    out.push(h("dl", { class: "dl" }, b.filter((x) => x[1]).map((x) => [h("dt", null, x[0]), h("dd", { class: "dd-plain" }, String(x[1]))])));
    const ck = D.checks || {};
    if (Array.isArray(ck.flags) && ck.flags.length) {
      out.push(h("details", { class: "ev" }, h("summary", null, "Flag timestamp checks (" + ck.flags.filter((f) => f.verified).length + " of " + ck.flags.length + " used as exact dates)"),
        h("ul", null, ck.flags.map((f) => h("li", null, h("code", null, f.flag), " decoded " + (f.decoded || "—") + ", first observed " + (f.first_observed || "—") + " — " + (f.verified ? "used as an exact date" : "not used as a date"))))));
    }
    if (ck.exporter) out.push(h("details", { class: "ev" }, h("summary", null, "Exporter consistency checks"), h("pre", null, JSON.stringify(ck.exporter, null, 1).slice(0, 6000))));
    if (Array.isArray(ck.warnings)) out.push(h("p", { class: "note" }, ck.warnings.length ? plural(ck.warnings.length, "build warning") + " recorded." : "No build warnings recorded."));
    out.push(h("p", { class: "note" }, HOST ? "This hosted edition loads its map, stories and chapters first, then world details right after the first view, and source references only when an evidence block is opened or a search runs. Illustrations load when their story opens. Every file is versioned, and the edition makes no request outside this site." : "This offline edition includes the map, evidence, styles and illustrations in one file, and makes no network requests."));
    return out;
  }
  function deltaSection() {
    const d = DELTA, prev = d.previous || META.previous_edition || {}, ar = d.archive || {};
    if (through() && st.idx < LAST) return [
      h("h3", null, "Since the previous edition"),
      h("p", { class: "note" }, "Edition changes cover the complete archive through " + S[LAST] + ". They are held back while reading through " + S[st.idx] + "."),
      h("button", { type: "button", class: "btn", onclick: () => setMode("complete") }, "Show the complete history"),
    ];
    const disc = Array.isArray(d.archival_discoveries) ? d.archival_discoveries : [];
    const later = Array.isArray(d.later_events) ? d.later_events : [];
    const item = (x, dateTxt) => h("li", null,
      x.entry && ENT.has(x.entry) ? h("button", { type: "button", class: "linkish", onclick: () => openEntry(x.entry, { from: "panel" }) }, x.title || ENT.get(x.entry).title) : h("b", null, x.title || "Record"),
      dateTxt ? h("span", { class: "muted" }, " · " + dateTxt) : null,
      x.text ? h("div", { class: "small" }, rich(x.text)) : null);
    const out = [h("h3", null, h("span", { lang: "fr" }, "Depuis l'édition précédente"), h("small", null, "Since the previous edition" + (prev.edition ? " (" + prev.edition + ")" : "")))];
    const arch = [];
    if (ar.previous_last && ar.current_last) arch.push(ar.previous_last === ar.current_last ? "The archive still ends at " + ar.current_last + "; no new saves." : "The archive now runs to " + ar.current_last + " (previously " + ar.previous_last + ")" + (Array.isArray(ar.new_snapshots) ? ", " + plural(ar.new_snapshots.length, "new save") : "") + ".");
    if (arch.length) out.push(h("p", { class: "note" }, arch));
    // Editor-assigned highlights (v4): the consequential storylines first.
    const hl = Array.isArray(d.highlights) ? d.highlights : [];
    if (hl.length) {
      out.push(h("p", { class: "group-h" }, h("span", { lang: "fr" }, "À retenir"), " ", h("span", null, "· the most consequential changes, chosen by the editors (" + hl.length + ")")));
      out.push(h("ol", { class: "delta highlights" }, hl.map((x) => item(x, x.date ? (x.date.length === 10 ? x.date : null) : null))));
    }
    const discList = disc.length ? h("ul", { class: "delta" }, disc.map((x) => item(x, null))) : h("p", { class: "note" }, "None recorded.");
    const laterList = later.length ? h("ul", { class: "delta" }, later.map((x) => item(x, x.date || (x.b ? "by " + x.b : null)))) : h("p", { class: "note" }, "None: no later game events are in this edition.");
    const infra = d.infrastructure && d.infrastructure.count ? h("p", { class: "note" }, plural(d.infrastructure.count, "infrastructure milestone") + " (hyper relays and gateways) are grouped under ", ENT.has(d.infrastructure.entry) ? h("button", { type: "button", class: "linkish", onclick: () => openEntry(d.infrastructure.entry, { from: "panel" }) }, ENT.get(d.infrastructure.entry).title) : "one entry", ".") : null;
    const group = (fr, en, n, body) => hl.length ? h("details", { class: "ev" }, h("summary", null, h("span", { lang: "fr" }, fr), " · " + en + " (" + n + ")"), body) : [h("p", { class: "group-h" }, h("span", { lang: "fr" }, fr), " ", h("span", null, "· " + en + " (" + n + ")")), body];
    out.push(group("Nouveaux événements", "every game event after the previous archive ended", later.length, [laterList, infra]));
    out.push(group("Nouvelles recherches", "new research, corrections and closed threads", disc.length, discList));
    return out;
  }

  // ---------------------------------------------------------------- search
  // Full-text index: titles and names rank first; story text, chapter
  // context and choices next; sources last. Each unit carries the snapshot
  // from which it is established, so through-date reading never shows a
  // snippet from a later record.
  const SEARCH = [];
  const unitsOf = (e) => {
    const u = [];
    if (e.lede) u.push({ t: e.lede, gate: "lede", w: 4, where: null });
    if (e.role) u.push({ t: e.role, gate: null, w: 4, where: null });
    for (const p of e.body) if (p && p.t) u.push({ t: p.t, gate: { p }, w: 5, where: null });
    for (const c of e.chapters) {
      const ci = chapterIdx(c), name = c.summary || c.t || "chapter";
      for (const t of [c.summary, c.t, c.context]) if (t) u.push({ t, gate: ci, w: 5.5, where: "Chapter: " + name });
      for (const t of [c.branch, c.optText]) if (t) u.push({ t, gate: choiceIdx(c), w: 5.5, where: "Choice in " + name });
      if (c.note) u.push({ t: c.note, gate: isIdx(c.note_idx) ? c.note_idx : choiceIdx(c), w: 5.5, where: "Choice in " + name });
      if (c.outcome) u.push({ t: c.outcome, gate: outcomeIdx(c), w: 5.5, where: "Outcome of " + name });
    }
    for (const p of e.body) for (const s of p && p.src || []) if (typeof s === "string") u.push({ t: s, gate: { p }, w: 8, where: "Source" });
    for (const id of e.excerpts || []) { const x = EXCERPTS[id]; if (x && (x.title || x.text)) u.push({ t: [x.title, x.text].filter(Boolean).join(" — "), gate: excerptGate(x), w: 8, where: "Source excerpt" }); }
    for (const x of Array.isArray(e.status) ? e.status : []) if (x && x.value != null) u.push({ t: x.label + ": " + x.value, gate: isIdx(x.gate_idx) ? x.gate_idx : x.b === "save" ? LAST : null, w: 6, where: "Status" });
    return u.map((x) => ({ ...x, nm: normMap(x.t) }));
  };
  for (const e of ENTRIES) {
    const s = e.system && SYS.get(e.system);
    SEARCH.push({ type: e.kind, ent: e, rank: isRecord(e) ? 3 : isPerson(e) ? 0.5 : 0, label: e.title || "Untitled", sub: kindOf(e).en + (s ? " · " + s.name : "") + (e.fr ? " · " + e.fr : ""), keys: [norm(e.title), norm(e.fr), ...e.aka.map(norm)], units: unitsOf(e), go: () => openEntry(e.id, { from: "search" }) });
  }
  for (const s of SYSTEMS) SEARCH.push({ type: "system", rank: 1, label: s.name, sub: "System" + ((entriesAt.get(s.id) || []).some(curated) ? " · has stories" : ""), keys: [norm(s.name)], go: () => selectSystem(s.id, { fly: true, from: "search" }) });
  let worldsIndexed = false;
  function addWorldSearch() {
  if (worldsIndexed) return;
  worldsIndexed = true;
  for (const [id, { s, b }] of BODY) {
    const x = b[3] || {};
    const names = new Set([b[1]]);
    if (x.n) for (const r of normRuns(x.n)) names.add(r[2]);
    const shown = [...names].filter((n) => n && !/^CONTFR_|^[A-Z0-9_]{6,}$/.test(n));
    if (!shown.length) continue;
    SEARCH.push({ type: "world", rank: 2, label: shown[shown.length - 1] === b[1] ? b[1] : shown.join(" / "), sub: (b[2] || "World") + " · " + s.name + (shown.length > 1 ? " · also " + shown.filter((n) => n !== b[1]).join(", ") : ""), keys: shown.map(norm), go: () => {
      const story = ENTRIES.find((e) => e.planet === id && curated(e));
      if (story) openEntry(story.id, { from: "search" }); else selectSystem(s.id, { fly: true, from: "search", planet: id });
    } });
  }
  }
  if (PARTS.worlds) addWorldSearch();
  function unitShown(it, u) {
    if (!through()) return true;
    if (u.gate === "lede") return ledeShown(it.ent);
    if (u.gate && u.gate.p) return shownAt(paraGate(u.gate.p, it.ent));
    return shownAt(u.gate);
  }
  function snippet(u, words) {
    const pos = u.nm.n.indexOf(words[0]);
    if (pos < 0) return null;
    const o0 = u.nm.map[pos], o1 = u.nm.map[Math.min(u.nm.map.length - 1, pos + words[0].length - 1)] + 1;
    const t = u.t, a = Math.max(0, o0 - 50), b = Math.min(t.length, o1 + 70);
    return [a > 0 ? "…" : "", t.slice(a, o0), h("mark", null, t.slice(o0, o1)), t.slice(o1, b), b < t.length ? "…" : ""];
  }
  const TYPE_LABEL = { story: "Story", lore: "Lore", person: "Person", institution: "Institution", site: "Dig site", rift: "Rift", system: "System", world: "World" };
  const q = $("#q"), results = $("#results");
  let hits = [], active = -1;
  // Hosted edition: world names and source references live in the deferred
  // worlds and evidence parts. Search requests whichever is missing (ensurePart
  // coalesces and retries), reruns the active query after each arrival, and
  // labels results as incomplete until both are in. A failure is shown with
  // Retry; the next keystroke or Retry tries again (never an automatic loop).
  const SEARCH_PARTS = ["worlds", "evidence"];
  const searchLoad = { busy: 0, error: null, again: new Set() };
  const searchMissing = () => (HOST ? SEARCH_PARTS.filter((p) => !PARTS[p]) : []);
  function loadSearchParts() {
    const missing = searchMissing().filter((p) => !searchLoad[p]);
    if (!missing.length) return;
    searchLoad.error = null;
    for (const p of missing) {
      searchLoad[p] = true; searchLoad.busy++;
      ensurePart(p).then(() => { if (p === "worlds") update(); }, (err) => { if (!searchLoad.again.has(p)) searchLoad.error = err || new Error("unknown error"); })
        .then(() => {
          searchLoad[p] = false; searchLoad.busy--;
          // A retry the reader asked for while this part was in flight gets
          // one more attempt (bounded: one per reader action).
          if (searchLoad.again.delete(p) && !PARTS[p]) { loadSearchParts(); return; }
          if (!results.hidden) runSearch();
        });
    }
  }
  // Reader action (Retry, or typing after a failure): clear the error, retry
  // idle parts now and parts still in flight once more if they fail.
  function userRetrySearch() {
    if (!searchLoad.error) return;
    searchLoad.error = null;
    for (const p of SEARCH_PARTS) if (searchLoad[p]) searchLoad.again.add(p);
  }
  function retrySearchParts() { userRetrySearch(); loadSearchParts(); if (!results.hidden) runSearch(); }
  function runSearch() {
    const t = norm(q.value).trim();
    if (t.length < 2) { closeResults(); return; }
    const missing = searchMissing();
    if (missing.length && !searchLoad.error) loadSearchParts(); // requests only parts not already in flight
    const words = t.split(/\s+/).filter(Boolean);
    const wordRe = new RegExp("(^|[\\s'\\-])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const scored = [];
    for (const it of SEARCH) {
      let best = Infinity, snip = null, where = null;
      for (const k of it.keys) {
        if (!k || !words.every((w) => k.includes(w))) continue;
        const sc = k === t ? 0 : k.startsWith(t) ? 1 : wordRe.test(k) ? 2 : 3;
        best = Math.min(best, sc + (k === it.keys[0] ? 0 : 1.5));
      }
      const ny = it.ent && notYet(it.ent);
      if (it.units && !ny) for (const u of it.units) {
        if (u.w >= best) break;
        if (!words.every((w) => u.nm.n.includes(w)) || !unitShown(it, u)) continue;
        best = u.w; snip = snippet(u, words); where = u.where;
        break;
      }
      if (best < Infinity) scored.push([best * 10 + it.rank, it, snip, where, ny]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
    // Keep world siblings from crowding out stories: at most six worlds.
    let worlds = 0, extraWorlds = 0;
    const kept = [];
    for (const x of scored) {
      if (x[1].type === "world" && ++worlds > 6) { extraWorlds++; continue; }
      kept.push(x);
      if (kept.length >= 30) break;
    }
    hits = kept.map((x) => x[1]);
    active = hits.length ? 0 : -1;
    const lis = kept.map(([, it, snip, where, ny], k) => h("li", { role: "option", id: "res-" + k, "aria-selected": String(k === active), onmousedown: (e) => { e.preventDefault(); choose(k); } },
      h("span", { class: "r-kind" }, TYPE_LABEL[it.type] || "Record"), h("span", { class: "r-name" }, it.label),
      h("span", { class: "r-sub" }, ny ? "Not yet observed at " + S[st.idx] + " · " + it.sub : it.sub),
      snip ? h("span", { class: "r-snip" }, where ? h("b", null, where + ": ") : null, snip) : null));
    if (extraWorlds) lis.push(h("li", { class: "r-empty", role: "option", "aria-disabled": "true" }, "+" + plural(extraWorlds, "more world") + " — refine the search to see them."));
    const what = missing.map((p) => (p === "worlds" ? "world names" : "source references")).join(" and ");
    const status = !missing.length ? null : searchLoad.error
      ? h("li", { class: "r-empty r-status bad", role: "option", "aria-disabled": "true" }, "Results are incomplete: the " + what + " could not be loaded" + (navigator.onLine === false ? " while offline" : "") + ". ",
        h("button", { type: "button", class: "linkish", id: "searchRetry", onmousedown: (e) => { e.preventDefault(); retrySearchParts(); } }, "Retry"))
      : h("li", { class: "r-empty r-status", role: "option", "aria-disabled": "true" }, "Loading the " + what + "… results may be incomplete.");
    const none = h("li", { class: "r-empty", role: "option", "aria-disabled": "true" }, (missing.length ? "No match yet in the loaded part of the atlas for “" : "No system, world, person or story matches “") + q.value.trim() + "”" + (through() ? " in the history through " + S[st.idx] : "") + ".");
    fill(results, status, lis.length ? lis : none);
    results.hidden = false;
    q.setAttribute("aria-expanded", "true");
    if (active >= 0) q.setAttribute("aria-activedescendant", "res-" + active); else q.removeAttribute("aria-activedescendant");
  }
  function moveActive(d) {
    if (!hits.length) return;
    active = (active + d + hits.length) % hits.length;
    results.querySelectorAll("li[id^='res-']").forEach((li, k) => li.setAttribute("aria-selected", String(k === active)));
    q.setAttribute("aria-activedescendant", "res-" + active);
    const li = $("#res-" + active); if (li) li.scrollIntoView({ block: "nearest" });
  }
  function choose(k) { const it = hits[k]; if (!it) return; closeResults(); q.blur(); it.go(); }
  function closeResults() { results.hidden = true; q.setAttribute("aria-expanded", "false"); q.removeAttribute("aria-activedescendant"); }
  q.addEventListener("input", () => { userRetrySearch(); runSearch(); });
  q.addEventListener("focus", () => { if (q.value.trim().length >= 2) runSearch(); });
  q.addEventListener("blur", () => setTimeout(closeResults, 120));
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (results.hidden) runSearch(); else moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter") { if (active >= 0) { e.preventDefault(); choose(active); } }
    else if (e.key === "Escape") { if (!results.hidden) { e.preventDefault(); closeResults(); } else q.value = ""; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== q && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });

  // ---------------------------------------------------------------- legend
  function renderLegend() {
    const rep = cColor(REP);
    const sw = (style) => h("span", { class: "lg-sw", style, "aria-hidden": "true" });
    fill($("#legendBody"),
      h("div", { class: "lg-row" }, sw("background:" + rep + ";border-radius:50%;width:10px;flex-basis:10px;height:10px;margin:0 4px"), "République de la Continuité"),
      h("div", { class: "lg-row" }, sw("background:linear-gradient(90deg,#c46a8a,#6fae8a,#8f86d9);border-radius:6px;height:8px"), "Other empires, in their saved colours"),
      h("div", { class: "lg-row" }, sw("background:#cfc6b2;opacity:.45;border-radius:50%;width:7px;flex-basis:7px;height:7px;margin:0 5px"), "Unclaimed system"),
      h("div", { class: "lg-row" }, sw("border:1.5px solid #e3cf94;border-radius:50%;width:14px;flex-basis:14px;height:14px;margin:0 2px"), "Curated story"),
      h("div", { class: "lg-row" }, sw("background:#d6a35c;transform:rotate(45deg) scale(.6);width:12px;flex-basis:12px;height:12px;margin:0 3px"), "Dig site record"),
      h("div", { class: "lg-row" }, sw("border:1.6px solid #a596f2;border-radius:50%;width:9px;flex-basis:9px;height:9px;margin:0 4.5px"), "Astral rift record"),
      h("div", { class: "lg-row" }, sw("border-top:1.6px dashed #6f8bd6;height:0;margin-top:2px"), "Journey route"),
      h("p", { class: "lg-note" }, st.terr ? "Territory shading is approximate (nearest owned system), not the game's borders. Dots and lanes carry the exact recorded owners." : "Territory shading is off. Dots and lanes carry the exact recorded owners."));
  }

  // ---------------------------------------------------------------- hash
  let hashTimer = null, applyingHash = false;
  function syncHash() {
    if (applyingHash) return;
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const p = new URLSearchParams();
      if (st.entry) p.set("e", st.entry);
      else if (st.sys) p.set("s", st.sys);
      if (st.planet && !st.entry) p.set("p", st.planet);
      p.set("d", S[st.idx]);
      if (st.mode === "through") p.set("m", "through");
      if (st.journey) p.set("j", st.journey);
      if (!st.follow) p.set("f", "keep");
      if (st.allRec) p.set("r", "all");
      if (st.tab !== "story") p.set("t", st.tab);
      if (reading()) p.set("ui", "read");
      if (st.tab === "index" && st.view !== "stories") p.set("v", st.view);
      const str = "#" + p.toString();
      if (location.hash !== str) try { history.replaceState(null, "", str); } catch (err) { /* file:// sandboxes may refuse */ }
    }, 250);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const out = {};
    if (p.get("d") && SNAP.has(p.get("d"))) out.idx = SNAP.get(p.get("d"));
    if (p.get("e") && ENT.has(p.get("e"))) out.entry = p.get("e");
    if (p.get("s") && SYS.has(p.get("s"))) out.sys = p.get("s");
    if (p.get("p") && BODY.has(p.get("p"))) out.planet = p.get("p");
    if (p.get("j") && JRN.has(p.get("j"))) out.journey = p.get("j");
    if (p.get("t") && TABS.includes(p.get("t"))) out.tab = p.get("t");
    if (p.get("m") === "through") out.mode = "through";
    if (p.get("f") === "keep") out.follow = false;
    if (p.get("r") === "all") out.allRec = true;
    if (["people", "threads"].includes(p.get("v"))) out.view = p.get("v");
    if (p.get("ui") === "read") out.read = true;
    return out;
  }
  function applyHash(hs, initial) {
    applyingHash = true;
    if (hs.idx != null) st.idx = hs.idx;
    st.mode = hs.mode || "complete";
    st.follow = hs.follow !== false;
    st.allRec = !!hs.allRec;
    st.view = hs.view || "stories";
    st.journey = hs.journey || null;
    for (const b of document.querySelectorAll("#modeSeg [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === st.mode));
    if (hs.entry) openEntry(hs.entry, { fly: !initial, date: hs.idx });
    else if (hs.sys) selectSystem(hs.sys, { fly: !initial, planet: hs.planet });
    if (hs.tab) showTab(hs.tab);
    if (isPhone()) setSheet(hs.read ? "full" : drawer.dataset.sheet === "full" ? "half" : drawer.dataset.sheet);
    applyingHash = false;
    update();
  }
  window.addEventListener("hashchange", () => { const hs = readHash(); if (Object.keys(hs).length) applyHash(hs, false); });

  // ---------------------------------------------------------------- update
  function updateReadouts() {
    const i = st.idx;
    range.value = String(i);
    range.setAttribute("aria-valuetext", S[i] + ", saved observation " + (i + 1) + " of " + N);
    $("#tlDate").textContent = S[i];
    $("#tlIdx").textContent = "save " + (i + 1) + " / " + N;
    $("#tlPrev").disabled = i <= 0;
    $("#tlNext").disabled = i >= LAST;
    const repN = SYSTEMS.reduce((n, s) => n + (presentAt(s, i) && ownerAt(s, i) === REP ? 1 : 0), 0);
    const ev = st.event && EVT.get(st.event);
    const w = ev ? when(ev) : null;
    const note = $("#tlNote");
    if (w) fill(note, "Event ", h("b", null, w.label), " — " + w.note);
    else if (st.playGroup) fill(note, h("b", null, S[st.playGroup.idx]), " · " + st.playGroup.list.slice(0, 2).map((e) => e.t).join("; ") + (st.playGroup.list.length > 2 ? " +" + (st.playGroup.list.length - 2) + " more" : ""));
    else fill(note, "République holds ", h("b", null, String(repN)), " systems in this save. Changes between saves are intervals; dates recorded in saves stay exact.");
    const car = $("#cartouche");
    const sel = st.sys && SYS.get(st.sys);
    fill(car,
      h("div", { class: "c-k", lang: "fr" }, "Carte au " + S[i], through() ? h("span", { class: "c-mode" }, " · lecture datée") : null),
      h("div", { class: "c-date" }, sel ? sel.name : "République de la Continuité"),
      h("div", { class: "c-sub" }, sel ? (presentAt(sel, i) ? (ownerAt(sel, i) ? "Held by " + cName(ownerAt(sel, i)) : "Unclaimed") + " at " + S[i] : "Not yet in the saves at " + S[i]) : repN + " systems held at " + S[i]),
      w && w.kind !== "exact" ? h("div", { class: "c-note" }, h("b", null, w.badge + ": "), w.note) : w ? h("div", { class: "c-note" }, w.note) : null);
    cv.setAttribute("aria-label", "Galaxy map at " + S[i] + (sel ? ", " + sel.name + " selected" : "") + ". République holds " + repN + " systems.");
    document.body.classList.toggle("mode-through", through());
  }
  function update() {
    // A moving story's selection follows its recorded position at the map date.
    const me = st.entry && ENT.get(st.entry);
    if (me && me.track && me.track.length) { const loc = entryLoc(me, st.idx); if (loc) st.sys = loc; }
    updateReadouts();
    updateReadbar();
    if (!scrubbing && !(playTimer && st.tab === "chron")) renderPanel(st.tab);
    renderFilters();
    drawTicks();
    requestRender();
    syncHash();
    if (!results.hidden) runSearch();
  }

  // ------------------------------------------------------------------ init
  q.value = "";
  $("#spanDates").textContent = S[0] + " – " + S[LAST];
  renderLegend();
  if (!isNarrow()) $("#legend").open = true;
  if (isNarrow()) setSheet("half");
  new ResizeObserver(() => resize()).observe($("#mapbox"));
  window.addEventListener("resize", resize);
  resize();
  const hs = readHash();
  if (Object.keys(hs).length) applyHash(hs, true);
  else {
    // The edition names its landing entry (v4: the current-state story); Terre otherwise.
    const first = ENT.get(META.default_entry) || ENT.get("story:terre");
    if (first) { st.entry = first.id; st.sys = first.system; st.planet = first.planet; }
    showTab("story");
    update();
  }
  const frame = () => {
    if (!W || !H) return;
    pendingFrame = null;
    const list = repCore(st.idx);
    if (hs.entry || hs.sys) { if (st.sys) { const s = SYS.get(st.sys); setView(s.wx, s.wy, 3); } else fitGalaxy(); return; }
    if (!list.length) { fitGalaxy(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of list) { x0 = Math.min(x0, s.wx); x1 = Math.max(x1, s.wx); y0 = Math.min(y0, s.wy); y1 = Math.max(y1, s.wy); }
    const pd = 50, k = clampK(Math.min((W - 2 * pd) / Math.max(1, x1 - x0), (H - 2 * pd) / Math.max(1, y1 - y0), 6));
    setView((x0 + x1) / 2, (y0 + y1) / 2, k);
  };
  pendingFrame = frame;
  frame();
  if (!W || !H) requestAnimationFrame(() => { resize(); frame(); });
  // Hosted edition: world details follow right after the first paint (system
  // views, world search and planet chips need them); source evidence loads
  // only when a reader opens an evidence block or searches.
  if (!PARTS.worlds) setTimeout(() => ensurePart("worlds").then(() => update()).catch(() => { /* retried on demand */ }), 250);
  if (HOST) HOST.onUpdate(showUpdate);
  // Test hook: read-only handles for automated checks (no behaviour depends on it).
  window.__atlas = { state: st, view, selectSystem, openEntry, selectEvent, setIdx: (i) => scrub(i), setMode, showTab, startJourney, journeyStep, stepEvent, startPlay, stopPlay, setSheet, chronList: () => chronList().map((e) => e.id), counts: { systems: SYSTEMS.length, entries: ENTRIES.length, events: EVENTS.length, journeys: JOURNEYS.length },
    parts: () => ({ ...PARTS }), data: () => D,
    memory: () => ({ territoryEntries: terrCache.size, territoryBytes: terrBytes, territoryBudget: TERR_BUDGET, grid: terrG, builds: terrBuilds, transientPerBuild: 10 * terrG * terrG, worstCase: TERR_BUDGET + 10 * terrG * terrG }) };
  }
})();
