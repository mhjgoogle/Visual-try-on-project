// Production upstream workspace (TASK-057 / ADR-0054) — run via `node --test`,
// wrapped by tests/test_motv_upstream_task057.py.
//
// Covers:
// - Creative Brief: working draft vs formal revision (Autosave != Version),
//   immutable revisions, restore, and the outline's Based-on link;
// - Relationship as a first-class object: exactly two existing characters, one
//   definition per unordered pair, non-destructive removal;
// - World Setting as upstream canon, distinct from the Location domain;
// - Episode beats (plot / character / relationship / world) as Episode-level
//   records that never touch project canon;
// - the ONE lightweight version/dependency mechanism: canon revisions bumped
//   only by explicit confirmation, a five-key basedOn stamp, and a
//   deterministic impact diff with an honestly-unavailable AI verdict;
// - character tiers (正式 / 临时) and identity-preserving promotion;
// - the v9→v10 migration and v10 validation;
// - the upstream view models + the rail's information architecture.
import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";
import * as pd from "../src/workflow/proddoc.js";
import * as cd from "../src/workflow/canondoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import {
  CANVAS_SCHEMA_VERSION, MIGRATIONS, migrateToCurrent, validateCanvasDoc,
} from "../src/services/canvasschema.js";
import { briefModel, renderBriefWs } from "../src/ui/briefws.js";
import { relationshipsModel } from "../src/ui/relws.js";
import { worldModel } from "../src/ui/worldws.js";
import { episodePlanModel, renderEpPlanWs } from "../src/ui/epplanws.js";
import { canonModel, directorNote, surfacedSection, directorModel, renderDirector } from "../src/ui/director.js";
import { NAV, EPISODE_NAV, EPISODE_MODULES, MODULE_LABEL, renderRail, episodeLabels } from "../src/ui/shell.js";
import * as sd from "../src/workflow/scriptdoc.js";

/* ========================================================================= */
/* Creative Brief — Autosave != Version                                      */
/* ========================================================================= */

test("brief: a fresh story has a working draft and ZERO revisions", () => {
  const doc = st.createStory(null);
  assert.deepEqual(doc.brief.versions, []);
  assert.equal(doc.brief.active, 0);
  assert.equal(st.activeBrief(doc), null);
  assert.equal(st.briefIsDirty(doc), false); // nothing written yet
});

test("brief: editing the draft NEVER creates a version", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "深夜酒吧的调酒师");
  st.editBriefDraft(doc, { genre: "都市悬疑", tone: "冷峻" });
  st.editBriefDraft(doc, { form: "竖屏短剧", targetEpisodes: 12 });
  assert.equal(doc.brief.versions.length, 0);
  assert.equal(doc.brief.active, 0);
  assert.equal(st.briefIsDirty(doc), true);
  assert.equal(doc.brief.draft.genre, "都市悬疑");
  assert.equal(doc.brief.draft.targetEpisodes, 12);
});

test("brief: an out-of-range episode target degrades to null, never a guess", () => {
  const doc = st.createStory(null);
  st.editBriefDraft(doc, { targetEpisodes: 0 });
  assert.equal(doc.brief.draft.targetEpisodes, null);
  st.editBriefDraft(doc, { targetEpisodes: 51 }); // above the planning cap
  assert.equal(doc.brief.draft.targetEpisodes, null);
  st.editBriefDraft(doc, { targetEpisodes: 50 });
  assert.equal(doc.brief.draft.targetEpisodes, 50);
});

test("brief: commit creates ONE immutable revision carrying the idea", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "创意 A");
  st.editBriefDraft(doc, { genre: "悬疑" });
  const rec = st.commitBrief(doc);
  assert.equal(rec.v, 1);
  assert.equal(rec.idea, "创意 A");
  assert.equal(rec.fields.genre, "悬疑");
  assert.equal(doc.brief.active, 1);
  assert.equal(st.briefIsDirty(doc), false);
  // committing an unchanged draft is a NO-OP: no identical version is minted
  assert.equal(st.commitBrief(doc), null);
  assert.equal(doc.brief.versions.length, 1);
  // the revision is IMMUTABLE: later draft edits do not rewrite it
  st.setIdea(doc, "创意 B");
  st.editBriefDraft(doc, { genre: "爱情" });
  assert.equal(doc.brief.versions[0].idea, "创意 A");
  assert.equal(doc.brief.versions[0].fields.genre, "悬疑");
  assert.equal(st.briefIsDirty(doc), true);
  const rec2 = st.commitBrief(doc);
  assert.equal(rec2.v, 2);
  assert.equal(doc.brief.versions.length, 2); // v1 is preserved
});

test("brief: the core idea has exactly ONE home (story.idea, not a brief copy)", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "唯一一份");
  // the draft has no idea field at all — editing it cannot fork the idea
  assert.ok(!("idea" in doc.brief.draft));
  assert.ok(!("coreIdea" in doc.brief.draft));
  st.editBriefDraft(doc, { idea: "试图写第二份" });
  assert.equal(doc.idea, "唯一一份");
  assert.ok(!("idea" in doc.brief.draft));
});

test("brief: restore pulls a revision back into the DRAFT, chain untouched", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "v1 创意");
  st.editBriefDraft(doc, { genre: "悬疑" });
  st.commitBrief(doc);
  st.setIdea(doc, "v2 创意");
  st.editBriefDraft(doc, { genre: "喜剧" });
  st.commitBrief(doc);
  assert.ok(st.restoreBriefDraft(doc, 1));
  assert.equal(doc.idea, "v1 创意");
  assert.equal(doc.brief.draft.genre, "悬疑");
  assert.equal(doc.brief.versions.length, 2); // nothing removed or rewritten
  assert.equal(doc.brief.active, 2); // what downstream is based on did NOT move
  assert.equal(st.briefIsDirty(doc), true); // the draft now differs from v2
  assert.equal(st.restoreBriefDraft(doc, 9), false);
});

test("brief: setActiveBrief only accepts a real revision", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "x");
  st.commitBrief(doc);
  st.editBriefDraft(doc, { tone: "冷" });
  st.commitBrief(doc);
  assert.ok(st.setActiveBrief(doc, 1));
  assert.equal(doc.brief.active, 1);
  assert.equal(st.setActiveBrief(doc, 5), false);
  assert.equal(doc.brief.active, 1);
});

test("brief: hydration is lossless and pointers degrade deterministically", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "创意");
  st.editBriefDraft(doc, { genre: "悬疑", notes: "参考：某部片" });
  st.commitBrief(doc);
  const round = st.createStory(st.serialize(doc));
  assert.deepEqual(st.serialize(round), st.serialize(doc));
  // an unusable pointer falls back to the LATEST revision, never crashes
  const bad = st.createStory({ ...st.serialize(doc), brief: { ...st.serialize(doc).brief, active: 99 } });
  assert.equal(bad.brief.active, 1);
  // 0 stays 0 — "only a working draft" is a legal, meaningful state
  const draftOnly = st.createStory({ ...st.serialize(doc), brief: { ...st.serialize(doc).brief, active: 0 } });
  assert.equal(draftOnly.brief.active, 0);
});

test("outline records the brief revision it was developed from (Based on)", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "创意");
  st.commitBrief(doc); // brief v1
  const id = st.beginDevelop(doc, "outline", "");
  // committing another revision MID-RUN must not re-attribute the outline
  st.editBriefDraft(doc, { genre: "改了" });
  st.commitBrief(doc); // brief v2
  st.completeDevelop(doc, id, { premise: "前提" });
  const rec = st.applyProposal(doc);
  assert.equal(rec.briefVersionId, doc.brief.versions[0].id); // captured at LAUNCH
  assert.equal(st.briefForOutline(doc, rec).v, 1);
  // a manual outline links to whatever is active at the time
  const manual = st.applyManualOutline(doc, { premise: "改写" });
  assert.equal(st.briefForOutline(doc, manual).v, 2);
  // an outline with no link resolves honestly to null, never to today's brief
  assert.equal(st.briefForOutline(doc, { briefVersionId: null }), null);
});

test("outline gains the `climax` facet at v10", () => {
  assert.ok(st.OUTLINE_FIELDS.includes("climax"));
  const o = st.sanitizeOutline({ premise: "p" });
  assert.equal(o.climax, ""); // absent degrades to empty, never invented
  assert.equal(st.sanitizeOutline({ climax: "殿前抗旨" }).climax, "殿前抗旨");
});

/* ========================================================================= */
/* Relationship — first-class, exactly two characters                        */
/* ========================================================================= */

function prodWithChars(names = ["林照", "沈既白"]) {
  const prod = pd.createProduction(null);
  const chars = names.map((n) => bd.addCharacter(prod, n));
  return { prod, chars };
}

test("relationship: links two EXISTING distinct characters, one per pair", () => {
  const { prod, chars } = prodWithChars();
  const [a, b] = chars;
  const rec = cd.addRelationship(prod, a.characterId, b.characterId);
  assert.ok(rec.relationshipId);
  assert.deepEqual(rec.characterIds, [a.characterId, b.characterId]);
  // the same pair, in EITHER order, is the same relationship
  assert.equal(cd.addRelationship(prod, a.characterId, b.characterId), null);
  assert.equal(cd.addRelationship(prod, b.characterId, a.characterId), null);
  assert.equal(prod.relationships.length, 1);
  // refused: self, unknown, empty
  assert.equal(cd.addRelationship(prod, a.characterId, a.characterId), null);
  assert.equal(cd.addRelationship(prod, a.characterId, "char-gone"), null);
  assert.equal(cd.addRelationship(prod, "", b.characterId), null);
  // order-independent lookup
  assert.equal(cd.relationshipBetween(prod, b.characterId, a.characterId).relationshipId, rec.relationshipId);
  assert.equal(cd.relationshipsOfCharacter(prod, a.characterId).length, 1);
});

