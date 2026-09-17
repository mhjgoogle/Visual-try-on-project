// 调用了，却没 import —— 这一类缺陷在运行时抛 `ReferenceError`，而**现有守卫一条都
// 抓不到它**。
//
// 今天的实例（codex 复审轮 4 报出）：`app.js` 里写了 `isUnknownOutcome(e)`，import 却
// 漏了 —— 剧本拆解一进 catch 就抛 `ReferenceError`，「问不到」既不会被记下也不会显示。
// 前端全量 2269 条全绿，`appparse.test.mjs` 也绿：**它判的是 ESM 能不能解析，而自由
// 标识符不是解析错误**（绿测试 ≠ 新代码真的接上了）。
//
// 规则只有一条，而且刻意宽松：
//
//   一个文件 `NAME(` 调用的名字，如果它是**别的模块导出的**，
//   那么这个名字必须在本文件里**还出现过至少一次不是紧跟 `(` 的位置**
//   （import 进来的、解构参数、赋值、方法定义……都算）。
//
// 为什么不按声明形式枚举：工厂函数的依赖是多行解构参数，局部助手有十几种写法，
// 按形式列举永远列不完，而列不全就会误杀。**宁可漏报不误杀** —— 与
// `lifecycle_check`「判不了的不判」同一态度。今天那个缺陷里 `isUnknownOutcome`
// 全文只出现一次、就是那句调用，所以照样拓得住。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);
const NL = String.fromCharCode(10);

function files(dir = SRC, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
    if (e.isDirectory()) files(child, out);
    else if (e.name.endsWith(".js")) {
      out.push([child.href.slice(SRC.href.length), readFileSync(child, "utf8")]);
    }
  }
  return out;
}

/** 去掉注释与字符串字面量 —— 这条判的是**调用**，不是**提到**。 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // **`.` 不匹配回车**：CRLF 文件里 `//.*$` 到不了行尾（`.*` 停在回车前，而 `$`
    // 只认字符串末尾），注释一行都剥不掉。而这个仓库的注释里全是反引号 —— 剥不掉
    // 注释，下一步的模板串配对就整体错位，判出来的全是噪音（第一版就栽在这）。
    .replace(/\/\/[^\n\r]*/g, " ")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '""')
    .replace(/'(?:[^'\\]|\\[\s\S])*'/g, '""')
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
}

test("调用了别的模块导出的名字，本文件里就必须有它的来处（否则运行时 ReferenceError）", () => {
  const all = files().map(([path, src]) => [path, code(src)]);

  // 谁导出了什么
  const exportedBy = new Map();
  for (const [path, c] of all) {
    for (const re of [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g,
    ]) {
      for (const m of c.matchAll(re)) {
        if (!exportedBy.has(m[1])) exportedBy.set(m[1], new Set());
        exportedBy.get(m[1]).add(path);
      }
    }
  }

  const problems = [];
  for (const [path, c] of all) {
    // 本文件里「有来处」的名字：出现过至少一次不是紧跟 `(` 的位置
    const known = new Set();
    for (const m of c.matchAll(/([A-Za-z_$][\w$]*)[\s\S]?/g)) {
      if (m[0].slice(m[1].length) !== "(") known.add(m[1]);
    }
    // 方法定义（`bind(node, el, ctx) {`）紧跟 `(`，上面那条看不见它
    for (const m of c.matchAll(/(?:^|[\s,{;])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) {
      known.add(m[1]);
    }

    for (const m of c.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (known.has(name)) continue;
      const owners = exportedBy.get(name);
      if (!owners || owners.has(path)) continue;   // 不是我们的模块导出的 / 就是自己
      problems.push(`${path} 调用了 ${name}()，但本文件里没有它的来处（它由 ${[...owners].join(" / ")} 导出）`);
    }
  }

  assert.deepEqual([...new Set(problems)], [], [...new Set(problems)].join(NL));
});
