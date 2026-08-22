// 人物 — the CHARACTER workspace (TASK-065 §1 / §2 / §3).
//
//   [正式角色] [临时角色] [人物关系]
//
// THREE TABS, ONE SUBJECT. 人物关系 moved in from its own rail entry (§2): a
// relationship connects two characters and has no meaning without them, so asking
// the creator to leave the person they are looking at in order to describe who that
// person is to someone else was two entrances for one subject.
//
// THREE TABS LEFT (§3). 场景地 moved to 世界观 — a location is not a person, and
// filing it under 人物 is why 「世界观」 read as an empty essay page while the real
// location canon lived somewhere else. 声音 and 风格 were READ LENSES over data that
// lives on the entities: both are now edited on the card that owns them, which is
// where a creator looks for them anyway. Nothing was deleted — 基础声音 is a section
// of the character's own 基础资产 panel, and 画面指令 is the field it always was.
//
// A CHARACTER IS NOT TEXT (§1). Clicking a card opens 设定 + 基础资产 side by side:
// the reference image, the per-state references, the base image prompt and the base
// voice — the things every downstream shot REUSES. The panel is shared with 世界观
// (ui/baseassetpanel.js), because a location needs exactly the same four things.
//
// PURE PRESENTATION. The detail fields are `workspaces.bibleFields()` verbatim, so
// every editable control keeps the exact data-* hook `bindSettings` already wires:
// this screen changes what you SEE, never what the bible DOES.
import { esc } from "../util/dom.js";
import { settingsModel, bibleFields, renderBreakdownPanel, bindSettings } from "./workspaces.js";
import { head, empty } from "./shell.js";
import { renderRelWs, bindRelWs } from "./relws.js";
import { renderBaseAssetPanel, bindBaseAssetPanel } from "./baseassetpanel.js";

/** §3: 场景地 / 声音 / 风格 are gone from here. 场景地 lives in 世界观 (its own
 *  canon), and the other two are sections of the card that owns them. */
export const TABS = [
  ["characters", "正式角色"],
  ["bits", "临时角色"],
  ["relationships", "人物关系"],
];

/** 正式 vs 临时 (TASK-057 / ADR-0054 决策 7). A bit part (服务员、路人、警察、
 *  医生) is a real identity with real references — it simply is not expected to
 *  carry a full Character Bible, and can be promoted at any time WITHOUT losing
 *  anything, because promotion only flips this flag. */
const isBit = (c) => c.tier === "bit";

/** The reference a card should show: the entity's active reference, else its
 *  first, else nothing (never a fabricated image). */
function heroRef(refs) {
  return refs.find((r) => r.active && r.url) || refs.find((r) => r.url) || null;
}

function refVersionLabel(refs) {
  const i = refs.findIndex((r) => r.active);
  return i >= 0 ? `v${i + 1}` : refs.length ? "未选定" : "无";
}

/** One character card. The BASE-ASSET standing is on the face of it — 「有没有参考
 *  图 / 有没有声音 / 有几个状态」 is what decides whether a shot can reuse this
 *  character, so it is not something to find by opening the card. */
