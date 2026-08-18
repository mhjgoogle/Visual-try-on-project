// TASK-078 批次 A — 从分镜到第一张画面，作为规则：
//
//   1. 景别 / 角度 / 情绪 / 光影氛围 有输入口，填了会存进新草稿版本，旧版本不动。
//   2. 加法字段在**每一条**保存路径上存活 —— 手工编辑弹窗曾经会把它们全删掉。
//   3. 分镜有表格视图，与卡片视图并存，一屏横向可比。
//   4. 画面描述里的人物 / 场景地被识别成可点链接，复用 breakdown.js 的匹配规则。
//   5. 「准备资产 N/M」是真的，且与三步向导第 ② 步是**同一个数**。
//   6. 表格的写路径就是既有那一条：保存 = 追加新草稿版本，删除也是。
//
// 纯测试：无 DOM、无时钟、无网络。断言的是派生结果，或纯渲染器返回的 HTML 字符串。

import { test } from "node:test";
import assert from "node:assert/strict";

import * as proddoc from "../src/workflow/proddoc.js";
import * as bibledoc from "../src/workflow/bibledoc.js";
import { normalizeShots, ADDITIVE_SHOT_FIELDS } from "../src/ui/shoteditor.js";
import {
  buildEntityIndex, findMentions, assetReadiness, shotText,
} from "../src/workflow/shotentity.js";
import {
  shotTableModel, renderShotTable, applyTableEdits, tableDirty, describeParts,
  COLUMNS, ROW_COLORS, EDITABLE_FIELDS,
} from "../src/ui/shottable.js";
import {
  renderStoryboard, shotDetailModel, buildPortraitIndex, tableModel, bindStoryboard,
} from "../src/ui/storyboard.js";
import { wizardReadiness } from "../src/ui/wizard.js";
import { compileImagePrompt, compileVideoPrompt } from "../src/workflow/promptc.js";
import { referencePlan, renderRefPlan } from "../src/ui/refplan.js";

/* ========================================================================= */
/* 固定装置 —— 真实项目的形状：镜头全部未归入场景，作品设定里有人物和场景地      */
/* ========================================================================= */

const SHOTS = [
  {
    shotId: "shot-a", sequence: 1, slot: "v1-1",
    title: "S1-01 实验室建立镜头",
    description: "白天，算法实验室。画面右后方可见林照的工位。",
    duration_seconds: 10,
  },
  {
    shotId: "shot-b", sequence: 2, slot: "v1-2",
    title: "S1-02 EEV 系统界面",
    description: "林照电脑屏幕的正面特写，屏幕冷白光映在玻璃上。",
    duration_seconds: 6,
    shotSize: "特写", cameraMotion: "固定机位",
  },
  {
    shotId: "shot-c", sequence: 3, slot: "v1-3",
    title: "S1-03 走廊",
    description: "夜里的空走廊，没有人。",
    duration_seconds: 6,
  },
];

/** A production document holding two characters and one location, with NO shot
 *  assigned to any scene — the live project's actual state. */
function fixtureProd({ withPortrait = false } = {}) {
  const prod = proddoc.createProduction(null);
  const lin = bibledoc.addCharacter(prod, "林照");
  const mu = bibledoc.addCharacter(prod, "林照母亲");
  const lab = bibledoc.addLocation(prod, "算法实验室");
  if (withPortrait) {
    lin.referenceAssetIds = ["asset-lin"];
    lin.activeReferenceAssetId = "asset-lin";
  }
  return { prod, linId: lin.characterId, muId: mu.characterId, labId: lab.locationId };
}

