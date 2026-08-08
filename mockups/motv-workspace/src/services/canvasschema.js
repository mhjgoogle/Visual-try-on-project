// Canvas persistence schema — the ONE authoritative schema version for the
// canvas document (data/<name>.json / localStorage), plus the sequential
// migration dispatcher every load routes through.
//
// Design (M1, persistence-only):
// - `v` identifies the document schema. Loading dispatches on it explicitly;
//   a version is never assumed to be the current shape.
// - Migrations are a sparse chain: MIGRATIONS[n] rewrites a version-n document
//   into version n+1. The dispatcher applies them sequentially
//   (v1 → migrate 1→2 → v2 → migrate 2→3 → …) and stamps `v` itself, so a
//   migration only transforms shape and stays deterministic/side-effect free.
// - Non-destructive: the input document is deep-copied before migrating, and a
//   migration receives (and returns) the WHOLE document — unknown fields pass
//   through untouched unless a documented migration deliberately removes them.
// - Fail safe: a NEWER version than this build understands is rejected
//   ("unsupported"), never reinterpreted as the current schema; malformed
//   version markers are rejected ("invalid"). Callers must not let either
//   outcome overwrite the stored document.

/** Authoritative CURRENT canvas schema version. Saves must emit exactly this. */
export const CANVAS_SCHEMA_VERSION = 2;

/**
 * v1 → v2 (checkpoint M2): stable creator identity + minimal provenance.
 * Purely ADDITIVE — no existing field is renamed, removed, or altered:
 * - scriptDoc.versions[]           += id                     (sv-mig-<n>)
 * - node.versions[]                += id                     (sdv-mig-<n>)
 * - draft versions (raw/draft)     += sourceScriptVersionId / basedOnDraftId
 *   — legacy saves never recorded this relation, so it is honestly null,
 *   never guessed from sequence/index/slot
 * - draft raw shots                += shotId                 (shot-mig-<n>)
 *
 * Determinism: ids are counter-based in document traversal order, so loading
 * the same untouched v1 save always mints the same identities. Runtime-minted
 * ids (identity.js) use UUIDs — the `-mig-` namespace cannot collide with
 * them. Records that already carry a string id are left untouched.
 */
function migrateV1ToV2(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  // Collision safety: a v1 document may ALREADY carry ids (e.g. hand-restored
  // from a v2 backup). Those are kept verbatim, so freshly minted ids must
  // skip every id already present — duplicates would make identity ambiguous.
  const taken = new Set();
  if (isObj(doc.scriptDoc) && Array.isArray(doc.scriptDoc.versions)) {
    for (const ver of doc.scriptDoc.versions) {
      if (isObj(ver) && typeof ver.id === "string") taken.add(ver.id);
    }
  }
  if (Array.isArray(doc.nodes)) {
    for (const n of doc.nodes) {
      if (!isObj(n) || !Array.isArray(n.versions)) continue;
      for (const ver of n.versions) {
        if (!isObj(ver)) continue;
        if (typeof ver.id === "string") taken.add(ver.id);
        for (const s of Array.isArray(ver.raw) ? ver.raw : []) {
          if (isObj(s) && typeof s.shotId === "string") taken.add(s.shotId);
        }
      }
    }
  }
  const counters = { sv: 0, sdv: 0, shot: 0 };
  const mig = (p) => {
    let cand;
    do cand = `${p}-mig-${++counters[p]}`;
    while (taken.has(cand));
    taken.add(cand);
    return cand;
  };
  if (isObj(doc.scriptDoc) && Array.isArray(doc.scriptDoc.versions)) {
    for (const ver of doc.scriptDoc.versions) {
      if (isObj(ver) && typeof ver.id !== "string") ver.id = mig("sv");
    }
  }
  if (Array.isArray(doc.nodes)) {
    for (const n of doc.nodes) {
      if (!isObj(n) || !Array.isArray(n.versions)) continue;
      for (const ver of n.versions) {
        if (!isObj(ver)) continue;
        if (typeof ver.id !== "string") ver.id = mig("sdv");
        if (Array.isArray(ver.raw) || ver.draft === true) {
          if (!("sourceScriptVersionId" in ver)) ver.sourceScriptVersionId = null;
          if (!("basedOnDraftId" in ver)) ver.basedOnDraftId = null;
        }
        if (Array.isArray(ver.raw)) {
          for (const s of ver.raw) {
            if (isObj(s) && typeof s.shotId !== "string") s.shotId = mig("shot");
          }
        }
      }
    }
  }
  return doc;
}

/** Sequential migration steps: { [fromVersion]: (doc) => docAtFromVersion+1 }.
 *  Extended one real step at a time, never speculatively. */
export const MIGRATIONS = { 1: migrateV1ToV2 };

