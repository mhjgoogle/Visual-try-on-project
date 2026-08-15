// Delivery QC — 检查层 3 (TASK-074 §1.2 / 系统合同 §6.5).
//
// SEVEN checks, each producing layer-3 ReviewIssues:
//
//   音画同步 · 字幕 · 音量 · 黑帧 · 缺帧 · 规格 · 素材权限
//
// THE ONE RULE THAT MATTERS MOST (§1.2 / ADR-0064 决策 6):
//
//   「检测能力缺失时 → 该项显示 unavailable + 原因，绝不产生一条『通过』的结论」
//
// An export waved through because a tool was missing is how a broken file ships. So
// every check answers `pass` / `fail` / `unavailable`, and `unavailable` is neither a
// pass nor a blocking failure — it is an UNKNOWN, and `report.passed` is false while
// any unknown remains. G4 blocks only on `blocking` + `open`, so an unknown does not
// silently block the export either; it is reported, and the creator decides.
//
// THIS IS NOT CREATIVE REVIEW (§1.2). 「这场戏不好看」 is layer 2. Everything here is
// mechanically checkable against the file and the spec.
//
// PURE: probe results and the spec are passed in. Nothing here runs ffmpeg — the
// caller does that and hands over what it measured, which is also what makes every
// 「工具缺失」 path expressible as data.

import { checkRenderedAgainstSpec } from "./deliveryspec.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** The seven checks, with their DEFAULT severities (§1.2 table). */
export const QC_CHECKS = Object.freeze([
  { key: "av_sync", label: "音画同步", severity: "blocking" },
  { key: "subtitle", label: "字幕", severity: "warning" },
  // loudness is a warning; CLIPPING is blocking — two findings from one probe, and
  // two distinct KEYS so a consumer keying rows by `key` cannot collide them
  { key: "loudness", label: "音量", severity: "warning" },
  { key: "clipping", label: "削波", severity: "blocking", category: "loudness" },
  { key: "black_frame", label: "黑帧", severity: "warning" },
  { key: "dropped_frame", label: "缺帧", severity: "blocking" },
  { key: "spec", label: "规格", severity: "blocking" },
  { key: "rights", label: "素材权限", severity: "blocking" },
]);

/** Thresholds, named and visible rather than buried as literals. */
export const QC_THRESHOLDS = Object.freeze({
  avSyncMs: 80, // beyond this the lip-sync is perceptible
  loudnessTargetLufs: -16, // short-form platform norm
  loudnessToleranceLu: 2,
  clipThresholdDbtp: -1, // true-peak above this is clipping
  durationToleranceRatio: 0.02, // frames-vs-duration consistency
});

/** One row. `state` is the three-valued answer; `severity` only matters for a fail. */
function row(key, state, detail, { severity = null } = {}) {
  const decl = QC_CHECKS.find((c) => c.key === key);
  return {
    key,
    label: decl ? decl.label : key,
    state, // "pass" | "fail" | "unavailable"
    severity: state === "fail" ? severity || (decl ? decl.severity : "warning") : null,
    detail: detail || null,
  };
}

/** A check whose input is missing answers UNAVAILABLE with the reason. */
function unavailable(key, why) {
  return row(key, "unavailable", why);
}

/** The layer-3 CATEGORY a row key files under, or null when the key is not one.
 *
 *  A row key is a UI concern and the category set is closed (§6.1): `clipping` is a
 *  second row of 音量 and files under `loudness`. Returning the row key for anything
 *  else would hand a caller a value the closed set cannot resolve. */
function categoryOf(key) {
  const decl = QC_CHECKS.find((c) => c.key === key);
  if (!decl) return null;
  return decl.category || (DELIVERY_CATEGORIES.has(decl.key) ? decl.key : null);
}

/** The closed layer-3 set, mirrored here so this module can resolve against it
 *  without importing the review module's whole vocabulary. A guard test asserts the
 *  two agree. */
const DELIVERY_CATEGORIES = new Set([
  "av_sync", "subtitle", "loudness", "black_frame", "dropped_frame", "spec", "rights",
]);

/* --- the seven ------------------------------------------------------------- */

