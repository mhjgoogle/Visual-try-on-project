// TASK-097 批次 5A —— 后期状态。本批要成立的四件事：
//
//   1. **三个状态取自 TASK-092，不重算**（TASK-096 §2.1 指名要的守卫）。
//   2. **「可以开始」与「可以定稿」是界面上两个不同的判定**（§2.2，本批主要用户价值）。
//   3. **「要不要做」没人写下来时是「不知道」**，不是「不需要」也不是「差一个」。
//   4. 声音的证据通道：音频片段读成 voice / sfx 的产物，**丢一条就不算做完**。
//
// 纯测试：无 DOM、无网络、不花一分钱。

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  POST_STAGES, STAGE_TRACKS, UNSTAGED_TRACKS, unclassifiedTracks, stageOfTrack,
  audioEvidence, soundNeed, postPhase, postRows, postSummary, parallelWindow,
  soundGaps, PHASE_LABEL, NEED_UNKNOWN,
} from "../src/workflow/poststatus.js";
import {
  stageBoard, skipStage, canStart, canFinalize, FINALIZE_DEPENDENCIES, FINALIZE_EXTRA,
  STAGE_DEPENDENCIES, withFinalizeExtra,
} from "../src/workflow/shotstage.js";
import { TRACKS as AUDIO_TRACKS } from "../src/workflow/shotaudio.js";
import { renderPostStatus } from "../src/ui/poststatusbar.js";

const codeOnly = (src) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const SHOT_WITH_LINE = { shotId: "s1", sequence: 1, title: "一", dialogue: "你是谁？" };
const SHOT_NO_LINE = { shotId: "s2", sequence: 2, title: "二" };

/** 一镜的 board，由**生产的那个函数**产出 —— fixture 不自己造形状（§2.6.3）。 */
function boardFor({ stages = {}, shotId = "s1", videoPresent = false, audio = null } = {}) {
  return stageBoard(stages, shotId, {
    artifact: (stage) => {
      if (stage === "video") return videoPresent ? { assetId: "vid-1", present: true } : null;
      if (audio && (stage === "voice" || stage === "sfx")) return audio[stage];
      return null;
    },
    fact: (name) => (name === "dialogue" ? "completed" : null),
  });
}

/* ========================================================================= */
/* 1. 状态取自 092，不重算                                                     */
/* ========================================================================= */

test("这一层不判定四态 —— 它没有一处在拿状态词做比较", () => {
  const src = codeOnly(readFileSync(new URL("../src/workflow/poststatus.js", import.meta.url), "utf8"));
  // 允许出现的是**转达**（`cell.status`），不许出现的是**判定**：
  // 自己把 present / inflight / 探针结论读成 completed 就是第二份状态机。
  assert.equal(/mediaprobe|INCONCLUSIVE|present === true|inflight/.test(src), false,
    "证据的读法属于 shotstage，这一层不得复制");
  // 唯一被允许出现状态词的地方是把 `cell.status` 分流成 phase —— 那是**显示**。
  // 判据写成「把合法用法挖掉，剩下的一个都不许有」，而不是「存在一处合法用法即可」：
  // 后者是一条永远为真的断言，本链已经为这种假守卫付过三次代价。
  //
  // `skipped` 不在这条判据里，而且这是想清楚的：它**同时**是一个状态词和一个 phase
  // 词（「按设计跳过」在两边是同一件事，phase 就是原样转达）。把它算进去，判据只会
  // 抓到这份共用词汇本身，抓不到真正的风险 —— 那个风险是这一层自己去把证据读成
  // `completed` / `in_progress` / `not_started`。
  const RECOMPUTABLE = /"(not_started|in_progress|completed)"/;
  const withoutLegal = src.replace(/cell\.status === "(not_started|in_progress|completed)"/g, "");
  assert.equal(RECOMPUTABLE.test(withoutLegal), false, "状态词只能用于给 cell.status 分流");
  assert.equal(RECOMPUTABLE.test(src), true, "判据本身要有东西可抓，否则它是一条空守卫");
  // 界面那一层同样不许出现状态词
  const ui = codeOnly(readFileSync(new URL("../src/ui/poststatusbar.js", import.meta.url), "utf8"));
  assert.equal(/"(not_started|in_progress|completed|skipped)"/.test(ui), false,
    "渲染层拿到的是 phase，不是状态词");
});

