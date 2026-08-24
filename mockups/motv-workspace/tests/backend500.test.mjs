// TASK-072 验收 #5 —— **后端 500 时 UI 模型是 error 而不是 empty**。
//
// 卡上写着这一条「已实证（不是推理）」，但也写着守卫测试**未做**：
// 「目前只有代码保证」。这份文件就是那道缺的守卫。
//
// 为什么这一条值得一道专门的守卫：坏掉的后端渲染成「你没有项目」，创作者
// **无法把它和真的空区分开**。他会以为项目没了 —— 而事实是后端炸了。
// 这两件事把他送到完全不同的地方（一个是去看服务，一个是去找备份）。
//
// 三条读路径都要守：`listProjects` / `getShots` / `getQuery`。
// 只守一条的话，另外两条哪天退化回 `[]` 不会有任何东西喊。
import test from "node:test";
import assert from "node:assert/strict";

import * as query from "../src/services/query.js";

/** 让本次调用处于 connected 模式，并让后端答一个真的 500。 */
async function withBackend(status, body, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // `detectMode` 那一次必须成功，否则模式退到 local，
    // 三条读路径会**合法地**返回 [] —— 那样这份测试就测了个寂寞。
    if (String(url).includes("/api/meta")) {
      return new Response(
        JSON.stringify({ mode: "connected", contract_version: "1.6" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await query.detectMode();
    assert.equal(query.isConnected(), true, "夹具没进 connected —— 下面证不出东西");
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const FAULT = { error: { category: "source_corrupt", detail: "记录读不出来" } };

test("验收 #5：后端 500 时 listProjects **抛出**，不退化成空数组", async () => {
  await withBackend(500, FAULT, async () => {
    await assert.rejects(
      () => query.listProjects(),
      (e) => {
        // 分类必须来自**后端**，不是就地编一个 —— 界面要能说出是哪种坏
        assert.equal(e.category, "source_corrupt");
        assert.equal(e.status, 500);
        return true;
      },
    );
  });
});

test("验收 #5：`getShots` 同样抛出 —— 这一页的全部工作就是显示镜头", async () => {
  await withBackend(500, FAULT, async () => {
    await assert.rejects(
      () => query.getShots("某项目"),
      (e) => e.category === "source_corrupt" && e.status === 500,
    );
  });
});

test("验收 #5：`getQuery` 同样抛出", async () => {
  await withBackend(500, FAULT, async () => {
    await assert.rejects(
      () => query.getQuery("某项目", "cost"),
      (e) => e.category === "source_corrupt" && e.status === 500,
    );
  });
});

test("**真的空仍然是空** —— 守卫不能把「没有项目」也变成错误", async () => {
  // 这条是上面三条的阳性对照。少了它，把三条读路径改成「永远抛」也能全绿，
  // 而那样创作者第一次打开一个空账户就会看到一条错误。
  await withBackend(200, { projects: [] }, async () => {
    assert.deepEqual(await query.listProjects(), []);
  });
  await withBackend(200, { shots: [] }, async () => {
    assert.deepEqual(await query.getShots("空项目"), []);
  });
  // `getQuery` 也要有对照（codex 复审非阻塞，判得对）：少了它，把这条路径改成
  // 「无条件抛」照样全绿，而那样每一次正常的只读查询都会显示成错误。
  await withBackend(200, { items: [] }, async () => {
    assert.deepEqual(await query.getQuery("空项目", "cost"), { items: [] });
  });
});

test("没有后端时返回空是**合法**的 —— 静态 demo 本来就没有后端", async () => {
  // 「后端坏了」与「按设计就没有后端」是两件事，只有前者是缺陷。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    await query.detectMode();
    assert.equal(query.isConnected(), false);
    assert.deepEqual(await query.listProjects(), []);
    assert.deepEqual(await query.getShots("随便"), []);
    // `getQuery` **不在这条对照里，而且是对的**：它没有 `isConnected()` 这道
    // 前置，因为它服务的页面在没有后端时根本进不去。所以「没有后端」对它而言
    // 就是一次失败，抛出正是它该做的 —— 与上面两条不同，如实记在这里。
    await assert.rejects(() => query.getQuery("随便", "cost"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
