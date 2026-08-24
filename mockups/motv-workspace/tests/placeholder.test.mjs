// TASK-087 §4.4 —— `nonEmpty` 现在也挡占位词（JS 编译器这一侧）。
//
// 「非空」不等于「有信息」：模型写「无」「常规」时旧校验通过，内容进入 canon，
// 界面上显示成一个看起来有人填过的答案。
//
// Python 侧与两份名单的一致性由 `tests/contract/test_placeholder_words_task087.py`
// 守（ADR-0067 双编译器合同）；这里守的是**本侧的判定行为**。
import test from "node:test";
import assert from "node:assert/strict";

import { validateOutput } from "../src/workflow/skills.js";

// `validateOutput` 收的是一个 skill，不是裸 schema —— 包一层最小的假件，
// 走的仍然是生产的那条 `typeError` 路径。
const asSkill = (schema) => ({ outputSchema: schema });
const NEED = asSkill({ type: "string", nonEmpty: true });
const OPTIONAL = asSkill({ type: "string" });

test("§4.4: 只写占位词 = 没填", () => {
  for (const word of ["无", "常规", "N/A", "  待定  ", "TBD", "-", "none"]) {
    const err = validateOutput(NEED, word);
    assert.ok(err, `占位词「${word}」被接受了`);
    assert.match(String(err), /占位词/);
  }
});

test("§4.4: 判据是整串相等，**不是子串包含**", () => {
  // 这条才是最该守住的：子串匹配会把真答案一起拒掉，
  // 那比放进无信息的内容更糟 —— 前者拒真内容，后者只是接受空话。
  for (const text of [
    "无人机俯拍，从屋顶掠过",
    "常规打光之外，加一盏侧逆光",
    "没有对白，全靠环境声",
    "略带沙哑的女声",
    "标准镜头 50mm，f/1.8",
    "暂无法确认的道具需要美术二次确认",
  ]) {
    assert.equal(validateOutput(NEED, text), null, `真答案「${text}」被拒了`);
  }
});

test("§4.4: 空串仍然报「不能为空」，不是「占位词」", () => {
  // 两种情况把创作者送到不同的地方：一个是没生成出来，一个是生成了但没内容。
  const err = String(validateOutput(NEED, "   "));
  assert.match(err, /不能为空/);
  assert.equal(/占位词/.test(err), false);
});

test("§4.4: 没要求 nonEmpty 的字段不受影响", () => {
  // 可选字段填「无」可能正是创作者的本意（「这一镜没有音效」）。
  assert.equal(validateOutput(OPTIONAL, "无"), null);
});

test("§4.4: 不可见字符包着的占位词，仍然是占位词（codex 复审非阻塞）", () => {
  // 起因是一处真的跨语言分歧：JS `trim()` 剥 U+FEFF，Python `strip()` 不剥，
  // 于是同一份输出两个编译器给出相反判定。两边现在剥同一份显式字符集。
  for (const s of ["﻿无﻿", "​无", "﻿ 无 ﻿", "⁠无‍"]) {
    const err = validateOutput(NEED, s);
    assert.ok(err, `${JSON.stringify(s)} 被接受了`);
    assert.match(String(err), /占位词/);
  }
});

test("§4.4: 只有不可见字符 = 空，不是占位词", () => {
  const err = String(validateOutput(NEED, "﻿ ​"));
  assert.match(err, /不能为空/);
  assert.equal(/占位词/.test(err), false);
});
