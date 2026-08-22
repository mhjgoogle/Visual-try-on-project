// 分集规划 Episode Plan — Production's EXIT (ADR-0054 决策 5 / 决策 6).
//
// Each episode card carries two different kinds of truth, and says which is
// which:
//
//   PLAN      the confirmed plan entry — number / title / synopsis / dramatic
//             purpose / hook / ending beat / duration (owned by the versioned
//             story plan, never re-typed here)
//   ARC       what this episode actually advances — Main Plot Beat, Character
//             Beat, Relationship Beat (start → event → end), World Reveal.
//             Episode-level records; writing one never edits project canon.
//
// Plus the dependency truth: 「Based on 创意 v2 · 大纲 v3 · 人物 v2 …」 and, when
// upstream moved on, 「N 个上游更新」 opening a lightweight Impact Review. An
// upstream revision NEVER rewrites an episode — the review only reports.
//
// PURE PRESENTATION over ctx.story (plan versions) and ctx.canon (beats,
// stamps, impact). The plan proposal/apply/confirm panel is reused verbatim
// from workspaces.js — this screen adds no second planning path.
import { esc } from "../util/dom.js";
import { episodesModel, renderPlanPanel } from "./workspaces.js";
import { UPSTREAM_STATE_LABEL } from "../workflow/canondoc.js";
import { head, empty } from "./shell.js";
import { bindField, restoreFieldFocus } from "./fieldsync.js";
import { reviewText, reviewList, notRunYet, written } from "./reviewface.js";
import { effectivePlanEpisodes, planEditBase, planDirty, planDraftVersions, nextPlanVersion } from "../workflow/storydoc.js";
import { liveEpisodes } from "../workflow/proddoc.js";

const code = (i) => `EP${String(i + 1).padStart(2, "0")}`;

/** Pure view-model of the Episode Plan surface: every EPISODE ENTITY joined to
 *  its confirmed plan entry, its beats (resolved to names) and its deterministic
 *  upstream impact. Exported for node --test.
 *
 *  `impactOf` is injected (ctx.canon.impact) so the model stays pure and the
 *  impact rule lives in exactly one place (canondoc). */
