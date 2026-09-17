// TASK-152 / REQ-009 判据 4：连着往下写若干章，可停、可改、不覆盖。
//
// 断言的是**行为**：这一片会静默出错的形状全在「写到了不该写的章」这一族 ——
// 覆盖了他刚写的、跳过了失败的那一章接着往下、停不下来、接错了上一章。
//
//   1. `chainTargets` —— 下一批写谁：没正文的、到 Planned 为止、按 count 截断。
//   2. `runChain` —— 每章现读再决定；失败停在原地；停止在两章之间生效；
//      每次运行的章号就是目标章号；应用用的是那次运行的 runId。
//   3. `chapterPlan.previous` —— 接着**最近一章有正文的**写，读的是此刻的正文。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as chain from "../src/workflow/novelchain.js";
import * as skills from "../src/workflow/skills.js";
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
import { createSkillController } from "../src/controllers/skillctl.js";
import { installBuiltinCatalog } from "./skillcatalog.mjs";

function novelWork({ planned = 12 } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  return k;
}

function write(k, no, text) {
  const u = w.ensureUnit(k, "novel", no, "T0");
  w.editUnit(k, u.id, "body", text, "T0");
  return u;
}

// --- 1. 下一批写谁 ---------------------------------------------------------- //

test("从第一章没正文的开始，已写的跳过，到 Planned 为止", () => {
  const k = novelWork({ planned: 6 });
  write(k, 1, "第一章");
  write(k, 2, "第二章");
  assert.deepEqual(w.chainTargets(k, null), [3, 4, 5, 6]);
  assert.deepEqual(w.chainTargets(k, 3), [3, 4, 5]);
  assert.deepEqual(w.chainTargets(k, 1), [3]);
});

test("中间空着的章也补 —— 显式假设，写在卡 §2", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "一");
  write(k, 3, "三");
  assert.deepEqual(w.chainTargets(k, 2), [2, 4]);
});

test("计划内全写完了 → 空数组，不越过 Planned 去写", () => {
  const k = novelWork({ planned: 2 });
  write(k, 1, "一");
  write(k, 2, "二");
  assert.deepEqual(w.chainTargets(k, 5), []);
});

test("只对小说成立；计划为 0 或 count 非法时什么都不写", () => {
  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  w.setPlanned(ep, "episode", 5);
  assert.deepEqual(w.chainTargets(ep, 3), []);
  const k = novelWork({ planned: 0 });
  assert.deepEqual(w.chainTargets(k, null), []);
  const k2 = novelWork({ planned: 4 });
  assert.deepEqual(w.chainTargets(k2, 0), []);
  assert.deepEqual(w.chainTargets(k2, -1), []);
  assert.deepEqual(w.chainTargets(k2, "x"), []);
});

test("只有空白的章不算已写", () => {
  const k = novelWork({ planned: 3 });
  write(k, 1, "   \n ");
  assert.deepEqual(w.chainTargets(k, null), [1, 2, 3]);
});

// --- 2. 驱动链 --------------------------------------------------------------- //

/** 一个假的「运行 + 应用」：运行成功就把正文写进 work 的那一章（应用做的事）。 */
function fakeDeps(k, { failAt = null, onRun = null } = {}) {
  const runs = [];
  const applied = [];
  let seq = 0;
  return {
    runs,
    applied,
    deps: {
      work: () => k,
      run: async (no) => {
        runs.push(no);
        if (onRun) onRun(no);
        if (failAt === no) return { ok: false, error: "执行器不可用" };
        seq += 1;
        return { ok: true, run: { runId: `run-${seq}`, unitNo: no } };
      },
      apply: (runId) => {
        applied.push(runId);
        const no = runs[runs.length - 1];
        write(k, no, `AI 写的第 ${no} 章`);
        return { ok: true };
      },
    },
  };
}

