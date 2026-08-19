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
import { episodeView } from "../workflow/proddoc.js";
import { resolveCharacter, resolveLocation, findCharacter, findLocation } from "../workflow/bibledoc.js";
import { derivedAppearances } from "../workflow/breakdown.js";
import { bindField, restoreFieldFocus } from "./fieldsync.js";

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
/** Image Assets available as bible reference candidates: every version in the
 *  M3 registry's image domain, labeled by slot+version. Pure. */
export function imageAssetOptions(assetUploads) {
  const out = [];
  for (const slot of Object.keys(assetUploads || {})) {
    const e = slotEntry(assetUploads, slot);
    if (!e) continue;
    for (const r of e.history) {
      if (r && typeof r.assetId === "string" && r.assetId) {
        // `key` is the registry SLOT this version belongs to — the same identifier
        // `script-breakdown` v2 is shown and answers `existingAssetKey` with, so a
        // hint can be resolved instead of printed unchecked (批次 E). `current` marks
        // the version the slot actually selects, so a hint resolves to what the
        // creator would SEE rather than to whichever version came first in history.
        // Additive: every existing reader takes `assetId` / `label` / `url`.
        out.push({
          assetId: r.assetId,
          key: slot,
          version: r.version,
          current: r.version === e.current,
          label: `${slot} v${r.version}`,
          url: r.url || "",
        });
      }
    }
  }
  return out;
}

/** 作品设定 (Production Bible, M7): characters & locations with their states,
 *  voice profile, and asset references resolved to thumbnails where the Asset
 *  is still present (a missing Asset shows its id — the reference legitimately
 *  outlives the media, never silently dropped). Pure. */
export function settingsModel(pd) {
  const prod = pd.production;
  if (!prod || !Array.isArray(prod.characters) || !Array.isArray(prod.locations)) return { empty: true };
  const assets = imageAssetOptions(pd.assetUploads);
  const byAsset = new Map(assets.map((a) => [a.assetId, a]));
  const refView = (ids, active) =>
    ids.map((id) => ({
      assetId: id,
      url: byAsset.has(id) ? byAsset.get(id).url : "",
      label: byAsset.has(id) ? byAsset.get(id).label : id,
      missing: !byAsset.has(id),
      active: id === active,
    }));
  // M8: episode appearances are DERIVED from Scene references (characterRefs
  // / locationRef) — never a manually maintained list.
  const appearances = derivedAppearances(prod);
  // TASK-057: a character's KEY RELATIONSHIP SUMMARY, derived from the
  // first-class Relationship objects — the character record never stores a
  // second copy of the relationship.
  const byChar = new Map(prod.characters.map((c) => [c.characterId, c]));
  const relSummary = (characterId) =>
    (prod.relationships || [])
      .filter((r) => r.characterIds.includes(characterId))
      .map((r) => {
        const otherId = r.characterIds.find((id) => id !== characterId);
        const other = byChar.get(otherId);
        const basis = r.profile.basis.trim();
        return `${other ? other.name : otherId}${basis ? ` · ${basis}` : ""}`;
      });
  return {
    empty: false,
    assets,
    // WHAT AN `existingAssetKey` HINT MAY RESOLVE TO (TASK-090 §2.2 / 批次 E).
    // Carried on the model so the breakdown card can check the capability's claim
    // against the real registry instead of printing whatever key it answered with.
    // Empty when the page was given no upload registry — then a hint simply cannot
    // be confirmed, and the card says so rather than assuming.
    //
    // ONE ENTRY PER SLOT, resolved to the version the slot SELECTS. Listing every
    // historical version made the card's `find` return whichever came first — v1
    // for a slot whose current version is v2 — so the creator would have gone and
    // checked the AI's hint against an obsolete image (codex review, 批次 E round 1).
    // The fallback for a corrupt `current` pointer is the highest version seen,
    // which is the rule `assetreg.listReferences` already documents.
    assetHints: [...assets.reduce((byKey, a) => {
      const key = a.key || a.assetId;
      const prev = byKey.get(key);
      if (!prev || a.current || (!prev.current && (a.version || 0) > (prev.version || 0))) {
        byKey.set(key, { key, name: a.label, version: a.version, current: a.current });
      }
      return byKey;
    }, new Map()).values()],
    // a state's refs view is null when the state INHERITS the base list (no
    // referenceAssetIds override) — distinct from an explicit empty list
    characters: prod.characters.map((c) => ({
      characterId: c.characterId,
      name: c.name,
      // 正式 / 临时 (TASK-057) — hydration guarantees one of the two
      tier: c.tier,
      profile: c.profile,
      voice: c.voice,
      episodes: (appearances.characters.get(c.characterId) || []).map((x) => x.title),
      relationships: relSummary(c.characterId),
      refs: refView(c.referenceAssetIds, c.activeReferenceAssetId),
      states: c.states.map((s) => {
        const resolved = resolveCharacter(c, s.stateId);
        return {
          stateId: s.stateId,
          name: s.name,
          overrides: s.overrides,
          resolved,
          // the EFFECTIVE pair from the resolver — a state that overrides the
          // list but not the active field still shows the inherited active
          // when it is a member of the state's own list
          refs: "referenceAssetIds" in s.overrides
            ? refView(resolved.referenceAssetIds, resolved.activeReferenceAssetId)
            : null,
        };
      }),
    })),
    locations: prod.locations.map((l) => ({
      locationId: l.locationId,
      name: l.name,
      profile: l.profile,
      episodes: (appearances.locations.get(l.locationId) || []).map((x) => x.title),
      refs: refView(l.referenceAssetIds, l.activeReferenceAssetId),
      states: l.states.map((s) => {
        const resolved = resolveLocation(l, s.stateId);
        return {
          stateId: s.stateId,
          name: s.name,
          overrides: s.overrides,
          resolved,
          // effective pair from the resolver (see character states above)
          refs: "referenceAssetIds" in s.overrides
            ? refView(resolved.referenceAssetIds, resolved.activeReferenceAssetId)
            : null,
        };
      }),
    })),
  };
}

