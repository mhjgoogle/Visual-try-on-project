// Unit tests for the script DOMAIN document (Idea → Script vertical slice).
// Pure-logic module — run via `node --test`, wrapped by
// tests/test_motv_script_slice_e2e.py. No DOM, no fetch.
import test from "node:test";
import assert from "node:assert/strict";

import * as sd from "../src/workflow/scriptdoc.js";

// --- 创意 → 生成 v1 ---------------------------------------------------------

test("initial generation applies directly as v1 and records the instruction", () => {
  const d = sd.createDoc();
  sd.setBrief(d, "社畜穿越盛唐");
  const id = sd.beginGeneration(d, "initial", d.brief);
  assert.ok(id > 0);
  assert.equal(d.pending.status, "generating");
  assert.equal(sd.completeGeneration(d, id, "【金銮殿·日】剧本正文"), true);
  assert.equal(d.pending, null);
  assert.equal(d.versions.length, 1);
  assert.deepEqual(d.versions[0], {
    v: 1,
    content: "【金銮殿·日】剧本正文",
    instruction: "社畜穿越盛唐",
    origin: "generated",
    basedOn: null,
    status: "done",
  });
  assert.equal(d.active, 1);
  assert.equal(sd.currentText(d), "【金銮殿·日】剧本正文");
});

test("only one generation may run at a time", () => {
  const d = sd.createDoc();
  const id = sd.beginGeneration(d, "initial", "想法");
  assert.ok(id > 0);
  assert.equal(sd.beginGeneration(d, "initial", "另一个想法"), 0);
  sd.completeGeneration(d, id, "剧本");
  assert.ok(sd.beginGeneration(d, "revision", "改结尾") > 0);
});

test("an un-applied proposal blocks a new generation; a failure allows retry", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改A"), "提案A");
  assert.equal(d.pending.status, "proposed");
  // starting another run would silently overwrite the draft under review
  assert.equal(sd.beginGeneration(d, "revision", "改B"), 0);
  assert.equal(d.pending.proposal, "提案A"); // untouched
  sd.discardProposal(d);
  const id = sd.beginGeneration(d, "revision", "改B");
  assert.ok(id > 0);
  // a FAILED pending is transient — a retry may replace it
  sd.failGeneration(d, id, "超时");
  assert.ok(sd.beginGeneration(d, "revision", "改B") > 0);
});

// --- 修订：提案 → 应用为 v2，v1 保留 ---------------------------------------

test("revision proposes; apply creates v2 and preserves v1 unchanged", () => {
  const d = sd.createDoc();
  const id1 = sd.beginGeneration(d, "initial", "想法");
  sd.completeGeneration(d, id1, "v1 正文");
  const id2 = sd.beginGeneration(d, "revision", "结尾加反转");
  assert.equal(sd.completeGeneration(d, id2, "v2 修订正文"), true);
  // still a PROPOSAL — nothing applied yet
  assert.equal(d.pending.status, "proposed");
  assert.equal(d.pending.proposal, "v2 修订正文");
  assert.equal(d.versions.length, 1);
  assert.equal(sd.currentText(d), "v1 正文");
  const rec = sd.applyProposal(d);
  assert.equal(rec.v, 2);
  assert.equal(rec.origin, "revision");
  assert.equal(rec.instruction, "结尾加反转");
  assert.equal(rec.basedOn, 1);
  assert.equal(d.active, 2);
  assert.equal(sd.currentText(d), "v2 修订正文");
  // v1 preserved byte-for-byte
  assert.equal(d.versions[0].content, "v1 正文");
  assert.equal(d.pending, null);
});

test("discarding a proposal leaves the version chain untouched", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "提案");
  sd.discardProposal(d);
  assert.equal(d.pending, null);
  assert.equal(d.versions.length, 1);
  assert.equal(sd.applyProposal(d), null); // nothing left to apply
});

// --- 版本切换 ---------------------------------------------------------------

test("setActive switches the visible version; unknown versions are rejected", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "v2 正文");
  sd.applyProposal(d);
  assert.equal(sd.setActive(d, 1), true);
  assert.equal(sd.currentText(d), "v1 正文");
  assert.equal(sd.setActive(d, 9), false);
  assert.equal(d.active, 1);
  assert.equal(sd.setActive(d, 2), true);
  assert.equal(sd.currentText(d), "v2 正文");
});

// --- 失败 / 取消 / 迟到的完成 -----------------------------------------------

test("failGeneration records the error; cancel clears; stale completion ignored", () => {
  const d = sd.createDoc();
  const id = sd.beginGeneration(d, "initial", "想法");
  assert.equal(sd.failGeneration(d, id, "CLI 超时"), true);
  assert.equal(d.pending.status, "failed");
  assert.equal(d.pending.error, "CLI 超时");
  assert.equal(d.versions.length, 0); // a failure never mints a version
  sd.cancelGeneration(d);
  assert.equal(d.pending, null);
  // a completion arriving after cancel must be a no-op
  const id2 = sd.beginGeneration(d, "initial", "想法");
  sd.cancelGeneration(d);
  assert.equal(sd.completeGeneration(d, id2, "迟到的正文"), false);
  assert.equal(d.versions.length, 0);
  assert.equal(sd.failGeneration(d, id2, "x"), false);
});

// --- 手工编辑缓冲 -----------------------------------------------------------

