// Canvas persistence schema-version dispatch (checkpoint M1) — run via
// `node --test`. Owned by the frontend suite (gate frontend tier + CI).
//
// Covers: explicit version read, sequential migration chain, v1 compatibility,
// fail-safe rejection of newer/invalid documents, save blocking after a
// fail-safe load, unknown-field preservation across the save round-trip, and
// consistent server/localStorage behavior.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANVAS_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
  migrateToCurrent,
} from "../src/services/canvasschema.js";
import { loadCanvas, saveCanvas, saveBlockedReason, blockSaves, unblockSaves } from "../src/services/persist.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A realistic v1 document — the shapes a real save carries today (scriptDoc,
// versioned drafts, MediaRef upload chains, firstFrames, finals, pan).
function v1Doc() {
  return {
    v: 1,
    project: "demo",
    scriptDoc: {
      brief: "被囚禁",
      versions: [{ v: 1, content: "【废弃仓库·夜】…", instruction: "", origin: "generated", basedOn: null, status: "done" }],
      active: 1,
      workingText: null,
    },
    nodes: [
      { id: "n1", type: "script", x: 0, y: 40, state: "", text: "" },
      {
        id: "n2", type: "scriptgen", x: 360, y: 40, state: "done", cur: 1,
        versions: [{ v: 1, draft: true, shots: [["01", "夜色海面（6s）"]], raw: [{ slot: "v1-1", description: "夜色海面" }] }],
      },
      {
        id: "n3", type: "assets", x: 720, y: 10, state: "done",
        uploads: { "v1-1": { current: 1, history: [{ slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/api/uploads/demo/assets-v1-1.png" }] } },
        firstFrames: { "v1-1": "/api/uploads/demo/assets-v1-1.png" },
        finals: {},
      },
    ],
    edges: [{ from: "n1", to: "n2", state: "done" }, { from: "n2", to: "n3", state: "" }],
    pan: { x: -20, y: 12 },
  };
}

// --- schema constants -------------------------------------------------------

test("the migration chain is unbroken from v1 to the current version", () => {
  // The chain must be COMPLETE and CONTIGUOUS — a gap would strand every older
  // save. Derived from CANVAS_SCHEMA_VERSION rather than a hand-written list so
  // a legitimate new migration extends it instead of breaking this test.
  const steps = Array.from({ length: CANVAS_SCHEMA_VERSION - 1 }, (_, i) => String(i + 1));
  assert.deepEqual(Object.keys(MIGRATIONS), steps);
  for (const k of steps) assert.equal(typeof MIGRATIONS[k], "function");
});

test("readSchemaVersion: explicit, legacy-missing, malformed", () => {
  assert.equal(readSchemaVersion({ v: 1 }), 1);
  assert.equal(readSchemaVersion({ v: 7 }), 7);
  assert.equal(readSchemaVersion({ nodes: [] }), 1); // pre-marker saves are shape-v1
  assert.equal(readSchemaVersion({ v: 0 }), null);
  assert.equal(readSchemaVersion({ v: "1" }), null);
  assert.equal(readSchemaVersion({ v: 1.5 }), null);
});

// --- dispatch: current / legacy / empty ------------------------------------

test("existing v1 save migrates to current without mutating the input", () => {
  const doc = v1Doc();
  const snapshot = structuredClone(doc);
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.equal(res.fromVersion, 1);
  assert.notEqual(res.doc, doc); // migrated on a deep copy…
  assert.deepEqual(doc, snapshot); // …the caller's object is never touched
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
});

test("current-version (v2) save loads as-is with no rewriting", () => {
  const doc = migrateToCurrent(v1Doc()).doc; // a genuine v2 document
  const snapshot = structuredClone(doc);
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.equal(res.fromVersion, CANVAS_SCHEMA_VERSION);
  assert.equal(res.doc, doc); // current version: returned untouched
  assert.deepEqual(doc, snapshot);
});

test("document without a version marker is dispatched as v1", () => {
  const doc = v1Doc();
  delete doc.v;
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.equal(res.fromVersion, 1);
});

test("null / absent / {} dispatch to empty, never to a fake document", () => {
  assert.equal(migrateToCurrent(null).status, "empty");
  assert.equal(migrateToCurrent(undefined).status, "empty");
  assert.equal(migrateToCurrent({}).status, "empty");
});

test("REAL saved project fixtures (data/*.json) dispatch ok", async () => {
  const fs = await import("node:fs");
  for (const rel of ["../data/evidence-demo.json", "../data/wfm1-demo.json"]) {
    const p = new URL(rel, import.meta.url);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf-8"));
    const res = migrateToCurrent(doc);
    assert.equal(res.status, "ok", `${rel}: ${res.detail || res.status}`);
    // data/*.json are gitignored runtime scratch — their on-disk version may
    // be anything from 1 to current. Whatever it is, dispatch must reach the
    // authoritative current version.
    assert.ok(res.fromVersion >= 1 && res.fromVersion <= CANVAS_SCHEMA_VERSION, `${rel}: from ${res.fromVersion}`);
    assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  }
});

// --- dispatch: fail-safe rejection ------------------------------------------

test("unsupported NEWER schema version is rejected, not reinterpreted", () => {
  const doc = { ...v1Doc(), v: CANVAS_SCHEMA_VERSION + 1 };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "unsupported");
  assert.equal(res.version, CANVAS_SCHEMA_VERSION + 1);
  assert.equal(res.doc, undefined);
});

test("malformed documents are invalid, not silently empty", () => {
  for (const raw of [[1, 2], "nope", 42, { v: 0 }, { v: "1" }, { v: -3, nodes: [] }]) {
    const res = migrateToCurrent(raw);
    assert.equal(res.status, "invalid", `raw=${JSON.stringify(raw)}`);
  }
});

test("valid JSON with malformed owned canvas fields fails safe as invalid", () => {
  // Dispatching these "ok" would blank the canvas and let autosave overwrite
  // the malformed-but-possibly-recoverable stored document.
  for (const raw of [
    { v: 1, bad: true }, // non-empty but no nodes at all
    { v: 1, nodes: "oops" },
    { v: 1, nodes: {} },
    { v: 1, nodes: [], edges: 5 },
    { v: 1, nodes: [], pan: [1, 2] },
    { v: 1, nodes: [], scriptDoc: "text" },
    { v: 1, nodes: [], project: 42 },
    { v: 1, nodes: [null] }, // element-level: restore would throw mid-way
    { v: 1, nodes: ["str"] },
    { v: 1, nodes: [{ x: 1 }] }, // node without a type
    { v: 1, nodes: [{ type: "script", versions: "oops" }] },
    { v: 1, nodes: [{ type: "assets", uploads: 5 }] },
    { v: 1, nodes: [{ type: "video", firstFrames: [1] }] },
    { v: 1, nodes: [{ type: "edit", finals: "clip.mp4" }] },
    { v: 1, nodes: [], edges: [null] },
  ]) {
    const res = migrateToCurrent(raw);
    assert.equal(res.status, "invalid", `raw=${JSON.stringify(raw)}`);
  }
  // a genuinely saved empty canvas (nodes: []) stays loadable
  assert.equal(migrateToCurrent({ v: 1, nodes: [], edges: [], scriptDoc: null }).status, "ok");
  // real-save shapes stay loadable: list finals (edit node), map finals
  assert.equal(migrateToCurrent({ v: 1, nodes: [{ type: "edit", finals: [] }] }).status, "ok");
  assert.equal(migrateToCurrent({ v: 1, nodes: [{ type: "video", finals: {} }] }).status, "ok");
});

// --- dispatch: sequential migration chain (injected, not shipped) -----------

test("migrations chain sequentially and preserve unknown fields", () => {
  const order = [];
  const migrations = {
    1: (d) => { order.push("1→2"); return { ...d, renamedIn2: d.legacyField }; },
    // a real v3 carries the assets registry; add it so the result is schema-valid
    2: (d) => { order.push("2→3"); return { ...d, assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] } }; },
  };
  const raw = { v: 1, legacyField: "keep-me", futureUnknown: { nested: true }, nodes: [] };
  const before = structuredClone(raw);
  const res = migrateToCurrent(raw, { migrations, current: 3 });
  assert.equal(res.status, "ok");
  assert.deepEqual(order, ["1→2", "2→3"]);
  assert.equal(res.doc.v, 3); // dispatcher stamps the version
  assert.equal(res.doc.renamedIn2, "keep-me");
  assert.deepEqual(res.doc.futureUnknown, { nested: true }); // untouched pass-through
  assert.deepEqual(raw, before); // input never mutated (deep copy)
});

test("a gap in the migration chain fails safe as invalid", () => {
  const res = migrateToCurrent({ v: 1, nodes: [] }, { migrations: { 2: (d) => d }, current: 3 });
  assert.equal(res.status, "invalid");
});

test("a migration returning a non-document fails safe as invalid", () => {
  const res = migrateToCurrent({ v: 1 }, { migrations: { 1: () => null }, current: 2 });
  assert.equal(res.status, "invalid");
});

// --- persist: server + localStorage paths through the dispatcher ------------

function stubEnv({ fetchImpl, store }) {
  globalThis.fetch = fetchImpl;
  const map = store ?? new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
  return map;
}
const noBackend = async () => { throw new TypeError("fetch failed"); };
const jsonHeaders = { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) };
const htmlHeaders = { get: (k) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) };
const okJson = (payload) => async () => ({ ok: true, status: 200, headers: jsonHeaders, json: async () => payload });

