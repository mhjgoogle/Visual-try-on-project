// 服务端媒体审计折进探针表 —— TASK-103 批次 C（GAP-02 / TASK-087 §4.2）。
//
// TASK-077 的前端 `HEAD` 探针有第三态 `INCONCLUSIVE`，因为它问的是**传输**：
// 服务器可能拒答（405/501）、可能 5xx、请求本身可能炸。那是一个关于请求的事实，
// 不是关于项目的事实。服务端读自己的目录之后，项目媒体只剩两种答案。
//
// 这里守的正是那条边界：审计能决定的一定决定，决定不了的**一个都不许乱决定**。
import test from "node:test";
import assert from "node:assert/strict";

import {
  createMediaProbe,
  uploadName,
  PRESENT,
  MISSING,
  INCONCLUSIVE,
} from "../src/services/mediaprobe.js";

// --- uploadName --------------------------------------------------------------

test("认得出 /api/uploads/<项目>/<文件> 这一种形状，别的一律不认", () => {
  assert.equal(uploadName("/api/uploads/proj/a.png", "proj"), "a.png");
  // 别的项目的地址不归本次审计管
  assert.equal(uploadName("/api/uploads/other/a.png", "proj"), null);
  // 嵌套路径不是这个扁平目录里的文件 —— 当成文件会让它被误判为「不在」
  assert.equal(uploadName("/api/uploads/proj/sub/a.png", "proj"), null);
  // 画布本地路径、data:/blob:、外站地址都不归审计管
  assert.equal(uploadName("/local/a.png", "proj"), null);
  assert.equal(uploadName("data:image/png;base64,AAA", "proj"), null);
  assert.equal(uploadName("https://evil.example/api/uploads/proj/a.png", "proj"), null);
  assert.equal(uploadName("//evil.example/api/uploads/proj/a.png", "proj"), null);
  assert.equal(uploadName("/api/uploads/proj/a.png", ""), null);
});

test("百分号编码的项目名与文件名都还原得回来", () => {
  assert.equal(uploadName("/api/uploads/%E9%A1%B9%E7%9B%AE/%E5%9B%BE.png", "项目"), "图.png");
});

// --- applyAudit --------------------------------------------------------------

const audit = (names, over = {}) => ({
  dir: true,
  truncated: false,
  files: Object.fromEntries(names.map((n) => [n, { bytes: 1 }])),
  ...over,
});

test("在与不在都被记下来 —— 没有第三态", () => {
  const p = createMediaProbe({ fetchImpl: null });
  const urls = ["/api/uploads/proj/a.png", "/api/uploads/proj/gone.png"];
  assert.equal(p.applyAudit(urls, "proj", audit(["a.png"])), true);
  assert.equal(p.stateOf("/api/uploads/proj/a.png"), PRESENT);
  assert.equal(p.stateOf("/api/uploads/proj/gone.png"), MISSING);
  assert.equal(p.checked(), 2);
});

test("项目根本没有 media 目录 —— 那也是答案，不是「问不出来」", () => {
  const p = createMediaProbe({ fetchImpl: null });
  p.applyAudit(["/api/uploads/proj/a.png"], "proj", { dir: false, files: {}, truncated: false });
  assert.equal(p.stateOf("/api/uploads/proj/a.png"), MISSING);
});

test("审计被截断时，没读到的名字一个都不许判成「不在」", () => {
  // 上限是一个实现约束，不是关于这些文件的事实。把它读成「不在」等于让一个
  // 阈值去指控用户的文件不见了 —— 正是 TASK-087 §7「守卫只覆盖了一半」那一族。
  const p = createMediaProbe({ fetchImpl: null });
  const urls = ["/api/uploads/proj/a.png", "/api/uploads/proj/beyond.png"];
  p.applyAudit(urls, "proj", audit(["a.png"], { truncated: true }));
  assert.equal(p.stateOf("/api/uploads/proj/a.png"), PRESENT);
  assert.equal(p.stateOf("/api/uploads/proj/beyond.png"), null, "截断之外必须保持未知");
});

test("不属于本项目上传目录的地址原样留给 HEAD 探针", () => {
  const p = createMediaProbe({ fetchImpl: null });
  const urls = ["/local/a.png", "/api/uploads/other/b.png", "data:image/png;base64,AA"];
  assert.equal(p.applyAudit(urls, "proj", audit([])), false);
  for (const u of urls) assert.equal(p.stateOf(u), null);
});

test("审计缺失或形状不对时什么都不改 —— 后端故障不得读成「都不在」", () => {
  const p = createMediaProbe({ fetchImpl: null });
  const urls = ["/api/uploads/proj/a.png"];
  for (const bad of [null, undefined, "nope", 42]) {
    assert.equal(p.applyAudit(urls, "proj", bad), false);
  }
  assert.equal(p.stateOf("/api/uploads/proj/a.png"), null);
});

test("审计说在，就不会被后到的「问不出来」抹掉", () => {
  // `record` 的既有规则（TASK-077 codex 轮 3 的 blocking）：非答案不覆盖答案。
  // 审计与 <img>/HEAD 天生竞速，这里确认审计的结论也受那条规则保护。
  const p = createMediaProbe({ fetchImpl: null });
  p.applyAudit(["/api/uploads/proj/a.png"], "proj", audit(["a.png"]));
  p.observe("/api/uploads/proj/a.png", false); // <img> 报错
  // 一个真实的失败观察**可以**推翻它（那是新证据），但 INCONCLUSIVE 不行
  assert.equal(p.stateOf("/api/uploads/proj/a.png"), MISSING);
  const q = createMediaProbe({ fetchImpl: null });
  q.applyAudit(["/api/uploads/proj/b.png"], "proj", audit([]));
  assert.equal(q.stateOf("/api/uploads/proj/b.png"), MISSING);
  assert.notEqual(q.stateOf("/api/uploads/proj/b.png"), INCONCLUSIVE);
});

test("重复折同一份审计不再报「变了」，调用方就不会无限重渲染", () => {
  const p = createMediaProbe({ fetchImpl: null });
  const urls = ["/api/uploads/proj/a.png"];
  assert.equal(p.applyAudit(urls, "proj", audit(["a.png"])), true);
  assert.equal(p.applyAudit(urls, "proj", audit(["a.png"])), false);
});
