// TASK-072 §1.5 + §1.6 — the three review layers and the five gates.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAYERS, ISSUE_CATEGORIES, issue, decision, ignoreIssue,
  openIssues, latestDecision, decisionStanding, layerOfCategory, newDecisionId, relocateLegacyIssues,
} from "../src/workflow/review.js";
import {
  g1FormalReview, g2LockPicture, g3Retire, g3TriggerFor, G3_TRIGGERS,
  g4Export, g5Append, nextVersionFor,
} from "../src/workflow/gates.js";

/* --- §1.5 review layers --------------------------------------------------- */

test("验收 #6: the three layers' category sets are DISJOINT", () => {
  // 「边界清晰」 expressed in data: a loudness problem cannot exist at layer 2, a
  // pacing problem cannot exist at layer 3.
  const seen = new Map();
  for (const layer of LAYERS) {
    for (const c of ISSUE_CATEGORIES[layer]) {
      assert.equal(seen.has(c), false, `${c} belongs to two layers`);
      seen.set(c, layer);
      assert.equal(layerOfCategory(c), layer);
    }
  }
  assert.equal(layerOfCategory("nonsense"), null);
  // a mis-filed category is refused AND told where it belongs
  const bad = issue({
    issueId: "i1", layer: "episode", category: "loudness", severity: "warning",
    source: "agent", targetId: "ep1", text: "响度偏低", locatedShotId: "s1",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /属于检查层 3/);
});

test("验收 #7: ReviewDecision.by can only be `user` — the domain refuses AI", () => {
  const base = {
    decisionId: "d1", layer: "shot", targetId: "s1", verdict: "passed", basedOnVersion: 2,
  };
  assert.equal(decision({ ...base, by: "user" }).ok, true);
  for (const by of ["agent", "ai", "system", "", undefined]) {
    const r = decision({ ...base, by });
    assert.equal(r.ok, false, String(by));
    assert.match(r.error, /只能由创作者本人/);
  }
  // …and it is normalised to "user", never echoed back from input
  assert.equal(decision({ ...base, by: "user" }).value.by, "user");
});

test("验收 #8: a layer-2 issue without `locatedShotId` is REFUSED", () => {
  const base = {
    issueId: "i1", layer: "episode", category: "pacing", severity: "warning",
    source: "agent", targetId: "ep1", text: "第二场太慢",
  };
  const no = issue(base);
  assert.equal(no.ok, false);
  assert.match(no.error, /必须定位到具体镜头/);
  const yes = issue({ ...base, locatedShotId: "s3" });
  assert.equal(yes.ok, true);
  assert.equal(yes.value.locatedShotId, "s3");
  // layers 1 and 3 do not require it — they are already about one object
  assert.equal(issue({ ...base, layer: "shot", category: "action", targetId: "s1" }).ok, true);
  assert.equal(issue({ ...base, layer: "delivery", category: "loudness", targetId: "d1" }).ok, true);
});

test("a decision must record WHICH version it judged", () => {
  // without it, 「已定稿的不是当前版本」 (§6.4) is unanswerable
  const r = decision({ decisionId: "d1", layer: "shot", targetId: "s1", verdict: "passed", by: "user" });
  assert.equal(r.ok, false);
  assert.match(r.error, /basedOnVersion/);
});

test("decisionStanding: unknown is NOT current", () => {
  const d = decision({
    decisionId: "d1", layer: "shot", targetId: "s1", verdict: "passed", by: "user",
    basedOnVersion: 2, at: "2026-01-01",
  }).value;
  assert.equal(decisionStanding([d], { layer: "shot", targetId: "s1", currentVersion: 2 }).state, "current");
  assert.equal(decisionStanding([d], { layer: "shot", targetId: "s1", currentVersion: 3 }).state, "stale");
  assert.equal(decisionStanding([], { layer: "shot", targetId: "s1", currentVersion: 2 }).state, "none");
  // could not read the current version → unknown, never "current"
  assert.equal(decisionStanding([d], { layer: "shot", targetId: "s1", currentVersion: null }).state, "unknown");
  // latest wins, by `at`
  const older = { ...d, decisionId: "d0", at: "2025-01-01", verdict: "needs_rework" };
  assert.equal(latestDecision([older, d], { layer: "shot", targetId: "s1" }).decisionId, "d1");
});

test("ignoring is a USER act, is recorded, and blocking cannot be ignored", () => {
  const warn = issue({
    issueId: "i1", layer: "delivery", category: "subtitle", severity: "warning",
    source: "agent", targetId: "d1", text: "有空 cue",
  }).value;
  const ig = ignoreIssue(warn, { by: "user", at: "2026-01-02" });
  assert.equal(ig.ok, true);
  assert.equal(ig.value.state, "ignored");
  assert.equal(ig.value.ignoredBy, "user");
  assert.equal(ig.value.ignoredAt, "2026-01-02");
  assert.equal(ignoreIssue(warn, { by: "agent", at: "x" }).ok, false);
  // blocking means blocking
  const block = { ...warn, severity: "blocking" };
  const no = ignoreIssue(block, { by: "user", at: "x" });
  assert.equal(no.ok, false);
  assert.match(no.error, /不能忽略/);
  // an ignored issue is no longer open
  assert.equal(openIssues([ig.value], { layer: "delivery" }).length, 0);
});

/* --- §1.6 gates ----------------------------------------------------------- */

test("G1: an incomplete episode yields a TEST cut, never a formal one", () => {
  const all = [{ shotId: "a", hasConfirmedVideo: true }, { shotId: "b", hasConfirmedVideo: true }];
  assert.deepEqual(g1FormalReview(all), { ok: true, kind: "formal" });
  const some = g1FormalReview([...all, { shotId: "c", hasConfirmedVideo: false }]);
  assert.equal(some.ok, false);
  assert.equal(some.kind, "test", "seeing the cut early must stay possible…");
  assert.deepEqual(some.pendingShotIds, ["c"], "…and it must say which shots are pending");
  assert.match(some.reason, /不能提交正式审片结论/);
  assert.equal(g1FormalReview([]).ok, false);
});

test("G2: locking needs a pass ON THE CURRENT cut", () => {
  const pass = (v, at) => ({
    decisionId: `d${v}`, layer: "episode", targetId: "ep1", verdict: "passed",
    by: "user", basedOnVersion: v, at,
  });
  assert.equal(g2LockPicture([pass(3, "t1")], { episodeId: "ep1", activeRoughCutVersion: 3 }).ok, true);
  // a pass on an older cut is not a pass on this one
  const stale = g2LockPicture([pass(2, "t1")], { episodeId: "ep1", activeRoughCutVersion: 3 });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /第 2 版粗剪，当前是第 3 版/);
  assert.equal(g2LockPicture([], { episodeId: "ep1", activeRoughCutVersion: 3 }).ok, false);
  // an unreadable current version cannot prove anything → refuse
  assert.equal(g2LockPicture([pass(3, "t1")], { episodeId: "ep1", activeRoughCutVersion: null }).ok, false);
  const rework = [{ ...pass(3, "t1"), verdict: "needs_rework" }];
  assert.equal(g2LockPicture(rework, { episodeId: "ep1", activeRoughCutVersion: 3 }).ok, false);
});

