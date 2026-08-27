// 一个常驻的 Agent 会话 (TASK-080 §1.2 · 批次 A).
//
// THE PROBLEM IT REPLACES. The right column was FOUR different panels —
// `director.js` / `directorshot.js` / `agentpanel.js` / `skillpanel.js` —
// dispatched by which page the creator happened to be on. So 「what can I ask
// for」 depended on where they were standing, and the system's own routing rules
// became the creator's burden. Worse, the context was IMPLICIT: whatever
// `ui.selectedShotId` said, invisible and uneditable.
//
// THE SHAPE (T-004 / T-045 / T-046). ONE session that survives navigation, whose
// context the creator states EXPLICITLY:
//
//   /  唤出能力   the WHOLE catalog — the same rows ⚙ 能力目录 lists, never a
//                 second derivation of 「what can this system do」
//   @  引用对象   镜头 / 角色 / 场景 / 场景地 / 资产 / 剧集, by the stable ids the
//                 documents already carry
//
// BATCH A DELETES NOTHING (§1.2 迁移纪律 4). The four panels are all still
// rendered and still reachable; this is an ADDITIONAL entrance that does not yet
// take anything over. Retiring the old entrances is batch B, deliberately a
// separate step — a one-shot replacement is how a capability quietly goes
// missing.
//
// PURE VIEW MODEL + PURE RENDERER. No fetch, no clock, no DOM in the model.
import { esc } from "../util/dom.js";
import { catalogRows } from "./skillcatalog.js";

/** The six kinds a creator may reference, and the id field each one is keyed by.
 *
 *  Every one of these ids ALREADY EXISTS in the documents — this table only says
 *  which one names which kind. Nothing here mints an id, and no seventh 「UI
 *  object」 identity is invented. */
export const OBJECT_KINDS = Object.freeze([
  { kind: "shot", icon: "🎬", label: "镜头", idField: "shotId" },
  { kind: "character", icon: "👤", label: "角色", idField: "characterId" },
  { kind: "scene", icon: "🗂", label: "场景", idField: "sceneId" },
  { kind: "location", icon: "📍", label: "场景地", idField: "locationId" },
  { kind: "asset", icon: "📦", label: "资产", idField: "assetId" },
  { kind: "episode", icon: "📺", label: "剧集", idField: "episodeId" },
]);

const ICON = Object.fromEntries(OBJECT_KINDS.map((k) => [k.kind, k.icon]));
const KIND_LABEL = Object.fromEntries(OBJECT_KINDS.map((k) => [k.kind, k.label]));

/**
 * WHICH referenced kinds ACTUALLY REACH A RUN, and why the others do not.
 *
 * A Skill's inputs are DECLARED (ADR-0056 决策 6): `compilePrompt` walks
 * `skill.inputs + skill.optionalInputs` and nothing else, and `scopeOf` records
 * only the levels the context builder really read. So the run contract can carry
 * a shot and a scene — and has nowhere to put a character, a location, an asset,
 * an episode, or a sentence of prose.
 *
 * THE DEFECT THIS TABLE CLOSES (independent review, batch A round 1). The session
 * accepted all six kinds plus free text and passed only the shot id — so a
 * creator who referenced 林晚 and typed 「写得更冷一点」 got a run that read
 * neither, with nothing on screen saying so. Making the omission SILENT is the
 * failure; making it visible is the fix that fits this card. Widening the run
 * contract is ADR-0067 territory, which TASK-080 §2 explicitly moves out of scope
 * («若被迫改 Skill 包格式、Run 记录 schema 或 skillDigest 语义 —— 停下»).
 */
export const SENT_KINDS = Object.freeze(["shot", "scene"]);

const NOT_SENT_WHY = "运行时不会送出：Skill 的输入是声明式的，没有这一类的位置";

/** The session's own state, created on first read.
 *
 *  Lives on the shell's `ui` bag, which `setModule` never replaces — which is
 *  exactly why the session survives a page change (验收 #5). `releasePageState`
 *  in production.js is the ONE thing a navigation does to `ui`, and it does not
 *  name any of these keys; a guard test asserts that rather than trusting it. */
export function sessionState(ui) {
  if (!ui.agentSession) {
    ui.agentSession = {
      // WHAT THE AGENT IS LOOKING AT — stated by the creator, editable, visible.
      context: [],
      text: "",
      // the capability chosen with `/`, if any
      skillId: null,
      // which token is being typed right now (`/` or `@`), for the picker
      pick: null,
    };
  }
  return ui.agentSession;
}

