// 剧集制作那一屏的**骨架合同**：每个直接子面板都必须被显式放进某个格子。
//
// 产品负责人 2026-09-03：「剧集制作那一页为什么和 AI 的对话框很小」。
//
// 实测（真实浏览器，1680×1000）：对话区高 **81px**、消息区只剩 **8px**，而同一个
// 骨架在故事开发与资产库里是 914px。原因是 TASK-124 的制作画布那一支把中间面板
// 写成了 `st-main prod-main ep3-main` —— **少了 `ep-main`**，而 `ep-main` 才是
// `epprod.css` 里那条定位规则的键。于是它没有匹配到任何一条规则，被**自动排版**
// 塞进「第 2 行 · 第 1 列」：画布挤在左边 312px 一条、右边空掉一屏，左栏掉到左下角，
// 横跨三列的第 2 行吃掉 850px，把右侧对话区压成一条。
//
// 别的两个空间没事，是因为它们的网格正好三列、三个子元素按顺序自动落位；
// **只有这个空间是六行显式排版** —— 在它里面「自动排版」就等于「排错」。
//
// 所以这条测试守的不是那一个类名，而是那条性质：**这个空间里没有未定位的面板**。
// 放在前端套件里而不是 pytest 里，是因为它要同时读 CSS 与 JS 两份前端源码
// （AGENTS.md 第 20 条：Python 测试不对前端 JS 做源码断言）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles/epprod.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../src/ui/production.js", import.meta.url), "utf8");

/** `epprod.css` 里真的被放进格子的那些类（带 grid-column / grid-row 的规则）。
 *  名单从 CSS 里读，不在测试里另抄一份 —— CSS 改了类名，这条测试跟着走。 */
function placedClasses() {
  const out = new Set();
  const re = /#production\.space-episode\s*>\s*([^{]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (!/grid-(column|row)\s*:/.test(m[2])) continue;
    for (const sel of m[1].split(",")) {
      const cls = sel.trim().match(/^\.([A-Za-z0-9_-]+)/);
      if (cls) out.add(cls[1]);
    }
  }
  // 逗号分隔的选择器组里，前几个分支的 `#production.space-episode >` 前缀写在
  // 自己那一行上（`.sr, .pi` 那种），上面的正则只吃到最后一支 —— 补上前缀写法。
  const re2 = /#production\.space-episode\s*>\s*\.([A-Za-z0-9_-]+)\s*,/g;
  while ((m = re2.exec(css))) out.add(m[1]);
  return out;
}

test("剧集制作的每个面板都被显式放进格子 —— 没有一个靠自动排版", () => {
  const placed = placedClasses();
  // 先确认名单本身是活的：读空了就等于这条测试白跑
  for (const need of ["st-crumb", "prod-eprail", "st-dir"]) {
    assert.ok(placed.has(need), `CSS 里读不到 .${need} 的定位规则 —— 名单解析坏了`);
  }

  // 这个文件里所有 `<main class="st-main …">` 字面量。剧集制作与别的空间共用
  // 同一个渲染函数文件，所以逐个看它落在哪个空间：带 `prod-main` 且出现在
  // 剧集制作分支里的那些，必须有一个被放过的类。
  const mains = [...js.matchAll(/<main class="(st-main[^"$]*)/g)].map((m) => m[1]);
  assert.ok(mains.length >= 2, "找不到主面板字面量 —— 选择器过期了");

  const episodeMains = mains.filter((cls) => /\bep\d*-main\b/.test(cls));
  assert.ok(
    episodeMains.length >= 2,
    "剧集制作至少有两支主面板（制作画布 + 做某一镜的那层包装）",
  );
  for (const cls of episodeMains) {
    const names = cls.split(/\s+/).filter(Boolean);
    assert.ok(
      names.some((n) => placed.has(n)),
      `<main class="${cls}"> 没有任何一个被定位过的类 —— 它会被自动排进第 2 行第 1 列`,
    );
  }
});

test("剧集制作的左栏带着它自己的落位键", () => {
  // 左栏在故事开发与资产库里是 `st-rail prod-nav`（三列网格自动落位，没问题），
  // 只有剧集制作那一支额外带 `prod-eprail` —— 那个类就是它的落位键。
  // 光看源码文本分不出一个 `st-rail` 字面量属于哪个空间，所以这里只钉**这一支**：
  // 分不清的判据会喊狼，喊狼的测试比没有测试更糟。
  const placed = placedClasses();
  assert.ok(
    /<nav class="st-rail prod-nav prod-eprail"/.test(js),
    "剧集制作的左栏丢了 prod-eprail —— 它会落到自动排版里",
  );
  assert.ok(placed.has("prod-eprail"), "CSS 里没有 .prod-eprail 的落位规则");
});
