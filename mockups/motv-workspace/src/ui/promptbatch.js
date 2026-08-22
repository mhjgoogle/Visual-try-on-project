// 「一键合成全部提示词」 (TASK-095 §2.3 / TASK-097 批次 4D) —— **batchpay 的第一个
// 真实调用方**。
//
// 批次 0 把批量付费的五条硬约束做成了 `workflow/batchpay.js`（396 行，那 15 个 P1
// 里九个的落点）。到批次 4C 结束它**应用侧调用方仍然是 0** —— §2.5c 那条
// 「读起来与功能完成一模一样」的活标本。这个文件就是接线。
//
// **这里不重新推导任何东西**（§2.5b）：总额、币种、条数一致性、确认与中止的状态
// 机、失败不算成功、迟到回执 —— 全部是 `batchpay` 的导出在管。本文件只做三件事：
//
//   1. 把「这一集要合成哪些镜头」整理成 batch 的 items
//   2. 把 Gateway 的 preflight 交给 `applyPreflight`
//   3. 把每一镜的结果交给 `recordItem`，并把 `settlementLine` 显示出来
//
// **付费红线**：本模块不发起任何真实扣费。preflight 由调用方给，确认按 ADR-0041
// 的两步由创作者在界面上完成，`submit` 只在**已确认**的批次上工作。
//
// PURE-ish：模型与渲染是纯的；`bind` 只调用注入的 ctx 方法。

import { esc } from "../util/dom.js";
import {
  createBatch, applyPreflight, confirmBatch, abortBatch, recordItem,
  settlement, settlementLine,
} from "../workflow/batchpay.js";
import { countText } from "../workflow/counts.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * 这一批要合成哪些镜头。
 *
 * **只包含真的需要合成的那些**：已经有两份提示词的镜头不重复付费。
 * 「哪些算已合成」不在这里判断 —— 它是 `counts.PRODUCTION_COUNTS.promptsComposed`
 * 的口径，由调用方用同一个 `promptsOf` 传进来（§2.6.2：一个计数一份定义）。
 */
export function batchItems({ shots, promptsOf } = {}) {
  const of = typeof promptsOf === "function" ? promptsOf : () => null;
  const list = Array.isArray(shots) ? shots.filter(isObj) : [];
  const items = [];
  const already = [];
  for (const s of list) {
    const id = typeof s.shotId === "string" ? s.shotId : "";
    if (!id) continue;
    const p = of(id);
    const done = isObj(p) && p.image === true && p.video === true;
    (done ? already : items).push({ id, label: s.title || id });
  }
  return { items, already };
}

/**
 * 建一个「合成提示词」批次。转交 `createBatch` —— 它会拒绝重复 id 与无 id 条目，
 * 而**拒绝而不是跳过**正是它存在的理由（创作者确认「14 镜」就必须是 14 镜）。
 */
export function startPromptBatch({ shots, promptsOf } = {}) {
  const { items, already } = batchItems({ shots, promptsOf });
  // **「没有要做的」与「这一批被拒绝」是两件事**（§2.5f 第一条的同一形状）。
  //
  // `createBatch([])` 会如实拒绝（「不会为空批次开预检」），那对它是对的。但把这个
  // 拒绝直接摆到创作者面前，屏幕上就是「没能建批次」—— 而真实情况是**60/60 都已经
  // 合成了，本来就没有活要干**。真实项目上第一次点这个按钮看到的正是那句话。
  if (!items.length) {
    return { batch: null, already, nothingToDo: true };
  }
  // `createBatch` **返回批次本身**（拒绝时是 `state:"refused"` + `refusal`），
  // 不是 `{batch, refused}` —— 第一版按想象包了一层，于是控制器读 `made.batch`
  // 读到 undefined。合同以那个模块为准，不以我的记忆为准。
  const batch = createBatch({ kind: "prompt-compose", items });
  return { batch, already, nothingToDo: false };
}

