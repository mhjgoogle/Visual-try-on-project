// 世界观 World Setting (ADR-0054 决策 4, extended TASK-065 §4).
//
//   [世界设定] [场景地]
//
// 场景地 MOVED HERE FROM 人物 (§4). A location is not a person. Filing 暗夜酒吧 under
// 人物 is why this screen used to be an essay page that pointed AT the real location
// canon rather than being it — and it made a creator looking for 「医院走廊长什么样」
// open the character workspace.
//
// The two halves are genuinely different and both belong here:
//
//   世界设定   the upstream Canon — 时代 / 世界规则 / 社会背景 / 视觉基调 / 氛围.
//              Creative direction, one confirmable revision, no media.
//   场景地     the reusable LOCATION archive — Location · LocationState ·
//              场景 Reference Image · 场景基础 Prompt. Real objects a Scene
//              references BY ID, and real media a Shot reuses.
//
// STILL NOT A SECOND LOCATION DATABASE. `production.locations` / LocationState keep
// their own canonical domain exactly as before; this screen is now the place they
// are EDITED instead of a page that links to somewhere else. A Scene's locationRef
// always resolves against that domain, never against anything here.
//
// The 基础资产 panel is shared with 人物 (ui/baseassetpanel.js): a location needs the
// same four things a character does — a reference, per-state references, a base
// image prompt, and honest gaps.
import { esc } from "../util/dom.js";
import { WORLD_FIELDS } from "../workflow/canondoc.js";
import { settingsModel, bibleFields, bindSettings } from "./workspaces.js";
import { head, empty } from "./shell.js";
import { bindField, restoreFieldFocus } from "./fieldsync.js";
import { renderBaseAssetPanel, bindBaseAssetPanel } from "./baseassetpanel.js";

export const WORLD_TABS = [
  ["world", "世界设定"],
  ["locations", "场景地"],
];

const FIELDS = [
  ["era", "时间 / 时代", "如：2019 年冬，某座沿海二线城市", 2, true],
  ["rules", "世界规则", "这个世界里什么可能、什么不可能，代价是什么", 3, true],
  ["society", "社会背景", "权力结构、阶层、行业生态、群体情绪", 3, false],
  ["regions", "主要区域", "作品活动范围（几个区域即可，不必穷举）", 2, false],
  ["places", "主要地点", "创作方向层面的地点（具体场景地在右边的「场景地」页签）", 2, false],
  ["visualTone", "视觉基调", "色调、光线、质感、镜头语言倾向", 2, false],
  ["atmosphere", "整体氛围", "观众看完一集应该留下的感觉", 2, false],
];

/** Pure view-model of the world CANON half. Exported for node --test. */
export function worldModel(pd) {
  const prod = pd.production;
  if (!prod || !prod.world || !prod.canon) return { empty: true };
  const w = prod.world;
  return {
    empty: false,
    world: w,
    filled: WORLD_FIELDS.filter((k) => w[k].trim()).length,
    total: WORLD_FIELDS.length,
    revision: prod.canon.world,
    locationCount: Array.isArray(prod.locations) ? prod.locations.length : 0,
  };
}

/** The reference a card shows: the active one, else the first, else nothing. */
function heroRef(refs) {
  return refs.find((r) => r.active && r.url) || refs.find((r) => r.url) || null;
}

function locCardHtml(l, ba, open) {
  const hero = heroRef(l.refs);
  const states = l.states.map((s) => `<span class="chip mute">${esc(s.name)}</span>`).join("");
  const gaps = ba && ba.gaps.length
    ? `<div class="rw"><span class="chip gate" title="${esc(ba.gaps.join("；"))}">缺 ${ba.gaps.length} 项基础资产</span></div>`
    : `<div class="rw"><span class="chip ok">基础资产齐</span></div>`;
  return (
    `<button class="bcard${open ? " on" : ""}" data-lopen="${esc(l.locationId)}">` +
    (hero
      ? `<img class="por loc" src="${esc(hero.url)}" alt="${esc(l.name)}" loading="lazy">`
      : `<div class="por loc media-none"><span class="ic">📍</span><span>还没有参考图</span></div>`) +
    `<div class="bd">` +
    `<div class="nm"><b>${esc(l.name)}</b><span class="role">${l.episodes.length ? `用于 ${l.episodes.length} 集` : "未使用"}</span></div>` +
    (states ? `<div class="rw">${states}</div>` : `<div class="meta">（没有状态：日 / 夜 / 雨夜 / 停电…）</div>`) +
    gaps +
    `</div></button>`
  );
}

