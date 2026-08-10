// 🎬 AI 导演 — the persistent right-hand panel of the Production studio (M8).
//
// A REAL panel over real state: the current context line, an instruction box,
// a primary generate/revise action, and the generation history read straight
// from the M5 Generation Registry + the script document. Actions are wired
// where a real free path exists TODAY (script generate/revise via the local
// agent; storyboard draft generation); everything else states honestly what
// it waits on — no fake buttons that pretend to generate.
import { esc } from "../util/dom.js";
import { scriptStatus } from "./production.js";

const MODULE_LABEL = {
  story: "故事", settings: "作品设定", episodes: "剧集", storage: "存储",
  script: "剧本", shots: "分镜", frames: "画面", video: "视频", audio: "音频",
  edit: "时间线",
};

const STATUS_ZH = { queued: "排队", generating: "生成中", success: "成功", failed: "失败", cancelled: "已取消" };
const TYPE_ICON = { image: "🖼", video: "▶", audio: "🎵" };

/** Pure view-model of the Director panel. `sel` is the shell's transient
 *  selection ({ selectedShotId } — storyboard only). */
export function directorModel({ module, doc, story, pd, sel }) {
  const st = scriptStatus(doc);
  const approved = story ? story.versions.find((x) => x.v === story.approved) || null : null;
  const shot = sel && sel.selectedShotId
    ? (pd.draftShots || []).find((s) => s && s.shotId === sel.selectedShotId) || null
    : null;
  // context: where the director is looking right now
  const context = [`模块：${MODULE_LABEL[module] || module}`];
  if (module === "story" && story) {
    context.push(story.versions.length ? `大纲 v${story.active}（共 ${story.versions.length} 版）` : "大纲：未发展");
    context.push(approved ? `已批准 v${approved.v}` : "大纲未批准");
  }
  if (module === "episodes" && story) {
    context.push(approved ? `大纲 v${approved.v} 已批准` : "大纲未批准");
    context.push(story.confirmedPlan ? `规划 v${story.confirmedPlan} 已确认` : story.plans.length ? `规划 v${story.activePlan}（未确认）` : "规划：未生成");
  }
  if (module === "script") context.push(st.versions ? `本集剧本 v${st.active}（共 ${st.versions} 版）` : "本集剧本：草稿");
  if (module === "shots") {
    context.push(pd.draftShots && pd.draftShots.length ? `分镜 ${pd.draftShots.length} 镜` : "分镜：未生成");
    if (shot) context.push(`选中镜头 ${String(shot.sequence).padStart(2, "0")} ${shot.title || ""}`);
  }
  // the ONE primary action this module really has today
  // `input: true` ⇔ the action actually CONSUMES the instruction text — an
  // input box is never rendered for an action that would silently discard it
  let primary = null;
  if (module === "story") {
    // M9: the story workspace develops the IDEA into an outline — the path to
    // scripts goes through approval and the episode plan, never a direct jump
    primary = story && story.versions.length
      ? { kind: "story-develop", label: "🪄 AI 修订大纲 → 生成提案", ph: "修改要求，例如：基调更黑色幽默；结局改开放式", input: true }
      : { kind: "story-develop", label: "🪄 AI 发展故事（生成大纲提案）", ph: "可补充方向，例如：偏权谋、女性主角", input: true };
  } else if (module === "episodes") {
    primary = approved
      ? { kind: "story-plan", label: "🪄 生成剧集规划提案", ph: "可补充要求，例如：压缩到 4 集、每集都要钩子", input: true }
      : null;
  } else if (module === "script") {
    primary = st.versions || doc.workingText
      ? { kind: "script-revise", label: "AI 修订本集剧本 → 生成提案", ph: "修改要求，例如：结尾加一个反转", input: true }
      : { kind: "script-initial", label: "AI 生成本集剧本 v1", ph: "留空则使用 大纲+本集规划 组成的上下文", input: true };
  } else if (module === "shots") {
    primary = pd.draftShots && pd.draftShots.length
      ? { kind: "shots-generate", label: "↻ 重新生成分镜（新版本）", ph: "当前版本保留；重新生成产出全新草稿版本", input: false }
      : { kind: "shots-generate", label: "🎬 基于剧本生成分镜", ph: "需要剧本 — 生成走本地 Claude，免费", input: false };
  } else if (module === "settings") {
    // AI-first bible: script breakdown → proposals (M8)
    primary = { kind: "bible-breakdown", label: "🪄 剧本拆解 → 同步作品设定提案", ph: "提案逐条确认，绝不覆盖已确认档案", input: false };
  }
  // what is NOT wired yet, said honestly
  const pending = {
    settings: "按设定的一致性检查 / Prompt 编译（待后续检查点）",
    episodes: approved ? null : "剧集规划需要已批准的故事大纲 — 先在「故事」发展并批准",
    frames: "按镜头生成图片：付费生成在工作流「资产准备」节点（ADR-0045）",
    video: "按镜头生成视频：付费生成在工作流「视频生成」节点（ADR-0041/0046）",
    audio: "对白/环境音/SFX/BGM 入口在音频工作区：本地 TTS（免费）· 复制提示词 · 导入 · Voice/Music API（未来）",
    edit: "时间线：修剪/音量/淡入淡出/重排 → 本地 FFmpeg 渲染本集（免费，含渲染溯源）",
    storage: "推荐清理：移除本地副本（保身份/溯源/引用）；永久删除受引用阻断保护",
  }[module] || null;
  // history: newest first — real provenance (M5), never fabricated
  const history = (pd.generations || [])
    .slice()
    .reverse()
    .slice(0, 8)
    .map((g) => ({
      icon: TYPE_ICON[g.type] || "•",
      label: `${g.type}${g.targetId ? ` · 镜头` : ""}`,
      status: STATUS_ZH[g.status] || g.status,
      ok: g.status === "success",
      busy: g.status === "generating" || g.status === "queued",
      when: g.createdAt ? g.createdAt.slice(5, 16).replace("T", " ") : "",
    }));
  // the transient run this module's action drives: the STORY document's
  // pending for story/episodes, the episode script's for everything else
  const pend = (module === "story" || module === "episodes") && story ? story.pending : doc.pending;
  return {
    context,
    primary,
    pending,
    history,
    generating: !!(pend && pend.status === "generating"),
    proposal: !!(pend && pend.status === "proposed"),
    // where a pending proposal is reviewed — derived from WHAT is pending
    // (its kind), not from where the user happens to be standing
    proposalGoto: pend && pend.kind === "plan" ? "episodes" : pend && pend.kind === "outline" ? "story" : "script",
    error: pend && pend.status === "failed" ? pend.error : null,
    module,
  };
}

