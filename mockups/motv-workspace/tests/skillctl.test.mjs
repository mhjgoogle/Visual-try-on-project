// TASK-073 §1.8 第四批 — `skillctl.js`（app.js 里最大的一块，853 行）搬出后的
// 第一批真测试。
//
// 和前几批同样的道理（§5.9）：**可构造性本身就是搬迁的验证手段**。这个控制器在
// app.js 里从来没有过任何测试——没有任何东西 import 得了 app.js。
//
// 第一条测的仍然是 **getter 注入**，因为那是这批搬迁唯一会静默出错的地方。这一个
// 控制器 0 处写入，所以它错的方向和前几个相反：不是「写进上一个项目」，而是
// **读到上一个项目**，于是把一份 prompt 从未携带过的 context 记进运行记录——
// 一条伪造的溯源，长得和真的一模一样。

import test from "node:test";
import assert from "node:assert/strict";

import { createSkillController } from "../src/controllers/skillctl.js";
import * as skills from "../src/workflow/skills.js";
import * as runtime from "../src/services/runtime.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as skillapply from "../src/workflow/skillapply.js";
import * as shotctx from "../src/workflow/shotctx.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as storydoc from "../src/workflow/storydoc.js";
import * as scriptdoc from "../src/workflow/scriptdoc.js";
import * as assetreg from "../src/workflow/assetreg.js";
import * as refinterp from "../src/workflow/refinterp.js";
import * as timeline from "../src/workflow/timeline.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as mediaref from "../src/workflow/mediaref.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

installBuiltinCatalog(skills);

const emptyRegistry = () => ({ images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} });

/** A production doc with one episode, one scene, one shot — enough for every
 *  episode-level and shot-level scope question below. */
function makeProduction(episodeId = "ep-1") {
  return {
    activeEpisodeId: episodeId,
    characters: [],
    relationships: [],
    world: {},
    locations: [],
    episodes: [
      {
        episodeId,
        title: `${episodeId} 标题`,
        scenes: [{ sceneId: "sc-1", title: "第一场", shotIds: ["shot-1"] }],
      },
    ],
  };
}

/** A controller over documents the test can SWAP wholesale — which is what
 *  loading another project does to the module-level `let`s in app.js. */
function makeCtl(over = {}) {
  const state = {
    runs: over.runs || [],
    production: over.production || makeProduction(),
    story: over.story || storydoc.createStory(null),
    script: over.script || scriptdoc.createDoc(null),
    registry: over.registry || emptyRegistry(),
    refInterp: over.refInterp || {},
    timelines: over.timelines || {},
    shotAudio: over.shotAudio || {},
    subtitles: over.subtitles || {},
    generations: over.generations || [],
    catalogDetail: over.catalogDetail !== undefined ? over.catalogDetail : "能力目录尚未加载",
    catalogProblems: over.catalogProblems || [],
    shots: over.shots || [],
    calls: { persist: 0, refresh: 0, dispatched: [], cancelled: [] },
  };
  const ctl = createSkillController({
    docs: {
      runs: () => state.runs,
      production: () => state.production,
      story: () => state.story,
      script: () => state.script,
      registry: () => state.registry,
      refInterp: () => state.refInterp,
      timelines: () => state.timelines,
      shotAudio: () => state.shotAudio,
      subtitles: () => state.subtitles,
      generations: () => state.generations,
    },
    catalog: { detail: () => state.catalogDetail, problems: () => state.catalogProblems },
    modules: {
      skills,
      runtime: over.runtime || runtime,
      skillrun,
      skillapply,
      shotctx,
      proddoc,
      storydoc,
      scriptdoc,
      assetreg,
      refinterp,
      timeline,
      subtitle,
      mediaref,
    },
    findShot: (shotId) => state.shots.find((s) => s.shotId === shotId) || null,
    slotOf: (shot) => (shot ? shot.slot || null : null),
    isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => ({}) },
    shotCtx: { build: () => ({ context: null }), candidates: () => ({ candidates: [] }) },
    draftShots: () => state.shots,
    dispatchAction: over.dispatchAction
      || ((act) => { state.calls.dispatched.push(act.action); return { ok: true }; }),
    persist: () => { state.calls.persist += 1; },
    refresh: () => { state.calls.refresh += 1; },
    now: () => "2026-08-15T00:00:00.000Z",
  });
  return { ctl, state };
}

