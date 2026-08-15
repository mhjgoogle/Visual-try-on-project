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
import * as query from "./services/query.js";
// TASK-072 §1.4: writes live in command.js; query.js keeps deprecated re-exports
import * as command from "./services/command.js";
import { submitCommand } from "./services/command.js";
// TASK-072 §1.4: the gateway's two-step write path came with them; the READ
// coordinates it used to sit beside (`getGenerationTarget` / `getLockTarget` /
// `paidOps`) are in query.js, because the split is 「会不会改东西」, not 「同一个流程」.
// A NAMED import, not `const { submitCommand } = command`: the destructure snapshots
// the namespace property at module-eval time, so an import cycle would make it
// silently `undefined` where the named binding throws a TDZ error instead
// (independent review).
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
import { dailiesModel } from "./ui/dailies.js";
import { shotDetailModel } from "./ui/storyboard.js";
import * as assetlibws from "./ui/assetlibws.js";
import { createWorkflowGraph } from "./ui/wfgraph.js";
import { renderStepbar } from "./ui/stepbar.js";
import { renderQueueBar, hasInflight } from "./ui/paidqueue.js";
import * as mediaref from "./workflow/mediaref.js";
import * as assetlib from "./workflow/assetlib.js";
import * as assetreg from "./workflow/assetreg.js";
import * as assetusage from "./workflow/assetusage.js";
import * as prodgraph from "./workflow/prodgraph.js";
import * as geninput from "./workflow/geninput.js";
import { referencePlan } from "./ui/refplan.js";
import * as genlib from "./workflow/genlib.js";
import * as skills from "./workflow/skills.js";
import * as skillrun from "./workflow/skillrun.js";
import * as skillapply from "./workflow/skillapply.js";
import * as actions from "./workflow/actions.js";
import * as promptdoc from "./workflow/promptdoc.js";
// TASK-064 Phase 2 / Phase 3 documents. Each is a pure domain module with its
// own sanitize/serialize pair; this file owns the instances, the persistence and
// the controllers, exactly like promptdoc above.
import * as refinterp from "./workflow/refinterp.js";
import * as refuse from "./workflow/refuse.js";
import * as shotctx from "./workflow/shotctx.js";
import * as ctxcache from "./workflow/ctxcache.js";
// TASK-073 §1.7: the fourteen ⚙ fields, their validation, and the two hard gates
import { SPEC_FIELD_BY_KEY, validateField } from "./workflow/deliveryspec.js";
// TASK-073 §1.8: controllers extracted from this file, one per domain
import { createLockController } from "./controllers/lockctl.js";
import { createTimelineController } from "./controllers/timelinectl.js";
// TASK-072 §1.5/§1.6: the three review layers and the five gates, as domain
import * as review from "./workflow/review.js";
import { g3TriggerFor, g3Retire } from "./workflow/gates.js";
import * as framebind from "./workflow/framebind.js";
import * as locksdoc from "./workflow/locks.js";
import * as shotaudio from "./workflow/shotaudio.js";
import * as subtitle from "./workflow/subtitle.js";
import * as roughcut from "./workflow/roughcut.js";
import * as runtime from "./services/runtime.js";
import { buildShotSlotIndex, slotForShotId, shotIdForSlot, resolveAdoptTarget } from "./workflow/shotmap.js";
import * as scriptdoc from "./workflow/scriptdoc.js";
import * as storydoc from "./workflow/storydoc.js";
import * as proddoc from "./workflow/proddoc.js";
import * as timeline from "./workflow/timeline.js";
import * as bibledoc from "./workflow/bibledoc.js";
import * as canondoc from "./workflow/canondoc.js";
import * as shotprod from "./workflow/shotprod.js";
import * as breakdown from "./workflow/breakdown.js";
// TASK-065: the creator-object-first surfaces. All three are PURE read models over
// documents this file already owns — none of them introduces a store.
import * as baseassets from "./workflow/baseassets.js";
import * as relgraph from "./workflow/relgraph.js";
import * as shotgraph from "./workflow/shotgraph.js";
import { compileEntityBasePrompt } from "./workflow/promptc.js";
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
// Why the capability catalog is not loaded, and the per-package load failures the
// backend reported (TASK-075 §1.4 / §1.7). Both are shown verbatim: a capability
// that failed to load must be VISIBLY unavailable with a reason, not absent.
let CATALOG_DETAIL = "能力目录尚未加载";
let CATALOG_PROBLEMS = [];
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

/** The Episode / Scene a Shot PROVABLY belongs to, from the production
 *  document's own scene→shotIds assignment (CP2 asset context links).
 *
 *  A shot that is not assigned to any scene resolves to `{episodeId: null,
 *  sceneId: null}` — the unassigned pool is a real, honest state, and picking
 *  "probably the active episode" would stamp a fabricated context onto every
 *  asset imported while an unassigned shot happened to be selected. */
function contextOfShot(shotId) {
  const out = { episodeId: null, sceneId: null, shotId: strOrNullId(shotId) };
  if (!out.shotId) return out;
  for (const ep of productionDoc.episodes || []) {
    for (const sc of ep.scenes || []) {
      if (Array.isArray(sc.shotIds) && sc.shotIds.includes(out.shotId)) {
        out.episodeId = ep.episodeId;
        out.sceneId = sc.sceneId;
        return out;
      }
    }
  }
  return out;
}

const strOrNullId = (x) => (typeof x === "string" && x ? x : null);

/** Action Layer result shape from a controller that answers true/false. A refusal
 *  carries the REASON: a dispatcher that reports `{ok:false}` with nothing to say
 *  leaves the caller reporting "failed" and the creator with no next step. */
const bool = (ok, reason) => (ok ? { ok: true } : { ok: false, error: reason });

/** Which registry domain a picked File belongs in — from its MIME type, which
 *  is also what the upload endpoint validates against (and magic-byte checks).
 *  Deliberately NOT from the file extension: the extension is user-controlled
 *  text, and CP2's rule is that semantics never come from a name. */
function mediaDomainOfFile(file) {
  const t = String((file && file.type) || "").toLowerCase();
  if (t.startsWith("image/")) return "images";
  if (t.startsWith("video/")) return "videos";
  if (t.startsWith("audio/")) return "audio";
  return "";
}

/** Ask the creator for ONE file. Resolves to the file, or to null when they
 *  cancel, so every caller can `if (!file) return`.
 *
 *  ONLY the browser's own `cancel` event ends it. A focus-return timer was
 *  tried as a second signal and removed again: the page can regain focus while
 *  the chooser is still open, and the timer then settles the promise as a
 *  cancellation that a later, real selection can no longer undo — it silently
 *  drops a file the creator did choose. The two failures are not equal. On a
 *  browser that never fires `cancel`, the promise stays pending and the gesture
 *  simply ends, having changed nothing and left nothing stale on screen; losing
 *  a chosen file loses real work. (`cancel` is supported by every browser this
 *  loopback prototype runs in.) */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.oncancel = () => resolve(null);
    input.onchange = () => resolve((input.files && input.files[0]) || null);
    input.click();
  });
}

/** The upload slug prefix each domain uses (the namespace the media files
 *  already live in — unchanged, so nothing has to be moved). */
/** The file-picker `accept` list for one declared Asset kind — derived from the
 *  domains that kind may legally be registered in (ADR-0061 决策 4), so a picker
 *  can never offer a file type the declaration would then refuse. */
/**
 * Grab ONE frame out of a video url and return it as a PNG File (TASK-064 §7).
 *
 * `pick: "last"` seeks to the very end of the clip; `"at"` seeks to
 * `timecodeMs`. Both are clamped to the clip's real duration — asking for 8.4 s
 * of a 6 s clip must produce the last frame, not a blank canvas.
 *
 * WHY THE CLIENT DOES THIS. The bytes are already in the browser (the creator is
 * looking at the clip), a `<video>` + `<canvas>` needs no ffmpeg on PATH, and the
 * result goes through the ORDINARY upload + registration path — so the frame is a
 * declared Asset like every other, on every machine the studio already runs on.
 *
 * Returns `{ file, timecodeMs, width, height }`. It REJECTS rather than returning
 * a blank image: a black frame silently registered as 「SH01 的尾帧」 would be
 * indistinguishable from a real one.
 */
function grabVideoFrame(url, { timecodeMs = null, pick = "last" } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    // same-origin (/api/uploads/…), so the canvas stays untainted and toBlob works
    v.crossOrigin = "anonymous";
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); v.src = ""; fn(arg); };
    const timer = setTimeout(() => done(reject, new Error("读取视频超时：无法提取帧")), 20000);
    v.onerror = () => done(reject, new Error("无法读取这条视频（文件可能已不在本地）"));
    v.onloadedmetadata = () => {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (!dur) { done(reject, new Error("这条视频没有可用的时长信息，无法定位帧")); return; }
      // the LAST frame is not `duration` exactly: seeking there lands past the
      // final sample in most containers and decodes nothing. One frame back at a
      // conservative 30 fps is the usual "last valid frame".
      const want = pick === "at" && Number.isFinite(timecodeMs)
        ? Math.min(Math.max(0, timecodeMs / 1000), Math.max(0, dur - 0.001))
        : Math.max(0, dur - 1 / 30);
      v.currentTime = want;
    };
    v.onseeked = () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) { done(reject, new Error("这条视频没有可读的画面尺寸")); return; }
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d").drawImage(v, 0, 0, w, h);
        const at = Math.round(v.currentTime * 1000);
        cv.toBlob((blob) => {
          if (!blob) { done(reject, new Error("帧编码失败")); return; }
          const file = new File([blob], `frame-${at}ms.png`, { type: "image/png" });
          done(resolve, { file, timecodeMs: at, width: w, height: h });
        }, "image/png");
      } catch (e) {
        // a tainted canvas throws here; report it rather than registering nothing
        done(reject, new Error(`无法读取画面像素：${e && e.message ? e.message : e}`));
      }
    };
    v.src = url;
  });
}

function acceptForKind(kind) {
  const domains = new Set(assetreg.domainsForKind(kind));
  const parts = [];
  if (domains.has("images")) parts.push("image/png,image/jpeg,image/webp");
  if (domains.has("videos")) parts.push("video/mp4,video/webm");
  if (domains.has("audio")) parts.push("audio/mpeg,audio/wav");
  // An unknown kind gets images rather than everything: fail narrow, and let the
  // declaration check produce the honest refusal.
  return parts.length ? parts.join(",") : "image/png,image/jpeg,image/webp";
}

