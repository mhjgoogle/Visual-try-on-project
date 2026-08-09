// Project Asset Registry (checkpoint M3) — the ONE durable owner of creator
// media. Workflow nodes present/reference assets but no longer own them:
// at restore, node views ALIAS these maps (same object), so the existing
// single write path (mediaref.addVersion) keeps writing into the registry
// and no second durable MediaRef source of truth can exist.
//
// Shape (persisted as the canvas document's top-level `assets` field):
//   {
//     images:      { [slot]:  {current, history:[MediaRef]} }  // assets 节点图片
//     videos:      { [slot]:  {current, history:[MediaRef]} }  // video 节点视频
//     audio:       { [key]:   {current, history:[MediaRef]} }  // voice-<slot>/music-*/sfx-*
//     firstFrames: { [slot]:  MediaRef }                       // 图→视频首帧引用
//     finals:      [ {assetId, url, origin} ]                  // 合成成片（追加式）
//     displaced:   [ …migration-preserved chains… ]            // 迁移防丢底账
//   }
//
// Keying: slots are NOT globally unique across media kinds (the same slot
// legally exists under images AND videos), so the registry is keyed by media
// domain first — never globally by slot. Every history record is an Asset
// (one durable media version = one Asset) carrying a stable `assetId`;
// `current` is a POINTER to the selected Asset, not an identity. `assetId`
// never derives from slot/position/node/digest — digest stays what it is
// today: content integrity, not business identity.
import { migrateUploads } from "./mediaref.js";
import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** Hydrate a registry from a persisted `assets` field (or start empty).
 *  Chain maps get the idempotent legacy string→MediaRef adapter, same as
 *  node uploads always did. A slot literally named `__proto__` is safe here:
 *  JSON.parse stores it as an OWN key and every write goes through
 *  mediaref.putKey, so the map's prototype is never mutated. */
export function createRegistry(saved) {
  // Spread first so any unknown field a future checkpoint added under `assets`
  // is carried through the hydrate → serialize round-trip instead of dropped.
  const reg = { ...(isObj(saved) ? saved : {}), images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] };
  if (isObj(saved)) {
    for (const k of ["images", "videos", "audio", "firstFrames"]) {
      if (isObj(saved[k])) reg[k] = saved[k];
    }
    if (Array.isArray(saved.finals)) reg.finals = saved.finals;
    if (Array.isArray(saved.displaced)) reg.displaced = saved.displaced;
  }
  migrateUploads(reg.images);
  migrateUploads(reg.videos);
  migrateUploads(reg.audio);
  return reg;
}

/** Composed finals as the plain url list every existing consumer renders
 *  (edit node player, Production 剪辑 workspace). Defensive against a
 *  hand-corrupted save (`finals: [null]`): only real urls surface. */
export function finalUrls(reg) {
  const out = [];
  for (const f of reg.finals) {
    if (typeof f === "string" && f) out.push(f);
    else if (isObj(f) && typeof f.url === "string" && f.url) out.push(f.url); // no phantom empty urls
  }
  return out;
}

/** Append a freshly composed final as a new Asset (runtime write path —
 *  origin is honestly "compose" because we ARE the compose caller here).
 *  Guards the url: a malformed compose response (no/empty url) must NOT write a
 *  record that v3 validation would reject on the next load — returns null so
 *  the caller can surface the failure instead. */
export function addFinal(reg, url) {
  if (typeof url !== "string" || !url) return null;
  const rec = { assetId: mintId("asset"), url, origin: "compose" };
  reg.finals.push(rec);
  return rec;
}

/** The M2 shotId a media key PROVABLY belongs to, else null.
 *
 *  The DOMAIN must be passed, never guessed from the key text: an image/video
 *  key IS the slot; an audio key is `voice-<slot>` (per shot) or `music-*` /
 *  `sfx-*` (not per shot). Guessing from a `voice-`/`music-`/`sfx-` prefix
 *  would mis-handle a legitimate image/video slot that happened to start with
 *  those letters. The slot→shotId relation is proven only when EVERY draft raw
 *  entry carrying that slot (across all versions/nodes) agrees on one shotId —
 *  anything ambiguous is honestly null. Never guessed by index or sequence. */
export function shotIdForKey(draftVersionLists, key, domain = "audio") {
  if (typeof key !== "string" || !key) return null;
  let slot;
  if (domain === "audio") {
    if (key.startsWith("music-") || key.startsWith("sfx-")) return null;
    slot = key.startsWith("voice-") ? key.slice("voice-".length) : key;
  } else {
    slot = key; // images / videos are keyed by the slot itself
  }
  const ids = new Set();
  let ambiguous = false;
  for (const versions of Array.isArray(draftVersionLists) ? draftVersionLists : []) {
    for (const ver of Array.isArray(versions) ? versions : []) {
      const raw = ver && Array.isArray(ver.raw) ? ver.raw : []; // truthy non-array must not throw
      for (const s of raw) {
        if (!s || s.slot !== slot) continue;
        // an occurrence of this slot without a string shotId makes ownership
        // unprovable — one identified + one unidentified must resolve to null
        if (typeof s.shotId === "string" && s.shotId) ids.add(s.shotId);
        else ambiguous = true;
      }
    }
  }
  return !ambiguous && ids.size === 1 ? ids.values().next().value : null;
}
