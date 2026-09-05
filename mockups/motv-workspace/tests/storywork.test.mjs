// Story Development 的新数据模型（TASK-122 第 1 步）。
//
// 产品负责人 2026-08-30 的规格里，有三条是**数据层**的承诺，界面再漂亮也补不回来：
//   1. 大纲节点的 id 要稳 —— 否则结构规划的「关联故事大纲」会集体断掉；
//   2. Planned Chapters/Episodes 可增可减 —— 减少时既有的章/集不许被删掉；
//   3. 日常编辑只留最新版，**点定稿才存历史**，历史可看可恢复可删。
// 这份测试守的就是这三条。

import test from "node:test";
import assert from "node:assert/strict";

import * as w from "../src/workflow/storywork.js";
import * as st from "../src/workflow/storydoc.js";

const work = () => w.createWork(null);

/* --- 大纲节点：id 必须稳 ---------------------------------------------------- */

test("段落切成节点，每个都有 id", () => {
  const k = work();
  const nodes = w.setOutline(k, "第一段\n\n第二段\n\n- 一条列表项");
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.kind), ["para", "para", "item"]);
  assert.ok(nodes.every((n) => n.id));
  assert.equal(new Set(nodes.map((n) => n.id)).size, 3, "id 不许重复");
});

test("改一个错别字，其余节点的 id 一个都不许变", () => {
  const k = work();
  const before = w.setOutline(k, "开端：他丢了名字\n\n发展：他去找\n\n结局：他换回来");
  const after = w.setOutline(k, "开端：他丢了名字\n\n发展：他去找回\n\n结局：他换回来");
  assert.equal(after[0].id, before[0].id, "没动的第一段换了 id");
  assert.equal(after[2].id, before[2].id, "没动的第三段换了 id");
  // 改过的那一段按位置复用，所以引用它的表格不会断
  assert.equal(after[1].id, before[1].id);
});

test("在中间插一段，前后各段的 id 仍然是自己的", () => {
  const k = work();
  const before = w.setOutline(k, "A\n\nB");
  const after = w.setOutline(k, "A\n\n新的\n\nB");
  const ids = after.map((n) => n.id);
  assert.ok(ids.includes(before[0].id), "A 的 id 丢了");
  assert.ok(ids.includes(before[1].id), "B 的 id 丢了");
});

test("节点与文本互相还原", () => {
  const k = work();
  w.setOutline(k, "第一段\n\n第二段");
  assert.equal(w.outlineText(k), "第一段\n\n第二段");
});

/* --- 结构规划：9 列，引用大纲节点 ------------------------------------------- */

test("那张表的列就是他点名的九列，顺序不变", () => {
  assert.deepEqual(
    w.PLAN_COLUMNS.map(([k]) => k),
    ["unitNo", "scene", "purpose", "characters", "goal", "conflict", "turn", "endingState", "outlineRefs"],
  );
});

test("一行能引用大纲节点；引用不存在的节点会被指出来，而不是静默丢掉", () => {
  const k = work();
  const nodes = w.setOutline(k, "开端\n\n结局");
  const row = w.addPlanRow(k, "T0");
  assert.equal(w.editPlanRow(k, row.id, "outlineRefs", [nodes[0].id, "on-没了"]), true);
  const bad = w.danglingRefs(k);
  assert.deepEqual(bad.map((x) => x.ref), ["on-没了"]);
});

test("表里不认识的列改不动", () => {
  const k = work();
  const row = w.addPlanRow(k, "T0");
  assert.equal(w.editPlanRow(k, row.id, "bogus", "x"), false);
});

test("删一行是软删除，能撤销", () => {
  const k = work();
  const row = w.addPlanRow(k, "T0");
  w.addPlanRow(k, "T0");
  assert.equal(w.hidePlanRow(k, row.id, "T1"), true);
  assert.equal(w.visiblePlanRows(k).length, 1);
  assert.equal(k.plan.rows.length, 2, "行本身不许从表里消失");
  assert.equal(w.restorePlanRow(k, row.id), true);
  assert.equal(w.visiblePlanRows(k).length, 2);
});

/* --- 形态与章/集数：可增可减，减了不删东西 ---------------------------------- */

test("形态不替他默认，乱写的形态不认", () => {
  const k = work();
  assert.equal(k.form, "");
  assert.equal(w.setForm(k, "漫画"), false);
  assert.equal(w.setForm(k, "novel"), true);
  assert.equal(k.form, "novel");
});

test("Planned 数量能加能减，减少时既有的章一个都不删", () => {
  const k = work();
  w.setPlanned(k, "novel", 3);
  w.ensureUnit(k, "novel", 3, "T0");
  assert.equal(w.setPlanned(k, "novel", 1), true);
  assert.equal(k.planned.novel, 1);
  assert.equal(k.units.length, 1, "计划变少不该删掉已经写的东西");
  assert.equal(k.units[0].no, 3);
});

