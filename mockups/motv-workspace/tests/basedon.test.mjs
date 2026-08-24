// TASK-087 §4.7 —— `basedOn` 必须指向一个**真实的更早版本**，不只是「是个整数」。
//
// 之前三处都写 `Number.isInteger(x.basedOn) ? x.basedOn : null`，于是 `0`、
// 负数、指向自己、指向未来版本全都能存进文档 ——「这一版是从哪一版改出来的」
// 可以是一句假话。
//
// **不阻塞**：身份继承读的是瞬态 `pending.basedOn`，不是这个持久字段，所以
// 畸形值最多让**溯源显示**不对，接不错集。但它是一句会被人读的假话。
import test from "node:test";
import assert from "node:assert/strict";

import { basedOnOrNull } from "../src/workflow/identity.js";
import { createDoc } from "../src/workflow/scriptdoc.js";

test("§4.7: 父版本必须真的在自己之前", () => {
  // v=3 的合法父版本只有 1 和 2
  assert.equal(basedOnOrNull(1, 3), 1);
  assert.equal(basedOnOrNull(2, 3), 2);

  assert.equal(basedOnOrNull(3, 3), null, "指向自己不是溯源");
  assert.equal(basedOnOrNull(4, 3), null, "指向未来版本");
  assert.equal(basedOnOrNull(0, 3), null, "版本号从 1 开始，0 不存在");
  assert.equal(basedOnOrNull(-1, 3), null, "负数");

  // 第一版没有父版本可指 —— 任何值都不合法
  assert.equal(basedOnOrNull(1, 1), null, "v1 的父版本只能是 null");
});

test("§4.7: 非整数一律 null，且**不夹到范围内**", () => {
  for (const bad of [null, undefined, "2", 1.5, NaN, Infinity, true, {}, []]) {
    assert.equal(basedOnOrNull(bad, 3), null, `${String(bad)} 不该被接受`);
  }
  // 越界回 null，不回 v-1：夹成 v-1 恰恰是 identity.js 那条注释禁的事
  // ——凭空发明一条溯源链。
  assert.equal(basedOnOrNull(99, 3), null);
  assert.notEqual(basedOnOrNull(99, 3), 2);
});

test("§4.7: 水合时真的用上了 —— 一份被篡改的存档带不出假溯源", () => {
  const doc = createDoc({
    versions: [
      { id: "sv-1", v: 1, content: "一稿", origin: "generated", basedOn: 7 },
      { id: "sv-2", v: 2, content: "二稿", origin: "revision", basedOn: 1 },
      { id: "sv-3", v: 3, content: "三稿", origin: "revision", basedOn: 3 },
      { id: "sv-4", v: 4, content: "四稿", origin: "revision", basedOn: 0 },
    ],
  });
  const chain = doc.versions.map((x) => [x.v, x.basedOn]);
  assert.deepEqual(chain, [
    [1, null], // 第一版指向 7：不存在，也不可能在自己之前
    [2, 1], // 合法，保留
    [3, null], // 指向自己
    [4, null], // 0 不是版本号
  ]);
});
