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
import { buildShotSlotIndex, slotForShotId, buildServerBridge, serverShotIdForShot } from "../workflow/shotmap.js";
import { episodeView, sceneOfShot } from "../workflow/proddoc.js";

const nn = (seq) => String(seq).padStart(2, "0");

// M4b — creator-facing media joins resolve by CANONICAL creativeShotId, not by
// draft position. For a draft shot, resolve its storage slot via the
// authoritative-draft index (creativeShotId → slot), then look media up by that
// slot in the Asset Registry. Returns { slot, unresolved }:
//  - slot: the storage key to look media up by (null when none/unresolvable);
//  - unresolved: the shot HAS a slot binding that CANNOT be proven (ambiguous
//    identity) — callers show "unknown", never guess by slot/sequence (M4 §5).
// A shot with a shotId but no slot yet is simply empty (not unresolved). A
// legacy shot with no creativeShotId falls back to its carried slot (compat).
function shotSlot(index, s) {
  if (typeof s.shotId === "string" && s.shotId) {
    const slot = slotForShotId(index, s.shotId);
    if (slot) return { slot, unresolved: false };
    const hasSlot = typeof s.slot === "string" && !!s.slot;
    return { slot: null, unresolved: hasSlot }; // has a slot that won't resolve → ambiguous
  }
  return { slot: s.slot || null, unresolved: false }; // legacy: no canonical identity
}

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
    const idx = buildShotSlotIndex(pd.draftShots);
    return {
      empty: false,
      kind: "draft",
      lock,
      versions,
      shots: pd.draftShots.map((s) => {
        const { slot, unresolved } = shotSlot(idx, s);
        return {
          seq: s.sequence,
          title: s.title,
          description: s.description || "",
          duration: s.duration_seconds ?? null,
          slot, // canonical (creativeShotId → slot); null when none/unresolved
          unresolved,
          // canonical identity + its scene assignment (M6) — display only
          shotId: typeof s.shotId === "string" && s.shotId ? s.shotId : null,
        };
      }),
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

/** 剧集: the Production domain structure (M6) — episodes, the active episode's
 *  scenes, and scene↔shot assignment joined against the CURRENT draft. Pure:
 *  a scene shot reference resolves by canonical creativeShotId only; a
 *  reference whose shot left the current draft is flagged dangling (never
 *  guessed, never pruned). Draft shots without a shotId (legacy) cannot be
 *  assigned and are counted honestly. */
export function episodesModel(pd) {
  const prod = pd.production;
  if (!prod || !Array.isArray(prod.episodes)) return { empty: true };
  const draft = pd.draftShots || [];
  const episodes = prod.episodes.map((e) => ({
    episodeId: e.episodeId,
    title: e.title,
    active: e.episodeId === prod.activeEpisodeId,
    sceneCount: e.scenes.length,
    shotRefCount: e.scenes.reduce((n, s) => n + s.shotIds.length, 0),
    removable: !e.scenes.length && prod.episodes.length > 1,
  }));
  const view = episodeView(prod, prod.activeEpisodeId, draft);
  const active = view
    ? {
        episodeId: view.episode.episodeId,
        title: view.episode.title,
        scenes: view.scenes.map((s) => ({
          sceneId: s.sceneId,
          title: s.title,
          removable: !s.shots.length,
          shots: s.shots.map((x) => ({
            shotId: x.shotId,
            dangling: x.dangling,
            seq: x.shot ? x.shot.sequence : null,
            title: x.shot ? x.shot.title : null,
          })),
        })),
        unassigned: view.unassigned.map((s) => ({ shotId: s.shotId, seq: s.sequence, title: s.title })),
        unassignableCount: view.unassignable.length,
        draftCount: draft.length,
      }
    : null;
  return { empty: false, episodes, active };
}

/** Media slots are keyed by DRAFT slot ids — when only display rows / real
 *  locked records exist, shots are still surfaced as context so the empty
 *  state never claims "nothing exists" against a project that has shots. */
function shotContext(pd) {
  const m = shotsModel(pd);
  return m.empty || m.kind === "draft" ? null : { count: m.shots.length, kind: m.kind };
}

/** 资产: per current shot — image slot standing (versions, origin), joined by
 *  canonical creativeShotId → slot → registry (M4b). */
export function assetsModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], context: shotContext(pd) };
  const idx = buildShotSlotIndex(pd.draftShots);
  const items = pd.draftShots.map((s) => {
    const { slot, unresolved } = shotSlot(idx, s);
    const e = slot ? slotEntry(pd.assetUploads, slot) : null;
    const ref = slot ? currentRef(pd.assetUploads, slot) : null;
    return {
      seq: s.sequence,
      title: s.title,
      slot, // resolved storage key (null when none/unresolved)
      unresolved,
      url: ref ? ref.url : "",
      versions: e ? e.history.length : 0,
      current: e ? e.current : 0,
      origin: ref ? ref.origin : null,
    };
  });
  return { empty: false, items, done: items.filter((x) => x.url).length, total: items.length };
}

