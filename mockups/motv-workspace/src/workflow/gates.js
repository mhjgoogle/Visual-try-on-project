// The FIVE GATES, in the domain (系统合同 §6.3 / TASK-072 §1.6).
//
//   G1  正式审片      every shot has a confirmed video, or the rough cut is a TEST
//   G2  画面锁定      an episode-layer `passed` decision ON THE CURRENT version
//   G3  结构变更回退  a structural change retires the decision and the picture lock
//   G4  阻断导出      an open blocking QC issue refuses the export
//   G5  版本非破坏    build / export APPEND; no overwrite path exists
//
// ALL OF THEM LIVE HERE, not in a page (§6.3: 「G3 的触发点是领域层，不是 UI」). A
// gate checked inside one page is bypassed by the next page that performs the same
// operation — which is how 「审片通过」 survives a shot reorder in the first place.
//
// EVERY GATE FAILS CLOSED AND SAYS WHY. `{ ok: false, reason }` with a sentence the
// creator can act on, never a bare false: a refusal with nothing to say leaves the
// caller reporting 「失败」 and the creator with no next step.
//
// PURE. Facts are passed in; nothing here reaches into a document or a clock.

import { latestDecision, openIssues } from "./review.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/**
 * G1 — may a FORMAL review be submitted for this episode?
 *
 * `shots` is `[{ shotId, hasConfirmedVideo }]`. Formal review requires every shot to
 * have a confirmed video; otherwise a rough cut may still be built, but as
 * `kind: "test"`, and no Decision may be recorded against it.
 *
 * WHY A TEST CUT IS STILL ALLOWED: seeing the cut early is exactly how a creator
 * finds out that shot 7 is wrong. What must not happen is that watch being recorded
 * as 「这一集审过了」.
 */
export function g1FormalReview(shots) {
  const list = Array.isArray(shots) ? shots.filter(isObj) : [];
  if (!list.length) {
    return { ok: false, kind: "test", reason: "这一集还没有镜头，没有可审的内容" };
  }
  const pending = list.filter((s) => s.hasConfirmedVideo !== true);
  if (pending.length) {
    return {
      ok: false,
      kind: "test",
      pendingShotIds: pending.map((s) => s.shotId),
      reason: `还有 ${pending.length} 个镜头没有定稿视频——可以生成「测试粗剪」先看，` +
        `但不能提交正式审片结论（门槛 G1）`,
    };
  }
  return { ok: true, kind: "formal" };
}

/**
 * G2 — may the PICTURE be locked?
 *
 * Requires an episode-layer `passed` decision whose `basedOnVersion` equals the rough
 * cut version currently active. A pass on an older cut is not a pass on this one —
 * that is the whole reason `basedOnVersion` exists.
 */
export function g2LockPicture(decisions, { episodeId, activeRoughCutVersion } = {}) {
  const d = latestDecision(decisions, { layer: "episode", targetId: episodeId });
  if (!d) return { ok: false, reason: "这一集还没有审片结论，不能锁定画面（门槛 G2）" };
  if (d.verdict !== "passed") {
    return { ok: false, reason: `最新的审片结论是「${d.verdict}」，不是通过——不能锁定画面（门槛 G2）` };
  }
  if (!Number.isInteger(activeRoughCutVersion)) {
    // unknown current version → cannot prove the pass is about it
    return { ok: false, reason: "读不出当前粗剪版本，无法确认审片结论是针对它的——不锁定（门槛 G2）" };
  }
  if (d.basedOnVersion !== activeRoughCutVersion) {
    return {
      ok: false,
      reason: `审片通过的是第 ${d.basedOnVersion} 版粗剪，当前是第 ${activeRoughCutVersion} 版` +
        `——先重新审再锁定（门槛 G2）`,
    };
  }
  return { ok: true, decision: d };
}

/**
 * G3 — the structural changes that RETIRE a review (§6.3).
 *
 * Exactly what §6.3 names: Shot 增删 (two triggers), Shot 的 confirmed video 版本变更,
 * TimelineClip 顺序变更, TimelineClip 入出点变更 — five triggers for the contract's
 * four bullet points, because 增 and 删 are separate events. Anything else is not a
 * structural change, and widening this set silently would make every volume tweak
 * demand a re-review.
 */
export const G3_TRIGGERS = Object.freeze([
  "shotAdded",
  "shotRemoved",
  "shotConfirmedVideoChanged",
  "timelineClipOrderChanged",
  "timelineClipTrimChanged",
]);

/** Map an ACTION NAME to its G3 trigger, or null.
 *
 *  Keyed on the action vocabulary rather than on a page, because §6.3 says the
 *  trigger is the domain: 「任何走 Action 层的相关写入都触发它」. */