/** Render the persistent panel. The SCRIPT module keeps its full live
 *  assistant (proposal apply/discard) — rendered by the shell; this covers
 *  every other module with the same structure. */
export function renderDirector(m, instruction) {
  const ctxLines = m.context.map((t) => `<div class="dir-ctx">${esc(t)}</div>`).join("");
  let action = "";
  if (m.generating) {
    action = `<div class="skel live"><i></i><i></i><i></i><i></i></div><div class="genprog"><span class="pc">AI 生成中…</span><span class="cx" data-dir-cancel="${esc(m.module)}">取消</span></div>`;
  } else if (m.proposal) {
    // reviewing happens in the workspace; when we ARE that workspace's module
    // the proposal panel is already on screen — no jump button needed
    const jump = m.proposalGoto !== m.module
      ? `<button class="nrun ghost" data-goto="${esc(m.proposalGoto)}">→ 去处理提案</button>`
      : "";
    action = `<div class="pa-note">📝 有一份提案待处理 — 在工作区「应用」或「放弃」后可继续</div>${jump}`;
  } else if (m.primary) {
    // instruction input ONLY for actions that consume it; others get the
    // explanation as a plain note (never a silently-discarded input)
    const inputOrNote = m.primary.input
      ? `<label class="pa-lab">指令</label>` +
        `<textarea class="pa-rev dir-input" rows="3" spellcheck="false" placeholder="${esc(m.primary.ph)}">${esc(instruction)}</textarea>`
      : `<div class="pa-note">${esc(m.primary.ph)}</div>`;
    action =
      (m.error ? `<div class="scripterr">⚠ 上次生成失败：${esc(m.error)}<button class="errx" data-dir-cancel="${esc(m.module)}">知道了</button></div>` : "") +
      inputOrNote +
      `<button class="nrun" data-dir-run="${esc(m.primary.kind)}">${esc(m.primary.label)}</button>`;
  }
  const pending = m.pending ? `<div class="pa-unavail">◌ ${esc(m.pending)}</div>` : "";
  const history = m.history.length
    ? `<div class="pa-lab">生成历史</div>` + m.history
        .map(
          (h) =>
            `<div class="dir-hist"><span>${h.icon}</span><span class="dir-hist-l">${esc(h.label)}</span>` +
            `<span class="ws-tag${h.ok ? " ok" : h.busy ? "" : " gate"}">${esc(h.status)}</span>` +
            `<span class="ws-desc">${esc(h.when)}</span></div>`,
        )
        .join("")
    : `<div class="pa-lab">生成历史</div><div class="ws-desc">还没有生成记录 — 每次 AI 生成都会记录在项目溯源里</div>`;
  return `<div class="dir-body">${ctxLines}${action}${pending}${history}</div>`;
}

/** Wire the panel. Real dispatches only; `state.directorText` holds the
 *  instruction across re-renders (transient). */
export function bindDirector(root, ctx, state) {
  const input = root.querySelector(".dir-input");
  if (input) input.oninput = () => { state.directorText = input.value; };
  const run = root.querySelector("[data-dir-run]");
  if (run)
    run.onclick = () => {
      const kind = run.dataset.dirRun;
      const text = (state.directorText || "").trim();
      if (kind === "script-initial") {
        // M9: default context = idea + approved outline + this EP's plan entry
        ctx.script.generate("initial", text || ctx.episodeScriptBrief());
      } else if (kind === "script-revise") {
        if (!text) { ctx.toast("先写修改要求"); return; }
        state.directorText = "";
        ctx.script.generate("revision", text);
      } else if (kind === "shots-generate") {
        if (!ctx.script.hasContent()) { ctx.toast("剧本为空：先生成/输入剧本"); return; }
        // same confirm-discard gate as the storyboard's own regenerate button
        if (state.dirty && !window.confirm("镜头详情有未保存的修改，重新生成将丢弃？")) return;
        state.dirty = false;
        state.buffer = {};
        state.selectedShotId = null;
        if (!ctx.shots.generateDraft()) ctx.toast("已有一个生成在进行中");
      } else if (kind === "bible-breakdown") {
        ctx.breakdown.run();
      } else if (kind === "story-develop") {
        state.directorText = "";
        ctx.story.develop("outline", text);
      } else if (kind === "story-plan") {
        state.directorText = "";
        ctx.story.develop("plan", text);
      }
    };
  const cancel = root.querySelector("[data-dir-cancel]");
  if (cancel)
    cancel.onclick = () => {
      const mod = cancel.dataset.dirCancel;
      if (mod === "story" || mod === "episodes") ctx.story.cancel();
      else ctx.script.cancel();
    };
}