test("server v1 document loads ok and allows saving", async () => {
  stubEnv({ fetchImpl: okJson(v1Doc()) });
  const res = await loadCanvas("srv-ok");
  assert.equal(res.status, "ok");
  assert.equal(res.doc.project, "demo");
  assert.equal(saveBlockedReason("srv-ok"), null);
});

test("server 409 corrupt_save blocks saves and never falls back to localStorage", async () => {
  const store = stubEnv({
    fetchImpl: async () => ({ ok: false, status: 409, headers: jsonHeaders, json: async () => ({ error: { category: "corrupt_save" } }) }),
  });
  store.set("motv:srv-corrupt", JSON.stringify(v1Doc())); // must NOT be used
  const res = await loadCanvas("srv-corrupt");
  assert.equal(res.status, "corrupt");
  assert.equal(saveBlockedReason("srv-corrupt").reason, "corrupt");
  // a blocked save is a no-op: no PUT, no localStorage write
  let putCalled = false;
  globalThis.fetch = async () => { putCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  saveCanvas("srv-corrupt", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);
  assert.equal(putCalled, false);
  assert.equal(store.get("motv:srv-corrupt"), JSON.stringify(v1Doc()));
});

test("corrupt localStorage save blocks saving and leaves the stored bytes intact", async () => {
  const store = stubEnv({ fetchImpl: noBackend });
  store.set("motv:ls-corrupt", "{definitely not json");
  const res = await loadCanvas("ls-corrupt");
  assert.equal(res.status, "corrupt");
  saveCanvas("ls-corrupt", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);
  assert.equal(store.get("motv:ls-corrupt"), "{definitely not json");
});

test("newer-version localStorage save is rejected and protected from overwrite", async () => {
  const newer = JSON.stringify({ ...v1Doc(), v: CANVAS_SCHEMA_VERSION + 1 });
  const store = stubEnv({ fetchImpl: noBackend });
  store.set("motv:ls-newer", newer);
  const res = await loadCanvas("ls-newer");
  assert.equal(res.status, "unsupported");
  saveCanvas("ls-newer", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);
  assert.equal(store.get("motv:ls-newer"), newer);
});

test("round-trip: v1 load → save re-emits current version and keeps unknown fields", async () => {
  const doc = { ...v1Doc(), futureField: { fromNextCheckpoint: 1 } };
  let putBody = null;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "PUT") { putBody = JSON.parse(opts.body); return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => doc };
  };
  const res = await loadCanvas("rt");
  assert.equal(res.status, "ok");
  saveCanvas("rt", { v: CANVAS_SCHEMA_VERSION, project: "rt", scriptDoc: doc.scriptDoc, nodes: doc.nodes, edges: doc.edges, pan: doc.pan });
  await sleep(850);
  assert.ok(putBody, "PUT fired");
  assert.equal(putBody.v, CANVAS_SCHEMA_VERSION); // authoritative version emitted
  assert.deepEqual(putBody.futureField, { fromNextCheckpoint: 1 }); // unknown field survived
  assert.deepEqual(putBody.nodes, doc.nodes);
  assert.deepEqual(putBody.scriptDoc, doc.scriptDoc);
});

