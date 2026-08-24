// TASK-087 §3.5.2 —— 「这一镜需要什么音效」现在有地方写了。
//
// 以前 `soundNeed(shot, "sfx")` 无条件 `return null`：镜头上根本没有这个字段，
// 于是逐镜质检对音效**永远只能答无法判定**。分镜表的「音效」列显示的是
// `sfxCount`（已有几条片段）—— 那是答案，不是需求。
//
// 口径与 `dialogue` **完全一致**，这是本条改动的全部设计：
//   写了      → true（要做）
//   空着      → null（**没人写下来**，不是「不需要」）
//   不需要    → 标为跳过，那是一条会被存下来的人的决定
import test from "node:test";
import assert from "node:assert/strict";

import { NEED_ACTIONS, NEED_UNKNOWN, soundNeed } from "../src/workflow/poststatus.js";
import { ADDITIVE_SHOT_FIELDS } from "../src/ui/shoteditor.js";
import { COLUMNS, EDITABLE_FIELDS, applyTableEdits } from "../src/ui/shottable.js";

test("§3.5.2: 写了音效需求 = 这一步要做", () => {
  assert.equal(soundNeed({ sfxNote: "雨声、远处雷" }, "sfx"), true);
});

test("§3.5.2: 空着是 null（不知道），**永远不是 false**（不需要）", () => {
  // `soundNeed` 没有资格代替创作者说「这一镜不需要音效」——
  // 那个决定的表达方式是标为跳过，会被存下来。
  for (const shot of [{}, { sfxNote: "" }, { sfxNote: "   " }, { sfxNote: 42 }, null]) {
    assert.equal(soundNeed(shot, "sfx"), null, JSON.stringify(shot));
  }
});

test("§3.5.2: 音效与台词是同一套口径 —— 不是两条各写各的规则", () => {
  // 两边都必须是「写了→true / 空→null」。哪天有人把其中一条改成返回 false，
  // 这条会红，并指出两者已经开始各说各话。
  assert.equal(soundNeed({ dialogue: "你是谁？" }, "voice"), soundNeed({ sfxNote: "雨声" }, "sfx"));
  assert.equal(soundNeed({ dialogue: "" }, "voice"), soundNeed({ sfxNote: "" }, "sfx"));
});

test("§3.5.2: 「不知道」时给出的话，说的是**现在真的存在**的那个地方", () => {
  // 旧文案是「没有地方写下这一镜需要什么音效」—— 本次改动之后那是句假话。
  // 一条把创作者指向不存在的地方的提示，比没有提示更糟。
  assert.match(NEED_UNKNOWN.sfx, /音效需求/);
  assert.equal(/没有地方/.test(NEED_UNKNOWN.sfx), false);
  assert.match(NEED_ACTIONS.sfx, /音效需求/);
  // 那个名字必须真的是表上的一列
  assert.ok(COLUMNS.some((c) => c.label === "音效需求"), "提示指向的列不存在");
});

test("§3.5.2: 「要什么」与「有什么」是并排的两列，不是一列", () => {
  const need = COLUMNS.find((c) => c.key === "sfxNote");
  const have = COLUMNS.find((c) => c.key === "sfx");
  assert.ok(need && have, "两列都要在");
  assert.equal(need.edit, "sfxNote", "需求列必须可写");
  assert.equal(have.edit, undefined, "片段数是派生的，这里只读（归音频工作区所有）");
});

test("§3.5.2: 它是**加法字段** —— 存得下来，且不碰旧数据", () => {
  // `ADDITIVE_SHOT_FIELDS` 的注释：「A field is only additive if it survives
  // EVERY save path」。这正是 TASK-055 §5 那条缺陷（保存镜头静默丢失景别/角度/情绪）
  // 留下的规矩；漏登记时既有守卫会红，这条把它钉在本字段上。
  assert.ok(EDITABLE_FIELDS.includes("sfxNote"));
  assert.ok(ADDITIVE_SHOT_FIELDS.includes("sfxNote"));

  // 真的走一遍保存：写进去、留得住、清空要删键（而不是留一个空串）
  const shots = [{ shotId: "s1", description: "雨夜街头", unknownField: "保住" }];
  const saved = applyTableEdits(shots, { buffer: { s1: { sfxNote: "雨声、远处雷" } } });
  assert.equal(saved[0].sfxNote, "雨声、远处雷");
  assert.equal(saved[0].unknownField, "保住", "加法字段不该动别人的字段");
  assert.equal(soundNeed(saved[0], "sfx"), true);

  const cleared = applyTableEdits(saved, { buffer: { s1: { sfxNote: "  " } } });
  assert.equal("sfxNote" in cleared[0], false, "清空要删键，不是存一个空串");
  assert.equal(soundNeed(cleared[0], "sfx"), null, "清空后回到「不知道」");
});
