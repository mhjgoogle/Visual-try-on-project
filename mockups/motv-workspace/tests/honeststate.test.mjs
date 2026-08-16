// TASK-077 — 诚实状态与死掉的面 (UI Gap Audit Phase 0), as RULES:
//
//   1. An UNAVAILABLE budget field renders `—`, never `¥0`. 「余额 ¥0」 on a project
//      that merely has no `config/wfm1.json` is the one audit defect a creator
//      could act wrongly on.
//   2. A registered asset whose file is not on disk renders an honest placeholder
//      that says WHY and WHICH FILE — not an `<img>` at a 404 — and 存储与诊断
//      counts it. Detection is DISPLAY-ONLY: nothing writes `storageState`.
//   3. A reference's use is stated for the ROUTE IN FORCE. On the Gateway route
//      the request carries one image (the first frame), so the four attachment
//      roles are not 「模型直接输入」.
//   4. Every page of `EPISODE_NAV` resolves to a real page AND a real section, is
//      drawn by a real rail, and ⑨ 粗剪审片 is reachable.
//   5. The batch pipeline (ui/wizard.js) has an entrance on the main path.
//   6. The breadcrumb draws only the segments the current page is really about.
//
// Pure: no DOM, no clock, no network. Every assertion is about a derivation or
// about the HTML string a pure renderer returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapStanding, yenOf, UNKNOWN, money } from "../src/services/realmap.js";
import {
  createMediaProbe, registryUrls, isProbeable, MISSING, PRESENT, INCONCLUSIVE,
} from "../src/services/mediaprobe.js";
import { storageModel } from "../src/ui/storagews.js";
import {
  EPISODE_NAV, EPISODE_MODULES, PAGE_SECTIONS, PAGES, MODULE_LABEL,
  renderEpisodeRail, resolveModule, spaceOf, crumbScope, mediaBox, mediaGoneBox, fileNameOf,
} from "../src/ui/shell.js";
import {
  ROLE_USE, ROUTE_CAPABILITY, routeCapability, effectiveRoleUse, downgradedRoles,
  referenceRouteNote, referenceRouteMatrix, MODEL_INPUT_ROLES, INTERPRETATION_ROLES,
} from "../src/workflow/geninput.js";
import { compileVideoPrompt, compileImagePrompt } from "../src/workflow/promptc.js";
import { renderAssetLibrary } from "../src/ui/assetlibws.js";
import { renderStoryboard } from "../src/ui/storyboard.js";
import * as proddoc from "../src/workflow/proddoc.js";

/* ========================================================================= */
/* 1 · 预算：unavailable 不得渲染成 ¥0                                        */
/* ========================================================================= */

// The REAL response from `GET /api/projects/照见未明rev2/budget`, 2026-08-16.
const UNAVAILABLE_BUDGET = {
  query_id: "WQ-14",
  items: [{
    budgets_jpy: { value: "no config", provenance: "unavailable" },
    episode_committed_jpy: { value: "no config/data", provenance: "unavailable" },
    episode_outstanding_holds_jpy: { value: "no config/data", provenance: "unavailable" },
  }],
  problems: [{
    category: "source_corrupt",
    detail: "config: project config does not exist: D:\\…\\config\\wfm1.json",
    context: { source: "config" },
  }],
  markers: ["contains_unavailable", "has_problems"],
};

const AVAILABLE_BUDGET = {
  items: [{
    budgets_jpy: {
      value: { episode_hard: 40000, episode_soft: 30000, per_shot: 900, monthly_hard: 200000 },
      provenance: "config",
    },
    episode_committed_jpy: { value: 12000, provenance: "events" },
    episode_outstanding_holds_jpy: { value: 3000, provenance: "events" },
  }],
  problems: [],
};

test("mapStanding keeps provenance instead of coercing an unavailable field to 0", () => {
  const s = mapStanding(UNAVAILABLE_BUDGET);
  for (const key of ["total", "spent", "held", "remaining", "softCap", "perShot", "monthlyCap"]) {
    assert.equal(s[key].available, false, `${key} must not claim to be known`);
    assert.equal(s[key].value, null, `${key} must be null, never 0`);
    assert.notEqual(s[key].value, 0, `${key} coerced to 0 is the whole defect`);
  }
  assert.equal(s.complete, false);
});

test("an unavailable field prints — and never ¥0", () => {
  const s = mapStanding(UNAVAILABLE_BUDGET);
  assert.equal(yenOf(s.remaining), UNKNOWN);
  assert.equal(yenOf(s.spent), UNKNOWN);
  assert.equal(yenOf(s.total), UNKNOWN);
  for (const key of ["total", "spent", "held", "remaining"]) {
    assert.ok(!yenOf(s[key]).includes("0"), `${key} must not print a zero amount`);
  }
});

test("a REAL budget still reads as numbers, and 剩余 is still derived", () => {
  const s = mapStanding(AVAILABLE_BUDGET);
  assert.equal(s.total.value, 40000);
  assert.equal(s.spent.value, 12000);
  assert.equal(s.held.value, 3000);
  assert.equal(s.remaining.value, 40000 - 12000 - 3000);
  assert.equal(s.remaining.available, true);
  assert.equal(s.complete, true);
  assert.equal(yenOf(s.remaining), "¥25,000 JPY");
});

