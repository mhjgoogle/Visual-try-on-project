// Run ONE capability from the page it belongs to (TASK-090 §2.3 / §2.4).
//
// WHY THIS EXISTS. Two surfaces need the same thing — 人物关系 must be able to say
// 「AI 梳理关系（按当前剧本）」 and 世界观 must be able to say 「AI 梳理世界观」 — and the
// existing route for it was 「open the right-hand panel and pick the capability
// yourself」. A capability the creator has to go find is a capability the product
// owner reasonably described as having no entrance at all.
//
// IT ADDS NO SECOND RUN PATH. Every run still goes through `ctx.skills.run`, the
// one call with the guards on it (declared-input check, executor resolution,
// durable Run, provenance). This module only decides WHEN it is called and what to
// say afterwards — the same shape `runSessionSkill` (ui/production.js) uses for the
// Agent session, factored out so the two page actions cannot drift from it.
//
// THE OUTPUT IS STILL A PROPOSAL. Nothing here applies anything: after a run the
// capability panel is pointed at it, and 「应用」 there is what writes — 已确认档案
// 绝不被静默覆盖 (M8 提案卡既有纪律 / ADR-0067 决策 4).

/**
 * @param ctx      the shell context (needs `skills`, `toast`)
 * @param ui       transient shell state (executor choice, panel focus)
 * @param skillId  which capability
 * @param opts.summary   what this run is about, recorded on the Run
 * @param opts.onDone    called after the toast, for a re-render
 */
export function runPageSkill(ctx, ui, skillId, { summary = null, onDone = null } = {}) {
  if (!ctx || !ctx.skills || typeof ctx.skills.run !== "function") {
    if (ctx && ctx.toast) ctx.toast("这个构建里没有能力运行通道");
    return Promise.resolve({ ok: false, error: "no runner" });
  }
  // `.then(...)` INSIDE the chain, so a SYNCHRONOUS throw out of `ctx.skills.run`
  // is caught too — `Promise.resolve(f())` evaluates `f()` first and would let it
  // escape, leaving a button that silently does nothing (the same reasoning as
  // `runSessionSkill`'s comment).
  return Promise.resolve()
    .then(() => ctx.skills.run(skillId, {
      executor: (ui && ui.skillExecutor) || "manual",
      summary,
    }))
    .then((res) => {
      if (!res || !res.ok) {
        ctx.toast(`运行失败：${(res && res.error) || "没有返回结果"}`);
      } else if (res.manual) {
        ctx.toast("已建立运行记录 —— 在右侧「能力」里复制 Prompt，跑完把结果粘回来");
      } else {
        ctx.toast("提案已生成 —— 在右侧「能力」里逐条确认；已确认的档案不会被覆盖");
      }
      // point the capability panel at THIS run, so its proposal is one scroll away
      if (ui) {
        ui.skillId = skillId;
        ui.dirOpen = { ...(ui.dirOpen || {}), skills: true };
      }
      if (onDone) onDone();
      return res;
    })
    .catch((e) => {
      ctx.toast(`运行失败：${(e && e.message) || e}`);
      if (onDone) onDone();
      return { ok: false, error: String((e && e.message) || e) };
    });
}

/**
 * 「这一面上次是什么时候被 AI 梳理过的」 — or that it never was.
 *
 * TASK-090 §2.5 wants the page to OPEN as 「AI 梳理出来的样子」 rather than as an
 * empty form. The honest version of that is stating which it is: a surface that has
 * never been run says so, instead of looking identical to one whose run found
 * nothing. Derived from the real Run history, never assumed.
 */
export function lastRunOf(ctx, skillId) {
  const runs = (ctx && ctx.skills && typeof ctx.skills.runs === "function" ? ctx.skills.runs() : null) || [];
  const mine = runs.filter((r) => r && r.skillId === skillId);
  if (!mine.length) return null;
  // the LAST one recorded; the registry appends, so the tail is the newest
  const last = mine[mine.length - 1];
  return {
    status: last.status || "",
    at: last.finishedAt || last.startedAt || last.createdAt || "",
    skillRunId: last.skillRunId || last.runId || "",
  };
}