test("G3: exactly the four contract triggers, keyed on the ACTION vocabulary", () => {
  // §6.3: the trigger is the domain, so it is keyed on actions rather than on pages
  assert.equal(g3TriggerFor("moveTimelineClip"), "timelineClipOrderChanged");
  assert.equal(g3TriggerFor("trimTimelineClip"), "timelineClipTrimChanged");
  assert.equal(g3TriggerFor("confirmShotVersion"), "shotConfirmedVideoChanged");
  assert.equal(g3TriggerFor("patchShots"), "shotAdded");
  // a volume tweak is NOT a structural change — widening this would demand a
  // re-review after every mix adjustment
  assert.equal(g3TriggerFor("setTimelineVolume"), null);
  assert.equal(g3TriggerFor("setTimelineFade"), null);
  assert.equal(g3TriggerFor("updateSubtitle"), null);

  const passed = {
    decisionId: "d1", layer: "episode", targetId: "ep1", verdict: "passed",
    by: "user", basedOnVersion: 3, at: "t1",
  };
  const r = g3Retire([passed], { episodeId: "ep1", trigger: "timelineClipOrderChanged", at: "t2" });
  assert.equal(r.changed, true);
  assert.equal(r.next.verdict, "needs_rereview");
  assert.equal(r.next.retiredBy, "timelineClipOrderChanged");
  assert.equal(r.unlockPicture, true);
  // the decision is RETIRED, not deleted — it happened, on an older cut
  assert.equal(r.next.basedOnVersion, 3);
  assert.equal(r.next.decisionId, "d1");
  // idempotent: a burst of edits does not produce a burst of notices
  assert.equal(g3Retire([r.next], { episodeId: "ep1", trigger: "shotAdded", at: "t3" }).changed, false);
  assert.equal(g3Retire([passed], { episodeId: "ep1", trigger: "notAThing", at: "t" }).changed, false);
  assert.equal(G3_TRIGGERS.length, 5);
});

test("G4: an open blocking issue refuses the export, and NO report also refuses", () => {
  const iss = (severity, state, id) => ({
    issueId: id, layer: "delivery", category: "av_sync", severity, state, text: `问题${id}`,
  });
  assert.equal(g4Export({ issues: [iss("warning", "open", "1")] }).ok, true);
  assert.equal(g4Export({ issues: [iss("blocking", "resolved", "1")] }).ok, true);
  const blocked = g4Export({ issues: [iss("blocking", "open", "1"), iss("blocking", "open", "2")] });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockingIssueIds, ["1", "2"]);
  assert.match(blocked.reason, /2 个阻断级/);
  // §6.5: 「未跑过 = 未知，不是通过」
  const noReport = g4Export(null);
  assert.equal(noReport.ok, false);
  assert.match(noReport.reason, /没跑不等于通过/);
});