export const G3_ACTIONS = Object.freeze({
  patchShots: "shotAdded",
  replaceShotDraft: "shotAdded",
  removeShot: "shotRemoved",
  confirmShotVersion: "shotConfirmedVideoChanged",
  moveTimelineClip: "timelineClipOrderChanged",
  removeTimelineClip: "timelineClipOrderChanged",
  restoreTimelineClip: "timelineClipOrderChanged",
  trimTimelineClip: "timelineClipTrimChanged",
});

export function g3TriggerFor(actionName) {
  return Object.prototype.hasOwnProperty.call(G3_ACTIONS, actionName)
    ? G3_ACTIONS[actionName]
    : null;
}

/**
 * G3 — apply the retirement. Returns what CHANGED, so a caller can report it.
 *
 * A `passed` episode decision becomes `needs_rereview` and the picture lock is
 * released. NOT deleted: the decision happened, and erasing it would lose the fact
 * that this episode was once approved on an older cut (the same rule that keeps
 * rejected proposals).
 *
 * Idempotent: applying it to an already-retired decision changes nothing, so a burst
 * of structural edits does not produce a burst of notices.
 */
export function g3Retire(decisions, { episodeId, trigger, at } = {}) {
  if (!G3_TRIGGERS.includes(trigger)) {
    return { changed: false, reason: `「${trigger}」不是结构变更，不触发回退` };
  }
  const d = latestDecision(decisions, { layer: "episode", targetId: episodeId });
  if (!d) return { changed: false, reason: "这一集还没有审片结论，没有需要回退的东西" };
  if (d.verdict !== "passed") {
    return { changed: false, reason: `最新结论已经是「${d.verdict}」，无需回退` };
  }
  return {
    changed: true,
    decisionId: d.decisionId,
    next: { ...d, verdict: "needs_rereview", retiredBy: trigger, retiredAt: at || null },
    unlockPicture: true,
    reason: "结构变更了，这一集的审片结论已置为「需要重新审」，画面锁定同时解除（门槛 G3）",
  };
}

/**
 * G4 — may the delivery be EXPORTED?
 *
 * Refused while any layer-3 issue is `blocking` and `open`. Also refused when the QC
 * report is ABSENT: §6.5 says 「`runDeliveryQc` 未跑过 = 未知，不是通过」, and an
 * export waved through on an unknown is how a broken file ships.
 */
export function g4Export(qcReport) {
  // `{}` IS NOT A REPORT (independent review, batch 2). Accepting any object let a
  // never-run or malformed report through the one gate whose stated purpose is
  // 「未跑过 = 未知，不是通过」. A real report always carries an `issues` array.
  if (!isObj(qcReport) || !Array.isArray(qcReport.issues)) {
    return { ok: false, reason: "还没有跑交付质检——没跑不等于通过，先跑质检再导出（门槛 G4）" };
  }
  const blockers = openIssues(qcReport.issues, { layer: "delivery" })
    .filter((i) => i.severity === "blocking");
  if (blockers.length) {
    return {
      ok: false,
      blockingIssueIds: blockers.map((i) => i.issueId),
      reason: `有 ${blockers.length} 个阻断级质检问题还没解决，导出已拒绝（门槛 G4）：` +
        blockers.map((i) => i.text).join("；"),
    };
  }
  return { ok: true };
}

/**
 * G5 — a version-producing operation must APPEND.
 *
 * Given the existing versions and the one about to be written, refuse anything that
 * would land on an existing number. §6.3 wants 「代码里不存在覆盖分支」; this is the
 * assertion that makes the absence checkable rather than claimed.
 */
export function g5Append(existingVersions, nextVersion) {
  const list = (Array.isArray(existingVersions) ? existingVersions : []).filter(Number.isInteger);
  if (!Number.isInteger(nextVersion)) {
    return { ok: false, reason: "新版本号无效——不写入" };
  }
  if (list.includes(nextVersion)) {
    return { ok: false, reason: `第 ${nextVersion} 版已经存在——只能追加新版本，绝不覆盖（门槛 G5）` };
  }
  const max = list.length ? Math.max(...list) : 0;
  if (nextVersion <= max) {
    return {
      ok: false,
      reason: `新版本号 ${nextVersion} 不大于现有最高版本 ${max}——版本只前进（门槛 G5）`,
    };
  }
  return { ok: true, version: nextVersion };
}

/** The next version number an append should use. Derived, never stored. */
export function nextVersionFor(existingVersions) {
  const list = (Array.isArray(existingVersions) ? existingVersions : []).filter(Number.isInteger);
  return (list.length ? Math.max(...list) : 0) + 1;
}
