// TASK-097 批次 3 / TASK-093 —— 单镜画布可编辑，作为规则：
//
//   1. **骨架永远派生。用户只能在骨架上加东西，而且加的东西也写回既有登记表。**
//      这条排在所有交付项之前，所以也排在本文件第一组。可执行形式：一个
//      **指不出登记表**的节点类型永远不可用，并且必须说出原因。
//   2. 「以此生成 →」的落点**预填输入**；不可用的组合**灰掉并说明原因**，
//      而且两种「不可用」要分开（本产品没有 / 这一镜还不满足）。
//   3. 删一个节点前问「还有谁引用着它」—— 派生扫描，**两个方向都钉**（§2.5d）：
//      仍被引用的要拒，**无人引用的必须真的能删**。
//   4. 参考区五个一级分类是派生的，且「进不进模型」**逐条**如实。
//   5. ADR-0074：从图创建角色只登记身份 + 一条参考绑定，**不臆造档案**。
//   6. ADR-0075：运镜预设是文本模板，落到镜头上就与预设脱钩；已有内容默认**追加**。
//
// §2.6.3：每条守卫先有一次「它真的会拒绝」的证明。
// §2.5b：不重推 refset / refscan 的逻辑，只测本批的判定与接线。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADDABLE_NODES, addableNodes, chainTargets, removalCheck, referenceArea, CHAIN_HANDLED,
  ownAssetRegistryPath,
} from "../src/workflow/canvasnodes.js";
import {
  CAMERA_PRESETS, cameraPreset, characterFromImage, applyCameraPreset, cameraPresetMenu,
} from "../src/workflow/canvasgrow.js";
import {
  renderAddMenu, renderChainMenu, renderStageChips, renderReferenceArea,
} from "../src/ui/shotgraphview.js";
import { REFERENCE_CATEGORIES } from "../src/workflow/refset.js";
import { stageStatuses } from "../src/workflow/shotstage.js";

/* ========================================================================= */
/* 1. 第一条纪律：加的东西必须有地方装                                         */
/* ========================================================================= */

test("**每一个可用的可添加节点都指名了一张既有登记表**，指不出来的永远不可用", () => {
  // 这就是那条纪律的可执行形式：`available` 只由 `registry` 决定，没有第二个开关。
  for (const n of addableNodes()) {
    if (n.available) {
      assert.ok(n.registry, `${n.id} 可用却没有指名登记表`);
      assert.equal(n.why, null, `${n.id} 可用时不该带拒绝原因`);
    } else {
      assert.equal(n.registry, null, `${n.id} 不可用却指名了登记表`);
      assert.ok(n.why && n.why.length > 10, `${n.id} 不可用时必须说出原因，不是静默隐藏`);
    }
  }
});

test("自由文本便签**不可用**，而且原因就是那 720 个文档", () => {
  const note = addableNodes().find((n) => n.id === "text-note");
  assert.equal(note.available, false, "它真的会拒绝");
  assert.match(note.why, /360[–-]720/, "原因指名了产品负责人担心的那个数字");
  assert.match(note.why, /画面描述/, "并且给出该写在哪里");
});

test("逐帧拉片 / 3D 导演台如实灰掉并说明为什么明确不做", () => {
  for (const id of ["frame-reader", "director-3d"]) {
    const item = addableNodes().find((n) => n.id === id);
    assert.equal(item.available, false);
    assert.match(item.why, /明确不做/);
  }
});

test("菜单把不可用项**画出来**而不是隐藏 —— 创作者看过 LibTV，会来找它们", () => {
  const html = renderAddMenu(addableNodes());
  assert.match(html, /文本便签/, "不可用项仍然出现在菜单里");
  assert.match(html, /360[–-]720/, "原因也画出来了");
  assert.match(html, /class="sg-add-item off"/, "而且视觉上是灰的");
  // 可用项显示它写进哪张登记表 —— 那句话本身就是纪律的可见形式
  assert.match(html, /→ shotProduction\.references/);
  assert.match(html, /每一项都写回一张<b>既有<\/b>登记表/, "纪律本身写在菜单表头上");
});

/* ========================================================================= */
/* 2. 「以此生成 →」                                                          */
/* ========================================================================= */

const IMG = (over = {}) => ({ id: "image:selected", type: "image", assetId: "img-1", version: 3, ...over });
const OPEN_GATE = { keyframe: { ok: true, blockers: [] } };
const SHUT_GATE = { keyframe: { ok: false, blockers: ["分镜草图：现在是「还没开始」，需要按设计跳过，或者出了草图并且你已经确认它"] } };