/** 音画同步 — dialogue anchors vs the video time base. */
export function checkAvSync(probe) {
  if (!isObj(probe) || !isNum(probe.avOffsetMs)) {
    return unavailable("av_sync", "没有测到音画偏移（需要对白轨锚点与视频时基）");
  }
  const off = Math.abs(probe.avOffsetMs);
  return off > QC_THRESHOLDS.avSyncMs
    ? row("av_sync", "fail", `音画偏移 ${probe.avOffsetMs}ms，超过 ±${QC_THRESHOLDS.avSyncMs}ms`)
    : row("av_sync", "pass", `偏移 ${probe.avOffsetMs}ms`);
}

/** 字幕 — existence, timing inside the film, no empty cues. */
export function checkSubtitles(track, { durationMs = null, subtitleMode = null } = {}) {
  // 「本片不做字幕」 is a legitimate delivery spec, not a missing check. Without this
  // such a delivery stayed permanently `unavailable`, so `passed` could never become
  // true for it (independent review).
  if (subtitleMode === "none") {
    return row("subtitle", "pass", "本片规格声明不做字幕");
  }
  // `burned` IS NOT LIKE `none` (independent review, batch 2 round 3 — the round-2
  // fix broke this file's own rule 20 lines below).
  //
  // `none` is safe to pass because NOTHING is expected. `burned` expects PIXELS, and
  // nothing here — or anywhere in this codebase — verifies that the burn-in actually
  // happened. Passing it unconditionally meant a render that silently dropped the
  // subtitles produced `subtitle: pass` with `unavailable: []`, so `passed` was true
  // and G4 would export a film with no subtitles at all.
  //
  // So it is UNAVAILABLE: an honest 「没检查」, which keeps `passed` false without
  // blocking the export — the creator decides.
  //
  // AND IT IS UNCONDITIONAL. The first attempt fired only when the cue track was
  // missing, so the NORMAL case — a burned delivery that has an authored track — fell
  // straight through to the checks below and returned `pass`, i.e. exactly the
  // 「没有证据说明烧录发生了，却报告通过」 this block exists to prevent (independent
  // review, batch 4). An authored track proves the cues were WRITTEN; it proves
  // nothing about whether the renderer burned them into the pixels.
  //
  // …but it returns unavailable ONLY when the cue data itself is sound. Returning
  // early in every case swapped a `fail` for an `unavailable` on an empty or
  // malformed track, and `unavailable` does not block the export the way `fail`
  // does — so a burned delivery with zero cues became exportable with no defect
  // ever named (independent review, next round). What cannot be verified is the
  // BURN-IN; the cue data is right here and is still checkable.
  if (subtitleMode === "burned") {
    const authored = checkSubtitles(track, { durationMs, subtitleMode: null });
    if (authored.state === "fail") return authored;
    return unavailable(
      "subtitle",
      "本片规格为烧录字幕：字幕在画面里，本检查无法验证它是否真的烧进去了——未检查不等于通过",
    );
  }
  if (!isObj(track) || !Array.isArray(track.cues)) {
    return unavailable("subtitle", "没有字幕轨可检查");
  }
  const cues = track.cues.filter(isObj);
  if (!cues.length) return row("subtitle", "fail", "字幕轨是空的");
  const problems = [];
  const empty = cues.filter((c) => typeof c.text !== "string" || !c.text.trim());
  if (empty.length) problems.push(`${empty.length} 条空字幕`);
  const inverted = cues.filter((c) => !(isNum(c.startMs) && isNum(c.endMs) && c.endMs > c.startMs));
  if (inverted.length) problems.push(`${inverted.length} 条时间无效（结束不晚于开始）`);
  const real = problems.slice();
  if (isNum(durationMs)) {
    const past = cues.filter((c) => isNum(c.endMs) && c.endMs > durationMs + 1);
    if (past.length) real.push(`${past.length} 条超出成片时长`);
  }
  if (real.length) return row("subtitle", "fail", real.join("；"));
  // AN UNPERFORMED SUB-CHECK IS NOT A PASS (independent review). Reporting `pass`
  // with the caveat buried in `detail` is the same claim this module's headline rule
  // bans — so a missing duration makes the whole row `unavailable`.
  if (!isNum(durationMs)) {
    return unavailable("subtitle", "没有提供成片时长，无法检查字幕是否越界——未检查不等于通过");
  }
  return row("subtitle", "pass", `${cues.length} 条，未发现问题`);
}

