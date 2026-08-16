// TASK-082 §1.2 — 资产库左栏：删重复 rail，改内容树.
//
// The rules under test:
//
//   1. The grouping comes from `asset.links` and NOTHING else. A tree that
//      inferred ownership from a filename, a usage site or a name match would be
//      a second, quieter answer to 「这个素材属于谁」 — and the two would drift.
//   2. 「没有归属的素材」 is a GROUP, not a gap. It is the only way to reach an
//      asset the registry never linked, so it must not be silently absent.
//   3. The tree sets the library's OWNERSHIP filters and never its TYPE filter:
//      the page's chips own that vocabulary (which is the duplication C-018 was).
//   4. Every historical `assets:*` key still resolves to the library with its
//      filter set — the rail rows went, the addresses did not.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assetTreeModel, renderAssetTree, activeTreeNode, libraryModel } from "../src/ui/assetlibws.js";
import { LINK_KEYS } from "../src/workflow/assetreg.js";

const link = (over = {}) => {
  const l = {};
  for (const k of LINK_KEYS) l[k] = null;
  return { ...l, ...over };
};

const ROWS = [
  { assetId: "a1", name: "林晚 Ref", links: link({ characterId: "ch-1" }) },
  { assetId: "a2", name: "林晚 夜班", links: link({ characterId: "ch-1", episodeId: "ep-1" }) },
  { assetId: "a3", name: "酒吧 Ref", links: link({ locationId: "lo-1" }) },
  { assetId: "a4", name: "EP01 成片", links: link({ episodeId: "ep-1" }) },
  // linked to a SHOT only — no character, no location, no episode: this is the
  // asset a category rail could never surface
  { assetId: "a5", name: "临时上传", links: link({ shotId: "sh-9" }) },
  { assetId: "a6", name: "谁也不知道", links: link() },
];

const NAMES = {
  character: (id) => (id === "ch-1" ? "林晚" : ""),
  location: (id) => (id === "lo-1" ? "暗夜酒吧" : ""),
  episode: (id) => (id === "ep-1" ? "EP01 沉默酒吧" : ""),
  scene: () => "",
  shot: () => "",
};

test("分组全部来自 asset.links，不新建第二份归属关系", () => {
  const m = assetTreeModel(ROWS, NAMES);
  assert.deepEqual(m.groups.map((g) => g.key), ["characterId", "locationId", "episodeId"]);
  const byKey = Object.fromEntries(m.groups.map((g) => [g.key, g.nodes]));
  assert.deepEqual(byKey.characterId, [{ id: "ch-1", n: 2, label: "林晚" }]);
  assert.deepEqual(byKey.locationId, [{ id: "lo-1", n: 1, label: "暗夜酒吧" }]);
  assert.deepEqual(byKey.episodeId, [{ id: "ep-1", n: 2, label: "EP01 沉默酒吧" }]);
  // every count is exactly the number of rows DECLARING that link — no inference
  for (const g of m.groups) {
    for (const nd of g.nodes) {
      assert.equal(nd.n, ROWS.filter((r) => r.links[g.key] === nd.id).length, `${g.key}:${nd.id}`);
    }
  }
});

test("归属只认三种键；shotId / sceneId 不构成分组，也不让素材消失", () => {
  const m = assetTreeModel(ROWS, NAMES);
  // a5 is linked to a shot only, a6 to nothing — both belong to 未归属
  assert.equal(m.orphans, 2);
  assert.equal(m.total, ROWS.length);
  // …and the whole library is still reachable from the tree's own total
  const grouped = new Set();
  for (const r of ROWS) {
    if (r.links.characterId || r.links.locationId || r.links.episodeId) grouped.add(r.assetId);
  }
  assert.equal(grouped.size + m.orphans, m.total);
});

test("「没有归属的素材」是一个分组，不是一个缺口", () => {
  const html = renderAssetTree(assetTreeModel(ROWS, NAMES), {});
  assert.match(html, /未归属/);
  assert.match(html, /data-al-tree="unlinked"/);
  assert.match(html, /没有归属的素材/);
  // …and it disappears only when there really is none
  const allLinked = ROWS.filter((r) => r.links.characterId || r.links.locationId || r.links.episodeId);
  const m2 = assetTreeModel(allLinked, NAMES);
  assert.equal(m2.orphans, 0);
  assert.ok(!renderAssetTree(m2, {}).includes("data-al-tree=\"unlinked\""));
});

test("没有名字的对象用 id 显示，不显示空行", () => {
  const rows = [{ assetId: "x", name: "x", links: link({ characterId: "ch-unknown" }) }];
  const m = assetTreeModel(rows, NAMES);
  assert.equal(m.groups[0].nodes[0].label, "ch-unknown");
  assert.match(renderAssetTree(m, {}), /ch-unknown/);
});

test("空库如实说空，不画一棵没有节点的树", () => {
  const html = renderAssetTree(assetTreeModel([], NAMES), {});
  assert.match(html, /还没有登记任何资产/);
  assert.ok(!html.includes("data-al-tree=\"all\""));
});

test("高亮读自当前筛选，树和列表不会各说各的", () => {
  assert.deepEqual(activeTreeNode({ characterId: "ch-1" }), { key: "characterId", id: "ch-1" });
  assert.deepEqual(activeTreeNode({ unlinked: true }), { key: "unlinked", id: "1" });
  assert.equal(activeTreeNode({ type: "reference" }), null, "a TYPE chip is not a tree node");
  assert.equal(activeTreeNode({}), null);
  const html = renderAssetTree(assetTreeModel(ROWS, NAMES), { characterId: "ch-1" });
  assert.match(html, /class="st-navitem st-subitem on" data-al-tree="characterId" data-al-tree-id="ch-1"/);
});

test("树的归属筛选与页面 chips 的类型筛选各管各的，互不清除", () => {
  const assets = ROWS.map((r) => ({ ...r, kind: "character-reference", tags: [], current: true }));
  const usage = new Map();
  const base = { assets, usage, names: NAMES };
  // ownership narrows …
  const byChar = libraryModel({ ...base, filters: { type: "all", variant: "all", characterId: "ch-1" } });
  assert.deepEqual(byChar.rows.map((r) => r.assetId), ["a1", "a2"]);
  // … and 「没有归属」 is a real filter, not a rendering trick
  const orphan = libraryModel({ ...base, filters: { type: "all", variant: "all", unlinked: true } });
  assert.deepEqual(orphan.rows.map((r) => r.assetId), ["a5", "a6"]);
  // … and the two compose rather than replace one another
  const both = libraryModel({
    ...base, filters: { type: "reference", variant: "all", characterId: "ch-1" },
  });
  assert.deepEqual(both.rows.map((r) => r.assetId), ["a1", "a2"]);
});
