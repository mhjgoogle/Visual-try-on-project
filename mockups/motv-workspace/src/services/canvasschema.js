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
export const CANVAS_SCHEMA_VERSION = 4;

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

/**
 * v2 → v3 (checkpoint M3): Project Asset Registry extraction.
 * Durable creator media moves OFF workflow nodes into the top-level `assets`
 * registry; at restore, node state re-attaches as ALIAS views over it, so the
 * single write path (mediaref.addVersion) keeps working unchanged.
 *
 * - node(assets).uploads → assets.images   \  keyed by media DOMAIN first:
 * - node(video).uploads  → assets.videos    ) the same slot value legally
 * - node(audio).uploads  → assets.audio    /  exists under several kinds
 * - node(video).firstFrames → assets.firstFrames — when a frame ref matches
 *   an image Asset (same slot + version + url: the exact carried reference
 *   the 「🎬→ 用作视频首帧」 flow copies), it KEEPS that Asset's id instead of
 *   minting an unrelated duplicate; digest equality alone proves nothing.
 * - node(edit).finals (url strings) → assets.finals records — conservatively:
 *   origin is null because historical compose provenance was never persisted.
 * - every history record becomes an Asset with a stable `assetId`
 *   (asset-mig-<n>, traversal order, pre-scanned against existing ids);
 *   `shot_id` is stamped only where the legacy slot maps to exactly ONE M2
 *   shotId across every draft version — ambiguity stays null, never guessed.
 * - duplicate slots across SAME-type nodes: the later node's chain wins (the
 *   merged read model already behaved that way); the displaced chain is kept
 *   verbatim in assets.displaced rather than silently destroyed.
 *
 * Bytes, urls, slots, history order and current selections are untouched.
 */
