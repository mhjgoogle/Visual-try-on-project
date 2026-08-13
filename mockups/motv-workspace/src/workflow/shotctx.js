// Shot Context Builder (TASK-067 §3 / §15, ADR-0064 决策 1–4) — the MINIMAL,
// TRACEABLE context a shot-scoped AI capability is allowed to read.
//
//   Project Canon ┐
//   Episode       │
//   Scene         ├─→ buildShotContext() ─→ { shotContext, trace }
//   Shot          │                             │
//   References    │                             ├─ compilePrompt() sees only this
//   Frames        │                             └─ skillrun records the trace
//   Media/Prompts ┘
//
// WHY IT EXISTS. `ctx.skills.context` handed the runtime the WHOLE project: every
// draft shot, every reference, every asset, every generation record, the complete
// timeline and subtitle track. For 「给这一镜写个 Image Prompt」 that is both
// expensive and worse-quality — the answer has to be found inside a haystack the
// model did not need. §15 forbids it, so shot-scoped capabilities read this
// projection instead.
//
// THREE RULES THIS MODULE ENFORCES:
//
//   1. PROJECTION, NEVER COPY. Everything here is derived at read time from the
//      already-resolved domain views (`shotDetailModel`, the bible resolvers, the
//      registry). Nothing is stored, so this can never become a stale second copy
//      of canon.
//   2. TRACEABLE. `trace` names the real ids AND the version/revision of every
//      surface that was read, so a Skill Run can answer 「本次到底读取了什么」 —
//      not just 「读了哪一集」 (ADR-0064 决策 2).
//   3. THE CANDIDATE SET IS DETERMINISTIC. `candidatesFor` retrieves REAL assets
//      out of the registry; a recommender Skill may only pick among them
//      (决策 4). A model therefore cannot invent an `assetId`, and does not need
//      to be shown the library to recommend from it.
//
// Pure — no fetch, no DOM, no clock, no ctx, no writes.

import { REFERENCE_ROLES, ROLE_LABEL, isInterpretationRole } from "./geninput.js";
import { AXIS_KEYS } from "./refinterp.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const s = (x) => (typeof x === "string" ? x.trim() : "");
const arr = (x) => (Array.isArray(x) ? x : []);
const strOrNull = (x) => (s(x) ? s(x) : null);

/* ========================================================================== */
/* 1 · the projection                                                         */
/* ========================================================================== */

/** A neighbour shot's CONTINUITY SUMMARY — not the shot.
 *
 *  A continuity check needs to know what the shot next door established, which is
 *  a handful of facets, not its whole record. Passing the neighbour verbatim would
 *  re-import the haystack this module exists to avoid, and would tempt a Prompt
 *  skill into writing the neighbour's framing into this shot. */
function neighbourSummary(d, endFrameAssetId) {
  if (!isObj(d) || !isObj(d.shot)) return null;
  return {
    shotId: d.shot.shotId,
    sequence: d.shot.seq,
    title: s(d.shot.title) || null,
    description: s(d.shot.description) || null,
    action: s(d.shot.action) || null,
    shotSize: s(d.shot.shotSize) || null,
    angle: s(d.shot.angle) || null,
    cameraMotion: s(d.shot.cameraMotion) || null,
    emotion: s(d.shot.emotion) || null,
    // WHO and WHERE, because that is what continuity is actually about
    characters: arr(d.scene && d.scene.characters).map((c) => ({
      characterId: c.characterId, name: c.name, stateName: c.stateName || null,
    })),
    location: d.scene && d.scene.location
      ? { locationId: d.scene.location.locationId, name: d.scene.location.name, stateName: d.scene.location.stateName || null }
      : null,
    hasSelectedImage: arr(d.images && d.images.list).some((r) => r.current),
    hasSelectedVideo: arr(d.videos && d.videos.list).some((r) => r.current),
    // the ONE thing a neighbour can hand this shot: its last frame
    endFrameAssetId: strOrNull(endFrameAssetId),
  };
}

/** One bound reference, as a capability sees it. `use` and the reading come along
 *  because 「这个参考服务哪一侧、有没有被读过」 changes what a Prompt may say about
 *  it — and an unread directing reference must be visible as unread, never
 *  silently omitted (the same rule promptc.js follows). */
