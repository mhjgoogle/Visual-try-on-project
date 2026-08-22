// Unit tests for the landing page's project registry (TASK-051B).
//
// The registry is prototype-local scratch: it records a NAME and a DECLARED
// asset root and nothing else. These tests pin the two things that must never
// go wrong — a name that would become an unsafe directory segment is refused,
// and a declared path is displayed with the separator it was written in
// (a Windows root must never be rendered POSIX, or the creator is told their
// assets go somewhere they do not).
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeName, validateName, validateRoot, separatorFor, assetPathFor,
  loadRegistry, saveRegistry, addProject, touchProject, projectCards, trimTrailingSep,
} from "../src/services/projects.js";

const BS = String.fromCharCode(92); // a literal backslash, unambiguously

/** A minimal localStorage stand-in. */
function storage(initial) {
  const m = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _dump: () => Object.fromEntries(m),
  };
}

/* --- names ---------------------------------------------------------------- */

test("normalizeName trims and collapses whitespace, keeps the rest", () => {
  assert.equal(normalizeName("  夜班   沉默 "), "夜班 沉默");
  assert.equal(normalizeName(undefined), "");
});

test("validateName refuses anything that would be an unsafe directory segment", () => {
  assert.equal(validateName("").ok, false);
  assert.equal(validateName("   ").ok, false);
  assert.equal(validateName(".").ok, false);
  assert.equal(validateName("..").ok, false);
  assert.equal(validateName("a/b").ok, false);
  assert.equal(validateName("a" + BS + "b").ok, false);
  assert.equal(validateName("c:name").ok, false);
  assert.equal(validateName("what?").ok, false);
  assert.equal(validateName("x".repeat(61)).ok, false);
  const ok = validateName("  雨夜停电 ");
  assert.equal(ok.ok, true);
  assert.equal(ok.name, "雨夜停电");
});

test("validateName rejects a duplicate case-insensitively (NTFS would collide)", () => {
  assert.equal(validateName("Rainy", ["rainy"]).ok, false);
  assert.equal(validateName("Rainy", ["other"]).ok, true);
});

/* --- roots ---------------------------------------------------------------- */

test("validateRoot accepts either platform's path but never traversal", () => {
  assert.equal(validateRoot("").ok, false);
  assert.equal(validateRoot("/home/me/../etc").ok, false);
  assert.equal(validateRoot("D:" + BS + "a" + BS + ".." + BS + "b").ok, false);
  assert.equal(validateRoot("/home/me/video").ok, true);
  const w = validateRoot("D:" + BS + "02_Work" + BS + "04_video-work" + BS);
  assert.equal(w.ok, true);
  assert.equal(w.root, "D:" + BS + "02_Work" + BS + "04_video-work"); // trailing sep trimmed
});

test("a declared path is joined with the separator its root already uses", () => {
  const win = "D:" + BS + "02_Work" + BS + "04_video-work";
  assert.equal(separatorFor(win), BS);
  assert.equal(assetPathFor(win, "雨夜停电"), win + BS + "雨夜停电");

  assert.equal(separatorFor("/home/me/video"), "/");
  assert.equal(assetPathFor("/home/me/video", "雨夜停电"), "/home/me/video/雨夜停电");

  // UNC and a drive with a forward slash both stay Windows
  assert.equal(separatorFor(BS + BS + "nas" + BS + "media"), BS);
  assert.equal(separatorFor("D:/media"), BS);
  // degenerate inputs never throw
  assert.equal(assetPathFor("", "x"), "x");
  assert.equal(assetPathFor("/root", ""), "/root");
});

/* --- registry ------------------------------------------------------------- */

test("loadRegistry survives absent, corrupt and wrong-shaped storage", () => {
  assert.deepEqual(loadRegistry(storage()), []);
  assert.deepEqual(loadRegistry(storage({ "motv.projects.v1": "{not json" })), []);
  assert.deepEqual(loadRegistry(storage({ "motv.projects.v1": '{"a":1}' })), []);
  assert.deepEqual(loadRegistry(storage({ "motv.projects.v1": '[1,null,{"name":""}]' })), []);
});

