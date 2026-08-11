// 分镜工作区 (M8) — the creator-facing Storyboard / Shot workspace:
// scene rail → shot cards → selected-shot detail (creative facets + scene's
// character/location context) → the shot's media area (image/video variants,
// first frame, voice standing, per-shot generation lineage).
//
// STRICT view over existing domains: shots live on the scriptgen draft
// (edits save as a NEW immutable version via ctx.shots.saveEdit), structure
// on the M6 production document, bible on M7, media on the M3 Asset
// Registry, provenance on the M5 Generation Registry. No state is duplicated
// here; transient UI state (selection, edit buffer) belongs to the shell.
import { esc } from "../util/dom.js";
import { head, empty } from "./shell.js";
import {
  nn, renderSceneStrip, renderShotList, renderHero, renderVariantGrid,
  renderVariantTabs, renderRefCards, renderLineage, renderShotMeta, videoSourceFrame, curVideoVersion,
} from "./studioparts.js";
import { slotEntry } from "../workflow/mediaref.js";
import { buildShotSlotIndex, slotForShotId, buildServerBridge, serverShotIdForShot } from "../workflow/shotmap.js";
import { episodeView, sceneOfShot, activeEpisode } from "../workflow/proddoc.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "../workflow/bibledoc.js";
import { outlineForPlan } from "../workflow/storydoc.js";
import { compileImagePrompt, compileVideoPrompt } from "../workflow/promptc.js";


const ORIGIN_ZH = {
  upload: "手工上传", "paid-image": "付费生成", "paid-video": "付费生成",
  adopted: "付费入槽", tts: "本地 TTS", compose: "本地合成",
};

// ---------- pure view-models --------------------------------------------- //

/** A scene's bible references resolved for display (name + state name). */
function sceneRefsView(prod, scene) {
  const characters = (scene.characterRefs || []).map((r) => {
    const c = findCharacter(prod, r.characterId);
    const rc = c ? resolveCharacter(c, r.stateId) : null;
    return {
      characterId: r.characterId,
      name: rc ? rc.name : r.characterId,
      stateName: rc ? rc.stateName : null,
    };
  });
  const lr = scene.locationRef;
  const l = lr && findLocation(prod, lr.locationId);
  const rl = l ? resolveLocation(l, lr.stateId) : null;
  return {
    characters,
    location: lr
      ? { locationId: lr.locationId, name: rl ? rl.name : lr.locationId, stateName: rl ? rl.stateName : null }
      : null,
  };
}

/** One shot card: identity + creative summary + media standing. */
function shotCard(pd, idx, s) {
  const shotId = typeof s.shotId === "string" && s.shotId ? s.shotId : null;
  const slot = shotId ? slotForShotId(idx, s.shotId) : s.slot || null;
  const unresolved = !!(shotId && !slotForShotId(idx, s.shotId) && s.slot);
  const img = slot ? slotEntry(pd.assetUploads, slot) : null;
  const vid = slot ? slotEntry(pd.media.video, slot) : null;
  const cur = (e) => (e ? e.history.find((r) => r.version === e.current) || e.history[e.history.length - 1] : null);
  const imgRef = cur(img);
  const vidRef = cur(vid);
  return {
    shotId,
    seq: s.sequence,
    title: s.title || "",
    description: s.description || "",
    duration: s.duration_seconds ?? null,
    slot,
    unresolved,
    thumb: imgRef ? imgRef.url : "",
    hasVideo: !!vidRef,
  };
}

/** The Storyboard board: the ACTIVE episode's scenes (resolved via canonical
 *  creativeShotId), the unassigned pool, and draft standing. */