function referenceView(r, use, reading) {
  return {
    referenceKey: r.key,
    assetId: r.assetId || null,
    kind: r.kind,
    role: ROLE_LABEL[r.kind] || r.kind,
    name: s(r.name) || null,
    version: r.version ?? null,
    use: use || null,
    interpreted: !!reading,
    // the READING, not the media: this is the only form in which a directing
    // reference can reach a prompt (ADR-0061 决策 4)
    axes: reading ? { ...reading.axes } : null,
    // `readingVersion`, NOT `version` — on an `interpretationInputs` row, `version`
    // is the REFERENCE's version and `readingVersion` is the reading's. Taking the
    // wrong one made re-reading a reference invisible to `contextRevision`, so a
    // cached conclusion drawn from the OLD words stayed 「fresh」 after the words
    // changed. That is exactly the staleness §15 exists to prevent.
    readingVersion: reading ? reading.readingVersion : null,
    readingLocked: reading ? reading.locked === true : false,
  };
}

/**
 * Build the minimal shot context (§3).
 *
 * Every argument is an ALREADY-RESOLVED view; this module resolves nothing itself,
 * so it cannot disagree with `promptc.js` about what this shot contains.
 *
 * @param detail     `shotDetailModel(pd, shotId)` output
 * @param place      `{ episodeId, episodeCode, episodeTitle, sceneId, sceneTitle }`
 * @param canon      `{ genreTone, worldVisualTone, worldRules, episodePlanNote }`
 * @param refUseOf   `(refKey) => "image" | "video" | "both"` — the effective side
 * @param prompts    `{ image: {version, text, locked}, video: {...} }` current versions
 * @param neighbours `{ prev, next }` — each a `shotDetailModel` output or null
 * @param neighbourFrames `{ prevEndFrameAssetId, nextStartFrameAssetId }`
 * @returns `{ context, trace }`
 */
export function buildShotContext({
  detail,
  place = {},
  canon = {},
  refUseOf = null,
  prompts = {},
  neighbours = {},
  neighbourFrames = {},
} = {}) {
  if (!isObj(detail) || !isObj(detail.shot)) {
    return { context: null, trace: null };
  }
  const d = detail;
  const useOf = typeof refUseOf === "function" ? refUseOf : () => null;
  const readingByKey = new Map(arr(d.refInputs && d.refInputs.interpretation).map((i) => [i.key, i.read ? i : null]));
  const references = arr(d.refInputs && d.refInputs.references)
    .map((r) => referenceView(r, useOf(r.key), readingByKey.get(r.key) || null));

  const selectedImage = arr(d.images && d.images.list).find((r) => r.current) || null;
  const selectedVideo = arr(d.videos && d.videos.list).find((r) => r.current) || null;

  const frame = (f) => (isObj(f)
    ? { assetId: f.assetId || null, version: f.version ?? null, name: s(f.name) || null, from: s(f.from) || null, bound: !!f.binding }
    : null);

  const promptView = (p) => (isObj(p)
    ? { version: p.version ?? null, text: s(p.text) || null, locked: p.locked === true }
    : { version: null, text: null, locked: false });

  const context = {
    // --- PROJECT CANON: the visual direction only, never the whole bible ----- //
    projectCanon: {
      genreTone: strOrNull(canon.genreTone),
      worldVisualTone: strOrNull(canon.worldVisualTone),
      worldRules: strOrNull(canon.worldRules),
    },
    episode: {
      episodeId: strOrNull(place.episodeId),
      code: strOrNull(place.episodeCode),
      title: strOrNull(place.episodeTitle),
      planNote: strOrNull(canon.episodePlanNote),
    },
    scene: {
      sceneId: strOrNull(place.sceneId),
      title: strOrNull(place.sceneTitle),
      characters: arr(d.scene && d.scene.characters).map((c) => ({
        characterId: c.characterId,
        name: c.name,
        // CharacterState is a first-class input (§3): 「同一个人在这一场是什么状态」
        stateName: c.stateName || null,
      })),
      location: d.scene && d.scene.location
        ? {
            locationId: d.scene.location.locationId,
            name: d.scene.location.name,
            stateName: d.scene.location.stateName || null,
          }
        : null,
    },
    shot: {
      shotId: d.shot.shotId,
      sequence: d.shot.seq,
      title: s(d.shot.title) || null,
      description: s(d.shot.description) || null,
      action: s(d.shot.action) || null,
      shotSize: s(d.shot.shotSize) || null,
      angle: s(d.shot.angle) || null,
      cameraMotion: s(d.shot.cameraMotion) || null,
      environmentMotion: strOrNull(d.shot.environmentMotion),
      expression: strOrNull(d.shot.expression),
      emotion: s(d.shot.emotion) || null,
      dialogue: s(d.shot.dialogue) || null,
      durationSeconds: d.shot.duration ?? null,
    },
    references,
    frames: { start: frame(d.frames && d.frames.start), end: frame(d.frames && d.frames.end) },
    // WHAT ALREADY EXISTS. A capability that cannot see the current result would
    // propose work that has been done, or overwrite a take the creator selected.
    media: {
      selectedShotImage: selectedImage
        ? { assetId: selectedImage.assetId || null, version: selectedImage.version, origin: s(selectedImage.origin) || null }
        : null,
      imageVersions: arr(d.images && d.images.list).length,
      selectedShotVideo: selectedVideo
        ? { assetId: selectedVideo.assetId || null, version: selectedVideo.version, origin: s(selectedVideo.origin) || null }
        : null,
      videoVersions: arr(d.videos && d.videos.list).length,
    },
    prompts: { image: promptView(prompts.image), video: promptView(prompts.video) },
    // the DETERMINISTIC gaps the compilers already report, carried verbatim so a
    // capability and the UI cannot disagree about what is missing
    compilerGaps: {
      image: arr(d.prompts && d.prompts.image && d.prompts.image.missing).slice(),
      video: arr(d.prompts && d.prompts.video && d.prompts.video.missing).slice(),
    },
    neighbours: {
      previous: neighbourSummary(neighbours.prev, neighbourFrames.prevEndFrameAssetId),
      next: neighbourSummary(neighbours.next, null),
    },
  };

  return { context, trace: traceOf(context) };
}

