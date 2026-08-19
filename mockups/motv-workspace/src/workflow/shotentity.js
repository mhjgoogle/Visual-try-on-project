// 镜头实体识别 (TASK-078 §2.3) — which bible entities a shot's own words name,
// and how much of that material is actually ready to generate from.
//
// WHY THIS EXISTS. 「我还差什么才能开始生成」 had its answer scattered across four
// pages: 分镜 (is there a description), 参考统筹 (is a reference bound), 作品设定
// (does the character have a reference image), 画面 (0/N). None of them said it
// together, and 参考统筹 on the real project reported 「没有缺口」 while not one of
// its 60 shots had anything bound — because it derives needs from the SCENE, and
// every shot was unassigned.
//
// The recognition rule is deliberately the one `workflow/breakdown.js` already
// uses — `normName` + conservative equality — extended to "the name occurs in
// this text". Nothing here is fuzzy: a missed mention only costs a link, a wrong
// one would attribute a character to a shot they are not in.
//
// Pure: no DOM, no fetch, no writes.

import { normName } from "./breakdown.js";

/** Characters whose adjacency would make a hit a PARTIAL WORD.
 *
 *  CJK has no word delimiters, so 「林照」 inside 「林照的工位」 is a real mention and
 *  must match. Latin script does have them, so `Ann` must not match inside
 *  `Annabel`. Neither Han nor Kana are in this class, which is why the boundary
 *  check simply does not apply to a Chinese name — that is the intended
 *  asymmetry, not an oversight. */
const WORD_CHAR = /[0-9A-Za-z_À-ɏ]/;

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** The bible entities that can be named in a shot: characters and location
 *  places, as `{ kind, id, name }`. Nameless entries are dropped — an entity
 *  with no name cannot be recognised in prose and a blank needle would match
 *  everywhere. */
export function buildEntityIndex(prod) {
  const out = [];
  if (!isObj(prod)) return out;
  for (const c of Array.isArray(prod.characters) ? prod.characters : []) {
    const name = normName(isObj(c) ? c.name : "");
    if (!name || !isObj(c) || typeof c.characterId !== "string") continue;
    out.push({ kind: "character", id: c.characterId, name });
  }
  for (const l of Array.isArray(prod.locations) ? prod.locations : []) {
    const name = normName(isObj(l) ? l.name : "");
    if (!name || !isObj(l) || typeof l.locationId !== "string") continue;
    out.push({ kind: "location", id: l.locationId, name });
  }
  // 道具（TASK-095 §2.2 / 批次 4C）。**加在这一处，就等于加进了所有计数** ——
  // 「准备资产 N/M」、分镜表的实体链接、②步的缺口行全都读这一份索引。
  // 如果道具在别处单独数一遍，那正是 §2.6.2 那个 16/48：改一个，其余继续说谎。
  for (const p of Array.isArray(prod.props) ? prod.props : []) {
    const name = normName(isObj(p) ? p.name : "");
    if (!name || !isObj(p) || typeof p.propId !== "string") continue;
    out.push({ kind: "prop", id: p.propId, name });
  }
  return out;
}

/** Would a hit at [at, at+len) be a partial word? Only ever true for scripts
 *  that HAVE word characters at the boundary in question. */
function wholeWord(src, at, len) {
  const first = src[at];
  const last = src[at + len - 1];
  const before = at > 0 ? src[at - 1] : "";
  const after = at + len < src.length ? src[at + len] : "";
  if (WORD_CHAR.test(first) && before && WORD_CHAR.test(before)) return false;
  if (WORD_CHAR.test(last) && after && WORD_CHAR.test(after)) return false;
  return true;
}

/**
 * Every entity mention in `text`, as non-overlapping `{ start, end, entity }`
 * spans in ASCENDING order — offsets into `text` exactly as given, so a caller
 * can slice the original string to build links without re-finding anything.
 *
 * Overlaps are resolved by claiming the LONGEST name first at a given start, so
 * a project holding both 「林照」 and 「林照母亲」 links the longer one where it
 * really appears. Two names that overlap at DIFFERENT starts are resolved
 * left-to-right; that ambiguity is inherent to prose and the earlier claim is
 * the one a reader sees first.
 */
export function findMentions(index, text) {
  const src = typeof text === "string" ? text : "";
  if (!src || !Array.isArray(index) || !index.length) return [];
  const lower = src.toLowerCase();
  const hits = [];
  for (const e of index) {
    const needle = String(e.name || "").toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      if (wholeWord(src, at, needle.length)) {
        hits.push({ start: at, end: at + needle.length, entity: e });
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let taken = 0;
  for (const h of hits) {
    if (h.start < taken) continue;
    out.push(h);
    taken = h.end;
  }
  return out;
}

/** The text of a shot that may NAME an entity: what the creator wrote about the
 *  picture. Title and description only — 台词 names a speaker constantly
 *  (「林照：…」) and counting that as an appearance would make every off-screen
 *  mention a production requirement. */
export function shotText(shot) {
  if (!isObj(shot)) return "";
  return [shot.title, shot.description].filter((x) => typeof x === "string" && x).join("\n");
}

/**
 * 「准备资产 N/M」 — the REAL number behind 「我还差什么才能开始生成」.
 *
 *   M  distinct entities the shot list NAMES
 *   N  …of those, the ones that already have a usable reference image
 *
 * `hasReferenceImage(kind, id)` answers the second half; pass
 * `ui/storyboard.js buildPortraitIndex(pd)` so 「有参考图」 means exactly what the
 * bible cards mean by it, rather than a second opinion about the same assets.
 *
 * NOTE ON SCOPE — this counts over the SHOT LIST it is given, and both call
 * sites (the storyboard table header and the three-step wizard's step ②) pass
 * `pd.draftShots`, the project-level draft. Two surfaces answering the same
 * question with different numbers is worse than either number alone, so the
 * input is pinned rather than each caller choosing its own (TASK-078 §2.3.3).
 */
export function assetReadiness({ index, shots, hasReferenceImage } = {}) {
  const has = typeof hasReferenceImage === "function" ? hasReferenceImage : () => false;
  const idx = Array.isArray(index) ? index : [];
  const byId = new Map();
  for (const s of Array.isArray(shots) ? shots : []) {
    for (const m of findMentions(idx, shotText(s))) {
      const key = `${m.entity.kind}:${m.entity.id}`;
      if (!byId.has(key)) {
        byId.set(key, { ...m.entity, shotIds: [], ready: !!has(m.entity.kind, m.entity.id) });
      }
      const row = byId.get(key);
      const shotId = isObj(s) && typeof s.shotId === "string" ? s.shotId : null;
      if (shotId && !row.shotIds.includes(shotId)) row.shotIds.push(shotId);
    }
  }
  const entities = [...byId.values()].sort(
    (a, b) => b.shotIds.length - a.shotIds.length || a.name.localeCompare(b.name),
  );
  return {
    entities,
    total: entities.length,
    ready: entities.filter((e) => e.ready).length,
    missing: entities.filter((e) => !e.ready),
  };
}