test("manual edits set the dirty flag; switching versions snapshots them", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  assert.equal(sd.isDirty(d), false);
  sd.editText(d, "v1 正文 + 手工改动");
  assert.equal(sd.isDirty(d), true);
  assert.equal(sd.currentText(d), "v1 正文 + 手工改动");
  assert.equal(d.versions[0].content, "v1 正文"); // version body untouched
  // switching versions must NOT silently drop the dirty buffer: it survives
  // as a manual v2, then the view shows exactly the selected version
  sd.setActive(d, 1);
  assert.equal(sd.isDirty(d), false);
  assert.equal(sd.currentText(d), "v1 正文");
  assert.deepEqual(
    d.versions.map((x) => [x.v, x.origin, x.content]),
    [[1, "generated", "v1 正文"], [2, "manual", "v1 正文 + 手工改动"]],
  );
  // a clean (non-dirty) switch adds nothing
  sd.setActive(d, 2);
  assert.equal(d.versions.length, 2);
});

// --- 产品规则：剧本版本必须含非空白内容 --------------------------------------
// Accepted product decision (2026-08-08): empty/whitespace-only buffers are
// NOT valid durable Script versions and must never mint junk versions — on
// ANY of the three version-minting paths.

test("product rule: empty/whitespace buffers never mint durable versions", () => {
  const d = sd.createDoc();
  // path 1 — initial-generation completion over a cleared buffer
  sd.editText(d, "   \n");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  assert.deepEqual(d.versions.map((x) => x.origin), ["generated"]);
  // path 2 — version switch with the editor cleared to whitespace
  sd.editText(d, " \t ");
  sd.setActive(d, 1);
  assert.equal(d.versions.length, 1);
  // path 3 — applying a revision proposal with the editor cleared to empty
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "v2 正文");
  sd.editText(d, "");
  const rec = sd.applyProposal(d);
  assert.equal(rec.v, 2);
  assert.deepEqual(d.versions.map((x) => x.origin), ["generated", "revision"]);
  // the invariant itself: every durable version holds non-whitespace content
  assert.ok(d.versions.every((x) => x.content.trim().length > 0));
  // and the cleared buffer was a transient edit, not a saved version
  assert.equal(sd.currentText(d), "v2 正文");
});

// --- 持久化 -----------------------------------------------------------------

test("serialize/createDoc round-trip keeps brief/versions/active, drops pending", () => {
  const d = sd.createDoc();
  sd.setBrief(d, "想法");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "v2 正文");
  sd.applyProposal(d);
  sd.setActive(d, 1);
  sd.beginGeneration(d, "revision", "进行中的调用"); // transient — must not survive
  const r = sd.createDoc(JSON.parse(JSON.stringify(sd.serialize(d))));
  assert.equal(r.brief, "想法");
  assert.equal(r.versions.length, 2);
  assert.equal(r.active, 1);
  assert.equal(r.pending, null);
  assert.equal(sd.currentText(r), "v1 正文");
});

test("hydration is defensive: bad records dropped, active falls back to newest", () => {
  const r = sd.createDoc({
    brief: 7, // wrong type — ignored
    versions: [
      { v: 1, content: "好的", origin: '<img src=x onerror=alert(1)>' },
      { v: 2, content: 42 }, // dropped
      null,
    ],
    active: 99, // dangling — falls back
  });
  assert.equal(r.brief, "");
  assert.equal(r.versions.length, 1);
  assert.equal(r.active, 1);
  // origin is enum-like: a tampered save cannot smuggle arbitrary strings in
  assert.equal(r.versions[0].origin, "generated");
});

test("legacy node text hydrates as an unversioned working buffer", () => {
  const r = sd.createDoc({ legacyText: "老画布里的剧本" });
  assert.equal(r.versions.length, 0);
  assert.equal(sd.currentText(r), "老画布里的剧本");
  // generating over it never silently discards the user's text: the buffer is
  // snapshotted as a manual v1, the generated script lands as v2
  sd.completeGeneration(r, sd.beginGeneration(r, "initial", "想法"), "生成的剧本");
  assert.equal(r.versions.length, 2);
  assert.deepEqual(
    r.versions.map((x) => [x.v, x.origin, x.content]),
    [[1, "manual", "老画布里的剧本"], [2, "generated", "生成的剧本"]],
  );
  assert.equal(r.versions[1].basedOn, 1);
  assert.equal(sd.currentText(r), "生成的剧本");
});

test("applying a proposal over dirty manual edits snapshots them first", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "修订稿");
  sd.editText(d, "v1 正文 + 手工改动"); // diverges while the proposal is pending
  const rec = sd.applyProposal(d);
  // chain: v1 (generated) → v2 (manual snapshot) → v3 (applied revision)
  assert.deepEqual(
    d.versions.map((x) => [x.v, x.origin]),
    [[1, "generated"], [2, "manual"], [3, "revision"]],
  );
  assert.equal(d.versions[1].content, "v1 正文 + 手工改动");
  assert.equal(rec.v, 3);
  assert.equal(rec.basedOn, 2);
  assert.equal(d.active, 3);
  // a buffer merely equal to the active version is NOT snapshotted
  sd.editText(d, d.versions[2].content);
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "再改"), "再修订");
  sd.applyProposal(d);
  assert.equal(d.versions.length, 4);
});
