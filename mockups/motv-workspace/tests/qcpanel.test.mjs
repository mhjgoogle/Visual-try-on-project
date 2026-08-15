// TASK-074 §1.2 — the 交付质检 panel. The screen's whole job is to be honest about
// what it did NOT measure, so that is what these assert.
import test from "node:test";
import assert from "node:assert/strict";

import { renderQcPanel } from "../src/ui/qcpanel.js";
import { runDeliveryQc, QC_CHECKS } from "../src/workflow/deliveryqc.js";
import { g4Export } from "../src/workflow/gates.js";

/** What the browser can actually supply today: no probe. */
function browserReport(over = {}) {
  return runDeliveryQc({
    probe: null,
    subtitleTrack: { cues: [{ startMs: 0, endMs: 1200, text: "陛下" }] },
    spec: { subtitleMode: "sidecar" },
    assets: [{ assetId: "a1", origin: "upload" }],
    // the CUT's duration — what the cues were authored against. The rendered file's
    // duration needs a probe, and ⚙'s target is not a measurement.
    durationMs: 60_000,
    deliveryId: "ep-1",
    ...over,
  }, { issueIdFor: (k, n) => `qc-ep-1-${k}-${n}` });
}

test("a check that could not run renders as 未检查, never as a tick", () => {
  const report = browserReport();
  const html = renderQcPanel({ report, g4: g4Export(report) });
  // the five probe-based checks are unavailable, and the screen says so per row
  for (const label of ["音画同步", "音量", "削波", "黑帧", "缺帧"]) {
    assert.match(html, new RegExp(label), `${label} must be listed`);
  }
  assert.equal((html.match(/未检查/g) || []).length >= 5, true);
  // 规格 is unavailable for a DIFFERENT reason — nobody filled ⚙ in — and the row
  // says which, because 「去把它填了」 and 「装个 ffmpeg」 are different actions
  assert.match(html, /规格里没有设置/);
  // every declared check has a row — a screen that silently omits one reads as
  // 「不适用」 when the truth is 「没测」
  assert.equal(report.rows.length, QC_CHECKS.length);
  // and the count is stated rather than implied
  assert.match(html, /已检查 <b>2<\/b> \/ 8 项/);
  assert.match(html, /尚未全部合格/);
  // by CLASS, not by substring: 「尚未全部合格」 contains 「全部合格」
  assert.equal(html.includes('class="qc-ok"'), false);
});

test("G4's verdict is RENDERED, not re-derived — and an unknown is not a pass", () => {
  const report = browserReport();
  const g4 = g4Export(report);
  // no blocking issue is open, so G4 does not stand in the way…
  assert.equal(g4.ok, true);
  const html = renderQcPanel({ report, g4 });
  // …but the panel still says the export is not proven good
  assert.match(html, /「没跑」和「警告」都不等于「通过」/);
  assert.match(html, /qc-gate-warn/);
  assert.equal(/qc-gate-ok/.test(html), false);
});

test("a blocking failure shows G4 refusing, with the offending issue named", () => {
  // an unmarked asset is a blocking 素材权限 failure
  const report = browserReport({ assets: [{ assetId: "a1", origin: "" }] });
  const g4 = g4Export(report);
  assert.equal(g4.ok, false);
  const html = renderQcPanel({ report, g4 });
  assert.match(html, /qc-gate-block/);
  assert.match(html, /G4 拒绝导出/);
  assert.match(html, /没有标注来源/);
  assert.match(html, /qc-ep-1-rights-1/, "the issue id must be visible, not just a count");
  // …and the row itself is marked blocking, not merely red
  assert.match(html, /qc-sev-blocking/);
});

test("never run at all is its own statement, and G4 refuses it", () => {
  const html = renderQcPanel({ report: null, g4: g4Export(null) });
  assert.match(html, /还没有跑过交付质检/);
  assert.match(html, /G4 拒绝导出/);
  assert.match(html, /没跑不等于通过/);
});

test("the panel escapes its detail text", () => {
  const report = browserReport({ assets: [{ assetId: "<script>", origin: "" }] });
  const html = renderQcPanel({ report, g4: g4Export(report) });
  assert.equal(html.includes("<script>"), false);
});

test("without a cut, 字幕 is unavailable too — an empty timeline is not a 0-length film", () => {
  // a 0 duration would mark every cue as running past the end of the film, so
  // 「还没有剪辑」 has to read as unknown
  const report = browserReport({ durationMs: null });
  const sub = report.rows.find((r) => r.key === "subtitle");
  assert.equal(sub.state, "unavailable");
  assert.match(sub.detail, /没有提供成片时长/);
  const html = renderQcPanel({ report, g4: g4Export(report) });
  assert.match(html, /已检查 <b>1<\/b> \/ 8 项/);
});