/** Land a run in `proposed` without going through a runtime. */
function seedProposedRun(state, { skillId = "editing-director", proposal = null, context = null } = {}) {
  const rec = skillrun.startRun(state.runs, {
    skillId,
    skillVersion: 1,
    runtime: "manual",
    executor: "manual",
    inputKeys: ["timeline"],
    context,
    createdAt: "2026-08-15T00:00:00.000Z",
  });
  skillrun.proposeRun(state.runs, rec.skillRunId, proposal || { edits: [] }, {
    model: null,
    at: "2026-08-15T00:00:00.000Z",
  });
  return rec;
}

/** A backend-owned run — `runId` is minted FROM `skillRunId` (skillrun.startRun),
 *  and a `run-…` prefix is the knowable difference between a run the backend owns
 *  and one this page owns. */
function seedBackendRun(state) {
  return skillrun.startRun(state.runs, {
    skillRunId: "run-abc",
    skillId: "editing-director",
    skillVersion: 1,
    runtime: "local_subscription",
    executor: "claude",
    createdAt: "2026-08-15T00:00:00.000Z",
  });
}

// --- 1. getter 注入 —— 这批搬迁唯一会静默出错的地方 ------------------------ //

test("documents are read through GETTERS — a loaded project must not be read stale", () => {
  const { ctl, state } = makeCtl();
  assert.deepEqual(ctl.runs(), [], "empty project reads empty");
  assert.equal(ctl.scopeOf("editing-director").episodeId, "ep-1");

  // simulate a project load: app.js reassigns the module-level `let`s wholesale
  state.production = makeProduction("ep-99");
  state.runs = [];
  seedProposedRun(state);

  assert.equal(
    ctl.scopeOf("editing-director").episodeId,
    "ep-99",
    "a controller that captured the production doc's VALUE would record the PREVIOUS "
    + "project's episode — a context the prompt never read, i.e. a fabricated provenance",
  );
  assert.equal(ctl.runs().length, 1, "the run registry follows the project too");
  assert.equal(ctl.stats("editing-director").total, 1);
});

test("the catalog's DETAIL is a getter too — it is only assigned at boot", () => {
  const { ctl, state } = makeCtl();
  assert.equal(ctl.catalogState().detail, "能力目录尚未加载");

  // installCatalog() runs after the controller is built; app.js reassigns the
  // module-level `let`. A captured value would leave the panel reporting
  // 「尚未加载」 forever, next to a catalog that is in fact loaded.
  state.catalogDetail = "";
  state.catalogProblems = [{ source: "project", detail: "manifest 缺少 skillId" }];
  assert.equal(ctl.catalogState().detail, "");
  assert.deepEqual(ctl.catalogState().problems, [
    { source: "project", detail: "manifest 缺少 skillId" },
  ]);
  assert.equal(ctl.catalogState().installed, true);
});

