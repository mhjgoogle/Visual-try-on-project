// Unit tests for the Production module workspaces' pure view-models — the
// read-only lenses over existing workflow/node state (no ownership moved).
// Run via `node --test`, wrapped by tests/test_motv_production_view_e2e.py.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ideaModel,
  shotsModel,
  assetsModel,
  videoModel,
  audioModel,
  editModel,
  episodesModel,
  settingsModel,
  nextStateRefsOnAdd,
  renderSettings,
  renderEpisodes,
  renderFrames,
} from "../src/ui/workspaces.js";
import { navBadges, NAV } from "../src/ui/production.js";
import {
  EPISODE_NAV, EPISODE_MODULES, EPISODE_DEFAULT, EPISODE_WORKSPACES,
  ASSET_NAV, ASSET_FILTER_ALIAS, spaceOf, renderAssetRail, MODULE_LABEL,
  LEGACY_EPISODE_STAGES, LEGACY_EPISODE_CENTRE, PROJECT_SETTINGS, PAGES, PAGE_SECTIONS, resolveModule, NAV as NAV_PAGES,
} from "../src/ui/shell.js";
import * as sd from "../src/workflow/scriptdoc.js";

/** The default production structure a fresh project carries (M6/M7). */
function prodDefault() {
  return {
    activeEpisodeId: "ep-1",
    episodes: [{ episodeId: "ep-1", title: "第 1 集", scenes: [] }],
    characters: [],
    locations: [],
  };
}

/** Empty prodData snapshot (fresh project). */
function pdEmpty() {
  return {
    draftShots: null,
    lockedPlan: null,
    shotVersions: null,
    realShots: null,
    assetUploads: {},
    media: { video: {}, audio: {} },
    firstFrames: {},
    finals: [],
    paidOps: {},
    production: prodDefault(),
  };
}

/** Snapshot with a 2-shot draft and some media in versioned/legacy forms. */
function pdDraft() {
  const pd = pdEmpty();
  pd.draftShots = [
    { shotId: "shot-a", sequence: 1, title: "跪殿", description: "大殿中央", duration_seconds: 6, slot: "v1-1" },
    { shotId: "shot-b", sequence: 2, title: "逼诗", description: "皇帝俯视", duration_seconds: 10, slot: "v1-2" },
  ];
  pd.shotVersions = { count: 1, cur: 1, state: "done", rows: null };
  // shot 1 has an asset image (2 versions, current v2, paid) — shot 2 has none
  pd.assetUploads["v1-1"] = {
    current: 2,
    history: [
      { slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/u/a1.png" },
      { slot_id: "v1-1", origin: "paid-image", version: 2, digest: "d", url: "/u/a1_v2.png" },
    ],
  };
  // shot 1 video uploaded as a legacy plain-string slot; first-frame lineage
  // recorded for it; shot 2 has neither
  pd.media.video["v1-1"] = "/u/vid1.mp4";
  pd.firstFrames["v1-1"] = { slot_id: "v1-1", origin: "paid-image", version: 2, url: "/u/a1_v2.png" };
  // voice for shot 2 only + background music
  pd.media.audio["voice-v1-2"] = "/u/voice2.wav";
  pd.media.audio["music-main"] = "/u/music.mp3";
  return pd;
}

// --- 创意 --------------------------------------------------------------- //

test("ideaModel: brief + script standing + pending status", () => {
  const d = sd.createDoc();
  assert.deepEqual(ideaModel(d), {
    brief: "",
    hasScript: false,
    scriptVersions: 0,
    activeVersion: 0,
    pending: null,
  });
  sd.setBrief(d, "一句创意");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "一句创意"), "v1 正文");
  sd.beginGeneration(d, "revision", "改");
  const m = ideaModel(d);
  assert.equal(m.hasScript, true);
  assert.equal(m.scriptVersions, 1);
  assert.equal(m.pending, "generating");
});

// --- 分镜 --------------------------------------------------------------- //

test("shotsModel: empty project opens as empty state, not disabled", () => {
  const m = shotsModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.lock, null);
});

test("shotsModel: structured draft exposes index/title/description/duration", () => {
  const m = shotsModel(pdDraft());
  assert.equal(m.empty, false);
  assert.equal(m.kind, "draft");
  assert.deepEqual(m.shots[1], {
    seq: 2, title: "逼诗", description: "皇帝俯视", duration: 10, slot: "v1-2", unresolved: false,
    shotId: "shot-b", // M6: canonical identity exposed for scene-assignment display
  });
  assert.deepEqual(m.versions, { count: 1, cur: 1 });
});

test("shotsModel: falls back to display rows, then real records", () => {
  const pd = pdEmpty();
  pd.shotVersions = { count: 2, cur: 2, state: "done", rows: [["01", "跪殿(逆光)"]] };
  let m = shotsModel(pd);
  assert.equal(m.kind, "rows");
  assert.equal(m.shots[0].title, "跪殿(逆光)");
  assert.equal(m.shots[0].duration, null); // not available — not invented
  const pd2 = pdEmpty();
  pd2.realShots = [["01", "官方镜头记录（6s）"]];
  m = shotsModel(pd2);
  assert.equal(m.kind, "records");
  assert.equal(m.empty, false);
});