/* ========================================================================== */
/* 2 · traceability (决策 2)                                                   */
/* ========================================================================== */

/**
 * WHAT this projection actually read, as ids plus the revision of each surface.
 *
 * This is deliberately NOT a restatement of the context: it is the set of things
 * that, if any one of them changes, make a cached conclusion stale. That is why it
 * is also the basis of `contextRevision` — one derivation, so a cache key can
 * never disagree with what the run reported it read.
 */
export function traceOf(context, { candidateKeys = null } = {}) {
  if (!isObj(context)) return null;
  const refs = arr(context.references);
  return {
    // WHICH candidates the run was allowed to pick from (ADR-0064 决策 4).
    //
    // Recorded because the constraint is 「只能在候选集内挑选」, and an applier with no
    // record of that set can only check 「这个 key 在注册表里存在」 — which lets a
    // recommendation bind any registered asset at all, including another character's
    // portrait. Null when the run was given no candidate set, which is a fact about
    // the run rather than an empty permission list.
    candidateKeys: Array.isArray(candidateKeys) ? candidateKeys.filter((k) => s(k)) : null,
    episodeId: context.episode.episodeId,
    sceneId: context.scene.sceneId,
    shotId: context.shot.shotId,
    // WHICH references, at WHICH version, serving WHICH side, with WHICH reading
    references: refs.map((r) => ({
      referenceKey: r.referenceKey,
      assetId: r.assetId,
      version: r.version,
      use: r.use,
      readingVersion: r.readingVersion,
    })),
    characterIds: arr(context.scene.characters).map((c) => `${c.characterId}${c.stateName ? `/${c.stateName}` : ""}`),
    locationId: context.scene.location
      ? `${context.scene.location.locationId}${context.scene.location.stateName ? `/${context.scene.location.stateName}` : ""}`
      : null,
    startFrameAssetId: context.frames.start ? context.frames.start.assetId : null,
    endFrameAssetId: context.frames.end ? context.frames.end.assetId : null,
    selectedImage: context.media.selectedShotImage
      ? { assetId: context.media.selectedShotImage.assetId, version: context.media.selectedShotImage.version }
      : null,
    selectedVideo: context.media.selectedShotVideo
      ? { assetId: context.media.selectedShotVideo.assetId, version: context.media.selectedShotVideo.version }
      : null,
    promptVersions: { image: context.prompts.image.version, video: context.prompts.video.version },
    neighbourShotIds: {
      previous: context.neighbours.previous ? context.neighbours.previous.shotId : null,
      next: context.neighbours.next ? context.neighbours.next.shotId : null,
    },
    // …and WHAT those neighbours said, as a content fingerprint.
    //
    // Ids alone were not enough: a continuity summary is drawn from the neighbour's
    // description / action / costume-bearing state, so re-writing the previous shot
    // leaves the ids identical and would keep a conclusion about the OLD text marked
    // fresh. Same rule as `shotDesign` below, one shot over.
    neighbourDigest: [context.neighbours.previous, context.neighbours.next]
      .map((n) => (isObj(n)
        ? [
            n.shotId, n.title, n.description, n.action, n.shotSize, n.angle,
            n.cameraMotion, n.emotion, n.endFrameAssetId,
            arr(n.characters).map((c) => `${c.characterId}/${c.stateName || ""}`).join(","),
            n.location ? `${n.location.locationId}/${n.location.stateName || ""}` : "",
            n.hasSelectedImage, n.hasSelectedVideo,
          ].map((x) => (x == null ? "" : String(x))).join("")
        : ""))
      .join(""),
    // …and the CANDIDATE SET a recommendation was drawn from. Registering a new
    // character reference, or removing one, changes what could have been recommended
    // — so a cached recommendation drawn from the old set is stale even though the
    // shot itself did not move (codex review round 2).
    candidateDigest: Array.isArray(candidateKeys) ? candidateKeys.filter((k) => s(k)).join(",") : "",
    // the PROJECT CANON the prompts really compile from. The visual direction changes
    // what an Image Prompt says, so a cached prompt review drawn from the old tone is
    // stale even though nothing about the shot moved.
    canonDigest: [
      context.projectCanon.genreTone, context.projectCanon.worldVisualTone,
      context.projectCanon.worldRules, context.episode.planNote,
      context.episode.code, context.scene.title,
    ].map((x) => (x == null ? "" : String(x))).join(""),
    // the shot's own design, as a content fingerprint: a re-written 画面/动作 must
    // invalidate a cached recommendation even though no id changed
    shotDesign: [
      context.shot.title, context.shot.description, context.shot.action,
      context.shot.shotSize, context.shot.angle, context.shot.cameraMotion,
      context.shot.environmentMotion, context.shot.expression, context.shot.emotion,
      context.shot.dialogue, context.shot.durationSeconds,
    ].map((x) => (x == null ? "" : String(x))).join(""),
  };
}

