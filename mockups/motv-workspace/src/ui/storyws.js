// 故事工作区 — story DEVELOPMENT, not a database editor.
//
// The pipeline (创意 → 发展 → 大纲 → 剧集规划) is the spine; the approved
// outline reads as structured section CARDS, and the confirmed plan as episode
// CARDS. Long stacks of textareas are gone: editing an outline opens a
// secondary editor, so the default view stays readable prose.
//
// Behaviour is unchanged from the previous form-first screen — the same
// ctx.story controllers, the same proposal-then-apply gate, the same
// approval/confirmation semantics. Only the presentation is new.
import { esc } from "../util/dom.js";
import { storyModel, OUTLINE_LABELS } from "./workspaces.js";
import { head, empty } from "./shell.js";

// The outline sections, grouped the way a writer reads them rather than the
// order the schema happens to store them in.
const SECTIONS = [
  ["premise", "前提", "🎯", true],
  ["logline", "故事线 Logline", "🧭", true],
  ["genreTone", "题材 / 基调", "🎨", false],
  ["world", "世界观", "🌐", false],
  ["centralConflict", "核心冲突", "⚔", false],
  ["storyArc", "故事弧", "📈", false],
  ["ending", "结局方向", "🏁", false],
];

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
    step(m.outlineCount ? `故事发展 · ${m.outlineCount} 版` : "故事发展", m.outlineCount ? "done" : "") +
    `<span class="arr">→</span>` +
    step(m.approved ? `✓ 故事大纲 v${m.approved.v}` : "故事大纲", s2) +
    `<span class="arr">→</span>` +
    step(m.confirmed ? `✓ 剧集规划 v${m.confirmed.v}` : "剧集规划", s3) +
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
  const o = m.pending.proposal;
  const rows = OUTLINE_LABELS.map(([k, label]) => (o[k] ? `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${esc(o[k])}</span></div>` : "")).join("");
  const chars = o.characterConcepts.length
    ? `<div class="row tight">${o.characterConcepts.map((c) => `<span class="chip">👤 ${esc(c)}</span>`).join("")}</div>`
    : "";
  return (
    `<div class="story-card wide" style="border-color:var(--accent-line);background:var(--accent-soft)">` +
    `<div class="hd"><span class="ic">🪄</span><h4>故事大纲提案 · 未应用</h4>` +
    `<span class="push"></span><button class="btn primary sm" data-st-apply>✔ 应用为大纲 v${m.outlineCount + 1}</button>` +
    `<button class="btn sm" data-st-discard>放弃</button></div>` +
    `<div class="kvrow">${rows}</div>${chars}` +
    (o.episodeCount ? `<div class="meta">建议集数：${o.episodeCount} 集</div>` : "") +
    `</div>`
  );
}

function outlineCards(ctx, m, ui) {
  const doc = ctx.story.doc();
  const o = m.active.outline;
  const card = ([k, label, icon, lead]) =>
    `<div class="story-card"><div class="hd"><span class="ic">${icon}</span><h4>${esc(label)}</h4></div>` +
    (o[k] ? `<div class="tx${lead ? " lead" : ""}">${esc(o[k])}</div>` : `<div class="none">（未填写）</div>`) +
    `</div>`;
  const chars =
    `<div class="story-card"><div class="hd"><span class="ic">👥</span><h4>主要角色概念</h4></div>` +
    (o.characterConcepts.length
      ? `<div class="row tight">${o.characterConcepts.map((c) => `<span class="chip">👤 ${esc(c)}</span>`).join("")}</div>`
      : `<div class="none">（暂无）</div>`) +
    `<div class="meta">正式角色档案由「剧本拆解」进入作品设定，不从大纲自动建立。</div></div>`;
  const scale =
    `<div class="story-card"><div class="hd"><span class="ic">📐</span><h4>体量</h4></div>` +
    `<div class="kvrow"><div class="kv"><span class="k">建议集数</span><span class="v">${o.episodeCount ? `${o.episodeCount} 集` : "未定"}</span></div>` +
    `<div class="kv"><span class="k">每集时长</span><span class="v">${esc(o.durationNote || "未定")}</span></div></div></div>`;

  const versions = doc.versions
    .map((x) => `<button class="st-ep${x.v === m.active.v ? " on" : ""}" data-st-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v}${x.v === doc.approved ? " ✓" : ""}</button>`)
    .join("");
  const approve = m.approvedIsActive
    ? `<span class="chip ok">✓ 已批准 · 剧集规划以此版为准</span>`
    : `<button class="btn primary sm" data-st-approve="${m.active.v}">✔ 批准大纲 v${m.active.v}</button>`;

  // The editor is SECONDARY: it only appears on demand, so the default view is
  // readable prose instead of a wall of form fields.
  const editor = ui.storyEdit
    ? `<div class="story-card wide"><div class="hd"><span class="ic">✎</span><h4>编辑大纲 · 保存为新版本</h4>` +
      `<span class="push"></span><button class="btn primary sm" data-st-save>保存为 v${doc.versions.length + 1}</button>` +
      `<button class="btn sm" data-st-editoff>取消</button></div>` +
      `<div class="editgrid">` +
      OUTLINE_LABELS.map(([k, label]) => {
        const buf = ui.outlineBuffer || {};
        const val = k in buf ? buf[k] : o[k];
        return `<div class="kv${k === "premise" || k === "logline" ? " full" : ""}"><label class="lab">${esc(label)}</label>` +
          `<textarea class="field" rows="${k === "premise" || k === "logline" ? 3 : 2}" spellcheck="false" data-so-field="${k}">${esc(val)}</textarea></div>`;
      }).join("") +
      `</div></div>`
    : "";

  return (
    `<div class="st-sec"><h3>故事大纲 · v${m.active.v}${m.active.v === doc.approved ? "（已批准）" : ""}</h3>` +
    `<div class="acts"><div class="row tight">${versions}</div>` +
    (ui.storyEdit ? "" : `<button class="btn sm" data-st-editon>✎ 编辑</button>`) +
    approve + `</div></div>` +
    editor +
    `<div class="story-grid">` +
    SECTIONS.slice(0, 2).map(card).join("") +
    SECTIONS.slice(2).map(card).join("") +
    chars + scale +
    `</div>`
  );
}

