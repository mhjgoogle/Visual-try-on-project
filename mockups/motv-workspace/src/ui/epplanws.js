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
  const plan = story.plans.find((p) => p.v === story.confirmedPlan) || null;
  const byChar = new Map((prod.characters || []).map((c) => [c.characterId, c]));
  const byRel = new Map((prod.relationships || []).map((r) => [r.relationshipId, r]));
  const relLabel = (r) => {
    if (!r) return "（已删除的关系）";
    const [a, b] = r.characterIds.map((id) => (byChar.get(id) || {}).name || "?");
    return `${a} × ${b}`;
  };
  const episodes = prod.episodes.map((e, i) => {
    const entry = plan ? plan.episodes.find((x) => x.episodeId === e.episodeId) || null : null;
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
    planVersion: plan ? plan.v : 0,
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

function planRows(p) {
  if (!p) {
    return `<div class="meta">这一集还没有确认的规划条目 —— 在上方生成/确认剧集规划后，标题、梗概、戏剧功能、钩子、结尾拍与时长会显示在这里。</div>`;
  }
  return (
    (p.synopsis ? `<div class="sy">${esc(p.synopsis)}</div>` : "") +
    `<div class="kvrow">` +
    [["戏剧功能", p.purpose], ["开场钩子", p.hook], ["结尾拍", p.endingBeat], ["时长", p.duration]]
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
      .join("") +
    `</div>`
  );
}

/** The Arc block: what this episode advances. Editable inline — every write
 *  goes through ctx.canon and is Episode-level only. */
function beatsBlock(m, ep, openBeats) {
  if (!openBeats) {
    const sum = [
      ep.beats.plot.length ? `主线 ${ep.beats.plot.length}` : "",
      ep.beats.character.length ? `人物 ${ep.beats.character.length}` : "",
      ep.beats.relationship.length ? `关系 ${ep.beats.relationship.length}` : "",
      ep.beats.world.length ? `世界 ${ep.beats.world.length}` : "",
    ].filter(Boolean).join(" · ");
    return (
      `<div class="rw row tight"><span class="k">Arc 推进</span>` +
      (sum ? `<span class="chip ok">${esc(sum)}</span>` : `<span class="chip mute">还没有记录</span>`) +
      `<button class="btn sm" data-beats="${esc(ep.episodeId)}">编辑本集推进</button></div>`
    );
  }
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
    `<div class="beatbox"><div class="hd"><b>本集 Arc 推进</b>` +
    `<span class="push"></span><button class="btn sm" data-beats-close>收起</button></div>` +
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
    `<button class="btn sm" data-ep-enter="${esc(ep.episodeId)}">进入本集</button></div>` +
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
      const openBeats = ui.beatsOpen === ep.episodeId;
      const openImpact = ui.impactOpen === ep.episodeId;
      return (
        `<div class="epcard${ep.active ? " on" : ""}">` +
        `<div class="top"><span class="no">${esc(ep.code)}</span><span class="ti">${esc(ep.title)}</span>` +
        (ep.plan && ep.plan.duration ? `<span class="chip mute push">${esc(ep.plan.duration)}</span>` : `<span class="push"></span>`) +
        `</div><div class="bd">` +
        planRows(ep.plan) +
        basedOnLine(ep) +
        beatsBlock(m, ep, openBeats) +
        (openImpact ? impactReview(ep) : "") +
        `<div class="ft"><button class="btn sm" data-ep-enter="${esc(ep.episodeId)}">进入本集 →</button>` +
        `<span class="meta">${ep.sceneCount} 个场景</span></div>` +
        `</div></div>`
      );
    })
    .join("");

  return (
    head("分集规划", `${m.episodes.length} 集 · Production 的出口${m.planVersion ? ` · 规划 v${m.planVersion} 已确认` : ""}`) +
    renderPlanPanel(ctx, em) +
    `<div class="epgrid wide">${cards}</div>`
  );
}

/** Wire the workspace. Plan proposal/apply/confirm keeps the shared bindings
 *  (bindEpisodes) so there is exactly one planning write path; everything added
 *  here is beats, stamps and the impact review. */
export function bindEpPlanWs(root, ctx, ui, rerender) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  on("[data-beats]", (el) => { ui.beatsOpen = el.dataset.beats; ui.impactOpen = null; rerender(); });
  on("[data-beats-close]", () => { ui.beatsOpen = null; rerender(); });
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
