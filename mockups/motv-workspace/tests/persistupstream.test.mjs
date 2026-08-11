// Production upstream PERSISTENCE (TASK-057 blocker fix) — run via
// `node --test`, wrapped by tests/test_motv_upstream_persistence.py.
//
// THE BLOCKER these tests exist for: the upstream fields wrote to the canonical
// document only on `change` (blur). A creator who typed into Creative Brief and
// hit browser-refresh with the caret still in the field lost the text — the
// value had never left the DOM. Every field below must reach the document on
// INPUT, so the debounced canvas save carries it to studio/canvas.json.
//
// These are NOT asset tests: the brief / outline / character / relationship /
// world / episode-beat content stays canonical canvas domain data.
import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";
import * as pd from "../src/workflow/proddoc.js";
import * as cd from "../src/workflow/canondoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import * as sd from "../src/workflow/scriptdoc.js";
import * as assetlib from "../src/workflow/assetlib.js";
import * as genlib from "../src/workflow/genlib.js";
import * as tl from "../src/workflow/timeline.js";
import { migrateToCurrent, validateCanvasDoc } from "../src/services/canvasschema.js";
import { renderBriefWs, bindBriefWs } from "../src/ui/briefws.js";
import { renderWorldWs, bindWorldWs } from "../src/ui/worldws.js";
import { renderRelWs, bindRelWs } from "../src/ui/relws.js";
import { renderEpPlanWs, bindEpPlanWs } from "../src/ui/epplanws.js";
import { renderBibleWs, bindBibleWs } from "../src/ui/biblews.js";
import { flushFields, flushAllFields, restoreFieldFocus } from "../src/ui/fieldsync.js";
import { saveCanvas, flushCanvas, notifyUnloading, setUnloading, loadCanvas } from "../src/services/persist.js";

/* ------------------------------------------------------------------ DOM stub */
// Just enough DOM for the bind functions: attribute lookup by selector, the
// handler slots they assign, and a value to type into. Deliberately tiny — the
// point is to prove which EVENT reaches the domain, not to emulate a browser.

class El {
  constructor(tag, attrs = {}, value = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.value = value;
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!k.startsWith("data-")) continue;
      const name = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[name] = v;
    }
    this.oninput = null;
    this.onchange = null;
    this.onclick = null;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._parent = null;
  }

  /** type `text` into the field, exactly as a browser would: value then input */
  type(text) {
    this.value = text;
    this.selectionStart = this.selectionEnd = text.length;
    if (this.oninput) this.oninput();
  }

  blur() {
    if (this.onchange) this.onchange();
  }

  /** Type Chinese through an IME: composition start, intermediate `input`
   *  events for each keystroke, then commit. */
  compose(steps, final) {
    if (this.oncompositionstart) this.oncompositionstart();
    for (const step of steps) {
      this.value = step;
      this.selectionStart = this.selectionEnd = step.length;
      if (this.oninput) this.oninput();
    }
    this.value = final;
    this.selectionStart = this.selectionEnd = final.length;
    if (this.oncompositionend) this.oncompositionend();
  }

  /** Supports what the bind functions actually use: a class, a tag, and one or
   *  more chained attribute clauses (`[data-beat-rel][data-field="start"]`). */
  matches(sel) {
    if (sel.startsWith(".")) return (this.attrs.class || "").split(/\s+/).includes(sel.slice(1));
    if (!sel.startsWith("[")) return sel.toLowerCase() === this.tagName.toLowerCase();
    const clauses = sel.match(/\[[^\]]+\]/g) || [];
    if (clauses.join("") !== sel) return false; // an unsupported selector shape
    return clauses.every((c) => {
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(c);
      if (!m) return false;
      const [, name, want] = m;
      return name in this.attrs && (want === undefined || this.attrs[name] === want);
    });
  }

  closest(sel) {
    let n = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n._parent;
    }
    return null;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
    return (this._children || []).filter((c) => parts.some((p) => c.matches(p)));
  }

  setSelectionRange(a, b) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }

  focus() {}
}

class Root extends El {
  constructor(children) {
    super("div");
    this._children = children;
    for (const c of children) c._parent = this;
    this.ownerDocument = { activeElement: null, body: null };
  }
}

/** A schema-VALID document at the current version (built by the real migration
 *  chain, so these tests never hand-maintain the full shape). */
function validDoc(extra = {}) {
  const res = migrateToCurrent({
    v: 1, project: "p", scriptDoc: null,
    nodes: [{ id: "n1", type: "script", x: 0, y: 0 }], edges: [], pan: { x: 0, y: 0 },
  });
  assert.equal(res.status, "ok", res.detail);
  return { ...res.doc, ...extra };
}

/* ------------------------------------------------------------------- harness */

/** A live project + the ctx the workspaces write through. `saves` records every
 *  ctx.persist() with the serialized document, i.e. exactly what would be PUT
 *  to studio/canvas.json. */
