// LEFT of 剧集制作 — 当前 Shot 参考输入 (TASK-066 §4 / §5 / §6).
//
//   当前 Shot 参考输入                          [⊙ AI 推荐]
//   主要画面参考 ⓘ                              [+ 添加参考]
//     ▢ 林晚 / 少女时期 Ref    v3 · 2026-05-20        ⋮
//     ▢ 暗夜酒吧 场景 Ref      v2 · 2026-05-18        ⋮
//   视频编排参考 ⓘ                              [+ 添加参考]
//     ▢ 镜头运动 Camera Ref    慢推 · v1              ⋮
//
// WHAT THIS COLUMN IS NOT ANY MORE. It used to be an object Inspector with seven
// function panels (镜头 / 参考 / Prompt / 生成 / 画面 / 视频 / 音频) — 「先选功能，再找
// 对象」. §4 removes that: this column answers ONE question, 「这个 Shot 当前引用了哪些
// 视觉资产」, and every per-object operation moved onto the centre's cards (§10).
//
// TWO GROUPS, DERIVED (§4). The split is `refuse.groupsForShot`: a reference's side
// comes from the creator's own per-card choice, or from its role when they made none.
// A reference set to 「同时用于两者」 appears in BOTH groups — that is what 同时 means,
// and showing it once with a footnote would hide half of what it does.
//
// THE ⋮ MENU IS THE RELATION CONTROL (§5). No separate 「关联到哪些输出」 bar, and no
// hand-drawn wires: the creator picks a side on the card and the centre's graph
// re-draws itself from the same derivation.
//
// PURE PRESENTATION over ctx.refUse / ctx.episode / ctx.frames.

import { esc } from "../util/dom.js";
import { ROLE_LABEL, REFERENCE_ROLES } from "../workflow/geninput.js";
import { USE_LABEL, USE_CHIP } from "../workflow/refuse.js";
import { domainsForKind } from "../workflow/assetreg.js";
import { runOperation } from "./directorshot.js";

/** The two groups, in the order the chain runs. */
export const GROUPS = [
  ["image", "主要画面参考", "进入 Image Prompt —— 决定人物、场景、服装、构图、光影"],
  ["video", "视频编排参考", "进入 Video Prompt —— 决定运镜、动作、表演、节奏"],
];

/** The roles each group's 「+ 添加参考」 offers. Derived from what the compilers read,
 *  so the menu cannot offer a role that would land in neither prompt. */
const GROUP_ROLES = {
  image: ["character-reference", "location-reference", "prop-reference", "style-reference"],
  video: ["video-style-reference", "motion-reference", "camera-reference", "performance-reference"],
};

const ZH_DOMAIN = { images: "图", videos: "视频", audio: "音频" };

/** A reference row's thumbnail — the DOMAIN decides the element. Rendering a motion
 *  clip as `<img>` gives it a broken-image glyph, which reads as 「出错了」 when the
 *  truth is 「这是一段视频」. */
function thumb(r) {
  if (!r.url || r.storageState === "archived" || r.storageState === "removed") {
    return `<span class="sr-th none" title="字节不在本地（记录仍在）">⃠</span>`;
  }
  if (r.domain === "videos") {
    return `<video class="sr-th" src="${esc(r.url)}" preload="metadata" muted playsinline></video>`;
  }
  if (r.domain === "audio") return `<span class="sr-th none" title="音频参考">🎵</span>`;
  return `<img class="sr-th" src="${esc(r.url)}" alt="" loading="lazy">`;
}

/** `v3 · 2026-05-20` — the version and when this take was registered. An unknown
 *  date is omitted rather than printed as today's. */
function meta(r) {
  const bits = [];
  if (r.version != null) bits.push(`v${r.version}`);
  if (r.at) bits.push(String(r.at).slice(0, 10));
  return bits.join(" · ");
}

/**
 * One reference card.
 *
 * `⋮` opens the RELATION menu (§5). It is rendered only while open, so a stale menu
 * can never be left pointing at a binding that has moved.
 */
