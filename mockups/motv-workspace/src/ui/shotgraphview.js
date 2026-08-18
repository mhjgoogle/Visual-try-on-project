// CENTER of 剧集制作 — SH0x 制作流程图 (TASK-066 §8 / §9 / §10).
//
//   SH05 制作流程图 ⓘ                 ⊙ 自动布局 | 手动布局      ⛶ 全屏
//   ┌ 参考输入 ─────┐
//   │ ▢ ▢ ▢ ▢ ▢     │──→ [Image Prompt v2] ──→ [主帧图 v3 当前选定] ──┐
//   └───────────────┘                                                ↓
//                    [视频编排参考] ──────────────→ [Video Prompt v2] ──→ [最终视频 v2]
//                                                                        ↓
//                                                            [End Frame（可选）]
//
// THE CARDS CARRY THEIR OWN ACTIONS (§10). Clicking one does NOT open a large
// Inspector any more — 上传 / 自动生成 / 修改 sit on the card, and 历史 is a secondary
// entry. Three reasons that is the right shape here: the actions are the same three on
// every card, they act on the thing the creator is already looking at, and a panel
// that opens elsewhere makes 「点了之后去哪看结果」 a question at all.
//
// 自动生成 IS HONEST ABOUT WHAT EXISTS (§11). On a PROMPT card it really runs the
// Prompt Director skill — that capability is wired and produces a proposal. On the
// 主帧图 / 最终视频 cards there is NO media provider connected, so the button says so
// and hands over the route that does work: copy the Prompt + references, generate
// outside, upload back. A button that pretended to generate would be the worst kind of
// lie this codebase can tell, because the creator would wait for something that is
// never coming.
//
// EDGES ARE MEASURED FROM REAL GEOMETRY after layout, so the crossing links land where
// the cards actually are. Nothing is drawn for a link the model does not hold.
//
// PURE PRESENTATION over `ctx.shotgraph.model(shotId)`.

import { esc } from "../util/dom.js";
import { BANDS, inspectFromShotNode } from "../workflow/shotgraph.js";

const BAND_HINT = Object.fromEntries(BANDS.map(([k, , hint]) => [k, hint]));
const BAND_LABEL = Object.fromEntries(BANDS.map(([k, label]) => [k, label]));

/** The bands drawn as ONE clustered box rather than a row of peer cards — the
 *  reference inputs, which the mockup groups behind a dashed frame because they are
 *  one thing ("what this shot is made of") rather than several stages. */
const CLUSTERED = new Set(["refs", "directing"]);

/** The three actions every media card offers, in one order everywhere (§10). */
const MEDIA_ACTS = [
  ["upload", "上传新版"],
  ["generate", "自动生成"],
  ["edit", "修改"],
];

function media(n) {
  if (n.type === "video" && n.url) {
    return `<video class="sg-shot" src="${esc(n.url)}" preload="metadata" controls playsinline></video>`;
  }
  if (n.url) return `<img class="sg-shot" src="${esc(n.url)}" alt="" loading="lazy">`;
  return `<div class="sg-shot none"><span>${n.type === "video" ? "▶" : "🖼"}</span>` +
    `<span class="t">${esc(n.state === "gap" ? "还没有" : "无预览")}</span></div>`;
}

/** A version chip: `v3 当前选定`. The word 选定 is deliberate — it is the creator's
 *  choice, not a system state. */
function versionChip(n) {
  if (n.version == null) return `<span class="chip mute">还没有版本</span>`;
  return `<span class="chip ok">v${esc(String(n.version))} 当前选定</span>`;
}

/** One PROMPT card. Its action is 查看 / 修改 — the text itself is the subject, so it
 *  is shown inline (truncated) rather than behind a click. */
