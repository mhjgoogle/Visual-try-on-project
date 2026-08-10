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
  const reg = {
    ...(isObj(saved) ? saved : {}),
    images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [],
    // M4d: paid results whose creative-Shot identity could not be resolved for
    // adoption — preserved with an explicit state, never silently attached to
    // another Shot or discarded. { serverShotId, taskId, creativeShotId, reason }.
    unresolvedPaid: [],
  };
  if (isObj(saved)) {
    for (const k of ["images", "videos", "audio", "firstFrames"]) {
      if (isObj(saved[k])) reg[k] = saved[k];
    }
    if (Array.isArray(saved.finals)) reg.finals = saved.finals;
    if (Array.isArray(saved.displaced)) reg.displaced = saved.displaced;
    if (Array.isArray(saved.unresolvedPaid)) reg.unresolvedPaid = saved.unresolvedPaid;
  }
  migrateUploads(reg.images);
  migrateUploads(reg.videos);
  migrateUploads(reg.audio);
  return reg;
}

/** Record a paid result that could not be resolved to a creative Shot (M4d),
 *  deduped by the unique `taskId` (a shot can have MANY paid results — deduping
 *  by serverShotId would silently drop earlier takes). Preserved, never lost. */
export function recordUnresolvedPaid(reg, entry) {
  if (!isObj(reg)) return;
  if (!Array.isArray(reg.unresolvedPaid)) reg.unresolvedPaid = [];
  const tid = entry && entry.taskId;
  if (typeof tid !== "string" || !tid) return; // a paid result is uniquely its task
  reg.unresolvedPaid = reg.unresolvedPaid.filter((e) => e && e.taskId !== tid).concat([entry]);
}

/** Clear a task's unresolved-paid record once it has been adopted successfully
 *  — else the persisted state keeps reporting an already-adopted result as
 *  unresolved (M4d). No-op when the task was never unresolved. */
export function clearUnresolvedPaid(reg, taskId) {
  if (!isObj(reg) || !Array.isArray(reg.unresolvedPaid)) return;
  if (typeof taskId !== "string" || !taskId) return;
  reg.unresolvedPaid = reg.unresolvedPaid.filter((e) => e && e.taskId !== taskId);
}

/** Change an Asset's byte-availability lifecycle (M5) WITHOUT touching its
 *  identity, url (last-known location), or its Generation provenance — those
 *  live independently, so releasing disk space never breaks the lineage chain.
 *  States: local | archived | missing | deleted. This is the single data-model
 *  primitive a future Remove-Local-Copy / archive / missing-detection /
 *  permanent-delete flow builds on. Returns true if a matching Asset was found.
 *  (`deleted`/`missing` keep the record + assetId; only availability changes.) */
export function setStorageState(reg, assetId, state) {
  const STATES = new Set(["local", "archived", "missing", "deleted"]);
  if (!isObj(reg) || typeof assetId !== "string" || !assetId || !STATES.has(state)) return false;
  let changed = false;
  const visit = (r) => {
    if (isObj(r) && r.assetId === assetId) { r.storageState = state; changed = true; }
  };
  for (const dom of ["images", "videos", "audio"]) {
    const m = reg[dom];
    if (!isObj(m)) continue;
    for (const k of Object.keys(m)) {
      const e = m[k];
      if (isObj(e) && Array.isArray(e.history)) e.history.forEach(visit);
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) visit(f);
  if (isObj(reg.firstFrames)) for (const k of Object.keys(reg.firstFrames)) visit(reg.firstFrames[k]);
  return changed;
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
  // storageState 'local' (M5): a freshly composed final's bytes are present, and
  // v5 validation requires the field on every durable Asset record.
  const rec = { assetId: mintId("asset"), url, origin: "compose", storageState: "local" };
  reg.finals.push(rec);
  return rec;
}

/** Locate an Asset RECORD by id anywhere in the registry (chains, finals,
 *  standalone first frames). Returns { record, domain, key } or null.
 *  firstFrames that ALIAS an image asset resolve to the image chain entry. */
export function findAssetById(reg, assetId) {
  if (!isObj(reg) || typeof assetId !== "string" || !assetId) return null;
  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      const r = e.history.find((x) => isObj(x) && x.assetId === assetId);
      if (r) return { record: r, domain, key };
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) {
    if (isObj(f) && f.assetId === assetId) return { record: f, domain: "finals", key: null };
  }
  if (isObj(reg.firstFrames)) {
    for (const key of Object.keys(reg.firstFrames)) {
      const r = reg.firstFrames[key];
      if (isObj(r) && r.assetId === assetId) return { record: r, domain: "firstFrames", key };
    }
  }
  return null;
}

