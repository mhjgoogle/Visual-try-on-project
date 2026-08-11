// Project-level CANON beyond characters & locations (TASK-057 / ADR-0054) —
// the parts of 作品设定 that describe the WHOLE work rather than one entity:
//
//   Relationship   a first-class object between EXACTLY TWO Characters
//   World Setting  era / rules / society / regions / visual tone / atmosphere
//   Canon revisions  one explicit version number per canon surface
//   Episode beats    what a given episode actually advances
//   basedOn stamps   which upstream versions an episode was built on
//
// OWNERSHIP:
// - Relationships reference Characters BY ID only — a relationship never
//   copies a character profile (same rule as Scene ↔ bible references, M7).
// - World Setting is the UPSTREAM canon. `production.locations` /
//   LocationState keep their own domain: World's 「主要地点」 is a creative
//   direction, NOT a second location database, and never resolves a Scene's
//   locationRef.
// - A Project-level Relationship DEFINITION describes the work's long arc
//   (戒备 → 合作 → 信任 → 决裂 → 再选择). What actually happens in one episode
//   is an Episode-level Relationship BEAT and is recorded here on the episode —
//   writing a beat never edits the definition.
//
// VERSIONS (ADR-0054 决策 6): each canon surface carries ONE monotonic revision
// number, bumped ONLY by an explicit user confirmation — never by autosave.
// An Episode carries a five-key `basedOn` stamp; Impact is the difference
// between the stamp and the current numbers. That is the whole mechanism:
// deterministic, provable, and the same shape for every surface.
//
// Pure state + transitions only — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const str = (x) => (typeof x === "string" ? x : "");
const rev = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);

/** Facets of a Relationship DEFINITION. Every one is project-level canon; none
 *  of them pins down a per-episode state (that is what beats are for). */
export const RELATIONSHIP_FIELDS = [
  "basis",         // 基础关系
  "aToB",          // A 怎么看 B
  "bToA",          // B 怎么看 A
  "coreConflict",  // 核心矛盾
  "tension",       // 情感张力
  "power",         // 权力关系
  "history",       // 共同历史
  "secrets",       // 隐藏信息 / 秘密
  "direction",     // 长期发展方向
  "arc",           // Relationship Arc
  "forbidden",     // 不应发生的关系偏离
];

/** Facets of the World Setting. */
export const WORLD_FIELDS = [
  "era",         // 时间 / 时代
  "rules",       // 世界规则
  "society",     // 社会背景
  "regions",     // 主要区域
  "places",      // 主要地点（创作方向，不是地点数据库）
  "visualTone",  // 视觉基调
  "atmosphere",  // 整体氛围
];

/** The upstream surfaces an Episode can be based on — ONE list, used by the
 *  stamp, the current-version reader and the impact diff, so the three can
 *  never fall out of sync. */
export const UPSTREAM_KEYS = ["brief", "outline", "characters", "relationships", "world"];

export const UPSTREAM_LABEL = {
  brief: "创意 Brief",
  outline: "故事大纲",
  characters: "人物",
  relationships: "人物关系",
  world: "世界观",
};

/** The dependency state of ONE upstream surface relative to an episode's stamp.
 *  Four values, deliberately distinct — conflating any two of them tells the
 *  creator something untrue (ADR-0054 决策 6):
 *
 *   none      the surface itself has no formal version yet → nothing to compare
 *   unknown   the episode has NO recorded baseline for it (stamp 0). This is an
 *             absence of information, NOT an old version: every legacy/migrated
 *             episode is here, and calling it outdated would invent a history
 *             the document never recorded.
 *   current   the recorded baseline IS the version in force
 *   outdated  the version in force moved FORWARD past the recorded baseline —
 *             the only state that means "上游已更新"
 *   diverged  the version in force is EARLIER than the recorded baseline (a
 *             pointer rollback: setActiveBrief / approveOutline can select an
 *             older revision). Still a real change to review, but it is not
 *             "outdated", so it is reported as its own state.
 */