/**
 * A stable revision string for a trace — the CACHE BASELINE (决策 3).
 *
 * Derived from the trace and nothing else. Deliberately NOT a timestamp: a
 * conclusion is stale because an input changed, not because time passed, and a
 * clock-based key would both re-run work for nothing and miss a real change
 * inside the same tick.
 *
 * `scope` lets one shot hold several independent baselines (a recommendation is
 * stale for different reasons than a continuity summary), without either one
 * having to re-derive which fields it depends on.
 */
export function contextRevision(trace, scope = "all") {
  if (!isObj(trace)) return null;
  const parts = [`scope=${s(scope) || "all"}`];
  const put = (k, v) => parts.push(`${k}=${v == null ? "" : v}`);
  put("shot", trace.shotId);
  put("scene", trace.sceneId);
  put("episode", trace.episodeId);
  put("chars", trace.characterIds.join(","));
  put("loc", trace.locationId);
  put("refs", trace.references.map((r) => `${r.referenceKey}@${r.version}:${r.use || "-"}:${r.readingVersion ?? "-"}`).join(","));
  put("sframe", trace.startFrameAssetId);
  put("eframe", trace.endFrameAssetId);
  put("img", trace.selectedImage ? `${trace.selectedImage.assetId}@${trace.selectedImage.version}` : null);
  put("vid", trace.selectedVideo ? `${trace.selectedVideo.assetId}@${trace.selectedVideo.version}` : null);
  put("pv", `${trace.promptVersions.image ?? "-"}/${trace.promptVersions.video ?? "-"}`);
  put("nb", `${trace.neighbourShotIds.previous || "-"}>${trace.neighbourShotIds.next || "-"}`);
  put("design", fingerprint(trace.shotDesign));
  // the neighbours' CONTENT and the project's visual direction are inputs too — see
  // `neighbourDigest` / `canonDigest`. Hashed rather than carried: they are free text,
  // and ids/versions above are what must stay exact.
  put("nbd", fingerprint(trace.neighbourDigest || ""));
  put("canon", fingerprint(trace.canonDigest || ""));
  // ONLY the recommendation scope depends on the candidate set. Folding it into every
  // revision would make a continuity summary go stale because an unrelated reference
  // was uploaded — churn, not freshness.
  if (s(scope) === "assetRecommendation") put("cand", fingerprint(trace.candidateDigest || ""));
  return parts.join("|");
}

