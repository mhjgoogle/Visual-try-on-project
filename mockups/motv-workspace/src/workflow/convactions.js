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
      return { said: `${said}（故事大纲 v${rec && rec.v ? rec.v : "?"}）` };
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
      return { said: `已批准故事大纲 v${v}` };
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
      return { said: `分集规划已保存为 v${v}（要让下游剧集改用它，还需你在页面上确认这一版）` };
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
