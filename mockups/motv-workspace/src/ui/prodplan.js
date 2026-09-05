// Production Plan — the AI Director's view of where the episode actually
// stands, DERIVED at read time from the existing domain documents.
//
// OWNERSHIP: nothing here is persisted and nothing is cached. Every number is
// recomputed from the same snapshot the workspaces render from (script doc,
// production document, Asset Registry, Generation Registry, timelines), so the
// plan can never drift from — or become a second copy of — production state.
//
// HONESTY: a stage is only ✓ when the domain says so. A blocker names the ONE
// concrete thing that is missing plus where to fix it; it is never inferred
// from a heuristic and never invented to fill the panel.
//
// Pure functions over `pd` (ctx.prodData()) — no DOM, no clock, no writes.
import { storyboardModel } from "./storyboard.js";
import { activeEpisode, sceneOfShot } from "../workflow/proddoc.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "../workflow/bibledoc.js";
import { timelineFor } from "../workflow/timeline.js";

/** Stage states, in the order the panel prints them. */
export const STAGE_ORDER = ["script", "bible", "shots", "frames", "video", "audio", "edit", "final"];

const STAGE_LABEL = {
  script: "剧本", bible: "设定同步", shots: "分镜", frames: "画面",
  video: "视频", audio: "音频", edit: "剪辑", final: "成片",
};

/** Where each stage's work is actually done — the panel's jump targets. */
const STAGE_GOTO = {
  script: "script", bible: "settings", shots: "shots", frames: "frames",
  video: "video", audio: "audio", edit: "edit", final: "edit",
};

const mark = (state) => (state === "done" ? "✓" : state === "active" ? "●" : "○");

/** Shots this EPISODE owns — i.e. referenced by one of ITS scenes.
 *
 *  The unassigned pool is deliberately NOT included: a shot that belongs to no
 *  scene belongs to no episode, so counting it here would credit the same work
 *  to every episode at once and inflate each one's progress. The pool is a
 *  separate signal (see `unassignedShots`) that the plan reports on its own. */
export function episodeShots(pd) {
  const m = storyboardModel(pd);
  const audioMap = (pd.media && pd.media.audio) || {};
  const byId = new Map((pd.draftShots || []).filter((x) => x && x.shotId).map((x) => [x.shotId, x]));
  const stamp = (s, scene) => {
    const raw = byId.get(s.shotId) || {};
    // Only a shot that HAS a line needs a dialogue take. A silent shot is not
    // "missing audio" — counting it as incomplete would make the audio stage
    // unreachable and freeze every stage after it.
    const needsDialogue = !!String(raw.dialogue || "").trim();
    return {
      ...s,
      sceneId: scene ? scene.sceneId : null,
      sceneTitle: scene ? scene.title : null,
      refs: scene ? scene.refs : null,
      dialogue: raw.dialogue || "",
      needsDialogue,
      audioReady: !!(s.slot && audioMap[`voice-${s.slot}`]),
    };
  };
  return m.scenes.flatMap((sc) =>
    sc.shots.filter((s) => s.shotId && !s.dangling).map((s) => stamp(s, sc)),
  );
}

/** Draft shots owned by no scene in any episode — real, workable inventory
 *  that simply has no episode yet. Reported, never counted as an episode's. */
export function unassignedShots(pd) {
  return storyboardModel(pd).unassigned.filter((s) => s.shotId);
}

/** Per-episode completion for the media stages. Shared with the left rail so
 *  the rail badge and the plan row can never disagree. */
export function episodeStageCounts(pd) {
  const shots = episodeShots(pd);
  const has = (fn) => shots.filter(fn).length;
  // the audio stage is measured against the shots that actually have a LINE
  const speaking = shots.filter((s) => s.needsDialogue);
  return {
    total: shots.length,
    frames: has((s) => s.thumb),
    video: has((s) => s.hasVideo),
    audio: speaking.filter((s) => s.audioReady).length,
    audioTotal: speaking.length,
  };
}

