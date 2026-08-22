// 世界观梳理有了能力（TASK-094 批次 F2 / TASK-090 §2.4）。
//
// 产品负责人 2026-08-17：「都按你的建议来。」→ 选 B：**新增 `world-director`**，
// 而不是去扩 `relationship-director`。理由写在卡里：「关系」和「世界规则」是两种判断，
// 混在一个输出里会互相稀释。这个文件钉住那条边界，以及提案的写回路径。
import test from "node:test";
import assert from "node:assert/strict";

import { applicability, planApply, unknownWorldFields } from "../src/workflow/skillapply.js";
import { ACTIONS } from "../src/workflow/actions.js";
import { renderWorldWs, bindWorldWs } from "../src/ui/worldws.js";
import * as pd from "../src/workflow/proddoc.js";
import * as cd from "../src/workflow/canondoc.js";

const PROPOSAL = {
  proposals: [
    { field: "rules", value: "不禁止尝试，只禁止成功", basis: "第 1 集：救人成功后她被抹除" },
    { field: "era", value: "「存在」终局世界", basis: "第 1 集场景描述" },
    { field: "atmosphere", value: "冷、干净、随时会被改写", basis: "第 5 集断面" },
  ],
};

function ctxFor(prod, runs = [], onRun = null) {
  return {
    prodData: () => ({ production: prod, assetUploads: {} }),
    baseAssets: { all: () => ({ empty: true }), one: () => null },
    canon: {
      updateWorld: (fields) => cd.updateWorld(prod, fields),
      confirm: () => {},
    },
    bible: {},
    skills: {
      runs: () => runs,
      run: (skillId, opts) => {
        if (onRun) onRun(skillId, opts);
        return Promise.resolve({ ok: true, manual: false });
      },
    },
    toast: () => {},
    isConnected: () => true,
  };
}

// --- 单一职责 --------------------------------------------------------------- #

test("world-director exists as its own capability and does not touch relationships", () => {
  const app = applicability("world-director");
  assert.equal(app.can, true);
  assert.equal(app.target, "world");
  // …and it is NOT the relationship applier: two capabilities, two targets
  assert.equal(applicability("relationship-director").target, "relationships");
});

test("its proposal becomes ONE world write, carrying only the facets it named", () => {
  const res = planApply("world-director", PROPOSAL);
  assert.equal(res.ok, true);
  assert.equal(res.actions.length, 1, "七项是一份文档，不是七次写入");
  assert.equal(res.actions[0].action, "updateWorldSetting");
  assert.deepEqual(Object.keys(res.actions[0].fields).sort(), ["atmosphere", "era", "rules"]);
  assert.equal(res.actions[0].fields.rules, "不禁止尝试，只禁止成功");
  // the action is declared in the Action Layer vocabulary, with its args
  assert.deepEqual(ACTIONS.updateWorldSetting.args, ["fields"]);
});

test("a facet this document does not have is DROPPED and REPORTED", () => {
  const hostile = {
    proposals: [
      { field: "magicSystem", value: "六道源律" },
      { field: "relationships", value: "许渡 × 林照：交易" },
      { field: "rules", value: "真的规则" },
    ],
  };
  const res = planApply("world-director", hostile);
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.actions[0].fields), ["rules"],
    "不认识的项不得进 canon —— 创作者会以为自己接受了一条世界规则");
  assert.deepEqual(unknownWorldFields(hostile), ["magicSystem", "relationships"]);
  // …AND THE PLAN CARRIES IT, so the caller can say so. codex review 批次 F2 round 1:
  // the reporter existed but nothing called it, so the comment promising a report
  // described behaviour that did not exist.
  assert.deepEqual(res.skipped, ["magicSystem", "relationships"]);
});