test("relationship: the definition carries every creative facet, canon-level", () => {
  const { prod, chars } = prodWithChars();
  const rec = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  for (const k of cd.RELATIONSHIP_FIELDS) assert.equal(rec.profile[k], "");
  assert.ok(cd.updateRelationship(prod, rec.relationshipId, {
    basis: "曾经的搭档", coreConflict: "谁背叛了谁", power: "沈既白掌握录音",
    arc: "戒备 → 合作 → 信任 → 决裂 → 再选择", forbidden: "不可以变成单纯的师徒温情",
  }));
  assert.equal(rec.profile.arc, "戒备 → 合作 → 信任 → 决裂 → 再选择");
  // unknown keys are ignored (whitelisted facets only)
  cd.updateRelationship(prod, rec.relationshipId, { evil: "x" });
  assert.ok(!("evil" in rec.profile));
  assert.equal(cd.updateRelationship(prod, "rel-gone", { basis: "x" }), false);
});

test("relationship: a character carries NO copy of the relationship", () => {
  const { prod, chars } = prodWithChars();
  cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  for (const c of prod.characters) {
    assert.ok(!("relationships" in c));
    assert.ok(!("relationshipIds" in c));
  }
});

test("relationship: removal is REFUSED while an episode records its beat", () => {
  const { prod, chars } = prodWithChars();
  const rec = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  const ep = prod.episodes[0];
  assert.ok(cd.setEpisodeRelationshipBeat(prod, ep.episodeId, rec.relationshipId, {
    start: "利益合作", event: "沈既白替林照承担风险", end: "有限信任",
  }));
  assert.equal(cd.removeRelationship(prod, rec.relationshipId), false);
  assert.equal(prod.relationships.length, 1);
  // release the beat, then removal succeeds
  assert.ok(cd.setEpisodeRelationshipBeat(prod, ep.episodeId, rec.relationshipId, {}));
  assert.ok(cd.removeRelationship(prod, rec.relationshipId));
  assert.equal(prod.relationships.length, 0);
});

test("character removal is refused while a relationship or beat references it", () => {
  const { prod, chars } = prodWithChars();
  const [a, b] = chars;
  const rec = cd.addRelationship(prod, a.characterId, b.characterId);
  assert.equal(bd.removeCharacter(prod, a.characterId), false); // in a relationship
  assert.ok(cd.removeRelationship(prod, rec.relationshipId));
  cd.setEpisodeCharacterBeat(prod, prod.episodes[0].episodeId, a.characterId, "做出选择");
  assert.equal(bd.removeCharacter(prod, a.characterId), false); // in a beat
  cd.setEpisodeCharacterBeat(prod, prod.episodes[0].episodeId, a.characterId, "");
  assert.ok(bd.removeCharacter(prod, a.characterId));
});

test("relationship hydration drops only unusable records", () => {
  const { prod, chars } = prodWithChars(["A", "B", "C"]);
  const [a, b, c] = chars;
  const saved = pd.serialize(prod);
  saved.relationships = [
    { relationshipId: "r1", characterIds: [a.characterId, b.characterId], profile: {} },
    { relationshipId: "r1", characterIds: [a.characterId, c.characterId], profile: {} }, // dup id
    { relationshipId: "r2", characterIds: [b.characterId, a.characterId], profile: {} }, // dup PAIR
    { relationshipId: "r3", characterIds: [a.characterId, "char-gone"], profile: {} }, // unknown
    { relationshipId: "r4", characterIds: [a.characterId], profile: {} }, // not two
    { relationshipId: "r5", characterIds: [c.characterId, c.characterId], profile: {} }, // self
    { relationshipId: "r6", characterIds: [b.characterId, c.characterId], profile: { basis: "同事" } },
  ];
  const hydrated = pd.createProduction(saved);
  assert.deepEqual(hydrated.relationships.map((r) => r.relationshipId), ["r1", "r6"]);
  assert.equal(hydrated.relationships[1].profile.basis, "同事");
  // and a clean document round-trips byte-for-byte
  assert.deepEqual(pd.serialize(pd.createProduction(pd.serialize(hydrated))), pd.serialize(hydrated));
});

/* ========================================================================= */
/* World Setting — upstream canon, NOT a second location database            */
/* ========================================================================= */

test("world: an empty profile hydrates, edits are whitelisted, round-trips", () => {
  const prod = pd.createProduction(null);
  for (const k of cd.WORLD_FIELDS) assert.equal(prod.world[k], "");
  assert.ok(cd.updateWorld(prod, { era: "2019 年冬", rules: "录音即证据", visualTone: "冷蓝" }));
  cd.updateWorld(prod, { locations: "试图塞地点库" });
  assert.ok(!("locations" in prod.world));
  assert.equal(prod.world.era, "2019 年冬");
  assert.deepEqual(pd.serialize(pd.createProduction(pd.serialize(prod))).world, prod.world);
});

test("world does NOT replace the Location domain", () => {
  const prod = pd.createProduction(null);
  const loc = bd.addLocation(prod, "暗夜酒吧");
  cd.updateWorld(prod, { places: "酒吧、旧公寓、警局" });
  // the canonical location entity is untouched and still the one scenes bind to
  assert.equal(prod.locations.length, 1);
  assert.equal(bd.findLocation(prod, loc.locationId).name, "暗夜酒吧");
  const scene = pd.addScene(prod, prod.episodes[0].episodeId, "第一场");
  assert.ok(bd.setSceneLocation(prod, scene.sceneId, loc.locationId, null));
  assert.equal(scene.locationRef.locationId, loc.locationId);
  // the world's prose is NOT a resolvable location reference
  assert.equal(bd.findLocation(prod, "酒吧、旧公寓、警局"), null);
});

/* ========================================================================= */
/* Episode beats — Episode-level records, never project canon                */
/* ========================================================================= */

test("beats: a fresh/added episode records nothing and is not auto-stamped", () => {
  const prod = pd.createProduction(null);
  assert.deepEqual(prod.episodes[0].beats, { plot: [], character: [], relationship: [], world: [] });
  assert.deepEqual(prod.episodes[0].basedOn, { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 });
  const ep = pd.addEpisode(prod, "EP02");
  assert.deepEqual(ep.beats.plot, []);
  assert.deepEqual(ep.basedOn.outline, 0);
});

test("beats: plot / world are string lists; blanks are dropped", () => {
  const prod = pd.createProduction(null);
  const id = prod.episodes[0].episodeId;
  assert.ok(cd.setEpisodeTextBeats(prod, id, "plot", ["找到录音", "  ", "被跟踪"]));
  assert.deepEqual(prod.episodes[0].beats.plot, ["找到录音", "被跟踪"]);
  assert.ok(cd.setEpisodeTextBeats(prod, id, "world", ["录音可以作为证据"]));
  assert.equal(cd.setEpisodeTextBeats(prod, id, "nonsense", ["x"]), false);
  assert.equal(cd.setEpisodeTextBeats(prod, "ep-gone", "plot", ["x"]), false);
});

test("beats: a character beat requires a REAL character; blank removes it", () => {
  const { prod, chars } = prodWithChars();
  const id = prod.episodes[0].episodeId;
  assert.equal(cd.setEpisodeCharacterBeat(prod, id, "char-gone", "x"), false);
  assert.ok(cd.setEpisodeCharacterBeat(prod, id, chars[0].characterId, "第一次说谎"));
  assert.equal(prod.episodes[0].beats.character.length, 1);
  // one beat per character: writing again REPLACES, never duplicates
  assert.ok(cd.setEpisodeCharacterBeat(prod, id, chars[0].characterId, "改写"));
  assert.equal(prod.episodes[0].beats.character.length, 1);
  assert.equal(prod.episodes[0].beats.character[0].beat, "改写");
  assert.ok(cd.setEpisodeCharacterBeat(prod, id, chars[0].characterId, "   "));
  assert.equal(prod.episodes[0].beats.character.length, 0);
});

test("beats: a Relationship Beat does NOT change the project-level definition", () => {
  const { prod, chars } = prodWithChars();
  const rec = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  cd.updateRelationship(prod, rec.relationshipId, { basis: "戒备", arc: "戒备 → 合作 → 信任" });
  const before = structuredClone(rec.profile);
  const id = prod.episodes[0].episodeId;
  assert.ok(cd.setEpisodeRelationshipBeat(prod, id, rec.relationshipId, {
    start: "利益合作", event: "沈既白替林照承担风险", end: "有限信任",
  }));
  assert.deepEqual(rec.profile, before); // canon untouched
  assert.deepEqual(prod.episodes[0].beats.relationship, [{
    relationshipId: rec.relationshipId, start: "利益合作",
    event: "沈既白替林照承担风险", end: "有限信任",
  }]);
  assert.equal(cd.setEpisodeRelationshipBeat(prod, id, "rel-gone", { start: "x" }), false);
  assert.equal(cd.episodesWithRelationshipBeat(prod, rec.relationshipId).length, 1);
});

test("beats hydration dedupes: hydration and validation must agree", () => {
  // a corrupt save with two beats for one entity must hydrate to ONE, else the
  // round-trip produces a document v10 validation rejects → save blocked
  const { prod, chars } = prodWithChars();
  const rel = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  const id = prod.episodes[0].episodeId;
  cd.setEpisodeCharacterBeat(prod, id, chars[0].characterId, "第一次");
  cd.setEpisodeRelationshipBeat(prod, id, rel.relationshipId, { start: "a", event: "b", end: "c" });
  const saved = pd.serialize(prod);
  saved.episodes[0].beats.character.push({ characterId: chars[0].characterId, beat: "重复" });
  saved.episodes[0].beats.relationship.push({ relationshipId: rel.relationshipId, start: "x", event: "", end: "" });
  const h = pd.createProduction(saved);
  assert.equal(h.episodes[0].beats.character.length, 1);
  assert.equal(h.episodes[0].beats.character[0].beat, "第一次"); // first claim wins
  assert.equal(h.episodes[0].beats.relationship.length, 1);
  assert.equal(h.episodes[0].beats.relationship[0].start, "a");
  // …and the hydrated result is a document validation accepts
  const doc = { ...v10Doc(), production: pd.serialize(h) };
  doc.story.brief.versions = [];
  doc.story.brief.active = 0;
  doc.story.versions.forEach((x) => { x.briefVersionId = null; });
  assert.equal(validateCanvasDoc(doc), null);
});

