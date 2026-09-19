// 小说 → 剧集的落地，整步（TASK-155 / REQ-009 判据 5、6）。
//
// 「用它」那一下要做的事全在 `adaptNovel` 里，按顺序、每一步都能单独说不：
//
//   ① 剧集线洁净吗 —— 最多一个默认「第 1 集」，没有场景、没有剧本。改编是给「小说先写
//      出来」的项目用的；往已在制作的剧集线里塞一套新集号会让单元 ↔ 剧集的按位对应错位。
//      判据 5 说的是加法，不是合并。
//   ② 章区间对吗 —— 连续、不重叠、覆盖**所有**已写的章（`checkChapterRanges`）。
//   ③ 规划追加一版（旧版保留，`episodeId` 一律 null —— ADR-0072 决策 1）。
//   ④ 每条规划条目一个剧集实体：洁净的默认第 1 集被**认领**为 EP1（不留一个空的孤儿），
//      其余追加；身份在这里盖上，规划确认指向这一版。
//   ⑤ 正文创作切到剧集、Planned = N、每集一个单元、Brief 写「改编自第 X–Y 章」。
//
// 纯逻辑：文档进、文档出。DOM 侧（`app.js`）只剩三样它才有的东西 —— 某一集有没有剧本文本
//（`hasScriptText`）、上游基线怎么盖（`stamp`）、persist / 重画。

import * as storydoc from "./storydoc.js";
import * as proddoc from "./proddoc.js";
import * as storywork from "./storywork.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** 剧集线洁净吗：没有剧集，或恰好一个未动过的默认「第 1 集」（与 `confirmPlan` 认领
 *  洁净默认集的规则同源）。`hasScriptText(episodeId)` 由调用方给 —— 剧本文档不在这里。 */
export function episodeLineIsPristine(prod, hasScriptText = () => false) {
  const eps = prod && Array.isArray(prod.episodes) ? prod.episodes : [];
  if (!eps.length) return true;
  if (eps.length !== 1) return false;
  const only = eps[0];
  return (
    (only.scenes || []).length === 0
    && only.title === "第 1 集"
    && !hasScriptText(only.episodeId)
  );
}

/**
 * @param work   `story.work`
 * @param story  storydoc（规划版本住这里）
 * @param prod   生产文档（剧集实体住这里）
 * @param episodes 提案里的分集（带 `chapters`）
 * @param at     时间戳
 * @param hasScriptText (episodeId) => boolean
 * @param stamp  (episodeId) => void   给新建 / 认领的剧集盖上游基线，可缺省
 * @returns {{ok: true, version, episodes: number, created, adopted, briefed}|{ok: false, error}}
 */
export function adaptNovel({ work, story, prod, episodes, at, hasScriptText = () => false, stamp = null }) {
  if (!work || !story || !prod) return { ok: false, error: "还没有作品文档" };
  if (!episodeLineIsPristine(prod, hasScriptText)) {
    return {
      ok: false,
      error: "这个项目的剧集线已经有内容了，改编不会覆盖它 —— 在一个新项目里做，或先把已有剧集归档",
    };
  }
  const bad = storywork.checkChapterRanges(work, episodes);
  if (bad) return { ok: false, error: bad };

  const rec = storydoc.addPlanVersion(story, episodes, {
    origin: "adapted",
    instruction: "由小说改编（novel-adapter）",
  });
  if (!rec) return { ok: false, error: "提案里没有一集能落地" };

  // 每条规划条目一个剧集实体。洁净的默认第 1 集被认领为 EP1，其余追加。
  const pristine = prod.episodes.length === 1 ? prod.episodes[0] : null;
  let adopted = 0;
  let created = 0;
  for (const e of rec.episodes) {
    if (pristine && !adopted) {
      adopted = 1;
      e.episodeId = pristine.episodeId;
      if (e.title.trim()) proddoc.renameEpisode(prod, pristine.episodeId, e.title);
    } else {
      const ep = proddoc.addEpisode(prod, e.title);
      e.episodeId = ep.episodeId;
      created += 1;
    }
    if (typeof stamp === "function") stamp(e.episodeId);
  }
  storydoc.confirmPlan(story, rec.v);
  // 第一集是当前集：他接下来要做的就是「写这一集的剧本」
  if (rec.episodes[0] && rec.episodes[0].episodeId) proddoc.setActiveEpisode(prod, rec.episodes[0].episodeId);

  const units = storywork.adoptEpisodesFromNovel(work, rec.episodes, at);
  if (!units.ok) return { ok: false, error: units.error };
  return {
    ok: true,
    version: rec.v,
    episodes: rec.episodes.length,
    created,
    adopted,
    briefed: units.briefed,
  };
}

/** 屏幕上那一句。 */
export function describeAdapt(res) {
  if (!isObj(res) || !res.ok) return "";
  return (
    `已确认剧集规划 v${res.version}：${res.episodes} 集已建立（${res.adopted ? "第 1 集认领了默认那一集，" : ""}新建 ${res.created} 集）；`
    + `正文创作已切到「剧集创作」，${res.briefed} 集写了「改编自第几章」的 Brief；小说的章与版本一字未动`
  );
}
