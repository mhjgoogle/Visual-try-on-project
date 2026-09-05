// Production Bible (checkpoint M7) — project-level Characters & Locations
// with States, living INSIDE the production domain document (schema v7:
// `production.characters` / `production.locations`; scenes gain reference
// fields `characterRefs` / `locationRef`).
//
// IDENTITY MODEL:
// - A Character/Location is ONE stable identity (characterId/locationId,
//   minted once). A State (少女时期/黑化时期; day/night/damaged…) OVERRIDES
//   presentation facets but never becomes a new identity — resolvers always
//   merge base ⊕ state overrides.
// - VOICE RULE: a Character has ONE base voice identity (voice.voiceId). A
//   state may modify performance characteristics (description/performance)
//   but can never carry its own voiceId — enforced here (overrides are
//   whitelisted and voiceId is stripped) AND by v7 validation, so a state can
//   not silently become an unrelated voice.
//
// OWNERSHIP: referenceAssetIds are REFERENCES into the Project Asset
// Registry (M3) — never copies, and (like Generation links, M5) they are not
// required to resolve to a currently present Asset: the bible legitimately
// outlives media bytes. Scenes reference characters/locations BY ID +
// optional state id; full profiles are never duplicated into Scene or Shot.
//
// NON-DESTRUCTIVE: removing a Character/Location or a State that a scene
// still references is REFUSED (release the scene references first) — same
// posture as M6's episode/scene removal rules.
//
// Pure state + transitions only — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";
import { relationshipsOfCharacter, episodesWithCharacterBeat } from "./canondoc.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const str = (x) => (typeof x === "string" ? x : "");
// unique ids only: a duplicated reference renders twice and one removal would
// delete every copy — validation rejects duplicates, hydration dedupes
const idArray = (x) => (Array.isArray(x) ? [...new Set(x.filter(nonEmpty))] : []);

/* --- 回收区：删除是软删除，拿得回来（TASK-129 / CA §5.2） -------------------- //
 *
 * **形状：删掉的记录移进一个单独的数组，不是在原地打标记。**
 *
 * 另一种做法（`storywork.js` 的定稿版本用的那种）是记录留在原数组里、打一个
 * `deleted` 标记，然后**每一个读它的地方**都过滤一次。那在定稿版本上是对的 ——
 * 读它的只有几处。这里不是：`prod.characters` 有约 60 个读点、跨 12 个文件，
 * 其中还包括别人正在改的文件。「每处都要记得过滤」在那个规模上是**六十次犯错
 * 机会**，而漏掉一处的表现是「删掉的人物在那一处继续冒出来」——
 * 不报错，只是错。
 *
 * 移走之后 `prod.characters` 的含义仍然是「活着的那些」，那 60 个读点**一行都
 * 不用改，而且天生正确**。产品行为一模一样，换的只是存储形状。
 *
 * 代价有两条，都是显式的：
 *
 * 1. **回收区必须自己加进读盘水合**（`sanitizeBible` 是显式重建 `{characters,
 *    locations, props}`，顶层没有 spread，不加就会在下次加载时整个丢掉）。
 * 2. **按 id 解析引用的读点要能找到删掉的那些** —— 那类读点要的东西与显示型
 *    正好相反（见 `findCharacterAny`）。
 *
 * 拿回来的记录**追加在数组末尾**，原来的位置不保留。这里的数组序只是插入序、
 * 没有语义（`addCharacter` 也是 push），所以接受它；哪天顺序有了含义，要记的是
 * 一个 `order` 字段，不是靠这里的位置。
 */

/** 移进回收区。`at` 只是给他看的时间戳，不参与任何判定。 */
function binPush(owner, key, rec, at) {
  if (!Array.isArray(owner[key])) owner[key] = [];
  owner[key].push({ ...rec, deletedAt: str(at) });
}

/** 从回收区拿回来：`idKey` 是这类记录的身份字段。 */
function binRestore(owner, key, idKey, id, liveList) {
  const bin = Array.isArray(owner[key]) ? owner[key] : [];
  const i = bin.findIndex((x) => isObj(x) && x[idKey] === id);
  if (i < 0) return false;
  const [rec] = bin.splice(i, 1);
  delete rec.deletedAt;
  liveList.push(rec);
  return true;
}

/** 回收区里的那些（只读，永远返回数组）。 */
const binOf = (owner, key) => (Array.isArray(owner && owner[key]) ? owner[key] : []);

export const deletedCharacters = (prod) => binOf(prod, "deletedCharacters");
export const deletedLocations = (prod) => binOf(prod, "deletedLocations");

/** 按 id 找一个人物，**回收区里的也找**。
 *
 *  和 `findCharacter` 的分工是显式的，因为两类读点要的东西相反：
 *
 *  | 读点 | 用哪个 | 为什么 |
 *  | --- | --- | --- |
 *  | 显示、修改（改名 / 写档案 / 加状态） | `findCharacter` | 删掉的不该被列出来，更不该还能改 |
 *  | 解析引用、判身份唯一、拿回来 | `findCharacterAny` | 「他删了、随时能拿回来」和「这个人物不存在」是两件事 |
 *
 *  今天「被引用就拒删」那道保护让删掉的人物**不可能**还被场景/关系/节拍指着，
 *  所以引用解析实际撞不到回收区。**那道保护因此是承重的** —— 有测试钉住它
 *  （`removeCharacter is REFUSED while a scene references it` 那一族）。哪天它
 *  放宽了，这个解析器就是那时候不至于把「已删除」读成「不存在」的那根线。 */