test("beats hydration drops references that no longer resolve", () => {
  const { prod, chars } = prodWithChars();
  const rec = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  const id = prod.episodes[0].episodeId;
  cd.setEpisodeCharacterBeat(prod, id, chars[0].characterId, "选择");
  cd.setEpisodeRelationshipBeat(prod, id, rec.relationshipId, { start: "a", event: "b", end: "c" });
  const saved = pd.serialize(prod);
  // a hand-corrupted save whose beats point at deleted canon
  saved.episodes[0].beats.character.push({ characterId: "char-gone", beat: "x" });
  saved.episodes[0].beats.relationship.push({ relationshipId: "rel-gone", start: "x", event: "", end: "" });
  saved.episodes[0].beats.plot = ["真的", 7, null];
  const hydrated = pd.createProduction(saved);
  assert.equal(hydrated.episodes[0].beats.character.length, 1);
  assert.equal(hydrated.episodes[0].beats.relationship.length, 1);
  assert.deepEqual(hydrated.episodes[0].beats.plot, ["真的"]);
});

/* ========================================================================= */
/* ONE version/dependency mechanism                                          */
/* ========================================================================= */

test("canon revisions are bumped ONLY by an explicit confirmation", () => {
  const { prod, chars } = prodWithChars();
  assert.deepEqual(prod.canon, { characters: 0, relationships: 0, world: 0 });
  // ordinary edits — the autosave path — never move a version number
  bd.updateCharacterProfile(prod, chars[0].characterId, { appearance: "短发" });
  cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  cd.updateWorld(prod, { era: "2019" });
  assert.deepEqual(prod.canon, { characters: 0, relationships: 0, world: 0 });
  assert.equal(cd.confirmCanon(prod, "characters"), 1);
  assert.equal(cd.confirmCanon(prod, "characters"), 2);
  assert.equal(cd.confirmCanon(prod, "world"), 1);
  assert.equal(cd.confirmCanon(prod, "nonsense"), 0); // unknown surface refused
  assert.deepEqual(prod.canon, { characters: 2, relationships: 0, world: 1 });
});

test("upstreamVersions reuses the story chain's EXISTING pointers", () => {
  const story = st.createStory(null);
  const prod = pd.createProduction(null);
  assert.deepEqual(cd.upstreamVersions(story, prod), {
    brief: 0, outline: 0, characters: 0, relationships: 0, world: 0,
  });
  st.setIdea(story, "创意");
  st.commitBrief(story);
  const id = st.beginDevelop(story, "outline", "");
  st.completeDevelop(story, id, { premise: "p" });
  st.applyProposal(story);
  // an APPLIED but unapproved outline is not yet something downstream is based on
  assert.equal(cd.upstreamVersions(story, prod).outline, 0);
  st.approveOutline(story, 1);
  cd.confirmCanon(prod, "world");
  assert.deepEqual(cd.upstreamVersions(story, prod), {
    brief: 1, outline: 1, characters: 0, relationships: 0, world: 1,
  });
});

/** A project with confirmed upstream versions on every surface. */
function upstreamProject() {
  const story = st.createStory(null);
  st.setIdea(story, "创意");
  st.commitBrief(story); // brief v1
  const gid = st.beginDevelop(story, "outline", "");
  st.completeDevelop(story, gid, { premise: "前提" });
  st.applyProposal(story);
  st.approveOutline(story, 1); // outline v1
  const prod = pd.createProduction(null);
  const a = bd.addCharacter(prod, "林照");
  const b = bd.addCharacter(prod, "沈既白");
  cd.addRelationship(prod, a.characterId, b.characterId);
  cd.updateWorld(prod, { era: "2019 年冬", rules: "录音即证据" });
  cd.confirmCanon(prod, "characters");
  cd.confirmCanon(prod, "relationships");
  cd.confirmCanon(prod, "world");
  return { story, prod, a, b };
}

/* ---- the three (four) dependency states, kept strictly apart --------------- */

test("surfaceState: 0 is UNKNOWN, never an old version", () => {
  // none: the surface itself has no version → nothing to compare
  assert.equal(cd.surfaceState(0, 0), "none");
  assert.equal(cd.surfaceState(3, 0), "none");
  // unknown: no recorded baseline. NOT outdated, no matter how far upstream is
  assert.equal(cd.surfaceState(0, 1), "unknown");
  assert.equal(cd.surfaceState(0, 99), "unknown");
  // current / outdated / diverged all require a RECORDED baseline
  assert.equal(cd.surfaceState(2, 2), "current");
  assert.equal(cd.surfaceState(1, 2), "outdated"); // moved forward
  assert.equal(cd.surfaceState(2, 1), "diverged"); // rolled back
  // total: every input lands in exactly one state
  for (const s of [0, 1, 2, 9]) {
    for (const c of [0, 1, 2, 9]) {
      assert.ok(Object.values(cd.UPSTREAM_STATE).includes(cd.surfaceState(s, c)));
    }
  }
});

test("impact: an episode with NO recorded baseline is unknown, not outdated", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  // requirement 1 + 2: 0 means 未记录 — it can NEVER produce a change count
  assert.equal(im.count, 0);
  assert.equal(im.state, "unknown");
  assert.deepEqual(im.stale, []);
  assert.deepEqual(im.outdated, []);
  assert.deepEqual(im.diverged, []);
  assert.equal(im.baselineRecorded, false);
  assert.deepEqual(im.unknown.map((u) => u.key), ["brief", "outline", "characters", "relationships", "world"]);
  assert.ok(im.surfaces.every((s) => s.state === "unknown"));
  assert.deepEqual(im.basedOn, { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 });
  // …and it STAYS unknown however far upstream moves (requirement 3: outdated
  // requires a recorded baseline first)
  for (let i = 0; i < 3; i++) {
    cd.confirmCanon(prod, "world");
    st.editBriefDraft(story, { genre: `v${i}` });
    st.commitBrief(story);
  }
  const later = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(later.count, 0);
  assert.equal(later.state, "unknown");
  assert.deepEqual(later.outdated, []);
});

test("impact: a MIGRATED legacy episode is never reported as 上游已更新", () => {
  // the real end-to-end path: a v9 save (no dependency data at all) migrated
  // into a project whose upstream already carries confirmed versions
  const migrated = migrateToCurrent(v9Doc()).doc;
  const story = st.createStory(migrated.story);
  const prod = pd.createProduction(migrated.production);
  st.setIdea(story, "创意");
  st.commitBrief(story);
  cd.confirmCanon(prod, "characters");
  cd.confirmCanon(prod, "world");
  const ep = prod.episodes[0];
  assert.deepEqual(ep.basedOn, { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 });
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.count, 0, "a migrated episode must not report upstream changes");
  assert.equal(im.state, "unknown");
  assert.ok(im.unknown.length >= 3);
  assert.deepEqual(im.outdated, []);
});

test("impact: outdated requires a RECORDED baseline that then moved FORWARD", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  cd.stampEpisodeUpstream(prod, ep.episodeId, story); // requirement 5: baseline recorded
  let im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.state, "current");
  assert.equal(im.baselineRecorded, true);
  assert.equal(im.count, 0);
  assert.ok(im.surfaces.every((s) => s.state === "current"));

  cd.confirmCanon(prod, "world"); // NOW it can be outdated
  im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.state, "outdated");
  assert.equal(im.count, 1);
  assert.deepEqual(im.outdated.map((s) => s.key), ["world"]);
  assert.deepEqual(im.diverged, []);
  assert.equal(im.outdated[0].from, 1);
  assert.equal(im.outdated[0].current, 2);
});

test("impact: a rollback is DIVERGED, reported separately from outdated", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  st.editBriefDraft(story, { genre: "v2" });
  st.commitBrief(story);
  cd.stampEpisodeUpstream(prod, ep.episodeId, story); // baseline: brief v2
  assert.ok(st.setActiveBrief(story, 1));             // rolled BACK
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.state, "diverged");
  assert.equal(im.count, 1);
  assert.deepEqual(im.diverged.map((s) => s.key), ["brief"]);
  assert.deepEqual(im.outdated, []);
  assert.equal(cd.UPSTREAM_STATE_LABEL[im.state], "上游已回退");
});

test("impact: unknown and outdated coexist without contaminating each other", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  // record a baseline for ONE surface only, by hand, then move it forward
  ep.basedOn = { brief: 0, outline: 0, characters: 1, relationships: 0, world: 0 };
  cd.confirmCanon(prod, "characters");
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  // the count covers ONLY the recorded-and-moved surface
  assert.equal(im.count, 1);
  assert.deepEqual(im.outdated.map((s) => s.key), ["characters"]);
  // the four unrecorded ones stay unknown and uncounted
  assert.deepEqual(im.unknown.map((s) => s.key), ["brief", "outline", "relationships", "world"]);
  assert.equal(im.baselineRecorded, false);
  // an actionable change outranks the missing baseline in the episode verdict
  assert.equal(im.state, "outdated");
});

