// Production Workspace shell (M2.5 — final information architecture).
//
// Creator-facing product shell: a persistent Project/Episode context header,
// a grouped left nav (项目级 / 当前剧集), the selected module's workspace in
// the center, and a PERSISTENT right-side AI Director region. The Script
// module keeps its full editor + live AI assistant; every other module's AI
// pane states honestly what is available today and what waits on later
// domain checkpoints (M3/M4). PURE PRESENTATION over ctx.script /
// ctx.prodData(): the scriptDoc domain document stays the single source of
// truth (shared with the workflow node), AI calls stay behind the controller
// in app.js. Nav selection is transient UI state only — never persisted.
import { $, esc } from "../util/dom.js";
import * as ws from "./workspaces.js";

/** Grouped navigation — the approved final IA. Exported for tests. */
export const NAV = [
  {
    sec: "项目",
    items: [
      ["story", "📖", "故事"],
      ["settings", "🎭", "作品设定"],
      ["episodes", "📺", "剧集"],
    ],
  },
  {
    sec: "当前剧集",
    items: [
      ["script", "📄", "剧本"],
      ["shots", "🎞", "分镜"],
      ["frames", "🖼", "画面"],
      ["video", "▶", "视频"],
      ["audio", "🎵", "音频"],
      ["edit", "✂", "剪辑"],
    ],
  },
];

/** Pure view-model of the script document for the shell (unit-tested):
 *  version standing + exactly one of the transient generation states. */
export function scriptStatus(doc) {
  const p = doc.pending;
  return {
    versions: doc.versions.length,
    active: doc.active,
    nextVersion: doc.versions.length + 1,
    generating: !!p && p.status === "generating",
    proposal:
      p && p.status === "proposed"
        ? { instruction: p.instruction, text: p.proposal }
        : null,
    error: p && p.status === "failed" ? p.error : null,
  };
}

/** Pure nav badges from current state — counts, not availability: every
 *  module stays clickable regardless of workflow progress (unit-tested).
 *  作品设定/剧集 carry no counts: their domain models don't exist yet and a
 *  fabricated number would claim persistence M2.5 does not have. */
export function navBadges(doc, pd) {
  const st = scriptStatus(doc);
  const shots = ws.shotsModel(pd);
  const frames = ws.assetsModel(pd);
  const video = ws.videoModel(pd);
  const audio = ws.audioModel(pd);
  const edit = ws.editModel(pd);
  const prod = pd.production;
  const bibleCount = prod && Array.isArray(prod.characters) && Array.isArray(prod.locations)
    ? prod.characters.length + prod.locations.length
    : 0;
  return {
    story: doc.brief && doc.brief.trim() ? "✓" : "",
    // M7: real persisted bible entities (characters + locations)
    settings: bibleCount ? String(bibleCount) : "",
    // M6: real persisted Episode entities — the count is honest domain data
    episodes: prod && Array.isArray(prod.episodes) ? String(prod.episodes.length) : "",
    script: st.versions ? `v${st.active}` : "草稿",
    shots: shots.empty ? "" : String(shots.shots.length),
    frames: frames.empty ? "" : `${frames.done}/${frames.total}`,
    video: video.empty ? "" : `${video.done}/${video.total}`,
    audio: audio.empty ? "" : `${audio.done}/${audio.total}`,
    edit: edit.finals ? `✓v${edit.finals}` : "",
  };
}

const MODULE_LABEL = {
  story: "故事", settings: "作品设定", episodes: "剧集", script: "剧本",
  shots: "分镜", frames: "画面", video: "视频", audio: "音频", edit: "剪辑",
};

/** AI Director copy for non-script modules: first what WILL come (and what it
 *  waits on), then what genuinely works today — honest labels, nothing fake. */
