// 对话流 —— 他说的、Agent 回的、这一轮正在做什么。
//
// SHAPE (REQ-004 v2): 上面是流，底部是输入框。像他每天用的那个对话框，而不是一叠面板。
//
// WHAT EACH TURN MUST SAY, and why:
//   * 他说的话         —— 一个答案在没有问题的情况下出现，读者无法判断它在回答什么
//   * Agent 回的话     —— 正文
//   * 这一轮的状态      —— 排队 / 正在想 / 失败，来自 RUN 状态（ADR-0089 决策 5），
//                        不是 Agent 自称的进度：自称的进度在进程死掉时会永远停在
//                        「进行中」
//   * 它想改什么        —— edits 是**待应用的意图**，由创作者自己那条编辑路径落地
//                        （决策 2b）。屏幕上必须区分「它说要改」和「已经改了」
//   * 它做不到什么      —— unsupported 保留而不是丢掉：一个被静默丢弃的意图，
//                        看起来就是「它答应了然后什么都没干」
import { esc } from "../util/dom.js";

const STATUS_ZH = {
  queued: "排队中",
  running: "正在想…",
  succeeded: "",
  failed: "失败",
  cancelled: "已取消",
  cancelling: "正在取消",
  awaiting_input: "等待输入",
  unknown: "状态未知",
};

const EDIT_ZH = {
  "brief.idea": "改核心创意",
  "story.outline": "追加一版故事大纲",
};

/** Pure view model: what the column shows, from the thread the server gave. */
export function threadModel(turns, { pendingRun = null, pendingStatus = "" } = {}) {
  const rows = (Array.isArray(turns) ? turns : []).map((t) => ({
    turnId: String(t.turnId || ""),
    role: t.role === "agent" ? "agent" : "user",
    text: String(t.text || ""),
    runId: t.runId || null,
    status: String(t.status || ""),
    failure: t.failure ? String(t.failure) : "",
    failureCategory: t.failureCategory ? String(t.failureCategory) : "",
    edits: Array.isArray(t.edits) ? t.edits : [],
    unsupported: Array.isArray(t.unsupported) ? t.unsupported : [],
  }));
  // The turn in flight has no agent row yet; it is shown as one so the column
  // never looks like the message vanished.
  const answered = new Set(rows.filter((r) => r.role === "agent").map((r) => r.runId));
  const waiting = pendingRun && !answered.has(pendingRun)
    ? { runId: pendingRun, status: pendingStatus || "queued" }
    : null;
  return { rows, waiting, empty: rows.length === 0 && !waiting };
}

function editList(items, { supported }) {
  if (!items.length) return "";
  const label = supported ? "它建议的改动（还没落到作品上）" : "它想做但本应用还做不到";
  const rows = items
    .map((e) => {
      const kind = supported
        ? EDIT_ZH[e.kind] || e.kind || "改动"
        : e.kind || "未知动作";
      return (
        `<li class="cv-edit${supported ? "" : " unsup"}">` +
        `<span class="k">${esc(String(kind))}</span>` +
        `<span class="t">${esc(String(e.text || ""))}</span></li>`
      );
    })
    .join("");
  return `<div class="cv-editswrap"><div class="lab">${esc(label)}</div><ul class="cv-edits">${rows}</ul></div>`;
}

export function renderThread(m) {
  if (m.empty) {
    return (
      `<div class="cv-empty">还没有对话。<br>在下面说一句话 —— 我会先把这个项目的` +
      `现状读一遍，再回答你。</div>`
    );
  }
  const rows = m.rows
    .map((r) => {
      if (r.role === "user") {
        return `<div class="cv-turn user"><div class="cv-tx">${esc(r.text)}</div></div>`;
      }
      const status = r.status && r.status !== "succeeded"
        ? `<span class="chip${r.status === "failed" ? " bad" : " mute"}">${esc(STATUS_ZH[r.status] || r.status)}</span>`
        : "";
      const failure = r.failure
        ? `<div class="cv-fail">没能完成：${esc(r.failure)}` +
          (r.failureCategory ? `<span class="chip bad">${esc(r.failureCategory)}</span>` : "") +
          `</div>`
        : "";
      // No avatar (产品负责人 2026-08-27:「机器人的图不需要」). The turn is already
      // distinguishable by its own block; a status chip appears only when there IS
      // a status worth saying, so a normal answer carries no chrome at all.
      return (
        `<div class="cv-turn agent">` +
        (status ? `<div class="cv-h">${status}</div>` : "") +
        (r.text ? `<div class="cv-tx">${esc(r.text)}</div>` : "") +
        failure +
        editList(r.edits, { supported: true }) +
        editList(r.unsupported, { supported: false }) +
        `</div>`
      );
    })
    .join("");
  const waiting = m.waiting
    ? `<div class="cv-turn agent waiting"><div class="cv-h">` +
      `<span class="chip mute">${esc(STATUS_ZH[m.waiting.status] || m.waiting.status)}</span>` +
      `<button class="as-cx" data-cv-cancel="${esc(m.waiting.runId)}" title="取消这一轮">✕</button>` +
      `</div><div class="cv-skel"><i></i><i></i><i></i></div></div>`
    : "";
  return `<div class="cv-thread">${rows}${waiting}</div>`;
}
