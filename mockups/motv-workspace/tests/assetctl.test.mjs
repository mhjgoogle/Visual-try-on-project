// TASK-073 §1.8 第三批 — `assetctl.js` 搬出 app.js 后的第一批真测试。
//
// 这些断言的存在本身就是搬迁的验证手段（§5.9）：控制器只有接显式依赖、能被独立
// 构造，才谈得上「搬对了」。所以第一条测的不是某个业务规则，而是 **getter 注入**
// ——它是这批搬迁唯一会静默出错的地方。

import test from "node:test";
import assert from "node:assert/strict";

import { createAssetController } from "../src/controllers/assetctl.js";
import * as assetreg from "../src/workflow/assetreg.js";
import * as assetlib from "../src/workflow/assetlib.js";
import * as mediaref from "../src/workflow/mediaref.js";
import * as assetusage from "../src/workflow/assetusage.js";
import * as assetlibws from "../src/ui/assetlibws.js";

const emptyRegistry = () => ({ images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} });
const emptyProduction = () => ({ characters: [], locations: [], episodes: [] });

/** A controller over documents the test can swap, plus a record of side effects. */
function makeCtl(over = {}) {
  const state = {
    registry: over.registry || emptyRegistry(),
    production: over.production || emptyProduction(),
    timelines: over.timelines || {},
    generations: over.generations || [],
    connected: over.connected !== false,
    project: over.project || "proj-a",
    calls: { persist: 0, refresh: 0, refreshType: [], toast: [], uploads: [] },
  };
  const ctl = createAssetController({
    docs: {
      registry: () => state.registry,
      production: () => state.production,
      timelines: () => state.timelines,
      generations: () => state.generations,
    },
    modules: { assetreg, assetlib, mediaref, assetusage, assetlibws },
    session: { connected: () => state.connected, projectName: () => state.project },
    uploadAssetImage: async (project, slug, file) => {
      state.calls.uploads.push({ project, slug, name: file && file.name });
      return { url: `/api/uploads/${project}/${slug}.png`, version: 1 };
    },
    pickFile: async () => over.pickedFile || null,
    mediaDomainOfFile: (f) => (f && f.domain) || null,
    domainSlugPrefix: (d) => ({ images: "img", videos: "vid", audio: "audio" })[d] || d,
    setCurrentVersion: (...args) => { state.calls.setCurrent = args; return true; },
    draftShots: () => over.draftShots || [],
    refreshType: (t) => state.calls.refreshType.push(t),
    persist: () => { state.calls.persist += 1; },
    refresh: () => { state.calls.refresh += 1; },
    toast: (m) => state.calls.toast.push(m),
  });
  return { ctl, state };
}

test("documents are read through GETTERS — switching project must not strand it", () => {
  const { ctl, state } = makeCtl();
  assert.deepEqual(ctl.list(), [], "empty project reads empty");

  // simulate a project load: app.js reassigns the module-level `let`s
  const other = emptyRegistry();
  other.finals.push({ assetId: "asset-x", url: "/api/uploads/p/final-cut-v1.mp4", kind: "final" });
  state.registry = other;

  const ids = ctl.list().map((a) => a.assetId);
  assert.deepEqual(ids, ["asset-x"],
    "a controller that captured the registry VALUE would still read the old project");
});

test("names() follows the production doc across a reload too", () => {
  const { ctl, state } = makeCtl();
  assert.equal(ctl.names().character("c1"), "");

  state.production = {
    characters: [{ characterId: "c1", name: "林照" }],
    locations: [], episodes: [],
  };
  assert.equal(ctl.names().character("c1"), "林照");
});

test("an offline import refuses BEFORE it uploads anything", async () => {
  const { ctl, state } = makeCtl({ connected: false });
  await assert.rejects(
    () => ctl.importReference({ kind: "character-reference", file: { name: "a.png", domain: "images" } }),
    /演示模式/,
  );
  assert.equal(state.calls.uploads.length, 0, "no bytes may be spent on a refused import");
});

test("a non-reference kind and a missing file are both refused, still no upload", async () => {
  const { ctl, state } = makeCtl();
  await assert.rejects(() => ctl.importReference({ kind: "final", file: { domain: "images" } }), /不是参考类型/);
  await assert.rejects(() => ctl.importReference({ kind: "character-reference" }), /没有选择文件/);
  assert.equal(state.calls.uploads.length, 0);
});

