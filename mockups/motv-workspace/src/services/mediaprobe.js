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

/** URLs this probe can ask a server about.
 *
 *  `data:` / `blob:` carry their own bytes — there is nothing to be missing, and
 *  a `HEAD` against them either throws or is meaningless. The demo seed's inline
 *  SVG placeholders are exactly this case, which is also why the audit's defect
 *  is invisible under demo data. */
export function isProbeable(url) {
  return typeof url === "string" && (url.startsWith("/") || /^https?:\/\//.test(url));
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
  /** url → PRESENT | MISSING. Absent means NOT YET KNOWN, which is a third state
   *  and is never collapsed into 「present」. */
  const state = new Map();
  const inflight = new Set();
  const f = fetchImpl
    || (typeof fetch === "function" ? (url, init) => fetch(url, init) : null);

  const stateOf = (url) => state.get(url) || null;

  /** Record an answer. Returns true when it CHANGED something, so a caller can
   *  re-render exactly once instead of on every image error. */
  function observe(url, present) {
    if (!isProbeable(url)) return false;
    const next = present ? PRESENT : MISSING;
    if (state.get(url) === next) return false;
    state.set(url, next);
    return true;
  }

  async function head(url) {
    try {
      const res = await f(url, { method: "HEAD", cache: "no-store" });
      // A 4xx/5xx is an ANSWER (the file is not being served); a thrown error is
      // not — the network, not the file, may be what failed. Both land on
      // MISSING here because both mean 「这个 URL 现在拿不到」, and the label the
      // creator reads says exactly that rather than claiming the bytes are gone.
      return observe(url, !!res && res.ok);
    } catch {
      return observe(url, false);
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
      for (let i = 0; i < todo.length; i += limit) {
        const slice = todo.slice(i, i + limit);
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
