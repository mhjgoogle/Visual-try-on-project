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

import { MAX_CLIP_START, MAX_CLIP_FADE, TRACKS as TIMELINE_TRACKS } from "../workflow/timeline.js";
import { pairKey } from "../workflow/canondoc.js";
import { ASSET_KINDS, declarationDomainError, LINK_KEYS } from "../workflow/assetreg.js";
import { RUN_STATUSES, PROPOSAL_DISPOSITIONS } from "../workflow/skillrun.js";
import {
  LAYERS as REVIEW_LAYERS, ISSUE_CATEGORIES, SEVERITIES, ISSUE_STATES, VERDICTS,
} from "../workflow/review.js";

/** The Skill Run states, reused from the domain rather than re-listed here —
 *  a forked copy is how a validator starts rejecting documents the domain
 *  legitimately produces (the v10 pair-key defect, twice over). */
const SKILL_RUN_STATUS_SET = new Set(RUN_STATUSES);
/** …and the same rule for the second axis. */
const SKILL_RUN_DISPOSITION_SET = new Set(PROPOSAL_DISPOSITIONS);

/** The review vocabularies, imported for the same reason — the document is
 *  validated against the domain's own sets, never a copy of them. */
const REVIEW_LAYER_SET = new Set(REVIEW_LAYERS);
const REVIEW_SEVERITY_SET = new Set(SEVERITIES);
const REVIEW_ISSUE_STATE_SET = new Set(ISSUE_STATES);
const REVIEW_VERDICT_SET = new Set(VERDICTS);
const REVIEW_CATEGORY_SET = new Map(
  REVIEW_LAYERS.map((layer) => [layer, new Set(ISSUE_CATEGORIES[layer])]),
);

/**
 * THE RULE EVERY ADDITIVE TOP-LEVEL FIELD FOLLOWS. Named once so the fields that
 * follow it cannot quietly follow two different rules.
 *
 * - ABSENT (or explicitly null) is legitimate and validates: a document written
 *   before the field existed simply carries none of it, and rejecting that would
 *   refuse every historical save — which is why none of these fields bumped the
 *   schema version.
 * - PRESENT-BUT-WRONG rejects the WHOLE document. A malformed additive field is
 *   not "a field to ignore": it is read by something downstream, and dropping it
 *   silently is how a document nobody can explain gets acted on.
 *
 * `deliverySpec` already worked this way; the top-level `reviews` did not, and
 * two additive fields carrying two standards is what TASK-084 项 2 closes.
 */
function additivePresent(value) {
  return value !== undefined && value !== null;
}

/** The pre-v15 vocabulary, kept so a v12–v14 document can still be validated as
 *  what it is. The v14→v15 migration is what turns these into the two axes. */
const LEGACY_SKILL_RUN_STATUSES = new Set([
  "running", "proposed", "failed", "accepted", "rejected",
]);

/** Authoritative CURRENT canvas schema version. Saves must emit exactly this. */
export const CANVAS_SCHEMA_VERSION = 15;

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

/**
 * v4 → v5 (checkpoint M5): Project Generation Registry + Asset storage lifecycle.
 * Two purely ADDITIVE changes — no existing field is renamed/removed/altered:
 *
 * 1. doc.generations (NEW top-level array) — the durable source of generation
 *    provenance, INDEPENDENT of media bytes. Backfilled from the Asset registry:
 *    every history record whose origin is an AI generation (paid-image /
 *    paid-video / adopted / tts — NOT upload) gets a Generation record linking to
 *    that assetId + its proven creativeShotId (M4). Historical prompt / model /
 *    parameters / inputs were never persisted on the MediaRef, so they stay
 *    honestly null (legacy) — never manufactured. gen-mig-<n> ids are
 *    counter-based in fixed traversal order (deterministic) and pre-scanned
 *    against any id an already-present generations array carries.
 *
 * 2. Asset storageState (NEW field on every durable Asset record) — 'local' for
 *    all existing media (bytes present). Lets a future Remove-Local-Copy /
 *    archive / missing-detection / permanent-delete flow change an Asset's byte
 *    availability WITHOUT touching its identity or its Generation provenance.
 *    assetId / url / version / digest / creativeShotId are untouched.
 */
function migrateV4ToV5(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(doc.assets)) {
    if (!Array.isArray(doc.generations)) doc.generations = [];
    return doc;
  }
  const AI_ORIGINS = new Set(["paid-image", "paid-video", "adopted", "tts"]);
  const DOMAIN_TYPE = { images: "image", videos: "video", audio: "audio" };
  const STORAGE_STATES = new Set(["local", "archived", "missing", "deleted"]);

  // -- storageState: NORMALIZE every durable Asset record to a valid value.
  // 'local' when absent (bytes present); also OVERWRITE an invalid pre-existing
  // value — v4 permitted arbitrary unknown fields, but v5 rejects a bad
  // storageState, so a normalize (not merely a fill) keeps a valid v4 save
  // loadable after migration.
  const stampStorage = (r) => {
    if (isObj(r) && !STORAGE_STATES.has(r.storageState)) r.storageState = "local";
  };
  for (const dom of ["images", "videos", "audio"]) {
    const m = doc.assets[dom];
    if (!isObj(m)) continue;
    for (const k of Object.keys(m)) {
      const e = m[k];
      if (isObj(e) && Array.isArray(e.history)) e.history.forEach(stampStorage);
    }
  }
  for (const f of Array.isArray(doc.assets.finals) ? doc.assets.finals : []) stampStorage(f);
  if (isObj(doc.assets.firstFrames)) {
    for (const k of Object.keys(doc.assets.firstFrames)) stampStorage(doc.assets.firstFrames[k]);
  }

  // -- generations: backfill FRESH from AI-origin history records --
  // The `generations` field is introduced AT v5, so a genuine v4 save never
  // carries it. Any pre-existing value on a v4 doc is hand-crafted junk that
  // could satisfy some v5 invariants while violating others (dup ids, dangling
  // links, wrong-domain results, mismatched targets) → an unloadable migrated
  // doc. We therefore IGNORE any pre-existing generations and build the registry
  // purely from the (already-validated-at-v5) asset backfill, which is always
  // v5-valid by construction.
  const gens = [];
  const claimedAssets = new Set();
  let counter = 0;
  // gen-mig-<n> in traversal order — deterministic and collision-free (the
  // registry starts empty, so no pre-existing id can clash).
  const migId = () => `gen-mig-${++counter}`;
  for (const dom of ["images", "videos", "audio"]) {
    const m = doc.assets[dom];
    if (!isObj(m)) continue;
    const type = DOMAIN_TYPE[dom];
    for (const k of Object.keys(m)) {
      const e = m[k];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      for (const r of e.history) {
        if (!isObj(r) || typeof r.assetId !== "string" || !r.assetId) continue;
        if (!AI_ORIGINS.has(r.origin)) continue; // upload / unknown → not an AI generation
        if (claimedAssets.has(r.assetId)) continue; // already registered
        claimedAssets.add(r.assetId);
        const target = typeof r.creativeShotId === "string" && r.creativeShotId ? r.creativeShotId : null;
        gens.push({
          generationId: migId(),
          type,
          targetType: target ? "shot" : null,
          targetId: target, // canonical creativeShotId (M4), never slot
          inputAssetIds: [],
          referenceAssetIds: [],
          userInstruction: null,
          promptSnapshot: null, // never persisted historically → honest null
          provider: null,
          model: null,
          parameters: null,
          status: "success", // the record IS its produced Asset
          resultAssetIds: [r.assetId],
          createdAt: null, // a deterministic migration mints no clock time
        });
      }
    }
  }
  doc.generations = gens;
  return doc;
}

/**
 * v5 → v6 (checkpoint M6): Production domain structure —
 * Project → Episodes → Scenes → Shots.
 *
 * Adds the top-level `production` document: episodes own scenes, scenes
 * reference shots by canonical creativeShotId (M2/M4) — shot CONTENT stays on
 * the scriptgen draft, asset ownership stays in `assets` (M3), generation
 * provenance in `generations` (M5). Nothing existing is renamed/removed.
 *
 * Every v5 project is a single-episode project by construction (the shell's
 * 单剧集视图), so the migration mints exactly ONE deterministic episode
 * (`ep-mig-1`, active) with no scenes: scene grouping and shot assignment are
 * creator decisions and are NEVER fabricated from sequence or position.
 *
 * The `production` field is introduced AT v6, so a genuine v5 save never
 * carries one. A pre-existing value is hand-crafted junk that could satisfy
 * some v6 invariants while violating others → it is REPLACED by the
 * deterministic default (same posture as the v5 `generations` backfill).
 */
function migrateV5ToV6(doc) {
  doc.production = {
    activeEpisodeId: "ep-mig-1",
    episodes: [{ episodeId: "ep-mig-1", title: "第 1 集", scenes: [] }],
  };
  return doc;
}

/**
 * v6 → v7 (checkpoint M7): Production Bible — project-level Characters and
 * Locations with States, plus Scene references to them.
 *
 * Purely ADDITIVE to the production document:
 * - production.characters / production.locations — introduced AT v7, so a
 *   genuine v6 save never carries them; any pre-existing value is
 *   hand-crafted junk and is REPLACED by the honest empty registry (same
 *   posture as the v5 generations / v6 production backfills). No character or
 *   location is ever fabricated from drafts, media, or scene titles.
 * - every scene += characterRefs: [] / locationRef: null — references INTO
 *   the bible (by id + optional state id); pre-existing junk under those key
 *   names is likewise replaced (the fields are born here).
 * Episodes, scenes, shot refs, assets, generations are untouched.
 */
function migrateV6ToV7(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(doc.production)) return doc; // fail safe: v7 validation will reject
  doc.production.characters = [];
  doc.production.locations = [];
  for (const e of Array.isArray(doc.production.episodes) ? doc.production.episodes : []) {
    if (!isObj(e)) continue;
    for (const s of Array.isArray(e.scenes) ? e.scenes : []) {
      if (!isObj(s)) continue;
      s.characterRefs = [];
      s.locationRef = null;
    }
  }
  return doc;
}

/**
 * v7 → v8 (checkpoint M9): Story development chain + per-episode scripts.
 *
 * 1. `story` (NEW top-level document) — Idea → Story Outline (versioned,
 *    approvable) → Episode Plan (versioned, confirmable). Introduced empty:
 *    outlines/plans are creator decisions and are NEVER fabricated. The idea
 *    is backfilled from the legacy project-level Creative Brief
 *    (scriptDoc.brief) — an honest copy of what the creator already wrote.
 * 2. `scripts` (NEW top-level map, episodeId → script document) — scripts
 *    become PER-EPISODE. Every pre-v8 project is a single-episode workflow by
 *    construction, so the one legacy `scriptDoc` moves (verbatim) to the
 *    ACTIVE episode's slot. The top-level `scriptDoc` field is gone at v8 —
 *    a leftover one is rejected by validation (like node media since v3),
 *    so no second durable script source of truth can form.
 */
function migrateV7ToV8(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  const brief = isObj(doc.scriptDoc) && typeof doc.scriptDoc.brief === "string" ? doc.scriptDoc.brief : "";
  doc.story = {
    idea: brief,
    versions: [],
    active: 0,
    approved: 0,
    plans: [],
    activePlan: 0,
    confirmedPlan: 0,
  };
  const scripts = {};
  const active = isObj(doc.production) && typeof doc.production.activeEpisodeId === "string"
    ? doc.production.activeEpisodeId
    : null;
  if (doc.scriptDoc === null || doc.scriptDoc === undefined) {
    delete doc.scriptDoc; // nothing durable to move
  } else if (isObj(doc.scriptDoc) && active) {
    // own-key write: an episodeId literally named `__proto__` must become a
    // real entry, never invoke the prototype setter (same rule as putKey in
    // the v2→v3 migration)
    if (active === "__proto__") {
      Object.defineProperty(scripts, active, {
        value: doc.scriptDoc, writable: true, enumerable: true, configurable: true,
      });
    } else {
      scripts[active] = doc.scriptDoc;
    }
    delete doc.scriptDoc; // moved verbatim to the active episode
  }
  // else: a malformed scriptDoc (or one with no episode to attach to) is LEFT
  // in place — v8 validation rejects the leftover, never a silent drop
  doc.scripts = scripts;
  return doc;
}