function charCardHtml(c, ba, open) {
  const hero = heroRef(c.refs);
  const states = c.states.slice(0, 5)
    .map((s) => `<span class="chip mute">${esc(s.name)}</span>`)
    .join("");
  const appears = c.episodes.length
    ? c.episodes.slice(0, 4).map((t) => esc(String(t).split(" ")[0])).join(" · ")
    : "尚未出场";
  const gaps = ba && ba.gaps.length
    ? `<div class="rw"><span class="chip gate" title="${esc(ba.gaps.join("；"))}">缺 ${ba.gaps.length} 项基础资产</span></div>`
    : `<div class="rw"><span class="chip ok">基础资产齐</span></div>`;
  return (
    `<button class="bcard${open ? " on" : ""}" data-bopen="c:${esc(c.characterId)}">` +
    (hero
      ? `<img class="por" src="${esc(hero.url)}" alt="${esc(c.name)}" loading="lazy">`
      : `<div class="por media-none"><span class="ic">👤</span><span>还没有参考图</span></div>`) +
    `<div class="bd">` +
    `<div class="nm"><b>${esc(c.name)}</b>` +
    (isBit(c) ? `<span class="chip mute">临时</span>` : "") +
    `<span class="role">${c.episodes.length ? `出现于 ${c.episodes.length} 集` : "未出场"}</span></div>` +
    `<div class="kv"><span class="k">出场</span><span class="v" style="font-size:var(--t-xs)">${appears}</span></div>` +
    (c.relationships && c.relationships.length
      ? `<div class="rw row tight"><span class="k">关系</span>${c.relationships.slice(0, 3).map((r) => `<span class="chip">${esc(r)}</span>`).join("")}` +
        (c.relationships.length > 3 ? `<span class="chip mute">+${c.relationships.length - 3}</span>` : "") + `</div>`
      : "") +
    `<div class="rw"><span class="k">参考</span><span class="chip ok">Reference ${esc(refVersionLabel(c.refs))}</span>` +
    (c.voice && (c.voice.voiceId || c.voice.description)
      ? `<span class="chip">🎤 ${esc(c.voice.voiceId || "已设定")}</span>`
      : `<span class="chip mute">🎤 未设定</span>`) +
    `</div>` +
    gaps +
    (states ? `<div class="rw">${states}${c.states.length > 5 ? `<span class="chip mute">+${c.states.length - 5}</span>` : ""}</div>` : "") +
    `</div></button>`
  );
}

/** The secondary detail drawer: 基础资产 first, then the full 设定 fields.
 *
 *  BASE ASSETS LEAD. The fields were here before and are unchanged, but a creator
 *  opening 林婉 is far more often going to attach a portrait or copy her prompt than
 *  to rewrite her 弱点 — and the assets are what every downstream shot depends on. */
function drawerHtml(ctx, m, ui) {
  if (!ui.bibleOpen) return "";
  const id = ui.bibleOpen.slice(2);
  const c = m.characters.find((x) => x.characterId === id);
  if (!c) return "";
  const f = bibleFields(m);
  const ba = ctx.baseAssets.one("character", c.characterId);
  const tierRow = isBit(c)
    ? `<div class="lab">角色层级</div><div class="row"><span class="chip mute">临时 / Episode Character</span>` +
      `<button class="btn primary sm" data-b-promote="${esc(c.characterId)}">↑ 提升为正式角色</button>` +
      `<span class="meta">提升保留已有剧情身份与全部引用</span></div>`
    : `<div class="lab">角色层级</div><div class="row"><span class="chip ok">正式角色</span>` +
      `<button class="btn sm" data-b-demote="${esc(c.characterId)}">↓ 改为临时角色</button></div>`;
  const relRow = c.relationships.length
    ? `<div class="lab">关键关系</div><div class="row tight">${c.relationships.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}` +
      `<button class="btn sm" data-btab-go="relationships">在关系图里编辑</button></div>`
    : `<div class="lab">关键关系</div><div class="row"><span class="meta">还没有关系定义</span>` +
      `<button class="btn sm" data-btab-go="relationships">→ 去关系图建立</button></div>`;
  return (
    `<aside class="drawer wide"><div class="drawer-h"><div class="ti">${esc(c.name)}</div>` +
    (isBit(c) ? `<span class="chip mute">临时</span>` : "") +
    `<span class="chip">${c.states.length} 个状态</span><span class="chip">${c.refs.length} 张参考图</span>` +
    `<button class="btn sm x" data-bclose>✕</button></div>` +
    `<div class="drawer-b">` +
    `<div>${renderBaseAssetPanel(ctx, ba, ui)}</div>` +
    `<div>${tierRow}${relRow}<div class="lab">人物设定</div>${f.charCard(c, true)}</div>` +
    `</div></aside>`
  );
}


