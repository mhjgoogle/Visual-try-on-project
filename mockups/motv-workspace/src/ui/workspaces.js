// Production module workspaces (checkpoint: read-only status surfaces).
//
// One render function per production stage (创意/分镜/资产/视频/音频/剪辑 —
// 剧本 keeps its full workspace in production.js). Each renders CURRENT
// project state from the read-only ctx.prodData() snapshot; a stage with no
// data opens to an explicit empty/needs-input state, never a disabled item.
// Pure view-model builders (`*Model`) are exported for node --test; nothing
// here mutates workflow nodes, domain state, or triggers generation.
import { esc } from "../util/dom.js";
import { slotEntry, currentRef } from "../workflow/mediaref.js";

const nn = (seq) => String(seq).padStart(2, "0");

// ---------- pure view-models --------------------------------------------- //

/** 创意: the Creative Brief (scriptDoc-owned) + script standing. */
export function ideaModel(doc) {
  const p = doc.pending;
  return {
    brief: doc.brief,
    hasScript: doc.versions.length > 0 || !!(doc.workingText && doc.workingText.trim()),
    scriptVersions: doc.versions.length,
    activeVersion: doc.active,
    pending: p ? p.status : null,
  };
}

/** 分镜: current shots — structured draft first, else the scriptgen node's
 *  display rows, else the project's real locked records. */
export function shotsModel(pd) {
  const lock = pd.lockedPlan ? { planVersion: pd.lockedPlan.plan_version } : null;
  const versions = pd.shotVersions
    ? { count: pd.shotVersions.count, cur: pd.shotVersions.cur }
    : null;
  if (pd.draftShots && pd.draftShots.length) {
    return {
      empty: false,
      kind: "draft",
      lock,
      versions,
      shots: pd.draftShots.map((s) => ({
        seq: s.sequence,
        title: s.title,
        description: s.description || "",
        duration: s.duration_seconds ?? null,
        slot: s.slot || null,
      })),
    };
  }
  const rows = (pd.shotVersions && pd.shotVersions.rows) || pd.realShots;
  if (rows && rows.length) {
    return {
      empty: false,
      kind: pd.shotVersions && pd.shotVersions.rows ? "rows" : "records",
      lock,
      versions,
      shots: rows.map((r, i) => ({
        seq: i + 1,
        title: r[1],
        description: "",
        duration: null,
        slot: null,
      })),
    };
  }
  return { empty: true, lock, versions };
}

/** Media slots are keyed by DRAFT slot ids — when only display rows / real
 *  locked records exist, shots are still surfaced as context so the empty
 *  state never claims "nothing exists" against a project that has shots. */
function shotContext(pd) {
  const m = shotsModel(pd);
  return m.empty || m.kind === "draft" ? null : { count: m.shots.length, kind: m.kind };
}

/** 资产: per current shot — image slot standing (versions, origin). */
export function assetsModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], context: shotContext(pd) };
  const items = pd.draftShots.map((s) => {
    const e = s.slot ? slotEntry(pd.assetUploads, s.slot) : null;
    const ref = s.slot ? currentRef(pd.assetUploads, s.slot) : null;
    return {
      seq: s.sequence,
      title: s.title,
      slot: s.slot || null,
      url: ref ? ref.url : "",
      versions: e ? e.history.length : 0,
      current: e ? e.current : 0,
      origin: ref ? ref.origin : null,
    };
  });
  return { empty: false, items, done: items.filter((x) => x.url).length, total: items.length };
}

/** The official shot id a paid op binds for a draft sequence (mirror of the
 *  ctx.lockedShotId rule, kept pure for the read-only view). */
function opShotId(pd, seq) {
  const row = pd.lockedPlan && pd.lockedPlan.shots && pd.lockedPlan.shots[seq - 1];
  return row ? row.shot_id : `shot-${seq}`;
}

/** 视频: per current shot — clip standing, KNOWN first-frame lineage (absent
 *  = honestly unknown, never invented), paid-op status projection. */
