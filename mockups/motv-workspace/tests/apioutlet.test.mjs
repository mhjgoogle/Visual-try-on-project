// 唯一 API Client 出口（创作者系统合同 §7.1 规定 10）—— TASK-103 批次 A。
//
// 这条不变量此前只活在文档里。TASK-072 批次二迁了 24/30 个调用点，剩下 6 个
// （`persist` 的 canvas 读/写、`runtime` 的取消/执行）没有任何可执行断言拦着
// 它们回流，于是「唯一出口」在四个月里一直是半真的 —— 而半真的架构规定比没有
// 规定更贵，因为读文档的人会以为它成立。
//
// **为什么住在前端套件而不是 `tests/contract/`**：这是一条纯前端的结构不变量，
// 被守的模块（`services/*.js`）全都能被 node import。ADR-0080 决策 3 要求
// 前端的东西由前端套件覆盖；`tests/contract/` 那个源码文本例外的范围是
// 「`.test.mjs` 拿不到的那一半」（入口 `app.js`），本条不属于它。
//
// **成员集合派生，不手写**（TASK-087 §7 项 2）：扫 `src/**.js`，新加的 service
// 不需要有人记得把它加进某张名单 —— 它因为存在而被检查。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 唯一允许出现裸 `fetch` 的模块。 */
const THE_ONE_OUTLET = "services/apiclient.js";

/** 唯一的显式豁免，连同它成立的理由。
 *
 *  `mediaprobe.js` 探的是**媒体字节**（对资产 URL 发 `HEAD`），不是后端 API ——
 *  规定 10 点名的五个模块里本来就没有它，而 `apiclient` 是 JSON API 客户端，把
 *  字节探测塞进去会让「问不出来」这个第三态失去自己的分类。它那一处还是测试
 *  注入点（`fetchImpl`）的缺省回落，去掉等于让探针无法被断言。
 *
 *  豁免是**被断言的，不是被假设的**：下面钉住它只有这一处、且就是那个缺省
 *  表达式。多出第二处、或它变成一条真实调用，测试就红 —— 这张免票盖不到别的
 *  文件头上。 */
const DECLARED_EXEMPTIONS = { "services/mediaprobe.js": 1 };

/** 裸调用：`fetch(` 前面不能紧跟标识符字符或点号，于是 `fetchImpl(` /
 *  `fetchAsDataUrl(` / `x.fetch(` 都不算，`await fetch(` 算。 */
const BARE_FETCH = /(?<![A-Za-z0-9_$.])fetch\s*\(/g;

/** 去掉注释再匹配 —— 一段解释边界的模块头注释不该读成对边界的违反。 */
function code(file) {
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return src
    .split(/\r?\n/)
    .map((ln) => ln.split("//")[0])
    .join("\n");
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
}

const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");

test("前端只有一个 fetch 出口 —— 成员集合从目录派生", () => {
  const offenders = {};
  for (const file of walk(SRC)) {
    const name = rel(file);
    if (name === THE_ONE_OUTLET) continue;
    const n = (code(file).match(BARE_FETCH) || []).length;
    if (n) offenders[name] = n;
  }
  assert.deepEqual(
    offenders,
    DECLARED_EXEMPTIONS,
    `裸 fetch 与已声明的豁免不一致 —— 新的后端调用必须经 ${THE_ONE_OUTLET}`,
  );
});

test("那一处豁免仍然只是可注入的缺省值，不是一条真实调用路径", () => {
  const src = code(path.join(SRC, "services", "mediaprobe.js"));
  const hits = src.split("\n").filter((ln) => new RegExp(BARE_FETCH.source).test(ln));
  assert.equal(hits.length, 1, JSON.stringify(hits));
  // 它是 `fetchImpl` 缺省时的回落表达式，不是一条调用；
  // 探测本身只调注入进来的 `f(...)`，所以测试永远能替换掉它。
  assert.ok(hits[0].includes('typeof fetch === "function"'), hits[0]);
  assert.ok(!hits[0].includes("await"), hits[0]);
  assert.ok(src.includes("const f = fetchImpl"));
  assert.ok(src.includes("await f("));
});

test("迁移过的三个调用点必须显式关掉客户端超时", () => {
  // `apiclient` 的默认 20s 对它们全都是错的：canvas 存档可以很大，取消「等不到」
  // 不等于「没取消」，本地 CLI 跑一次以分钟计。忘掉 `timeoutMs: 0` 的症状是
  // 「跑到一半自己断了」—— 那种缺陷在行为测试里很难自然暴露，所以直接钉住。
  const persist = code(path.join(SRC, "services", "persist.js"));
  const runtime = code(path.join(SRC, "services", "runtime.js"));
  const count = (s) => (s.match(/timeoutMs:\s*0/g) || []).length;
  assert.equal(count(persist), 1, "canvas PUT 丢了 no-deadline 语义");
  assert.equal(count(runtime), 2, "cancel / skill-run 丢了 no-deadline 语义");
});
