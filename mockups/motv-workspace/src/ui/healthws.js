// ⚙ 项目健康 — 「这个项目整体在哪一步，有什么数据问题」 (TASK-082 §1.1).
//
// THE QUERIES WERE ALREADY RUNNING. `/api/projects/<p>/plan`, `/problems` and
// `/approvals` are served by the backend and were called by NOTHING: `getQuery`
// had exactly three callers (`status` / `cost` / `budget`). So a creator could
// see 「0/38」 on one page and 「38 镜」 on another and never learn that this
// project is at L0-S2, that the plan has 54 steps, or that one of its sources
// cannot be read at all.
//
// ONE NUMBER, TWO SIZES. The top bar's ⚠ and this panel's 数据源问题 are the same
// fact — `realmap.problemCount` is the only thing that counts it, so they cannot
// disagree (§1.1 与 TASK-077 §1.1 对齐, guard-tested).
//
// TWO DIFFERENT FACTS, NEVER MERGED:
//
//   数据源问题     the query ENVELOPE's problems — 「读这个项目时出了什么问题」
//   问题记录       WQ-09's problem ROWS — 「这个项目里发生过什么问题」
//
// Merging them would produce a third count that agrees with neither surface.
//
// HONESTY (§1.1 诚实纪律, inherited from TASK-077 §1.1): every field carries its
// provenance, and an `unavailable` one prints `—` plus the reason. It is never
// rendered as 0, and never as an empty string that reads like 「没有」.
import { esc } from "../util/dom.js";
import { UNKNOWN, problemCount, problemUnion } from "../services/realmap.js";

/**
 * @param src
 *   standing   `realmap.mapStanding` result — the SAME object the top bar's ⚠
 *              counts. Null before it has been read.
 *   status / plan / problems / approvals   the mapped query results, or null
 *   state      "idle" | "loading" | "ok" | "error"
 *   error      why, when state is "error"
 */