test("同一章拿两次是同一个单元，不会长出第二份", () => {
  const k = work();
  const a = w.ensureUnit(k, "episode", 2, "T0");
  const b = w.ensureUnit(k, "episode", 2, "T1");
  assert.equal(a.id, b.id);
  assert.equal(k.units.length, 1);
});

/* --- 定稿：日常不产生历史 --------------------------------------------------- */

test("日常编辑不产生历史版本", () => {
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "写了一段", "T1");
  w.editUnit(k, u.id, "body", "又改了一遍", "T2");
  assert.equal(u.finalized.length, 0, "日常改动不该存历史");
  assert.equal(u.body, "又改了一遍");
});

test("点定稿才存一版；内容没变时不重复存", () => {
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "第一稿", "T1");
  assert.equal(w.finalizeUnit(k, u.id, "T2", "第一次定稿").v, 1);
  assert.equal(w.finalizeUnit(k, u.id, "T3"), null, "没改就不该再存一版");
  w.editUnit(k, u.id, "body", "第二稿", "T4");
  assert.equal(w.finalizeUnit(k, u.id, "T5").v, 2);
  assert.equal(u.finalized.length, 2);
});

test("历史能恢复、能手动删 —— 删是软删除，回收区里拿得回来", () => {
  // 合同在 2026-09-05 的补审后变了两处，都是 P1 修出来的：
  //   1. 删版本是**软删除**。动作注册表只收可逆的动作（AGENTS.md §1），而
  //      `work.deleteVersion` 的 `undo` 自己写着「删掉就没有了」—— 那道准入检查
  //      被一个没声明 `reversible: false` 的动作混了过去。
  //   2. **恢复之前先把当前这一稿存档**（第 13 条：覆盖前留可回滚）。上一版
  //      直接覆盖，他今天写了没定稿的字一个也找不回来。
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "第一稿", "T1");
  w.finalizeUnit(k, u.id, "T2");
  w.editUnit(k, u.id, "body", "写坏了", "T3");

  assert.equal(w.restoreFinalized(k, u.id, 1, "T4"), true);
  assert.equal(u.body, "第一稿");
  // 「写坏了」那一稿没有定过稿，但它**没有被吞掉**
  const auto = u.finalized.find((x) => x.body === "写坏了");
  assert.ok(auto, "恢复把还没定稿的当前内容吞了 —— 那是静默覆盖");
  assert.match(auto.note, /自动存档/, "自动存的那一版要说清楚不是他点的定稿");

  assert.equal(w.deleteFinalized(k, u.id, 1, "T5"), true);
  assert.equal(w.visibleVersions(u.finalized).some((x) => x.v === 1), false, "删了还看得见");
  assert.equal(u.body, "第一稿", "删历史不该动当前正文");
  // 撤销那条路真的存在 —— 这才是它有资格待在动作表里的理由
  assert.equal(w.undeleteFinalized(k, u.id, 1), true);
  assert.equal(w.visibleVersions(u.finalized).some((x) => x.v === 1), true);
});

test("版本号按最大号 +1 派 —— 删掉中间一版不会重号", () => {
  // `list.length + 1` 在删过中间版本之后会派出第二个 v3：于是「恢复 v3」恢复到
  // 旧的那一版、「删掉 v3」一次删掉两版。版本号是他指认某一版的**名字**（补审 2026-09-05）。
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  for (const [body, t] of [["一", "T1"], ["二", "T2"], ["三", "T3"]]) {
    w.editUnit(k, u.id, "body", body, t);
    w.finalizeUnit(k, u.id, t);
  }
  assert.deepEqual(u.finalized.map((x) => x.v), [1, 2, 3]);
  w.deleteFinalized(k, u.id, 2, "T4");
  w.editUnit(k, u.id, "body", "四", "T5");
  w.finalizeUnit(k, u.id, "T5");
  const vs = u.finalized.map((x) => x.v);
  assert.equal(new Set(vs).size, vs.length, `版本号重了：${vs.join(",")}`);
  assert.equal(Math.max(...vs), 4);
});

/* --- 存盘往返 + 与既有文档并存 ---------------------------------------------- */

test("整份 round-trip 无损 —— 刷新一次不许丢东西", () => {
  const k = work();
  w.setForm(k, "novel");
  k.core = "被世界抹除的人并没有消失";
  w.setOutline(k, "开端\n\n结局");
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "scene", "酒吧 · 打烊后");
  w.editPlanRow(k, row.id, "outlineRefs", [k.outline.nodes[0].id]);
  const u = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, u.id, "body", "正文", "T1");
  w.finalizeUnit(k, u.id, "T2");

  const round = w.createWork(JSON.parse(JSON.stringify(w.serializeWork(k))));
  assert.deepEqual(w.serializeWork(round), w.serializeWork(k));
});

