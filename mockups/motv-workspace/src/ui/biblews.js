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
  ["characters", "角色"],
  ["locations", "场景地"],
  ["voices", "声音"],
  ["style", "风格"],
];

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
    `<div class="nm"><b>${esc(c.name)}</b><span class="role">${c.episodes.length ? `出现于 ${c.episodes.length} 集` : "未出场"}</span></div>` +
    `<div class="kv"><span class="k">出场</span><span class="v" style="font-size:var(--t-xs)">${appears}</span></div>` +
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
    return (
      `<aside class="drawer"><div class="drawer-h"><div class="ti">${esc(c.name)}</div>` +
      `<span class="chip">${c.states.length} 个状态</span><span class="chip">${c.refs.length} 张参考图</span>` +
      `<button class="btn sm x" data-bclose>✕</button></div>` +
      `<div class="drawer-b">` +
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
  const tabs =
    `<div class="vtabs">` +
    TABS.map(([k, label]) => {
      const n = k === "characters" ? m.characters.length : k === "locations" ? m.locations.length : null;
      return `<button class="vtab${k === tab ? " on" : ""}" data-btab="${k}">${esc(label)}${n != null ? `<span class="ct">${n}</span>` : ""}</button>`;
    }).join("") +
    `</div>`;

  let body;
  if (tab === "characters") {
    body = m.characters.length
      ? `<div class="biblegrid">${m.characters.map((c) => charCardHtml(c, ui.bibleOpen === `c:${c.characterId}`)).join("")}</div>` +
        `<div class="row"><button class="btn" data-b-chadd>＋ 新建角色</button></div>`
      : empty("👤", "还没有角色", "角色是跨镜头、跨集一致性的锚点：一个稳定身份 + 参考图 + 基础声音 + 若干状态。", `<div class="row"><button class="btn primary" data-bd-run>🪄 从剧本拆解</button><button class="btn" data-b-chadd>＋ 新建角色</button></div>`);
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

  return (
    head("作品设定", `${m.characters.length} 个角色 · ${m.locations.length} 个场景地 · AI 拆解为先，手工编辑为辅`) +
    renderBreakdownPanel(ctx, m) +
    tabs +
    body +
    drawerHtml(m, ui)
  );
}

export function bindBibleWs(root, ctx, ui, rerender) {
  // every editable control in the drawer keeps its original wiring
  bindSettings(root, ctx);
  root.querySelectorAll("[data-btab]").forEach((b) => (b.onclick = () => {
    ui.bibleTab = b.dataset.btab;
    ui.bibleOpen = null;
    rerender();
  }));
  root.querySelectorAll("[data-bopen]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    ui.bibleTab = b.dataset.bopen.startsWith("l:") ? "locations" : ui.bibleTab === "voices" ? "voices" : ui.bibleTab;
    ui.bibleOpen = b.dataset.bopen;
    rerender();
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
