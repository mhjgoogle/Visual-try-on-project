// 「一次生成 = 一张卡」的共同形状 (TASK-097 §2.1) —— 五处生成，一个组件。
//
// 本链有五处会向模型要东西：
//
//   asset-image   ② 准备资产的设定图        TASK-095 §2.2 图 4
//   prompt        ③ 合成提示词              TASK-095 §2.3 图 5
//   storyboard    ④ 低成本草图              TASK-095 §2.4  ← 便宜档
//   keyframe      ⑤ 多图合成的正式画面      TASK-095 §2.5  ← 正式档
//   video         批量生视频                既有
//
// 每一处都需要同样的六件东西：Prompt · 参考 chip · 模型 · 规格 · **报价** · 提交。
// TASK-078 批次 B 已经把 video 那一处做成了一张卡（ui/gencard.js）；不抽出来，剩下四处
// 会各自摸索一遍，然后四处各有一个自算报价的机会。
//
// 这个模块只负责**不变量**，不负责画面：
//
//   1. 报价**只来自 Gateway preflight**，界面永不自算（ADR-0071 决策 6，
//      TASK-078 批次 B 已有守卫）。`quoteView` 是唯一的读法，它拒绝任何没有 preflight
//      出处的东西 —— 让「乘一下」这个动作在代码里没有落脚点。
//   2. 规格（模型 / 分辨率 / 时长 / 能力）同样只从 preflight 读，读不到就说读不到，
//      **不显示看起来合理的默认值**。
//   3. 每一处生成声明自己的**档位**。Storyboard 是便宜档、Keyframe 是正式档，这不是
//      注释而是数据：守卫测试断言草图路径不得请求 2K（TASK-095 §6）。
//
// PURE。无 fetch / DOM / clock。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/**
 * 一个金额可不可以显示给创作者看。
 *
 * ONE PREDICATE FOR THE WHOLE CHAIN (codex rounds 1–2). Both rounds found the same
 * defect in a different spelling — `total.amount`, per-item `spent`, and then
 * `cost.jpy` — because each site did its own `Number.isFinite` check and 「有限」
 * happily includes −84. A negative amount is malformed data, never a discount, and
 * the surface it would land on is the last line a creator reads before spending.
 * Exported so `batchpay` uses the same one rather than a fourth copy.
 */
export const isDisplayableAmount = (x) => Number.isFinite(x) && x >= 0;

/* -------------------------------------------------------------------------- */
/* 五处生成，闭集                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `tier` 是**成本阶梯**（TASK-095 §1.2），不是形容词：
 *
 *   draft   低画质 / 小尺寸 —— 便宜是它存在的全部理由
 *   final   正式档
 *   text    产出是文字，不是像素
 *
 * `paidToday` 记的是**今天真的有付费写路径吗**。图片付费生成没有被 ADR-0038 批准，
 * 所以一张提供「提交（付费）」的资产图卡是在承诺一条不存在的路
 * （paid_gateway.py: "Paid scope is VIDEO ONLY"）。写成数据，免得五处各判断一次。
 */
export const GEN_SITES = [
  {
    id: "asset-image",
    label: "设定图",
    tier: "final",
    mediaKind: "image",
    paidToday: false,
    why: "付费图片生成尚未获批（ADR-0038 未 Accepted）—— 用免费路线生成再导入",
  },
  {
    id: "prompt",
    label: "提示词",
    tier: "text",
    mediaKind: "text",
    paidToday: false,
    why: "提示词合成走 Skill 运行，不是媒体生成命令",
  },
  {
    id: "storyboard",
    label: "分镜草图",
    tier: "draft",
    mediaKind: "image",
    paidToday: false,
    why: "草图落免费 / 手工路线（TASK-092 §2.7 第 2 条：零花费）",
  },
  {
    id: "keyframe",
    label: "关键帧",
    tier: "final",
    mediaKind: "image",
    paidToday: false,
    why: "多图合成需要 provider 声明「多图不额外计费」（ADR-0071 方案 C）",
  },
  {
    id: "video",
    label: "视频",
    tier: "final",
    mediaKind: "video",
    paidToday: true,
    why: null,
  },
];

