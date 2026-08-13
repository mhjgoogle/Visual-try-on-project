// 后期控制台 — the Post Production Console (ADR-0061 决策 6 / TASK-064 Phase 3).
//
//   剧集制作 页面下方的「成片链路」区域 → ONE working console
//
//     [镜头音频]   multi-track audio for the shot the creator is standing on
//     [剧集剪辑]   the episode cut: picture, sound, subtitles, preview
//     [成片]       render settings, the render itself, and its provenance
//
// AUTOMATION FIRST + HUMAN FINE-TUNING (§40). The console never opens on an
// empty timeline: 「自动初剪」 assembles a working version out of what the project
// really has, and the creator tunes it. Everything automated is skippable, every
// skip is reported, and nothing automated overwrites a LOCKED or hand-placed
// item — that is what makes 「AI Draft → Human Tune → Lock → AI Continue」 a loop
// rather than a slogan.
//
// NOT AN NLE, NOT A DAW (§46 「不要做」). Three transitions, one video track, six
// audio tracks, gain / fade / trim / order. No compositing, no grading, no masks,
// no keyframes, no multi-camera.
//
// TWO SIZES, ONE IMPLEMENTATION. `mode: "dock"` is the strip under the centre
// column; `mode: "full"` is the same console filling the 剪辑 workspace. They are
// the same component, so 「展开」 cannot show a different tool than the dock —
// and there is exactly one place any post operation is implemented.
//
// EVERY MUTATION GOES THROUGH THE ACTION LAYER (§52). The click handlers here
// dispatch named actions; they never touch a document. That is what lets the AI
// Director apply the same operations through the same guards.

import { esc } from "../util/dom.js";
import { TRACK_LABEL as SHOT_TRACK_LABEL, TRACKS as SHOT_TRACKS, GAIN_MIN_DB, GAIN_MAX_DB } from "../workflow/shotaudio.js";
import { AUDIO_TRACKS, TRACK_LABEL as TL_TRACK_LABEL, TRANSITIONS, TRANSITION_LABEL } from "../workflow/timeline.js";
import { DEP } from "../workflow/mediadep.js";
import { STYLE_PRESETS } from "../workflow/subtitle.js";

/** The console's three faces. Deliberately three, and deliberately INSIDE one
 *  console rather than three top-level pages (§32 / the UX constraint): they are
 *  three views of one job, and the creator moves between them constantly. */
export const POST_TABS = [
  ["shotaudio", "🎚", "镜头音频"],
  ["edit", "✂", "剧集剪辑"],
  ["final", "🎬", "成片"],
];

const POST_TAB_KEYS = POST_TABS.map(([k]) => k);

export const isPostTab = (k) => POST_TAB_KEYS.includes(k);

const ms = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(2)}s` : "—");
const secs = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}s` : "—");
const NONE = `<span class="muted">未记录</span>`;

/** An asset's human label + url, resolved through the registry. Returns
 *  `{ name, url, domain, version, available }` — an asset whose bytes are gone
 *  keeps its NAME and reports `available: false`, because a clip referencing it
 *  is still a real clip and rendering it is what must fail, not reading it. */
function assetView(ctx, assetId) {
  if (!assetId) return { name: "—", url: "", domain: null, version: null, available: false, missing: true };
  const hit = ctx.assets.find(assetId);
  if (!hit) return { name: `${String(assetId).slice(0, 12)}…（已删除）`, url: "", domain: null, version: null, available: false, missing: true };
  const row = ctx.assets.libraryOne(assetId);
  const state = hit.record.storageState || "local";
  return {
    name: (row && row.name) || `${hit.domain} v${hit.record.version || 1}`,
    url: hit.record.url || "",
    domain: hit.domain,
    key: hit.key,
    version: Number.isInteger(hit.record.version) ? hit.record.version : null,
    available: state === "local" && !!hit.record.url,
    missing: false,
    storageState: state,
  };
}

/* -------------------------------------------------------------------------- */
/* model                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything the console renders, resolved once from real state.
 *
 * Exported so a unit test can assert the derivation without a DOM — the same
 * discipline every other read model in this studio follows.
 */
export function postModel(ctx, ui) {
  const tab = isPostTab(ui.postTab) ? ui.postTab : "edit";
  const shotId = ui.selectedShotId || null;
  const shot = shotId ? ctx.shot.find(shotId) : null;
  const t = ctx.timeline.doc();
  const sub = ctx.subtitles.track();
  const drift = ctx.timeline.drift();
  // THIS episode's finals. A final with no recorded episode is still shown (it
  // is real output; the link simply predates the field) rather than hidden —
  // hiding a deliverable because a metadata field is missing loses the file.
  const epId = ctx.prodData().production.activeEpisodeId;
  const finals = ctx.assets.list().filter(
    (a) => a.domain === "finals" && (!a.links.episodeId || a.links.episodeId === epId),
  );
  return {
    tab,
    shotId,
    shotTitle: shot ? (shot.title || `镜头 ${shot.sequence}`) : null,
    // --- 镜头音频 --------------------------------------------------------- //
    audio: shotId
      ? {
        tracks: ctx.shotAudio.byTrack(shotId).map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => ({ ...c, asset: assetView(ctx, c.assetId), locked: c.locked })),
        })),
        anchors: Object.keys(ctx.shotAudio.anchors(shotId)),
        mix: ctx.shotAudio.mix(shotId),
        standing: ctx.shotAudio.standing(shotId),
        count: ctx.shotAudio.clips(shotId).length,
      }
      : null,
    // --- 剧集剪辑 --------------------------------------------------------- //
    edit: {
      episodeId: ctx.prodData().production.activeEpisodeId,
      duration: (() => {
        const vids = t.clips.filter((c) => c.trackType === "video" && !c.removed);
        return vids.reduce((n, c) => n + (c.trimOut - c.trimIn), 0);
      })(),
      roughCutVersion: Number.isInteger(t.roughCutVersion) ? t.roughCutVersion : 0,
      roughCutAt: t.roughCutAt || null,
      edited: t.edited === true,
      video: t.clips
        .filter((c) => c.trackType === "video")
        .map((c, i) => ({
          ...c,
          index: i,
          asset: assetView(ctx, c.assetId),
          locked: ctx.locks.is("timelineClip", c.clipId),
          shotTitle: c.shotId ? (() => { const s = ctx.shot.find(c.shotId); return s ? (s.title || `镜头 ${s.sequence}`) : null; })() : null,
          drift: drift.find((d) => d.clipId === c.clipId) || null,
        })),
      audio: AUDIO_TRACKS.map((track) => ({
        trackType: track,
        label: TL_TRACK_LABEL[track] || track,
        clips: t.clips
          .filter((c) => c.trackType === track)
          .map((c) => ({
            ...c,
            asset: assetView(ctx, c.assetId),
            locked: ctx.locks.is("timelineClip", c.clipId),
            drift: drift.find((d) => d.clipId === c.clipId) || null,
          })),
      })),
      drift,
      settings: t.settings,
    },
    // --- 字幕 -------------------------------------------------------------- //
    subtitles: {
      version: sub.version,
      style: sub.style,
      generatedFrom: sub.generatedFrom,
      overlaps: ctx.subtitles.overlaps(),
      adapters: ctx.subtitles.ADAPTERS,
      cues: sub.cues.map((c) => ({ ...c, locked: ctx.locks.is("subtitle", c.cueId) })),
    },
    // --- 成片 -------------------------------------------------------------- //
    finals: finals.slice().reverse(),
    locks: ctx.locks.count(),
  };
}

