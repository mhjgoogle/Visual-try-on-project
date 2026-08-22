// TASK-097 批次 4C —— 第 ② 步「准备资产」，作为规则：
//
//   1. 底部那句「检测到 5 个人物角色和 3 个场景和 2 个道具没有设定图」是**待办，
//      不是阻塞**（§2.5f 第二条）。这个模块**不返回 blockers**。
//   2. 「还差几个」**从 `assetReadiness` 派生并按 kind 重排**，不重新数一遍
//      （§2.5c / §2.6.2）。
//   3. 「AI 抽出的清单」与「登记表里的实体」是一条缝（§2.5e）：两处陈述同一件事实，
//      所以它们必须在**一个模型里**算出来。
//   4. **「还没抽取过」与「抽过、没有新东西」是两件事**（§2.5f 第一条）：
//      混成一个就是把「我不知道」实现成「已经齐了」。
//   5. 构图规范来自 **Skill 包**，拿不到就 fail-closed 说清后果（见
//      `creatorobject.test.mjs` 里那条；这里只钉「三类都能拿到自己那一段」）。
//
// 纯测试：无 DOM、无网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assetPrepModel, prepGroups, gapLine, reconcile, PREP_KINDS, prepKind,
} from "../src/workflow/assetprep.js";
import { assetReadiness, buildEntityIndex } from "../src/workflow/shotentity.js";
import * as pdoc from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import { parseBreakdown, matchProposals } from "../src/workflow/breakdown.js";
import { installCatalog, promptBlock } from "../src/workflow/skills.js";
import {
  migrateToCurrent, validateCanvasDoc, CANVAS_SCHEMA_VERSION, MIGRATIONS,
} from "../src/services/canvasschema.js";
import { ensureDeclaration } from "../src/workflow/assetreg.js";
import { quoteView } from "../src/workflow/genspec.js";

/** 一个有三类对象的真实文档：走 `proddoc` / `bibledoc` 的写路径建，不手写形状。 */
function docWith() {
  const prod = pdoc.createProduction(null);
  const c1 = bd.addCharacter(prod, "沈昭昭");
  bd.updateCharacterProfile(prod, c1.characterId, { appearance: "干枯中长发" });
  const c2 = bd.addCharacter(prod, "许渡");
  const l1 = bd.addLocation(prod, "便利店外");
  bd.updateLocationProfile(prod, l1.locationId, { description: "夜，霓虹" });
  const p1 = bd.addProp(prod, "青铜钥匙");
  bd.updatePropProfile(prod, p1.propId, { description: "带锈" });
  return { prod, c1, c2, l1, p1 };
}

const shotsNaming = (...names) =>
  names.map((n, i) => ({ shotId: `shot-${i}`, title: `镜 ${i}`, description: `${n} 出现在画面里` }));

/* ========================================================================= */
/* 1. 三组卡片                                                                */
/* ========================================================================= */

test("三组是闭集，顺序是产品负责人给的：角色 / 场景 / 道具", () => {
  assert.deepEqual(PREP_KINDS.map((k) => k.kind), ["character", "location", "prop"]);
  assert.deepEqual(PREP_KINDS.map((k) => k.label), ["角色", "场景", "道具"]);
  assert.equal(prepKind("prop").word, "道具");
  assert.equal(prepKind("nope"), null);
});

test("每张卡是名称 + 描述摘要 + 有没有设定图；描述缺了就是空，不编", () => {
  const { prod, c1, p1 } = docWith();
  const groups = prepGroups({ prod, hasReferenceImage: (k, id) => id === c1.characterId });
  const chars = groups.find((g) => g.kind === "character");
  assert.deepEqual(chars.rows.map((r) => r.name), ["沈昭昭", "许渡"]);
  assert.equal(chars.rows[0].summary, "干枯中长发");
  assert.equal(chars.rows[0].ready, true);
  assert.equal(chars.rows[1].summary, "", "没写描述就是空 —— 界面自己说「还没写描述」");
  assert.equal(chars.rows[1].ready, false);
  assert.equal(chars.ready, 1);
  assert.equal(chars.total, 2);
  // 道具与场景走同一个组件读同构数据
  const props = groups.find((g) => g.kind === "prop");
  assert.deepEqual(props.rows.map((r) => r.id), [p1.propId]);
  assert.equal(props.rows[0].summary, "带锈");
});

