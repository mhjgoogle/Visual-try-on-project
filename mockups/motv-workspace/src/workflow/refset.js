// 有序参考集合 (ADR-0071 决策 1 / 决策 2) — 「这一次生成，把哪几张图送进去，第几张管什么」.
//
// TODAY the model is 「每个角色一个槽位」: a shot binds reference KEYS and the role
// decides what each one is for. That is fine for a standard shot and a wall for an
// experimental one — the creator cannot say 「这一镜用这 3 张，第 2 张只借姿势」.
//
// ADR-0071 replaces the slot with an ORDERED SET whose ordinal IS the number the
// prompt refers to:
//
//   referenceInputs: [{ ordinal, assetId, version, contentDigest, role, note }, …]
//   prompt:          "…画面构图参考 [[ref:1]]，人物身份以 [[ref:2]] 为准…"
//
// THREE INVARIANTS, all fail-closed, all with a mutation-proven guard (ADR-0071
// 「后果 · 风险」: 最大的风险是又一次「不变量只覆盖一半」):
//
//   1. `ordinal` is 1..N, contiguous, no holes — it is the number in the prompt,
//      so a hole is a marker pointing at nothing.
//   2. A `[[ref:N]]` whose N is not in the set REFUSES COMPILATION and names the
//      dangling marker. It is never silently deleted: the prompt would still read
//      fluently while quietly having one fewer picture, which is the exact class
//      of lie TASK-077 §1.3 was written to remove.
//   3. `version` + `contentDigest` are mandatory. A paid generation has to bind
//      the version it actually used or 「同参数重跑」 has no definition (ADR-0041's
//      existing `reuse_assets` discipline, same shape).
//
// The reverse is NOT an error: a reference in the set that no marker names is 「一并
// 提供」 and still gets sent (决策 2 第 3 点). Markers are indication, not inventory.
//
// PURE. No fetch, no DOM, no clock, no writes.

import { ASSET_KIND_LABEL, isInterpretationKind } from "./assetreg.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const strOrNull = (x) => (nonEmpty(x) ? x : null);

/* -------------------------------------------------------------------------- */
/* 五个一级分类 (TASK-092 §5 / TASK-093 §2.5)                                   */
/* -------------------------------------------------------------------------- */

/**
 * 人物｜场景｜道具｜视觉参考｜声音 — 产品负责人 2026-08-17 定的最终一级分类.
 *
 * ZERO MIGRATION: no `kind` value changes. This is a DERIVED grouping over the
 * kinds that already exist, which is why the real project (only ever
 * `character-reference`) reads identically before and after.
 */
export const REFERENCE_CATEGORIES = [
  ["character", "人物"],
  ["location", "场景"],
  ["prop", "道具"],
  ["visual", "视觉参考"],
  ["audio", "声音"],
];

export const CATEGORY_LABEL = Object.fromEntries(REFERENCE_CATEGORIES);

/** kind → 一级分类. The five 视觉参考 members (`style` / `video-style` / `motion` /
 *  `camera` / `performance`) are the merge 产品负责人 asked for; `external-reference`
 *  joins them and is marked 不参与生成 separately (TASK-092 §5). */
const CATEGORY_OF_KIND = {
  "character-reference": "character",
  "location-reference": "location",
  "prop-reference": "prop",
  "style-reference": "visual",
  "video-style-reference": "visual",
  "motion-reference": "visual",
  "camera-reference": "visual",
  "performance-reference": "visual",
  "external-reference": "visual",
  "voice-reference": "audio",
  dialogue: "audio",
  ambience: "audio",
  sfx: "audio",
  foley: "audio",
  vo: "audio",
  bgm: "audio",
};

/** 一级分类 of a kind, or null for a kind that is not a reference at all
 *  (`shot-image`, `final`…). Null is the honest answer — filing a成片 under 视觉参考
 *  would list the one asset the pipeline exists to produce as somebody's input. */
export const categoryOf = (kind) => CATEGORY_OF_KIND[kind] || null;

/**
 * 「合并的是归类，不是那个事实」 (TASK-092 §5 / TASK-093 §2.5).
 *
 * The five kinds now sharing the 视觉参考 heading straddle the `ROLE_USE` line:
 * `style-reference` IS ingested by a model, while `video-style` / `motion` /
 * `camera` / `performance` are only ever read by a Skill and compiled into words.
 * TASK-077 §1.3 removed exactly the claim that all four were 「模型直接输入」, and a
 * merge that quietly restored it would put the lie back under a new heading.
 *
 * `external-reference` is neither: `geninput.js` deliberately leaves it out of the
 * eight roles, so it never participates in a generation at all.
 */