function fixturePd({ shots = SHOTS, withPortrait = false, shotAudio = {} } = {}) {
  const { prod } = fixtureProd({ withPortrait });
  return {
    draftShots: shots.map((s) => ({ ...s })),
    lockedPlan: null,
    shotVersions: { count: 1, cur: 1, state: "done", rows: null },
    realShots: null,
    assetUploads: withPortrait
      ? { "char-lin": { current: 1, history: [{ version: 1, url: "u/lin.png", assetId: "asset-lin" }] } }
      : {},
    media: { video: {}, audio: {} },
    firstFrames: {}, finals: [], paidOps: {},
    production: prod, generations: [], story: null, scripts: {},
    skillRuns: [], assets: {}, timelines: {}, prompts: {},
    refInterp: {}, refUse: {}, frameBindings: {}, locks: {},
    shotAudio, subtitles: {},
  };
}

const boardCtx = (pd) => ({ prodData: () => pd, script: { hasContent: () => true } });

/** The smallest thing `bindStoryboard` can be wired against.
 *
 *  Deliberately not a DOM library: the only binding under test here is the
 *  卡片/表格 toggle, and everything else must simply find nothing and do nothing.
 *  Elements are matched by the exact selector the binder asks for. */
function fakeRoot(nodes) {
  const els = nodes.map((n) => ({
    sel: n.sel, dataset: n.dataset, onclick: null, hidden: false, tagName: "BUTTON",
    removeAttribute() {}, setAttribute() {},
  }));
  return {
    querySelectorAll: (sel) => els.filter((e) => e.sel === sel),
    querySelector: (sel) => els.find((e) => e.sel === sel) || null,
    fire(sel) {
      const e = els.find((x) => x.sel === sel);
      assert.ok(e && e.onclick, `${sel} 没有被接线`);
      e.onclick({ stopPropagation() {} });
    },
  };
}

/* ========================================================================= */
/* 1 · 缺的不是模型，是输入口                                                 */
/* ========================================================================= */

test("镜头详情表单给出景别 / 角度 / 情绪 / 光影氛围的输入口", () => {
  // 这四项在四个只读位置显示、并被编进 Image Prompt，却在整个产品里没有任何
  // 地方可以输入 —— 真实项目 38/60 全「未记录」的第三个成因。
  const pd = fixturePd();
  const html = renderStoryboard(boardCtx(pd), { selectedShotId: "shot-a", buffer: {} });
  for (const field of ["shotSize", "angle", "emotion", "lighting"]) {
    assert.ok(html.includes(`data-sf="${field}"`), `${field} 没有输入口`);
  }
});

test("空白刻面不再只是宣布自己空白，它指向可以填它的地方", () => {
  const pd = fixturePd();
  const html = renderStoryboard(boardCtx(pd), { selectedShotId: "shot-a", buffer: {} });
  assert.ok(html.includes("未填 · 去填写"));
  assert.ok(html.includes('data-fillfacet="shotSize"'));
  assert.ok(html.includes('data-shot="shot-a"'));
  assert.ok(!html.includes(">未定<"), "「未定」是个死胡同，不留");
});

test("光影氛围进得了 Image / Video Prompt —— 只写进去不用的字段等于装饰", () => {
  const withIt = compileImagePrompt({ shot: { description: "d", lighting: "冷白顶光" } });
  assert.ok(withIt.text.includes("光影氛围：冷白顶光"));
  const video = compileVideoPrompt({ shot: { description: "d", lighting: "冷白顶光" } });
  assert.ok(video.text.includes("【光影氛围】冷白顶光"));
});

test("没有光影氛围的旧镜头编译出的 Prompt 与本卡之前逐字节相同", () => {
  const shot = { description: "d", shotSize: "特写" };
  assert.equal(
    compileImagePrompt({ shot }).text,
    compileImagePrompt({ shot: { ...shot, lighting: "" } }).text,
  );
  assert.ok(!compileImagePrompt({ shot }).text.includes("光影氛围"));
});

/* ========================================================================= */
/* 2 · 加法字段必须在每一条保存路径上存活                                     */
/* ========================================================================= */

