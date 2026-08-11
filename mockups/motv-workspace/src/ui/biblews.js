// 作品设定工作区 — card/gallery-first Production Bible.
//
// The landing surface is a PORTRAIT GALLERY: one card per character/location
// showing the reference image, the appearances derived from scene references,
// the active state, the chosen reference version and the voice. Detailed
// fields only exist inside a secondary drawer, opened by clicking a card —
// the old accordion-of-forms home screen is gone.
//
// The drawer reuses workspaces.bibleFields() verbatim, so every editable
// control keeps the exact data-* hook bindSettings already wires: this screen
// changes what you SEE first, never what the bible DOES.
import { esc } from "../util/dom.js";
import { settingsModel, bibleFields, renderBreakdownPanel, bindSettings } from "./workspaces.js";
import { head, empty } from "./shell.js";

const TABS = [
  ["characters", "正式角色"],
  ["bits", "临时角色"],
  ["locations", "场景地"],
  ["voices", "声音"],
  ["style", "风格"],
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

function charCardHtml(c, open) {
  const hero = heroRef(c.refs);
  const states = c.states.slice(0, 5)
    .map((s) => `<span class="chip mute">${esc(s.name)}</span>`)
    .join("");
  const appears = c.episodes.length
    ? c.episodes.slice(0, 4).map((t) => esc(String(t).split(" ")[0])).join(" · ")
    : "尚未出场";
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
    (states ? `<div class="rw">${states}${c.states.length > 5 ? `<span class="chip mute">+${c.states.length - 5}</span>` : ""}</div>` : "") +
    `</div></button>`
  );
}

function locCardHtml(l, open) {
  const hero = heroRef(l.refs);
  const states = l.states.map((s) => `<span class="chip mute">${esc(s.name)}</span>`).join("");
  return (
    `<button class="bcard${open ? " on" : ""}" data-bopen="l:${esc(l.locationId)}">` +
    (hero
      ? `<img class="por loc" src="${esc(hero.url)}" alt="${esc(l.name)}" loading="lazy">`
      : `<div class="por loc media-none"><span class="ic">📍</span><span>还没有参考图</span></div>`) +
    `<div class="bd">` +
    `<div class="nm"><b>${esc(l.name)}</b><span class="role">${l.episodes.length ? `用于 ${l.episodes.length} 集` : "未使用"}</span></div>` +
    (states ? `<div class="rw">${states}</div>` : `<div class="meta">（没有状态）</div>`) +
    `<div class="rw"><span class="chip ok">Reference ${esc(refVersionLabel(l.refs))}</span></div>` +
    `</div></button>`
  );
}

/** 声音 tab: one row per character — the ONE base voice identity plus the
 *  per-state performance modifiers (a state can never carry its own voice). */
function voicesHtml(m) {
  if (!m.characters.length) {
    return empty("🎤", "还没有角色", "声音档案挂在角色身份上——先建立角色，再为它设定基础声音。");
  }
  return (
    `<div class="stack">` +
    m.characters
      .map((c) => {
        const hero = heroRef(c.refs);
        const perf = c.states
          .filter((s) => s.overrides.voice && s.overrides.voice.description)
          .map((s) => `<span class="chip">${esc(s.name)} · ${esc(s.overrides.voice.description)}</span>`)
          .join("");
        return (
          `<div class="audiocard">` +
          (hero ? `<img class="por" src="${esc(hero.url)}" alt="">` : `<div class="por media-none"></div>`) +
          `<div class="bd"><div class="row"><b>${esc(c.name)}</b>` +
          (c.voice.voiceId ? `<span class="chip ok">${esc(c.voice.voiceId)}</span>` : `<span class="chip gate">未设定声音身份</span>`) +
          `<button class="btn sm push" data-bopen="c:${esc(c.characterId)}">编辑</button></div>` +
          `<div class="meta">${esc(c.voice.description || "（没有声音描述）")}</div>` +
          (perf ? `<div class="rw row tight">${perf}</div>` : "") +
          `</div></div>`
        );
      })
      .join("") +
    `</div>`
  );
}

