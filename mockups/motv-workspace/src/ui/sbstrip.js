// ④ Storyboard —— 横着看的一条带 (TASK-095 §2.4 / TASK-097 批次 4F)。
//
// 形态由要判断的那件事决定：**「前后 Shot 接起来是否顺」是跨镜判断**，单镜视图看不见
// 它。所以这里是一条横向可滚的带，一格一镜，缩略图挨着缩略图。
//
// 每格三选一：**通过 / 重出 / 跳过**。
//   通过  绑到那一张具体的草图 —— 换一张，通过自动失效
//   重出  撤销通过并再出一张（不改任何持久判定）
//   跳过  写下「这一镜不画草图」这个**人的决定**
//
// **四种状态在屏幕上必须分得开**（§2.5f 第一条）：`skipped` 是一个决定，
// `not_started` 是一件还没发生的事 —— 两者都「没有图」，但把它们画成一样，
// 创作者就会去做他已经决定不做的事。
//
// 便宜档写在带上，不藏在代码里：创作者要知道自己看的是草图（`DRAFT_SPEC`）。
//
// PURE PRESENTATION；写入全部经 ctx。

import { esc } from "../util/dom.js";
import { DRAFT_SPEC } from "../workflow/sbdraft.js";

const STATE_LABEL = {
  approved: ["✓", "已通过", "ok"],
  drafted: ["◐", "待确认", "warn"],
  skipped: ["⊘", "已跳过", "skip"],
  not_started: ["＋", "还没画", "none"],
};

function cell(r) {
  const [icon, label, cls] = STATE_LABEL[r.state] || STATE_LABEL.not_started;
  return (
    `<div class="sbs-cell sbs-${esc(cls)}" data-sbs-shot="${esc(r.shotId)}">` +
    `<div class="sbs-thumb">` +
    (r.draft && r.draft.url
      ? `<img src="${esc(r.draft.url)}" alt="" loading="lazy">`
      : `<span class="sbs-none">${esc(icon)}</span>`) +
    `</div>` +
    `<div class="sbs-meta"><b>${r.seq != null ? esc(String(r.seq).padStart(2, "0")) : ""}</b>` +
    `<span class="sbs-title">${esc(r.title)}</span>` +
    `<span class="chip ${esc(cls)}">${esc(label)}</span></div>` +
    `<div class="sbs-acts">` +
    (r.canApprove ? `<button class="btn sm primary" data-sbs-ok="${esc(r.shotId)}">通过</button>` : "") +
    (r.canRedraw ? `<button class="btn sm" data-sbs-redraw="${esc(r.shotId)}">重出</button>` : "") +
    (r.canRedraw ? `<button class="btn sm" data-sbs-up="${esc(r.shotId)}">上传草图</button>` : "") +
    (r.canSkip ? `<button class="btn sm" data-sbs-skip="${esc(r.shotId)}">跳过</button>` : "") +
    (r.canUnskip ? `<button class="btn sm" data-sbs-unskip="${esc(r.shotId)}">取消跳过</button>` : "") +
    `</div></div>`
  );
}

/**
 * 一镜的**草图任务单**。
 *
 * 今天图片生成走手工路线（付费图片路线没有任何 Accepted ADR 授权），所以这一格
 * 给的是「提示词 + 便宜档规格 + 一个上传入口」，**不是一句「已排入队列」**——
 * 那句话曾经在屏幕上出现过，而没有任何东西会产出一张草图。
 */