test("三章依次写出、落进各自那一章；已写的两章一个字不动", async () => {
  const k = novelWork({ planned: 12 });
  write(k, 1, "他写的第一章");
  write(k, 2, "他写的第二章");
  const c = chain.createChain(w.chainTargets(k, 3), { count: 3 });
  const f = fakeDeps(k);
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [3, 4, 5], "每次运行的章号必须就是目标章号");
  assert.deepEqual(f.applied, ["run-1", "run-2", "run-3"], "应用的是那次运行自己的 runId");
  assert.deepEqual(c.written, [3, 4, 5]);
  for (const no of [3, 4, 5]) {
    assert.equal(k.units.find((u) => u.no === no).body, `AI 写的第 ${no} 章`);
  }
  assert.equal(k.units.find((u) => u.no === 1).body, "他写的第一章");
  assert.equal(k.units.find((u) => u.no === 2).body, "他写的第二章");
});

test("链跑着的时候他自己写了下一章 → 跳过它、不覆盖、往后补足章数（§5.2）", async () => {
  const k = novelWork({ planned: 6 });
  const c = chain.createChain(w.chainTargets(k, 3), { count: 3 }); // 开链时名单 [1,2,3]
  const f = fakeDeps(k, {
    // 写第 1 章的那次运行进行中，他在第 2 章手写了几段
    onRun: (no) => { if (no === 1) write(k, 2, "他中途写的第二章"); },
  });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [1, 3, 4], "第 2 章不该被跑；「写 3 章」要补到第 4 章（codex 轮 1 的 P2）");
  assert.deepEqual(c.written, [1, 3, 4]);
  assert.deepEqual(c.skipped, [2]);
  assert.equal(k.units.find((u) => u.no === 2).body, "他中途写的第二章", "他写的被覆盖了");
  assert.match(chain.describe(c), /第 2 章已有正文，跳过/);
});

test("他在**正在写的那一章**里自己写了 → 运行回来不落地，他的字一个不动（codex 轮 1 的 P1）", async () => {
  const k = novelWork({ planned: 6 });
  const c = chain.createChain(w.chainTargets(k, 3), { count: 3 });
  const f = fakeDeps(k, {
    // 第 2 章的运行还没回来，他已经在第 2 章的编辑器里写下了自己的版本
    onRun: (no) => { if (no === 2) write(k, 2, "他趁着 AI 在写的时候自己写的第二章"); },
  });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [1, 2, 3, 4], "第 2 章的运行已经起了，回来后跳过，再往后补足");
  assert.deepEqual(f.applied, ["run-1", "run-3", "run-4"], "第 2 章那一版**不许**应用");
  assert.equal(
    k.units.find((u) => u.no === 2).body,
    "他趁着 AI 在写的时候自己写的第二章",
    "他正在写的那一章被 AI 那一版盖掉了",
  );
  assert.deepEqual(c.skipped, [2]);
  assert.deepEqual(c.held, ["run-2"], "AI 那一版要留在册上让他自己决定，不是丢掉");
  assert.match(chain.describe(c), /留在「能力」面板里，没有落地/);
});