function harness() {
  const story = st.createStory(null);
  const production = pd.createProduction(null);
  const assets = assetlib.createRegistry(null);
  const generations = genlib.createGenerationRegistry(null);
  const timelines = tl.createTimelines(null);
  const scripts = Object.create(null);
  const saves = [];
  let renders = 0;

  // The document is layered OVER a base produced by the real migration chain,
  // so it always carries whatever the current schema version requires — these
  // tests are about persistence, and must not need editing every time a new
  // migration adds a field.
  const serialize = () => ({
    ...validDoc(),
    project: "夜班沉默",
    story: st.serialize(story),
    scripts: Object.fromEntries(Object.keys(scripts).map((k) => [k, sd.serialize(scripts[k])])),
    assets,
    generations,
    production: pd.serialize(production),
    timelines: tl.serialize(timelines),
  });
  const persist = () => saves.push(serialize());
  // prodOp's real behaviour: persist AND re-render
  const prodOp = (ok) => {
    if (ok) { persist(); renders += 1; }
    return ok;
  };

  const prodData = () => ({
    production, story, generations, assets, timelines,
    assetUploads: assets.images, media: { video: assets.videos, audio: assets.audio },
    firstFrames: assets.firstFrames, finals: [], paidOps: {}, draftShots: null,
    lockedPlan: null, shotVersions: null, realShots: null,
  });
  const ctx = {
    project: { name: "夜班沉默" },
    prodData,
    toast: () => {},
    isConnected: () => true,
    breakdown: { state: () => null },
    script: { doc: () => sd.createDoc(), currentText: () => "", isDirty: () => false, hasContent: () => false },
    production: { doc: () => production },
    story: {
      doc: () => story,
      setIdea: (t) => { st.setIdea(story, t); persist(); },
      editBrief: (f) => { st.editBriefDraft(story, f); persist(); },
      briefIsDirty: () => st.briefIsDirty(story),
      activeBrief: () => st.activeBrief(story),
      commitBrief: () => { const r = st.commitBrief(story); if (r) persist(); return r; },
    },
    bible: {
      updateCharacterProfile: (id, f) => prodOp(bd.updateCharacterProfile(production, id, f)),
      updateLocationProfile: (id, f) => prodOp(bd.updateLocationProfile(production, id, f)),
      setCharacterVoice: (id, v) => prodOp(bd.setCharacterVoice(production, id, v)),
      setCharacterStateOverrides: (id, s, o) => prodOp(bd.setCharacterStateOverrides(production, id, s, o)),
      setLocationStateOverrides: (id, s, o) => prodOp(bd.setLocationStateOverrides(production, id, s, o)),
    },
    canon: {
      updateWorld: (f) => prodOp(cd.updateWorld(production, f)),
      updateRelationship: (id, f) => prodOp(cd.updateRelationship(production, id, f)),
      setTextBeats: (e, k, l) => prodOp(cd.setEpisodeTextBeats(production, e, k, l)),
      setCharacterBeat: (e, c, b) => prodOp(cd.setEpisodeCharacterBeat(production, e, c, b)),
      setRelationshipBeat: (e, r, rec) => prodOp(cd.setEpisodeRelationshipBeat(production, e, r, rec)),
      impact: (id) => cd.episodeImpact(production, id, story),
      confirm: (s) => prodOp(!!cd.confirmCanon(production, s)),
      stamp: (id) => prodOp(cd.stampEpisodeUpstream(production, id, story)),
    },
  };
  return { story, production, ctx, saves, serialize, renders: () => renders };
}

/** Reload: serialize → dispatch → hydrate, exactly like restoreGraph. */
function reload(doc) {
  const res = migrateToCurrent(JSON.parse(JSON.stringify(doc)));
  assert.equal(res.status, "ok", res.detail || res.status);
  assert.equal(validateCanvasDoc(res.doc), null);
  return { story: st.createStory(res.doc.story), production: pd.createProduction(res.doc.production) };
}

/** Advance past the field-sync debounce. */
const settle = (ui) => flushFields(ui);

/* ============================ Creative Brief ============================== */

test("brief: typing reaches the document on INPUT and survives reload", () => {
  const h = harness();
  const ui = { briefBuffer: {}, dirOpen: {} };
  const el = new El("textarea", { "data-cb-field": "genre" });
  const root = new Root([el]);
  bindBriefWs(root, h.ctx, ui, () => {});

  el.type("都市悬疑");
  // the blocker was that NOTHING happened until blur — the value must be
  // committed by the debounce alone, with no blur at all
  settle(ui);
  assert.equal(h.story.brief.draft.genre, "都市悬疑");
  assert.ok(h.saves.length > 0, "an edit must trigger a canvas save");

  // …and the saved document restores it
  const back = reload(h.saves[h.saves.length - 1]);
  assert.equal(back.story.brief.draft.genre, "都市悬疑");
  assert.equal(st.briefIsDirty(back.story), true); // still an unversioned draft
});