test("它住在故事文档里，且不动既有的简报 / 大纲 / 分集规划", () => {
  const doc = st.createStory(null);
  assert.ok(doc.work, "story.work 没建起来");
  st.setIdea(doc, "创意");
  st.commitBrief(doc);
  w.setForm(doc.work, "episode");
  const round = st.createStory(JSON.parse(JSON.stringify(st.serialize(doc))));
  assert.equal(round.work.form, "episode");
  assert.equal(round.brief.versions.length, 1, "既有的简报版本被动了");
  assert.equal(round.idea, "创意");
});

test("迁移：现有分集变成结构规划的行，且只做一次", () => {
  const k = work();
  const n = w.seedPlanFromEpisodes(k, [{ title: "EP01 迷雾入城" }, { title: "EP02 回声" }], "T0");
  assert.equal(n, 2);
  assert.deepEqual(w.visiblePlanRows(k).map((r) => r.scene), ["EP01 迷雾入城", "EP02 回声"]);
  assert.equal(w.seedPlanFromEpisodes(k, [{ title: "EP03" }], "T1"), 0, "不许重复灌一次");
});

/* --- 2026-09-05 补审抓到的 P1，一条一个守卫 --------------------------------- */

test("中间插一段，其余节点的 id 一个不动", () => {
  // 上一版在同一趟里「先试精确、不中就吃掉 olds[i]」：[A,B,C] 插 X 之后
  // X 拿走 B 的 id、B 拿走 C 的 id，结构规划里指向 B 段的引用**指到了 X 上**，
  // 而且不报 dangling —— 引用错行比引用断掉更坏，断掉他看得见，错行他看不见。
  const k = work();
  w.setOutline(k, "A段\n\nB段\n\nC段");
  const before = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  w.setOutline(k, "A段\n\nX段\n\nB段\n\nC段");
  const after = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  for (const t of ["A段", "B段", "C段"]) {
    assert.equal(after[t], before[t], `${t} 的 id 被抢走了`);
  }
  assert.ok(after["X段"], "新插的段没有 id");
  assert.equal(new Set(Object.values(after)).size, 4, "id 撞了");
});

test("中文项目重开一次会话，新节点不会和已存的 id 撞", async () => {
  // 种子里的中文被 [^a-zA-Z0-9] 过滤成空 → 退化成 "x"；`seq` 又是模块级、每次
  // 加载归零。于是重开会话再加一段，必然又派出 on-x1，和存进 canvas.json 的撞上。
  //
  // **必须真的重新加载一次模块**（补审 2026-09-05 第五轮指出）：上一版跑在同一个
  // 模块实例里，`seq` 单调递增，于是**没修过的 mintId 也照样绿** —— 一条为了错误
  // 的理由而通过的守卫比没有守卫更糟，它让人以为这里有保护。加 query 串拿到的是
  // 一个全新的模块实例，`seq` 从 0 开始，那才是「重开一次会话」。
  // **两次会话都要是新的模块实例。** 只让第二次新鲜是不够的：这个文件里前面的
  // 用例已经把共享实例的 `seq` 推高了，于是「第一次会话」存下的 id 根本不是
  // `on-x1`，第二次自然撞不上 —— 那正是这条守卫上一版形同虚设的原因。
  const s1 = await import("../src/workflow/storywork.js?session=1");
  const s2 = await import("../src/workflow/storywork.js?session=2");
  const k = s1.createWork(null);
  s1.setOutline(k, "第一段\n\n第二段");
  const saved = JSON.parse(JSON.stringify(s1.serializeWork(k)));

  const fresh = s2;
  const reopened = fresh.createWork(saved);
  fresh.setOutline(reopened, fresh.outlineText(reopened) + "\n\n第三段");
  const ids = reopened.outline.nodes.map((n) => n.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length, `重开后 id 撞了：${ids.join(",")}`);
});

test("plan.row.edit 改不动引用列 —— 拒绝，而不是清空", () => {
  // 上一版收到非数组就写成 [] 还 return true：一次调用抹掉整行引用，回执照说「改好了」。
  const k = work();
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "outlineRefs", ["on-abc"]);
  assert.deepEqual(row.outlineRefs, ["on-abc"]);
  assert.equal(w.editPlanRow(k, row.id, "outlineRefs", "§3"), false, "非数组该被拒");
  assert.deepEqual(row.outlineRefs, ["on-abc"], "引用被清空了");
});

