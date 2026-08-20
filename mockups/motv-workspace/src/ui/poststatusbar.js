// ⑩ 后期交付 顶部的「后期状态」条 (TASK-096 §2.1–2.3 / TASK-097 批次 5A)。
//
// 这一条回答后期唯一重要的那个问题：**还差什么，其中哪些现在就能做。**
//
// 「现在就能做」是本批新出现的东西。产品负责人原话是
// **「音频在视频之后，但可以并行准备」**，而在此之前界面上只有一种「之后」——
// 于是创作者要么以为配音得等视频（白等），要么录完发现对不上画面（白录）。
// 判定不在这里：`shotstage.canStart` / `canFinalize` 是同一个引擎的两张表，
// `poststatus` 把两个 ok 变成一个词，这里只负责把那个词画出来。
//
// **状态一个都不重算**（TASK-096 §2.1）。这一层没有 `"completed"` 这种字面量去和
// 什么东西比较；它拿到的是 `poststatus` 的 phase。
//
// 挂载位置：`delivery` 这一页的**页面级**位置，七个 section 都在它下面 ——
// 「这一集后期还差什么」不属于某一个 section。§2.5i 第二条要求先确认这件事：
// 这一页的 section 由 `production.js` 的 `delivery:` 分支自己切（`sectionOf`），
// 而模块表里另有 `audio:` 与 `edit:` 两个**历史键**各自有渲染器 —— 挂到那两个上面，
// 创作者从 rail 进来时屏幕上什么都不会出现。这是同一处混淆的第四次，不再花第五次。
//
// PURE：模型由控制器给，渲染是纯字符串。

import { esc } from "../util/dom.js";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** 并行窗口那句话 —— 只有真的存在这个差额时才出现（`poststatus.parallelWindow`）。 */
function parallelLine(p) {
  if (!isObj(p) || !p.exists) return "";
  return (
    `<div class="ps-par"><b>${esc(p.text)}</b>` +
    (p.reason ? `<span class="meta"> —— 定稿卡在：${esc(p.reason)}</span>` : "") +
    `</div>`
  );
}

/** 一步一行。`text` 只印非零的桶，所以行数不会被「0 镜进行中」撑开。 */
function stageLine(row) {
  if (!isObj(row)) return "";
  return (
    `<div class="ps-row">` +
    `<span class="ps-txt">${esc(row.text)}</span>` +
    (row.known
      ? `<span class="chip ${row.settled === row.total ? "ok" : ""}">${row.settled}/${row.total} 已了结</span>`
      : `<span class="chip">—</span>`) +
    `</div>`
  );
}

/** 声音资产：还差哪些文件，以及**答不上来时**真实可做的那件事。 */
function soundBlock(g) {
  if (!isObj(g) || !isObj(g.byStage)) return "";
  const rows = Object.keys(g.byStage).map((k) => {
    const s = g.byStage[k];
    const bits = [
      `${s.have} 已有`,
      s.missing ? `${s.missing} 镜还差文件` : "",
      s.undecided ? `${s.undecided} 镜还没写下要不要做` : "",
    ].filter(Boolean);
    return (
      `<div class="ps-snd">` +
      `<b>${esc(s.label)}</b><span class="meta">（${s.tracks.map(esc).join(" · ")}）</span>` +
      `<span class="ps-txt">${esc(bits.join(" · "))}</span>` +
      (s.why ? `<div class="meta">${esc(s.why)}</div>` : "") +
      (s.action ? `<div class="ps-act">现在真实可做的是：${esc(s.action)}</div>` : "") +
      `</div>`
    );
  });
  return `<div class="ps-sound"><div class="ps-h2">声音资产</div>${rows.join("")}</div>`;
}

export function renderPostStatus(m) {
  if (!isObj(m)) return "";
  if (!m.hasShots) {
    return (
      `<div class="ps"><div class="ps-h"><b>后期状态</b>` +
      `<span class="meta">这一集还没有镜头 —— 先在「本集剧本」拆分镜</span></div></div>`
    );
  }
  return (
    `<div class="ps" data-ps="1">` +
    `<div class="ps-h"><b>后期状态</b>` +
    `<span class="meta">${esc(m.rule)}</span>` +
    `<span class="push"></span>` +
    `<button class="btn sm" data-goto="shots">去分镜表</button></div>` +
    parallelLine(m.parallel) +
    m.stages.map((k) => stageLine(m.summary[k])).join("") +
    soundBlock(m.gaps) +
    (Array.isArray(m.unclassified) && m.unclassified.length
      ? `<div class="ps-unc"><b>有音轨没有归属：${m.unclassified.map(esc).join(" · ")}</b>`
        + `<div class="meta">它现在不参与任何一步的状态判定 —— 先决定它算配音还是音效</div></div>`
      : "") +
    `<div class="ps-why">${esc(m.whyHere)}</div>` +
    `</div>`
  );
}
