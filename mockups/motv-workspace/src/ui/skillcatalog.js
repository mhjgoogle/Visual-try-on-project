// ⚙ 能力目录 — 「这个系统一共能帮我做哪些事」, answered in ONE place (TASK-080 §1.1).
//
// WHY THIS IS A SECTION OF ⚙ AND NOT A TWELFTH PAGE. ADR-0066 决策 10 says
// 「新增 Skill 不得新增一级或二级页面」. What it forbids is each capability
// claiming a page of its own; ONE page carrying all of them is the shape that
// constraint is asking for, so a catalog page is not in conflict with the rule
// itself. It IS in conflict with the other half of the frozen IA: `PAGES` is a
// CLOSED set of eleven with a guard test on its count (workspaces.test.mjs
// 「the IA is a CLOSED set」), and passing that test by editing the number is how
// a frozen set stops being frozen. ⚙ 项目设置 is explicitly outside the three
// spaces' eleven pages (shell.js `PROJECT_SETTINGS`), so a section there adds a
// surface without touching either rule — which is the fallback TASK-080 §1.1
// named in advance.
//
// THE DATA IS ALREADY THERE. `GET /api/skills` has always served `role / purpose
// / inputs / optionalInputs / recommendedRuntime / skillDigest / source`, a
// `deprecated[]` list and a `problems[]` list. The page installed the catalog and
// then rendered one collapsed row 「能力 21 个能力」 in the right column, and threw
// `deprecated[]` away entirely. Nothing new is fetched here.
//
// PURE VIEW MODEL + PURE RENDERER. No fetch, no clock, no DOM in the model.
import { esc } from "../util/dom.js";
import { SKILL_INPUTS, isShotScoped } from "../workflow/skills.js";

/** The three groups, in the order a creator meets them. `work` comes from each
 *  package's own manifest, so this table only NAMES the values — it never
 *  invents a grouping the packages do not declare. A package carrying some
 *  other `work` falls into 其他 rather than disappearing. */
export const WORK_LABEL = Object.freeze({
  creative: "创作",
  review: "检查",
  other: "其他",
});

const WORK_ORDER = ["creative", "review", "other"];

const SOURCE_LABEL = Object.freeze({
  project: "项目",
  user: "用户",
  builtin: "内置",
});

/** ONE skill, translated into what a creator needs to decide whether to run it.
 *
 *  `missing` is asked of the SAME check the run path gates on
 *  (`ctx.skills.missing`), so 「可运行」 here and 「缺少必要输入」 at the run button
 *  cannot disagree. */
function row(ctx, s, { deprecated = false } = {}) {
  const missing = deprecated ? [] : ctx.skills.missing(s.skillId) || [];
  const label = (k) => ({ key: k, label: SKILL_INPUTS[k] || k, missing: missing.includes(k) });
  return {
    skillId: s.skillId,
    version: s.version,
    work: WORK_ORDER.includes(s.work) ? s.work : "other",
    role: s.role || "",
    title: s.title || s.skillId,
    purpose: s.purpose || "",
    inputs: (s.inputs || []).map(label),
    optionalInputs: (s.optionalInputs || []).map((k) => ({ key: k, label: SKILL_INPUTS[k] || k })),
    shotScoped: isShotScoped(s),
    recommendedRuntime: s.recommendedRuntime || "",
    source: s.source || "",
    sourceLabel: SOURCE_LABEL[s.source] || s.source || "未记录",
    digest: s.skillDigest || "",
    deprecated,
    missing,
    ready: !deprecated && missing.length === 0,
  };
}

/**
 * EVERY capability a creator may pick, as rows.
 *
 * Exported because the ⚙ catalog and the session's `/` picker must be ONE set:
 * two derivations of 「what can this system do」 is the fork TASK-080 §3's guard
 * test exists to prevent. Neither caller may filter this by anything other than
 * the creator's own query.
 */
export function catalogRows(ctx) {
  return (ctx.skills.catalog() || []).map((s) => row(ctx, s));
}

