// Delivery spec + budget limits (TASK-073 §1.7 / IA §4 ⚙) — the DOMAIN half.
//
// The fourteen fields IA §4 ⚙ froze, their validation, and the two HARD GATES.
//
// WHY THIS IS PURE, AND STORES NOTHING. Where a project-level spec lives is a
// persistence decision (a new canvas field means a schema version and a migration),
// which is not this module's call. So the contract, the validation and the gates are
// settled here — they are what ⑩ 交付质检's 「规格」 check and the generation path
// both need — and the storage wiring is a separate, explicit step.
//
// THE HONESTY RULE, verbatim from §1.7: 「取不到某一项 → 该项 unavailable，绝不判定为
// 通过」. A missing field is never defaulted into a value that then gets checked
// against and passes. `specStanding` reports every field as one of
// `set` / `unavailable`, and a spec with any `unavailable` field can never be
// reported as satisfied — which is exactly what TASK-074 §1.2's 规格 check consumes.
//
// THE GATES ARE GATES, not confirmations (§1.7): 「超过即拒绝并说明，不是弹窗问一句
// 『确定吗』」. A dialog the creator can click through is not a limit.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * The FOURTEEN fields, as a closed list (IA §4 ⚙).
 *
 * `group` decides which ⚙ section renders it. `kind` decides how it is validated —
 * nothing here is free text except the two language/platform choices, because a spec
 * that cannot be compared to a rendered file is not a spec.
 */
export const SPEC_FIELDS = Object.freeze([
  // --- 成片规格 ---------------------------------------------------------- //
  { key: "platform", group: "spec", label: "平台", kind: "enum",
    values: ["douyin", "kuaishou", "bilibili", "youtube", "other"] },
  { key: "aspect", group: "spec", label: "画幅", kind: "enum",
    values: ["9:16", "16:9", "1:1", "4:5"] },
  { key: "resolution", group: "spec", label: "分辨率", kind: "enum",
    values: ["1080x1920", "720x1280", "1920x1080", "1280x720"] },
  { key: "fps", group: "spec", label: "帧率", kind: "int", min: 1, max: 60 },
  { key: "episodeSeconds", group: "spec", label: "单集时长（秒）", kind: "int", min: 1, max: 36000 },
  { key: "episodeTarget", group: "spec", label: "目标集数", kind: "int", min: 1, max: 999 },
  { key: "subtitleMode", group: "spec", label: "字幕方式", kind: "enum",
    values: ["srt", "burned", "none"] },
  { key: "subtitleLang", group: "spec", label: "字幕语言", kind: "enum",
    values: ["zh", "en", "zh+en", "none"] },
  { key: "container", group: "spec", label: "容器", kind: "enum", values: ["mp4", "webm"] },
  { key: "videoBitrateKbps", group: "spec", label: "视频码率（kbps）", kind: "int", min: 100, max: 200000 },
  { key: "audioBitrateKbps", group: "spec", label: "音频码率（kbps）", kind: "int", min: 32, max: 512 },
  // --- 预算与限制 -------------------------------------------------------- //
  { key: "budgetTotalUsd", group: "budget", label: "项目总预算（USD）", kind: "money", min: 0, max: 1000000 },
  // the two HARD GATES
  { key: "perGenerationCapUsd", group: "budget", label: "单次生成上限（USD）", kind: "money", min: 0, max: 100000, gate: true },
  { key: "retryCap", group: "budget", label: "重试上限（次）", kind: "int", min: 0, max: 100, gate: true },
]);

export const SPEC_FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(SPEC_FIELDS.map((f) => [f.key, f])),
);

/** Validate ONE field's value. Returns null when acceptable, else the reason.
 *
 *  A value that is present but wrong is a REFUSAL, never a silent coercion: a fps of
 *  `"25"` quietly turned into 25 here would mean the stored spec and the string the
 *  creator typed are two different things, and only one of them was checked. */