function migrateV2ToV3(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  // Safe write for a slot literally named `__proto__`: assign it as an OWN key
  // rather than mutating the map's prototype. Inlined so the migration stays
  // self-contained/deterministic; mediaref.putKey does the same at runtime.
  const putKey = (obj, key, val) => {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = val;
    }
  };
  if (!Array.isArray(doc.nodes)) return doc;

  // -- pre-scan EVERY asset id anywhere in the document (collision safety) --
  // A minted id must never collide with an existing one, no matter where that
  // one lives — an active chain, a finals record, a first frame, OR a
  // preserved-verbatim `displaced` blob (which can carry an asset-mig-N from a
  // prior partial migration and may itself receive newly-displaced media). A
  // single deep walk over nodes + assets catches them all. ITERATIVE with a
  // visited set: no stack overflow on deep input (structuredClone already
  // rejected anything too deep to clone) and no spin on a cycle.
  const taken = new Set();
  const collectIds = (root) => {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const v = stack.pop();
      if (!isObj(v) && !Array.isArray(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const x of v) stack.push(x);
      } else {
        if (typeof v.assetId === "string" && v.assetId) taken.add(v.assetId);
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  };
  collectIds(doc.nodes);
  if (isObj(doc.assets)) collectIds(doc.assets);
  let counter = 0;
  const mig = () => {
    let cand;
    do cand = `asset-mig-${++counter}`;
    while (taken.has(cand));
    taken.add(cand);
    return cand;
  };

  // -- provable legacy slot → M2 shotId map (unique across all scriptgen
  //    drafts). ONLY scriptgen nodes own authoritative draft shots (matches
  //    ctx.shotIdForKey at runtime); trusting any node with a `versions` array
  //    would let crafted/unrelated data forge or nullify shot associations. --
  const slotShots = new Map(); // slot → shotId | false(=ambiguous)
  for (const n of doc.nodes) {
    if (!isObj(n) || n.type !== "scriptgen" || !Array.isArray(n.versions)) continue;
    for (const ver of n.versions) {
      for (const s of (isObj(ver) && Array.isArray(ver.raw) && ver.raw) || []) {
        if (!isObj(s) || typeof s.slot !== "string") continue;
        const seen = slotShots.get(s.slot);
        if (seen === false) continue; // already ambiguous
        // an occurrence of this slot WITHOUT a string shotId makes ownership
        // unprovable — one identified + one unidentified must resolve to null
        const shotId = typeof s.shotId === "string" && s.shotId ? s.shotId : null;
        if (shotId === null) slotShots.set(s.slot, false);
        else if (seen === undefined) slotShots.set(s.slot, shotId);
        else if (seen !== shotId) slotShots.set(s.slot, false);
      }
    }
  }
  // The provable shot a media key belongs to, resolved with the DOMAIN known
  // (never guessed from the key's text). An image/video key IS the slot; an
  // audio key is `voice-<slot>` (per shot) or `music-*`/`sfx-*` (not per shot).
  // Guessing the domain from a `voice-`/`music-`/`sfx-` prefix would mis-handle
  // a legitimate image/video slot that happened to start with those letters.
  const provenShot = (domain, key) => {
    if (typeof key !== "string") return null;
    let slot;
    if (domain === "audio") {
      if (key.startsWith("music-") || key.startsWith("sfx-")) return null;
      slot = key.startsWith("voice-") ? key.slice("voice-".length) : key;
    } else {
      slot = key; // images / videos / firstFrames are keyed by the slot itself
    }
    const id = slotShots.get(slot);
    return typeof id === "string" ? id : null;
  };

  // -- build the registry, moving node media in document order -------------
  // A pre-existing but NON-object `assets` (corrupt or a future extension's
  // value) is never silently clobbered: keep it verbatim in displaced and
  // start a fresh registry.
  let reg;
  if (isObj(doc.assets)) {
    reg = doc.assets;
  } else {
    reg = {};
    if (doc.assets !== undefined) reg.displaced = [{ key: "__preexisting_assets", entry: doc.assets }];
  }
  // A pre-existing registry field of the WRONG type (corrupt/hand-authored) is
  // never silently clobbered: preserve it in displaced before installing the
  // correct empty container.
  if (!Array.isArray(reg.displaced)) {
    if (reg.displaced !== undefined) reg.displaced = [{ key: "__preexisting_displaced", entry: reg.displaced }];
    else reg.displaced = [];
  }
  for (const k of ["images", "videos", "audio", "firstFrames"]) {
    if (!isObj(reg[k])) {
      if (reg[k] !== undefined) reg.displaced.push({ key: `__preexisting_${k}`, entry: reg[k] });
      reg[k] = {};
    }
  }
  if (!Array.isArray(reg.finals)) {
    if (reg.finals !== undefined) reg.displaced.push({ key: "__preexisting_finals", entry: reg.finals });
    reg.finals = [];
  }

  // A usable stable identity is a NON-EMPTY string; an empty "" must be re-minted.
  const hasId = (o) => isObj(o) && typeof o.assetId === "string" && o.assetId !== "";
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const normalizeChain = (key, val) => {
    // legacy plain-string slot → v1 chain (same rule as mediaref.normalizeEntry;
    // inlined so the migration stays self-contained and deterministic)
    if (typeof val === "string" && val) {
      return { current: 1, history: [{ slot_id: key, origin: "upload", version: 1, digest: null, url: val }] };
    }
    return isObj(val) && Array.isArray(val.history) ? val : null;
  };
  const stampChain = (domain, key, e) => {
    for (const r of e.history) {
      if (!isObj(r)) continue;
      if (!hasId(r)) r.assetId = mig();
      if (!("shot_id" in r)) r.shot_id = provenShot(domain, key);
    }
    return e;
  };
  const moveChains = (domain, from, into) => {
    for (const key of Object.keys(from)) {
      const e = normalizeChain(key, from[key]);
      if (!e) {
        // Unrecognized entry: NEVER dropped. Keep it verbatim in displaced so
        // no recoverable v2 media is lost when the node field is removed.
        reg.displaced.push({ key, entry: from[key] });
        continue;
      }
      if (has(into, key)) {
        // later node wins (matches the merged read model); keep the loser.
        // hasOwnProperty, not `into[key]`: a first slot named `__proto__` would
        // otherwise read the inherited prototype as a spurious "existing" entry.
        reg.displaced.push({ key, entry: into[key] });
      }
      putKey(into, key, stampChain(domain, key, e));
    }
  };

  // Pass 1 — move every chain-based medium (uploads) and finals into the
  // registry. firstFrames are resolved in pass 2, AFTER all image chains
  // exist, so a video node preceding its assets node still reuses the carried
  // image Asset's id rather than minting a duplicate.
  const DOMAIN = { assets: "images", video: "videos", audio: "audio" };
  const frameSources = [];
  for (const n of doc.nodes) {
    if (!isObj(n)) continue;
    // A null media field carries no data — drop it so a legitimate v2 node with
    // `uploads: null` (etc.) isn't rejected by the v3 no-node-media invariant.
    for (const field of ["uploads", "firstFrames", "finals"]) {
      if (n[field] === null) delete n[field];
    }
    // own-property only: a crafted node.type like "constructor" must NOT
    // resolve an inherited DOMAIN value.
    const domain = Object.prototype.hasOwnProperty.call(DOMAIN, n.type) ? DOMAIN[n.type] : null;
    const nid = typeof n.id === "string" ? n.id : n.type;
    // Media the v2 READ path never consumed from THIS node type was inert — it
    // must be preserved (displaced) and the node cleaned, NEVER promoted to
    // active (which could replace the real first frame / final). Media on the
    // consuming node type is moved active if well-shaped; a malformed shape on
    // the right type is left in place for the v3 validator to reject (fail safe).

    // uploads — consumed per media DOMAIN (assets→images, video→videos, audio→audio)
    if (n.uploads !== undefined) {
      if (domain) {
        if (isObj(n.uploads)) { moveChains(domain, n.uploads, reg[domain]); delete n.uploads; }
        // else: malformed uploads on a domain node → leave → v3 validator rejects
      } else {
        reg.displaced.push({ key: `node-uploads:${nid}`, entry: n.uploads }); // inert in v2
        delete n.uploads;
      }
    }
    // firstFrames — consumed ONLY by video nodes
    if (n.firstFrames !== undefined) {
      if (n.type === "video") {
        if (isObj(n.firstFrames)) { frameSources.push(n.firstFrames); delete n.firstFrames; }
        // else: malformed firstFrames on a video node → leave → validator rejects
      } else {
        reg.displaced.push({ key: `node-firstFrames:${nid}`, entry: n.firstFrames }); // inert in v2
        delete n.firstFrames;
      }
    }
    // finals — consumed ONLY by edit nodes. A final Asset needs a non-empty url;
    // a urlless object (v2's permitted `finals: [{}]`) / primitive → displaced.
    const pushFinal = (f) => {
      if (typeof f === "string" && f) reg.finals.push({ assetId: mig(), url: f, origin: null });
      else if (isObj(f) && typeof f.url === "string" && f.url) {
        if (!hasId(f)) f.assetId = mig();
        reg.finals.push(f);
      } else reg.displaced.push({ key: `final-entry:${nid}`, entry: f });
    };
    if (n.finals !== undefined) {
      if (n.type === "edit") {
        if (Array.isArray(n.finals)) { for (const f of n.finals) pushFinal(f); delete n.finals; }
        else if (isObj(n.finals)) { for (const val of Object.values(n.finals)) pushFinal(val); delete n.finals; }
        // else: malformed finals (string/primitive) on an edit node → leave → validator rejects
      } else {
        reg.displaced.push({ key: `node-finals:${nid}`, entry: n.finals }); // inert in v2
        delete n.finals;
      }
    }
  }

  // Normalize + stamp EVERY registry chain — pre-existing entries (from a
  // partial v2 `assets`, including legacy url strings) as well as just-moved
  // ones — so no Asset lacks an identity, and the first-frame reuse below can
  // match against stamped image asset ids.
  for (const dom of ["images", "videos", "audio"]) {
    for (const key of Object.keys(reg[dom])) {
      let e = reg[dom][key];
      if (typeof e === "string" && e) {
        e = normalizeChain(key, e);
        putKey(reg[dom], key, e);
      }
      if (isObj(e) && Array.isArray(e.history)) stampChain(dom, key, e);
    }
  }
  // Normalize pre-existing registry finals too: a partial v2 `assets.finals`
  // url STRING is a real final → an Asset record (like a node string final); a
  // urlless object / primitive is inert → displaced. Rebuild the array so the
  // v3 registry holds only valid, identity-stamped final records.
  const finalsIn = reg.finals;
  reg.finals = [];
  for (const f of finalsIn) {
    if (typeof f === "string" && f) reg.finals.push({ assetId: mig(), url: f, origin: null });
    else if (isObj(f) && typeof f.url === "string" && f.url) {
      if (!hasId(f)) f.assetId = mig();
      reg.finals.push(f);
    } else reg.displaced.push({ key: "final-preexisting", entry: f });
  }

  // Stamp a first-frame ref's identity + provenance. Reuse of the carried
  // image Asset (same slot+version+url is the copied reference itself) requires
  // reg.images already stamped — which the pass above guarantees.
  const stampFrame = (key, r) => {
    if (!hasId(r)) {
      // reuse ONLY the SAME-slot image Asset (key is the slot): a first frame is
      // per-shot, carried from that shot's own image; never another slot's.
      // Reuse requires an UNAMBIGUOUS match: if duplicate history records share
      // this version+url, identity can't be proven → mint a fresh id instead of
      // arbitrarily taking the first.
      const img = reg.images[key];
      let match = null;
      let matchCount = 0;
      for (const x of isObj(img) && Array.isArray(img.history) ? img.history : []) {
        if (isObj(x) && x.version === r.version && x.url === r.url) {
          match = x;
          matchCount += 1;
        }
      }
      r.assetId = matchCount === 1 && hasId(match) ? match.assetId : mig();
    }
    // firstFrames are keyed by slot (image-like), so provenShot uses the slot
    if (!("shot_id" in r)) r.shot_id = provenShot("images", key);
  };

  // Pass 2 — firstFrames. Later node wins on a duplicate slot (consistent with
  // the uploads merge and the pre-M3 merged read model).
  for (const frames of frameSources) {
    for (const key of Object.keys(frames)) {
      let r = frames[key];
      // A legacy string first-frame (v2 validation permitted a url string as a
      // firstFrames value) is a REAL configured frame — normalize it to a v1
      // MediaRef, exactly like a legacy string upload, so upgrading never
      // silently disables it. Only a non-string primitive is inert → displaced.
      if (typeof r === "string" && r) {
        r = { slot_id: key, origin: "upload", version: 1, digest: null, url: r };
      } else if (!isObj(r)) {
        if (r !== undefined) reg.displaced.push({ key: `firstFrame:${key}`, entry: r });
        continue;
      }
      // later node wins, but the earlier frame link is NEVER dropped — keep it
      // in displaced, symmetric with the uploads merge. hasOwnProperty, not
      // `reg.firstFrames[key]`: a `__proto__` slot would else read the prototype.
      if (has(reg.firstFrames, key)) reg.displaced.push({ key: `firstFrame:${key}`, entry: reg.firstFrames[key] });
      putKey(reg.firstFrames, key, r);
    }
  }
  // Stamp ALL first frames — node-derived AND pre-existing (a partial v2
  // `assets.firstFrames` would otherwise persist without assetId/shot_id). A
  // pre-existing string entry is a real frame → normalize it (as above); any
  // other primitive is inert → displaced, so the v3 map holds only references.
  for (const key of Object.keys(reg.firstFrames)) {
    let r = reg.firstFrames[key];
    if (typeof r === "string" && r) {
      r = { slot_id: key, origin: "upload", version: 1, digest: null, url: r };
      putKey(reg.firstFrames, key, r);
    }
    if (isObj(r)) stampFrame(key, r);
    else {
      reg.displaced.push({ key: `firstFrame:${key}`, entry: r });
      delete reg.firstFrames[key];
    }
  }
  doc.assets = reg;
  return doc;
}