function brief(b) {
  if (!b) return "";
  return (
    `<div class="sbs-brief" data-sbs-brief="1">` +
    `<div class="sbs-h"><b>草图任务单 · ${esc(b.shotId)}</b>` +
    `<span class="meta">${esc(b.spec.label)}</span>` +
    `<span class="push"></span>` +
    `<button class="icon-btn" data-sbs-close>✕</button></div>` +
    (b.violations.length
      ? `<ul class="ap-missing">` + b.violations.map((v) => `<li>${esc(v)}</li>`).join("") + `</ul>`
      : "") +
    `<textarea class="ap-prompt" rows="8" readonly>${esc(b.prompt)}</textarea>` +
    (b.missing.length
      ? `<ul class="ap-missing">` + b.missing.map((x) => `<li>${esc(x)}</li>`).join("") + `</ul>`
      : "") +
    `<div class="ap-foot">` +
    `<span class="meta">复制到外部工具出图（${esc(b.spec.resolution)} / ${esc(b.spec.aspect)}），` +
    `回来上传成这一镜的草图 —— 上传即登记</span>` +
    `<button class="btn primary" data-sbs-up="${esc(b.shotId)}">上传出好的草图</button>` +
    `</div></div>`
  );
}

export function renderStoryboardStrip(m, ui = {}) {
  if (!m) return "";
  if (!m.total) {
    return (
      `<div class="sbs sbs-empty"><b>这一集还没有镜头</b>` +
      `<span class="meta">草图是按镜头出的 —— 先在第 ① 步确认镜头</span></div>`
    );
  }
  return (
    `<div class="sbs" data-sbs="1">` +
    `<div class="sbs-h"><b>④ Storyboard 草图</b>` +
    // 便宜档写在屏幕上，不藏在代码里
    `<span class="meta">${esc(DRAFT_SPEC.label)} —— 先便宜地看一眼构图与前后是否接得顺，` +
    `正式画面在第 ⑤ 步合成</span>` +
    `<span class="push"></span>` +
    `<span class="chip">${m.approved}/${m.total} 已通过</span>` +
    (m.skipped ? `<span class="chip skip">${m.skipped} 已跳过</span>` : "") +
    (m.drafted ? `<span class="chip warn">${m.drafted} 待确认</span>` : "") +
    (m.notStarted ? `<span class="chip none">${m.notStarted} 还没画</span>` : "") +
    `<button class="btn sm primary" data-sbs-all>一次出全集</button>` +
    `</div>` +
    // 横向可滚：跨镜比较是这一步的全部意义
    `<div class="sbs-track">${m.rows.map(cell).join("")}</div>` +
    (ui.sbsBrief ? brief(ui.sbsBrief) : "") +
    `</div>`
  );
}

export function bindStoryboardStrip(root, ctx, ui, rerender) {
  const all = root.querySelector("[data-sbs-all]");
  if (all) all.onclick = () => {
    const r = ctx.storyboard.drawAll();
    // 打开第一镜的任务单：全集的意义在于比较，但出图仍然是一镜一张
    ui.sbsBrief = (r.todo && r.todo.length) ? r.todo[0] : null;
    rerender();
  };
  root.querySelectorAll("[data-sbs-up]").forEach((el) => (el.onclick = async () => {
    await ctx.storyboard.upload(el.dataset.sbsUp);
    rerender();
  }));
  const close = root.querySelector("[data-sbs-close]");
  if (close) close.onclick = () => { ui.sbsBrief = null; rerender(); };
  root.querySelectorAll("[data-sbs-ok]").forEach((el) => (el.onclick = () => {
    ctx.storyboard.approve(el.dataset.sbsOk);
    rerender();
  }));
  root.querySelectorAll("[data-sbs-redraw]").forEach((el) => (el.onclick = () => {
    ui.sbsBrief = ctx.storyboard.redraw(el.dataset.sbsRedraw);
    rerender();
  }));
  root.querySelectorAll("[data-sbs-skip]").forEach((el) => (el.onclick = () => {
    ctx.storyboard.skip(el.dataset.sbsSkip);
    rerender();
  }));
  root.querySelectorAll("[data-sbs-unskip]").forEach((el) => (el.onclick = () => {
    ctx.storyboard.unskip(el.dataset.sbsUnskip);
    rerender();
  }));
}
