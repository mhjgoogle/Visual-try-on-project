// 世界观 World Setting — upstream Canon (ADR-0054 决策 4).
//
// The world the whole work happens in: 时代 / 世界规则 / 社会背景 / 主要区域 /
// 主要地点方向 / 视觉基调 / 整体氛围. High-density cards, autosaved, with one
// explicit 「确认版本」 that downstream episodes can be based on.
//
// NOT a location database. `production.locations` / LocationState keep their own
// canonical domain: a Scene's locationRef always resolves there, never here.
// This screen says so on screen, and links across instead of duplicating.
import { esc } from "../util/dom.js";
import { WORLD_FIELDS } from "../workflow/canondoc.js";
import { head, empty } from "./shell.js";

const FIELDS = [
  ["era", "时间 / 时代", "如：2019 年冬，某座沿海二线城市", 2, true],
  ["rules", "世界规则", "这个世界里什么可能、什么不可能，代价是什么", 3, true],
  ["society", "社会背景", "权力结构、阶层、行业生态、群体情绪", 3, false],
  ["regions", "主要区域", "作品活动范围（几个区域即可，不必穷举）", 2, false],
  ["places", "主要地点", "创作方向层面的地点（具体场景地档案在「人物 · 场景地」里）", 2, false],
  ["visualTone", "视觉基调", "色调、光线、质感、镜头语言倾向", 2, false],
  ["atmosphere", "整体氛围", "观众看完一集应该留下的感觉", 2, false],
];

/** Pure view-model. Exported for node --test. */
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
    // the separate, canonical location domain — surfaced as a cross-link so the
    // creator is never tempted to re-type地点 here
    locationCount: Array.isArray(prod.locations) ? prod.locations.length : 0,
  };
}

export function renderWorldWs(ctx, ui) {
  const m = worldModel(ctx.prodData());
  if (m.empty) return head("世界观", "项目级") + empty("🌐", "世界观不可用", "生产域文档未加载。");
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
    `<span class="push"></span><button class="btn sm" data-goto="characters">→ 去场景地库</button></div>` +
    `<div class="tx">世界观是上游设定；可复用的具体场景地（含日/夜等状态、参考图）有自己的档案库 — ` +
    `当前 ${m.locationCount} 个。世界观里的「主要地点」只是创作方向，不是第二份地点数据库。</div></div>`;

  return (
    head("世界观", "项目级 · 整部作品的世界 Canon；随时可回来修改", standing) +
    `<div class="meta cb-note">编辑即自动保存。只有「确认世界观版本」才会形成下游可依据的版本号 —— 已有剧集不会被自动改写，只会显示「上游变化」。</div>` +
    `<div class="story-grid">${cards}${locNote}</div>`
  );
}

export function bindWorldWs(root, ctx, ui) {
  const buf = ui.worldBuffer || (ui.worldBuffer = {});
  root.querySelectorAll("[data-w-field]").forEach((el) => {
    el.oninput = () => { buf[el.dataset.wField] = el.value; };
    el.onchange = () => ctx.canon.updateWorld({ [el.dataset.wField]: el.value });
  });
  root.querySelectorAll("[data-canon-confirm]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    ctx.canon.confirm(b.dataset.canonConfirm);
  }));
}