test("brief: the core idea reaches the document on every keystroke", () => {
  const h = harness();
  const ui = { briefBuffer: {} };
  const idea = new El("textarea", { class: "field brieftext pm-brieftext" });
  bindBriefWs(new Root([idea]), h.ctx, ui, () => {});
  idea.type("一间深夜不打烊的酒吧");
  assert.equal(h.story.idea, "一间深夜不打烊的酒吧"); // no debounce for the idea
  const back = reload(h.saves[h.saves.length - 1]);
  assert.equal(back.story.idea, "一间深夜不打烊的酒吧");
});

test("brief: a committed revision and the draft BOTH survive reload", () => {
  const h = harness();
  const ui = { briefBuffer: {} };
  const el = new El("textarea", { "data-cb-field": "tone" });
  bindBriefWs(new Root([el]), h.ctx, ui, () => {});
  st.setIdea(h.story, "创意");
  el.type("冷峻克制");
  settle(ui);
  st.commitBrief(h.story); // explicit version
  const el2 = new El("textarea", { "data-cb-field": "form" });
  bindBriefWs(new Root([el2]), h.ctx, ui, () => {});
  el2.type("竖屏短剧"); // and then keep editing the draft
  settle(ui);

  const back = reload(h.serialize());
  assert.equal(back.story.brief.versions.length, 1);
  assert.equal(back.story.brief.versions[0].fields.tone, "冷峻克制");
  assert.equal(back.story.brief.active, 1);
  assert.equal(back.story.brief.draft.form, "竖屏短剧"); // the newer draft too
  assert.equal(st.briefIsDirty(back.story), true);
});

/* ============================ World Setting =============================== */

test("world: typing reaches the document on INPUT and survives reload", () => {
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "rules" });
  bindWorldWs(new Root([el]), h.ctx, ui);
  el.type("录音是唯一不会改口的证物");
  settle(ui);
  assert.equal(h.production.world.rules, "录音是唯一不会改口的证物");
  const back = reload(h.serialize());
  assert.equal(back.production.world.rules, "录音是唯一不会改口的证物");
});

/* ============================ Relationship ================================ */

test("relationship: facet typing reaches the document on INPUT and reloads", () => {
  const h = harness();
  const a = bd.addCharacter(h.production, "林照");
  const b = bd.addCharacter(h.production, "沈既白");
  const rel = cd.addRelationship(h.production, a.characterId, b.characterId);
  const ui = { relOpen: rel.relationshipId };
  const el = new El("textarea", { "data-rel-field": rel.relationshipId, "data-field": "coreConflict" });
  bindRelWs(new Root([el]), h.ctx, ui, () => {});
  el.type("都想要真相，代价方向相反");
  settle(ui);
  assert.equal(rel.profile.coreConflict, "都想要真相，代价方向相反");
  const back = reload(h.serialize());
  assert.equal(back.production.relationships[0].profile.coreConflict, "都想要真相，代价方向相反");
  assert.deepEqual(back.production.relationships[0].characterIds, [a.characterId, b.characterId]);
});

/* ============================ Character =================================== */

test("character: profile typing reaches the document on INPUT and reloads", () => {
  const h = harness();
  const c = bd.addCharacter(h.production, "林照");
  const ui = { bibleTab: "characters", bibleState: {}, bibleOpen: `c:${c.characterId}` };
  const el = new El("textarea", { "data-b-chprof": c.characterId, "data-field": "identity" });
  bindBibleWs(new Root([el]), h.ctx, ui, () => {});
  el.type("酒吧「沉默」的女招待");
  settle(ui);
  assert.equal(c.profile.identity, "酒吧「沉默」的女招待");
  const back = reload(h.serialize());
  assert.equal(back.production.characters[0].profile.identity, "酒吧「沉默」的女招待");
  assert.equal(back.production.characters[0].tier, "formal");
});

/* ============================ Episode beats =============================== */

test("beats: plot typing reaches the document on INPUT and reloads", () => {
  const h = harness();
  const ep = h.production.episodes[0];
  const ui = { beatsOpen: ep.episodeId };
  const el = new El("textarea", { "data-beat-text": ep.episodeId, "data-kind": "plot" });
  bindEpPlanWs(new Root([el]), h.ctx, ui, () => {});
  el.type("第一位客人讲述雨夜\n发现陌生录音");
  settle(ui);
  assert.deepEqual(ep.beats.plot, ["第一位客人讲述雨夜", "发现陌生录音"]);
  const back = reload(h.serialize());
  assert.deepEqual(back.production.episodes[0].beats.plot, ["第一位客人讲述雨夜", "发现陌生录音"]);
});