test("static host responses (non-JSON) keep the localStorage fallback", async () => {
  // 404 from a plain static file server
  let store = stubEnv({
    fetchImpl: async () => ({ ok: false, status: 404, headers: htmlHeaders, json: async () => { throw new SyntaxError("html"); } }),
  });
  store.set("motv:static-404", JSON.stringify(v1Doc()));
  let res = await loadCanvas("static-404");
  assert.equal(res.status, "ok");
  assert.equal(saveBlockedReason("static-404"), null);
  // 200 HTML from an index-fallback host
  store = stubEnv({
    fetchImpl: async () => ({ ok: true, status: 200, headers: htmlHeaders, json: async () => { throw new SyntaxError("html"); } }),
  });
  store.set("motv:static-200", JSON.stringify(v1Doc()));
  res = await loadCanvas("static-200");
  assert.equal(res.status, "ok");
});

test("a save queued BEFORE a blocking load cannot fire after it", async () => {
  const store = stubEnv({ fetchImpl: noBackend });
  store.set("motv:race", JSON.stringify(v1Doc()));
  assert.equal((await loadCanvas("race")).status, "ok");
  saveCanvas("race", { v: CANVAS_SCHEMA_VERSION, nodes: [] }); // queued, not yet fired
  store.set("motv:race", "{broken"); // store corrupts before the debounce fires
  assert.equal((await loadCanvas("race")).status, "corrupt");
  await sleep(850);
  assert.equal(store.get("motv:race"), "{broken"); // queued write was suppressed
});

