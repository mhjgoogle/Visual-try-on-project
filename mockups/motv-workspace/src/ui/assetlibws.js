// Asset Library (checkpoint CP5 / ADR-0058) — a VISUAL-FIRST Production Memory
// Library, not a storage manager.
//
// The question it answers is 「我现在有什么可以复用」, so the primary surface is
// the media itself: a real thumbnail, a real poster, a real waveform, a real
// player. `path` / `assetId` / `storageState` are engineering facts about the
// same object and they live in Technical Details, behind the thing the creator
// actually recognises. (Storage MANAGEMENT is a separate surface and stays
// where it is — this workspace never deletes anything.)
//
// Everything here is DERIVED on render from the registry + canonical documents:
// the library owns no state of its own, so it can never disagree with what the
// project actually holds. Only the creator's own metadata edits (displayName /
// tags / reusable) write, and they go through the one declaration write path.

import { esc } from "../util/dom.js";
import { head, empty } from "./shell.js";
import {
  ASSET_KIND_LABEL, ASSET_KINDS, KIND_DOMAIN, REFERENCE_KINDS as REF_KINDS,
  derivedLabel, isReferenceKey,
} from "../workflow/assetreg.js";
import { USAGE_KIND_LABEL, isUnused } from "../workflow/assetusage.js";

/** Media class → how a card presents itself. Visual-first means the DOMAIN
 *  decides the presentation, never the file extension. */
function mediaClass(a) {
  if (a.domain === "images") return "image";
  if (a.domain === "videos" || a.domain === "finals") return "video";
  if (a.domain === "audio") return "audio";
  return "other";
}

/** The library's filter vocabulary. `all` is deliberately first: the creator
 *  opens this to browse, not to run a query. */
export const TYPE_FILTERS = [
  ["all", "全部"],
  ["reference", "参考"],
  ["shot-image", "镜头图片"],
  ["shot-video", "镜头视频"],
  ["audio", "音频"],
  ["final", "成片"],
  // §1.6: Collections became 「已保存筛选」 — it was never a second container, only
  // a filter the creator had marked. Naming it a collection implied a place to put
  // things into, which it never was.
  ["collection", "已保存筛选"],
];

/** 资产库 rail key → the type filter it stands for (ADR-0061 决策 1). The rail is
 *  media CATEGORIES; production navigation is deliberately absent from it. */
export const RAIL_TYPE = {
  assets: "all",
  "assets:reference": "reference",
  "assets:image": "shot-image",
  "assets:video": "shot-video",
  "assets:audio": "audio",
  "assets:final": "final",
  "assets:collection": "collection",
};

// Imported, never re-listed: a second copy of "which kinds are references" is
// exactly how the library came to hide the ADR-0061 directing references while
// the shot workspaces bound them (a filter that lies about what exists).
const REFERENCE_KINDS = new Set(REF_KINDS);
const AUDIO_KINDS = new Set(
  ASSET_KINDS.filter((k) => KIND_DOMAIN[k] === "audio"),
);

function matchesType(a, type) {
  if (type === "all") return true;
  if (type === "reference") return REFERENCE_KINDS.has(a.kind) || isReferenceKey(a.key);
  if (type === "audio") return AUDIO_KINDS.has(a.kind) || a.domain === "audio";
  if (type === "final") return a.kind === "final" || a.domain === "finals";
  // 资产库's Collections tab (ADR-0061 决策 1): assets the creator EXPLICITLY
  // marked reusable. Never "used more than once" — that inference is what
  // ADR-0055 决策 1 refuses.
  if (type === "collection") return a.reusable === true;
  return a.kind === type;
}

/** Free-text search across everything a creator would actually type: the name
 *  they gave it, their tags, and the NAMES of the canonical objects it is
 *  attached to — never the assetId, which nobody remembers. */