function promptCard(n, open) {
  return (
    `<div class="sg-card sg-prompt st-${esc(n.state)}" data-node="${esc(n.id)}">` +
    `<header><b>${esc(n.title)}</b>` +
    (n.version ? `<span class="chip">v${esc(String(n.version))}</span>` : `<span class="chip mute">自动编译</span>`) +
    `<span class="push"></span>` +
    `<button class="sg-dots" data-sg-menu="${esc(n.id)}" title="更多">⋮</button></header>` +
    `<p class="sg-ptext">${esc(n.preview || "还没有内容")}</p>` +
    (n.missing && n.missing.length
      ? `<div class="sg-miss" title="${esc(n.missing.join("；"))}">${n.missing.length} 项还缺</div>`
      : "") +
    `<div class="sg-acts">` +
    `<button class="btn sm" data-sg-act="view" data-id="${esc(n.id)}">查看 / 修改</button>` +
    `<button class="btn sm" data-sg-act="generate" data-id="${esc(n.id)}" title="让 Prompt Director 重写一版（提案，你确认才生效）">自动生成</button>` +
    `<button class="btn sm" data-sg-act="copy" data-id="${esc(n.id)}">复制</button>` +
    `</div>` +
    (open ? menu(n, [["history", "历史版本"], ["provenance", "在完整溯源里查看"]]) : "") +
    `</div>`
  );
}

/** One MEDIA card (主帧图 / 最终视频). Shows the SELECTED version; history is
 *  secondary (§10). */
function mediaCard(n, open) {
  return (
    `<div class="sg-card sg-media sg-${esc(n.type)} st-${esc(n.state)}" data-node="${esc(n.id)}">` +
    `<header><b>${esc(n.title)}</b>${versionChip(n)}` +
    `<span class="push"></span>` +
    `<button class="sg-dots" data-sg-menu="${esc(n.id)}" title="更多">⋮</button></header>` +
    media(n) +
    (n.failed
      ? `<div class="sg-miss">上一次生成失败（${esc(n.lastStatus || "")}）</div>`
      : "") +
    (n.type === "video" && n.sourceImageVersion != null
      ? `<div class="sg-meta">来自主帧图 v${esc(String(n.sourceImageVersion))}</div>`
      : n.type === "video" && n.version != null
        ? `<div class="sg-meta">没有生成记录说明它的源画面（这是一次导入）</div>`
        : "") +
    `<div class="sg-acts">` +
    MEDIA_ACTS.map(([act, label]) =>
      `<button class="btn sm${act === "upload" ? " primary" : ""}" data-sg-act="${esc(act)}" data-id="${esc(n.id)}">` +
      `${esc(label)}</button>`).join("") +
    `</div>` +
    (n.versions > 1
      ? `<button class="sg-hist" data-sg-act="history" data-id="${esc(n.id)}">历史版本（${n.versions}）›</button>`
      : "") +
    (open
      ? menu(n, [
          ...(n.versions > 1 ? [["history", `历史版本（${n.versions}）`]] : []),
          ...(n.type === "video" ? [["extract", "提取尾帧 → 下一镜首帧"]] : []),
          ["provenance", "在完整溯源里查看"],
        ])
      : "") +
    `</div>`
  );
}

/** The optional END FRAME card — produced FROM the final video, for the next shot. */
function endCard(n) {
  return (
    `<div class="sg-card sg-end st-${esc(n.state)}" data-node="${esc(n.id)}">` +
    `<header><b>${esc(n.title)}</b><span class="push"></span></header>` +
    (n.url ? `<img class="sg-shot sm" src="${esc(n.url)}" alt="" loading="lazy">` : `<div class="sg-shot sm none"><span>⇥</span></div>`) +
    `<div class="sg-meta">${esc(n.sub || "")}</div>` +
    `<div class="sg-acts">` +
    `<button class="btn sm" data-sg-act="extract" data-id="${esc(n.id)}">提取尾帧</button>` +
    (n.nextShot
      ? `<button class="btn sm primary" data-sg-act="extractbind" data-id="${esc(n.id)}" ` +
        `title="提取并设为「${esc(n.nextShot.title || "")}」的首帧">→ 接给下一镜</button>`
      : `<span class="sg-meta">这个场景里没有下一个镜头</span>`) +
    `</div></div>`
  );
}

/** A card's `⋮` menu. Rendered only while open, so a stale menu can never point at a
 *  card whose object has moved. */
function menu(n, items) {
  return (
    `<div class="sg-menu">` +
    items.map(([act, label]) =>
      `<button data-sg-act="${esc(act)}" data-id="${esc(n.id)}">${esc(label)}</button>`).join("") +
    `</div>`
  );
}