export function episodePlanModel(pd, story, impactOf) {
  const prod = pd.production;
  if (!prod || !Array.isArray(prod.episodes)) return { empty: true };
  // TASK-069: the entries ON SCREEN — the unversioned hand edit when there is one,
  // else the version on file. `effectivePlanEpisodes` is the ONE derivation, so the
  // editor and the reader cannot show different text for the same episode.
  const entries = effectivePlanEpisodes(story);
  const base = planEditBase(story);
  const byChar = new Map((prod.characters || []).map((c) => [c.characterId, c]));
  const byRel = new Map((prod.relationships || []).map((r) => [r.relationshipId, r]));
  const relLabel = (r) => {
    if (!r) return "（已删除的关系）";
    const [a, b] = r.characterIds.map((id) => (byChar.get(id) || {}).name || "?");
    return `${a} × ${b}`;
  };
  // ARCHIVED EPISODES LEAVE THE LIST (ADR-0072 决策 4 / 批次 G). They stay in the
  // document and stay resolvable by id — a script, a Run or a plan entry still
  // points at them — but a shell with nothing in it is not something the creator
  // is working with, and 48 of those is what 「分集规划竟然设计了 48 集」 was.
  //
  // The INDEX for `code` comes from this filtered list on purpose: EP01…EP12 must
  // be what the creator counts on screen, not positions in a list holding 36 rows
  // they cannot see.
  const episodes = liveEpisodes(prod).map((e, i) => {
    const entry = entries.find((x) => x.episodeId === e.episodeId) || null;
    const beats = e.beats;
    const impact = impactOf ? impactOf(e.episodeId) : null;
    return {
      episodeId: e.episodeId,
      code: code(i),
      title: e.title,
      active: e.episodeId === prod.activeEpisodeId,
      sceneCount: e.scenes.length,
      // plan facets come from the CONFIRMED plan version, or are honestly absent
      plan: entry
        ? {
            epNumber: entry.epNumber, title: entry.title, synopsis: entry.synopsis,
            purpose: entry.purpose, hook: entry.hook, endingBeat: entry.endingBeat, duration: entry.duration,
            // 产品负责人的七项（TASK-088 §2.1）. Carried through the model rather
            // than read off the document in the renderer, so the table and any
            // other reader see one derivation.
            coreGoal: entry.coreGoal, emotionArc: entry.emotionArc,
            keyEvents: Array.isArray(entry.keyEvents) ? entry.keyEvents : [],
            reveals: Array.isArray(entry.reveals) ? entry.reveals : [],
            characterBeats: Array.isArray(entry.characterBeats) ? entry.characterBeats : [],
          }
        : null,
      beats: {
        plot: beats.plot,
        world: beats.world,
        character: beats.character.map((b) => ({
          characterId: b.characterId,
          name: (byChar.get(b.characterId) || {}).name || b.characterId,
          tier: (byChar.get(b.characterId) || {}).tier || "formal",
          beat: b.beat,
        })),
        relationship: beats.relationship.map((b) => ({
          relationshipId: b.relationshipId,
          label: relLabel(byRel.get(b.relationshipId)),
          start: b.start, event: b.event, end: b.end,
        })),
      },
      beatCount: beats.plot.length + beats.world.length + beats.character.length + beats.relationship.length,
      impact,
    };
  });
  // THE TABLE IS THE PLAN VERSION (TASK-088 §2.3). One row per ENTRY of the
  // version on screen, in the plan's own order — not one card per Episode entity.
  //
  // WHY THIS IS THE HONEST SHAPE. 分集规划 used to render `prod.episodes`, so the
  // real project showed 48 rows for a 12-episode plan and the product owner read
  // that as 「分集规划竟然设计了 48 集」. Those 48 entities are real (four confirmed
  // versions created them, ADR-0072 背景), but they are not THIS plan — so the
  // plan shows its own entries, and everything else is accounted for below in
  // `others` rather than silently dropped.
  const byEpisode = new Map(episodes.map((e) => [e.episodeId, e]));
  const rows = entries.map((entry) => {
    const ep = entry.episodeId ? byEpisode.get(entry.episodeId) || null : null;
    return {
      // the PLAN's own numbering: this row is 「本版第 N 集」, which is what the
      // creator is reading and what the reviser is told to preserve
      code: `EP${String(entry.epNumber).padStart(2, "0")}`,
      epNumber: entry.epNumber,
      episodeId: entry.episodeId || null,
      // 「这一行还没有对应的剧集实体」 — an unconfirmed plan entry. It is NOT
      // editable (every plan edit is addressed by episodeId) and it has nowhere to
      // enter, so the row says so instead of offering controls that refuse.
      linked: !!ep,
      title: entry.title,
      entity: ep,
      plan: {
        // `title` IS one of the editable facets — the 标题 cell reads it from here,
        // and leaving it out rendered twelve rows whose title cell showed only a
        // placeholder while the real title sat in the row header (caught by looking
        // at the actual screen on 照见未明rev2, not by a test).
        title: entry.title,
        coreGoal: entry.coreGoal, emotionArc: entry.emotionArc,
        endingBeat: entry.endingBeat, hook: entry.hook,
        duration: entry.duration, synopsis: entry.synopsis, purpose: entry.purpose,
        keyEvents: Array.isArray(entry.keyEvents) ? entry.keyEvents : [],
        reveals: Array.isArray(entry.reveals) ? entry.reveals : [],
        characterBeats: Array.isArray(entry.characterBeats) ? entry.characterBeats : [],
      },
    };
  });
  const inPlan = new Set(entries.map((e) => e.episodeId).filter(Boolean));
  const others = episodes.filter((e) => !inPlan.has(e.episodeId));
  // …and what has been put away. Read straight off the document (not from
  // `episodes`, which is the LIVE list) so 「已归档」 is answered by the field rather
  // than by absence from a filtered list.
  const archived = (prod.episodes || [])
    .filter((e) => e.archived && e.archived.at)
    .map((e, i) => ({
      episodeId: e.episodeId,
      code: `#${i + 1}`,
      title: e.title,
      archivedAt: e.archived.at,
      archivedReason: e.archived.reason || "",
    }));
  return {
    empty: false,
    episodes,
    rows,
    others,
    archived,
    planVersion: story.confirmedPlan || 0,
    // TASK-077 §1.6: THE TWO NUMBERS, named. One screen printed 48 / 48 集 / 12 集 /
    // 47 集 with no statement of what each counted, so they read as four claims
    // about one quantity that disagreed. They are two different quantities:
    //   established  Episode ENTITIES that exist in the production document
    //   planned      entries in the plan version currently on screen
    // A confirmed plan usually has fewer entries than the project has episodes
    // (older episodes predate it, or the plan covers one arc), and that difference
    // is normal — it just has to be said.
    establishedCount: episodes.length,
    plannedCount: entries.length,
    // THE THIRD NUMBER (TASK-094 §4). 创意 says 24 集, every plan version has 12
    // entries, and 48 entities exist — three numbers that never checked each other,
    // which is GAP-06's real form. The screen now states all three and FLAGS a
    // mismatch. It does NOT block: a creator may legitimately be planning the
    // first 12 of 24 (「做出来给用户看」——他看完不满意再改).
    targetEpisodes: (() => {
      const brief = story.brief && (story.brief.versions || []).find((x) => x.v === story.brief.active);
      const fields = brief ? brief.fields : story.brief && story.brief.draft;
      const n = fields ? fields.targetEpisodes : null;
      return Number.isInteger(n) && n > 0 ? n : null;
    })(),
    // …and what the APPROVED outline asked for, which is what the planner is told
    // to respect (`episode-planner` reviewCriteria: 集数是否尊重 episodeCount)
    outlineEpisodeCount: (() => {
      const o = (story.versions || []).find((x) => x.v === (story.approved || story.active));
      const n = o && o.outline ? o.outline.episodeCount : null;
      return Number.isInteger(n) && n > 0 ? n : null;
    })(),
    // the version a hand edit is based on (0 = there is no plan to edit yet), and
    // whether that edit is currently unsaved
    planBaseVersion: base ? base.v : 0,
    planBaseIsConfirmed: !!base && base.v === story.confirmedPlan,
    planDirty: planDirty(story),
    nextPlanVersion: nextPlanVersion(story),
    // versions OTHER than the one on screen that still hold an unsaved edit. Named
    // so a waiting draft is never invisible: drafts are per-version now (codex
    // review), which is what makes them survive 「查看 v2」 — but a draft the creator
    // cannot see is one they cannot finish.
    planOtherDrafts: planDraftVersions(story).filter((v) => !base || v !== base.v),
    characterOptions: (prod.characters || []).map((c) => ({ characterId: c.characterId, name: c.name, tier: c.tier })),
    relationshipOptions: (prod.relationships || []).map((r) => ({
      relationshipId: r.relationshipId, label: relLabel(r),
    })),
  };
}

/** 「Based on: 创意 v2 · 大纲 v3 · 人物 v2」 — the episode's upstream baseline.
 *
 *  Every state comes STRAIGHT off the impact model (surface.state); nothing is
 *  recomputed here, so the chips, the flag and the count can never tell three
 *  different stories. The three cases the creator must be able to tell apart:
 *
 *    未记录   no baseline recorded (a legacy/migrated episode) — muted, and it
 *             NEVER contributes to 「N 个上游变化」
 *    v2       baseline recorded and still in force — plain
 *    v1 ⚠     baseline recorded and the upstream has since moved — gated
 */
function basedOnLine(ep) {
  const im = ep.impact;
  if (!im) return "";
  const CHIP = { unknown: " mute", current: "", outdated: " gate", diverged: " gate" };
  const parts = im.surfaces
    .filter((s) => s.state !== "none") // a surface with no version at all is not a baseline
    .map((s) => {
      const txt = s.state === "unknown" ? "未记录" : `v${s.from}`;
      const title = s.state === "unknown"
        ? `本集没有记录 ${s.label} 的基线（当前 v${s.current}）——不代表落后`
        : s.state === "current"
          ? `当前 ${s.label} v${s.current}`
          : `本集基于 v${s.from}，当前 ${s.label} 是 v${s.current}（${UPSTREAM_STATE_LABEL[s.state]}）`;
      return `<span class="chip${CHIP[s.state]}" title="${esc(title)}">${esc(s.label)} ${esc(txt)}</span>`;
    });
  if (!parts.length) {
    return `<div class="rw"><span class="meta">上游还没有任何正式版本 — 先在「创意 / 故事大纲 / 人物 / 人物关系 / 世界观」确认版本</span></div>`;
  }
  // ONE flag per episode state. An unknown baseline gets 「上游基线未记录」 plus
  // the way to establish one — never a change count it cannot justify.
  const flag = im.count
    ? `<button class="btn sm gate" data-impact="${esc(ep.episodeId)}">⚠ ${im.count} 个上游变化</button>`
    : im.unknown.length
      ? `<span class="chip mute">上游基线未记录</span>` +
        `<button class="btn sm" data-stamp="${esc(ep.episodeId)}">建立当前基线</button>`
      : `<span class="chip ok">与上游一致</span>`;
  return `<div class="rw row tight"><span class="k">Based on</span>${parts.join("")}${flag}</div>`;
}

