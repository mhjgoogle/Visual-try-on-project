// 生成意图按 (媒体种类, 镜头) 存 —— TASK-103 批次 D（TASK-087 §5.2）。
//
// 手工生成路线的中间一步发生在本应用之外（复制 Prompt → 外部模型 → 导回来），
// 所以「这个文件对应刚才那条 Prompt」全靠一条暂存意图接住。它就是那条媒体的
// 溯源。
//
// 旧形状 `ui.genIntent[kind]` **一种媒体只有一格**。三个消费方都会比对
// `intent.shotId`，所以不会张冠李戴 —— 但会**静默丢失**，而丢了之后界面什么都
// 不说，落地的媒体溯源为空。下面第一条就是那个场景。
import test from "node:test";
import assert from "node:assert/strict";

import {
  intentKey,
  setIntent,
  getIntent,
  consumeIntent,
} from "../src/ui/genintent.js";

const INTENT = (shotId, entry = "manual") => ({ shotId, prompt: "p", entry });

test("两镜同类的意图并存 —— 这正是旧形状会静默丢掉的那一条", () => {
  // 给 A 镜复制图片 Prompt → 切到 B 镜再复制一次 → 回到 A 镜导入。
  // 旧形状此时 A 的意图已被 B 覆盖，那张图落地时溯源为空且无人报错。
  const ui = {};
  setIntent(ui, "image", "shot-a", INTENT("shot-a"));
  setIntent(ui, "image", "shot-b", INTENT("shot-b"));
  assert.equal(getIntent(ui, "image", "shot-a").shotId, "shot-a");
  assert.equal(getIntent(ui, "image", "shot-b").shotId, "shot-b");
});

test("同一镜的图片与视频互不覆盖", () => {
  const ui = {};
  setIntent(ui, "image", "shot-a", INTENT("shot-a", "chatgpt-manual"));
  setIntent(ui, "video", "shot-a", INTENT("shot-a", "manual"));
  assert.equal(getIntent(ui, "image", "shot-a").entry, "chatgpt-manual");
  assert.equal(getIntent(ui, "video", "shot-a").entry, "manual");
});

test("没记过就是 null —— 不会捡到别的镜头的意图", () => {
  const ui = {};
  setIntent(ui, "image", "shot-a", INTENT("shot-a"));
  assert.equal(getIntent(ui, "image", "shot-b"), null);
  assert.equal(getIntent(ui, "video", "shot-a"), null);
});

test("身份不合法时什么都不存 —— 孤儿意图比丢掉更糟", () => {
  // 存进一个 `null` 键会让它变成谁都可能捡走的一条意图，那是把「丢失溯源」
  // 换成了「错误溯源」，后者更难发现。
  const ui = {};
  assert.equal(setIntent(ui, "image", "", INTENT("")), null);
  assert.equal(setIntent(ui, "", "shot-a", INTENT("shot-a")), null);
  assert.equal(setIntent(ui, "image", undefined, {}), null);
  assert.deepEqual(ui.genIntent, undefined);
  assert.equal(intentKey("image", ""), null);
  assert.equal(intentKey("", "shot-a"), null);
});

test("用掉之后就没了", () => {
  const ui = {};
  const it = INTENT("shot-a");
  setIntent(ui, "image", "shot-a", it);
  assert.equal(consumeIntent(ui, "image", "shot-a", it), true);
  assert.equal(getIntent(ui, "image", "shot-a"), null);
});

test("上传在飞时新写的意图不会被上一次导入顺手删掉", () => {
  // 导入是异步的。按身份删会把「下一次导入要用的那条」一起删掉，
  // 于是下一张图的溯源为空 —— 所以比的是对象本身，不是键。
  const ui = {};
  const older = INTENT("shot-a", "manual");
  setIntent(ui, "image", "shot-a", older);
  const newer = INTENT("shot-a", "chatgpt-manual");
  setIntent(ui, "image", "shot-a", newer); // 上传途中又复制了一次
  assert.equal(consumeIntent(ui, "image", "shot-a", older), false);
  assert.equal(getIntent(ui, "image", "shot-a"), newer);
});

test("消费一条不存在的意图不会炸，也不会误删", () => {
  const ui = {};
  assert.equal(consumeIntent(ui, "image", "shot-a", INTENT("shot-a")), false);
  assert.equal(consumeIntent(ui, "image", "shot-a", null), false);
  assert.equal(consumeIntent(null, "image", "shot-a", INTENT("shot-a")), false);
});
