// 点一个元素写意见 —— 判断那一半（TASK-132 切片 A）。
//
// 这个模块刻意把**判断**做成纯函数，所以这里不需要真 DOM：一个手搭的假节点树
// 就够，而且能造出真浏览器里难复现的形状（点在图标上、没有任何标记、深层嵌套）。
//
// 三条硬规矩各有用例守着，每条都写两个方向：
//   1. 点选不触发页面行为（不只拦 click）；
//   2. CSS 路径只是线索 —— 不带 nth-child，因为重排会让它指向别的元素；
//   3. 退出要干净，而且 stop() 幂等。

import test from "node:test";
import assert from "node:assert/strict";

import {
  targetOf,
  cssPathOf,
  labelOf,
  snapshotOf,
  newAnnotationId,
  breadcrumbOf,
  startPicking,
  handleOf,
} from "../src/ui/elementfeedback.js";

/** 一个够用的假元素。`el()` 从上往下建，自动接好 parentElement。 */
function el(tag, opts = {}, ...kids) {
  const node = {
    tagName: tag.toUpperCase(),
    dataset: opts.data || {},
    className: opts.cls || "",
    textContent: opts.text || "",
    parentElement: null,
    attrs: opts.attrs || {},
    getAttribute: (k) => (opts.attrs || {})[k] ?? null,
    getBoundingClientRect: () => opts.rect || { left: 0, top: 0, width: 0, height: 0 },
  };
  // 只认 `[data-x-y]` 这一种选择器 —— 模块里只用到它。剥掉方括号与 `data-`
  // 前缀之后，比的是 dataset 的短横线写法（`efUi` → `ef-ui`）。
  node.closest = (sel) => {
    const want = sel.replace(/[[\]]/g, "").replace(/^data-/, "");
    let n = node;
    while (n) {
      if (n.dataset && want in dashToCamelKeys(n.dataset)) return n;
      n = n.parentElement;
    }
    return null;
  };
  for (const k of kids) if (k) k.parentElement = node;
  return node;
}
const dashToCamelKeys = (ds) => {
  const out = {};
  for (const k of Object.keys(ds)) out[k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = ds[k];
  return out;
};

/* --- targetOf：他点的是图标，指的是按钮 ------------------------------------ */

test("点在按钮里的图标上，选中的是按钮", () => {
  const btn = el("button", { data: { uiId: "shot-generate" }, text: "生成" });
  const icon = el("span", { text: "✨" });
  icon.parentElement = btn;
  assert.equal(targetOf(icon), btn);
});

test("data-ui-id 优先于「最近的可交互元素」", () => {
  // 渲染方打了标记，就是它在声明「这才是可指认的那个东西」。
  const row = el("div", { data: { uiId: "shot-row" } });
  const btn = el("button", { text: "删除" });
  const icon = el("span", {});
  btn.parentElement = row;
  icon.parentElement = btn;
  assert.equal(targetOf(icon), row, "带标记的祖先赢");
});

test("没有任何标记时退到最近的可交互元素，再退到容器", () => {
  const li = el("li", {});
  const span = el("span", {});
  span.parentElement = li;
  assert.equal(targetOf(span), li);

  const a = el("a", { text: "打开" });
  const inner = el("em", {});
  inner.parentElement = a;
  assert.equal(targetOf(inner), a, "可交互元素优先于容器");
});

test("一路找不到就返回他点的那个，不返回 null", () => {
  // 「他确实点了个东西」是事实；假装没点中比给一个粗一点的定位更糟。
  const lone = el("span", {});
  assert.equal(targetOf(lone), lone);
});

test("往上找有上限，不会顺着长链一路爬到根", () => {
  let node = el("span", {});
  const leaf = node;
  for (let i = 0; i < 40; i += 1) {
    const p = el("div", {});
    node.parentElement = p;
    node = p;
  }
  const top = el("li", { data: { uiId: "way-up" } });
  node.parentElement = top;
  assert.notEqual(targetOf(leaf), top, "40 层之外的标记不该被认领");
});

/* --- cssPathOf：线索，不是身份 --------------------------------------------- */

test("CSS 线索不带 nth-child —— 重排会让它指向别的元素", () => {
  const wrap = el("div", { cls: "shot-row" });
  const btn = el("button", { cls: "primary on" });
  btn.parentElement = wrap;
  const p = cssPathOf(btn);
  assert.ok(!p.includes("nth"), p);
  assert.equal(p, "div.shot-row > button.primary", "状态类 on 不进线索");
});

test("CSS 线索有深度上限，不整棵树打印出来", () => {
  let node = el("button", { cls: "x" });
  for (let i = 0; i < 10; i += 1) {
    const p = el("div", { cls: `l${i}` });
    node.parentElement = p;
    node = p;
  }
  assert.ok(cssPathOf(el("button", { cls: "x" })).split(">").length <= 3);
});

/* --- 标签与快照 ------------------------------------------------------------ */

test("标签取有限可见文字，不搬正文", () => {
  const long = el("div", { text: "  很长的一段正文".repeat(40) });
  assert.ok(labelOf(long).length <= 60, labelOf(long).length);
  assert.ok(!labelOf(long).includes("\n"));
  assert.equal(labelOf(el("button", { text: " 生成 \n " })), "生成");
  assert.equal(labelOf(el("input", { attrs: { placeholder: "写一句意见" } })), "写一句意见");
});

test("快照带上实体身份 —— 那比任何 CSS 路径都稳", () => {
  const row = el("div", { data: { shotId: "shot-2", episodeId: "ep-1" } });
  const btn = el("button", { data: { uiId: "gen", uiComponent: "shotList" }, text: "生成" });
  btn.parentElement = row;
  const snap = snapshotOf(btn);
  assert.equal(snap.uiId, "gen");
  assert.equal(snap.component, "shotList");
  assert.equal(snap.shotId, "shot-2", "身份从祖先上取到了");
  assert.equal(snap.episodeId, "ep-1");
  assert.equal(snap.label, "生成");
});

test("空字段不进快照 —— 送过去只会被服务端丢掉", () => {
  const snap = snapshotOf(el("span", {}));
  assert.ok(!("uiId" in snap));
  assert.ok(!("shotId" in snap));
});

test("rect 是 CSS 像素、视口参照系，取一位小数", () => {
  const btn = el("button", { rect: { left: 12.44, top: 300.06, width: 64, height: 28 } });
  assert.deepEqual(snapshotOf(btn).rect, { x: 12.4, y: 300.1, w: 64, h: 28 });
});

test("annotationId 不借用 runId，而且两次不一样", () => {
  let n = 0;
  const a = newAnnotationId(() => 1000, () => 0.1);
  const b = newAnnotationId(() => 1000, () => { n += 1; return 0.9; });
  assert.match(a, /^ann-/);
  assert.notEqual(a, b);
});

test("引用条一级级退，退到哪一级他看得出来", () => {
  const where = { moduleLabel: "分镜设计" };
  assert.equal(
    breadcrumbOf({ component: "镜头列表", label: "生成" }, where),
    "分镜设计 › 镜头列表 › 生成",
  );
  assert.equal(breadcrumbOf({ uiId: "shot-gen" }, where), "分镜设计 › shot-gen");
  assert.equal(breadcrumbOf({ selector: "div > button" }, where), "分镜设计 › div > button");
  assert.equal(breadcrumbOf({}, where), "分镜设计 › （未命名元素）");
});

/* --- startPicking：点选不许触发页面行为 ------------------------------------ */

function fakeDoc() {
  const listeners = [];
  return {
    listeners,
    body: { classList: { added: [], add(c) { this.added.push(c); }, remove(c) { this.added = this.added.filter((x) => x !== c); } } },
    addEventListener: (name, fn, capture) => listeners.push({ name, fn, capture }),
    removeEventListener: (name, fn, capture) =>
      listeners.splice(listeners.findIndex((l) => l.name === name && l.fn === fn && l.capture === capture), 1),
    fire(name, ev) {
      for (const l of [...listeners]) if (l.name === name) l.fn(ev);
    },
  };
}
const evt = (target, extra = {}) => {
  const e = { target, prevented: false, stopped: false, ...extra };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  return e;
};

test("拦的不只是 click —— pointerdown 与键盘激活同样会触发按钮", () => {
  // 上游只拦了 click。本项目的按钮有拖拽和键盘激活：只拦 click 的话，他想选
  // 「生成」，结果真的生成了一次。
  const doc = fakeDoc();
  const stop = startPicking(doc, {});
  const btn = el("button", { text: "生成" });
  for (const name of ["pointerdown", "mousedown"]) {
    const e = evt(btn);
    doc.fire(name, e);
    assert.ok(e.prevented && e.stopped, `${name} 没被拦住`);
  }
  for (const key of ["Enter", " "]) {
    const e = evt(btn, { key });
    doc.fire("keydown", e);
    assert.ok(e.prevented && e.stopped, `键 ${key} 没被拦住`);
  }
  stop();
});

test("全部挂在捕获阶段 —— 页面自己的监听在冒泡阶段，捕获拦住等于没被点到", () => {
  const doc = fakeDoc();
  const stop = startPicking(doc, {});
  assert.ok(doc.listeners.length > 0);
  assert.ok(doc.listeners.every((l) => l.capture === true), "有监听不在捕获阶段");
  stop();
});

test("点一下 = 选中并自动退出选择模式", () => {
  const doc = fakeDoc();
  const picked = [];
  const btn = el("button", { data: { uiId: "gen" }, text: "生成" });
  const stop = startPicking(doc, { onPick: (el2, snap) => picked.push(snap) });
  doc.fire("click", evt(btn));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].uiId, "gen");
  assert.equal(doc.listeners.length, 0, "选完要自己退出，不能一直拦着页面");
  stop();
});