/** Blockers for ONE shot: the concrete, domain-provable reasons it cannot be
 *  generated yet. Ordered most-fundamental first; the first one is the one the
 *  panel shows. Never a guess — each maps to a field that is genuinely empty. */
export function shotBlockers(pd, shot) {
  const prod = pd.production;
  const out = [];
  // read the scene's OWN reference records (they carry the stateId); the
  // display-only `refs` view does not, and resolving against the base entity
  // would ignore a state-specific reference image and block a valid shot
  const owner = prod && shot.shotId ? sceneOfShot(prod, shot.shotId) : null;
  if (!shot.sceneId || !owner) {
    out.push({ code: "no-scene", text: "未归入场景", fix: "episodes", fixLabel: "去剧集归组" });
    return out;
  }
  const scene = owner.scene;
  const locRef = scene.locationRef;
  if (!locRef) {
    out.push({ code: "no-location", text: "所属场景未设定场景地", fix: "episodes", fixLabel: "设定场景地" });
  } else {
    const l = findLocation(prod, locRef.locationId);
    if (!l) {
      // the scene still points at a location that no longer exists — the
      // prompt cannot resolve, so this is a blocker, not a silent pass
      out.push({ code: "dangling-location", text: "所属场景引用的场景地已不存在", fix: "settings", fixLabel: "去作品设定修复引用" });
    } else {
      const rl = resolveLocation(l, locRef.stateId ?? null);
      if (!rl.referenceAssetIds || !rl.referenceAssetIds.length) {
        out.push({ code: "no-location-ref", text: `场景地「${rl.name}」缺少参考图`, fix: "settings", fixLabel: "去作品设定补参考图" });
      }
    }
  }
  const charRefs = scene.characterRefs || [];
  if (!charRefs.length) {
    out.push({ code: "no-characters", text: "所属场景未设定出场角色", fix: "episodes", fixLabel: "设定出场角色" });
  } else {
    for (const r of charRefs) {
      const ch = findCharacter(prod, r.characterId);
      if (!ch) {
        // same rule as the location above: a reference that cannot resolve is
        // an inconsistency the Director must report, never skip
        out.push({ code: "dangling-character", text: "所属场景引用的角色已不存在", fix: "settings", fixLabel: "去作品设定修复引用" });
        continue;
      }
      const rc = resolveCharacter(ch, r.stateId ?? null);
      if (!rc.referenceAssetIds || !rc.referenceAssetIds.length) {
        out.push({
          code: "no-character-ref",
          text: `角色「${rc.name}」缺少参考图`,
          fix: "settings",
          fixLabel: "去作品设定补参考图",
        });
      }
    }
  }
  if (!(shot.description || "").trim()) {
    out.push({ code: "no-description", text: "画面内容为空", fix: "shots", fixLabel: "去分镜补写" });
  }
  return out;
}

/** Finals PROVABLY belonging to this episode.
 *
 *  The registry's finals list is project-wide and a final record carries no
 *  episode of its own, so `finals.length` would mark every episode complete as
 *  soon as any one of them rendered. The M11 render does record the episode —
 *  on its `render` Generation (`parameters.episodeId`) — so that link is the
 *  only honest source. A single-episode project is unambiguous by construction
 *  and counts directly; anything else we cannot prove stays uncounted rather
 *  than claiming a finished episode. */