/** 音量 — integrated loudness (warning) and clipping (BLOCKING). Two findings. */
export function checkLoudness(probe) {
  const out = [];
  if (!isObj(probe) || !isNum(probe.lufs)) {
    out.push(unavailable("loudness", "没有测到整体响度（需要 ffmpeg loudnorm/ebur128）"));
  } else {
    const delta = probe.lufs - QC_THRESHOLDS.loudnessTargetLufs;
    out.push(
      Math.abs(delta) > QC_THRESHOLDS.loudnessToleranceLu
        ? row("loudness", "fail", `响度 ${probe.lufs} LUFS，偏离目标 ${QC_THRESHOLDS.loudnessTargetLufs} LUFS 超过 ${QC_THRESHOLDS.loudnessToleranceLu} LU`)
        : row("loudness", "pass", `响度 ${probe.lufs} LUFS`),
    );
  }
  // CLIPPING IS BLOCKING even though loudness is a warning: a clipped master is
  // damaged audio, not a preference.
  //
  // AND AN UNMEASURED TRUE PEAK IS `unavailable`, NOT ABSENT (independent review).
  // Emitting no row at all let a probe that measured LUFS but not true peak produce
  // `passed: true` with `unavailable: []` — G4 would then export a clipped master.
  // That is the exact 「工具缺失被当成通过」 this file's headline rule forbids.
  //
  // Its own key, so a consumer keying rows by `key` cannot collide with the loudness
  // row (both used to be `loudness`).
  if (!isObj(probe) || !isNum(probe.truePeakDbtp)) {
    out.push(unavailable("clipping", "没有测到真峰值（需要 ffmpeg ebur128 的 True Peak）"));
  } else if (probe.truePeakDbtp > QC_THRESHOLDS.clipThresholdDbtp) {
    out.push(row("clipping", "fail", `真峰值 ${probe.truePeakDbtp} dBTP 超过 ${QC_THRESHOLDS.clipThresholdDbtp} dBTP（削波）`, { severity: "blocking" }));
  } else {
    out.push(row("clipping", "pass", `真峰值 ${probe.truePeakDbtp} dBTP`));
  }
  return out;
}

/** 黑帧 — ffmpeg blackdetect spans. */
export function checkBlackFrames(probe) {
  if (!isObj(probe) || !Array.isArray(probe.blackSpans)) {
    return unavailable("black_frame", "没有跑黑帧检测（需要 ffmpeg blackdetect）");
  }
  const spans = probe.blackSpans.filter(isObj);
  return spans.length
    ? row("black_frame", "fail", `${spans.length} 段黑帧，最长 ${Math.max(...spans.map((s) => s.durationS || 0))}s`)
    : row("black_frame", "pass", "未发现黑帧");
}

/** 缺帧 — duration vs frame count consistency. */
export function checkDroppedFrames(probe) {
  if (!isObj(probe) || !isNum(probe.frameCount) || !isNum(probe.durationS) || !isNum(probe.fps)) {
    return unavailable("dropped_frame", "缺少帧数 / 时长 / 帧率，无法判断是否缺帧");
  }
  if (probe.durationS <= 0 || probe.fps <= 0) {
    return unavailable("dropped_frame", "时长或帧率无效，无法判断是否缺帧");
  }
  const expected = probe.durationS * probe.fps;
  const ratio = Math.abs(probe.frameCount - expected) / expected;
  return ratio > QC_THRESHOLDS.durationToleranceRatio
    ? row("dropped_frame", "fail", `实际 ${probe.frameCount} 帧，按 ${probe.durationS}s × ${probe.fps}fps 应为约 ${Math.round(expected)} 帧`)
    : row("dropped_frame", "pass", `${probe.frameCount} 帧，与时长一致`);
}

