// 剧集制作的那一块画布（TASK-124）。
//
// 产品负责人 2026-08-30，两句话定了形状：
//
//   「首先我需要选集制作。设计下拉菜单。然后不要点击剧本和设定同步然后跳回故事开发。
//    正确路径应该是故事开发之后进入剧集制作。到剧集制作的入口之后。主要的动作是选择
//    要制作的剧集。然后准备该集的资产。包括人物和场景和各种必须的提示词。最后生成
//    视频。不要出现分镜设计这些应该在工作区出现而不应该在左边和上面设计各种入口。」
//
//   「请你思考如何能让用户简洁并直观的操作」
//
// 所以这一屏是**一条从上往下的线，三步，每一步只有一个主按钮**：
//
//   ① 选哪一集     一个下拉 —— 进来第一件事
//   ② 备这一集的料  人物 / 场景 / 提示词：一行一个数，缺了给一个按钮去补
//   ③ 生成视频     一镜一张卡，一个主按钮；再往后是审片与出片
//
// **他不需要知道这个应用有几个页面。** 页面一个没删（分镜设计、镜头制作、粗剪审片、
// 后期交付都在），但它们不再作为并列入口摆在左栏与顶部 —— 只在某一步真的需要它时，
// 作为那一步的动作出现。
//
// 剧本与设定同步**不画在这条线上**：它们属于故事开发，摆在这里只会把他弹回上一个空间
// （他 2026-08-30 的原话：「不要点击剧本和设定同步然后跳回故事开发」）。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import { productionPlan, episodeShots, shotBlockers } from "./prodplan.js";

/** 一镜要走的那几步。**顺序即流程**，名字用领域自己的说法。 */
export const SHOT_STEPS = [
  { key: "storyboard", label: "草图", goto: "storyboard" },
  { key: "blocking", label: "白膜", goto: "blocking" },
  { key: "keyframe", label: "关键帧", goto: "frames" },
  { key: "video", label: "视频", goto: "video" },
];

/** 备料那三行的说法。**空不等于齐**（honest state）。 */
const WHY = {
  ok: "够了",
  empty: "还没有",
  unknown: "这一集还没有镜头 —— 缺什么现在判断不了",
};

const MARK = { done: "✓", active: "◔", todo: "·" };

/** 这一集的名字。`title` 常常已经带着集号，别再前缀一次。 */
export function episodeLabel(ep) {
  const title = String((ep && ep.title) || "").trim();
  const code = String((ep && ep.code) || "").trim();
  if (!title) return code;
  return title.startsWith(code) ? title : `${code} ${title}`;
}

/* --- 读模型 ----------------------------------------------------------------- */

