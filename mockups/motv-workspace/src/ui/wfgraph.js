// Workflow — the generation provenance workspace (TASK-054).
//
// The Production surface already answers "where is this episode in the
// process". This page answers a different question, and only that one:
//
//   which prompt, references and source media actually produced this asset,
//   and what did it go on to produce?
//
// It renders the DERIVED graph from workflow/provenance.js. It owns view state
// only — scope, filter, query, selection, which groups are expanded — and never
// writes to any domain document. Every label on screen traces to a record; a
// link the records do not prove is not drawn, and a gap is printed as a gap.
//
// Deliberately NOT a DAG editor: no ports, no payloads, no ids in the primary
// surface (raw ids live in the inspector's collapsed 技术详情), no dragging
// nodes around. Media nodes show the real frame/poster/waveform.

import { esc } from "../util/dom.js";
import {
  buildProvenanceGraph,
  scopeGraph,
  traceOf,
  searchGraph,
  explainNode,
  sceneGroups,
  shotGroups,
  seqLabel,
  nodeIds,
} from "../workflow/provenance.js";

const SCOPES = [
  ["episode", "剧集"],
  ["scene", "场景"],
  ["shot", "镜头"],
  ["project", "全项目"],
];

const FILTERS = [
  ["all", "全部"],
  ["image", "图片"],
  ["video", "视频"],
  ["audio", "音频"],
  ["render", "渲染"],
  ["failed", "失败"],
];

const STATUS_LABEL = {
  success: "成功", failed: "失败", cancelled: "已取消",
  generating: "生成中", queued: "排队中",
};

/** Column headers, from what the column actually holds.
 *  The leftmost column is everything that was never generated here — bible
 *  references and plain imports alike — so it is honestly labelled INPUTS
 *  rather than RESULT, which it is not. */
function columnTitle(nodes, rank) {
  const types = new Set(nodes.map((n) => n.type));
  if (types.size === 1) {
    if (types.has("prompt")) return "PROMPT";
    if (types.has("generation")) return "GENERATION";
  }
  const kinds = new Set(nodes.filter((n) => n.type === "asset").map((n) => n.kind));
  if (kinds.has("final")) return "FINAL";
  if (rank === 0) {
    return [...kinds].every((k) => k === "characterRef" || k === "locationRef") ? "REFERENCES" : "INPUTS";
  }
  if (types.has("asset")) return "RESULT";
  return "";
}

/* -------------------------------------------------------------------------- */
/* node cards                                                                  */
/* -------------------------------------------------------------------------- */

const shotLine = (n) => (n.shot ? `${seqLabel(n.shot)} ${n.shot.title}`.trim() : "");

function assetCard(n) {
  const cls = ["wg-node", "wg-asset", `wg-k-${n.kind}`];
  if (n.active) cls.push("is-active");
  if (n.missing) cls.push("is-missing");
  const badge = n.active ? `<span class="wg-badge">ACTIVE</span>` : "";
  // "Ref v3" is the entity's third reference; a bare "v3" would read as a media
  // version, which a bible reference does not have
  const ver = n.version == null ? "" : `${n.versionKind === "reference" ? "Ref " : ""}v${n.version}`;
  const title = n.roleLabel || (n.shot ? shotLine(n) : n.kindLabel);
  let visual;
  if (n.missing) {
    visual = `<div class="wg-thumb wg-gone"><span>媒体已删除</span></div>`;
  } else if (n.kind === "dialogue" || n.kind === "sfx" || n.kind === "bgm" || n.kind === "ambience" || n.kind === "audio") {
    visual = n.url
      ? `<img class="wg-thumb wg-wave" src="${esc(n.url)}" alt="" loading="lazy">`
      : `<div class="wg-thumb wg-wave wg-gone"><span>无波形</span></div>`;
  } else if (n.url && (n.kind === "shotVideo" || n.kind === "final")) {
    // A video asset's url IS the video file. An <img> cannot decode an mp4 —
    // with the SVG placeholders every "video" was really a picture, so this
    // only shows up against real media, as a broken-image glyph. <video> with
    // metadata preload paints the real first frame without downloading it all.
    visual =
      `<div class="wg-thumbwrap">` +
      `<video class="wg-thumb" src="${esc(n.url)}" muted preload="metadata" playsinline></video>` +
      `<span class="wg-play">▶</span></div>`;
  } else if (n.url) {
    visual = `<div class="wg-thumbwrap"><img class="wg-thumb" src="${esc(n.url)}" alt="" loading="lazy"></div>`;
  } else {
    visual = `<div class="wg-thumb wg-gone"><span>无预览</span></div>`;
  }
  return (
    `<button class="${cls.join(" ")}" data-node="${esc(n.id)}" type="button">` +
    visual +
    `<span class="wg-nt">${esc(title)}${ver ? ` <b>${esc(ver)}</b>` : ""}</span>` +
    `<span class="wg-nk">${esc(n.kindLabel)}${badge}</span>` +
    `</button>`
  );
}