test("a WARNING-level failure never renders as 合格, even though G4 lets it through", () => {
  // G4 only clears BLOCKING issues, so an off-target loudness leaves `g4.ok` true
  // while `report.passed` is false. Reading the gate as a verdict painted 「全部合格」
  // over a ❌ row and a 尚未全部合格 header (independent review). The gate answers
  // 「能不能导出」; only the report answers 「合格没有」.
  const report = browserReport({
    probe: {
      avOffsetMs: 0, lufs: -8, truePeakDbtp: -6, blackSpans: [],
      frameCount: 1500, durationMs: 60_000, fps: 25,
      resolution: "1080x1920", container: "mp4",
      videoBitrateKbps: 6000, audioBitrateKbps: 128,
    },
    spec: {
      subtitleMode: "sidecar", resolution: "1080x1920", fps: 25, container: "mp4",
      videoBitrateKbps: 6000, audioBitrateKbps: 128,
    },
  });
  const loud = report.rows.find((r) => r.key === "loudness");
  assert.equal(loud.state, "fail");
  assert.equal(loud.severity, "warning");
  assert.equal(report.passed, false);

  const g4 = g4Export(report);
  assert.equal(g4.ok, true, "a warning does not block the export…");
  const html = renderQcPanel({ report, g4 });
  assert.equal(html.includes("qc-gate-ok"), false, "…but it is not 合格 either");
  assert.match(html, /qc-gate-warn/);
  assert.match(html, /1<\/b> 项不合格/);
  assert.match(html, /警告」都不等于「通过/);
});

test("the verdict line states the REAL number of checks, not a stale literal", () => {
  // 「七项」 was hard-coded while QC_CHECKS has eight rows (削波 is its own), so the
  // green line contradicted the header two lines above it
  assert.equal(QC_CHECKS.length, 8);
  const rows = QC_CHECKS.map((c) => ({ key: c.key, label: c.label, state: "pass", detail: "ok" }));
  const passing = { rows, issues: [], unavailable: [], unavailableRows: [], passed: true, blocking: false };
  const html = renderQcPanel({ report: passing, g4: g4Export(passing) });
  assert.match(html, /8 项全部检查完毕且合格/);
  assert.equal(html.includes("七项"), false);
});

test("素材权限 judges THE FILM's assets, and an incomplete list is unknown", () => {
  // the registry is the whole project — superseded versions, rejected takes, other
  // episodes' material. Feeding it here made one unused old record with no `origin` a
  // BLOCKING failure on an episode that never touched it, and a green row counted
  // assets outside the cut (independent review).
  const inCut = browserReport({ assets: [{ assetId: "a1", origin: "upload" }] });
  assert.match(inCut.rows.find((r) => r.key === "rights").detail, /1 个素材都标注了来源/);

  // a list that could not be built is UNKNOWN, not a rights failure: 「查不到这个
  // 素材」 and 「这个素材没标来源」 are different findings
  const noList = browserReport({ assets: null });
  const row = noList.rows.find((r) => r.key === "rights");
  assert.equal(row.state, "unavailable");
  assert.match(row.detail, /没有拿到/, "…and it says the list could not be READ");

  // an EMPTY list is a different statement: the cut exists and uses no assets. Both
  // end in `unavailable` — the verdict was never the problem — but they send the
  // creator to different places (independent review, round 3).
  const emptyList = browserReport({ assets: [] });
  const emptyRow = emptyList.rows.find((r) => r.key === "rights");
  assert.equal(emptyRow.state, "unavailable");
  assert.match(emptyRow.detail, /清单是空的/);
  assert.notEqual(emptyRow.detail, row.detail);
  assert.equal(g4Export(noList).ok, true, "an unknown must not block the export…");
  assert.equal(noList.passed, false, "…and must not pass it either");
});

test("the note is DERIVED, so it stops telling you to fill ⚙ once ⚙ is filled", () => {
  const unset = renderQcPanel({ report: browserReport(), g4: null });
  assert.match(unset, /去 ⚙ 项目设置/);

  // ⚙ complete, but still no probe: the 规格 row now says it could not READ the file
  const filled = browserReport({
    spec: {
      subtitleMode: "sidecar", resolution: "1080x1920", fps: 25, container: "mp4",
      videoBitrateKbps: 6000, audioBitrateKbps: 128,
    },
  });
  const html = renderQcPanel({ report: filled, g4: g4Export(filled) });
  assert.equal(html.includes("去 ⚙ 项目设置"), false, "the setting is already filled");
  assert.match(html, /要等成片渲染出来/);
  // an explicit note still wins, for a caller that has something more specific to say
  assert.match(renderQcPanel({ report: filled, g4: null, note: "自定义" }), /自定义/);
});
