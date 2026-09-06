// 「生成记录」有没有入口 —— TASK-087 §5.13。
//
// IA §6.3 把 Skill / Skill 版本 / Runtime / Executor / Model 从主界面移走，
// 原话是「moved here」不是 erased。**而那个 here 在 2026-09-06 之前谁也到不了**：
// `ui/genrecord.js` 在 `src/` 里零 importer，全模块一个测试也没有。
//
// 更重的一条在 `ui/production.js`：那里删掉「运行记录」框时写下的理由正是
// 「能力运行仍可在生成记录页读到」—— **一个界面被删的理由，依赖于一个不存在的
// 页面**。删东西时写下的「它在别处还看得到」，本身就是一条要被守住的断言。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { genRecordModel, renderGenRecord, genRecord } from "../src/ui/genrecord.js";
import { taskRowModel, renderTaskRows } from "../src/ui/taskrow.js";

const RUN = {
  runId: "run-77",
  taskName: "分镜设计",
  status: "succeeded",
  skillId: "storyboard-director",
  skillVersion: 2,
  runtime: "claude-code",
  executor: "claude-code",
  provider: "local_subscription",
  model: "claude-x",
  startedAt: "2026-09-06T10:00:00Z",
  endedAt: "2026-09-06T10:02:00Z",
  context: { shotId: "shot-1" },
};

test("那五个技术字段真的画出来了 —— 它们是被「移到这里」的，不是被删掉的", () => {
  const html = renderGenRecord(genRecordModel({ run: RUN }));
  // **标签在不等于值在**（codex 复审非阻断）：只查标签的话，某个字段错画成
  // 「未记录」照样绿 —— 而那正是这条守卫要防的失败（信息说是移过来了，实际没有）。
  for (const [label, value] of [
    ["Skill", "storyboard-director"],
    ["Skill 版本", "v2"],
    ["Runtime", "claude-code"],
    ["Executor", "claude-code"],
    ["Model", "claude-x"],
  ]) {
    assert.ok(html.includes(label), `少了「${label}」—— IA §6.3 说它们移到了这里`);
    assert.ok(html.includes(value), `「${label}」的值没画出来（期待 ${value}）`);
  }
  // 这一份记录里那五个字段都有值，所以它们任何一个都不该显示「未记录」
  const five = html.slice(html.indexOf("Skill"), html.indexOf("内部任务 ID"));
  assert.doesNotMatch(five, /未记录/, "有值的字段被画成了「未记录」");
});

test("没记录就说没记录 —— 空格子和 0 长得一样，而只有一个是真的", () => {
  const html = renderGenRecord(genRecordModel({ run: { runId: "r", status: "succeeded" } }));
  assert.match(html, /未记录/, "字段缺失时留了空白，而不是说出来");
});

test("手工放进来的东西没有生成记录 —— 这里不编一个来源出来", () => {
  const html = renderGenRecord(genRecordModel({}));
  assert.match(html, /直接导入|手工/, "空记录没有如实说明");
  assert.doesNotMatch(html, /Skill/, "没有来源却画出了技术字段");
});

test("**它挂得上任务行** —— 这条是 §5.13 的要害：能力存在 ≠ 到得了", async () => {
  // **驱动的是产品真正渲染的那一块**，不是测试自己搭的组合。
  // 第一版守卫就是自己搭的：把 `production.js` 里的入口拆掉，它照样绿 ——
  // 它断言的是「有没有 import」而不是「屏幕上有没有」。所以那一块被抽成了
  // `ui/shottasks.js`，这条才真会红（变异验证过）。
  const { renderShotTasks } = await import("../src/ui/shottasks.js");
  const html = renderShotTasks([RUN], "shot-1", {
    nowMs: Date.parse("2026-09-06T10:02:00Z"),
  });
  assert.match(html, /生成记录/, "任务行下面没有生成记录 —— 那一页仍然到不了");
  assert.match(html, /storyboard-director/, "记录挂上了却没带上技术字段");
  assert.match(html, /tk-row/, "把任务行本身弄丢了");
});