export function findCharacterAny(prod, characterId) {
  return (
    findCharacter(prod, characterId) ||
    deletedCharacters(prod).find((c) => c.characterId === characterId) ||
    null
  );
}

export function findLocationAny(prod, locationId) {
  return (
    findLocation(prod, locationId) ||
    deletedLocations(prod).find((l) => l.locationId === locationId) ||
    null
  );
}

/** Character TIERS (TASK-057). A `bit` character (服务员 / 路人 / 警察 / 医生)
 *  carries the same identity machinery but is never required to fill in a
 *  complete Character Bible; promoting it to `formal` keeps its id and every
 *  existing reference (scene refs, relationships, beats, reference images). */
export const CHARACTER_TIERS = ["formal", "bit"];

/** A Character's CREATIVE-layer facets (TASK-057). These describe who the
 *  character IS, not how they look in one scene — which is exactly why none of
 *  them is state-overridable (same rule as `personality`): a state is the same
 *  person. `visualInstruction` (基础视觉方向) and `appearance`/`costume` stay the
 *  presentation facets a state may override.
 *
 *  关键关系摘要 is deliberately NOT here: it is DERIVED from the first-class
 *  Relationship objects, so a character never carries a second copy of it. */
export const CHARACTER_CREATIVE_FACETS = [
  "identity",      // 身份
  "desire",        // 欲望 / 目标
  "weakness",      // 弱点
  "coreConflict",  // 核心矛盾
  "arc",           // Character Arc
];

/** Every writable profile facet of a Character. */
export const CHARACTER_PROFILE_FIELDS = [
  "appearance", "costume", "personality", "visualInstruction", ...CHARACTER_CREATIVE_FACETS,
];

// Facets a CharacterState / LocationState may override. personality and the
// voice IDENTITY are deliberately absent: a state is the SAME character.
const CHAR_OVERRIDE_KEYS = ["appearance", "costume", "visualInstruction", "voice", "referenceAssetIds", "activeReferenceAssetId"];
const LOC_OVERRIDE_KEYS = ["description", "visualInstruction", "referenceAssetIds", "activeReferenceAssetId"];

/** A member-or-null active pointer: anything else degrades to null (an active
 *  reference that is not one of the entity's references is meaningless). */
function activeIn(refs, active) {
  return nonEmpty(active) && refs.includes(active) ? active : null;
}

function sanitizeOverrides(saved, keys) {
  const out = {};
  if (!isObj(saved)) return out;
  for (const k of keys) {
    if (!(k in saved)) continue;
    if (k === "voice") {
      if (isObj(saved.voice)) {
        const v = {};
        if ("description" in saved.voice) v.description = str(saved.voice.description);
        if ("performance" in saved.voice && isObj(saved.voice.performance)) v.performance = saved.voice.performance;
        // voiceId is NEVER accepted on a state — same character, same voice
        if (Object.keys(v).length) out.voice = v;
      }
    } else if (k === "referenceAssetIds") {
      out.referenceAssetIds = idArray(saved.referenceAssetIds);
    } else if (k === "activeReferenceAssetId") {
      // self-contained: a state's active ref must live in the state's OWN list
      out.activeReferenceAssetId = activeIn(idArray(saved.referenceAssetIds), saved.activeReferenceAssetId);
    } else {
      out[k] = str(saved[k]);
    }
  }
  return out;
}

function sanitizeStates(list, keys, takenIds) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || !nonEmpty(s.stateId) || takenIds.has(s.stateId)) continue;
    takenIds.add(s.stateId);
    // spread first: an unknown field a future checkpoint added is carried
    // through the load→save round-trip, never silently dropped
    out.push({ ...s, stateId: s.stateId, name: str(s.name), overrides: sanitizeOverrides(s.overrides, keys) });
  }
  return out;
}

function sanitizeCharacter(c, taken, stateIds) {
  if (!isObj(c) || !nonEmpty(c.characterId) || taken.has(c.characterId)) return null;
  taken.add(c.characterId);
  const p = isObj(c.profile) ? c.profile : {};
  const v = isObj(c.voice) ? c.voice : {};
  const refs = idArray(c.referenceAssetIds);
  // spreads: unknown fields survive the round-trip (non-destructive), while
  // every known field is normalized to the shape the app reads
  return {
    ...c,
    characterId: c.characterId,
    name: str(c.name),
    // TASK-057: an unknown/absent tier hydrates as `formal` — an existing
    // character was confirmed by the creator, so silently demoting it to a bit
    // part would be the lossy reading
    tier: CHARACTER_TIERS.includes(c.tier) ? c.tier : "formal",
    profile: {
      ...p,
      ...Object.fromEntries(CHARACTER_PROFILE_FIELDS.map((k) => [k, str(p[k])])),
    },
    referenceAssetIds: refs,
    activeReferenceAssetId: activeIn(refs, c.activeReferenceAssetId),
    voice: {
      ...v,
      voiceId: nonEmpty(v.voiceId) ? v.voiceId : null,
      description: str(v.description),
      performance: isObj(v.performance) ? v.performance : {},
    },
    states: sanitizeStates(c.states, CHAR_OVERRIDE_KEYS, stateIds),
    // 回收区（TASK-129）。`...c` 会把它原样带过往返，但**规范化不能省**：
    // 删掉的状态同样要占住 `stateIds`（它随时可能被拿回来），而摘掉的参考图 id
    // 不过 `idArray` 就会把重复项和空串带进来。
    ...binFields(c, sanitizeStates(c.deletedStates, CHAR_OVERRIDE_KEYS, stateIds)),
  };
}

