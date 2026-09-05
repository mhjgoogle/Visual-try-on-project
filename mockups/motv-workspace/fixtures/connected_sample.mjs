// 可重复的 Connected Project 样本 —— 画布那一半（TASK-130 / 收敛审查 §5.E）。
//
// WHY A GENERATOR, NOT A COMMITTED JSON. 画布的形状归前端（`serializeGraph` 的键、
// `CANVAS_SCHEMA_VERSION`、每一段的校验），一份手写或提交的 JSON 会在下一次 schema 升版时
// 悄悄过期。这里用**界面写用的同一组域 API**（`fixtures/demo-project.js` 的 `seedDemoProject`
// 走的正是它们）把文档造出来，再用 `validateCanvasDoc` 自检 —— 造不出合法文档就退出非零，
// 而不是让测试拿着一份坏画布往下跑。
//
// WHAT IT ADDS ON TOP OF THE DEMO SEED（§5.E 点名要的状态，每一条都能在界面上看见）：
//   · 占位 SVG（data: URL）全部换成 `/api/uploads/<项目>/<assetId>.<ext>` —— 文件由 Python 侧
//     用 ffmpeg 生成，小而真（真 H.264 / 真 WAV / 真 PNG）；名字就是 assetId，两边不用对表
//   · 一版候选成片（`kind: "cut"`）+ 一版历史成片（`kind: "final"`）
//   · `deliverySpec` 设成生成媒体**必然不满足**的规格 → 交付质检的「规格」行阻断 → G4 拒绝导出
//     （这是旅程里「有阻断问题的候选导不出」那一步的**真实**触发，不是种一条问题冒充）
//   · 一条 open 的交付层审片问题（`reviews.issues`，经 `review.issue()` 造，非法就抛）
//   · 一次失败的能力运行（`skillRuns`）
//   运行中的对话 run 与未决提案不在画布里 —— 它们住在后端（runs 注册表 / 账户级 feedback.json），
//   由 Python 侧造。
//
// 用法（Python 侧调）：node connected_sample.mjs <项目名>  → stdout 一份 JSON：
//   { canvas: <serializeGraph 形状>, media: [{ name, domain, seconds }] }
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as storydoc from "../src/workflow/storydoc.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as assetlib from "../src/workflow/assetlib.js";
import * as genlib from "../src/workflow/genlib.js";
import * as timeline from "../src/workflow/timeline.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as promptdoc from "../src/workflow/promptdoc.js";
import * as refinterp from "../src/workflow/refinterp.js";
import * as refuse from "../src/workflow/refuse.js";
import * as framebind from "../src/workflow/framebind.js";
import * as locksdoc from "../src/workflow/locks.js";
import * as shotaudio from "../src/workflow/shotaudio.js";
import * as subtitle from "../src/workflow/subtitle.js";
import * as ctxcache from "../src/workflow/ctxcache.js";
import * as review from "../src/workflow/review.js";
import { CANVAS_SCHEMA_VERSION, validateCanvasDoc } from "../src/services/canvasschema.js";
import { seedDemoProject } from "./demo-project.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function buildConnectedSample(projectName) {
  const project = String(projectName || "样本 · 迷雾入城");
  const story = storydoc.createStory(null);
  const production = proddoc.createProduction(null);
  const scripts = Object.create(null);
  const assets = assetlib.createRegistry(null);
  const generations = genlib.createGenerationRegistry(null);
  const timelines = timeline.createTimelines(null);
  const skillRuns = skillrun.createSkillRunRegistry(null);

  // 1. 一个进行到一半的真实项目：故事 / 设定 / 分集 / 分镜 / 媒体全部就位
  const seed = seedDemoProject({ story, production, scripts, assets, generations, timelines });

  // 2. 占位 SVG → 真媒体的地址。名字 = assetId，Python 侧按同一个名字生成文件。
  const media = [];
  const extOf = { images: "png", videos: "mp4", audio: "wav", finals: "mp4" };
  const swap = (rec, domain) => {
    if (!rec || typeof rec.url !== "string") return;
    if (!rec.url.startsWith("data:")) return;
    const name = `${rec.assetId}.${extOf[domain]}`;
    rec.url = `/api/uploads/${encodeURIComponent(project)}/${name}`;
    media.push({ name, domain, seconds: domain === "images" ? 0 : 1.0 });
  };
  for (const domain of ["images", "videos", "audio"]) {
    const map = assets[domain] || {};
    for (const key of Object.keys(map)) {
      for (const rec of map[key].history || []) swap(rec, domain);
    }
  }
  for (const rec of assets.finals || []) swap(rec, "finals");
  for (const key of Object.keys(assets.firstFrames || {})) swap(assets.firstFrames[key], "images");

  // 3. 交付链：演示种子给的是候选（TASK-074 §1.7）；再补一版**历史成片**，让「已导出的成片」
  //    那一组也非空 —— 老项目本来就有 `final`，样本要像老项目。
  const historical = assetlib.addCut(assets, `/api/uploads/${encodeURIComponent(project)}/final-history.mp4`, seed.activeEpisodeId);
  historical.kind = "final"; // 历史记录：当时的规则就是「渲染即成片」（TASK-074 §1.7 不改写老记录）
  media.push({ name: "final-history.mp4", domain: "finals", seconds: 1.0 });

  // 4. 成片规格：生成的媒体是 320x320 @ 24fps mp4，这里要 1080x1920 @ 30 —— 规格行必然阻断。
  // 只设三项 —— 都是交付质检「规格」行会拿去比的；多设一项枚举字段就多一处校验要对
  // （第一版写了 platform: "竖屏短剧"，validateCanvasDoc 当场拒了：它是枚举）。
  const deliverySpec = { resolution: "1080x1920", fps: 30, container: "mp4" };

  // 5. 一条 open 的交付层审片问题 —— 经 `review.issue()` 造，非法直接抛（fail-closed）
  const issue = review.issue({
    issueId: "qc-sample-av-1",
    layer: "delivery",
    category: "av_sync",
    severity: "blocking",
    source: "user",
    targetType: "delivery",
    targetId: seed.activeEpisodeId,
    text: "样本：对白比画面晚 220ms（人工标记，等复核）",
  });
  if (!issue.ok) throw new Error(`造不出合法的审片问题：${issue.error}`);

  // 6. 一次失败的能力运行 —— 让「失败任务」在看板与运行记录里有东西可看
  const failed = skillrun.startRun(skillRuns, {
    skillId: "story-review",
    skillVersion: 1,
    runtime: "local_subscription",
    executor: "claude-code",
    model: null,
    inputKeys: ["brief", "outline"],
    inputSummary: "样本：一次注定失败的审读",
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  skillrun.failRun(skillRuns, failed.runId, "unavailable", "样本：执行器不可用（故意的）");

  const canvas = {
    v: CANVAS_SCHEMA_VERSION,
    project,
    story: storydoc.serialize(story),
    scripts: Object.fromEntries(Object.entries(scripts).map(([k, d]) => [k, d])),
    assets,
    generations,
    skillRuns,
    production: proddoc.serialize(production),
    batches: {},
    timelines: timeline.serialize(timelines),
    prompts: promptdoc.serialize(promptdoc.createPrompts(null)),
    refInterp: refinterp.serialize(refinterp.createInterpretations(null)),
    refUse: refuse.serialize(refuse.createRefUse(null)),
    frameBindings: framebind.serialize(framebind.createFrameBindings(null)),
    locks: locksdoc.serialize(locksdoc.createLocks(null)),
    shotAudio: shotaudio.serialize(shotaudio.createShotAudio(null)),
    subtitles: subtitle.serialize(subtitle.createSubtitles(null)),
    ctxCache: ctxcache.serialize(ctxcache.createCache(null)),
    deliverySpec,
    reviews: { issues: [issue.value], decisions: [], coreSync: {} },
    nodes: [],
    edges: [],
    pan: { x: 0, y: 0 },
  };

  // 7. 自检：造不出合法文档就别让测试拿着它跑
  const bad = validateCanvasDoc(canvas);
  if (bad) throw new Error(`样本画布不合法：${bad}`);

  return { canvas, media, activeEpisodeId: seed.activeEpisodeId, draftShots: seed.draftShots.length };
}

// CLI：node connected_sample.mjs <项目名>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = buildConnectedSample(process.argv[2]);
  process.stdout.write(JSON.stringify(out));
}

export const FIXTURE_DIR = HERE;
export const SAMPLE_PROJECT_NAME = "样本 · 迷雾入城";
