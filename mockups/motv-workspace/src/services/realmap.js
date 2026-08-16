// Map the ADR-0031 query DTOs (to_jsonable output) into the small structures the
// UI renders. Each item field is {value, provenance}; some derived fields carry a
// human string ("no config") instead of a number when the source is unavailable.
//
// PROVENANCE IS NOT FLATTENED HERE (TASK-077 §1.1). This module used to coerce
// every non-number to 0, and the top bar then printed 「余额 ¥0 JPY」 for a project
// that simply has no `config/wfm1.json` — the one defect in the audit a creator
// could act wrongly on, because 「余额 0」 reads as 「我没钱了」 while the truth is
// 「这个项目没有预算配置」. A money field therefore travels as
//
//     { value: number|null, available: boolean, provenance: string, note: string|null }
//
// and the renderers print `—` for an unavailable one. `problems[]` — which the
// backend has always returned and the front end never showed — travels with it.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** One `{value, provenance}` DTO field, with BOTH halves kept. */
const field = (item, key) => {
  const raw = item ? item[key] : undefined;
  return isObj(raw)
    ? { value: "value" in raw ? raw.value : undefined, provenance: raw.provenance || null }
    : { value: undefined, provenance: null };
};

const val = (item, key) => field(item, key).value;

/** ONE money field. A number is a real observation; anything else (the DTO's
 *  human string, or an absent field) is UNAVAILABLE and says so — it is never
 *  turned into a zero that reads like a measurement. */
export function money(value, provenance) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, available: true, provenance: provenance || "observed", note: null };
  }
  return {
    value: null,
    available: false,
    provenance: provenance || "unavailable",
    note: typeof value === "string" && value ? value : null,
  };
}

/** The unavailable marker every readout prints, in ONE place so the top bar, the
 *  drill-down panel and any future surface cannot disagree about what 「不知道」
 *  looks like. */
export const UNKNOWN = "—";

/** WQ-14 budget_standing → readout fields (JPY), each with its provenance. */
export function mapStanding(budgetJson) {
  const json = isObj(budgetJson) ? budgetJson : {};
  const it = (Array.isArray(json.items) && json.items[0]) || {};
  // `budgets_jpy.value` is an OBJECT of caps when available and a string when not,
  // so every cap inherits the wrapper's provenance rather than inventing its own.
  const bf = field(it, "budgets_jpy");
  const caps = isObj(bf.value) ? bf.value : {};
  const cap = (k) => money(caps[k], bf.provenance);
  const committed = field(it, "episode_committed_jpy");
  const holds = field(it, "episode_outstanding_holds_jpy");
  const total = cap("episode_hard");
  const spent = money(committed.value, committed.provenance);
  const held = money(holds.value, holds.provenance);
  // 剩余 is a DERIVATION, so it is available only when everything it subtracts is.
  // Computing it from coerced zeros is exactly how 「余额 ¥0」 was produced.
  const remaining = total.available && spent.available && held.available
    ? {
        value: Math.max(0, total.value - spent.value - held.value),
        available: true,
        provenance: "derived",
        note: null,
      }
    : {
        value: null,
        available: false,
        provenance: "unavailable",
        note: "缺少预算上限或已承诺金额，余额无法计算",
      };
  const problems = (Array.isArray(json.problems) ? json.problems : [])
    .filter(isObj)
    .map((p) => ({
      category: typeof p.category === "string" ? p.category : "",
      detail: typeof p.detail === "string" ? p.detail : "",
      source: isObj(p.context) && typeof p.context.source === "string" ? p.context.source : "",
    }));
  const fields = { total, spent, held, remaining };
  return {
    currency: "JPY",
    total,
    spent,
    held,
    remaining,
    softCap: cap("episode_soft"),
    perShot: cap("per_shot"),
    monthlyCap: cap("monthly_hard"),
    problems,
    markers: Array.isArray(json.markers) ? json.markers.slice() : [],
    /** true when EVERY number the top bar prints is a real observation. */
    complete: Object.values(fields).every((f) => f.available),
  };
}

/**
 * HOW MANY SOURCE PROBLEMS THIS PROJECT HAS — in ONE place (TASK-082 §1.1).
 *
 * The top bar's ⚠ and ⚙ 项目健康's problem list are the same fact at two sizes,
 * and §1.1 requires they can never print two different numbers. They cannot,
 * because both call this and neither counts anything itself.
 *
 * It counts the query ENVELOPE's `problems[]` — 「读这个项目的来源时出了什么问题」
 * (a missing `config/wfm1.json`, an unreadable approval marker). That is a
 * different fact from WQ-09's problem RECORDS (a failed validation, a failed QC
 * check), which the health panel lists separately and labels separately.
 */
export function problemCount(...sources) {
  return problemUnion(...sources).length;
}

/** One `problems[]` entry, normalised. Same shape `mapStanding` already produces,
 *  so an envelope from any query and the budget's own list are one vocabulary. */
export function mapProblemEnvelope(json) {
  const list = Array.isArray(json && json.problems) ? json.problems : [];
  return {
    problems: list.filter(isObj).map((p) => ({
      category: typeof p.category === "string" ? p.category : "",
      detail: typeof p.detail === "string" ? p.detail : "",
      source: isObj(p.context) && typeof p.context.source === "string" ? p.context.source : "",
    })),
  };
}

