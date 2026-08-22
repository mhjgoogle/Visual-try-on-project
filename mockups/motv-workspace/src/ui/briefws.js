// 创意 Creative Brief — the first upstream surface (TASK-057 / ADR-0054 决策 2).
//
// A compact, creator-oriented field grid: 核心创意 leads, then 类型 / 基调 /
// 形式 / 目标集数 / 时长方向 as high-density cards. Deliberately NOT one giant
// textarea, and deliberately NOT a wizard step — the creator comes back here
// whenever the work's premise shifts.
//
// VERSION RULE, visible on screen: everything typed here lands in the WORKING
// DRAFT and autosaves. A formal revision exists only because the creator asked
// for one, so the header always says which of the two you are looking at.
//
// PURE PRESENTATION over ctx.story (the same document that owns the idea, the
// outline chain and the episode plan) — this screen owns no creative state.
import { esc } from "../util/dom.js";
import { BRIEF_FIELDS } from "../workflow/storydoc.js";
import { head } from "./shell.js";
import { bindField, restoreFieldFocus } from "./fieldsync.js";

/** The brief's fields as the creator reads them: label, placeholder, and how
 *  much room each one deserves. */
const FIELDS = [
  ["genre", "类型", "如：都市悬疑 / 古装权谋 / 校园青春", 2],
  ["tone", "基调", "如：冷峻克制、黑色幽默、温柔治愈", 2],
  ["form", "大致形式", "如：竖屏短剧、每集单元＋主线、双时间线", 2],
  ["episodeDuration", "单集时长方向", "如：60–90 秒 / 3 分钟", 1],
  ["totalDuration", "总体时长方向", "如：全 12 集约 20 分钟", 1],
  ["notes", "其它方向", "还没定型但想记下的方向、参考、禁区", 3],
];

/** Pure view-model of the brief for the workspace and the AI Director.
 *  `dirty` is the DOCUMENT's answer (storydoc.briefIsDirty), never a guess. */
export function briefModel(story, dirty) {
  const b = story.brief;
  const active = b.versions.find((x) => x.v === b.active) || null;
  const d = b.draft;
  const filled = BRIEF_FIELDS.filter((k) => d[k].trim()).length + (d.targetEpisodes ? 1 : 0);
  return {
    idea: story.idea,
    hasIdea: !!story.idea.trim(),
    draft: d,
    active,
    versionCount: b.versions.length,
    versions: b.versions.map((x) => ({ v: x.v, id: x.id, origin: x.origin, isActive: x.v === b.active })),
    dirty: !!dirty,
    filled,
    total: BRIEF_FIELDS.length + 1, // + 目标集数
  };
}

export function renderBriefWs(ctx, ui) {
  const story = ctx.story.doc();
  const m = briefModel(story, ctx.story.briefIsDirty());
  const buf = ui.briefBuffer || {};
  const val = (k) => (k in buf ? buf[k] : m.draft[k]);

  // standing: Working Draft vs the revision downstream is based on
  const standing = m.active
    ? `<span class="chip ok">创意 v${m.active.v}</span>` +
      (m.dirty ? `<span class="chip gate">工作草稿 · 未版本化</span>` : `<span class="chip mute">与 v${m.active.v} 一致</span>`)
    : `<span class="chip gate">工作草稿 · 还没有正式版本</span>`;
  const versions = m.versions.length
    ? `<div class="row tight">${m.versions
        .map((x) => `<button class="st-ep${x.isActive ? " on" : ""}" data-cb-v="${x.v}" title="切换下游所依据的版本">v${x.v}</button>`)
        .join("")}</div>`
    : "";
  const actions =
    versions +
    (m.dirty ? `<button class="btn primary sm" data-cb-commit>✔ 创建版本 v${m.versionCount + 1}</button>` : "") +
    (m.active && m.dirty ? `<button class="btn sm" data-cb-restore="${m.active.v}">取回 v${m.active.v} 内容</button>` : "");

  const ideaCard =
    `<div class="story-card wide"><div class="hd"><span class="ic">💡</span><h4>核心创意</h4>` +
    `<span class="push"></span><span class="meta">一句话就够 — 它是整部作品的锚</span></div>` +
    `<textarea class="field brieftext pm-brieftext" rows="2" spellcheck="false" placeholder="例如：一间深夜不打烊的酒吧，和一个不肯把录音交出去的调酒师">${esc(m.idea)}</textarea></div>`;

  const cards = FIELDS.map(([k, label, ph, rows]) =>
    `<div class="story-card${rows >= 3 ? " wide" : ""}"><div class="hd"><h4>${esc(label)}</h4></div>` +
    `<textarea class="field" rows="${rows}" spellcheck="false" placeholder="${esc(ph)}" data-cb-field="${k}">${esc(val(k))}</textarea></div>`,
  ).join("");

  const target = "targetEpisodes" in buf ? buf.targetEpisodes : m.draft.targetEpisodes;
  const countCard =
    `<div class="story-card"><div class="hd"><h4>目标集数</h4></div>` +
    `<input class="field" type="number" min="1" max="50" inputmode="numeric" placeholder="如 12" data-cb-count value="${target == null ? "" : esc(String(target))}">` +
    `<div class="meta">规划分集时作为目标（1–50）</div></div>`;

  const diff = m.active && m.dirty ? briefDiff(m) : "";

  return (
    head("创意", "项目级 · 建立整部作品的创作前提；随时可回来修改", standing + actions) +
    `<div class="meta cb-note">编辑即自动保存为工作草稿 —— 自动保存不产生版本。只有「创建版本」才会形成下游可依据的正式创意版本。</div>` +
    `<div class="story-grid">${ideaCard}${cards}${countCard}</div>` +
    diff
  );
}

