// TASK-072 §1.7 — the ArtifactVersion six-state DERIVED view (系统合同 §3).
//
// The point of these is that the mapping is a mapping: the same stored documents,
// read in one vocabulary. So each case states a stored shape and the six-state
// answer it must produce — never a new field the documents would have to grow.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_STATES,
  ACTIVE_STATES,
  STATE_LABEL,
  stateOfVersion,
  promptVersionStates,
  chainVersionStates,
  activeVersion,
  stateAllowedFrom,
} from "../src/workflow/artifactversion.js";

test("the state set is exactly six, and deprecated is ONE OF THEM", () => {
  assert.deepEqual(ARTIFACT_STATES, [
    "draft", "suggested", "candidate", "confirmed", "locked", "deprecated",
  ]);
  // ADR-0066 §6 校正 6 retired the 「五态 + deprecated」 reading. A label for each,
  // or a surface renders a raw English key at the creator.
  for (const s of ARTIFACT_STATES) assert.ok(STATE_LABEL[s], `${s} has no label`);
  assert.deepEqual(ACTIVE_STATES, ["confirmed", "locked"]);
});

test("confirmed / locked can ONLY come from the user (§3.1 invariant 1)", () => {
  for (const state of ["confirmed", "locked"]) {
    assert.equal(stateAllowedFrom(state, "user").ok, true);
    const ai = stateAllowedFrom(state, "ai");
    assert.equal(ai.ok, false, `${state} must never be produced by automation`);
    // a refusal has to SAY why — a bare false leaves the caller with nothing to show
    assert.match(ai.reason, /只能由你本人/);
  }
  // …and an agent may still propose and generate
  assert.equal(stateAllowedFrom("suggested", "ai").ok, true);
  assert.equal(stateAllowedFrom("candidate", "ai").ok, true);
  assert.equal(stateAllowedFrom("nonsense", "user").ok, false);
});

test("a prompt entry maps to six states without changing storage", () => {
  const entry = {
    active: 2,
    locked: false,
    versions: [
      { v: 1, text: "第一版", origin: "manual", at: "t1" },
      { v: 2, text: "选中的这版", origin: "manual", at: "t2" },
      { v: 3, text: "AI 提的", origin: "skill", at: "t3" },
      { v: 4, text: "   ", origin: "manual", at: "t4" },
    ],
  };
  assert.deepEqual(promptVersionStates(entry).map((s) => s.state), [
    "candidate",  // stored, not active, human-written
    "confirmed",  // the active pointer
    "suggested",  // came out of a Skill Run
    "draft",      // written but empty — never offered as something to pick
  ]);
  assert.equal(activeVersion(promptVersionStates(entry)).version, 2);
});

test("the entry lock moves the ACTIVE version to locked, and only it", () => {
  const entry = {
    active: 2,
    locked: true,
    versions: [{ v: 1, text: "a", origin: "manual" }, { v: 2, text: "b", origin: "manual" }],
  };
  // A lock says 「the version in force must not be overwritten」. Reporting every
  // historical version as locked would claim the creator pinned things they never
  // looked at — and would make 「解锁」 look like it had to release four things.
  assert.deepEqual(promptVersionStates(entry).map((s) => s.state), ["candidate", "locked"]);
  assert.equal(activeVersion(promptVersionStates(entry)).state, "locked");
});

test("`active: 0` is a REAL state: nothing stored is confirmed", () => {
  // promptdoc's 「回到自动编译，但保留我写过的版本」. Falling back to 「the newest is
  // confirmed」 would report a version the creator explicitly stepped away from as
  // the one in force.
  const entry = {
    active: 0,
    locked: false,
    versions: [{ v: 1, text: "a", origin: "manual" }, { v: 2, text: "b", origin: "manual" }],
  };
  const states = promptVersionStates(entry);
  assert.deepEqual(states.map((s) => s.state), ["candidate", "candidate"]);
  assert.equal(activeVersion(states), null);
});

test("a media chain maps the same way, and storageState stays ORTHOGONAL", () => {
  const chain = {
    current: 2,
    history: [
      { version: 1, assetId: "a1", origin: "upload", storageState: "archived" },
      { version: 2, assetId: "a2", origin: "paid-image", storageState: "archived" },
    ],
  };
  const states = chainVersionStates(chain);
  assert.deepEqual(states.map((s) => s.state), ["candidate", "confirmed"]);
  // §3.2: 「字节在不在」 is not 「这版行不行」. A confirmed version whose bytes were
  // archived is still confirmed; merging the two would silently un-confirm it.
  assert.equal(states[1].storageState, "archived");
  assert.equal(states[1].state, "confirmed");
});

test("deprecated wins from anywhere, including the active version", () => {
  // It is reachable from every other state, so it cannot be ranked below them.
  assert.equal(stateOfVersion({ v: 1, deprecated: true }, { active: 1, locked: true }), "deprecated");
  assert.equal(stateOfVersion({ v: 9, origin: "skill" }, { active: 0, deprecated: true }), "deprecated");
});

test("garbage in is null out, never a state that looks meaningful", () => {
  assert.equal(stateOfVersion(null, {}), null);
  assert.equal(stateOfVersion("v1", {}), null);
  assert.deepEqual(promptVersionStates(null), []);
  assert.deepEqual(promptVersionStates({ versions: "oops" }), []);
  assert.deepEqual(chainVersionStates({ history: null }), []);
  assert.equal(activeVersion(null), null);
});
