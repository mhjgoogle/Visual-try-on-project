// Asset Inbox — a READ-TIME classification pass over the existing Project
// Asset Registry (M3) + Generation Registry (M5) + production document.
//
// THIS IS NOT A SECOND ASSET REGISTRY. It stores nothing, mints no ids, and
// moves no media. It answers exactly one question per Asset: *do we already
// know what this belongs to?* — and when the answer is no, it keeps the Asset
// visible and asks, instead of silently attaching it somewhere.
//
// Three tiers, in descending certainty:
//
//   A · deterministic  The registry/production state ALREADY names the owner:
//                      a proven creativeShotId, a bible reference, a scene's
//                      ambience, an episode BGM, a timeline clip, or a
//                      Generation whose result this Asset is. No guessing, no
//                      confirmation — the owner is a fact we already hold.
//
//   B · proposed       Not owned, but there is REAL EVIDENCE pointing at an
//                      owner (a sibling version in the same slot; a paid result
//                      the M4d bridge could not resolve). Rendered as a
//                      proposal with its evidence and a confidence, and it
//                      requires explicit confirmation before anything attaches.
//
//   C · uncertain      No owner and no evidence. Stays in the inbox. Never
//                      attached, never hidden, never guessed. This tier also
//                      carries the migration's `displaced` blobs — preserved
//                      legacy media that belongs to nothing we can name.
//
// AI-assisted classification of externally imported media (proposing character
// / state / location / scene from the pixels) is deliberately NOT implemented
// here: it would be a new agent capability and needs its own ADR. Tier B is
// evidence-based and says so — it never claims to be an AI judgement.

import { findAssetById } from "../workflow/assetlib.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

const DOMAIN_LABEL = { images: "图片", videos: "视频", audio: "音频", finals: "成片" };

/** Every Asset record in the registry, flattened with its domain + slot. */
function walkAssets(reg) {
  const out = [];
  if (!isObj(reg)) return out;
  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!isObj(m)) continue;
    for (const slot of Object.keys(m)) {
      const e = m[slot];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      for (const r of e.history) {
        if (!isObj(r) || typeof r.assetId !== "string" || !r.assetId) continue;
        out.push({
          assetId: r.assetId,
          domain,
          slot,
          version: r.version,
          url: r.url || "",
          origin: r.origin || "",
          storageState: r.storageState || "local",
          creativeShotId: typeof r.creativeShotId === "string" ? r.creativeShotId : null,
          isCurrent: r.version === e.current,
        });
      }
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) {
    if (isObj(f) && typeof f.assetId === "string" && f.assetId) {
      out.push({
        assetId: f.assetId, domain: "finals", slot: null, version: null,
        url: f.url || "", origin: f.origin || "", storageState: f.storageState || "local",
        creativeShotId: null, isCurrent: true,
      });
    }
  }
  return out;
}

/** Media the v2→v3 migration PRESERVED but could not place (assetlib's
 *  `displaced`). These are `{key, entry}` blobs of arbitrary legacy shape, not
 *  Asset records — but they are exactly "media whose owner is unknown", so
 *  leaving them out of the inbox would hide the one thing it promises never to
 *  hide. Surfaced as uncertain, never auto-attached. */
function walkDisplaced(reg) {
  if (!isObj(reg) || !Array.isArray(reg.displaced)) return [];
  const out = [];
  reg.displaced.forEach((d, i) => {
    if (!isObj(d)) return;
    const entry = d.entry;
    // a legacy chain or a bare url string may still carry a viewable frame
    let url = "";
    if (typeof entry === "string") url = entry;
    else if (isObj(entry) && Array.isArray(entry.history)) {
      const last = entry.history[entry.history.length - 1];
      if (isObj(last) && typeof last.url === "string") url = last.url;
    } else if (isObj(entry) && typeof entry.url === "string") url = entry.url;
    out.push({
      assetId: null,
      displacedIndex: i,
      displacedKey: typeof d.key === "string" ? d.key : `#${i}`,
      domain: "images",
      slot: null,
      version: null,
      url,
      origin: "displaced",
      storageState: "local",
      creativeShotId: null,
    });
  });
  return out;
}

