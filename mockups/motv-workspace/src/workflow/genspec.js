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

/* -------------------------------------------------------------------------- */
/* 参考图能力：目录说了什么（ADR-0071 决策 4 / 决策 5）                          */
/* -------------------------------------------------------------------------- */

/**
 * 把 preflight 里的 `inputs.reference_images` 读成界面能说的一句话。
 *
 * WHY IT LIVES HERE AND NOT IN A NEW MODULE (TASK-097 §2.5b). 这是「报价与规格只有
 * 一个读法」那条不变量的同一处：能力和报价来自**同一份** preflight 响应，分开读会
 * 立刻产生「按 A 的能力显示、按 B 的报价收费」的缝。批次 0 那 15 个 P1 有一半是这个
 * 形状，所以这里扩展既有模块，而不是新写一份。
 *
 * 三种答案，界面必须分得清：
 *
 *   declared + max>0   这个 model 真的吃 N 张图
 *   declared + max=0   目录明确说它不吃 —— 那些图**不会进模型**
 *   未 declared        目录里没有这个 model；按 fail-closed 读成不吃，
 *                      但**说法不同**：「不知道」不等于「已知为 0」
 */
export function referenceCapability(preflight) {
  const q = quoteView(preflight);
  const raw = q.inputs && isObj(q.inputs.reference_images) ? q.inputs.reference_images : null;
  if (!raw) {
    return {
      known: false,
      maxImages: 0,
      addressable: false,
      roles: [],
      // 「没问过」与「问过，答案是 0」不是一回事。前者该去取报价，后者是事实。
      note: "还不知道这个模型吃不吃参考图 —— 按「⚡报价」向 Gateway 取一次",
    };
  }
  const maxImages = Number.isInteger(raw.max) && raw.max > 0 ? raw.max : 0;
  const declared = raw.declared === true;
  return {
    known: true,
    declared,
    maxImages,
    addressable: raw.addressable === true,
    roles: Array.isArray(raw.roles) ? raw.roles.filter(nonEmpty) : [],
    // `providerLabel` 让 batchpay 的方案 C 拒绝语句能指名道姓
    providerLabel: nonEmpty(q.inputs.model) ? q.inputs.model : null,
    note: maxImages > 0
      ? `这个模型接受 ${maxImages} 张参考图${raw.addressable === true ? "，并且认得提示词里的 [[ref:N]] 编号" : "，但不认编号指代"}`
      : declared
        ? "目录明确声明这个模型**不吃参考图** —— 绑定的参考图不会进模型，只会被 AI 解读成提示词里的文字"
        : "目录里没有这个模型的参考图声明 —— 按 fail-closed 当作不吃（ADR-0071 决策 4）",
  };
}

/**
 * 这一组参考图能不能送给这个模型 —— 与后端
 * `paid_coordinator.reference_capability_violation` **同一套判据**。
 *
 * 两边都要有，理由不是冗余：界面必须在**点提交之前**就说清楚，而后端必须在
 * **花钱之前**再拦一次。少了前者创作者会白绑一堆图；少了后者一个绕过界面的调用
 * 就能把图悄悄丢掉（ADR-0071 决策 5：那是拒绝，不是截断）。
 */
export function referenceViolation(capability, { count = 0, markers = [], usesMarkers = false, roles = [] } = {}) {
  // 标记要按**编号**判，不是按「有没有用标记」这个布尔（codex 轮 5）。
  // 只传布尔时，两张图 + `[[ref:99]]` 在界面上是合法的，而后端会拒 —— 创作者点了
  // 提交才看到一个莫名其妙的失败。悬空判定必须与后端逐条对齐，用的是同一条规则：
  // 编号必须落在 1..N 之内。
  const raw = Array.isArray(markers) ? markers.filter((n) => typeof n === "number") : [];
  // 位数超限的编号在 `refMarkers` 里是 `Infinity`。它**不能被过滤掉**：那是一个真的
  // 写在提示词里的标记，只是不可能命中任何图，而后端会明确拒绝它（codex 轮 6）。
  if (raw.some((n) => !Number.isFinite(n))) {
    return "提示词里有一个编号长得离谱的 [[ref:N]] 标记 —— 它不可能对应任何一张参考图";
  }
  const ordinals = raw.filter((n) => Number.isInteger(n));
  const anyMarker = ordinals.length > 0 || usesMarkers === true;
  const dangling = [...new Set(ordinals.filter((n) => n < 1 || n > count))].sort((a, b) => a - b);
  if (dangling.length) {
    return `提示词里的 ${dangling.map((n) => `[[ref:${n}]]`).join("、")} 指向不存在的参考`
      + `（这一镜绑定了 ${count} 张，编号只能是 1..${count}）`;
  }
  // 零张图时**仍要**检查标记（codex 轮 4）—— 后端在轮 2 修的正是同一个早退：
  // 一条写着 [[ref:1]] 而集合为空的提示词，界面放行、后端拒绝。
  if (anyMarker && !count) {
    return "提示词里用了 [[ref:N]]，但这一镜没有绑定任何参考图 —— 标记指向不存在的东西";
  }
  if (!count) return null;
  const cap = isObj(capability) ? capability : null;
  if (!cap || !cap.known) {
    return "还没有向 Gateway 取过这个模型的参考图能力 —— 先报价，不猜";
  }
  const label = cap.providerLabel ? `模型 ${cap.providerLabel}` : "这个模型";
  if (cap.maxImages <= 0) {
    return `${label}没有声明多图支持，所以这 ${count} 张参考图送不出去。`
      + "ADR-0071 方案 C：拒绝，而不是悄悄少送几张 —— 降级会让「用了角色设定图」这句话变成谎。";
  }
  if (count > cap.maxImages) {
    return `${label}接受 ${cap.maxImages} 张参考图，现在绑了 ${count} 张 —— 请选留哪几张。`
      + "多出来的不会被截断：静默丢弃就是「界面显示已应用、实际没应用」。";
  }
  if (anyMarker && !cap.addressable) {
    return `${label}不认编号指代，但提示词里用了 [[ref:N]]`;
  }
  if (cap.roles.length) {
    const bad = [...new Set((Array.isArray(roles) ? roles : []).filter((r) => nonEmpty(r) && !cap.roles.includes(r)))];
    if (bad.length) return `${label}不接受这些参考角色：${bad.join("、")}（它只接受 ${cap.roles.join("、")}）`;
  }
  return null;
}