/** A short, stable digest of a text. FNV-1a, because the alternative (carrying the
 *  whole design string in every cache key) makes keys unreadable in the UI and
 *  unbounded in size. A collision costs a wrongly-fresh cache entry, which is why
 *  ids and versions above are carried EXACTLY and only free text is hashed. */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const t = typeof text === "string" ? text : String(text ?? "");
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* ========================================================================== */
/* 3 · readiness — 已有 / 缺少 (§6)                                            */
/* ========================================================================== */

/** The roles this round judges a shot's reference coverage by, and what each one
 *  is FOR. Ordered as the chain runs, so the list reads as the work to do. */
export const READINESS_ROLES = [
  ["character-reference", "人物参考", "image", "跨镜头脸部一致性靠它"],
  ["location-reference", "场景参考", "image", "同一个地点在不同镜头里保持同一个样子"],
  ["style-reference", "风格参考", "image", "整部作品看起来像同一部"],
  ["prop-reference", "道具参考", "image", "关键道具不会每镜换一个"],
  ["camera-reference", "机位参考", "video", "运镜由参考决定，而不是由形容词决定"],
  ["motion-reference", "运动参考", "video", "动起来之后的运动质感"],
  ["performance-reference", "表演参考", "video", "表演强度与节奏"],
  ["video-style-reference", "视频风格参考", "video", "动态影像的整体质感"],
];

/**
 * What this shot HAS and what it is MISSING — derived, never hard-coded (§6).
 *
 * The result is the single source for the AI Director's checklist and for the
 * readiness gate on 「可以生成 Image Prompt 了吗」. Deriving it in one place is why
 * the panel and the capability layer cannot disagree about whether a shot is ready.
 *
 * SEVERITY IS A REAL DISTINCTION:
 *   blocking  the next step genuinely cannot happen (no image ⇒ no Video Prompt)
 *   gap       it will work, but the result will be measurably worse
 *   soft      worth saying once, never worth stopping for
 */
