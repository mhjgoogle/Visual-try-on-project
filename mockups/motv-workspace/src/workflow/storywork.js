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

/** 历史版本记录：形状不对的一律丢，但**已有的一条都不改写**。 */
function sanitizeFinals(list) {
  return (Array.isArray(list) ? list : []).filter(isObj).map((r, i) => ({
    v: int(r.v, 1, 100000) ?? i + 1,
    at: str(r.at),
    note: str(r.note).slice(0, 500),
    body: str(r.body),
  }));
}

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
    // 哪些内容已经从旧结构迁过来了 —— 只灌一次，之后他自己写的那一份才是权威
    // 定稿出来的历史版本（四样内容同一条规矩，见 finalizeDoc）
    finalized: {
      core: sanitizeFinals(isObj(src.finalized) ? src.finalized.core : null),
      outline: sanitizeFinals(isObj(src.finalized) ? src.finalized.outline : null),
      plan: sanitizeFinals(isObj(src.finalized) ? src.finalized.plan : null),
    },
    seeded: {
      core: str(isObj(src.seeded) ? src.seeded.core : ""),
      outline: str(isObj(src.seeded) ? src.seeded.outline : ""),
    },
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
    finalized: work.finalized,
    seeded: work.seeded,
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

/* --- 从旧结构迁进来（加法，不删旧的）--------------------------------------- */

/** 故事核心那一篇的分节顺序 —— 产品负责人 2026-08-30 点名的五样。 */
export const CORE_SECTIONS = [
  // 每一节列的是**所有可能承载它的字段**：他这个项目里填的是 `logline` / `themes` /
  // `characters` / `beats`，另一个项目里可能填的是那八个结构化项。两套都读 ——
  // 「旧数据还在文档里」但没出现在他眼前的编辑器里，等于没有（真项目上验出来的）。
  ["立意", ["storyCore", "premise", "logline", "themeAndChange", "themes"]],
  ["主角", ["protagonist", "characters"]],
  ["冲突", ["centralConflict", "conflict"]],
  ["世界规则", ["world", "worldAndRules", "genreTone"]],
  ["人物关系", ["keyRelationships"]],
];

/** 常见子键的中文名 —— 迁过来的那一篇要能读，不是一串 `who / initialWant`。 */
const SUBKEY_LABEL = {
  who: "谁", initialWant: "最开始想要什么", name: "姓名", role: "角色",
  want: "他要什么", obstacle: "挡在前面的", external: "外部冲突", internal: "内心冲突",
  theme: "主题", protagonistBecomes: "最后变成了谁", where: "地点", rules: "规则",
  nature: "关系", howItChanges: "怎么变的", truth: "真相", revealAround: "何时揭开",
  setup: "开端", development: "发展", midpointTurn: "中段转折", climax: "高潮", ending: "结局",
};

const line = (v) => (typeof v === "string" ? v.trim() : "");