/** 视频: per current shot — clip standing joined by canonical creativeShotId →
 *  slot → registry (M4b); KNOWN first-frame lineage (absent = honestly unknown,
 *  never invented). Paid-op status joins by the M4c bridge: creativeShotId →
 *  locked bridge → server shot_id → paidOps (NOT draft sequence). An M4c lock
 *  whose shot can't be bridged shows opUnresolved (never a sequence guess); a
 *  legacy pre-M4c lock keeps the positional fallback. */
export function videoModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], context: shotContext(pd) };
  const idx = buildShotSlotIndex(pd.draftShots);
  const lockedShots = pd.lockedPlan && pd.lockedPlan.shots;
  const bridge = buildServerBridge(lockedShots);
  const items = pd.draftShots.map((s) => {
    const { slot, unresolved } = shotSlot(idx, s);
    const e = slot ? slotEntry(pd.media.video, slot) : null;
    const ref = slot ? currentRef(pd.media.video, slot) : null;
    const ff = slot ? pd.firstFrames[slot] : null;
    const { id: sid, unresolved: opUnresolved } = serverShotIdForShot(bridge, lockedShots, s);
    const op = sid ? pd.paidOps[sid] || null : null;
    return {
      seq: s.sequence,
      title: s.title,
      unresolved,
      url: ref ? ref.url : "",
      versions: e ? e.history.length : 0,
      origin: ref ? ref.origin : null,
      // lineage: only what the data actually records
      firstFrame: ff ? { version: ff.version, origin: ff.origin || "upload", url: ff.url } : null,
      opStatus: op ? op.status : null,
      opUnresolved, // paid-op identity could not be bridged (M4c lock) — show unknown
    };
  });
  return { empty: false, items, done: items.filter((x) => x.url).length, total: items.length };
}

/** 音频: per current shot voice slot (joined by canonical creativeShotId → slot
 *  → registry, M4b) + optional music/sfx extras. */
export function audioModel(pd) {
  if (!pd.draftShots || !pd.draftShots.length)
    return { empty: true, items: [], extras: [], context: shotContext(pd) };
  const entry = (k) => {
    const e = k ? slotEntry(pd.media.audio, k) : null;
    const ref = k ? currentRef(pd.media.audio, k) : null;
    return { url: ref ? ref.url : "", versions: e ? e.history.length : 0, origin: ref ? ref.origin : null };
  };
  const idx = buildShotSlotIndex(pd.draftShots);
  const items = pd.draftShots.map((s) => {
    const { slot, unresolved } = shotSlot(idx, s);
    return { seq: s.sequence, title: s.title, unresolved, ...entry(slot ? `voice-${slot}` : "") };
  });
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
  const idx = buildShotSlotIndex(pd.draftShots);
  const items = pd.draftShots.map((s) => {
    const { slot, unresolved } = shotSlot(idx, s);
    return {
      seq: s.sequence,
      title: s.title,
      unresolved,
      video: !!(slot && currentRef(pd.media.video, slot)),
      voice: !!(slot && currentRef(pd.media.audio, `voice-${slot}`)),
    };
  });
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

export function renderStory(ctx) {
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
    head("📖 故事工作区", "项目级 · 故事创意是剧本的输入 · 与剧本工作区同源") +
    `<div class="pm-brief"><label class="pa-lab">创意 / 想法（Creative Brief）</label><textarea class="brieftext pm-brieftext" rows="4" spellcheck="false" placeholder="一句话创意，例如：社畜穿越盛唐，被逼当殿作诗">${esc(ctx.script.doc().brief)}</textarea></div>` +
    `<div class="ws-kv">${esc(status)}</div>` + pending +
    `<button class="nrun ws-jump" data-goto="script">→ 去剧本工作区${m.hasScript ? "" : "生成 v1"}</button>`
  );
}

