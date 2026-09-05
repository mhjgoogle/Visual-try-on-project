// TASK-097 批次 1 / ADR-0073 —— Shot 的六个 Stage，作为规则：
//
//   1. 四态**按来源**分配：只有 `skipped` 是持久的，其余三个是把证据读成一个词。
//      存储的 `in_progress` 在崩溃后会永久说谎；存储的 `completed` 在产物消失后
//      会继续说做完了 —— 两者都必须**存不进去**，而不是「我们不要那样写」。
//   2. 依赖关系是**数据**：加一个假 stage 只需加一行，判定代码不动。
//   3. Keyframe 的闸门按产品负责人原话：`skipped` 放行、`completed` 但未确认**不**放行。
//   4. 换掉草图，原来的确认自动失效（批准绑产物，不绑 stage）。
//   5. Audio 组**不以 Video 完成为前置**。
//   6. `shotStage` 汇总之后，三个消费者的既有断言全部继续通过。
//   7. 新增 asset kind 必须被它的**全部**消费者认识 —— 用派生守卫，不用清单。
//
// §2.6.3 的纪律：每条守卫先有一次「它真的会拒绝」的证明。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STAGES, STATUSES, STAGE_GROUP, STAGE_DEPENDENCIES,
  sanitizeShotStages, skipStage, unskipStage, isSkipped,
  stageStatuses, stageBoard, canStart, summarizeStages, shotComplete, FACTS,
} from "../src/workflow/shotstage.js";
import {
  defaultShotProduction, sanitizeShotProduction, shotStage, approveShot, stagesFromMedia,
} from "../src/workflow/shotprod.js";
import {
  ASSET_KINDS, ASSET_KIND_LABEL, KIND_DOMAIN, KIND_DOMAINS,
  SHOT_PICTURE_KINDS, SHOT_VIDEO_LIBRARY_KINDS,
} from "../src/workflow/assetreg.js";
import { TYPE_FILTERS, libraryModel } from "../src/ui/assetlibws.js";
import { CANVAS_SCHEMA_VERSION, MIGRATIONS, validateCanvasDoc } from "../src/services/canvasschema.js";

/* ========================================================================= */
/* 1. 四态按来源                                                              */
/* ========================================================================= */

test("六个 stage 与四态就是产品负责人给的那两份清单", () => {
  assert.deepEqual(STAGES, ["storyboard", "keyframe", "video", "voice", "sfx", "qc"]);
  assert.deepEqual(STATUSES, ["not_started", "in_progress", "completed", "skipped"]);
  assert.deepEqual(
    STAGES.map((s) => STAGE_GROUP[s]),
    ["visual", "visual", "visual", "audio", "audio", "qc"],
  );
});

test("写进文档的 completed / in_progress **存不进去** —— 它们会在产物消失后继续说谎", () => {
  const poisoned = {
    "shot-a": {
      storyboard: { skipped: { at: "t1", reason: "轻量模式" } },
      keyframe: { status: "completed" },          // 有人（或旧版本）写下的声明
      video: { skipped: { at: "" } },             // 半条记录
    },
  };
  const clean = sanitizeShotStages(poisoned);
  assert.deepEqual(Object.keys(clean["shot-a"]), ["storyboard"], "它真的只留下跳过决定");
  assert.equal("keyframe" in clean["shot-a"], false);
  assert.equal("video" in clean["shot-a"], false, "半条跳过记录降级成没有决定");
});

test("in_progress 只来自在途 Run —— 没有在途 Run 时不得为真", () => {
  const stages = {};
  const none = stageStatuses(stages, "shot-a", { inflight: () => false });
  for (const s of STAGES) assert.equal(none[s].status, "not_started");
  const flying = stageStatuses(stages, "shot-a", { inflight: (s) => s === "video" });
  assert.equal(flying.video.status, "in_progress");
  assert.equal(flying.keyframe.status, "not_started");
});

