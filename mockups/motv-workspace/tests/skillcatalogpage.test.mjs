// TASK-080 §1.1 — ⚙ 能力目录.
//
// The rules under test are the ones a creator would notice if they broke:
//
//   1. EVERY capability the backend serves is on the page. Not a sample, not the
//      four the right column used to recommend.
//   2. A capability that FAILED TO LOAD stays visible WITH ITS REASON. Vanishing
//      from a list is indistinguishable from never having existed, and only one
//      of those is something the creator can fix (ADR-0067 决策 7).
//   3. Retired capabilities are marked and NOT mixed in with the live ones.
//   4. The filter narrows the live list and NEVER the problem list.
//
// Pure: no DOM, no fetch, no clock. The catalog is the REAL builtin package set,
// read the same way the backend reads it.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as skills from "../src/workflow/skills.js";
import { builtinCatalogPayload, installBuiltinCatalog } from "./skillcatalog.mjs";
import {
  skillCatalogModel, renderSkillCatalog, catalogRows, WORK_LABEL,
} from "../src/ui/skillcatalog.js";

installBuiltinCatalog(skills);

const PAYLOAD = builtinCatalogPayload();

/** The narrow ctx face the catalog reads — nothing else is touched. */
function makeCtx({ problems = [], installed = true, detail = "", missing = () => [] } = {}) {
  return {
    skills: {
      catalog: () => skills.SKILLS,
      deprecated: () => skills.DEPRECATED,
      catalogState: () => ({ installed, detail, problems }),
      missing,
      find: (id) => skills.findSkill(id),
    },
  };
}

test("每一个能力都在页面上：目录 == 后端发的可选集合，一个不少", () => {
  const m = skillCatalogModel(makeCtx(), {});
  assert.equal(m.total, PAYLOAD.skills.length);
  assert.ok(m.total >= 21, `expected the real catalog, got ${m.total}`);
  const shown = m.groups.flatMap((g) => g.rows.map((r) => r.skillId)).sort();
  assert.deepEqual(shown, PAYLOAD.skills.map((s) => s.skillId).sort());
});

test("每张卡说清「它要什么输入、产出什么、谁提供的」", () => {
  const m = skillCatalogModel(makeCtx(), {});
  for (const r of m.groups.flatMap((g) => g.rows)) {
    assert.ok(r.title, `${r.skillId} has no title`);
    assert.ok(r.purpose, `${r.skillId} has no purpose`);
    assert.ok(r.role, `${r.skillId} has no role`);
    assert.ok(r.recommendedRuntime, `${r.skillId} has no recommended runtime`);
    assert.equal(r.sourceLabel, "内置");
    assert.equal(typeof r.shotScoped, "boolean");
    // the input keys are TRANSLATED through the shared label table the payload
    // carries — a raw context key is not something a creator can read
    for (const i of r.inputs) {
      assert.equal(i.label, PAYLOAD.inputs[i.key] || i.key);
      assert.notEqual(i.label, "", `${r.skillId} input ${i.key} has no label`);
    }
  }
});

test("镜头级能力被标出来，并且判定来自 payload 自己的 shotScopedInputs", () => {
  const m = skillCatalogModel(makeCtx(), {});
  const rows = m.groups.flatMap((g) => g.rows);
  const scoped = rows.filter((r) => r.shotScoped);
  assert.ok(scoped.length, "no shot-scoped capability found — the list is wrong");
  for (const r of rows) {
    const keys = [...r.inputs, ...r.optionalInputs].map((i) => i.key);
    assert.equal(
      r.shotScoped,
      PAYLOAD.shotScopedInputs.some((k) => keys.includes(k)),
      `${r.skillId} shotScoped disagrees with the shared table`,
    );
  }
});

test("已停用的能力标出来，且不与在用的混排（ADR-0067 决策 5）", () => {
  const m = skillCatalogModel(makeCtx(), {});
  assert.equal(m.deprecated.length, PAYLOAD.deprecated.length);
  assert.ok(m.deprecated.length, "the fixture has no retired capability to check");
  const live = new Set(m.groups.flatMap((g) => g.rows.map((r) => r.skillId)));
  for (const r of m.deprecated) {
    assert.equal(r.deprecated, true);
    assert.ok(!live.has(r.skillId), `${r.skillId} is retired AND listed as pickable`);
  }
  const html = renderSkillCatalog(m);
  assert.match(html, /已停用/);
});