function promptCard(n) {
  const first = String(n.text || "").split("\n").find((l) => l.trim()) || "";
  const preview = first.length > 42 ? `${first.slice(0, 42)}…` : first;
  return (
    `<button class="wg-node wg-prompt" data-node="${esc(n.id)}" type="button">` +
    `<span class="wg-pk">${esc(n.kindLabel)}</span>` +
    `<span class="wg-ptext">“${esc(preview)}”</span>` +
    (n.userInstruction ? `<span class="wg-pnote">改写：${esc(n.userInstruction)}</span>` : "") +
    `</button>`
  );
}

function generationCard(n) {
  const st = n.status || "generating";
  const time = n.createdAt ? String(n.createdAt).slice(11, 16) : "";
  return (
    `<button class="wg-node wg-gen wg-st-${esc(st)}" data-node="${esc(n.id)}" type="button">` +
    `<span class="wg-gk">${esc(n.kindLabel)}</span>` +
    `<span class="wg-gmeta">${esc(n.provider || "未记录来源")}</span>` +
    `<span class="wg-gstat"><i></i>${esc(STATUS_LABEL[st] || st)}${time ? ` · ${esc(time)}` : ""}</span>` +
    `</button>`
  );
}

function nodeCard(n) {
  if (n.type === "prompt") return promptCard(n);
  if (n.type === "generation") return generationCard(n);
  return assetCard(n);
}

/* -------------------------------------------------------------------------- */
/* the workspace                                                               */
/* -------------------------------------------------------------------------- */

