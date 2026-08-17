// 落地页项目卡 —— 封面 + 进度 (TASK-082 §1.3 / GAP-11).
//
// WHAT IT REPLACES. C-001: a grey folder glyph, the project name, a 「真实项目」
// badge and 「未记录资产位置」. Four projects looked identical, and the one number
// on the card was about where its files are — not about the film.
//
// EVERYTHING HERE IS ALREADY IN THE DOCUMENT. The episode count is the production
// doc's own list, the shot count is the shots its scenes really own, and the
// cover is an asset the registry already declares. Nothing is fetched that the
// canvas does not already contain, and nothing is invented: a project whose
// canvas cannot be read says so instead of showing zeros.
//
// A COVER IS NEVER A FILE THE PROBE SAYS IS GONE (§1.3). `storageState` on an
// Asset is a DECLARATION nobody checks (see services/mediaprobe.js), so picking
// 「the first registered image」 would put a broken glyph on the landing page —
// which is precisely the 「碎图」 this card names. The candidates are ordered here;
// which one survives is the probe's answer, asked by the caller.
//
// PURE. No fetch, no DOM, no clock.
import { esc } from "../util/dom.js";
import { listAssets } from "../workflow/assetreg.js";
import { currentDraftShots } from "../workflow/shotmap.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/**
 * One project's card, derived from its saved canvas document.
 *
 * `doc` is what `persist.loadCanvas(name)` returns as `.doc` — or null when the
 * canvas could not be read, which is a DIFFERENT state from an empty project and
 * is reported as such.
 */
export function projectCardModel(doc) {
  if (!isObj(doc)) {
    return {
      readable: false, episodes: null, shots: null, generated: null,
      coverCandidates: [],
    };
  }
  const prod = isObj(doc.production) ? doc.production : {};
  // ARCHIVED SHELLS DO NOT COUNT ON THE PROJECT CARD (批次 G). The card answers
  // 「这个项目有多少集」, and the archived ones are put-away husks — the very reason
  // this card's own comment below argues about one word meaning two things.
  const episodes = (Array.isArray(prod.episodes) ? prod.episodes : [])
    .filter((e) => !(e && e.archived && e.archived.at));
  // THE SHOTS THE EPISODES REALLY OWN. Counted as a SET across scenes: a shot id
  // listed by two scenes is one shot, and counting the lists would inflate the
  // number the creator is shown.
  const shotIds = new Set();
  for (const e of episodes) {
    for (const sc of (isObj(e) && Array.isArray(e.scenes) ? e.scenes : [])) {
      for (const id of (isObj(sc) && Array.isArray(sc.shotIds) ? sc.shotIds : [])) {
        if (id) shotIds.add(id);
      }
    }
  }
  // …AND THE SHOTS THAT EXIST AT ALL (TASK-086 §3).
  //
  // Owning is not existing, and this card showed only the first. The live project
  // 照见未明rev2 has 60 drafted shots, NONE of them claimed by a scene, so the card
  // said 「0 镜」 while 本集看板 two clicks away said 「60 个镜头」. Both numbers were
  // defined correctly and the creator has only one reading: a card saying 0 after
  // you drafted 60 shots reads as 「我什么都没做」 or 「我的分镜没了」. That is the
  // GAP-06 failure (one word, two meanings, no stated scope) on the first screen
  // of the product.
  //
  // So the card carries the number a creator means by 「镜」 — the shots that
  // exist — and says how many of them are grouped only when that is not all of
  // them. `draftShots` is the same list ⑦ 分镜设计 and 本集看板 count.
  // `currentDraftShots` is the ONE reader of a saved document's draft list —
  // `draftShots` is a runtime field the hydrate pass fills, so a card reading the
  // saved doc has to walk the nodes, and a second copy of that walk is exactly how
  // two surfaces come to disagree about 「几镜」 in the first place.
  const drafted = new Set(
    currentDraftShots(doc)
      .map((s) => (isObj(s) ? s.shotId || s.slot : null))
      .filter(Boolean),
  );
  // A shot claimed by a scene but absent from the current draft still exists as
  // far as the production doc is concerned, so the total is the union — never
  // smaller than either half.
  const allShots = new Set([...drafted, ...shotIds]);
  const assets = listAssets(doc.assets);
  // 已生成 = shots that have a SELECTED video. Counted by the shot the video
  // proves it belongs to (`creativeShotId`), falling back to its slot key — a
  // count of takes would say 「3 已生成」 for one shot rendered three times.
  const generated = new Set(
    assets.filter((a) => a.domain === "videos" && a.current)
      .map((a) => a.creativeShotId || a.key),
  ).size;
  // COVER CANDIDATES, in the order a creator would recognise the project by:
  // a reference image (what the work looks like), then a selected shot image.
  const refs = assets.filter((a) => a.domain === "images" && a.current
    && typeof a.kind === "string" && a.kind.endsWith("-reference"));
  const shots = assets.filter((a) => a.domain === "images" && a.current
    && !(typeof a.kind === "string" && a.kind.endsWith("-reference")));
  const coverCandidates = [...refs, ...shots].map((a) => a.url).filter(Boolean);
  return {
    readable: true,
    episodes: episodes.length,
    // `shots` is what the creator means by 「镜」; `grouped` is the narrower count
    // this model used to publish as `shots`, kept because 「归组」 is real progress
    // and ⑦ 分镜设计 reports it.
    shots: allShots.size,
    grouped: shotIds.size,
    generated,
    coverCandidates,
  };
}

/**
 * The first candidate the probe does NOT report missing.
 *
 * `isMissing` is `mediaProbe.isMissing` — which answers false for 「还没问过」 and
 * for 「问不出来」, and true ONLY where something definitively established the
 * bytes are not there. So this skips the files known to be gone and lets the
 * `<img>` itself be the last word on the rest.
 */
export function pickCover(candidates, isMissing) {
  const gone = typeof isMissing === "function" ? isMissing : () => false;
  return (Array.isArray(candidates) ? candidates : []).find((u) => u && !gone(u)) || null;
}

/** 「48 集 · 60 镜 · 0 已生成」 — or an honest gap where a number is not known.
 *
 *  A project whose canvas could not be read prints NO numbers: 「0 集 · 0 镜」 for
 *  a project full of work is the same lie 「余额 ¥0」 was (TASK-077 §1.1).
 *
 *  WHEN NOT EVERY SHOT IS GROUPED, SAY SO (TASK-086 §3). 「60 镜」 alone would leave
 *  a creator wondering why 本集看板 shows nothing under a scene; 「60 镜（0 已归组）」
 *  states the scope of both numbers in the place they disagree. The parenthetical
 *  is omitted when all shots are grouped, because then there is nothing to explain
 *  — a note that never varies is noise, not information. */
export function cardStats(m) {
  if (!m || !m.readable) return null;
  const grouped = typeof m.grouped === "number" ? m.grouped : m.shots;
  const scope = m.shots > 0 && grouped !== m.shots ? `（${grouped} 已归组）` : "";
  return `${m.episodes} 集 · ${m.shots} 镜${scope} · ${m.generated} 已生成`;
}

/** The card's picture: a real cover, or the gradient placeholder it has today. */
export function renderCover(cover, fallbackHtml) {
  if (!cover) return fallbackHtml;
  return (
    `<div class="thumb thumb-cover">` +
    `<img src="${esc(cover)}" alt="" loading="lazy" data-media-url="${esc(cover)}" data-pcard-cover="1">` +
    `</div>`
  );
}