// --- 资产 --------------------------------------------------------------- //

test("assetsModel: per-shot slot standing with version chain metadata", () => {
  const m = assetsModel(pdDraft());
  assert.equal(m.done, 1);
  assert.equal(m.total, 2);
  assert.deepEqual(m.items[0], {
    seq: 1, title: "跪殿", slot: "v1-1", unresolved: false,
    url: "/u/a1_v2.png", versions: 2, current: 2, origin: "paid-image",
  });
  assert.equal(m.items[1].url, ""); // empty slot shows as missing, still listed
});

test("assetsModel: no shots → empty state", () => {
  const m = assetsModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.context, null); // truly nothing — no context to surface
});

test("media models surface existing real/row shots as context, never 'nothing'", () => {
  // connected mode: real locked records exist, but no canvas draft → media
  // slots can't attach; the models must still expose the shots' existence
  const pd = pdEmpty();
  pd.realShots = [["01", "官方镜头（6s）"], ["02", "官方镜头（10s）"]];
  for (const model of [assetsModel, videoModel, audioModel, editModel]) {
    const m = model(pd);
    assert.equal(m.empty, true, model.name);
    assert.deepEqual(m.context, { count: 2, kind: "records" }, model.name);
  }
  // demo mode: scriptgen display rows without a structured draft → same
  const pd2 = pdEmpty();
  pd2.shotVersions = { count: 1, cur: 1, state: "done", rows: [["01", "跪殿"]] };
  assert.deepEqual(videoModel(pd2).context, { count: 1, kind: "rows" });
  // an active draft never reports context (the full per-shot list renders)
  assert.equal(assetsModel(pdDraft()).context, undefined);
});

// --- 视频 --------------------------------------------------------------- //

test("videoModel: known first-frame lineage is exposed; absent stays unknown", () => {
  const m = videoModel(pdDraft());
  assert.equal(m.done, 1);
  const [s1, s2] = m.items;
  assert.equal(s1.url, "/u/vid1.mp4"); // legacy string slot readable as v1
  assert.equal(s1.versions, 1);
  assert.deepEqual(s1.firstFrame, { version: 2, origin: "paid-image", url: "/u/a1_v2.png" });
  assert.equal(s2.firstFrame, null); // never invented
  assert.equal(s2.url, "");
});

test("videoModel: LEGACY lock (no bridge) maps paid ops positionally, else shot-<seq>", () => {
  const pd = pdDraft();
  pd.paidOps = { "shot-1": { status: "held" } };
  assert.equal(videoModel(pd).items[0].opStatus, "held"); // no lock → shot-<seq>
  pd.lockedPlan = { plan_version: 2, shots: [{ shot_id: "shot-p2-1" }, { shot_id: "shot-p2-2" }] }; // no creativeShotId
  pd.paidOps = { "shot-p2-1": { status: "committed" } };
  const m = videoModel(pd);
  assert.equal(m.items[0].opStatus, "committed");
  assert.equal(m.items[1].opStatus, null);
  assert.equal(m.items[0].opUnresolved, false); // legacy positional fallback is allowed
});

// --- M4c: paid-op state joins by the creativeShotId ↔ server bridge -------- //

function pdBridged() {
  const pd = pdDraft(); // shot-a(跪殿)→v1-1, shot-b(逼诗)→v1-2
  // an M4c lock: each official record carries the creative identity
  pd.lockedPlan = {
    plan_version: 3,
    shots: [
      { shot_id: "shot-p3-1", creativeShotId: "shot-a", sequence: 1 },
      { shot_id: "shot-p3-2", creativeShotId: "shot-b", sequence: 2 },
    ],
  };
  pd.paidOps = { "shot-p3-1": { status: "committed" } }; // shot-a's op is committed
  return pd;
}

test("M4c: paid state follows the creative Shot after REORDER, not draft position", () => {
  const pd = pdBridged();
  pd.draftShots = [pd.draftShots[1], pd.draftShots[0]]; // reorder → [逼诗, 跪殿]
  const m = videoModel(pd);
  // shot-a(跪殿)'s committed op stays with 跪殿 wherever it now sits — NOT with
  // whatever shot is now at sequence 1
  assert.equal(m.items.find((x) => x.title === "跪殿").opStatus, "committed");
  assert.equal(m.items.find((x) => x.title === "逼诗").opStatus, null);
});

test("M4c: insert/delete does not shift paid state to a neighbor", () => {
  const pd = pdBridged();
  pd.draftShots = [{ shotId: "shot-new", sequence: 1, title: "新镜头", slot: "v2-1" }, ...pd.draftShots];
  const m = videoModel(pd);
  assert.equal(m.items.find((x) => x.title === "新镜头").opStatus, null); // no op for a new shot
  assert.equal(m.items.find((x) => x.title === "跪殿").opStatus, "committed"); // shot-a keeps its op
});

