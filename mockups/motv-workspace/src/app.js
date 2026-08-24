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
// TASK-081: URL 即状态 — the address is written from the shell's own state and
// read back through `resolveModule`, never through a second mapping table.
import {
  formatRoute, parseRoute, sameRoute, loadLastRoute, saveLastRoute,
} from "./services/route.js";
import * as persist from "./services/persist.js";
import { grabVideoFrame } from "./services/videoframe.js";
import { CANVAS_SCHEMA_VERSION } from "./services/canvasschema.js";
import * as realmap from "./services/realmap.js";
import { createRouteLatch } from "./services/routelatch.js";
import * as mediaprobe from "./services/mediaprobe.js";
import { createInspector } from "./ui/inspector.js";
import { createEstimate } from "./ui/estimate.js";
import { createWizard, wizardReadiness } from "./ui/wizard.js";
import { createShotEditor, normalizeShots, nextDraftVersion } from "./ui/shoteditor.js";
import { mintId } from "./workflow/identity.js";
import { createViews } from "./ui/landing.js";
// TASK-082 §1.3: the landing card finally says something about the film
import { projectCardModel, pickCover, cardStats, renderCover } from "./ui/landingcard.js";
// 步骤就绪判定**只有一份**，在向导定义旁边。控制器不复述它 —— 复述就是 §2.5e
// 那条缝（两处陈述同一件事实），而这一批的 P1 正是从「上游要求是手写的」来的。
import { stepReadiness } from "./ui/prodwizard.js";
import { createProduction } from "./ui/production.js";
import { dailiesModel } from "./ui/dailies.js";
import { reviewBoardModel } from "./ui/cutreview.js";
import { shotDetailModel, buildPortraitIndex } from "./ui/storyboard.js";
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
import {
  SPEC_FIELD_BY_KEY, validateField, specCheckForCut,
} from "./workflow/deliveryspec.js";
// TASK-073 §1.8: controllers extracted from this file, one per domain
import { createLockController } from "./controllers/lockctl.js";
import { createReferenceController } from "./controllers/refctl.js";
import { createPromptController } from "./controllers/promptctl.js";
import { createSubtitleController } from "./controllers/subtitlectl.js";
import { createShotAudioController } from "./controllers/shotaudioctl.js";
import { createFrameController } from "./controllers/framectl.js";
import { createAssetController } from "./controllers/assetctl.js";
import { createTimelineController } from "./controllers/timelinectl.js";
import { createSkillController } from "./controllers/skillctl.js";
import { createMotionPreviewController } from "./controllers/motionctl.js";
// TASK-072 §1.5/§1.6: the three review layers and the five gates, as domain
import * as review from "./workflow/review.js";
import * as reviewsync from "./workflow/reviewsync.js";
import { g3TriggerFor, g3Retire, g4Export } from "./workflow/gates.js";
import * as deliveryqc from "./workflow/deliveryqc.js";
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
import * as episodecleanup from "./workflow/episodecleanup.js";
import * as timeline from "./workflow/timeline.js";
import * as bibledoc from "./workflow/bibledoc.js";
import * as canondoc from "./workflow/canondoc.js";
import * as shotprod from "./workflow/shotprod.js";
import * as shotstage from "./workflow/shotstage.js";
import * as poststatus from "./workflow/poststatus.js";
import * as shotqc from "./workflow/shotqc.js";
import * as breakdown from "./workflow/breakdown.js";
// TASK-065: the creator-object-first surfaces. All three are PURE read models over
// documents this file already owns — none of them introduces a store.
import * as baseassets from "./workflow/baseassets.js";
import * as relgraph from "./workflow/relgraph.js";
import * as shotgraph from "./workflow/shotgraph.js";
import * as canvasnodes from "./workflow/canvasnodes.js";
import * as canvasgrow from "./workflow/canvasgrow.js";
import * as counts from "./workflow/counts.js";
import * as genspec from "./workflow/genspec.js";
import * as sceneplan from "./workflow/sceneplan.js";
import * as assetprep from "./workflow/assetprep.js";
import * as sbdraft from "./workflow/sbdraft.js";
import * as keyframe from "./workflow/keyframe.js";
import * as motionpreview from "./workflow/motionpreview.js";
import * as promptbatch from "./ui/promptbatch.js";
import * as videobatch from "./ui/videobatch.js";
import {
  installShotMirror, softDeleteShot, restoreShot, deletionImpact, mergeKeepingRecycled,
} from "./workflow/shotdelete.js";
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
// TASK-074 §1.2 接线：一次真实 ffprobe/ffmpeg 测量的结果，连同它测的是哪个成片。
//
// NOT persisted, deliberately. A probe describes ONE rendered file; the moment a
// new cut is composed the numbers are about the wrong file. Storing them would
// make stale measurements look current on the delivery screen — worse than
// having none, because 未检查 at least tells the truth.
let DELIVERY_PROBE = { assetId: null, name: null, probe: null, error: null, running: false };
// 逐镜时长测量（批次 5B）。**同样不持久化，同样理由**：一次测量说的是**那一个文件**
// 的事，换了一条视频它就在说别的文件。所以键是**视频的 assetId** —— 换 take、加新版本，
// 上一次的测量自动不再匹配，界面回到「还没测过」而不是显示一个旧数字。
//
// 值：`{ name, durationS?, error?, running }`。「没测过」= 键不在表里；
// 「没跑成」= 有 error。两者会把创作者送到不同的地方，所以不能合成一个。
// `media-audit?measure=` 的五种具名失败状态各自的说法（TASK-087 §3.5.4）。
// 服务端刻意把它们分开命名，因为每一种把创作者送到**不同的下一步**：
// 装 ffprobe、去找文件、改文件名、换一条视频。压成一句「探测失败」就等于
// 把这个端点专门保留下来的那个区分丢掉。
const SHOT_MEASURE_STATE = {
  bad_name: "这条视频的文件名不合规，没法安全地去量",
  not_found: "这个文件不在项目的 media 目录里",
  no_ffprobe: "这台机器上没有 ffprobe，量不了（装上再试）",
  unreadable: "文件在，但 ffprobe 读不出可用的时长",
};

const SHOT_PROBES = new Map();
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
// `grabVideoFrame` 搬进 `services/videoframe.js`（TASK-073 §1.8 · TASK-072 §1.9 #10）
// —— 它是这里唯一真正绑定浏览器的一步，留在 app.js 里就没人测得到它。
// 现在 `tests/e2e/test_video_frame_grab_task072.py` 在真的 Chromium 里驱动它。

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
// TASK-077 §1.2 — what is ACTUALLY on disk, as opposed to what the registry
// DECLARES. Session-scoped and never serialized: it is an observation about this
// moment, not a fact about the project, and writing it into the canvas would be
// exactly the persistent-state change this card refuses to make.
const mediaProbe = mediaprobe.createMediaProbe();

/** url → ffprobe 结果（TASK-103 批次 C / TASK-087 §4.3）。
 *
 *  **只在创作者按下「测量」时才填**，一次一个文件。整块自动测量会让 60 镜的
 *  审片页一次起 60 个 ffprobe —— 那正是 TASK-087 §3.5.4 记下来的重端点问题，
 *  换个地方重犯一遍没有意义。
 *
 *  不落盘：资产登记表里仍然没有像素尺寸字段，加它是一次 schema 改动，有自己的
 *  归属。这里是显示用的会话内缓存，跟 `mediaProbe` 同一个姿态。 */
const mediaMeasured = new Map();

/** 最近一次目录审计的清单（文件名 → {bytes}）。审计本身在 `scanRegistry` 里做，
 *  这里只留结果，供审片页显示真实字节数。空表 = 还没审计过，不是「都不在」。 */
let mediaAuditFiles = {};
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
// `coreSync` (TASK-103 批次 B) 是**回执台账**，不是第二份结论：decisionId →
// 这条结论有没有走进核心项目、没走进是因为什么。结论本身仍然只有 `decisions`
// 一份。分开存是因为 G5「只追加」管的是结论，而登记是一次可以重试的传输。
let reviewsDoc = { issues: [], decisions: [], coreSync: {} };

/** WHICH DOCUMENT IS LOADED RIGHT NOW (codex round 1, P1).
 *
 *  `syncReviewToCore` awaits the gateway and then writes into the module-level
 *  `reviewsDoc`. Switching projects during that await replaces the document, and
 *  the late write would drop the previous project's receipt into the NEW
 *  project's canvas — a receipt for a decision that canvas has never heard of.
 *  Bumped wherever the document is replaced wholesale; the async writer captures
 *  it before the await and refuses to write if it moved. */
let canvasEpoch = 0;
// The 「用于生成」 intent (ADR-0061 决策 3) MOVED with the skill controller
// (src/controllers/skillctl.js): it is session state owned by exactly two of that
// controller's methods, so it belongs beside the rules that govern it.

// --- budget readout (real in CONNECTED, fixture otherwise) ---
function renderBudget() {
  if (CONNECTED && REAL_STANDING) {
    const s = REAL_STANDING;
    // TASK-077 §1.1: an UNAVAILABLE field prints `—`, never `¥0`. 「余额 ¥0」 on a
    // project that merely has no `config/wfm1.json` is the one audit defect a
    // creator could act wrongly on — it reads as 「我没钱了」.
    const low = s.remaining.available && s.total.available && s.total.value > 0
      && s.remaining.value < s.total.value * 0.15;
    // …and the backend's `problems[]` finally gets a surface. The whole readout
    // already opens 真实项目数据; the ⚠ says there is something to read there.
    // TASK-082 §1.1: the count comes from `realmap.problemCount`, which ⚙ 项目健康
    // also calls — ONE counter, so the badge and its own drill-down panel can
    // never print two different numbers from one source.
    // …across EVERY envelope read so far, deduplicated — the same union
    // ⚙ 项目健康 prints (TASK-082 §1.1). At boot only the budget's is available,
    // which is why `loadHealth` calls `renderBudget()` when the rest arrive.
    const envelopes = HEALTH.project === PROJECT_NAME ? HEALTH.envelopes : [];
    const union = realmap.problemUnion(s, ...envelopes);
    const nProblems = union.length;
    const warn = nProblems
      // THE TOOLTIP LISTS THE SAME UNION IT COUNTS. Listing only the budget's own
      // problems while counting all four is the same defect one level down: the
      // creator opens 「⚠ 2」 and is shown one line (independent review, round 2).
      ? `<span class="bwarn" title="${esc(union.map((p) => p.detail).join("\n"))}">⚠ ${nProblems}</span>`
      : "";
    const html =
      `<span>已花 <b>${realmap.yenOf(s.spent)}</b></span><span class="sep">·</span>` +
      `<span>余额 <b class="bal" ${low ? 'style="color:var(--gate)"' : ""}>${realmap.yenOf(s.remaining)}</b></span>` +
      warn + `<span class="sep">▾</span>`;
    $$("#budget1,#budget2").forEach((e) => {
      e.innerHTML = html;
      e.title = s.complete ? "" : "这个项目没有可用的预算数据 — 点开看原因";
      e.onclick = openRealProjectData;
    });
    return;
  }
  const y = budget.yuan;
  const bal = budget.balance();
  const html = `<span>已花 <b>${y(budget.totalSpent())}</b></span><span class="sep">·</span><span>余额 <b class="bal" ${bal < 3000 ? 'style="color:var(--gate)"' : ""}>${y(bal)}</b></span><span class="sep">▾</span>`;
  $$("#budget1,#budget2").forEach((e) => { e.innerHTML = html; e.onclick = () => inspector.openCost(); });
}

/* -------------------------------------------------------------------------- */
/* ⚙ 项目健康 (TASK-082 §1.1)                                                  */
/* -------------------------------------------------------------------------- */
//
// FOUR READ-ONLY QUERIES THE FRONT END NEVER CALLED. `plan` / `problems` /
// `approvals` were served by the backend and consumed by nothing; `status` was
// only ever read for the cost drill-down. Fetched ONCE per project on demand and
// cached here — the shell renders synchronously, so a panel that awaited would
// blank the page while it ran (the same reason `ensureProbe` works this way).

// KEYED BY PROJECT, and read back through the same key. A module-level cache with
// no key showed project A's health under project B's name: `ensureHealth` saw
// `state !== "idle"` and skipped the load (independent review, round 1). That is
// the fabricated-observation failure this codebase keeps closing — so the key is
// checked at READ time, not merely reset on switch, and a stale entry can never
// be rendered even if some future path forgets to clear it.
const HEALTH_EMPTY = {
  project: null, state: "idle", status: null, plan: null,
  problems: null, approvals: null, envelopes: [], error: null,
};
let HEALTH = { ...HEALTH_EMPTY };
/** Which read is the CURRENT one. Two 「重新读取」 clicks race, and without this the
 *  slower (older) response wins simply by finishing last — the panel and the ⚠
 *  would then show data the creator已经 asked to replace (independent review,
 *  round 2). The project name alone cannot tell them apart: both are for the same
 *  project. */
let HEALTH_GEN = 0;

