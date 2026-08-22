// TASK-084 项 2 — the TOP-LEVEL `reviews` is schema-validated on load.
//
// `production.shotProduction.reviews` has been validated element by element since
// v13, but the top-level `reviews` was not validated at all: `restoreGraph`
// hydrated `decisions` behind a bare `Array.isArray` check and took every element
// verbatim, so a decision of any shape reached G3 — the gate that decides whether
// an episode's approval still stands and whether the picture stays locked.
//
// The rule pinned here is `deliverySpec`'s rule, deliberately NOT a second one:
//   ABSENT (or null) validates — it is an additive field, and refusing a document
//   that omits it would refuse every archive written before it existed;
//   PRESENT-BUT-WRONG rejects the WHOLE document.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAYERS, ISSUE_CATEGORIES, SEVERITIES, ISSUE_STATES, VERDICTS,
  decision, relocateLegacyIssues,
} from "../src/workflow/review.js";
import { g3Retire, G3_TRIGGERS } from "../src/workflow/gates.js";
import {
  CANVAS_SCHEMA_VERSION, migrateToCurrent, validateCanvasDoc,
} from "../src/services/canvasschema.js";

/** A genuine current-version document, built through the real migration chain. */
function currentDoc() {
  const res = migrateToCurrent({
    v: 1, project: "demo",
    scriptDoc: { brief: "", versions: [], active: 0, workingText: null },
    nodes: [], edges: [], pan: { x: 0, y: 0 },
  });
  assert.equal(res.status, "ok", res.detail);
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  return res.doc;
}

const goodDecision = () => ({
  decisionId: "dec-1", layer: "episode", targetId: "ep-1", verdict: "passed",
  by: "user", at: "2026-08-16T00:00:00Z", basedOnVersion: 3, openIssueIds: ["iss-1"],
});
const goodIssue = () => ({
  issueId: "iss-1", layer: "episode", targetType: "episode", targetId: "ep-1",
  locatedShotId: "shot-1", category: "pacing", severity: "warning", source: "agent",
  text: "这里节奏慢", state: "open", ignoredBy: null, ignoredAt: null,
});

test("项 2: an ABSENT `reviews` still validates — every existing archive omits it", () => {
  // THE EASIEST THING TO GET WRONG. `reviews` is additive: requiring it would refuse
  // to load every document written before it existed, and one of the two real
  // Connected Projects on this machine carries no `reviews` key at all.
  const doc = currentDoc();
  assert.equal("reviews" in doc, false);
  assert.equal(validateCanvasDoc(doc), null);
  doc.reviews = null; // explicitly 「未记录」 validates the same way
  assert.equal(validateCanvasDoc(doc), null);
  doc.reviews = {}; // present, carrying neither array
  assert.equal(validateCanvasDoc(doc), null);
  doc.reviews = { issues: [], decisions: [] }; // the shape `restoreGraph` writes
  assert.equal(validateCanvasDoc(doc), null);
});

test("项 2: a well-formed `reviews` validates, including a legacy issue with no locatedShotId", () => {
  const doc = currentDoc();
  doc.reviews = { issues: [goodIssue()], decisions: [goodDecision()] };
  assert.equal(validateCanvasDoc(doc), null);

  // TASK-074 §1.3's migration exists to ACCEPT AND MARK an episode issue that never
  // recorded which shot it meant. Validating `locatedShotId` here would reject the
  // documents that migration ships to repair, so it deliberately does not.
  const legacy = { ...goodIssue(), locatedShotId: null };
  doc.reviews = { issues: [legacy], decisions: [] };
  assert.equal(validateCanvasDoc(doc), null);
  delete legacy.locatedShotId;
  assert.equal(validateCanvasDoc(doc), null);
  // …and the migration still marks it, i.e. the two halves agree
  assert.equal(relocateLegacyIssues([legacy])[0].needsRelocation, true);
});

test("项 2: a decision NOT made by the creator is refused at LOAD, not only at creation", () => {
  // review.js refuses to CREATE one (合同 §6.2 「不得静默定稿」). Before this, a stored
  // decision claiming an AI author loaded fine and G3 read it as a real 通过.
  const doc = currentDoc();
  assert.equal(decision({ ...goodDecision(), by: "agent" }).ok, false); // creation side
  doc.reviews = { issues: [], decisions: [{ ...goodDecision(), by: "agent" }] };
  assert.match(String(validateCanvasDoc(doc)), /not made by the creator/);
});

test("项 2: a malformed decision rejects the WHOLE document (deliverySpec's rule, not a second one)", () => {
  const doc = currentDoc();
  const reject = (mutate, label) => {
    const d = goodDecision();
    mutate(d);
    doc.reviews = { issues: [], decisions: [d] };
    assert.ok(validateCanvasDoc(doc), `expected rejection: ${label}`);
  };
  reject((d) => { delete d.decisionId; }, "no decisionId");
  reject((d) => { d.decisionId = ""; }, "empty decisionId");
  reject((d) => { d.layer = "story"; }, "unknown layer");
  reject((d) => { d.verdict = "ok"; }, "unknown verdict");
  reject((d) => { d.targetId = ""; }, "no target");
  reject((d) => { delete d.basedOnVersion; }, "no basedOnVersion");
  reject((d) => { d.basedOnVersion = "3"; }, "basedOnVersion is not an integer");
  reject((d) => { d.at = 1755300000000; }, "at is not a string");
  reject((d) => { d.openIssueIds = "iss-1"; }, "openIssueIds is not an array");
  reject((d) => { d.openIssueIds = [""]; }, "empty openIssueId");

  doc.reviews = { issues: [], decisions: ["not an object"] };
  assert.ok(validateCanvasDoc(doc), "expected rejection: non-object decision");
  doc.reviews = { issues: [], decisions: { "dec-1": goodDecision() } };
  assert.ok(validateCanvasDoc(doc), "expected rejection: decisions is not an array");
  doc.reviews = [];
  assert.ok(validateCanvasDoc(doc), "expected rejection: reviews is not an object");
});

