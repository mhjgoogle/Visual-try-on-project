// TASK-098 白膜视频 —— 那句「运镜」读成一组数，作为规则：
//
//   1. **三种结局，不是两种**：能预览 / 认得出但做不到 / 认不出。
//      压成两种就必然在某一头说谎。
//   2. **认不出就说认不出，并列出能识别的词** —— 绝不静默给一个不动的视频（§7.2）。
//   3. **明写「固定机位」时，一个不动的视频是正确答案** —— 放行那一半必须存在
//      （§2.5d：只钉「会拒绝」的一半，就是在造一个迟早被关掉的闸门）。
//   4. **不猜**：时长读不到就不渲；方向没说就不挑一个；两个相反方向不选一个。
//   5. **裁切窗口永远在画面里** —— 对**每一种词的组合**成立，不是对我记得写下的那几种。
//   6. **不新增第七个 stage**，也不进「这一镜有没有视频」那条判定（§5.4 / §5.5）。
//
// 纯测试：无 DOM、无网络、无 ffmpeg、不花一分钱。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MOTION_TERMS, MOTION_BASE, PREVIEW_FPS, MAX_PREVIEW_SECONDS, motionVocabulary,
  parseCameraMotion, previewPlan, specContained, motionRow,
} from "../src/workflow/motionpreview.js";
// 整个模块原样传给控制器 —— 手挑几个导出等于让 fixture 发明形状（§2.6.3）
import * as motionpreviewModule from "../src/workflow/motionpreview.js";
import { CAMERA_PRESETS } from "../src/workflow/canvasgrow.js";
import { keyframeList } from "../src/workflow/keyframe.js";
import { renderKeyframeList } from "../src/ui/kflist.js";
import * as mediaref from "../src/workflow/mediaref.js";
import * as shotstage from "../src/workflow/shotstage.js";
import { gapCheck } from "../src/workflow/shotqc.js";
import * as assetreg from "../src/workflow/assetreg.js";
import { createMotionPreviewController } from "../src/controllers/motionctl.js";
import { STAGES } from "../src/workflow/shotstage.js";
import { ASSET_KINDS, KIND_DOMAIN, SHOT_PICTURE_KINDS } from "../src/workflow/assetreg.js";

const plan = (text, dur = 6) => previewPlan({ text, durationSeconds: dur });

/** 一张正式关键帧当输入。第二档（镜头图片）另有专门的用例。 */
const KF = { tier: "keyframe", url: "/api/uploads/p/kf-s1_v1.png", assetId: "a-kf" };

/* ========================================================================== */
/* 一、词汇表本身                                                              */
/* ========================================================================== */

test("词汇表是闭集，每条都说得出自己是哪一类、做不到的还要说出为什么", () => {
  const kinds = new Set(["move", "static", "unsupported", "ambiguous", "speed", "amplitude"]);
  const ids = new Set();
  for (const t of MOTION_TERMS) {
    assert.ok(kinds.has(t.kind), `${t.id} 的 kind 不在闭集里：${t.kind}`);
    assert.ok(t.words.length > 0 && t.words.every((w) => typeof w === "string" && w));
    assert.ok(!ids.has(t.id), `${t.id} 重复`);
    ids.add(t.id);
    if (t.kind === "move") {
      assert.ok(["zoom", "x", "y", "shake"].includes(t.axis), `${t.id} 没有轴`);
      assert.ok(t.dir === 1 || t.dir === -1, `${t.id} 没有方向`);
    }
    // 做不到 / 说不清的**必须**带上原因：界面要把那句话原样印出来，
    // 没有原因就只能印「不行」——那正是本卡在消除的那种回答。
    if (t.kind === "unsupported" || t.kind === "ambiguous") {
      assert.ok(typeof t.why === "string" && t.why.length > 8, `${t.id} 没有说明为什么`);
    }
    if (t.kind === "ambiguous") assert.ok(Array.isArray(t.satisfiedBy) && t.satisfiedBy.length);
    if (t.kind === "speed" || t.kind === "amplitude") {
      assert.equal(typeof t.mult, "number");
      assert.ok(t.mult > 0 && t.mult < 3);
    }
  }
});

test("**派生守卫**：能识别的词那份清单来自词汇表本身，不是手写的第二份", () => {
  const listed = new Set(motionVocabulary().flatMap((g) => g.words));
  for (const t of MOTION_TERMS) {
    if (t.kind === "unsupported" || t.kind === "ambiguous") continue;
    assert.ok(listed.has(t.words[0]), `${t.id} 的词一个都没进「能识别的词」`);
  }
  // 反方向：做不到的词**不许**出现在「能识别的词」里 —— 列出去就等于承诺能做
  for (const t of MOTION_TERMS.filter((x) => x.kind === "unsupported")) {
    for (const w of t.words) assert.ok(!listed.has(w), `${w} 被列成了能预览的词`);
  }
});

/* ========================================================================== */
/* 二、ADR-0075 的八个预设 —— 预设给词汇，白膜给反馈，两者必须对得上            */
/* ========================================================================== */

