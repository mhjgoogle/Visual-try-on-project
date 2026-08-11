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
import * as projects from "./services/projects.js";
import * as persist from "./services/persist.js";
import { CANVAS_SCHEMA_VERSION } from "./services/canvasschema.js";
import * as realmap from "./services/realmap.js";
import { createInspector } from "./ui/inspector.js";
import { createEstimate } from "./ui/estimate.js";
import { createWizard } from "./ui/wizard.js";
import { createShotEditor, normalizeShots, nextDraftVersion } from "./ui/shoteditor.js";
import { mintId } from "./workflow/identity.js";
import { createViews } from "./ui/landing.js";
import { createProduction } from "./ui/production.js";
import { createWorkflowGraph } from "./ui/wfgraph.js";
import { renderStepbar } from "./ui/stepbar.js";
import { renderQueueBar, hasInflight } from "./ui/paidqueue.js";
import * as mediaref from "./workflow/mediaref.js";
import * as assetlib from "./workflow/assetlib.js";
import * as genlib from "./workflow/genlib.js";
import { buildShotSlotIndex, slotForShotId, shotIdForSlot, resolveAdoptTarget } from "./workflow/shotmap.js";
import * as scriptdoc from "./workflow/scriptdoc.js";
import * as storydoc from "./workflow/storydoc.js";
import * as proddoc from "./workflow/proddoc.js";
import * as timeline from "./workflow/timeline.js";
import * as bibledoc from "./workflow/bibledoc.js";
import * as breakdown from "./workflow/breakdown.js";
import { seedDemoProject, DEMO_PROJECT_NAME } from "../fixtures/demo-project.js";

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
// the backend's project list, kept so the landing/new-project dialog can
// re-render and name-check without refetching
let REAL_NAMES = [];
let canvasActive = false;
let seeded = false;
// Script DOMAIN documents — PER EPISODE since M9 (schema v8 `scripts` map).
// `scriptDoc` always aliases the ACTIVE episode's document, so every existing
// consumer (nodes, storyboard, breakdown) keeps reading one current script.
// Null-prototype map: an episodeId literally named __proto__ stays an own key.
let scriptDocs = Object.create(null);
let scriptDoc = scriptdoc.createDoc();
// Story DOMAIN document (M9): Idea → Story Outline (versioned, approvable) →
// Episode Plan (versioned, confirmable) → per-episode scripts.
let storyDoc = storydoc.createStory(null);

/** The script document for an episode, created lazily (a fresh episode has an
 *  empty script — honest, nothing fabricated). */
function scriptForEpisode(episodeId) {
  if (typeof episodeId !== "string" || !episodeId) return scriptdoc.createDoc();
  if (!scriptDocs[episodeId]) scriptDocs[episodeId] = scriptdoc.createDoc();
  return scriptDocs[episodeId];
}

/** A stable signature of a default clip build — the fingerprint of the SOURCE
 *  (shots/media/scene audio) a timeline was last synced from. Includes shotId
 *  + startTime so reordering equal-duration shots reusing one asset changes it
 *  (M11 review). Stamped on the timeline as `sourceSig` at each sync. */
function timelineSourceSig(clips) {
  return clips
    .map((c) => `${c.trackType}:${c.assetId}:${c.shotId || ""}:${c.startTime.toFixed(2)}:${(c.trimOut - c.trimIn).toFixed(2)}`)
    .join("|");
}

/** Re-point the `scriptDoc` alias at the ACTIVE episode's document. Called on
 *  restore and on every active-episode switch. */