export function canvasModel(ctx) {
  const pd = ctx.prodData();
  const prod = pd.production || {};
  const plan = productionPlan(pd, ctx.script ? ctx.script.doc() : null);
  const shots = episodeShots(pd);
  const blocking = prod.blocking || {};

  const episodes = (prod.episodes || []).map((e, i) => ({
    episodeId: e.episodeId,
    code: `EP${String(i + 1).padStart(2, "0")}`,
    title: e.title || "",
    active: e.episodeId === prod.activeEpisodeId,
  }));

  const cards = shots.map((s) => {
    // 每一镜的阶段板用**既有的**那一份：算第二遍的那一刻，
    // 卡片与工作区就会开始各说各话。
    const board = ctx.shot && ctx.shot.stageBoard ? ctx.shot.stageBoard(s.shotId) : null;
    const b = blocking[s.shotId];
    const hasBlocking = !!(b && (b.actors || []).some((a) => !a.hidden));
    const steps = SHOT_STEPS.map((step) => {
      let state = "todo";
      if (step.key === "blocking") state = hasBlocking ? "done" : "todo";
      else if (board && board[step.key]) {
        const st = board[step.key];
        state = st.status === "completed" ? "done" : st.status === "in_progress" ? "active" : "todo";
      }
      return { ...step, state, mark: MARK[state] };
    });
    return {
      shotId: s.shotId,
      seq: s.seq,
      title: s.title || s.shotId,
      // **`s.poster` 这个字段不存在。** `episodeShots` 摊平的是 `storyboardModel`
      // 的镜头，那上面当前画面叫 `thumb` —— 于是这张卡从上线起就永远显示
      //「还没有画面」，哪怕关键帧早就打了勾（TASK-087 §5.19 记的就是这一条）。
      //
      // 本来不在 TASK-139 范围内（AGENTS.md 第 17 条），**但它挡住这张卡上的出图
      // 按钮**：出完图卡片仍说「还没有画面」，他会以为没成功、再点一次 ——
      // 而那是一次真的重复消耗。所以按第 17 条的例外就地修掉，只改这一处取值。
      poster: s.poster || s.thumb || null,
      blockers: shotBlockers(pd, s),
      steps,
      next: steps.find((x) => x.state !== "done") || null,
    };
  });

  // ② 备料：**缺什么、去哪补**全部来自 `shotBlockers` —— 它已经把这两件都算好了，
  //    这里只按类别归拢，不自己再判一遍「够不够」（判第二遍就会与镜头卡打架）。
  const byCode = new Map();
  for (const c of cards) {
    for (const bk of c.blockers) {
      if (!byCode.has(bk.code)) byCode.set(bk.code, { ...bk, shots: [] });
      byCode.get(bk.code).shots.push(c.seq ?? c.shotId);
    }
  }
  const gaps = [...byCode.values()];
  const hit = (re) => gaps.filter((g) => re.test(`${g.code} ${g.text}`));
  const prep = [
    { key: "people", label: "人物", have: (prod.characters || []).length, gaps: hit(/character|人物|角色/), goto: "characters" },
    { key: "places", label: "场景", have: (prod.locations || []).length, gaps: hit(/location|scene|场景/), goto: "world" },
    {
      key: "prompts",
      label: "提示词",
      have: cards.filter((c) => c.steps.some((s) => s.key === "keyframe" && s.state !== "todo")).length,
      total: cards.length,
      gaps: hit(/prompt|提示词|参考/),
      goto: "refplan",
    },
  ];

  // **没有证据不等于通过**（这份仓库反复付过代价的那条）。一个镜头都没有的时候，
  // 「缺什么」是**无从判断**，不是「都齐了」；有 0 个人物就说「够了」同理。
  for (const row of prep) {
    row.state = row.gaps.length
      ? "gap"
      : !cards.length
      ? "unknown"
      : row.have === 0 && row.total === undefined
      ? "empty"
      : "ok";
  }
  const ready = cards.filter((c) => !c.blockers.length).length;
  return {
    plan,
    cards,
    episodes,
    episode: plan.episode,
    prep,
    gaps,
    ready,
    // 当前该做哪一步 —— **只有一步会高亮**，这就是「直观」的具体含义。
    // 一个镜头都没有时高亮的是「备料」，不是「生成视频」：那一步此刻无事可做。
    step: !plan.episode ? 1 : gaps.length || !cards.length ? 2 : 3,
  };
}

/* --- 三步 ------------------------------------------------------------------- */

function stepBox(n, title, on, body, hint = "") {
  return (
    `<section class="ep3${on ? " on" : ""}">` +
    `<div class="ep3-h"><span class="n">${n}</span><span class="t">${esc(title)}</span>` +
    (hint ? `<span class="hint">${esc(hint)}</span>` : "") +
    `</div><div class="ep3-b">${body}</div></section>`
  );
}

/** ① 选集：进来第一件事，一个下拉。 */
function pickEpisode(m) {
  if (!m.episodes.length) {
    return (
      `<div class="ep3-empty">还没有剧集 —— 先去「故事开发 · 结构规划」把集数定下来。` +
      `<button class="btn sm" data-goto="episodes">去结构规划</button></div>`
    );
  }
  const opts = m.episodes
    .map(
      (e) =>
        `<option value="${esc(e.episodeId)}"${e.active ? " selected" : ""}>${esc(episodeLabel(e))}</option>`,
    )
    .join("");
  return (
    `<div class="ep3-pick"><select class="ep3-sel" data-ep-pick="1">${opts}</select>` +
    `<span class="meta">共 ${m.episodes.length} 集 · 这一集 ${m.cards.length} 个镜头</span></div>`
  );
}