test("completed 要证据：探针没说它在，就不是 completed（对着 TASK-077 那个谎）", () => {
  const stages = {};
  const present = stageStatuses(stages, "shot-a", {
    artifact: (s) => (s === "keyframe" ? { assetId: "img-1", present: true } : null),
  });
  assert.equal(present.keyframe.status, "completed");

  // 探针说它没了 → 不是 completed
  const gone = stageStatuses(stages, "shot-a", {
    artifact: (s) => (s === "keyframe" ? { assetId: "img-1", present: false } : null),
  });
  assert.equal(gone.keyframe.status, "not_started", "它真的会拒绝把丢了文件的产物算作完成");

  // 没人问过探针 → 同样不是 completed（声明不等于事实）
  const unasked = stageStatuses(stages, "shot-a", {
    artifact: (s) => (s === "keyframe" ? { assetId: "img-1" } : null),
  });
  assert.equal(unasked.keyframe.status, "not_started", "没问过就不能算完成");
});

test("跳过压过一切：即使意外留下了产物，人的决定仍然是决定", () => {
  const stages = {};
  skipStage(stages, "shot-a", "storyboard", "t1", "轻量模式");
  const st = stageStatuses(stages, "shot-a", {
    inflight: () => true,
    artifact: () => ({ assetId: "img-1", present: true }),
  });
  assert.equal(st.storyboard.status, "skipped");
});

test("skipped 是唯一的写路径，撤销是删记录而不是写一个 false", () => {
  const stages = {};
  assert.equal(skipStage(stages, "shot-a", "storyboard", "t1"), true);
  assert.equal(isSkipped(stages, "shot-a", "storyboard"), true);
  assert.equal(skipStage(stages, "shot-a", "不存在的stage", "t1"), false, "只认六个 stage");
  assert.equal(skipStage(stages, "shot-a", "storyboard", ""), false, "没有时间戳不算一个决定");
  // 写路径接受的必须正好是能存活的：纯空白的时间戳会被规整和 v16 校验双双拒收，
  // 所以它在这里就得被拒 —— 否则界面上看得见一个重载就消失的决定。
  assert.equal(
    skipStage(stages, "shot-a", "keyframe", "   "),
    false,
    "它真的会拒绝一个存不下来的时间戳",
  );
  assert.equal(isSkipped(stages, "shot-a", "keyframe"), false);
  assert.equal(unskipStage(stages, "shot-a", "storyboard"), true);
  assert.deepEqual(stages, {}, "撤销之后什么都不剩，而不是留一个 skipped:false");
});

test("shotId 叫 __proto__ 也是自己的 key", () => {
  const stages = {};
  skipStage(stages, "__proto__", "storyboard", "t1");
  assert.equal(isSkipped(stages, "__proto__", "storyboard"), true);
  assert.equal({}.storyboard, undefined, "原型没有被污染");
});

/* ========================================================================= */
/* 2 + 3 + 5. 依赖是数据；闸门；Audio 不等 Video                               */
/* ========================================================================= */

test("Keyframe 的闸门逐条按原话：skipped 放行 / completed 未确认不放行 / 确认了放行", () => {
  const base = (over) => ({ storyboard: { status: "not_started", approved: false }, ...over });

  const skipped = canStart("keyframe", base({ storyboard: { status: "skipped", approved: false } }));
  assert.equal(skipped.ok, true, "轻量模式放行");

  const completedOnly = canStart("keyframe", base({ storyboard: { status: "completed", approved: false } }));
  assert.equal(completedOnly.ok, false, "它真的会拦住「出了草图但还没确认」");
  assert.match(completedOnly.blockers[0], /已完成但还没确认/);

  const approved = canStart("keyframe", base({ storyboard: { status: "completed", approved: true } }));
  assert.equal(approved.ok, true);

  const nothing = canStart("keyframe", base({}));
  assert.equal(nothing.ok, false);
  assert.match(nothing.blockers[0], /分镜草图/, "拦住时说清是哪一步、缺什么");
});