test("剩余 is unavailable whenever ANY of its inputs is — never a partial sum", () => {
  const s = mapStanding({
    items: [{
      budgets_jpy: { value: { episode_hard: 40000 }, provenance: "config" },
      episode_committed_jpy: { value: "no config/data", provenance: "unavailable" },
      episode_outstanding_holds_jpy: { value: 0, provenance: "events" },
    }],
  });
  assert.equal(s.total.available, true);
  assert.equal(s.remaining.available, false);
  assert.equal(yenOf(s.remaining), UNKNOWN);
  // …and 0 committed is a REAL observation, not an absence
  assert.equal(s.held.available, true);
  assert.equal(s.held.value, 0);
});

test("problems[] reaches the front end (it never did before)", () => {
  const s = mapStanding(UNAVAILABLE_BUDGET);
  assert.equal(s.problems.length, 1);
  assert.equal(s.problems[0].category, "source_corrupt");
  assert.equal(s.problems[0].source, "config");
  assert.ok(s.problems[0].detail.includes("wfm1.json"));
  assert.deepEqual(mapStanding(AVAILABLE_BUDGET).problems, []);
});

test("mapStanding survives a malformed / empty payload without inventing zeros", () => {
  for (const bad of [undefined, null, {}, { items: [] }, { items: [{}] }]) {
    const s = mapStanding(bad);
    assert.equal(s.total.available, false);
    assert.equal(s.total.value, null);
    assert.deepEqual(s.problems, []);
  }
});

test("money() distinguishes a real 0 from an absent number", () => {
  assert.deepEqual(money(0, "events"), { value: 0, available: true, provenance: "events", note: null });
  const none = money("no config", "unavailable");
  assert.equal(none.available, false);
  assert.equal(none.value, null);
  assert.equal(none.note, "no config", "the DTO's own words are kept as the reason");
});

/* ========================================================================= */
/* 2 · 媒体缺失：诚实占位 + 真实计数                                          */
/* ========================================================================= */

// The REAL registry of 照见未明rev2: nine `local` image records, seven files.
const GONE_A = "/api/uploads/p/assets-ref-c6e26bfb_v1.png";
const GONE_B = "/api/uploads/p/assets-ref-5d4cf6e2_v1.png";
const REG = {
  images: {
    a: { current: 1, history: [{ assetId: "A", version: 1, url: GONE_A, storageState: "local", origin: "upload" }] },
    b: { current: 1, history: [{ assetId: "B", version: 1, url: GONE_B, storageState: "local", origin: "upload" }] },
    c: { current: 1, history: [{ assetId: "C", version: 1, url: "/api/uploads/p/ok_v1.png", storageState: "local", origin: "upload" }] },
    d: { current: 1, history: [{ assetId: "D", version: 1, url: "/api/uploads/p/arch_v1.png", storageState: "archived", origin: "upload" }] },
  },
  videos: {}, audio: {}, finals: [], firstFrames: {},
};
const NO_REFS = () => ({ blocking: [], provenance: 0 });

test("存储与诊断 reported 0 unavailable while two files were gone — now it counts them", () => {
  const before = storageModel({ reg: REG, referencesOf: NO_REFS });
  assert.equal(before.stats.missing, 0, "the declaration alone is what reported 0");

  const after = storageModel({
    reg: REG,
    referencesOf: NO_REFS,
    probeMissing: (url) => url === GONE_A || url === GONE_B,
  });
  assert.equal(after.stats.missing, 2);
  assert.equal(after.stats.probedMissing, 2);
});

test("the probe is an OBSERVATION laid beside the declaration — it never rewrites it", () => {
  const m = storageModel({
    reg: REG,
    referencesOf: NO_REFS,
    probeMissing: (url) => url === GONE_A,
  });
  const row = m.rows.find((r) => r.assetId === "A");
  assert.equal(row.state, "local", "storageState is NOT changed — that is a persistence decision");
  assert.equal(row.probedMissing, true);
  // …and the source record itself is untouched
  assert.equal(REG.images.a.history[0].storageState, "local");
});

test("an already-archived row is not re-reported as a new finding", () => {
  const m = storageModel({
    reg: REG,
    referencesOf: NO_REFS,
    probeMissing: () => true, // even if everything 404s
  });
  const arch = m.rows.find((r) => r.assetId === "D");
  assert.equal(arch.probedMissing, false, "archived bytes are SUPPOSED to be absent");
  assert.equal(m.stats.probedMissing, 3, "the three that claim to be local");
});

test("a probe-less model claims nothing (tests, offline, nothing scanned yet)", () => {
  const m = storageModel({ reg: REG, referencesOf: NO_REFS });
  assert.equal(m.stats.probedMissing, 0);
  assert.ok(m.rows.every((r) => r.probedMissing === false));
});