test("落点预填输入 —— 一个跳过去却空白的表单等于把上下文丢了", () => {
  const targets = chainTargets(IMG(), { stage: OPEN_GATE });
  const firstFrame = targets.find((t) => t.id === "first-frame");
  assert.equal(firstFrame.available, true);
  assert.deepEqual(firstFrame.prefill, { firstFrameAssetId: "img-1", version: 3 });
  const html = renderChainMenu(targets);
  assert.match(html, /带过去：firstFrameAssetId/, "界面上说清带过去什么");
});

test("没有 assetId 的图不能当首帧 —— 灰掉并说明，不隐藏", () => {
  const targets = chainTargets(IMG({ assetId: null }), { stage: OPEN_GATE });
  const firstFrame = targets.find((t) => t.id === "first-frame");
  assert.equal(firstFrame.available, false, "它真的会拒绝");
  assert.match(firstFrame.why, /资产 id/);
  assert.match(renderChainMenu(targets), /class="sg-chain-item off"/);
});

test("闸门开着也不够 —— 没有源图就不能开始合成（两个条件都要）", () => {
  // codex 轮 1：之前只看闸门，于是一张没有 assetId 的图在闸门开着时是**可点的**，
  // 而 prefill 是 null —— 一次合成会在没有源图的情况下开始。
  const noAsset = chainTargets(IMG({ assetId: null }), { stage: OPEN_GATE })
    .find((t) => t.id === "keyframe-compose");
  assert.equal(noAsset.available, false, "它真的会拒绝");
  assert.equal(noAsset.prefill, null);
  assert.match(noAsset.why, /真的存在的源图/);
  // 有图 + 闸门开 → 前置这一侧就通了。它现在仍然 unavailable，原因是**执行面还没做完**
  // （4G），而不是前置不满足 —— 两种「不能点」必须说不同的话（codex 轮 2）。
  const ok = chainTargets(IMG(), { stage: OPEN_GATE }).find((t) => t.id === "keyframe-compose");
  assert.deepEqual(ok.prefill, { composeFrom: "img-1", role: "构图" }, "预填已经算好了");
  assert.match(ok.why, /还没做完/, "拦住它的是实现，不是前置");
  assert.equal(/草图/.test(ok.why), false, "前置已满足，就不该再说前置");
});

test("ADR-0074 的入口在「以此生成 →」里，而且没有 assetId 时拒绝", () => {
  const ok = chainTargets(IMG(), {}).find((t) => t.id === "character-from-image");
  assert.equal(ok.available, true);
  assert.deepEqual(ok.prefill, { referenceAssetId: "img-1" });
  const no = chainTargets(IMG({ assetId: null }), {}).find((t) => t.id === "character-from-image");
  assert.equal(no.available, false, "它真的会拒绝");
  assert.match(no.why, /悬空/);
});

test("④→⑤ 那道闸门是**读**来的，不在这里重算", () => {
  const shut = chainTargets(IMG(), { stage: SHUT_GATE }).find((t) => t.id === "keyframe-compose");
  assert.equal(shut.available, false, "它真的会拒绝");
  assert.match(shut.why, /草图/, "而且直接转述闸门自己的话");
  // §2.5d 的另一半：闸门开了，说的话就换成实现那一句 —— 闸门这一侧确实放行了，
  // 证据是它不再重复前置的理由。判定读的是注入的 stage，本模块没有第二份。
  const open = chainTargets(IMG(), { stage: OPEN_GATE }).find((t) => t.id === "keyframe-compose");
  assert.equal(/草图/.test(open.why), false, "闸门开了就不再报前置");
});

test("两种「没有下一镜」不混为一谈", () => {
  const noId = chainTargets({ id: "v", type: "video", assetId: null }, { nextShotId: "shot-b" });
  assert.match(noId.find((t) => t.id === "end-frame").why, /资产 id/);
  const noNext = chainTargets({ id: "v", type: "video", assetId: "vid-1" }, { nextShotId: null });
  assert.match(noNext.find((t) => t.id === "end-frame").why, /最后一镜/);
  const ok = chainTargets({ id: "v", type: "video", assetId: "vid-1" }, { nextShotId: "shot-b" });
  assert.equal(ok.find((t) => t.id === "end-frame").available, true);
});