test("八个内置运镜预设，每一条都得到一个**明确**的答案（能渲 / 说清为什么不能）", () => {
  const verdicts = new Map();
  for (const p of CAMERA_PRESETS) {
    const r = plan(p.text);
    verdicts.set(p.id, r.ok);
    if (r.ok) {
      assert.ok(r.parse.summary, `${p.id} 说能渲却说不出渲了什么`);
      assert.ok(specContained(r.spec), `${p.id} 的规格越界了`);
    } else {
      assert.ok(r.reason.length > 10, `${p.id} 不能渲却说不出为什么`);
    }
  }
  // 六条能渲：左弧（退化成横移，弧形如实说没做到）· 瞳孔拉近 · 机械臂下降 ·
  // 手持跟随 · 固定机位 · 后拉揭示 · 上摇揭示
  assert.equal(verdicts.get("orbit-360"), false, "360 环绕在一张静态图上做不到");
  for (const id of ["arc-left", "push-in-eye", "crane-down", "handheld-follow",
    "static-lock", "pull-back-reveal", "tilt-up-reveal"]) {
    assert.equal(verdicts.get(id), true, `${id} 应该能渲`);
  }
});

test("左弧滑行：横移渲出来，**弧形如实说没做到** —— 不拿平移冒充弧线", () => {
  const r = plan(CAMERA_PRESETS.find((p) => p.id === "arc-left").text);
  assert.ok(r.ok);
  assert.equal(r.parse.summary, "向左");
  assert.ok(r.spec.center.fromX > r.spec.center.toX, "向左：中心点要往左走");
  assert.deepEqual(r.parse.notApplied.map((n) => n.id), ["arc"]);
  assert.ok(r.caveats.some((c) => c.includes("没做到：弧形滑行")));
});

test("360 环绕：**不渲**，而且说出来为什么 —— 一段横移不是环绕", () => {
  const r = plan(CAMERA_PRESETS.find((p) => p.id === "orbit-360").text);
  assert.equal(r.ok, false);
  assert.equal(r.spec, null);
  assert.match(r.reason, /环绕/);
  assert.match(r.reason, /纵深/);
});

/* ========================================================================== */
/* 三、「不动」的两个方向（§7.2 · §2.5d）                                       */
/* ========================================================================== */

test("认不出的运镜：**不渲**，并列出能识别的词", () => {
  for (const text of ["无人机俯冲下坠", "阿巴阿巴", "长焦压缩，浅景深", "升格 120fps"]) {
    const r = plan(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.spec, null, text);
    assert.match(r.reason, /认出/, text);
    // 「列出能识别的词」是验收标准的一半，不是一句安慰
    const words = r.parse.vocabulary.flatMap((g) => g.words);
    for (const w of ["推近", "后拉", "向左摇", "上摇", "手持微晃", "固定机位", "缓慢"]) {
      assert.ok(words.includes(w), `${text}：能识别的词里没有「${w}」`);
    }
  }
});

test("只写了速度 / 幅度：说清缺的是**动作**，不说「一个词都没认出来」", () => {
  for (const text of ["缓慢", "轻微", "极缓慢，大幅"]) {
    const r = plan(text);
    assert.equal(r.ok, false, text);
    assert.match(r.reason, /只写了速度/, text);
    assert.doesNotMatch(r.reason, /一个能预览的词都没认出来/, text);
  }
  // 而真正一个词都没认出来时，那句话仍然要出现（反方向）
  assert.match(plan("阿巴阿巴").reason, /一个能预览的词都没认出来/);
});

test("明写「固定机位」：**渲一个不动的视频，这是对的答案**（放行那一半）", () => {
  for (const text of ["固定机位", "固定特写，浅景深。", "过肩固定。",
    "镜头完全静止，不推不摇；画面内的运动全部来自被摄主体"]) {
    const r = plan(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.spec.still, true, text);
    assert.equal(r.spec.zoom.from, r.spec.zoom.to, text);
    assert.equal(r.spec.center.fromX, 0.5, text);
    assert.equal(r.spec.shake, null, text);
    assert.match(r.parse.summary, /画面不动是对的/, text);
  }
});

test("否定要被看见 —— **两字否定也算**（codex 轮 1 的 P1）", () => {
  // 第一版只看紧邻的一个字符，于是「不要推近」里的「推近」前面是「要」→ 被渲成一次
  // 推镜。**一句明确禁止的运镜被反向渲染出来，比「认不出」坏得多。**
  for (const text of [
    "不推不摇", "不要推近", "不用推近", "无需推近", "没有移动",
    "不再晃动", "禁止晃动", "避免推近", "切勿摇动", "别再晃动",
  ]) {
    const r = parseCameraMotion(text);
    assert.deepEqual(r.applied, [], `${text}：否定没被看见`);
    assert.equal(r.staticDeclared, true, text);
    assert.equal(r.renderable, true, text);
    assert.match(r.summary, /画面不动是对的/, text);
  }
  // **反方向同样要钉**（§2.5d）：没有否定的时候它必须照常认出来
  assert.equal(parseCameraMotion("缓慢推近").applied.length, 1);
  assert.equal(parseCameraMotion("轻微晃动").applied.length, 1);
  // 而一个隔得远的「不」**不许**去否定后面的运镜 —— 那是另一个方向的谎
  const far = parseCameraMotion("构图不错，缓慢推近");
  assert.equal(far.applied.length, 1, "远处的「不」把推镜否定掉了");
  assert.equal(far.applied[0].id, "push");
});

