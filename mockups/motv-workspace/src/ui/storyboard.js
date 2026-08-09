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
import { slotEntry } from "../workflow/mediaref.js";
import { buildShotSlotIndex, slotForShotId, buildServerBridge, serverShotIdForShot } from "../workflow/shotmap.js";
import { episodeView, sceneOfShot, activeEpisode } from "../workflow/proddoc.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "../workflow/bibledoc.js";
import { outlineForPlan } from "../workflow/storydoc.js";
import { compileImagePrompt, compileVideoPrompt } from "../workflow/promptc.js";

const nn = (seq) => String(seq).padStart(2, "0");

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
  return {
    hasDraft: draft.length > 0,
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
    },
    scene: owner
      ? { sceneId: owner.scene.sceneId, title: owner.scene.title, ...sceneRefsView(prod, owner.scene) }
      : null,
    slot,
    images,
    videos: variants(pd.media.video),
    firstFrame: ff ? { version: ff.version, origin: ORIGIN_ZH[ff.origin] || ff.origin || "", url: ff.url } : null,
    voice: voiceCur
      ? { url: voiceCur.url, versions: voiceE.history.length, origin: ORIGIN_ZH[voiceCur.origin] || voiceCur.origin || "" }
      : null,
    opStatus: op ? op.status : null,
    opUnresolved,
    generations: gens,
  };
}

// ---------- render --------------------------------------------------------- //

function sceneRefChips(refs) {
  const loc = refs.location
    ? `<span class="ws-tag">📍 ${esc(refs.location.name)}${refs.location.stateName ? ` · ${esc(refs.location.stateName)}` : ""}</span>`
    : "";
  const chars = refs.characters
    .map((c) => `<span class="ws-tag">👤 ${esc(c.name)}${c.stateName ? ` · ${esc(c.stateName)}` : ""}</span>`)
    .join(" ");
  return loc || chars ? `<span class="sb-refchips">${loc} ${chars}</span>` : "";
}

function shotCardHtml(c, selected) {
  if (c.dangling) {
    return `<div class="sb-card sb-dangling" title="${esc(c.shotId)}"><div class="sb-thumb sb-none">⚠</div><div class="sb-cap">不在当前草稿</div></div>`;
  }
  const thumb = c.thumb
    ? `<img class="sb-thumb" src="${esc(c.thumb)}" alt="">`
    : `<div class="sb-thumb sb-none">${c.unresolved ? "⚠" : "🎞"}</div>`;
  const marks = `${c.hasVideo ? "▶" : ""}`;
  return (
    `<div class="sb-card${selected ? " on" : ""}${c.shotId ? "" : " sb-legacy"}" ${c.shotId ? `data-shot="${esc(c.shotId)}"` : ""}>` +
    `${thumb}<div class="sb-cap"><span class="n mono">${esc(nn(c.seq))}</span> ${esc(c.title)}${marks ? `<span class="sb-marks">${marks}</span>` : ""}</div>` +
    `<div class="sb-sub">${c.duration != null ? `${esc(String(c.duration))}s` : ""}${c.unresolved ? " · ⚠未解析" : ""}</div></div>`
  );
}

function variantStrip(kind, slot, v, actions) {
  if (!v.list.length) return `<div class="ws-desc">（还没有${kind === "image" ? "图片" : "视频"}）</div>`;
  const tiles = v.list
    .map((r) => {
      const media = kind === "image"
        ? `<img class="sb-vthumb" src="${esc(r.url)}" alt="">`
        : `<video class="sb-vthumb" src="${esc(r.url)}" muted preload="metadata"></video>`;
      const use = r.current
        ? `<span class="ws-tag">✓当前</span>`
        : `<button class="ws-chipx" data-setcur="${kind}" data-slot="${esc(slot)}" data-v="${r.version}">设为当前</button>`;
      return `<div class="sb-vitem${r.current ? " on" : ""}">${media}<div class="sb-vmeta">v${r.version} · ${esc(r.origin)} ${use}</div></div>`;
    })
    .join("");
  return `<div class="sb-vstrip">${tiles}</div>${actions || ""}`;
}

/** Selected-shot detail: creative facet form + scene context + media area.
 *  `buf` is the shell's UNSAVED edit buffer — rendered values prefer it, so a
 *  re-render (media switch, poll) never loses in-progress edits. */
