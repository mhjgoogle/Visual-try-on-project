// Agent 的可操作面 = 创作者的可操作面。
//
// 产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」
//
// 所以这里不是「再列一批 Agent 专用的编辑种类」，而是**一份注册表**：界面上创作者能
// 做的动作，登记在这里，Agent 的词汇表**由它生成**。加一个动作 = 加一条记录，
// 提示词、白名单、落地、界面文案四处同时跟上 —— 不会出现「提示里说能做，落地却没有」。
//
// 三条硬规矩（AGENTS.md §1「回不了头才问」+ 第 13 条）：
//
//   1. **只登记可逆的动作。** 判据不是「名字里有没有 delete」，而是**撤销的那条路存不存在**：
//      版本化写入（新版本，旧版本一字不动）可逆；软删除（打标记 + 回收区）可逆；
//      真删字节、绑定实体身份不可逆 —— 那不是「Agent 不够聪明」，是那条路径本身该先被
//      做成可逆的。每条动作都要显式写 `undo`：撤销它的那个动作 id，或它为什么天然可逆。
//   2. **付费不在表里。** 花钱是唯一必须问创作者的事。
//   3. **走创作者自己那条函数。** 每个 `apply` 调的都是界面按钮调的同一个 `ctx.*`，
//      所以 Agent 做的和他自己点的，结果、版本语义、撤销方式完全一致（ADR-0089 决策 2b）。
//
// 还没进表的（有意留白，不是遗漏）：`confirmPlan`（确认规划会绑定剧集身份，反悔不干净）、
// 删除类、运行/生成类（花钱）。它们仍然由创作者自己点。

/** 长文字段的上限，与数据模型自己的上限对齐（`storywork.editUnit` 是 200000）。
 *
 *  白名单默认把字符串砍到 4000 字 —— 那个数是给**模型输出**定的护栏，没问题。
 *  出事的是 ADR-0096 之后**界面按钮也走这张表**：故事核心与正文的编辑器每敲一个字
 *  就调 `work.core` / `unit.write`（`production.js:1855/1976`），于是他自己写的正文
 *  一过 4000 字就被静默切掉、当场落库 —— `editUnit` 那个 200000 的上限形同虚设，
 *  而他看到的是「现在有 4000 字」，不是一句报错（补审 2026-09-05 第二轮）。
 *
 *  「Agent 能做的 = 他能做的」这条路打通之后，**给模型定的护栏就成了给他定的护栏**。
 *  所以长文动作必须自己说出上限，而不是继承一个为别的目的选的数。 */
const LONG_TEXT = 200000;

/** 一条动作。`args` 是**白名单**：模型报上来的其它键一律不落进文档。 */
import * as swork from "./storywork.js";
import * as bwork from "./blocking.js";

/** 那一镜的白膜。**与他在俯视图里拖的是同一份数据**（ADR-0094 决策 5）。 */
function blockingOf(ctx, shotId) {
  const id = String(shotId || "");
  if (!id) throw new Error("没说要改哪一镜的白膜");
  if (!ctx.blocking || typeof ctx.blocking.of !== "function") {
    throw new Error("这个项目还没有白膜的数据模型");
  }
  const b = ctx.blocking.of(id);
  if (!b) throw new Error(`没有这一镜：${id}`);
  return b;
}


/** 人物的可写栏位。**这份名单不是我编的，是 `bibledoc.CHARACTER_PROFILE_FIELDS`** ——
 *  上一版这里写着 background / speech / note 三个文档里根本不存在的栏，
 *  而 `updateCharacterProfile` 只认自己那张表，于是那三栏**被静默丢掉**：
 *  动作报「改好了」，角色设计上什么都没多出来（2026-08-31 实测）。 */
const CHAR_FIELDS = [
  "identity", "personality", "desire", "weakness", "coreConflict", "arc",
  "appearance", "costume", "visualInstruction",
];

/** 关系的可写栏位（`canondoc.RELATIONSHIP_FIELDS`）。同上：上一版的 `nature`
 *  在文档里叫 `basis`。 */
/** 场景地的可写栏位（`bibledoc.updateLocationProfile` 只认这两个）。 */
const LOC_FIELDS = ["description", "visualInstruction"];

const REL_FIELDS = [
  "basis", "aToB", "bToA", "coreConflict", "tension", "power",
  "history", "secrets", "direction", "arc", "forbidden",
];

/** 按名字拿人物 —— **没有就新建**。
 *
 *  产品负责人 2026-08-31 让 Agent 把故事核心里的三个人物搬进角色设计，三条全落空：
 *  「人物里没有「林照」」。原因不是他写错了，是这张表**只会改、不会加** ——
 *  而他的角色设计本来就是空的，于是每一条都必然失败。
 *
 *  同一个文件里的 `blocking.actor` 早就是「没有就新建」，人物和关系只是漏了。
 *  新建可逆（角色设计里能删），所以按 AGENTS.md §1 它就该直接做。
 *  重名/错字会多出一个人物 —— 代价是他看得见、删得掉，因此 `said` 里**必须明说
 *  是新建的**，不能混在「改好了」里。 */
function ensureCharacter(ctx, who) {
  const list = (ctx.prodData().production.characters) || [];
  const rec = list.find((c) => c.characterId === who || c.name === who);
  if (rec) return { rec, created: false };
  if (!ctx.bible || typeof ctx.bible.addCharacter !== "function") {
    throw new Error(`人物里没有「${who}」，这个项目也加不了人物`);
  }
  const made = ctx.bible.addCharacter(who, "formal");
  if (!made) throw new Error(`加不了人物「${who}」`);
  return { rec: made, created: true };
}

/** 一段关系的两头是不是这两个人（`characterIds`，不是 `aId/bId`）。
 *
 *  字段名值得留一句：`r.aId` / `r.aName` 在这份文档里**根本不存在**，而按它们去找
 *  会安静地永远找不到 —— 于是「就算关系已经建好也照报『没有这段关系』」。
 *  这个坑 `relationship.fields` 踩过一次，写在这里免得第三次。 */
function relBetween(ctx, aId, bId) {
  const list = (ctx.prodData().production.relationships) || [];
  const has = (r, id) => (r.characterIds || []).includes(id);
  return list.find((r) => has(r, aId) && has(r, bId)) || null;
}

/** 解析「哪一段关系」：界面给 `relationshipId`，Agent 给两个人物名字。
 *
 *  **不新建人物**（与 `relationship.add` 的差别）：删除和改方向针对的是一段
 *  已经存在的关系，为了执行它而先造一个人物出来是荒谬的。 */
function resolveRel(ctx, x) {
  if (!ctx.canon) throw new Error("这个项目没有人物关系");
  const list = (ctx.prodData().production.relationships) || [];
  const rid = String(x.relationshipId || "").trim();
  if (rid) {
    const rec = list.find((r) => r.relationshipId === rid);
    if (!rec) throw new Error(`没有这段关系：${rid}`);
    return rec;
  }
  const an = String(x.a || "").trim();
  const bn = String(x.b || "").trim();
  if (!an || !bn) throw new Error("没说是哪一段关系（给 relationshipId，或者两个人物名字）");
  const chars = (ctx.prodData().production.characters) || [];
  const A = chars.find((c) => c.characterId === an || c.name === an);
  const B = chars.find((c) => c.characterId === bn || c.name === bn);
  if (!A || !B) throw new Error(`人物里没有「${!A ? an : bn}」`);
  const rec = relBetween(ctx, A.characterId, B.characterId);
  if (!rec) throw new Error(`「${an} — ${bn}」之间还没有关系`);
  return rec;
}