test("Audio 组不以 Video 完成为前置 —— 音频可以先准备", () => {
  const ready = {
    video: { status: "not_started", approved: false },
    dialogue: { status: "completed" },
  };
  assert.equal(canStart("voice", ready).ok, true, "视频还没有，配音照样可以开工");
  assert.equal(canStart("sfx", ready).ok, true);
  // …但它**有**前置：台词已确认（TASK-092 §2.5 的原话）
  for (const row of [...STAGE_DEPENDENCIES.voice, ...STAGE_DEPENDENCIES.sfx]) {
    assert.equal(row.on, "dialogue", "音频的前置是台词，不是 video");
  }
});

test("台词没定就不能开始配音 —— 录完必然重录", () => {
  const undecided = { dialogue: { status: "not_started" } };
  const r = canStart("voice", undecided);
  assert.equal(r.ok, false, "它真的会拦住");
  assert.match(r.blockers[0], /台词/);
  // 没有台词的镜头本来就不需要配音：那是决定，不是缺口
  assert.equal(canStart("voice", { dialogue: { status: "skipped" } }).ok, true);
  // 没人告诉我们台词定了 = 没定（fail-closed，不猜）
  assert.equal(canStart("voice", {}).ok, false);
});

test("QC 是「两组都就位后」，不是画面好了就能判片", () => {
  const videoOnly = {
    video: { status: "completed" }, voice: { status: "not_started" }, sfx: { status: "not_started" },
  };
  const blocked = canStart("qc", videoOnly);
  assert.equal(blocked.ok, false, "它真的会拦住只有画面的 QC");
  assert.equal(blocked.blockers.length, 2, "配音与音效各报一条，不合并成一句含糊的话");

  const bothGroups = {
    video: { status: "completed" }, voice: { status: "completed" }, sfx: { status: "skipped" },
  };
  assert.equal(canStart("qc", bothGroups).ok, true, "音效按设计跳过也算就位");
});

test("「这一镜真的做完了吗」有自己的名字，不去改写审片那个词", () => {
  const videoApproved = {
    storyboard: { status: "skipped" }, keyframe: { status: "completed" },
    video: { status: "completed", approved: true },
    voice: { status: "not_started" }, sfx: { status: "not_started" }, qc: { status: "not_started" },
  };
  // ⑨ 粗剪审片 仍然可以说「我看过这条视频，通过了」——那句话是真的
  assert.equal(summarizeStages(videoApproved), "approved");
  // …而「整镜做完了吗」是另一个问题，它老实回答没有
  const c = shotComplete(videoApproved);
  assert.equal(c.complete, false, "它真的不会把没配音的镜头算作完成");
  assert.deepEqual(c.missing, ["voice", "sfx", "qc"]);
  assert.match(c.reason, /配音/);

  const done = {
    storyboard: { status: "skipped" }, keyframe: { status: "completed" },
    video: { status: "completed", approved: true },
    voice: { status: "completed" }, sfx: { status: "skipped" }, qc: { status: "completed" },
  };
  assert.equal(shotComplete(done).complete, true, "按设计跳过的那一步算已了结");
});

test("依赖关系是数据：加一个假 stage 只需加一行，判定代码不动", () => {
  // 这就是「以后加 Lip Sync / BGM / Retake 不会把状态机推翻」的可执行证明。
  const withLipSync = {
    ...STAGE_DEPENDENCIES,
    lipSync: [{ on: "video", satisfiedBy: ["completed"] }],
  };
  const blocked = canStart("lipSync", { video: { status: "not_started" } }, { dependencies: withLipSync });
  assert.equal(blocked.ok, false);
  const open = canStart("lipSync", { video: { status: "completed" } }, { dependencies: withLipSync });
  assert.equal(open.ok, true);
});

