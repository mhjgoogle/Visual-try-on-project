// 把一轮对话提出的改动，落到作品上。
//
// WHERE THIS RUNS AND WHY (ADR-0089 决策 2b)：创作文档由**前端**整份保存，所以落地
// 只能在前端；服务端不偷改他的文档。这里走的是**创作者自己那条编辑路径** —— 他点
// 按钮时调用的同一批函数（`setIdea` / `editBrief`，然后 `commitBrief`），因此结果与
// 他手动改一模一样：**新的一版**，旧版本一字不动（决策 3）。可逆，所以不问就能落
// （AGENTS.md §1「回不了头才问」）。
//
// 不在这里落地的：`story.outline`。大纲版本是 8 个文本字段 + 人物 + 集数的结构，一段
// 自由文本没法安全映射过去，硬映射等于让模型改写他已批准的大纲 —— 那正是「不可逆」。
// 它继续停在「它建议的改动」，由他自己那条大纲路径处理。

/** 简报字段的中文名 —— 与创意简报页面上的标签同一套说法。 */
export const BRIEF_LABEL = {
  genre: "类型/题材",
  tone: "基调",
  form: "形态",
  episodeDuration: "每集时长",
  totalDuration: "总时长",
  notes: "备注",
  targetEpisodes: "目标集数",
};

/** 这一轮里，哪些改动是这条路径能落的。 */
export function applicableEdits(run) {
  const out = run && run.outputs && run.outputs.conversation;
  const edits = out && Array.isArray(out.edits) ? out.edits : [];
  return edits.filter((e) => (
    e && typeof e === "object"
    && (e.kind === "brief.idea"
      || (e.kind === "brief.fields" && e.fields && typeof e.fields === "object"))
  ));
}

/**
 * 落地一轮的改动。
 *
 * @param story  ctx.story —— 创作者自己那条写路径（setIdea / editBrief / commitBrief）
 * @param run    终态的 run（带 outputs.conversation.edits），外加 `instruction`：
 *               他原本说的那句话，用来记进版本的来历
 * @returns [{kind, detail, error?}] —— 每一条都要能在屏幕上说清楚落了什么、
 *          或者为什么没落下。空数组 = 这一轮没有可落的改动。
 */
export function applyConversationEdits(story, run) {
  const edits = applicableEdits(run);
  const landed = [];
  let dirty = false;
  for (const e of edits) {
    try {
      if (e.kind === "brief.idea") {
        story.setIdea(String(e.text || ""));
        dirty = true;
        landed.push({ kind: e.kind, detail: String(e.text || "").slice(0, 200) });
      } else {
        story.editBrief(e.fields);
        dirty = true;
        landed.push({
          kind: e.kind,
          detail: Object.entries(e.fields)
            .map(([k, v]) => `${BRIEF_LABEL[k] || k} → ${String(v).slice(0, 80)}`)
            .join("；"),
        });
      }
    } catch (err) {
      // 一条落不下去，不能连累别的：如实记下这一条，继续下一条
      landed.push({
        kind: e.kind,
        detail: String(e.text || ""),
        error: (err && (err.message || err.detail)) || String(err),
      });
    }
  }
  if (!dirty) return landed;
  try {
    // ONE REVISION PER TURN, not one per edit：「他说了一句话」才是意图的单位，
    // 一轮里改了创意又改了类型，应该读成一版，而不是两版。
    const rec = story.commitBrief("developed", String((run && run.instruction) || ""));
    const said = rec && rec.v ? `创意简报 v${rec.v}` : "与当前版本没有差异，未新建版本";
    for (const x of landed) if (!x.error) x.detail = `${x.detail}（${said}）`;
  } catch (err) {
    const why = (err && (err.message || err.detail)) || String(err);
    for (const x of landed) if (!x.error) x.error = why;
  }
  return landed;
}