test("M4c: an unbridgeable shot is opUnresolved, never sequence-guessed", () => {
  const pd = pdBridged();
  // a draft shot whose creativeShotId isn't in the locked bridge
  pd.draftShots = [{ shotId: "shot-ghost", sequence: 1, title: "幽灵", slot: "v9-9" }];
  pd.paidOps = { "shot-p3-1": { status: "committed" } }; // would be grabbed if we guessed by seq
  const m = videoModel(pd);
  assert.equal(m.items[0].opStatus, null); // NOT the sequence-1 op
  assert.equal(m.items[0].opUnresolved, true);
});

test("M4c: a conflicting bridge (dup creativeShotId) resolves to unresolved", () => {
  const pd = pdBridged();
  pd.lockedPlan.shots = [
    { shot_id: "shot-p3-1", creativeShotId: "shot-a", sequence: 1 },
    { shot_id: "shot-p3-2", creativeShotId: "shot-a", sequence: 2 }, // conflict
  ];
  const m = videoModel(pd);
  for (const it of m.items) assert.equal(it.opUnresolved, true); // fail safe
});

test("M4c: an ALL-NULL bridge (server fail-safe) is unresolved, NEVER sequence fallback", () => {
  const pd = pdBridged();
  // the server nulled the bridge but kept the keys — must not sequence-guess
  pd.lockedPlan.shots = [
    { shot_id: "shot-p3-1", creativeShotId: null, sequence: 1 },
    { shot_id: "shot-p3-2", creativeShotId: null, sequence: 2 },
  ];
  pd.paidOps = { "shot-p3-1": { status: "committed" } }; // would be grabbed by seq fallback
  const m = videoModel(pd);
  for (const it of m.items) {
    assert.equal(it.opUnresolved, true);
    assert.equal(it.opStatus, null); // NOT the sequence-1 committed op
  }
});

// --- 音频 --------------------------------------------------------------- //

test("audioModel: voice per shot + music/sfx extras", () => {
  const m = audioModel(pdDraft());
  assert.equal(m.done, 1);
  assert.equal(m.items[0].url, ""); // shot 1 has no voice
  assert.equal(m.items[1].url, "/u/voice2.wav");
  const music = m.extras.find((x) => x.key === "music-main");
  assert.equal(music.url, "/u/music.mp3");
  assert.equal(m.extras.find((x) => x.key === "sfx-main").url, "");
});

// --- 剪辑 --------------------------------------------------------------- //

test("editModel: readiness per shot and composed finals", () => {
  const pd = pdDraft();
  pd.finals = ["/u/final_v1.mp4", "/u/final_v2.mp4"];
  const m = editModel(pd);
  assert.equal(m.ready, 1);
  assert.equal(m.total, 2);
  assert.deepEqual(m.items[0], { seq: 1, title: "跪殿", unresolved: false, video: true, voice: false });
  assert.deepEqual(m.items[1], { seq: 2, title: "逼诗", unresolved: false, video: false, voice: true });
  assert.equal(m.finals, 2);
  assert.equal(m.lastFinal, "/u/final_v2.mp4");
});

test("editModel: empty project still surfaces finals standing", () => {
  const m = editModel(pdEmpty());
  assert.equal(m.empty, true);
  assert.equal(m.finals, 0);
});

// --- M4b: media joins by canonical creativeShotId, not draft position ----- //

const titled = (items, title) => items.find((x) => x.title === title);

test("REORDER: media follows the creative Shot, not its draft position", () => {
  const pd = pdDraft(); // shot-a(跪殿)→v1-1 has image+video+frame; shot-b(逼诗)→v1-2 has voice
  pd.draftShots = [pd.draftShots[1], pd.draftShots[0]]; // reorder → [逼诗, 跪殿]
  // asset image stays with 跪殿 (shot-a) wherever it now sits
  const a = assetsModel(pd);
  assert.equal(titled(a.items, "跪殿").url, "/u/a1_v2.png");
  assert.equal(titled(a.items, "逼诗").url, ""); // shot-b never had an image
  // video + first frame stay with shot-a; voice stays with shot-b
  const v = videoModel(pd);
  assert.equal(titled(v.items, "跪殿").url, "/u/vid1.mp4");
  assert.ok(titled(v.items, "跪殿").firstFrame);
  assert.equal(titled(v.items, "逼诗").url, "");
  const au = audioModel(pd);
  assert.equal(titled(au.items, "逼诗").url, "/u/voice2.wav");
  assert.equal(titled(au.items, "跪殿").url, "");
});

test("INSERT: a new shot does not slide a neighbor's media", () => {
  const pd = pdDraft();
  pd.draftShots = [
    { shotId: "shot-new", sequence: 1, title: "新镜头", slot: "v2-1" }, // inserted, no media
    ...pd.draftShots,
  ];
  const a = assetsModel(pd);
  assert.equal(titled(a.items, "新镜头").url, ""); // new shot has no image
  assert.equal(titled(a.items, "跪殿").url, "/u/a1_v2.png"); // shot-a's image unmoved
});

test("DELETE: removing a shot does not slide a survivor's media", () => {
  const pd = pdDraft();
  pd.draftShots = [pd.draftShots[1]]; // delete shot-a(跪殿), keep shot-b(逼诗)
  const a = assetsModel(pd);
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].title, "逼诗");
  assert.equal(a.items[0].url, ""); // shot-b did NOT inherit shot-a's image
  const au = audioModel(pd);
  assert.equal(au.items[0].url, "/u/voice2.wav"); // shot-b keeps its own voice
});