function locDrawer(ctx, m, ui) {
  if (!ui.worldOpen) return "";
  const l = m.locations.find((x) => x.locationId === ui.worldOpen);
  if (!l) return "";
  const f = bibleFields(m);
  const ba = ctx.baseAssets.one("location", l.locationId);
  return (
    `<aside class="drawer wide"><div class="drawer-h"><div class="ti">${esc(l.name)}</div>` +
    `<span class="chip">${l.states.length} 个状态</span><span class="chip">${l.refs.length} 张参考图</span>` +
    `<button class="btn sm x" data-lclose>✕</button></div>` +
    `<div class="drawer-b">` +
    `<div>${renderBaseAssetPanel(ctx, ba, ui)}</div>` +
    `<div><div class="lab">场景地设定</div>${f.locCard(l, true)}</div>` +
    `</div></aside>`
  );
}

export function renderWorldWs(ctx, ui) {
  const pd = ctx.prodData();
  const m = worldModel(pd);
  if (m.empty) return head("世界观", "项目级") + empty("🌐", "世界观不可用", "生产域文档未加载。");
  const sm = settingsModel(pd);
  const tab = WORLD_TABS.some(([k]) => k === ui.worldTab) ? ui.worldTab : "world";
  const locCount = sm.empty ? 0 : sm.locations.length;
  const tabs =
    `<div class="vtabs">` +
    WORLD_TABS.map(([k, label]) =>
      `<button class="vtab${k === tab ? " on" : ""}" data-wtab="${k}">${esc(label)}` +
      (k === "locations" ? `<span class="ct">${locCount}</span>` : "") + `</button>`).join("") +
    `</div>`;

  if (tab === "locations") {
    const baModel = ctx.baseAssets.model();
    const baOf = (lid) => (baModel.empty ? null : baModel.locations.find((x) => x.entityId === lid) || null);
    const body = sm.empty
      ? empty("📍", "场景地不可用", "生产域文档未加载。")
      : sm.locations.length
        ? `<div class="biblegrid">${sm.locations.map((l) => locCardHtml(l, baOf(l.locationId), ui.worldOpen === l.locationId)).join("")}</div>` +
          `<div class="row"><button class="btn" data-b-locadd>＋ 新建场景地</button></div>`
        : empty(
            "📍",
            "还没有场景地",
            "场景地是可复用的地点档案：暗夜酒吧 / 医院走廊 / 天台雨夜。场景按 ID 引用它，不复制；参考图和基础 Prompt 都挂在这里，后续镜头直接复用。",
            `<div class="row"><button class="btn primary" data-b-locadd>＋ 新建场景地</button></div>`,
          );
    return (
      head("世界观 · 场景地", `${locCount} 个可复用地点 · 参考图与基础 Prompt 都在这里`) +
      tabs +
      `<div class="meta cb-note">场景地从「人物」搬到这里：地点不属于人物。场景（Scene）按 ID 引用这些档案，` +
      `绝不复制它们 —— 改这里一次，引用它的每一个场景都跟着变。</div>` +
      body +
      (sm.empty ? "" : locDrawer(ctx, sm, ui))
    );
  }

  const buf = ui.worldBuffer || {};
  const val = (k) => (k in buf ? buf[k] : m.world[k]);
  const standing =
    (m.revision ? `<span class="chip ok">世界观 v${m.revision}</span>` : `<span class="chip mute">尚未确认版本</span>`) +
    `<span class="chip${m.filled === m.total ? " ok" : ""}">${m.filled}/${m.total} 项已填</span>` +
    `<button class="btn sm" data-canon-confirm="world">✔ 确认世界观版本</button>`;
  const cards = FIELDS.map(([k, label, ph, rows, lead]) =>
    `<div class="story-card${rows >= 3 || lead ? " wide" : ""}"><div class="hd"><h4>${esc(label)}</h4></div>` +
    `<textarea class="field" rows="${rows}" spellcheck="false" placeholder="${esc(ph)}" data-w-field="${k}">${esc(val(k))}</textarea></div>`,
  ).join("");
  const locNote =
    `<div class="story-card wide"><div class="hd"><span class="ic">📍</span><h4>具体场景地</h4>` +
    `<span class="push"></span><button class="btn sm" data-wtab="locations">→ 场景地（${m.locationCount}）</button></div>` +
    `<div class="tx">世界观是上游设定；可复用的具体场景地（含日/夜/雨夜等状态、参考图、基础生图 Prompt）` +
    `在旁边的「场景地」页签里。这里的「主要地点」只是创作方向，不是第二份地点数据库。</div></div>`;
  return (
    head("世界观", "项目级 · 整部作品的世界 Canon；随时可回来修改", standing) +
    tabs +
    `<div class="meta cb-note">编辑即自动保存。只有「确认世界观版本」才会形成下游可依据的版本号 —— 已有剧集不会被自动改写，只会显示「上游变化」。` +
    `「视觉基调」会被编译进每个场景地的基础生图 Prompt。</div>` +
    `<div class="story-grid">${cards}${locNote}</div>`
  );
}

