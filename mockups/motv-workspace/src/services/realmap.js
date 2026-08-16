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