test("a queued save cannot fire while a SLOW blocking load is still in flight", async () => {
  // the 409 arrives only after the debounce would have fired — entry into
  // loadCanvas must already have cancelled the queued write
  let putCalled = false;
  stubEnv({
    fetchImpl: (url, opts) => {
      if (opts && opts.method === "PUT") { putCalled = true; return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => ({}) }); }
      return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 409, headers: jsonHeaders, json: async () => ({ error: { category: "corrupt_save" } }) }), 800));
    },
  });
  saveCanvas("slowrace", { v: CANVAS_SCHEMA_VERSION, nodes: [] }); // queued
  const res = await loadCanvas("slowrace"); // cancels the queued save at entry
  assert.equal(res.status, "corrupt");
  await sleep(850);
  assert.equal(putCalled, false);
});

test("a save attempted DURING an in-flight load is dropped, not queued", async () => {
  let putCalled = false;
  stubEnv({
    fetchImpl: (url, opts) => {
      if (opts && opts.method === "PUT") { putCalled = true; return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => ({}) }); }
      return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 409, headers: jsonHeaders, json: async () => ({ error: { category: "corrupt_save" } }) }), 300));
    },
  });
  const p = loadCanvas("midflight");
  saveCanvas("midflight", { v: CANVAS_SCHEMA_VERSION, nodes: [] }); // load in flight → refused
  assert.equal((await p).status, "corrupt");
  await sleep(850);
  assert.equal(putCalled, false);
});

test("concurrent loads: a fast load completing does not release a slower pending one", async () => {
  // load A (fast, ok) and load B (slow, corrupt) overlap; after A settles a
  // save must STILL be refused because B holds the latch until it blocks.
  let putCalled = false;
  let call = 0;
  stubEnv({
    fetchImpl: (url, opts) => {
      if (opts && opts.method === "PUT") { putCalled = true; return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => ({}) }); }
      call += 1;
      if (call === 1) return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => v1Doc() });
      return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 409, headers: jsonHeaders, json: async () => ({ error: { category: "corrupt_save" } }) }), 300));
    },
  });
  const fast = loadCanvas("dual");
  const slow = loadCanvas("dual");
  assert.equal((await fast).status, "ok");
  saveCanvas("dual", { v: CANVAS_SCHEMA_VERSION, nodes: [] }); // slow still in flight → refused
  assert.equal((await slow).status, "corrupt");
  await sleep(850);
  assert.equal(putCalled, false);
  assert.ok(saveBlockedReason("dual"));
});

