// 逐镜质检报告 (TASK-096 §2.4 / TASK-097 批次 5B)。
//
// **只读**。这一页上没有一个按钮会改数据：时长超差时该改分镜表还是重新生成，
// 只有创作者知道 —— 报告给的是一条**跳回那一镜**的路，不是一次代他做的修改。
//
// 三条判据都有「无法判定」这一档，而且它**不显示成通过也不显示成失败**。
// 尤其是一致性那一条：「没有发送记录」不是「没用上」（TASK-096 §2.4 点名的陷阱）。
//
// 与既有的 **交付质检** 是两份报告，各答一个问题，都放在 ⑩ 的「交付质检」一节：
//   逐镜质检 —— 这一集每一镜对不对
//   交付质检 —— 这条成片能不能导出
//
// PURE：模型由控制器给，渲染是纯字符串。

import { esc } from "../util/dom.js";
import { QC_ITEMS, interesting } from "../workflow/shotqc.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

const STATE_CLASS = { pass: "ok", fail: "bad", unknown: "" };
const STATE_LABEL = { pass: "通过", fail: "有发现", unknown: "无法判定" };

function cell(c, shotId) {
  if (!isObj(c)) return `<td class="sq-c">—</td>`;
  return (
    `<td class="sq-c sq-${esc(c.state)}">` +
    `<span class="chip ${STATE_CLASS[c.state] || ""}">${esc(STATE_LABEL[c.state] || c.state)}</span>` +
    (c.detail ? `<div class="meta">${esc(c.detail)}</div>` : "") +
    // 动作永远是「去那一镜」或「去测一次」—— 报告自己不改任何东西
    (c.action
      ? (c.key === "duration" && /测/.test(c.action)
        ? `<button class="sq-mini" data-sq-measure="${esc(shotId)}">${esc(c.action)}</button>`
        : `<button class="sq-mini" data-sq-go="${esc(shotId)}">${esc(c.action)}</button>`)
      : "") +
    `</td>`
  );
}

function summaryLine(s) {
  if (!isObj(s)) return "";
  return (
    `<div class="sq-row"><span class="sq-txt">${esc(s.text)}</span>` +
    (s.known
      ? `<span class="chip ${s.by.fail ? "bad" : (s.by.unknown ? "" : "ok")}">` +
        `${s.by.pass}/${s.total}</span>`
      : `<span class="chip">—</span>`) +
    `</div>`
  );
}

/**
 * 视图模型。
 *
 * 只列**有话说**的那些镜头（`interesting`）：60 行全绿的表没人会看，而真正要看的
 * 那三五行会被埋掉。全过的那些只留一句「另有 N 镜三条全过」。
 */
export const LIST_CAP = 20;

export function shotQcModel(ctx) {
  const rep = ctx.shotQc.report();
  const flagged = interesting(rep.rows);
  // 上限是**说出来的**，不是静默截断：真实项目上 60 镜全都有话说，
  // 一张 60 行 ×120 个按钮的表本身就是另一种噪音。汇总那三行说的是「多少镜」，
  // 表说的是「哪几镜」—— 所以先给前 20 条，并如实说还有多少没列。
  const listed = flagged.slice(0, LIST_CAP);
  // 按钮上的那个数必须是**真的会被测到**的数。写 `rep.rows.length` 时它承诺
  // 「60 镜」，而处理器只走 `measurableIds()` —— 真实项目上一条视频都没有，
  // 于是那个按钮承诺 60 镜、实际一镜也不测。这与 4F 那句「已排入草图生成」
  // 是同一类：屏幕说了一件不成立的事（codex 轮 3 的 non-blocking，真的）。
  const measurable = typeof ctx.shotQc.measurableIds === "function"
    ? ctx.shotQc.measurableIds().length
    : 0;
  return {
    ...rep,
    listed,
    measurable,
    overflow: flagged.length - listed.length,
    hidden: rep.rows.length - flagged.length,
    why: "这份报告只读：时长超差不会去改分镜表的数字，也不做画面内容的审美判断"
      + "（那需要视频理解，超出当前授权）。它给的是一条跳回那一镜的路。",
  };
}

export function renderShotQc(m) {
  if (!isObj(m)) return "";
  const head =
    `<div class="sq-h"><b>逐镜质检</b>` +
    `<span class="meta">${esc(m.line || "")}</span>` +
    `<span class="push"></span>` +
    (m.measurable
      ? `<button class="btn sm" data-sq-all>逐镜测时长（${m.measurable} 镜有视频，只读不花钱）</button>`
      : (m.rows && m.rows.length
        ? `<span class="meta">还没有视频可测 —— 时长要等视频生成出来才量得到</span>`
        : "")) +
    `</div>`;
  if (!m.rows || !m.rows.length) {
    return `<div class="sq">${head}<span class="meta">这一集还没有镜头可判</span></div>`;
  }
  const listed = m.listed || [];
  return (
    `<div class="sq" data-sq="1">` +
    head +
    QC_ITEMS.map((i) => summaryLine(m.summary[i.key])).join("") +
    // 只列**有话说**的那些镜头 —— 60 行全绿的表没人会看
    (listed.length
      ? `<table class="sq-t"><thead><tr><th>镜号</th>` +
        QC_ITEMS.map((i) => `<th>${esc(i.label)}</th>`).join("") +
        `</tr></thead><tbody>` +
        listed.map((r) =>
          `<tr><td class="sq-seq"><span class="mono">` +
          `${esc(String(r.seq == null ? "—" : r.seq).padStart(2, "0"))}</span>` +
          `<div class="sq-title">${esc(r.title)}</div></td>` +
          QC_ITEMS.map((i) => cell((r.checks || []).find((c) => c.key === i.key), r.shotId)).join("") +
          `</tr>`).join("") +
        `</tbody></table>`
      : `<div class="sq-clean">三条判据在每一镜上都过了</div>`) +
    (m.overflow
      ? `<div class="meta">另有 ${m.overflow} 镜同样有发现，未列出 —— 先处理上面这些</div>`
      : "") +
    (m.hidden ? `<div class="meta">另有 ${m.hidden} 镜三条全过，未列出</div>` : "") +
    `<div class="sq-why">${esc(m.why)}</div>` +
    `</div>`
  );
}

/**
 * `openShot(shotId)` 由 shell 注入。
 *
 * **不用 `data-goto` 那条通路**：那个属性由 shell 统一挂 `onclick`，在同一个按钮上
 * 再挂一个就是两个 handler 抢一个元素，后挂的静默胜出 —— `ui/shottable.js` 的注释里
 * 已经为这件事留过一条记录。一个注入的函数没有这个问题。
 */
export function bindShotQc(root, ctx, ui, rerender, { openShot } = {}) {
  root.querySelectorAll("[data-sq-measure]").forEach((el) => (el.onclick = async () => {
    await ctx.shotQc.measure(el.dataset.sqMeasure);
    rerender();
  }));
  root.querySelectorAll("[data-sq-go]").forEach((el) => (el.onclick = () => {
    if (typeof openShot === "function") openShot(el.dataset.sqGo);
  }));
  const all = root.querySelector("[data-sq-all]");
  if (all) {
    all.onclick = async () => {
      // 逐个来，不并发：这是一次一次的 ffprobe，同时开 60 个只会让机器忙死
      // 而每一条都变慢。读到哪一条就把哪一条刷出来。
      for (const id of ctx.shotQc.measurableIds()) {
        await ctx.shotQc.measure(id);
      }
      rerender();
    };
  }
}