/** 风格 tab: the project's visual instructions, gathered from the entities
 *  that actually carry them. Nothing new is stored — this is a read lens. */
function styleHtml(m) {
  const rows = [
    ...m.characters.filter((c) => c.profile.visualInstruction).map((c) => ["👤", c.name, c.profile.visualInstruction]),
    ...m.locations.filter((l) => l.profile.visualInstruction).map((l) => ["📍", l.name, l.profile.visualInstruction]),
  ];
  if (!rows.length) {
    return empty("🎨", "还没有画面指令", "为角色或场景地写下画面指令（打光/镜头/色调），它们会进入 Image Prompt 的编译结果。");
  }
  return (
    `<div class="story-grid">` +
    rows
      .map(([ic, name, tx]) =>
        `<div class="story-card"><div class="hd"><span class="ic">${ic}</span><h4>${esc(name)}</h4></div><div class="tx">${esc(tx)}</div></div>`,
      )
      .join("") +
    `<div class="story-card"><div class="hd"><span class="ic">ℹ</span><h4>风格来源</h4></div>` +
    `<div class="tx">画面指令存放在各自的角色 / 场景地档案里，这里只是汇总读取——不存第二份风格设定。</div></div>` +
    `</div>`
  );
}

/** The secondary detail drawer. Body = the SAME fields as before. */
function drawerHtml(m, ui) {
  if (!ui.bibleOpen) return "";
  const [kind, id] = [ui.bibleOpen.slice(0, 1), ui.bibleOpen.slice(2)];
  const f = bibleFields(m);
  if (kind === "c") {
    const c = m.characters.find((x) => x.characterId === id);
    if (!c) return "";
    const gal = c.refs
      .map((r, i) =>
        `<button class="g${r.active ? " on" : ""}" data-b-refactive="${esc(c.characterId)}" data-aid="${esc(r.assetId)}">` +
        (r.url ? `<img src="${esc(r.url)}" alt="">` : `<div class="media-none" style="aspect-ratio:3/4"><span class="ic">缺</span></div>`) +
        `<div class="cp">v${i + 1}${r.active ? " ·主" : ""}</div></button>`,
      )
      .join("");
    const states = c.states
      .map((s) => `<button class="sbtn${ui.bibleState[c.characterId] === s.stateId ? " on" : ""}" data-bstate="${esc(c.characterId)}" data-sid="${esc(s.stateId)}">${esc(s.name)}</button>`)
      .join("");
    // 提升为正式角色 / 降为临时角色 — identity-preserving either way
    const tierRow = isBit(c)
      ? `<div class="lab">角色层级</div><div class="row"><span class="chip mute">临时 / Episode Character</span>` +
        `<button class="btn primary sm" data-b-promote="${esc(c.characterId)}">↑ 提升为正式角色</button>` +
        `<span class="meta">提升保留已有剧情身份与全部引用</span></div>`
      : `<div class="lab">角色层级</div><div class="row"><span class="chip ok">正式角色</span>` +
        `<button class="btn sm" data-b-demote="${esc(c.characterId)}">↓ 改为临时角色</button></div>`;
    const relRow = c.relationships.length
      ? `<div class="lab">关键关系</div><div class="row tight">${c.relationships.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}` +
        `<button class="btn sm" data-goto="relationships">在「人物关系」编辑</button></div>`
      : `<div class="lab">关键关系</div><div class="row"><span class="meta">还没有关系定义</span>` +
        `<button class="btn sm" data-goto="relationships">→ 去建立关系</button></div>`;
    return (
      `<aside class="drawer"><div class="drawer-h"><div class="ti">${esc(c.name)}</div>` +
      (isBit(c) ? `<span class="chip mute">临时</span>` : "") +
      `<span class="chip">${c.states.length} 个状态</span><span class="chip">${c.refs.length} 张参考图</span>` +
      `<button class="btn sm x" data-bclose>✕</button></div>` +
      `<div class="drawer-b">` +
      `<div>${tierRow}${relRow}</div>` +
      (gal ? `<div><div class="lab">参考图库</div><div class="drawer-gal">${gal}</div></div>` : "") +
      (states ? `<div><div class="lab">角色状态</div><div class="statebar">${states}</div></div>` : "") +
      `<div>${f.charCard(c, true)}</div>` +
      `</div></aside>`
    );
  }
  const l = m.locations.find((x) => x.locationId === id);
  if (!l) return "";
  const gal = l.refs
    .map((r, i) =>
      `<button class="g${r.active ? " on" : ""}" data-b-refactive="${esc(l.locationId)}" data-aid="${esc(r.assetId)}">` +
      (r.url ? `<img src="${esc(r.url)}" alt="" style="aspect-ratio:16/9">` : `<div class="media-none" style="aspect-ratio:16/9"><span class="ic">缺</span></div>`) +
      `<div class="cp">v${i + 1}${r.active ? " ·主" : ""}</div></button>`,
    )
    .join("");
  const states = l.states
    .map((s) => `<button class="sbtn${ui.bibleState[l.locationId] === s.stateId ? " on" : ""}" data-bstate="${esc(l.locationId)}" data-sid="${esc(s.stateId)}">${esc(s.name)}</button>`)
    .join("");
  return (
    `<aside class="drawer"><div class="drawer-h"><div class="ti">${esc(l.name)}</div>` +
    `<span class="chip">${l.states.length} 个状态</span><span class="chip">${l.refs.length} 张参考图</span>` +
    `<button class="btn sm x" data-bclose>✕</button></div>` +
    `<div class="drawer-b">` +
    (gal ? `<div><div class="lab">参考图库</div><div class="drawer-gal">${gal}</div></div>` : "") +
    (states ? `<div><div class="lab">场景地状态</div><div class="statebar">${states}</div></div>` : "") +
    `<div>${f.locCard(l, true)}</div>` +
    `</div></aside>`
  );
}

