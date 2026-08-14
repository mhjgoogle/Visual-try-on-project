// TASK-072 §1.4 — the one transport, and the contracts its callers depend on.
//
// Every case here is a finding from the batch-1 independent review. They are kept as
// tests rather than as fixes-plus-a-comment because each one is silent when wrong:
// a re-downloaded media file, an uncancellable body read, a status flattened to 200.
import test from "node:test";
import assert from "node:assert/strict";

import { request, attempt, ApiError, API_ERROR, legacyError } from "../src/services/apiclient.js";

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
  for (const status of [200, 201, 204]) {
    stubFetch(() => jsonRes(status, { n: status }));
    const r = await attempt("/api/x");
    assert.equal(r.ok, true);
    assert.equal(r.status, status, `status ${status} was flattened`);
    assert.deepEqual(r.data, { n: status });
  }
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