function card(r, group, openMenu) {
  const key = `${group}:${r.key}`;
  const isOpen = openMenu === key;
  const sideChips = r.use === "both"
    ? `<span class="chip">${esc(USE_CHIP.both)}</span>`
    : r.useSource === "creator"
      ? `<span class="chip ok" title="你为这张卡片指定的用途">${esc(USE_CHIP[r.use])}</span>`
      : "";
  return (
    `<li class="sr-card${isOpen ? " menuopen" : ""}">` +
    thumb(r) +
    `<button class="sr-meta" data-sr-view="${esc(r.key)}" title="查看这个参考">` +
    `<b>${esc(r.name)}</b>` +
    `<span class="sr-sub">${esc(ROLE_LABEL[r.kind] || r.kind || "未分类")}` +
    (meta(r) ? ` · ${esc(meta(r))}` : "") + `</span>` +
    `</button>` +
    sideChips +
    `<button class="sr-dots" data-sr-menu="${esc(key)}" title="关系与资产操作">⋮</button>` +
    (isOpen
      ? `<div class="sr-menu">` +
        // RELATION CONTROL — only the sides this role's compilers really read are
        // offered (§5 「语义允许时」). A switch the compiler ignores would be a
        // control that silently does nothing.
        `<div class="sr-mhd">关系</div>` +
        r.allowed.map((u) =>
          `<button class="${r.use === u ? "cur" : ""}" data-sr-use="${esc(r.key)}" data-use="${esc(u)}">` +
          `${esc(USE_LABEL[u])}</button>`).join("") +
        (r.allowed.length === 1
          ? `<div class="sr-mnote">这一类参考只有主要画面会读它——Video Prompt 的编译器不读，所以不提供那个选项。</div>`
          : "") +
        `<div class="sr-mhd">资产</div>` +
        `<button data-sr-replace="${esc(r.key)}">更换资产（上传新版本）</button>` +
        `<button data-sr-view="${esc(r.key)}">查看资产</button>` +
        `<button class="bad" data-sr-unbind="${esc(r.key)}">解除关联</button>` +
        `</div>`
      : "") +
    `</li>`
  );
}

/** The 「+ 添加参考」 popover: from the library, or a fresh upload (§6). */
function addMenu(group, open, library) {
  if (!open) return "";
  return (
    `<div class="sr-menu add">` +
    `<div class="sr-mhd">从已有参考素材添加</div>` +
    (library.length
      ? library.slice(0, 8).map((r) =>
          `<button data-sr-add="${esc(r.key)}" data-group="${esc(group)}">` +
          `${esc(r.name)} <span class="note">${esc(ROLE_LABEL[r.kind] || r.kind || "")}</span></button>`).join("")
        + (library.length > 8
          ? `<div class="sr-mnote">还有 ${library.length - 8} 个——用下方「参考素材库」搜索。</div>`
          : "")
      : `<div class="sr-mnote">资产库里没有这一组可用的参考了。用下面的「上传」或到「资产库」补。</div>`) +
    `<div class="sr-mhd">新增 / 上传</div>` +
    GROUP_ROLES[group].map((role) => {
      const kinds = domainsForKind(role).map((d) => ZH_DOMAIN[d] || d).join("/");
      // the button SAYS what it accepts — a control offering 「运动参考」 that only
      // takes a png is a control that lies about itself
      return `<button data-sr-upload="${esc(role)}" data-group="${esc(group)}">` +
        `上传${esc(ROLE_LABEL[role] || role)} <span class="note">${esc(kinds)}</span></button>`;
    }).join("") +
    `<div class="sr-mnote">上传即登记：落盘的同一次调用里声明它是什么、属于谁，绝不产生孤立媒体。</div>` +
    `</div>`
  );
}

/**
 * The column.
 *
 * `m` carries `{ groups, library, frames }` resolved by the shell so this and the
 * centre read the SAME derivation of what the shot references.
 */
export function renderShotRefs(ctx, ui, m) {
  if (!m || m.empty) {
    return (
      `<aside class="sr"><div class="sr-hd"><b>当前 Shot 参考输入</b></div>` +
      `<div class="sr-none">先在上面选一个镜头，这里会显示它引用的视觉资产。</div></aside>`
    );
  }
  const group = (key, label, hint) => {
    const rows = m.groups[key] || [];
    const lib = (m.library[key] || []);
    return (
      `<section class="sr-grp">` +
      `<header><b>${esc(label)}</b>` +
      `<span class="sr-i" title="${esc(hint)}">ⓘ</span>` +
      `<span class="sr-n">${rows.length}</span>` +
      `<span class="push"></span>` +
      `<button class="btn sm" data-sr-addopen="${esc(key)}">＋ 添加参考</button></header>` +
      (rows.length
        ? `<ul class="sr-list">${rows.map((r) => card(r, key, ui.srMenu)).join("")}</ul>`
        : `<div class="sr-none">${key === "image"
          ? "还没有主要画面参考——一致性会明显不稳。"
          : "还没有视频编排参考——这一镜的运镜与表演只能靠镜头设计的文字。"}</div>`) +
      (ui.srAdd === key ? addMenu(key, true, lib) : "") +
      `</section>`
    );
  };
  // The FRAME rows are inputs too, and they belong to 主要画面参考 as continuity —
  // but they are bound and re-extracted from the VIDEO card (§13), so they are
  // read-only here rather than offering the same action a second time.
  const frameRow = (f, label) =>
    `<li class="sr-card frame">` +
    (f && f.url ? `<img class="sr-th" src="${esc(f.url)}" alt="" loading="lazy">` : `<span class="sr-th none">⃠</span>`) +
    `<span class="sr-meta static"><b>${esc(label)}</b>` +
    `<span class="sr-sub">${f ? esc(f.from || "已绑定") : "还没有"}</span></span>` +
    (f && f.drift
      ? `<span class="chip gate" title="${esc(f.drift)}">上游已更新</span>`
      : "") +
    `<button class="sr-dots" data-sr-frames title="在中央的视频卡片里处理">›</button>` +
    `</li>`;
  return (
    `<aside class="sr">` +
    `<div class="sr-hd"><b>当前 Shot 参考输入</b><span class="push"></span>` +
    `<button class="btn sm" data-sr-ai title="让 AI 导演找出可复用的参考并给出建议">⊙ AI 推荐</button></div>` +
    group(...GROUPS[0]) +
    `<section class="sr-grp"><header><b>连续性帧</b>` +
    `<span class="sr-i" title="上一镜的尾帧接成这一镜的首帧；来源 pin 到具体视频版本">ⓘ</span></header>` +
    `<ul class="sr-list">${frameRow(m.frames.start, "首帧 Start Frame")}${frameRow(m.frames.end, "尾帧 End Frame（可选）")}</ul>` +
    `</section>` +
    group(...GROUPS[1]) +
    `</aside>`
  );
}