/* -------------------------------------------------------------------------- */
/* shared render helpers                                                      */
/* -------------------------------------------------------------------------- */

function lockBtn(scope, id, on) {
  return `<button class="pc-lock${on ? " on" : ""}" data-pc-lock="${esc(scope)}" data-pc-lockid="${esc(id)}" ` +
    `title="${on ? "已锁定：自动初剪 / Auto Mix / Skill 提案都不会改它" : "锁定后自动化不会改它"}">${on ? "🔒" : "🔓"}</button>`;
}

/** The drift notice §48 requires: 「SH03 有新版本 v3，时间线当前仍使用 v2」 with
 *  三个出口 and no silent replacement. */
function driftRow(d) {
  return (
    `<div class="pc-drift dep-${esc(d.state)}">` +
    `<b>${esc(d.state === DEP.OUTDATED ? "上游已更新" : "上游已回退")}</b>` +
    `<span>时间线当前使用 v${esc(String(d.pinnedVersion))}` +
    (Number.isInteger(d.activeVersion) ? `，镜头当前版本是 v${esc(String(d.activeVersion))}` : "") + `。</span>` +
    `<span class="pc-acts">` +
    `<button class="btn sm" data-pc-driftkeep="${esc(d.clipId)}">保持 v${esc(String(d.pinnedVersion))}</button>` +
    (d.activeAssetId
      ? `<button class="btn sm primary" data-pc-driftreplace="${esc(d.clipId)}" data-pc-asset="${esc(d.activeAssetId)}">替换为 v${esc(String(d.activeVersion))}</button>`
      : "") +
    `<button class="btn sm" data-pc-driftcompare="${esc(d.clipId)}">对比</button>` +
    `</span></div>`
  );
}

/* -------------------------------------------------------------------------- */
/* 镜头音频                                                                    */
/* -------------------------------------------------------------------------- */

function audioClipRow(c) {
  const anchored = !!c.anchor;
  return (
    `<li class="pc-clip${c.unresolved ? " bad" : ""}${c.muted ? " muted" : ""}" data-pc-clip="${esc(c.clipId)}">` +
    `<span class="pc-clipn" title="${esc(c.asset.name)}">${esc(c.asset.name)}` +
    (c.asset.missing || !c.asset.available ? `<span class="chip bad">素材不可用</span>` : "") +
    (c.origin === "auto" ? `<span class="chip mute">自动</span>` : "") +
    `</span>` +
    // TIMING — the two modes are exclusive and the control says which one is in
    // force, because a clip that showed both would have two answers to 「它从哪里
    // 开始」 and whichever the renderer used would make the other a lie.
    `<span class="pc-timing">` +
    `<select class="pc-mode" data-pc-mode="${esc(c.clipId)}">` +
    `<option value="absolute"${anchored ? "" : " selected"}>绝对时间</option>` +
    `<option value="anchored"${anchored ? " selected" : ""}>跟随事件</option>` +
    `</select>` +
    (anchored
      ? `<input class="pc-anchor" data-pc-anchorof="${esc(c.clipId)}" value="${esc(c.anchor)}" size="16">` +
        `<input class="pc-off" type="number" step="10" data-pc-offset="${esc(c.clipId)}" value="${esc(String(c.offsetMs))}"> ms`
      : `<input class="pc-off" type="number" step="10" min="0" data-pc-start="${esc(c.clipId)}" value="${esc(String(c.startTimeMs || 0))}"> ms`) +
    `</span>` +
    `<span class="pc-at">${c.unresolved ? `<span class="chip bad">对位未解析</span>` : `${ms(c.startMs)} → ${ms(c.endMs)}`}</span>` +
    `<span class="pc-gain"><input type="range" min="${GAIN_MIN_DB}" max="${GAIN_MAX_DB}" step="1" ` +
    `data-pc-gain="${esc(c.clipId)}" value="${esc(String(Math.round(c.gain)))}">` +
    `<b>${esc(String(Math.round(c.gain)))} dB</b></span>` +
    `<span class="pc-fade">淡入 <input type="number" min="0" step="50" data-pc-fadein="${esc(c.clipId)}" value="${esc(String(c.fadeInMs))}">` +
    ` 淡出 <input type="number" min="0" step="50" data-pc-fadeout="${esc(c.clipId)}" value="${esc(String(c.fadeOutMs))}"></span>` +
    `<span class="pc-acts">` +
    `<button class="btn sm${c.muted ? " on" : ""}" data-pc-mute="${esc(c.clipId)}">${c.muted ? "取消静音" : "静音"}</button>` +
    `<button class="btn sm" data-pc-replace="${esc(c.clipId)}">换素材…</button>` +
    lockBtn("audioClip", c.clipId, c.locked) +
    `<button class="btn sm" data-pc-rmclip="${esc(c.clipId)}">移除</button>` +
    `</span></li>`
  );
}