const AI_DIRECTOR = {
  story: {
    future: ["创意扩写、题材/结构建议（待创意域扩展）"],
    now: ["现在可用：写下创意后，到「剧本」工作区一键生成剧本 v1"],
  },
  settings: {
    future: ["按设定的一致性检查、Prompt 编译（待后续检查点）"],
    now: ["现在可用：建立角色/场景地档案与状态（少女/黑化、日/夜…），挂参考图，供场景按 ID 引用（结构已持久化，M7）"],
  },
  episodes: {
    future: ["剧集规划、跨集连贯性建议（待后续检查点）"],
    now: ["现在可用：新建/切换剧集，在剧集内建场景并把镜头归入场景（结构已持久化，M6）"],
  },
  shots: {
    future: ["按镜头的修订建议与一致性检查（待资产/生成记录域，M3/M4）"],
    now: ["现在可用：分镜生成/重新生成/手工编辑在工作流视图「脚本生成器」节点"],
  },
  frames: {
    future: ["画面一致性/风格检查（待资产域模型，M3）"],
    now: ["现在可用：图片上传与付费生成在工作流视图「资产准备」节点"],
  },
  video: {
    future: ["镜头节奏/运动建议（待生成记录域，M4）"],
    now: ["现在可用：视频上传/付费生成在工作流视图「视频生成」节点"],
  },
  audio: {
    future: ["配音风格与情绪建议（待 VoiceProfile 域，后续检查点）"],
    now: ["现在可用：配音上传/本地 TTS 在工作流视图「音频生成」节点"],
  },
  edit: {
    future: ["剪辑节奏/转场建议（待生成记录域，M4）"],
    now: ["现在可用：本地 FFmpeg 合成在工作流视图「剪辑合成」节点（免费）"],
  },
};

