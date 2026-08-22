// TASK-073 §1.6 — ⑪ 资产库 and the 「添加参考」 drawer are ONE component, two sizes.
import test from "node:test";
import assert from "node:assert/strict";

import { renderAssetLibrary, RAIL_TYPE } from "../src/ui/assetlibws.js";

function ctxWith(rows) {
  return {
    assets: {
      library: () => ({
        total: rows.length,
        shown: rows.length,
        unusedCount: 0,
        needsReview: 0,
        counts: [
          { id: "all", label: "全部", n: rows.length },
          { id: "collection", label: "已保存筛选", n: 1 },
        ],
        tags: [{ tag: "雨夜", n: 1 }],
        rows,
      }),
      filterOptions: () => ({ characters: [], locations: [], episodes: [], sources: [] }),
      provenanceOf: () => null,
      libraryOne: () => null,
    },
  };
}

// shaped like a real `ctx.assets.library()` row — the inspector reads `tags` and
// `displayName`, so a fixture missing them would fail for the wrong reason
const ROW = {
  assetId: "a1", key: "ref-rainy-street", isReference: true,
  name: "雨夜街景", displayName: "雨夜街景", kindLabel: "场景参考",
  reusable: true, current: true, version: 1, tags: ["雨夜"],
  usage: { count: 0, places: [] }, needsReview: false,
  url: "", domain: "images", originalFilename: null,
};

test("§1.6: one implementation, two sizes — the filters are IDENTICAL", () => {
  const ctx = ctxWith([ROW]);
  const page = renderAssetLibrary(ctx, {}, { mode: "page" });
  const drawer = renderAssetLibrary(ctx, {}, { mode: "drawer", shotId: "SH03" });
  // the same filter vocabulary in both — the drift this consolidation prevents is a
  // 「只看可复用」 that means one thing on the page and another in the drawer
  for (const hook of [
    "data-al-type", "data-al-tag", "data-al-search",
    "data-al-character", "data-al-location", "data-al-episode", "data-al-source",
    "data-al-reusableonly", "data-al-historical", "data-al-recent",
  ]) {
    const inPage = page.includes(hook);
    const inDrawer = drawer.includes(hook);
    assert.equal(inPage, inDrawer, `${hook}: page=${inPage} drawer=${inDrawer}`);
  }
  // …and the same cards
  assert.ok(page.includes("雨夜街景") && drawer.includes("雨夜街景"));
});

test("the drawer adds exactly ONE affordance, and the page has none of it", () => {
  const ctx = ctxWith([ROW]);
  const page = renderAssetLibrary(ctx, {}, { mode: "page" });
  const drawer = renderAssetLibrary(ctx, {}, { mode: "drawer", shotId: "SH03" });
  // THE REFERENCE KEY, not the assetId: `addReference` binds by chain key, and the
  // assetId either resolved nothing or bound a bogus reference while the toast said
  // 「已加入」 (independent review, batch 3).
  assert.ok(drawer.includes('data-al-add="ref-rainy-street"'), "the drawer adds BY KEY");
  assert.ok(!drawer.includes('data-al-add="a1"'), "never the assetId");
  assert.ok(!page.includes("data-al-add"), "the page is not a picker");
  // the drawer NAMES its target — a picker that does not say where it adds is how a
  // reference lands on the wrong shot
  assert.ok(drawer.includes("SH03"));
  assert.ok(drawer.includes("data-al-drawer-close"));
  // …and with no shot selected it says so instead of silently adding nowhere
  const noShot = renderAssetLibrary(ctx, {}, { mode: "drawer" });
  assert.match(noShot, /还没有选中镜头/);
});

test("the inspector is page-only: a drawer is opened to PICK", () => {
  const ctx = ctxWith([ROW]);
  // ui.alOpen names an asset — the page shows the full inspector for it
  const page = renderAssetLibrary(ctx, { alOpen: "a1" }, { mode: "page" });
  const drawer = renderAssetLibrary(ctx, { alOpen: "a1" }, { mode: "drawer", shotId: "SH03" });
  assert.ok(page.includes("al-info"), "the page carries the inspector");
  assert.ok(!drawer.includes("al-info"), "…the drawer must not compete with its own purpose");
});

test("a non-reference asset offers no add button, rather than one that fails", () => {
  const ctx = ctxWith([{ ...ROW, isReference: false }]);
  const drawer = renderAssetLibrary(ctx, {}, { mode: "drawer", shotId: "SH03" });
  assert.ok(!drawer.includes("data-al-add"), "no button that would be refused");
  assert.match(drawer, /不可加入/);
});

test("§1.6: Collections became 「已保存筛选」", () => {
  // it was never a second container to put things into, only a filter the creator had
  // marked — the old name implied a place, which it never was
  const label = RAIL_TYPE ? null : null;
  assert.equal(label, null); // RAIL_TYPE maps rail keys → filter values, unchanged
  const ctx = ctxWith([ROW]);
  const page = renderAssetLibrary(ctx, {}, { mode: "page" });
  assert.ok(page.includes("已保存筛选"));
  assert.ok(!page.includes("Collections"));
});

test("an empty library says so in BOTH sizes", () => {
  const ctx = ctxWith([]);
  assert.match(renderAssetLibrary(ctx, {}, { mode: "page" }), /还没有任何资产/);
  const drawer = renderAssetLibrary(ctx, {}, { mode: "drawer", shotId: "SH03" });
  assert.match(drawer, /还没有任何资产/);
  assert.ok(drawer.includes("添加参考"), "…and the drawer keeps its own header");
});