/** The bar that tells the creator what state their edit is in, and gets them out
 *  of it. Rendered only when there is a plan to edit. */
function planEditBar(ctx, dirty, baseV, baseIsConfirmed, otherDrafts, nextV) {
  return (
    `<div class="planbar row tight">` +
    // The flag and the save button are updated IN PLACE while typing (see
    // bindEpPlanWs). Re-rendering on every keystroke would move the caret out of
    // the field being typed in — the rule ui/fieldsync.js exists for — but leaving
    // them stale would tell the creator their edit was not registered and that
    // 保存 is unavailable, while the draft had in fact already been saved.
    `<span class="chip gate" data-plan-flag${dirty ? "" : " hidden"}>已手工修改（未版本化）</span>` +
    `<span class="chip mute" data-plan-clean${dirty ? " hidden" : ""}>规划 v${esc(String(baseV))} · 未改动</span>` +
    `<span class="push"></span>` +
    `<button class="btn sm" data-plan-discard${dirty ? "" : " hidden"}>放弃修改</button>` +
    `<button class="btn primary sm" data-plan-save${dirty ? "" : " disabled"}>保存为新版本</button>` +
    `</div>` +
    (otherDrafts && otherDrafts.length
      ? `<div class="meta">另有 ${otherDrafts.map((v) => `v${v}`).join("、")} ` +
        `也有未保存的手工修改——切到那一版即可继续。</div>`
      : "") +
    `<div class="meta">手工修改先存成草稿；「保存为新版本」才创建规划 v${esc(String(nextV))}，` +
    `旧版本全部保留。要让下游剧集改用新版本，还需在上面<b>确认</b>它。</div>`
  );
}

/** The Arc block: what this episode advances. Editable inline — every write
 *  goes through ctx.canon and is Episode-level only. */
/** 本集要推进什么 — ON THE SURFACE, always editable (产品 2026-08-13 选择的形状).
 *
 *  It is part of 「这一集要表达的内容」, not production machinery, so it does not hide
 *  behind a toggle. What DID move into 详情 is the dependency baseline and the entry
 *  into 剧集制作 — those are about how the episode gets MADE, not about what it says. */
/*
 *  `ep` IS THE VIEW MODEL, NOT THE DOCUMENT. `episodePlanModel` already resolves
 *  each beat's `name` / `tier` / `label` against the bible (see `beats:` above), so
 *  a row reads them straight off the entry. Handing the raw
 *  `production.episodes[i]` in here would render nameless rows — asserted by
 *  「a recorded canon beat is still shown and still editable」, which checks the
 *  character's NAME reaches the row (this was reported as a defect by codex review,
 *  批次 B round 2; it is not one, and the assertion is there so it cannot become
 *  one).
 */
function beatsBlock(m, ep, ui = {}) {
  const list = (kind, label, ph) =>
    `<label class="ws-lab">${esc(label)}</label>` +
    `<textarea class="ws-bibletext" rows="3" spellcheck="false" placeholder="${esc(ph)}" data-beat-text="${esc(ep.episodeId)}" data-kind="${kind}">${esc((kind === "plot" ? ep.beats.plot : ep.beats.world).join("\n"))}</textarea>`;

  // ONLY THE PEOPLE THIS EPISODE ACTUALLY ADVANCES (TASK-088 §1.3 / §2.3).
  //
  // This used to lay out one input per CAST MEMBER: 6 characters × 48 episodes =
  // 288 boxes in the real project, of which the capability produced exactly zero.
  // 「为什么那么多重复的内容要写呢」 had a precise technical answer — 确实要他写.
  //
  // So a row exists for a character who HAS a beat here, plus one picker to add
  // one. Nothing is removed: every character is still reachable through the
  // picker, and an existing beat is still edited in place.
  // A ROW EXISTS EITHER BECAUSE THERE IS A BEAT, OR BECAUSE THE CREATOR JUST
  // PICKED THAT CHARACTER. The pick is SHELL state (`ui.beatOpen`) — it writes
  // nothing. The first shape of this wrote a placeholder 「（这一集他走了哪一步）」
  // through `setCharacterBeat` to make the row appear, which put a beat the
  // creator never entered into canonical episode data and left it there if they
  // walked away (codex review, 批次 B round 1, blocking). Scaffolding must never
  // reach the document.
  const opened = ui.beatOpen || {};
  const isOpen = (id) => !!opened[`${ep.episodeId}:${id}`];
  const withBeat = ep.beats.character.filter((b) => b.beat && b.beat.trim());
  const charRow = (characterId, name, tier, beat) =>
    `<div class="beatrow"><span class="chip${tier === "bit" ? " mute" : ""}">${esc(name)}${tier === "bit" ? " ·临时" : ""}</span>` +
    `<input class="ws-bibleinput" placeholder="本集这个人物走了哪一步（清空＝本集不推进）" ` +
    `data-beat-char="${esc(ep.episodeId)}" data-cid="${esc(characterId)}" value="${esc(beat || "")}"></div>`;
  const charRows =
    withBeat.map((b) => charRow(b.characterId, b.name, b.tier, b.beat)).join("") +
    m.characterOptions
      .filter((c) => isOpen(c.characterId) && !withBeat.some((b) => b.characterId === c.characterId))
      .map((c) => charRow(c.characterId, c.name, c.tier, ""))
      .join("");
  const notYet = m.characterOptions.filter(
    (c) => !withBeat.some((b) => b.characterId === c.characterId) && !isOpen(c.characterId),
  );
  const charAdd = notYet.length
    ? `<select class="ws-assign" data-beat-add="${esc(ep.episodeId)}">` +
      `<option value="">＋ 记一个人物的推进…</option>` +
      notYet.map((c) => `<option value="${esc(c.characterId)}">${esc(c.name)}</option>`).join("") +
      `</select>`
    : "";
  // …and the same rule for relationships, which had the same shape (2 × 48 × 3
  // fields here). `relws.js` tells the creator to remove a Relationship Beat from
  // THIS screen, so a recorded one must stay visible and editable.
  const withRel = ep.beats.relationship.filter((b) => [b.start, b.event, b.end].some((x) => x && x.trim()));
  const relRow = (relationshipId, label, cur) => {
    const f = (k, ph) =>
      `<input class="ws-bibleinput sm" placeholder="${esc(ph)}" data-beat-rel="${esc(ep.episodeId)}" ` +
      `data-rid="${esc(relationshipId)}" data-field="${k}" value="${esc(cur && typeof cur[k] === "string" ? cur[k] : "")}">`;
    return (
      `<div class="beatrow rel"><span class="chip">${esc(label)}</span>` +
      f("start", "start（本集开始时）") + f("event", "event（本集发生了什么）") + f("end", "end（本集结束时）") +
      `</div>`
    );
  };
  const relRows =
    withRel.map((r) => relRow(r.relationshipId, r.label, r)).join("") +
    m.relationshipOptions
      .filter((r) => isOpen(r.relationshipId) && !withRel.some((b) => b.relationshipId === r.relationshipId))
      .map((r) => relRow(r.relationshipId, r.label, null))
      .join("");
  const relNotYet = m.relationshipOptions.filter(
    (r) => !withRel.some((b) => b.relationshipId === r.relationshipId) && !isOpen(r.relationshipId),
  );
  const relAdd = !m.relationshipOptions.length
    ? `<div class="meta">还没有人物关系 — 在「人物关系」建立后可在这里记录每集的推进。</div>`
    : relNotYet.length
      ? `<select class="ws-assign" data-beat-reladd="${esc(ep.episodeId)}">` +
        `<option value="">＋ 记一段关系的推进…</option>` +
        relNotYet.map((r) => `<option value="${esc(r.relationshipId)}">${esc(r.label)}</option>`).join("") +
        `</select>`
      : "";

  return (
    `<div class="beatbox"><div class="hd"><b>本集要推进什么</b></div>` +
    `<div class="meta">这里记录<b>这一集实际发生了什么</b>；作品级的人物设定与关系定义不会因此改变。</div>` +
    list("plot", "Main Plot Beat 主线推进（每行一条）", "一行一条主线进展") +
    `<label class="ws-lab">Character Beat 人物推进</label>` +
    (charRows || `<div class="meta">这一集还没有记录任何人物推进。</div>`) + charAdd +
    `<label class="ws-lab">Relationship Beat 关系推进（Episode-level）</label>` +
    (relRows || (m.relationshipOptions.length ? `<div class="meta">这一集还没有记录关系推进。</div>` : "")) + relAdd +
    list("world", "World Rule / Information Reveal 世界规则与信息揭示（每行一条）", "一行一条揭示") +
    `</div>`
  );
}

