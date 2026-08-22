// 剧本拆解的「疑似已有参考」是**线索**，不是绑定（TASK-094 批次 E / TASK-090 §2.2）。
//
// 产品负责人要的是「AI 根据现在的剧本和已经上传的资产来梳理」。给了资产之后，
// 能力可以说「这个人我看到已经有参考图了」——而界面必须**对着真实资产库核一遍**再显示：
// 一个模型编出来的资产键不得看起来像一张真的素材。
import test from "node:test";
import assert from "node:assert/strict";

import * as bd from "../src/workflow/breakdown.js";
import { settingsModel, renderBreakdownPanel, imageAssetOptions } from "../src/ui/workspaces.js";
import * as pd from "../src/workflow/proddoc.js";

const UPLOADS = {
  "ref-lin-zhao": {
    current: 2,
    history: [
      { assetId: "a1", version: 1, url: "blob:1" },
      { assetId: "a2", version: 2, url: "blob:2" },
    ],
  },
};

function panel(cards, prod = pd.createProduction(null)) {
  const m = settingsModel({ production: prod, assetUploads: UPLOADS });
  return renderBreakdownPanel(
    {
      breakdown: { state: () => ({ status: "ready", cards, error: null, source: "claude", stale: false }) },
      isConnected: () => true,
    },
    m,
  );
}

test("parseBreakdown keeps the hint, and drops a malformed one", () => {
  const parsed = bd.parseBreakdown({
    characters: [
      { name: "林照", existingAssetKey: "ref-lin-zhao" },
      { name: "许渡", existingAssetKey: { $ref: "evil" } },
      { name: "叁" },
    ],
    locations: [{ name: "断面前", existingAssetKey: "ref-duan-mian" }],
  });
  assert.equal(parsed.characters[0].existingAssetKey, "ref-lin-zhao");
  assert.equal(parsed.characters[1].existingAssetKey, "", "非字符串不得进文档");
  assert.equal(parsed.characters[2].existingAssetKey, "");
  assert.equal(parsed.locations[0].existingAssetKey, "ref-duan-mian");
});

test("the registry key travels with each asset option, so a hint can be checked", () => {
  const opts = imageAssetOptions(UPLOADS);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].key, "ref-lin-zhao");
  assert.equal(opts[0].assetId, "a1", "既有读者取的 assetId / label / url 不变");
});

test("a hint resolves to the version the slot SELECTS, not to the oldest one", () => {
  // codex review, 批次 E round 1 (non-blocking): one hint entry per HISTORY version
  // made the card's lookup return v1 for a slot whose current version is v2, so the
  // creator would have verified the AI's hint against an obsolete image.
  const m = settingsModel({ production: pd.createProduction(null), assetUploads: UPLOADS });
  assert.deepEqual(m.assetHints.map((h) => h.key), ["ref-lin-zhao"], "一个槽位一条");
  assert.equal(m.assetHints[0].name, "ref-lin-zhao v2");
  assert.equal(m.assetHints[0].current, true);

  // …and a corrupt `current` pointer falls back to the highest version seen, the
  // rule `assetreg.listReferences` already documents
  const corrupt = settingsModel({
    production: pd.createProduction(null),
    assetUploads: {
      "ref-x": {
        current: 99,
        history: [
          { assetId: "b1", version: 1, url: "blob:1" },
          { assetId: "b2", version: 2, url: "blob:2" },
        ],
      },
    },
  });
  assert.equal(corrupt.assetHints[0].name, "ref-x v2");
});

test("the card shows the CURRENT version of the hinted slot", () => {
  const html = panel([
    { id: "bp-1", kind: "new-character", proposal: bd.parseBreakdown({
      characters: [{ name: "林照", existingAssetKey: "ref-lin-zhao" }], locations: [],
    }).characters[0] },
  ]);
  assert.ok(html.includes("ref-lin-zhao v2"));
  assert.ok(!html.includes("ref-lin-zhao v1"), "不要指着一张过时的图让创作者去核对");
});

test("a hint that RESOLVES is shown as something to confirm — never auto-bound", () => {
  const html = panel([
    { id: "bp-1", kind: "new-character", proposal: bd.parseBreakdown({
      characters: [{ name: "林照", existingAssetKey: "ref-lin-zhao" }], locations: [],
    }).characters[0] },
  ]);
  assert.ok(html.includes("疑似已有参考"));
  assert.ok(html.includes("ref-lin-zhao v2"));
  assert.ok(html.includes("待你确认"));
  // …and nothing in this card binds an asset: the actions stay 添加 / 并入 / 忽略
  assert.ok(!html.includes("data-bd-bind"));
});

test("a hint pointing at NOTHING says so — it must not read as a real asset", () => {
  const html = panel([
    { id: "bp-1", kind: "new-character", proposal: bd.parseBreakdown({
      characters: [{ name: "林照", existingAssetKey: "ref-invented-by-the-model" }], locations: [],
    }).characters[0] },
  ]);
  assert.ok(html.includes("指向了不存在的素材"));
  assert.ok(!html.includes("ref-invented-by-the-model"), "编出来的键不该被当成素材名印出来");
});

test("no hint means no row at all", () => {
  const html = panel([
    { id: "bp-1", kind: "new-character", proposal: bd.parseBreakdown({
      characters: [{ name: "林照" }], locations: [],
    }).characters[0] },
  ]);
  assert.ok(!html.includes("疑似已有参考"));
});