/** Every assetId the project ALREADY points at, with a human owner label.
 *  These are facts held in the domain documents — not inferences. */
export function knownOwners({ production, timelines, generations, reg, liveShotIds }) {
  const owners = new Map();
  const claim = (id, label) => {
    if (typeof id === "string" && id && !owners.has(id)) owners.set(id, label);
  };
  if (isObj(production)) {
    for (const c of production.characters || []) {
      for (const a of c.referenceAssetIds || []) claim(a, `角色参考图 · ${c.name}`);
      for (const st of c.states || []) {
        const ov = st.overrides || {};
        for (const a of ov.referenceAssetIds || []) claim(a, `角色状态参考图 · ${c.name} · ${st.name}`);
      }
    }
    for (const l of production.locations || []) {
      for (const a of l.referenceAssetIds || []) claim(a, `场景地参考图 · ${l.name}`);
      for (const st of l.states || []) {
        const ov = st.overrides || {};
        for (const a of ov.referenceAssetIds || []) claim(a, `场景地状态参考图 · ${l.name} · ${st.name}`);
      }
    }
    for (const ep of production.episodes || []) {
      claim(ep.bgmAssetId, `剧集 BGM · ${ep.title}`);
      for (const sc of ep.scenes || []) {
        claim(sc.ambienceAssetId, `场景环境音 · ${sc.title}`);
        claim(sc.bgmAssetId, `场景 BGM · ${sc.title}`);
      }
    }
  }
  if (isObj(timelines)) {
    for (const epId of Object.keys(timelines)) {
      const t = timelines[epId];
      for (const c of (isObj(t) && t.clips) || []) claim(c.assetId, `时间线片段 · ${c.trackType}`);
    }
  }
  if (isObj(reg) && isObj(reg.firstFrames)) {
    for (const slot of Object.keys(reg.firstFrames)) {
      const r = reg.firstFrames[slot];
      if (isObj(r)) claim(r.assetId, `镜头首帧 · ${slot}`);
    }
  }
  for (const g of Array.isArray(generations) ? generations : []) {
    if (!isObj(g) || !g.targetId) continue;
    // A generation whose target shot has LEFT the draft (a regenerated
    // storyboard mints fresh ids) no longer names a live owner. Claiming it
    // here would mark the result as settled and drop it out of the inbox —
    // exactly the case tier B exists to raise as a proposal. Same rule the
    // media record's own creativeShotId already follows.
    if (liveShotIds && !liveShotIds.has(g.targetId)) continue;
    for (const a of g.resultAssetIds || []) claim(a, `生成结果 · 镜头`);
  }
  return owners;
}

/**
 * Classify the whole registry.
 *
 * @param {object} pd  ctx.prodData() — read-only.
 * @returns {{total,auto,pending,items,byTier}} where `items` holds ONLY the
 *          entries that still need a human decision (tiers B and C).
 */