test("没给数 = 写到计划内没正文的都写完，中途他写了的也不重写", async () => {
  const k = novelWork({ planned: 5 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k, {
    onRun: (no) => { if (no === 1) write(k, 4, "他写的第四章"); },
  });
  await chain.runChain(c, f.deps);
  assert.equal(c.status, "done");
  assert.deepEqual(f.runs, [1, 2, 3, 5]);
  assert.deepEqual(c.skipped, [4]);
  assert.equal(k.units.find((u) => u.no === 4).body, "他写的第四章");
});

// --- 2b. 起不起得来 ------------------------------------------------------------ //

test("连写只对小说成立，且要一个能自动跑完的执行器（§5.7）", () => {
  const novel = novelWork();
  assert.deepEqual(chain.readiness(novel, "claude-code"), { ok: true });

  const ep = w.createWork(null);
  w.setForm(ep, "episode");
  assert.equal(chain.readiness(ep, "claude-code").ok, false);
  assert.match(chain.readiness(ep, "claude-code").reason, /小说/);
  assert.equal(chain.readiness(null, "claude-code").ok, false);

  for (const executor of [null, undefined, "", "manual"]) {
    const r = chain.readiness(novel, executor);
    assert.equal(r.ok, false, `executor=${String(executor)} 竟然能连写`);
    assert.match(r.reason, /执行器/, "拒绝要说出缺的是执行器");
  }
});

test("一章失败 → 链停在那一章，不跳过它去写下一章", async () => {
  const k = novelWork({ planned: 5 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k, { failAt: 2 });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "failed");
  assert.deepEqual(f.runs, [1, 2], "失败之后还在往下跑");
  assert.deepEqual(c.written, [1]);
  assert.deepEqual(c.failed, { no: 2, error: "执行器不可用" });
  assert.equal(k.units.find((u) => u.no === 2), undefined, "失败的那一章不该有东西落进去");
  assert.match(chain.describe(c), /停在第 2 章/);
});

test("应用失败也算失败 —— 写出来却没落地，不能当写完", async () => {
  const k = novelWork({ planned: 3 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k);
  f.deps.apply = () => ({ ok: false, error: "还不知道该写第几章" });
  await chain.runChain(c, f.deps);
  assert.equal(c.status, "failed");
  assert.deepEqual(c.written, []);
  assert.equal(c.failed.no, 1);
});

test("停止在两章之间生效：写完手上这一章就停，再接着来不重写", async () => {
  const k = novelWork({ planned: 6 });
  const c = chain.createChain(w.chainTargets(k, null)); // 1..6
  const f = fakeDeps(k, {
    onRun: (no) => { if (no === 2) chain.requestStop(c); }, // 第 2 章跑着的时候按了停
  });
  await chain.runChain(c, f.deps);

  assert.equal(c.status, "stopped");
  assert.deepEqual(f.runs, [1, 2], "按了停还往下跑了");
  assert.deepEqual(c.written, [1, 2], "手上那一章要写完落地，不是半途丢掉");
  assert.match(chain.describe(c), /已停下/);

  // 再说一次「接着写」：从进度接着算，不重写 1、2
  assert.deepEqual(w.chainTargets(k, null), [3, 4, 5, 6]);
});

test("运行抛异常不让链崩掉 —— 记成失败停下", async () => {
  const k = novelWork({ planned: 2 });
  const c = chain.createChain(w.chainTargets(k, null));
  const f = fakeDeps(k);
  f.deps.run = async () => { throw new Error("网断了"); };
  await chain.runChain(c, f.deps);
  assert.equal(c.status, "failed");
  assert.equal(c.failed.error, "网断了");
});

test("手工执行器不连写：一次运行都不起（§5.7）", async () => {
  // `readiness` 是 production.startNovelChain 起链前问的那道闸；这里证明它拒了就没有链。
  const k = novelWork({ planned: 3 });
  const r = chain.readiness(k, "manual");
  assert.equal(r.ok, false);
  const f = fakeDeps(k);
  if (r.ok) await chain.runChain(chain.createChain(w.chainTargets(k, null)), f.deps);
  assert.deepEqual(f.runs, [], "被拒了却还起了运行");
  assert.equal(k.units.filter((u) => (u.body || "").trim()).length, 0);
});

test("没有可写的章：链一开始就是 done，且说的是「都已经有正文了」", async () => {
  const c = chain.createChain([]);
  assert.equal(c.status, "done");
  assert.match(chain.describe(c), /都已经有正文/);
  const f = fakeDeps(novelWork());
  await chain.runChain(c, f.deps);
  assert.deepEqual(f.runs, []);
});

// --- 3. 接着谁写 --------------------------------------------------------------- //

test("本章任务带着上一章此刻的结尾 —— 他中途改过就是改过的", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "第一章原稿。结尾是旧的。");
  assert.equal(w.chapterPlanOf(k, 2).previous.no, 1);
  assert.match(w.chapterPlanOf(k, 2).previous.tail, /结尾是旧的/);

  const u1 = k.units.find((u) => u.no === 1);
  w.editUnit(k, u1.id, "body", "第一章改过了。结尾变成新的。", "T1");
  assert.match(w.chapterPlanOf(k, 2).previous.tail, /结尾变成新的/, "读的不是此刻的正文");
});