/**
 * 界面模型。**报价只来自 preflight**（ADR-0071 决策 6）：这里没有任何乘法。
 */
export function promptBatchModel(batch, counts = null) {
  if (!isObj(batch)) {
    return {
      exists: false,
      // 「还没建批次」与「批次里 0 条」是两件事（§2.5f 第一条）
      text: "还没有待合成的批次 —— 点「一键合成全部提示词」先看总额",
      composed: counts ? countText("promptsComposed", counts) : null,
    };
  }
  const st = settlement(batch);
  return {
    exists: true,
    state: batch.state,
    total: st.total,
    quote: batch.quote || null,
    line: settlementLine(batch),
    settlement: st,
    composed: counts ? countText("promptsComposed", counts) : null,
  };
}

export function renderPromptBatch(m) {
  if (!isObj(m)) return "";
  if (!m.exists) {
    return (
      `<div class="pb"><span class="meta">${esc(m.text)}</span>` +
      (m.composed ? `<span class="chip">${esc(m.composed)}</span>` : "") +
      `<button class="btn primary sm" data-pb-start>一键合成全部提示词</button></div>`
    );
  }
  const q = m.quote;
  return (
    `<div class="pb pb-open" data-pb="1">` +
    `<div class="pb-h"><b>合成全部提示词</b>` +
    `<span class="meta">${m.total} 个镜头</span>` +
    (m.composed ? `<span class="chip">${esc(m.composed)}</span>` : "") +
    `</div>` +
    // 总额：preflight 给的那一个数。**没有就说没有**，不乘单价。
    `<div class="pb-quote">${q && q.amount != null
      ? `合计 ${esc(String(q.amount))} ${esc(q.currency || "")}（覆盖 ${esc(String(q.count))} 条）`
      : "还没有总额 —— 先向 Gateway 取一次预检；界面不自算"}</div>` +
    `<div class="pb-line">${esc(m.line)}</div>` +
    `<div class="pb-acts">` +
    // **每一个状态都要有出路**（codex round 3）。第一版只给 quoted / running 配了
    // 按钮，于是预检失败留下的 `draft` 批次是一个**死局**：既不能重试预检，
    // 也不能重新开始 —— 界面把创作者关在里面了。
    (m.state === "draft"
      ? `<button class="btn primary sm" data-pb-requote>重新取总额</button>` +
        `<button class="btn sm" data-pb-discard>放弃这一批</button>`
      : "") +
    (m.state === "quoted"
      ? `<button class="btn primary sm" data-pb-confirm>确认并开始（第二步确认）</button>` +
        `<button class="btn sm" data-pb-discard>放弃这一批</button>`
      : "") +
    (m.state === "running"
      ? `<button class="btn sm" data-pb-abort>中止</button>`
      : "") +
    (m.state === "refused" || m.state === "aborted" || m.state === "done"
      ? `<button class="btn sm" data-pb-discard>关掉这一批</button>`
      : "") +
    `</div></div>`
  );
}

export function bindPromptBatch(root, ctx, ui, rerender) {
  const start = root.querySelector("[data-pb-start]");
  if (start) start.onclick = () => { ctx.promptBatch.start(); rerender(); };
  const confirm = root.querySelector("[data-pb-confirm]");
  if (confirm) confirm.onclick = () => { ctx.promptBatch.confirm(); rerender(); };
  const abort = root.querySelector("[data-pb-abort]");
  if (abort) abort.onclick = () => { ctx.promptBatch.abort(); rerender(); };
  const requote = root.querySelector("[data-pb-requote]");
  if (requote) requote.onclick = () => { ctx.promptBatch.requote(); rerender(); };
  const discard = root.querySelector("[data-pb-discard]");
  if (discard) discard.onclick = () => { ctx.promptBatch.discard(); rerender(); };
}


/* -------------------------------------------------------------------------- */
/* 谁给这一批报价                                                              */
/* -------------------------------------------------------------------------- */