const SITE_BY_ID = new Map(GEN_SITES.map((s) => [s.id, s]));

export const genSite = (id) => SITE_BY_ID.get(id) || null;

/** 便宜档不得请求正式档的规格。写成一条可测的判定，而不是散在四处的注释 ——
 *  TASK-095 §6:「守卫测试：草图路径不得请求 2K」。 */
const FINAL_ONLY_RESOLUTIONS = ["2K", "2k", "4K", "4k", "2160", "1440"];

export function specViolations(siteId, inputs) {
  const site = genSite(siteId);
  if (!site || !isObj(inputs)) return [];
  const out = [];
  const res = nonEmpty(inputs.resolution) ? inputs.resolution : "";
  if (site.tier === "draft" && FINAL_ONLY_RESOLUTIONS.some((r) => res.includes(r))) {
    out.push(`${site.label}是便宜档，不得按 ${res} 出图 —— 便宜是这一步存在的理由（TASK-095 §1.2）`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 报价：唯一读法                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 把一次 Gateway preflight 读成界面能显示的报价。**这是唯一的读法。**
 *
 * 它刻意不接受「金额 + 币种」这样的裸参数：能被裸参数调用的函数，就能被
 * `unit * n` 调用，而那正是 ADR-0071 决策 6 要挡住的动作。要拿到一个报价，你必须
 * 手上真的有一份 preflight 响应。
 *
 * 金额**不做任何除法**（TASK-078 批次 B codex 第 2 轮）：「minor units」的指数按币种
 * 不同（USD 2 / JPY 0 / KWD 3），固定 ÷100 会把 ¥28 印成 ¥0.28 —— 一个错误的数字，
 * 出现在创作者花钱前最后读的那一行。
 */
export function quoteView(preflight) {
  if (!isObj(preflight)) {
    return { available: false, reason: "还没有向 Gateway 取过报价", blockers: [], cost: null, inputs: null };
  }
  const blockers = Array.isArray(preflight.blockers) ? preflight.blockers.filter(nonEmpty) : [];
  if (blockers.length) {
    return { available: false, reason: blockers[0], blockers, cost: null, inputs: isObj(preflight.inputs) ? preflight.inputs : null };
  }
  const cost = isObj(preflight.cost) ? preflight.cost : null;
  if (!cost || !isDisplayableAmount(cost.jpy)) {
    return {
      available: false,
      // WORDING IS PART OF THE CONTRACT HERE: 「报价不可用」 is what TASK-078 批次 B
      // put on screen and what its guard asserts. The reason is appended, not
      // substituted — a creator who sees a price go missing needs the same three
      // words they have always seen, plus why.
      reason: "报价不可用 —— 预检没有给出报价，界面不自算（ADR-0071 决策 6）",
      blockers,
      cost: null,
      inputs: isObj(preflight.inputs) ? preflight.inputs : null,
    };
  }
  return {
    available: true,
    reason: null,
    blockers,
    cost: {
      jpy: cost.jpy,
      originalCurrency: nonEmpty(cost.original_currency) ? cost.original_currency : null,
    },
    inputs: isObj(preflight.inputs) ? preflight.inputs : null,
    source: "gateway-preflight",
  };
}

/**
 * 规格四行，全部来自 preflight。
 *
 * 读不到就返回 `known: false`，由界面写「未知 —— 按『⚡报价』向 Gateway 取一次」。
 * **不填默认值**：一张写着「2K · 6s」而实际没人问过 Gateway 的卡，比一张写「未知」的卡
 * 危险得多。
 */
export function specRows(preflight) {
  const q = quoteView(preflight);
  if (!q.inputs) return { known: false, rows: [] };
  const i = q.inputs;
  return {
    known: true,
    rows: [
      ["模型", nonEmpty(i.model) ? i.model : null],
      ["分辨率", nonEmpty(i.resolution) ? i.resolution : null],
      ["时长", i.duration != null ? `${i.duration}s` : null],
      ["能力", nonEmpty(i.capability) ? i.capability : null],
    ],
  };
}