function domainSlugPrefix(domain) {
  return domain === "videos" ? "video" : domain === "audio" ? "audio" : "assets";
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
// Skill Run Registry (CP3) — the durable record of every AI capability run:
// which skill at which version, on which runtime/executor, and how the creator
// judged the result. Provenance, NOT chat history, and never a data owner.
let skillRunRegistry = skillrun.createSkillRunRegistry(null);
// Production domain document (M6) — Project → Episodes → Scenes → Shots
// structure. Scenes reference shots by canonical creativeShotId; shot content
// stays on the scriptgen draft, media/provenance stay in their registries.
let productionDoc = proddoc.createProduction(null);
// Per-episode timelines (M11) — clips referencing assets by id, never bytes.
let timelinesDoc = timeline.createTimelines(null);
// Per-shot Prompt OVERRIDES (ADR-0061 决策 5). Only shots whose prompt the
// creator (or an applied Skill proposal) actually wrote live here; everything
// else uses the compiled prompt, which is a derivation and not stored.
let promptsDoc = promptdoc.createPrompts(null);
// --- TASK-064 Phase 2 / Phase 3 documents ---------------------------------- //
// Reference READINGS (ADR-0061 决策 4): what a video-style / motion / camera /
// performance reference says along six axes, so the prompt compiler can carry it.
// Keyed by referenceKey — a canonical Reference is one shared thing.
let refInterpDoc = refinterp.createInterpretations(null);
// TASK-066 §5: which SIDE of the chain each reference binding serves. Keyed by
// shot + referenceKey; ABSENT means 「按类型推导」, which is why an existing document
// needs no migration and compiles byte-identical prompts until a menu is touched.
let refUseDoc = refuse.createRefUse(null);
// Frame BINDINGS (§7): 上一镜尾帧 → 下一镜首帧, with the full source provenance.
// The EFFECTIVE start frame stays `assets.firstFrames[slot]`; this records where
// it came from, which that slot-level pointer never held.
let frameBindingsDoc = framebind.createFrameBindings(null);
// LOCKS (§50) for the objects with nowhere to put a flag of their own. Prompt /
// audio clip / frame binding locks live on their own documents — see locks.js.
let locksDoc = locksdoc.createLocks(null);
// Per-shot MULTI-TRACK audio (决策 6): dialogue / vo / ambience / sfx / foley /
// bgm clips with timing, gain and fades, plus the derived Shot Mix pointer.
let shotAudioDoc = shotaudio.createShotAudio(null);
// The per-episode SUBTITLE track (决策 6). Cues, not a rendered file.
let subtitlesDoc = subtitle.createSubtitles(null);
// 剧本拆解提案 (M8) — TRANSIENT review state, per session, never persisted:
// null | { status: "running"|"ready"|"failed", cards, error, source }.
// A reload lands on the confirmed bible; proposals are re-derivable any time.
let bibleProposals = null;
// --- TASK-067 documents (ADR-0064) ----------------------------------------- //
// Cached DERIVED CONCLUSIONS (§15 / 决策 3): asset recommendations, continuity
// summaries and prompt reviews, each keyed by the REVISION of the shot context it
// was drawn from. Never a copy of canon — only conclusions about it, which is why
// an entry can be checked for staleness instead of being trusted.
let ctxCacheDoc = ctxcache.createCache(null);
/** The fourteen ⚙ fields (TASK-073 §1.7). Empty until the creator sets them —
 *  every field absent is the honest state, and an absent field is never defaulted
 *  into a value that then passes a check. */
let deliverySpecDoc = {};
/** Review issues + decisions (系统合同 §6 / TASK-072 §1.5). Additive and optional,
 *  exactly like refInterp / frameBindings / ctxCache: a document written before this
 *  carries none of it and hydrates empty, so no schema version and no migration. */
let reviewsDoc = { issues: [], decisions: [] };
// The 「用于生成」 intent (ADR-0061 决策 3): `{ skillRunId, proposalId, shotId }`
// set ONLY when the creator presses that button, consumed by the next generation
// for that shot. Session-scoped and deliberately NOT derived — see
// ctx.skills.pendingOriginFor for why deriving it fabricated lineage.
let pendingOrigin = null;

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
    const tgt = await query.getGenerationTarget(PROJECT_NAME, shotId);
    const opId = command.newOperationId();
    const envelope = command.buildEnvelope(
      "submit-video-generation",
      tgt.target,
      { ...tgt.params, operation_id: opId },
      "cmd-" + opId,
    );
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
    const pf = await command.preflight(PROJECT_NAME, envelope);
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
          const receipt = await command.submit(PROJECT_NAME, envelope, digest);
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
    const tgt = await query.getLockTarget(PROJECT_NAME);
    // M4c bridge: send each shot's CREATIVE identity as a PARALLEL array (in
    // draft order), separate from the shot payload core consumes. The server
    // strips it before core and echoes it back onto each official record —
    // core's contract is untouched, the bridge is additive.
    const creativeShotIds = draft.map((s) => (typeof s.shotId === "string" && s.shotId ? s.shotId : null));
    const envelope = command.buildEnvelope(
      "lock-draft-plan",
      tgt.target,
      { ...tgt.params, shots, creativeShotIds },
    );
    const pf = await command.preflight(PROJECT_NAME, envelope);
    est.openLock(pf, {
      onConfirm: async (digest) => {
        toast("已确认，正在发布正式分镜（新版本，不覆盖旧版）…");
        try {
          const receipt = await command.submit(PROJECT_NAME, envelope, digest);
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
    /**
     * 从故事大纲的「主要角色概念」播下初始人物 (TASK-070).
     *
     * WHY IT EXISTS: 人物设定 sits between 故事大纲 and 分集规划 in the creative
     * spine, but the only route into it was 剧本拆解 — which reads an episode SCRIPT,
     * two steps later. The cast could not be filled until after the thing that
     * depends on it. 产品 2026-08-13: 「初始的时候是从故事大纲获取的」, and 剧本拆解
     * keeps refining afterwards — both paths, not one instead of the other.
     *
     * READ-ONLY derivation. `seedCharacter` below is the write, one row at a time,
     * after the creator confirms — so the outline still never writes canon by itself.
     */
    conceptSeeds: () => {
      const o = storydoc.approvedOutline(storyDoc) || storydoc.activeOutline(storyDoc) || null;
      const concepts = o && o.outline ? o.outline.characterConcepts : [];
      return {
        // WHICH outline version they came from — the creator is entitled to know
        // whether they are seeding from the approved one or a later draft
        version: o ? o.v : 0,
        approved: !!(o && storyDoc.approved === o.v),
        rows: bibledoc.characterSeedsFromConcepts(productionDoc, concepts),
      };
    },
    /** Create ONE character from a concept row. The name is what the creator
     *  confirmed in the field, not the heuristic split — the split only prefills. */
    seedCharacter: (name, identity) => {
      const n = String(name || "").trim();
      if (!n) { toast("先给这个角色一个名字"); return null; }
      const rec = bibledoc.addCharacter(productionDoc, n);
      if (!rec) return null;
      if (String(identity || "").trim()) {
        bibledoc.updateCharacterProfile(productionDoc, rec.characterId, { identity: String(identity).trim() });
      }
      ctx.persist();
      refreshProductionView();
      toast(`已从故事大纲创建角色「${n}」——档案可以继续补，剧本拆解之后还会自动补充`);
      return rec;
    },
    addCharacter: (name, tier) => prodNew(bibledoc.addCharacter(productionDoc, name, tier)),
    renameCharacter: (id, name) => prodOp(bibledoc.renameCharacter(productionDoc, id, name)),
    removeCharacter: (id) => prodOp(bibledoc.removeCharacter(productionDoc, id)),
    updateCharacterProfile: (id, fields) => prodOp(bibledoc.updateCharacterProfile(productionDoc, id, fields)),
    setCharacterVoice: (id, voice) => prodOp(bibledoc.setCharacterVoice(productionDoc, id, voice)),
    addCharacterState: (id, name) => prodNew(bibledoc.addCharacterState(productionDoc, id, name)),
    renameCharacterState: (id, sid, name) => prodOp(bibledoc.renameCharacterState(productionDoc, id, sid, name)),
    removeCharacterState: (id, sid) => prodOp(bibledoc.removeCharacterState(productionDoc, id, sid)),
    setCharacterStateOverrides: (id, sid, o) => prodOp(bibledoc.setCharacterStateOverrides(productionDoc, id, sid, o)),
    // TASK-057: a character may be created as a formal or a temporary (bit)
    // one, and promoted later without losing its identity or references
    setCharacterTier: (id, tier) => prodOp(bibledoc.setCharacterTier(productionDoc, id, tier)),
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
  // Project-level CANON controller (TASK-057 / ADR-0054): Relationships,
  // World Setting, canon revisions, Episode beats and the upstream version
  // stamp. Same posture as ctx.production / ctx.bible: the ONLY write path,
  // every accepted op persists + re-renders, a refused op changes nothing.
  // Transitions live in workflow/canondoc.js.
  canon: {
    // --- Relationship (first-class, exactly two characters) ---------------- //
    addRelationship: (a, b) => prodNew(canondoc.addRelationship(productionDoc, a, b)),
    removeRelationship: (id) => prodOp(canondoc.removeRelationship(productionDoc, id)),
    updateRelationship: (id, fields) => prodOp(canondoc.updateRelationship(productionDoc, id, fields)),
    /** 改方向 — swap which side is A. The two DIRECTIONAL facets travel with it
     *  (canondoc), so flipping the arrow can never leave 「A 怎么看 B」 describing
     *  the other direction. */
    swapDirection: (id) => prodOp(canondoc.swapRelationshipDirection(productionDoc, id)),
    /** 当前关系 — derived from the Episode Relationship Beats up to `episodeId`
     *  (default: the active episode). Never stored; see canondoc. */
    currentState: (id, episodeId = null) =>
      canondoc.relationshipCurrentState(productionDoc, id, episodeId || productionDoc.activeEpisodeId || null),
    // --- World Setting ------------------------------------------------------ //
    updateWorld: (fields) => prodOp(canondoc.updateWorld(productionDoc, fields)),
    // --- explicit canon REVISIONS (the only thing that bumps a version) ---- //
    confirm: (surface) => {
      const v = canondoc.confirmCanon(productionDoc, surface);
      if (!v) return 0;
      ctx.persist();
      refreshProductionView();
      toast(`已确认${canondoc.UPSTREAM_LABEL[surface] || surface}设定 v${v} — 下游剧集会显示「上游变化」，但不会被自动改写`);
      return v;
    },
    // --- Episode beats (Arc progression records) ---------------------------- //
    setTextBeats: (epId, kind, list) => prodOp(canondoc.setEpisodeTextBeats(productionDoc, epId, kind, list)),
    setCharacterBeat: (epId, cid, beat) => prodOp(canondoc.setEpisodeCharacterBeat(productionDoc, epId, cid, beat)),
    setRelationshipBeat: (epId, rid, rec) => prodOp(canondoc.setEpisodeRelationshipBeat(productionDoc, epId, rid, rec)),
    // --- upstream dependency truth ----------------------------------------- //
    /** Stamp this episode as based on the CURRENT upstream versions. Explicit:
     *  an upstream revision never re-stamps (or rewrites) an episode. */
    stamp: (epId) => {
      const ok = canondoc.stampEpisodeUpstream(productionDoc, epId, storyDoc);
      if (ok) {
        ctx.persist();
        refreshProductionView();
        toast("已记录本集所基于的上游版本");
      }
      return ok;
    },
    versions: () => canondoc.upstreamVersions(storyDoc, productionDoc),
    impact: (epId) => canondoc.episodeImpact(productionDoc, epId, storyDoc),
  },

  // ---------------------------------------------------------------------- //
  // 人物关系图 (TASK-065 §2) — READ ONLY. Nodes are real Characters resolved on
  // every derivation, so a rename in 人物 cannot leave a stale label on the graph
  // and nothing here can copy a character.
  // ---------------------------------------------------------------------- //
  relgraph: {
    model: (opts = {}) => relgraph.relationshipGraph(ctx.prodData(), opts),
  },

  // ---------------------------------------------------------------------- //
  // 基础生图 Prompt (TASK-065 §1 / §4) — a bible entity's own image prompt.
  //
  // REUSES promptdoc under a NAMESPACED key (`base:<kind>:<id>[|<stateId>]`, see
  // workflow/baseassets.js). Same append-only versions, same active pointer, same
  // 「回到自动编译」, same Lock — one implementation, so a base prompt cannot end up
  // with weaker version rules than a shot prompt.
  //
  // The COMPILED default comes from the one compiler (workflow/promptc.js), fed by
  // the one resolver (bibledoc.resolve*), so an entity's own card and the shot that
  // uses it can never describe the character differently.
  // ---------------------------------------------------------------------- //
  basePrompt: {
    key: (kind, entityId, stateId = null) => baseassets.basePromptKey(kind, entityId, stateId),
    /** The compiled prompt for one entity (optionally in one state). Returns
     *  `{ text, missing }`; `{ text: "", missing: [...] }` when the entity is gone. */
    compiled: (kind, entityId, stateId = null) => {
      const entity = kind === "character"
        ? bibledoc.findCharacter(productionDoc, entityId)
        : bibledoc.findLocation(productionDoc, entityId);
      if (!entity) return { text: "", missing: ["这个对象已不存在"] };
      const resolved = kind === "character"
        ? bibledoc.resolveCharacter(entity, stateId)
        : bibledoc.resolveLocation(entity, stateId);
      return compileEntityBasePrompt({
        kind,
        entity: resolved,
        tone: confirmedGenreTone(),
        // a location's look is a statement about the world before it is about the
        // place — the World Setting's 视觉基调 is a real input, not decoration
        worldTone: kind === "location" ? (productionDoc.world.visualTone || "") : "",
      });
    },
    /** The EFFECTIVE prompt + where it came from — a stored version overrides the
     *  compiled default, exactly like a shot prompt. */
    effective: (kind, entityId, stateId = null) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      const compiled = ctx.basePrompt.compiled(kind, entityId, stateId);
      if (!key) return { ...compiled, source: "compiled", version: 0, locked: false, compiled: compiled.text, key: null };
      const eff = promptdoc.effectivePrompt(promptsDoc, key, "image", compiled.text);
      return { ...eff, missing: compiled.missing, compiled: compiled.text, key };
    },
    entry: (kind, entityId, stateId = null) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      return key ? promptdoc.entryOf(promptsDoc, key, "image") : null;
    },
    save: (kind, entityId, stateId, text) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      if (!key) return 0;
      return ctx.prompt.save(key, "image", text, { origin: "manual" });
    },
    setActive: (kind, entityId, stateId, version) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      return !!key && ctx.prompt.setActive(key, "image", version);
    },
    useCompiled: (kind, entityId, stateId = null) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      return !!key && ctx.prompt.useCompiled(key, "image");
    },
    setLocked: (kind, entityId, stateId, on) => {
      const key = baseassets.basePromptKey(kind, entityId, stateId);
      return !!key && ctx.prompt.setLocked(key, "image", on);
    },
  },

  // ---------------------------------------------------------------------- //
  // 基础资产 (TASK-065 §1 / §4) — the ONE controller for a bible entity's
  // long-lived reusable media.
  //
  // EVERY WRITE GOES THROUGH AN EXISTING PATH: `ctx.assets.importReference` for
  // registration (上传 ≠ 保存文件 — ADR-0055) and `ctx.bible.*` for attachment. This
  // controller adds no store and opens no second upload path; it only decides WHICH
  // entity (or state) the registered asset is attached to.
  // ---------------------------------------------------------------------- //
  baseAssets: {
    model: () => baseassets.baseAssetsModel(ctx.prodData(), {
      promptOf: (kind, entityId, stateId) => ctx.basePrompt.effective(kind, entityId, stateId),
    }),
    one: (kind, entityId) => {
      const m = ctx.baseAssets.model();
      return baseassets.findBaseAssets(m, entityId);
    },
    /** The name to OFFER for a reference about to be registered — derived from the
     *  entity and the state the creator uploaded under (workflow/baseassets.js
     *  explains why this is a derivation and not a model call). */
    suggestName: (kind, entityId, stateId = null) => {
      const entity = kind === "character"
        ? bibledoc.findCharacter(productionDoc, entityId)
        : bibledoc.findLocation(productionDoc, entityId);
      if (!entity) return "";
      const st = stateId ? (entity.states || []).find((x) => x.stateId === stateId) : null;
      return baseassets.suggestReferenceName({
        entityName: entity.name,
        stateName: st ? st.name : null,
      });
    },
    /**
     * Register an uploaded file as this entity's (or state's) reference.
     *
     * `displayName` is what the creator CONFIRMED — the suggestion is offered by
     * the caller and may have been edited or replaced. Nothing is registered under
     * a name nobody accepted.
     *
     * ATTACHMENT IS PART OF THE SAME CALL. A registered asset that never reached
     * the character would be exactly the orphan the registration rule exists to
     * prevent — visible in the library, attached to nothing, and looking to the
     * creator like the upload failed.
     */
    uploadReference: async (kind, entityId, stateId, { file, displayName } = {}) => {
      const refKind = baseassets.BASE_REFERENCE_KIND[kind];
      if (!refKind) throw new Error(`未知对象类型：${kind}`);
      const picked = file || await pickFile("image/png,image/jpeg,image/webp");
      if (!picked) return null;
      // CHECK THE TARGET BEFORE THE BYTES GO ANYWHERE, and again after.
      //
      // The file dialog is open for as long as the creator takes, and the entity or
      // the state can be deleted in the meantime. Registering first and attaching
      // afterwards then leaves a registered upload attached to nothing — exactly the
      // orphan ADR-0055 exists to prevent, and exactly what the comment above this
      // controller claims cannot happen. Same rule as `importReference` itself,
      // which validates its declaration BEFORE uploading rather than after.
      //
      // The second check is not redundant: the first one closes the file-dialog
      // window, and the upload is itself a server round trip during which the same
      // deletion can land. It fails LOUDLY — the asset is registered and real, so
      // the honest report is 「已登记但没能挂上」 plus where to find it, never silence.
      const bad = missingBaseTarget(kind, entityId, stateId);
      if (bad) throw new Error(bad);
      const links = kind === "character" ? { characterId: entityId } : { locationId: entityId };
      const { ref } = await ctx.assets.importReference({
        kind: refKind,
        file: picked,
        links,
        displayName: displayName || null,
      });
      const gone = missingBaseTarget(kind, entityId, stateId);
      if (gone || !ctx.baseAssets.attach(kind, entityId, stateId, ref.assetId, { active: true })) {
        throw new Error(
          `${gone || "无法挂到这个对象上"}——文件已经登记为资产（${assetreg.derivedLabel(ref)}），` +
          "可以在「资产库」里找到它并手工绑定，没有丢失。",
        );
      }
      return ref;
    },
    /**
     * Attach an ALREADY REGISTERED asset (从资产库选择).
     *
     * A STATE'S references live in the state's own `overrides.referenceAssetIds`.
     * The state list is SELF-CONTAINED by domain rule (bibledoc sanitizes an active
     * pointer against the state's own list), so attaching to a state seeds the list
     * from what the state currently shows — otherwise the first state-level upload
     * would silently drop the inherited base references.
     */
    attach: (kind, entityId, stateId, assetId, { active = false } = {}) => {
      if (!assetId) return false;
      if (!stateId) {
        if (!ctx.bible.addReferenceAsset(entityId, assetId)) return false;
        if (active) ctx.bible.setActiveReferenceAsset(entityId, assetId);
        return true;
      }
      const cur = stateRefs(kind, entityId, stateId);
      if (!cur) return false;
      const ids = cur.ids.includes(assetId) ? cur.ids : [...cur.ids, assetId];
      return setStateRefs(kind, entityId, stateId, ids, active ? assetId : cur.active);
    },
    /** Move the ACTIVE pointer — 主图. Never deletes anything. */
    setActive: (kind, entityId, stateId, assetId) => {
      if (!stateId) return ctx.bible.setActiveReferenceAsset(entityId, assetId);
      const cur = stateRefs(kind, entityId, stateId);
      if (!cur || !cur.ids.includes(assetId)) return false;
      return setStateRefs(kind, entityId, stateId, cur.ids, assetId);
    },
    /** Detach a reference from this entity (or state). The ASSET is untouched: it
     *  stops being USED as this character's reference; it does not stop BEING a
     *  character reference (ADR-0055's declared-vs-derived rule). */
    detach: (kind, entityId, stateId, assetId) => {
      if (!stateId) return ctx.bible.removeReferenceAsset(entityId, assetId);
      const cur = stateRefs(kind, entityId, stateId);
      if (!cur) return false;
      const ids = cur.ids.filter((x) => x !== assetId);
      return setStateRefs(kind, entityId, stateId, ids, cur.active === assetId ? null : cur.active);
    },
    /** Release a state's own reference list so it INHERITS the character's again.
     *  Distinct from an empty list: 「跟基础设定一致」 and 「这个状态没有参考图」 are
     *  different facts and must not be reachable only by one of them. */
    inheritRefs: (kind, entityId, stateId) => {
      const entity = kind === "character"
        ? bibledoc.findCharacter(productionDoc, entityId)
        : bibledoc.findLocation(productionDoc, entityId);
      const st = entity && (entity.states || []).find((x) => x.stateId === stateId);
      if (!st) return false;
      const next = { ...st.overrides };
      delete next.referenceAssetIds;
      delete next.activeReferenceAssetId;
      return kind === "character"
        ? ctx.bible.setCharacterStateOverrides(entityId, stateId, next)
        : ctx.bible.setLocationStateOverrides(entityId, stateId, next);
    },
    /**
     * Upload a BASE VOICE sample for a character.
     *
     * It becomes an ordinary registered audio Asset declared `voice-reference` and
     * LINKED to the character. It deliberately does NOT touch `voice.voiceId`: that
     * field is the identity string local TTS passes to the engine, and overwriting
     * it with a media key would break dialogue generation for this character.
     */
    uploadVoice: async (characterId) => {
      if (!bibledoc.findCharacter(productionDoc, characterId)) throw new Error("这个人物不存在");
      const file = await pickFile("audio/mpeg,audio/wav");
      if (!file) return null;
      // CHECK AGAIN AFTER THE PICKER, BEFORE THE BYTES MOVE. The check above closes
      // nothing on its own: the dialog is open for as long as the creator takes, and
      // deleting the character during it made `importKey` register an audio asset
      // linked to nobody — an orphan, created by the very controller that promises
      // there are none (codex review round 4; the first fix only added a check
      // AFTER the upload, which reports the orphan instead of preventing it).
      if (!bibledoc.findCharacter(productionDoc, characterId)) throw new Error("这个人物已不存在——没有上传任何文件");
      const key = mintId("basevoice");
      const ref = await ctx.audio.importKey(key, null, file, null, "voice-reference");
      // SAME RULE AS uploadReference: the character can be deleted while the file
      // dialog is open or while the upload is in flight, and a sample linked to
      // nobody is an orphan. The take is real and registered by this point, so the
      // failure is reported with where to find it rather than swallowed.
      //
      // The LINK is stamped through `ctx.assets.update`, the ONE declaration-edit
      // path (it resolves the record and lets the record's own domain gate the
      // change), never by writing the registry record directly.
      if (!bibledoc.findCharacter(productionDoc, characterId)
        || !ctx.assets.update(ref.assetId, { links: { characterId } })) {
        throw new Error(
          "这个人物已不存在——音频已经登记为资产，可以在「资产库」里找到它，没有丢失。",
        );
      }
      return ref;
    },
    /**
     * Every registered audio asset that could serve as a base voice — for 「从资产库
     * 选择」.
     *
     * A take already linked to ANOTHER character is listed but marked `takenBy`, and
     * the panel offers no button for it. `links.characterId` is single-valued, so
     * pointing this character at it would REMOVE the other character's only
     * discoverable sample — a silent destruction of somebody else's base voice.
     * Sharing one sample between two characters would need a multi-valued link, i.e.
     * a schema change and a migration, which ADR-0063 declined for the same reason it
     * declined `links.stateId`. So the honest behaviour is: show it, name its owner,
     * and refuse — never take it away and never pretend it can be shared.
     */
    voiceOptions: (forCharacterId = null) => {
      const out = [];
      for (const key of Object.keys(assetRegistry.audio)) {
        const e = mediaref.slotEntry(assetRegistry.audio, key);
        if (!e) continue;
        for (const r of e.history) {
          if (!r || !r.assetId) continue;
          if (r.kind !== "voice-reference" && r.kind !== "dialogue" && r.kind !== "vo") continue;
          const owner = (r.links && r.links.characterId) || null;
          const takenBy = owner && owner !== forCharacterId ? owner : null;
          out.push({
            assetId: r.assetId,
            key,
            version: r.version,
            url: r.url || "",
            kind: r.kind,
            characterId: owner,
            takenBy,
            takenByName: takenBy ? nameOfChar(takenBy) : null,
            label: `${assetreg.derivedLabel(r)} · ${key} v${r.version}`,
            storageState: r.storageState || "local",
          });
        }
      }
      return out;
    },
    /**
     * Point a character at an EXISTING audio asset as its base voice.
     *
     * Re-declares it `voice-reference` and links it to the character. Returns
     * `{ ok, error }` rather than a bare boolean so the caller can say WHY.
     *
     * REFUSED when the take already belongs to a different character (see
     * `voiceOptions`) — re-linking would strip that character's only sample. Also
     * refused when the asset does not live in the audio domain: `ctx.assets.update`
     * gates the kind change against the record's own domain, so a picture can never
     * be declared somebody's voice.
     */
    useVoiceAsset: (characterId, assetId) => {
      if (!bibledoc.findCharacter(productionDoc, characterId)) {
        return { ok: false, error: "这个人物已不存在" };
      }
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      if (!hit) return { ok: false, error: "这个资产已不存在" };
      const owner = (hit.record.links && hit.record.links.characterId) || null;
      if (owner && owner !== characterId) {
        return {
          ok: false,
          error: `这条样本已经是「${nameOfChar(owner)}」的基础声音。一条样本只能属于一个人物——` +
            "改挂过来会让那个人物失去它。请另外上传一条，或先在那边解除。",
        };
      }
      const ok = ctx.assets.update(assetId, { kind: "voice-reference", links: { characterId } });
      return ok ? { ok: true } : { ok: false, error: "只有音频资产可以作为基础声音" };
    },
    /** Every registered image reference of a KIND — 「从资产库选择」 for a character
     *  or a location. Already-attached ones are marked rather than hidden, because a
     *  reference can legitimately serve two entities. */
    referenceOptions: (kind) => {
      const want = baseassets.BASE_REFERENCE_KIND[kind];
      return assetreg.listReferences(assetRegistry)
        .filter((r) => r.kind === want || r.kind === "external-reference")
        .map((r) => ({
          key: r.key,
          assetId: r.assetId,
          version: r.version,
          url: r.url || "",
          label: assetreg.derivedLabel(r),
          kind: r.kind,
          links: r.links,
          storageState: r.storageState || "local",
        }));
    },
  },

  // ---------------------------------------------------------------------- //
  // 当前 Shot Production Graph (TASK-065 §9) — READ ONLY, and built from the SAME
  // `shotDetailModel` the LEFT inspector reads, so the picture and the panel beside
  // it cannot name different references, frames or prompts.
  // ---------------------------------------------------------------------- //
  shotgraph: {
    model: (shotId) => {
      const pd = ctx.prodData();
      const detail = shotId ? shotDetailModel(pd, shotId) : null;
      // `review` and `nextShot` are the model's two CONTROLLER-backed inputs, and they
      // have to be supplied here — the model is pure and cannot reach for them.
      // Forgetting `nextShot` left every End Frame card with `nextShot: null`, so the
      // 「接给下一镜」 action could never appear: a feature that looked implemented and
      // was dead (codex review round 2). The 「built but no caller」 shape this codebase
      // keeps catching, in reverse.
      return shotgraph.shotProductionGraph(pd, shotId, detail, {
        review: shotId ? ctx.shot.review(shotId) : null,
        nextShot: shotId && ctx.frames.nextShotOf ? ctx.frames.nextShotOf(shotId) : null,
      });
    },
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
    // --- Creative Brief (TASK-057) ------------------------------------------ //
    // AUTOSAVE != VERSION: editing the brief only persists the WORKING DRAFT.
    // A formal revision exists solely because the creator asked for one.
    editBrief: (fields) => { storydoc.editBriefDraft(storyDoc, fields); ctx.persist(); },
    briefIsDirty: () => storydoc.briefIsDirty(storyDoc),
    activeBrief: () => storydoc.activeBrief(storyDoc),
    commitBrief: () => {
      const rec = storydoc.commitBrief(storyDoc, "manual", "");
      if (!rec) { toast("与当前版本没有差异 — 未创建新版本"); return null; }
      ctx.persist();
      refreshProductionView();
      toast(`已创建创意版本 v${rec.v}（旧版本保留；下游剧集会显示「上游变化」）`);
      return rec;
    },
    // --- 分集规划 手工修改 (TASK-069) --------------------------------------- //
    //
    // The same shape as the Creative Brief above, and for the same reason:
    // AUTOSAVE ≠ VERSION. Typing writes an unversioned DRAFT (persisted, so a
    // refresh mid-sentence loses nothing); a new plan version exists solely
    // because the creator asked for one.
    //
    // A plan version is immutable canon that every Episode records itself as
    // 「Based on 规划 vN」, so editing one in place would leave that baseline
    // pointing at content it no longer describes (ADR-0054 决策 6).
    planEntries: () => storydoc.effectivePlanEpisodes(storyDoc),
    planEditBase: () => storydoc.planEditBase(storyDoc),
    planDirty: () => storydoc.planDirty(storyDoc),
    nextPlanVersion: () => storydoc.nextPlanVersion(storyDoc),
    editPlanEntry: (episodeId, field, value) => {
      const ok = storydoc.editPlanEntry(storyDoc, episodeId, field, value);
      if (ok) ctx.persist();
      return ok;
    },
    savePlanDraft: () => {
      const v = storydoc.savePlanDraft(storyDoc);
      if (!v) { toast("与当前版本没有差异 — 未创建新版本"); return 0; }
      ctx.persist();
      refreshProductionView();
      // Deliberately explicit about what did NOT happen: the confirm pointer is
      // the gate that binds episodes, and a hand edit must not walk through it.
      toast(`已保存为规划 v${v}（手工修改）。旧版本保留；要让下游剧集改用它，还需在上面「确认」这一版`);
      return v;
    },
    discardPlanDraft: () => {
      const ok = storydoc.discardPlanDraft(storyDoc);
      if (ok) { ctx.persist(); refreshProductionView(); toast("已放弃手工修改，回到已保存的版本"); }
      return ok;
    },
    setActiveBrief: (v) => prodOp(storydoc.setActiveBrief(storyDoc, v)),
    restoreBriefDraft: (v) => {
      const ok = storydoc.restoreBriefDraft(storyDoc, v);
      if (ok) toast(`已把 v${v} 的内容取回工作草稿（版本链未改动；确认后才成为新版本）`);
      return prodOp(ok);
    },
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
        // TASK-057: recorded Arc beats are real creative content too. An episode
        // carrying them is NOT pristine — adopting it would retitle the
        // creator's work, and (see the baseline rule below) stamping it would
        // claim those beats are consistent with canon they never saw.
        && !Object.values(productionDoc.episodes[0].beats).some((x) => x.length)
          ? productionDoc.episodes[0]
          : null;
      let adopted = false;
      // TASK-057: confirming the plan is the creator's explicit act, so it MAY
      // record the upstream baseline (ADR-0054 决策 6) — but only for episodes
      // whose baseline is a PROVABLE fact right now:
      //  - one this confirmation just created: it is born from the current
      //    upstream, so "based on today's versions" is true by construction;
      //  - the pristine default episode this plan adopts: it carries no scenes,
      //    no script text and no beats, so there is no prior content that could
      //    have been built on anything else.
      // An episode that already existed keeps whatever baseline it had —
      // stamping it would assert it is consistent with canon it may never have
      // seen, i.e. exactly the guess 决策 6 / 要求 4 forbids.
      const baseline = [];
      for (const e of plan.episodes) {
        const existing = e.episodeId ? proddoc.findEpisode(productionDoc, e.episodeId) : null;
        if (existing) {
          if (e.title.trim() && existing.title !== e.title) proddoc.renameEpisode(productionDoc, existing.episodeId, e.title);
        } else if (pristine && !adopted) {
          adopted = true;
          e.episodeId = pristine.episodeId;
          if (e.title.trim()) proddoc.renameEpisode(productionDoc, pristine.episodeId, e.title);
          baseline.push(pristine.episodeId);
        } else {
          const ep = proddoc.addEpisode(productionDoc, e.title);
          e.episodeId = ep.episodeId; // explicit identity join, stamped once
          baseline.push(ep.episodeId);
        }
      }
      storydoc.confirmPlan(storyDoc, v);
      // stamped once the confirmation is complete, so the baseline is taken from
      // fully-applied state (the five recorded surfaces do not include the plan
      // pointer, so the order is not load-bearing — it is just the honest point
      // at which "this episode was established" is true)
      for (const id of baseline) canondoc.stampEpisodeUpstream(productionDoc, id, storyDoc);
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
    importKey: async (key, shotId, file, intent, kind = null) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法导入文件");
      // CHECK BEFORE UPLOADING: a declaration refused after the bytes are on
      // disk would leave exactly the orphan file this checkpoint forbids.
      const pre = assetreg.checkDeclaration("audio", { kind });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await query.uploadAssetImage(PROJECT_NAME, `audio-${key}`, file);
      const ref = mediaref.refFromResponse(key, "upload", res, shotId ?? null);
      // CP2: the caller states the audio KIND (对白 / 环境音 / 音效 / BGM). It is
      // not inferred from the key text — the key is an addressing detail, and
      // a caller that genuinely does not know passes null (→ needs review).
      const decl = assetreg.declare(ref, "audio", {
        kind,
        originalFilename: (file && file.name) || null,
        links: contextOfShot(shotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
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
        if (gen) {
          ctx.completeGeneration(gen.generationId, [ref.assetId]);
          ref.links.generationId = gen.generationId;
        }
      }
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(`已导入音频 · v${res.version || 1}（旧版本保留）${intent && intent.prompt ? " · 已记录生成溯源" : ""}`);
      return ref;
    },
    // mint a NEW pool chain and import its first take (ambience/BGM pools).
    // The POOL the creator opened states the kind — amb-… is 环境音, bgm-… is
    // BGM — so the declaration is what they asked for, not a name lookup.
    importPool: async (prefix, file, intent) => {
      const key = mintId(prefix); // e.g. amb-<uuid> / bgm-<uuid>
      const kind = prefix === "amb" ? "ambience" : prefix === "bgm" ? "bgm" : null;
      return ctx.audio.importKey(key, null, file, intent, kind);
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
      // CP2: a TTS take IS 对白, and its speaker is the character just verified
      // to have a fixed base voice — both facts, recorded at the write.
      assetreg.declare(ref, "audio", {
        kind: "dialogue",
        links: { ...contextOfShot(shotId), characterId: voiceMeta.characterId },
      });
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
      if (gen) {
        ctx.completeGeneration(gen.generationId, [ref.assetId]);
        ref.links.generationId = gen.generationId;
      }
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
  // TIMELINE — MOVED to src/controllers/timelinectl.js (TASK-073 §1.8).
  // Attached after this literal (`ctx.timeline = …`), with documents and session
  // values passed as GETTERS: they are module-level `let`s that project loading
  // reassigns, so capturing their values would leave the controller operating on the
  // previous project's timeline.
  // ---------------------------------------------------------------------- //
  // Film Skill controller (CP3 / ADR-0056) — the ONE way a capability runs.
  //
  //   Domain context → Skill → Runtime → structured Proposal
  //     → AI Director review → user Accept → canonical controller write
  //
  // The runtime NEVER writes canon. This controller records the run and holds
  // the Proposal; `accept()` marks it, and the caller then applies it through
  // the normal domain controllers. Nothing here can modify a document, so a
  // model's answer cannot become project data without a human decision.
  // ---------------------------------------------------------------------- //
  skills: {
    catalog: () => skills.SKILLS,
    /** Is a catalog loaded, and if not, why (TASK-075 §1.4)?
     *
     *  A panel must distinguish "the backend could not give us the packages"
     *  from "there are no capabilities". The first is a system state with a
     *  cause; the second would be a lie told with an empty list. */
    catalogState: () => ({
      installed: skills.catalogInstalled(),
      detail: CATALOG_DETAIL,
      problems: CATALOG_PROBLEMS,
    }),
    find: (skillId) => skills.findSkill(skillId),
    runtimes: () => runtime.RUNTIMES,
    executors: () => runtime.EXECUTORS,
    probe: () => runtime.probeExecutors(),
    configurationHint: (executorId) => runtime.configurationHint(executorId),
    runs: () => skillRunRegistry,
    stats: (skillId) => skillrun.skillStats(skillRunRegistry, skillId),
    /** An input key's human label. Here rather than in each panel so 「缺少必要输入」
     *  reads the same wherever it is reported. */
    inputLabel: (key) => skills.SKILL_INPUTS[key] || key,

    /**
     * The domain context for a skill, assembled from the CANONICAL documents.
     * Read-only: this builds the prompt's data, it never reaches back.
     *
     * TASK-067 §15 / ADR-0064 决策 1: a skill that declares any SHOT-SCOPED input
     * (`shotContext` / `assetCandidates` / `selectedShotImage` / `neighbourShots` /
     * `promptUnderReview`) is served from `ctx.shotctx` — the minimal projection of
     * ONE shot — rather than from the project-wide bag below. That is the whole of
     * this round's context-cost strategy: those capabilities never see every draft
     * shot, every reference, every asset and every generation just to answer a
     * question about one shot.
     *
     * `scope.shotId` names WHICH shot. Absent, the shot-scoped keys are absent too,
     * and `missingInputs` refuses the run — a shot-scoped capability run against no
     * shot would answer about whatever happened to be selected.
     */
    context: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return {};
      const prod = productionDoc;
      const ep = proddoc.activeEpisode(prod);
      const draft = ctx.project.draftShots || [];
      const view = ep ? proddoc.episodeView(prod, ep.episodeId, draft) : null;
      const available = {
        brief: storydoc.activeBrief(storyDoc) || storyDoc.brief.draft,
        outline: (storydoc.approvedOutline(storyDoc) || storydoc.activeOutline(storyDoc) || {}).outline || null,
        characters: prod.characters,
        relationships: prod.relationships,
        world: prod.world,
        episodePlan: (() => {
          const plan = storydoc.confirmedPlan(storyDoc);
          const entry = plan && ep ? plan.episodes.find((e) => e.episodeId === ep.episodeId) : null;
          return entry || null;
        })(),
        episodeScript: scriptdoc.currentText(scriptDoc),
        scenes: view ? view.scenes.map((s) => ({ sceneId: s.sceneId, title: s.title, shotIds: s.shotIds })) : [],
        shots: draft,
        references: assetreg.listReferences(assetRegistry).map((r) => ({
          key: r.key, kind: r.kind, name: assetreg.derivedLabel(r), version: r.version, links: r.links,
          // ADR-0061 决策 4: Reference Interpreter needs to see what has ALREADY
          // been read, or it re-reads references the creator settled on — and it
          // needs to know a reading is LOCKED, because proposing one that will be
          // refused wastes the run.
          interpretation: (() => {
            const reading = refinterp.activeReading(refInterpDoc, r.key);
            return reading ? { axes: reading.axes, version: reading.version, locked: reading.locked } : null;
          })(),
        })),
        assets: assetreg.listAssets(assetRegistry).map((a) => ({
          assetId: a.assetId, kind: a.kind, name: assetreg.derivedLabel(a),
          tags: a.tags, reusable: a.reusable, links: a.links,
        })),
        generations: generationRegistry,
        // --- POST-PRODUCTION context (ADR-0061 决策 6 / §55) ----------------- //
        // A post skill must address a CLIP or a CUE by id, so the context carries
        // the ids — an editing note that cannot be addressed cannot be applied,
        // and would come back as prose the creator has to re-do by hand.
        timeline: (() => {
          const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
          const nameOf = (sid) => {
            const s = ctx.shot.find(sid);
            return s ? (s.title || `镜头 ${s.sequence}`) : null;
          };
          return {
            episodeId: productionDoc.activeEpisodeId,
            settings: t.settings,
            durationSeconds: timeline.timelineDuration(t),
            clips: timeline.liveClips(t).map((c) => ({
              clipId: c.clipId,
              trackType: c.trackType,
              shotId: c.shotId,
              shotTitle: c.shotId ? nameOf(c.shotId) : null,
              assetId: c.assetId,
              assetVersion: c.assetVersion,
              startMs: Math.round(c.startTime * 1000),
              inMs: Math.round(c.trimIn * 1000),
              outMs: Math.round(c.trimOut * 1000),
              volume: c.volume,
              muted: c.muted,
              ...(c.trackType === "video" ? { transition: c.transition, transitionMs: c.transitionMs } : {}),
              locked: ctx.locks.is("timelineClip", c.clipId),
              // the OTHER takes it could be replaced with, so 「换成 v3」 can name
              // a real assetId rather than a version number nothing resolves
              //
              // BY TRACK TYPE (TASK-072 §1.9 缺陷 7). This used to look up the
              // shot's slot with no regard for the track, so an AUDIO clip was
              // handed the shot's VIDEO version chain — and `ctx.assets.chainOf`
              // searches images first, so a video clip could be offered its
              // first-frame IMAGE versions. Either way the Editing Director
              // proposes `replaceTimelineAsset` with an asset of the wrong domain
              // and the write is refused at domain validation, every time. The key
              // rules here are the SAME ones `ctx.timeline.activeFor` uses.
              alternatives: (() => {
                const entry = _clipChain(c.shotId, c.trackType);
                if (!entry) return [];
                return entry.history
                  .filter((v) => v.assetId && v.assetId !== c.assetId)
                  .map((v) => ({ assetId: v.assetId, version: v.version }));
              })(),
            })),
          };
        })(),
        shotAudio: (() => {
          const out2 = [];
          for (const shotId of Object.keys(shotAudioDoc)) {
            const resolved = ctx.shotAudio.resolved(shotId);
            if (!resolved.length) continue;
            const s = ctx.shot.find(shotId);
            out2.push({
              shotId,
              shotTitle: s ? (s.title || `镜头 ${s.sequence}`) : null,
              anchors: ctx.shotAudio.anchors(shotId),
              clips: resolved.map((c) => ({
                clipId: c.clipId, trackType: c.trackType, assetId: c.assetId,
                startMs: c.startMs, endMs: c.endMs, anchor: c.anchor, offsetMs: c.offsetMs,
                gainDb: c.gain, fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs,
                muted: c.muted, unresolved: c.unresolved, locked: c.locked,
              })),
            });
          }
          return out2;
        })(),
        subtitles: (() => {
          const t = subtitle.trackFor(subtitlesDoc, productionDoc.activeEpisodeId);
          return {
            episodeId: productionDoc.activeEpisodeId,
            version: t.version,
            style: t.style,
            generatedFrom: t.generatedFrom,
            overlaps: subtitle.overlaps(t),
            cues: t.cues.map((c) => ({
              cueId: c.cueId, startMs: c.startMs, endMs: c.endMs, text: c.text,
              speaker: c.speaker, shotId: c.shotId, origin: c.origin,
              locked: ctx.locks.is("subtitle", c.cueId),
            })),
          };
        })(),
      };

      // --- the SHOT-SCOPED half (TASK-067 §3, ADR-0064 决策 1) ------------- //
      //
      // Built ONLY when this skill declares a shot-scoped input, and only when the
      // caller named a shot. `build` is called at most once even though four keys
      // read from it, because it resolves the whole shot detail model.
      const shotId = scope && typeof scope === "object" && typeof scope.shotId === "string"
        ? scope.shotId
        : null;
      if (skills.isShotScoped(skill) && shotId) {
        const built = ctx.shotctx.build(shotId);
        const c = built.context;
        if (c) {
          available.shotContext = c;
          available.neighbourShots = (c.neighbours.previous || c.neighbours.next) ? c.neighbours : null;
          // `describedAs` is present whenever an image is: the required-input gate
          // judges by CONTENT, and `{assetId, version}` is all identity — an object
          // of nothing but ids would read as empty and make Video Prompt Director
          // refuse a shot that really does have a selected main frame.
          // WHAT THE FIRST FRAME LOOKS LIKE, in the only form this runtime can carry.
          //
          // The runtime sends TEXT and receives TEXT (ADR-0056 决策 2) — the picture
          // itself goes to the external image/video tool, not to the model writing the
          // prompt. But 「以所附图片为第 1 帧，保持完全一致」 is an assertion about an
          // image the writer has never seen (codex review round 3), and there IS a
          // textual answer on file: the prompt that produced that exact take.
          //
          // Honestly null for an imported frame with no generation record — we do not
          // describe a picture nobody wrote a prompt for.
          available.selectedShotImage = c.media.selectedShotImage
            ? (() => {
                const sel = c.media.selectedShotImage;
                const gen = sel.assetId
                  ? (generationRegistry || []).find(
                    (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(sel.assetId),
                  )
                  : null;
                const fromPrompt = gen && typeof gen.promptSnapshot === "string" && gen.promptSnapshot.trim()
                  ? gen.promptSnapshot
                  : null;
                return {
                  ...sel,
                  describedAs: `主帧图 v${sel.version}${sel.origin ? `（${sel.origin}）` : ""}`,
                  // the frozen prompt this take was generated from — what the picture
                  // was MADE to look like
                  fromPrompt,
                  ...(fromPrompt ? {} : { appearanceNote: "这一版主帧图没有生成记录（外部导入），无从描述它的实际画面——只能依据镜头设计与参考保持一致" }),
                };
              })()
            : null;
          const cand = ctx.shotctx.candidates(shotId);
          available.assetCandidates = cand;
          // WHICH prompt is under review is the caller's statement (`extra`), not a
          // guess: reviewing 「whichever one is non-empty」 would silently review the
          // image prompt when the creator asked about the video one.
          const reviewKind = extra && extra.reviewKind === "video" ? "video" : "image";
          const under = c.prompts[reviewKind];
          available.promptUnderReview = under && under.text
            ? { kind: reviewKind, version: under.version, text: under.text }
            : null;
        }
      }

      const out = {};
      for (const k of [...skill.inputs, ...skill.optionalInputs]) {
        if (k in extra) { out[k] = extra[k]; continue; }
        if (k in available) out[k] = available[k];
      }
      return out;
    },

    /**
     * WHICH canon a run of this skill reads, as ids (ADR-0059 要求 2).
     *
     * Derived from the SAME state `ctx.skills.context` assembles its inputs
     * from, so the recorded context and the prompt can never name different
     * episodes. A caller narrows it by passing `scope` (a shot-scoped action
     * passes its shotId); everything it does not name stays null.
     *
     * The episode is taken from the production document's ACTIVE episode
     * because that is genuinely what the context builder read — not as a guess.
     * A skill that reads no episode-level input at all (a project-wide one)
     * records no episode: it did not look at one.
     */
    scopeOf: (skillId, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return null;
      const keys = new Set([...skill.inputs, ...skill.optionalInputs]);
      // TASK-064: the post-production inputs are EPISODE-level by construction —
      // a timeline, a subtitle track and a shot-audio arrangement all belong to
      // one episode — so a run that reads any of them really did read an episode.
      // Leaving them out made an Editing Director run record no episode at all,
      // which is a run the provenance graph cannot place.
      //
      // TASK-067: a SHOT-SCOPED input is episode-level for the same reason —
      // `shotContext` projects the active episode's scene and shot, so a run that
      // read one really did read that episode. Omitting it here would leave every
      // Image Prompt Director run unplaceable on the provenance graph.
      const readsEpisode = ["episodePlan", "episodeScript", "scenes", "shots", "timeline", "subtitles", "shotAudio"]
        .some((k) => keys.has(k)) || skills.isShotScoped(skill);
      // The EPISODE is not the caller's to choose. `ctx.skills.context` builds
      // its inputs from the ACTIVE episode and nothing else, so honouring a
      // caller-supplied episodeId would record a context the prompt never read
      // — a lie that looks exactly like provenance.
      const s = scope != null && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
      // For a SHOT-SCOPED run the episode is the one that OWNS the shot — the same
      // derivation `ctx.shotctx.build` uses. Reading the active pointer here while
      // the context builder read the shot's own episode is exactly the disagreement
      // between record and prompt ADR-0059 exists to prevent (codex review).
      const shotOwner = skills.isShotScoped(skill) && typeof s.shotId === "string" && s.shotId
        ? proddoc.sceneOfShot(productionDoc, s.shotId)
        : null;
      const ep = shotOwner
        ? shotOwner.episode
        : readsEpisode ? proddoc.activeEpisode(productionDoc) : null;
      const episodeId = ep ? ep.episodeId : null;
      // A caller may NARROW within that episode. A scene or shot belonging to a
      // different one is dropped rather than recorded: the same inconsistency,
      // one level down.
      // Checked TOGETHER, not one at a time: a scene from S01 plus a shot from
      // S02 passes two independent membership tests and records a scene/shot
      // pairing that does not exist.
      const owns = (sceneId, shotId) => {
        if (!ep) return false;
        const scenes = ep.scenes || [];
        const scene = sceneId ? scenes.find((sc) => sc.sceneId === sceneId) || null : null;
        if (sceneId && !scene) return false;
        if (shotId) {
          const home = scene || scenes.find((sc) => (sc.shotIds || []).includes(shotId));
          if (!home || !(home.shotIds || []).includes(shotId)) return false;
        }
        return true;
      };
      // A LEVEL is recorded only when the skill actually reads that level. A
      // skill given only the outline never saw a shot, so recording one would
      // assert shot-level lineage the prompt cannot support — the same rule as
      // the episode above, one step down.
      const readsScene = keys.has("scenes") || skills.isShotScoped(skill);
      // `shotAudio` is per-shot data, so a run given it genuinely can be narrowed
      // to one shot — which is what makes a Sound Designer proposal for SH03
      // recorded as being about SH03 rather than about the whole episode. A
      // shot-scoped input is per-shot by definition (TASK-067).
      const readsShot = keys.has("shots") || keys.has("shotAudio") || skills.isShotScoped(skill);
      const wantScene = readsScene && typeof s.sceneId === "string" && s.sceneId ? s.sceneId : null;
      const wantShot = readsShot && typeof s.shotId === "string" && s.shotId ? s.shotId : null;
      const narrow = owns(wantScene, wantShot);
      // A SHOT-SCOPED run really did read the shot's own scene — `shotContext`
      // projects it — so the scene is DERIVED from the shot rather than left null.
      // Derived, not guessed: it is the scene that actually owns this shot, and a
      // shot the episode does not own has already been dropped by `owns`.
      const derivedScene = narrow && !wantScene && wantShot && skills.isShotScoped(skill) && ep
        ? ((ep.scenes || []).find((sc) => (sc.shotIds || []).includes(wantShot)) || {}).sceneId || null
        : null;
      const out = {
        episodeId,
        sceneId: narrow ? (wantScene || derivedScene) : null,
        shotId: narrow ? wantShot : null,
      };
      return out.episodeId || out.sceneId || out.shotId ? out : null;
    },

    /** The full task prompt — IDENTICAL for every runtime. Copying this into a
     *  web chat and running it locally ask exactly the same question.
     *
     *  `scope` must be the SAME one the run will use: a preview compiled without
     *  the shot would show the creator a different question from the one asked. */
    prompt: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return "";
      return skills.compilePrompt(skill, ctx.skills.context(skillId, extra, scope));
    },

    /** Which required inputs are missing. A skill with missing inputs REFUSES
     *  to run — an AI asked to storyboard with no scene produces something
     *  plausible and unrelated, which is worse than an honest refusal.
     *
     *  For a shot-scoped capability this is also the gate §8 relies on: with no
     *  selected main frame, `selectedShotImage` is absent and Video Prompt Director
     *  reports it as missing rather than writing an ungrounded prompt. */
    missing: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return [];
      return skills.missingInputs(skill, ctx.skills.context(skillId, extra, scope));
    },

    /**
     * Run a Skill and record the run. `executor` "manual" only OPENS the run
     * (the creator pastes the answer back via `submitManual`); a local executor
     * runs it now.
     */
    run: async (skillId, { executor = "manual", extra = {}, summary = null, scope = null } = {}) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return { ok: false, error: `未知能力 ${skillId}` };
      // A shot-scoped capability with no shot has nothing to read. Refused HERE with
      // the reason, rather than letting it run on an empty projection and answer
      // about a shot nobody named (TASK-067 §3).
      const shotScoped = skills.isShotScoped(skill);
      const scopeShotId = scope && typeof scope === "object" && typeof scope.shotId === "string"
        ? scope.shotId
        : null;
      if (shotScoped && !scopeShotId) {
        return { ok: false, error: "这个能力只针对一个镜头运行——先选一个镜头" };
      }
      const context = ctx.skills.context(skillId, extra, scope);
      const missing = skills.missingInputs(skill, context);
      if (missing.length) {
        return {
          ok: false,
          error: `缺少必要输入：${missing.map((k) => skills.SKILL_INPUTS[k] || k).join("、")}`,
        };
      }
      const exec = runtime.EXECUTOR_BY_ID.get(executor);
      const rec = skillrun.startRun(skillRunRegistry, {
        skillId: skill.skillId,
        skillVersion: skill.version,
        runtime: exec ? exec.runtime : "manual",
        executor,
        inputKeys: Object.keys(context),
        inputSummary: summary || (shotScoped && context.shotContext
          ? shotctx.summarize(context.shotContext)
          : null),
        // WHICH canon this run read, as ids (ADR-0059). Taken from the same
        // place `ctx.skills.context` read it from, so the record and the prompt
        // can never describe different episodes. A caller may narrow it (a
        // shot-scoped skill passes its shotId); anything it does not name stays
        // null, because a null level is a fact about the run's scope.
        context: ctx.skills.scopeOf(skillId, scope),
        // TASK-067 §3 / ADR-0064 决策 2: WHAT this run read, not just which level.
        // Taken from the very context object compiled into the prompt below, so the
        // record cannot describe a projection the prompt did not carry. Null for a
        // project-wide capability — it read no single shot, and inventing a trace
        // would claim a precision the run does not have.
        //
        // WHICH PROMPT A REVIEW READ is part of that trace, and it is the only place
        // it can live: the reviewer's answer does not restate it, and reading the
        // creator's currently-open tab at apply time would let an image review be
        // written into the video prompt.
        contextTrace: !shotScoped
          // TASK-072 §1.9 缺陷 8: an EPISODE-wide run needs a trace too. The
          // Editing Director is handed each clip's `alternatives`; without
          // recording them, `replaceTimelineAsset` accepted any registered asset of
          // the right domain, so an injected or hallucinated proposal could swap a
          // clip for ANY unrelated media in the project. Same shape and same
          // fail-closed rule as `candidateKeys` above — recorded at launch, because
          // that is when the permission was fixed.
          ? (context.timeline && Array.isArray(context.timeline.clips)
            ? {
                timelineAlternatives: Object.fromEntries(
                  context.timeline.clips.map((c) => [
                    c.clipId,
                    (Array.isArray(c.alternatives) ? c.alternatives : [])
                      .map((v) => v.assetId)
                      .filter((id) => typeof id === "string" && id),
                  ]),
                ),
              }
            : null)
          : context.shotContext
          ? {
              ...shotctx.traceOf(context.shotContext, {
                // WHICH candidates this run was allowed to pick from (决策 4). Recorded
                // at launch, because that is when the permission was fixed — and the
                // applier checks against it rather than against a fresh retrieval.
                candidateKeys: context.assetCandidates && Array.isArray(context.assetCandidates.candidates)
                  ? context.assetCandidates.candidates.map((c) => c.referenceKey)
                  : null,
              }),
              ...(context.promptUnderReview
                ? {
                    reviewedPromptKind: context.promptUnderReview.kind,
                    reviewedPromptVersion: context.promptUnderReview.version,
                  }
                : {}),
            }
          : null,
        createdAt: new Date().toISOString(),
      });
      if (!rec) return { ok: false, error: "无法建立运行记录" };
      const prompt = skills.compilePrompt(skill, context);
      if (executor === "manual") {
        // FREEZE the question. The creator copies it later — possibly after editing
        // the shot — and recompiling then would hand them a prompt that no longer
        // matches the context this run recorded (codex review round 4).
        rec.promptText = prompt;
        ctx.persist();
        // the run stays OPEN until the creator brings an answer back
        return { ok: true, run: rec, prompt, manual: true };
      }
      ctx.persist();
      const res = await runtime.runOnExecutor({ executor, prompt });
      if (!res.ok) {
        skillrun.failRun(skillRunRegistry, rec.skillRunId, res.kind, res.detail);
        ctx.persist();
        refreshProductionView();
        return { ok: false, error: res.detail, kind: res.kind, run: rec };
      }
      return ctx.skills._land(rec, skill, res.text, res.model);
    },

    /** Bring a MANUAL answer back. Same skill, same schema, same gate — only
     *  the executor differed. */
    submitManual: (skillRunId, text) => {
      const rec = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!rec) return { ok: false, error: "运行记录不存在" };
      // A run that has ALREADY landed is not open for another answer. Without
      // this, pasting a second (malformed) answer into a run that already holds
      // a good proposal would fail it and wipe the creator's result.
      // A manual run waits in `awaiting_input` — nothing is running, the system
      // is waiting for a person. `running` is still accepted so a record written
      // before v15 (and not yet migrated in memory) can still be answered.
      if (rec.status !== "awaiting_input" && rec.status !== "running") {
        return { ok: false, error: `这次运行已经是「${rec.status}」，不能再提交结果` };
      }
      // …and a LOCAL run is not a manual one. Pasting an answer into a run that
      // a local executor is still working on creates a race: whichever lands
      // second fails validation and clears the one that landed first.
      if (rec.executor !== "manual") {
        return { ok: false, error: `这次运行由「${rec.executor}」执行，不能手工提交结果` };
      }
      const skill = skills.findSkill(rec.skillId);
      if (!skill) return { ok: false, error: `未知能力 ${rec.skillId}` };
      return ctx.skills._land(rec, skill, text, null);
    },

    /** Validate an answer and land it as a Proposal — or as an honest failure.
     *  A non-conforming answer NEVER becomes a partially-kept proposal. */
    _land: (rec, skill, text, model) => {
      const read = skills.readSkillAnswer(skill, text);
      if (!read.ok) {
        skillrun.failRun(skillRunRegistry, rec.skillRunId, "invalid_output", read.error);
        ctx.persist();
        refreshProductionView();
        return { ok: false, error: read.error, kind: "invalid_output", run: rec };
      }
      // proposeRun REFUSES a run that is not `running`. Ignoring that refusal
      // would report success for a proposal that was never recorded, and the UI
      // would render something the document does not contain.
      const landed = skillrun.proposeRun(skillRunRegistry, rec.skillRunId, read.value, {
        model,
        at: new Date().toISOString(),
      });
      if (!landed) {
        return { ok: false, error: `这次运行已经是「${rec.status}」，结果未记录`, kind: "execution_error", run: rec };
      }
      ctx.persist();
      refreshProductionView();
      return { ok: true, run: rec, proposal: read.value };
    },

    /**
     * The origin stamp a production action carries when it is launched FROM a
     * run's proposal (ADR-0059 要求 3). Returns null for anything else.
     *
     * The caller must name the run — nothing here searches for "the proposal
     * that was probably behind this". A generation attributed by proximity
     * would read as a record of something that never happened.
     */
    originOf: (skillRunId) => {
      const r = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!r) return null;
      const proposalId = skillrun.proposalIdOf(r);
      // 「从这份提案发起」 requires a proposal the creator ACCEPTED. A run still
      // waiting for an answer has none; a rejected one launched nothing; and a
      // proposal with no id cannot be pointed at. Stamping any of those would
      // let a generation claim a provenance the records never support.
      if (!skillrun.isAccepted(r) || !proposalId) return null;
      return { skillRunId: r.skillRunId, proposalId };
    },

    /**
     * 「应用」 — write a proposal back to canon (ADR-0061 决策 3).
     *
     * The plan comes from `skillapply.planApply`, which knows WHICH canonical
     * surface each skill's answer belongs to and refuses the ones that have
     * none. Every action is then performed through the ORDINARY controller for
     * that surface, so a proposal cannot reach a document through a path that
     * skips the guards a hand edit goes through.
     *
     * The run is marked accepted only AFTER the write succeeds: a run marked
     * accepted with nothing applied would claim a decision took effect when it
     * did not.
     */
    applyProposal: (skillRunId, scope = {}) => {
      const run = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!run) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isPending(run)) {
        return { ok: false, error: `这次运行是「${run.status}」，没有待应用的提案` };
      }
      // The SCOPE the run recorded wins over whatever is selected now: applying
      // a shot-scoped proposal to a different shot than the one the run read
      // would attribute the answer to a context it never saw (ADR-0059).
      const recorded = run.context || {};
      const trace = run.contextTrace || {};
      const merged = {
        shotId: recorded.shotId || scope.shotId || null,
        genKind: scope.genKind === "video" ? "video" : "image",
        // TASK-067: which prompt a REVIEW was about comes from what the run really
        // read, never from what is on screen now (see `contextTrace` in `run`).
        reviewKind: trace.reviewedPromptKind === "video" ? "video" : "image",
        // …and WHICH references this run was allowed to recommend (ADR-0064 决策 4).
        // From the run's own record, so the permission is the one that was in force
        // when the answer was produced — not whatever a fresh retrieval returns now.
        candidateKeys: Array.isArray(trace.candidateKeys) ? trace.candidateKeys : null,
        // …and WHICH takes this run was allowed to swap each clip to
        // (TASK-072 §1.9 缺陷 8). Same rule, other surface: the alternatives the run
        // actually saw, not a fresh lookup — a version added since would otherwise
        // become retroactively "allowed".
        timelineAlternatives:
          trace.timelineAlternatives != null
          && typeof trace.timelineAlternatives === "object"
          && !Array.isArray(trace.timelineAlternatives)
            ? trace.timelineAlternatives
            : null,
      };
      const plan = skillapply.planApply(run.skillId, run.proposal, merged);
      if (!plan.ok) return plan;
      // EVERY action is attempted, and the outcome of each is reported.
      //
      // Aborting on the first failure was wrong in a way that only showed on a
      // retry: a multi-reference proposal would bind two references, fail on the
      // third, and leave the run un-accepted — so pressing 应用 again failed
      // immediately on the two bindings that had already landed, and the
      // remaining ones could never be applied at all (codex review round 1).
      //
      // So: an action that is ALREADY SATISFIED counts as done rather than as an
      // error (applying a proposal twice must be safe), a genuine failure is
      // collected and reported, and the run is accepted when anything landed.
      const done = [];
      const already = [];
      const failed = [];
      for (const act of plan.actions) {
        const res = ctx.actions.dispatch(act, {
          skillRunId: run.skillRunId,
          proposalId: skillrun.proposalIdOf(run),
        });
        if (res.ok) { done.push(act.action); continue; }
        if (res.satisfied) { already.push(act.action); continue; }
        failed.push(`${act.action}：${res.error}`);
      }
      if (!done.length && !already.length) {
        return { ok: false, error: failed.length ? failed.join("；") : "提案里没有任何可应用的内容" };
      }
      const parts = [];
      if (done.length) parts.push(`${done.length} 项已应用（${[...new Set(done)].join("、")}）`);
      if (already.length) parts.push(`${already.length} 项本来就已满足`);
      // The run is accepted ONLY when the proposal fully landed.
      //
      // Round 1 aborted on the first failure, which stranded the rest. The fix
      // for that swung too far and accepted the run whenever ANYTHING landed —
      // and `applyProposal` refuses a run that is no longer `proposed`, so the
      // failed items could never be retried once their prerequisite was fixed
      // (codex review round 2). A partial apply therefore leaves the run
      // PROPOSED: the actions that succeeded are idempotent (they now report
      // `satisfied`), so pressing 应用 again finishes the job instead of
      // re-doing it.
      if (failed.length) {
        return {
          ok: true,
          partial: true,
          detail: `${parts.join("；")}；${failed.length} 项失败，提案仍待处理（修好后可再按「应用」重试）：${failed.join("；")}`,
          failed,
        };
      }
      ctx.skills.accept(skillRunId);
      return { ok: true, partial: false, detail: parts.join("；"), failed };
    },

    /**
     * 「用于生成」 — accept the proposal and hand back the origin stamp the next
     * generation will carry (ADR-0061 决策 3 / TASK-064 §74).
     *
     * This is the half that makes the button real rather than decorative: the
     * accepted run's `{skillRunId, proposalId}` is remembered as the PENDING
     * ORIGIN, and the next generation launched for that shot freezes it into its
     * record — so the provenance graph can show that this generation was in fact
     * started from this proposal.
     */
    useForGeneration: (skillRunId) => {
      const run = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!run) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isPending(run) && !skillrun.isAccepted(run)) {
        return { ok: false, error: `这次运行是「${run.status}」，没有可用于生成的提案` };
      }
      if (skillrun.isPending(run) && !ctx.skills.accept(skillRunId)) {
        return { ok: false, error: "无法标记为已接受" };
      }
      const origin = ctx.skills.originOf(skillRunId);
      if (!origin) {
        return { ok: false, error: "这份提案没有可引用的身份（proposalId 未记录）" };
      }
      // The intent is remembered EXPLICITLY, keyed to the run the creator pressed
      // it on. See `pendingOriginFor` for why it is not derived.
      pendingOrigin = { ...origin, shotId: (run.context && run.context.shotId) || null };
      ctx.persist();
      refreshProductionView();
      return { ok: true, origin, shotId: pendingOrigin.shotId };
    },

    /**
     * The origin stamp a generation for `shotId` should carry, or null.
     *
     * ONLY an explicit 「用于生成」 produces one. An earlier revision derived it
     * instead — "the newest accepted run nobody has claimed" — which silently
     * included runs accepted by 应用 (a canon write, not a generation intent), so
     * an unrelated later generation could be stamped with a proposal that never
     * launched it (codex review round 1). That is a fabricated lineage, and a
     * fabricated lineage is worse than none because it looks like a record.
     *
     * Bound to the run's OWN recorded shot: a proposal accepted for SH03 must not
     * stamp a generation launched for SH07. A run whose scope genuinely was wider
     * than one shot (no recorded shotId) can stamp any shot's generation —
     * narrowing that would invent a limit the record does not state.
     *
     * KNOWN LIMIT, deliberately accepted: this intent is session-scoped, so a
     * reload between 「用于生成」 and the upload loses it and the creator presses
     * the button again. Persisting it would need its own schema field with its own
     * "was this consumed" bookkeeping; a lost convenience is a far smaller cost
     * than a wrong provenance record.
     */
    pendingOriginFor: (shotId) => {
      if (!pendingOrigin) return null;
      if (pendingOrigin.shotId && pendingOrigin.shotId !== shotId) return null;
      // A generation that already carries this origin has consumed it — an origin
      // describes ONE launch.
      const claimed = generationRegistry.some(
        (g) => g && g.origin && g.origin.skillRunId === pendingOrigin.skillRunId,
      );
      if (claimed) { pendingOrigin = null; return null; }
      return { skillRunId: pendingOrigin.skillRunId, proposalId: pendingOrigin.proposalId };
    },

    /** The creator ACCEPTS. This marks the run only — applying the proposal to
     *  canon is the caller's, through the normal domain controllers. */
    accept: (skillRunId) => {
      const r = skillrun.acceptRun(skillRunRegistry, skillRunId, new Date().toISOString());
      if (!r) return null;
      ctx.persist();
      refreshProductionView();
      return r;
    },
    reject: (skillRunId, reason) => {
      const r = skillrun.rejectRun(skillRunRegistry, skillRunId, new Date().toISOString(), reason);
      if (!r) return null;
      ctx.persist();
      refreshProductionView();
      return r;
    },

    /**
     * ABANDON a run that is still `running` (TASK-067).
     *
     * WHY THIS HAS TO EXIST: a manual run stays open until an answer comes back, and
     * an answer does not always come back — the creator changes their mind, or the
     * page is closed mid-run. Nothing could then move that run out of `running`, so it
     * sat in the panel's open-run slot forever and every later answer was matched
     * against it instead of against the operation just pressed. Found on the real
     * project, which had accumulated several.
     *
     * Recorded as a REAL terminal state (`execution_error` with the creator's reason),
     * not deleted: the run happened, it was asked, and it produced nothing. Deleting it
     * would leave only the flattering half of the history — the same rule that keeps
     * rejected proposals (ADR-0056 决策 6).
     */
    /**
     * REAL CANCEL — terminate a run the BACKEND owns (TASK-073 §1.3 / 验收 #7).
     *
     * `abandon` already told the creator to 「用『取消运行』终止它」 for anything not
     * executed manually, but no such entry point existed: the sentence pointed at
     * nothing. This is it.
     *
     * IT NEVER SETTLES THE RECORD ITSELF. A local executor is a real process, and
     * only `POST /api/runs/<id>/cancel` can prove it died. This calls that, and then
     * records ONLY what the backend confirmed:
     *
     *   cancelled   → the process tree is gone; mark it cancelled here too
     *   cancelling  → the kill was NOT confirmed; the run stays open and the real
     *                 reason (including any residual pid) is reported verbatim
     *   finished    → it completed before the request landed; the real outcome
     *                 stands and nothing is overwritten with 「已取消」
     *
     * Writing `cancelled` on an unconfirmed kill is exactly what 系统合同 §5.4
     * rule 3 forbids: it puts 「已取消」 on screen while the executor keeps running
     * and keeps spending.
     */
    cancel: async (skillRunId) => {
      const r = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!r) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isOpen(r)) {
        return { ok: false, error: `这次运行已经是「${r.status}」，没有可取消的东西` };
      }
      // A run the FRONT END owns has no process to kill — that is `abandon`'s job,
      // and routing it here would ask the backend about an id it never minted.
      const backendOwned = typeof r.runId === "string" && r.runId.startsWith("run-");
      if (!backendOwned) return ctx.skills.abandon(skillRunId, "创作者取消了这次运行");
      const at = new Date().toISOString();
      // park it in `cancelling` FIRST, so the row stops offering 「取消」 twice while
      // the request is in flight
      skillrun.cancelRun(skillRunRegistry, skillRunId, at, "创作者取消了这次运行");
      ctx.persist();
      refreshProductionView();
      const res = await runtime.cancelRun(r.runId, r.projectId || null);
      if (res.ok) {
        skillrun.confirmCancelled(skillRunRegistry, skillRunId, new Date().toISOString());
        ctx.persist();
        refreshProductionView();
        return { ok: true };
      }
      // NOT cancelled. The record stays open and says why — never a fabricated
      // terminal state. `finished` is not a failure of the cancel: the run simply
      // produced its real result first, and that result is the truth.
      ctx.persist();
      refreshProductionView();
      return {
        ok: false,
        error: res.finished
          ? res.detail
          : `未能确认终止：${res.detail}。这次运行仍停在「取消中」，不会被标成已取消。`,
        finished: !!res.finished,
      };
    },
    abandon: async (skillRunId, reason = "创作者放弃了这次运行") => {
      const r = skillrun.findRun(skillRunRegistry, skillRunId);
      if (!r) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isOpen(r)) {
        return { ok: false, error: `这次运行已经是「${r.status}」，不需要放弃` };
      }
      // ABANDON IS A CANCEL, not a failure (系统合同 §5.2 迁移表). Nothing went
      // wrong — the creator chose to stop. Recording it as `failed` put a real
      // decision into the same bucket as a crashed executor.
      // ONLY runs this page owns. A run executed by a local executor is owned
      // by the BACKEND, and stopping it means terminating a real process — which
      // only `POST /api/runs/<id>/cancel` can do. Marking it `cancelled` here
      // would put 「已取消」 on screen while the executor keeps running and
      // keeps spending (codex review, round 7).
      if (r.executor && r.executor !== "manual") {
        return {
          ok: false,
          error: `这次运行由「${r.executor}」执行，请用「取消运行」终止它——放弃只用于手工运行`,
        };
      }
      // A MANUAL RUN CAN STILL BE THE BACKEND'S. The manual fallback creates a
      // durable Run in `awaiting_input`, so settling it only on the canvas left
      // the two sides permanently disagreeing — and reconciliation would then
      // read the backend's still-open state (codex review, round 20).
      //
      // So the backend is asked first. A 404 means it never knew this run
      // (local/demo mode, or a purely front-end record), which is the case the
      // canvas genuinely owns; anything else must succeed there before it is
      // recorded here.
      // WHO OWNS THIS RUN is decided from what we know, not from a 404 (codex
      // review, round 23). A record that never reached the backend has no
      // `runId` of the backend's minting; anything else must be settled THERE
      // first, because only the backend can stop a real process.
      // A BACKEND-MINTED id starts with `run-`; the front end's own runs carry
      // a `skillrun-` id it minted itself and the backend has never heard of.
      // That is the knowable difference — not a 404.
      if (typeof r.runId === "string" && r.runId.startsWith("run-")) {
        const backend = await runtime.cancelRun(r.runId, r.projectId || null);
        if (!backend.ok && !backend.unknown) {
          return { ok: false, error: `后端未能取消这次运行：${backend.detail}` };
        }
      }
      const at = new Date().toISOString();
      skillrun.cancelRun(skillRunRegistry, skillRunId, at, reason);
      // …AND IT MUST REACH A TERMINAL STATE HERE.
      //
      // `cancelRun` parks a `running` record in `cancelling`, which is correct
      // when a real process has to be signalled and confirmed dead. This path
      // has no such process: these are runs the FRONT END owns (a manual run
      // waiting for an answer, or one whose page was closed mid-flight), so
      // nothing would ever arrive to complete the transition and the run would
      // sit in `cancelling` forever — reintroducing the exact stuck-open run
      // this control was added to clear (codex review, round 1).
      //
      // Confirming here is not the pretence §5.4 rule 3 forbids: that rule is
      // about claiming a SUBPROCESS died without checking. A backend-owned run
      // is cancelled through `POST /api/runs/<id>/cancel`, which does the real
      // termination and only then reports `cancelled`.
      skillrun.confirmCancelled(skillRunRegistry, skillRunId, at);
      ctx.persist();
      refreshProductionView();
      return { ok: true };
    },
  },
  // ---------------------------------------------------------------------- //
  // Per-shot Prompt versions (ADR-0061 决策 5).
  //
  // A shot with no entry has NO prompt of its own and the compiled one is in
  // force — which is the honest default, not a value someone typed. The moment
  // the creator edits, or an applied Skill proposal writes, a real version is
  // recorded and every later one appends beside it.
  // ---------------------------------------------------------------------- //
  prompt: {
    /** The effective prompt + where it came from. `compiled` is passed in by the
     *  caller (it is a derivation of the shot design, which this module does not
     *  own) so there is one compiler, not two. */
    effective: (shotId, kind, compiled) => promptdoc.effectivePrompt(promptsDoc, shotId, kind, compiled),
    entry: (shotId, kind) => promptdoc.entryOf(promptsDoc, shotId, kind),
    /** Record a new version. Returns the version number, or 0 when refused
     *  (a LOCKED prompt refuses everything that is not a manual edit — 决策 5). */
    save: (shotId, kind, text, opts = {}) => {
      const v = promptdoc.addVersion(promptsDoc, shotId, kind, {
        text,
        origin: opts.origin || "manual",
        at: new Date().toISOString(),
        skillRunId: opts.skillRunId || null,
        proposalId: opts.proposalId || null,
      });
      if (v) { ctx.persist(); refreshProductionView(); }
      return v;
    },
    setActive: (shotId, kind, version) => prodOp(promptdoc.setActive(promptsDoc, shotId, kind, version)),
    /** 「回到自动编译」 — the saved versions stay, they are just not in force. */
    useCompiled: (shotId, kind) => prodOp(promptdoc.useCompiled(promptsDoc, shotId, kind)),
    setLocked: (shotId, kind, on) => prodOp(promptdoc.setLocked(promptsDoc, shotId, kind, on)),
  },

  // ---------------------------------------------------------------------- //
  // Reference INTERPRETATION (ADR-0061 决策 4 / TASK-064 Phase 2 §21–§22).
  //
  // 「AI 解读输入」 stops being a label the moment a reading exists: the Prompt
  // compiler reads these and writes them into the effective prompt. Nothing here
  // infers a reading from a file — a reading has a human or a named Skill Run
  // behind it, always.
  // ---------------------------------------------------------------------- //
  refInterp: {
    reading: (refKey) => refinterp.activeReading(refInterpDoc, refKey),
    entry: (refKey) => refinterp.entryOf(refInterpDoc, refKey),
    /** Record a reading. Returns the version, or 0 when refused (a LOCKED
     *  reading refuses everything that is not a manual edit). */
    save: (refKey, axes, opts = {}) => {
      // WHAT IS BEING READ, recorded with the reading (TASK-072 §1.9 缺陷 3).
      // Resolved HERE from the registry rather than trusted from the caller: the
      // whole point is that the record describes the material that actually existed
      // at the moment of reading, so a later version swap can be reported as drift
      // instead of silently relabelling an old note as a new one.
      const chain = ctx.assets.chainOf(refKey);
      const cur = chain && Array.isArray(chain.list)
        ? chain.list.find((x) => x.current) || null
        : null;
      const v = refinterp.addReading(refInterpDoc, refKey, {
        axes,
        origin: opts.origin || "manual",
        at: new Date().toISOString(),
        skillRunId: opts.skillRunId || null,
        proposalId: opts.proposalId || null,
        basedOnAssetId: cur && cur.assetId ? cur.assetId : null,
        basedOnVersion: cur && Number.isInteger(cur.version) ? cur.version : null,
      });
      if (v) { ctx.persist(); refreshProductionView(); }
      return v;
    },
    setActive: (refKey, version) => prodOp(refinterp.setActive(refInterpDoc, refKey, version)),
    setLocked: (refKey, on) => prodOp(refinterp.setLocked(refInterpDoc, refKey, on)),
    /** The interpretation inputs for a shot — its bound INTERPRETATION-kind
     *  references, each with its active reading (or `read: false`). ONE
     *  derivation, shared by the prompt compiler, the Generation Input Set and
     *  the Inspector, so those three cannot disagree about what has been read. */
    forShot: (shotId) => refinterp.interpretationInputs(
      refInterpDoc,
      ctx.episode.referencesOfShot(shotId),
      assetreg.INTERPRETATION_KINDS,
    ),
  },

  // ---------------------------------------------------------------------- //
  // 参考用途 (TASK-066 §4 / §5) — 「这个参考服务主要画面，还是视频编排，还是两者」.
  //
  // The card's `⋮` menu writes here, and `referenceInputs` (ui/storyboard.js) reads
  // it when it splits the bound list for the two compilers — so a choice made in the
  // menu really changes what the Prompt says. Without that read it would be a
  // control that does nothing, which is the empty promise this codebase keeps
  // catching itself at.
  //
  // A choice equal to the role's own default is stored as NOTHING (see refuse.setUse):
  // 「按类型推导」 and 「恰好选了同一边」 must stay distinguishable.
  // ---------------------------------------------------------------------- //
  refUse: {
    USES: refuse.USES,
    USE_LABEL: refuse.USE_LABEL,
    USE_CHIP: refuse.USE_CHIP,
    /** Which sides this role may serve — from what the COMPILERS read, so the menu
     *  can never offer a switch the prompt compiler ignores (§5 「语义允许时」). */
    allowed: (role) => refuse.allowedUses(role),
    /** `{ use, source }` — `source` is "creator" or "role", so the card can say
     *  whether the creator set it or it was derived. */
    effective: (shotId, refKey, role) => refuse.effectiveUse(refUseDoc, shotId, refKey, role),
    /** The two groups the LEFT column renders. A `both` reference is in BOTH. */
    groups: (shotId) => refuse.groupsForShot(refUseDoc, shotId, ctx.episode.referencesOfShot(shotId)),
    set: (shotId, refKey, use, role) => prodOp(refuse.setUse(refUseDoc, shotId, refKey, use, role)),
    clear: (shotId, refKey) => prodOp(refuse.clearUse(refUseDoc, shotId, refKey)),
  },

  // ---------------------------------------------------------------------- //
  // Shot CONTEXT (TASK-067 §3 / §15 / ADR-0064 决策 1–4) — the minimal, traceable
  // context a shot-scoped capability reads, plus the deterministic candidate set a
  // recommender is allowed to pick from.
  //
  // THE POINT OF THIS CONTROLLER: it is the ONLY place a shot-scoped Skill's
  // context comes from. `ctx.skills.context` routes those capabilities here rather
  // than handing them the whole project, which is the entirety of this round's
  // token-cost strategy — there is no second knob.
  //
  // READ-ONLY except for the conclusion cache, which stores derivations ABOUT
  // canon and never canon itself.
  // ---------------------------------------------------------------------- //
  shotctx: {
    SCOPES: ctxcache.SCOPES,
    READINESS_ROLES: shotctx.READINESS_ROLES,

    /**
     * `{ context, trace }` for one shot, or `{ context: null, trace: null }`.
     *
     * Every input is resolved from the SAME views the prompt compilers read
     * (`shotDetailModel`, the bible resolvers, the registry), so this projection
     * and the effective prompt can never disagree about what the shot contains.
     */
    build: (shotId) => {
      if (!shotId) return { context: null, trace: null };
      const pd = ctx.prodData();
      const detail = shotDetailModel(pd, shotId);
      if (!detail) return { context: null, trace: null };
      const prod = productionDoc;
      const owner = prod ? proddoc.sceneOfShot(prod, shotId) : null;
      // THE EPISODE COMES FROM THE SHOT, not from the active pointer.
      //
      // Taking it from `activeEpisode` paired this shot's scene with whatever
      // episode happened to be selected — so a shot belonging to EP03 was described
      // to the capability as EP01, with EP01's code, title and plan note, while the
      // scene and the neighbours came from EP03. The prompt would then be about a
      // canon that does not exist, and the recorded provenance would name the wrong
      // episode (codex review, TASK-069 round 2).
      //
      // `sceneOfShot` already resolves the owning episode, so this is derived, never
      // guessed. A shot no episode owns has NO episode — stated as null rather than
      // borrowed from the pointer.
      const ep = owner ? owner.episode : null;
      const epIndex = ep && prod ? prod.episodes.findIndex((e) => e.episodeId === ep.episodeId) : -1;
      // the outline's genre/tone and the world's visual tone — the visual
      // DIRECTION only. The full bible is not a shot's context.
      const plan = storydoc.confirmedPlan(storyDoc);
      const outline = storydoc.approvedOutline(storyDoc) || storydoc.activeOutline(storyDoc) || null;
      const planEntry = plan && ep ? plan.episodes.find((e) => e.episodeId === ep.episodeId) || null : null;
      const world = (prod && prod.world) || {};
      const compiled = ctx.episode.genModel(shotId, "image");
      const compiledVideo = ctx.episode.genModel(shotId, "video");
      const promptOf = (kind, compiledText) => {
        const eff = ctx.prompt.effective(shotId, kind, compiledText);
        const entry = ctx.prompt.entry(shotId, kind);
        return {
          // `version` is null when the effective prompt is the COMPILED one: it has
          // no version because it is a derivation, and `effectivePrompt` reports v0
          // for exactly that case. Passing 0 through would imply a saved version.
          version: eff && eff.version > 0 ? eff.version : null,
          text: eff ? eff.text : null,
          locked: !!(entry && entry.locked),
        };
      };
      // NEIGHBOURS, scoped to the shot's own scene — the same rule
      // `ctx.frames.nextShotOf` follows: a cut across a scene boundary is a jump
      // somewhere else, and treating it as continuity would assert the opposite of
      // what the structure says.
      const ids = owner ? owner.scene.shotIds || [] : [];
      const i = ids.indexOf(shotId);
      const prevId = i > 0 ? ids[i - 1] : null;
      const nextId = i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
      const prev = prevId ? shotDetailModel(pd, prevId) : null;
      const next = nextId ? shotDetailModel(pd, nextId) : null;
      // WHAT THE PREVIOUS SHOT CAN HAND OVER: its bound end frame if it has one,
      // else nothing. Its own selected image is NOT an end frame — offering that as
      // 「上一镜的尾帧」 would name a picture that is not the last frame of anything.
      const prevEnd = prev && prev.frames && prev.frames.end && prev.frames.end.binding
        ? prev.frames.end.assetId
        : null;
      return shotctx.buildShotContext({
        detail,
        place: {
          episodeId: ep ? ep.episodeId : null,
          episodeCode: epIndex >= 0 ? `EP${String(epIndex + 1).padStart(2, "0")}` : null,
          episodeTitle: ep ? ep.title : null,
          sceneId: owner ? owner.scene.sceneId : null,
          sceneTitle: owner ? owner.scene.title : null,
        },
        canon: {
          genreTone: outline && outline.outline ? outline.outline.genreTone : null,
          worldVisualTone: world.visualTone || null,
          worldRules: world.rules || null,
          // the episode's own PURPOSE in one line — hook / 作用 / 结尾拍. Not the
          // whole plan entry: a shot does not need the episode's duration budget.
          episodePlanNote: planEntry
            ? [planEntry.hook, planEntry.purpose, planEntry.endingBeat]
              .map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join(" / ") || null
            : null,
        },
        refUseOf: (refKey) => {
          const rec = assetreg.listReferences(assetRegistry).find((r) => r.key === refKey);
          const eff = ctx.refUse.effective(shotId, refKey, rec ? rec.kind : null);
          return eff ? eff.use : null;
        },
        prompts: {
          image: promptOf("image", compiled.prompt),
          video: promptOf("video", compiledVideo.prompt),
        },
        neighbours: { prev, next },
        neighbourFrames: { prevEndFrameAssetId: prevEnd },
      });
    },

    /** 已有 / 缺少 for one shot (§6) — derived, never hard-coded demo copy. */
    readiness: (shotId) => {
      const { context } = ctx.shotctx.build(shotId);
      return context ? shotctx.shotReadiness(context) : null;
    },

    /**
     * The DETERMINISTIC candidate set a recommender may pick from (决策 4).
     *
     * Retrieved from the registry here, with real `referenceKey` + `assetId` and the
     * evidence for each. A model is never shown the library and never invents an id.
     */
    candidates: (shotId, opts = {}) => {
      const { context } = ctx.shotctx.build(shotId);
      if (!context) return { candidates: [], byRole: {}, bound: [], truncated: 0 };
      const refs = assetreg.listReferences(assetRegistry).map((r) => ({
        key: r.key,
        kind: r.kind,
        name: assetreg.derivedLabel(r),
        version: r.version,
        assetId: r.assetId,
        links: r.links,
        reusable: r.reusable === true,
      }));
      return shotctx.candidatesFor(context, refs, opts);
    },

    /**
     * The cache baseline for one conclusion about one shot.
     *
     * `assetRecommendation` MUST be fingerprinted with the candidate set, exactly as
     * the run recorded it (决策 4): registering or removing a character reference
     * changes what could have been recommended, so a conclusion drawn from the old
     * set is stale even though the shot itself never moved.
     *
     * Computing the LIVE side without it — while `remember` stamps the baseline from
     * a run trace that HAS it — makes the two digests differ by construction, so every
     * cached recommendation is reported stale the instant it is written and the cache
     * never returns anything (codex review round 6). The retrieval is deterministic
     * (`candidatesFor` is pure), so re-deriving it here yields the same set the run saw
     * whenever the references have not changed — which is precisely the question being
     * asked.
     */
    revision: (shotId, scope) => {
      const { context, trace } = ctx.shotctx.build(shotId);
      if (!trace) return null;
      if (scope !== "assetRecommendation") return shotctx.contextRevision(trace, scope);
      const cand = ctx.shotctx.candidates(shotId);
      return shotctx.contextRevision(
        shotctx.traceOf(context, {
          candidateKeys: cand && Array.isArray(cand.candidates)
            ? cand.candidates.map((c) => c.referenceKey)
            : null,
        }),
        scope,
      );
    },

    /** A cached conclusion + whether it still applies. `stale: true` is returned,
     *  never hidden and never auto-refreshed — a re-run spends tokens. */
    cached: (scope, shotId, variant = null) => ctxcache.get(ctxCacheDoc, {
      scope,
      shotId,
      variant,
      currentRevision: ctx.shotctx.revision(shotId, scope),
    }),

    /**
     * Record a conclusion against the revision of the context it was ACTUALLY drawn
     * from.
     *
     * When a `skillRunId` is given, the baseline comes from THAT RUN's recorded
     * `contextTrace` — not from the live context. A manual run's answer can come back
     * minutes later, after the creator has edited the shot; stamping it with the
     * current revision would mark a conclusion drawn from the old inputs as fresh
     * forever, which is precisely the fabricated freshness ADR-0064 决策 3 exists to
     * prevent. Falls back to the live context only when there is no run to read
     * (a conclusion nobody can attribute has no better baseline available).
     */
    remember: (scope, shotId, value, { skillRunId = null, proposalId = null, variant = null } = {}) => {
      const run = skillRunId ? skillrun.findRun(skillRunRegistry, skillRunId) : null;
      const rev = run && run.contextTrace
        ? shotctx.contextRevision(run.contextTrace, scope)
        : ctx.shotctx.revision(shotId, scope);
      if (!rev) return null;
      const e = ctxcache.put(ctxCacheDoc, {
        scope, shotId, variant, baselineRevision: rev, value,
        at: new Date().toISOString(), skillRunId, proposalId,
      });
      if (e) ctx.persist();
      return e;
    },

    forget: (scope, shotId, variant = null) => {
      const ok = ctxcache.forget(ctxCacheDoc, { scope, shotId, variant });
      if (ok) ctx.persist();
      return ok;
    },
  },

  // ---------------------------------------------------------------------- //
  // LOCK (ADR-0061 决策 5 / §50) — 「这个我定了」.
  //
  // MOVED to src/controllers/lockctl.js (TASK-073 §1.8). Documents are handed over
  // as GETTERS, because they are module-level `let`s reassigned on project load — a
  // factory capturing their values would keep writing to the previous project's
  // documents. Assigned AFTER this literal (see below `ctx.locks = …`), since the
  // factory needs `ctx`-adjacent helpers that only exist once it is built.
  // ---------------------------------------------------------------------- //

  // ---------------------------------------------------------------------- //
  // FRAMES (TASK-064 Phase 2 §7) — 上一镜尾帧 → 下一镜首帧.
  //
  //   SH01 Video v3 ──[提取 t]──▶ 派生 Image Asset ──▶ SH02 Start Frame
  //
  // NOT A SECOND FRAME SYSTEM. The EFFECTIVE start frame is still
  // `assets.firstFrames[slot]` — the pointer the paid route, the draft lock and
  // the provenance graph already read. `bind` writes that pointer AND the
  // provenance record in the same call, so they cannot drift apart.
  // ---------------------------------------------------------------------- //
  frames: {
    bindings: (shotId) => framebind.bindingsOf(frameBindingsDoc, shotId),
    binding: (shotId, type) => framebind.bindingOf(frameBindingsDoc, shotId, type),
    /** The ACTIVE video version of a shot, or null. Passed to
     *  `framebind.frameNotice` so drift is measured against real state. */
    activeVideoVersion: (shotId) => {
      const shot = ctx.shot.find(shotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      const ref = slot ? mediaref.currentRef(assetRegistry.videos, slot) : null;
      return ref && Number.isInteger(ref.version) ? ref.version : null;
    },
    /** 「上游视频已有新版本」 — the notice and its three choices, or null. */
    notice: (shotId, type) => framebind.frameNotice(
      framebind.bindingOf(frameBindingsDoc, shotId, type),
      (sid) => ctx.frames.activeVideoVersion(sid),
    ),
    /**
     * EXTRACT one frame out of a shot's current video take and register it as a
     * derived Image Asset. Returns `{ assetId, url, version, key, source }`.
     *
     * `pick` is the creator's INTENT and is stored: "last" re-seeks to the end of
     * whatever video it is re-extracted from, "at" re-seeks to the same
     * millisecond. `timecodeMs` null with `pick: "last"` means 「最后一帧」.
     *
     * The bytes are read from the video element the browser already has; nothing
     * server-side is needed beyond the ordinary upload endpoint, so this works on
     * exactly the machines the rest of the studio works on.
     */
    extract: async (sourceShotId, { timecodeMs = null, pick = "last" } = {}) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法登记提取出来的帧");
      const shot = ctx.shot.find(sourceShotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      const ref = slot ? mediaref.currentRef(assetRegistry.videos, slot) : null;
      if (!ref || !ref.url) throw new Error("这个镜头还没有视频，无法提取帧");
      if (ref.storageState && ref.storageState !== "local") {
        throw new Error("这条视频的字节不在本地（记录仍在）——先恢复本地副本再提取");
      }
      const grabbed = await grabVideoFrame(ref.url, { timecodeMs, pick });
      // its own chain key: a derived frame is not a version of the target shot's
      // 画面 (that would make 「这个镜头有几版画面」 count frames nobody designed)
      const key = mintId("frame");
      const pre = assetreg.checkDeclaration("images", { kind: "derived-frame" });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await query.uploadAssetImage(PROJECT_NAME, `assets-${key}`, grabbed.file);
      // creativeShotId is the SOURCE shot: that is the shot these pixels provably
      // came from. WHERE the frame is USED is the binding's `targetShotId`, and
      // conflating the two would file the frame under a shot it was not cut from.
      const mref = mediaref.refFromResponse(key, "upload", res, sourceShotId);
      const decl = assetreg.declare(mref, "images", {
        kind: "derived-frame",
        displayName: `${(shot && shot.title) || "镜头"} 视频 v${ref.version} 的${pick === "last" ? "尾帧" : `${(grabbed.timecodeMs / 1000).toFixed(2)}s 帧`}`,
        originalFilename: null,
        links: contextOfShot(sourceShotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: assetRegistry.images }, key, mref);
      ctx.refreshType("assets");
      ctx.persist();
      refreshProductionView();
      return {
        key,
        assetId: mref.assetId,
        url: mref.url,
        version: mref.version,
        source: {
          sourceShotId,
          sourceVideoAssetId: ref.assetId || null,
          sourceVideoVersion: Number.isInteger(ref.version) ? ref.version : null,
          sourceTimecodeMs: grabbed.timecodeMs,
          sourceFrame: null, // fps is not knowable from a <video> element — unknown stays unknown
          pick,
        },
      };
    },
    /**
     * BIND a derived (or any registered) image as a shot's start / end frame.
     *
     * `startFrame` additionally moves `assets.firstFrames[slot]`, which is what
     * the video generation route actually reads — the binding record alone would
     * be provenance for a frame nothing used.
     */
    /**
     * The shot that FOLLOWS this one in canonical order, or null.
     *
     * Scoped to the shot's own SCENE: 「下一镜」 across a scene boundary is a cut
     * to somewhere else, and continuing its last frame into it would be a claim
     * about continuity the structure contradicts. A shot at the end of its scene
     * honestly has no next shot here.
     */
    nextShotOf: (shotId) => {
      const owner = proddoc.sceneOfShot(productionDoc, shotId);
      if (!owner) return null;
      const ids = owner.scene.shotIds || [];
      const i = ids.indexOf(shotId);
      if (i < 0 || i + 1 >= ids.length) return null;
      const nextId = ids[i + 1];
      const s = ctx.shot.find(nextId);
      return s ? { shotId: nextId, title: s.title || `镜头 ${s.sequence}` } : null;
    },
    /**
     * BIND an image as a shot's start / end frame.
     *
     * `source` (an object) is the extraction provenance and makes the binding
     * `extracted`. `sourceKind` names the non-extracted cases explicitly — a
     * binding must SAY where it came from, and defaulting everything without a
     * source object to 「upload」 would file the shot's own picture as an upload.
     */
    bind: (targetShotId, bindingType, { assetId, source = null, sourceKind = "upload", force = false } = {}) => {
      // EVERY check runs BEFORE the first write (TASK-072 §1.9 缺陷 1). This used
      // to record the binding, then discover the problem, then report success:
      //   ① `targetShotId` was never resolved → a binding pointing at no shot,
      //      reported as applied;
      //   ② any image asset was accepted → an asset belonging to ANOTHER slot and
      //      not declared `derived-frame` fails `validateCanvasDoc`, and that
      //      validator rejects the WHOLE document — so binding one made the
      //      project unopenable (and unsaveable) afterwards;
      //   ③ the slot was resolved AFTER `framebind.bind` had already persisted →
      //      the prompt showed the new frame while generation still used the old.
      // Nothing is written unless all of them pass.
      const hit = assetId ? assetlib.findAssetById(assetRegistry, assetId) : null;
      if (!hit || hit.domain !== "images") { toast("只能绑定已登记的图片资产作为首/尾帧"); return null; }
      const shot = ctx.shot.find(targetShotId);
      if (!shot) { toast("目标镜头不存在：没有绑定任何帧"); return null; }
      let slot = null;
      if (bindingType === "startFrame") {
        slot = ctx.shot._slotOf(shot);
        // ③ refuse rather than record a binding whose effective pointer cannot be
        // written: 「已记录绑定，但生成仍用旧画面」 is a binding that lies.
        if (!slot) { toast("目标镜头的槽位无法解析：没有绑定任何帧"); return null; }
        // ② the exact rule `validateCanvasDoc` enforces on assets.firstFrames:
        // an image may be bound to a DIFFERENT slot only when it is the one kind
        // whose whole purpose is that (上一镜尾帧 → 下一镜首帧). Checked here so a
        // refusal is a sentence now, instead of an unloadable document later.
        if (hit.record.kind !== "derived-frame" && hit.key !== slot) {
          toast("这张图属于另一个镜头的画面，且不是提取出来的帧——不能用作本镜头的首帧");
          return null;
        }
      }
      const b = framebind.bind(frameBindingsDoc, targetShotId, bindingType, {
        derivedImageAssetId: assetId,
        source: source ? "extracted" : sourceKind,
        ...(source || {}),
        at: new Date().toISOString(),
      }, { force });
      if (!b) { toast("这个帧槽位已锁定：先解锁再绑定"); return null; }
      if (slot) {
        mediaref.putKey(assetRegistry.firstFrames, slot, {
          ...hit.record, slot_id: slot, digest: hit.record.digest || null,
        });
        ctx.refreshType("video");
      }
      ctx.persist();
      refreshProductionView();
      return b;
    },
    /** 解除绑定. The derived Asset is NOT deleted — it is a registered asset with
     *  its own provenance, and unbinding is a statement about this shot only. */
    unbind: (targetShotId, bindingType) => {
      const ok = framebind.unbind(frameBindingsDoc, targetShotId, bindingType);
      if (!ok) { toast("这个帧槽位已锁定或本来就没有绑定"); return false; }
      if (bindingType === "startFrame") {
        const shot = ctx.shot.find(targetShotId);
        const slot = shot ? ctx.shot._slotOf(shot) : null;
        // clear the EFFECTIVE pointer too, or the generation would keep using a
        // frame the record no longer claims
        if (slot && assetRegistry.firstFrames && Object.prototype.hasOwnProperty.call(assetRegistry.firstFrames, slot)) {
          delete assetRegistry.firstFrames[slot];
          ctx.refreshType("video");
        }
      }
      ctx.persist();
      refreshProductionView();
      return true;
    },
    /** 从当前版本重新提取 — extract again from the source shot's ACTIVE take and
     *  re-bind, repeating the creator's stored intent (`pick`). */
    reextract: async (targetShotId, bindingType) => {
      const b = framebind.bindingOf(frameBindingsDoc, targetShotId, bindingType);
      if (!b || b.source !== "extracted" || !b.sourceShotId) {
        toast("这个帧不是从视频里提取的，没有可重新提取的来源");
        return null;
      }
      const out = await ctx.frames.extract(b.sourceShotId, {
        timecodeMs: b.pick === "at" ? b.sourceTimecodeMs : null,
        pick: b.pick,
      });
      return ctx.frames.bind(targetShotId, bindingType, {
        assetId: out.assetId, source: out.source, force: true,
      });
    },
  },

  // ---------------------------------------------------------------------- //
  // Per-shot MULTI-TRACK AUDIO (ADR-0061 决策 6 / §37–§39).
  //
  //   Dialogue · VO · Ambience · SFX · Foley · BGM
  //     → clips with absolute or ANCHORED timing, trim, gain, fades
  //     → internal mix (local ffmpeg)
  //     → ONE derived Shot Mixed Audio Asset — sources untouched, always
  // ---------------------------------------------------------------------- //
  shotAudio: {
    TRACKS: shotaudio.TRACKS,
    TRACK_LABEL: shotaudio.TRACK_LABEL,
    clips: (shotId) => shotaudio.clipsOf(shotAudioDoc, shotId),
    mix: (shotId) => shotaudio.mixOf(shotAudioDoc, shotId),
    /**
     * The ANCHORS a shot's clips may sync to, resolved to milliseconds.
     *
     * Derived from what the documents really hold, so an anchor either resolves
     * or is reported unresolved — never placed at zero:
     *
     *   shot:start / shot:end        the shot's own bounds
     *   dialogue:<shotId>            where this shot's line sits (its start)
     *   action:<name>                a named beat the creator declared on the
     *                                shot (`shot.audioAnchors`), in ms
     *
     * 「AI 以后可以提出 event，但不能直接偷偷改 canonical timeline」 (§35): a Skill
     * proposes an OFFSET against one of these; it cannot mint an anchor.
     */
    anchors: (shotId) => {
      const shot = ctx.shot.find(shotId);
      const durMs = Math.round(((shot && shot.duration_seconds === 10) ? 10 : 6) * 1000);
      const out = { "shot:start": 0, "shot:end": durMs };
      if (shot && typeof shot.dialogue === "string" && shot.dialogue.trim()) out[`dialogue:${shotId}`] = 0;
      // creator-declared beats live on the draft shot as `audioAnchors`
      const declared = shot && shot.audioAnchors;
      if (declared && typeof declared === "object" && !Array.isArray(declared)) {
        for (const name of Object.keys(declared)) {
          const v = declared[name];
          if (Number.isFinite(v)) out[`action:${name}`] = Math.max(0, Math.round(v));
        }
      }
      return out;
    },
    /** Source durations, where the registry knows them. Unknown stays unknown —
     *  `resolveClips` then reports `endMs: null` rather than a guessed length. */
    durations: () => ({}),
    resolved: (shotId) => shotaudio.resolveClips(shotaudio.clipsOf(shotAudioDoc, shotId), {
      anchors: ctx.shotAudio.anchors(shotId),
      durations: ctx.shotAudio.durations(),
    }),
    byTrack: (shotId) => shotaudio.byTrack(ctx.shotAudio.resolved(shotId)),
    standing: (shotId) => shotaudio.mixStanding(shotAudioDoc, shotId, ctx.shotAudio.resolved(shotId)),
    add: (shotId, clip) => prodNew(shotaudio.addClip(shotAudioDoc, shotId, clip)),
    remove: (shotId, clipId) => prodOp(shotaudio.removeClip(shotAudioDoc, shotId, clipId)),
    move: (shotId, clipId, timing, opts) => prodOp(shotaudio.moveClip(shotAudioDoc, shotId, clipId, timing, opts)),
    trim: (shotId, clipId, inMs, outMs, opts) => prodOp(shotaudio.trimClip(shotAudioDoc, shotId, clipId, inMs, outMs, opts)),
    setGain: (shotId, clipId, gain, opts) => prodOp(shotaudio.setGain(shotAudioDoc, shotId, clipId, gain, opts)),
    setFade: (shotId, clipId, fi, fo, opts) => prodOp(shotaudio.setFade(shotAudioDoc, shotId, clipId, fi, fo, opts)),
    setMuted: (shotId, clipId, on, opts) => prodOp(shotaudio.setMuted(shotAudioDoc, shotId, clipId, on, opts)),
    replaceAsset: (shotId, clipId, assetId, opts) => prodOp(
      shotaudio.replaceClipAsset(shotAudioDoc, shotId, clipId, assetId, opts),
    ),
    /** The AUTOMATIC first arrangement (§41): the shot's dialogue take, its
     *  scene's ambience, the episode's BGM. It invents nothing and never touches
     *  a locked or hand-placed clip. */
    autoArrange: (shotId) => {
      const shot = ctx.shot.find(shotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      const owner = proddoc.sceneOfShot(productionDoc, shotId);
      const dialogue = slot ? mediaref.currentRef(assetRegistry.audio, `voice-${slot}`) : null;
      // scene ambience and the effective BGM are stored as ASSET IDS on the
      // production document (proddoc), not as chain keys — they are references to
      // one reusable recording that many scenes share
      const bgm = owner
        ? proddoc.effectiveBgm(productionDoc, owner.episode.episodeId, owner.scene.sceneId)
        : null;
      const res = shotaudio.autoArrange(shotAudioDoc, shotId, {
        dialogue: dialogue ? dialogue.assetId : null,
        ambience: owner && owner.scene.ambienceAssetId ? owner.scene.ambienceAssetId : null,
        bgm: bgm ? bgm.assetId : null,
        durationMs: Math.round(((shot && shot.duration_seconds === 10) ? 10 : 6) * 1000),
      });
      if (res.added.length) { ctx.persist(); refreshProductionView(); }
      return res;
    },
    /**
     * MIX the shot's audio into ONE derived Asset (§38).
     *
     * The sources are read and left completely alone; the mix is a new
     * `shot-mix` Asset on its own chain, and its provenance snapshot records
     * every source assetId, version, timing, anchor, offset, gain and fade it was
     * made with — frozen, so it keeps describing what it IS after the clips move.
     */
    mixNow: async (shotId) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法混音");
      const shot = ctx.shot.find(shotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      if (!slot) throw new Error("镜头身份未解析：无法定位混音槽位");
      const resolved = ctx.shotAudio.resolved(shotId);
      const audible = resolved.filter((c) => !c.muted && !c.unresolved);
      if (!audible.length) throw new Error("这个镜头没有可混的音频片段（全部静音或对位未解析）");
      const clips = [];
      for (const c of audible) {
        const hit = assetlib.findAssetById(assetRegistry, c.assetId);
        if (!hit || !hit.record.url) throw new Error(`片段引用的素材不存在或字节已移除：${c.assetId}`);
        if (hit.record.storageState && hit.record.storageState !== "local") {
          throw new Error(`片段素材的字节不在本地：${assetreg.derivedLabel({ ...hit.record, key: hit.key })}`);
        }
        const base = String(hit.record.url).split("/").pop();
        clips.push({
          file: base,
          in: c.sourceInMs / 1000,
          // THREE cases, and they mean different things:
          //
          //   no out point        「到素材结束」 — the server resolves the real
          //                       duration with ffprobe. Substituting
          //                       `sourceInMs + 1000` here truncated every
          //                       un-trimmed clip to one second and still
          //                       reported success.
          //   AUTO clip's out     a CAP the arranger derived from the shot's
          //                       length, not a request for that much audio. A
          //                       4-second ambience bed under a 6-second shot is
          //                       not an error — sent as `maxOut`, which clamps.
          //   MANUAL clip's out   the creator's own trim. Sent as `out`, and the
          //                       server REFUSES it if the file is shorter:
          //                       they asked for audio that does not exist.
          ...(c.sourceOutMs != null
            ? (c.origin === "auto"
              ? { maxOut: c.sourceOutMs / 1000 }
              : { out: c.sourceOutMs / 1000 })
            : {}),
          start: (c.startMs || 0) / 1000,
          gainDb: c.gain,
          fadeInMs: c.fadeInMs,
          fadeOutMs: c.fadeOutMs,
        });
      }
      const key = `mix-${slot}`;
      const res = await query.mixShotAudio(PROJECT_NAME, key, clips);
      const ref = mediaref.refFromResponse(key, "mix", res, shotId);
      const decl = assetreg.declare(ref, "audio", {
        kind: "shot-mix",
        displayName: `${(shot && shot.title) || "镜头"} 混音 v${res.version}`,
        originalFilename: null,
        links: contextOfShot(shotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: assetRegistry.audio }, key, ref);
      // the mix is a DERIVED result of real inputs, so it is a Generation like any
      // other — that is what puts it on the provenance graph with its sources
      const prov = shotaudio.mixProvenance(resolved, {
        settings: { format: "mp3", sampleRate: 44100, bitrate: "192k" },
        versionOf: (assetId) => {
          const h = assetlib.findAssetById(assetRegistry, assetId);
          return h && Number.isInteger(h.record.version) ? h.record.version : null;
        },
      });
      const gen = ctx.startGeneration({
        type: "audio",
        targetType: "shot",
        targetId: shotId,
        inputAssetIds: prov.sources.map((s) => s.assetId),
        referenceAssetIds: [],
        promptSnapshot: null,
        provider: "shot-mix",
        parameters: { mix: prov.settings, sources: prov.sources, unresolved: prov.unresolved },
        status: "generating",
      });
      if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
      shotaudio.setMix(shotAudioDoc, shotId, {
        assetId: ref.assetId,
        at: new Date().toISOString(),
        provenance: prov,
      });
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(`镜头混音 v${res.version} 已生成（${prov.sources.length} 条源素材全部保留）`);
      return ref;
    },
  },

  // ---------------------------------------------------------------------- //
  // SUBTITLE track (ADR-0061 决策 6 / §44–§45) — automatic by default.
  // ---------------------------------------------------------------------- //
  subtitles: {
    ADAPTERS: subtitle.ADAPTERS,
    STYLE_PRESETS: subtitle.STYLE_PRESETS,
    track: () => subtitle.trackFor(subtitlesDoc, productionDoc.activeEpisodeId),
    overlaps: () => subtitle.overlaps(ctx.subtitles.track()),
    /** Case A: dialogue text + the CUT's timing → cues. The timing comes from the
     *  timeline because that is what the viewer sees; using the shot's nominal
     *  duration would drift from the picture the moment anything was trimmed. */
    generate: () => {
      const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
      const rows = [];
      // `liveClips`, NOT `clipsOf` (TASK-072 §1.9 缺陷 5). `clipsOf` excludes
      // removed clips by default TODAY, but the cut's definition of 「in the
      // picture」 is `liveClips` — one definition, so the SRT, the render and the
      // duration cannot disagree. Generating cues for a clip the viewer will never
      // see ships a subtitle describing a shot that is not in the film.
      for (const c of timeline.liveClips(t)) {
        if (c.trackType !== "video") continue;
        if (!c.shotId) continue;
        const shot = ctx.shot.find(c.shotId);
        if (!shot) continue;
        rows.push({
          shotId: c.shotId,
          startMs: Math.round(c.startTime * 1000),
          endMs: Math.round((c.startTime + (c.trimOut - c.trimIn)) * 1000),
          dialogue: shot.dialogue || "",
          // WHO speaks, ONLY where the shot itself names a speaker. Falling back
          // to the scene's first character would print a name nobody said — and a
          // subtitle attributing a line to the wrong character is worse than an
          // unattributed one, because it reads as a fact.
          speaker: typeof shot.speaker === "string" && shot.speaker ? shot.speaker : null,
        });
      }
      const track = ctx.subtitles.track();
      const res = subtitle.generateFromDialogue(track, rows, {
        at: new Date().toISOString(),
        isLocked: (cueId) => ctx.locks.is("subtitle", cueId),
      });
      if (res.added.length) { ctx.persist(); refreshProductionView(); }
      return res;
    },
    /** An unavailable adapter answers with its real reason — no fake ASR (§45). */
    tryAdapter: (id) => subtitle.adapterUnavailable(id),
    update: (cueId, fields) => prodOp(_writeCue(cueId, fields, { force: true })),
    /** A SKILL's edit of a cue — same write path, but the lock is enforced. */
    applyFix: (cueId, fields, meta = {}) =>
      prodOp(
        _writeCue(cueId, fields, {
          force: false,
          origin: meta.skillRunId ? "skill" : "manual",
        }),
      ),
    add: (cue) => prodNew(subtitle.addCue(ctx.subtitles.track(), cue)),
    remove: (cueId) => prodOp(subtitle.removeCue(ctx.subtitles.track(), cueId, {
      isLocked: (id) => ctx.locks.is("subtitle", id),
    })),
    split: (cueId, atMs, splitAtChar) => prodOp(subtitle.splitCue(ctx.subtitles.track(), cueId, atMs, {
      splitAtChar, at: new Date().toISOString(), isLocked: (id) => ctx.locks.is("subtitle", id),
    })),
    setStyle: (style) => prodOp(subtitle.setStyle(ctx.subtitles.track(), style)),
    /** SRT for the current track. Subtitles are NOT burned into the picture this
     *  round; an SRT beside the MP4 is the honest form of 「字幕交付」 without
     *  claiming a burn-in that did not happen. */
    srt: () => subtitle.toSRT(ctx.subtitles.track()),
  },

  // ---------------------------------------------------------------------- //
  // The Action Layer dispatcher (ADR-0061 决策 9 / TASK-064 §52).
  //
  // ONE name per mutation, and every name maps to the ORDINARY controller for
  // that surface. The UI and the AI Director call the same dispatcher, so there
  // is no second implementation of any mutation to drift from the first.
  //
  // An action this checkpoint has not wired reports 「未接线」 honestly rather
  // than returning ok — a dispatcher that silently no-ops is worse than a
  // missing button, because the caller reports success.
  // ---------------------------------------------------------------------- //
  actions: {
    NAMES: actions.ACTION_NAMES,
    LEVEL: actions.CURRENT_LEVEL,
    /** Dispatch one action envelope. `meta.origin` is "user" (default) or "ai";
     *  the gate is `actions.allowedAt`, which at the level in force refuses every
     *  AI-origin mutation. */
    /**
     * Dispatch, then apply G3 (系统合同 §6.3 / TASK-072 §1.6 验收 #9).
     *
     * WRAPPED HERE rather than repeated in each case: §6.3 says the trigger is the
     * DOMAIN, 「任何走 Action 层的相关写入都触发它」. A retirement checked inside one
     * page is bypassed by the next page that performs the same operation — which is
     * how 「审片通过」 survives a shot reorder in the first place.
     *
     * Only on SUCCESS: a refused edit changed no structure, so it must not retire a
     * review. And the note is appended to the result, so the creator is told the
     * lock was released instead of discovering it later.
     */
    dispatch: (envelope, meta = {}) => {
      const res = ctx.actions._dispatchRaw(envelope, meta);
      if (!res || res.ok !== true) return res;
      const trigger = g3TriggerFor(envelope && envelope.action);
      if (!trigger) return res;
      const episodeId = productionDoc.activeEpisodeId;
      if (!episodeId) return res;
      const g3 = g3Retire(reviewsDoc.decisions, {
        episodeId,
        trigger,
        at: new Date().toISOString(),
      });
      if (!g3.changed) return res;
      reviewsDoc = {
        ...reviewsDoc,
        decisions: reviewsDoc.decisions.map((d) => (d.decisionId === g3.decisionId ? g3.next : d)),
      };
      // THE PICTURE LOCK IS NOT RELEASED HERE, and that is stated rather than
      // silently skipped: there is no `pictureEdit` scope in `workflow/locks.js`
      // yet — 画面锁定 arrives with `lockPictureEdit` (合同 §6.3 G2 / TASK-073 §1.7
      // 表), which is not implemented. Calling `ctx.locks.set` with an undeclared
      // scope would write a lock nothing reads and report success.
      const lockNote = g3.unlockPicture
        ? "（画面锁定本身还未实现，所以没有锁需要解除）"
        : "";
      ctx.persist();
      refreshProductionView();
      return { ...res, note: [res.note, g3.reason + lockNote].filter(Boolean).join("；") };
    },
    _dispatchRaw: (envelope, meta = {}) => {
      const bad = actions.validate(envelope);
      if (bad) return { ok: false, error: bad };
      const gate = actions.allowedAt(envelope.action, {
        origin: meta.origin || "user",
        confirmed: meta.confirmed === true,
      });
      if (!gate.ok) return { ok: false, error: gate.reason };
      const a = envelope;
      switch (a.action) {
        case "setActiveVersion":
          return bool(ctx.media.setCurrent(a.domain, a.key, a.version), "版本不在历史里");
        case "addReference": {
          // ALREADY BOUND is not a failure — it is the requested end state. Told
          // apart from 「参考不存在」 by asking the document first, because the
          // write path returns false for both and a caller cannot tell a
          // satisfied action from a broken one by the return value alone.
          const bound = ctx.shot.references(a.shotId) || [];
          if (bound.includes(a.referenceKey)) return { ok: false, satisfied: true, error: "这个参考已经绑定在这个镜头上" };
          const exists = assetreg.listReferences(assetRegistry).some((r) => r.key === a.referenceKey);
          if (!exists) return { ok: false, error: `参考 ${a.referenceKey} 不存在（可能已删除）` };
          return bool(ctx.shot.addReference(a.shotId, a.referenceKey), "无法绑定到这个镜头（镜头身份可能已失效）");
        }
        case "replaceReference": {
          // A REAL SWAP (TASK-067 §12): unbind the old, bind the new, and carry the
          // creator's use-side choice across so 「用于视频编排」 does not silently
          // revert to the role default just because the asset changed.
          const bound = ctx.shot.references(a.shotId) || [];
          if (!bound.includes(a.replacesKey)) {
            return { ok: false, error: `这个镜头没有绑定参考 ${a.replacesKey}，没有可替换的对象` };
          }
          if (a.referenceKey === a.replacesKey) {
            return { ok: false, satisfied: true, error: "新旧参考是同一个，无需替换" };
          }
          if (bound.includes(a.referenceKey)) {
            return { ok: false, error: `参考 ${a.referenceKey} 已经绑在这个镜头上——用「解除关联」移除旧的即可` };
          }
          const all = assetreg.listReferences(assetRegistry);
          const incoming = all.find((r) => r.key === a.referenceKey);
          if (!incoming) return { ok: false, error: `参考 ${a.referenceKey} 不存在（可能已删除）` };
          const outgoing = all.find((r) => r.key === a.replacesKey) || null;
          // read the OLD side BEFORE unbinding — `removeReference` forgets it
          const prevUse = ctx.refUse.effective(a.shotId, a.replacesKey, outgoing ? outgoing.kind : null);
          const carry = prevUse && prevUse.source === "creator" ? prevUse.use : null;
          // BIND FIRST, then unbind. The other order leaves the shot with neither
          // reference if the bind fails, which is strictly worse than leaving it
          // with the old one — a failed swap must not lose what was there.
          if (!ctx.shot.addReference(a.shotId, a.referenceKey)) {
            return { ok: false, error: "无法绑定新参考（镜头身份可能已失效）——旧参考保持不变" };
          }
          if (!ctx.shot.removeReference(a.shotId, a.replacesKey)) {
            return {
              ok: true,
              partial: true,
              detail: "新参考已绑定，但旧参考没能解除——两个都还在，请手动解除旧的",
            };
          }
          // carry the explicit side over, but only where the NEW role can serve it:
          // a creator's 「用于视频编排」 on a motion reference is meaningless on a
          // character reference, and forcing it would store a use no compiler reads
          if (carry && refuse.allowedUses(incoming.kind).includes(carry)) {
            ctx.refUse.set(a.shotId, a.referenceKey, carry, incoming.kind);
          }
          return { ok: true, detail: `已用 ${assetreg.derivedLabel(incoming)} 替换` };
        }
        // --- 接上一镜的尾帧 (TASK-067 §12) ------------------------------------ //
        case "usePreviousShotEndFrame": {
          const owner = proddoc.sceneOfShot(productionDoc, a.shotId);
          if (!owner) return { ok: false, error: "这个镜头还没有归入场景，所以没有「上一镜」" };
          const ids = owner.scene.shotIds || [];
          const i = ids.indexOf(a.shotId);
          if (i <= 0) return { ok: false, error: "这是本场的第一个镜头，没有上一镜可以接" };
          const prevId = ids[i - 1];
          // the PREVIOUS shot's own END-FRAME BINDING is the only thing that is
          // actually its last frame. Its selected image is a picture from the middle
          // of the take, and offering that as 「上一镜的尾帧」 would name a frame that
          // is not the end of anything.
          const prevDetail = shotDetailModel(ctx.prodData(), prevId);
          const end = prevDetail && prevDetail.frames ? prevDetail.frames.end : null;
          if (!end || !end.binding || !end.assetId) {
            return {
              ok: false,
              error: "上一镜还没有绑定尾帧——先在它的视频卡片上「提取尾帧」（提取会写入字节，是一个独立的动作）",
            };
          }
          const cur = (shotDetailModel(ctx.prodData(), a.shotId) || {}).frames || {};
          if (cur.start && cur.start.binding && cur.start.assetId === end.assetId) {
            return { ok: false, satisfied: true, error: "这一镜的首帧已经是上一镜的尾帧" };
          }
          const bound = ctx.frames.bind(a.shotId, "startFrame", {
            assetId: end.assetId,
            source: end.binding && typeof end.binding === "object" ? end.binding : null,
          });
          return bool(!!bound, "无法绑定首帧（槽位可能已锁定——先解锁）");
        }
        case "removeReference": {
          const bound = ctx.shot.references(a.shotId) || [];
          if (!bound.includes(a.referenceKey)) return { ok: false, satisfied: true, error: "这个镜头本来就没有绑定该参考" };
          return bool(ctx.shot.removeReference(a.shotId, a.referenceKey), "无法移除该绑定");
        }
        case "updatePrompt":
          return bool(
            ctx.prompt.save(a.shotId, a.kind, a.text, {
              origin: meta.skillRunId ? "skill" : "manual",
              skillRunId: meta.skillRunId || null,
              proposalId: meta.proposalId || null,
            }) > 0,
            "Prompt 已锁定：先解锁再写入",
          );
        case "approveShot":
          // Approving an already-approved shot is the requested end state, not a
          // failure — and re-approving would move the review timestamp for no
          // reason (the approval is bound to a take, and that take has not
          // changed).
          if (ctx.shot.isApproved(a.shotId)) return { ok: false, satisfied: true, error: "这个镜头已经通过" };
          return bool(ctx.shot.approve(a.shotId, a.note || ""), "这个镜头还没有视频");
        case "unapproveShot":
          if (!ctx.shot.isApproved(a.shotId)) return { ok: false, satisfied: true, error: "这个镜头本来就没有通过记录" };
          return bool(ctx.shot.unapprove(a.shotId), "无法撤销通过");
        case "replaceShotDraft":
          return bool(ctx.shots.saveEdit(a.shots), "没有可写入的分镜草稿版本");
        case "patchShots": {
          const draft = (ctx.project.draftShots || []).map((s) => ({ ...s }));
          if (!draft.length) return { ok: false, error: "当前没有分镜草稿" };
          const byId = new Map(draft.map((s) => [s.shotId, s]));
          let n = 0;
          const skipped = [];
          for (const p of a.patches) {
            const target = byId.get(p.shotId);
            // A patch naming a shot that is not in the CURRENT draft is skipped
            // and reported, never applied to a neighbour: applying it by position
            // is how 「Shot 3 的运镜」 lands on a different shot after any edit.
            if (!target) { skipped.push(p.shotId); continue; }
            Object.assign(target, p.fields);
            n += 1;
          }
          if (!n) return { ok: false, error: `提案里的镜头都不在当前草稿里（${skipped.length} 条已跳过）` };
          const ok = ctx.shots.saveEdit(draft);
          return ok
            ? { ok: true, detail: skipped.length ? `${n} 个镜头已更新，${skipped.length} 条跳过` : `${n} 个镜头已更新` }
            : { ok: false, error: "无法保存新的草稿版本" };
        }
        // --- 参考用途 (TASK-066 §5) ------------------------------------------ //
        case "setReferenceUse": {
          const bound = ctx.shot.references(a.shotId) || [];
          if (!bound.includes(a.referenceKey)) {
            return { ok: false, error: `这个镜头没有绑定参考 ${a.referenceKey}` };
          }
          // the ROLE decides which sides are even meaningful, so it is resolved from
          // the registry here rather than trusted from the caller
          const rec = assetreg.listReferences(assetRegistry).find((r) => r.key === a.referenceKey);
          if (!rec) return { ok: false, error: `参考 ${a.referenceKey} 不存在（可能已删除）` };
          const allowed = refuse.allowedUses(rec.kind);
          if (!allowed.includes(a.use)) {
            return {
              ok: false,
              error: `${assetreg.ASSET_KIND_LABEL[rec.kind] || rec.kind} 不能「${refuse.USE_LABEL[a.use] || a.use}」` +
                `——没有编译器会读它，改了也不会进 Prompt`,
            };
          }
          const changed = ctx.refUse.set(a.shotId, a.referenceKey, a.use, rec.kind);
          // already on that side is the requested END STATE, not a failure
          return changed
            ? { ok: true, detail: refuse.USE_LABEL[a.use] }
            : { ok: false, satisfied: true, error: "这个参考已经是这个用途了" };
        }
        // --- reference interpretation (§21–§22) ----------------------------- //
        case "updateInterpretation": {
          const exists = assetreg.listReferences(assetRegistry).some((r) => r.key === a.referenceKey);
          if (!exists) return { ok: false, error: `参考 ${a.referenceKey} 不存在（可能已删除）` };
          return bool(
            ctx.refInterp.save(a.referenceKey, a.axes, {
              origin: meta.skillRunId ? "skill" : "manual",
              skillRunId: meta.skillRunId || null,
              proposalId: meta.proposalId || null,
            }) > 0,
            "解读已锁定：先解锁再写入（或提案里没有任何有内容的轴）",
          );
        }
        // --- frames (§7) ---------------------------------------------------- //
        case "extractFrame":
          // ASYNC, and deliberately not awaited through the dispatcher: every
          // other action here is synchronous, and making one of them return a
          // promise would let a caller report success before the upload landed.
          // The UI calls ctx.frames.extract directly and reports the real result.
          return { ok: false, error: "提取帧是异步动作：请通过左栏「提取尾帧」执行（它会等待登记完成后再报告）" };
        case "bindStartFrame":
          return bool(!!ctx.frames.bind(a.targetShotId, "startFrame", { assetId: a.assetId }), "无法绑定首帧");
        case "unbindFrame":
          return bool(ctx.frames.unbind(a.targetShotId, a.bindingType || "startFrame"), "无法解除绑定（可能已锁定）");
        // --- shot audio (决策 6 / 决策 7) ----------------------------------- //
        // `shotId` may be null on a Skill proposal: a proposal addresses a CLIP,
        // and clip ids are minted unique, so the owning shot is a lookup rather
        // than something the proposal has to get right. A proposal that named the
        // wrong shot would otherwise be applied to a clip inside it.
        case "moveAudioClip": {
          const hit = findShotAudioClip(a.clipId);
          if (!hit) return { ok: false, error: `音频片段 ${a.clipId} 不存在` };
          const t = a.timing || {};
          // an OFFSET DELTA is stated against the clip's current timing, which
          // only this layer knows — the proposal states the shift, not the result
          const timing = Number.isFinite(t.offsetDeltaMs)
            ? (hit.clip.anchor
              ? { anchor: hit.clip.anchor, offsetMs: hit.clip.offsetMs + t.offsetDeltaMs }
              : { startTimeMs: Math.max(0, (hit.clip.startTimeMs || 0) + t.offsetDeltaMs) })
            : t;
          return bool(
            ctx.shotAudio.move(a.shotId || hit.shotId, a.clipId, timing),
            "无法移动（片段已锁定，或 timing 既没有绝对时间也没有可解析的 anchor）",
          );
        }
        case "trimAudioClip": {
          const hit = findShotAudioClip(a.clipId);
          if (!hit) return { ok: false, error: `音频片段 ${a.clipId} 不存在` };
          return bool(ctx.shotAudio.trim(a.shotId || hit.shotId, a.clipId, a.sourceIn, a.sourceOut), "无法修剪（片段可能已锁定）");
        }
        case "setGain": {
          const hit = findShotAudioClip(a.clipId);
          if (!hit) return { ok: false, error: `音频片段 ${a.clipId} 不存在` };
          // a Skill proposes a DELTA in dB; a UI slider sets an absolute value
          const next = a.gainIsDelta === true ? hit.clip.gain + a.gain : a.gain;
          return bool(ctx.shotAudio.setGain(a.shotId || hit.shotId, a.clipId, next), "无法调整音量（片段可能已锁定）");
        }
        case "setFade": {
          const hit = findShotAudioClip(a.clipId);
          if (!hit) return { ok: false, error: `音频片段 ${a.clipId} 不存在` };
          return bool(
            ctx.shotAudio.setFade(
              a.shotId || hit.shotId, a.clipId,
              a.fadeInMs == null ? hit.clip.fadeInMs : a.fadeInMs,
              a.fadeOutMs == null ? hit.clip.fadeOutMs : a.fadeOutMs,
            ),
            "无法调整淡入淡出（片段可能已锁定）",
          );
        }
        case "setAudioMuted": {
          const hit = findShotAudioClip(a.clipId);
          if (!hit) return { ok: false, error: `音频片段 ${a.clipId} 不存在` };
          if (hit.clip.muted === (a.muted === true)) return { ok: false, satisfied: true, error: "这个片段本来就是这个状态" };
          return bool(ctx.shotAudio.setMuted(a.shotId || hit.shotId, a.clipId, a.muted), "无法静音/取消静音（片段可能已锁定）");
        }
        case "addAudioClip":
          return bool(!!ctx.shotAudio.add(a.shotId, a.clip), "片段无效（需要 assetId、轨道，以及恰好一种 timing）");
        case "removeAudioClip":
          return bool(ctx.shotAudio.remove(a.shotId, a.clipId), "无法移除（片段可能已锁定）");
        case "autoArrangeShotAudio": {
          const res = ctx.shotAudio.autoArrange(a.shotId);
          return res.added.length
            ? { ok: true, detail: `自动排入 ${res.added.length} 条，跳过 ${res.skipped.length} 条` }
            : { ok: false, error: res.skipped.length ? res.skipped.map((s) => s.reason).join("；") : "这个镜头没有可自动排入的音频素材" };
        }
        case "mixShotAudio":
          return { ok: false, error: "混音是异步动作：请在下方「后期控制台」执行（它会等待 ffmpeg 完成后再报告）" };
        // --- episode timeline (决策 6 / §46 / §48) --------------------------- //
        case "replaceTimelineAsset": {
          const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
          const clip = timeline.findClip(t, a.clipId);
          if (!clip) return { ok: false, error: `时间线片段 ${a.clipId} 不存在` };
          if (ctx.locks.is("timelineClip", a.clipId)) return { ok: false, error: "这个片段已锁定：先解锁再替换" };
          const hit = assetlib.findAssetById(assetRegistry, a.assetId);
          if (!hit) return { ok: false, error: `资产 ${a.assetId} 不存在（可能已删除）` };
          if (clip.assetId === a.assetId) return { ok: false, satisfied: true, error: "这个片段已经在用这条素材" };
          // THE TRACK DECIDES WHAT MAY GO ON IT. Without this, an Editing
          // Director proposal naming the wrong assetId puts an image or an audio
          // take on the picture track — and the timeline persists, valid-looking,
          // until the render fails on it. Refused here, in the one write path.
          const want = clip.trackType === "video" ? "videos" : "audio";
          if (hit.domain !== want) {
            const zh = { images: "图片", videos: "视频", audio: "音频", finals: "成片" };
            return {
              ok: false,
              error: `「${timeline.TRACK_LABEL[clip.trackType] || clip.trackType}」轨只能放${want === "videos" ? "视频" : "音频"}，` +
                `这条素材是${zh[hit.domain] || hit.domain}`,
            };
          }
          const v = Number.isInteger(hit.record.version) ? hit.record.version : null;
          return bool(ctx.timeline.op("replaceClipAsset", a.clipId, a.assetId, v), "无法替换素材");
        }
        case "trimTimelineClip": {
          if (ctx.locks.is("timelineClip", a.clipId)) return { ok: false, error: "这个片段已锁定：先解锁再修剪" };
          // the timeline stores SECONDS; the action vocabulary speaks ms so a
          // proposal cannot be off by a factor of 1000 depending on which layer
          // it was written for
          return bool(ctx.timeline.op("trimClip", a.clipId, a.inMs / 1000, a.outMs / 1000), "无法修剪（out 必须大于 in）");
        }
        case "moveTimelineClip":
          if (ctx.locks.is("timelineClip", a.clipId)) return { ok: false, error: "这个片段已锁定：先解锁再移动" };
          return bool(ctx.timeline.op("moveVideoClipTo", a.clipId, a.index), "无法移动（只有画面轨可以重排顺序）");
        case "removeTimelineClip": {
          const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
          const clip = timeline.findClip(t, a.clipId);
          if (!clip) return { ok: false, error: `时间线片段 ${a.clipId} 不存在` };
          if (clip.removed === true) return { ok: false, satisfied: true, error: "这个片段本来就已移出成片" };
          return _setRemoved(a.clipId, true, "无法移出（片段可能已锁定）");
        }
        case "restoreTimelineClip":
          return _setRemoved(a.clipId, false, "无法恢复（片段可能已锁定，或本来就在成片里）");
        case "setTimelineVolume": {
          const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
          const clip = timeline.findClip(t, a.clipId);
          if (!clip) return { ok: false, error: `时间线片段 ${a.clipId} 不存在` };
          if (ctx.locks.is("timelineClip", a.clipId)) return { ok: false, error: "这个片段已锁定：先解锁再调整音量" };
          // a Skill proposes dB; the timeline stores LINEAR volume. The single
          // conversion lives in dbToLinear — see skillapply.collectSoundAdjustments.
          const next = Number.isFinite(a.gainDb) ? dbToLinear(clip.volume, a.gainDb) : a.volume;
          return bool(ctx.timeline.op("setClipVolume", a.clipId, next), "无法调整音量");
        }
        case "setTimelineFade": {
          const t = timeline.timelineFor(timelinesDoc, productionDoc.activeEpisodeId);
          const clip = timeline.findClip(t, a.clipId);
          if (!clip) return { ok: false, error: `时间线片段 ${a.clipId} 不存在` };
          if (ctx.locks.is("timelineClip", a.clipId)) {
            return { ok: false, error: "这个片段已锁定：先解锁再调整淡入淡出" };
          }
          // A proposal states MILLIseconds; the timeline stores seconds. One
          // conversion, here, for the same reason dbToLinear exists — and `null`
          // means 「这一端不动」, so it keeps the clip's current value rather than
          // resetting the other end to zero.
          const secs = (ms, cur) => (Number.isFinite(ms) ? ms / 1000 : cur);
          return bool(
            ctx.timeline.op(
              "setClipFades",
              a.clipId,
              secs(a.fadeInMs, clip.fadeIn),
              secs(a.fadeOutMs, clip.fadeOut),
            ),
            "无法调整淡入淡出",
          );
        }
        case "setTransition":
          if (ctx.locks.is("timelineClip", a.clipId)) return { ok: false, error: "这个片段已锁定：先解锁再改转场" };
          return bool(ctx.timeline.op("setTransition", a.clipId, a.kind, a.durationMs), "无法设置转场（只有画面轨有转场）");
        // --- subtitles (§44–§45) -------------------------------------------- //
        case "updateSubtitle": {
          const track = subtitle.trackFor(subtitlesDoc, productionDoc.activeEpisodeId);
          if (!subtitle.findCue(track, a.cueId)) return { ok: false, error: `字幕 ${a.cueId} 不存在` };
          if (ctx.locks.is("subtitle", a.cueId)) return { ok: false, error: "这条字幕已锁定：先解锁再修改" };
          return bool(ctx.subtitles.applyFix(a.cueId, a.fields, meta), "无法修改这条字幕（时间可能无效）");
        }
        case "buildSubtitles": {
          const res = ctx.subtitles.generate();
          return res.added.length
            ? { ok: true, detail: `生成 ${res.added.length} 条字幕，保留 ${res.kept.length} 条，跳过 ${res.skipped.length} 处` }
            : { ok: false, error: res.skipped.length ? res.skipped.map((s) => s.reason).join("；") : "没有可用来生成字幕的台词与时间线时长" };
        }
        // --- rough cut + render (§41 / §57) --------------------------------- //
        case "buildRoughCut": {
          const res = ctx.timeline.buildRoughCut();
          return res.ok ? { ok: true, detail: res.summary } : res;
        }
        case "renderEpisode":
          return { ok: false, error: "渲染是异步动作：请在下方「后期控制台 · 成片」执行（它会等待 ffmpeg 完成后再报告）" };
        // --- lock (§50) ------------------------------------------------------ //
        case "lockItem":
          if (ctx.locks.is(a.scope, a.id)) return { ok: false, satisfied: true, error: "这一项本来就已锁定" };
          return bool(ctx.locks.set(a.scope, a.id, true), "无法锁定（这个对象可能不存在）");
        case "unlockItem":
          if (!ctx.locks.is(a.scope, a.id)) return { ok: false, satisfied: true, error: "这一项本来就没有锁定" };
          return bool(ctx.locks.set(a.scope, a.id, false), "无法解锁");
        case "prepareGeneration": {
          const g = ctx.episode.genModel(a.shotId, a.kind === "video" ? "video" : "image");
          return g && g.slot
            ? { ok: true, detail: g.missing.length ? `可以发起，但还缺：${g.missing.join("；")}` : "输入集合已就绪" }
            : { ok: false, error: "镜头身份未解析：无法组装生成输入" };
        }
        // --- 人物关系 (TASK-065 §2) ----------------------------------------- //
        //
        // CREATE-OR-REVISE, resolved HERE against the documents. The proposal only
        // claims a pair; whether that pair exists as a relationship, and whether
        // both characters exist at all, is a question about state that only this
        // layer can answer. A skill that got to decide would be able to create a
        // relationship for a character that was deleted.
        case "upsertRelationship": {
          const chars = productionDoc.characters || [];
          const missing = [a.aCharacterId, a.bCharacterId]
            .filter((id) => !chars.some((c) => c.characterId === id));
          if (missing.length) {
            return { ok: false, error: `人物不存在（已跳过）：${missing.join("、")}` };
          }
          if (a.aCharacterId === a.bCharacterId) {
            return { ok: false, error: "一段关系必须连接两个不同的人物" };
          }
          const existing = canondoc.relationshipBetween(productionDoc, a.aCharacterId, a.bCharacterId);
          if (existing) {
            // A REVISION NEVER BLANKS A FACET. Only the fields the proposal really
            // carries are written (skillapply already dropped the empty ones), so
            // 「补一条核心矛盾」 cannot erase the arc a creator wrote by hand.
            const ok = ctx.canon.updateRelationship(existing.relationshipId, a.fields);
            return ok
              ? { ok: true, detail: `已修改「${nameOfChar(a.aCharacterId)} × ${nameOfChar(a.bCharacterId)}」的 ${Object.keys(a.fields).length} 个字段` }
              : { ok: false, error: "无法修改这段关系" };
          }
          const rec = ctx.canon.addRelationship(a.aCharacterId, a.bCharacterId);
          if (!rec) return { ok: false, error: "无法建立这段关系" };
          ctx.canon.updateRelationship(rec.relationshipId, a.fields);
          return { ok: true, detail: `已建立「${nameOfChar(a.aCharacterId)} × ${nameOfChar(a.bCharacterId)}」` };
        }
        case "removeRelationship":
          return bool(
            ctx.canon.removeRelationship(a.relationshipId),
            "仍有剧集记录了这段关系的推进：先在「分集规划」移除该集的 Relationship Beat",
          );
        case "swapRelationshipDirection":
          return bool(ctx.canon.swapDirection(a.relationshipId), "这段关系不存在");
        case "proposeOutline":
          return { ok: false, error: "大纲提案的写回路径尚未接线（本检查点只接了分镜 / 参考 / Prompt / 审片）" };
        case "proposeScript":
          return { ok: false, error: "剧本提案的写回路径尚未接线（本检查点只接了分镜 / 参考 / Prompt / 审片）" };
        case "proposeBible":
          return { ok: false, error: "人物 / 场景地提案请走「作品设定」的剧本拆解确认门" };
        default:
          return { ok: false, error: `动作「${a.action}」尚未接线` };
      }
    },
  },

  // ---------------------------------------------------------------------- //
  // Shot production controller (CP4 / ADR-0057) — review approval + the
  // canonical References a shot uses. The ONLY write path for both.
  //
  // 生成成功 != 镜头完成: nothing here is set by a successful generation. A shot
  // reaches 已通过 because a human said so, and for no other reason.
  // ---------------------------------------------------------------------- //
  shot: {
    /** The DERIVED production stage of one shot (待设计 … 已通过). */
    stage: (shot) => shotprod.shotStage(productionDoc, shot, ctx.shot.mediaOf(shot)),
    stageCounts: (shots) => shotprod.stageCounts(productionDoc, shots, (s) => ctx.shot.mediaOf(s)),
    /** Whether a shot HAS a current image / video Asset — resolved through the
     *  proven shotId→slot index, never by position. */
    mediaOf: (shot) => {
      const slot = ctx.shot._slotOf(shot);
      if (!slot) return { image: false, video: false, videoAssetId: null };
      const vid = mediaref.currentRef(assetRegistry.videos, slot);
      return {
        image: !!mediaref.currentRef(assetRegistry.images, slot),
        video: !!vid,
        // WHICH video is current — an approval is bound to this exact take, so
        // switching the variant or adding a newer one retires the approval
        videoAssetId: vid && vid.assetId ? vid.assetId : null,
        // …and WHICH VERSION of it, because a layer-1 Decision is invalid without
        // it (系统合同 §6.2): a decision that cannot say which take it judged can
        // never go stale, so 「已定稿的不是当前版本」 becomes unanswerable (§6.4).
        videoVersion: vid && Number.isInteger(vid.version) ? vid.version : null,
      };
    },
    _slotOf: (shot) => {
      const draft = ctx.project.draftShots || [];
      const shotId = shot && typeof shot.shotId === "string" ? shot.shotId : null;
      return shotId ? slotForShotId(buildShotSlotIndex(draft), shotId) : null;
    },
    isApproved: (shotId) => shotprod.isApproved(productionDoc, shotId),
    review: (shotId) => shotprod.reviewOf(productionDoc, shotId),
    /** The shot entry for a creativeShotId in the CURRENT draft, or null. */
    find: (shotId) => (ctx.project.draftShots || []).find(
      (s) => s && typeof s.shotId === "string" && s.shotId === shotId,
    ) || null,
    /** Record 「通过」. REFUSED without a current video: 审片 is a judgement about
     *  the shot as it will be seen, so approving one with nothing to watch would
     *  record a review that never happened. Enforced HERE, in the sole write
     *  path — a UI-only guard leaves every other caller free to bypass it. */
    approve: (shotId, note) => {
      const shot = ctx.shot.find(shotId);
      const media = shot ? ctx.shot.mediaOf(shot) : null;
      if (!media || !media.video || !media.videoAssetId) {
        toast("这个镜头还没有视频，无法通过审片——先生成或导入视频");
        return false;
      }
      // 系统合同 §6.4 / TASK-072 §1.5: an approval IS a layer-1 ReviewDecision.
      // Built FIRST, because it is the record that must exist — the legacy marker
      // below is kept for one version as a comparison surface (TASK-074 §1.3 deletes
      // it), and writing the marker while failing to record the decision would leave
      // the two disagreeing with the weaker one winning.
      const at = new Date().toISOString();
      const dec = review.decision({
        decisionId: `dec-shot-${shotId}-${Date.now().toString(36)}`,
        layer: "shot",
        targetId: shotId,
        verdict: "passed",
        by: "user",
        basedOnVersion: media.videoVersion,
        at,
        note: note || "",
      });
      if (!dec.ok) {
        // FAIL CLOSED rather than approve without saying which take was approved.
        toast(`无法记录审片结论：${dec.error}`);
        return false;
      }
      const ok = shotprod.approveShot(productionDoc, shotId, media.videoAssetId, at, note || "");
      if (ok) {
        reviewsDoc = { ...reviewsDoc, decisions: [...reviewsDoc.decisions, dec.value] };
        ctx.persist();
        refreshProductionView();
      }
      return ok;
    },
    /** Withdraw an approval. The legacy marker is REMOVED (「没有记录通过」 is the
     *  state, not 「approved: false」), but the Decision is APPENDED to, never
     *  deleted: it happened, on a take that existed. G5 「只追加」 applies to the
     *  review log too — a withdrawn approval that vanished would make the history
     *  claim the creator never approved it. */
    unapprove: (shotId) => {
      if (!shotprod.isApproved(productionDoc, shotId)) return false;
      const prev = review.latestDecision(reviewsDoc.decisions, { layer: "shot", targetId: shotId });
      const undo = review.decision({
        decisionId: `dec-shot-${shotId}-${Date.now().toString(36)}`,
        layer: "shot",
        targetId: shotId,
        verdict: "needs_rework",
        by: "user",
        // the SAME version the withdrawn approval judged: this decision is about
        // that take, and inventing a current version here would misdate it
        basedOnVersion: prev && Number.isInteger(prev.basedOnVersion) ? prev.basedOnVersion : null,
        at: new Date().toISOString(),
        note: "撤销通过",
      });
      const ok = prodOp(shotprod.unapproveShot(productionDoc, shotId));
      // A legacy approval carries no version, so no valid Decision can be written for
      // it. The withdrawal still takes effect — refusing it would strand the shot —
      // and the missing counterpart is honest: there was never a Decision to retire.
      if (ok && undo.ok) {
        reviewsDoc = { ...reviewsDoc, decisions: [...reviewsDoc.decisions, undo.value] };
        ctx.persist();
      }
      return ok;
    },
    // --- shared canonical References ---------------------------------------- //
    references: (shotId) => shotprod.referencesOfShot(productionDoc, shotId),
    addReference: (shotId, key) => prodOp(shotprod.addShotReference(productionDoc, shotId, key)),
    /** Unbind, and FORGET the per-binding side override with it (TASK-066 §5).
     *
     *  Leaving the override behind would resurrect a stale choice the next time the
     *  same reference is bound to the same shot — the creator would get a side they
     *  set once, long ago, on a binding they had since removed. The order matters:
     *  the override is cleared only when the unbind really happened. */
    removeReference: (shotId, key) => {
      const ok = shotprod.removeShotReference(productionDoc, shotId, key);
      if (ok) refuse.forget(refUseDoc, shotId, key);
      return prodOp(ok);
    },
    /** Which shots share one Reference — 「SH01 / SH02 / SH05 → 林照 Ref v3」. */
    shotsUsingReference: (key) => shotprod.shotsUsingReference(productionDoc, key),
    /** Drop bindings to references that no longer exist, so no phantom chip
     *  survives a deletion. */
    pruneReferences: () => {
      const live = new Set(assetreg.listReferences(assetRegistry).map((r) => r.key));
      const removed = shotprod.pruneShotReferences(productionDoc, live);
      if (removed) { ctx.persist(); refreshProductionView(); }
      return removed;
    },
  },
  // Dailies read model (CP4) — the active episode's review sequence, in
  // CANONICAL order. Derived on every render; only the approval is persisted.
  dailies: {
    model: () => {
      const ep = proddoc.activeEpisode(productionDoc);
      const draft = ctx.project.draftShots || [];
      const view = ep ? proddoc.episodeView(productionDoc, ep.episodeId, draft) : null;
      return dailiesModel({
        prod: productionDoc,
        view,
        mediaOf: (s) => ctx.shot.mediaOf(s),
        urlOf: (s) => {
          const slot = ctx.shot._slotOf(s);
          return slot ? mediaref.slotUrl(assetRegistry.videos, slot) : "";
        },
      });
    },
  },
  // ---------------------------------------------------------------------- //
  // Episode Production controller (CP6 / ADR-0058) — the read models behind
  // 本集制作 and 参考统筹, plus the manual generation round trip.
  //
  // Everything here DERIVES from the canonical documents on every call. The
  // only writes are the two the creator explicitly asks for — bind a
  // Reference, import a generation result — and both go through the existing
  // single write paths (ctx.shot.addReference / ctx.media.importShotMedia),
  // never around them.
  // ---------------------------------------------------------------------- //
  episode: {
    view: () => {
      const ep = proddoc.activeEpisode(productionDoc);
      return ep ? proddoc.episodeView(productionDoc, ep.episodeId, ctx.project.draftShots || []) : null;
    },
    /** The canonical References bound to a shot, RESOLVED to their current
     *  version. A binding whose reference no longer exists is dropped from the
     *  view (never rendered as a phantom chip) — pruning it from the document
     *  is ctx.shot.pruneReferences's job, not a render's. */
    referencesOfShot: (shotId) => {
      const byKey = new Map(assetreg.listReferences(assetRegistry).map((r) => [r.key, r]));
      return shotprod.referencesOfShot(productionDoc, shotId)
        .map((key) => byKey.get(key))
        .filter(Boolean)
        .map((r) => ({
          key: r.key,
          kind: r.kind,
          name: assetreg.derivedLabel(r),
          version: r.version,
          assetId: r.assetId,
          url: r.url,
          storageState: r.storageState,
          // ADR-0061 决策 4: a Reference can be a video or an audio take, so the
          // renderer must be told WHICH element to use. Deriving it from the
          // kind would be wrong for the multi-domain directing references.
          domain: r.domain,
        }));
    },
    mediaUrl: (shot, domain) => {
      const slot = ctx.shot._slotOf(shot);
      return slot ? mediaref.slotUrl(assetRegistry[domain], slot) : "";
    },
    /** Does this shot have a voice take of its own?
     *
     *  Deliberately NOT "does the episode have any audio": scene ambience and
     *  episode BGM belong to the scene and the episode, and counting them here
     *  would report every shot in a scored episode as having audio — which is the
     *  opposite of what a creator looking for missing dialogue needs to see. */
    hasShotAudio: (shotId) => {
      const shot = ctx.shot.find(shotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      return !!(slot && mediaref.currentRef(assetRegistry.audio, `voice-${slot}`));
    },
    /** The Reference picker's three entrances: what this shot already has,
     *  what THIS episode suggests (a reference for a character/location that
     *  appears in the shot's own scene), and the whole library. */
    pickerModel: (shotId) => {
      const bound = ctx.episode.referencesOfShot(shotId);
      const boundKeys = new Set(bound.map((r) => r.key));
      const all = assetreg.listReferences(assetRegistry).map((r) => ({
        key: r.key, kind: r.kind, name: assetreg.derivedLabel(r),
        version: r.version, assetId: r.assetId, url: r.url, links: r.links,
        domain: r.domain,
        // carried so the picker can say 已归档 / 字节已移除 instead of
        // rendering a broken image — the reference still exists and is still
        // bindable; only its bytes are away
        storageState: r.storageState || "local",
      }));
      const owner = proddoc.sceneOfShot(productionDoc, shotId);
      const wantChar = new Set((owner ? owner.scene.characterRefs || [] : []).map((r) => r.characterId));
      const wantLoc = owner && owner.scene.locationRef ? owner.scene.locationRef.locationId : null;
      const suggested = all.filter((r) => !boundKeys.has(r.key) && (
        (r.links && r.links.characterId && wantChar.has(r.links.characterId))
        || (r.links && r.links.locationId && r.links.locationId === wantLoc)
      ));
      const suggestedKeys = new Set(suggested.map((r) => r.key));
      return {
        bound,
        suggested,
        library: all.filter((r) => !boundKeys.has(r.key) && !suggestedKeys.has(r.key)),
      };
    },
    /** The Generation Input Set + the effective prompt for one shot. */
    genModel: (shotId, kind) => {
      const pd = ctx.prodData();
      const d = shotDetailModel(pd, shotId);
      const shot = ctx.shot.find(shotId);
      const owner = proddoc.sceneOfShot(productionDoc, shotId);
      const epIndex = productionDoc.episodes.findIndex(
        (e) => owner && e.episodeId === owner.episode.episodeId,
      );
      const compiled = d ? (kind === "video" ? d.prompts.video : d.prompts.image) : { text: "", missing: [] };
      // The frames come from the SAME resolution the prompt was compiled from
      // (shotDetailModel.frames): an explicit start-frame BINDING when there is
      // one — 上一镜的尾帧 — else the shot's own current image. Re-deriving them
      // here is how the Input Set ends up naming a different picture than the
      // prompt it sits beside (§7 / §4).
      const set = geninput.buildInputSet({
        shot,
        context: {
          shotId,
          sceneId: owner ? owner.scene.sceneId : null,
          episodeId: owner ? owner.episode.episodeId : null,
          sceneTitle: owner ? owner.scene.title : null,
          episodeCode: epIndex >= 0 ? `EP${String(epIndex + 1).padStart(2, "0")}` : null,
        },
        references: ctx.episode.referencesOfShot(shotId),
        // FRAMES ARE A VIDEO INPUT. An image generation is framed by neither —
        // its prompt compiles no frame and its request attaches none — so
        // carrying the end frame into an image set made `generationSeedFrom`
        // record it in `inputAssetIds`, and the lineage then claimed an asset
        // that contributed nothing to that image.
        frames: d && kind === "video"
          ? { start: d.frames.start, end: d.frames.end }
          : null,
        interpretation: d ? d.refInputs.interpretation : [],
        prompt: compiled.text,
        // A manual external run reports NOTHING about the model it used, so
        // model/parameters/seed stay null until an import tells us otherwise.
        runtime: { source: "手工外部生成", model: null, parameters: null, seed: null },
      });
      return {
        set,
        prompt: compiled.text,
        // both the compiler's honest gaps and the input set's own
        missing: [...compiled.missing, ...geninput.missingForGeneration(set, { kind })],
        slot: d ? d.slot : null,
      };
    },
    copyPrompt: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        toast("Prompt 已复制——粘贴到你的生成工具，结果回来点「上传外部生成结果」");
      } catch {
        toast("复制失败：请手动选中文本复制");
      }
    },
    /** Temp upload from the picker. It is NOT a shortcut around registration:
     *  the file becomes a real canonical Reference (its own `ref-…` chain,
     *  declared kind, linked to the scene's subject when there is one) and is
     *  then bound to the shot. There is no path here that leaves media
     *  unregistered. */
    uploadReference: async (shotId, kind) => {
      // ADR-0061 决策 4: the picker offers exactly the media types this reference
      // KIND is allowed to be. It used to ask for images unconditionally, so the
      // four directing references (motion / camera / performance / video style)
      // had visible upload buttons that could not accept a clip — an advertised
      // control that cannot do what it says (codex review round 3).
      const file = await pickFile(acceptForKind(kind));
      if (!file) return null;
      const owner = proddoc.sceneOfShot(productionDoc, shotId);
      const links = {};
      if (owner) {
        if (kind === "character-reference") {
          const first = (owner.scene.characterRefs || [])[0];
          if (first) links.characterId = first.characterId;
        } else if (kind === "location-reference" && owner.scene.locationRef) {
          links.locationId = owner.scene.locationRef.locationId;
        }
      }
      try {
        const { key } = await ctx.assets.importReference({ kind, file, links });
        ctx.shot.addReference(shotId, key);
        return key;
      } catch (err) {
        toast(`上传参考失败：${err.message}`);
        return null;
      }
    },
    /** The manual generation round trip closes HERE: the external result comes
     *  back, is registered as an Asset on this shot, and the Generation record
     *  freezes the prompt and the reference/frame inputs it was made from — so
     *  the Workflow graph can show the whole chain afterwards. */
    importResult: async (shotId, kind, file, promptText, fromSkillRunId = null) => {
      const g = ctx.episode.genModel(shotId, kind);
      if (!g.slot) { toast("镜头身份未解析：无法定位媒体槽位"); return null; }
      // the creator's own text wins verbatim, including when they cleared it —
      // only a caller that has no field at all (null) falls back to the set
      const seed = geninput.generationSeedFrom(g.set, { type: kind, promptSnapshot: promptText });
      // ADR-0059: an origin is recorded ONLY when the caller names the run this
      // was launched from, OR when the creator explicitly pressed 「用于生成」 on
      // a proposal for THIS shot (ADR-0061 决策 3). Both are statements the
      // creator made; neither is a search for "the proposal that was probably
      // behind this".
      const origin = fromSkillRunId
        ? ctx.skills.originOf(fromSkillRunId)
        : ctx.skills.pendingOriginFor(shotId);
      const ref = await ctx.media.importShotMedia(kind, g.slot, shotId, file, {
        shotId,
        prompt: seed.promptSnapshot,
        entry: "manual",
        seed: origin ? { ...seed, origin } : seed,
      });
      return ref;
    },
  },
  // Reference Planning read model (CP6) — the episode's reference material as
  // ONE plan. Derived; it never copies a canonical Asset.
  refplan: {
    model: () => referencePlan({
      view: ctx.episode.view(),
      bindings: (shotId) => shotprod.referencesOfShot(productionDoc, shotId),
      references: assetreg.listReferences(assetRegistry),
      sceneOf: (shotId) => {
        const owner = proddoc.sceneOfShot(productionDoc, shotId);
        if (!owner) return null;
        return {
          sceneId: owner.scene.sceneId,
          title: owner.scene.title,
          characterIds: (owner.scene.characterRefs || []).map((r) => r.characterId).filter(Boolean),
          locationId: owner.scene.locationRef ? owner.scene.locationRef.locationId : null,
        };
      },
      names: ctx.assets.names(),
    }),
    shotName: (shotId) => {
      const s = ctx.shot.find(shotId);
      return s ? (s.title || `镜头 ${s.sequence}`) : "";
    },
    /** Fill a gap: upload a reference FOR a named subject. The subject is the
     *  reason the gap exists, so it is linked at registration — the creator
     *  never has to re-state what they just answered. */
    uploadFor: async (kind, subjectId) => {
      const file = await pickFile("image/png,image/jpeg,image/webp");
      if (!file) return null;
      const links = kind === "character-reference"
        ? { characterId: subjectId }
        : { locationId: subjectId };
      try {
        const { key } = await ctx.assets.importReference({ kind, file, links });
        return key;
      } catch (err) {
        toast(`上传参考失败：${err.message}`);
        return null;
      }
    },
  },
  // ---------------------------------------------------------------------- //
  // Unified Production read model (CP8 / ADR-0059 要求 9).
  //
  // ONE model over Story · Episode · Scene/Shot · References · Skill runs ·
  // Generations · Assets · QC/review · Final — and it returns the CONTEXT IDS
  // it read, so anything the AI Director observes or decides can be traced
  // back to exactly the canon it was looking at.
  //
  // Read-only. It writes nothing and copies no story content (要求 8).
  // ---------------------------------------------------------------------- //
  prodgraph: {
    model: (scope = {}) => prodgraph.productionModel({
      story: storyDoc,
      scripts: scriptDocs,
      production: productionDoc,
      draftShots: ctx.project.draftShots || [],
      assets: assetRegistry,
      generations: generationRegistry,
      skillRuns: skillRunRegistry,
      timelines: timelinesDoc,
      finals: assetRegistry.finals,
    }, scope),
    /** Runs whose context the document never captured. Real history that
     *  belongs to no episode — surfaced, never swept into the active one. */
    runsWithoutContext: () => prodgraph.runsWithoutContext(skillRunRegistry),
  },
  // read-only registry view for the storage workspace (writes stay on the
  // ctx.storage / mediaref paths)
  assetRegistryView: () => assetRegistry,
  // ---------------------------------------------------------------------- //
  // Asset Registration controller (CP2 / ADR-0055) — the ONE import path.
  //
  // 上传 ≠ 保存文件。Every page that produces or receives media calls
  // `ctx.assets.import*`: the file is written by the existing upload endpoint
  // (collision-safe `<slug>_v<N>.<ext>`), DECLARED in the same call, registered
  // through the M3 single media write path, and immediately visible everywhere.
  // No page implements its own upload logic, so no page can forget a step.
  // ---------------------------------------------------------------------- //
  assets: {
    KINDS: assetreg.ASSET_KINDS,
    KIND_LABEL: assetreg.ASSET_KIND_LABEL,
    /** Every registered Asset, flattened (the asset library / picker / Director
     *  all read this one derivation). */
    list: () => assetreg.listAssets(assetRegistry),
    /** The canonical References — one entry per `ref-…` chain at its CURRENT
     *  version. This is the unit many shots SHARE; never copied per shot. */
    references: () => assetreg.listReferences(assetRegistry),
    find: (assetId) => assetlib.findAssetById(assetRegistry, assetId),

    /** Import a file as a NEW canonical Reference (人物 / 场景 / 道具 / 风格 /
     *  外部). Mints its own `ref-…` chain so later takes of the SAME reference
     *  append as v2, v3 … rather than becoming unrelated assets. */
    importReference: async ({ kind, file, links, displayName, tags } = {}) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法上传参考图");
      if (!assetreg.isReferenceKind(kind)) throw new Error(`不是参考类型：${kind}`);
      if (!file) throw new Error("没有选择文件");
      const key = assetreg.mintReferenceKey();
      const domain = mediaDomainOfFile(file);
      // An unresolvable domain must FAIL HERE. Falling through would hand
      // addVersion a `{uploads: undefined}` map, which quietly creates a throw-
      // away object: the upload would succeed on disk and be gone after reload.
      // (The server would refuse the write anyway — its type allow-list reads
      // the same MIME — so this is the honest error, not a new restriction.)
      if (!domain) {
        throw new Error("无法识别文件类型：请上传 png/jpg/webp、mp4/webm 或 mp3/wav");
      }
      // The kind's OWN allowed domains decide (ADR-0061 决策 4), rather than
      // 「images unless external」: a motion reference is legitimately a clip, and
      // a performance reference is legitimately a line read. The declaration
      // check below re-verifies this, so the guarantee does not rest on this
      // message being right.
      const allowed = assetreg.domainsForKind(kind);
      if (!allowed.includes(domain)) {
        const zh = { images: "图片", videos: "视频", audio: "音频" };
        throw new Error(
          `${assetreg.ASSET_KIND_LABEL[kind] || kind} 只能是 ${allowed.map((d) => zh[d] || d).join(" / ")}`,
        );
      }
      // checked BEFORE the upload — see ctx.audio.importKey
      const pre = assetreg.checkDeclaration(domain, { kind });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await query.uploadAssetImage(PROJECT_NAME, `${domainSlugPrefix(domain)}-${key}`, file);
      const ref = mediaref.refFromResponse(key, "upload", res, null);
      const decl = assetreg.declare(ref, domain, {
        kind,
        displayName: displayName || null,
        originalFilename: file.name || null,
        links,
        tags,
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: assetRegistry[domain] }, key, ref);
      ctx.refreshType("assets");
      ctx.persist();
      refreshProductionView();
      toast(`已登记参考资产「${assetreg.derivedLabel({ ...ref, version: ref.version })}」`);
      return { key, ref };
    },

    /** Append a NEW VERSION to an existing canonical Reference — 林照 Ref v2,
     *  v3 … The chain, its kind and its links are the reference's; only the
     *  bytes are new. Every shot pointing at this reference follows the
     *  chain's current pointer, so nothing has to be re-pointed by hand. */
    importReferenceVersion: async (key, file) => {
      if (!CONNECTED) throw new Error("演示模式无后端，无法上传参考图");
      if (!assetreg.isReferenceKey(key)) throw new Error("不是参考资产");
      const chain = mediaref.slotEntry(assetRegistry.images, key)
        || mediaref.slotEntry(assetRegistry.videos, key)
        || mediaref.slotEntry(assetRegistry.audio, key);
      if (!chain) throw new Error("参考资产不存在");
      const head = chain.history[chain.history.length - 1] || {};
      const domain = mediaDomainOfFile(file);
      if (!domain) {
        throw new Error("无法识别文件类型：请上传 png/jpg/webp、mp4/webm 或 mp3/wav");
      }
      if (!assetRegistry[domain] || !mediaref.slotEntry(assetRegistry[domain], key)) {
        throw new Error("新版本的媒体类型与该参考资产不一致");
      }
      // checked BEFORE the upload — see ctx.audio.importKey
      const pre = assetreg.checkDeclaration(domain, { kind: head.kind || null });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await query.uploadAssetImage(PROJECT_NAME, `${domainSlugPrefix(domain)}-${key}`, file);
      const ref = mediaref.refFromResponse(key, "upload", res, null);
      const decl = assetreg.declare(ref, domain, {
        kind: head.kind || null,
        displayName: head.displayName || null,
        originalFilename: file.name || null,
        links: head.links,
        tags: head.tags,
        reusable: head.reusable === true,
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: assetRegistry[domain] }, key, ref);
      ctx.refreshType("assets");
      ctx.persist();
      refreshProductionView();
      toast(`参考资产已新增 v${ref.version}（旧版本保留，可回切）`);
      return ref;
    },

    /** Pick a file and append it as a new version of an existing Reference.
     *  Thin wrapper so the Production Inspector never opens its own upload path
     *  (ADR-0055: 上传 ≠ 保存文件 — one entrance, one registration). */
    uploadReferenceVersion: async (key) => {
      if (!assetreg.isReferenceKey(key)) throw new Error("不是参考资产");
      const chain = mediaref.slotEntry(assetRegistry.images, key)
        || mediaref.slotEntry(assetRegistry.videos, key)
        || mediaref.slotEntry(assetRegistry.audio, key);
      if (!chain) throw new Error("参考资产不存在");
      const head = chain.history[chain.history.length - 1] || {};
      // Only the domains this reference's KIND is allowed in — a picker that
      // offers an mp3 for a 人物参考 invites a refusal the creator cannot
      // predict. `accept` follows the declaration, not the other way round.
      const domains = new Set(assetreg.domainsForKind(head.kind || null));
      const accept = [
        domains.has("images") ? "image/png,image/jpeg,image/webp" : "",
        domains.has("videos") ? "video/mp4,video/webm" : "",
        domains.has("audio") ? "audio/mpeg,audio/wav" : "",
      ].filter(Boolean).join(",") || "image/png,image/jpeg,image/webp";
      const file = await pickFile(accept);
      if (!file) return null;
      return ctx.assets.importReferenceVersion(key, file);
    },

    /** One chain's full version list, for the version block in the Production
     *  Inspector. Read-only; the switch itself goes through ctx.media.setCurrent
     *  so there is still exactly one write path for an active pointer. */
    chainOf: (key) => {
      for (const domain of ["images", "videos", "audio"]) {
        const e = mediaref.slotEntry(assetRegistry[domain], key);
        if (!e) continue;
        return {
          domain,
          current: e.current,
          list: e.history.map((r) => ({
            version: r.version,
            url: r.url || "",
            origin: r.origin || "",
            assetId: r.assetId || null,
            current: r.version === e.current,
            storageState: r.storageState || "local",
          })),
        };
      }
      return null;
    },

    /** Edit an Asset's CREATOR metadata. Always an explicit user action —
     *  nothing in the system reclassifies an asset on its own. */
    update: (assetId, fields) => {
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      // the record's OWN domain gates a kind change — the same rule declare()
      // applies at import, so the edit path cannot mint an invalid document
      if (!hit || !assetreg.updateDeclaration(hit.record, fields, hit.domain)) return false;
      ctx.persist();
      refreshProductionView();
      return true;
    },
    addTag: (assetId, tag) => {
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      if (!hit || !assetreg.addTag(hit.record, tag)) return false;
      ctx.persist();
      refreshProductionView();
      return true;
    },
    removeTag: (assetId, tag) => {
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      if (!hit || !assetreg.removeTag(hit.record, tag)) return false;
      ctx.persist();
      refreshProductionView();
      return true;
    },
    /** Mark / unmark 可复用. EXPLICIT only: "used many times" is never taken as
     *  consent to call something reusable (ADR-0055 决策 1). */
    setReusable: (assetId, on) => ctx.assets.update(assetId, { reusable: on === true }),
    /** Switch a chain's CURRENT version — the Active variant everything reads. */
    setCurrent: (domain, key, version) => ctx.media.setCurrent(
      domain === "images" ? "image" : domain === "videos" ? "video" : "audio", key, version,
    ),

    // --- Asset Library read models (CP5) ----------------------------------- //
    // All DERIVED per render: the library owns no state, so it cannot disagree
    // with what the project actually holds.
    /** Where every asset is used — one pass over the canonical documents. */
    usage: () => assetusage.usageIndex({
      assets: assetreg.listAssets(assetRegistry),
      production: productionDoc,
      timelines: timelinesDoc,
      generations: generationRegistry,
    }),
    usageOf: (assetId) => {
      const hit = assetlib.findAssetById(assetRegistry, assetId);
      // a Shot binds the CHAIN, which resolves to one version — so shot usage
      // belongs to the current take only, never to the ones it superseded
      const chain = hit && hit.key && assetRegistry[hit.domain]
        ? mediaref.slotEntry(assetRegistry[hit.domain], hit.key)
        : null;
      return assetusage.usageOfAsset({
        assetId,
        referenceKey: hit ? hit.key : null,
        // the version is on the left on purpose: the single-media-write-path
        // guard scans raw text for an assignment to a chain's current pointer,
        // and a comparison written the other way round is indistinguishable
        // from one by substring. This only ever reads.
        isCurrent: !chain || hit.record.version === chain.current,
        production: productionDoc,
        timelines: timelinesDoc,
        generations: generationRegistry,
      });
    },
    library: (filters) => assetlibws.libraryModel({
      assets: assetreg.listAssets(assetRegistry),
      usage: ctx.assets.usage(),
      names: ctx.assets.names(),
      filters,
    }),
    /** One asset in the library's shape, even when the current filters hide it
     *  — an inspector that closes because you ticked a filter is maddening. */
    libraryOne: (assetId) => ctx.assets.library({ type: "all", variant: "all" })
      .rows.find((r) => r.assetId === assetId) || null,
    /** id → human name, so search and filters work on what the creator SEES. */
    names: () => {
      const prod = productionDoc;
      const ch = new Map((prod.characters || []).map((c) => [c.characterId, c.name]));
      const lo = new Map((prod.locations || []).map((l) => [l.locationId, l.name]));
      const ep = new Map();
      const sc = new Map();
      (prod.episodes || []).forEach((e, i) => {
        ep.set(e.episodeId, `EP${String(i + 1).padStart(2, "0")} ${e.title}`);
        for (const s of e.scenes || []) sc.set(s.sceneId, s.title);
      });
      const sh = new Map((ctx.project.draftShots || []).map((s) => [s.shotId, s.title || ""]));
      const get = (m) => (id) => (id && m.get(id)) || "";
      return { character: get(ch), location: get(lo), episode: get(ep), scene: get(sc), shot: get(sh) };
    },
    /** The dropdown options — only canonical objects that really exist. */
    filterOptions: () => {
      const prod = productionDoc;
      const sources = [...new Set(assetreg.listAssets(assetRegistry).map((a) => a.origin).filter(Boolean))];
      return {
        characters: (prod.characters || []).map((c) => ({ id: c.characterId, name: c.name })),
        locations: (prod.locations || []).map((l) => ({ id: l.locationId, name: l.name })),
        episodes: (prod.episodes || []).map((e, i) => ({ id: e.episodeId, name: `EP${String(i + 1).padStart(2, "0")} ${e.title}` })),
        sources: sources.map((s) => ({ id: s, name: s })),
      };
    },
    /** The Generation that produced this asset, with its frozen inputs resolved
     *  to names. Honest null when nothing recorded producing it. */
    provenanceOf: (assetId) => {
      const gen = generationRegistry.find(
        (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(assetId),
      );
      if (!gen) return null;
      const nameOf = (id) => {
        const hit = assetlib.findAssetById(assetRegistry, id);
        if (!hit) return `${id}（已删除）`;
        return assetreg.derivedLabel({ ...hit.record, version: hit.record.version, key: hit.key });
      };
      return {
        generation: gen,
        references: [...(gen.referenceAssetIds || []), ...(gen.inputAssetIds || [])].map(nameOf),
      };
    },
  },
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
      // CP4/ADR-0057 决策 5: removing the LAST version of a canonical Reference
      // removes its chain, and any shot still bound to that key would render a
      // chip that points at nothing. Prune here — this is the one place a
      // reference actually ceases to exist. (Generation provenance is NOT
      // pruned: a dangling `referenceAssetIds` link is by design, because it
      // records the historical fact that this asset WAS used.)
      const prunedRefs = shotprod.pruneShotReferences(
        productionDoc,
        new Set(assetreg.listReferences(assetRegistry).map((r) => r.key)),
      );
      ctx.refreshType("assets");
      ctx.refreshType("video");
      ctx.refreshType("audio");
      ctx.persist();
      refreshProductionView();
      toast(
        `已永久删除资产（溯源记录保留${refs.provenance ? `，${refs.provenance} 条生成记录的链接将悬空——按设计如实保留` : ""}` +
        `${prunedRefs ? `；已清理 ${prunedRefs} 处镜头参考绑定` : ""}）`,
      );
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
      const domain = kind === "image" ? "images" : "videos";
      const declKind = kind === "image" ? "shot-image" : "shot-video";
      // The DECLARED kind comes from which entry the creator used; the FILE has
      // to agree with it. A file input's `accept` is a hint the picker can be
      // told to ignore, so without this an mp4 chosen under 「图片」 would be
      // registered into the images chain as a `shot-image` — a registration
      // that states something the bytes contradict, and the one thing CP2's
      // rules exist to prevent. Checked BEFORE the upload, so a refusal never
      // leaves a file on disk.
      const fileDomain = mediaDomainOfFile(file);
      if (!fileDomain) {
        throw new Error("无法识别文件类型：请上传 png/jpg/webp 或 mp4/webm");
      }
      if (fileDomain !== domain) {
        throw new Error(
          `这是${fileDomain === "videos" ? "视频" : fileDomain === "audio" ? "音频" : "图片"}文件，` +
          `但当前是「${kind === "image" ? "图片" : "视频"}」入口——切换到对应的入口再导入`,
        );
      }
      // checked BEFORE the upload — see ctx.audio.importKey
      const pre = assetreg.checkDeclaration(domain, { kind: declKind });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await query.uploadAssetImage(PROJECT_NAME, slug, file);
      const map = kind === "image" ? assetRegistry.images : assetRegistry.videos;
      const ref = mediaref.refFromResponse(slot, "upload", res, shotId ?? null);
      // CP2/ADR-0055: the import declares WHAT this is and WHERE it belongs, in
      // the same call that writes it — the shot is known, so its episode/scene
      // context is a provable fact, not a guess.
      const decl = assetreg.declare(ref, domain, {
        kind: declKind,
        displayName: null,
        originalFilename: (file && file.name) || null,
        links: contextOfShot(shotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: map }, slot, ref);
      // A Generation is recorded whenever this import CAME FROM a generation —
      // which is what an `intent` means. It is NOT gated on there being a
      // prompt: an external run started from reference images and a first frame
      // with no prompt at all is still a generation, and its inputs are still
      // real lineage. Gating on the prompt threw all of that away and left the
      // result looking like a plain import (codex review, round A4). An import
      // with no intent at all stays a plain import — honestly, and by design.
      //
      // `intent.entry` counts as well as a seed or a prompt: the entry names
      // WHICH generation route this came back from, so an intent carrying one
      // is a generation even if its prompt happens to be empty. Keying only on
      // text made "was this generated" depend on whether anything was typed.
      if (intent && intent.shotId === shotId && (intent.seed || intent.entry || intent.prompt)) {
        // CP6: when the caller assembled a Generation Input Set, the record is
        // built FROM it — so the references and first frame the creator was
        // actually given are frozen into the lineage, not lost because the
        // manual route had nowhere to put them. The older entry path (which
        // knows only the prompt) keeps its minimal record; both produce the
        // same SHAPE, and what a route cannot know stays null.
        const gen = ctx.startGeneration(intent.seed ? {
          ...intent.seed,
          provider: intent.entry || intent.seed.provider || "manual",
          status: "generating",
        } : {
          type: kind === "image" ? "image" : "video",
          targetType: shotId ? "shot" : null,
          targetId: shotId ?? null,
          promptSnapshot: intent.prompt,
          provider: intent.entry || "manual",
          parameters: null,
          status: "generating",
        });
        if (gen) {
          ctx.completeGeneration(gen.generationId, [ref.assetId]);
          // the asset's own back-link to the Generation that produced it — the
          // Generation already records the result, this closes the loop so an
          // asset opened from the library can name its origin without a scan
          ref.links.generationId = gen.generationId;
        }
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
  // the Episode/Scene a shot PROVABLY belongs to — the context every asset
  // registration stamps into its links (CP2). Unassigned shots resolve to
  // nulls; the active episode is never substituted as a stand-in.
  contextOfShot: (shotId) => contextOfShot(shotId),
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
  // ⚙ 项目设置 (TASK-073 §1.7). `deliverySpec` is read by ⚙ and by 交付质检's 规格
  // check; `setDeliverySpecField` is the ONLY write path and refuses invalid values.
  deliverySpec,
  setDeliverySpecField,
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
      // CP7: the per-episode script documents, so the provenance graph can
      // start where the work actually starts. READ-ONLY, like every other
      // registry here — writes stay on ctx.script.
      scripts: scriptDocs,
      // CP8/ADR-0059: the skill-run registry, so the graph can show what was
      // ASKED of the canon and what came back. READ-ONLY; writes via ctx.skills.
      skillRuns: skillRunRegistry,
      // TASK-051A: the AI Director's Production Plan / Asset Inbox DERIVE from
      // existing state and own nothing. They need the whole Asset Registry
      // (finals/displaced/unresolvedPaid, not just the chain maps) and the
      // per-episode timelines. Exposed READ-ONLY here, exactly like the other
      // registries above — no second copy, no new document.
      assets: assetRegistry,
      timelines: timelinesDoc,
      // TASK-064 Phase 2 / Phase 3 documents, READ-ONLY here exactly like the
      // registries above — writes stay on ctx.refInterp / ctx.frames / ctx.locks /
      // ctx.shotAudio / ctx.subtitles. `shotDetailModel` needs refInterp and
      // frameBindings to compile a reference-aware prompt, and it is the ONE
      // compiler, so they belong in the read model rather than being fetched
      // separately by each caller.
      refInterp: refInterpDoc,
      refUse: refUseDoc,
      frameBindings: frameBindingsDoc,
      shotAudio: shotAudioDoc,
      subtitles: subtitlesDoc,
      locks: locksDoc,
    };
  },
  // paid-op status projection (生成情况) — refreshed after paid actions AND
  // auto-polled while any op is in flight (TASK-048 第2步; read-only)
  paidOps: {},
  paidOpsAll: [],
  loadPaidOps: async () => {
    if (!CONNECTED) return;
    try {
      const ops = await query.paidOps(PROJECT_NAME);
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

// --- controllers extracted from the literal above (TASK-073 §1.8) ------------- //
//
// Attached AFTER `ctx` rather than inside the literal: the factories take `ctx`-level
// helpers (`prodOp`, `findShotAudioClip`) and, for some, `ctx` itself, which cannot be
// referenced while the literal is still being evaluated. Nothing in the literal calls
// these during evaluation — every property there is a function body — so the order is
// safe, and a test asserts the controller is present on `ctx`.
//
// Documents are passed as GETTERS. They are module-level `let`s that project loading
// REASSIGNS, so handing over their current values would leave a controller writing to
// the previous project's documents forever.
ctx.timeline = createTimelineController({
  docs: {
    timelines: () => timelinesDoc,
    production: () => productionDoc,
    assets: () => assetRegistry,
    shotAudio: () => shotAudioDoc,
    subtitles: () => subtitlesDoc,
  },
  session: {
    projectName: () => PROJECT_NAME,
    connected: () => CONNECTED,
  },
  modules: { timeline, roughcut, proddoc, mediaref, assetlib, shotaudio, subtitle, command },
  helpers: {
    timelineSourceSig, buildShotSlotIndex, slotForShotId, toast, refreshProductionView,
    now: () => new Date().toISOString(),
  },
  getCtx: () => ctx,
});

ctx.locks = createLockController({
  docs: {
    locks: () => locksDoc,
    prompts: () => promptsDoc,
    shotAudio: () => shotAudioDoc,
    frameBindings: () => frameBindingsDoc,
    refInterp: () => refInterpDoc,
  },
  modules: { locksdoc, promptdoc, shotaudio, framebind, refinterp },
  findShotAudioClip,
  prodOp,
  now: () => new Date().toISOString(),
});

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
// `onNavigate` keeps the top bar honest: the shell reports its own space after
// every render, so an in-shell move (「进入剧集制作 →」, an empty state's jump, a
// provenance hand-off) can never leave 故事开发 highlighted while 剧集制作 is on
// screen. The bar never derives the active space itself — there is one owner.
const production = createProduction(() => ctx, { onNavigate: () => syncTopBar() });
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
  // A shot's home is 剧集制作 (ADR-0061 决策 2). `openShot` opens the space AND
  // selects the shot; a refusal (unsaved edit) leaves the creator exactly where
  // they were rather than moving them somewhere they did not ask for.
  production.openShot(shotId, "workbench");
  syncTopBar();
};
/** Mount the provenance graph into the 剧集制作 centre column (ADR-0061 决策 2).
 *
 *  `embedded` suppresses the graph's own node-detail aside: that detail is the
 *  LEFT inspector's job now, so rendering it here too would put one object in two
 *  places. The shell re-renders so the LEFT column can follow the graph's
 *  selection — but ONLY when the selection actually changed.
 *
 *  That guard is load-bearing, not defensive: the shell's render mounts the graph,
 *  mounting renders the graph, and the graph reports its selection back to the
 *  shell. Re-rendering unconditionally on that report is an infinite loop. What
 *  the LEFT column needs is the CHANGE, so the change is what it is told about.
 */
let provSelected = null;
ctx.mountProvenance = (box, rerender) => {
  wfGraph.mount(box, {
    embedded: true,
    onSelectionChange: () => {
      const id = wfGraph.selectedId();
      if (id === provSelected) return;
      provSelected = id;
      // The LEFT inspector shows the selected node when there IS one, and the
      // shot when there is not — so a selection change is what moves that column.
      if (rerender) rerender();
    },
  });
  wfGraph.render();
};
// ADR-0061 决策 2 / TASK-064 §11: the relations filter (上游 / 下游 / 完整链路)
// belongs to the LEFT Production Inspector now, but what it filters is the
// provenance graph. The graph stays its owner — the inspector only drives it —
// so there is still ONE trace mode rather than a copy in the shell that could
// disagree with what the graph is actually dimming.
ctx.relationsMode = () => wfGraph.state.traceMode;
ctx.setRelationsMode = (mode) => wfGraph.setTraceMode(mode);
ctx.focusProvenanceNode = (nodeId) => wfGraph.focusNode(nodeId);
/** The selected provenance node's story — what the LEFT inspector renders when
 *  the centre is showing 生成溯源. Null when nothing is selected. */
ctx.provenanceSelection = () => wfGraph.selection();
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
/** WHICH shot owns a shot-audio clip. Clip ids are minted unique, so this
 *  lookup is deterministic — and it is what lets a Skill proposal name a clip
 *  without also having to name the shot it happens to be under (a proposal that
 *  named the wrong shot would otherwise be applied to a clip in it).
 *  Returns `{ shotId, clip }` or null. */
function findShotAudioClip(clipId) {
  if (typeof clipId !== "string" || !clipId) return null;
  for (const shotId of Object.keys(shotAudioDoc)) {
    const clip = shotaudio.findClip(shotAudioDoc, shotId, clipId);
    if (clip) return { shotId, clip };
  }
  return null;
}

/** A character's NAME for a message about it. Falls back to the id rather than to
 *  「某个人物」: a report the creator cannot match to a row is not a report. */
function nameOfChar(characterId) {
  const c = bibledoc.findCharacter(productionDoc, characterId);
  return c && c.name ? c.name : String(characterId || "");
}

/** The 题材/基调 of the CONFIRMED plan's outline, or "" when there is none.
 *
 *  Resolved through storydoc exactly the way `promptInputs` (ui/storyboard.js) does
 *  for a shot prompt, so an entity's base prompt and the shots that use it carry
 *  the same style line — two derivations of 「这部作品什么调子」 would be two answers. */
function confirmedGenreTone() {
  if (!storyDoc) return "";
  const plan = (storyDoc.plans || []).find((x) => x.v === storyDoc.confirmedPlan) || null;
  const o = storydoc.outlineForPlan(storyDoc, plan);
  return o ? o.outline.genreTone || "" : "";
}

/**
 * Why a base-asset target cannot be written to, or "" when it can.
 *
 * ONE predicate, consulted before a long-running upload starts AND again after it
 * lands, because the window in between (a file dialog plus a server round trip) is
 * long enough for the entity or the state to be deleted. Returning the REASON rather
 * than a boolean is what lets the caller tell the creator which of the two vanished.
 */
function missingBaseTarget(kind, entityId, stateId) {
  const entity = kind === "character"
    ? bibledoc.findCharacter(productionDoc, entityId)
    : bibledoc.findLocation(productionDoc, entityId);
  if (!entity) return kind === "character" ? "这个人物已不存在" : "这个场景地已不存在";
  if (stateId && !(entity.states || []).some((s) => s.stateId === stateId)) {
    return `「${entity.name}」已经没有这个状态了`;
  }
  return "";
}

/** A STATE's own reference list + active pointer, or null when the state is gone.
 *
 *  `ids` is what the state currently SHOWS: its own override list when it has one,
 *  else the entity's — so seeding a state's first own reference does not silently
 *  drop the inherited ones (bibledoc keeps a state's active pointer inside the
 *  state's own list, so the two have to be written together). */
function stateRefs(kind, entityId, stateId) {
  const entity = kind === "character"
    ? bibledoc.findCharacter(productionDoc, entityId)
    : bibledoc.findLocation(productionDoc, entityId);
  const st = entity && (entity.states || []).find((x) => x.stateId === stateId);
  if (!st) return null;
  const resolved = kind === "character"
    ? bibledoc.resolveCharacter(entity, stateId)
    : bibledoc.resolveLocation(entity, stateId);
  return {
    entity,
    state: st,
    own: "referenceAssetIds" in (st.overrides || {}),
    ids: [...resolved.referenceAssetIds],
    active: resolved.activeReferenceAssetId,
  };
}

/** Write a state's reference list + active pointer through the ordinary overrides
 *  path. Every OTHER override the state carries is preserved: a reference edit must
 *  not blank the state's 外貌 / 服装 / 画面指令. */
function setStateRefs(kind, entityId, stateId, ids, active) {
  const cur = stateRefs(kind, entityId, stateId);
  if (!cur) return false;
  const next = {
    ...cur.state.overrides,
    referenceAssetIds: ids,
    activeReferenceAssetId: active && ids.includes(active) ? active : null,
  };
  return kind === "character"
    ? ctx.bible.setCharacterStateOverrides(entityId, stateId, next)
    : ctx.bible.setLocationStateOverrides(entityId, stateId, next);
}

/** dB → the LINEAR volume the episode timeline stores. The two layers use
 *  different units (shotaudio: dB, timeline: 0..2 linear), so the conversion
 *  exists exactly once — here — and every caller goes through it. */
function dbToLinear(currentLinear, deltaDb) {
  const base = Number.isFinite(currentLinear) ? currentLinear : 1;
  const next = base * 10 ** (deltaDb / 20);
  return Math.min(2, Math.max(0, next));
}

/** The project's delivery spec — read (TASK-073 §1.7).
 *
 *  A plain copy: callers render it and compare against it, never mutate it. The one
 *  write path is `ctx.setDeliverySpecField` below. */
function deliverySpec() {
  return { ...deliverySpecDoc };
}

/**
 * Set ONE ⚙ field — the ONLY write path (§1.7: 「唯一编辑入口」).
 *
 * Validated through the domain module, so a bad value is REFUSED rather than
 * coerced: `fps: "25"` silently becoming 25 would mean the stored spec and what the
 * creator typed are two different things, and only one of them was checked.
 *
 * An empty string CLEARS the field back to 「还没有设置」 — which must stay reachable,
 * or a mistyped cap could never be un-set, only replaced.
 */
function setDeliverySpecField(key, raw) {
  const field = SPEC_FIELD_BY_KEY[key];
  if (!field) return { ok: false, error: `未知的规格字段 ${key}` };
  if (raw === "" || raw === null || raw === undefined) {
    const next = { ...deliverySpecDoc };
    delete next[key];
    deliverySpecDoc = next;
    ctx.persist();
    refreshProductionView();
    return { ok: true, cleared: true };
  }
  // parse by DECLARED kind, never by guessing from the text
  let value = raw;
  if (field.kind === "int") {
    value = /^-?\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : raw;
  } else if (field.kind === "money") {
    const t = String(raw).trim();
    value = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : raw;
  }
  const err = validateField(key, value);
  if (err) return { ok: false, error: err };
  deliverySpecDoc = { ...deliverySpecDoc, [key]: value };
  ctx.persist();
  refreshProductionView();
  return { ok: true };
}

/** Remove / restore a timeline clip, REPORTING what the cascade left alone.
 *
 *  Removing a video clip takes its shot's anchored audio with it, but a LOCKED
 *  audio clip is not taken (TASK-072 §1.9 缺陷 4). That is the right behaviour and
 *  it must be visible: an unexplained audio clip still sitting in the cut after the
 *  picture left is exactly as confusing as one that silently vanished. */
function _setRemoved(clipId, on, failReason) {
  const skipped = [];
  const ok = ctx.timeline.op("setClipRemoved", clipId, on, {
    isLocked: (id) => ctx.locks.is("timelineClip", id),
    skipped,
  });
  if (!ok) return { ok: false, error: failReason };
  if (!skipped.length) return { ok: true };
  return {
    ok: true,
    note: on
      ? `${skipped.length} 条已锁定的音频没有跟着移出（先解锁才会一起移出）`
      : `${skipped.length} 条已锁定的音频没有跟着恢复（先解锁才会一起恢复）`,
  };
}

/** The version chain a timeline clip could be replaced FROM — the right one for
 *  its track (TASK-072 §1.9 缺陷 7).
 *
 *  Reads the SAME map + key vocabulary as `ctx.timeline.activeFor`, so 「这条片段
 *  当前是哪一版」 and 「它还能换成哪几版」 cannot disagree. Deliberately NOT
 *  `ctx.assets.chainOf`, which guesses the domain by searching images → videos →
 *  audio and therefore returns the first-frame IMAGE chain for a video slot.
 *
 *  `ambience` / `bgm` return null: they are owned by the scene / episode, not by a
 *  per-shot chain, so there is no shot-level alternative list to offer. An empty
 *  list is the honest answer — a wrong one invites a proposal that cannot apply. */
function _clipChain(shotId, trackType) {
  if (!shotId) return null;
  const shot = ctx.shot.find(shotId);
  const slot = shot ? ctx.shot._slotOf(shot) : null;
  if (!slot) return null;
  const key = trackType === "video"
    ? slot
    : trackType === "dialogue"
      ? `voice-${slot}`
      : trackType === "sfx"
        ? `sfx-${slot}`
        : null;
  if (!key) return null;
  const map = trackType === "video" ? assetRegistry.videos : assetRegistry.audio;
  return mediaref.slotEntry(map, key) || null;
}

/** Write one subtitle cue: a merge, a field edit, or BOTH (TASK-072 §1.9 缺陷 6).
 *
 *  The two used to be exclusive branches — `mergeWithNext === true` took the merge
 *  path and every other field in the same fix (`text`, `startMs`, `endMs`,
 *  `speaker`) was SILENTLY DROPPED while the surface reported success. A Subtitle
 *  Reviewer that says 「合并这两条，并把文字改成…」 is one fix, not two, and half of
 *  it landing is worse than none: the creator sees 已应用 and the text they were
 *  shown is not what is in the track.
 *
 *  BOTH OR NEITHER. The merge runs first (the field edit describes the merged
 *  window), and if the edit is then refused — a lock, a bad value — the merge is
 *  ROLLED BACK from a snapshot so the track never keeps half a fix. */
function _writeCue(cueId, fields, { force = false, origin = null } = {}) {
  const track = ctx.subtitles.track();
  if (!track || fields == null || typeof fields !== "object") return false;
  const at = new Date().toISOString();
  const isLocked = (id) => ctx.locks.is("subtitle", id);
  const opts = { at, force, isLocked, ...(origin ? { origin } : {}) };
  const rest = {};
  for (const k of Object.keys(fields)) {
    if (k !== "mergeWithNext") rest[k] = fields[k];
  }
  const hasRest = Object.keys(rest).length > 0;
  if (fields.mergeWithNext !== true) {
    return !!subtitle.updateCue(track, cueId, rest, opts);
  }
  // A DEEP snapshot. `slice()` copies the ARRAY but not the cues in it, and
  // `mergeCue` mutates the surviving cue in place (text, endMs, speaker) — so
  // restoring the array put back the next cue while the merged one KEPT its merged
  // text, producing duplicated/overlapping subtitles: exactly the half-applied fix
  // this function exists to prevent (independent review, batch 3).
  const snapshot = track.cues.map((c) => ({ ...c }));
  if (!subtitle.mergeCue(track, cueId, { at, isLocked })) return false;
  if (!hasRest) return true;
  if (!subtitle.updateCue(track, cueId, rest, opts)) {
    track.cues = snapshot; // refuse whole, keep nothing
    return false;
  }
  return true;
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

// ADR-0061 决策 1: the node canvas is a DIAGNOSTIC surface, not one of the
// creator's three spaces. It is reachable only at `?canvas=1` (or from the
// diagnostic bar itself) — Production is already the workflow, and the
// provenance graph explains what was generated from inside 剧集制作.
const CANVAS_DIAGNOSTIC = (() => {
  try {
    return new URLSearchParams(window.location.search).get("canvas") === "1";
  } catch {
    return false;
  }
})();

function showDiagnosticCanvas(on) {
  $("#viewport").style.display = on ? "block" : "none";
  $("#wf-hint").hidden = !on;
  $("#wf-tabs").hidden = !on;
  $("#wfgraph").hidden = true;
  if (on) {
    production.hide();
    renderStepbar(engine, $("#stepbar"), $("#entrybar")); // restores bar visibility
    ctx.refreshType("script"); // node summaries pick up workspace edits
  } else {
    $("#entrybar").style.display = "none";
    $("#stepbar").style.display = "none";
  }
}

/** Top-level SPACE switch: 故事开发 | 剧集制作 | 资产库. All three are the studio
 *  shell — they differ in which rail/inspector the left column carries and which
 *  workspace the centre shows — so there is one surface and one navigation state
 *  rather than three pages that can disagree about where the creator is. */
function setTopMode(space) {
  const highlight = (s) => {
    for (const [id, k] of [["#seg-story", "story"], ["#seg-episode", "episode"], ["#seg-assets", "assets"]]) {
      const el = $(id);
      if (el) el.classList.toggle("on", k === s);
    }
  };
  showDiagnosticCanvas(false);
  // the shell may REFUSE the switch (unsaved shot edits) — highlight what it
  // actually landed on, never what we asked for
  highlight(production.show(space));
}
/** Re-highlight the top bar from the shell's OWN state. Used after something
 *  outside the bar moved the creator (a provenance jump, an episode entrance) —
 *  the bar must report where they are, not where they last clicked. */
function syncTopBar() {
  const s = production.space();
  for (const [id, k] of [["#seg-story", "story"], ["#seg-episode", "episode"], ["#seg-assets", "assets"]]) {
    const el = $(id);
    if (el) el.classList.toggle("on", k === s);
  }
}
function goProduction() { setTopMode("story"); }
function goWorkflow() { setTopMode("episode"); }
$("#seg-story").onclick = () => setTopMode("story");
$("#seg-episode").onclick = () => setTopMode("episode");
$("#seg-assets").onclick = () => setTopMode("assets");
const wfExit = $("#wf-tab-exit");
if (wfExit) wfExit.onclick = () => setTopMode("episode");
const wfCanvasTab = $("#wf-tab-canvas");
if (wfCanvasTab) wfCanvasTab.onclick = () => showDiagnosticCanvas(true);
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
    res = await command.adoptPaid(PROJECT_NAME, taskId, `video-${before.slot}`);
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
    // CP2/ADR-0055: an adopted paid clip IS this shot's video — declared here,
    // where the owning shot has just been PROVEN stable across the await.
    // the FULL provable context (episode + scene + shot) — recording only part
    // of what the document proves would hide the clip from scene-scoped views
    assetreg.declare(ref, "videos", { kind: "shot-video", links: contextOfShot(cid ?? null) });
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
      const tgt = await query.getGenerationTarget(PROJECT_NAME, shotId);
      const opId = command.newOperationId(`op-ui-${s.sequence}-`);
      const envelope = command.buildEnvelope(
        "submit-video-generation",
        tgt.target,
        { ...tgt.params, operation_id: opId },
        "cmd-" + opId,
      );
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
      const pf = await command.preflight(PROJECT_NAME, envelope);
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
      await command.submit(PROJECT_NAME, envelope, pf.preflight_digest);
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
    // Skill Run provenance (CP3) — top-level, parallel to generations.
    skillRuns: skillRunRegistry,
    // Production structure (M6) — episodes/scenes owning shot REFERENCES only.
    production: proddoc.serialize(productionDoc),
    // Per-episode timelines (M11) — asset REFERENCES only, never media bytes.
    timelines: timeline.serialize(timelinesDoc),
    // Per-shot Prompt OVERRIDES (ADR-0061 决策 5). Only shots whose prompt was
    // really written appear here; the compiled prompt is a derivation and is
    // deliberately never stored, so it cannot go stale in the document.
    prompts: promptdoc.serialize(promptsDoc),
    // TASK-064 Phase 2 / Phase 3. All five are ADDITIVE and optional: a document
    // written before this checkpoint simply carries none of them and hydrates
    // empty, which is why no schema migration is needed — there is nothing to
    // back-fill, and inventing a reading / a binding / a lock the creator never
    // made would be exactly the fabricated record this codebase refuses.
    refInterp: refinterp.serialize(refInterpDoc),
    refUse: refuse.serialize(refUseDoc),
    frameBindings: framebind.serialize(frameBindingsDoc),
    locks: locksdoc.serialize(locksDoc),
    shotAudio: shotaudio.serialize(shotAudioDoc),
    subtitles: subtitle.serialize(subtitlesDoc),
    // TASK-067 §15: cached DERIVED CONCLUSIONS, each with the revision of the shot
    // context it was drawn from. Persisted so a reload does not silently re-spend
    // tokens re-deriving what is still valid — and so a conclusion that HAS gone
    // stale is still shown as stale rather than vanishing.
    ctxCache: ctxcache.serialize(ctxCacheDoc),
    // TASK-073 §1.7 / canvas v16: the PROJECT-level delivery spec (成片规格 +
    // 预算与限制). Deliberately separate from `timelines[].settings`, which is one
    // EPISODE's render settings — a render can legitimately differ from the delivery
    // target, and folding them together would make changing one change the other.
    deliverySpec: { ...deliverySpecDoc },
    // §6: issues an Agent may raise + decisions only the creator may make
    reviews: { issues: [...reviewsDoc.issues], decisions: [...reviewsDoc.decisions] },
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
  // Skill Run Registry (CP3): hydrate from the same save.
  skillRunRegistry = skillrun.createSkillRunRegistry((data && data.skillRuns) || null);
  // Production structure (M6): existing episode/scene ids survive verbatim; a
  // fresh/legacy canvas starts with the default single active episode.
  productionDoc = proddoc.createProduction((data && data.production) || null);
  // Per-episode timelines (M11).
  timelinesDoc = timeline.createTimelines((data && data.timelines) || null);
  // Per-shot Prompt overrides (ADR-0061 决策 5).
  promptsDoc = promptdoc.createPrompts((data && data.prompts) || null);
  // TASK-064 Phase 2 / Phase 3 documents (additive; absent → empty).
  refInterpDoc = refinterp.createInterpretations((data && data.refInterp) || null);
  refUseDoc = refuse.createRefUse((data && data.refUse) || null);
  frameBindingsDoc = framebind.createFrameBindings((data && data.frameBindings) || null);
  locksDoc = locksdoc.createLocks((data && data.locks) || null);
  shotAudioDoc = shotaudio.createShotAudio((data && data.shotAudio) || null);
  subtitlesDoc = subtitle.createSubtitles((data && data.subtitles) || null);
  // TASK-067 §15 (additive; absent → empty). Entries whose baseline no longer
  // matches hydrate fine and simply read as stale — that is the point.
  ctxCacheDoc = ctxcache.createCache((data && data.ctxCache) || null);
  // TASK-073 §1.7: absent → an EMPTY spec, never a guessed one. A historical document
  // recorded none of these fields and back-filling them would be fabrication
  // (TASK-074 §1.3 同规).
  deliverySpecDoc = (data && data.deliverySpec && typeof data.deliverySpec === "object"
    && !Array.isArray(data.deliverySpec)) ? { ...data.deliverySpec } : {};
  const rv = data && data.reviews;
  reviewsDoc = {
    issues: rv && Array.isArray(rv.issues) ? [...rv.issues] : [],
    decisions: rv && Array.isArray(rv.decisions) ? [...rv.decisions] : [],
  };
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
  promptsDoc = promptdoc.createPrompts(null);
  // …and the Phase 2 / Phase 3 documents. Cleared HERE too, not only in
  // restoreGraph: entering a project whose canvas is empty never calls restore,
  // so anything left here would carry the PREVIOUS project's readings, frame
  // bindings, locks, audio arrangement and subtitles into it.
  refInterpDoc = refinterp.createInterpretations(null);
  refUseDoc = refuse.createRefUse(null);
  frameBindingsDoc = framebind.createFrameBindings(null);
  locksDoc = locksdoc.createLocks(null);
  shotAudioDoc = shotaudio.createShotAudio(null);
  subtitlesDoc = subtitle.createSubtitles(null);
  // …and the conclusion cache. Carrying it across a project switch would show one
  // project's asset recommendations under another project's shot ids.
  ctxCacheDoc = ctxcache.createCache(null);
  deliverySpecDoc = {};
  reviewsDoc = { issues: [], decisions: [] };
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
    skillRunRegistry = skillrun.createSkillRunRegistry(null);
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
  // Default creator-facing space: 故事开发 (ADR-0061 决策 1) — the work starts by
  // writing the story. `?canvas=1` opens the diagnostic node canvas instead; it
  // is not one of the creator's three spaces and has no top-bar entry.
  if (CANVAS_DIAGNOSTIC) showDiagnosticCanvas(true);
  else goProduction();
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

/**
 * The outcome of the LAST `listProjects()` call, or null when it succeeded.
 *
 * IT BELONGS TO THE FETCH, NOT TO THE RENDER. Three review rounds went into this one
 * flag because the lifetime kept being managed inside `renderLanding`:
 *   round 1 — no flag: a redraw reverted the note to 「已连接后端」 over an empty grid;
 *   round 2 — sticky for the session: a later redraw WITH projects still showed the
 *             fault, turning 「瞬时错误被抹掉」 into 「错误永久显示」;
 *   round 3 — cleared whenever `realNames` was non-empty: creating one project after
 *             the failure flipped the note to success while the list was still
 *             unreadable — exactly the 「你没有项目」 misreading it exists to prevent.
 *
 * Every one of those is the same mistake: a RENDER deciding the truth of a FETCH.
 * A redraw learns nothing new about the backend, and locally adding a project does
 * not make the list readable. So only `fetchProjectList` writes this, and
 * `renderLanding` merely reads it.
 */
let LIST_ERROR = null;

/** The ONE place the project list is fetched, and therefore the one place its
 *  outcome is recorded. Returns the names; the error travels in `LIST_ERROR`. */
async function fetchProjectList() {
  try {
    const names = await query.listProjects();
    LIST_ERROR = null; // a successful READ is the only thing that clears it
    return names;
  } catch (e) {
    LIST_ERROR = e;
    return [];
  }
}

function renderLanding(realNames) {
  const projectsError = LIST_ERROR;
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
    // A FAULT READS AS A FAULT (验收 #5). An empty project grid caused by a 500 is
    // indistinguishable from an account with no projects, and only one of them is
    // something the creator can act on.
    note.classList.toggle("bad", !!projectsError);
    note.textContent = projectsError
      ? `读取项目列表失败：${projectsError.message || projectsError}——这不是「你没有项目」，是后端没能给出列表`
      : CONNECTED
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

/** Load the capability catalog from the backend (TASK-075 §1.4).
 *
 *  FAIL CLOSED (ADR-0067 决策 7): if the payload is rejected, NOTHING installs
 *  and the recorded reason is the loader's own message. A partially installed
 *  catalog would offer capabilities whose output contract never arrived — the
 *  page would let a creator run one and then have no way to judge the answer. */
async function installSkillCatalog() {
  // A REJECTION must not abort the bootstrap. Only `res.ok === false` was handled, so
  // any throw out of `fetchSkillCatalog` propagated through `await` in `boot()` and
  // left a blank app instead of a stated 「能力目录不可用」 (independent review,
  // batch 3) — the same shape as the batch-1 `listProjects` defect.
  let res;
  try {
    res = await query.fetchSkillCatalog();
  } catch (e) {
    CATALOG_DETAIL = `能力目录不可达：${(e && e.message) || e}`;
    CATALOG_PROBLEMS = [];
    return;
  }
  if (!res.ok) {
    CATALOG_DETAIL = res.detail;
    CATALOG_PROBLEMS = [];
    return;
  }
  // Load failures travel WITH the catalog: `problems[]` is how a broken package
  // stays visible instead of silently vanishing from the list (§1.7). Entries
  // whose skillId could not be read carry an empty id — kept, and labelled, so a
  // list view never renders a nameless row (批次 A 交接项).
  CATALOG_PROBLEMS = (Array.isArray(res.payload.problems) ? res.payload.problems : []).map(
    (p) => ({ ...p, skillId: p && p.skillId ? p.skillId : "（未能读出能力 ID）" }),
  );
  try {
    skills.installCatalog(res.payload);
    CATALOG_DETAIL = "";
  } catch (e) {
    CATALOG_DETAIL = `能力目录无法安装：${e.message}`;
  }
}

// --- async bootstrap ---
async function boot() {
  const m = await query.detectMode();
  CONNECTED = m.mode === "connected";
  PAID = CONNECTED && m.paid === true;
  setModeBadge();
  await installSkillCatalog();
  REAL_NAMES = [];
  // TASK-072 §1.4 验收 #5. `listProjects` now THROWS a classified error instead of
  // swallowing a fault into `[]` — so this, its only caller, has to handle it. It is
  // caught HERE rather than in the seam because the decision is a product one: a
  // backend fault must read AS A FAULT (not 「你没有项目」), and it must not take the
  // whole bootstrap down before the landing screen is ever drawn.
  if (CONNECTED) {
    REAL_NAMES = await fetchProjectList();
    // A FAULT IS NOT AN EMPTY ACCOUNT. With no list read, there is no default
    // project to speak of — naming one anyway lets a later action target a project
    // the backend never listed (independent review, batch 1 round 2).
    DEFAULT_NAME = LIST_ERROR ? null : REAL_NAMES[0] || "draft";
    if (!LIST_ERROR && REAL_NAMES[0]) {
      PROJECT_NAME = REAL_NAMES[0];
      try { REAL_STANDING = realmap.mapStanding(await query.getQuery(REAL_NAMES[0], "budget")); } catch { REAL_STANDING = null; }
    }
  } else {
    DEFAULT_NAME = "local-draft";
  }
  renderLanding(REAL_NAMES);
  renderBudget();
}
// LAST RESORT. `boot()` is async and was invoked bare, so ANY rejection inside it
// became an unhandled rejection and left a blank page with nothing on screen to
// explain it. A boot that cannot finish must still say so.
boot().catch((e) => {
  const note = $("#landing-note");
  if (note) {
    note.textContent = `启动失败：${(e && e.message) || e}——页面没有加载完，请刷新或检查后端`;
    note.classList.add("bad");
  }
  console.error("motv: boot failed", e);
});