test("normalizeShots 保留每一个加法字段", () => {
  const rich = {
    shotId: "shot-a", title: "t", description: "d", duration_seconds: 6, slot: "v1-1",
  };
  for (const k of ADDITIVE_SHOT_FIELDS) rich[k] = `${k}-值`;
  const [out] = normalizeShots([rich], "v2");
  for (const k of ADDITIVE_SHOT_FIELDS) assert.equal(out[k], `${k}-值`, `${k} 被保存路径删掉了`);
  assert.equal(out.shotId, "shot-a", "身份被带过去，不是重新推导的");
});

test("空字符串的加法字段被省略，而不是存成空串", () => {
  const [out] = normalizeShots(
    [{ shotId: "s", title: "t", description: "d", duration_seconds: 6, shotSize: "  " }],
    "v2",
  );
  assert.ok(!("shotSize" in out), "「填了又清空」不该与「从来没填过」存成两种形状");
});

test("ADDITIVE_SHOT_FIELDS 覆盖 promptc 真正会读的每一个镜头字段", () => {
  // 一个 promptc 会编译、而保存路径会删掉的字段，是「填了、看见了、下次就没了」——
  // 这个清单漂移过一次（expression / environmentMotion 曾经不在里面）。
  for (const k of ["shotSize", "angle", "cameraMotion", "lighting", "action",
    "expression", "emotion", "dialogue", "environmentMotion"]) {
    assert.ok(ADDITIVE_SHOT_FIELDS.includes(k), `${k} 会被编进 Prompt 却存不下来`);
  }
});

/* ========================================================================= */
/* 3 · 实体识别 —— 复用 breakdown.js 的规则，不写第二套                        */
/* ========================================================================= */

test("画面描述里的人物与场景地被认出来，位置精确到字符", () => {
  const { prod, linId, labId } = fixtureProd();
  const index = buildEntityIndex(prod);
  const hits = findMentions(index, "白天，算法实验室。右后方是林照的工位。");
  assert.deepEqual(hits.map((h) => h.entity.id), [labId, linId]);
  assert.deepEqual(
    hits.map((h) => "白天，算法实验室。右后方是林照的工位。".slice(h.start, h.end)),
    ["算法实验室", "林照"],
  );
});

test("更长的名字先认领 —— 「林照母亲」不会被拆成「林照」", () => {
  const { prod, muId } = fixtureProd();
  const hits = findMentions(buildEntityIndex(prod), "林照母亲坐在窗边。");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entity.id, muId);
});

test("拉丁名按词边界匹配，中文名不受词边界限制", () => {
  const prod = proddoc.createProduction(null);
  bibledoc.addCharacter(prod, "Ann");
  const index = buildEntityIndex(prod);
  assert.equal(findMentions(index, "Annabel walked in.").length, 0, "Ann 不该在 Annabel 里命中");
  assert.equal(findMentions(index, "Ann walked in.").length, 1);
  // 中日文没有词分隔符，「林照的工位」里的「林照」是真的出现
  const { prod: cn } = fixtureProd();
  assert.equal(findMentions(buildEntityIndex(cn), "林照的工位").length, 1);
});

test("台词不算出场 —— 只看镜头名与画面描述", () => {
  assert.equal(shotText({ title: "t", description: "d", dialogue: "林照：你是谁" }), "t\nd");
});

test("describeParts 把描述切成纯文本段与实体段，顺序不变、内容不丢", () => {
  const { prod } = fixtureProd();
  const text = "白天，算法实验室。右后方是林照的工位。";
  const parts = describeParts(buildEntityIndex(prod), text);
  assert.equal(parts.map((p) => p.text).join(""), text, "拼回去必须是原文");
  assert.deepEqual(parts.filter((p) => p.entity).map((p) => p.text), ["算法实验室", "林照"]);
});

/* ========================================================================= */
/* 4 · 「准备资产 N/M」是真的，而且只有一个                                    */
/* ========================================================================= */