test("恢复历史版本不清空回收区里的软删除行", () => {
  // 快照里只有当时可见的行，上一版拿它整体替换 rows —— 软删除的行（他随时能恢复的
  // 那些）在恢复任意历史版本时被永久丢弃。软删除的全部意义就是那条撤销路还在。
  // 关键是**快照之后**才建、才软删的那些行：它们不在快照里，上一版的整体替换
  // 会把它们连同回收区一起抹掉。（快照里本来就有的行，恢复成可见是对的。）
  const k = work();
  const a = w.addPlanRow(k, "T0");
  w.editPlanRow(k, a.id, "scene", "留着的");
  w.finalizeDoc(k, "plan", "T1");
  const b = w.addPlanRow(k, "T2");
  w.hidePlanRow(k, b.id, "T2");
  w.editPlanRow(k, a.id, "scene", "改过的");
  assert.equal(w.restoreDoc(k, "plan", 1, "T3"), true);
  assert.equal(k.plan.rows.find((r) => r.id === a.id).scene, "留着的", "没恢复成");
  assert.ok(
    k.plan.rows.some((r) => r.id === b.id && r.hidden),
    "回收区里的行被恢复顺手清掉了",
  );
  assert.equal(w.restorePlanRow(k, b.id), true, "撤销那条路没了");
});

/* --- 2026-09-05 补审第三轮：软删除必须活过一次刷新 --------------------------- */

test("删掉的版本活过一次存盘往返 —— 不会自己复活", () => {
  // 读盘是按字段白名单重建记录的。新加的 `deleted` 一旦没写进白名单，就会在下一次
  // 加载时被丢掉：他删掉的每一版全部复活成正常历史，回收区自己清空 —— 而软删除的
  // 全部意义就是那条撤销路还在。**这一条才是回收区能不能算数的判据。**
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  for (const [b, t] of [["一", "T1"], ["二", "T2"]]) {
    w.editUnit(k, u.id, "body", b, t);
    w.finalizeUnit(k, u.id, t);
  }
  k.core = "核心";
  w.finalizeDoc(k, "core", "T3");
  w.deleteFinalized(k, u.id, 1, "T4");
  w.deleteDoc(k, "core", 1, "T4");

  const round = w.createWork(JSON.parse(JSON.stringify(w.serializeWork(k))));
  const ru = round.units[0];
  assert.equal(w.visibleVersions(ru.finalized).some((x) => x.v === 1), false, "章的删版本复活了");
  assert.equal(w.visibleVersions(round.finalized.core).length, 0, "文档的删版本复活了");
  // 回收区里还在，拿得回来
  assert.equal(w.undeleteFinalized(round, ru.id, 1), true);
  assert.equal(w.undeleteDoc(round, "core", 1), true);
});

test("删掉最后一版之后，同样内容还能再定稿", () => {
  // 「内容没变不重复存」如果跟数组末尾比，而末尾正是刚被软删的那一版，
  // 他点定稿就什么都不会发生（补审 2026-09-05 第三轮）。
  const k = work();
  k.core = "同一段内容";
  assert.equal(w.finalizeDoc(k, "core", "T1").v, 1);
  w.deleteDoc(k, "core", 1, "T2");
  const again = w.finalizeDoc(k, "core", "T3");
  assert.ok(again, "点了定稿却什么都没存");
  assert.equal(w.visibleVersions(k.finalized.core).length, 1);
});

test("恢复旧版本不改写、也不拽出回收区里的行", () => {
  // **这条是真 codex 抓到的**（2026-09-05 第六轮；前五轮同模型自审全没看见）。
  //
  //   某行以内容 A 定稿 → 改成 B → 删进回收区 → 恢复那一版定稿
  //     上一版只保住「快照里没有」的隐藏行。这一行快照里**有**（内容 A），
  //     于是被整体换回 A，还从回收区里被拽了出来 —— B 一个字都找不回来，
  //     因为自动存档只存看得见的行，而 B 当时正躺在回收区里。
  //
  // 正确语义是两件事分开：版本历史管「看得见的那些长什么样」，回收区管
  // 「他删掉了什么」。恢复旧版本不该顺手把他删掉的东西拽回来，更不该改写它。
  const k = work();
  const row = w.addPlanRow(k, "T0");
  w.editPlanRow(k, row.id, "scene", "A · 定稿时的内容");
  w.finalizeDoc(k, "plan", "T1");
  w.editPlanRow(k, row.id, "scene", "B · 后来改的内容");
  w.hidePlanRow(k, row.id, "T2");

  assert.equal(w.restoreDoc(k, "plan", 1, "T3"), true);
  const now = k.plan.rows.find((r) => r.id === row.id);
  assert.ok(now, "整行没了");
  assert.equal(now.scene, "B · 后来改的内容", "回收区里那一行被旧版本改写了 —— B 丢了");
  assert.ok(now.hidden, "恢复旧版本把他删掉的行拽了出来");
  // 撤销那条路仍然通，拿回来的还是 B
  assert.equal(w.restorePlanRow(k, row.id), true);
  assert.equal(k.plan.rows.find((r) => r.id === row.id).scene, "B · 后来改的内容");
});

/* --- 2026-09-05 真 codex 抓到的两条（同模型自审五轮全没看见）------------------ */

