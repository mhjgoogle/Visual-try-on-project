// 发送这条线的**行为**测试（不是源码文本测试）。
//
// WHY THIS FILE EXISTS. 两次真机失败都出在同一类地方，而两次源码断言都是绿的：
//
//   1. `disabled` 写在渲染出的 HTML 里 → 输入框为了不跳光标不重渲染，按钮永远停在
//      「画出来那一刻是空的」（产品负责人：「根本得按不了发送」）。
//   2. `bindAgentSession` 的签名没有解构 `onSend` → `send()` 里 `!onSend` 直接 return，
//      点了什么都不发（产品负责人：「点击发送送不出去」）。
//
// 两个都不是「渲染得对不对」，而是「点了之后到底有没有发生」。所以这里真的调 bind，
// 真的触发 click / keydown，断言 onSend 拿到了那句话。
import test from "node:test";
import assert from "node:assert/strict";

import { bindAgentSession, sessionState } from "../src/ui/agentsession.js";

/** The smallest DOM these handlers touch: the textarea and the two buttons. */
function fakeRoot({ value = "" } = {}) {
  const box = {
    className: "field as-input",
    value,
    selectionStart: value.length,
    oninput: null,
    onkeydown: null,
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    focus() { this.focused = true; },
    setSelectionRange() {},
  };
  const send = {
    dataset: { asSend: "1" },
    onclick: null,
    classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) send.classes.add(name);
        else send.classes.delete(name);
      },
    },
  };
  return {
    box,
    send,
    querySelector: (sel) => {
      if (sel === ".as-input") return box;
      if (sel === "[data-as-send]") return send;
      return null;
    },
    querySelectorAll: () => [],
  };
}

function harness({ value = "" } = {}) {
  const ui = {};
  const st = sessionState(ui);
  st.text = value;
  const sent = [];
  const root = fakeRoot({ value });
  bindAgentSession(root, { toast() {} }, ui, () => {}, {
    onRun: () => {},
    onSend: (text) => sent.push(text),
  });
  return { root, ui, st, sent };
}

test("点「发送」把那句话交出去 —— 这是「点了没反应」那个 bug 的守卫", () => {
  const h = harness({ value: "你能定位现在的页面吗" });
  assert.equal(typeof h.root.send.onclick, "function", "发送按钮没有被绑上处理器");
  h.root.send.onclick();
  assert.deepEqual(h.sent, ["你能定位现在的页面吗"]);
});

test("发出去之后输入框被清空 —— 留着会被再按一次发第二遍", () => {
  const h = harness({ value: "改冷一点" });
  h.root.send.onclick();
  assert.equal(h.st.text, "");
});

test("空白不发", () => {
  const h = harness({ value: "   " });
  h.root.send.onclick();
  assert.deepEqual(h.sent, []);
});

test("Enter 发送，Shift+Enter 不发", () => {
  const h = harness({ value: "" });
  h.root.box.value = "一句话";
  let prevented = 0;
  h.root.box.onkeydown({ key: "Enter", shiftKey: false, preventDefault: () => prevented++ });
  assert.deepEqual(h.sent, ["一句话"]);
  assert.equal(prevented, 1);

  h.root.box.value = "换行不发";
  h.root.box.onkeydown({ key: "Enter", shiftKey: true, preventDefault: () => prevented++ });
  assert.deepEqual(h.sent, ["一句话"], "Shift+Enter 应该只是换行");
});

test("输入法组字中的 Enter 不发 —— 中文选字会把话截半句发出去", () => {
  const h = harness({ value: "" });
  h.root.box.value = "选字中";
  h.root.box.onkeydown({ key: "Enter", isComposing: true, preventDefault: () => {} });
  h.root.box.onkeydown({ key: "Enter", keyCode: 229, preventDefault: () => {} });
  assert.deepEqual(h.sent, []);
});

test("按钮的暗态随输入实时变，不靠重渲染", () => {
  const h = harness({ value: "" });
  assert.ok(h.root.send.classes.has("dim"), "空文本时应该是暗的");
  h.root.box.value = "写了字";
  for (const fn of h.root.box.listeners.input || []) fn();
  assert.ok(!h.root.send.classes.has("dim"), "打了字就该亮起来 —— 这正是卡住过的地方");
});

test("选了能力时，Enter 不抢走能力自己的运行按钮", () => {
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "skill-x";
  st.text = "顺手写的备注";
  const sent = [];
  const root = fakeRoot({ value: "顺手写的备注" });
  bindAgentSession(root, { toast() {} }, ui, () => {}, {
    onRun: () => {},
    onSend: (t) => sent.push(t),
  });
  root.box.onkeydown({ key: "Enter", shiftKey: false, preventDefault: () => {} });
  assert.deepEqual(sent, []);
});