test("否定**跨过修饰词**才算看见 —— 「不要缓慢推近」（codex 轮 2 的 P1）", () => {
  // 轮 1 的修法只让否定作用于**紧接着的那一个词条**，于是「缓慢」把否定吃掉了，
  // 「推近」照样渲了出来 —— 一句明确禁止的运镜再一次被反向渲染。
  // 修饰词自己渲不出任何东西，它没资格用掉一个否定。
  for (const text of [
    "不要缓慢推近", "不要大幅快速推近", "不用轻微晃动", "没有缓慢移动",
    "不要缓慢地推近", "不要太快推近", "别再剧烈晃动",
  ]) {
    const r = parseCameraMotion(text);
    assert.deepEqual(r.applied, [], `${text}：否定被修饰词吃掉了`);
    assert.equal(r.staticDeclared, true, text);
  }
  // **反方向**：没有否定时，修饰词照常起作用（幅度真的变了）
  const slow = plan("缓慢推近").spec.zoom.to;
  const fast = plan("快速推近").spec.zoom.to;
  assert.ok(fast > slow, "修饰词不起作用了");
  // 而「不断 / 不停 / 不住」整体是「持续地」，**不是**一次否定 —— 不许读反
  for (const text of ["不断推近", "不停推近", "不住推近"]) {
    const r = parseCameraMotion(text);
    assert.equal(r.applied.length, 1, `${text}：被误当成否定了`);
    assert.equal(r.applied[0].id, "push", text);
  }
  // 隔着标点的「不」仍然不许伸手过去
  assert.equal(parseCameraMotion("构图不错，缓慢推近").applied.length, 1);
});

test("**派生守卫**：会渲染的那一档里没有单字词（codex 轮 1 的 P1）", () => {
  // 第一版收了「推」「拉」，于是「固定机位，人物推门」被读成一次推镜 —— 一个**主体
  // 动作**被渲染成相机运动。修法不是列排除清单（手写枚举不收敛），是整类去掉。
  for (const t of MOTION_TERMS.filter((x) => x.kind === "move")) {
    for (const w of t.words) {
      assert.ok(w.length >= 2, `${t.id} 收了单字词「${w}」—— 一个汉字不足以让镜头动起来`);
    }
  }
  // 于是主体动作不再被误报成相机运动，而同句话里的「固定机位」照样成立
  const r = plan("固定机位，人物推门");
  assert.ok(r.ok);
  assert.equal(r.spec.still, true, "人物推门被渲成了一次推镜");
  // 而真正的运镜写法仍然认得出（放行那一半）
  assert.ok(plan("缓慢推近").parse.applied.some((a) => a.id === "push"));
  assert.ok(plan("匀速后拉").parse.applied.some((a) => a.id === "pull"));
  // 单字的「摇」「移」留在**永不渲染**的那一档，所以最坏只是一句提示
  const bare = parseCameraMotion("摇头");
  assert.deepEqual(bare.applied, []);
  assert.deepEqual(bare.notApplied.map((n) => n.id), ["pan-any"]);
});

test("「固定机位缓慢上摇」：固定说的是机位，不是画面 —— 上摇照渲", () => {
  const r = plan("固定机位缓慢上摇，从积水倒影摇到招牌本体。");
  assert.ok(r.ok);
  assert.equal(r.parse.summary, "向上");
  assert.equal(r.spec.still, false);
  assert.ok(r.spec.center.fromY > r.spec.center.toY, "上摇：视窗要往上走");
  // 后半句那个第二个「摇」已经被「上摇」交代过了，不许再报一条「没说方向」
  assert.deepEqual(r.parse.notApplied, []);
});

test("方向没说：**不挑一个**，说清缺什么 —— 但同句话里已有方向词时不再啰嗦", () => {
  const bare = plan("缓慢横移");
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /向左还是向右/);
  // 有别的可渲染成分时，它渲那一部分，并如实说这一条没做到
  const withShake = plan("手持中景，极缓慢横移。");
  assert.ok(withShake.ok);
  assert.equal(withShake.parse.summary, "手持微晃");
  assert.deepEqual(withShake.parse.notApplied.map((n) => n.id), ["track-h"]);
  // 补上方向 → 同一句话立刻变成可渲染的（这正是这条提示存在的目的）
  const fixed = plan("手持中景，极缓慢向左横移。");
  assert.ok(fixed.ok);
  assert.ok(fixed.parse.applied.some((a) => a.id === "pan-left"));
});

