// Task rows (TASK-073 §1.3) — what a running / finished piece of work looks like
// on ⑧ 镜头制作, and anywhere else a Run is shown to a creator.
//
// §1.3 fixes SIX things every row must carry:
//
//   状态 · 耗时 · 成本 · 失败原因 · 重试 · 真实取消
//
// The point of putting them in ONE read model is that they cannot drift apart per
// page: a row on 镜头制作 and the same run on 后期交付 say the same thing.
//
// HONESTY RULES, all of them learned the hard way elsewhere in this codebase:
//
//   - unknown stays unknown. No duration until the run actually started; no cost
//     guessed from the executor; no model invented. `null` renders as 「未记录」,
//     never as 0 or as a plausible default (ADR-0056 / 系统合同 §5.3).
//   - a subscription run costs 0 AND SAYS SO (`basis: "subscription"`). An absent
//     cost reads as 「不知道」, which is a different fact.
//   - 「真实取消」 means calling the backend (验收 #7). This module only decides
//     WHETHER a row may offer it; the button is wired to `ctx.skills.cancel`,
//     which refuses to record a cancellation the backend did not confirm.
//   - a retry is a NEW run, never a silent re-use of this one. A row may offer it
//     only from a terminal state, so a retry can never race the run it retries.
import { esc } from "../util/dom.js";
import { isOpen, RUN_STATUS_LABEL } from "../workflow/skillrun.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** States from which a retry is a new, unambiguous decision. */
const RETRYABLE = new Set(["failed", "cancelled"]);

/** Elapsed time, in the plainest possible form.
 *
 *  `null` when the run has not started, or when the clock cannot be read — an
 *  unparseable timestamp is not 0 seconds, and printing 「0.0s」 for it would
 *  invent a measurement. */