test("插一段和改一段同时发生，改过的那段仍拿回自己的 id", () => {
  // 按下标硬套位置在这里会错：[A,B,C] → [X,A,B改,C] 时，精确匹配先认走 A 和 C，
  // 而 `B改` 落在下标 2、olds[2] 正是已被占用的 C，于是它拿不到 B 的 id ——
  // 指向 B 的结构规划引用当场断掉。改成按锚点分段配对之后，A 和 C 之间
  // 只剩 `B改` 和 `B`，一对一配上。
  const k = work();
  w.setOutline(k, "A段\n\nB段\n\nC段");
  const before = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  w.setOutline(k, "X段\n\nA段\n\nB段改过了\n\nC段");
  const after = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  assert.equal(after["A段"], before["A段"]);
  assert.equal(after["C段"], before["C段"]);
  assert.equal(after["B段改过了"], before["B段"], "改过的那段丢了自己的 id");
  assert.ok(!Object.values(before).includes(after["X段"]), "新插的段抢了别人的 id");
});

test("已经退休、但还被引用着的 id，不许被新段落重新领走", async () => {
  // 中文项目里 id 会退化成 on-xN，而 seq 每次加载归零。某段被删掉、结构规划里
  // 的引用留着，重开会话后新写的段落就会**重新领走 on-x1** —— 那条本已失效的
  // 引用于是静默指到一段毫不相干的文字上。
  //
  // **引用错行比引用断掉更坏**：断掉他看得见（表格里是 §?），错行他看不见。
  const s1 = await import("../src/workflow/storywork.js?retired=1");
  const s2 = await import("../src/workflow/storywork.js?retired=2");
  const k = s1.createWork(null);
  s1.setOutline(k, "第一段");
  const retired = k.outline.nodes[0].id;
  const row = s1.addPlanRow(k, "T0");
  s1.editPlanRow(k, row.id, "outlineRefs", [retired]);
  s1.setOutline(k, ""); // 段落删掉，引用留着

  const reopened = s2.createWork(JSON.parse(JSON.stringify(s1.serializeWork(k))));
  s2.setOutline(reopened, "一段毫不相干的新文字");
  assert.notEqual(
    reopened.outline.nodes[0].id,
    retired,
    "退休的 id 被新段落领走了 —— 那条引用现在指着一段无关的文字",
  );
  // 失效的引用仍然照实报为失效
  assert.deepEqual(s2.danglingRefs(reopened).map((x) => x.ref), [retired]);
});

test("同一区间里先插后改：新段落不许抢走被改那段的 id", () => {
  // [A,B,C] → [A,X,B改,C]：锚点是 A 和 C，中间只剩一个旧节点 B，却有两个块。
  // 按顺序配 → **X 抢走 B 的 id**，B改 领新 id —— 指向 B 的引用静默指到 X 上。
  // 数目对不上时改成按内容相似度配（codex 补审 2026-09-05 第八轮）。
  const k = work();
  w.setOutline(k, "A段\n\nB段\n\nC段");
  const before = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  w.setOutline(k, "A段\n\nX段\n\nB段改过了\n\nC段");
  const after = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  assert.equal(after["B段改过了"], before["B段"], "被改那段丢了自己的 id");
  assert.ok(!Object.values(before).includes(after["X段"]), "新插的段抢了别人的 id");
  assert.equal(after["A段"], before["A段"]);
  assert.equal(after["C段"], before["C段"]);
});

test("数目一样时按顺序配 —— 整段推倒重写也保住 id", () => {
  // 相似度只在**数目对不上**时用来消歧。数目一样就是一一对应，没有歧义：
  // 他把一整段推倒重写，新旧文字可以毫无共同点，但那仍然是同一段。
  // 这一支若也拿相似度卡，重写一段就会白白断掉引用。
  const k = work();
  w.setOutline(k, "开端\n\n发展\n\n结局");
  const before = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  w.setOutline(k, "开端\n\n完全换了一段毫不相干的文字\n\n结局");
  const after = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  assert.equal(after["完全换了一段毫不相干的文字"], before["发展"]);
});

test("两段都够像时，一个都不认 —— 宁可断掉，也不要指错", () => {
  // 相似度分不清「把这段改了」和「在旁边插了一段很像的」。codex 第九轮给的例子
  // 直接打穿了取最高分：原文「他走进房间」，新文本里插入「他走进房间后坐下」
  // （≈0.73）而原句被改成「他走出房间」（≈0.5）—— 取最高分就把 id 判给了
  // **新插进来的那段**，指向原句的引用于是静默错行。
  //
  // 这种输入本来就有歧义，再调阈值只是把反例往后推一格。所以：够得上的候选
  // 不止一个时一个都不认，让引用变成 §?（他在表格里看得见）。
  const k = work();
  w.setOutline(k, "开头锚点\n\n他走进房间\n\n结尾锚点");
  const was = k.outline.nodes[1].id;
  w.setOutline(k, "开头锚点\n\n他走进房间后坐下\n\n他走出房间\n\n结尾锚点");
  const ids = k.outline.nodes.map((n) => n.id);
  assert.ok(!ids.includes(was), "有歧义时仍然把旧 id 判给了某一段");
});

