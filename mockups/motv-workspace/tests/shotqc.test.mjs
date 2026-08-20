// TASK-097 批次 5B —— 逐镜质检。四件事，其中第二件是这张卡自己点名的陷阱：
//
//   1. **时长**：实测 vs 分镜表，超差如实标出，**不自动改数据**；
//      「没测过」与「没跑成」是两个不同的处境。
//   2. **一致性**：「没有发送记录」≠「没用上」。
//      TASK-096 §2.4 原话：「这一条只在 ADR-0071 落地后才有意义，否则它永远报『没用上』」。
//   3. **缺口**：取自 TASK-092 的状态，不另算；「不知道」不并进「还差」。
//   4. **只读**：报告不写任何东西，也不做审美判断。
//
// 纯测试：无 DOM、无网络、不花一分钱。

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  QC_ITEMS, QC_STAGES, DURATION_TOLERANCE_S,
  durationCheck, gapCheck, consistencyCheck, shotQcReport, qcSummary, interesting,
} from "../src/workflow/shotqc.js";
import { stageBoard, skipStage } from "../src/workflow/shotstage.js";
import { postRows } from "../src/workflow/poststatus.js";

const codeOnly = (src) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const SHOT6 = { shotId: "s1", sequence: 1, title: "一", duration_seconds: 6, dialogue: "喂？" };
const SHOT10 = { shotId: "s2", sequence: 2, title: "二", duration_seconds: 10 };

/** board 由**生产的那个函数**产出（§2.6.3）。 */
function boardFor({ shotId = "s1", stages = {}, video = null, audio = null } = {}) {
  return stageBoard(stages, shotId, {
    artifact: (stage) => {
      if (stage === "video") return video;
      if (audio && (stage === "voice" || stage === "sfx")) return audio[stage];
      return null;
    },
    fact: (name) => (name === "dialogue" ? "completed" : null),
  });
}

/* ========================================================================= */
/* 1. 时长                                                                     */
/* ========================================================================= */

test("没测过 / 没跑成 / 测到了 —— 三个不同的答案，送去三个不同的地方", () => {
  const never = durationCheck(SHOT6, null);
  assert.equal(never.state, "unknown");
  assert.match(never.detail, /还没测过/);
  assert.match(never.action, /测这一镜/);

  const failed = durationCheck(SHOT6, { error: "ffmpeg/ffprobe 缺失" });
  assert.equal(failed.state, "unknown");
  assert.match(failed.detail, /没测成：ffmpeg/, "「没跑成」要说清是什么没跑成");
  assert.notEqual(failed.detail, never.detail, "两种处境不能长成同一句话");

  // 探测跑完了但服务端没写这个字段（「测不到就不写」）—— 也是不知道，不是 0 秒
  const noField = durationCheck(SHOT6, { name: "a.mp4" });
  assert.equal(noField.state, "unknown");
  assert.equal(/0s/.test(noField.detail), false);
});

test("超差如实标出，而且**不去改分镜表的数字**", () => {
  const ok = durationCheck(SHOT6, { durationS: 6.3 });
  assert.equal(ok.state, "pass", `${DURATION_TOLERANCE_S}s 以内算对得上`);
  const bad = durationCheck(SHOT6, { durationS: 8.3 });
  assert.equal(bad.state, "fail");
  assert.match(bad.detail, /实际 8\.3s，分镜表写 6s —— 差 \+2\.3s/);
  // 该改哪一个只有创作者知道：所以动作是「去那一镜」，不是「改成 8.3」
  assert.match(bad.action, /去这一镜/);
  assert.equal(/改成|自动|同步为/.test(bad.action), false);
  // 短了也一样报
  assert.equal(durationCheck(SHOT10, { durationS: 6 }).state, "fail");
  // **分镜表写的数照原样读**：8 秒的镜头不许拿去和 6 秒比（那会造出一条假发现）。
  // 本仓库别处有「6 或 10，其他当 6」那句兜底，那是排音频轨用的，判据不能用它。
  const eight = { shotId: "s8", duration_seconds: 8 };
  assert.equal(durationCheck(eight, { durationS: 8.2 }).state, "pass");
  assert.match(durationCheck(eight, { durationS: 8.2 }).detail, /分镜表写 8s/);
  // 没写时长 = 没有可比的目标 → 无法判定，不是「按 6 秒算」
  const nothing = durationCheck({ shotId: "s9" }, { durationS: 6.1 });
  assert.equal(nothing.state, "unknown");
  assert.match(nothing.detail, /没写这一镜的时长/);
  // 本模块一行都不写 —— **行为判据**，不是文本判据：把输入全部冻起来跑一遍报告，
  // 任何一次改写都会当场抛错。文本判据在这里会误伤（往本地数组里 push 不是写数据）。
  const shot = Object.freeze({ ...SHOT6 });
  const gen = Object.freeze({ referenceAssetIds: Object.freeze(["a1"]) });
  const rep = shotQcReport({
    shots: Object.freeze([shot]),
    boardOf: () => boardFor({}),
    boundOf: () => Object.freeze([Object.freeze({ assetId: "a1", name: "林照" })]),
    genOf: () => gen,
    measureOf: () => Object.freeze({ durationS: 9 }),
  });
  assert.equal(rep.rows.length, 1);
  assert.equal(shot.duration_seconds, 6, "分镜表的数字一个字节都没动");
});