/* ========================================================================= */
/* 2. 缺口是待办，且不重新计数                                                  */
/* ========================================================================= */

test("那句缺口话术**从 `assetReadiness` 派生**，且不返回 blockers", () => {
  const { prod } = docWith();
  const shots = shotsNaming("沈昭昭", "许渡", "便利店外", "青铜钥匙");
  const m = assetPrepModel({ prod, shots, hasReferenceImage: () => false });
  // 与 `assetReadiness` 同源：数字对得上，不是第二次计数
  const direct = assetReadiness({
    index: buildEntityIndex(prod), shots, hasReferenceImage: () => false,
  });
  assert.equal(m.readiness.total, direct.total);
  assert.equal(m.readiness.missing.length, direct.missing.length);
  assert.equal(m.todo, "检测到 2 个人物角色和 1 个场景和 1 个道具没有设定图");
  // **不是阻塞**：这个模型里没有 blockers 这种东西
  assert.equal("blockers" in m, false);
  assert.equal(/不能|无法|还不能开始/.test(m.todo), false, "话术里没有「不能开始」");
});

test("缺席的类别整段省略；全齐了就不说缺口", () => {
  const { prod, c1 } = docWith();
  const shots = shotsNaming("沈昭昭", "便利店外");
  const one = assetPrepModel({ prod, shots, hasReferenceImage: (k, id) => id === c1.characterId });
  assert.equal(one.todo, "检测到 1 个场景没有设定图", "不打印「和 0 个道具」");
  const all = assetPrepModel({ prod, shots, hasReferenceImage: () => true });
  assert.equal(all.todoState, "ready");
  assert.match(all.todo, /2 个对象都已经有设定图/);
  assert.equal(gapLine(null), "");
  assert.equal(gapLine({ missing: [] }), "");
});

test("**一个都没识别出来 ≠ 都已经有设定图**（真实项目上抓到的那一条）", () => {
  // 真实项目第一次打开这块面板就是这个状态：那一集的镜头描述里还没点到任何实体。
  // 第一版把 `missing.length === 0` 读成「齐了」，屏幕上写着「这一集用到的对象都
  // 已经有设定图」—— 而我们其实什么都不知道。这与「不知道 ≠ 0」是同一条（§2.5f）。
  const { prod } = docWith();
  const nothing = assetPrepModel({ prod, shots: [], hasReferenceImage: () => false });
  assert.equal(nothing.readiness.total, 0, "前提：确实一个都没识别出来");
  assert.equal(nothing.todoState, "unknown");
  assert.equal(/都已经有设定图/.test(nothing.todo), false, "不得把「不知道」印成「齐了」");
  assert.match(nothing.todo, /还没从分镜表里识别出任何对象/);
  // 三态互不相同，且各自能被区分
  const gap = assetPrepModel({ prod, shots: shotsNaming("沈昭昭"), hasReferenceImage: () => false });
  const ready = assetPrepModel({ prod, shots: shotsNaming("沈昭昭"), hasReferenceImage: () => true });
  assert.deepEqual(
    [nothing.todoState, gap.todoState, ready.todoState],
    ["unknown", "gap", "ready"],
  );
});

/* ========================================================================= */
/* 3 + 4. AI 抽出的清单 ↔ 登记表：一条缝，一个模型                              */
/* ========================================================================= */