test("addProject validates before writing and never half-applies", () => {
  const s = storage();
  const bad = addProject(s, { name: "a/b", assetRoot: "/r", now: "T1" });
  assert.equal(bad.ok, false);
  assert.deepEqual(loadRegistry(s), []); // nothing written

  const ok = addProject(s, { name: " 雨夜停电 ", assetRoot: "/r/", now: "T1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, "雨夜停电");
  assert.equal(ok.assetRoot, "/r");
  assert.deepEqual(loadRegistry(s).map((p) => p.name), ["雨夜停电"]);

  const dup = addProject(s, { name: "雨夜停电", assetRoot: "/r", now: "T2" });
  assert.equal(dup.ok, false);
  assert.equal(loadRegistry(s).length, 1);
});

test("a storage that refuses writes never throws — it reports", () => {
  const s = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(saveRegistry(s, []), false);
  // and the caller is TOLD, so it does not open a project that will vanish
  const res = addProject(s, { name: "x", assetRoot: "/r", now: "T" });
  assert.equal(res.ok, false);
});

test("touchProject only stamps an existing entry", () => {
  const s = storage();
  addProject(s, { name: "A", assetRoot: "/r", now: "T1" });
  touchProject(s, "A", "T9");
  assert.equal(loadRegistry(s)[0].openedAt, "T9");
  touchProject(s, "missing", "T9"); // no throw, no entry
  assert.equal(loadRegistry(s).length, 1);
});

/* --- landing cards -------------------------------------------------------- */

test("projectCards labels real vs canvas projects and never lists one twice", () => {
  const local = [
    { name: "夜班", assetRoot: "/r", createdAt: "T1", openedAt: "T3" },
    { name: "wfm1-demo", assetRoot: "/r", createdAt: "T1", openedAt: "T5" },
  ];
  const cards = projectCards({ local, remote: ["wfm1-demo", "minimal"] });
  assert.equal(cards.length, 3);
  assert.deepEqual(
    [...cards].map((c) => `${c.name}:${c.kind}`).sort(),
    ["minimal:real", "wfm1-demo:real", "夜班:canvas"].sort(),
  );
  // a name the backend really has is shown ONCE, as the real project
  assert.equal(cards.filter((c) => c.name === "wfm1-demo").length, 1);
  assert.equal(cards.find((c) => c.name === "wfm1-demo").kind, "real");
  // the local entry still contributes its remembered asset root
  assert.equal(cards.find((c) => c.name === "wfm1-demo").assetRoot, "/r");
  assert.equal(cards.find((c) => c.name === "夜班").kind, "canvas");
});

test("projectCards puts the most recently opened first and the demo last", () => {
  const local = [
    { name: "old", assetRoot: "", createdAt: "", openedAt: "2026-01-01" },
    { name: "new", assetRoot: "", createdAt: "", openedAt: "2026-08-01" },
  ];
  const cards = projectCards({ local, remote: [], demo: { name: "示例", assetRoot: "" } });
  assert.deepEqual(cards.map((c) => c.name), ["new", "old", "示例"]);
  assert.equal(cards[2].kind, "demo");
});

test("Windows reserved device names are refused as project names", () => {
  for (const bad of ["CON", "nul", "Com1", "LPT9", "aux.txt"]) {
    assert.equal(validateName(bad).ok, false, bad);
  }
  assert.equal(validateName("名字.").ok, false);   // trailing dot
  assert.equal(validateName("名字 ").ok, true);     // trailing space is trimmed first
  assert.equal(validateName("console").ok, true);  // only the exact stems are reserved
});

test("a root that IS a separator survives trimming and joins correctly", () => {
  assert.equal(trimTrailingSep("/"), "/");
  assert.equal(trimTrailingSep("/home/me/"), "/home/me");
  assert.equal(trimTrailingSep(""), "");
  assert.equal(assetPathFor("/", "雨夜"), "/雨夜");
  assert.equal(validateRoot("/").root, "/");
  // a Windows drive root keeps its separator once, not twice
  assert.equal(assetPathFor("D:" + BS, "雨夜"), "D:" + BS + "雨夜");
});

test("addProject reports failure when the registry cannot be written", () => {
  const s = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const res = addProject(s, { name: "x", assetRoot: "/r", now: "T" });
  assert.equal(res.ok, false);
  assert.match(res.error, /未创建/);
});

test("the location is optional metadata — demo mode has no filesystem at all", () => {
  const s = storage();
  const res = addProject(s, { name: "本地草稿", assetRoot: "", now: "T1" });
  assert.equal(res.ok, true);
  assert.equal(res.assetRoot, "");
  assert.equal(loadRegistry(s)[0].assetRoot, "");
  // but a location that IS supplied must still be valid
  assert.equal(addProject(s, { name: "另一个", assetRoot: "../escape", now: "T2" }).ok, false);
});

test("control characters are refused before they can reach the backend", () => {
  // a NUL reaches Path() server-side and raises ValueError (not OSError),
  // which would drop the connection instead of returning a 400
  // (tab and friends are whitespace: normalizeName already collapses them,
  //  so the check only has to catch the non-whitespace controls)
  for (const bad of ["a\u0000b", "bell\u0007", "esc\u001b[0m", "del\u007f"]) {
    assert.equal(validateName(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateName("正常名字").ok, true);
});
