// motv workspace mockup — bootstrap.
//
// Registers node types, builds the shared ctx, wires the generic engine to the
// workflow, and mounts the UI. Two run modes:
//   - CONNECTED: server.py present → real read-only project data (budget/status/
//     cost via ADR-0031) + canvas persistence to data/<name>.json.
//   - LOCAL/demo: static (no backend) → fixtures + localStorage persistence.
// Generation stays stubbed ("待 Gateway") in both modes — no paid Provider, no
// core writes.

import { $, $$, toast, esc } from "./util/dom.js";
import { GraphEngine } from "./graph/engine.js";
import * as registry from "./graph/registry.js";
import * as budget from "./services/budget.js";
import * as gw from "./services/gateway.js";
import { submitCommand } from "./services/gateway.js";
import * as query from "./services/query.js";
import * as persist from "./services/persist.js";
import * as realmap from "./services/realmap.js";
import { createInspector } from "./ui/inspector.js";
import { createEstimate } from "./ui/estimate.js";
import { createWizard } from "./ui/wizard.js";
import { createShotEditor } from "./ui/shoteditor.js";
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

const FIX = query.fixtureProject();
const labelOf = (t) => (registry.get(t) ? registry.get(t).title : t);

// --- session state ---
let CONNECTED = false;
let PAID = false; // backend --enable-paid: real Gateway write path available
let PROJECT_NAME = "local-draft";
let DEFAULT_NAME = "local-draft";
let REAL_STANDING = null;
let canvasActive = false;
let seeded = false;

// --- budget readout (real in CONNECTED, fixture otherwise) ---
function renderBudget() {
  if (CONNECTED && REAL_STANDING) {
    const s = REAL_STANDING;
    const low = s.remaining < s.total * 0.15;
    const html = `<span>已花 <b>${realmap.yen(s.spent)}</b></span><span class="sep">·</span><span>余额 <b class="bal" ${low ? 'style="color:var(--gate)"' : ""}>${realmap.yen(s.remaining)}</b></span><span class="sep">▾</span>`;
    $$("#budget1,#budget2").forEach((e) => { e.innerHTML = html; e.onclick = openRealProjectData; });
    return;
  }
  const y = budget.yuan;
  const bal = budget.balance();
  const html = `<span>已花 <b>${y(budget.totalSpent())}</b></span><span class="sep">·</span><span>余额 <b class="bal" ${bal < 3000 ? 'style="color:var(--gate)"' : ""}>${y(bal)}</b></span><span class="sep">▾</span>`;
  $$("#budget1,#budget2").forEach((e) => { e.innerHTML = html; e.onclick = () => inspector.openCost(); });
}

async function openRealProjectData() {
  try {
    const [statusJ, costJ] = await Promise.all([
      query.getQuery(PROJECT_NAME, "status"),
      query.getQuery(PROJECT_NAME, "cost"),
    ]);
    inspector.openProjectData(PROJECT_NAME, {
      standing: REAL_STANDING,
      stages: realmap.mapStages(statusJ),
      cost: realmap.mapCost(costJ),
    });
  } catch {
    inspector.openProjectData(PROJECT_NAME, { standing: REAL_STANDING });
  }
}

function setModeBadge() {
  $$("#modebadge1,#modebadge2").forEach((e) => {
    e.className = "modebadge " + (CONNECTED ? "connected" : "local");
    e.textContent = PAID
      ? "💳 真实数据 + 付费写路径"
      : CONNECTED
        ? "🟢 真实只读数据"
        : "⚪ 演示模式";
    e.title = PAID
      ? "已启用 ADR-0041 生成写路径：视频生成经 Gateway 真实提交（预检+确认后才花费）"
      : CONNECTED
        ? "已连接后端：项目/预算/状态为真实只读；创作为本地草稿；生成待 Gateway"
        : "静态演示：数据为 fixtures，画布仍本地持久化";
  });
}

