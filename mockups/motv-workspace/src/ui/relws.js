// 人物关系 — Relationship as a FIRST-CLASS creative object (ADR-0054 决策 3).
//
// A relationship is not a text field on a character: it is 林照 × 沈既白, with
// its own conflict, tension, power balance, shared history, secrets and Arc.
// This workspace shows the pair GALLERY first (both portraits, the basis, the
// arc, and which episodes actually advance it) and opens a detail drawer for
// the eleven definition facets.
//
// PROJECT-LEVEL CANON: what is written here describes the WHOLE work
// (戒备 → 合作 → 信任 → 决裂 → 再选择). It never pins down one episode's actual
// state — that is the Episode Relationship Beat, recorded in 分集规划.
//
// PURE PRESENTATION over ctx.canon / the production document. Characters are
// referenced by id; no profile is ever copied here.
import { esc } from "../util/dom.js";
import { RELATIONSHIP_FIELDS } from "../workflow/canondoc.js";
import { head, empty } from "./shell.js";

/** The definition facets, grouped the way a writer reads a relationship. */
const FACETS = [
  ["basis", "基础关系", "如：曾经的搭档，现在的对手", 2],
  ["aToB", "A 怎么看 B", "", 2],
  ["bToA", "B 怎么看 A", "", 2],
  ["coreConflict", "核心矛盾", "两人之间无法轻易化解的东西", 2],
  ["tension", "情感张力", "吸引 / 忌惮 / 未说出口的东西", 2],
  ["power", "权力关系", "谁掌握什么，谁有求于谁", 2],
  ["history", "共同历史", "在故事开始之前发生过什么", 2],
  ["secrets", "隐藏信息 / 秘密", "谁瞒着谁什么，何时可能揭穿", 2],
  ["direction", "长期发展方向", "整部作品里这段关系走向哪里", 2],
  ["arc", "Relationship Arc", "如：戒备 → 合作 → 信任 → 决裂 → 再选择", 2],
  ["forbidden", "不应发生的关系偏离", "越界即 OOC 的地方（AI 与后续集数的红线）", 2],
];

/** Pure view-model: every relationship joined to its two characters and to the
 *  episodes that record a beat for it. Exported for node --test. */
export function relationshipsModel(pd) {
  const prod = pd.production;
  if (!prod || !Array.isArray(prod.relationships) || !Array.isArray(prod.characters)) return { empty: true };
  const byId = new Map(prod.characters.map((c) => [c.characterId, c]));
  const hero = (c) => {
    if (!c) return "";
    const active = c.activeReferenceAssetId || c.referenceAssetIds[0] || null;
    if (!active) return "";
    for (const slot of Object.keys(pd.assetUploads || {})) {
      const e = pd.assetUploads[slot];
      for (const r of (e && e.history) || []) {
        if (r && r.assetId === active) return r.url || "";
      }
    }
    return "";
  };
  const items = prod.relationships.map((r) => {
    const [a, b] = r.characterIds.map((id) => byId.get(id) || null);
    const beats = (prod.episodes || [])
      .map((e, i) => {
        const beat = ((e.beats && e.beats.relationship) || []).find((x) => x.relationshipId === r.relationshipId);
        return beat ? { code: `EP${String(i + 1).padStart(2, "0")}`, title: e.title, ...beat } : null;
      })
      .filter(Boolean);
    return {
      relationshipId: r.relationshipId,
      profile: r.profile,
      a: a ? { characterId: a.characterId, name: a.name, tier: a.tier, url: hero(a) } : null,
      b: b ? { characterId: b.characterId, name: b.name, tier: b.tier, url: hero(b) } : null,
      // filled facets out of eleven — the honest completeness signal
      filled: RELATIONSHIP_FIELDS.filter((k) => r.profile[k].trim()).length,
      total: RELATIONSHIP_FIELDS.length,
      beats,
    };
  });
  // every pair that could still be defined (both formal and bit characters can
  // hold a relationship — a recurring 医生 legitimately has one)
  const pairs = [];
  for (let i = 0; i < prod.characters.length; i++) {
    for (let j = i + 1; j < prod.characters.length; j++) {
      const a = prod.characters[i];
      const b = prod.characters[j];
      const exists = items.some(
        (r) => (r.a && r.b)
          && ((r.a.characterId === a.characterId && r.b.characterId === b.characterId)
            || (r.a.characterId === b.characterId && r.b.characterId === a.characterId)),
      );
      if (!exists) pairs.push({ a: a.characterId, b: b.characterId, label: `${a.name} × ${b.name}` });
    }
  }
  return {
    empty: false,
    items,
    pairs,
    characterCount: prod.characters.length,
    revision: prod.canon.relationships,
  };
}