function matches(r, q) {
  if (!q) return true;
  return [r.title, r.role, r.purpose, r.skillId, ...r.inputs.map((i) => i.label)]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/**
 * The catalog page's model.
 *
 * `problems` NEVER passes through the filter. A package that failed to load has
 * no title, no role and no purpose to match a query against, so any text filter
 * would silently empty the one list whose whole job is to stay visible
 * (ADR-0067 决策 7: 加载失败的能力必须可见且带原因).
 */
export function skillCatalogModel(ctx, ui) {
  const st = typeof ctx.skills.catalogState === "function"
    ? ctx.skills.catalogState()
    : { installed: true, detail: "", problems: [] };
  const rows = catalogRows(ctx);
  const retired = (typeof ctx.skills.deprecated === "function" ? ctx.skills.deprecated() : [])
    .map((s) => row(ctx, s, { deprecated: true }));
  const q = String((ui && ui.scQuery) || "").trim().toLowerCase();
  const work = (ui && ui.scWork) || "all";
  const shown = rows.filter((r) => (work === "all" || r.work === work) && matches(r, q));
  const groups = WORK_ORDER
    .map((k) => ({ key: k, label: WORK_LABEL[k], rows: shown.filter((r) => r.work === k) }))
    .filter((g) => g.rows.length);
  return {
    installed: !!st.installed,
    detail: st.detail || "",
    // kept whole, deliberately — see the note above
    problems: (Array.isArray(st.problems) ? st.problems : []).map((p) => ({
      skillId: p && p.skillId ? p.skillId : "（未能读出能力 ID）",
      source: (p && p.source) || "",
      reason: (p && (p.detail || p.reason)) || "没有给出原因",
    })),
    query: (ui && ui.scQuery) || "",
    work,
    // the counts are of the WHOLE catalog, not of the filtered view: 「一共能帮我
    // 做哪些事」 must not change because the creator typed in the search box
    total: rows.length,
    counts: WORK_ORDER.reduce(
      (acc, k) => ({ ...acc, [k]: rows.filter((r) => r.work === k).length }),
      {},
    ),
    shown: shown.length,
    groups,
    deprecated: retired,
    // WHAT 「在当前上下文运行」 WOULD SEND. Read from what the creator is standing
    // on — never invented, and stated so a shot-scoped capability run from ⚙ with
    // no shot selected says so instead of quietly answering about nothing.
    context: {
      shotId: (ui && ui.selectedShotId) || null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

function inputList(r) {
  const req = r.inputs.length
    ? r.inputs
        .map((i) => `<span class="chip${i.missing ? " bad" : " ok"}">${esc(i.label)}</span>`)
        .join("")
    : `<span class="chip mute">不需要输入</span>`;
  const opt = r.optionalInputs
    .map((i) => `<span class="chip mute">${esc(i.label)}（可选）</span>`)
    .join("");
  return `<div class="sc-chips">${req}${opt}</div>`;
}

function card(r, ctxModel) {
  const runnable = !r.deprecated;
  const why = r.deprecated
    ? "已停用：它仍可被历史运行记录引用，但不再作为可选项提供（ADR-0067 决策 5）"
    : r.ready
      ? r.shotScoped && !ctxModel.context.shotId
        ? "这是镜头级能力，但当前没有选中镜头——运行前先在 ⑧ 镜头制作选一个"
        : ""
      : `缺少必要输入：${r.inputs.filter((i) => i.missing).map((i) => i.label).join("、")}`;
  return (
    `<article class="sc-card${r.deprecated ? " off" : ""}" data-sc-card="${esc(r.skillId)}">` +
    `<header class="sc-h">` +
    `<span class="sc-role">${esc(r.role)}</span>` +
    `<b class="sc-t">${esc(r.title)}</b>` +
    `<span class="chip mute">v${esc(String(r.version))}</span>` +
    (r.deprecated
      ? `<span class="chip gate">已停用</span>`
      : `<span class="chip${r.ready ? " ok" : " gate"}">${r.ready ? "可运行" : `缺 ${r.missing.length}`}</span>`) +
    `</header>` +
    `<p class="sc-p">${esc(r.purpose)}</p>` +
    `<div class="lab">需要什么</div>` +
    inputList(r) +
    `<div class="sc-meta">` +
    `<span class="chip mute">${r.shotScoped ? "镜头级" : "本集 / 项目级"}</span>` +
    `<span class="chip mute">推荐 ${esc(r.recommendedRuntime || "未声明")}</span>` +
    `<span class="chip mute">来源 ${esc(r.sourceLabel)}</span>` +
    `</div>` +
    (why ? `<div class="${r.ready && runnable ? "meta" : "dir-unavail"}">${r.ready && runnable ? "" : "◌ "}${esc(why)}</div>` : "") +
    (runnable
      ? `<div class="sc-acts"><button class="btn sm primary" data-sc-run="${esc(r.skillId)}">在当前上下文运行</button></div>`
      : "") +
    `</article>`
  );
}

/** The load-failure list. ALWAYS rendered when non-empty, above everything and
 *  outside the filter — 「加载失败的能力必须可见且带原因，不得从列表里消失」. */
function problemBlock(m) {
  if (!m.problems.length) return "";
  return (
    `<section class="sc-bad">` +
    `<div class="lab">${m.problems.length} 个能力没能加载</div>` +
    m.problems
      .map(
        (p) =>
          `<div class="sc-badrow" data-sc-problem="${esc(p.skillId)}">` +
          `<b>${esc(p.skillId)}</b>` +
          (p.source ? `<span class="chip mute">${esc(p.source)}</span>` : "") +
          `<div class="meta">${esc(p.reason)}</div></div>`,
      )
      .join("") +
    `<div class="meta">加载失败的能力不会被降级使用，也不会回退到同名的低优先级包` +
    `（ADR-0067 决策 7）——修好它或升一版，它才会重新出现。这里列出来，是因为` +
    `「加载失败」和「从来没写过」在一个空列表里长得一模一样。</div>` +
    `</section>`
  );
}

export function renderSkillCatalog(m) {
  const head =
    `<div class="st-head"><div class="st-title">能力目录</div>` +
    `<div class="st-sub">系统里真实存在的 Film Skill，由后端从 Skill 包加载` +
    `（项目 → 用户 → 内置）。每一个说清它要什么输入、产出什么。</div></div>`;
  if (!m.installed) {
    return (
      head +
      problemBlock(m) +
      `<div class="dir-unavail">◌ 能力目录不可用${m.detail ? `：${esc(m.detail)}` : ""}</div>` +
      `<div class="meta">这不是「没有能力」，是没能把能力包读进来。Skill 包在磁盘上，` +
      `只有后端能读它们；静态 demo 没有后端，所以这里如实显示不可用。</div>`
    );
  }
  const tab = (k, label, n) =>
    `<button class="st-secitem${m.work === k ? " on" : ""}" data-sc-work="${esc(k)}">` +
    `${esc(label)}${n == null ? "" : ` ${n}`}</button>`;
  const filters =
    `<div class="sc-bar">` +
    `<input class="field sc-q" type="search" placeholder="搜能力：名字 / 角色 / 它解决什么" ` +
    `value="${esc(m.query)}" data-sc-query>` +
    `<nav class="st-secnav">` +
    tab("all", "全部", m.total) +
    WORK_ORDER.filter((k) => m.counts[k]).map((k) => tab(k, WORK_LABEL[k], m.counts[k])).join("") +
    `</nav></div>`;
  const body = m.groups.length
    ? m.groups
        .map(
          (g) =>
            `<section class="sc-grp"><div class="lab">${esc(g.label)} · ${g.rows.length}</div>` +
            `<div class="sc-grid">${g.rows.map((r) => card(r, m)).join("")}</div></section>`,
        )
        .join("")
    : `<div class="st-empty"><div class="ic">🔍</div><div class="tt">没有匹配的能力</div>` +
      `<div class="hh">一共 ${m.total} 个能力——清空搜索框可以看到全部。</div></div>`;
  const retired = m.deprecated.length
    ? `<section class="sc-grp sc-off"><div class="lab">已停用 · ${m.deprecated.length}</div>` +
      `<div class="meta">不与在用的混排：它们只为历史运行记录保留可解析性，不能再被选来运行。</div>` +
      `<div class="sc-grid">${m.deprecated.map((r) => card(r, m)).join("")}</div></section>`
    : "";
  return head + problemBlock(m) + filters + body + retired;
}

/* -------------------------------------------------------------------------- */
/* bind                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param onRun  `(skillId) => void` — the shell's ONE run entrance. The catalog
 *               deliberately does not run anything itself: there is one run path
 *               with one set of guards, and a second one here would be a second
 *               place to forget them.
 */
export function bindSkillCatalog(root, ctx, ui, render, { onRun } = {}) {
  const q = root.querySelector("[data-sc-query]");
  if (q) {
    // `input`, not `change`: this filters a list that is already in memory, so
    // there is nothing to validate and nothing to commit. The caret survives
    // because the handler re-renders and then restores it below.
    q.oninput = () => {
      ui.scQuery = q.value;
      const pos = q.selectionStart;
      render();
      const again = root.querySelector("[data-sc-query]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
    };
  }
  root.querySelectorAll("[data-sc-work]").forEach((b) => (b.onclick = () => {
    ui.scWork = b.dataset.scWork;
    render();
  }));
  root.querySelectorAll("[data-sc-run]").forEach((b) => (b.onclick = () => {
    if (onRun) onRun(b.dataset.scRun);
  }));
}
