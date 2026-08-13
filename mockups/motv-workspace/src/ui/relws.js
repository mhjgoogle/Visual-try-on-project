// 人物关系 — the relationship GRAPH (TASK-065 §2), now a TAB inside the 人物
// workspace rather than a top-level rail item.
//
// WHY IT MOVED. 人物 and 人物关系 are one subject: a relationship connects two
// characters and has no meaning without them, and a creator who wants to change how
// 林照 sees 沈既白 was being asked to leave the person they were looking at. Two rail
// entries for one subject is exactly the 「少入口」 rule this round is about.
//
// WHY IT IS A GRAPH. A relationship is already a first-class object with eleven
// facets (ADR-0054 决策 3), and eleven text fields per pair read as a form. A form
// cannot answer 「谁跟谁是对立的」 at a glance; a picture can. The eleven facets did
// not go anywhere — they are the detail panel behind a click on an edge.
//
// FOUR THINGS ON THE PICTURE (§2): 关系类型 / 方向 / 情绪·冲突 / 当前关系. Where each
// comes from is documented in workflow/relgraph.js, which owns the derivation and
// the layout; this file only draws it.
//
// NODES ARE REAL CHARACTERS. Every node carries a characterId and resolves its name
// and portrait from the bible on each render — no profile is copied here.
//
// AI ONLY PROPOSES (§2 的硬约束). The 「让 AI 读一遍剧本」 button opens the
// Relationship Director in the right-hand AI Director; its answer is a Proposal the
// creator accepts or ignores. Nothing on this screen writes canon without a click.
//
// PURE PRESENTATION over ctx.relgraph / ctx.canon.

import { esc } from "../util/dom.js";
import { RELATIONSHIP_FIELDS } from "../workflow/canondoc.js";
import { empty } from "./shell.js";
import { bindField, restoreFieldFocus } from "./fieldsync.js";

/** The definition facets, grouped the way a writer reads a relationship. */
const FACETS = [
  ["basis", "关系类型 / 基础关系", "如：曾经的搭档，现在的对手", 2],
  ["coreConflict", "核心矛盾", "两人之间无法轻易化解的东西", 2],
  ["tension", "情感张力", "吸引 / 忌惮 / 未说出口的东西", 2],
  ["aToB", "A 怎么看 B", "", 2],
  ["bToA", "B 怎么看 A", "", 2],
  ["power", "权力关系", "谁掌握什么，谁有求于谁", 2],
  ["history", "共同历史", "在故事开始之前发生过什么", 2],
  ["secrets", "隐藏信息 / 秘密", "谁瞒着谁什么，何时可能揭穿", 2],
  ["direction", "长期发展方向", "整部作品里这段关系走向哪里", 2],
  ["arc", "Relationship Arc", "如：戒备 → 合作 → 信任 → 决裂 → 再选择", 2],
  ["forbidden", "不应发生的关系偏离", "越界即 OOC 的地方（AI 与后续集数的红线）", 2],
];

/** Edge thickness / colour class from the conflict weight. A pair with nothing
 *  written scores 0 and is drawn as the quiet line it is — the graph never invents
 *  a conflict to make itself look busy. */
function heatClass(w) {
  if (w >= 3) return "hot";
  if (w >= 1) return "warm";
  return "cool";
}

/** One character node. A node with no portrait draws its initial rather than a
 *  broken image or a stock avatar. */
