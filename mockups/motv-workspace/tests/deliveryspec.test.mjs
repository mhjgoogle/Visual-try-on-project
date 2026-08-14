// TASK-073 §1.7 — the fourteen spec fields, and the two HARD GATES.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SPEC_FIELDS, validateField, specStanding,
  checkGenerationCost, checkRetryAllowed, checkRenderedAgainstSpec,
} from "../src/workflow/deliveryspec.js";

test("the field list is IA §4 ⚙'s frozen fourteen", () => {
  assert.equal(SPEC_FIELDS.length, 14);
  assert.deepEqual(SPEC_FIELDS.map((f) => f.key), [
    "platform", "aspect", "resolution", "fps", "episodeSeconds", "episodeTarget",
    "subtitleMode", "subtitleLang", "container", "videoBitrateKbps", "audioBitrateKbps",
    "budgetTotalUsd", "perGenerationCapUsd", "retryCap",
  ]);
  // exactly the two hard gates
  assert.deepEqual(SPEC_FIELDS.filter((f) => f.gate).map((f) => f.key),
    ["perGenerationCapUsd", "retryCap"]);
});

test("a present-but-wrong value is REFUSED, never coerced", () => {
  // `"25"` silently becoming 25 would mean the stored spec and what the creator
  // typed are two different things, and only one of them was checked
  assert.match(validateField("fps", "25"), /必须是整数/);
  assert.match(validateField("fps", 0), /1–60/);
  assert.equal(validateField("fps", 25), null);
  assert.match(validateField("container", "mov"), /只能是/);
  assert.equal(validateField("container", "mp4"), null);
  assert.match(validateField("budgetTotalUsd", "x"), /必须是数字/);
  assert.match(validateField("nope", 1), /未知的规格字段/);
  // absent is NOT invalid — it is unavailable, which is a different state
  for (const v of [null, undefined, ""]) assert.equal(validateField("fps", v), null);
});

test("§1.7 honesty: a missing field is `unavailable`, and never completes the spec", () => {
  const st = specStanding({ fps: 25, container: "mp4" });
  assert.equal(st.complete, false);
  assert.equal(st.fields.find((f) => f.key === "fps").state, "set");
  const missing = st.fields.find((f) => f.key === "platform");
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.detail, "还没有设置");
  // three distinct states, never collapsed
  const bad = specStanding({ fps: 999 }).fields.find((f) => f.key === "fps");
  assert.equal(bad.state, "invalid");
  assert.match(bad.detail, /1–60/);
  assert.equal(specStanding(null).complete, false);
  assert.equal(specStanding(null).missing.length, 14);
});

test("HARD GATE 单次生成上限: over the cap is REFUSED, with no way to confirm past it", () => {
  const spec = { perGenerationCapUsd: 1.0 };
  assert.equal(checkGenerationCost(spec, 0.5).ok, true);
  assert.equal(checkGenerationCost(spec, 1.0).ok, true, "at the cap is allowed");
  const over = checkGenerationCost(spec, 1.01);
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过单次生成上限/);
  // §1.7: 「不是弹窗问一句『确定吗』」 — there is no parameter that overrides it
  assert.equal(checkGenerationCost.length, 2);

  // FAIL CLOSED: a paid op with no cap configured is exactly what a cap prevents
  const noCap = checkGenerationCost({}, 0.5);
  assert.equal(noCap.ok, false);
  assert.match(noCap.reason, /还没有设置「单次生成上限」/);
  // …but a free (subscription) op has nothing to cap
  assert.equal(checkGenerationCost({}, 0).ok, true);
  // an unknown cost cannot be compared, so it is refused rather than assumed cheap
  assert.equal(checkGenerationCost(spec, null).ok, false);
});

test("HARD GATE 重试上限: at the cap it stops, and an unset cap stops it too", () => {
  const spec = { retryCap: 2 };
  assert.equal(checkRetryAllowed(spec, 0).ok, true);
  assert.equal(checkRetryAllowed(spec, 1).ok, true);
  const at = checkRetryAllowed(spec, 2);
  assert.equal(at.ok, false);
  assert.match(at.reason, /达到重试上限/);
  // unlimited retries against a paid provider is the failure this gate is for
  assert.equal(checkRetryAllowed({}, 0).ok, false);
  assert.equal(checkRetryAllowed(spec, null).ok, false);
});

