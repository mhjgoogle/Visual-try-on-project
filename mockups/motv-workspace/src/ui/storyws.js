// 故事大纲工作区 — the durable Story Outline, as a REVIEW SURFACE.
//
// 「故事发展」 is NOT a stage of its own (ADR-0054 §4): AI Story Development is
// the AI Director's ABILITY to develop this outline, not a separate domain
// layer. The spine the creator sees is 创意 → 故事大纲 → 分集规划, and the
// outline surface shows exactly one thing: Working Draft / the current formal
// Revision, plus the Creative Brief revision it was developed from.
//
// THE EIGHT ITEMS (TASK-089 §2.1 / TASK-094 批次 D). The product owner listed
// them himself, in this order, and the surface follows that order: 故事核心 /
// 主角与目标 / 核心冲突 / 世界与核心规则 / 主要角色关系 / 故事主线 /
// 核心秘密与揭示顺序 / 主题与最终变化. Three of them are structures on purpose —
// 外部/内部冲突 apart, 世界规则 as a list, 主线 as five ordered segments — because
// that separation IS the content; flattening them is how 「核心冲突」 became one
// paragraph of prose nobody could act on.
//
// AI WRITES, YOU REVIEW (ui/reviewface.js): what a capability produced is shown
// and editable; what it did NOT produce is stated in one line, never laid out as
// a box waiting to be filled in by hand.
//
// LEGACY IS NOT DELETED (§2.2). The four outline versions of the real project are
// written in `premise` / `centralConflict` / `storyArc` / `climax` / `ending` /
// `world`. Each of those is shown where its replacement would go, labelled as the
// old field, and stays editable — hiding it would leave real content on disk that
// this screen could neither show nor clear.
//
// The version model is the EXISTING one (story.versions / active / approved) —
// no second Story data was introduced. Saving is the SAME write path: an explicit
// 保存 appends a new immutable version and every earlier one stays.
import { esc } from "../util/dom.js";
import { storyModel } from "./workspaces.js";
import { briefForOutline, storyCoreOf } from "../workflow/storydoc.js";
import { head, empty } from "./shell.js";
import { reviewText, reviewList, written } from "./reviewface.js";

/** The legacy one-line facets, and the new field each one now lives under. */
const LEGACY_UNDER = {
  storyCore: [["premise", "旧字段 · 前提"], ["logline", "旧字段 · 主线"]],
  conflict: [["centralConflict", "旧字段 · 核心冲突"]],
  worldAndRules: [["world", "旧字段 · 世界观概述"]],
  mainline: [["storyArc", "旧字段 · 故事弧"], ["climax", "旧字段 · 高潮"], ["ending", "旧字段 · 结局"]],
};

/** 「体量」 — the three facets that come from the Creative Brief and are kept
 *  because something downstream reads them (§2.2). */
const SCALE_FIELDS = [
  ["genreTone", "题材 / 基调"],
  ["durationNote", "每集时长预期"],
];

/** Read the value at a dotted path, tolerating a document that predates it. */
function at(outline, path) {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), outline);
}

/** One editable text control bound to a dotted path on the outline. */
function field(label, outline, path, opts = {}) {
  return reviewText(label, at(outline, path) ?? "", {
    attrs: `data-so-path="${esc(path)}"`,
    rows: opts.rows ?? 2,
    placeholder: opts.placeholder || "",
    hint: opts.hint || "",
    force: !!opts.force,
  });
}

/**
 * The old value of a merged/replaced facet, shown where its replacement goes.
 *
 * NEVER THE SAME TEXT TWICE — WHILE READING. 故事核心 falls back to `logline` (then
 * `premise`) when the new field is empty, so listing that same field again below it
 * printed one paragraph twice: once as the headline and once as 「旧字段 · 主线」
 * (seen on 照见未明rev2, whose four outline versions have no `storyCore`).
 *
 * WHILE EDITING, EVERYTHING STORED IS SHOWN. The headline's control is bound to
 * `storyCore`, which in that document is EMPTY — so hiding the legacy field there
 * too left real content on disk that could be neither edited nor cleared (codex
 * review, 批次 D round 1, blocking). Reading dedupes; editing is a complete view of
 * what the document actually holds.
 */
