// 把一轮对话提出的动作，落到作品上。
//
// WHERE THIS RUNS AND WHY (ADR-0089 决策 2b)：创作文档由**前端**整份保存，所以落地只能
// 在前端；服务端不偷改他的文档。动作表在 `convactions.js` —— **Agent 能做的就是创作者
// 能做的**（产品负责人 2026-08-29:「用户能够操作的前端的agent都应该可以操作」），每个
// 动作调的都是界面按钮调的同一个 `ctx.*`。
//
// 版本语义（决策 3）：`brief` 类动作写的是**工作草稿**，所以这一轮结束时提交**一次**
// —— 「他说了一句话」才是意图的单位，一轮里改了创意又改了类型应该读成一版。大纲、
// 分集规划这类动作自己就产生版本，不需要再提交。

import { runAction, knownAction } from "./convactions.js";

/** 这一轮里，本应用真能落的那些。 */
export function applicableEdits(run) {
  const out = run && run.outputs && run.outputs.conversation;
  const edits = out && Array.isArray(out.edits) ? out.edits : [];
  return edits.filter((e) => e && typeof e === "object" && knownAction(e.kind));
}

/**
 * 落地一轮的动作。
 *
 * @param story  ctx —— 创作者自己那条写路径（`ctx.story.*` / `ctx.setDeliverySpecField`）
 * @param run    终态的 run（带 outputs.conversation.edits），外加 `instruction`：
 *               他原本说的那句话，用来记进版本的来历
 * @returns [{kind, detail, error?}] —— 每一条都要能在屏幕上说清楚落了什么、
 *          或者为什么没落下。空数组 = 这一轮没有可落的动作。
 */
export function applyConversationEdits(story, run) {
  const ctx = story;
  const edits = applicableEdits(run);
  const landed = [];
  let commitBrief = false;
  for (const e of edits) {
    try {
      const res = runAction(
        ctx,
        e.kind,
        e.fields ? { fields: e.fields } : (e.args || e),
        { instruction: String((run && run.instruction) || "") },
      );
      if (res.versioned === "brief") commitBrief = true;
      landed.push({ kind: e.kind, detail: res.said });
    } catch (err) {
      // 一条落不下去不能连累别的：如实记下这一条，继续下一条
      landed.push({
        kind: e.kind,
        detail: String(e.text || ""),
        error: (err && (err.message || err.detail)) || String(err),
      });
    }
  }
  if (!commitBrief) return landed;
  try {
    const rec = ctx.story.commitBrief("developed", String((run && run.instruction) || ""));
    const said = rec && rec.v ? `创意简报 v${rec.v}` : "与当前版本没有差异，未新建版本";
    for (const x of landed) {
      if (!x.error && isBrief(x.kind)) x.detail = `${x.detail}（${said}）`;
    }
  } catch (err) {
    const why = (err && (err.message || err.detail)) || String(err);
    for (const x of landed) if (!x.error && isBrief(x.kind)) x.error = why;
  }
  return landed;
}

function isBrief(kind) {
  return kind === "brief.idea" || kind === "brief.fields";
}