test("registryUrls lists every declared media URL, deduped, probeable only", () => {
  const urls = registryUrls({
    ...REG,
    videos: { v: { current: 1, history: [{ assetId: "V", version: 1, url: "/x/v.mp4" }] } },
    finals: [{ assetId: "F", url: "/x/f.mp4" }],
    firstFrames: { s1: { assetId: "A", url: GONE_A } }, // already listed by images
  });
  assert.ok(urls.includes(GONE_A));
  assert.equal(urls.filter((u) => u === GONE_A).length, 1, "deduped");
  assert.ok(urls.includes("/x/v.mp4") && urls.includes("/x/f.mp4"));
});

test("data:/blob: URLs are not probeable — the demo seed can never look 'missing'", () => {
  assert.equal(isProbeable("data:image/svg+xml;base64,AAA"), false);
  assert.equal(isProbeable("blob:http://x/y"), false);
  assert.equal(isProbeable("/api/uploads/p/x.png"), true);
  // TIGHTENED after codex rounds 1–2: an ABSOLUTE http(s) URL is no longer
  // probeable either. Nothing in this app mints one (every registry url is
  // `/api/uploads/…`), and allowing it is the same「stored data aims the browser」
  // exposure as the protocol-relative spellings below, just spelled openly.
  assert.equal(isProbeable("https://x/y.png"), false);
  assert.equal(registryUrls({ images: { a: { current: 1, history: [{ assetId: "A", version: 1, url: "data:image/png;base64,A" }] } } }).length, 0);
});

test("real project paths stay probeable — including CJK and query strings", () => {
  for (const u of [
    "/api/uploads/照见未明rev2/assets-ref-c6e26bfb_v1.png",
    "/api/uploads/p/a b.png",
    "/x.png?v=1#frag",
    "/%5Cnot-a-host/x.png", // percent-encoded backslash is a PATH, not a host
  ]) {
    assert.equal(isProbeable(u), true, u);
  }
});

test("the probe records what the server answered, and re-scans nothing", async () => {
  const asked = [];
  const probe = createMediaProbe({
    // a REAL server answer, status included: the missing file is a 404, which is
    // the only kind of failure allowed to mean 「不在磁盘上」
    fetchImpl: async (url) => {
      asked.push(url);
      return url === GONE_A ? { ok: false, status: 404 } : { ok: true, status: 200 };
    },
  });
  assert.equal(await probe.scan([GONE_A, "/ok.png"]), true);
  assert.equal(probe.stateOf(GONE_A), MISSING);
  assert.equal(probe.stateOf("/ok.png"), PRESENT);
  assert.equal(probe.isMissing(GONE_A), true);
  assert.equal(probe.isMissing("/ok.png"), false);
  // calling it again from a render loop must not spin
  assert.equal(await probe.scan([GONE_A, "/ok.png"]), false);
  assert.deepEqual(asked, [GONE_A, "/ok.png"]);
});

test("ONLY a definitive answer says missing — a declined question does not (codex R1 P1)", async () => {
  // The first version recorded EVERY non-2xx and every thrown error as MISSING,
  // permanently. A server that serves GET but rejects HEAD (405/501), a 5xx blip,
  // or one dropped request would then have labelled a file that is right there
  // 「媒体文件已不在磁盘上」 until reload — the same untrue state this card removes,
  // produced by the check meant to remove it.
  const cases = [
    [404, MISSING, "the server answered ABOUT THE RESOURCE"],
    [410, MISSING, "gone is also an answer about the resource"],
    [405, INCONCLUSIVE, "method not allowed is about the REQUEST"],
    [501, INCONCLUSIVE, "HEAD unimplemented is about the REQUEST"],
    [500, INCONCLUSIVE, "a server fault says nothing about the file"],
    [403, INCONCLUSIVE, "forbidden is not absent"],
  ];
  for (const [status, want, why] of cases) {
    const probe = createMediaProbe({ fetchImpl: async () => ({ ok: false, status }) });
    await probe.scan(["/x.png"]);
    assert.equal(probe.stateOf("/x.png"), want, `${status}: ${why}`);
    assert.equal(probe.isMissing("/x.png"), want === MISSING, `${status} must not over-claim`);
  }
  // a thrown request (network down, CORS, abort) is not evidence about the file
  const boom = createMediaProbe({ fetchImpl: async () => { throw new Error("network"); } });
  await boom.scan(["/y.png"]);
  assert.equal(boom.stateOf("/y.png"), INCONCLUSIVE);
  assert.equal(boom.isMissing("/y.png"), false);
  assert.deepEqual(boom.missingUrls(), []);
});

test("an inconclusive answer is recorded, so a render loop does not re-ask forever", async () => {
  let asked = 0;
  const probe = createMediaProbe({
    fetchImpl: async () => { asked += 1; return { ok: false, status: 405 }; },
  });
  assert.equal(await probe.scan(["/x.png"]), true, "learning 「问不出来」 is still a change");
  assert.equal(await probe.scan(["/x.png"]), false, "…and it is not asked again");
  assert.equal(asked, 1);
  assert.equal(probe.isKnown("/x.png"), true);
});