test("a slow stale success cannot clear a block set by a fresher failed load", async () => {
  // load A (slow, would succeed) starts first; load B (fast, corrupt) starts
  // second. Loads are serialized per name, so B runs AFTER A and its verdict
  // — from the freshest read — is final: the project stays blocked.
  let putCalled = false;
  let call = 0;
  stubEnv({
    fetchImpl: (url, opts) => {
      if (opts && opts.method === "PUT") { putCalled = true; return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => ({}) }); }
      call += 1;
      if (call === 1) return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, headers: jsonHeaders, json: async () => v1Doc() }), 400));
      return Promise.resolve({ ok: false, status: 409, headers: jsonHeaders, json: async () => ({ error: { category: "corrupt_save" } }) });
    },
  });
  const a = loadCanvas("stale");
  const b = loadCanvas("stale");
  assert.equal((await a).status, "ok");
  assert.equal((await b).status, "corrupt");
  assert.ok(saveBlockedReason("stale")); // the LATEST read wins
  saveCanvas("stale", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);
  assert.equal(putCalled, false);
});

test("canvas names shadowing Object.prototype work end to end", async () => {
  for (const name of ["constructor", "__proto__", "hasOwnProperty"]) {
    const store = stubEnv({ fetchImpl: noBackend });
    store.set("motv:" + name, JSON.stringify(v1Doc()));
    const res = await loadCanvas(name);
    assert.equal(res.status, "ok", name);
    assert.equal(saveBlockedReason(name), null, name);
    saveCanvas(name, { v: CANVAS_SCHEMA_VERSION, nodes: [] });
    await sleep(850);
    assert.equal(JSON.parse(store.get("motv:" + name)).v, CANVAS_SCHEMA_VERSION, name);
    // and a corrupt store still blocks under these names
    store.set("motv:" + name, "{broken");
    assert.equal((await loadCanvas(name)).status, "corrupt", name);
    saveCanvas(name, { v: CANVAS_SCHEMA_VERSION, nodes: [] });
    await sleep(850);
    assert.equal(store.get("motv:" + name), "{broken", name);
  }
});

test("an unknown top-level __proto__ field survives the save round-trip", async () => {
  // JSON.parse creates `__proto__` as an OWN property; the extras stash must
  // keep it that way instead of mutating a prototype and dropping it.
  const raw = `{"v":1,"nodes":[],"__proto__":{"fromFuture":1}}`;
  let putBody = null;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "PUT") { putBody = opts.body; return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({}) }; }
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => JSON.parse(raw) };
  };
  assert.equal((await loadCanvas("proto-extra")).status, "ok");
  saveCanvas("proto-extra", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);
  assert.ok(putBody.includes('"__proto__":{"fromFuture":1}'), putBody);
});

test("empty then valid load: no save exists → saving allowed; later corrupt load re-blocks", async () => {
  stubEnv({ fetchImpl: okJson({}) });
  assert.equal((await loadCanvas("cycle")).status, "empty");
  assert.equal(saveBlockedReason("cycle"), null);
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: jsonHeaders, json: async () => ({ error: { category: "read_failed" } }) });
  assert.equal((await loadCanvas("cycle")).status, "unavailable");
  assert.ok(saveBlockedReason("cycle"));
  // a subsequent healthy load clears the block
  globalThis.fetch = okJson(v1Doc());
  assert.equal((await loadCanvas("cycle")).status, "ok");
  assert.equal(saveBlockedReason("cycle"), null);
});

// --- TASK-105 审查轮 5：调用方知道的理由也能停用自动保存 -------------------- //