test("a run's registry is re-read AFTER the await, never hoisted (§5.14)", async () => {
  // PRE-EXISTING SEMANTICS, pinned deliberately. In app.js `skillRunRegistry` was a
  // bare identifier resolved at EVERY use, so a failure arriving after a project
  // switch was looked up in the NEW registry and therefore landed nowhere — the
  // abandoned project's record stayed `running`. Hoisting `docs.runs()` to a const
  // would settle the ABANDONED project's record instead, which is a different
  // program. This test is what tells the two apart.
  //
  // That the honest fix is to REFUSE a cross-project landing is recorded as a
  // follow-up in TASK-073 §5.14; §1.8 is a move round, so behaviour is preserved.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctl, state } = makeCtl({
    runtime: {
      ...runtime,
      EXECUTOR_BY_ID: new Map([["fake", { id: "fake", runtime: "local_subscription" }]]),
      runOnExecutor: async () => {
        await gate;
        return { ok: false, kind: "timeout", detail: "执行器超时" };
      },
    },
    timelines: {},
  });
  const abandoned = state.runs;
  const pending = ctl.run("editing-director", { executor: "fake" });
  assert.equal(abandoned.length, 1, "the run was recorded in the registry current at launch");

  state.runs = []; // a project loads while the executor is still working
  release();
  const res = await pending;

  assert.equal(res.ok, false);
  assert.equal(abandoned[0].status, "running", "the abandoned project's record is NOT settled");
  assert.equal(state.runs.length, 0, "nor is anything written into the new project");
});

// --- 2. 记录的 scope 必须是 prompt 真的读过的那一份 (ADR-0059) -------------- //

test("the caller cannot re-point the episode a run recorded", () => {
  const { ctl } = makeCtl();
  const scope = ctl.scopeOf("editing-director", { episodeId: "ep-somewhere-else" });
  assert.equal(scope.episodeId, "ep-1", "the ACTIVE episode is what the context builder read");
});

test("a scene and a shot are validated TOGETHER, not one at a time", () => {
  const { ctl, state } = makeCtl();
  state.production.episodes[0].scenes.push({ sceneId: "sc-2", title: "第二场", shotIds: ["shot-9"] });
  // sc-1 is real, shot-9 is real — but shot-9 does not live in sc-1
  const scope = ctl.scopeOf("script-breakdown", { sceneId: "sc-1", shotId: "shot-9" });
  assert.equal(scope.sceneId, null);
  assert.equal(scope.shotId, null);
  assert.equal(scope.episodeId, "ep-1", "the episode it really read still stands");
});

test("a skill that reads no episode-level input records no episode", () => {
  const { ctl } = makeCtl();
  // story-development reads brief/outline only — it never looked at an episode
  assert.equal(ctl.scopeOf("story-development"), null);
});

// --- 3. 一个片段的可换版本来自它 **自己那条轨** 的链 (TASK-072 §1.9 缺陷 7) -- //

test("a clip's alternatives come from its OWN track's chain, never the image chain", () => {
  const { ctl, state } = makeCtl();
  state.shots = [{ shotId: "shot-1", slot: "s1", sequence: 1, title: "开场" }];

  // the SAME slot key exists in images (first frames) and in audio (dialogue).
  // `_clipChain` used to search images first, so a dialogue clip was offered the
  // first-frame IMAGE versions and every proposal it produced failed domain
  // validation at apply time.
  state.registry.images = { s1: { current: 2, history: [
    { version: 1, assetId: "asset-img-1" },
    { version: 2, assetId: "asset-img-2" },
  ] } };
  state.registry.audio = { "voice-s1": { current: 1, history: [
    { version: 1, assetId: "asset-voice-1" },
    { version: 2, assetId: "asset-voice-2" },
  ] } };
  const t = timeline.timelineFor(state.timelines, "ep-1");
  t.clips.push({
    clipId: "clip-1", trackType: "dialogue", shotId: "shot-1",
    assetId: "asset-voice-1", assetVersion: 1,
    startTime: 0, trimIn: 0, trimOut: 2, volume: 1, muted: false,
  });

  const ctxOut = ctl.context("editing-director");
  const clip = ctxOut.timeline.clips.find((c) => c.clipId === "clip-1");
  assert.deepEqual(
    clip.alternatives.map((a) => a.assetId),
    ["asset-voice-2"],
    "a dialogue clip may only be offered OTHER TAKES OF ITS OWN AUDIO CHAIN",
  );
});

