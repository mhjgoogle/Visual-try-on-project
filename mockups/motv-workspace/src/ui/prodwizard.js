// 剧集制作是一条向导，不是五个平级页面 (TASK-095 / TASK-097 批次 4A)。
//
// 产品负责人 2026-08-17：**「现在剧集制作的各个页面还是设计的太 busy 了。
// 完全不知道点击哪里好。」**
//
// 那句抱怨有精确的技术形态：剧集制作今天是五个平级页面，每页自己又是三栏 ——
// **任何时刻屏幕上都有十几个同级入口，没有一个说「下一步点我」。**
// 向导的性质正好相反：**任何时刻只有一个下一步动作。**
//
// 五步（不是 LibTV 的三步 —— ④⑤ 是产品负责人当场补上的，而且他补的是目标产品
// 自己的一个缺陷：从一段文字直接跳到整条链上最贵的一步，中间没有任何一次便宜的
// 目视确认）：
//
//   ① 确认镜头   分镜表
//   ② 准备资产   角色 / 场景 / 道具的「基础资产」
//   ③ 合成提示词 两份：分镜提示词 · 视频运动提示词
//   ④ Storyboard 低成本草图，先确认镜头设计
//   ⑤ Keyframe   由 ④ + ② 合成的正式画面
//
// 本批只做**骨架与导航**，各步内容是 4B–4G。但骨架**不是壳子**：顶部那些数字必须
// 是真的（§2.5），每一步「能不能进」必须是真的判定（§2.5e）。
//
// ─────────────────────────────────────────────────────────────────────────────
// §2.5e 对本文件的直接约束：**向导的每一步本身就是一条缝。**
//
// 「这一步说可以进下一步」与「下一步真的能做」是两处在陈述同一件事实。
// 批次 3 那 9 个 P1 全落在这种缝上，而在向导里它的形状是
// **「下一步亮着但点进去是空的」**。
//
// 所以每一步声明的 `ready` 都必须来自它**真实的完成条件**，而不是「上一步点过了」。
// 一个只记录「用户走到哪一步」的向导会立刻变成那条缝：它记的是导航历史，
// 不是工作状态。因此本文件**不存进度** —— 进度全部派生自登记表。
// ─────────────────────────────────────────────────────────────────────────────
//
// 不新增页面（TASK-095 §1.1）：向导是一层**覆盖面**，`PAGES.length === 11` 那条
// 冻结守卫不碰（ADR-0066 决策 10）。新界面最容易顺手多开一页。
//
// PURE：模型是派生的，渲染是纯字符串；写入与导航由 shell 执行。

import { esc } from "../util/dom.js";
import { countText } from "../workflow/counts.js";

/**
 * 五步，闭集。
 *
 * `count` 指名这一步顶部显示哪一个计数 —— **走 `counts.productionCounts`**，
 * 不在这里算（§2.6.2：就地算会同时造成「模块永远接不上」和「多出第二份计数」，
 * 两个缺陷一次达成）。
 *
 * `lands` 是这一步的内容**今天落在哪个既有页面**。向导不新增页面，它把已有内容
 * 重新组织成一条路，所以每一步都必须指得出落点；指不出来的步骤在本批里如实说
 * 「这一步的界面还没做」，而不是给一个空白面板。
 */
export const WIZARD_STEPS = [
  {
    id: "shots",
    n: 1,
    label: "确认镜头",
    detail: "AI 生成的分镜表，每格可改，可删镜头",
    count: "shotsReady",
    lands: "storyboard",
    built: true,
  },
  {
    id: "assets",
    n: 2,
    label: "准备资产",
    detail: "角色 / 场景 / 道具的基础资产 —— 第 ③ 步要用它们",
    count: "assetsReady",
    lands: "refplan",
    built: true,
  },
  {
    id: "prompts",
    n: 3,
    label: "合成提示词",
    detail: "两份：分镜提示词出图，视频运动提示词出视频",
    count: "promptsComposed",
    lands: "shotwork",
    built: true,
  },
  {
    id: "storyboard",
    n: 4,
    label: "Storyboard",
    detail: "低成本草图，先确认构图与前后是否接得顺 —— 便宜是它存在的理由",
    count: "storyboardPassed",
    // 批次 4F 建成：落点是分镜设计页的 storyboard 一节（那条横向带）。
    lands: "storyboard",
    built: true,
  },
  {
    id: "keyframe",
    n: 5,
    label: "Keyframe",
    detail: "由草图 + 角色设定图 + 场景设定图合成的正式画面，就是视频首帧",
    count: "keyframePassed",
    lands: null,
    built: false,
  },
];

const STEP_BY_ID = new Map(WIZARD_STEPS.map((s) => [s.id, s]));

export const wizardStep = (id) => STEP_BY_ID.get(id) || null;

