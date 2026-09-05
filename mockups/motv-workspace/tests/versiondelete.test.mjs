// 版本的「删除」：不再显示，但一个字节都不动（TASK-115）。
//
// 产品负责人 2026-08-29：「不管是故事还是镜头。应该都可以有删除的选项。不然画面会很乱。」
//
// 为什么是软删除而不是真删：版本号在 hydration 时是**密集重编号**的（`v: out.length+1`），
// 真删一版会把后面所有版本号左移，于是「Based on 创意 v2」指向另一版 —— 那正是
// AGENTS.md §1 说的「不可逆是实现的缺陷」。所以删除 = 打标记 + 回收区可撤销。

import test from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/workflow/storydoc.js";
import { versionRow } from "../src/ui/versionrow.js";

function briefWithVersions(n) {
  const doc = st.createStory(null);
  for (let i = 1; i <= n; i += 1) {
    st.setIdea(doc, `创意 ${i}`);
    st.commitBrief(doc);
  }
  return doc;
}

test("删除一版：它从看得见的列表里消失，但版本链一字不动", () => {
  const doc = briefWithVersions(3);
  st.setActiveBrief(doc, 3);
  const res = st.hideBriefVersion(doc, 1, "2026-08-29T00:00:00Z");
  assert.equal(res.ok, true);
  assert.deepEqual(st.visibleVersions(doc.brief.versions).map((x) => x.v), [2, 3]);
  assert.deepEqual(st.hiddenVersions(doc.brief.versions).map((x) => x.v), [1]);
  // 链本身没动：v1 还在，内容还在，号也没被别人顶替
  assert.equal(doc.brief.versions.length, 3);
  assert.equal(doc.brief.versions[0].idea, "创意 1");
});

test("撤销删除把它放回去", () => {
  const doc = briefWithVersions(2);
  st.hideBriefVersion(doc, 1);
  assert.equal(st.restoreBriefVersion(doc, 1).ok, true);
  assert.deepEqual(st.visibleVersions(doc.brief.versions).map((x) => x.v), [1, 2]);
});

test("不许删掉下游正在依据的那一版", () => {
  const doc = briefWithVersions(2);
  st.setActiveBrief(doc, 2);
  const res = st.hideBriefVersion(doc, 2);
  assert.equal(res.ok, false);
  assert.match(res.error, /正在依据/);
  assert.equal(doc.brief.versions[1].hidden, null);
});

test("大纲：已批准的那一版也不许删 —— 它是剧集规划的闸门", () => {
  const doc = st.createStory(null);
  st.applyManualOutline(doc, { logline: "一" });
  st.applyManualOutline(doc, { logline: "二" });
  st.approveOutline(doc, 1);
  st.setActiveOutline(doc, 2);
  const res = st.hideOutlineVersion(doc, 1);
  assert.equal(res.ok, false);
  assert.match(res.error, /已批准/);
  // 换成批准 v2 之后，v1 就删得掉了 —— 「先把不可逆变可逆」不是刁难，是路径
  st.approveOutline(doc, 2);
  assert.equal(st.hideOutlineVersion(doc, 1).ok, true);
});

test("不存在的版本号说得清楚", () => {
  const doc = briefWithVersions(1);
  assert.match(st.hideBriefVersion(doc, 9).error, /没有 v9/);
  assert.match(st.restoreBriefVersion(doc, 9).error, /不在回收区/);
});

test("软删标记活过一次 round-trip —— 否则刷新一下删除就白做了", () => {
  const doc = briefWithVersions(2);
  st.hideBriefVersion(doc, 1, "2026-08-29T00:00:00Z");
  const round = st.createStory(st.serialize(doc));
  assert.deepEqual(st.hiddenVersions(round.brief.versions).map((x) => x.v), [1]);
});

/* --- 界面：删除只在展开历史时露出，且不给不许删的那些 ---------------------- */

test("收起时不画 ✕（台面上只剩最新版与正在依据的那版，而它们恰恰不许删）", () => {
  const html = versionRow(
    [{ v: 1 }, { v: 2 }, { v: 3, isActive: true }],
    { attr: "cbV", toggleAttr: "cbHist", delAttr: "cbDel", keep: [3] },
  );
  assert.doesNotMatch(html, /data-cb-del/);
});

test("展开后每一版都有 ✕，除了不许删的那些", () => {
  const html = versionRow(
    [{ v: 1 }, { v: 2 }, { v: 3, isActive: true }],
    { attr: "cbV", open: true, toggleAttr: "cbHist", delAttr: "cbDel", keep: [3] },
  );
  assert.match(html, /data-cb-del="1"/);
  assert.match(html, /data-cb-del="2"/);
  assert.doesNotMatch(html, /data-cb-del="3"/);
});

test("回收区在展开时列出，并给撤销的出口", () => {
  const html = versionRow(
    [{ v: 2, isActive: true }],
    {
      attr: "cbV", open: true, toggleAttr: "cbHist",
      delAttr: "cbDel", undelAttr: "cbUndel", trash: [{ v: 1 }], keep: [2],
    },
  );
  assert.match(html, /回收区/);
  assert.match(html, /data-cb-undel="1"/);
});

test("回收区空的时候不占地方", () => {
  const html = versionRow([{ v: 1, isActive: true }], {
    attr: "cbV", open: true, toggleAttr: "cbHist", trash: [], undelAttr: "cbUndel",
  });
  assert.doesNotMatch(html, /回收区/);
});

/* --- 镜头：删掉的从列表里消失，而不是变成一行「不在当前草稿」 --------------- */

import { storyboardModel } from "../src/ui/storyboard.js";

/** 最小的 prodData：一集、一场、两个镜头。 */
function pdWithShots() {
  return {
    draftShots: [
      { shotId: "s-1", sequence: 1, title: "招牌·雨夜", description: "", duration_seconds: 6 },
      { shotId: "s-2", sequence: 2, title: "吧台", description: "", duration_seconds: 6 },
    ],
    production: {
      characters: [],
      episodes: [{
        episodeId: "ep-1", title: "EP01", active: true,
        scenes: [{ sceneId: "sc-1", title: "S01", shotIds: ["s-1", "s-2"] }],
      }],
    },
    assetUploads: {}, media: { video: {} },
  };
}

test("回收区里的镜头从场景列表里消失（不是留下一行坏引用）", () => {
  const pd = pdWithShots();
  const before = storyboardModel(pd);
  const shotsOf = (m) => m.scenes.flatMap((sc) => sc.shots.map((s) => s.shotId || s.title));
  assert.deepEqual(shotsOf(before), ["s-1", "s-2"]);

  // 软删除只把镜头移出存活列表；场景仍然引用它（撤销要靠这条引用把它放回原位）
  pd.draftShots = pd.draftShots.filter((s) => s.shotId !== "s-1");
  const dangling = storyboardModel(pd);
  assert.ok(
    dangling.scenes[0].shots.some((s) => s.dangling),
    "没有告诉模型它在回收区时，那一行就是坏引用 —— 这正是真机上看到的",
  );

  const after = storyboardModel(pd, ["s-1"]);
  assert.deepEqual(shotsOf(after), ["s-2"]);
  assert.ok(!after.scenes[0].shots.some((s) => s.dangling));
});

test("真正的坏引用仍然要露出来 —— 它和「我删了它」不是一回事", () => {
  const pd = pdWithShots();
  pd.draftShots = pd.draftShots.filter((s) => s.shotId !== "s-1");
  const m = storyboardModel(pd, ["别的镜头"]);
  assert.ok(m.scenes[0].shots.some((s) => s.dangling && s.shotId === "s-1"));
});