function portrait(p, icon) {
  if (!p) return `<div class="por media-none sm"><span class="ic">?</span></div>`;
  return p.url
    ? `<img class="por sm" src="${esc(p.url)}" alt="${esc(p.name)}" loading="lazy">`
    : `<div class="por media-none sm"><span class="ic">${icon}</span></div>`;
}

function card(r, open) {
  const names = `${r.a ? esc(r.a.name) : "?"} <span class="rel-x">×</span> ${r.b ? esc(r.b.name) : "?"}`;
  const beats = r.beats.length
    ? `<div class="rw row tight">${r.beats.slice(0, 4).map((b) => `<span class="chip" title="${esc(`${b.start} → ${b.event} → ${b.end}`)}">${esc(b.code)}</span>`).join("")}` +
      (r.beats.length > 4 ? `<span class="chip mute">+${r.beats.length - 4}</span>` : "") + `</div>`
    : `<div class="meta">还没有任何一集推进这段关系</div>`;
  return (
    `<button class="relcard${open ? " on" : ""}" data-relopen="${esc(r.relationshipId)}">` +
    `<div class="rel-pair">${portrait(r.a, "👤")}${portrait(r.b, "👤")}</div>` +
    `<div class="bd"><div class="nm"><b>${names}</b></div>` +
    (r.profile.basis ? `<div class="kv"><span class="v">${esc(r.profile.basis)}</span></div>` : `<div class="meta">（还没写基础关系）</div>`) +
    (r.profile.arc ? `<div class="rw"><span class="chip ok">Arc</span><span class="meta">${esc(r.profile.arc)}</span></div>` : "") +
    `<div class="rw"><span class="chip${r.filled === r.total ? " ok" : r.filled ? "" : " mute"}">${r.filled}/${r.total} 项已填</span></div>` +
    beats +
    `</div></button>`
  );
}

function drawer(m, ui) {
  const r = m.items.find((x) => x.relationshipId === ui.relOpen);
  if (!r) return "";
  const aName = r.a ? r.a.name : "A";
  const bName = r.b ? r.b.name : "B";
  const label = (k, base) =>
    k === "aToB" ? `${aName} 怎么看 ${bName}` : k === "bToA" ? `${bName} 怎么看 ${aName}` : base;
  const fields = FACETS.map(([k, base, ph, rows]) =>
    `<label class="ws-lab">${esc(label(k, base))}</label>` +
    `<textarea class="ws-bibletext" rows="${rows}" spellcheck="false" placeholder="${esc(ph)}" data-rel-field="${esc(r.relationshipId)}" data-field="${k}">${esc(r.profile[k])}</textarea>`,
  ).join("");
  const beats = r.beats.length
    ? `<div class="lab">各集实际推进（Episode-level，不改上面的作品级定义）</div>` +
      r.beats
        .map((b) =>
          `<div class="bd-f"><span>${esc(b.code)}</span>${esc(b.start || "—")} → ${esc(b.event || "—")} → ${esc(b.end || "—")}</div>`,
        )
        .join("")
    : `<div class="meta">在「分集规划」里为某一集记录 start / event / end，就会显示在这里。</div>`;
  return (
    `<aside class="drawer"><div class="drawer-h"><div class="ti">${esc(aName)} × ${esc(bName)}</div>` +
    `<span class="chip">${r.filled}/${r.total} 项</span>` +
    `<button class="btn sm x" data-relclose>✕</button></div>` +
    `<div class="drawer-b"><div>` +
    `<div class="meta">这里写的是<b>整部作品</b>的关系定义。某一集实际发生什么，记在该集的 Relationship Beat 里。</div>` +
    fields +
    `<div class="row"><button class="btn" data-reldel="${esc(r.relationshipId)}">删除这段关系</button></div>` +
    `</div><div>${beats}</div></div></aside>`
  );
}

