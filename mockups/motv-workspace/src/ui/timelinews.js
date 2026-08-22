// 时间线工作区 (M11-B) — the lightweight episode edit surface:
// TOP episode preview (play/pause/scrub/cursor) · MIDDLE five tracks
// (video/dialogue/ambience/sfx/bgm) · BOTTOM selected-clip properties +
// render settings + [渲染本集]. NOT a professional NLE — exactly the V1 ops.
//
// Clips reference assetIds; media is looked up read-only in the M3 registry
// for display/preview. The PREVIEW is a coarse scheduler (one <video> for the
// current video clip + <audio> elements started/stopped as the cursor enters
// their span) — honest about being a draft preview, the render is the truth.
import { esc } from "../util/dom.js";
import * as timeline from "../workflow/timeline.js";
import { findAssetById } from "../workflow/assetlib.js";

const TRACK_LABEL = { video: "VIDEO", dialogue: "DIALOGUE", ambience: "AMBIENCE", sfx: "SFX", bgm: "BGM" };
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Pure view-model: tracks with proportional clip geometry + media lookup.
 *  `shotLabels` maps a shotId → a human label ("01 跪殿") so a clip reads as
 *  its shot rather than its raw assetId; scene/episode audio (no shotId) and
 *  unmapped shots fall back to a short assetId. */
export function timelineModel(t, reg, shotLabels = {}) {
  const dur = Math.max(1, timeline.timelineDuration(t));
  const tracks = timeline.TRACKS.map((track) => ({
    track,
    label: TRACK_LABEL[track],
    clips: timeline.clipsOf(t, track).map((c) => {
      const hit = findAssetById(reg, c.assetId);
      const available = !!hit && (hit.record.storageState || "local") === "local";
      const label = (c.shotId && shotLabels[c.shotId]) || c.assetId.slice(0, 12);
      return {
        ...c,
        left: (c.startTime / dur) * 100,
        width: Math.max(1.2, ((c.trimOut - c.trimIn) / dur) * 100),
        url: hit ? hit.record.url : "",
        label,
        available,
        missing: !hit,
      };
    }),
  }));
  return { duration: dur, tracks, edited: t.edited, settings: t.settings };
}

/** shotId → "NN 标题" from the current draft shots (for clip labels). */
function shotLabelMap(pd) {
  const out = {};
  for (const s of pd.draftShots || []) {
    if (s && s.shotId) out[s.shotId] = `${String(s.sequence).padStart(2, "0")} ${s.title || ""}`.trim();
  }
  return out;
}

