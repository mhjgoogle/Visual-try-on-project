// 「开发」窗口里看得见的提案卡片。
//
// 产品负责人 2026-08-30：「开发给的方案在哪里。我根本没看到」「我明明说那么清楚了
// 为什么前端agent一直问我重复的问题」。
//
// 两个缺陷，一个形状：**方案只活在模型的转述里**。它不在屏幕上，所以他看不到正文；
// 他的答复要靠模型解析成 `proposal.decide`，模型没给就等于没答，于是同一个问题被问第二遍。
//
// 所以这里把提案画成卡片，拍板做成**按钮**：点一下走服务端那条确定性的端点，
// 不经过模型。已答复的折叠起来并带着他的原话 —— 那句话就是已经定下来的事。

import { esc } from "../util/dom.js";

const VERDICT_ZH = { approved: "同意", rejected: "不要", changes: "要改" };

/** 纯视图模型：待答复的在前，已答复的折叠在后。 */
export function proposalsModel(proposals) {
  const rows = (Array.isArray(proposals) ? proposals : []).filter(
    (x) => x && typeof x === "object",
  );
  const open = rows.filter((x) => !x.decision);
  const done = rows.filter((x) => x.decision);
  return { open, done, total: rows.length };
}

function card(x) {
  const pending = !!x.pending;
  const body = String(x.body || "").trim();
  return (
    `<li class="pp-card${pending ? " pending" : ""}" data-pp-id="${esc(String(x.id))}">` +
    `<div class="pp-h"><span class="pp-n">#${esc(String(x.id))}</span>` +
    `<span class="pp-t">${esc(String(x.title || ""))}</span></div>` +
    // 正文按原样换行显示：方案写的是「现在／改完／不变／要你定」四行，压成一行就白写了
    (body ? `<pre class="pp-b">${esc(body)}</pre>` : "") +
    (pending
      ? `<div class="pp-acts"><span class="meta">开发正在写方案…</span></div>`
      : `<div class="pp-acts">` +
        `<button class="btn primary sm" data-pp-ok="${esc(String(x.id))}">同意</button>` +
        `<button class="btn sm" data-pp-no="${esc(String(x.id))}">不要</button>` +
        `<button class="btn sm" data-pp-ch="${esc(String(x.id))}">可以，但要改…</button>` +
        `</div>`) +
    `</li>`
  );
}

function doneRow(x) {
  const d = x.decision || {};
  const zh = VERDICT_ZH[d.verdict] || d.verdict || "";
  return (
    `<li class="pp-done"><span class="pp-n">#${esc(String(x.id))}</span>` +
    `<span class="pp-t">${esc(String(x.title || ""))}</span>` +
    `<span class="chip ${d.verdict === "rejected" ? "bad" : "ok"}">${esc(zh)}</span>` +
    (d.note ? `<span class="pp-note">你说：${esc(String(d.note))}</span>` : "") +
    `</li>`
  );
}

export function renderProposals(m) {
  if (!m.total) return "";
  const open = m.open.length
    ? `<div class="lab">开发给你的方案（${m.open.length} 条等你拍板）</div>` +
      `<ul class="pp-list">${m.open.map(card).join("")}</ul>`
    : `<div class="lab">开发的方案都答复过了</div>`;
  const done = m.done.length
    ? `<details class="pp-donebox"><summary>已答复（${m.done.length}）</summary>` +
      `<ul class="pp-donelist">${m.done.map(doneRow).join("")}</ul></details>`
    : "";
  return `<div class="pp-wrap">${open}${done}</div>`;
}

/** 「我提过的意见」—— 他要能查自己说过什么、到哪一步了（意见 #3）。 */
export function renderOpinions(opinions) {
  const rows = (Array.isArray(opinions) ? opinions : []).filter(Boolean);
  if (!rows.length) return "";
  const item = (x) => (
    `<li class="pp-op"><span class="chip ${x.status === "done" ? "ok" : "mute"}">` +
    // 「已处理」只代表**台账上标了**，不代表源码已经改了（TASK-132 切片 B）。
    // 这里刻意不引入第二套状态：真正的「已修改」要关联实现与验证证据，
    // 而那是提案回路的事，不是这一行 chip 能承担的。
    `${x.status === "done" ? "已处理" : "待处理"}</span>` +
    `<span class="pp-t">${esc(String(x.text || "").slice(0, 120))}</span>` +
    (x.page ? `<span class="meta">${esc(String(x.page))}</span>` : "") +
    // 点中过某个元素的那些意见，给一条回去看的路（TASK-132 切片 B）。
    // 定位不保证成功 —— 找不到 / 认不准时说实话，见 `locateMessage`。
    (x.targetLabel
      ? `<button class="btn ghost sm" data-op-locate="${esc(String(x.id))}" ` +
        `title="回到他当时点的那个元素">◎ ${esc(x.targetLabel)}</button>`
      : "") +
    (x.locateNote ? `<span class="meta pp-opnote">${esc(x.locateNote)}</span>` : "") +
    `</li>`
  );
  const open = rows.filter((x) => x.status !== "done").length;
  return (
    `<details class="pp-opbox"><summary>我提过的意见（${rows.length}，待处理 ${open}）</summary>` +
    `<ul class="pp-oplist">${rows.slice().reverse().map(item).join("")}</ul></details>`
  );
}
