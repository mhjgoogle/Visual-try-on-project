// The Action Layer (ADR-0061 决策 9 / TASK-064 §52) — the ONE vocabulary of
// domain mutations that both the UI and the AI Director speak.
//
// WHY IT EXISTS: without it there are two implementations of every mutation —
// the one a button calls and the one an automated proposal would call — and they
// drift. Every guard added to one is missing from the other. So there is exactly
// one name per mutation, and every caller goes through the dispatcher.
//
// THIS MODULE IS THE VOCABULARY, NOT THE IMPLEMENTATION. It declares which
// actions exist, what arguments each takes, and how risky each is. The dispatcher
// (app.js `ctx.actions`) maps a name to the ORDINARY controller for that surface —
// so an action cannot reach a document through a path that skips the guards a
// hand edit goes through.
//
// AUTOMATION LEVEL (决策 9 / §53). This round has exactly one level in force:
//
//     AI Suggest → User Accept → Action
//
// `LEVELS` names the future ones so the architecture can carry them, and
// `allowedAt` is the single predicate that decides. Nothing is autonomous today:
// `CURRENT_LEVEL` is `suggest`, and at that level every mutating action requires
// an explicit human decision. Raising it is a code change with an ADR behind it,
// not a setting a proposal can flip.
//
// Pure data + pure predicates — no fetch, no DOM, no clock, no ctx.

/** Every action name, with the arguments it takes and its risk class.
 *
 *  `risk`:
 *    read      changes nothing (listed so a caller can route uniformly)
 *    pointer   moves an ACTIVE pointer; destroys nothing (Set Active, lock)
 *    edit      writes a new version / binding; previous state preserved
 *    heavy     spends real time or bytes (a render)
 */