test("beats: editing ONE relationship field keeps the other two", () => {
  const h = harness();
  const a = bd.addCharacter(h.production, "林照");
  const b = bd.addCharacter(h.production, "沈既白");
  const rel = cd.addRelationship(h.production, a.characterId, b.characterId);
  const ep = h.production.episodes[0];
  const ui = { beatsOpen: ep.episodeId };
  const mk = (f, v) => new El("input", { "data-beat-rel": ep.episodeId, "data-rid": rel.relationshipId, "data-field": f }, v);
  const start = mk("start", "");
  const event = mk("event", "");
  const end = mk("end", "");
  const row = new El("div", { class: "beatrow" });
  row._children = [start, event, end];
  for (const el of row._children) el._parent = row;
  const root = new Root([start, event, end]);
  // the row is the closest ancestor the bind reads siblings from
  for (const el of [start, event, end]) el._parent = row;
  row._parent = root;
  bindEpPlanWs(root, h.ctx, ui, () => {});

  start.type("利益合作");
  settle(ui);
  event.type("陈默替林照承担风险");
  settle(ui);
  end.type("有限信任");
  settle(ui);
  assert.deepEqual(ep.beats.relationship, [{
    relationshipId: rel.relationshipId,
    start: "利益合作", event: "陈默替林照承担风险", end: "有限信任",
  }]);
  const back = reload(h.serialize());
  assert.equal(back.production.episodes[0].beats.relationship[0].end, "有限信任");
});

/* ============================ cross-surface =============================== */

test("every upstream surface edited in one session survives ONE reload", () => {
  const h = harness();
  const c = bd.addCharacter(h.production, "林照");
  const c2 = bd.addCharacter(h.production, "沈既白");
  const rel = cd.addRelationship(h.production, c.characterId, c2.characterId);
  const ep = h.production.episodes[0];
  const ui = { briefBuffer: {}, worldBuffer: {}, bibleState: {}, bibleTab: "characters" };

  const brief = new El("textarea", { "data-cb-field": "genre" });
  bindBriefWs(new Root([brief]), h.ctx, ui, () => {});
  brief.type("都市悬疑");
  settle(ui);

  st.setIdea(h.story, "深夜酒吧");
  st.applyManualOutline(h.story, { premise: "失忆的女招待", climax: "天台对峙" });
  st.approveOutline(h.story, 1);

  const world = new El("textarea", { "data-w-field": "era" });
  bindWorldWs(new Root([world]), h.ctx, ui);
  world.type("当代雨季");
  settle(ui);

  const prof = new El("textarea", { "data-b-chprof": c.characterId, "data-field": "arc" });
  bindBibleWs(new Root([prof]), h.ctx, ui, () => {});
  prof.type("被动 → 追查 → 交出录音");
  settle(ui);

  const facet = new El("textarea", { "data-rel-field": rel.relationshipId, "data-field": "arc" });
  bindRelWs(new Root([facet]), h.ctx, { relOpen: rel.relationshipId, ...ui }, () => {});
  facet.type("戒备 → 合作 → 决裂");
  settle(ui);

  const beat = new El("textarea", { "data-beat-text": ep.episodeId, "data-kind": "world" });
  bindEpPlanWs(new Root([beat]), h.ctx, { beatsOpen: ep.episodeId, ...ui }, () => {});
  beat.type("录音可以作为证据");
  settle(ui);

  cd.confirmCanon(h.production, "world");
  cd.stampEpisodeUpstream(h.production, ep.episodeId, h.story);

  const back = reload(h.serialize());
  assert.equal(back.story.brief.draft.genre, "都市悬疑");
  assert.equal(back.story.idea, "深夜酒吧");
  assert.equal(back.story.versions[0].outline.premise, "失忆的女招待");
  assert.equal(back.story.versions[0].outline.climax, "天台对峙");
  assert.equal(back.story.approved, 1);
  assert.equal(back.production.world.era, "当代雨季");
  assert.equal(back.production.characters[0].profile.arc, "被动 → 追查 → 交出录音");
  assert.equal(back.production.relationships[0].profile.arc, "戒备 → 合作 → 决裂");
  assert.deepEqual(back.production.episodes[0].beats.world, ["录音可以作为证据"]);
  assert.equal(back.production.canon.world, 1);
  assert.equal(cd.episodeImpact(back.production, back.production.episodes[0].episodeId, back.story).state, "current");
});

/* ============================ field-sync rules ============================= */

test("fieldsync: a pending write is never lost when focus moves to another field", () => {
  const h = harness();
  const ui = { briefBuffer: {} };
  const a = new El("textarea", { "data-cb-field": "genre" });
  const b = new El("textarea", { "data-cb-field": "tone" });
  bindBriefWs(new Root([a, b]), h.ctx, ui, () => {});
  a.type("悬疑");     // queued
  b.type("冷峻");     // a different field takes the slot…
  settle(ui);
  // …and BOTH values are in the document
  assert.equal(h.story.brief.draft.genre, "悬疑");
  assert.equal(h.story.brief.draft.tone, "冷峻");
});

test("fieldsync: blur commits immediately, without waiting for the debounce", () => {
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "atmosphere" });
  bindWorldWs(new Root([el]), h.ctx, ui);
  el.type("潮湿不安");
  el.blur(); // no settle() — the blur must be enough
  assert.equal(h.production.world.atmosphere, "潮湿不安");
});