export function renderBibleWs(ctx, ui) {
  const m = settingsModel(ctx.prodData());
  if (m.empty) {
    return head("作品设定", "项目级") + empty("🎭", "作品设定不可用", "生产域文档未加载。");
  }
  const tab = ui.bibleTab || "characters";
  const formal = m.characters.filter((c) => !isBit(c));
  const bits = m.characters.filter(isBit);
  const tabs =
    `<div class="vtabs">` +
    TABS.map(([k, label]) => {
      const n = k === "characters" ? formal.length
        : k === "bits" ? bits.length
          : k === "locations" ? m.locations.length : null;
      return `<button class="vtab${k === tab ? " on" : ""}" data-btab="${k}">${esc(label)}${n != null ? `<span class="ct">${n}</span>` : ""}</button>`;
    }).join("") +
    `</div>`;

  // 人物可以在项目任何阶段继续新增 — never a "create the whole cast up front" gate
  const addRow =
    `<div class="row"><button class="btn" data-b-chadd>＋ 添加人物</button>` +
    `<button class="btn" data-b-chadd-bit>＋ 添加临时角色</button>` +
    `<span class="meta">随时可以继续加人；临时角色（服务员/路人/警察/医生）不需要完整档案。</span></div>`;

  let body;
  if (tab === "characters") {
    body = formal.length
      ? `<div class="biblegrid">${formal.map((c) => charCardHtml(c, ui.bibleOpen === `c:${c.characterId}`)).join("")}</div>` + addRow
      : empty("👤", "还没有正式角色", "角色是跨镜头、跨集一致性的锚点：一个稳定身份 + 参考图 + 基础声音 + 若干状态。", `<div class="row"><button class="btn primary" data-bd-run>🪄 从剧本拆解</button><button class="btn" data-b-chadd>＋ 添加人物</button></div>`);
  } else if (tab === "bits") {
    body =
      `<div class="meta cb-note">临时 / Episode Character：只需要一个名字就能用起来。当某个临时角色开始承担剧情时，「提升为正式角色」会保留它已有的剧情身份与全部引用（参考图、场景出场、关系、beat）。</div>` +
      (bits.length
        ? `<div class="biblegrid">${bits.map((c) => charCardHtml(c, ui.bibleOpen === `c:${c.characterId}`)).join("")}</div>`
        : empty("🧍", "还没有临时角色", "服务员、路人、警察、医生——需要时随手加，不必填写完整 Character Bible。", "")) +
      `<div class="row"><button class="btn" data-b-chadd-bit>＋ 添加临时角色</button></div>` +
      // ADR-0054 决策 7/§10: the decision path exists in the domain and the UI;
      // there is no AI proposal route wired yet, so it is stated, not simulated.
      `<div class="dir-unavail">◌ AI 主动提出「本集需要一名值班医生」的提案通道尚未接入（需另立 ADR）。接入后仍然只能是提案：创建正式角色 / 作为临时角色 / 忽略 —— 未经确认不写入 Canon。</div>`;
  } else if (tab === "locations") {
    body = m.locations.length
      ? `<div class="biblegrid">${m.locations.map((l) => locCardHtml(l, ui.bibleOpen === `l:${l.locationId}`)).join("")}</div>` +
        `<div class="row"><button class="btn" data-b-locadd>＋ 新建场景地</button></div>`
      : empty("📍", "还没有场景地", "场景地是可复用的地点档案（可含日/夜/雨夜等状态）；场景按 ID 引用它，不复制。", `<div class="row"><button class="btn" data-b-locadd>＋ 新建场景地</button></div>`);
  } else if (tab === "voices") {
    body = voicesHtml(m);
  } else {
    body = styleHtml(m);
  }

  // the 人物 canon revision — bumped ONLY here, by an explicit confirmation
  const rev = ctx.prodData().production.canon.characters;
  const confirm =
    `<button class="btn sm" data-canon-confirm="characters">✔ 确认人物设定版本</button>` +
    (rev ? `<span class="chip ok">人物设定 v${rev}</span>` : `<span class="chip mute">尚未确认版本</span>`);
  return (
    head(
      "人物",
      `${formal.length} 个正式角色 · ${bits.length} 个临时角色 · ${m.locations.length} 个场景地`,
      confirm,
    ) +
    renderBreakdownPanel(ctx, m) +
    tabs +
    body +
    drawerHtml(m, ui)
  );
}