test("an unrecognisable file type is refused rather than uploaded as a guess", async () => {
  const { ctl, state } = makeCtl();
  await assert.rejects(
    () => ctl.importReference({ kind: "character-reference", file: { name: "x.bin", domain: null } }),
    /无法识别文件类型/,
  );
  assert.equal(state.calls.uploads.length, 0);
});

test("a kind may only take the domains ITS declaration allows", async () => {
  const { ctl, state } = makeCtl();
  // 人物参考 is an image kind; an audio file for it must be refused by the
  // kind's own allow-list, not by a hardcoded 「images unless external」
  await assert.rejects(
    () => ctl.importReference({ kind: "character-reference", file: { name: "v.mp3", domain: "audio" } }),
    /只能是/,
  );
  assert.equal(state.calls.uploads.length, 0);
});

test("a successful import registers, persists and names what it registered", async () => {
  const { ctl, state } = makeCtl();
  const out = await ctl.importReference({
    kind: "character-reference",
    file: { name: "lin.png", domain: "images" },
    displayName: "林照",
  });

  assert.ok(out.key.startsWith("ref-"), "a canonical reference mints its own chain");
  assert.equal(state.calls.uploads.length, 1);
  assert.equal(state.calls.persist, 1, "the registration must be persisted");
  assert.deepEqual(state.calls.refreshType, ["assets"]);
  assert.equal(state.calls.toast.length, 1);
  assert.equal(ctl.list().length, 1, "and it is readable straight back");
});

test("uploadReferenceVersion on an unknown key refuses without opening a picker", async () => {
  const { ctl } = makeCtl();
  await assert.rejects(() => ctl.uploadReferenceVersion("not-a-ref"), /不是参考资产/);
  await assert.rejects(() => ctl.uploadReferenceVersion("ref-nope"), /参考资产不存在/);
});

test("setReusable goes through update — one write path, not two", () => {
  const { ctl, state } = makeCtl();
  // no such asset: update refuses, and refusing must not persist
  assert.equal(ctl.setReusable("asset-missing", true), false);
  assert.equal(state.calls.persist, 0, "a refused edit must not write");
});

test("setCurrent DELEGATES the active-pointer write instead of re-implementing it", () => {
  const { ctl, state } = makeCtl();
  ctl.setCurrent("images", "ref-1", 2);
  assert.deepEqual(state.calls.setCurrent, ["image", "ref-1", 2],
    "the domain word is translated, but the write itself stays in the one path");
  ctl.setCurrent("videos", "ref-2", 3);
  assert.equal(state.calls.setCurrent[0], "video");
  ctl.setCurrent("audio", "ref-3", 1);
  assert.equal(state.calls.setCurrent[0], "audio");
});

test("provenanceOf is honestly null when nothing recorded producing the asset", () => {
  const { ctl, state } = makeCtl();
  assert.equal(ctl.provenanceOf("asset-x"), null);

  state.generations = [{ generationId: "gen-1", resultAssetIds: ["asset-x"], inputAssetIds: [] }];
  const prov = ctl.provenanceOf("asset-x");
  assert.equal(prov.generation.generationId, "gen-1");
});

test("a deleted input still shows in provenance, marked as deleted", () => {
  const { ctl, state } = makeCtl();
  state.generations = [
    { generationId: "gen-1", resultAssetIds: ["asset-x"], inputAssetIds: ["asset-gone"] },
  ];
  const prov = ctl.provenanceOf("asset-x");
  assert.match(prov.references[0], /已删除/,
    "an input that no longer resolves is named as missing, not dropped from the record");
});

test("filterOptions offers only canonical objects that really exist", () => {
  const { ctl, state } = makeCtl();
  assert.deepEqual(ctl.filterOptions().characters, []);

  state.production = {
    characters: [{ characterId: "c1", name: "林照" }],
    locations: [{ locationId: "l1", name: "金銮殿" }],
    episodes: [{ episodeId: "e1", title: "雨夜" }],
  };
  const opts = ctl.filterOptions();
  assert.deepEqual(opts.characters, [{ id: "c1", name: "林照" }]);
  assert.equal(opts.episodes[0].name, "EP01 雨夜");
});