function detailHtml(ctx, d, buf) {
  const val = (key, committed) => (key in buf ? buf[key] : committed);
  const field = (key, label, committed, rows = 2, ph = "") =>
    `<label class="ws-lab">${esc(label)}</label><textarea class="ws-bibletext" rows="${rows}" spellcheck="false" data-sf="${key}" placeholder="${esc(ph)}">${esc(val(key, committed))}</textarea>`;
  const sceneCtx = d.scene
    ? `<div class="sb-scenectx">🎬 ${esc(d.scene.title)} ${sceneRefChips(d.scene)}</div>`
    : `<div class="sb-scenectx ws-desc">未归入场景 — 在「剧集」把镜头归入场景后，这里显示出场角色/场景地上下文</div>`;
  const op = d.opStatus
    ? d.opStatus === "committed" ? `<span class="ws-tag ok">✓已付费</span>` : `<span class="ws-tag">⏳${esc(d.opStatus)}</span>`
    : d.opUnresolved ? `<span class="ws-tag gate">付费状态未解析</span>` : "";
  const gens = d.generations.length
    ? `<div class="ws-lab">本镜头生成记录</div>` + d.generations.slice(0, 5)
        .map((g) => `<div class="ws-desc">· ${esc(g.type)} — ${esc(g.status)}${g.createdAt ? ` · ${esc(g.createdAt.slice(0, 16).replace("T", " "))}` : ""}</div>`)
        .join("")
    : "";
  const curImg = d.images.list.find((r) => r.current);
  const ffBtn = curImg
    ? `<button class="nrun ghost" data-useff="${esc(d.slot || "")}">🎬→ 用作视频首帧</button>`
    : "";
  const ffLine = d.firstFrame
    ? `<div class="ws-desc">首帧：资产 v${esc(String(d.firstFrame.version))}（${esc(d.firstFrame.origin)}）</div>`
    : `<div class="ws-desc">首帧来源：未记录</div>`;
  const voice = d.voice
    ? `<div class="ws-desc">🎤 配音就绪 · ${d.voice.versions} 版 · ${esc(d.voice.origin)}</div><audio class="aaud" src="${esc(d.voice.url)}" controls preload="none"></audio>`
    : `<div class="ws-desc">🎤 还没有配音 — 「音频」工作区查看，或在工作流「音频生成」节点本地 TTS/上传</div>`;
  // 生成入口 (M10): compiled prompt → pick an entry → result imports back
  // onto this shot (with real Generation provenance when the flow was used)
  const genPanel = (kind, p, entries) => {
    const gaps = p.missing.map((m) => `<div class="ws-kv gate">◌ ${esc(m)}</div>`).join("");
    const entryBtns = entries
      .map(([key, label]) => `<button class="nrun ghost" data-gp-entry="${key}" data-kind="${kind}">↗ ${esc(label)}（复制并打开）</button>`)
      .join("");
    return (
      `<div class="gen-panel"><div class="ws-lab">🪄 ${kind === "image" ? "生成画面 · Image Prompt（场景地/角色状态/画面内容 编译）" : "生成视频 · Video Prompt（首帧图片 + 动作 + 运镜）"}</div>` +
      gaps +
      `<textarea class="gen-prompt" readonly spellcheck="false" data-genprompt="${kind}">${esc(p.text)}</textarea>` +
      `<div class="bd-actions"><button class="nrun ghost" data-gp-copy data-kind="${kind}">📋 复制提示词</button>${entryBtns}` +
      `<button class="nrun ghost" data-gp-import data-kind="${kind}">⬆ 导入生成结果</button></div>` +
      `<div class="pa-unavail">◌ API 自动生成（未来/可选）— 付费生成当前在工作流节点（图像 ADR-0045 / 视频 ADR-0041），本入口后续接线</div>` +
      `</div>`
    );
  };
  return (
    `<div class="sb-detail">` +
    `<div class="sb-detail-head"><b>${esc(nn(d.shot.seq))} ${esc(d.shot.title)}</b>${op}<span class="ws-desc mono">${esc(d.shot.shotId)}</span></div>` +
    sceneCtx +
    `<div class="sb-detail-grid"><div class="sb-fields">` +
    `<label class="ws-lab">镜头名</label><input class="ws-bibleinput" data-sf="title" maxlength="80" value="${esc(val("title", d.shot.title))}">` +
    field("description", "画面内容（可直接用作生成提示词）", d.shot.description, 3) +
    field("action", "动作（人物/物体做什么）", d.shot.action, 2, "例如：李昭跪地，指尖颤抖地抬起") +
    field("cameraMotion", "运镜", d.shot.cameraMotion, 2, "例如：低角度缓慢推近至面部特写") +
    field("dialogue", "台词/旁白", d.shot.dialogue, 2, "例如：「臣……遵旨。」") +
    `<label class="ws-lab">时长</label><select class="ws-assign" data-sf="duration">${(() => {
      const dur = "duration" in buf ? +buf.duration : d.shot.duration;
      return `<option value="6"${dur === 10 ? "" : " selected"}>6s</option><option value="10"${dur === 10 ? " selected" : ""}>10s</option>`;
    })()}</select>` +
    `<div class="vbtns"><button class="nrun" data-shot-save>保存为新草稿版本（历史保留）</button></div>` +
    `</div><div class="sb-media">` +
    `<div class="ws-lab">🖼 画面变体${d.slot ? "" : "（镜头身份未解析——无法定位媒体槽位）"}</div>` +
    variantStrip("image", d.slot, d.images, ffBtn) + ffLine +
    genPanel("image", d.prompts.image, [["chatgpt", "ChatGPT"], ["gemini", "Gemini"]]) +
    `<div class="ws-lab">▶ 视频变体</div>` +
    variantStrip("video", d.slot, d.videos, "") +
    genPanel("video", d.prompts.video, [["gemini", "Gemini 视频"]]) +
    voice + gens +
    `</div></div></div>`
  );
}