/**
 * v8 → v9 (checkpoint M11): audio references + per-episode timelines.
 * Purely ADDITIVE:
 * - every scene += ambienceAssetId: null / bgmAssetId: null, every episode +=
 *   bgmAssetId: null — REFERENCES into the audio registry (never copies; the
 *   fields are born here, pre-existing junk under these names is replaced);
 * - `timelines` (NEW top-level map, episodeId → { clips, settings, edited })
 *   — introduced empty; timeline clips are creator/sync decisions, never
 *   fabricated by a migration;
 * - the Generation type vocabulary gains "render" AT v9 (local FFmpeg render
 *   provenance: inputs = clip assetIds, parameters = settings + clip
 *   snapshot, result = the final Asset) — a mechanical render is durable
 *   provenance like any generation, with an honest non-AI provider.
 */
function migrateV8ToV9(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  // ADD the v9 fields without CLOBBERING any value already present under those
  // names (the codebase's unknown-field-preservation convention): only default
  // a field that is genuinely absent — never overwrite persisted data.
  // preserve a VALID pre-existing ref (non-empty string), else default to null:
  // a v8 doc may carry a non-string value under these names that v8 ignored;
  // carrying it into v9 unchanged would make v9 validation reject the doc, so
  // coerce anything that is not a valid assetRef to null (still non-destructive
  // for real data — only invalid/absent values change).
  const ref = (v) => (typeof v === "string" && v ? v : null);
  if (isObj(doc.production)) {
    for (const e of Array.isArray(doc.production.episodes) ? doc.production.episodes : []) {
      if (!isObj(e)) continue;
      e.bgmAssetId = ref(e.bgmAssetId);
      for (const s of Array.isArray(e.scenes) ? e.scenes : []) {
        if (!isObj(s)) continue;
        s.ambienceAssetId = ref(s.ambienceAssetId);
        s.bgmAssetId = ref(s.bgmAssetId);
      }
    }
  }
  if (!isObj(doc.timelines)) doc.timelines = {};
  return doc;
}

/**
 * v9 → v10 (TASK-057 / ADR-0054): the Production UPSTREAM workspace's canon.
 * Purely ADDITIVE — no existing field is renamed, removed or reinterpreted:
 *
 * 1. `story.brief` (NEW) — the Creative Brief as a WORKING DRAFT plus an
 *    append-only revision chain. Introduced with ZERO revisions: a migration
 *    must not mint a "v1" the creator never confirmed (Autosave != Version).
 *    The draft starts EMPTY of brief facets — genre/tone/form/duration were
 *    never persisted before, so inventing them from the idea text would be
 *    fabrication. `story.idea` stays exactly where it is: the one canonical
 *    home of the core idea (决策 2).
 * 2. `production.relationships` (NEW, empty) — first-class relationships are
 *    creator canon and are NEVER derived from co-appearance in a scene.
 * 3. `production.world` (NEW, empty profile) — the World Setting. Deliberately
 *    NOT seeded from `story.versions[].outline.world`: that is the outline's
 *    own prose, owned by the (versioned, approvable) outline chain, and copying
 *    it would create the second source of truth §12 forbids.
 * 4. `production.canon` (NEW) — one revision counter per canon surface, all 0:
 *    nothing has been explicitly confirmed yet.
 * 5. every character += `tier: "formal"` — an existing character was confirmed
 *    by the creator (manually or through 剧本拆解), so `formal` is the honest
 *    reading; only a NEW character can be created as a bit part.
 * 6. every episode += empty `beats` and an ALL-ZERO `basedOn` — the upstream
 *    versions an old episode was built on were never recorded, so the stamp
 *    stays honestly empty ("未记录上游版本") instead of claiming the episode is
 *    current with canon it has never seen.
 *
 * Pre-existing values under these names are hand-crafted junk (the fields are
 * born here), so they are REPLACED by the deterministic default — the same
 * posture as the v5 generations / v6 production / v7 bible backfills.
 */
function migrateV9ToV10(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  if (isObj(doc.story)) {
    // 7. every outline version += `climax: ""` — 高潮 becomes its own outline
    //    facet at v10. Left EMPTY, never extracted from the storyArc prose:
    //    splitting a creator's sentence is a guess, not a migration.
    for (const x of Array.isArray(doc.story.versions) ? doc.story.versions : []) {
      if (isObj(x) && isObj(x.outline) && typeof x.outline.climax !== "string") x.outline.climax = "";
    }
    doc.story.brief = {
      draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null },
      versions: [],
      active: 0,
    };
  }
  if (isObj(doc.production)) {
    doc.production.relationships = [];
    doc.production.world = { era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "" };
    doc.production.canon = { characters: 0, relationships: 0, world: 0 };
    // 8. every character += `tier` and the CREATIVE-layer profile facets
    //    (身份 / 欲望 / 弱点 / 核心矛盾 / Character Arc), all empty: they were
    //    never persisted, and slicing them out of the existing 性格 prose would
    //    be invention. `tier` is "formal" — an existing character was confirmed
    //    by the creator, so demoting it to a bit part is the lossy reading.
    for (const c of Array.isArray(doc.production.characters) ? doc.production.characters : []) {
      if (!isObj(c)) continue;
      c.tier = "formal";
      if (!isObj(c.profile)) c.profile = {};
      for (const k of ["identity", "desire", "weakness", "coreConflict", "arc"]) {
        if (typeof c.profile[k] !== "string") c.profile[k] = "";
      }
    }
    for (const e of Array.isArray(doc.production.episodes) ? doc.production.episodes : []) {
      if (!isObj(e)) continue;
      e.beats = { plot: [], character: [], relationship: [], world: [] };
      e.basedOn = { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 };
    }
  }
  return doc;
}

/**
 * v10 → v11 (checkpoint CP2 / ADR-0055): every durable Asset record gains its
 * DECLARATION — kind / displayName / originalFilename / links / tags / reusable
 * / needsReview.
 *
 * Purely additive, and deliberately MINIMAL about what it claims. `kind` is
 * back-filled ONLY where the document ALREADY records the fact:
 *
 *   finals                                  → final       (origin is compose)
 *   character.referenceAssetIds hit         → character-reference + characterId
 *   location.referenceAssetIds hit          → location-reference  + locationId
 *   audio key voice-* / sfx-* / amb-* /
 *     bgm-* / music-main                    → dialogue / sfx / ambience / bgm
 *                                             (these prefixes are written BY
 *                                             this system — a convention we own,
 *                                             not a guess about a filename)
 *   scene.ambienceAssetId / bgmAssetId,
 *     episode.bgmAssetId                    → ambience / bgm + scene/episode link
 *   image record with a proven creativeShotId → shot-image + shotId
 *   video record with a proven creativeShotId → shot-video + shotId
 *
 * Everything else becomes `kind: null, needsReview: true`. That is the honest
 * outcome: the studio never recorded what those files were, and inventing a
 * classification (every png in `images` is a 镜头图片) would put a fabricated
 * answer where the creator's real one belongs.
 *
 * `originalFilename` and `displayName` are ALWAYS null after migration. Neither
 * was ever persisted, and deriving one from the url would present a
 * system-generated name (`assets-slot-3_v2.png`) as the creator's own.
 */
function migrateV10ToV11(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  const str = (x) => (typeof x === "string" && x ? x : null);
  if (!isObj(doc.assets)) return doc;
  const reg = doc.assets;
  const prod = isObj(doc.production) ? doc.production : null;

  // --- the facts the document ALREADY holds, collected once ---------------- //
  const declared = new Map(); // assetId → { kind, links }
  const claim = (assetId, kind, links) => {
    if (typeof assetId !== "string" || !assetId || declared.has(assetId)) return;
    declared.set(assetId, { kind, links });
  };
  if (prod) {
    for (const c of Array.isArray(prod.characters) ? prod.characters : []) {
      if (!isObj(c)) continue;
      const cid = str(c.characterId);
      const own = [
        ...(Array.isArray(c.referenceAssetIds) ? c.referenceAssetIds : []),
        // a state's override list is the SAME character's reference material
        ...(Array.isArray(c.states) ? c.states : []).flatMap((st) =>
          isObj(st) && isObj(st.overrides) && Array.isArray(st.overrides.referenceAssetIds)
            ? st.overrides.referenceAssetIds
            : []),
      ];
      for (const id of own) claim(id, "character-reference", { characterId: cid });
    }
    for (const l of Array.isArray(prod.locations) ? prod.locations : []) {
      if (!isObj(l)) continue;
      const lid = str(l.locationId);
      const own = [
        ...(Array.isArray(l.referenceAssetIds) ? l.referenceAssetIds : []),
        ...(Array.isArray(l.states) ? l.states : []).flatMap((st) =>
          isObj(st) && isObj(st.overrides) && Array.isArray(st.overrides.referenceAssetIds)
            ? st.overrides.referenceAssetIds
            : []),
      ];
      for (const id of own) claim(id, "location-reference", { locationId: lid });
    }
    for (const ep of Array.isArray(prod.episodes) ? prod.episodes : []) {
      if (!isObj(ep)) continue;
      const epId = str(ep.episodeId);
      claim(ep.bgmAssetId, "bgm", { episodeId: epId });
      for (const sc of Array.isArray(ep.scenes) ? ep.scenes : []) {
        if (!isObj(sc)) continue;
        const scId = str(sc.sceneId);
        claim(sc.ambienceAssetId, "ambience", { episodeId: epId, sceneId: scId });
        claim(sc.bgmAssetId, "bgm", { episodeId: epId, sceneId: scId });
      }
    }
  }

  // audio KEY prefixes this system writes itself (app.js / audiows.js): a
  // convention we own, so reading it back is recall, not inference
  const audioKindForKey = (key) => {
    if (typeof key !== "string") return null;
    if (key.startsWith("voice-")) return "dialogue";
    if (key.startsWith("sfx-")) return "sfx";
    if (key.startsWith("amb-")) return "ambience";
    if (key.startsWith("bgm-") || key === "music-main" || key.startsWith("music-")) return "bgm";
    return null;
  };

  const stamp = (rec, kind, links) => {
    if (!isObj(rec)) return;
    rec.kind = kind || null;
    rec.displayName = null; // never persisted before — not invented now
    rec.originalFilename = null;
    const l = {};
    for (const k of LINK_KEYS) l[k] = null;
    if (isObj(links)) {
      for (const k of LINK_KEYS) if (str(links[k])) l[k] = links[k];
    }
    rec.links = l;
    rec.tags = [];
    rec.reusable = false; // only an EXPLICIT creator mark ever sets this
    rec.needsReview = !rec.kind;
  };

  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      for (const r of e.history) {
        if (!isObj(r)) continue;
        const known = declared.get(str(r.assetId));
        if (known) {
          stamp(r, known.kind, known.links);
          continue;
        }
        if (domain === "audio") {
          const k = audioKindForKey(key);
          // a `voice-<slot>` take belongs to the shot the slot belongs to, and
          // that relation is only PROVEN when the record carries the id
          stamp(r, k, k === "dialogue" || k === "sfx" ? { shotId: str(r.creativeShotId) } : null);
          continue;
        }
        const shotId = str(r.creativeShotId);
        if (shotId) {
          stamp(r, domain === "images" ? "shot-image" : "shot-video", { shotId });
          continue;
        }
        stamp(r, null, null); // unclassified — kept, visible, and asking
      }
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) stamp(f, "final", null);
  // firstFrames ALIAS an image Asset (same assetId) — the alias carries no
  // second declaration, so it is deliberately left alone.
  return doc;
}

/**
 * v11 → v12 (checkpoint CP3 / ADR-0056): the Skill Run registry.
 *
 * One added top-level field, `skillRuns: []`. Purely additive and deliberately
 * EMPTY: no AI run has ever been recorded before this version, and minting
 * plausible history for the runs that produced existing drafts would fabricate
 * provenance for work whose actual origin the document never captured.
 */
function migrateV11ToV12(doc) {
  if (!Array.isArray(doc.skillRuns)) doc.skillRuns = [];
  return doc;
}

/**
 * v12 → v13 (checkpoint CP4 / ADR-0057): shot production state.
 *
 * `production.shotProduction = { reviews: {}, references: {} }` — the two
 * things about a Shot's production that cannot be derived: the creator's
 * 「通过」 and which canonical References the shot uses.
 *
 * Both start EMPTY. A migration cannot know which existing shots the creator
 * would have approved — and marking a shot approved because it happens to have
 * a video would be the exact confusion 「生成成功 != 镜头完成」 forbids. Existing
 * shots therefore show as 待审片, which is the truth: nobody has reviewed them.
 */