test("a browser LOAD failure may still say missing — it really tried to fetch the bytes", async () => {
  // <img onerror> is evidence about the RESOURCE in a way a declined HEAD is not.
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: false, status: 405 }) });
  await probe.scan(["/x.png"]);
  assert.equal(probe.isMissing("/x.png"), false);
  assert.equal(probe.observe("/x.png", false), true, "the load failure overrides 「问不出来」");
  assert.equal(probe.isMissing("/x.png"), true);
});

test("a non-positive batch size cannot wedge the scan loop (codex R1 P2)", async () => {
  // `slice(i, i + 0)` is empty forever, so the loop never advances and the caller hangs.
  for (const limit of [0, -3, NaN, "six", null]) {
    const probe = createMediaProbe({ fetchImpl: async () => ({ ok: true }), limit });
    assert.equal(await probe.scan(["/a.png", "/b.png", "/c.png"]), true, `limit=${String(limit)}`);
    assert.equal(probe.stateOf("/c.png"), PRESENT);
  }
});

test("NO spelling of another origin is ever probed — stored data must not aim the browser", () => {
  // codex R1 flagged `//host`; `startsWith("//")` closed that ONE spelling and codex
  // R2 immediately found `/\host`. Measured against Node's WHATWG parser, all five
  // of these resolve to `http://evil.example` — which is why the check stopped
  // matching prefixes and started asking the parser for the resolved origin.
  const spellings = [
    "//evil.example/x.png",
    String.raw`/\evil.example/x.png`,
    String.raw`/\/evil.example/x.png`,
    String.raw`\\evil.example/x.png`,
    String.raw`\/evil.example/x.png`,
  ];
  for (const u of spellings) {
    assert.equal(
      new URL(u, "http://localhost:8791/").origin, "http://evil.example",
      `${JSON.stringify(u)} really does resolve off-origin — the test is testing the right thing`,
    );
    assert.equal(isProbeable(u), false, u);
  }
});

test("…and none of them reaches fetch, the state map, or the scan list", async () => {
  const evil = String.raw`/\evil.example/x.png`;
  const asked = [];
  const probe = createMediaProbe({ fetchImpl: async (u) => { asked.push(u); return { ok: true, status: 200 }; } });
  await probe.scan([evil, "//evil.example/y.png", "/ok.png"]);
  assert.deepEqual(asked, ["/ok.png"], "only the same-origin path was requested");
  assert.equal(probe.observe(evil, false), false, "an <img> error on one cannot record it either");
  assert.equal(probe.isMissing(evil), false);
  assert.equal(registryUrls({
    images: {
      a: { current: 1, history: [{ assetId: "A", version: 1, url: evil }] },
      b: { current: 1, history: [{ assetId: "B", version: 1, url: "//evil.example/y.png" }] },
    },
  }).length, 0, "a crafted registry contributes nothing to the scan list");
});

test("naming the validator's OWN sentinel host does not get you through (codex R3 P1)", () => {
  // The single-base version accepted `//media-probe.invalid/x` — it resolved ONTO
  // the sentinel, so the origin matched — while `fetch` would have resolved the raw
  // string against the PAGE origin and gone out to the network. Validating against
  // one base and fetching with another is the gap all three rounds lived in; the
  // check is base-INDEPENDENCE now, so no host can be named, sentinel or otherwise.
  for (const host of ["media-probe-a.invalid", "media-probe-b.invalid", "media-probe.invalid"]) {
    assert.equal(isProbeable(`//${host}/x.png`), false, host);
    assert.equal(isProbeable(`http://${host}/x.png`), false, host);
    // a trailing backslash cannot end a String.raw template, so this one is escaped
    assert.equal(isProbeable("/\\" + host + "/x.png"), false, host);
  }
  assert.equal(isProbeable("   "), false, "whitespace resolves to the base itself");
  assert.equal(isProbeable(""), false);
  assert.equal(isProbeable(null), false);
  assert.equal(isProbeable(undefined), false);
  assert.equal(isProbeable(42), false);
});

test("a value is probeable only if it names no host — the property, not a spelling list", () => {
  // Stated as the PROPERTY the implementation checks, so a future parser change
  // that invents a sixth spelling is caught by this test rather than by round 4.
  const bases = ["http://alpha.example/", "https://beta.example:8443/deep/page"];
  const baseIndependent = (u) => {
    const origins = bases.map((b) => new URL(u, b).origin);
    return origins.every((o, i) => o === new URL(bases[i]).origin);
  };
  for (const u of ["/api/uploads/p/x.png", "/x.png?v=1", "/%5Cnot-a-host/x.png"]) {
    assert.equal(baseIndependent(u), true, `${u} is a real project path`);
    assert.equal(isProbeable(u), true, u);
  }
  for (const u of [
    "//evil.example/x", String.raw`/\evil.example/x`, String.raw`\\evil.example/x`,
    String.raw`\/evil.example/x`, String.raw`/\/evil.example/x`, "//media-probe-a.invalid/x",
  ]) {
    assert.equal(baseIndependent(u), false, `${u} names a host`);
    assert.equal(isProbeable(u), false, u);
  }
});

