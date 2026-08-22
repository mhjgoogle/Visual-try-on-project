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
//
// WHAT AUTOSAVE GUARANTEES (TASK-057), and what it does not:
//  - an edit reaches the canonical document as it is typed (ui/fieldsync.js) and
//    this module writes it 700ms later;
//  - a page teardown (pagehide / visibilitychange:hidden) writes immediately
//    instead of waiting for that timer, with `keepalive` so the request outlives
//    the document — for bodies under the Fetch standard's 64 KiB keepalive
//    ceiling, which a canvas exceeds only once its registries are large;
//  - writes for one project are SERIALIZED, so an older save can never land
//    after a newer one and overwrite it. A teardown write is the one exception:
//    it cannot afford to wait behind a request in flight (the page may be gone
//    before that one settles), so it jumps the queue and ABORTS the write it
//    supersedes — safe because every PUT carries the whole document, so the
//    newer body already contains everything the older one did.
//
// NOT guaranteed, and NOT fixable from this file: once a PUT has left the
// browser, nothing here can stop the server from applying it. A write this module
// supersedes is cancelled and every write still waiting is dropped, so the only
// remaining window is a request the server had already received — if it applies
// after the newer one, it overwrites it. Closing that needs the WRITE ORDER to be
// decided where the writes land: a monotonic write ordinal (or If-Match) on
// /api/canvas/<name>, with the server refusing anything older than what it has.
// That is a backend contract change, not a client heuristic — an earlier
// revision of this module tried to settle precedence locally and review found a
// steady series of ordering defects in exactly that decision. Recorded as a
// follow-up rather than guessed at again.
//
// Also NOT guaranteed: a reload in the last moments before a large document's write
// completes can lose that final edit. An earlier revision of this module kept an
// unconfirmed copy in localStorage and preferred it on the next load; that made
// this file decide, from local heuristics alone, whether a retained body should
// override the server, and review found a steady series of ordering defects in
// exactly that decision (a replay over a newer confirmed edit being the last).
// The decision was removed rather than refined: no precedence is inferred here,
// so none can be inferred wrongly. Offering the creator an explicit "restore
// unsaved changes?" choice is the right shape for that feature, and belongs in
// the UI with its own task — not in a heuristic buried in the save path.

import { migrateToCurrent } from "./canvasschema.js";
import { attempt, API_ERROR } from "./apiclient.js";

const _timers = new Map();
// The payload of the save queued for each project, so a page teardown can still
// write it after the debounce timer is cancelled.
const _pendingSaves = new Map();
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
// Per-project WRITE serialization, for the same reason in the other direction:
// two concurrent PUTs can complete out of order, and an older one landing last
// would overwrite the server with stale content. One write at a time, in order,
// makes that impossible by construction rather than by careful bookkeeping.
const _saveChain = new Map();
// Per-project record of the write currently in flight:
//   { ctl, data, keepalive }
// The controller lets a newer write cancel the older snapshot it overtakes (which
// could otherwise land last and overwrite it), and `data`/`keepalive` let a flush
// recognise a body that is ALREADY on the wire in a form that survives teardown,
// so it does not re-send it and cancel itself in the process.
const _inflight = new Map();
// Per-project WRITE GENERATION. Two events make every write queued before them
// stale: a teardown snapshot (it already contains their content) and a load (it
// replaces the graph they describe). Both bump the generation; a write stamps it
// when queued and re-checks it when it runs, so a write that lost its meaning
// while it waited is dropped instead of landing on top of newer state.
const _writeGen = new Map();
// Total bytes of keepalive requests currently in flight. The Fetch standard's
// 64 KiB ceiling is an AGGREGATE across them, not a per-request limit, so several
// individually-small teardown saves can push the newest one over it — and a
// rejected keepalive request is not sent at all.
let _keepaliveBytes = 0;

function _bumpWriteGen(name) {
  const next = (_writeGen.get(name) || 0) + 1;
  _writeGen.set(name, next);
  return next;
}