function legacyFor(outline, key, editing) {
  const shownAsCore = !editing && key === "storyCore" && !written(outline.storyCore)
    ? storyCoreOf(outline)
    : null;
  return (LEGACY_UNDER[key] || [])
    .filter(([path]) => written(at(outline, path)))
    .filter(([path]) => !(shownAsCore && at(outline, path) === shownAsCore))
    .map(([path, label]) =>
      `<div class="ept-legacy"><span class="chip mute" title="这一版大纲写在旧字段里；让 AI 改一次就会写成新的结构">${esc(label)}</span>` +
      (editing
        ? `<textarea class="rf-t" rows="2" spellcheck="false" data-so-path="${esc(path)}">${esc(at(outline, path))}</textarea>`
        : `<div class="tx">${esc(at(outline, path))}</div>`))
    .join("");
}

/** 主要角色关系 / 核心秘密 —— one row per item the AI actually produced. */
function relationshipRows(outline, editing) {
  const list = Array.isArray(outline.keyRelationships) ? outline.keyRelationships : [];
  if (!list.length) return `<div class="meta rf-none">AI 没有写这一项</div>`;
  return list
    .map((r, i) => {
      const between = Array.isArray(r.between) ? r.between : [];
      // THE TWO NAMES ARE EDITABLE TOO (codex review, 批次 D round 1, blocking).
      // A capability that named the wrong pair — or a name the creator later
      // renamed in 作品设定 — was uncorrectable while this was a static chip.
      const who = editing
        ? `<input class="rf-i sm" data-so-path="keyRelationships.${i}.between.0" value="${esc(between[0] || "")}" placeholder="谁">` +
          `<span class="meta">×</span>` +
          `<input class="rf-i sm" data-so-path="keyRelationships.${i}.between.1" value="${esc(between[1] || "")}" placeholder="和谁">`
        : `<span class="chip">${esc(between.join(" × "))}</span>`;
      const body = editing
        ? `<input class="rf-i" data-so-path="keyRelationships.${i}.nature" value="${esc(r.nature || "")}" placeholder="是什么关系">` +
          `<input class="rf-i" data-so-path="keyRelationships.${i}.howItChanges" value="${esc(r.howItChanges || "")}" placeholder="整部作品里怎么变">`
        : `<div class="tx">${esc(r.nature || "")}</div>` +
          (r.howItChanges ? `<div class="meta">走向：${esc(r.howItChanges)}</div>` : "");
      return `<div class="rf-row rel">${who}${body}</div>`;
    })
    .join("");
}

function secretRows(outline, editing) {
  const list = Array.isArray(outline.secretsAndReveals) ? outline.secretsAndReveals : [];
  if (!list.length) return `<div class="meta rf-none">AI 没有写这一项</div>`;
  return list
    .map((s, i) => {
      const when = s.revealAround ? `<span class="chip">${esc(s.revealAround)}</span>` : "";
      const body = editing
        ? `<input class="rf-i" data-so-path="secretsAndReveals.${i}.truth" value="${esc(s.truth || "")}" placeholder="哪个真相">` +
          `<input class="rf-i" data-so-path="secretsAndReveals.${i}.whyNotUpfront" value="${esc(s.whyNotUpfront || "")}" placeholder="为什么不能一开始说">` +
          `<input class="rf-i" data-so-path="secretsAndReveals.${i}.revealAround" value="${esc(s.revealAround || "")}" placeholder="大概什么时候揭露">`
        : `<div class="tx">${esc(s.truth || "")}</div>` +
          (s.whyNotUpfront ? `<div class="meta">不能一开始说：${esc(s.whyNotUpfront)}</div>` : "");
      return `<div class="rf-row secret">${when}${body}</div>`;
    })
    .join("");
}