function nodeSvg(n, radius, selected, i) {
  // The clip id comes from the node's INDEX, not from a sanitized characterId.
  // Stripping punctuation out of an arbitrary id is not injective — `a:b` and `ab`
  // produce the same id — and two nodes sharing one clipPath means one portrait is
  // clipped by the OTHER node's circle, i.e. drawn in the wrong place
  // (codex review round 4). The index is unique within this SVG by construction.
  const clip = `rp-${i}`;
  const body = n.url
    ? `<clipPath id="${esc(clip)}"><circle cx="${n.x}" cy="${n.y}" r="${radius}"/></clipPath>` +
      `<image href="${esc(n.url)}" x="${n.x - radius}" y="${n.y - radius}" ` +
      `width="${radius * 2}" height="${radius * 2}" preserveAspectRatio="xMidYMid slice" ` +
      `clip-path="url(#${esc(clip)})"/>`
    : `<circle class="rg-blank" cx="${n.x}" cy="${n.y}" r="${radius}"/>` +
      `<text class="rg-initial" x="${n.x}" y="${n.y + 8}" text-anchor="middle">${esc(n.initial)}</text>`;
  return (
    `<g class="rg-node${selected ? " sel" : ""}${n.tier === "bit" ? " bit" : ""}" data-rg-node="${esc(n.characterId)}">` +
    body +
    `<circle class="rg-ring" cx="${n.x}" cy="${n.y}" r="${radius}"/>` +
    `<text class="rg-name" x="${n.x}" y="${n.y + radius + 18}" text-anchor="middle">${esc(n.name)}</text>` +
    (n.tier === "bit"
      ? `<text class="rg-tier" x="${n.x}" y="${n.y + radius + 32}" text-anchor="middle">临时</text>`
      : "") +
    `</g>`
  );
}

/** One relationship edge: an ARROW A→B, a type label, and 当前关系 under it. */
function edgeSvg(e, selected) {
  const type = e.type || "未写关系类型";
  const cur = e.current ? `${e.current.code} · ${e.current.text}` : "";
  return (
    `<g class="rg-edge ${heatClass(e.weight)}${selected ? " sel" : ""}" data-rg-edge="${esc(e.relationshipId)}">` +
    `<line class="rg-hit" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}"/>` +
    `<line class="rg-line" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" marker-end="url(#rg-arrow)"/>` +
    `<g class="rg-lab" transform="translate(${e.label.x},${e.label.y})">` +
    `<text class="rg-type" text-anchor="middle" y="0">${esc(type.length > 18 ? `${type.slice(0, 17)}…` : type)}</text>` +
    (e.conflict
      ? `<text class="rg-conf" text-anchor="middle" y="15">⚡ ${esc(e.conflict.length > 20 ? `${e.conflict.slice(0, 19)}…` : e.conflict)}</text>`
      : "") +
    (cur
      ? `<text class="rg-cur" text-anchor="middle" y="${e.conflict ? 29 : 15}">${esc(cur.length > 26 ? `${cur.slice(0, 25)}…` : cur)}</text>`
      : "") +
    `</g></g>`
  );
}

/** The detail panel for the SELECTED relationship — the eleven facets, unchanged. */
function detail(ctx, g, ui) {
  const e = g.edges.find((x) => x.relationshipId === ui.relOpen);
  if (!e) {
    return (
      `<aside class="rg-side"><div class="rg-sidehd">关系详情</div>` +
      `<div class="ba-none">点图上的一条连线，这里显示这段关系的完整定义；点两个人物可以新建一段关系。</div>` +
      `</aside>`
    );
  }
  const aName = e.a.name;
  const bName = e.b.name;
  const label = (k, base) =>
    k === "aToB" ? `${aName} 怎么看 ${bName}` : k === "bToA" ? `${bName} 怎么看 ${aName}` : base;
  const r = ctx.prodData().production.relationships.find((x) => x.relationshipId === e.relationshipId);
  if (!r) return "";
  const fields = FACETS.map(([k, base, ph, rows]) =>
    `<label class="ws-lab">${esc(label(k, base))}</label>` +
    `<textarea class="ws-bibletext" rows="${rows}" spellcheck="false" placeholder="${esc(ph)}" ` +
    `data-rel-field="${esc(e.relationshipId)}" data-field="${k}">${esc(r.profile[k])}</textarea>`,
  ).join("");
  return (
    `<aside class="rg-side">` +
    `<div class="rg-sidehd">${esc(aName)} <span class="rg-arrow">→</span> ${esc(bName)}` +
    `<span class="chip">${e.filled}/${RELATIONSHIP_FIELDS.length} 项</span></div>` +
    `<div class="pi-acts">` +
    `<button class="btn sm" data-rel-swap="${esc(e.relationshipId)}">⇄ 改方向</button>` +
    `<button class="btn sm" data-reldel="${esc(e.relationshipId)}">删除这段关系</button>` +
    `</div>` +
    `<div class="meta">「改方向」同时把「A 怎么看 B」和「B 怎么看 A」一起调换 —— ` +
    `只翻箭头会让你写过的话描述反了的方向。</div>` +
    (e.current
      ? `<div class="rg-cursum"><b>当前关系（到 ${esc(e.current.code)} 为止）</b>${esc(e.current.text)}</div>`
      : `<div class="meta">还没有任何一集推进这段关系 —— 在「分集规划」为某一集记录 start / event / end，` +
        `这里和图上都会显示「当前关系」。</div>`) +
    `<div class="meta">下面写的是<b>整部作品</b>的关系定义。某一集实际发生什么，记在该集的 Relationship Beat 里。</div>` +
    fields +
    `</aside>`
  );
}