/** ② 备料：人物 / 场景 / 提示词。一行一个数，缺了给一个按钮。 */
function prepare(m) {
  return m.prep
    .map((p) => {
      const bad = p.gaps.length;
      const count = p.total !== undefined ? `${p.have} / ${p.total}` : `${p.have} 个`;
      const g = bad ? p.gaps[0] : null;
      return (
        `<div class="ep3-row${bad ? " bad" : ""}">` +
        `<span class="k">${esc(p.label)}</span><span class="v">${esc(count)}</span>` +
        (g
          ? `<span class="why">${esc(g.text)}${g.shots.length > 1 ? `（${g.shots.length} 镜）` : ""}</span>` +
            `<button class="btn sm" data-goto="${esc(g.fix || p.goto)}">${esc(g.fixLabel || "去补上")}</button>`
          : `<span class="why ${p.state === "ok" ? "ok" : ""}">${esc(WHY[p.state] || "")}</span>` +
            `<button class="btn ${p.state === "ok" ? "ghost " : ""}sm" data-goto="${esc(p.goto)}">` +
            `${p.state === "ok" ? "看看" : "去准备"}</button>`) +
        `</div>`
      );
    })
    .join("");
}

/** ③ 生成视频：一镜一张卡，一个主按钮。 */
function generate(m) {
  if (!m.cards.length) {
    return (
      `<div class="ep3-empty">这一集还没有镜头。` +
      `<button class="btn sm" data-goto="storyboard">去拆分镜</button></div>`
    );
  }
  const cards = m.cards
    .map((c) => {
      const dots = c.steps
        .map((s) => `<span class="ec-dot ec-${esc(s.state)}">${s.mark}${esc(s.label)}</span>`)
        .join("");
      const poster = c.poster
        ? `<img class="ec-poster" src="${esc(c.poster)}" alt="" data-media-url="${esc(c.poster)}">`
        : `<div class="ec-poster none">还没有画面</div>`;
      return (
        `<div class="ec-card">${poster}` +
        `<div class="ec-h"><span class="n">${esc(String(c.seq ?? ""))}</span>` +
        `<span class="t">${esc(c.title)}</span></div>` +
        `<div class="ec-steps">${dots}</div>` +
        (c.blockers.length ? `<div class="ec-block">⚠ ${esc(c.blockers[0].text)}</div>` : "") +
        // ✨ 出图（TASK-139 / REQ-008 判据 1）。**只在这一镜还没有画面时出现** ——
        // 卡上那句「还没有画面」就是它要填的那个洞，填完它就该消失，而不是长期占位。
        //
        // 它没有违反「一镜一张卡，一个主按钮」：主按钮仍然是「下一步」。这一颗是
        // 那句「还没有画面」的直接出口 —— 否则他要先做草图、再做白膜，才走得到
        // 能出图的那一页（产品负责人 2026-09-05：「我还是没有找到啊」）。
        (c.poster
          ? ""
          : `<button class="btn sm ec-gen" data-ec-gen="${esc(c.shotId)}" ` +
            `title="自动生成这一镜的画面（免费 · 不产生账单；来源见 .env.local 的 IMAGE_PROVIDER）">` +
            `✨ 出图</button>`) +
        (c.next
          ? `<button class="btn sm ec-go" data-ec-step="${esc(c.shotId)}:${esc(c.next.goto)}">` +
            `${esc(c.next.label === "视频" ? "生成视频" : `做${c.next.label}`)}</button>`
          : `<div class="ec-done">这一镜做完了</div>`) +
        `</div>`
      );
    })
    .join("");
  return (
    `<div class="ec-grid">${cards}</div>` +
    `<div class="ep3-after"><button class="btn ghost sm" data-goto="cutreview">连起来看一遍</button>` +
    `<button class="btn ghost sm" data-goto="delivery">出成片</button></div>`
  );
}

export function renderEpCanvas(ctx, ui) {
  const m = canvasModel(ctx);
  void ui;
  return (
    head("剧集制作", m.episode ? esc(episodeLabel(m.episode)) : "还没有选集") +
    `<div class="ep3-note">从上往下走：选一集 → 把这一集要用的东西备齐 → 一镜一镜生成。</div>` +
    stepBox("①", "选哪一集", m.step === 1, pickEpisode(m)) +
    stepBox("②", "准备这一集的资产", m.step === 2, prepare(m), m.gaps.length ? `还差 ${m.gaps.length} 样` : "都齐了") +
    stepBox("③", "生成视频", m.step === 3, generate(m), m.cards.length ? `${m.ready} / ${m.cards.length} 镜可以开做` : "")
  );
}