export const UPSTREAM_STATE = {
  NONE: "none",
  UNKNOWN: "unknown",
  CURRENT: "current",
  OUTDATED: "outdated",
  DIVERGED: "diverged",
};

export const UPSTREAM_STATE_LABEL = {
  none: "尚无版本",
  unknown: "基线未记录",
  current: "与上游一致",
  outdated: "上游已更新",
  diverged: "上游已回退",
};

/** Classify one surface. `stamped`/`current` are revision numbers, 0 = absent.
 *  Pure and total: every input maps to exactly one state. */
export function surfaceState(stamped, current) {
  if (!current) return UPSTREAM_STATE.NONE;
  if (!stamped) return UPSTREAM_STATE.UNKNOWN; // 0 means UNRECORDED, never "old"
  if (stamped === current) return UPSTREAM_STATE.CURRENT;
  return current > stamped ? UPSTREAM_STATE.OUTDATED : UPSTREAM_STATE.DIVERGED;
}

/** Where each upstream surface is edited — the Impact Review's jump targets. */
export const UPSTREAM_GOTO = {
  brief: "brief",
  outline: "story",
  characters: "characters",
  relationships: "relationships",
  world: "world",
};

// ---- hydration ------------------------------------------------------------- //

export function defaultWorld() {
  const w = {};
  for (const k of WORLD_FIELDS) w[k] = "";
  return w;
}

export function defaultCanon() {
  return { characters: 0, relationships: 0, world: 0 };
}

export function defaultBasedOn() {
  const b = {};
  for (const k of UPSTREAM_KEYS) b[k] = 0; // 0 = never stamped (honest, not "current")
  return b;
}

export function defaultBeats() {
  return { plot: [], character: [], relationship: [], world: [] };
}

export function sanitizeWorld(saved) {
  const src = isObj(saved) ? saved : {};
  const out = { ...src }; // unknown fields survive the round-trip
  for (const k of WORLD_FIELDS) out[k] = str(src[k]);
  return out;
}

export function sanitizeCanon(saved) {
  const src = isObj(saved) ? saved : {};
  return { characters: rev(src.characters), relationships: rev(src.relationships), world: rev(src.world) };
}

export function sanitizeBasedOn(saved) {
  const src = isObj(saved) ? saved : {};
  const out = {};
  for (const k of UPSTREAM_KEYS) out[k] = rev(src[k]);
  return out;
}

function sanitizeRelBeat(b, relIds) {
  if (!isObj(b) || !nonEmpty(b.relationshipId) || !relIds.has(b.relationshipId)) return null;
  return {
    relationshipId: b.relationshipId,
    start: str(b.start),
    event: str(b.event),
    end: str(b.end),
  };
}

/** Hydrate one episode's beats against the entities they reference. A beat
 *  pointing at a character/relationship that no longer exists is dropped: like
 *  Scene bible refs (M7) these are INTERNAL references and must always
 *  resolve — unlike shot refs, which point outside the document. */
export function sanitizeBeats(saved, charIds, relIds) {
  const src = isObj(saved) ? saved : {};
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  // ONE beat per entity per episode — the same rule v10 validation enforces.
  // Hydration must not keep a duplicate a corrupt save carries: it would either
  // round-trip into a document validation then REJECTS (blocking the save) or
  // leave a second, stale beat the UI can never reach (the editors address a
  // beat by entity id). First claim wins, deterministically.
  const charBeats = [];
  const seenChars = new Set();
  for (const b of Array.isArray(src.character) ? src.character : []) {
    if (!isObj(b) || !nonEmpty(b.characterId) || !charIds.has(b.characterId)) continue;
    if (seenChars.has(b.characterId)) continue;
    seenChars.add(b.characterId);
    charBeats.push({ characterId: b.characterId, beat: str(b.beat) });
  }
  const relBeats = [];
  const seenRels = new Set();
  for (const b of Array.isArray(src.relationship) ? src.relationship : []) {
    const rec = sanitizeRelBeat(b, relIds);
    if (!rec || seenRels.has(rec.relationshipId)) continue;
    seenRels.add(rec.relationshipId);
    relBeats.push(rec);
  }
  return {
    plot: strList(src.plot),
    character: charBeats,
    relationship: relBeats,
    world: strList(src.world),
  };
}