test("an all-unknown proposal is refused, and the refusal names what it wrote", () => {
  const res = planApply("world-director", {
    proposals: [{ field: "magicSystem", value: "六道源律" }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /magicSystem/, "拒绝要说清它写的是什么，而不是「没有可写入的条目」");
});

test("an empty proposal is refused, not applied as a no-op that reports success", () => {
  assert.equal(planApply("world-director", { proposals: [] }).ok, false);
  assert.equal(planApply("world-director", { proposals: [{ field: "rules", value: "  " }] }).ok, false);
  assert.match(planApply("world-director", { proposals: [] }).error, /没有可写入/);
});

test("two proposals for one facet do not get concatenated into a third value", () => {
  const res = planApply("world-director", {
    proposals: [
      { field: "rules", value: "第一种说法" },
      { field: "rules", value: "第二种说法" },
    ],
  });
  assert.equal(res.actions[0].fields.rules, "第二种说法");
});

// --- 写回：只动被提到的项 ---------------------------------------------------- #

test("applying it never blanks a facet the creator wrote by hand", () => {
  const prod = pd.createProduction(null);
  cd.updateWorld(prod, { visualTone: "手写的视觉基调", rules: "手写的规则" });
  const ctx = ctxFor(prod);
  const res = planApply("world-director", PROPOSAL);
  // the dispatcher's merge is `ctx.canon.updateWorld(fields)`
  ctx.canon.updateWorld(res.actions[0].fields);
  assert.equal(prod.world.rules, "不禁止尝试，只禁止成功", "被提到的项被改写");
  assert.equal(prod.world.visualTone, "手写的视觉基调", "没被提到的项一个字都不动");
  assert.equal(prod.world.era, "「存在」终局世界");
  assert.equal(prod.world.society, "", "本来是空的仍然是空的");
});

// --- 入口与姿态 ------------------------------------------------------------- #

test("世界观 offers a primary action, and says whether AI ever ran", () => {
  const prod = pd.createProduction(null);
  const never = renderWorldWs(ctxFor(prod), { worldTab: "world" });
  assert.ok(never.includes("AI 梳理世界观"), "这一页原来根本没有 AI");
  assert.match(never, /data-world-ai/);
  assert.ok(never.includes("还没有让 AI 梳理过"));
  assert.ok(never.includes("没被提到的项一个字都不动"));

  const ran = renderWorldWs(
    ctxFor(prod, [{ skillId: "world-director", status: "succeeded", endedAt: "2026-08-18T09:00:00Z" }]),
    { worldTab: "world" },
  );
  assert.ok(ran.includes("上次梳理：succeeded"));
  assert.ok(!ran.includes("还没有让 AI 梳理过"));
});

test("pressing it runs world-director through the one run path", async () => {
  const prod = pd.createProduction(null);
  const calls = [];
  const ctx = ctxFor(prod, [], (skillId, opts) => calls.push([skillId, opts]));
  const ui = { worldTab: "world", skillExecutor: "claude-code" };
  const root = fakeRoot(renderWorldWs(ctx, ui));
  bindWorldWs(root, ctx, ui, () => {});
  root.byAttr("data-world-ai").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "world-director");
  assert.match(calls[0][1].summary, /已上传资产/);
});

/** The smallest DOM stand-in these bindings need. */
function fakeRoot(html) {
  const nodes = new Map();
  for (const m of html.matchAll(/data-([a-z-]+)(?:="([^"]*)")?/g)) {
    const attr = `data-${m[1]}`;
    if (!nodes.has(attr)) nodes.set(attr, { dataset: {}, onclick: null, attr });
  }
  return {
    querySelectorAll: (sel) => {
      const attr = sel.replace(/[[\]]/g, "").split("=")[0];
      const hit = nodes.get(attr);
      return hit ? [hit] : [];
    },
    querySelector: (sel) => {
      const attr = sel.replace(/[[\]]/g, "").split("=")[0];
      return nodes.get(attr) || null;
    },
    byAttr: (attr) => {
      const el = nodes.get(attr);
      if (!el) throw new Error(`no element with ${attr}`);
      return { click: () => el.onclick({ stopPropagation() {} }) };
    },
    ownerDocument: { activeElement: null, body: {} },
  };
}