/**
 * 从故事大纲的「主要角色概念」播下初始人物 (TASK-070).
 *
 * Shown only when the outline actually has concepts that are NOT yet in the cast —
 * a panel offering nothing is noise. Each row shows the concept VERBATIM and an
 * EDITABLE name: the split into name + 身份 is a heuristic, and a heuristic that
 * names a character without being seen is exactly what this codebase refuses. The
 * creator confirms one row at a time.
 */
function conceptSeeds(seeds) {
  if (!seeds || !seeds.rows.length) return "";
  const missing = seeds.rows.filter((r) => !r.exists);
  if (!missing.length) {
    return `<div class="meta cb-note">故事大纲的主要角色概念（${seeds.rows.length} 个）都已经在人物表里了。` +
      `剧本细化之后，「从剧本拆解」还会继续补充。</div>`;
  }
  return (
    `<section class="seedbox"><div class="hd"><b>从故事大纲的主要角色概念创建</b>` +
    `<span class="chip mute">大纲 v${esc(String(seeds.version))}${seeds.approved ? " · 已批准" : " · 未批准"}</span>` +
    `<span class="push"></span><span class="meta">${missing.length} 个还没有</span></div>` +
    `<div class="meta">名字是从概念里猜的——<b>先改对再创建</b>。其余文字会写进「身份」，` +
    `之后可以继续补，剧本拆解也会再补充。</div>` +
    missing.map((r, i) =>
      `<div class="seedrow"><span class="cpt" title="${esc(r.concept)}">${esc(r.concept)}</span>` +
      `<input class="ws-bibleinput sm" data-seed-name="${i}" value="${esc(r.name)}" placeholder="角色名">` +
      `<input type="hidden" data-seed-identity="${i}" value="${esc(r.identity)}">` +
      `<button class="btn sm primary" data-seed-add="${i}">创建</button></div>`).join("") +
    `</section>`
  );
}

