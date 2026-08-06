// Bottom step navigator: shows workflow progress and doubles as a slidable jump
// bar (the canvas can grow wider than the screen). Derived from the registry, so
// a newly registered node type appears here automatically once it is on canvas.
import { el } from "../util/dom.js";
import * as registry from "../graph/registry.js";

// Short labels for the bar; unknown types fall back to their def title.
const SHORT = {
  script: "剧本", scriptgen: "分镜", assets: "资产",
  video: "视频", audio: "音频", edit: "剪辑", master: "成片",
};

export function renderStepbar(engine, barEl, entrybarEl) {
  const nodes = engine.nodes;
  if (!nodes.length) {
    barEl.style.display = "none";
    if (entrybarEl) entrybarEl.style.display = "flex";
    return;
  }
  if (entrybarEl) entrybarEl.style.display = "none";
  barEl.style.display = "flex";

  const present = registry
    .list()
    .filter((d) => nodes.some((n) => n.type === d.type))
    .sort((a, b) => a.step - b.step);

  // An editor node with no `run` action (e.g. 剧本) is complete once it exists.
  const isDone = (n) => !!n && (n.state === "done" || !(registry.get(n.type) && registry.get(n.type).run));
  // current = the FIRST incomplete step in order (the one being worked on)
  let cur = null;
  for (const d of present) {
    const n = nodes.find((x) => x.type === d.type);
    if (!cur && !isDone(n)) cur = d.type;
  }
  if (!cur && present.length) cur = present[present.length - 1].type;
  const doneCount = present.filter((d) => isDone(nodes.find((x) => x.type === d.type))).length;

  barEl.innerHTML = "";
  const hint = el("div", "stephint");
  hint.innerHTML = `进度 <b>${doneCount}/${present.length}</b>`;
  barEl.appendChild(hint);

  present.forEach((d, i) => {
    const n = nodes.find((x) => x.type === d.type);
    const stateCls = n ? (isDone(n) ? "done" : n.state === "gen" ? "gen" : d.type === cur ? "cur" : "") : "";
    const b = el("button", "snav" + (stateCls ? " " + stateCls : ""));
    b.innerHTML = `<span class="sd"></span><span>${SHORT[d.type] || d.title}</span>`;
    b.title = "跳到该步骤节点";
    b.onclick = () => {
      engine.selId = n.id;
      engine.render();
      engine.panTo(n.id);
    };
    barEl.appendChild(b);
    if (i < present.length - 1) barEl.appendChild(el("span", "sarrow", "›"));
  });
}