/** Lightweight Impact Review (决策 6). Two clearly separated parts:
 *  1. deterministic dependency change — provable, this is what the system knows;
 *  2. AI semantic impact — no checker exists yet, so it is shown as
 *     unavailable. It is NEVER faked. */
function impactReview(ep) {
  const im = ep.impact;
  if (!im) return "";
  // each row names WHICH kind of change it is — 已更新 (moved forward) vs
  // 已回退 (the pointer now selects an earlier revision)
  const rows = im.stale
    .map(
      (s) =>
        `<div class="bd-f"><span>${esc(s.label)}</span>${esc(UPSTREAM_STATE_LABEL[s.state])}：` +
        `本集基于 v${s.from} · 当前 v${s.current}` +
        `<button class="btn sm" data-goto="${esc(s.goto)}">查看上游</button></div>`,
    )
    .join("");
  // an UNKNOWN baseline is reported as an absence of information, never as
  // "behind": the document does not record what this episode was built on
  const unst = im.unknown.length
    ? `<div class="meta">另有 ${im.unknown.length} 个上游（${esc(im.unknown.map((u) => u.label).join("、"))}）` +
      `本集<b>没有记录基线</b> —— 这不是「落后」，而是无从判断。可在下方建立当前基线。</div>`
    : "";
  return (
    `<div class="impactbox"><div class="hd"><b>⚠ 影响审阅 · ${esc(ep.code)}</b>` +
    `<span class="push"></span><button class="btn sm" data-impact-close>关闭</button></div>` +
    `<div class="lab">1 · 确定性依赖变化（系统可证明）</div>` +
    (rows || `<div class="meta">没有与本集不一致的上游。</div>`) + unst +
    `<div class="lab">2 · AI 语义影响判断</div>` +
    `<div class="dir-unavail">◌ ${esc(im.semantic.reason)}</div>` +
    `<div class="meta">上游变化<b>不会</b>自动改写本集。确认这一集仍然成立后，可把它记录为基于当前上游版本。</div>` +
    `<div class="row"><button class="btn primary sm" data-stamp="${esc(ep.episodeId)}">✔ 本集已复核 · 记录为基于当前版本</button>` +
    `<button class="btn sm" data-ep-enter="${esc(ep.episodeId)}">进入剧集制作 →</button></div>` +
    `</div>`
  );
}

/** The nine columns of 分集规划. `label` is the product owner's own wording. */
export const PLAN_COLUMNS = [
  { key: "ep", label: "集" },
  { key: "title", label: "标题" },
  { key: "coreGoal", label: "本集核心目标" },
  { key: "keyEvents", label: "主要剧情" },
  { key: "characterBeats", label: "角色推进" },
  { key: "reveals", label: "信息揭示" },
  { key: "emotionArc", label: "情绪曲线" },
  { key: "ending", label: "结尾钩子" },
  { key: "ops", label: "" },
];

/** Which list rows the creator has explicitly opened for hand entry, per cell.
 *  Transient shell state: `ui.planOpen["<episodeId>:<field>"] = [index, …]`. */
function openedRows(ui, episodeId, field) {
  const all = ui.planOpen || {};
  const list = all[`${episodeId}:${field}`];
  return Array.isArray(list) ? list : [];
}

/**
 * THE LEGACY PROSE, still readable and still editable.
 *
 * The real project's four plan versions are written in `synopsis` / `purpose` —
 * `episode-planner` v2's七项 did not exist when they were made. Rendering only the
 * new fields would show the product owner twelve nearly-empty rows for a plan that
 * is in fact full, which is the 「界面说的和事实不符」 family this whole chain is
 * about. So the old value is shown where its replacement would go, labelled as
 * what it is, and 「让 AI 改一次」 is what turns it into the structured form.
 *
 * SHOWN WHENEVER IT IS NON-EMPTY — not only while the new field is blank (codex
 * review, 批次 B round 1). They are two DISTINCT stored values: hiding the old one
 * as soon as the new one is filled left real content on disk that this screen
 * could neither show nor clear, so a creator could not even delete it.
 */