test("没选镜头时整块不渲染；这一镜没有任务时说出来", async () => {
  const { renderShotTasks } = await import("../src/ui/shottasks.js");
  assert.equal(renderShotTasks([RUN], null), "", "没选镜头却画了一块空的");
  const empty = renderShotTasks([RUN], "shot-other");
  assert.match(empty, /还没有发起过任务/, "别的镜头的任务被算进来了，或者空状态没说话");
  assert.doesNotMatch(empty, /storyboard-director/, "把别的镜头的运行画进来了");
});

test("不给 extra 时任务行一个字都不变 —— 这是加法，不是改写", () => {
  // **「有行、没记录」不足以证明「一字不变」**（codex 复审非阻断）：状态、耗时、
  // 操作按钮被删掉也照样满足那两条。所以这里直接比两次渲染的**差**。
  const models = [taskRowModel(RUN, { nowMs: Date.parse("2026-09-06T10:02:00Z") })];
  const plain = renderTaskRows(models, { emptyText: "空" });
  const withExtra = renderTaskRows(models, { emptyText: "空", extra: () => "<i data-x></i>" });

  assert.doesNotMatch(plain, /生成记录/);
  // 加法的确切含义：带 extra 的输出 = 不带 extra 的输出，逐行插入那段 extra
  assert.equal(withExtra.replace(/<i data-x><\/i>/g, ""), plain, "extra 改动了任务行本身");
  // 而任务行本身该有的东西一个不少
  assert.match(plain, /tk-row/);
  assert.match(plain, /分镜设计/, "任务名没了");
  assert.match(plain, /耗时/, "耗时那一格没了");
});

test("`src/ui/` 下不该有谁都到不了的模块", () => {
  // §5.13 的一般形状：**能力存在不等于到得了**。`genrecord.js` 曾经是零 importer，
  // 而它是唯一渲染那五个字段的地方 —— 删掉它会真的删掉能力，留着它又没人到得了。
  //
  // 判据刻意宽松：只要 `src/` 下有任何文件 import 它就算数（不追是否真被渲染），
  // **宁可漏报不误杀**。入口文件 `app.js` 自己不算孤儿。
  const SRC = new URL("../src/", import.meta.url);
  const NL = String.fromCharCode(10);
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(child, prefix + e.name + "/");
      else if (e.name.endsWith(".js")) files.push([prefix + e.name, readFileSync(child, "utf8")]);
    }
  };
  walk(SRC);

  const imported = new Set();
  for (const [, src] of files) {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n\r]*/g, " ");
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      imported.add(spec.split("/").pop());
    }
  }

  const orphans = files
    .map(([path]) => path)
    .filter((p) => p !== "app.js" && p.startsWith("ui/"))
    .filter((p) => !imported.has(p.split("/").pop()))
    .sort();

  // **登记在案的孤儿**：判的是「集合完全相等」，不是「不超过这些」——
  // 多出一个会红（新缺陷），**少一个也会红**（有人修好了却没更新这里）。
  // 一份只能变长的豁免名单迟早变成垃圾桶；这条形状逼它保持为真。
  const KNOWN = [
    // `ui/timelinews.js`（M11-B 时间线工作区）：后期控制台 `ui/postconsole.js`
    // 已经在做时间线，并且有顺序预览播放 —— 但**没有拖动游标那一条**，所以
    // 删掉它会真的删掉一个能力（TASK-074 §1.5 规则 2），而它今天又谁都到不了。
    // 两件事该由后期那一面的负责人一起定，已记 TASK-087（见台账「到不了的界面模块」那条）。
    "ui/timelinews.js",
  ];
  assert.deepEqual(
    orphans,
    KNOWN,
    `到不了的界面模块变了。多出来的是新缺陷，少掉的是已经修好但这份名单没跟上：${NL}${orphans.join(NL)}`,
  );
});
