// Prompt 编译器 + 生成入口 (checkpoint M10) — run via `node --test`, wrapped
// by tests/test_motv_prompt_m10.py.
//
// Covers: image/video prompt compilation from resolved states (facet
// overrides flow through, gaps reported honestly, nothing invented), the
// shot-detail integration (prompts derived from the scene's bible refs and
// the plan's launch outline tone), and the entry panel rendering.
import test from "node:test";
import assert from "node:assert/strict";

import { compileImagePrompt, compileVideoPrompt } from "../src/workflow/promptc.js";
import { shotDetailModel, renderStoryboard } from "../src/ui/storyboard.js";
import { renderGenEntry } from "../src/ui/genentry.js";
import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";

// --- compileImagePrompt ------------------------------------------------------ //

const CHAR = {
  name: "李昭", stateName: "黑化时期",
  appearance: "黑衣冷面，眼神如霜", costume: "玄色劲装",
  visualInstruction: "冷色调，低角度仰拍",
};
const LOC = {
  name: "太极殿", stateName: "夜晚",
  description: "烛影幢幢，金砖白玉阶", visualInstruction: "对称构图",
};

test("image prompt composes state-resolved facets + tone + shot visual", () => {
  const { text, missing } = compileImagePrompt({
    shot: { description: "李昭跪于大殿中央，冷汗浸透衣衫" },
    characters: [CHAR],
    location: LOC,
    tone: "古装爽剧 · 黑色幽默",
  });
  assert.ok(text.includes("【风格】古装爽剧"));
  assert.ok(text.includes("【场景】太极殿（夜晚）：烛影幢幢"));
  assert.ok(text.includes("【场景画面指令】对称构图"));
  assert.ok(text.includes("【角色】李昭（黑化时期）：黑衣冷面，眼神如霜；玄色劲装"));
  assert.ok(text.includes("【角色画面指令】冷色调"));
  assert.ok(text.includes("【画面】李昭跪于大殿中央"));
  assert.ok(text.includes("16:9"));
  assert.deepEqual(missing, []);
});

test("image prompt reports honest gaps and never invents absent facets", () => {
  const { text, missing } = compileImagePrompt({ shot: { description: "" } });
  assert.equal(missing.length, 3); // 场景地 / 角色 / 画面内容
  assert.ok(missing[0].includes("场景地"));
  assert.ok(missing[1].includes("出场角色"));
  assert.ok(missing[2].includes("画面内容"));
  assert.ok(!text.includes("【场景】"));
  assert.ok(!text.includes("【角色】"));
  assert.ok(!text.includes("【风格】")); // no tone → no fabricated style line
});

// --- compileVideoPrompt -------------------------------------------------------- //

test("video prompt = first frame + action + camera + duration + dialogue", () => {
  const { text, missing } = compileVideoPrompt({
    shot: {
      description: "大殿中央", action: "指尖颤抖地撑地，缓缓抬头",
      cameraMotion: "低角度缓慢推近至面部特写", duration_seconds: 10,
      dialogue: "「臣……遵旨。」",
    },
    hasImage: true,
  });
  assert.ok(text.includes("【首帧】以所附图片为第 1 帧"));
  assert.ok(text.includes("【动作】指尖颤抖"));
  assert.ok(text.includes("【运镜】低角度缓慢推近"));
  assert.ok(text.includes("【时长】10 秒"));
  assert.ok(text.includes("【台词（口型/情绪参考）】「臣……遵旨。」"));
  assert.deepEqual(missing, []);
});

test("video prompt gaps: no image / no action / no camera", () => {
  const { text, missing } = compileVideoPrompt({ shot: { duration_seconds: 6 }, hasImage: false });
  assert.equal(missing.length, 3);
  assert.ok(missing[0].includes("图片"));
  assert.ok(text.includes("【时长】6 秒"));
  assert.ok(!text.includes("【首帧】"));
});

// --- shot-detail integration ----------------------------------------------------- //