/** Cancel the write in flight for `name`, if any — ordinary or teardown. Used
 *  when something newer supersedes it: a newer teardown snapshot, or a load that
 *  replaces the graph it describes. */
function _abortInflight(name) {
  const cur = _inflight.get(name);
  if (!cur) return;
  _inflight.delete(name);
  if (!cur.ctl) return; // no AbortController in this environment
  try {
    cur.ctl.abort();
  } catch {
    /* already settled — nothing to cancel */
  }
}

// Top-level fields the app serializer owns (see serializeGraph in app.js).
// Anything else in a loaded document is carried through saves untouched.
const OWNED_FIELDS = [
  "v", "project", "scriptDoc", "story", "scripts", "assets", "generations", "skillRuns",
  "production", "timelines", "prompts",
  // TASK-064 Phase 2 / Phase 3. A field the serializer writes must be listed
  // here so it is not ALSO captured as a foreign "extra" — the save merges
  // `{...extras, ...data}`, so the serializer's value still wins, but an
  // unlisted field would be kept in a second, permanently stale copy that the
  // next load would re-read and carry forward forever.
  "refInterp", "frameBindings", "locks", "shotAudio", "subtitles",
  // TASK-066 §5: which side of the chain each reference binding serves. Absent =
  // derived from the role, which is why an existing document needs no migration.
  "refUse",
  // TASK-067 §15: cached derived conclusions (asset recommendation / continuity
  // summary / prompt review), each keyed by the revision of the context it came
  // from. A conclusion ABOUT canon, never a copy of it.
  "ctxCache",
  "nodes", "edges", "pan",
];