test("Esc 退出并回调 onCancel", () => {
  const doc = fakeDoc();
  let cancelled = 0;
  startPicking(doc, { onCancel: () => { cancelled += 1; } });
  doc.fire("keydown", evt(null, { key: "Escape" }));
  assert.equal(cancelled, 1);
  assert.equal(doc.listeners.length, 0);
  assert.deepEqual(doc.body.classList.added, [], "光标样式也要还原");
});

test("stop() 幂等 —— 第二次调用不许摘掉别人后来挂的监听", () => {
  // `click` 里先 stop 再回调，调用方在回调里很可能又 stop 一次（它并不知道
  // 模块已经自己退过了）。而这中间页面已经重新挂上了它自己的监听 ——
  // 一个不幂等的 stop 会去摘一个**已经不在表里**的东西，`splice(-1, 1)` 于是
  // 摘掉最后一个，也就是别人的那个。症状是「点选用过一次之后，页面某个交互失灵」。
  const doc = fakeDoc();
  const stop = startPicking(doc, {});
  stop();
  const theirs = () => {};
  doc.addEventListener("click", theirs, false);
  stop();
  assert.deepEqual(
    doc.listeners.map((l) => l.fn),
    [theirs],
    "第二次 stop 把别人后来挂的监听摘掉了",
  );
});