export function bindWorldWs(root, ctx, ui, rerender = () => {}) {
  root.querySelectorAll("[data-wtab]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    ui.worldTab = b.dataset.wtab;
    ui.worldOpen = null;
    ui.bpText = null;
    rerender();
  }));
  const tab = WORLD_TABS.some(([k]) => k === ui.worldTab) ? ui.worldTab : "world";

  if (tab === "locations") {
    // every editable field in the location drawer keeps the exact wiring
    // `bindSettings` already provides — this screen changed WHERE locations are
    // edited, never HOW
    bindSettings(root, ctx, ui);
    const add = root.querySelector("[data-b-locadd]");
    if (add)
      add.onclick = (ev) => {
        ev.stopPropagation();
        const t = window.prompt("场景地名称（如：暗夜酒吧 / 医院走廊 / 天台雨夜）");
        if (t == null || !t.trim()) return;
        const rec = ctx.bible.addLocation(t.trim());
        if (rec) { ui.worldOpen = rec.locationId; ui.bpText = null; rerender(); }
      };
    root.querySelectorAll("[data-lopen]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      if (ui.worldOpen !== b.dataset.lopen) ui.bpText = null;
      ui.worldOpen = b.dataset.lopen;
      ui.baRefPick = null;
      rerender();
    }));
    const x = root.querySelector("[data-lclose]");
    if (x) x.onclick = () => { ui.worldOpen = null; ui.bpText = null; rerender(); };
    root.querySelectorAll("[data-bstate]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.bstate;
      ui.bibleState[id] = ui.bibleState[id] === b.dataset.sid ? null : b.dataset.sid;
      rerender();
    }));
    if (ui.worldOpen) {
      bindBaseAssetPanel(root, ctx, ui, rerender, { kind: "location", entityId: ui.worldOpen });
    }
    return;
  }

  const buf = ui.worldBuffer || (ui.worldBuffer = {});
  // AUTOSAVE ON INPUT (see ui/fieldsync.js): updateWorld re-renders through
  // prodOp, so the write is debounced and the caret is restored below.
  root.querySelectorAll("[data-w-field]").forEach((el) => {
    bindField(el, ui, (value) => ctx.canon.updateWorld({ [el.dataset.wField]: value }), {
      onInput: (value) => { buf[el.dataset.wField] = value; },
    });
  });
  root.querySelectorAll("[data-canon-confirm]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    ctx.canon.confirm(b.dataset.canonConfirm);
  }));
  restoreFieldFocus(root, ui);
}