test("**还没抽取过**与**抽过、没有新东西**是两件事", () => {
  const { prod } = docWith();
  const never = reconcile({ prod, proposals: null });
  assert.equal(never.known, false);
  assert.match(never.text, /还没有从分镜表抽取过/);
  const clean = reconcile({ prod, proposals: [] });
  assert.equal(clean.known, true);
  assert.match(clean.text, /都已经在作品设定里/);
  // 把两者混成一个，就是把「我不知道」实现成「已经齐了」（§2.5f 第一条）
  assert.notEqual(never.text, clean.text);
});

test("抽出的清单与登记表在**一个模型里**对账 —— 两个数字不可能各说各话", () => {
  const { prod } = docWith();
  const parsed = parseBreakdown({
    characters: [{ name: "沈昭昭", appearance: "更细的描述" }, { name: "新角色" }],
    locations: [{ name: "金銮殿" }],
    props: [{ name: "青铜钥匙", description: "带锈的青铜钥匙" }, { name: "旧监视器" }],
  });
  const cards = matchProposals(prod, parsed);
  const rec = reconcile({ prod, proposals: cards });
  assert.equal(rec.known, true);
  const byKind = new Map(rec.registry.map((r) => [r.kind, r]));
  // 登记表里的数目
  assert.equal(byKind.get("character").registry, 2);
  assert.equal(byKind.get("prop").registry, 1);
  // AI 说还要新增的
  assert.equal(byKind.get("character").proposedNew, 1, "新角色");
  assert.equal(byKind.get("prop").proposedNew, 1, "旧监视器");
  assert.equal(byKind.get("location").proposedNew, 1, "金銮殿");
  // 同名的那些被认出来是**更新**，不是新增 —— 这正是那条缝：AI 说「要沈昭昭」，
  // 登记表里已经有她
  const known = rec.pending.filter((x) => x.inRegistry);
  assert.deepEqual(known.map((x) => x.name).sort(), ["沈昭昭", "青铜钥匙"]);
  assert.equal(known.every((x) => x.isNew === false), true);
  assert.match(rec.text, /1 个角色、1 个场景、1 个道具/);
});

/* ========================================================================= */
/* 5. 构图规范来自 Skill 包（三类各一段）                                       */
/* ========================================================================= */

test("三类都能从 Skill 包里拿到自己那一段构图规范；缺了 fail-closed", () => {
  // 目录从**真实的包**装进来，不手写（§2.6.3 第 2 条）
  const manifest = JSON.parse(readFileSync(
    new URL("../../../product-skills/builtin/base-asset-designer/manifest.json", import.meta.url),
    "utf8",
  ));
  installCatalog({
    skills: [{
      skillId: manifest.skillId,
      version: manifest.skillVersion,
      instruction: "（不为本测试所用）",
      outputSchema: { type: "object", required: [], fields: {} },
      promptBlocks: manifest.promptBlocks,
      optionalInputs: manifest.optionalInputs,
    }],
    inputs: {},
    shotScopedInputs: [],
  });
  for (const kind of ["character", "location", "prop"]) {
    const b = promptBlock("base-asset-designer", `compositionSpec.${kind}`);
    assert.equal(b.ok, true, `${kind} 拿不到构图规范`);
    assert.ok(b.text.length > 10);
  }
  // 角色那一段必须真的说了四视图那几件事 —— 它存在的目的就是让这张图能当参考图用
  const spec = promptBlock("base-asset-designer", "compositionSpec.character").text;
  for (const must of ["四视图", "纯白背景", "无表情", "水印"]) {
    assert.ok(spec.includes(must), `构图规范少了「${must}」`);
  }
  // 拿不到时**说清后果**，不返回一段差不多的默认文本
  const miss = promptBlock("base-asset-designer", "compositionSpec.nope");
  assert.equal(miss.ok, false);
  assert.equal(miss.text, null);
  assert.match(miss.reason, /promptBlocks\.compositionSpec\.nope/);
  const noSkill = promptBlock("not-a-skill", "compositionSpec.character");
  assert.equal(noSkill.ok, false);
  assert.match(noSkill.reason, /没装上|加载失败/);
});

/* ========================================================================= */
/* 6. 全局风格不是新字段                                                       */
/* ========================================================================= */

