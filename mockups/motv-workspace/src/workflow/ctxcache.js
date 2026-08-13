// Derived-conclusion cache (TASK-067 §15, ADR-0064 决策 3).
//
//   entry = { key, scope, baselineRevision, value, at, skillRunId, proposalId }
//
// WHAT IT CACHES: structured conclusions that cost a model run to produce — an
// asset recommendation, a continuity summary, a reference interpretation reading.
// Re-deriving those on every render is the 「每次 Skill 都重新算一遍」 §15 forbids.
//
// WHAT IT MUST NEVER CACHE: canon. A cached copy of a document is a stale second
// copy of the truth, and this codebase has paid for that before. Every entry here
// is a CONCLUSION ABOUT canon, keyed by the revision of the canon it was drawn
// from — so it can be checked, never trusted blindly.
//
// STALE IS VISIBLE, NOT AUTOMATIC (决策 3):
//
//   revision matches  → fresh, reuse it
//   revision differs  → STALE. `get` still returns it, marked `stale: true`, with
//                       the revision it was drawn from. The UI says so. Nothing
//                       re-runs by itself — a re-run spends tokens, and that is
//                       the creator's decision, not the cache's.
//
// A stale entry is deliberately NOT deleted: 「上一次的结论 + 它已经过期了」 is more
// useful than an empty panel, and it is the only way the creator can see WHAT
// changed since. Eviction is by count, oldest first, so the document cannot grow
// without bound.
//
// Pure state + transitions — no fetch, no DOM, no clock (callers pass `at`).

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x.trim() ? x : null);

/** The conclusion kinds this round caches. A closed list: an open one would let a
 *  caller invent a scope whose staleness nothing knows how to judge. */
export const SCOPES = ["assetRecommendation", "continuitySummary", "promptReview"];
const SCOPE_SET = new Set(SCOPES);

/** How many entries one document keeps, oldest evicted first. Sized for 「一集的
 *  镜头数 × 三种结论」 with room to spare, not for unbounded history — the durable
 *  record of a run is the Skill Run registry, not this. */
export const MAX_ENTRIES = 240;

/** `scope:shotId[:variant]` — one entry per conclusion per shot. A second run of the
 *  same scope on the same shot REPLACES the first: this is a cache, and the run history
 *  lives in the Skill Run registry where it is not evictable.
 *
 *  `variant` separates conclusions that share a scope but are NOT about the same thing.
 *  `promptReview` is drawn on both the Image Prompt and the Video Prompt; without the
 *  variant they collide on one key, so reviewing the video side would silently overwrite
 *  the image side's conclusion — and worse, the image panel would then display the video
 *  review AS ITS OWN (codex review round 4). Optional, because the scopes that are
 *  genuinely one-per-shot should not carry a meaningless suffix. */
export function cacheKey(scope, shotId, variant = null) {
  if (!SCOPE_SET.has(scope) || !strOrNull(shotId)) return null;
  const v = strOrNull(variant);
  return v ? `${scope}:${shotId}:${v}` : `${scope}:${shotId}`;
}

function sanitizeEntry(e) {
  if (!isObj(e)) return null;
  const key = strOrNull(e.key);
  const scope = SCOPE_SET.has(e.scope) ? e.scope : null;
  const baselineRevision = strOrNull(e.baselineRevision);
  // An entry with no baseline cannot be checked for staleness, so it would be
  // reused forever against changed canon. Dropped rather than trusted.
  if (!key || !scope || !baselineRevision) return null;
  if (e.value === undefined) return null;
  return {
    key,
    scope,
    shotId: strOrNull(e.shotId),
    baselineRevision,
    value: e.value,
    at: strOrNull(e.at),
    skillRunId: strOrNull(e.skillRunId),
    proposalId: strOrNull(e.proposalId),
  };
}

/** Hydrate from a persisted `ctxCache` field (or start empty). */
export function createCache(saved) {
  const entries = (Array.isArray(saved) ? saved : []).map(sanitizeEntry).filter(Boolean);
  // last write wins per key, preserving order of first appearance
  const byKey = new Map();
  for (const e of entries) byKey.set(e.key, e);
  return [...byKey.values()];
}

/**
 * Record a conclusion.
 *
 * `baselineRevision` MUST be `shotctx.contextRevision(trace, scope)` for the very
 * context the conclusion was drawn from. Passing a revision that was not the one
 * read is the one way this module can lie, so it is never derived here — the caller
 * that built the context is the only one that knows.
 */
export function put(cache, { scope, shotId, variant = null, baselineRevision, value, at = null, skillRunId = null, proposalId = null } = {}) {
  if (!Array.isArray(cache)) return null;
  const key = cacheKey(scope, shotId, variant);
  if (!key || !strOrNull(baselineRevision) || value === undefined) return null;
  const entry = {
    key, scope, shotId,
    baselineRevision,
    value,
    at: strOrNull(at),
    skillRunId: strOrNull(skillRunId),
    proposalId: strOrNull(proposalId),
  };
  const i = cache.findIndex((e) => e.key === key);
  if (i >= 0) cache[i] = entry;
  else cache.push(entry);
  // evict OLDEST FIRST, and only ever down to the cap
  while (cache.length > MAX_ENTRIES) cache.shift();
  return entry;
}

/**
 * Read a conclusion, and say honestly whether it still applies.
 *
 * Returns null when nothing was ever recorded — an absence, not a miss to be
 * papered over. Otherwise `{ value, stale, baselineRevision, currentRevision, … }`:
 * a STALE entry is returned, marked, and never silently presented as current.
 */
export function get(cache, { scope, shotId, variant = null, currentRevision } = {}) {
  if (!Array.isArray(cache)) return null;
  const key = cacheKey(scope, shotId, variant);
  if (!key) return null;
  const e = cache.find((x) => x.key === key);
  if (!e) return null;
  // With no current revision to compare against we CANNOT claim freshness. Saying
  // `stale: true` here is the conservative answer: the creator is told the
  // conclusion may not apply, rather than being shown it as current.
  const cur = strOrNull(currentRevision);
  return {
    scope: e.scope,
    shotId: e.shotId,
    value: e.value,
    at: e.at,
    skillRunId: e.skillRunId,
    proposalId: e.proposalId,
    baselineRevision: e.baselineRevision,
    currentRevision: cur,
    stale: cur == null ? true : cur !== e.baselineRevision,
  };
}

/** Forget one conclusion. Used when the thing it was about stops existing (a shot
 *  that left the draft), never as a way to hide staleness. */
export function forget(cache, { scope, shotId, variant = null } = {}) {
  if (!Array.isArray(cache)) return false;
  const key = cacheKey(scope, shotId, variant);
  if (!key) return false;
  const i = cache.findIndex((e) => e.key === key);
  if (i < 0) return false;
  cache.splice(i, 1);
  return true;
}

/** Forget every conclusion about one shot — the shot is gone, so all of them are
 *  about nothing. */
export function forgetShot(cache, shotId) {
  if (!Array.isArray(cache) || !strOrNull(shotId)) return 0;
  let n = 0;
  for (let i = cache.length - 1; i >= 0; i--) {
    if (cache[i].shotId === shotId) { cache.splice(i, 1); n += 1; }
  }
  return n;
}

export function serialize(cache) {
  return (Array.isArray(cache) ? cache : []).map((e) => ({
    key: e.key, scope: e.scope, shotId: e.shotId,
    baselineRevision: e.baselineRevision, value: e.value,
    at: e.at, skillRunId: e.skillRunId, proposalId: e.proposalId,
  }));
}