/**
 * **合成提示词这件事，在我们的产品里是本地免费的。**
 *
 * `promptc` 是纯编译：60 个镜头合成两份提示词不向任何 provider 发一个字节。
 * 目标产品在这里收 ⚡6，是因为它那一步是模型在写；我们这一步是我们自己的代码在拼。
 *
 * 所以这一批的总额是 **0**，而这**不是界面自算**：
 *   - 「厂商这次收多少」永远只能来自 Gateway preflight（ADR-0071 决策 6）。界面
 *     乘一遍单价，就是那条禁令说的事。
 *   - 「我们自己的本地计算不花钱」是**关于我们自己代码的事实**，不是对厂商价目表
 *     的猜测。它由这个具名谓词说出来，生产与测试共用同一份（§2.5d）。
 *
 * 判据是**路线**，不是心情：只有本地路线才允许 0。付费路线一律必须拿 Gateway 的
 * 答复，拿不到就停在待报价 —— 不许在这里补一个 0（那才是自算）。
 */
export function localComposeIsFree(route) {
  return route !== "gateway";
}

/**
 * 本地路线的「预检答复」。形状与 Gateway 的一致，交给 `applyPreflight` 校验 ——
 * 条数、币种、非负金额那三道检查照走，一条都不绕过。
 */
export function localComposeQuote(count, currency = "JPY") {
  return {
    total: { amount: 0, currency, count },
    preflight_digest: null,
    source: "local-compose",
  };
}


/**
 * 从持久文档里取回这一种批量的状态（v18 / 批次 4D）。
 *
 * **读不懂就当没有**（fail-closed）：一个形状不对的批次会让 `settlement` 据它印出
 * 「已花多少」，而那个数字没有任何来源 —— 宁可显示「还没有批次」，让创作者重新
 * 建一次（本地合成重跑不花钱；付费批量重跑前会重新走一次两步确认）。
 */
export function hydrateBatch(saved, kind) {
  if (!isObj(saved)) return null;
  const b = saved[kind];
  if (!isObj(b) || b.kind !== kind || !Array.isArray(b.items)) return null;
  const STATES = ["draft", "quoted", "running", "done", "aborted", "refused"];
  if (!STATES.includes(b.state)) return null;
  return b;
}


/**
 * 一镜的合成结果 —— **具名谓词，生产与测试共用一份**（§2.5d）。
 *
 * 判据不是「文本非空」。一份提示词可以非空**而且**因为 fail-closed 把参考图扣下了
 * ——那时它编出来的是一段**不带角色设定图**的提示词，报成 success 就是让批量说
 * 「60 镜全好了」而实际有 60 镜没有用上角色图（codex round 3 的那一条）。
 *
 * 所以：
 *   - 文本为空            → 失败（还编不出来）
 *   - 有参考被扣下        → 失败（这一镜的参考没送出去，原因跟着报）
 *   - 其余的 `missing`    → **不是失败**：那些是「填了更好」的建议（缺动作、
 *     缺表情…），把它们算成失败会让整批永远失败，而那等于这个功能不存在。
 */
export function composeOutcome({ image, video } = {}) {
  const reasons = [];
  const textOf = (p) => (p && typeof p.text === "string" ? p.text.trim() : "");
  if (!textOf(image)) reasons.push("分镜提示词编不出来");
  if (!textOf(video)) reasons.push("视频运动提示词编不出来");
  const withheld = [
    ...((image && Array.isArray(image.withheldReferences)) ? image.withheldReferences : []),
    ...((video && Array.isArray(video.withheldReferences)) ? video.withheldReferences : []),
  ];
  for (const w of withheld) {
    reasons.push(`${w.name || "一张参考"} 因为没有用法规则被扣下，没有随这一镜送出`);
  }
  return { ok: reasons.length === 0, reasons, withheld: withheld.length };
}

/** 转交，供控制器使用 —— 控制器不直接 import batchpay，避免出现第二处状态机知识。 */
export const batchOps = { applyPreflight, confirmBatch, abortBatch, recordItem, settlement };