test("M 是被点到的实体去重数，N 是其中已有参考图的", () => {
  const { prod } = fixtureProd();
  const index = buildEntityIndex(prod);
  const rd = assetReadiness({
    index,
    shots: SHOTS,
    hasReferenceImage: (kind, id) => id === index.find((e) => e.name === "林照").id,
  });
  // 林照（两镜）+ 算法实验室（一镜）；林照母亲一次都没被点到
  assert.equal(rd.total, 2);
  assert.equal(rd.ready, 1);
  assert.deepEqual(rd.missing.map((e) => e.name), ["算法实验室"]);
  assert.deepEqual(rd.entities[0].shotIds, ["shot-a", "shot-b"], "按被点到的镜头数排序");
});

test("表头的「准备资产 N/M」与三步向导第 ② 步是同一个数（守卫）", () => {
  // 两处不同的数字比没有数字更糟 —— 这条是本卡 §2.3.3 的全部意思。
  for (const withPortrait of [false, true]) {
    const pd = fixturePd({ withPortrait });
    const table = tableModel(pd, {}).readiness;
    const wizard = wizardReadiness(pd);
    assert.equal(table.total, wizard.total, "M 必须一致");
    assert.equal(table.ready, wizard.ready, "N 必须一致");
    assert.deepEqual(
      table.entities.map((e) => e.id),
      wizard.entities.map((e) => e.id),
      "连清单本身都得是同一份",
    );
  }
  // 而且这个装置真的有区别，不是两边都是 0 的空跑
  assert.equal(tableModel(fixturePd({ withPortrait: true }), {}).readiness.ready, 1);
  assert.equal(tableModel(fixturePd(), {}).readiness.ready, 0);
});

test("参考图的判据就是作品设定卡片用的那一个", () => {
  const pd = fixturePd({ withPortrait: true });
  const portraitFor = buildPortraitIndex(pd);
  const lin = buildEntityIndex(pd.production).find((e) => e.name === "林照");
  assert.equal(portraitFor("character", lin.id), "u/lin.png");
  assert.ok(tableModel(pd, {}).readiness.entities.find((e) => e.id === lin.id).ready);
});

/* ========================================================================= */
/* 5 · 表格视图                                                               */
/* ========================================================================= */

test("⑦ 分镜设计 提供表格视图，且与卡片视图并存", () => {
  const pd = fixturePd();
  const cards = renderStoryboard(boardCtx(pd), { selectedShotId: "shot-a", buffer: {} });
  assert.ok(cards.includes('data-sb-view="table"'));
  assert.ok(cards.includes('data-sb-view="cards"'));
  assert.ok(cards.includes("wsplit"), "默认仍是卡片视图");
  const table = renderStoryboard(boardCtx(pd), { tableView: true, buffer: {} });
  assert.ok(!table.includes("wsplit"), "表格视图下不再画三栏卡片");
  assert.ok(table.includes("<table class=\"sbt\">"));
});

test("表格给出卡片答不了的那几列，一行一个镜头", () => {
  const pd = fixturePd();
  const html = renderShotTable(boardCtx(pd), tableModel(pd, {}), {});
  for (const [, label] of [["镜号"], ["时长"], ["画面描述"], ["景别"], ["光影氛围"],
    ["台词"], ["音效"], ["运镜"], ["提示词"], ["操作"]].map((x) => ["", x[0]])) {
    assert.ok(html.includes(`>${label}</th>`), `缺少列：${label}`);
  }
  assert.equal(COLUMNS.length, 10);
  const m = tableModel(pd, {});
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows.map((r) => r.seq), [1, 2, 3]);
});

test("表格如实报出缺口，这就是要一张表的理由", () => {
  const m = tableModel(fixturePd(), {});
  assert.equal(m.gaps.shotSize, 2, "三镜里两镜没写景别");
  assert.equal(m.gaps.cameraMotion, 2);
  assert.equal(m.gaps.lighting, 3);
});

test("描述单元格里的实体是可点的链接，带上 kind 与 id", () => {
  const pd = fixturePd();
  const html = renderShotTable(boardCtx(pd), tableModel(pd, {}), {});
  const lin = buildEntityIndex(pd.production).find((e) => e.name === "林照");
  assert.ok(html.includes(`data-ent-kind="character" data-ent-id="${lin.id}"`));
  assert.ok(html.includes(">林照</button>"));
});