export function episodesModel(pd) {
  const prod = pd.production;
  if (!prod || !Array.isArray(prod.episodes)) return { empty: true };
  const draft = pd.draftShots || [];
  // scene bible references resolved for display (M7); entities always resolve
  // (internal refs are validated), states merge through the pure resolvers
  const sceneRefs = (s) => ({
    characters: (s.characterRefs || []).map((r) => {
      const c = findCharacter(prod, r.characterId);
      const rc = c ? resolveCharacter(c, r.stateId) : null;
      return {
        characterId: r.characterId,
        stateId: r.stateId,
        name: rc ? rc.name : r.characterId,
        stateName: rc ? rc.stateName : null,
        states: c ? c.states.map((x) => ({ stateId: x.stateId, name: x.name })) : [],
      };
    }),
    location: (() => {
      const r = s.locationRef;
      const l = r && findLocation(prod, r.locationId);
      const rl = l ? resolveLocation(l, r.stateId) : null;
      return r
        ? {
            locationId: r.locationId,
            stateId: r.stateId,
            name: rl ? rl.name : r.locationId,
            stateName: rl ? rl.stateName : null,
            states: l ? l.states.map((x) => ({ stateId: x.stateId, name: x.name })) : [],
          }
        : null;
    })(),
  });
  // ARCHIVED EPISODES LEAVE THIS LIST TOO (批次 G). It feeds the 剧集 structure
  // workspace and the plan panel's integrity line, and an archived shell is not
  // something the creator is structuring. `removable` counts the LIVE ones: 「删除
  // 最后一集」 must stay refused when the only others are archived.
  const live = prod.episodes.filter((e) => !(e.archived && e.archived.at));
  const episodes = live.map((e) => ({
    episodeId: e.episodeId,
    title: e.title,
    active: e.episodeId === prod.activeEpisodeId,
    sceneCount: e.scenes.length,
    shotRefCount: e.scenes.reduce((n, s) => n + s.shotIds.length, 0),
    removable: !e.scenes.length && live.length > 1,
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
          // M7: the scene's bible references, resolved for display (read off
          // the raw scene record — episodeView's rows carry shots only)
          refs: sceneRefs(view.episode.scenes.find((x) => x.sceneId === s.sceneId) || {}),
        })),
        // M7: entities offerable to scenes (id/name/states only — by reference)
        characterOptions: (prod.characters || []).map((c) => ({
          characterId: c.characterId, name: c.name,
          states: c.states.map((x) => ({ stateId: x.stateId, name: x.name })),
        })),
        locationOptions: (prod.locations || []).map((l) => ({
          locationId: l.locationId, name: l.name,
          states: l.states.map((x) => ({ stateId: x.stateId, name: x.name })),
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

export const OUTLINE_LABELS = [
  ["premise", "前提（Premise）"],
  ["logline", "主线（Logline）"],
  ["centralConflict", "核心冲突"],
  ["storyArc", "故事弧（Story Arc）"],
  ["climax", "高潮"],
  ["ending", "结局（Ending）"],
  ["genreTone", "题材 / 基调"],
  ["world", "世界观（概述）"],
  ["durationNote", "每集时长预期"],
];

/** 故事 (M9): the development pipeline standing — pure, unit-tested. */
export function storyModel(story) {
  const active = story.versions.find((x) => x.v === story.active) || null;
  const approved = story.versions.find((x) => x.v === story.approved) || null;
  const plan = story.plans.find((x) => x.v === story.activePlan) || null;
  const confirmed = story.plans.find((x) => x.v === story.confirmedPlan) || null;
  const p = story.pending;
  return {
    idea: story.idea,
    hasIdea: !!story.idea.trim(),
    outlineCount: story.versions.length,
    active,
    approved,
    approvedIsActive: !!active && story.approved === story.active,
    planCount: story.plans.length,
    plan,
    confirmed,
    confirmedIsActive: !!plan && story.confirmedPlan === story.activePlan,
    pending: p ? { kind: p.kind, status: p.status, error: p.error || null, proposal: p.proposal } : null,
  };
}

/** 故事 (M9) — Idea → AI story development → versioned Outline → approval.
 *  NO idea→script shortcut: the path to scripts goes through the approved
 *  outline and the confirmed episode plan (剧集工作区). */
export function renderStory(ctx) {
  const m = storyModel(ctx.story.doc());
  const stepChip = (label, state) =>
    `<span class="ws-tag${state === "done" ? " ok" : state === "next" ? " gate" : ""}">${esc(label)}</span>`;
  const pipeline =
    `<div class="ws-scenerefs">` +
    stepChip(m.hasIdea ? "✓ 创意" : "① 创意", m.hasIdea ? "done" : "next") +
    "→" + stepChip(m.approved ? `✓ 大纲 v${m.approved.v} 已批准` : m.outlineCount ? "② 大纲（待批准）" : "② AI 发展故事", m.approved ? "done" : m.hasIdea ? "next" : "") +
    "→" + stepChip(m.confirmed ? `✓ 规划 v${m.confirmed.v} 已确认` : "③ 剧集规划（在「剧集」）", m.confirmed ? "done" : m.approved ? "next" : "") +
    "→" + stepChip("④ 分集剧本", m.confirmed ? "next" : "") +
    `</div>`;
  const idea =
    `<div class="pm-brief"><label class="pa-lab">💡 创意 / 想法（Idea）</label>` +
    `<textarea class="brieftext pm-brieftext" rows="3" spellcheck="false" placeholder="一句话创意，例如：社畜穿越盛唐，被逼当殿作诗">${esc(m.idea)}</textarea></div>`;
  // --- pending outline proposal (AI output is a PROPOSAL first) ----------- //
  let proposal = "";
  if (m.pending && m.pending.kind === "outline") {
    if (m.pending.status === "generating") {
      proposal = `<div class="bd-panel"><div class="bd-h">🪄 AI 发展故事中…</div><div class="skel live"><i></i><i></i><i></i><i></i></div></div>`;
    } else if (m.pending.status === "failed") {
      proposal = `<div class="bd-panel"><div class="bd-h">🪄 故事发展失败</div><div class="scripterr">⚠ ${esc(m.pending.error || "")}</div><button class="nrun ghost" data-st-cancel>知道了</button></div>`;
    } else if (m.pending.status === "proposed") {
      const o = m.pending.proposal;
      const rows = OUTLINE_LABELS
        .map(([k, label]) => (o[k] ? `<div class="bd-f"><span>${esc(label)}</span>${esc(o[k])}</div>` : ""))
        .join("");
      const chars = o.characterConcepts.length
        ? `<div class="bd-f"><span>角色概念</span>${o.characterConcepts.map((c) => `<span class="ws-tag">👤 ${esc(c)}</span>`).join(" ")}</div>`
        : "";
      const count = o.episodeCount ? `<div class="bd-f"><span>建议集数</span>${o.episodeCount} 集</div>` : "";
      proposal =
        `<div class="bd-panel"><div class="bd-h">🪄 故事大纲提案 · 未应用</div>` +
        rows + chars + count +
        `<div class="bd-actions"><button class="nrun" data-st-apply>✔ 应用为大纲 v${m.outlineCount + 1}（旧版本保留）</button>` +
        `<button class="nrun ghost" data-st-discard>放弃提案</button></div></div>`;
    }
  }
  // --- the ACTIVE outline version (editable → new manual version) --------- //
  let outline = "";
  if (m.active) {
    const o = m.active.outline;
    const vchips = ctx.story.doc().versions
      .map((x) => `<button class="ws-chipx${x.v === m.active.v ? " on" : ""}" data-st-v="${x.v}">v${x.v}${x.v === ctx.story.doc().approved ? "✓" : ""}</button>`)
      .join(" ");
    const fields = OUTLINE_LABELS
      .map(([k, label]) => `<label class="ws-lab">${esc(label)}</label><textarea class="ws-bibletext" rows="2" spellcheck="false" data-so-field="${k}">${esc(o[k])}</textarea>`)
      .join("");
    const chars =
      `<label class="ws-lab">主要角色概念（正式角色档案由剧本拆解进入作品设定，不从大纲自动建立）</label>` +
      `<div class="ws-scenerefs">${o.characterConcepts.map((c) => `<span class="ws-tag">👤 ${esc(c)}</span>`).join(" ") || "<span class='ws-desc'>（暂无）</span>"}</div>`;
    const count = `<div class="ws-kv">建议集数：${o.episodeCount ? `${o.episodeCount} 集` : "未定"} · ${esc(o.durationNote || "时长未定")}</div>`;
    const approveBtn = m.approvedIsActive
      ? `<span class="ws-tag ok">✓ 已批准（剧集规划以此版为准）</span>`
      : `<button class="nrun" data-st-approve="${m.active.v}">✔ 批准大纲 v${m.active.v} → 可规划分集</button>`;
    outline =
      `<div class="pm-head"><div class="pm-title">📑 故事大纲 · v${m.active.v}${m.active.v === ctx.story.doc().approved ? "（已批准）" : ""}</div>` +
      `<div class="pm-note">版本：${vchips}</div></div>` +
      fields +
      `<div class="vbtns"><button class="nrun ghost" data-st-save>保存修改为新版本</button>${approveBtn}</div>` +
      chars + count;
  } else if (!m.pending) {
    outline =
      `<div class="ws-empty"><div class="ic">📑</div><div class="tt">从创意发展故事大纲</div>` +
      `<div class="hh">先写一句创意，AI 帮你发展：前提/故事线/题材基调/世界观/角色概念/核心冲突/故事弧/结局/集数 — 以提案呈现，应用后成为可批准的大纲版本</div>` +
      (m.hasIdea
        ? `<button class="nrun" data-st-develop>🪄 AI 发展故事（生成大纲提案）</button>`
        : `<div class="hh">↑ 在上方创意框写下想法后开始</div>`) +
      `</div>`;
  }
  const next = m.approved
    ? `<div class="ws-kv ok">下一步：到「剧集」生成/确认剧集规划${m.confirmed ? "（已确认 — 可逐集写剧本）" : ""}</div><button class="nrun ghost" data-goto="episodes">→ 去剧集规划</button>`
    : "";
  return (
    head("📖 故事工作区", "项目级 · 创意 → 大纲 → 剧集规划 → 分集剧本") +
    pipeline + idea + proposal + outline + next
  );
}

/** Wire the 故事 workspace: idea edits, outline proposal review, version
 *  switch/approve, manual outline edits (buffered → one new version). */
export function bindStory(root, ctx) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  on("[data-st-develop]", () => ctx.story.develop("outline", ""));
  on("[data-st-apply]", () => ctx.story.applyProposal());
  on("[data-st-discard]", () => ctx.story.discardProposal());
  on("[data-st-cancel]", () => ctx.story.cancel());
  on("[data-st-approve]", (el) => ctx.story.approveOutline(+el.dataset.stApprove));
  on("[data-st-v]", (el) => ctx.story.setActiveOutline(+el.dataset.stV));
  const buffer = {};
  root.querySelectorAll("[data-so-field]").forEach((el) => {
    el.oninput = () => { buffer[el.dataset.soField] = el.value; };
  });
  on("[data-st-save]", () => {
    if (!Object.keys(buffer).length) { ctx.toast("没有修改"); return; }
    ctx.story.applyManualOutline(buffer);
  });
}

/** 作品设定 (Production Bible, M7) — project-level Characters & Locations
 *  with States. One stable identity per entity; a state overrides
 *  presentation facets (per-field: empty = inherit the base) but never mints
 *  a new identity, and never a new voice identity (voice rule). Reference
 *  images are REFERENCES into the M3 Asset Registry. */
/** 剧本拆解 / 同步提案面板 (M8) — AI-first: proposals with explicit 添加 /
 *  并入已有 / 应用更新 / 忽略 actions; confirmed entities never overwritten. */
export function renderBreakdownPanel(ctx, m) {
  const st = ctx.breakdown.state();
  const runLabel = ctx.isConnected && ctx.isConnected()
    ? "🪄 AI 剧本拆解 → 同步提案"
    : "🪄 剧本拆解（演示模板）→ 同步提案";
  if (!st) {
    return (
      `<div class="bd-panel"><div class="bd-h">🪄 剧本拆解 / 同步作品设定</div>` +
      `<div class="ws-desc">让 AI 通读当前剧本，提议新角色/场景地、既有档案更新与剧情阶段状态 — 全部以提案呈现，逐条确认，绝不覆盖已确认内容。</div>` +
      `<button class="nrun" data-bd-run>${runLabel}</button></div>`
    );
  }
  if (st.status === "running") {
    return `<div class="bd-panel"><div class="bd-h">🪄 剧本拆解中…</div><div class="skel live"><i></i><i></i><i></i><i></i></div></div>`;
  }
  if (st.status === "failed") {
    return (
      `<div class="bd-panel"><div class="bd-h">🪄 剧本拆解失败</div>` +
      `<div class="scripterr">⚠ ${esc(st.error || "")}</div>` +
      `<button class="nrun ghost" data-bd-run>重试</button></div>`
    );
  }
  if (!st.cards.length) {
    return (
      `<div class="bd-panel"><div class="bd-h">🪄 剧本拆解 · 已同步</div>` +
      `<div class="ws-kv ok">✓ 没有待处理提案 — 作品设定与剧本一致（或提案已全部处理）</div>` +
      `<button class="nrun ghost" data-bd-run>重新拆解</button></div>`
    );
  }
  const KIND = {
    "new-character": ["👤 新角色", ""],
    "new-location": ["📍 新场景地", ""],
    "new-prop": ["🔑 新道具", ""],
    "update-character": ["👤 角色更新", "update"],
    "update-location": ["📍 场景地更新", "update"],
    "update-prop": ["🔑 道具更新", "update"],
  };
  const cards = st.cards
    .map((c) => {
      const p = c.proposal;
      const [badge] = KIND[c.kind];
      let body = "";
      let actions = "";
      if (c.kind.startsWith("new-")) {
        const facets = c.kind === "new-character"
          ? [["外貌", p.appearance], ["服装", p.costume], ["性格", p.personality], ["画面指令", p.visualInstruction], ["声音", p.voiceDescription]]
          : [["描述", p.description], ["画面指令", p.visualInstruction]];
        // 「并入已有」的候选**同类**：道具只能并进道具（跨类并入会把一把钥匙
        // 写进一个场景地的档案，而两边的字段名恰好一样，所以不会报错）
        body = facets.filter(([, v]) => v).map(([k, v]) => `<div class="bd-f"><span>${esc(k)}</span>${esc(v)}</div>`).join("");
        const sameKind = c.kind === "new-character"
          ? m.characters
          : c.kind === "new-prop" ? (m.props || []) : m.locations;
        const idOf = (e) => e.characterId || e.locationId || e.propId;
        const mergeSel = sameKind.length
          ? `<select class="ws-assign" data-bd-merge="${esc(c.id)}"><option value="">并入已有…（只填充空字段）</option>${sameKind
              .map((e) => `<option value="${esc(idOf(e))}">${esc(e.name)}</option>`)
              .join("")}</select>`
          : "";
        actions = `<button class="nrun" data-bd-add="${esc(c.id)}">＋ 添加</button>${mergeSel}<button class="nrun ghost" data-bd-ignore="${esc(c.id)}">忽略</button>`;
      } else {
        body = c.changes.fields
          .map((f) => `<div class="bd-f"><span>${esc(f.key)}</span><s>${esc(f.from || "（空）")}</s> → ${esc(f.to)}</div>`)
          .join("");
        actions = `<button class="nrun" data-bd-apply="${esc(c.id)}">应用更新到「${esc(c.entityName)}」</button><button class="nrun ghost" data-bd-ignore="${esc(c.id)}">忽略</button>`;
      }
      // 道具没有状态（`bibledoc.sanitizeProp`），所以这里读到的是 undefined，
      // 不是空数组 —— 归一化在这一处做，不让每个消费者各自 `|| []`
      const states = ((c.kind.startsWith("new-") ? p.states : c.changes.states) || [])
        .map((s) => `<span class="ws-tag" title="${esc(s.reason || "")}">◈ ${esc(s.name)}</span>`)
        .join(" ");
      // 「这个对象可能已经有参考图了」 (TASK-090 §2.2 / 批次 E). RESOLVED against the
      // real registry, and only shown when it resolves: a key the capability
      // invented must not appear as if it were a real asset — and a claim the
      // creator cannot check is worse than no claim. Nothing is bound here; this is
      // a clue on a proposal card.
      const hinted = p.existingAssetKey
        ? (m.assetHints || []).find((a) => a.key === p.existingAssetKey) || null
        : null;
      const assetHint = hinted
        ? `<div class="bd-f"><span>疑似已有参考</span>${esc(hinted.name)}` +
          `<span class="ws-tag" title="AI 认为已上传的这张素材就是它；添加后可在档案里挂上，这里不会自动绑定">待你确认</span></div>`
        : p.existingAssetKey
          ? `<div class="bd-f"><span>疑似已有参考</span>` +
            `<span class="ws-tag gate" title="AI 给出的资产键在资产库里找不到 —— 当作没有这条线索">指向了不存在的素材</span></div>`
          : "";
      return (
        `<div class="bd-card"><div class="bd-card-h"><span class="ws-tag">${badge}</span><b>${esc(p.name)}</b></div>` +
        body + assetHint + (states ? `<div class="bd-states">建议状态：${states}</div>` : "") +
        `<div class="bd-actions">${actions}</div></div>`
      );
    })
    .join("");
  const staleNote = st.stale
    ? `<div class="ws-kv gate">⚠ 拆解期间剧本已被修改：以下提案基于拆解时的剧本文本 — 建议「重新拆解」后再确认</div>`
    : "";
  return (
    `<div class="bd-panel"><div class="bd-h">🪄 剧本拆解提案 · ${st.cards.length} 条待处理${st.source === "demo" ? " · 演示模板" : ""}</div>` +
    `<div class="ws-desc">逐条确认：添加 / 并入已有（只填充空字段）/ 应用更新 / 忽略 — 已确认的档案绝不被静默覆盖。</div>` +
    staleNote + cards +
    `<button class="nrun ghost" data-bd-run>重新拆解</button></div>`
  );
}

// The bible's detail FIELDS (profile, voice, states, reference blocks) are
// shared: the gallery-first workspace (ui/biblews.js) renders them inside a
// detail drawer, and they keep the exact same data-* hooks bindSettings wires.
// They live at module scope, taking the settings model explicitly, so there is
// only ONE definition of each editable field in the codebase.
export function bibleFields(m) {
  const refBlock = (entityId, refs) => {
    const rows = refs
      .map((r, i) => {
        const human = `参考图 v${i + 1}`;
        const thumb = r.url
          ? `<img class="ws-refthumb" src="${esc(r.url)}" alt="">`
          : `<span class="ws-refthumb ws-refmiss" title="${esc(r.assetId)}">缺</span>`;
        return (
          `<span class="ws-refitem${r.active ? " on" : ""}" title="${esc(r.label)}">${thumb}<span class="ws-desc">${esc(human)}${r.active ? " ·主参考" : ""}${r.missing ? "（资产已不在注册表——引用保留）" : ""}</span>` +
          (r.active ? "" : `<button class="ws-chipx" data-b-refactive="${esc(entityId)}" data-aid="${esc(r.assetId)}">设为主参考</button>`) +
          `<button class="ws-chipx" data-b-refdel="${esc(entityId)}" data-aid="${esc(r.assetId)}">移除</button></span>`
        );
      })
      .join("");
    const addable = m.assets.filter((a) => !refs.some((r) => r.assetId === a.assetId));
    const add = addable.length
      ? `<select class="ws-assign" data-b-refadd="${esc(entityId)}"><option value="">＋ 从画面资产添加参考图…</option>${addable
          .map((a) => `<option value="${esc(a.assetId)}">${esc(a.label)}</option>`)
          .join("")}</select>`
      : `<div class="ws-desc">（没有可添加的画面资产 — 先在「画面」为镜头上传/生成图片）</div>`;
    return `<div class="ws-lab">参考图（引用 M3 资产，不复制）</div>${rows || ""}${add}`;
  };
  // sid: explicit data-sid attribute — ids are NEVER packed into one
  // attribute value (an id containing the join character would mis-parse)
  const profField = (kind, id, field, label, value, base = null, sid = null) =>
    `<label class="ws-lab">${esc(label)}</label><textarea class="ws-bibletext" rows="2" spellcheck="false" data-b-${kind}="${esc(id)}"${sid ? ` data-sid="${esc(sid)}"` : ""} data-field="${esc(field)}" ${base !== null ? `placeholder="（空 = 继承基础形态：${esc(base)}）"` : ""}>${esc(value)}</textarea>`;
  // state-level reference images: null refs = the state INHERITS the base
  // list; an explicit override list gets the same add/active/remove controls
  // as the base block (all writes go through the state's overrides).
  const stateRefBlock = (kind, entityId, stateId, refs) => {
    const attrs = `data-kind="${kind}" data-eid="${esc(entityId)}" data-sid="${esc(stateId)}"`;
    const listed = refs || [];
    const rows = listed
      .map((r) => {
        const thumb = r.url
          ? `<img class="ws-refthumb" src="${esc(r.url)}" alt="">`
          : `<span class="ws-refthumb ws-refmiss" title="${esc(r.assetId)}">缺</span>`;
        return (
          `<span class="ws-refitem${r.active ? " on" : ""}">${thumb}<span class="ws-desc">${esc(r.label)}${r.active ? " ·主参考" : ""}${r.missing ? "（资产已不在注册表——引用保留）" : ""}</span>` +
          (r.active ? "" : `<button class="ws-chipx" data-b-ovrefactive ${attrs} data-aid="${esc(r.assetId)}">设为主参考</button>`) +
          `<button class="ws-chipx" data-b-ovrefdel ${attrs} data-aid="${esc(r.assetId)}">移除</button></span>`
        );
      })
      .join("");
    const addable = m.assets.filter((a) => !listed.some((r) => r.assetId === a.assetId));
    const add = addable.length
      ? `<select class="ws-assign" data-b-ovrefadd ${attrs}><option value="">＋ 状态专属参考图…</option>${addable
          .map((a) => `<option value="${esc(a.assetId)}">${esc(a.label)}</option>`)
          .join("")}</select>`
      : "";
    const standing = refs === null
      ? `<div class="ws-desc">（继承基础参考图 — 添加后此状态使用自己的参考图列表）</div>`
      : `<button class="ws-chipx" data-b-ovrefreset ${attrs}>恢复继承基础参考图</button>`;
    return `<div class="ws-lab">状态参考图（覆盖）</div>${rows}${standing}${add}`;
  };
  // `bare` returns the BODY only (no <details> accordion) so the gallery-first
  // workspace can place the identical fields inside its detail drawer.
  const charCard = (c, bare = false) => {
    const states = c.states
      .map(
        (s) =>
          `<details class="ws-state" data-key="${esc(JSON.stringify([c.characterId, s.stateId]))}"><summary>◈ ${esc(s.name)}</summary>` +
          `<div class="ws-epbtns"><button class="nrun ghost" data-b-csrename="${esc(c.characterId)}" data-sid="${esc(s.stateId)}">重命名</button><button class="nrun ghost" data-b-csdel="${esc(c.characterId)}" data-sid="${esc(s.stateId)}">删除</button></div>` +
          profField("csov", c.characterId, "appearance", "外貌（覆盖）", s.overrides.appearance ?? "", c.profile.appearance, s.stateId) +
          profField("csov", c.characterId, "costume", "服装（覆盖）", s.overrides.costume ?? "", c.profile.costume, s.stateId) +
          profField("csov", c.characterId, "visualInstruction", "画面指令（覆盖）", s.overrides.visualInstruction ?? "", c.profile.visualInstruction, s.stateId) +
          profField("csov", c.characterId, "voiceDescription", "声音表现（覆盖·同一声音身份）", (s.overrides.voice && s.overrides.voice.description) ?? "", c.voice.description, s.stateId) +
          stateRefBlock("c", c.characterId, s.stateId, s.refs) +
          `</details>`,
      )
      .join("");
    // M8: episode appearances are DERIVED from scene references — displayed,
    // never edited here
    const appear = c.episodes.length
      ? `<div class="ws-kv">出现于：${c.episodes.map((t) => `<span class="ws-tag">📺 ${esc(t)}</span>`).join(" ")}（由场景引用派生）</div>`
      : `<div class="ws-desc">尚未在任何场景出场 — 在「剧集」的场景里添加出场角色后自动显示</div>`;
    // TASK-057 creative layer: who the character IS. None of these is
    // state-overridable — a state is the same person — so they sit above the
    // presentation facets rather than inside the state blocks.
    const creative =
      `<div class="ws-lab">创作层（人物是谁 — 状态不可覆盖）</div>` +
      profField("chprof", c.characterId, "identity", "身份", c.profile.identity) +
      profField("chprof", c.characterId, "personality", "性格", c.profile.personality) +
      profField("chprof", c.characterId, "desire", "欲望 / 目标", c.profile.desire) +
      profField("chprof", c.characterId, "weakness", "弱点", c.profile.weakness) +
      profField("chprof", c.characterId, "coreConflict", "核心矛盾", c.profile.coreConflict) +
      profField("chprof", c.characterId, "arc", "Character Arc", c.profile.arc);
    const body =
      appear +
      `<div class="ws-epbtns"><button class="nrun ghost" data-b-chrename="${esc(c.characterId)}">重命名</button><button class="nrun ghost" data-b-chdel="${esc(c.characterId)}">删除</button></div>` +
      creative +
      `<div class="ws-lab">表现层（状态可覆盖）</div>` +
      profField("chprof", c.characterId, "appearance", "外貌", c.profile.appearance) +
      profField("chprof", c.characterId, "costume", "服装", c.profile.costume) +
      profField("chprof", c.characterId, "visualInstruction", "基础视觉方向 / 画面指令", c.profile.visualInstruction) +
      `<label class="ws-lab">基础声音（角色唯一声音身份；状态只能调表现，不能换声音）</label>` +
      `<input class="ws-bibleinput" data-b-voice="${esc(c.characterId)}" data-field="voiceId" placeholder="声音标识（如 piper 声音名，可留空）" value="${esc(c.voice.voiceId || "")}">` +
      `<input class="ws-bibleinput" data-b-voice="${esc(c.characterId)}" data-field="description" placeholder="声音描述（音色/年龄感/语气）" value="${esc(c.voice.description)}">` +
      refBlock(c.characterId, c.refs) +
      `<div class="ws-lab">角色状态（少女时期/黑化时期… — 同一角色身份）</div>${states}` +
      `<button class="nrun ghost" data-b-csadd="${esc(c.characterId)}">＋ 新建状态</button>`;
    if (bare) return body;
    return (
      `<details class="ws-bible" data-key="${esc(JSON.stringify([c.characterId]))}"><summary>👤 <b>${esc(c.name)}</b><span class="ws-desc"> · ${c.states.length} 个状态 · ${c.refs.length} 张参考图${c.episodes.length ? ` · 出现于 ${c.episodes.length} 集` : ""}</span></summary>` +
      body +
      `</details>`
    );
  };
  const locCard = (l, bare = false) => {
    const states = l.states
      .map(
        (s) =>
          `<details class="ws-state" data-key="${esc(JSON.stringify([l.locationId, s.stateId]))}"><summary>◈ ${esc(s.name)}</summary>` +
          `<div class="ws-epbtns"><button class="nrun ghost" data-b-lsrename="${esc(l.locationId)}" data-sid="${esc(s.stateId)}">重命名</button><button class="nrun ghost" data-b-lsdel="${esc(l.locationId)}" data-sid="${esc(s.stateId)}">删除</button></div>` +
          profField("lsov", l.locationId, "description", "描述（覆盖）", s.overrides.description ?? "", l.profile.description, s.stateId) +
          profField("lsov", l.locationId, "visualInstruction", "画面指令（覆盖）", s.overrides.visualInstruction ?? "", l.profile.visualInstruction, s.stateId) +
          stateRefBlock("l", l.locationId, s.stateId, s.refs) +
          `</details>`,
      )
      .join("");
    const appear = l.episodes.length
      ? `<div class="ws-kv">出现于：${l.episodes.map((t) => `<span class="ws-tag">📺 ${esc(t)}</span>`).join(" ")}（由场景引用派生）</div>`
      : `<div class="ws-desc">尚未被任何场景使用 — 在「剧集」的场景里设定场景地后自动显示</div>`;
    const body =
      appear +
      `<div class="ws-epbtns"><button class="nrun ghost" data-b-locrename="${esc(l.locationId)}">重命名</button><button class="nrun ghost" data-b-locdel="${esc(l.locationId)}">删除</button></div>` +
      profField("locprof", l.locationId, "description", "描述", l.profile.description) +
      profField("locprof", l.locationId, "visualInstruction", "画面指令", l.profile.visualInstruction) +
      refBlock(l.locationId, l.refs) +
      `<div class="ws-lab">场景地状态（日/夜、天气、受损/完好、季节…）</div>${states}` +
      `<button class="nrun ghost" data-b-lsadd="${esc(l.locationId)}">＋ 新建状态</button>`;
    if (bare) return body;
    return (
      `<details class="ws-bible" data-key="${esc(JSON.stringify([l.locationId]))}"><summary>📍 <b>${esc(l.name)}</b><span class="ws-desc"> · ${l.states.length} 个状态 · ${l.refs.length} 张参考图${l.episodes.length ? ` · 用于 ${l.episodes.length} 集` : ""}</span></summary>` +
      body +
      `</details>`
    );
  };
  return { refBlock, profField, stateRefBlock, charCard, locCard };
}

export function renderSettings(ctx) {
  const m = settingsModel(ctx.prodData());
  if (m.empty) {
    return head("🎭 作品设定", "项目级") + empty("🎭", "作品设定不可用", ["生产域文档未加载"]);
  }
  const { charCard, locCard } = bibleFields(m);
  return (
    head("🎭 作品设定（Production Bible）", `${m.characters.length} 个角色 · ${m.locations.length} 个场景地 · AI 拆解为先，手工编辑为辅`) +
    renderBreakdownPanel(ctx, m) +
    `<div class="pm-title2">👤 角色库</div>` +
    (m.characters.map(charCard).join("") || `<div class="ws-kv">还没有角色 — 建立角色档案，保证跨镜头/跨集一致性</div>`) +
    `<button class="nrun" data-b-chadd>＋ 新建角色</button>` +
    `<div class="pm-title2">📍 场景地库</div>` +
    (m.locations.map(locCard).join("") || `<div class="ws-kv">还没有场景地 — 建立场景档案（可含日/夜等状态）</div>`) +
    `<button class="nrun" data-b-locadd>＋ 新建场景地</button>` +
    `<div class="ws-kv">场景（剧集工作区）按 ID 引用角色/场景地及其状态；档案内容只存在这里，绝不复制进场景或镜头。</div>`
  );
}

/** Pure: the state's next override pair after ADDING a state-specific
 *  reference. The state's EFFECTIVE primary (its own override key, else the
 *  inherited base active) is never displaced while it remains a member of the
 *  new list — adding a secondary reference must not silently change the
 *  primary. Only when nothing effective remains (first state-specific ref,
 *  explicit none, or the old primary left the list) does the added reference
 *  become primary. Returns null for a duplicate add (no-op). Exported for
 *  node --test. */
export function nextStateRefsOnAdd(entity, overrides, assetId) {
  const cur = Array.isArray(overrides.referenceAssetIds) ? overrides.referenceAssetIds : [];
  if (cur.includes(assetId)) return null;
  const refs = [...cur, assetId];
  const next = { ...overrides, referenceAssetIds: refs };
  const effective = "activeReferenceAssetId" in overrides
    ? overrides.activeReferenceAssetId
    : entity.activeReferenceAssetId; // inherited base primary
  if (!(effective != null && refs.includes(effective))) next.activeReferenceAssetId = assetId;
  return next;
}

/** Wire the 作品设定 workspace to the bible controller. Per-field override
 *  edits MERGE into the state's existing overrides; clearing a field removes
 *  the key (= inherit base), never writes a hollow empty override. */
export function bindSettings(root, ctx, ui = {}) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  const prompt2 = (label, cur = "") => {
    const t = window.prompt(label, cur);
    return t == null ? null : t.trim();
  };
  const prod = () => ctx.production.doc();
  // --- 剧本拆解提案 (M8): explicit per-card actions ------------------------ //
  on("[data-bd-run]", () => ctx.breakdown.run());
  on("[data-bd-add]", (el) => ctx.breakdown.addAsNew(el.dataset.bdAdd));
  on("[data-bd-apply]", (el) => ctx.breakdown.applyUpdate(el.dataset.bdApply));
  on("[data-bd-ignore]", (el) => ctx.breakdown.dismiss(el.dataset.bdIgnore));
  root.querySelectorAll("[data-bd-merge]").forEach((sel) => {
    sel.onchange = () => { if (sel.value) ctx.breakdown.mergeInto(sel.dataset.bdMerge, sel.value); };
  });
  on("[data-b-chadd]", () => {
    const t = prompt2("角色名称");
    if (t != null) ctx.bible.addCharacter(t);
  });
  on("[data-b-locadd]", () => {
    const t = prompt2("场景地名称");
    if (t != null) ctx.bible.addLocation(t);
  });
  on("[data-b-chrename]", (el) => {
    const t = prompt2("角色名称");
    if (t) ctx.bible.renameCharacter(el.dataset.bChrename, t);
  });
  on("[data-b-locrename]", (el) => {
    const t = prompt2("场景地名称");
    if (t) ctx.bible.renameLocation(el.dataset.bLocrename, t);
  });
  on("[data-b-chdel]", (el) => {
    if (!ctx.bible.removeCharacter(el.dataset.bChdel)) ctx.toast("仍有场景引用该角色：先在剧集工作区移除引用");
  });
  on("[data-b-locdel]", (el) => {
    if (!ctx.bible.removeLocation(el.dataset.bLocdel)) ctx.toast("仍有场景引用该场景地：先在剧集工作区移除引用");
  });
  on("[data-b-csadd]", (el) => {
    const t = prompt2("状态名称（如：少女时期 / 黑化时期）");
    if (t != null) ctx.bible.addCharacterState(el.dataset.bCsadd, t);
  });
  on("[data-b-lsadd]", (el) => {
    const t = prompt2("状态名称（如：夜晚 / 战损）");
    if (t != null) ctx.bible.addLocationState(el.dataset.bLsadd, t);
  });
  on("[data-b-csrename]", (el) => {
    const t = prompt2("状态名称");
    if (t) ctx.bible.renameCharacterState(el.dataset.bCsrename, el.dataset.sid, t);
  });
  on("[data-b-lsrename]", (el) => {
    const t = prompt2("状态名称");
    if (t) ctx.bible.renameLocationState(el.dataset.bLsrename, el.dataset.sid, t);
  });
  on("[data-b-csdel]", (el) => {
    if (!ctx.bible.removeCharacterState(el.dataset.bCsdel, el.dataset.sid)) ctx.toast("仍有场景以该状态引用角色：先切换/移除场景引用");
  });
  on("[data-b-lsdel]", (el) => {
    if (!ctx.bible.removeLocationState(el.dataset.bLsdel, el.dataset.sid)) ctx.toast("仍有场景以该状态引用场景地：先切换/移除场景引用");
  });
  on("[data-b-refactive]", (el) => ctx.bible.setActiveReferenceAsset(el.dataset.bRefactive, el.dataset.aid));
  on("[data-b-refdel]", (el) => ctx.bible.removeReferenceAsset(el.dataset.bRefdel, el.dataset.aid));
  root.querySelectorAll("[data-b-refadd]").forEach((sel) => {
    sel.onchange = () => { if (sel.value) ctx.bible.addReferenceAsset(sel.dataset.bRefadd, sel.value); };
  });
  // AUTOSAVE ON INPUT (see ui/fieldsync.js). These used to write only on blur,
  // so a browser refresh with the caret still in a character field lost the
  // edit — the same TASK-057 persistence blocker as the upstream surfaces.
  root.querySelectorAll("[data-b-chprof]").forEach((el) => {
    bindField(el, ui, (value) => ctx.bible.updateCharacterProfile(el.dataset.bChprof, { [el.dataset.field]: value }));
  });
  root.querySelectorAll("[data-b-locprof]").forEach((el) => {
    bindField(el, ui, (value) => ctx.bible.updateLocationProfile(el.dataset.bLocprof, { [el.dataset.field]: value }));
  });
  root.querySelectorAll("[data-b-voice]").forEach((el) => {
    bindField(el, ui, (value) => ctx.bible.setCharacterVoice(el.dataset.bVoice, { [el.dataset.field]: value }));
  });
  // state override fields: merge per field; empty value = inherit (drop key)
  const mergeOverride = (overrides, field, value) => {
    const next = { ...overrides };
    if (field === "voiceDescription") {
      const v = { ...(next.voice || {}) };
      if (value) v.description = value;
      else delete v.description;
      if (Object.keys(v).length) next.voice = v;
      else delete next.voice;
    } else if (value) {
      next[field] = value;
    } else {
      delete next[field];
    }
    return next;
  };
  // ids are carried in SEPARATE data attributes (data-sid/data-eid) — never
  // packed into one value that a delimiter split could mis-parse
  const entityRec = (kind, eid) => {
    const doc = prod();
    return kind === "c"
      ? doc.characters.find((x) => x.characterId === eid)
      : doc.locations.find((x) => x.locationId === eid);
  };
  const stateOv = (kind, eid, sid) => {
    const e = entityRec(kind, eid);
    const s = e && e.states.find((x) => x.stateId === sid);
    return s ? s.overrides : null;
  };
  const setOv = (kind, eid, sid, ov) =>
    kind === "c" ? ctx.bible.setCharacterStateOverrides(eid, sid, ov) : ctx.bible.setLocationStateOverrides(eid, sid, ov);
  root.querySelectorAll("[data-b-csov]").forEach((el) => {
    bindField(el, ui, (value) => {
      const o = stateOv("c", el.dataset.bCsov, el.dataset.sid);
      if (o) setOv("c", el.dataset.bCsov, el.dataset.sid, mergeOverride(o, el.dataset.field, value));
    });
  });
  root.querySelectorAll("[data-b-lsov]").forEach((el) => {
    bindField(el, ui, (value) => {
      const o = stateOv("l", el.dataset.bLsov, el.dataset.sid);
      if (o) setOv("l", el.dataset.bLsov, el.dataset.sid, mergeOverride(o, el.dataset.field, value));
    });
  });
  // --- state-level reference images (override list on the state itself) --- //
  on("[data-b-ovrefactive]", (el) => {
    const { kind, eid, sid, aid } = el.dataset;
    const o = stateOv(kind, eid, sid);
    if (o && Array.isArray(o.referenceAssetIds) && o.referenceAssetIds.includes(aid)) {
      setOv(kind, eid, sid, { ...o, activeReferenceAssetId: aid });
    }
  });
  on("[data-b-ovrefdel]", (el) => {
    const { kind, eid, sid, aid } = el.dataset;
    const o = stateOv(kind, eid, sid);
    if (!o || !Array.isArray(o.referenceAssetIds)) return;
    const refs = o.referenceAssetIds.filter((x) => x !== aid);
    const next = { ...o, referenceAssetIds: refs };
    if (next.activeReferenceAssetId === aid) next.activeReferenceAssetId = refs[0] ?? null;
    setOv(kind, eid, sid, next);
  });
  on("[data-b-ovrefreset]", (el) => {
    // back to INHERITING the base list: remove both override keys
    const { kind, eid, sid } = el.dataset;
    const o = stateOv(kind, eid, sid);
    if (!o) return;
    const next = { ...o };
    delete next.referenceAssetIds;
    delete next.activeReferenceAssetId;
    setOv(kind, eid, sid, next);
  });
  root.querySelectorAll("[data-b-ovrefadd]").forEach((sel) => {
    sel.onchange = () => {
      if (!sel.value) return;
      const { kind, eid, sid } = sel.dataset;
      const e = entityRec(kind, eid);
      const o = stateOv(kind, eid, sid);
      if (!e || !o) return;
      // an effective (possibly inherited) primary is never displaced by
      // adding a secondary reference — pure decision, unit-tested
      const next = nextStateRefsOnAdd(e, o, sel.value);
      if (next) setOv(kind, eid, sid, next);
    };
  });
  restoreFieldFocus(root, ui);
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
        // M7: the scene's bible references — location (one) + characters (many),
        // each with a state picker resolving to the SAME identity. `attrs` is a
        // raw attribute string; ids ride in SEPARATE attributes, never packed
        // into one value a delimiter split could mis-parse.
        const stateSel = (attrs, states, cur) =>
          states.length
            ? `<select class="ws-assign ws-staterefsel" ${attrs}><option value="">（基础形态）</option>${states
                .map((x) => `<option value="${esc(x.stateId)}"${x.stateId === cur ? " selected" : ""}>${esc(x.name)}</option>`)
                .join("")}</select>`
            : "";
        // M8 rule: a Scene REFERENCES a reusable Location — pick an existing
        // one, or create a NEW Location (it lands in the Production Bible
        // immediately); never a per-scene duplicate location entity.
        const newLocBtn = `<button class="ws-chipx" data-scref-lnew="${esc(s.sceneId)}">＋新建场景地</button>`;
        const loc = s.refs.location
          ? `<span class="ws-tag">📍 ${esc(s.refs.location.name)}</span>` +
            stateSel(`data-scref-lstate="${esc(s.sceneId)}"`, s.refs.location.states, s.refs.location.stateId) +
            `<button class="ws-chipx" data-scref-lclear="${esc(s.sceneId)}">×</button>`
          : (a.locationOptions.length
              ? `<select class="ws-assign" data-scref-lset="${esc(s.sceneId)}"><option value="">📍 选择场景地…</option>${a.locationOptions
                  .map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)}</option>`)
                  .join("")}</select>`
              : `<span class="ws-desc">📍 还没有场景地</span>`) + newLocBtn;
        const charChips = s.refs.characters
          .map(
            (r) =>
              `<span class="ws-tag">👤 ${esc(r.name)}</span>` +
              stateSel(`data-scref-cstate="${esc(s.sceneId)}" data-cid="${esc(r.characterId)}"`, r.states, r.stateId) +
              `<button class="ws-chipx" data-scref-cdel="${esc(s.sceneId)}" data-cid="${esc(r.characterId)}">×</button>`,
          )
          .join(" ");
        const charAddable = a.characterOptions.filter((c) => !s.refs.characters.some((r) => r.characterId === c.characterId));
        const charAdd = charAddable.length
          ? `<select class="ws-assign" data-scref-cadd="${esc(s.sceneId)}"><option value="">＋ 出场角色…</option>${charAddable
              .map((c) => `<option value="${esc(c.characterId)}">${esc(c.name)}</option>`)
              .join("")}</select>`
          : "";
        const bibleLine = loc || charChips || charAdd
          ? `<div class="ws-scenerefs">${loc} ${charChips} ${charAdd}</div>`
          : "";
        return (
          `<div class="ws-row"><div class="ws-main"><b>🎬 ${esc(s.title)}</b>` +
          `<div class="ws-desc">${chips || "（还没有镜头归入此场景）"}</div>${bibleLine}${assign}</div>` +
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
  // 当前剧集进度 (M8): the ACTIVE episode's production standing — script /
  // shots / per-stage media readiness / finals, all from existing read models
  const doc = ctx.script.doc();
  const pdAll = ctx.prodData();
  const shots = shotsModel(pdAll);
  const frames = assetsModel(pdAll);
  const video = videoModel(pdAll);
  const audio = audioModel(pdAll);
  const edit = editModel(pdAll);
  const stage = (icon, label, value, goto) =>
    `<button class="ws-stage" data-goto="${goto}"><span class="ws-stage-ic">${icon}</span><span class="ws-stage-l">${esc(label)}</span><b>${esc(value)}</b></button>`;
  const progress = m.active
    ? `<div class="ws-progress">` +
      stage("📄", "剧本", doc.versions.length ? `v${doc.active}` : "未生成", "script") +
      stage("🎞", "分镜", shots.empty ? "未生成" : `${shots.shots.length} 镜`, "shots") +
      stage("🖼", "画面", frames.empty ? "—" : `${frames.done}/${frames.total}`, "frames") +
      stage("▶", "视频", video.empty ? "—" : `${video.done}/${video.total}`, "video") +
      stage("🎵", "配音", audio.empty ? "—" : `${audio.done}/${audio.total}`, "audio") +
      stage("✂", "成片", edit.finals ? `v${edit.finals}` : "未合成", "edit") +
      `</div>`
    : "";
  return (
    head("📺 剧集", `${m.episodes.length} 集 · 结构已持久化`) +
    renderPlanPanel(ctx, m) +
    progress +
    `<div class="ws-epgrid">${cards}</div>` +
    `<button class="nrun" data-ep-add>＋ 新建剧集</button>` +
    structure
  );
}

/** 剧集规划 (M9): plan proposal → applied plan versions → CONFIRMATION
 *  (instantiates/links Episode entities) → per-episode script entry. */
export function renderPlanPanel(ctx, m) {
  const sm = storyModel(ctx.story.doc());
  const epCard = (e, opts = {}) => {
    // THE PROPOSAL PREVIEW SHOWS WHAT THE MODEL ACTUALLY ANSWERED (TASK-094 批次 B).
    // `episode-planner` v2 answers the product owner's seven facets, so a preview
    // built from the v1 field names alone would have shown 「开场钩子 / 结尾拍」 and
    // nothing else — a full proposal that reads as an empty one, which is the
    // 「界面说的和事实不符」 family this chain exists to remove. The legacy names stay
    // for the four plan versions of the real project that are written in them.
    const list = (label, items) => {
      const kept = (Array.isArray(items) ? items : []).filter((x) => x && String(x).trim());
      if (!kept.length) return "";
      return `<div class="bd-f"><span>${esc(label)}</span>${kept.map((x) => esc(String(x))).join("；")}</div>`;
    };
    const beats = (Array.isArray(e.characterBeats) ? e.characterBeats : [])
      .filter((b) => b && b.who && b.change)
      .map((b) => `${b.who}：${b.change}${b.relationChange ? `（关系：${b.relationChange}）` : ""}`);
    const rows = [
      ["本集核心目标", e.coreGoal], ["情绪曲线", e.emotionArc],
      ["结尾拍", e.endingBeat], ["留下的悬念", e.hook], ["时长", e.duration],
      // legacy, only when the new field is absent — never both saying the same thing
      ...(e.coreGoal ? [] : [["戏剧功能（旧）", e.purpose]]),
      ...((Array.isArray(e.keyEvents) && e.keyEvents.length) ? [] : [["梗概（旧）", e.synopsis]]),
    ].filter(([, v]) => v).map(([k, v]) => `<div class="bd-f"><span>${esc(k)}</span>${esc(v)}</div>`).join("")
      + list("主要剧情", e.keyEvents) + list("角色推进", beats) + list("信息揭示", e.reveals);
    const link = opts.confirmed
      ? e.episodeId && m.episodes.some((x) => x.episodeId === e.episodeId)
        ? `<button class="nrun ghost" data-ep-open="${esc(e.episodeId)}">→ 进入本集剧本</button>`
        : `<span class="ws-tag gate">⚠ 剧集实体缺失（已被删除）</span>`
      : "";
    return (
      `<div class="bd-card"><div class="bd-card-h"><span class="ws-tag">EP${e.epNumber}</span><b>${esc(e.title)}</b>${link}</div>${rows}</div>`
    );
  };
  const p = sm.pending;
  if (p && p.kind === "plan") {
    if (p.status === "generating") {
      return `<div class="bd-panel"><div class="bd-h">🪄 AI 规划分集中…</div><div class="skel live"><i></i><i></i><i></i><i></i></div></div>`;
    }
    if (p.status === "failed") {
      return `<div class="bd-panel"><div class="bd-h">🪄 规划失败</div><div class="scripterr">⚠ ${esc(p.error || "")}</div><button class="nrun ghost" data-pl-cancel>知道了</button></div>`;
    }
    return (
      `<div class="bd-panel"><div class="bd-h">🪄 剧集规划提案 · ${p.proposal.length} 集 · 未应用</div>` +
      p.proposal.map((e) => epCard(e)).join("") +
      `<div class="bd-actions"><button class="nrun" data-pl-apply>✔ 应用为规划 v${sm.planCount + 1}（旧版本保留）</button>` +
      `<button class="nrun ghost" data-pl-discard>放弃提案</button></div></div>`
    );
  }
  if (sm.plan) {
    const vchips = ctx.story.doc().plans
      .map((x) => `<button class="ws-chipx${x.v === sm.plan.v ? " on" : ""}" data-pl-v="${x.v}">v${x.v}${x.v === ctx.story.doc().confirmedPlan ? "✓" : ""}</button>`)
      .join(" ");
    const confirmed = sm.plan.v === ctx.story.doc().confirmedPlan;
    const confirmBtn = confirmed
      ? `<span class="ws-tag ok">✓ 已确认 — 每集可进入剧本</span>`
      : `<button class="nrun" data-pl-confirm="${sm.plan.v}">✔ 确认规划 v${sm.plan.v}（建立/联结剧集，然后逐集写剧本）</button>`;
    // THE CONTENT IS NOT RENDERED HERE (产品 2026-08-13).
    //
    // This panel used to repeat every episode's 梗概 / 戏剧功能 / 钩子 / 结尾拍 / 时长
    // read-only, directly above the cards that own them. Once those cards became
    // editable, the same content existed twice on one screen and only the lower copy
    // could be typed in — so 「编辑不了剧集规划的内容」 was the literal experience of
    // clicking the upper one. A panel is the VERSION control; the cards are the content.
    // INTEGRITY STAYS HERE even though the content left. A confirmed plan entry whose
    // Episode entity was deleted has no card below (the cards are built from the
    // entities), so without this line it would be invisible — the plan would claim
    // episodes that no longer exist and nothing would say so.
    const orphans = confirmed
      ? sm.plan.episodes.filter((e) => !e.episodeId || !m.episodes.some((x) => x.episodeId === e.episodeId))
      : [];
    const orphanLine = orphans.length
      ? `<div class="bd-f"><span class="ws-tag gate">⚠ 剧集实体缺失</span>` +
        `${orphans.map((e) => `EP${e.epNumber} ${esc(e.title)}`).join("、")}` +
        `（已被删除；下面没有它们的卡片）</div>`
      : "";
    return (
      `<div class="bd-panel"><div class="bd-h">📋 剧集规划 · v${sm.plan.v}${confirmed ? "（已确认）" : "（未确认）"}<span class="ws-desc"> 版本：${vchips}</span></div>` +
      // TASK-077 §1.6: 「12 集」 beside a page header saying 「48 集」 read as a
      // contradiction. It is a different quantity — this VERSION's entries — and
      // now says so, next to the count of episodes that actually exist.
      `<div class="ws-desc">本版规划 ${sm.plan.episodes.length} 集` +
      (m.episodes && m.episodes.length !== sm.plan.episodes.length
        ? ` · 项目已建立 ${m.episodes.length} 集`
        : "") +
      ` · 每一集的内容概要在下面的卡片里，直接点就能改。</div>` +
      orphanLine +
      `<div class="bd-actions">${confirmBtn}<button class="nrun ghost" data-pl-develop>🪄 重新规划（新提案）</button></div></div>`
    );
  }
  if (sm.approved) {
    return (
      `<div class="bd-panel"><div class="bd-h">📋 剧集规划</div>` +
      `<div class="ws-desc">大纲 v${sm.approved.v} 已批准 — 让 AI 按大纲规划逐集（集数/标题/梗概/戏剧功能/钩子/结尾拍/时长），确认后建立剧集并逐集写剧本。</div>` +
      `<button class="nrun" data-pl-develop>🪄 生成剧集规划提案</button></div>`
    );
  }
  return (
    `<div class="bd-panel"><div class="bd-h">📋 剧集规划</div>` +
    `<div class="ws-desc">前置：已批准的故事大纲 — 先在「故事」发展并批准大纲，再规划分集。</div>` +
    `<button class="nrun ghost" data-goto="story">→ 去故事工作区</button></div>`
  );
}

/** Wire the 剧集 workspace's structure actions to the production controller.
 *  Every mutation goes through ctx.production (the single domain write path);
 *  a refused op (returns false/null) is reported honestly, nothing persists. */
export function bindEpisodes(root, ctx) {
  const on = (sel, fn) =>
    root.querySelectorAll(sel).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));
  // --- 剧集规划 (M9): proposal → apply → confirm --------------------------- //
  on("[data-pl-develop]", () => ctx.story.develop("plan", ""));
  on("[data-pl-apply]", () => ctx.story.applyProposal());
  on("[data-pl-discard]", () => ctx.story.discardProposal());
  on("[data-pl-cancel]", () => ctx.story.cancel());
  on("[data-pl-v]", (el) => ctx.story.setActivePlan(+el.dataset.plV));
  on("[data-pl-confirm]", (el) => {
    if (!window.confirm("确认此剧集规划？将建立/联结对应剧集实体（旧剧集与内容保留，不会被删除）。")) return;
    ctx.story.confirmPlan(+el.dataset.plConfirm);
  });
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
  // --- scene ↔ bible references (M7) --------------------------------------- //
  // create a NEW reusable Location and reference it from this scene — the
  // entity lands in the Production Bible immediately (M8 rule 7/8)
  on("[data-scref-lnew]", (el) => {
    const t = window.prompt("新场景地名称（将进入作品设定，可复用于其它场景）");
    if (t == null || !t.trim()) return;
    const loc = ctx.bible.addLocation(t.trim());
    if (loc) ctx.bible.setSceneLocation(el.dataset.screfLnew, loc.locationId, null);
  });
  on("[data-scref-lclear]", (el) => ctx.bible.setSceneLocation(el.dataset.screfLclear, null, null));
  on("[data-scref-cdel]", (el) => ctx.bible.removeSceneCharacter(el.dataset.screfCdel, el.dataset.cid));
  root.querySelectorAll("[data-scref-lset]").forEach((sel) => {
    sel.onchange = () => { if (sel.value) ctx.bible.setSceneLocation(sel.dataset.screfLset, sel.value, null); };
  });
  root.querySelectorAll("[data-scref-lstate]").forEach((sel) => {
    sel.onchange = () => {
      const sceneId = sel.dataset.screfLstate;
      const cur = ctx.production.doc(); // re-read the current location ref
      let locId = null;
      for (const e of cur.episodes) for (const s of e.scenes) if (s.sceneId === sceneId && s.locationRef) locId = s.locationRef.locationId;
      if (locId) ctx.bible.setSceneLocation(sceneId, locId, sel.value || null);
    };
  });
  root.querySelectorAll("[data-scref-cadd]").forEach((sel) => {
    sel.onchange = () => { if (sel.value) ctx.bible.addSceneCharacter(sel.dataset.screfCadd, sel.value, null); };
  });
  root.querySelectorAll("[data-scref-cstate]").forEach((sel) => {
    sel.onchange = () => {
      ctx.bible.setSceneCharacterState(sel.dataset.screfCstate, sel.dataset.cid, sel.value || null);
    };
  });
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