export function renderRelWs(ctx, ui) {
  const m = relationshipsModel(ctx.prodData());
  if (m.empty) return head("人物关系", "项目级") + empty("🔗", "人物关系不可用", "生产域文档未加载。");

  if (m.characterCount < 2) {
    return (
      head("人物关系", "项目级 · 一段关系连接两个真实人物") +
      empty(
        "🔗",
        "先有两个人物，才有关系",
        "关系是人物设定体系里的独立对象：它有自己的核心矛盾、权力关系和 Arc，不是角色档案里的一个文本字段。",
        `<button class="btn primary" data-goto="characters">→ 去建立人物</button>`,
      )
    );
  }
  // the two ids ride in SEPARATE attributes — never packed into one value a
  // delimiter split could mis-parse (a characterId is an arbitrary string, so
  // any join character could legally occur inside one). Same rule as the scene
  // reference selects in ui/workspaces.js.
  const add = m.pairs.length
    ? `<select class="ws-assign" data-reladd><option value="">＋ 建立关系…</option>${m.pairs
        .map((p, i) => `<option value="${i}" data-a="${esc(p.a)}" data-b="${esc(p.b)}">${esc(p.label)}</option>`)
        .join("")}</select>`
    : `<span class="chip mute">所有人物两两之间都已有关系定义</span>`;
  const confirm =
    `<button class="btn sm" data-canon-confirm="relationships">✔ 确认关系设定版本</button>` +
    (m.revision ? `<span class="chip ok">关系设定 v${m.revision}</span>` : `<span class="chip mute">尚未确认版本</span>`);

  const body = m.items.length
    ? `<div class="relgrid">${m.items.map((r) => card(r, ui.relOpen === r.relationshipId)).join("")}</div>`
    : empty(
        "🔗",
        "还没有人物关系",
        "选择两个人物建立关系，然后写下他们的核心矛盾、权力关系与长期走向 —— AI 导演据此判断关系是否走偏。",
        "",
      );

  return (
    head("人物关系", `${m.items.length} 段关系 · 作品级 Canon（不写死每一集的状态）`, add + confirm) +
    body +
    drawer(m, ui)
  );
}

export function bindRelWs(root, ctx, ui, rerender) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  const sel = root.querySelector("[data-reladd]");
  if (sel)
    sel.onchange = () => {
      if (!sel.value) return;
      // read the two ids off the chosen option's own attributes
      const opt = sel.selectedOptions ? sel.selectedOptions[0] : sel.options[sel.selectedIndex];
      if (!opt) return;
      const { a, b } = opt.dataset;
      const rec = ctx.canon.addRelationship(a, b);
      if (rec) { ui.relOpen = rec.relationshipId; rerender(); }
      else ctx.toast("无法建立：两个人物必须存在且不同，且这一对已有关系定义");
    };
  on("[data-relopen]", (el) => { ui.relOpen = el.dataset.relopen; rerender(); });
  const x = root.querySelector("[data-relclose]");
  if (x) x.onclick = () => { ui.relOpen = null; rerender(); };
  on("[data-reldel]", (el) => {
    if (!window.confirm("删除这段关系定义？（各集已记录的关系推进必须先移除）")) return;
    if (ctx.canon.removeRelationship(el.dataset.reldel)) { ui.relOpen = null; rerender(); }
    else ctx.toast("仍有剧集记录了这段关系的推进：先在「分集规划」移除该集的 Relationship Beat");
  });
  // facet edits save on change (blur) — no re-render while typing
  root.querySelectorAll("[data-rel-field]").forEach((el) => {
    el.onchange = () => ctx.canon.updateRelationship(el.dataset.relField, { [el.dataset.field]: el.value });
  });
  on("[data-canon-confirm]", (el) => ctx.canon.confirm(el.dataset.canonConfirm));
}