function planCards(ctx, m) {
  const plan = m.confirmed || m.plan;
  if (!plan) {
    return (
      `<div class="st-sec"><h3>剧集规划</h3></div>` +
      empty(
        "📺",
        m.approved ? "从已批准的大纲生成分集规划" : "先批准一版故事大纲",
        m.approved
          ? "AI 会把大纲拆成每集的标题 / 梗概 / 戏剧功能 / 开场钩子 / 结尾拍 / 时长——以提案呈现，确认后才建立剧集实体。"
          : "剧集规划以「已批准」的大纲版本为准，所以先批准上面的大纲。",
        m.approved ? `<button class="btn primary" data-goto="episodes">→ 去剧集规划</button>` : "",
      )
    );
  }
  const cards = plan.episodes
    .map((e) => {
      const code = `EP${String(e.epNumber).padStart(2, "0")}`;
      return (
        `<div class="epcard"><div class="top"><span class="no">${code}</span><span class="ti">${esc(e.title)}</span>` +
        (e.duration ? `<span class="chip mute push">${esc(e.duration)}</span>` : "") +
        `</div><div class="bd">` +
        (e.synopsis ? `<div class="sy">${esc(e.synopsis)}</div>` : "") +
        `<div class="kvrow">` +
        (e.purpose ? `<div class="kv"><span class="k">戏剧功能</span><span class="v">${esc(e.purpose)}</span></div>` : "") +
        (e.hook ? `<div class="kv"><span class="k">开场钩子</span><span class="v">${esc(e.hook)}</span></div>` : "") +
        (e.endingBeat ? `<div class="kv"><span class="k">结尾拍</span><span class="v">${esc(e.endingBeat)}</span></div>` : "") +
        `</div>` +
        `<div class="ft">` +
        (e.episodeId
          ? `<button class="btn sm" data-ep-open="${esc(e.episodeId)}">进入本集剧本 →</button>`
          : `<span class="chip mute">未联结剧集</span>`) +
        `</div></div></div>`
      );
    })
    .join("");
  return (
    `<div class="st-sec"><h3>剧集规划 · v${plan.v}</h3>` +
    `<div class="acts">${m.confirmed ? `<span class="chip ok">✓ 已确认</span>` : `<span class="chip gate">未确认</span>`}` +
    `<button class="btn sm" data-goto="episodes">在「剧集」管理</button></div></div>` +
    `<div class="epgrid">${cards}</div>`
  );
}

export function renderStoryWs(ctx, ui) {
  const m = storyModel(ctx.story.doc());
  const idea =
    `<div class="story-card wide"><div class="hd"><span class="ic">💡</span><h4>创意 · Idea</h4></div>` +
    `<textarea class="field brieftext pm-brieftext" rows="2" spellcheck="false" placeholder="一句话创意，例如：深夜酒吧的女招待发现每个客人都在讲述同一个她不记得的夜晚">${esc(m.idea)}</textarea></div>`;

  const body = m.active
    ? outlineCards(ctx, m, ui)
    : m.pending && m.pending.status === "generating"
      ? ""
      : empty(
          "📑",
          "从创意发展故事大纲",
          "AI 会把一句创意发展成前提 / 故事线 / 题材基调 / 世界观 / 角色概念 / 核心冲突 / 故事弧 / 结局 / 集数——以提案呈现，应用后成为可批准的大纲版本。",
          m.hasIdea ? `<button class="btn primary" data-st-develop>🪄 AI 发展故事</button>` : "",
        );

  return (
    head("故事", "项目级 · 创意 → 故事发展 → 故事大纲 → 剧集规划 → 分集剧本") +
    pipeline(m) +
    `<div class="story-grid">${idea}</div>` +
    proposalPanel(m) +
    body +
    planCards(ctx, m)
  );
}

/** Wire the 故事 workspace. Same controllers and same gates as before; the
 *  editor toggle is transient shell state. */
export function bindStoryWs(root, ctx, ui, rerender) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  const brief = root.querySelector(".pm-brieftext");
  if (brief) brief.oninput = () => ctx.story.setIdea(brief.value);
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
  root.querySelectorAll("[data-so-field]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.soField] = el.value; };
  });
  on("[data-st-save]", () => {
    if (!Object.keys(buffer).length) { ctx.toast("没有修改"); return; }
    ui.storyEdit = false;
    ui.outlineBuffer = {};
    // applyManualOutline MERGES over the active outline, so a partial buffer
    // only changes the fields that were actually edited
    ctx.story.applyManualOutline(buffer);
  });
  on("[data-ep-open]", (el) => {
    if (ctx.story.openEpisodeScript(el.dataset.epOpen)) {
      const nav = root.querySelector('[data-mod="script"]');
      if (nav) nav.click();
    }
  });
}