/** Hydrate the relationships registry. Each record links EXACTLY TWO distinct,
 *  EXISTING characters; at most one relationship per unordered pair. Anything
 *  else is structurally unusable and dropped (never repaired by guessing). */
export function sanitizeRelationships(saved, charIds) {
  const out = [];
  const taken = new Set();
  const pairs = new Set();
  for (const r of Array.isArray(saved) ? saved : []) {
    if (!isObj(r) || !nonEmpty(r.relationshipId) || taken.has(r.relationshipId)) continue;
    const ids = Array.isArray(r.characterIds) ? r.characterIds.filter(nonEmpty) : [];
    if (ids.length !== 2 || ids[0] === ids[1]) continue;
    if (!charIds.has(ids[0]) || !charIds.has(ids[1])) continue;
    const key = pairKey(ids[0], ids[1]);
    if (pairs.has(key)) continue; // one definition per pair
    taken.add(r.relationshipId);
    pairs.add(key);
    const p = isObj(r.profile) ? r.profile : {};
    const profile = { ...p };
    for (const k of RELATIONSHIP_FIELDS) profile[k] = str(p[k]);
    out.push({ ...r, relationshipId: r.relationshipId, characterIds: [ids[0], ids[1]], profile });
  }
  return out;
}

/** Order-independent key for a character pair — 林照×沈既白 and 沈既白×林照 are
 *  the SAME relationship.
 *
 *  JSON, not a joined string: a characterId is an arbitrary non-empty string
 *  (only runtime-minted ones look like `char-<uuid>`), so ANY separator
 *  character could legally occur inside an id and make two different pairs
 *  collide on one key -- silently merging two distinct relationships.
 *  JSON.stringify of the ordered pair is injective for every input. */
export function pairKey(a, b) {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}

// ---- relationship transitions ---------------------------------------------- //

export function findRelationship(prod, relationshipId) {
  return (prod.relationships || []).find((r) => r.relationshipId === relationshipId) || null;
}

/** The relationship between two characters (order-independent), or null. */
export function relationshipBetween(prod, a, b) {
  const key = pairKey(a, b);
  return (prod.relationships || []).find((r) => pairKey(r.characterIds[0], r.characterIds[1]) === key) || null;
}

export function relationshipsOfCharacter(prod, characterId) {
  return (prod.relationships || []).filter((r) => r.characterIds.includes(characterId));
}

/** Create a Relationship between two EXISTING, DISTINCT characters. Refused
 *  when either character is unknown, when they are the same, or when the pair
 *  already has a definition (one canon per pair). */
export function addRelationship(prod, aId, bId) {
  if (!nonEmpty(aId) || !nonEmpty(bId) || aId === bId) return null;
  const chars = prod.characters || [];
  if (!chars.some((c) => c.characterId === aId) || !chars.some((c) => c.characterId === bId)) return null;
  if (relationshipBetween(prod, aId, bId)) return null;
  const profile = {};
  for (const k of RELATIONSHIP_FIELDS) profile[k] = "";
  const rec = { relationshipId: mintId("rel"), characterIds: [aId, bId], profile };
  if (!Array.isArray(prod.relationships)) prod.relationships = [];
  prod.relationships.push(rec);
  return rec;
}

/** Remove a Relationship — REFUSED while an episode still records a beat for
 *  it: the beat is real creative history and must be released explicitly
 *  (same non-destructive posture as M6/M7 removals). */
export function removeRelationship(prod, relationshipId) {
  if (!findRelationship(prod, relationshipId)) return false;
  if (episodesWithRelationshipBeat(prod, relationshipId).length) return false;
  prod.relationships = prod.relationships.filter((r) => r.relationshipId !== relationshipId);
  return true;
}