test("ambience / bgm honestly offer nothing — they are not per-shot chains", () => {
  const { ctl, state } = makeCtl();
  state.shots = [{ shotId: "shot-1", slot: "s1", sequence: 1 }];
  const t = timeline.timelineFor(state.timelines, "ep-1");
  t.clips.push({
    clipId: "clip-bgm", trackType: "bgm", shotId: "shot-1", assetId: "asset-bgm",
    startTime: 0, trimIn: 0, trimOut: 5, volume: 1, muted: false,
  });
  const clip = ctl.context("editing-director").timeline.clips.find((c) => c.clipId === "clip-bgm");
  assert.deepEqual(clip.alternatives, []);
});

// --- 4. 「用于生成」 是一次显式声明，不是推断出来的 (ADR-0061 决策 3) ------- //

test("no explicit 「用于生成」 → no origin, ever", () => {
  const { ctl, state } = makeCtl();
  seedProposedRun(state);
  assert.equal(ctl.pendingOriginFor("shot-1"), null, "a proposal nobody pressed the button on");
});

test("the pending origin is bound to the run's OWN recorded shot", () => {
  const { ctl, state } = makeCtl();
  const rec = seedProposedRun(state, { context: { episodeId: "ep-1", sceneId: "sc-1", shotId: "shot-1" } });
  const used = ctl.useForGeneration(rec.skillRunId);
  assert.equal(used.ok, true);

  assert.deepEqual(ctl.pendingOriginFor("shot-1"), {
    skillRunId: rec.skillRunId,
    proposalId: skillrun.proposalIdOf(skillrun.findRun(state.runs, rec.skillRunId)),
  });
  assert.equal(
    ctl.pendingOriginFor("shot-7"), null,
    "a proposal accepted for shot-1 must not stamp a generation launched for shot-7",
  );
});

test("an origin describes ONE launch — a generation that carries it consumes it", () => {
  const { ctl, state } = makeCtl();
  const rec = seedProposedRun(state, { context: { episodeId: "ep-1", sceneId: null, shotId: "shot-1" } });
  ctl.useForGeneration(rec.skillRunId);
  assert.notEqual(ctl.pendingOriginFor("shot-1"), null);

  // …and the claim is looked up through the GETTER: a generation registry replaced
  // by a project load is the one that answers
  state.generations = [{ generationId: "gen-1", origin: { skillRunId: rec.skillRunId, proposalId: "p" } }];
  assert.equal(ctl.pendingOriginFor("shot-1"), null, "consumed");
});

test("originOf refuses a run that is not accepted", () => {
  const { ctl, state } = makeCtl();
  const rec = seedProposedRun(state);
  assert.equal(ctl.originOf(rec.skillRunId), null, "proposed is not accepted");
  ctl.accept(rec.skillRunId);
  assert.notEqual(ctl.originOf(rec.skillRunId), null);
});

// --- 5. 应用提案：部分成功仍留在 proposed，可以再按一次 -------------------- //

test("a PARTIAL apply leaves the run proposed so the rest can be retried", () => {
  const { ctl, state } = makeCtl({
    dispatchAction: (act) => (act.action === "removeTimelineClip"
      ? { ok: false, error: "目标片段不存在" }
      : { ok: true }),
  });
  const rec = seedProposedRun(state, {
    proposal: {
      edits: [
        { clipId: "clip-1", trimInMs: 0, trimOutMs: 1000, reason: "掐头" },
        { clipId: "clip-2", remove: true, reason: "这一条多余" },
      ],
    },
  });
  const res = ctl.applyProposal(rec.skillRunId);
  assert.equal(res.ok, true);
  assert.equal(res.partial, true);
  assert.equal(
    skillrun.dispositionOf(skillrun.findRun(state.runs, rec.skillRunId)), "pending",
    "an accepted run refuses applyProposal, so a partial apply must NOT accept it",
  );
});