export function videoModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], context: shotContext(pd) };
  const items = pd.draftShots.map((s) => {
    const k = s.slot || null;
    const e = k ? slotEntry(pd.media.video, k) : null;
    const ref = k ? currentRef(pd.media.video, k) : null;
    const ff = k ? pd.firstFrames[k] : null;
    const op = pd.paidOps[opShotId(pd, s.sequence)] || null;
    return {
      seq: s.sequence,
      title: s.title,
      url: ref ? ref.url : "",
      versions: e ? e.history.length : 0,
      origin: ref ? ref.origin : null,
      // lineage: only what the data actually records
      firstFrame: ff ? { version: ff.version, origin: ff.origin || "upload", url: ff.url } : null,
      opStatus: op ? op.status : null,
    };
  });
  return { empty: false, items, done: items.filter((x) => x.url).length, total: items.length };
}

/** 音频: per current shot voice slot + optional music/sfx extras. */
export function audioModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], extras: [], context: shotContext(pd) };
  const entry = (k) => {
    const e = slotEntry(pd.media.audio, k);
    const ref = currentRef(pd.media.audio, k);
    return { url: ref ? ref.url : "", versions: e ? e.history.length : 0, origin: ref ? ref.origin : null };
  };
  const items = pd.draftShots.map((s) => ({
    seq: s.sequence,
    title: s.title,
    ...entry(s.slot ? `voice-${s.slot}` : ""),
  }));
  const extras = [
    { key: "music-main", label: "🎼 背景音乐", ...entry("music-main") },
    { key: "sfx-main", label: "🔊 音效", ...entry("sfx-main") },
  ];
  return { empty: false, items, extras, done: items.filter((x) => x.url).length, total: items.length };
}

/** 剪辑: per-shot readiness (video/voice present) + composed finals. */
export function editModel(pd) {
  const finals = pd.finals || [];
  if (!pd.draftShots || !pd.draftShots.length) {
    return {
      empty: true,
      items: [],
      finals: finals.length,
      lastFinal: finals[finals.length - 1] || "",
      context: shotContext(pd),
    };
  }
  const items = pd.draftShots.map((s) => ({
    seq: s.sequence,
    title: s.title,
    video: !!(s.slot && currentRef(pd.media.video, s.slot)),
    voice: !!(s.slot && currentRef(pd.media.audio, `voice-${s.slot}`)),
  }));
  return {
    empty: false,
    items,
    ready: items.filter((x) => x.video).length,
    total: items.length,
    finals: finals.length,
    lastFinal: finals[finals.length - 1] || "",
  };
}

// ---------- shared render helpers ---------------------------------------- //

const ORIGIN_ZH = {
  upload: "手工上传", "paid-image": "付费生成", "paid-video": "付费生成",
  adopted: "付费入槽", tts: "本地 TTS",
};

function empty(icon, title, hints) {
  return `<div class="ws-empty"><div class="ic">${icon}</div><div class="tt">${title}</div>${hints
    .map((h) => `<div class="hh">${h}</div>`)
    .join("")}</div>`;
}

/** Honest media empty state: when shots DO exist (real records / title rows)
 *  but media slots can't attach (they follow draft slot ids), say exactly
 *  that instead of "nothing exists yet". */
function mediaEmpty(icon, what, context, hints) {
  if (context) {
    const kindZh = context.kind === "records" ? "正式镜头记录" : "镜头标题行";
    return empty(icon, `项目已有 ${context.count} 个${kindZh}，但${what}槽位尚不可归属`, [
      "媒体槽位跟随分镜草稿的镜头 slot；当前没有活动草稿",
      "在工作流视图「脚本生成器」生成/恢复分镜草稿后，这里会按镜头显示媒体",
    ]);
  }
  return empty(icon, `还没有${what}`, hints);
}

function head(title, meta) {
  return `<div class="pm-head"><div class="pm-title">${title}</div><div class="pm-note">${meta}</div></div>`;
}

// ---------- workspaces ---------------------------------------------------- //