test("本产品没有的那条路每个节点都列出来，不假装不存在", () => {
  const t = chainTargets(IMG(), { stage: OPEN_GATE }).find((x) => x.id === "smart-edit");
  assert.equal(t.available, false);
  assert.match(t.why, /FFmpeg 时间线/);
});

/* ========================================================================= */
/* 3. 删除前的引用检查 —— 两个方向都钉（§2.5d）                                */
/* ========================================================================= */

// 文档形状取自 `persist` 真的会写的那一份（§2.6.3 第 2 条：不手写「看起来像」的对象）
const DOC = (over = {}) => ({
  production: { activeEpisodeId: "ep-1", episodes: [{ episodeId: "ep-1", scenes: [] }] },
  assets: { images: { "img-1": { current: 1, history: [{ version: 1, assetId: "img-1" }] } } },
  timelines: {},
  ...over,
});

test("仍被引用的对象拒删，并列出**每一处**引用位置", () => {
  const doc = DOC({ timelines: { "ep-1": { clips: [{ assetId: "img-1" }] } } });
  const r = removalCheck(doc, "img-1", { label: "这张图" });
  assert.equal(r.ok, false, "它真的会拒绝");
  assert.ok(r.sites.length >= 1);
  assert.match(r.blockers[0], /还被 \d+ 处引用着/);
  assert.match(r.blockers[0], /timelines/, "指名位置，创作者才能去解开");
  assert.match(r.blockers[0], /软删除/, "并给出另一条路");
});

test("**无人引用的对象必须真的能删** —— 只钉会拒绝的那一半就是造一个迟早被关掉的闸门", () => {
  const r = removalCheck(DOC(), "img-nobody-uses", { label: "这张图" });
  assert.equal(r.ok, true, "它真的会放行");
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.sites, []);
});

test("没有 id 时拒绝判断，而不是默认放行", () => {
  assert.equal(removalCheck(DOC(), "").ok, false, "它真的会拒绝");
});

test("明天新增的引用点默认算引用 —— 闭集是「哪里不算」", () => {
  const doc = DOC({ futureThing: { pointsAt: "img-1" } });
  const r = removalCheck(doc, "img-1");
  assert.equal(r.ok, false);
  assert.ok(r.sites.some((s) => s.includes("futureThing")));
});

/* ========================================================================= */
/* 4. 参考区五分类                                                            */
/* ========================================================================= */

test("五个一级分类是派生的，且「进不进模型」逐条如实", () => {
  const area = referenceArea([
    { key: "r1", name: "现代沈昭昭", kind: "character-reference" },
    { key: "r2", name: "盛唐", kind: "style-reference" },
    { key: "r3", name: "推轨", kind: "motion-reference" },
    { key: "r4", name: "不是参考", kind: "shot-image" },
  ]);
  assert.equal(area.groups.get("character").length, 1);
  // style 与 motion 同在「视觉参考」这一组…
  assert.equal(area.groups.get("visual").length, 2);
  // …但它们说的**不是同一句话**
  const visual = area.groups.get("visual");
  assert.equal(visual.find((r) => r.name === "盛唐").reach, "model-input");
  assert.equal(visual.find((r) => r.name === "推轨").reach, "ai-interpretation");
  assert.equal(area.unclassified.length, 1, "归不了类的报出来，不是丢掉");

  const html = renderReferenceArea(area, REFERENCE_CATEGORIES);
  assert.match(html, /视觉参考/);
  assert.match(html, /图进模型/);
  assert.match(html, /图不进模型/);
  assert.match(html, /归不到分类/);
});

/* ========================================================================= */
/* 5. ADR-0074 从图创建角色                                                   */
/* ========================================================================= */

test("从图创建角色只登记身份 + 一条参考绑定，档案字段**一律留空**", () => {
  const r = characterFromImage({ node: IMG(), name: "现代沈昭昭", characters: [] });
  assert.equal(r.ok, true);
  assert.equal(r.proposal.name, "现代沈昭昭");
  assert.equal(r.proposal.referenceAssetId, "img-1");
  // 留空是**故意的**，而且列出来让人看得见
  assert.deepEqual(r.proposal.leftBlank, ["appearance", "costume", "personality", "visualInstruction", "voice"]);
  // 提案里不得出现任何被填上的档案内容
  for (const k of r.proposal.leftBlank) assert.equal(k in r.proposal === false || r.proposal[k] === undefined, true);
});