export const ACTIONS = {
  // --- versions & selection (决策 5) ------------------------------------- //
  setActiveVersion: { args: ["domain", "key", "version"], risk: "pointer" },
  // TASK-067 §12 — THREE distinct reference mutations, because a Proposal has to be
  // able to say which one it means.
  //
  // `addReference` is new, and `replaceReference` changed meaning. Before this round
  // `replaceReference` only ever ADDED (already-bound reported `satisfied`), so the
  // word 「替换」 in the vocabulary was false: no proposal could express 「把 A 换成
  // B」 at all. Now `addReference` is the add and `replaceReference` genuinely swaps,
  // carrying the reference's use-side over to the new binding.
  addReference: { args: ["shotId", "referenceKey"], risk: "edit" },
  replaceReference: { args: ["shotId", "referenceKey", "replacesKey"], risk: "edit" },
  removeReference: { args: ["shotId", "referenceKey"], risk: "edit" },
  updatePrompt: { args: ["shotId", "kind", "text"], risk: "edit" },
  // TASK-066 §5: which side of the chain a reference binding serves. It moves no
  // media and creates no version — it re-points which prompt reads this reference,
  // so it is a POINTER-class change, like Set Active.
  setReferenceUse: { args: ["shotId", "referenceKey", "use"], risk: "pointer" },
  // --- reference interpretation (决策 4 / §21–§22) ------------------------- //
  // The reading of a directing reference is a WRITE like any other: the same
  // dispatcher, the same lock, the same provenance. A Skill that could write it
  // through a private path would be able to overwrite a locked reading.
  updateInterpretation: { args: ["referenceKey", "axes"], risk: "edit" },
  // --- frames (§7) --------------------------------------------------------- //
  // extractFrame produces a new derived Image Asset out of a video take; it
  // writes bytes, so it is an edit rather than a pointer move.
  extractFrame: { args: ["shotId", "timecodeMs"], risk: "edit" },
  bindStartFrame: { args: ["targetShotId", "assetId"], risk: "edit" },
  unbindFrame: { args: ["targetShotId", "bindingType"], risk: "edit" },
  // TASK-067 §12. ONE name for 「接上一镜的尾帧」, because that is one decision the
  // creator makes and one thing a Proposal has to be able to point at. Underneath it
  // is the shot's own end-frame binding resolved to its asset and bound as this
  // shot's start frame — through the same guards `bindStartFrame` goes through.
  //
  // It does NOT extract: extraction writes bytes and is asynchronous (see the
  // `extractFrame` case), so this action requires the previous shot to ALREADY have
  // a bound end frame and refuses otherwise, with the reason. A proposal that
  // silently kicked off an async extraction would report success before anything
  // landed.
  usePreviousShotEndFrame: { args: ["shotId"], risk: "edit" },
  // --- skills & proposals (决策 3) --------------------------------------- //
  runSkill: { args: ["skillId", "executor", "scope"], risk: "edit" },
  applyProposal: { args: ["skillRunId"], risk: "edit" },
  prepareGeneration: { args: ["shotId", "kind"], risk: "read" },
  registerGenerationResult: { args: ["shotId", "kind", "file"], risk: "edit" },
  // --- review (ADR-0057) -------------------------------------------------- //
  approveShot: { args: ["shotId", "note"], risk: "edit" },
  unapproveShot: { args: ["shotId"], risk: "edit" },
  // --- shot audio (决策 6 / 决策 7) --------------------------------------- //
  moveAudioClip: { args: ["shotId", "clipId", "timing"], risk: "edit" },
  trimAudioClip: { args: ["shotId", "clipId", "sourceIn", "sourceOut"], risk: "edit" },
  setGain: { args: ["shotId", "clipId", "gain"], risk: "edit" },
  setFade: { args: ["shotId", "clipId", "fadeInMs", "fadeOutMs"], risk: "edit" },
  addAudioClip: { args: ["shotId", "clip"], risk: "edit" },
  removeAudioClip: { args: ["shotId", "clipId"], risk: "edit" },
  setAudioMuted: { args: ["shotId", "clipId", "muted"], risk: "edit" },
  autoArrangeShotAudio: { args: ["shotId"], risk: "edit" },
  mixShotAudio: { args: ["shotId"], risk: "heavy" },
  // --- episode timeline (决策 6) ------------------------------------------ //
  replaceTimelineAsset: { args: ["clipId", "assetId"], risk: "edit" },
  trimTimelineClip: { args: ["clipId", "inMs", "outMs"], risk: "edit" },
  moveTimelineClip: { args: ["clipId", "index"], risk: "edit" },
  removeTimelineClip: { args: ["clipId"], risk: "edit" },
  restoreTimelineClip: { args: ["clipId"], risk: "edit" },
  setTimelineVolume: { args: ["clipId", "volume"], risk: "edit" },
  // TASK-072 §1.9 缺陷 9: the episode timeline has had `fadeIn` / `fadeOut` since
  // M11, but no action addressed them — so a Sound Designer's episode-layer fade
  // was collected, dropped, and reported as applied. Fades are stated in MILLI-
  // seconds like every other proposal duration; the timeline stores seconds and
  // the dispatcher converts, exactly as it does for dB → linear volume.
  setTimelineFade: { args: ["clipId", "fadeInMs", "fadeOutMs"], risk: "edit" },
  setTransition: { args: ["clipId", "kind", "durationMs"], risk: "edit" },
  updateSubtitle: { args: ["cueId", "fields"], risk: "edit" },
  buildSubtitles: { args: ["episodeId"], risk: "edit" },
  buildRoughCut: { args: ["episodeId"], risk: "edit" },
  renderEpisode: { args: ["episodeId"], risk: "heavy" },
  // --- lock (决策 5 / §50) ------------------------------------------------ //
  lockItem: { args: ["scope", "id"], risk: "pointer" },
  unlockItem: { args: ["scope", "id"], risk: "pointer" },
  // --- structure ---------------------------------------------------------- //
  replaceShotDraft: { args: ["shots"], risk: "edit" },
  patchShots: { args: ["patches"], risk: "edit" },
  proposeOutline: { args: ["proposal"], risk: "edit" },
  proposeScript: { args: ["text"], risk: "edit" },
  proposeBible: { args: ["proposal"], risk: "edit" },
  // --- 人物关系 (TASK-065 §2) ---------------------------------------------- //
  // Create-or-revise, ONE name. Two names ("addRelationship" / "editRelationship")
  // would force every caller to first find out which one applies, and a caller
  // that guessed wrong would silently do nothing. The dispatcher resolves the pair
  // against the documents and refuses when either character does not exist.
  upsertRelationship: { args: ["aCharacterId", "bCharacterId", "fields"], risk: "edit" },
  // 世界观 canon, one facet at a time (TASK-090 §2.4 / TASK-094 批次 F2). `fields` is
  // a partial: only the facets the proposal really carries are written, so
  // accepting 「补一条世界规则」 can never blank the 视觉基调 a creator wrote by hand —
  // the same rule `upsertRelationship` follows.
  updateWorldSetting: { args: ["fields"], risk: "edit" },
  removeRelationship: { args: ["relationshipId"], risk: "edit" },
  swapRelationshipDirection: { args: ["relationshipId"], risk: "pointer" },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

/** The automation levels the architecture is built to carry (§53). */
export const LEVELS = ["manual", "suggest", "confirm", "auto-low-risk"];

/** The level in force. `suggest` = AI Suggest → User Accept → Action.
 *
 *  A constant, not a setting: this round grants no autonomous mutation at all,
 *  and something a proposal could flip would not be a guarantee. */
export const CURRENT_LEVEL = "suggest";

/**
 * May `origin` perform `action` at `level`?
 *
 *   origin "user"      an explicit human action — always allowed
 *   origin "ai"        an automated caller
 *
 * At `suggest`, an AI origin may only perform `read` actions: everything that
 * writes needs a human decision, which is what「AI 建议 → 你确认 → 执行」means.
 * At `confirm` an AI origin may write only when `confirmed` is true. Only
 * `auto-low-risk` lets an AI write without asking, and then only for a pointer
 * move — never an edit, never a heavy job.
 */
export function allowedAt(action, { origin = "user", level = CURRENT_LEVEL, confirmed = false } = {}) {
  const spec = ACTIONS[action];
  if (!spec) return { ok: false, reason: `未知动作 ${action}` };
  if (origin === "user") return { ok: true };
  if (spec.risk === "read") return { ok: true };
  if (level === "manual" || level === "suggest") {
    return { ok: false, reason: "当前只允许「AI 建议 → 你确认 → 执行」：这个动作需要你亲自决定" };
  }
  if (level === "confirm") {
    return confirmed ? { ok: true } : { ok: false, reason: "需要你确认后才能执行" };
  }
  if (level === "auto-low-risk") {
    return spec.risk === "pointer"
      ? { ok: true }
      : { ok: false, reason: "自动执行只覆盖低风险动作（移动 ACTIVE 指针），不覆盖写入与渲染" };
  }
  return { ok: false, reason: `未知自动化级别 ${level}` };
}

/** Validate an action envelope's shape before anything is dispatched. Returns
 *  null when acceptable, else the reason. Missing arguments are named, because
 *  「参数不对」 is not something a caller can fix. */
export function validate(envelope) {
  if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return "动作必须是一个对象";
  }
  const spec = ACTIONS[envelope.action];
  if (!spec) return `未知动作 ${envelope.action}`;
  const missing = spec.args.filter((a) => envelope[a] === undefined);
  return missing.length ? `${envelope.action} 缺少参数：${missing.join("、")}` : null;
}