// --- REAL paid generation (ADR-0041 two-step: preflight → confirm → submit) ---
async function paidGenerate(shotId) {
  try {
    const tgt = await gw.getGenerationTarget(PROJECT_NAME, shotId);
    const opId = "op-ui-" + Date.now().toString(36);
    const envelope = {
      command_id: "cmd-" + opId,
      name: "submit-video-generation",
      params: { ...tgt.params, operation_id: opId },
      target: tgt.target,
    };
    const pf = await gw.preflight(PROJECT_NAME, envelope);
    est.openReal(pf, {
      onConfirm: async (digest) => {
        toast("已确认，真实生成中（约 1–2 分钟，请勿关闭页面）…");
        try {
          const receipt = await gw.submit(PROJECT_NAME, envelope, digest);
          const oc = receipt.outcome || {};
          if (receipt.status === "completed" && oc.kind === "success") {
            toast(
              `✅ 真实生成成功 · ${oc.cost_minor_units} ${oc.currency} · ${oc.operation_id}`,
            );
            // auto-bridge the paid clip into the canvas slot (ADR-0046 §3)
            adoptPaidIntoSlot(shotId, envelope.params.task_id).then((okAdopt) => {
              if (okAdopt) toast("付费成片已自动进入画布槽位");
              ctx.loadPaidOps();
            });
          } else {
            toast(`结果：${receipt.status} · ${oc.kind || receipt.reason || ""}`);
          }
          try {
            REAL_STANDING = realmap.mapStanding(
              await query.getQuery(PROJECT_NAME, "budget"),
            );
            renderBudget();
          } catch {
            /* budget refresh is best-effort */
          }
        } catch (e) {
          toast("提交被拒（fail-closed）：" + e.message);
        }
      },
    });
  } catch (e) {
    toast("预检失败：" + e.message);
  }
}

// --- REAL draft lock (ADR-0047 two-step: preflight → confirm → submit) ---
// Turns the CURRENT canvas draft (shots + per-shot asset first-frame images)
// into an official versioned plan/records/packets via the lock-draft-plan
// Gateway command. Spends nothing; available in both modes.
const FRAME_MAX_BYTES = Math.round(5.5 * 1024 * 1024); // ADR-0047 原图上限
async function lockDraftPlan(node) {
  const curV = (node.versions || []).find((x) => x.v === node.cur);
  const draft = curV && curV.raw;
  if (!draft || !draft.length) { toast("没有可锁定的分镜草稿"); return; }
  if (node._lockBusy) return;
  node._lockBusy = true;
  try {
    // per-shot first frame = the assets node's uploaded/generated image for
    // the shot's slot, inlined as a data URL (>5.5MB fails closed with a
    // compress-and-reupload hint; a shot without an image locks text-only)
    const assetUploads = engine.nodes
      .filter((n) => n.type === "assets")
      .reduce((acc, n) => Object.assign(acc, n.uploads || {}), {});
    const shots = [];
    for (const s of draft) {
      let frame = null;
      const url = s.slot && assetUploads[s.slot];
      if (url) {
        try {
          frame = await query.fetchAsDataUrl(url, FRAME_MAX_BYTES);
        } catch (e) {
          if (e.tooLarge) {
            toast(`镜头 ${s.sequence} 首帧图超过 5.5MB：请压缩后重新上传`);
            return;
          }
          throw e;
        }
      }
      shots.push({
        title: s.title,
        description: s.description,
        duration_seconds: s.duration_seconds,
        first_frame_image: frame,
      });
    }
    const tgt = await gw.getLockTarget(PROJECT_NAME);
    const envelope = {
      command_id: "cmd-lock-" + Date.now().toString(36),
      name: "lock-draft-plan",
      params: { ...tgt.params, shots },
      target: tgt.target,
    };
    const pf = await gw.preflight(PROJECT_NAME, envelope);
    est.openLock(pf, {
      onConfirm: async (digest) => {
        toast("已确认，正在发布正式分镜（新版本，不覆盖旧版）…");
        try {
          const receipt = await gw.submit(PROJECT_NAME, envelope, digest);
          const oc = receipt.outcome || {};
          if (receipt.status === "completed") {
            curV.locked = { plan_version: oc.plan_version, shots: oc.shots || [] };
            ctx.project.lockedPlan = curV.locked;
            ctx.refresh(node);
            ctx.refreshType("video");
            ctx.persist();
            toast(`✅ 已锁定为正式分镜 · plan v${oc.plan_version} · ${(oc.shots || []).length} 个镜头 packet 已编译`);
          } else {
            toast(`锁定结果：${receipt.status} · ${receipt.reason || ""}`);
          }
        } catch (e) {
          toast("锁定被拒（fail-closed）：" + e.message);
        }
      },
    });
  } catch (e) {
    toast("锁定预检失败：" + e.message);
  } finally {
    node._lockBusy = false;
  }
}