export function modelReach(kind) {
  if (kind === "external-reference") return "none";
  if (!categoryOf(kind)) return "none";
  return isInterpretationKind(kind) ? "ai-interpretation" : "model-input";
}

export const MODEL_REACH_LABEL = {
  "model-input": "图进模型",
  "ai-interpretation": "图不进模型 · 只被解读成文字",
  none: "不参与生成",
};

/** Group resolved references into the five headings, in the declared order, with
 *  each entry carrying its own reach. DERIVED — a new kind lands in a group by
 *  virtue of `CATEGORY_OF_KIND`, and a kind with no category is reported rather
 *  than dropped, because a silently missing reference is how a binding disappears. */
export function groupByCategory(references) {
  const groups = REFERENCE_CATEGORIES.map(([id, label]) => ({ id, label, items: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const unclassified = [];
  for (const r of Array.isArray(references) ? references : []) {
    if (!isObj(r)) continue;
    const cat = categoryOf(r.kind);
    const item = { ...r, category: cat, reach: modelReach(r.kind), reachLabel: MODEL_REACH_LABEL[modelReach(r.kind)] };
    if (cat && byId.has(cat)) byId.get(cat).items.push(item);
    else unclassified.push(item);
  }
  return { groups, unclassified };
}

/* -------------------------------------------------------------------------- */
/* 集合本身                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an ordered reference set: drop anything that cannot be bound to a
 * specific version, then RENUMBER 1..N.
 *
 * Renumbering rather than preserving whatever ordinals arrived is what makes
 * invariant 1 hold by construction. The caller who cares about which entry moved
 * gets `dropped` — a silently shorter list is how a creator loses a picture they
 * bound and never finds out.
 *
 * ⚠ IT ALSO RETURNS A `mapping`, AND A PROMPT THAT ALREADY CARRIES MARKERS MUST USE
 * IT (codex round 3, P1). Renumbering after a drop is a SILENT REBINDING, not a
 * dangling marker: drop entry 1 and the surviving entry 2 becomes ordinal 1, so an
 * existing `[[ref:1]]` now names a different picture and every fail-closed check
 * still passes — the compile is valid, the prompt reads fine, and a paid generation
 * runs against the wrong asset. `normalizeReferenceSet` below is the API to use
 * whenever text is involved; this one is for building a set from scratch.
 *
 * `mapping` is keyed by the entry's INCOMING ordinal (or its 1-based position when
 * it has none) and maps to the new ordinal, or `null` for a dropped entry.
 */
export function normalizeReferenceInputs(list) {
  const inputs = [];
  const dropped = [];
  const mapping = new Map();
  const conflicts = [];
  const src = Array.isArray(list) ? list : [];
  // TWO ENTRIES CLAIMING ONE ORDINAL POISON THE MAPPING (codex rounds 4 and 6, P1).
  // The second `mapping.set(1, …)` overwrites the first, so `[[ref:1]]` gets remapped
  // to whichever entry came last instead of the set being refused — the same silent
  // rebinding round 3 closed, reached through the input side.
  //
  // ROUND 6: THE COLLISION IS OVER THE EFFECTIVE ORDINAL, NOT THE DECLARED ONE. An
  // entry with no `ordinal` still gets its position as its key, so `[{…}, {ordinal:1}]`
  // has TWO entries keyed 1 while the declared-only check saw none. The key is
  // therefore computed once, here, and both the conflict scan and the mapping use
  // that same array — there is no second place left to disagree.
  const froms = src.map((raw, i) => (isObj(raw) && Number.isInteger(raw.ordinal) ? raw.ordinal : i + 1));
  const seenOrdinals = new Set();
  for (const from of froms) {
    if (seenOrdinals.has(from)) conflicts.push(from);
    seenOrdinals.add(from);
  }
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const from = froms[i];
    const drop = (why) => { dropped.push({ entry: raw, why }); if (!mapping.has(from)) mapping.set(from, null); };
    if (!isObj(raw) || !nonEmpty(raw.assetId)) { drop("没有 assetId"); continue; }
    // ADR-0041 的既有纪律：a paid generation must bind the exact version it used.
    if (!Number.isInteger(raw.version) || raw.version < 1) {
      drop("没有版本号（一次付费生成必须绑定它实际用的那一版）");
      continue;
    }
    if (!nonEmpty(raw.contentDigest)) {
      drop("没有 contentDigest（无法定义「同参数重跑」）");
      continue;
    }
    const ordinal = inputs.length + 1;
    // first claim wins deterministically; the conflict is reported above, and every
    // text-holding caller refuses on it rather than trusting this fallback
    if (!mapping.has(from)) mapping.set(from, ordinal);
    inputs.push({
      ordinal,
      assetId: raw.assetId,
      version: raw.version,
      contentDigest: raw.contentDigest,
      role: strOrNull(raw.role),
      // 「它管什么」 (TASK-095 §2.5): 构图 / 身份 / 环境 / 风格. Free text on purpose —
      // it goes into the prompt, not into a contract check.
      note: typeof raw.note === "string" ? raw.note : "",
      name: typeof raw.name === "string" ? raw.name : "",
      kind: strOrNull(raw.kind),
    });
  }
  return { inputs, dropped, mapping, conflicts: [...new Set(conflicts)].sort((a, b) => a - b) };
}

/**
 * Normalize a set TOGETHER WITH the prompt that names it — the safe API, and the
 * one every caller holding text must use (codex round 3, P1).
 *
 * Three outcomes, and the middle one is the whole reason this exists:
 *
 *   ok        markers renumbered to match; nothing lost
 *   refused   a marker named a reference that got DROPPED — refuse, name it, and
 *             do NOT hand back a prompt whose numbers now mean something else
 *   refused   a marker named a reference that was never in the set at all (the
 *             ordinary dangling case)
 */
export function normalizeReferenceSet({ text = "", inputs = [] } = {}) {
  const { inputs: next, dropped, mapping, conflicts } = normalizeReferenceInputs(inputs);
  if (conflicts.length) {
    return {
      ok: false,
      inputs: next,
      text: null,
      dropped,
      reasons: conflicts.map((n) => `有不止一张参考声称自己是第 ${n} 张 —— 编号已经有歧义，重新编号只会把歧义变成一个确定的错答案`),
    };
  }
  const used = [...new Set(refMarkers(text))];
  const rebound = used.filter((n) => mapping.get(n) === null);
  const unknown = used.filter((n) => !mapping.has(n));
  if (rebound.length || unknown.length) {
    return {
      ok: false,
      inputs: next,
      text: null,
      dropped,
      reasons: [
        ...rebound.map((n) => {
          const d = dropped.find((x) => isObj(x.entry) && (x.entry.ordinal === n));
          return `提示词引用了 [[ref:${n}]]，但那一张已被剔除（${d ? d.why : "不可绑定"}）`
            + " —— 重新编号会让这个标记指向另一张图，因此拒绝，而不是照做";
        }),
        ...unknown.map((n) => `提示词引用了 [[ref:${n}]]，集合里从来没有第 ${n} 张`),
      ],
    };
  }
  const { text: remapped, unmapped } = remapMarkers(text, mapping);
  if (unmapped.length) {
    return {
      ok: false,
      inputs: next,
      text: null,
      dropped,
      reasons: unmapped.map((n) => `[[ref:${n}]] 没有对应的新编号 —— 拒绝给出一个半改过的提示词`),
    };
  }
  return { ok: true, inputs: next, text: remapped, dropped, reasons: [] };
}

/** Reorder by ordinal WITHOUT touching the prompt text is impossible by
 *  definition — the ordinal is what the text names. So reordering renumbers AND
 *  reports the mapping, and the caller rewrites the markers with `remapMarkers`.
 *  Doing half of it is how 「重排参考」 silently repoints every marker. */
export function reorderReferenceInputs(inputs, order) {
  const src = Array.isArray(inputs) ? inputs : [];
  const want = Array.isArray(order) ? order : [];
  const byOrdinal = new Map(src.map((r) => [r.ordinal, r]));
  const seen = new Set();
  const next = [];
  const mapping = new Map(); // old ordinal → new ordinal
  for (const o of want) {
    if (!byOrdinal.has(o) || seen.has(o)) continue;
    seen.add(o);
    const entry = byOrdinal.get(o);
    const ordinal = next.length + 1;
    mapping.set(o, ordinal);
    next.push({ ...entry, ordinal });
  }
  // anything the caller forgot keeps its relative order at the end — dropping it
  // would delete a reference through a reorder, which nobody asked for
  for (const entry of src) {
    if (seen.has(entry.ordinal)) continue;
    const ordinal = next.length + 1;
    mapping.set(entry.ordinal, ordinal);
    next.push({ ...entry, ordinal });
  }
  return { inputs: next, mapping };
}

/* -------------------------------------------------------------------------- */
/* [[ref:N]]                                                                   */
/* -------------------------------------------------------------------------- */

/** 决策 2: `[[ref:N]]`, not `{{Image N}}` — `{{…}}` collides with Chinese creative
 *  text, and the word `Image` would lie the moment the same mechanism carries a
 *  text / video / audio reference. The TYPE is stated by the entry's `role`,
 *  一处权威. */
const MARKER_RE = /\[\[ref:(\d+)\]\]/g;

/** Every ordinal a prompt refers to, in reading order (duplicates kept: a prompt
 *  may legitimately name the same picture twice). */
export function refMarkers(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const m of text.matchAll(MARKER_RE)) out.push(Number(m[1]));
  return out;
}

/**
 * Validate a prompt against its set. FAIL-CLOSED, at COMPILE TIME (决策 2:
 * 越早说不知道越好, same reasoning as ADR-0031 provenance).
 *
 * `dangling` names each marker that points at nothing. `unreferenced` is NOT an
 * error and is reported separately so a surface can say 「这两张会一并提供」.
 */
export function validateReferenceSet({ text = "", inputs = [] } = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  const set = new Set(list.map((r) => r && r.ordinal));
  const used = refMarkers(text);
  const dangling = [...new Set(used.filter((n) => !set.has(n)))].sort((a, b) => a - b);
  const usedSet = new Set(used);
  const unreferenced = list.filter((r) => isObj(r) && !usedSet.has(r.ordinal)).map((r) => r.ordinal);
  // invariant 1, checked rather than assumed — a caller may hand us a set it built
  // itself, and a hole here makes every marker after it mean a different picture
  const ordinals = list.map((r) => (isObj(r) ? r.ordinal : null));
  const contiguous = ordinals.every((o, i) => o === i + 1);
  // INVARIANT 3 IS CHECKED HERE TOO (codex round 4, P1). It was enforced only by
  // `normalizeReferenceInputs`, so a caller reaching `compileReferenceMarkers`
  // directly could compile a set whose entries name no version and no digest — a
  // prompt that reads perfectly, sent to a paid generation, with no way to say WHICH
  // take of 现代沈昭昭 it used or to define 「同参数重跑」 afterwards. Validation must
  // not depend on which door the caller came through.
  const unpinned = list
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !isObj(r) || !nonEmpty(r.assetId) || !Number.isInteger(r.version) || r.version < 1 || !nonEmpty(r.contentDigest))
    .map(({ r, i }) => (isObj(r) && Number.isInteger(r.ordinal) ? r.ordinal : i + 1));
  return {
    ok: dangling.length === 0 && contiguous && unpinned.length === 0,
    dangling,
    unreferenced,
    contiguous,
    unpinned,
    reasons: [
      ...dangling.map((n) => `提示词里的 [[ref:${n}]] 没有对应的参考 —— 补上第 ${n} 张，或删掉这个标记`),
      ...(contiguous ? [] : ["参考集合的编号不连续，标记会指向另一张图（请重新规整集合）"]),
      ...unpinned.map((n) => `第 ${n} 张参考没有绑定 assetId / 版本 / contentDigest —— `
        + "没有它们，这次生成说不出用的是哪一版，事后也无法定义「同参数重跑」（ADR-0041 / ADR-0071 决策 1）"),
    ],
  };
}