/** THE EIGHT, in the product owner's own order. */
function eightItems(outline, editing) {
  const card = (n, title, body) =>
    `<div class="story-card wide" data-so-item="${esc(title)}">` +
    `<div class="hd"><span class="ic">${n}</span><h4>${esc(title)}</h4></div>${body}</div>`;
  const ro = (value, lead = false) => (written(value)
    ? `<div class="tx${lead ? " lead" : ""}">${esc(value)}</div>`
    : `<div class="none">（AI 没有写这一项）</div>`);
  const one = (label, path, opts = {}) => (editing
    ? field(label, outline, path, { force: true, ...opts })
    : `<div class="rf-f"><span class="k">${esc(label)}</span>${ro(at(outline, path), opts.lead)}</div>`);

  const rules = Array.isArray(at(outline, "worldAndRules.rules")) ? outline.worldAndRules.rules : [];
  return (
    card("①", "故事核心", (editing
      ? field("一句话说明这个故事讲什么", outline, "storyCore", { rows: 2, force: true })
      : ro(storyCoreOf(outline), true)) + legacyFor(outline, "storyCore", editing)) +
    card("②", "主角与目标",
      one("主角是谁", "protagonist.who", { rows: 1 }) +
      one("她/他最开始想要什么", "protagonist.initialWant")) +
    card("③", "核心冲突",
      one("外部冲突：什么力量阻止主角", "conflict.external") +
      one("内部冲突：主角自己身上的什么", "conflict.internal") +
      legacyFor(outline, "conflict", editing)) +
    card("④", "世界与核心规则",
      one("故事发生在哪里", "worldAndRules.where") +
      (editing
        ? reviewList("会直接影响剧情的重要规则", rules, {
            rowAttrs: (i) => `class="rf-i" data-so-path="worldAndRules.rules.${i}"`,
            placeholder: "一条一个规则",
          })
        : reviewList("会直接影响剧情的重要规则", rules, { rowAttrs: () => "readonly" })) +
      legacyFor(outline, "worldAndRules", editing)) +
    card("⑤", "主要角色关系",
      `<div class="rf-l">${relationshipRows(outline, editing)}</div>` +
      `<div class="meta">大纲讲这段关系的总体走向；某一集里发生了什么记在「分集规划」的角色推进里 —— 两者不互相覆盖。</div>`) +
    card("⑥", "故事主线",
      // FIXED ORDER: 顺序本身是信息（§2.3）
      one("开端", "mainline.setup") +
      one("发展", "mainline.development") +
      one("中段重大转折", "mainline.midpointTurn") +
      one("高潮", "mainline.climax") +
      one("结局", "mainline.ending") +
      legacyFor(outline, "mainline", editing)) +
    card("⑦", "核心秘密 / 信息揭示顺序",
      `<div class="rf-l">${secretRows(outline, editing)}</div>`) +
    card("⑧", "主题与最终变化",
      one("故事最终想表达什么", "themeAndChange.theme") +
      one("主角经历整个故事后变成了怎样的人", "themeAndChange.protagonistBecomes"))
  );
}

function pipeline(m) {
  const step = (label, state) => `<span class="fstep ${state}">${esc(label)}</span>`;
  const s1 = m.hasIdea ? "done" : "on";
  const s2 = m.approved ? "done" : m.outlineCount ? "on" : "";
  const s3 = m.confirmed ? "done" : m.approved ? "on" : "";
  const s4 = m.confirmed ? "on" : "";
  return (
    `<div class="flow">` +
    step(m.hasIdea ? "✓ 创意" : "创意", s1) +
    `<span class="arr">→</span>` +
    step(m.approved ? `✓ 故事大纲 v${m.approved.v}` : m.outlineCount ? `故事大纲 · ${m.outlineCount} 版` : "故事大纲", s2) +
    `<span class="arr">→</span>` +
    step(m.confirmed ? `✓ 分集规划 v${m.confirmed.v}` : "分集规划", s3) +
    `<span class="arr">→</span>` +
    step("分集剧本", s4) +
    `</div>`
  );
}

