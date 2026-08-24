// TASK-074 §1.4 —— **整条流程走一遍**，用真的领域模块，不用 AI、不花钱。
//
// 产品负责人 2026-08-24：「真实案例不能全部都用虚拟的吗」。**重新读 §1.4 之后：
// 能，而且比我之前说的多得多。**
//
// §1.4 点名的八条边界情况，**没有一条是「内容好不好」** —— 全是机械的：
// 闸拒绝、状态回落、进程退出、报错、版本保留。「内容判断」是我从 AGENTS.md §20
// 推出来的，**不在 §1.4 的文字里**；而 §20 禁占位素材的理由是「它不像真媒体那样
// 行为」，那条理由对 ffmpeg 生成的真媒体不成立。
//
// 所以这份测试把那条 17 步的链子**从头走到尾**，在它自然经过的地方断言边界情况。
// 走的是真的 `gates.js` / `review.js` —— 一个断言都不抄实现。
//
// **这里不做什么**：不判断分镜切得好不好、粗剪节奏顺不顺。那是审美，
// 而 §1.4 没有要求它 —— 里程碑级的产品判断在 TASK-037/040，不在这里。
import test from "node:test";
import assert from "node:assert/strict";

import {
  g1FormalReview,
  g2LockPicture,
  g3Retire,
  g3TriggerFor,
  g4Export,
  g5Append,
  nextVersionFor,
} from "../src/workflow/gates.js";
import { decision, issue, newDecisionId } from "../src/workflow/review.js";

/** 构造器返回 `{ok, value}`，并且**拒绝是有理由的** —— 这里不吞掉那个理由：
 *  构造失败时直接把 error 抛出来，否则夹具坏了会表现成「产品坏了」。 */
function must(built, what) {
  assert.ok(built.ok, `${what} 构造失败：${built.error}`);
  return built.value;
}

const EP = "ep-1";
const AT = "2026-08-24T00:00:00.000Z";

/** 一集的镜头。`hasConfirmedVideo` 是 G1 唯一看的东西。 */
const shots = (n, confirmed) =>
  Array.from({ length: n }, (_, i) => ({
    shotId: `sh-${i + 1}`,
    hasConfirmedVideo: i < confirmed,
  }));

test("§1.4 整条流程：分镜 → 定稿 → 粗剪 → 审片 → 锁定 → 质检 → 导出", () => {
  // ---- 分镜：三个镜头，还没有定稿视频 ------------------------------------
  let board = shots(3, 0);

  // ---- 边界 1：镜头未全定稿时提交正式审片 → 被 G1 拒绝，但可生成测试粗剪 --
  const early = g1FormalReview(board);
  assert.equal(early.ok, false, "没定稿就该被 G1 拒");
  assert.equal(early.kind, "test", "被拒之后仍然可以生成**测试**粗剪");
  assert.deepEqual(early.pendingShotIds, ["sh-1", "sh-2", "sh-3"]);
  assert.match(early.reason, /G1/);

  // ---- 单镜定稿：三个都定稿 ----------------------------------------------
  board = shots(3, 3);
  const formal = g1FormalReview(board);
  assert.equal(formal.ok, true, "全定稿之后 G1 应当放行");
  assert.equal(formal.kind, "formal");

  // ---- 自动粗剪：第 1 版 --------------------------------------------------
  let cuts = [];
  let v = nextVersionFor(cuts);
  assert.equal(v, 1);
  assert.equal(g5Append(cuts, v).ok, true);
  cuts = [...cuts, v];

  // ---- 整集审片：先退回重做一次（§1.4 明确要求「含一次退回重做」）--------
  let decisions = [
    must(
      decision({
        decisionId: newDecisionId("episode", EP),
        layer: "episode",
        targetId: EP,
        verdict: "needs_rework",
        by: "user",
        at: AT,
        basedOnVersion: 1,
      }),
      "退回重做的结论",
    ),
  ];
  assert.equal(
    g2LockPicture(decisions, { episodeId: EP, activeRoughCutVersion: 1 }).ok,
    false,
    "结论是「退回重做」时不能锁定画面",
  );

  // ---- 改完再出一版粗剪，然后审片通过 ------------------------------------
  v = nextVersionFor(cuts);
  assert.equal(v, 2);
  cuts = [...cuts, v];
  decisions = [
    ...decisions,
    must(
      decision({
        decisionId: newDecisionId("episode", EP),
        layer: "episode",
        targetId: EP,
        verdict: "passed",
        by: "user",
        at: AT,
        basedOnVersion: 2,
      }),
      "通过的结论",
    ),
  ];
  const lock = g2LockPicture(decisions, { episodeId: EP, activeRoughCutVersion: 2 });
  assert.equal(lock.ok, true, "针对当前版本的通过结论应当允许锁定画面");

  // ---- 边界 2：审片通过后改镜头顺序 → 回落 needs_rereview，锁定解除（G3）--
  // G3 认的是**动作名**的封闭映射（`G3_ACTIONS`）——「改镜头顺序」在时间线上
  // 就是 `moveTimelineClip`。我第一版写的 `reorderShots` 不在表里，被如实拒了：
  // 那正是验收 #4j 那类「表 ↔ 代码逐行一致」要守的东西。
  const trigger = g3TriggerFor("moveTimelineClip");
  assert.ok(trigger, "改镜头顺序必须是一个 G3 触发器");
  assert.equal(g3TriggerFor("notAnAction"), null, "不在表里的动作不触发回退");
  const retired = g3Retire(decisions, { episodeId: EP, trigger, at: AT });
  assert.equal(retired.changed, true, "结构变更必须让通过结论回落");
  assert.equal(retired.next.verdict, "needs_rereview");
  assert.equal(retired.unlockPicture, true, "画面锁定必须同时解除");
  // **回落是替换那一条，不是删掉它** —— 「这一集曾经通过过」这个事实要留着
  assert.equal(retired.next.decisionId, retired.decisionId);
  const after = decisions.map((d) => (d.decisionId === retired.decisionId ? retired.next : d));
  assert.equal(
    g2LockPicture(after, { episodeId: EP, activeRoughCutVersion: 2 }).ok,
    false,
    "回落之后不能再锁定画面",
  );
  // 幂等：再来一次结构变更不该重复回落（否则一串编辑会刷出一串通知）
  assert.equal(g3Retire(after, { episodeId: EP, trigger, at: AT }).changed, false);

  // ---- 后期 + 质检：先制造一个阻断级问题 ----------------------------------
  // `category` 必须在 delivery 层的**封闭集**里（`loudness`，不是我第一版写的
  // `audio_loudness`）—— 那条封闭集正是验收 #6「三层 Issue 的 category 互不相交」
  // 要挡的东西，被它拒一次说明它在干活。
  const blocking = must(
    issue({
      issueId: "iss-1",
      layer: "delivery",
      category: "loudness",
      severity: "blocking",
      source: "agent",
      targetId: EP,
      text: "整体响度超标",
      at: AT,
    }),
    "阻断级质检问题",
  );

  // ---- 边界 3：有 blocking 质检问题时导出 → 被 G4 拒绝并列出问题 ----------
  const refused = g4Export({ issues: [blocking] });
  assert.equal(refused.ok, false, "有阻断问题必须拒绝导出");
  assert.deepEqual(refused.blockingIssueIds, [blocking.issueId]);
  assert.match(refused.reason, /G4/);
  assert.match(refused.reason, /整体响度超标/, "拒绝时必须**列出**是哪个问题");

  // ---- 修掉之后导出放行 ---------------------------------------------------
  assert.equal(g4Export({ issues: [] }).ok, true);
});