export function renderBibleWs(ctx, ui) {
  const m = settingsModel(ctx.prodData());
  if (m.empty) {
    return head("人物", "项目级") + empty("🎭", "人物设定不可用", "生产域文档未加载。");
  }
  const tab = TABS.some(([k]) => k === ui.bibleTab) ? ui.bibleTab : "characters";
  const formal = m.characters.filter((c) => !isBit(c));
  const bits = m.characters.filter(isBit);
  const baModel = ctx.baseAssets.model();
  const baOf = (cid) => (baModel.empty ? null : baModel.characters.find((x) => x.entityId === cid) || null);
  const relCount = (ctx.prodData().production.relationships || []).length;
  const tabs =
    `<div class="vtabs">` +
    TABS.map(([k, label]) => {
      const n = k === "characters" ? formal.length
        : k === "bits" ? bits.length
          : relCount;
      return `<button class="vtab${k === tab ? " on" : ""}" data-btab="${k}">${esc(label)}<span class="ct">${n}</span></button>`;
    }).join("") +
    `</div>`;

  // 人物可以在项目任何阶段继续新增 — never a "create the whole cast up front" gate
  const addRow =
    `<div class="row"><button class="btn" data-b-chadd>＋ 添加人物</button>` +
    `<button class="btn" data-b-chadd-bit>＋ 添加临时角色</button>` +
    `<span class="meta">随时可以继续加人；临时角色（服务员/路人/警察/医生）不需要完整档案。</span></div>`;

  let body;
  if (tab === "characters") {
    // 人物设定 comes AFTER 故事大纲 in the spine, so the outline's cast concepts are
    // the natural way to start it — 剧本拆解 then refines (产品 2026-08-13).
    const seeds = ctx.bible.conceptSeeds ? ctx.bible.conceptSeeds() : null;
    const seedPanel = conceptSeeds(seeds);
    body = formal.length
      ? seedPanel + `<div class="biblegrid">${formal.map((c) => charCardHtml(c, baOf(c.characterId), ui.bibleOpen === `c:${c.characterId}`)).join("")}</div>` + addRow
      : seedPanel + empty("👤", "还没有正式角色",
        "角色是跨镜头、跨集一致性的锚点：一个稳定身份 + 参考图 + 基础声音 + 若干状态。初始阵容从故事大纲的主要角色概念来；剧本写出来之后，「从剧本拆解」会继续补充。",
        `<div class="row"><button class="btn primary" data-bd-run>🪄 从剧本拆解</button><button class="btn" data-b-chadd>＋ 添加人物</button></div>`);
  } else if (tab === "bits") {
    body =
      `<div class="meta cb-note">临时 / Episode Character：只需要一个名字就能用起来。当某个临时角色开始承担剧情时，「提升为正式角色」会保留它已有的剧情身份与全部引用（参考图、场景出场、关系、beat）。</div>` +
      (bits.length
        ? `<div class="biblegrid">${bits.map((c) => charCardHtml(c, baOf(c.characterId), ui.bibleOpen === `c:${c.characterId}`)).join("")}</div>`
        : empty("🧍", "还没有临时角色", "服务员、路人、警察、医生——需要时随手加，不必填写完整 Character Bible。", "")) +
      `<div class="row"><button class="btn" data-b-chadd-bit>＋ 添加临时角色</button></div>` +
      // ADR-0054 决策 7/§10: the decision path exists in the domain and the UI;
      // there is no AI proposal route wired yet, so it is stated, not simulated.
      `<div class="dir-unavail">◌ AI 主动提出「本集需要一名值班医生」的提案通道尚未接入（需另立 ADR）。接入后仍然只能是提案：创建正式角色 / 作为临时角色 / 忽略 —— 未经确认不写入 Canon。</div>`;
  } else {
    // 人物关系 — the graph, mounted as a tab (§2). Its own module still owns the
    // rendering and the writes; this workspace only gives it a place to live.
    body = renderRelWs(ctx, ui);
  }

  // the 人物 canon revision — bumped ONLY here, by an explicit confirmation
  const rev = ctx.prodData().production.canon.characters;
  const confirm = tab === "relationships"
    ? ""
    : `<button class="btn sm" data-canon-confirm="characters">✔ 确认人物设定版本</button>` +
      (rev ? `<span class="chip ok">人物设定 v${rev}</span>` : `<span class="chip mute">尚未确认版本</span>`);
  return (
    head(
      "人物",
      `${formal.length} 个正式角色 · ${bits.length} 个临时角色 · ${relCount} 段关系` +
      `　（场景地在「世界观」）`,
      confirm,
    ) +
    (tab === "relationships" ? "" : renderBreakdownPanel(ctx, m)) +
    tabs +
    body +
    (tab === "relationships" ? "" : drawerHtml(ctx, m, ui))
  );
}