test("fieldsync: nothing pending means nothing written (no phantom saves)", () => {
  const h = harness();
  const ui = {};
  assert.equal(flushFields(ui), false);
  assert.equal(h.saves.length, 0);
});

test("IME: nothing is written or re-rendered mid-composition", () => {
  // Chinese input fires `input` for every intermediate state. Committing one of
  // those would re-render the textarea being composed in and destroy the
  // half-formed word — for a Chinese product this is the NORMAL typing path.
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "atmosphere" });
  bindWorldWs(new Root([el]), h.ctx, ui);
  el.oncompositionstart();
  for (const step of ["p", "pa", "pai"]) { el.value = step; el.oninput(); }
  settle(ui); // even a pause mid-composition must not commit
  assert.equal(h.production.world.atmosphere, "", "no intermediate IME state may be written");
  assert.equal(h.saves.length, 0, "and nothing may re-render mid-word");
});

test("IME: the composed text is written when the composition ENDS", () => {
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "atmosphere" });
  bindWorldWs(new Root([el]), h.ctx, ui);
  el.compose(["p", "pa", "pai"], "潮湿不安");
  settle(ui);
  assert.equal(h.production.world.atmosphere, "潮湿不安");
  const back = reload(h.serialize());
  assert.equal(back.production.world.atmosphere, "潮湿不安");
});

test("IME: a teardown DURING composition still keeps the committed text", () => {
  const h = harness();
  const ui = { briefBuffer: {} };
  const el = new El("textarea", { "data-cb-field": "notes" });
  bindBriefWs(new Root([el]), h.ctx, ui, () => {});
  el.compose(["j", "ji"], "禁忌：不写受害者叙事");
  // no settle — the page goes away right after the IME commits
  assert.ok(flushAllFields() >= 1);
  assert.equal(h.story.brief.draft.notes, "禁忌：不写受害者叙事");
});

test("teardown: a Ctrl+R inside the debounce still keeps the text", () => {
  // THE BLOCKER, in its sharpest form: type and reload immediately. The field
  // debounce has not fired, so the page teardown must commit it.
  const h = harness();
  const ui = { briefBuffer: {} };
  const el = new El("textarea", { "data-cb-field": "notes" });
  bindBriefWs(new Root([el]), h.ctx, ui, () => {});
  el.type("禁忌：不要写成受害者叙事");
  // NO settle() — this is the "refresh before the timer fires" case
  assert.equal(h.story.brief.draft.notes, "", "precondition: still only in the DOM");
  assert.equal(flushAllFields() >= 1, true); // what pagehide triggers
  assert.equal(h.story.brief.draft.notes, "禁忌：不要写成受害者叙事");
  const back = reload(h.saves[h.saves.length - 1]);
  assert.equal(back.story.brief.draft.notes, "禁忌：不要写成受害者叙事");
});

