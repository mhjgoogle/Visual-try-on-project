// 剧本 — the creator-facing Idea → Script surface. This node is a VIEW over the
// script DOMAIN document (workflow/scriptdoc.js, reached only via ctx.script):
// Creative Brief (创意) → AI-generated script v1 → revision instruction → AI
// proposal → apply as v2 (v1 preserved, versions switchable). All AI calls and
// state transitions live behind ctx.script in app.js — never here.
import { nx } from "./shared.js";
import { esc } from "../../util/dom.js";

const ORIGIN_LABEL = { generated: "AI 生成", revision: "AI 修订", manual: "手工" };

function vmenuHtml(d) {
  return `<div class="vmenu">${d.versions
    .map(
      (x) =>
        `<button class="${x.v === d.active ? "cur" : ""}" data-v="${x.v}" title="${esc(x.instruction || "")}">v${x.v} · ${esc(ORIGIN_LABEL[x.origin] || x.origin)}${x.v === d.active ? " ·当前" : ""}</button>`,
    )
    .join("")}</div>`;
}

export default {
  type: "script",
  step: 0,
  stage: "S1 剧本",
  title: "剧本",
  icon: "📄",
  init() {
    return {}; // view-only state (vmenu / revInput are transient, never persisted)
  },
  render(node, ctx) {
    const d = ctx.script.doc();
    const p = d.pending;
    const brief = `<div class="brieflab">💡 创意 / 想法</div><textarea class="brieftext" rows="2" spellcheck="false" placeholder="一句话创意，例如：社畜穿越盛唐，被逼当殿作诗">${esc(d.brief)}</textarea>`;
    if (p && p.status === "generating") {
      const lab = p.kind === "initial" ? "AI 生成剧本中…" : "AI 生成修订稿中…";
      return `<div class="scriptbox">${brief}<div class="skel live"><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="genprog"><span class="pc">${lab}</span><span class="cx">取消</span></div></div>`;
    }
    const gen = d.versions.length ? "" : `<button class="nrun" data-genscript>AI 生成剧本 v1</button>`;
    const vbar = d.versions.length
      ? `<div class="vbar"><span class="vchip">v${d.active} ▾</span>${ctx.script.isDirty() ? '<span class="dirtytag">已手工修改</span>' : ""}${node.vmenu ? vmenuHtml(d) : ""}</div>`
      : "";
    const text = ctx.script.currentText();
    const scriptArea = `<textarea class="scripttext" spellcheck="false" placeholder="在此输入/粘贴剧本，或先写创意用上方按钮生成">${esc(text)}</textarea>`;
    // revision only over the document's REAL content (typed or generated)
    const revRow = ctx.script.hasContent()
      ? `<div class="revrow"><textarea class="revtext" rows="1" spellcheck="false" placeholder="修改要求，如：结尾加一个反转">${esc(node.revInput || "")}</textarea><button class="nrun ghost" data-revise>AI 修订</button></div>`
      : "";
    let panel = "";
    if (p && p.status === "proposed") {
      panel = `<div class="proposal"><div class="proplab">修订稿（未应用）· 要求：${esc(p.instruction)}</div><textarea class="proptext" readonly spellcheck="false">${esc(p.proposal)}</textarea><div class="vbtns"><button class="nrun" data-apply>✔ 应用为 v${d.versions.length + 1}</button><button class="nrun ghost" data-discard>放弃</button></div></div>`;
    } else if (p && p.status === "failed") {
      panel = `<div class="scripterr">⚠ 生成失败：${esc(p.error)}<button class="errx" data-errx>知道了</button></div>`;
    }
    return `<div class="scriptbox">${brief}${gen}${vbar}${scriptArea}${revRow}${panel}${nx([["scriptgen", "生成分镜"]])}</div>`;
  },
  bind(node, el, ctx) {
    const gen = el.querySelector("[data-genscript]");
    if (gen) gen.onclick = (e) => { e.stopPropagation(); ctx.script.generate("initial", ctx.script.doc().brief); };
    const rev = el.querySelector("[data-revise]");
    if (rev) rev.onclick = (e) => { e.stopPropagation(); ctx.script.generate("revision", node.revInput || ""); };
    const rt = el.querySelector(".revtext");
    if (rt) rt.oninput = () => { node.revInput = rt.value; }; // transient view buffer
    const cx = el.querySelector(".cx");
    if (cx) cx.onclick = (e) => { e.stopPropagation(); ctx.script.cancel(); };
    const vch = el.querySelector(".vchip");
    if (vch) vch.onclick = (e) => { e.stopPropagation(); node.vmenu = !node.vmenu; ctx.refresh(node); };
    const menu = el.querySelector(".vmenu");
    if (menu)
      menu.querySelectorAll("button").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        node.vmenu = false;
        ctx.script.setActive(+b.dataset.v);
      }));
    const ap = el.querySelector("[data-apply]");
    if (ap) ap.onclick = (e) => { e.stopPropagation(); ctx.script.applyProposal(); };
    const di = el.querySelector("[data-discard]");
    if (di) di.onclick = (e) => { e.stopPropagation(); ctx.script.discardProposal(); };
    const ex = el.querySelector("[data-errx]");
    if (ex) ex.onclick = (e) => { e.stopPropagation(); ctx.script.cancel(); };
  },
  // script/brief typing is handled globally in app.js (input → ctx.script)
  next: ["scriptgen"],
};
