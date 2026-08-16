// FRONT-END media presence probe (TASK-077 §1.2).
//
// WHY IT EXISTS. `storageState` on an Asset record is a DECLARATION — every write
// path sets `r.storageState || "local"` and nothing ever checks it against the
// disk. On the real project `照见未明rev2` that declaration says nine local assets
// while `media/` holds seven files, so 资产库 rendered two browser broken-image
// glyphs while 存储与诊断 reported 「媒体不可用 0」. Both surfaces were repeating a
// claim nobody had verified.
//
// WHAT THIS IS NOT. It is DISPLAY-ONLY and deliberately so: it never writes
// `storageState`, never touches the registry, and never persists anything.
// Reconciling the declared state with the disk is a persistence change (a write
// path, a migration story, a decision about who owns the truth) and is recorded
// as a follow-up rather than smuggled in behind a `<img onerror>`.
//
// TWO SOURCES, ONE MAP. A `HEAD` request answers for any asset the page does not
// paint; an `<img>` that fails to load answers for the ones it does. They agree
// by construction because both write into the same table, keyed by URL.

export const PRESENT = "present";
export const MISSING = "missing";
/** We ASKED and still do not know — the server refused the question (405/501),
 *  failed (5xx), or the request itself blew up. Recorded so the scan does not ask
 *  again on every render, and treated as NOT missing everywhere: a probe that
 *  cannot tell must not be the thing that tells the creator their file is gone. */
export const INCONCLUSIVE = "inconclusive";

/** Status codes that are a real ANSWER about the resource, not about the request.
 *  Everything else is the server declining to answer. */
const DEFINITELY_ABSENT = new Set([404, 410]);

/** TWO hosts that cannot exist (`.invalid` is reserved, RFC 2606). Two, not one —
 *  see `isProbeable`: a single sentinel can be named by the input. */
const PROBE_BASE_A = "http://media-probe-a.invalid";
const PROBE_BASE_B = "http://media-probe-b.invalid";

/**
 * URLs this probe can ask a server about: SAME-ORIGIN PROJECT PATHS ONLY.
 *
 * `data:` / `blob:` carry their own bytes — there is nothing to be missing, and a
 * `HEAD` against them either throws or is meaningless. The demo seed's inline SVG
 * placeholders are exactly this case, which is also why the audit's defect is
 * invisible under demo data.
 *
 * THE TEST IS BASE-INDEPENDENCE, NOT A LIST OF SPELLINGS (codex review rounds 1–3,
 * all three blocking). The theme took three rounds because each fix was one notch
 * too specific, and the notches are worth recording:
 *
 *   R1  `//host/path` accepted           → refused `startsWith("//")`
 *   R2  `/\host/path` accepted           → browsers normalise `\` to `/`; FIVE
 *                                          spellings escape a prefix check
 *                                          (`//h` `/\h` `/\/h` `\\h` `\/h`)
 *                                        → asked the URL parser for the origin
 *   R3  `//media-probe.invalid/x` accepted → it resolves ONTO the sentinel, so the
 *                                          single-base check passed — while `fetch`
 *                                          would resolve it against the PAGE origin
 *                                          and go out to the network
 *
 * R3 is the one that shows the real defect: validating against one base and then
 * handing the RAW STRING to `fetch` (which resolves against another) leaves a gap,
 * and every round was a different way to live in that gap. What actually
 * characterises a safe value is that it does not depend on the base at all — a
 * genuine project path lands on whatever origin it is resolved against, while any
 * value that names a host lands on THAT host no matter the base.
 *
 * So it is resolved against two different impossible hosts and must come out on
 * each. `/api/uploads/x.png` does; `//anything/x` cannot — including the sentinels
 * themselves, which is what closes R3 without another special case.
 */
export function isProbeable(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  // An explicit scheme is never a project path: `data:`/`blob:` carry their own
  // bytes, `http(s)://…` names a host outright.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  try {
    const a = new URL(url, PROBE_BASE_A);
    const b = new URL(url, PROBE_BASE_B);
    // base-independent ⇒ it named no host of its own ⇒ it is a project path
    return a.origin === PROBE_BASE_A && b.origin === PROBE_BASE_B && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/** Every media URL the registry declares, deduped. Pure, so a test can state
 *  what would be probed without a network. */
export function registryUrls(reg) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (!isProbeable(u) || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  if (!reg || typeof reg !== "object") return out;
  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!m || typeof m !== "object") continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!e || !Array.isArray(e.history)) continue;
      for (const r of e.history) if (r) add(r.url);
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) if (f) add(f.url);
  const ff = reg.firstFrames;
  if (ff && typeof ff === "object") for (const k of Object.keys(ff)) if (ff[k]) add(ff[k].url);
  return out;
}

/**
 * Create the probe.
 *
 * `fetchImpl`  injected so a test can state the server's answers; defaults to the
 *              page's `fetch`. Absent entirely → the probe simply knows nothing,
 *              which renders as 「未探测」 rather than as 「都在」.
 * `limit`      concurrent requests. Small on purpose: this is a background truth
 *              check, not something a creator is waiting on.
 */