test("接着的是最近一章**有正文**的，不是第 N−1 章；第一章没有 previous", () => {
  const k = novelWork({ planned: 5 });
  write(k, 1, "一");
  w.ensureUnit(k, "novel", 2, "T0"); // 第 2 章空着
  const p = w.chapterPlanOf(k, 3).previous;
  assert.equal(p.no, 1, "接了一个空章");
  assert.equal(w.chapterPlanOf(k, 1).previous, null);
});

test("结尾只取最后一段，不把整章塞回去", () => {
  const k = novelWork({ planned: 3 });
  write(k, 1, "开头".repeat(500) + "真正的结尾");
  const tail = w.chapterPlanOf(k, 2).previous.tail;
  assert.equal(tail.length, w.PREVIOUS_TAIL_CHARS);
  assert.ok(tail.endsWith("真正的结尾"));
});

// --- 4. 走真实的 controller：每章仍是一次登记在册的运行 + 一次应用（REQ-007 判据 3） --- //
//
// 上面用假的「运行 + 应用」测的是链的规则；这一段把「链的一步就是一次普通运行」这句话
// 用真的 `skillctl` 证一遍：真的登记表、真的 `skillrun`（pending → accepted）、真的
// `skillapply.planApply`、真的 `applyBodyProposal`。唯一的假件是执行器（不起真进程）
// 与 `dispatchAction` 那一端（它需要整个浏览器外壳）。

function installNovelistCatalog() {
  // 磁盘上那一份真的能力包（prompt 与 output.schema 都是真的），不是手写的形状。
  installBuiltinCatalog(skills);
}

/** 真的 controller（真的文档模块、真的登记表）+ 一个只会「按提示词里的章号写一句」
 *  的假执行器。 */
function realController(k, { beforeAnswer = null } = {}) {
  const registry = [];
  const prompts = [];
  const fakeRuntime = {
    EXECUTOR_BY_ID: new Map([["claude-code", { id: "claude-code", runtime: "local_subscription" }]]),
    runOnExecutor: async ({ prompt }) => {
      prompts.push(prompt);
      const no = Number((prompt.match(/"no": (\d+)/) || [])[1]);
      if (beforeAnswer) beforeAnswer(no);
      return { ok: true, text: JSON.stringify({ chapter: `AI 写的第 ${no} 章正文` }), model: "fake" };
    },
  };
  const story = storydoc.createStory(null);
  story.work = k;
  const state = {
    production: {
      characters: [], relationships: [], world: {}, locations: [], episodes: [],
      activeEpisodeId: null, blocking: {},
    },
    story,
    script: scriptdoc.createDoc(null),
    registry: { images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} },
  };
  const ctl = createSkillController({
    docs: {
      runs: () => registry,
      production: () => state.production,
      story: () => state.story,
      script: () => state.script,
      registry: () => state.registry,
      refInterp: () => ({}), timelines: () => ({}), shotAudio: () => ({}), subtitles: () => ({}),
      generations: () => [],
    },
    catalog: { detail: () => null, problems: () => [] },
    modules: {
      skills, runtime: fakeRuntime, skillrun, skillapply, shotctx, proddoc, storydoc, scriptdoc,
      assetreg, refinterp, timeline, subtitle, mediaref, storywork: w,
    },
    findShot: () => null, slotOf: () => null, isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => ({}) },
    shotCtx: { build: () => ({ context: null }), candidates: () => ({ candidates: [] }) },
    draftShots: () => [],
    // `app.js` 那一端做的事：按提案自带的落点身份写进那一章（TASK-146）。
    dispatchAction: (act) => {
      if (act.action !== "proposeScript") return { ok: false, error: `没接线：${act.action}` };
      const r = w.applyBodyProposal(k, { boundForm: act.form, boundUnitNo: act.unitNo }, act.text, "T");
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    persist: () => {}, refresh: () => {},
    now: () => "2026-09-18T00:00:00Z",
  });
  return { ctl, registry, prompts };
}