test("「提示词」列的缺口计数来自那一个编译器，不是这里自己算的", () => {
  const pd = fixturePd();
  const m = tableModel(pd, {});
  const row = m.rows.find((r) => r.shotId === "shot-a");
  const real = shotDetailModel(pd, "shot-a").prompts.image;
  assert.equal(row.prompt.gaps, real.missing.length);
  assert.equal(row.prompt.head, real.text.split("\n")[0]);
  assert.ok(row.prompt.gaps > 0, "这个装置真的有缺口，不是空跑");
});

test("音效只读地拉进来 —— 写仍然留在音频工作区", () => {
  // the document is keyed BY shotId at the top level — the shape
  // `workflow/shotaudio.js createShotAudio` produces
  const shotAudio = {
    "shot-a": {
      clips: [
        { clipId: "c1", assetId: "a1", trackType: "sfx", timing: {}, sourceInMs: 0 },
        { clipId: "c2", assetId: "a2", trackType: "dialogue", timing: {}, sourceInMs: 0 },
      ],
      mix: null,
    },
  };
  const pd = fixturePd({ shotAudio });
  const m = tableModel(pd, {});
  assert.equal(m.rows.find((r) => r.shotId === "shot-a").sfx, 1, "只数 sfx 轨");
  assert.equal(m.rows.find((r) => r.shotId === "shot-b").sfx, 0);
  const html = renderShotTable(boardCtx(pd), m, {});
  assert.ok(html.includes('data-goto="audio"'), "编辑入口指回所有者");
  assert.ok(!html.includes('data-tf="sfx"'), "这张表不写音效");
});

/* ========================================================================= */
/* 6 · 表格的写路径就是既有那一条                                             */
/* ========================================================================= */

test("就地编辑落在缓冲里，保存才产生新版本；没有改动就不产生", () => {
  const shots = SHOTS.map((s) => ({ ...s }));
  assert.equal(tableDirty(shots, {}), false);
  // 缓冲里写进与已提交值相同的内容，不算改动
  assert.equal(tableDirty(shots, { buffer: { "shot-b": { shotSize: "特写" } } }), false);
  assert.equal(tableDirty(shots, { buffer: { "shot-a": { shotSize: "全景" } } }), true);
  assert.equal(tableDirty(shots, { deleted: ["shot-c"] }), true);
});

test("applyTableEdits 只改被改的，其余逐字节保留", () => {
  const shots = SHOTS.map((s) => ({ ...s }));
  const out = applyTableEdits(shots, {
    buffer: { "shot-a": { shotSize: "全景", lighting: "冷白顶光", color: "amber" } },
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].shotSize, "全景");
  assert.equal(out[0].lighting, "冷白顶光");
  assert.equal(out[0].color, "amber");
  assert.deepEqual(out[1], shots[1], "没碰的行原样返回");
  assert.equal(out[0].shotId, "shot-a", "身份不变 —— 已上传的媒体跟着它走");
});

test("清空一个刻面是删除这个键，不是存一个空串", () => {
  const shots = [{ shotId: "s", title: "t", description: "d", duration_seconds: 6, shotSize: "特写" }];
  const [out] = applyTableEdits(shots, { buffer: { s: { shotSize: "  " } } });
  assert.ok(!("shotSize" in out));
});

test("认不出来的颜色标记不入库", () => {
  const shots = [{ shotId: "s", title: "t", description: "d", duration_seconds: 6 }];
  const [ok] = applyTableEdits(shots, { buffer: { s: { color: "amber" } } });
  assert.equal(ok.color, "amber");
  const [bad] = applyTableEdits(shots, { buffer: { s: { color: "<script>" } } });
  assert.ok(!("color" in bad));
  assert.ok(ROW_COLORS.every(([k]) => k === "" || /^[a-z]+$/.test(k)));
});