function shotAudioBody(m) {
  if (!m.shotId) {
    return `<div class="pc-none">在中央的图上选一个镜头，这里就是它的多轨音频。</div>`;
  }
  const a = m.audio;
  const st = a.standing;
  return (
    `<div class="pc-head">` +
    `<b>${esc(m.shotTitle || "当前镜头")}</b>` +
    `<span class="pc-sub">${a.count} 条片段 · ${SHOT_TRACKS.length} 条轨道</span>` +
    `<span class="pc-acts">` +
    `<button class="btn sm" data-pc-autoarrange>自动排入</button>` +
    `<button class="btn sm primary" data-pc-mix>生成镜头混音</button>` +
    `<button class="btn sm" data-pc-addclip>添加片段…</button>` +
    `</span></div>` +
    (a.mix
      ? `<div class="pc-mixrow">` +
        `<b>镜头混音</b>` +
        `<span class="chip${st.state === "current" ? " ok" : " gate"}">${st.state === "current" ? "与当前编排一致" : "编排已变，混音已过期"}</span>` +
        `<span class="pc-sub">${a.mix.sources.length} 条源素材（全部保留，未被替换）` +
        (a.mix.unresolved.length ? ` · ${a.mix.unresolved.length} 条因对位未解析未混入` : "") + `</span>` +
        `<span class="pc-sub">${esc(String(a.mix.at || "").slice(0, 16).replace("T", " "))}</span>` +
        `</div>`
      : `<div class="pc-note">还没有生成镜头混音。生成后原始素材一条都不会被替换——混音是派生资产。</div>`) +
    `<div class="pc-tracks">` +
    a.tracks.map((tr) =>
      `<section class="pc-track">` +
      `<header><span class="pc-trackn">${esc(SHOT_TRACK_LABEL[tr.trackType] || tr.trackType)}</span>` +
      `<span class="pc-sub">${tr.clips.length}</span></header>` +
      (tr.clips.length
        ? `<ul class="pc-clips">${tr.clips.map(audioClipRow).join("")}</ul>`
        : `<div class="pc-none">这条轨道还没有片段。</div>`) +
      `</section>`).join("") +
    `</div>` +
    `<div class="pc-note">对位可以用「绝对时间」，也可以「跟随事件」（例如 <code>action:glass_hits_table</code> +80ms）。` +
    `事件解析不出来时片段会明确报「对位未解析」，不会被悄悄放到 0 秒。可用事件：` +
    `${a.anchors.map((x) => `<code>${esc(x)}</code>`).join("、") || "（这个镜头还没有声明事件）"}。</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* 剧集剪辑                                                                    */
/* -------------------------------------------------------------------------- */

function videoClipCard(c, total) {
  const dur = c.trimOut - c.trimIn;
  return (
    `<div class="pc-vclip${c.removed ? " removed" : ""}${c.locked ? " locked" : ""}" data-pc-vclip="${esc(c.clipId)}">` +
    `<div class="pc-vth">` +
    (c.asset.available && c.asset.domain === "videos"
      ? `<video src="${esc(c.asset.url)}" preload="metadata" muted playsinline></video>`
      : `<span class="none">${c.asset.missing ? "⃠" : "🎞"}</span>`) +
    `<span class="pc-vdur">${secs(dur)}</span>` +
    `</div>` +
    `<div class="pc-vmeta">` +
    `<b>${esc(c.shotTitle || "未命名镜头")}</b>` +
    `<span class="pc-sub">${c.asset.version != null ? `v${c.asset.version}` : "版本未记录"}` +
    (c.assetVersion != null ? ` · 时间线固定在 v${c.assetVersion}` : " · 时间线未记录固定版本") + `</span>` +
    (c.removed ? `<span class="chip gate">已移出成片</span>` : "") +
    `</div>` +
    `<div class="pc-vacts">` +
    `<button class="btn sm" data-pc-vmove="${esc(c.clipId)}" data-pc-dir="-1"${c.index === 0 ? " disabled" : ""}>◀</button>` +
    `<button class="btn sm" data-pc-vmove="${esc(c.clipId)}" data-pc-dir="1"${c.index === total - 1 ? " disabled" : ""}>▶</button>` +
    `<select class="pc-trans" data-pc-trans="${esc(c.clipId)}" ` +
    `title="转入这一镜的转场（已记录进时间线与成片溯源；本轮本地渲染器仍按硬切拼接）">` +
    TRANSITIONS.map((k) => `<option value="${k}"${c.transition === k ? " selected" : ""}>${esc(TRANSITION_LABEL[k])}</option>`).join("") +
    `</select>` +
    `<label class="pc-trim">时长 <input type="number" min="0.2" step="0.1" data-pc-vtrim="${esc(c.clipId)}" value="${esc(dur.toFixed(2))}">s</label>` +
    `<button class="btn sm" data-pc-vreplace="${esc(c.clipId)}">换版本…</button>` +
    (c.removed
      ? `<button class="btn sm primary" data-pc-vrestore="${esc(c.clipId)}">恢复</button>`
      : `<button class="btn sm" data-pc-vremove="${esc(c.clipId)}">移出</button>`) +
    lockBtn("timelineClip", c.clipId, c.locked) +
    `</div>` +
    (c.drift ? driftRow(c.drift) : "") +
    `</div>`
  );
}

function editBody(m) {
  const e = m.edit;
  const live = e.video.filter((c) => !c.removed);
  return (
    `<div class="pc-head">` +
    `<b>本集剪辑</b>` +
    `<span class="pc-sub">${live.length} 个镜头 · ${secs(e.duration)}` +
    (e.roughCutVersion ? ` · 初剪 v${e.roughCutVersion}` : " · 还没有初剪") +
    (e.edited ? " · 有人工调整" : "") + `</span>` +
    `<span class="pc-acts">` +
    `<button class="btn sm primary" data-pc-rough>${e.roughCutVersion ? "重新初剪" : "自动初剪"}</button>` +
    `<button class="btn sm" data-pc-resync title="丢弃全部手工调整，按当前素材从头重建">按当前素材重建…</button>` +
    `<button class="btn sm" data-pc-preview>预览</button>` +
    `</span></div>` +
    (e.roughCutVersion
      ? `<div class="pc-note">重新初剪只重排「自动」片段：锁定的和手工摆放的原样保留，跳过的会逐条报出来。` +
        `手工摆放的片段因此<b>不会</b>被重新固定版本——要让它们跟上当前素材，用「换版本…」或「按当前素材重建」。</div>`
      : `<div class="pc-note">自动初剪会按镜头顺序排入每个镜头的当前视频、对白、环境音、音效/拟音与整集配乐，并把每个片段固定到具体版本。</div>`) +
    (e.drift.length
      ? `<div class="pc-warn"><b>${e.drift.length} 个片段的上游有变化</b>` +
        `<div class="pc-sub">时间线不会被自动替换——每一条都由你选。</div></div>`
      : "") +
    `<section class="pc-track vtrack">` +
    `<header><span class="pc-trackn">画面</span><span class="pc-sub">顺序即播放顺序</span></header>` +
    (e.video.length
      ? `<div class="pc-vstrip">${e.video.map((c) => videoClipCard(c, e.video.length)).join("")}</div>`
      : `<div class="pc-none">时间线还没有画面片段。按「自动初剪」用现有素材排一版。</div>`) +
    `</section>` +
    e.audio.filter((tr) => tr.clips.length).map((tr) =>
      `<section class="pc-track">` +
      `<header><span class="pc-trackn">${esc(tr.label)}</span><span class="pc-sub">${tr.clips.length}</span></header>` +
      `<ul class="pc-clips">${tr.clips.map((c) =>
        `<li class="pc-clip${c.removed ? " removed" : ""}">` +
        `<span class="pc-clipn">${esc(c.asset.name)}` +
        (c.asset.missing || !c.asset.available ? `<span class="chip bad">素材不可用</span>` : "") +
        (c.origin === "auto" ? `<span class="chip mute">自动</span>` : "") + `</span>` +
        `<span class="pc-at">${secs(c.startTime)} → ${secs(c.startTime + (c.trimOut - c.trimIn))}</span>` +
        `<span class="pc-gain"><input type="range" min="0" max="2" step="0.05" ` +
        `data-pc-tvol="${esc(c.clipId)}" value="${esc(String(c.volume))}"><b>${esc(c.volume.toFixed(2))}×</b></span>` +
        `<span class="pc-acts">` +
        (c.removed
          ? `<button class="btn sm primary" data-pc-vrestore="${esc(c.clipId)}">恢复</button>`
          : `<button class="btn sm" data-pc-vremove="${esc(c.clipId)}">移出</button>`) +
        lockBtn("timelineClip", c.clipId, c.locked) +
        `</span>` +
        (c.drift ? driftRow(c.drift) : "") +
        `</li>`).join("")}</ul>` +
      `</section>`).join("") +
    subtitleBody(m)
  );
}

function subtitleBody(m) {
  const s = m.subtitles;
  return (
    `<section class="pc-track subtrack">` +
    `<header><span class="pc-trackn">字幕</span>` +
    `<span class="pc-sub">${s.cues.length} 条` +
    (s.version ? ` · v${s.version}` : " · 还没有生成") +
    (s.generatedFrom ? ` · 来源：${esc(s.generatedFrom)}` : "") + `</span>` +
    `<span class="pc-acts">` +
    s.adapters.map((a) =>
      `<button class="btn sm${a.available ? " primary" : ""}" data-pc-subgen="${esc(a.id)}" ` +
      `title="${esc(a.detail)}">${esc(a.label)}${a.available ? "" : "（不可用）"}</button>`).join("") +
    `<select class="pc-substyle" data-pc-substyle>` +
    STYLE_PRESETS.map((p) => `<option value="${p.id}"${s.style === p.id ? " selected" : ""}>${esc(p.label)}</option>`).join("") +
    `</select>` +
    `<button class="btn sm" data-pc-srt>导出 SRT</button>` +
    `</span></header>` +
    (s.overlaps.length
      ? `<div class="pc-warn"><b>${s.overlaps.length} 处字幕重叠</b><div class="pc-sub">两条字幕同时在屏上。时间来自剪辑，所以不会自动挪——哪一条让位是创作决定。</div></div>`
      : "") +
    (s.cues.length
      ? `<ul class="pc-cues">${s.cues.map((c) =>
        `<li class="pc-cue${c.locked ? " locked" : ""}">` +
        `<span class="pc-at"><input type="number" step="50" min="0" data-pc-custart="${esc(c.cueId)}" value="${esc(String(c.startMs))}">` +
        ` → <input type="number" step="50" min="0" data-pc-cuend="${esc(c.cueId)}" value="${esc(String(c.endMs))}"></span>` +
        `<input class="pc-cuspk" data-pc-cuspk="${esc(c.cueId)}" placeholder="说话人" value="${esc(c.speaker || "")}">` +
        `<input class="pc-cutext" data-pc-cutext="${esc(c.cueId)}" value="${esc(c.text)}">` +
        `<span class="chip mute">${esc(c.origin)}</span>` +
        `<span class="pc-acts">` +
        `<button class="btn sm" data-pc-cumerge="${esc(c.cueId)}" title="与下一条合并">合并</button>` +
        `<button class="btn sm" data-pc-cusplit="${esc(c.cueId)}" title="在中点拆成两条">拆分</button>` +
        lockBtn("subtitle", c.cueId, c.locked) +
        `<button class="btn sm" data-pc-curm="${esc(c.cueId)}">删除</button>` +
        `</span></li>`).join("")}</ul>`
      : `<div class="pc-none">还没有字幕。有台词和剪辑时长时，「台词 → 字幕」可以直接生成一版。</div>`) +
    `<div class="pc-note">字幕本轮<b>不烧进画面</b>：渲染出来的 MP4 不含字幕，可用「导出 SRT」拿到独立字幕文件。` +
    `本地对齐与语音识别的适配点已经留好，但本轮没有接入——把已有台词原样返回并标成「已转写」会让这个字段永远无法被信任。</div>` +
    `</section>`
  );
}

/* -------------------------------------------------------------------------- */
/* 成片                                                                        */
/* -------------------------------------------------------------------------- */

function finalBody(ctx, m) {
  const s = m.edit.settings;
  const live = m.edit.video.filter((c) => !c.removed);
  return (
    `<div class="pc-head"><b>成片</b>` +
    `<span class="pc-sub">${live.length} 个镜头 · ${secs(m.edit.duration)} · ` +
    `字幕 ${m.subtitles.version ? `v${m.subtitles.version}` : "无"} · 锁定 ${m.locks} 项</span>` +
    `<span class="pc-acts"><button class="btn sm primary" data-pc-render>渲染成片</button></span>` +
    `</div>` +
    `<div class="pc-settings">` +
    `<label>宽 <input type="number" data-pc-set="width" min="16" max="3840" value="${esc(String(s.width))}"></label>` +
    `<label>高 <input type="number" data-pc-set="height" min="16" max="2160" value="${esc(String(s.height))}"></label>` +
    `<label>帧率 <input type="number" data-pc-set="fps" min="1" max="60" value="${esc(String(s.fps))}"></label>` +
    `<label>格式 <select data-pc-set="format">` +
    ["mp4", "webm"].map((f) => `<option value="${f}"${s.format === f ? " selected" : ""}>${f}</option>`).join("") +
    `</select></label>` +
    `</div>` +
    (m.finals.length
      ? `<ul class="pc-finals">${m.finals.map((f) => finalRow(ctx, f)).join("")}</ul>`
      : `<div class="pc-none">还没有渲染过成片。</div>`) +
    `<div class="pc-note">渲染用本地 ffmpeg。移出成片的片段不参与渲染；素材字节不在本地的片段会让渲染<b>明确失败</b>，` +
    `而不是被悄悄跳过——一条少了半个镜头却报成功的成片，比一次失败糟得多。<br>` +
    `本轮的本地渲染器<b>按硬切拼接</b>：转场已经记录在时间线和成片溯源里，但还没有真正渲染出来。` +
    `与其让「叠化」看起来生效、实际出来是硬切，不如在这里说清楚。</div>`
  );
}

/** ONE final's provenance — §57: 「Final 必须可复现」. Every line comes from the
 *  render's own frozen record, not from the timeline as it stands now (which has
 *  moved since). A field the record does not hold prints 未记录. */
function finalRow(ctx, f) {
  const prov = ctx.assets.provenanceOf(f.assetId);
  const p = prov && prov.generation && prov.generation.parameters ? prov.generation.parameters : null;
  const clips = p && Array.isArray(p.clips) ? p.clips : [];
  const vids = clips.filter((c) => c.trackType === "video");
  return (
    `<li class="pc-final">` +
    `<video class="pc-finalv" src="${esc(f.url || "")}" controls preload="metadata"></video>` +
    `<div class="pc-finalm">` +
    `<b>${esc(f.url ? String(f.url).split("/").pop() : "成片")}</b>` +
    (p
      ? `<details class="pc-prov" open><summary>溯源 · 这条成片是什么做出来的</summary>` +
        `<dl class="pi-kv">` +
        `<dt>时间线版本</dt><dd>${p.timelineVersion ? `初剪 v${p.timelineVersion}` : "未经过自动初剪"}` +
        `${p.timelineEdited ? "（含人工调整）" : ""}</dd>` +
        `<dt>镜头与版本</dt><dd>${vids.length
          ? vids.map((c) => `${esc(c.shotId ? shortName(ctx, c.shotId) : "未记录镜头")} · ${c.assetVersion != null ? `v${c.assetVersion}` : "版本未记录"}`).join("；")
          : NONE}</dd>` +
        `<dt>音频来源</dt><dd>${clips.filter((c) => c.trackType !== "video").length
          ? clips.filter((c) => c.trackType !== "video").map((c) => `${esc(TL_TRACK_LABEL[c.trackType] || c.trackType)} · ${esc(assetView(ctx, c.assetId).name)}`).join("；")
          : NONE}</dd>` +
        // only mixes that were REALLY in this render are listed; a shot whose mix
        // sits outside the timeline did not feed it, and saying so would be a
        // lineage the render never had
        `<dt>镜头混音</dt><dd>${Array.isArray(p.shotMixes) && p.shotMixes.length
          ? p.shotMixes.map((x) => `${esc(shortName(ctx, x.shotId))} · ${x.sources.length} 条源素材`).join("；")
          : `<span class="muted">这条成片没有用到镜头混音（各轨由渲染器直接混合）</span>`}</dd>` +
        `<dt>字幕版本</dt><dd>${p.subtitleVersion ? `v${p.subtitleVersion}（${p.subtitleCues} 条）` : NONE}` +
        `${p.subtitleBurnedIn === false ? "，未烧入画面" : ""}</dd>` +
        `<dt>转场</dt><dd>${vids.some((c) => c.transition && c.transition !== "cut")
          ? vids.filter((c) => c.transition && c.transition !== "cut").map((c) => `${esc(shortName(ctx, c.shotId))} ${esc(TRANSITION_LABEL[c.transition] || c.transition)} ${c.transitionMs}ms`).join("；")
          : "全部硬切"}</dd>` +
        `<dt>渲染设置</dt><dd>${p.settings ? esc(`${p.settings.width}×${p.settings.height} @${p.settings.fps} ${p.settings.format}`) : NONE}</dd>` +
        `<dt>锁定项</dt><dd>${Number.isInteger(p.locksInForce) ? `${p.locksInForce} 项` : NONE}</dd>` +
        `</dl></details>`
      : `<div class="pc-note">这条成片没有渲染记录（可能来自更早的构建）——来源如实记为未知。</div>`) +
    `</div></li>`
  );
}

function shortName(ctx, shotId) {
  if (!shotId) return "未记录镜头";
  const s = ctx.shot.find(shotId);
  return s ? (s.title || `镜头 ${s.sequence}`) : `${String(shotId).slice(0, 8)}（已不在草稿里）`;
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The console. `mode` is "dock" (the strip under 剧集制作's centre) or "full"
 * (the 剪辑 workspace). Same component, same handlers — 「展开」 can never show a
 * different tool than the dock.
 */
export function renderPostConsole(ctx, ui, { mode = "dock" } = {}) {
  const m = postModel(ctx, ui);
  const collapsed = mode === "dock" && ui.postOpen === false;
  const tabs = POST_TABS.map(([k, icon, label]) =>
    `<button class="pc-tab${m.tab === k ? " on" : ""}" data-pc-tab="${k}">` +
    `<span class="ic">${icon}</span>${esc(label)}</button>`).join("");
  const head =
    `<header class="pc-bar">` +
    (mode === "dock"
      ? `<button class="pc-toggle" data-pc-toggle title="${collapsed ? "展开后期控制台" : "收起"}">${collapsed ? "▴" : "▾"}</button>`
      : "") +
    `<span class="pc-title">后期控制台</span>` +
    `<nav class="pc-tabs">${tabs}</nav>` +
    `<span class="pc-barnote">${m.edit.roughCutVersion ? `初剪 v${m.edit.roughCutVersion}` : "还没有初剪"}` +
    ` · 锁定 ${m.locks} 项</span>` +
    (mode === "dock"
      ? `<button class="pc-expand" data-mod="edit" title="在整页里打开后期控制台">展开 ↗</button>`
      : `<button class="pc-expand" data-mod="provenance" title="回到生成溯源">← 生成溯源</button>`) +
    `</header>`;
  if (collapsed) return `<div class="pc pc-${mode} collapsed">${head}</div>`;
  const body =
    m.tab === "shotaudio" ? shotAudioBody(m)
    : m.tab === "final" ? finalBody(ctx, m)
    : editBody(m);
  return (
    `<div class="pc pc-${mode}">${head}` +
    `<div class="pc-body">${body}</div>` +
    (ui.postPreview ? previewBody(m) : "") +
    `</div>`
  );
}

/** PREVIEW — the picture, in cut order, played back-to-back from the real files.
 *
 *  HONEST ABOUT WHAT IT IS: the audio tracks are NOT mixed here. Mixing six
 *  tracks live in a browser would be a different product; what the creator hears
 *  in the render is what the render produces. Saying so is better than a preview
 *  that quietly plays only the first clip's sound and is believed. */
function previewBody(m) {
  const live = m.edit.video.filter((c) => !c.removed && c.asset.available);
  const list = live.map((c) => ({
    url: c.asset.url, in: c.trimIn, out: c.trimOut, title: c.shotTitle || "",
  }));
  return (
    `<div class="pc-preview" data-pc-playlist='${esc(JSON.stringify(list))}'>` +
    `<div class="pc-pvhead"><b>预览</b>` +
    `<span class="pc-sub">${live.length} 个镜头，按剪辑顺序连续播放</span>` +
    `<button class="btn sm" data-pc-pvclose>关闭</button></div>` +
    (list.length
      ? `<video class="pc-pv" controls playsinline></video><div class="pc-pvnow"></div>`
      : `<div class="pc-none">没有可预览的画面（片段为空，或素材字节不在本地）。</div>`) +
    `<div class="pc-note">预览只放画面：多轨声音不在浏览器里实时混合，最终声音以渲染结果为准。</div>` +
    `</div>`
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every handler dispatches a NAMED ACTION (§52). Nothing here writes a document
 * directly, so the AI Director's 「应用」 and a human click go through the same
 * guards, the same locks and the same refusals.
 */
export function bindPostConsole(root, ctx, ui, render) {
  const on = (q, fn) => { const el = root.querySelector(q); if (el) el.onclick = fn; };
  const all = (attr, fn) => root.querySelectorAll(`[${attr}]`).forEach((el) => fn(el));
  const shotId = () => ui.selectedShotId || null;
  /** Dispatch + report. A refused action must SAY why — a button that silently
   *  does nothing is how a lock looks like a bug. */
  const act = (envelope, okMsg) => {
    const res = ctx.actions.dispatch(envelope);
    if (res.ok) { if (okMsg) ctx.toast(okMsg); }
    else if (!res.satisfied) ctx.toast(res.error);
    render();
    return res;
  };

  all("data-pc-tab", (b) => (b.onclick = () => { ui.postTab = b.dataset.pcTab; ui.postOpen = true; render(); }));
  on("[data-pc-toggle]", () => { ui.postOpen = ui.postOpen === false; render(); });

  // --- 镜头音频 ----------------------------------------------------------- //
  on("[data-pc-autoarrange]", () => act({ action: "autoArrangeShotAudio", shotId: shotId() }, "已按现有素材自动排入"));
  on("[data-pc-mix]", async () => {
    const btn = root.querySelector("[data-pc-mix]");
    if (btn) { btn.disabled = true; btn.textContent = "混音中…"; }
    try {
      await ctx.shotAudio.mixNow(shotId());
    } catch (e) {
      ctx.toast(`混音失败：${e.message}`);
    }
    render();
  });
  on("[data-pc-addclip]", async () => {
    const picked = await pickAudioAsset(ctx);
    if (!picked) return;
    act({
      action: "addAudioClip",
      shotId: shotId(),
      clip: { assetId: picked.assetId, trackType: picked.trackType, startTimeMs: 0, origin: "manual" },
    }, "已添加片段");
  });
  all("data-pc-mode", (sel) => (sel.onchange = () => {
    const clipId = sel.dataset.pcMode;
    // switching MODE is a move: the two timings are exclusive, so the clip gets
    // exactly one of them. A default anchor is used when switching to anchored —
    // `shot:start` is the one anchor every shot has.
    act({
      action: "moveAudioClip",
      shotId: shotId(),
      clipId,
      timing: sel.value === "anchored" ? { anchor: "shot:start", offsetMs: 0 } : { startTimeMs: 0 },
    });
  }));
  const numChange = (attr, build) => all(attr, (inp) => (inp.onchange = () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v)) { render(); return; }
    build(inp.dataset[attrToProp(attr)], v);
  }));
  numChange("data-pc-start", (clipId, v) => act({ action: "moveAudioClip", shotId: shotId(), clipId, timing: { startTimeMs: v } }));
  numChange("data-pc-offset", (clipId, v) => {
    const cur = clipOf(ctx, clipId);
    if (!cur || !cur.anchor) { render(); return; }
    act({ action: "moveAudioClip", shotId: shotId(), clipId, timing: { anchor: cur.anchor, offsetMs: v } });
  });
  all("data-pc-anchorof", (inp) => (inp.onchange = () => {
    const clipId = inp.dataset.pcAnchorof;
    const cur = clipOf(ctx, clipId);
    act({
      action: "moveAudioClip", shotId: shotId(), clipId,
      timing: { anchor: inp.value.trim(), offsetMs: cur ? cur.offsetMs : 0 },
    });
  }));
  numChange("data-pc-gain", (clipId, v) => act({ action: "setGain", shotId: shotId(), clipId, gain: v }));
  numChange("data-pc-fadein", (clipId, v) => {
    const cur = clipOf(ctx, clipId);
    act({ action: "setFade", shotId: shotId(), clipId, fadeInMs: v, fadeOutMs: cur ? cur.fadeOutMs : 0 });
  });
  numChange("data-pc-fadeout", (clipId, v) => {
    const cur = clipOf(ctx, clipId);
    act({ action: "setFade", shotId: shotId(), clipId, fadeInMs: cur ? cur.fadeInMs : 0, fadeOutMs: v });
  });
  all("data-pc-mute", (b) => (b.onclick = () => {
    const cur = clipOf(ctx, b.dataset.pcMute);
    act({ action: "setAudioMuted", shotId: shotId(), clipId: b.dataset.pcMute, muted: !(cur && cur.muted) });
  }));
  all("data-pc-rmclip", (b) => (b.onclick = () => act({ action: "removeAudioClip", shotId: shotId(), clipId: b.dataset.pcRmclip }, "已移除片段")));
  all("data-pc-replace", (b) => (b.onclick = async () => {
    const picked = await pickAudioAsset(ctx);
    if (!picked) return;
    const hit = ctx.shotAudio.clips(shotId()).find((c) => c.clipId === b.dataset.pcReplace);
    if (!hit) { ctx.toast("片段不存在"); render(); return; }
    ctx.shotAudio.replaceAsset(shotId(), b.dataset.pcReplace, picked.assetId);
    render();
  }));

  // --- 剪辑 --------------------------------------------------------------- //
  on("[data-pc-rough]", () => {
    const res = ctx.actions.dispatch({ action: "buildRoughCut", episodeId: ctx.prodData().production.activeEpisodeId });
    ctx.toast(res.ok ? `初剪完成：${res.detail}` : `未生成初剪：${res.error}`);
    render();
  });
  // 按当前素材重建 — the ONE destructive edit in this console, and the only way
  // back for a timeline whose clips predate version pinning (they carry
  // `origin: manual`, so the Rough Cut correctly refuses to touch them and they
  // can never pick up a pin on their own). Confirmed, and it says exactly what
  // it discards; unmounting the old 剪辑 workspace had left it unreachable.
  on("[data-pc-resync]", () => {
    if (!window.confirm("按当前镜头 / 音频从头重建时间线？\n\n所有手工调整（顺序、修剪、音量、转场、移出）都会被本次重建覆盖。锁定项也不会保留。")) return;
    ctx.timeline.resync();
    render();
  });
  on("[data-pc-preview]", () => { ui.postPreview = true; render(); });
  on("[data-pc-pvclose]", () => { ui.postPreview = false; render(); });
  all("data-pc-vmove", (b) => (b.onclick = () => {
    const clipId = b.dataset.pcVmove;
    const m = postModel(ctx, ui);
    const cur = m.edit.video.findIndex((c) => c.clipId === clipId);
    if (cur < 0) return;
    act({ action: "moveTimelineClip", clipId, index: cur + Number(b.dataset.pcDir) });
  }));
  all("data-pc-vtrim", (inp) => (inp.onchange = () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v <= 0) { render(); return; }
    // 时长 changes the OUT point, keeping the clip's existing IN point. Sending
    // `inMs: 0` reset a non-zero trim-in, so adjusting the length of a clip that
    // started part-way into its source silently changed WHICH part of the shot
    // plays — a content change disguised as a duration tweak.
    const clipId = inp.dataset.pcVtrim;
    const m = postModel(ctx, ui);
    const clip = m.edit.video.find((c) => c.clipId === clipId);
    const inMs = clip ? Math.round(clip.trimIn * 1000) : 0;
    act({ action: "trimTimelineClip", clipId, inMs, outMs: inMs + v * 1000 });
  }));
  all("data-pc-trans", (sel) => (sel.onchange = () => act({
    action: "setTransition", clipId: sel.dataset.pcTrans, kind: sel.value, durationMs: 500,
  })));
  all("data-pc-vremove", (b) => (b.onclick = () => act({ action: "removeTimelineClip", clipId: b.dataset.pcVremove }, "已移出成片（可以恢复）")));
  all("data-pc-vrestore", (b) => (b.onclick = () => act({ action: "restoreTimelineClip", clipId: b.dataset.pcVrestore }, "已恢复到成片里")));
  all("data-pc-tvol", (inp) => (inp.onchange = () => act({
    action: "setTimelineVolume", clipId: inp.dataset.pcTvol, volume: Number(inp.value),
  })));
  all("data-pc-vreplace", (b) => (b.onclick = () => {
    const m = postModel(ctx, ui);
    const clip = m.edit.video.find((c) => c.clipId === b.dataset.pcVreplace);
    if (!clip || !clip.shotId) { ctx.toast("这个片段没有绑定镜头，无法列出它的其它版本"); return; }
    const shot = ctx.shot.find(clip.shotId);
    const slot = shot ? ctx.shot._slotOf(shot) : null;
    const chain = slot ? ctx.assets.chainOf(slot) : null;
    const others = chain ? chain.list.filter((v) => v.assetId && v.assetId !== clip.assetId) : [];
    if (!others.length) { ctx.toast("这个镜头只有当前这一条视频版本"); return; }
    const want = window.prompt(
      `换成哪一版？\n${others.map((v) => `v${v.version}${v.current ? "（当前）" : ""}`).join("\n")}\n\n输入版本号：`,
      String(others[others.length - 1].version),
    );
    const pick = others.find((v) => String(v.version) === String(want || "").trim());
    if (!pick) return;
    act({ action: "replaceTimelineAsset", clipId: clip.clipId, assetId: pick.assetId }, `已换为 v${pick.version}`);
  }));
  // the drift's three exits (§48) — 保持 does nothing on purpose, and says so
  all("data-pc-driftkeep", (b) => (b.onclick = () => {
    ctx.toast("保持当前版本：时间线不变，提示会一直在，直到你换版本或改回上游");
  }));
  all("data-pc-driftreplace", (b) => (b.onclick = () => act(
    { action: "replaceTimelineAsset", clipId: b.dataset.pcDriftreplace, assetId: b.dataset.pcAsset },
    "已替换为当前版本",
  )));
  all("data-pc-driftcompare", (b) => (b.onclick = () => {
    const m = postModel(ctx, ui);
    const d = m.edit.drift.find((x) => x.clipId === b.dataset.pcDriftcompare);
    if (!d) return;
    // COMPARE opens the shot's video panel on the left, where both takes are
    // listed with previews. A second comparison surface here would be a third
    // place the same versions are shown.
    ui.selectedShotId = d.shotId;
    ui.inspect = { ...(ui.inspect || {}), kind: "video", shotId: d.shotId };
    ctx.toast("已在左栏打开这个镜头的视频版本列表：两条 take 都能直接预览");
    render();
  }));

  // --- 字幕 --------------------------------------------------------------- //
  all("data-pc-subgen", (b) => (b.onclick = () => {
    const id = b.dataset.pcSubgen;
    const probe = ctx.subtitles.tryAdapter(id);
    if (!probe.ok) { ctx.toast(probe.error); return; }
    const res = ctx.actions.dispatch({ action: "buildSubtitles", episodeId: ctx.prodData().production.activeEpisodeId });
    ctx.toast(res.ok ? res.detail : `未生成字幕：${res.error}`);
    render();
  }));
  all("data-pc-substyle", (sel) => (sel.onchange = () => { ctx.subtitles.setStyle(sel.value); render(); }));
  const cueEdit = (attr, field, numeric) => all(attr, (inp) => (inp.onchange = () => {
    const cueId = inp.dataset[attrToProp(attr)];
    const v = numeric ? Number(inp.value) : inp.value;
    if (numeric && !Number.isFinite(v)) { render(); return; }
    act({ action: "updateSubtitle", cueId, fields: { [field]: v } });
  }));
  cueEdit("data-pc-custart", "startMs", true);
  cueEdit("data-pc-cuend", "endMs", true);
  cueEdit("data-pc-cutext", "text", false);
  cueEdit("data-pc-cuspk", "speaker", false);
  all("data-pc-cumerge", (b) => (b.onclick = () => act({ action: "updateSubtitle", cueId: b.dataset.pcCumerge, fields: { mergeWithNext: true } }, "已与下一条合并")));
  all("data-pc-cusplit", (b) => (b.onclick = () => {
    const m = postModel(ctx, ui);
    const c = m.subtitles.cues.find((x) => x.cueId === b.dataset.pcCusplit);
    if (!c) return;
    const mid = Math.round((c.startMs + c.endMs) / 2);
    const ok = ctx.subtitles.split(c.cueId, mid, Math.ceil(c.text.length / 2));
    if (!ok) ctx.toast("拆不开：两半都必须够长才能读得到（也可能这条已锁定）");
    render();
  }));
  all("data-pc-curm", (b) => (b.onclick = () => {
    if (!ctx.subtitles.remove(b.dataset.pcCurm)) ctx.toast("这条字幕已锁定：先解锁再删除");
    render();
  }));
  on("[data-pc-srt]", () => {
    const text = ctx.subtitles.srt();
    if (!text.trim()) { ctx.toast("字幕轨是空的，没有可导出的内容"); return; }
    downloadText(text, `subtitles-${ctx.prodData().production.activeEpisodeId || "episode"}.srt`);
  });

  // --- 成片 --------------------------------------------------------------- //
  all("data-pc-set", (inp) => (inp.onchange = () => {
    const key = inp.dataset.pcSet;
    ctx.timeline.setSettings({ [key]: key === "format" ? inp.value : Number(inp.value) });
    render();
  }));
  on("[data-pc-render]", async () => {
    const btn = root.querySelector("[data-pc-render]");
    if (btn) { btn.disabled = true; btn.textContent = "渲染中…"; }
    try {
      const res = await ctx.timeline.render();
      ctx.toast(`成片已渲染 · v${res.version}`);
    } catch (e) {
      ctx.toast(`渲染失败：${e.message}`);
    }
    render();
  });

  // --- LOCK (§50) — one control, whichever document owns the flag ----------- //
  all("data-pc-lock", (b) => (b.onclick = () => {
    const scope = b.dataset.pcLock;
    const id = b.dataset.pcLockid;
    act({ action: ctx.locks.is(scope, id) ? "unlockItem" : "lockItem", scope, id });
  }));

  // --- the sequential PREVIEW player --------------------------------------- //
  const pv = root.querySelector(".pc-pv");
  if (pv) mountPreview(root, pv);
}

/** `data-pc-foo` → the `dataset` property name `pcFoo`. */
function attrToProp(attr) {
  return attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function clipOf(ctx, clipId) {
  for (const shotId of Object.keys(ctx.prodData().shotAudio || {})) {
    const c = ctx.shotAudio.clips(shotId).find((x) => x.clipId === clipId);
    if (c) return c;
  }
  return null;
}

/** Pick one AUDIO asset from the project, with the track it should land on. Uses
 *  the ordinary library read model — the console never opens its own index. */
async function pickAudioAsset(ctx) {
  const rows = ctx.assets.library({ type: "all", variant: "all" }).rows
    .filter((r) => r.domain === "audio");
  if (!rows.length) { ctx.toast("项目里还没有音频资产——先在「资产库」或音频工作区上传"); return null; }
  const want = window.prompt(
    `选一条音频（输入编号）：\n${rows.map((r, i) => `${i + 1}. ${r.name}${r.kind ? `（${r.kind}）` : ""}`).join("\n")}`,
    "1",
  );
  const i = Number(want) - 1;
  const row = rows[i];
  if (!row) return null;
  // the TRACK follows the asset's DECLARED kind. A kind the tracks do not cover
  // lands on sfx and says so — guessing silently is how a BGM ends up as dialogue.
  const track = SHOT_TRACKS.includes(row.kind) ? row.kind : "sfx";
  if (track !== row.kind) ctx.toast(`「${row.name}」的类型是 ${row.kind || "未分类"}，已放到「音效」轨——需要的话在轨上换`);
  return { assetId: row.assetId, trackType: track };
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Play the video clips back-to-back, each within its own trim window.
 *
 * A real sequential preview of the CUT, not of one clip: it advances at each
 * clip's out point and reports which shot is on screen. It plays PICTURE ONLY —
 * see previewBody for why that is stated rather than hidden.
 */
function mountPreview(root, video) {
  const box = root.querySelector(".pc-preview");
  const now = root.querySelector(".pc-pvnow");
  let list = [];
  try { list = JSON.parse(box.dataset.pcPlaylist || "[]"); } catch { list = []; }
  if (!list.length) return;
  let i = 0;
  const load = (n) => {
    if (n >= list.length) { if (now) now.textContent = "播放完毕"; return; }
    i = n;
    const c = list[n];
    if (now) now.textContent = `${n + 1}/${list.length} · ${c.title || ""}`;
    video.src = c.url;
    video.currentTime = c.in;
    const seek = () => {
      video.currentTime = c.in;
      video.removeEventListener("loadedmetadata", seek);
      video.play().catch(() => { /* autoplay refused — the controls still work */ });
    };
    video.addEventListener("loadedmetadata", seek);
  };
  video.ontimeupdate = () => {
    const c = list[i];
    if (c && video.currentTime >= c.out) load(i + 1);
  };
  video.onended = () => load(i + 1);
  load(0);
}