test("board 读不出来 = 无法判定，不是「都还没开始」", () => {
  const rows = postRows([SHOT_WITH_LINE], { boardOf: () => null });
  assert.equal(rows.length, POST_STAGES.length);
  for (const r of rows) {
    assert.equal(r.phase, "unknown");
    assert.equal(r.status, null, "答不上来就不报一个状态词");
  }
  const sum = postSummary(rows);
  assert.equal(sum.voice.by.unknown, 1);
  assert.equal(sum.voice.settled, 0);
});

/* ========================================================================= */
/* 2. 可以开始 ≠ 可以定稿                                                      */
/* ========================================================================= */

test("配音在视频还没生成时**就能开始**，但**不能定稿** —— 两个判定，两句话", () => {
  const statuses = { dialogue: { status: "completed" }, video: { status: "not_started" } };
  assert.equal(canStart("voice", statuses).ok, true, "台词定了就能录 —— 不等视频");
  const fin = canFinalize("voice", statuses);
  assert.equal(fin.ok, false);
  assert.match(fin.blockers[0], /配音要贴画面时长/, "定稿被卡住要说清为什么");
  // 有了画面（或明确跳过）就能定稿
  assert.equal(canFinalize("voice", { ...statuses, video: { status: "completed" } }).ok, true);
  assert.equal(canFinalize("voice", { ...statuses, video: { status: "skipped" } }).ok, true);
});

test("定稿表是**派生**的，不是手抄的第二张表", () => {
  // 开工条件一改，定稿条件跟着改 —— 两张手写的表必然有一天各说一套（§2.5g）
  for (const stage of Object.keys(STAGE_DEPENDENCIES)) {
    const start = STAGE_DEPENDENCIES[stage];
    const fin = FINALIZE_DEPENDENCIES[stage];
    assert.deepEqual(fin.slice(0, start.length), start, `${stage} 的定稿条件必须包含开工条件`);
    assert.equal(fin.length, start.length + (FINALIZE_EXTRA[stage] || []).length);
  }
  // 自定义依赖表（加 Lip Sync、或测试加一个假 stage）也不会把额外那条丢掉
  const custom = withFinalizeExtra({ voice: [], sfx: [], fake: [] });
  assert.equal(custom.voice.length, 1, "给定哪张表就在哪张表上加");
  assert.deepEqual(custom.fake, []);
});

test("board 每一格同时带着两个判定 —— 消费者不必自己再算一次", () => {
  const b = boardFor({});
  assert.equal(b.voice.ok, true);
  assert.equal(b.voice.finalize.ok, false);
  assert.equal(boardFor({ videoPresent: true }).voice.finalize.ok, true);
  // qc 没有额外的定稿条件 —— 那就如实等于开工条件，不发明一个
  assert.equal(b.qc.ok, b.qc.finalize.ok);
});

test("那两个新词在屏幕上是分开的：现在就能开始 / 等画面对齐", () => {
  const parallel = postPhase({ status: "not_started", ok: true, finalize: { ok: false, blockers: ["x"] } }, true);
  assert.equal(parallel, "parallel");
  assert.equal(PHASE_LABEL.parallel, "现在就能开始");
  const waiting = postPhase({ status: "completed", ok: true, finalize: { ok: false, blockers: ["x"] } }, true);
  assert.equal(waiting, "waiting", "录好了但没有画面可对齐 —— 不是「已完成」");
  const done = postPhase({ status: "completed", ok: true, finalize: { ok: true, blockers: [] } }, true);
  assert.equal(done, "done");
  // 一集里的差额有一句话
  const rows = postRows([SHOT_WITH_LINE], { boardOf: () => boardFor({}) });
  const w = parallelWindow(rows);
  assert.equal(w.startable >= 1, true);
  assert.match(w.text, /现在就能开始/);
  assert.match(w.reason, /配音要贴画面时长/);
  // 没有差额时不念规则
  assert.equal(parallelWindow([]).text, "");
});

/* ========================================================================= */
/* 3. 「要不要做」没人写下来 = 不知道                                            */
/* ========================================================================= */