test("impact: stamping, then an upstream revision, yields a provable diff", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  assert.ok(cd.stampEpisodeUpstream(prod, ep.episodeId, story));
  let im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.count, 0);
  assert.deepEqual(im.unknown, []);

  // two upstream surfaces move on
  cd.updateWorld(prod, { rules: "录音不再是证据" });
  cd.confirmCanon(prod, "world"); // world v2
  st.editBriefDraft(story, { genre: "改成悬疑" });
  st.commitBrief(story); // brief v2

  im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.count, 2);
  assert.deepEqual(im.stale.map((s) => s.key).sort(), ["brief", "world"]);
  const w = im.stale.find((s) => s.key === "world");
  assert.equal(w.from, 1);
  assert.equal(w.current, 2);
  assert.equal(w.goto, "world");
  // the episode itself was NOT modified by any of this
  assert.deepEqual(ep.basedOn, { brief: 1, outline: 1, characters: 1, relationships: 1, world: 1 });
  // …and an explicit re-stamp clears it
  assert.ok(cd.stampEpisodeUpstream(prod, ep.episodeId, story));
  assert.equal(cd.episodeImpact(prod, ep.episodeId, story).count, 0);
});

test("impact: an upstream revision NEVER rewrites the episode's content", () => {
  const { story, prod, a } = upstreamProject();
  const ep = prod.episodes[0];
  cd.setEpisodeTextBeats(prod, ep.episodeId, "plot", ["找到录音"]);
  cd.setEpisodeCharacterBeat(prod, ep.episodeId, a.characterId, "第一次说谎");
  pd.renameEpisode(prod, ep.episodeId, "EP01 夜班");
  cd.stampEpisodeUpstream(prod, ep.episodeId, story);
  const snapshot = structuredClone(ep);

  st.applyManualOutline(story, { premise: "完全改写" });
  st.approveOutline(story, 2);
  cd.confirmCanon(prod, "characters");
  cd.confirmCanon(prod, "relationships");

  assert.deepEqual(ep, snapshot); // title, beats and stamp all untouched
  assert.equal(cd.episodeImpact(prod, ep.episodeId, story).count, 3);
});

test("impact: a ROLLED-BACK upstream pointer is a change, not 'up to date'", () => {
  // Two of the five surfaces are POINTERS: story.brief.active and
  // story.approved can select an EARLIER revision. Rolling one back changes
  // what an episode is based on just as much as moving forward — an ordering
  // test would report the episode as current and hide the review.
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  st.editBriefDraft(story, { genre: "v2 的类型" });
  st.commitBrief(story);            // brief v2
  st.applyManualOutline(story, { premise: "v2 的前提" });
  st.approveOutline(story, 2);      // outline v2
  cd.stampEpisodeUpstream(prod, ep.episodeId, story);
  assert.equal(cd.episodeImpact(prod, ep.episodeId, story).count, 0);

  assert.ok(st.setActiveBrief(story, 1)); // roll the brief BACK to v1
  assert.ok(st.approveOutline(story, 1)); // and re-approve the older outline
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.count, 2);
  assert.deepEqual(im.stale.map((s) => s.key).sort(), ["brief", "outline"]);
  const b = im.stale.find((s) => s.key === "brief");
  assert.equal(b.from, 2);    // the episode was stamped at v2…
  assert.equal(b.current, 1); // …and the active revision is now v1
});

test("impact: a stamp pointing at a NONEXISTENT version cannot mask changes", () => {
  // A corrupt/forged stamp above every current version must surface as changed.
  // Validation deliberately does NOT bound the stamp by the current version:
  // stamp > current is a LEGITIMATE state after a rollback (see the test
  // above), so rejecting it would refuse a valid document.
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  cd.stampEpisodeUpstream(prod, ep.episodeId, story);
  ep.basedOn.world = 99;
  const im = cd.episodeImpact(prod, ep.episodeId, story);
  assert.equal(im.count, 1);
  assert.deepEqual(im.stale.map((s) => s.key), ["world"]);
  assert.equal(im.stale[0].from, 99);
  assert.equal(im.stale[0].current, 1);
  // and it stays reported no matter how many real revisions follow
  cd.confirmCanon(prod, "world");
  cd.confirmCanon(prod, "world");
  assert.equal(cd.episodeImpact(prod, ep.episodeId, story).count, 1);
});

test("pairKey is injective for ids containing ANY separator character", () => {
  // A characterId is an arbitrary non-empty string, so a joined key would let
  // two different pairs collide and silently merge two relationships.
  for (const sep of ["|", " ", ":", ",", "\u0000", "\u001f"]) {
    const k1 = cd.pairKey(`a${sep}b`, "c");
    const k2 = cd.pairKey("a", `b${sep}c`);
    assert.notEqual(k1, k2, `pairKey collides on ${JSON.stringify(sep)}`);
  }
  // still order-independent
  assert.equal(cd.pairKey("x", "y"), cd.pairKey("y", "x"));
  // and the key is plain text — no control characters leak into it
  assert.ok(!/[\u0000-\u001f]/.test(cd.pairKey("a", "b")));
});

test("v10 validation uses the DOMAIN's pair key (no local join that over-rejects)", () => {
  // A delimiter-joined key in the validator would make ["a b","c"] and
  // ["a","b c"] collide and REJECT a document hydration happily accepts —
  // blocking a legitimate save. Validation must apply the same rule as the
  // domain, exactly like the shared MAX_CLIP_* bounds.
  const doc = v10Doc();
  const mk = (id, name) => ({
    characterId: id, name, tier: "formal",
    profile: {
      appearance: "", costume: "", personality: "", visualInstruction: "",
      identity: "", desire: "", weakness: "", coreConflict: "", arc: "",
    },
    referenceAssetIds: [], activeReferenceAssetId: null,
    voice: { voiceId: null, description: "", performance: {} }, states: [],
  });
  const profile = {};
  for (const k of cd.RELATIONSHIP_FIELDS) profile[k] = "";
  for (const sep of [" ", "|", ":", ","]) {
    const d = structuredClone(doc);
    d.production.characters.push(mk(`a${sep}b`, "AB"), mk("c", "C"), mk("a", "A"), mk(`b${sep}c`, "BC"));
    d.production.relationships.push(
      { relationshipId: `r-x-${sep}`, characterIds: [`a${sep}b`, "c"], profile: { ...profile } },
      { relationshipId: `r-y-${sep}`, characterIds: ["a", `b${sep}c`], profile: { ...profile } },
    );
    assert.equal(validateCanvasDoc(d), null, `separator ${JSON.stringify(sep)} must not collide`);
    // hydration keeps BOTH — validation and hydration now agree
    assert.equal(pd.createProduction(d.production).relationships.length, 3);
  }
  // a genuine duplicate pair is still rejected
  const dup = structuredClone(doc);
  dup.production.relationships.push({
    relationshipId: "rel-2", characterIds: ["char-2", "char-1"], profile: { ...profile },
  });
  assert.ok(validateCanvasDoc(dup));
});

/** Render 分集规划 from a live production/story pair. */
function renderPlan(prod, story, ui = {}) {
  return renderEpPlanWs(
    {
      prodData: () => snap(prod),
      story: { doc: () => story },
      canon: { impact: (id) => cd.episodeImpact(prod, id, story) },
      breakdown: { state: () => null },
      script: { doc: () => sd.createDoc() },
      toast: () => {},
      isConnected: () => true,
    },
    { dirOpen: {}, ...ui },
  );
}

test("UI: an unrecorded baseline shows 上游基线未记录, never 「N 个上游更新」", () => {
  const { story, prod } = upstreamProject();
  const html = renderPlan(prod, story);
  assert.ok(html.includes("上游基线未记录"));
  assert.ok(html.includes("建立当前基线"));
  // requirement 2: no change count anywhere for an unrecorded baseline
  assert.ok(!/个上游变化/.test(html));
  assert.ok(!/个上游更新/.test(html));
  assert.ok(!html.includes("与上游一致"));
  // every surface chip reads 未记录 and is muted, not gated
  for (const label of ["创意 Brief", "故事大纲", "人物", "人物关系", "世界观"]) {
    assert.ok(
      html.includes(`<span class="chip mute" title="本集没有记录 ${label} 的基线`),
      `${label} must render as an unrecorded baseline`,
    );
  }
  assert.ok(!/<span class="chip gate"/.test(html), "nothing may be gated on an unrecorded baseline");
  // the explanatory title says outright that this is not "behind"
  assert.ok(html.includes("不代表落后"));
});

test("UI: recording the baseline flips the card to 与上游一致", () => {
  const { story, prod } = upstreamProject();
  cd.stampEpisodeUpstream(prod, prod.episodes[0].episodeId, story);
  const html = renderPlan(prod, story);
  assert.ok(html.includes("与上游一致"));
  assert.ok(!html.includes("上游基线未记录"));
  assert.ok(!/个上游变化/.test(html));
});

test("UI: only after a recorded baseline moves does the card show a change", () => {
  const { story, prod } = upstreamProject();
  cd.stampEpisodeUpstream(prod, prod.episodes[0].episodeId, story);
  cd.confirmCanon(prod, "world");
  const html = renderPlan(prod, story);
  assert.ok(html.includes("⚠ 1 个上游变化"));
  assert.ok(!html.includes("上游基线未记录"));
  // the Impact Review names the KIND of change
  const review = renderPlan(prod, story, { impactOpen: prod.episodes[0].episodeId });
  assert.ok(review.includes("上游已更新：本集基于 v1 · 当前 v2"));
  assert.ok(review.includes("确定性依赖变化"));
});

test("UI: the Impact Review calls an unrecorded surface 没有记录基线, not 落后", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  ep.basedOn = { brief: 0, outline: 0, characters: 1, relationships: 0, world: 0 };
  cd.confirmCanon(prod, "characters");
  const review = renderPlan(prod, story, { impactOpen: ep.episodeId });
  assert.ok(review.includes("没有记录基线"));
  assert.ok(review.includes("这不是「落后」"));
  assert.ok(review.includes("上游已更新：本集基于 v1 · 当前 v2"));
});