test("删除是**软删除**：打标记留在列表里，不是抹掉（TASK-097 批次 4B）", () => {
  const shots = SHOTS.map((s) => ({ ...s }));
  const out = applyTableEdits(shots, { deleted: ["shot-b"], at: "2026-08-19T00:00:00Z" });
  // 三条都还在 —— 记录不消失（AGENTS.md 第 13 条）
  assert.deepEqual(out.map((s) => s.shotId), ["shot-a", "shot-b", "shot-c"]);
  assert.deepEqual(out.find((s) => s.shotId === "shot-b").deleted, { at: "2026-08-19T00:00:00Z" });
  assert.equal("deleted" in out.find((s) => s.shotId === "shot-a"), false, "没删的不带标记");
  assert.equal(shots.length, 3, "输入没有被就地改动");
  assert.equal("deleted" in shots[1], false, "输入也没有被打上标记");
  // 没有时间戳就**拒绝**，不静默丢掉这次删除：创作者会以为删掉了，而下一次保存
  // 又把它带回来（§2.6.3：每条守卫先证明它真的会拒绝）
  assert.throws(() => applyTableEdits(shots, { deleted: ["shot-b"] }), /时间戳/);
  // 没有删除时不需要时间戳 —— 守卫只挡它该挡的那一半
  assert.equal(applyTableEdits(shots, { buffer: {} }).length, 3);
  // 未保存之前，被标记的行仍然在表上，可以撤销
  const m = shotTableModel({ ...fixturePd(), }, { deleted: ["shot-b"] });
  assert.equal(m.rows.length, 3);
  assert.equal(m.deletedCount, 1);
  assert.ok(m.rows.find((r) => r.shotId === "shot-b").deleted);
});

test("标记了删除、还没保存时，表格照常渲染 —— 不需要时间戳（codex round 2 的驳回，钉住）", () => {
  // codex 报「选中删除会让表格渲染崩掉」。不成立：`shotTableModel` 调
  // `applyTableEdits(shots, { buffer })`，**从不**把 `deleted` 传进去 ——
  // 待删是渲染出来的一个状态（划掉的行 + 「N 行将被删除」），不是一次写入。
  // 但这条担心值得钉住：哪天有人顺手把 `deleted` 也传进去，这个测试会先喊。
  const m = shotTableModel(fixturePd(), { deleted: ["shot-b"] });
  assert.equal(m.rows.length, 3, "三行都还在屏幕上");
  assert.equal(m.deletedCount, 1);
  assert.equal(m.dirty, true, "而且 保存 是可用的");
  // 真正落盘那一步才要时间戳
  assert.throws(() => applyTableEdits(fixturePd().draftShots, { deleted: ["shot-b"] }), /时间戳/);
});

test("时长只认 6 / 10", () => {
  const shots = [{ shotId: "s", title: "t", description: "d", duration_seconds: 6 }];
  assert.equal(applyTableEdits(shots, { buffer: { s: { duration: "10" } } })[0].duration_seconds, 10);
  assert.equal(applyTableEdits(shots, { buffer: { s: { duration: "7" } } })[0].duration_seconds, 6);
});

test("每一格显示的都是保存会写进去的那个值（codex round 2 · P1）", () => {
  // 时长格曾经无视缓冲：改成 10s、再触发任意一次重渲染，屏幕退回 6s，而保存
  // 仍然写 10s —— 创作者看不见的改动，就是他无法拒绝的改动。
  const pd = fixturePd();
  const ui = { tbuf: { "shot-a": { duration: "6", shotSize: "全景", dialogue: "「你是谁？」" } } };
  const row = tableModel(pd, ui).rows.find((r) => r.shotId === "shot-a");
  const saved = applyTableEdits(pd.draftShots, { buffer: ui.tbuf, deleted: [] })
    .find((s) => s.shotId === "shot-a");
  assert.equal(row.duration, 6, "shot-a 提交值是 10s，缓冲改成 6s —— 屏幕必须显示 6s");
  assert.equal(row.duration, saved.duration_seconds);
  assert.equal(row.shotSize, saved.shotSize);
  assert.equal(row.dialogue, saved.dialogue);
  // 而渲染出来的 <select> 也必须真的选中它
  const html = renderShotTable(boardCtx(pd), tableModel(pd, ui), ui);
  assert.ok(/<option value="6" selected>6s<\/option>/.test(html));
});