function snapshot() {
  const prod = pd.createProduction(null);
  const scene = pd.addScene(prod, prod.episodes[0].episodeId, "大殿对峙");
  pd.assignShot(prod, scene.sceneId, "shot-a");
  const c = bd.addCharacter(prod, "李昭");
  bd.updateCharacterProfile(prod, c.characterId, { appearance: "青衫束发" });
  const st = bd.addCharacterState(prod, c.characterId, "黑化时期");
  bd.setCharacterStateOverrides(prod, c.characterId, st.stateId, { appearance: "黑衣冷面" });
  const l = bd.addLocation(prod, "太极殿");
  bd.updateLocationProfile(prod, l.locationId, { description: "金砖白玉阶" });
  bd.addSceneCharacter(prod, scene.sceneId, c.characterId, st.stateId);
  bd.setSceneLocation(prod, scene.sceneId, l.locationId, null);
  return {
    draftShots: [{
      shotId: "shot-a", sequence: 1, title: "跪殿", description: "李昭跪于大殿中央",
      duration_seconds: 6, slot: "v1-1", action: "缓缓抬头", cameraMotion: "推近",
    }],
    lockedPlan: null,
    shotVersions: { count: 1, cur: 1, state: "done", rows: null },
    realShots: null,
    assetUploads: {
      "v1-1": { current: 1, history: [{ slot_id: "v1-1", origin: "upload", version: 1, url: "/u/a.png", assetId: "asset-1" }] },
    },
    media: { video: {}, audio: {} },
    firstFrames: {},
    finals: [],
    paidOps: {},
    generations: [],
    production: prod,
    story: {
      idea: "", active: 1, approved: 1, activePlan: 0, confirmedPlan: 0, plans: [],
      versions: [{ id: "so-1", v: 1, origin: "developed", instruction: "", basedOn: null,
        outline: { premise: "", logline: "", genreTone: "古装爽剧", world: "", characterConcepts: [], centralConflict: "", storyArc: "", ending: "", episodeCount: null, durationNote: "" } }],
      pending: null,
    },
  };
}

test("shotDetailModel compiles prompts from the scene's STATE-resolved bible refs", () => {
  const s = snapshot();
  const d = shotDetailModel(s, "shot-a");
  // the character's 黑化时期 override reaches the prompt — not the base look
  assert.ok(d.prompts.image.text.includes("李昭（黑化时期）：黑衣冷面"));
  assert.ok(!d.prompts.image.text.includes("青衫束发"));
  assert.ok(d.prompts.image.text.includes("【场景】太极殿：金砖白玉阶"));
  assert.ok(d.prompts.image.text.includes("【风格】古装爽剧")); // approved outline tone
  assert.deepEqual(d.prompts.image.missing, []);
  // the shot HAS a current image → the video prompt binds it as frame 1
  assert.ok(d.prompts.video.text.includes("【首帧】"));
  assert.ok(d.prompts.video.text.includes("【动作】缓缓抬头"));
});

test("the AI Director hosts both entry panels with real affordances", () => {
  const s = snapshot();
  const d = shotDetailModel(s, "shot-a");
  for (const kind of ["image", "video"]) {
    const html = renderGenEntry(d, kind, null);
    assert.ok(html.includes(`data-genprompt="${kind}"`));
    assert.ok(html.includes("data-gp-go"));
    assert.ok(html.includes("data-gp-import"));
    assert.ok(html.includes('data-gp-prov="gemini"'));
    assert.ok(html.includes("API 自动生成")); // honest future note, not a fake button
    assert.ok(html.includes("未来"));
  }
  // ChatGPT is an image entry; the video prompt offers Gemini video
  assert.ok(renderGenEntry(d, "image", null).includes('data-gp-prov="chatgpt"'));
  // the compiled text is IN the panel, ready to copy
  assert.ok(renderGenEntry(d, "image", null).includes("黑衣冷面"));
});

test("the storyboard detail still renders the shot's media-first surface", () => {
  const s = snapshot();
  const ctx = { prodData: () => s, script: { hasContent: () => true } };
  const html = renderStoryboard(ctx, { selectedShotId: "shot-a", buffer: {} });
  assert.ok(html.includes("herobox")); // large current-frame preview
  assert.ok(html.includes("data-vtab=")); // variant tabs
  assert.ok(html.includes("跪殿")); // the shot itself
});
