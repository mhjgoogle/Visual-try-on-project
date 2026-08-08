// Unit tests for the Production workspace view-model (`scriptStatus`) — the
// pure lens the shell renders from, driven through REAL scriptdoc transitions
// so the two stay contract-compatible. Run via `node --test`, wrapped by
// tests/test_motv_production_view_e2e.py. No DOM.
import test from "node:test";
import assert from "node:assert/strict";

import * as sd from "../src/workflow/scriptdoc.js";
import { scriptStatus } from "../src/ui/production.js";

test("empty document: no versions, no transient state", () => {
  const st = scriptStatus(sd.createDoc());
  assert.deepEqual(st, {
    versions: 0,
    active: 0,
    nextVersion: 1,
    generating: false,
    proposal: null,
    error: null,
  });
});

test("generating → applied v1 → proposal → applied v2 mirrors the domain", () => {
  const d = sd.createDoc();
  const id = sd.beginGeneration(d, "initial", "想法");
  assert.equal(scriptStatus(d).generating, true);
  sd.completeGeneration(d, id, "v1 正文");
  let st = scriptStatus(d);
  assert.equal(st.generating, false);
  assert.equal(st.versions, 1);
  assert.equal(st.active, 1);
  assert.equal(st.nextVersion, 2);
  // revision → PROPOSAL state carries instruction + text for the AI pane
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改结尾"), "v2 提案");
  st = scriptStatus(d);
  assert.deepEqual(st.proposal, { instruction: "改结尾", text: "v2 提案" });
  assert.equal(st.versions, 1); // not yet durable — apply is explicit
  sd.applyProposal(d);
  st = scriptStatus(d);
  assert.equal(st.proposal, null);
  assert.equal(st.versions, 2);
  assert.equal(st.active, 2);
});

test("failed generation surfaces the error; cancel clears it", () => {
  const d = sd.createDoc();
  const id = sd.beginGeneration(d, "initial", "想法");
  sd.failGeneration(d, id, "CLI 超时");
  assert.equal(scriptStatus(d).error, "CLI 超时");
  assert.equal(scriptStatus(d).generating, false);
  sd.cancelGeneration(d);
  assert.equal(scriptStatus(d).error, null);
});

test("version switch keeps the lens consistent (active follows selection)", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1 正文");
  sd.completeGeneration(d, sd.beginGeneration(d, "revision", "改"), "v2 正文");
  sd.applyProposal(d);
  sd.setActive(d, 1);
  const st = scriptStatus(d);
  assert.equal(st.active, 1);
  assert.equal(st.versions, 2);
  assert.equal(st.nextVersion, 3);
});
