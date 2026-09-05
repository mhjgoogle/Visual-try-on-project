// TASK-072 §1.4 — the one transport, and the contracts its callers depend on.
//
// Every case here is a finding from the batch-1 independent review. They are kept as
// tests rather than as fixes-plus-a-comment because each one is silent when wrong:
// a re-downloaded media file, an uncancellable body read, a status flattened to 200.
import test from "node:test";
import assert from "node:assert/strict";

import { request, attempt, ApiError, API_ERROR, legacyError } from "../src/services/apiclient.js";
import { buildEnvelope, preflight, submit, newOperationId, submitCommand } from "../src/services/command.js";
import * as command from "../src/services/command.js";
import * as query from "../src/services/query.js";

/** Install a fake fetch and record what it was called with. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  return calls;
}

const jsonRes = (status, body, { ctype = "application/json" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => ctype },
  json: async () => body,
});

test("`no-store` is for JSON reads — a raw BYTE read keeps its caching", () => {
  // `fetchAsDataUrl` / `sha256OfUrl` pull whole media files; forcing a re-download on
  // every preview or hash is pure waste (independent review, batch 1).
  const calls = stubFetch(() => jsonRes(200, { a: 1 }));
  return request("/api/x").then(async () => {
    assert.equal(calls[0].init.cache, "no-store");
    await request("/media/x.mp4", { expect: "raw" });
    assert.equal("cache" in calls[1].init, false, "a raw read must not force no-store");
  });
});

test("the real status travels with the body: 200, 201 and 204 stay distinct", async () => {
  // `attempt` used to hardcode 200, so `query.js:_call` callers could not tell them
  // apart — and `createProject` genuinely answers 201.
  for (const status of [200, 201]) {
    stubFetch(() => jsonRes(status, { n: status }));
    const r = await attempt("/api/x");
    assert.equal(r.ok, true);
    assert.equal(r.status, status, `status ${status} was flattened`);
    assert.deepEqual(r.data, { n: status });
  }
  // A REAL 204 has an EMPTY body, so `res.json()` throws and the response is
  // reported MALFORMED. Asserted as-is rather than stubbed with a JSON body the
  // shape never has (independent review): no endpoint in this app answers 204 today,
  // and making the transport tolerate it is a contract change, not a test fix.
  stubFetch(() => ({
    ok: true, status: 204,
    headers: { get: () => "application/json" },
    json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
  }));
  const noContent = await attempt("/api/x");
  assert.equal(noContent.ok, false);
  assert.equal(noContent.error.category, API_ERROR.MALFORMED);
  // …and `request` still resolves to the BODY, unwrapped once, at the seam
  stubFetch(() => jsonRes(201, { a: 1 }));
  assert.deepEqual(await request("/api/x"), { a: 1 });
});

test("the deadline covers the BODY read, not just the headers", async () => {
  // `fetch` resolves when the headers arrive. Releasing the timer there left
  // `.json()` unbounded — a slow body hung forever despite a timeout being set.
  let aborted = false;
  stubFetch((_p, init) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    // A body that never arrives, and that REJECTS on abort — which is what a real
    // Response body does. (A stub ignoring the signal would hang this test forever
    // and prove nothing about the deadline.)
    json: () => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    }),
  }));
  await assert.rejects(
    () => request("/api/x", { timeoutMs: 30 }),
    (e) => e instanceof ApiError && e.category === API_ERROR.TIMEOUT,
  );
  assert.equal(aborted, true, "the body read must be abortable by the deadline");
});

test("a caller's abort reads as ABORTED, a deadline as TIMEOUT", async () => {
  // two different facts: reporting a timeout as a cancellation hides a backend fault
  stubFetch((_p, init) => new Promise((_r, rej) => {
    init.signal.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      rej(e);
    });
  }));
  const ctl = new AbortController();
  const p = request("/api/x", { signal: ctl.signal, timeoutMs: 0 });
  ctl.abort();
  await assert.rejects(p, (e) => e.category === API_ERROR.ABORTED);
  await assert.rejects(
    () => request("/api/x", { timeoutMs: 20 }),
    (e) => e.category === API_ERROR.TIMEOUT,
  );
});

test("a write is NEVER retried by the transport", async () => {
  // 系统合同 §5.8: a request that may already have been applied must not be replayed
  // by a layer that cannot know whether it took effect.
  let n = 0;
  stubFetch(() => { n += 1; throw new Error("network down"); });
  await assert.rejects(() => request("/api/x", { method: "POST", body: {} }));
  assert.equal(n, 1, "a POST must be attempted exactly once");
  n = 0;
  await assert.rejects(() => request("/api/x", { retries: 2 }));
  assert.equal(n, 3, "a GET may retry transport faults");
});

test("`attempt` retries GET faults exactly like `request` does", async () => {
  // An earlier fix had `attempt` call `once` directly to get at the real status,
  // which silently dropped the retry for detectMode / fetchSkillCatalog / fsList /
  // probeExecutors. The worst case: ONE transient fault on /api/meta then pins the
  // whole session to demo mode — a backend fault rendered as 「按设计没有后端」.
  let n = 0;
  stubFetch(() => {
    n += 1;
    if (n === 1) throw new Error("transient");
    return jsonRes(200, { mode: "connected" });
  });
  const r = await attempt("/api/meta");
  assert.equal(n, 2, "attempt must retry a transient GET fault");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { mode: "connected" });

  // …and it honours an explicit budget, like request
  n = 0;
  stubFetch(() => { n += 1; throw new Error("down"); });
  const dead = await attempt("/api/x", { retries: 2 });
  assert.equal(n, 3);
  assert.equal(dead.ok, false);

  // a WRITE is still never retried, on either entry point
  n = 0;
  stubFetch(() => { n += 1; throw new Error("down"); });
  await attempt("/api/x", { method: "POST", body: {} });
  assert.equal(n, 1, "a POST must be attempted exactly once");
});

test("legacyError keeps the BACKEND's category, not the transport class", () => {
  // the skill panel's hint table is keyed on `unavailable` / `unauthenticated` /
  // `invalid_output`; replacing them with `client`/`server` blanks every message
  const e = new ApiError(API_ERROR.SERVER, {
    status: 502,
    detail: "执行器不可用",
    body: { error: { category: "unavailable", detail: "执行器不可用", raw_excerpt: "..." } },
  });
  const legacy = legacyError(e, "agent");
  assert.equal(legacy.category, "unavailable");
  assert.equal(legacy.status, 502);
  assert.equal(legacy.rawExcerpt, "...");
  // with no backend body it falls back to the transport class rather than inventing one
  assert.equal(legacyError(new ApiError(API_ERROR.OFFLINE, {}), "x").category, "offline");
});

test("a 200 of HTML is MALFORMED, not data", async () => {
  // the signature of a dev server serving index.html for an unknown /api path
  stubFetch(() => jsonRes(200, null, { ctype: "text/html" }));
  await assert.rejects(
    () => request("/api/x"),
    (e) => e.category === API_ERROR.MALFORMED,
  );
});

/* --- §1.4 落点表: Envelope 构造 + preflight + submit 归位 ------------------- */