/** What the working draft changed relative to the active revision — so
 *  「创建版本」 is an informed decision, not a leap. */
function briefDiff(m) {
  const rows = [];
  if (m.active.idea !== m.idea) rows.push(["核心创意", m.active.idea, m.idea]);
  for (const [k, label] of FIELDS.map(([key, label]) => [key, label])) {
    if (m.active.fields[k] !== m.draft[k]) rows.push([label, m.active.fields[k], m.draft[k]]);
  }
  if (m.active.fields.targetEpisodes !== m.draft.targetEpisodes) {
    rows.push(["目标集数", m.active.fields.targetEpisodes, m.draft.targetEpisodes]);
  }
  if (!rows.length) return "";
  const txt = (v) => (v == null || v === "" ? "（空）" : String(v));
  return (
    `<div class="story-card wide"><div class="hd"><span class="ic">±</span><h4>与 v${m.active.v} 的差异 · ${rows.length} 处</h4></div>` +
    rows.map(([k, from, to]) => `<div class="bd-f"><span>${esc(k)}</span><s>${esc(txt(from))}</s> → ${esc(txt(to))}</div>`).join("") +
    `</div>`
  );
}

/** Wire the workspace. Field edits AUTOSAVE the draft on change (blur) so the
 *  caret is never stolen mid-sentence; the typed values live on the shell's
 *  transient buffer so an unrelated re-render (an AI Director poll, a section
 *  toggle) re-renders what was typed instead of throwing it away. */
export function bindBriefWs(root, ctx, ui, rerender) {
  const buf = ui.briefBuffer || (ui.briefBuffer = {});
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));

  // A committed edit CHANGES what the header must offer: the moment the draft
  // differs from the active revision, 「创建版本」 has to exist (and it has to
  // disappear again once the draft matches). Re-rendering on `change` — i.e. on
  // blur, after the value is already persisted — is what keeps the header
  // truthful; doing it on `input` would steal the caret mid-sentence.
  const commit = (field, value) => {
    ctx.story.editBrief({ [field]: value });
    delete buf[field]; // the document now holds it — stop shadowing it
    rerender();
  };

  const idea = root.querySelector(".pm-brieftext");
  if (idea) {
    idea.oninput = () => ctx.story.setIdea(idea.value); // one canonical home
    // the idea is not a brief FIELD (it lives on story.idea), but it is part of
    // what a revision snapshots — so it moves the dirty standing too
    idea.onchange = () => rerender();
  }
  // AUTOSAVE ON INPUT, not on blur: a refresh while the caret is still in the
  // field must not lose the text (see ui/fieldsync.js).
  root.querySelectorAll("[data-cb-field]").forEach((el) => {
    bindField(el, ui, (value) => commit(el.dataset.cbField, value), {
      onInput: (value) => { buf[el.dataset.cbField] = value; },
    });
  });
  const count = root.querySelector("[data-cb-count]");
  if (count) {
    // Three OUTCOMES, kept distinct: a valid number is written, an EMPTY field
    // clears the target (a real intent), and an invalid entry is REFUSED —
    // refused meaning nothing is written and the stored value comes back. A
    // typo must never destroy a target the creator had already set.
    const parse = () => {
      const raw = count.value.trim();
      if (!raw) return { ok: true, value: null };
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 && n <= 50 ? { ok: true, value: n } : { ok: false };
    };
    count.oninput = () => {
      const r = parse();
      if (r.ok) buf.targetEpisodes = r.value;
      else delete buf.targetEpisodes; // keep showing the stored value on re-render
    };
    count.onchange = () => {
      const r = parse();
      if (!r.ok) {
        ctx.toast("目标集数需要是 1–50 的整数 — 未修改");
        delete buf.targetEpisodes;
        const cur = ctx.story.doc().brief.draft.targetEpisodes;
        count.value = cur == null ? "" : String(cur); // restore what is stored
        return; // refused → nothing changed, so nothing to re-render
      }
      commit("targetEpisodes", r.value);
    };
  }
  on("[data-cb-commit]", () => {
    if (ctx.story.commitBrief()) { ui.briefBuffer = {}; rerender(); }
  });
  on("[data-cb-v]", (el) => ctx.story.setActiveBrief(+el.dataset.cbV));
  on("[data-cb-restore]", (el) => {
    if (!window.confirm("用该版本的内容替换当前工作草稿？（版本链不变，草稿里未版本化的修改会丢失）")) return;
    ui.briefBuffer = {};
    ctx.story.restoreBriefDraft(+el.dataset.cbRestore);
  });
  restoreFieldFocus(root, ui); // a commit may have re-rendered us mid-typing
}
