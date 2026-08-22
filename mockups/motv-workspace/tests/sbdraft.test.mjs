// TASK-097 批次 4F —— ④ Storyboard 草图，作为规则：
//
//   1. **便宜是它存在的理由。** 草图路径不得请求 2K —— 高清草图既不便宜，
//      也不比 ⑤ 早看到什么，那一步就白设了。守卫钉两个方向（§2.5d）。
//   2. **四种状态互不混淆**：`skipped`（人决定不画）/ `approved` / `drafted` /
//      `not_started`。「跳过」与「还没做」在界面上必须分得开（§2.5f 第一条）。
//   3. **通过绑在那一张具体的草图上**：换一张，通过自动失效。
//   4. **图片类 stage 的通过不与审片共用一条记录** —— 共用会让「通过了视频」
//      把「通过了草图」翻掉，于是 ④→⑤ 那道闸门在视频做完之后自己关上。
//   5. 闸门判定只有一份（`keyframeGate`），4G 的清单与画布都调它。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  DRAFT_SPEC, DRAFT_FORBIDDEN_RESOLUTIONS, draftSpecViolations,
  storyboardStrip, keyframeGate,
} from "../src/workflow/sbdraft.js";
import * as pdoc from "../src/workflow/proddoc.js";
import {
  approveShot, approveStage, unapproveStage, isStageArtifactApproved,
  isStageApprovedFor, stageReviewOf,
} from "../src/workflow/shotprod.js";
import { skipStage } from "../src/workflow/shotstage.js";

const items = (...ids) => ids.map((id, i) => ({ shotId: id, index: i, title: `镜 ${i + 1}`, sceneTitle: "S01" }));
const draft = (assetId, present = true) => ({ assetId, url: `/u/${assetId}.png`, version: 1, present });

/* ========================================================================= */
/* 1. 便宜档：两个方向都钉                                                     */
/* ========================================================================= */

test("草图不得按 2K 出，而草图档必须真的放行", () => {
  assert.equal(DRAFT_SPEC.quality, "draft");
  assert.deepEqual(draftSpecViolations(DRAFT_SPEC), [], "自己的规格必须通得过");
  assert.deepEqual(draftSpecViolations({ quality: "draft", resolution: "512p" }), []);
  // 高清一律拒 —— 逐个都拒，不只拒「2K」这一种拼法
  for (const res of DRAFT_FORBIDDEN_RESOLUTIONS) {
    const v = draftSpecViolations({ quality: "draft", resolution: res });
    assert.equal(v.length >= 1, true, `${res} 应当被拒`);
    assert.match(v[0], /便宜/);
  }
  // 说不出规格的请求也拒：不知道自己便不便宜
  assert.match(draftSpecViolations({ quality: "draft" })[0], /没有说清分辨率/);
  // 画质档不对也拒
  assert.match(draftSpecViolations({ quality: "high", resolution: "512p" })[0], /画质档/);
});

/* ========================================================================= */
/* 2 + 3. 四种状态；通过绑在那一张上                                            */
/* ========================================================================= */

test("四种状态互不混淆：跳过 / 已通过 / 有草图未通过 / 还没画", () => {
  const prod = pdoc.createProduction(null);
  const stages = prod.shotProduction.stages;
  skipStage(stages, "s1", "storyboard", "2026-08-20T00:00:00Z", "这一镜用空镜");
  approveStage(prod, "s3", "storyboard", "a3", "2026-08-20T00:00:00Z");
  const m = storyboardStrip({
    items: items("s1", "s2", "s3", "s4"),
    stages,
    draftOf: (id) => (id === "s2" ? draft("a2") : id === "s3" ? draft("a3") : null),
    approvedFor: (shotId, assetId) => isStageArtifactApproved(prod, shotId, "storyboard", assetId),
  });
  assert.deepEqual(m.rows.map((r) => r.state), ["skipped", "drafted", "approved", "not_started"]);
  assert.equal(m.skipped, 1);
  assert.equal(m.drafted, 1);
  assert.equal(m.approved, 1);
  assert.equal(m.notStarted, 1);
  // 「跳过」不是一个空位：它的动作是「取消跳过」，而不是「通过」
  const sk = m.rows[0];
  assert.equal(sk.canApprove, false);
  assert.equal(sk.canUnskip, true);
  assert.equal(sk.canSkip, false);
  // 「还没画」不给通过 —— 通过必须绑在一张具体的草图上
  assert.equal(m.rows[3].canApprove, false);
  assert.equal(m.rows[1].canApprove, true, "有草图未通过 → 可以按通过");
});

