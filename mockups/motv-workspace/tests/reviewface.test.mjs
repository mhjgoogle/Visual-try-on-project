// 审阅面 primitives (TASK-094 §1.2 / 批次 0).
//
// The rule under test is the one the product owner stated: what AI wrote is
// shown and editable; what it did NOT write is stated in one line and never laid
// out as a grid of boxes waiting to be filled in by hand.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  written,
  countNote,
  countChip,
  absentRow,
  reviewText,
  reviewList,
  notRunYet,
} from "../src/ui/reviewface.js";

test("written(): the four ways 「nothing was produced」 arrives all read as absent", () => {
  assert.equal(written(null), false);
  assert.equal(written(undefined), false);
  assert.equal(written(""), false);
  assert.equal(written("   \n "), false);
  assert.equal(written([]), false);
  assert.equal(written(["", "  "]), false);
  assert.equal(written({}), false);
  assert.equal(written({ a: "", b: null }), false);

  assert.equal(written("林照"), true);
  assert.equal(written(["", "一条"]), true);
  assert.equal(written({ a: "", b: "有" }), true);
  assert.equal(written(0), true, "a real number is content, not absence");
});

test("a range is a HINT: too few / too many is flagged, never blocked", () => {
  assert.equal(countNote(4, 3, 6), null, "in range → no flag at all");
  assert.equal(countNote(3, 3, 6), null, "the boundary is in range");
  assert.equal(countNote(6, 3, 6), null);

  const short = countNote(2, 3, 6);
  assert.equal(short.state, "short");
  assert.match(short.text, /2 条/);
  assert.match(short.text, /3～6/);
  assert.match(short.title, /不是限制/, "the flag says so itself");

  const over = countNote(7, 3, 6);
  assert.equal(over.state, "over");

  // …and the chip never carries a disabled control or a refusal
  const chip = countChip(2, 3, 6);
  assert.match(chip, /data-rf-count="short"/);
  assert.doesNotMatch(chip, /disabled/);
  assert.equal(countChip(4, 3, 6), "", "in range renders nothing");
});

test("an ABSENT text facet is ONE line, not an input", () => {
  const html = reviewText("情绪曲线", "");
  assert.match(html, /rf-absent/);
  assert.match(html, /AI 没有写这一项/);
  assert.doesNotMatch(html, /<textarea/, "no box for something nobody wrote");
  assert.doesNotMatch(html, /<input/);
});

test("an absent facet offers hand entry ONLY when the caller has somewhere for it to go", () => {
  const bare = absentRow("情绪曲线");
  assert.doesNotMatch(bare, /<button/, "no invented disabled control");

  const withAdd = absentRow("情绪曲线", { addAttrs: 'data-rf-add="emotionArc"' });
  assert.match(withAdd, /data-rf-add="emotionArc"/);

  // the reveal hook is NOT the field's write hook — binding a click to a text
  // writer is how the two get confused
  const revealed = reviewText("情绪曲线", "", {
    attrs: 'data-plan-edit="ep1" data-field="emotionArc"',
    addAttrs: 'data-rf-add="ep1:emotionArc"',
  });
  assert.match(revealed, /data-rf-add="ep1:emotionArc"/);
  assert.doesNotMatch(revealed, /data-plan-edit/);
});

test("a WRITTEN text facet is editable and carries the caller's own hooks", () => {
  const html = reviewText("本集核心目标", "确立世界规则", {
    attrs: 'data-plan-edit="ep-1" data-field="coreGoal"',
  });
  assert.match(html, /data-plan-edit="ep-1"/);
  assert.match(html, /data-field="coreGoal"/);
  assert.match(html, /value="确立世界规则"/);
  assert.doesNotMatch(html, /rf-absent/);
});

test("`force` renders the control for a facet that has to be typeable anyway", () => {
  const html = reviewText("本集标题", "", { force: true, attrs: 'data-x="1"' });
  assert.match(html, /<input/);
  assert.doesNotMatch(html, /rf-absent/);
});