// --- UI singletons ---
const inspector = createInspector();
const est = createEstimate({ renderBudget, toast });

// --- shared context handed to every node def ---
const ctx = {
  project: { ...FIX },
  gateway: { submitCommand },
  budget,
  inspector,
  wizard: null, // set below (needs ctx.estimate)
  toast,
  // paid generation routing:
  //  - PAID mode + video + a picked shot → the REAL ADR-0041 two-step Gateway
  //    flow, bound to EXACTLY the shot the user clicked (consent accuracy)
  //  - PAID mode + video batch (no shot) → refused; one confirmed shot at a time
  //  - PAID mode + image/audio → still gated (ADR-0038 not accepted for paid)
  //  - CONNECTED (read-only backend) → NO real generation (write-side ADR not
  //    wired), but advance the prototype with a PLACEHOLDER so downstream steps
  //    stay reachable — honest toast, zero cost, nothing written server-side.
  //  - demo → local pretend preflight
  estimate: (o) => {
    if (PAID && o.kind === "视频") {
      if (o.shot) paidGenerate(o.shot);
      else toast("付费模式一次只生成一个镜头：请用「生成单个 ▾」选择镜头");
      return;
    }
    if (CONNECTED) {
      // Placeholder-advance: real generation needs the write-side Gateway/ADR,
      // so this produces NO real asset and costs nothing — it only lets the user
      // preview the next steps. o.after marks the node done in the prototype.
      toast(`「${o.kind}」占位推进：未真实生成、不花费（真实生成需接入写侧 Gateway）`);
      if (typeof o.after === "function") o.after();
      return;
    }
    est.open(o);
  },
  refresh: (node) => {
    engine.refreshBody(node);
    if (dtNode === node) renderDetail(); // keep the detail window live-synced
  },
  // re-render every node of a type — used when upstream state (e.g. the current
  // draft version) changes and a downstream node's prefill must follow.
  refreshType: (type) => {
    engine.nodes.filter((n) => n.type === type).forEach((n) => engine.refreshBody(n));
    if (dtNode && dtNode.type === type) renderDetail();
  },
  markIncoming: (id, state) => engine.markIncoming(id, state),
  addNext,
  // creative agent (ADR-0042): available whenever the backend is present
  isConnected: () => CONNECTED,
  // the CURRENT script text: the canvas script node's edit buffer, falling
  // back to the project's script field
  getScriptText: () => {
    const s = engine.nodes.find((n) => n.type === "script");
    return (s && s.text) || ctx.project.script || "";
  },
  agentShotsDraft: (script) => query.generateShotsDraft(script),
  isPaid: () => PAID,
  // draft lock (ADR-0047): canvas draft → official versioned plan/records/
  // packets via the lock-draft-plan Gateway command (no spend, both modes)
  lockDraft: (node) => lockDraftPlan(node),
  // the record shot id paid generation binds for a draft sequence: a LOCKED
  // draft uses its minted official ids (shot-p<plan>-<seq>), the pre-seeded
  // evidence project keeps its shot-<seq> records
  lockedShotId: (seq) => {
    const lp = ctx.project.lockedPlan;
    const row = lp && lp.shots && lp.shots[seq - 1];
    return row ? row.shot_id : `shot-${seq}`;
  },
  // manual providers (prototype scratch): media upload + explicit persistence
  uploadMedia: (slug, file) => {
    if (!CONNECTED) return Promise.reject(new Error("演示模式无后端，无法上传"));
    return query.uploadAssetImage(PROJECT_NAME, slug, file);
  },
  // free automatic voice-over via local Piper TTS (ADR-0043); fitSlug names an
  // uploaded video slot so the narration is paced to fit that clip's duration
  agentTts: (slug, text, fitSlug) => {
    if (!CONNECTED) return Promise.reject(new Error("演示模式无后端"));
    return query.ttsGenerate(PROJECT_NAME, slug, text, fitSlug);
  },
  // paid image generation (ADR-0045): PAID mode only, price already confirmed
  // by the caller's per-image dialog and echoed for the server-side check
  paidImage: (slug, prompt, confirmUsd) => {
    if (!PAID) return Promise.reject(new Error("付费模式未开启（--enable-paid）"));
    return query.paidImageGenerate(PROJECT_NAME, slug, prompt, confirmUsd);
  },
  // real local FFmpeg draft compose (ADR-0044)
  composeFinal: (spec) => {
    if (!CONNECTED) return Promise.reject(new Error("演示模式无后端"));
    return query.composeFinal(PROJECT_NAME, spec);
  },
  // The video/audio upload maps for the edit node's readiness view — merged
  // across ALL nodes of the type: slot ids are unique per draft version, so
  // whichever node holds a slot's upload IS that shot's upload (duplicated or
  // branched nodes can never make compose pick an unrelated file).
  collectMedia: () => {
    const merge = (type) =>
      engine.nodes
        .filter((n) => n.type === type)
        .reduce((acc, n) => Object.assign(acc, n.uploads || {}), {});
    return { video: merge("video"), audio: merge("audio") };
  },
  persist: () => {
    if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph());
  },
  // paid-op status projection (生成情况) — refreshed after paid actions
  paidOps: {},
  loadPaidOps: async () => {
    if (!CONNECTED) return;
    try {
      const ops = await gw.paidOps(PROJECT_NAME);
      ctx.paidOps = {};
      ops.forEach((o) => {
        if (!o.shot_id) return;
        const cur = ctx.paidOps[o.shot_id];
        // a committed op always wins over stale/aborted records for the shot
        if (!cur || (o.status === "committed" && cur.status !== "committed")) {
          ctx.paidOps[o.shot_id] = o;
        }
      });
      ctx.refreshType("video");
    } catch { /* status is best-effort */ }
  },
};
ctx.wizard = createWizard({ estimate: { open: (o) => ctx.estimate(o) }, getProject: () => ctx.project, refresh: (n) => engine.refreshBody(n) });
ctx.shotEditor = createShotEditor({ toast });