export function validateField(key, value) {
  const f = SPEC_FIELD_BY_KEY[key];
  if (!f) return `未知的规格字段 ${key}`;
  if (value === null || value === undefined || value === "") return null; // absent ≠ invalid
  if (f.kind === "enum") {
    return f.values.includes(value) ? null : `${f.label} 只能是 ${f.values.join(" / ")}`;
  }
  if (f.kind === "int") {
    if (!Number.isInteger(value)) return `${f.label} 必须是整数`;
    if (value < f.min || value > f.max) return `${f.label} 必须在 ${f.min}–${f.max} 之间`;
    return null;
  }
  if (f.kind === "money") {
    if (!isNum(value)) return `${f.label} 必须是数字`;
    if (value < f.min || value > f.max) return `${f.label} 必须在 ${f.min}–${f.max} 之间`;
    return null;
  }
  return null;
}

/**
 * The standing of every field: `set` with its value, or `unavailable` with why.
 *
 * This is what ⚙ renders and what TASK-074 §1.2's 规格 check reads. `complete` is
 * false while ANY field is unavailable, and a caller may not report the 规格 check
 * as passed in that case — 「绝不判定为通过」.
 */
export function specStanding(spec) {
  const src = isObj(spec) ? spec : {};
  const fields = SPEC_FIELDS.map((f) => {
    const raw = Object.prototype.hasOwnProperty.call(src, f.key) ? src[f.key] : null;
    const absent = raw === null || raw === undefined || raw === "";
    const error = absent ? null : validateField(f.key, raw);
    return {
      key: f.key,
      label: f.label,
      group: f.group,
      gate: !!f.gate,
      value: absent ? null : raw,
      // three distinct states, never collapsed: set / not recorded / recorded wrong
      state: absent ? "unavailable" : error ? "invalid" : "set",
      detail: absent ? "还没有设置" : error || null,
    };
  });
  const missing = fields.filter((x) => x.state !== "set");
  return {
    fields,
    missing: missing.map((x) => x.key),
    complete: missing.length === 0,
    // stated separately because the gates cannot be enforced at all without them,
    // which is a different problem from an incomplete spec
    gatesConfigured: fields.filter((x) => x.gate).every((x) => x.state === "set"),
  };
}

/**
 * HARD GATE — may this generation run, given its estimated cost?
 *
 * `{ ok: true }` or `{ ok: false, reason }`. §1.7: 「超过即拒绝并说明，不是弹窗问一句
 * 『确定吗』」, so there is deliberately no `confirm` parameter to override it.
 *
 * FAIL CLOSED when the cap is not configured AND the operation costs money: a spend
 * with no limit in force is precisely what a limit exists to prevent. A free
 * (subscription) operation is allowed through, because there is nothing to cap.
 */
export function checkGenerationCost(spec, estimatedUsd) {
  const cap = isObj(spec) ? spec.perGenerationCapUsd : null;
  const cost = isNum(estimatedUsd) ? estimatedUsd : null;
  if (cost === null) {
    return { ok: false, reason: "这次生成的预计花费未知，无法与单次生成上限比对——不予执行" };
  }
  if (cost <= 0) return { ok: true }; // nothing to cap
  if (!isNum(cap)) {
    return { ok: false, reason: "还没有设置「单次生成上限」，付费生成一律不执行——先在 ⚙ 项目设置里设定" };
  }
  if (cost > cap) {
    return {
      ok: false,
      reason: `这次生成预计 $${cost.toFixed(2)}，超过单次生成上限 $${cap.toFixed(2)}——已拒绝。` +
        `要执行就先在 ⚙ 项目设置里调高上限，那是一次明确的决定。`,
    };
  }
  return { ok: true };
}

/**
 * HARD GATE — may this be retried again?
 *
 * `attemptsSoFar` counts retries ALREADY made for this target. Fails closed when the
 * cap is unset: an unlimited retry loop against a paid provider is the failure this
 * gate exists for.
 */