/* -------------------------------------------------------------------------- */
/* the referenceable objects                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every object a `@` can reach, from the CANONICAL documents.
 *
 * Read-only and derived: an object that has been deleted simply stops appearing
 * here, which is how a stale reference in the context becomes visible as
 * 「已不在」 rather than silently resolving to nothing.
 */
export function objectIndex(ctx) {
  const pd = ctx.prodData();
  const prod = (pd && pd.production) || { episodes: [], characters: [], locations: [] };
  const out = [];
  const push = (kind, id, label) => {
    if (id && label) out.push({ kind, id, label, icon: ICON[kind] });
  };
  (prod.episodes || []).forEach((e, i) => {
    const code = `EP${String(i + 1).padStart(2, "0")}`;
    push("episode", e.episodeId, `${code} ${e.title || ""}`.trim());
    for (const sc of e.scenes || []) push("scene", sc.sceneId, `${code} · ${sc.title || sc.sceneId}`);
  });
  for (const c of prod.characters || []) push("character", c.characterId, c.name);
  for (const l of prod.locations || []) push("location", l.locationId, l.name);
  for (const s of pd.draftShots || []) {
    if (!s || !s.shotId) continue;
    push("shot", s.shotId, `Shot ${String(s.sequence ?? "").padStart(2, "0")} ${s.title || ""}`.trim());
  }
  // the library's OWN read model, so a referenced asset is named the way the
  // 资产库 names it rather than by a second labelling rule
  const rows = ctx.assets ? ctx.assets.library({ type: "all", variant: "all" }).rows : [];
  for (const r of rows) push("asset", r.assetId, r.name);
  return out;
}

/* -------------------------------------------------------------------------- */
/* the `/` and `@` triggers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The token being typed at the END of the instruction, if it is a trigger.
 *
 * A trigger only counts at a word boundary: `他/她` and an e-mail address must
 * not open a picker. Returns `{ trigger, query, start }`, where `start` is where
 * the token begins so a pick can replace exactly it.
 */
export function activeToken(text) {
  const t = typeof text === "string" ? text : "";
  const m = /(^|\s)([/@])([^\s/@]*)$/.exec(t);
  if (!m) return null;
  return { trigger: m[2], query: m[3], start: m.index + m[1].length, end: t.length };
}