/** 两个回收区字段：**源里有就规范化，源里没有就不写**。
 *
 *  不能写成「规范化结果为空就不写这个键」—— 调用方是 `{ ...c, ...binFields(c) }`，
 *  `...c` 已经把**未规范化的原值**放进去了。返回空对象只会让那份原值留下，
 *  于是一份带垃圾 `deletedStates` 的文档会原样穿过水合（自测时抓到）。
 *
 *  源里没有这两个键时一个都不加：从没删过东西的旧文档不该因为读了一次就多出
 *  两个空数组，那会让每份旧 canvas.json 在第一次保存时产生一个纯噪音的 diff。 */
function binFields(src, states) {
  const out = {};
  if ("deletedStates" in src) out.deletedStates = states;
  if ("deletedReferenceAssetIds" in src) {
    out.deletedReferenceAssetIds = idArray(src.deletedReferenceAssetIds);
  }
  return out;
}

function sanitizeLocation(l, taken, stateIds) {
  if (!isObj(l) || !nonEmpty(l.locationId) || taken.has(l.locationId)) return null;
  taken.add(l.locationId);
  const p = isObj(l.profile) ? l.profile : {};
  const refs = idArray(l.referenceAssetIds);
  return {
    ...l,
    locationId: l.locationId,
    name: str(l.name),
    profile: { ...p, description: str(p.description), visualInstruction: str(p.visualInstruction) },
    referenceAssetIds: refs,
    activeReferenceAssetId: activeIn(refs, l.activeReferenceAssetId),
    states: sanitizeStates(l.states, LOC_OVERRIDE_KEYS, stateIds),
    ...binFields(l, sanitizeStates(l.deletedStates, LOC_OVERRIDE_KEYS, stateIds)),
  };
}

/**
 * 道具 (TASK-095 §2.2 / TASK-097 批次 4C) — the third thing the ② step prepares.
 *
 * DELIBERATELY SIMPLER THAN A LOCATION: **no states.** A location has 白天 / 夜 /
 * 被砸过 because the same place is re-shot under different conditions; a prop is
 * 一把钥匙, and 「同一把钥匙的两个状态」 is a thing we have never once needed. States
 * cost a whole id namespace, an override whitelist and a resolve path, and an
 * unused one is not free — it is a shape every reader has to understand and every
 * writer can get wrong. If a prop ever does need states, adding them then is
 * additive; taking them away later would not be.
 *
 * Everything else is deliberately identical to a location, because the ② step
 * treats all three kinds the same way: 名称 + 描述摘要 + 设定图.
 */
function sanitizeProp(p, taken) {
  if (!isObj(p) || !nonEmpty(p.propId) || taken.has(p.propId)) return null;
  taken.add(p.propId);
  const prof = isObj(p.profile) ? p.profile : {};
  const refs = idArray(p.referenceAssetIds);
  // `...p` 保留未知字段（非破坏性水合），但 **`states` 必须被摘掉**：道具没有状态，
  // 而 schema 明确拒绝带 states 的道具 —— 留着它，一次 load → save 往返就会产出
  // 一份**自己拒绝加载**的文档（codex 本批 round 2 的 P1）。
  // 这是「宽容地读」与「严格地校验」之间的缝：两边必须对同一件事说同一句话。
  const { states: _ignoredStates, ...rest } = p;
  return {
    ...rest,
    propId: p.propId,
    name: str(p.name),
    profile: {
      ...prof,
      description: str(prof.description),
      visualInstruction: str(prof.visualInstruction),
    },
    referenceAssetIds: refs,
    activeReferenceAssetId: activeIn(refs, p.activeReferenceAssetId),
  };
}

/** Hydrate the bible slice of a persisted production document. Existing ids
 *  survive verbatim; structurally unusable entries are dropped. Character,
 *  Location AND Prop ids share ONE namespace (entity lookups resolve across all
 *  three kinds — see `entityOf`), so a cross-kind collision drops the later
 *  entry deterministically. Returns { characters, locations, props }. */
