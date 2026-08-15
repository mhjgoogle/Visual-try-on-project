// The THREE REVIEW LAYERS, as domain (系统合同 §6 / TASK-072 §1.5).
//
//   layer 1  shot      一个镜头做对了吗        → ⑧ 镜头制作 step ④
//   layer 2  episode    这一集好看吗            → ⑨ 粗剪审片
//   layer 3  delivery   这个文件能交付吗        → ⑩ 交付质检
//
// TWO OBJECT TYPES, and the asymmetry between them IS the product rule:
//
//   ReviewIssue     an observation. An AGENT may produce one.
//   ReviewDecision  a judgement.    ONLY the user may produce one.
//
// That is §7.3's 「不得静默定稿」 enforced in the domain rather than agreed in the UI:
// `decision()` rejects any `by` other than "user", so no automation level, no page and
// no proposal can produce a passing verdict. A UI-only guard would leave every other
// caller free to bypass it.
//
// THE CATEGORY SETS ARE DISJOINT (§6.1). A `loudness` problem cannot exist at layer 2
// and a `pacing` problem cannot exist at layer 3 — that is 「边界清晰」 expressed in
// data instead of in prose, and a guard test asserts the disjointness rather than
// trusting this comment.
//
// PURE. No clock, no ids minted from randomness: `at` and `issueId` are supplied by
// the caller, so this module is deterministic and testable.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim() : "");

export const LAYERS = Object.freeze(["shot", "episode", "delivery"]);

/** Each layer's own vocabulary. Disjoint by construction (§6.1). */
export const ISSUE_CATEGORIES = Object.freeze({
  shot: Object.freeze(["character", "action", "composition", "duration", "artifact"]),
  episode: Object.freeze(["story", "pacing", "continuity", "transition", "missing_shot"]),
  delivery: Object.freeze([
    "av_sync", "subtitle", "loudness", "black_frame", "dropped_frame", "spec", "rights",
  ]),
});

export const SEVERITIES = Object.freeze(["blocking", "warning", "info"]);
export const ISSUE_STATES = Object.freeze(["open", "resolved", "ignored"]);
export const VERDICTS = Object.freeze(["passed", "needs_rework", "needs_rereview"]);

export const LAYER_LABEL = Object.freeze({
  shot: "检查层 1 · 单镜",
  episode: "检查层 2 · 整集",
  delivery: "检查层 3 · 交付",
});

export const VERDICT_LABEL = Object.freeze({
  passed: "通过",
  needs_rework: "退回重做",
  needs_rereview: "需要重新审",
});

/** Which layer owns a category, or null. Derived from the one table above, so a
 *  category can never belong to two layers or to none. */
export function layerOfCategory(category) {
  for (const layer of LAYERS) {
    if (ISSUE_CATEGORIES[layer].includes(category)) return layer;
  }
  return null;
}

/**
 * Build a ReviewIssue, or return `{ ok: false, error }`.
 *
 * `locatedShotId` is REQUIRED at layer 2 (§6.1). An episode-wide 「节奏有点慢」 that
 * does not say WHERE is not actionable: the creator cannot open a shot from it, and
 * the 退回重做 path has nothing to point at. So the domain refuses it rather than
 * storing an issue nobody can act on.
 */
