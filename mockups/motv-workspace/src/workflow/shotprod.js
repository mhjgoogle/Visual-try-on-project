// Shot production state (checkpoint CP4 / ADR-0057) — the two things about a
// Shot's PRODUCTION that the studio cannot derive and must therefore own:
//
//   1. REVIEW APPROVAL   「这个镜头我看过，通过了」—— bound to the exact video
//   2. REFERENCE BINDING 「这个镜头用这几张 canonical 参考」
//
// Everything else about a shot's standing IS derivable and is deliberately NOT
// stored (ADR-0057 决策 2):
//
//   待设计       the design facets are empty
//   已设计·待生成 designed, no image yet (one condition, not two)
//   已生成       an image exists, no video yet
//   待审片       a video exists and no approval applies to IT
//   已通过       an approval recorded FOR THE CURRENT VIDEO  ← the only stored bit
//
// Storing a duplicate "status" field would immediately disagree with the media
// registry the moment a variant is switched or an asset is removed. The one
// state that is a genuine human decision — approval — has nowhere else to live,
// so it lives here.
//
// REFERENCES ARE SHARED, NOT COPIED: a shot records reference KEYS (the
// `ref-…` chains of assetreg.js). Ten shots pointing at 林照 Ref means ten
// entries of the same key, one reference, one version pointer. Re-pointing the
// chain updates every shot at once — which is the entire reason references are
// canonical objects rather than per-shot files.
//
// Keyed by the CREATIVE shotId (M2 identity), never by slot or position: a
// re-generated draft that keeps a shot's identity must keep its approval and
// its references.
//
// Pure state + transitions — no fetch, no DOM, no clock (callers pass `now`).

import { defaultShotStages, sanitizeShotStages, stageStatuses, summarizeStages } from "./shotstage.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const strOrNull = (x) => (nonEmpty(x) ? x : null);

/** The derived production standing of one Shot, in order.
 *
 *  「已设计」 and 「待生成」 are the SAME condition in this system — a shot that
 *  has been designed and has no image yet IS the one waiting to be generated.
 *  Listing both would leave one of them permanently unreachable, i.e. a label
 *  the UI could print but the data could never produce. The single honest state
 *  is `todo-generate`, labelled 「已设计 · 待生成」. */
export const SHOT_STAGES = ["todo-design", "todo-generate", "generated", "todo-review", "approved"];

export const SHOT_STAGE_LABEL = {
  "todo-design": "待设计",
  "todo-generate": "已设计 · 待生成",
  generated: "已生成",
  "todo-review": "待审片",
  approved: "已通过",
};

/** The shot design facets that make a shot "designed" — the ones a generation
 *  actually consumes. A title alone is not a design. */
const DESIGN_FACETS = ["description", "shotSize", "angle", "cameraMotion", "action"];

export function defaultShotProduction() {
  // `stages` (ADR-0073 决策 8) 是加法字段，只承载 `skipped` 决定。旧存档没有它时
  // 按决策 2 派生，不写回填脚本 —— 回填一个可以算出来的值正是决策 2 要禁止的事。
  // `stageReviews`（批次 4F）同样是加法字段：老存档没有它，但**存下去总是带上**，
  // 否则「没有分阶段通过」会有「缺键」和「空对象」两个形状。
  return { reviews: {}, references: {}, stages: defaultShotStages(), stageReviews: {} };
}

/** Safe own-property write: a creativeShotId is an arbitrary string and could
 *  legally be `__proto__` (same rule as mediaref.putKey). */
function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

