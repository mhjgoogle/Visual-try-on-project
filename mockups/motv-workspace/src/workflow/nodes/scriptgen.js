// 脚本生成器 — turns the 剧本 into a shot list (分镜). Re-runnable; each run
// produces an immutable new version (v1, v2…) that can be compared.
import { nx } from "./shared.js";

const SKEL9 = '<div class="skel live">' + "<i></i>".repeat(9) + "</div>";

// Each generation snapshots its own immutable shot list. The fixture ships v1/v2;
// any further regeneration derives a deterministic, distinct set so version
// selection and compare always show that version's real data.
export function shotsForVersion(project, v) {
  if (v === 1) return project.shots.v1;
  if (v === 2) return project.shots.v2;
  return project.shots.v2.map((s, i) => (i === 0 ? [s[0], `${s[1]} · v${v}`] : s));
}

function vmenuHtml(node) {
  return `<div class="vmenu">${node.versions
    .map((x) => `<button class="${x.v === node.cur ? "cur" : ""}" data-v="${x.v}">版本 v${x.v}${x.v === node.cur ? " ·当前" : ""}</button>`)
    .join("")}</div>`;
}

export default {
  type: "scriptgen",
  step: 1,
  stage: "S3 镜头拆分",
  title: "脚本生成器",
  icon: "🎞",
  init() {
    return { state: "", prog: 0, versions: [], cur: 0, vmenu: false };
  },
  render(node, ctx) {
    const sd = ctx.project.shots;
    if (node.state === "gen") {
      return `<div class="genbox">${SKEL9}<div class="genprog"><div class="pb"><i style="width:${node.prog}%"></i></div><span class="pc">生成中 ${node.prog}%</span><span class="cx">取消</span></div></div>`;
    }
    if (node.state === "done") {
      const curV = node.versions.find((x) => x.v === node.cur);
      const shots = curV ? curV.shots : sd.v1;
      const vbar = `<div class="vbar"><span class="vchip">v${node.cur} ▾</span>${node.versions.length >= 2 ? '<span class="vcmp">⇄ 对比</span>' : ""}${node.vmenu ? vmenuHtml(node) : ""}</div>`;
      const rows = shots.map((s) => `<div class="shotrow"><span class="n mono">${s[0]}</span><span class="nm">${s[1]}</span></div>`).join("");
      return `<div class="genbox">${vbar}${rows}<div style="font-size:11px;color:var(--text-faint);margin:2px 2px 0">…共 ${sd.total} 个镜头</div><button class="nrun ghost" data-run>重新生成（新版本）</button>${nx([["assets", "准备资产"]])}</div>`;
    }
    return `<div class="genbox"><div class="skel"><i></i><i></i><i></i><i></i><i></i><i></i></div><button class="nrun" data-run>基于剧本生成分镜</button></div>`;
  },
  run(node, ctx) {
    node.state = "gen";
    node.prog = 6;
    ctx.refresh(node);
    ctx.markIncoming(node.id, "active");
    node._timer = setInterval(() => {
      node.prog += Math.floor(Math.random() * 14) + 6;
      if (node.prog >= 100) {
        node.prog = 100;
        clearInterval(node._timer);
        node._timer = null;
        node.state = "done";
        const v = node.versions.length + 1;
        node.versions.push({ v, shots: shotsForVersion(ctx.project, v) });
        node.cur = v;
        ctx.refresh(node);
        ctx.markIncoming(node.id, "done");
        ctx.toast(v > 1 ? `重新生成完成 · 新版本 v${v}（可对比 v${v - 1}）` : "分镜完成 · 11 个镜头就绪。下一步：准备资产");
      } else {
        ctx.refresh(node);
      }
    }, 400);
  },
  bind(node, el, ctx) {
    const cx = el.querySelector(".cx");
    if (cx) cx.onclick = (e) => {
      e.stopPropagation();
      if (node._timer) { clearInterval(node._timer); node._timer = null; }
      node.state = ""; node.prog = 0;
      ctx.markIncoming(node.id, ""); // clear the incoming edge's "generating" state
      ctx.refresh(node);
    };
    const vch = el.querySelector(".vchip");
    if (vch) vch.onclick = (e) => { e.stopPropagation(); node.vmenu = !node.vmenu; ctx.refresh(node); };
    // Wire the version-menu buttons here — bind() re-runs on every (re)render with
    // the current body element, so this never depends on querying a stale element
    // from inside the click handler.
    const menu = el.querySelector(".vmenu");
    if (menu)
      menu.querySelectorAll("button").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        node.cur = +b.dataset.v;
        node.vmenu = false;
        ctx.refresh(node);
        ctx.toast(`切到版本 v${node.cur}（digest 绑定）`);
      }));
    const vcmp = el.querySelector(".vcmp");
    if (vcmp) vcmp.onclick = (e) => { e.stopPropagation(); ctx.inspector.openCompare(node); };
  },
  next: ["assets"],
};