function matchesSearch(a, q, names) {
  if (!q) return true;
  const hay = [
    a.displayName || "",
    a.originalFilename || "",
    derivedLabel(a),
    ASSET_KIND_LABEL[a.kind] || "",
    ...a.tags,
    names.character(a.links.characterId),
    names.location(a.links.locationId),
    names.episode(a.links.episodeId),
    names.scene(a.links.sceneId),
    names.shot(a.links.shotId),
  ].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

/**
 * The library read model.
 *
 * `assets`  assetreg.listAssets(registry)
 * `usage`   Map(assetId → usage) from assetusage.usageIndex
 * `names`   resolvers for canonical ids → human names (so search and filters
 *           work on what the creator sees, not on ids)
 * `filters` { type, search, characterId, locationId, episodeId, sceneId,
 *             shotId, source, reusable, variant, recent }
 */
export function libraryModel({ assets, usage, names, filters = {} }) {
  const f = { type: "all", variant: "current", ...filters };
  const q = (f.search || "").trim();

  let rows = assets.map((a) => {
    const u = usage.get(a.assetId) || { places: [], count: 0, byKind: {} };
    return {
      ...a,
      name: derivedLabel(a),
      kindLabel: a.kind ? ASSET_KIND_LABEL[a.kind] || a.kind : "未分类",
      media: mediaClass(a),
      usage: u,
      unused: isUnused(u),
      isReference: REFERENCE_KINDS.has(a.kind) || isReferenceKey(a.key),
    };
  });

  const before = rows.length;
  rows = rows.filter((a) => matchesType(a, f.type));
  rows = rows.filter((a) => matchesSearch(a, q, names));
  if (f.characterId) rows = rows.filter((a) => a.links.characterId === f.characterId
    || a.usage.places.some((p) => p.characterId === f.characterId));
  if (f.locationId) rows = rows.filter((a) => a.links.locationId === f.locationId
    || a.usage.places.some((p) => p.locationId === f.locationId));
  if (f.episodeId) rows = rows.filter((a) => a.links.episodeId === f.episodeId
    || a.usage.places.some((p) => p.episodeId === f.episodeId));
  if (f.sceneId) rows = rows.filter((a) => a.links.sceneId === f.sceneId
    || a.usage.places.some((p) => p.sceneId === f.sceneId));
  if (f.shotId) rows = rows.filter((a) => a.links.shotId === f.shotId
    || a.usage.places.some((p) => p.shotId === f.shotId));
  if (f.source) rows = rows.filter((a) => (a.origin || "") === f.source);
  if (f.reusable) rows = rows.filter((a) => a.reusable);
  if (f.tag) rows = rows.filter((a) => a.tags.includes(f.tag));
  // Active / Historical: a chain's CURRENT version vs the takes behind it.
  // `all` is offered because "show me the other takes" is a real question.
  if (f.variant === "current") rows = rows.filter((a) => a.current);
  else if (f.variant === "historical") rows = rows.filter((a) => !a.current);

  // "Recently created" has no timestamp on an Asset record — the honest proxy
  // is registry order, which IS creation order (records are appended). Labelled
  // as 最近登记 rather than pretending to a date we never stored.
  if (f.recent) rows = rows.slice(-24).reverse();

  const tags = new Map();
  for (const a of assets) for (const t of a.tags) tags.set(t, (tags.get(t) || 0) + 1);

  return {
    rows,
    total: assets.length,
    shown: rows.length,
    filtered: before !== rows.length || !!q,
    tags: [...tags.entries()].map(([tag, n]) => ({ tag, n })).sort((x, y) => y.n - x.n),
    counts: TYPE_FILTERS.map(([id, label]) => ({
      id, label, n: assets.filter((a) => matchesType(a, id)).length,
    })),
    unusedCount: assets.filter((a) => isUnused(usage.get(a.assetId))).length,
    needsReview: assets.filter((a) => a.needsReview).length,
  };
}

// --- rendering ---------------------------------------------------------------- //

/** The visual for one asset. REAL media, always — an image is its own
 *  thumbnail, a video gets a poster frame from its own first frame, audio gets
 *  a waveform block plus a player. A missing byte says so instead of showing a
 *  broken frame. */
function preview(a, { big = false } = {}) {
  const gone = a.storageState !== "local";
  if (gone) {
    return `<div class="al-media al-gone"><span class="ic">⃠</span><span>${esc(a.storageState === "archived" ? "已归档" : "本地字节不在")}</span></div>`;
  }
  if (a.media === "image") {
    return `<img class="al-media" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy">`;
  }
  if (a.media === "video") {
    return big
      ? `<video class="al-media" src="${esc(a.url)}" controls preload="metadata"></video>`
      : `<video class="al-media" src="${esc(a.url)}" preload="metadata" muted playsinline></video>`;
  }
  if (a.media === "audio") {
    return (
      `<div class="al-media al-wave"><span class="ic">🎵</span>` +
      `<audio src="${esc(a.url)}" controls preload="metadata"></audio></div>`
    );
  }
  return `<div class="al-media al-gone"><span class="ic">?</span><span>未知媒体</span></div>`;
}

/** A library card.
 *
 *  An <article> with a <button> caption, NOT one big <button>: an audio card
 *  carries `<audio controls>`, and a control nested inside a button is invalid
 *  HTML whose clicks the browser may route to the outer button — pressing play
 *  opened the inspector instead of playing.
 *
 *  The whole card still opens the asset, but through a click handler on the
 *  article that ignores clicks landing inside a media control (see
 *  bindAssetLibrary). The caption stays a real <button> so the card is
 *  reachable and operable from the keyboard, which a bare click handler is not. */
function card(a, { drawer = false } = {}) {
  const use = a.usage.count;
  return (
    `<article class="al-card${a.needsReview ? " needs" : ""}" data-al-card="${esc(a.assetId)}">` +
    preview(a) +
    `<button class="al-cap" data-al-open="${esc(a.assetId)}">` +
    `<span class="al-name">${esc(a.name)}</span>` +
    `<span class="al-sub">` +
    `<span class="chip">${esc(a.kindLabel)}</span>` +
    (a.reusable ? `<span class="chip ok">可复用</span>` : "") +
    (a.current ? "" : `<span class="chip">历史 v${a.version}</span>`) +
    (use ? `<span class="al-use">用于 ${use} 处</span>` : `<span class="al-use muted">未被使用</span>`) +
    `</span></button>` +
    // the ONE affordance the drawer adds: it exists to put this asset on a shot
    (drawer ? `<button class="btn sm al-add" data-al-add="${esc(a.assetId)}">+ 加入</button>` : "") +
    `</article>`
  );
}

/** The Asset Inspector: Preview · Info · Usage · Provenance · Technical.
 *  Technical is LAST and collapsed — path/assetId/storageState are true and
 *  useful, and they are not what the creator recognises the asset by. */
function inspector(a, prov) {
  const info =
    `<dl class="al-info">` +
    `<dt>名称</dt><dd>${esc(a.displayName || "（未命名 · 显示为派生标签）")}</dd>` +
    `<dt>类型</dt><dd>${esc(a.kindLabel)}${a.needsReview ? "（待分类）" : ""}</dd>` +
    `<dt>标签</dt><dd>${a.tags.length ? a.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(" ") : "—"}</dd>` +
    `<dt>可复用</dt><dd>${a.reusable ? "是（由你标记）" : "否"}</dd>` +
    (a.originalFilename ? `<dt>原始文件名</dt><dd>${esc(a.originalFilename)}</dd>` : "") +
    `</dl>`;
  const usage = a.usage.count
    ? `<ul class="al-usage">${a.usage.places
        .map((p) => `<li><span class="chip">${esc(USAGE_KIND_LABEL[p.kind] || p.kind)}</span>${esc(p.label)}</li>`)
        .join("")}</ul>`
    : `<div class="al-none">还没有任何地方使用它。</div>`;
  const provHtml = prov && prov.generation
    ? `<dl class="al-info">` +
      `<dt>Prompt</dt><dd>${prov.generation.promptSnapshot ? esc(prov.generation.promptSnapshot) : "—"}</dd>` +
      `<dt>来源</dt><dd>${esc(prov.generation.provider || "—")}</dd>` +
      `<dt>模型</dt><dd>${esc(prov.generation.model || "未上报")}</dd>` +
      `<dt>参考输入</dt><dd>${(prov.references || []).length ? (prov.references || []).map((r) => esc(r)).join("、") : "—"}</dd>` +
      `<dt>状态</dt><dd>${esc(prov.generation.status || "—")}</dd>` +
      `</dl>`
    : `<div class="al-none">没有记录到产生它的生成——它是直接导入的，或早于生成登记。</div>`;
  return (
    `<div class="al-insp">` +
    `<div class="al-insp-head"><b>${esc(a.name)}</b><button class="btn" data-al-close>关闭</button></div>` +
    `<div class="al-insp-media">${preview(a, { big: true })}</div>` +
    `<h4>信息</h4>${info}` +
    `<div class="al-edit">` +
    `<input class="field al-rename" placeholder="给它一个你认得的名字" value="${esc(a.displayName || "")}">` +
    `<input class="field al-tag" placeholder="加一个标签（雨夜 / cinematic / 暖光）">` +
    `<label class="al-reuse"><input type="checkbox" data-al-reusable ${a.reusable ? "checked" : ""}> 标记为可复用</label>` +
    `</div>` +
    `<h4>使用（${a.usage.count}）</h4>${usage}` +
    `<h4>溯源</h4>${provHtml}` +
    `<details class="al-tech"><summary>技术细节</summary><dl class="al-info">` +
    `<dt>assetId</dt><dd><code>${esc(a.assetId)}</code></dd>` +
    `<dt>链 / 版本</dt><dd><code>${esc(a.key || "—")}</code> · v${a.version}${a.current ? "（当前）" : ""}</dd>` +
    `<dt>存储状态</dt><dd>${esc(a.storageState)}</dd>` +
    `<dt>路径</dt><dd><code>${esc(a.url)}</code></dd>` +
    `</dl></details></div>`
  );
}

/**
 * ⑪ 资产库 — ONE implementation, TWO SIZES (TASK-073 §1.6).
 *
 * `mode: "page"`   the full ⑪ 资产库 page
 * `mode: "drawer"` the 「添加参考」 drawer, opened beside a shot
 *
 * §1.6: 「『添加参考』抽屉与资产库页是**同一个组件的两种尺寸**——一份实现，两个触发
 * 点（与 postconsole 的 dock/full 是同一条教训）」. That lesson is worth restating:
 * two implementations of one library drift, and the drift shows up as a filter
 * vocabulary that means one thing on the page and another in the drawer — so the
 * creator's 「只看可复用」 stops being one idea.
 *
 * The DRAWER differs only in chrome and in one added affordance: each card gets
 * 「+ 加入」 (`data-al-add`), because that is the whole point of opening it beside a
 * shot. Same filters, same counts, same cards, same inspector.
 */
export function renderAssetLibrary(ctx, ui, { mode = "page", shotId = null } = {}) {
  const drawer = mode === "drawer";
  const m = ctx.assets.library(ui.alFilters || {});
  const f = ui.alFilters || {};
  if (!m.total) {
    const emptyBody = empty(
      "🗂",
      "还没有任何资产",
      "在镜头里生成/导入媒体，或上传一张参考图，它们会自动登记到这里",
    );
    return drawer
      ? `<div class="al-drawer">${drawerTop(shotId)}${emptyBody}</div>`
      : head("资产库", "你现在有什么可以复用") + emptyBody;
  }
  const tabs = m.counts
    .map((c) => `<button class="al-tab${(f.type || "all") === c.id ? " on" : ""}" data-al-type="${c.id}">${esc(c.label)} <b>${c.n}</b></button>`)
    .join("");
  const tagChips = m.tags.slice(0, 12)
    .map((t) => `<button class="al-tagchip${f.tag === t.tag ? " on" : ""}" data-al-tag="${esc(t.tag)}">${esc(t.tag)} ${t.n}</button>`)
    .join("");
  const sel = (id, label, options, value) =>
    `<select class="al-sel" data-al-${id}><option value="">${esc(label)}</option>${options
      .map((o) => `<option value="${esc(o.id)}"${value === o.id ? " selected" : ""}>${esc(o.name)}</option>`)
      .join("")}</select>`;
  const opts = ctx.assets.filterOptions();
  const open = ui.alOpen ? m.rows.find((r) => r.assetId === ui.alOpen) || ctx.assets.libraryOne(ui.alOpen) : null;
  const heading = drawer
    ? drawerTop(shotId)
    : head(
      "资产库",
      `${m.shown} / ${m.total} 个资产 · ${m.unusedCount} 个未被使用${m.needsReview ? ` · ${m.needsReview} 个待分类` : ""}`,
    );
  const body =
    `<div class="al-bar">${tabs}</div>` +
    `<div class="al-bar2">` +
    `<input class="field al-search" placeholder="搜索名称 / 标签 / 人物 / 场景 / 剧集…" value="${esc(f.search || "")}">` +
    sel("character", "人物", opts.characters, f.characterId) +
    sel("location", "场景地", opts.locations, f.locationId) +
    sel("episode", "剧集", opts.episodes, f.episodeId) +
    sel("source", "来源", opts.sources, f.source) +
    `<label class="al-toggle"><input type="checkbox" data-al-reusableonly ${f.reusable ? "checked" : ""}> 只看可复用</label>` +
    `<label class="al-toggle"><input type="checkbox" data-al-historical ${f.variant === "historical" ? "checked" : ""}> 历史版本</label>` +
    `<label class="al-toggle"><input type="checkbox" data-al-recent ${f.recent ? "checked" : ""}> 最近登记</label>` +
    `</div>` +
    (tagChips ? `<div class="al-tags">${tagChips}</div>` : "") +
    `<div class="al-body">` +
    `<div class="al-grid">${m.rows.length
      ? m.rows.map((a) => card(a, { drawer })).join("")
      : `<div class="al-none">没有符合条件的资产。</div>`}</div>` +
    // the inspector is page-only: a drawer is opened to PICK something, and a full
    // provenance panel inside it would compete with the one decision it exists for
    (!drawer && open ? inspector(open, ctx.assets.provenanceOf(open.assetId)) : "") +
    `</div>`;
  return drawer ? `<div class="al-drawer">${heading}${body}</div>` : heading + body;
}

/** The drawer's own header. Says WHICH shot it will add to — a picker that does not
 *  name its target is how a reference lands on the wrong shot. */
function drawerTop(shotId) {
  return (
    `<div class="al-dtop"><b>添加参考</b>` +
    (shotId
      ? `<span class="al-dscope">加入到 ${esc(shotId)}</span>`
      : `<span class="al-dscope warn">还没有选中镜头——先选一个镜头再加入</span>`) +
    `<button class="al-dx" data-al-drawer-close="1" title="关闭">✕</button></div>` +
    `<div class="meta">这就是 ⑪ 资产库本身，只是换了尺寸：同一套筛选、同一批卡片。</div>`
  );
}

export function bindAssetLibrary(root, ctx, ui, render) {
  ui.alFilters = ui.alFilters || {};
  const setF = (patch) => { ui.alFilters = { ...ui.alFilters, ...patch }; render(); };
  root.querySelectorAll("[data-al-type]").forEach((b) => (b.onclick = () => setF({ type: b.dataset.alType })));
  root.querySelectorAll("[data-al-tag]").forEach((b) => (b.onclick = () => setF({
    tag: ui.alFilters.tag === b.dataset.alTag ? null : b.dataset.alTag,
  })));
  root.querySelectorAll("[data-al-open]").forEach((b) => (b.onclick = () => {
    ui.alOpen = b.dataset.alOpen;
    render();
  }));
  // The whole card opens the asset, but a click that lands on a media control
  // belongs to that control: pressing play on an audio card must play it, not
  // navigate away from it. (The <audio>/<video> element cannot live inside the
  // caption button at all — nested interactive content is invalid HTML and the
  // browser is free to route the click to the outer button.)
  root.querySelectorAll("[data-al-card]").forEach((el) => (el.onclick = (ev) => {
    if (ev.target.closest("audio,video,button")) return;
    ui.alOpen = el.dataset.alCard;
    render();
  }));
  const on = (sel, ev, fn) => {
    const el = root.querySelector(sel);
    if (el) el[ev] = fn;
  };
  // search does NOT re-render per keystroke — it would destroy the field the
  // creator is typing in (the same lesson fieldsync.js encodes for the domain)
  const search = root.querySelector(".al-search");
  if (search) {
    search.onchange = () => setF({ search: search.value });
    search.onkeydown = (e) => { if (e.key === "Enter") setF({ search: search.value }); };
  }
  on("[data-al-character]", "onchange", (e) => setF({ characterId: e.target.value || null }));
  on("[data-al-location]", "onchange", (e) => setF({ locationId: e.target.value || null }));
  on("[data-al-episode]", "onchange", (e) => setF({ episodeId: e.target.value || null }));
  on("[data-al-source]", "onchange", (e) => setF({ source: e.target.value || null }));
  on("[data-al-reusableonly]", "onchange", (e) => setF({ reusable: e.target.checked }));
  on("[data-al-historical]", "onchange", (e) => setF({ variant: e.target.checked ? "historical" : "current" }));
  on("[data-al-recent]", "onchange", (e) => setF({ recent: e.target.checked }));
  on("[data-al-close]", "onclick", () => { ui.alOpen = null; render(); });
  // --- inspector edits: the ONE declaration write path -------------------- //
  const rename = root.querySelector(".al-rename");
  if (rename) rename.onchange = () => { ctx.assets.update(ui.alOpen, { displayName: rename.value }); render(); };
  const tag = root.querySelector(".al-tag");
  if (tag) {
    tag.onkeydown = (e) => {
      if (e.key !== "Enter" || !tag.value.trim()) return;
      ctx.assets.addTag(ui.alOpen, tag.value);
      tag.value = "";
      render();
    };
  }
  on("[data-al-reusable]", "onchange", (e) => { ctx.assets.setReusable(ui.alOpen, e.target.checked); render(); });
}
