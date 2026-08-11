// 故事大纲工作区 — the durable Story Outline, read as prose.
//
// 「故事发展」 is NOT a stage of its own (ADR-0054 §4): AI Story Development is
// the AI Director's ABILITY to develop this outline, not a separate domain
// layer. The spine the creator sees is 创意 → 故事大纲 → 分集规划, and the
// outline surface shows exactly one thing: Working Draft / the current formal
// Revision, plus the Creative Brief revision it was developed from.
//
// The version model is the EXISTING one (story.versions / active / approved) —
// no second Story data was introduced. Behaviour is unchanged: the same
// ctx.story controllers, the same proposal-then-apply gate, the same
// approval/confirmation semantics.
import { esc } from "../util/dom.js";
import { storyModel, OUTLINE_LABELS } from "./workspaces.js";
import { briefForOutline } from "../workflow/storydoc.js";
import { head, empty } from "./shell.js";

// The outline sections, grouped the way a writer reads them rather than the
// order the schema happens to store them in.
const SECTIONS = [
  ["premise", "前提 Premise", "🎯", true],
  ["logline", "主线 Logline", "🧭", true],
  ["centralConflict", "核心冲突", "⚔", false],
  ["storyArc", "Story Arc 故事弧", "📈", false],
  ["climax", "高潮", "🔥", false],
  ["ending", "Ending 结局", "🏁", false],
  ["genreTone", "题材 / 基调", "🎨", false],
  ["world", "世界观（概述）", "🌐", false],
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

  // 「Based on Creative Brief v2」 — lightweight upstream provenance, read off
  // the version's own launch-time link. No DAG here (ADR-0054 §8/§11).
  const src = briefForOutline(doc, m.active);
  const basedOn = src
    ? `<span class="chip" title="本版大纲是基于该创意版本发展出来的">Based on 创意 v${src.v}</span>`
    : `<span class="chip mute" title="这一版大纲没有记录所依据的创意版本">未记录所依据的创意版本</span>`;
  const standing = m.active.v === doc.versions.length
    ? m.active.v === doc.approved
      ? `<span class="chip ok">当前正式版本</span>`
      : `<span class="chip gate">最新版本 · 未批准</span>`
    : `<span class="chip mute">正在查看历史版本</span>`;

  return (
    `<div class="st-sec"><h3>Story Outline v${m.active.v}${m.active.v === doc.approved ? "（已批准）" : ""}</h3>` +
    `<div class="acts">${standing}${basedOn}<div class="row tight">${versions}</div>` +
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
          "AI 会把一句创意发展成前提 / 故事线 / 题材基调 / 世界观 / 角色概念 / 核心冲突 / 故事弧 / 结局 / 集数——以提案呈现，应用后成为可批准的大纲版本。",
          m.hasIdea ? `<button class="btn primary" data-st-develop>🪄 AI 发展故事</button>` : "",
        );

  return (
    head("故事大纲", "项目级 · 持久版本链；AI 只出提案，应用后才成为新版本") +
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
  // NOTE: [data-ep-open] is deliberately NOT wired here. Entering an episode is
  // a SHELL decision (switch the active episode AND open one of its stages), and
  // the shell owns it — see enterEpisode in ui/production.js, which binds this
  // attribute after every workspace's own bindings.
}
