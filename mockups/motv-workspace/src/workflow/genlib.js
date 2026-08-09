// Project Generation Registry (checkpoint M5) — the ONE durable source of
// generation provenance. Every AI image / video / audio generation is recorded
// here so a result stays traceable to the Shot it targeted, the Generation that
// produced it, the inputs/prompt/model/parameters actually used, and the
// result Asset it registered.
//
// DECOUPLED FROM MEDIA BYTES: a Generation record is provenance, not storage.
// It survives even after its result Asset's local bytes are archived, missing,
// or permanently deleted (the Asset's own `storageState` tracks that, in the
// Project Asset Registry). Releasing disk space must never break this chain.
//
// OWNERSHIP: Generation belongs to the PROJECT production domain, persisted as
// the canvas document's top-level `generations` array (parallel to `assets`).
// Workflow nodes EXECUTE generations but never own this data; the Asset
// registry never owns generation history. generationId is minted ONCE and never
// derived from assetId / slot / hash.
//
// Generation {
//   generationId,                 // stable: gen-<uuid> (runtime) | gen-mig-N (migration)
//   type: 'image'|'video'|'audio',
//   targetType: 'shot'|null,      // what the generation targets
//   targetId,                     // canonical creativeShotId (NEVER slot) | null
//   inputAssetIds:     [assetId], // proven inputs, FROZEN at launch
//   referenceAssetIds: [assetId], // proven references, FROZEN at launch
//   userInstruction,              // raw user ask | null
//   promptSnapshot,               // EXACT effective prompt at launch | null
//   provider, model,              // actually used | null
//   parameters,                   // object actually used | null
//   status: 'queued'|'generating'|'success'|'failed'|'cancelled',
//   resultAssetIds: [assetId],    // produced Assets (M3) | []
//   createdAt,                    // ISO string at launch | null (legacy backfill)
// }
//
// `idle` is NOT a Generation status: it is a UI-transient node state (nothing is
// generating) and no durable record exists for it. A Generation record is born
// only when a generation is actually launched.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const TYPES = new Set(["image", "video", "audio"]);
const STATUSES = new Set(["queued", "generating", "success", "failed", "cancelled"]);

export const GENERATION_TYPES = TYPES;
export const GENERATION_STATUSES = STATUSES;

const strOrNull = (x) => (typeof x === "string" && x ? x : null);
const idArray = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s) : []);

// Keys that must NOT be persisted into durable provenance — a provider params
// object could carry a credential/token, and the Generation Registry is written
// to the canvas save. Matched case-insensitively as a whole word / sub-token.
// Sensitive token bounded by the START/END or ANY non-alphanumeric separator
// (`_ - . space /` …), so `api_key`, `openai.api_key`, `x api key` all match;
// camelCase is split into `_` before testing (see isSensitiveKey).
const SENSITIVE_KEY = /(?:^|[^a-z0-9])(?:api[_-]?key|apikey|key|token|secret|password|passwd|credential|credentials|authorization|auth|bearer|signature|cookie|session)(?:$|[^a-z0-9])/i;

// True if a key names a secret — matched after splitting camelCase into
// separators, so `apiKey`, `accessToken`, `clientSecret` are caught alongside
// `api_key` / `access-token`.
function isSensitiveKey(k) {
  const normalized = String(k).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY.test(normalized);
}

// Redact a credential embedded in a string VALUE. Scoped to the one unambiguous
// shape — a URL's userinfo (`scheme://user:pass@host`). Exhaustive value-level
// secret scanning is deliberately out of scope: generation `parameters` come
// only from the server target ({task_id, shot_id, packet_version}) plus client
// ids, so no credential-bearing value reaches here; scanning every string would
// risk corrupting legitimate provenance for a threat that does not exist.
function scrubValue(v) {
  return typeof v === "string"
    ? v.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
    : v;
}

// Recursively drop sensitive keys (and scrub credential-in-URL string values) so
// a stored parameter snapshot never leaks a secret through project data.
// Cycle-safe (a self-referential params object must not overflow the stack and
// abort the generation launch).
function redactSecrets(x, seen = new WeakMap()) {
  if (Array.isArray(x)) {
    if (seen.has(x)) return seen.get(x);
    const out = [];
    seen.set(x, out);
    for (const v of x) out.push(redactSecrets(v, seen));
    return out;
  }
  if (!isObj(x)) return scrubValue(x);
  if (seen.has(x)) return seen.get(x);
  const out = {};
  seen.set(x, out);
  for (const k of Object.keys(x)) {
    if (isSensitiveKey(k)) continue;
    out[k] = redactSecrets(x[k], seen);
  }
  return out;
}

// Deep-copy a parameters object so the FROZEN launch snapshot cannot be mutated
// by a later edit to the caller's object (the recorded provenance must stay the
// parameters actually submitted), and REDACT any secret-shaped keys before the
// snapshot is persisted. A non-cloneable value degrades to null rather than
// sharing a live reference.
function freezeParams(x) {
  if (!isObj(x)) return null;
  let clone;
  try {
    clone = structuredClone(x);
  } catch {
    try {
      clone = JSON.parse(JSON.stringify(x));
    } catch {
      return null;
    }
  }
  const redacted = redactSecrets(clone);
  // Guarantee the snapshot is JSON-PERSISTABLE — canvas saves serialize to JSON,
  // and a cyclic graph survives structuredClone but would throw on persist. A
  // non-serializable (e.g. cyclic) params object degrades to null rather than
  // breaking the generation launch / save.
  try {
    return JSON.parse(JSON.stringify(redacted));
  } catch {
    return null;
  }
}

