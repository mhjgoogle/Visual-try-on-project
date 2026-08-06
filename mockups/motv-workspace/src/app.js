// motv workspace mockup — bootstrap. Registers node types, builds the shared
// ctx, wires the generic engine to the workflow, and mounts the UI. Adding a new
// workflow step = create ../workflow/nodes/<type>.js and add one register() line.

import { $, $$, toast } from "./util/dom.js";
import { GraphEngine } from "./graph/engine.js";
import * as registry from "./graph/registry.js";
import * as budget from "./services/budget.js";
import { submitCommand } from "./services/gateway.js";
import { getProject } from "./services/query.js";
import { createInspector } from "./ui/inspector.js";
import { createEstimate } from "./ui/estimate.js";
import { createWizard } from "./ui/wizard.js";
import { createViews } from "./ui/landing.js";
import { renderStepbar } from "./ui/stepbar.js";

// --- register node types (the extension list) ---
import script from "./workflow/nodes/script.js";
import scriptgen from "./workflow/nodes/scriptgen.js";
import assets from "./workflow/nodes/assets.js";
import video from "./workflow/nodes/video.js";
import audio from "./workflow/nodes/audio.js";
import edit from "./workflow/nodes/edit.js";
import master from "./workflow/nodes/master.js";
[script, scriptgen, assets, video, audio, edit, master].forEach(registry.register);

const project = getProject("shengtang");
const labelOf = (t) => (registry.get(t) ? registry.get(t).title : t);

// --- budget readout (shared header widget) ---
function renderBudget() {
  const y = budget.yuan;
  const bal = budget.balance();
  const html = `<span>已花 <b>${y(budget.totalSpent())}</b></span><span class="sep">·</span><span>余额 <b class="bal" ${bal < 3000 ? 'style="color:var(--gate)"' : ""}>${y(bal)}</b></span><span class="sep">▾</span>`;
  $$("#budget1,#budget2").forEach((e) => {
    e.innerHTML = html;
    e.onclick = () => inspector.openCost();
  });
}

// --- UI singletons ---
const inspector = createInspector();
const est = createEstimate({ renderBudget, toast });
const wizard = createWizard({ estimate: est, project, refresh: (n) => engine.refreshBody(n) });

// --- shared context handed to every node def ---
const ctx = {
  project,
  gateway: { submitCommand },
  budget,
  inspector,
  wizard,
  toast,
  estimate: est.open,
  refresh: (node) => engine.refreshBody(node),
  markIncoming: (id, state) => engine.markIncoming(id, state),
  addNext,
};

// --- engine wired to the workflow via registry/contract ---
const engine = new GraphEngine({
  viewport: $("#viewport"),
  world: $("#world"),
  svg: $("#edges"),
  edgectl: $("#edgectl"),
  emptyhint: $("#emptyhint"),
  renderBody: (node) => {
    const def = registry.get(node.type);
    return def && def.render ? def.render(node, ctx) : "";
  },
  bindBody: (node, bodyEl) => {
    const def = registry.get(node.type);
    if (def && def.bind) def.bind(node, bodyEl, ctx);
    const run = bodyEl.querySelector("[data-run]");
    if (run) run.onclick = (e) => { e.stopPropagation(); if (def && def.run) def.run(node, ctx); };
    bodyEl.querySelectorAll("[data-next]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      addNext(node, b.dataset.next, +(b.dataset.dy || 0));
    }));
  },
  canConnect: (a, b) => registry.canConnect(a.type, b.type),
  onConnect: () => toast("已连线：手动建立工作流关系"),
  onWireRejected: () => toast("不能跨步骤连接：只能连到相邻的下一步"),
  onNodeClick: (node) => inspector.openNode(node),
  onCanvasMenu: (wx, wy, cx, cy, srcNode) =>
    openMenu(cx, cy, (type) => {
      const nn = createNode(type, wx, wy);
      if (srcNode) {
        if (registry.canConnect(srcNode.type, nn.type)) engine.addEdge(srcNode.id, nn.id, srcNode.state === "done" ? "done" : "");
        else toast("已新建节点（与来源不相邻，未自动连线）");
      }
      engine.render();
    }),
  onEdgeInsert: (ed, cx, cy) => openMenu(cx, cy, (type) => insertOnEdge(ed, type)),
  onChange: () => renderStepbar(engine, $("#stepbar"), $("#entrybar")),
  onDeleteEdges: () => toast("已删除选中连线"),
});