/** Every place that REFERENCES an Asset (M11 permanent-delete gate). Returns
 *  { blocking: [labels], provenance: n } — blocking references must be
 *  released BEFORE a permanent delete (never silently broken); generation
 *  links are provenance (allowed to dangle by design, M5) and are only
 *  REPORTED so the deletion prompt can state the impact honestly. */
export function referencesOfAsset({ reg, assetId, production, timelines, generations }) {
  const blocking = [];
  if (isObj(reg) && isObj(reg.firstFrames)) {
    for (const key of Object.keys(reg.firstFrames)) {
      const r = reg.firstFrames[key];
      if (isObj(r) && r.assetId === assetId) blocking.push(`镜头首帧引用（槽位 ${key}）`);
    }
  }
  if (isObj(production)) {
    for (const c of Array.isArray(production.characters) ? production.characters : []) {
      if (Array.isArray(c.referenceAssetIds) && c.referenceAssetIds.includes(assetId)) blocking.push(`角色参考图（${c.name}）`);
      for (const st of Array.isArray(c.states) ? c.states : []) {
        if (st.overrides && Array.isArray(st.overrides.referenceAssetIds) && st.overrides.referenceAssetIds.includes(assetId)) {
          blocking.push(`角色状态参考图（${c.name} · ${st.name}）`);
        }
      }
    }
    for (const l of Array.isArray(production.locations) ? production.locations : []) {
      if (Array.isArray(l.referenceAssetIds) && l.referenceAssetIds.includes(assetId)) blocking.push(`场景地参考图（${l.name}）`);
      for (const st of Array.isArray(l.states) ? l.states : []) {
        if (st.overrides && Array.isArray(st.overrides.referenceAssetIds) && st.overrides.referenceAssetIds.includes(assetId)) {
          blocking.push(`场景地状态参考图（${l.name} · ${st.name}）`);
        }
      }
    }
    for (const ep of Array.isArray(production.episodes) ? production.episodes : []) {
      if (ep.bgmAssetId === assetId) blocking.push(`剧集 BGM（${ep.title}）`);
      for (const sc of Array.isArray(ep.scenes) ? ep.scenes : []) {
        if (sc.ambienceAssetId === assetId) blocking.push(`场景环境音（${sc.title}）`);
        if (sc.bgmAssetId === assetId) blocking.push(`场景 BGM（${sc.title}）`);
      }
    }
  }
  if (isObj(timelines)) {
    for (const epId of Object.keys(timelines)) {
      const t = timelines[epId];
      for (const c of isObj(t) && Array.isArray(t.clips) ? t.clips : []) {
        if (isObj(c) && c.assetId === assetId) blocking.push(`时间线 clip（${c.trackType}）`);
      }
    }
  }
  let provenance = 0;
  for (const g of Array.isArray(generations) ? generations : []) {
    if (!isObj(g)) continue;
    for (const field of ["inputAssetIds", "referenceAssetIds", "resultAssetIds"]) {
      if (Array.isArray(g[field]) && g[field].includes(assetId)) provenance += 1;
    }
  }
  return { blocking, provenance };
}

/** Surgically remove ONE Asset record (permanent delete, AFTER the blocking
 *  reference gate + byte deletion). Chain records: the version leaves the
 *  history; a current pointer at it re-points to the newest remaining; an
 *  emptied chain key is removed. Finals: the record leaves the list.
 *  Generation provenance is NEVER touched (dangling links are by design). */
export function removeAssetRecord(reg, assetId) {
  const hit = findAssetById(reg, assetId);
  if (!hit) return false;
  if (hit.domain === "finals") {
    reg.finals = reg.finals.filter((f) => !(isObj(f) && f.assetId === assetId));
    return true;
  }
  if (hit.domain === "firstFrames") {
    delete reg.firstFrames[hit.key];
    return true;
  }
  const chain = reg[hit.domain][hit.key];
  chain.history = chain.history.filter((r) => !(isObj(r) && r.assetId === assetId));
  if (!chain.history.length) {
    delete reg[hit.domain][hit.key];
    return true;
  }
  if (!chain.history.some((r) => r.version === chain.current)) {
    chain.current = chain.history[chain.history.length - 1].version;
  }
  return true;
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
