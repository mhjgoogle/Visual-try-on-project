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

/* -------------------------------------------------------------------------- */
/* WHAT A ROUTE CAN ACTUALLY INGEST (TASK-077 §1.3)                           */
/* -------------------------------------------------------------------------- */

/**
 * `ROLE_USE` above is the role's DECLARED use — what kind of contribution the
 * reference makes, and therefore which prompt compiles it (workflow/refuse.js) and
 * which side of the production graph it sits on (workflow/shotgraph.js). That is a
 * fact about the role and it does not change.
 *
 * What it is NOT is a promise that the file reaches a model. On the paid route it
 * does not:
 *
 *   shot.first_frame_image → packet.first_frame_image
 *     → ProviderRequest.provider_parameters
 *     → src/ai_video_workflow/providers/cloud_minimax.py `_payload`
 *   body = { model, prompt, duration, resolution, first_frame_image? }
 *
 * `ProviderRequest` (src/ai_video_workflow/providers/models.py) carries no other
 * image field, so exactly ONE image is submitted — the first frame. The panel
 * nevertheless labelled 人物 / 场景 / 道具 / 风格参考 「模型直接输入」, which told the
 * creator four files would be sent that never were.
 *
 * The fix is a SECOND, derived answer — the role's EFFECTIVE use on the route in
 * force — not an edit to `ROLE_USE`. Flipping the declared table would move those
 * references onto the video side of the prompt compiler and redraw the shot graph,
 * which is a cross-layer change this card explicitly does not make.
 */
export const ROUTE_CAPABILITY = Object.freeze({
  // Gateway 付费生成 (ADR-0041) — one image, and it is the first frame.
  //
  // THIS IS NOW A FALLBACK, NOT THE ANSWER (ADR-0071 决策 4). Hard-coding `false`
  // was the honest reading while nothing could tell the UI otherwise: the catalog
  // had no capability field, so 「这条路送几张图」 was a property of the code. It is
  // a property of the MODEL now, declared in the catalog and delivered by the
  // Gateway preflight — see `gatewayCapabilityFrom` below. This entry describes the
  // route when no preflight has been taken yet, and it stays fail-closed, because
  // 「还没问过」 must never render as 「可以送」.
  gateway: Object.freeze({
    id: "gateway",
    label: "Gateway 付费生成",
    referenceImages: false,
    imageInputs: Object.freeze(["first-frame"]),
  }),
  // 免费 / 手工路线 — the creator copies the Prompt into an external tool and
  // attaches the files themselves, so every reference image really IS model input.
  // This is why the manual prompt's 「作为参考图一并提供」 wording is correct and stays.
  manual: Object.freeze({
    id: "manual",
    label: "免费 / 手工路线",
    referenceImages: true,
    imageInputs: Object.freeze(["first-frame", "reference"]),
  }),
});

/** Unknown route → the MANUAL capability, deliberately: the manual route is the
 *  one where the creator is holding the files, so its wording is the safe default
 *  (it instructs a human rather than promising an API behaviour). */
export const routeCapability = (route) =>
  ROUTE_CAPABILITY[route] || ROUTE_CAPABILITY.manual;

/**
 * The role's EFFECTIVE use on one route.
 *
 * A `model-input` role on a route that cannot carry reference images reaches the
 * generation the only way left to it — as words a Skill compiled into the Prompt.
 * That is `ai-interpretation`, and saying so is the whole point: it is what
 * actually happens, and it tells the creator that the reference still matters and
 * how.
 */
export function effectiveRoleUse(role, capability) {
  const declared = ROLE_USE[role];
  if (!declared) return null;
  const cap = capability && typeof capability === "object" ? capability : ROUTE_CAPABILITY.manual;
  return declared === "model-input" && cap.referenceImages !== true
    ? "ai-interpretation"
    : declared;
}

/** Roles whose declared use is `model-input` but which this route will not send.
 *  Named separately from the genuinely-interpreted roles because the two are NOT
 *  the same thing: a motion reference has a reading to compile, while a character
 *  reference on the paid route has only whatever the prompt already says about the
 *  character. Labelling both 「已解读 / 尚未解读」 would invent a reading. */
export function downgradedRoles(capability) {
  return MODEL_INPUT_ROLES.filter((r) => effectiveRoleUse(r, capability) !== "model-input");
}

/** The route note a panel prints for ONE route. */
export function referenceRouteNote(capability) {
  const cap = capability && typeof capability === "object" ? capability : ROUTE_CAPABILITY.manual;
  return cap.referenceImages
    ? `${cap.label}：由你把文件附给外部工具，所以这些参考图真的会被模型看到。`
    : `${cap.label}：请求只带一张图片（首帧）。人物 / 场景 / 道具 / 风格参考`
      + "<b>不会进模型</b>——它们只会被 AI 解读成 Prompt 里的文字描述。";
}

/**
 * BOTH routes' truths, always — the panel's replacement for the unqualified
 * 「模型直接输入」 (TASK-077 §1.3).
 *
 * WHY BOTH AND NOT JUST THE ONE IN FORCE. This product offers two live routes at
 * the same time: the creator can copy the compiled Prompt into an external tool
 * TODAY, whether or not the Gateway write path is enabled. Printing only the
 * active one would be honest about this minute and would still leave a creator
 * planning a paid run believing four images will be sent. The claim that had to
 * go was the UNQUALIFIED one; the fix is to say which route each fact belongs to.
 *
 * The route in force is marked, so 「我现在在哪条路上」 is still answered.
 */
export function referenceRouteMatrix(capability) {
  const now = capability && typeof capability === "object" ? capability : ROUTE_CAPABILITY.manual;
  return ["manual", "gateway"].map((id) => ({
    id,
    active: ROUTE_CAPABILITY[id] === now || id === now.id,
    label: ROUTE_CAPABILITY[id].label,
    sendsReferenceImages: ROUTE_CAPABILITY[id].referenceImages,
    note: referenceRouteNote(ROUTE_CAPABILITY[id]),
  }));
}

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

/**
 * The gateway route's capability AS THE CATALOG DECLARES IT (ADR-0071 决策 4).
 *
 * `capability` is `genspec.referenceCapability(preflight)` — passed in rather than
 * imported so this module stays free of the preflight shape, and so there is one
 * reader of that response (TASK-097 §2.5b: 报价与能力来自同一份 preflight，分开读会
 * 产生「按 A 的能力显示、按 B 的报价收费」的缝).
 *
 * Falls back to the fail-closed static entry when nothing has been asked yet: the
 * route note then says 「请求只带一张图片（首帧）」, which is what a creator should
 * assume until the Gateway says otherwise.
 */
export function gatewayCapabilityFrom(capability) {
  const cap = capability && typeof capability === "object" ? capability : null;
  if (!cap || cap.known !== true || !(cap.maxImages > 0)) return ROUTE_CAPABILITY.gateway;
  return Object.freeze({
    id: "gateway",
    label: "Gateway 付费生成",
    referenceImages: true,
    maxImages: cap.maxImages,
    addressable: cap.addressable === true,
    imageInputs: Object.freeze(["first-frame", "reference"]),
  });
}