test("read model: the rail and the Director never flag an unrecorded baseline", () => {
  const { story, prod } = upstreamProject();
  const doc = sd.createDoc();
  const pdSnap = snap(prod);

  // the rail badge is driven by im.count, so an unknown baseline yields none
  const upstream = {};
  for (const e of prod.episodes) {
    const im = cd.episodeImpact(prod, e.episodeId, story);
    if (im.count) upstream[e.episodeId] = im.count;
  }
  assert.deepEqual(upstream, {});
  const rail = renderRail({
    activeModule: "brief", badges: {}, episodes: episodeLabels(prod),
    ratios: {}, episodeMode: false, upstream,
  });
  assert.ok(!rail.includes("变化"), "the rail must not claim a change for an unrecorded baseline");

  // the Director separates the two lists, with distinct wording
  let cm = canonModel({ story, pd: pdSnap });
  assert.deepEqual(cm.stale, []);
  assert.equal(cm.unrecorded.length, 1);
  let html = renderDirector(
    directorModel({ module: "brief", doc, story, pd: pdSnap, sel: { dirOpen: {} } }), "", { canon: true },
  );
  assert.ok(html.includes("上游基线未记录"));
  assert.ok(html.includes("未记录 ≠ 落后"));
  assert.ok(!html.includes("上游变化（确定性）"));
  // …and the COLLAPSED summary must not claim agreement either
  assert.ok(html.includes("1 集基线未记录"));
  assert.ok(!html.includes("与上游一致"), "an unrecorded baseline is not agreement");

  // once a baseline exists AND moves, it appears in the CHANGED list instead
  cd.stampEpisodeUpstream(prod, prod.episodes[0].episodeId, story);
  cd.confirmCanon(prod, "world");
  cm = canonModel({ story, pd: snap(prod) });
  assert.equal(cm.unrecorded.length, 0);
  assert.equal(cm.stale.length, 1);
  assert.deepEqual(cm.stale[0].surfaces, ["世界观（已更新）"]);
  html = renderDirector(
    directorModel({ module: "brief", doc, story, pd: snap(prod), sel: { dirOpen: {} } }), "", { canon: true },
  );
  assert.ok(html.includes("上游变化（确定性）"));
  assert.ok(!html.includes("上游基线未记录"));
});

test("basedOn chips flag EXACTLY the surfaces the impact model calls changed", () => {
  // the view must not carry its own copy of the staleness rule: a rolled-back
  // pointer has to light up the same surface the count refers to
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  st.editBriefDraft(story, { genre: "v2" });
  st.commitBrief(story);
  cd.stampEpisodeUpstream(prod, ep.episodeId, story); // stamped at brief v2
  assert.ok(st.setActiveBrief(story, 1));             // rolled BACK to v1
  const impactOf = (id) => cd.episodeImpact(prod, id, story);
  const html = renderEpPlanWs(
    {
      prodData: () => snap(prod), story: { doc: () => story },
      canon: { impact: impactOf }, breakdown: { state: () => null },
      script: { doc: () => sd.createDoc() }, toast: () => {}, isConnected: () => true,
    },
    { dirOpen: {} },
  );
  const im = impactOf(ep.episodeId);
  assert.equal(im.count, 1);
  assert.deepEqual(im.stale.map((s) => s.key), ["brief"]);
  // the rolled-back surface carries the gate chip…
  assert.match(html, /<span class="chip gate"[^>]*>创意 Brief v2<\/span>/);
  // …and a surface that did NOT change does not
  assert.match(html, /<span class="chip"[^>]*>世界观 v1<\/span>/);
  assert.ok(html.includes("⚠ 1 个上游变化"));
});

test("relationships: two pairs whose ids differ only by a separator stay distinct", () => {
  const prod = pd.createProduction(null);
  // hand-authored ids (the domain accepts any non-empty string)
  prod.characters.push(
    { characterId: "a|b", name: "A|B", tier: "formal", profile: {}, referenceAssetIds: [], activeReferenceAssetId: null, voice: { voiceId: null, description: "", performance: {} }, states: [] },
    { characterId: "c", name: "C", tier: "formal", profile: {}, referenceAssetIds: [], activeReferenceAssetId: null, voice: { voiceId: null, description: "", performance: {} }, states: [] },
    { characterId: "a", name: "A", tier: "formal", profile: {}, referenceAssetIds: [], activeReferenceAssetId: null, voice: { voiceId: null, description: "", performance: {} }, states: [] },
    { characterId: "b|c", name: "B|C", tier: "formal", profile: {}, referenceAssetIds: [], activeReferenceAssetId: null, voice: { voiceId: null, description: "", performance: {} }, states: [] },
  );
  assert.ok(cd.addRelationship(prod, "a|b", "c"));
  assert.ok(cd.addRelationship(prod, "a", "b|c")); // must NOT be seen as a duplicate pair
  assert.equal(prod.relationships.length, 2);
});

test("impact: the AI semantic verdict is reported as UNAVAILABLE, never faked", () => {
  const { story, prod } = upstreamProject();
  const im = cd.episodeImpact(prod, prod.episodes[0].episodeId, story);
  assert.equal(im.semantic.available, false);
  assert.ok(im.semantic.reason.includes("ADR"));
  // there is no verdict field that could be mistaken for a judgement
  assert.ok(!("verdict" in im.semantic));
  assert.ok(!("affected" in im.semantic));
  assert.equal(cd.episodeImpact(prod, "ep-gone", story), null);
});

test("baseline: a NEW episode may be stamped at confirmation; a pre-existing one may not", () => {
  // Mirrors ctx.story.confirmPlan's rule (app.js): the confirmation records a
  // baseline ONLY where it is provable — for the episodes it just created, and
  // for the pristine default it adopts. An episode that already carried content
  // keeps its own (unrecorded) baseline: stamping it would be the guess
  // requirement 4 forbids.
  const { story, prod } = upstreamProject();

  // a pre-existing episode WITH content
  const older = pd.addEpisode(prod, "早就存在的一集");
  pd.addScene(prod, older.episodeId, "第一场");
  cd.setEpisodeTextBeats(prod, older.episodeId, "plot", ["旧内容"]);

  // …and one the confirmation creates now
  const fresh = pd.addEpisode(prod, "刚建立的一集");
  cd.stampEpisodeUpstream(prod, fresh.episodeId, story); // what confirmPlan does

  assert.equal(cd.episodeImpact(prod, fresh.episodeId, story).state, "current");
  assert.equal(cd.episodeImpact(prod, fresh.episodeId, story).baselineRecorded, true);
  // the pre-existing one is untouched → still honestly unknown
  const oldIm = cd.episodeImpact(prod, older.episodeId, story);
  assert.equal(oldIm.state, "unknown");
  assert.equal(oldIm.count, 0);
  assert.deepEqual(older.basedOn, { brief: 0, outline: 0, characters: 0, relationships: 0, world: 0 });
});

test("baseline: an episode carrying beats is NOT pristine (so it is not adopted/stamped)", () => {
  // the pristine test in ctx.story.confirmPlan must treat recorded beats as
  // real content, else adopting the episode would both retitle the creator's
  // work and stamp a baseline its beats never saw
  const prod = pd.createProduction(null);
  const ep = prod.episodes[0];
  const beatsEmpty = (e) => !Object.values(e.beats).some((x) => x.length);
  assert.equal(beatsEmpty(ep), true); // a fresh default episode IS pristine
  const c = bd.addCharacter(prod, "林照");
  cd.setEpisodeCharacterBeat(prod, ep.episodeId, c.characterId, "做出选择");
  assert.equal(beatsEmpty(ep), false); // …and stops being so once a beat exists
});

test("the dependency mechanism is ONE mechanism (same keys everywhere)", () => {
  assert.deepEqual(cd.UPSTREAM_KEYS, ["brief", "outline", "characters", "relationships", "world"]);
  const prod = pd.createProduction(null);
  const story = st.createStory(null);
  assert.deepEqual(Object.keys(cd.defaultBasedOn()).sort(), [...cd.UPSTREAM_KEYS].sort());
  assert.deepEqual(Object.keys(cd.upstreamVersions(story, prod)).sort(), [...cd.UPSTREAM_KEYS].sort());
  assert.deepEqual(Object.keys(prod.episodes[0].basedOn).sort(), [...cd.UPSTREAM_KEYS].sort());
  for (const k of cd.UPSTREAM_KEYS) {
    assert.equal(typeof cd.UPSTREAM_LABEL[k], "string");
    assert.equal(typeof cd.UPSTREAM_GOTO[k], "string");
  }
});

/* ========================================================================= */
/* Character tiers: 正式 / 临时 + identity-preserving promotion              */
/* ========================================================================= */

test("tier: new characters default to formal; a bit part is explicit", () => {
  const prod = pd.createProduction(null);
  assert.equal(bd.addCharacter(prod, "林照").tier, "formal");
  assert.equal(bd.addCharacter(prod, "值班医生", "bit").tier, "bit");
  assert.equal(bd.addCharacter(prod, "怪值", "nonsense").tier, "formal"); // invalid → formal
  assert.deepEqual(bd.CHARACTER_TIERS, ["formal", "bit"]);
});

test("tier: promotion preserves the identity and EVERY reference", () => {
  const prod = pd.createProduction(null);
  const doctor = bd.addCharacter(prod, "值班医生", "bit");
  const lead = bd.addCharacter(prod, "林照");
  const scene = pd.addScene(prod, prod.episodes[0].episodeId, "急诊");
  bd.addSceneCharacter(prod, scene.sceneId, doctor.characterId, null);
  bd.addReferenceAsset(prod, doctor.characterId, "asset-1");
  const rel = cd.addRelationship(prod, doctor.characterId, lead.characterId);
  cd.setEpisodeCharacterBeat(prod, prod.episodes[0].episodeId, doctor.characterId, "揭示病历");

  assert.ok(bd.setCharacterTier(prod, doctor.characterId, "formal"));
  const after = bd.findCharacter(prod, doctor.characterId);
  assert.equal(after.characterId, doctor.characterId); // SAME identity
  assert.equal(after.tier, "formal");
  assert.deepEqual(after.referenceAssetIds, ["asset-1"]);
  assert.equal(bd.scenesReferencingCharacter(prod, doctor.characterId).length, 1);
  assert.equal(cd.relationshipBetween(prod, doctor.characterId, lead.characterId).relationshipId, rel.relationshipId);
  assert.equal(cd.episodesWithCharacterBeat(prod, doctor.characterId).length, 1);
  // and back down, equally non-destructive
  assert.ok(bd.setCharacterTier(prod, doctor.characterId, "bit"));
  assert.equal(bd.findCharacter(prod, doctor.characterId).referenceAssetIds.length, 1);
  assert.equal(bd.setCharacterTier(prod, doctor.characterId, "nonsense"), false);
  assert.equal(bd.setCharacterTier(prod, "char-gone", "formal"), false);
});

