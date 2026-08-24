// TASK-073 验收 #9 —— 后端错误**显示为错误，不显示为空**（渲染层这一侧）。
//
// 查询层由 `backend500.test.mjs` 守（三条读路径在 500 时抛出而不是回 `[]`）。
// 这里守的是它到了界面之后的那一半：`LIST_ERROR`。
//
// **为什么这条不变量值得一道专门的守卫** —— app.js 里那段注释记了三轮审查，
// 三次错法一模一样：**让「渲染」去决定「取数」的真相**。
//
//   轮 1  没有这个标志：一次重绘把提示变回「已连接后端」，而下面是一个空网格
//   轮 2  整个会话粘住：后来一次**有项目**的重绘仍然显示故障 —— 从「瞬时错误被
//         抹掉」变成「错误永久显示」
//   轮 3  只要 `realNames` 非空就清掉：失败之后新建一个项目就把提示翻成成功，
//         而列表其实仍然读不出来 —— 正是它要防的那句「你没有项目」
//
// 于是定下来的规矩是：**只有 `fetchProjectList` 写它，`renderLanding` 只读。**
// 一次重绘不会学到任何关于后端的新事实，本地新建一个项目也不会让列表变得可读。
//
// app.js 是浏览器脚本（没有 export、靠 document 活着），import 不进来，
// 所以这里判的是**结构**：写它的地方只能有那一处。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

/** 「写 `LIST_ERROR`」的判据。
 *
 *  第一版判据是「LIST_ERROR 后面跟一个等号」，两头都错
 *  （codex 复审非阻塞，判得对）：
 *  它把 `LIST_ERROR === null` 这种**读**算成写（假阳性，一次无害的比较就能
 *  让守卫红），又漏掉 `LIST_ERROR ||= e` 这种**复合赋值**（假阴性，而那正是
 *  绕过这条不变量最省事的写法）。
 *
 *  正确判据：`=` 后面不跟 `=`，外加三种复合赋值。 */
const WRITE = new RegExp(
  "LIST_ERROR\\s*(?:"
    + "=(?!=)"           // 普通赋值（排除 == / ===）
    + "|\\|\\|=|&&=|\\?\\?="  // 逻辑复合赋值
    + "|[+\\-*/%&|^]="       // 算术 / 位复合赋值
    + "|\\*\\*=|<<=|>>>?="   // 幂 / 移位复合赋值
    + "|\\+\\+|--"           // 后置自增自减
    + ")"
    + "|(?:\\+\\+|--)\\s*LIST_ERROR",  // 前置自增自减
  "g",
);

// **这道守卫抓不到解构赋值**（`({ x: LIST_ERROR } = obj)`），如实写下来。
// 用正则去覆盖解构要的机器远超它买到的安全性：这是一个模块级的 `let`，
// 没有人会用解构去写它，而**假装覆盖了**比承认没覆盖更糟 ——
// 下面那条测试把这个缺口钉成可执行的断言，所以它不会被忘掉，
// 也不会有人以为这里是密不透风的。


// **不剥注释，直接扫原文**（codex 轮 3 非阻塞）。
//
// 上一版有一个 `codeOnly` 剥离器，而它把字符串 / 正则 / 模板里的 `//` 也当成
// 注释 —— 同一行后面的赋值会在扫描前被删掉，**写就从守卫底下溜过去了**。
// 把它写对需要一个真的词法分析器，而它买到的东西是零：实测 app.js 原文里
// 写模式一共命中 3 次，**全部是真代码**，没有一次落在注释里。
//
// 代价说清楚：将来有人写一行 `// LIST_ERROR = x` 的注释，这道守卫会红。
// 那是 **fail-closed** 方向（对无害的注释过敏），比反过来好得多，
// 而且它红的时候一眼就看得出是怎么回事。

/** `fetchProjectList` 的函数体。
 *
 *  **必须容忍 CRLF，而且找不到就抛。**
 *  第一版用 LF 版本的「换行 + 右括号 + 换行」找结尾 ——
 *  权威环境是 Windows（ADR-0062）且本仓库工作树是 CRLF，
 *  于是右括号后面是 CR 不是 LF，`search` 返回 -1，
 *  `slice(0, -1)` 把**几乎整个文件**当成了函数体。
 *  下面每一条断言因此都在整份 app.js 上匹配。
 *
 *  这不是「可能会」—— 它当时就在发生（codex 复审报出，判得对）。
 *  所以除了容忍 CRLF，还要**找不到就抛**：一个悄悄退化成
 *  「全文件」的取范围函数，正是这一类守卫最典型的失效方式。 */
