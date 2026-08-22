// 全局付费任务队列条（TASK-048 第2步）— 严格只读投影。
//
// 数据源是既有的 GET /api/paid-ops/<project>（reservation 记录 + staging 产物
// 存在性），状态枚举忠实投影 coordinator/reservation 现有状态机
// （held / committed / released / needs_reconciliation），不发明任何 UI 状态
// （无 pause/cancel/skip）。批量付费进行中时同步显示 node._batchMsg 的 N/M 进度。
//
// 轮询策略（app.js 调用 shouldPoll 决定停/走）：存在 in-flight 任务
// （held 的 reservation，或批量循环 busy）时才继续定时刷新；否则停表不空转。
import { esc } from "../util/dom.js";

// status → [图标, 中文标签, css 类]。未知状态原样透出（faithful projection）。
const STATUS_VIEW = {
  held: ["⏳", "生成中", "q-held"],
  committed: ["✓", "已入账", "q-ok"],
  released: ["✕", "已释放", "q-rel"],
  needs_reconciliation: ["⚠", "需对账", "q-warn"],
};

/** 按状态聚合计数（未知状态归入 other，原样显示）。纯函数，便于单测。 */
export function aggregateOps(ops) {
  const counts = { held: 0, committed: 0, released: 0, needs_reconciliation: 0, other: 0 };
  for (const o of ops || []) {
    if (Object.prototype.hasOwnProperty.call(counts, o.status)) counts[o.status] += 1;
    else counts.other += 1;
  }
  return counts;
}

/** 是否存在在途任务（reservation held）。批量 busy 由调用方另行 OR 进去。 */
export function hasInflight(ops) {
  return (ops || []).some((o) => o.status === "held");
}

function statusView(status) {
  return STATUS_VIEW[status] || ["·", String(status || "未知"), "q-warn"];
}

/** 渲染队列条到容器 el。
 *  model: { ops: [...], batchMsg: string|null }
 *  onJump(op): 点击条目跳转对应节点 detail（由 app.js 提供）。
 *  无任何在途/历史付费任务且无批量进行时整条隐藏。 */
export function renderQueueBar(el, model, { onJump } = {}) {
  if (!el) return;
  const ops = model.ops || [];
  const batchMsg = model.batchMsg || "";
  if (!ops.length && !batchMsg) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const c = aggregateOps(ops);
  const seg = (n, icon, label, cls) =>
    n ? `<span class="qseg ${cls}">${icon} ${label} <b>${n}</b></span>` : "";
  const counts =
    seg(c.held, "⏳", "生成中", "q-held") +
    seg(c.committed, "✓", "已入账", "q-ok") +
    seg(c.released, "✕", "已释放", "q-rel") +
    seg(c.needs_reconciliation, "⚠", "需对账", "q-warn") +
    seg(c.other, "·", "其他", "q-warn");
  const batch = batchMsg
    ? `<span class="qseg q-held qbatch">${esc(batchMsg)}</span>`
    : "";
  const items = ops
    .map((o, i) => {
      const [icon, label, cls] = statusView(o.status);
      const tip = `${o.task_id || ""} · ${o.model_id || ""} · ${o.quote || ""}${o.artifact_bytes ? " · 已取回成片" : ""}`;
      return `<button class="qitem ${cls}" data-qop="${i}" title="${esc(tip)}">${icon} ${esc(o.shot_id || o.task_id || "?")} <i>${esc(label)}</i></button>`;
    })
    .join("");
  el.innerHTML = `<span class="qhead">💳 付费队列</span>${batch}${counts}<span class="qsep"></span>${items}`;
  el.hidden = false;
  if (onJump) {
    el.querySelectorAll("[data-qop]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      onJump(ops[Number(b.dataset.qop)]);
    }));
  }
}