test("多个旧节点争同一个新段落时，谁都不认", () => {
  // 上一版只查了一个方向（「这个旧节点的候选是不是只有一个」），漏掉反方向：
  //   旧：[他走进房间, 他走出房间]；新文本删掉前者、把后者改成「他走出房间后坐下」
  //   「他走进房间」的相似度 ≈0.36 刚过阈值，且它排在前面 → **先把 id 认走了**，
  //   新段落于是继承了一个已经被删掉的段落的身份，引用静默错行。
  // 配对必须互相唯一：任何一边有第二人，就谁都不认（codex 补审第十轮）。
  const k = work();
  w.setOutline(k, "开头锚点\n\n他走进房间\n\n他走出房间\n\n结尾锚点");
  const was = Object.fromEntries(k.outline.nodes.map((n) => [n.text, n.id]));
  w.setOutline(k, "开头锚点\n\n他走出房间后坐下\n\n结尾锚点");
  assert.notEqual(
    k.outline.nodes[1].id,
    was["他走进房间"],
    "新段落继承了被删掉那段的 id",
  );
});

test("正文超上限是拒绝，不是砍掉一截", () => {
  // 这是这条路上最后一处静默截断：`editUnit` 曾经 slice(0, 200000)。
  const k = work();
  const u = w.ensureUnit(k, "novel", 1, "T0");
  assert.equal(w.editUnit(k, u.id, "body", "字".repeat(w.UNIT_MAX), "T1"), true);
  assert.equal(w.editUnit(k, u.id, "body", "字".repeat(w.UNIT_MAX + 1), "T2"), false, "超了却写进去了");
  assert.equal(u.body.length, w.UNIT_MAX, "被拒的那次改动了正文");
});

test("只被定稿快照指着的 id，也不许被新段落领走", async () => {
  // 保留集漏掉任何一处载体，那一处的引用就会在某天静默指到无关文字上。
  // 上一版只扫当前的 plan.rows，漏了**定稿快照**（codex 补审第十一轮）：
  //   定稿一版含该引用的规划 → 清掉当前行的引用 → 删掉那个节点 → 重开会话再写一段
  //   → id 被重新发出去 → 此后「恢复那一版规划」，老引用指向了新的无关段落。
  const s1 = await import("../src/workflow/storywork.js?snap=1");
  const s2 = await import("../src/workflow/storywork.js?snap=2");
  const k = s1.createWork(null);
  s1.setOutline(k, "第一段");
  const retired = k.outline.nodes[0].id;
  const row = s1.addPlanRow(k, "T0");
  s1.editPlanRow(k, row.id, "outlineRefs", [retired]);
  s1.finalizeDoc(k, "plan", "T1"); // 快照里从此留着这条引用
  s1.editPlanRow(k, row.id, "outlineRefs", []); // 当前行不再指它
  s1.setOutline(k, ""); // 节点也删掉

  const reopened = s2.createWork(JSON.parse(JSON.stringify(s1.serializeWork(k))));
  s2.setOutline(reopened, "一段毫不相干的新文字");
  assert.notEqual(
    reopened.outline.nodes[0].id,
    retired,
    "只有快照指着的 id 被领走了 —— 恢复那一版规划时会指向无关文字",
  );
});

test("两段文字一模一样时，改其中一段不会让 id 互相串位", () => {
  // 他复制粘贴过一段，于是两个旧节点同文。精确匹配若取 `findIndex` 的第一个：
  //   旧 ["他走进房间"(a), "他走进房间"(b)]，只把第一段改成「他走出房间」——
  //   **没改的第二段抢走 a**，被改的第一段领新 id，b 凭空消失：
  //   指向第一段的引用指到了第二段，指向第二段的引用则断掉（codex 补审第十二轮）。
  // 取**位置最近**的那个同文旧节点，两条引用就都对。
  const k = work();
  w.setOutline(k, "他走进房间\n\n他走进房间");
  const [a, b] = k.outline.nodes.map((n) => n.id);
  assert.notEqual(a, b);
  w.setOutline(k, "他走出房间\n\n他走进房间");
  const now = k.outline.nodes.map((n) => n.id);
  assert.equal(now[0], a, "被改的那段丢了自己的 id");
  assert.equal(now[1], b, "没改的那段被换了 id");

  // 反过来改第二段也要对
  const k2 = work();
  w.setOutline(k2, "同一段\n\n同一段");
  const [c, d] = k2.outline.nodes.map((n) => n.id);
  w.setOutline(k2, "同一段\n\n同一段改了");
  assert.deepEqual(k2.outline.nodes.map((n) => n.id), [c, d]);
});