function fetchBody(src) {
  const from = src.indexOf("async function fetchProjectList()");
  assert.ok(from > 0, "`fetchProjectList` 不在了 —— 这条不变量的归属没了");
  const rest = src.slice(from);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.ok(
    end > 0,
    "找不到 `fetchProjectList` 的结尾 —— 取范围坏了，不许退化成全文件",
  );
  return rest.slice(0, end);
}

test("验收 #9：**只有 `fetchProjectList` 写 `LIST_ERROR`**", () => {
  const code = APP;
  const assignments = [...code.matchAll(WRITE)];
  // 声明那一行（`let LIST_ERROR = null;`）也算一次赋值，所以是 1 + 函数体里的两次
  assert.equal(assignments.length, 3, "写 LIST_ERROR 的地方变多了");

  const body = fetchBody(APP);
  const inFetch = [...body.matchAll(WRITE)];
  assert.equal(inFetch.length, 2, "`fetchProjectList` 里应当恰好两次：清掉与记下");

  // 声明 + 函数体内两次 = 全部。多出来的一次必然在别处 —— 那就是三轮里的错法。
  assert.match(code, /let LIST_ERROR = null;/);
});

test("验收 #9：清掉它的唯一理由是**一次成功的读**", () => {
  const body = fetchBody(APP);
  // `LIST_ERROR = null` 必须紧跟在 `await query.listProjects()` 之后 ——
  // 轮 3 的错法正是「只要 realNames 非空就清掉」，那是拿**渲染时看到什么**
  // 去推断**取数成功没有**。
  assert.match(body, /await query\.listProjects\(\)[\s\S]{0,120}LIST_ERROR = null/);
  assert.equal(
    /(realNames|REAL_NAMES)[\s\S]{0,40}LIST_ERROR = null/.test(body),
    false,
    "不许用「有没有项目」去推断「读成功没有」",
  );
});

test("验收 #9：读失败时**返回空列表但记下错误** —— 两件事都要做", () => {
  const body = fetchBody(APP);
  assert.match(body, /catch[\s\S]{0,60}LIST_ERROR = e/, "失败必须被记下来");
  assert.match(body, /LIST_ERROR = e;[\s\S]{0,40}return \[\]/, "同时仍要返回空列表");
  // 这两件事一起做，才让界面能说「读不出来」而不是「你没有项目」：
  // 空列表是给渲染用的形状，错误是给创作者看的事实。
});

test("渲染只**读** `LIST_ERROR`，不写它", () => {
  const code = APP;
  const from = code.indexOf("const projectsError = LIST_ERROR;");
  assert.ok(from > 0, "渲染侧读取那一行不在了");
  // 从渲染读取处往后一段里不许出现赋值
  const after = code.slice(from, from + 4000);
  assert.equal(
    new RegExp(WRITE.source).test(after),
    false,
    "渲染侧写了 LIST_ERROR —— 一次重绘学不到任何关于后端的新事实",
  );
});

test("如实记下这道守卫的边界：**解构赋值抓不到**", () => {
  // 这条测试断言的是**漏洞仍然存在** —— 与 gate 那条「安全边界抬到必须故意
  // 绕过，没有抬到不可绕过」同一种写法。它的作用是让缺口**可见**：
  // 哪天有人真的用解构写了 LIST_ERROR，这条会绿而守卫会漏，
  // 而读到这里的人至少知道该去看什么。
  const sneaky = "({ err: LIST_ERROR } = outcome);";
  assert.equal(
    new RegExp(WRITE.source).test(sneaky),
    false,
    "如果这条开始红了，说明守卫变强了 —— 把这条测试删掉并更新上面的注释",
  );
  // 而所有常规写法都抓得到
  for (const w of [
    "LIST_ERROR = e",
    "LIST_ERROR ||= e",
    "LIST_ERROR ??= e",
    "LIST_ERROR &&= e",
    "LIST_ERROR |= 1",
    "LIST_ERROR += 1",
    "LIST_ERROR++",
    "++LIST_ERROR",
  ]) {
    assert.ok(new RegExp(WRITE.source).test(w), `漏掉了写法：${w}`);
  }
  // 读不许被算成写
  for (const r of ["LIST_ERROR === null", "LIST_ERROR == null", "if (LIST_ERROR)"]) {
    assert.equal(new RegExp(WRITE.source).test(r), false, `把读算成了写：${r}`);
  }
});