/** 按名字拿场景地 —— **没有就新建**（同 `ensureCharacter`）。 */
function ensureLocation(ctx, who) {
  const list = (ctx.prodData().production.locations) || [];
  const rec = list.find((l) => l.locationId === who || l.name === who);
  if (rec) return { rec, created: false };
  if (!ctx.bible || typeof ctx.bible.addLocation !== "function") {
    throw new Error(`场景地里没有「${who}」，这个项目也加不了场景地`);
  }
  const made = ctx.bible.addLocation(who);
  if (!made) throw new Error(`加不了场景地「${who}」`);
  return { rec: made, created: true };
}

/** 这四页的正式数据模型。写路径**只有这一条** —— 他自己点、Agent 调，走的是同一组函数
 *  （产品负责人 2026-08-30：「Agent 修改的是正式数据模型，不是只修改 UI 展示文本」）。 */
function workOf(ctx) {
  const doc = ctx && ctx.story && typeof ctx.story.doc === "function" ? ctx.story.doc() : null;
  if (!doc || !doc.work) throw new Error("这个项目还没有故事开发的数据模型");
  return doc.work;
}

const ACTIONS = [
  {
    id: "brief.idea",
    label: "改核心创意",
    doc: "brief",
    undo: "写成新的一版，旧版本一字不动",
    args: { text: "一句话的核心创意" },
    apply: (ctx, a) => {
      ctx.story.setIdea(String(a.text || ""));
      return { versioned: "brief", said: `核心创意 → ${String(a.text || "").slice(0, 60)}` };
    },
  },
  {
    id: "brief.fields",
    label: "改创意简报",
    doc: "brief",
    undo: "写成新的一版，旧版本一字不动",
    fields: {
      genre: "类型/题材", tone: "基调", form: "形态",
      episodeDuration: "每集时长", totalDuration: "总时长", notes: "备注",
      targetEpisodes: "目标集数（整数 1–50）",
    },
    apply: (ctx, a) => {
      ctx.story.editBrief(a.fields);
      return { versioned: "brief", said: describe(a.fields, ACTION_BY_ID["brief.fields"].fields) };
    },
  },
  {
    id: "brief.setActive",
    label: "改用创意简报的某一版",
    doc: "brief",
    undo: "brief.setActive（指针，切回去就行）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.setActiveBrief(v)) throw new Error(`没有创意简报 v${a.v}`);
      return { said: `下游改用创意简报 v${v}` };
    },
  },
  {
    id: "brief.commit",
    label: "把创意简报存为新版本",
    doc: "brief",
    undo: "旧版本一字不动，随时切回去",
    args: { note: "这一版的说明（可选）" },
    apply: (ctx, a) => {
      // 界面「保存为新版本」按钮做的事；Agent 侧 `applyConversationEdits` 在 brief.* 之后
      // 自动做同一件事 —— 两边现在都从这张表里找得到它（TASK-127）。
      const rec = ctx.story.commitBrief("manual", String(a.note || ""));
      return rec && rec.v ? { said: `创意简报存为 v${rec.v}`, version: rec.v } : { said: "与当前版本没有差异，未新建版本" };
    },
  },
  {
    id: "outline.fields",
    label: "改故事大纲",
    doc: "outline",
    undo: "写成新的一版，旧版本一字不动",
    fields: {
      logline: "一句话故事", storyCore: "故事内核", premise: "前提",
      genreTone: "类型与调性", world: "世界", centralConflict: "核心冲突",
      storyArc: "故事弧", climax: "高潮", ending: "结局", durationNote: "时长说明",
      protagonist: "主角（who / initialWant）",
      conflict: "冲突（external / internal）",
      themeAndChange: "主题与转变（theme / protagonistBecomes）",
      mainline: "主线（setup / development / midpointTurn / climax / ending）",
      worldAndRules: "世界与规则（where）",
      episodeCount: "集数（整数 1–50）",
    },
    apply: (ctx, a, meta) => {
      const rec = ctx.story.applyManualOutline(a.fields, "developed", (meta && meta.instruction) || "");
      const said = describe(a.fields, ACTION_BY_ID["outline.fields"].fields);
      // `version` 是这次写入的**稳定身份**（TASK-119）：跨层一致性诊断以它作幂等
      // key，所以它必须是文档给的那个数，不是从 `said` 里再解析一次的字符串。
      return { said: `${said}（故事大纲 v${rec && rec.v ? rec.v : "?"}）`, version: rec && rec.v };
    },
  },
  {
    id: "outline.approve",
    label: "批准故事大纲",
    doc: "outline",
    undo: "outline.approve（改批别的版本）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.approveOutline(v)) throw new Error(`没有故事大纲 v${a.v}`);
      return { said: `已批准故事大纲 v${v}`, version: v };
    },
  },
  {
    id: "outline.setActive",
    label: "改用故事大纲的某一版",
    doc: "outline",
    undo: "outline.setActive（指针，切回去就行）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.setActiveOutline(v)) throw new Error(`没有故事大纲 v${a.v}`);
      return { said: `下游改用故事大纲 v${v}` };
    },
  },
  {
    id: "plan.entry",
    label: "改分集规划的一条",
    doc: "plan",
    undo: "改回来；未保存前它只在工作草稿里",
    args: {
      episodeId: "这一集的 id", field: "字段名（title / logline / …）", value: "新内容",
    },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanEntry(String(a.episodeId), String(a.field), String(a.value ?? ""));
      if (!ok) throw new Error(`改不了 ${a.episodeId} 的 ${a.field}`);
      return { said: `${a.episodeId} 的 ${a.field} → ${String(a.value ?? "").slice(0, 60)}`, draft: "plan" };
    },
  },
  {
    id: "plan.save",
    label: "把分集规划的修改保存为新一版",
    doc: "plan",
    undo: "写成新的一版，旧版本一字不动",
    args: {},
    apply: (ctx) => {
      const v = ctx.story.savePlanDraft();
      if (!v) return { said: "分集规划与当前版本没有差异，未新建版本" };
      // 确认（绑定剧集）仍然由创作者自己点 —— 见文件头的留白说明
      return {
        said: `分集规划已保存为 v${v}（要让下游剧集改用它，还需你在页面上确认这一版）`,
        version: v,
      };
    },
  },
  {
    id: "plan.item.add",
    label: "分集规划的列表格加一行",
    doc: "plan",
    undo: "plan.item.remove，或 plan.discard 回到已保存的版本（草稿层）",
    args: { episodeId: "这一集的 id", field: "列表字段名（mainPlot / reveals / beats …）" },
    apply: (ctx, a) => {
      const i = ctx.story.addPlanItem(String(a.episodeId || ""), String(a.field || ""));
      if (!(i >= 0)) throw new Error("这一行不在当前这一版规划里，加不了");
      return { said: `${a.field} 加了第 ${i + 1} 行` };
    },
  },
  {
    id: "plan.item.edit",
    label: "改分集规划列表格的一行",
    doc: "plan",
    undo: "改回去就行；已保存的版本一字不动",
    args: { episodeId: "这一集的 id", field: "列表字段名", index: "第几行（从 0 起）", value: "新内容" },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanItem(
        String(a.episodeId || ""), String(a.field || ""), Number(a.index), String(a.value ?? ""),
      );
      if (!ok) throw new Error(`改不了 ${a.field} 第 ${a.index} 行`);
      return { said: `${a.field} 第 ${Number(a.index) + 1} 行改好了` };
    },
  },
  {
    id: "plan.item.beat",
    label: "改「角色推进」的一格",
    doc: "plan",
    undo: "改回去就行；已保存的版本一字不动",
    args: { episodeId: "这一集的 id", index: "第几行（从 0 起）", key: "列（who / change …）", value: "新内容" },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanBeat(
        String(a.episodeId || ""), Number(a.index), String(a.key || ""), String(a.value ?? ""),
      );
      if (!ok) throw new Error(`改不了角色推进第 ${a.index} 行的 ${a.key}`);
      return { said: `角色推进第 ${Number(a.index) + 1} 行的 ${a.key} 改好了` };
    },
  },
  {
    id: "plan.item.remove",
    label: "删分集规划列表格的一行",
    doc: "plan",
    undo: "草稿层：plan.discard 回到已保存的版本；已保存版本一字不动",
    args: { episodeId: "这一集的 id", field: "列表字段名", index: "第几行（从 0 起）" },
    apply: (ctx, a) => {
      const ok = ctx.story.removePlanItem(String(a.episodeId || ""), String(a.field || ""), Number(a.index));
      if (!ok) throw new Error(`删不了 ${a.field} 第 ${a.index} 行`);
      return { said: `${a.field} 第 ${Number(a.index) + 1} 行删了（未保存前 plan.discard 可整体回退）` };
    },
  },
  {
    id: "plan.discard",
    label: "丢弃分集规划的未保存草稿",
    doc: "plan",
    undo: "只丢草稿；已保存的版本一字不动",
    args: {},
    apply: (ctx) => {
      const ok = ctx.story.discardPlanDraft();
      return { said: ok ? "分集规划回到最近保存的那一版" : "没有未保存的草稿" };
    },
  },
  {
    id: "settings.delivery",
    label: "改交付规格",
    doc: "settings",
    undo: "settings.delivery（改回原值或留空清除）",
    args: { field: "规格字段", value: "新值（留空表示清除）" },
    apply: (ctx, a) => {
      const res = ctx.setDeliverySpecField(String(a.field), a.value);
      if (!res || !res.ok) throw new Error((res && res.error) || "改不了这个规格字段");
      return { said: `${a.field} → ${res.cleared ? "（已清除）" : String(a.value).slice(0, 60)}` };
    },
  },
  // --- 删除（一律软删除，回收区可撤销）---------------------------------- //
  //
  // 产品负责人 2026-08-29：「不管是故事还是镜头。应该都可以有删除的选项。不然画面会很乱。」
  // 他自己在界面上能删，那 Agent 就能删 —— 前提同上：**撤销那条路存在**。
  {
    id: "brief.hideVersion",
    label: "删除创意简报的某一版",
    doc: "brief",
    undo: "brief.restoreVersion（版本链一字不动，只是不再显示）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.hideBriefVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `删不掉创意简报 v${a.v}`);
      return { said: `已删除创意简报 v${v}（在回收区可以撤销）` };
    },
  },
  {
    id: "brief.restoreVersion",
    label: "撤销删除创意简报的某一版",
    doc: "brief",
    undo: "brief.hideVersion",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.restoreBriefVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `撤销不了 v${a.v}`);
      return { said: `创意简报 v${v} 回来了` };
    },
  },
  {
    id: "outline.hideVersion",
    label: "删除故事大纲的某一版",
    doc: "outline",
    undo: "outline.restoreVersion（版本链一字不动，只是不再显示）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.hideOutlineVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `删不掉故事大纲 v${a.v}`);
      return { said: `已删除故事大纲 v${v}（在回收区可以撤销）` };
    },
  },
  {
    id: "outline.restoreVersion",
    label: "撤销删除故事大纲的某一版",
    doc: "outline",
    undo: "outline.hideVersion",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.restoreOutlineVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `撤销不了 v${a.v}`);
      return { said: `故事大纲 v${v} 回来了` };
    },
  },
  {
    id: "shot.hide",
    label: "删除一个镜头",
    doc: "shots",
    undo: "shot.restore（镜头进回收区，内容一字不动）",
    args: { shotId: "镜头 id" },
    apply: (ctx, a) => {
      const id = String(a.shotId || "");
      if (!ctx.shots || !ctx.shots.softDelete(id)) throw new Error(`删不掉镜头 ${id}（草稿里没有它）`);
      return { said: `已删除镜头 ${id}（在回收区可以撤销）` };
    },
  },
  {
    id: "shot.restore",
    label: "撤销删除一个镜头",
    doc: "shots",
    undo: "shot.hide",
    args: { shotId: "镜头 id" },
    apply: (ctx, a) => {
      const id = String(a.shotId || "");
      if (!ctx.shots || !ctx.shots.restoreDeleted(id)) throw new Error(`撤销不了 ${id}（回收区里没有它）`);
      return { said: `镜头 ${id} 回来了` };
    },
  },
  /* ===== 3D 导演台（TASK-123 / ADR-0094 决策 5）===========================
     「把镜头拉远一点」「让林晚从门口走到吧台」——这类话要能落成真改动，而不是一段
     建议文字。走的是他自己在俯视图里拖时的同一组函数。 */
  /* ===== 定稿版本：看得见，也要改得动（2026-08-31）=======================
     产品负责人：「你要保证服务端的 agent 可以看到所有我定稿的东西然后也可以根据我的
     意见修改。」看得见那一半在 server.py 的事实里；改得动这一半在这里 ——
     他说「回到定稿那版」「把 v2 删了」时，要能落成真动作。 */
  {
    id: "work.restoreVersion",
    label: "恢复到某一版定稿",
    doc: "work",
    undo: "所有定稿版本都还在，随时切回去",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.restoreFinalized(work, unit.id, v, at)) throw new Error(`没有 v${a.v}`);
        return { said: `第 ${a.no} 章/集回到了 v${v}` };
      }
      if (!swork.restoreDoc(work, String(a.what), v, at)) throw new Error(`没有 v${a.v}`);
      return { said: `已恢复到 v${v}（其它定稿版本一个没删）` };
    },
  },
  {
    id: "work.deleteVersion",
    label: "删掉某一版定稿",
    doc: "work",
    // **这句 `undo` 上一版是假的**：它写着「删掉就没有了」，而 `deleteDoc` 真删字节。
    // 这条动作又没声明 `reversible: false`，于是被默认补成可逆、混过了准入检查 ——
    // 那道「不可逆的不许进表」的检查因此形同虚设（补审 2026-09-05 · AGENTS.md §1）。
    // 现在删的是标记，回收区里还能拿回来，这句话才成立。
    undo: "work.undeleteVersion —— 软删除，回收区里能恢复；当前内容始终不动",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.deleteFinalized(work, unit.id, v, at)) throw new Error(`没有 v${a.v}`);
      } else if (!swork.deleteDoc(work, String(a.what), v, at)) {
        throw new Error(`没有 v${a.v}`);
      }
      ctx.persist();
      return { said: `删掉了 v${v}（当前内容没有动；回收区里还能恢复）` };
    },
  },
  {
    id: "work.undeleteVersion",
    label: "把删掉的那一版拿回来",
    doc: "work",
    undo: "work.deleteVersion",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.undeleteFinalized(work, unit.id, v)) throw new Error(`回收区里没有 v${a.v}`);
      } else if (!swork.undeleteDoc(work, String(a.what), v)) {
        throw new Error(`回收区里没有 v${a.v}`);
      }
      ctx.persist();
      return { said: `v${v} 回来了` };
    },
  },

  /* ===== 作品设定：人物 / 人物关系 / 世界观 ==============================
     他在那三页能改的，Agent 也要能改（REQ-006 判据 1）。这些是「基础财产」——
     后面写小说、做剧集都读它们。 */
  {
    id: "character.tier",
    label: "把人物设为正式 / 临时角色",
    doc: "bible",
    undo: "再切回去就行；剧情身份、参考图、出场与关系全部保留",
    args: { name: "人物名字（或 id）", tier: "formal（正式）或 bit（临时）" },
    apply: (ctx, a) => {
      const tier = a.tier === "bit" ? "bit" : a.tier === "formal" ? "formal" : null;
      if (!tier) throw new Error("tier 只能是 formal 或 bit");
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说是哪个人物");
      const list = (ctx.prodData().production.characters) || [];
      const rec = list.find((c) => c.characterId === who || c.name === who);
      if (!rec) throw new Error(`人物里没有「${who}」`);
      if (!ctx.bible.setCharacterTier(rec.characterId, tier)) throw new Error(`改不了「${rec.name}」的类型`);
      return { said: `「${rec.name}」现在是${tier === "bit" ? "临时角色" : "正式角色"}` };
    },
  },
  {
    id: "character.add",
    label: "新建人物",
    doc: "bible",
    undo: "角色设计里能删（软删除 + 回收区）",
    args: { name: "人物名", tier: "formal（正式，默认）或 bit（临时角色）" },
    apply: (ctx, a) => {
      const name = String(a.name || "").trim();
      if (!name) throw new Error("没说人物叫什么");
      const tier = a.tier === "bit" ? "bit" : "formal";
      const rec = ctx.bible.addCharacter(name, tier);
      if (!rec) throw new Error(`加不了人物「${name}」`);
      return { said: `新建了${tier === "bit" ? "临时角色" : "人物"}「${name}」`, characterId: rec.characterId };
    },
  },
  {
    id: "location.add",
    label: "新建场景地",
    doc: "bible",
    undo: "场景设计里能删（软删除 + 回收区）",
    args: { name: "场景地名" },
    apply: (ctx, a) => {
      const name = String(a.name || "").trim();
      if (!name) throw new Error("没说场景地叫什么");
      const rec = ctx.bible.addLocation(name);
      if (!rec) throw new Error(`加不了场景地「${name}」`);
      return { said: `新建了场景地「${name}」`, locationId: rec.locationId };
    },
  },
  {
    id: "character.fields",
    label: "加/改一个人物的设定（人物不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的人物在角色设计里能删",
    args: {
      name: "人物名字（或 id）—— 角色设计里没有这个人就新建一个",
      identity: "身份", personality: "性格", desire: "欲望 / 目标",
      weakness: "弱点", coreConflict: "核心矛盾", arc: "Character Arc（弧光）",
      appearance: "外貌", costume: "服装", visualInstruction: "基础视觉方向 / 画面指令",
    },
    apply: (ctx, a) => {
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说要改哪个人物");
      // 先确认改得动，再建人物。反过来的话，一次失败会留下一个空人物，
      // 而这个文件的约定是「抛错 = 没落下」（补审 2026-09-05 第二轮）。
      if (!ctx.bible || !ctx.bible.updateCharacterProfile) throw new Error("这个项目改不了人物设定");
      const { rec, created } = ensureCharacter(ctx, who);
      const fields = {};
      for (const k of CHAR_FIELDS) {
        if (typeof a[k] === "string" && a[k].trim()) fields[k] = a[k].trim();
      }
      // 落不下的栏由 `runAction` 统一说出来 —— 白名单在 `apply` 之前就把它们剥掉了，
      // 这里根本看不见（所以这段检测只能在中央那一处做）。
      if (!Object.keys(fields).length) {
        if (created) return { said: `新建了人物「${rec.name}」，但没说要写哪几栏` };
        throw new Error(`没说要把「${rec.name}」改成什么`);
      }
      ctx.bible.updateCharacterProfile(rec.characterId, fields);
      const head = created ? `新建了人物「${rec.name}」，写了` : `「${rec.name}」写了`;
      return { said: `${head} ${Object.keys(fields).length} 栏` };
    },
  },
  {
    id: "relationship.fields",
    label: "加/改一段人物关系（关系不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的关系在角色设计里能删",
    args: {
      relationshipId: "已有关系的 id（界面编辑时给；给了就不用 a / b）",
      a: "一方（人物名字）", b: "另一方（人物名字）",
      basis: "基础关系", aToB: "A 怎么看 B", bToA: "B 怎么看 A",
      coreConflict: "核心矛盾", tension: "情感张力", power: "权力关系",
      history: "共同历史", secrets: "隐藏信息 / 秘密",
      direction: "长期发展方向", arc: "Relationship Arc", forbidden: "不应发生的关系偏离",
    },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.updateRelationship) throw new Error("这个项目改不了人物关系");
      // 界面编辑的是一条**已有**的关系，手里有 id —— 直接改，不按名字反查。
      // Agent 说的是「林照和阿夏的关系」，走下面的名字路径。两条路写的是同一个函数。
      const rid = String(x.relationshipId || "").trim();
      if (rid) {
        const all = (ctx.prodData().production.relationships) || [];
        const existing = all.find((r) => r.relationshipId === rid);
        if (!existing) throw new Error(`没有这段关系：${rid}`);
        const patch = {};
        for (const k of REL_FIELDS) if (typeof x[k] === "string") patch[k] = x[k];
        if (!Object.keys(patch).length) throw new Error("没有可写的栏");
        ctx.canon.updateRelationship(rid, patch);
        return { said: `关系 ${rid} 改了 ${Object.keys(patch).join("、")}` };
      }
      const nameOf = (v) => String(v || "").trim();
      const an = nameOf(x.a);
      const bn = nameOf(x.b);
      if (!an || !bn) throw new Error("没说是哪两个人的关系");
      if (an === bn) throw new Error("一段关系要两个不同的人");
      // 两头都先落实到人物 —— 关系存的是 characterId，人物不在就没有可指的东西。
      const A = ensureCharacter(ctx, an);
      const B = ensureCharacter(ctx, bn);
      // **关系存的是 `characterIds`**（canondoc）。上一版按 r.aId / r.aName 去找 ——
      // 那四个字段在文档里根本不存在，所以就算关系已经建好，也照样报「没有这段关系」。
      const list = (ctx.prodData().production.relationships) || [];
      const has = (r, id) => (r.characterIds || []).includes(id);
      let rec = list.find((r) => has(r, A.rec.characterId) && has(r, B.rec.characterId));
      let created = false;
      if (!rec) {
        if (typeof ctx.canon.addRelationship !== "function") {
          throw new Error(`没有「${an} — ${bn}」这段关系，这个项目也加不了关系`);
        }
        rec = ctx.canon.addRelationship(A.rec.characterId, B.rec.characterId);
        if (!rec) throw new Error(`加不了「${an} — ${bn}」这段关系`);
        created = true;
      }
      const fields = {};
      for (const k of REL_FIELDS) {
        if (typeof x[k] === "string" && x[k].trim()) fields[k] = x[k].trim();
      }
      const made = [
        A.created ? `人物「${A.rec.name}」` : "",
        B.created ? `人物「${B.rec.name}」` : "",
        created ? "这段关系" : "",
      ].filter(Boolean);
      const head = made.length ? `新建了${made.join("、")}，` : "";
      if (!Object.keys(fields).length) {
        if (made.length) return { said: `${head}但没说要写哪几栏` };
        throw new Error(`没说要把「${an} — ${bn}」改成什么`);
      }
      ctx.canon.updateRelationship(rec.relationshipId, fields);
      return { said: `${head}「${an} — ${bn}」写了 ${Object.keys(fields).length} 栏` };
    },
  },
  // --- 关系的**结构**（TASK-129）：建 / 删 / 拿回来 / 改方向 --------------- //
  //
  // `relationship.fields` 管的是一段关系**写了什么**；这四条管的是**有没有这段
  // 关系、它朝哪边**。分开是因为它们的可逆性不一样：改字段改回去就行，
  // 删一段关系在切片 1 之前是不可逆的（现在是软删除 + 回收区）。
  //
  // 两种叫法都收：界面手里有 `relationshipId`，Agent 说的是「林照和阿夏的关系」。
  // 两条路解析到同一条记录，`relationship.fields` 早就是这么做的。
  {
    id: "relationship.add",
    label: "建立一段人物关系",
    doc: "bible",
    undo: "relationship.remove（软删除，回收区里拿得回来）",
    args: { a: "一方（人物名字）", b: "另一方（人物名字）" },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.addRelationship) throw new Error("这个项目加不了人物关系");
      const an = String(x.a || "").trim();
      const bn = String(x.b || "").trim();
      if (!an || !bn) throw new Error("没说是哪两个人的关系");
      if (an === bn) throw new Error("一段关系要两个不同的人");
      const A = ensureCharacter(ctx, an);
      const B = ensureCharacter(ctx, bn);
      if (relBetween(ctx, A.rec.characterId, B.rec.characterId)) {
        throw new Error(`「${an} — ${bn}」已经有一段关系了 —— 改它用 relationship.fields`);
      }
      const rec = ctx.canon.addRelationship(A.rec.characterId, B.rec.characterId);
      if (!rec) throw new Error(`加不了「${an} — ${bn}」这段关系`);
      const made = [A.created ? `人物「${an}」` : "", B.created ? `人物「${bn}」` : ""].filter(Boolean);
      const head = made.length ? `新建了${made.join("、")}，并` : "";
      return { said: `${head}建立了「${an} — ${bn}」的关系`, relationshipId: rec.relationshipId };
    },
  },
  {
    id: "relationship.remove",
    label: "删掉一段人物关系",
    doc: "bible",
    undo: "relationship.restore —— 软删除，回收区里拿得回来；各集已记的推进不受影响",
    args: { relationshipId: "关系 id（界面给）", a: "一方（人物名字）", b: "另一方" },
    apply: (ctx, x) => {
      const rec = resolveRel(ctx, x);
      if (!ctx.canon.removeRelationship(rec.relationshipId)) {
        // 唯一的拒绝原因就是它：有剧集记录了这段关系的推进。说出**怎么办**，
        // 不只说「失败」—— 那条推进是他写的创作史，得由他自己决定要不要撤。
        throw new Error("有剧集记录了这段关系的推进：先在「分集规划」移除该集的关系节拍");
      }
      return { said: "删掉了这段关系（回收区里还能拿回来）" };
    },
  },
  {
    id: "relationship.restore",
    label: "把删掉的关系拿回来",
    doc: "bible",
    undo: "relationship.remove",
    args: { relationshipId: "关系 id" },
    apply: (ctx, x) => {
      const rid = String(x.relationshipId || "").trim();
      if (!rid) throw new Error("没说要拿回哪一段关系");
      if (!ctx.canon || !ctx.canon.undeleteRelationship) throw new Error("这个项目拿不回关系");
      if (!ctx.canon.undeleteRelationship(rid)) {
        // 两种失败分开说：回收区里没有它，和这一对已经有活着的关系了。
        // 后者不是错误，是他自己后来又建了一段 —— 得由他决定留哪一段。
        const inBin = (ctx.prodData().production.deletedRelationships || [])
          .some((r) => r.relationshipId === rid);
        throw new Error(
          inBin
            ? "这两个人之间已经有一段活着的关系了 —— 一对人物只能有一段。要旧的那段，先把现在这段删掉"
            : `回收区里没有这段关系：${rid}`,
        );
      }
      return { said: "这段关系回来了" };
    },
  },
  {
    id: "relationship.swap",
    label: "调换一段关系的方向",
    doc: "bible",
    undo: "relationship.swap（再调一次就换回来）",
    args: { relationshipId: "关系 id（界面给）", a: "一方（人物名字）", b: "另一方" },
    apply: (ctx, x) => {
      const rec = resolveRel(ctx, x);
      if (!ctx.canon.swapDirection(rec.relationshipId)) throw new Error("调换不了方向");
      return { said: "已调换方向（「A 怎么看 B」与「B 怎么看 A」一起跟着换了）" };
    },
  },
  // --- 分集规划里的节拍（TASK-129）：本集推进了什么 ----------------------- //
  //
  // 三条都是**改一栏内容**，可逆性与 `work.core` 同级（改回去就行）。
  // 同一批里的 `stamp`（记录本集基于的上游版本）**没有进表**，理由写在
  // `tests/contract/test_surface_manifest.py` 的 `ALLOWED_DIRECT` 里：
  // 它是裁决 —— 「我认现在这一版上游」是他的决定，而且盖下去之后旧基线就没了。
  {
    id: "beat.text",
    label: "改本集的剧情 / 世界推进",
    doc: "canon",
    undo: "改回去就行",
    args: { episodeId: "这一集的 id", kind: "plot（剧情）或 world（世界）", lines: "一行一条" },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.setTextBeats) throw new Error("这个项目改不了分集节拍");
      const kind = String(a.kind || "");
      if (kind !== "plot" && kind !== "world") throw new Error("kind 只能是 plot 或 world");
      // 收字符串也收数组：Agent 多半给一整段，界面给的是已经切好的行。
      const raw = Array.isArray(a.lines) ? a.lines : String(a.lines ?? "").split("\n");
      const list = raw.map((s) => String(s).trim()).filter(Boolean);
      if (!ctx.canon.setTextBeats(String(a.episodeId || ""), kind, list)) {
        throw new Error(`改不了 ${a.episodeId} 的${kind === "plot" ? "剧情" : "世界"}推进`);
      }
      return { said: `${a.episodeId} 的${kind === "plot" ? "剧情" : "世界"}推进写了 ${list.length} 条` };
    },
  },
  {
    id: "beat.character",
    label: "记一个人物在本集的推进",
    doc: "canon",
    undo: "改回去就行；写空字符串等于把这一条撤掉",
    args: { episodeId: "这一集的 id", character: "人物名字或 id", beat: "这一集他怎么变了" },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.setCharacterBeat) throw new Error("这个项目改不了分集节拍");
      const who = String(a.character || "").trim();
      if (!who) throw new Error("没说是哪个人物");
      // **不新建人物** —— 节拍是「这个人在这一集怎么变了」，人物不在就是他说错了名字，
      // 这时候造一个空人物出来只会让那条节拍挂在一个谁都不认识的身份上。
      const chars = (ctx.prodData().production.characters) || [];
      const rec = chars.find((c) => c.characterId === who || c.name === who);
      if (!rec) throw new Error(`人物里没有「${who}」`);
      if (!ctx.canon.setCharacterBeat(String(a.episodeId || ""), rec.characterId, String(a.beat ?? ""))) {
        throw new Error(`记不下「${rec.name}」在 ${a.episodeId} 的推进`);
      }
      return { said: `${a.episodeId}：「${rec.name}」的推进记下了` };
    },
  },
  {
    id: "beat.relationship",
    label: "记一段关系在本集的推进",
    doc: "canon",
    undo: "改回去就行",
    args: {
      episodeId: "这一集的 id", relationshipId: "关系 id（界面给）",
      a: "一方（人物名字）", b: "另一方",
      start: "本集开始时", event: "本集发生了什么", end: "本集结束时",
    },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.setRelationshipBeat) throw new Error("这个项目改不了分集节拍");
      const rec = resolveRel(ctx, x);
      // 三栏是**一条记录**：只写一栏时另外两栏必须原样带上，否则「改了开始」
      // 会把「发生了什么」和「结束时」清空（界面那边早就是这么做的）。
      const cur =
        ((ctx.prodData().production.episodes || [])
          .find((e) => e.episodeId === String(x.episodeId || "")) || {})
          .beats;
      const old = ((cur && cur.relationship) || []).find((r) => r.relationshipId === rec.relationshipId) || {};
      const pick = (k) => (typeof x[k] === "string" ? x[k] : String(old[k] ?? ""));
      const body = { start: pick("start"), event: pick("event"), end: pick("end") };
      if (!ctx.canon.setRelationshipBeat(String(x.episodeId || ""), rec.relationshipId, body)) {
        throw new Error(`记不下这段关系在 ${x.episodeId} 的推进`);
      }
      return { said: `${x.episodeId}：这段关系的推进记下了` };
    },
  },
  {
    id: "world.fields",
    label: "改世界观",
    doc: "bible",
    undo: "改回去就行",
    fields: {
      era: "时间 / 时代", rules: "世界规则", society: "社会背景",
      regions: "主要区域", places: "主要地点", visualTone: "视觉基调", atmosphere: "整体氛围",
    },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.updateWorld) throw new Error("这个项目改不了世界观");
      ctx.canon.updateWorld(a.fields);
      return { said: describe(a.fields, ACTION_BY_ID["world.fields"].fields) };
    },
  },
  {
    // 场景设计这一页**之前根本没有动作** —— 人物和世界观都能改，场景地不能。
    // 产品负责人 2026-08-31 把设定往角色设计和世界观里搬时还没走到这一步，
    // 但下一步一定会走到（「这都会成为之后小说剧集制作的基础财产」），
    // 到时候又会是一次「回执说改好了、页面上什么都没有」。
    id: "location.fields",
    label: "加/改一个场景地（场景地不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的场景地在场景设计里能删",
    args: {
      name: "场景地名字（或 id）—— 场景设计里没有就新建一个",
      description: "描述",
      visualInstruction: "基础视觉方向 / 画面指令",
    },
    apply: (ctx, a) => {
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说要改哪个场景地");
      if (!ctx.bible || !ctx.bible.updateLocationProfile) throw new Error("这个项目改不了场景地");
      const { rec, created } = ensureLocation(ctx, who);
      const fields = {};
      for (const k of LOC_FIELDS) {
        if (typeof a[k] === "string" && a[k].trim()) fields[k] = a[k].trim();
      }
      if (!Object.keys(fields).length) {
        if (created) return { said: `新建了场景地「${rec.name}」，但没说要写哪几栏` };
        throw new Error(`没说要把「${rec.name}」改成什么`);
      }
      ctx.bible.updateLocationProfile(rec.locationId, fields);
      const head = created ? `新建了场景地「${rec.name}」，写了` : `「${rec.name}」写了`;
      return { said: `${head} ${Object.keys(fields).length} 栏` };
    },
  },
  {
    id: "blocking.actor",
    label: "加/改白膜里的一个演员",
    doc: "blocking",
    undo: "改回去；删是软删除，可恢复",
    args: {
      shotId: "镜头 id",
      name: "名字",
      fromX: "起点 X（米）",
      fromZ: "起点 Z（米）",
      toX: "终点 X（米）",
      toZ: "终点 Z（米）",
      facing: "朝向（度）",
    },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const name = String(a.name || "").trim();
      let actor = bwork.visibleActors(b).find((x) => x.name === name);
      if (!actor) actor = bwork.addActor(b, name || `演员 ${bwork.visibleActors(b).length + 1}`);
      const patch = {};
      if (a.fromX !== undefined || a.fromZ !== undefined) {
        patch.from = { x: Number(a.fromX ?? actor.from.x), z: Number(a.fromZ ?? actor.from.z) };
      }
      if (a.toX !== undefined || a.toZ !== undefined) {
        patch.to = { x: Number(a.toX ?? actor.to.x), z: Number(a.toZ ?? actor.to.z) };
      }
      if (a.facing !== undefined) patch.facing = Number(a.facing);
      bwork.editActor(b, actor.id, patch);
      return { said: `白膜里的「${actor.name}」摆好了` };
    },
  },
  {
    id: "blocking.camera",
    label: "改白膜的机位",
    doc: "blocking",
    undo: "改回去就行",
    args: {
      shotId: "镜头 id",
      which: "from / to / both",
      x: "机位 X（米）",
      z: "机位 Z（米）",
      y: "机位高度（米）",
      lookX: "看向 X",
      lookZ: "看向 Z",
      lens: "焦距（毫米）",
    },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const which = ["from", "to", "both"].includes(String(a.which)) ? String(a.which) : "both";
      const side = which === "both" ? "from" : which;
      const patch = {};
      if (a.x !== undefined || a.z !== undefined) {
        const cur = b.camera[side].at;
        patch.at = { x: Number(a.x ?? cur.x), z: Number(a.z ?? cur.z) };
      }
      if (a.lookX !== undefined || a.lookZ !== undefined) {
        const cur = b.camera[side].look;
        patch.look = { x: Number(a.lookX ?? cur.x), z: Number(a.lookZ ?? cur.z) };
      }
      if (a.y !== undefined) patch.y = Number(a.y);
      if (a.lens !== undefined) patch.lens = Number(a.lens);
      if (!bwork.setCamera(b, which, patch)) throw new Error("这个机位改不了");
      return {
        said: which === "both" ? "机位（起幅与落幅）改好了" : `机位（${which === "from" ? "起幅" : "落幅"}）改好了`,
      };
    },
  },
  {
    id: "blocking.timing",
    label: "改白膜的时长或场地",
    doc: "blocking",
    undo: "改回去就行",
    args: { shotId: "镜头 id", seconds: "时长（秒）", stage: "场地边长（米）" },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const said = [];
      if (a.seconds !== undefined && bwork.setDuration(b, Number(a.seconds))) {
        said.push(`时长 ${b.duration}s`);
      }
      if (a.stage !== undefined && bwork.setStage(b, Number(a.stage))) {
        said.push(`场地 ${b.stage}m`);
      }
      if (!said.length) throw new Error("没有可改的时长或场地");
      return { said: said.join(" · ") };
    },
  },
  /* ===== Story Development 的四页（TASK-122 第 6 步）=======================
     产品负责人 2026-08-30：「Agent 必须能够读取、修改以上所有当前内容。Agent 修改的是
     正式数据模型，不是只修改 UI 展示文本。」

     所以这几条动作调用的是 `storywork` 里那组函数 —— **和他自己在页面上点、在框里打字
     走的是同一条写路径**。不存在「Agent 专用的一份」。 */
  {
    id: "work.core",
    label: "改故事核心",
    doc: "work",
    undo: "改回去就行；「定稿」才产生历史版本",
    args: { text: "整篇故事核心（覆盖）", append: "追加在末尾的一段（可选）" },
    argMax: { text: LONG_TEXT, append: LONG_TEXT },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const add = typeof a.append === "string" ? a.append.trim() : "";
      if (add) work.core = work.core ? `${work.core}\n\n${add}` : add;
      else if (typeof a.text === "string") work.core = a.text;
      else throw new Error("没说要把故事核心改成什么");
      return { said: add ? `故事核心追加了 ${add.length} 字` : `故事核心改成了 ${work.core.length} 字` };
    },
  },
  {
    id: "work.outline",
    label: "改故事大纲",
    doc: "work",
    undo: "改回去就行；节点 id 会尽量保住，引用不会断",
    args: { text: "整份大纲（覆盖，空行分段）" },
    argMax: { text: LONG_TEXT },
    apply: (ctx, a) => {
      if (typeof a.text !== "string") throw new Error("没说要把大纲改成什么");
      const nodes = swork.setOutline(workOf(ctx), a.text);
      return { said: `大纲改成了 ${nodes.length} 个节点（编号已自动维护）` };
    },
  },
  {
    id: "plan.row.add",
    label: "结构规划加一行",
    doc: "work",
    undo: "plan.row.delete（软删除，可恢复）",
    args: { unitNo: "Unit No.（可选）", scene: "Scene（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const row = swork.addPlanRow(work, new Date().toISOString());
      if (typeof a.unitNo === "string" && a.unitNo) swork.editPlanRow(work, row.id, "unitNo", a.unitNo);
      if (typeof a.scene === "string" && a.scene) swork.editPlanRow(work, row.id, "scene", a.scene);
      return { said: `结构规划加了一行（${row.unitNo}）` };
    },
  },
  {
    id: "plan.row.edit",
    label: "改结构规划的一格",
    doc: "work",
    undo: "改回去就行",
    args: { rowId: "行 id", field: "列（unitNo/scene/purpose/characters/goal/conflict/turn/endingState）", value: "内容" },
    apply: (ctx, a) => {
      const ok = swork.editPlanRow(workOf(ctx), String(a.rowId || ""), String(a.field || ""), a.value);
      if (!ok) throw new Error(`改不了这一格（行 ${a.rowId} / 列 ${a.field}）`);
      return { said: `结构规划 ${a.rowId} 的「${a.field}」改好了` };
    },
  },
  {
    id: "plan.row.delete",
    label: "删结构规划的一行",
    doc: "work",
    undo: "plan.row.restore（进回收区，内容一字不动）",
    args: { rowId: "行 id" },
    apply: (ctx, a) => {
      if (!swork.hidePlanRow(workOf(ctx), String(a.rowId || ""), new Date().toISOString()))
        throw new Error(`删不掉 ${a.rowId}（表里没有它，或者已经删了）`);
      return { said: `已删除 ${a.rowId}（回收区里可以恢复）` };
    },
  },
  {
    id: "plan.row.restore",
    label: "撤销删除结构规划的一行",
    doc: "work",
    undo: "plan.row.delete",
    args: { rowId: "行 id" },
    apply: (ctx, a) => {
      if (!swork.restorePlanRow(workOf(ctx), String(a.rowId || "")))
        throw new Error(`撤销不了 ${a.rowId}（回收区里没有它）`);
      return { said: `${a.rowId} 回来了` };
    },
  },
  {
    id: "plan.row.link",
    label: "把一行关联到大纲节点",
    doc: "work",
    undo: "再调一次去掉那个引用",
    args: { rowId: "行 id", nodeId: "大纲节点 id", remove: "true 时只取消关联（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const row = work.plan.rows.find((r) => r.id === String(a.rowId || ""));
      if (!row) throw new Error(`表里没有 ${a.rowId}`);
      const nodeId = String(a.nodeId || "");
      if (!work.outline.nodes.some((n) => n.id === nodeId)) throw new Error(`大纲里没有节点 ${nodeId}`);
      // `remove: true` 只删不加（界面上「×」那个按钮的语义）；不带它就是切换。
      const has = row.outlineRefs.includes(nodeId);
      const next = a.remove === true
        ? row.outlineRefs.filter((x) => x !== nodeId)
        : has ? row.outlineRefs.filter((x) => x !== nodeId) : [...row.outlineRefs, nodeId];
      swork.editPlanRow(work, row.id, "outlineRefs", next);
      return { said: `${a.rowId} ${next.includes(nodeId) ? "关联到" : "取消关联"} ${nodeId}` };
    },
  },
  {
    id: "work.form",
    label: "选小说创作还是剧集创作",
    doc: "work",
    undo: "换回去就行，写下的内容不删",
    args: { form: "novel 或 episode" },
    apply: (ctx, a) => {
      if (!swork.setForm(workOf(ctx), String(a.form || ""))) throw new Error(`不认识的形态「${a.form}」`);
      return { said: a.form === "novel" ? "改成小说创作" : "改成剧集创作" };
    },
  },
  {
    id: "work.planned",
    label: "设 Planned Chapters / Episodes",
    doc: "work",
    undo: "改回去就行；减少不会删掉已经写下的章/集",
    args: { n: "数量（整数）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const n = Number(a.n);
      if (!swork.setPlanned(work, work.form, n)) throw new Error(`数量不对：${a.n}`);
      return { said: `计划写 ${n} ${work.form === "novel" ? "章" : "集"}（已经写下的不会删）` };
    },
  },
  {
    id: "unit.ensure",
    label: "打开第 N 章/集（没有就建一个空的）",
    doc: "work",
    undo: "建出来的是空章/集；什么都没写就什么都不用撤",
    args: { no: "第几章/集" },
    apply: (ctx, a) => {
      // 界面上的「章/集选择器」点下去做的就是这件事（TASK-127）：让第 N 章/集存在。
      // 幂等 —— 已经有的不会被动一个字。
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const unit = swork.ensureUnit(work, work.form, Number(a.no), new Date().toISOString());
      if (!unit) throw new Error(`第 ${a.no} 章/集不是一个有效的编号`);
      return { said: `第 ${a.no} ${work.form === "novel" ? "章" : "集"}已就位（${unit.body.length} 字）` };
    },
  },
  {
    id: "unit.write",
    label: "写某一章/集的正文",
    doc: "work",
    undo: "改回去就行；「定稿」才产生历史版本",
    args: { no: "第几章/集", text: "正文（覆盖）", append: "追加的一段（可选）", title: "标题（可选）" },
    argMax: { text: LONG_TEXT, append: LONG_TEXT },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const at = new Date().toISOString();
      const unit = swork.ensureUnit(work, work.form, Number(a.no), at);
      if (!unit) throw new Error(`第 ${a.no} 章/集不是一个有效的编号`);
      const add = typeof a.append === "string" ? a.append.trim() : "";
      // **检查的是落地之后的长度，不是参数的长度。** 往一篇已经写满的正文后面
      // 追加一个字，参数检查当然过得去 —— 出事的是拼接之后（codex 第十轮）。
      const next = add
        ? (unit.body ? `${unit.body}\n\n${add}` : add)
        : (typeof a.text === "string" ? a.text : null);
      if (next !== null) {
        if (!swork.editUnit(work, unit.id, "body", next, at)) {
          throw new Error(
            `写不进去：这一${work.form === "novel" ? "章" : "集"}` +
              `${add ? "追加后" : ""}会有 ${next.length} 字，超过 ${swork.UNIT_MAX} 字上限` +
              "，一个字都没有写进去",
          );
        }
      }
      if (typeof a.title === "string") swork.editUnit(work, unit.id, "title", a.title, at);
      return { said: `第 ${a.no} ${work.form === "novel" ? "章" : "集"}现在有 ${unit.body.length} 字` };
    },
  },
  {
    id: "work.finalize",
    label: "定稿，存一版历史",
    doc: "work",
    undo: "存下来的历史版本可以手动删",
    args: { what: "core / outline / plan / unit", no: "unit 时是第几章/集", note: "这一版的说明（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const what = String(a.what || "");
      if (what === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        const rec = swork.finalizeUnit(work, unit.id, at, String(a.note || ""));
        return { said: rec ? `第 ${a.no} 章/集存为 v${rec.v}` : "内容没变，没有重复存一版" };
      }
      if (!swork.DOC_KINDS.includes(what)) throw new Error(`不知道要定稿什么：「${a.what}」`);
      const rec = swork.finalizeDoc(work, what, at, String(a.note || ""));
      return { said: rec ? `存为 v${rec.v}` : "内容没变，没有重复存一版" };
    },
  },
];

