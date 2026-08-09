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
  renderSettings,
  renderEpisodes,
  renderShots,
  renderFrames,
} from "../src/ui/workspaces.js";
import { navBadges, NAV } from "../src/ui/production.js";
import * as sd from "../src/workflow/scriptdoc.js";

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

test("videoModel: paid ops map via locked plan ids, else shot-<seq>", () => {
  const pd = pdDraft();
  pd.paidOps = { "shot-1": { status: "held" } };
  assert.equal(videoModel(pd).items[0].opStatus, "held");
  pd.lockedPlan = { plan_version: 2, shots: [{ shot_id: "shot-p2-1" }, { shot_id: "shot-p2-2" }] };
  pd.paidOps = { "shot-p2-1": { status: "committed" } };
  const m = videoModel(pd);
  assert.equal(m.items[0].opStatus, "committed");
  assert.equal(m.items[1].opStatus, null);
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
  assert.deepEqual(empty, {
    story: "", settings: "", episodes: "",
    script: "草稿", shots: "", frames: "", video: "", audio: "", edit: "",
  });
  sd.setBrief(d, "想法");
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "v1");
  const b = navBadges(d, pdDraft());
  assert.equal(b.story, "✓");
  assert.equal(b.script, "v1");
  assert.equal(b.shots, "2");
  assert.equal(b.frames, "1/2");
  assert.equal(b.video, "1/2");
  assert.equal(b.audio, "1/2");
  assert.equal(b.edit, "");
  // 作品设定/剧集 never fabricate a count — their domains are not persisted yet
  assert.equal(b.settings, "");
  assert.equal(b.episodes, "");
});

// --- M2.5 最终信息架构 ----------------------------------------------------- //

test("NAV: grouped final IA — 项目级 and 当前剧集 with every module present", () => {
  assert.deepEqual(NAV.map((g) => g.sec), ["项目", "当前剧集"]);
  assert.deepEqual(NAV[0].items.map((i) => i[0]), ["story", "settings", "episodes"]);
  assert.deepEqual(NAV[1].items.map((i) => i[0]), ["script", "shots", "frames", "video", "audio", "edit"]);
});

function fakeCtx(pd, doc) {
  const d = doc || sd.createDoc();
  return { prodData: () => pd, script: { doc: () => d } };
}

test("作品设定/剧集 are honest placeholders — no fake persistence claimed", () => {
  const settings = renderSettings();
  assert.ok(settings.includes("尚未开放"));
  assert.ok(settings.includes("后续检查点"));
  const eps = renderEpisodes(fakeCtx(pdEmpty()));
  assert.ok(eps.includes("单剧集视图"));
  assert.ok(eps.includes("无剧集实体被持久化"));
  assert.ok(eps.includes("剧本未生成"));
});

test("剧集 card reflects real current data without inventing entities", () => {
  const d = sd.createDoc();
  sd.completeGeneration(d, sd.beginGeneration(d, "initial", "想法"), "剧本");
  const eps = renderEpisodes(fakeCtx(pdDraft(), d));
  assert.ok(eps.includes("剧本 v1"));
  assert.ok(eps.includes("2 个镜头"));
});

test("分镜 renders creator-facing Shot cards from the current collection", () => {
  const html = renderShots(fakeCtx(pdDraft()));
  assert.ok(html.includes("shotgrid"));
  assert.ok(html.includes("跪殿"));
  assert.ok(html.includes("逼诗"));
  assert.ok(html.includes("/u/a1_v2.png")); // current asset version as card thumb
  assert.ok(!html.includes("场景")); // no fabricated Scene grouping
});

test("画面 workspace presents the same asset read model as cards", () => {
  const html = renderFrames(fakeCtx(pdDraft()));
  assert.ok(html.includes("画面工作区"));
  assert.ok(html.includes("/u/a1_v2.png"));
  assert.ok(html.includes("缺图")); // shot 2 honestly missing
});