test("teardown: the CANVAS save also skips its debounce and uses keepalive", () => {
  // The field write is only half the loop: persist debounces the PUT by 700ms,
  // so a reload inside that window would drop it too. On teardown the write
  // must go out at once, with keepalive so it outlives the document.
  const NAME = "kp-proj";
  const all = [];
  const mine = () => all.filter((c) => c.url.includes(NAME));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    all.push({ url: String(url), keepalive: !!(opts && opts.keepalive), body: opts && opts.body });
    return { ok: true, headers: { get: () => "application/json" } };
  };
  try {
    // a queued save, then the page goes away before the timer fires
    saveCanvas(NAME, validDoc({ marker: "queued" }));
    assert.equal(mine().length, 0, "precondition: still only queued");
    assert.equal(flushCanvas(NAME), 1);
    assert.equal(mine().length, 1);
    assert.equal(mine()[0].keepalive, true, "a teardown write must use keepalive");
    assert.ok(mine()[0].body.includes("queued"));

    // and once unloading, any FURTHER save bypasses the debounce entirely —
    // whichever order the two teardown listeners happen to run in
    setUnloading(true);
    saveCanvas(NAME, validDoc({ marker: "after-unload" }));
    // writes are SERIALIZED, so this one waits for the previous request rather
    // than racing it — what matters is that it is never left in a 700ms timer
    assert.ok(mine().every((c) => c.keepalive));
    assert.ok(String(mine()[mine().length - 1].body).length > 0);
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

test("teardown: a field write is immediate NO MATTER which flush ran first", () => {
  // The listener order between persist.js and fieldsync.js is not guaranteed
  // (on mobile, `visibilitychange:hidden` can precede `pagehide`). If persist
  // flushed an EMPTY queue first, a field write arriving afterwards must still
  // go out at once — never into a 700ms timer a dying document never fires.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), keepalive: !!(opts && opts.keepalive), body: opts && opts.body });
    return { ok: true, headers: { get: () => "application/json" } };
  };
  try {
    const LATE = "late-proj";
    setUnloading(true);            // persist's listener runs FIRST, queue empty
    const mineLate = () => calls.filter((c) => c.url.includes(LATE));
    assert.equal(mineLate().length, 0);
    saveCanvas(LATE, validDoc({ marker: "late-field-write" })); // fieldsync second
    assert.equal(mineLate().length, 1, "a write during teardown must not be queued");
    assert.equal(mineLate()[0].keepalive, true);
    assert.ok(mineLate()[0].body.includes("late-field-write"));
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

test("teardown: coming back (BFCache / tab switch) restores normal debouncing", async () => {
  // `_unloading` is a FLAG, not a one-way switch: a page restored from the
  // back/forward cache, or a tab switched back to, must debounce again.
  const BF = "bfcache-proj";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes(BF)) calls.push({ keepalive: !!(opts && opts.keepalive) });
    return { ok: true, headers: { get: () => "application/json" } };
  };
  try {
    setUnloading(true);
    saveCanvas(BF, validDoc({ marker: "hidden" }));
    assert.equal(calls.length, 1); // immediate while hidden

    setUnloading(false); // pageshow / visible
    saveCanvas(BF, validDoc({ marker: "restored" }));
    assert.equal(calls.length, 1, "a restored session must debounce again, not write at once");
    // …and the queued write is still recoverable by a later teardown
    assert.equal(flushCanvas(BF), 1);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].keepalive, true);
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

/* A PUT stub that records each write and hands back a gate to settle it, so a
 * test can hold one request in flight and observe what the next one does. */
function putGate(NAME) {
  const started = [];
  const finished = [];
  const gates = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "PUT" && String(url).includes(NAME)) {
      const marker = JSON.parse(opts.body).marker;
      const signal = opts.signal || null;
      started.push({ marker, signal, keepalive: !!opts.keepalive });
      await new Promise((resolve, reject) => {
        // a real fetch rejects with an AbortError the moment its signal fires
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
        gates.push(() => {
          finished.push(marker);
          resolve();
        });
      });
      return { ok: true, headers: { get: () => "application/json" } };
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => validDoc() };
  };
  return {
    started,
    finished,
    gates,
    markers: () => started.map((s) => s.marker),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const afterDebounce = () => new Promise((r) => setTimeout(r, 800));

test("writes are SERIALIZED: an older save can never land after a newer one", async () => {
  // Two concurrent PUTs could complete out of order, and an older one landing
  // last would overwrite the server with stale content. Serializing per project
  // removes that whole class for ordinary saves: B's request is not even issued
  // until A settles. (The teardown write is the deliberate exception — it jumps
  // the queue and cancels what it supersedes; see the next test.)
  const NAME = "order-proj";
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "A" }));
    await afterDebounce();                 // A's debounce fires — A is in flight
    assert.deepEqual(g.markers(), ["A"]);
    saveCanvas(NAME, validDoc({ marker: "B" }));
    await afterDebounce();                 // B's debounce fires while A is held
    assert.deepEqual(g.markers(), ["A"], "B waits behind the request in flight");
    g.gates.shift()();                     // let A finish
    await tick();
    await tick();
    assert.deepEqual(g.markers(), ["A", "B"], "B is issued only after A settled");
    g.gates.shift()();
    await tick();
    assert.deepEqual(g.finished, ["A", "B"], "the newer write lands last");
  } finally {
    g.restore();
  }
});

test("teardown: the last edit is sent AT ONCE, not behind the request in flight", async () => {
  // Queueing a teardown write behind an in-flight PUT means it is dispatched only
  // once that PUT settles — and a page that terminates first never dispatches it,
  // so the creator's last edit dies with the document. It must jump the queue.
  const NAME = "jump-proj";
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "A" }));
    await afterDebounce();
    assert.deepEqual(g.markers(), ["A"], "A is in flight and held open");
    saveCanvas(NAME, validDoc({ marker: "B" }));   // the edit after A left
    setUnloading(true);                            // pagehide
    await tick();
    assert.deepEqual(g.markers(), ["A", "B"], "B goes out WITHOUT waiting for A");
    assert.equal(g.started[1].keepalive, true, "…and with keepalive, to outlive the page");
    // A carries an OLDER snapshot: if it landed last it would overwrite B, so it
    // is cancelled rather than raced.
    assert.equal(g.started[0].signal.aborted, true, "the superseded write is aborted");
    assert.equal(g.started[1].signal.aborted, false, "…while the teardown write itself stands");
  } finally {
    setUnloading(false);
    g.restore();
  }
});

test("teardown: the aborted write does not leave its STALE body in localStorage", async () => {
  // _write falls back to localStorage when a PUT fails — but an abort is not a
  // failure, it is "something newer replaced you". Writing that body locally
  // would restore pre-teardown content on the next load.
  const NAME = "abort-ls-proj";
  const store = new Map();
  const realLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "A" }));
    await afterDebounce();
    saveCanvas(NAME, validDoc({ marker: "B" }));
    setUnloading(true);
    await tick();
    await tick();
    const local = store.get("motv:" + NAME);
    if (local !== undefined) {
      assert.notEqual(JSON.parse(local).marker, "A", "the cancelled body must not be stored");
    }
  } finally {
    setUnloading(false);
    g.restore();
    globalThis.localStorage = realLS;
  }
});