export function assetInbox(pd) {
  const reg = pd.assets;
  const draft = pd.draftShots || [];
  const shotById = new Map(draft.filter((s) => s && s.shotId).map((s) => [s.shotId, s]));
  const slotsInDraft = new Set(draft.map((s) => s && s.slot).filter(Boolean));
  const owners = knownOwners({
    production: pd.production,
    timelines: pd.timelines,
    generations: pd.generations,
    reg,
    liveShotIds: new Set(shotById.keys()),
  });
  const all = walkAssets(reg);

  const items = [];
  let auto = 0;

  for (const a of all) {
    // ---- tier A: the domain already names an owner --------------------- //
    if (a.creativeShotId && shotById.has(a.creativeShotId)) {
      auto += 1;
      continue;
    }
    if (owners.has(a.assetId)) {
      auto += 1;
      continue;
    }
    if (a.domain === "finals") {
      auto += 1; // a composed final belongs to the project by construction
      continue;
    }

    // ---- tier B: real evidence points at an owner ---------------------- //
    // a creativeShotId that no longer resolves: the shot left the draft (a
    // regenerated storyboard mints fresh ids). The Asset is NOT reattached —
    // we say what it used to belong to and ask.
    if (a.creativeShotId) {
      items.push({
        ...a,
        tier: "proposed",
        confidence: 0.5,
        proposal: "曾属于一个已不在当前草稿的镜头",
        evidence: `记录的镜头身份 ${a.creativeShotId.slice(0, 12)}… 在当前分镜草稿里不存在`,
        action: "review",
      });
      continue;
    }
    // a slot that IS a draft shot's slot, but this record never recorded the
    // shot id (legacy / plain upload): the slot is real evidence, not a guess.
    if (a.slot && slotsInDraft.has(a.slot)) {
      const owner = draft.find((s) => s && s.slot === a.slot);
      items.push({
        ...a,
        tier: "proposed",
        confidence: 0.8,
        proposal: owner ? `镜头 ${String(owner.sequence).padStart(2, "0")} ${owner.title}` : "该槽位对应的镜头",
        proposalShotId: owner ? owner.shotId : null,
        evidence: `与槽位 ${a.slot} 的其它版本同属一个媒体链`,
        action: "attach",
      });
      continue;
    }

    // ---- tier C: no owner, no evidence --------------------------------- //
    items.push({
      ...a,
      tier: "uncertain",
      confidence: 0,
      proposal: null,
      evidence: "没有记录镜头身份，也没有被任何角色 / 场景 / 时间线引用",
      action: "review",
    });
  }

  // Migration leftovers: preserved, ownerless, and previously invisible here.
  for (const d of walkDisplaced(reg)) {
    items.push({
      ...d,
      tier: "uncertain",
      confidence: 0,
      proposal: null,
      evidence: `迁移时保留的历史媒体（${d.displacedKey}）——没有可用的归属信息`,
      action: "review",
    });
  }

  // M4d: paid results whose creative Shot could not be resolved are already a
  // first-class "needs a decision" record — surface them, never auto-adopt.
  for (const u of (isObj(reg) && reg.unresolvedPaid) || []) {
    if (!isObj(u) || !u.taskId) continue;
    items.push({
      assetId: null,
      taskId: u.taskId,
      domain: "videos",
      slot: null,
      url: "",
      origin: "paid-video",
      storageState: "local",
      tier: "proposed",
      confidence: 0.4,
      proposal: "付费生成结果，镜头身份未解析",
      evidence: u.reason ? String(u.reason) : `服务端镜头 ${u.serverShotId || "?"} 无法映射到创作镜头`,
      action: "review",
    });
  }

  // stable, useful order: highest-confidence proposals first, then uncertain
  items.sort((x, y) => (y.confidence - x.confidence) || String(x.assetId).localeCompare(String(y.assetId)));

  // `total` must equal auto + pending: unresolved paid records are inbox items
  // that are NOT registry assets, so they have to be counted in the total too
  // or the header prints numbers that do not add up.
  // total must equal auto + pending, so every inbox item that is NOT a
  // registry asset (unresolved paid tasks, displaced blobs) counts in it too
  const extraPending = items.filter((i) => i.taskId || i.displacedKey).length;
  return {
    total: all.length + extraPending,
    auto,
    pending: items.length,
    items,
    byTier: {
      proposed: items.filter((i) => i.tier === "proposed").length,
      uncertain: items.filter((i) => i.tier === "uncertain").length,
    },
    /** honest note about what is NOT implemented */
    aiAssisted: false,
  };
}

/** One inbox row's display label. */
export function inboxLabel(item) {
  const dom = DOMAIN_LABEL[item.domain] || item.domain;
  if (item.displacedKey) return `迁移保留 · ${item.displacedKey}`;
  if (item.taskId) return `${dom} · 付费任务 ${String(item.taskId).slice(0, 10)}…`;
  return `${dom}${item.version ? ` v${item.version}` : ""}${item.slot ? ` · ${item.slot}` : ""}`;
}

/** Resolve an inbox item back to its live registry record (never a copy). */
export function inboxRecord(reg, assetId) {
  return findAssetById(reg, assetId);
}