test("the Envelope has ONE constructor, and it refuses an unlocatable command", () => {
  const e = buildEnvelope("lock-draft-plan", { digest: "d1" }, { shots: [] });
  assert.equal(e.name, "lock-draft-plan");
  assert.deepEqual(e.target, { digest: "d1" });
  assert.deepEqual(e.params, { shots: [] });
  assert.match(e.command_id, /^cmd-/);
  // `actor` is the BACKEND's to set — a browser-sent one is a claim it cannot make
  assert.equal("actor" in e, false);

  // a missing target does not fail loudly at the call site; it fails as a command the
  // gateway cannot locate, AFTER the creator confirmed a cost
  for (const bad of [null, undefined, ""]) {
    assert.throws(() => buildEnvelope("x", bad, {}), /缺少 target/);
  }
  assert.throws(() => buildEnvelope("", { d: 1 }, {}), /缺少 name/);
  assert.throws(() => buildEnvelope("x", { d: 1 }, "not-an-object"), /params 必须是对象/);
});

test("two envelopes built in the same millisecond get DIFFERENT command ids", () => {
  // the batch path builds one per shot in a tight loop; `Date.now()` alone collided,
  // and two commands sharing an id is indistinguishable from a replay
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(buildEnvelope("n", { d: 1 }, {}).command_id);
  assert.equal(ids.size, 50);
  // an explicit id (correlated with operation_id) is honoured verbatim
  assert.equal(buildEnvelope("n", { d: 1 }, {}, "cmd-op-7").command_id, "cmd-op-7");
});

test("submit REFUSES to fire without the preflight digest it was confirmed against", async () => {
  const calls = stubFetch(() => jsonRes(200, { preflight_digest: "pf-1" }));
  await preflight("p", buildEnvelope("n", { d: 1 }, {}));
  assert.match(calls[0].path, /\/api\/projects\/p\/preflight$/);
  assert.equal(calls[0].init.method, "POST");
  // step 2 without step 2's authorisation is not a write we are willing to attempt
  for (const missing of [undefined, null, ""]) {
    await assert.rejects(() => submit("p", buildEnvelope("n", { d: 1 }, {}), missing), /确认摘要/);
  }
  assert.equal(calls.length, 1, "no request may leave for an unconfirmed submit");
  const receipt = await submit("p", buildEnvelope("n", { d: 1 }, {}), "pf-1");
  assert.equal(JSON.parse(calls[1].init.body).confirmation, "pf-1");
  assert.ok(receipt);
});