test("blockSaves 让一次自动保存变成 no-op —— 空白画布不会被存成开局", async () => {
  const store = stubEnv({ fetchImpl: okJson(v1Doc()) });

  // 场景：项目是全新的（还没有画布），而「它从哪份模板起步」这一问读失败了。
  // 照常走下去会 restore 一张空白画布并把它自动保存 —— 刷新之后看到的是一张
  // 已保存的空画布，于是永远不会再去取模板：一次瞬时失败把创作者的选择**永久**
  // 丢掉了（codex 审查轮 5）。
  blockSaves("flow-unreadable", "flow_unreadable", "读不到 studio/flow.json");
  assert.equal(saveBlockedReason("flow-unreadable").reason, "flow_unreadable");

  let putCalled = false;
  globalThis.fetch = async () => { putCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  saveCanvas("flow-unreadable", { v: CANVAS_SCHEMA_VERSION, nodes: [] });
  await sleep(850);

  assert.equal(putCalled, false, "被停用之后不得发出任何 PUT");
  assert.equal(store.get("motv:flow-unreadable"), undefined, "也不得落到 localStorage");
});

test("blockSaves 对空项目名是无害的空操作", () => {
  assert.equal(blockSaves("", "x", "y"), null);
  assert.equal(blockSaves(null, "x", "y"), null);
});

test("blockSaves 不覆盖已有的停用理由 —— 第一个声明者说了算", () => {
  // 覆盖会让一个较轻的理由顶掉较重的：`flow_pending` 压在 `corrupt` 上面，
  // 然后它自己的 unblockSaves 把唯一那条删掉，于是自动保存在一份**仍然读不出来**
  // 的存档上恢复了（codex 审查轮 9）。
  blockSaves("layered", "corrupt", "存档读不出来");
  blockSaves("layered", "flow_pending", "还没确定模板");
  assert.equal(saveBlockedReason("layered").reason, "corrupt", "第一个说了算");

  // 而按后来那个理由去解除，什么也不该发生
  unblockSaves("layered", "flow_pending");
  assert.equal(saveBlockedReason("layered").reason, "corrupt", "仍然停用");

  // 只有按**它自己**的理由才解得开
  unblockSaves("layered", "corrupt");
  assert.equal(saveBlockedReason("layered"), null);
});

/* --- 存不下就得说出来（2026-09-05）------------------------------------------ */

test("排队中的写在触发时被丢掉，必须出声 —— 这条是真跑，不是扫源码", async () => {
  // **这条守的是 2026-09-05 那次 1/5 静默丢字的真正机制。**
  //
  // `saveCanvas` 入口处的 `_blocked` / `_loading` 两道检查都会 `console.warn`，
  // 但去抖定时器（700ms）**触发时**还会复查一次 —— 而那一处原来是
  //     if (_blocked.has(name) || _loading.get(name)) { _pendingSaves.delete(name); return; }
  // **一声不吭地把排队中的那次写删掉**。于是：字在屏幕上、盘上没有、控制台干净。
  //
  // 「没有警告」把排查引向了别处（并行会话据此推断「根本没走到 ctx.persist」）——
  // **静默失败最贵的地方不是丢了东西，是它让你去查不相干的地方。**
  //
  // codex 点过上一版这条守卫：它「扫源码文本，没有真的驱动那条通知」。这一版真跑。
  const seen = [];
  const realWarn = console.warn;
  console.warn = (...a) => seen.push(a.join(" "));
  const realFetch = globalThis.fetch;
  globalThis.fetch = okJson({ ok: true });
  try {
    saveCanvas("排队项目", { nodes: [] });      // 排队，700ms 后才写
    blockSaves("排队项目", "TEST", "测试用");    // 在它触发之前把这个项目停用
    await sleep(900);                            // 让定时器真的触发一次
  } finally {
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    unblockSaves("排队项目", "TEST");
  }
  const dropped = seen.filter((t) => /dropped at flush time/.test(t));
  assert.equal(dropped.length, 1, `丢弃时没有出声；看到的是：${JSON.stringify(seen)}`);
  assert.match(dropped[0], /排队项目/, "没说是哪个项目");
  assert.match(dropped[0], /TEST|没有写下去/, "没说为什么");
});

/* --- 载入期间那把锁：codex 2026-09-05 判的两条 P1，用真调用钉住 -------------- */

/** 一个够用的 DOM 替身。这把锁只需要 `classList` 和 `querySelectorAll`。 */
function fakeRoot(fields) {
  const cls = new Set();
  return {
    classList: { toggle: (n, on) => (on ? cls.add(n) : cls.delete(n)), contains: (n) => cls.has(n) },
    querySelectorAll: () => fields,
  };
}
const field = (readOnly = false) => ({ readOnly, dataset: {} });

test("载入期间锁住输入：两端各一次，用真调用而不是扫源码", async () => {
  // 上一条守的是「存不下要说出来」；这一条守的是**根本别让他敲进去** ——
  // 能防住的损失不该只靠提示。窗口是：`enterCanvas` 开头 `canvasActive = false`，
  // 而重新进入同一个项目时旧界面还留在屏幕上。
  const { createEditLock } = await import("../src/ui/editlock.js");
  const el = field(false);
  const lock = createEditLock({ getRoot: () => fakeRoot([el]) });
  lock.lock();
  assert.equal(el.readOnly, true, "进入项目时没有上锁");
  lock.unlock();
  assert.equal(el.readOnly, false, "载入完没有解锁");
});

test("重复上锁，不会把「本来可编辑」记成「本来只读」", async () => {
  // codex 原话：Repeated locking records the first lock's `readOnly` value as an
  // original restriction; unlocking then leaves originally editable inputs read-only.
  //
  // 上一版每次上锁都写标记：第二次上锁时 `readOnly` 已经是**我们自己设的** true，
  // 于是被记成「原本就只读」—— 解锁后那个框永远只读。**标记记的是「进入锁定之前
  // 的样子」，所以只能在进入的那一次写。**
  const { createEditLock } = await import("../src/ui/editlock.js");
  const editable = field(false);
  const alwaysRo = field(true);
  const lock = createEditLock({ getRoot: () => fakeRoot([editable, alwaysRo]) });

  lock.lock();
  lock.lock();          // ← 重复上锁（嵌套的重新进入）
  lock.unlock();

  assert.equal(editable.readOnly, false, "本来可编辑的框被永久锁住了");
  assert.equal(alwaysRo.readOnly, true, "本来只读的框被放开了");
});

test("看门狗先解锁、载入完再解锁，不会把「本来只读」放开", async () => {
  // codex 原话：watchdog unlock followed by completion unlock makes originally
  // read-only inputs editable because the first unlock deleted their marker.
  const { createEditLock } = await import("../src/ui/editlock.js");
  const editable = field(false);
  const alwaysRo = field(true);
  const warns = [];
  const lock = createEditLock({ getRoot: () => fakeRoot([editable, alwaysRo]), warn: (m) => warns.push(m) });

  lock.lock();
  assert.equal(lock._fireWatchdog(), true, "看门狗没能跑");   // 第一次解锁
  lock.unlock();                                              // 载入完成，第二次解锁

  assert.equal(alwaysRo.readOnly, true, "本来只读的框被第二次解锁放开了");
  assert.equal(editable.readOnly, false);
  assert.match(warns.join(" "), /放开输入/, "看门狗解锁时没出声");
});

test("这把锁一定会自己开 —— 载入抛异常也不许把人锁在外面", async () => {
  // `enterCanvas` 里有 `await`，抛了就走不到解锁那一行（还有一处「切到别的项目就
  // return」）。**把人锁在一个永远只读的编辑器前面，比原来的丢字更糟。**
  const { createEditLock } = await import("../src/ui/editlock.js");
  const el = field(false);
  const said = [];
  const lock = createEditLock({ getRoot: () => fakeRoot([el]), toast: (m) => said.push(m) });

  lock.lock();
  assert.equal(el.readOnly, true, "上锁没生效");
  lock._fireWatchdog();
  assert.equal(el.readOnly, false, "看门狗没有放开输入");
  assert.equal(lock.isLocked(), false, "放开了输入却没改状态 —— 之后的解锁会再动一次标记");
  assert.match(said.join(" "), /已放开输入/, "放开了却没告诉他");
});

test("锁上时用 readOnly 不用 disabled —— 他可能正想把刚敲的字复制走", async () => {
  const { createEditLock } = await import("../src/ui/editlock.js");
  const el = field(false);
  const lock = createEditLock({ getRoot: () => fakeRoot([el]) });
  lock.lock();
  assert.equal(el.readOnly, true);
  assert.equal(el.disabled, undefined, "用了 disabled —— 那会连选中复制都做不到");
});

test("根节点还不存在时什么都不做，也不记下一个假的锁定状态", async () => {
  const { createEditLock } = await import("../src/ui/editlock.js");
  const lock = createEditLock({ getRoot: () => null });
  lock.lock();
  assert.equal(lock.isLocked(), false, "没有界面却记成锁上了 —— 界面出现后第一次上锁会被当成重复");
});