/**
 * Compile the markers into readable text for a human / an external tool.
 *
 * REFUSES on a dangling marker (invariant 2) — it returns `{ ok: false }` and the
 * caller shows the reason. It does NOT return a best-effort string: a prompt that
 * silently lost a picture reads perfectly and produces the wrong image.
 *
 * `render(entry)` decides the substitution. The default names the picture the way
 * `promptc` names every other attachment — 名字 + 版本 — because an external tool
 * receives a pile of files with no roles and the prompt is the only place the roles
 * exist.
 */
export function compileReferenceMarkers(text, inputs, render = defaultMarkerText) {
  const v = validateReferenceSet({ text, inputs });
  if (!v.ok) return { ok: false, text: null, reasons: v.reasons, dangling: v.dangling, unpinned: v.unpinned };
  const byOrdinal = new Map((Array.isArray(inputs) ? inputs : []).map((r) => [r.ordinal, r]));
  const out = String(text ?? "").replace(MARKER_RE, (_all, n) => render(byOrdinal.get(Number(n))));
  return { ok: true, text: out, reasons: [], dangling: [] };
}

function defaultMarkerText(entry) {
  if (!isObj(entry)) return "";
  const name = entry.name || ASSET_KIND_LABEL[entry.kind] || "参考";
  const ver = Number.isInteger(entry.version) ? ` v${entry.version}` : "";
  const what = entry.note ? `，${entry.note}` : "";
  return `【参考${entry.ordinal}：${name}${ver}${what}】`;
}