test("全局风格 = 世界观的「视觉基调」，同一份（不是第二个字段）", () => {
  const { prod } = docWith();
  prod.world.visualTone = "冷白霓虹，颗粒感";
  const m = assetPrepModel({ prod, shots: [], hasReferenceImage: () => false });
  assert.equal(m.style, "冷白霓虹，颗粒感");
  // 界面写入走的也是那一处 —— 守卫钉住它不新开一个 globalStyle
  const view = readFileSync(new URL("../src/ui/assetprepview.js", import.meta.url), "utf8");
  assert.match(view, /ctx\.canon\.updateWorld\(\{ visualTone/);
  // 精确到**标识符**，不是「文件里出现过这个词」—— 上一版这条守卫被自己的注释
  // 匹配到了，于是它在报一个不存在的缺陷（一条会误报的守卫迟早被删掉）。
  assert.equal(/globalStyle\s*[:=(]/.test(view), false, "不得引入第二个「全局风格」字段");
});

/* ========================================================================= */
/* 7. v16 → v17 迁移必须让**真实形状**的文档仍然能加载                          */
/* ========================================================================= */

test("v17 迁移给每一条资产补上 `links.propId` —— 包括**嵌在 history 里**的那些", () => {
  // 这条守卫是一个真实缺陷买来的：第一版迁移按「桶 → 行」两层遍历，而链接真正
  // 住在每条资产链的 **history 记录**上。后果是真实项目 `migrate: invalid`：
  // 界面照常渲染，作品设定却全空（6 个角色变 0 个）。
  //
  // **1629 项测试全绿**，因为套件里唯一那条「真实文档迁移」测试
  // （assets.test.mjs 的 `REAL saved fixtures…`）指向两个**不存在**的 fixture，
  // 于是 `existsSync` 让它整个跳过 —— 一条什么都不检查的守卫（§2.6.3 第 1 条）。
  // 所以这里不引用外部文件：文档由**迁移链自己**产出，链接形状照抄产品真正写下的
  // 那一种（`mediaref` 的 `{current, history:[…]}`）。
  const doc = { v: 1, nodes: [] };
  // **迁到 v16 为止**（`propId` 是 v16→v17 加的）。此前写成 `CANVAS_SCHEMA_VERSION - 1`，
  // 于是 v18 一落地这条守卫就变成在测 v17→v18 —— 检查的已经不是它自己那件事了。
  // 又一处「钉在相对版本号上」的守卫（§2.6.3 第 1 条：钉死的守卫会静默变成别的东西）。
  const V16 = 16;
  for (let from = 1; from < V16; from++) MIGRATIONS[from](doc);
  doc.v = V16;
  // 每条记录由**生产函数** `ensureDeclaration` 补全（§2.6.3 第 2 条：手写 fixture
  // 会发明字段，也会漏掉字段 —— 第一版就漏了几个，于是校验因为别的原因失败，
  // 差点让我以为迁移还是坏的）。补完之后再把 `propId` 摘掉，得到一份 v16 的形状。
  const v16Record = (version, url) => {  // 每个版本一条独立记录（校验要求 assetId 唯一）
    const rec = ensureDeclaration({
      assetId: `asset-${version}`, version, url, digest: null,
      origin: "upload", storageState: "local", kind: "character-reference",
    });
    delete rec.links.propId; // v16 里没有这个键
    return rec;
  };
  doc.assets.images["林照 Ref"] = {
    current: 2,
    history: [v16Record(1, "/api/uploads/p/a_v1.png"), v16Record(2, "/api/uploads/p/a_v2.png")],
  };
  assert.equal("propId" in doc.assets.images["林照 Ref"].history[0].links, false, "前提：v16 没有这个键");

  const res = migrateToCurrent(structuredClone(doc));
  assert.equal(res.status, "ok", `真实形状的 v16 文档必须能迁移：${res.reason || ""}`);
  assert.equal(validateCanvasDoc(res.doc), null, "迁移后必须通过校验");
  for (const rec of res.doc.assets.images["林照 Ref"].history) {
    assert.equal(rec.links.propId, null, "每一条 history 记录都补上了，且是 null（不知道）");
  }
  // 加法：老数据一个字节不改 —— 其他链接键仍是原值
  assert.equal(res.doc.assets.images["林照 Ref"].current, 2);
  assert.equal(res.doc.assets.images["林照 Ref"].history[1].url, "/api/uploads/p/a_v2.png");
  // 而 props 是空数组，不回填任何条目（回填等于替创作者发明道具）
  assert.deepEqual(res.doc.production.props, []);
});

/* ========================================================================= */
/* 8. 报价只来自 preflight，而且**字段名要对**                                  */
/* ========================================================================= */

test("报价用的是 `quoteView` 真实的字段，没有报价就如实说（真实屏幕上曾印出 undefined）", () => {
  const raw = readFileSync(new URL("../src/ui/assetprepview.js", import.meta.url), "utf8");
  // **只看代码，不看注释。** 这条守卫的上一版把自己的注释匹配了进去，于是在报一个
  // 不存在的缺陷 —— 与上面 globalStyle 那条同一个错，第二次犯，所以这里剥掉注释行。
  const view = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // `quoteView` 返回 available / reason / cost —— 没有 `text`，也没有 `ok`。
  // 第一版照想象写了 `q.text`，于是真实屏幕上印的是 "undefined"（§2.6.4）。
  assert.equal(/\bq\.text\b/.test(view), false, "quoteView 没有 text 字段");
  assert.equal(/\bq\.ok\b/.test(view), false, "quoteView 没有 ok 字段");
  assert.match(view, /q\.available/);
  assert.match(view, /q\.cost\.jpy/);
  assert.match(view, /q\.reason/);
  // 而且**不自算**：界面里不得出现单价乘数量
  assert.equal(/jpy\s*\*|\*\s*count|unitPrice/.test(view), false, "界面不得自算报价");
  // 真实契约核对，不是照抄我的记忆
  const q = quoteView(null);
  assert.equal(q.available, false);
  assert.equal(typeof q.reason, "string");
  assert.equal("text" in q, false);
  const priced = quoteView({ cost: { jpy: 18 }, inputs: {} });
  assert.equal(priced.available, true);
  assert.equal(priced.cost.jpy, 18);
});

/* ========================================================================= */
/* 9. 「确认生成」必须用**框里那段文字**（codex 本批 round 1 的 P1）              */
/* ========================================================================= */

test("生成用的是 textarea 的当前内容，改动先存成新版本 —— 不静默丢掉", () => {
  // 第一版无视了那个可编辑的框，转头重新读一遍生效版本：创作者改完按「确认生成」，
  // 出图用的是他改之前那一版，而且没有任何提示。这是「看不见的改动无法被拒绝」
  // 那条的镜像 —— **看得见、以为生效了，实际被丢掉**。
  const view = readFileSync(new URL("../src/ui/assetprepview.js", import.meta.url), "utf8");
  const code = view.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const handler = code.slice(code.indexOf('[data-ap-generate]'));
  assert.match(handler, /querySelector\("\[data-ap-prompt\]"\)/, "取的是框里的值");
  assert.match(handler, /generate\(kind, id, box \? box\.value : null\)/, "并把它交给控制器");

  // 控制器侧：不同就先存版本，锁定就如实拒绝，不用旧的那版偷偷生成
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("generate: (kind, entityId, edited = null)"));
  const body = fn.slice(0, fn.indexOf("\n    upload:"));
  assert.match(body, /ctx\.basePrompt\.save\(kind, entityId, null, text\)/, "经既有版本路径落盘");
  assert.match(body, /before\.locked/, "锁定的提示词不被覆盖");
  assert.equal(/ctx\.basePrompt\.effective\([^)]*\)\.text\s*\)/.test(body), false);
});