export function createProduction(getCtx) {
  const root = $("#production");
  // transient view state — NEVER persisted, never on canvas nodes
  let activeModule = "script";
  let revText = "";
  let vmenuOpen = false;
  const openBible = new Set(); // 作品设定 <details> open state (transient)

  function vmenuHtml(d) {
    const label = { generated: "AI 生成", revision: "AI 修订", manual: "手工" };
    return `<div class="vmenu">${d.versions
      .map(
        (x) =>
          `<button class="${x.v === d.active ? "cur" : ""}" data-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v} · ${esc(label[x.origin] || x.origin)}${x.v === d.active ? " ·当前" : ""}</button>`,
      )
      .join("")}</div>`;
  }

  function aiPane(ctx, d, st) {
    if (st.generating) {
      const lab = d.pending.kind === "initial" ? "AI 生成剧本中…" : "AI 生成修订稿中…";
      return `<div class="skel live"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="genprog"><span class="pc">${lab}</span><span class="cx">取消</span></div>`;
    }
    let out = "";
    if (st.error) {
      out += `<div class="scripterr">⚠ 生成失败：${esc(st.error)}<button class="errx" data-errx>知道了</button></div>`;
    }
    if (st.proposal) {
      // proposal vs current: both labeled, apply is explicitly "new version"
      return (
        out +
        `<div class="pa-cur">当前剧本：<b>v${st.active}</b>${ctx.script.isDirty() ? "（含未版本化的手工修改）" : ""}</div>` +
        `<div class="proposal"><div class="proplab">修订稿提案 · 未应用 · 要求：${esc(st.proposal.instruction)}</div>` +
        `<textarea class="pa-proptext" readonly spellcheck="false">${esc(st.proposal.text)}</textarea>` +
        `<div class="vbtns"><button class="nrun" data-apply>✔ 应用为 v${st.nextVersion}（新持久版本）</button><button class="nrun ghost" data-discard>放弃提案</button></div></div>` +
        `<div class="pa-note">应用后成为持久版本 v${st.nextVersion}；v1…v${st.versions} 全部保留，可随时回切。</div>`
      );
    }
    if (!st.versions && !ctx.script.hasContent()) {
      return (
        out +
        `<div class="pa-note">先在左侧写一句创意，然后：</div>` +
        `<button class="nrun" data-gen>AI 生成剧本 v1（基于创意）</button>`
      );
    }
    return (
      out +
      `<label class="pa-lab">修改要求</label>` +
      `<textarea class="pa-rev" rows="3" spellcheck="false" placeholder="例如：结尾加一个反转；台词更口语化">${esc(revText)}</textarea>` +
      `<button class="nrun" data-revise>AI 修订 → 生成提案</button>` +
      `<div class="pa-note">提案不会直接生效：确认「应用」后才会创建新版本 v${st.nextVersion}，旧版本全部保留。</div>`
    );
  }

  /** The persistent right-side AI Director region. Script gets the live
   *  assistant; every other module states capabilities honestly. */
  function aiDirector(ctx) {
    if (activeModule === "script") {
      const d = ctx.script.doc();
      return `<aside class="prod-ai"><div class="pa-title">🎬 AI 导演 · 剧本助理</div>${aiPane(ctx, d, scriptStatus(d))}</aside>`;
    }
    const c = AI_DIRECTOR[activeModule] || { future: [], now: [] };
    const future = c.future
      .map((t) => `<div class="pa-unavail">◌ ${esc(t)}</div>`)
      .join("");
    const now = c.now.map((t) => `<div class="pa-note">${esc(t)}</div>`).join("");
    return (
      `<aside class="prod-ai"><div class="pa-title">🎬 AI 导演 · ${esc(MODULE_LABEL[activeModule] || "")}</div>` +
      `<div class="pa-lab">待后续域模型解锁</div>${future}${now}</aside>`
    );
  }

  /** Persistent Project / current-Episode context header. Since M6 the active
   *  Episode is a REAL persisted domain entity (production document); episode
   *  management lives in the 剧集 workspace. */
  function ctxHead(ctx) {
    const name = (ctx.project && ctx.project.name) || "未命名项目";
    const prod = ctx.production && ctx.production.doc();
    const ep = prod && (prod.episodes.find((e) => e.episodeId === prod.activeEpisodeId) || prod.episodes[0]);
    const epLabel = ep ? ep.title : "当前剧集";
    const more = prod && prod.episodes.length > 1 ? `（共 ${prod.episodes.length} 集，在「剧集」切换）` : "";
    return (
      `<header class="prod-ctx"><span class="pc-proj">📁 ${esc(name)}</span>` +
      `<span class="pc-sep">›</span><span class="pc-ep">📺 ${esc(epLabel)}</span>` +
      `<span class="pc-note">剧集/场景结构已持久化（M6）${esc(more)}</span></header>`
    );
  }

  function scriptMain(ctx) {
    const d = ctx.script.doc();
    const st = scriptStatus(d);
    const dirty = ctx.script.isDirty();
    const vbar = st.versions
      ? `<div class="vbar"><span class="vchip">v${st.active} ▾</span><span class="dirtytag" ${dirty ? "" : "hidden"}>已手工修改（未版本化）</span>${vmenuOpen ? vmenuHtml(d) : ""}</div>`
      : "";
    return (
      `<main class="prod-main">` +
      `<div class="pm-head"><div class="pm-title">📄 剧本工作区</div>${vbar}<div class="pm-note">应用修订 = 创建新版本，旧版本保留</div></div>` +
      `<div class="pm-brief"><label class="pa-lab">💡 创意 / 想法</label><textarea class="brieftext pm-brieftext" rows="2" spellcheck="false" placeholder="一句话创意，例如：社畜穿越盛唐，被逼当殿作诗">${esc(d.brief)}</textarea></div>` +
      `<textarea class="pm-text" spellcheck="false" placeholder="在此输入/粘贴剧本，或在右侧用创意生成">${esc(ctx.script.currentText())}</textarea>` +
      `</main>`
    );
  }

  const WORKSPACES = {
    story: ws.renderStory,
    settings: ws.renderSettings,
    episodes: ws.renderEpisodes,
    shots: ws.renderShots,
    frames: ws.renderFrames,
    video: ws.renderVideo,
    audio: ws.renderAudio,
    edit: ws.renderEdit,
  };

  function render() {
    const ctx = getCtx();
    const badges = navBadges(ctx.script.doc(), ctx.prodData());
    const nav = NAV.map(
      (grp) =>
        `<div class="pnav-sec">${esc(grp.sec)}</div>` +
        grp.items
          .map(([k, icon, label]) => {
            const b = badges[k];
            return `<button class="pnav-item${k === activeModule ? " active" : ""}" data-mod="${k}">${icon} ${label}${b ? `<span class="pnav-badge">${esc(b)}</span>` : ""}</button>`;
          })
          .join(""),
    ).join("");
    const main =
      activeModule === "script"
        ? scriptMain(ctx)
        : `<main class="prod-main">${WORKSPACES[activeModule](ctx)}</main>`;
    root.innerHTML =
      ctxHead(ctx) + `<nav class="prod-nav">${nav}</nav>` + main + aiDirector(ctx);
    bind(ctx);
  }

  function setModule(k) {
    if (!WORKSPACES[k] && k !== "script") return;
    activeModule = k; // UI navigation state only — Script edits/proposal live
    vmenuOpen = false; // in scriptDoc and survive this switch untouched
    render();
  }

  function bind(ctx) {
    // left nav — every module opens; selection is visually .active
    root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => setModule(b.dataset.mod)));
    // the brief textarea exists in BOTH the script and story workspaces
    const brief = root.querySelector(".pm-brieftext");
    if (brief) brief.oninput = () => ctx.script.setBrief(brief.value);
    const jump = root.querySelector("[data-goto]");
    if (jump) jump.onclick = () => setModule(jump.dataset.goto);
    // 剧集 workspace structure actions (M6) — domain writes via ctx.production
    if (activeModule === "episodes") ws.bindEpisodes(root, ctx);
    // 作品设定 workspace (M7) — domain writes via ctx.bible. Re-renders
    // collapse <details>; restore the ones the creator had open (transient
    // UI state only, never persisted).
    if (activeModule === "settings") {
      ws.bindSettings(root, ctx);
      root.querySelectorAll("details[data-key]").forEach((d) => {
        if (openBible.has(d.dataset.key)) d.open = true;
        d.ontoggle = () => {
          if (d.open) openBible.add(d.dataset.key);
          else openBible.delete(d.dataset.key);
        };
      });
    }
    if (activeModule !== "script") return;
    // --- script workspace bindings (unchanged behavior) ---
    const text = root.querySelector(".pm-text");
    const dirtyTag = root.querySelector(".dirtytag");
    if (text)
      text.oninput = () => {
        ctx.script.edit(text.value); // no re-render — keeps the caret
        if (dirtyTag) dirtyTag.hidden = !ctx.script.isDirty();
      };
    const rev = root.querySelector(".pa-rev");
    if (rev) rev.oninput = () => { revText = rev.value; };
    const on = (sel, fn) => {
      const el = root.querySelector(sel);
      if (el) el.onclick = fn;
    };
    on("[data-gen]", () => ctx.script.generate("initial", ctx.script.doc().brief));
    on("[data-revise]", () => ctx.script.generate("revision", revText));
    on("[data-apply]", () => { revText = ""; ctx.script.applyProposal(); });
    on("[data-discard]", () => ctx.script.discardProposal());
    on("[data-errx]", () => ctx.script.cancel());
    on(".cx", () => ctx.script.cancel());
    on(".vchip", () => { vmenuOpen = !vmenuOpen; render(); });
    const menu = root.querySelector(".vmenu");
    if (menu)
      menu.querySelectorAll("button").forEach((b) => (b.onclick = () => {
        vmenuOpen = false;
        ctx.script.setActive(+b.dataset.v); // triggers refreshType → re-render
      }));
  }

  return {
    render,
    show() { root.style.display = "grid"; render(); },
    hide() { root.style.display = "none"; vmenuOpen = false; },
    isVisible: () => root.style.display === "grid",
  };
}