/** Read the schema version of a raw persisted document.
 *  Returns a positive integer, or null if the marker is malformed.
 *  Documents predating the `v` marker are all shape-v1 (`v: 1` has been
 *  written since the first canvas save), so a missing marker means 1. */
export function readSchemaVersion(raw) {
  if (raw.v === undefined) return 1;
  return Number.isInteger(raw.v) && raw.v >= 1 ? raw.v : null;
}

/** Structural invariants of a canvas document at the CURRENT schema. A
 *  syntactically-valid JSON object whose owned fields have the wrong shape
 *  (e.g. `nodes: "oops"`) must fail safe as invalid — dispatching it "ok"
 *  would hand the app a blank canvas whose next autosave overwrites the
 *  malformed-but-possibly-recoverable stored document. Every real save has
 *  written a `nodes` array since the first canvas version, so requiring one
 *  on a non-empty document rejects no genuine save. */
export function validateCanvasDoc(doc) {
  const isPlainObject = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  if (!Array.isArray(doc.nodes)) return "nodes is not an array";
  // Element shape too: restore iterates these and reads fields off each entry
  // — a null/garbage element would throw mid-restore, leaving a half-restored
  // canvas that a later autosave could write over the stored document.
  for (const n of doc.nodes) {
    if (!isPlainObject(n)) return "nodes contains a non-object entry";
    if (typeof n.type !== "string") return "node entry has no type";
    if (n.versions !== undefined && !Array.isArray(n.versions)) {
      return "node versions is not an array";
    }
    for (const k of ["uploads", "firstFrames"]) {
      if (n[k] !== undefined && n[k] !== null && !isPlainObject(n[k])) {
        return `node ${k} is not an object`;
      }
    }
    // real saves persist `finals` as a LIST on edit nodes and a map elsewhere
    // — both are valid; only primitives are malformed
    if (n.finals !== undefined && n.finals !== null && typeof n.finals !== "object") {
      return "node finals is not an object or array";
    }
  }
  if (doc.edges !== undefined) {
    if (!Array.isArray(doc.edges)) return "edges is not an array";
    for (const e of doc.edges) {
      if (!isPlainObject(e)) return "edges contains a non-object entry";
    }
  }
  if (doc.pan !== undefined && !isPlainObject(doc.pan)) return "pan is not an object";
  if (doc.scriptDoc !== undefined && doc.scriptDoc !== null && !isPlainObject(doc.scriptDoc)) {
    return "scriptDoc is not an object";
  }
  if (doc.project !== undefined && typeof doc.project !== "string") {
    return "project is not a string";
  }
  return null;
}

/**
 * Dispatch a raw persisted document to the current schema.
 *
 * Returns exactly one of:
 * - { status: "empty" }                          — no saved document
 * - { status: "ok", doc, fromVersion }           — doc is at the current
 *   version; when fromVersion === current the input object is returned as-is
 *   (no rewriting), otherwise doc is a migrated deep copy
 * - { status: "unsupported", version }           — persisted by a NEWER build;
 *   must not be interpreted, downgraded, or overwritten
 * - { status: "invalid", detail }                — not a canvas document
 *   (wrong type / malformed `v` / malformed owned fields / gap in the
 *   migration chain)
 *
 * `opts` (tests only) may inject { migrations, current } to exercise the
 * chain without shipping speculative migrations.
 */
export function migrateToCurrent(raw, opts = {}) {
  const current = opts.current ?? CANVAS_SCHEMA_VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;

  if (raw == null) return { status: "empty" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "invalid", detail: "document is not an object" };
  }
  if (Object.keys(raw).length === 0) return { status: "empty" };

  const from = readSchemaVersion(raw);
  if (from === null) {
    return { status: "invalid", detail: `malformed schema version: ${JSON.stringify(raw.v)}` };
  }
  if (from > current) return { status: "unsupported", version: from };
  if (from === current) {
    const bad = validateCanvasDoc(raw);
    if (bad) return { status: "invalid", detail: bad };
    return { status: "ok", doc: raw, fromVersion: from };
  }

  // Sequential upgrade on a deep copy — the caller's object is never mutated.
  let doc = structuredClone(raw);
  for (let v = from; v < current; v++) {
    const step = migrations[v];
    if (typeof step !== "function") {
      return { status: "invalid", detail: `no migration from v${v} to v${v + 1}` };
    }
    const next = step(doc);
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      return { status: "invalid", detail: `migration v${v}→v${v + 1} returned a non-document` };
    }
    doc = next;
    doc.v = v + 1; // the dispatcher owns the version stamp
  }
  const bad = validateCanvasDoc(doc);
  if (bad) return { status: "invalid", detail: `after migration: ${bad}` };
  return { status: "ok", doc, fromVersion: from };
}