export function createMediaProbe({ fetchImpl, limit = 6 } = {}) {
  /** url → PRESENT | MISSING | INCONCLUSIVE. Absent means NOT YET ASKED, which is
   *  a fourth state and is never collapsed into 「present」. */
  const state = new Map();
  const inflight = new Set();
  const f = fetchImpl
    || (typeof fetch === "function" ? (url, init) => fetch(url, init) : null);
  // A non-positive batch size makes the scan loop below never advance — `slice(i,
  // i+0)` is empty forever (codex review round 1). Clamped rather than trusted.
  const batch = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 6;

  const stateOf = (url) => state.get(url) || null;

  /** Record a state. Returns true when it CHANGED something, so a caller can
   *  re-render exactly once instead of on every image error.
   *
   *  A NON-ANSWER NEVER ERASES AN ANSWER (codex review round 3, blocking). The
   *  `HEAD` and the `<img>` race by construction — the scan is in flight while the
   *  page paints — and the losing order was real: `<img>` fails → `MISSING`; the
   *  slow `HEAD` comes back 405 → `INCONCLUSIVE` overwrote it, and the honest
   *  placeholder plus the storage count vanished *after* the browser had proved
   *  the bytes were unfetchable. `INCONCLUSIVE` means 「问不出来」, which is only
   *  news when nothing better is known. */
  function record(url, next) {
    if (!isProbeable(url)) return false;
    const cur = state.get(url);
    if (cur === next) return false;
    if (next === INCONCLUSIVE && (cur === MISSING || cur === PRESENT)) return false;
    state.set(url, next);
    return true;
  }

  /** Record a BROWSER-OBSERVED load result (an `<img>`/`<video>` that did or did
   *  not render). This one may say MISSING on failure: the browser actually tried
   *  to fetch the bytes and could not get them, which is evidence about the
   *  resource — unlike a `HEAD` the server declined to answer. */
  function observe(url, present) {
    return record(url, present ? PRESENT : MISSING);
  }

  /**
   * Ask the server about ONE url.
   *
   * ONLY A DEFINITIVE ANSWER MAY SAY MISSING (codex review round 1, blocking).
   * The first version recorded every non-2xx AND every thrown error as MISSING,
   * permanently — so a server that serves `GET` but rejects `HEAD` (405/501), a
   * 5xx blip, or one dropped request would have labelled a file that is right
   * there 「媒体文件已不在磁盘上」 until reload. That is the same species of untrue
   * state this whole card exists to remove, produced by the check meant to remove it.
   *
   *   2xx            → PRESENT
   *   404 / 410      → MISSING      the server answered ABOUT THE RESOURCE
   *   anything else  → INCONCLUSIVE the server answered about the REQUEST, or
   *                                 nothing answered at all
   *
   * INCONCLUSIVE is recorded (not left absent) so a render loop does not re-ask
   * every frame, and it is `false` everywhere `isMissing` is consulted. A file
   * whose bytes genuinely cannot be fetched is still caught — by the `<img>` that
   * fails to load, which is a real attempt at the real bytes.
   */
  async function head(url) {
    try {
      const res = await f(url, { method: "HEAD", cache: "no-store" });
      if (res && res.ok) return record(url, PRESENT);
      const status = res && typeof res.status === "number" ? res.status : 0;
      return record(url, DEFINITELY_ABSENT.has(status) ? MISSING : INCONCLUSIVE);
    } catch {
      return record(url, INCONCLUSIVE);
    }
  }

  /**
   * Probe every URL not already known or in flight. Resolves to `true` when the
   * table changed, so the caller re-renders once at the end.
   *
   * Re-callable from a render loop: with nothing new to ask it does no work and
   * resolves `false`, which is what keeps 「render → scan → render」 from spinning.
   */
  async function scan(urls) {
    if (!f) return false;
    const todo = (Array.isArray(urls) ? urls : [])
      .filter((u) => isProbeable(u) && !state.has(u) && !inflight.has(u));
    if (!todo.length) return false;
    todo.forEach((u) => inflight.add(u));
    let changed = false;
    try {
      for (let i = 0; i < todo.length; i += batch) {
        const slice = todo.slice(i, i + batch);
        const results = await Promise.all(slice.map(head));
        if (results.some(Boolean)) changed = true;
      }
    } finally {
      todo.forEach((u) => inflight.delete(u));
    }
    return changed;
  }

  return {
    stateOf,
    isMissing: (url) => stateOf(url) === MISSING,
    isKnown: (url) => state.has(url),
    observe,
    scan,
    /** For the honest 「已探测 n 条」 line — never used to imply completeness. */
    checked: () => state.size,
    missingUrls: () => [...state.entries()].filter(([, v]) => v === MISSING).map(([u]) => u),
  };
}