/** Bind the column. Every write goes through an existing controller. */
export function bindShotRefs(root, ctx, ui, render, { shotId, onOpenNode } = {}) {
  const all = (q, fn) =>
    root.querySelectorAll(q).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el, ev); }));

  all("[data-sr-menu]", (el) => {
    ui.srMenu = ui.srMenu === el.dataset.srMenu ? null : el.dataset.srMenu;
    ui.srAdd = null;
    render();
  });
  all("[data-sr-addopen]", (el) => {
    ui.srAdd = ui.srAdd === el.dataset.srAddopen ? null : el.dataset.srAddopen;
    ui.srMenu = null;
    render();
  });

  // --- relation control (§5) ------------------------------------------------ //
  all("[data-sr-use]", (el) => {
    const res = ctx.actions.dispatch({
      action: "setReferenceUse",
      shotId,
      referenceKey: el.dataset.srUse,
      use: el.dataset.use,
    });
    ui.srMenu = null;
    // `satisfied` means it already served that side — the requested end state, not a
    // failure, so it is not reported as one
    if (!res.ok && !res.satisfied) ctx.toast(res.error);
    else if (res.ok) ctx.toast(`已改为「${res.detail}」——中央的关系图和 Prompt 一起跟着变了`);
    render();
  });

  // --- asset operations ----------------------------------------------------- //
  all("[data-sr-replace]", async (el) => {
    ui.srMenu = null;
    try {
      await ctx.assets.uploadReferenceVersion(el.dataset.srReplace);
    } catch (e) {
      ctx.toast(`上传新版本失败：${e.message}`);
    }
    render();
  });
  all("[data-sr-view]", (el) => {
    ui.srMenu = null;
    // 查看资产 opens the reference on the CENTRE graph, which is where its detail and
    // its versions live now — not a second panel here (§10)
    if (onOpenNode) onOpenNode({ type: "reference", refKey: el.dataset.srView });
    render();
  });
  all("[data-sr-unbind]", (el) => {
    ui.srMenu = null;
    if (!ctx.shot.removeReference(shotId, el.dataset.srUnbind)) ctx.toast("无法解除这个关联");
    render();
  });

  // --- adding (§6) ---------------------------------------------------------- //
  all("[data-sr-add]", (el) => {
    ui.srAdd = null;
    if (!ctx.shot.addReference(shotId, el.dataset.srAdd)) ctx.toast("这个参考已经绑在这一镜上了");
    render();
  });
  all("[data-sr-upload]", async (el) => {
    const role = el.dataset.srUpload;
    ui.srAdd = null;
    // ONE upload path (ADR-0055): register + bind in the same call, never a file on
    // disk without a declaration.
    const key = await ctx.episode.uploadReference(shotId, role);
    if (key) ctx.toast("已登记并绑到这一镜——它同时进了资产库，其它镜头也能搜到复用");
    render();
  });

  all("[data-sr-frames]", () => {
    if (onOpenNode) onOpenNode({ type: "video" });
  });
  all("[data-sr-ai]", async (el) => {
    // AI PROPOSES (TASK-067 §4). This really RUNS the Shot Asset Recommender against
    // this shot: `shotctx.candidatesFor` retrieves real candidates out of the
    // registry, the capability ranks and justifies among them, and the answer lands
    // as a proposal in the right column. Applying it is a separate, explicit
    // decision — nothing is bound here.
    //
    // Before this round the button only SELECTED `reference-planner` in the capability
    // catalog and told the creator to press run themselves, on an episode-wide skill
    // that addressed references by key with no assetId.
    if (!shotId) { ctx.toast("先选一个镜头"); return; }
    el.disabled = true;
    const res = await runOperation(ctx, ui, "recommend", shotId);
    el.disabled = false;
    if (!res.ok) ctx.toast(`推荐失败：${res.error}`);
    else if (res.manual) ctx.toast("已建立运行记录——在右侧「AI 导演」复制任务 Prompt，跑完把结果粘回来");
    else ctx.toast("推荐已生成——在右侧「AI 导演」里逐条接受 / 替换 / 忽略");
    render();
  });
}