export function issue(input) {
  if (!isObj(input)) return { ok: false, error: "问题必须是一个对象" };
  const layer = str(input.layer);
  if (!LAYERS.includes(layer)) return { ok: false, error: `未知的检查层 ${layer || "(空)"}` };
  const category = str(input.category);
  if (!ISSUE_CATEGORIES[layer].includes(category)) {
    // states the LAYER it does belong to, so a mis-filed issue is one edit away
    const owner = layerOfCategory(category);
    return {
      ok: false,
      error: owner
        ? `「${category}」属于${LAYER_LABEL[owner]}，不属于${LAYER_LABEL[layer]}`
        : `${LAYER_LABEL[layer]} 没有「${category || "(空)"}」这一类问题`,
    };
  }
  const severity = str(input.severity);
  if (!SEVERITIES.includes(severity)) return { ok: false, error: `未知的严重程度 ${severity || "(空)"}` };
  const source = str(input.source);
  if (source !== "user" && source !== "agent") {
    return { ok: false, error: "问题必须说明它是谁提出的（user / agent）" };
  }
  const targetId = str(input.targetId);
  if (!targetId) return { ok: false, error: "问题必须指向一个对象" };
  const text = str(input.text);
  if (!text) return { ok: false, error: "问题必须写清楚是什么问题" };
  const locatedShotId = str(input.locatedShotId) || null;
  if (layer === "episode" && !locatedShotId) {
    return {
      ok: false,
      error: "整集问题必须定位到具体镜头（合同 §6.1）——没有定位的问题无法退回，也无法打开",
    };
  }
  const issueId = str(input.issueId);
  if (!issueId) return { ok: false, error: "问题必须有 issueId" };
  return {
    ok: true,
    value: {
      issueId,
      layer,
      targetType: str(input.targetType) || layer,
      targetId,
      locatedShotId,
      category,
      severity,
      source,
      text,
      state: ISSUE_STATES.includes(str(input.state)) ? str(input.state) : "open",
      ignoredBy: null,
      ignoredAt: null,
    },
  };
}

/**
 * TASK-074 §1.3 迁移：历史存档里没有 `locatedShotId` 的整集问题。
 *
 * `issue()` refuses to CREATE one (§1.5 验收 #8) — but the restore path takes stored
 * issues verbatim, so an issue that got in before that rule, or through any other
 * door, survives silently and layer 2 quietly stops being 「整集问题必须定位到具体
 * 镜头」.
 *
 * The card's rule is 不丢弃. So this MARKS, and marks only:
 *
 *   - `needsRelocation: true` is ADDED; `state` is left exactly as it was. Overwriting
 *     `state` would take an OPEN blocking issue out of `openIssues`, and G4 would then
 *     let an export through that a real problem was blocking — a migration that
 *     silently unblocks a gate is worse than the drift it repairs.
 *   - anything that is not a layer-2 issue, and anything already marked, is returned
 *     UNCHANGED (same object), so re-running the migration is a no-op.
 *   - entries that are not objects are passed through untouched rather than dropped.
 *
 * Deterministic by construction: no clock, no randomness, no guessing which shot it
 * meant — 「哪个镜头」 is the creator's answer to give, and inventing one here would
 * be fabricating the very datum the migration exists to admit is missing.
 */
export function relocateLegacyIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.map((it) => {
    if (!isObj(it)) return it;
    if (str(it.layer) !== "episode") return it;
    if (str(it.locatedShotId)) return it;
    if (it.needsRelocation === true) return it;
    return {
      ...it,
      needsRelocation: true,
      relocationNote: "历史记录没有说明这是哪个镜头的问题——请指认后再处理",
    };
  });
}

/** A decision id that cannot collide with one minted in the same millisecond.
 *
 *  `dec-<target>-<Date.now()>` collided on approve → unapprove → approve inside one
 *  millisecond (a script, a batch, a double click), and two decisions sharing an id
 *  make the append-only log ambiguous: anything that looks a decision up BY id then
 *  points at the wrong one, so 「这条结论审的是哪一版」 stops being answerable — the
 *  exact property §6.2 exists for (independent review; the same class as the paid
 *  path's `newOperationId`, which this round fixed there and not here).
 *
 *  A COUNTER rather than a random suffix, but note what that does and does not buy:
 *  the id still embeds `Date.now()`, so re-minting one is NOT reproducible and this
 *  must never be used inside a schema migration, which TASK-074 §1.3 requires to be
 *  deterministic. What the counter guarantees is uniqueness WITHIN a session — which
 *  is the property an append-only log needs. `relocateLegacyIssues` above mints no
 *  ids at all, for exactly this reason. */
let _decSeq = 0;
export function newDecisionId(layer, targetId) {
  return `dec-${layer}-${targetId}-${Date.now().toString(36)}-${++_decSeq}`;
}

/**
 * Build a ReviewDecision, or refuse.
 *
 * `by` is ALWAYS "user" (§6.2). This is the system-level enforcement of
 * 「不得静默定稿」: an AI origin reaching a passing verdict is refused here, in the
 * domain, whatever the automation level says.
 *
 * `openIssueIds` records what was still open at the moment of the decision — so a
 * 「通过」 taken over three open warnings stays auditable instead of looking clean.
 */