function migrateV12ToV13(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  if (isObj(doc.production) && !isObj(doc.production.shotProduction)) {
    doc.production.shotProduction = { reviews: {}, references: {} };
  }
  return doc;
}

/**
 * v13 → v14 (checkpoint CP8 / ADR-0059): the production graph's identity
 * contract — three additive fields that let the existing layers be traced
 * through as ONE chain.
 *
 *   skillRun.context   { episodeId, sceneId, shotId }  — WHICH canon a run read
 *   skillRun.proposal  gains `proposalId`              — so it can be referenced
 *   generation.origin  { skillRunId, proposalId }      — WHICH proposal launched it
 *
 * EVERY ONE OF THEM STARTS null ON EXISTING RECORDS, and that is the point.
 * The document never captured this linkage, so there is nothing to restore:
 * back-filling `context` from "the episode that was active when the run was
 * saved" would invent a fact, and attributing a Generation to the nearest
 * Proposal by timestamp would invent a lineage — which is worse than none,
 * because it looks like a record. Old runs and old generations therefore read
 * 「未记录」 in the UI, which is exactly what is true about them.
 *
 * Purely additive: nothing is moved, renamed or dropped, so a v13 document
 * loses nothing by coming forward.
 */
function migrateV13ToV14(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  for (const r of Array.isArray(doc.skillRuns) ? doc.skillRuns : []) {
    if (!isObj(r)) continue;
    if (r.context === undefined) r.context = null;
    // a proposal that predates the id carries none — it is still a real
    // proposal, it simply cannot be pointed at
    if (isObj(r.proposal) && r.proposal.proposalId === undefined) r.proposal.proposalId = null;
  }
  for (const g of Array.isArray(doc.generations) ? doc.generations : []) {
    if (isObj(g) && g.origin === undefined) g.origin = null;
  }
  return doc;
}

/**
 * v14 → v15 (TASK-072 批次一 / ADR-0066 决策 8): the Skill Run status splits into
 * TWO axes, and the record grows the fields the contract requires.
 *
 * The old enum answered two questions with one field:
 *
 *   running   -> running        (still going)          … or awaiting_input
 *   proposed  -> succeeded + disposition "pending"
 *   accepted  -> succeeded + disposition "accepted"
 *   rejected  -> succeeded + disposition "rejected"
 *   failed    -> failed
 *
 * `running` SPLITS, and the branch is read off a field the document already
 * carries — `executor` — so the migration stays deterministic (no clock, no
 * randomness, no guessing):
 *
 *   executor "manual"  -> awaiting_input   the creator may still bring an answer
 *   any local executor -> failed(interrupted)
 *
 * The second branch is not pessimism, it is arithmetic: the process that owned
 * that run belonged to a backend that no longer exists, so it can never produce
 * a result. Leaving it `running` forever is the zombie TASK-067 补记 2 fixed once
 * already.
 *
 * EVERY OTHER NEW FIELD IS null OR DERIVED FROM AN EXISTING ONE. `runId` is the
 * run's own `skillRunId` (one id, a new name — not a new identity); `taskType`
 * is `"skill." + skillId`. `provider` / `cost` / `progress` / timings stay empty
 * because the document never captured them, and back-filling them would be
 * fabricating provenance for work whose real origin nobody recorded.
 */
function migrateV14ToV15(doc) {
  const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
  for (const r of Array.isArray(doc.skillRuns) ? doc.skillRuns : []) {
    if (!isObj(r)) continue;
    const was = r.status;
    if (was === "running") {
      r.status = r.executor === "manual" ? "awaiting_input" : "failed";
      if (r.status === "failed") {
        r.failureReason = {
          category: "interrupted",
          detail: "运行中断：这次运行的后端进程已不存在（v14→v15 迁移时发现）",
        };
      }
    } else if (was === "proposed" || was === "accepted" || was === "rejected") {
      r.status = "succeeded";
      const disposition = was === "proposed" ? "pending" : was;
      // The disposition lives ON the proposal (系统合同 §5.3).
      //
      // A hand-corrupted NON-OBJECT proposal (`proposal: []`, a bare string…)
      // cannot carry the field. An earlier draft left those alone; the result
      // was a `succeeded` record whose proposal can never be recognised as
      // pending, accepted or rejected — accepted by the validator and useless to
      // every reader (codex review, rounds 4–7).
      //
      // So it is WRAPPED rather than ignored or dropped: the original value is
      // kept verbatim under `payload`, and the record becomes usable. Nothing
      // this app writes takes this branch — only a foreign or damaged document —
      // and for those, preserving the bytes while restoring the invariant is
      // strictly better than either discarding them or storing them unusable.
      if (isObj(r.proposal)) {
        r.proposal.disposition = disposition;
      } else if (r.proposal !== null && r.proposal !== undefined) {
        r.proposal = { payload: r.proposal, disposition, proposalId: null };
      }
    }
    if (r.runId === undefined) r.runId = r.skillRunId || null;
    if (r.kind === undefined) r.kind = "skill";
    if (r.taskType === undefined) {
      r.taskType = typeof r.skillId === "string" && r.skillId ? `skill.${r.skillId}` : null;
    }
    for (const [k, v] of [
      ["projectId", null], ["provider", null], ["target", null],
      ["outputs", null], ["outputVersions", null], ["progress", null],
      ["cost", null], ["startedAt", null], ["endedAt", null],
      ["failureReason", null], ["confirmation", null],
    ]) {
      if (r[k] === undefined) r[k] = v;
    }
  }
  return doc;
}

/** Sequential migration steps: { [fromVersion]: (doc) => docAtFromVersion+1 }.
 *  Extended one real step at a time, never speculatively. */