test("空台词是「不知道要不要配音」，不是「不需要配音」", () => {
  assert.equal(soundNeed(SHOT_WITH_LINE, "voice"), true);
  assert.equal(soundNeed(SHOT_NO_LINE, "voice"), null, "空着分不清默戏和还没写");
  assert.equal(soundNeed({ shotId: "x", dialogue: "   " }, "voice"), null);
  // 音效今天没有任何地方写下需求 —— 分镜表那一列是**片段数**
  assert.equal(soundNeed(SHOT_WITH_LINE, "sfx"), null);
  assert.match(NEED_UNKNOWN.sfx, /片段数/);
  // 每一镜都要审 —— qc 不问这个问题
  assert.equal(soundNeed(SHOT_NO_LINE, "qc"), true);
  // 这个函数**永远不返回 false**：「不需要」是人的决定（标为跳过），不是推断
  const src = readFileSync(new URL("../src/workflow/poststatus.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function soundNeed"));
  assert.equal(/return false/.test(body.slice(0, body.indexOf("\n}"))), false);
});

test("不知道的那些**不进「还差文件」**，而是带着一条真实可做的动作", () => {
  const rows = postRows([SHOT_NO_LINE], { boardOf: () => boardFor({ shotId: "s2" }) });
  const g = soundGaps(rows);
  assert.equal(g.missing, 0, "不知道要不要做，就不能说它「差一个文件」");
  assert.equal(g.undecided, 2, "配音 + 音效 各一");
  assert.match(g.byStage.voice.action, /写上台词|标为跳过/);
  assert.match(g.byStage.sfx.why, /不是需求/);
  // 写下了台词，它才变成一个真的缺口
  const withLine = soundGaps(postRows([SHOT_WITH_LINE], { boardOf: () => boardFor({}) }));
  assert.equal(withLine.byStage.voice.missing, 1);
  assert.equal(withLine.byStage.voice.undecided, 0);
});

test("跳过是「决定不做」，它了结这一步，而且与「不知道」分得开", () => {
  const stages = {};
  skipStage(stages, "s2", "voice", "2026-08-20T00:00:00Z", "默戏");
  const rows = postRows([SHOT_NO_LINE], { boardOf: () => boardFor({ stages, shotId: "s2" }) });
  const voice = rows.find((r) => r.stage === "voice");
  assert.equal(voice.phase, "skipped");
  assert.equal(soundGaps(rows).byStage.voice.undecided, 0, "决定过了就不再是「没人写下来」");
  assert.equal(postSummary(rows).voice.settled, 1);
});

/* ========================================================================= */
/* 4. 声音的证据通道                                                           */
/* ========================================================================= */

test("每一条音频轨都被分类过 —— 新增一条会当场被抓到", () => {
  assert.deepEqual(unclassifiedTracks(), [], "漏掉一条轨 = 它静默地不参与任何状态");
  // 覆盖面是**全部**轨：分给某一步，或显式声明不逐镜判定
  const mapped = Object.values(STAGE_TRACKS).flat();
  for (const t of AUDIO_TRACKS) {
    assert.ok(mapped.includes(t) || t in UNSTAGED_TRACKS, `${t} 没有归属`);
  }
  assert.equal(stageOfTrack("dialogue"), "voice");
  assert.equal(stageOfTrack("foley"), "sfx");
  assert.equal(stageOfTrack("bgm"), null, "BGM 是剧集级的，不逐镜判定");
  assert.equal(unclassifiedTracks(["lipsync"]).length, 1);
  // 而这条守卫在**屏幕上**也有效：没归属的轨会被说出来，不是静默忽略。
  // 只有测试调用的导出等于没接线（§2.5c 规则 3）。
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /unclassified: poststatus\.unclassifiedTracks\(\)/);
  const bar = readFileSync(new URL("../src/ui/poststatusbar.js", import.meta.url), "utf8");
  assert.match(bar, /m\.unclassified/);
  const html = renderPostStatus({
    hasShots: true, stages: [], rule: "r", summary: {}, parallel: null,
    gaps: { byStage: {} }, unclassified: ["lipsync"], whyHere: "w",
  });
  assert.match(html, /有音轨没有归属：lipsync/);
  assert.equal(/有音轨没有归属/.test(renderPostStatus({
    hasShots: true, stages: [], rule: "r", summary: {}, parallel: null,
    gaps: { byStage: {} }, unclassified: [], whyHere: "w",
  })), false, "没有问题时不制造噪音");
});