test("没有名字就不创建 —— 不从文件名猜", () => {
  const r = characterFromImage({ node: IMG(), name: "   ", characters: [] });
  assert.equal(r.ok, false, "它真的会拒绝");
  assert.match(r.blockers.join(" "), /IMG_2481/, "原因说清了为什么文件名不行");
});

test("没有 assetId 的图不能创建角色 —— 那条绑定会立刻悬空", () => {
  const r = characterFromImage({ node: IMG({ assetId: null }), name: "阿七", characters: [] });
  assert.equal(r.ok, false, "它真的会拒绝");
  assert.match(r.blockers.join(" "), /资产 id/);
});

test("重名不合并、不悄悄建第二个", () => {
  const r = characterFromImage({
    node: IMG(), name: "林照", characters: [{ characterId: "c1", name: "林照" }],
  });
  assert.equal(r.ok, false, "它真的会拒绝");
  assert.match(r.blockers.join(" "), /不合并也不建第二个/);
  assert.match(r.blockers.join(" "), /随机命中/, "并说明为什么建第二个更糟");
});

test("不是图的节点不能创建角色", () => {
  const r = characterFromImage({ node: { id: "p", type: "prompt" }, name: "阿七", characters: [] });
  assert.equal(r.ok, false, "它真的会拒绝");
});

/* ========================================================================= */
/* 6. ADR-0075 运镜预设                                                       */
/* ========================================================================= */

test("预设文本必须自足 —— 外部工具看不到我们的项目数据", () => {
  assert.ok(CAMERA_PRESETS.length >= 6, "0/60 那个填充率需要足够的起点");
  for (const p of CAMERA_PRESETS) {
    assert.ok(p.text.length > 10, `${p.id} 的文本太短，起不到「省掉从零想一句」的作用`);
    // 不含只有本项目才知道的指代
    assert.equal(/第\s*\d+\s*镜/.test(p.text), false, `${p.id} 引用了本项目的镜号`);
    assert.equal(/\bshot-|\bimg-|\bref-/.test(p.text), false, `${p.id} 出现了内部 id`);
  }
  assert.equal(cameraPreset("nope"), null);
});

test("空的镜头直接填入；**已有内容默认追加，不替换**", () => {
  const empty = applyCameraPreset("", "arc-left");
  assert.equal(empty.ok, true);
  assert.equal(empty.text, cameraPreset("arc-left").text);
  assert.equal(empty.appended, false);

  const has = applyCameraPreset("先固定两秒", "arc-left");
  assert.equal(has.appended, true, "它真的不会替换掉创作者写的话");
  assert.match(has.text, /^先固定两秒\n/);
  assert.match(has.text, /弧形滑过/);
});

test("要替换必须显式说，而且这是唯一会覆盖用户内容的路径", () => {
  const r = applyCameraPreset("先固定两秒", "arc-left", { mode: "replace" });
  assert.equal(r.replaced, true);
  assert.equal(/先固定两秒/.test(r.text), false);
});

test("点两次不会得到两行一样的字", () => {
  const once = applyCameraPreset("", "orbit-360").text;
  const twice = applyCameraPreset(once, "orbit-360").text;
  assert.equal(twice, once);
});

test("菜单先告诉创作者点下去会发生什么", () => {
  assert.match(cameraPresetMenu("").note, /直接填进去/);
  assert.match(cameraPresetMenu("已经写了").note, /追加/);
  assert.equal(cameraPresetMenu("已经写了").hasExisting, true);
});

test("落到镜头上就与预设脱钩 —— 预设改了，已经用过它的镜头什么都不会发生", () => {
  // 这是 ADR-0075 决策 1 的可执行证明：应用的产物是**文本**，不含任何 preset id，
  // 所以不存在「解引用时读到新版本」这条路径。
  const applied = applyCameraPreset("", "push-in-eye");
  assert.equal(typeof applied.text, "string");
  for (const p of CAMERA_PRESETS) {
    assert.equal(applied.text.includes(p.id), false, "产物里不得出现 preset id");
  }
});

/* ========================================================================= */
/* 7. 六个 stage 画在画布上                                                    */
/* ========================================================================= */