export function sanitizeBible(saved) {
  const characters = [];
  const locations = [];
  const props = [];
  const deletedCharacters = [];
  const deletedLocations = [];
  const entityIds = new Set(); // one namespace across characters, locations AND props
  const stateIds = new Set(); // unique across the whole bible
  if (isObj(saved)) {
    for (const c of Array.isArray(saved.characters) ? saved.characters : []) {
      const rec = sanitizeCharacter(c, entityIds, stateIds);
      if (rec) characters.push(rec);
    }
    for (const l of Array.isArray(saved.locations) ? saved.locations : []) {
      const rec = sanitizeLocation(l, entityIds, stateIds);
      if (rec) locations.push(rec);
    }
    // 加法字段：老文档没有 `props` 是常态，水合成空数组，一个字节的旧数据不动
    for (const p of Array.isArray(saved.props) ? saved.props : []) {
      const rec = sanitizeProp(p, entityIds);
      if (rec) props.push(rec);
    }
    // 回收区（TASK-129）。**两件事都要做对，各自都会静默出错：**
    //
    // 1. **必须在这里水合。** 这个函数是显式重建 `{characters, locations, props}`
    //    的，顶层没有 spread —— 不加这一段，他删掉的每一个人物都会在下一次加载时
    //    从回收区消失，而「软删除」的全部意义就是那条撤销的路还在。
    // 2. **必须进同一个 id 命名空间。** 删掉的实体仍然占着它的 id，因为它随时可能
    //    被拿回来。不占的话，新建的人物可以拿到一个已删人物的 id，等他点「拿回来」
    //    就撞上一个同名身份 —— 而 `sanitizeCharacter` 遇到重复 id 是**丢弃**，
    //    于是回收区里那条无声消失。
    //
    // 活的先水合、回收区后水合：万一某份文档里同一个 id 两边都有（只可能来自
    // 手改或旧缺陷），**活的那条是权威**，回收区那条按重复 id 丢弃。
    for (const c of Array.isArray(saved.deletedCharacters) ? saved.deletedCharacters : []) {
      const rec = sanitizeCharacter(c, entityIds, stateIds);
      if (rec) deletedCharacters.push(rec);
    }
    for (const l of Array.isArray(saved.deletedLocations) ? saved.deletedLocations : []) {
      const rec = sanitizeLocation(l, entityIds, stateIds);
      if (rec) deletedLocations.push(rec);
    }
  }
  return { characters, locations, props, deletedCharacters, deletedLocations };
}

/** Sanitize a scene's bible references against the hydrated entities: a ref
 *  to a character/location (or state) that does not exist is dropped — the
 *  document's internal references are always resolvable (unlike shot refs,
 *  which point OUTSIDE the document and stay dangling-but-kept). */
export function sanitizeSceneRefs(scene, characters, locations) {
  const byChar = new Map(characters.map((c) => [c.characterId, c]));
  const byLoc = new Map(locations.map((l) => [l.locationId, l]));
  const refs = [];
  const seen = new Set();
  for (const r of Array.isArray(scene.characterRefs) ? scene.characterRefs : []) {
    if (!isObj(r) || !nonEmpty(r.characterId) || seen.has(r.characterId)) continue;
    const c = byChar.get(r.characterId);
    if (!c) continue;
    seen.add(r.characterId);
    const stateId = nonEmpty(r.stateId) && c.states.some((s) => s.stateId === r.stateId) ? r.stateId : null;
    refs.push({ characterId: r.characterId, stateId });
  }
  scene.characterRefs = refs;
  const lr = scene.locationRef;
  if (isObj(lr) && nonEmpty(lr.locationId) && byLoc.has(lr.locationId)) {
    const l = byLoc.get(lr.locationId);
    const stateId = nonEmpty(lr.stateId) && l.states.some((s) => s.stateId === lr.stateId) ? lr.stateId : null;
    scene.locationRef = { locationId: lr.locationId, stateId };
  } else {
    scene.locationRef = null;
  }
  return scene;
}

// ---- lookups --------------------------------------------------------------- //

export function findCharacter(prod, characterId) {
  return (prod.characters || []).find((c) => c.characterId === characterId) || null;
}

export function findLocation(prod, locationId) {
  return (prod.locations || []).find((l) => l.locationId === locationId) || null;
}

function findState(entity, stateId) {
  return entity.states.find((s) => s.stateId === stateId) || null;
}

/** Every scene (across all episodes) whose refs mention this character. */
export function scenesReferencingCharacter(prod, characterId, stateId = null) {
  const out = [];
  for (const e of prod.episodes) {
    for (const s of e.scenes) {
      for (const r of s.characterRefs || []) {
        if (r.characterId === characterId && (stateId === null || r.stateId === stateId)) out.push(s);
      }
    }
  }
  return out;
}

export function scenesReferencingLocation(prod, locationId, stateId = null) {
  const out = [];
  for (const e of prod.episodes) {
    for (const s of e.scenes) {
      const r = s.locationRef;
      if (r && r.locationId === locationId && (stateId === null || r.stateId === stateId)) out.push(s);
    }
  }
  return out;
}

/* ---- seeding the cast from the outline (TASK-070) --------------------------- */
//
// 人物设定 sits BETWEEN 故事大纲 and 分集规划 in the creative spine, but until now
// the only way to get a character was 剧本拆解 — which reads an episode SCRIPT, two
// steps LATER. So the one place the cast belongs could not be filled until after the
// place that depends on it. The outline already carries 主要角色概念
// (`outline.characterConcepts`); this turns them into the初始 cast.
//
// BOTH PATHS COEXIST (产品 2026-08-13): this seeds the INITIAL cast from the
// outline; 剧本拆解 keeps refining and adding as the scripts get written. Neither
// replaces the other.
//
// A PROPOSAL, NOT A WRITE. This function only DERIVES what could be created; the
// creator confirms each row. That keeps M9 rule 8's intent intact — the outline
// still never writes canon by itself, a person does.

/** Separators a concept line uses between the NAME and the rest. Ordered longest
 *  first so 「——」 is not split by the single 「—」. */
const CONCEPT_SEPARATORS = ["——", "：", ":", " - ", "—", "、", "，", ",", "|"];