test("AMBIGUOUS identity resolves to unresolved (unknown), never positional", () => {
  const pd = pdDraft();
  // two shots now claim slot v1-1 — the binding is unprovable
  pd.draftShots = [
    { shotId: "shot-a", sequence: 1, title: "跪殿", slot: "v1-1" },
    { shotId: "shot-x", sequence: 2, title: "冒名", slot: "v1-1" }, // dup slot
  ];
  const a = assetsModel(pd);
  for (const it of a.items) {
    assert.equal(it.unresolved, true); // both flagged unresolved
    assert.equal(it.url, ""); // neither silently grabs v1-1's image
  }
  assert.equal(a.done, 0);
});

test("LEGACY draft without creativeShotId falls back to its carried slot", () => {
  const pd = pdDraft();
  pd.draftShots = [{ sequence: 1, title: "旧镜头", slot: "v1-1" }]; // no shotId
  const a = assetsModel(pd);
  assert.equal(a.items[0].unresolved, false);
  assert.equal(a.items[0].url, "/u/a1_v2.png"); // legacy compat: uses the carried slot
});

// --- 导航徽标 ------------------------------------------------------------ //

test("navBadges: counts reflect state; empty modules still get a badge-less item", () => {
  const d = sd.createDoc();
  const empty = navBadges(d, pdEmpty());
  // asserted key by key: a later checkpoint may add a module (and therefore a
  // badge key), which is not what this test is about
  const expectEmpty = {
    // TASK-057 upstream surfaces: brief / characters / relationships / world
    brief: "", characters: "", relationships: "", world: "",
    story: "", settings: "", episodes: "1", // M6: real persisted episode count
    script: "草稿", scenes: "", shots: "", frames: "", video: "", audio: "", edit: "",
    storage: "", assets: "",
  };
  for (const [k, v] of Object.entries(expectEmpty)) {
    assert.equal(empty[k], v, `badge ${k}`);
  }
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1");
  // M9: the story badge reflects the OUTLINE standing, not the script brief
  const pdStory = pdDraft();
  pdStory.story = {
    ...storyDefault(),
    idea: "想法",
    versions: [{ id: "so-1", v: 1, outline: {}, origin: "developed", instruction: "", basedOn: null }],
    active: 1,
    approved: 1,
  };
  const b = navBadges(d, pdStory);
  assert.equal(b.story, "✓v1"); // approved outline
  pdStory.story.approved = 0;
  assert.equal(navBadges(d, pdStory).story, "v1"); // drafted, not approved
  pdStory.story.versions = [];
  pdStory.story.active = 0;
  assert.equal(navBadges(d, pdStory).story, "…"); // idea only
  assert.equal(b.script, "v1");
  assert.equal(b.shots, "2");
  assert.equal(b.frames, "1/2");
  assert.equal(b.video, "1/2");
  assert.equal(b.audio, "1/2");
  assert.equal(b.edit, "");
  // 作品设定 never fabricates a count — its domain is not persisted yet;
  // 剧集 counts the REAL persisted episodes (M6), and honestly shows nothing
  // when the production document is absent from the snapshot
  assert.equal(b.settings, "");
  assert.equal(b.episodes, "1");
  assert.equal(navBadges(d, { ...pdEmpty(), production: null }).episodes, "");
});

// --- M2.5 最终信息架构 ----------------------------------------------------- //