/* ========================================================================= */
/* 10. round 2 的三条：两条修掉，一条驳回（都钉住）                              */
/* ========================================================================= */

test("道具**不得带 states** —— 水合时摘掉，否则一次 load→save 产出自己拒绝加载的文档", () => {
  // 「宽容地读」（`...p` 保留未知字段）与「严格地校验」（schema 拒绝带 states 的道具）
  // 之间的缝：两边必须对同一件事说同一句话（codex round 2 的 P1）。
  const prod = pdoc.createProduction({
    activeEpisodeId: "ep-1",
    episodes: [{ episodeId: "ep-1", title: "第 1 集", scenes: [] }],
    props: [{ propId: "prop-1", name: "青铜钥匙", profile: { description: "带锈" },
      referenceAssetIds: [], activeReferenceAssetId: null,
      states: [{ stateId: "st-1", name: "被折断" }] }],
  });
  assert.equal("states" in prod.props[0], false, "水合就把它摘掉了");
  // 而且往返之后文档仍然是可加载的（这才是这条规则的意义）
  const doc = { v: 1, nodes: [] };
  for (let f = 1; f < CANVAS_SCHEMA_VERSION; f++) MIGRATIONS[f](doc);
  doc.v = CANVAS_SCHEMA_VERSION;
  doc.production = pdoc.serialize(prod);
  assert.equal(validateCanvasDoc(doc), null, `往返后必须仍可加载：${validateCanvasDoc(doc)}`);
  // 反方向：真的带着 states 的道具**会**被校验拒绝（守卫不是空的）
  doc.production.props[0].states = [{ stateId: "st-1", name: "被折断" }];
  assert.match(String(validateCanvasDoc(doc)), /carries states/);
});