// --- helpers ---
function createNode(type, x, y) {
  return engine.addNode(registry.createNodeData(type, x, y));
}
function addNext(from, type, dy) {
  let n = engine.nodes.find((x) => x.type === type);
  const w = engine.world.querySelector(`[data-id="${from.id}"]`);
  if (!n) {
    const bx = w ? w.offsetLeft + w.offsetWidth + 120 : from.x + 380;
    const by = from.y + (dy || 0);
    n = createNode(type, bx, by);
  }
  if (registry.canConnect(from.type, n.type)) engine.addEdge(from.id, n.id, from.state === "done" ? "done" : "");
  engine.render();
  engine.panTo(n.id);
  toast("已展开下一步：" + labelOf(type));
}
function insertOnEdge(ed, type) {
  const a = engine.world.querySelector(`[data-id="${ed.from}"]`);
  const b = engine.world.querySelector(`[data-id="${ed.to}"]`);
  const mx = (a.offsetLeft + a.offsetWidth + b.offsetLeft) / 2 - 90;
  const my = (a.offsetTop + b.offsetTop) / 2 + 70;
  const fromNode = engine.findNode(ed.from);
  const toNode = engine.findNode(ed.to);
  // Validate BEFORE touching the original edge: only a legal insert (adjacent to
  // both ends) may replace A→B. An incompatible type must never silently delete
  // the existing user connection.
  const legal = registry.canConnect(fromNode.type, type) && registry.canConnect(type, toNode.type);
  const nn = createNode(type, mx, my);
  if (legal) {
    engine.removeEdge(ed);
    engine.addEdge(ed.from, nn.id, "");
    engine.addEdge(nn.id, ed.to, "");
    engine.render();
    toast(`已在连线中插入「${labelOf(type)}」`);
  } else {
    engine.render(); // keep original A→B intact; node placed unconnected
    toast(`「${labelOf(type)}」与相邻步骤不匹配，已新建但未插入（原连线保留）`);
  }
}

// --- node-type menu ---
function openMenu(cx, cy, cb) {
  const m = $("#nmenu");
  m.innerHTML = `<div class="h">插入 / 新建节点</div>`;
  registry.list().forEach((d) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="mi">${d.icon}</span><span>${d.title}</span><span class="ms mono">${(d.stage || "").split(" ")[0]}</span>`;
    b.onclick = () => { closeMenu(); cb(d.type); };
    m.appendChild(b);
  });
  m.style.left = Math.min(cx, innerWidth - 200) + "px";
  m.style.top = Math.min(cy, innerHeight - 280) + "px";
  m.classList.add("show");
}
function closeMenu() { $("#nmenu").classList.remove("show"); }
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#nmenu") && !e.target.closest(".ectl button")) closeMenu();
}, true);

// --- seeds (progressive: only the starting nodes; the rest grow on demand) ---
let seeded = false;
function seedStory() {
  if (seeded) { toast("画布已有故事工作流"); return; }
  seeded = true;
  const s = createNode("script", 0, 40);
  const g = createNode("scriptgen", 360, 40);
  engine.addEdge(s.id, g.id, "");
  engine.render();
  engine.panTo(g.id);
}
$$(".entry").forEach((b) => (b.onclick = () => {
  seedStory();
  if (b.dataset.seed !== "story") toast("已进入故事工作流（原型：过程统一到 L0–S7 链）");
}));

function openRecent() {
  if (seeded) return;
  seeded = true;
  // 深夜便利店: mid-production — script✓ scriptgen✓ assets✓ video/audio pending
  const s = createNode("script", 0, 40);
  const g = createNode("scriptgen", 360, 40);
  const a = createNode("assets", 720, 10);
  const v = createNode("video", 1060, -50);
  const au = createNode("audio", 1060, 150);
  g.state = "done"; g.versions = [{ v: 1, shots: project.shots.v1 }]; g.cur = 1; a.state = "done";
  engine.addEdge(s.id, g.id, "done");
  engine.addEdge(g.id, a.id, "done");
  engine.addEdge(a.id, v.id, "");
  engine.addEdge(a.id, au.id, "");
  engine.render();
  engine.panTo(v.id);
  toast("已打开：进行到 S4 视频生成（见底部进度条）");
}

// --- global bits ---
engine.world.addEventListener("input", (e) => {
  if (e.target.classList.contains("scripttext")) {
    const n = engine.findNode(e.target.closest(".node").dataset.id);
    if (n) n.text = e.target.value;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#es-scrim").classList.contains("show")) return; // estimate handles itself
  if ($("#nmenu").classList.contains("show")) { closeMenu(); return; }
  if ($("#wz-scrim").classList.contains("show")) { $("#wz-scrim").classList.remove("show"); return; }
  inspector.close();
});

createViews({ onStart: () => {}, onOpenRecent: openRecent, renderBudget });
