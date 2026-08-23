// 分集规划是一张表（TASK-094 批次 B / TASK-088 §2.3）。
//
// 产品负责人 2026-08-17：「分集规划你就列一张表格用 AI 写内容就好了。我要改也可以改」
// 以及「为什么那么多重复的内容要写呢」—— 后者的精确成因是旧界面摆了
// 6 角色 × 48 集 = 288 个 AI 一字不产出的输入框。
import test from "node:test";
import assert from "node:assert/strict";

import { episodePlanModel, renderEpPlanWs, PLAN_COLUMNS } from "../src/ui/epplanws.js";
import * as st from "../src/workflow/storydoc.js";
import * as pd from "../src/workflow/proddoc.js";
import * as cd from "../src/workflow/canondoc.js";
import * as sd from "../src/workflow/scriptdoc.js";
import * as bd from "../src/workflow/bibledoc.js";

const OUTLINE = {
  premise: "p", logline: "l", genreTone: "t", world: "w", characterConcepts: [],
  centralConflict: "c", storyArc: "a", climax: "x", ending: "e",
  episodeCount: 2, durationNote: "60-90 秒",
};

/** A project with 2 episodes, a confirmed 2-entry plan, and 6 characters —
 *  the shape the 288-cell defect needs to be visible in. */
function project(entries) {
  const prod = pd.createProduction(null);
  const story = st.createStory(null);
  story.idea = "i";
  st.editBriefDraft(story, { targetEpisodes: 4 });
  st.commitBrief(story);
  const oid = st.beginDevelop(story, "outline", "");
  st.completeDevelop(story, oid, OUTLINE);
  st.applyProposal(story);
  st.approveOutline(story, 1);

  const cast = ["林照", "许渡", "校准官", "叁", "阿姐", "编号七"].map((n) => bd.addCharacter(prod, n));
  const pid = st.beginDevelop(story, "plan", "");
  st.completeDevelop(story, pid, entries);
  st.applyProposal(story);
  // confirm-time identity join, exactly as the caller does it
  const eps = [prod.episodes[0], pd.addEpisode(prod, "第 2 集")];
  story.plans[0].episodes.forEach((e, i) => { e.episodeId = eps[i].episodeId; });
  st.confirmPlan(story, 1);
  return { prod, story, cast, eps };
}

const V2_ENTRIES = [
  {
    epNumber: 1, title: "被抹除的核验员", coreGoal: "确立世界规则与越界的代价",
    keyEvents: ["她救下不可被救的人", "世界开始收走她", "她醒在终局世界"],
    characterBeats: [{ who: "林照", change: "第一次越界", relationChange: "从陌生到欠一条命" }],
    reveals: ["抹除不等于死亡"], emotionArc: "平静 → 紧张 → 转折",
    endingBeat: "她捡到刻着自己名字的旧校准牌", hook: "被抹除的人为什么还活着？",
  },
  { epNumber: 2, title: "引路人的价目表", coreGoal: "建立交易关系", keyEvents: ["许渡开价"] },
];

