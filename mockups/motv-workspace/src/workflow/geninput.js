// Generation Input Set (checkpoint CP6 / ADR-0058) — the formal statement of
// what ONE generation is given.
//
//     Character Ref · Location Ref · Prop Ref · Style Ref
//     Start Frame · End Frame
//     Prompt
//     Shot / Scene context
//     source / runtime / model (when known)
//     parameters · seed (when known)
//
// WHY THIS EXISTS SEPARATELY: until now the inputs to a generation were
// assembled ad hoc at each call site, so two paths could disagree about what
// "the inputs" were, and the manual path recorded almost nothing. One place
// builds the set, one shape describes it, and the Generation record freezes it.
//
// HONEST LINEAGE IS THE WHOLE POINT (ADR-0055): different generation routes
// legitimately lack different fields — a manual external run has no seed and
// usually no model, a first-frame-less image has no start frame. A missing
// field is recorded as MISSING (null), never guessed, never defaulted to
// something plausible. What we do not know, we say we do not know.
//
// Pure assembly — no fetch, no DOM, no clock, no writes.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const strOrNull = (x) => (nonEmpty(x) ? x : null);

/** The reference roles a generation can be given, in the order a creator thinks
 *  about them: WHAT is in frame, then HOW it is shot and played.
 *  `external` is deliberately absent: an external reference is material the
 *  creator collected, not a role in THIS shot's generation.
 *
 *  ADR-0061 决策 4: the last four are directing references. They reach the
 *  generation through AI INTERPRETATION rather than as direct model input — see
 *  `isInterpretationRole`. Being un-ingestible by today's video API does not make
 *  them decoration: a Skill reads them and compiles运镜 / 节奏 / 表演 into the
 *  Prompt, which is a real contribution to the result. */
export const REFERENCE_ROLES = [
  ["character-reference", "人物参考"],
  ["location-reference", "场景参考"],
  ["prop-reference", "道具参考"],
  ["style-reference", "风格参考"],
  ["video-style-reference", "视频风格参考"],
  ["motion-reference", "运动参考"],
  ["camera-reference", "机位参考"],
  ["performance-reference", "表演参考"],
];

/** role → label, for the many callers that only need the word. */
export const ROLE_LABEL = Object.fromEntries(REFERENCE_ROLES);

/** How a role reaches the generation (ADR-0061 决策 4):
 *
 *    model-input        the media model ingests it directly, where supported
 *    ai-interpretation  a Skill reads it and compiles it INTO the prompt
 *
 *  This is a fact about the ROLE, not about a provider's current feature list,
 *  which is why it is stated once here instead of being guessed per call site. */
export const ROLE_USE = {
  "character-reference": "model-input",
  "location-reference": "model-input",
  "prop-reference": "model-input",
  "style-reference": "model-input",
  "video-style-reference": "ai-interpretation",
  "motion-reference": "ai-interpretation",
  "camera-reference": "ai-interpretation",
  "performance-reference": "ai-interpretation",
};

export const ROLE_USE_LABEL = {
  "model-input": "模型直接输入",
  "ai-interpretation": "AI 解读输入",
};

export const isInterpretationRole = (role) => ROLE_USE[role] === "ai-interpretation";

/** The roles that are direct model input, and the roles that are interpreted —
 *  derived from ROLE_USE so a new role cannot be forgotten by one of the two. */
export const MODEL_INPUT_ROLES = REFERENCE_ROLES.filter(([r]) => !isInterpretationRole(r)).map(([r]) => r);
export const INTERPRETATION_ROLES = REFERENCE_ROLES.filter(([r]) => isInterpretationRole(r)).map(([r]) => r);

/**
 * Assemble the input set for one shot's generation.
 *
 * `shot`        the draft shot (its design IS part of the input)
 * `context`     { episodeId, sceneId, shotId, sceneTitle, episodeCode }
 * `references`  the canonical References bound to this shot, already resolved
 *               to { key, kind, name, version, assetId, url }
 * `frames`      { start, end } — resolved first/last frame refs or null
 * `prompt`      the effective prompt text (or null when not compiled yet)
 * `runtime`     { source, model, parameters, seed } — anything unknown is null
 * `interpretation`  refinterp.interpretationInputs() for the interpretation
 *               references — each carries `axes` and `read`. An UNREAD one is
 *               kept in the set: the panel has to be able to show 「你绑了运动
 *               参考，但还没有人读过它」, and dropping it would make the set claim
 *               a complete picture it does not have.
 */
