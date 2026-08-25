// 系统合同 §7 —— 读写两个模块的分工，钉成一条可执行的断言。
//
// 历史：这个文件原本守的是 TASK-074 §1.5 的**前置**（「§1.4 没通过之前，
// `query.js` 里那两个已无人调用的写函数 re-export 也不许提前删」）。
// §1.4 于 2026-08-24 机械闭合、§1.5 批次 2 于 2026-08-25 把十六个 re-export
// 连同调用点一起迁完之后，那条规则已被取代 —— **它保护的是历史行为，不是
// 当前有效行为**，所以换成下面这条。
//
// 现在守的是那件真正长期成立的事：**`query.*` 底下不得再出现写操作。**
// 拆开两个模块的全部理由，是让「这一次调用会不会改东西」能靠「它来自哪个模块」
// 回答；只要有一个写函数能从 `query.*` 取到，这个问题就又要逐个调用点去查了。
//
// 写函数的名单**从 command.js 自己派生**，不手写：新加的写函数应当**因为存在**
// 而进入这条守卫（TASK-087 §7 方法论第 2 条）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);

/** `src/` 下所有 .js 的原文（按需递归）。 */
function allSources(dir = SRC, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
    if (e.isDirectory()) allSources(child, out);
    // **按路径记，不按文件名** —— 下面要排除的是 `services/query.js` 这一个文件，
    // 而不是「任何叫 query.js 的文件」。按 basename 排除的话，将来某个子目录里
    // 再出现一个 query.js，它重新调用目标函数也不会被看见（codex 复审非阻塞）。
    else if (e.name.endsWith(".js")) {
      out.push([child.href.slice(SRC.href.length), readFileSync(child, "utf8")]);
    }
  }
  return out;
}

/** 去掉注释，只留代码。
 *
 *  这条守卫判的是**调用**，不是**提到**。app.js 里有一段注释专门解释
 *  「这里为什么必须是 command.preflight 而不是 query.preflight」——
 *  连那段解释一起判成违规，会逼着代码不许把理由写下来，而理由正是
 *  防止有人再改回去的那样东西。
 *
 *  故意做得保守：块注释与整行 `//` 注释，够用且不会把真代码吃掉。
 *  行尾 `//` 不处理 —— 它可能出现在字符串里的 `https://`，切错了会
 *  把真代码切没，那才是危险的方向。 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** command.js 导出的每一个函数名 —— 派生，不手写。 */
function writeFunctionNames() {
  const text = readFileSync(new URL("services/command.js", SRC), "utf8");
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return [...names];
}

test("§7：command.js 的每一个写函数都不得能从 `query.*` 取到", () => {
  const query = readFileSync(new URL("services/query.js", SRC), "utf8");
  const leaked = writeFunctionNames().filter((fn) => (
    // 只看 query.js 里的**导出面**：注释里提到某个名字（比如解释为什么删掉了
    // 兼容层）不是泄漏。这里判的是「它有没有被再导出」。
    new RegExp(`^\\s*export\\b[^\\n]*\\b${fn}\\b`, "m").test(query)
    || new RegExp(`\\b${fn}\\b[^\\n]*\\n?[^\\n]*from ["']\\./command\\.js["']`).test(query)
  ));
  assert.deepEqual(leaked, [],
    `这些写函数又能从 \`query.*\` 取到了：${leaked}。`
    + "系统合同 §7：读住 query.js，写住 command.js —— 一个写操作从读模块导出，"
    + "就把「这一次调用会不会改东西」重新变成一个要逐处去查的问题。");
});

test("§7：没有任何调用点还在走 `query.<写函数>`", () => {
  const names = writeFunctionNames();
  const sources = allSources().filter(([rel]) => rel !== "services/query.js");
  const offenders = [];
  for (const [rel, raw] of sources) {
    const text = codeOnly(raw);
    for (const fn of names) {
      if (text.includes(`query.${fn}`)) offenders.push(`${rel} → query.${fn}`);
    }
  }
  assert.deepEqual(offenders, [], `${offenders}\n改成从 command.js 直接调。`);
});

test("§7：扫描面非空自检", () => {
  // 上面两条都靠「扫遍 src/」与「从 command.js 派生名单」。任何一边扫空了，
  // 断言就在空集上恒真 —— 一条永远绿的守卫比没有守卫更糟，因为它看起来
  // 像有人在看着。
  const sources = allSources();
  assert.ok(sources.length > 50, `只扫到 ${sources.length} 个源文件，扫描面坏了`);
  assert.ok(
    sources.some(([, t]) => t.includes("query.")),
    "一个 `query.` 引用都没扫到 —— 扫描面坏了",
  );
  const names = writeFunctionNames();
  assert.ok(names.length > 10, `只从 command.js 派生出 ${names.length} 个写函数，名单坏了`);
  // 迁移过来的那批必须真的在名单里，否则「派生」只是看起来在派生。
  for (const fn of ["renderEpisode", "mixShotAudio", "createProject", "ttsGenerate"]) {
    assert.ok(names.includes(fn), `派生名单里没有 ${fn}`);
  }
});