function render(prod, story, ui = {}) {
  return renderEpPlanWs(
    {
      prodData: () => ({ production: prod }),
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

test("the table is the PLAN VERSION: one row per entry, not one card per entity", () => {
  const { prod, story } = project(V2_ENTRIES);
  // three more entities from an earlier (now unreferenced) planning round
  pd.addEpisode(prod, "更早建立的一集");
  pd.addEpisode(prod, "另一集");
  const m = episodePlanModel({ production: prod }, story, () => null);
  assert.equal(m.rows.length, 2, "本版规划 2 集 → 2 行");
  assert.equal(m.others.length, 2, "其余的如实计入 others，不静默丢弃");
  assert.equal(m.establishedCount, 4);
  assert.equal(m.plannedCount, 2);

  const html = render(prod, story);
  assert.match(html, /<table class="ept">/);
  assert.equal((html.match(/class="ept-row/g) || []).length, 2);
  assert.match(html, /另有 2 集不在这一版规划里/);
});

test("every one of the product owner's seven facets has a column", () => {
  const keys = PLAN_COLUMNS.map((c) => c.key);
  for (const k of ["title", "coreGoal", "keyEvents", "characterBeats", "reveals", "emotionArc", "ending"]) {
    assert.ok(keys.includes(k), `缺列：${k}`);
  }
  const { prod, story } = project(V2_ENTRIES);
  const html = render(prod, story);
  for (const label of ["本集核心目标", "主要剧情", "角色推进", "信息揭示", "情绪曲线", "结尾钩子"]) {
    assert.ok(html.includes(label), `表头缺：${label}`);
  }
});

test("what AI wrote is on screen and editable in place", () => {
  const { prod, story, eps } = project(V2_ENTRIES);
  const html = render(prod, story);
  assert.ok(html.includes("确立世界规则与越界的代价"));
  assert.ok(html.includes("她救下不可被救的人"));
  assert.ok(html.includes("抹除不等于死亡"));
  assert.ok(html.includes("平静 → 紧张 → 转折"));
  // …and each is addressed by episodeId + field, i.e. the existing write path
  // 地址带标签（TASK-103 批次 D，codex 轮 3）：`id:` 与 `num:` 是两个不相通的空间
  assert.match(html, new RegExp(`data-plan-edit="id:${eps[0].episodeId}" data-field="coreGoal"`));
  assert.match(html, new RegExp(`data-plan-item="id:${eps[0].episodeId}" data-field="keyEvents" data-i="0"`));
  assert.match(html, new RegExp(`data-plan-beat="id:${eps[0].episodeId}" data-i="0" data-key="who"`));
  // endingBeat and hook are TWO fields in ONE cell — merging would lose one
  assert.match(html, /data-field="endingBeat"/);
  assert.match(html, /data-field="hook"/);
});

test("the 288-cell grid is gone: no row for a character with nothing to advance", () => {
  const { prod, story, eps } = project(V2_ENTRIES);
  const html = render(prod, story, { impactOpen: eps[0].episodeId });
  // six characters exist; only 林照 has a beat in the plan, and NO canon beat is
  // recorded at all — so no per-character input may be laid out
  const charInputs = (html.match(/data-beat-char=/g) || []).length;
  assert.equal(charInputs, 0, "旧界面在这里会摆 6 × 2 = 12 个空框");
  assert.match(html, /data-beat-add=/, "改成一个选择器：要记谁就挑谁");
  // …and the same for relationships
  assert.equal((html.match(/data-beat-rel=/g) || []).length, 0);
});

test("picking a character OPENS a row and writes nothing to canon", () => {
  // codex review, 批次 B round 1 (BLOCKING): the first shape wrote a placeholder
  // beat through `setCharacterBeat` to make the row appear, so abandoning the edit
  // left a character progression the creator never entered in canonical data.
  const { prod, story, cast, eps } = project(V2_ENTRIES);
  const key = `${eps[0].episodeId}:${cast[1].characterId}`;
  const html = render(prod, story, { impactOpen: eps[0].episodeId, beatOpen: { [key]: true } });
  // the row is there to type in…
  assert.match(html, new RegExp(`data-cid="${cast[1].characterId}"`));
  assert.match(html, /data-beat-char=[^>]*value=""/, "空行，不是伪造的内容");
  // …and the document still records nothing for that character
  const beats = prod.episodes.find((e) => e.episodeId === eps[0].episodeId).beats;
  assert.equal(beats.character.length, 0, "选一下人物不得写进 canon");
  // …and EP01's picker no longer offers a character whose row is already open.
  // Scoped to EP01's row: EP02 has its own picker, where that character is
  // legitimately still on offer.
  const ep01 = html.slice(html.indexOf(eps[0].episodeId), html.indexOf(eps[1].episodeId));
  assert.equal(ep01.includes(`<option value="${cast[1].characterId}"`), false);
  assert.ok(html.includes(`<option value="${cast[1].characterId}"`), "EP02 那一行仍然可以挑他");
});

test("picking a relationship also only opens a row", () => {
  const { prod, story, cast, eps } = project(V2_ENTRIES);
  const rel = cd.addRelationship(prod, cast[0].characterId, cast[1].characterId);
  const key = `${eps[0].episodeId}:${rel.relationshipId}`;
  const html = render(prod, story, { impactOpen: eps[0].episodeId, beatOpen: { [key]: true } });
  assert.match(html, new RegExp(`data-rid="${rel.relationshipId}"`));
  const beats = prod.episodes.find((e) => e.episodeId === eps[0].episodeId).beats;
  assert.equal(beats.relationship.length, 0, "选一下关系不得写进 canon");
});

test("a recorded canon beat is still shown and still editable", () => {
  const { prod, story, cast, eps } = project(V2_ENTRIES);
  cd.setEpisodeCharacterBeat(prod, eps[0].episodeId, cast[0].characterId, "第一次说谎");
  const rel = cd.addRelationship(prod, cast[0].characterId, cast[1].characterId);
  cd.setEpisodeRelationshipBeat(prod, eps[0].episodeId, rel.relationshipId, {
    start: "戒备", event: "合作", end: "信任",
  });
  const html = render(prod, story, { impactOpen: eps[0].episodeId });
  assert.ok(html.includes("第一次说谎"));
  assert.match(html, new RegExp(`data-beat-char="${eps[0].episodeId}"`));
  // exactly ONE row: the other five characters have nothing here
  assert.equal((html.match(/data-beat-char=/g) || []).length, 1);

  // …AND THE ROW SAYS WHO IT IS. A beat RECORD carries only `characterId`; the
  // display name is resolved by `episodePlanModel` against the bible, so passing
  // the raw document into `beatsBlock` would render nameless rows editable against
  // an unidentified person (reported as a defect by codex review, batch B round 2 —
  // it is not one, because the renderer is given the view model; this assertion is
  // what keeps that true).
  assert.ok(html.includes(cast[0].name), "人物推进那一行必须显示是谁");
  assert.ok(html.includes(`${cast[0].name} × ${cast[1].name}`), "关系推进那一行必须显示是哪一段关系");
  assert.ok(html.includes("戒备") && html.includes("合作") && html.includes("信任"));
});

test("3～6 条 is a hint: a short list is flagged and nothing is blocked", () => {
  const { prod, story } = project(V2_ENTRIES);
  const html = render(prod, story);
  // EP02 has ONE key event
  assert.match(html, /1 条 · 少于建议的 3～6 条/);
  assert.doesNotMatch(html, /disabled[^>]*data-plan-item/);
});

test("a name that matches no character is FLAGGED, not dropped", () => {
  const { prod, story } = project([
    {
      ...V2_ENTRIES[0],
      characterBeats: [{ who: "不存在的人", change: "做了什么" }],
    },
    V2_ENTRIES[1],
  ]);
  const html = render(prod, story);
  assert.ok(html.includes("不存在的人"), "静默丢掉答案 = 创作者以为 AI 什么都没产出");
  assert.ok(html.includes("未知人物"));
});

test("the LEGACY prose of the real project is visible where its replacement goes", () => {
  // 照见未明rev2 的四版规划都写在 synopsis / purpose 里，没有 coreGoal / keyEvents
  const { prod, story } = project([
    { epNumber: 1, title: "不可被救的人", synopsis: "校准员林照救下被判定不可被救的人。", purpose: "建立世界规则" },
    { epNumber: 2, title: "回声", synopsis: "她听见自己的名字。", purpose: "推进" },
  ]);
  const html = render(prod, story);
  assert.ok(html.includes("校准员林照救下被判定不可被救的人。"), "旧格式的规划不能显示成空表");
  assert.ok(html.includes("建立世界规则"));
  assert.ok(html.includes("旧字段 · 梗概"));
  assert.ok(html.includes("旧字段 · 戏剧功能"), "并且标明它是旧字段");
  // …and it is still editable, through the same field it lives in
  assert.match(html, /data-field="synopsis"/);
});

test("legacy prose stays visible AFTER the new field is filled — it is distinct data", () => {
  // codex review, 批次 B round 1 (non-blocking): hiding `purpose` as soon as
  // `coreGoal` was written left real stored content this screen could neither show
  // nor clear, so the creator could not even delete it.
  const { prod, story } = project([
    {
      epNumber: 1, title: "t", coreGoal: "新的核心目标", keyEvents: ["新的事件"],
      purpose: "旧的戏剧功能", synopsis: "旧的梗概",
    },
    V2_ENTRIES[1],
  ]);
  const html = render(prod, story);
  assert.ok(html.includes("新的核心目标"));
  assert.ok(html.includes("旧的戏剧功能"), "两个都是磁盘上真实存在的内容");
  assert.ok(html.includes("新的事件"));
  assert.ok(html.includes("旧的梗概"));
});

test("the three numbers are stated, and a mismatch is flagged without blocking", () => {
  const { prod, story } = project(V2_ENTRIES);
  const m = episodePlanModel({ production: prod }, story, () => null);
  assert.equal(m.targetEpisodes, 4, "创意的目标集数");
  assert.equal(m.outlineEpisodeCount, 2);
  const html = render(prod, story);
  assert.ok(html.includes("本版规划 2 集"));
  assert.ok(html.includes("创意目标 4 集"));
  assert.ok(html.includes("条数与目标集数不一致"));
  assert.ok(html.includes("先规划前几集是完全正常的"), "提示，不是闸门");
});

test("the last column enters that episode", () => {
  const { prod, story, eps } = project(V2_ENTRIES);
  const html = render(prod, story);
  assert.match(html, new RegExp(`data-ep-enter="${eps[0].episodeId}"`));
  assert.match(html, new RegExp(`data-ep-open="${eps[0].episodeId}"`));
});

test("an UNCONFIRMED entry is EDITABLE, and honest that it cannot be entered yet", () => {
  // TASK-103 批次 D / TASK-087 §5.8. 这条测试原本守的是相反的行为：整行 colspan
  // 一句「确认后才能改」。那个限制来自实现（每次规划编辑都按 episodeId 寻址），
  // 不来自产品 —— 创作者面对的是 AI 写出来的一版规划，下一步本来就是先改再确认。
  // 现在寻址扩成「有 id 用 id，没有就用本版第 N 集」，所以内容照常改；真正缺的
  // 「进入这一集」仍然缺，那一句留着。
  const { prod, story } = project(V2_ENTRIES);
  // a fresh plan version whose entries are not linked to any entity
  const pid = st.beginDevelop(story, "plan", "");
  st.completeDevelop(story, pid, [{ epNumber: 1, title: "全新的一集", coreGoal: "g", keyEvents: ["x"] }]);
  st.applyProposal(story);
  const html = render(prod, story);
  assert.match(html, /class="ept-row unlinked"/);
  // 可编辑：单元格按「本版第 N 集」寻址
  assert.match(html, /data-plan-edit="num:1"/);
  // 绝不写成 null —— 那是一个谁都可能接住的地址
  assert.doesNotMatch(html, /data-plan-edit="null"/);
  // 仍然说得出它还不能进入
  assert.ok(html.includes("才能进入这一集"));
  assert.ok(html.includes("未确认"));
});

test("未确认行的编辑真的写得进去，而且写的是那一行", () => {
  // 界面可编辑但域层拒收，是比不可编辑更糟的一种谎。
  const { story } = project(V2_ENTRIES);
  const pid = st.beginDevelop(story, "plan", "");
  st.completeDevelop(story, pid, [
    { epNumber: 1, title: "第一集", coreGoal: "g1", keyEvents: ["x"] },
    { epNumber: 2, title: "第二集", coreGoal: "g2", keyEvents: ["y"] },
  ]);
  st.applyProposal(story);
  assert.equal(st.editPlanEntry(story, "num:2", "coreGoal", "改过的目标"), true);
  const rows = st.planEditBase(story) && st.effectivePlanEpisodes(story);
  const second = rows.find((e) => e.epNumber === 2);
  const first = rows.find((e) => e.epNumber === 1);
  assert.equal(second.coreGoal, "改过的目标");
  assert.equal(first.coreGoal, "g1", "只能改到那一行");
  // 不存在的编号被拒绝，而不是静默无操作
  assert.equal(st.editPlanEntry(story, "num:99", "coreGoal", "x"), false);
  assert.equal(st.editPlanEntry(story, "num:0", "coreGoal", "x"), false);
});

test("an opened fold survives the next re-render", () => {
  // codex review, 批次 B round 2 (BLOCKING): `<details>` keeps its open state in the
  // DOM, and this page rebuilds the DOM — so clicking 「⚠ N 个上游变化」 on an episode
  // inside the 「另有 N 集」 fold re-rendered it CLOSED and hid the review just asked
  // for. Both folds now record their state on the shell.
  const { prod, story } = project(V2_ENTRIES);
  const stray = pd.addEpisode(prod, "更早建立的一集");
  const html = render(prod, story, { othersOpen: true });
  assert.match(html, /<details class="ept-others" open>/);

  // …and it opens by itself when the thing being reviewed is inside it
  const withImpact = render(prod, story, { impactOpen: stray.episodeId });
  assert.match(withImpact, /<details class="ept-others" open>/);
  assert.ok(withImpact.includes("确定性依赖变化"), "折叠里的影响审阅必须真的出现");

  // the row fold has the same memory, and a handle to record it through
  const rowOpen = render(prod, story, { epmoreOpen: { [prod.episodes[0].episodeId]: true } });
  assert.match(rowOpen, /<details class="epmore" open data-epmore=/);
});

test("with no plan at all it states the situation — it does not draw a blank grid", () => {
  const prod = pd.createProduction(null);
  const story = st.createStory(null);
  const html = render(prod, story);
  assert.match(html, /data-rf-notrun/);
  assert.doesNotMatch(html, /<table class="ept">/);
  assert.doesNotMatch(html, /data-plan-item/);
});

test("两种地址形式互不相通 —— 冲突根本表达不出来", () => {
  // codex 轮 2（P1）：第一版把优先级只写在**单条记录内部**，取的时候仍是 `.find()`，
  // 于是谁在数组前面谁被选中 —— 一个 id 恰好长成 `ep#3` 的已确认剧集若排在编号 3 的
  // 未确认行后面，编辑会静默落到未确认行上。「每条记录内部的优先级」不是优先级。
  // 轮 3（P1）又从反面报了一条：如果改成「身份优先」，那么一个 id 恰好读作
  // `ep#3` 的已确认剧集会把编号 3 的未确认行**顶掉**，后者的编辑落到前者身上。
  //
  // 一条代码被从两个方向各报一次，说明错的不是仲裁规则而是那条代码：两种地址
  // 本来就不该在同一个字符串空间里。现在带标签（`id:` / `num:`），冲突表达不
  // 出来 —— `episodeId` 里含 `ep#3`、含冒号、含什么都行。
  const { story } = project(V2_ENTRIES);
  const base = st.planEditBase(story);
  const confirmed = base.episodes.find((e) => e.episodeId);
  assert.ok(confirmed, "fixture 里应当有已确认的行");
  const before = confirmed.coreGoal;
  assert.equal(
    st.editPlanEntry(story, `num:${confirmed.epNumber}`, "coreGoal", "不该落到这里"),
    false,
    "有 episodeId 的行不接受编号地址",
  );
  assert.equal(
    st.effectivePlanEpisodes(story).find((e) => e.epNumber === confirmed.epNumber).coreGoal,
    before,
    "被拒绝的编辑一个字都不许写进去",
  );
  // 而它自己的身份地址照常可用
  assert.equal(st.editPlanEntry(story, `id:${confirmed.episodeId}`, "coreGoal", "改到了"), true);
  // 裸的字符串**不再是地址**（codex 轮 4）。容忍它正是第四种拼法进来的路：
  // 一个 id 恰好读作 `num:3` 时，裸形式又会被当成「本版第 3 集」。
  assert.equal(st.editPlanEntry(story, confirmed.episodeId, "coreGoal", "x"), false);
  // 而 id 里写什么都不再要紧 —— 它只活在 `id:` 之后，永远不会被二次解读
  assert.equal(st.editPlanEntry(story, "id:num:3", "coreGoal", "x"), false, "没有这个 id");
  assert.equal(st.editPlanEntry(story, "id:ep#3", "coreGoal", "x"), false, "也没有这个 id");
  // 编号空间只能经 `num:` 进入，所以上面两个不可能撞到任何未确认行
  assert.equal(st.editPlanEntry(story, "num:", "coreGoal", "x"), false);
});