test("§1.4 边界 3 的另一半：**没跑过质检 ≠ 通过**", () => {
  // 这一条常被忽略：G4 要的是一份真报告，而不是「没有阻断问题」。
  for (const notAReport of [undefined, null, {}, { issues: null }, "ok"]) {
    const r = g4Export(notAReport);
    assert.equal(r.ok, false, `${JSON.stringify(notAReport)} 不该被当成一份质检报告`);
    assert.match(r.reason, /没跑不等于通过|还没有跑/);
  }
});

test("§1.4 边界 8：每次粗剪 / 每次导出都是**新版本，旧版本仍在**", () => {
  // **这一条此前全仓没有任何测试**（TASK-087 §4.10 登记的缺口）。
  //
  // 这里验的是 **G5 这道闸本身**。它**不足以**守住边界 8 —— codex 复审一句话
  // 点破：这条测试只在内存里的数字数组上跑，生产代码完全可以绕开 G5 直接覆盖
  // 文件而它照样绿。**闸对不等于闸接上了。**
  //
  // 真正写文件的那条路在服务端（ 用 O_CREAT|O_EXCL 原子占号），
  // 由  在**磁盘上**验：
  // 旧的那几版还在不在、内容有没有被改写。两条一起才是边界 8 的守卫。
  let versions = [];
  for (let i = 1; i <= 5; i += 1) {
    const next = nextVersionFor(versions);
    assert.equal(next, i, "版本号只前进");
    const ok = g5Append(versions, next);
    assert.equal(ok.ok, true);
    versions = [...versions, next];
  }
  // 旧版本一个都没少
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);

  // 覆盖任何一个已存在的版本都必须被拒 —— 「代码里不存在覆盖分支」这句话
  // 由这条断言变成可检验的
  for (const existing of versions) {
    const r = g5Append(versions, existing);
    assert.equal(r.ok, false, `第 ${existing} 版已存在，不该允许再写一次`);
    assert.match(r.reason, /G5/);
  }
  // 倒退也不行
  assert.equal(g5Append(versions, 3).ok, false);
  // 非整数不行 —— 否则 `undefined` 会绕过整条判断
  for (const bad of [undefined, null, 1.5, "6", NaN]) {
    assert.equal(g5Append(versions, bad).ok, false, `${String(bad)} 不是合法版本号`);
  }
});