function syncActiveScript() {
  scriptDoc = scriptForEpisode(productionDoc.activeEpisodeId);
}
// Project Asset Registry (M3) — the ONE durable owner of creator media.
// Node uploads/firstFrames are ALIAS views over these maps (attachAssetViews),
// so mediaref.addVersion stays the single write path and serialization only
// ever persists the registry, never node-local copies.
let assetRegistry = assetlib.createRegistry(null);
// Project Generation Registry (M5) — the ONE durable source of generation
// provenance, top-level and parallel to the asset registry. Decoupled from
// media bytes: a Generation record outlives its result Asset's local copy.
let generationRegistry = genlib.createGenerationRegistry(null);
// Production domain document (M6) — Project → Episodes → Scenes → Shots
// structure. Scenes reference shots by canonical creativeShotId; shot content
// stays on the scriptgen draft, media/provenance stay in their registries.
let productionDoc = proddoc.createProduction(null);
// Per-episode timelines (M11) — clips referencing assets by id, never bytes.
let timelinesDoc = timeline.createTimelines(null);
// 剧本拆解提案 (M8) — TRANSIENT review state, per session, never persisted:
// null | { status: "running"|"ready"|"failed", cards, error, source }.
// A reload lands on the confirmed bible; proposals are re-derivable any time.
let bibleProposals = null;

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
    // M5: SNAPSHOT this video generation's provenance now, at envelope-build
    // time — these are the inputs the submitted job uses. Resolving at confirm
    // time instead would record whatever the draft looked like AFTER any edit
    // made while the confirm dialog was open, diverging from the submitted job.
    // The target is the canonical creativeShotId (never the slot); the input is
    // the shot's proven first-frame Asset; the correlation ids travel with the
    // frozen params so an adopt after reload can reconcile the record by task.
    const launch = resolveAdoptSlot(shotId);
    const launchSlot = launch && launch.slot ? launch.slot : null;
    const frameRef = launchSlot ? assetRegistry.firstFrames[launchSlot] : null;
    const p = tgt.params && typeof tgt.params === "object" ? tgt.params : null;
    const genSeed = {
      type: "video",
      targetType: launch && launch.creativeShotId ? "shot" : null,
      targetId: (launch && launch.creativeShotId) || null,
      inputAssetIds: frameRef && frameRef.assetId ? [frameRef.assetId] : [],
      promptSnapshot: p && typeof p.prompt === "string" ? p.prompt : null,
      provider: p && p.provider ? String(p.provider) : null,
      model: p && p.model ? String(p.model) : null,
      parameters: { ...(p || {}), operation_id: opId, task_id: envelope.params.task_id },
    };
    const pf = await gw.preflight(PROJECT_NAME, envelope);
    est.openReal(pf, {
      onConfirm: async (digest) => {
        toast("已确认，真实生成中（约 1–2 分钟，请勿关闭页面）…");
        // pick up the freshly-held reservation soon so the queue bar starts
        // showing ⏳ without waiting for the submit to return
        setTimeout(() => ctx.loadPaidOps(), 2_000);
        // record the generation from the FROZEN seed (only now that the user is
        // spending) — persisted before submit, so a lost response / page exit
        // still leaves a durable record reconcilable by task_id
        const gen = ctx.startGeneration({ ...genSeed, status: "generating" });
        const genId = gen && gen.generationId;
        try {
          const receipt = await gw.submit(PROJECT_NAME, envelope, digest);
          const oc = receipt.outcome || {};
          if (receipt.status === "completed" && oc.kind === "success") {
            toast(
              `✅ 真实生成成功 · ${oc.cost_minor_units} ${oc.currency} · ${oc.operation_id}`,
            );
            // auto-bridge the paid clip into the canvas slot (ADR-0046 §3)
            adoptPaidIntoSlot(shotId, envelope.params.task_id).then((r) => {
              if (r.adopted) toast("付费成片已自动进入画布槽位");
              // adopt reconciled the record BY TASK on success; a result that
              // couldn't be adopted (shot changed in flight, preserved
              // unresolved) still marks the generation successful with NO result
              // Asset — honest and recoverable.
              else if (genId && r.unresolved) ctx.completeGeneration(genId, []);
              ctx.loadPaidOps();
            });
          } else {
            // a DEFINITIVE server response saying not-success → mark failed
            if (genId) ctx.failGeneration(genId, "failed");
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
          // AMBIGUOUS outcome: the submit threw, but the remote may already have
          // accepted+billed the job. Do NOT mark the generation failed — that
          // would exclude it from task reconciliation and permanently orphan a
          // billed success. Leave it `generating`; a later adopt reconciles it by
          // task if the job did complete. (A truly-rejected submit leaves a
          // `generating` record a future paid-op sweep can retire.)
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
    // Per-shot first frame resolved by MediaRef (TASK-048 第1步): the video
    // node's explicit first-frame input (「🎬→ 用作视频首帧」) wins; a shot
    // without one falls back to the assets slot's CURRENT version, as before.
    // Behavior otherwise unchanged: inlined as a data URL, >5.5MB fails closed
    // with a compress-and-reupload hint; a shot with no image locks text-only.
    const assetUploads = assetRegistry.images; // registry-backed, same data the nodes show
    const videoFrames = assetRegistry.firstFrames;
    // M4d: resolve each shot's first-frame/media slot through its CANONICAL
    // creative identity (creativeShotId → slot), not by trusting a positional
    // slot — an ambiguous shot resolves to no slot → text-only lock, never a
    // frame borrowed from another shot.
    const lockIdx = buildShotSlotIndex(draft);
    const shots = [];
    for (const s of draft) {
      let frame = null;
      const slot = typeof s.shotId === "string" && s.shotId ? slotForShotId(lockIdx, s.shotId) : s.slot || null;
      const fref = slot && videoFrames[slot];
      const url = (fref && fref.url) || (slot && mediaref.slotUrl(assetUploads, slot));
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
    // M4c bridge: send each shot's CREATIVE identity as a PARALLEL array (in
    // draft order), separate from the shot payload core consumes. The server
    // strips it before core and echoes it back onto each official record —
    // core's contract is untouched, the bridge is additive.
    const creativeShotIds = draft.map((s) => (typeof s.shotId === "string" && s.shotId ? s.shotId : null));
    const envelope = {
      command_id: "cmd-lock-" + Date.now().toString(36),
      name: "lock-draft-plan",
      params: { ...tgt.params, shots, creativeShotIds },
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

// --- script drafting orchestration (Idea → Script slice) -------------------
// The AI call lives HERE (behind ctx.script), never in the node's render/bind.
// CONNECTED → the real local Claude CLI via /api/agent/script-draft (ADR-0042
// posture: draft-domain, free, nothing written server-side). Demo → an honest
// deterministic local template so the flow stays walkable offline.
function demoScriptDraft(kind, instruction, base) {
  if (kind === "revision") {
    return (
      `${base}\n\n【演示修订 · ${instruction}】\n` +
      "（演示模式：本地模板改写，未调用 AI——连接后端后为真实 Claude 修订）"
    );
  }
  return (
    `【创意】${instruction}\n\n${FIX.script}\n\n` +
    "（演示模式：以上为本地示例剧本，未调用 AI——连接后端后按创意真实生成）"
  );
}

// Demo-mode breakdown: an honest deterministic template (labeled 演示模板 in
// the reasons) so the proposal review flow stays walkable offline — no AI.
function demoBibleBreakdown() {
  return {
    characters: [
      {
        name: "李昭", appearance: "束发青衫，眉目清瘦", costume: "青色襦衫",
        personality: "怯懦中藏锋", visualInstruction: "冷色调，低角度仰拍",
        voiceDescription: "清亮偏紧的青年声",
        states: [{ name: "殿前受迫", reason: "被逼当殿作诗（演示模板）" }],
      },
      {
        name: "皇帝", appearance: "冕旒垂面，目光如刀", costume: "玄色龙袍",
        personality: "威压难测", visualInstruction: "高位俯拍，金色逆光",
        voiceDescription: "低沉迟缓的中年声", states: [],
      },
    ],
    locations: [
      {
        name: "太极殿", description: "金砖白玉阶，百官分列",
        visualInstruction: "对称构图，纵深透视",
        states: [{ name: "夜晚", reason: "烛影幢幢（演示模板）" }],
      },
    ],
  };
}

// Demo-mode story development: honest deterministic templates (labeled) so
// the outline/plan proposal flow stays walkable offline — no AI.
function demoStoryOutline(doc) {
  const idea = doc.idea.trim() || "社畜穿越盛唐，被逼当殿作诗";
  return {
    premise: `${idea}（演示模板）`,
    logline: "小人物身怀现代记忆闯入权力之巅，每一次开口都是生死赌局。",
    genreTone: "古装爽剧 · 紧张中带黑色幽默",
    world: "架空盛唐，宫廷礼法森严，诗才即权力通行证。",
    characterConcepts: ["李昭：怯懦社畜，被逼觉醒的急智诗人", "皇帝：威压难测，以诗试人心", "高内侍：冷眼旁观的宫廷守门人"],
    centralConflict: "现代灵魂的求生欲 VS 皇权的猜忌与规训",
    storyArc: "被迫登场 → 险中求胜 → 名动长安 → 树敌宫闱 → 抉择去留",
    ending: "以一首『离席诗』换得自由身，留下传世之名。",
    episodeCount: 4,
    durationNote: "每集 60-90 秒",
  };
}
function demoEpisodePlan(doc) {
  const o = storydoc.approvedOutline(doc);
  // hard-capped like the real endpoint's parser (≤50): a crafted/huge
  // episodeCount must not exhaust memory building demo entries
  const n = Math.min((o && o.outline.episodeCount) || 4, 50);
  const beats = [
    ["殿前成诗", "李昭被拖上大殿，三步成诗保命。", "建立人物与规则", "拖拽上殿的混乱", "皇帝眯眼：『再来一首。』"],
    ["名动长安", "诗作传出宫墙，李昭一夜成名，也被盯上。", "扩张世界与代价", "满城传抄的诗笺", "暗处一只手捏碎诗笺"],
    ["宫闱暗流", "嫉恨者设局，命题诗暗藏杀机。", "反转与险境", "一道不可能的诗题", "李昭落笔前的死寂"],
    ["离席之诗", "李昭以一首离席诗自证，换得去留抉择。", "高潮与收束", "殿门缓缓打开", "背影消失在长安晨光"],
  ];
  // honor the approved episodeCount even beyond the template beats — extra
  // episodes get honest generic beats (still labeled 演示模板), never fewer
  // episodes than the approved outline requests
  return Array.from({ length: n }, (_, i) => {
    const b = beats[i] || [
      `第 ${i + 1} 集`, "剧情推进一步，埋下一个新钩子。", "推进",
      "上集结尾的钩子回收", "新的悬念落下",
    ];
    return {
      epNumber: i + 1,
      title: b[0],
      synopsis: `${b[1]}（演示模板）`,
      purpose: b[2],
      hook: b[3],
      endingBeat: b[4],
      duration: "60-90 秒",
    };
  });
}

// Run an AI story-development pass (outline or plan) — proposals only; the
// creator applies/discards in the story workspace (M9).
async function developStoryRun(kind, instruction) {
  const doc = storyDoc;
  if (kind === "outline" && !doc.idea.trim() && !storydoc.activeOutline(doc)) {
    toast("先在「故事」写一句创意");
    return;
  }
  const id = storydoc.beginDevelop(doc, kind, instruction);
  if (!id) {
    toast(
      kind === "plan" && !storydoc.approvedOutline(doc)
        ? "先批准一个故事大纲版本，再生成剧集规划"
        : doc.pending && doc.pending.status === "proposed"
          ? "有一份提案待处理：请先「应用」或「放弃」"
          : "已有一个生成在进行中",
    );
    return;
  }
  refreshProductionView();
  try {
    let payload;
    if (CONNECTED) {
      payload = kind === "plan"
        ? await query.planEpisodes({ outline: storydoc.approvedOutline(doc).outline, instruction })
        : await query.developStory({
            idea: doc.idea,
            current: (storydoc.activeOutline(doc) || {}).outline || null,
            instruction,
          });
    } else {
      await new Promise((r) => setTimeout(r, 700)); // visible working state
      payload = kind === "plan" ? demoEpisodePlan(doc) : demoStoryOutline(doc);
    }
    if (storyDoc !== doc) return; // project switched mid-flight
    if (storydoc.completeDevelop(doc, id, payload)) refreshProductionView();
  } catch (e) {
    if (storyDoc !== doc) return;
    if (storydoc.failDevelop(doc, id, e.message)) refreshProductionView();
  }
}

async function generateScript(kind, instruction) {
  const doc = scriptDoc;
  if (!instruction || !instruction.trim()) {
    toast(kind === "initial" ? "先在「创意」里写一句想法" : "先写修改要求");
    return;
  }
  // The revision base is the DOCUMENT's own text only — never the fixture/
  // placeholder fallback, so a fresh canvas can't mint a version chain from
  // non-script content (generate v1 or type a script first).
  const base = scriptdoc.currentText(doc);
  if (kind === "revision" && !base.trim()) {
    toast("当前没有剧本可修订：先「AI 生成剧本 v1」或直接输入剧本");
    return;
  }
  const id = scriptdoc.beginGeneration(doc, kind, instruction);
  if (!id) {
    toast(
      doc.pending && doc.pending.status === "proposed"
        ? "有一份修订稿待处理：请先「应用」或「放弃」"
        : "已有一个生成在进行中",
    );
    return;
  }
  ctx.refreshType("script");
  try {
    let content;
    if (CONNECTED) {
      content = await query.generateScriptDraft(
        kind === "revision" ? { baseScript: base, instruction } : { idea: instruction },
      );
    } else {
      await new Promise((r) => setTimeout(r, 900)); // visible loading state
      content = demoScriptDraft(kind, instruction, base);
    }
    // The user may have switched projects / reloaded the canvas while the call
    // was in flight — refresh/persist/toast would then act on the WRONG
    // project's state. Drop the stale result honestly instead.
    if (scriptDoc !== doc) {
      toast("剧本生成已完成，但画布已切换/重载，本次结果未套用");
      return;
    }
    // completeGeneration rejects a stale id (user cancelled meanwhile)
    if (scriptdoc.completeGeneration(doc, id, content)) {
      ctx.refreshType("script");
      ctx.persist();
      toast(
        kind === "initial"
          ? `剧本 v${doc.active} 已生成（旧版本保留，可回切）`
          : "修订稿已就绪：确认后应用为新版本，或放弃",
      );
    }
  } catch (e) {
    if (scriptDoc !== doc) return; // project switched mid-flight — nothing to show
    if (scriptdoc.failGeneration(doc, id, e.message)) ctx.refreshType("script");
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
    // M8: the Production studio renders the SAME draft state — a scriptgen
    // change (generation progress/completion, version switch) must reach it.
    // Other node types deliberately do NOT re-render the studio here: the
    // 12s paid polling would otherwise wipe in-progress field edits.
    if (node.type === "scriptgen") refreshProductionView();
  },
  // re-render every node of a type — used when upstream state (e.g. the current
  // draft version) changes and a downstream node's prefill must follow. The
  // Production workspace is one more view over the same domain state, so a
  // script refresh reaches it too (when visible).
  refreshType: (type) => {
    engine.nodes.filter((n) => n.type === type).forEach((n) => engine.refreshBody(n));
    if (dtNode && dtNode.type === type) renderDetail();
    if (type === "script" && production.isVisible()) production.render();
  },
  markIncoming: (id, state) => engine.markIncoming(id, state),
  addNext,
  // creative agent (ADR-0042): available whenever the backend is present
  isConnected: () => CONNECTED,
  // the CURRENT script text CONSUMED downstream (scriptgen → Claude) comes
  // from the script DOMAIN document ONLY: an empty/cleared doc reads as empty
  // so shot generation refuses instead of running on non-script text
  getScriptText: () => scriptdoc.currentText(scriptDoc),
  // stable id of the Script version that text comes from — null when the
  // buffer holds unversioned manual edits (provenance is never guessed, M2)
  getScriptSourceId: () => scriptdoc.sourceVersionId(scriptDoc),
  // Script domain controller (Idea → Script slice): the ONLY way node views
  // touch the script document. State transitions live in workflow/scriptdoc.js;
  // the AI call lives in generateScript() above.
  script: {
    doc: () => scriptDoc,
    // WHAT THE DOCUMENT HOLDS, nothing else — the view never shows fixture/
    // placeholder text as if it were content (display == truth == what
    // scriptgen consumes). Demo mode instead SEEDS the example script into a
    // virgin document on canvas entry (see enterCanvas), so it is real.
    currentText: () => scriptdoc.currentText(scriptDoc),
    // non-empty real document content — gates the revision affordance
    hasContent: () => !!scriptdoc.currentText(scriptDoc).trim(),
    isDirty: () => scriptdoc.isDirty(scriptDoc),
    setBrief: (t) => { scriptdoc.setBrief(scriptDoc, t); ctx.persist(); },
    edit: (t) => { scriptdoc.editText(scriptDoc, t); ctx.persist(); },
    generate: (kind, instruction) => generateScript(kind, instruction),
    cancel: () => { scriptdoc.cancelGeneration(scriptDoc); ctx.refreshType("script"); },
    applyProposal: () => {
      const rec = scriptdoc.applyProposal(scriptDoc);
      if (!rec) return;
      ctx.refreshType("script");
      ctx.persist();
      toast(`已应用修订为剧本 v${rec.v}（旧版本全部保留，可回切）`);
    },
    discardProposal: () => { scriptdoc.discardProposal(scriptDoc); ctx.refreshType("script"); },
    setActive: (v) => {
      if (!scriptdoc.setActive(scriptDoc, v)) return;
      ctx.refreshType("script");
      ctx.persist();
      toast(`已切到剧本 v${v}`);
    },
  },
  // Production structure controller (M6): the ONLY way views touch the
  // Episode/Scene document. State transitions live in workflow/proddoc.js;
  // every mutation persists (same canvas save) and re-renders the shell.
  production: {
    doc: () => productionDoc,
    addEpisode: (title) => {
      const ep = proddoc.addEpisode(productionDoc, title);
      ctx.persist();
      refreshProductionView();
      return ep;
    },
    renameEpisode: (id, title) => prodOp(proddoc.renameEpisode(productionDoc, id, title)),
    removeEpisode: (id) => {
      const ok = proddoc.removeEpisode(productionDoc, id);
      if (ok) {
        // removing the ACTIVE episode re-points the active pointer — the
        // script alias must follow, or edits would target the removed
        // episode's document (M9)
        syncActiveScript();
        ctx.refreshType("script");
      }
      return prodOp(ok);
    },
    setActiveEpisode: (id) => {
      const ok = proddoc.setActiveEpisode(productionDoc, id);
      if (ok) {
        // M9: the script surface follows the episode — re-point the alias and
        // refresh every script view before the shell re-renders
        syncActiveScript();
        ctx.refreshType("script");
      }
      return prodOp(ok);
    },
    addScene: (episodeId, title) => {
      const scene = proddoc.addScene(productionDoc, episodeId, title);
      if (scene) { ctx.persist(); refreshProductionView(); }
      return scene;
    },
    renameScene: (id, title) => prodOp(proddoc.renameScene(productionDoc, id, title)),
    removeScene: (id) => prodOp(proddoc.removeScene(productionDoc, id)),
    assignShot: (sceneId, shotId) => prodOp(proddoc.assignShot(productionDoc, sceneId, shotId)),
    unassignShot: (shotId) => prodOp(proddoc.unassignShot(productionDoc, shotId)),
  },
  // Production Bible controller (M7): characters/locations with states, voice
  // profiles, asset references, and scene↔bible references. Same posture as
  // ctx.production: the ONLY write path, every mutation persists + re-renders;
  // refused ops (false/null) change nothing. State transitions live in
  // workflow/bibledoc.js.
  bible: {
    addCharacter: (name) => prodNew(bibledoc.addCharacter(productionDoc, name)),
    renameCharacter: (id, name) => prodOp(bibledoc.renameCharacter(productionDoc, id, name)),
    removeCharacter: (id) => prodOp(bibledoc.removeCharacter(productionDoc, id)),
    updateCharacterProfile: (id, fields) => prodOp(bibledoc.updateCharacterProfile(productionDoc, id, fields)),
    setCharacterVoice: (id, voice) => prodOp(bibledoc.setCharacterVoice(productionDoc, id, voice)),
    addCharacterState: (id, name) => prodNew(bibledoc.addCharacterState(productionDoc, id, name)),
    renameCharacterState: (id, sid, name) => prodOp(bibledoc.renameCharacterState(productionDoc, id, sid, name)),
    removeCharacterState: (id, sid) => prodOp(bibledoc.removeCharacterState(productionDoc, id, sid)),
    setCharacterStateOverrides: (id, sid, o) => prodOp(bibledoc.setCharacterStateOverrides(productionDoc, id, sid, o)),
    addLocation: (name) => prodNew(bibledoc.addLocation(productionDoc, name)),
    renameLocation: (id, name) => prodOp(bibledoc.renameLocation(productionDoc, id, name)),
    removeLocation: (id) => prodOp(bibledoc.removeLocation(productionDoc, id)),
    updateLocationProfile: (id, fields) => prodOp(bibledoc.updateLocationProfile(productionDoc, id, fields)),
    addLocationState: (id, name) => prodNew(bibledoc.addLocationState(productionDoc, id, name)),
    renameLocationState: (id, sid, name) => prodOp(bibledoc.renameLocationState(productionDoc, id, sid, name)),
    removeLocationState: (id, sid) => prodOp(bibledoc.removeLocationState(productionDoc, id, sid)),
    setLocationStateOverrides: (id, sid, o) => prodOp(bibledoc.setLocationStateOverrides(productionDoc, id, sid, o)),
    addReferenceAsset: (id, assetId) => prodOp(bibledoc.addReferenceAsset(productionDoc, id, assetId)),
    removeReferenceAsset: (id, assetId) => prodOp(bibledoc.removeReferenceAsset(productionDoc, id, assetId)),
    setActiveReferenceAsset: (id, assetId) => prodOp(bibledoc.setActiveReferenceAsset(productionDoc, id, assetId)),
    addSceneCharacter: (sceneId, cid, sid) => prodOp(bibledoc.addSceneCharacter(productionDoc, sceneId, cid, sid)),
    setSceneCharacterState: (sceneId, cid, sid) => prodOp(bibledoc.setSceneCharacterState(productionDoc, sceneId, cid, sid)),
    removeSceneCharacter: (sceneId, cid) => prodOp(bibledoc.removeSceneCharacter(productionDoc, sceneId, cid)),
    setSceneLocation: (sceneId, lid, sid) => prodOp(bibledoc.setSceneLocation(productionDoc, sceneId, lid, sid)),
  },
  agentShotsDraft: (script) => query.generateShotsDraft(script),
  // Story development controller (M9): Idea → Outline (versioned, approved) →
  // Episode Plan (versioned, confirmed). The ONLY write path into the story
  // document; AI output lands as proposals, application is explicit, versions
  // are never overwritten. Confirming a plan INSTANTIATES/links Episode
  // entities (explicit identity join stamped into the plan version). The
  // outline never writes Production Bible entities (M9 rule 8).
  story: {
    doc: () => storyDoc,
    setIdea: (t) => { storydoc.setIdea(storyDoc, t); ctx.persist(); },
    develop: (kind, instruction) => developStoryRun(kind, instruction),
    cancel: () => { storydoc.cancelDevelop(storyDoc); refreshProductionView(); },
    applyProposal: () => {
      const rec = storydoc.applyProposal(storyDoc);
      if (!rec) return null;
      ctx.persist();
      refreshProductionView();
      toast(rec.outline
        ? `已应用为故事大纲 v${rec.v}（旧版本保留；批准后才能规划分集）`
        : `已应用为剧集规划 v${rec.v}（确认后才建立剧集）`);
      return rec;
    },
    discardProposal: () => { storydoc.discardProposal(storyDoc); refreshProductionView(); },
    applyManualOutline: (fields) => {
      const rec = storydoc.applyManualOutline(storyDoc, fields);
      ctx.persist();
      refreshProductionView();
      toast(`已保存为大纲 v${rec.v}（手工修改，旧版本保留）`);
      return rec;
    },
    setActiveOutline: (v) => prodOp(storydoc.setActiveOutline(storyDoc, v)),
    approveOutline: (v) => {
      const ok = storydoc.approveOutline(storyDoc, v);
      if (ok) {
        ctx.persist();
        refreshProductionView();
        toast(`已批准故事大纲 v${v} — 现在可以生成剧集规划`);
      }
      return ok;
    },
    setActivePlan: (v) => prodOp(storydoc.setActivePlan(storyDoc, v)),
    // Confirm the plan: entries without an episode get one created; entries
    // already linked keep their episode (title follows the plan). A pristine
    // sole default episode (no scenes, no script content) is ADOPTED as the
    // first unlinked entry's episode instead of leaving an empty orphan —
    // a deterministic adoption rule, never a name-based guess.
    confirmPlan: (v) => {
      const plan = storyDoc.plans.find((p) => p.v === v);
      if (!plan) return false;
      const pristine =
        productionDoc.episodes.length === 1
        && productionDoc.episodes[0].scenes.length === 0
        // a manually RENAMED episode is intentional user data — never adopt
        // and retitle it; only the untouched default (第 1 集, the exact title
        // both the migration and defaultProduction mint) qualifies
        && productionDoc.episodes[0].title === "第 1 集"
        && !plan.episodes.some((e) => e.episodeId === productionDoc.episodes[0].episodeId)
        && !scriptdoc.currentText(scriptForEpisode(productionDoc.episodes[0].episodeId)).trim()
          ? productionDoc.episodes[0]
          : null;
      let adopted = false;
      for (const e of plan.episodes) {
        const existing = e.episodeId ? proddoc.findEpisode(productionDoc, e.episodeId) : null;
        if (existing) {
          if (e.title.trim() && existing.title !== e.title) proddoc.renameEpisode(productionDoc, existing.episodeId, e.title);
        } else if (pristine && !adopted) {
          adopted = true;
          e.episodeId = pristine.episodeId;
          if (e.title.trim()) proddoc.renameEpisode(productionDoc, pristine.episodeId, e.title);
        } else {
          const ep = proddoc.addEpisode(productionDoc, e.title);
          e.episodeId = ep.episodeId; // explicit identity join, stamped once
        }
      }
      storydoc.confirmPlan(storyDoc, v);
      // defensive: none of the episode ops above moves the active pointer
      // today (addEpisode only appends), but the script alias must be correct
      // no matter how they evolve — resyncing is idempotent
      syncActiveScript();
      ctx.persist();
      refreshProductionView();
      toast(`已确认剧集规划 v${v} · ${plan.episodes.length} 集已建立/联结 — 选择一集进入其剧本`);
      return true;
    },
    // enter an episode's script workspace (M9 rule 7)
    openEpisodeScript: (episodeId) => {
      if (!ctx.production.setActiveEpisode(episodeId)) return false;
      return true;
    },
  },
  // The CONTEXT brief the active episode's initial script generation runs
  // from: idea + approved outline + this episode's confirmed plan entry —
  // composed at call time, honest fallback to the bare idea.
  episodeScriptBrief: () => {
    const epId = productionDoc.activeEpisodeId;
    const plan = storydoc.confirmedPlan(storyDoc);
    // the outline the CONFIRMED plan was built from — never a newer approved
    // outline mixed with an older plan (contradictory context)
    const o = plan ? storydoc.outlineForPlan(storyDoc, plan) : storydoc.approvedOutline(storyDoc);
    const entry = plan && plan.episodes.find((e) => e.episodeId === epId);
    const parts = [];
    if (storyDoc.idea.trim()) parts.push(`创意：${storyDoc.idea.trim()}`);
    if (o) {
      if (o.outline.premise) parts.push(`前提：${o.outline.premise}`);
      if (o.outline.logline) parts.push(`故事线：${o.outline.logline}`);
      if (o.outline.genreTone) parts.push(`题材/基调：${o.outline.genreTone}`);
    }
    if (entry) {
      parts.push(`本集 EP${entry.epNumber}「${entry.title}」：${entry.synopsis}`);
      if (entry.hook) parts.push(`开场钩子：${entry.hook}`);
      if (entry.endingBeat) parts.push(`结尾拍：${entry.endingBeat}`);
    }
    return parts.join("\n");
  },
  // 剧本拆解 / 同步作品设定 (M8): AI-first bible workflow. The agent PROPOSES
  // characters/locations/states from the episode script; every application is
  // an explicit user action composed of existing bibledoc ops — a confirmed
  // entity is never destructively overwritten by the sync (updates write only
  // the shown changed fields; merges fill only EMPTY fields; states are
  // additive). Proposals are transient review state, never persisted.
  breakdown: {
    state: () => bibleProposals,
    clear: () => { bibleProposals = null; refreshProductionView(); },
    dismiss: (id) => {
      if (!bibleProposals || bibleProposals.status !== "ready") return;
      bibleProposals.cards = bibleProposals.cards.filter((c) => c.id !== id);
      refreshProductionView();
    },
    run: async () => {
      if (bibleProposals && bibleProposals.status === "running") return;
      const script = scriptdoc.currentText(scriptDoc);
      if (!script.trim()) { toast("剧本为空：先在「剧本」工作区生成/输入剧本"); return; }
      const doc = productionDoc;
      bibleProposals = { status: "running", cards: [], error: null, source: CONNECTED ? "claude" : "demo" };
      refreshProductionView();
      try {
        let raw;
        if (CONNECTED) {
          raw = await query.generateBibleBreakdown(script);
        } else {
          await new Promise((r) => setTimeout(r, 700)); // visible working state
          raw = demoBibleBreakdown();
        }
        // project switched / reloaded while the call was in flight → stale
        if (productionDoc !== doc) return;
        const parsed = breakdown.parseBreakdown(raw);
        const cards = breakdown.matchProposals(productionDoc, parsed);
        bibleProposals = {
          status: "ready",
          cards,
          error: null,
          source: CONNECTED ? "claude" : "demo",
          // the script changed while the agent ran — the proposals derive
          // from the text as it was at launch; say so instead of pretending
          stale: scriptdoc.currentText(scriptDoc) !== script,
        };
      } catch (e) {
        if (productionDoc !== doc) return;
        bibleProposals = { status: "failed", cards: [], error: e.message, source: CONNECTED ? "claude" : "demo" };
      }
      refreshProductionView();
    },
    // 添加为新实体 — creates the entity, fills its profile/voice, adds states.
    addAsNew: (id) => {
      const card = (bibleProposals?.cards || []).find((c) => c.id === id);
      if (!card || !card.kind.startsWith("new-")) return null;
      const p = card.proposal;
      let entity;
      if (card.kind === "new-character") {
        entity = bibledoc.addCharacter(productionDoc, p.name);
        bibledoc.updateCharacterProfile(productionDoc, entity.characterId, p);
        if (p.voiceDescription) bibledoc.setCharacterVoice(productionDoc, entity.characterId, { description: p.voiceDescription });
        for (const s of p.states) bibledoc.addCharacterState(productionDoc, entity.characterId, s.name);
      } else {
        entity = bibledoc.addLocation(productionDoc, p.name);
        bibledoc.updateLocationProfile(productionDoc, entity.locationId, p);
        for (const s of p.states) bibledoc.addLocationState(productionDoc, entity.locationId, s.name);
      }
      ctx.breakdown.dismiss(id);
      ctx.persist();
      toast(`已添加${card.kind === "new-character" ? "角色" : "场景地"}「${p.name}」`);
      return entity;
    },
    // 应用更新 — writes EXACTLY the changes the card DISPLAYED. A field whose
    // current value no longer matches the card's "from" was manually edited
    // mid-review and is SKIPPED (reported honestly) — an unseen difference is
    // never written, so a confirmed edit can't be silently lost.
    applyUpdate: (id) => ctx.breakdown._applyTo(id, null, "update"),
    // 并入已有 — the user picked the target; only fields EMPTY at apply time
    // are filled (non-destructive by construction, even after mid-review edits).
    mergeInto: (id, entityId) => ctx.breakdown._applyTo(id, entityId, "merge"),
    _applyTo: (id, entityId, mode) => {
      const card = (bibleProposals?.cards || []).find((c) => c.id === id);
      if (!card) return false;
      const p = card.proposal;
      const isChar = card.kind.endsWith("character");
      const targetId = entityId || card.entityId;
      const entity = isChar
        ? bibledoc.findCharacter(productionDoc, targetId)
        : bibledoc.findLocation(productionDoc, targetId);
      if (!entity) return false;
      let fieldsToWrite;
      let statesToAdd;
      let skipped = 0;
      if (mode === "merge") {
        const changes = isChar
          ? breakdown.characterChanges(entity, p, "merge")
          : breakdown.locationChanges(entity, p, "merge");
        fieldsToWrite = changes.fields;
        statesToAdd = changes.states;
      } else {
        // the card's snapshot, gated field-by-field on "unchanged since shown"
        const gated = breakdown.gateUpdate(entity, card.changes);
        fieldsToWrite = gated.fields;
        skipped = gated.skipped;
        statesToAdd = gated.states;
      }
      const fields = {};
      for (const f of fieldsToWrite) {
        if (f.key === "voiceDescription") bibledoc.setCharacterVoice(productionDoc, targetId, { description: f.to });
        else fields[f.key] = f.to;
      }
      if (Object.keys(fields).length) {
        if (isChar) bibledoc.updateCharacterProfile(productionDoc, targetId, fields);
        else bibledoc.updateLocationProfile(productionDoc, targetId, fields);
      }
      for (const s of statesToAdd) {
        if (isChar) bibledoc.addCharacterState(productionDoc, targetId, s.name);
        else bibledoc.addLocationState(productionDoc, targetId, s.name);
      }
      ctx.breakdown.dismiss(id);
      ctx.persist();
      toast(
        mode === "merge"
          ? `已并入「${entity.name}」（只填充空字段，已确认内容未被覆盖）`
          : skipped
            ? `已应用更新到「${entity.name}」；${skipped} 个字段在提案后被手工修改，已保留你的版本未覆盖`
            : `已应用更新到「${entity.name}」`,
      );
      return true;
    },
  },
  // Shot-draft controller (M8): the Production studio's write path INTO the
  // scriptgen node. The workflow node stays the SINGLE owner of draft
  // versions — both views render one state; every save is a NEW immutable
  // version (never overwrites history), exactly like the node's ✎ editor.
  shots: {
    node: () => engine.nodes.find((n) => n.type === "scriptgen") || null,
    // The scriptgen node (and its script predecessor) exist whenever the
    // studio needs to write — a fresh canvas gets the story seed; a seeded
    // canvas whose scriptgen node was deleted gets one re-created.
    ensure: () => {
      let n = ctx.shots.node();
      if (n) return n;
      if (!seeded) seedStory();
      n = ctx.shots.node();
      if (!n) {
        const s = engine.nodes.find((x) => x.type === "script");
        n = createNode("scriptgen", s ? s.x + 360 : 360, s ? s.y : 40);
        if (s) engine.addEdge(s.id, n.id, "");
        engine.render();
      }
      return n;
    },
    // Kick a (re)generation — the node's OWN run flow (real agent when
    // connected, fixture demo otherwise), so state/versions behave identically
    // from either view.
    generateDraft: () => {
      const n = ctx.shots.ensure();
      if (!n || n.state === "gen") return false;
      registry.get("scriptgen").run(n, ctx);
      return true;
    },
    // Save an edited raw shot list as a NEW draft version. Same identity
    // rules as the node editor: surviving shots keep shotId + slot, new ones
    // mint fresh; M8 creative facets ride on the raw shots additively.
    saveEdit: (items) => {
      const node = ctx.shots.node();
      const curV = node && (node.versions || []).find((x) => x.v === node.cur);
      if (!curV) return false;
      const v = nextDraftVersion(node.versions); // max+1, never length+1
      const edited = normalizeShots(items, `v${v}`);
      node.versions.push({
        id: mintId("sdv"),
        v,
        shots: edited.map((s) => [
          String(s.sequence).padStart(2, "0"),
          `${s.title} — ${s.description}（${s.duration_seconds}s）`,
        ]),
        draft: true,
        edited: true,
        raw: edited,
        origin: "edited",
        sourceScriptVersionId: curV.sourceScriptVersionId ?? null,
        basedOnDraftId: typeof curV.id === "string" ? curV.id : null,
      });
      node.cur = v;
      node.state = "done";
      ctx.project.draftShots = edited;
      ctx.project.lockedPlan = null; // the new edited version is not locked
      ctx.refresh(node);
      ctx.refreshType("assets");
      ctx.refreshType("video");
      ctx.persist();
      return true;
    },
  },
  // Audio production controller (M11-A): the single write path for audio
  // REFERENCES (scene ambience / episode+scene BGM) and for audio media
  // entering from the studio. providerModes: manual_subscription (copy the
  // compiled prompt → external web tool) / local_subscription (piper TTS) /
  // import / api (future — architecture slot only, no provider wired).
  audio: {
    setSceneAmbience: (sceneId, assetId) => prodOp(proddoc.setSceneAmbience(productionDoc, sceneId, assetId)),
    setSceneBgm: (sceneId, assetId) => prodOp(proddoc.setSceneBgm(productionDoc, sceneId, assetId)),
    setEpisodeBgm: (episodeId, assetId) => prodOp(proddoc.setEpisodeBgm(productionDoc, episodeId, assetId)),
    // the reusable audio pools: every history record under keys with this
    // prefix IS an Asset (ambience: amb-…, music: bgm-… + legacy music-main)
    pool: (prefix) => {
      const out = [];
      for (const key of Object.keys(assetRegistry.audio)) {
        if (!key.startsWith(prefix) && !(prefix === "bgm" && key === "music-main")) continue;
        const e = mediaref.slotEntry(assetRegistry.audio, key);
        if (!e) continue;
        for (const r of e.history) {
          if (r && r.assetId) out.push({ assetId: r.assetId, key, version: r.version, url: r.url, label: `${key} v${r.version}`, storageState: r.storageState || "local" });
        }
      }
      return out;
    },
    // shared audio-import core: same upload endpoint + slug namespace as the
    // audio node (`audio-<key>`), mediaref appends a version, and an
    // intent-carrying import records REAL Generation provenance
    importKey: async (key, shotId, file, intent) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法导入文件");
      const res = await query.uploadAssetImage(PROJECT_NAME, `audio-${key}`, file);
      const ref = mediaref.refFromResponse(key, "upload", res, shotId ?? null);
      mediaref.addVersion({ uploads: assetRegistry.audio }, key, ref);
      if (intent && intent.prompt) {
        const gen = ctx.startGeneration({
          type: "audio",
          targetType: shotId ? "shot" : null,
          targetId: shotId ?? null,
          promptSnapshot: intent.prompt,
          provider: intent.entry || "import",
          parameters: { providerMode: intent.providerMode || "import" },
          status: "generating",
        });
        if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
      }
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(`已导入音频 · v${res.version || 1}（旧版本保留）${intent && intent.prompt ? " · 已记录生成溯源" : ""}`);
      return ref;
    },
    // mint a NEW pool chain and import its first take (ambience/BGM pools)
    importPool: async (prefix, file, intent) => {
      const key = mintId(prefix); // e.g. amb-<uuid> / bgm-<uuid>
      return ctx.audio.importKey(key, null, file, intent);
    },
    // REAL local dialogue TTS (piper, ADR-0043 — the local_subscription mode):
    // fits the shot's video length when a clip exists, registers the take as
    // a new variant and records provenance with the dialogue text.
    ttsDialogue: async (slot, shotId, text, fitSlug, voiceMeta = null) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法本地 TTS");
      if (!text || !text.trim()) throw new Error("对白为空：先在镜头详情填写台词");
      // the voice-identity rule is ENFORCED at generation: a dialogue take
      // must belong to a speaker with a FIXED base voice identity — an
      // unassigned shot or a scene with no characters cannot generate one
      if (!voiceMeta || !voiceMeta.characterId) throw new Error("未选择说话人：在场景添加出场角色并选择说话人");
      if (!voiceMeta.voiceId) throw new Error("说话人未设基础声音（voiceId）：先在「作品设定」填写声音档案");
      const key = `voice-${slot}`;
      // pass the speaker's FIXED base voiceId so the server renders with a
      // matching local piper model when present (else honest default fallback)
      const res = await query.ttsGenerate(PROJECT_NAME, `audio-${key}`, text, fitSlug || undefined, voiceMeta && voiceMeta.voiceId ? voiceMeta.voiceId : undefined);
      const ref = mediaref.refFromResponse(key, "tts", res, shotId ?? null);
      mediaref.addVersion({ uploads: assetRegistry.audio }, key, ref);
      const gen = ctx.startGeneration({
        type: "audio",
        targetType: shotId ? "shot" : null,
        targetId: shotId ?? null,
        promptSnapshot: text,
        provider: "piper",
        // the speaker's FIXED voice identity + state performance + emotion are
        // recorded with the take (provenance says WHO this line belongs to),
        // AND what the local model ACTUALLY rendered: res.voice is the requested
        // voiceId when its piper model was present, else null (default model) —
        // so history never falsely claims a character voice that didn't render
        parameters: {
          providerMode: "local_subscription",
          ...(voiceMeta && typeof voiceMeta === "object" ? { voice: voiceMeta } : {}),
          voiceRendered: res && "voice" in res ? res.voice : null,
        },
        status: "generating",
      });
      if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(`本地配音完成 · v${res.version || 1}（旧版本保留，可回切）`);
      return ref;
    },
  },
  // Episode-timeline controller (M11-B): the single write path into the
  // per-episode timeline. Clips reference assetIds only. SHOT→TIMELINE RULE:
  // an UN-EDITED timeline always mirrors the shots (auto-sync is safe —
  // nothing hand-made can be lost); after the first manual edit a stale
  // source shows a banner and re-sync is an EXPLICIT confirmed action
  // (a hand-edited timeline is never silently overwritten).
  timeline: {
    // sync a timeline from rows AND stamp the source fingerprint used by
    // sourceStale — the ONE place both fields move together
    _sync: (t, rows) => {
      timeline.syncFromRows(t, rows);
      t.sourceSig = timelineSourceSig(t.clips);
    },
    doc: () => {
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      if (!t.edited) {
        const rows = ctx.timeline.gatherRows();
        const hasVideo = rows.some((r) => r.videoAssetId);
        if ((t.clips.length && ctx.timeline.sourceStale(t)) || (!t.clips.length && hasVideo)) {
          ctx.timeline._sync(t, rows);
          ctx.persist();
        }
      }
      return t;
    },
    // the DEFAULT rows the timeline mirrors: active episode's scenes in
    // order (then unassigned draft shots), each shot's CURRENT video/voice/
    // sfx assets + the scene's ambience + effective BGM
    gatherRows: () => {
      const draft = ctx.project.draftShots || [];
      const idx = buildShotSlotIndex(draft);
      const ep = proddoc.activeEpisode(productionDoc);
      const view = ep ? proddoc.episodeView(productionDoc, ep.episodeId, draft) : null;
      const ordered = [];
      if (view) {
        for (const sc of view.scenes) {
          for (const x of sc.shots) if (x.shot) ordered.push({ shot: x.shot, sceneId: sc.sceneId });
        }
        for (const s of view.unassigned) ordered.push({ shot: s, sceneId: null });
      }
      // the CURRENT asset regardless of byte availability: a clip must keep
      // REFERENCING an archived/removed asset (the timeline UI shows it as
      // unavailable and render refuses honestly) — filtering non-local here
      // would let the unedited auto-sync silently DROP those references
      const cur = (map, key) => {
        const r = key ? mediaref.currentRef(map, key) : null;
        return r && r.assetId ? r.assetId : null;
      };
      return ordered.map(({ shot, sceneId }) => {
        const slot = shot.shotId ? slotForShotId(idx, shot.shotId) : null;
        const scene = sceneId ? proddoc.findScene(productionDoc, sceneId) : null;
        const bgm = ep ? proddoc.effectiveBgm(productionDoc, ep.episodeId, sceneId) : null;
        return {
          shotId: shot.shotId || null,
          duration: shot.duration_seconds === 10 ? 10 : 6,
          videoAssetId: cur(assetRegistry.videos, slot),
          dialogueAssetId: cur(assetRegistry.audio, slot ? `voice-${slot}` : null),
          sfxAssetId: cur(assetRegistry.audio, slot ? `sfx-${slot}` : null),
          sceneId,
          ambienceAssetId: scene ? scene.scene.ambienceAssetId : null,
          bgmAssetId: bgm ? bgm.assetId : null,
        };
      });
    },
    // Has the SOURCE (shots / current media / scene audio) changed since this
    // timeline was last built from it? Compares the current source's default
    // build to the sourceSig STAMPED at the last sync — NOT to the (possibly
    // hand-edited) clip list, so trim/reorder/volume edits never false-report
    // "source changed". The signature carries shotId + startTime so reordering
    // equal-duration shots that reuse one asset is still detected.
    sourceStale: (t) => timelineSourceSig(timeline.buildFromRows(ctx.timeline.gatherRows())) !== (t.sourceSig || ""),
    resync: () => {
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      ctx.timeline._sync(t, ctx.timeline.gatherRows());
      ctx.persist();
      refreshProductionView();
      toast("时间线已按当前镜头/音频重建（此前的手工调整被本次同步覆盖）");
    },
    op: (fn, ...args) => {
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      const ok = timeline[fn](t, ...args);
      if (ok) { ctx.persist(); refreshProductionView(); }
      return ok;
    },
    setSettings: (s) => {
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      timeline.setSettings(t, s);
      ctx.persist();
      return true;
    },
    // FINAL RENDER (local FFmpeg): resolve every clip's asset to its exact
    // uploaded file (bytes must be local — missing media fails honestly, it
    // is never skipped), render server-side, register the Final Asset and a
    // durable RENDER provenance record (type "render", provider ffmpeg-local,
    // inputs = clip assetIds, parameters = settings + clip snapshot).
    render: async () => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法渲染（需连接模式 + 本地 ffmpeg）");
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      if (!t.clips.some((c) => c.trackType === "video")) throw new Error("时间线没有视频 clip");
      const clips = [];
      for (const c of t.clips) {
        // a muted / zero-volume AUDIO clip contributes nothing and the backend
        // skips it — drop it here too so an unavailable (deleted) asset on such
        // a clip never blocks a render it wouldn't participate in anyway
        const silentAudio = c.trackType !== "video" && (c.muted === true || c.volume <= 0);
        if (silentAudio) continue;
        const hit = assetlib.findAssetById(assetRegistry, c.assetId);
        if (!hit) throw new Error(`clip 引用的资产已不存在（${c.trackType} · ${c.assetId}）`);
        if ((hit.record.storageState || "local") !== "local") {
          throw new Error(`clip 的媒体不可用（${c.trackType} · ${hit.record.storageState}）— 请恢复或替换后再渲染`);
        }
        clips.push({
          track: c.trackType,
          file: String(hit.record.url || "").split("/").pop(),
          start: c.startTime,
          in: c.trimIn,
          out: c.trimOut,
          volume: c.volume,
          muted: c.muted,
          fadeIn: c.fadeIn,
          fadeOut: c.fadeOut,
        });
      }
      const res = await query.renderEpisode(PROJECT_NAME, clips, t.settings);
      const rec = assetlib.addFinal(assetRegistry, res.url);
      const gen = ctx.startGeneration({
        type: "render",
        targetType: null,
        targetId: null,
        inputAssetIds: [...new Set(t.clips.map((c) => c.assetId))],
        promptSnapshot: null,
        provider: "ffmpeg-local",
        parameters: {
          providerMode: "local",
          settings: { ...t.settings },
          episodeId: productionDoc.activeEpisodeId,
          clips: t.clips.map((c) => ({ clipId: c.clipId, trackType: c.trackType, assetId: c.assetId, startTime: c.startTime, trimIn: c.trimIn, trimOut: c.trimOut, volume: c.volume, muted: c.muted, fadeIn: c.fadeIn, fadeOut: c.fadeOut })),
        },
        status: "generating",
      });
      if (gen && rec) ctx.completeGeneration(gen.generationId, [rec.assetId]);
      ctx.refreshType("edit");
      ctx.persist();
      refreshProductionView();
      return { ...res, assetId: rec ? rec.assetId : null };
    },
  },
  // read-only registry view for the storage workspace (writes stay on the
  // ctx.storage / mediaref paths)
  assetRegistryView: () => assetRegistry,
  // Storage-management controller (M11-D): built on the EXISTING M5
  // storageState lifecycle — no second state system. Byte removal keeps the
  // assetId, metadata, provenance and every reference (shown unavailable);
  // permanent delete is gated on the blocking-reference scan.
  storage: {
    referencesOf: (assetId) => assetlib.referencesOfAsset({
      reg: assetRegistry,
      assetId,
      production: productionDoc,
      timelines: timelinesDoc,
      generations: generationRegistry,
    }),
    archive: (assetId, on) => {
      // archive is a local↔archived toggle ONLY: un-archiving must never
      // resurrect a deleted/missing record to "local" (bytes are still gone)
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      const state = hit ? hit.record.storageState || "local" : null;
      if (state !== "local" && state !== "archived") return false;
      const ok = assetlib.setStorageState(assetRegistry, assetId, on ? "archived" : "local");
      if (ok) { ctx.persist(); refreshProductionView(); }
      return ok;
    },
    // Remove Local Copy: bytes go, EVERYTHING else stays (assetId, metadata,
    // provenance, references — the UI shows the media as unavailable).
    removeLocal: async (assetId) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法删除文件");
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      if (!hit) throw new Error("资产不存在");
      await query.deleteAssetFile(PROJECT_NAME, String(hit.record.url || "").split("/").pop());
      assetlib.setStorageState(assetRegistry, assetId, "deleted");
      ctx.persist();
      refreshProductionView();
      toast("已移除本地副本 — 资产身份/元数据/溯源保留，引用处将显示媒体不可用");
      return true;
    },
    // Permanent Delete: EXPLICIT destructive action — blocked while any
    // blocking reference exists (never silently broken); provenance links
    // are reported and deliberately left dangling (M5 design).
    permanentDelete: async (assetId) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法删除文件");
      const refs = ctx.storage.referencesOf(assetId);
      if (refs.blocking.length) {
        throw new Error(`仍被引用，已阻止删除：${refs.blocking.join("；")} — 先释放这些引用`);
      }
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      if (!hit) throw new Error("资产不存在");
      await query.deleteAssetFile(PROJECT_NAME, String(hit.record.url || "").split("/").pop());
      assetlib.removeAssetRecord(assetRegistry, assetId);
      ctx.refreshType("assets");
      ctx.refreshType("video");
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(`已永久删除资产（溯源记录保留${refs.provenance ? `，${refs.provenance} 条生成记录的链接将悬空——按设计如实保留` : ""}）`);
      return true;
    },
  },
  // Media controller (M8): variant switching on the PROJECT registry (M3)
  // through the same mediaref primitive the node version picker uses — no
  // second media state, no new write path.
  media: {
    setCurrent: (domain, slot, version) => {
      const map =
        domain === "image" ? assetRegistry.images
        : domain === "video" ? assetRegistry.videos
        : domain === "audio" ? assetRegistry.audio
        : null;
      if (!map) return false;
      const ok = mediaref.setCurrent({ uploads: map }, slot, version);
      if (ok) {
        ctx.refreshType(domain === "image" ? "assets" : domain);
        ctx.persist();
        refreshProductionView();
        toast(`已回切到 v${version}（旧版本全部保留）`);
      }
      return ok;
    },
    // 导入生成结果 (M10): a manual-entry (ChatGPT/Gemini) generation comes
    // BACK onto the shot — same upload endpoint + mediaref write path as the
    // workflow nodes (identical slug namespace, so files land alongside node
    // uploads); when the prompt flow was used, the Generation Registry gets a
    // REAL record (promptSnapshot = the copied text, provider = the entry).
    importShotMedia: async (kind, slot, shotId, file, intent) => {
      if (!CONNECTED) {
        throw new Error("演示模式无后端，无法导入文件（复制提示词仍可用）");
      }
      const slug = kind === "image" ? `assets-${slot}` : `video-${slot}`;
      const res = await query.uploadAssetImage(PROJECT_NAME, slug, file);
      const map = kind === "image" ? assetRegistry.images : assetRegistry.videos;
      const ref = mediaref.refFromResponse(slot, "upload", res, shotId ?? null);
      mediaref.addVersion({ uploads: map }, slot, ref);
      if (intent && intent.prompt && intent.shotId === shotId) {
        const gen = ctx.startGeneration({
          type: kind === "image" ? "image" : "video",
          targetType: shotId ? "shot" : null,
          targetId: shotId ?? null,
          promptSnapshot: intent.prompt,
          provider: intent.entry || "manual",
          parameters: null,
          status: "generating",
        });
        if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
      }
      ctx.refreshType(kind === "image" ? "assets" : "video");
      ctx.persist();
      refreshProductionView();
      toast(`已导入 · v${res.version || 1}（旧版本保留，可回切）${intent ? " · 已记录生成溯源" : ""}`);
      return ref;
    },
    // 「用作视频首帧」 from the studio — same carried-reference semantics as
    // the assets node flow (registry maps are the same objects).
    useAsFirstFrame: async (slot) => {
      const an = engine.nodes.find((n) => n.type === "assets");
      if (an) {
        await ctx.useAsFirstFrame(an, slot);
        refreshProductionView();
        return;
      }
      const ref = mediaref.currentRef(assetRegistry.images, slot);
      if (!ref) { toast("该镜头还没有图，先生成/上传一张"); return; }
      let digest = ref.digest;
      if (!digest) {
        try { digest = await mediaref.sha256OfUrl(ref.url); } catch { digest = null; }
      }
      mediaref.putKey(assetRegistry.firstFrames, slot, { ...ref, slot_id: slot, digest });
      ctx.refreshType("video");
      ctx.persist();
      refreshProductionView();
      toast(`已设为该镜头视频首帧（来自资产 v${ref.version}）`);
    },
  },
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
    if (!PAID) {
      const err = new Error("付费模式未开启（--enable-paid）");
      err.definitiveReject = true; // a client-side guard — nothing was generated/billed
      return Promise.reject(err);
    }
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
  // branched nodes can never make compose pick an unrelated file). Values are
  // versioned slot entries — consumers read them via mediaref.slotUrl/slotStem.
  collectMedia: () => ({
    // M3: the Project Asset Registry IS the media source of truth — node
    // views alias these same maps, so this is the same data every node shows.
    video: assetRegistry.videos,
    audio: assetRegistry.audio,
  }),
  // 「🎬→ 用作视频首帧」(TASK-048 第1步): flow the assets slot's CURRENT
  // version image into every video node's first-frame input as a MediaRef.
  useAsFirstFrame: async (assetsNode, slot) => {
    const ref = mediaref.currentRef(assetsNode.uploads, slot);
    if (!ref) { toast("该镜头还没有图，先生成/上传一张"); return; }
    let digest = ref.digest;
    if (!digest) {
      // legacy entries carry no digest — compute it now so the MediaRef binds
      // the exact bytes (same sha256 family as the lock-draft first frame)
      try { digest = await mediaref.sha256OfUrl(ref.url); } catch { digest = null; }
    }
    // The carried reference keeps the image Asset's identity (same assetId):
    // "use as first frame" relates the SAME Asset, it does not mint a twin.
    const frameRef = { ...ref, slot_id: slot, digest };
    if (!engine.nodes.some((n) => n.type === "video")) {
      addNext(assetsNode, "video", -50); // no video node yet — expand one
    }
    mediaref.putKey(assetRegistry.firstFrames, slot, frameRef); // video nodes alias this map
    ctx.refreshType("video");
    ctx.persist();
    toast(`已设为该镜头视频首帧（来自资产 v${frameRef.version}）`);
  },
  // 版本选择器（TASK-048 第3步）：浏览槽位历史版本 / 回切当前版本
  openVersions: (node, slot) => openVersionPicker(node, slot),
  // M3 — Asset Registry helpers:
  // the M2 shotId a media key PROVABLY belongs to (unique across all drafts),
  // else null; write sites stamp it on new Assets, never guessed by index
  shotIdForKey: (key, domain) =>
    assetlib.shotIdForKey(
      engine.nodes.filter((n) => n.type === "scriptgen").map((n) => n.versions || []),
      key,
      domain,
    ),
  // composed finals: registry-owned records, url view for every consumer
  finalUrls: () => assetlib.finalUrls(assetRegistry),
  addFinal: (url) => assetlib.addFinal(assetRegistry, url),
  // M5 — Generation Registry helpers. startGeneration freezes the inputs /
  // prompt / model / target at LAUNCH; complete/fail update the SAME record by
  // generationId and NEVER re-derive inputs — so a result landing after the
  // active Shot or image changed keeps the lineage it launched with. targetId
  // is a canonical creativeShotId (never a slot).
  startGeneration: (entry) => {
    const rec = genlib.startGeneration(generationRegistry, {
      ...entry,
      createdAt: (entry && entry.createdAt) || new Date().toISOString(),
    });
    ctx.persist();
    return rec;
  },
  completeGeneration: (generationId, resultAssetIds) => {
    const g = genlib.completeGeneration(generationRegistry, generationId, resultAssetIds);
    ctx.persist();
    return g;
  },
  failGeneration: (generationId, status) => {
    const g = genlib.failGeneration(generationRegistry, generationId, status);
    ctx.persist();
    return g;
  },
  persist: () => {
    if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph());
  },
  // READ-ONLY snapshot of current workflow/node state for the Production
  // workspaces (this checkpoint: expose, don't migrate). Ownership stays on
  // the nodes / project mirrors — same merge pattern as collectMedia().
  prodData: () => {
    const sg = engine.nodes.find((n) => n.type === "scriptgen");
    const cur = sg && (sg.versions || []).find((x) => x.v === sg.cur);
    return {
      draftShots: ctx.project.draftShots || null,
      lockedPlan: ctx.project.lockedPlan || null,
      // shot version standing lives ONLY on the scriptgen node — summarized,
      // not copied: rows of the CURRENT version for display fallback
      shotVersions: sg
        ? { count: (sg.versions || []).length, cur: sg.cur, state: sg.state, rows: (cur && cur.shots) || null }
        : null,
      // connected mode may hold the project's REAL locked shot records
      realShots: ctx.project.shots && ctx.project.shots.real ? ctx.project.shots.v1 : null,
      // M3: same shapes as before, now read straight off the Asset Registry
      assetUploads: assetRegistry.images,
      media: ctx.collectMedia(),
      firstFrames: assetRegistry.firstFrames,
      finals: assetlib.finalUrls(assetRegistry),
      paidOps: ctx.paidOps || {},
      // M6: the production structure document (episodes/scenes/shot refs) —
      // read it only; writes go through ctx.production.
      production: productionDoc,
      // M5/M8: generation provenance for the studio (AI Director history,
      // per-shot lineage) — read-only; writes stay on ctx.*Generation.
      generations: generationRegistry,
      // M9: the story development chain — read-only; writes via ctx.story.
      story: storyDoc,
      // TASK-051A: the AI Director's Production Plan / Asset Inbox DERIVE from
      // existing state and own nothing. They need the whole Asset Registry
      // (finals/displaced/unresolvedPaid, not just the chain maps) and the
      // per-episode timelines. Exposed READ-ONLY here, exactly like the other
      // registries above — no second copy, no new document.
      assets: assetRegistry,
      timelines: timelinesDoc,
    };
  },
  // paid-op status projection (生成情况) — refreshed after paid actions AND
  // auto-polled while any op is in flight (TASK-048 第2步; read-only)
  paidOps: {},
  paidOpsAll: [],
  loadPaidOps: async () => {
    if (!CONNECTED) return;
    try {
      const ops = await gw.paidOps(PROJECT_NAME);
      ctx.paidOpsAll = ops;
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
    updateQueueBar();
    schedulePaidPolling();
  },
};

// --- paid-op auto polling + global queue bar (TASK-048 第2步, read-only) ---
// While a paid generation is running (reservation held) or the batch loop is
// busy, refresh the projection every POLL_MS; otherwise the timer stops — no
// idle polling. Everything here consumes existing read-only endpoints only.
const PAID_POLL_MS = 12_000;
let paidPollTimer = null;
function batchBusyNode() {
  return engine.nodes.find((n) => n._batchBusy);
}
function schedulePaidPolling() {
  const busy = hasInflight(ctx.paidOpsAll) || !!batchBusyNode();
  if (busy && paidPollTimer === null) {
    paidPollTimer = setInterval(() => ctx.loadPaidOps(), PAID_POLL_MS);
  } else if (!busy && paidPollTimer !== null) {
    clearInterval(paidPollTimer);
    paidPollTimer = null;
  }
}
function updateQueueBar() {
  const busy = batchBusyNode();
  renderQueueBar(
    $("#paidqueue"),
    { ops: PAID ? ctx.paidOpsAll : [], batchMsg: busy ? busy._batchMsg : "" },
    {
      onJump: () => {
        // the ops belong to the video stage — open its node detail
        const vn = engine.nodes.find((n) => n.type === "video");
        if (!vn) { toast("画布上还没有视频节点"); return; }
        engine.panTo(vn.id);
        openDetail(vn);
      },
    },
  );
}
ctx.wizard = createWizard({ estimate: { open: (o) => ctx.estimate(o) }, getProject: () => ctx.project, refresh: (n) => engine.refreshBody(n) });
ctx.shotEditor = createShotEditor({ toast });

// --- Production ⇄ Workflow views (creator-facing shell vs node canvas) ------
// Both are views over the SAME state (scriptDoc + engine graph) — switching
// only toggles display and re-renders the surface being entered, so nothing
// is ever lost. Production is the default creator-facing area.
const production = createProduction(() => ctx);
// Workflow · 生成溯源 — a READ-ONLY view over the same registries (TASK-054).
// It derives its graph fresh on every render, so it can never hold a stale or
// second copy of provenance.
const wfGraph = createWorkflowGraph(() => ctx);
wfGraph.mount($("#wfgraph"));
/** Hand off from a provenance node to the shot's production workspace: switch
 *  to the shot's OWN episode first (a shot from another episode would otherwise
 *  be selected under the wrong one), then open it. */
ctx.openShotInProduction = (shotId) => {
  // Ask BEFORE switching the episode: an unsaved buffer belongs to a shot in
  // the episode we would be leaving. Once the creator agrees, DROP the buffer
  // here — otherwise openShot() asks the same question again, and declining
  // that second prompt would leave the new episode active with the old shot's
  // edit still pending.
  if (production.hasUnsavedShotEdit()) {
    if (!window.confirm("镜头详情有未保存的修改，跳转将丢弃？")) return;
    production.discardShotEdit();
  }
  const owner = proddoc.sceneOfShot(productionDoc, shotId);
  if (owner && owner.episode.episodeId !== productionDoc.activeEpisodeId) {
    ctx.production.setActiveEpisode(owner.episode.episodeId);
  }
  setTopMode("prod");
  if (!production.openShot(shotId, "shots")) setTopMode("wf"); // refused — stay put
};
/** Whether the Production shell holds an unsaved shot edit (read-only probe for
 *  surfaces that can change what it is looking at). */
ctx.hasUnsavedShotEdit = () => production.hasUnsavedShotEdit();
/** Drop that buffer — ONLY after the caller has asked and been told to discard.
 *  A surface that changes the active episode must call this once the creator
 *  agrees, or the edit survives into an episode it does not belong to. */
ctx.discardShotEdit = () => production.discardShotEdit();
// Land a production-structure mutation: refused ops (false) change nothing and
// must not persist; successful ones persist + re-render the shell (hoisted —
// ctx.production above calls these only at runtime).
function refreshProductionView() {
  if (production.isVisible()) production.render();
}
function prodOp(ok) {
  if (ok) {
    ctx.persist();
    refreshProductionView();
  }
  return ok;
}
// Same landing for ops that return a freshly minted record (or null).
function prodNew(rec) {
  if (rec) {
    ctx.persist();
    refreshProductionView();
  }
  return rec;
}
/** Top-level mode switch: 制作 (Production) | 工作流 (Workflow) | 资产 (Assets).
 *  Production and Assets are both the studio shell — Assets simply opens the
 *  shell on its asset-library module — so only the workflow canvas is a
 *  genuinely different surface. */
// ADR-0053 — a project still living in the legacy repo scratch. It opens
// read-only; this banner is the ONLY way it becomes editable, and the creator
// has to press it: migration copies files on their disk.
let legacyProject = null;
function showLegacyBanner(name) {
  const bar = $("#legacy-bar");
  if (!bar) return;
  bar.hidden = !name;
  if (!name) return;
  bar.innerHTML =
    `<span class="lb-t">「${esc(name)}」的画布与媒体还在旧的仓库 scratch 目录里，` +
    `当前为只读。迁移到项目目录后才能编辑（旧文件会保留，不会删除）。</span>` +
    `<button class="btn sm primary" id="legacy-go">迁移到项目目录</button>`;
  const go = $("#legacy-go");
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "迁移中…";
    try {
      const r = await query.migrateLegacy(name);
      toast(`已迁移 ${r.files} 个文件到项目目录，正在重新载入…`);
      legacyProject = null;
      await enterCanvas(name, {}); // reload from the project-rooted copy
    } catch (e) {
      go.disabled = false;
      go.textContent = "迁移到项目目录";
      toast(`迁移失败：${e.message}`);
    }
  };
}

// Which Workflow view is showing: the provenance graph (default) or the node
// canvas. Both are Workflow — the graph explains what WAS generated, the canvas
// is where generation is executed (ADR-0052). Neither replaces the other.
let wfView = "graph";
function showWorkflowCanvas(on) {
  $("#viewport").style.display = on ? "block" : "none";
  $("#wf-hint").hidden = !on;
  $("#wfgraph").hidden = on;
  $("#wf-tab-graph").classList.toggle("on", !on);
  $("#wf-tab-canvas").classList.toggle("on", on);
  if (on) {
    renderStepbar(engine, $("#stepbar"), $("#entrybar")); // restores bar visibility
    ctx.refreshType("script"); // node summaries pick up workspace edits
  } else {
    $("#entrybar").style.display = "none";
    $("#stepbar").style.display = "none";
    wfGraph.render();
  }
}
function setTopMode(mode) {
  const highlight = (m) => {
    for (const [id, k] of [["#seg-prod", "prod"], ["#seg-wf", "wf"], ["#seg-assets", "assets"]]) {
      $(id).classList.toggle("on", k === m);
    }
  };
  if (mode === "wf") {
    highlight("wf");
    production.hide();
    $("#wf-tabs").hidden = false;
    showWorkflowCanvas(wfView === "canvas");
    return;
  }
  $("#viewport").style.display = "none";
  $("#wf-hint").hidden = true;
  $("#wf-tabs").hidden = true;
  $("#wfgraph").hidden = true;
  $("#entrybar").style.display = "none";
  $("#stepbar").style.display = "none";
  // the shell may REFUSE the switch (unsaved shot edits) — highlight what it
  // actually landed on, never what we asked for
  const landed = production.show(mode === "assets" ? "assets" : null);
  highlight(landed === "assets" ? "assets" : "prod");
}
function goProduction() { setTopMode("prod"); }
function goWorkflow() { setTopMode("wf"); }
$("#seg-prod").onclick = goProduction;
$("#seg-wf").onclick = goWorkflow;
$("#seg-assets").onclick = () => setTopMode("assets");
$("#wf-tab-graph").onclick = () => { wfView = "graph"; showWorkflowCanvas(false); };
$("#wf-tab-canvas").onclick = () => { wfView = "canvas"; showWorkflowCanvas(true); };
$("#proj-switch").onclick = () => views.goHome();

// Every locked plan a paid op could have been minted under: each scriptgen
// version keeps its own `locked` bridge, so a paid op from a PRIOR (re-locked)
// plan still resolves to its canonical creative shot (M4d).
function collectLockedPlans() {
  const out = [];
  for (const n of engine.nodes) {
    if (n.type !== "scriptgen" || !Array.isArray(n.versions)) continue;
    for (const v of n.versions) {
      if (v && v.locked && Array.isArray(v.locked.shots)) {
        out.push({ plan_version: v.locked.plan_version, shots: v.locked.shots });
      }
    }
  }
  return out;
}

// Resolve a SERVER shot_id → the CURRENT draft's target media slot (M4d) via
// the pure resolver: server shot_id → M4c bridge → creativeShotId → slot; a
// re-locked op resolves through its own prior plan's bridge; legacy → positional.
function resolveAdoptSlot(serverShotId) {
  return resolveAdoptTarget(serverShotId, ctx.project.draftShots || [], collectLockedPlans());
}

// --- adopt a paid staging clip into every video node's slot (ADR-0046 §3) ---
// M4d: the slot is resolved through canonical creative-Shot identity, never by
// sequence for M4 records; a result that can't be resolved is preserved with an
// explicit unresolved state (kept in the queue + recorded), never silently
// attached to another shot or discarded.
async function adoptPaidIntoSlot(serverShotId, taskId) {
  // preserve a paid result that can't be safely attached — recorded + kept in
  // the queue with an explicit state, never silently dropped or misattached.
  // (The staging clip is COPIED not moved server-side, so a preserved result is
  // always re-adoptable once its shot settles.)
  const preserve = (reason, creativeShotId, msg) => {
    assetlib.recordUnresolvedPaid(assetRegistry, {
      serverShotId, taskId, creativeShotId: creativeShotId || null, reason,
    });
    // best-effort persist — a storage/quota/serialization failure must not reject
    // the adoption promise and strand the caller's paid-op refresh; the in-memory
    // record + toast still inform the user, and the entry re-persists on the next
    // successful save
    try { ctx.persist(); } catch { /* keep the in-memory record; do not reject */ }
    toast(msg);
    return { adopted: false, unresolved: true };
  };
  // the shot a resolved target PROVABLY belongs to: the canonical creativeShotId
  // (M4 record), else the single draft shot occupying the slot (legacy). Null
  // when unprovable — which must NEVER pass the stability gate (a bare slot is
  // storage, not identity, so a legacy `undefined` owner is not "stable").
  const owner = (r, draft) =>
    r.creativeShotId ?? shotIdForSlot(buildShotSlotIndex(draft), r.slot);

  const draftBefore = ctx.project.draftShots || [];
  const before = resolveAdoptSlot(serverShotId);
  if (before.unresolved) {
    return preserve(
      before.reason, before.creativeShotId,
      before.reason === "creative-shot-not-in-current-draft"
        ? "付费成片对应的镜头已不在当前分镜：已保留在生成队列，未附加到任何镜头"
        : "付费成片身份无法桥接到镜头：已保留在生成队列，未附加到任何镜头",
    );
  }
  if (!before.slot) {
    // a legacy / unknown-shape op that maps to no current slot must NOT be
    // silently dropped — preserve it explicitly (decision #5)
    return preserve(
      "no-current-slot", before.creativeShotId,
      "付费成片无法定位到当前分镜槽位：已保留在生成队列，未附加到任何镜头",
    );
  }
  const ownerBefore = owner(before, draftBefore);
  let res;
  try {
    // an occupied slot gains a NEW version (origin=adopted) — never overwrites
    // an earlier take (TASK-048 第3步; the anti-double-pay guard stays on the
    // submit side, unchanged)
    res = await gw.adoptPaid(PROJECT_NAME, taskId, `video-${before.slot}`);
  } catch {
    return { adopted: false }; // artifact may not be fetched yet — status view still shows it
  }
  // The draft can be re-locked / regenerated WHILE this adopt is in flight
  // (M4d #3). The slot was resolved BEFORE the await — re-resolve now and
  // require the PROVABLE owning shot AND its slot to be unchanged before
  // registering the client media. If either moved (or is no longer provable),
  // the clip would attach to a slot reassigned to another shot → preserve as
  // unresolved instead, never misattach. (The server copied the clip to the
  // call-time slot; a preserved result leaves an inert, unreferenced orphan
  // version there — business identity lives ONLY in the client media ref, which
  // we do not write, so no shot gains the wrong clip.)
  const draftAfter = ctx.project.draftShots || [];
  const after = resolveAdoptSlot(serverShotId);
  const ownerAfter = after.unresolved ? null : owner(after, draftAfter);
  const stable = ownerBefore != null && ownerBefore === ownerAfter
    && !!after.slot && after.slot === before.slot;
  if (!stable) {
    return preserve(
      "shot-changed-while-in-flight", before.creativeShotId,
      "付费成片生成期间分镜已变化：已保留在生成队列，未附加到任何镜头",
    );
  }
  try {
    // stamp the PROVABLE creative identity: the resolved bridge id, else the
    // slot's owning shot (both provable, never guessed positionally)
    const cid = before.creativeShotId ?? ownerBefore;
    const ref = mediaref.refFromResponse(before.slot, "adopted", res, cid ?? null);
    mediaref.addVersion({ uploads: assetRegistry.videos }, before.slot, ref);
    // a task that once failed to resolve (recorded unresolved) has now adopted —
    // clear its stale marker so it isn't reported unresolved forever (M4d)
    assetlib.clearUnresolvedPaid(assetRegistry, taskId);
    // M5: reconcile the launching video Generation BY TASK id — this closes the
    // provenance loop whether the adopt runs in the original session or after a
    // reload (whose launch closure is gone), so a completed job is never left
    // permanently `generating`.
    genlib.completeGenerationByTask(generationRegistry, taskId, [ref.assetId]);
    engine.nodes.filter((n) => n.type === "video").forEach((n) => engine.refreshBody(n));
    ctx.persist();
    // M5: the adopted video Asset's id, so the launching Generation can link it
    return { adopted: true, assetId: ref.assetId };
  } catch {
    // a malformed response or storage/render failure must degrade to a plain
    // non-adopt (as when this lived inside the adopt try) — never reject the
    // promise and strand the caller's queue refresh
    return { adopted: false };
  }
}

// --- batch paid generation (ADR-0046): ONE total confirmation, per-shot
// quote-equality validation, abort on any blocker/mismatch ---
async function batchPaidGenerate(node) {
  const draft = ctx.project.draftShots || [];
  const media = ctx.collectMedia();
  const pending = draft.filter((s) => s.slot && !mediaref.slotUrl(media.video, s.slot));
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
    updateQueueBar(); // N/M progress in the global bar (data source: _batchMsg)
    schedulePaidPolling(); // keep the ⏳ projection live during each 1–2min submit
    let gen = null; // recorded just before this shot's submit; failed in catch
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
      // M5: SNAPSHOT provenance at envelope-build time — the draft shot in hand
      // carries its canonical creativeShotId (s.shotId, never the slot) and its
      // proven first-frame input Asset; these are the inputs the job will use.
      const frameRef = s.slot ? assetRegistry.firstFrames[s.slot] : null;
      const bp = tgt.params && typeof tgt.params === "object" ? tgt.params : null;
      const genSeed = {
        type: "video",
        targetType: s.shotId ? "shot" : null,
        targetId: s.shotId ?? null,
        inputAssetIds: frameRef && frameRef.assetId ? [frameRef.assetId] : [],
        promptSnapshot: bp && typeof bp.prompt === "string" ? bp.prompt : null,
        provider: bp && bp.provider ? String(bp.provider) : null,
        model: bp && bp.model ? String(bp.model) : null,
        parameters: { ...(bp || {}), operation_id: opId, task_id: envelope.params.task_id },
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
        // aborted BEFORE launch (no spend) → no generation is recorded
        toast(`批量中止于镜头 ${s.sequence}：${blockers[0] || "报价与确认单价不符"}（已完成 ${done} 段，未再扣费）`);
        break;
      }
      // record the generation just BEFORE the launch (submit) — a failed launch
      // still leaves a durable record (failed in catch), and the snapshot is
      // launch-time, not completion-time
      gen = ctx.startGeneration({ ...genSeed, status: "generating" });
      await gw.submit(PROJECT_NAME, envelope, pf.preflight_digest);
      done++;
      const r = await adoptPaidIntoSlot(shotId, envelope.params.task_id);
      // adopt reconciles the record BY TASK on success; ONLY the preserved-
      // unresolved case (shot changed in flight) completes with no result Asset.
      // A transient non-adopt (artifact not fetched yet) must stay `generating`
      // so a later adopt reconciles it by task — never mark a failure successful.
      if (gen && !r.adopted && r.unresolved) ctx.completeGeneration(gen.generationId, []);
    } catch (e) {
      // AMBIGUOUS: the submit threw, but the remote may already have accepted+
      // billed the job. Leave the record `generating` (never mark failed) so a
      // later adopt can reconcile a billed success by task — same rationale as
      // the single-shot path.
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
// view the image full-size / play the video with controls. Versioned slots
// (data-vslot/data-vnode) additionally get a history strip: browse every
// version and 回切 the current one (TASK-048 第3步). ---
const lbScrim = $("#lb-scrim");
function media(src, kind, cls = "") {
  if (kind === "video") {
    return cls
      ? `<video src="${esc(src)}" class="${cls}" muted preload="metadata"></video>`
      : `<video src="${esc(src)}" controls autoplay></video>`;
  }
  return `<img src="${esc(src)}" ${cls ? `class="${cls}"` : ""} alt="">`;
}
function kindOf(url) {
  return /\.(mp4|webm)$/i.test(url) ? "video" : /\.(mp3|wav)$/i.test(url) ? "audio" : "image";
}
function openLightbox(el) {
  const node = el.dataset && el.dataset.vnode ? engine.findNode(el.dataset.vnode) : null;
  if (node && el.dataset.vslot) { openVersionPicker(node, el.dataset.vslot); return; }
  const c = $("#lb-c");
  const src = el.currentSrc || el.src;
  if (!src) return;
  c.innerHTML = media(src, el.tagName === "VIDEO" ? "video" : "image");
  lbScrim.classList.add("show");
}
// 版本选择器：主视图显示所选版本，底部缩略图条列出全部历史版本；
// 「设为当前」回切画布槽位的当前版本（持久化，重载后仍生效）。
function openVersionPicker(node, slot, showVersion = null) {
  const e = mediaref.slotEntry(node.uploads, slot);
  if (!e || !e.history.length) { toast("该槽位还没有媒体"); return; }
  const shown = e.history.find((r) => r.version === (showVersion ?? e.current)) || e.history[e.history.length - 1];
  const kind = kindOf(shown.url);
  const main = kind === "audio"
    ? `<audio src="${esc(shown.url)}" controls autoplay style="width:min(80vw,560px)"></audio>`
    : media(shown.url, kind);
  const strip = e.history
    .map((r) => {
      const cur = r.version === e.current;
      const on = r.version === shown.version;
      const tag = `v${r.version}${cur ? " ✓当前" : ""}`;
      const tile = kindOf(r.url) === "audio" ? `<span class="vaud">🎵</span>` : media(r.url, kindOf(r.url), "vthumb");
      return `<div class="vitem${on ? " on" : ""}" data-show="${r.version}" title="${esc(r.origin || "upload")} · ${esc(r.digest ? r.digest.slice(0, 12) : "无摘要")}">${tile}<span class="vtag">${esc(tag)}</span>${cur ? "" : `<button class="vuse" data-use="${r.version}">设为当前</button>`}</div>`;
    })
    .join("");
  $("#lb-c").innerHTML = `<div class="vpick">${main}<div class="vstrip">${strip}</div></div>`;
  lbScrim.classList.add("show");
  $("#lb-c").querySelectorAll("[data-show]").forEach((d) => (d.onclick = (ev) => {
    if (ev.target.closest("[data-use]")) return;
    openVersionPicker(node, slot, Number(d.dataset.show));
  }));
  $("#lb-c").querySelectorAll("[data-use]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const v = Number(b.dataset.use);
    if (mediaref.setCurrent(node, slot, v)) {
      // setCurrent mutates the shared project registry (M3) — refresh every
      // same-type node so a duplicate reflects the version switch too
      ctx.refreshType(node.type);
      ctx.persist();
      toast(`已回切到 v${v}（旧版本全部保留）`);
      openVersionPicker(node, slot, v);
    }
  }));
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
// script/brief editing inside the detail window: write to the script document
// + mirror to the canvas copy (the modal textarea itself is left untouched to
// keep focus)
$("#dt-b").addEventListener("input", (e) => {
  if (!dtNode) return;
  const cl = e.target.classList;
  if (cl.contains("scripttext")) ctx.script.edit(e.target.value);
  else if (cl.contains("brieftext")) ctx.script.setBrief(e.target.value);
  else return;
  engine.refreshBody(dtNode);
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
    // The step/entry bars belong to the WORKFLOW CANVAS — not merely to "not
    // Production". A graph change while the provenance view is open (switching
    // episode re-renders nodes) would otherwise pop them over that surface,
    // which is hidden from Production's point of view but is not the canvas.
    if ($("#viewport").style.display !== "block") {
      $("#stepbar").style.display = "none";
      $("#entrybar").style.display = "none";
    } else {
      renderStepbar(engine, $("#stepbar"), $("#entrybar"));
    }
    if (canvasActive && PROJECT_NAME) persist.saveCanvas(PROJECT_NAME, serializeGraph());
  },
  onDeleteEdges: () => toast("已删除选中连线"),
});