function legacyNote(row, field, label) {
  const value = row.plan[field];
  if (typeof value !== "string" || !value.trim()) return "";
  return (
    `<div class="ept-legacy"><span class="chip mute" title="这一版规划写在旧字段里；让 AI 改一次就会拆成新的结构">${esc(label)}</span>` +
    `<textarea class="rf-t" rows="3" spellcheck="false" ` +
    `data-plan-edit="${esc(row.episodeId)}" data-field="${field}">${esc(value)}</textarea></div>`
  );
}

/** One 主要剧情 / 信息揭示 cell: a review face over a string list. */
function listCell(ui, row, field, opts) {
  return reviewList(opts.label, row.plan[field], {
    rowAttrs: (i) =>
      `class="rf-i" data-plan-item="${esc(row.episodeId)}" data-field="${field}" data-i="${i}"`,
    addAttrs: `data-rf-add="${esc(row.episodeId)}" data-field="${field}"`,
    open: openedRows(ui, row.episodeId, field),
    min: opts.min ?? null,
    max: opts.max ?? null,
    hint: opts.hint || "",
    addLabel: opts.addLabel || "加一条",
    placeholder: opts.placeholder || "",
  });
}

/** 角色推进 — one row per character the AI actually advanced, never one per cast
 *  member. This is the direct answer to 「为什么那么多重复的内容要写呢」: the old
 *  surface laid out `characterOptions.length × episodes.length` inputs (6 × 48 =
 *  288 in the real project) that no capability produced a single character of. */
function beatsCell(m, ui, row) {
  const beats = row.plan.characterBeats;
  const known = new Set(m.characterOptions.map((c) => c.name));
  const opened = openedRows(ui, row.episodeId, "characterBeats");
  const rows = beats
    .map((b, i) => ({ b, i }))
    .filter(({ b, i }) => written(b) || opened.includes(i))
    .map(({ b, i }) => {
      const f = (key, ph) =>
        `<input class="rf-i" data-plan-beat="${esc(row.episodeId)}" data-i="${i}" data-key="${key}" ` +
        `placeholder="${esc(ph)}" value="${esc(typeof b[key] === "string" ? b[key] : "")}">`;
      // A NAME THAT MATCHES NO CHARACTER IS FLAGGED, NOT DROPPED. The capability
      // is told not to invent people; when it does anyway, silently discarding the
      // row would leave the creator believing nothing was produced.
      const unknown = b.who && b.who.trim() && !known.has(b.who.trim())
        ? `<span class="chip gate" title="人物档案里没有这个名字 —— AI 不应发明人物；改成已有角色，或去「作品设定」建立他">未知人物</span>`
        : "";
      return (
        `<div class="rf-row beat">${f("who", "谁")}${unknown}${f("change", "发生了什么变化")}` +
        f("relationChange", "关系怎么变（可空）") +
        `<button class="btn sm ghost" data-rf-del="${esc(row.episodeId)}" data-field="characterBeats" ` +
        `data-i="${i}" title="移除这一行">✕</button></div>`
      );
    })
    .join("");
  return (
    `<div class="rf-l" data-rf-list="角色推进">` +
    (rows || `<div class="meta rf-none">AI 没有写这一项</div>`) +
    `<button class="btn sm rf-add" data-rf-add="${esc(row.episodeId)}" data-field="characterBeats">＋ 加一个角色</button>` +
    `</div>`
  );
}

/** 结尾钩子 — TWO fields in ONE cell (TASK-088 §2.1). They are two different
 *  things in the real data (`endingBeat` = what finally happened, `hook` = the
 *  question left open), so merging them would lose one; showing them apart on the
 *  table would read as two unrelated columns. */
function endingCell(row) {
  const f = (field, label, ph) =>
    reviewText(label, row.plan[field], {
      attrs: `data-plan-edit="${esc(row.episodeId)}" data-field="${field}"`,
      rows: 2,
      placeholder: ph,
      force: true,
    });
  return f("endingBeat", "最后发生了什么", "这一集停在哪一下") + f("hook", "留下什么悬念", "推动下一集的那个问题");
}

/** One table row. Editable only when the entry is LINKED to an Episode entity —
 *  every plan edit is addressed by episodeId, so an unconfirmed entry has nothing
 *  to write to and says so rather than offering controls that refuse. */