/** The whole Storyboard workspace. `ui` is the shell's transient state:
 *  { selectedShotId } — selection only, nothing persisted. */
export function renderStoryboard(ctx, ui) {
  const pd = ctx.prodData();
  const m = storyboardModel(pd);
  if (m.generating) {
    return (
      `<div class="pm-head"><div class="pm-title">🎞 分镜工作区</div><div class="pm-note">生成中</div></div>` +
      `<div class="ws-empty"><div class="ic">⏳</div><div class="tt">Claude 正在生成分镜草稿…</div><div class="hh">通常 20–60 秒，完成后自动出现在这里</div><div class="skel live"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>`
    );
  }
  if (!m.hasDraft) {
    const hasScript = ctx.script.hasContent();
    return (
      `<div class="pm-head"><div class="pm-title">🎞 分镜工作区</div><div class="pm-note">还没有分镜</div></div>` +
      `<div class="ws-empty"><div class="ic">🎞</div><div class="tt">从剧本生成分镜，开始逐镜头制作</div>` +
      (hasScript
        ? `<div class="hh">剧本已就绪 — 一键让 AI 拆分镜头（草稿可手工改、可重生成，全部版本保留）</div><button class="nrun" data-sb-generate>🎬 基于剧本生成分镜</button>`
        : `<div class="hh">前置：剧本 — 先到「剧本」工作区写一句创意生成 v1</div><button class="nrun ghost" data-goto="script">→ 去剧本工作区</button>`) +
      `</div>`
    );
  }
  const selected = ui.selectedShotId;
  const sceneBlocks = m.scenes
    .map(
      (sc) =>
        `<div class="sb-scene"><div class="sb-scene-h">🎬 ${esc(sc.title)} ${sceneRefChips(sc.refs)}<span class="ws-desc">${sc.shots.length} 镜</span></div>` +
        `<div class="sb-cards">${sc.shots.map((c) => shotCardHtml(c, c.shotId === selected)).join("") || `<div class="ws-desc">（空场景 — 在下方未归组镜头卡上归入）</div>`}</div></div>`,
    )
    .join("");
  const pool = m.unassigned.length
    ? `<div class="sb-scene"><div class="sb-scene-h">未归组镜头<span class="ws-desc">${m.unassigned.length} 镜 · 在「剧集」建场景后归组</span></div>` +
      `<div class="sb-cards">${m.unassigned.map((c) => shotCardHtml(c, c.shotId === selected)).join("")}</div></div>`
    : "";
  const meta = [
    m.versions && m.versions.count ? `草稿 v${m.versions.cur}/${m.versions.count}` : "",
    m.lock ? `🔒 已锁定 plan v${m.lock.planVersion}` : "未锁定",
    `${m.total} 个镜头`,
    m.unassignableCount ? `⚠ ${m.unassignableCount} 个 legacy 镜头无稳定身份` : "",
  ].filter(Boolean).join(" · ");
  const d = selected ? shotDetailModel(pd, selected) : null;
  const detail = d
    ? detailHtml(ctx, d, ui.buffer || {})
    : `<div class="sb-detail sb-detail-empty ws-desc">点击上方镜头卡查看/编辑镜头详情与媒体</div>`;
  return (
    `<div class="pm-head"><div class="pm-title">🎞 分镜工作区${m.episode ? ` · ${esc(m.episode.title)}` : ""}</div><div class="pm-note">${esc(meta)}</div>` +
    `<div class="pm-actions"><button class="nrun ghost" data-sb-generate>↻ 重新生成（新版本）</button></div></div>` +
    sceneBlocks + pool + detail
  );
}