/* ========================================================================= */
/* 2. 一致性 —— 本卡点名的陷阱                                                  */
/* ========================================================================= */

test("**没有发送记录 ≠ 没用上** —— 三种处境三个答案", () => {
  const bound = [{ assetId: "a-lin", name: "林照 设定图" }];

  // ① 手工放进来的视频：没有生成记录
  const noGen = consistencyCheck({ bound, generation: null });
  assert.equal(noGen.state, "unknown");
  assert.equal(/没用上|没有用/.test(noGen.detail), false, "这是「不知道」，不是「它没做」");
  assert.match(noGen.detail, /没有对应的生成记录/);

  // ② 有记录，但一张参考都没记（ADR-0071 之前的那些）
  const noRefs = consistencyCheck({ bound, generation: { referenceAssetIds: [] } });
  assert.equal(noRefs.state, "unknown");
  assert.equal(/没用上/.test(noRefs.detail), false,
    "TASK-096 §2.4：否则它永远报「没用上」——这正是那条");
  assert.match(noRefs.detail, /没有留下参考发送记录/);

  // ③ 记录里有几张，缺这一张 —— 这才是一个真的发现
  const real = consistencyCheck({ bound, generation: { referenceAssetIds: ["a-other", "a-bg"] } });
  assert.equal(real.state, "fail");
  assert.match(real.detail, /林照 设定图 没有进这一次生成/);
  assert.match(real.detail, /这次送了 2 张/);

  // ④ 都在
  const pass = consistencyCheck({ bound, generation: { referenceAssetIds: ["a-lin"] } });
  assert.equal(pass.state, "pass");

  // ⑤ 一张都没绑：没有可核对的东西，也不是「没用上」
  const none = consistencyCheck({ bound: [], generation: { referenceAssetIds: ["x"] } });
  assert.equal(none.state, "unknown");
  assert.match(none.action, /绑定/);
});

test("这条判据读的是**发起时冻结**的那份记录，不是现在的绑定", () => {
  // `genlib.startGeneration` 冻结 `referenceAssetIds`，所以「当时送了什么」是可查的。
  // 这个测试钉住字段名：改掉它就等于让这条判据永远答不上来。
  const src = readFileSync(new URL("../src/workflow/genlib.js", import.meta.url), "utf8");
  assert.match(src, /referenceAssetIds: idArray\(entry\.referenceAssetIds\)/);
  const qc = readFileSync(new URL("../src/workflow/shotqc.js", import.meta.url), "utf8");
  assert.match(qc, /generation\.referenceAssetIds/);
});

/* ========================================================================= */
/* 3. 缺口 —— 取自 092，不另算                                                  */
/* ========================================================================= */