export function shotReadiness(context) {
  if (!isObj(context)) return null;
  const refs = arr(context.references);
  const byRole = new Map();
  for (const r of refs) {
    if (!byRole.has(r.kind)) byRole.set(r.kind, []);
    byRole.get(r.kind).push(r);
  }
  const have = [];
  const missing = [];

  for (const [kind, label, side, why] of READINESS_ROLES) {
    const bound = byRole.get(kind) || [];
    if (bound.length) {
      // a DIRECTING reference that nobody has read contributes nothing yet — it is
      // present as a file and absent as an input, and saying 「✓」 would hide that
      const unread = isInterpretationRole(kind) ? bound.filter((r) => !r.interpreted) : [];
      if (unread.length) {
        missing.push({
          kind, label, side, severity: "gap",
          text: `${label} 已绑定但还没有被解读（${unread.length} 个）——没有解读它就不会进 Prompt`,
          fix: "interpret", refKeys: unread.map((r) => r.referenceKey),
        });
      } else {
        have.push({ kind, label, side, count: bound.length, names: bound.map((r) => r.name).filter(Boolean) });
      }
      continue;
    }
    // ABSENT. Whether that is a gap depends on whether this shot needs it at all.
    if (kind === "character-reference") {
      if (arr(context.scene.characters).length) {
        missing.push({ kind, label, side, severity: "gap", text: `没有${label}——${why}`, fix: "recommend" });
      }
      continue;
    }
    if (kind === "location-reference") {
      if (context.scene.location) {
        missing.push({ kind, label, side, severity: "gap", text: `没有${label}——${why}`, fix: "recommend" });
      }
      continue;
    }
    if (kind === "prop-reference") continue; // a shot with no prop is not missing one
    missing.push({ kind, label, side, severity: "soft", text: `没有${label}——${why}`, fix: "recommend" });
  }

  // --- the chain's own prerequisites -------------------------------------- //
  if (!context.scene.location) {
    missing.push({ kind: "sceneLocation", label: "场景地", side: "image", severity: "blocking",
      text: "这一场还没有设定场景地——Image Prompt 缺一致性锚点", fix: "scene" });
  }
  if (!arr(context.scene.characters).length) {
    missing.push({ kind: "sceneCharacters", label: "出场角色", side: "image", severity: "gap",
      text: "这一场还没有出场角色——Prompt 无法锁住人物一致性", fix: "scene" });
  }
  if (!s(context.shot.description)) {
    missing.push({ kind: "shotDescription", label: "画面内容", side: "image", severity: "blocking",
      text: "镜头的画面内容为空——没有可写的主体", fix: "shot" });
  }
  // START FRAME: a real gap only once there is something to frame FROM
  const prevEnd = context.neighbours.previous && context.neighbours.previous.endFrameAssetId;
  if (!context.frames.start || !context.frames.start.bound) {
    if (prevEnd) {
      missing.push({ kind: "startFrame", label: "Start Frame", side: "video", severity: "gap",
        text: "上一镜有可用的尾帧，但这一镜没有绑定首帧——接上它，人物长相才不会在镜与镜之间漂移",
        fix: "usePreviousShotEndFrame" });
    } else if (context.media.selectedShotImage) {
      missing.push({ kind: "startFrame", label: "Start Frame", side: "video", severity: "soft",
        text: "首帧用的是这一镜自己的画面（没有来自上一镜的连接）", fix: "frames" });
    }
  }
  if (!context.media.selectedShotImage) {
    missing.push({ kind: "selectedShotImage", label: "主帧图", side: "video", severity: "blocking",
      text: "还没有选定的主帧图——Video Prompt 要以它为第 1 帧，所以还不能写",
      fix: "prepareImageGeneration" });
  }

  const blocking = missing.filter((x) => x.severity === "blocking");
  const gaps = missing.filter((x) => x.severity === "gap");
  return {
    have,
    missing,
    blocking,
    gaps,
    soft: missing.filter((x) => x.severity === "soft"),
    // THE TWO GATES the panel and the capability layer both read
    canWriteImagePrompt: !blocking.some((x) => x.side === "image"),
    canWriteVideoPrompt: !blocking.some((x) => x.side === "image" || x.side === "video"),
    // one sentence, derived — 「现在这一镜处于什么状态」
    verdict: verdictOf(context, blocking, gaps),
  };
}

function verdictOf(context, blocking, gaps) {
  const imgBlock = blocking.filter((x) => x.side === "image");
  if (imgBlock.length) return `还不能写 Image Prompt：${imgBlock[0].text}`;
  if (!context.prompts.image.text) {
    return gaps.length
      ? `可以生成 Image Prompt 了（还有 ${gaps.length} 项会让结果更稳）`
      : "可以生成 Image Prompt 了";
  }
  if (!context.media.selectedShotImage) {
    return "Image Prompt 已就绪——到外部工具出图，回来上传，这一镜就能进入视频编排";
  }
  if (!context.prompts.video.text) {
    const vBlock = blocking.filter((x) => x.side === "video");
    if (vBlock.length) return `还不能写 Video Prompt：${vBlock[0].text}`;
    return "已有选定的主帧图——可以生成 Video Prompt 了";
  }
  if (!context.media.selectedShotVideo) {
    return "Video Prompt 已就绪——到外部工具生成视频，回来上传";
  }
  return "这一镜已经有选定的最终视频——剧集制作对它的工作完成了";
}

/* ========================================================================== */
/* 4 · the deterministic candidate set (决策 4)                                */
/* ========================================================================== */

/** Which reference roles a recommendation may target, by the side they serve. */
const CANDIDATE_ROLES = REFERENCE_ROLES.map(([k]) => k);

/**
 * Retrieve REAL candidate references for this shot, out of the registry.
 *
 * This is the half a language model must not do. Every candidate carries a real
 * `referenceKey` and `assetId` read from the registry, together with the EVIDENCE
 * for why it is a candidate at all — 「它 link 到本场出场的人物」 is a fact, not a
 * guess. A recommender Skill then ranks and justifies WITHIN this set; the applier
 * verifies the keys again before anything is bound.
 *
 * @param context     buildShotContext() output
 * @param references  every reference in the registry, resolved to
 *                    `{ key, kind, name, version, assetId, links }`
 * @param opts.limitPerRole  how many candidates per role reach the prompt
 */