test("a slow inconclusive HEAD cannot erase a proven load failure (codex R3 P1)", async () => {
  // The scan is in flight while the page paints, so these two race by construction.
  // The losing order was real: <img> fails → MISSING, then a 405 lands and wipes it,
  // taking the honest placeholder and the storage count with it.
  let release;
  const gate = new Promise((r) => { release = r; });
  const probe = createMediaProbe({
    fetchImpl: async () => { await gate; return { ok: false, status: 405 }; },
  });
  const scanning = probe.scan(["/x.png"]);
  assert.equal(probe.observe("/x.png", false), true, "the browser proved it cannot load");
  assert.equal(probe.isMissing("/x.png"), true);
  release();
  await scanning;
  assert.equal(probe.isMissing("/x.png"), true, "「问不出来」 must not overwrite 「试过，拿不到」");
  assert.equal(probe.stateOf("/x.png"), MISSING);
});

test("…and the same protection covers a proven PRESENT", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const probe = createMediaProbe({
    fetchImpl: async () => { await gate; return { ok: false, status: 500 }; },
  });
  const scanning = probe.scan(["/y.png"]);
  probe.observe("/y.png", true);
  release();
  await scanning;
  assert.equal(probe.stateOf("/y.png"), PRESENT, "a 5xx blip must not un-prove a loaded image");
});

test("a DEFINITIVE answer still wins over an earlier inconclusive", async () => {
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: false, status: 405 }) });
  await probe.scan(["/z.png"]);
  assert.equal(probe.stateOf("/z.png"), INCONCLUSIVE);
  assert.equal(probe.observe("/z.png", false), true, "evidence may always replace a non-answer");
  assert.equal(probe.stateOf("/z.png"), MISSING);
});

test("an unknown URL is NOT assumed present — three states, never two", () => {
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: true }) });
  assert.equal(probe.isKnown("/never-asked.png"), false);
  assert.equal(probe.isMissing("/never-asked.png"), false, "unknown is not 'missing' either");
});

test("an <img> load failure feeds the SAME table, and reports whether it changed", () => {
  const probe = createMediaProbe({ fetchImpl: async () => ({ ok: true }) });
  assert.equal(probe.observe(GONE_A, false), true, "first observation changes something");
  assert.equal(probe.observe(GONE_A, false), false, "a repeat must not re-render");
  assert.equal(probe.isMissing(GONE_A), true);
  assert.equal(probe.observe("data:image/png;base64,A", false), false, "not probeable, not recorded");
});

test("a missing media box says WHY and WHICH FILE — no <img> at a 404", () => {
  const gone = mediaBox(GONE_A, { alt: "林晚 Ref", gone: true });
  assert.ok(!gone.includes("<img"), "a broken-image glyph is not an honest state");
  assert.ok(gone.includes("媒体文件已不在磁盘上"));
  assert.ok(gone.includes("assets-ref-c6e26bfb_v1.png"), "the filename is what the creator can act on");
  assert.ok(gone.includes("media-gone"));
  // …and it is NOT the same box as 「还没有画面」
  const notYet = mediaBox("", { missing: "还没有画面" });
  assert.ok(!notYet.includes("media-gone"));
  assert.ok(notYet.includes("还没有画面"));
});

test("a present media box carries data-media-url so ONE handler can catch its failure", () => {
  const ok = mediaBox("/api/uploads/p/ok_v1.png", { alt: "x" });
  assert.ok(ok.includes("<img"));
  assert.ok(ok.includes(`data-media-url="/api/uploads/p/ok_v1.png"`));
});

test("fileNameOf survives query strings and percent-encoding", () => {
  assert.equal(fileNameOf("/api/uploads/%E7%85%A7/a_v1.png?x=1"), "a_v1.png");
  assert.equal(fileNameOf(""), "");
  assert.equal(fileNameOf(null), "");
  assert.ok(mediaGoneBox("/a/b.png").includes("b.png"));
});

/* ========================================================================= */
/* 3 · 参考图用途：按路线真实能力标注                                          */
/* ========================================================================= */

const GATEWAY = ROUTE_CAPABILITY.gateway;
const MANUAL = ROUTE_CAPABILITY.manual;

test("the DECLARED role table is untouched — it drives the compiler and the graph", () => {
  // Flipping ROLE_USE would move these four onto the video side of the prompt
  // compiler (workflow/refuse.js) and redraw the shot graph. This card does not.
  for (const role of ["character-reference", "location-reference", "prop-reference", "style-reference"]) {
    assert.equal(ROLE_USE[role], "model-input", `${role} is declared model-input`);
    assert.ok(MODEL_INPUT_ROLES.includes(role));
  }
  for (const role of INTERPRETATION_ROLES) assert.equal(ROLE_USE[role], "ai-interpretation");
});

test("on the Gateway route the four attachment roles are NOT model input", () => {
  // ONE image reaches the model: cloud_minimax._payload sends first_frame_image
  // and ProviderRequest has no other image field.
  assert.equal(GATEWAY.referenceImages, false);
  assert.deepEqual([...GATEWAY.imageInputs], ["first-frame"]);
  for (const role of ["character-reference", "location-reference", "prop-reference", "style-reference"]) {
    assert.equal(effectiveRoleUse(role, GATEWAY), "ai-interpretation", role);
  }
  assert.deepEqual(downgradedRoles(GATEWAY), MODEL_INPUT_ROLES);
});