test("teardown: a write WAITING on the chain is dropped, not run after the snapshot", async () => {
  // Overtaking the request in flight is only half of it. B was queued behind A
  // and is still waiting; if it ran after the teardown snapshot C it would put
  // pre-teardown content back on the server.
  const NAME = "chain-stale-proj";
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "A" }));
    await afterDebounce();                         // A in flight, held
    saveCanvas(NAME, validDoc({ marker: "B" }));
    await afterDebounce();                         // B queued behind A
    assert.deepEqual(g.markers(), ["A"]);
    saveCanvas(NAME, validDoc({ marker: "C" }));
    setUnloading(true);                            // C is the teardown snapshot
    await tick();
    assert.deepEqual(g.markers(), ["A", "C"], "C jumps ahead");
    g.gates.shift()();                             // A settles (it was aborted)
    await tick();
    await tick();
    assert.deepEqual(g.markers(), ["A", "C"], "B is dropped, never sent after C");
  } finally {
    setUnloading(false);
    g.restore();
  }
});

test("a load drops the write waiting on the chain and cancels the one in flight", async () => {
  // Both describe the graph the load replaces, so either landing afterwards would
  // overwrite the freshly loaded document.
  const NAME = "load-inflight-proj";
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "A" }));
    await afterDebounce();                         // A in flight
    saveCanvas(NAME, validDoc({ marker: "B" }));
    await afterDebounce();                         // B queued behind A
    assert.deepEqual(g.markers(), ["A"]);
    await loadCanvas(NAME);                        // supersedes both
    assert.equal(g.started[0].signal.aborted, true, "the in-flight write is cancelled");
    g.gates.shift()();
    await tick();
    await tick();
    assert.deepEqual(g.markers(), ["A"], "the queued write is not sent after the load");
  } finally {
    g.restore();
  }
});

test("teardown: two teardown writes in a row do not RACE each other", async () => {
  // pagehide and visibilitychange:hidden fire in succession, and tab switches
  // repeat. Both writes jump the queue, so if the first were not cancellable the
  // older full document could land last and overwrite the newer one.
  const NAME = "double-teardown-proj";
  const g = putGate(NAME);
  try {
    await loadCanvas(NAME);
    saveCanvas(NAME, validDoc({ marker: "first" }));
    setUnloading(true);                            // pagehide
    await tick();
    assert.deepEqual(g.markers(), ["first"]);
    saveCanvas(NAME, validDoc({ marker: "second" }));  // one more keystroke
    setUnloading(true);                            // hidden, right after
    await tick();
    assert.deepEqual(g.markers(), ["first", "second"]);
    assert.equal(g.started[0].signal.aborted, true, "the older teardown write is cancelled");
    assert.equal(g.started[1].signal.aborted, false, "the newest one is the survivor");
  } finally {
    setUnloading(false);
    g.restore();
  }
});