test("同一根轴上两个相反方向 = 一次冲突，**不挑先发生的那个**", () => {
  for (const [text, ids] of [
    ["先推近再后拉", ["conflict-zoom"]],
    ["向左摇再向右摇", ["conflict-x"]],
    ["上摇然后下摇", ["conflict-y"]],
  ]) {
    const r = plan(text);
    assert.equal(r.ok, false, text);
    assert.deepEqual(r.parse.notApplied.map((n) => n.id), ids, text);
    assert.match(r.reason, /不猜哪个先发生/, text);
  }
});

/* ========================================================================== */
/* 四、数值规格                                                                */
/* ========================================================================== */

test("预览时长 == 这一镜的时长（§9），而且**读不到时长就不渲**", () => {
  for (const [dur, frames] of [[6, 150], [10, 250], [8, 200], [2.5, 63]]) {
    const r = plan("缓慢推近", dur);
    assert.ok(r.ok, String(dur));
    assert.equal(r.spec.fps, PREVIEW_FPS);
    assert.equal(r.spec.frames, frames, `${dur}s`);
  }
  // 上限与**服务端那道帧数上限**说同一件事：不然界面会亮着按钮而后端 400
  assert.equal(plan("缓慢推近", MAX_PREVIEW_SECONDS).ok, true);
  const tooLong = plan("缓慢推近", MAX_PREVIEW_SECONDS + 0.5);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /最长/);
  // 别处有一句「6 或 10，其他一律当 6」的兜底 —— 放在这里等于让一条 8 秒的镜头
  // 渲出 6 秒然后声称等长。读不到就是读不到。
  for (const bad of [null, undefined, 0, -1, NaN, "6", Infinity]) {
    const r = previewPlan({ text: "缓慢推近", durationSeconds: bad });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.reason, /时长/, String(bad));
  }
});

test("速度词与幅度词改变走多远，而**取最极端的那一个，不相乘**", () => {
  const d = (text) => {
    const s = plan(text).spec;
    return Math.round((s.zoom.to / s.zoom.from - 1) * 1000) / 1000;
  };
  assert.equal(d("推近"), MOTION_BASE.zoom);
  assert.ok(d("极缓慢推近") < d("缓慢推近"));
  assert.ok(d("缓慢推近") < d("推近"));
  assert.ok(d("快速推近") > d("推近"));
  // 「缓慢」与「极缓慢」是同一件事的两种说法 —— 相乘会得到一个谁都没要求的数
  assert.equal(d("极缓慢推近"), d("缓慢，极缓慢推近"));
});

test("**派生守卫**：裁切窗口在**每一种词的组合**下都落在画面里", () => {
  // 不是「我记得写下的那几种」：对着词汇表本身穷举 move 的组合 × 速度 × 幅度。
  const moves = MOTION_TERMS.filter((t) => t.kind === "move");
  const mods = ["", "极缓慢", "缓慢", "匀速", "快速", "急速", "轻微", "大幅", "急速大幅"];
  let checked = 0;
  for (const a of moves) {
    for (const b of moves) {
      // 同轴反向是冲突（另有测试），跳过它 —— 它本来就不产出规格
      if (a.axis === b.axis && a.dir !== b.dir) continue;
      for (const mod of mods) {
        const r = plan(`${mod}${a.words[0]}${b.words[0]}`);
        if (!r.ok) continue;
        checked += 1;
        assert.ok(
          specContained(r.spec),
          `${mod}${a.words[0]}${b.words[0]} 的规格越界：${JSON.stringify(r.spec)}`,
        );
        assert.ok(r.spec.zoom.from >= 1 && r.spec.zoom.to >= 1);
        assert.ok(r.spec.frames >= 2);
      }
    }
  }
  assert.ok(checked > 300, `只验了 ${checked} 种组合，穷举没跑起来`);
});

test("要平移就得裁画幅，而这件事**说出来** —— 起止构图的相对关系仍是真的", () => {
  const pan = plan("向左摇");
  assert.ok(pan.spec.zoom.from > 1, "平移需要余量");
  assert.ok(pan.caveats.some((c) => c.includes("画幅")));
  assert.ok(pan.caveats.some((c) => c.includes("摇与移")), "摇/移同形要如实说");
  // 纯推近不需要额外余量：起点就是整幅画面
  assert.equal(plan("缓慢推近").spec.zoom.from, 1);
  // 每一份规格都带那句「白膜只回答运镜对不对」——它是这一格在成本阶梯里的位置
  assert.ok(pan.caveats.some((c) => c.includes("只回答")));
});

test("同一句话永远解析成同一组数 —— 预览必须可复现，否则改一个字看不出变化", () => {
  const a = JSON.stringify(plan("手持微晃，缓慢向左摇").spec);
  const b = JSON.stringify(plan("手持微晃，缓慢向左摇").spec);
  assert.equal(a, b);
});