function planRow(m, ui, row) {
  const ep = row.entity;
  const cell = (field, ph, rows = 2) =>
    reviewText("", row.plan[field], {
      attrs: `data-plan-edit="${esc(row.episodeId)}" data-field="${field}"`,
      rows,
      placeholder: ph,
      force: true,
    });
  if (!row.linked) {
    return (
      `<tr class="ept-row unlinked" data-eprow="${esc(String(row.epNumber))}">` +
      `<td class="ept-ep"><span class="mono">${esc(row.code)}</span></td>` +
      `<td colspan="${PLAN_COLUMNS.length - 1}"><b>${esc(row.title)}</b>` +
      `<div class="meta">这一版还没确认，所以这一集还没有对应的剧集实体 ——` +
      `上面「确认规划 v${esc(String(m.planBaseVersion))}」之后就能逐格修改，并进入这一集。</div></td>` +
      `</tr>`
    );
  }
  return (
    `<tr class="ept-row${ep.active ? " on" : ""}" data-eprow="${esc(row.episodeId)}">` +
    `<td class="ept-ep"><span class="mono">${esc(row.code)}</span>` +
    (ep.active ? `<span class="chip ok" title="当前剧集">当前</span>` : "") +
    (row.plan.duration ? `<div class="meta">${esc(row.plan.duration)}</div>` : "") +
    `</td>` +
    `<td class="ept-title">${cell("title", "这一集叫什么", 1)}</td>` +
    `<td class="ept-goal">${cell("coreGoal", "这一集要完成的那一件事")}` +
    legacyNote(row, "purpose", "旧字段 · 戏剧功能") +
    `</td>` +
    `<td class="ept-events">${listCell(ui, row, "keyEvents", {
      label: "", min: 3, max: 6, addLabel: "加一条事件", placeholder: "一个动作或转折",
    })}` +
    legacyNote(row, "synopsis", "旧字段 · 梗概") +
    `</td>` +
    `<td class="ept-beats">${beatsCell(m, ui, row)}</td>` +
    `<td class="ept-reveals">${listCell(ui, row, "reveals", {
      label: "", addLabel: "加一条", placeholder: "观众这一集新知道了什么",
    })}</td>` +
    `<td class="ept-arc">${cell("emotionArc", "平静 → 紧张 → 冲突 → 转折", 2)}</td>` +
    `<td class="ept-end">${endingCell(row)}</td>` +
    `<td class="ept-ops">` +
    `<button class="btn primary sm" data-ep-open="${esc(row.episodeId)}">去写剧本 →</button>` +
    `<button class="btn sm" data-ep-enter="${esc(row.episodeId)}">进入剧集制作 →</button>` +
    // …and the row's own fold remembers being opened, for the same reason: it holds
    // 时长 and the beats editor, and adding a 主要剧情 row re-renders — which used to
    // collapse the fold the creator was working inside.
    `<details class="epmore"${ui.impactOpen === row.episodeId || (ui.epmoreOpen || {})[row.episodeId] ? " open" : ""}` +
    ` data-epmore="${esc(row.episodeId)}">` +
    `<summary>详情：时长 / 上游基线 / 本集实际推进</summary>` +
    // 时长 is deliberately NOT a column: it derives from 创意's 单集时长方向 and is
    // only written when THIS episode deviates (TASK-088 §2.1), so a column of it
    // would be twelve boxes nobody needs to fill.
    reviewText("时长（仅偏离时填）", row.plan.duration, {
      attrs: `data-plan-edit="${esc(row.episodeId)}" data-field="duration"`,
      placeholder: "例如 90 秒",
      force: true,
    }) +
    basedOnLine(ep) +
    (ui.impactOpen === row.episodeId ? impactReview(ep) : "") +
    beatsBlock(m, ep, ui) +
    `</details></td>` +
    `</tr>`
  );
}

/** 「另有 N 集不在这一版规划里」 — everything that EXISTS but is not part of the plan
 *  on screen. Folded, because the table is the plan; present, because 36 real
 *  Episode entities carrying real scripts must not vanish from the one screen that
 *  used to list them (they are cleaned up by TASK-094 批次 G, not by hiding). */
function othersFold(m, ui, cleanup) {
  if (!m.others.length) return "";
  // 「归档这 N 个零内容空壳」 (TASK-094 批次 G / ADR-0072 决策 4-5).
  //
  // WHO DECIDES: `episodeCleanupReport` scans the WHOLE document for any reference
  // to each episodeId. The button offers only what that scan cleared, and every
  // episode it did NOT clear says WHY on its own row — 「任何一项非空就不归档，如实
  // 列出来交给产品负责人看」 (TASK-094 §5). Nothing is deleted: archiving is a field
  // that can be put back.
  const report = Array.isArray(cleanup) ? cleanup : [];
  const byId = new Map(report.map((r) => [r.episodeId, r]));
  const canArchive = m.others.filter((e) => (byId.get(e.episodeId) || {}).archivable);
  const cleanupRow = report.length
    ? `<div class="rg-ai">` +
      (canArchive.length
        ? `<button class="btn sm" data-ep-archive-all>归档这 ${canArchive.length} 个零内容空壳</button>` +
          `<span class="meta">它们没有剧本、没有分镜、没有推进记录，也没有被文档里任何地方引用过。` +
          `<b>归档不是删除</b>：记录留在文档里、按 id 仍然可解析，随时可以取消归档。</span>`
        : `<span class="chip mute">这些集都有内容或被引用，没有可归档的空壳</span>`) +
      `</div>`
    : "";
  // OPEN WHEN THE CREATOR OPENED IT, **OR** WHEN WHAT THEY ASKED FOR IS INSIDE IT.
  // `ui.othersOpen` is recorded by the fold's own `toggle` handler (`bindEpPlanWs`);
  // without that, any re-render — including the one caused by clicking 「⚠ N 个上游
  // 变化」 on an episode in here — collapsed the fold and hid the very review that
  // click had just requested (codex review, 批次 B round 2, blocking).
  const holdsImpact = m.others.some((e) => e.episodeId === ui.impactOpen);
  return (
    `<details class="ept-others"${ui.othersOpen || holdsImpact ? " open" : ""}><summary>` +
    `另有 ${m.others.length} 集不在这一版规划里（更早的规划版本建立的）</summary>` +
    `<div class="meta">它们仍然存在、仍然可以进入 —— 只是当前这一版规划没有引用它们。` +
    `其中没有任何内容的空壳可以归档（ADR-0072 决策 4）。</div>` +
    cleanupRow +
    m.others
      .map((ep) => {
        const r = byId.get(ep.episodeId) || null;
        // WHY THIS ONE STAYS, on its own row. A cleanup that archived 32 and said
        // nothing about the other 4 would leave the creator to work out which of his
        // episodes were spared and why.
        const verdict = !r
          ? ""
          : r.archivable
            ? `<span class="chip mute" title="没有任何内容，也没有被引用">可归档</span>`
            : `<span class="chip ok" title="${esc(r.blockers.join("；"))}">留下：${esc(r.blockers[0] || "有内容")}</span>`;
        return (
        `<div class="ept-other${ep.active ? " on" : ""}">` +
        `<span class="mono">${esc(ep.code)}</span><b>${esc(ep.title)}</b>` +
        `<span class="meta">${ep.sceneCount} 个场景 · ${ep.beatCount} 条推进记录</span>` +
        verdict +
        basedOnLine(ep) +
        // …and its Impact Review opens HERE. `basedOnLine` above renders the
        // 「⚠ N 个上游变化」 button for these episodes too, and a button whose panel
        // has nowhere to appear is a button that does nothing.
        (ui.impactOpen === ep.episodeId ? impactReview(ep) : "") +
        `<button class="btn sm" data-ep-enter="${esc(ep.episodeId)}">进入 →</button>` +
        `</div>`);
      })
      .join("") +
    `</details>`
  );
}

/** 「已归档 N 集」 — archived episodes are OUT of the way, not out of existence, and
 *  every one of them can come back (ADR-0072 决策 4: 取消归档随时可以，这是敢做这一步
 *  的前提). */