export function episodeFinals(pd, ep) {
  const reg = pd.assets;
  // ONLY EXPORTED FINALS (TASK-074 §1.7). `reg.finals` is the finals **域**, and it
  // now holds candidates too — counting those would light the pipeline's 成片 段 as
  // 完成 the moment a candidate exists, which is the exact claim this slice removes:
  // 合成完 ≠ 成片。
  // 撤回（归档）过的那一版也不算 —— 与 `assetlib.finals()` 同一个口径。
  const exported = (reg && Array.isArray(reg.finals) ? reg.finals : []).filter(
    (f) => f && f.kind === "final" && typeof f.assetId === "string" && f.storageState !== "archived",
  );
  if (!exported.length || !ep) return 0;
  const episodes = (pd.production && pd.production.episodes) || [];
  if (episodes.length <= 1) return exported.length; // no other episode to confuse it with
  const finalIds = new Set(exported.map((f) => f.assetId));
  let n = 0;
  for (const g of pd.generations || []) {
    if (!g || g.type !== "render") continue;
    const epId = g.parameters && g.parameters.episodeId;
    if (epId !== ep.episodeId) continue;
    if ((g.resultAssetIds || []).some((id) => finalIds.has(id))) n += 1;
  }
  return n;
}

/** The whole plan: stage rows + the single next action + every blocker.
 *  `scriptDoc` is the ACTIVE episode's script document. */
export function productionPlan(pd, scriptDoc) {
  const prod = pd.production;
  const ep = prod ? activeEpisode(prod) : null;
  const epIndex = ep && prod ? prod.episodes.findIndex((e) => e.episodeId === ep.episodeId) : -1;
  const epCode = epIndex >= 0 ? `EP${String(epIndex + 1).padStart(2, "0")}` : "";
  const shots = episodeShots(pd);
  const counts = episodeStageCounts(pd);
  const total = counts.total;
  // removed from the counts, so it must be REPORTED — an unassigned shot is
  // real work that simply has no episode yet
  const loose = unassignedShots(pd).length;

  // --- script -------------------------------------------------------------
  const scriptVersions = scriptDoc ? scriptDoc.versions.length : 0;
  const scriptDraft = !!(scriptDoc && scriptDoc.workingText && scriptDoc.workingText.trim());
  const scriptState = scriptVersions ? "done" : scriptDraft ? "active" : "todo";

  // --- bible sync: does every scene of this episode reference the bible? ---
  const scenes = ep ? ep.scenes : [];
  const wired = scenes.filter((s) => s.locationRef && (s.characterRefs || []).length).length;
  const bibleState = !scenes.length ? "todo" : wired === scenes.length ? "done" : wired ? "active" : "todo";

  // --- storyboard ---------------------------------------------------------
  const shotsState = total ? "done" : "todo";

  // --- media stages -------------------------------------------------------
  const media = (done) => (!total ? "todo" : done === total ? "done" : done ? "active" : "todo");

  // --- edit / final -------------------------------------------------------
  const tl = ep && pd.timelines ? timelineFor(pd.timelines, ep.episodeId) : null;
  const clips = tl && Array.isArray(tl.clips) ? tl.clips.length : 0;
  const editState = !clips ? "todo" : tl.edited ? "done" : "active";
  const finals = episodeFinals(pd, ep);
  const finalState = finals ? "done" : "todo";

  const stages = [
    { key: "script", state: scriptState, detail: scriptVersions ? `v${scriptDoc.active}` : scriptDraft ? "草稿" : "" },
    { key: "bible", state: bibleState, detail: scenes.length ? `${wired}/${scenes.length} 场景已联结` : "" },
    {
      key: "shots",
      state: shotsState,
      detail: (total ? `${total} / ${total}` : "") + (loose ? `${total ? " · " : ""}另有 ${loose} 未归组` : ""),
    },
    { key: "frames", state: media(counts.frames), detail: total ? `${counts.frames} / ${total}` : "" },
    { key: "video", state: media(counts.video), detail: total ? `${counts.video} / ${total}` : "" },
    {
      key: "audio",
      // measured against speaking shots only; no lines at all ⇒ nothing to do
      state: !total ? "todo" : !counts.audioTotal ? "done" : counts.audio === counts.audioTotal ? "done" : counts.audio ? "active" : "todo",
      detail: !total ? "" : counts.audioTotal ? `${counts.audio} / ${counts.audioTotal} 有台词` : "无台词",
    },
    { key: "edit", state: editState, detail: clips ? `${clips} 个片段` : "" },
    { key: "final", state: finalState, detail: finals ? `v${finals}` : "" },
  ].map((s) => ({ ...s, label: STAGE_LABEL[s.key], goto: STAGE_GOTO[s.key], mark: mark(s.state) }));

  // --- blockers across the episode ----------------------------------------
  const blocked = [];
  for (const s of shots) {
    const b = shotBlockers(pd, s);
    if (b.length) blocked.push({ shotId: s.shotId, seq: s.seq, title: s.title, reason: b[0], all: b });
  }

  // --- the ONE next action ------------------------------------------------
  const next = computeNext({ stages, counts, total, shots, blocked, loose });

  return {
    episode: ep ? { episodeId: ep.episodeId, title: ep.title, code: epCode } : null,
    stages,
    counts,
    total,
    unassigned: loose,
    blocked,
    next,
    /** true when nothing is missing, nothing is blocked, and nothing is loose */
    healthy: !blocked.length && !loose && stages.every((s) => s.state === "done"),
  };
}