test("a list renders ONE row per produced item — never N blank rows", () => {
  const html = reviewList("主要剧情", ["一", "二"], {
    rowAttrs: (i) => `data-ke="${i}"`,
    addAttrs: 'data-rf-add="keyEvents"',
    min: 3,
    max: 6,
  });
  assert.equal((html.match(/rf-row/g) || []).length, 2, "two items → two rows");
  assert.match(html, /data-ke="0"/);
  assert.match(html, /data-ke="1"/);
  // …plus the flag, because 2 is short of 3–6, and the add is still offered
  assert.match(html, /data-rf-count="short"/);
  assert.match(html, /data-rf-add="keyEvents"/);
});

test("a BLANK entry gets no row, and the rows that remain keep their own index", () => {
  // codex review, batch 0: `written("")` is false, so rendering a blank entry as
  // an editable row rebuilt the empty-input surface this module removes.
  const html = reviewList("主要剧情", ["", "第二条", "  "], {
    rowAttrs: (i) => `data-ke="${i}"`,
    min: 3,
    max: 6,
  });
  assert.equal((html.match(/rf-row/g) || []).length, 1, "one written entry → one row");
  assert.match(html, /data-ke="1"/, "the kept row keeps ITS index, not a renumbered one");
  assert.doesNotMatch(html, /data-ke="0"/);
  assert.doesNotMatch(html, /data-ke="2"/);
  // …and the range hint counts what is on screen, not the blank padding
  assert.match(html, /1 条 · 少于建议的 3～6 条/);
});

test("「＋ 添加一条」 actually produces a row to type in", () => {
  // codex review, batch 0 round 2 (BLOCKING): the blank-row filter swallowed the
  // entry the add action had just appended, so hand entry was impossible.
  const added = reviewList("主要剧情", ["一", ""], {
    rowAttrs: (i) => `data-ke="${i}"`,
    addAttrs: 'data-rf-add="keyEvents"',
    open: [1],
    min: 3,
    max: 6,
  });
  assert.equal((added.match(/rf-row/g) || []).length, 2, "the opened row renders");
  assert.match(added, /data-ke="1"/);
  // …but a blank row the creator opened is not CONTENT: the range hint counts 1
  assert.match(added, /1 条 · 少于建议的 3～6 条/);

  // and without `open` the same document renders only the written entry
  const closed = reviewList("主要剧情", ["一", ""], { rowAttrs: (i) => `data-ke="${i}"` });
  assert.equal((closed.match(/rf-row/g) || []).length, 1);
});

test("an all-blank list with an opened row is a row, not the 「没有写」 line", () => {
  const html = reviewList("信息揭示", [""], { rowAttrs: (i) => `data-r="${i}"`, open: [0] });
  assert.match(html, /rf-row/);
  assert.doesNotMatch(html, /AI 没有写这一项/);
});

test("a one-sided range reads as a range, not as 「1～null」", () => {
  assert.match(countNote(0, 1, null).text, /少于建议的 1 以上 条/);
  assert.doesNotMatch(countNote(0, 1, null).text, /null/);
  assert.match(countNote(9, null, 6).text, /多于建议的 6 以内 条/);
  assert.doesNotMatch(countNote(9, null, 6).text, /null/);
  assert.equal(countNote(4, 1, null), null, "no upper bound → 4 is fine");
  assert.equal(countNote(4, null, 6), null, "no lower bound → 4 is fine");
});

test("an EMPTY list says so — it does not pre-lay-out a row to fill in", () => {
  const html = reviewList("角色推进", [], { rowAttrs: (i) => `data-i="${i}"` });
  assert.doesNotMatch(html, /rf-row/, "this is the 288-cell defect (TASK-088 §1.3)");
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /AI 没有写这一项/);
});

test("「还没有跑过 AI」 is a stated state with exactly one action", () => {
  const html = notRunYet("作品设定还没有梳理过", "AI 会从当前剧本与已上传资产里读出人物与世界规则", {
    runAttrs: 'data-bd-run="1"',
  });
  assert.match(html, /data-rf-notrun/);
  assert.match(html, /data-bd-run="1"/);
  assert.equal((html.match(/<button/g) || []).length, 1, "one thing to do, not a form");
});