/**
 * EVERY source problem this project has, across however many query envelopes are
 * available — deduplicated.
 *
 * WHY IT TAKES SEVERAL. Each query carries its own `problems[]`, and they overlap
 * heavily: a missing `config/wfm1.json` is reported by budget, plan, problems and
 * approvals alike. Counting only the budget's envelope hid a failure that only
 * another read could see; counting them all without dedup would multiply one
 * failure by four (independent review, TASK-082 round 1). The identity of a
 * problem is what it SAYS — category + detail + source — because that is all the
 * envelope carries.
 */
export function problemUnion(...sources) {
  const seen = new Map();
  for (const s of sources) {
    const list = s && Array.isArray(s.problems) ? s.problems : [];
    for (const p of list) {
      if (!isObj(p)) continue;
      const row = {
        category: typeof p.category === "string" ? p.category : "",
        detail: typeof p.detail === "string" ? p.detail : "",
        source: typeof p.source === "string"
          ? p.source
          : isObj(p.context) && typeof p.context.source === "string" ? p.context.source : "",
      };
      seen.set(`${row.category}|${row.detail}|${row.source}`, row);
    }
  }
  return [...seen.values()];
}

/** WQ-01 project_plan → the L0–S7 steps, with each step's run standing.
 *
 *  `runStatus` keeps BOTH halves of its DTO field. Most steps are
 *  `unavailable` because WFM1 does not execute them (owner ADR-0037…0039), and
 *  flattening that to a status string would print a stage as 「未开始」 when the
 *  truth is 「这个版本不跑这一步」 — the same lie `¥0` told about a budget. */
export function mapPlan(planJson) {
  const items = Array.isArray(planJson && planJson.items) ? planJson.items : [];
  return {
    total: items.length,
    steps: items.map((it) => ({
      id: val(it, "step_id"),
      level: val(it, "level"),
      title: val(it, "title"),
      sequence: val(it, "sequence"),
      execution: val(it, "execution"),
      responsibility: val(it, "responsibility"),
      gate: val(it, "gate") || null,
      runStatus: field(it, "run_status"),
      stale: val(it, "run_stale") === true,
    })),
  };
}

/** WQ-09 recent_problems → the problem RECORDS it found, most recent first.
 *
 *  Its own envelope `problems[]` is NOT merged in here: that is the source-read
 *  fact `problemCount` owns, and merging the two would produce a third number
 *  that agrees with neither surface. */
export function mapProblemRows(json) {
  const items = Array.isArray(json && json.items) ? json.items : [];
  return {
    rows: items.map((it) => ({
      kind: val(it, "kind") || "未分类",
      detail: val(it, "detail") || "",
      // WHICH object — the DTO names it by whichever id that kind of problem has
      entity: val(it, "entity_id") || val(it, "task_id") || val(it, "shot_id")
        || val(it, "check_id") || null,
      at: val(it, "occurred_at") || null,
    })),
  };
}

/** WQ-13 approval_audit → per-stage approval standing + the append-only trail.
 *
 *  ONE list arrives carrying two shapes (stage rows and audit entries); they are
 *  told apart by which field is present rather than by position. */
export function mapApprovals(json) {
  const items = Array.isArray(json && json.items) ? json.items : [];
  const stages = [];
  const audit = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    if ("audit_entry" in it) { audit.push(val(it, "audit_entry")); continue; }
    if (!("stage_id" in it)) continue;
    stages.push({
      stage: val(it, "stage_id"),
      status: val(it, "status"),
      stale: val(it, "stale") === true,
      by: val(it, "approved_by") || null,
      at: val(it, "approved_at") || null,
      targets: val(it, "approved_targets") || [],
      blockedBy: val(it, "blocked_by") || [],
      reason: val(it, "reason") || null,
    });
  }
  return { stages, audit };
}

/** WQ-02 project_status → stage list + scope summary. */
export function mapStages(statusJson) {
  const sc = statusJson.scope || {};
  return {
    current: sc.current_stage,
    approved: sc.approved,
    total: sc.total,
    progress: typeof sc.progress === "number" ? sc.progress : 0,
    stages: (statusJson.items || []).map((it) => ({
      id: val(it, "stage_id"),
      status: val(it, "status"),
      stale: !!val(it, "stale"),
      running: !!val(it, "running"),
      blocked: val(it, "blocked_by") || [],
    })),
  };
}

/** WQ-07 cost_breakdown → actual totals. Its `actual_total_jpy` is a real ledger
 *  sum, so an absent one is genuinely 0 spent — unlike a budget CAP, which is a
 *  configuration that either exists or does not. */
export function mapCost(costJson) {
  const it = (costJson.items && costJson.items[0]) || {};
  const t = val(it, "actual_total_jpy");
  return {
    actualTotalJpy: typeof t === "number" ? t : 0,
    byCurrency: val(it, "actual_by_currency") || {},
  };
}

export const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP") + " JPY";

/** Print a money FIELD: the amount when it is known, `—` when it is not. The
 *  reason travels in `note`, which the drill-down panel shows. */
export const yenOf = (f) => (f && f.available && typeof f.value === "number" ? yen(f.value) : UNKNOWN);
