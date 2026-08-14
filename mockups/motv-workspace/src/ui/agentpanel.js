// The CONTEXTUAL AGENT PANEL (TASK-073 §1.4 / IA §6).
//
// TWO ENTRANCES, and only two (IA §6.1):
//
//   page level    「询问 Agent」      fixed at the top-right of every page
//   object level  「让 Agent 处理」    on a card / row
//
// It is a PANEL OPENED ON DEMAND, not a standing sidebar: closed, it occupies no
// layout. A permanent panel makes every page narrower for a feature used
// occasionally, and it invites the creator to read it instead of their work.
//
// SEVEN ITEMS, FIXED (IA §6.3). The list does not grow when capabilities do — that is
// the whole point of ADR-0066 决策 10 (「新增 Skill 不得新增页面」) applied to this
// panel: twenty capabilities behind one shape.
//
//   1 当前发现的问题        from REAL data, never the model's impression
//   2 Agent 对任务的理解    the task name + what it read
//   3 缺失输入              each one clickable, to the place that fixes it
//   4 推荐下一步            one to three
//   5 一个主要执行按钮      exactly one primary action
//   6 查看其他方案          folded, so it cannot compete with the primary
//   7 执行后的候选结果与版本差异
//
// WHAT IT NEVER SHOWS: Skill ID · Skill 版本 · Runtime · Executor · Provider ·
// Model · 内部任务 ID · context snapshot. Those live in 「生成记录」 beside the
// result (ui/genrecord.js). The creator sees a TASK NAME —— 「为这一镜写画面提示词」
// —— because that is what they are deciding about.
//
// UNAVAILABLE IS SAID OUT LOUD (IA §6.4 / ADR-0064 决策 6): no runtime, missing
// inputs, or an answer that broke its contract each produce a stated reason and NO
// primary button. A disabled-looking button with no explanation is how a lock reads
// as a bug.
import { esc } from "../util/dom.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim() : "");

/** The seven, in order. Exported so a guard test can assert the shape is fixed. */
export const PANEL_ITEMS = Object.freeze([
  "problems", "understanding", "missingInputs", "nextSteps",
  "primaryAction", "alternatives", "results",
]);

/** Field names that must NEVER reach this panel (IA §6.3). */
export const HIDDEN_FIELDS = Object.freeze([
  "skillId", "skillVersion", "runtime", "executor", "provider", "model",
  "runId", "skillRunId", "context", "contextTrace", "promptText",
]);

/**
 * The panel's view model.
 *
 * @param {object} src
 *   scope        `{ kind: "page" | "object", label }` — which entrance opened it
 *   taskName     the creator-facing name of the primary action
 *   understanding what the Agent read, as plain sentences
 *   problems     `[{ text, severity, targetLabel }]` — from real data
 *   missing      `[{ key, label, gotoModule }]` — clickable
 *   nextSteps    `[string]` — trimmed to three
 *   available    `{ ok, reason }` — may the primary action run at all
 *   alternatives `[{ taskName, why }]` — folded
 *   results      `[{ label, version, diff }]` — after a run
 *   manualFallback `{ can, hint }` — every AI action keeps a manual path
 */
export function agentPanelModel(src) {
  const s = isObj(src) ? src : {};
  const avail = isObj(s.available) ? s.available : { ok: false, reason: "还没有判断这个能力是否可用" };
  const missing = (Array.isArray(s.missing) ? s.missing : []).filter(isObj).map((m) => ({
    key: str(m.key),
    label: str(m.label) || str(m.key) || "（未命名输入）",
    // WHERE TO FIX IT. A missing-input list that cannot be acted on just tells the
    // creator they are stuck (IA §6.3 item 3: 「逐项可点，点到能修它的地方」).
    gotoModule: str(m.gotoModule) || null,
  }));
  // ONE primary action, and it is refused for a STATED reason rather than rendered
  // as a dead control. Missing inputs are their own reason — 「缺 3 项输入」 is more
  // useful than 「不可用」.
  const blocked = !avail.ok
    ? str(avail.reason) || "这个能力当前不可用"
    : missing.length
      ? `缺少必要输入：${missing.map((m) => m.label).join("、")}`
      : null;
  return {
    scope: {
      kind: s.scope && s.scope.kind === "object" ? "object" : "page",
      label: str(s.scope && s.scope.label) || null,
    },
    // 1
    problems: (Array.isArray(s.problems) ? s.problems : []).filter(isObj).map((p) => ({
      text: str(p.text),
      severity: ["blocking", "warning", "info"].includes(p.severity) ? p.severity : "info",
      targetLabel: str(p.targetLabel) || null,
    })).filter((p) => p.text),
    // 2 — the TASK NAME, never the skill id
    understanding: {
      taskName: str(s.taskName) || null,
      read: (Array.isArray(s.understanding) ? s.understanding : []).map(str).filter(Boolean),
    },
    // 3
    missing,
    // 4 — 「一到三条」, so a long list is trimmed rather than shown in full
    nextSteps: (Array.isArray(s.nextSteps) ? s.nextSteps : []).map(str).filter(Boolean).slice(0, 3),
    // 5
    primary: { taskName: str(s.taskName) || null, can: !blocked, blockedReason: blocked },
    // 6 — folded by construction
    alternatives: (Array.isArray(s.alternatives) ? s.alternatives : []).filter(isObj).map((a) => ({
      taskName: str(a.taskName) || "（未命名方案）",
      why: str(a.why) || null,
    })),
    // 7
    results: (Array.isArray(s.results) ? s.results : []).filter(isObj).map((r) => ({
      label: str(r.label) || "候选",
      version: Number.isInteger(r.version) ? r.version : null,
      diff: str(r.diff) || null,
    })),
    // every AI action keeps a manual path (IA §6 / ADR-0065 决策 2)
    manualFallback: isObj(s.manualFallback)
      ? { can: s.manualFallback.can !== false, hint: str(s.manualFallback.hint) || null }
      : { can: true, hint: null },
  };
}