export function createWorkflowGraph(getCtx) {
  // view state only — none of this is persisted, none of it is domain data
  const view = {
    scopeKind: "episode",
    sceneId: null,
    shotId: null,
    filter: "all",
    query: "",
    selected: null,
    traceMode: "full",
    expandedScene: null,
    expandedShot: null,
    // once the creator opens/closes a group themselves, the default-expansion
    // below must never override their choice
    touchedScene: false,
    touchedShot: false,
    showFinalDetail: false,
  };
  let root = null;
  let onSelect = null;
  let resizeObs = null;

  const pd = () => getCtx().prodData();

  function fullGraph() {
    const d = pd();
    return buildProvenanceGraph({
      assets: d.assets,
      generations: d.generations,
      production: d.production,
      timelines: d.timelines,
      draftShots: d.draftShots,
    });
  }

  /** The graph after scope + filter. Filtering hides nodes but NEVER rewrites
   *  an edge: a hidden middle step leaves a visible gap rather than a
   *  fabricated shortcut. */
  function currentGraph() {
    const d = pd();
    const g = fullGraph();
    const epId = d.production ? d.production.activeEpisodeId : null;
    let scope = { kind: "project" };
    if (view.scopeKind === "episode") scope = { kind: "episode", id: epId };
    else if (view.scopeKind === "scene") scope = { kind: "scene", id: view.sceneId };
    else if (view.scopeKind === "shot") scope = { kind: "shot", id: view.shotId };
    const scoped = scopeGraph(g, scope);
    if (view.filter === "all") return scoped;
    const keep = (n) => {
      if (view.filter === "failed") {
        return n.type === "generation" && (n.status === "failed" || n.status === "cancelled");
      }
      const k = view.filter;
      if (n.type === "generation" || n.type === "prompt") return n.kind === k;
      if (k === "image") return n.kind === "shotImage" || n.kind === "characterRef" || n.kind === "locationRef";
      if (k === "video") return n.kind === "shotVideo";
      if (k === "audio") return ["dialogue", "sfx", "bgm", "ambience", "audio"].includes(n.kind);
      if (k === "render") return n.kind === "final";
      return true;
    };
    const ids = new Set(scoped.order.filter((id) => keep(scoped.nodes.get(id))));
    const nodes = new Map();
    for (const id of scoped.order) if (ids.has(id)) nodes.set(id, scoped.nodes.get(id));
    return {
      ...scoped,
      nodes,
      edges: scoped.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      order: scoped.order.filter((id) => ids.has(id)),
    };
  }

  /* ---- header ----------------------------------------------------------- */

  function header(g) {
    const d = pd();
    const prod = d.production;
    const eps = prod ? prod.episodes : [];
    const epOpts = eps
      .map((e, i) => `<option value="${esc(e.episodeId)}"${e.episodeId === prod.activeEpisodeId ? " selected" : ""}>EP${String(i + 1).padStart(2, "0")} ${esc(e.title.replace(/^EP\d+\s*/, ""))}</option>`)
      .join("");
    const scopeBtns = SCOPES.map(([k, label]) => {
      const disabled = (k === "scene" && !view.sceneId) || (k === "shot" && !view.shotId);
      return `<button class="wg-seg${view.scopeKind === k ? " on" : ""}" data-scope="${k}"${disabled ? " disabled title=\"先在下面展开一个场景/镜头\"" : ""}>${esc(label)}</button>`;
    }).join("");
    const filterBtns = FILTERS.map(([k, label]) =>
      `<button class="wg-chip${view.filter === k ? " on" : ""}" data-filter="${k}">${esc(label)}</button>`).join("");
    const counts = {
      gen: g.order.filter((id) => g.nodes.get(id).type === "generation").length,
      failed: g.order.filter((id) => {
        const n = g.nodes.get(id);
        return n.type === "generation" && (n.status === "failed" || n.status === "cancelled");
      }).length,
    };
    return (
      `<div class="wg-bar">` +
      `<div class="wg-barrow">` +
      `<div class="wg-title">生成溯源<span>每一个资产的来源与去向</span></div>` +
      (eps.length ? `<select class="wg-epsel" id="wg-ep">${epOpts}</select>` : "") +
      `<div class="wg-segs">${scopeBtns}</div>` +
      `<div class="wg-spacer"></div>` +
      `<input class="wg-search" id="wg-q" type="search" placeholder="搜索镜头 / 角色 / 版本 / 来源 / Prompt 文本" value="${esc(view.query)}">` +
      `</div>` +
      `<div class="wg-barrow wg-barrow2">` +
      `<div class="wg-chips">${filterBtns}</div>` +
      `<div class="wg-spacer"></div>` +
      `<div class="wg-stat">${counts.gen} 次生成${counts.failed ? ` · <b class="bad">${counts.failed} 次未成功</b>` : ""}</div>` +
      `</div></div>`
    );
  }

  /* ---- episode overview (progressive disclosure) ------------------------- */

  /** Up to six real frames from the scene, newest-version first — the collapsed
   *  row still has to look like film, not a table row. */
  function sceneStrip(g, sceneId) {
    const shots = new Map();
    for (const id of g.order) {
      const n = g.nodes.get(id);
      if (n.sceneId !== sceneId || n.type !== "asset") continue;
      // images only: a filmstrip <img> cannot decode an mp4, and a shot's frame
      // is the right glance-level thumbnail anyway
      if (n.kind !== "shotImage") continue;
      const key = `${n.shotId}:${n.kind}`;
      const prev = shots.get(key);
      if (!prev || (n.version || 0) > (prev.version || 0)) shots.set(key, n);
    }
    const pics = [...shots.values()]
      .sort((a, b) => (a.shot && b.shot ? (a.shot.sequence || 0) - (b.shot.sequence || 0) : 0))
      .filter((n) => n.url)
      .slice(0, 6);
    if (!pics.length) return `<span class="wg-stripnone">还没有画面</span>`;
    return `<span class="wg-strip">${pics.map((n) =>
      `<img src="${esc(n.url)}" alt="" loading="lazy">`).join("")}</span>`;
  }

  /** Every version this shot holds, oldest first — a collapsed shot row still
   *  shows what was actually made for it, in order. */
  function shotStrip(g, shotId) {
    const pics = g.order
      .map((id) => g.nodes.get(id))
      .filter((n) => n.shotId === shotId && n.type === "asset" && n.url && n.kind === "shotImage")
      .sort((a, b) => (a.kind === b.kind ? (a.version || 0) - (b.version || 0) : a.kind < b.kind ? 1 : -1))
      .slice(0, 8);
    if (!pics.length) return `<span class="wg-stripnone">还没有画面</span>`;
    return `<span class="wg-strip sm">${pics.map((n) =>
      `<img src="${esc(n.url)}" alt="" loading="lazy"${n.active ? ' class="on"' : ""}>`).join("")}</span>`;
  }

  function overview(g, focus) {
    const d = pd();
    const prod = d.production;
    const epId = prod ? prod.activeEpisodeId : null;
    const scenes = sceneGroups(g, prod, epId);
    if (!scenes.length) {
      return `<div class="wg-empty"><div class="ic">🕸</div><div class="tt">这一集还没有场景</div><div class="hh">先在「剧集」里建立场景与镜头，生成过的每一步都会出现在这里。</div></div>`;
    }
    // Open the first scene that actually HAS generation history until the
    // creator chooses otherwise: an episode with real work behind it must never
    // greet them with four collapsed rows and a page of empty space.
    if (!view.touchedScene && view.expandedScene === null) {
      const first = scenes.find((s) => s.generations > 0) || scenes[0];
      view.expandedScene = first.sceneId;
      view.sceneId = first.sceneId;
    }
    const cards = scenes.map((sc) => {
      const on = view.expandedScene === sc.sceneId;
      return (
        `<div class="wg-scene${on ? " open" : ""}">` +
        `<button class="wg-scenehead" data-scene="${esc(sc.sceneId)}">` +
        `<span class="wg-sname">${esc(sc.title)}</span>` +
        (on ? "" : sceneStrip(g, sc.sceneId)) +
        `<span class="wg-scounts">` +
        `<i>镜头 <b>${sc.shots}</b></i><i>图片 <b>${sc.images}</b></i><i>视频 <b>${sc.videos}</b></i>` +
        `<i>音频 <b>${sc.audio}</b></i><i>生成 <b>${sc.generations}</b></i>` +
        (sc.failed ? `<i class="bad">未成功 <b>${sc.failed}</b></i>` : "") +
        `</span><span class="wg-caret">${on ? "收起" : "展开"}</span></button>` +
        (on ? sceneBody(g, sc.sceneId, focus) : "") +
        `</div>`
      );
    }).join("");
    return `<div class="wg-scenes">${cards}</div>${finalCard(g)}`;
  }

  function sceneBody(g, sceneId, focus) {
    const groups = shotGroups(g, pd().production, sceneId);
    // same reasoning as the scene above: show one real lineage straight away
    if (!view.touchedShot && view.expandedShot === null) {
      const first = groups.find((s) => s.generations > 0);
      if (first) { view.expandedShot = first.shotId; view.shotId = first.shotId; }
    }
    const rows = groups.map((s) => {
      const on = view.expandedShot === s.shotId;
      return (
        `<div class="wg-shotrow${on ? " open" : ""}">` +
        `<button class="wg-shothead" data-shot="${esc(s.shotId)}">` +
        `<span class="wg-shname">${esc(s.label)}</span>` +
        (on ? "" : shotStrip(g, s.shotId)) +
        `<span class="wg-scounts"><i>图 <b>${s.images}</b></i><i>视频 <b>${s.videos}</b></i><i>对白 <b>${s.audio}</b></i>` +
        (s.failed ? `<i class="bad">未成功 <b>${s.failed}</b></i>` : "") + `</span>` +
        `<span class="wg-caret">${on ? "收起" : "展开生成链"}</span></button>` +
        (on ? `<div class="wg-shotlane">${columns(scopeGraph(g, { kind: "shot", id: s.shotId }), focus)}</div>` : "") +
        `</div>`
      );
    }).join("");
    return `<div class="wg-shots">${rows}</div>`;
  }

  /** The Final's lineage, collapsed by track — §15: never explode hundreds of
   *  nodes by default, and never hide how many there are. */
  function finalCard(g) {
    const finals = g.order.map((id) => g.nodes.get(id)).filter((n) => n.type === "asset" && n.kind === "final");
    if (!finals.length) return "";
    const fin = finals[finals.length - 1];
    const story = explainNode(g, fin.id);
    const gen = story.producedBy;
    const groups = new Map();
    for (const inp of gen ? explainNode(g, gen.id).inputs : []) {
      const key = inp.kindLabel;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inp);
    }
    const chips = [...groups.entries()].map(([label, list]) =>
      `<button class="wg-group" data-group="${esc(label)}">${esc(label)} <b>×${list.length}</b></button>`).join("");
    const expanded = view.showFinalDetail
      ? `<div class="wg-groupbody">${[...groups.values()].flat().map(assetCard).join("")}</div>`
      : "";
    return (
      `<section class="wg-final">` +
      `<div class="wg-finalhead"><span class="wg-fk">成片链路</span>` +
      `<button class="wg-flink" data-node="${esc(fin.id)}">查看成片详情</button></div>` +
      `<div class="wg-finalrow">` +
      `<div class="wg-finalin"><div class="wg-collabel">上游素材</div><div class="wg-groups">${chips || "<span class=\"wg-none\">没有记录任何输入</span>"}</div></div>` +
      `<div class="wg-arrow">→</div>` +
      `<div class="wg-finalgen">${gen ? generationCard(gen) : "<span class=\"wg-none\">没有渲染记录</span>"}</div>` +
      `<div class="wg-arrow">→</div>` +
      `<div class="wg-finalout">${assetCard(fin)}</div>` +
      `</div>${expanded}</section>`
    );
  }

  /* ---- the column graph -------------------------------------------------- */

  function columns(g, focus) {
    if (!g.order.length) {
      return `<div class="wg-empty small"><div class="tt">这个范围里没有可显示的生成记录</div><div class="hh">换一个筛选条件，或展开别的镜头。</div></div>`;
    }
    const byRank = new Map();
    for (const id of g.order) {
      const n = g.nodes.get(id);
      if (!byRank.has(n.rank)) byRank.set(n.rank, []);
      byRank.get(n.rank).push(n);
    }
    // Inside a column, read top-to-bottom the way a creator thinks: references
    // before imports, earlier versions before later ones, earlier attempts
    // before the one that worked. Sorting by node id would interleave a
    // character reference with a shot frame for no reason a reader can see.
    const KIND_ORDER = { characterRef: 0, locationRef: 1, shotImage: 2, shotVideo: 3, dialogue: 4, sfx: 5, ambience: 6, bgm: 7, final: 8 };
    const rowKey = (n) => [
      n.type === "asset" ? (KIND_ORDER[n.kind] ?? 9) : 0,
      n.shot && n.shot.sequence != null ? n.shot.sequence : 0,
      n.version != null ? n.version : 0,
      n.createdAt || "",
      n.id,
    ];
    const cmp = (a, b) => {
      const ka = rowKey(a), kb = rowKey(b);
      for (let i = 0; i < ka.length; i += 1) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    };
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const cols = ranks.map((r) => {
      const list = byRank.get(r).slice().sort(cmp);
      const title = columnTitle(list, r);
      const cards = list.map((n) => {
        const dim = focus && !focus.has(n.id);
        const sel = view.selected === n.id;
        return `<div class="wg-slot${dim ? " dim" : ""}${sel ? " sel" : ""}">${nodeCard(n)}</div>`;
      }).join("");
      return `<div class="wg-col"><div class="wg-collabel">${esc(title)}</div><div class="wg-colbody">${cards}</div></div>`;
    });
    // The SVG is filled in after layout (drawEdges) — it needs real geometry.
    return `<div class="wg-cols" data-edges="1"><svg class="wg-wires" aria-hidden="true"></svg>${cols.join(`<div class="wg-flow">→</div>`)}</div>`;
  }

  /** Draw the real connections, after the cards have been laid out.
   *
   *  One line per RECORDED edge, from the right edge of the source card to the
   *  left edge of the target. Nothing is drawn for a link the graph does not
   *  hold, and an edge whose endpoint is filtered out is simply absent — the
   *  wires can never claim more than the records do. */
  function drawEdges(g, focus) {
    for (const box of root.querySelectorAll(".wg-cols[data-edges]")) {
      const svg = box.querySelector(".wg-wires");
      if (!svg) continue;
      const base = box.getBoundingClientRect();
      svg.setAttribute("viewBox", `0 0 ${Math.max(1, box.scrollWidth)} ${Math.max(1, box.scrollHeight)}`);
      svg.setAttribute("width", box.scrollWidth);
      svg.setAttribute("height", box.scrollHeight);
      const at = (id) => {
        const el = box.querySelector(`[data-node="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x1: r.left - base.left, x2: r.right - base.left,
          y: r.top - base.top + r.height / 2,
        };
      };
      const parts = [];
      for (const e of g.edges) {
        const a = at(e.from);
        const b = at(e.to);
        if (!a || !b || b.x1 <= a.x2) continue; // only forward, left→right
        const dx = Math.max(14, (b.x1 - a.x2) * 0.55);
        const lit = !focus || (focus.has(e.from) && focus.has(e.to));
        parts.push(
          `<path d="M${a.x2} ${a.y} C${a.x2 + dx} ${a.y} ${b.x1 - dx} ${b.y} ${b.x1} ${b.y}" ` +
          `class="wire wire-${e.kind}${lit ? " lit" : ""}"/>`,
        );
      }
      svg.innerHTML = parts.join("");
    }
  }

  /* ---- inspectors -------------------------------------------------------- */

  function kv(label, value) {
    return `<div class="wg-kv"><span>${esc(label)}</span><b>${value}</b></div>`;
  }

  function miniRow(list, emptyText) {
    if (!list.length) return `<div class="wg-none">${esc(emptyText)}</div>`;
    return `<div class="wg-mini">${list.map((n) => {
      const label = n.type === "asset"
        ? `${n.roleLabel || n.kindLabel}${n.version != null ? ` v${n.version}` : ""}`
        : n.kindLabel;
      const thumb = n.type === "asset" && n.url ? `<img src="${esc(n.url)}" alt="">` : "";
      return `<button class="wg-minirow" data-node="${esc(n.id)}">${thumb}<span>${esc(label)}</span></button>`;
    }).join("")}</div>`;
  }

  /**
   * AI 导演 · 溯源助手 (§18).
   *
   * It reads the SAME derived story the graph draws and re-states it as a
   * chain, plus at most one observation. Every sentence it can produce is
   * pinned to a record: it never proposes a link, never guesses a cause, and
   * when the records do not support a remark it prints nothing rather than
   * filling the panel.
   */
  function directorPanel(g) {
    if (!view.selected || !g.nodes.has(view.selected)) {
      return (
        `<section class="wg-dir"><div class="wg-ilabel">AI 导演 · 溯源</div>` +
        `<div class="wg-none">选中一个节点后，这里会把它的生成链按记录复述一遍。</div></section>`
      );
    }
    const n = g.nodes.get(view.selected);
    const story = explainNode(g, n.id);
    const name = (x) => (x.type === "asset"
      ? `${x.roleLabel || x.kindLabel}${x.version != null ? ` v${x.version}` : ""}`
      : x.kindLabel);

    /** Name the inputs — but a render consumes every clip in the episode, and
     *  listing forty of them is not a summary. Past a handful, collapse to
     *  counts BY KIND, which is still exactly what the records say. */
    const feedLine = (list) => {
      if (list.length <= 5) return list.map((f) => `<b>${esc(name(f))}</b>`).join(" ＋ ");
      const byKind = new Map();
      for (const x of list) byKind.set(x.kindLabel, (byKind.get(x.kindLabel) || 0) + 1);
      return `<b>${list.length} 项素材</b>（` +
        [...byKind.entries()].map(([k, c]) => `${esc(k)} ×${c}`).join(" · ") + `）`;
    };

    const steps = [];
    if (story.producedBy) {
      const genStory = explainNode(g, story.producedBy.id);
      const feed = genStory.references.concat(genStory.inputs);
      if (feed.length) steps.push(feedLine(feed));
      if (story.prompt) steps.push(`＋ <b>${esc(story.prompt.kindLabel)}</b>`);
      steps.push(`→ ${esc(story.producedBy.kindLabel)}（${esc(story.producedBy.provider || "来源未记录")}）`);
      steps.push(`→ <b>${esc(name(n))}</b>`);
    } else if (n.type === "asset") {
      steps.push(n.missing ? "媒体记录已删除，只保留了链路。" : "这是一次导入：没有生成记录，也没有可引用的 Prompt。");
    } else if (n.type === "generation") {
      const gs = explainNode(g, n.id);
      const feed = gs.references.concat(gs.inputs);
      if (feed.length) steps.push(feedLine(feed));
      if (gs.prompt) steps.push(`＋ <b>${esc(gs.prompt.kindLabel)}</b>`);
      steps.push(`→ ${esc(n.kindLabel)}（${esc(STATUS_LABEL[n.status] || n.status)}）`);
      steps.push(gs.results.length ? `→ <b>${esc(gs.results.map(name).join("、"))}</b>` : "→ 没有产出");
    } else {
      steps.push(`这段 Prompt 驱动了一次${esc(n.kindLabel)}。`);
    }

    // At most ONE observation, and only where the records themselves justify it.
    let note = "";
    if (n.type === "asset" && n.kind === "shotVideo" && story.inputs.length === 1) {
      const src = story.inputs[0];
      note = `这个视频是从 <b>${esc(name(src))}</b> 生成的${src.active ? "" : "（该图片已不是当前选用版本）"}。` +
        `人物或场景不一致时，先查这一张图片和它的参考，再决定要不要重做视频。`;
    } else if (n.type === "generation" && (n.status === "failed" || n.status === "cancelled")) {
      note = `这次尝试没有产出，记录保留下来是为了说明后面那一次改了什么。`;
    } else if (n.type === "asset" && story.provenance === "import" && !n.missing) {
      note = `没有生成记录，所以来源只能如实写成「外部导入」——不要在这里推断 Prompt。`;
    }

    const jumps = [];
    if (story.producedBy) jumps.push(`<button class="wg-btn" data-node="${esc(story.producedBy.id)}">查看生成记录</button>`);
    if (story.prompt) jumps.push(`<button class="wg-btn" data-node="${esc(story.prompt.id)}">查看 Prompt</button>`);
    if (story.inputs[0]) jumps.push(`<button class="wg-btn" data-node="${esc(story.inputs[0].id)}">定位 ${esc(name(story.inputs[0]))}</button>`);

    return (
      `<section class="wg-dir"><div class="wg-ilabel">AI 导演 · 溯源</div>` +
      `<div class="wg-dirchain">` +
      steps.map((s) => `<div class="wg-dirstep"><span class="mk">·</span><span class="bd">${s}</span></div>`).join("") +
      `</div>` +
      (note ? `<div class="wg-dirnote">${note}</div>` : "") +
      (jumps.length ? `<div class="wg-acts">${jumps.join("")}</div>` : "") +
      `</section>`
    );
  }

  function inspector(g) {
    if (!view.selected || !g.nodes.has(view.selected)) {
      return (
        `<aside class="wg-insp empty"><div class="wg-inspempty">` +
        `<div class="ic">🔍</div><div class="tt">选一个节点</div>` +
        `<div class="hh">点任意画面、Prompt 或生成记录，这里会显示它的完整来源与去向；<br>图上会只亮起这一条链路。</div>` +
        `</div>${directorPanel(g)}</aside>`
      );
    }
    const n = g.nodes.get(view.selected);
    const story = explainNode(g, n.id);
    const traceBtns =
      `<div class="wg-trace">` +
      ["up", "down", "full"].map((m) =>
        `<button class="wg-seg${view.traceMode === m ? " on" : ""}" data-trace="${m}">${m === "up" ? "仅看上游" : m === "down" ? "仅看下游" : "完整链路"}</button>`).join("") +
      `</div>`;

    let body = "";
    if (n.type === "prompt") {
      body =
        `<div class="wg-isec"><div class="wg-ilabel">目标</div><div class="wg-ivalue">${esc(n.shot ? `${n.shot.episodeTitle} · ${n.shot.sceneTitle} · ${seqLabel(n.shot)}` : "未绑定镜头")}</div></div>` +
        `<div class="wg-isec"><div class="wg-ilabel">Prompt 快照</div><pre class="wg-pre">${esc(n.text)}</pre></div>` +
        (n.userInstruction ? `<div class="wg-isec"><div class="wg-ilabel">本次改写要求</div><div class="wg-ivalue">${esc(n.userInstruction)}</div></div>` : "") +
        `<div class="wg-isec"><div class="wg-ilabel">输入</div>${miniRow(story.references.concat(story.inputs), "这次生成没有记录输入")}</div>` +
        `<div class="wg-isec"><div class="wg-ilabel">来源</div><div class="wg-ivalue">${esc(n.provider || "未记录")}</div></div>` +
        `<div class="wg-acts"><button class="wg-btn" data-copy="${esc(n.id)}">复制 Prompt</button>` +
        `<button class="wg-btn" data-node="${esc(nodeIds.generation(n.generationId))}">查看生成记录</button>` +
        (n.shotId ? `<button class="wg-btn" data-goshot="${esc(n.shotId)}">定位镜头</button>` : "") + `</div>`;
    } else if (n.type === "generation") {
      const p = n.parameters;
      body =
        `<div class="wg-isec"><div class="wg-ilabel">状态</div><div class="wg-ivalue"><span class="wg-pill wg-st-${esc(n.status)}">${esc(STATUS_LABEL[n.status] || n.status)}</span></div></div>` +
        kv("来源", esc(n.provider || "未记录")) +
        kv("模型", esc(n.model || "未记录")) +
        kv("时间", esc(n.createdAt || "未记录")) +
        kv("目标", esc(n.shot ? `${n.shot.sceneTitle} · ${seqLabel(n.shot)} ${n.shot.title}` : "整集渲染")) +
        (story.prompt ? `<div class="wg-isec"><div class="wg-ilabel">Prompt 快照</div><pre class="wg-pre">${esc(story.prompt.text)}</pre></div>`
          : `<div class="wg-isec"><div class="wg-ilabel">Prompt</div><div class="wg-none">这类生成没有 Prompt（渲染使用的是设置，不是提示词）</div></div>`) +
        `<div class="wg-isec"><div class="wg-ilabel">参考</div>${miniRow(story.references, "没有记录参考")}</div>` +
        `<div class="wg-isec"><div class="wg-ilabel">输入</div>${miniRow(story.inputs, "没有记录输入")}</div>` +
        `<div class="wg-isec"><div class="wg-ilabel">产出</div>${miniRow(story.results, n.status === "failed" || n.status === "cancelled" ? "这次尝试没有产出（记录保留）" : "还没有产出")}</div>` +
        (p ? `<details class="wg-tech"><summary>技术详情</summary><pre class="wg-pre">${esc(JSON.stringify({ generationId: n.generationId, parameters: p }, null, 2))}</pre></details>`
          : `<details class="wg-tech"><summary>技术详情</summary><pre class="wg-pre">${esc(n.generationId)}</pre></details>`);
    } else {
      const origin = story.provenance === "import"
        ? (n.missing ? "媒体记录已删除，只剩链路" : "外部导入 · 没有生成记录")
        : "AI 生成";
      body =
        `<div class="wg-ihero">${n.url ? `<img src="${esc(n.url)}" alt="">` : `<div class="wg-gone"><span>无预览</span></div>`}</div>` +
        kv("类型", esc(n.kindLabel) + (n.version != null ? ` v${n.version}` : "") + (n.active ? ` <span class="wg-badge">ACTIVE</span>` : "")) +
        kv("归属", esc(n.shot ? `${n.shot.sceneTitle} · ${seqLabel(n.shot)} ${n.shot.title}` : (n.roleLabel || "项目级素材"))) +
        kv("来源", esc(origin)) +
        (n.storageState && n.storageState !== "local" ? kv("媒体状态", esc(n.storageState)) : "") +
        (story.producedBy
          ? `<div class="wg-isec"><div class="wg-ilabel">由谁生成</div>${miniRow([story.producedBy], "")}</div>` +
            (story.prompt ? `<div class="wg-isec"><div class="wg-ilabel">Prompt</div><pre class="wg-pre">${esc(story.prompt.text)}</pre></div>` : "")
          : `<div class="wg-isec"><div class="wg-ilabel">Prompt</div><div class="wg-none">未知 — 这是一次导入，没有可引用的 Prompt</div></div>`) +
        `<div class="wg-isec"><div class="wg-ilabel">参考</div>${miniRow(story.references, "没有记录参考")}</div>` +
        (story.firstFrame.length ? `<div class="wg-isec"><div class="wg-ilabel">记录的首帧</div>${miniRow(story.firstFrame, "")}</div>` : "") +
        `<div class="wg-isec"><div class="wg-ilabel">下游产物</div>${miniRow(story.usedBy, "还没有被任何后续生成使用")}</div>` +
        `<div class="wg-acts">` +
        (n.shotId ? `<button class="wg-btn" data-goshot="${esc(n.shotId)}">在制作中打开</button>` : "") +
        `<button class="wg-btn" data-scopeshot="${esc(n.shotId || "")}"${n.shotId ? "" : " disabled"}>只看这个镜头</button>` +
        `</div>`;
    }

    const title = n.type === "asset"
      ? `${n.roleLabel || n.kindLabel}${n.version != null ? ` v${n.version}` : ""}`
      : n.kindLabel;
    return (
      `<aside class="wg-insp">` +
      `<div class="wg-ihead"><div class="wg-it">${esc(title)}</div>` +
      `<button class="wg-close" data-close="1">✕</button></div>` +
      traceBtns +
      `<div class="wg-ibody">${body}${directorPanel(g)}</div></aside>`
    );
  }

  /* ---- render ------------------------------------------------------------ */

  function render() {
    if (!root) return;
    const g = currentGraph();
    const hits = view.query ? new Set(searchGraph(g, view.query)) : null;
    let focus = null;
    if (view.selected && g.nodes.has(view.selected)) focus = traceOf(g, view.selected, view.traceMode);
    else if (hits && hits.size) focus = hits;

    const showOverview = view.scopeKind === "episode" && !view.query;
    const main = showOverview ? overview(g, focus) : columns(g, focus);
    const hitNote = hits
      ? `<div class="wg-hits">${hits.size ? `找到 <b>${hits.size}</b> 个匹配节点，其余已淡出` : "没有匹配的节点"}</div>`
      : "";
    root.innerHTML =
      `<div class="wg-root">${header(g)}` +
      `<div class="wg-body"><div class="wg-canvas">${hitNote}${main}</div>${inspector(g)}</div></div>`;
    wire(g);
    // wires need real geometry, and the placeholder frames are images: redraw
    // once after layout and again as each one lands, or the curves would point
    // at where the cards used to be
    const redraw = () => drawEdges(g, focus);
    requestAnimationFrame(redraw);
    for (const img of root.querySelectorAll(".wg-cols img")) {
      if (!img.complete) img.addEventListener("load", redraw, { once: true });
    }
    if (resizeObs) resizeObs.disconnect();
    if (typeof ResizeObserver === "function") {
      resizeObs = new ResizeObserver(() => redraw());
      for (const box of root.querySelectorAll(".wg-cols")) resizeObs.observe(box);
    }
    if (onSelect) onSelect(view.selected ? explainNode(g, view.selected) : null, g);
  }

  function wire(g) {
    const q = (sel) => root.querySelectorAll(sel);
    const ep = root.querySelector("#wg-ep");
    if (ep) {
      const wasEp = ep.value;
      ep.onchange = () => {
        const ctx = getCtx();
        // The active episode is shared with the Production shell. Switching it
        // while a shot detail has unsaved edits would strand that buffer: the
        // shell blocks re-selection while dirty, so returning to Production
        // would show the previous episode's shot under the new episode.
        if (ctx.hasUnsavedShotEdit && ctx.hasUnsavedShotEdit()) {
          if (!window.confirm("镜头详情有未保存的修改，切换剧集将丢弃？")) {
            ep.value = wasEp; // the switch did not happen — do not pretend it did
            return;
          }
          // the creator said discard, so actually discard: leaving the buffer
          // alive would carry the old episode's shot edit into the new episode
          if (ctx.discardShotEdit) ctx.discardShotEdit();
        }
        if (ctx.production && ctx.production.setActiveEpisode) ctx.production.setActiveEpisode(ep.value);
        view.expandedScene = null; view.expandedShot = null;
        view.sceneId = null; view.shotId = null; view.selected = null;
        view.scopeKind = "episode";
        render();
      };
    }
    const search = root.querySelector("#wg-q");
    if (search) {
      search.oninput = () => {
        view.query = search.value;
        render();
        const again = root.querySelector("#wg-q");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      };
    }
    for (const b of q("[data-scope]")) {
      b.onclick = () => { view.scopeKind = b.dataset.scope; view.selected = null; render(); };
    }
    for (const b of q("[data-filter]")) {
      b.onclick = () => { view.filter = b.dataset.filter; render(); };
    }
    for (const b of q("[data-scene]")) {
      b.onclick = () => {
        const id = b.dataset.scene;
        view.touchedScene = true;
        view.touchedShot = false;
        view.expandedScene = view.expandedScene === id ? null : id;
        view.sceneId = view.expandedScene;
        view.expandedShot = null;
        render();
      };
    }
    for (const b of q("[data-shot]")) {
      b.onclick = () => {
        const id = b.dataset.shot;
        view.touchedShot = true;
        view.expandedShot = view.expandedShot === id ? null : id;
        view.shotId = view.expandedShot;
        render();
      };
    }
    for (const b of q("[data-node]")) {
      b.onclick = () => {
        const id = b.dataset.node;
        view.selected = view.selected === id ? null : id;
        render();
      };
    }
    for (const b of q("[data-trace]")) {
      b.onclick = () => { view.traceMode = b.dataset.trace; render(); };
    }
    for (const b of q("[data-group]")) {
      b.onclick = () => { view.showFinalDetail = !view.showFinalDetail; render(); };
    }
    for (const b of q("[data-close]")) {
      b.onclick = () => { view.selected = null; render(); };
    }
    for (const b of q("[data-copy]")) {
      b.onclick = async () => {
        const n = g.nodes.get(b.dataset.copy);
        if (!n) return;
        try {
          await navigator.clipboard.writeText(n.text);
          b.textContent = "已复制";
          setTimeout(() => { b.textContent = "复制 Prompt"; }, 1200);
        } catch {
          b.textContent = "复制失败";
        }
      };
    }
    for (const b of q("[data-scopeshot]")) {
      b.onclick = () => {
        if (!b.dataset.scopeshot) return;
        view.shotId = b.dataset.scopeshot;
        view.scopeKind = "shot";
        render();
      };
    }
    for (const b of q("[data-goshot]")) {
      b.onclick = () => {
        const ctx = getCtx();
        if (ctx.openShotInProduction) ctx.openShotInProduction(b.dataset.goshot);
      };
    }
  }

  return {
    /** Attach to a container WITHOUT rendering: at app-boot time the engine and
     *  the project documents do not exist yet, and deriving a graph from them
     *  would throw before the shell is even up. The first render happens when
     *  Workflow is actually opened. */
    mount(el, { onSelectionChange } = {}) {
      root = el;
      onSelect = onSelectionChange || null;
    },
    render,
    /** The current selection's provenance story — what the AI Director reads.
     *  It is the SAME derived record set the page draws, so the panel cannot
     *  describe a link the graph does not show. */
    selection() {
      if (!view.selected) return null;
      const g = currentGraph();
      return g.nodes.has(view.selected) ? explainNode(g, view.selected) : null;
    },
    /** Focus a shot's lineage from outside (e.g. the Director's jump buttons). */
    focusShot(shotId) {
      view.scopeKind = "shot";
      view.shotId = shotId;
      view.selected = null;
      render();
    },
    focusNode(nodeId) {
      view.selected = nodeId;
      render();
    },
    state: view,
  };
}