/** Update whitelisted definition facets (strings only). */
export function updateRelationship(prod, relationshipId, fields) {
  const r = findRelationship(prod, relationshipId);
  if (!r || !isObj(fields)) return false;
  for (const k of RELATIONSHIP_FIELDS) {
    if (k in fields) r.profile[k] = str(fields[k]);
  }
  return true;
}

/** Every episode that records a beat for this relationship. */
export function episodesWithRelationshipBeat(prod, relationshipId) {
  return (prod.episodes || []).filter((e) =>
    ((e.beats && e.beats.relationship) || []).some((b) => b.relationshipId === relationshipId));
}

/** Every episode that records a beat for this character. */
export function episodesWithCharacterBeat(prod, characterId) {
  return (prod.episodes || []).filter((e) =>
    ((e.beats && e.beats.character) || []).some((b) => b.characterId === characterId));
}

// ---- world transitions ----------------------------------------------------- //

export function updateWorld(prod, fields) {
  if (!isObj(fields)) return false;
  for (const k of WORLD_FIELDS) {
    if (k in fields) prod.world[k] = str(fields[k]);
  }
  return true;
}

// ---- canon revisions ------------------------------------------------------- //

/** Confirm a canon surface as a new REVISION — the only thing that bumps its
 *  number (autosave never does). Returns the new number, or 0 when refused. */
export function confirmCanon(prod, surface) {
  if (!Object.prototype.hasOwnProperty.call(prod.canon, surface)) return 0;
  prod.canon[surface] = rev(prod.canon[surface]) + 1;
  return prod.canon[surface];
}

/** The CURRENT version number of every upstream surface. `brief`/`outline`
 *  reuse the story document's existing pointers (决策 2/6: no parallel
 *  version system); the three canon surfaces use their counters. */
export function upstreamVersions(story, prod) {
  return {
    brief: story && story.brief ? rev(story.brief.active) : 0,
    outline: story ? rev(story.approved) : 0,
    characters: rev(prod.canon.characters),
    relationships: rev(prod.canon.relationships),
    world: rev(prod.canon.world),
  };
}

// ---- episode beats + basedOn ----------------------------------------------- //

function episodeById(prod, episodeId) {
  return (prod.episodes || []).find((e) => e.episodeId === episodeId) || null;
}

/** Replace an episode's PLOT or WORLD beat list (plain string lists). */
export function setEpisodeTextBeats(prod, episodeId, kind, list) {
  const ep = episodeById(prod, episodeId);
  if (!ep || (kind !== "plot" && kind !== "world")) return false;
  ep.beats[kind] = (Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && x.trim());
  return true;
}

/** Set (or clear, with an empty string) a character's beat in this episode.
 *  Refused for an unknown character — a beat must reference real canon. */
export function setEpisodeCharacterBeat(prod, episodeId, characterId, beat) {
  const ep = episodeById(prod, episodeId);
  if (!ep || !(prod.characters || []).some((c) => c.characterId === characterId)) return false;
  const text = str(beat);
  const list = ep.beats.character;
  const i = list.findIndex((b) => b.characterId === characterId);
  if (!text.trim()) {
    if (i >= 0) list.splice(i, 1);
    return true;
  }
  if (i >= 0) list[i] = { characterId, beat: text };
  else list.push({ characterId, beat: text });
  return true;
}

/** Record what a relationship ACTUALLY does in this episode (start → event →
 *  end). This is Episode-level: it never touches the project-level definition.
 *  All three fields blank removes the beat. */
export function setEpisodeRelationshipBeat(prod, episodeId, relationshipId, { start, event, end } = {}) {
  const ep = episodeById(prod, episodeId);
  if (!ep || !findRelationship(prod, relationshipId)) return false;
  const rec = { relationshipId, start: str(start), event: str(event), end: str(end) };
  const list = ep.beats.relationship;
  const i = list.findIndex((b) => b.relationshipId === relationshipId);
  if (!rec.start.trim() && !rec.event.trim() && !rec.end.trim()) {
    if (i >= 0) list.splice(i, 1);
    return true;
  }
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  return true;
}