function match(hay, q) {
  if (!q) return true;
  return String(hay).toLowerCase().includes(q.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* model                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The whole session, derived.
 *
 * `skills` is `catalogRows` — the SAME function ⚙ 能力目录 renders from. Two
 * derivations of the capability set is the fork §3's guard test exists to
 * prevent: a `/` list that quietly differs from the catalog would make the
 * catalog a lie about what can be run.
 */
export function agentSessionModel(ctx, ui) {
  const st = sessionState(ui);
  const objects = objectIndex(ctx);
  const byId = new Map(objects.map((o) => [`${o.kind}:${o.id}`, o]));
  // A REFERENCE WHOSE OBJECT IS GONE IS SHOWN, NOT DROPPED. Silently removing it
  // would make the context the creator stated differ from the context they see,
  // which is the exact opposite of 「上下文可见且可编辑」.
  const rows = st.context.map((r) => {
    const live = byId.get(`${r.kind}:${r.id}`) || null;
    return {
      kind: r.kind,
      id: r.id,
      icon: ICON[r.kind] || "•",
      kindLabel: KIND_LABEL[r.kind] || r.kind,
      label: live ? live.label : r.label || r.id,
      alive: !!live,
    };
  });
  // 送出 IS NOT DECIDED HERE. IT IS ASKED OF THE DOMAIN.
  //
  // Three review rounds found three variants of the same defect, because each fix
  // restated one more of `scopeOf`'s rules in this file: the contract carries one
  // shot and one scene (round 2), and it drops a scene the run's episode does not
  // own, and it drops levels a capability does not read at all (round 3). Every
  // restatement is a SECOND derivation of the recording rule, and a second
  // derivation is exactly what keeps disagreeing.
  //
  // So the flag is read off `ctx.skills.scopeOf` — the very function that stamps
  // the Run record. Whatever it keeps is what the creator is told was used; there
  // is no rule here left to drift from it.
  const candidate = new Map();
  for (const r of rows) {
    if (r.alive && SENT_KINDS.includes(r.kind) && !candidate.has(r.kind)) candidate.set(r.kind, r);
  }
  const proposed = {
    ...(candidate.get("shot") ? { shotId: candidate.get("shot").id } : {}),
    ...(candidate.get("scene") ? { sceneId: candidate.get("scene").id } : {}),
  };
  const recorded = st.skillId && typeof ctx.skills.scopeOf === "function"
    ? ctx.skills.scopeOf(st.skillId, Object.keys(proposed).length ? proposed : null)
    : null;
  const keptId = { shot: recorded ? recorded.shotId : null, scene: recorded ? recorded.sceneId : null };
  const context = rows.map((r) => {
    const carries = SENT_KINDS.includes(r.kind);
    const sent = carries && r.alive && keptId[r.kind] === r.id;
    let mark = null;
    let why = null;
    if (!sent) {
      if (!carries) { mark = "笔记"; why = NOT_SENT_WHY; }
      else if (!st.skillId) { mark = "待定"; why = "先选一个能力，才知道这一项会不会被送出"; }
      else if (candidate.get(r.kind) !== r) {
        mark = "未送出";
        why = `运行只带一个${KIND_LABEL[r.kind] || r.kind}，送出的是上面第一个`;
      } else {
        // the candidate itself was dropped by the recording rule — a foreign
        // episode, or a level this capability does not read
        mark = "未送出";
        why = "这个能力的运行记录里放不下这一项（不属于本次运行的剧集，或它根本不读这一层）";
      }
    }
    return { ...r, sent, mark, why };
  });
  const skills = catalogRows(ctx);
  const tok = activeToken(st.text);
  let pick = null;
  if (tok && tok.trigger === "/") {
    pick = {
      trigger: "/",
      query: tok.query,
      rows: skills
        .filter((s) => match(`${s.title} ${s.role} ${s.skillId} ${s.purpose}`, tok.query))
        .slice(0, 12)
        .map((s) => ({
          id: s.skillId,
          label: s.title,
          sub: `${s.role} · ${s.ready ? "可运行" : `缺 ${s.missing.length} 项输入`}`,
          ready: s.ready,
        })),
      total: skills.length,
    };
  } else if (tok && tok.trigger === "@") {
    const hits = objects.filter((o) => match(o.label, tok.query));
    pick = {
      trigger: "@",
      query: tok.query,
      rows: hits.slice(0, 12).map((o) => ({
        id: `${o.kind}:${o.id}`,
        label: o.label,
        sub: KIND_LABEL[o.kind],
        icon: o.icon,
      })),
      total: objects.length,
    };
  }
  const skill = st.skillId ? skills.find((s) => s.skillId === st.skillId) || null : null;
  // What a run would be OFFERED — read from the context the creator stated, not
  // from whatever page they are on. A shot in the context is what makes a run
  // shot-scoped; without one, a shot-scoped capability says so instead of
  // answering about whichever shot happened to be selected. What is finally
  // RECORDED is `recorded` above, and only the domain decides that.
  const shotRef = candidate.get("shot") || null;
  // Anything the run will NOT carry, named. Derived from the same flag, so the
  // chip and the sentence under the run button cannot disagree.
  const notSent = context.filter((r) => !r.sent && r.alive);
  const proseIgnored = String(st.text || "").replace(/[/@][^\s]*/g, "").trim();
  const runs = (ctx.skills.runs() || [])
    .filter((r) => r && (!st.skillId || r.skillId === st.skillId))
    .slice()
    .reverse()
    .slice(0, 6)
    .map((r) => ({
      skillRunId: r.runId,
      skillId: r.skillId,
      status: r.status,
      createdAt: r.createdAt,
    }));
  return {
    context,
    text: st.text,
    pick,
    skill,
    skillCount: skills.length,
    objectCount: objects.length,
    // what the shell OFFERS to `ctx.skills.run` …
    scope: { shotId: proposed.shotId || null, sceneId: proposed.sceneId || null },
    // … and what `scopeOf` says will actually be recorded from it. The surface
    // prints THIS one, so it can only ever claim what the record will hold.
    recorded: recorded
      ? { episodeId: recorded.episodeId || null, sceneId: recorded.sceneId || null, shotId: recorded.shotId || null }
      : null,
    notSent,
    proseIgnored,
    blocked: !skill
      ? "输入 / 选一个能力"
      : !skill.ready
        ? `缺少必要输入：${skill.inputs.filter((i) => i.missing).map((i) => i.label).join("、")}`
        : skill.shotScoped && !shotRef
          ? "这是镜头级能力——用 @ 引用一个镜头，它才知道在说哪一镜"
          : null,
    runs,
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

function pickerHtml(p) {
  if (!p) return "";
  const head = p.trigger === "/"
    ? `能力 · ${p.rows.length}/${p.total}`
    : `对象 · ${p.rows.length}/${p.total}`;
  const rows = p.rows.length
    ? p.rows
        .map(
          (r) =>
            `<button class="as-pick" data-as-pick="${esc(r.id)}" data-as-trigger="${esc(p.trigger)}">` +
            `<span class="as-pi">${r.icon || (p.trigger === "/" ? "⚡" : "•")}</span>` +
            `<span class="as-pl">${esc(r.label)}</span>` +
            `<span class="as-ps">${esc(r.sub || "")}</span></button>`,
        )
        .join("")
    : `<div class="meta">没有匹配的${p.trigger === "/" ? "能力" : "对象"}。`
      + `全部共 ${p.total} 个——删掉后面的字可以看到更多。</div>`;
  return `<div class="as-picker"><div class="lab">${esc(head)}</div>${rows}</div>`;
}

/**
 * @param opts.panel  HTML of the page-level Agent panel (TASK-080 §1.2 批次 B).
 *
 *  IT MOVED HERE, IT DID NOT GO AWAY. 「询问 Agent」 used to open a SECOND panel in
 *  the middle column — a fourth right-hand surface with its own scope, its own
 *  close button and its own idea of what the Agent was looking at. The button
 *  stays (IA §6.1 fixes it at each page's top right); what it opens is now this
 *  one session, so there is one place that answers 「Agent 现在在看什么」.
 *  Its seven items and every one of its actions are rendered verbatim.
 */
export function renderAgentSession(m, { panel = "", split = false } = {}) {
  const chips = m.context.length
    ? m.context
        .map(
          (r) =>
            `<span class="as-chip${r.alive ? "" : " gone"}${r.sent ? " sent" : ""}" ` +
            `title="${esc(`${r.kindLabel} · ${r.id}${r.why ? ` · ${r.why}` : ""}`)}">` +
            `<span class="as-ci">${r.icon}</span>${esc(r.label)}` +
            (r.alive ? "" : `<span class="chip bad">已不在</span>`) +
            (r.alive && r.mark
              ? `<span class="chip${r.mark === "未送出" ? " gate" : " mute"}">${esc(r.mark)}</span>`
              : "") +
            `<button class="as-cx" data-as-drop="${esc(`${r.kind}:${r.id}`)}" title="从上下文里移除">✕</button>` +
            `</span>`,
        )
        .join("")
    : `<span class="meta">还没有引用任何对象——输入 <b>@</b> 可以把镜头 / 角色 / 场景 / 场景地 / 资产 / 剧集加进来。</span>`;
  // WHAT YOU TYPE INTO. Kept together so it can be pinned to the bottom of the
  // column (REQ-004 判据 4) — the one element that must never move as the
  // Director finds more to say above it.
  const composer =
    `<div class="lab">当前上下文</div>` +
    `<div class="as-ctx">${chips}</div>` +
    (m.skill
      ? `<div class="lab">要做什么</div>` +
        `<div class="as-task"><b>${esc(m.skill.title)}</b>` +
        `<span class="chip mute">${esc(m.skill.role)}</span>` +
        `<button class="as-cx" data-as-clearskill="1" title="换一个能力">✕</button></div>`
      : "") +
    // WHAT ACTUALLY GOES OUT, spelled out. The session accepts six kinds and free
    // text; the run contract carries two of them. Saying which is which is the
    // difference between a session and a box that quietly eats what you type.
    // PRINTED FROM `recorded`, i.e. from `scopeOf` itself — never from a local
    // guess about what it would keep.
    `<div class="meta">这次运行会被记为：` +
    `<b>${esc(m.skill ? m.skill.title : "（还没选能力）")}</b>` +
    (m.recorded
      ? [
        m.recorded.episodeId ? "本集" : null,
        m.recorded.sceneId ? "限定到一个场景" : null,
        m.recorded.shotId ? "限定到一个镜头" : null,
      ].filter(Boolean).map((t) => ` · ${t}`).join("") || " · 没有任何层级限定"
      : m.skill ? " · 没有任何层级限定" : "") +
    `。</div>` +
    (m.notSent.length || m.proseIgnored
      ? `<div class="meta as-nosend">` +
        (m.notSent.length
          ? `${m.notSent.map((r) => `「${esc(r.label)}」`).join("")}` +
            `${m.proseIgnored ? "和你写的文字" : ""}`
          : `你写的文字`) +
        `<b>不会</b>进入这次运行的 Prompt——Skill 的输入是声明式的（ADR-0056 决策 6），` +
        `没有可以放它们的位置。它们留在这里作为你自己的笔记；` +
        `想按自己的说法跑，用下面「能力」里的「查看任务 Prompt」+ 手工运行。</div>`
      : "") +
    // THE BOX IS LAST (REQ-004 判据 4). Everything explanatory sits ABOVE it,
    // the way a chat console puts its input at the very bottom — a note printed
    // BELOW the box is the line that gets clipped by the band edge.
    `<textarea class="field as-input" rows="3" spellcheck="false" ` +
    `placeholder="说你要做什么。/ 唤出能力，@ 引用对象">${esc(m.text)}</textarea>` +
    pickerHtml(m.pick) +
    `<div class="as-acts">` +
    (m.blocked
      ? `<div class="dir-unavail">◌ ${esc(m.blocked)}</div>`
      : `<button class="btn primary sm" data-as-run="1">运行「${esc(m.skill.title)}」</button>`) +
    `</div>`;
  // WHAT ALREADY HAPPENED. Scrolls above the composer, because history grows and
  // an input box that history pushes down is the thing this split removes.
  const history =
    (m.runs.length
      ? `<div class="lab">运行记录</div><ul class="as-runs">` +
        m.runs
          .map(
            (r) =>
              `<li><span class="chip${r.status === "failed" ? " bad" : r.status === "succeeded" ? " ok" : ""}">` +
              `${esc(r.status)}</span><span class="as-rn">${esc(r.skillId)}</span>` +
              `<span class="as-rt">${esc(String(r.createdAt || "").slice(5, 16).replace("T", " "))}</span></li>`,
          )
          .join("") +
        `</ul>`
      : `<div class="meta">这个会话还没有运行记录。</div>`) +
    (panel ? `<div class="lab">这一页的诊断</div>${panel}` : "");
  const head =
    `<div class="dir-sec-h static"><span class="ti">会话</span>` +
    `<span class="su"><span class="chip mute">${m.skillCount} 个能力</span></span></div>`;
  // TWO PLACES, ONE MODEL (REQ-004 判据 4/5). `split` only changes WHERE the two
  // halves are mounted — both are still rendered, so nothing a creator could
  // reach before became unreachable.
  if (split) {
    return {
      history:
        `<section class="dir-sec open as-sec as-history">` +
        head +
        `<div class="dir-sec-b as-body">${history}</div></section>`,
      composer:
        `<section class="dir-sec open as-sec as-composer">` +
        `<div class="dir-sec-b as-body">${composer}</div></section>`,
    };
  }
  return (
    `<section class="dir-sec open as-sec">` +
    head +
    `<div class="dir-sec-b as-body">` +
    composer +
    history +
    `</div></section>`
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                       */
/* -------------------------------------------------------------------------- */

/** Replace the trailing trigger token with nothing — a pick is recorded as a
 *  CHIP or a task, never left as text the creator has to clean up. */
export function stripToken(text) {
  const tok = activeToken(text);
  if (!tok) return text;
  return text.slice(0, tok.start);
}

export function bindAgentSession(root, ctx, ui, render, { onRun } = {}) {
  const st = sessionState(ui);
  const box = root.querySelector(".as-input");
  if (box) {
    box.oninput = () => {
      const before = !!st.pick;
      st.text = box.value;
      const now = activeToken(st.text);
      st.pick = now ? now.trigger : null;
      // Re-render ONLY when the picker's presence changes. Repainting on every
      // keystroke would move the caret and drop the creator out of their own
      // sentence — the failure that makes an inline picker unusable.
      if (before !== !!st.pick || st.pick) {
        const pos = box.selectionStart;
        render();
        const again = root.querySelector(".as-input");
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
      }
    };
  }
  root.querySelectorAll("[data-as-pick]").forEach((b) => (b.onclick = () => {
    const id = b.dataset.asPick;
    if (b.dataset.asTrigger === "/") {
      st.skillId = id;
    } else {
      const at = id.indexOf(":");
      const kind = id.slice(0, at);
      const objId = id.slice(at + 1);
      if (!st.context.some((r) => r.kind === kind && r.id === objId)) {
        const hit = objectIndex(ctx).find((o) => o.kind === kind && o.id === objId);
        st.context = [...st.context, { kind, id: objId, label: hit ? hit.label : objId }];
      }
    }
    st.text = stripToken(st.text);
    st.pick = null;
    render();
  }));
  root.querySelectorAll("[data-as-drop]").forEach((b) => (b.onclick = () => {
    const id = b.dataset.asDrop;
    const at = id.indexOf(":");
    const kind = id.slice(0, at);
    const objId = id.slice(at + 1);
    st.context = st.context.filter((r) => !(r.kind === kind && r.id === objId));
    render();
  }));
  const clear = root.querySelector("[data-as-clearskill]");
  if (clear) clear.onclick = () => { st.skillId = null; render(); };
  const run = root.querySelector("[data-as-run]");
  if (run) run.onclick = () => { if (onRun) onRun(st.skillId); };
}