/** Rewrite the markers after a reorder, using the mapping `reorderReferenceInputs`
 *  returned. Never partial: an unmapped ordinal is left alone and reported, so the
 *  caller can refuse rather than ship a prompt half-renumbered. */
export function remapMarkers(text, mapping) {
  const unmapped = [];
  const out = String(text ?? "").replace(MARKER_RE, (all, n) => {
    const from = Number(n);
    const to = mapping && mapping.has(from) ? mapping.get(from) : undefined;
    // A `null` target means 「那一张被剔除了」 — it is UNMAPPED, not a destination.
    // Writing `[[ref:null]]` would turn a rebinding into a parse artefact.
    if (!Number.isInteger(to)) {
      unmapped.push(from);
      return all;
    }
    return `[[ref:${to}]]`;
  });
  return { text: out, unmapped: [...new Set(unmapped)] };
}

/* -------------------------------------------------------------------------- */
/* 用法规则 (TASK-095 §2.3.3)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 「参考图使用规则」 — the thing we have no place for today, and whose absence is a
 * REAL defect rather than a missing nicety.
 *
 * 第 ② 步 deliberately produces a 四视图设定图 (one picture, four angles) because
 * that是 what makes it usable as a reference at all. Feed it in with no rule and the
 * model paints four views. The target product blocks that with one sentence per
 * reference category.
 *
 * THE RULES ARE SKILL-PACKAGE CONTENT, NOT A CONSTANT HERE (TASK-095 §2.3.3 /
 * ADR-0067: a Skill is manifest + prompt + schema, versioned, digest-pinned). They
 * evolve with experience; a hard-coded string would freeze one generation's lesson
 * into source and make every future correction a code change.
 *
 * So this module only holds the LOOKUP and the fail-closed answer when a category
 * has no rule: it says so out loud instead of sending the picture bare.
 */