test("重复段落前面插一段，两个重复段的 id 不互换", () => {
  // 连续两轮栽在同一件事上：文字一模一样的段落之间，**文本里没有任何信息能把
  // 它们区分开**，所以任何 tie-break 都能被构造出反例 ——
  //   取第一个 → 改第一段时没改的第二段抢走它的 id（第十二轮）；
  //   取最近的 → 在它们前面插一段，两个 id 当场互换（第十三轮）。
  // 能区分它们的只有**顺序**。锚点改用 LCS 挑，天然满足 i 与 j 同时递增，
  // 交叉配对构造不出来 —— 这不是第三个 tie-break，是把这一类去掉。
  const k = work();
  w.setOutline(k, "重复段\n\n重复段");
  const [a, b] = k.outline.nodes.map((n) => n.id);
  w.setOutline(k, "X段\n\n重复段\n\n重复段");
  const now = k.outline.nodes.map((n) => n.id);
  assert.equal(now[1], a, "第一个重复段换了 id");
  assert.equal(now[2], b, "第二个重复段换了 id");
  assert.ok(!ˍdup(now), "id 撞了");
  function ˍdup(list) { return new Set(list).size !== list.length; }
});

test("锚点保序：交叉配对构造不出来", () => {
  // 这条守的是性质本身，不是某一个例子：任何一对锚点 (i,j) 与 (i2,j2)，
  // i < i2 就必须 j < j2。乱序的锚点正是 id 互换的成因。
  const k = work();
  w.setOutline(k, "甲\n\n乙\n\n甲\n\n乙");
  const before = k.outline.nodes.map((n) => n.id);
  w.setOutline(k, "乙\n\n甲\n\n乙\n\n甲");
  const after = k.outline.nodes.map((n) => n.id);
  // 复用了哪些不重要，重要的是复用的那些**相对顺序没有反过来**
  const reused = after.map((id) => before.indexOf(id)).filter((x) => x >= 0);
  const sorted = [...reused].sort((x, y) => x - y);
  assert.deepEqual(reused, sorted, `锚点乱序了：${reused.join(",")}`);
});

test("删掉两个同文段之一：幸存的那段不继承被删者的 id", () => {
  // `[A(a), A(b)]` 删成 `[A]` —— 文本里**没有任何信息**能说明他删的是哪一个，
  // 两种解读同样成立。硬锚一个的话，幸存段就继承了被删段的 id：指向被删段的
  // 引用静默转到幸存段上，指向幸存段的引用断掉（codex 第十四轮）。
  //
  // 所以重复组缺了人就整组不锚：这里两条引用都变 §?（他看得见），
  // 而不是一条对、一条静默指错。
  const k = work();
  w.setOutline(k, "A\n\nA");
  const before = k.outline.nodes.map((n) => n.id);
  w.setOutline(k, "A");
  assert.equal(k.outline.nodes.length, 1);
  assert.ok(
    !before.includes(k.outline.nodes[0].id),
    "幸存的那段继承了一个说不清是谁的 id",
  );
});

test("段落极多走退路时，指针只往前走 —— 不会把同一个旧节点认领两次", () => {
  // 这一条打的是退路的**单调性**本身。上一条（改第一个重复段）打不到它：
  // 重复组缺人时整组不锚，退路的顺序根本没被用上 —— 那条守卫**为了错误的理由
  // 通过**，我把 `j = k + 1` 改成 `j = 0` 时它照样绿。
  //
  // 这里让重复段数目对得上（因而会真的走锚定），并把它们整体挪到最前面：
  // 指针若不单调，第二个 A 会从头再扫一遍、**把第一个 A 已经认领的旧节点再认一次**
  // → 两个节点拿到同一个 id。
  const many = Array.from({ length: 999 }, (_, i) => `独立段落${i}`);
  const k = work();
  w.setOutline(k, [...many, "重复段", "重复段"].join("\n\n"));
  const before = k.outline.nodes.map((n) => n.id);
  assert.ok(before.length * before.length > 1000000, "这个用例没有越过阈值，守不到退路");
  w.setOutline(k, ["重复段", "重复段", ...many].join("\n\n"));
  const after = k.outline.nodes.map((n) => n.id);
  assert.equal(new Set(after).size, after.length, `id 撞了：同一个旧节点被认领了两次`);
});

