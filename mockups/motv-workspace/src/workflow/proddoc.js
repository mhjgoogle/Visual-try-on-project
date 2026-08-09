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

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/** A fresh default document: one episode, active, no scenes. Every project
 *  has at least one episode (the shell's "当前剧集" context header). */
function defaultProduction() {
  const ep = { episodeId: mintId("ep"), title: "第 1 集", scenes: [] };
  return { activeEpisodeId: ep.episodeId, episodes: [ep] };
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
  return { sceneId: s.sceneId, title: typeof s.title === "string" ? s.title : "", shotIds };
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
    episodes.push({ episodeId: e.episodeId, title: typeof e.title === "string" ? e.title : "", scenes });
  }
  if (!episodes.length) return defaultProduction();
  const active = nonEmpty(saved.activeEpisodeId) && episodes.some((e) => e.episodeId === saved.activeEpisodeId)
    ? saved.activeEpisodeId
    : episodes[0].episodeId; // a dangling pointer falls back deterministically
  return { activeEpisodeId: active, episodes };
}

/** The durable slice for persistence (schema v6 `production`). */
export function serialize(prod) {
  return { activeEpisodeId: prod.activeEpisodeId, episodes: prod.episodes };
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

/** Append a new Episode (id minted once, carried forever). Returns it. */
export function addEpisode(prod, title) {
  const ep = {
    episodeId: mintId("ep"),
    title: nonEmpty(title) ? title : `第 ${prod.episodes.length + 1} 集`,
    scenes: [],
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