test("加载失败的能力可见且带原因，不从列表里消失（ADR-0067 决策 7）", () => {
  const problems = [
    { skillId: "broken-one", source: "project", reason: "output.schema.json 不是合法 JSON" },
    { skillId: "", source: "user", detail: "manifest.json 缺少 skillId" },
  ];
  const m = skillCatalogModel(makeCtx({ problems }), {});
  assert.equal(m.problems.length, 2);
  assert.equal(m.problems[0].reason, "output.schema.json 不是合法 JSON");
  // a package whose id could not be read is still a ROW, never a blank line
  assert.equal(m.problems[1].skillId, "（未能读出能力 ID）");
  assert.equal(m.problems[1].reason, "manifest.json 缺少 skillId");
  const html = renderSkillCatalog(m);
  assert.match(html, /broken-one/);
  assert.match(html, /output\.schema\.json 不是合法 JSON/);
  assert.match(html, /manifest\.json 缺少 skillId/);
});

test("搜索只收窄在用列表，永远不收窄失败清单", () => {
  const problems = [{ skillId: "broken-one", source: "project", reason: "读不出来" }];
  const ctx = makeCtx({ problems });
  const all = skillCatalogModel(ctx, {});
  // a query that matches nothing at all
  const none = skillCatalogModel(ctx, { scQuery: "zzz-no-such-capability" });
  assert.equal(none.groups.length, 0);
  assert.equal(none.shown, 0);
  // …the totals still say what the system can do
  assert.equal(none.total, all.total);
  // …and the failures are still there, which is the whole point
  assert.equal(none.problems.length, 1);
  assert.match(renderSkillCatalog(none), /broken-one/);
});

test("按 work 分组用的是 manifest 自己声明的值，未知值落到「其他」而不是消失", () => {
  const ctx = makeCtx();
  const m = skillCatalogModel(ctx, {});
  const byId = new Map(PAYLOAD.skills.map((s) => [s.skillId, s]));
  for (const g of m.groups) {
    assert.equal(g.label, WORK_LABEL[g.key]);
    for (const r of g.rows) {
      const declared = byId.get(r.skillId).work;
      assert.equal(r.work, ["creative", "review", "other"].includes(declared) ? declared : "other");
    }
  }
  // filtering by one group keeps exactly that group's rows
  const creative = skillCatalogModel(ctx, { scWork: "creative" });
  assert.deepEqual(creative.groups.map((g) => g.key), ["creative"]);
  assert.equal(creative.shown, m.counts.creative);
});

test("缺少输入来自运行路径同一个检查，不是目录自己算的", () => {
  const ctx = makeCtx({ missing: (id) => (id === "script-writer" ? ["outline", "brief"] : []) });
  const m = skillCatalogModel(ctx, {});
  const row = m.groups.flatMap((g) => g.rows).find((r) => r.skillId === "script-writer");
  assert.ok(row, "script-writer is not in the builtin catalog any more");
  assert.equal(row.ready, false);
  assert.deepEqual(row.missing, ["outline", "brief"]);
  const html = renderSkillCatalog(m);
  assert.match(html, /缺少必要输入/);
  // everything else stays runnable — a per-skill check, not a page-wide verdict
  assert.ok(m.groups.flatMap((g) => g.rows).filter((r) => r.ready).length >= m.total - 1);
});

test("目录不可用时说「不可用」而不是「没有能力」，失败清单照样在", () => {
  const m = skillCatalogModel(
    makeCtx({ installed: false, detail: "后端不可达", problems: [{ skillId: "x", reason: "y" }] }),
    {},
  );
  const html = renderSkillCatalog(m);
  assert.match(html, /能力目录不可用/);
  assert.match(html, /后端不可达/);
  assert.match(html, /这不是「没有能力」/);
  assert.match(html, /<b>x<\/b>/);
});

test("catalogRows 是 ⚙ 目录与 `/` 唤出共用的唯一来源", () => {
  const ctx = makeCtx();
  const rows = catalogRows(ctx);
  const m = skillCatalogModel(ctx, {});
  assert.deepEqual(
    rows.map((r) => r.skillId).sort(),
    m.groups.flatMap((g) => g.rows.map((r) => r.skillId)).sort(),
  );
  // and it never leaks a retired capability into the pickable set
  const retired = new Set(skills.DEPRECATED.map((s) => s.skillId));
  for (const r of rows) assert.ok(!retired.has(r.skillId));
});
