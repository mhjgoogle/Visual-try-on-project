// TASK-146 / REQ-009 判据 1–3：小说模式下，AI 的正文提案真的落到他打开的那一章。
//
// 断言的是**行为**，不是源码文本：这一条改的两件事都属于「界面看着正常、其实写到了
// 别处」那一类 —— 章号选错不会报错，它会安静地把一章正文写进另一章。
//
//   1. `targetUnitNo` —— 写第几章/集的判断。小说看他打开着哪一章，剧集看当前集，
//      两种都**不猜**；没有答案时给的是一句让他能照着做的话，不是一个默认值。
//   2. `planApply("novel-chapter-writer", …)` —— 小说家的产出真的被翻译成正文提案，
//      而不是停在「尚未接线」（产品负责人 2026-08-30 撞过的那一类缺陷）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as w from "../src/workflow/storywork.js";
import * as skillapply from "../src/workflow/skillapply.js";
import * as skills from "../src/workflow/skills.js";
import * as skillrun from "../src/workflow/skillrun.js";
import * as runtime from "../src/services/runtime.js";
import { createSkillController } from "../src/controllers/skillctl.js";

const { planApply, applicability } = skillapply;

// --- 1. 写第几章/集 --------------------------------------------------------- //

test("小说：写进他此刻打开着的那一章", () => {
  const got = w.targetUnitNo("novel", { openUnitNo: 7, activeEpisodeIndex: 0 });
  assert.deepEqual(got, { no: 7, word: "章" });
});

test("小说：一章都没打开时不猜，让他先去打开", () => {
  for (const openUnitNo of [null, undefined, 0, "", NaN]) {
    const got = w.targetUnitNo("novel", { openUnitNo, activeEpisodeIndex: 3 });
    assert.ok(got.error, `openUnitNo=${String(openUnitNo)} 时竟然选出了一章`);
    assert.equal(got.no, undefined, "不许在报错的同时还给一个章号");
    assert.match(got.error, /正文创作/, "这句话要告诉他去哪儿才能继续");
  }
});

test("小说：当前选中的是哪一集，与写第几章毫无关系", () => {
  // 一个既写小说、又碰巧选中了某一集的项目，不能被集号带跑。
  const got = w.targetUnitNo("novel", { openUnitNo: 2, activeEpisodeIndex: 11 });
  assert.equal(got.no, 2);
});

test("剧集：按当前集在列表里的位置对到第几集", () => {
  assert.deepEqual(w.targetUnitNo("episode", { activeEpisodeIndex: 0 }), {
    no: 1,
    word: "集",
  });
  assert.deepEqual(w.targetUnitNo("episode", { activeEpisodeIndex: 4 }), {
    no: 5,
    word: "集",
  });
});

test("剧集：没有选中的集就说没有，不退回第 1 集", () => {
  const got = w.targetUnitNo("episode", { activeEpisodeIndex: -1 });
  assert.ok(got.error);
  assert.equal(got.no, undefined);
});

test("形态还没选时，先让他去选形态", () => {
  const got = w.targetUnitNo("", { openUnitNo: 3, activeEpisodeIndex: 0 });
  assert.ok(got.error);
  assert.match(got.error, /小说创作还是剧集创作/);
});

test("章号越界按无效处理，不被截断成一个合法值", () => {
  // 501 被夹成 500 就会把正文写进第 500 章 —— 那是「猜」的另一种形状。
  assert.ok(w.targetUnitNo("novel", { openUnitNo: 501 }).error);
  assert.ok(w.targetUnitNo("novel", { openUnitNo: -3 }).error);
});

// --- 1b. 提案真的落进那一章，且不静默覆盖 ------------------------------------ //

/** 一份最小的、真的能写进去的 work（与 `storywork` 自己的构造器同一条路）。 */
function novelWork({ planned = 12 } = {}) {
  const k = w.createWork(null);
  w.setForm(k, "novel");
  w.setPlanned(k, "novel", planned);
  return k;
}

