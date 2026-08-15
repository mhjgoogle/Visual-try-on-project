// ⑩ 后期交付 · 交付质检 (TASK-074 §1.2 / 系统合同 §6.5 / IA §4 ⑩).
//
// The layer-3 checks (`QC_CHECKS` — eight rows: 削波 is a second finding of 音量),
// shown as a table the creator can act on, plus the G4 verdict on the export. The
// count is read from that table, never written out as a literal: a hard-coded 「七项」
// contradicted the header two lines below it (independent review).
//
// THE HONESTY RULE IS THE POINT OF THIS SCREEN (§1.2 / ADR-0064 决策 6). A browser
// cannot run ffmpeg, so today the probe-based checks — 音画同步 · 音量 · 削波 · 黑帧
// · 缺帧 — genuinely cannot be measured here. They therefore render as
// **未检查**, WITH the reason, and `passed` stays false. They must never render as a
// tick: an export waved through because the tool was missing is how a broken file
// ships, and a screen that shows eight green rows when it measured two of them is a
// worse lie than a screen that shows nothing.
//
// Two checks ARE real right now, from data the page already holds:
//
//   字幕     the cue track (existence, empty cues, inverted or out-of-film timing)
//   素材权限  every Asset used carries a source marking
//
// PURE PRESENTATION over a view-model. It computes nothing; `runDeliveryQc` does.
import { esc } from "../util/dom.js";
import { QC_CHECKS } from "../workflow/deliveryqc.js";

/** The three states, as the creator reads them. `unavailable` is deliberately NOT
 *  「通过」-coloured and deliberately not an error either: it is an open question. */
const STATE = Object.freeze({
  pass: { icon: "✅", label: "通过", cls: "qc-pass" },
  fail: { icon: "❌", label: "不合格", cls: "qc-fail" },
  unavailable: { icon: "❔", label: "未检查", cls: "qc-unknown" },
});

const SEVERITY_LABEL = Object.freeze({ blocking: "阻断", warning: "警告" });

/** One row of the table. */
function qcRow(r) {
  const st = STATE[r.state] || STATE.unavailable;
  const sev = r.state === "fail" && r.severity
    ? `<span class="qc-sev qc-sev-${esc(r.severity)}">${esc(SEVERITY_LABEL[r.severity] || r.severity)}</span>`
    : "";
  return (
    `<tr class="${st.cls}">` +
    `<td class="qc-k">${esc(r.label || r.key)}</td>` +
    `<td class="qc-s">${st.icon} ${esc(st.label)}${sev}</td>` +
    `<td class="qc-d">${esc(r.detail || "")}</td>` +
    `</tr>`
  );
}

/**
 * The G4 verdict line.
 *
 * `g4` is `{ok, reason?, blockingIssueIds?}` straight from the gate — the panel does
 * not re-derive it, because two places deciding whether an export may proceed is one
 * place too many (系统合同 §6.3).
 */
function g4Line(g4, report) {
  if (g4 && g4.ok) {
    // THE GREEN LINE FOLLOWS `report.passed`, NOT `g4.ok`. G4 only clears BLOCKING
    // issues, so a warning-severity failure — an off-target loudness, say — leaves
    // `g4.ok` true while `passed` is false. Reading the gate as a verdict painted
    // 「全部合格」 on a screen whose own header said 尚未全部合格 and whose 音量 row
    // showed ❌ (independent review). The gate answers 「能不能导出」; only the report
    // answers 「合格没有」, and this screen exists to keep those two apart.
    if (report && report.passed) {
      return `<div class="qc-gate qc-gate-ok">` +
        `G4 通过：${QC_CHECKS.length} 项全部检查完毕且合格。</div>`;
    }
    const unknown = report && report.unavailableRows ? report.unavailableRows.length : 0;
    const failed = report && report.rows ? report.rows.filter((r) => r.state === "fail").length : 0;
    const parts = [];
    if (failed) parts.push(`<b>${failed}</b> 项不合格（均为警告级，不阻断导出）`);
    if (unknown) parts.push(`<b>${unknown}</b> 项没检查过`);
    return `<div class="qc-gate qc-gate-warn">G4 不阻断导出：没有未处理的阻断级问题。` +
      `但${parts.join("、") || "报告尚未全部合格"}——「没跑」和「警告」都不等于「通过」，` +
      `是否导出由你决定。</div>`;
  }
  const why = (g4 && g4.reason) || "还没有质检报告——没跑不等于通过";
  const ids = g4 && Array.isArray(g4.blockingIssueIds) && g4.blockingIssueIds.length
    ? `<div class="qc-gate-ids">问题：${g4.blockingIssueIds.map((i) => esc(i)).join("、")}</div>`
    : "";
  return `<div class="qc-gate qc-gate-block">G4 拒绝导出：${esc(why)}${ids}</div>`;
}