// --- adopt a paid staging clip into every video node's slot (ADR-0046 §3) ---
async function adoptPaidIntoSlot(shotId, taskId) {
  const draft = ctx.project.draftShots || [];
  // match the CURRENT locked id or the legacy shot-<seq> id: a paid op
  // submitted before a lock (or after one) must still adopt into its slot
  // even if the lock state changed while the generation was running
  const s = draft.find(
    (x) => ctx.lockedShotId(x.sequence) === shotId || `shot-${x.sequence}` === shotId,
  );
  if (!s || !s.slot) return false;
  try {
    const url = await gw.adoptPaid(PROJECT_NAME, taskId, `video-${s.slot}`);
    engine.nodes.filter((n) => n.type === "video").forEach((n) => {
      n.uploads = n.uploads || {};
      n.uploads[s.slot] = url;
      engine.refreshBody(n);
    });
    ctx.persist();
    return true;
  } catch {
    return false; // artifact may not be fetched yet — status view still shows it
  }
}

// --- batch paid generation (ADR-0046): ONE total confirmation, per-shot
// quote-equality validation, abort on any blocker/mismatch ---
async function batchPaidGenerate(node) {
  const draft = ctx.project.draftShots || [];
  const media = ctx.collectMedia();
  const pending = draft.filter((s) => s.slot && !media.video[s.slot]);
  if (!pending.length) { toast("所有镜头都已有视频，无需批量生成"); return; }
  const UNIT_USD = 0.28;
  const total = (pending.length * UNIT_USD).toFixed(2);
  const list = pending.map((s) => String(s.sequence).padStart(2, "0")).join("、");
  if (!window.confirm(
    `一键批量付费生成 ${pending.length} 个镜头（${list}）\n` +
    `单价 $${UNIT_USD}/段 × ${pending.length} = 总计 $${total}\n\n` +
    `确认后逐镜头经 Gateway 真实生成（每段约 1–2 分钟）；任何一笔报价与单价不符或存在阻断将立即中止。确认扣费？`,
  )) return;
  node._batchBusy = true;
  let done = 0;
  for (const s of pending) {
    node._batchMsg = `批量付费 ${done + 1}/${pending.length} · 镜头 ${String(s.sequence).padStart(2, "0")} 生成中…`;
    ctx.refresh(node);
    try {
      const shotId = ctx.lockedShotId(s.sequence);
      const tgt = await gw.getGenerationTarget(PROJECT_NAME, shotId);
      const opId = "op-ui-" + Date.now().toString(36) + s.sequence;
      const envelope = {
        command_id: "cmd-" + opId,
        name: "submit-video-generation",
        params: { ...tgt.params, operation_id: opId },
        target: tgt.target,
      };
      const pf = await gw.preflight(PROJECT_NAME, envelope);
      const p = pf.preview || {};
      const cost = p.estimated_cost;
      const blockers = p.blockers || [];
      // per-shot validation: quote must equal the confirmed unit price
      const quoteOk = cost
        && cost.original_currency === "USD"
        && cost.original_amount_minor_units === Math.round(UNIT_USD * 100);
      if (blockers.length || !quoteOk) {
        toast(`批量中止于镜头 ${s.sequence}：${blockers[0] || "报价与确认单价不符"}（已完成 ${done} 段，未再扣费）`);
        break;
      }
      await gw.submit(PROJECT_NAME, envelope, pf.preflight_digest);
      done++;
      await adoptPaidIntoSlot(shotId, envelope.params.task_id);
    } catch (e) {
      toast(`批量中止于镜头 ${s.sequence}：${e.message}（已完成 ${done} 段）`);
      break;
    }
  }
  node._batchBusy = false;
  node._batchMsg = "";
  ctx.refresh(node);
  ctx.loadPaidOps();
  try {
    REAL_STANDING = realmap.mapStanding(await query.getQuery(PROJECT_NAME, "budget"));
    renderBudget();
  } catch { /* best-effort */ }
  if (done) toast(`批量付费完成 · ${done} 段已生成并入槽位`);
}
ctx.batchPaid = batchPaidGenerate;