test("缺口用的是 TASK-092 那一份状态，「不知道」不并进「还差」", () => {
  const rows = postRows([SHOT6], { boardOf: () => boardFor({}), stages: QC_STAGES });
  const gap = gapCheck(rows);
  // 视频没有 → 那是一个真的缺口；音效「要不要做还没写下来」→ 单独说
  assert.equal(gap.state, "fail");
  assert.match(gap.detail, /还差 视频/);
  assert.match(gap.detail, /另有 音效/);

  // 三步都了结 → 通过
  const settled = {};
  skipStage(settled, "s1", "voice", "2026-08-20T00:00:00Z");
  skipStage(settled, "s1", "sfx", "2026-08-20T00:00:00Z");
  const done = postRows([SHOT6], {
    boardOf: () => boardFor({ stages: settled, video: { assetId: "v1", present: true } }),
    stages: QC_STAGES,
  });
  assert.equal(gapCheck(done).state, "pass");

  // 全部差在「不知道」上 → 那不是缺口的清单，是一个还没被回答的问题
  const unknownOnly = postRows([{ shotId: "s3", sequence: 3 }], {
    boardOf: () => boardFor({ shotId: "s3", video: { assetId: "v", present: true } }),
    stages: QC_STAGES,
  });
  const g = gapCheck(unknownOnly);
  assert.equal(g.state, "unknown");
  assert.match(g.detail, /配音|音效/);

  // 读不到状态 → 不知道，不是「都没做」
  assert.equal(gapCheck([]).state, "unknown");
});

test("这一层不重算状态 —— 它没有一处在读证据", () => {
  const src = codeOnly(readFileSync(new URL("../src/workflow/shotqc.js", import.meta.url), "utf8"));
  assert.equal(/mediaprobe|INCONCLUSIVE|present === true|inflight|isSkipped/.test(src), false);
  assert.match(src, /postRows\(/, "缺口经 poststatus 那一份派生");
});

/* ========================================================================= */
/* 4. 报告                                                                     */
/* ========================================================================= */

test("报告：未检查不是通过，而且它不拦任何东西", () => {
  const rep = shotQcReport({
    shots: [SHOT6, SHOT10],
    boardOf: (id) => boardFor({ shotId: id }),
    boundOf: () => [],
    genOf: () => null,
    measureOf: () => null,
  });
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.passed, false, "还有 unknown 就不是通过");
  assert.ok(rep.unknowns > 0);
  assert.match(rep.line, /2 镜/);
  // 三条判据每一条都有一行汇总
  assert.deepEqual(Object.keys(rep.summary), QC_ITEMS.map((i) => i.key));
  assert.match(rep.summary.consistency.text, /无法判定/);
  // 没有镜头时不印 0 通过
  const empty = shotQcReport({ shots: [] });
  assert.equal(empty.passed, false);
  assert.match(empty.line, /还没有镜头/);
  assert.equal(empty.summary.duration.known, false);
});

test("三条全过时报告能说出来，而且只列有话说的那些镜头", () => {
  const stages = {};
  skipStage(stages, "s1", "voice", "t");
  skipStage(stages, "s1", "sfx", "t");
  const rep = shotQcReport({
    shots: [SHOT6],
    boardOf: () => boardFor({ stages, video: { assetId: "v1", present: true } }),
    boundOf: () => [{ assetId: "a1", name: "林照" }],
    genOf: () => ({ referenceAssetIds: ["a1"] }),
    measureOf: () => ({ durationS: 6.1 }),
  });
  assert.equal(rep.passed, true);
  assert.equal(rep.fails, 0);
  assert.equal(rep.unknowns, 0);
  assert.match(rep.line, /三条判据全过/);
  assert.deepEqual(interesting(rep.rows), [], "全过的镜头不占版面");
});

test("表最多 20 行，而且**说出来**还剩多少 —— 不静默截断", async () => {
  const { shotQcModel, LIST_CAP } = await import("../src/ui/shotqcpanel.js");
  const shots = Array.from({ length: 60 }, (_, i) => ({ shotId: `s${i}`, sequence: i + 1 }));
  const m = shotQcModel({
    shotQc: {
      measurableIds: () => [],
      report: () => shotQcReport({
        shots,
        boardOf: (id) => boardFor({ shotId: id }),
        boundOf: () => [],
        genOf: () => null,
        measureOf: () => null,
      }),
    },
  });
  assert.equal(m.listed.length, LIST_CAP);
  assert.equal(m.overflow, 40);
  // 按钮上的数是**真会被测到**的数：一条视频都没有时，不许承诺「60 镜」
  assert.equal(m.measurable, 0);
  const html0 = (await import("../src/ui/shotqcpanel.js")).renderShotQc(m);
  assert.equal(/逐镜测时长/.test(html0), false, "没有视频可测时不摆那个按钮");
  assert.match(html0, /还没有视频可测/);
  assert.match(
    (await import("../src/ui/shotqcpanel.js")).renderShotQc({ ...m, measurable: 3 }),
    /逐镜测时长（3 镜有视频/,
  );
  const { renderShotQc } = await import("../src/ui/shotqcpanel.js");
  assert.match(renderShotQc(m), /另有 40 镜同样有发现，未列出/);
});