test("teardown: keepalive is refused once the AGGREGATE in-flight quota is spent", async () => {
  // The Fetch standard's 64 KiB keepalive ceiling counts every in-flight request
  // together. Two 40 KiB teardown saves each fit on their own, so a per-request
  // check would ask for keepalive twice and the second request would be rejected
  // outright — the very loss keepalive exists to prevent.
  const A = "quota-a";
  const B = "quota-b";
  const seen = [];
  const gates = [];
  const realFetch = globalThis.fetch;
  const mine = (url) => String(url).includes(A) || String(url).includes(B);
  globalThis.fetch = async (url, opts) => {
    // Only THIS test's two projects are held open and measured: setUnloading
    // flushes every project with a pending payload, including leftovers from
    // earlier tests, and those must not be counted or hold quota.
    if (opts && opts.method === "PUT" && mine(url)) {
      seen.push({ url: String(url), keepalive: !!opts.keepalive });
      await new Promise((r) => gates.push(r));
      return { ok: true, headers: { get: () => "application/json" } };
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => validDoc() };
  };
  try {
    setUnloading(true);
    await tick();                                  // let unrelated leftovers drain
    saveCanvas(A, validDoc({ bulk: "x".repeat(40 * 1024) }));
    await tick();
    saveCanvas(B, validDoc({ bulk: "y".repeat(40 * 1024) }));
    await tick();
    assert.equal(seen.length, 2, "both writes go out");
    assert.equal(seen[0].keepalive, true, "the first fits the ceiling");
    assert.equal(seen[1].keepalive, false, "the second must not claim quota that is gone");
    while (gates.length) gates.shift()();
    await tick();
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

test("a payload queued BEFORE a load is never written after it", async () => {
  // The queued payload describes the graph the load replaces. Cancelling its
  // timer is not enough: a later teardown flush would still find it and overwrite
  // the freshly loaded document with pre-load state.
  const NAME = "preload-proj";
  const g = putGate(NAME);
  try {
    saveCanvas(NAME, validDoc({ marker: "stale" }));  // queued, timer running
    await loadCanvas(NAME);                           // supersedes that graph
    assert.equal(flushCanvas(NAME), 0, "nothing is left queued to flush");
    setUnloading(true);
    await afterDebounce();
    assert.deepEqual(g.markers(), [], "the pre-load payload is never sent");
  } finally {
    setUnloading(false);
    g.restore();
  }
});

test("focus: a re-render that removed the clicked element must NOT steal focus back", () => {
  // After a re-render, activeElement falls back to <body> — which is NOT proof
  // the creator still wants the field they were typing in a while ago. Restoring
  // then would send their next keystrokes somewhere they are not looking.
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "era" });
  const root = new Root([el]);
  bindWorldWs(root, h.ctx, ui);
  el.type("当代");
  settle(ui);
  // pretend the typing happened a while ago (the creator has since clicked
  // something that the re-render removed)
  ui._fieldsync.focus.at = Date.now() - 5000;
  let focused = 0;
  el.focus = () => { focused += 1; };
  restoreFieldFocus(root, ui);
  assert.equal(focused, 0, "stale focus must not be restored");
  assert.equal(ui._fieldsync.focus, null, "and the stale record is cleared");
});

test("focus: the caret IS restored for the re-render our own typing caused", () => {
  const h = harness();
  const ui = { worldBuffer: {} };
  const el = new El("textarea", { "data-w-field": "era" });
  const root = new Root([el]);
  bindWorldWs(root, h.ctx, ui);
  el.type("当代雨季");
  let focused = 0;
  let range = null;
  el.focus = () => { focused += 1; };
  el.setSelectionRange = (a, b) => { range = [a, b]; };
  settle(ui);            // the write re-renders in the real shell
  restoreFieldFocus(root, ui);
  assert.equal(focused, 1, "mid-typing focus must come back");
  assert.deepEqual(range, [4, 4], "…with the caret where it was");
});

test("teardown: an OVERSIZED body does not request keepalive (it would be rejected)", async () => {
  // The Fetch standard rejects keepalive bodies over 64 KiB outright, so asking
  // for it would guarantee the request is never sent. The write is issued as an
  // ordinary one instead — best effort, and the documented limitation is that a
  // reload in that window can lose the final edit (see the module header).
  const NAME = "big-proj";
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes(NAME) && opts && opts.method === "PUT") {
      seen.push({ keepalive: !!opts.keepalive });
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => validDoc() };
  };
  try {
    setUnloading(true);
    saveCanvas(NAME, validDoc({ bulk: "x".repeat(70 * 1024) }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].keepalive, false, "over the ceiling, keepalive must not be requested");
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

test("teardown: a body that FITS is sent with keepalive so it outlives the page", async () => {
  const NAME = "fits-proj";
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes(NAME) && opts && opts.method === "PUT") {
      seen.push({ keepalive: !!opts.keepalive });
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => validDoc() };
  };
  try {
    setUnloading(true);
    saveCanvas(NAME, validDoc({ marker: "small" }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].keepalive, true);
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
  }
});

test("no local recovery cache is written: the save path infers no precedence", async () => {
  // An earlier revision kept an unconfirmed body in localStorage and preferred it
  // on the next load. That decision is gone (see the module header), and with it
  // every ordering hazard it produced — so nothing may be stashed.
  const NAME = "nocache-proj";
  const store = new Map();
  const realLS = globalThis.localStorage;
  const realFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "PUT") throw new Error("cancelled");
    return { ok: true, headers: { get: () => "application/json" }, json: async () => validDoc() };
  };
  try {
    setUnloading(true);
    saveCanvas(NAME, validDoc({ marker: "x" }));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(![...store.keys()].some((k) => k.includes("pending")), "no recovery copy may be written");
  } finally {
    setUnloading(false);
    globalThis.fetch = realFetch;
    globalThis.localStorage = realLS;
  }
});

test("teardown: flushing every bound shell commits all surfaces at once", () => {
  const h = harness();
  const c = bd.addCharacter(h.production, "林照");
  const uiBrief = { briefBuffer: {} };
  const uiWorld = { worldBuffer: {} };
  const uiBible = { bibleTab: "characters", bibleState: {} };
  const brief = new El("textarea", { "data-cb-field": "genre" });
  const world = new El("textarea", { "data-w-field": "society" });
  const prof = new El("textarea", { "data-b-chprof": c.characterId, "data-field": "desire" });
  bindBriefWs(new Root([brief]), h.ctx, uiBrief, () => {});
  bindWorldWs(new Root([world]), h.ctx, uiWorld);
  bindBibleWs(new Root([prof]), h.ctx, uiBible, () => {});
  brief.type("都市悬疑");
  world.type("老街等待拆迁");
  prof.type("拿回那一夜");
  flushAllFields(); // pagehide
  assert.equal(h.story.brief.draft.genre, "都市悬疑");
  assert.equal(h.production.world.society, "老街等待拆迁");
  assert.equal(c.profile.desire, "拿回那一夜");
});
