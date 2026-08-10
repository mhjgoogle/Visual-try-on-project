// Canvas persistence — the mockup's OWN editable state (script drafts, node
// positions, edges), keyed by project name. Prototype-local scratch only: it is
// NOT a projection of core facts and is never written back to any core file.
//
// - With the backend: PUT/GET /api/canvas/<name> → data/<name>.json.
// - Without it: localStorage fallback, so the static demo still persists.
//
// Every load (server AND localStorage) routes through the schema migration
// dispatcher in canvasschema.js. A load that fails safe (corrupt payload,
// newer-than-supported version, invalid document) BLOCKS subsequent saves for
// that project so the stored document — which may still be recoverable — is
// never overwritten by an empty/partial in-memory state.
//
// All per-name state lives in Maps (never plain-object dictionaries): a canvas
// legally named `constructor` or `__proto__` must hit ONLY its own entry, not
// something inherited from Object.prototype.

import { migrateToCurrent } from "./canvasschema.js";

const _timers = new Map();
// Per-project top-level fields present in the loaded document but not produced
// by the serializer — preserved verbatim across the save round-trip so a field
// written by a future checkpoint is not silently dropped by this build.
const _extras = new Map();
// Per-project save block: { reason } after a fail-safe load, absent when
// saving is allowed.
const _blocked = new Map();
// Per-project count of in-flight loads — saves must not race ANY pending
// load (a counter, not a boolean: concurrent loads of the same name must
// each hold the latch until they settle).
const _loading = new Map();
// Per-project load serialization: overlapping loads of the same name run one
// after another, so the LAST-run load always reads the freshest stored state
// and no stale success can clear a block set by a fresher failed read.
const _loadChain = new Map();

// Top-level fields the app serializer owns (see serializeGraph in app.js).
// Anything else in a loaded document is carried through saves untouched.
const OWNED_FIELDS = ["v", "project", "scriptDoc", "story", "scripts", "assets", "generations", "production", "timelines", "nodes", "edges", "pan"];

function _dispatch(name, raw) {
  const res = migrateToCurrent(raw);
  if (res.status === "ok") {
    _blocked.delete(name);
    // null prototype so an unknown `__proto__` field is stored as a plain own
    // key (and later spread back into the save) instead of mutating the
    // prototype and silently vanishing.
    const extras = Object.create(null);
    for (const k of Object.keys(res.doc)) {
      if (!OWNED_FIELDS.includes(k)) extras[k] = res.doc[k];
    }
    _extras.set(name, extras);
    return { status: "ok", doc: res.doc, fromVersion: res.fromVersion };
  }
  if (res.status === "empty") {
    _blocked.delete(name);
    _extras.set(name, Object.create(null));
    return { status: "empty" };
  }
  // unsupported / invalid — fail safe, keep the stored document intact
  _blocked.set(name, { reason: res.status, detail: res.detail, version: res.version });
  return res;
}

function _fail(name, reason, detail) {
  _blocked.set(name, { reason, detail });
  return { status: reason, detail };
}

/** Why saving is blocked for `name` after a fail-safe load, or null. */
export function saveBlockedReason(name) {
  return _blocked.get(name) || null;
}

/**
 * Load a saved canvas document for `name`.
 *
 * Returns { status: "ok", doc, fromVersion } | { status: "empty" }
 *       | { status: "corrupt" | "unsupported" | "invalid" | "unavailable", … }.
 * Every non-ok/non-empty status also blocks saveCanvas for this project.
 */
export function loadCanvas(name) {
  const run = async () => {
    // A load supersedes any queued autosave: pending state belongs to the
    // PREVIOUS in-memory graph, and letting it fire while this load is still
    // in flight could overwrite the very document being inspected (before a
    // fail-safe outcome manages to set the block). Cancel it, and refuse new
    // save scheduling until this load settles.
    clearTimeout(_timers.get(name));
    _timers.delete(name);
    _loading.set(name, (_loading.get(name) || 0) + 1);
    try {
      return await _loadCanvasInner(name);
    } finally {
      _loading.set(name, _loading.get(name) - 1);
    }
  };
  const p = (_loadChain.get(name) || Promise.resolve()).then(run, run);
  _loadChain.set(name, p.catch(() => {})); // keep the chain alive after failures
  return p;
}

async function _loadCanvasInner(name) {
  let backend = false;
  try {
    const r = await fetch(`/api/canvas/${encodeURIComponent(name)}`, { cache: "no-store" });
    // Only a JSON response is the canvas backend speaking. A static host
    // (no server.py) answers these URLs too — 404s, or 200 HTML from an
    // index fallback — and must keep the documented localStorage fallback.
    const ctype = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
    backend = ctype.includes("application/json");
    if (backend) {
      if (r.ok) return _dispatch(name, await r.json());
      // The backend answered but refused: the stored file exists yet cannot
      // be served as a document (corrupt JSON → 409, read failure → 5xx).
      // Do NOT fall through to localStorage — the server copy is
      // authoritative — and do not let an empty canvas overwrite it.
      let category = "";
      try {
        category = (await r.json())?.error?.category || "";
      } catch {
        /* unreadable error body */
      }
      return _fail(name, category === "corrupt_save" ? "corrupt" : "unavailable", category || `http ${r.status}`);
    }
  } catch {
    if (backend) return _fail(name, "corrupt", "unreadable response body");
  }
  // no backend — static demo persists via localStorage
  let s = null;
  try {
    s = localStorage.getItem("motv:" + name);
  } catch {
    return _dispatch(name, null); // storage unavailable: genuinely nothing saved
  }
  if (s == null) return _dispatch(name, null);
  try {
    return _dispatch(name, JSON.parse(s));
  } catch {
    // Corrupt local save: leave the stored string untouched (it may be
    // recoverable by hand) and block saves so it cannot be overwritten.
    return _fail(name, "corrupt", "localStorage JSON parse failed");
  }
}

/** Debounced save of the canvas graph for `name`. No-op while a fail-safe
 *  load has saving blocked (the stored document must stay recoverable). */
export function saveCanvas(name, data) {
  if (_blocked.has(name)) {
    console.warn(`motv: canvas save for "${name}" skipped (${_blocked.get(name).reason}) — stored document preserved`);
    return;
  }
  if (_loading.get(name)) {
    // A load is in flight: this save describes the graph being replaced, and
    // scheduling it could overwrite a document the load is about to reject.
    console.warn(`motv: canvas save for "${name}" skipped (load in flight)`);
    return;
  }
  clearTimeout(_timers.get(name));
  _timers.set(name, setTimeout(async () => {
    // Re-check at fire time: a fail-safe load may have blocked this project
    // AFTER the save was queued — the queued write must not slip through.
    if (_blocked.has(name) || _loading.get(name)) return;
    // Re-attach loaded fields this build does not own so a round-trip through
    // an older build never drops a future checkpoint's data.
    const body = JSON.stringify({ ...(_extras.get(name) || {}), ...data });
    try {
      const r = await fetch(`/api/canvas/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return;
    } catch {
      /* fall through to localStorage */
    }
    // The awaited PUT gives a blocking load a window to land — check again
    // before touching the local copy.
    if (_blocked.has(name) || _loading.get(name)) return;
    try {
      localStorage.setItem("motv:" + name, body);
    } catch {
      /* nothing we can do — keep the in-memory graph */
    }
  }, 700));
}