test("提案写进他打开着的那一章，别的章一个字都不动", () => {
  const k = novelWork();
  const before = w.ensureUnit(k, "novel", 1, "T0");
  w.editUnit(k, before.id, "body", "第一章原有的正文", "T0");

  const res = w.applyBodyProposal(k, { openUnitNo: 5 }, "第五章新写的正文", "T1");
  assert.equal(res.ok, true, res.error);
  assert.equal(res.no, 5);
  assert.equal(res.word, "章");

  const five = k.units.find((u) => u.kind === "novel" && u.no === 5);
  assert.equal(five.body, "第五章新写的正文", "正文没落进第 5 章");
  assert.equal(
    k.units.find((u) => u.kind === "novel" && u.no === 1).body,
    "第一章原有的正文",
    "写第 5 章却动了第 1 章",
  );
});

test("覆盖已有正文之前，旧的那一份先被存成一版", () => {
  const k = novelWork();
  const res1 = w.applyBodyProposal(k, { openUnitNo: 3 }, "AI 写的第一版", "T1");
  assert.equal(res1.kept, null, "空章不该凭空产生一版历史");

  const res2 = w.applyBodyProposal(k, { openUnitNo: 3 }, "AI 写的第二版", "T2");
  assert.ok(res2.kept, "覆盖前什么都没存下来 —— 他上一版没了");
  assert.equal(res2.kept.body, "AI 写的第一版", "存下来的不是被覆盖的那一份");
  assert.match(res2.kept.note, /覆盖前/, "要说清楚这一版不是他点的定稿");

  const three = k.units.find((u) => u.kind === "novel" && u.no === 3);
  assert.equal(three.body, "AI 写的第二版");
  // 退得回去 —— 「存了一版」只有在真的能恢复时才算数。
  assert.equal(w.restoreFinalized(k, three.id, res2.kept.v, "T3"), true, "退不回上一版");
  assert.equal(
    k.units.find((u) => u.kind === "novel" && u.no === 3).body,
    "AI 写的第一版",
  );
});

test("一章都没打开时，一个字都不写", () => {
  const k = novelWork();
  const res = w.applyBodyProposal(k, { openUnitNo: null }, "不该被写下去的正文", "T1");
  assert.equal(res.ok, false);
  assert.match(res.error, /正文创作/);
  assert.equal(
    k.units.filter((u) => (u.body || "").trim()).length,
    0,
    "拒绝了却还是写下去了",
  );
});

test("形态还没选时，提案不落地", () => {
  const k = w.createWork(null);
  const res = w.applyBodyProposal(k, { openUnitNo: 2 }, "正文", "T1");
  assert.equal(res.ok, false);
  assert.equal(k.units.length, 0);
});

test("剧集：提案仍然落进当前这一集", () => {
  const k = w.createWork(null);
  w.setForm(k, "episode");
  w.setPlanned(k, "episode", 12);
  // 当前选中的是列表里第 3 个 → 第 3 集。章号即使开着也不参与。
  const res = w.applyBodyProposal(
    k,
    { activeEpisodeIndex: 2, openUnitNo: 9 },
    "第三集的剧本正文",
    "T1",
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.no, 3);
  assert.equal(res.word, "集");
  assert.equal(
    k.units.find((u) => u.kind === "episode" && u.no === 3).body,
    "第三集的剧本正文",
  );
});

// --- 1c. 能力知道自己在写第几章 ---------------------------------------------- //