test("NAV: the rail is 故事开发 and it ENDS at the episode script (ADR-0061 决策 1)", () => {
  // ADR-0061 决策 1: the first space is 故事开发 — 把故事写出来 — and its end
  // point is每一集的 Episode Script. 创意 → 故事大纲 → 作品设定（人物 / 人物关系 /
  // 世界观）→ 分集规划 → 本集剧本.
  assert.deepEqual(NAV.map((g) => g.sec), ["故事开发"]);
  // TASK-065 §2 / §4 — a DELIBERATE contract change: TWO 作品设定 entries, not
  // three. 人物关系 is a TAB inside 人物 (a relationship connects two characters and
  // has no meaning without them) and 场景地 is a TAB inside 世界观 (a location is not
  // a person). Fewer entrances for the same subject is the whole point.
  // TASK-073 §1.1 went one step further: 人物 / 人物关系 / 世界观 are now three
  // SECTIONS of one page (③ 作品设定), so the rail carries five rows, not six. The
  // sub-heading disappeared with them — there is nothing left to group.
  assert.deepEqual(NAV[0].items.map((i) => i[0]), [
    "brief", "story", "settings", "episodes", "script",
  ]);
  assert.equal(NAV[0].items.filter((i) => i[3] && i[3].under).length, 0);
  // …and `characters` / `relationships` / `world` are NOT rail rows any more, while
  // still being working module keys: several existing jump targets use them, and
  // `setModule` routes each to its section of 作品设定. A jump target that resolves
  // to nothing would be a regression, not a migration.
  for (const k of ["characters", "relationships", "world"]) {
    assert.ok(!NAV.some((g) => g.items.some((i) => i[0] === k)), `${k} left the rail`);
    assert.equal(resolveModule(k).module, "settings", k);
  }
  assert.equal(MODULE_LABEL.relationships, "人物关系");
  assert.equal(spaceOf("relationships"), "story");
  // The MEDIA production stages left the story rail entirely: they belong to
  // 剧集制作, which is a top-level SPACE now rather than a sub-tree under an
  // episode row (TASK-064 §4).
  for (const k of ["scenes", "shots", "refplan", "frames", "video", "audio", "dailies", "edit", "workbench", "provenance"]) {
    assert.ok(!NAV.some((g) => g.items.some((i) => i[0] === k)), `${k} must not be in the story rail`);
  }
  // 剧集制作's centre is the 制作台 — the CURRENT SHOT's production graph (TASK-065
  // §9): it leads, and every stage workspace (生成溯源 included) stays reachable
  // behind the secondary 「工作区」 entry. Deliberately still NOT a second flow model
  // (流程画布).
  // TASK-073 §1.1 froze this space at FIVE pages. The eleven old stages are not
  // gone — they are sections of these five, reached through `resolveModule`, which
  // a dedicated test below checks key by key.
  const epKeys = EPISODE_NAV.map((i) => i[0]);
  assert.deepEqual(epKeys, ["board", "storyboard", "shotwork", "cutreview", "delivery"]);
  assert.equal(EPISODE_DEFAULT, "board", "the space opens on 本集看板");
  assert.equal(epKeys[0], EPISODE_DEFAULT);
  assert.ok(!epKeys.includes("canvas"), "流程画布 must not be on a creator path");
  // EPISODE_MODULES still spans the legacy keys, or a bookmark to one episode's
  // shots would report 故事开发 in the top bar
  for (const k of ["scenes", "shots", "refplan", "frames", "video", "audio", "dailies", "provenance", "edit", "episode", "workbench"]) {
    assert.ok(EPISODE_MODULES.includes(k), `${k} must still resolve inside 剧集制作`);
  }
  // the legacy 「工作区」 menu is derived from the LEGACY stage list minus its own
  // centre — kept working this round; TASK-074 removes the entrance
  assert.deepEqual(
    EPISODE_WORKSPACES.map((i) => i[0]),
    LEGACY_EPISODE_STAGES.map((i) => i[0]).filter((k) => k !== "workbench"),
  );
  // storage/assets left the rail: 资产库 is a top-level SPACE with its own rail
  // of media categories (TASK-064 §15), not a per-project rail item here
  assert.ok(!NAV.some((g) => g.items.some((i) => i[0] === "storage" || i[0] === "assets")));
});

test("spaceOf: every module belongs to exactly one space (ADR-0061 决策 1)", () => {
  // ONE function decides, so the top bar, the rail and the breadcrumb cannot
  // disagree about where the creator is.
  for (const k of ["brief", "story", "characters", "relationships", "world", "episodes", "script", "settings"]) {
    assert.equal(spaceOf(k), "story", k);
  }
  for (const k of EPISODE_MODULES) assert.equal(spaceOf(k), "episode", k);
  for (const k of ["assets", "assets:reference", "assets:image", "assets:video", "assets:audio", "assets:final", "assets:collection"]) {
    assert.equal(spaceOf(k), "assets", k);
  }
  // `storage` and `provenance` now land in ⚙ 项目设置 (TASK-073 §1.1), which belongs
  // to NO space — it reports 故事开发 only so the shell has a rail to draw
  assert.equal(spaceOf("storage"), "story");
  assert.equal(spaceOf(PROJECT_SETTINGS), "story");
  // an unknown module lands in 故事开发 rather than throwing: a navigation state
  // that cannot be placed must still render somewhere real
  assert.equal(spaceOf("nonesuch"), "story");
  assert.equal(spaceOf(null), "story");
});

test("TASK-073 §1.1 验收 #1: the IA is a CLOSED set — 三空间 / 十一页", () => {
  // ADR-0066 决策 10: 「新增 Skill 不得新增一级或二级页面」. That is only enforceable
  // if the count is asserted, so this is the enforcement.
  assert.equal(NAV_PAGES.length, 1, "故事开发 is one rail section");
  assert.deepEqual(NAV_PAGES[0].items.map((i) => i[0]),
    ["brief", "story", "settings", "episodes", "script"]);
  assert.equal(PAGES.length, 11, `expected eleven pages, got ${PAGES.join(" ")}`);
  // ⚙ 项目设置 is NOT one of the eleven — it is not a page of any space (§1.7)
  assert.ok(!PAGES.includes(PROJECT_SETTINGS));
  // every page with sections declares only sections it can actually render
  for (const [page, secs] of Object.entries(PAGE_SECTIONS)) {
    assert.ok(secs.length >= 1, `${page} declares no section`);
    assert.equal(new Set(secs).size, secs.length, `${page} lists a section twice`);
  }
  // ⑧ 镜头制作's sections ARE the four steps of §1.3, in order
  assert.deepEqual(PAGE_SECTIONS.shotwork, ["prepare", "image", "video", "pick"]);
});