// --- shared node-body wiring (used by BOTH the canvas node and the detail
// window, so every action works identically in either surface) ---
function bindNodeBody(node, bodyEl) {
  const def = registry.get(node.type);
  if (def && def.bind) def.bind(node, bodyEl, ctx);
  const run = bodyEl.querySelector("[data-run]");
  if (run) run.onclick = (e) => { e.stopPropagation(); if (def && def.run) def.run(node, ctx); };
  bodyEl.querySelectorAll("[data-next]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    addNext(node, b.dataset.next, +(b.dataset.dy || 0));
  }));
}

// --- node detail window (放大编辑视窗): live-synced with the canvas node ---
let dtNode = null;
const dtScrim = $("#dt-scrim");
function renderDetail() {
  if (!dtNode) return;
  const def = registry.get(dtNode.type);
  $("#dt-t").textContent = `${def.icon || ""} ${def.title || dtNode.type}`;
  $("#dt-s").textContent = def.stage || "";
  const body = $("#dt-b");
  body.innerHTML = def && def.render ? def.render(dtNode, ctx) : "";
  bindNodeBody(dtNode, body);
  // the script textarea saves through the same global handler as the canvas
}
function openDetail(node) {
  dtNode = node;
  renderDetail();
  dtScrim.classList.add("show");
  if (node.type === "video" && ctx.loadPaidOps) ctx.loadPaidOps();
}
$("#dt-x").onclick = () => { dtNode = null; dtScrim.classList.remove("show"); };