test("an action that is ALREADY SATISFIED counts as done — applying twice is safe", () => {
  const { ctl, state } = makeCtl({ dispatchAction: () => ({ ok: false, satisfied: true }) });
  const rec = seedProposedRun(state, {
    proposal: { edits: [{ clipId: "clip-1", trimInMs: 0, trimOutMs: 1000, reason: "掐头" }] },
  });
  const res = ctl.applyProposal(rec.skillRunId);
  assert.equal(res.ok, true);
  assert.equal(res.partial, false);
  assert.match(res.detail, /本来就已满足/);
});

test("applying a world proposal SAYS which requested fields it skipped", () => {
  // codex review, 批次 F2 round 1: `planApply` drops a facet the world document does
  // not have — which is right, it must not reach canon — but the report that made
  // that acceptable existed only as an unused helper. 「已应用」 with entries missing
  // and nothing said is the same silence, one layer later.
  const { ctl, state } = makeCtl({ dispatchAction: () => ({ ok: true }) });
  const rec = seedProposedRun(state, {
    skillId: "world-director",
    proposal: {
      proposals: [
        { field: "rules", value: "不禁止尝试，只禁止成功" },
        { field: "magicSystem", value: "六道源律" },
      ],
    },
  });
  const res = ctl.applyProposal(rec.skillRunId);
  assert.equal(res.ok, true);
  assert.match(res.detail, /1 项已应用/);
  assert.match(res.detail, /不是这份档案的字段，已跳过（magicSystem）/);
});

test("applyProposal refuses a run with nothing pending", () => {
  const { ctl, state } = makeCtl();
  const rec = seedProposedRun(state);
  ctl.accept(rec.skillRunId);
  const res = ctl.applyProposal(rec.skillRunId);
  assert.equal(res.ok, false);
  assert.match(res.error, /没有待应用的提案/);
});

// --- 6. 取消：只记录后端确认过的东西 (系统合同 §5.4 rule 3) ---------------- //

test("an UNCONFIRMED kill leaves the run in 「取消中」 — never marked cancelled", async () => {
  const { ctl, state } = makeCtl({
    runtime: { ...runtime, cancelRun: async () => ({ ok: false, detail: "残留 pid 4312" }) },
  });
  const rec = seedBackendRun(state);
  const res = await ctl.cancel(rec.skillRunId);
  assert.equal(res.ok, false);
  assert.match(res.error, /未能确认终止/);
  assert.equal(
    skillrun.findRun(state.runs, rec.skillRunId).status, "cancelling",
    "「已取消」 on screen while the executor keeps running and keeps spending",
  );
});

test("a run that FINISHED first keeps its real result — not overwritten with 「已取消」", async () => {
  const { ctl, state } = makeCtl({
    runtime: {
      ...runtime,
      cancelRun: async () => ({ ok: false, finished: true, detail: "这次运行已经结束" }),
    },
  });
  const rec = seedBackendRun(state);
  const res = await ctl.cancel(rec.skillRunId);
  assert.equal(res.ok, false);
  assert.equal(res.finished, true);
  assert.equal(res.error, "这次运行已经结束");
});

test("a CONFIRMED kill is recorded as cancelled", async () => {
  const { ctl, state } = makeCtl({
    runtime: { ...runtime, cancelRun: async () => ({ ok: true }) },
  });
  const rec = seedBackendRun(state);
  assert.equal((await ctl.cancel(rec.skillRunId)).ok, true);
  assert.equal(skillrun.findRun(state.runs, rec.skillRunId).status, "cancelled");
});

test("abandon is for MANUAL runs only — an executor's run needs a real kill", async () => {
  const { ctl, state } = makeCtl();
  const rec = seedBackendRun(state);
  const res = await ctl.abandon(rec.skillRunId);
  assert.equal(res.ok, false);
  assert.match(res.error, /取消运行/);
});