export function sanitizeShotProduction(saved) {
  const src = isObj(saved) ? saved : {};
  const reviews = {};
  const rin = isObj(src.reviews) ? src.reviews : {};
  for (const shotId of Object.keys(rin)) {
    const r = rin[shotId];
    if (!isObj(r) || r.approved !== true) continue; // only a real approval is kept
    // …and an approval that does not say WHICH video it was given for cannot be
    // matched against the current one, so it could only ever be applied to
    // footage nobody reviewed. Dropped rather than trusted.
    if (!nonEmpty(r.assetId)) continue;
    putKey(reviews, shotId, {
      approved: true,
      assetId: r.assetId,
      approvedAt: strOrNull(r.approvedAt),
      note: typeof r.note === "string" ? r.note : "",
    });
  }
  const references = {};
  const fin = isObj(src.references) ? src.references : {};
  for (const shotId of Object.keys(fin)) {
    const list = Array.isArray(fin[shotId]) ? fin[shotId] : [];
    const seen = new Set();
    const keys = [];
    for (const k of list) {
      if (!nonEmpty(k) || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    if (keys.length) putKey(references, shotId, keys);
  }
  // `sanitizeShotStages` 只认 `skipped`：任何被写进文档的 `completed` / `in_progress`
  // 一律丢弃（ADR-0073 决策 2 —— 那种声明会在产物消失后继续说做完了）。
  // 分阶段通过（批次 4F）：加法字段。形状不对的条目丢掉 —— 一条读不懂的通过
  // 记录会让闸门以为草图已经过了。
  const stageReviews = {};
  const srcSR = isObj(src.stageReviews) ? src.stageReviews : {};
  for (const shotId of Object.keys(srcSR)) {
    const perShot = srcSR[shotId];
    if (!nonEmpty(shotId) || !isObj(perShot)) continue;
    const kept = {};
    for (const stage of Object.keys(perShot)) {
      const r = perShot[stage];
      if (!isObj(r) || r.approved !== true || !nonEmpty(r.assetId)) continue;
      if (!nonEmpty(r.approvedAt) || !r.approvedAt.trim()) continue;
      kept[stage] = {
        approved: true,
        assetId: r.assetId,
        approvedAt: r.approvedAt,
        note: typeof r.note === "string" ? r.note : "",
      };
    }
    if (Object.keys(kept).length) putKey(stageReviews, shotId, kept);
  }
  return { reviews, references, stages: sanitizeShotStages(src.stages), stageReviews };
}

// ---- review ---------------------------------------------------------------- //

/** Does this shot carry an approval RECORD at all (for any video)? */
export function isApproved(prod, shotId) {
  const r = prod.shotProduction.reviews[shotId];
  return !!(isObj(r) && r.approved === true);
}

/** Is this shot approved FOR THIS EXACT VIDEO?
 *
 *  An approval is a judgement about one specific take. Switch the variant, or
 *  upload a newer one, and the recorded approval simply does not describe what
 *  is on screen now — treating it as current would let unreviewed footage
 *  inherit a 已通过 it never earned. */
export function isApprovedFor(prod, shotId, videoAssetId) {
  const r = prod.shotProduction.reviews[shotId];
  return !!(isObj(r) && r.approved === true && nonEmpty(videoAssetId) && r.assetId === videoAssetId);
}

/* -------------------------------------------------------------------------- */
/* 分阶段的「通过」 (TASK-095 §2.4 / TASK-097 批次 4F)                          */
/* -------------------------------------------------------------------------- */
//
// **为什么不能沿用上面那一条 review。** `reviews[shotId]` 记的是**审片**对某一个
// 视频的判断（一个 shot 一条，带 `assetId`）。④ Storyboard 也需要「通过」，而它通过
// 的是一张草图 —— 如果两者共用那一条记录，创作者一旦通过了视频，草图那一格的
// `approved` 就会翻回 false（`isApprovedFor` 比的是同一个 `assetId`），于是
// ④→⑤ 那道闸门在视频做完之后自己关上了。
//
// 所以图片类 stage 的通过单独存：`stageReviews[shotId][stage]`。**加法字段**，
// 老文档没有它是常态。审片那一条**不动** —— 粗剪审片是它的主人。
//
// 「这个 stage 的产物通过了吗」只有**一个**函数回答（`isStageArtifactApproved`），
// 它知道该问哪一份；两处各自判断就是 §2.5e 那条缝。

/** 图片类 stage 的通过记录，或 null。 */
export function stageReviewOf(prod, shotId, stage) {
  const all = prod.shotProduction.stageReviews;
  const perShot = isObj(all) ? all[shotId] : null;
  const rec = isObj(perShot) ? perShot[stage] : null;
  return isObj(rec) ? rec : null;
}

/** 这个 stage 的通过，是不是**针对这一张具体的产物**。
 *  换一张草图，记录就不再描述屏幕上的东西 —— 与审片同一条纪律。 */
export function isStageApprovedFor(prod, shotId, stage, assetId) {
  const r = stageReviewOf(prod, shotId, stage);
  return !!(r && r.approved === true && nonEmpty(assetId) && r.assetId === assetId);
}

/**
 * **「这个 stage 的产物通过了吗」的唯一答案。**
 *
 * `video` 那一格问审片那条记录（粗剪审片是它的主人），其余问 `stageReviews`。
 * 具名、可导出、生产与测试共用一份（§2.5d）—— 界面与闸门都调它，所以两处不可能
 * 对同一张图给出不同答案。
 */
export function isStageArtifactApproved(prod, shotId, stage, assetId) {
  if (stage === "video") return isApprovedFor(prod, shotId, assetId);
  return isStageApprovedFor(prod, shotId, stage, assetId);
}

/** 记下「这一张通过了」。拒绝没有 assetId 的通过 —— 说不出通过了什么的记录，
 *  事后什么也证明不了（与 `approveShot` 同一条）。 */
export function approveStage(prod, shotId, stage, assetId, at, note = "") {
  if (!nonEmpty(shotId) || !nonEmpty(stage) || !nonEmpty(assetId)) return false;
  if (!nonEmpty(at) || !at.trim()) return false;
  if (!isObj(prod.shotProduction.stageReviews)) prod.shotProduction.stageReviews = {};
  const all = prod.shotProduction.stageReviews;
  if (!isObj(all[shotId])) putKey(all, shotId, {});
  all[shotId][stage] = {
    approved: true,
    assetId,
    approvedAt: at,
    note: typeof note === "string" ? note : "",
  };
  return true;
}

/** 撤销这个 stage 的通过（「重出」按下时用）。**删记录，不写 approved:false** ——
 *  加法字段的反面是移除，留一条 false 会让「撤销过」与「从没通过」两个形状并存。 */
export function unapproveStage(prod, shotId, stage) {
  const all = prod.shotProduction.stageReviews;
  if (!isObj(all) || !isObj(all[shotId]) || !isObj(all[shotId][stage])) return false;
  delete all[shotId][stage];
  if (!Object.keys(all[shotId]).length) delete all[shotId];
  return true;
}

export function reviewOf(prod, shotId) {
  const r = prod.shotProduction.reviews[shotId];
  return isObj(r) ? r : null;
}

/** Record the creator's 「通过」 FOR ONE SPECIFIC VIDEO. An explicit human
 *  decision — nothing derives it, and no generation success ever sets it
 *  (生成成功 != 镜头完成). Refused without the video's assetId: an approval that
 *  cannot say what it approved is not usable evidence of anything. */
export function approveShot(prod, shotId, videoAssetId, at, note = "") {
  if (!nonEmpty(shotId) || !nonEmpty(videoAssetId)) return false;
  putKey(prod.shotProduction.reviews, shotId, {
    approved: true,
    assetId: videoAssetId,
    approvedAt: strOrNull(at),
    note: typeof note === "string" ? note : "",
  });
  return true;
}

/** Withdraw an approval (「重新审」). Removing the record is right: the state is
 *  「no approval is recorded」, not 「approved: false」 — a false would claim the
 *  creator actively rejected the shot, which is a different thing. */
export function unapproveShot(prod, shotId) {
  if (!isApproved(prod, shotId)) return false;
  delete prod.shotProduction.reviews[shotId];
  return true;
}

// ---- references ------------------------------------------------------------ //

/** The canonical Reference keys bound to this shot (order preserved). */
export function referencesOfShot(prod, shotId) {
  const list = prod.shotProduction.references[shotId];
  return Array.isArray(list) ? [...list] : [];
}

/** Bind a canonical Reference to a shot. The SAME key may be bound to any
 *  number of shots — that is sharing, and it is the point. */
export function addShotReference(prod, shotId, referenceKey) {
  if (!nonEmpty(shotId) || !nonEmpty(referenceKey)) return false;
  const list = referencesOfShot(prod, shotId);
  if (list.includes(referenceKey)) return false;
  list.push(referenceKey);
  putKey(prod.shotProduction.references, shotId, list);
  return true;
}

export function removeShotReference(prod, shotId, referenceKey) {
  const list = referencesOfShot(prod, shotId);
  const next = list.filter((k) => k !== referenceKey);
  if (next.length === list.length) return false;
  if (next.length) putKey(prod.shotProduction.references, shotId, next);
  else delete prod.shotProduction.references[shotId];
  return true;
}

/** Every shot that uses this reference — the answer to 「这个参考被哪里用了」
 *  on the production side. Derived, never stored. */
export function shotsUsingReference(prod, referenceKey) {
  const out = [];
  const map = prod.shotProduction.references;
  for (const shotId of Object.keys(map)) {
    if (Array.isArray(map[shotId]) && map[shotId].includes(referenceKey)) out.push(shotId);
  }
  return out;
}

/** Drop bindings to references that no longer exist. Called with the set of
 *  live reference keys; a binding to a deleted reference is dead data that
 *  would render as a phantom chip. Returns the number of bindings removed. */
export function pruneShotReferences(prod, liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(Array.isArray(liveKeys) ? liveKeys : []);
  let removed = 0;
  const map = prod.shotProduction.references;
  for (const shotId of Object.keys(map)) {
    const list = Array.isArray(map[shotId]) ? map[shotId] : [];
    const next = list.filter((k) => live.has(k));
    removed += list.length - next.length;
    if (next.length) putKey(map, shotId, next);
    else delete map[shotId];
  }
  return removed;
}

// ---- derived standing ------------------------------------------------------ //

/** Is this shot DESIGNED? True once any generation-consumed design facet
 *  carries content — a title alone is a placeholder, not a design. */
export function isDesigned(shot) {
  if (!isObj(shot)) return false;
  return DESIGN_FACETS.some((k) => typeof shot[k] === "string" && shot[k].trim());
}

/**
 * The production stage of ONE shot, DERIVED from what actually exists.
 *
 * `media` is { image: bool, video: bool } — whether the shot has a current
 * image / video Asset. The caller resolves that from the registry, so this
 * module stays pure and there is exactly one place the rule lives.
 *
 * 生成成功 != 镜头完成: a shot with a video is `todo-review`, never `approved`.
 * Only a recorded human approval reaches the last stage.
 */
export function shotStage(prod, shot, media) {
  // NOW A SUMMARY OVER THE SIX STAGES (ADR-0073 决策 6). The five words and this
  // signature are unchanged, and so is every answer it gives — what changed is
  // that there is no longer a second place where a shot's standing is computed.
  // The linear chain that used to live here WAS that second place: it read the
  // media map directly, so the moment 六个 stage 出现，两者必然开始漂移。
  //
  // An approval is only the CURRENT standing while the thing that was approved
  // is still there. Delete or switch away the video and the shot is no longer
  // 已通过 — it has an approval on record for footage that is gone, which is a
  // different (and less finished) situation. The RECORD is kept either way:
  // the creator really did approve something, and erasing that would destroy a
  // real decision. `staleApproval` is how the UI says so.
  return summarizeStages(stagesFromMedia(prod, shot, media), { designed: isDesigned(shot) });
}

/**
 * The six stages as far as a plain `{ image, video }` media map can answer them.
 *
 * WHY IT IS SEPARATE AND DELIBERATELY PARTIAL. `stageStatuses` wants real evidence
 * — an in-flight Run, a probe verdict, an approval bound to an asset. The three
 * legacy consumers hand over only what they always had, and inventing the rest
 * would be exactly the 「声明当事实」 this ADR exists to stop. So this adapter says
 * what the media map genuinely proves and nothing more: 有图 / 有视频 / 那条视频有没有
 * 被批准。Storyboard / voice / sfx are honestly `not_started` here, and the surfaces
 * that need the real answer (向导 / 画布 / QC) call `stageStatuses` with real
 * evidence instead.
 */
export function stagesFromMedia(prod, shot, media) {
  const shotId = isObj(shot) ? shot.shotId : null;
  const m = isObj(media) ? media : {};
  const stages = isObj(prod) && isObj(prod.shotProduction) ? prod.shotProduction.stages || {} : {};
  return stageStatuses(stages, shotId, {
    inflight: () => false, // a media map cannot know; never guessed as 「进行中」
    artifact: (stage) => {
      if (stage === "keyframe") return m.image ? { assetId: m.imageAssetId || null, present: true } : null;
      if (stage === "video") return m.video ? { assetId: m.videoAssetId || null, present: true } : null;
      return null;
    },
    approvedFor: (assetId) => isApprovedFor(prod, shotId, assetId),
  });
}

/** True when a shot carries an approval that no longer describes what is on
 *  screen: the approved video was deleted, or a different take is current now.
 *  The record stays (a real decision was made); this is how the UI says it no
 *  longer applies. */
export function hasStaleApproval(prod, shot, media) {
  const shotId = isObj(shot) ? shot.shotId : null;
  const m = isObj(media) ? media : {};
  return !!(nonEmpty(shotId) && isApproved(prod, shotId) && !isApprovedFor(prod, shotId, m.videoAssetId));
}

/** Tally the stages across a shot list — the Episode's production standing.
 *  `mediaOf(shot)` returns { image, video } for one shot. */
export function stageCounts(prod, shots, mediaOf) {
  const counts = Object.fromEntries(SHOT_STAGES.map((s) => [s, 0]));
  for (const s of Array.isArray(shots) ? shots : []) {
    counts[shotStage(prod, s, mediaOf ? mediaOf(s) : null)] += 1;
  }
  return { ...counts, total: Array.isArray(shots) ? shots.length : 0 };
}