function proposalPanel(m) {
  if (!m.pending || m.pending.kind !== "outline") return "";
  if (m.pending.status === "generating") {
    return `<div class="story-card wide"><div class="hd"><span class="ic">🪄</span><h4>AI 正在发展故事…</h4></div><div class="st-skel"><i></i><i></i><i></i><i></i><i></i></div></div>`;
  }
  if (m.pending.status === "failed") {
    return (
      `<div class="story-card wide"><div class="hd"><span class="ic">⚠</span><h4>故事发展失败</h4></div>` +
      `<div class="tx">${esc(m.pending.error || "")}</div>` +
      `<div class="row"><button class="btn" data-st-cancel>知道了</button></div></div>`
    );
  }
  // THE PREVIEW SHOWS WHAT THE MODEL ACTUALLY ANSWERED. Built from the v1 field
  // names it would have shown 「前提 / 主线」 and nothing else for a v2 answer — a
  // full proposal reading as an empty one.
  const o = m.pending.proposal;
  return (
    `<div class="story-card wide" style="border-color:var(--accent-line);background:var(--accent-soft)">` +
    `<div class="hd"><span class="ic">🪄</span><h4>故事大纲提案 · 未应用</h4>` +
    `<span class="push"></span><button class="btn primary sm" data-st-apply>✔ 应用为大纲 v${m.outlineCount + 1}</button>` +
    `<button class="btn sm" data-st-discard>放弃</button></div>` +
    `<div class="story-grid">${eightItems(o, false)}</div>` +
    (o.episodeCount ? `<div class="meta">建议集数：${o.episodeCount} 集</div>` : "") +
    `</div>`
  );
}

function outlineCards(ctx, m, ui) {
  const doc = ctx.story.doc();
  const editing = !!ui.storyEdit;
  // WHAT IS ON SCREEN while editing: the buffer over the version on file, so a
  // re-render (an AI Director toggle, a poll) re-renders the typed values instead
  // of throwing them away.
  const outline = editing ? applyBuffer(m.active.outline, ui.outlineBuffer || {}) : m.active.outline;

  const versions = doc.versions
    .map((x) => `<button class="st-ep${x.v === m.active.v ? " on" : ""}" data-st-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v}${x.v === doc.approved ? " ✓" : ""}</button>`)
    .join("");
  const approve = m.approvedIsActive
    ? `<span class="chip ok">✓ 已批准 · 剧集规划以此版为准</span>`
    : `<button class="btn primary sm" data-st-approve="${m.active.v}">✔ 批准大纲 v${m.active.v}</button>`;

  const src = briefForOutline(doc, m.active);
  const basedOn = src
    ? `<span class="chip" title="本版大纲是基于该创意版本发展出来的">Based on 创意 v${src.v}</span>`
    : `<span class="chip mute" title="这一版大纲没有记录所依据的创意版本">未记录所依据的创意版本</span>`;
  const standing = m.active.v === doc.versions.length
    ? m.active.v === doc.approved
      ? `<span class="chip ok">当前正式版本</span>`
      : `<span class="chip gate">最新版本 · 未批准</span>`
    : `<span class="chip mute">正在查看历史版本</span>`;

  // AN EXPLICIT EDIT SESSION, on purpose. The outline chain has NO unversioned
  // draft (unlike 创意 and 分集规划), so always-on editing would keep the creator's
  // typing in the DOM only and lose it on a refresh. 保存 appends a new version and
  // every earlier one stays — the existing write path, not a second one.
  const editBar = editing
    ? `<div class="planbar row tight"><span class="chip gate">正在编辑 · 还没有保存</span>` +
      `<span class="push"></span>` +
      `<button class="btn sm" data-st-editoff>取消</button>` +
      `<button class="btn primary sm" data-st-save>保存为 v${doc.versions.length + 1}</button></div>` +
      `<div class="meta">保存会追加一个新版本，旧版本全部保留；要让分集规划改用它，还需在上面<b>批准</b>它。</div>`
    : "";

  const scale =
    `<div class="story-card"><div class="hd"><span class="ic">📐</span><h4>体量（来自创意）</h4></div>` +
    `<div class="kvrow"><div class="kv"><span class="k">目标集数</span><span class="v">${outline.episodeCount ? `${outline.episodeCount} 集` : "未定"}</span></div></div>` +
    SCALE_FIELDS.map(([k, label]) => (editing
      ? field(label, outline, k, { rows: 1, force: true })
      : `<div class="rf-f"><span class="k">${esc(label)}</span>` +
        (written(outline[k]) ? `<div class="tx">${esc(outline[k])}</div>` : `<div class="none">（未填写）</div>`) +
        `</div>`)).join("") +
    `</div>`;
  const chars =
    `<div class="story-card"><div class="hd"><span class="ic">👥</span><h4>主要角色概念</h4></div>` +
    (outline.characterConcepts && outline.characterConcepts.length
      ? `<div class="row tight">${outline.characterConcepts.map((c) => `<span class="chip">👤 ${esc(c)}</span>`).join("")}</div>`
      : `<div class="none">（暂无）</div>`) +
    `<div class="meta">正式角色档案由「剧本拆解」进入作品设定，不从大纲自动建立。</div></div>`;

  return (
    `<div class="st-sec"><h3>故事大纲 v${m.active.v}${m.active.v === doc.approved ? "（已批准）" : ""}</h3>` +
    `<div class="acts">${standing}${basedOn}<div class="row tight">${versions}</div>` +
    (editing ? "" : `<button class="btn sm" data-st-editon>✎ 修改</button>`) +
    approve + `</div></div>` +
    editBar +
    `<div class="story-grid">${eightItems(outline, editing)}${chars}${scale}</div>`
  );
}