test("TASK-073 §1.1 验收 #2 + #12: every OLD key resolves to a real page + section", () => {
  // 「落到一个没有该内容的页面」 and 「落空」 are the same failure (ADR-0063 决策 1),
  // so each key must name a page AND a section that page really declares.
  const expected = {
    characters: ["settings", "characters"],
    relationships: ["settings", "relationships"],
    world: ["settings", "world"],
    episode: ["board", "overview"],
    scenes: ["storyboard", "scenes"],
    shots: ["storyboard", "shots"],
    // dispatched by WHAT THEY DID, not to the nearest-looking page
    refplan: ["shotwork", "prepare"],
    frames: ["shotwork", "image"],
    video: ["shotwork", "video"],
    dailies: ["shotwork", "pick"],
    audio: ["delivery", "voice"],
    edit: ["delivery", "timeline"],
    storage: [PROJECT_SETTINGS, "storage"],
  };
  for (const [key, [page, section]] of Object.entries(expected)) {
    const hit = resolveModule(key);
    assert.equal(hit.resolved, true, `${key} did not resolve`);
    assert.equal(hit.module, page, `${key} landed on ${hit.module}`);
    assert.equal(hit.section, section, `${key} opened section ${hit.section}`);
    assert.ok(
      PAGE_SECTIONS[page].includes(section),
      `${key} names section ${section}, which ${page} does not render`,
    );
  }
  // the seven asset rows became PRESET FILTERS on the single ⑪ 资产库 page
  for (const [key, filter] of Object.entries({
    "assets:reference": "reference", "assets:image": "image", "assets:video": "video",
    "assets:audio": "audio", "assets:final": "final", "assets:collection": "collection",
  })) {
    const hit = resolveModule(key);
    assert.equal(hit.module, "assets", key);
    assert.equal(hit.filter, filter, key);
  }
  // 验收 #12 — the collision that would read as correct: ③ 作品设定 and ⚙ 项目设置
  // must be DIFFERENT pages, or every old deep link lands on the wrong one
  assert.notEqual(resolveModule("settings").module, resolveModule(PROJECT_SETTINGS).module);
  assert.equal(resolveModule("settings").module, "settings");
  assert.equal(resolveModule(PROJECT_SETTINGS).module, PROJECT_SETTINGS);
  // every resolvable key has a LABEL, or the breadcrumb renders blank
  for (const k of [...Object.keys(expected), ...PAGES, PROJECT_SETTINGS]) {
    assert.ok(MODULE_LABEL[k], `${k} has no label`);
  }
  // `workbench` and `provenance` are NOT aliased yet, and that is asserted rather
  // than hidden: ⑧ does not contain the 制作台's graph and ⚙ does not mount the
  // provenance graph, so redirecting them produced the 「落到一个没有该内容的页面」
  // failure this very test exists to prevent (independent review, batch 3). They keep
  // their own page until the CONTENT moves — TASK-073 §5.11.
  //
  // `resolved: false` is what KEEPS them working: production.js `setModule` only
  // rewrites the key when `hit.resolved` is true, so an unaliased key passes through
  // to its own renderer untouched. They must therefore still be listed as legacy
  // stages — an unaliased key with no workspace of its own WOULD land nowhere.
  const legacyKeys = LEGACY_EPISODE_STAGES.map(([k]) => k);
  for (const notYet of ["workbench", "provenance"]) {
    assert.equal(resolveModule(notYet).resolved, false, `${notYet} must not be redirected yet`);
    assert.equal(legacyKeys.includes(notYet), true, `${notYet} must keep its own workspace`);
  }
  // and the centre the 「工作区」 back-navigation compares against is one of them
  assert.equal(resolveModule(LEGACY_EPISODE_CENTRE).resolved, false,
    "redirecting the centre makes `activeModule === LEGACY_EPISODE_CENTRE`永远为假");

  // an unknown key still lands somewhere real, and says it was not resolved
  const miss = resolveModule("no-such-module");
  assert.equal(miss.resolved, false);
  assert.ok(PAGES.includes(miss.module));
});

test("资产库 rail 只剩入口：媒体分类七行已删，键仍解析（TASK-082 §1.2）", () => {
  // THE RULE CHANGED, WITH A CARD BEHIND IT. TASK-064 §15 asked the rail to be
  // media categories and nothing else; TASK-073 §1.1 then decided those seven
  // categories ARE the page's own filter chips (`ASSET_FILTER_ALIAS`) and the
  // rail rows are a duplicate of one vocabulary (C-018). TASK-082 §1.2 deletes
  // the rows. So this test now asserts the NEW rule — it was not relaxed to let
  // the code pass, it was rewritten to state what the rail is for.
  const keys = ASSET_NAV.map((i) => i[0]);
  for (const k of ["script", "scenes", "shots", "frames", "video", "audio", "dailies", "edit", "workbench"]) {
    assert.ok(!keys.includes(k), `${k} is production navigation and must not pollute 资产库`);
  }
  // the seven media categories are GONE from the rail …
  for (const k of ["assets:reference", "assets:image", "assets:video", "assets:audio", "assets:final", "assets:collection"]) {
    assert.ok(!keys.includes(k), `${k} is a page filter chip now, not a rail row`);
  }
  // … and are still fully RESOLVABLE, which is the half that must never change:
  // a bookmark, a deep link and a jump target all go through `resolveModule`
  for (const k of Object.keys(ASSET_FILTER_ALIAS)) {
    const hit = resolveModule(k);
    assert.equal(hit.resolved, true, `${k} must still resolve`);
    assert.equal(hit.module, "assets");
    assert.equal(hit.filter, ASSET_FILTER_ALIAS[k]);
  }
  // 存储管理 stays: it is an entrance to another page, not a media category
  assert.ok(keys.includes("storage"));
  assert.ok(keys.includes("assets"));
});

