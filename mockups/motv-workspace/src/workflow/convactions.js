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

/** 一条动作。`args` 是**白名单**：模型报上来的其它键一律不落进文档。 */
import * as swork from "./storywork.js";

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
    args: { rowId: "行 id", nodeId: "大纲节点 id" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const row = work.plan.rows.find((r) => r.id === String(a.rowId || ""));
      if (!row) throw new Error(`表里没有 ${a.rowId}`);
      const nodeId = String(a.nodeId || "");
      if (!work.outline.nodes.some((n) => n.id === nodeId)) throw new Error(`大纲里没有节点 ${nodeId}`);
      const next = row.outlineRefs.includes(nodeId)
        ? row.outlineRefs.filter((x) => x !== nodeId)
        : [...row.outlineRefs, nodeId];
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
    id: "unit.write",
    label: "写某一章/集的正文",
    doc: "work",
    undo: "改回去就行；「定稿」才产生历史版本",
    args: { no: "第几章/集", text: "正文（覆盖）", append: "追加的一段（可选）", title: "标题（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const at = new Date().toISOString();
      const unit = swork.ensureUnit(work, work.form, Number(a.no), at);
      if (!unit) throw new Error(`第 ${a.no} 章/集不是一个有效的编号`);
      const add = typeof a.append === "string" ? a.append.trim() : "";
      if (add) swork.editUnit(work, unit.id, "body", unit.body ? `${unit.body}\n\n${add}` : add, at);
      else if (typeof a.text === "string") swork.editUnit(work, unit.id, "body", a.text, at);
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
    ...(a.fields ? { fields: a.fields } : {}),
    ...(a.args ? { args: a.args } : {}),
  }));
}

export function knownAction(id) {
  return !!ACTION_BY_ID[id];
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
    if (typeof val === "string") args[key] = val.slice(0, 4000);
    else if (typeof val === "number" || typeof val === "boolean") args[key] = val;
  }
  return args;
}

/**
 * 落一条动作。抛错 = 没落下，调用方要把原因说出来（决策 6：fail-closed 并说明）。
 * @returns {{said: string, versioned?: string}}
 */
export function runAction(ctx, id, rawArgs, meta) {
  const spec = ACTION_BY_ID[id];
  if (!spec) throw new Error(`本应用没有「${id}」这个动作`);
  const args = sanitizeArgs(id, rawArgs);
  if (args === null) throw new Error(`「${spec.label}」没有收到能写的内容`);
  return { ...spec.apply(ctx, args, meta || {}), label: spec.label };
}

export { ACTIONS as _ACTIONS };
