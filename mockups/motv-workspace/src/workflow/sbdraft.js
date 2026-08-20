// ④ Storyboard 草图 (TASK-095 §2.4 / TASK-097 批次 4F)。
//
// 产品负责人当场补上的一步，而且他补的是目标产品自己的一个缺陷：**从一段文字直接
// 跳到整条链上最贵的一步，中间没有任何一次便宜的目视确认。**
//
// 所以这一步的性质由两件事定义：
//
//   1. **便宜是它存在的理由。** 低画质、小尺寸 —— 界面写明这是草图。
//      守卫：草图路径**不得**请求 2K（见 `draftSpec` / `specViolationsForDraft`）。
//   2. **一次出全集，横着看。** 「前后 Shot 接起来是否顺」是跨镜判断，
//      单镜视图看不见它。
//
// ─────────────────────────────────────────────────────────────────────────────
// 不新建第二套视图模型（TASK-095 §2.4 的原话）
//
// ⑨ 粗剪审片与这一条带**共用同一个底座**：`ui/dailies.js dailiesModel` —— 一行一镜、
// 带 stage 与通过状态的那份清单。粗剪审片是它的一个渲染器（视频列 + 播放），
// 这条带是另一个（草图列 + 三选一）。**共用的是底座，不是它的视频行**：把草图硬塞进
// 一个为视频写的行里，只会得到一堆永远为空的字段，而那与「第二套」一样坏。
//
// 三选一：**通过 / 重出 / 跳过**
//   通过  绑到**那一张具体的草图**（`shotprod.isStageArtifactApproved`）——
//         换一张草图，通过自动失效
//   重出  撤销通过、再出一张（不改任何持久判定，只是让它回到「还没通过」）
//   跳过  写 `stages[shotId].storyboard`（ADR-0073 决策 8 里唯一被持久化的状态）
//
// **`skipped` 与「还没做」在界面上必须可区分**（§2.5f 第一条的同一形状）：
// 前者是一个人做过的决定，后者是一件还没发生的事。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE：读模型 + 判定。无 DOM、无 fetch、无写入。

import { isSkipped } from "./shotstage.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim() : "");

/**
 * 草图的规格 —— **便宜档**。
 *
 * 这不是「随便设个小尺寸」：④ 存在的全部理由就是在最贵那一步之前先花一点点钱看一眼。
 * 一旦草图按 2K 出，它就既不便宜、也不比 ⑤ 早看到什么 —— 那一步就没有意义了。
 */
export const DRAFT_SPEC = Object.freeze({
  quality: "draft",
  resolution: "512p",
  aspect: "16:9",
  label: "草图档（低画质小尺寸）",
});

/** 草图路径**不得**请求的东西。具名、可导出，生产与测试共用一份（§2.5d）。 */
export const DRAFT_FORBIDDEN_RESOLUTIONS = Object.freeze(["2K", "2k", "4K", "4k", "1080p", "1440p", "2160p"]);

/**
 * 这份请求规格能不能走草图路径。
 *
 * 返回违规原因数组（空 = 可以）。**两个方向都钉**（§2.5d）：
 * 高清一律拒，而**草图档必须真的放行** —— 只会拒绝的守卫迟早被关掉。
 */
export function draftSpecViolations(spec) {
  const s = isObj(spec) ? spec : {};
  const out = [];
  const res = str(s.resolution);
  if (!res) out.push("草图请求没有说清分辨率 —— 说不出规格的请求不知道自己便不便宜");
  else if (DRAFT_FORBIDDEN_RESOLUTIONS.includes(res)) {
    out.push(`草图不得按 ${res} 出 —— ④ 存在的理由就是便宜，高清草图既不便宜也不比 ⑤ 早`);
  }
  if (str(s.quality) && str(s.quality) !== "draft") {
    out.push(`草图的画质档应为 draft，收到的是 ${str(s.quality)}`);
  }
  return out;
}

/**
 * 一条带的模型。
 *
 * `items` 是 `dailiesModel(...).items`（同一个底座，见文件头）。
 * `draftOf(shotId)` 给这一镜**当前那张草图**：`{assetId, url, version, present}`
 * —— `present` 来自探针，与 TASK-092 的 `completed` 用同一份证据口径。
 * `stages` 是 `shotProduction.stages`；`approvedFor(shotId, assetId)` 是生产那份谓词。
 */
export function storyboardStrip({ items, stages, draftOf, approvedFor } = {}) {
  const list = Array.isArray(items) ? items.filter(isObj) : [];
  const of = typeof draftOf === "function" ? draftOf : () => null;
  const okOf = typeof approvedFor === "function" ? approvedFor : () => false;
  const rows = list.map((it) => {
    const shotId = str(it.shotId);
    const skipped = isSkipped(stages, shotId, "storyboard");
    const draft = of(shotId);
    const has = !!(isObj(draft) && draft.present === true && str(draft.assetId));
    const approved = has ? !!okOf(shotId, draft.assetId) : false;
    // **四种状态，互不混淆**（§2.5f 第一条）：
    //   skipped     人决定不画 —— 是一个决定，不是一个空位
    //   approved    这一张通过了（绑在这一张上）
    //   drafted     有草图，还没通过
    //   not_started 还没画
    const state = skipped ? "skipped" : approved ? "approved" : has ? "drafted" : "not_started";
    return {
      shotId,
      seq: typeof it.index === "number" ? it.index + 1 : null,
      title: str(it.title) || "未命名镜头",
      sceneTitle: str(it.sceneTitle),
      draft: has ? { assetId: draft.assetId, url: str(draft.url), version: draft.version ?? null } : null,
      state,
      // 三个动作各自「现在能不能按」：通过要有一张具体的草图；重出任何时候都行；
      // 跳过在已经通过之后仍然允许（人可以改主意），但会先失去那条通过记录。
      canApprove: has && !approved,
      canRedraw: !skipped,
      canSkip: !skipped,
      canUnskip: skipped,
    };
  });
  const by = (s) => rows.filter((r) => r.state === s).length;
  return {
    rows,
    total: rows.length,
    approved: by("approved"),
    drafted: by("drafted"),
    skipped: by("skipped"),
    notStarted: by("not_started"),
    // 「⑤ 还差哪几镜」的话术由 4G 的闸门去说；这里只如实分类。
    spec: DRAFT_SPEC,
  };
}

/**
 * ④ → ⑤ 那道闸门对**一镜**的判定。
 *
 * TASK-095 §2.5 / ADR-0073：`skipped`（人决定不画）或（有草图**且**那张草图通过了）。
 * 具名、可导出、生产与测试共用一份 —— 4G 的清单与画布都调它。
 *
 * 返回 `{ ok, reason }`。**`reason` 只在 `ok` 为假时有内容**，而且它说的是
 * 「差什么」，不是「你不能进」。
 */
export function keyframeGate(row) {
  if (!isObj(row)) return { ok: false, reason: "这一镜不在清单里" };
  if (row.state === "skipped") return { ok: true, reason: "" };
  if (row.state === "approved") return { ok: true, reason: "" };
  if (row.state === "drafted") return { ok: false, reason: "草图还没通过 —— 在这条带上按「通过」，或者跳过这一镜" };
  return { ok: false, reason: "还没有草图 —— 先出一张，或者跳过这一镜" };
}