/**
 * The outline as it looks WITH the unsaved edits applied.
 *
 * The buffer is keyed by DOTTED PATH (`conflict.external`,
 * `worldAndRules.rules.2`, `keyRelationships.0.nature`) because the eight items
 * are structures — a flat field→string buffer could only ever address a third of
 * them. Exported for tests: `applyManualOutline` merges shallowly per top-level
 * key, so what this produces is exactly what gets saved.
 */
export function applyBuffer(base, buffer) {
  let out = { ...(base || {}) };
  for (const [path, value] of Object.entries(buffer || {})) {
    const parts = path.split(".").filter((p) => p !== "");
    if (!parts.length) continue;
    const next = setPath(out, parts, value);
    if (next !== undefined) out = next;
  }
  return out;
}

/**
 * Copy-on-write set of ONE dotted path. Returns the new container, or `undefined`
 * when the path does not address anything that already exists.
 *
 * ONE WALKER RATHER THAN A CASE PER SHAPE. The first version had a branch per
 * depth, so adding the editable `keyRelationships.N.between.M` (four segments,
 * ending in an array INDEX) needed a fourth branch — and the shape it did not
 * cover was silently ignored instead of refused.
 *
 * TWO RULES, applied at every level:
 *   * an ARRAY is never GROWN — an index at or past the end is a stale render
 *     (a row another action removed), and recreating it would resurrect content
 *     the creator deleted;
 *   * a missing OBJECT is created, because a document written before an item
 *     existed legitimately has no `conflict` at all and must still be editable.
 */
function setPath(container, parts, value) {
  const [head, ...rest] = parts;
  if (Array.isArray(container)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) return undefined;
    const copy = [...container];
    if (!rest.length) {
      copy[index] = value;
      return copy;
    }
    const inner = setPath(copy[index], rest, value);
    if (inner === undefined) return undefined;
    copy[index] = inner;
    return copy;
  }
  if (container === null || typeof container !== "object") {
    // a scalar (or absent) where a container is addressed: build the object, but
    // only for a NAMED key — a numeric segment means an array that is not there
    if (Number.isInteger(Number(head)) && `${Number(head)}` === head) return undefined;
    const built = {};
    if (!rest.length) {
      built[head] = value;
      return built;
    }
    const inner = setPath(undefined, rest, value);
    if (inner === undefined) return undefined;
    built[head] = inner;
    return built;
  }
  const copy = { ...container };
  if (!rest.length) {
    copy[head] = value;
    return copy;
  }
  const inner = setPath(copy[head], rest, value);
  if (inner === undefined) return undefined;
  copy[head] = inner;
  return copy;
}

/** The top-level keys a save must carry, derived from the buffer's paths — so
 *  `applyManualOutline`'s shallow merge receives whole items rather than a dotted
 *  key it would store verbatim. */
export function patchFromBuffer(base, buffer) {
  const merged = applyBuffer(base, buffer);
  const patch = {};
  for (const path of Object.keys(buffer || {})) {
    const key = path.split(".")[0];
    patch[key] = merged[key];
  }
  return patch;
}