test("道具 id 与人物 / 场景地**同一个命名空间** —— 撞了必须拒（round 2 那条驳回）", () => {
  // codex 报「校验查的是 locStates/charStates 而不是 id 集合」。不成立：那两个 Map
  // **就是**按 characterId / locationId 建的键，既有代码第 2138 行判断
  // 「场景地 id 撞上人物 id」用的是完全相同的写法。这个测试把它钉住：
  // 一个复用了人物 id 的道具必须被拒绝。
  const doc = { v: 1, nodes: [] };
  for (let f = 1; f < CANVAS_SCHEMA_VERSION; f++) MIGRATIONS[f](doc);
  doc.v = CANVAS_SCHEMA_VERSION;
  const prod = pdoc.createProduction(null);
  const c = bd.addCharacter(prod, "林照");
  bd.addProp(prod, "钥匙");
  prod.props[0].propId = c.characterId; // 手工造一次撞号
  doc.production = pdoc.serialize(prod);
  assert.match(String(validateCanvasDoc(doc)), /duplicate propId/,
    "撞号不拒的话，`entityOf` 会把参考图挂到错的对象上");
  // 反方向：不撞号的道具照常通过
  prod.props[0].propId = "prop-unique";
  doc.production = pdoc.serialize(prod);
  assert.equal(validateCanvasDoc(doc), null);
});

test("「从资产库选」真的挂得上 —— 不是一个只弹提示的按钮（round 2 的 P1）", () => {
  const view = readFileSync(new URL("../src/ui/assetprepview.js", import.meta.url), "utf8");
  const code = view.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // 列出候选 + 每个候选一个真的挂接动作
  assert.match(code, /ctx\.assetPrep\.libraryOptions\(kind\)/);
  assert.match(code, /data-ap-attach=/);
  assert.match(code, /ctx\.assetPrep\.attachFromLibrary\(kind, id, assetId\)/);
  // 而且挂接走既有那一条路径，不新开
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("attachFromLibrary: (kind, entityId, assetId)"));
  assert.match(fn.slice(0, 700), /ctx\.baseAssets\.attach\(kind, entityId, null, assetId/);
  // 候选集与基础资产面板同源（§2.5e）
  assert.match(app, /libraryOptions: \(kind\) => ctx\.baseAssets\.referenceOptions\(kind\)/);
});