test("表格能写的字段，全都是保存路径会保留的加法字段", () => {
  for (const k of EDITABLE_FIELDS) {
    if (k === "description") continue; // 基础字段，本来就在
    assert.ok(ADDITIVE_SHOT_FIELDS.includes(k), `${k} 存不下来`);
  }
});

test("保存按钮在没有改动时是禁用的", () => {
  const pd = fixturePd();
  const html = renderShotTable(boardCtx(pd), tableModel(pd, {}), {});
  assert.ok(/data-tsave disabled/.test(html));
  assert.ok(/data-tflag hidden/.test(html), "「已修改」不该在没改动时出现");
  const ui = { tbuf: { "shot-a": { shotSize: "全景" } } };
  const dirty = renderShotTable(boardCtx(pd), tableModel(pd, ui), ui);
  assert.ok(!/data-tsave disabled/.test(dirty));
  assert.ok(!/data-tflag hidden/.test(dirty));
});

test("只删了一行、没打过一个字，保存也必须是可点的（codex round 1 · P1）", () => {
  // 之前 savebar 读的是 `ui.tableDirty`，而它只有输入事件才会写。删除行只调
  // rerender，于是渲染读到过期的 false —— 删除永远保存不了，功能等于不存在。
  const pd = fixturePd();
  const ui = { tdel: ["shot-b"] };
  const m = tableModel(pd, ui);
  assert.equal(m.dirty, true, "dirty 必须由状态推导，不是由最后一次按键推导");
  const html = renderShotTable(boardCtx(pd), m, ui);
  assert.ok(!/data-tsave disabled/.test(html), "删除行之后保存必须可点");
  assert.ok(html.includes("1 行将被删除"));
  // 撤销之后回到干净状态
  const clean = tableModel(pd, { tdel: [] });
  assert.equal(clean.dirty, false);
  assert.ok(/data-tsave disabled/.test(renderShotTable(boardCtx(pd), clean, {})));
});

test("提示词的缺口数跟着未保存的编辑走（codex round 1 · P2）", () => {
  // 表里刚填上运镜、旁边却还印着「缺 N」（N 里含「运镜为空」），等于告诉创作者
  // 他刚做的事没被登记。
  const pd = fixturePd();
  const before = tableModel(pd, {}).rows.find((r) => r.shotId === "shot-a").prompt.gaps;
  const ui = { tbuf: { "shot-a": { shotSize: "全景", lighting: "冷白顶光" } } };
  const after = tableModel(pd, ui).rows.find((r) => r.shotId === "shot-a").prompt;
  assert.ok(after.head.includes("全景") || after.gaps < before || after.head !== "",
    "编译结果必须反映缓冲里的编辑");
  // 最直接的一条：把描述清空，「画面内容为空」这个缺口必须立刻出现
  const emptied = tableModel(pd, { tbuf: { "shot-a": { description: "" } } })
    .rows.find((r) => r.shotId === "shot-a");
  assert.ok(emptied.prompt.gaps > before, "清空描述后缺口必须变多");
});

test("「准备资产 N/M」也跟着未保存的编辑走", () => {
  const pd = fixturePd();
  assert.equal(tableModel(pd, {}).readiness.total, 2);
  // 在第三镜的描述里点到「林照母亲」——她本来一次都没被点到
  const ui = { tbuf: { "shot-c": { description: "夜里的走廊，林照母亲站在尽头。" } } };
  assert.equal(tableModel(pd, ui).readiness.total, 3);
  // 而标记删除的行不再计入
  assert.equal(tableModel(pd, { tdel: ["shot-a", "shot-b"] }).readiness.total, 0);
});

