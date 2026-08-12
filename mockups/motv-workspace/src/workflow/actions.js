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
  replaceReference: { args: ["shotId", "referenceKey"], risk: "edit" },
  removeReference: { args: ["shotId", "referenceKey"], risk: "edit" },
  updatePrompt: { args: ["shotId", "kind", "text"], risk: "edit" },
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
  mixShotAudio: { args: ["shotId"], risk: "heavy" },
  // --- episode timeline (决策 6) ------------------------------------------ //
  replaceTimelineAsset: { args: ["clipId", "assetId"], risk: "edit" },
  trimTimelineClip: { args: ["clipId", "inMs", "outMs"], risk: "edit" },
  moveTimelineClip: { args: ["clipId", "index"], risk: "edit" },
  removeTimelineClip: { args: ["clipId"], risk: "edit" },
  updateSubtitle: { args: ["cueId", "fields"], risk: "edit" },
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