/** Stamp an episode as based on the CURRENT upstream versions — the creator's
 *  explicit "this episode is up to date with canon" decision. Never automatic:
 *  an upstream revision must not silently re-stamp (or rewrite) an episode. */
export function stampEpisodeUpstream(prod, episodeId, story) {
  const ep = episodeById(prod, episodeId);
  if (!ep) return false;
  ep.basedOn = { ...upstreamVersions(story, prod) };
  return true;
}

/** Deterministic dependency impact for ONE episode.
 *
 *  Every surface is classified by `surfaceState` into exactly one state, and the
 *  three that matter are kept STRICTLY apart:
 *
 *  - `unknown` — no recorded baseline (stamp 0). An episode that predates the
 *    dependency mechanism, or one the creator has never based on anything, lives
 *    here. It is NEVER counted as a change: `count` covers only surfaces with a
 *    recorded baseline that has since moved. Reporting a legacy episode as
 *    「N 个上游更新」 would assert a history the document does not contain.
 *  - `outdated` — the baseline IS recorded and the version in force moved
 *    FORWARD past it. This is the only state that means 上游已更新.
 *  - `diverged` — the baseline is recorded and the version in force is EARLIER
 *    (a pointer rollback via setActiveBrief / approveOutline, or a corrupt stamp
 *    pointing past every real revision). Also a real change to review, but
 *    reported as its own state rather than as "outdated".
 *
 *  `stale` = outdated ∪ diverged, i.e. exactly the surfaces with a recorded
 *  baseline that no longer matches. `count` is its length, so an unknown
 *  baseline can never inflate it.
 *
 *  This is the whole of what the system can prove. Whether a change actually
 *  matters dramatically is an AI SEMANTIC judgement; there is no checker for
 *  it yet, so `semantic` is honestly reported as unavailable. */
export function episodeImpact(prod, episodeId, story) {
  const ep = episodeById(prod, episodeId);
  if (!ep) return null;
  const cur = upstreamVersions(story, prod);
  const stamp = ep.basedOn;
  const surfaces = UPSTREAM_KEYS.map((k) => ({
    key: k,
    label: UPSTREAM_LABEL[k],
    goto: UPSTREAM_GOTO[k],
    from: stamp[k], // the recorded baseline; 0 = 未记录
    current: cur[k], // the version in force; 0 = the surface has none yet
    state: surfaceState(stamp[k], cur[k]),
  }));
  const of = (s) => surfaces.filter((x) => x.state === s);
  const outdated = of(UPSTREAM_STATE.OUTDATED);
  const diverged = of(UPSTREAM_STATE.DIVERGED);
  const unknown = of(UPSTREAM_STATE.UNKNOWN);
  // surfaces the episode COULD be based on (they have a version at all)
  const comparable = surfaces.filter((x) => x.state !== UPSTREAM_STATE.NONE);
  // the episode-level verdict. An actionable CHANGE outranks a missing
  // baseline, which outranks "current"; with nothing comparable at all the
  // honest answer is that no upstream baseline exists yet.
  const state = outdated.length
    ? UPSTREAM_STATE.OUTDATED
    : diverged.length
      ? UPSTREAM_STATE.DIVERGED
      : unknown.length
        ? UPSTREAM_STATE.UNKNOWN
        : comparable.length
          ? UPSTREAM_STATE.CURRENT
          : UPSTREAM_STATE.NONE;
  return {
    episodeId,
    basedOn: stamp,
    current: cur,
    surfaces,
    state,
    outdated,
    diverged,
    unknown,
    /** outdated ∪ diverged — surfaces with a RECORDED baseline that moved. */
    stale: [...outdated, ...diverged],
    /** true once every comparable surface has a recorded baseline */
    baselineRecorded: comparable.length > 0 && unknown.length === 0,
    /** ONLY recorded-baseline changes. An unknown baseline never counts. */
    count: outdated.length + diverged.length,
    // deliberately NOT a fabricated verdict — see the module header
    semantic: { available: false, reason: "AI 语义影响判断尚未接入（需另立 ADR）——当前只给出确定性的版本依赖结论" },
  };
}