test("on the manual route they ARE model input — the creator attaches the files", () => {
  assert.equal(MANUAL.referenceImages, true);
  for (const role of MODEL_INPUT_ROLES) {
    assert.equal(effectiveRoleUse(role, MANUAL), "model-input", role);
  }
  assert.deepEqual(downgradedRoles(MANUAL), []);
});

test("an interpretation role is interpreted on EVERY route — a capability never upgrades it", () => {
  for (const role of INTERPRETATION_ROLES) {
    assert.equal(effectiveRoleUse(role, MANUAL), "ai-interpretation");
    assert.equal(effectiveRoleUse(role, GATEWAY), "ai-interpretation");
  }
});

test("an unknown route falls back to MANUAL — the wording that instructs a human", () => {
  assert.equal(routeCapability("nope"), MANUAL);
  assert.equal(routeCapability(undefined), MANUAL);
  assert.equal(effectiveRoleUse("character-reference", undefined), "model-input");
  assert.equal(effectiveRoleUse("not-a-role", GATEWAY), null);
});

test("the route note says plainly that those images do not reach the model", () => {
  const note = referenceRouteNote(GATEWAY);
  assert.ok(note.includes("不会进模型"));
  assert.ok(note.includes("首帧"));
  assert.ok(note.includes(GATEWAY.label), "a note that does not name its route is the old unqualified claim");
  assert.ok(!referenceRouteNote(MANUAL).includes("不会进模型"));
  assert.ok(referenceRouteNote(MANUAL).includes(MANUAL.label));
});

test("BOTH routes are always stated — the unqualified claim is what had to go", () => {
  // The product offers both routes at once: a creator can copy the Prompt into an
  // external tool today whether or not the Gateway write path is enabled. Printing
  // only the active one would still let someone planning a paid run believe four
  // images get sent.
  for (const inForce of [MANUAL, GATEWAY]) {
    const rows = referenceRouteMatrix(inForce);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id), ["manual", "gateway"]);
    assert.deepEqual(rows.map((r) => r.sendsReferenceImages), [true, false]);
    assert.equal(rows.filter((r) => r.active).length, 1, "exactly one route is in force");
    assert.equal(rows.find((r) => r.active).id, inForce.id);
    assert.ok(rows.find((r) => r.id === "gateway").note.includes("不会进模型"),
      "the Gateway limit is stated even while the manual route is in force");
  }
});

test("the VIDEO prompt stops promising an attachment the Gateway never sends", () => {
  const args = {
    shot: { description: "雨夜", action: "转身", cameraMotion: "推" },
    hasImage: true,
    references: [{ kind: "style-reference", name: "冷调 Ref", version: 2 }],
  };
  const manual = compileVideoPrompt({ ...args, route: "manual" });
  assert.ok(manual.text.includes("【风格参考】冷调 Ref v2（作为参考图一并提供，保持一致）"),
    "免费 / 手工路线 keeps the instruction — the creator really does attach it");

  const gateway = compileVideoPrompt({ ...args, route: "gateway" });
  assert.ok(!gateway.text.includes("作为参考图一并提供"));
  assert.ok(gateway.text.includes("【风格参考】冷调 Ref v2"), "the reference is still NAMED");
  assert.ok(gateway.text.includes("图片不随本次提交发送"));
});

test("no route given compiles byte-identical text to before this change", () => {
  const args = {
    shot: { description: "雨夜", action: "转身", cameraMotion: "推" },
    hasImage: true,
    references: [{ kind: "style-reference", name: "冷调 Ref", version: 2 }],
  };
  assert.equal(compileVideoPrompt(args).text, compileVideoPrompt({ ...args, route: "manual" }).text);
});

test("the IMAGE prompt is unchanged — there is no paid image route to lie about", () => {
  const { text } = compileImagePrompt({
    shot: { description: "雨夜" },
    references: [{ kind: "character-reference", name: "林晚 Ref", version: 3 }],
  });
  assert.ok(text.includes("【人物参考】林晚 Ref v3（作为参考图一并提供，保持一致）"));
});

/* ========================================================================= */
/* 4 · 五页 rail：EPISODE_NAV 终于有渲染器                                     */
/* ========================================================================= */

test("every EPISODE_NAV key resolves to a real page AND a real section", () => {
  for (const [key, icon, label] of EPISODE_NAV) {
    const hit = resolveModule(key);
    assert.equal(hit.resolved, true, `${key} must resolve`);
    assert.equal(hit.module, key, `${key} is a page, not an alias`);
    assert.ok(PAGES.includes(key), `${key} must be one of the eleven pages`);
    assert.equal(spaceOf(key), "episode", `${key} belongs to 剧集制作`);
    assert.equal(typeof MODULE_LABEL[key], "string");
    assert.ok(label && icon, `${key} needs a label and an icon to draw`);
    // a page with declared sections must declare at least one REAL one
    const secs = PAGE_SECTIONS[key];
    if (secs) assert.ok(secs.length > 0, `${key} declares an empty section list`);
    assert.ok(EPISODE_MODULES.includes(key));
  }
});