test("character: the creative layer is canonical and NOT state-overridable", () => {
  const prod = pd.createProduction(null);
  const c = bd.addCharacter(prod, "林照");
  for (const k of bd.CHARACTER_CREATIVE_FACETS) assert.equal(c.profile[k], "");
  assert.ok(bd.updateCharacterProfile(prod, c.characterId, {
    identity: "酒吧女招待", desire: "拿回自己的记忆", weakness: "无法主动回忆",
    coreConflict: "真相与自我保全彻底对立", arc: "被动听讲述 → 主动追查 → 说出真相",
  }));
  assert.equal(c.profile.arc, "被动听讲述 → 主动追查 → 说出真相");
  // 关键关系摘要 is DERIVED, never stored on the character
  assert.ok(!("relationships" in c.profile));
  // a state may override presentation, never who the character IS
  const s = bd.addCharacterState(prod, c.characterId, "三年前");
  bd.setCharacterStateOverrides(prod, c.characterId, s.stateId, {
    appearance: "长发", identity: "试图改写身份", arc: "试图改写 Arc",
  });
  assert.equal(s.overrides.appearance, "长发");
  for (const k of bd.CHARACTER_CREATIVE_FACETS) assert.ok(!(k in s.overrides), `${k} must not be overridable`);
  // the resolver therefore always reports the BASE creative layer
  const r = bd.resolveCharacter(c, s.stateId);
  assert.equal(r.appearance, "长发");
  assert.equal(r.personality, c.profile.personality);
});

test("character: a v9 profile hydrates with EMPTY creative facets, never invented", () => {
  const prod = pd.createProduction(null);
  bd.addCharacter(prod, "林照");
  const saved = pd.serialize(prod);
  saved.characters[0].profile = { appearance: "短发", costume: "", personality: "克制、警觉", visualInstruction: "" };
  const hydrated = pd.createProduction(saved);
  assert.equal(hydrated.characters[0].profile.personality, "克制、警觉");
  for (const k of bd.CHARACTER_CREATIVE_FACETS) {
    assert.equal(hydrated.characters[0].profile[k], "", `${k} must hydrate empty, not derived from 性格`);
  }
});

test("tier: an existing character with no tier hydrates as FORMAL", () => {
  const prod = pd.createProduction(null);
  bd.addCharacter(prod, "林照");
  const saved = pd.serialize(prod);
  delete saved.characters[0].tier;
  assert.equal(pd.createProduction(saved).characters[0].tier, "formal");
  saved.characters[0].tier = "junk";
  assert.equal(pd.createProduction(saved).characters[0].tier, "formal");
});

/* ========================================================================= */
/* v9 → v10 migration                                                        */
/* ========================================================================= */

/** A well-formed v9 document with real creative content. */
function v9Doc() {
  return {
    v: 9,
    project: "p",
    story: {
      idea: "深夜酒吧",
      versions: [{
        id: "so-1", v: 1,
        outline: {
          premise: "前提", logline: "主线", genreTone: "悬疑", world: "都市",
          centralConflict: "冲突", storyArc: "弧", ending: "结局", durationNote: "60 秒",
          characterConcepts: ["林照"], episodeCount: 4,
        },
        origin: "developed", instruction: "", basedOn: null,
      }],
      active: 1, approved: 1,
      plans: [{
        id: "plan-1", v: 1, origin: "proposed", instruction: "", outlineVersionId: "so-1",
        episodes: [{
          epNumber: 1, title: "迷雾入城", synopsis: "梗概", purpose: "建立",
          hook: "钩子", endingBeat: "结尾拍", duration: "60 秒", episodeId: "ep-1",
        }],
      }],
      activePlan: 1, confirmedPlan: 1,
    },
    scripts: {},
    assets: { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [] },
    generations: [],
    production: {
      activeEpisodeId: "ep-1",
      episodes: [{
        episodeId: "ep-1", title: "EP01 迷雾入城", bgmAssetId: null,
        scenes: [{
          sceneId: "sc-1", title: "酒吧", shotIds: [],
          characterRefs: [{ characterId: "char-1", stateId: null }],
          locationRef: { locationId: "loc-1", stateId: null },
          ambienceAssetId: null, bgmAssetId: null,
        }],
      }],
      characters: [{
        characterId: "char-1", name: "林照",
        profile: { appearance: "", costume: "", personality: "", visualInstruction: "" },
        referenceAssetIds: [], activeReferenceAssetId: null,
        voice: { voiceId: null, description: "", performance: {} }, states: [],
      }],
      locations: [{
        locationId: "loc-1", name: "暗夜酒吧",
        profile: { description: "", visualInstruction: "" },
        referenceAssetIds: [], activeReferenceAssetId: null, states: [],
      }],
    },
    timelines: {},
    nodes: [{ id: "n1", type: "script", x: 0, y: 0 }],
    edges: [],
    pan: { x: 0, y: 0 },
  };
}

test("v9→v10 is purely additive and mints NO version the creator did not make", () => {
  const input = v9Doc();
  const snapshot = structuredClone(input);
  const res = migrateToCurrent(input);
  assert.equal(res.status, "ok");
  assert.deepEqual(input, snapshot); // the caller's object is never mutated
  const d = res.doc;
  // the chain now runs past v10 (CP2 adds v11) — what this test pins is that the
  // v10 STEP invents no creative content, so it reads the fields, not the marker
  assert.equal(d.v, CANVAS_SCHEMA_VERSION);
  // the Creative Brief: an EMPTY working draft, ZERO revisions
  assert.deepEqual(d.story.brief, {
    draft: { genre: "", tone: "", form: "", episodeDuration: "", totalDuration: "", notes: "", targetEpisodes: null },
    versions: [],
    active: 0,
  });
  // the idea stays exactly where it was — never copied into the brief
  assert.equal(d.story.idea, "深夜酒吧");
  // canon is EMPTY: relationships are never derived from co-appearance, and the
  // World Setting is never seeded from the outline's own `world` prose
  assert.deepEqual(d.production.relationships, []);
  assert.deepEqual(d.production.world, {
    era: "", rules: "", society: "", regions: "", places: "", visualTone: "", atmosphere: "",
  });
  assert.notEqual(d.production.world.society, d.story.versions[0].outline.world);
  assert.deepEqual(d.production.canon, { characters: 0, relationships: 0, world: 0 });
  // an existing character is FORMAL and gains EMPTY creative facets — never
  // sliced out of its existing 性格 prose
  assert.equal(d.production.characters[0].tier, "formal");
  for (const k of ["identity", "desire", "weakness", "coreConflict", "arc"]) {
    assert.equal(d.production.characters[0].profile[k], "");
  }
  // the episode gains empty beats and an ALL-ZERO stamp (never "current")
  assert.deepEqual(d.production.episodes[0].beats, { plot: [], character: [], relationship: [], world: [] });
  assert.deepEqual(d.production.episodes[0].basedOn, {
    brief: 0, outline: 0, characters: 0, relationships: 0, world: 0,
  });
  // the outline gains an empty climax, NOT a slice of the storyArc prose
  assert.equal(d.production.episodes[0].title, "EP01 迷雾入城"); // untouched
  assert.equal(d.story.versions[0].outline.climax, "");
  assert.equal(d.story.versions[0].outline.storyArc, "弧");
  // everything else survives verbatim
  assert.deepEqual(d.story.plans, snapshot.story.plans);
  assert.deepEqual(d.production.locations, snapshot.production.locations);
  assert.deepEqual(d.nodes, snapshot.nodes);
  // deterministic
  assert.deepEqual(migrateToCurrent(v9Doc()).doc, migrateToCurrent(v9Doc()).doc);
});

test("v9→v10 replaces hand-crafted junk under the fields born at v10", () => {
  const doc = v9Doc();
  doc.story.brief = { versions: [{ id: "x" }], active: 7 };
  doc.production.relationships = "junk";
  doc.production.canon = { characters: -5 };
  doc.production.characters[0].tier = "bit";
  doc.production.episodes[0].beats = { plot: "junk" };
  const res = migrateToCurrent(doc);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.doc.story.brief.versions, []);
  assert.equal(res.doc.story.brief.active, 0);
  assert.deepEqual(res.doc.production.relationships, []);
  assert.deepEqual(res.doc.production.canon, { characters: 0, relationships: 0, world: 0 });
  assert.equal(res.doc.production.characters[0].tier, "formal");
  assert.deepEqual(res.doc.production.episodes[0].beats.plot, []);
});

