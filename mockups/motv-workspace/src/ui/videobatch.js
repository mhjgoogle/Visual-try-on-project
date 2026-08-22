// ⑥ 批量生视频 (TASK-095 §2.5 末段 / TASK-097 §2.3 · 批次 4E)。
//
// 五条硬约束全部由 `workflow/batchpay.js` 管（批次 0 打硬的那 396 行）：
// 总额来自 preflight、一次确认（ADR-0041 两步）、可中止、失败不算成功且已花的钱
// 如实记账、方案 C fail-closed。这一层只做三件事：谁进这一批、报价交给它、
// 每一镜的结果报回去。
//
// ─────────────────────────────────────────────────────────────────────────────
// **这一批与 4D 那一批的根本差别：视频要真花钱。**
//
// 4D 的「合成提示词」是本地编译，所以 0 是一个**关于我们自己代码的事实**。
// 视频不是：每一镜都要向厂商付费。于是有一条无法绕开的后果 ——
//
//   **Gateway 今天没有「批量预检」这个命令。**
//   拿不到整批总额，就不能开始这一批。
//
// 而**不能做的正确反应不是伪造一个数**：
//   - 逐镜预检再自己加起来 = 「单价 ×N 让人自己乘」，正是 batchpay 第 1 条禁止的；
//   - 补一个 0 = 谎，因为它真的要钱。
//
// 所以闸门关着时这一块**退化成真实可做的那件事**（§2.5h 第二条）：说明原因，
// 并把「逐镜生成」这条真实存在的路摆出来 —— 那条路每镜自己走 ADR-0041 的两步确认，
// 今天就能用。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE-ish：模型与渲染是纯的；`bind` 只调注入的 ctx 方法。

import { esc } from "../util/dom.js";
import {
  createBatch, applyPreflight, confirmBatch, abortBatch, recordItem,
  settlement, settlementLine,
} from "../workflow/batchpay.js";
import { countText } from "../workflow/counts.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** 这一种批量的 kind。写在一处 —— 序列化的「谁拥有它」要按这个名字来。 */
export const VIDEO_BATCH_KIND = "video-generate";

/**
 * 谁进这一批。
 *
 * **只装真的能生成的那些**：有首帧、还没有视频。判据由调用方注入
 * （`readyOf(shotId)` → `{ hasFrame, hasVideo }`）——「哪些算就绪」不在这里
 * 第二次定义（§2.6.2）。
 */
export function batchItems({ shots, readyOf } = {}) {
  const of = typeof readyOf === "function" ? readyOf : () => null;
  const items = [];
  const already = [];
  const blocked = [];
  for (const s of Array.isArray(shots) ? shots.filter(isObj) : []) {
    const id = typeof s.shotId === "string" ? s.shotId : "";
    if (!id) continue;
    const r = of(id) || {};
    const row = { id, label: s.title || id };
    if (r.hasVideo === true) already.push(row);
    else if (r.hasFrame === true) items.push(row);
    else blocked.push({ ...row, why: "还没有首帧 —— 先在 ⑤ 合成关键帧，或手工绑一张" });
  }
  return { items, already, blocked };
}

/** 建批次。转交 `createBatch`（重复 id / 无 id 一律拒绝，不静默跳过）。 */
export function startVideoBatch({ shots, readyOf } = {}) {
  const { items, already, blocked } = batchItems({ shots, readyOf });
  if (!items.length) return { batch: null, already, blocked, nothingToDo: true };
  return { batch: createBatch({ kind: VIDEO_BATCH_KIND, items }), already, blocked, nothingToDo: false };
}

/**
 * 界面模型。
 *
 * `quoteUnavailable` 是这一块的核心状态：**拿不到整批总额**。它不是错误，也不是
 * 「进行中」—— 它是一个如实的「今天做不了这件事，但那件事可以做」。
 */