/**
 * 这一步**真实的**完成条件与阻塞原因 —— 纯函数，只读 `counts`。
 *
 * 为什么在这个文件里而不是在控制器里：§2.5d 要求「两个方向都钉住」用的是
 * **生产用的那个谓词**。谓词藏在 `app.js` 的一个闭包里 → 测试只能自己写一份
 * 等价物 → 「两个方向都钉住」自己就变成了一条新的缝。所以它必须有名字、
 * 可导出、生产与测试共用同一份。
 *
 * **答不上来绝不读作放行。** 这是「不知道 ≠ 0」（§2.5b）在闸门上的同一形状：
 * 计数上它是「别把不知道印成 0」，闸门上它是「别把不知道当成通过」。
 * 反过来就是 codex 在本批报的那个 P1：一集没有镜头时 `assetsReady` 是 unknown，
 * 第 ③ 步于是没有任何阻塞、亮着「进入」，点进去是一个空的 shotwork ——
 * 正是文件头那句「下一步亮着但点进去是空的」。
 */
export function stepReadiness(counts, stepId) {
  const c = counts || {};
  const known = (id) => !!(c[id] && c[id].known);
  const val = (id) => c[id] || {};
  const own = (id) => {
    if (id === "shots") {
      // 第 ① 步的输入是剧本，不是另一个向导步骤 —— 没有分镜表时它**真的开始不了**，
      // 所以这是唯一一个自己就能 cannotStart 的步骤。
      const noScript = "这一集还没有分镜 —— 先在「本集剧本」里写剧本，再让脚本生成器拆分镜";
      if (!known("shotsReady")) {
        return { done: false, why: "读不到这一集的分镜表", cannotStart: true };
      }
      return val("shotsReady").value > 0
        ? { done: true, why: null }
        : { done: false, why: noScript, cannotStart: true };
    }
    if (id === "assets") {
      if (!known("assetsReady")) return { done: false, why: "读不到资产就绪情况" };
      const r = val("assetsReady");
      if (!(r.total > 0)) return { done: false, why: "分镜表里还没有人物 / 场景 / 道具" };
      return r.missing === 0
        ? { done: true, why: null }
        : { done: false, why: `还有 ${r.missing} 个人物 / 场景 / 道具没有设定图 —— 合成的提示词会用到它们` };
    }
    if (id === "prompts") {
      if (!known("promptsComposed")) return { done: false, why: "读不到提示词编译情况" };
      const r = val("promptsComposed");
      if (!(r.total > 0)) return { done: false, why: "没有镜头可以合成提示词" };
      return r.value === r.total
        ? { done: true, why: null }
        : { done: false, why: `还有 ${r.total - r.value} 个镜头的两份提示词没编译齐` };
    }
    const cid = id === "storyboard" ? "storyboardPassed" : "keyframePassed";
    const unbuilt = "这一步的界面还在做（本链 4F / 4G）";
    if (!known(cid)) return { done: false, why: unbuilt };
    const r = val(cid);
    return r.total > 0 && r.value + (r.skipped || 0) === r.total
      ? { done: true, why: null }
      : { done: false, why: unbuilt };
  };
  const step = wizardStep(stepId);
  if (!step) return { done: false, blockers: [] };
  const mine = own(stepId);
  // 上游要求**从步骤次序派生**，不逐步手写。§2.6.1：手写的「检查这 N 项」清单
  // 总会漏一项 —— 这次漏掉的就是第 ③ 步没检查上游是否**可知**。
  const upstream = WIZARD_STEPS
    .filter((s) => s.n < step.n)
    .map((s) => ({ s, r: own(s.id) }))
    .filter(({ r }) => !r.done);
  // `blockers` 的含义是**「这一步开始不了」**，不是「这一步还没做完」。
  //
  // 这两者被我混成一个之后，真实屏幕上第 ② 步（正是此刻该做的那一步）顶着一句
  // 「还不能开始这一步 —— 还有 1 个没有设定图」：把「你要做的工作」当成了
  // 「拦住你的理由」。它是那个 P1 的镜像 —— 一个只会拒绝的闸门同样是错的，
  // 而且是 §2.5d 要求钉住反方向的原因。所以自己没做完**不进** blockers，
  // 它是这一步的工作内容；进 blockers 的只有上游缺失。
  const blockers = upstream.length
    ? [`先完成第 ${upstream[0].s.n} 步「${upstream[0].s.label}」 —— ${upstream[0].r.why}`]
    : (mine.cannotStart && mine.why ? [mine.why] : []);
  return { done: mine.done, blockers };
}

/**
 * 向导的视图模型。
 *
 * `counts` 是 `counts.productionCounts(...)` 的产出 —— 传进来而不是在这里算，
 * 于是顶部的数字与其他消费者**同源**（§2.6.2 那个 16/48）。
 *
 * `readyOf(stepId)` 由调用方给：它是这一步**真实的完成条件**，来自登记表与
 * TASK-092 的六个 stage。向导不自己判断「他点过了没有」——
 * 那会把导航历史当成工作状态（见文件头 §2.5e 那段）。
 */