/**
 * The explanation under the table, built from what the rows ACTUALLY say.
 *
 * A fixed sentence went stale the moment the state changed: it told the creator
 * 「「规格」缺的是设置本身，去 ⚙ 填」 even after ⚙ was filled and the row had become
 * 「读不出成片的分辨率」 — sending them to the wrong place (independent review). Each
 * sentence here is conditional on the row it explains.
 */
function qcNote(report) {
  const rows = (report && report.rows) || [];
  const unavailableDetail = (k) => {
    const r = rows.find((x) => x.key === k);
    return r && r.state === "unavailable" ? r.detail || "" : "";
  };
  const parts = [];
  const PROBED = ["av_sync", "loudness", "clipping", "black_frame", "dropped_frame"];
  if (rows.some((r) => PROBED.includes(r.key) && r.state === "unavailable")) {
    parts.push(
      "音画同步 · 音量 · 削波 · 黑帧 · 缺帧需要对成片文件做 ffprobe/ffmpeg 探测，" +
      "浏览器里跑不了，所以它们如实显示「未检查」——没跑不等于通过。",
    );
  }
  const spec = unavailableDetail("spec");
  if (spec.includes("没有设置")) {
    parts.push("「规格」缺的是设置本身，去 ⚙ 项目设置 · 成片规格 填完就能判。");
  } else if (spec) {
    parts.push("「规格」要等成片渲染出来、能被探测之后才判得了。");
  }
  if (rows.some((r) => r.key === "rights" && r.state !== "unavailable")) {
    parts.push("「素材权限」只看这条片子用到的素材，不看整个项目的资产库。");
  }
  if (rows.some((r) => r.key === "subtitle" && r.state !== "unavailable")) {
    parts.push("字幕越界按当前剪辑的时长判，不是按成片文件——成片还没渲染出来。");
  }
  return parts.join("");
}

/**
 * Render the 交付质检 section.
 *
 * `vm` is `{ report, g4, ran, note }`:
 *   - `report` the QCReport from `runDeliveryQc`, or null when it has not been run
 *   - `g4`     the gate's verdict on that report
 *   - `note`   an OVERRIDE for the derived explanation; omit it and the panel builds
 *              one from the rows, which is what keeps it from going stale
 */
export function renderQcPanel(vm) {
  const report = vm && vm.report;
  if (!report) {
    return (
      `<div class="qc-wrap">` +
      `<div class="qc-empty">还没有跑过交付质检。</div>` +
      g4Line(vm && vm.g4, null) +
      `</div>`
    );
  }
  const declared = QC_CHECKS.length;
  const measured = report.rows.filter((r) => r.state !== "unavailable").length;
  return (
    `<div class="qc-wrap">` +
    `<div class="qc-head">` +
    `<span class="qc-count">已检查 <b>${measured}</b> / ${declared} 项</span>` +
    (report.passed
      ? `<span class="qc-ok">全部合格</span>`
      : `<span class="qc-notyet">尚未全部合格</span>`) +
    `</div>` +
    `<table class="qc-table"><thead><tr>` +
    `<th>检查项</th><th>结果</th><th>说明</th>` +
    `</tr></thead><tbody>${report.rows.map(qcRow).join("")}</tbody></table>` +
    ((vm && vm.note) || qcNote(report)
      ? `<div class="qc-note">${esc((vm && vm.note) || qcNote(report))}</div>`
      : "") +
    g4Line(vm && vm.g4, report) +
    `</div>`
  );
}