test("本章任务带着章号、这一章的结构规划行和它引用的大纲", () => {
  const k = novelWork();
  // 段落之间是**空行** —— 单个换行仍是同一段（`setOutline` 的分段规则）。
  w.setOutline(k, "海底城市浮出水面\n\n考古队决定下潜");
  const nodeIds = k.outline.nodes.map((n) => n.id);
  assert.equal(nodeIds.length, 2, "大纲没被分成两段，这条测试的前提就不成立");
  const row = w.addPlanRow(k);
  w.editPlanRow(k, row.id, "unitNo", "4");
  w.editPlanRow(k, row.id, "scene", "下潜准备");
  w.editPlanRow(k, row.id, "conflict", "氧气不够两个人用");
  w.editPlanRow(k, row.id, "outlineRefs", [nodeIds[1]]);

  const plan = w.chapterPlanOf(k, 4);
  assert.equal(plan.no, 4, "能力不知道自己在写第几章");
  assert.equal(plan.planRows.length, 1);
  assert.equal(plan.planRows[0]["Scene"], "下潜准备");
  assert.equal(plan.planRows[0]["冲突"], "氧气不够两个人用");
  assert.ok(
    plan.outlineExcerpts.some((x) => x.includes("考古队决定下潜")),
    "大纲引用没有被解析成内容 —— 能力读不懂一个裸 id",
  );
  assert.ok(
    !JSON.stringify(plan.planRows).includes(nodeIds[1]),
    "裸 nodeId 不该出现在喂给能力的材料里",
  );
});

test("本章任务只带这一章的行，不把别章的也塞进来", () => {
  const k = novelWork();
  const a = w.addPlanRow(k);
  w.editPlanRow(k, a.id, "unitNo", "1");
  const b = w.addPlanRow(k);
  w.editPlanRow(k, b.id, "unitNo", "2");
  assert.equal(w.chapterPlanOf(k, 1).planRows.length, 1);
  assert.equal(w.chapterPlanOf(k, 2).planRows.length, 1);
});

test("这一章还没规划也能跑，但说得出它什么都没有", () => {
  const k = novelWork();
  const plan = w.chapterPlanOf(k, 6);
  assert.ok(plan, "没有结构规划不是错误 —— 他可以只写大纲就开写");
  assert.equal(plan.no, 6);
  assert.deepEqual(plan.planRows, []);
  assert.equal(plan.wordsSoFar, 0);
});

test("续写时说得出这一章已经有多少字", () => {
  const k = novelWork();
  w.applyBodyProposal(k, { openUnitNo: 2 }, "已经写了十个字", "T1");
  assert.equal(w.chapterPlanOf(k, 2).wordsSoFar, 7);
});

test("没有章号就没有本章任务 —— 能力因此报缺，而不是自己挑一章", () => {
  const k = novelWork();
  for (const no of [null, undefined, 0, "3", 501]) {
    assert.equal(w.chapterPlanOf(k, no), null, `chapterPlanOf(${String(no)}) 竟然给了结果`);
  }
});

// --- 2. 小说家的产出落到正文提案上 ------------------------------------------- //

test("小说家的这一章被翻译成正文提案", () => {
  const out = planApply("novel-chapter-writer", {
    chapter: "潜水舱的灯灭了三秒。等它重新亮起来，舷窗外多了一个人影。",
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].action, "proposeScript");
  assert.match(out.actions[0].text, /潜水舱/);
});

test("小说家：提案里没有正文就拒绝，不落一个空章", () => {
  for (const proposal of [{}, { chapter: "" }, { chapter: "   " }, { notes: "写不动" }]) {
    const out = planApply("novel-chapter-writer", proposal);
    assert.equal(out.ok, false, `${JSON.stringify(proposal)} 竟然被接受了`);
    assert.ok(out.error);
  }
});

test("小说家是可应用的能力，且说得出写到哪儿", () => {
  const app = applicability("novel-chapter-writer");
  assert.equal(app.can, true);
  assert.ok(app.label, "按钮上必须有字");
  assert.match(app.detail, /章/, "按之前要说清楚落到哪儿");
});