test("`specContained` 两个方向都钉：越界要拒，正常幅度**必须放行**", () => {
  assert.ok(specContained(plan("向左摇").spec));
  assert.ok(specContained(plan("固定机位").spec));
  assert.ok(!specContained({ zoom: { from: 1, to: 1 }, center: { fromX: 0.3, toX: 0.7, fromY: 0.5, toY: 0.5 }, shake: null }));
  assert.ok(!specContained({ zoom: { from: 0.9, to: 1 }, center: { fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, shake: null }));
  assert.ok(!specContained(null));
});

/* ========================================================================== */
/* 五、⑤ 那张清单里的一行                                                      */
/* ========================================================================== */

test("一行分得清「开始不了」和「你要做的活」（§2.5f 第二条）", () => {
  // 没有关键帧 = 开始不了（上游缺东西）
  const noKf = motionRow({ text: "缓慢推近", durationSeconds: 6, source: null });
  assert.equal(noKf.canPreview, false);
  assert.match(noKf.blocked, /关键帧/);
  assert.equal(noKf.todo, "", "上游缺失时不该再印一条待办");
  // 有图、没写运镜 = 你要做的活（**不是**拦住你的理由）
  const noText = motionRow({ text: "", durationSeconds: 6, source: KF });
  assert.equal(noText.canPreview, false);
  assert.equal(noText.blocked, "");
  assert.match(noText.todo, /写一句运镜/);
  // 齐了 = 能点
  const ready = motionRow({ text: "缓慢推近", durationSeconds: 6, source: KF });
  assert.equal(ready.canPreview, true);
  assert.ok(ready.spec);
});

test("输入档次：**退一档可以，静默退一档不行**（SOURCE_TIERS）", () => {
  // 首选正式关键帧 —— 不加任何注记
  const kf = motionRow({ text: "缓慢推近", durationSeconds: 6, source: KF });
  assert.equal(kf.sourceTier, "keyframe");
  assert.equal(kf.sourceLabel, "正式关键帧");
  assert.equal(kf.sourceNote, "");
  // 退到镜头图片：**照样能渲**（否则功能在每个现有真实项目上都是死的）……
  const img = motionRow({
    text: "缓慢推近", durationSeconds: 6,
    source: { tier: "shot-image", url: "/api/uploads/p/assets-v1-1_v1.png" },
  });
  assert.equal(img.canPreview, true);
  assert.equal(img.sourceLabel, "镜头图片");
  // ……而且这件事**说出来**，就在 caveats 的第一条
  assert.match(img.sourceNote, /不是正式关键帧/);
  assert.equal(img.caveats[0], img.sourceNote);
  // 认不出的档次不算档次（fail-closed，不猜一个）
  for (const bad of [{ tier: "storyboard", url: "x" }, { tier: "", url: "x" }, {}, null]) {
    const r = motionRow({ text: "缓慢推近", durationSeconds: 6, source: bad });
    assert.equal(r.canPreview, false, JSON.stringify(bad));
    assert.equal(r.sourceTier, null, JSON.stringify(bad));
    assert.match(r.blocked, /还没有画面/, JSON.stringify(bad));
  }
});

test("已经渲过的那一段挂在行上；一个没有 url 的「预览」不算预览", () => {
  const withPrev = motionRow({
    text: "缓慢推近", durationSeconds: 6, source: KF,
    preview: { url: "/api/uploads/p/motion-s1_v2.mp4", version: 2 },
  });
  assert.equal(withPrev.preview.version, 2);
  for (const bad of [null, {}, { url: "" }, { version: 3 }]) {
    assert.equal(motionRow({ text: "推近", durationSeconds: 6, source: KF, preview: bad }).preview, null);
  }
});

test("清单顶部那几个数就是**运镜填充率** —— 0/60 那个数字的对照面", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const rows = ids.map((shotId) => ({ shotId, state: "completed", approved: true }));
  const texts = { s1: "缓慢推近", s2: "环绕一周", s3: "", s4: "缓慢后拉", s5: "匀速向左摇" };
  // s4 已经看过白膜且**对得上**；s5 那段是上一版运镜渲的（身份对不上）
  const s4stamp = motionRow({ text: texts.s4, durationSeconds: 6, source: KF }).stamp;
  const previews = {
    s4: { url: "/api/uploads/p/motion-s4_v1.mp4", version: 1, stamp: s4stamp },
    s5: { url: "/api/uploads/p/motion-s5_v1.mp4", version: 1, stamp: "deadbeef" },
  };
  const m = keyframeList({
    rows,
    keyframeOf: () => ({ present: true, assetId: "kf", approved: true }),
    motionOf: (shotId, ev) => motionRow({
      text: texts[shotId], durationSeconds: 6,
      source: ev.hasKeyframe ? KF : null,
      preview: previews[shotId] || null,
    }),
  });
  assert.equal(m.motion.total, 5);
  assert.equal(m.motion.written, 4, "s3 没写");
  assert.equal(m.motion.previewable, 3, "s1 / s4 / s5 能渲");
  // **三种结局在指标上也是三个数**：s2（环绕）是「认得出但做不到」，
  // 不是「认不出」—— 并成一个数就把本卡最核心的那条区分抹掉了
  assert.equal(m.motion.unsupported, 1, "s2 应该算「认得出但白膜做不到」");
  assert.equal(m.motion.unreadable, 0, "s2 不是「认不出」");
  // **只数对得上的那些**：把 s5 算进「已看过白膜」就是一个说谎的计数 ——
  // 创作者会以为那一镜确认过了
  assert.equal(m.motion.previewed, 1, "只有 s4 那段对得上");
  assert.equal(m.motion.previewStale, 1, "s5 那段该被点出来");
  assert.equal(m.rows[0].motion.canPreview, true);
});