/** A reference thumbnail inside a cluster. */
function refThumb(n, selectedId) {
  const inner = !n.url || (n.storageState && n.storageState !== "local")
    ? `<span class="sg-rt none" title="字节不在本地">⃠</span>`
    : n.domain === "videos"
      ? `<video class="sg-rt" src="${esc(n.url)}" preload="metadata" muted playsinline></video>`
      : `<img class="sg-rt" src="${esc(n.url)}" alt="" loading="lazy">`;
  return (
    `<button class="sg-ref${n.id === selectedId ? " sel" : ""}${n.state === "partial" ? " partial" : ""}" ` +
    `data-node="${esc(n.id)}" data-sg-node="${esc(n.id)}" ` +
    `title="${esc(n.title)} · ${esc(n.sub || "")}${n.state === "partial" ? "（还没有被解读）" : ""}">` +
    inner + `<span class="nm">${esc(n.title)}</span></button>`
  );
}

/** A clustered band — the dashed 参考输入 / 视频编排参考 boxes. */
function cluster(b, selectedId) {
  return (
    `<section class="sg-cluster sg-band-${esc(b.key)}" data-node="cluster:${esc(b.key)}">` +
    `<header><span class="sg-bandl">${esc(b.label)}</span>` +
    `<span class="sg-i" title="${esc(BAND_HINT[b.key] || "")}">ⓘ</span>` +
    `<span class="sg-n">${b.nodes.length}</span></header>` +
    (b.nodes.length
      ? `<div class="sg-refs">${b.nodes.map((n) => refThumb(n, selectedId)).join("")}</div>`
      : `<div class="sg-empty">${esc(b.key === "refs"
        ? "还没有主要画面参考 —— 在左栏「+ 添加参考」，或用下面的素材库搜"
        : "还没有视频编排参考 —— 运镜 / 动作 / 表演只能靠镜头设计的文字")}</div>`) +
    `</section>`
  );
}

/** The stage locator (§9) — 「告诉用户当前做到哪里」, NOT four pages. */
export function renderStages(g, active) {
  const steps = g.stages || [];
  return (
    `<div class="sg-stages">` +
    steps.map((st, i) =>
      `<button class="sg-stage${st.key === active ? " on" : ""} st-${esc(st.state)}" data-sg-stage="${esc(st.key)}">` +
      `<span class="n">${i + 1}</span>${esc(st.label)}` +
      `<span class="mk">${st.state === "done" ? "✓" : st.state === "doing" ? "◐" : "○"}</span>` +
      `</button>`).join(`<span class="sg-steplink"></span>`) +
    `</div>`
  );
}

/**
 * The centre body for one shot.
 *
 * `selectedId` is the card the creator last opened, so the picture and any open menu
 * agree about what is current.
 */
/**
 * 「＋ 添加」 — TASK-093 §2.3, and the place its first discipline becomes visible.
 *
 * Unavailable kinds are GREYED WITH THEIR REASON, never hidden (TASK-079 §1.2). The
 * creator has seen LibTV's nine-item menu and will come looking for 文本便签 /
 * 逐帧拉片 / 3D 导演台; a menu that silently lacks them reads as a bug, while one that
 * says WHY reads as a decision. And the reason for 文本便签 is the load-bearing one:
 * it has no registry, so adding it would create the 360–720 documents 「一个 shot 一个
 * 画布是不是有点奢侈了」 was worried about.
 */