export function healthModel({
  standing = null, status = null, plan = null, problems = null, approvals = null,
  envelopes = [], state = "idle", error = null,
} = {}) {
  // EVERY envelope, not just the budget's. Each query reports the source failures
  // IT hit, and only one of them may have hit the one that matters — counting a
  // single envelope hid the rest (independent review, round 1). `problemUnion`
  // deduplicates, and the top bar's ⚠ calls the same function with the same
  // sources, so the two numbers are one number.
  const sources = [standing, ...(Array.isArray(envelopes) ? envelopes : [])];
  return {
    state,
    error: error || null,
    // 阶段推进 — from WQ-02's scope. `null` means 「没读到」, and the renderer
    // prints `—` for it; 0 would claim a measurement.
    stage: status
      ? {
        current: status.current ?? null,
        approved: typeof status.approved === "number" ? status.approved : null,
        total: typeof status.total === "number" ? status.total : null,
        progress: typeof status.progress === "number" ? status.progress : null,
      }
      : null,
    plan: plan || null,
    // THE SAME UNION THE ⚠ COUNTS — one function, called with the same sources
    sourceProblems: problemUnion(...sources),
    sourceProblemCount: problemCount(...sources),
    records: problems && Array.isArray(problems.rows) ? problems.rows : [],
    approvals: approvals || null,
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

/** A readout that says `—` when it does not know, never 0. */
function readout(label, value, note = "") {
  const known = value !== null && value !== undefined && value !== "";
  return (
    `<div class="hz-stat"><span class="k">${esc(label)}</span>` +
    `<span class="v${known ? "" : " unknown"}"${note && !known ? ` title="${esc(note)}"` : ""}>` +
    `${known ? esc(String(value)) : UNKNOWN}</span></div>`
  );
}

function stageBlock(m) {
  if (!m.stage) {
    return `<div class="dir-unavail">◌ 读不到阶段推进——上面写了原因。</div>`;
  }
  const s = m.stage;
  const pct = s.progress === null ? null : Math.round(s.progress * 100);
  return (
    `<div class="hz-stats">` +
    readout("当前阶段", s.current, "project_status 没有给出 current_stage") +
    readout("已批准", s.approved, "project_status 没有给出 approved") +
    readout("共", s.total, "project_status 没有给出 total") +
    readout("进度", pct === null ? null : `${pct}%`, "没有可算进度的数据") +
    `</div>`
  );
}

const RUN_LABEL = {
  approved: "已批准", pending: "待批准", blocked: "被阻塞",
  defined: "已定义", stale: "已过期",
};

function planBlock(m) {
  if (!m.plan) return `<div class="dir-unavail">◌ 读不到 L0–S7 计划。</div>`;
  const rows = m.plan.steps.map((st) => {
    const f = st.runStatus || {};
    const unavailable = f.provenance === "unavailable";
    // 「这个版本不跑这一步」 is a FACT about the plan, not a missing reading — it
    // prints as `—` with the reason on the row, never as 「未开始」
    const value = unavailable
      ? UNKNOWN
      : RUN_LABEL[f.value] || (f.value == null ? UNKNOWN : String(f.value));
    return (
      `<tr${st.stale ? ' class="bad"' : ""}>` +
      `<td class="hz-seq">${esc(String(st.sequence ?? ""))}</td>` +
      `<td class="hz-lv">${esc(String(st.level ?? ""))}</td>` +
      `<td class="hz-t">${esc(st.title || st.id || "")}` +
      (st.gate ? `<span class="chip gate">人工 Gate</span>` : "") +
      (st.stale ? `<span class="chip bad">已过期</span>` : "") +
      `</td>` +
      `<td class="hz-ex">${esc(st.execution || "")}</td>` +
      `<td class="hz-ow">${esc(st.responsibility || "")}</td>` +
      `<td class="hz-st${unavailable ? " unknown" : ""}"` +
      (unavailable && f.value ? ` title="${esc(String(f.value))}"` : "") +
      `>${esc(value)}</td></tr>`
    );
  }).join("");
  const unknown = m.plan.steps.filter((st) => (st.runStatus || {}).provenance === "unavailable").length;
  return (
    `<table class="hz-tbl"><thead><tr>` +
    `<th>#</th><th>层</th><th>步骤</th><th>执行</th><th>负责</th><th>运行状态</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="meta">共 ${m.plan.total} 步。其中 ${unknown} 步的运行状态是 ` +
    `<code>unavailable</code> —— 这个版本不执行它们（归属 ADR-0037…0039），` +
    `所以显示 ${UNKNOWN} 而不是「未开始」。</div>`
  );
}

function problemBlock(m) {
  const src = m.sourceProblems.length
    ? `<ul class="hz-probs">` +
      m.sourceProblems.map((p) =>
        `<li><span class="chip bad">${esc(p.category || "问题")}</span>` +
        `<span class="hz-pd">${esc(p.detail || "没有给出说明")}</span>` +
        (p.source ? `<span class="chip mute">${esc(p.source)}</span>` : "") +
        `</li>`).join("") +
      `</ul>`
    : `<div class="meta">读这个项目的来源时没有发现问题。</div>`;
  const rec = m.records.length
    ? `<ul class="hz-probs">` +
      m.records.map((r) =>
        `<li><span class="chip gate">${esc(r.kind)}</span>` +
        `<span class="hz-pd">${esc(r.detail || "（没有细节）")}</span>` +
        (r.entity ? `<span class="chip mute">${esc(r.entity)}</span>` : "") +
        (r.at ? `<span class="hz-at">${esc(String(r.at).slice(0, 16).replace("T", " "))}</span>` : "") +
        `</li>`).join("") +
      `</ul>`
    : `<div class="meta">没有问题记录。</div>`;
  return (
    `<div class="lab">数据源问题 · ${m.sourceProblemCount}</div>` +
    `<div class="meta">顶栏那个 ⚠ 数的就是这一份——四个查询各自报告的来源问题，` +
    `合并去重后的同一个集合，不是两份统计。</div>` +
    src +
    `<div class="lab">问题记录 · ${m.records.length}</div>` +
    `<div class="meta">这是另一件事：不是「读不出来」，是「跑出来的东西有问题」` +
    `（校验未通过、质检未通过、对账缺口）。</div>` +
    rec
  );
}

function approvalBlock(m) {
  if (!m.approvals) return `<div class="dir-unavail">◌ 读不到审批审计。</div>`;
  const { stages, audit } = m.approvals;
  const rows = stages.length
    ? `<table class="hz-tbl"><thead><tr><th>阶段</th><th>状态</th><th>批准人</th><th>时间</th><th>说明</th></tr></thead><tbody>` +
      stages.map((s) =>
        `<tr${s.stale ? ' class="bad"' : ""}>` +
        `<td>${esc(s.stage || "")}</td>` +
        `<td>${esc(RUN_LABEL[s.status] || s.status || "")}` +
        (s.stale ? `<span class="chip bad">已过期</span>` : "") + `</td>` +
        `<td>${s.by ? esc(s.by) : UNKNOWN}</td>` +
        `<td>${s.at ? esc(String(s.at).slice(0, 16).replace("T", " ")) : UNKNOWN}</td>` +
        `<td>${esc(s.reason || (s.blockedBy.length ? `被阻塞：${s.blockedBy.join("、")}` : ""))}</td>` +
        `</tr>`).join("") +
      `</tbody></table>`
    : `<div class="meta">这个项目还没有任何阶段进入审批。</div>`;
  return (
    rows +
    `<div class="meta">审计条目 ${audit.length} 条（只增不改）。` +
    `未批准的阶段没有批准人和时间，显示 ${UNKNOWN}——不是空白，是还没发生。</div>`
  );
}

export function renderHealth(m) {
  const head =
    `<div class="st-head"><div class="st-title">项目健康</div>` +
    `<div class="st-sub">这个项目整体在哪一步、L0–S7 计划、有什么数据问题、` +
    `谁批准过什么。全部来自只读查询合同（ADR-0031），这里不改任何东西。</div>` +
    `<div class="acts"><button class="btn sm" data-hz-reload="1">重新读取</button></div></div>`;
  if (m.state === "loading") {
    return head + `<div class="st-skel"><i></i><i></i><i></i><i></i></div>`;
  }
  if (m.state === "error") {
    return (
      head +
      `<div class="dir-unavail">◌ 读不到项目健康数据${m.error ? `：${esc(m.error)}` : ""}</div>` +
      `<div class="meta">这不是「这个项目没问题」，是没能把查询结果拿回来。` +
      `演示模式没有后端，所以这里如实显示不可用。</div>`
    );
  }
  if (m.state !== "ok") {
    return head + `<div class="meta">还没有读取——点「重新读取」。</div>`;
  }
  return (
    head +
    `<section class="hz-sec"><div class="lab">阶段推进</div>${stageBlock(m)}</section>` +
    `<section class="hz-sec"><div class="lab">问题</div>${problemBlock(m)}</section>` +
    `<section class="hz-sec"><div class="lab">L0–S7 计划</div>${planBlock(m)}</section>` +
    `<section class="hz-sec"><div class="lab">审批审计</div>${approvalBlock(m)}</section>`
  );
}

export function bindHealth(root, { onReload } = {}) {
  const b = root.querySelector("[data-hz-reload]");
  if (b && onReload) b.onclick = () => onReload();
}