test("没有 `motionOf` 时清单照常工作 —— 白膜是加法，不是新的前置", () => {
  const m = keyframeList({
    rows: [{ shotId: "s1", state: "skipped" }],
    keyframeOf: () => null,
  });
  assert.equal(m.total, 1);
  assert.equal(m.rows[0].motion, null);
  assert.deepEqual(m.motion, {
    total: 1, written: 0, previewable: 0, previewed: 0, previewStale: 0,
    unreadable: 0, unsupported: 0,
  });
});

/* ========================================================================== */
/* 六、它是预览，不是产物（§5.4 · §5.5）                                        */
/* ========================================================================== */

test("**不新增第七个 stage** —— TASK-092 那六个是唯一真相，消费者一个都不用改", () => {
  assert.deepEqual(STAGES, ["storyboard", "keyframe", "video", "voice", "sfx", "qc"]);
  assert.equal(STAGES.length, 6);
  assert.ok(!STAGES.includes("motionpreview"));
  assert.ok(!STAGES.includes("motionPreview"));
});

test("**白膜进不了「这一镜有没有视频」那条判定**（§5.4 的守卫，走生产那几个函数）", () => {
  // 「这一镜有没有视频」= `mediaref.currentRef(registry.videos, slot)`，也就是
  // `app.js` 的 `mediaOf` 读的那一份，也是 TASK-092 的 `video` stage 与逐镜质检
  // 的成片判定读的那一份。白膜住在 `motion-<slot>`，两者永不相遇 ——
  // 这条守卫钉的就是「永不相遇」，而不是「我记得它们不同名」。
  const videos = {};
  const slot = "v1-1";
  // 先证明这条判定**是活的**：往镜头视频那条链写一版，它就该看得见
  mediaref.addVersion({ uploads: videos }, slot, {
    slot_id: slot, origin: "upload", version: 1, url: "/api/uploads/p/shot01_v1.mp4",
    kind: "shot-video",
  });
  assert.ok(mediaref.currentRef(videos, slot), "镜头视频那条链本来就该被看见");

  // 换一个干净的登记表，只放白膜 —— 这一镜就**没有**视频
  const only = {};
  mediaref.addVersion({ uploads: only }, `motion-${slot}`, {
    slot_id: `motion-${slot}`, origin: "motion", version: 1,
    url: "/api/uploads/p/motion-v1-1_v1.mp4", kind: "motionpreview",
  });
  assert.equal(mediaref.currentRef(only, slot), null, "白膜被当成了这一镜的视频");
  assert.ok(mediaref.currentRef(only, `motion-${slot}`), "白膜自己那条链要找得到");

  // 而 `video` 这个 stage 因此仍然是「还没开始」—— 逐镜质检的缺口读的正是它
  const board = shotstage.stageBoard({}, "s1", {
    artifact: (stage) => (stage === "video"
      // 生产里这个证据来自 `mediaOf`，所以这里也走同一条查找
      ? (mediaref.currentRef(only, slot) ? { assetId: "x", present: true } : null)
      : null),
  });
  assert.equal(board.video.status, "not_started", "白膜把 video stage 点亮了");
  const gaps = gapCheck([{ key: "video", phase: "not_started", label: "视频" }]);
  assert.ok(gaps, "缺口判据要给得出结论");
});

test("`motionpreview` 是自己的 kind，且**不在**「这一镜的画面」那一族里", () => {
  assert.ok(ASSET_KINDS.includes("motionpreview"));
  assert.equal(KIND_DOMAIN.motionpreview, "videos");
  // 混进画面那一族 = 一段白膜可以顶替一张关键帧
  assert.ok(!SHOT_PICTURE_KINDS.includes("motionpreview"));
});


/* ========================================================================== */
/* 七、控制器写到哪儿去 —— 用**生产那一个控制器**，不是一个等价物                */
/* ========================================================================== */

/**
 * 装一个真的 `motionPreviewController`，只把 ffmpeg 与网络换成假的。
 *
 * 为什么非这样不可：上一条守卫钉的是 `mediaref` 的链分离**机制**，而「白膜该写到
 * 哪条链」这个**决定**在控制器里。把 `chainKey` 改成镜头自己的槽位（也就是让白膜
 * 直接变成这一镜的视频），那条守卫**照样全绿** —— 变异验证抓到的，正是
 * TASK-097 §2.5k 第一条那个形状：守卫没接到做决定的那一处。
 */