test("renderEpisodeRail draws all five, with data-mod the shell already binds", () => {
  const html = renderEpisodeRail({ activeModule: "shotwork", episodeCode: "EP01", episodeTitle: "沉默酒吧" });
  for (const [key, , label] of EPISODE_NAV) {
    assert.ok(html.includes(`data-mod="${key}"`), `${key} needs an entrance`);
    assert.ok(html.includes(label), `${label} must be named`);
  }
  assert.ok(html.includes("EP01 沉默酒吧"), "the rail says which episode it is for");
});

test("⑨ 粗剪审片 is REACHABLE — it had a renderer, a binding and no entrance at all", () => {
  const html = renderEpisodeRail({ activeModule: "board" });
  assert.ok(html.includes(`data-mod="cutreview"`), "this attribute existed nowhere in the repo");
  assert.equal(resolveModule("cutreview").module, "cutreview");
  assert.deepEqual(PAGE_SECTIONS.cutreview, ["review"]);
  assert.equal(spaceOf("cutreview"), "episode");
});

test("exactly ONE row is marked active, and a legacy key highlights its new page", () => {
  const on = (html) => (html.match(/class="st-navitem[^"]* on"/g) || []).length;
  assert.equal(on(renderEpisodeRail({ activeModule: "shotwork" })), 1);
  // the caller resolves first — `frames` lands on ⑧ 镜头制作
  const resolved = resolveModule("frames");
  assert.equal(resolved.module, "shotwork");
  assert.equal(on(renderEpisodeRail({ activeModule: resolved.module })), 1);
  // …and a surface the IA does not name highlights nothing rather than lying
  assert.equal(resolveModule("workbench").resolved, false);
  assert.equal(on(renderEpisodeRail({ activeModule: null })), 0);
});

test("the rail carries no invented badge — a second count could only disagree", () => {
  const html = renderEpisodeRail({ activeModule: "board" });
  assert.ok(!html.includes("bdg"), "no badge model exists for these five pages yet");
});

/* ========================================================================= */
/* 5 · 中栏标题 / 面包屑跟随当前页                                             */
/* ========================================================================= */

test("crumbScope: episode-level pages do not claim a shot", () => {
  for (const m of ["board", "cutreview", "delivery", "episode", "scenes", "edit"]) {
    assert.equal(crumbScope(m, null), "episode", `${m} is about the whole episode`);
  }
});

test("crumbScope: shot-level pages do", () => {
  for (const m of ["shotwork", "workbench", "provenance", "shots", "frames", "video", "audio", "dailies", "refplan"]) {
    assert.equal(crumbScope(m, null), "shot", `${m} is about one shot`);
  }
});

test("crumbScope: ⑦ 分镜设计 follows its SECTION — 场景 is episode-level, 分镜 is not", () => {
  assert.equal(crumbScope("storyboard", "scenes"), "episode");
  assert.equal(crumbScope("storyboard", "shots"), "shot");
  assert.equal(crumbScope("storyboard", null), "episode", "the page's own default section");
});

test("crumbScope: 故事开发 and 资产库 pages are project-level", () => {
  for (const m of ["brief", "story", "settings", "episodes", "script", "assets", "projectsettings"]) {
    assert.equal(crumbScope(m, null), "project", `${m} is not inside one episode`);
  }
});

test("crumbScope classifies EVERY page — no module falls through unclassified", () => {
  for (const k of PAGES) {
    assert.ok(["project", "episode", "shot"].includes(crumbScope(k, null)), k);
  }
});

/* ========================================================================= */
/* 6 · 资产库卡片：缺失的媒体不再是浏览器碎图                                   */
/* ========================================================================= */

const LIB_ROW = (over = {}) => ({
  assetId: "a1", key: "ref-lin", isReference: true,
  name: "林晚 Ref", displayName: "林晚 Ref", kindLabel: "人物参考",
  reusable: false, current: true, version: 1, tags: [],
  usage: { count: 0, places: [] }, needsReview: false,
  url: GONE_A, domain: "images", media: "image", storageState: "local",
  originalFilename: null, ...over,
});

function libCtx(rows, probe) {
  return {
    mediaProbe: probe,
    assets: {
      library: () => ({
        total: rows.length, shown: rows.length, unusedCount: 0, needsReview: 0,
        counts: [{ id: "all", label: "全部", n: rows.length }], tags: [], rows,
      }),
      filterOptions: () => ({ characters: [], locations: [], episodes: [], sources: [] }),
      provenanceOf: () => null,
      libraryOne: () => null,
    },
  };
}

test("the 「不在磁盘上」 count survives a filter — it is a fact about the project", () => {
  // `m.rows` is the FILTERED set; counting it would report 0 the moment the creator
  // picked 音频, and the whole point of the line is that this fact stops hiding.
  const gone = LIB_ROW();
  const other = LIB_ROW({ assetId: "a2", url: "/api/uploads/p/ok_v1.png", name: "别的" });
  const ctx = libCtx([gone, other], { isMissing: (u) => u === GONE_A });
  // simulate a filter that excludes the missing asset from the visible rows
  ctx.assets.library = (f = {}) => ({
    total: 2, shown: 1, unusedCount: 0, needsReview: 0,
    counts: [{ id: "all", label: "全部", n: 2 }], tags: [],
    rows: f.type === "all" && f.variant === "all" ? [gone, other] : [other],
  });
  const html = renderAssetLibrary(ctx, { alFilters: { type: "audio" } }, { mode: "page" });
  assert.ok(html.includes("⚠ 1 个媒体文件已不在磁盘上"), "a filter must not hide it");
});

test("a card whose file is gone renders the honest placeholder, not <img src> at a 404", () => {
  const rows = [LIB_ROW()];
  const before = renderAssetLibrary(libCtx(rows, null), {}, { mode: "page" });
  assert.ok(before.includes("<img"), "with nothing probed it is still just a picture");

  const after = renderAssetLibrary(
    libCtx(rows, { isMissing: (u) => u === GONE_A }),
    {}, { mode: "page" },
  );
  assert.ok(!after.includes("<img"), "the broken-image glyph is what the audit found");
  assert.ok(after.includes("媒体文件已不在磁盘上"));
  assert.ok(after.includes("assets-ref-c6e26bfb_v1.png"), "…and WHICH file");
  assert.ok(after.includes("⚠ 1 个媒体文件已不在磁盘上"), "the header states the count");
});

test("a DECLARED absence still reads as itself — archived is not 「文件不见了」", () => {
  const html = renderAssetLibrary(
    libCtx([LIB_ROW({ storageState: "archived" })], { isMissing: () => true }),
    {}, { mode: "page" },
  );
  assert.ok(html.includes("已归档"));
  assert.ok(!html.includes("媒体文件已不在磁盘上"), "the project DECIDED this one; it is not a surprise");
});

test("a present card carries data-media-url, so a 404 nobody predicted is still caught", () => {
  const html = renderAssetLibrary(libCtx([LIB_ROW()], null), {}, { mode: "page" });
  assert.ok(html.includes(`data-media-url="${GONE_A}"`));
});

/* ========================================================================= */
/* 7 · 三步向导接回主路径                                                     */
/* ========================================================================= */

function storyboardCtx({ locked = null } = {}) {
  const prod = proddoc.createProduction(null);
  const scene = proddoc.addScene(prod, prod.episodes[0].episodeId, "大殿");
  proddoc.assignShot(prod, scene.sceneId, "shot-a");
  const pd = {
    draftShots: [
      { shotId: "shot-a", sequence: 1, title: "跪殿", description: "大殿中央", duration_seconds: 6, slot: "v1-1" },
    ],
    lockedPlan: locked,
    shotVersions: { count: 1, cur: 1, state: "done", rows: null },
    realShots: null,
    assetUploads: {}, media: { video: {}, audio: {} }, firstFrames: {}, finals: [],
    paidOps: {}, production: prod, generations: [], story: null, scripts: {},
    skillRuns: [], assets: {}, timelines: {}, prompts: {}, refInterp: {},
    refUse: {}, frameBindings: {}, locks: {}, shotAudio: {}, subtitles: {},
  };
  return { prodData: () => pd, script: { hasContent: () => true } };
}

test("⑦ 分镜设计 offers 「→ 准备资产」 — the batch pipeline's only creative entrance", () => {
  // ui/wizard.js implements 确认镜头 → 准备资产 → 合成提示词 → 批量生视频 in full and
  // its ONLY caller was workflow/nodes/assets.js — a node on the `?canvas=1`
  // diagnostic canvas, which ADR-0061 took off every creative path.
  const html = renderStoryboard(storyboardCtx(), { selectedShotId: null, buffer: {} });
  assert.ok(html.includes("data-wz-open"), "the wizard needs an entrance a creator can reach");
  assert.ok(html.includes("准备资产"));
});

test("a locked shot list makes 准备资产 the PRIMARY action, not a different one", () => {
  const locked = renderStoryboard(
    storyboardCtx({ locked: { planVersion: 1, shots: [] } }),
    { selectedShotId: null, buffer: {} },
  );
  assert.ok(/class="btn sm primary"[^>]*data-wz-open/.test(locked), "锁定后它是主行动");
  const unlocked = renderStoryboard(storyboardCtx(), { selectedShotId: null, buffer: {} });
  assert.ok(unlocked.includes("data-wz-open"), "…and it is still reachable before locking");
  assert.ok(!/class="btn sm primary"[^>]*data-wz-open/.test(unlocked));
});

test("no shot list, no entrance — the wizard's step ① would have nothing to confirm", () => {
  const ctx = storyboardCtx();
  const pd = ctx.prodData();
  const empty = { ...ctx, prodData: () => ({ ...pd, draftShots: null }) };
  assert.ok(!renderStoryboard(empty, { selectedShotId: null, buffer: {} }).includes("data-wz-open"));
});