export function bindBibleWs(root, ctx, ui, rerender) {
  // every editable control in the drawer keeps its original wiring
  // `ui` carries the field-sync state so a character edit autosaves on input
  // and the caret survives the re-render the write triggers
  bindSettings(root, ctx, ui);
  root.querySelectorAll("[data-btab]").forEach((b) => (b.onclick = () => {
    ui.bibleTab = b.dataset.btab;
    ui.bibleOpen = null;
    rerender();
  }));
  // 临时角色 creation and promotion (TASK-057) — the tier is the ONLY thing that
  // changes; identity and every reference are preserved by the domain op.
  const addBit = root.querySelector("[data-b-chadd-bit]");
  if (addBit)
    addBit.onclick = () => {
      const t = window.prompt("临时角色名称（如：值班医生 / 服务员 / 路人）");
      if (t == null) return;
      const rec = ctx.bible.addCharacter(t.trim(), "bit");
      if (rec) { ui.bibleTab = "bits"; ui.bibleOpen = `c:${rec.characterId}`; rerender(); }
    };
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
    ui.bibleOpen = b.dataset.bopen;
    if (b.dataset.bopen.startsWith("l:")) ui.bibleTab = "locations";
    rerender();
  }));
  root.querySelectorAll("[data-canon-confirm]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    ctx.canon.confirm(b.dataset.canonConfirm);
  }));
  const x = root.querySelector("[data-bclose]");
  if (x) x.onclick = () => { ui.bibleOpen = null; rerender(); };
  // state preview inside the drawer is pure UI (which state's overrides the
  // creator is looking at) — it never writes to the document
  root.querySelectorAll("[data-bstate]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.bstate;
    ui.bibleState[id] = ui.bibleState[id] === b.dataset.sid ? null : b.dataset.sid;
    rerender();
  }));
}