/**
 * Split one concept string into a suggested name and the rest.
 *
 * 「林晚 —— 夜班调酒师，不肯交出录音」 → { name: "林晚", identity: "夜班调酒师，不肯交出录音" }
 *
 * A GUESS, and treated as one: the caller shows the name in an EDITABLE field so
 * the creator corrects it before anything is created. Silently naming a character
 * from a heuristic is exactly what this codebase refuses to do — showing the guess
 * and letting a person approve it is not the same thing.
 *
 * A concept with no separator is a bare name and carries no identity text.
 */
export function splitCharacterConcept(concept) {
  const raw = str(concept).trim();
  if (!raw) return null;
  for (const sep of CONCEPT_SEPARATORS) {
    const i = raw.indexOf(sep);
    // a separator at position 0 would leave an empty name
    if (i > 0) {
      const name = raw.slice(0, i).trim();
      const identity = raw.slice(i + sep.length).trim();
      if (name) return { name, identity };
    }
  }
  return { name: raw, identity: "" };
}

/**
 * What the outline's character concepts could seed, joined against the cast that
 * already exists.
 *
 * `exists` is matched by NAME, trimmed — the only join two independently written
 * lists can honestly have. A concept whose name is already in the bible is reported
 * as `exists` rather than being offered again, so pressing 创建 twice cannot produce
 * a duplicate 林晚.
 */
