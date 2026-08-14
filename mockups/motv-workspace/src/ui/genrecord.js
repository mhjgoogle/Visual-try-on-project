// 「生成记录」 (TASK-073 §1.5 / IA §5.1 #12 · #31) — how ONE result came to be.
//
// It hangs beside EVERY result: a candidate card, a version row, a rough cut, an
// export record. That placement is the point: 「这个东西是怎么来的」 is asked while
// looking at the thing, not by navigating to a graph of the whole episode.
//
// IT IS ALSO WHERE THE TECHNICAL VOCABULARY LIVES. IA §6.3 removes Skill ID, Skill
// version, Runtime, Executor, Provider, Model, internal task id and the context
// snapshot from the main interface — 「删除」 there means 「moved here」, not erased.
// A creator who wants to know which executor answered can always find out; they just
// do not have to read it to use the product.
//
// UNRECORDED IS PRINTED, NOT HIDDEN. Every field that was never captured says
// 「未记录」. A blank row and a zero look identical, and only one of them is true —
// historical runs genuinely have no `provider` / `cost` / timing, and back-filling a
// plausible value would be fabrication (系统合同 §5.3 / TASK-074 §1.3 同规).
//
// PURE. A view model plus HTML; no clock, no fetch. `nowMs` is supplied when a
// still-running duration is wanted.
import { esc } from "../util/dom.js";
import { RUN_STATUS_LABEL } from "../workflow/skillrun.js";
import { formatDuration, formatCost, elapsedMs } from "./taskrow.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const NOT_RECORDED = "未记录";

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The record for one result.
 *
 * @param {object} src
 *   run          the Run this result came from (skill / generation / render), or null
 *   generation   a generation-registry record, or null
 *   confirmation `{ by, at }` — the creator's own decision about this result
 *   inputs       `[{ label, version }]` — WHAT it was made from, with versions
 *   params       `{ [k]: v }` — the parameters actually sent
 *
 * Both `run` and `generation` are optional: a manually uploaded asset has neither,
 * and the honest record for it says exactly that rather than showing an empty shell.
 */
export function genRecordModel(src, { nowMs = null } = {}) {
  const s = isObj(src) ? src : {};
  const run = isObj(s.run) ? s.run : null;
  const gen = isObj(s.generation) ? s.generation : null;
  const conf = isObj(s.confirmation) ? s.confirmation : null;
  const ms = run ? elapsedMs(run, nowMs) : null;
  const failure = run && isObj(run.failureReason) ? run.failureReason : null;
  const rows = [
    // WHAT it was — the creator-facing name, first
    ["任务", text(run && run.taskName) || text(gen && gen.type) || null],
    ["状态", run ? RUN_STATUS_LABEL[run.status] || run.status : text(gen && gen.status)],
    // …then the technical identity IA §6.3 moved out of the main interface
    ["Skill", text(run && run.skillId)],
    ["Skill 版本", Number.isInteger(run && run.skillVersion) ? `v${run.skillVersion}` : null],
    ["Runtime", text(run && run.runtime)],
    ["Executor", text(run && run.executor)],
    ["Provider", text((run && run.provider) || (gen && gen.provider))],
    ["Model", text(run && run.model)],
    ["内部任务 ID", text((run && run.runId) || (gen && gen.generationId))],
    // …then the accounting
    ["开始", text(run && run.startedAt)],
    ["结束", text(run && run.endedAt)],
    ["耗时", formatDuration(ms)],
    ["成本", formatCost(run && run.cost)],
    ["失败原因", failure ? text(failure.detail) || text(failure.category) : null],
  ];
  return {
    rows: rows.map(([label, value]) => ({ label, value, recorded: value !== null })),
    // INPUTS AND THEIR VERSIONS — 「用的是哪一版」 is the question a stale result
    // makes urgent, so the version travels with the label.
    inputs: (Array.isArray(s.inputs) ? s.inputs : [])
      .filter(isObj)
      .map((i) => ({
        label: text(i.label) || "（未命名输入）",
        version: Number.isInteger(i.version) ? i.version : null,
      })),
    params: isObj(s.params) ? { ...s.params } : null,
    // THE USER'S OWN DECISION. A result nobody confirmed says so — that is the
    // difference between 「生成成功」 and 「这一版就是定稿」 (ADR-0057).
    confirmation: conf
      ? { by: text(conf.by) || "user", at: text(conf.at) }
      : null,
    // a purely manual artifact has no run and no generation, and pretending
    // otherwise would invent provenance
    empty: !run && !gen,
  };
}

/** The collapsed record. `open` is caller-held view state, never persisted. */
export function renderGenRecord(m, { open = false } = {}) {
  if (!m) return "";
  if (m.empty) {
    return (
      `<details class="gr"${open ? " open" : ""}><summary>生成记录</summary>` +
      `<div class="gr-none">这份产物没有生成记录——它是直接导入 / 手工放进来的。` +
      `没有记录就是没有记录，这里不会编一个来源出来。</div></details>`
    );
  }
  const cell = (r) =>
    `<tr><td class="gr-k">${esc(r.label)}</td>` +
    `<td class="gr-v${r.recorded ? "" : " un"}">` +
    (r.recorded ? esc(String(r.value)) : NOT_RECORDED) +
    `</td></tr>`;
  const inputs = m.inputs.length
    ? `<div class="gr-sec">输入</div><ul class="gr-in">` +
      m.inputs
        .map(
          (i) =>
            `<li>${esc(i.label)}` +
            (i.version === null
              ? `<span class="chip mute">版本未记录</span>`
              : `<span class="chip">v${i.version}</span>`) +
            `</li>`,
        )
        .join("") +
      `</ul>`
    : `<div class="gr-sec">输入</div><div class="gr-none">未记录用了哪些输入</div>`;
  const params = m.params && Object.keys(m.params).length
    ? `<div class="gr-sec">参数</div><pre class="gr-pre">${esc(JSON.stringify(m.params, null, 2))}</pre>`
    : `<div class="gr-sec">参数</div><div class="gr-none">未记录参数</div>`;
  const confirmation = m.confirmation
    ? `<div class="gr-sec">确认记录</div><div class="gr-ok">由 ${esc(m.confirmation.by)} 确认` +
      (m.confirmation.at ? `，${esc(m.confirmation.at)}` : "") +
      `</div>`
    : `<div class="gr-sec">确认记录</div><div class="gr-none">还没有人确认这一版——` +
      `生成成功不等于定稿</div>`;
  return (
    `<details class="gr"${open ? " open" : ""}><summary>生成记录</summary>` +
    `<table class="gr-tbl">${m.rows.map(cell).join("")}</table>` +
    inputs + params + confirmation +
    `</details>`
  );
}

/** Convenience: build + render in one call, for the many result cards. */
export function genRecord(src, opts = {}) {
  return renderGenRecord(genRecordModel(src, opts), opts);
}