function archivedFold(m, ui) {
  if (!m.archived.length) return "";
  return (
    `<details class="ept-others"${ui.archivedOpen ? " open" : ""} data-archivedfold><summary>` +
    `已归档 ${m.archived.length} 集（不显示在上面，记录仍在）</summary>` +
    `<div class="meta">归档只是把空壳收起来：它们仍然在文档里、按 id 仍然可解析，` +
    `所以指向它们的历史记录不会变成悬空引用。想要哪一集回来就取消归档。</div>` +
    m.archived
      .map((ep) =>
        `<div class="ept-other">` +
        `<span class="mono">${esc(ep.code)}</span><b>${esc(ep.title)}</b>` +
        (ep.archivedAt ? `<span class="meta">归档于 ${esc(String(ep.archivedAt).slice(0, 16))}</span>` : "") +
        `<button class="btn sm" data-ep-unarchive="${esc(ep.episodeId)}">取消归档</button>` +
        `</div>`)
      .join("") +
    `</details>`
  );
}

/** The three numbers, and whether they agree (TASK-094 §4). PROMPTS, NEVER BLOCKS:
 *  planning the first 12 of 24 episodes is a legitimate state, so a mismatch is
 *  reported and the save path is untouched. */
function countLine(m) {
  const parts = [`本版规划 ${m.plannedCount} 集`, `已建立 ${m.establishedCount} 集`];
  if (m.targetEpisodes) parts.push(`创意目标 ${m.targetEpisodes} 集`);
  if (m.outlineEpisodeCount) parts.push(`大纲 ${m.outlineEpisodeCount} 集`);
  const disagree = [m.targetEpisodes, m.outlineEpisodeCount]
    .filter((n) => Number.isInteger(n) && n !== m.plannedCount);
  const flag = m.plannedCount && disagree.length
    ? `<span class="chip gate" title="这只是提示：先规划前几集是完全正常的，保存不受影响">` +
      `条数与目标集数不一致</span>`
    : "";
  return `<div class="row tight ept-counts"><span class="meta">${esc(parts.join(" · "))}</span>${flag}</div>`;
}

export function renderEpPlanWs(ctx, ui) {
  const pd = ctx.prodData();
  const em = episodesModel(pd);
  if (em.empty) return head("分集规划", "项目级") + empty("📺", "剧集结构不可用", "生产域文档未加载。");
  const m = episodePlanModel(pd, ctx.story.doc(), (id) => ctx.canon.impact(id));

  const table = m.rows.length
    ? `<div class="ept-wrap"><table class="ept">` +
      `<thead><tr>${PLAN_COLUMNS.map((c) => `<th class="ept-h-${esc(c.key)}">${esc(c.label)}</th>`).join("")}</tr></thead>` +
      `<tbody>${m.rows.map((r) => planRow(m, ui, r)).join("")}</tbody>` +
      `</table></div>`
    // NOT AN EMPTY FORM (TASK-094 §1.2). With no plan yet there is exactly one
    // thing to do, and 「让 AI 规划」 lives in the panel above — so this states the
    // situation instead of drawing a grid of blank cells to fill in by hand.
    : notRunYet(
        "还没有分集规划",
        "AI 会按已批准的故事大纲规划逐集：集数 / 标题、本集核心目标、主要剧情、角色推进、信息揭示、情绪曲线、结尾钩子。上面「生成剧集规划提案」跑一次，这里就是一张可以逐格修改的表。",
      );

  return (
    head(
      "分集规划",
      `AI 写好、你逐格改${m.planVersion ? ` · 规划 v${m.planVersion} 已确认` : " · 还没有确认的版本"}`,
    ) +
    renderPlanPanel(ctx, em) +
    (m.planBaseVersion
      ? planEditBar(ctx, m.planDirty, m.planBaseVersion, m.planBaseIsConfirmed, m.planOtherDrafts, m.nextPlanVersion)
      : "") +
    countLine(m) +
    table +
    // the cleanup verdict comes from the WHOLE document, so the page asks the shell
    // for it rather than deriving it from `production` alone (批次 G)
    othersFold(m, ui, ctx.production && ctx.production.cleanupReport ? ctx.production.cleanupReport() : null) +
    archivedFold(m, ui)
  );
}

/** Wire the workspace. Plan proposal/apply/confirm keeps the shared bindings
 *  (bindEpisodes) so there is exactly one planning write path; everything added
 *  here is beats, stamps and the impact review. */