/** 作品设定 (Production Bible) — the domain model does not exist yet, and this
 *  workspace says exactly that instead of pretending: no fake fields, no fake
 *  persistence, a plain list of what a later checkpoint will bring. */
export function renderSettings() {
  return (
    head("🎭 作品设定", "项目级 · 域模型未建立") +
    empty("🎭", "作品设定（Production Bible）尚未开放", [
      "将包含：角色 / 场景 / 道具 / 美术风格 / 声音风格 等跨集一致性设定",
      "依赖作品设定域模型 — 属于后续检查点，当前没有可编辑或已持久化的数据",
    ])
  );
}

/** 剧集 — the persisted Production structure (M6): manage Episodes, the active
 *  episode's Scenes, and scene↔shot assignment. Structure only: shot content /
 *  media / provenance stay in their own domains and are never copied here. */
export function renderEpisodes(ctx) {
  const m = episodesModel(ctx.prodData());
  if (m.empty) {
    return head("📺 剧集", "项目级") + empty("📺", "剧集结构不可用", ["生产域文档未加载"]);
  }
  const cards = m.episodes
    .map(
      (e) =>
        `<div class="ws-epcard${e.active ? " on" : ""}"><div class="ws-epname">${e.active ? "▶ " : ""}${esc(e.title)}</div>` +
        `<div class="ws-desc">${e.sceneCount} 个场景 · ${e.shotRefCount} 个镜头归属</div>` +
        `<div class="ws-epbtns">${e.active ? `<span class="ws-tag">当前</span>` : `<button class="nrun ghost" data-ep-active="${esc(e.episodeId)}">设为当前</button>`}` +
        `<button class="nrun ghost" data-ep-rename="${esc(e.episodeId)}">重命名</button>` +
        (e.removable ? `<button class="nrun ghost" data-ep-del="${esc(e.episodeId)}">删除</button>` : "") +
        `</div></div>`,
    )
    .join("");
  const a = m.active;
  let structure = "";
  if (a) {
    const sceneRows = a.scenes
      .map((s) => {
        const chips = s.shots
          .map((x) =>
            x.dangling
              ? `<span class="ws-tag gate" title="${esc(x.shotId)}">⚠ 不在当前草稿<button class="ws-chipx" data-shot-un="${esc(x.shotId)}">移出</button></span>`
              : `<span class="ws-tag">${esc(nn(x.seq))} ${esc(x.title || "")}<button class="ws-chipx" data-shot-un="${esc(x.shotId)}">移出</button></span>`,
          )
          .join(" ");
        const assign = a.unassigned.length
          ? `<select class="ws-assign" data-assign-scene="${esc(s.sceneId)}"><option value="">＋ 归入镜头…</option>${a.unassigned
              .map((u) => `<option value="${esc(u.shotId)}">${esc(nn(u.seq))} ${esc(u.title || "")}</option>`)
              .join("")}</select>`
          : "";
        return (
          `<div class="ws-row"><div class="ws-main"><b>🎬 ${esc(s.title)}</b>` +
          `<div class="ws-desc">${chips || "（还没有镜头归入此场景）"}</div>${assign}</div>` +
          `<button class="nrun ghost" data-sc-rename="${esc(s.sceneId)}">重命名</button>` +
          (s.removable ? `<button class="nrun ghost" data-sc-del="${esc(s.sceneId)}">删除</button>` : "") +
          `</div>`
        );
      })
      .join("");
    const pool = a.unassigned.length
      ? `<div class="ws-kv">未归入场景的镜头：${a.unassigned.map((u) => `${esc(nn(u.seq))} ${esc(u.title || "")}`).join("、")}</div>`
      : a.draftCount
        ? `<div class="ws-kv ok">当前草稿镜头已全部归入场景</div>`
        : `<div class="ws-kv">当前没有分镜草稿镜头可归入 — 先在「分镜」生成分镜</div>`;
    const legacyNote = a.unassignableCount
      ? `<div class="ws-kv gate">⚠ ${a.unassignableCount} 个草稿镜头没有稳定身份（legacy），无法归入场景</div>`
      : "";
    structure =
      `<div class="pm-head"><div class="pm-title">🎬 「${esc(a.title)}」的场景</div><div class="pm-note">场景按稳定镜头身份（creativeShotId）引用镜头 · 镜头内容仍在分镜草稿</div></div>` +
      `<div class="ws-list">${sceneRows || `<div class="ws-kv">还没有场景 — 新建一个场景，把镜头按叙事单元归组</div>`}</div>` +
      `<button class="nrun" data-sc-add="${esc(a.episodeId)}">＋ 新建场景</button>` +
      pool + legacyNote;
  }
  return (
    head("📺 剧集", `${m.episodes.length} 集 · 结构已持久化`) +
    `<div class="ws-epgrid">${cards}</div>` +
    `<button class="nrun" data-ep-add>＋ 新建剧集</button>` +
    structure
  );
}