const SEV_CLS = { blocking: "bad", warning: "gate", info: "mute" };

export function renderAgentPanel(m) {
  if (!m) return "";
  const sec = (title, body) => `<div class="ag-sec"><div class="ag-h">${esc(title)}</div>${body}</div>`;
  const none = (t) => `<div class="ag-none">${esc(t)}</div>`;

  const problems = m.problems.length
    ? `<ul class="ag-probs">` +
      m.problems
        .map(
          (p) =>
            `<li><span class="chip ${SEV_CLS[p.severity]}">${esc(p.severity === "blocking" ? "阻断" : p.severity === "warning" ? "注意" : "提示")}</span>` +
            `${esc(p.text)}${p.targetLabel ? `<span class="ag-tgt">${esc(p.targetLabel)}</span>` : ""}</li>`,
        )
        .join("") +
      `</ul>`
    : none("按当前数据没有发现问题。这一条来自真实数据的检查，不是模型的印象。");

  const understanding =
    (m.understanding.taskName
      ? `<div class="ag-task">${esc(m.understanding.taskName)}</div>`
      : none("还没有确定要做什么")) +
    (m.understanding.read.length
      ? `<ul class="ag-read">${m.understanding.read.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : none("它还没有读到任何上下文"));

  const missing = m.missing.length
    ? `<ul class="ag-miss">` +
      m.missing
        .map(
          (x) =>
            `<li>${x.gotoModule
              ? `<button class="ag-goto" data-goto="${esc(x.gotoModule)}">${esc(x.label)} →</button>`
              : `<span>${esc(x.label)}</span><span class="chip mute">没有可跳转的位置</span>`}</li>`,
        )
        .join("") +
      `</ul>`
    : none("必要输入都齐了");

  const steps = m.nextSteps.length
    ? `<ol class="ag-steps">${m.nextSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
    : none("暂时没有推荐的下一步");

  // ONE primary button, or a stated reason — never both, never neither
  const primary = m.primary.can
    ? `<button class="btn primary ag-run" data-agent-run="1">${esc(m.primary.taskName || "执行")}</button>`
    : `<div class="dir-unavail">◌ ${esc(m.primary.blockedReason)}</div>`;
  const fallback = m.manualFallback.can
    ? `<button class="btn sm ag-manual" data-agent-manual="1">复制任务，到别处跑</button>` +
      `<div class="meta">粘回来的答案走同一道输出契约与同一道确认门。</div>`
    : none("这个动作没有手工兜底");

  const alternatives = m.alternatives.length
    ? `<details class="ag-alt"><summary>查看其他方案（${m.alternatives.length}）</summary>` +
      `<ul>${m.alternatives.map((a) => `<li><b>${esc(a.taskName)}</b>${a.why ? `：${esc(a.why)}` : ""}</li>`).join("")}</ul>` +
      `</details>`
    : "";

  const results = m.results.length
    ? `<ul class="ag-res">` +
      m.results
        .map(
          (r) =>
            `<li>${esc(r.label)}` +
            (r.version === null ? `<span class="chip mute">版本未记录</span>` : `<span class="chip">v${r.version}</span>`) +
            (r.diff ? `<div class="ag-diff">${esc(r.diff)}</div>` : "") +
            `</li>`,
        )
        .join("") +
      `</ul>` +
      `<div class="meta">技术细节（Skill / Runtime / Executor / Provider / Model / 任务 ID）` +
      `在每个结果旁的「生成记录」里。</div>`
    : none("还没有执行过");

  return (
    `<aside class="ag-panel" data-agent-panel="${esc(m.scope.kind)}">` +
    `<div class="ag-top"><b>${esc(m.scope.kind === "object" ? "让 Agent 处理" : "询问 Agent")}</b>` +
    (m.scope.label ? `<span class="ag-scope">${esc(m.scope.label)}</span>` : "") +
    `<button class="ag-x" data-agent-close="1" title="关闭">✕</button></div>` +
    sec("当前发现的问题", problems) +
    sec("它对任务的理解", understanding) +
    sec("缺失输入", missing) +
    sec("推荐下一步", steps) +
    sec("执行", primary + fallback) +
    (alternatives ? sec("其他方案", alternatives) : "") +
    sec("结果与版本差异", results) +
    `</aside>`
  );
}

/** Wire the panel. Every handler is supplied — this module owns no behaviour. */
export function bindAgentPanel(root, { onRun, onManual, onClose, onGoto } = {}) {
  if (!root) return;
  const one = (sel, fn) => {
    const el = root.querySelector(sel);
    if (el && typeof fn === "function") el.onclick = () => fn();
  };
  one("[data-agent-run]", onRun);
  one("[data-agent-manual]", onManual);
  one("[data-agent-close]", onClose);
  if (typeof onGoto === "function") {
    root.querySelectorAll(".ag-panel [data-goto]").forEach((b) => (b.onclick = () => onGoto(b.dataset.goto)));
  }
}