test("看不懂的前置条件名 fail-closed —— 绝不当成已满足", () => {
  const weird = { x: [{ on: "video", satisfiedBy: ["某个我们不认识的条件"] }] };
  const r = canStart("x", { video: { status: "completed", approved: true } }, { dependencies: weird });
  assert.equal(r.ok, false, "它真的会拒绝");
});

test("stageBoard 把状态与「能不能开工」一次给全", () => {
  const stages = {};
  skipStage(stages, "shot-a", "storyboard", "t1");
  const board = stageBoard(stages, "shot-a", { fact: (n) => (n === "dialogue" ? "completed" : null) });
  assert.equal(board.storyboard.status, "skipped");
  assert.equal(board.storyboard.statusLabel, "按设计跳过");
  assert.equal(board.keyframe.ok, true, "草图跳过了，关键帧可以开工");
  assert.equal(board.video.ok, false, "关键帧还没好，视频不能开工");
  assert.equal(board.voice.ok, true, "台词已确认，配音可以开工");
  // 同一块板，台词没定的时候配音就开不了工
  const noLine = stageBoard(stages, "shot-a", {});
  assert.equal(noLine.voice.ok, false);
});

test("非 stage 的事实不混进六个 stage 的清单里", () => {
  assert.deepEqual(FACTS, ["dialogue"]);
  assert.equal(STAGES.includes("dialogue"), false, "台词不是第七个制作环节");
  const st = stageStatuses({}, "shot-a", { fact: () => "completed" });
  assert.equal(st.dialogue.status, "completed");
  // 但它确实和 stage 放在同一张表里，所以 canStart 只查表
  assert.equal(canStart("voice", st).ok, true);
});

/* ========================================================================= */
/* 4 + 6. 批准绑产物；shotStage 汇总                                          */
/* ========================================================================= */

function prod(over = {}) {
  return { shotProduction: { ...defaultShotProduction(), ...over } };
}

test("换掉产物，原来的确认自动失效 —— 批准绑的是那一张，不是那个 stage", () => {
  const p = prod();
  approveShot(p, "shot-a", "img-1", "t1");
  const stages = p.shotProduction.stages;
  const withV1 = stageStatuses(stages, "shot-a", {
    artifact: (s) => (s === "storyboard" ? { assetId: "img-1", present: true } : null),
    approvedFor: (id) => id === "img-1",
  });
  assert.equal(withV1.storyboard.approved, true);
  assert.equal(canStart("keyframe", withV1).ok, true);

  // 重出一张草图 → 同一个 stage，另一张图
  const withV2 = stageStatuses(stages, "shot-a", {
    artifact: (s) => (s === "storyboard" ? { assetId: "img-2", present: true } : null),
    approvedFor: (id) => id === "img-1",
  });
  assert.equal(withV2.storyboard.approved, false, "它真的会让旧的确认失效");
  assert.equal(canStart("keyframe", withV2).ok, false, "闸门随之关上");
});

test("shotStage 是六个 stage 的汇总，五档词汇一个不改", () => {
  assert.equal(summarizeStages({}), "todo-design");
  assert.equal(summarizeStages({}, { designed: true }), "todo-generate");
  assert.equal(summarizeStages({ keyframe: { status: "completed" } }), "generated");
  assert.equal(summarizeStages({ video: { status: "completed", approved: false } }), "todo-review");
  assert.equal(summarizeStages({ video: { status: "completed", approved: true } }), "approved");
});

test("汇总没有第二条路径：shotStage 的答案与它自己的 stage 视图一致", () => {
  const p = prod();
  approveShot(p, "shot-a", "vid-1", "t1");
  const shot = { shotId: "shot-a", description: "白天，工位" };
  const media = { image: true, video: true, videoAssetId: "vid-1" };
  assert.equal(shotStage(p, shot, media), "approved");
  assert.equal(
    summarizeStages(stagesFromMedia(p, shot, media), { designed: true }),
    shotStage(p, shot, media),
    "两者必须永远相等 —— 否则就是又一份计算",
  );
  // 换一版视频，确认失效
  assert.equal(shotStage(p, shot, { image: true, video: true, videoAssetId: "vid-2" }), "todo-review");
});