export function wizardModel({ counts, readyOf, activeId = null } = {}) {
  const readyFn = typeof readyOf === "function" ? readyOf : () => null;
  // WHICH STEP IS SHOWN, when the creator has not picked one. Opening on ① is wrong
  // whenever ① is already done: the header then says 「下一步：准备资产」 while the body
  // shows a finished step, and 「任何时刻只有一个下一步动作」 stops being true on the
  // one screen that promises it. Seen on the real project, not in a test — the tests
  // all passed an explicit `activeId` (TASK-097 §2.6.4).
  const doneOf = (id) => (readyFn(id) || {}).done === true;
  const firstUnfinished = WIZARD_STEPS.find((s) => !doneOf(s.id));
  const shown = activeId || (firstUnfinished ? firstUnfinished.id : WIZARD_STEPS[0].id);
  const steps = WIZARD_STEPS.map((s) => {
    const r = readyFn(s.id) || {};
    const blockers = Array.isArray(r.blockers) ? r.blockers.filter(Boolean) : [];
    return {
      ...s,
      // 顶部数字：一处派生，一个显示入口
      countText: countText(s.count, counts),
      // 这一步自己算不算完成（真实条件，不是「走到过」）
      done: r.done === true,
      // 能不能进这一步。**不置灰导航**（既有纪律）：仍然可进，但主行动说明缺什么。
      ready: blockers.length === 0,
      blockers,
      active: s.id === shown,
    };
  });
  const active = steps.find((s) => s.active) || steps[0];
  return {
    steps,
    active,
    // 「一条只有一个下一步的路」 —— 第一个没做完的那一步就是下一步
    next: steps.find((s) => !s.done) || null,
    // 全部做完才解锁批量生视频（TASK-095 §2.5 末句）
    allDone: steps.every((s) => s.done),
  };
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

/** 顶部常驻进度条：步号 + 名字 + **真实数字**。 */
function progress(m) {
  return (
    `<div class="pw-steps">` +
    m.steps.map((s) =>
      `<button class="pw-step${s.active ? " on" : ""}${s.done ? " done" : ""}" ` +
      `data-pw-step="${esc(s.id)}" title="${esc(s.detail)}">` +
      `<span class="n">${s.done ? "✓" : s.n}</span>` +
      `<b>${esc(s.label)}</b>` +
      `<small>${esc(s.countText)}</small>` +
      `</button>`).join(`<span class="pw-line"></span>`) +
    `</div>`
  );
}

/** 主区：**任何时刻只有一个下一步动作**。 */
function body(m) {
  const s = m.active;
  const cta = !s.built
    ? `<div class="pw-note pw-unbuilt">这一步的界面还在做（本链 4F / 4G）—— ` +
      `不给一个空白面板假装它已经在了。前面几步的产出会成为它的输入。</div>`
    : s.ready
      ? `<button class="btn primary pw-go" data-pw-go="${esc(s.id)}">进入「${esc(s.label)}」 →</button>`
      : `<div class="pw-block"><b>还不能开始这一步</b><ul>` +
        s.blockers.map((b) => `<li>${esc(b)}</li>`).join("") +
        `</ul>` +
        // 闸门不置灰导航（既有纪律）：仍然给一条进去的路，只是如实说缺什么
        `<button class="btn pw-go" data-pw-go="${esc(s.id)}">仍然进去看看 →</button></div>`;
  return (
    `<div class="pw-body">` +
    `<div class="pw-h"><span class="pw-n">${s.n}</span><b>${esc(s.label)}</b>` +
    `<span class="meta">${esc(s.detail)}</span></div>` +
    `<div class="pw-count">${esc(s.countText)}</div>` +
    cta +
    `</div>`
  );
}

export function renderProdWizard(m) {
  if (!m) return "";
  return (
    `<div class="pw-scrim show" data-pw="1"><div class="pw">` +
    `<div class="pw-top"><b>剧集制作</b>` +
    `<span class="meta">一条只有一个下一步的路</span>` +
    `<span class="push"></span>` +
    (m.next ? `<span class="pw-next">下一步：${esc(m.next.label)}</span>` : "") +
    `<button class="icon-btn" data-pw-close>✕</button></div>` +
    progress(m) +
    body(m) +
    `<div class="pw-foot">` +
    (m.allDone
      ? `<b>五步都完成了 —— 可以批量生视频</b>`
      : `<span class="meta">向导覆盖九步里的 ① 到 ⑥，止于批量生视频；` +
        `配音 / 剪辑 / 交付质检在「后期交付」里（那三步不是一条链，塞进来会重新变成「太 busy」）。</span>`) +
    `</div></div></div>`
  );
}

/** 绑定。三个动作：切步、进入落点、关闭。 */
export function bindProdWizard(root, { onStep, onGo, onClose } = {}) {
  root.querySelectorAll("[data-pw-step]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onStep) onStep(el.dataset.pwStep);
  }));
  root.querySelectorAll("[data-pw-go]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onGo) onGo(el.dataset.pwGo);
  }));
  root.querySelectorAll("[data-pw-close]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onClose) onClose();
  }));
}