test("编剧那条路一个字节都没变", () => {
  const out = planApply("script-writer", { script: "场景1 · 潜水舱 · 夜" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.actions[0].action, "proposeScript");
  assert.match(out.actions[0].text, /场景1/);
});

test("提案带着它是为哪一章写的 —— 生成后切章不会把它写到别处", () => {
  // 他在第 5 章让 AI 写 → 切到第 6 章 → 点「用它」。没有这一条，第 5 章的正文会
  // 安静地落进第 6 章：内容是按第 5 章的任务生成的，落点却跟着屏幕跑
  //（codex 轮 2 的 BLOCKING）。
  const out = planApply(
    "novel-chapter-writer",
    { chapter: "第五章的正文" },
    { unitNo: 5 },
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.actions[0].unitNo, 5, "提案没带上它是为第几章写的");

  // 落地那一端：**屏幕上已经翻到第 6 章**，它仍然写第 5 章。
  const k = novelWork();
  const res = w.applyBodyProposal(
    k,
    { openUnitNo: 6, boundUnitNo: out.actions[0].unitNo },
    out.actions[0].text,
    "T1",
  );
  assert.equal(res.no, 5, "跟着屏幕跑了 —— 第 5 章的正文落进了第 6 章");
  assert.equal(
    k.units.find((u) => u.kind === "novel" && u.no === 6),
    undefined,
    "第 6 章被凭空写出来了",
  );
  assert.equal(k.units.find((u) => u.kind === "novel" && u.no === 5).body, "第五章的正文");
});

test("绑定过的提案连形态都不跟着屏幕走", () => {
  // 他在小说模式生成第 5 章 → **切成剧集模式** → 点「用它」。只固定章号是不够的：
  // 读当前 `work.form` 会让 `targetUnitNo` 走剧集分支，把一章小说正文写进当前集
  //（codex 轮 3 的 BLOCKING —— 轮 2 那条修复只做了这个类的一半）。
  const k = novelWork();
  w.setForm(k, "episode");
  w.setPlanned(k, "episode", 12);

  const res = w.applyBodyProposal(
    k,
    { boundUnitNo: 5, activeEpisodeIndex: 2, openUnitNo: 9 },
    "按小说第 5 章的任务写出来的正文",
    "T1",
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.word, "章", "按剧集处理了");
  assert.equal(res.no, 5);
  assert.equal(
    k.units.find((u) => u.kind === "episode"),
    undefined,
    "一章小说正文被写成了一集",
  );
  assert.equal(
    k.units.find((u) => u.kind === "novel" && u.no === 5).body,
    "按小说第 5 章的任务写出来的正文",
  );
});

test("反方向也一样：一份剧本提案不会写进一章小说", () => {
  // 他在剧集模式生成剧本 → **切成小说模式并打开第 3 章** → 点「用它」。
  // 改这段之前的老代码会拒绝这种情况（`work.form !== "episode"` 就报错），
  // 所以只给小说那一半带上形态，等于亲手开出一个反方向的新口子
  //（codex 轮 4 的 BLOCKING）。
  const k = novelWork();
  const res = w.applyBodyProposal(
    k,
    { boundForm: "episode", activeEpisodeIndex: 1, openUnitNo: 3 },
    "场景1 · 潜水舱 · 夜",
    "T1",
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.word, "集", "一份剧本被当成一章小说写进去了");
  assert.equal(res.no, 2);
  assert.equal(
    k.units.find((u) => u.kind === "novel"),
    undefined,
    "小说那一侧被这份剧本污染了",
  );
});

test("剧本提案在没有选中的集时报错，而不是退而求其次写进一章小说", () => {
  const k = novelWork();
  const res = w.applyBodyProposal(
    k,
    { boundForm: "episode", activeEpisodeIndex: -1, openUnitNo: 3 },
    "场景1 · 潜水舱 · 夜",
    "T1",
  );
  assert.equal(res.ok, false);
  assert.equal(k.units.length, 0, "拒绝了却还是写下去了");
});

test("两个真实能力的提案都自报形态", () => {
  const novel = planApply("novel-chapter-writer", { chapter: "正文" }, {});
  assert.equal(novel.actions[0].form, "novel");
  const script = planApply("script-writer", { script: "场景1" });
  assert.equal(script.actions[0].form, "episode");
  const doctor = planApply("script-doctor", { revisedScript: "场景1" });
  assert.equal(doctor.actions[0].form, "episode");
});

test("认不出来的形态不生效，回落到当前状态而不是写去一个空形态", () => {
  const k = novelWork();
  for (const boundForm of ["Novel", "", null, 1, "manga"]) {
    const res = w.applyBodyProposal(k, { boundForm, openUnitNo: 4 }, "正文", "T1");
    assert.equal(res.ok, true, `boundForm=${String(boundForm)}：${res.error}`);
    assert.equal(res.word, "章", "回落时没有用当前形态（小说）");
  }
});

test("没绑定的提案照旧看当前形态", () => {
  // 绑定是**加法**：手工触发那条路（没有 boundUnitNo）行为一个字节不变。
  const k = w.createWork(null);
  w.setForm(k, "episode");
  w.setPlanned(k, "episode", 12);
  const res = w.applyBodyProposal(k, { activeEpisodeIndex: 0 }, "第一集", "T1");
  assert.equal(res.word, "集");
  assert.equal(res.no, 1);
});

test("没有章号的提案不假装有一个", () => {
  // 手工触发（没经过带章号的 scope）时 action 里不该出现 `unitNo` —— 有一个
  // 假的章号比没有更糟：`app.js` 会优先信它。
  for (const scope of [undefined, {}, { unitNo: null }, { unitNo: "5" }, { shotId: "sh-1" }]) {
    const out = planApply("novel-chapter-writer", { chapter: "正文" }, scope);
    assert.equal(out.ok, true, out.error);
    assert.equal(
      "unitNo" in out.actions[0],
      false,
      `scope=${JSON.stringify(scope)} 时凭空带上了章号`,
    );
  }
});

test("不合规的模型输出被真实的 output.schema 拒掉", () => {
  // 轮 5 说得对：这一条**不需要真实模型**。跑的是磁盘上那份
  // `novel-chapter-writer/output.schema.json`，不是测试里为了让 controller 起来
  // 而塞的那个空壳 —— 我前几轮把它和「产出是不是散文」混成一件事，那是两件事。
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../product-skills/builtin/novel-chapter-writer/output.schema.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const skill = { skillId: "novel-chapter-writer", outputSchema: schema };

  // 合规的那一份放行。
  assert.equal(skills.validateOutput(skill, { chapter: "潜水舱的灯灭了三秒。" }), null);
  assert.equal(
    skills.validateOutput(skill, { chapter: "正文", title: "下潜", notes: "" }),
    null,
  );

  // 不合规的逐个被拒 —— 每一种都是模型真的会交出来的形状。
  for (const bad of [
    {},                                  // 什么都没给
    { chapter: "" },                     // 空正文
    { chapter: "   " },                  // 只有空白
    { chapter: 42 },                     // 类型不对
    { chapter: ["一段", "两段"] },        // 数组而不是字符串
    { chapter: null },
    { script: "场景1 · 潜水舱 · 夜" },    // 交的是编剧那份契约
    "潜水舱的灯灭了三秒。",                // 根本不是对象
  ]) {
    assert.ok(
      skills.validateOutput(skill, bad),
      `不合规的输出被放行了：${JSON.stringify(bad)}`,
    );
  }
});

test("两条路不会串：小说家不收剧本字段，编剧不收章节字段", () => {
  // 「写出来的是小说不是剧本」这件事，自动化能证的是**结构**这一半：两个能力读的
  // 是不同的字段，一份剧本提案掉不进小说的应用路径，反之亦然。内容真的是散文那
  // 一半由 prompt 与 reviewCriteria 约束，只能在真实项目上走查（如实记在卡上）。
  const scriptShaped = planApply("novel-chapter-writer", {
    script: "场景1 · 潜水舱 · 夜\n林default：氧气还剩多少？",
  });
  assert.equal(scriptShaped.ok, false, "一份剧本提案被小说家的应用路径收下了");

  const chapterShaped = planApply("script-writer", {
    chapter: "潜水舱的灯灭了三秒。",
  });
  assert.equal(chapterShaped.ok, false, "一份章节提案被编剧的应用路径收下了");
});

// --- 2b. 记录 → 翻译 → 派发，走真实的 controller ----------------------------- //

/** 把两个**真实的**能力包装进目录 —— 这一段测的是 controller 怎么读 manifest，
 *  所以 manifest 必须是磁盘上那一份，不是一个手写的形状。 */
function installRealCatalog() {
  const read = (id) =>
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../product-skills/builtin/${id}/manifest.json`, import.meta.url),
        ),
        "utf8",
      ),
    );
  const entry = (m) => ({
    skillId: m.skillId,
    version: m.skillVersion,
    work: m.work,
    role: m.role,
    title: m.title,
    purpose: m.purpose,
    inputs: m.inputs,
    optionalInputs: m.optionalInputs,
    reviewCriteria: m.reviewCriteria,
    recommendedRuntime: m.recommendedRuntime,
    routing: m.routing,
    instruction: "（不为本测试所用）",
    outputSchema: { type: "object", required: [], fields: {} },
  });
  skills.installCatalog({
    skills: [entry(read("novel-chapter-writer")), entry(read("script-writer"))],
    inputs: { outline: "故事大纲", chapterPlan: "本章任务", episodePlan: "本集规划" },
    shotScopedInputs: [],
  });
}

/** 一个真的 skillctl：真的登记表、真的 `skillrun`、真的 `skillapply`。
 *
 *  前三轮审查都指着同一处说「测试直接把章号递给写入函数，绕过了 controller 的记录
 *  与 action 派发」。这一段把那一环补上：`scopeOf` 记什么 → `apply` 把什么传给
 *  `planApply` → 派发出去的 action 长什么样，全部走真实现。
 *  `dispatchAction` 是唯一的假件，因为它那一端（`app.js` 的 handler）需要整个
 *  浏览器外壳；它记下收到的每个 action，那正是这一段要断言的东西。 */
function realController(storyWork, { dispatched = [] } = {}) {
  const registry = [];
  const ctl = createSkillController({
    docs: {
      runs: () => registry,
      production: () => ({ episodes: [], activeEpisodeId: null, characters: [], relationships: [], world: {} }),
      story: () => ({ work: storyWork }),
      script: () => ({}),
      registry: () => ({}),
      refInterp: () => ({}),
      timelines: () => ({}),
      shotAudio: () => ({}),
      subtitles: () => ({}),
      generations: () => ({}),
    },
    catalog: { detail: () => null, problems: () => [] },
    modules: {
      skills, runtime, skillrun, skillapply,
      shotctx: {}, proddoc: { activeEpisode: () => null, episodeView: () => null },
      storydoc: {
        activeBrief: () => null, approvedOutline: () => null, activeOutline: () => null,
        confirmedPlan: () => null, planForPrompt: () => [], effectivePlanEpisodes: () => [],
      },
      storywork: w,
      scriptdoc: { currentText: () => "" },
      assetreg: { listReferences: () => [] },
      refinterp: {}, timeline: {}, subtitle: {}, mediaref: {},
    },
    findShot: () => null,
    slotOf: () => null,
    isLocked: () => false,
    shotAudio: { resolved: () => [], anchors: () => [] },
    shotCtx: { build: () => ({}), candidates: () => ({}) },
    draftShots: () => [],
    dispatchAction: (act) => { dispatched.push(act); return { ok: true }; },
    persist: () => {},
    refresh: () => {},
    now: () => "2026-09-14T00:00:00Z",
  });
  return { ctl, registry, dispatched };
}

test("controller 把「这一轮写的是第几章」记进 run，而不是记完就忘", () => {
  installRealCatalog();
  const k = novelWork();
  const { ctl } = realController(k);
  const recorded = ctl.scopeOf("novel-chapter-writer", { unitNo: 5 });
  assert.ok(recorded, "这一轮什么范围都没记下来");
  assert.equal(recorded.unitNo, 5, "章号没进 run 的记录 —— 应用时就只能看屏幕了");
});

test("只有真的读了本章任务的能力才记章号", () => {
  installRealCatalog();
  const k = novelWork();
  const { ctl } = realController(k);
  // 编剧不读 `chapterPlan`，就算调用方硬塞一个章号也不该记下来 —— 记了就等于
  // 给一份它从没读过的上下文盖章（`scopeOf` 对 episode/scene/shot 的同一条规则）。
  const recorded = ctl.scopeOf("script-writer", { unitNo: 5 });
  assert.ok(
    !recorded || recorded.unitNo === undefined,
    `编剧不读本章任务，却记下了章号：${JSON.stringify(recorded)}`,
  );
});

test("应用时派发出去的 action 带着记录下来的那一章", () => {
  installRealCatalog();
  const k = novelWork();
  const dispatched = [];
  const { ctl, registry } = realController(k, { dispatched });
  const run = skillrun.startRun(registry, {
    skillId: "novel-chapter-writer",
    skillVersion: 1,
    runtime: "manual",
    executor: "manual",
    // 这一轮**记下来的**范围：第 5 章。
    context: ctl.scopeOf("novel-chapter-writer", { unitNo: 5 }),
  });
  skillrun.proposeRun(registry, run.runId, { chapter: "第五章的正文" });

  const res = ctl.applyProposal(run.runId, {});
  assert.equal(res.ok, true, res.error);
  assert.equal(dispatched.length, 1, "什么都没派发出去");
  assert.equal(dispatched[0].action, "proposeScript");
  assert.equal(
    dispatched[0].unitNo,
    5,
    "派发出去的 action 没带章号 —— 落点又回到「屏幕上现在开着哪一章」了",
  );
});

// --- 3. 形态真的被报上去 ----------------------------------------------------- //

test("每一轮对话都把形态报给服务端", () => {
  // `conversationContext` 是 `createProduction` 闭包里的私有函数，拿不到它的返回值，
  // 所以这一条只能盯源码 —— 与 convthread.test.mjs 守 `sendTurn(…, conversationContext(ctx))`
  // 同一处境、同一手法。**它的局限要说在明处**：它证明接线在，不证明接线跑对。
  // 「跑对」那一半由服务端侧的 tests/studio/test_motv_novel_chapter_routing_task146.py
  // 承担 —— 那边拿真实目录判「报了 novel 会选中谁」。
  const src = readFileSync(
    fileURLToPath(new URL("../src/ui/production.js", import.meta.url)),
    "utf-8",
  );
  const fn = src.slice(src.indexOf("function conversationContext(ctx)"));
  assert.ok(fn, "conversationContext 不见了");
  const body = fn.slice(0, fn.indexOf("\n  }\n"));

  // 形态来自那份 work，不是从别处抄的一个常量。
  assert.match(body, /convWork\s*=\s*workOf\(\)/, "形态必须读当前这份 work");
  assert.match(
    body,
    /convWork\.form\s*\?\s*\{\s*form:\s*convWork\.form\s*\}/,
    "没选形态时不许报一个空 form —— 空 = 不限，报空串会让服务端按字符串去比",
  );
  // 它必须与 readyInputs 待在同一个「非 feedback」分支里：「开发」窗口不跑作品能力，
  // 把作品上下文报进那个窗口是同一条边界上的泄漏。
  const guarded = body.slice(body.indexOf('convMode() === "feedback"'));
  assert.ok(
    guarded.indexOf("convWork.form") > 0 &&
      guarded.indexOf("convWork.form") < guarded.indexOf("route:"),
    "form 跑到 feedback 守卫外面去了",
  );
});