test("媒体图答不上来的 stage 老实说 not_started，不猜成进行中", () => {
  const p = prod();
  const st = stagesFromMedia(p, { shotId: "shot-a" }, { image: true });
  assert.equal(st.keyframe.status, "completed");
  assert.equal(st.storyboard.status, "not_started");
  assert.equal(st.voice.status, "not_started");
  assert.equal(st.sfx.status, "not_started");
});

test("跳过的记录跟着 shotProduction 一起往返，其余状态一个都存不下来", () => {
  const p = prod();
  skipStage(p.shotProduction.stages, "shot-a", "storyboard", "t1", "轻量模式");
  const round = sanitizeShotProduction(JSON.parse(JSON.stringify(p.shotProduction)));
  assert.deepEqual(round.stages, { "shot-a": { storyboard: { skipped: { at: "t1", reason: "轻量模式" } } } });
});

/* ========================================================================= */
/* 7. 新增 kind 的消费者 —— 派生守卫                                          */
/* ========================================================================= */

test("storyboard / keyframe 是两个新的图像 kind", () => {
  assert.ok(ASSET_KINDS.includes("storyboard"));
  assert.ok(ASSET_KINDS.includes("keyframe"));
  assert.equal(KIND_DOMAIN.storyboard, "images");
  assert.equal(KIND_DOMAIN.keyframe, "images");
  assert.deepEqual(SHOT_PICTURE_KINDS, ["shot-image", "storyboard", "keyframe"]);
});

test("**派生守卫**：每个 kind 都有标签、有允许的媒体域 —— 不是一张「记得改三处」的清单", () => {
  for (const k of ASSET_KINDS) {
    assert.equal(typeof ASSET_KIND_LABEL[k], "string", `${k} 没有标签`);
    assert.ok(
      KIND_DOMAIN[k] || (KIND_DOMAINS[k] && KIND_DOMAINS[k].length),
      `${k} 没有声明允许的媒体域`,
    );
  }
});

/**
 * 只有「全部」找得到的 kind —— **显式列出并说明**，不是静默通过。
 *
 * `derived-frame`（从视频里切出来的一帧）今天没有任何具体筛选认领它。这是**本卡
 * 之前就存在的缺口**，TASK-098 只把它记下来（Follow-up），不顺手改：动它要先决定
 * 「切出来的帧算不算镜头图片」，那是一个产品判断，不是一次筛选修补。
 */
const ONLY_UNDER_ALL = new Set(["derived-frame"]);

test("**派生守卫**：每个 kind 都能被一个**具体**筛选找到 —— 「全部」不算", () => {
  // 「全部」对每个 kind 都返回真，所以把它算进来这条守卫**永远不会失败**。
  // TASK-098 的变异验证抓到了这一点：把「镜头视频」那条筛选删掉，守卫照样全绿
  // —— 它当时只是在证明 `matchesType("all")` 返回真（§2.5d「过严的守卫等于没有
  // 守卫」的镜像：**过松的守卫同样等于没有守卫**）。
  //
  // 而且一个几百条的库里，「全部」本来就不是找到某个东西的方式。
  const names = { character: () => "", location: () => "", episode: () => "", scene: () => "", shot: () => "" };
  const filters = TYPE_FILTERS.map(([k]) => k).filter((k) => k !== "collection" && k !== "all");
  assert.ok(!filters.includes("all"), "「全部」必须排除，否则这条守卫恒真");
  const kinds = ASSET_KINDS.filter((k) => KIND_DOMAIN[k] || (KIND_DOMAINS[k] || []).length);
  assert.equal(kinds.length, ASSET_KINDS.length, "每个 kind 都要声明媒体域");
  for (const kind of kinds) {
    const domains = KIND_DOMAIN[kind] ? [KIND_DOMAIN[kind]] : KIND_DOMAINS[kind];
    const found = filters.some((type) => domains.some((domain) => {
      const asset = {
        assetId: `a-${kind}`, key: `k-${kind}`, kind, domain,
        tags: [], links: {}, current: true, reusable: false,
      };
      return libraryModel({
        assets: [asset], usage: new Map(), names,
        filters: { type, variant: "all" },
      }).rows.some((r) => r.kind === kind);
    }));
    if (ONLY_UNDER_ALL.has(kind)) {
      // 例外也要钉住：哪天有人给它接上筛选，这条会红，提醒把它从例外表里删掉。
      assert.ok(!found, `${kind} 已经能被具体筛选找到了 —— 把它从 ONLY_UNDER_ALL 里删掉`);
      continue;
    }
    assert.ok(found, `${kind}（${domains.join("|")}）没有任何具体筛选能找到它 —— 它在资产库里等于隐形`);
  }
});