test("renderAssetRail marks the active row and prints only real counts", () => {
  const html = renderAssetRail({ activeModule: "assets", counts: { assets: 3, storage: 0 } });
  assert.ok(html.includes("当前项目"));
  assert.ok(html.includes('class="st-navitem on" data-mod="assets"'));
  assert.ok(/data-mod="storage"/.test(html));
  // a zero count prints NOTHING: a 「0」 badge is noise, not information (the
  // same rule the story rail's badges follow)
  assert.ok(html.includes(">3<"));
  assert.ok(!/data-mod="storage"[\s\S]*?>0</.test(html));
});

/** An empty story document (M9 default shape). */
function storyDefault() {
  return { idea: "", versions: [], active: 0, approved: 0, plans: [], activePlan: 0, confirmedPlan: 0, pending: null };
}

function fakeCtx(pd, doc) {
  const d = doc || sd.createDoc();
  const story = pd.story || storyDefault();
  return {
    prodData: () => pd,
    script: { doc: () => d },
    // same shape the real ctx provides (M8/M9): idle breakdown, offline
    breakdown: { state: () => null },
    story: { doc: () => story },
    isConnected: () => false,
  };
}

test("作品设定 renders the persisted bible: characters, locations, voice rule (M7)", () => {
  // fresh project: honest empty library with add affordances
  const empty = renderSettings(fakeCtx(pdEmpty()));
  assert.ok(empty.includes("还没有角色"));
  assert.ok(empty.includes("还没有场景地"));
  assert.ok(empty.includes("data-b-chadd"));
  assert.ok(empty.includes("data-b-locadd"));
  // with entities: profile fields, states, references (a missing Asset is
  // kept + labeled, never dropped), and the voice-rule wording
  const pd = pdDraft();
  pd.production = prodDefault();
  pd.production.characters = [{
    characterId: "char-1", name: "李昭",
    profile: { appearance: "束发", costume: "襦裙", personality: "怯懦", visualInstruction: "" },
    referenceAssetIds: ["asset-gone"], activeReferenceAssetId: "asset-gone",
    voice: { voiceId: "zh_CN-huayan", description: "清亮", performance: {} },
    states: [{ stateId: "cstate-1", name: "黑化时期", overrides: { appearance: "黑衣" } }],
  }];
  pd.production.locations = [{
    locationId: "loc-1", name: "太极殿",
    profile: { description: "金殿", visualInstruction: "" },
    referenceAssetIds: [], activeReferenceAssetId: null, states: [],
  }];
  const html = renderSettings(fakeCtx(pd));
  assert.ok(html.includes("李昭"));
  assert.ok(html.includes("黑化时期"));
  assert.ok(html.includes("太极殿"));
  assert.ok(html.includes("引用保留")); // missing asset reference kept + labeled
  assert.ok(html.includes("不能换声音")); // voice rule stated
});

test("nextStateRefsOnAdd: adding a secondary reference never displaces the effective primary", () => {
  const entity = { activeReferenceAssetId: "asset-base" };
  // override list contains the INHERITED primary, no active key of its own —
  // adding another ref keeps inheriting (no active key minted), primary stays
  const kept = nextStateRefsOnAdd(entity, { referenceAssetIds: ["asset-base"] }, "asset-x");
  assert.deepEqual(kept, { referenceAssetIds: ["asset-base", "asset-x"] });
  // an explicit override primary is kept verbatim
  const explicit = nextStateRefsOnAdd(entity, { referenceAssetIds: ["a"], activeReferenceAssetId: "a" }, "b");
  assert.equal(explicit.activeReferenceAssetId, "a");
  // FIRST state-specific ref: the inherited primary is not a member of the
  // new one-item list → the added ref becomes primary
  const first = nextStateRefsOnAdd(entity, {}, "asset-x");
  assert.deepEqual(first, { referenceAssetIds: ["asset-x"], activeReferenceAssetId: "asset-x" });
  // explicit none → the added ref becomes primary
  const none = nextStateRefsOnAdd(entity, { referenceAssetIds: [], activeReferenceAssetId: null }, "c");
  assert.equal(none.activeReferenceAssetId, "c");
  // duplicate add is a no-op
  assert.equal(nextStateRefsOnAdd(entity, { referenceAssetIds: ["d"] }, "d"), null);
});