// --- media lightbox: click any slot thumbnail (canvas OR detail window) to
// view the image full-size / play the video with controls ---
const lbScrim = $("#lb-scrim");
function openLightbox(el) {
  const c = $("#lb-c");
  const src = el.currentSrc || el.src;
  if (!src) return;
  c.innerHTML = el.tagName === "VIDEO"
    ? `<video src="${esc(src)}" controls autoplay></video>`
    : `<img src="${esc(src)}" alt="">`;
  lbScrim.classList.add("show");
}
function closeLightbox() {
  $("#lb-c").innerHTML = ""; // stops playback
  lbScrim.classList.remove("show");
}
$("#lb-x").onclick = closeLightbox;
lbScrim.onclick = (e) => { if (e.target === lbScrim) closeLightbox(); };
// capture phase so a canvas-node click doesn't ALSO open the inspector
document.addEventListener(
  "click",
  (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("athumb") && (t.src || t.currentSrc)) {
      e.stopPropagation();
      e.preventDefault();
      openLightbox(t);
    }
  },
  true,
);
// script editing inside the detail window: update the node + mirror to the
// canvas copy (the modal textarea itself is left untouched to keep focus)
$("#dt-b").addEventListener("input", (e) => {
  if (dtNode && e.target.classList.contains("scripttext")) {
    dtNode.text = e.target.value;
    engine.refreshBody(dtNode);
    if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph());
  }
});

