// Frontend unit tests for TASK-048 (run via `node --test`, wrapped by
// tests/test_motv_task048_e2e.py). Pure-logic modules only — no DOM needed.
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEntry,
  migrateUploads,
  slotEntry,
  currentRef,
  slotUrl,
  slotStem,
  addVersion,
  setCurrent,
  refFromResponse,
} from "../src/workflow/mediaref.js";
import { aggregateOps, hasInflight } from "../src/ui/paidqueue.js";

// --- 旧版 data/<project>.json（字符串 uploads）加载兼容性 ------------------

test("legacy string upload migrates to a v1 version chain", () => {
  const uploads = {
    "v1-1": "/api/uploads/demo/assets-v1-1.png",
    "voice-v1-2": "/api/uploads/demo/audio-voice-v1-2.wav",
  };
  migrateUploads(uploads);
  const e = uploads["v1-1"];
  assert.equal(e.current, 1);
  assert.equal(e.history.length, 1);
  assert.deepEqual(e.history[0], {
    slot_id: "v1-1",
    origin: "upload",
    version: 1,
    digest: null,
    url: "/api/uploads/demo/assets-v1-1.png",
  });
  // reads resolve identically to the pre-versioning behavior
  assert.equal(slotUrl(uploads, "v1-1"), "/api/uploads/demo/assets-v1-1.png");
  assert.equal(slotStem(uploads, "v1-1"), "assets-v1-1");
  assert.equal(slotStem(uploads, "voice-v1-2"), "audio-voice-v1-2");
});

test("migration is idempotent and drops empty/invalid entries", () => {
  const uploads = { a: "/u/a.png", b: "", c: null };
  migrateUploads(uploads);
  migrateUploads(uploads); // second pass must not double-wrap
  assert.equal(uploads.a.current, 1);
  assert.ok(!("b" in uploads));
  assert.ok(!("c" in uploads));
});

test("reads tolerate both raw-string and normalized entries", () => {
  const uploads = { a: "/u/legacy.png" };
  assert.equal(slotUrl(uploads, "a"), "/u/legacy.png"); // no migration needed
  assert.equal(slotEntry(uploads, "a").current, 1);
  assert.equal(slotUrl(uploads, "missing"), "");
  assert.equal(currentRef(uploads, "missing"), null);
});

// --- 版本链：追加、回切 ----------------------------------------------------

test("addVersion appends and becomes current; setCurrent switches back", () => {
  const node = { uploads: { a: "/api/uploads/p/x-a.png" } };
  addVersion(node, "a", refFromResponse("a", "upload", {
    url: "/api/uploads/p/x-a_v2.jpg", version: 2, sha256: "d2",
  }));
  const e = node.uploads.a;
  assert.equal(e.current, 2);
  assert.equal(e.history.length, 2); // v1 (migrated legacy) + v2 — nothing lost
  assert.equal(slotUrl(node.uploads, "a"), "/api/uploads/p/x-a_v2.jpg");
  assert.equal(slotStem(node.uploads, "a"), "x-a_v2");
  // 回切 v1：当前指针切换，历史保持
  assert.equal(setCurrent(node, "a", 1), true);
  assert.equal(slotUrl(node.uploads, "a"), "/api/uploads/p/x-a.png");
  assert.equal(node.uploads.a.history.length, 2);
  // 回切到不存在的版本被拒绝，不改变现状
  assert.equal(setCurrent(node, "a", 9), false);
  assert.equal(node.uploads.a.current, 1);
});

test("refFromResponse carries origin/version/digest for the MediaRef", () => {
  const r = refFromResponse("s1", "adopted", { url: "/u/v-s1_v3.mp4", version: 3, sha256: "abc" });
  // shot_id defaults to null — provable association is passed by the caller (M3)
  assert.deepEqual(r, { slot_id: "s1", origin: "adopted", version: 3, digest: "abc", url: "/u/v-s1_v3.mp4", shot_id: null });
  assert.equal(refFromResponse("s1", "adopted", { url: "/u" }, "shot-a").shot_id, "shot-a");
  // missing version/sha256 (defensive) → v1, null digest
  const r2 = refFromResponse("s1", "tts", { url: "/u/a.wav" });
  assert.equal(r2.version, 1);
  assert.equal(r2.digest, null);
});

// --- 付费队列条聚合/轮询判定（TASK-048 第2步） ------------------------------

test("aggregateOps counts faithful reservation statuses", () => {
  const ops = [
    { status: "held" },
    { status: "held" },
    { status: "committed" },
    { status: "released" },
    { status: "needs_reconciliation" },
    { status: "mystery" },
  ];
  assert.deepEqual(aggregateOps(ops), {
    held: 2, committed: 1, released: 1, needs_reconciliation: 1, other: 1,
  });
});

test("hasInflight is true only while a reservation is held", () => {
  assert.equal(hasInflight([{ status: "held" }, { status: "committed" }]), true);
  // committed/released/needs_reconciliation alone must STOP the poll timer
  assert.equal(hasInflight([{ status: "committed" }, { status: "released" }]), false);
  assert.equal(hasInflight([{ status: "needs_reconciliation" }]), false);
  assert.equal(hasInflight([]), false);
});

// 轮询触发后的状态流转：⏳(held) → ✓(committed) 反映为聚合计数变化，
// 且 in-flight 判定翻转（app.js 据此停表）。
test("poll transition held→committed flips inflight and counts", () => {
  const before = [{ status: "held", shot_id: "shot-1" }];
  const after = [{ status: "committed", shot_id: "shot-1" }];
  assert.equal(hasInflight(before), true);
  assert.equal(hasInflight(after), false);
  assert.equal(aggregateOps(before).held, 1);
  assert.equal(aggregateOps(after).committed, 1);
});
