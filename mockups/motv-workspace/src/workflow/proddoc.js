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
import { createBlocking } from "./blocking.js";

/** shotId → 白膜（TASK-123 / ADR-0094）。形状不对的丢掉；`__proto__` 这类名字
 *  留成**自有键**，与这份文档里其它按 shotId 索引的表同一条纪律。 */
function sanitizeBlockingMap(saved) {
  // 与这份文档里其它按 shotId 索引的表一样用普通对象： 这类名字由
  // 下面的  落成**自有键**，而不是靠换原型（换了原型，
  // 序列化的往返比较就会因为原型不同而不等 —— proddoc 的守卫当场抓到）。
  const out = {};
  if (saved == null || typeof saved !== "object" || Array.isArray(saved)) return out;
  for (const key of Object.keys(saved)) {
    const v = saved[key];
    if (v == null || typeof v !== "object" || Array.isArray(v)) continue;
    Object.defineProperty(out, key, {
      value: createBlocking(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

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
    props: [],
    // TASK-057 project-level canon: relationships between characters, the
    // World Setting, and one revision number per canon surface
    relationships: [],
    world: defaultWorld(),
    canon: defaultCanon(),
    // CP4 shot production state: review approvals + shared Reference bindings,
    // keyed by creativeShotId (see workflow/shotprod.js)
    shotProduction: defaultShotProduction(),
    // 每一镜的白膜（TASK-123 / ADR-0094）：shotId → blocking。
    // 字节不在这里 —— 录出来的视频走既有的资产登记（决策 4）。
    blocking: {},
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
  const timeOfDay = typeof s.timeOfDay === "string" ? s.timeOfDay.trim() : "";
  return {
    sceneId: s.sceneId,
    title: typeof s.title === "string" ? s.title : "",
    // 场景时间（TASK-095 §2.1.2）—— **加法字段**，老数据没有它是常态。
    // 缺就是缺：不填默认值、不猜「白天」。产品负责人给的理由是资产复用 ——
    // 同一个「便利店外」的白天与夜是两套场景图，没有时间就分不开也复用不了。
    // 只在真的有值时带上这个键，好让「清空时间」与「从来没写过时间」持久成同一形状。
    ...(timeOfDay ? { timeOfDay } : {}),
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
  const { characters, locations, props } = sanitizeBible(saved);
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
    // 道具（TASK-095 §2.2）—— 加法字段，老文档没有它是常态
    props,
    relationships,
    world: sanitizeWorld(saved.world),
    canon: sanitizeCanon(saved.canon),
    shotProduction: sanitizeShotProduction(saved.shotProduction),
    blocking: sanitizeBlockingMap(saved.blocking),
  };
}

/** The durable slice for persistence (schema v10 `production`). */
/** 这是一份**能用的**落地流程吗（ADR-0084 / TASK-105）？
 *
 *  判据是 `createdFrom.flowId` —— 后端写下的每一份 `studio/flow.json` 都有它，
 *  它就是「这确实是一份落下来的流程」的那个标记。
 *
 *  为什么需要一个具名谓词而不是 `if (flow)`：`{}` 是真值，于是它会被当成加载
 *  成功，套用时静默 no-op，而自动保存照常把空白画布存下来 —— 与请求失败的后果
 *  一模一样（codex 审查轮 7）。前几轮一次修一种输入（失败 → 消息 → 停保存），
 *  这一版守的是那个**性质**：打算套用模板，就必须真的拿到一份能用的模板。
 *
 *  住在这里而不是 app.js 里，是为了它**能被真的测到** —— app.js 是入口编排层，
 *  `node --test` 拿不到它，那一层只剩源码文本断言（TASK-087 §3.6.4）。 */
export function isUsableFlow(flow) {
  if (!isObj(flow) || !isObj(flow.createdFrom)) return false;
  const { flowId, flowVersion, flowDigest } = flow.createdFrom;
  // **三个字段一个不少** —— ADR-0084 决策 5 写的就是三个，理由也在那里：
  // `flowVersion` 回答「作者说这是第几版」，`flowDigest` 回答「那一版到底是什么」。
  // 只认 `flowId` 的话，一份被截断的 flow 能解除自动保存、套用出零内容，然后把
  // 空白画布存成这个项目的开局（codex 审查轮 10）。
  //
  // `nonEmpty` 只查 `!== ""`，所以 `"   "` 会过；这里 trim，因为这个谓词的
  // **全部意义**就是不让「看起来有东西」冒充「真的有东西」。
  return (
    typeof flowId === "string" && flowId.trim() !== "" &&
    typeof flowVersion === "number" && Number.isInteger(flowVersion) && flowVersion >= 1 &&
    typeof flowDigest === "string" && flowDigest.trim() !== ""
  );
}

/** 把一份流程模板的骨架应用到**全新**的生产文档上（ADR-0084 / TASK-105）。
 *
 *  只在项目还没有画布时调用一次。**它不覆盖任何已有内容** —— 传进来的 `prod`
 *  必须是刚 `createProduction(null)` 出来的那一份，否则就成了「模板改写创作者
 *  已经写下的东西」，那是第 13 条禁止的静默覆盖。
 *
 *  为什么这一步存在：不做它，从模板起步的项目和空项目**一模一样**，
 *  「选模板」就成了一个点了没反应的控件（codex 审查轮 3 的 blocking）。
 *
 *  目前应用的是 `episodeCount`。刻意**只做这一条**：它是 seed 里唯一一个能在
 *  不发明任何内容的前提下改变项目形状的约定 —— 集数是结构，剧本是内容。 */
export function applyFlowSeed(prod, flow) {
  if (!isObj(prod) || !isObj(flow)) return prod;
  const conventions = isObj(flow.conventions) ? flow.conventions : {};
  const want = conventions.episodeCount;
  // 整数、>= 1、且有个上限：一个写着 1e9 的模板不该让新建项目挂住
  if (typeof want !== "number" || !Number.isInteger(want) || want < 1 || want > 200) {
    return prod;
  }
  // 只从**默认那一集**长出去。判据不能只是「集数 == 1」：一份创作者已经写了
  // 半天、但仍然只有一集的文档同样满足它，于是模板会在它上面接着长出十一集
  // （codex 审查轮 6 的 non-blocking）。今天唯一的调用方在「这个项目还没有画布」
  // 时才调，所以撞不上——但**一个函数不该靠调用方替它守规矩**，尤其当它守的是
  // 第 13 条（不静默覆盖创作者的东西）。
  if (prod.episodes.length !== 1) return prod;
  const only = prod.episodes[0];
  const untouched =
    (!Array.isArray(only.scenes) || only.scenes.length === 0) &&
    !only.bgmAssetId &&
    !isArchived(only) &&
    !prod.characters.length &&
    !prod.locations.length &&
    !prod.props.length;
  if (!untouched) return prod;
  while (prod.episodes.length < want) {
    addEpisode(prod, `第 ${prod.episodes.length + 1} 集`);
  }
  // `addEpisode` 会把新集设为 active；模板应用完之后回到第一集，
  // 因为创作者要从头开始，不是从第 12 集开始。
  prod.activeEpisodeId = prod.episodes[0].episodeId;
  return prod;
}

export function serialize(prod) {
  return {
    activeEpisodeId: prod.activeEpisodeId,
    episodes: prod.episodes,
    characters: prod.characters,
    locations: prod.locations,
    props: prod.props,
    relationships: prod.relationships,
    world: prod.world,
    canon: prod.canon,
    shotProduction: prod.shotProduction,
    blocking: prod.blocking,
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

/** 场景时间（`白天` / `夜` / `黄昏`…）。自由文本：`TIME_OF_DAY_HINTS` 只是输入建议。
 *  空值**删字段**，与 `sanitizeScene` 同一姿态。 */
export function setSceneTimeOfDay(prod, sceneId, timeOfDay) {
  const hit = findScene(prod, sceneId);
  if (!hit) return false;
  const v = typeof timeOfDay === "string" ? timeOfDay.trim() : "";
  if (v) hit.scene.timeOfDay = v;
  else delete hit.scene.timeOfDay;
  return true;
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
