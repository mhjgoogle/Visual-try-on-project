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
  };
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
  };
}

/** Hydrate the bible slice of a persisted production document. Existing ids
 *  survive verbatim; structurally unusable entries are dropped. Character and
 *  Location ids share ONE namespace (entity lookups resolve across both
 *  kinds), so a cross-kind collision drops the later entry deterministically.
 *  Returns { characters, locations }. */
export function sanitizeBible(saved) {
  const characters = [];
  const locations = [];
  const entityIds = new Set(); // one namespace across characters AND locations
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
  }
  return { characters, locations };
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
export function removeCharacter(prod, characterId) {
  const c = findCharacter(prod, characterId);
  if (!c) return false;
  if (scenesReferencingCharacter(prod, characterId).length) return false;
  if (relationshipsOfCharacter(prod, characterId).length) return false;
  if (episodesWithCharacterBeat(prod, characterId).length) return false;
  prod.characters = prod.characters.filter((x) => x.characterId !== characterId);
  return true;
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
export function removeCharacterState(prod, characterId, stateId) {
  const c = findCharacter(prod, characterId);
  if (!c || !findState(c, stateId)) return false;
  if (scenesReferencingCharacter(prod, characterId, stateId).length) return false;
  c.states = c.states.filter((s) => s.stateId !== stateId);
  return true;
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
  return findCharacter(prod, id) || findLocation(prod, id);
}

/** Attach an Asset REFERENCE (M3 assetId) to a character/location. */
export function addReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  if (!e || !nonEmpty(assetId) || e.referenceAssetIds.includes(assetId)) return false;
  e.referenceAssetIds.push(assetId);
  if (!e.activeReferenceAssetId) e.activeReferenceAssetId = assetId; // first ref becomes active
  return true;
}

/** Detach a reference (the Asset itself is untouched — it lives in M3). */
export function removeReferenceAsset(prod, entityId, assetId) {
  const e = entityOf(prod, entityId);
  if (!e || !e.referenceAssetIds.includes(assetId)) return false;
  e.referenceAssetIds = e.referenceAssetIds.filter((x) => x !== assetId);
  if (e.activeReferenceAssetId === assetId) e.activeReferenceAssetId = e.referenceAssetIds[0] || null;
  return true;
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

export function removeLocation(prod, locationId) {
  const l = findLocation(prod, locationId);
  if (!l || scenesReferencingLocation(prod, locationId).length) return false;
  prod.locations = prod.locations.filter((x) => x.locationId !== locationId);
  return true;
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

export function removeLocationState(prod, locationId, stateId) {
  const l = findLocation(prod, locationId);
  if (!l || !findState(l, stateId)) return false;
  if (scenesReferencingLocation(prod, locationId, stateId).length) return false;
  l.states = l.states.filter((s) => s.stateId !== stateId);
  return true;
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