test("界面只读：没有一个按钮会改数据，也没有审美判断", () => {
  const ui = readFileSync(new URL("../src/ui/shotqcpanel.js", import.meta.url), "utf8");
  const code = codeOnly(ui);
  // 只有两种动作：去那一镜、去测一次
  assert.match(code, /data-sq-go/);
  assert.match(code, /data-sq-measure/);
  assert.equal(/dispatchAction|ctx\.shot\.save|persist\(\)/.test(code), false, "报告不写数据");
  // 审美判断明确不做，而且说出来
  assert.match(ui, /审美判断/);
  // 「无法判定」不能显示成通过
  assert.match(code, /unknown: "无法判定"/);
  assert.equal(/unknown: "通过"/.test(code), false);
});

test("控制器把三样证据接上，而且时长测量不落盘", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const from = app.indexOf("  shotQc: {");
  assert.ok(from > 0, "shotQc 控制器不在了");
  const after = app.slice(from + "  shotQc: {".length);
  const next = after.search(/\n {2}[A-Za-z_$][A-Za-z0-9_$]*: [{(]/);
  const region = after.slice(0, next >= 0 ? next : after.length);
  // 状态取 092 那一份、绑定取既有 references、发送记录取生成登记表
  assert.match(region, /ctx\.shot\.stageBoard\(shotId\)/);
  assert.match(region, /ctx\.shot\.references\(shotId\)/);
  // 而这个名字**真的存在**。一个文本判据只证明我写下了它：第一版写成
  // `ctx.episode.references`，那条断言照样通过，而真实屏幕上整块面板炸掉
  // （`ctx.episode.references is not a function`）—— §2.5f 第三条原话：
  // 往 ctx 上挂一个名字之前先 grep 它。
  //
  // 判据：**本批不引入任何新的 ctx 能力**，它只消费既有的。所以这里调的每一个
  // `ctx.x.y(` 在 app.js 里都必须**另有调用方**。我凭空发明的那个只会出现在这一处，
  // 于是当场被抓；而将来真要新增一个能力的人会看到这句话，知道该去真实屏幕上确认。
  for (const m of new Set([...region.matchAll(/ctx\.[A-Za-z_$]+\.[A-Za-z_$]+\(/g)].map((x) => x[0]))) {
    // 自己内部的小助手（`ctx.shotQc._x`）当然只有自己在调 —— 判据问的是**外部能力**
    if (m.startsWith("ctx.shotQc.")) continue;
    const uses = app.split(m).length - 1;
    const here = region.split(m).length - 1;
    assert.ok(uses > here, `${m}…) 只有逐镜质检在调 —— 先确认这个名字真的存在`);
  }
  assert.match(region, /g\.type === "video"/);
  assert.match(region, /query\.deliveryProbe\(PROJECT_NAME, name\)/);
  // 探测抛了也不能永远卡在「探测中」：那是一个只能靠刷新解开的死结，
  // 而刷新会丢掉这一轮所有测量（codex 轮 2 的 blocking —— 今天的 `attempt` 兜底
  // 让它不可达，仍然加了，代价四行）。
  assert.match(region, /catch \(e\)/);
  assert.match(region, /探测出错/);
  assert.equal(/running: true[\s\S]*catch/.test(region), true, "running 一定有出路");
  // 测量键是**视频的 assetId** —— 换 take 自动失效
  assert.match(region, /SHOT_PROBES\.get\(assetId\)/);
  assert.match(app, /const SHOT_PROBES = new Map\(\)/);
  // 不进序列化：一次测量说的是那一个文件的事
  assert.equal(/SHOT_PROBES/.test(app.slice(app.indexOf("function serialize"))), false,
    "测量结果不持久化（与 DELIVERY_PROBE 同一条理由）");
  // 挂载在 delivery 的 qc 一节，和交付质检并列
  const prod = readFileSync(new URL("../src/ui/production.js", import.meta.url), "utf8");
  assert.match(prod, /renderShotQc\(shotQcModel\(ctx\)\) \+ renderQcPanel\(ctx\.deliveryQc\(\)\)/);
  assert.match(prod, /bindShotQc\(root, ctx, ui, render, \{ openShot/);
});