test("换一张草图，通过自动失效（与审片同一条纪律）", () => {
  const prod = pdoc.createProduction(null);
  approveStage(prod, "s1", "storyboard", "draft-v1", "2026-08-20T00:00:00Z");
  const strip = (assetId) => storyboardStrip({
    items: items("s1"),
    stages: prod.shotProduction.stages,
    draftOf: () => draft(assetId),
    approvedFor: (shotId, aid) => isStageArtifactApproved(prod, shotId, "storyboard", aid),
  });
  assert.equal(strip("draft-v1").rows[0].state, "approved");
  assert.equal(strip("draft-v2").rows[0].state, "drafted", "换了一张，旧的通过不再描述屏幕上的东西");
  // 「重出」= 撤销通过（删记录，不写 approved:false）
  assert.equal(unapproveStage(prod, "s1", "storyboard"), true);
  assert.equal(stageReviewOf(prod, "s1", "storyboard"), null);
  assert.equal(unapproveStage(prod, "s1", "storyboard"), false, "撤销两次不谎报成功");
});

/* ========================================================================= */
/* 4. 图片类通过与审片**不共用**一条记录                                        */
/* ========================================================================= */

test("通过了视频，不会把「通过了草图」翻掉（这一批的核心决定）", () => {
  const prod = pdoc.createProduction(null);
  approveStage(prod, "s1", "storyboard", "draft-1", "2026-08-20T00:00:00Z");
  // 审片通过了一个视频（那条记录带的是视频的 assetId）
  approveShot(prod, "s1", "video-1", "2026-08-20T01:00:00Z");
  // 草图那一格仍然是通过的 —— 共用一条记录的话它会翻回 false，
  // 于是 ④→⑤ 的闸门在视频做完之后自己关上
  assert.equal(isStageArtifactApproved(prod, "s1", "storyboard", "draft-1"), true);
  assert.equal(isStageApprovedFor(prod, "s1", "storyboard", "draft-1"), true);
  // 而视频那一格问的是审片那条记录（一个函数知道该问哪一份）
  assert.equal(isStageArtifactApproved(prod, "s1", "video", "video-1"), true);
  assert.equal(isStageArtifactApproved(prod, "s1", "video", "video-2"), false);
  // 反方向：没有通过就是没有
  assert.equal(isStageArtifactApproved(prod, "s1", "storyboard", "draft-2"), false);
  assert.equal(isStageArtifactApproved(prod, "s2", "storyboard", "draft-1"), false);
});

test("通过记录必须说得出通过了什么，而且能活过一次往返", () => {
  const prod = pdoc.createProduction(null);
  assert.equal(approveStage(prod, "s1", "storyboard", "", "t"), false, "没有 assetId 不给通过");
  assert.equal(approveStage(prod, "s1", "storyboard", "a1", "  "), false, "没有时间戳不给通过");
  assert.equal(approveStage(prod, "s1", "storyboard", "a1", "2026-08-20T00:00:00Z"), true);
  const round = pdoc.createProduction(pdoc.serialize(prod));
  assert.equal(isStageArtifactApproved(round, "s1", "storyboard", "a1"), true, "存下去、读回来还在");
  // 形状不对的记录在水合时被丢掉（读不懂的通过会让闸门误以为草图过了）
  const junk = pdoc.serialize(prod);
  junk.shotProduction.stageReviews.s2 = { storyboard: { approved: true } }; // 没有 assetId
  const cleaned = pdoc.createProduction(junk);
  assert.equal(stageReviewOf(cleaned, "s2", "storyboard"), null);
  assert.equal(isStageArtifactApproved(cleaned, "s1", "storyboard", "a1"), true, "好的那条没被牵连");
});

/* ========================================================================= */
/* 5. ④→⑤ 闸门：一份判定，两个方向                                             */
/* ========================================================================= */