/** Wire the storyboard. Field edits buffer locally (no re-render while
 *  typing); ONLY 「保存为新草稿版本」 commits — through ctx.shots.saveEdit,
 *  which appends an immutable draft version. */
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
  root.querySelectorAll("[data-shot]").forEach((el) => {
    el.onclick = () => {
      if (el.dataset.shot === ui.selectedShotId) return;
      if (ui.dirty && !window.confirm("镜头详情有未保存的修改，切换将丢弃？")) return;
      ui.dirty = false;
      ui.buffer = {};
      ui.selectedShotId = el.dataset.shot;
      rerender();
    };
  });
  // --- detail: buffered field edits → one immutable save ------------------ //
  // the buffer lives on the SHELL's ui state (not this binding closure), so a
  // re-render — media variant switch, generation completion — re-renders the
  // buffered values instead of discarding unsaved edits
  const buffer = ui.buffer || (ui.buffer = {});
  root.querySelectorAll("[data-sf]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; };
    if (el.tagName === "SELECT") el.onchange = () => { buffer[el.dataset.sf] = el.value; ui.dirty = true; };
  });
  const save = root.querySelector("[data-shot-save]");
  if (save)
    save.onclick = () => {
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
      // no effective change → no version churn (an identical draft version
      // would only pollute the history)
      const after = items.find((s) => s.shotId === ui.selectedShotId);
      const changed = ["title", "description", "action", "cameraMotion", "dialogue"]
        .some((k) => (after[k] || "") !== (before[k] || ""))
        || after.duration_seconds !== before.duration_seconds;
      if (!changed) { ctx.toast("没有修改 — 未创建新版本"); return; }
      if (items.some((s) => !(s.title || "").trim())) { ctx.toast("镜头名不能为空"); return; }
      if (ctx.shots.saveEdit(items)) {
        ui.dirty = false;
        ui.buffer = {};
        ctx.toast("已保存为新草稿版本（旧版本保留，可在工作流节点回切）");
        rerender();
      } else {
        ctx.toast("没有可保存的草稿版本");
      }
    };
  // --- media: variant switching + first-frame flow ------------------------- //
  root.querySelectorAll("[data-setcur]").forEach((b) => {
    b.onclick = () => ctx.media.setCurrent(b.dataset.setcur, b.dataset.slot, +b.dataset.v);
  });
  const ff = root.querySelector("[data-useff]");
  if (ff) ff.onclick = () => { if (ff.dataset.useff) ctx.media.useAsFirstFrame(ff.dataset.useff); };
  // --- 生成入口 (M10): prompt → entry → import with provenance -------------- //
  // The INTENT (compiled prompt + entry) is captured when the creator copies
  // or opens an entry; an import through this panel then records a REAL
  // Generation (promptSnapshot = the copied text, provider = the entry).
  // A plain import without a prior intent stays an ordinary upload.
  const ENTRY_URL = { chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/" };
  const promptText = (kind) => {
    const ta = root.querySelector(`textarea[data-genprompt="${kind}"]`);
    return ta ? ta.value : "";
  };
  const setIntent = (kind, entry) => {
    ui.genIntent = ui.genIntent || {};
    ui.genIntent[kind] = { shotId: ui.selectedShotId, prompt: promptText(kind), entry };
  };
  const copyPrompt = async (kind) => {
    try {
      await navigator.clipboard.writeText(promptText(kind));
      ctx.toast("提示词已复制");
      return true;
    } catch {
      ctx.toast("复制失败：请手动选择文本复制");
      return false;
    }
  };
  root.querySelectorAll("[data-gp-copy]").forEach((b) => {
    b.onclick = async () => {
      if (await copyPrompt(b.dataset.kind)) setIntent(b.dataset.kind, "manual");
    };
  });
  root.querySelectorAll("[data-gp-entry]").forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.kind;
      const entry = b.dataset.gpEntry;
      // open FIRST, synchronously in the user gesture — an awaited clipboard
      // call before window.open can demote it to a blocked popup
      window.open(ENTRY_URL[entry] || "about:blank", "_blank", "noopener");
      // provenance intent ONLY when the prompt actually reached the
      // clipboard — a denied copy must not fake a "sent to ChatGPT" record
      if (await copyPrompt(kind)) setIntent(kind, `${entry}-manual`);
    };
  });
  root.querySelectorAll("[data-gp-import]").forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.kind;
      const d = shotDetailModel(ctx.prodData(), ui.selectedShotId);
      if (!d || !d.slot) { ctx.toast("镜头身份未解析：无法定位媒体槽位"); return; }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const intent = ui.genIntent && ui.genIntent[kind] && ui.genIntent[kind].shotId === ui.selectedShotId
          ? ui.genIntent[kind]
          : null;
        try {
          await ctx.media.importShotMedia(kind, d.slot, ui.selectedShotId, file, intent);
          // consume ONLY the intent this import used — a NEWER intent set
          // while the upload was in flight belongs to the next import
          if (intent && ui.genIntent && ui.genIntent[kind] === intent) {
            delete ui.genIntent[kind];
          }
          rerender();
        } catch (err) {
          ctx.toast("导入失败：" + err.message);
        }
      };
      input.click();
    };
  });
}