test("真 controller：三章各是一次登记在册的运行，应用后 accepted，正文落进各自那一章", async () => {
  installNovelistCatalog();
  const k = novelWork({ planned: 6 });
  w.setOutline(k, "海底城市浮出水面\n\n考古队决定下潜");
  write(k, 1, "他写的第一章。结尾：灯灭了。");
  const { ctl, registry, prompts } = realController(k);

  const c = chain.createChain(w.chainTargets(k, 2), { count: 2 });
  await chain.runChain(c, {
    work: () => k,
    run: (no) => ctl.run("novel-chapter-writer", { executor: "claude-code", scope: { unitNo: no } }),
    apply: (runId) => ctl.applyProposal(runId),
  });

  assert.equal(c.status, "done", JSON.stringify(c.failed));
  assert.deepEqual(c.written, [2, 3]);
  assert.equal(k.units.find((u) => u.no === 2).body, "AI 写的第 2 章正文");
  assert.equal(k.units.find((u) => u.no === 3).body, "AI 写的第 3 章正文");
  assert.equal(k.units.find((u) => u.no === 1).body, "他写的第一章。结尾：灯灭了。");

  // 登记在册：每章一条 run，记着它写的是第几章，且已 accepted（不是「写了但没人认领」）
  assert.equal(registry.length, 2);
  assert.deepEqual(registry.map((r) => r.context.unitNo), [2, 3]);
  assert.ok(registry.every((r) => skillrun.isAccepted(r)), "应用过的运行要是 accepted");
  // 接着谁写：第 2 章的提示词里有第 1 章此刻的结尾；第 3 章的里有 AI 刚写的第 2 章
  assert.match(prompts[0], /灯灭了/, "第 2 章没拿到第 1 章的结尾");
  assert.match(prompts[1], /AI 写的第 2 章正文/, "第 3 章没拿到刚落地的第 2 章");
});

test("真 controller：他在正在写的那一章里自己写了 → 提案留在册上 pending，他的字一个不动", async () => {
  installNovelistCatalog();
  const k = novelWork({ planned: 6 });
  w.setOutline(k, "大纲");
  const { ctl, registry } = realController(k, {
    beforeAnswer: (no) => { if (no === 1) write(k, 1, "他趁 AI 在写时自己写的第一章"); },
  });

  const c = chain.createChain(w.chainTargets(k, 2), { count: 2 });
  await chain.runChain(c, {
    work: () => k,
    run: (no) => ctl.run("novel-chapter-writer", { executor: "claude-code", scope: { unitNo: no } }),
    apply: (runId) => ctl.applyProposal(runId),
  });

  assert.equal(c.status, "done", JSON.stringify(c.failed));
  assert.deepEqual(c.written, [2, 3], "第 1 章跳过后要补到第 3 章");
  assert.deepEqual(c.skipped, [1]);
  assert.equal(k.units.find((u) => u.no === 1).body, "他趁 AI 在写时自己写的第一章");
  const held = registry.find((r) => r.context.unitNo === 1);
  assert.ok(skillrun.isPending(held), "AI 为第 1 章写的那一版要留成 pending 提案，不是丢掉也不是落地");
  assert.deepEqual(c.held, [held.runId]);
  // 他之后可以自己决定用它 —— 那时才走覆盖前存一版的既有兜底
  const late = ctl.applyProposal(held.runId);
  assert.equal(late.ok, true, late.error);
  const one = k.units.find((u) => u.no === 1);
  assert.equal(one.body, "AI 写的第 1 章正文");
  assert.equal(w.visibleVersions(one.finalized).length, 1, "他自己写的那一版没被存下来");
});