test("闸门：跳过或（有草图且已通过）才放行，缺什么就说缺什么", () => {
  const row = (state) => ({ shotId: "s", state });
  assert.deepEqual(keyframeGate(row("skipped")), { ok: true, reason: "" }, "人决定不画 → 放行");
  assert.deepEqual(keyframeGate(row("approved")), { ok: true, reason: "" });
  const drafted = keyframeGate(row("drafted"));
  assert.equal(drafted.ok, false);
  assert.match(drafted.reason, /草图还没通过/);
  assert.match(drafted.reason, /或者跳过这一镜/, "给一条走得通的路，不是只说不行");
  const none = keyframeGate(row("not_started"));
  assert.equal(none.ok, false);
  assert.match(none.reason, /还没有草图/);
  assert.equal(keyframeGate(null).ok, false);
  // 话术里**没有**「不能进」这类堵死的说法：闸门不置灰导航（既有纪律）
  for (const r of [drafted, none]) assert.equal(/不能进|禁止/.test(r.reason), false);
});

/* ========================================================================= */
/* 6. round 1 的 P1：不许说「已排入」而什么都没发生                              */
/* ========================================================================= */

test("「一次出全集」给的是任务单，不是一句「已排入队列」（round 1 的 P1）", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  // 区间自己算（到下一个同级键），而且**只看代码不看注释** —— 这条守卫的第一版
  // 匹配到了自己那句解释性注释。同一个错误本链已经犯过三次，所以这里写成一个
  // 小工具，而不是又一次「记得剥注释」。
  const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const region = codeOnly((() => {
    const from = app.indexOf("  storyboard: {");
    const after = app.slice(from + "  storyboard: {".length);
    const next = after.search(/\n {2}[A-Za-z_$][A-Za-z0-9_$]*: \{/);
    return after.slice(0, next >= 0 ? next : after.length);
  })());
  // 不得再出现「排入」这种承诺 —— 今天没有那个队列（付费图片路线未被任何
  // Accepted ADR 授权），说了就是撒谎
  assert.equal(/排入/.test(region), false, "没有队列就不许说排入");
  // 取而代之：任务单（提示词 + 便宜档规格）+ 一条真的上传路径
  assert.match(region, /brief: \(shotId\)/);
  assert.match(region, /upload: async \(shotId\)/);
  assert.match(region, /ctx\.assets\.importReference\(\{\s*kind: "storyboard"/,
    "上传经既有登记路径，kind 是 storyboard");
  assert.match(region, /links: \{ shotId \}/, "并且链到这一镜 —— 否则找不回它属于谁");
  // 而界面上那个「上传」入口真的在
  const code = codeOnly(readFileSync(new URL("../src/ui/sbstrip.js", import.meta.url), "utf8"));
  assert.match(code, /data-sbs-up=/);
  assert.match(code, /ctx\.storyboard\.upload\(/);
});

test("探针的两个名字是**两样东西**，而且都在（round 2 的驳回）", () => {
  // codex 报「`mediaProbe` 与 `mediaprobe` 有一个是 undefined，`draftOf` 会抛」。
  // 不成立：`mediaprobe` 是模块命名空间（常量 MISSING / INCONCLUSIVE 从它取），
  // `mediaProbe` 是那一个实例（`createMediaProbe()`，`stateOf` 从它取）。既有代码
  // 在 stageBoard 里用的是完全相同的一对。这个测试把这个区分钉住 ——
  // 哪天有人把两者之一删掉或改名，它会先喊。
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const code = codeOnly(app);
  assert.match(code, /import \* as mediaprobe from "\.\/services\/mediaprobe\.js"/, "命名空间导入");
  assert.match(code, /const mediaProbe = mediaprobe\.createMediaProbe\(\)/, "实例只建一个");
  // 实例上取 stateOf，命名空间上取常量 —— 两处用法都必须存在且各在其位
  assert.match(code, /mediaProbe\.stateOf\(/);
  assert.match(code, /mediaprobe\.(MISSING|INCONCLUSIVE)/);
  // 每一处读探针的地方用的都是这一对（不是自己另建一个探针）。
  // **两处都钉**：codex 在 4F 轮 2 与 4G 轮 3 分别为 `draftOf` 与 `frameOf` 报过
  // 同一个不存在的缺陷，所以这条守卫覆盖两个函数，下次再报时有现成证据。
  for (const fn of ["draftOf: (shotId)", "frameOf: (shotId)"]) {
    const from = code.indexOf(fn);
    assert.ok(from > 0, `${fn} 不见了`);
    const body = code.slice(from, from + 1400);
    assert.match(body, /mediaProbe\.stateOf\(/, `${fn} 要用那个实例`);
    assert.match(body, /mediaprobe\.MISSING/, `${fn} 要用命名空间上的常量`);
    assert.equal(/createMediaProbe\(/.test(body), false, `${fn} 不该另建一个探针`);
  }
});