test("剧集场景行提供角色/场景地引用（按 ID + 状态，不复制档案）", () => {
  const pd = pdDraft();
  pd.production = {
    activeEpisodeId: "ep-1",
    episodes: [{
      episodeId: "ep-1", title: "第 1 集",
      scenes: [{
        sceneId: "scene-1", title: "大殿", shotIds: [],
        characterRefs: [{ characterId: "char-1", stateId: "cstate-1" }],
        locationRef: { locationId: "loc-1", stateId: null },
      }],
    }],
    characters: [{
      characterId: "char-1", name: "李昭",
      profile: { appearance: "", costume: "", personality: "", visualInstruction: "" },
      referenceAssetIds: [], activeReferenceAssetId: null,
      voice: { voiceId: null, description: "", performance: {} },
      states: [{ stateId: "cstate-1", name: "黑化时期", overrides: {} }],
    }],
    locations: [{
      locationId: "loc-1", name: "太极殿",
      profile: { description: "", visualInstruction: "" },
      referenceAssetIds: [], activeReferenceAssetId: null, states: [],
    }],
  };
  const m = episodesModel(pd);
  const scene = m.active.scenes[0];
  assert.equal(scene.refs.characters[0].name, "李昭");
  assert.equal(scene.refs.characters[0].stateName, "黑化时期");
  assert.equal(scene.refs.location.name, "太极殿");
  const html = renderEpisodes(fakeCtx(pd));
  assert.ok(html.includes("👤 李昭"));
  assert.ok(html.includes("📍 太极殿"));
  // scene id and character id ride in SEPARATE attributes — never packed into
  // one value a delimiter split could mis-parse (regression: a NUL byte, and
  // later a space-join fragile against ids containing spaces, both lived here)
  assert.ok(html.includes('data-scref-cstate="scene-1" data-cid="char-1"'));
});

test("作品设定状态区提供状态专属参考图控件（M7 round-2）", () => {
  const pd = pdDraft();
  // image assets must carry assetId to be offerable as references (M3 identity)
  pd.assetUploads = {
    "v1-1": {
      current: 1,
      history: [{ slot_id: "v1-1", origin: "upload", version: 1, digest: null, url: "/u/a1.png", assetId: "asset-a1" }],
    },
  };
  pd.production = prodDefault();
  pd.production.characters = [{
    characterId: "char-1", name: "李昭",
    profile: { appearance: "", costume: "", personality: "", visualInstruction: "" },
    referenceAssetIds: ["asset-a1"], activeReferenceAssetId: "asset-a1",
    voice: { voiceId: null, description: "", performance: {} },
    states: [
      { stateId: "cstate-1", name: "黑化时期", overrides: {} }, // inherits base refs
      { stateId: "cstate-2", name: "受伤时期", overrides: { referenceAssetIds: ["asset-x"], activeReferenceAssetId: "asset-x" } },
      // overrides the LIST only — the inherited base active is a member, so
      // the state view must still show it as the main reference (round-3 fix)
      { stateId: "cstate-3", name: "回忆", overrides: { referenceAssetIds: ["asset-a1", "asset-x"] } },
    ],
  }];
  const m = settingsModel(pd);
  const s3 = m.characters[0].states.find((s) => s.stateId === "cstate-3");
  assert.deepEqual(s3.refs.map((r) => [r.assetId, r.active]), [["asset-a1", true], ["asset-x", false]]);
  assert.equal(m.characters[0].states[0].refs, null); // inherit = null, not []
  const html = renderSettings(fakeCtx(pd));
  assert.ok(html.includes("data-b-ovrefadd")); // add a state-specific reference
  assert.ok(html.includes("继承基础参考图")); // inherit standing stated honestly
  assert.ok(html.includes("data-b-ovrefreset")); // explicit list can revert to inherit
  assert.ok(html.includes('data-eid="char-1" data-sid="cstate-2"')); // separate id attrs
});

test("剧集 renders the persisted structure: episodes, scenes, assignment pool (M6)", () => {
  // fresh project: the default single episode, active, no scenes yet
  const eps = renderEpisodes(fakeCtx(pdEmpty()));
  assert.ok(eps.includes("第 1 集"));
  assert.ok(eps.includes("结构已持久化"));
  assert.ok(eps.includes("data-ep-add")); // 新建剧集
  assert.ok(eps.includes("data-sc-add")); // 新建场景（当前剧集）
  assert.ok(eps.includes("还没有场景"));
  // with a draft + a scene holding shot-a: chip for the assigned shot, the
  // unassigned pool offers ONLY shot-b, and a dangling ref is flagged
  const pd = pdDraft();
  pd.production = {
    activeEpisodeId: "ep-1",
    episodes: [{
      episodeId: "ep-1", title: "第 1 集",
      scenes: [{ sceneId: "scene-1", title: "大殿", shotIds: ["shot-a", "shot-gone"] }],
    }],
  };
  const html = renderEpisodes(fakeCtx(pd));
  assert.ok(html.includes("大殿"));
  assert.ok(html.includes("跪殿")); // shot-a resolved via canonical identity
  assert.ok(html.includes("不在当前草稿")); // shot-gone → dangling, flagged not guessed
  assert.ok(html.includes("未归入场景的镜头"));
  assert.ok(html.includes("逼诗")); // shot-b still unassigned
});

test("画面 workspace presents the same asset read model as cards", () => {
  const html = renderFrames(fakeCtx(pdDraft()));
  assert.ok(html.includes("画面工作区"));
  assert.ok(html.includes("/u/a1_v2.png"));
  assert.ok(html.includes("缺图")); // shot 2 honestly missing
});