/**
 * 三个能力标签（ADR-0096 决策 2）。加载时补默认值：这张表里的动作**默认可逆、免费、
 * 不绑身份** —— 这不是宽松，是登记的门槛：一条不可逆、又不是付费、又不绑身份的动作
 * 没有资格进表（先把它做成可逆的，AGENTS.md §1「回不了头是缺陷」），所以登记时就抛。
 * 付费动作可以登记（为了让 `runAction` 在执行时按同一条规矩拒），但今天一条也没有。
 */
for (const a of ACTIONS) {
  if (typeof a.reversible !== "boolean") a.reversible = true;
  if (typeof a.paid !== "boolean") a.paid = false;
  if (typeof a.identityBinding !== "boolean") a.identityBinding = false;
  if (!a.reversible && !a.paid && !a.identityBinding) {
    throw new Error(`动作 ${a.id} 不可逆又不付费不绑身份 —— 先把它做成可逆的，再登记`);
  }
}

const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/** 「类型/题材 → 悬疑；基调 → 冷」——落了什么，用他在页面上看到的字眼说。 */
function describe(fields, labels) {
  return Object.entries(fields || {})
    .map(([k, v]) => {
      const name = (labels && labels[k]) || k;
      const val = v && typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${String(name).replace(/（.*）$/, "")} → ${val.slice(0, 80)}`;
    })
    .join("；");
}

/** 模型看到的词汇表。**它就是这张注册表**，不是另抄一份。 */
export function actionCatalog() {
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    undo: a.undo,
    reversible: a.reversible,
    paid: a.paid,
    identityBinding: a.identityBinding,
    ...(a.fields ? { fields: a.fields } : {}),
    ...(a.args ? { args: a.args } : {}),
  }));
}

export function knownAction(id) {
  return !!ACTION_BY_ID[id];
}

/** 一条动作的三个能力标签；未知 id → null。 */
export function actionTags(id) {
  const a = ACTION_BY_ID[id];
  return a ? { reversible: a.reversible, paid: a.paid, identityBinding: a.identityBinding } : null;
}

/** 白名单过滤：只留这条动作声明过的键。结构化子对象保留它自己的一层。 */
export function sanitizeArgs(id, raw) {
  const spec = ACTION_BY_ID[id];
  if (!spec) return null;
  const src = raw && typeof raw === "object" ? raw : {};
  if (spec.fields) {
    const fields = {};
    for (const key of Object.keys(spec.fields)) {
      const val = src.fields && typeof src.fields === "object" ? src.fields[key] : src[key];
      if (typeof val === "string" && val.trim()) fields[key] = val.trim().slice(0, 2000);
      else if (typeof val === "number" && Number.isInteger(val) && val > 0 && val <= 50) fields[key] = val;
      else if (val && typeof val === "object" && !Array.isArray(val)) {
        const row = {};
        for (const [sk, sv] of Object.entries(val)) {
          if (typeof sv === "string" && sv.trim()) row[sk] = sv.trim().slice(0, 2000);
        }
        if (Object.keys(row).length) fields[key] = row;
      }
    }
    return Object.keys(fields).length ? { fields } : null;
  }
  const args = {};
  for (const key of Object.keys(spec.args || {})) {
    const val = src[key] !== undefined ? src[key] : (src.args || {})[key];
    if (typeof val === "string") {
      // 长文字段（`argMax`）**一个字都不许在这里砍**：那是他自己在编辑器里敲的字。
      // 超了由 `runAction` 当场报错，而不是悄悄留下前 20 万字。
      // 没声明 `argMax` 的字段仍然砍到 4000 —— 那道护栏管的是**模型输出**，不是他的正文。
      args[key] = spec.argMax && spec.argMax[key] ? val : val.slice(0, 4000);
    }
    else if (typeof val === "number" || typeof val === "boolean") args[key] = val;
  }
  return args;
}

/**
 * 落一条动作。抛错 = 没落下，调用方要把原因说出来（决策 6：fail-closed 并说明）。
 * @returns {{said: string, versioned?: string}}
 */
/** 白名单剥掉了哪些**有内容**的键。
 *
 *  白名单本身是对的（表外的键一律不落进文档），错的是它**一声不吭**：模型报上来
 *  `background`，剥掉，动作照样回一句「改好了」—— 他以为搬完了，其实少了几栏
 *  （2026-08-31 实测：人物的 background/speech/note、世界观的 premise 全是这样没的）。
 *
 *  所以剥掉什么要说出来。放在这里而不是每条 `apply` 里，是因为 `apply` 拿到的
 *  已经是剥完的参数 —— **它看不见自己少了什么**，34 条动作都一样。 */
function strippedKeys(spec, rawArgs) {
  const src = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const known = Object.keys(spec.fields || spec.args || {});
  const pool = spec.fields
    ? (src.fields && typeof src.fields === "object" ? src.fields : src)
    : { ...(src.args && typeof src.args === "object" ? src.args : {}), ...src };
  return Object.keys(pool).filter(
    (k) => !known.includes(k)
      && !["fields", "args", "id", "action"].includes(k)
      // 只看字符串会**漏报**：模型把内容塞进一个未知的对象/数组键时，
      // 既没写进去，也不出现在「没有这些栏」里（补审 2026-09-05 第二轮）。
      && pool[k] !== undefined && pool[k] !== null
      && (typeof pool[k] !== "string" || pool[k].trim()),
  );
}

export function runAction(ctx, id, rawArgs, meta) {
  const spec = ACTION_BY_ID[id];
  if (!spec) throw new Error(`本应用没有「${id}」这个动作`);
  // 标签在这里统一判（ADR-0096 决策 2）—— 不在每条 apply 里各判一次。
  //   paid            → 谁调都拒：花钱是唯一必须问创作者的事，不由这张表替他决定
  //   identityBinding → 只有他自己点（origin "ui"）才行；Agent 反悔不干净
  const origin = meta && typeof meta.origin === "string" ? meta.origin : "agent";
  if (spec.paid) throw new Error(`「${spec.label}」要花钱 —— 这张表不替你决定花钱的事`);
  if (spec.identityBinding && origin !== "ui") {
    throw new Error(`「${spec.label}」会绑定身份，只能由你自己在界面上点`);
  }
  const args = sanitizeArgs(id, rawArgs);
  if (args === null) throw new Error(`「${spec.label}」没有收到能写的内容`);
  // 长文超上限 = **拒绝**，并说清楚超了多少。fail-closed 并说明白，而不是留下
  // 前 N 个字让他以为写进去了 —— 只把上限从 4000 抬到 20 万，是把「静默丢字」
  // 挪远一格，不是修掉它（codex 补审 2026-09-05 第九轮）。
  for (const [key, max] of Object.entries(spec.argMax || {})) {
    const v = args[key];
    if (typeof v === "string" && v.length > max) {
      throw new Error(
        `「${(spec.args && spec.args[key]) || key}」超过 ${max} 字上限` +
          `（这次是 ${v.length} 字），一个字都没有写进去 —— 先拆开再写`,
      );
    }
  }
  const out = { ...spec.apply(ctx, args, meta || {}), label: spec.label };
  const extra = strippedKeys(spec, rawArgs);
  if (extra.length) {
    out.said = `${out.said}；「${spec.label}」没有 ${extra.join("、")} 这些栏，它们没有写进去`;
  }
  return out;
}

export { ACTIONS as _ACTIONS };
