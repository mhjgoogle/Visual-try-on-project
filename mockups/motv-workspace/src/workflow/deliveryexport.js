// 「这一版候选现在能不能导出」—— 导出闸门的判定本身（TASK-074 §1.7 · 系统合同 §6.5）。
//
// WHY IT IS ITS OWN MODULE. 这段判定原来长在 `app.js` 的 `ctx.delivery` 闭包里，于是
// 它只能靠 `g4Export` 与 `addFinal` 各自的单元测试**间接**证明 —— 而 codex 轮 1 说对了：
// 四种拒绝里有三种（找不到 / 已是成片 / 这一版没测过）根本不在 `g4Export` 里，
// 拼在一起的顺序也没被任何测试跑过。闸门是最不该只靠「看起来对」的那种代码。
//
// PURE. 三样输入全部由调用方给：候选行、探测状态、质检报告。没有 fetch、没有 DOM、
// 没有模块级状态 —— 于是「拿另一版的测量放行」这种错在这里能被写成一条测试。
//
// 顺序即优先级，每一条拒绝都带**创作者能去做的事**：
//   1. 找不到这一版            → 刷新 / 重渲染
//   2. 它已经是成片了          → 要出新版本先渲染一版新的候选
//   3. 这一版还没被测量过      → 先对**它**跑一次交付质检（拿别的版本的数字放行，
//                                等于为一个从没被检查过的文件签字）
//   4. G4：有 open 的阻断问题  → 列出是哪几条
//   5. 放行

import { g4Export } from "./gates.js";

// ---- 导出票：签发与验收都在这个模块里，签发**不导出**（codex 轮 2/3/4）-------------
//
// 「`kind: "final"` 只有一个写入者」要成为结构而不是约定，就不能有任何一条公开路径
// 能拿到签票函数。轮 2 报 `addFinal` 裸导出、轮 3 报 `mintExportTicket` 导出、轮 4 报
// `bindMinter` 先来先得 —— 三次是同一件事：只要签票函数**在任何模块的导出面上**，就有
// 人能绕过 G4。所以它现在是本文件的一个私有函数，唯一的调用点是 `exportability` 放行
// 那一行；`assetlib.addFinal` 只拿到验收函数。票按身份验（伪造过不了）、用一次作废、
// 只对这一版有效。`assetlib` import 本模块，本模块不 import `assetlib` —— 无环。

const ISSUED = new WeakSet();
const SPENT = new WeakSet();

function mintExportTicket(cutAssetId) {
  const t = Object.freeze({ cutAssetId: String(cutAssetId) });
  ISSUED.add(t);
  return t;
}

/**
 * 验收并作废。返回 `null` 表示可以写；否则是**拒绝理由**（fail-closed 并说明）。
 * 三种拒绝：不是这里签的（伪造 / 手写）· 已经用过 · 票不是给这一版的。
 */
export function spendExportTicket(ticket, cutAssetId) {
  if (!ticket || typeof ticket !== "object" || !ISSUED.has(ticket)) {
    return "登记成片需要一张导出票 —— 它只由交付质检的放行签发（门槛 G4）";
  }
  if (SPENT.has(ticket)) return "这张导出票已经用过 —— 每次导出都是一条新记录（门槛 G5）";
  if (ticket.cutAssetId !== String(cutAssetId)) {
    return "这张导出票不是给这一版候选的";
  }
  SPENT.add(ticket);
  return null;
}

/**
 * @param {object} p
 * @param {object|null} p.cut     `_cuts()` 里的那一行：`{ assetId, url, kind, exportable, name }`
 * @param {object|null} p.probe   探测状态：`{ assetId, measured }`（`measured` = 真的拿到了数字）
 * @param {object|null} p.report  `runDeliveryQc` 的报告；没跑过就是 null
 * @returns {{ ok: boolean, reason?: string, blockingIssueIds?: string[], step: string }}
 *          `step` 说的是**卡在哪一步** —— 面板据它决定按钮旁边那句话该指向哪里。
 */
export function exportability({ cut, probe, report }) {
  if (!cut) {
    return { ok: false, step: "missing", reason: "找不到这一版候选成片" };
  }
  if (cut.kind !== "cut" || cut.exportable === false) {
    return {
      ok: false,
      step: "already-final",
      reason: "这一版已经是成片了 —— 要出新版本请先渲染一版新的候选",
    };
  }
  const measuredThis = !!(probe && probe.measured && probe.assetId === cut.assetId);
  if (!measuredThis) {
    return {
      ok: false,
      step: "unmeasured",
      reason: "这一版候选还没被测量过 —— 先对它跑一次交付质检（没测过不等于通过，门槛 G4）",
    };
  }
  // THE REPORT MUST BE ABOUT THIS VERSION TOO (codex 轮 3 P1). Measurement binding
  // alone let 「A 刚测过 + 一份给 B 出的干净报告」 export A. The report says which file
  // its rows describe; it has to be the same one.
  const reportFor = report && typeof report === "object" ? report.probeAssetId : null;
  if (reportFor !== cut.assetId) {
    return {
      ok: false,
      step: "report-mismatch",
      reason: "这份质检报告不是对这一版候选出的 —— 先对它跑一次交付质检（门槛 G4）",
    };
  }
  const gate = g4Export(report);
  if (!gate.ok) return { ...gate, step: "g4" };
  // 放行的那一刻签票。票是 `addFinal` 唯一认的东西 —— 这就是「唯一写入者」的结构形式。
  return { ok: true, step: "ready", ticket: mintExportTicket(cut.assetId) };
}