export function buildInputSet({ shot, context, references, frames, prompt, runtime, interpretation } = {}) {
  const refs = Array.isArray(references) ? references.filter(isObj) : [];
  const byRole = {};
  for (const [role] of REFERENCE_ROLES) byRole[role] = refs.filter((r) => r.kind === role);
  const f = isObj(frames) ? frames : {};
  const rt = isObj(runtime) ? runtime : {};
  const ctx = isObj(context) ? context : {};
  const interp = Array.isArray(interpretation) ? interpretation.filter(isObj) : [];
  return {
    shotId: strOrNull(ctx.shotId) || (isObj(shot) ? strOrNull(shot.shotId) : null),
    sceneId: strOrNull(ctx.sceneId),
    episodeId: strOrNull(ctx.episodeId),
    sceneTitle: strOrNull(ctx.sceneTitle),
    episodeCode: strOrNull(ctx.episodeCode),
    // the shot DESIGN is an input: it is what the prompt was written from
    design: isObj(shot)
      ? {
          title: typeof shot.title === "string" ? shot.title : "",
          description: typeof shot.description === "string" ? shot.description : "",
          shotSize: strOrNull(shot.shotSize),
          angle: strOrNull(shot.angle),
          cameraMotion: strOrNull(shot.cameraMotion),
          action: strOrNull(shot.action),
          expression: strOrNull(shot.expression),
          emotion: strOrNull(shot.emotion),
          dialogue: strOrNull(shot.dialogue),
          duration: typeof shot.duration_seconds === "number" ? shot.duration_seconds : null,
        }
      : null,
    references: byRole,
    referenceCount: refs.length,
    // THE TWO GROUPS, formally (ADR-0061 决策 4 / §4). Derived from ROLE_USE
    // rather than listed twice, so a role cannot end up in both or in neither —
    // and the panel renders 「模型直接输入」 / 「AI 解读输入」 from exactly this.
    modelInputs: MODEL_INPUT_ROLES.flatMap((role) => byRole[role] || []),
    // the interpretation SIDE carries its reading, not just the file: that is
    // the whole difference between the two groups
    interpretationInputs: interp,
    // bound-but-unread references, so a caller can report the gap without
    // re-filtering (and so 「已解读 2/3」 is one derivation, not three)
    interpretationUnread: interp.filter((i) => !i.read),
    // a video generation is framed by real image Assets; an image generation
    // has neither, and says so rather than inventing a frame
    startFrame: isObj(f.start) ? f.start : null,
    endFrame: isObj(f.end) ? f.end : null,
    prompt: strOrNull(prompt),
    source: strOrNull(rt.source),
    model: strOrNull(rt.model),          // unknown stays null — never assumed
    parameters: isObj(rt.parameters) ? rt.parameters : null,
    seed: rt.seed === undefined || rt.seed === null ? null : rt.seed,
  };
}

/** What is still missing before this set can produce anything. Returned as a
 *  list the UI shows verbatim — a disabled button with no reason is a dead end. */
export function missingForGeneration(set, { kind = "image" } = {}) {
  const missing = [];
  if (!isObj(set)) return ["没有输入集合"];
  if (!set.shotId) missing.push("镜头身份未解析（草稿可能已重新生成）");
  if (!set.prompt) missing.push("还没有编译 Prompt");
  if (kind === "video" && !set.startFrame) missing.push("视频生成需要首帧图片");
  if (kind === "image" && !set.design) missing.push("镜头还没有设计内容");
  return missing;
}

/** The Generation-record seed this set becomes when a generation is launched.
 *  The SAME shape for every route, so a manual run and a local run record the
 *  same kind of lineage — only the values differ, and the ones a route cannot
 *  know stay null.
 *
 *  `promptSnapshot` distinguishes NOT SUPPLIED from EXPLICITLY EMPTY, because
 *  they mean opposite things. Omitting it (undefined/null) says "use whatever
 *  the set compiled"; passing a string — including "" — is the caller's own
 *  answer and is recorded verbatim. Falling back on an empty string replaced a
 *  prompt the creator had deliberately cleared with the compiled one, and the
 *  record then claimed a prompt that never drove anything. */
export function generationSeedFrom(set, { type, promptSnapshot, status = "generating" } = {}) {
  const refAssetIds = [];
  for (const [role] of REFERENCE_ROLES) {
    for (const r of set.references[role] || []) if (nonEmpty(r.assetId)) refAssetIds.push(r.assetId);
  }
  const inputs = [];
  if (set.startFrame && nonEmpty(set.startFrame.assetId)) inputs.push(set.startFrame.assetId);
  if (set.endFrame && nonEmpty(set.endFrame.assetId)) inputs.push(set.endFrame.assetId);
  const interpRefs = (Array.isArray(set.interpretationInputs) ? set.interpretationInputs : [])
    .filter((i) => isObj(i) && i.read && nonEmpty(i.key))
    .map((i) => ({
      referenceKey: i.key,
      kind: i.kind || null,
      readingVersion: Number.isInteger(i.readingVersion) ? i.readingVersion : null,
      readingOrigin: strOrNull(i.readingOrigin),
    }));
  // NOTE: the interpretation references' own assetIds are already in
  // `refAssetIds` — REFERENCE_ROLES covers all eight roles, and an interpretation
  // reference IS a reference input (the words it produced went into the prompt).
  // `interpretedReferences` below adds WHICH READING was used, which the asset id
  // alone cannot say.
  return {
    type,
    targetType: set.shotId ? "shot" : null,
    targetId: set.shotId,
    inputAssetIds: inputs,
    referenceAssetIds: refAssetIds,
    // Whitespace decides EMPTINESS but is never edited out of the text itself:
    // a prompt of nothing but spaces drove nothing and is recorded as none,
    // while a real prompt is frozen exactly as the creator wrote it — indent,
    // line breaks and all. Trimming what we store would quietly rewrite the
    // thing this field exists to preserve verbatim.
    promptSnapshot: promptSnapshot === undefined || promptSnapshot === null
      ? set.prompt
      : (String(promptSnapshot).trim() ? String(promptSnapshot) : null),
    provider: set.source,
    model: set.model,
    parameters: {
      ...(set.parameters || {}),
      ...(set.seed !== null ? { seed: set.seed } : {}),
      // the canonical context travels with the record so a generation can still
      // be placed after a draft is regenerated
      ...(set.episodeId ? { episodeId: set.episodeId } : {}),
      ...(set.sceneId ? { sceneId: set.sceneId } : {}),
      // WHICH READING of each interpretation reference drove this run. The text
      // is already frozen in `promptSnapshot`; this records the reading's
      // identity so a later 「这段运镜是哪一版解读来的」 has an answer, and so a
      // re-read of the same reference does not make this record look like it
      // used the new one. Only READ references are listed — a bound-but-unread
      // reference contributed nothing and must not appear as an input.
      ...(interpRefs.length ? { interpretedReferences: interpRefs } : {}),
    },
    status,
  };
}
