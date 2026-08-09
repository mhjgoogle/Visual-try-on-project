// Production studio shell (M8) — the creator-facing production environment:
// LEFT navigation/resources · CENTER production workspace · RIGHT persistent
// AI Director. The workflow node canvas stays available under the ⛓ tab but
// is no longer the primary creator experience.
//
// PURE PRESENTATION over the domain documents (scriptDoc / production / bible
// / Asset & Generation registries) through ctx controllers — the shell owns
// only TRANSIENT UI state (active module, selection, edit buffers, open
// panels), never persisted, never on canvas nodes.
import { $, esc } from "../util/dom.js";
import * as ws from "./workspaces.js";
import { renderStoryboard, bindStoryboard } from "./storyboard.js";
import { directorModel, renderDirector, bindDirector } from "./director.js";

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
 *  module stays clickable regardless of workflow progress (unit-tested). */
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

export function createProduction(getCtx) {
  const root = $("#production");
  // transient view state — NEVER persisted, never on canvas nodes
  let activeModule = "script";
  let revText = "";
  let vmenuOpen = false;
  const openBible = new Set(); // 作品设定 <details> open state (transient)
  // storyboard selection + UNSAVED shot-edit buffer + director instruction —
  // shared across re-renders so a media action / poll re-render never
  // discards in-progress field edits (they commit only on explicit save)
  const ui = { selectedShotId: null, dirty: false, buffer: {}, directorText: "" };

  function vmenuHtml(d) {
    const label = { generated: "AI 生成", revision: "AI 修订", manual: "手工" };
    return `<div class="vmenu">${d.versions
      .map(
        (x) =>
          `<button class="${x.v === d.active ? "cur" : ""}" data-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v} · ${esc(label[x.origin] || x.origin)}${x.v === d.active ? " ·当前" : ""}</button>`,
      )
      .join("")}</div>`;
  }

  // --- the SCRIPT module keeps its full live assistant ---------------------- //
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

  /** The persistent right-side AI Director. Script gets the live assistant;
   *  every other module gets the structured Director panel (context +
   *  instruction + real action where one exists + generation history). */
  function aiDirector(ctx) {
    if (activeModule === "script") {
      const d = ctx.script.doc();
      return `<aside class="prod-ai"><div class="pa-title">🎬 AI 导演 · 剧本助理</div>${aiPane(ctx, d, scriptStatus(d))}</aside>`;
    }
    const m = directorModel({
      module: activeModule,
      doc: ctx.script.doc(),
      pd: ctx.prodData(),
      sel: ui,
    });
    return (
      `<aside class="prod-ai"><div class="pa-title">🎬 AI 导演 · ${esc(MODULE_LABEL[activeModule] || "")}</div>` +
      renderDirector(m, ui.directorText) +
      `</aside>`
    );
  }

  /** Persistent Project / current-Episode context header. Since M6 the active
   *  Episode is a REAL persisted domain entity (production document). */
  function ctxHead(ctx) {
    const name = (ctx.project && ctx.project.name) || "未命名项目";
    const prod = ctx.production && ctx.production.doc();
    const ep = prod && (prod.episodes.find((e) => e.episodeId === prod.activeEpisodeId) || prod.episodes[0]);
    const epLabel = ep ? ep.title : "当前剧集";
    const more = prod && prod.episodes.length > 1 ? `（共 ${prod.episodes.length} 集，在「剧集」切换）` : "";
    return (
      `<header class="prod-ctx"><span class="pc-proj">📁 ${esc(name)}</span>` +
      `<span class="pc-sep">›</span><span class="pc-ep">📺 ${esc(epLabel)}</span>` +
      `<span class="pc-sep">›</span><span class="pc-mod">${esc(MODULE_LABEL[activeModule] || "")}</span>` +
      `<span class="pc-note">${esc(more)}</span></header>`
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
    story: (ctx) => ws.renderStory(ctx),
    settings: (ctx) => ws.renderSettings(ctx),
    episodes: (ctx) => ws.renderEpisodes(ctx),
    shots: (ctx) => renderStoryboard(ctx, ui),
    frames: (ctx) => ws.renderFrames(ctx),
    video: (ctx) => ws.renderVideo(ctx),
    audio: (ctx) => ws.renderAudio(ctx),
    edit: (ctx) => ws.renderEdit(ctx),
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
            return `<button class="pnav-item${k === activeModule ? " active" : ""}" data-mod="${k}"><span class="pnav-ic">${icon}</span>${label}${b ? `<span class="pnav-badge">${esc(b)}</span>` : ""}</button>`;
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
    if (k === activeModule) return; // staying put must not touch unsaved edits
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    activeModule = k; // UI navigation state only — domain edits/proposals live
    vmenuOpen = false; // in their documents and survive this switch untouched
    render();
  }

  function bind(ctx) {
    // left nav — every module opens; selection is visually .active
    root.querySelectorAll("[data-mod]").forEach((b) => (b.onclick = () => setModule(b.dataset.mod)));
    // the brief textarea exists in BOTH the script and story workspaces
    const brief = root.querySelector(".pm-brieftext");
    if (brief) brief.oninput = () => ctx.script.setBrief(brief.value);
    // cross-module jumps (empty states, director) — EVERY [data-goto] wires
    root.querySelectorAll("[data-goto]").forEach((j) => (j.onclick = () => setModule(j.dataset.goto)));
    // 剧集 workspace structure actions (M6) — domain writes via ctx.production
    if (activeModule === "episodes") ws.bindEpisodes(root, ctx);
    // 作品设定 workspace (M7) — domain writes via ctx.bible. Re-renders
    // collapse <details>; restore the ones the creator had open.
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
    // 分镜 storyboard (M8) — selection + buffered shot edits + media actions
    if (activeModule === "shots") bindStoryboard(root, ctx, ui, render);
    // AI Director (non-script modules) — real dispatches only
    if (activeModule !== "script") {
      bindDirector(root, ctx, ui);
      return;
    }
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
