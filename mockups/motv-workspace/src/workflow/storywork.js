// Story Development 的正式数据模型（TASK-122 第 1 步）。
//
// 产品负责人 2026-08-30 的规格：左栏严格四个入口 —— 故事核心 / 故事大纲 / 结构规划 /
// 正文创作；大纲要有**稳定的 Outline Node ID**（作者不用维护）；结构规划是固定 9 列的表
// 并能引用大纲节点；正文创作先选小说还是剧集，先定 Planned Chapters / Episodes（可增减），
// 章/集用页内选择器切换、不进左栏；**日常只留最新一版，点「定稿」才存历史版本**。
//
// 为什么单独一个模块：`storydoc.js` 是既有的创意简报 + 大纲版本 + 分集规划，那三样一条
// 都不删（ADR-0087 的「旧版本永不删除」同一条道理）。新结构住在 `story.work` 里，与它们
// 并存 —— 迁移是**加法**，不是就地改写（AGENTS.md 第 13 条）。
//
// 纯数据 + 纯函数：没有 DOM、没有 fetch、没有时钟（`at` 一律由调用方传入）。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
const int = (x, lo, hi) =>
  Number.isInteger(x) && !(typeof x === "boolean") && x >= lo && x <= hi ? x : null;

/** 结构规划那张表的列 —— **顺序即合同**（产品负责人逐列点名过）。 */
export const PLAN_COLUMNS = [
  ["unitNo", "Unit No."],
  ["scene", "Scene"],
  ["purpose", "Scene 目的"],
  ["characters", "主要人物"],
  ["goal", "人物目标"],
  ["conflict", "冲突"],
  ["turn", "关键转折"],
  ["endingState", "Ending State"],
  ["outlineRefs", "关联故事大纲"],
];

/** 作品形态。`""` = 还没选 —— 不替他默认成任何一种。 */
export const FORMS = ["novel", "episode"];

let seq = 0;
/** 稳定 id。**不用时钟**（会破坏 round-trip 的确定性），种子由调用方给。 */
function mintId(prefix, seed) {
  seq += 1;
  const s = str(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `${prefix}-${s || "x"}${seq.toString(36)}`;
}

/* --- 大纲节点 --------------------------------------------------------------- */

/**
 * 把作者写的一段文本切成节点，**尽量保住已有节点的 id**。
 *
 * 为什么 id 必须稳：结构规划的「关联故事大纲」引用它。作者改一个错别字就换一批 id，
 * 那张表的引用就会集体断掉 —— 那正是「作者不用手动维护 id」这条要求的真实含义。
 *
 * 匹配规则（按顺序试，先到先得）：文字完全一样 → 复用；否则同一位置上的旧节点 → 复用。
 * 都不匹配才发新 id。
 */
export function parseOutline(text, prev = []) {
  const olds = Array.isArray(prev) ? prev.filter(isObj) : [];
  const used = new Set();
  const blocks = str(text)
    .split(/\n{2,}/)
    .flatMap((b) => b.split(/\n(?=\s*[-*·]\s+)/))
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((body, i) => {
    const exact = olds.find((o) => !used.has(o.id) && str(o.text).trim() === body);
    const byPos = olds[i] && !used.has(olds[i].id) ? olds[i] : null;
    const keep = exact || byPos;
    if (keep) used.add(keep.id);
    return {
      id: keep ? keep.id : mintId("on", body),
      kind: /^\s*[-*·]\s+/.test(body) ? "item" : "para",
      text: body,
    };
  });
}

/** 节点拼回作者看到的那段文本。 */
export function outlineText(work) {
  return (work.outline.nodes || []).map((n) => n.text).join("\n\n");
}

export function setOutline(work, text) {
  work.outline.nodes = parseOutline(text, work.outline.nodes);
  return work.outline.nodes;
}

/* --- 结构规划 --------------------------------------------------------------- */

function sanitizeRow(r, i) {
  const src = isObj(r) ? r : {};
  const row = { id: str(src.id) || mintId("sp", `r${i}`) };
  for (const [key] of PLAN_COLUMNS) {
    if (key === "outlineRefs") {
      row.outlineRefs = (Array.isArray(src.outlineRefs) ? src.outlineRefs : [])
        .filter((x) => typeof x === "string" && x)
        .slice(0, 20);
    } else if (key === "unitNo") {
      row.unitNo = str(src.unitNo).slice(0, 40);
    } else {
      row[key] = str(src[key]).slice(0, 2000);
    }
  }
  // 软删除：删一行也要能撤销（第 13 条）
  row.hidden = isObj(src.hidden) && str(src.hidden.at) ? { at: str(src.hidden.at) } : null;
  // 出生时就带着它，否则 round-trip 会掉一个字段（第一次跑 round-trip 就撞见）
  row.createdAt = str(src.createdAt);
  return row;
}

export function addPlanRow(work, at) {
  const row = sanitizeRow({ unitNo: String(visiblePlanRows(work).length + 1) }, work.plan.rows.length);
  row.createdAt = str(at);
  work.plan.rows.push(row);
  return row;
}

export function editPlanRow(work, id, field, value) {
  if (!PLAN_COLUMNS.some(([k]) => k === field)) return false;
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row) return false;
  if (field === "outlineRefs") {
    row.outlineRefs = (Array.isArray(value) ? value : [])
      .filter((x) => typeof x === "string" && x)
      .slice(0, 20);
  } else {
    row[field] = str(value).slice(0, 2000);
  }
  return true;
}