export function characterSeedsFromConcepts(prod, concepts) {
  const have = new Map(
    ((prod && prod.characters) || []).map((c) => [str(c.name).trim(), c.characterId]),
  );
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(concepts) ? concepts : []) {
    const split = splitCharacterConcept(c);
    if (!split) continue;
    // the same concept twice in one outline is one character
    const key = `${split.name}|${split.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      concept: str(c).trim(),
      name: split.name,
      identity: split.identity,
      exists: have.has(split.name),
      characterId: have.get(split.name) || null,
    });
  }
  return out;
}

// ---- character transitions -------------------------------------------------- //

/** Add a Character. `tier` defaults to a FORMAL character; pass "bit" for a
 *  temporary / episode character (服务员、路人…) that is not expected to carry a
 *  full Character Bible. A character may be added at ANY point in the project —
 *  nothing requires the cast to be complete up front. */
export function addCharacter(prod, name, tier = "formal") {
  const c = {
    characterId: mintId("char"),
    name: nonEmpty(name) ? name : `角色 ${prod.characters.length + 1}`,
    tier: CHARACTER_TIERS.includes(tier) ? tier : "formal",
    profile: Object.fromEntries(CHARACTER_PROFILE_FIELDS.map((k) => [k, ""])),
    referenceAssetIds: [],
    activeReferenceAssetId: null,
    voice: { voiceId: null, description: "", performance: {} },
    states: [],
  };
  prod.characters.push(c);
  return c;
}

/** Change a character's tier. PROMOTION (bit → formal) keeps the identity and
 *  therefore every existing reference: scene refs, relationships, episode
 *  beats and reference images all continue to point at the same characterId
 *  (ADR-0054 决策 7). Demotion is symmetric and equally non-destructive. */
export function setCharacterTier(prod, characterId, tier) {
  const c = findCharacter(prod, characterId);
  if (!c || !CHARACTER_TIERS.includes(tier)) return false;
  c.tier = tier;
  return true;
}

export function renameCharacter(prod, characterId, name) {
  const c = findCharacter(prod, characterId);
  if (!c || typeof name !== "string" || !name.trim()) return false;
  c.name = name;
  return true;
}

/** Remove a Character — REFUSED while anything still references it: a scene
 *  (M7), a Relationship definition or an episode Character Beat (TASK-057).
 *  Cascading would silently destroy creator canon, so the references must be
 *  released explicitly first. */
export function removeCharacter(prod, characterId, at = "") {
  const c = findCharacter(prod, characterId);
  if (!c) return false;
  if (scenesReferencingCharacter(prod, characterId).length) return false;
  if (relationshipsOfCharacter(prod, characterId).length) return false;
  if (episodesWithCharacterBeat(prod, characterId).length) return false;
  prod.characters = prod.characters.filter((x) => x.characterId !== characterId);
  binPush(prod, "deletedCharacters", c, at);
  return true;
}

/** 把删掉的人物拿回来。 */
export function undeleteCharacter(prod, characterId) {
  return binRestore(prod, "deletedCharacters", "characterId", characterId, prod.characters);
}

/** Update canonical profile facets (whitelisted string fields only). */
export function updateCharacterProfile(prod, characterId, fields) {
  const c = findCharacter(prod, characterId);
  if (!c || !isObj(fields)) return false;
  for (const k of CHARACTER_PROFILE_FIELDS) {
    if (k in fields) c.profile[k] = str(fields[k]);
  }
  return true;
}

/** Set the BASE voice — the character's one voice identity. */
export function setCharacterVoice(prod, characterId, voice) {
  const c = findCharacter(prod, characterId);
  if (!c || !isObj(voice)) return false;
  if ("voiceId" in voice) c.voice.voiceId = nonEmpty(voice.voiceId) ? voice.voiceId : null;
  if ("description" in voice) c.voice.description = str(voice.description);
  if ("performance" in voice && isObj(voice.performance)) c.voice.performance = voice.performance;
  return true;
}

export function addCharacterState(prod, characterId, name) {
  const c = findCharacter(prod, characterId);
  if (!c) return null;
  const s = { stateId: mintId("cstate"), name: nonEmpty(name) ? name : `状态 ${c.states.length + 1}`, overrides: {} };
  c.states.push(s);
  return s;
}

export function renameCharacterState(prod, characterId, stateId, name) {
  const c = findCharacter(prod, characterId);
  const s = c && findState(c, stateId);
  if (!s || typeof name !== "string" || !name.trim()) return false;
  s.name = name;
  return true;
}

/** Remove a state — REFUSED while a scene references the character IN that
 *  state (the identity stays; only the unreferenced presentation goes). */
export function removeCharacterState(prod, characterId, stateId, at = "") {
  const c = findCharacter(prod, characterId);
  const s = c && findState(c, stateId);
  if (!s) return false;
  if (scenesReferencingCharacter(prod, characterId, stateId).length) return false;
  c.states = c.states.filter((x) => x.stateId !== stateId);
  // 状态的回收区挂在**它自己的实体**上：状态 id 是实体内部的，跟着实体走才对 ——
  // 人物删进回收区时，他的状态回收区一并跟着走，拿回来时也一并回来。
  binPush(c, "deletedStates", s, at);
  return true;
}

export function undeleteCharacterState(prod, characterId, stateId) {
  const c = findCharacter(prod, characterId);
  return !!c && binRestore(c, "deletedStates", "stateId", stateId, c.states);
}

/** Replace a state's overrides (whitelisted facets; voice identity stripped). */
export function setCharacterStateOverrides(prod, characterId, stateId, overrides) {
  const c = findCharacter(prod, characterId);
  const s = c && findState(c, stateId);
  if (!s) return false;
  s.overrides = sanitizeOverrides(overrides, CHAR_OVERRIDE_KEYS);
  return true;
}

// ---- reference assets (shared by characters & locations) --------------------- //

function entityOf(prod, id) {
  // 三类共用**一处**解析。参考图的挂接 / 摘除 / 设主图因此对道具天生就成立 ——
  // 如果道具另写一份，那就是 §2.5e 那条缝：两处陈述「参考图怎么挂在实体上」。
  return findCharacter(prod, id) || findLocation(prod, id) || findProp(prod, id);
}

/** Attach an Asset REFERENCE (M3 assetId) to a character/location. */
export function addReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  if (!e || !nonEmpty(assetId) || e.referenceAssetIds.includes(assetId)) return false;
  e.referenceAssetIds.push(assetId);
  if (!e.activeReferenceAssetId) e.activeReferenceAssetId = assetId; // first ref becomes active
  return true;
}

/** Detach a reference (the Asset itself is untouched — it lives in M3).
 *
 *  摘下来的**引用**进回收区。字节本来就没删（资产在 M3 里），但「这张图曾经挂在
 *  这个实体上、而且是主图」这个事实会丢 —— 那就是他要撤销的东西。
 *  这里的回收区是一串 id，形状与实体/状态那两处不同，理由是原数组本身就是一串 id。 */
export function removeReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  if (!e || !e.referenceAssetIds.includes(assetId)) return false;
  e.referenceAssetIds = e.referenceAssetIds.filter((x) => x !== assetId);
  if (!Array.isArray(e.deletedReferenceAssetIds)) e.deletedReferenceAssetIds = [];
  if (!e.deletedReferenceAssetIds.includes(assetId)) e.deletedReferenceAssetIds.push(assetId);
  if (e.activeReferenceAssetId === assetId) e.activeReferenceAssetId = e.referenceAssetIds[0] || null;
  return true;
}

/** 把摘下来的参考图挂回去。
 *
 *  **不恢复「主图」身份** —— 摘掉主图时主图位已经让给了别人，硬抢回来会覆盖他之后
 *  做的选择。第一张挂上去时才自动成为主图（`addReferenceAsset` 的既有规矩），
 *  这里沿用：只有实体当前一张参考图都没有时，拿回来的这张才顺位成为主图。 */
export function undeleteReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  const bin = e && Array.isArray(e.deletedReferenceAssetIds) ? e.deletedReferenceAssetIds : null;
  if (!bin || !bin.includes(assetId)) return false;
  e.deletedReferenceAssetIds = bin.filter((x) => x !== assetId);
  if (!e.referenceAssetIds.includes(assetId)) e.referenceAssetIds.push(assetId);
  if (!e.activeReferenceAssetId) e.activeReferenceAssetId = assetId;
  return true;
}

/**
 * 给一个**状态**加一张参考图之后，它的 overrides 该变成什么样（纯决策）。
 *
 * 状态的参考图是对基础档案那份清单的**覆盖**：没写 `referenceAssetIds` 时它继承
 * 基础的那份，一写就整份接管。
 *
 * 规矩只有一条：**加一张次要参考图，永远不顶掉当前生效的主图。**
 * 「生效的主图」= 状态自己写了就用它，没写就继承基础档案的。只有当生效的那张
 * 已经不在新清单里（第一次加状态专属图、显式设成「没有主图」、或者原主图被摘掉）
 * 时，新加的这张才顺位成为主图。
 *
 * 重复添加返回 `null`（是空操作，不是失败）。
 *
 * **为什么住在这一层**（TASK-129 切片 2e）：它是一条决策，不是渲染。原先它住在
 * `ui/workspaces.js`，于是动作表要用它就得 `workflow/` 反向 import `ui/` —— 撞
 * CA §2 的依赖方向。结果是状态级参考图那四个入口一直进不了动作表，棘轮上挂着
 * `setCharacterStateOverrides` / `setLocationStateOverrides` 两个名字下不来。
 * 搬过来之后两边都对：UI 只管接线，动作表拿得到同一条决策。
 */
export function nextStateRefsOnAdd(entity, overrides, assetId) {
  const cur = Array.isArray(overrides.referenceAssetIds) ? overrides.referenceAssetIds : [];
  if (cur.includes(assetId)) return null;
  const refs = [...cur, assetId];
  const next = { ...overrides, referenceAssetIds: refs };
  const effective = "activeReferenceAssetId" in overrides
    ? overrides.activeReferenceAssetId
    : entity.activeReferenceAssetId; // 继承来的基础主图
  if (!(effective != null && refs.includes(effective))) next.activeReferenceAssetId = assetId;
  return next;
}

export function setActiveReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  if (!e) return false;
  if (assetId === null) { e.activeReferenceAssetId = null; return true; }
  if (!e.referenceAssetIds.includes(assetId)) return false;
  e.activeReferenceAssetId = assetId;
  return true;
}

// ---- location transitions ---------------------------------------------------- //

// ---- 道具 (TASK-095 §2.2 / 批次 4C) ----------------------------------------- //
//
// 与场景地同构，少了 states（理由见 `sanitizeProp`）。写路径与人物 / 场景地一致，
// 所以 ② 步那三组卡片是**同一个组件**读三份同构数据，而不是三套代码。

export function findProp(prod, propId) {
  if (!isObj(prod) || !Array.isArray(prod.props)) return null;
  return prod.props.find((p) => p.propId === propId) || null;
}

export function addProp(prod, name) {
  if (!Array.isArray(prod.props)) prod.props = [];
  const p = {
    propId: mintId("prop"),
    name: nonEmpty(name) ? name : `道具 ${prod.props.length + 1}`,
    profile: { description: "", visualInstruction: "" },
    referenceAssetIds: [],
    activeReferenceAssetId: null,
  };
  prod.props.push(p);
  return p;
}

export function renameProp(prod, propId, name) {
  const p = findProp(prod, propId);
  if (!p || typeof name !== "string" || !name.trim()) return false;
  p.name = name;
  return true;
}

export function removeProp(prod, propId) {
  const p = findProp(prod, propId);
  if (!p) return false;
  prod.props = prod.props.filter((x) => x.propId !== propId);
  return true;
}

export function updatePropProfile(prod, propId, fields) {
  const p = findProp(prod, propId);
  if (!p || !isObj(fields)) return false;
  for (const k of ["description", "visualInstruction"]) {
    if (k in fields) p.profile[k] = str(fields[k]);
  }
  return true;
}

export function addLocation(prod, name) {
  const l = {
    locationId: mintId("loc"),
    name: nonEmpty(name) ? name : `场景地 ${prod.locations.length + 1}`,
    profile: { description: "", visualInstruction: "" },
    referenceAssetIds: [],
    activeReferenceAssetId: null,
    states: [],
  };
  prod.locations.push(l);
  return l;
}

export function renameLocation(prod, locationId, name) {
  const l = findLocation(prod, locationId);
  if (!l || typeof name !== "string" || !name.trim()) return false;
  l.name = name;
  return true;
}

export function removeLocation(prod, locationId, at = "") {
  const l = findLocation(prod, locationId);
  if (!l || scenesReferencingLocation(prod, locationId).length) return false;
  prod.locations = prod.locations.filter((x) => x.locationId !== locationId);
  binPush(prod, "deletedLocations", l, at);
  return true;
}

/** 把删掉的场景地拿回来。 */
export function undeleteLocation(prod, locationId) {
  return binRestore(prod, "deletedLocations", "locationId", locationId, prod.locations);
}

export function updateLocationProfile(prod, locationId, fields) {
  const l = findLocation(prod, locationId);
  if (!l || !isObj(fields)) return false;
  for (const k of ["description", "visualInstruction"]) {
    if (k in fields) l.profile[k] = str(fields[k]);
  }
  return true;
}

export function addLocationState(prod, locationId, name) {
  const l = findLocation(prod, locationId);
  if (!l) return null;
  const s = { stateId: mintId("lstate"), name: nonEmpty(name) ? name : `状态 ${l.states.length + 1}`, overrides: {} };
  l.states.push(s);
  return s;
}

export function renameLocationState(prod, locationId, stateId, name) {
  const l = findLocation(prod, locationId);
  const s = l && findState(l, stateId);
  if (!s || typeof name !== "string" || !name.trim()) return false;
  s.name = name;
  return true;
}

export function removeLocationState(prod, locationId, stateId, at = "") {
  const l = findLocation(prod, locationId);
  const s = l && findState(l, stateId);
  if (!s) return false;
  if (scenesReferencingLocation(prod, locationId, stateId).length) return false;
  l.states = l.states.filter((x) => x.stateId !== stateId);
  binPush(l, "deletedStates", s, at);
  return true;
}

export function undeleteLocationState(prod, locationId, stateId) {
  const l = findLocation(prod, locationId);
  return !!l && binRestore(l, "deletedStates", "stateId", stateId, l.states);
}

export function setLocationStateOverrides(prod, locationId, stateId, overrides) {
  const l = findLocation(prod, locationId);
  const s = l && findState(l, stateId);
  if (!s) return false;
  s.overrides = sanitizeOverrides(overrides, LOC_OVERRIDE_KEYS);
  return true;
}

// ---- scene ↔ bible references ------------------------------------------------- //

function sceneById(prod, sceneId) {
  for (const e of prod.episodes) {
    const s = e.scenes.find((x) => x.sceneId === sceneId);
    if (s) return s;
  }
  return null;
}

/** Put a character (in an optional state) into a scene — by ID only, at most
 *  one ref per character per scene. */
export function addSceneCharacter(prod, sceneId, characterId, stateId = null) {
  const s = sceneById(prod, sceneId);
  const c = findCharacter(prod, characterId);
  if (!s || !c) return false;
  if ((s.characterRefs || []).some((r) => r.characterId === characterId)) return false;
  if (stateId !== null && !findState(c, stateId)) return false;
  if (!Array.isArray(s.characterRefs)) s.characterRefs = [];
  s.characterRefs.push({ characterId, stateId });
  return true;
}

/** Switch WHICH state the scene shows the character in — same identity. */
export function setSceneCharacterState(prod, sceneId, characterId, stateId) {
  const s = sceneById(prod, sceneId);
  const c = findCharacter(prod, characterId);
  const r = s && (s.characterRefs || []).find((x) => x.characterId === characterId);
  if (!r || !c) return false;
  if (stateId !== null && !findState(c, stateId)) return false;
  r.stateId = stateId;
  return true;
}

export function removeSceneCharacter(prod, sceneId, characterId) {
  const s = sceneById(prod, sceneId);
  if (!s || !(s.characterRefs || []).some((r) => r.characterId === characterId)) return false;
  s.characterRefs = s.characterRefs.filter((r) => r.characterId !== characterId);
  return true;
}

/** Set (or clear, with null) the scene's location reference. */
export function setSceneLocation(prod, sceneId, locationId, stateId = null) {
  const s = sceneById(prod, sceneId);
  if (!s) return false;
  if (locationId === null) { s.locationRef = null; return true; }
  const l = findLocation(prod, locationId);
  if (!l) return false;
  if (stateId !== null && !findState(l, stateId)) return false;
  s.locationRef = { locationId, stateId };
  return true;
}

// ---- resolvers (pure read models) ---------------------------------------------- //

/** The EFFECTIVE character presentation for an optional state: base profile ⊕
 *  state overrides. The identity never changes — characterId and the base
 *  voiceId always come from the base record; a state contributes only
 *  performance characteristics. Unknown stateId resolves to the BASE with
 *  `stateResolved: false` (honest, never guessed). */
export function resolveCharacter(character, stateId = null) {
  const c = character;
  const s = stateId === null ? null : findState(c, stateId);
  const o = s ? s.overrides : {};
  const refs = "referenceAssetIds" in o ? o.referenceAssetIds : c.referenceAssetIds;
  // the resolved active ref must be a member of the RESOLVED list: a state
  // that overrides the reference list without naming an active one must not
  // inherit a base active that is outside its own list
  const active = "activeReferenceAssetId" in o ? o.activeReferenceAssetId : c.activeReferenceAssetId;
  return {
    characterId: c.characterId,
    name: c.name,
    stateId: s ? s.stateId : null,
    stateName: s ? s.name : null,
    stateResolved: stateId === null || !!s,
    appearance: "appearance" in o ? o.appearance : c.profile.appearance,
    costume: "costume" in o ? o.costume : c.profile.costume,
    personality: c.profile.personality, // never state-overridden
    visualInstruction: "visualInstruction" in o ? o.visualInstruction : c.profile.visualInstruction,
    voice: {
      voiceId: c.voice.voiceId, // ALWAYS the base identity (voice rule)
      description: o.voice && "description" in o.voice ? o.voice.description : c.voice.description,
      performance: o.voice && "performance" in o.voice ? o.voice.performance : c.voice.performance,
    },
    referenceAssetIds: refs,
    activeReferenceAssetId: active !== null && refs.includes(active) ? active : null,
  };
}

/** The EFFECTIVE location presentation for an optional state (same rules). */
export function resolveLocation(location, stateId = null) {
  const l = location;
  const s = stateId === null ? null : findState(l, stateId);
  const o = s ? s.overrides : {};
  const refs = "referenceAssetIds" in o ? o.referenceAssetIds : l.referenceAssetIds;
  // same membership clamp as resolveCharacter (see comment there)
  const active = "activeReferenceAssetId" in o ? o.activeReferenceAssetId : l.activeReferenceAssetId;
  return {
    locationId: l.locationId,
    name: l.name,
    stateId: s ? s.stateId : null,
    stateName: s ? s.name : null,
    stateResolved: stateId === null || !!s,
    description: "description" in o ? o.description : l.profile.description,
    visualInstruction: "visualInstruction" in o ? o.visualInstruction : l.profile.visualInstruction,
    referenceAssetIds: refs,
    activeReferenceAssetId: active !== null && refs.includes(active) ? active : null,
  };
}