/** The whole surface: graph + side panel.
 *
 *  The export names are unchanged (`renderRelWs` / `bindRelWs`) even though this is
 *  now a graph mounted as a TAB: this module is still 「人物关系 workspace」, and
 *  renaming it would only make every caller and guard test churn for no behavioural
 *  reason. 人物 mounts it; `setModule("relationships")` still resolves here. */
export function renderRelWs(ctx, ui) {
  const g = ctx.relgraph.model();
  if (g.empty) return empty("🔗", "人物关系不可用", "生产域文档未加载。");
  if (g.castCount < 2) {
    return empty(
      "🔗",
      "先有两个人物，才有关系",
      "关系是人物设定体系里的独立对象：它有自己的核心矛盾、权力关系和 Arc，不是角色档案里的一个文本字段。",
      `<button class="btn primary" data-b-chadd>＋ 添加人物</button>`,
    );
  }
  const sel = ui.relSelectA || null;
  const svg =
    `<svg class="rg-svg" viewBox="0 0 ${g.view.w} ${g.view.h}" preserveAspectRatio="xMidYMid meet">` +
    `<defs><marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0 0 L10 5 L0 10 z"/></marker></defs>` +
    g.edges.map((e) => edgeSvg(e, ui.relOpen === e.relationshipId)).join("") +
    g.nodes.map((n, i) => nodeSvg(n, g.radius, sel === n.characterId, i)).join("") +
    `</svg>`;
  const add = g.pairs.length
    ? `<select class="ws-assign" data-reladd><option value="">＋ 建立关系…</option>${g.pairs
        .map((p, i) => `<option value="${i}" data-a="${esc(p.a)}" data-b="${esc(p.b)}">${esc(p.label)}</option>`)
        .join("")}</select>`
    : `<span class="chip mute">所有人物两两之间都已有关系定义</span>`;
  const confirm =
    `<button class="btn sm" data-canon-confirm="relationships">✔ 确认关系设定版本</button>` +
    (g.revision ? `<span class="chip ok">关系设定 v${g.revision}</span>` : `<span class="chip mute">尚未确认版本</span>`);
  const hint = sel
    ? `<span class="chip">已选中：${esc((g.nodes.find((n) => n.characterId === sel) || {}).name || "")} — 再点另一个人物建立关系</span>`
    : `<span class="meta">点一个人物再点另一个 = 建立关系；点连线 = 编辑这段关系。</span>`;
  return (
    `<div class="rg">` +
    `<div class="rg-bar">${add}${hint}<span class="push"></span>` +
    `<button class="btn sm" data-rel-ai>🪄 让 AI 读剧本提关系…</button>${confirm}</div>` +
    (g.dangling.length
      ? `<div class="dir-unavail">${g.dangling.length} 段关系指向已不存在的人物，未画出（记录仍在）。</div>`
      : "") +
    `<div class="rg-body"><div class="rg-canvas">${svg}` +
    (g.edges.length ? "" : `<div class="rg-empty">还没有人物关系 —— 点两个人物建立第一段。</div>`) +
    `</div>${detail(ctx, g, ui)}</div>` +
    `<div class="meta rg-legend">线越粗越红＝矛盾越明确（由「核心矛盾 / 情感张力 / 红线」是否写了推导，不是评分）。` +
    `箭头方向＝「A 怎么看 B」的 A 那一侧。标签下方是<b>当前关系</b>（到当前剧集为止的 Relationship Beat，派生，不存第二份）。</div>` +
    `</div>`
  );
}