export function storyboardModel(pd) {
  const prod = pd.production;
  const draft = pd.draftShots || [];
  const idx = buildShotSlotIndex(draft);
  const ep = prod ? activeEpisode(prod) : null;
  const view = prod && ep ? episodeView(prod, ep.episodeId, draft) : null;
  const cardByShotId = new Map();
  for (const s of draft) {
    const c = shotCard(pd, idx, s);
    if (c.shotId) cardByShotId.set(c.shotId, c);
  }
  const scenes = view
    ? view.scenes.map((sc) => ({
        sceneId: sc.sceneId,
        title: sc.title,
        refs: sceneRefsView(prod, ep.scenes.find((x) => x.sceneId === sc.sceneId) || {}),
        shots: sc.shots.map((x) =>
          x.shot && cardByShotId.has(x.shotId)
            ? cardByShotId.get(x.shotId)
            : { shotId: x.shotId, dangling: true, title: x.shotId, seq: null, thumb: "", hasVideo: false }),
      }))
    : [];
  const unassigned = view ? view.unassigned.map((s) => shotCard(pd, idx, s)) : [];
  // Shots this EPISODE owns — referenced by one of ITS scenes. The draft is
  // project-level (it lives on the scriptgen node) and the unassigned pool
  // belongs to no episode at all, so neither `draft.length` nor the pool may
  // be counted here: both would credit the same work to every episode.
  const episodeShotIds = [];
  for (const sc of scenes) {
    for (const x of sc.shots) if (x.shotId && !x.dangling) episodeShotIds.push(x.shotId);
  }
  const episodeTotal = episodeShotIds.length;
  return {
    hasDraft: draft.length > 0,
    episodeShotIds,
    episodeTotal,
    episodeEmpty: episodeTotal === 0,
    generating: pd.shotVersions ? pd.shotVersions.state === "gen" : false,
    episode: ep ? { episodeId: ep.episodeId, title: ep.title } : null,
    lock: pd.lockedPlan ? { planVersion: pd.lockedPlan.plan_version } : null,
    versions: pd.shotVersions ? { count: pd.shotVersions.count, cur: pd.shotVersions.cur } : null,
    scenes,
    unassigned,
    unassignableCount: view ? view.unassignable.length : 0,
    total: draft.length,
  };
}

/** The shot's FULLY-RESOLVED creative context for prompt compilation (M10):
 *  the scene's characters/location resolved through their states, plus the
 *  outline tone (the CONFIRMED plan's launch outline, honest fallback). */
function promptInputs(pd, shotId) {
  const prod = pd.production;
  const owner = prod ? sceneOfShot(prod, shotId) : null;
  const characters = [];
  let location = null;
  if (owner) {
    for (const r of owner.scene.characterRefs || []) {
      const c = findCharacter(prod, r.characterId);
      if (c) characters.push(resolveCharacter(c, r.stateId));
    }
    const lr = owner.scene.locationRef;
    const l = lr && findLocation(prod, lr.locationId);
    if (l) location = resolveLocation(l, lr.stateId);
  }
  let tone = "";
  const story = pd.story;
  if (story) {
    const plan = story.plans.find((x) => x.v === story.confirmedPlan) || null;
    const o = outlineForPlan(story, plan);
    tone = o ? o.outline.genreTone : "";
  }
  return { characters, location, tone };
}

/** Everything the detail panel needs for ONE selected shot: creative fields,
 *  its scene's bible context, its media variants (image/video), first-frame
 *  lineage, voice standing, paid-op status and per-shot generations. */