function _dispatch(name, raw, { legacy = false } = {}) {
  const res = migrateToCurrent(raw);
  if (res.status === "ok") {
    // ADR-0053: a document served out of the legacy repo scratch is READ-ONLY
    // until the creator migrates the project. Loading it is right — they need
    // to see what they have before deciding — but every save the server would
    // refuse with 409 must be blocked here too, or the studio autosaves into
    // a void and reports nothing.
    if (legacy) {
      _blocked.set(name, {
        reason: "legacy_unmigrated",
        detail: "画布与媒体还在旧的仓库 scratch 目录，迁移到项目目录后才能编辑",
      });
    } else {
      _blocked.delete(name);
    }
    // null prototype so an unknown `__proto__` field is stored as a plain own
    // key (and later spread back into the save) instead of mutating the
    // prototype and silently vanishing.
    const extras = Object.create(null);
    for (const k of Object.keys(res.doc)) {
      if (!OWNED_FIELDS.includes(k)) extras[k] = res.doc[k];
    }
    _extras.set(name, extras);
    return { status: "ok", doc: res.doc, fromVersion: res.fromVersion, legacy };
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
    // Cancelling the timer is not enough: the PAYLOAD it would have written must
    // go too. It describes the graph this load is replacing, and anything that
    // writes queued payloads later — a teardown flush after the load settles —
    // would send it and overwrite the freshly loaded document with pre-load
    // state. Drop it here, where the graph it belongs to stops being current.
    _pendingSaves.delete(name);
    // Same reasoning for writes that already left the queue: one WAITING on the
    // save chain must not run after this load (the generation bump drops it), and
    // one already in flight must not land after it (cancelled). What the server
    // may already have received cannot be recalled from here — see the module
    // header's note on write ordering.
    _bumpWriteGen(name);
    _abortInflight(name);
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

/** Did the CANVAS BACKEND answer this, or is there no backend at all?
 *
 *  The whole fallback decision hangs on this one distinction, and it is NOT the
 *  same as "did the request succeed". A static host (no `server.py`) answers
 *  these URLs too — 404s, or 200 HTML from an index fallback — and must keep the
 *  documented localStorage fallback. A backend that answered 409/5xx is
 *  authoritative and must NOT be fallen back from, or an empty canvas overwrites
 *  a recoverable file.
 *
 *  Two independent pieces of evidence, either of which proves a backend spoke:
 *  a parsed `{error:{…}}` body (this project's error convention), or a
 *  `application/json` content type — the latter also covers the case the old
 *  code caught in its `catch`: JSON headers with a body that would not parse,
 *  which is a CORRUPT server document, not an absent server. */
function _backendSpoke(err) {
  if (!err) return false;
  if (err.body !== null && err.body !== undefined) return true;
  return String(err.contentType || "").includes("application/json");
}

async function _loadCanvasInner(name) {
  // Through the ONE api client (系统合同 §7.1 规定 10). `retries: 0` keeps the
  // pre-migration behaviour exactly: a canvas load never silently repeated.
  const res = await attempt(`/api/canvas/${encodeURIComponent(name)}`, { retries: 0 });
  if (res.ok) {
    const doc = res.data;
    // the server marks a document it served from the legacy scratch
    const legacy = !!(doc && doc._legacy);
    return _dispatch(name, doc, { legacy });
  }
  if (_backendSpoke(res.error)) {
    // The backend answered but refused: the stored file exists yet cannot be
    // served as a document (corrupt JSON → 409, read failure → 5xx). Do NOT
    // fall through to localStorage — the server copy is authoritative.
    const category = (res.error.body && res.error.body.error && res.error.body.error.category) || "";
    if (res.error.category === API_ERROR.MALFORMED) {
      return _fail(name, "corrupt", "unreadable response body");
    }
    return _fail(
      name,
      category === "corrupt_save" ? "corrupt" : "unavailable",
      category || `http ${res.status}`,
    );
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

// True once the page has started going away. A save arriving in that window
// cannot afford the debounce — the timer would simply never fire — so it is
// written out at once with `keepalive`, which is exactly what that flag is for:
// the request outlives the document.
let _unloading = false;

// The Fetch standard caps the TOTAL body of in-flight `keepalive` requests at
// 64 KiB and rejects anything over it. A canvas document grows well past that
// (asset + generation registries), so asking for keepalive on a big save would
// not merely be slower — the request would never be sent at all.
const KEEPALIVE_MAX_BYTES = 60 * 1024; // headroom under the 64 KiB ceiling

/** Transmitted size in BYTES. `String.length` counts UTF-16 code units, so it
 *  under-reports every non-ASCII character — a Chinese document measures ~1/3
 *  of its real UTF-8 size and would sail past the ceiling check only to have the
 *  request rejected. The creative content here is mostly Chinese, so this is the
 *  common case, not an edge one. */
function _byteLength(s) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(s).length;
  // last-resort estimate when TextEncoder is unavailable: assume the worst
  // (3 bytes per non-ASCII char) rather than under-reporting
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) < 128 ? 1 : 3;
  return n;
}

/** The actual write. `keepalive` asks for it to outlive page teardown. */
async function _write(name, data, { keepalive = false } = {}) {
  // Re-attach loaded fields this build does not own so a round-trip through
  // an older build never drops a future checkpoint's data.
  const body = JSON.stringify({ ...(_extras.get(name) || {}), ...data });
  // Over the keepalive ceiling the request would be REJECTED outright, so ask
  // for an ordinary one instead of one guaranteed not to be sent. The ceiling
  // counts every keepalive request in flight together, so what is left of it —
  // not this body alone — decides.
  const size = _byteLength(body);
  const fits = size + _keepaliveBytes <= KEEPALIVE_MAX_BYTES;
  const reserving = keepalive && fits;
  if (reserving) _keepaliveBytes += size;
  // EVERY write is cancellable, teardown ones included. A second teardown write
  // (pagehide then hidden, or two tab switches) also jumps the queue, so if the
  // first were not cancellable the two would race and the older full document
  // could land last. `keepalive` and `signal` compose fine: the request outlives
  // the page unless something newer explicitly replaces it.
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const entry = { ctl, data, keepalive: reserving };
  _inflight.set(name, entry);
  try {
    // Through the ONE api client (系统合同 §7.1 规定 10). `timeoutMs: 0` keeps the
    // pre-migration semantics: this write had NO deadline, and giving it the
    // client's 20s default would abort a large canvas save mid-flight — which is
    // the one thing this module exists to prevent. `body` is already a JSON
    // string, so the client passes it through untouched (`isRawBody`), and a
    // write is never retried by the transport.
    const res = await attempt(`/api/canvas/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: 0,
      ...(ctl ? { signal: ctl.signal } : {}),
      ...(reserving ? { keepalive: true } : {}),
    });
    if (res.ok) {
      // CONFIRMED — and only now is it safe to forget anything. The queued
      // payload is dropped only if it is still this exact one (a newer edit may
      // have replaced it while this request was in flight), and the recovery
      // copy only if it belongs to this body.
      if (_pendingSaves.get(name) === data) _pendingSaves.delete(name);
      return true;
    }
    // Cancelled on purpose by a newer (teardown) write: that write carries this
    // body's content and more, so persisting THIS one to localStorage would put
    // stale content there — the exact overwrite the abort was meant to prevent.
    if (res.error && res.error.category === API_ERROR.ABORTED) return;
    /* otherwise fall through to localStorage */
  } finally {
    if (reserving) _keepaliveBytes -= size;
    if (_inflight.get(name) === entry) _inflight.delete(name);
  }
  // The awaited PUT gives a blocking load a window to land — check again
  // before touching the local copy.
  if (_blocked.has(name) || _loading.get(name)) return;
  try {
    localStorage.setItem("motv:" + name, body);
  } catch {
    /* nothing we can do — keep the in-memory graph */
  }
}

/** Serialize a write behind any write already in flight for this project.
 *
 *  When nothing is in flight the request is issued SYNCHRONOUSLY — during a
 *  teardown there may be no future microtask to run, so deferring even by a tick
 *  could mean never dispatching at all. Only an actual overlap waits, which is
 *  precisely the case that could otherwise land out of order.
 *
 *  A TEARDOWN write does not wait even then. Queueing it behind a request in
 *  flight means it is dispatched only once that request settles, and a page that
 *  terminates first never dispatches it at all — the creator's last edit dies
 *  with the document, which is the one thing this path exists to prevent. So it
 *  jumps the queue, and the write it overtakes is ABORTED — including an earlier
 *  teardown write, since pagehide/hidden can fire in succession and two
 *  queue-jumping writes would otherwise race: every PUT is
 *  a full document snapshot, so the newer body already carries everything the
 *  older one did, while an older request landing LAST would overwrite it.
 *
 *  Overtaking the request in flight is not enough on its own: writes may also be
 *  WAITING on the chain, and one of those running after the teardown snapshot
 *  would overwrite it just as surely. The teardown write therefore bumps the
 *  write generation, and every queued write re-checks its own stamp before it
 *  goes out — so the ones it superseded drop themselves. */
function _queueWrite(name, data, opts) {
  const jump = !!(opts && opts.keepalive);
  if (jump) {
    _abortInflight(name);
    _bumpWriteGen(name);
  }
  const gen = _writeGen.get(name) || 0;
  const prev = jump ? null : _saveChain.get(name) || null;
  const run = () => {
    // Stale by the time its turn came: a teardown snapshot or a load has since
    // superseded the state this body describes.
    if ((_writeGen.get(name) || 0) !== gen) return;
    return _write(name, data, opts);
  };
  const p = prev ? prev.then(run, run) : run();
  const tracked = Promise.resolve(p).catch(() => {});
  _saveChain.set(name, tracked);
  // drop the link once idle, so the next save is immediate again
  tracked.then(() => {
    if (_saveChain.get(name) === tracked) _saveChain.delete(name);
  });
  return p;
}

/** Fire any queued save for `name` (or for every project) right now. Used when
 *  the page is going away: a pending debounce must not take the creator's last
 *  edit with it. Exported for tests. */
export function flushCanvas(name = null) {
  const names = name === null ? [..._pendingSaves.keys()] : [name];
  let n = 0;
  for (const key of names) {
    const data = _pendingSaves.get(key);
    if (data === undefined) continue;
    // This exact body is already on the wire in a form that outlives the page
    // (pagehide and visibilitychange:hidden both flush, one right after the
    // other). Re-sending it would cancel that request — for an identical body,
    // pure waste. An ORDINARY request in flight is NOT good enough: the browser
    // may kill it at teardown, which is why the keepalive re-send exists.
    const cur = _inflight.get(key);
    if (cur && cur.keepalive && cur.data === data) continue;
    // A save deferred because a LOAD is in flight must keep its trigger: the
    // load will settle and the timer is the only thing that will write it.
    // Cancelling it here and skipping would leave the edit memory-only. (No
    // direct test: loadCanvas already cancels queued timers by design — "a load
    // supersedes any queued autosave" — so this window is latent rather than
    // reachable through the public API. The reorder costs nothing and removes
    // the trap if that ever changes.)
    // (A BLOCKED project is different and deliberate: saving is refused to
    // protect a document that may still be recoverable, and no recovery copy is
    // stashed for it either — see _dispatch.)
    if (_blocked.has(key) || _loading.get(key)) continue;
    clearTimeout(_timers.get(key));
    _timers.delete(key);
    // the payload STAYS queued until _write confirms it: a teardown write can
    // still fail, and re-sending an identical PUT is harmless
    _queueWrite(key, data, { keepalive: true });
    n += 1;
  }
  return n;
}

/**
 * Tell the module whether the page is currently going away / backgrounded.
 *
 * While it is, saves bypass the debounce (a timer in a hidden or dying document
 * may never fire) and go out with `keepalive`. Crucially this is a FLAG, not a
 * one-way switch: `pagehide` can be followed by `pageshow` when the page comes
 * back from the back/forward cache, and `visibilitychange` alternates every time
 * the creator switches tabs. Leaving it stuck on would turn every later save of
 * a restored session into an immediate write and lose the debounce entirely.
 *
 * Setting it also FLUSHES, so it does not matter whether this or the field-level
 * flush (ui/fieldsync.js) runs first: whichever is second, the write it produces
 * finds the flag already set and leaves immediately.
 */
export function setUnloading(on) {
  _unloading = !!on;
  return _unloading ? flushCanvas() : 0;
}

/** Back-compat alias for the teardown entry point. */
export function notifyUnloading() {
  return setUnloading(true);
}

/** Debounced save of the canvas graph for `name`. No-op while a fail-safe
 *  load has saving blocked (the stored document must stay recoverable).
 *  While the page is unloading the debounce is skipped entirely. */
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
  if (_unloading) {
    // no timer will ever fire — write it now, keepalive. The payload stays
    // queued (and a recovery copy is stashed by _write) until confirmed.
    clearTimeout(_timers.get(name));
    _timers.delete(name);
    _pendingSaves.set(name, data);
    _queueWrite(name, data, { keepalive: true });
    return;
  }
  clearTimeout(_timers.get(name));
  _pendingSaves.set(name, data);
  _timers.set(name, setTimeout(() => {
    _timers.delete(name);
    // Re-check at fire time: a fail-safe load may have blocked this project
    // AFTER the save was queued — the queued write must not slip through.
    if (_blocked.has(name) || _loading.get(name)) {
      _pendingSaves.delete(name);
      return;
    }
    // The payload is NOT dropped before the write: if the page tears down while
    // this ordinary (non-keepalive) request is in flight, the teardown flush
    // must still find it and re-send it with keepalive + a recovery copy.
    // _write clears it once the server confirms.
    _queueWrite(name, data);
  }, 700));
}

// The page-lifecycle signals, in BOTH directions. Order against the field-level
// listeners (ui/fieldsync.js) is irrelevant by construction: the flag is set
// before anything is flushed, so a field write that lands afterwards is written
// immediately rather than queued.
//   pagehide / hidden   → going away or backgrounded: write everything now
//   pageshow / visible  → back again: resume normal debouncing
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => setUnloading(true));
  window.addEventListener("pageshow", () => setUnloading(false)); // BFCache restore
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      setUnloading(document.visibilityState === "hidden");
    });
  }
}
