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
import { effectivePlanEpisodes, planEditBase, planDirty, planDraftVersions, nextPlanVersion } from "../workflow/storydoc.js";

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
  const episodes = prod.episodes.map((e, i) => {
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
  return {
    empty: false,
    episodes,
    planVersion: story.confirmedPlan || 0,
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

/** The six plan facets — DIRECTLY EDITABLE (TASK-069).
 *
 *  No edit mode: click a field and type. The first shape had a 「✎ 手工修改规划」
 *  toggle guarding them; the product could not find it, which is the whole argument
 *  against it — a control you have to discover before you can do the obvious thing
 *  is a control that should not exist.
 *
 *  Typing autosaves into the unversioned draft (`ctx.story.editPlanEntry`); a new
 *  plan version happens only when the creator presses 保存. That split is the same
 *  one the Creative Brief and the episode script already use, and it exists because
 *  a plan version is immutable canon every Episode records itself as based on —
 *  see storydoc's MANUAL plan editing note.
 *
 *  A facet with no value renders as an EMPTY FIELD rather than being hidden: the
 *  read-only version omitted empty facets, which made 「这一集没有钩子」 and
 *  「钩子这一栏不存在」 look identical and left nowhere to type one. */
function planRows(ep) {
  const p = ep.plan;
  if (!p) {
    return `<div class="meta">这一集还没有确认的规划条目 —— 在上方生成/确认剧集规划后，标题、梗概、戏剧功能、钩子、结尾拍与时长会显示在这里。</div>`;
  }
  const f = (field, label, ph, tag = "input") =>
    `<div class="kv edit"><span class="k">${esc(label)}</span>` +
    (tag === "textarea"
      ? `<textarea class="ws-bibletext" rows="2" spellcheck="false" placeholder="${esc(ph)}" ` +
        `data-plan-edit="${esc(ep.episodeId)}" data-field="${field}">${esc(p[field] || "")}</textarea>`
      : `<input class="ws-bibleinput" placeholder="${esc(ph)}" ` +
        `data-plan-edit="${esc(ep.episodeId)}" data-field="${field}" value="${esc(p[field] || "")}">`) +
    `</div>`;
  // ONE BOX (产品 2026-08-13: 「要填的框太多了。尽量统合到一个框填写。告诉我要填什么
  // 就可以了」). 内容概要 is the box; the label says what to cover. The other four
  // facets are OPTIONAL and folded away — they still exist (the script brief and the
  // shot context read them), but nobody has to fill six fields to plan an episode.
  //
  // The title stays outside the fold because it is the episode's NAME, not a facet:
  // the card header shows it and something has to be typeable there.
  // The four framing facets are shown as TEXT in the summary and become inputs only
  // when opened. Auto-opening them because they happen to be filled would put four
  // more boxes on screen for someone who has nothing left to type there — which is
  // the complaint this whole shape answers.
  const FACETS = [["purpose", "戏剧功能"], ["hook", "开场钩子"], ["endingBeat", "结尾拍"], ["duration", "时长"]];
  const filledFacets = FACETS.filter(([k]) => typeof p[k] === "string" && p[k].trim());
  return (
    `<div class="planedit">` +
    f("title", "本集标题", "这一集叫什么") +
    `<div class="kv edit lead"><span class="k">这一集要表达什么</span>` +
    `<span class="hint">写清楚这一集讲了什么、想让观众感受到什么。` +
    `剧本就是从这段细化出来的——写得具体一点，后面省很多事。</span>` +
    `<textarea class="ws-bibletext lead" rows="6" spellcheck="false" ` +
    `placeholder="例：打烊后的酒吧。陈默来要回那段录音，林晚没有交。两个人都不肯先开口，` +
    `直到林晚把录音笔收进口袋、转身关灯——这一集要让观众意识到，录音已经成了筹码。" ` +
    `data-plan-edit="${esc(ep.episodeId)}" data-field="synopsis">${esc(p.synopsis || "")}</textarea></div>` +
    // the four framing facets: optional, and out of the way until wanted
    `<details class="planfacets-fold"><summary>` +
    (filledFacets.length
      // already written: show the VALUES, not four empty-looking inputs. Clicking
      // opens them for editing.
      ? `<span class="facetsum">` +
        filledFacets.map(([k, label]) =>
          `<span class="fc"><i>${esc(label)}</i>${esc(p[k])}</span>`).join("") +
        `</span><span class="more">改</span>`
      : `更多要素（可选）：戏剧功能 / 开场钩子 / 结尾拍 / 时长`) +
    `</summary><div class="planfacets">` +
    f("purpose", "戏剧功能", "它在整部作品里承担什么") +
    f("hook", "开场钩子", "开头用什么抓住观众") +
    f("endingBeat", "结尾拍", "结尾停在哪一下") +
    f("duration", "时长", "例如 8 分钟") +
    `</div></details>` +
    `</div>`
  );
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
function beatsBlock(m, ep) {
  const list = (kind, label, ph) =>
    `<label class="ws-lab">${esc(label)}</label>` +
    `<textarea class="ws-bibletext" rows="3" spellcheck="false" placeholder="${esc(ph)}" data-beat-text="${esc(ep.episodeId)}" data-kind="${kind}">${esc((kind === "plot" ? ep.beats.plot : ep.beats.world).join("\n"))}</textarea>`;

  const charRows = m.characterOptions
    .map((c) => {
      const cur = ep.beats.character.find((b) => b.characterId === c.characterId);
      return (
        `<div class="beatrow"><span class="chip${c.tier === "bit" ? " mute" : ""}">${esc(c.name)}${c.tier === "bit" ? " ·临时" : ""}</span>` +
        `<input class="ws-bibleinput" placeholder="本集这个人物走了哪一步（留空＝本集不推进）" ` +
        `data-beat-char="${esc(ep.episodeId)}" data-cid="${esc(c.characterId)}" value="${esc(cur ? cur.beat : "")}"></div>`
      );
    })
    .join("");
  const relRows = m.relationshipOptions.length
    ? m.relationshipOptions
        .map((r) => {
          const cur = ep.beats.relationship.find((b) => b.relationshipId === r.relationshipId);
          const f = (k, ph) =>
            `<input class="ws-bibleinput sm" placeholder="${esc(ph)}" data-beat-rel="${esc(ep.episodeId)}" ` +
            `data-rid="${esc(r.relationshipId)}" data-field="${k}" value="${esc(cur ? cur[k] : "")}">`;
          return (
            `<div class="beatrow rel"><span class="chip">${esc(r.label)}</span>` +
            f("start", "start（本集开始时）") + f("event", "event（本集发生了什么）") + f("end", "end（本集结束时）") +
            `</div>`
          );
        })
        .join("")
    : `<div class="meta">还没有人物关系 — 在「人物关系」建立后可在这里记录每集的推进。</div>`;

  return (
    `<div class="beatbox"><div class="hd"><b>本集要推进什么</b></div>` +
    `<div class="meta">这里记录<b>这一集实际发生了什么</b>；作品级的人物设定与关系定义不会因此改变。</div>` +
    list("plot", "Main Plot Beat 主线推进（每行一条）", "一行一条主线进展") +
    `<label class="ws-lab">Character Beat 人物推进</label>${charRows}` +
    `<label class="ws-lab">Relationship Beat 关系推进（Episode-level）</label>${relRows}` +
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

export function renderEpPlanWs(ctx, ui) {
  const pd = ctx.prodData();
  const em = episodesModel(pd);
  if (em.empty) return head("分集规划", "项目级") + empty("📺", "剧集结构不可用", "生产域文档未加载。");
  const m = episodePlanModel(pd, ctx.story.doc(), (id) => ctx.canon.impact(id));

  const cards = m.episodes
    .map((ep) => {
      const openImpact = ui.impactOpen === ep.episodeId;
      return (
        `<div class="epcard${ep.active ? " on" : ""}">` +
        `<div class="top"><span class="no">${esc(ep.code)}</span><span class="ti">${esc(ep.title)}</span>` +
        (ep.plan && ep.plan.duration ? `<span class="chip mute push">${esc(ep.plan.duration)}</span>` : `<span class="push"></span>`) +
        `</div><div class="bd">` +
        planRows(ep) +
        beatsBlock(m, ep) +
        // 「根据这个来细化剧本」 — the forward action of a PLAN is the script.
        `<div class="ft"><button class="btn primary sm" data-ep-open="${esc(ep.episodeId)}">去写本集剧本 →</button>` +
        `<span class="meta">${ep.sceneCount} 个场景</span></div>` +
        // …and the production machinery: the dependency baseline, the impact review
        // and the way into 剧集制作. Real and one click away, but not what this
        // screen is about.
        `<details class="epmore"${openImpact ? " open" : ""}><summary>详情：上游基线 / 进入剧集制作</summary>` +
        basedOnLine(ep) +
        (openImpact ? impactReview(ep) : "") +
        `<div class="row tight"><button class="btn sm" data-ep-enter="${esc(ep.episodeId)}">进入剧集制作 →</button></div>` +
        `</details>` +
        `</div></div>`
      );
    })
    .join("");

  return (
    head("分集规划", `${m.episodes.length} 集 · Production 的出口${m.planVersion ? ` · 规划 v${m.planVersion} 已确认` : ""}`) +
    renderPlanPanel(ctx, em) +
    (m.planBaseVersion
      ? planEditBar(ctx, m.planDirty, m.planBaseVersion, m.planBaseIsConfirmed, m.planOtherDrafts, m.nextPlanVersion)
      : "") +
    `<div class="epgrid wide">${cards}</div>`
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
  restoreFieldFocus(root, ui);
}