export function renderStoryWs(ctx, ui) {
  const doc = ctx.story.doc();
  const m = storyModel(doc);
  // The Creative Brief has its OWN workspace, so this is a read-only summary
  // with a link across — never a second editor for the same canonical field.
  const brief = ctx.story.activeBrief();
  const idea =
    `<div class="story-card wide"><div class="hd"><span class="ic">💡</span><h4>创意</h4>` +
    (brief ? `<span class="chip ok">创意 v${brief.v}</span>` : `<span class="chip mute">工作草稿</span>`) +
    `<span class="push"></span><button class="btn sm" data-goto="brief">✎ 去创意工作区</button></div>` +
    (m.hasIdea ? `<div class="tx lead">${esc(m.idea)}</div>` : `<div class="none">（还没有核心创意 — 先在「创意」写一句）</div>`) +
    (brief
      ? `<div class="row tight">${[["类型", brief.fields.genre], ["基调", brief.fields.tone], ["形式", brief.fields.form],
        ["目标集数", brief.fields.targetEpisodes ? `${brief.fields.targetEpisodes} 集` : ""], ["单集时长", brief.fields.episodeDuration]]
        .filter(([, v]) => v)
        .map(([k, v]) => `<span class="chip">${esc(k)}：${esc(v)}</span>`)
        .join("")}</div>`
      : "") +
    `</div>`;

  const body = m.active
    ? outlineCards(ctx, m, ui)
    : m.pending && m.pending.status === "generating"
      ? ""
      : empty(
          "📑",
          "从创意发展故事大纲",
          "AI 会把一句创意写成八项：故事核心 / 主角与目标 / 核心冲突（外部 + 内部）/ 世界与核心规则 / 主要角色关系 / 故事主线五段 / 核心秘密与揭示顺序 / 主题与最终变化 —— 以提案呈现，应用后成为可批准的大纲版本。",
          m.hasIdea ? `<button class="btn primary" data-st-develop>🪄 AI 发展故事</button>` : "",
        );

  return (
    head("故事大纲", "项目级 · 持久版本链；AI 只出提案，应用后才成为新版本") +
    pipeline(m) +
    `<div class="story-grid">${idea}</div>` +
    proposalPanel(m) +
    body
    // 分集规划 does NOT belong under 故事大纲 (产品 2026-08-13). The outline
    // workspace ends at the outline; the plan is its own step in the rail.
  );
}

/** Wire the 故事 workspace. Same controllers and same gates as before; the
 *  editor toggle is transient shell state. */
export function bindStoryWs(root, ctx, ui, rerender) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  on("[data-st-develop]", () => ctx.story.develop("outline", ""));
  on("[data-st-apply]", () => ctx.story.applyProposal());
  on("[data-st-discard]", () => ctx.story.discardProposal());
  on("[data-st-cancel]", () => ctx.story.cancel());
  on("[data-st-approve]", (el) => ctx.story.approveOutline(+el.dataset.stApprove));
  on("[data-st-v]", (el) => ctx.story.setActiveOutline(+el.dataset.stV));
  on("[data-st-editon]", () => { ui.storyEdit = true; rerender(); });
  on("[data-st-editoff]", () => {
    ui.storyEdit = false;
    ui.outlineBuffer = {}; // an explicit cancel is the ONLY thing that discards
    rerender();
  });
  // the buffer lives on the SHELL's transient state, so a re-render triggered
  // by anything else (an AI Director section toggle, a poll) re-renders the
  // typed values instead of throwing them away
  const buffer = ui.outlineBuffer || (ui.outlineBuffer = {});
  root.querySelectorAll("[data-so-path]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.soPath] = el.value; };
  });
  on("[data-st-save]", () => {
    if (!Object.keys(buffer).length) { ctx.toast("没有修改"); return; }
    const m = storyModel(ctx.story.doc());
    // WHOLE ITEMS, not dotted keys: `applyManualOutline` merges shallowly over the
    // active outline, so handing it `conflict.external` would store that literal
    // key and leave `conflict` itself untouched.
    const patch = patchFromBuffer(m.active ? m.active.outline : {}, buffer);
    ui.storyEdit = false;
    ui.outlineBuffer = {};
    ctx.story.applyManualOutline(patch);
  });
  // NOTE: [data-ep-open] is deliberately NOT wired here. Entering an episode is
  // a SHELL decision (switch the active episode AND open one of its stages), and
  // the shell owns it — see enterEpisode in ui/production.js, which binds this
  // attribute after every workspace's own bindings.
}