/** Wire the 剧集 workspace's structure actions to the production controller.
 *  Every mutation goes through ctx.production (the single domain write path);
 *  a refused op (returns false/null) is reported honestly, nothing persists. */
export function bindEpisodes(root, ctx) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  on("[data-ep-add]", () => {
    const t = window.prompt("新剧集名称", `第 ${ctx.production.doc().episodes.length + 1} 集`);
    if (t != null) ctx.production.addEpisode(t.trim());
  });
  on("[data-ep-active]", (el) => ctx.production.setActiveEpisode(el.dataset.epActive));
  on("[data-ep-rename]", (el) => {
    const ep = ctx.production.doc().episodes.find((e) => e.episodeId === el.dataset.epRename);
    const t = window.prompt("剧集名称", ep ? ep.title : "");
    if (t != null && t.trim() && !ctx.production.renameEpisode(el.dataset.epRename, t.trim())) {
      ctx.toast("重命名失败");
    }
  });
  on("[data-ep-del]", (el) => {
    if (!ctx.production.removeEpisode(el.dataset.epDel)) {
      ctx.toast("只能删除没有场景的非当前剩余剧集（先删除其场景）");
    }
  });
  on("[data-sc-add]", (el) => {
    const t = window.prompt("新场景名称", "");
    if (t != null) ctx.production.addScene(el.dataset.scAdd, t.trim());
  });
  on("[data-sc-rename]", (el) => {
    const t = window.prompt("场景名称", "");
    if (t != null && t.trim()) ctx.production.renameScene(el.dataset.scRename, t.trim());
  });
  on("[data-sc-del]", (el) => {
    if (!ctx.production.removeScene(el.dataset.scDel)) {
      ctx.toast("场景内仍有镜头归属：先「移出」全部镜头再删除");
    }
  });
  on("[data-shot-un]", (el) => ctx.production.unassignShot(el.dataset.shotUn));
  root.querySelectorAll("[data-assign-scene]").forEach((sel) => {
    sel.onchange = () => {
      if (sel.value) ctx.production.assignShot(sel.dataset.assignScene, sel.value);
    };
  });
}