test("项 2: a malformed issue rejects the whole document too", () => {
  const doc = currentDoc();
  const reject = (mutate, label) => {
    const it = goodIssue();
    mutate(it);
    doc.reviews = { issues: [it], decisions: [] };
    assert.ok(validateCanvasDoc(doc), `expected rejection: ${label}`);
  };
  reject((i) => { i.issueId = ""; }, "no issueId");
  reject((i) => { i.layer = "delivery"; }, "category belongs to another layer");
  reject((i) => { i.category = "loudness"; }, "delivery category on an episode issue");
  reject((i) => { i.severity = "urgent"; }, "unknown severity");
  reject((i) => { i.state = "done"; }, "unknown state");
  reject((i) => { i.source = "system"; }, "does not say who raised it");
  reject((i) => { i.targetId = ""; }, "no target");
  reject((i) => { i.text = "   "; }, "blank text");
  reject((i) => { i.locatedShotId = 7; }, "locatedShotId is not a string");

  doc.reviews = { issues: [null], decisions: [] };
  assert.ok(validateCanvasDoc(doc), "expected rejection: non-object issue");
  doc.reviews = { issues: "iss-1", decisions: [] };
  assert.ok(validateCanvasDoc(doc), "expected rejection: issues is not an array");
});

test("项 2: the validator reads the DOMAIN's vocabularies, not a forked copy of them", () => {
  // A copied list is how a validator starts rejecting what the domain legitimately
  // produces (the v10 pair-key defect, twice over). So every value the domain
  // accepts must validate, checked against the domain's own exports — if someone
  // adds a category or a verdict there, this test fails until the schema follows.
  const doc = currentDoc();
  for (const layer of LAYERS) {
    for (const category of ISSUE_CATEGORIES[layer]) {
      const it = {
        ...goodIssue(), layer, category, targetType: layer,
        locatedShotId: layer === "episode" ? "shot-1" : null,
      };
      doc.reviews = { issues: [it], decisions: [] };
      assert.equal(validateCanvasDoc(doc), null, `${layer}/${category} must validate`);
    }
    for (const verdict of VERDICTS) {
      doc.reviews = { issues: [], decisions: [{ ...goodDecision(), layer, verdict }] };
      assert.equal(validateCanvasDoc(doc), null, `${layer}/${verdict} must validate`);
    }
  }
  for (const severity of SEVERITIES) {
    doc.reviews = { issues: [{ ...goodIssue(), severity }], decisions: [] };
    assert.equal(validateCanvasDoc(doc), null, `severity ${severity} must validate`);
  }
  for (const state of ISSUE_STATES) {
    doc.reviews = { issues: [{ ...goodIssue(), state }], decisions: [] };
    assert.equal(validateCanvasDoc(doc), null, `state ${state} must validate`);
  }
});

test("项 2: a decision RETIRED by G3 still validates (the one runtime rewrite of a stored decision)", () => {
  const doc = currentDoc();
  const g3 = g3Retire([goodDecision()], {
    episodeId: "ep-1", trigger: G3_TRIGGERS[0], at: "2026-08-16T01:00:00Z",
  });
  assert.equal(g3.changed, true, g3.reason);
  doc.reviews = { issues: [], decisions: [g3.next] };
  // the extra retiredBy/retiredAt keys are KEPT, not rejected: a future build's
  // field must not make this build refuse the whole document
  assert.equal(validateCanvasDoc(doc), null);
});

test("项 2: `deliverySpec` keeps its behaviour exactly (regression — the rule is shared now)", () => {
  const doc = currentDoc();
  assert.equal("deliverySpec" in doc, false);
  assert.equal(validateCanvasDoc(doc), null);
  doc.deliverySpec = null;
  assert.equal(validateCanvasDoc(doc), null);
  doc.deliverySpec = {};
  assert.equal(validateCanvasDoc(doc), null);
  doc.deliverySpec = { platform: "douyin", fps: 30, budgetTotalUsd: 12.5, futureField: "kept" };
  assert.equal(validateCanvasDoc(doc), null);
  doc.deliverySpec = { platform: "tiktok" };
  assert.match(String(validateCanvasDoc(doc)), /allowed values/);
  doc.deliverySpec = { fps: 0 };
  assert.match(String(validateCanvasDoc(doc)), /out of range/);
  doc.deliverySpec = [];
  assert.match(String(validateCanvasDoc(doc)), /not an object/);
});

test("项 2: the rejection happens on the LOAD path, not only inside the validator", () => {
  // migrateToCurrent is what every load routes through; a malformed `reviews` must
  // come back `invalid` THERE, or the validation is unreachable in practice.
  const doc = currentDoc();
  doc.reviews = { issues: [], decisions: [{ ...goodDecision(), by: "agent" }] };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "invalid");
  assert.match(res.detail, /not made by the creator/);

  const ok = currentDoc();
  ok.reviews = { issues: [goodIssue()], decisions: [goodDecision()] };
  assert.equal(migrateToCurrent(ok).status, "ok");
});