export function hidePlanRow(work, id, at) {
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row || row.hidden) return false;
  row.hidden = { at: str(at) };
  return true;
}

export function restorePlanRow(work, id) {
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row || !row.hidden) return false;
  row.hidden = null;
  return true;
}

export const visiblePlanRows = (work) => work.plan.rows.filter((r) => !r.hidden);

/** 引用了一个已经不存在的大纲节点 —— **说出来**，不要静默丢掉那一格。 */
export function danglingRefs(work) {
  const live = new Set((work.outline.nodes || []).map((n) => n.id));
  const out = [];
  for (const row of visiblePlanRows(work)) {
    for (const ref of row.outlineRefs) if (!live.has(ref)) out.push({ rowId: row.id, ref });
  }
  return out;
}

/* --- 形态与单元（章 / 集）--------------------------------------------------- */

export function setForm(work, form) {
  if (!FORMS.includes(form)) return false;
  work.form = form;
  return true;
}

/** 计划写多少章 / 多少集。**可增可减**，减少时既有单元不删（只是不在计划内）。 */
export function setPlanned(work, kind, n) {
  if (!FORMS.includes(kind)) return false;
  const v = int(n, 0, 500);
  if (v === null) return false;
  work.planned[kind] = v;
  return true;
}

/** 拿到第 no 个单元，没有就建一个（章/集共用一张表，用 kind 区分）。 */
export function ensureUnit(work, kind, no, at) {
  if (!FORMS.includes(kind)) return null;
  const n = int(no, 1, 500);
  if (n === null) return null;
  let unit = work.units.find((u) => u.kind === kind && u.no === n);
  if (!unit) {
    unit = {
      id: mintId("u", `${kind}${n}`),
      kind,
      no: n,
      title: "",
      brief: "",
      body: "",
      updatedAt: str(at),
      finalized: [],
    };
    work.units.push(unit);
  }
  return unit;
}

export function editUnit(work, id, field, value, at) {
  if (!["title", "brief", "body"].includes(field)) return false;
  const unit = work.units.find((u) => u.id === id);
  if (!unit) return false;
  unit[field] = str(value).slice(0, 200000);
  unit.updatedAt = str(at);
  return true;
}

/* --- 定稿：日常只留最新，定稿才存历史 --------------------------------------- */

/**
 * 存一版历史。**日常编辑不进这里** —— 产品负责人要的是「默认只显示当前最新版」，
 * 历史只在他主动定稿时产生（可看、可恢复、可删）。
 */
