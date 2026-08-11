// AI Director execution safety — the ONE place that decides what the Director
// may do on its own and what it must ask about first.
//
// Three operating levels:
//
//   OBSERVE   read and analyse the project. Always automatic; touches nothing.
//   PLAN      turn observations into an ordered proposal. Always automatic;
//             a plan is not an action.
//   EXECUTE   invoke an EXISTING product action. Never a new code path — the
//             Director calls the same controller the workspace button calls.
//
// Every EXECUTE capability declares whether it needs explicit confirmation.
// The rule is not "is it expensive" but "can the user lose something they
// decided": canon (story / bible), the currently-active asset, money, bytes,
// and the final render all require a yes. Free, proposal-gated, reversible
// generation does not — those already end in an explicit apply/discard gate of
// their own, so a second prompt would be noise.
//
// Pure policy + a single gate function. No DOM, no domain writes of its own.

export const LEVELS = ["observe", "plan", "execute"];

/**
 * capability → { level, confirm, why }
 * `confirm` is a CONFIRMATION PROMPT requirement, not a permission denial:
 * the user can always say yes. `why` is what the prompt explains.
 */
export const CAPABILITIES = {
  // ---- OBSERVE — automatic, read-only ---------------------------------- //
  "inspect-project": { level: "observe", confirm: false },
  "find-missing-work": { level: "observe", confirm: false },
  "find-inconsistencies": { level: "observe", confirm: false },
  "classify-deterministic": { level: "observe", confirm: false },
  "compile-prompt": { level: "observe", confirm: false },

  // ---- PLAN — automatic, produces proposals only ------------------------ //
  "plan-next-actions": { level: "plan", confirm: false },
  "propose-asset-owner": { level: "plan", confirm: false },

  // ---- EXECUTE — free / already proposal-gated → no extra prompt -------- //
  "navigate": { level: "execute", confirm: false },
  "script-initial": { level: "execute", confirm: false },
  "script-revise": { level: "execute", confirm: false },
  "shots-generate": { level: "execute", confirm: false },
  "story-develop": { level: "execute", confirm: false },
  "story-plan": { level: "execute", confirm: false },
  "bible-breakdown": { level: "execute", confirm: false },
  "copy-prompt": { level: "execute", confirm: false },
  "import-result": { level: "execute", confirm: false },

  // ---- EXECUTE — must be confirmed -------------------------------------- //
  "canon-change": { level: "execute", confirm: true, why: "这会改动故事 / 作品设定的正典内容" },
  "attach-asset": { level: "execute", confirm: true, why: "这会把资产归属到镜头 / 角色，改变已确认的引用" },
  "replace-active-asset": { level: "execute", confirm: true, why: "这会替换当前生效的资产版本" },
  "bulk-paid-generate": { level: "execute", confirm: true, why: "这会发起批量付费生成，产生真实花费" },
  "destructive": { level: "execute", confirm: true, why: "这是破坏性操作，字节将被删除" },
  "final-render": { level: "execute", confirm: true, why: "这会渲染本集成片并写入一个新的成片版本" },
};

/** Capabilities the Director runs by itself, with no user action at all. */
export function isAutomatic(key) {
  const c = CAPABILITIES[key];
  return !!c && c.level !== "execute";
}

/** True when invoking `key` must ask first. An UNKNOWN capability is treated
 *  as confirm-required: failing closed is the only safe default for a table
 *  that a future checkpoint will extend. */
export function needsConfirm(key) {
  const c = CAPABILITIES[key];
  return c ? !!c.confirm : true;
}

export function levelOf(key) {
  const c = CAPABILITIES[key];
  return c ? c.level : "execute";
}

/**
 * The single gate every Director action goes through.
 *
 * @param {string} key      capability id
 * @param {function} run    the real product action (already existing)
 * @param {object} [opts]   { confirm, detail } — `confirm` defaults to
 *                          window.confirm so tests can inject a stub.
 * @returns {boolean} whether `run` was invoked.
 */
export function invoke(key, run, opts = {}) {
  const ask = opts.confirm || ((msg) => window.confirm(msg));
  if (needsConfirm(key)) {
    const c = CAPABILITIES[key];
    const why = (c && c.why) || "这个操作需要确认";
    const detail = opts.detail ? `\n\n${opts.detail}` : "";
    if (!ask(`${why}。${detail}\n\n确认继续？`)) return false;
  }
  run();
  return true;
}
