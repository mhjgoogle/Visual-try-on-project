// TASK-074 §1.5 —— 「哪些旧接口**真的**可以删」这条判断，别让它悄悄过期。
//
// §1.5 的第一条规则是「先确认无引用，再删」。2026-08-24 做过一次全仓核查，
// 结论写在卡上。问题是：**那份核查是一份文档，而文档会过期** —— 这个仓库今天
// 已经撞到十几处过期声明了。
//
// 所以把核查里**唯一可执行的那部分**钉住：`query.js` 那 16 个写函数 re-export
// 里，只有 `renderEpisode` 与 `mixShotAudio` 已经没有 `query.*` 调用点。
// 哪天有人重新用起它们，卡上那句「这两个可以删」就变成假话 —— 这条会先红。
//
// **不钉「仍在使用」的那 14 个**：那是正常状态，钉它只会让每次正常改动都变红。
// 只钉「已经可以删」的少数几个 —— 它们才是会被人照着去删的那几行。
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

const RETIREABLE = ["renderEpisode", "mixShotAudio"];

test("§1.5 核查：这两个写函数 re-export 仍然无人从 `query.*` 调用", () => {
  const sources = allSources().filter(([rel]) => rel !== "services/query.js");
  for (const fn of RETIREABLE) {
    const callers = sources
      .filter(([, text]) => text.includes(`query.${fn}`))
      .map(([rel]) => rel);
    assert.deepEqual(
      callers,
      [],
      `卡上说 \`${fn}\` 已无调用点、可随 §1.5 一起删 —— 但 ${callers} 又用起来了。`
        + "先更新 TASK-074 §1.5 的核查表，再决定还删不删。",
    );
  }
});

test("§1.5 核查：它们**还在**，也就是说 §1.5 没有被悄悄执行掉一半", () => {
  // 反方向的守卫。§1.5 的硬前置是 §1.4，而 §1.4 还没通过 —— 所以这些东西
  // 此刻**应该都还在**。少了任何一个，说明有人跳过了那个前置。
  const query = readFileSync(new URL("services/query.js", SRC), "utf8");
  for (const fn of RETIREABLE) {
    assert.ok(
      query.includes(fn),
      `\`${fn}\` 已经从 query.js 消失了 —— §1.5 的硬前置是 §1.4 全绿，`
        + "而 §1.4 尚未通过。要么是提前删了，要么是这份核查该更新了。",
    );
  }
});

test("§1.5 核查：扫描面非空自检", () => {
  // 上面两条都靠「扫遍 src/」。扫空了的话，第一条在空集上恒真 ——
  // 一条永远绿的守卫比没有守卫更糟，因为它看起来像有人在看着。
  const sources = allSources();
  assert.ok(sources.length > 50, `只扫到 ${sources.length} 个源文件，扫描面坏了`);
  assert.ok(
    sources.some(([, t]) => t.includes("query.")),
    "一个 `query.` 引用都没扫到 —— 扫描面坏了",
  );
});
