// TASK-074 §1.2 — 交付质检 (检查层 3). Seven checks, three-valued answers.
import test from "node:test";
import assert from "node:assert/strict";

import {
  QC_CHECKS, QC_THRESHOLDS, runDeliveryQc,
  checkAvSync, checkSubtitles, checkLoudness, checkBlackFrames,
  checkDroppedFrames, checkSpec, checkRights,
} from "../src/workflow/deliveryqc.js";
import { ISSUE_CATEGORIES } from "../src/workflow/review.js";
import { g4Export } from "../src/workflow/gates.js";

const SPEC = {
  resolution: "1080x1920", fps: 25, container: "mp4",
  videoBitrateKbps: 6000, audioBitrateKbps: 128,
};
const GOOD_PROBE = {
  avOffsetMs: 10, lufs: -16, truePeakDbtp: -3, blackSpans: [],
  frameCount: 250, durationS: 10, fps: 25,
  resolution: "1080x1920", container: "mp4", videoBitrateKbps: 6000, audioBitrateKbps: 128,
};
const GOOD_SUBS = { cues: [{ text: "你好", startMs: 0, endMs: 900 }] };
const GOOD_ASSETS = [{ assetId: "a1", origin: "upload" }];

test("the seven checks are exactly 检查层 3's category set", () => {
  assert.equal(QC_CHECKS.length, 7);
  // every check IS a layer-3 category, and covers the layer completely — a check
  // whose category belonged to another layer would break §6.1's disjointness
  assert.deepEqual(
    QC_CHECKS.map((c) => c.key).slice().sort(),
    ISSUE_CATEGORIES.delivery.slice().sort(),
  );
});

test("a clean file passes all seven", () => {
  const r = runDeliveryQc({
    probe: GOOD_PROBE, subtitleTrack: GOOD_SUBS, spec: SPEC,
    assets: GOOD_ASSETS, durationMs: 10000,
  });
  assert.equal(r.passed, true, JSON.stringify(r.rows.filter((x) => x.state !== "pass")));
  assert.equal(r.issues.length, 0);
  assert.equal(r.blocking, false);
  assert.deepEqual(r.unavailable, []);
});

test("§1.2 THE RULE: a missing tool is `unavailable` and NEVER a pass", () => {
  // nothing measured at all
  const r = runDeliveryQc({ spec: SPEC, assets: GOOD_ASSETS });
  assert.equal(r.passed, false, "an unmeasured file must not pass");
  // …and it is not reported as a failure either — it is an unknown
  assert.equal(r.blocking, false);
  for (const key of ["av_sync", "loudness", "black_frame", "dropped_frame", "subtitle"]) {
    assert.ok(r.unavailable.includes(key), `${key} should be unavailable`);
  }
  // each unknown SAYS WHY
  for (const row of r.rows.filter((x) => x.state === "unavailable")) {
    assert.ok(row.detail && row.detail.length > 3, `${row.key} has no reason`);
  }
  // an unknown produces NO issue, so it cannot masquerade as a finding
  assert.equal(r.issues.length, 0);
});

test("音画同步 blocks beyond the threshold", () => {
  assert.equal(checkAvSync({ avOffsetMs: QC_THRESHOLDS.avSyncMs }).state, "pass");
  const bad = checkAvSync({ avOffsetMs: QC_THRESHOLDS.avSyncMs + 1 });
  assert.equal(bad.state, "fail");
  assert.equal(bad.severity, "blocking");
  assert.equal(checkAvSync({}).state, "unavailable");
  // a negative offset of the same magnitude is equally wrong
  assert.equal(checkAvSync({ avOffsetMs: -(QC_THRESHOLDS.avSyncMs + 1) }).state, "fail");
});

test("字幕: empty cues, inverted timing and out-of-range are all caught", () => {
  assert.equal(checkSubtitles({ cues: [] }).state, "fail");
  assert.equal(checkSubtitles(null).state, "unavailable");
  assert.match(checkSubtitles({ cues: [{ text: "  ", startMs: 0, endMs: 5 }] }).detail, /空字幕/);
  assert.match(checkSubtitles({ cues: [{ text: "a", startMs: 5, endMs: 5 }] }).detail, /时间无效/);
  assert.match(
    checkSubtitles({ cues: [{ text: "a", startMs: 0, endMs: 9999 }] }, { durationMs: 1000 }).detail,
    /超出成片时长/,
  );
  // WITHOUT a duration the sub-check is skipped — and says so rather than passing
  // silently on a check it did not perform
  const noDur = checkSubtitles(GOOD_SUBS);
  assert.equal(noDur.state, "pass");
  assert.match(noDur.detail, /未提供成片时长/);
});