export function renderTimelineWs(ctx, ui) {
  const pd = ctx.prodData();
  const t = ctx.timeline.doc();
  const m = timelineModel(t, ctxReg(ctx), shotLabelMap(pd));
  const stale = ctx.timeline.sourceStale(t);
  const hasVideo = m.tracks[0].clips.length > 0;
  if (!hasVideo && !t.edited) {
    return (
      `<div class="pm-head"><div class="pm-title">🎬 时间线</div><div class="pm-note">还没有可编排的镜头视频</div></div>` +
      `<div class="ws-empty"><div class="ic">🎬</div><div class="tt">时间线由镜头的当前视频自动构建</div>` +
      `<div class="hh">前置：每镜头至少一段视频（「视频」工作区/工作流节点生成或导入）；对白/环境音/BGM 在「音频」工作区就位后一并入轨</div>` +
      `<button class="nrun ghost" data-goto="video">→ 去视频工作区</button></div>`
    );
  }
  const staleBanner = stale
    ? `<div class="ws-kv gate">⚠ 镜头/音频来源已变化（换当前版本、重排或音频引用变更）。` +
      `${t.edited ? "时间线含手工调整——" : ""}<button class="ws-chipx" data-tl-resync>重新同步（按来源重建${t.edited ? "，覆盖手工调整" : ""}）</button> 或保留现状继续。</div>`
    : "";
  // --- preview -------------------------------------------------------------- //
  const preview =
    `<div class="tl-preview"><video class="tl-video" data-tl-video preload="metadata" muted></video>` +
    `<div class="tl-ctl"><button class="nrun ghost" data-tl-play>▶ / ⏸</button>` +
    `<input type="range" class="tl-scrub" data-tl-scrub min="0" max="${m.duration.toFixed(2)}" step="0.05" value="${(ui.tlCursor || 0).toFixed(2)}">` +
    `<span class="ws-desc mono" data-tl-time>${fmtT(ui.tlCursor || 0)} / ${fmtT(m.duration)}</span></div>` +
    `<div class="ws-desc">预览为草稿级（切镜与混音以最终渲染为准）· 视频原声不参与——声音来自音频轨</div></div>`;
  // --- tracks ----------------------------------------------------------------- //
  const tracks = m.tracks
    .map(
      (tr) =>
        `<div class="tl-track"><span class="tl-tlabel">${tr.label}</span><div class="tl-lane">` +
        tr.clips
          .map(
            (c) =>
              `<button class="tl-clip${c.clipId === ui.tlSelected ? " on" : ""}${c.available ? "" : " unavailable"}" ` +
              `data-tl-clip="${esc(c.clipId)}" style="left:${c.left}%;width:${c.width}%" ` +
              `title="${esc(c.label)} · ${esc(c.assetId)}${c.available ? "" : c.missing ? "（资产已删除）" : "（媒体不可用）"}">` +
              `${c.muted ? "🔇 " : ""}${esc(c.label)}${c.available ? "" : " ⚠"}</button>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("");
  // --- selected clip properties ------------------------------------------------ //
  const sel = ui.tlSelected ? timeline.findClip(t, ui.tlSelected) : null;
  let props = `<div class="ws-desc">点击 clip 编辑属性（修剪/音量/静音/淡入淡出/重排/替换/移除）</div>`;
  if (sel) {
    const isVideo = sel.trackType === "video";
    // video clips may be replaced by ANOTHER version of the same shot's chain
    let variantSel = "";
    if (isVideo && sel.shotId) {
      const hit = findAssetById(ctxReg(ctx), sel.assetId);
      if (hit && hit.domain === "videos") {
        const chain = ctxReg(ctx).videos[hit.key];
        variantSel =
          `<label class="ws-lab">替换视频变体（同镜头链）</label><select class="ws-assign" data-tl-replace>` +
          chain.history.map((r) => `<option value="${esc(r.assetId)}"${r.assetId === sel.assetId ? " selected" : ""}>v${r.version} · ${esc(r.origin)}${(r.storageState || "local") !== "local" ? "（不可用）" : ""}</option>`).join("") +
          `</select>`;
      }
    }
    props =
      `<div class="tl-props"><div class="pm-title">clip · ${esc(TRACK_LABEL[sel.trackType])} <span class="ws-desc mono">${esc(sel.assetId)}</span></div>` +
      (isVideo
        ? `<div class="bd-actions"><button class="nrun ghost" data-tl-move="-1">◀ 前移</button><button class="nrun ghost" data-tl-move="1">后移 ▶</button></div>`
        : `<label class="ws-lab">开始时间（秒）</label><input class="ws-bibleinput" type="number" min="0" max="${timeline.MAX_CLIP_START}" step="0.1" data-tl-prop="startTime" value="${sel.startTime}">`) +
      `<label class="ws-lab">修剪入点 / 出点（秒）</label>` +
      `<div class="bd-actions"><input class="ws-bibleinput tl-num" type="number" min="0" step="0.1" data-tl-prop="trimIn" value="${sel.trimIn}">` +
      `<input class="ws-bibleinput tl-num" type="number" min="0" step="0.1" data-tl-prop="trimOut" value="${sel.trimOut}"></div>` +
      `<label class="ws-lab">音量 ${sel.volume.toFixed(2)}（渲染与混音使用；预览近似）</label>` +
      `<input type="range" min="0" max="2" step="0.05" data-tl-prop="volume" value="${sel.volume}">` +
      `<div class="bd-actions"><label class="ws-kv"><input type="checkbox" data-tl-prop="muted" ${sel.muted ? "checked" : ""}> 静音</label>` +
      `<label class="ws-lab">淡入</label><input class="ws-bibleinput tl-num" type="number" min="0" max="${timeline.MAX_CLIP_FADE}" step="0.1" data-tl-prop="fadeIn" value="${sel.fadeIn}">` +
      `<label class="ws-lab">淡出</label><input class="ws-bibleinput tl-num" type="number" min="0" max="${timeline.MAX_CLIP_FADE}" step="0.1" data-tl-prop="fadeOut" value="${sel.fadeOut}"></div>` +
      variantSel +
      `<div class="bd-actions"><button class="nrun ghost" data-tl-remove>移除 clip（源资产不受影响）</button></div></div>`;
  }
  // --- settings + render --------------------------------------------------------- //
  const st = m.settings;
  const finals = (pd.finals || []).slice(-3).reverse();
  const settings =
    `<div class="tl-props"><div class="pm-title">🎬 最终渲染（本地 FFmpeg · 免费）</div>` +
    `<div class="bd-actions">` +
    `<label class="ws-lab">分辨率</label><select class="ws-assign" data-tl-set="res">` +
    [["1280x720", 1280, 720], ["1920x1080", 1920, 1080], ["720x1280", 720, 1280], ["1080x1920", 1080, 1920]]
      .map(([l, w, h]) => `<option value="${w}x${h}"${st.width === w && st.height === h ? " selected" : ""}>${l}${h > w ? "（竖屏 9:16）" : "（横屏 16:9）"}</option>`).join("") +
    `</select>` +
    `<label class="ws-lab">帧率</label><select class="ws-assign" data-tl-set="fps">${[24, 25, 30].map((f) => `<option value="${f}"${st.fps === f ? " selected" : ""}>${f} fps</option>`).join("")}</select>` +
    `<label class="ws-lab">容器/编码</label><select class="ws-assign" data-tl-set="format"><option value="mp4"${st.format === "mp4" ? " selected" : ""}>MP4 · H.264/AAC</option><option value="webm"${st.format === "webm" ? " selected" : ""}>WebM · VP9/Opus</option></select>` +
    `</div><div class="ws-desc">输出路径：&lt;项目目录&gt;/media/render-ep-v&lt;N&gt;.${esc(st.format)}（版本化，绝不覆盖）</div>` +
    `<div class="bd-actions"><button class="nrun" data-tl-render${ui.tlRendering ? " disabled" : ""}>${ui.tlRendering ? "⏳ 渲染中…" : "🎬 渲染本集（Final Render）"}</button></div>` +
    (finals.length
      ? `<div class="ws-lab">最新成片</div>` + finals.map((u) => `<video class="afinal" src="${esc(u)}" controls preload="metadata"></video>`).join("")
      : "") +
    `</div>`;
  return (
    `<div class="pm-head"><div class="pm-title">🎬 时间线 · 轻量剪辑</div><div class="pm-note">${m.tracks[0].clips.length} 个视频 clip · 总长 ${fmtT(m.duration)}${t.edited ? " · 已手工调整" : " · 与镜头同步"}</div></div>` +
    staleBanner + preview + `<div class="tl-tracks">${tracks}</div>` + props + settings
  );
}

function ctxReg(ctx) {
  // the registry maps ride on prodData for read-only display
  const pd = ctx.prodData();
  return { images: pd.assetUploads, videos: pd.media.video, audio: pd.media.audio, finals: [], firstFrames: pd.firstFrames };
}

/** Coarse preview scheduler + all edit bindings. */
export function bindTimelineWs(root, ctx, ui, rerender) {
  const resync = root.querySelector("[data-tl-resync]");
  if (resync)
    resync.onclick = () => {
      const t = ctx.timeline.doc();
      if (t.edited && !window.confirm("重新同步会按当前镜头/音频重建时间线，覆盖手工调整。继续？")) return;
      ctx.timeline.resync();
      ui.tlSelected = null;
      rerender();
    };
  root.querySelectorAll("[data-tl-clip]").forEach((b) => {
    b.onclick = () => { ui.tlSelected = b.dataset.tlClip; stopPreview(ui); rerender(); };
  });
  root.querySelectorAll("[data-tl-move]").forEach((b) => {
    b.onclick = () => { if (ctx.timeline.op("reorderVideo", ui.tlSelected, +b.dataset.tlMove)) rerender(); };
  });
  const replace = root.querySelector("[data-tl-replace]");
  if (replace) replace.onchange = () => { if (ctx.timeline.op("replaceClipAsset", ui.tlSelected, replace.value)) rerender(); };
  const remove = root.querySelector("[data-tl-remove]");
  if (remove)
    remove.onclick = () => {
      if (ctx.timeline.op("removeClip", ui.tlSelected)) { ui.tlSelected = null; rerender(); }
    };
  root.querySelectorAll("[data-tl-prop]").forEach((el) => {
    el.onchange = () => {
      const t = ctx.timeline.doc();
      const c = timeline.findClip(t, ui.tlSelected);
      if (!c) return;
      const p = el.dataset.tlProp;
      let ok = false;
      if (p === "trimIn" || p === "trimOut") {
        ok = ctx.timeline.op("trimClip", ui.tlSelected, p === "trimIn" ? +el.value : c.trimIn, p === "trimOut" ? +el.value : c.trimOut);
        if (!ok) ctx.toast("修剪无效：出点必须大于入点");
      } else if (p === "volume") ok = ctx.timeline.op("setClipVolume", ui.tlSelected, +el.value);
      else if (p === "muted") ok = ctx.timeline.op("setClipMuted", ui.tlSelected, el.checked);
      else if (p === "startTime") ok = ctx.timeline.op("moveClip", ui.tlSelected, +el.value);
      else if (p === "fadeIn") ok = ctx.timeline.op("setClipFades", ui.tlSelected, +el.value, c.fadeOut);
      else if (p === "fadeOut") ok = ctx.timeline.op("setClipFades", ui.tlSelected, c.fadeIn, +el.value);
      if (ok) rerender();
    };
  });
  root.querySelectorAll("[data-tl-set]").forEach((el) => {
    el.onchange = () => {
      const k = el.dataset.tlSet;
      if (k === "res") {
        const [w, h] = el.value.split("x").map(Number);
        ctx.timeline.setSettings({ width: w, height: h });
      } else if (k === "fps") ctx.timeline.setSettings({ fps: +el.value });
      else if (k === "format") ctx.timeline.setSettings({ format: el.value });
      rerender();
    };
  });
  const render = root.querySelector("[data-tl-render]");
  if (render)
    render.onclick = async () => {
      if (ui.tlRendering) return;
      ui.tlRendering = true;
      rerender();
      try {
        const res = await ctx.timeline.render();
        ctx.toast(`✅ 渲染完成 · render-ep-v${res.version} 已入成片（含渲染溯源记录）`);
      } catch (e) {
        ctx.toast("渲染失败：" + e.message);
      } finally {
        ui.tlRendering = false;
        rerender();
      }
    };
  // ---- coarse preview scheduler --------------------------------------------- //
  const video = root.querySelector("[data-tl-video]");
  const scrub = root.querySelector("[data-tl-scrub]");
  const timeEl = root.querySelector("[data-tl-time]");
  const play = root.querySelector("[data-tl-play]");
  if (!video) return;
  const t = ctx.timeline.doc();
  const m = timelineModel(t, ctxReg(ctx));
  const vids = m.tracks[0].clips;
  const audible = m.tracks.slice(1).flatMap((tr) => tr.clips).filter((c) => c.available && !c.muted && c.volume > 0);
  const state = (ui._pv = ui._pv || { playing: false, cursor: ui.tlCursor || 0, audios: new Map(), timer: null });
  const clipAt = (cur) => vids.find((c) => cur >= c.startTime - 1e-3 && cur < c.startTime + (c.trimOut - c.trimIn)) || null;
  const seekVideo = (cur) => {
    const c = clipAt(cur);
    if (!c || !c.available) { video.removeAttribute("src"); return null; }
    const base = video.getAttribute("src");
    if (base !== c.url) video.src = c.url;
    const local = c.trimIn + (cur - c.startTime);
    if (Math.abs((video.currentTime || 0) - local) > 0.25) video.currentTime = local;
    return c;
  };
  const syncAudio = (cur) => {
    for (const c of audible) {
      const end = c.startTime + (c.trimOut - c.trimIn);
      const within = cur >= c.startTime && cur < end;
      let a = state.audios.get(c.clipId);
      if (within) {
        if (!a) { a = new Audio(c.url); a.volume = Math.min(1, c.volume); state.audios.set(c.clipId, a); }
        const local = c.trimIn + (cur - c.startTime);
        if (Math.abs((a.currentTime || 0) - local) > 0.35) a.currentTime = local;
        if (state.playing && a.paused) a.play().catch(() => {});
        if (!state.playing && !a.paused) a.pause();
      } else if (a && !a.paused) a.pause();
    }
  };
  const tick = () => {
    if (!state.playing) return;
    state.cursor = Math.min(m.duration, state.cursor + 0.2);
    if (state.cursor >= m.duration) { state.playing = false; video.pause(); }
    const c = seekVideo(state.cursor);
    if (c && state.playing && video.paused) video.play().catch(() => {});
    if (!c) video.pause();
    syncAudio(state.cursor);
    if (scrub) scrub.value = state.cursor.toFixed(2);
    if (timeEl) timeEl.textContent = `${fmtT(state.cursor)} / ${fmtT(m.duration)}`;
    ui.tlCursor = state.cursor;
    if (state.playing) state.timer = setTimeout(tick, 200);
  };
  if (play)
    play.onclick = () => {
      state.playing = !state.playing;
      if (state.playing) { seekVideo(state.cursor); video.play().catch(() => {}); tick(); }
      else { video.pause(); syncAudio(state.cursor); clearTimeout(state.timer); }
    };
  if (scrub)
    scrub.oninput = () => {
      state.cursor = +scrub.value;
      ui.tlCursor = state.cursor;
      seekVideo(state.cursor);
      syncAudio(state.cursor);
      if (timeEl) timeEl.textContent = `${fmtT(state.cursor)} / ${fmtT(m.duration)}`;
    };
  seekVideo(state.cursor);
}

function stopPreview(ui) {
  const st = ui._pv;
  if (!st) return;
  st.playing = false;
  clearTimeout(st.timer);
  for (const a of st.audios.values()) a.pause();
}