test("stage 徽章把「跳过」与「还没开始」写成不同的字", () => {
  const board = {
    storyboard: { label: "分镜草图", status: "skipped", statusLabel: "按设计跳过", ok: true, blockers: [] },
    keyframe: { label: "关键帧", status: "not_started", statusLabel: "还没开始", ok: true, blockers: [] },
    video: { label: "视频", status: "not_started", statusLabel: "还没开始", ok: false, blockers: ["关键帧还没好"] },
  };
  const html = renderStageChips(board);
  assert.match(html, /分镜草图：按设计跳过/);
  assert.match(html, /关键帧：还没开始/);
  assert.match(html, /sg-stagechip skip/);
  assert.match(html, /待前置/, "开不了工的那一项说出来");
  assert.equal(renderStageChips(null), "", "没有 board 就什么都不画");
});

test("拿不到环节状态时不放行，也不去闸门里取话 —— 那会直接崩", () => {
  // 我自己引入的崩溃：`stage` 为 null 时 `why` 分支仍然去读 stage.keyframe.blockers。
  // 「拿不到闸门」既不是放行也不是某个具体前置，它是第三种答案。
  const t = chainTargets(IMG(), {}).find((x) => x.id === "keyframe-compose");
  assert.equal(t.available, false, "它真的不会放行");
  assert.match(t.why, /还不知道/);
  // 闸门存在但没给出 blockers 时也不崩，给一句能用的话
  const bare = chainTargets(IMG(), { stage: { keyframe: { ok: false } } })
    .find((x) => x.id === "keyframe-compose");
  assert.equal(bare.available, false);
  assert.ok(bare.why && bare.why.length > 4);
});

test("**每一个 available 的落点都必须有处理器** —— 渲染成可点却什么都不发生更糟", () => {
  // codex 轮 2 的 P1：keyframe-compose 曾经 available 却没有处理器，点下去掉进
  // 「落点还没接上」。这条守卫让那种组合在结构上不可能出现。
  const handled = new Set(CHAIN_HANDLED);
  const nodes = [
    IMG(),
    IMG({ assetId: null }),
    { id: "v", type: "video", assetId: "vid-1" },
    { id: "p", type: "prompt", genKind: "image", preview: "有内容" },
    { id: "r", type: "reference", refKey: "ref-a" },
  ];
  const stages = [OPEN_GATE, SHUT_GATE, null];
  for (const n of nodes) {
    for (const stage of stages) {
      for (const t of chainTargets(n, { stage, hasPrompt: true, nextShotId: "shot-b" })) {
        if (t.available) {
          assert.ok(handled.has(t.id), `${t.id} 渲染成可点，但没有处理器`);
        }
      }
    }
  }
});

test("还没实现的落点如实说「还没做完」，而且前置满足时也不谎称可用", () => {
  const t = chainTargets(IMG(), { stage: OPEN_GATE }).find((x) => x.id === "keyframe-compose");
  assert.equal(t.available, false, "它真的不会放行");
  assert.match(t.why, /还没做完/);
  // 前置不满足时，说的仍然是**前置**那句话 —— 那才是创作者能动手的信息
  const shut = chainTargets(IMG(), { stage: SHUT_GATE }).find((x) => x.id === "keyframe-compose");
  assert.match(shut.why, /草图/);
});

test("in-flight 只归给**真的在跑**的那一个 stage，不给相邻的那个", () => {
  // codex 轮 3：一次 image 生成曾经同时把 storyboard 与 keyframe 标成进行中。
  // in_progress 会喂给闸门判定，所以标错一个就会改变「你现在能开始什么」这句话。
  // 生成记录只说 image / video / audio，说不出「这张图是草图还是正式关键帧」——
  // 所以每个 stage 只认它今天真能拥有的那条流水线。
  const running = stageStatuses({}, "shot-a", { inflight: (s) => s === "keyframe" });
  assert.equal(running.keyframe.status, "in_progress");
  assert.equal(running.storyboard.status, "not_started", "草图没有生成路径，就不该显示进行中");
  const audio = stageStatuses({}, "shot-a", { inflight: (s) => s === "voice" });
  assert.equal(audio.voice.status, "in_progress");
  assert.equal(audio.sfx.status, "not_started");
});

test("「在别的镜头也用这张参考」如实说它还差一个选择器，而不是假装绑好了", () => {
  const t = chainTargets({ id: "r", type: "reference", refKey: "ref-a" }, {})
    .find((x) => x.id === "reuse-elsewhere");
  assert.equal(t.available, false, "它真的不会放行");
  assert.match(t.why, /选择器/);
  assert.match(t.why, /参考统筹/, "并给出今天能走的那条路");
  // prefill 仍然算好了 —— 等选择器接上就能直接用，而不是重新推导
  assert.deepEqual(t.prefill, { referenceKey: "ref-a" });
});