test("三条音效丢了一条就不是「做完了」", () => {
  const clips = [
    { assetId: "a1", trackType: "sfx" },
    { assetId: "a2", trackType: "ambience" },
    { assetId: "gone", trackType: "foley" },
  ];
  const all = audioEvidence(clips, { presentOf: () => true });
  assert.equal(all.sfx.present, true);
  assert.equal(all.sfx.clips, 3);
  assert.equal(all.sfx.assetId, null, "多个片段不绑其中任意一个");
  const one = audioEvidence(clips, { presentOf: (id) => id !== "gone" });
  assert.equal(one.sfx.present, false, "缺一条，合出来就缺一条");
  // 没有片段 = 没有产物（null），而不是「有一个不在的产物」
  assert.equal(audioEvidence([], { presentOf: () => true }).voice, null);
  // 单条时给出 assetId —— 将来逐份批准要绑的就是它
  assert.equal(audioEvidence([{ assetId: "v1", trackType: "dialogue" }], { presentOf: () => true }).voice.assetId, "v1");
  // 探针不认账 = 不算在（fail-closed）
  assert.equal(audioEvidence([{ assetId: "v1", trackType: "dialogue" }], {}).voice.present, false);
});

test("音频片段接上之后，配音真的会变成「已完成」——通道是通的", () => {
  const audio = { voice: { assetId: "v1", present: true, clips: 1 }, sfx: null };
  const b = boardFor({ videoPresent: true, audio });
  assert.equal(b.voice.status, "completed");
  const rows = postRows([SHOT_WITH_LINE], { boardOf: () => b });
  assert.equal(rows.find((r) => r.stage === "voice").phase, "done");
  // 画面还没有 → 同一份素材是「等画面对齐」，不是「已完成」
  const noPic = postRows([SHOT_WITH_LINE], { boardOf: () => boardFor({ audio }) });
  assert.equal(noPic.find((r) => r.stage === "voice").phase, "waiting");
});

/* ========================================================================= */
/* 5. 汇总与接线                                                              */
/* ========================================================================= */

test("汇总只印非零的桶，一个镜头都没有时不印 0", () => {
  const s = postSummary([]);
  assert.equal(s.voice.known, false);
  assert.match(s.voice.text, /还没有镜头/);
  const rows = postRows([SHOT_WITH_LINE, SHOT_NO_LINE], {
    boardOf: (id) => boardFor({ shotId: id }),
  });
  const sum = postSummary(rows);
  assert.equal(/0 镜/.test(sum.voice.text), false, "「0 镜进行中」是噪音");
  assert.match(sum.voice.text, /配音：/);
  assert.deepEqual(Object.keys(sum), POST_STAGES);
});

test("三步是派生的，不是手写的 ['voice','sfx','qc']", () => {
  const src = codeOnly(readFileSync(new URL("../src/workflow/poststatus.js", import.meta.url), "utf8"));
  assert.match(src, /STAGES\.filter\(/, "加一个 stage 应该自动出现在后期面板上");
  assert.deepEqual(POST_STAGES, ["voice", "sfx", "qc"]);
});

test("控制器把它接在 delivery 这一页上，而且不是接在历史键上", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /postStatus: \{/);
  // 状态来自 092 那一份计算，控制器不自己算
  // 区域**派生**：下一个同级键为界。写死一个字符数就是「锚在今天的位置上」，
  // 那正是本链踩过三次的那个形状（§2.5h 第三条）。
  const from = app.indexOf("  postStatus: {");
  assert.ok(from > 0, "postStatus 控制器不在了");
  const after = app.slice(from + "  postStatus: {".length);
  const next = after.search(/\n {2}[A-Za-z_$][A-Za-z0-9_$]*: [{(]/);
  const region = after.slice(0, next >= 0 ? next : after.length);
  assert.match(region, /ctx\.shot\.stageBoard\(shotId\)/);
  assert.equal(/status ===|"completed"/.test(codeOnly(region)), false, "控制器也不重算状态");
  // 挂载点：`delivery` 那个渲染分支，两个 section 分支都要有（qc 也是这一页）
  const prod = readFileSync(new URL("../src/ui/production.js", import.meta.url), "utf8");
  const dl = prod.slice(prod.indexOf("    delivery: (ctx) => {"));
  const body = dl.slice(0, dl.indexOf("\n    },"));
  assert.match(body, /renderPostStatus\(ctx\.postStatus\.model\(\)\)/);
  assert.equal((body.match(/\+ status \+/g) || []).length, 2, "七个 section 都在它下面");
  // 音频那条音轨证据由 app 接上（voice / sfx 不再永远 null）
  assert.match(app, /poststatus\.audioEvidence\(ctx\.shotAudio\.clips\(shotId\)/);
});