/** Hydrate the registry from a persisted `generations` field (or start empty).
 *  Non-object entries in a hand-corrupted save are dropped (they carry no
 *  provenance); every real record is preserved verbatim. */
export function createGenerationRegistry(saved) {
  return Array.isArray(saved) ? saved.filter(isObj) : [];
}

/** Start a Generation at LAUNCH, freezing its inputs/prompt/model/parameters.
 *  The caller passes `createdAt` (an ISO string) — this module never reads the
 *  clock, so migrations and tests stay deterministic. A typeless generation is
 *  rejected (null): a record with no media type carries no usable provenance. */
export function startGeneration(reg, entry) {
  if (!Array.isArray(reg) || !isObj(entry)) return null;
  if (!TYPES.has(entry.type)) return null;
  const targetId = strOrNull(entry.targetId); // canonical creativeShotId, never a slot
  const parameters = freezeParams(entry.parameters); // deep-copied + redacted, frozen at launch
  const rec = {
    generationId: strOrNull(entry.generationId) || mintId("gen"),
    type: entry.type,
    // targetType is DERIVED from targetId so the pair can never disagree — a
    // caller passing only one field can't mint a save that fails v5 reload
    targetType: targetId ? "shot" : null,
    targetId,
    inputAssetIds: idArray(entry.inputAssetIds),
    referenceAssetIds: idArray(entry.referenceAssetIds),
    userInstruction: strOrNull(entry.userInstruction),
    promptSnapshot: strOrNull(entry.promptSnapshot),
    provider: strOrNull(entry.provider),
    model: strOrNull(entry.model),
    parameters,

    status: STATUSES.has(entry.status) ? entry.status : "generating",
    resultAssetIds: idArray(entry.resultAssetIds),
    createdAt: strOrNull(entry.createdAt),
  };
  reg.push(rec);
  return rec;
}

export function findGeneration(reg, generationId) {
  if (!Array.isArray(reg) || typeof generationId !== "string" || !generationId) return null;
  return reg.find((g) => isObj(g) && g.generationId === generationId) || null;
}

/** Mark a Generation successful, attaching its result Assets. Race-safe:
 *  - a DUPLICATE completion UNIONs result ids (never appends a duplicate), so a
 *    doubled async callback cannot create inconsistent history;
 *  - a completion arriving AFTER a terminal failed/cancelled does NOT resurrect
 *    the record — a stale late result must not rewrite provenance.
 *  It NEVER touches the frozen inputs/prompt/target: a generation that finishes
 *  after the active Shot or image changed keeps the lineage it launched with. */
export function completeGeneration(reg, generationId, resultAssetIds) {
  const g = findGeneration(reg, generationId);
  if (!g) return null;
  if (g.status === "failed" || g.status === "cancelled") return g; // stale — never resurrect
  if (!Array.isArray(g.resultAssetIds)) g.resultAssetIds = [];
  const have = new Set(g.resultAssetIds);
  for (const id of idArray(resultAssetIds)) {
    if (!have.has(id)) { g.resultAssetIds.push(id); have.add(id); }
  }
  g.status = "success";
  return g;
}

/** Reconcile a Generation by the paid TASK id it recorded in its parameters,
 *  rather than by an in-memory generationId. This is what lets a paid-video
 *  result completed AFTER a reload (whose launch closure is gone) still be
 *  attached to the exact record it launched — never left permanently
 *  `generating`. Matches the first non-terminal record carrying that task_id. */
export function completeGenerationByTask(reg, taskId, resultAssetIds) {
  if (!Array.isArray(reg) || typeof taskId !== "string" || !taskId) return null;
  const active = reg.filter(
    (x) => isObj(x) && isObj(x.parameters) && x.parameters.task_id === taskId
      && x.status !== "success" && x.status !== "failed" && x.status !== "cancelled",
  );
  // Reconcile ONLY when EXACTLY ONE active record owns this task. task_id is
  // deterministic per SHOT (not per launch), so two concurrent attempts are
  // indistinguishable by task alone — guessing would MISATTRIBUTE the result to
  // the wrong launch's frozen prompt/inputs. We choose integrity over
  // completeness: ambiguous (>1 active) or absent (0) → no-op; the records stay
  // honestly `generating` rather than mislinked. (The common sequential retry
  // has exactly one active at completion time, so it reconciles fully.) A repeat
  // reconcile after success finds zero active and correctly no-ops.
  //
  // ACCEPTED LIMITATION (M5): fully-complete reconciliation of CONCURRENT
  // same-shot attempts is impossible client-side because the server mints
  // task_id per shot (bootstrap.initial_task_id), not per launch. Robustly
  // linking every concurrent result requires a per-LAUNCH correlation id
  // threaded through the paid pipeline — a Core/server contract change, out of
  // M5's client-side scope. The result Asset is still adopted into its slot; only
  // the (rare) concurrent Generation→result link is left unresolved, never wrong.
  if (active.length !== 1) return null;
  return completeGeneration(reg, active[0].generationId, resultAssetIds);
}

/** Mark a Generation failed/cancelled. Never overrides an already-successful
 *  record: a late failure signal must not erase a real success. */
export function failGeneration(reg, generationId, status) {
  const g = findGeneration(reg, generationId);
  if (!g) return null;
  if (g.status === "success") return g; // a real success is not undone
  g.status = status === "cancelled" ? "cancelled" : "failed";
  return g;
}