/** 把一个大纲字段渲染成人读的文本 —— 结构化的那几个拆成小标题，列表拆成条目。 */
function fieldText(key, val) {
  if (typeof val === "string") return line(val);
  if (Array.isArray(val)) {
    return val
      .map((row) =>
        isObj(row)
          ? Object.entries(row)
              .map(([k, v]) => (line(v) ? `${SUBKEY_LABEL[k] || k}：${line(v)}` : ""))
              .filter(Boolean)
              .join("；")
          : line(row),
      )
      .filter(Boolean)
      .map((s) => `- ${s}`)
      .join("\n");
  }
  if (isObj(val)) {
    return Object.entries(val)
      .map(([k, v]) => {
        const body = Array.isArray(v) ? v.map(line).filter(Boolean).join("、") : line(v);
        return body ? `${SUBKEY_LABEL[k] || k}：${body}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 把既有的创意简报 + 大纲版本写成「故事核心」那一篇。
 *
 * 为什么要迁：他的规格说故事核心「只使用一个大型文本编辑器」。如果那个编辑器是空的，
 * 他四版大纲里写下的东西就等于从屏幕上消失了 —— **旧数据一个字不删**（第 13 条），
 * 但它得**出现在他现在看的那一页里**，否则「不删」只是技术上的说法。
 *
 * 只灌一次（`seeded.core`）：之后他自己改的那一篇才是权威，重开一次不许覆盖它。
 */
export function seedCoreFromStory(work, outlineFields, brief, at) {
  if (work.seeded.core) return false;
  const src = isObj(outlineFields) ? outlineFields : {};
  const parts = [];
  for (const [title, keys] of CORE_SECTIONS) {
    const body = keys.map((k) => fieldText(k, src[k])).filter(Boolean).join("\n");
    if (body) parts.push(`## ${title}\n${body}`);
  }
  const b = isObj(brief) ? brief : {};
  const meta = [
    b.genre ? `类型：${line(b.genre)}` : "",
    b.tone ? `基调：${line(b.tone)}` : "",
  ].filter(Boolean);
  if (meta.length) parts.push(`## 基本信息\n${meta.join("\n")}`);
  work.seeded.core = str(at) || "1";
  if (!parts.length) return false;
  work.core = parts.join("\n\n");
  return true;
}

/** 大纲主线写成节点化文本（开端 / 发展 / 中段转折 / 高潮 / 结局，顺序即信息）。 */
export function seedOutlineFromStory(work, outlineFields, at) {
  if (work.seeded.outline) return false;
  work.seeded.outline = str(at) || "1";
  const src = isObj(outlineFields) ? outlineFields : {};
  const mainline = isObj(src.mainline) ? src.mainline : {};
  const order = [
    ["setup", "开端"],
    ["development", "发展"],
    ["midpointTurn", "中段转折"],
    ["climax", "高潮"],
    ["ending", "结局"],
  ];
  const blocks = order
    .map(([k, label]) => (line(mainline[k]) ? `${label}：${line(mainline[k])}` : ""))
    .filter(Boolean);
  const tail = [fieldText("storyArc", src.storyArc), fieldText("ending", src.ending)]
    .filter(Boolean);
  // 他这个项目的 mainline 是空壳，真正写下的主线在 `beats` 里 —— 退回去读它，
  // 一条一个节点（顺序本身就是信息）。
  const beats = Array.isArray(src.beats) ? src.beats.map(line).filter(Boolean) : [];
  const text = blocks.length || tail.length
    ? [...blocks, ...tail].join("\n\n")
    : beats.join("\n\n");
  if (!text) return false;
  setOutline(work, text);
  return true;
}

/* --- 定稿（故事核心 / 故事大纲 / 结构规划）--------------------------------- */
//
// 产品负责人 2026-08-30 的版本规则不是只管正文：「日常编辑只维护当前最新版。只有用户
// 主动『定稿/保存版本』时才生成历史版本。默认 UI 只显示当前最新版。历史版本可查看、
// 恢复、手动删除。」——四样内容同一条规矩，所以这里是**一份实现**，不是四份。

export const DOC_KINDS = ["core", "outline", "plan"];

/** 某一样内容此刻的快照文本（存历史与比较用的**同一个**取值口径）。 */
export function docSnapshot(work, kind) {
  if (kind === "core") return work.core;
  if (kind === "outline") return outlineText(work);
  if (kind === "plan") return JSON.stringify(visiblePlanRows(work));
  return null;
}

/** 存一版。内容没变就不重复存（返回 null）。 */
export function finalizeDoc(work, kind, at, note = "") {
  if (!DOC_KINDS.includes(kind)) return null;
  const body = docSnapshot(work, kind);
  const list = work.finalized[kind];
  const last = list[list.length - 1];
  if (last && last.body === body) return null;
  const rec = {
    v: list.length + 1,
    at: str(at),
    note: str(note).slice(0, 500),
    body: typeof body === "string" ? body : "",
  };
  list.push(rec);
  return rec;
}

/** 恢复到某一版。大纲会**重新解析**，尽量保住还在的节点 id。 */
export function restoreDoc(work, kind, v) {
  const rec = (work.finalized[kind] || []).find((x) => x.v === v);
  if (!rec) return false;
  if (kind === "core") work.core = rec.body;
  else if (kind === "outline") setOutline(work, rec.body);
  else if (kind === "plan") {
    let rows;
    try {
      rows = JSON.parse(rec.body);
    } catch {
      return false;
    }
    if (!Array.isArray(rows)) return false;
    work.plan.rows = rows.filter(isObj).map(sanitizeRow);
  } else return false;
  return true;
}

/** 手动删一版历史 —— 删历史不动当前内容。 */
export function deleteDoc(work, kind, v) {
  const list = work.finalized[kind];
  if (!Array.isArray(list)) return false;
  const before = list.length;
  work.finalized[kind] = list.filter((x) => x.v !== v);
  return work.finalized[kind].length !== before;
}