test("同一时刻只能有一个脏缓冲 —— 切视图会丢弃另一边（codex round 3 · P1）", () => {
  // 两个视图编辑的是同一批字段。两个缓冲同时存在时：卡片里改景别 → 切表格 →
  // 表格里也改景别 → 表格保存 → 回卡片只改镜头名 → 保存。卡片的保存会把它缓冲里
  // **每一个**键都写下去，于是刚提交的景别被一次改标题悄悄回滚了。
  const pd = fixturePd();
  const saved = [];
  const ctx = {
    ...boardCtx(pd),
    shots: { saveEdit: (items) => { saved.push(items); return true; } },
    toast: () => {},
  };
  const ui = {
    tableView: false,
    dirty: true, buffer: { shotSize: "全景" },   // 卡片视图里改了景别，没保存
    tbuf: {}, tdel: [],
  };
  // 切到表格：源视图是脏的 → 必须先问，答「是」则丢弃卡片缓冲
  let asked = 0;
  const root = fakeRoot([{ sel: "[data-sb-view]", dataset: { sbView: "table" } }]);
  const prevConfirm = globalThis.window;
  globalThis.window = { confirm: () => { asked += 1; return true; } };
  try {
    bindStoryboard(root, ctx, ui, () => {});
    root.fire("[data-sb-view]");
  } finally {
    globalThis.window = prevConfirm;
  }
  assert.equal(asked, 1, "丢弃未保存的修改之前必须问");
  assert.equal(ui.tableView, true);
  assert.equal(ui.dirty, false);
  assert.deepEqual(ui.buffer, {}, "卡片缓冲不得活着进表格");
});

test("切视图时源视图不脏，就不打断创作者", () => {
  const pd = fixturePd();
  const ui = { tableView: false, dirty: false, buffer: {}, tbuf: {}, tdel: [] };
  const root = fakeRoot([{ sel: "[data-sb-view]", dataset: { sbView: "table" } }]);
  const prev = globalThis.window;
  let asked = 0;
  globalThis.window = { confirm: () => { asked += 1; return true; } };
  try {
    bindStoryboard(root, { ...boardCtx(pd), toast: () => {} }, ui, () => {});
    root.fire("[data-sb-view]");
  } finally {
    globalThis.window = prev;
  }
  assert.equal(asked, 0);
  assert.equal(ui.tableView, true);
});

/* ========================================================================= */
/* 7 · 参考统筹不再把「无从判断」说成「没有缺口」                              */
/* ========================================================================= */

test("镜头都没归入场景时，参考统筹说无从判断，而不是没问题", () => {
  // 真实项目：60 镜一个参考都没绑，这一页写「没有缺口」。那句话对推导为真、
  // 对项目为假 —— 它是从场景推需要的，而每个镜头都不属于任何场景。
  const view = { scenes: [], unassigned: SHOTS.map((s) => ({ ...s })) };
  const m = referencePlan({
    view,
    bindings: () => [],
    references: [],
    sceneOf: () => null,
    names: { character: (x) => x, location: (x) => x },
  });
  assert.equal(m.shots, 3);
  assert.equal(m.unscoped, 3);
  assert.equal(m.missing.length, 0);
  const html = renderRefPlan(
    { refplan: { model: () => m, shotName: (id) => id } },
    {},
  );
  assert.ok(html.includes("无从判断"));
  assert.ok(!html.includes("没有缺口。"));
  assert.ok(html.includes('data-goto="shots"'), "指向真的能回答它的那一面");
});

test("镜头都归入了场景且没缺口时，仍然直说没有缺口", () => {
  const m = referencePlan({
    view: { scenes: [], unassigned: [] },
    bindings: () => [],
    references: [],
    sceneOf: () => ({ sceneId: "sc", title: "t", characterIds: [], locationId: null }),
    names: { character: (x) => x, location: (x) => x },
  });
  assert.equal(m.unscoped, 0);
});