test("a fresh v1 save reaches v10 with empty upstream canon", () => {
  const v1 = { v: 1, project: "p", scriptDoc: null, nodes: [{ id: "n1", type: "script", x: 0, y: 0 }], edges: [], pan: { x: 0, y: 0 } };
  const res = migrateToCurrent(v1);
  assert.equal(res.status, "ok");
  assert.equal(res.doc.v, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(res.doc.production.relationships, []);
  assert.equal(res.doc.story.brief.active, 0);
  assert.equal(typeof MIGRATIONS[9], "function");
});

/* ========================================================================= */
/* v10 validation                                                            */
/* ========================================================================= */

/** A well-formed v10 document with real upstream canon. */
function v10Doc() {
  const doc = migrateToCurrent(v9Doc()).doc;
  doc.story.brief = {
    draft: { genre: "悬疑", tone: "冷峻", form: "竖屏", episodeDuration: "60 秒", totalDuration: "12 分钟", notes: "", targetEpisodes: 12 },
    versions: [{
      id: "cb-1", v: 1, idea: "深夜酒吧",
      fields: { genre: "悬疑", tone: "冷峻", form: "竖屏", episodeDuration: "60 秒", totalDuration: "12 分钟", notes: "", targetEpisodes: 12 },
      origin: "manual", instruction: "",
    }],
    active: 1,
  };
  doc.story.versions[0].briefVersionId = "cb-1";
  doc.production.characters.push({
    characterId: "char-2", name: "沈既白", tier: "bit",
    profile: {
      appearance: "", costume: "", personality: "", visualInstruction: "",
      identity: "", desire: "", weakness: "", coreConflict: "", arc: "",
    },
    referenceAssetIds: [], activeReferenceAssetId: null,
    voice: { voiceId: null, description: "", performance: {} }, states: [],
  });
  doc.production.relationships = [{
    relationshipId: "rel-1", characterIds: ["char-1", "char-2"],
    profile: {
      basis: "搭档", aToB: "", bToA: "", coreConflict: "背叛", tension: "", power: "",
      history: "", secrets: "", direction: "", arc: "戒备 → 合作", forbidden: "",
    },
  }];
  doc.production.world = {
    era: "2019 年冬", rules: "录音即证据", society: "", regions: "", places: "", visualTone: "冷蓝", atmosphere: "",
  };
  doc.production.canon = { characters: 1, relationships: 1, world: 2 };
  doc.production.episodes[0].beats = {
    plot: ["找到录音"],
    character: [{ characterId: "char-1", beat: "第一次说谎" }],
    relationship: [{ relationshipId: "rel-1", start: "利益合作", event: "承担风险", end: "有限信任" }],
    world: ["录音可以作为证据"],
  };
  doc.production.episodes[0].basedOn = { brief: 1, outline: 1, characters: 1, relationships: 1, world: 1 };
  return doc;
}

test("a well-formed v10 document validates ok", () => {
  assert.equal(validateCanvasDoc(v10Doc()), null);
  assert.equal(migrateToCurrent(v10Doc()).status, "ok");
});

test("v10 validation rejects upstream-canon corruption, case by case", () => {
  const cases = [
    // --- Creative Brief ---
    [(d) => delete d.story.brief, "missing brief"],
    [(d) => (d.story.brief.draft = null), "draft not an object"],
    [(d) => delete d.story.brief.draft.genre, "draft field missing"],
    [(d) => (d.story.brief.draft.targetEpisodes = 0), "target out of range"],
    [(d) => (d.story.brief.draft.targetEpisodes = 51), "target above the cap"],
    [(d) => (d.story.brief.versions[0].v = 3), "non-dense revision"],
    [(d) => delete d.story.brief.versions[0].id, "revision with no id"],
    [(d) => d.story.brief.versions.push({ ...d.story.brief.versions[0] }), "duplicate revision id"],
    [(d) => delete d.story.brief.versions[0].idea, "revision without its idea snapshot"],
    [(d) => (d.story.brief.versions[0].origin = "hallucinated"), "invalid origin"],
    [(d) => (d.story.brief.active = 9), "active pointer with no revision"],
    [(d) => (d.story.versions[0].briefVersionId = "cb-gone"), "outline links a missing brief"],
    [(d) => (d.story.versions[0].briefVersionId = 7), "non-string brief link"],
    [(d) => delete d.story.versions[0].outline.climax, "outline without climax at v10"],
    // --- relationships ---
    [(d) => delete d.production.relationships, "relationships missing"],
    [(d) => (d.production.relationships[0].characterIds = ["char-1"]), "not two characters"],
    [(d) => (d.production.relationships[0].characterIds = ["char-1", "char-1"]), "self-relationship"],
    [(d) => (d.production.relationships[0].characterIds = ["char-1", "char-gone"]), "unknown character"],
    [(d) => d.production.relationships.push({ ...structuredClone(d.production.relationships[0]), relationshipId: "rel-2" }), "duplicate pair"],
    [(d) => d.production.relationships.push(structuredClone(d.production.relationships[0])), "duplicate relationshipId"],
    [(d) => delete d.production.relationships[0].profile.arc, "profile facet missing"],
    // --- world / canon ---
    [(d) => delete d.production.world, "world missing"],
    [(d) => delete d.production.world.rules, "world facet missing"],
    [(d) => delete d.production.canon, "canon missing"],
    [(d) => (d.production.canon.world = -1), "negative revision"],
    [(d) => (d.production.canon.world = 1.5), "non-integer revision"],
    // --- character tier ---
    [(d) => (d.production.characters[0].tier = "hero"), "invalid tier"],
    [(d) => delete d.production.characters[0].tier, "tier missing"],
    // --- episode beats / stamp ---
    [(d) => delete d.production.episodes[0].beats, "beats missing"],
    [(d) => (d.production.episodes[0].beats.plot = "junk"), "plot not an array"],
    [(d) => d.production.episodes[0].beats.plot.push(7), "non-string plot beat"],
    [(d) => (d.production.episodes[0].beats.character[0].characterId = "char-gone"), "beat on a missing character"],
    [(d) => d.production.episodes[0].beats.character.push({ characterId: "char-1", beat: "x" }), "two beats for one character"],
    [(d) => (d.production.episodes[0].beats.relationship[0].relationshipId = "rel-gone"), "beat on a missing relationship"],
    [(d) => d.production.episodes[0].beats.relationship.push({ relationshipId: "rel-1", start: "", event: "", end: "" }), "two beats for one relationship"],
    [(d) => delete d.production.episodes[0].beats.relationship[0].end, "relationship beat missing a field"],
    [(d) => delete d.production.episodes[0].basedOn, "stamp missing"],
    [(d) => (d.production.episodes[0].basedOn.world = -1), "negative stamp"],
    [(d) => delete d.production.episodes[0].basedOn.brief, "stamp key missing"],
  ];
  for (const [mutate, label] of cases) {
    const doc = v10Doc();
    mutate(doc);
    assert.ok(validateCanvasDoc(doc), `expected rejection: ${label}`);
  }
});

test("v10 accepts a legitimately EMPTY upstream (nothing confirmed yet)", () => {
  const doc = migrateToCurrent(v9Doc()).doc;
  assert.equal(validateCanvasDoc(doc), null);
  // an outline with no brief link is legal — it predates the brief chain
  assert.equal(doc.story.versions[0].briefVersionId, undefined);
});

/* ========================================================================= */
/* View models                                                               */
/* ========================================================================= */

/** The prodData snapshot shape the workspaces read. */
function snap(prod, extra = {}) {
  return {
    production: prod, assetUploads: {}, media: { video: {}, audio: {} }, firstFrames: {},
    finals: [], paidOps: {}, generations: [], draftShots: null, assets: { finals: [] },
    timelines: {}, ...extra,
  };
}

test("brief: 创建版本 is offered as soon as the draft differs (fresh project incl.)", () => {
  // regression: the button only renders when the model is dirty, so an edit
  // handler that persists WITHOUT re-rendering left a brand-new project unable
  // to create v1 at all until an unrelated redraw.
  const story = st.createStory(null);
  const has = () => renderBriefWs(fakeBriefCtx(story), { briefBuffer: {} }).includes("data-cb-commit");
  assert.equal(has(), false); // nothing written yet → nothing to version
  st.setIdea(story, "深夜酒吧"); // the very first thing a creator types
  assert.equal(st.briefIsDirty(story), true);
  assert.equal(has(), true, "v1 must be creatable on a fresh project");
  assert.ok(renderBriefWs(fakeBriefCtx(story), { briefBuffer: {} }).includes("创建版本 v1"));
  st.commitBrief(story);
  assert.equal(has(), false); // draft now matches v1 → the offer withdraws
  st.editBriefDraft(story, { genre: "都市悬疑" });
  assert.equal(has(), true); // …and returns on the next real change
  assert.ok(renderBriefWs(fakeBriefCtx(story), { briefBuffer: {} }).includes("创建版本 v2"));
});

/** Minimal ctx for the brief workspace. */
function fakeBriefCtx(story) {
  return {
    story: {
      doc: () => story,
      activeBrief: () => st.activeBrief(story),
      briefIsDirty: () => st.briefIsDirty(story),
    },
    toast: () => {},
  };
}

test("briefModel: reports the draft, the revision and the dirty standing", () => {
  const doc = st.createStory(null);
  st.setIdea(doc, "创意");
  st.editBriefDraft(doc, { genre: "悬疑" });
  let m = briefModel(doc, st.briefIsDirty(doc));
  assert.equal(m.hasIdea, true);
  assert.equal(m.active, null);
  assert.equal(m.dirty, true);
  assert.equal(m.versionCount, 0);
  st.commitBrief(doc);
  m = briefModel(doc, st.briefIsDirty(doc));
  assert.equal(m.active.v, 1);
  assert.equal(m.dirty, false);
  assert.deepEqual(m.versions, [{ v: 1, id: m.active.id, origin: "manual", isActive: true }]);
});

test("relationshipsModel: pairs, completeness and the episodes that advance it", () => {
  const { prod, chars } = prodWithChars(["林照", "沈既白", "医生"]);
  const rec = cd.addRelationship(prod, chars[0].characterId, chars[1].characterId);
  cd.updateRelationship(prod, rec.relationshipId, { basis: "搭档", arc: "戒备 → 合作" });
  cd.setEpisodeRelationshipBeat(prod, prod.episodes[0].episodeId, rec.relationshipId, {
    start: "利益合作", event: "承担风险", end: "有限信任",
  });
  const m = relationshipsModel(snap(prod));
  assert.equal(m.empty, false);
  assert.equal(m.items.length, 1);
  const it = m.items[0];
  assert.equal(it.a.name, "林照");
  assert.equal(it.b.name, "沈既白");
  assert.equal(it.filled, 2);
  assert.equal(it.total, cd.RELATIONSHIP_FIELDS.length);
  assert.deepEqual(it.beats.map((b) => b.code), ["EP01"]);
  // remaining undefined pairs are offered, the defined one is not
  assert.equal(m.pairs.length, 2);
  assert.ok(!m.pairs.some((p) => p.label === "林照 × 沈既白"));
  assert.equal(relationshipsModel(snap(null)).empty, true);
});

test("worldModel: fill standing + the separate Location domain count", () => {
  const prod = pd.createProduction(null);
  bd.addLocation(prod, "暗夜酒吧");
  cd.updateWorld(prod, { era: "2019", rules: "录音即证据" });
  const m = worldModel(snap(prod));
  assert.equal(m.filled, 2);
  assert.equal(m.total, cd.WORLD_FIELDS.length);
  assert.equal(m.revision, 0);
  assert.equal(m.locationCount, 1);
  cd.confirmCanon(prod, "world");
  assert.equal(worldModel(snap(prod)).revision, 1);
});

test("episodePlanModel: plan facets, resolved beats and the impact per episode", () => {
  const { story, prod, a, b } = upstreamProject();
  const ep = prod.episodes[0];
  const rel = prod.relationships[0];
  cd.setEpisodeTextBeats(prod, ep.episodeId, "plot", ["找到录音"]);
  cd.setEpisodeCharacterBeat(prod, ep.episodeId, a.characterId, "第一次说谎");
  cd.setEpisodeRelationshipBeat(prod, ep.episodeId, rel.relationshipId, { start: "戒备", event: "合作", end: "信任" });
  cd.setEpisodeTextBeats(prod, ep.episodeId, "world", ["录音可作证据"]);
  cd.stampEpisodeUpstream(prod, ep.episodeId, story);
  cd.confirmCanon(prod, "world"); // world v2 → this episode is now behind

  const m = episodePlanModel(snap(prod), story, (id) => cd.episodeImpact(prod, id, story));
  assert.equal(m.episodes.length, 1);
  const e = m.episodes[0];
  assert.equal(e.code, "EP01");
  assert.equal(e.beatCount, 4);
  assert.equal(e.beats.character[0].name, a.name);
  assert.equal(e.beats.relationship[0].label, `${a.name} × ${b.name}`);
  assert.equal(e.impact.count, 1);
  assert.deepEqual(e.impact.stale.map((s) => s.key), ["world"]);
  // no confirmed plan in this fixture → the plan facets are honestly absent
  assert.equal(e.plan, null);
  assert.equal(m.planVersion, 0);
  assert.equal(episodePlanModel(snap(null), story, null).empty, true);
});

test("canonModel: what the Director reads, and what it cannot yet judge", () => {
  const { story, prod } = upstreamProject();
  const ep = prod.episodes[0];
  cd.setEpisodeTextBeats(prod, ep.episodeId, "plot", ["找到录音"]);
  cd.stampEpisodeUpstream(prod, ep.episodeId, story);
  let m = canonModel({ story, pd: snap(prod) });
  assert.deepEqual(m.versions, { brief: 1, outline: 1, characters: 1, relationships: 1, world: 1 });
  assert.deepEqual(m.stale, []);
  const reads = new Map(m.reads.map((r) => [r.k, r]));
  assert.equal(reads.get("创意 Brief").v, "v1");
  assert.equal(reads.get("人物关系").ok, true);
  assert.equal(reads.get("世界规则").ok, true);
  assert.equal(reads.get("已发生的剧集事实").v, "1 条 beat");
  // the supervising checks are LISTED as unavailable, not stubbed
  assert.ok(m.capabilities.length >= 3);

  cd.confirmCanon(prod, "world");
  m = canonModel({ story, pd: snap(prod) });
  assert.equal(m.stale.length, 1);
  assert.equal(m.stale[0].code, "EP01");
  assert.equal(m.stale[0].count, 1);
  assert.deepEqual(m.stale[0].surfaces, ["世界观（已更新）"]);
});

test("director: the upstream modules get real, justified observations", () => {
  const { story, prod } = upstreamProject();
  const doc = sd.createDoc();
  const base = { doc, pd: snap(prod), shotId: null };
  // every upstream module answers with a NOTE grounded in state
  for (const module of ["brief", "story", "relationships", "world", "episodes", "characters"]) {
    const note = directorNote({ ...base, module, story });
    assert.equal(typeof note, "string");
    assert.ok(note.length > 8, `${module} note too thin`);
  }
  // a genuinely empty world is called out as empty
  const emptyProd = pd.createProduction(null);
  assert.match(
    directorNote({ ...base, pd: snap(emptyProd), module: "world", story: st.createStory(null) }),
    /世界观还是空的/,
  );
  // …and one character is not enough for a relationship
  assert.match(
    directorNote({ ...base, pd: snap(emptyProd), module: "relationships", story }),
    /两个人物/,
  );
});

test("director surfaces the CANON section while working upstream", () => {
  const plan = { next: { label: "写本集剧本" } };
  const inbox = { pending: 2 };
  const upstream = { isUpstream: true, stale: [] };
  assert.equal(surfacedSection({ plan, inbox, currentBlocked: false, upstream, module: "brief" }), "canon");
  // a blocked shot still outranks everything — it is why work has stopped
  assert.equal(surfacedSection({ plan, inbox, currentBlocked: true, upstream, module: "brief" }), "plan");
  // downstream, the existing priority is unchanged
  assert.equal(
    surfacedSection({ plan, inbox, currentBlocked: false, upstream: { isUpstream: false, stale: [] }, module: "frames" }),
    "inbox",
  );
});

/* ========================================================================= */
/* The demo fixture must stay v10-valid                                      */
/* ========================================================================= */

test("the demo seed produces a document that VALIDATES at the current schema", async () => {
  const { seedDemoProject } = await import("../fixtures/demo-project.js");
  const assetlib = await import("../src/workflow/assetlib.js");
  const genlib = await import("../src/workflow/genlib.js");
  const tl = await import("../src/workflow/timeline.js");

  const story = st.createStory(null);
  const production = pd.createProduction(null);
  const scripts = Object.create(null);
  const assets = assetlib.createRegistry(null);
  const generations = genlib.createGenerationRegistry(null);
  const timelines = tl.createTimelines(null);
  seedDemoProject({ story, production, scripts, assets, generations, timelines });

  // exactly the shape app.js serializeGraph() persists
  const scriptsOut = Object.create(null);
  for (const k of Object.keys(scripts)) scriptsOut[k] = sd.serialize(scripts[k]);
  // layered over a migrated base so the document always satisfies the CURRENT
  // schema — the subject here is the demo seed's own content
  const base = migrateToCurrent({
    v: 1, project: "demo", scriptDoc: null,
    nodes: [{ id: "n1", type: "script", x: 0, y: 0 }], edges: [], pan: { x: 0, y: 0 },
  });
  assert.equal(base.status, "ok", base.detail);
  const doc = {
    ...base.doc,
    project: "demo",
    story: st.serialize(story),
    scripts: scriptsOut,
    assets,
    generations,
    production: pd.serialize(production),
    timelines: tl.serialize(timelines),
  };
  assert.equal(validateCanvasDoc(doc), null);

  // …and it actually EXERCISES the new upstream surfaces (a demo that skipped
  // them would let the fixture rot while still validating)
  assert.equal(story.brief.versions.length, 1); // one explicit commit, not one per edit
  assert.equal(story.brief.active, 1);
  assert.equal(st.briefIsDirty(story), false);
  assert.equal(st.briefForOutline(story, story.versions[0]).v, 1);
  assert.ok(production.relationships.length >= 2);
  assert.ok(production.world.rules.trim());
  assert.deepEqual(production.canon, { characters: 1, relationships: 1, world: 1 });
  const stamped = production.episodes.filter((e) => e.basedOn.outline > 0);
  assert.equal(stamped.length, 3);
  assert.ok(stamped[0].beats.plot.length);
  assert.ok(production.episodes.some((e) => e.beats.relationship.length));
  // the un-stamped later episodes stay honestly empty
  const rest = production.episodes.filter((e) => e.basedOn.outline === 0);
  assert.ok(rest.length);
  for (const e of rest) assert.deepEqual(e.beats.plot, []);
  // nothing is behind: the seed stamps against the versions it just confirmed
  for (const e of stamped) assert.equal(cd.episodeImpact(production, e.episodeId, story).count, 0);
});

/* ========================================================================= */
/* Information architecture                                                  */
/* ========================================================================= */

test("IA: Production's rail is upstream-only; episode stages sit under Episodes", () => {
  assert.deepEqual(NAV.map((g) => g.sec), ["作品开发"]);
  assert.deepEqual(NAV[0].items.map((i) => i[0]), [
    "brief", "story", "characters", "relationships", "world", "episodes",
  ]);
  // 分集规划 is the LAST upstream step — Production's exit
  assert.equal(NAV[0].items[NAV[0].items.length - 1][0], "episodes");
  // the four downstream stages the spec names are NOT in the project rail
  for (const k of ["frames", "video", "audio", "edit"]) {
    assert.ok(!NAV.some((g) => g.items.some((i) => i[0] === k)));
    assert.ok(EPISODE_MODULES.includes(k));
  }
  // the episode context contains these stages (a later checkpoint may add more)
  const epKeys = EPISODE_NAV.map((i) => i[0]);
  for (const k of ["script", "scenes", "shots", "frames", "video", "audio", "edit"]) {
    assert.ok(epKeys.includes(k), `episode context is missing ${k}`);
  }
  // every module the rail can open has a human label
  for (const [k] of [...NAV[0].items, ...EPISODE_NAV]) assert.equal(typeof MODULE_LABEL[k], "string");
});