function realController({
  registry, shot, keyframe = null, shotImage = null, response = null,
  // 「等待期间换项目」用这两个模拟：`switchTo` 一被设置，`projectName()` 就换人，
  // 而 `registry()` 这个 **getter** 也跟着指向新项目的登记表 —— 与 app.js 里那个
  // 模块级 `let` 换项目时发生的事完全同形。
  switchTo = null, otherRegistry = null,
} = {}) {
  const toasts = [];
  let project = "p";
  const api = createMotionPreviewController({
    docs: { registry: () => (project === "p" ? registry : otherRegistry) },
    modules: { motionpreview: motionpreviewModule, mediaref, assetreg },
    findShot: () => shot,
    slotOf: (s) => (s ? s.slot : null),
    keyframeOf: () => keyframe,
    shotImageOf: () => shotImage,
    contextOfShot: () => ({ shotId: shot ? shot.shotId : null }),
    session: { connected: () => true, projectName: () => project },
    renderMotionPreview: async (proj, slug, image, spec) => {
      api._sent = { project: proj, slug, image, spec };
      // 请求**进行中**换项目，正是那个竞态发生的时刻
      if (switchTo) project = switchTo;
      if (!response) throw new Error("boom");
      return response;
    },
    refreshType: () => {}, persist: () => {}, refresh: () => {},
    toast: (t) => toasts.push(t),
  });
  api._toasts = toasts;
  return api;
}

const SHOT = { shotId: "s1", slot: "v1-1", title: "招牌 · 雨夜", duration_seconds: 6, cameraMotion: "缓慢推近" };
const KFRAME = { present: true, url: "/api/uploads/p/kf-s1_v1.png", assetId: "a-kf" };
const KFRAME_AS_SOURCE = { tier: "keyframe", url: KFRAME.url };
const OK_RESPONSE = {
  url: "/api/uploads/p/motion-v1-1_v1.mp4", version: 1, sha256: "d".repeat(64),
  duration: 6, frames: 150, fps: 25, width: 1280, height: 720, source: "kf-s1_v1.png",
};

test("**控制器把白膜写在 `motion-<slot>`，而这一镜的视频那条链一动不动**（§5.4）", async () => {
  const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const api = realController({ registry, shot: SHOT, keyframe: KFRAME, response: OK_RESPONSE });
  const ref = await api.render("s1");
  assert.ok(ref, api._toasts.join(" | "));
  // 它送给后端的名字必须落在保留命名空间里（后端也会再挡一次）
  assert.equal(api._sent.slug, "motion-v1-1");
  assert.equal(api._sent.image, "kf-s1_v1.png");
  // 写进去的是自己那条链……
  assert.deepEqual(Object.keys(registry.videos), ["motion-v1-1"]);
  assert.equal(mediaref.currentRef(registry.videos, "motion-v1-1").kind, "motionpreview");
  // ……而「这一镜有没有视频」仍然是「没有」
  assert.equal(mediaref.currentRef(registry.videos, "v1-1"), null, "白膜变成了这一镜的视频");
  // 也没碰图片那条链（白膜不是这一镜的画面）
  assert.deepEqual(Object.keys(registry.images), []);
});

test("控制器这一层也拦：读不懂的运镜 / 没有画面，**一个请求都不发**", async () => {
  for (const [label, shot, kf, img] of [
    ["认不出", { ...SHOT, cameraMotion: "无人机俯冲下坠" }, KFRAME, null],
    ["环绕做不到", { ...SHOT, cameraMotion: "环绕一周" }, KFRAME, null],
    ["没写运镜", { ...SHOT, cameraMotion: "" }, KFRAME, null],
    ["读不到时长", { ...SHOT, duration_seconds: null }, KFRAME, null],
    ["没有任何画面", SHOT, null, null],
  ]) {
    const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
    const api = realController({ registry, shot, keyframe: kf, shotImage: img, response: OK_RESPONSE });
    const ref = await api.render("s1");
    assert.equal(ref, null, label);
    assert.equal(api._sent, undefined, `${label}：不该发出请求`);
    assert.deepEqual(Object.keys(registry.videos), [], label);
    assert.ok(api._toasts.length && api._toasts[0].length > 8, `${label}：要说出为什么`);
  }
});

test("后端 fail-closed 时**原样转达原因**，且什么都不登记", async () => {
  const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const api = realController({ registry, shot: SHOT, keyframe: KFRAME, response: null });
  assert.equal(await api.render("s1"), null);
  assert.deepEqual(Object.keys(registry.videos), []);
  assert.match(api._toasts.join(" "), /boom/, "后端说的原因被改写成了别的话");
});

test("退到镜头图片时，送出去的是那张图，而且 toast 说得出用了哪一档", async () => {
  const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const api = realController({
    registry, shot: SHOT, keyframe: null,
    shotImage: { url: "/api/uploads/p/assets-v1-1_v3.png", assetId: "a-img" },
    response: OK_RESPONSE,
  });
  assert.ok(await api.render("s1"));
  assert.equal(api._sent.image, "assets-v1-1_v3.png");
  assert.match(api._toasts.join(" "), /镜头图片/);
});