async function loadHealth() {
  if (!CONNECTED) {
    HEALTH = {
      ...HEALTH_EMPTY, project: PROJECT_NAME, state: "error",
      error: "演示模式没有后端——这四个查询由后端读项目目录得出，静态 demo 里不存在",
    };
    production.render();
    return;
  }
  const gen = ++HEALTH_GEN;
  HEALTH = { ...HEALTH_EMPTY, project: PROJECT_NAME, state: "loading" };
  production.render();
  const name = PROJECT_NAME;
  /** Is this still the read whose answer anyone is waiting for? */
  const current = () => gen === HEALTH_GEN && name === PROJECT_NAME;
  try {
    const [planJ, statusJ, problemsJ, approvalsJ] = await Promise.all([
      query.getQuery(name, "plan"),
      query.getQuery(name, "status"),
      query.getQuery(name, "problems"),
      query.getQuery(name, "approvals"),
    ]);
    // THE PROJECT MAY HAVE CHANGED WHILE THIS RAN. Writing another project's
    // readings into the panel is the fabricated-observation failure this codebase
    // keeps guarding against, so a late answer for a project we have left is
    // dropped rather than displayed.
    if (!current()) return;
    HEALTH = {
      project: name,
      state: "ok",
      plan: realmap.mapPlan(planJ),
      status: realmap.mapStages(statusJ),
      problems: realmap.mapProblemRows(problemsJ),
      approvals: realmap.mapApprovals(approvalsJ),
      // EVERY query's own `problems[]`. Only one of the four may have hit the
      // source failure that matters, and the budget read — the only one the ⚠ had
      // — is not necessarily that one (independent review, round 1).
      envelopes: [planJ, statusJ, problemsJ, approvalsJ].map(realmap.mapProblemEnvelope),
      error: null,
    };
  } catch (e) {
    if (!current()) return;
    HEALTH = { ...HEALTH_EMPTY, project: name, state: "error", error: (e && e.message) || String(e) };
  }
  production.render();
  // …and the ⚠ now has more sources than it did at boot, so it is recomputed from
  // the same union the panel prints.
  renderBudget();
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

/**
 * Build the envelope + provenance seed for ONE shot's paid video generation.
 *
 * SPLIT OUT for TASK-078 §3 (the generation card): 「⚡报价」 needs exactly the
 * same envelope the submit will use, because the preflight digest is bound to
 * THAT envelope. Quoting from a differently-built envelope would either be
 * rejected at submit or — worse — price one thing and run another.
 *
 * Read-only: it reaches the backend only for the generation target. Nothing is
 * reserved, nothing is written, nothing is spent.
 */
async function preparePaidVideo(shotId) {
  const tgt = await query.getGenerationTarget(PROJECT_NAME, shotId);
  const opId = command.newOperationId();
  const envelope = command.buildEnvelope(
    "submit-video-generation",
    tgt.target,
    { ...tgt.params, operation_id: opId },
    "cmd-" + opId,
  );
  const launch = resolveAdoptSlot(shotId);
  const launchSlot = launch && launch.slot ? launch.slot : null;
  const frameRef = launchSlot ? assetRegistry.firstFrames[launchSlot] : null;
  const p = tgt.params && typeof tgt.params === "object" ? tgt.params : null;
  return {
    envelope,
    opId,
    genSeed: {
      type: "video",
      targetType: launch && launch.creativeShotId ? "shot" : null,
      targetId: (launch && launch.creativeShotId) || null,
      inputAssetIds: frameRef && frameRef.assetId ? [frameRef.assetId] : [],
      promptSnapshot: p && typeof p.prompt === "string" ? p.prompt : null,
      provider: p && p.provider ? String(p.provider) : null,
      model: p && p.model ? String(p.model) : null,
      parameters: { ...(p || {}), operation_id: opId, task_id: envelope.params.task_id },
    },
  };
}

/**
 * 「⚡报价」 — the READ-ONLY half of ADR-0041's two steps, surfaced on its own.
 *
 * The preflight already computes the model, resolution, duration and the
 * locked-catalog price (`paid_gateway._preview`), and the UI has never shown any
 * of it: the creator met the number for the first time inside the confirm
 * dialog, one click from spending. This returns it so the card can put it next
 * to the submit button.
 *
 * IT IS NOT CONSENT. The quote is informational and can go stale; 提交 always
 * runs a FRESH preflight and shows the confirm dialog built from that one, so
 * what the creator approves is never this cached number (see `paidGenerate`).
 */
async function paidVideoQuote(shotId) {
  if (!PAID) throw new Error("付费模式未开启（--enable-paid）");
  const { envelope } = await preparePaidVideo(shotId);
  const pf = await command.preflight(PROJECT_NAME, envelope);
  const p = pf.preview || {};
  return {
    shotId,
    inputs: p.inputs || {},
    cost: p.estimated_cost || null,
    blockers: p.blockers || [],
    at: new Date().toISOString(),
  };
}

// --- REAL paid generation (ADR-0041 two-step: preflight → confirm → submit) ---
async function paidGenerate(shotId) {
  try {
    const prepared = await preparePaidVideo(shotId);
    const { envelope } = prepared;
    // M5: SNAPSHOT this video generation's provenance now, at envelope-build
    // time — these are the inputs the submitted job uses. Resolving at confirm
    // time instead would record whatever the draft looked like AFTER any edit
    // made while the confirm dialog was open, diverging from the submitted job.
    // The target is the canonical creativeShotId (never the slot); the input is
    // the shot's proven first-frame Asset; the correlation ids travel with the
    // frozen params so an adopt after reload can reconcile the record by task.
    //
    // Built by `preparePaidVideo` above, so 「⚡报价」 and 提交 cannot disagree
    // about what is being priced and what is being run (TASK-078 §3).
    const genSeed = prepared.genSeed;
    // ALWAYS A FRESH PREFLIGHT. The card may already be showing a quote, but a
    // cached number is not consent: the dialog the creator approves is built
    // from THIS response, so the price they confirm is the price in force now.
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
            // a DEFINITIVE server response saying not-success → mark failed,
            // WITH what the server actually said (TASK-079 §1.3). 「失败了」 with
            // no account of why is a dead end: the creator cannot tell a stale
            // packet from a rejected prompt from an exhausted budget, so they
            // cannot decide whether retrying unchanged is even sensible.
            const why = [receipt.status, oc.kind, receipt.reason].filter(Boolean).join(" · ");
            if (genId) ctx.failGeneration(genId, "failed", why || null);
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
    // THE EIGHT ITEMS, in demo mode too (TASK-089 §2.1) — a template still writing
    // only the v1 facets would make the offline walk-through look like the defect
    // this batch removes: an outline surface whose new sections are all empty.
    storyCore: `${idea}（演示模板）`,
    protagonist: { who: "李昭", initialWant: "活过今天这场殿前对答" },
    conflict: {
      external: "皇权的猜忌：答得好会被留下，答不好会被处死",
      internal: "他习惯了不出头 —— 每一次开口都在违背自己的生存本能",
    },
    worldAndRules: {
      where: "架空盛唐，宫廷礼法森严",
      rules: ["诗才即权力通行证", "当殿失仪者不得再入朝堂", "御前应答不得称『不知』"],
    },
    keyRelationships: [
      { between: ["李昭", "皇帝"], nature: "被试探的臣与试探人心的君", howItChanges: "由生死拿捏转为互相利用" },
      { between: ["李昭", "高内侍"], nature: "被守门人冷眼旁观", howItChanges: "由旁观转为暗中递话" },
    ],
    mainline: {
      setup: "被拖上大殿，三步成诗保命",
      development: "诗作传出宫墙，一夜成名，也被盯上",
      midpointTurn: "嫉恨者设局，命题诗暗藏杀机",
      climax: "以一首离席诗当众自证",
      ending: "换得自由身，留下传世之名",
    },
    secretsAndReveals: [
      { truth: "他的诗不是自己写的，是另一个时代的记忆", whyNotUpfront: "一开始揭穿就没有赌局了", revealAround: "中段转折前后" },
    ],
    themeAndChange: {
      theme: "被逼出来的才华，也是才华",
      protagonistBecomes: "从不肯出头的人，变成愿意为别人开口的人",
    },
    genreTone: "古装爽剧 · 紧张中带黑色幽默",
    characterConcepts: ["李昭：怯懦社畜，被逼觉醒的急智诗人", "皇帝：威压难测，以诗试人心", "高内侍：冷眼旁观的宫廷守门人"],
    episodeCount: 4,
    durationNote: "每集 60-90 秒",
    // kept so the demo also exercises the legacy-fallback path every existing
    // outline version of the real project takes
    premise: `${idea}（演示模板）`,
    logline: "小人物身怀现代记忆闯入权力之巅，每一次开口都是生死赌局。",
    world: "架空盛唐，宫廷礼法森严，诗才即权力通行证。",
    centralConflict: "现代灵魂的求生欲 VS 皇权的猜忌与规训",
    storyArc: "被迫登场 → 险中求胜 → 名动长安 → 树敌宫闱 → 抉择去留",
    climax: "殿前当众抗旨",
    ending: "以一首『离席诗』换得自由身，留下传世之名。",
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
    // THE SEVEN FACETS, in demo mode too (TASK-088 §2.1). A template still
    // producing only `synopsis`/`purpose` would make the demo walk-through look
    // like the defect this batch removes — an episode row whose new columns are
    // all empty. Everything stays labelled 演示模板, and no AI runs.
    return {
      epNumber: i + 1,
      title: b[0],
      coreGoal: `${b[2]}（演示模板）`,
      keyEvents: [`${b[1]}（演示模板）`, `${b[3]}`, `${b[4]}`],
      characterBeats: [{ who: "李昭", change: `${b[2]}（演示模板）` }],
      reveals: [`第 ${i + 1} 集的新信息（演示模板）`],
      emotionArc: "平静 → 紧张 → 转折",
      hook: b[3],
      endingBeat: b[4],
      duration: "60-90 秒",
      // kept so the demo also exercises the legacy-fallback path the real
      // project's four existing plan versions take
      synopsis: `${b[1]}（演示模板）`,
      purpose: b[2],
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
        ? await query.planEpisodes({
            outline: storydoc.approvedOutline(doc).outline,
            instruction,
            // WHAT IS BEING REVISED (TASK-094 批次 A) — and ONLY when this run is
            // a revision. `planRevisionBase` is the single predicate: the same one
            // `beginDevelop` used to decide whether the new version continues
            // these episodes, so what the model is shown and what the document
            // links to cannot disagree. A fresh 「重新规划」 sends no plan at all,
            // which is also how the backend selects `episode-planner`.
            currentPlan: storydoc.planRevisionBase(doc, instruction)
              ? storydoc.planForPrompt(storydoc.effectivePlanEpisodes(doc))
              : null,
            // …and the cast, so `characterBeats[].who` can name a real person
            characters: productionDoc.characters.map((c) => ({
              characterId: c.characterId, name: c.name, tier: c.tier,
            })),
          })
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

/** 真正问 Gateway 要一批提示词合成的总额（预检只读，从不扣费）。
 *
 * 留在 app.js 而不是跟着控制器走：它读的是 `ctx.gateway` 与 `query`，也就是
 * 这个文件负责组装的那两样东西。控制器通过 `preflight` 注入拿到它，测试替换
 * 的仍然是同一个缝。 */
async function askPromptBatchGateway(batch) {
  const envelope = ctx.gateway.buildEnvelope
    ? ctx.gateway.buildEnvelope({ kind: "prompt-compose", count: batch.items.length })
    : null;
  if (!envelope) return null;
  return query.preflight(PROJECT_NAME, envelope);
}

// --- UI singletons ---
const inspector = createInspector();
const est = createEstimate({ renderBudget, toast });

// --- shared context handed to every node def ---
// 镜头列表镜像 —— **一处决定「镜头列表是什么」**（TASK-097 批次 4B）。
//
// 读到的是存活镜头，回收的从 `shotMirror.recycled()` 单独取。`draftShots` 今天有
// 28 个文件在读；让每个调用点自己过滤就是 §2.6.1 那条「手写清单总会漏一项」，
// 而漏掉的那一处会显示一个已删除的镜头，或者把它算进「60 个镜头已就绪」。
//
// 项目对象每次换项目都会重建，所以镜像必须在**它出生的地方**装上 —— 这个 let
// 指向当前那个。
// 「一键合成全部提示词」当前那一批（批次 4D）。**只有一批**：两批同时跑会让
// 「已花多少」有两个来源，而那正是 batchpay 要挡的东西。
let promptBatchState = null;
//: 这个项目落下的那份流程（`studio/flow.json`），等着在全新画布上被应用一次。
//: 应用完就清空 —— 它是一次性的开局，不是一份持续生效的配置。
let PENDING_FLOW = null;
let videoBatchState = null;
// 文档里**别的**批量（这一层不管的那些 kind）。保存时必须原样写回去 ——
// 否则打开-保存一次就删掉了它们（4D 轮 4 的 P1）。
//
// **这一层拥有的 kind 是一个集合，不是一个名字**（批次 4E）：4D 只有
// `prompt-compose` 时它被写成了一个字符串，而 4E 一加进来，「摘掉自己那一种」
// 就必须摘两种 —— 漏掉一种的后果与 4D 轮 5 那个「放弃之后又自己回来」一模一样。
const OWNED_BATCH_KINDS = ["prompt-compose", videobatch.VIDEO_BATCH_KIND];
let loadedBatches = {};

let shotMirror = null;

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
    // --- 历史空壳收口 (TASK-094 批次 G / ADR-0072 决策 4-5) ------------------- //
    //
    // WHY THIS LIVES HERE. The judgement is 「这个 episodeId 在整份文档里还有别的引用
    // 吗」, and `serializeGraph()` — the exact object `persist` writes — is the only
    // place the WHOLE document exists. A check written inside `proddoc` could see
    // `production` alone and would have missed the `timelines` entries the real
    // project turned out to have (measured on 照见未明rev2: four episodes referenced
    // there and nowhere in the task card's checklist).
    cleanupReport: () => episodecleanup.episodeCleanupReport(serializeGraph()),
    archivableCount: () => episodecleanup.archivableEpisodes(serializeGraph()).length,
    archiveEmptyShells: () => {
      const ids = episodecleanup.archivableEpisodes(serializeGraph());
      const at = new Date().toISOString();
      let n = 0;
      for (const id of ids) {
        // `archiveEpisode` refuses the ACTIVE episode independently of the scan —
        // two guards, because this one is about a pointer and the scan is about
        // references, and neither implies the other
        if (proddoc.archiveEpisode(productionDoc, id, { at, reason: "零内容空壳（TASK-094 批次 G）" })) n += 1;
      }
      if (!n) { toast("没有可归档的空壳"); return 0; }
      ctx.persist();
      refreshProductionView();
      toast(`已归档 ${n} 集空壳。这不是删除：记录仍在文档里，可以随时取消归档`);
      return n;
    },
    unarchive: (id) => {
      const ok = proddoc.unarchiveEpisode(productionDoc, id);
      if (ok) { ctx.persist(); refreshProductionView(); toast("已取消归档，这一集回到列表里"); }
      return ok;
    },
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
    /** 场景时间（TASK-095 §2.1.2）。空值删字段 —— 「清空」与「从没写过」是同一形状。 */
    setSceneTimeOfDay: (sceneId, v) => prodOp(
      proddoc.setSceneTimeOfDay(productionDoc, sceneId, sceneplan.normalizeTimeOfDay(v) || ""),
    ),
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
  // TASK-073 §1.8 第五批：提示词域整体搬进 `controllers/promptctl.js`；
  // `ctx.prompt` / `ctx.basePrompt` / `ctx.promptBatch` 在这个字面量之后挂上
  // （见 `ctx._prompts = createPromptController(…)`），原名不变，调用点一处不改。

  // ---------------------------------------------------------------------- //
  // 基础资产 (TASK-065 §1 / §4) — the ONE controller for a bible entity's
  // long-lived reusable media.
  //
  // EVERY WRITE GOES THROUGH AN EXISTING PATH: `ctx.assets.importReference` for
  // registration (上传 ≠ 保存文件 — ADR-0055) and `ctx.bible.*` for attachment. This
  // controller adds no store and opens no second upload path; it only decides WHICH
  // entity (or state) the registered asset is attached to.
  // ---------------------------------------------------------------------- //
  /**
   * 第 ② 步「准备资产」(TASK-095 §2.2 / 批次 4C)。
   *
   * 名字先 grep 过（§2.5f 第三条：`ctx.wizard` 那次是被静默覆盖，不报错）。
   *
   * **每一个写入都走既有路径**：新增实体走 `bibledoc`，上传走
   * `ctx.baseAssets.registerUpload`（ADR-0055：上传即登记），从资产库挂走
   * `ctx.baseAssets.attach`。这里没有第二条上传通道，也没有第二份计数。
   */
  /**
   * ④ Storyboard 草图 (TASK-095 §2.4 / 批次 4F)。
   *
   * 名字先 grep 过（§2.5f 第三条）。**判定不在这里**：状态四分与闸门都在
   * `workflow/sbdraft.js`，这一层只把证据凑齐、把决定写进既有的两份存储
   * （跳过 → `stages`，通过 → `stageReviews`）。
   *
   * **便宜是这一步存在的理由**，所以出草图一律带 `DRAFT_SPEC`，并且在提交前
   * 用生产那份谓词 `draftSpecViolations` 拦一次 —— 高清草图既不便宜，
   * 也不比 ⑤ 早看到什么。
   */
  storyboard: {
    /** 这一镜当前那张草图。**从资产登记表里找**，不另存一份指针（§2.5e）。 */
    draftOf: (shotId) => {
      if (!shotId) return null;
      const rows = assetreg.listAssets(assetRegistry)
        .filter((a) => a && a.kind === "storyboard" && a.links && a.links.shotId === shotId);
      if (!rows.length) return null;
      // 最新那一版就是「当前那张草图」；`present` 用与 stageBoard 同一份探针口径
      const newest = rows.reduce((m, a) => (a.version > (m ? m.version : -1) ? a : m), null);
      const verdict = mediaProbe.stateOf(newest.url);
      return {
        assetId: newest.assetId,
        url: newest.url,
        version: newest.version,
        // 与 TASK-092 的 `completed` 同一条：探针说不出来，就不算它在
        present: verdict !== mediaprobe.MISSING && verdict !== mediaprobe.INCONCLUSIVE,
      };
    },
    model: () => {
      // **共用 ⑨ 粗剪审片那个底座**（TASK-095 §2.4：不新建第二套视图模型）——
      // 直接调 `ctx.dailies.model()`，而不是自己再拼一遍参数：第一版按记忆写成
      // `dailiesModel(pd, {})`，签名不对，于是 items 恒为空 —— 一条空带，
      // 而测试全绿（真实屏幕上才看得见，§2.6.4）。
      const dailies = ctx.dailies.model();
      return sbdraft.storyboardStrip({
        items: dailies.items,
        stages: productionDoc.shotProduction.stages,
        draftOf: (shotId) => ctx.storyboard.draftOf(shotId),
        // **生产那一份谓词**（§2.5d）：界面与闸门问的是同一个函数
        approvedFor: (shotId, assetId) =>
          shotprod.isStageArtifactApproved(productionDoc, shotId, "storyboard", assetId),
      });
    },
    /** 「通过」—— 绑到那一张具体的草图上。没有草图不给通过。 */
    approve: (shotId) => {
      const d = ctx.storyboard.draftOf(shotId);
      if (!d || !d.present) {
        toast("这一镜还没有可确认的草图 —— 先出一张（探针确认它真的在）");
        return false;
      }
      const ok = shotprod.approveStage(productionDoc, shotId, "storyboard", d.assetId, new Date().toISOString());
      if (ok) { ctx.persist(); refreshProductionView(); }
      return ok;
    },
    /** 「重出」—— 撤销通过，再出一张。撤销与重出是两件事，都做，顺序固定。 */
    /** 「重出」= 撤销通过，然后重新出一张（任务单再给一次）。 */
    redraw: (shotId) => {
      shotprod.unapproveStage(productionDoc, shotId, "storyboard");
      ctx.persist();
      refreshProductionView();
      return ctx.storyboard.brief(shotId);
    },
    /** 「跳过」/「取消跳过」—— 写 `stages`，那是 ADR-0073 里唯一被持久化的状态。 */
    skip: (shotId) => {
      const ok = shotstage.skipStage(
        productionDoc.shotProduction.stages, shotId, "storyboard",
        new Date().toISOString(), "创作者决定这一镜不画草图",
      );
      if (ok) {
        // 跳过之后那条通过记录不再描述任何东西 —— 一起清掉，免得留下一个
        // 「跳过了但也通过了」的形状
        shotprod.unapproveStage(productionDoc, shotId, "storyboard");
        ctx.persist();
        refreshProductionView();
      }
      return ok;
    },
    unskip: (shotId) => {
      const ok = shotstage.unskipStage(productionDoc.shotProduction.stages, shotId, "storyboard");
      if (ok) { ctx.persist(); refreshProductionView(); }
      return ok;
    },
    /**
     * 一镜的**草图任务单**：提示词 + 便宜档规格 + 违规检查。
     *
     * **这里没有「排入队列」这回事，因为今天没有那个队列。** 图片生成在本仓库仍然
     * 是手工路线（付费图片路线未被任何 Accepted ADR 授权 —— app.js 的 `estimate`
     * 那段就写着 image/audio 仍然 gated）。所以老实的动作是：把提示词与规格交给
     * 创作者，他到外部工具出图，回来上传成这一镜的草图。
     *
     * 第一版这里只弹了一句「已排入草图生成」然后 return true —— 屏幕说 60 镜都排上了，
     * 而没有任何东西会产出一张草图（codex 本批 round 1 的 P1）。那是 §2.5e 里
     * 「亮着但点进去什么也没发生」的最贵版本：它还顺带撒了个谎。
     */
    brief: (shotId) => {
      const violations = sbdraft.draftSpecViolations(sbdraft.DRAFT_SPEC);
      const d = shotId ? shotDetailModel(ctx.prodData(), shotId) : null;
      const img = d && d.prompts.image ? d.prompts.image : null;
      return {
        shotId,
        // ④ 吃的是**分镜提示词**（TASK-095 §2.4：草图不表达运动，所以不是视频那一份）
        prompt: img ? img.text : "",
        missing: img ? img.missing : ["这一镜还编不出分镜提示词"],
        spec: sbdraft.DRAFT_SPEC,
        violations,
        ready: !!(img && img.text.trim()) && !violations.length,
      };
    },
    /** 上传一张出好的草图，登记为这一镜的 `storyboard` 资产（上传即登记，ADR-0055）。 */
    upload: async (shotId) => {
      if (!shotId) return null;
      try {
        const { ref } = await ctx.assets.importReference({
          kind: "storyboard",
          links: { shotId },
          displayName: `草图 · ${shotId}`,
        });
        toast("已登记为这一镜的草图 —— 回到带上按「通过」或「重出」");
        refreshProductionView();
        return ref;
      } catch (e) {
        toast(`上传失败：${e.message}`);
        return null;
      }
    },
    /**
     * 「一次出全集」：跨镜比较是这一步的意义，所以默认是全集。
     *
     * 它给的是**全集的任务单**（哪几镜要出、每镜的提示词齐不齐），
     * 不是一句「已排入」。
     */
    drawAll: () => {
      const m = ctx.storyboard.model();
      const todo = m.rows.filter((r) => r.state === "not_started" || r.state === "drafted");
      if (!todo.length) {
        toast(m.total
          ? "每一镜都已经通过或跳过了 —— 没有要出的草图"
          : "这一集还没有镜头 —— 先在第 ① 步确认镜头");
        return { todo: [], ready: 0, blocked: [] };
      }
      const briefs = todo.map((r) => ctx.storyboard.brief(r.shotId));
      const ready = briefs.filter((b) => b.ready);
      const blocked = briefs.filter((b) => !b.ready);
      toast(blocked.length
        ? `${ready.length} 镜的草图提示词已备好；${blocked.length} 镜还编不出提示词 —— 展开看缺什么`
        : `${ready.length} 镜的草图提示词已备好 —— 复制到外部工具出图（${sbdraft.DRAFT_SPEC.label}），回来上传`);
      refreshProductionView();
      return { todo: briefs, ready: ready.length, blocked };
    },
  },
  /**
   * ⑤ Keyframe 合成 (TASK-095 §1.3 / §2.5 · 批次 4G)。**本链最重的一批。**
   *
   * 名字先 grep 过（§2.5f 第三条）。判定全部在 `workflow/keyframe.js`，而它又把
   * 有序集合 / 用法规则 / 方案 C / 闸门分别转交 `promptrefs` / `genspec` / `sbdraft`
   * —— 这一层只负责把证据凑齐、把决定写进既有存储、把产物接到既有那条首帧路上。
   *
   * **付费红线**：本控制器不发起真实扣费。方案 C 的拒绝落在**提交路径**上
   * （`composeSubmission`），而不是一份人类可读报告里的一句话（§2.5b-2）。
   */
  keyframe: {
    /** 这一镜当前那张 keyframe（资产登记表里 kind 为 `keyframe`、链到这一镜的那张）。 */
    frameOf: (shotId) => {
      if (!shotId) return null;
      const rows = assetreg.listAssets(assetRegistry)
        .filter((a) => a && a.kind === "keyframe" && a.links && a.links.shotId === shotId);
      if (!rows.length) return null;
      const newest = rows.reduce((m, a) => (a.version > (m ? m.version : -1) ? a : m), null);
      const verdict = mediaProbe.stateOf(newest.url);
      const present = verdict !== mediaprobe.MISSING && verdict !== mediaprobe.INCONCLUSIVE;
      return {
        assetId: newest.assetId,
        url: newest.url,
        version: newest.version,
        present,
        // **keyframe 的通过是它自己那件事**（§2.5h 第一条）：不看审片，也不看草图
        approved: shotprod.isStageArtifactApproved(productionDoc, shotId, "keyframe", newest.assetId),
        skipped: shotstage.isSkipped(productionDoc.shotProduction.stages, shotId, "keyframe"),
      };
    },
    /** 向导第 ⑤ 步那张全集清单。④ 的状态与闸门都来自 4F 那一份。 */
    list: () => keyframe.keyframeList({
      rows: ctx.storyboard.model().rows,
      keyframeOf: (shotId) => {
        const kf = ctx.keyframe.frameOf(shotId);
        if (kf) return kf;
        // 没有产物时仍然要说得出「整镜是不是被跳过了」
        return { skipped: shotstage.isSkipped(productionDoc.shotProduction.stages, shotId, "keyframe") };
      },
      // 白膜视频（TASK-098）：每行多一格运镜。**注入而不是 import** —— 与
      // `keyframeOf` 同一条纪律，`keyframe.js` 不该知道 ffmpeg 或者那句运镜怎么读。
      motionOf: (shotId, ev) => ctx.motionPreview.rowOf(shotId, ev),
    }),
    /** 一镜的合成编排：草图 + 设定图 + 分镜提示词，每张声明它管什么。 */
    plan: (shotId) => {
      const pd = ctx.prodData();
      const d = shotId ? shotDetailModel(pd, shotId) : null;
      // **只有「通过了的」草图才是输入**（codex 本批 round 2 的 P1）。
      //
      // 闸门有两条放行路径：草图通过，或者**这一镜的草图被跳过**。第一版只看
      // `present`，于是「跳过了 ④、但硬盘上还留着一张没通过的旧草图」这种情形下，
      // 那张被否决的草图仍然被送进合成 —— 创作者决定不用它，它却在影响画面。
      // 「通过」是一个人的判断，`present` 只是「文件在」。
      const draftRow = ctx.storyboard.draftOf(shotId);
      const draftApproved = !!(draftRow && draftRow.present
        && shotprod.isStageArtifactApproved(productionDoc, shotId, "storyboard", draftRow.assetId));
      const draft = draftApproved
        ? { ...draftRow, name: `本镜草图 v${draftRow.version}`, contentDigest: draftRow.assetId }
        : null;
      // ② 的设定图：这一镜绑定的参考里，图片类的那些（人物 / 场景 / 道具 / 风格）
      const refs = d && d.refInputs ? (d.refInputs.imageReferences || []) : [];
      return keyframe.composePlan({
        shotId,
        draft,
        refs,
        // ③ 的**分镜提示词**（不是视频运动那一份 —— 静态帧不表达运动）
        prompt: d && d.prompts.image ? d.prompts.image.text : "",
        lookup: skills.promptBlock,
      });
    },
    /**
     * 提交合成。**方案 C 的拒绝就在这里** —— 这一层是真正要发请求的那一层。
     *
     * 能力从 preflight 来（`genspec.referenceCapability`），拿不到就是拿不到：
     * 不许在这里补一个「大概能吃 6 张」。
     */
    submit: (shotId, { preflight = null } = {}) => {
      const plan = ctx.keyframe.plan(shotId);
      // 闸门结论从**清单那一行**取 —— 与界面看到的是同一份判断（§2.5d）
      const row = ctx.keyframe.list().rows.find((r) => r.shotId === shotId) || null;
      const gate = row ? { ok: row.gateOk, reason: row.gateReason } : null;
      // **能力来自调用方手上那份 preflight**（界面刚取的那一次），不是控制器自己
      // 攒的一个全局 —— 那种全局会让「上一次取的报价」被当成这一次的事实。
      // 给不出 preflight 时 `known` 为假，`composeSubmission` 就会拒（不知道 ≠ 可以送）。
      const capability = genspec.referenceCapability(preflight);
      const verdict = keyframe.composeSubmission({ plan, capability, gate });
      if (!verdict.ok) {
        // 闸门关着时**退化成真实可做的那件事**（§2.5h 第二条）：说明原因 +
        // 这一镜真实可走的路（复制编排、外部合成、回来上传）。不说「已提交」。
        toast(`没有提交：${verdict.reason}`);
        return { ok: false, reason: verdict.reason, plan };
      }
      toast(`编排合规（${verdict.count} 张输入）—— 实际扣费仍要你在弹窗里按两步确认`);
      return { ok: true, plan, count: verdict.count };
    },
    /** 上传一张合成好的 keyframe，登记并**接到既有那条首帧路上**。 */
    upload: async (shotId) => {
      if (!shotId) return null;
      try {
        const { ref } = await ctx.assets.importReference({
          kind: "keyframe",
          links: { shotId },
          displayName: `关键帧 · ${shotId}`,
        });
        // **产出就是视频首帧**（TASK-095 §2.5）：接既有的
        // `shot.first_frame_image → packets.py → cloud_minimax` 那条路，
        // 不新建第二条通道 —— `ctx.frames.bind` 就是那条路的入口。
        const bound = ctx.frames.bind(shotId, "start", {
          assetId: ref.assetId, source: "keyframe", sourceKind: "keyframe",
        });
        toast(bound
          ? "已登记为这一镜的关键帧，并绑成视频首帧"
          : "已登记为关键帧，但没能绑成首帧 —— 在「画面」里手工绑一次（资产没有丢）");
        refreshProductionView();
        return ref;
      } catch (e) {
        toast(`上传失败：${e.message}`);
        return null;
      }
    },
    /** 「通过」这一张 keyframe —— 它自己那件事，与草图 / 视频各不相干。 */
    approve: (shotId) => {
      const kf = ctx.keyframe.frameOf(shotId);
      if (!kf || !kf.present) {
        toast("这一镜还没有可确认的关键帧");
        return false;
      }
      const ok = shotprod.approveStage(productionDoc, shotId, "keyframe", kf.assetId, new Date().toISOString());
      if (ok) { ctx.persist(); refreshProductionView(); }
      return ok;
    },
    /** 进入这一镜的画布：选中它并切到画布 —— 合成在那儿做。 */
    openCanvas: (shotId) => {
      if (!shotId) return false;
      ctx.ui = ctx.ui || {};
      ctx.ui.gotoShotCanvas = shotId;
      return true;
    },
    /**
     * 「用同一套默认编排试一遍」。
     *
     * **产出是提案，逐镜确认**（TASK-095 §2.5）：⑤ 是整条链上最贵的一步，把 60 次
     * 判断压缩成一次点击正是这一批要避免的事。所以这里只算出每一镜的编排与它过不过
     * 方案 C，**不提交任何一镜**。
     */
    tryAll: ({ preflight = null } = {}) => {
      const list = ctx.keyframe.list();
      const open = list.rows.filter((r) => r.canCompose && r.state === "not_started");
      if (!open.length) {
        toast(list.blocked.length
          ? `没有可合成的镜头 —— ${list.blocked.length} 镜还过不了 ④→⑤ 那道门`
          : "每一镜都已经合成或跳过了");
        return { proposals: [], blocked: list.blocked.length };
      }
      const capability = genspec.referenceCapability(preflight);
      const proposals = open.map((r) => {
        const plan = ctx.keyframe.plan(r.shotId);
        const verdict = keyframe.composeSubmission({
          plan, capability, gate: { ok: r.gateOk, reason: r.gateReason },
        });
        return { shotId: r.shotId, title: r.title, plan, ok: verdict.ok, reason: verdict.reason };
      });
      const ready = proposals.filter((p) => p.ok).length;
      toast(ready
        ? `${ready}/${proposals.length} 镜的编排可以合成 —— 逐镜进画布确认，不一次性提交`
        : `${proposals.length} 镜都还不能合成：${proposals[0].reason}`);
      refreshProductionView();
      return { proposals, blocked: list.blocked.length };
    },
  },
  /**
   * ⑥ 批量生视频 (TASK-095 §2.5 末段 / 批次 4E)。
   *
   * 名字先 grep 过（§2.5f 第三条）。状态机全部是 `batchpay`；这一层只做
   * 「谁进这一批 / 报价交给它 / 结果报回去」。
   *
   * **与 4D 那一批的根本差别：视频要真花钱。**
   * 所以这里没有「本地免费」那条路，也不许自己把逐镜单价加起来 ——
   * 那正是 batchpay 第 1 条禁止的「单价 ×N 让人自己乘」。
   * 拿不到整批总额时，这一块**退化成真实可做的那件事**（§2.5h 第二条）。
   */
  videoBatch: {
    state: () => videoBatchState,
    _save: () => { ctx.persist(); refreshProductionView(); return videoBatchState; },
    /**
     * 为什么拿不到总额 —— **一句真话 + 一条真实可走的路**。
     *
     * Gateway 今天只有**逐镜**的预检命令（`submit-video-generation` 一次一镜），
     * 没有「批量预检」。逐镜预检再自己加起来就是界面自算；补一个 0 是谎，
     * 因为它真的要钱。所以这一批开始不了，而**逐镜生成今天就能用**。
     */
    _whyNoQuote: () => ({
      reason: "拿不到整批总额",
      detail: "Gateway 现在只有逐镜的预检命令，没有批量预检。"
        + "逐镜取价再自己加起来就是「单价 ×N」——界面永不自算（ADR-0071 决策 6）；"
        + "补一个 0 更不行，视频是真的要花钱。",
      alternative: "逐镜生成 —— 在「视频」里选中一镜按「生成单个」，"
        + "每一镜自己走 ADR-0041 的两步确认（预检 → 你确认 → 提交）",
    }),
    model: () => videobatch.videoBatchModel(videoBatchState, {
      counts: ctx.prodWizard.counts(),
      quoteUnavailable: PAID ? ctx.videoBatch._whyNoQuote() : {
        reason: "当前不是付费模式",
        detail: "没有真实的付费路线，所以既取不到总额，也不会有任何扣费。",
        alternative: "先用逐镜的手工流程把画面与视频跑通（M1 那条路），或让产品负责人开启付费模式",
      },
    }),
    start: () => {
      const pd = ctx.prodData();
      const made = videobatch.startVideoBatch({
        shots: pd.draftShots || [],
        // 「哪些算就绪」**不在这里第二次定义**：首帧看既有的绑定 / 媒体，
        // 视频看既有的媒体判断
        readyOf: (shotId) => {
          const shot = (ctx.project.draftShots || []).find((s) => s && s.shotId === shotId) || null;
          if (!shot) return null;
          const media = ctx.shot.mediaOf(shot);
          const frame = ctx.frames.binding(shotId, "start");
          const kf = ctx.keyframe.frameOf(shotId);
          return {
            hasFrame: !!(frame || (kf && kf.present) || media.image),
            hasVideo: !!media.video,
          };
        },
      });
      if (made.nothingToDo) {
        videoBatchState = null;
        toast(made.blocked.length
          ? `没有可生成的镜头：${made.blocked.length} 镜还没有首帧 —— 先在 ⑤ 合成关键帧`
          : `没有可生成的镜头 —— ${made.already.length} 镜已经有视频了`);
        return ctx.videoBatch._save();
      }
      videoBatchState = made.batch;
      if (videoBatchState.state === "refused") {
        toast(`没能建批次：${videoBatchState.refusal ? videoBatchState.refusal.reason : "条目不合法"}`);
        return ctx.videoBatch._save();
      }
      toast(`${videoBatchState.items.length} 镜待生成 —— 正在取整批总额`);
      ctx.videoBatch.requote();
      return videoBatchState;
    },
    /**
     * 取整批总额。**今天必然拿不到**（没有批量预检命令），所以这里如实停在 draft
     * 并把原因与替代路径交给界面 —— 不伪造、不自算、不静默降级成逐镜偷偷跑。
     */
    requote: () => {
      if (!videoBatchState || videoBatchState.state !== "draft") return videoBatchState;
      const why = PAID ? ctx.videoBatch._whyNoQuote() : null;
      toast(why ? `${why.reason} —— ${why.alternative}` : "当前不是付费模式：没有总额可取，也不会有任何扣费");
      return ctx.videoBatch._save();
    },
    /** ADR-0041 第二步。没有总额时**拒绝开始**（batchpay 自己也会拒）。 */
    confirm: () => {
      if (!videoBatchState) return null;
      videoBatchState = videobatch.batchOps.confirmBatch(videoBatchState, new Date().toISOString());
      if (videoBatchState.state !== "running") {
        toast("还不能开始：这一批没有总额（ADR-0041 两步 —— 先预检，再确认）");
      }
      return ctx.videoBatch._save();
    },
    abort: () => {
      if (!videoBatchState) return null;
      videoBatchState = videobatch.batchOps.abortBatch(videoBatchState, new Date().toISOString());
      toast("已中止 —— 已经花掉的照实记账，迟到的回执仍然会被收下");
      return ctx.videoBatch._save();
    },
    /**
     * 一镜的结果报回状态机。**失败不算成功**，花掉的钱如实记 ——
     * 包括「失败但已扣费」这种最容易被记漏的情形。
     */
    record: (shotId, { outcome, spent = null, error = null } = {}) => {
      if (!videoBatchState) return null;
      videoBatchState = videobatch.batchOps.recordItem(videoBatchState, shotId, { outcome, spent, error });
      return ctx.videoBatch._save();
    },
    discard: () => {
      if (!videoBatchState) return null;
      if (videoBatchState.state === "running") {
        toast("这一批正在跑 —— 先中止；中止后已经花掉的会照实留在账上");
        return videoBatchState;
      }
      videoBatchState = null;
      ctx.videoBatch._save();
      return null;
    },
  },
  assetPrep: {
    model: () => assetprep.assetPrepModel({
      prod: productionDoc,
      // 与分镜表、向导第 ② 步**同一份**镜头列表（软删除的已被镜像过滤掉）
      shots: ctx.project.draftShots || [],
      // 与 `assetReadiness` 用同一个判断 —— 卡片上的「已有设定图」与底部那句
      // 缺口话术不可能互相矛盾（§2.6.2）
      hasReferenceImage: buildPortraitIndex(ctx.prodData()),
      // null 与 [] 是两件事：前者「还没抽取过」，后者「抽过、没有新东西」
      proposals: bibleProposals ? (bibleProposals.cards || []) : null,
    }),
    add: (kind, name) => {
      const K = ctx.breakdown._kinds[kind];
      if (!K || !String(name || "").trim()) return null;
      const made = K.add(String(name).trim());
      ctx.persist();
      refreshProductionView();
      return made;
    },
    /**
     * 生成设定图。**本批只走到报价与提交**：报价来自 preflight，界面永不自算。
     *
     * `edited` 是弹窗里那个 textarea 的当前内容。**它与生效版本不同时，先存成新版本
     * 再生成** —— 否则创作者改了提示词却用旧的那版出图，而且没有任何提示
     * （codex 本批 round 1 的 P1）。存盘走既有的版本路径，不新开存储。
     */
    generate: (kind, entityId, edited = null) => {
      const before = ctx.basePrompt.effective(kind, entityId);
      const text = typeof edited === "string" ? edited : (before.text || "");
      if (!text.trim()) {
        toast("这个对象还没有可用的提示词 —— 先在卡片里补上描述");
        return false;
      }
      if (text.trim() !== String(before.text || "").trim()) {
        if (before.locked) {
          // 锁定的提示词不被覆盖（既有规则）。如实说，不静默用旧的那版去生成。
          toast("这段提示词是锁定的 —— 先解锁再改，否则生成用的会是锁定的那一版");
          return false;
        }
        const v = ctx.basePrompt.save(kind, entityId, null, text);
        if (!v) {
          toast("没能保存你改过的提示词 —— 未提交生成");
          return false;
        }
        toast(`已把你改过的提示词存成第 ${v} 版，并用它提交生成`);
      }
      // 走既有的生成入口（同一张「一次生成 = 一张卡」）。付费与否由那条路上的
      // 闸门决定；这里不复制一份判断。
      return ctx.basePrompt.entry(kind, entityId, null);
    },
    upload: async (kind, entityId) => {
      try {
        const ref = await ctx.baseAssets.registerUpload(kind, entityId, null, {
          displayName: ctx.baseAssets.suggestName(kind, entityId, null),
        });
        if (ref) toast("已登记为这个对象的设定图");
        refreshProductionView();
        return ref;
      } catch (e) {
        toast(e.message);
        return null;
      }
    },
    /**
     * 「从资产库选」的候选：**已经登记过的、这一类的参考资产**。
     *
     * 复用 `ctx.baseAssets.referenceOptions` —— 基础资产面板用的就是它，所以两处
     * 看到的候选集一定相同（§2.5e：同一件事实一份来源）。
     */
    libraryOptions: (kind) => ctx.baseAssets.referenceOptions(kind),
    /**
     * 挂上一张已登记资产。走 `ctx.baseAssets.attach` —— 没有第二条挂接路径。
     *
     * 第一版这里**只弹了一句提示就返回 true**：那个 tab 于是「点得开、什么也做不了」
     * —— §2.5e 里 `available` 却没有处理器的同一形状（codex 本批 round 2 的 P1）。
     */
    attachFromLibrary: (kind, entityId, assetId) => {
      if (!assetId) return false;
      const one = ctx.baseAssets.one(kind, entityId);
      const first = !one || !one.refs || !one.refs.length;
      const ok = ctx.baseAssets.attach(kind, entityId, null, assetId, { active: first });
      toast(ok ? "已挂上这张设定图" : "没能挂上 —— 这张资产不适用于这个对象");
      if (ok) refreshProductionView();
      return ok;
    },
  },
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
    // ---- the WRITABLE half (TASK-093 / 批次 3) ------------------------------ //
    //
    // THE SKELETON STAYS DERIVED. Everything below either writes into a registry
    // that already exists, or refuses and says why. There is no canvas document,
    // nothing to name, nothing to maintain — which is the answer to 「一个 shot 一个
    // 画布是不是有点奢侈了」 (TASK-093 §0c).
    //
    // WIRED HERE, NOT LEFT FOR LATER. Batch 2 shipped two functions whose only
    // caller was a test — green guards over an app that still behaved the old way
    // (§2.5c). So each of these has a real path from the canvas view to it.

    /** 能往画布上加什么。`available` 只由「有没有既有登记表装它」决定. */
    addable: () => canvasnodes.addableNodes(),

    /** 「以此生成 →」 for one node, with its prefill and its refusals.
     *  The six stages come from TASK-092's ONE computation (§2.4), passed in. */
    chain: (shotId, node) => canvasnodes.chainTargets(node, {
      stage: shotId ? ctx.shot.stageBoard(shotId) : null,
      hasPrompt: !!(node && node.preview && node.preview.trim()),
      nextShotId: shotId && ctx.frames.nextShotOf ? ctx.frames.nextShotOf(shotId) : null,
    }),

    /** 参考区的五个一级分类 —— 派生分组，`kind` 数据不动，且「进不进模型」逐条如实. */
    referenceArea: (shotId) => {
      const d = shotId ? shotDetailModel(ctx.prodData(), shotId) : null;
      const refs = (d && d.refInputs && d.refInputs.references) || [];
      return canvasnodes.referenceArea(refs);
    },

    /** 删一个节点背后那条记录之前，先问「还有谁引用着它」（派生扫描，两个方向都钉）. */
    removalCheck: (id, label) => canvasnodes.removalCheck(
      serializeGraph(),
      id,
      {
        label: label || "这个对象",
        // 它自己的登记条目不算「被引用」—— 闭集是「哪里不算」，于是明天新增的
        // 引用点默认算引用（§2.6.1）。谓词是 `canvasnodes` 里那个**有名字的**
        // 函数，测试用的是同一份：这里原先是一个写错的内联 lambda，把资产自己的
        // 版本记录也算成外部引用，于是什么都删不掉，而测试因为用了另一个谓词
        // 而通过（codex 轮 4）。
        expected: canvasnodes.ownAssetRegistryPath(id),
      },
    ),

    // ---- ADR-0074 / ADR-0075 ------------------------------------------------ //

    /** 从一张图创建角色：只登记身份 + 一条参考绑定，其余如实留空. */
    characterFromImage: (node, name) => {
      const check = canvasgrow.characterFromImage({
        node, name, characters: productionDoc.characters,
      });
      if (!check.ok) { toast(check.blockers[0]); return null; }
      const c = bibledoc.addCharacter(productionDoc, check.proposal.name);
      // 引用，不复制（ADR-0074 决策 3）—— 不产生任何新的媒体字节
      c.referenceAssetIds = [check.proposal.referenceAssetId];
      c.activeReferenceAssetId = check.proposal.referenceAssetId;
      ctx.persist();
      refreshProductionView();
      toast(
        `已创建角色「${c.name}」并绑定这张图为参考。`
        + "外貌 / 服装 / 画面指令仍然是空的 —— 这张图没告诉我们这些，需要你来写。",
      );
      return c;
    },

    /** 运镜预设菜单 + 应用（复制文本，落到镜头上就与预设脱钩）. */
    cameraPresets: (shotId) => {
      const shot = (ctx.project.draftShots || []).find((s) => s && s.shotId === shotId);
      return canvasgrow.cameraPresetMenu(shot ? shot.cameraMotion : "");
    },
    applyCameraPreset: (shotId, presetId, mode) => {
      const shot = (ctx.project.draftShots || []).find((s) => s && s.shotId === shotId);
      if (!shot) { toast("找不到这个镜头"); return false; }
      const r = canvasgrow.applyCameraPreset(shot.cameraMotion, presetId, { mode });
      if (!r.ok) { toast(r.reason); return false; }
      // THE EXISTING WRITE PATH: an edit becomes a NEW immutable draft version,
      // exactly like the detail editor and the table (no second write path).
      ctx.shots.saveEdit(shotId, { cameraMotion: r.text });
      toast(r.appended ? "已追加到这一镜的运镜后面（你写的话没有被替换）" : "已填入这一镜的运镜");
      return true;
    },
  },

  // ---- 剧集制作向导 (TASK-095 / TASK-097 批次 4A) --------------------------- //
  //
  // `counts` 的第一个真实消费者（§2.5c 接线账）。顶部那些数字**全部**走
  // `counts.productionCounts` —— 就地算一遍会同时造成「模块永远接不上」和
  // 「多出第二份计数」，两个缺陷一次达成（§2.6.2 那个 16/48）。
  // `prodWizard`, NOT `wizard`: `ctx.wizard` is ALREADY the demo assets-node wizard
  // (`createWizard`, assigned near the bottom of this file), so an object-literal key
  // named `wizard` here was silently overwritten by that later assignment — the whole
  //五步向导 read as 「ctx.wizard.counts is not a function」 on the real project while
  // every test passed. Two things claiming one name is TASK-097 §2.5e's exact shape,
  // and `tests/wizardskeleton.test.mjs` now asserts the two names stay distinct.
  prodWizard: {
    /** 全部计数，一次算完。缺来源的那些如实返回「不知道」，不是 0。 */
    counts: () => {
      const pd = ctx.prodData();
      const shots = Array.isArray(pd.draftShots) ? pd.draftShots : null;
      return counts.productionCounts({
        shots,
        // 「还差 10 个」查的是**实际有参考图的实体**（既有那一份派生，不重算）
        assetReadiness: shots ? wizardReadiness(pd) : null,
        // 两份提示词都编译出来才算已合成（TASK-095 §2.3.1）
        promptsOf: (shotId) => {
          const d = shotId ? shotDetailModel(pd, shotId) : null;
          if (!d) return null;
          return {
            image: !!(d.prompts.image && d.prompts.image.text.trim()),
            video: !!(d.prompts.video && d.prompts.video.text.trim()),
          };
        },
        // 六个 stage 那**一份**计算（§2.4），逐镜取
        stageOf: (shotId) => (shotId ? ctx.shot.stageBoard(shotId) : null),
      });
    },
    /**
     * 这一步**真实的**完成条件与阻塞原因。
     *
     * §2.5e：向导的每一步都是一条缝 ——「说可以进下一步」与「下一步真的能做」
     * 是两处在陈述同一件事实。所以这里读的是**登记表**，绝不读「用户走到哪一步」：
     * 一个记录导航历史的向导会立刻变成那条缝（「下一步亮着但点进去是空的」）。
     */
    // 判定本体在 `ui/prodwizard.js` 的 `stepReadiness` 里：**生产用的那个谓词
    // 必须是被钉住的那个**（§2.5d）。它只读 counts，所以是纯函数、可导出、
    // 测试与生产共用同一份 —— 在这里内联一份等于让「两个方向都钉住」
    // 自己变成一条新的缝。
    readyOf: (stepId) => stepReadiness(ctx.prodWizard.counts(), stepId),
  },

  /**
   * 逐镜质检（TASK-096 §2.4 / 批次 5B）—— **只读判断，不修数据**。
   *
   * 三条判据的判定全在 `workflow/shotqc.js`（纯函数）；这一层只负责把证据取出来：
   * 状态取 TASK-092 那一份 board、绑定取既有的 references、发送记录取生成登记表里
   * **发起时冻结**的 `referenceAssetIds`、时长测量走既有那个真实 ffprobe 端点。
   */
  shotQc: {
    _shots: () => {
      const shots = ctx.project.draftShots;
      return Array.isArray(shots) ? shots.filter((x) => x && !counts.isDeleted(x)) : [];
    },
    /** 这一镜绑定的设定图。名字用登记表那一份派生标签，不另起一套叫法。 */
    _bound: (shotId) => {
      // `ctx.shot.references`，**不是** `ctx.episode.references`：后者不存在。
      // 第一版就是那么写的，1725 项测试全绿，而真实屏幕上整块面板炸掉
      // （`ctx.episode.references is not a function`）—— §2.5f 第三条原话：
      // 往 ctx 上挂一个名字之前先 grep 它。守卫测试也一起改成**行为判据**。
      const keys = ctx.shot.references(shotId) || [];
      const byKey = new Map(assetreg.listReferences(assetRegistry).map((r) => [r.key, r]));
      return keys
        .map((k) => byKey.get(k))
        .filter(Boolean)
        .map((r) => ({ assetId: r.assetId, name: assetreg.derivedLabel(r), kind: r.kind }));
    },
    /** 产出**当前那条视频**的那次生成，或 null（手工放进来的就是 null）。 */
    _generation: (shotId) => {
      const media = ctx.shot.mediaOf(ctx.shot.find(shotId));
      const assetId = media && media.videoAssetId;
      if (!assetId) return null;
      return (generationRegistry || []).find(
        (g) => g && g.type === "video" && Array.isArray(g.resultAssetIds)
          && g.resultAssetIds.includes(assetId),
      ) || null;
    },
    /** 这一镜当前那条视频的测量结果 —— 键是 assetId，所以换了视频自动失效。 */
    _measure: (shotId) => {
      const media = ctx.shot.mediaOf(ctx.shot.find(shotId));
      const assetId = media && media.videoAssetId;
      if (!assetId) return null;
      return SHOT_PROBES.get(assetId) || null;
    },
    /** 哪些镜头**真的有视频可测** —— 「逐镜测时长」只会走这些，
     *  不会对 60 个没有视频的镜头各弹一次「这一镜还没有视频」。 */
    measurableIds: () => ctx.shotQc._shots()
      .filter((s) => {
        const m = ctx.shot.mediaOf(s);
        return !!(m && m.videoAssetId);
      })
      .map((s) => s.shotId),
    report: () => shotqc.shotQcReport({
      shots: ctx.shotQc._shots(),
      boardOf: (shotId) => ctx.shot.stageBoard(shotId),
      boundOf: ctx.shotQc._bound,
      genOf: ctx.shotQc._generation,
      measureOf: ctx.shotQc._measure,
    }),
    /**
     * 真的去量一镜的时长（`media-audit?measure=`，只读、不花钱）。
     *
     * **走轻端点，不走 `/api/delivery/probe`**（TASK-087 §3.5.4）：后者每次
     * ffprobe **加一次完整解码**（ebur128 + blackdetect），而这里只要时长，
     * 且逐镜质检是 60 镜逐个跑 —— ffprobe-only 快一个数量级。
     *
     * 失败**留下来并显示**：「没跑成」与「没测过」把创作者送到不同的地方
     * （一个装 ffmpeg，一个点按钮），静默 catch 会让两者长得一样
     * —— 与 `runDeliveryProbe` 同一条纪律。轻端点把失败分成**五种具名状态**，
     * 逐种给话说：压成一句「探测失败」等于把这个端点专门保留的区分丢掉。
     */
    measure: async (shotId) => {
      const shot = ctx.shot.find(shotId);
      const media = ctx.shot.mediaOf(shot);
      const assetId = media && media.videoAssetId;
      if (!assetId) { toast("这一镜还没有视频可测"); return null; }
      if (!CONNECTED) {
        SHOT_PROBES.set(assetId, { error: "演示模式无后端，无法跑真实探测", running: false });
        refreshProductionView();
        return null;
      }
      const hit = ctx.assets.find(assetId);
      const url = hit && hit.record ? hit.record.url || "" : "";
      const name = String(url).split("/").filter(Boolean).pop() || "";
      if (!name) {
        SHOT_PROBES.set(assetId, { error: "这条视频没有可解析的文件名", running: false });
        refreshProductionView();
        return null;
      }
      SHOT_PROBES.set(assetId, { name, running: true });
      refreshProductionView();
      // `getMediaAudit` **读不到就抛**（不像 `deliveryProbe` 会回 `{ok:false}`），
      // 所以这个 try/catch 在这里是**承重的**，不再只是兜底。失败模式仍然是
      // 不可恢复的：`running: true` 一旦卡住，除了刷新没有别的出路，而刷新会
      // 丢掉这一轮所有测量。
      try {
        const audit = await query.getMediaAudit(PROJECT_NAME, name);
        const m = audit && audit.measured;
        SHOT_PROBES.set(assetId, (m && m.state === "ok")
          ? {
            name,
            // 服务端「测不到就不写这个字段」，所以这里也**不补默认值**
            durationS: typeof m.duration === "number" ? m.duration : null,
            running: false,
          }
          : {
            name,
            error: SHOT_MEASURE_STATE[m && m.state] || "探测失败",
            running: false,
          });
      } catch (e) {
        SHOT_PROBES.set(assetId, { name, error: `探测出错：${String(e && e.message ? e.message : e)}`, running: false });
      }
      refreshProductionView();
      return SHOT_PROBES.get(assetId);
    },
  },

  /**
   * ⑩ 后期交付 的状态（TASK-096 / 批次 5A）。
   *
   * 三个状态**取自 TASK-092 那一份**（`ctx.shot.stageBoard`），这一层一个都不重算 ——
   * 它只把「可以开始 / 可以定稿」这两个已经算好的 ok 变成创作者看得懂的词，
   * 并说清「要不要做」有没有人写下来。
   */
  postStatus: {
    rows: () => {
      const shots = ctx.project.draftShots;
      if (!Array.isArray(shots)) return null;
      return poststatus.postRows(shots.filter((x) => x && !counts.isDeleted(x)), {
        boardOf: (shotId) => ctx.shot.stageBoard(shotId),
      });
    },
    model: () => {
      const rows = ctx.postStatus.rows();
      return {
        hasShots: Array.isArray(rows) && rows.length > 0,
        stages: poststatus.POST_STAGES,
        // 规则本身写一次，就在这里 —— 每一行不必各自解释一遍
        rule: "音频与视频并行：现在就能开始，定稿要等画面对齐",
        summary: poststatus.postSummary(rows || []),
        parallel: poststatus.parallelWindow(rows || []),
        gaps: poststatus.soundGaps(rows || []),
        // 新增一条音轨而忘了给它归属时，**屏幕上说出来**。守卫测试只在 CI 里挡，
        // 而这一条让创作者也不会对着一个静默不参与任何状态的轨发愁（§2.5c 规则 3：
        // 一个只有测试调用的导出等于没接线）。
        unclassified: poststatus.unclassifiedTracks(),
        whyHere: poststatus.SOUND_HOME_WHY,
      };
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
    // …and the list facets the product owner's seven added (TASK-088 §2.1).
    // Same draft-then-version rule as above: every one of these writes the
    // UNVERSIONED draft, so none of them can alter a plan version in place.
    //
    // 添加/删除 re-render (a row appeared or vanished); typing does NOT — it goes
    // through ui/fieldsync.js, which must not re-render mid-sentence.
    editPlanItem: (episodeId, field, index, value) => {
      const ok = storydoc.editPlanItem(storyDoc, episodeId, field, index, value);
      if (ok) ctx.persist();
      return ok;
    },
    editPlanBeat: (episodeId, index, key, value) => {
      const ok = storydoc.editPlanBeat(storyDoc, episodeId, index, key, value);
      if (ok) ctx.persist();
      return ok;
    },
    addPlanItem: (episodeId, field) => {
      const i = storydoc.addPlanItem(storyDoc, episodeId, field);
      if (i >= 0) { ctx.persist(); refreshProductionView(); }
      return i;
    },
    removePlanItem: (episodeId, field, index) => {
      const ok = storydoc.removePlanItem(storyDoc, episodeId, field, index);
      if (ok) { ctx.persist(); refreshProductionView(); }
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
      if (rec.outline) {
        toast(`已应用为故事大纲 v${rec.v}（旧版本保留；批准后才能规划分集）`);
        return rec;
      }
      // SAY WHETHER THE EPISODES WERE CONTINUED OR ARE NEW (ADR-0072 决策 1).
      // A revision normally inherits the base version's episode identities, so
      // confirming it UPDATES those episodes. When the answer's own episode
      // numbers were not a clean mapping the identities are deliberately NOT
      // carried — and then confirming creates new episodes, which is exactly the
      // 48-episode surprise this batch removes. Silence there would reproduce it.
      const linked = rec.episodes.filter((e) => e.episodeId).length;
      toast(
        !rec.basedOn
          ? `已应用为剧集规划 v${rec.v}（确认后才建立剧集）`
          : linked === rec.episodes.length
            ? `已应用为剧集规划 v${rec.v}（改的是 v${rec.basedOn} 的这 ${linked} 集；确认后更新它们，不新建）`
            : linked
              ? `已应用为剧集规划 v${rec.v}（${linked} 集沿用 v${rec.basedOn} 的剧集，${rec.episodes.length - linked} 集是新的）`
              : `已应用为剧集规划 v${rec.v}：AI 的答案没有保持集号，无法判断每一条对应哪一集 —— 因此这一版不沿用任何已有剧集，确认后会新建 ${rec.episodes.length} 集`,
      );
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
      // THE EIGHT ITEMS REACH THE SCRIPT (TASK-089 §2.1 / TASK-094 批次 C). This read
      // `premise` / `logline` only, so an outline written by `story-development` v2
      // — whose content lives in storyCore / conflict / worldAndRules / mainline —
      // would have handed the script writer almost nothing. Legacy outlines still
      // work: each line prefers the new field and falls back to the old one.
      const ol = o.outline;
      const core = storydoc.storyCoreOf(ol);
      if (core) parts.push(`故事核心：${core}`);
      if (ol.premise && ol.premise !== core) parts.push(`前提：${ol.premise}`);
      if (ol.protagonist && (ol.protagonist.who || ol.protagonist.initialWant)) {
        parts.push(`主角与目标：${ol.protagonist.who}｜最初想要：${ol.protagonist.initialWant}`);
      }
      const cf = ol.conflict;
      if (cf && (cf.external || cf.internal)) parts.push(`核心冲突：外部 ${cf.external}｜内部 ${cf.internal}`);
      else if (ol.centralConflict) parts.push(`核心冲突：${ol.centralConflict}`);
      const war = ol.worldAndRules;
      if (war && (war.where || (war.rules || []).length)) {
        parts.push(`世界与规则：${war.where}${(war.rules || []).length ? `｜${war.rules.join("；")}` : ""}`);
      } else if (ol.world) parts.push(`世界观：${ol.world}`);
      const ml = ol.mainline;
      if (ml && Object.values(ml).some((v) => v && String(v).trim())) {
        parts.push(
          `故事主线：开端 ${ml.setup} → 发展 ${ml.development} → 中段转折 ${ml.midpointTurn}` +
          ` → 高潮 ${ml.climax} → 结局 ${ml.ending}`,
        );
      } else if (ol.storyArc) parts.push(`故事线：${ol.storyArc}`);
      const tc = ol.themeAndChange;
      if (tc && (tc.theme || tc.protagonistBecomes)) {
        parts.push(`主题与最终变化：${tc.theme}｜主角最后成为：${tc.protagonistBecomes}`);
      }
      if (ol.genreTone) parts.push(`题材/基调：${ol.genreTone}`);
    }
    if (entry) {
      // THE SEVEN FACETS REACH THE SCRIPT (TASK-094 批次 A). This read the prose
      // `synopsis` only, so a plan written by `episode-planner` v2 — whose content
      // lives in coreGoal / keyEvents / characterBeats / reveals / emotionArc —
      // would have handed the script writer an EMPTY episode brief. Old versions
      // still work: each line prefers the new field and falls back to the old one.
      const goal = (entry.coreGoal || entry.purpose || "").trim();
      const events = Array.isArray(entry.keyEvents) ? entry.keyEvents.filter((s) => s && s.trim()) : [];
      parts.push(`本集 EP${entry.epNumber}「${entry.title}」`);
      if (goal) parts.push(`本集核心目标：${goal}`);
      if (events.length) parts.push(`主要剧情：\n${events.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
      else if (entry.synopsis) parts.push(`本集梗概：${entry.synopsis}`);
      const beats = Array.isArray(entry.characterBeats) ? entry.characterBeats : [];
      if (beats.length) {
        parts.push(`角色推进：\n${beats
          .map((b) => `- ${b.who}：${b.change}${b.relationChange ? `（关系：${b.relationChange}）` : ""}`)
          .join("\n")}`);
      }
      const reveals = Array.isArray(entry.reveals) ? entry.reveals.filter((s) => s && s.trim()) : [];
      if (reveals.length) parts.push(`信息揭示：${reveals.join("；")}`);
      if (entry.emotionArc) parts.push(`情绪曲线：${entry.emotionArc}`);
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
          // WHAT THE CREATOR ALREADY HAS (TASK-090 §2.2 / 批次 E): the uploaded
          // assets, so the breakdown can point at an existing reference instead of
          // proposing a duplicate object, and the cast, so an entity that already
          // has a profile comes back as an update.
          raw = await query.generateBibleBreakdown(script, {
            assets: assetreg.listAssets(assetRegistry).map((a) => ({
              key: a.key, kind: a.kind, name: assetreg.derivedLabel(a),
              tags: a.tags, links: a.links,
            })),
            characters: productionDoc.characters.map((c) => ({
              characterId: c.characterId, name: c.name, tier: c.tier,
            })),
          });
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
    //
    // THREE KINDS, ONE TABLE (批次 4C). This used to be `isChar ? … : …`, and 道具
    // would have made it a three-way branch in five separate places — five chances
    // for 「道具走的是场景地那一支」. The kind is DATA: what to call it, how to find
    // it, how to write it, and whether it even HAS states (a prop does not, see
    // `bibledoc.sanitizeProp`). A fourth kind adds a row, not a branch.
    _kinds: {
      character: {
        word: "角色",
        find: (idv) => bibledoc.findCharacter(productionDoc, idv),
        add: (name) => bibledoc.addCharacter(productionDoc, name),
        idOf: (e) => e.characterId,
        writeProfile: (idv, f) => bibledoc.updateCharacterProfile(productionDoc, idv, f),
        addState: (idv, name) => bibledoc.addCharacterState(productionDoc, idv, name),
        // 只有人物有声音。**能力写在表里**，不靠调用点回忆 —— 否则 `voiceDescription`
        // 迟早会被写到一个没有 voice 的实体上（而 `entity.voice.description` 会抛）。
        setVoice: (idv, description) =>
          bibledoc.setCharacterVoice(productionDoc, idv, { description }),
        changes: (e, prop, mode) => breakdown.characterChanges(e, prop, mode),
      },
      location: {
        word: "场景地",
        find: (idv) => bibledoc.findLocation(productionDoc, idv),
        add: (name) => bibledoc.addLocation(productionDoc, name),
        idOf: (e) => e.locationId,
        writeProfile: (idv, f) => bibledoc.updateLocationProfile(productionDoc, idv, f),
        addState: (idv, name) => bibledoc.addLocationState(productionDoc, idv, name),
        changes: (e, prop, mode) => breakdown.locationChanges(e, prop, mode),
      },
      prop: {
        word: "道具",
        find: (idv) => bibledoc.findProp(productionDoc, idv),
        add: (name) => bibledoc.addProp(productionDoc, name),
        idOf: (e) => e.propId,
        writeProfile: (idv, f) => bibledoc.updatePropProfile(productionDoc, idv, f),
        // 道具没有状态。**null 是一个明确的答案**，不是一个空实现 ——
        // 给它一个 no-op 会让「加状态失败了」与「这类东西没有状态」看起来一样。
        addState: null,
        changes: (e, prop, mode) => breakdown.propChanges(e, prop, mode),
      },
    },
    /** 卡片种类 → 那一类的写法。`new-prop` / `update-prop` 都落到 `prop`。 */
    _kindOf: (cardKind) => {
      const name = String(cardKind || "").replace(/^(new|update)-/, "");
      return ctx.breakdown._kinds[name] || null;
    },
    addAsNew: (id) => {
      const card = (bibleProposals?.cards || []).find((c) => c.id === id);
      if (!card || !card.kind.startsWith("new-")) return null;
      const p = card.proposal;
      const K = ctx.breakdown._kindOf(card.kind);
      if (!K) return null;
      const entity = K.add(p.name);
      const entityId = K.idOf(entity);
      K.writeProfile(entityId, p);
      if (K.setVoice && p.voiceDescription) K.setVoice(entityId, p.voiceDescription);
      if (K.addState) {
        for (const st of Array.isArray(p.states) ? p.states : []) K.addState(entityId, st.name);
      }
      ctx.breakdown.dismiss(id);
      ctx.persist();
      toast(`已添加${K.word}「${p.name}」`);
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
      const K = ctx.breakdown._kindOf(card.kind);
      if (!K) return false;
      const targetId = entityId || card.entityId;
      const entity = K.find(targetId);
      if (!entity) return false;
      let fieldsToWrite;
      let statesToAdd;
      let skipped = 0;
      if (mode === "merge") {
        const changes = K.changes(entity, p, "merge");
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
      if (Object.keys(fields).length) K.writeProfile(targetId, fields);
      if (K.addState) for (const st of statesToAdd) K.addState(targetId, st.name);
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
      // THE VERSION MUST CARRY THE RECYCLE AREA TOO (TASK-097 批次 4B). Callers
      // read `ctx.project.draftShots`, which is LIVE shots only, so a list built
      // from it omits everything soft-deleted. Persisting that list would hard-
      // delete the recycled shots at the next reload — 「删除可撤销」 would hold
      // until the page refreshed, which is the worst kind of reversible.
      const full = mergeKeepingRecycled(shotMirror ? shotMirror.all() : null, items);
      const edited = normalizeShots(full, `v${v}`);
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
    /**
     * 软删除 / 撤销（TASK-095 §2.1 · AGENTS.md 第 13 条）。
     *
     * 走的是**同一条**保存路径（新的不可变草稿版本），只是写进去的列表带回收标记。
     * 没有第二条写路径 —— 那正是这个仓库反复付过代价的地方。
     */
    softDelete: (shotId) => {
      const all = shotMirror && shotMirror.all();
      if (!Array.isArray(all)) return false;
      const r = softDeleteShot(all, shotId, { at: new Date().toISOString() });
      if (!r.changed) return false;
      return ctx.shots.saveEdit(r.shots);
    },
    restoreDeleted: (shotId) => {
      const all = shotMirror && shotMirror.all();
      if (!Array.isArray(all)) return false;
      const r = restoreShot(all, shotId);
      if (!r.changed) return false;
      return ctx.shots.saveEdit(r.shots);
    },
    /** 回收区的内容（只读）。界面据此给出「撤销删除」。 */
    recycled: () => (shotMirror ? shotMirror.recycled() : []),
    /**
     * 删了会影响到哪儿 —— **派生扫描**（§2.6.1）。
     *
     * 不是闸门：软删除不销毁任何东西，撤销把它原位放回，所以这里只如实说后果，
     * 不拦（§2.5f 第二条）。
     */
    deletionImpact: (shotId) => deletionImpact(serializeGraph(), shotId),
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
  //   Domain context -> Skill -> Runtime -> structured Proposal
  //     -> AI Director review -> user Accept -> canonical controller write
  //
  // SKILLS — MOVED to src/controllers/skillctl.js (TASK-073 §1.8 第四批).
  // Attached after this literal (`ctx.skills = ...`). Its dependency face was
  // measured first: 10 documents, ALL READ, zero writes — so the silent-write
  // failure §5.10 records cannot arise here. Documents are still passed as GETTERS,
  // because reading a STALE document would record a context the prompt never
  // carried, which is a fabricated provenance and looks exactly like a real one.
  // `_clipChain` and the `pendingOrigin` intent moved with it: each had exactly one
  // caller, and both live inside this controller's rules.
  // ---------------------------------------------------------------------- //
  // Per-shot Prompt versions (ADR-0061 决策 5).
  //
  // A shot with no entry has NO prompt of its own and the compiled one is in
  // force — which is the honest default, not a value someone typed. The moment
  // the creator edits, or an applied Skill proposal writes, a real version is
  // recorded and every later one appends beside it.
  // ---------------------------------------------------------------------- //

  // ---------------------------------------------------------------------- //
  // Reference INTERPRETATION (ADR-0061 决策 4 / TASK-064 Phase 2 §21–§22).
  //
  // 「AI 解读输入」 stops being a label the moment a reading exists: the Prompt
  // compiler reads these and writes them into the effective prompt. Nothing here
  // infers a reading from a file — a reading has a human or a named Skill Run
  // behind it, always.
  // ---------------------------------------------------------------------- //
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
          // `coreGoal` is what `purpose` became at episode-planner v2 (TASK-088
          // §2.1); the fallback keeps every plan written before that readable.
          episodePlanNote: planEntry
            ? [planEntry.hook, planEntry.coreGoal || planEntry.purpose, planEntry.endingBeat]
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
  // MOVED to src/controllers/framectl.js (TASK-073 §1.8), where this section's
  // explanation now lives with the code. Left here, it came to sit directly above
  // the SHOT AUDIO header — the same misattribution as the `_writeCue` doc block
  // that ended up documenting `prodOp` (independent review).
  // ---------------------------------------------------------------------- //
  // ---------------------------------------------------------------------- //
  // Per-shot MULTI-TRACK AUDIO (ADR-0061 决策 6 / §37–§39).
  //
  //   Dialogue · VO · Ambience · SFX · Foley · BGM
  //     → clips with absolute or ANCHORED timing, trim, gain, fades
  //     → internal mix (local ffmpeg)
  //     → ONE derived Shot Mixed Audio Asset — sources untouched, always
  // ---------------------------------------------------------------------- //
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
        // 世界观 canon (TASK-090 §2.4 / 批次 F2). A PARTIAL write by construction:
        // `ctx.canon.updateWorld` merges, so the facets this proposal did not
        // mention keep whatever the creator wrote — and `skillapply` already
        // dropped any facet name this document does not have.
        case "updateWorldSetting": {
          const fields = a.fields;
          if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
            return { ok: false, error: "没有可写入的世界观条目" };
          }
          const keys = Object.keys(fields);
          if (!ctx.canon.updateWorld(fields)) return { ok: false, error: "无法写入世界观" };
          // WHAT CHANGED, named. 「已应用」 with no list leaves the creator to diff a
          // seven-field document by eye to find out what they just accepted.
          return { ok: true, detail: `已写入世界观的 ${keys.length} 项：${keys.join("、")}` };
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
    /**
     * TASK-092's SIX stages with their gates, for one shot (ADR-0073).
     *
     * The evidence is assembled HERE because each piece lives in a different
     * registry — and `shotstage` stays pure so 「崩溃后 in_progress 会不会说谎」 is
     * testable without a backend.
     *
     * THIS IS THE ONE COMPUTATION (§2.4). The canvas, the wizard and QC all read
     * it; none of them re-derives a status. `inflight` reads the generation
     * registry, `artifact` requires the probe to actually say the bytes are there
     * (a declaration is not evidence — TASK-077's `storageState` lesson), and
     * `approvedFor` is the existing approval bound to the artifact.
     */
    stageBoard: (shotId) => {
      const shot = (ctx.project.draftShots || []).find((s) => s && s.shotId === shotId) || null;
      const media = ctx.shot.mediaOf(shot);
      const gens = (generationRegistry.generations || []).filter((g) => g && g.targetId === shotId);
      const inflightOf = (kind) => gens.some(
        (g) => g.type === kind && (g.status === "queued" || g.status === "generating"),
      );
      // THE PROBE'S VERDICT, not the registry's declaration — and the four possible
      // verdicts do NOT collapse into two (codex 轮 5, P1).
      //
      // Two different questions read this same tri-state, and they must read it
      // differently. `mediaprobe`'s own rule is about not crying wolf; this one is
      // about not claiming completion. Both are right:
      //
      //   「这张图丢了吗」   INCONCLUSIVE → 不说丢了   (mediaprobe.js 的规则)
      //   「这一步做完了吗」 INCONCLUSIVE → 不说做完了 (本条)
      //
      //   PRESENT       done: the probe confirmed the bytes
      //   MISSING       not done: they are gone
      //   INCONCLUSIVE  not done: we ASKED and could not confirm. A gate opening on
      //                 this would spend money against unverified media.
      //   null          done: nobody has asked yet. The probe scans lazily, and the
      //                 registry's current-asset pointer is the evidence we hold. That
      //                 is a genuinely different position from INCONCLUSIVE — one is
      //                 unanswered, the other is answered "cannot tell".
      //
      // ADR-0073 决策 2 said 「探针没有判定它 MISSING」, which is what let the loose
      // check through; that wording is corrected to match this.
      const present = (url) => {
        const verdict = mediaProbe.stateOf(url);
        if (verdict === mediaprobe.MISSING) return false;
        if (verdict === mediaprobe.INCONCLUSIVE) return false;
        return true;
      };
      return shotstage.stageBoard(productionDoc.shotProduction.stages, shotId, {
        // ATTRIBUTED ONLY WHERE THE PIPELINE REALLY FEEDS (codex 轮 3, P1). Mapping an
        // in-flight `image` generation onto BOTH `storyboard` and `keyframe` showed
        // false progress on a stage nothing was running for — and `in_progress` feeds
        // the gates, so a wrong one changes what the creator is told they can start.
        //
        // A generation record carries `type: image | video | audio`; it does NOT say
        // whether an image is a draft sketch or a final keyframe. So each stage claims
        // only the run it can genuinely own today:
        //
        //   keyframe  the existing image pipeline produces THIS
        //   video     the existing video pipeline
        //   voice     the existing TTS path (dialogue)
        //   storyboard / sfx  have no generation path yet (4F / 5A). They report
        //                     `not_started`, which is the honest answer — inventing
        //                     progress for them would be the 「声明当事实」 this whole
        //                     card removes.
        inflight: (stage) => {
          if (stage === "keyframe") return inflightOf("image");
          if (stage === "video") return inflightOf("video");
          if (stage === "voice") return inflightOf("audio");
          return false;
        },
        artifact: (stage) => {
          if (stage === "keyframe") {
            const url = ctx.episode.mediaUrl(shot, "images");
            return media.image ? { assetId: media.imageAssetId || null, present: present(url) } : null;
          }
          if (stage === "video") {
            const url = ctx.episode.mediaUrl(shot, "videos");
            return media.video ? { assetId: media.videoAssetId || null, present: present(url) } : null;
          }
          // ④ 草图的通道在批次 4F 接上：它是资产登记表里 kind 为 `storyboard`、
          // 链到这一镜的那一张（`ctx.storyboard.draftOf` 是唯一的那处查找）。
          if (stage === "storyboard") {
            const d = ctx.storyboard.draftOf(shotId);
            return d ? { assetId: d.assetId, present: d.present } : null;
          }
          // ⑦⑧ 配音 / 音效的通道在批次 5A 接上：它是这一镜**音频轨上的片段**
          // （`poststatus.STAGE_TRACKS` 说哪条轨算哪一步），而「在不在」仍然要探针说话
          // —— 与 keyframe / video 同一口径。
          if (stage === "voice" || stage === "sfx") {
            const ev = poststatus.audioEvidence(ctx.shotAudio.clips(shotId), {
              presentOf: (assetId) => {
                const hit = assetId ? ctx.assets.find(assetId) : null;
                // 片段指着一个已经不在登记表里的资产 = fail-closed，不是「在」
                return hit ? present(hit.record.url || "") : false;
              },
            });
            return ev[stage];
          }
          // qc 仍然没有通道（5B）。返回 null 是老实话：`not_started`，
          // 不是猜一个「已完成」。
          return null;
        },
        // **分阶段问**（批次 4F）：`video` 问审片那条记录，图片类问 `stageReviews`。
        // 共用一条记录会让「通过了视频」把「通过了草图」翻掉，于是 ④→⑤ 那道闸门
        // 在视频做完之后自己关上。一个函数知道该问哪一份（§2.5e）。
        approvedFor: (assetId, stage) =>
          shotprod.isStageArtifactApproved(productionDoc, shotId, stage, assetId),
        // 「台词已确认」 is a fact about the SCRIPT, not a seventh stage (ADR-0073).
        // A shot with a line written counts as settled; one with no line at all is
        // `skipped` — it needs no voice, and that is a decision, not a gap.
        fact: (name) => {
          if (name !== "dialogue") return null;
          const line = shot && typeof shot.dialogue === "string" ? shot.dialogue.trim() : "";
          return line ? "completed" : "skipped";
        },
      });
    },
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
        decisionId: review.newDecisionId("shot", shotId),
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
        // AND OUT OF THE CANVAS (TASK-103 批次 B / TASK-087 §1.2). Deliberately NOT
        // awaited: the approval already happened locally and is already saved, so
        // making the button wait on the backend would turn a local fact into a
        // network-latency fact. What must not happen is the result being lost —
        // `syncReviewToCore` records it in the ledger and the page shows it.
        syncReviewToCore(reviewsync.evaluationFor(dec.value), dec.value.decisionId, shotId);
      }
      return ok;
    },
    /** Re-send this shot's LATEST review decision to the core.
     *
     *  Needed because an interrupted or refused sync is otherwise unreachable:
     *  once a shot is approved the 「✓ 通过」 button is replaced by 「撤销通过」,
     *  so there is no way to ask again. Re-sends the SAME decision — same
     *  `evaluation_id`, so the gateway's idempotency makes a duplicate press a
     *  no-op rather than a second evaluation.
     */
    resyncReview: (shotId) => {
      const d = review.latestDecision(reviewsDoc.decisions, { layer: "shot", targetId: shotId });
      if (!d) { toast("这一镜还没有审片结论可登记"); return false; }
      // A retry ON TOP OF a live attempt is a duplicate, not a retry (codex 轮 3).
      // It would overwrite the shared `pending` entry, let the earlier attempt's
      // result overwrite it back, and hand the creator another 重试 button — one
      // press turning into a queue of identical requests.
      const live = (reviewsDoc.coreSync || {})[d.decisionId];
      if (live && live.state === "pending") { toast("正在登记中，先等这一次的结果"); return false; }
      syncReviewToCore(reviewsync.evaluationFor(d), d.decisionId, shotId);
      return true;
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
        decisionId: review.newDecisionId("shot", shotId),
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
        // A WITHDRAWAL IS ALSO A FACT THE CORE MUST HEAR. Recording only approvals
        // would leave the core believing a shot passed after the creator took it
        // back — the core's copy would be a stale half of the story, which is worse
        // than not having one.
        syncReviewToCore(reviewsync.evaluationFor(undo.value), undo.value.decisionId, shotId);
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
        // 这一镜最近一条审片结论的登记回执（TASK-103 批次 B）。按 decisionId 取，
        // 所以显示的永远是**当前这条结论**的去向，不是历史上任意一次的。
        coreSyncOf: (shotId) => {
          const d = review.latestDecision(reviewsDoc.decisions, { layer: "shot", targetId: shotId });
          return d ? (reviewsDoc.coreSync || {})[d.decisionId] || null : null;
        },
        mediaOf: (s) => ctx.shot.mediaOf(s),
        urlOf: (s) => {
          const slot = ctx.shot._slotOf(s);
          return slot ? mediaref.slotUrl(assetRegistry.videos, slot) : "";
        },
      });
    },
  },
  // ---------------------------------------------------------------------- //
  // ⑨ 粗剪审片 · 故事板 (TASK-079 §1.1). DERIVED on every call from the dailies
  // model (which owns the shot walk, including the unassigned pool) and the ONE
  // shot detail model. No new state, no second status computation — this is a
  // different SHAPE over the same standing the per-shot walk shows.
  review: {
    board: (filter) => reviewBoardModel(
      ctx.dailies.model(),
      (shotId) => shotDetailModel(ctx.prodData(), shotId),
      {
        filter,
        media: {
          measuredOf: (url) => (url ? mediaMeasured.get(url) || null : null),
          // 真实字节数来自那一次目录审计，免费且总是有 —— 但它**不是**尺寸，
          // 所以只作附注（见 `sizeText`），绝不冒充像素值。
          bytesOf: (url) => {
            const name = mediaprobe.uploadName(url, PROJECT_NAME);
            const e = name && mediaAuditFiles[name];
            return e && Number.isFinite(e.bytes) ? e.bytes : null;
          },
        },
      },
    ),
    /** 测量一个媒体文件的真实尺寸/时长。只读，不花钱，一次一个。 */
    measure: async (url) => {
      const name = mediaprobe.uploadName(url, PROJECT_NAME);
      if (!CONNECTED || !name) {
        // 演示模式或非项目媒体：如实说测不了，而不是留一个按不动的按钮
        mediaMeasured.set(url, { state: "not_found" });
        return false;
      }
      try {
        const j = await query.getMediaAudit(PROJECT_NAME, name);
        mediaAuditFiles = (j && j.files) || mediaAuditFiles;
        mediaMeasured.set(url, (j && j.measured) || { state: "unreadable" });
      } catch (e) {
        // 后端故障不是关于这个文件的事实 —— 不缓存，让创作者可以再按一次
        toast(`测量失败：${(e && e.message) || "读不到后端"}`);
        return false;
      }
      return true;
    },
  },
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
  // TASK-077 §1.2 — DISPLAY-ONLY media presence. Deliberately NOT part of
  // ctx.storage: everything on that controller WRITES, and this one is forbidden
  // from writing. It never touches `storageState`; reconciling the declaration
  // with the disk is a persistence decision and is a follow-up, not this card.
  mediaProbe: {
    isMissing: (url) => mediaProbe.isMissing(url),
    isKnown: (url) => mediaProbe.isKnown(url),
    observe: (url, present) => mediaProbe.observe(url, present),
    /** Probe every URL the registry declares. Resolves true when something new
     *  was learned, so the caller re-renders exactly once.
     *
     *  SERVER AUDIT FIRST (TASK-103 批次 C). When connected, one request answers
     *  for every project media file at once, authoritatively — no per-URL `HEAD`,
     *  and no `INCONCLUSIVE` for files sitting on the creator's own disk. The
     *  `HEAD` scan still runs afterwards for whatever the audit did not decide
     *  (canvas-local paths, a truncated listing), so nothing loses coverage.
     *
     *  An audit that FAILS is not an answer: we fall through to the probe rather
     *  than let a backend fault read as 「都不在」. */
    scanRegistry: async () => {
      const urls = mediaprobe.registryUrls(assetRegistry);
      let changed = false;
      if (CONNECTED) {
        try {
          const audit = await query.getMediaAudit(PROJECT_NAME);
          mediaAuditFiles = (audit && audit.files) || {};
          changed = mediaProbe.applyAudit(urls, PROJECT_NAME, audit);
        } catch {
          /* audit unavailable — the HEAD scan below is still the honest fallback */
        }
      }
      const scanned = await mediaProbe.scan(urls);
      return changed || scanned;
    },
    checked: () => mediaProbe.checked(),
  },
  // ---------------------------------------------------------------------- //
  // Asset Registration controller (CP2 / ADR-0055) — the ONE import path.
  //
  // 上传 ≠ 保存文件。Every page that produces or receives media calls
  // `ctx.assets.import*`: the file is written by the existing upload endpoint
  // (collision-safe `<slug>_v<N>.<ext>`), DECLARED in the same call, registered
  // through the M3 single media write path, and immediately visible everywhere.
  // No page implements its own upload logic, so no page can forget a step.
  // ---------------------------------------------------------------------- //
  /** The assets THE FILM ACTUALLY USES, or null when that list cannot be built.
   *
   *  NOT `ctx.assets.list()`: that is the whole project registry — every history
   *  entry of every domain, including superseded versions, rejected takes and other
   *  episodes' material. `checkRights` is contracted as 「成片用到的素材清单」, so
   *  feeding it the registry made one unused old record with no `origin` a BLOCKING
   *  素材权限 failure on an episode that never touched it, while a green row counted
   *  assets outside the cut and therefore said nothing about the film (independent
   *  review).
   *
   *  A clip whose asset cannot be resolved makes the list INCOMPLETE, and an
   *  incomplete list is reported as unknown rather than as a rights failure: 「查不到
   *  这个素材」 and 「这个素材没标来源」 are different findings, and only the second
   *  one is what this check is about. */
  _cutAssets: () => {
    const t = ctx.timeline && ctx.timeline.doc ? ctx.timeline.doc() : null;
    if (!t) return null; // no timeline at all — nothing to read
    const live = timeline.liveClips(t);
    const byId = new Map();
    for (const c of live) {
      const id = typeof c.assetId === "string" ? c.assetId : "";
      if (!id || byId.has(id)) continue;
      const hit = assetlib.findAssetById(assetRegistry, id);
      // The list is INCOMPLETE. `null` is the only value that says so, and saying so
      // matters more than the verdict does: every branch here ends in `unavailable`
      // either way, but 「清单没拿全」 and 「这条片子还没用到素材」 send the creator
      // to different places (independent review, round 3).
      if (!hit || !hit.record) return null;
      byId.set(id, { assetId: id, origin: hit.record.origin || "" });
    }
    // A cut that exists and uses no assets is an EMPTY list, not an unreadable one.
    return [...byId.values()];
  },

  /** The CUT's duration in ms, or null when there is no cut yet.
   *
   *  `timelineDuration` counts seconds and returns 0 for an empty timeline. A 0
   *  handed to the QC would mark every cue as running past the end of the film, so
   *  「还没有剪辑」 is reported as UNKNOWN instead — the same rule 「没跑不等于通过」
   *  follows, in the other direction. */
  _cutDurationMs: () => {
    const t = ctx.timeline && ctx.timeline.doc ? ctx.timeline.doc() : null;
    if (!t) return null;
    const secs = timeline.timelineDuration(t);
    return typeof secs === "number" && secs > 0 ? Math.round(secs * 1000) : null;
  },

  /**
   * ⑩ 交付质检 (TASK-074 §1.2) — the layer-3 report, and G4's verdict on it.
   *
   * WHAT IS AND IS NOT MEASURED, and why the difference is visible. A browser cannot
   * run ffmpeg, so `probe` is null and the five probe-based checks answer
   * `unavailable` WITH the reason. That is the requirement, not a shortfall:
   * 「检测能力缺失时该项显示 unavailable + 原因，绝不产生一条『通过』的结论」
   * (§1.2 / ADR-0064 决策 6). Feeding them a fabricated probe to make the screen
   * look complete is the exact failure the rule exists to prevent.
   *
   * `durationMs` comes from the CUT, not from the file and not from ⚙. The rendered
   * file's duration needs a probe; ⚙'s `episodeSeconds` is a target, and checking
   * cues against a target answers a different question. The timeline is the thing the
   * cues were authored against, so 「这条字幕跑到片子外面去了」 is answerable from it
   * — and an empty timeline yields null (unknown), never 0, because a 0 would mark
   * every cue as out of range.
   *
   * Deterministic issue ids: keyed on the episode and the row, never on a clock, so
   * re-running the report does not mint a second copy of the same finding.
   */
  /** Every registered cut, oldest first. Finals have no chain (assetreg §492),
   *  so registration order IS version order. */
  _cuts: () =>
    ctx.assets
      .list()
      .filter((a) => a && a.kind === "final" && a.url)
      .map((a) => ({
        assetId: a.assetId,
        url: a.url,
        name: String(a.url).split("/").filter(Boolean).pop() || "",
      }))
      .filter((c) => c.name),

  /** The cut a measurement applies to: an explicitly chosen one, else the newest.
   *
   *  A measurement that does not say WHICH file it measured is not actionable,
   *  so the name travels with the probe everywhere it is shown. */
  _selectedCut: (assetId = null) => {
    const cuts = ctx._cuts();
    if (!cuts.length) return null;
    if (assetId) return cuts.find((c) => c.assetId === assetId) || null;
    return cuts[cuts.length - 1];
  },

  /** Run the REAL probe (TASK-074 §1.2 接线). Pass an `assetId` to measure a
   *  SPECIFIC cut — that is what makes 「哪一版」 a real choice on the 成片 tab
   *  rather than an implicit 「最后那条」 (§1.1 成片预览).
   *
   *  Failures are kept and shown rather than thrown away: 「没跑成」 and
   *  「没跑过」 send the creator to different places, and a silent catch would
   *  make a 503「装个 ffmpeg」 look identical to never pressing the button. */
  runDeliveryProbe: async (assetId = null) => {
    if (!CONNECTED) {
      DELIVERY_PROBE = { assetId: null, name: null, probe: null, error: "演示模式无后端，无法跑真实探测", running: false };
      return DELIVERY_PROBE;
    }
    const cut = ctx._selectedCut(assetId);
    if (!cut) {
      DELIVERY_PROBE = { assetId: null, name: null, probe: null, error: "还没有成片可测：先渲染一版成片", running: false };
      return DELIVERY_PROBE;
    }
    DELIVERY_PROBE = { assetId: cut.assetId, name: cut.name, probe: null, error: null, running: true };
    const res = await query.deliveryProbe(PROJECT_NAME, cut.name);
    DELIVERY_PROBE = res.ok
      ? { assetId: cut.assetId, name: cut.name, probe: (res.data && res.data.probe) || null, error: null, running: false }
      : {
        assetId: cut.assetId,
        name: cut.name,
        probe: null,
        error: (res.error && res.error.detail) || (res.error && res.error.category) || "探测失败",
        running: false,
      };
    return DELIVERY_PROBE;
  },

  /** THIS cut measured against ⚙ 成片规格 (§1.1 成片预览「与规格对照」).
   *
   *  Returns null unless the probe on record is for THIS cut: showing v1's
   *  numbers on v2's row would be a comparison of two different files, and the
   *  creator has no way to see that from the screen. Re-measuring is one click.
   */
  cutSpecCheck: (assetId) =>
    specCheckForCut(assetId, DELIVERY_PROBE, { ...deliverySpecDoc }),

  /** What the probe last did, for any surface that shows it. */
  probeState: () => ({
    assetId: DELIVERY_PROBE.assetId,
    name: DELIVERY_PROBE.name,
    running: DELIVERY_PROBE.running,
    error: DELIVERY_PROBE.error,
    measured: DELIVERY_PROBE.probe !== null,
  }),

  deliveryQc: () => {
    const ep = (productionDoc && productionDoc.activeEpisodeId) || "delivery";
    const report = deliveryqc.runDeliveryQc(
      {
        probe: DELIVERY_PROBE.probe,
        subtitleTrack: ctx.subtitles.track(),
        spec: { ...deliverySpecDoc },
        assets: ctx._cutAssets(),
        durationMs: ctx._cutDurationMs(),
        deliveryId: ep,
      },
      { issueIdFor: (k, n) => `qc-${ep}-${k}-${n}` },
    );
    return {
      report,
      // ONE decision point: the panel renders this verdict, it does not re-derive it
      g4: g4Export(report),
      // The explanation under the table is DERIVED from the rows by the panel — a
      // fixed sentence kept telling the creator to go fill ⚙ after they already had
      // (independent review), and it is presentation, so it belongs there.
      //
      // The probe's own state travels WITH the report: which file was measured,
      // whether a scan is running, and why one failed. Without it the five
      // ffmpeg rows say 未检查 in three different situations — never pressed,
      // pressed and failed, pressed and still running — and the creator cannot
      // tell which.
      probe: ctx.probeState(),
      hasCut: ctx._cuts().length > 0,
    };
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
  /** 「⚡报价」 for ONE shot's paid video generation (TASK-078 §3).
   *
   *  READ-ONLY and PRICE-HONEST: the number comes from the Gateway preflight's
   *  locked-catalog quote, never from arithmetic in the browser. The card is
   *  forbidden to compute a price from `config/providers` itself — that would be
   *  a second pricing implementation, and the one that is wrong is always the one
   *  the creator read before spending. */
  paidQuote: (shotId) => paidVideoQuote(shotId),
  /** The ADR-0041 two-step submit for ONE shot (preflight → 人工确认 → command).
   *  Deliberately the SAME function the paid route already used: the card is a
   *  new surface onto it, not a new write path. */
  paidSubmit: (shotId) => paidGenerate(shotId),
  /** WHICH generation route the creator is on (TASK-077 §1.3).
   *
   *  `gateway` — the ADR-0041 write path is live, so a video generation is a real
   *  submit and `cloud_minimax._payload` decides what the model receives: one
   *  image, the first frame.
   *  `manual`  — the creator copies the compiled Prompt into an external tool and
   *  attaches the files, so every reference image really is model input.
   *
   *  Derived, never stored: it is a property of how the backend was started. */
  genRoute: () => (PAID ? "gateway" : "manual"),
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
  failGeneration: (generationId, status, reason = null) => {
    const g = genlib.failGeneration(generationRegistry, generationId, status, reason);
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
      // TASK-077 §1.3: WHICH route the compiled prompts are for. The Gateway
      // route sends one image (the first frame), so a line promising 「作为参考图
      // 一并提供」 would be describing something that does not happen.
      route: PAID ? "gateway" : "manual",
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
/** 装上镜头列表镜像（见 `let shotMirror` 那段）。换项目会重建 `ctx.project`，
 *  所以每一个新的项目对象都要经过这里 —— 否则那个项目的 `draftShots` 是一个普通
 *  属性，过滤与「赋值不丢回收区」两条保证同时失效，而且**不报错**。 */
function useShotMirror(project) {
  const initial = Array.isArray(project.draftShots) ? project.draftShots : null;
  shotMirror = installShotMirror(project, initial);
  return shotMirror;
}
useShotMirror(ctx.project);

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

// TASK-073 §1.8 第五批：提示词域。三层一起搬 —— `prompt` 是一份提示词的版本账，
// `basePrompt` 把一个基础资产实体翻译成那本账里的一个 key（它的四个写操作全部是
// 对 `prompt` 的转发），`promptBatch` 读的就是这两层编译出来的结果。分开搬会让
// 「同一份提示词」的三层各持一段，谁也说不全。
//
// **批次状态要一个显式的写口子**：`promptBatchState` 是会被整体替换的模块级
// `let`，文档那种只读 getter 不够用。给 `{ get, set }` 而不是把状态搬进控制器，
// 是因为 restore 仍然要能把它清掉 —— 真相只留一份，在 app.js。
ctx._prompts = createPromptController({
  docs: { prompts: () => promptsDoc, production: () => productionDoc },
  batchState: {
    get: () => promptBatchState,
    set: (next) => { promptBatchState = next; },
  },
  modules: { bibledoc, promptdoc, baseassets, promptbatch, skills },
  compileEntityBasePrompt,
  confirmedGenreTone: () => confirmedGenreTone(),
  shotDetailModel: (pd, shotId) => shotDetailModel(pd, shotId),
  prodData: () => ctx.prodData(),
  wizardCounts: () => ctx.prodWizard.counts(),
  // 经 `ctx.promptBatch._askGateway` 而不是直接调函数：那个属性原本就是测试
  // 替换的缝，直接调会让替换悄悄失效（替换的属性没人读）。
  preflight: (batch) => ctx.promptBatch._askGateway(batch),
  paidRoute: () => (PAID ? "gateway" : "local"),
  projectName: () => PROJECT_NAME,
  prodOp,
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  toast: (text) => toast(text),
  now: () => new Date().toISOString(),
});
ctx.prompt = ctx._prompts.prompt;
ctx.basePrompt = ctx._prompts.basePrompt;
ctx.promptBatch = ctx._prompts.promptBatch;
// 原来是 `ctx.promptBatch._askGateway`，抽出来是为了让测试能替换它而不必碰状态机
// —— 那个理由没变，所以它保持可替换，只是换到了这一层。
ctx.promptBatch._askGateway = (batch) => askPromptBatchGateway(batch);

// TASK-073 §1.8: 参考解读 + 参考用途 —— 同一个域的两面（「这张参考读出了什么」与
// 「它服务哪一边」），由同一份绑定列表派生，因此一起搬出去。旧的 `ctx.refInterp` /
// `ctx.refUse` 保持原名指向控制器的两半，调用点一处不用改。
ctx._refs = createReferenceController({
  docs: { refInterp: () => refInterpDoc, refUse: () => refUseDoc },
  modules: { refinterp, refuse, assetreg },
  referencesOfShot: (shotId) => ctx.episode.referencesOfShot(shotId),
  chainOf: (refKey) => ctx.assets.chainOf(refKey),
  prodOp,
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  now: () => new Date().toISOString(),
});
ctx.refInterp = ctx._refs.interp;
ctx.refUse = ctx._refs.use;

// TASK-073 §1.8: 字幕控制器。`_writeCue` 跟着一起搬 —— 它是 app.js 里只被这个
// 控制器的 update / applyFix 用到的模块级辅助，而且它持有那条容易写错两次的规则
// （合并 + 编辑要么整体生效要么整体不生效）。把事务和它仅有的调用方留在两个文件里
// 没有道理。
ctx.subtitles = createSubtitleController({
  docs: {
    subtitles: () => subtitlesDoc,
    production: () => productionDoc,
    timelines: () => timelinesDoc,
  },
  modules: { subtitle, timeline },
  findShot: (shotId) => ctx.shot.find(shotId),
  isCueLocked: (cueId) => ctx.locks.is("subtitle", cueId),
  prodOp,
  prodNew,
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  now: () => new Date().toISOString(),
});

// TASK-073 §1.8: 镜头音频。这一个的依赖列表是全组里最长的 —— mixNow 要读登记、
// 调后端、登记 Asset、记一条 Generation、再写混音指针。在 app.js 里这五件事是
// 看不见的（它们只是作用域里的名字）。列出来才看得出它是音频面里波及最广的操作。
ctx.shotAudio = createShotAudioController({
  docs: {
    shotAudio: () => shotAudioDoc,
    production: () => productionDoc,
    registry: () => assetRegistry,
  },
  modules: { shotaudio, proddoc, mediaref, assetreg, assetlib },
  findShot: (shotId) => ctx.shot.find(shotId),
  slotOf: (shot) => ctx.shot._slotOf(shot),
  contextOfShot,
  session: { connected: () => CONNECTED, projectName: () => PROJECT_NAME },
  mixShotAudio: (project, key, clips) => command.mixShotAudio(project, key, clips),
  generations: {
    start: (entry) => ctx.startGeneration(entry),
    complete: (id, ids) => ctx.completeGeneration(id, ids),
  },
  refreshType: (t) => ctx.refreshType(t),
  prodOp,
  prodNew,
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  toast,
  now: () => new Date().toISOString(),
});

// 白膜视频（TASK-098）。名字先 grep 过（§2.5f 第三条：`ctx` 上撞名不报错，
// 只是行为静默变成另一个）—— 仓库里没有第二个 `motionPreview`。
//
// 依赖列表短得刻意：它读登记表、读那一镜的运镜与时长、调本地 ffmpeg、登记一份
// 预览。**没有 generations、没有 gateway、没有 budget** —— 零花费是本卡的前提，
// 而一个不需要付费依赖的操作就不该把它们接进来。
ctx.motionPreview = createMotionPreviewController({
  docs: { registry: () => assetRegistry },
  modules: { motionpreview, mediaref, assetreg },
  findShot: (shotId) => ctx.shot.find(shotId),
  slotOf: (shot) => ctx.shot._slotOf(shot),
  keyframeOf: (shotId) => ctx.keyframe.frameOf(shotId),
  // 第二档：这一镜**当前那张镜头图片**（`mediaOf` 读的正是这条链）。
  // 实测两个真实项目里 `keyframe` 一张都还没产出过，只认关键帧会让白膜在现有
  // 项目上一次也跑不起来 —— 退档是允许的，**静默退档不是**（界面与 toast 都
  // 报出用的是哪一档，见 `motionpreview.SOURCE_TIERS`）。
  shotImageOf: (shotId) => {
    const shot = ctx.shot.find(shotId);
    const slot = shot ? ctx.shot._slotOf(shot) : null;
    if (!slot) return null;
    const ref = mediaref.currentRef(assetRegistry.images, slot);
    return ref && ref.url ? { url: ref.url, assetId: ref.assetId || null } : null;
  },
  contextOfShot,
  session: { connected: () => CONNECTED, projectName: () => PROJECT_NAME },
  renderMotionPreview: (project, slug, image, spec) =>
    command.renderMotionPreview(project, slug, image, spec),
  refreshType: (t) => ctx.refreshType(t),
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  toast,
});

// TASK-073 §1.8: 首/尾帧。grabVideoFrame 用注入而不是 import —— 它读的是
// <video> 元素，是这里唯一真正绑定浏览器的一步；把它注入进来，这个模块的其余部分
// 才能在测试里被构造出来。
ctx.frames = createFrameController({
  docs: {
    frameBindings: () => frameBindingsDoc,
    registry: () => assetRegistry,
    production: () => productionDoc,
  },
  modules: { framebind, mediaref, assetreg, assetlib, proddoc },
  findShot: (shotId) => ctx.shot.find(shotId),
  slotOf: (shot) => ctx.shot._slotOf(shot),
  contextOfShot,
  session: { connected: () => CONNECTED, projectName: () => PROJECT_NAME },
  uploadAssetImage: (project, key, file) => command.uploadAssetImage(project, key, file),
  grabVideoFrame,
  mintId,
  refreshType: (t) => ctx.refreshType(t),
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  toast,
  now: () => new Date().toISOString(),
});

// TASK-073 §1.8 第三批。Documents as GETTERS: `assetRegistry` / `productionDoc` /
// `timelinesDoc` / `generationRegistry` are module-level `let`s reassigned on
// project load, so a controller that captured their VALUES would keep reading
// and WRITING the previous project's registry (§5.10).
ctx.assets = createAssetController({
  docs: {
    registry: () => assetRegistry,
    production: () => productionDoc,
    timelines: () => timelinesDoc,
    generations: () => generationRegistry,
  },
  modules: { assetreg, assetlib, mediaref, assetusage, assetlibws },
  session: { connected: () => CONNECTED, projectName: () => PROJECT_NAME },
  uploadAssetImage: (project, key, file) => query.uploadAssetImage(project, key, file),
  pickFile,
  mediaDomainOfFile,
  domainSlugPrefix,
  // the ONE active-pointer write path stays where it was — this controller
  // delegates instead of re-implementing it
  setCurrentVersion: (domainWord, key, version) => ctx.media.setCurrent(domainWord, key, version),
  draftShots: () => ctx.project.draftShots,
  refreshType: (t) => ctx.refreshType(t),
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
  toast,
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

// TASK-073 §1.8 第四批 — 最大的一块（853 行）。开工前先量了依赖面：**10 份文档
// 全是读、0 处写入**，所以搬迁不可能引入「写进上一个项目」那类静默错误（§5.10）。
// 但反过来那一半仍然在：**读到过期文档**会记录下 prompt 从未携带的 context，
// 那是一条伪造的溯源，而伪造的溯源和真的长得一模一样。因此文档照样以 getter 传入。
//
// `CATALOG_DETAIL` / `CATALOG_PROBLEMS` 也是 getter：它们是启动时安装能力目录才
// 被赋值的模块级 `let`，捕获它们的值会让面板永远报「能力目录尚未加载」。
// ⚙ 项目健康 (TASK-082 §1.1) — READ ONLY, and cached per project. `standing` is
// the SAME `REAL_STANDING` the top bar's ⚠ counts, handed over rather than
// re-fetched, so the badge and its drill-down cannot describe two different reads.
ctx.health = {
  // A cache belonging to ANOTHER project reads as 「还没读」, never as that
  // project's data — see the note on HEALTH_EMPTY.
  get: () => (HEALTH.project === PROJECT_NAME
    ? { ...HEALTH, standing: REAL_STANDING }
    : { ...HEALTH_EMPTY, standing: REAL_STANDING }),
  load: () => loadHealth(),
};

ctx.skills = createSkillController({
  docs: {
    runs: () => skillRunRegistry,
    production: () => productionDoc,
    story: () => storyDoc,
    script: () => scriptDoc,
    registry: () => assetRegistry,
    refInterp: () => refInterpDoc,
    timelines: () => timelinesDoc,
    shotAudio: () => shotAudioDoc,
    subtitles: () => subtitlesDoc,
    generations: () => generationRegistry,
  },
  catalog: { detail: () => CATALOG_DETAIL, problems: () => CATALOG_PROBLEMS },
  modules: {
    skills, runtime, skillrun, skillapply, shotctx,
    proddoc, storydoc, scriptdoc, assetreg, refinterp, timeline, subtitle, mediaref,
  },
  findShot: (shotId) => ctx.shot.find(shotId),
  slotOf: (shot) => ctx.shot._slotOf(shot),
  isLocked: (kind, id) => ctx.locks.is(kind, id),
  shotAudio: {
    resolved: (shotId) => ctx.shotAudio.resolved(shotId),
    anchors: (shotId) => ctx.shotAudio.anchors(shotId),
  },
  shotCtx: {
    build: (shotId) => ctx.shotctx.build(shotId),
    candidates: (shotId) => ctx.shotctx.candidates(shotId),
  },
  draftShots: () => ctx.project.draftShots,
  // the ONE path a proposal may reach canon through — every write still goes
  // through the ordinary domain controller, never from here
  dispatchAction: (act, origin) => ctx.actions.dispatch(act, origin),
  persist: () => ctx.persist(),
  refresh: () => refreshProductionView(),
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
ctx.wizard = createWizard({
  estimate: { open: (o) => ctx.estimate(o) },
  getProject: () => ctx.project,
  // TASK-078 §2.3.3: step ② counts ENTITIES with/without a reference image, which
  // needs the production document and the asset registry — `ctx.project` holds
  // neither. Same read model every workspace uses; the wizard writes nothing.
  prodData: () => ctx.prodData(),
  refresh: (n) => engine.refreshBody(n),
});
ctx.shotEditor = createShotEditor({ toast });

// --- Production ⇄ Workflow views (creator-facing shell vs node canvas) ------
// Both are views over the SAME state (scriptDoc + engine graph) — switching
// only toggles display and re-renders the surface being entered, so nothing
// is ever lost. Production is the default creator-facing area.
// `onNavigate` keeps the top bar honest: the shell reports its own space after
// every render, so an in-shell move (「进入剧集制作 →」, an empty state's jump, a
// provenance hand-off) can never leave 故事开发 highlighted while 剧集制作 is on
// screen. The bar never derives the active space itself — there is one owner.
// …and, since TASK-081, it also writes the ADDRESS BAR from that same report.
// Writing the URL from `render()` rather than from each mover is what makes
// 「URL 说的就是你在哪」 true by construction: a new way to move cannot forget it.
const production = createProduction(() => ctx, {
  onNavigate: () => { syncTopBar(); writeUrl(); },
});
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
/** 装载时的台账修正：上一次会话留下的 `pending` 是**中断**，不是进行中。
 *
 *  两者要求的下一步不同 —— 一个是等，一个是重试 —— 而它们长得一样正是本批
 *  反复在消除的那种「两个事实塌成一个」。 */
function normaliseCoreSync(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out = {};
  for (const k of Object.keys(stored)) {
    const e = stored[k];
    if (!e || typeof e !== "object") continue;
    out[k] = e.state === "pending"
      ? { ...e, state: "interrupted", text: "登记没能确认结果（上次会话中断）—— 可以重试" }
      : e;
  }
  return out;
}

/** 一条回执落进台账。集中一处，因为它有三个写入时机（开始前、结束后、装载时）。 */
function writeCoreSync(decisionId, entry) {
  reviewsDoc = {
    ...reviewsDoc,
    coreSync: { ...(reviewsDoc.coreSync || {}), [decisionId]: entry },
  };
}

/** 每一镜自己一条串行链（codex round 1, P1）。
 *
 *  通过与撤销通过是**两条不同的命令**（不同 decisionId ⇒ 不同 evaluation_id），
 *  所以网关的按 command_id 幂等救不了顺序：快速「通过 → 撤销」两次 fire-and-forget
 *  并发发出，撤销可能先落、通过后落，核心最终留下的是一个创作者已经收回的
 *  「passed」。按镜头串起来之后，核心看到的顺序就是他按下的顺序。
 *
 *  按镜头而不是全局：不同镜头之间没有顺序关系，串成一条会让 60 镜的批量审片
 *  变成一个个排队。
 *
 *  **键里带项目与文档世代**（codex 轮 3，P1）。只按 `shotId` 串，切到另一个项目
 *  后一个**同名**的镜头会排在上一个项目那次请求的后面 —— 而那次请求没有客户端
 *  超时（本地 CLI 与大存档都需要无限期），一旦后端挂住，新项目的登记就永远发不
 *  出去，界面停在「正在登记」。链条属于一份文档，键就该说出是哪一份。 */
const reviewSyncChains = new Map();

/** 把一次审片结论送进核心项目，并把「送没送到、为什么没送到」记下来。
 *
 *  TASK-103 批次 B。四条纪律：
 *  1. **不阻塞创作者**：画布上的通过已经成立并已存盘，这里失败不回滚它。
 *  2. **不吞掉结果**：每次都往 `reviewsDoc.coreSync` 写一条，界面据此如实显示。
 *     一个只弹 toast 的版本等于三秒后又回到「按下之后不知去了哪」。
 *     **开始之前就写一条 `pending`**（codex round 1, P1）：请求飞在半空时关掉
 *     页面，本地已经有一条通过、核心什么都没收到，而台账里空空如也 —— 那正是
 *     本批要消除的「按下之后不知去了哪」，只是换了个时机。
 *  3. **不假装成功**：`AMBIGUOUS`／被拒／没后端各自是自己的状态（见
 *     `reviewsync.explain`），绝不合并成一句「登记失败」。
 *  4. **不写到别人的画布上**：await 之后先确认装载的还是同一份文档。
 */
function syncReviewToCore(spec, decisionId, shotId) {
  // 只有连上真实项目才有核心可写。演示模式不是错误，是「这里本来就没有核心」。
  const client = CONNECTED
    ? {
        // 目标三元组由后端算 —— 见 `_review_target`。前端拼一个 digest 出来
        // 等于把命令绑在一个不存在的版本上。
        target: (project, shotId2) => query.getReviewTarget(project, shotId2),
        preflight: command.preflight,
        submit: command.submit,
      }
    : null;
  const project = PROJECT_NAME;
  const epoch = canvasEpoch;
  // 先落一条「登记中」，并且**立刻存盘** —— 这条状态存在的意义就是在请求没能
  // 回来时仍然说得出话。
  writeCoreSync(decisionId, { state: "pending", text: "正在登记到核心…", at: new Date().toISOString() });
  ctx.persist();
  refreshProductionView();

  const chainKey = `${project}\u0000${epoch}\u0000${shotId}`;
  const prev = reviewSyncChains.get(chainKey) || Promise.resolve();
  const run = prev.then(async () => {
    // ANY throw must still replace `pending` (codex round 2, P1). `sendThroughGateway`
    // is written not to reject, but 「写得对」 is not a guarantee: an exception from
    // anywhere in here would leave the ledger saying 「正在登记到核心…」 forever, and
    // the card hides 重试登记 on `pending` — so the one state that must never get
    // stuck is exactly the one that would. Fail-closed to a visible, retryable
    // failure rather than to a hopeful one.
    let said;
    try {
      said = reviewsync.explain(await reviewsync.sendThroughGateway(client, project, spec));
    } catch (e) {
      said = { state: "failed", text: `未登记到核心：${(e && e.message) || "登记过程出错"}` };
    }
    // 装载的已经不是同一份文档了 —— 这条回执属于上一份，写进来就是伪造。
    if (project !== PROJECT_NAME || epoch !== canvasEpoch) return said;
    writeCoreSync(decisionId, { state: said.state, text: said.text, at: new Date().toISOString() });
    ctx.persist();
    refreshProductionView();
    if (said.state !== "recorded") toast(said.text);
    return said;
  });
  // 链条不能被一次失败截断（否则这一镜后续的登记全部不再发出）
  const link = run.catch(() => {});
  reviewSyncChains.set(chainKey, link);
  // …而跑完就得清掉（codex 轮 4）。每次装载文档都会造出一批新的世代键，只加不减
  // 会让一整个标签页寿命内的链条与它们捕获的请求状态全部留着。只有当自己仍然是
  // 这一格的当前值时才删 —— 后面排上来的那条不该被上一条顺手清掉。
  link.then(() => {
    if (reviewSyncChains.get(chainKey) === link) reviewSyncChains.delete(chainKey);
  });
  return run;
}

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

// `_clipChain` MOVED to src/controllers/skillctl.js (TASK-073 §1.8 第四批): its
// only caller was the timeline half of the skill context, and it holds that
// controller's rule that a clip's alternatives come from its OWN track's chain.

/** Persist + refresh on a truthy result, and return it. The landing every
 *  controller's write goes through, so 「写成功了但界面没更新」 cannot happen in one
 *  place and not another. */
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
/* -------------------------------------------------------------------------- */
/* URL 即状态 (TASK-081)                                                       */
/* -------------------------------------------------------------------------- */
//
// ONE DIRECTION EACH WAY. `writeUrl` is the only thing that writes the address,
// and it is called from the shell's own post-render report; `honourAddress` is
// the only thing that reads it, and it is the only caller of `applyRoute`. Two
// writers, or a reader that also writes, is how an address bar and an application
// start fighting each other over the back button.

/** True while we are HONOURING the address bar. Everything written during that
 *  window replaces the current history entry instead of pushing a new one —
 *  otherwise going back would push a forward entry and the back button would
 *  never actually go anywhere. */
let routeApplying = false;
/** The module the last write recorded, so 「换页」 (push) and 「同页内换分区 / 换
 *  选中」 (replace) can be told apart. Without this, a section click would bury the
 *  real previous page under a dozen history entries. */
let lastUrlModule = null;
/** WHERE THE APPLICATION ACTUALLY IS, as a route.
 *
 *  Kept so an incoming address can be compared against it. One back-press fires
 *  BOTH `popstate` and `hashchange`, and re-applying the same route on the second
 *  event would repaint and re-ask the unsaved-edit question the creator has just
 *  answered — worse, after they DECLINE and the address is restored, the second
 *  event would apply the restored route as if it were a new navigation. */
let currentRoute = null;

function writeUrl() {
  if (!canvasActive || !production.isVisible()) return;
  const r = production.route();
  const url = formatRoute({ project: PROJECT_NAME, ...r });
  // remembered per browser, never in canvas.json — 「上次在哪一页」 is not创作数据
  saveLastRoute(window.localStorage, PROJECT_NAME, r);
  // RECORDED BEFORE THE EARLY RETURN. An address that is already canonical is
  // still where we are, and `lastUrlModule` is still the module we are on — not
  // updating them made the NEXT same-page change look like a page change and push
  // a history entry, adding a Back stop that goes nowhere (independent review,
  // round 1, non-blocking).
  currentRoute = { project: PROJECT_NAME, ...r };
  const pageMoved = r.module !== lastUrlModule;
  lastUrlModule = r.module;
  if (url === window.location.hash) return;
  try {
    if (routeApplying || !pageMoved) window.history.replaceState({}, "", url);
    else window.history.pushState({}, "", url);
  } catch {
    // a `file://` page refuses pushState. The studio must still work there —
    // it simply loses deep links, which is exactly what it had before this card.
  }
}

/** Put the address back where the application really is. Used when the creator
 *  declines to leave: the browser has ALREADY moved, so leaving the URL alone
 *  would leave it describing a page that is not on screen. */
function restoreUrl() {
  const r = production.route();
  // the restored address IS where the application is — recorded, so the duplicate
  // event that follows one back-press recognises it and does nothing
  currentRoute = { project: PROJECT_NAME, ...r };
  lastUrlModule = r.module;
  try {
    window.history.pushState({}, "", formatRoute({ project: PROJECT_NAME, ...r }));
  } catch { /* see writeUrl */ }
}

/** Drop the address entirely — the landing page is not a place inside a project. */
function clearUrl() {
  lastUrlModule = null;
  currentRoute = null;
  try {
    window.history.pushState({}, "", window.location.pathname + window.location.search);
  } catch { /* see writeUrl */ }
}

/** Say WHY an address could not be opened, on the landing page itself. Set
 *  directly rather than through `renderLanding`, which only runs at boot and
 *  after project creation — and a redraw learns nothing new about this address. */
function landingNote(msg) {
  const note = $("#landing-note");
  if (!note) return;
  note.textContent = msg;
  note.classList.add("bad");
}

/** The address this function last ACTED on.
 *
 *  The de-duplication of 「one press, two events」 used to be the `routeApplying`
 *  early return, which also discarded a genuine second press (TASK-087 §5.6).
 *  Now that the latch re-runs instead of discarding, the duplicate has to be
 *  recognised by what it IS — the same address again — rather than by when it
 *  arrived. Keyed on the raw hash, so it holds even on the paths that return
 *  before `writeUrl()` updates `currentRoute` (a declined unsaved-edit prompt,
 *  an address naming a project this backend does not list). */
let lastHonouredHash = null;

/**
 * Go where the address bar says.
 *
 * Bound to BOTH `popstate` and `hashchange`: the first fires for our own
 * push/replace history entries, the second for an address typed or pasted into
 * the bar, and a back-press between two hash-differing entries fires both.
 * `lastHonouredHash` is what keeps that double event from being applied twice —
 * and, much more importantly, from asking the unsaved-edit question twice for one
 * press. A genuine second press carries a DIFFERENT address, so it survives.
 */
async function honourAddress(atHash) {
  // The address AS IT WAS WHEN THE EVENT FIRED, not as it is now (codex 轮 1, P1):
  // a navigation that already finished has rewritten `window.location.hash` back
  // to where IT went, so a re-run reading it live would go nowhere.
  const hash = typeof atHash === "string" ? atHash : window.location.hash;
  const want = parseRoute(hash);
  // THE SECOND EVENT OF ONE PRESS DOES NOTHING. `popstate` and `hashchange` both
  // fire for a back-press between two hash-differing entries, and applying the
  // route twice would repaint and re-ask the unsaved-edit question — and after a
  // DECLINE, `restoreUrl` has already put the address back, so the second event
  // would read the restored address and apply it as a fresh navigation.
  if (currentRoute && sameRoute(want, currentRoute)) return;
  // the SECOND event of ONE press: same address, already handled
  if (hash === lastHonouredHash) return;
  lastHonouredHash = hash;
  if (!want.ok || !want.project) {
    // The address names nowhere. That IS the landing page — but it still goes
    // through the unsaved-edit guard, because the back button reaching this state
    // would otherwise discard a shot's edits with no question asked.
    if (production.isVisible()) {
      if (production.hasUnsavedShotEdit()
        && !window.confirm("镜头详情有未保存的修改，离开将丢弃？")) { restoreUrl(); return; }
      production.discardShotEdit();
      production.hide();
    }
    views.goHome();
    return;
  }
  routeApplying = true;
  try {
    if (want.project !== PROJECT_NAME || !canvasActive) {
      // §1.2 第 3 条: never open a half-initialised workbench for a project the
      // backend never listed. Say so on the landing page instead.
      if (CONNECTED && !LIST_ERROR && REAL_NAMES.length && !REAL_NAMES.includes(want.project)) {
        production.hide();
        views.goHome();
        landingNote(
          `地址里的项目「${want.project}」不在这个后端的项目列表里`
          + `——这不是「打不开」，是这个后端没有这个项目。`,
        );
        return;
      }
      await enterCanvas(want.project, {});
    } else {
      // THE VIEW MUST FOLLOW THE ADDRESS, not only the shell's module.
      //
      // 「返回项目列表」 hides `#canvas` but leaves the project LOADED, so pressing
      // Back to an address inside it skipped `enterCanvas` entirely, re-rendered
      // the studio into a hidden container and left the creator looking at the
      // landing page with a URL that claimed otherwise — stranded (independent
      // review, round 2). Showing the canvas here is the router doing its one
      // job: make what is on screen match what the address says.
      views.goCanvas();
    }
    // §1.2 第 2 条: an address this build does not understand lands somewhere real
    // and SAYS SO. It is never swallowed.
    if (want.reason) toast(want.reason);
    if (want.module && !production.applyRoute(want)) { restoreUrl(); return; }
  } finally {
    routeApplying = false;
  }
  // normalise the address (derived space segment, dropped section) WITHOUT
  // adding an entry — `lastUrlModule` is already current, so this replaces
  writeUrl();
}

// COALESCED, NOT DROPPED (TASK-103 批次 D / TASK-087 §5.6).
//
// `routeApplying` used to `return` on a second event, which is right for the two
// events of ONE press (popstate + hashchange both fire for a hash-differing
// back-press) but wrong for a SECOND press arriving while the first navigation is
// still loading a project: that press was silently discarded. The address bar sat
// at the second position, the screen at the first, and the trailing `writeUrl()`
// then rewrote the address back to where the app actually was — consistent, and
// yet the creator's press did nothing and nothing said so.
//
// The latch re-runs once after the in-flight navigation finishes, WITH the address
// captured when the event fired. Reading the address live in the re-run does not
// work: the finished navigation calls `writeUrl()`, which normalises the bar back
// to where it went, so the re-run would read that and short-circuit — the last
// press lost again, just later (codex 轮 1, P1). `honourAddress`'s own
// `lastHonouredHash` / `sameRoute` checks still make the duplicate event of a
// single press a no-op.
const routeLatch = createRouteLatch(honourAddress);
window.addEventListener("popstate", () => { routeLatch.trigger(window.location.hash); });
window.addEventListener("hashchange", () => { routeLatch.trigger(window.location.hash); });

function goProduction() { setTopMode("story"); }
function goWorkflow() { setTopMode("episode"); }
$("#seg-story").onclick = () => setTopMode("story");
$("#seg-episode").onclick = () => setTopMode("episode");
$("#seg-assets").onclick = () => setTopMode("assets");
const wfExit = $("#wf-tab-exit");
if (wfExit) wfExit.onclick = () => setTopMode("episode");
const wfCanvasTab = $("#wf-tab-canvas");
if (wfCanvasTab) wfCanvasTab.onclick = () => showDiagnosticCanvas(true);
$("#proj-switch").onclick = () => { views.goHome(); clearUrl(); };

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
    // 批量付费的状态（v18 / 批次 4D）。**必须落盘**：一个已确认的批次带着报价、
    // 已花多少与「迟到回执还没收齐」；刷新一次全没了，创作者会再确认一次 ——
    // 对付费批量那是第二次真实扣费，而且没有任何一处说过第一次发生过。
    // **别的 kind 不被吃掉**（codex round 4）：4E 会加「批量生视频」那一种，而
    // 打开-保存一次就把它删掉，正是 AGENTS.md 第 13 条禁止的静默覆盖。
    // 内存里的那一种覆盖同名项，其余原样带过去。
    batches: {
      ...loadedBatches,
      ...(promptBatchState ? { [promptBatchState.kind]: promptBatchState } : {}),
      ...(videoBatchState ? { [videoBatchState.kind]: videoBatchState } : {}),
    },
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
    reviews: {
      issues: [...reviewsDoc.issues],
      decisions: [...reviewsDoc.decisions],
      coreSync: { ...(reviewsDoc.coreSync || {}) },
    },
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
  // 从模板起步的项目：**第一次**打开（还没有画布）时把模板的骨架应用上去。
  // 不做这一步，从模板起步的项目和空项目一模一样 ——「选模板」就是个点了没反应
  // 的控件（codex 审查轮 3 的 blocking）。
  //
  // 条件卡在「没有已保存的画布」上，而不是「有没有模板」：模板永远不覆盖创作者
  // 已经写下的东西（第 13 条）。
  if (!data && PENDING_FLOW) {
    proddoc.applyFlowSeed(productionDoc, PENDING_FLOW);
    PENDING_FLOW = null;
  }
  // Per-episode timelines (M11).
  timelinesDoc = timeline.createTimelines((data && data.timelines) || null);
  // 批量付费的状态（v18 / 批次 4D）：**水合回来**，否则刷新之后创作者看到一个
  // 从没跑过的干净界面，然后再确认一次。一种批量只有一个，取那一个。
  // **一个 kind 只有一个主人。**
  //
  // `loadedBatches` 保存「这一层不管的那些批量」，所以水合时就把自己那一种**摘掉**。
  // 不摘的后果 codex round 5 指出来了：`discard()` 把内存里那一批清成 null，而序列化
  // 仍然从 `loadedBatches` 把它写回去 —— 刷新之后那个已经被放弃的、已报价的批次
  // 原地复活，然后可以被确认。放弃一件事之后它自己回来，是最坏的一种不可逆。
  const savedBatches = (data && data.batches && typeof data.batches === "object" && !Array.isArray(data.batches))
    ? { ...data.batches }
    : {};
  promptBatchState = promptbatch.hydrateBatch(savedBatches, "prompt-compose");
  videoBatchState = promptbatch.hydrateBatch(savedBatches, videobatch.VIDEO_BATCH_KIND);
  // 自己拥有的**每一种**都摘掉 —— 留下任何一种，`discard` 清了内存之后序列化
  // 又会把它写回去，那个已经被放弃的批次就原地复活（4D 轮 5 的 P1）。
  for (const kind of OWNED_BATCH_KINDS) delete savedBatches[kind];
  loadedBatches = savedBatches;
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
    // TASK-074 §1.3: a stored layer-2 issue with no `locatedShotId` is MARKED, never
    // dropped and never repaired by guessing a shot. `issue()` refuses to create one,
    // but the restore path used to take stored issues verbatim, so any that got in
    // another way made layer 2 quietly stop being 「必须定位到具体镜头」.
    issues: review.relocateLegacyIssues(rv && rv.issues),
    decisions: rv && Array.isArray(rv.decisions) ? [...rv.decisions] : [],
    // 旧存档没有这张台账 —— 空表读作「还没问过核心」，不是「核心拒绝过」。
    // 从磁盘读回来的 `pending` **不是**「正在登记」：那次登记随页面一起结束了，
    // 结果没人知道。如实改写成 `interrupted`，界面据此给出重试（codex round 1, P1）。
    coreSync: normaliseCoreSync(rv && rv.coreSync),
  };
  // a DIFFERENT document is loaded now — any sync still in flight belongs to the
  // previous one and must not write into this canvas
  canvasEpoch++;
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
  promptBatchState = null; // 换项目：上一个项目的批次不跟过来
  videoBatchState = null;
  loadedBatches = {};
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
  reviewsDoc = { issues: [], decisions: [], coreSync: {} };
  canvasEpoch++; // same reason as the load path
  // …and the project-health cache, for the same reason every document above is
  // cleared here: it describes the project being left.
  HEALTH = { ...HEALTH_EMPTY };
  HEALTH_GEN += 1; // any read still in flight is for the project being left
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
  useShotMirror(ctx.project);
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
    // 只在**确实还没有画布**时去取模板（`empty`，不是「读失败」）。读失败时
    // 存档还在、自动保存已停，往上套模板会把一次读错变成一次改写。
    PENDING_FLOW = null;
    if (CONNECTED && res.status === "empty") {
      // **默认是「不确定」，不确定就不许保存。**
      //
      // 前四轮审查各报出这个洞的一种拼法：请求失败 → 只 toast 不停保存 →
      // `{}` 是真值 → `false`/`0`/`""` 是假值绕过了「形状不对」那一支。
      // 每一次我都在补一个新的失败拼法，而拼法是补不完的（ADR-0081 §2b 记的
      // 正是这种病）。所以这一版**把默认反过来**：先停用，只有两种**确凿**的
      // 结果才解除 ——
      //
      //   1. 后端明确说「这个项目没用模板」（`flow === null`）；
      //   2. 拿到了一份 `isUsableFlow` 认可的模板。
      //
      // 其余一切 —— 请求失败、`{}`、`false`、`0`、`""`、缺 `createdFrom`、
      // 将来某种还没见过的形状 —— 统统落进 else，**不需要被枚举**。
      const PENDING = "flow_pending";
      persist.blockSaves(name, PENDING, "还没确定这个项目是不是从模板起步的");
      const got = await query.projectFlow(name);
      // **await 之后世界可能已经变了**（codex 审查轮 9）：创作者可以在这一问
      // 还没回来的时候就切到另一个项目。`PENDING_FLOW` 是模块级的，所以晚回来
      // 的那一份答复会把 A 的模板套到 B 的画布上。
      //
      // 与 `promptBatch._quote` 里那条钉子是同一个形状、同一个修法：把「问的时候
      // 是哪个项目」记下来，回来不是同一个就**只留下那次停用**（那是给 A 的，
      // A 的画布也确实还没确定），什么都不套、什么都不解除。
      if (PROJECT_NAME !== name) return;
      const flow = got.ok && got.data ? got.data.flow : undefined;
      if (got.ok && flow === null) {
        persist.unblockSaves(name, PENDING);            // 确凿：没用模板
      } else if (proddoc.isUsableFlow(flow)) {
        PENDING_FLOW = flow;
        persist.unblockSaves(name, PENDING);            // 确凿：拿到了
      } else {
        const detail = got.ok
          ? "studio/flow.json 形状不对"
          : (got.error && got.error.detail) || "请求失败";
        persist.blockSaves(name, "flow_unreadable", detail);
        toast(
          `读不到这个项目的流程模板（${detail}）——已停用自动保存以免把空白画布` +
          "存成这个项目的开局；刷新可以重试",
        );
      }
    }
    if (!restoreGraph(doc)) { engine.reset(); seeded = false; engine.render(); }
    if (PENDING_FLOW) {
      // restoreGraph 在 doc 为 null 时会走它自己的早退路径，不一定进到应用点；
      // 兜一次，并且**只在还是全新文档时**兜（applyFlowSeed 自己也会再判一次）。
      proddoc.applyFlowSeed(productionDoc, PENDING_FLOW);
      PENDING_FLOW = null;
      refreshProductionView();
    }
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
  else {
    goProduction();
    // TASK-081 §1.3 — and it is applied AFTER the default landing, not instead of
    // it: `applyRoute` can refuse (an unsaved edit, a page that no longer exists),
    // and refusing must leave the creator somewhere real rather than nowhere.
    if (opts.route && opts.route.module) production.applyRoute(opts.route);
  }
}

// --- global bits ---
const views = createViews({ onHome: clearUrl });

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

/**
 * project name → `{ model }` for the landing card (TASK-082 §1.3).
 *
 * Filled by `loadProjectCards`, read by `renderLanding`. A name that is absent
 * has NOT been read yet, which is a different state from 「read and empty」 — the
 * card shows no numbers at all for it rather than zeros.
 */
const CARD_INFO = new Map();

/**
 * Read each project's canvas once and derive its card.
 *
 * WHY IT IS SAFE TO READ THEM ALL. `loadCanvas` is the same read the studio does
 * on entry and writes nothing; a project whose document is corrupt or too new
 * comes back with a status and is recorded as unreadable rather than throwing the
 * landing page away. The demo is skipped: it is re-seeded from scratch on every
 * entry, so any cover or count derived from a previous seed is about a project
 * that no longer exists.
 *
 * The cover is then PROBED before it is shown — a registered image whose bytes
 * are gone must not become the face of the project (§1.3 「封面不是碎图」).
 */
async function loadProjectCards(names) {
  const wanted = (Array.isArray(names) ? names : []).filter((n) => n && n !== DEMO_PROJECT_NAME);
  if (!wanted.length) return;
  const covers = [];
  for (const name of wanted) {
    try {
      const res = await persist.loadCanvas(name);
      const model = projectCardModel(res.status === "ok" ? res.doc : null);
      CARD_INFO.set(name, { model });
      covers.push(...model.coverCandidates);
    } catch {
      // an unreadable project is a FACT about it, recorded — never a reason to
      // leave the whole landing page half-drawn
      CARD_INFO.set(name, { model: projectCardModel(null) });
    }
  }
  renderLanding(REAL_NAMES);
  if (covers.length) {
    try {
      if (await mediaProbe.scan(covers)) renderLanding(REAL_NAMES);
    } catch { /* a probe that cannot run leaves the <img> as the last word */ }
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
    // TASK-082 §1.3 — the card finally says something about the FILM. `CARD_INFO`
    // is filled in by `loadProjectCards` after each canvas is read; until then the
    // card is exactly what it was, and a project whose canvas cannot be read stays
    // that way rather than printing zeros.
    const info = CARD_INFO.get(c.name) || null;
    const stats = info ? cardStats(info.model) : null;
    const cover = info ? pickCover(info.model.coverCandidates, (u) => mediaProbe.isMissing(u)) : null;
    b.innerHTML =
      renderCover(cover, landingThumb(c.kind, c.name)) +
      `<div class="cap"><div class="nm">${esc(c.name)}</div>` +
      `<div class="rw"><span class="chip${c.kind === "real" ? " ok" : c.kind === "demo" ? " gate" : ""}">${esc(tag)}</span>` +
      (stats ? `<span class="pstat">${esc(stats)}</span>` : "") +
      (info && !info.model.readable ? `<span class="chip bad">画布读不出来</span>` : "") +
      `</div>` +
      (c.openedAt ? `<div class="pt">上次打开 ${esc(String(c.openedAt).slice(0, 16).replace("T", " "))}</div>` : "") +
      `<div class="pt" title="${esc(where)}">${esc(where)}</div></div>`;
    b.onclick = () => {
      if (c.kind !== "demo") projects.touchProject(window.localStorage, c.name, new Date().toISOString());
      // TASK-081 §1.3: back to where they LEFT OFF, not to a fixed first page.
      // The demo is excluded on purpose — it is re-seeded from scratch on every
      // entry, so a remembered shot id from a previous seed points at nothing.
      enterCanvas(c.name, {
        ...(c.kind === "demo" ? { seedDemo: true } : {}),
        route: c.kind === "demo" ? null : loadLastRoute(window.localStorage, c.name),
      });
    };
    // A COVER THAT FAILS AT PAINT TIME IS RECORDED AND REPLACED. The probe's
    // `HEAD` can be declined by a server that still serves `GET`, so the `<img>`
    // is the last word — and when it says the bytes are unfetchable, the next
    // candidate takes over instead of a broken glyph becoming the project's face.
    const img = b.querySelector("[data-pcard-cover]");
    if (img) {
      img.onerror = () => {
        if (mediaProbe.observe(img.dataset.mediaUrl, false)) renderLanding(realNames);
      };
    }
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

/** 把可用的流程模板装进选择框。**不可用的那些也说出来**，带原因。
 *
 *  失败不挡创建：模板是可选的，取不到列表就等于「这次不用模板」，
 *  而不是「新建项目坏了」。但要**说出来**——静默的空列表看起来像「没有模板」，
 *  那是另一件事（ADR-0067 决策 7 的同一条理由：装了却没生效必须可见）。 */
async function npLoadFlows() {
  const sel = $("#np-flow");
  const note = $("#np-flow-note");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "不用模板（空项目）";
  sel.appendChild(none);
  note.textContent = "";
  if (!CONNECTED) {
    sel.disabled = true;
    note.textContent = "演示模式没有后端，读不到流程模板。";
    return;
  }
  sel.disabled = false;
  const res = await query.listFlows();
  if (!res.ok) {
    note.textContent = `读不到流程模板（${(res.error && res.error.detail) || "请求失败"}）——这次可以先不用模板。`;
    return;
  }
  const flows = (res.data && res.data.flows) || [];
  for (const f of flows) {
    if (f.deprecated) continue;
    const opt = document.createElement("option");
    opt.value = f.flowId;
    opt.textContent = `${f.title}（${f.steps.length} 步 · v${f.flowVersion}）`;
    opt.title = f.purpose;
    sel.appendChild(opt);
  }
  const problems = (res.data && res.data.problems) || [];
  if (problems.length) {
    note.textContent = `${problems.length} 份模板加载不了：${problems
      .map((p) => `${p.flowId || p.path}——${p.detail}`)
      .join("；")}`;
  } else if (!flows.length) {
    note.textContent = "还没有可用的流程模板。";
  }
}

async function npOpen() {
  npName.value = "";
  npRoot = await defaultAssetRoot();
  npNote.textContent = CONNECTED
    ? "项目文件夹会由后端创建在这个位置。第一次使用一个新位置时会要求你确认一次。"
    : "演示模式没有后端，也就没有文件系统：这里不会建任何文件夹。要真正把项目建到磁盘上，用连接模式启动（./scripts/launch/studio.ps1 -Connected）。";
  const pick = $("#np-pick");
  pick.disabled = !CONNECTED;
  pick.title = CONNECTED ? "" : "目录选择需要连接模式（后端）";
  npRefresh();
  npScrim.classList.add("show");
  npName.focus();
  // await 放在最后：读模板不该拖慢对话框出现，也不该在它失败时挡住输入
  await npLoadFlows();
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
    const flowId = ($("#np-flow") && $("#np-flow").value) || "";
    let res = await query.createProject(v.name, npRoot, false, flowId);
    if (res.status === 409 && res.error && res.error.category === "root_unconfirmed") {
      if (!window.confirm(`${res.error.detail}\n\n确认使用这个位置？`)) return;
      res = await query.createProject(v.name, npRoot, true, flowId);
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
  // TASK-082 §1.3 — covers and counts arrive after the cards are already on
  // screen, so a slow or unreadable canvas never delays the project list.
  loadProjectCards(CONNECTED ? REAL_NAMES : projects.loadRegistry(window.localStorage).map((p) => p.name));
  // TASK-081 验收 #1 / #2 — a deep link is honoured on FIRST LOAD, which is the
  // whole point: a refresh and a pasted address are the same event to a browser,
  // and both used to land on the project list. Done last, so the landing page is
  // already drawn underneath if the address turns out to name nothing.
  if (parseRoute(window.location.hash).ok) await honourAddress();
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
