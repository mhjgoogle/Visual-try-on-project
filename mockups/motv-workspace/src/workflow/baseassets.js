// 基础资产 (TASK-065 §1 / §4) — the long-lived, reusable assets that belong to a
// bible ENTITY rather than to one shot.
//
//   人物   Reference Image · 每个 Character State 的 Reference · 基础生图 Prompt · Base Voice
//   场景地  Reference Image · 每个 Location State 的 Reference · 场景基础 Prompt
//
// WHY THIS MODULE EXISTS. Before it, a character was text and a shot was media,
// and nothing said 「林婉长这样，下游镜头直接复用」. The pieces were all already in
// the domain — they were simply never gathered into one answer, so the creator had
// to know that a state's reference list lives in `states[].overrides` and that a
// voice identity lives on the character while its performance lives on the state.
//
// NOT A SECOND IMAGE DATABASE (§1 的硬约束). Every value here is READ from state
// that already exists:
//
//   base references     character.referenceAssetIds / location.referenceAssetIds
//   state references    state.overrides.referenceAssetIds  ← the domain already
//                       whitelists this key (bibledoc CHAR_OVERRIDE_KEYS), so a
//                       state reference needs no new field and no new store
//   base voice          character.voice.{voiceId,description}
//   media bytes         the Asset Registry (assetUploads / audio maps)
//   prompt overrides    workflow/promptdoc.js, under a NAMESPACED key (below)
//
// Writes go through `ctx.bible.*` and `ctx.assets.importReference` exactly as
// before. This module never mutates anything.
//
// Pure derivation — no fetch, no DOM, no clock.

import { resolveCharacter, resolveLocation } from "./bibledoc.js";
import { slotEntry } from "./mediaref.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const s = (x) => (typeof x === "string" ? x.trim() : "");

/** The two entity kinds that carry base assets. */
export const BASE_ASSET_KINDS = ["character", "location"];

/** The declared Asset kind a base reference of each entity kind is registered
 *  as. Stated once here so the upload path, the library picker and the gap
 *  report cannot disagree about what a 人物参考 is. */
export const BASE_REFERENCE_KIND = {
  character: "character-reference",
  location: "location-reference",
};

/**
 * The promptdoc key ONE entity (optionally in one state) stores its base prompt
 * override under.
 *
 * REUSE, DELIBERATELY. `workflow/promptdoc.js` already implements exactly what a
 * base prompt needs — append-only versions, an active pointer, `active: 0`
 * meaning 「用自动编译」, and Lock — and it is keyed by an ARBITRARY string. A
 * second prompt store would mean a second set of version rules to drift from the
 * first, and a second Lock the automation layer could forget to consult.
 *
 * The `base:` prefix is what keeps the namespaces apart: a shotId is arbitrary
 * persisted text, so an entity key that could ever equal one would let a
 * character's prompt be served for a shot. Nothing mints a shotId starting with
 * `base:`, and this is the only writer of that prefix.
 */
export function basePromptKey(kind, entityId, stateId = null) {
  if (!BASE_ASSET_KINDS.includes(kind) || !s(entityId)) return null;
  const tail = s(stateId) ? `|${s(stateId)}` : "";
  return `base:${kind}:${s(entityId)}${tail}`;
}

/**
 * The name to SUGGEST for a reference the creator just uploaded — 「林婉 / 少女时期」.
 *
 * DERIVED, NOT GENERATED, and the UI says so. It is composed from the entity name
 * and the state the upload was made under, which is precisely the information §1
 * lists (人物名 · Character State · 上下文). Calling a model for it would add a
 * failure mode and a wait to a value that is already determined, and would make
 * the label 「AI 提议」 mean something weaker than it does elsewhere in this app,
 * where a proposal is a recorded Skill Run with an accept/ignore decision.
 *
 * ALWAYS A SUGGESTION. The caller shows it pre-filled and editable and registers
 * only what the creator confirmed — an auto-applied name is a write nobody made.
 */
export function suggestReferenceName({ entityName, stateName, seq = 0 } = {}) {
  const base = s(entityName);
  if (!base) return "";
  const st = s(stateName);
  const head = st ? `${base} / ${st}` : `${base} / 日常`;
  return seq > 1 ? `${head} ${seq}` : head;
}