/** The single most useful thing to do next. Returns null only when the episode
 *  is genuinely finished. Ready/blocked counts are always honest. */
function computeNext({ stages, counts, total, shots, blocked, loose }) {
  const blockedIds = new Set(blocked.map((b) => b.shotId));
  const stage = stages.find((s) => s.state !== "done");
  if (!stage) {
    // the episode itself is complete, but unowned shots are still sitting
    // around — say so instead of reporting "nothing to do"
    return loose
      ? { key: "assign", label: "把未归组镜头归入场景", detail: `还有 ${loose} 个镜头不属于任何一集。`, goto: "episodes", ready: 0, blocked: 0 }
      : null;
  }

  if (stage.key === "script") {
    return { key: "script", label: "写正文", detail: "本集还没有可用的剧本版本。", goto: "script", ready: 0, blocked: 0 };
  }
  if (stage.key === "bible") {
    const n = stages.find((s) => s.key === "bible");
    return { key: "bible", label: "把场景联结到作品设定", detail: `${n.detail} — 未联结的场景无法编译一致的 Prompt。`, goto: "episodes", ready: 0, blocked: 0 };
  }
  if (stage.key === "shots") {
    return { key: "shots", label: "从剧本生成分镜", detail: "本集还没有镜头。", goto: "shots", ready: 0, blocked: 0 };
  }
  if (stage.key === "frames" || stage.key === "video" || stage.key === "audio") {
    const needs = stage.key === "frames"
      ? shots.filter((s) => !s.thumb)
      : stage.key === "video"
        ? shots.filter((s) => !s.hasVideo)
        : shots.filter((s) => s.needsDialogue && !s.audioReady);
    const pending = needs.length;
    const readyList = needs.filter((s) => !blockedIds.has(s.shotId));
    const blockedList = needs.filter((s) => blockedIds.has(s.shotId));
    const noun = stage.key === "frames" ? "画面" : stage.key === "video" ? "视频" : "配音";
    return {
      key: stage.key,
      label: `继续生成${noun}`,
      detail: `还有 ${pending} 个镜头需要${noun}。`,
      goto: stage.goto,
      ready: readyList.length,
      blocked: blockedList.length,
      firstReady: readyList.length ? readyList[0].shotId : null,
      firstBlocked: blockedList.length ? blockedList[0].shotId : null,
    };
  }
  if (stage.key === "edit") {
    return { key: "edit", label: "在时间线上组装本集", detail: "镜头素材已经可以进时间线。", goto: "edit", ready: 0, blocked: 0 };
  }
  return { key: "final", label: "渲染本集成片", detail: "时间线就绪后即可本地渲染。", goto: "edit", ready: 0, blocked: 0, confirm: true };
}