export function finalizeUnit(work, id, at, note = "") {
  const unit = work.units.find((u) => u.id === id);
  if (!unit) return null;
  const last = unit.finalized[unit.finalized.length - 1];
  if (last && last.body === unit.body && last.title === unit.title) return null;
  const rec = {
    v: unit.finalized.length + 1,
    at: str(at),
    note: str(note).slice(0, 500),
    title: unit.title,
    body: unit.body,
  };
  unit.finalized.push(rec);
  return rec;
}

export function restoreFinalized(work, id, v, at) {
  const unit = work.units.find((u) => u.id === id);
  const rec = unit && unit.finalized.find((x) => x.v === v);
  if (!rec) return false;
  unit.title = rec.title;
  unit.body = rec.body;
  unit.updatedAt = str(at);
  return true;
}

/** 手动删一版历史 —— 他明确要求「历史版本可查看、恢复、**手动删除**」。 */
export function deleteFinalized(work, id, v) {
  const unit = work.units.find((u) => u.id === id);
  if (!unit) return false;
  const before = unit.finalized.length;
  unit.finalized = unit.finalized.filter((x) => x.v !== v);
  return unit.finalized.length !== before;
}

/* --- 建立 / 序列化 ---------------------------------------------------------- */

export function createWork(saved) {
  const src = isObj(saved) ? saved : {};
  const work = {
    // 形态没选就是没选：不替他默认成小说或剧集
    form: FORMS.includes(src.form) ? src.form : "",
    core: str(src.core),
    outline: { nodes: [] },
    plan: { rows: [] },
    planned: {
      novel: int(isObj(src.planned) ? src.planned.novel : null, 0, 500) ?? 0,
      episode: int(isObj(src.planned) ? src.planned.episode : null, 0, 500) ?? 0,
    },
    units: [],
  };
  const nodes = isObj(src.outline) && Array.isArray(src.outline.nodes) ? src.outline.nodes : [];
  work.outline.nodes = nodes.filter(isObj).map((n, i) => ({
    id: str(n.id) || mintId("on", `n${i}`),
    kind: n.kind === "item" ? "item" : "para",
    text: str(n.text),
  }));
  const rows = isObj(src.plan) && Array.isArray(src.plan.rows) ? src.plan.rows : [];
  work.plan.rows = rows.filter(isObj).map(sanitizeRow);
  work.units = (Array.isArray(src.units) ? src.units : []).filter(isObj).map((u, i) => ({
    id: str(u.id) || mintId("u", `u${i}`),
    kind: FORMS.includes(u.kind) ? u.kind : "episode",
    no: int(u.no, 1, 500) ?? i + 1,
    title: str(u.title),
    brief: str(u.brief),
    body: str(u.body),
    updatedAt: str(u.updatedAt),
    finalized: (Array.isArray(u.finalized) ? u.finalized : [])
      .filter(isObj)
      .map((f, j) => ({
        v: int(f.v, 1, 10000) ?? j + 1,
        at: str(f.at),
        note: str(f.note),
        title: str(f.title),
        body: str(f.body),
      })),
  }));
  return work;
}

export function serializeWork(work) {
  return {
    form: work.form,
    core: work.core,
    outline: { nodes: work.outline.nodes },
    plan: { rows: work.plan.rows },
    planned: work.planned,
    units: work.units,
  };
}

/** 迁移：现有的分集规划变成结构规划的行。**加法** —— 旧数据一条不动。 */
export function seedPlanFromEpisodes(work, episodes, at) {
  if (visiblePlanRows(work).length) return 0;
  let n = 0;
  for (const [i, ep] of (Array.isArray(episodes) ? episodes : []).entries()) {
    if (!isObj(ep)) continue;
    const row = addPlanRow(work, at);
    row.unitNo = String(i + 1);
    row.scene = str(ep.title);
    row.purpose = str(ep.logline || ep.purpose || "");
    n += 1;
  }
  return n;
}