test("**等待期间换了项目 → 什么都不登记**（codex 轮 1 的 P1）", async () => {
  const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const other = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const api = realController({
    registry, otherRegistry: other, shot: SHOT, keyframe: KFRAME,
    response: OK_RESPONSE, switchTo: "q",
  });
  assert.equal(await api.render("s1"), null);
  // 字节渲在了项目 p 的 media/ 下 —— 那没关系（免费预览）。**不能做的是**把它登记到
  // 现在这个项目：那会让项目 q 里出现一条指着项目 p 媒体的资产。
  assert.deepEqual(Object.keys(other.videos), [], "预览被登记进了另一个项目");
  assert.deepEqual(Object.keys(registry.videos), []);
  assert.match(api._toasts.join(" "), /切到别的项目/, "要说出发生了什么");
  // 请求本身是用**开工时**那个项目名发的（不是回来时那个）
  assert.equal(api._sent.project, "p");
});

test("**改了运镜之后，旧的那段白膜不冒充当前预览**（codex 轮 1 的 P1）", async () => {
  const registry = { images: {}, videos: {}, audio: {}, firstFrames: {}, finals: {} };
  const api = realController({ registry, shot: SHOT, keyframe: KFRAME, response: OK_RESPONSE });
  assert.ok(await api.render("s1"));
  // 刚渲完 → 对得上
  const fresh = api.rowOf("s1", { hasKeyframe: true });
  assert.ok(fresh.preview);
  assert.equal(fresh.previewStale, false);
  assert.equal(fresh.previewFresh, true);
  // 改一句运镜（同一个控制器、同一份登记表）→ 那段 MP4 还在，但它**对不上了**
  SHOT.cameraMotion = "缓慢向左摇";
  try {
    const after = api.rowOf("s1", { hasKeyframe: true });
    assert.ok(after.preview, "文件还在，不该凭空消失");
    assert.equal(after.previewStale, true, "旧白膜在新摘要旁边冒充当前预览");
    assert.match(after.previewStaleWhy, /上一版/);
    assert.equal(after.previewFresh, false);
    assert.equal(after.summary, "向左", "摘要该是新的那一句");
  } finally {
    SHOT.cameraMotion = "缓慢推近";
  }
  // 换掉源图同样对不上：源图地址进了身份，而它带着版本号
  const other = motionRow({
    text: SHOT.cameraMotion, durationSeconds: 6,
    source: { tier: "keyframe", url: "/api/uploads/p/kf-s1_v2.png" },
    preview: api.previewOf("s1"),
  });
  assert.equal(other.previewStale, true, "换了关键帧，旧白膜还在冒充当前预览");
  // 同一张图 + 同一句话 → 仍然对得上（放行那一半）
  const same = motionRow({
    text: SHOT.cameraMotion, durationSeconds: 6, source: KFRAME_AS_SOURCE,
    preview: api.previewOf("s1"),
  });
  assert.equal(same.previewStale, false);
});

test("没有印身份的旧预览 → 读作「不知道」，不读作「就是当前那一版」", () => {
  const row = motionRow({
    text: "缓慢推近", durationSeconds: 6, source: KF,
    preview: { url: "/api/uploads/p/motion-v1-1_v1.mp4", version: 1 },
  });
  assert.equal(row.previewStale, true);
  assert.match(row.previewStaleWhy, /没有记下/);
  assert.equal(row.previewFresh, false);
});

/* ========================================================================== */
/* 八、那一行的动作 —— 只在真的能做的时候出现                                    */
/* ========================================================================== */

test("只能失败的按钮不出现；而能做的时候它必须在（codex 轮 4）", () => {
  const rowOf = (over) => {
    const m = motionRow({ text: "缓慢推近", durationSeconds: 6, source: KF, ...over });
    return renderKeyframeList({
      total: 1, approved: 1, made: 0, skipped: 0, notStarted: 0, todo: "",
      motion: { total: 1, written: 1, previewable: 1, previewed: 0, previewStale: 0, unreadable: 0, unsupported: 0 },
      rows: [{ shotId: "s1", seq: 1, title: "一镜", state: "approved", gateOk: true, gateReason: "", canCompose: true, motion: m }],
    });
  };
  // 能预览 → 按钮在
  assert.match(rowOf({}), /data-kfl-motion/);
  // 源图没了（但那段旧白膜还在）→ 按钮**不在**，而 `<video>` 仍然在
  const noSource = rowOf({ source: null, preview: { url: "/u/m_v1.mp4", version: 1, stamp: "x" } });
  assert.doesNotMatch(noSource, /data-kfl-motion/, "留下了一个只能失败的按钮");
  assert.match(noSource, /<video/, "已经渲出来的那一段不该消失");
  assert.match(noSource, /还没有画面/, "要说得出为什么不能重渲");
  // 时长被清空 → 同样不出现
  assert.doesNotMatch(
    rowOf({ durationSeconds: null, preview: { url: "/u/m_v1.mp4", stamp: "x" } }),
    /data-kfl-motion/,
  );
  // 运镜改成认不出的话 → 同样不出现
  assert.doesNotMatch(
    rowOf({ text: "阿巴阿巴", preview: { url: "/u/m_v1.mp4", stamp: "x" } }),
    /data-kfl-motion/,
  );
});