export function renderAddMenu(items, { open = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const can = list.filter((it) => it.available);
  const cannot = list.filter((it) => !it.available);
  const rows = can.map((it) =>
    `<button class="sg-add-item" data-sg-add="${esc(it.id)}" title="${esc(it.detail || "")}">` +
    `<span class="ic">${esc(it.icon || "＋")}</span><b>${esc(it.label)}</b>` +
    `<span class="sg-add-reg">→ ${esc(it.registry)}</span></button>`).join("");
  // THE UNAVAILABLE ONES ARE COLLAPSED, NOT HIDDEN. Their count is always on screen
  // and one click shows every reason in full. Rendering all eight expanded pushed the
  // graph itself off the bottom of the column on the real project — a menu that buries
  // the thing it acts on is worse than the menu not being there (TASK-097 §2.6.4).
  const why = cannot.map((it) =>
    `<span class="sg-add-item off" title="${esc(it.why || "")}">` +
    `<span class="ic">${esc(it.icon || "＋")}</span><b>${esc(it.label)}</b>` +
    `<span class="sg-add-why">${esc(it.why || "")}</span></span>`).join("");
  return (
    `<div class="sg-add"><header><b>＋ 添加到这块画布</b>` +
    `<span class="meta">每一项都写回一张<b>既有</b>登记表 —— 画布本身没有文档，不用起名、不用维护</span>` +
    `</header><div class="sg-add-list">${rows}</div>` +
    (cannot.length
      ? `<details class="sg-add-off"${open ? " open" : ""}>` +
        `<summary>${cannot.length} 项本产品不提供 · 点开看原因</summary>` +
        `<div class="sg-add-list">${why}</div></details>`
      : "") +
    `</div>`
  );
}

/** 「以此生成 →」 for one node (TASK-093 §2.2 / GAP-19).
 *
 *  An unavailable target states its reason inline rather than disappearing, and the
 *  available ones say what they carry over — a chain action that lands on a blank
 *  form has thrown away the context that made it worth offering. */
export function renderChainMenu(targets) {
  const rows = (Array.isArray(targets) ? targets : []).map((t) => (t.available
    ? `<button class="sg-chain-item" data-sg-chain="${esc(t.id)}">` +
      `<span class="ic">${esc(t.icon || "→")}</span><b>${esc(t.label)}</b>` +
      (t.prefill
        ? `<span class="sg-chain-pre">带过去：${esc(Object.keys(t.prefill).join(" · "))}</span>`
        : "") +
      `</button>`
    : `<span class="sg-chain-item off"><span class="ic">${esc(t.icon || "→")}</span>` +
      `<b>${esc(t.label)}</b><span class="sg-chain-why">${esc(t.why || "")}</span></span>`)).join("");
  return `<div class="sg-chain"><header><b>以此生成 →</b></header>${rows}</div>`;
}

/** TASK-092 的六个 stage，画在画布上 —— 那是它们最自然的显示面（TASK-093 §3 项 4）。
 *
 *  「跳过」与「还没开始」用不同的字，因为它们是不同的事实：前者是他决定不做，
 *  后者是还没做。这正是 `skipped` 成为一等状态的全部理由。 */
export function renderStageChips(board) {
  const keys = board ? Object.keys(board) : [];
  if (!keys.length) return "";
  return (
    // `sg-stagechips`, NOT `sg-stages`: the four-step locator (`renderStages` above)
    // already owns `.sg-stages` / `.sg-stage`, so reusing them would have every CSS
    // rule for one silently restyle the other. Found by querying the real DOM rather
    // than by reading the diff -- both selectors came back holding both widgets.
    `<div class="sg-stagechips"><span class="lab">这一镜各环节</span>` +
    keys.map((k) => {
      const s = board[k];
      const cls = s.status === "completed" ? "ok"
        : s.status === "skipped" ? "skip"
        : s.status === "in_progress" ? "run" : "todo";
      const gate = s.ok ? "" : ` · 待前置`;
      return `<span class="chip sg-stagechip ${cls}" title="${esc(s.ok ? "可以开工" : (s.blockers[0] || ""))}">` +
        `${esc(s.label)}：${esc(s.statusLabel)}${esc(gate)}</span>`;
    }).join("") +
    `</div>`
  );
}

/** 参考区的五个一级分类，并**逐条**如实标注「进不进模型」（TASK-093 §2.5）。
 *
 *  合并的是归类，不是那个事实：`style` 的图进模型，`video-style` / `motion` /
 *  `camera` / `performance` 的不进 —— 显示在同一组里而说同一句话，就是把
 *  TASK-077 §1.3 修掉的那个谎换个标题装回来。 */
export function renderReferenceArea(area, categories) {
  const groups = (Array.isArray(categories) ? categories : []).map(([id, label]) => {
    const items = (area && area.groups && area.groups.get(id)) || [];
    if (!items.length) return "";
    return (
      `<div class="sg-refcat"><header><b>${esc(label)}</b><span class="sg-n">${items.length}</span></header>` +
      items.map((r) =>
        `<span class="sg-refrow" title="${esc(r.name || "")}">` +
        `<b>${esc(r.name || "未命名")}</b>` +
        `<span class="sg-reach sg-reach-${esc(r.reach)}">${esc(r.reachLabel)}</span></span>`).join("") +
      `</div>`
    );
  }).join("");
  const stray = area && area.unclassified && area.unclassified.length
    ? `<div class="sg-refcat off"><header><b>归不到分类</b>` +
      `<span class="sg-n">${area.unclassified.length}</span></header>` +
      `<span class="meta">这些参考的 kind 不在五个一级分类里 —— 报出来而不是丢掉，` +
      `因为一个悄悄消失的绑定就是一张创作者以为在用的图。</span></div>`
    : "";
  return groups || stray
    ? `<div class="sg-refarea">${groups}${stray}</div>`
    : "";
}

/**
 * 运镜预设 (ADR-0075) —— 实测依据是 `cameraMotion` 填充率 **0/60**。
 *
 * 菜单先说清点下去会发生什么（新写 / 追加），因为那是两件不同的事，而创作者有权
 * 在点之前知道。ADR-0075 决策 4：已有内容默认**追加**，替换要显式选。
 */
export function renderCameraPresets(menu) {
  if (!menu) return "";
  return (
    `<div class="sg-presets"><header><b>🎥 运镜预设</b>` +
    `<span class="meta">${esc(menu.note)}</span></header>` +
    `<div class="sg-preset-list">` +
    menu.presets.map((p) =>
      `<button class="sg-preset" data-sg-preset="${esc(p.id)}" title="${esc(p.text)}">` +
      `${esc(p.label)}</button>`).join("") +
    `</div></div>`
  );
}

export function renderShotGraph(g, { selectedId = null, layout = "auto", menuOpen = null } = {}) {
  if (!g || g.empty) {
    return (
      `<div class="sg-root"><div class="st-empty"><div class="ic">🎞</div>` +
      `<div class="tt">先选一个镜头</div>` +
      `<div class="hh">上面选 Episode / Scene / Shot，这里就会显示「这一镜怎么被做出来」。</div></div></div>`
    );
  }
  const byKey = Object.fromEntries(g.bands.map((b) => [b.key, b]));
  const one = (key) => (byKey[key] && byKey[key].nodes[0]) || null;
  const card = (n) => {
    if (!n) return "";
    const open = menuOpen === n.id;
    if (n.type === "prompt") return promptCard(n, open);
    if (n.type === "endFrame") return endCard(n);
    return mediaCard(n, open);
  };
  return (
    `<div class="sg-root layout-${esc(layout)}">` +
    `<div class="sg-flow" data-sg-edges="1">` +
    `<svg class="sg-wires" aria-hidden="true"></svg>` +
    `<div class="sg-col left">` +
    cluster(byKey.refs, selectedId) +
    cluster(byKey.directing, selectedId) +
    `</div>` +
    `<div class="sg-col chain">` +
    card(one("imagePrompt")) +
    card(one("image")) +
    card(one("videoPrompt")) +
    card(one("video")) +
    card(one("endFrame")) +
    `</div>` +
    `</div>` +
    `<div class="meta sg-legend">这不是四列流水线：风格参考同时进两个 Prompt，最终视频指向它<b>真正</b>` +
    `来自的那一版主帧图，首帧可能来自<b>上一镜</b>。线画的是记录里真实存在的关系 —— 没有记录就没有线。</div>` +
    `</div>`
  );
}

/** Draw the wires after layout. Measured, so crossing edges land on the real cards. */
export function drawShotEdges(root, g) {
  if (!g || g.empty) return;
  const box = root.querySelector(".sg-flow[data-sg-edges]");
  if (!box) return;
  const svg = box.querySelector(".sg-wires");
  if (!svg) return;
  const base = box.getBoundingClientRect();
  const w = Math.max(1, box.scrollWidth);
  const h = Math.max(1, box.scrollHeight);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  const at = (id) => {
    const el = box.querySelector(`[data-node="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      cx: r.left - base.left + r.width / 2,
      cy: r.top - base.top + r.height / 2,
      left: r.left - base.left,
      right: r.right - base.left,
      top: r.top - base.top,
      bottom: r.top - base.top + r.height,
    };
  };
  // A reference's edge is drawn from its CLUSTER, not from each thumbnail: forty
  // hair-thin lines out of one box is noise, and the model's per-reference edges all
  // land on the same target anyway. The cluster edge is the honest summary of them.
  const anchorFor = (id) => {
    const n = g.nodes.find((x) => x.id === id);
    if (n && (n.band === "refs" || n.band === "directing")) return `cluster:${n.band}`;
    return id;
  };
  const seen = new Set();
  const parts = [];
  for (const e of g.edges) {
    const from = anchorFor(e.from);
    const to = anchorFor(e.to);
    if (from === to) continue;
    const sig = `${from}>${to}>${e.kind}`;
    if (seen.has(sig)) continue; // one line per real relation, not per reference
    seen.add(sig);
    const a = at(from);
    const b = at(to);
    if (!a || !b) continue;
    let d;
    if (b.top > a.bottom) {
      const dy = Math.max(14, (b.top - a.bottom) * 0.6);
      d = `M${a.cx} ${a.bottom} C${a.cx} ${a.bottom + dy} ${b.cx} ${b.top - dy} ${b.cx} ${b.top}`;
    } else if (a.right < b.left) {
      // side by side — the reference clusters feeding the chain column
      const dx = Math.max(14, (b.left - a.right) * 0.55);
      d = `M${a.right} ${a.cy} C${a.right + dx} ${a.cy} ${b.left - dx} ${b.cy} ${b.left} ${b.cy}`;
    } else if (b.bottom <= a.top) {
      // A BACK EDGE — the target is above. It is a real recorded dependency (a
      // directing reference also feeds the IMAGE prompt), so it is routed around the
      // gutter rather than dropped: an edge the layout cannot express straight is
      // still an input, and hiding it would make the picture claim fewer inputs than
      // the records hold.
      const g2 = Math.max(6, Math.min(a.left, b.left) - 22);
      d = `M${a.left} ${a.cy} C${g2} ${a.cy} ${g2} ${b.cy} ${b.left} ${b.cy}`;
    } else {
      continue; // overlapping: no direction a line could honestly express
    }
    parts.push(`<path d="${d}" class="sg-wire w-${esc(e.kind)}${b.bottom <= a.top ? " back" : ""}"/>`);
  }
  svg.innerHTML = parts.join("");
}

/**
 * Bind the centre.
 *
 * `onAct(action, node)` receives every card action — the SHELL performs it, because
 * uploading, generating and editing all go through controllers this module must not
 * reach for. `onOpen(node)` is a plain selection (a reference thumbnail).
 */
export function bindShotGraph(root, g, {
  onAct, onOpen, onMenu, onStage, onAdd, onChain, onPreset,
} = {}) {
  // BIND THE CANVAS CONTROLS BEFORE THE EMPTY-GRAPH RETURN (codex 轮 3, P1). They do
  // not depend on the node list, so an early return left any that DID render without
  // handlers. The render site also gates them on having a shot, and this is the second
  // half of that fix: neither half alone stops a clickable-but-inert control.
  bindCanvasControls(root, { onAdd, onChain, onPreset });
  if (!g || g.empty) return;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  root.querySelectorAll("[data-sg-node]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    const n = byId.get(el.dataset.sgNode);
    if (n && onOpen) onOpen(n);
  }));
  root.querySelectorAll("[data-sg-menu]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onMenu) onMenu(el.dataset.sgMenu);
  }));
  root.querySelectorAll("[data-sg-act]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    const n = byId.get(el.dataset.id);
    if (n && onAct) onAct(el.dataset.sgAct, n);
  }));
  root.querySelectorAll("[data-sg-stage]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onStage) onStage(el.dataset.sgStage);
  }));
}

/** TASK-093 批次 3 的三条新交互。Separate from the node bindings because they do NOT
 *  depend on the node list — a control that renders and does nothing is the same
 *  defect as a module with no caller, and batch 2 shipped that once already
 *  (TASK-097 §2.5c). */
function bindCanvasControls(root, { onAdd, onChain, onPreset } = {}) {
  root.querySelectorAll("[data-sg-add]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onAdd) onAdd(el.dataset.sgAdd);
  }));
  root.querySelectorAll("[data-sg-chain]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onChain) onChain(el.dataset.sgChain);
  }));
  root.querySelectorAll("[data-sg-preset]").forEach((el) => (el.onclick = (ev) => {
    ev.stopPropagation();
    if (onPreset) onPreset(el.dataset.sgPreset);
  }));
}

export { BAND_LABEL, BAND_HINT };