export function candidatesFor(context, references, { limitPerRole = 6 } = {}) {
  if (!isObj(context)) return { candidates: [], byRole: {}, bound: [] };
  const boundKeys = new Set(arr(context.references).map((r) => r.referenceKey));
  const charIds = new Set(arr(context.scene.characters).map((c) => c.characterId));
  const charNames = arr(context.scene.characters).map((c) => s(c.name)).filter(Boolean);
  const locId = context.scene.location ? context.scene.location.locationId : null;
  const locName = context.scene.location ? s(context.scene.location.name) : "";

  const out = [];
  for (const r of arr(references)) {
    if (!isObj(r) || !s(r.key) || !CANDIDATE_ROLES.includes(r.kind)) continue;
    if (boundKeys.has(r.key)) continue; // already on this shot — not a recommendation
    const links = isObj(r.links) ? r.links : {};
    const name = s(r.name);
    // EVIDENCE, in descending strength. A candidate with no evidence at all is
    // still offered for the roles that are project-wide by nature (style / camera /
    // motion / performance), and is NOT offered for the roles that are about a
    // specific person or place — 「随便一张人物参考」 is not a recommendation.
    let evidence = null;
    let score = 0;
    if (r.kind === "character-reference") {
      if (links.characterId && charIds.has(links.characterId)) { evidence = "link 到本场出场人物"; score = 100; }
      else if (name && charNames.some((n) => name.includes(n))) { evidence = "名称含本场出场人物"; score = 60; }
    } else if (r.kind === "location-reference") {
      if (links.locationId && locId && links.locationId === locId) { evidence = "link 到本场场景地"; score = 100; }
      else if (name && locName && name.includes(locName)) { evidence = "名称含本场场景地"; score = 60; }
    } else if (r.kind === "prop-reference") {
      const text = `${s(context.shot.description)} ${s(context.shot.action)}`;
      if (name && text.includes(name)) { evidence = "镜头描述里提到了它"; score = 70; }
    } else {
      // project-wide directing / style roles: reusable by construction
      evidence = r.reusable === true ? "标记为可复用的项目级参考" : "项目级参考，可复用";
      score = r.reusable === true ? 50 : 40;
    }
    if (!evidence) continue;
    out.push({
      referenceKey: r.key,
      assetId: r.assetId || null,
      kind: r.kind,
      role: ROLE_LABEL[r.kind] || r.kind,
      name: name || null,
      version: r.version ?? null,
      side: isInterpretationRole(r.kind) ? "video" : "image",
      evidence,
      score,
    });
  }

  out.sort((a, b) => b.score - a.score || String(a.name || "").localeCompare(String(b.name || "")));
  const byRole = {};
  const capped = [];
  for (const c of out) {
    byRole[c.kind] = byRole[c.kind] || [];
    if (byRole[c.kind].length >= limitPerRole) continue;
    byRole[c.kind].push(c);
    capped.push(c);
  }
  return {
    candidates: capped,
    byRole,
    bound: arr(context.references).map((r) => ({ referenceKey: r.referenceKey, kind: r.kind, name: r.name })),
    // HONEST TRUNCATION: a capped set must say it was capped, or the recommender
    // will report 「已经看过全部候选」 about a set that was cut
    truncated: out.length > capped.length ? out.length - capped.length : 0,
  };
}

/* ========================================================================== */
/* 5 · what a capability is handed                                            */
/* ========================================================================== */

/** The axes a recommendation / review answer may talk about, echoed into the
 *  prompt so a model does not invent a seventh. */
export const INTERPRETATION_AXES = AXIS_KEYS.slice();

/**
 * A one-line human summary of a shot context — `inputSummary` on the Skill Run.
 *
 * Short on purpose: it is what a person reads in a run list. The machine-readable
 * answer to 「读了什么」 is `trace`, not this.
 */
export function summarize(context) {
  if (!isObj(context)) return null;
  const bits = [];
  if (context.episode.code) bits.push(context.episode.code);
  if (context.scene.title) bits.push(context.scene.title);
  if (context.shot.sequence != null) bits.push(`SH${String(context.shot.sequence).padStart(2, "0")}`);
  const refs = arr(context.references).length;
  bits.push(`${refs} 个参考`);
  if (context.media.selectedShotImage) bits.push(`主帧图 v${context.media.selectedShotImage.version}`);
  if (context.media.selectedShotVideo) bits.push(`视频 v${context.media.selectedShotVideo.version}`);
  return bits.join(" · ");
}