export function elapsedMs(run, nowMs = null) {
  if (!isObj(run)) return null;
  const start = Date.parse(run.startedAt || "");
  if (!Number.isFinite(start)) return null;
  const endRaw = run.endedAt ? Date.parse(run.endedAt) : null;
  const end = Number.isFinite(endRaw) ? endRaw : nowMs;
  if (!Number.isFinite(end)) return null; // still running and no clock supplied
  return Math.max(0, end - start);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

/** What this run cost, as text the creator can act on.
 *
 *  A subscription run is 「订阅内（不额外计费）」 rather than 「$0.00」: the number is
 *  the same and the meaning is not, and a creator deciding whether to retry needs
 *  the meaning. */
export function formatCost(cost) {
  if (!isObj(cost)) return null; // never recorded → 未记录, not 0
  const amount = typeof cost.amount === "number" && Number.isFinite(cost.amount) ? cost.amount : null;
  if (cost.basis === "subscription") return "订阅内（不额外计费）";
  if (amount === null) return null;
  const cur = typeof cost.currency === "string" && cost.currency ? cost.currency : "USD";
  return `${cur === "USD" ? "$" : `${cur} `}${amount.toFixed(2)}`;
}

/**
 * One row's view model. `nowMs` is passed in rather than read from a clock here so
 * the model stays pure and a test can assert a duration.
 */
export function taskRowModel(run, { nowMs = null, canCancel = null } = {}) {
  if (!isObj(run)) return null;
  const open = isOpen(run);
  const ms = elapsedMs(run, nowMs);
  const failure = isObj(run.failureReason) ? run.failureReason : null;
  // A backend-minted id is the knowable difference between a run with a real
  // process behind it and a front-end record (same rule as `ctx.skills.abandon`).
  const backendOwned = typeof run.runId === "string" && run.runId.startsWith("run-");
  return {
    runId: run.runId || run.runId || null,
    skillRunId: run.runId || null,
    taskName: run.taskName || null,
    status: run.status || null,
    statusLabel: RUN_STATUS_LABEL[run.status] || run.status || "未知",
    open,
    // 耗时 — null while it has not started, or when it cannot be measured
    durationMs: ms,
    duration: formatDuration(ms),
    running: run.status === "running" || run.status === "cancelling",
    // 成本 — 「订阅内」 and 「未记录」 are different answers and both are given
    cost: formatCost(run.cost),
    // 失败原因 — the backend's own words, never a generic 「失败」
    failure: failure ? failure.detail || failure.category || "没有给出原因" : null,
    failureCategory: failure ? failure.category || null : null,
    // 重试 — only from a terminal state, so it cannot race the run it retries
    canRetry: RETRYABLE.has(run.status),
    // 真实取消 — offered only while the run is open. `canCancel` lets a caller veto
    // (a page with no cancel wiring must not draw a button that does nothing).
    canCancel: open && canCancel !== false,
    // …and whether pressing it will reach a real process, which is what the row
    // must say: 「放弃」 and 「终止一个正在烧额度的进程」 are not the same promise.
    cancelReachesBackend: backendOwned,
    progress: Number.isFinite(run.progress) ? run.progress : null,
    executor: run.executor || null,
    model: run.model || null,
  };
}

/** One row. `data-task-*` hooks are what `bindTaskRows` wires. */
export function renderTaskRow(m) {
  if (!m) return "";
  const chip = (txt, cls = "") => `<span class="chip${cls ? ` ${cls}` : ""}">${esc(txt)}</span>`;
  const bad = m.status === "failed";
  return (
    `<div class="tk-row${m.open ? " open" : ""}${bad ? " bad" : ""}" data-task-run="${esc(m.runId || "")}">` +
    `<div class="tk-main">` +
    `<span class="tk-name">${esc(m.taskName || "任务")}</span>` +
    chip(m.statusLabel, bad ? "bad" : m.open ? "gen" : "ok") +
    // 耗时 / 成本 — 未记录 is printed, not hidden: a blank cell is indistinguishable
    // from a zero, and only one of those is true
    chip(m.duration ? `耗时 ${m.duration}` : "耗时未记录", "mute") +
    chip(m.cost ? `成本 ${m.cost}` : "成本未记录", "mute") +
    `</div>` +
    (m.progress !== null && m.running
      ? `<div class="tk-bar"><i style="width:${Math.max(0, Math.min(100, m.progress))}%"></i></div>`
      : "") +
    (m.failure ? `<div class="tk-fail">失败原因：${esc(m.failure)}</div>` : "") +
    `<div class="tk-acts">` +
    (m.canCancel
      ? `<button class="btn sm" data-task-cancel="${esc(m.runId || "")}" ` +
        `title="${m.cancelReachesBackend
          ? "调用后端终止这次运行的进程树；未确认终止时不会标成已取消"
          : "这次运行由本页持有（手工运行），取消即记为已取消"}">` +
        `${m.cancelReachesBackend ? "取消运行" : "放弃"}</button>`
      : "") +
    (m.canRetry
      ? `<button class="btn sm" data-task-retry="${esc(m.runId || "")}" ` +
        `title="重试是一次新的运行，旧记录保留">重试</button>`
      : "") +
    `</div></div>`
  );
}

export function renderTaskRows(models, { emptyText = "还没有任务记录" } = {}) {
  const rows = (models || []).filter(Boolean);
  if (!rows.length) return `<div class="tk-empty">${esc(emptyText)}</div>`;
  return `<div class="tk-list">${rows.map(renderTaskRow).join("")}</div>`;
}

/**
 * Wire the rows. `onCancel` / `onRetry` receive the runId.
 *
 * REAL CANCEL (验收 #7): the caller passes `ctx.skills.cancel`, which calls the
 * backend. A handler that only cleared front-end state would leave a real
 * executor running while the row said 「已取消」 — so this module deliberately has
 * no fallback of its own to fall back to.
 */
export function bindTaskRows(root, { onCancel, onRetry } = {}) {
  if (!root) return;
  root.querySelectorAll("[data-task-cancel]").forEach((b) => (b.onclick = async () => {
    if (typeof onCancel !== "function") return;
    b.disabled = true; // a second press would race the first
    b.textContent = "取消中…";
    await onCancel(b.dataset.taskCancel);
  }));
  root.querySelectorAll("[data-task-retry]").forEach((b) => (b.onclick = () => {
    if (typeof onRetry === "function") onRetry(b.dataset.taskRetry);
  }));
}
