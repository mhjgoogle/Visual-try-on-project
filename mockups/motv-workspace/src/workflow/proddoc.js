// Production domain document (checkpoint M6) — the creator-facing
// Project → Episodes → Scenes → Shots structure.
//
// OWNERSHIP (deliberately minimal):
// - Episode OWNS its Scenes (nested array — a scene belongs to exactly one
//   episode).
// - Scene REFERENCES Shots by canonical creativeShotId (M2 `shot-…` /
//   `shot-mig-N`) — shot CONTENT (title/description/duration/slot) stays on
//   the authoritative scriptgen draft, so the legacy workflow keeps working
//   unchanged and no second durable shot source of truth can form.
// - Assets stay owned by the Project Asset Registry (M3) and generation
//   provenance by the Generation Registry (M5); this document never copies
//   either.
//
// Persisted as the canvas document's top-level `production` field (schema v6).
// Identity: episodeId/sceneId are minted ONCE (identity.js) and only carried —
// never derived from title, index, or position. Migrated legacy documents get
// deterministic `ep-mig-N` ids from canvasschema.js (namespaces cannot collide).
//
// Fail-safe reading (M4 decision #5 applied to structure): a scene's shotId
// that no longer resolves in the current draft is DANGLING — kept and flagged,
// never guessed positionally and never silently pruned (the creator may switch
// back to the draft version that owns it).
//
// Pure state + transitions only — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";
import { sanitizeBible, sanitizeSceneRefs } from "./bibledoc.js";
import {
  sanitizeRelationships, sanitizeWorld, sanitizeCanon, sanitizeBeats, sanitizeBasedOn,
  defaultWorld, defaultCanon, defaultBeats, defaultBasedOn,
} from "./canondoc.js";
import { defaultShotProduction, sanitizeShotProduction } from "./shotprod.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/** A fresh default document: one episode, active, no scenes; an empty
 *  Production Bible (M7) and empty project-level canon (TASK-057). Every
 *  project has at least one episode (the shell's "当前剧集" context header). */
function defaultProduction() {
  const ep = {
    episodeId: mintId("ep"), title: "第 1 集", scenes: [], bgmAssetId: null,
    beats: defaultBeats(), basedOn: defaultBasedOn(), archived: null,
  };
  return {
    activeEpisodeId: ep.episodeId,
    episodes: [ep],
    characters: [],
    locations: [],
    // TASK-057 project-level canon: relationships between characters, the
    // World Setting, and one revision number per canon surface
    relationships: [],
    world: defaultWorld(),
    canon: defaultCanon(),
    // CP4 shot production state: review approvals + shared Reference bindings,
    // keyed by creativeShotId (see workflow/shotprod.js)
    shotProduction: defaultShotProduction(),
  };
}

function sanitizeScene(s, takenSceneIds, takenShotIds) {
  if (!isObj(s) || !nonEmpty(s.sceneId) || takenSceneIds.has(s.sceneId)) return null;
  takenSceneIds.add(s.sceneId);
  const shotIds = [];
  for (const id of Array.isArray(s.shotIds) ? s.shotIds : []) {
    // a shot belongs to at most ONE scene — on a hand-corrupted duplicate the
    // FIRST claim wins deterministically, the later one is dropped (ambiguous
    // ownership must not survive into runtime state)
    if (nonEmpty(id) && !takenShotIds.has(id)) {
      takenShotIds.add(id);
      shotIds.push(id);
    }
  }
  const assetRef = (v) => (typeof v === "string" && v ? v : null);
  return {
    sceneId: s.sceneId,
    title: typeof s.title === "string" ? s.title : "",
    shotIds,
    // M7 bible references — validated against the hydrated entities below
    // (sanitizeSceneRefs), since they point INSIDE this same document
    characterRefs: Array.isArray(s.characterRefs) ? s.characterRefs : [],
    locationRef: s.locationRef ?? null,
    // M11 audio references (shape-only, into the M3 audio registry): the
    // scene's reusable ambience and its optional BGM override — REFERENCES,
    // never copies; the same assetId may serve many scenes
    ambienceAssetId: assetRef(s.ambienceAssetId),
    bgmAssetId: assetRef(s.bgmAssetId),
  };
}

/** Hydrate the production document from a persisted `production` field (or
 *  start with the default single episode). Existing ids survive verbatim —
 *  only structurally unusable entries (no id / duplicate id) are dropped. */
export function createProduction(saved) {
  if (!isObj(saved)) return defaultProduction();
  const takenEpisodeIds = new Set();
  const takenSceneIds = new Set();
  const takenShotIds = new Set();
  const episodes = [];
  for (const e of Array.isArray(saved.episodes) ? saved.episodes : []) {
    if (!isObj(e) || !nonEmpty(e.episodeId) || takenEpisodeIds.has(e.episodeId)) continue;
    takenEpisodeIds.add(e.episodeId);
    const scenes = [];
    for (const s of Array.isArray(e.scenes) ? e.scenes : []) {
      const sc = sanitizeScene(s, takenSceneIds, takenShotIds);
      if (sc) scenes.push(sc);
    }
    episodes.push({
      episodeId: e.episodeId,
      title: typeof e.title === "string" ? e.title : "",
      scenes,
      // M11: the episode-level BGM reference (scenes may override)
      bgmAssetId: typeof e.bgmAssetId === "string" && e.bgmAssetId ? e.bgmAssetId : null,
      // TASK-057: beats + upstream stamp are sanitized below, once the canon
      // entities they reference are hydrated
      _rawBeats: e.beats,
      basedOn: sanitizeBasedOn(e.basedOn),
      // SOFT ARCHIVE (ADR-0072 决策 4). `null` is the normal state; an archived
      // episode STAYS in this list, at its position, and stays resolvable by id —
      //历史 Run / 剧本 / 提案 point at it, and turning those into dangling
      // references is the thing a delete would do (AGENTS.md 第 13 条).
      archived: sanitizeArchived(e.archived),
    });
  }
  if (!episodes.length) return defaultProduction();
  const active = nonEmpty(saved.activeEpisodeId) && episodes.some((e) => e.episodeId === saved.activeEpisodeId)
    ? saved.activeEpisodeId
    : episodes[0].episodeId; // a dangling pointer falls back deterministically
  // M7 Production Bible: hydrate entities first, then scene refs against them
  const { characters, locations } = sanitizeBible(saved);
  for (const e of episodes) for (const s of e.scenes) sanitizeSceneRefs(s, characters, locations);
  // TASK-057 canon: relationships need the characters to exist, and beats need
  // both — so the order is characters → relationships → beats
  const charIds = new Set(characters.map((c) => c.characterId));
  const relationships = sanitizeRelationships(saved.relationships, charIds);
  const relIds = new Set(relationships.map((r) => r.relationshipId));
  for (const e of episodes) {
    e.beats = sanitizeBeats(e._rawBeats, charIds, relIds);
    delete e._rawBeats;
  }
  return {
    activeEpisodeId: active,
    episodes,
    characters,
    locations,
    relationships,
    world: sanitizeWorld(saved.world),
    canon: sanitizeCanon(saved.canon),
    shotProduction: sanitizeShotProduction(saved.shotProduction),
  };
}

/** The durable slice for persistence (schema v10 `production`). */
export function serialize(prod) {
  return {
    activeEpisodeId: prod.activeEpisodeId,
    episodes: prod.episodes,
    characters: prod.characters,
    locations: prod.locations,
    relationships: prod.relationships,
    world: prod.world,
    canon: prod.canon,
    shotProduction: prod.shotProduction,
  };
}

export function findEpisode(prod, episodeId) {
  return prod.episodes.find((e) => e.episodeId === episodeId) || null;
}

export function activeEpisode(prod) {
  return findEpisode(prod, prod.activeEpisodeId) || prod.episodes[0] || null;
}

export function findScene(prod, sceneId) {
  for (const e of prod.episodes) {
    const s = e.scenes.find((x) => x.sceneId === sceneId);
    if (s) return { episode: e, scene: s };
  }
  return null;
}

/** `{ at, reason }` or null. A malformed value degrades to 「not archived」: the
 *  visible state must never be decided by a half-written record. */
function sanitizeArchived(a) {
  if (!isObj(a)) return null;
  const at = typeof a.at === "string" ? a.at : "";
  const reason = typeof a.reason === "string" ? a.reason : "";
  if (!at.trim()) return null;
  return { at, reason };
}

/** Is this episode archived? The one reader of the shape, so 「归档了没有」 cannot
 *  be answered two different ways. */
export function isArchived(ep) {
  return !!(ep && isObj(ep.archived) && typeof ep.archived.at === "string" && ep.archived.at.trim());
}

/** The episodes a creator is working with — archived ones excluded.
 *
 *  Every surface that LISTS episodes uses this; anything that RESOLVES one by id
 *  keeps using `findEpisode`, because an archived episode must stay reachable
 *  (ADR-0072 决策 4). */
export function liveEpisodes(prod) {
  return (prod && Array.isArray(prod.episodes) ? prod.episodes : []).filter((e) => !isArchived(e));
}

/**
 * Archive one episode. Returns false when it is not there or already archived.
 *
 * NO CONTENT CHECK HERE, deliberately: this module cannot see `scripts`,
 * `timelines` or the Run registry, and a check that only looked at what it CAN see
 * would be exactly the 「守卫看起来加了，其实只覆盖了一半」 defect this repo keeps
 * paying for. `archivableEpisodes` (workflow/episodecleanup.js) makes that
 * judgement against the WHOLE document and is what the UI offers.
 */
export function archiveEpisode(prod, episodeId, { at, reason = "" } = {}) {
  const ep = findEpisode(prod, episodeId);
  if (!ep || isArchived(ep)) return false;
  if (typeof at !== "string" || !at.trim()) return false; // no clock in here
  if (prod.activeEpisodeId === episodeId) return false; // never the one in hand
  ep.archived = { at, reason: typeof reason === "string" ? reason : "" };
  return true;
}

/** Put it back. The whole reason archiving is allowed at all. */
export function unarchiveEpisode(prod, episodeId) {
  const ep = findEpisode(prod, episodeId);
  if (!ep || !isArchived(ep)) return false;
  ep.archived = null;
  return true;
}

/** Append a new Episode (id minted once, carried forever). Returns it. */
export function addEpisode(prod, title) {
  const ep = {
    episodeId: mintId("ep"),
    title: nonEmpty(title) ? title : `第 ${prod.episodes.length + 1} 集`,
    scenes: [],
    bgmAssetId: null,
    // TASK-057: a new episode records no beats and is NOT auto-stamped against
    // upstream — the creator stamps it when they decide it is up to date
    beats: defaultBeats(),
    basedOn: defaultBasedOn(),
    archived: null,
  };
  prod.episodes.push(ep);
  return ep;
}

export function renameEpisode(prod, episodeId, title) {
  const ep = findEpisode(prod, episodeId);
  if (!ep || typeof title !== "string" || !title.trim()) return false;
  ep.title = title;
  return true;
}

/** Remove an Episode — REFUSED unless it is empty (no scenes) and not the last
 *  one: deleting scenes implicitly would silently destroy creator structure
 *  (non-destructive rule); remove its scenes explicitly first. If the removed
 *  episode was active, the first remaining becomes active. */
export function removeEpisode(prod, episodeId) {
  const ep = findEpisode(prod, episodeId);
  if (!ep || ep.scenes.length || prod.episodes.length <= 1) return false;
  prod.episodes = prod.episodes.filter((e) => e.episodeId !== episodeId);
  if (prod.activeEpisodeId === episodeId) prod.activeEpisodeId = prod.episodes[0].episodeId;
  return true;
}

export function setActiveEpisode(prod, episodeId) {
  if (!findEpisode(prod, episodeId)) return false;
  prod.activeEpisodeId = episodeId;
  return true;
}

/** Append a new Scene to an Episode (id minted once). Returns it or null. */
export function addScene(prod, episodeId, title) {
  const ep = findEpisode(prod, episodeId);
  if (!ep) return null;
  const scene = {
    sceneId: mintId("scene"),
    title: nonEmpty(title) ? title : `场 ${ep.scenes.length + 1}`,
    shotIds: [],
    characterRefs: [], // M7: bible references (by id + optional state)
    locationRef: null,
    ambienceAssetId: null, // M11: reusable ambience/BGM references
    bgmAssetId: null,
  };
  ep.scenes.push(scene);
  return scene;
}

export function renameScene(prod, sceneId, title) {
  const hit = findScene(prod, sceneId);
  if (!hit || typeof title !== "string" || !title.trim()) return false;
  hit.scene.title = title;
  return true;
}

/** Remove a Scene — REFUSED while it still references shots: the creator must
 *  unassign them first (explicit, never a silent cascade). The shots
 *  themselves live on the draft and are never touched. */
export function removeScene(prod, sceneId) {
  const hit = findScene(prod, sceneId);
  if (!hit || hit.scene.shotIds.length) return false;
  hit.episode.scenes = hit.episode.scenes.filter((s) => s.sceneId !== sceneId);
  return true;
}

/** Assign a shot (by canonical creativeShotId) to a Scene. MOVE semantics: a
 *  shot belongs to at most one scene project-wide, so any previous assignment
 *  is released first. Only the REFERENCE moves — shot content is untouched. */
export function assignShot(prod, sceneId, shotId) {
  if (!nonEmpty(shotId)) return false;
  const hit = findScene(prod, sceneId);
  if (!hit) return false;
  unassignShot(prod, shotId);
  hit.scene.shotIds.push(shotId);
  return true;
}

/** Release a shot from whichever scene references it (no-op when unassigned). */
export function unassignShot(prod, shotId) {
  let removed = false;
  for (const e of prod.episodes) {
    for (const s of e.scenes) {
      const before = s.shotIds.length;
      s.shotIds = s.shotIds.filter((id) => id !== shotId);
      if (s.shotIds.length !== before) removed = true;
    }
  }
  return removed;
}

// ---- M11 audio references (scene ambience / episode+scene BGM) ------------ //
// REFERENCES into the M3 audio registry (assetId), never copies — the same
// ambience/music asset legitimately serves many scenes/episodes. null clears.

export function setSceneAmbience(prod, sceneId, assetId) {
  const hit = findScene(prod, sceneId);
  if (!hit) return false;
  hit.scene.ambienceAssetId = typeof assetId === "string" && assetId ? assetId : null;
  return true;
}

export function setSceneBgm(prod, sceneId, assetId) {
  const hit = findScene(prod, sceneId);
  if (!hit) return false;
  hit.scene.bgmAssetId = typeof assetId === "string" && assetId ? assetId : null;
  return true;
}

export function setEpisodeBgm(prod, episodeId, assetId) {
  const ep = findEpisode(prod, episodeId);
  if (!ep) return false;
  ep.bgmAssetId = typeof assetId === "string" && assetId ? assetId : null;
  return true;
}

/** The effective BGM for a scene: its own override, else its episode's. */
export function effectiveBgm(prod, episodeId, sceneId) {
  const hit = sceneId ? findScene(prod, sceneId) : null;
  if (hit && hit.scene.bgmAssetId) return { assetId: hit.scene.bgmAssetId, from: "scene" };
  const ep = findEpisode(prod, episodeId);
  if (ep && ep.bgmAssetId) return { assetId: ep.bgmAssetId, from: "episode" };
  return null;
}

/** The scene a shotId is assigned to, or null. */
export function sceneOfShot(prod, shotId) {
  for (const e of prod.episodes) {
    for (const s of e.scenes) {
      if (s.shotIds.includes(shotId)) return { episode: e, scene: s };
    }
  }
  return null;
}

/** Pure read model of one Episode joined against the CURRENT draft shots.
 *  - each scene's shotIds resolve to the draft shot carrying that
 *    creativeShotId; a reference whose shot is not in the current draft is
 *    DANGLING (kept + flagged, never guessed, never pruned);
 *  - `unassigned` lists current-draft shots not referenced by ANY scene of ANY
 *    episode (a shot assigned in another episode is not re-offered here).
 *  Draft shots without a canonical shotId (legacy) cannot be referenced and
 *  are surfaced in `unassignable` so the UI can say so honestly. */
export function episodeView(prod, episodeId, draftShots) {
  const ep = findEpisode(prod, episodeId);
  if (!ep) return null;
  const byShotId = new Map();
  const legacy = [];
  for (const s of Array.isArray(draftShots) ? draftShots : []) {
    if (!isObj(s)) continue;
    if (nonEmpty(s.shotId)) {
      // a duplicated creativeShotId in a corrupt draft is ambiguous — resolve
      // it to NO shot (fail safe), consistent with shotmap's index rules
      byShotId.set(s.shotId, byShotId.has(s.shotId) ? null : s);
    } else {
      legacy.push(s);
    }
  }
  const claimed = new Set();
  for (const e of prod.episodes) {
    for (const s of e.scenes) for (const id of s.shotIds) claimed.add(id);
  }
  const scenes = ep.scenes.map((s) => ({
    sceneId: s.sceneId,
    title: s.title,
    shots: s.shotIds.map((id) => {
      const shot = byShotId.get(id);
      return { shotId: id, shot: shot || null, dangling: !shot };
    }),
  }));
  const unassigned = [];
  for (const [id, shot] of byShotId) {
    if (shot && !claimed.has(id)) unassigned.push(shot);
  }
  return { episode: ep, scenes, unassigned, unassignable: legacy };
}
