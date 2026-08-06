// Map the ADR-0031 query DTOs (to_jsonable output) into the small structures the
// UI renders. Each item field is {value, provenance}; some derived fields carry a
// human string instead of a number when unavailable — coerced to 0 here.

const val = (item, key) =>
  item && item[key] && typeof item[key] === "object" && "value" in item[key] ? item[key].value : undefined;
const num = (v) => (typeof v === "number" ? v : 0);

/** WQ-14 budget_standing → readout numbers (JPY). */
export function mapStanding(budgetJson) {
  const it = (budgetJson.items && budgetJson.items[0]) || {};
  const b = val(it, "budgets_jpy") || {};
  const total = num(b.episode_hard);
  const spent = num(val(it, "episode_committed_jpy"));
  const held = num(val(it, "episode_outstanding_holds_jpy"));
  return {
    currency: "JPY",
    total,
    spent,
    held,
    remaining: Math.max(0, total - spent - held),
    softCap: num(b.episode_soft),
    perShot: num(b.per_shot),
    monthlyCap: num(b.monthly_hard),
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

/** WQ-07 cost_breakdown → actual totals. */
export function mapCost(costJson) {
  const it = (costJson.items && costJson.items[0]) || {};
  return {
    actualTotalJpy: num(val(it, "actual_total_jpy")),
    byCurrency: val(it, "actual_by_currency") || {},
  };
}

export const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP") + " JPY";