/** Every image asset in the registry, keyed by assetId, with the chain it came
 *  from. The chain key matters: a reference bound to a shot is addressed by its
 *  `ref-…` key, so a base asset has to be able to name it. */
function imageIndex(assetUploads) {
  const byAsset = new Map();
  for (const key of Object.keys(assetUploads || {})) {
    const e = slotEntry(assetUploads, key);
    if (!e) continue;
    for (const r of e.history) {
      if (!r || !s(r.assetId)) continue;
      byAsset.set(r.assetId, {
        assetId: r.assetId,
        key,
        version: r.version,
        url: r.url || "",
        displayName: s(r.displayName),
        kind: s(r.kind) || null,
        storageState: s(r.storageState) || "local",
        current: r.version === e.current,
      });
    }
  }
  return byAsset;
}

/** Resolve a list of assetIds into a reference view. A MISSING asset is kept and
 *  marked — a bible reference legitimately outlives its media bytes (M7), and
 *  dropping it would make the card claim the creator never attached anything. */
function refView(ids, active, byAsset) {
  return (Array.isArray(ids) ? ids : []).map((id) => {
    const a = byAsset.get(id) || null;
    return {
      assetId: id,
      key: a ? a.key : null,
      version: a ? a.version : null,
      url: a ? a.url : "",
      name: a ? (a.displayName || `${a.key} v${a.version}`) : id,
      storageState: a ? a.storageState : "unknown",
      missing: !a,
      active: id === active,
    };
  });
}

/**
 * The uploaded BASE VOICE SAMPLE of a character, if there is one.
 *
 * FOUND BY LINK, NOT BY `voice.voiceId`. `voiceId` is the voice IDENTITY string
 * the TTS path passes to the engine (app.js `ttsDialogue` refuses to run without
 * it), so overwriting it with a media chain key would break local dialogue
 * generation. The sample is therefore an ordinary registered audio Asset declared
 * `voice-reference` and LINKED to the character — the same declaration mechanism
 * every other reference uses.
 *
 * The newest version of the newest matching chain wins, and 「没有」 is reported as
 * null rather than as an empty player.
 */
function voiceSample(audioMap, characterId) {
  const want = s(characterId);
  if (!want) return null;
  let best = null;
  for (const key of Object.keys(audioMap || {})) {
    const e = slotEntry(audioMap, key);
    if (!e) continue;
    const cur = e.history.find((r) => r.version === e.current) || null;
    if (!cur || cur.kind !== "voice-reference") continue;
    if (!cur.links || cur.links.characterId !== want) continue;
    const cand = {
      key,
      assetId: cur.assetId || null,
      url: cur.url || "",
      version: cur.version,
      versions: e.history.length,
      storageState: s(cur.storageState) || "local",
      at: s(cur.at) || "",
    };
    // deterministic tie-break: the later `at`, then the later key, so the same
    // registry always yields the same sample
    if (!best || cand.at > best.at || (cand.at === best.at && cand.key > best.key)) best = cand;
  }
  return best;
}

/**
 * ONE entity's base assets.
 *
 * `states[]` carries a per-state reference view. `inherited: true` means the state
 * has NO `referenceAssetIds` override and therefore shows the character's own
 * references — which is a different fact from 「这个状态有 0 张参考图」, and the two
 * must not render the same: only the second one is a gap.
 */