test("MEASURED values get a tolerance; DISCRETE ones stay exact", () => {
  // ffprobe reports 30000/1001 for a 30 fps render and a bitrate that never lands
  // exactly on target — strict equality made every real export a blocking 规格
  // failure and G4 refused it (independent review, batch 2).
  const spec = {
    resolution: "1080x1920", fps: 30, container: "mp4",
    videoBitrateKbps: 6000, audioBitrateKbps: 128,
  };
  const probed = {
    resolution: "1080x1920", fps: 29.97, container: "mp4",
    videoBitrateKbps: 5987, audioBitrateKbps: 127,
  };
  assert.equal(checkRenderedAgainstSpec(spec, probed).passed, true);
  // …but a genuinely wrong frame rate still fails
  assert.equal(checkRenderedAgainstSpec(spec, { ...probed, fps: 25 }).passed, false);
  // resolution and container are DISCRETE — a 1080x1920 file is that or it is not
  assert.equal(checkRenderedAgainstSpec(spec, { ...probed, resolution: "1920x1080" }).blocking, true);
  assert.equal(checkRenderedAgainstSpec(spec, { ...probed, container: "webm" }).blocking, true);
});

test("the audio band is ABSOLUTE, so it works at every ladder target", () => {
  // No single RATIO serves both 128 and 192: 3% of 128 is ±3.8 kbps (below ordinary
  // VBR drift, refusing a correct master) while 10% of 192 accepts 176 and 208 — the
  // adjacent ladder targets — through a BLOCKING row (independent review, rounds 3+4).
  const at = (spec, actual) => checkRenderedAgainstSpec(
    { resolution: "1080x1920", fps: 25, container: "mp4", videoBitrateKbps: 6000, audioBitrateKbps: spec },
    { resolution: "1080x1920", fps: 25, container: "mp4", videoBitrateKbps: 6000, audioBitrateKbps: actual },
  ).passed;
  // routine drift passes at both targets
  assert.equal(at(128, 127), true);
  assert.equal(at(128, 122), true);
  assert.equal(at(192, 187), true);
  // …and the nearest WRONG rung fails at both
  assert.equal(at(128, 112), false, "112 is a different target, not drift");
  assert.equal(at(128, 160), false);
  assert.equal(at(192, 176), false, "176 is the adjacent ladder rung");
  assert.equal(at(192, 208), false);
});

test("TASK-074 §1.2 规格 check: `unavailable` never counts as a pass", () => {
  const spec = {
    resolution: "1080x1920", fps: 25, container: "mp4",
    videoBitrateKbps: 6000, audioBitrateKbps: 128,
  };
  const good = checkRenderedAgainstSpec(spec, {
    resolution: "1080x1920", fps: 25, container: "mp4",
    videoBitrateKbps: 6000, audioBitrateKbps: 128,
  });
  assert.equal(good.passed, true);
  assert.equal(good.blocking, false);

  const wrong = checkRenderedAgainstSpec(spec, { ...spec, fps: 30 });
  assert.equal(wrong.passed, false);
  assert.equal(wrong.blocking, true);
  assert.match(wrong.rows.find((r) => r.key === "fps").detail, /期望 25，实际 30/);

  // a property the probe could not read is UNKNOWN — and unknown blocks, because a
  // file waved through on an unknown is how a wrong export ships (ADR-0064 决策 6)
  const unread = checkRenderedAgainstSpec(spec, { ...spec, fps: null });
  assert.equal(unread.passed, false);
  assert.equal(unread.blocking, false, "unknown is not a failure…");
  assert.equal(unread.unknown, true, "…but it is not a pass either");
  // …and so is a spec field nobody set
  const unset = checkRenderedAgainstSpec({}, { resolution: "1080x1920" });
  assert.equal(unset.passed, false);
  assert.equal(unset.unknown, true);
});