export function renderShots(ctx) {
  const pd = ctx.prodData();
  const m = shotsModel(pd);
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
  // Creator-facing Shot cards over the CURRENT shot collection. Scene grouping
  // is not provable from current data, so this is deliberately a flat
  // collection — no fabricated Scene semantics (that domain waits for later).
  const cards = m.shots
    .map((s) => {
      // s.slot is the CANONICAL slot (creativeShotId → slot); null when a shot's
      // identity can't be proven — show unresolved, never guess by position.
      const ref = s.slot ? currentRef(pd.assetUploads, s.slot) : null;
      const thumb = ref
        ? `<img class="sc-thumb" src="${esc(ref.url)}" alt="">`
        : `<div class="sc-thumb sc-none">${s.unresolved ? "⚠" : "🎞"}</div>`;
      // M6: which scene this shot is assigned to (by canonical shotId) — a tag
      // only; assignment is managed in the 剧集 workspace
      const sc = s.shotId && pd.production ? sceneOfShot(pd.production, s.shotId) : null;
      const sceneTag = sc ? `<span class="ws-tag">🎬 ${esc(sc.scene.title)}</span>` : "";
      return (
        `<div class="shotcard">${thumb}<div class="sc-body">` +
        `<div class="sc-title"><span class="n mono">${esc(nn(s.seq))}</span> <b>${esc(s.title)}</b>${s.duration != null ? `<span class="ws-tag">${esc(String(s.duration))}s</span>` : ""}${sceneTag}</div>` +
        (s.description ? `<div class="ws-desc">${esc(s.description)}</div>` : "") +
        (s.unresolved ? `<div class="ws-kv gate">⚠ 镜头身份未解析（slot 归属歧义）— 不按位置猜测</div>` : "") +
        `</div></div>`
      );
    })
    .join("");
  const note = m.kind === "draft" ? "" : `<div class="ws-kv">（当前仅有镜头标题行 — 结构化草稿在生成分镜后可见）</div>`;
  return head("🎞 分镜工作区", `${m.shots.length} 个镜头 · ${meta} · 只读`) + note + `<div class="shotgrid">${cards}</div>`;
}

export function renderFrames(ctx) {
  const m = assetsModel(ctx.prodData());
  if (m.empty) {
    return head("🖼 画面工作区", "只读") + mediaEmpty("🖼", "画面（镜头图片）", m.context, [
      "前置：分镜（分镜工作区当前为空则先生成分镜）",
      "生成分镜后，在工作流视图的「资产准备」节点按镜头上传/生成图片",
    ]);
  }
  const cards = m.items
    .map((x) => {
      const thumb = x.url
        ? `<img class="sc-thumb" src="${esc(x.url)}" alt="">`
        : `<div class="sc-thumb sc-none">${x.unresolved ? "⚠" : "无图"}</div>`;
      const meta = x.url
        ? `v${x.current} · 共 ${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")}`
        : x.unresolved
          ? "⚠ 身份未解析（slot 归属歧义）"
          : "缺图";
      return `<div class="shotcard">${thumb}<div class="sc-body"><div class="sc-title"><span class="n mono">${esc(nn(x.seq))}</span> <b>${esc(x.title)}</b></div><div class="ws-desc">${meta}</div></div></div>`;
    })
    .join("");
  return head("🖼 画面工作区", `画面就绪 ${m.done}/${m.total} · 只读`) + `<div class="shotgrid">${cards}</div>`;
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
        : x.opUnresolved ? " · 付费状态未解析（身份无法桥接）" : "";
      const meta = x.url
        ? `${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")} · ${ff}${op}`
        : x.unresolved
          ? `⚠ 身份未解析（slot 归属歧义）${op}`
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
    const meta = x.url
      ? `${x.versions} 版 · ${esc(ORIGIN_ZH[x.origin] || x.origin || "")}`
      : x.unresolved
        ? "⚠ 身份未解析（slot 归属歧义）"
        : "缺音频";
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