/**
 * v3 → v4 (checkpoint M4a): rename the CREATIVE media-shot reference.
 * M3 stamped every media record with `shot_id` = the provable creative shotId.
 * That collides by NAME with the server's sequence-based official `shot_id`
 * (different namespace) — a dangerous trap for the M4 shotId↔server bridge.
 * Since `MediaRef.shot_id` is write-only/inert in M3 (no reader anywhere), the
 * rename to `creativeShotId` is deterministic and behavior-free: it only
 * disambiguates the two namespaces before any join starts reading them.
 *
 * Purely a field rename on media records (images/videos/audio history +
 * firstFrames). No id, url, slot, version, digest, current pointer, or history
 * order is touched. The server-side `shot_id` (paid ops, locked records) is a
 * DIFFERENT field on different objects and is NOT touched.
 */
function migrateV3ToV4(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  const rename = (r) => {
    if (!isObj(r) || !("shot_id" in r)) return;
    if (!("creativeShotId" in r)) r.creativeShotId = r.shot_id;
    delete r.shot_id; // the collided name is gone for good
  };
  if (!isObj(doc.assets)) return doc;
  for (const dom of ["images", "videos", "audio"]) {
    const m = doc.assets[dom];
    if (!isObj(m)) continue;
    for (const k of Object.keys(m)) {
      const e = m[k];
      if (isObj(e) && Array.isArray(e.history)) e.history.forEach(rename);
    }
  }
  if (isObj(doc.assets.firstFrames)) {
    for (const k of Object.keys(doc.assets.firstFrames)) rename(doc.assets.firstFrames[k]);
  }
  return doc;
}