export function checkRetryAllowed(spec, attemptsSoFar) {
  const cap = isObj(spec) ? spec.retryCap : null;
  const n = Number.isInteger(attemptsSoFar) ? attemptsSoFar : null;
  if (n === null) {
    return { ok: false, reason: "无法确定这个目标已经重试过几次——不予重试" };
  }
  if (!Number.isInteger(cap)) {
    return { ok: false, reason: "还没有设置「重试上限」，不执行自动重试——先在 ⚙ 项目设置里设定" };
  }
  if (n >= cap) {
    return {
      ok: false,
      reason: `这个目标已经重试 ${n} 次，达到重试上限 ${cap}——已拒绝。` +
        `继续重试要先在 ⚙ 项目设置里调高上限。`,
    };
  }
  return { ok: true };
}

/**
 * Compare a RENDERED file's real properties against the spec — TASK-074 §1.2's
 * 规格 check, in domain form so that card wires rather than re-derives it.
 *
 * Every field is one of `pass` / `fail` / `unavailable`, and `unavailable` NEVER
 * counts as a pass (ADR-0064 决策 6): a spec field nobody set, or a property the
 * probe could not read, is an unknown — and an export blocked on an unknown is
 * correct, while one waved through on an unknown is how a wrong file ships.
 */
/** How close a MEASURED value has to be to count as matching the spec.
 *
 *  Strict equality was wrong for everything ffprobe measures: it reports 30000/1001
 *  (29.97) for a 30 fps render and a bitrate that never lands exactly on the target,
 *  so a perfectly correct export produced a `blocking` 规格 failure and G4 refused it
 *  (independent review, batch 2). Resolution and container stay EXACT — they are
 *  discrete, and a 1080x1920 file is either that or it is not. */
export const SPEC_TOLERANCE = Object.freeze({
  fps: 0.01, // relative: 29.97 vs 30
  videoBitrateKbps: 0.1, // relative: encoders overshoot/undershoot the target
  audioBitrateKbps: 0.1,
});

export function checkRenderedAgainstSpec(spec, probed) {
  const src = isObj(spec) ? spec : {};
  const got = isObj(probed) ? probed : {};
  const rows = [];
  const near = (key, a, b) => {
    const tol = SPEC_TOLERANCE[key];
    if (tol === undefined || !isNum(a) || !isNum(b)) return a === b;
    if (b === 0) return a === 0;
    return Math.abs(a - b) / Math.abs(b) <= tol;
  };
  const cmp = (key, actual, expected, fmt = (v) => String(v)) => {
    if (expected === null || expected === undefined || expected === "") {
      rows.push({ key, state: "unavailable", detail: `规格里没有设置${SPEC_FIELD_BY_KEY[key].label}` });
      return;
    }
    if (actual === null || actual === undefined) {
      rows.push({ key, state: "unavailable", detail: `没能读出成片的${SPEC_FIELD_BY_KEY[key].label}` });
      return;
    }
    const ok = near(key, actual, expected);
    rows.push({
      key,
      state: ok ? "pass" : "fail",
      detail: ok ? null : `期望 ${fmt(expected)}，实际 ${fmt(actual)}`,
    });
  };
  cmp("resolution", got.resolution ?? null, src.resolution ?? null);
  cmp("fps", got.fps ?? null, src.fps ?? null);
  cmp("container", got.container ?? null, src.container ?? null);
  cmp("videoBitrateKbps", got.videoBitrateKbps ?? null, src.videoBitrateKbps ?? null);
  cmp("audioBitrateKbps", got.audioBitrateKbps ?? null, src.audioBitrateKbps ?? null);
  const failed = rows.filter((r) => r.state === "fail");
  const unknown = rows.filter((r) => r.state === "unavailable");
  return {
    rows,
    // `passed` requires EVERY row to pass. Unknown rows keep it false.
    passed: failed.length === 0 && unknown.length === 0,
    blocking: failed.length > 0,
    unknown: unknown.length > 0,
  };
}