test("G4: `{}` is NOT a report — 未跑过 = 未知，不是通过", () => {
  // Accepting any object let a never-run or malformed report through the one gate
  // whose stated purpose is that (independent review, batch 2).
  for (const bogus of [{}, { issues: null }, { issues: "none" }, [], null, undefined]) {
    const r = g4Export(bogus);
    assert.equal(r.ok, false, JSON.stringify(bogus));
    assert.match(r.reason, /没跑不等于通过/);
  }
  // a REAL report with no blockers passes
  assert.equal(g4Export({ issues: [] }).ok, true);
});

test("the gates fail closed on a missing argument instead of throwing", () => {
  // `is()`-style predicates are consulted on every write path; a TypeError there
  // takes the path down rather than refusing one check (independent review, batch 2).
  assert.doesNotThrow(() => g2LockPicture([]));
  assert.equal(g2LockPicture([]).ok, false);
  assert.doesNotThrow(() => g3Retire([]));
  assert.equal(g3Retire([]).changed, false);
  assert.doesNotThrow(() => latestDecision([]));
  assert.equal(latestDecision([]), null);
  assert.doesNotThrow(() => decisionStanding([]));
  assert.equal(decisionStanding([]).state, "none");
});

test("G5: versions only APPEND, and only forward", () => {
  assert.deepEqual(g5Append([1, 2, 3], 4), { ok: true, version: 4 });
  assert.equal(g5Append([1, 2, 3], 3).ok, false, "an existing version is never overwritten");
  assert.equal(g5Append([1, 2, 3], 2).ok, false, "versions only move forward");
  assert.match(g5Append([1, 2, 3], 3).reason, /绝不覆盖/);
  assert.equal(g5Append([], 1).ok, true);
  assert.equal(g5Append([1], null).ok, false);
  assert.equal(nextVersionFor([]), 1);
  assert.equal(nextVersionFor([1, 5, 2]), 6);
  assert.equal(nextVersionFor(null), 1);
});

test("two decisions on the SAME target in one millisecond get different ids", () => {
  // approve → unapprove → approve inside one ms (a script, a batch, a double click)
  // minted the same `dec-shot-<id>-<Date.now()>` twice, and two decisions sharing an
  // id make the append-only log ambiguous: a lookup BY id points at the wrong one and
  // 「这条结论审的是哪一版」 stops being answerable (independent review).
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(newDecisionId("shot", "s1"));
  assert.equal(ids.size, 50);
  // the target is part of the id, so two shots never share one either
  assert.notEqual(newDecisionId("shot", "s1"), newDecisionId("shot", "s2"));
  assert.match(newDecisionId("episode", "ep1"), /^dec-episode-ep1-/);
  // a COUNTER, not a random: a migration that re-ran must produce the same shape
  assert.equal(/[0-9a-z]+-\d+$/.test(newDecisionId("shot", "s1")), true);
});

test("TASK-074 §1.3: a legacy un-located episode issue is MARKED, never dropped", () => {
  const legacy = {
    issueId: "i-old", layer: "episode", category: "pacing", severity: "blocking",
    source: "agent", targetId: "ep1", text: "第二场太慢", state: "open",
  };
  const located = { ...legacy, issueId: "i-ok", locatedShotId: "s3" };
  const shotLevel = { ...legacy, issueId: "i-shot", layer: "shot", category: "action" };
  const out = relocateLegacyIssues([legacy, located, shotLevel, "junk", null]);

  assert.equal(out.length, 5, "不丢弃 — nothing is removed, not even junk");
  assert.equal(out[0].needsRelocation, true);
  assert.match(out[0].relocationNote, /请指认/);
  // …and its STATE is untouched: taking an open blocking issue out of `openIssues`
  // would let G4 pass an export that a real problem was blocking
  assert.equal(out[0].state, "open");
  assert.equal(openIssues(out, { layer: "episode" }).length, 2);

  // already-located, other layers and non-objects come back UNCHANGED (same object)
  assert.equal(out[1], located);
  assert.equal(out[2], shotLevel);
  assert.equal(out[3], "junk");
  assert.equal(out[4], null);

  // idempotent: re-running the migration changes nothing further
  const twice = relocateLegacyIssues(out);
  assert.equal(twice[0], out[0]);
  assert.deepEqual(twice, out);
  // no clock, no randomness — two runs of the same input are identical
  assert.deepEqual(relocateLegacyIssues([legacy]), relocateLegacyIssues([legacy]));
  assert.deepEqual(relocateLegacyIssues(null), []);
});