export function decision(input) {
  if (!isObj(input)) return { ok: false, error: "决定必须是一个对象" };
  const layer = str(input.layer);
  if (!LAYERS.includes(layer)) return { ok: false, error: `未知的检查层 ${layer || "(空)"}` };
  const verdict = str(input.verdict);
  if (!VERDICTS.includes(verdict)) return { ok: false, error: `未知的结论 ${verdict || "(空)"}` };
  const by = str(input.by);
  if (by !== "user") {
    return {
      ok: false,
      error: "审片结论只能由创作者本人做出（合同 §6.2）——Agent 只能提出问题，不能下结论",
    };
  }
  const targetId = str(input.targetId);
  if (!targetId) return { ok: false, error: "决定必须指向一个对象" };
  const decisionId = str(input.decisionId);
  if (!decisionId) return { ok: false, error: "决定必须有 decisionId" };
  // WHICH VERSION was judged. Without it a decision cannot go stale, and 「已定稿的
  // 不是当前版本」 becomes unanswerable (§6.4).
  const basedOnVersion = Number.isInteger(input.basedOnVersion) ? input.basedOnVersion : null;
  if (basedOnVersion === null) {
    return { ok: false, error: "决定必须记录它审的是哪一版（合同 §6.2 basedOnVersion）" };
  }
  return {
    ok: true,
    value: {
      decisionId,
      layer,
      targetId,
      verdict,
      by: "user",
      at: str(input.at) || null,
      basedOnVersion,
      openIssueIds: Array.isArray(input.openIssueIds) ? input.openIssueIds.map(String) : [],
    },
  };
}

/** Ignore a non-blocking issue — WITH A RECORD (§6.1 / U10).
 *
 *  A blocking issue cannot be ignored: that is what blocking means. Ignoring is a
 *  user act and is stamped, so 「这个问题去哪了」 always has an answer. */
export function ignoreIssue(iss, { by, at }) {
  if (!isObj(iss)) return { ok: false, error: "问题不存在" };
  if (iss.severity === "blocking") {
    return { ok: false, error: "阻断级问题不能忽略——先解决它，或把它降级为警告并说明理由" };
  }
  if (str(by) !== "user") return { ok: false, error: "只有创作者本人能忽略一个问题" };
  return {
    ok: true,
    value: { ...iss, state: "ignored", ignoredBy: "user", ignoredAt: str(at) || null },
  };
}

/** Issues still open at a layer, for a target. */
export function openIssues(issues, { layer = null, targetId = null } = {}) {
  return (Array.isArray(issues) ? issues : []).filter(
    (i) =>
      isObj(i) &&
      i.state === "open" &&
      (layer === null || i.layer === layer) &&
      (targetId === null || i.targetId === targetId),
  );
}

/** The LATEST decision for a target at a layer, or null. `at` is compared as a
 *  string, which is correct for ISO-8601 and needs no clock here. */
export function latestDecision(decisions, { layer, targetId } = {}) {
  const mine = (Array.isArray(decisions) ? decisions : []).filter(
    (d) => isObj(d) && d.layer === layer && d.targetId === targetId,
  );
  if (!mine.length) return null;
  return mine.reduce((best, d) => (String(d.at || "") >= String(best.at || "") ? d : best));
}

/**
 * Is the latest decision still ABOUT the current version (§6.4)?
 *
 * `hasStaleApproval` in the old vocabulary. Returns one of:
 *   `none`     no decision yet
 *   `current`  the decision judged the version in force
 *   `stale`    it judged an older version — 「已定稿的不是当前版本」
 *   `unknown`  the current version is not known, so staleness cannot be decided
 *
 * `unknown` is NOT `current`: claiming a decision is up to date because we could not
 * read the current version is exactly the fabricated reassurance ADR-0064 决策 6
 * forbids.
 */
export function decisionStanding(decisions, { layer, targetId, currentVersion } = {}) {
  const d = latestDecision(decisions, { layer, targetId });
  if (!d) return { state: "none", decision: null };
  if (!Number.isInteger(currentVersion)) return { state: "unknown", decision: d };
  return { state: d.basedOnVersion === currentVersion ? "current" : "stale", decision: d };
}