export const MIGRATIONS = { 1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4, 4: migrateV4ToV5, 5: migrateV5ToV6, 6: migrateV6ToV7, 7: migrateV7ToV8, 8: migrateV8ToV9, 9: migrateV9ToV10, 10: migrateV10ToV11, 11: migrateV11ToV12, 12: migrateV12ToV13, 13: migrateV13ToV14, 14: migrateV14ToV15 };

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
  // Since v8 scripts are PER-EPISODE (top-level `scripts` map) and the story
  // development chain lives in `story`. A leftover top-level scriptDoc would
  // be a second durable script source of truth — rejected like node media
  // since v3. Both new fields are always emitted by the serializer; a
  // truncated save missing either must fail safe, not restore empty.
  const atV8 = Number.isInteger(doc.v) && doc.v >= 8;
  // TASK-057 / ADR-0054: the Production upstream canon (Creative Brief,
  // relationships, World Setting, canon revisions, episode beats + basedOn).
  const atV10 = Number.isInteger(doc.v) && doc.v >= 10;
  if (atV8 && doc.scriptDoc !== undefined) {
    return "v8 document retains scriptDoc (scripts are per-episode since v8)";
  }
  if (atV8 && !isPlainObject(doc.scripts)) return "v8 document is missing its scripts map";
  if (doc.scripts !== undefined) {
    if (!isPlainObject(doc.scripts)) return "scripts is not an object";
    for (const k of Object.keys(doc.scripts)) {
      if (typeof k !== "string" || !k) return "scripts has an empty episode key";
      const s = doc.scripts[k];
      if (!isPlainObject(s)) return `scripts[${k}] is not an object`;
      if (!atV8) continue;
      // strict at v8 — everything script hydration (scriptdoc.createDoc)
      // would drop, coerce, or renumber is rejected instead: an accepted
      // save must never silently lose script content on the round-trip
      if (typeof s.brief !== "string") return `scripts[${k}] brief is missing or not a string`;
      if (!(s.workingText === null || typeof s.workingText === "string")) {
        return `scripts[${k}] workingText is not null or a string`;
      }
      if (!Array.isArray(s.versions)) return `scripts[${k}] versions is not an array`;
      const svIds = new Set();
      for (let i = 0; i < s.versions.length; i++) {
        const x = s.versions[i];
        const where = `scripts[${k}] v${i + 1}`;
        if (!isPlainObject(x)) return `scripts[${k}] versions contains a non-object entry`;
        if (typeof x.id !== "string" || !x.id) return `${where} has no id`;
        if (svIds.has(x.id)) return `scripts[${k}] has duplicate version id ${x.id}`;
        svIds.add(x.id);
        if (x.v !== i + 1) return `${where} is not densely numbered`;
        if (typeof x.content !== "string") return `${where} content is missing or not a string`;
        if (!["generated", "revision", "manual"].includes(x.origin)) return `${where} has invalid origin`;
        if (typeof x.instruction !== "string") return `${where} instruction is not a string`;
        if (!(x.basedOn === null || Number.isInteger(x.basedOn))) return `${where} basedOn is invalid`;
        if (x.status !== "done") return `${where} has invalid status`;
      }
      if (!(s.active === 0 || (Number.isInteger(s.active) && s.versions.some((x) => x.v === s.active)))) {
        return `scripts[${k}] active pointer has no matching version`;
      }
    }
  }
  if (atV8 && !isPlainObject(doc.story)) return "v8 document is missing its story document";
  if (doc.story !== undefined) {
    if (!isPlainObject(doc.story)) return "story is not an object";
    const st = doc.story;
    if (atV8) {
      // strict on every KNOWN field — anything hydration would coerce or
      // renumber is rejected instead (accepted saves never lose data)
      const OUTLINE_FIELDS = ["premise", "logline", "genreTone", "world", "centralConflict", "storyArc", "ending", "durationNote"];
      const PLAN_FIELDS = ["title", "synopsis", "purpose", "hook", "endingBeat", "duration"];
      // The product owner's seven (TASK-088 §2.1). ADDITIVE, and therefore
      // validated by the rule `additivePresent` states: absent/null is a
      // legitimate document written before the field existed, present-but-wrong
      // rejects the WHOLE document — hydration coerces these, so accepting a
      // malformed one would lose plan content on the load→save round-trip.
      // No schema-version bump, exactly like every other additive field.
      const PLAN_ADDED_STRINGS = ["coreGoal", "emotionArc"];
      const PLAN_LIST_FIELDS = ["keyEvents", "reveals"];
      if (typeof st.idea !== "string") return "story idea is missing or not a string";
      if (!Array.isArray(st.versions)) return "story versions is not an array";
      const soIds = new Set();
      for (let i = 0; i < st.versions.length; i++) {
        const x = st.versions[i];
        const where = `story outline v${i + 1}`;
        if (!isPlainObject(x)) return "story versions contains a non-object entry";
        if (typeof x.id !== "string" || !x.id) return `${where} has no id`;
        if (soIds.has(x.id)) return `duplicate story outline id ${x.id}`;
        soIds.add(x.id);
        if (x.v !== i + 1) return `${where} is not densely numbered`;
        if (!isPlainObject(x.outline)) return `${where} has no outline object`;
        for (const k of OUTLINE_FIELDS) {
          if (typeof x.outline[k] !== "string") return `${where} outline ${k} is missing or not a string`;
        }
        // `climax` is born at v10 (a v8/v9 outline legitimately has none)
        if (atV10 && typeof x.outline.climax !== "string") {
          return `${where} outline climax is missing or not a string`;
        }
        if (!Array.isArray(x.outline.characterConcepts)
          || x.outline.characterConcepts.some((s) => typeof s !== "string" || !s.trim())) {
          return `${where} characterConcepts is not a list of non-blank strings`;
        }
        // THE PRODUCT OWNER'S EIGHT (TASK-089 §2.1), by the same additive rule as
        // the plan's七项: absent/null is a document written before they existed;
        // present-but-wrong rejects the WHOLE document, because hydration coerces
        // them and accepting a malformed one would lose outline content on the
        // load→save round-trip. No schema-version bump.
        if (additivePresent(x.outline.storyCore) && typeof x.outline.storyCore !== "string") {
          return `${where} storyCore is not a string`;
        }
        const OUTLINE_OBJECTS = {
          protagonist: ["who", "initialWant"],
          conflict: ["external", "internal"],
          themeAndChange: ["theme", "protagonistBecomes"],
          mainline: ["setup", "development", "midpointTurn", "climax", "ending"],
        };
        for (const [key, subkeys] of Object.entries(OUTLINE_OBJECTS)) {
          const v = x.outline[key];
          if (!additivePresent(v)) continue;
          if (!isPlainObject(v)) return `${where} ${key} is not an object`;
          for (const sub of subkeys) {
            if (additivePresent(v[sub]) && typeof v[sub] !== "string") {
              return `${where} ${key}.${sub} is not a string`;
            }
          }
        }
        if (additivePresent(x.outline.worldAndRules)) {
          const w = x.outline.worldAndRules;
          if (!isPlainObject(w)) return `${where} worldAndRules is not an object`;
          if (additivePresent(w.where) && typeof w.where !== "string") {
            return `${where} worldAndRules.where is not a string`;
          }
          if (additivePresent(w.rules)
            && (!Array.isArray(w.rules) || w.rules.some((s) => typeof s !== "string" || !s.trim()))) {
            return `${where} worldAndRules.rules is not a list of non-blank strings`;
          }
        }
        if (additivePresent(x.outline.keyRelationships)) {
          const list = x.outline.keyRelationships;
          if (!Array.isArray(list)) return `${where} keyRelationships is not an array`;
          for (let r = 0; r < list.length; r++) {
            const rel = list[r];
            const rw = `${where} keyRelationships[${r}]`;
            if (!isPlainObject(rel)) return `${rw} is not an object`;
            // BOTH names, or the row names no relationship at all — and the
            // sanitizer drops such a row, so accepting it here would lose it
            if (!Array.isArray(rel.between) || rel.between.length !== 2
              || rel.between.some((s) => typeof s !== "string" || !s.trim())) {
              return `${rw} between is not two non-blank names`;
            }
            if (typeof rel.nature !== "string" || !rel.nature.trim()) return `${rw} has no nature`;
            if (additivePresent(rel.howItChanges) && typeof rel.howItChanges !== "string") {
              return `${rw} howItChanges is not a string`;
            }
          }
        }
        if (additivePresent(x.outline.secretsAndReveals)) {
          const list = x.outline.secretsAndReveals;
          if (!Array.isArray(list)) return `${where} secretsAndReveals is not an array`;
          for (let s = 0; s < list.length; s++) {
            const sec = list[s];
            const sw = `${where} secretsAndReveals[${s}]`;
            if (!isPlainObject(sec)) return `${sw} is not an object`;
            if (typeof sec.truth !== "string" || !sec.truth.trim()) return `${sw} has no truth`;
            for (const k of ["whyNotUpfront", "revealAround"]) {
              if (additivePresent(sec[k]) && typeof sec[k] !== "string") {
                return `${sw} ${k} is not a string`;
              }
            }
          }
        }
        const n = x.outline.episodeCount;
        // 1..50, matching the plan endpoint's parser cap (hydration nulls
        // out-of-range values, so out-of-range is rejected here instead)
        if (!(n === null || (Number.isInteger(n) && n > 0 && n <= 50))) {
          return `${where} episodeCount is not null or an integer in 1..50`;
        }
        if (!["developed", "revision", "manual"].includes(x.origin)) return `${where} has invalid origin`;
        if (typeof x.instruction !== "string") return `${where} instruction is not a string`;
        if (!(x.basedOn === null || Number.isInteger(x.basedOn))) return `${where} basedOn is invalid`;
      }
      const vOk = (v) => v === 0 || (Number.isInteger(v) && st.versions.some((x) => x.v === v));
      if (!vOk(st.active)) return "story active pointer has no matching outline version";
      if (!vOk(st.approved)) return "story approved pointer has no matching outline version";
      if (!Array.isArray(st.plans)) return "story plans is not an array";
      const planIds = new Set();
      for (let i = 0; i < st.plans.length; i++) {
        const x = st.plans[i];
        const where = `episode plan v${i + 1}`;
        if (!isPlainObject(x)) return "story plans contains a non-object entry";
        if (typeof x.id !== "string" || !x.id) return `${where} has no id`;
        if (planIds.has(x.id)) return `duplicate episode plan id ${x.id}`;
        planIds.add(x.id);
        if (x.v !== i + 1) return `${where} is not densely numbered`;
        if (!["proposed", "manual"].includes(x.origin)) return `${where} has invalid origin`;
        if (typeof x.instruction !== "string") return `${where} instruction is not a string`;
        if (!(x.outlineVersionId === null || (typeof x.outlineVersionId === "string" && x.outlineVersionId))) {
          return `${where} outlineVersionId is invalid`;
        }
        // which version this one was revised from (ADR-0072 决策 1). Additive:
        // absent on every version written before it, rejected when malformed.
        if (additivePresent(x.basedOn) && !Number.isInteger(x.basedOn)) {
          return `${where} basedOn is invalid`;
        }
        if (!Array.isArray(x.episodes) || !x.episodes.length) return `${where} has no episodes`;
        const linked = new Set();
        for (let j = 0; j < x.episodes.length; j++) {
          const e = x.episodes[j];
          const ew = `${where} EP${j + 1}`;
          if (!isPlainObject(e)) return `${where} episodes contains a non-object entry`;
          if (e.epNumber !== j + 1) return `${ew} is not densely numbered`;
          for (const k of PLAN_FIELDS) {
            if (typeof e[k] !== "string") return `${ew} ${k} is missing or not a string`;
          }
          if (!e.title.trim()) return `${ew} has a blank title`;
          for (const k of PLAN_ADDED_STRINGS) {
            if (additivePresent(e[k]) && typeof e[k] !== "string") {
              return `${ew} ${k} is not a string`;
            }
          }
          for (const k of PLAN_LIST_FIELDS) {
            if (!additivePresent(e[k])) continue;
            if (!Array.isArray(e[k]) || e[k].some((s) => typeof s !== "string" || !s.trim())) {
              return `${ew} ${k} is not a list of non-blank strings`;
            }
          }
          if (additivePresent(e.characterBeats)) {
            if (!Array.isArray(e.characterBeats)) return `${ew} characterBeats is not an array`;
            for (let b = 0; b < e.characterBeats.length; b++) {
              const beat = e.characterBeats[b];
              const bw = `${ew} characterBeats[${b}]`;
              if (!isPlainObject(beat)) return `${bw} is not an object`;
              // `who` + `change` are what a 角色推进 row IS: the sanitizer drops a
              // row missing either, so a saved half-row would be lost on reload
              if (typeof beat.who !== "string" || !beat.who.trim()) return `${bw} has no who`;
              if (typeof beat.change !== "string" || !beat.change.trim()) return `${bw} has no change`;
              if (additivePresent(beat.relationChange) && typeof beat.relationChange !== "string") {
                return `${bw} relationChange is not a string`;
              }
            }
          }
          if (!(e.episodeId === null || (typeof e.episodeId === "string" && e.episodeId))) {
            return `${ew} episodeId is invalid`;
          }
          // two planned episodes mapped to ONE entity would share a script
          // and fight over the title on every confirmation — reject
          if (e.episodeId !== null) {
            if (linked.has(e.episodeId)) return `${ew} reuses episodeId ${e.episodeId} within the plan`;
            linked.add(e.episodeId);
          }
        }
      }
      const pOk = (v) => v === 0 || (Number.isInteger(v) && st.plans.some((x) => x.v === v));
      if (!pOk(st.activePlan)) return "story activePlan pointer has no matching plan version";
      if (!pOk(st.confirmedPlan)) return "story confirmedPlan pointer has no matching plan version";
      // a CONFIRMED plan's entries are all episode-linked (confirmation stamps
      // every episodeId) — a "confirmed" save with unlinked entries would
      // claim planned episodes that have no script workspace to enter
      if (st.confirmedPlan !== 0) {
        const cp = st.plans.find((x) => x.v === st.confirmedPlan);
        if (cp && cp.episodes.some((e) => e.episodeId === null)) {
          return "confirmed episode plan has an entry with no linked episode";
        }
      }
    }
    // Since v10 the Creative Brief lives here: a WORKING DRAFT (autosaved,
    // unversioned) plus an append-only revision chain. Strict on every known
    // field for the same reason as the outline/plan chains above — anything
    // hydration would coerce or renumber is rejected instead, so an accepted
    // save never loses brief content on the load→save round-trip.
    if (atV10) {
      if (!isPlainObject(st.brief)) return "v10 story is missing its creative brief";
      const b = st.brief;
      const BRIEF_FIELDS = ["genre", "tone", "form", "episodeDuration", "totalDuration", "notes"];
      const epCount = (n) => n === null || (Number.isInteger(n) && n > 0 && n <= 50);
      const checkFields = (o, where) => {
        for (const k of BRIEF_FIELDS) {
          if (typeof o[k] !== "string") return `${where} ${k} is missing or not a string`;
        }
        if (!epCount(o.targetEpisodes)) return `${where} targetEpisodes is not null or an integer in 1..50`;
        return null;
      };
      if (!isPlainObject(b.draft)) return "creative brief draft is not an object";
      const draftErr = checkFields(b.draft, "creative brief draft");
      if (draftErr) return draftErr;
      if (!Array.isArray(b.versions)) return "creative brief versions is not an array";
      const cbIds = new Set();
      for (let i = 0; i < b.versions.length; i++) {
        const x = b.versions[i];
        const where = `creative brief v${i + 1}`;
        if (!isPlainObject(x)) return "creative brief versions contains a non-object entry";
        if (typeof x.id !== "string" || !x.id) return `${where} has no id`;
        if (cbIds.has(x.id)) return `duplicate creative brief id ${x.id}`;
        cbIds.add(x.id);
        if (x.v !== i + 1) return `${where} is not densely numbered`;
        // a revision is IMMUTABLE and self-contained: it carries the idea it
        // was taken with, so a downstream "based on brief vN" means one thing
        if (typeof x.idea !== "string") return `${where} idea is missing or not a string`;
        if (!isPlainObject(x.fields)) return `${where} has no fields object`;
        const fErr = checkFields(x.fields, where);
        if (fErr) return fErr;
        if (!["manual", "developed"].includes(x.origin)) return `${where} has invalid origin`;
        if (typeof x.instruction !== "string") return `${where} instruction is not a string`;
      }
      // 0 is always legal: a working draft with no formal revision yet
      if (!(b.active === 0 || (Number.isInteger(b.active) && b.versions.some((x) => x.v === b.active)))) {
        return "creative brief active pointer has no matching revision";
      }
      // every outline version's brief link is SHAPE-checked and, when set, must
      // resolve: it is an INTERNAL reference (same document), so a dangling one
      // is corrupt — unlike shot refs, which legitimately point outside.
      for (const x of Array.isArray(st.versions) ? st.versions : []) {
        if (!isPlainObject(x)) continue;
        if (x.briefVersionId === null || x.briefVersionId === undefined) continue;
        if (typeof x.briefVersionId !== "string" || !x.briefVersionId) {
          return `story outline v${x.v} briefVersionId is invalid`;
        }
        if (!cbIds.has(x.briefVersionId)) {
          return `story outline v${x.v} references unknown creative brief ${x.briefVersionId}`;
        }
      }
    }
  }
  if (doc.project !== undefined && typeof doc.project !== "string") {
    return "project is not a string";
  }
  // A v3 save ALWAYS carries the registry (the serializer emits it even when
  // empty). A v3 document missing `assets` is truncated — accepting it would
  // restore an empty registry and cement silent loss of all creator media on
  // the next save; fail safe instead.
  const atV3 = Number.isInteger(doc.v) && doc.v >= 3;
  const atV5 = Number.isInteger(doc.v) && doc.v >= 5;
  const atV11 = Number.isInteger(doc.v) && doc.v >= 11;
  // v11 declaration invariants (ADR-0055). A malformed declaration is rejected
  // rather than repaired on load: hydration WOULD normalize it, and a normalize
  // that silently drops a creator's tags / reusable mark / context links is the
  // same class of quiet loss the registry exists to prevent. `kind: null` is
  // valid and expected — unclassified is a real state, not a defect.
  const ASSET_KIND_SET = new Set(ASSET_KINDS);
  const LINK_KEY_SET = new Set(LINK_KEYS);
  const declarationError = (r, where, domain) => {
    if (r.kind !== null && r.kind !== undefined && !ASSET_KIND_SET.has(r.kind)) {
      return `assets ${where} has unknown kind ${JSON.stringify(r.kind)}`;
    }
    if (r.kind === undefined) return `assets ${where} has no kind field at v11`;
    // a declaration must be writable into the domain it lives in, or every
    // type filter downstream reports something the media cannot be. The rule is
    // asked of `assetreg` rather than re-derived here: a multi-domain kind
    // (`external-reference`, and the ADR-0061 directing references, which may be
    // a clip OR a still) has its own allowed SET, and duplicating that logic in
    // the validator is how the two come to disagree.
    if (r.kind && domain) {
      const bad = declarationDomainError(r.kind, domain);
      if (bad) return `assets ${where} declares ${r.kind} inside ${domain}`;
    }
    for (const k of ["displayName", "originalFilename"]) {
      if (r[k] !== null && typeof r[k] !== "string") return `assets ${where} ${k} is not a string or null`;
    }
    if (!isPlainObject(r.links)) return `assets ${where} links is not an object`;
    // EVERY canonical key must be present. Consumers read `links.sceneId` and
    // treat null as "not known"; a MISSING key reads as `undefined`, which is a
    // second, undeclared flavour of unknown that filters and comparisons handle
    // differently. Hydration always writes the full set, so requiring it here
    // rejects no genuine save.
    for (const k of LINK_KEYS) {
      if (!(k in r.links)) return `assets ${where} links is missing ${k}`;
    }
    for (const k of Object.keys(r.links)) {
      if (!LINK_KEY_SET.has(k)) return `assets ${where} links has unknown key ${k}`;
      const v = r.links[k];
      if (v !== null && (typeof v !== "string" || !v)) return `assets ${where} links.${k} is not a non-empty string or null`;
    }
    if (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string" || !t)) {
      return `assets ${where} tags is not a list of non-empty strings`;
    }
    if (typeof r.reusable !== "boolean") return `assets ${where} reusable is not a boolean`;
    if (typeof r.needsReview !== "boolean") return `assets ${where} needsReview is not a boolean`;
    return null;
  };
  const STORAGE_STATES = new Set(["local", "archived", "missing", "deleted"]);
  if (atV3 && !isPlainObject(doc.assets)) {
    return "v3 document is missing its assets registry";
  }
  // Since v5 the Project Generation Registry (top-level `generations`) is the
  // durable provenance source. A v5 save always emits it (even empty); a
  // truncated one missing it would restore empty and cement provenance loss.
  if (atV5 && !Array.isArray(doc.generations)) {
    return "v5 document is missing its generations registry";
  }
  if (doc.generations !== undefined && !Array.isArray(doc.generations)) {
    return "generations is not an array";
  }
  // v12 (CP3): the Skill Run registry. Same posture as `generations` — a v12
  // save always emits it, so an absent one is a truncated document that would
  // restore empty and cement the loss of every recorded AI run.
  const atV12 = Number.isInteger(doc.v) && doc.v >= 12;
  const atV15 = Number.isInteger(doc.v) && doc.v >= 15;
  if (atV12 && !Array.isArray(doc.skillRuns)) {
    return "v12 document is missing its skillRuns registry";
  }
  if (doc.skillRuns !== undefined && !Array.isArray(doc.skillRuns)) {
    return "skillRuns is not an array";
  }
  for (const r of Array.isArray(doc.skillRuns) ? doc.skillRuns : []) {
    if (!isPlainObject(r)) return "skillRuns contains a non-object entry";
    if (typeof r.skillRunId !== "string" || !r.skillRunId) return "a skill run has no skillRunId";
    if (typeof r.skillId !== "string" || !r.skillId) return `skill run ${r.skillRunId} has no skillId`;
    // the VERSION is what makes a run comparable later — a run that cannot say
    // which definition produced it is unusable as evidence for a revision
    if (!Number.isInteger(r.skillVersion) || r.skillVersion < 1) {
      return `skill run ${r.skillRunId} has no valid skillVersion`;
    }
    // A document is judged by ITS OWN version's vocabulary. A v12–v14 save
    // legitimately holds `proposed` / `accepted` / `rejected`, and a caller that
    // validates before migrating must not have those rejected as corruption
    // (codex review, round 22). v15 documents get the v15 set, and only that.
    const allowed = atV15 ? SKILL_RUN_STATUS_SET : LEGACY_SKILL_RUN_STATUSES;
    if (!allowed.has(r.status)) return `skill run ${r.skillRunId} has invalid status`;
    // The status↔proposal invariant, BOTH ways (v15). The domain transitions can
    // only produce these pairings, and a document carrying another one
    // misreports what the creator actually saw and decided:
    //
    //   succeeded  carries a proposal + a disposition — the answer landed
    //   failed     no proposal — a failure never becomes content
    //   cancelled  no proposal — the creator stopped it before an answer landed
    //   anything else (queued / running / awaiting_* / cancelling): not finished
    // The v15 pairing rules describe v15 records. A caller validating a v12–v14
    // document BEFORE migrating it would otherwise have its perfectly good
    // `proposed` / `accepted` / `rejected` runs rejected (codex review, round 22).
    if (!atV15) continue;
    const wantsProposal = r.status === "succeeded";
    if (wantsProposal && r.proposal == null) {
      return `skill run ${r.skillRunId} is ${r.status} but carries no proposal`;
    }
    if (!wantsProposal && r.proposal != null) {
      // `cancelled` is included, deliberately (codex review, round 4). An earlier
      // draft exempted it — the reasoning was that a run finishing DURING
      // cancellation keeps what it produced. That is true, but that output lives
      // on the BACKEND record (`runs.json`), not in the canvas as a Proposal:
      // a Proposal is something offered to the creator for a decision, and a
      // cancelled run is offering nothing. Exempting it let a document assert
      // both "I stopped this" and "here is its answer to judge".
      return `skill run ${r.skillRunId} is ${r.status} but carries a proposal`;
    }
    // The DISPOSITION is the second axis (ADR-0066 决策 8) and is REQUIRED on a
    // succeeded run. The proposal must therefore be a plain object — a
    // `proposal: []` carries no disposition, so nothing downstream can tell
    // whether the creator accepted it, and accepting such a record would store a
    // proposal that can never be acted on (codex review, rounds 4–7). The v15
    // migration wraps any non-object proposal precisely so this holds.
    if (wantsProposal) {
      if (!isPlainObject(r.proposal)) {
        return `skill run ${r.skillRunId} has a non-object proposal`;
      }
      if (!SKILL_RUN_DISPOSITION_SET.has(r.proposal.disposition)) {
        return `skill run ${r.skillRunId} has invalid proposal.disposition`;
      }
    }
    // v15 identity: `runId` is the same value as `skillRunId` (one id, a new
    // name). A DIFFERENT value would mean two identities for one run, and every
    // provenance edge would then be ambiguous.
    //
    // At v15 it is REQUIRED, not optional (codex review, round 17): the whole
    // point of the field is that the backend can be asked about this run, and
    // the migration sets it on every record — so a current-schema document
    // missing it is malformed, not merely old.
    if (atV15 && r.runId !== r.skillRunId) {
      return `skill run ${r.skillRunId} has a missing or conflicting runId`;
    }
    if (r.runId !== undefined && r.runId !== null && r.runId !== r.skillRunId) {
      return `skill run ${r.skillRunId} has a conflicting runId`;
    }
    // v14 (ADR-0059): the run's target context. `null` is VALID and means the
    // document never captured it — but a present context must be an object of
    // ids, because a malformed one would be rendered as a real provenance link.
    if (r.context !== undefined && r.context !== null && !isPlainObject(r.context)) {
      return `skill run ${r.skillRunId} has a non-object context`;
    }
    for (const k of ["episodeId", "sceneId", "shotId"]) {
      const v = isPlainObject(r.context) ? r.context[k] : undefined;
      if (v !== undefined && v !== null && (typeof v !== "string" || !v)) {
        return `skill run ${r.skillRunId} has an invalid context.${k}`;
      }
    }
    // …and a context object naming NOTHING is refused. The domain normaliser
    // collapses that case to `null` precisely so 「未记录」 stays distinguishable
    // from 「记录了，但是空的」; a document carrying the empty object instead
    // would render as a recorded context and silently suppress the unrecorded
    // state. Nothing this app writes produces it — only a corrupt or foreign
    // document can, and that is exactly what validation is for.
    if (isPlainObject(r.context)
      && !r.context.episodeId && !r.context.sceneId && !r.context.shotId) {
      return `skill run ${r.skillRunId} has a context naming nothing (use null for 未记录)`;
    }
  }
  // v14: a Generation's ORIGIN — which proposal launched it. `null`/absent is
  // valid (nothing recorded it, or it was not launched from one); a present
  // origin must name a real-looking run, because the graph draws an edge from it.
  for (const g of Array.isArray(doc.generations) ? doc.generations : []) {
    if (!isPlainObject(g) || g.origin === undefined || g.origin === null) continue;
    if (!isPlainObject(g.origin)) return `generation ${g.generationId} has a non-object origin`;
    for (const k of ["skillRunId", "proposalId"]) {
      const v = g.origin[k];
      if (v !== undefined && v !== null && (typeof v !== "string" || !v)) {
        return `generation ${g.generationId} has an invalid origin.${k}`;
      }
    }
    // The RUN is what anchors an origin. A proposal id with no run names an
    // answer with no record of who was asked, and an empty origin claims a
    // launch that names nothing at all — both would render as lineage. `null`
    // remains the way to say there was none.
    if (!g.origin.skillRunId || !g.origin.proposalId) {
      return `generation ${g.generationId} has a half origin (both ids, or null for 未记录)`;
    }
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
      // assetId → {slot, version, url, digest, kind} — legit reuse targets.
      // `kind` is carried because a `derived-frame` (TASK-064 §7) is allowed to be
      // bound as a first frame on a DIFFERENT slot; see the firstFrames check.
      const imageById = new Map();
      const claim = (id, where, rec, slot) => {
        if (typeof id !== "string" || !id) return `assets ${where} has no assetId`;
        if (ids.has(id)) return `assets ${where} has duplicate assetId ${id}`;
        ids.add(id);
        if (rec) imageById.set(id, { slot, version: rec.version, url: rec.url, digest: rec.digest, kind: rec.kind });
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
            // v5 storage lifecycle: byte availability is explicit and decoupled
            // from identity (the url stays as the last-known location even when
            // bytes are archived/missing/deleted).
            if (atV5 && !STORAGE_STATES.has(r.storageState)) return `assets.${k}[${slot}] history record has invalid storageState`;
            if (atV11) {
              const derr = declarationError(r, `${k}[${slot}] history record`, k);
              if (derr) return derr;
            }
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
        if (atV5 && !STORAGE_STATES.has(f.storageState)) return "assets.finals record has invalid storageState";
        if (atV11) {
          const derr = declarationError(f, "finals record", "finals");
          if (derr) return derr;
        }
      }
      const ff = doc.assets.firstFrames;
      // standalone (non-image-alias) first-frame ids ARE durable Assets a video
      // generation can legitimately take as input — collected here so the
      // generation link check below accepts them (hoisted so it stays in scope
      // even when there are no first frames).
      const standaloneFrameIds = new Set();
      if (isPlainObject(ff)) {
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
          if (atV5 && !STORAGE_STATES.has(r.storageState)) return `assets.firstFrames[${slot}] reference has invalid storageState`;
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
            // TASK-064 Phase 2 §7 introduced a SECOND legitimate origin for a
            // first frame: a `derived-frame` cut out of ANOTHER shot's video
            // (上一镜尾帧 → 下一镜首帧). Such an image lives on its own
            // `frame-<uuid>` chain by construction, so requiring `src.slot === slot`
            // refused it — and because this validator fails the whole document,
            // binding one made the entire canvas unloadable and blocked saving.
            //
            // The rule this check exists for is unchanged: an image must not have
            // its identity glued onto DIFFERENT bytes. So every media check still
            // applies (version, url, digest, the frame's own slot_id) — only the
            // same-slot requirement is waived, and only for the one declared kind
            // whose entire purpose is to be bound to a different shot.
            const isDerivedFrame = src.kind === "derived-frame";
            const slotMismatch = !isDerivedFrame && src.slot !== slot;
            if (slotMismatch || r.version !== src.version || r.url !== src.url || digestConflict || slotIdConflict) {
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
      // v5 Generation Registry: every record is well-formed, uniquely
      // identified, and its asset links reference REAL Assets in this registry
      // (`ids` = every durable history + final assetId). A dangling link is
      // unprovable lineage; a deleted-bytes Asset still keeps its record + id
      // (only its storageState changes), so provenance survives byte removal.
      if (atV5) {
        // v9 adds the non-AI "render" provenance type (local FFmpeg episode
        // renders) — earlier versions never legitimately carry it
        const GEN_TYPES = Number.isInteger(doc.v) && doc.v >= 9
          ? new Set(["image", "video", "audio", "render"])
          : new Set(["image", "video", "audio"]);
        const GEN_STATUSES = new Set(["queued", "generating", "success", "failed", "cancelled"]);
        const genIds = new Set();
        for (const g of doc.generations) {
          if (!isPlainObject(g)) return "generations contains a non-object entry";
          if (typeof g.generationId !== "string" || !g.generationId) return "a generation has no generationId";
          if (genIds.has(g.generationId)) return `duplicate generationId ${g.generationId}`;
          genIds.add(g.generationId);
          if (!GEN_TYPES.has(g.type)) return `generation ${g.generationId} has invalid type`;
          if (!GEN_STATUSES.has(g.status)) return `generation ${g.generationId} has invalid status`;
          // a Shot-level generation targets the canonical creativeShotId — never
          // a slot. Only 'shot' (or null) is a valid targetType; targetId is a
          // non-empty id or null. This rejects e.g. targetType:"slot".
          if (g.targetType !== null && g.targetType !== "shot") return `generation ${g.generationId} has invalid targetType`;
          if (g.targetId !== null && (typeof g.targetId !== "string" || !g.targetId)) return `generation ${g.generationId} has invalid targetId`;
          // type and id must AGREE — a 'shot' target needs an id, and an id needs
          // a 'shot' type — else the shot provenance is ambiguous or unusable
          if ((g.targetType === "shot") !== (g.targetId !== null)) return `generation ${g.generationId} has inconsistent target (targetType/targetId must agree)`;
          for (const field of ["inputAssetIds", "referenceAssetIds", "resultAssetIds"]) {
            if (!Array.isArray(g[field])) return `generation ${g.generationId} ${field} is not an array`;
            for (const aid of g[field]) {
              if (typeof aid !== "string" || !aid) return `generation ${g.generationId} ${field} has a non-string id`;
              // SHAPE only — a link is NOT required to resolve to a currently
              // present Asset. Provenance legitimately OUTLIVES an Asset whose
              // record was removed (Remove-Local-Copy / replace / permanent
              // delete); requiring resolution would make removing ONE Asset
              // reject the WHOLE canvas (M5: Generation metadata ≠ media
              // lifecycle). Corrupt fabricated links are the accepted trade-off.
            }
          }
        }
      }
    }
  }
  // Since v6 the Production domain document (top-level `production`) owns the
  // Episode/Scene structure. A v6 save always emits it (even for a fresh
  // canvas); a truncated one missing it would restore the default structure
  // and cement loss of the creator's episode/scene organization on next save.
  const atV6 = Number.isInteger(doc.v) && doc.v >= 6;
  if (atV6 && !isPlainObject(doc.production)) {
    return "v6 document is missing its production structure";
  }
  if (doc.production !== undefined) {
    if (!isPlainObject(doc.production)) return "production is not an object";
    const p = doc.production;
    if (!Array.isArray(p.episodes)) return "production.episodes is not an array";
    // Since v7 the Production Bible (characters/locations + scene references)
    // lives inside the production document. Entities are validated FIRST so
    // scene references can be checked against them below.
    const atV7 = Number.isInteger(doc.v) && doc.v >= 7;
    const charStates = new Map(); // characterId → Set(stateId)
    const locStates = new Map(); // locationId → Set(stateId)
    if (atV7) {
      const bibleStateIds = new Set();
      const checkRefs = (e, where) => {
        if (!Array.isArray(e.referenceAssetIds)) return `${where} referenceAssetIds is not an array`;
        for (const id of e.referenceAssetIds) {
          if (typeof id !== "string" || !id) return `${where} has a non-string reference asset id`;
        }
        // duplicates render twice and one removal deletes every copy —
        // hydration would dedupe (data change), so reject instead
        if (new Set(e.referenceAssetIds).size !== e.referenceAssetIds.length) {
          return `${where} has duplicate reference asset ids`;
        }
        // the active pointer must be one of the entity's own references (or
        // null) — an active ref outside the list is meaningless dead data.
        // SHAPE only vs the Asset registry: like Generation links (M5), a
        // bible reference legitimately outlives the Asset's bytes/record.
        if (e.activeReferenceAssetId !== null && !e.referenceAssetIds.includes(e.activeReferenceAssetId)) {
          return `${where} activeReferenceAssetId is not one of its references`;
        }
        return null;
      };
      // Override values are validated EXACTLY as strictly as hydration
      // (bibledoc.sanitizeOverrides) consumes them: any key or value shape
      // hydration would drop or coerce is REJECTED here instead — an accepted
      // save must never silently lose data on the next load→save round-trip.
      const idList = (v) =>
        Array.isArray(v) && v.every((x) => typeof x === "string" && x) && new Set(v).size === v.length;
      const checkStates = (entity, where, facetKeys) => {
        if (!Array.isArray(entity.states)) return `${where} states is not an array`;
        for (const s of entity.states) {
          if (!isPlainObject(s)) return `${where} states contains a non-object entry`;
          if (typeof s.stateId !== "string" || !s.stateId) return `${where} has a state with no stateId`;
          if (bibleStateIds.has(s.stateId)) return `duplicate stateId ${s.stateId}`;
          bibleStateIds.add(s.stateId);
          if (typeof s.name !== "string") return `state ${s.stateId} has no name string`;
          if (!isPlainObject(s.overrides)) return `state ${s.stateId} overrides is not an object`;
          const o = s.overrides;
          for (const k of Object.keys(o)) {
            if (k === "voice") {
              if (!facetKeys.includes("voice")) return `state ${s.stateId} has unknown override "voice"`;
              // VOICE RULE: a state may modify performance characteristics but
              // never carries its own voice IDENTITY — same character, same voice.
              if (!isPlainObject(o.voice)) return `state ${s.stateId} voice override is not an object`;
              for (const vk of Object.keys(o.voice)) {
                if (vk === "voiceId") return `state ${s.stateId} overrides the voice identity (voiceId) — states must keep the base voice`;
                if (vk === "description") {
                  if (typeof o.voice.description !== "string") return `state ${s.stateId} voice description override is not a string`;
                } else if (vk === "performance") {
                  if (!isPlainObject(o.voice.performance)) return `state ${s.stateId} voice performance override is not an object`;
                } else {
                  return `state ${s.stateId} has unknown voice override "${vk}"`;
                }
              }
            } else if (k === "referenceAssetIds") {
              if (!idList(o.referenceAssetIds)) return `state ${s.stateId} referenceAssetIds override is not a list of ids`;
            } else if (k === "activeReferenceAssetId") {
              // a state's active ref must live in the state's OWN override list
              if (o.activeReferenceAssetId !== null) {
                if (typeof o.activeReferenceAssetId !== "string") return `state ${s.stateId} activeReferenceAssetId override is not an id`;
                if (!Array.isArray(o.referenceAssetIds) || !o.referenceAssetIds.includes(o.activeReferenceAssetId)) {
                  return `state ${s.stateId} activeReferenceAssetId is not in its override references`;
                }
              }
            } else if (facetKeys.includes(k)) {
              if (typeof o[k] !== "string") return `state ${s.stateId} override "${k}" is not a string`;
            } else {
              return `state ${s.stateId} has unknown override "${k}"`;
            }
          }
        }
        return null;
      };
      // base facets: hydration coerces non-strings — reject them instead
      const checkProfile = (entity, where, fields) => {
        for (const k of fields) {
          if (typeof entity.profile[k] !== "string") return `${where} profile ${k} is missing or not a string`;
        }
        return null;
      };
      // Character/Location ids share ONE namespace: entity lookups (e.g. the
      // reference-asset ops) resolve by id across both kinds, so a cross-kind
      // collision would silently address the wrong entity.
      const CHAR_FACETS = ["appearance", "costume", "visualInstruction", "voice"];
      const LOC_FACETS = ["description", "visualInstruction"];
      if (!Array.isArray(p.characters)) return "production.characters is missing or not an array";
      for (const c of p.characters) {
        if (!isPlainObject(c)) return "production.characters contains a non-object entry";
        if (typeof c.characterId !== "string" || !c.characterId) return "a character has no characterId";
        if (charStates.has(c.characterId)) return `duplicate characterId ${c.characterId}`;
        if (typeof c.name !== "string") return `character ${c.characterId} has no name string`;
        // v10: 正式角色 / 临时角色. Hydration coerces an unknown tier to
        // "formal", so an invalid persisted value is rejected instead — a
        // silently promoted bit part is a data change.
        if (atV10 && c.tier !== "formal" && c.tier !== "bit") {
          return `character ${c.characterId} has invalid tier`;
        }
        if (!isPlainObject(c.profile)) return `character ${c.characterId} has no profile object`;
        if (!isPlainObject(c.voice)) return `character ${c.characterId} has no voice profile`;
        if (c.voice.voiceId !== null && (typeof c.voice.voiceId !== "string" || !c.voice.voiceId)) {
          return `character ${c.characterId} has an invalid base voiceId`;
        }
        if (typeof c.voice.description !== "string") return `character ${c.characterId} voice description is missing or not a string`;
        if (!isPlainObject(c.voice.performance)) return `character ${c.characterId} voice performance is missing or not an object`;
        // v10 adds the creative-layer facets (身份 / 欲望 / 弱点 / 核心矛盾 /
        // Character Arc) — none of them state-overridable, so CHAR_FACETS is
        // deliberately unchanged: a state is the same person.
        const PROFILE_FIELDS = atV10
          ? ["appearance", "costume", "personality", "visualInstruction", "identity", "desire", "weakness", "coreConflict", "arc"]
          : ["appearance", "costume", "personality", "visualInstruction"];
        const err = checkProfile(c, `character ${c.characterId}`, PROFILE_FIELDS)
          || checkRefs(c, `character ${c.characterId}`)
          || checkStates(c, `character ${c.characterId}`, CHAR_FACETS);
        if (err) return err;
        charStates.set(c.characterId, new Set(c.states.map((s) => s.stateId)));
      }
      if (!Array.isArray(p.locations)) return "production.locations is missing or not an array";
      for (const l of p.locations) {
        if (!isPlainObject(l)) return "production.locations contains a non-object entry";
        if (typeof l.locationId !== "string" || !l.locationId) return "a location has no locationId";
        if (locStates.has(l.locationId) || charStates.has(l.locationId)) return `duplicate locationId ${l.locationId}`;
        if (typeof l.name !== "string") return `location ${l.locationId} has no name string`;
        if (!isPlainObject(l.profile)) return `location ${l.locationId} has no profile object`;
        const err = checkProfile(l, `location ${l.locationId}`, ["description", "visualInstruction"])
          || checkRefs(l, `location ${l.locationId}`)
          || checkStates(l, `location ${l.locationId}`, LOC_FACETS);
        if (err) return err;
        locStates.set(l.locationId, new Set(l.states.map((s) => s.stateId)));
      }
    }
    // Since v13 the production document owns SHOT PRODUCTION state: the
    // creator's review approvals and the canonical References each shot uses.
    // Both are keyed by creativeShotId; both are deliberately sparse (only
    // shots with something recorded appear).
    const atV13 = Number.isInteger(doc.v) && doc.v >= 13;
    if (atV13) {
      const sp = p.shotProduction;
      if (!isPlainObject(sp)) return "production.shotProduction is missing or not an object";
      if (!isPlainObject(sp.reviews)) return "production.shotProduction.reviews is not an object";
      if (!isPlainObject(sp.references)) return "production.shotProduction.references is not an object";
      for (const shotId of Object.keys(sp.reviews)) {
        const r = sp.reviews[shotId];
        if (!isPlainObject(r)) return `shot review ${shotId} is not an object`;
        // ONLY approvals are stored. `approved: false` would claim the creator
        // actively rejected the shot, which is a different (unrecorded) thing —
        // "not approved" is the ABSENCE of a record.
        if (r.approved !== true) return `shot review ${shotId} is not an approval`;
        // an approval must say WHICH video it was given for, or it could only
        // ever be applied to footage nobody reviewed
        if (typeof r.assetId !== "string" || !r.assetId) {
          return `shot review ${shotId} does not name the video it approved`;
        }
        if (r.approvedAt !== null && typeof r.approvedAt !== "string") {
          return `shot review ${shotId} has an invalid approvedAt`;
        }
        if (typeof r.note !== "string") return `shot review ${shotId} has no note string`;
      }
      for (const shotId of Object.keys(sp.references)) {
        const list = sp.references[shotId];
        if (!Array.isArray(list) || !list.length) {
          return `shot references ${shotId} is not a non-empty array`;
        }
        const seen = new Set();
        for (const k of list) {
          if (typeof k !== "string" || !k) return `shot references ${shotId} has an empty key`;
          // a duplicated key would render the same reference chip twice and
          // double-count the reference's usage
          if (seen.has(k)) return `shot references ${shotId} repeats ${k}`;
          seen.add(k);
        }
      }
    }
    // Since v10 the production document also owns project-level CANON:
    // relationships between characters, the World Setting, and one revision
    // number per canon surface. Validated BEFORE the episode loop so episode
    // beats can be checked against real relationship ids.
    const relIds = new Set();
    if (atV10) {
      const RELATIONSHIP_FIELDS = ["basis", "aToB", "bToA", "coreConflict", "tension", "power", "history", "secrets", "direction", "arc", "forbidden"];
      const WORLD_FIELDS = ["era", "rules", "society", "regions", "places", "visualTone", "atmosphere"];
      if (!Array.isArray(p.relationships)) return "production.relationships is missing or not an array";
      const pairs = new Set();
      for (const r of p.relationships) {
        if (!isPlainObject(r)) return "production.relationships contains a non-object entry";
        if (typeof r.relationshipId !== "string" || !r.relationshipId) return "a relationship has no relationshipId";
        if (relIds.has(r.relationshipId)) return `duplicate relationshipId ${r.relationshipId}`;
        relIds.add(r.relationshipId);
        // EXACTLY two distinct, EXISTING characters — hydration drops anything
        // else, so an accepted save must not carry a relationship that would
        // vanish (or silently change shape) on the next load
        if (!Array.isArray(r.characterIds) || r.characterIds.length !== 2) {
          return `relationship ${r.relationshipId} does not link exactly two characters`;
        }
        const [a, b] = r.characterIds;
        for (const id of [a, b]) {
          if (typeof id !== "string" || !id) return `relationship ${r.relationshipId} has a non-string character id`;
          if (!charStates.has(id)) return `relationship ${r.relationshipId} references unknown character ${JSON.stringify(id)}`;
        }
        if (a === b) return `relationship ${r.relationshipId} links a character to itself`;
        // one definition per unordered pair: 林照×沈既白 and 沈既白×林照 are the
        // same relationship, and two records would fight over the same canon.
        // The key comes from the DOMAIN (canondoc.pairKey), not a local join:
        // a characterId is an arbitrary string, so a delimiter-joined key would
        // collide on ids containing that delimiter and REJECT a document
        // hydration accepts — blocking a legitimate save. Shared for the same
        // reason MAX_CLIP_* is imported above: validation must never disagree
        // with the rule the domain actually applies.
        const key = pairKey(a, b);
        if (pairs.has(key)) return `duplicate relationship for the same character pair (${r.relationshipId})`;
        pairs.add(key);
        if (!isPlainObject(r.profile)) return `relationship ${r.relationshipId} has no profile object`;
        for (const k of RELATIONSHIP_FIELDS) {
          if (typeof r.profile[k] !== "string") return `relationship ${r.relationshipId} profile ${k} is missing or not a string`;
        }
      }
      if (!isPlainObject(p.world)) return "production.world is missing or not an object";
      for (const k of WORLD_FIELDS) {
        if (typeof p.world[k] !== "string") return `production.world ${k} is missing or not a string`;
      }
      if (!isPlainObject(p.canon)) return "production.canon is missing or not an object";
      for (const k of ["characters", "relationships", "world"]) {
        if (!Number.isInteger(p.canon[k]) || p.canon[k] < 0) return `production.canon.${k} is not a non-negative integer`;
      }
    }
    if (atV6) {
      // v6 structural invariants: at least one episode (the shell's current-
      // episode context), unique non-empty ids, scenes referencing each shot
      // at most ONCE project-wide (a shot in two scenes is ambiguous
      // ownership). Scene shotIds are canonical creativeShotIds and are NOT
      // required to resolve to a current draft shot: structure legitimately
      // outlives a regenerated draft (dangling refs display as unresolved).
      if (!p.episodes.length) return "production has no episodes";
      const epIds = new Set();
      const sceneIds = new Set();
      const shotRefs = new Set();
      const atV9 = Number.isInteger(doc.v) && doc.v >= 9;
      const assetRefOk = (v) => v === null || (typeof v === "string" && v);
      for (const e of p.episodes) {
        if (!isPlainObject(e)) return "production.episodes contains a non-object entry";
        if (typeof e.episodeId !== "string" || !e.episodeId) return "an episode has no episodeId";
        if (epIds.has(e.episodeId)) return `duplicate episodeId ${e.episodeId}`;
        epIds.add(e.episodeId);
        if (typeof e.title !== "string") return `episode ${e.episodeId} has no title string`;
        // SOFT ARCHIVE (ADR-0072 决策 4 / TASK-094 批次 G). Additive, by the rule
        // `additivePresent` states: absent/null is every document written before it,
        // and present-but-wrong rejects the WHOLE document — hydration degrades a
        // malformed value to 「not archived」, so accepting one would make an episode
        // reappear on the next load with nothing saying why. No version bump.
        if (additivePresent(e.archived)) {
          if (!isPlainObject(e.archived)) return `episode ${e.episodeId} archived is not an object`;
          if (typeof e.archived.at !== "string" || !e.archived.at.trim()) {
            return `episode ${e.episodeId} archived.at is missing`;
          }
          if (additivePresent(e.archived.reason) && typeof e.archived.reason !== "string") {
            return `episode ${e.episodeId} archived.reason is not a string`;
          }
          // THE ONE IN HAND IS NEVER ARCHIVED. `activeEpisodeId` pointing at an
          // archived episode is a document whose current episode is not shown
          // anywhere — the state `archiveEpisode` refuses to create.
          if (p.activeEpisodeId === e.episodeId) {
            return `episode ${e.episodeId} is archived but is also activeEpisodeId`;
          }
        }
        // v9: episode BGM reference — SHAPE only vs the audio registry (a
        // music asset legitimately outlives its bytes, like bible refs)
        if (atV9 && !assetRefOk(e.bgmAssetId)) return `episode ${e.episodeId} bgmAssetId is invalid`;
        // v10: the episode as an ARC unit — beats + the upstream version stamp.
        // Beat references are INTERNAL (same document) so they must resolve;
        // hydration drops dangling ones, so an accepted save must not have any.
        if (atV10) {
          if (!isPlainObject(e.beats)) return `episode ${e.episodeId} is missing its beats`;
          for (const k of ["plot", "world"]) {
            if (!Array.isArray(e.beats[k])) return `episode ${e.episodeId} beats.${k} is not an array`;
            for (const t of e.beats[k]) {
              if (typeof t !== "string") return `episode ${e.episodeId} beats.${k} has a non-string entry`;
            }
          }
          if (!Array.isArray(e.beats.character)) return `episode ${e.episodeId} beats.character is not an array`;
          const beatChars = new Set();
          for (const b of e.beats.character) {
            if (!isPlainObject(b)) return `episode ${e.episodeId} beats.character has a non-object entry`;
            if (typeof b.characterId !== "string" || !charStates.has(b.characterId)) {
              return `episode ${e.episodeId} character beat references unknown character ${JSON.stringify(b.characterId)}`;
            }
            // hydration keeps the LAST write per character, so two beats for one
            // character would silently lose one — reject instead
            if (beatChars.has(b.characterId)) return `episode ${e.episodeId} has two beats for character ${b.characterId}`;
            beatChars.add(b.characterId);
            if (typeof b.beat !== "string") return `episode ${e.episodeId} character beat is not a string`;
          }
          if (!Array.isArray(e.beats.relationship)) return `episode ${e.episodeId} beats.relationship is not an array`;
          const beatRels = new Set();
          for (const b of e.beats.relationship) {
            if (!isPlainObject(b)) return `episode ${e.episodeId} beats.relationship has a non-object entry`;
            if (typeof b.relationshipId !== "string" || !relIds.has(b.relationshipId)) {
              return `episode ${e.episodeId} relationship beat references unknown relationship ${JSON.stringify(b.relationshipId)}`;
            }
            if (beatRels.has(b.relationshipId)) return `episode ${e.episodeId} has two beats for relationship ${b.relationshipId}`;
            beatRels.add(b.relationshipId);
            for (const k of ["start", "event", "end"]) {
              if (typeof b[k] !== "string") return `episode ${e.episodeId} relationship beat ${k} is not a string`;
            }
          }
          if (!isPlainObject(e.basedOn)) return `episode ${e.episodeId} is missing its basedOn stamp`;
          for (const k of ["brief", "outline", "characters", "relationships", "world"]) {
            if (!Number.isInteger(e.basedOn[k]) || e.basedOn[k] < 0) {
              return `episode ${e.episodeId} basedOn.${k} is not a non-negative integer`;
            }
          }
        }
        if (!Array.isArray(e.scenes)) return `episode ${e.episodeId} scenes is not an array`;
        for (const s of e.scenes) {
          if (!isPlainObject(s)) return `episode ${e.episodeId} scenes contains a non-object entry`;
          if (typeof s.sceneId !== "string" || !s.sceneId) return "a scene has no sceneId";
          if (sceneIds.has(s.sceneId)) return `duplicate sceneId ${s.sceneId}`;
          sceneIds.add(s.sceneId);
          if (typeof s.title !== "string") return `scene ${s.sceneId} has no title string`;
          if (!Array.isArray(s.shotIds)) return `scene ${s.sceneId} shotIds is not an array`;
          for (const id of s.shotIds) {
            if (typeof id !== "string" || !id) return `scene ${s.sceneId} has a non-string shot reference`;
            if (shotRefs.has(id)) return `shot ${id} is referenced by more than one scene`;
            shotRefs.add(id);
          }
          // v9 audio references — shape-only asset refs, required present
          if (atV9) {
            if (!assetRefOk(s.ambienceAssetId)) return `scene ${s.sceneId} ambienceAssetId is invalid`;
            if (!assetRefOk(s.bgmAssetId)) return `scene ${s.sceneId} bgmAssetId is invalid`;
          }
          // v7 bible references: INTERNAL to this document, so they must
          // resolve — a ref to a missing character/location/state is corrupt
          // (domain ops refuse removals while referenced), unlike shot refs
          // which point outside the document and may legitimately dangle.
          if (atV7) {
            // ID-ONLY reference contract: a scene ref carries EXACTLY the
            // entity id + state id, nothing else — an extra field would be
            // dropped by hydration (accepted save loses data) and could
            // smuggle embedded profile copies past the never-duplicate rule.
            const idOnly = (r, idKey, where) => {
              for (const k of Object.keys(r)) {
                if (k !== idKey && k !== "stateId") return `${where} has unknown field "${k}" (references are id-only)`;
              }
              if (!("stateId" in r)) return `${where} is missing stateId`;
              return null;
            };
            if (!Array.isArray(s.characterRefs)) return `scene ${s.sceneId} characterRefs is not an array`;
            const seenChars = new Set();
            for (const r of s.characterRefs) {
              if (!isPlainObject(r)) return `scene ${s.sceneId} characterRefs contains a non-object entry`;
              const shapeErr = idOnly(r, "characterId", `scene ${s.sceneId} character reference`);
              if (shapeErr) return shapeErr;
              if (!charStates.has(r.characterId)) return `scene ${s.sceneId} references unknown character ${JSON.stringify(r.characterId)}`;
              if (seenChars.has(r.characterId)) return `scene ${s.sceneId} references character ${r.characterId} twice`;
              seenChars.add(r.characterId);
              if (r.stateId !== null && !charStates.get(r.characterId).has(r.stateId)) {
                return `scene ${s.sceneId} references unknown state ${JSON.stringify(r.stateId)} of character ${r.characterId}`;
              }
            }
            // the field itself is REQUIRED at v7 (migration/serializer always
            // emit it) — accepting an absent key would let a truncated scene
            // pass as "no location" instead of failing safe
            if (s.locationRef === undefined) return `scene ${s.sceneId} is missing locationRef`;
            if (s.locationRef !== null) {
              const r = s.locationRef;
              if (!isPlainObject(r)) return `scene ${s.sceneId} locationRef is not an object`;
              const shapeErr = idOnly(r, "locationId", `scene ${s.sceneId} locationRef`);
              if (shapeErr) return shapeErr;
              if (!locStates.has(r.locationId)) return `scene ${s.sceneId} references unknown location ${JSON.stringify(r.locationId)}`;
              if (r.stateId !== null && !locStates.get(r.locationId).has(r.stateId)) {
                return `scene ${s.sceneId} references unknown state ${JSON.stringify(r.stateId)} of location ${r.locationId}`;
              }
            }
          }
        }
      }
      if (typeof p.activeEpisodeId !== "string" || !epIds.has(p.activeEpisodeId)) {
        return "production.activeEpisodeId does not reference an episode";
      }
    }
  }
  // Since v9 per-episode timelines are durable (top-level `timelines` map).
  // Clips REFERENCE assets by id (shape-only — the registry stays the single
  // media source of truth; a clip whose asset lost its bytes shows honestly).
  const atV9top = Number.isInteger(doc.v) && doc.v >= 9;
  if (atV9top && !isPlainObject(doc.timelines)) return "v9 document is missing its timelines map";
  if (doc.timelines !== undefined) {
    if (!isPlainObject(doc.timelines)) return "timelines is not an object";
    // IMPORTED, not re-listed. A second copy of the track vocabulary was one
    // edit away from rejecting a document the domain had just written — which is
    // the worst failure mode this validator has, because it blocks the save
    // rather than the load. TASK-064 Phase 3 added `foley` and `vo`.
    const TRACKS = new Set(TIMELINE_TRACKS);
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    for (const k of Object.keys(doc.timelines)) {
      if (typeof k !== "string" || !k) return "timelines has an empty episode key";
      const t = doc.timelines[k];
      if (!isPlainObject(t)) return `timelines[${k}] is not an object`;
      if (!atV9top) continue;
      if (typeof t.edited !== "boolean") return `timelines[${k}] edited flag is missing or not a boolean`;
      if (!isPlainObject(t.settings)) return `timelines[${k}] settings is not an object`;
      // render settings the creator chose must survive the round-trip EXACTLY
      // and must be RENDERABLE: the bounds match the render endpoint's, so a
      // persisted setting can never disagree with what the server would render
      // (it would otherwise silently default an out-of-range value). Fail safe
      // — a save is rejected rather than mutated.
      const st = t.settings;
      const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
      if (!inRange(st.width, 16, 3840) || !inRange(st.height, 16, 2160)) return `timelines[${k}] settings width/height are invalid`;
      if (!inRange(st.fps, 1, 60)) return `timelines[${k}] settings fps is invalid`;
      if (st.format !== "mp4" && st.format !== "webm") return `timelines[${k}] settings format is invalid`;
      if (!Array.isArray(t.clips)) return `timelines[${k}] clips is not an array`;
      const clipIds = new Set();
      for (const c of t.clips) {
        if (!isPlainObject(c)) return `timelines[${k}] clips contains a non-object entry`;
        if (typeof c.clipId !== "string" || !c.clipId) return `timelines[${k}] has a clip with no clipId`;
        if (clipIds.has(c.clipId)) return `timelines[${k}] has duplicate clipId ${c.clipId}`;
        clipIds.add(c.clipId);
        if (!TRACKS.has(c.trackType)) return `clip ${c.clipId} has invalid trackType`;
        if (typeof c.assetId !== "string" || !c.assetId) return `clip ${c.clipId} has no assetId`;
        if (!(c.shotId === null || (typeof c.shotId === "string" && c.shotId))) return `clip ${c.clipId} shotId is invalid`;
        // start/fade upper bounds are SHARED with the domain + render caps
        // (imported MAX_CLIP_*), so a persisted clip can never hold a value the
        // render would reject — no "valid-looking edit that cannot render".
        if (!num(c.startTime) || c.startTime < 0 || c.startTime > MAX_CLIP_START) return `clip ${c.clipId} startTime is invalid`;
        if (!num(c.trimIn) || c.trimIn < 0) return `clip ${c.clipId} trimIn is invalid`;
        if (!num(c.trimOut) || c.trimOut <= c.trimIn) return `clip ${c.clipId} trimOut must exceed trimIn`;
        if (!num(c.volume) || c.volume < 0 || c.volume > 2) return `clip ${c.clipId} volume must be 0..2`;
        if (typeof c.muted !== "boolean") return `clip ${c.clipId} muted is not a boolean`;
        if (!num(c.fadeIn) || c.fadeIn < 0 || c.fadeIn > MAX_CLIP_FADE) return `clip ${c.clipId} fadeIn is invalid`;
        if (!num(c.fadeOut) || c.fadeOut < 0 || c.fadeOut > MAX_CLIP_FADE) return `clip ${c.clipId} fadeOut is invalid`;
        // TASK-064 Phase 3 fields. Each is checked only when PRESENT: a v14
        // document written before this checkpoint carries none of them, and
        // requiring them would refuse to load every existing save. The domain
        // sanitizer supplies the defaults on hydrate.
        if (c.assetVersion !== undefined && c.assetVersion !== null && !Number.isInteger(c.assetVersion)) {
          return `clip ${c.clipId} assetVersion is invalid`;
        }
        if (c.removed !== undefined && typeof c.removed !== "boolean") return `clip ${c.clipId} removed is not a boolean`;
        if (c.origin !== undefined && c.origin !== "auto" && c.origin !== "manual") {
          return `clip ${c.clipId} origin is invalid`;
        }
      }
    }
  }
  // --- v16: the project-level delivery spec (TASK-073 §1.7) ---------------- //
  //
  // Validated STRUCTURALLY only: it must be an object, and any field it does carry
  // must be one of the fourteen with a value of the right shape. It is NOT required
  // to be complete — an empty spec is the honest state of every project that has not
  // been configured, and rejecting the document for that would make a brand-new
  // project unloadable.
  // NO SCHEMA BUMP. `deliverySpec` is purely ADDITIVE and OPTIONAL, exactly like
  // refInterp / refUse / frameBindings / locks / shotAudio / subtitles / ctxCache: a
  // document written before it simply carries none of it and hydrates empty, so there
  // is nothing to back-fill and no migration to run. An earlier draft of this made it
  // a required v16 field, which would have rejected every hand-written and historical
  // document that omits it — a breaking change bought for nothing.
  if (additivePresent(doc.deliverySpec)) {
    if (!isPlainObject(doc.deliverySpec)) return "deliverySpec is not an object";
    const ENUMS = {
      platform: ["douyin", "kuaishou", "bilibili", "youtube", "other"],
      aspect: ["9:16", "16:9", "1:1", "4:5"],
      resolution: ["1080x1920", "720x1280", "1920x1080", "1280x720"],
      subtitleMode: ["srt", "burned", "none"],
      subtitleLang: ["zh", "en", "zh+en", "none"],
      container: ["mp4", "webm"],
    };
    const INTS = {
      fps: [1, 60], episodeSeconds: [1, 36000], episodeTarget: [1, 999],
      videoBitrateKbps: [100, 200000], audioBitrateKbps: [32, 512], retryCap: [0, 100],
    };
    const MONEY = { budgetTotalUsd: [0, 1000000], perGenerationCapUsd: [0, 100000] };
    for (const k of Object.keys(doc.deliverySpec)) {
      const v = doc.deliverySpec[k];
      if (v === null) continue; // explicitly 「未设置」
      if (ENUMS[k]) {
        if (!ENUMS[k].includes(v)) return `deliverySpec.${k} is not one of its allowed values`;
      } else if (INTS[k]) {
        if (!Number.isInteger(v) || v < INTS[k][0] || v > INTS[k][1]) {
          return `deliverySpec.${k} is out of range`;
        }
      } else if (MONEY[k]) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < MONEY[k][0] || v > MONEY[k][1]) {
          return `deliverySpec.${k} is out of range`;
        }
      } else {
        // An UNRECOGNISED key is kept, not rejected: a future build's field must not
        // make this build refuse the whole document (the same posture `extras` takes
        // in persist.js). It is simply not interpreted here.
        continue;
      }
    }
  }

  // --- the top-level review record (系统合同 §6 / TASK-084 项 2) -------------- //
  //
  // THE SAME RULE `deliverySpec` FOLLOWS — see `additivePresent` above, which both
  // fields now call rather than each spelling out its own version of it. Absent
  // validates; present-but-wrong rejects the whole document.
  //
  // WHY THIS EXISTS. `production.shotProduction.reviews` (v13, above) was validated
  // element by element from the start, but the TOP-LEVEL `reviews` was not validated
  // at all: `restoreGraph` hydrated `decisions` behind a bare `Array.isArray` check
  // and took every element verbatim. So a decision of ANY shape survived a load and
  // was handed to G3 — the gate that decides whether an episode's approval still
  // stands and whether the picture stays locked. `review.js` refuses to CREATE a
  // decision whose `by` is not "user" (合同 §6.2 「不得静默定稿」); refusing it only
  // at creation while accepting anything at load leaves the same door open from the
  // other side, and a hand-edited or corrupted save is the exact way through it.
  //
  // WHAT IS DELIBERATELY NOT REQUIRED: an episode issue's `locatedShotId`. `issue()`
  // requires it, but TASK-074 §1.3's migration exists precisely to ACCEPT stored
  // issues that lack it and MARK them — validating it here would reject the documents
  // that migration was written to repair, i.e. refuse to load a save because it needs
  // the migration this build ships.
  if (additivePresent(doc.reviews)) {
    if (!isPlainObject(doc.reviews)) return "reviews is not an object";
    const issues = doc.reviews.issues;
    if (additivePresent(issues)) {
      if (!Array.isArray(issues)) return "reviews.issues is not an array";
      for (const it of issues) {
        if (!isPlainObject(it)) return "reviews.issues contains a non-object entry";
        if (typeof it.issueId !== "string" || !it.issueId) return "a review issue has no issueId";
        if (!REVIEW_LAYER_SET.has(it.layer)) return `review issue ${it.issueId} has an unknown layer`;
        // the layer OWNS its vocabulary (§6.1 disjointness): a delivery category on
        // an episode issue would put the issue on a panel that never shows it
        if (!REVIEW_CATEGORY_SET.get(it.layer).has(it.category)) {
          return `review issue ${it.issueId} has a category that does not belong to its layer`;
        }
        if (!REVIEW_SEVERITY_SET.has(it.severity)) return `review issue ${it.issueId} has an unknown severity`;
        if (!REVIEW_ISSUE_STATE_SET.has(it.state)) return `review issue ${it.issueId} has an unknown state`;
        // WHO raised it decides what it may do: an agent-raised observation and a
        // creator's own note are not interchangeable (§6.1/§6.2)
        if (it.source !== "user" && it.source !== "agent") {
          return `review issue ${it.issueId} does not say who raised it`;
        }
        if (typeof it.targetId !== "string" || !it.targetId) {
          return `review issue ${it.issueId} does not point at an object`;
        }
        if (typeof it.text !== "string" || !it.text.trim()) {
          return `review issue ${it.issueId} has no text`;
        }
        if (it.locatedShotId !== undefined && it.locatedShotId !== null
          && typeof it.locatedShotId !== "string") {
          return `review issue ${it.issueId} has an invalid locatedShotId`;
        }
      }
    }
    const decisions = doc.reviews.decisions;
    if (additivePresent(decisions)) {
      if (!Array.isArray(decisions)) return "reviews.decisions is not an array";
      for (const d of decisions) {
        if (!isPlainObject(d)) return "reviews.decisions contains a non-object entry";
        if (typeof d.decisionId !== "string" || !d.decisionId) return "a review decision has no decisionId";
        if (!REVIEW_LAYER_SET.has(d.layer)) return `review decision ${d.decisionId} has an unknown layer`;
        if (!REVIEW_VERDICT_SET.has(d.verdict)) return `review decision ${d.decisionId} has an unknown verdict`;
        // §6.2, enforced on the way IN as well as on the way out: only the creator
        // reaches a verdict, so a stored decision that claims any other author is a
        // 定稿 nobody made and G3 must never see it
        if (d.by !== "user") return `review decision ${d.decisionId} was not made by the creator`;
        if (typeof d.targetId !== "string" || !d.targetId) {
          return `review decision ${d.decisionId} does not point at an object`;
        }
        // WHICH VERSION was judged (§6.4). Without it 「已定稿的不是当前版本」 is
        // unanswerable and a stale approval reads as a current one.
        if (!Number.isInteger(d.basedOnVersion)) {
          return `review decision ${d.decisionId} does not record the version it judged`;
        }
        if (d.at !== undefined && d.at !== null && typeof d.at !== "string") {
          return `review decision ${d.decisionId} has an invalid timestamp`;
        }
        if (d.openIssueIds !== undefined) {
          if (!Array.isArray(d.openIssueIds)) {
            return `review decision ${d.decisionId} has an invalid openIssueIds`;
          }
          if (d.openIssueIds.some((x) => typeof x !== "string" || !x)) {
            return `review decision ${d.decisionId} has an empty openIssueId`;
          }
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