/** 规格 — delegated to the spec module, so ⚙ and QC read one comparison. */
export function checkSpec(spec, probed) {
  const res = checkRenderedAgainstSpec(spec, probed);
  if (res.blocking) {
    const bad = res.rows.filter((r) => r.state === "fail");
    return row("spec", "fail", bad.map((r) => `${r.key}: ${r.detail}`).join("；"));
  }
  if (res.unknown) {
    const un = res.rows.filter((r) => r.state === "unavailable");
    return unavailable("spec", un.map((r) => r.detail).join("；"));
  }
  return row("spec", "pass", "与项目成片规格一致");
}

/** 素材权限 — every Asset used must carry a source marking. */
export function checkRights(assets) {
  if (!Array.isArray(assets)) {
    return unavailable("rights", "没有拿到成片用到的素材清单");
  }
  const list = assets.filter(isObj);
  if (!list.length) return unavailable("rights", "素材清单是空的，无法确认来源");
  const unmarked = list.filter((a) => {
    const o = typeof a.origin === "string" ? a.origin.trim() : "";
    return !o;
  });
  return unmarked.length
    ? row("rights", "fail", `${unmarked.length} 个素材没有标注来源`)
    : row("rights", "pass", `${list.length} 个素材都标注了来源`);
}

/**
 * Run all seven and build the QCReport.
 *
 * `issueIdFor(key, n)` mints ids — supplied so this stays deterministic.
 *
 * `passed` requires every row to PASS. An `unavailable` row keeps it false without
 * making it blocking: 「没测出来」 is not 「不合格」, and it is also not 「合格」.
 */
export function runDeliveryQc(input, { issueIdFor } = {}) {
  const {
    probe = null, subtitleTrack = null, spec = null, assets = null, durationMs = null,
  } = isObj(input) ? input : {};
  const rows = [
    checkAvSync(probe),
    checkSubtitles(subtitleTrack, {
      durationMs,
      subtitleMode: isObj(spec) ? spec.subtitleMode : null,
    }),
    ...checkLoudness(probe),
    checkBlackFrames(probe),
    checkDroppedFrames(probe),
    checkSpec(spec, probe),
    checkRights(assets),
  ];
  const mint = typeof issueIdFor === "function" ? issueIdFor : (k, n) => `qc-${k}-${n}`;
  const issues = rows
    .filter((r) => r.state === "fail")
    .map((r, n) => ({
      issueId: mint(r.key, n + 1),
      layer: "delivery",
      targetType: "delivery",
      targetId: (isObj(input) && input.deliveryId) || "delivery",
      locatedShotId: null,
      // the layer-3 CATEGORY, which is not always the row key: `clipping` is a
      // second finding of the 音量 check and files under `loudness` (§6.1's category
      // set is closed, and a row key is a UI concern)
      category: categoryOf(r.key) || r.key,
      severity: r.severity || "warning",
      source: "agent", // a MEASUREMENT is an observation, never a decision (§6.2)
      text: `${r.label}：${r.detail || "不合格"}`,
      state: "open",
      ignoredBy: null,
      ignoredAt: null,
    }));
  const unknowns = rows.filter((r) => r.state === "unavailable");
  return {
    rows,
    issues,
    // ROW keys, which are not all layer-3 CATEGORIES (`clipping` is a second row of
    // 音量). Callers resolving these through the closed category set would fail to
    // label it, so the category is carried alongside.
    // ONE list of PAIRS rather than two lists that drift out of correspondence: the
    // de-duplicated second array no longer matched `unavailable` by index, and its
    // `|| key` fallback re-emitted the very unresolvable key it existed to translate
    // (independent review, batch 2 round 3).
    unavailable: unknowns.map((r) => r.key),
    unavailableRows: unknowns.map((r) => ({
      key: r.key,
      // The layer-3 category this row files under, or null when the row key is not
      // itself one. `decl.category || decl.key` was wrong: only `clipping` declares a
      // `category`, so every other key fell back to the row key and re-emitted the
      // very unresolvable value this field exists to translate (independent review,
      // batch 2 round 4). Resolved against the CLOSED set instead.
      category: categoryOf(r.key),
      detail: r.detail,
    })),
    // NEVER true while anything is unknown (§1.2 / ADR-0064 决策 6)
    passed: rows.every((r) => r.state === "pass"),
    blocking: issues.some((i) => i.severity === "blocking"),
  };
}
