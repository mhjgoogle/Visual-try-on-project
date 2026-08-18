// TASK-097 批次 4B —— 持久化侧的两条 fail-closed 守卫，**两个方向都钉住**（§2.5d）。
//
// 为什么这两条值得一道门：镜头列表镜像按 `counts.isDeleted` 过滤，所以一个**形状
// 不对的 `deleted`** 会让这一镜要么在界面上彻底消失、要么反过来仍然算进
// 「60 个镜头已就绪」—— 两种都没有任何一处会喊。`timeOfDay` 同理：存 `""` 与不存
// 这个键会在下游分叉成「清空过」与「从没写过」两个形状。
//
// §2.6.3：每条守卫先证明它真的会拒绝，再证明它不会拒绝正常文档。

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateCanvasDoc, CANVAS_SCHEMA_VERSION, MIGRATIONS } from "../src/services/canvasschema.js";

/**
 * 文档由**迁移链跑出来**，不是手写的（§2.6.3 第 2 条：手写 fixture 会发明字段，
 * 于是守卫在校验一个产品里不存在的世界）。迁移链产出的形状就是应用真正写下的形状。
 */
const base = () => {
  const doc = { v: 1, nodes: [] };
  for (let from = 1; from < CANVAS_SCHEMA_VERSION; from++) MIGRATIONS[from](doc);
  doc.v = CANVAS_SCHEMA_VERSION;
  // 一个带镜头草稿的 scriptgen 节点 —— 标记就住在这里
  doc.nodes.push({
    type: "scriptgen",
    versions: [{ id: "sdv-1", v: 1, draft: true, raw: [{ shotId: "shot-a" }],
      sourceScriptVersionId: null, basedOnDraftId: null }],
    cur: 1,
  });
  return doc;
};

const ok = (doc) => assert.equal(validateCanvasDoc(doc), null, `本该通过却被拒：${validateCanvasDoc(doc)}`);
const rejects = (doc, re) => {
  const why = validateCanvasDoc(doc);
  assert.ok(typeof why === "string" && why, "本该拒绝却通过了");
  assert.match(why, re);
};

test("软删除标记：**缺席合法**，出现就必须长得对", () => {
  ok(base()); // 没有标记的正常文档
  const withMark = base();
  withMark.nodes[0].versions[0].raw[0].deleted = { at: "2026-08-19T00:00:00Z" };
  ok(withMark);
  const withBy = base();
  withBy.nodes[0].versions[0].raw[0].deleted = { at: "t", by: "me" };
  ok(withBy);
});

test("软删除标记：形状不对一律拒绝（它真的会拒绝）", () => {
  const notObj = base();
  notObj.nodes[0].versions[0].raw[0].deleted = true;
  rejects(notObj, /deleted marker is not an object/);

  const noAt = base();
  noAt.nodes[0].versions[0].raw[0].deleted = {};
  rejects(noAt, /no timestamp/);

  const blankAt = base();
  blankAt.nodes[0].versions[0].raw[0].deleted = { at: "   " };
  rejects(blankAt, /no timestamp/);

  const extra = base();
  extra.nodes[0].versions[0].raw[0].deleted = { at: "t", reason: "手滑" };
  rejects(extra, /unknown field "reason"/);
});

test("`timeOfDay`：**加法字段，缺席合法**；出现必须是非空字符串", () => {
  // 迁移链已经建出了 production 文档（v6 起）；这里**只往它里面放一个场景**，
  // 不重写整份 —— 重写就又是一个手写 fixture。
  const prod = (scene) => {
    const d = base();
    d.production.episodes[0].scenes = [scene];
    return d;
  };
  const scene = (extra = {}) => ({
    sceneId: "sc-1", title: "便利店外", shotIds: [],
    characterRefs: [], locationRef: null, ambienceAssetId: null, bgmAssetId: null,
    ...extra,
  });
  ok(prod(scene()));                          // 老数据没有这个字段
  ok(prod(scene({ timeOfDay: "夜" })));
  ok(prod(scene({ timeOfDay: "雨夜" })));      // 自由文本，不是闭集
  rejects(prod(scene({ timeOfDay: "" })), /timeOfDay must be a non-empty string/);
  rejects(prod(scene({ timeOfDay: "  " })), /timeOfDay must be a non-empty string/);
  rejects(prod(scene({ timeOfDay: 3 })), /timeOfDay must be a non-empty string/);
});
