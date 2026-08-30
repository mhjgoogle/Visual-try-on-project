// 作品设定：位置、入口、默认姿态（TASK-094 批次 F1 / TASK-090 §2.1 §2.3 §2.5）。
//
// 产品负责人 2026-08-17：
//   「现在的作品设定可以保留。但是作品设定的内容不应该在故事开发的时候准备。
//     人物关系应该是随着剧情推进有变化的。所以可能要放故事开发的最后。随着剧情的
//     推进可能用户会需要重新梳理作品设定。这时候会需要 AI 帮助梳理。」
import test from "node:test";
import assert from "node:assert/strict";

import { NAV, PAGES } from "../src/ui/shell.js";
import { renderRelWs, bindRelWs } from "../src/ui/relws.js";
import { lastRunOf } from "../src/ui/runskill.js";
import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import * as cd from "../src/workflow/canondoc.js";
import * as st from "../src/workflow/storydoc.js";
import * as sd from "../src/workflow/scriptdoc.js";
import * as relgraph from "../src/workflow/relgraph.js";

function project() {
  const prod = pd.createProduction(null);
  const a = bd.addCharacter(prod, "林照");
  const b = bd.addCharacter(prod, "许渡");
  return { prod, a, b };
}

function ctxFor(prod, runs = [], onRun = null) {
  return {
    prodData: () => ({ production: prod }),
    story: { doc: () => st.createStory(null) },
    script: { doc: () => sd.createDoc() },
    canon: { impact: () => null },
    // the REAL derivation, like the app wires it — a stubbed graph would let this
    // file pass while the page it claims to test could not render
    relgraph: { model: (opts = {}) => relgraph.relationshipGraph({ production: prod }, opts) },
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

// --- §2.1 位置 -------------------------------------------------------------- //

test("作品设定 退出左栏，但仍是十一页之一（ADR-0092 决策 3）", () => {
  // **规则变了，不是测试变绿**。产品负责人 2026-08-30：「左侧一级导航严格只有 4 个」
  // 「其余次级项收起或移除」。这里选了**收起**：页面、地址、既有跳转全部保留，
  // 只是不画在左栏（NAV 项上的 `hidden`）——所以人物 / 关系 / 世界观一格都没变得够不着。
  //
  // 旧规则的出处留在这里备查：TASK-090 §2.1「作品设定的内容不应该在故事开发的时候
  // 准备…放故事开发的最后」——它当时占最后一行，现在一行都不占。
  const keys = NAV[0].items.map((i) => i[0]);
  const drawn = NAV[0].items.filter((i) => !(i[3] && i[3].hidden)).map((i) => i[0]);
  assert.deepEqual(drawn, ["brief", "story", "episodes", "script"], "左栏严格四个入口");
  assert.ok(keys.includes("settings"), "作品设定不许从页面集合里消失");
  // 「不改成员集合 —— 因此不碰 PAGES.length === 11 那条冻结守卫」（ADR-0066 决策 10）
  assert.equal(PAGES.length, 11);
});

// --- §2.3 入口 -------------------------------------------------------------- //

test("人物关系 offers a primary action that RUNS relationship-director", () => {
  const { prod } = project();
  const html = renderRelWs(ctxFor(prod), { dirOpen: {} });
  assert.ok(html.includes("AI 梳理关系（按当前剧本）"));
  assert.match(html, /data-rel-ai/);
});

test("pressing it runs the capability through the ONE run path", async () => {
  const { prod } = project();
  const calls = [];
  const ctx = ctxFor(prod, [], (skillId, opts) => calls.push([skillId, opts]));
  const ui = { dirOpen: {}, skillExecutor: "claude-code" };
  const root = fakeRoot(renderRelWs(ctx, ui));
  bindRelWs(root, ctx, ui, () => {});
  root.byAttr("data-rel-ai").click();
  // the run is deliberately deferred one microtask (`Promise.resolve().then`), so a
  // SYNCHRONOUS throw out of `ctx.skills.run` is caught by the same chain
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "relationship-director");
  assert.equal(calls[0][1].executor, "claude-code", "执行器用创作者选的那个");
  assert.match(calls[0][1].summary, /当前剧本/);
});

// --- §2.5 默认姿态：说出「跑过没有」 ---------------------------------------- //

test("the page says whether AI has ever tidied the relationships", () => {
  const { prod } = project();
  const never = renderRelWs(ctxFor(prod, []), { dirOpen: {} });
  assert.ok(never.includes("还没有让 AI 梳理过"),
    "「从来没跑过」和「跑过但没提出新关系」在什么都不显示的屏幕上长得一样");

  // THE FIELD NAMES ARE THE DOMAIN'S (`workflow/skillrun.js`): `endedAt` when a run
  // finished, `startedAt` while it runs. A fixture inventing `finishedAt` would let
  // this test pass while the real chip showed nothing (codex review, 批次 F2 round 2).
  const ran = renderRelWs(
    ctxFor(prod, [
      { skillId: "relationship-director", status: "succeeded", startedAt: "2026-08-17T10:00:00Z", endedAt: "2026-08-17T11:22:00Z", skillRunId: "r1" },
    ]),
    { dirOpen: {} },
  );
  assert.ok(ran.includes("上次梳理：succeeded"));
  assert.ok(ran.includes("2026-08-17T11:22"), "显示的是结束时间，不是开始时间");
  assert.ok(!ran.includes("2026-08-17T10:00"));
  assert.ok(!ran.includes("还没有让 AI 梳理过"));
});

test("it also says the proposal will not overwrite a confirmed record", () => {
  const { prod } = project();
  const html = renderRelWs(ctxFor(prod), { dirOpen: {} });
  assert.ok(html.includes("提案"));
  assert.ok(html.includes("已确认的关系不会被覆盖"));
  // …and 「剧情推进后可以再跑一次」, which is the product owner's own point
  assert.ok(html.includes("再跑一次"));
});

test("lastRunOf reads real history and never invents one", () => {
  const ctx = ctxFor(pd.createProduction(null), [
    { skillId: "world-director", status: "failed", runId: "w1" },
    { skillId: "relationship-director", status: "succeeded", runId: "r1" },
    { skillId: "relationship-director", status: "failed", runId: "r2", startedAt: "2026-08-17T12:00:00Z" },
  ]);
  assert.equal(lastRunOf(ctx, "relationship-director").runId, "r2", "最后一条才是上一次");
  assert.equal(lastRunOf(ctx, "world-director").status, "failed");
  assert.equal(lastRunOf(ctx, "script-doctor"), null);
  assert.equal(lastRunOf({}, "relationship-director"), null, "没有运行记录通道就是没有");
});

test("lastRunOf reads the timestamp fields the domain really writes", () => {
  const at = (rec) => lastRunOf(ctxFor(pd.createProduction(null), [rec]), "world-director").at;
  // a run that ENDED reports its end; one still running reports its start; one that
  // never started reports when it was created — `skillrun.startRun` writes exactly
  // these three and never a `finishedAt`
  assert.equal(at({ skillId: "world-director", endedAt: "E", startedAt: "S", createdAt: "C" }), "E");
  assert.equal(at({ skillId: "world-director", startedAt: "S", createdAt: "C" }), "S");
  assert.equal(at({ skillId: "world-director", createdAt: "C" }), "C");
  assert.equal(at({ skillId: "world-director" }), "", "没有时间就是没有，不编一个");
});

test("a relationship beat still resolves — the graph keeps its existing meaning", () => {
  const { prod, a, b } = project();
  const rel = cd.addRelationship(prod, a.characterId, b.characterId);
  const ep = prod.episodes[0];
  cd.setEpisodeRelationshipBeat(prod, ep.episodeId, rel.relationshipId, {
    start: "交易", event: "他救了她", end: "同伴",
  });
  const html = renderRelWs(ctxFor(prod), { dirOpen: {}, relOpen: rel.relationshipId });
  assert.ok(html.includes("林照"));
  assert.ok(html.includes("许渡"));
});

/** The smallest DOM stand-in these bindings need: `querySelectorAll` + onclick. */
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