export function bindBibleWs(root, ctx, ui, rerender) {
  const tab = TABS.some(([k]) => k === ui.bibleTab) ? ui.bibleTab : "characters";
  root.querySelectorAll("[data-btab]").forEach((b) => (b.onclick = () => {
    ui.bibleTab = b.dataset.btab;
    ui.bibleOpen = null;
    ui.bpText = null;
    rerender();
  }));
  // 「在关系图里编辑」 — a TAB switch, not a navigation. Before §2 this was
  // `data-goto="relationships"`, i.e. a jump to another rail entry; now the
  // relationship graph is right here.
  root.querySelectorAll("[data-btab-go]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    ui.bibleTab = b.dataset.btabGo;
    ui.bibleOpen = null;
    rerender();
  }));

  if (tab === "relationships") {
    bindRelWs(root, ctx, ui, rerender);
    // 添加人物 is reachable from the relationship tab's empty state, so it binds
    // here too — an empty state whose button does nothing is worse than no button.
    bindAddCharacter(root, ctx, ui, rerender);
    return;
  }

  // every editable control in the drawer keeps its original wiring
  // `ui` carries the field-sync state so a character edit autosaves on input
  // and the caret survives the re-render the write triggers
  bindSettings(root, ctx, ui);
  bindAddCharacter(root, ctx, ui, rerender);
  root.querySelectorAll("[data-b-promote]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    if (ctx.bible.setCharacterTier(b.dataset.bPromote, "formal")) {
      ui.bibleTab = "characters";
      rerender();
      ctx.toast("已提升为正式角色 — 原有剧情身份、参考图、场景出场与关系全部保留");
    }
  }));
  root.querySelectorAll("[data-b-demote]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    if (ctx.bible.setCharacterTier(b.dataset.bDemote, "bit")) { ui.bibleTab = "bits"; rerender(); }
  }));
  root.querySelectorAll("[data-bopen]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    // opening a DIFFERENT card drops the unsaved base-prompt buffer: it belongs to
    // the entity it was typed against, and carrying it over would offer character B
    // the prompt written for A and save it there (same rule as ui.piPrompt)
    if (ui.bibleOpen !== b.dataset.bopen) ui.bpText = null;
    ui.bibleOpen = b.dataset.bopen;
    ui.baRefPick = null;
    ui.baVoicePick = null;
    rerender();
  }));
  root.querySelectorAll("[data-canon-confirm]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    ctx.canon.confirm(b.dataset.canonConfirm);
  }));
  const x = root.querySelector("[data-bclose]");
  if (x) x.onclick = () => { ui.bibleOpen = null; ui.bpText = null; rerender(); };
  // state preview inside the drawer is pure UI (which state's overrides the
  // creator is looking at) — it never writes to the document
  root.querySelectorAll("[data-bstate]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.bstate;
    ui.bibleState[id] = ui.bibleState[id] === b.dataset.sid ? null : b.dataset.sid;
    rerender();
  }));
  // the 基础资产 panel — bound LAST and only for the character actually open, so its
  // handlers cannot be attached for an entity the drawer is not showing
  if (ui.bibleOpen && ui.bibleOpen.startsWith("c:")) {
    bindBaseAssetPanel(root, ctx, ui, rerender, { kind: "character", entityId: ui.bibleOpen.slice(2) });
  }
}

/** 添加人物 / 添加临时角色 — shared by the card tabs and the relationship tab's
 *  empty state, so the same button cannot be live on one screen and dead on
 *  another. */
function bindAddCharacter(root, ctx, ui, rerender) {
  // 从大纲概念创建 — the NAME comes from the field the creator just saw and could
  // correct, never from the heuristic split alone.
  root.querySelectorAll("[data-seed-add]").forEach((btn) => (btn.onclick = (ev) => {
    ev.stopPropagation();
    const i = btn.dataset.seedAdd;
    const nameEl = root.querySelector(`[data-seed-name="${i}"]`);
    const idEl = root.querySelector(`[data-seed-identity="${i}"]`);
    const rec = ctx.bible.seedCharacter(nameEl ? nameEl.value : "", idEl ? idEl.value : "");
    if (rec) rerender();
  }));
  const addFormal = root.querySelector("[data-b-chadd]");
  if (addFormal)
    addFormal.onclick = (e) => {
      e.stopPropagation();
      const t = window.prompt("人物名称");
      if (t == null || !t.trim()) return;
      const rec = ctx.bible.addCharacter(t.trim());
      if (rec) { ui.bibleTab = "characters"; ui.bibleOpen = `c:${rec.characterId}`; rerender(); }
    };
  const addBit = root.querySelector("[data-b-chadd-bit]");
  if (addBit)
    addBit.onclick = (e) => {
      e.stopPropagation();
      const t = window.prompt("临时角色名称（如：值班医生 / 服务员 / 路人）");
      if (t == null) return;
      const rec = ctx.bible.addCharacter(t.trim(), "bit");
      if (rec) { ui.bibleTab = "bits"; ui.bibleOpen = `c:${rec.characterId}`; rerender(); }
    };
}
