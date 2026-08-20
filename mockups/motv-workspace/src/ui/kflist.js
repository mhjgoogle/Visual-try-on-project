// 向导第 ⑤ 步 —— **一张全集清单** (TASK-095 §1.3 / §2.5 · TASK-097 批次 4G)。
//
// ⑤ 不是向导上的一个按钮：**合成要说清「哪几张图、什么顺序、每张管什么」，
// 而一个按钮表达不了这件事**。所以分工是：
//
//   向导  说清**还差哪几镜**，每行给一条「进入这一镜的画布合成 →」
//   画布  做**那一镜**（TASK-093 那块单镜画布）
//
// 闸门：`storyboardStatus == skipped` 或（`completed` 且草图已 approved）。
// **没过闸门不置灰导航**（既有纪律）：那一行照样进得去，只是如实写出缺什么，
// 并且给一条走得通的路（去 ④ 通过草图，或者把这一镜跳过）。
//
// 「批量」在这一步只能是**用同一套默认编排试一遍**，产出是提案，逐镜确认 ——
// ⑤ 是整条链上最贵的一步，一次把 60 镜按同一套编排送出去，等于把 60 次判断
// 压缩成一次点击。
//
// PURE PRESENTATION；写入全部经 ctx。

import { esc } from "../util/dom.js";

const STATE = {
  approved: ["✓", "已通过", "ok"],
  made: ["◐", "待确认", "warn"],
  skipped: ["⊘", "已跳过", "skip"],
  not_started: ["＋", "还没合成", "none"],
};

function row(r) {
  const [icon, label, cls] = STATE[r.state] || STATE.not_started;
  return (
    `<tr class="kfl-row kfl-${esc(cls)}">` +
    `<td class="mono">${r.seq != null ? esc(String(r.seq).padStart(2, "0")) : ""}</td>` +
    `<td>${esc(r.title || r.shotId)}</td>` +
    `<td><span class="chip ${esc(cls)}">${esc(icon)} ${esc(label)}</span></td>` +
    // ④ 那一格的状态照带：清单要说得出「为什么这一镜还进不去」
    `<td class="kfl-gate">${r.gateOk
      ? `<span class="chip ok">④ 已就绪</span>`
      : `<span class="chip gate">${esc(r.gateReason)}</span>`}</td>` +
    `<td class="kfl-act">` +
    // **不置灰导航**：进得去看，只是能不能合成另说
    `<button class="btn sm${r.canCompose ? " primary" : ""}" data-kfl-open="${esc(r.shotId)}">` +
    `${r.canCompose ? "进入这一镜的画布合成 →" : "仍然进去看看 →"}</button>` +
    `</td></tr>`
  );
}

export function renderKeyframeList(m) {
  if (!m) return "";
  if (!m.total) {
    return (
      `<div class="kfl kfl-empty"><b>这一集还没有镜头</b>` +
      `<span class="meta">⑤ 是按镜头合成的 —— 先在第 ① 步确认镜头</span></div>`
    );
  }
  return (
    `<div class="kfl" data-kfl="1">` +
    `<div class="kfl-h"><b>⑤ Keyframe 合成</b>` +
    `<span class="meta">草图给构图 · 角色设定图给身份 · 场景图给环境 · 分镜提示词给描述与风格` +
    ` —— 它是合成，不是又一次文生图</span>` +
    `<span class="push"></span>` +
    `<span class="chip">${m.approved}/${m.total} 已通过</span>` +
    (m.made ? `<span class="chip warn">${m.made} 待确认</span>` : "") +
    (m.skipped ? `<span class="chip skip">${m.skipped} 已跳过</span>` : "") +
    (m.notStarted ? `<span class="chip none">${m.notStarted} 还没合成</span>` : "") +
    `<button class="btn sm" data-kfl-try>用同一套默认编排试一遍</button>` +
    `</div>` +
    // 待办，不是阻塞（§2.5f 第二条）
    (m.todo ? `<div class="kfl-todo">${esc(m.todo)}</div>` : "") +
    `<table class="kfl-t"><thead><tr>` +
    `<th>镜号</th><th>镜头</th><th>⑤ 状态</th><th>④→⑤ 闸门</th><th>动作</th>` +
    `</tr></thead><tbody>${m.rows.map(row).join("")}</tbody></table>` +
    `</div>`
  );
}

export function bindKeyframeList(root, ctx, ui, rerender) {
  root.querySelectorAll("[data-kfl-open]").forEach((el) => (el.onclick = () => {
    // 「进入这一镜的画布」= 选中这一镜并切到它的画布 —— 那才是做合成的地方
    ctx.keyframe.openCanvas(el.dataset.kflOpen);
    rerender();
  }));
  const tryAll = root.querySelector("[data-kfl-try]");
  if (tryAll) tryAll.onclick = () => {
    // 报价由界面手上那一份 preflight 提供（`ui.gcQuote`）—— 没有就是没有，
    // 控制器会据此拒绝提交（不知道 ≠ 可以送）
    ctx.keyframe.tryAll({ preflight: ui.gcQuote || null });
    rerender();
  };
}
