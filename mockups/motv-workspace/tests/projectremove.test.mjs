// REQ-005 / ADR-0090 —— 主页卡片上的「移除」。
//
// 这条路径的危险不在于它做不到，而在于它**做多了**：一个看起来像删除的按钮，
// 很容易变成真的删文件。产品负责人划的界很清楚：「删除前端。后端的文件留下就好了啊。」
// 所以这里既测行为，也钉住「应用里没有任何删文件的路径」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { removeProject, addProject, loadRegistry } from "../src/services/projects.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

/** The smallest `localStorage` these functions use. */
function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test("本机项目从列表里移除，其它项目不受影响", () => {
  const s = storage();
  addProject(s, { name: "甲", assetRoot: "D:/a", now: "2026-08-01T00:00:00Z" });
  addProject(s, { name: "乙", assetRoot: "D:/b", now: "2026-08-02T00:00:00Z" });
  const res = removeProject(s, "甲");
  assert.equal(res.ok, true);
  assert.deepEqual(res.list.map((p) => p.name), ["乙"]);
  assert.deepEqual(loadRegistry(s).map((p) => p.name), ["乙"]);
});

test("移除一个不存在的名字是空操作，不会把列表清空", () => {
  const s = storage();
  addProject(s, { name: "甲", assetRoot: "D:/a", now: "2026-08-01T00:00:00Z" });
  const res = removeProject(s, "并不存在");
  assert.equal(res.ok, true);
  assert.deepEqual(res.list.map((p) => p.name), ["甲"]);
});

test("写入失败要如实返回，不能假装移除了", () => {
  const s = storage();
  addProject(s, { name: "甲", assetRoot: "D:/a", now: "2026-08-01T00:00:00Z" });
  s.setItem = () => { throw new Error("quota"); };
  const res = removeProject(s, "甲");
  assert.equal(res.ok, false);
  assert.ok(res.error, "失败必须带原因");
});

// --- the wiring and the boundary -------------------------------------------- //

test("每张卡片旁边都有移除按钮，而且它是卡片的兄弟不是子元素", () => {
  // `pcard` 是 <button>：把另一个 button 塞进去既非法，点击还会冒泡成「打开项目」——
  // 对一个看起来危险的控件来说，那是最糟的误触。
  const app = readFileSync(join(SRC, "app.js"), "utf8");
  assert.match(app, /wrap\.className = "pcardwrap"/);
  assert.match(app, /del\.className = "pdel"/);
  assert.match(app, /wrap\.appendChild\(b\);/);
  assert.match(app, /wrap\.appendChild\(del\);/);
  assert.match(app, /ev\.stopPropagation\(\)/);
});

test("确认文案必须写明「文件不会被删」——否则「删了怎么还占着盘」就是下一个问题", () => {
  const app = readFileSync(join(SRC, "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function removeProjectCard"), app.indexOf("function renderLanding"));
  assert.match(fn, /磁盘上的项目文件夹不会被删除/);
  assert.match(fn, /重新打开那个文件夹/, "还要告诉他怎么加回来 —— 这才叫可逆");
});

test("正在打开的项目不能被就地移除（判据 4）", () => {
  const app = readFileSync(join(SRC, "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function removeProjectCard"), app.indexOf("function renderLanding"));
  assert.match(fn, /canvasActive && name === PROJECT_NAME/);
});

test("应用里没有任何删除项目文件的路径（ADR-0090 决策 2）", () => {
  // 这是本卡最重要的一条：不是「删得对不对」，而是「根本没有这条路」。
  const app = readFileSync(join(SRC, "app.js"), "utf8");
  const q = readFileSync(join(SRC, "services", "query.js"), "utf8");
  for (const [what, src] of [["app.js", app], ["query.js", q]]) {
    assert.doesNotMatch(src, /rmdir|rmtree|deleteFolder|unlinkProject/, `${what} 出现了删文件的迹象`);
  }
  // 端点名本身就说明它只动注册表
  assert.match(q, /\/unregister/);
  assert.doesNotMatch(q, /\/(trash|delete)\b/);
});

test("服务端那条路由不含任何文件系统写操作", () => {
  const srv = readFileSync(join(HERE, "..", "server.py"), "utf8");
  const fn = srv.slice(
    srv.indexOf("def _unregister_project"),
    srv.indexOf("# -- 对话（ADR-0089）"),
  );
  assert.ok(fn.length > 200, "没找到那个处理器");
  for (const forbidden of ["rmtree", "unlink", "shutil.move", "os.replace", "os.remove"]) {
    assert.ok(!fn.includes(forbidden), `处理器里出现了 ${forbidden} —— 它不许碰文件`);
  }
  assert.match(fn, /filesDeleted/);
});
