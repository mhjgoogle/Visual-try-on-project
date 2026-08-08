// Production Workspace shell — the creator-facing editing surface. Left nav
// selects a production module (transient UI state only — never persisted);
// center renders that module's workspace: Script keeps its full editor + the
// AI Director pane, every other stage opens a read-only status workspace
// (src/ui/workspaces.js) over the same project state — a stage with no data
// opens to an empty/needs-input state, never a disabled item. PURE
// PRESENTATION over ctx.script / ctx.prodData(): the scriptDoc domain
// document stays the single source of truth (shared with the workflow node),
// AI calls stay behind the controller in app.js.
import { $, esc } from "../util/dom.js";
import * as ws from "./workspaces.js";

const NAV = [
  ["idea", "💡", "创意"],
  ["script", "📄", "剧本"],
  ["shots", "🎞", "分镜"],
  ["assets", "🧑‍🎨", "资产"],
  ["video", "▶", "视频"],
  ["audio", "🎵", "音频"],
  ["edit", "✂", "剪辑"],
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
  const assets = ws.assetsModel(pd);
  const video = ws.videoModel(pd);
  const audio = ws.audioModel(pd);
  const edit = ws.editModel(pd);
  return {
    idea: doc.brief && doc.brief.trim() ? "✓" : "",
    script: st.versions ? `v${st.active}` : "草稿",
    shots: shots.empty ? "" : String(shots.shots.length),
    assets: assets.empty ? "" : `${assets.done}/${assets.total}`,
    video: video.empty ? "" : `${video.done}/${video.total}`,
    audio: audio.empty ? "" : `${audio.done}/${audio.total}`,
    edit: edit.finals ? `✓v${edit.finals}` : "",
  };
}

export function createProduction(getCtx) {
  const root = $("#production");
  // transient view state — NEVER persisted, never on canvas nodes
  let activeModule = "script";
  let revText = "";
  let vmenuOpen = false;

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

  function scriptContent(ctx) {
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
      `</main>` +
      `<aside class="prod-ai"><div class="pa-title">🎬 AI 导演 · 剧本助理</div>${aiPane(ctx, d, st)}</aside>`
    );
  }

  const WORKSPACES = {
    idea: ws.renderIdea,
    shots: ws.renderShots,
    assets: ws.renderAssets,
    video: ws.renderVideo,
    audio: ws.renderAudio,
    edit: ws.renderEdit,
  };

  function render() {
    const ctx = getCtx();
    const badges = navBadges(ctx.script.doc(), ctx.prodData());
    const nav = NAV.map(([k, icon, label]) => {
      const b = badges[k];
      return `<button class="pnav-item${k === activeModule ? " active" : ""}" data-mod="${k}">${icon} ${label}${b ? `<span class="pnav-badge">${esc(b)}</span>` : ""}</button>`;
    }).join("");
    const content =
      activeModule === "script"
        ? scriptContent(ctx)
        : `<main class="prod-main">${WORKSPACES[activeModule](ctx)}</main>`;
    root.classList.toggle("noai", activeModule !== "script");
    root.innerHTML = `<nav class="prod-nav">${nav}</nav>` + content;
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
    // the brief textarea exists in BOTH the script and idea workspaces
    const brief = root.querySelector(".pm-brieftext");
    if (brief) brief.oninput = () => ctx.script.setBrief(brief.value);
    const jump = root.querySelector("[data-goto]");
    if (jump) jump.onclick = () => setModule(jump.dataset.goto);
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