test("the write path and the read coordinates now come from the seam that names them", () => {
  // 「这一次调用会不会改东西」 must be answerable from the module, which is the whole
  // point of the split — so this asserts WHERE each one lives, not just that it exists.
  for (const w of ["buildEnvelope", "preflight", "submit", "adoptPaid", "submitCommand"]) {
    assert.equal(typeof command[w], "function", `${w} must be a WRITE`);
    assert.equal(w in query, false, `${w} writes — it must not be reachable from query.js`);
  }
  for (const r of ["getGenerationTarget", "getLockTarget", "paidOps"]) {
    assert.equal(typeof query[r], "function", `${r} must be a READ`);
    assert.equal(r in command, false, `${r} only reads — it must not sit in command.js`);
  }
  // 原本这里还有两组断言，钉的是 `services/gateway.js` 那个兼容层「re-export 而
  // 不是重新实现，所以不会漂移」。**那个文件在 TASK-074 §1.5 批次 3 删掉了**
  // （它自己的文件头就写着「TASK-074 §1.5 deletes the file once nothing imports
  // it」，而 `src/` 里确实一个 import 都没有了）。层没了，「层会不会漂移」这个
  // 问题也就不存在了 —— 上面那两组「谁只读、谁只写」的断言才是真正要长期成立的。
});

test("the MONEY paths get their uniqueness from the operation id, not the envelope", () => {
  // both paid paths correlate the two ids by construction (`cmd-${opId}`) and so pass
  // an EXPLICIT command id — which means buildEnvelope's own suffix never applied to
  // them, and only the lock path benefited from it (independent review).
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(newOperationId());
  assert.equal(ids.size, 50);
  assert.match(newOperationId(), /^op-ui-/);
  assert.match(newOperationId("op-ui-3-"), /^op-ui-3-/);
  // and the derived command ids inherit that uniqueness
  const cmds = new Set();
  for (let i = 0; i < 50; i++) {
    cmds.add(buildEnvelope("submit-video-generation", { d: 1 }, {}, "cmd-" + newOperationId()).command_id);
  }
  assert.equal(cmds.size, 50);
});

test("the demo stub represents 「没有目标」 instead of inventing one", () => {
  // routing it through `buildEnvelope` meant substituting a made-up target, because
  // refusing a missing target is exactly what the real constructor is for
  const r = submitCommand({ name: "generate", params: { kind: "image" } });
  assert.equal(r.status, "accepted");
  assert.equal(r.command.target, null);
  assert.equal(r.command.actor, "user");
  assert.deepEqual(r.command.params, { kind: "image" });
  assert.notEqual(
    submitCommand({ name: "a" }).command.command_id,
    submitCommand({ name: "a" }).command.command_id,
  );
});

// --- 免费自动出图（TASK-139 / ADR-0100 · REQ-008 判据 2/5）-------------------

test("免费出图不带金额：请求体里没有 confirm_usd", async () => {
  const calls = stubFetch(() => jsonRes(200, { ok: true, billing: "account-quota" }));
  const res = await command.accountImageGenerate("作品", "hero", "一只猫");
  assert.equal(res.billing, "account-quota");
  assert.equal(calls[0].path, "/api/agent/image-gen-account");
  const sent = JSON.parse(calls[0].init.body);
  // 这条路上没有金额可确认 —— 出现 confirm_usd 就说明有人把付费那条的形状抄了过来
  assert.equal("confirm_usd" in sent, false);
  assert.deepEqual(sent, { project: "作品", slug: "hero", prompt: "一只猫" });
  // 同意也不能被顺手带上：不传就不该出现在报文里
  assert.equal("acknowledge_unknown" in sent, false);
});

test("同意只在显式布尔真时才发出去", async () => {
  let calls = stubFetch(() => jsonRes(200, { ok: true }));
  await command.accountImageGenerate("作品", "hero", "猫", "true");
  assert.equal("acknowledge_unknown" in JSON.parse(calls[0].init.body), false,
    "字符串 'true' 不是同意 —— 后端也只认布尔真");
  calls = stubFetch(() => jsonRes(200, { ok: true }));
  await command.accountImageGenerate("作品", "hero", "猫", true);
  assert.equal(JSON.parse(calls[0].init.body).acknowledge_unknown, true);
});

test("只有 side_effect=none 才敢标失败 —— 其余都可能已经消耗过", async () => {
  // 合同 §5.8：把 unknown / applied 记成一次干净的失败，会让下一次重试
  // 看起来是干净的第一次。
  for (const [se, definitive] of [["none", true], ["unknown", false], ["applied", false]]) {
    stubFetch(() => jsonRes(429, { error: { category: "quota_exhausted", side_effect: se, detail: "x" } }));
    const err = await command.accountImageGenerate("作品", "hero", "猫").then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `side_effect=${se} 应当抛错`);
    assert.equal(err.sideEffect, se);
    assert.equal(!!err.definitiveReject, definitive, `side_effect=${se}`);
    assert.equal(err.category, "quota_exhausted", "具名类别要带到界面上");
  }
});