export function usageRuleFor(category, rules) {
  const table = isObj(rules) ? rules : null;
  const text = table && typeof table[category] === "string" ? table[category].trim() : "";
  if (text) return { ok: true, category, text, source: "skill" };
  return {
    ok: false,
    category,
    text: null,
    source: null,
    reason: `「${CATEGORY_LABEL[category] || category}」这一类还没有参考图使用规则 ——`
      + "不带规则送多图，四视图设定图会让模型画出四个视图（TASK-095 §2.3.3）",
  };
}

/** The usage-rule block for one compiled generation: one line per category that is
 *  actually present in the set. DERIVED from the set, never a fixed list — a
 *  category nobody bound contributes no rule, and a category that IS bound but has
 *  no rule is reported rather than skipped. */
export function usageRuleBlock(inputs, rules) {
  const cats = [];
  const uncategorized = [];
  for (const r of Array.isArray(inputs) ? inputs : []) {
    const c = categoryOf(isObj(r) ? r.kind : null);
    if (c) {
      if (!cats.includes(c)) cats.push(c);
      continue;
    }
    // AN UNCLASSIFIABLE REFERENCE IS THE MOST DANGEROUS ONE, NOT THE ONE TO SKIP
    // (codex round 1, P1). It was being dropped from the loop entirely, so a
    // reference whose kind this table does not know would be SENT with no usage
    // rule at all — the exact 「四视图变成四个视图」 failure this block exists to
    // prevent, reached through the one path the guard did not cover.
    uncategorized.push(isObj(r) ? (r.name || r.kind || `第 ${r.ordinal} 张`) : "一个参考");
  }
  const lines = [];
  const missing = [];
  for (const c of cats) {
    const rule = usageRuleFor(c, rules);
    if (rule.ok) lines.push(`- ${CATEGORY_LABEL[c]}：${rule.text}`);
    else missing.push(rule.reason);
  }
  for (const name of uncategorized) {
    missing.push(`${name} 归不到五个一级分类里，因此没有用法规则可用 —— 先给它一个已知的 kind，不要不带规则就送出去`);
  }
  return {
    text: lines.length ? ["【参考图使用规则】", ...lines].join("\n") : "",
    missing,
    categories: cats,
    uncategorized,
  };
}