export function renderIdea(ctx) {
  const m = ideaModel(ctx.script.doc());
  const status = m.hasScript
    ? m.scriptVersions
      ? `✓ 已有剧本 · 当前 v${m.activeVersion}（共 ${m.scriptVersions} 个版本）`
      : "✓ 已有剧本草稿（未版本化）"
    : "尚无剧本 — 在剧本工作区用创意生成 v1";
  const pending = m.pending === "generating"
    ? `<div class="ws-kv gate">⏳ 有一个生成正在进行（见剧本工作区）</div>`
    : m.pending === "proposed"
      ? `<div class="ws-kv gate">📝 有一份修订稿提案待处理（见剧本工作区）</div>`
      : m.pending === "failed"
        ? `<div class="ws-kv gate">⚠ 上次生成失败（见剧本工作区）</div>`
        : "";
  return (
    head("💡 创意工作区", "创意是剧本的输入 · 与剧本工作区同源") +
    `<div class="pm-brief"><label class="pa-lab">创意 / 想法（Creative Brief）</label><textarea class="brieftext pm-brieftext" rows="4" spellcheck="false" placeholder="一句话创意，例如：社畜穿越盛唐，被逼当殿作诗">${esc(ctx.script.doc().brief)}</textarea></div>` +
    `<div class="ws-kv">${esc(status)}</div>` + pending +
    `<button class="nrun ws-jump" data-goto="script">→ 去剧本工作区${m.hasScript ? "" : "生成 v1"}</button>`
  );
}

export function renderShots(ctx) {
  const m = shotsModel(ctx.prodData());
  const meta = [
    m.versions && m.versions.count ? `版本 v${m.versions.cur}/${m.versions.count}` : "",
    m.lock ? `🔒 已锁定 plan v${esc(String(m.lock.planVersion))}` : "未锁定",
  ].filter(Boolean).join(" · ");
  if (m.empty) {
    return head("🎞 分镜工作区", meta) + empty("🎞", "还没有生成分镜", [
      "前置：剧本（可在剧本工作区生成/编辑）",
      "在工作流视图的「脚本生成器」节点点「基于剧本生成分镜」",
    ]);
  }
  const rows = m.shots
    .map(
      (s) =>
        `<div class="ws-row"><span class="n mono">${esc(nn(s.seq))}</span><div class="ws-main"><b>${esc(s.title)}</b>${s.description ? `<div class="ws-desc">${esc(s.description)}</div>` : ""}</div>${s.duration != null ? `<span class="ws-tag">${esc(String(s.duration))}s</span>` : ""}</div>`,
    )
    .join("");
  const note = m.kind === "draft" ? "" : `<div class="ws-kv">（当前仅有镜头标题行 — 结构化草稿在生成分镜后可见）</div>`;
  return head("🎞 分镜工作区", `${m.shots.length} 个镜头 · ${meta} · 只读`) + note + `<div class="ws-list">${rows}</div>`;
}

export function renderAssets(ctx) {
  const m = assetsModel(ctx.prodData());
  if (m.empty) {
    return head("🧑‍🎨 资产工作区", "只读") + mediaEmpty("🧑‍🎨", "图片资产", m.context, [
      "前置：分镜（分镜工作区当前为空则先生成分镜）",
      "生成分镜后，在工作流视图的「资产准备」节点按镜头上传/生成图片",
    ]);
  }
  const rows = m.items
    .map((x) => {
      const thumb = x.url
        ? `<img class="athumb" src="${esc(x.url)}" alt="">`
        : `<span class="aph">无图</span>`;
      const meta = x.url
        ? `v${x.current} · 共 ${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")}`
        : "缺图";
      return `<div class="ws-row">${thumb}<div class="ws-main"><b>${esc(nn(x.seq))} ${esc(x.title)}</b><div class="ws-desc">${meta}</div></div></div>`;
    })
    .join("");
  return head("🧑‍🎨 资产工作区", `图片就绪 ${m.done}/${m.total} · 只读`) + `<div class="ws-list">${rows}</div>`;
}