test("音量: loudness warns, CLIPPING blocks — two findings from one probe", () => {
  const off = checkLoudness({ lufs: -10, truePeakDbtp: -3 });
  assert.equal(off[0].state, "fail");
  assert.equal(off[0].severity, "warning", "loudness alone is a preference");
  const clipped = checkLoudness({ lufs: -16, truePeakDbtp: 0.5 });
  assert.equal(clipped[0].state, "pass");
  assert.equal(clipped[1].state, "fail");
  assert.equal(clipped[1].severity, "blocking", "a clipped master is damaged audio");
  assert.equal(checkLoudness({}).length, 1);
  assert.equal(checkLoudness({})[0].state, "unavailable");
});

test("黑帧 / 缺帧", () => {
  assert.equal(checkBlackFrames({ blackSpans: [] }).state, "pass");
  assert.match(checkBlackFrames({ blackSpans: [{ durationS: 1.5 }] }).detail, /1 段黑帧/);
  assert.equal(checkBlackFrames({}).state, "unavailable");

  assert.equal(checkDroppedFrames({ frameCount: 250, durationS: 10, fps: 25 }).state, "pass");
  const dropped = checkDroppedFrames({ frameCount: 200, durationS: 10, fps: 25 });
  assert.equal(dropped.state, "fail");
  assert.equal(dropped.severity, "blocking");
  // a zero fps cannot be divided by — unknown, not a crash and not a pass
  assert.equal(checkDroppedFrames({ frameCount: 1, durationS: 10, fps: 0 }).state, "unavailable");
  assert.equal(checkDroppedFrames({}).state, "unavailable");
});

test("规格 delegates to the spec module, and an unset spec is UNKNOWN", () => {
  assert.equal(checkSpec(SPEC, GOOD_PROBE).state, "pass");
  assert.equal(checkSpec(SPEC, { ...GOOD_PROBE, fps: 30 }).state, "fail");
  // ⚙ never configured → the check cannot conclude, so it must not conclude
  assert.equal(checkSpec({}, GOOD_PROBE).state, "unavailable");
  assert.equal(checkSpec(SPEC, { ...GOOD_PROBE, fps: null }).state, "unavailable");
});

test("素材权限: an unmarked source blocks", () => {
  assert.equal(checkRights(GOOD_ASSETS).state, "pass");
  const bad = checkRights([{ assetId: "a1", origin: "" }, { assetId: "a2", origin: "upload" }]);
  assert.equal(bad.state, "fail");
  assert.equal(bad.severity, "blocking");
  assert.match(bad.detail, /1 个素材没有标注来源/);
  assert.equal(checkRights(null).state, "unavailable");
  assert.equal(checkRights([]).state, "unavailable");
});

test("the report's issues are layer-3, agent-sourced, and feed G4", () => {
  const r = runDeliveryQc({
    probe: { ...GOOD_PROBE, avOffsetMs: 500 },
    subtitleTrack: GOOD_SUBS, spec: SPEC, assets: GOOD_ASSETS, durationMs: 10000,
    deliveryId: "d1",
  });
  assert.equal(r.issues.length, 1);
  const iss = r.issues[0];
  assert.equal(iss.layer, "delivery");
  assert.equal(iss.category, "av_sync");
  assert.equal(iss.severity, "blocking");
  // a MEASUREMENT is an observation, never a verdict (§6.2)
  assert.equal(iss.source, "agent");
  assert.equal(iss.state, "open");
  assert.equal(iss.targetId, "d1");
  // …and G4 refuses the export on it
  const gate = g4Export(r);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blockingIssueIds, [iss.issueId]);
  // a warning-only report does not block
  const warn = runDeliveryQc({
    probe: { ...GOOD_PROBE, lufs: -10 },
    subtitleTrack: GOOD_SUBS, spec: SPEC, assets: GOOD_ASSETS, durationMs: 10000,
  });
  assert.equal(warn.blocking, false);
  assert.equal(g4Export(warn).ok, true, "a warning must not block the export");
  assert.equal(warn.passed, false, "…but it is still not a clean pass");
});