test("自己的控件不拦 —— 否则「取消」按钮点不动，退不出去", () => {
  const doc = fakeDoc();
  const own = el("button", { data: { efUi: "cancel" }, text: "取消" });
  const picked = [];
  startPicking(doc, { onPick: (e2, s) => picked.push(s) });
  const e = evt(own);
  doc.fire("click", e);
  assert.ok(!e.prevented, "自己的控件被拦住了");
  assert.equal(picked.length, 0, "点自己的控件不该算作一次选中");
});

/* --- 句柄从已有的 data-* 派生（TASK-132 切片 A 补齐） --------------------- */

test("句柄从已有的 data-* 派生 —— 不为点击定位再打一遍标记", () => {
  // 这些属性早就在，而且 **bind 函数就是靠它们 querySelectorAll 的** ——
  // 也就是说它们已经是承重的、跨重渲染稳定的身份。再手工打一遍 `data-ui-id`
  // 等于把同一件事写两遍，然后等它们漂移。
  assert.equal(handleOf(el("button", { data: { sbGenerate: "1" } })), "sb-generate");
  assert.equal(handleOf(el("button", { data: { bChdel: "char-1" } })), "b-chdel");
});

test("显式的 data-ui-id 永远优先 —— 派生只是兜底", () => {
  const e = el("button", { data: { uiId: "shot-generate", sbGenerate: "1" } });
  assert.equal(handleOf(e), "shot-generate");
});

test("携带**值**的 data-* 不算句柄", () => {
  // `data-sid` / `data-field` 是「这一行是哪个状态 / 哪一栏」，同一个按钮在不同
  // 行上都不一样。拿它当身份，等于说「他点的是状态 s-3」而不是「他点的是状态的
  // 删除按钮」—— 下次渲染那一行换了 id，这条意见就指到别处去了。
  assert.equal(handleOf(el("button", { data: { sid: "s-3", kind: "c" } })), "");
  assert.equal(handleOf(el("div", { data: { shotId: "shot-2" } })), "", "身份另有字段装");
  // 混在一起时，只挑句柄那个
  assert.equal(
    handleOf(el("button", { data: { sid: "s-3", bCsdel: "char-1", field: "x" } })),
    "b-csdel",
  );
});

test("targetOf 认派生句柄 —— 点在图标上，选中的是那个带句柄的按钮", () => {
  const btn = el("button", { data: { sbGenerate: "1" }, text: "生成" });
  const icon = el("span", { text: "🎬" });
  icon.parentElement = btn;
  assert.equal(targetOf(icon), btn);
  assert.equal(snapshotOf(btn).uiId, "sb-generate");
});

test("component 也从祖先上取 —— 区块名通常打在容器上，不在按钮上", () => {
  const panel = el("section", { data: { uiComponent: "镜头列表" } });
  const btn = el("button", { data: { sbGenerate: "1" }, text: "生成" });
  btn.parentElement = panel;
  assert.equal(snapshotOf(btn).component, "镜头列表");
});