test("**运镜预览是自己的 kind**，而不是又一条镜头视频（TASK-098 §5.4）", () => {
  assert.ok(ASSET_KINDS.includes("motionpreview"));
  assert.equal(KIND_DOMAIN.motionpreview, "videos");
  assert.equal(ASSET_KIND_LABEL.motionpreview, "运镜预览");
  // 资产库找得到它…
  assert.ok(SHOT_VIDEO_LIBRARY_KINDS.includes("motionpreview"));
  // …而「这一镜的画面」那一族**不含**它：白膜不是一张关键帧的替代品
  assert.ok(!SHOT_PICTURE_KINDS.includes("motionpreview"));
});

/* ========================================================================= */
/* schema v16                                                                */
/* ========================================================================= */

test("v15→v16 只加一个空容器，一个字节的旧数据都不改", () => {
  assert.equal(CANVAS_SCHEMA_VERSION, 20,
    "v17 道具（4C）/ v18 批量状态（4D）/ v19 删除 skillRunId 别名（TASK-074 §1.5）/ "
    + "v20 每一镜的白膜（TASK-123 · ADR-0094，纯加法：一张空表）");
  const doc = {
    v: 15, nodes: [],
    production: { shotProduction: { reviews: { a: { approved: true, assetId: "v1", approvedAt: null, note: "" } }, references: {} } },
  };
  MIGRATIONS[15](doc);
  assert.deepEqual(doc.production.shotProduction.stages, {});
  assert.deepEqual(doc.production.shotProduction.reviews, { a: { approved: true, assetId: "v1", approvedAt: null, note: "" } });
});

test("v16 校验拒绝任何不是「跳过决定」的 stage 记录", () => {
  // The document is built by MIGRATING a minimal v1 save, not hand-authored:
  // TASK-097 §2.6.3 第 2 条 —— 手写的 fixture 会发明字段，于是守卫在校验一个产品里
  // 不存在的世界。The migration chain produces exactly the shape the app writes.
  const base = () => {
    const doc = { v: 1, nodes: [] };
    for (let from = 1; from < CANVAS_SCHEMA_VERSION; from++) MIGRATIONS[from](doc);
    doc.v = CANVAS_SCHEMA_VERSION;
    return doc;
  };
  assert.equal(validateCanvasDoc(base()), null, "干净的文档通过");

  const stored = base();
  stored.production.shotProduction.stages = { "shot-a": { keyframe: { status: "completed" } } };
  assert.match(String(validateCanvasDoc(stored)), /skip decision/, "它真的会拒绝一个写下来的 completed");

  const unknown = base();
  unknown.production.shotProduction.stages = { "shot-a": { lipSync: { skipped: { at: "t", reason: "" } } } };
  assert.match(String(validateCanvasDoc(unknown)), /unknown stage/);

  const halfWritten = base();
  halfWritten.production.shotProduction.stages = { "shot-a": { video: { skipped: { at: "  ", reason: "" } } } };
  assert.match(String(validateCanvasDoc(halfWritten)), /no time/);
});