// --- engine wired to the workflow via registry/contract ---
const engine = new GraphEngine({
  viewport: $("#viewport"),
  world: $("#world"),
  svg: $("#edges"),
  edgectl: $("#edgectl"),
  emptyhint: $("#emptyhint"),
  renderBody: (node) => {
    const def = registry.get(node.type);
    const body = def && def.render ? def.render(node, ctx) : "";
    // every node gets an expand affordance into the detail window
    return body + `<button class="nexpand" data-expand>⤢ 放大编辑</button>`;
  },
  bindBody: (node, bodyEl) => {
    bindNodeBody(node, bodyEl);
    const ex = bodyEl.querySelector("[data-expand]");
    if (ex) ex.onclick = (e) => { e.stopPropagation(); openDetail(node); };
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
  onChange: () => {
    renderStepbar(engine, $("#stepbar"), $("#entrybar"));
    if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph());
  },
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
  const legal = registry.canConnect(fromNode.type, type) && registry.canConnect(type, toNode.type);
  const nn = createNode(type, mx, my);
  if (legal) {
    engine.removeEdge(ed);
    engine.addEdge(ed.from, nn.id, "");
    engine.addEdge(nn.id, ed.to, "");
    engine.render();
    toast(`已在连线中插入「${labelOf(type)}」`);
  } else {
    engine.render();
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

// --- canvas (de)serialization for persistence ---
function serializeGraph() {
  return {
    v: 1,
    project: PROJECT_NAME,
    nodes: engine.nodes.map((n) => ({
      id: n.id, type: n.type, x: n.x, y: n.y, state: n.state,
      text: n.text, versions: n.versions, cur: n.cur, pickSingle: n.pickSingle,
      uploads: n.uploads, finals: n.finals,
    })),
    edges: engine.edges.map((e) => ({ from: e.from, to: e.to, state: e.state })),
    pan: { x: engine.panX, y: engine.panY },
  };
}
function restoreGraph(data) {
  engine.reset();
  seeded = false;
  if (!data || !Array.isArray(data.nodes) || !data.nodes.length) return false;
  const idMap = {};
  for (const sn of data.nodes) {
    if (!registry.get(sn.type)) continue;
    const nd = registry.createNodeData(sn.type, sn.x || 0, sn.y || 0);
    ["state", "text", "versions", "cur", "pickSingle", "uploads", "finals"].forEach((k) => { if (sn[k] !== undefined) nd[k] = sn[k]; });
    // Connected mode: a scriptgen node's shot list must come from a REAL agent
    // draft (ADR-0042, draft:true), never a resurrected demo/fixture snapshot —
    // otherwise a canvas persisted in demo mode shows shots that don't match the
    // script. Drop non-draft generated versions; if none survive, revert the
    // node to "ready to generate" so the real script drives a fresh real run.
    if (CONNECTED && sn.type === "scriptgen" && Array.isArray(nd.versions)) {
      nd.versions = nd.versions.filter((x) => x && x.draft);
      if (!nd.versions.length) { nd.state = ""; nd.cur = 0; }
      else if (!nd.versions.some((x) => x.v === nd.cur)) { nd.cur = nd.versions[nd.versions.length - 1].v; }
      // Back-compat: drafts persisted before slot ids got one per shot so
      // uploads can attach (an upload never matches across versions).
      nd.versions.forEach((ver) => {
        if (ver.raw) ver.raw.forEach((s, i) => { if (!s.slot) s.slot = `v${ver.v}-${i + 1}`; });
      });
      // Rehydrate downstream prefill from the restored current draft, else the
      // Assets node falls back to fixtures after reload (auto-prefill breaks).
      const curDraft = nd.versions.find((x) => x.v === nd.cur);
      if (curDraft && curDraft.raw) ctx.project.draftShots = curDraft.raw;
      // rehydrate the lock state too, so paid generation keeps binding the
      // locked official shot ids after a reload
      ctx.project.lockedPlan = (curDraft && curDraft.locked) || null;
    }
    idMap[sn.id] = engine.addNode(nd).id;
  }
  for (const se of data.edges || []) {
    if (idMap[se.from] && idMap[se.to]) engine.addEdge(idMap[se.from], idMap[se.to], se.state || "");
  }
  if (data.pan) { engine.panX = data.pan.x; engine.panY = data.pan.y; engine.applyPan(); }
  seeded = true;
  engine.render();
  return true;
}

// --- seeds ---
function seedStory() {
  if (seeded) { toast("画布已有故事工作流"); return; }
  seeded = true;
  const s = createNode("script", 0, 40);
  const g = createNode("scriptgen", 360, 40);
  engine.addEdge(s.id, g.id, "");
  engine.render();
  engine.panTo(g.id);
}
function seedDemoGraph() {
  // 演示：进行到 S4 —— script✓ scriptgen✓ assets✓ video/audio 待生成
  const s = createNode("script", 0, 40);
  const g = createNode("scriptgen", 360, 40);
  const a = createNode("assets", 720, 10);
  const v = createNode("video", 1060, -50);
  const au = createNode("audio", 1060, 150);
  g.state = "done"; g.versions = [{ v: 1, shots: ctx.project.shots.v1 }]; g.cur = 1; a.state = "done";
  engine.addEdge(s.id, g.id, "done");
  engine.addEdge(g.id, a.id, "done");
  engine.addEdge(a.id, v.id, "");
  engine.addEdge(a.id, au.id, "");
  seeded = true;
  engine.render();
  engine.panTo(v.id);
}
$$(".entry").forEach((b) => (b.onclick = () => {
  seedStory();
  if (b.dataset.seed !== "story") toast("已进入故事工作流（原型：过程统一到 L0–S7 链）");
}));

// --- enter a project's canvas (real or demo) ---
async function enterCanvas(name, opts = {}) {
  PROJECT_NAME = name;
  canvasActive = false;
  ctx.project = {
    ...FIX,
    id: name,
    name,
    script: CONNECTED
      ? `【${name}】\n（在此编写剧本草稿，自动保存到本地 data/${name}.json）`
      : FIX.script,
  };
  if (CONNECTED) {
    try { REAL_STANDING = realmap.mapStanding(await query.getQuery(name, "budget")); } catch { REAL_STANDING = null; }
    // Show the project's REAL locked shot plan in the 分镜 node instead of the
    // demo fixture — the paid generation is packet-only, so what the user sees
    // must be what the locked plan will actually generate.
    try {
      const shots = await query.getShots(name);
      if (shots.length) {
        const rows = shots.map((s) => [
          String(s.sequence ?? "").padStart(2, "0"),
          `${s.description || s.shot_id}（${s.duration_seconds ?? "?"}s）`,
        ]);
        ctx.project.shots = { v1: rows, v2: rows, total: rows.length, real: true };
      }
    } catch {
      /* keep fixture shots if records unavailable */
    }
  } else {
    REAL_STANDING = null;
  }
  renderBudget();
  views.goCanvas();
  if (opts.seedDemo) {
    seedDemoGraph();
  } else {
    const saved = await persist.loadCanvas(name);
    if (!restoreGraph(saved)) { engine.reset(); seeded = false; engine.render(); }
  }
  canvasActive = true;
  if (PAID) ctx.loadPaidOps(); // 生成情况 projection for the video node
}

// --- landing project cards ---
function renderLanding(realNames) {
  const grid = $("#projgrid");
  [...grid.querySelectorAll(".pcard")].forEach((c) => c.remove());
  if (CONNECTED) {
    realNames.forEach((name) => {
      const b = document.createElement("button");
      b.className = "pcard";
      b.innerHTML = `<div class="thumb" style="background:radial-gradient(120% 120% at 40% 30%,#1e4a56,#12183a)"><span style="color:#a9d8e8">📁 ${esc(name)}</span></div><div class="cap">${esc(name)} <span class="tg">真实项目</span></div>`;
      b.onclick = () => enterCanvas(name, {});
      grid.appendChild(b);
    });
  } else {
    const b = document.createElement("button");
    b.className = "pcard";
    b.innerHTML = `<div class="thumb" style="background:radial-gradient(120% 120% at 30% 20%,#3a2a5e,#12183a)"><span style="color:#cbb9e8">🎬 示例·进行中</span></div><div class="cap">示例项目 <span class="tg">演示 · S4</span></div>`;
    b.onclick = () => enterCanvas("demo", { seedDemo: true });
    grid.appendChild(b);
  }
}

// --- global bits ---
const views = createViews();
$("#start-create").onclick = () => enterCanvas(DEFAULT_NAME, {});
engine.world.addEventListener("input", (e) => {
  if (e.target.classList.contains("scripttext")) {
    const n = engine.findNode(e.target.closest(".node").dataset.id);
    if (n) { n.text = e.target.value; if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph()); }
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (lbScrim.classList.contains("show")) { closeLightbox(); return; }
  if (dtScrim.classList.contains("show")) { dtNode = null; dtScrim.classList.remove("show"); return; }
  if ($("#es-scrim").classList.contains("show")) return;
  if ($("#nmenu").classList.contains("show")) { closeMenu(); return; }
  if ($("#wz-scrim").classList.contains("show")) { $("#wz-scrim").classList.remove("show"); return; }
  inspector.close();
});

// --- async bootstrap ---
async function boot() {
  const m = await query.detectMode();
  CONNECTED = m.mode === "connected";
  PAID = CONNECTED && m.paid === true;
  setModeBadge();
  let realNames = [];
  if (CONNECTED) {
    realNames = await query.listProjects();
    DEFAULT_NAME = realNames[0] || "draft";
    if (realNames[0]) {
      PROJECT_NAME = realNames[0];
      try { REAL_STANDING = realmap.mapStanding(await query.getQuery(realNames[0], "budget")); } catch { REAL_STANDING = null; }
    }
  } else {
    DEFAULT_NAME = "local-draft";
  }
  renderLanding(realNames);
  renderBudget();
}
boot();