export function bindEpPlanWs(root, ctx, ui, rerender) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  on("[data-plan-discard]", () => { if (ctx.story.discardPlanDraft()) rerender(); });
  on("[data-plan-save]", (el) => { if (!el.hasAttribute("disabled")) { ctx.story.savePlanDraft(); rerender(); } });
  // AUTOSAVE ON INPUT (ui/fieldsync.js): the draft is persisted, so a refresh
  // mid-sentence keeps what was typed. It is still NOT a version — see planEditBar.
  // …and reflect the new dirty state on the bar WITHOUT a re-render, so the caret
  // stays where the creator is typing (ui/fieldsync.js) while 「已手工修改」 and the
  // enabled 保存 button appear immediately.
  const flag = root.querySelector("[data-plan-flag]");
  const clean = root.querySelector("[data-plan-clean]");
  const save = root.querySelector("[data-plan-save]");
  const discard = root.querySelector("[data-plan-discard]");
  const syncBar = () => {
    const d = ctx.story.planDirty();
    if (flag) flag.hidden = !d;
    if (clean) clean.hidden = d;
    if (discard) discard.hidden = !d;
    if (save) { if (d) save.removeAttribute("disabled"); else save.setAttribute("disabled", ""); }
  };
  root.querySelectorAll("[data-plan-edit]").forEach((el) => {
    bindField(el, ui, (value) => {
      ctx.story.editPlanEntry(el.dataset.planEdit, el.dataset.field, value);
      syncBar();
    });
  });
  // …and the LIST facets (主要剧情 / 信息揭示 / 角色推进). Same autosave-into-the-draft
  // rule, same `syncBar` so 保存 arms without a re-render stealing the caret.
  root.querySelectorAll("[data-plan-item]").forEach((el) => {
    bindField(el, ui, (value) => {
      ctx.story.editPlanItem(el.dataset.planItem, el.dataset.field, Number(el.dataset.i), value);
      syncBar();
    });
  });
  root.querySelectorAll("[data-plan-beat]").forEach((el) => {
    bindField(el, ui, (value) => {
      ctx.story.editPlanBeat(el.dataset.planBeat, Number(el.dataset.i), el.dataset.key, value);
      syncBar();
    });
  });
  // ADDING / REMOVING A ROW re-renders (a row appeared or vanished), unlike typing.
  // The new row's index is remembered so `reviewface`'s blank-row filter renders
  // it: a row the creator ASKED for is not an empty box nobody wanted.
  on("[data-rf-add]", (el) => {
    const episodeId = el.dataset.rfAdd;
    const field = el.dataset.field;
    const i = ctx.story.addPlanItem(episodeId, field);
    if (i < 0) { ctx.toast("这一版还没有确认，暂时不能逐格修改"); return; }
    if (!ui.planOpen) ui.planOpen = {};
    const key = `${episodeId}:${field}`;
    ui.planOpen[key] = [...(ui.planOpen[key] || []), i];
    rerender();
  });
  on("[data-rf-del]", (el) => {
    const episodeId = el.dataset.rfDel;
    const field = el.dataset.field;
    const index = Number(el.dataset.i);
    if (!ctx.story.removePlanItem(episodeId, field, index)) return;
    // the opened-row marks shift with the removal, or they would keep a row that
    // is no longer there visible and hide the one that took its place
    if (ui.planOpen) {
      const key = `${episodeId}:${field}`;
      ui.planOpen[key] = (ui.planOpen[key] || [])
        .filter((i) => i !== index)
        .map((i) => (i > index ? i - 1 : i));
    }
    rerender();
  });
  on("[data-impact]", (el) => { ui.impactOpen = el.dataset.impact; rerender(); });
  on("[data-impact-close]", () => { ui.impactOpen = null; rerender(); });
  on("[data-stamp]", (el) => { if (ctx.canon.stamp(el.dataset.stamp)) { ui.impactOpen = null; rerender(); } });
  // AUTOSAVE ON INPUT (see ui/fieldsync.js): beats are canonical episode data,
  // so a refresh mid-sentence must not lose them.
  root.querySelectorAll("[data-beat-text]").forEach((el) => {
    bindField(el, ui, (value) => {
      const list = value.split("\n").map((s) => s.trim()).filter(Boolean);
      ctx.canon.setTextBeats(el.dataset.beatText, el.dataset.kind, list);
    });
  });
  root.querySelectorAll("[data-beat-char]").forEach((el) => {
    bindField(el, ui, (value) => ctx.canon.setCharacterBeat(el.dataset.beatChar, el.dataset.cid, value));
  });
  root.querySelectorAll("[data-beat-rel]").forEach((el) => {
    // start/event/end are ONE record, so the write re-reads all three from the
    // row (via the field's own current value for the one being edited) — saving
    // one of them can never blank the other two
    bindField(el, ui, (value) => {
      const scope = el.closest(".beatrow");
      const get = (f) => {
        if (f === el.dataset.field) return value;
        const x = scope && scope.querySelector(`[data-beat-rel][data-field="${f}"]`);
        return x ? x.value : "";
      };
      ctx.canon.setRelationshipBeat(el.dataset.beatRel, el.dataset.rid, {
        start: get("start"), event: get("event"), end: get("end"),
      });
    });
  });
  // 「＋ 记一个人物的推进…」 — the picker that replaced the row-per-cast-member grid.
  // Writing a SPACE would be a lie (that is not a beat); an empty beat is refused
  // by the domain. So the pick only OPENS a row, by writing a placeholder the
  // creator immediately types over — recorded on the shell, not in the document.
  // 「＋ 记一个人物 / 一段关系的推进…」 — the pickers that replaced the row-per-cast-member
  // grid. THEY WRITE NOTHING: the pick only opens a row on the shell, and the
  // creator's first keystroke is what reaches canon through the bindings above.
  // Writing a placeholder to make the row appear put a beat nobody entered into
  // canonical episode data (codex review, 批次 B round 1).
  root.querySelectorAll("[data-beat-add]").forEach((sel) => {
    sel.onchange = () => {
      if (!sel.value) return;
      ui.beatOpen = { ...(ui.beatOpen || {}), [`${sel.dataset.beatAdd}:${sel.value}`]: true };
      rerender();
    };
  });
  root.querySelectorAll("[data-beat-reladd]").forEach((sel) => {
    sel.onchange = () => {
      if (!sel.value) return;
      ui.beatOpen = { ...(ui.beatOpen || {}), [`${sel.dataset.beatReladd}:${sel.value}`]: true };
      rerender();
    };
  });
  // A FOLD THE CREATOR OPENED MUST SURVIVE THE NEXT RE-RENDER. `<details>` keeps its
  // own state in the DOM, and this page rebuilds that DOM — so the state is recorded
  // on the shell here rather than being silently lost (codex review, 批次 B round 2).
  // `toggle` needs no re-render: the browser has already opened or closed it.
  const others = root.querySelector(".ept-others");
  if (others) others.ontoggle = () => { ui.othersOpen = others.open; };
  const archived = root.querySelector("[data-archivedfold]");
  if (archived) archived.ontoggle = () => { ui.archivedOpen = archived.open; };
  // 归档 / 取消归档 (批次 G). Archiving is offered ONLY for what the document-wide
  // scan cleared, and it is confirmed once — it changes what the creator sees on
  // their own project, and 「说清楚将要发生什么」 is cheaper than an undo they have to
  // discover. Un-archiving needs no confirmation: it only puts something back.
  on("[data-ep-archive-all]", () => {
    if (!ctx.production || !ctx.production.archiveEmptyShells) return;
    const n = ctx.production.archivableCount ? ctx.production.archivableCount() : 0;
    if (!n) { ctx.toast("没有可归档的空壳"); return; }
    if (!window.confirm(
      `归档 ${n} 个零内容空壳？\n\n` +
      "它们没有剧本、没有分镜、没有推进记录，也没有被文档里任何地方引用。\n" +
      "这不是删除：记录留在文档里，按 id 仍然可解析，随时可以取消归档。",
    )) return;
    ctx.production.archiveEmptyShells();
    rerender();
  });
  on("[data-ep-unarchive]", (el) => {
    if (!ctx.production || !ctx.production.unarchive) return;
    ctx.production.unarchive(el.dataset.epUnarchive);
    rerender();
  });
  root.querySelectorAll("[data-epmore]").forEach((el) => {
    el.ontoggle = () => {
      if (!ui.epmoreOpen) ui.epmoreOpen = {};
      ui.epmoreOpen[el.dataset.epmore] = el.open;
    };
  });
  restoreFieldFocus(root, ui);
}