export function shotDetailModel(pd, shotId) {
  const draft = pd.draftShots || [];
  const s = draft.find((x) => x && x.shotId === shotId);
  if (!s) return null;
  const idx = buildShotSlotIndex(draft);
  const slot = slotForShotId(idx, shotId) || null;
  const variants = (map) => {
    const e = slot ? slotEntry(map, slot) : null;
    if (!e) return { list: [], current: 0 };
    return {
      current: e.current,
      list: e.history.map((r) => ({
        version: r.version,
        url: r.url,
        origin: ORIGIN_ZH[r.origin] || r.origin || "",
        current: r.version === e.current,
        assetId: r.assetId || null,
      })),
    };
  };
  const prod = pd.production;
  const owner = prod ? sceneOfShot(prod, shotId) : null;
  const ff = slot ? pd.firstFrames[slot] : null;
  const voiceE = slot ? slotEntry(pd.media.audio, `voice-${slot}`) : null;
  const voiceCur = voiceE ? voiceE.history.find((r) => r.version === voiceE.current) : null;
  const lockedShots = pd.lockedPlan && pd.lockedPlan.shots;
  const bridge = buildServerBridge(lockedShots);
  const { id: sid, unresolved: opUnresolved } = serverShotIdForShot(bridge, lockedShots, s);
  const op = sid ? (pd.paidOps || {})[sid] || null : null;
  const gens = (pd.generations || [])
    .filter((g) => g && g.targetId === shotId)
    .map((g) => ({
      generationId: g.generationId,
      type: g.type,
      status: g.status,
      createdAt: g.createdAt,
      provider: g.provider,
    }))
    .reverse(); // registry is append-only → newest first
  const images = variants(pd.assetUploads);
  const videos = variants(pd.media.video);
  // The source image of EACH video version, from the Generation that produced
  // that version. `firstFrames[slot]` is slot-level and overwritten, so it
  // describes only the newest take — using it for every version would show an
  // older video as having come from an image that did not exist yet.
  const imageByAssetId = new Map(images.list.filter((r) => r.assetId).map((r) => [r.assetId, r]));
  const videoSources = {};
  for (const v of videos.list) {
    let src = null;
    if (v.assetId) {
      const gen = (pd.generations || []).find(
        (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(v.assetId),
      );
      const inputId = gen && Array.isArray(gen.inputAssetIds) ? gen.inputAssetIds[0] : null;
      const img = inputId ? imageByAssetId.get(inputId) : null;
      if (img) src = { version: img.version, origin: img.origin, url: img.url, proven: true };
    }
    videoSources[v.version] = src;
  }
  const ctxIn = promptInputs(pd, shotId);
  return {
    // M10: compiled generation prompts + honest gaps
    prompts: {
      image: compileImagePrompt({ shot: s, ...ctxIn }),
      video: compileVideoPrompt({ shot: s, hasImage: images.list.some((r) => r.current) }),
    },
    shot: {
      shotId,
      seq: s.sequence,
      title: s.title || "",
      description: s.description || "",
      action: s.action || "",
      cameraMotion: s.cameraMotion || "",
      dialogue: s.dialogue || "",
      duration: s.duration_seconds === 10 ? 10 : 6,
      // Directing facets the storyboard shows as compact metadata. They are
      // additive draft-shot fields (like action/cameraMotion before them) and
      // are honestly blank when the draft never carried them.
      shotSize: s.shotSize || "",
      angle: s.angle || "",
      emotion: s.emotion || "",
    },
    scene: owner
      ? { sceneId: owner.scene.sceneId, title: owner.scene.title, ...sceneRefsView(prod, owner.scene) }
      : null,
    slot,
    images,
    videos,
    videoSources,
    firstFrame: ff ? { version: ff.version, origin: ORIGIN_ZH[ff.origin] || ff.origin || "", url: ff.url } : null,
    voice: voiceCur
      ? { url: voiceCur.url, versions: voiceE.history.length, origin: ORIGIN_ZH[voiceCur.origin] || voiceCur.origin || "" }
      : null,
    opStatus: op ? op.status : null,
    opUnresolved,
    generations: gens,
  };
}

/** The shot a shot-centric workspace should open on when nothing is selected
 *  yet (or the previous selection left the draft): the active episode's first
 *  resolvable shot, else the first unassigned one, else null. Keeps the centre
 *  column showing real production context instead of a blank panel. */
export function defaultShotId(pd) {
  const m = storyboardModel(pd);
  if (m.episodeShotIds.length) return m.episodeShotIds[0];
  // A project whose shots are all still unassigned has REAL inventory and no
  // episode owning any of it. Returning null here left the shot workspaces with
  // nothing selected and no way to reach that inventory at all, which is the
  // blank centre column this function exists to avoid. An unassigned shot is
  // never credited to the episode — it is only made reachable.
  const free = m.unassigned.find((s) => s.shotId && !s.dangling);
  return free ? free.shotId : null;
}

/** Is `shotId` owned by the ACTIVE episode? Selection must be validated
 *  against this, not against the project-wide draft: a shot from the previous
 *  episode still exists in the draft, so a draft-wide check would leave it
 *  selected after an episode switch and show its media under the new one. */
export function isEpisodeShot(pd, shotId) {
  return !!shotId && storyboardModel(pd).episodeShotIds.includes(shotId);
}

/** Can the shell KEEP this selection?
 *
 *  Broader than `isEpisodeShot` on purpose: the shot list also renders the
 *  UNASSIGNED pool as selectable cards, and those shots belong to no episode at
 *  all, so validating selection against episode ownership alone snapped the
 *  selection back the instant one was clicked — their detail and media were
 *  unreachable. A shot owned by ANOTHER episode is still rejected, which is the
 *  case the episode-scoped check exists for. */
export function isSelectableShot(pd, shotId) {
  if (!shotId) return false;
  const m = storyboardModel(pd);
  return m.episodeShotIds.includes(shotId) || m.unassigned.some((s) => s.shotId === shotId);
}

/** Portrait lookup: a bible entity's ACTIVE reference image url, or "" when it
 *  has none. Reference-only — resolves ids against the M3 registry, never
 *  copies or invents an image. */
export function buildPortraitIndex(pd) {
  const byAsset = new Map();
  for (const slot of Object.keys(pd.assetUploads || {})) {
    const e = slotEntry(pd.assetUploads, slot);
    if (!e) continue;
    for (const r of e.history) if (r && r.assetId) byAsset.set(r.assetId, r.url || "");
  }
  const out = new Map();
  const prod = pd.production;
  const add = (id, activeId, list) => {
    const pick = activeId && byAsset.has(activeId) ? activeId : (list || []).find((a) => byAsset.has(a));
    out.set(id, pick ? byAsset.get(pick) : "");
  };
  for (const c of (prod && prod.characters) || []) add(c.characterId, c.activeReferenceAssetId, c.referenceAssetIds);
  for (const l of (prod && prod.locations) || []) add(l.locationId, l.activeReferenceAssetId, l.referenceAssetIds);
  return (kind, id) => out.get(id) || "";
}

/// ---------- render --------------------------------------------------------- //

/** Selected-shot detail: the media-first surface. A large hero of the shot's
 *  CURRENT frame, compact directing metadata beneath it, the variant gallery
 *  with visible provenance, and the scene's character/location references as
 *  pictures. The editable form lives behind an explicit 编辑 toggle so the
 *  default view reads as a shot, not a database row. */
function detailHtml(ctx, d, ui) {
  const buf = ui.buffer || {};
  const val = (key, committed) => (key in buf ? buf[key] : committed);
  const tab = ui.variantTab || "image";

  const curImg = d.images.list.find((r) => r.current);
  const curVid = d.videos.list.find((r) => r.current);
  const showVideo = tab === "video" && curVid;
  const op = d.opStatus
    ? d.opStatus === "committed" ? `<span class="chip ok">✓ 已付费</span>` : `<span class="chip gen">⏳ ${esc(d.opStatus)}</span>`
    : d.opUnresolved ? `<span class="chip gate">付费状态未解析</span>` : "";

  const hero = renderHero({
    url: showVideo ? curVid.url : curImg ? curImg.url : "",
    kind: showVideo ? "video" : "image",
    // a video is only ever shown over its RECORDED first frame
    poster: videoSourceFrame(d, curVideoVersion(d)),
    title: `${nn(d.shot.seq)} ${d.shot.title}`,
    badges: [
      `<span class="chip solid">${esc(nn(d.shot.seq))}</span>`,
      d.shot.shotSize ? `<span class="chip">${esc(d.shot.shotSize)}</span>` : "",
      `<span class="chip">${d.shot.duration}s</span>`,
    ].filter(Boolean),
    right: [
      showVideo
        ? `<span class="chip ok">Video v${curVid.version}</span>`
        : curImg ? `<span class="chip ok">Image v${curImg.version}</span>` : "",
      op,
    ].filter(Boolean),
    missing: "这个镜头还没有画面 — 用右侧 AI 导演生成或导入",
  });

  // variant gallery — a video card shows the shot's own current image as its
  // frame (that IS the recorded first frame), never a fabricated still
  const counts = { image: d.images.list.length, video: d.videos.list.length, audio: d.voice ? d.voice.versions : 0 };
  let panel;
  if (tab === "image") {
    panel = renderVariantGrid("image", d.slot, d.images, null) +
      (curImg ? `<div class="row"><button class="btn sm" data-useff="${esc(d.slot || "")}">🎬 用作视频首帧</button></div>` : "");
  } else if (tab === "video") {
    panel = renderVariantGrid("video", d.slot, d.videos, (r) => videoSourceFrame(d, r.version));
  } else if (tab === "audio") {
    panel = d.voice
      ? `<div class="row"><span class="chip ok">🎤 配音就绪 · ${d.voice.versions} 版 · ${esc(d.voice.origin)}</span>` +
        `<button class="btn sm" data-goto="audio">在「音频」编辑 →</button></div>` +
        `<audio class="aaud" src="${esc(d.voice.url)}" controls preload="none"></audio>`
      : `<div class="meta">还没有配音 — 到「音频」工作区用本地 TTS 生成，或导入。</div>` +
        `<div class="row"><button class="btn sm" data-goto="audio">→ 去音频工作区</button></div>`;
  } else {
    panel = d.generations.length
      ? `<div class="stack" style="gap:var(--s1)">` + d.generations.slice(0, 8)
          .map((g) => `<div class="dir-hrow"><span class="l">${esc(g.type)} · ${esc(g.provider || "—")}</span>` +
            `<span class="chip${g.status === "success" ? " ok" : g.status === "failed" ? " bad" : " gen"}">${esc(g.status)}</span>` +
            `<span class="t">${g.createdAt ? esc(g.createdAt.slice(0, 16).replace("T", " ")) : ""}</span></div>`)
          .join("") + `</div>`
      : `<div class="meta">这个镜头还没有生成记录。</div>`;
  }

  const editor = ui.shotEdit
    ? `<div class="card pad"><div class="st-sec"><h3>编辑镜头</h3><div class="acts">` +
      `<button class="btn primary sm" data-shot-save>保存为新草稿版本</button>` +
      `<button class="btn sm" data-shot-editoff>取消</button></div></div>` +
      `<div class="editgrid">` +
      `<div class="kv full"><label class="lab">镜头名</label><input class="field" data-sf="title" maxlength="80" value="${esc(val("title", d.shot.title))}"></div>` +
      `<div class="kv full"><label class="lab">画面内容</label><textarea class="field" rows="3" spellcheck="false" data-sf="description">${esc(val("description", d.shot.description))}</textarea></div>` +
      `<div class="kv"><label class="lab">动作</label><textarea class="field" rows="2" spellcheck="false" data-sf="action" placeholder="例如：她抬手碰了一下纱布，随即放下">${esc(val("action", d.shot.action))}</textarea></div>` +
      `<div class="kv"><label class="lab">运镜</label><textarea class="field" rows="2" spellcheck="false" data-sf="cameraMotion" placeholder="例如：低角度缓慢推近至面部特写">${esc(val("cameraMotion", d.shot.cameraMotion))}</textarea></div>` +
      `<div class="kv"><label class="lab">台词 / 旁白</label><textarea class="field" rows="2" spellcheck="false" data-sf="dialogue" placeholder="例如：「你到底是谁？」">${esc(val("dialogue", d.shot.dialogue))}</textarea></div>` +
      `<div class="kv"><label class="lab">时长</label><select class="field" data-sf="duration">${(() => {
        const dur = "duration" in buf ? +buf.duration : d.shot.duration;
        return `<option value="6"${dur === 10 ? "" : " selected"}>6s</option><option value="10"${dur === 10 ? " selected" : ""}>10s</option>`;
      })()}</select></div>` +
      `</div></div>`
    : "";

  return (
    `<div class="stack">` +
    hero +
    renderLineage(d) +
    // the shot's name already reads off the hero — this row is the actions
    `<div class="st-sec"><h3>镜头信息</h3><div class="acts">` +
    (ui.shotEdit ? "" : `<button class="btn sm" data-shot-editon>✎ 编辑镜头</button>`) +
    `</div></div>` +
    editor +
    renderShotMeta(d.shot) +
    `<div class="variants">${renderVariantTabs(tab, counts)}` +
    (d.slot ? panel : `<div class="meta">镜头身份未解析 — 无法定位媒体槽位。</div>`) +
    `</div></div>`
  );
}

/** The whole Storyboard workspace. `ui` is the shell's transient state:
 *  { selectedShotId, variantTab, shotEdit } — selection only, nothing
 *  persisted. */
export function renderStoryboard(ctx, ui) {
  const pd = ctx.prodData();
  const m = storyboardModel(pd);
  if (m.generating) {
    return (
      head("分镜", "生成中") +
      `<div class="st-empty"><div class="ic">⏳</div><div class="tt">Claude 正在生成分镜草稿…</div>` +
      `<div class="hh">通常 20–60 秒，完成后自动出现在这里</div>` +
      `<div class="st-skel" style="width:100%;max-width:520px"><i></i><i></i><i></i><i></i><i></i></div></div>`
    );
  }
  if (!m.hasDraft) {
    const hasScript = ctx.script.hasContent();
    return (
      head("分镜", "还没有分镜") +
      empty(
        "🎬",
        "从剧本生成分镜，开始逐镜头制作",
        hasScript
          ? "剧本已就绪 — 一键让 AI 拆分镜头。草稿可手工改、可重生成，全部版本保留。"
          : "前置：剧本 — 先到「剧本」工作区写下本集内容或用 AI 生成 v1。",
        hasScript
          ? `<button class="btn primary" data-sb-generate>🎬 基于剧本生成分镜</button>`
          : `<button class="btn" data-goto="script">→ 去剧本工作区</button>`,
      )
    );
  }
  // This EPISODE owns no shots AND there is no unassigned inventory either:
  // there is genuinely nothing to list, so say so and point at the fix.
  //
  // When a pool DOES exist the board renders normally instead — those shots are
  // real work, they are already selectable in the list, and hiding them behind
  // an empty state made a project whose shots are all unassigned impossible to
  // inspect from any shot workspace. The header still states plainly that this
  // episode owns none of them.
  if (m.episodeEmpty && !m.unassigned.length) {
    return (
      head(m.episode ? m.episode.title : "分镜", `本集还没有镜头 · 项目草稿共 ${m.total} 个镜头`) +
      empty(
        "🎬",
        "本集还没有镜头",
        "分镜草稿是项目级的，场景与镜头归属是按集的。先在「剧集」为本集建立场景并归入镜头，或基于本集剧本重新生成分镜。",
        `<div class="row"><button class="btn primary" data-goto="episodes">→ 去剧集建立场景</button>` +
          `<button class="btn" data-goto="script">→ 去本集剧本</button></div>`,
      )
    );
  }
  const selected = ui.selectedShotId;
  const portraitFor = buildPortraitIndex(pd);
  // the scene the selection belongs to drives the strip's highlight
  const selScene = m.scenes.find((sc) => sc.shots.some((s) => s.shotId === selected));
  const d = selected ? shotDetailModel(pd, selected) : null;
  const meta = [
    m.versions && m.versions.count ? `草稿 v${m.versions.cur}/${m.versions.count}` : "",
    m.lock ? `🔒 已锁定 plan v${m.lock.planVersion}` : "未锁定",
    `本集 ${m.episodeTotal} 个镜头${m.episodeTotal === m.total ? "" : `（项目共 ${m.total}）`}`,
    // the episode owns nothing yet, but the pool below is real inventory — say
    // which is which rather than letting the list imply these are this episode's
    m.episodeEmpty ? `本集尚未归入任何镜头 · 下方 ${m.unassigned.length} 个未归组` : "",
    m.unassignableCount ? `⚠ ${m.unassignableCount} 个 legacy 镜头无稳定身份` : "",
  ].filter(Boolean).join(" · ");

  const centre = d
    ? detailHtml(ctx, d, ui)
    : empty("🎞", "选一个镜头", "左侧点击任意镜头，这里会显示它的画面、变体与可直接修改的镜头信息。");

  return (
    head(
      m.episode ? m.episode.title : "分镜",
      meta,
      (m.episodeEmpty ? `<button class="btn sm" data-goto="episodes">→ 去剧集归入镜头</button>` : "") +
        `<button class="btn sm" data-sb-generate>↻ 重新生成（新版本）</button>`,
    ) +
    renderSceneStrip(m.scenes, selScene ? selScene.sceneId : null) +
    `<div class="wsplit">` +
    `<div class="listcol">${renderShotList(m.scenes, m.unassigned, selected)}</div>` +
    `<div class="maincol">${centre}</div>` +
    `<div class="refcol">${d ? renderRefCards(d.scene, portraitFor) : ""}</div>` +
    `</div>`
  );
}

/** Wire the storyboard. Field edits buffer locally (no re-render while
 *  typing); ONLY 「保存为新草稿版本」 commits — through ctx.shots.saveEdit,
 *  which appends an immutable draft version.
 *
 *  The generation entry (prompt → provider → import) now lives in the AI
 *  Director and is wired by ui/genentry.js; the shot-level wiring below is
 *  unchanged from before that move. */
export function bindStoryboard(root, ctx, ui, rerender) {
  const gen = root.querySelector("[data-sb-generate]");
  if (gen)
    gen.onclick = () => {
      if (!ctx.script.hasContent()) { ctx.toast("剧本为空：先在「剧本」工作区生成/输入剧本"); return; }
      // regeneration replaces the draft: unsaved edits would strand against
      // shots that no longer exist — same confirm-discard gate as switching
      if (ui.dirty && !window.confirm("镜头详情有未保存的修改，重新生成将丢弃？")) return;
      ui.dirty = false;
      ui.buffer = {};
      ui.selectedShotId = null; // the regenerated draft mints fresh shot ids
      if (!ctx.shots.generateDraft()) ctx.toast("已有一个生成在进行中");
    };
  bindShotSelection(root, ctx, ui, rerender);
  bindShotEditor(root, ctx, ui, rerender);
  bindShotMedia(root, ctx, ui);
}

/** Shot selection — shared by 分镜 / 画面 / 视频 (all three are shot-centric).
 *  Clicking a scene card selects that scene's FIRST shot, which is what makes
 *  the scene strip a navigation control rather than decoration. */
export function bindShotSelection(root, ctx, ui, rerender) {
  const pick = (shotId) => {
    if (!shotId || shotId === ui.selectedShotId) return;
    if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return;
    ui.dirty = false;
    ui.buffer = {};
    ui.shotEdit = false;
    ui.selectedShotId = shotId;
    rerender();
  };
  root.querySelectorAll("[data-shot]").forEach((el) => (el.onclick = () => pick(el.dataset.shot)));
  root.querySelectorAll("[data-scene]").forEach((el) => (el.onclick = () => {
    const m = storyboardModel(ctx.prodData());
    const sc = m.scenes.find((x) => x.sceneId === el.dataset.scene);
    const first = sc && sc.shots.find((s) => s.shotId && !s.dangling);
    if (first) pick(first.shotId);
  }));
  root.querySelectorAll("[data-vtab]").forEach((el) => (el.onclick = () => {
    ui.variantTab = el.dataset.vtab;
    rerender();
  }));
}

/** The buffered shot-detail editor: edits stay local until 保存, which appends
 *  ONE new immutable draft version. */
export function bindShotEditor(root, ctx, ui, rerender) {
  const on = (sel, fn) => {
    const el = root.querySelector(sel);
    if (el) el.onclick = fn;
  };
  on("[data-shot-editon]", () => { ui.shotEdit = true; rerender(); });
  on("[data-shot-editoff]", () => { ui.shotEdit = false; ui.dirty = false; ui.buffer = {}; rerender(); });
  // the buffer lives on the SHELL's ui state (not this binding closure), so a
  // re-render — media variant switch, generation completion — re-renders the
  // buffered values instead of discarding unsaved edits
  const buffer = ui.buffer || (ui.buffer = {});
  root.querySelectorAll("[data-sf]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; };
    if (el.tagName === "SELECT") el.onchange = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; };
  });
  on("[data-shot-save]", () => {
    const draft = ctx.prodData().draftShots || [];
    const before = draft.find((s) => s && s.shotId === ui.selectedShotId);
    const items = draft.map((s) => {
      if (!s || s.shotId !== ui.selectedShotId) return { ...s };
      const n = { ...s };
      for (const k of ["title", "description", "action", "cameraMotion", "dialogue"]) {
        if (k in buffer) n[k] = buffer[k];
      }
      if ("duration" in buffer) n.duration_seconds = +buffer.duration;
      return n;
    });
    if (!items.length || !before) return;
    // no effective change → no version churn (an identical draft version would
    // only pollute the history)
    const after = items.find((s) => s.shotId === ui.selectedShotId);
    const changed = ["title", "description", "action", "cameraMotion", "dialogue"]
      .some((k) => (after[k] || "") !== (before[k] || ""))
      || after.duration_seconds !== before.duration_seconds;
    if (!changed) { ctx.toast("没有修改 — 未创建新版本"); return; }
    if (items.some((s) => !(s.title || "").trim())) { ctx.toast("镜头名不能为空"); return; }
    if (ctx.shots.saveEdit(items)) {
      ui.dirty = false;
      ui.buffer = {};
      ui.shotEdit = false;
      ctx.toast("已保存为新草稿版本（旧版本保留，可在工作流节点回切）");
      rerender();
    } else {
      ctx.toast("没有可保存的草稿版本");
    }
  });
}

/** Variant switching + the first-frame flow — shared by all shot workspaces. */
export function bindShotMedia(root, ctx, ui) {
  root.querySelectorAll("[data-setcur]").forEach((b) => {
    b.onclick = () => ctx.media.setCurrent(b.dataset.setcur, b.dataset.slot, +b.dataset.v);
  });
  const ff = root.querySelector("[data-useff]");
  if (ff) ff.onclick = () => { if (ff.dataset.useff) ctx.media.useAsFirstFrame(ff.dataset.useff); };
}