export function bindRelWs(root, ctx, ui, rerender) {
  const all = (q, fn) =>
    root.querySelectorAll(q).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));

  const sel = root.querySelector("[data-reladd]");
  if (sel)
    sel.onchange = () => {
      if (!sel.value) return;
      // the two ids ride in SEPARATE attributes — never packed into one value a
      // delimiter split could mis-parse (a characterId is an arbitrary string)
      const opt = sel.selectedOptions ? sel.selectedOptions[0] : sel.options[sel.selectedIndex];
      if (!opt) return;
      const rec = ctx.canon.addRelationship(opt.dataset.a, opt.dataset.b);
      if (rec) { ui.relOpen = rec.relationshipId; ui.relSelectA = null; rerender(); }
      else ctx.toast("无法建立：两个人物必须存在且不同，且这一对已有关系定义");
    };

  // CLICK TWO NODES = build a relationship. The first click only SELECTS — it must
  // not write anything, because a mis-click on a portrait would otherwise create
  // canon. The second click on the same node cancels.
  all("[data-rg-node]", (el) => {
    const id = el.dataset.rgNode;
    if (!ui.relSelectA) { ui.relSelectA = id; rerender(); return; }
    if (ui.relSelectA === id) { ui.relSelectA = null; rerender(); return; }
    const a = ui.relSelectA;
    ui.relSelectA = null;
    const rec = ctx.canon.addRelationship(a, id);
    if (rec) ui.relOpen = rec.relationshipId;
    else ctx.toast("这两个人物之间已经有关系定义了 —— 点那条连线可以编辑它");
    rerender();
  });
  all("[data-rg-edge]", (el) => {
    ui.relOpen = el.dataset.rgEdge;
    ui.relSelectA = null;
    rerender();
  });
  all("[data-rel-swap]", (el) => {
    if (ctx.canon.swapDirection(el.dataset.relSwap)) {
      ctx.toast("已调换方向（「A 怎么看 B」与「B 怎么看 A」一起跟着换了）");
    }
    rerender();
  });
  all("[data-reldel]", (el) => {
    if (!window.confirm("删除这段关系定义？（各集已记录的关系推进必须先移除）")) return;
    if (ctx.canon.removeRelationship(el.dataset.reldel)) { ui.relOpen = null; rerender(); }
    else ctx.toast("仍有剧集记录了这段关系的推进：先在「分集规划」移除该集的 Relationship Beat");
  });
  all("[data-rel-ai]", () => {
    // AI PROPOSES ONLY. This opens the Relationship Director in the right-hand
    // Director; running it produces a Proposal, and 「应用」 there is what writes.
    ui.dirOpen = { ...(ui.dirOpen || {}), skills: true };
    ui.skillId = "relationship-director";
    ctx.toast("在右侧「AI 导演 · 能力」里运行 Relationship Director：它出提案，你确认后才写进 Canon");
    rerender();
  });
  all("[data-canon-confirm]", (el) => ctx.canon.confirm(el.dataset.canonConfirm));

  // AUTOSAVE ON INPUT (ui/fieldsync.js) — a refresh mid-sentence kept nothing when
  // these only wrote on blur.
  root.querySelectorAll("[data-rel-field]").forEach((el) => {
    bindField(el, ui, (value) => ctx.canon.updateRelationship(el.dataset.relField, { [el.dataset.field]: value }));
  });
  restoreFieldFocus(root, ui);
}