// --- helpers ---
function createNode(type, x, y) {
  const nd = registry.createNodeData(type, x, y);
  attachAssetViews(nd); // fresh nodes present the SAME project registry
  return engine.addNode(nd);
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
  // per-episode scripts (M9): serialize every episode's document
  const scripts = Object.create(null);
  for (const k of Object.keys(scriptDocs)) scripts[k] = scriptdoc.serialize(scriptDocs[k]);
  return {
    v: CANVAS_SCHEMA_VERSION,
    project: PROJECT_NAME,
    // Story development chain (M9) — idea/outline/plan, project-level.
    story: storydoc.serialize(storyDoc),
    scripts,
    // Creator media is owned by the PROJECT registry (M3) — node-local
    // uploads/finals/firstFrames are alias views and are deliberately NOT
    // serialized, so no second durable media source of truth can form.
    assets: assetRegistry,
    // Generation provenance (M5) — top-level, parallel to assets, durable
    // independent of media bytes.
    generations: generationRegistry,
    // Production structure (M6) — episodes/scenes owning shot REFERENCES only.
    production: proddoc.serialize(productionDoc),
    // Per-episode timelines (M11) — asset REFERENCES only, never media bytes.
    timelines: timeline.serialize(timelinesDoc),
    nodes: engine.nodes.map((n) => ({
      id: n.id, type: n.type, x: n.x, y: n.y, state: n.state,
      text: n.text, versions: n.versions, cur: n.cur, pickSingle: n.pickSingle,
    })),
    edges: engine.edges.map((e) => ({ from: e.from, to: e.to, state: e.state })),
    pan: { x: engine.panX, y: engine.panY },
  };
}
/** Attach the registry's maps as this node's media views — same OBJECT, not a
 *  copy: reads see the registry, writes via mediaref.addVersion land in it. */