/** Sequential migration steps: { [fromVersion]: (doc) => docAtFromVersion+1 }.
 *  Extended one real step at a time, never speculatively. */
export const MIGRATIONS = { 1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4 };

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
    // Since v3 the Project Asset Registry owns creator media; nodes only ALIAS
    // it at runtime and never persist it. A v3 document whose node still
    // carries uploads/firstFrames/finals would load WITHOUT that media (restore
    // no longer reads node media) and overwrite it on the next save — so fail
    // safe: reject it, never silently drain it. (v1/v2 nodes legitimately carry
    // media; the v2→v3 migration is what moves it into the registry.)
    if (Number.isInteger(doc.v) && doc.v >= 3) {
      for (const field of ["uploads", "firstFrames", "finals"]) {
        if (n[field] !== undefined) return `node retains media field "${field}" (must be in assets registry since v3)`;
      }
    } else {
      for (const k of ["uploads", "firstFrames"]) {
        if (n[k] !== undefined && n[k] !== null && !isPlainObject(n[k])) {
          return `node ${k} is not an object`;
        }
      }
      if (n.finals !== undefined && n.finals !== null && typeof n.finals !== "object") {
        return "node finals is not an object or array";
      }
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
  // A v3 save ALWAYS carries the registry (the serializer emits it even when
  // empty). A v3 document missing `assets` is truncated — accepting it would
  // restore an empty registry and cement silent loss of all creator media on
  // the next save; fail safe instead.
  const atV3 = Number.isInteger(doc.v) && doc.v >= 3;
  if (atV3 && !isPlainObject(doc.assets)) {
    return "v3 document is missing its assets registry";
  }
  if (doc.assets !== undefined) {
    if (!isPlainObject(doc.assets)) return "assets is not an object";
    for (const k of ["images", "videos", "audio", "firstFrames"]) {
      // at v3 a subfield must be PRESENT (the serializer always emits all six);
      // an omitted one is a truncated save that would restore empty and cement
      // media loss on the next save — reject it.
      if (atV3 && !isPlainObject(doc.assets[k])) return `v3 assets.${k} is missing or not an object`;
      if (doc.assets[k] !== undefined && !isPlainObject(doc.assets[k])) {
        return `assets.${k} is not an object`;
      }
    }
    for (const k of ["finals", "displaced"]) {
      if (atV3 && !Array.isArray(doc.assets[k])) return `v3 assets.${k} is missing or not an array`;
      if (doc.assets[k] !== undefined && !Array.isArray(doc.assets[k])) {
        return `assets.${k} is not an array`;
      }
    }
    // Fail SAFE, don't silently lose: a chain-map entry that isn't a legacy
    // url string or a {history:[…]} chain is exactly what registry hydration
    // (mediaref.migrateUploads) would DELETE. Reject the document instead, so
    // a corrupt registry blocks saving rather than dropping media on reload.
    for (const k of ["images", "videos", "audio"]) {
      const m = doc.assets[k];
      if (!isPlainObject(m)) continue;
      for (const slot of Object.keys(m)) {
        const e = m[slot];
        const ok = (typeof e === "string" && e) || (isPlainObject(e) && Array.isArray(e.history));
        if (!ok) return `assets.${k}[${slot}] is not a media chain`;
      }
    }
    // v3 identity invariant: every durable Asset (chain history record + final)
    // carries a NON-EMPTY assetId, and those ids are UNIQUE across the registry.
    // (firstFrames deliberately REUSE an image Asset's id, so they alias rather
    // than mint — excluded from the uniqueness set, only required non-empty.)
    // A save violating this would load identity-less/colliding assets; reject it.
    if (atV3) {
      const ids = new Set();
      const imageById = new Map(); // assetId → {slot, version, url, digest} — legit reuse targets
      const claim = (id, where, rec, slot) => {
        if (typeof id !== "string" || !id) return `assets ${where} has no assetId`;
        if (ids.has(id)) return `assets ${where} has duplicate assetId ${id}`;
        ids.add(id);
        if (rec) imageById.set(id, { slot, version: rec.version, url: rec.url, digest: rec.digest });
        return null;
      };
      for (const k of ["images", "videos", "audio"]) {
        const m = doc.assets[k];
        if (!isPlainObject(m)) continue;
        for (const slot of Object.keys(m)) {
          const e = m[slot];
          if (typeof e === "string") return `assets.${k}[${slot}] is a legacy string (no identity) at v3`;
          if (!Array.isArray(e.history) || !e.history.length) return `assets.${k}[${slot}] has no history`;
          for (const r of e.history) {
            const err = claim(isPlainObject(r) ? r.assetId : null, `${k}[${slot}] history record`, k === "images" ? r : null, slot);
            if (err) return err;
            // an Asset needs REACHABLE bytes and a resolvable version, else it
            // loads but its media/current-pointer is dead
            if (typeof r.url !== "string" || !r.url) return `assets.${k}[${slot}] history record has no url`;
            if (!Number.isInteger(r.version)) return `assets.${k}[${slot}] history record has no valid version`;
          }
          // the current pointer must resolve to a real version in the chain
          if (!e.history.some((r) => isPlainObject(r) && r.version === e.current)) {
            return `assets.${k}[${slot}] current pointer ${JSON.stringify(e.current)} has no matching version`;
          }
        }
      }
      for (const f of Array.isArray(doc.assets.finals) ? doc.assets.finals : []) {
        // at v3 every final IS an Asset record — a bare string has no identity
        if (typeof f === "string") return "assets.finals has a bare-string entry (no identity) at v3";
        const err = claim(isPlainObject(f) ? f.assetId : null, "finals record");
        if (err) return err;
        // …and a real, reachable url — else finalUrls silently hides it and the
        // "final" is inaccessible dead data
        if (typeof f.url !== "string" || !f.url) return "assets.finals record has no url";
      }
      const ff = doc.assets.firstFrames;
      if (isPlainObject(ff)) {
        const standaloneFrameIds = new Set();
        for (const slot of Object.keys(ff)) {
          const r = ff[slot];
          // a first frame is an object REFERENCE with a non-empty assetId (it
          // legitimately reuses an image Asset's id, so it's excluded from the
          // uniqueness set above); a primitive would be dead/misleading data
          if (!isPlainObject(r)) return `assets.firstFrames[${slot}] is not a reference object`;
          if (typeof r.assetId !== "string" || !r.assetId) {
            return `assets.firstFrames[${slot}] reference has no assetId`;
          }
          // a frame drives video first-frame planning/compose — it needs
          // reachable bytes and a resolvable version, never undefined media
          if (typeof r.url !== "string" || !r.url) return `assets.firstFrames[${slot}] reference has no url`;
          if (!Number.isInteger(r.version)) return `assets.firstFrames[${slot}] reference has no valid version`;
          if (imageById.has(r.assetId)) {
            // reuse is legit ONLY if it references THAT image at the SAME slot
            // (a first frame is per-shot, carried from that shot's own image)
            // with matching version+url; anything else glues one image's
            // identity onto another shot's or another image's bytes. The frame's
            // OWN slot_id must agree with its map key, and if both carry a digest
            // they must match (a legit carried frame may compute a digest the
            // source image lacked, so a null on either side is not a conflict).
            const src = imageById.get(r.assetId);
            const digestConflict =
              typeof r.digest === "string" && r.digest &&
              typeof src.digest === "string" && src.digest && r.digest !== src.digest;
            const slotIdConflict = r.slot_id !== undefined && r.slot_id !== slot;
            if (src.slot !== slot || r.version !== src.version || r.url !== src.url || digestConflict || slotIdConflict) {
              return `assets.firstFrames[${slot}] reuses image id ${r.assetId} but does not match its slot/media`;
            }
            continue;
          }
          // not an image alias: an id matching a video/audio/final Asset is a
          // misattributed collision; a STANDALONE id must still be unique among
          // first frames, else two different frame urls conflate under one id.
          if (ids.has(r.assetId)) return `assets.firstFrames[${slot}] reuses a non-image Asset id ${r.assetId}`;
          if (standaloneFrameIds.has(r.assetId)) {
            return `assets.firstFrames[${slot}] shares a standalone assetId ${r.assetId}`;
          }
          standaloneFrameIds.add(r.assetId);
        }
      }
    }
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
  // The whole run is guarded: untrusted input (e.g. pathologically deep JSON
  // that overflows structuredClone, or a migration hitting bad data) must fail
  // SAFE with an "invalid" verdict, never throw and crash the load.
  try {
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
  } catch (e) {
    return { status: "invalid", detail: `migration failed: ${e && e.message ? e.message : String(e)}` };
  }
}