test("abandoning a front-end run reaches a TERMINAL state, not 「取消中」 forever", async () => {
  const { ctl, state } = makeCtl();
  const rec = skillrun.startRun(state.runs, {
    skillId: "editing-director", skillVersion: 1, runtime: "manual",
    executor: "manual", createdAt: "2026-08-15T00:00:00.000Z",
  });
  assert.equal((await ctl.abandon(rec.skillRunId)).ok, true);
  assert.equal(
    skillrun.findRun(state.runs, rec.skillRunId).status, "cancelled",
    "nothing would ever arrive to complete a `cancelling` transition here",
  );
});

// --- 7. 手工提交：同一份 schema、同一道闸 ---------------------------------- //

test("a LOCAL run cannot be answered by hand — that is a race, not a fallback", () => {
  const { ctl, state } = makeCtl();
  const rec = seedBackendRun(state);
  const res = ctl.submitManual(rec.skillRunId, "{}");
  assert.equal(res.ok, false);
  assert.match(res.error, /不能手工提交结果/);
});

test("a run that already LANDED is not open for a second answer", () => {
  const { ctl, state } = makeCtl();
  const rec = seedProposedRun(state);
  const res = ctl.submitManual(rec.skillRunId, "garbage");
  assert.equal(res.ok, false);
  assert.match(res.error, /不能再提交结果/);
  // v15 split the two questions: `succeeded` is 「the run finished」, `pending` is
  // 「the creator has not decided yet」 (ADR-0066 决策 8).
  const held = skillrun.findRun(state.runs, rec.skillRunId);
  assert.equal(held.status, "succeeded");
  assert.equal(
    skillrun.dispositionOf(held), "pending",
    "a malformed second paste must not wipe the proposal already held",
  );
  assert.notEqual(held.proposal, null);
});

// --- 8. 缺少输入 / 没有镜头 —— 老实拒绝，而不是回答一个没人问的问题 ------- //

test("a shot-scoped capability with no shot is refused with the reason", async () => {
  const { ctl } = makeCtl();
  const res = await ctl.run("image-prompt-director", { executor: "manual" });
  assert.equal(res.ok, false);
  assert.match(res.error, /先选一个镜头/);
});

test("missing required inputs refuse the run rather than answering plausibly", async () => {
  const { ctl } = makeCtl();
  // script-writer needs the outline/plan the empty story doc does not have
  const missing = ctl.missing("script-writer");
  assert.ok(missing.length > 0, "an empty project cannot satisfy script-writer");
  const res = await ctl.run("script-writer", { executor: "manual" });
  assert.equal(res.ok, false);
  assert.match(res.error, /缺少必要输入/);
});

test("an unknown capability is refused by every entry point", async () => {
  const { ctl } = makeCtl();
  assert.equal(ctl.find("nope"), null);
  assert.deepEqual(ctl.context("nope"), {});
  assert.equal(ctl.scopeOf("nope"), null);
  assert.equal(ctl.prompt("nope"), "");
  assert.deepEqual(ctl.missing("nope"), []);
  assert.equal((await ctl.run("nope")).ok, false);
});

// --- 9. 手工运行冻结它问的那个问题 ---------------------------------------- //

test("a manual run FREEZES its prompt — editing the project later must not rewrite it", async () => {
  const { ctl, state } = makeCtl();
  const t = timeline.timelineFor(state.timelines, "ep-1");
  t.clips.push({
    clipId: "clip-1", trackType: "video", shotId: null, assetId: "asset-v",
    startTime: 0, trimIn: 0, trimOut: 3, volume: 1, muted: false,
  });
  const res = await ctl.run("editing-director", { executor: "manual" });
  assert.equal(res.ok, true);
  assert.equal(res.manual, true);
  assert.ok(res.prompt.includes("clip-1"));

  const frozen = skillrun.findRun(state.runs, res.run.skillRunId).promptText;
  state.timelines = {}; // the creator edits — or loads another project
  assert.equal(
    skillrun.findRun(state.runs, res.run.skillRunId).promptText, frozen,
    "the creator copies this later; recompiling would hand them a different question",
  );
  assert.ok(frozen.includes("clip-1"));
});