function attachAssetViews(nd) {
  if (nd.type === "assets") nd.uploads = assetRegistry.images;
  else if (nd.type === "video") {
    nd.uploads = assetRegistry.videos;
    nd.firstFrames = assetRegistry.firstFrames;
  } else if (nd.type === "audio") nd.uploads = assetRegistry.audio;
}
function restoreGraph(data) {
  engine.reset();
  seeded = false;
  // Per-episode script documents (M9): hydrate the whole map, then alias the
  // active episode's document (after production hydrates below).
  scriptDocs = Object.create(null);
  if (data && data.scripts && typeof data.scripts === "object" && !Array.isArray(data.scripts)) {
    for (const k of Object.keys(data.scripts)) {
      if (k) scriptDocs[k] = scriptdoc.createDoc(data.scripts[k]);
    }
  }
  // Story development chain (M9).
  storyDoc = storydoc.createStory((data && data.story) || null);
  scriptDoc = scriptdoc.createDoc();
  // Same for the Asset Registry (M3): hydrate BEFORE nodes attach their views.
  assetRegistry = assetlib.createRegistry((data && data.assets) || null);
  // Generation Registry (M5): hydrate from the same save (durable provenance).
  generationRegistry = genlib.createGenerationRegistry((data && data.generations) || null);
  // Production structure (M6): existing episode/scene ids survive verbatim; a
  // fresh/legacy canvas starts with the default single active episode.
  productionDoc = proddoc.createProduction((data && data.production) || null);
  // Per-episode timelines (M11).
  timelinesDoc = timeline.createTimelines((data && data.timelines) || null);
  // Breakdown proposals are PER-PROJECT transient review state: cards derived
  // from another project's script must never be appliable here, and a switch
  // mid-run must not leave a stuck "running" guard. (The in-flight run's
  // stale check compares productionDoc identity and will drop its result.)
  bibleProposals = null;
  syncActiveScript(); // alias follows the restored active episode
  if (!data || !Array.isArray(data.nodes) || !data.nodes.length) return false;
  if (!Object.keys(scriptDocs).length) {
    // pre-scriptDoc canvases persisted the script as node.text — migrate it
    // into the ACTIVE episode's unversioned buffer (M9: scripts are per-episode)
    const legacy = data.nodes.find((n) => n.type === "script" && typeof n.text === "string" && n.text);
    if (legacy && productionDoc.activeEpisodeId) {
      scriptDocs[productionDoc.activeEpisodeId] = scriptdoc.createDoc({ legacyText: legacy.text });
      syncActiveScript();
    }
  }
  const idMap = {};
  for (const sn of data.nodes) {
    if (!registry.get(sn.type)) continue;
    const nd = registry.createNodeData(sn.type, sn.x || 0, sn.y || 0);
    ["state", "text", "versions", "cur", "pickSingle"].forEach((k) => { if (sn[k] !== undefined) nd[k] = sn[k]; });
    // Media is NOT copied off the saved node: since v3 the registry owns it
    // (migration moved legacy node media there) and nodes only attach views.
    attachAssetViews(nd);
    if (sn.type === "scriptgen" && Array.isArray(nd.versions)) {
      // Connected mode: a scriptgen node's shot list must come from a REAL
      // agent draft (ADR-0042, draft:true), never a resurrected demo/fixture
      // snapshot — otherwise a canvas persisted in demo mode shows shots that
      // don't match the script. Drop non-draft generated versions; if none
      // survive, revert the node to "ready to generate".
      if (CONNECTED) {
        nd.versions = nd.versions.filter((x) => x && x.draft);
        if (!nd.versions.length) { nd.state = ""; nd.cur = 0; }
        else if (!nd.versions.some((x) => x.v === nd.cur)) { nd.cur = nd.versions[nd.versions.length - 1].v; }
      }
      // Back-compat: drafts persisted before slot ids got one per shot so
      // uploads can attach (an upload never matches across versions).
      nd.versions.forEach((ver) => {
        if (ver.raw) ver.raw.forEach((s, i) => { if (!s.slot) s.slot = `v${ver.v}-${i + 1}`; });
      });
      // Rehydrate downstream prefill from the restored current draft in BOTH
      // modes (M8): the Production studio renders from draftShots, and a demo/
      // static reload must restore it too — else a saved draft shows an empty
      // storyboard. (Pre-M8 this only mattered connected; demo saves carrying
      // raw drafts are legitimate now.)
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
  // 演示：一个进行到一半的真实项目 —— 故事/作品设定/剧集/分镜/媒体全部就位。
  // DEMO ONLY: seeds through the same domain APIs the UI writes with, so the
  // fixture can never drift from the schema (fixtures/demo-project.js).
  const seed = seedDemoProject({
    story: storyDoc,
    production: productionDoc,
    scripts: scriptDocs,
    assets: assetRegistry,
    generations: generationRegistry,
    timelines: timelinesDoc,
  });
  syncActiveScript();
  ctx.project.draftShots = seed.draftShots;
  const rows = seed.draftShots.map((s) => [
    String(s.sequence).padStart(2, "0"),
    `${s.title} — ${s.description}（${s.duration_seconds}s）`,
  ]);
  const s = createNode("script", 0, 40);
  const g = createNode("scriptgen", 360, 40);
  const a = createNode("assets", 720, 10);
  const v = createNode("video", 1060, -50);
  const au = createNode("audio", 1060, 150);
  g.state = "done";
  g.versions = [{
    id: mintId("sdv"), v: 1, shots: rows, draft: true, raw: seed.draftShots,
    origin: "generated", sourceScriptVersionId: null, basedOnDraftId: null,
  }];
  g.cur = 1; a.state = "done";
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
  scriptDocs = Object.create(null); // per-project; restoreGraph rehydrates
  scriptDoc = scriptdoc.createDoc();
  storyDoc = storydoc.createStory(null);
  timelinesDoc = timeline.createTimelines(null);
  const known = projects.loadRegistry(window.localStorage).find((p) => p.name === name);
  ctx.project = {
    ...FIX,
    id: name,
    name,
    // DECLARED asset location (prototype metadata, never a filesystem action)
    assetRoot: (opts.assetRoot != null ? opts.assetRoot : known ? known.assetRoot : "") || "",
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
  $("#proj-name").textContent = name;
  $("#proj-switch").title = ctx.project.assetRoot
    ? `资产位置：${projects.assetPathFor(ctx.project.assetRoot, name)}（点击返回项目列表）`
    : "点击返回项目列表";
  views.goCanvas();
  if (opts.seedDemo) {
    // A re-entry must rebuild the demo from scratch: these registries are
    // otherwise only reset by restoreGraph, which the seed path skips.
    engine.reset();
    seeded = false;
    assetRegistry = assetlib.createRegistry(null);
    generationRegistry = genlib.createGenerationRegistry(null);
    productionDoc = proddoc.createProduction(null);
    seedDemoGraph();
  } else {
    const res = await persist.loadCanvas(name);
    const doc = res.status === "ok" ? res.doc : null;
    if (!restoreGraph(doc)) { engine.reset(); seeded = false; engine.render(); }
    // Fail-safe load (corrupt save / newer schema / backend read failure):
    // persist has already blocked saves for this project so the stored
    // document stays recoverable — tell the creator why nothing autosaves.
    if (res.status !== "ok" && res.status !== "empty") {
      toast(
        res.status === "unsupported"
          ? `画布存档版本过新（v${res.version} > 本版本支持的 v${CANVAS_SCHEMA_VERSION}），已停用自动保存以保护存档`
          : "画布存档无法读取，已停用自动保存以保护原始数据（存档未被修改）",
      );
    }
    // ADR-0053: the document came from the legacy repo scratch. It opens
    // READ-ONLY — offer the one action that makes it editable, and never
    // migrate on our own initiative (it copies files on the creator's disk).
    if (res.legacy) legacyProject = name;
    showLegacyBanner(res.legacy ? name : null);
  }
  // DEMO ONLY: seed the example script into a VIRGIN document (never typed,
  // no versions) so what the textarea shows is real, consumable content —
  // display always equals the document; there is no render-time fallback.
  // A deliberately cleared buffer ("") is respected, not resurrected.
  if (!CONNECTED && scriptDoc.workingText == null && !scriptDoc.versions.length) {
    scriptdoc.editText(scriptDoc, ctx.project.script || "");
    ctx.refreshType("script");
  }
  canvasActive = true;
  if (PAID) ctx.loadPaidOps(); // 生成情况 projection for the video node
  // Default creator-facing view: Production (Script workspace). The workflow
  // canvas keeps its full state behind the ⛓ 工作流 toggle.
  goProduction();
}

// --- global bits ---
const views = createViews();

// --- landing: my projects + new project ---------------------------------- //
// The landing page shows exactly two things: the projects this creator has,
// and a way to make another one. Project creation is PROTOTYPE-LOCAL: it
// records a name and a DECLARED asset location (services/projects.js) and
// opens a canvas for it. It does NOT create a project directory — that is the
// backend/CLI's write path (ADR-0033+), and the dialog says so.

/** The asset root a new project defaults to.
 *  Connected: the backend's own --account-root, so the default is always the
 *  place this deployment actually writes into. Otherwise: the last root the
 *  creator used. Never a hardcoded platform path (AGENTS.md §3/§4). */
async function defaultAssetRoot() {
  if (CONNECTED) {
    const res = await query.fsDefault();
    if (res.ok && res.data.root) return res.data.root;
  }
  const m = query.meta();
  if (m && m.account_root) return m.account_root;
  const local = projects.loadRegistry(window.localStorage);
  const last = local.filter((p) => p.assetRoot).pop();
  return last ? last.assetRoot : "";
}

function landingThumb(kind, name) {
  const grad = kind === "demo"
    ? "radial-gradient(120% 120% at 30% 20%,#3a2a5e,#12183a)"
    : kind === "real"
      ? "radial-gradient(120% 120% at 40% 30%,#1e4a56,#12183a)"
      : "radial-gradient(120% 120% at 35% 25%,#28323f,#11161d)";
  const ic = kind === "demo" ? "🎬" : "📁";
  return `<div class="thumb" style="background:${grad}"><span style="font-size:30px;opacity:.75">${ic}</span></div>`;
}

function renderLanding(realNames) {
  const grid = $("#projgrid");
  [...grid.querySelectorAll(".pcard")].forEach((c) => c.remove());
  const local = projects.loadRegistry(window.localStorage);
  const cards = projects.projectCards({
    local,
    remote: CONNECTED ? realNames : [],
    // the seeded demo is always offered in demo mode — it is what makes the
    // studio explorable without any real data
    demo: CONNECTED ? null : { name: DEMO_PROJECT_NAME, assetRoot: "", openedAt: "" },
  });
  const note = $("#landing-note");
  if (note) {
    const m = query.meta();
    note.textContent = CONNECTED
      ? `已连接后端 · 资产根目录 ${m && m.account_root ? m.account_root : "未知"}`
      : "演示模式（无后端）· 画布与项目列表保存在本机浏览器";
  }
  for (const c of cards) {
    const b = document.createElement("button");
    b.className = "pcard";
    const tag = c.kind === "real" ? "真实项目" : c.kind === "demo" ? "演示项目" : "画布项目";
    const where = c.kind === "demo"
      ? "内置示例 · EP01 制作中"
      : c.assetRoot
        ? projects.assetPathFor(c.assetRoot, c.name)
        : "未记录资产位置";
    b.innerHTML =
      landingThumb(c.kind, c.name) +
      `<div class="cap"><div class="nm">${esc(c.name)}</div>` +
      `<div class="rw"><span class="chip${c.kind === "real" ? " ok" : c.kind === "demo" ? " gate" : ""}">${esc(tag)}</span></div>` +
      `<div class="pt" title="${esc(where)}">${esc(where)}</div></div>`;
    b.onclick = () => {
      if (c.kind !== "demo") projects.touchProject(window.localStorage, c.name, new Date().toISOString());
      enterCanvas(c.name, c.kind === "demo" ? { seedDemo: true } : {});
    };
    grid.appendChild(b);
  }
}

// --- new-project dialog ---------------------------------------------------- //
// The project location is CHOSEN, never typed: one 「选择…」 button opens a
// server-backed directory picker (ADR-0051 §4 — the browser cannot hand a real
// absolute path to the backend, so the backend lists directories for it).
const npScrim = $("#np-scrim");
const npName = $("#np-name");
const npRootEl = $("#np-root");
const npPath = $("#np-path");
const npNote = $("#np-note");
const npErr = $("#np-err");
let npRoot = ""; // the chosen location; "" until picked/defaulted

function npRefresh() {
  const name = projects.normalizeName(npName.value);
  npRootEl.textContent = npRoot || (CONNECTED ? "" : "（演示模式不写盘）");
  npPath.innerHTML = npRoot
    ? `项目将创建在 <b>${esc(projects.assetPathFor(npRoot, name || "<项目名>"))}</b>`
    : CONNECTED
      ? "先选择一个保存位置"
      : "演示模式：项目只存在于本机浏览器，不会写到磁盘";
  npErr.hidden = true;
}

function npFail(msg, focus) {
  npErr.textContent = msg;
  npErr.hidden = false;
  if (focus) focus.focus();
}

async function npOpen() {
  npName.value = "";
  npRoot = await defaultAssetRoot();
  npNote.textContent = CONNECTED
    ? "项目文件夹会由后端创建在这个位置。第一次使用一个新位置时会要求你确认一次。"
    : "演示模式没有后端，也就没有文件系统：这里不会建任何文件夹。要真正把项目建到磁盘上，用连接模式启动（./run-windows.ps1 -Connected）。";
  const pick = $("#np-pick");
  pick.disabled = !CONNECTED;
  pick.title = CONNECTED ? "" : "目录选择需要连接模式（后端）";
  npRefresh();
  npScrim.classList.add("show");
  npName.focus();
}

const npClose = () => npScrim.classList.remove("show");

async function npCreate() {
  const local = projects.loadRegistry(window.localStorage);
  const taken = local.map((p) => p.name).concat(CONNECTED ? REAL_NAMES : [DEMO_PROJECT_NAME]);
  const v = projects.validateName(npName.value, taken);
  if (!v.ok) return npFail(v.error, npName);
  if (CONNECTED && !npRoot) return npFail("请先选择项目保存位置", null);

  if (CONNECTED) {
    // the BACKEND creates the folder; it owns admission (deny-list, symlink,
    // writability) and asks once per new location
    let res = await query.createProject(v.name, npRoot, false);
    if (res.status === 409 && res.error && res.error.category === "root_unconfirmed") {
      if (!window.confirm(`${res.error.detail}\n\n确认使用这个位置？`)) return;
      res = await query.createProject(v.name, npRoot, true);
    }
    if (!res.ok) {
      return npFail((res.error && res.error.detail) || "创建失败", null);
    }
    REAL_NAMES = REAL_NAMES.concat([v.name]);
    projects.addProject(window.localStorage, {
      name: v.name, assetRoot: npRoot, now: new Date().toISOString(),
    });
    npClose();
    renderLanding(REAL_NAMES);
    ctx.toast(`已创建项目文件夹：${res.data.project_path}`);
    enterCanvas(v.name, { assetRoot: npRoot });
    return;
  }

  // demo mode: prototype-local only, and the note above says so
  const res = projects.addProject(window.localStorage, {
    name: v.name, assetRoot: npRoot, now: new Date().toISOString(),
  });
  if (!res.ok) return npFail(res.error, null);
  ctx.toast("演示模式：项目只记录在本机浏览器，没有写盘");
  npClose();
  renderLanding(REAL_NAMES);
  enterCanvas(res.name, { assetRoot: res.assetRoot });
}

$("#start-create").onclick = npOpen;
$("#np-x").onclick = npClose;
$("#np-cancel").onclick = npClose;
$("#np-ok").onclick = npCreate;
$("#np-pick").onclick = () => fsOpen(npRoot);
npName.oninput = npRefresh;
npName.onkeydown = (e) => { if (e.key === "Enter") npCreate(); };
npScrim.onclick = (e) => { if (e.target === npScrim) npClose(); };

// --- directory picker ------------------------------------------------------ //
const fsScrim = $("#fs-scrim");
const fsList = $("#fs-list");
const fsCur = $("#fs-cur");
const fsErr = $("#fs-err");
let fsPath = "";
let fsParent = null;

async function fsRender(path) {
  fsErr.hidden = true;
  const res = await query.fsList(path);
  if (!res.ok) {
    // The view still shows the PREVIOUS directory, so leaving the select
    // button live would hand back a folder the creator never asked for.
    // Disable it until a listing succeeds, and name the path that failed.
    fsErr.textContent = `${path}：${(res.error && res.error.detail) || "无法读取这个目录"}`;
    fsErr.hidden = false;
    $("#fs-ok").disabled = true;
    return;
  }
  $("#fs-ok").disabled = false;
  fsPath = res.data.path;
  fsParent = res.data.parent;
  fsCur.textContent = fsPath;
  $("#fs-up").disabled = !fsParent;
  fsList.innerHTML = res.data.entries.length
    ? res.data.entries
        .map((e) => `<button class="fs-row" data-fs="${esc(e.path)}"><span class="ic">📁</span><span class="nm">${esc(e.name)}</span></button>`)
        .join("") + (res.data.truncated ? `<div class="fs-empty">子文件夹过多，仅显示前 500 个</div>` : "")
    : `<div class="fs-empty">这个文件夹里没有子文件夹 — 可以直接选择它</div>`;
  fsList.querySelectorAll("[data-fs]").forEach((b) => (b.onclick = () => fsRender(b.dataset.fs)));
}

async function fsOpen(start) {
  if (!CONNECTED) {
    ctx.toast("目录选择需要连接模式（后端）——演示模式没有文件系统访问");
    return;
  }
  fsPath = "";
  $("#fs-ok").disabled = true; // nothing listed yet
  fsScrim.classList.add("show");
  await fsRender(start || (await defaultAssetRoot()));
}

const fsClose = () => fsScrim.classList.remove("show");
$("#fs-x").onclick = fsClose;
$("#fs-cancel").onclick = fsClose;
$("#fs-up").onclick = () => { if (fsParent) fsRender(fsParent); };
$("#fs-ok").onclick = () => {
  if (!fsPath) return;
  npRoot = fsPath;
  fsClose();
  npRefresh();
};
fsScrim.onclick = (e) => { if (e.target === fsScrim) fsClose(); };

engine.world.addEventListener("input", (e) => {
  // Script-slice inputs write to the DOMAIN document (no re-render — the
  // textarea being typed in must keep focus); ctx.script persists internally.
  const cl = e.target.classList;
  if (cl.contains("scripttext")) ctx.script.edit(e.target.value);
  else if (cl.contains("brieftext")) ctx.script.setBrief(e.target.value);
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
  REAL_NAMES = [];
  if (CONNECTED) {
    REAL_NAMES = await query.listProjects();
    DEFAULT_NAME = REAL_NAMES[0] || "draft";
    if (REAL_NAMES[0]) {
      PROJECT_NAME = REAL_NAMES[0];
      try { REAL_STANDING = realmap.mapStanding(await query.getQuery(REAL_NAMES[0], "budget")); } catch { REAL_STANDING = null; }
    }
  } else {
    DEFAULT_NAME = "local-draft";
  }
  renderLanding(REAL_NAMES);
  renderBudget();
}
boot();