test("段落极多走退路时，同样不会让 id 互换", () => {
  // 阈值之上曾经退回「先到先得」——也就是被 LCS 取代掉的那个算法，于是大纲够长时
  // 缺陷原样复现。**一条已知错误的退路不是退路，是埋在阈值后面的地雷**
  //（codex 第十四轮）。退路改成双指针贪心：j 只往前走，锚点天然递增。
  const many = Array.from({ length: 999 }, (_, i) => `独立段落${i}`);
  const k = work();
  w.setOutline(k, ["他走进房间", "他走进房间", ...many].join("\n\n"));
  const before = k.outline.nodes.map((n) => n.id);
  assert.ok(before.length * before.length > 1000000, "这个用例没有越过阈值，守不到退路");
  w.setOutline(k, ["他走出房间", "他走进房间", ...many].join("\n\n"));
  const after = k.outline.nodes.map((n) => n.id);
  assert.equal(after[1], before[1], "没动的第二段被换了 id");
  assert.deepEqual(after.slice(2), before.slice(2), "其余段落被动了");
});

/* --- 一条**记录在案的残留局限**，不是遗漏 -------------------------------- */

test("同文段落的身份：三种形状的既定处置（含说不清时的取舍）", () => {
  // 文字**完全一样**的段落之间，文本里没有任何信息能把它们区分开。
  // 这一类连审四轮（codex 12/13/14/15），每一轮都能构造出新的反例 —— 因为
  // 任何规则都在用不存在的信息做判断。所以这里给死结论，不再往下追：
  //
  //   数量不变 → LCS 保序对齐（顺序是唯一可用的信息）
  //   数量变少 → 整组不锚，引用变 §?（无解 → 交给他看得见的失败）
  //   数量变多 → 保序，前面的保住 id（无解 → 取代价最小的那个）
  //
  // 最后一条是**取舍不是正确**：`[A,A]` 变成 `[A,A,A]` 时，若他实际是在最前面
  // 插入，那么原来指向第一段的引用会指到新插入的那一段上。代价是「引用指向一段
  // 文字完全相同的段落」，只有在他此后把它们改得不同时才显形。
  //
  // 反过来把「变多」也判成歧义的代价更大：`[A]` → `[A,A]`（他复制粘贴了一段）
  // 时原来那段会**丢掉自己的 id** —— 那是实打实的回归，比上面那个构造出来的
  // 边界常见得多。这条测试就是把这个取舍钉在这里，改动它的人要先读懂它。

  // ① 数量不变：保序
  const a1 = work();
  w.setOutline(a1, "重复段\n\n重复段");
  const b1 = a1.outline.nodes.map((n) => n.id);
  w.setOutline(a1, "X段\n\n重复段\n\n重复段");
  assert.deepEqual(a1.outline.nodes.slice(1).map((n) => n.id), b1);

  // ② 数量变少：谁都不认
  const a2 = work();
  w.setOutline(a2, "A\n\nA");
  const b2 = a2.outline.nodes.map((n) => n.id);
  w.setOutline(a2, "A");
  assert.ok(!b2.includes(a2.outline.nodes[0].id));

  // ③ 数量变多：保序，前面的保住 —— 复制一段不许弄丢原来那段的 id
  const a3 = work();
  w.setOutline(a3, "A\n\nB");
  const b3 = a3.outline.nodes.map((n) => n.id);
  w.setOutline(a3, "A\n\nA\n\nB");
  assert.equal(a3.outline.nodes[0].id, b3[0], "复制一段把原来那段的 id 弄丢了");
  assert.equal(a3.outline.nodes[2].id, b3[1], "B 的 id 被牵连");
});

test("接受 AI 大纲提案前，先把现有大纲存一版", () => {
  // 接受提案是**整篇替换**，不是日常打字：他今天写了、还没点定稿的大纲会被一次盖掉，
  // 而 `setOutline` 不留版本（它不该留 —— 日常编辑不产生历史是产品规格）。
  // 所以存档必须发生在**接受提案这个边界**上（codex 补审 2026-09-05 块 2b）。
  //
  // 这条守的是数据模型这一半：`finalizeDoc` 在覆盖前确实存得下当前内容。
  // app.js 的 `proposeOutline` 走的就是这两步（同文件的 `proposeScript` 早就这么做）。
  const k = work();
  w.setOutline(k, "我今天写的大纲，还没点定稿");
  const before = w.outlineText(k);
  assert.equal(k.finalized.outline.length, 0, "日常编辑不该产生历史");

  const rec = w.finalizeDoc(k, "outline", "T1", "被 AI 大纲覆盖前自动存的一版");
  w.setOutline(k, "提案覆盖进来的新大纲");

  assert.ok(rec, "覆盖前没有存下任何东西");
  assert.equal(rec.body, before, "存下来的不是被覆盖的那一份");
  assert.match(rec.note, /覆盖前/, "自动存的那一版要说清楚它不是他点的定稿");
  assert.equal(w.outlineText(k), "提案覆盖进来的新大纲");
  assert.equal(w.restoreDoc(k, "outline", rec.v, "T2"), true, "退不回去");
  assert.equal(w.outlineText(k), before);
});