export function renderVideo(ctx) {
  const m = videoModel(ctx.prodData());
  if (m.empty) {
    return head("▶ 视频工作区", "只读") + mediaEmpty("▶", "视频", m.context, [
      "前置：分镜 + （可选）每镜头首帧图",
      "生成分镜后，在工作流视图的「视频生成」节点手工上传或付费生成",
    ]);
  }
  const rows = m.items
    .map((x) => {
      const thumb = x.url
        ? `<video class="athumb" src="${esc(x.url)}" muted preload="metadata"></video>`
        : `<span class="aph">无片</span>`;
      const ff = x.firstFrame
        ? `首帧：资产 v${esc(String(x.firstFrame.version))}（${esc(ORIGIN_ZH[x.firstFrame.origin] || x.firstFrame.origin)}）`
        : "首帧来源：未记录";
      const op = x.opStatus
        ? x.opStatus === "committed" ? " · ✓已付费" : ` · ⏳${esc(x.opStatus)}`
        : "";
      const meta = x.url
        ? `${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")} · ${ff}${op}`
        : `缺片 · ${ff}${op}`;
      return `<div class="ws-row">${thumb}<div class="ws-main"><b>${esc(nn(x.seq))} ${esc(x.title)}</b><div class="ws-desc">${meta}</div></div></div>`;
    })
    .join("");
  return head("▶ 视频工作区", `视频就绪 ${m.done}/${m.total} · 只读`) + `<div class="ws-list">${rows}</div>`;
}

export function renderAudio(ctx) {
  const m = audioModel(ctx.prodData());
  if (m.empty) {
    return head("🎵 音频工作区", "只读") + mediaEmpty("🎵", "音频", m.context, [
      "前置：分镜（每镜头一段配音）",
      "生成分镜后，在工作流视图的「音频生成」节点上传或本地 TTS 自动配音",
    ]);
  }
  const row = (label, x) => {
    const player = x.url ? `<audio class="aaud" src="${esc(x.url)}" controls preload="none"></audio>` : "";
    const meta = x.url ? `${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")}` : "缺音频";
    return `<div class="ws-row"><div class="ws-main"><b>${label}</b><div class="ws-desc">${meta}</div>${player}</div></div>`;
  };
  const rows = m.items.map((x) => row(`🎤 ${esc(nn(x.seq))} ${esc(x.title)}`, x)).join("");
  const extras = m.extras.map((x) => row(esc(x.label), x)).join("");
  return head("🎵 音频工作区", `配音就绪 ${m.done}/${m.total} · 只读`) + `<div class="ws-list">${rows}${extras}</div>`;
}

export function renderEdit(ctx) {
  const m = editModel(ctx.prodData());
  const finals = m.finals
    ? `<div class="ws-kv ok">✓ 已合成成片 ${m.finals} 版（最新 v${m.finals}）</div><video class="afinal" src="${esc(m.lastFinal)}" controls preload="metadata"></video>`
    : "";
  if (m.empty) {
    return head("✂ 剪辑工作区", "只读") + finals + mediaEmpty("✂", "可剪辑素材", m.context, [
      "前置：每镜头视频（+ 可选配音/音乐）",
      "素材齐后在工作流视图的「剪辑合成」节点本地 FFmpeg 合成（免费）",
    ]);
  }
  const rows = m.items
    .map((x) => `<div class="ws-row"><span class="n mono">${esc(nn(x.seq))}</span><div class="ws-main"><b>${esc(x.title)}</b></div><span class="ws-tag">${x.video ? "🎞✓" : "🎞–"}</span><span class="ws-tag">${x.voice ? "🎤✓" : "🎤–"}</span></div>`)
    .join("");
  const hint = m.ready >= m.total
    ? `<div class="ws-kv ok">✓ ${m.ready}/${m.total} 镜头视频就绪 — 可在工作流「剪辑合成」节点合成</div>`
    : `<div class="ws-kv gate">还差 ${m.total - m.ready} 个镜头视频（视频工作区可查看缺口）</div>`;
  return head("✂ 剪辑工作区", `素材就绪 ${m.ready}/${m.total} · 只读`) + finals + `<div class="ws-list">${rows}</div>` + hint;
}