export function videoBatchModel(batch, { counts = null, quoteUnavailable = null } = {}) {
  if (!isObj(batch)) {
    return {
      exists: false,
      text: "还没有批量任务 —— 点「批量生视频」先看这一批有多少镜、总额多少",
      done: counts ? countText("videoDone", counts) : null,
      quoteUnavailable: quoteUnavailable || null,
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
    done: counts ? countText("videoDone", counts) : null,
    // **被拒绝的批次不显示成「进行中」**（batchpay 第 4 条那一族）
    refused: batch.state === "refused" ? (batch.refusal || { reason: "这一批被拒绝了" }) : null,
    quoteUnavailable: batch.state === "draft" ? (quoteUnavailable || null) : null,
  };
}

/** 拿不到总额时那一块 —— 说明原因 + **真实可做的那件事**。 */
function unavailable(u) {
  if (!u) return "";
  return (
    `<div class="vb-unavail">` +
    `<b>这一批开始不了：${esc(u.reason)}</b>` +
    `<div class="meta">${esc(u.detail || "")}</div>` +
    (u.alternative
      ? `<div class="vb-alt">现在真实可做的是：${esc(u.alternative)}</div>`
      : "") +
    `</div>`
  );
}

export function renderVideoBatch(m) {
  if (!isObj(m)) return "";
  if (!m.exists) {
    return (
      `<div class="vb"><span class="meta">${esc(m.text)}</span>` +
      (m.done ? `<span class="chip">${esc(m.done)}</span>` : "") +
      `<button class="btn primary sm" data-vb-start>批量生视频</button>` +
      unavailable(m.quoteUnavailable) +
      `</div>`
    );
  }
  return (
    `<div class="vb vb-open" data-vb="1">` +
    `<div class="vb-h"><b>批量生视频</b>` +
    `<span class="meta">${m.total} 个镜头</span>` +
    (m.done ? `<span class="chip">${esc(m.done)}</span>` : "") +
    `<span class="push"></span>` +
    // 状态如实：被拒绝的不写成「进行中」
    `<span class="chip ${m.refused ? "bad" : m.state === "running" ? "gate" : ""}">` +
    `${esc(m.refused ? "已拒绝" : m.state === "running" ? "进行中" : m.state === "quoted" ? "待确认" : m.state)}` +
    `</span></div>` +
    (m.refused
      ? `<div class="vb-refused"><b>${esc(m.refused.reason)}</b>` +
        (m.refused.detail ? `<div class="meta">${esc(m.refused.detail)}</div>` : "") + `</div>`
      : "") +
    // 总额：**preflight 给的那一个数**，界面不乘
    (m.quote && m.quote.amount != null
      ? `<div class="vb-quote">合计 ${esc(String(m.quote.amount))} ${esc(m.quote.currency || "")}` +
        `（覆盖 ${esc(String(m.quote.count))} 条）—— 来自 Gateway 预检，界面不自算</div>`
      : unavailable(m.quoteUnavailable)) +
    `<div class="vb-line">${esc(m.line)}</div>` +
    `<div class="vb-acts">` +
    (m.state === "draft" ? `<button class="btn sm" data-vb-requote>重新取总额</button>` : "") +
    (m.state === "quoted"
      ? `<button class="btn primary sm" data-vb-confirm>确认并开始（第二步确认）</button>`
      : "") +
    (m.state === "running" ? `<button class="btn sm" data-vb-abort>中止</button>` : "") +
    (m.state !== "running" ? `<button class="btn sm" data-vb-discard>关掉这一批</button>` : "") +
    `</div></div>`
  );
}

export function bindVideoBatch(root, ctx, ui, rerender) {
  const start = root.querySelector("[data-vb-start]");
  if (start) start.onclick = () => { ctx.videoBatch.start(); rerender(); };
  const requote = root.querySelector("[data-vb-requote]");
  if (requote) requote.onclick = () => { ctx.videoBatch.requote(); rerender(); };
  const confirm = root.querySelector("[data-vb-confirm]");
  if (confirm) confirm.onclick = () => { ctx.videoBatch.confirm(); rerender(); };
  const abort = root.querySelector("[data-vb-abort]");
  if (abort) abort.onclick = () => { ctx.videoBatch.abort(); rerender(); };
  const discard = root.querySelector("[data-vb-discard]");
  if (discard) discard.onclick = () => { ctx.videoBatch.discard(); rerender(); };
}

/** 转交，供控制器使用 —— 控制器不直接 import batchpay（状态机知识只有一处）。 */
export const batchOps = { applyPreflight, confirmBatch, abortBatch, recordItem, settlement };