export function entityBaseAssets({ kind, entity, byAsset, audioMap, prompt = null }) {
  const isChar = kind === "character";
  const id = isChar ? entity.characterId : entity.locationId;
  const resolveOne = isChar ? resolveCharacter : resolveLocation;
  const base = resolveOne(entity, null);
  const baseRefs = refView(entity.referenceAssetIds, entity.activeReferenceAssetId, byAsset);
  const states = (entity.states || []).map((st) => {
    const resolved = resolveOne(entity, st.stateId);
    const own = "referenceAssetIds" in (st.overrides || {});
    return {
      stateId: st.stateId,
      name: st.name,
      overrides: st.overrides || {},
      resolved,
      inherited: !own,
      refs: own
        ? refView(resolved.referenceAssetIds, resolved.activeReferenceAssetId, byAsset)
        : baseRefs,
      promptKey: basePromptKey(kind, id, st.stateId),
      // a state's suggested reference name — the pair the creator sees on upload
      suggestedName: suggestReferenceName({ entityName: entity.name, stateName: st.name }),
    };
  });
  const voice = isChar
    ? {
        voiceId: entity.voice.voiceId,
        description: entity.voice.description,
        sample: voiceSample(audioMap, id),
        // a state may adjust PERFORMANCE only — never the identity (bibledoc's
        // voice rule). Surfaced so the card can show what each state does to the
        // voice without implying a state can have a different one.
        statePerformance: (entity.states || [])
          .filter((st) => st.overrides && st.overrides.voice && s(st.overrides.voice.description))
          .map((st) => ({ stateId: st.stateId, name: st.name, description: st.overrides.voice.description })),
      }
    : null;
  // WHAT IS STILL MISSING, named with where to fix it. Reference and voice gaps
  // are separate facts: a character with a portrait and no voice is not
  // 「half set up」 in one number, it is ready to appear and not ready to speak.
  const gaps = [];
  if (!baseRefs.some((r) => !r.missing)) gaps.push(isChar ? "还没有人物参考图" : "还没有场景参考图");
  else if (!baseRefs.some((r) => r.active)) gaps.push("参考图还没有选定主图");
  for (const st of states) {
    if (st.inherited) continue;
    if (!st.refs.some((r) => !r.missing)) gaps.push(`状态「${st.name}」没有自己的参考图`);
  }
  // A BASE VOICE IS SET when the character has a voice IDENTITY (what TTS needs),
  // a written description, or an uploaded sample. Any one of the three is a real
  // answer to 「林婉听起来是什么样」, so requiring all three would report a gap on a
  // character that is fully specified for the route being used.
  if (isChar && !s(voice.voiceId) && !s(voice.description) && !voice.sample) {
    gaps.push("还没有 Base Voice");
  }
  return {
    kind,
    entityId: id,
    name: entity.name,
    tier: isChar ? entity.tier : null,
    profile: entity.profile,
    resolved: base,
    refs: baseRefs,
    heroRef: baseRefs.find((r) => r.active && r.url) || baseRefs.find((r) => r.url) || null,
    states,
    voice,
    promptKey: basePromptKey(kind, id, null),
    // the resolved prompt standing, when the caller supplied a resolver (the
    // prompt document is not part of the read-only production snapshot)
    prompt,
    suggestedName: suggestReferenceName({ entityName: entity.name, stateName: null }),
    gaps,
    referenceKind: BASE_REFERENCE_KIND[kind],
  };
}

/**
 * The whole project's base assets.
 *
 * `promptOf(kind, entityId, stateId)` is optional and is how the prompt document
 * reaches this pure model without it importing an app controller. Absent, every
 * `prompt` field is null and the caller renders the compiled prompt only.
 */
export function baseAssetsModel(pd, { promptOf = null } = {}) {
  const prod = pd && pd.production;
  if (!prod || !Array.isArray(prod.characters) || !Array.isArray(prod.locations)) return { empty: true };
  const byAsset = imageIndex(pd.assetUploads);
  const audioMap = (pd.media && pd.media.audio) || {};
  const one = (kind, entity) => {
    const id = kind === "character" ? entity.characterId : entity.locationId;
    return entityBaseAssets({
      kind,
      entity,
      byAsset,
      audioMap,
      prompt: promptOf ? promptOf(kind, id, null) : null,
    });
  };
  return {
    empty: false,
    characters: prod.characters.map((c) => one("character", c)),
    locations: prod.locations.map((l) => one("location", l)),
  };
}

/** Lookup one entity's base assets by id, across both kinds (ids share one
 *  namespace in the bible, so one lookup is correct and two would be a bug). */
export function findBaseAssets(model, entityId) {
  if (!model || model.empty) return null;
  return (
    model.characters.find((c) => c.entityId === entityId)
    || model.locations.find((l) => l.entityId === entityId)
    || null
  );
}