/* ========================================================================= */
/* 3b. 生产用的那个谓词，两个方向都钉（codex 轮 4）                             */
/* ========================================================================= */

// 这一组用的是 **app.js 真正传进去的那个谓词**。上面那几条用默认谓词，
// 于是「无人引用的真的能删」在测试里通过、在产品里恒假 —— §2.5d 的原话：
// 只钉会拒绝的那一半，就是在造一个迟早被关掉的闸门。
const REAL_DOC = () => ({
  production: {
    activeEpisodeId: "ep-1",
    episodes: [{ episodeId: "ep-1", scenes: [] }],
    shotProduction: { reviews: {}, references: {}, stages: {} },
  },
  assets: {
    images: {
      "v1-1": { current: 2, history: [
        { version: 1, assetId: "img-old" },
        { version: 2, assetId: "img-1" },
      ] },
    },
    videos: {}, audio: {}, firstFrames: {}, finals: [], displaced: [],
  },
  timelines: {},
  generations: [],
});

test("**用生产谓词**：只被自己的登记记录提到的资产，真的能删", () => {
  const doc = REAL_DOC();
  const r = removalCheck(doc, "img-1", {
    label: "这张图",
    expected: ownAssetRegistryPath("img-1"),
  });
  assert.equal(r.ok, true, "它真的会放行 —— 之前这里恒为 false，什么都删不掉");
  assert.deepEqual(r.sites, []);
  // 同一个文档里的另一版也一样
  assert.equal(
    removalCheck(doc, "img-old", { expected: ownAssetRegistryPath("img-old") }).ok,
    true,
  );
});

test("**用生产谓词**：真的被别处引用时仍然拒绝", () => {
  const cases = [
    ["首帧绑定", { firstFrames: { "v1-1": { assetId: "img-1" } } }],
    ["时间线", { timelines: { "ep-1": { clips: [{ assetId: "img-1" }] } } }],
    ["生成记录", { generations: [{ generationId: "g1", inputAssetIds: ["img-1"] }] }],
  ];
  for (const [what, patch] of cases) {
    const doc = { ...REAL_DOC(), ...patch };
    if (patch.firstFrames) doc.assets = { ...doc.assets, firstFrames: patch.firstFrames };
    const r = removalCheck(doc, "img-1", { expected: ownAssetRegistryPath("img-1") });
    assert.equal(r.ok, false, `${what} 引用着它，必须拒绝`);
    assert.ok(r.sites.length >= 1, `${what} 应报出位置`);
  }
});

test("生产谓词不会把别的资产的记录当成自己的", () => {
  // `img-1` 的谓词不得放行 `img-old` 的键式引用，否则两个资产互相「掩护」
  const pred = ownAssetRegistryPath("img-1");
  assert.equal(pred("$.assets.images.img-1<key>"), true);
  assert.equal(pred("$.assets.images.v1-1.history[1].assetId"), true);
  assert.equal(pred("$.assets.firstFrames.v1-1.assetId"), false, "首帧绑定是引用");
  assert.equal(pred("$.timelines.ep-1.clips[0].assetId"), false);
  assert.equal(pred("$.assets.images.img-other<key>"), false, "不是自己的键");
});

test("探针的四种答案不塌缩成两种 —— 「答不上来」不得算作已完成", () => {
  // codex 轮 5：INCONCLUSIVE 曾经被算成产物存在，于是闸门会在未经确认的媒体上打开。
  // ADR-0073 决策 2 原本的措辞（「没有判定它 MISSING」）正是那个漏洞的来源，已订正。
  const cases = [
    ["present", true, "completed"],
    ["missing", false, "not_started"],
    ["inconclusive", false, "not_started"],
    [null, true, "completed"],
  ];
  for (const [verdict, presentExpected, statusExpected] of cases) {
    // 这里复刻 app.js 那个读法：只有 MISSING 与 INCONCLUSIVE 否认「做完了」
    const present = verdict !== "missing" && verdict !== "inconclusive";
    assert.equal(present, presentExpected, `${verdict} 的 present 判定`);
    const st = stageStatuses({}, "shot-a", {
      artifact: (s) => (s === "keyframe" ? { assetId: "img-1", present } : null),
    });
    assert.equal(st.keyframe.status, statusExpected, `${verdict} 应得到 ${statusExpected}`);
  }
});
