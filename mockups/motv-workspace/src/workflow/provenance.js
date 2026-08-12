// Generation Provenance Graph (TASK-054) — a DERIVED read model answering one
// question: which prompt, references and inputs actually produced this asset,
// and what did that asset go on to produce?
//
// NOT A SECOND SOURCE OF TRUTH. Nothing here is persisted, cached or minted.
// Every node and edge is recomputed from records that already exist:
//
//   Generation Registry  inputAssetIds / referenceAssetIds / resultAssetIds /
//                        promptSnapshot / provider / model / status / target
//   Asset Registry       chains (images/videos/audio), finals, firstFrames
//   Production document  episodes → scenes → shotIds, character/location refs
//   Timelines            clips (which assets a render consumed)
//
// HONESTY IS THE WHOLE POINT. Two rules the rest of the module obeys:
//
//   1. An edge exists ONLY where a record proves it. Lineage is never inferred
//      from "the shot's current image" or from slot/sequence adjacency — if a
//      video was generated from Image v2, the graph says v2 even after v3
//      becomes active.
//   2. Unknown stays unknown. A plain import has no Prompt node — not an empty
//      one, not a guessed one. An asset a Generation references but the
//      registry no longer holds still appears, marked missing, so a broken
//      chain is visible rather than silently short.
//
// Pure functions: no DOM, no clock, no fetch, no writes.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === "string" ? x : "");

/** The text a script document currently holds — EXACTLY the rule
 *  `scriptdoc.currentText` uses, so the graph can never show something the
 *  workspace does not: any string buffer wins, including an empty one. Treating
 *  a cleared buffer as "no buffer" made the graph fall back to the last version
 *  and go on showing script the creator had just deleted. (Read here rather
 *  than imported only so this module stays dependency-free.) */
function scriptTextOf(doc) {
  if (!isObj(doc)) return "";
  if (typeof doc.workingText === "string") return doc.workingText;
  const av = arr(doc.versions).find((x) => isObj(x) && x.v === doc.active);
  return av && typeof av.content === "string" ? av.content : "";
}

/** Node id namespaces. Ids are derived from the SOURCE record's own id, so the
 *  same node keeps its identity across rebuilds (focus/selection survives). */
export const nodeIds = {
  asset: (assetId) => `asset:${assetId}`,
  generation: (generationId) => `gen:${generationId}`,
  // a Prompt node belongs to the Generation whose snapshot froze it: there is
  // no Prompt Library in this system, so the snapshot IS the prompt's identity
  prompt: (generationId) => `prompt:${generationId}`,
  // CP7/ADR-0058 — the CREATIVE SPINE the media hangs off. These are not
  // generated things: they are the canonical documents that decided what to
  // generate, and the graph is incomplete without them. A creator asking
  // "where did this frame come from" means the shot and the scene, not only
  // the prompt string.
  script: (episodeId) => `script:${episodeId}`,
  scene: (sceneId) => `scene:${sceneId}`,
  shot: (shotId) => `shot:${shotId}`,
};

const MEDIA_DOMAINS = ["images", "videos", "audio"];

/** Human labels — user-facing language only, never `input_0` / raw field names. */
const ASSET_KIND_LABEL = {
  characterRef: "角色参考图",
  locationRef: "场景地参考图",
  shotImage: "镜头画面",
  shotVideo: "镜头视频",
  dialogue: "对白",
  ambience: "环境音",
  sfx: "音效",
  bgm: "配乐",
  final: "成片",
  image: "图片",
  video: "视频",
  audio: "音频",
};

const GEN_KIND_LABEL = {
  image: "图片生成",
  video: "视频生成",
  audio: "语音生成",
  render: "合成渲染",
};

const PROMPT_KIND_LABEL = {
  image: "IMAGE PROMPT",
  video: "VIDEO PROMPT",
  audio: "DIALOGUE PROMPT",
  render: "RENDER SETTINGS",
};

export { ASSET_KIND_LABEL, GEN_KIND_LABEL, PROMPT_KIND_LABEL };

/* -------------------------------------------------------------------------- */
/* structural indexes                                                          */
/* -------------------------------------------------------------------------- */

/** shotId → {episodeId, episodeTitle, sceneId, sceneTitle, sequence, title}.
 *  Built from the production document's OWNERSHIP (scene.shotIds), which is the
 *  only thing that makes a shot belong to an episode. A shot in no scene
 *  belongs to no episode — it is reported as unassigned, never credited to one. */
export function shotIndex({ production, draftShots }) {
  const byId = new Map();
  const draft = new Map(arr(draftShots).filter((s) => isObj(s) && s.shotId).map((s) => [s.shotId, s]));
  for (const ep of arr(isObj(production) ? production.episodes : [])) {
    for (const sc of arr(ep.scenes)) {
      for (const shotId of arr(sc.shotIds)) {
        const raw = draft.get(shotId) || null;
        byId.set(shotId, {
          shotId,
          episodeId: ep.episodeId,
          episodeTitle: str(ep.title),
          sceneId: sc.sceneId,
          sceneTitle: str(sc.title),
          sequence: raw ? raw.sequence : null,
          title: raw ? str(raw.title) : "",
          slot: raw ? str(raw.slot) : "",
          dangling: !raw, // owned by a scene but absent from the draft
        });
      }
    }
  }
  // draft shots owned by no scene: real inventory with no episode
  for (const [shotId, raw] of draft) {
    if (byId.has(shotId)) continue;
    byId.set(shotId, {
      shotId, episodeId: null, episodeTitle: "", sceneId: null, sceneTitle: "",
      sequence: raw.sequence, title: str(raw.title), slot: str(raw.slot), dangling: false,
    });
  }
  return byId;
}

/** assetId → a role label proven by the production document / registry.
 *  These are FACTS already held (a bible reference, a scene's ambience, an
 *  episode's BGM, a recorded first frame) — not inferences about content. */
function assetRoles({ production, assets }) {
  const roles = new Map();
  const put = (id, kind, label, owner, extra) => {
    if (typeof id !== "string" || !id || roles.has(id)) return;
    roles.set(id, { kind, label, owner: owner || null, ...(extra || {}) });
  };
  /** A bible reference's ORDINAL is its position in the entity's reference
   *  list — "Ref v3" means the entity's third reference. It is NOT the media
   *  record's version: every reference is stored as its own single-version
   *  chain, so reading `version` there would print v1 for all of them and call
   *  every one of them ACTIVE. The chosen one is the entity's
   *  `activeReferenceAssetId`, and nothing else. */
  const refs = (ids, activeId, kind, label, owner) => {
    arr(ids).forEach((a, i) => {
      put(a, kind, label, owner, { refIndex: i + 1, refActive: a === activeId });
    });
  };
  if (isObj(production)) {
    for (const c of arr(production.characters)) {
      refs(c.referenceAssetIds, c.activeReferenceAssetId, "characterRef", str(c.name),
        { type: "character", id: c.characterId, name: str(c.name) });
      for (const st of arr(c.states)) {
        const ov = isObj(st.overrides) ? st.overrides : {};
        refs(ov.referenceAssetIds, ov.activeReferenceAssetId, "characterRef", `${str(c.name)} · ${str(st.name)}`,
          { type: "characterState", id: st.stateId, name: `${str(c.name)} · ${str(st.name)}` });
      }
    }
    for (const l of arr(production.locations)) {
      refs(l.referenceAssetIds, l.activeReferenceAssetId, "locationRef", str(l.name),
        { type: "location", id: l.locationId, name: str(l.name) });
      for (const st of arr(l.states)) {
        const ov = isObj(st.overrides) ? st.overrides : {};
        refs(ov.referenceAssetIds, ov.activeReferenceAssetId, "locationRef", `${str(l.name)} · ${str(st.name)}`,
          { type: "locationState", id: st.stateId, name: `${str(l.name)} · ${str(st.name)}` });
      }
    }
    for (const ep of arr(production.episodes)) {
      put(ep.bgmAssetId, "bgm", `${str(ep.title)} 配乐`, { type: "episode", id: ep.episodeId, name: str(ep.title) });
      for (const sc of arr(ep.scenes)) {
        put(sc.ambienceAssetId, "ambience", `${str(sc.title)} 环境音`, { type: "scene", id: sc.sceneId, name: str(sc.title) });
        put(sc.bgmAssetId, "bgm", `${str(sc.title)} 配乐`, { type: "scene", id: sc.sceneId, name: str(sc.title) });
      }
    }
  }
  if (isObj(assets) && isObj(assets.firstFrames)) {
    for (const slot of Object.keys(assets.firstFrames)) {
      const r = assets.firstFrames[slot];
      if (isObj(r) && typeof r.assetId === "string") {
        // a first frame is a ROLE an image plays, never a separate asset kind
        const cur = roles.get(r.assetId);
        if (!cur) roles.set(r.assetId, { kind: "shotImage", label: "", owner: null, firstFrameOf: slot });
        else cur.firstFrameOf = slot;
      }
    }
  }
  return roles;
}

/** The media kind an audio chain key encodes. Audio is the one domain whose key
 *  carries meaning (`voice-<slot>` / `music-*` / `sfx-*`), and it is read only
 *  from the key — never guessed from the content. */
function audioKind(key) {
  if (key.startsWith("voice-")) return "dialogue";
  if (key.startsWith("sfx-")) return "sfx";
  if (key.startsWith("music-") || key.startsWith("bgm-")) return "bgm";
  if (key.startsWith("ambience-")) return "ambience";
  return "audio";
}

/** Every Asset record in the registry as a graph node seed. */
function walkAssets(assets) {
  const out = [];
  if (!isObj(assets)) return out;
  for (const domain of MEDIA_DOMAINS) {
    const m = assets[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const chain = m[key];
      if (!isObj(chain) || !Array.isArray(chain.history)) continue;
      for (const r of chain.history) {
        if (!isObj(r) || typeof r.assetId !== "string" || !r.assetId) continue;
        out.push({
          assetId: r.assetId,
          domain,
          key,
          version: typeof r.version === "number" ? r.version : null,
          url: str(r.url),
          origin: str(r.origin),
          storageState: str(r.storageState) || "local",
          // the shot identity RECORDED on the media record; never re-derived
          creativeShotId: typeof r.creativeShotId === "string" ? r.creativeShotId : null,
          isCurrent: r.version === chain.current,
          chainCurrent: chain.current,
        });
      }
    }
  }
  for (const f of arr(assets.finals)) {
    if (!isObj(f) || typeof f.assetId !== "string" || !f.assetId) continue;
    out.push({
      assetId: f.assetId, domain: "finals", key: null, version: null,
      url: str(f.url), origin: str(f.origin), storageState: str(f.storageState) || "local",
      creativeShotId: null, isCurrent: true, chainCurrent: null,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* the graph                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the provenance graph.
 *
 * @param {object}  src.assets       Asset Registry (canvas `assets`)
 * @param {Array}   src.generations  Generation Registry (canvas `generations`)
 * @param {object}  src.production   production document
 * @param {object}  src.timelines    episodeId → timeline
 * @param {Array}   src.draftShots   current storyboard draft
 * @param {object}  src.scripts      episodeId → script document (CP7 spine)
 * @returns {{nodes: Map, edges: Array, order: Array, warnings: Array}}
 *   `nodes` is id → node; `edges` are {from, to, kind}; `order` is the node ids
 *   in a deterministic left→right layered order.
 */
export function buildProvenanceGraph({ assets, generations, production, timelines, draftShots, scripts } = {}) {
  const shots = shotIndex({ production, draftShots });
  const roles = assetRoles({ production, assets });
  const nodes = new Map();
  const edges = [];
  const warnings = [];

  const addEdge = (from, to, kind) => {
    if (!from || !to || from === to) return;
    edges.push({ from, to, kind, id: `${from}→${to}:${kind}` });
  };

  // ---- the creative spine: Script → Scene → Shot -------------------------- //
  // These come from the canonical documents, so they exist whether or not
  // anything was ever generated: a shot with no image is still a real shot, and
  // showing it is how the graph says "nothing has been made for this yet".
  // A script node exists only where an episode HAS script text — an empty
  // episode gets no node rather than an empty one (§14: unknown stays unknown).
  for (const ep of arr(isObj(production) ? production.episodes : [])) {
    const doc = isObj(scripts) ? scripts[ep.episodeId] : null;
    const text = scriptTextOf(doc);
    let scriptNodeId = null;
    // whitespace is not a script: an emptied draft gets no node, exactly as an
    // episode that never had one doesn't
    if (text.trim()) {
      scriptNodeId = nodeIds.script(ep.episodeId);
      nodes.set(scriptNodeId, {
        id: scriptNodeId,
        type: "script",
        kind: "script",
        kindLabel: "剧本",
        episodeId: ep.episodeId,
        sceneId: null,
        shotId: null,
        title: str(ep.title),
        text,
        version: isObj(doc) && Number.isInteger(doc.active) && doc.active > 0 ? doc.active : null,
      });
    }
    for (const sc of arr(ep.scenes)) {
      const sceneNodeId = nodeIds.scene(sc.sceneId);
      nodes.set(sceneNodeId, {
        id: sceneNodeId,
        type: "scene",
        kind: "scene",
        kindLabel: "场景",
        episodeId: ep.episodeId,
        sceneId: sc.sceneId,
        shotId: null,
        title: str(sc.title),
        shotCount: arr(sc.shotIds).length,
      });
      addEdge(scriptNodeId, sceneNodeId, "scene");
      for (const shotId of arr(sc.shotIds)) {
        const s = shots.get(shotId);
        const shotNodeId = nodeIds.shot(shotId);
        nodes.set(shotNodeId, {
          id: shotNodeId,
          type: "shot",
          kind: "shot",
          kindLabel: "镜头",
          episodeId: ep.episodeId,
          sceneId: sc.sceneId,
          shotId,
          shot: s || null,
          title: s ? str(s.title) : "",
          // a scene owning a shot the draft no longer holds is a REAL state:
          // the node stays and says so, it is never quietly dropped
          dangling: !s || s.dangling === true,
        });
        addEdge(sceneNodeId, shotNodeId, "shot");
      }
    }
  }

  // ---- asset nodes -------------------------------------------------------- //
  for (const a of walkAssets(assets)) {
    const role = roles.get(a.assetId) || null;
    let kind = role ? role.kind : null;
    if (!kind) {
      if (a.domain === "images") kind = "shotImage";
      else if (a.domain === "videos") kind = "shotVideo";
      else if (a.domain === "audio") kind = audioKind(a.key || "");
      else if (a.domain === "finals") kind = "final";
      else kind = "image";
    }
    nodes.set(nodeIds.asset(a.assetId), {
      id: nodeIds.asset(a.assetId),
      type: "asset",
      assetId: a.assetId,
      kind,
      kindLabel: ASSET_KIND_LABEL[kind] || kind,
      domain: a.domain,
      slot: a.domain === "audio" || a.domain === "finals" ? null : a.key,
      chainKey: a.key,
      // a bible reference numbers by its position in the entity's list, not by
      // the media chain's version (see assetRoles)
      version: role && role.refIndex ? role.refIndex : a.version,
      versionKind: role && role.refIndex ? "reference" : "media",
      url: a.url,
      origin: a.origin,
      storageState: a.storageState,
      active: role && role.refIndex ? role.refActive === true : a.isCurrent,
      shotId: a.creativeShotId,
      roleLabel: role ? role.label : "",
      roleOwner: role ? role.owner : null,
      firstFrameOf: role && role.firstFrameOf ? role.firstFrameOf : null,
      missing: false,
    });
  }

  /** An asset a Generation names but the registry no longer holds. It STAYS in
   *  the graph: a chain that silently ends would read as "no provenance" when
   *  the truth is "the media was removed but the lineage is recorded". */
  const ensureAsset = (assetId, hintKind) => {
    const id = nodeIds.asset(assetId);
    if (nodes.has(id)) return id;
    // The hint is only ever what the GENERATION's own type proves (a video
    // generation's result is a video). Where nothing proves it, the node says
    // "已删除的媒体" rather than guessing a character reference or an image —
    // a wrong media type reads as a fact the records never stated.
    nodes.set(id, {
      id, type: "asset", assetId, kind: hintKind || "unknown",
      kindLabel: ASSET_KIND_LABEL[hintKind] || "已删除的媒体",
      domain: null, slot: null, chainKey: null, version: null, url: "",
      origin: "", storageState: "deleted", active: false, shotId: null,
      roleLabel: "", roleOwner: null, firstFrameOf: null,
      missing: true,
    });
    return id;
  };

  // ---- generation + prompt nodes ------------------------------------------ //
  for (const g of arr(generations)) {
    if (!isObj(g) || typeof g.generationId !== "string" || !g.generationId) continue;
    const gid = nodeIds.generation(g.generationId);
    const shot = g.targetId ? shots.get(g.targetId) || null : null;
    if (g.targetId && !shot) warnings.push({ kind: "unknownTarget", generationId: g.generationId, targetId: g.targetId });
    nodes.set(gid, {
      id: gid,
      type: "generation",
      generationId: g.generationId,
      kind: str(g.type) || "image",
      kindLabel: GEN_KIND_LABEL[str(g.type)] || str(g.type) || "生成",
      status: str(g.status) || "generating",
      provider: str(g.provider),
      model: str(g.model),
      parameters: isObj(g.parameters) ? g.parameters : null,
      createdAt: str(g.createdAt),
      userInstruction: str(g.userInstruction),
      promptSnapshot: str(g.promptSnapshot),
      shotId: g.targetId || null,
      shot,
      episodeId: shot ? shot.episodeId : null,
      sceneId: shot ? shot.sceneId : null,
    });

    // A Prompt node exists ONLY where a snapshot was actually frozen. A render
    // has settings, not a prompt — §14: never invent one.
    if (str(g.promptSnapshot)) {
      const pid = nodeIds.prompt(g.generationId);
      nodes.set(pid, {
        id: pid,
        type: "prompt",
        generationId: g.generationId,
        kind: str(g.type) || "image",
        kindLabel: PROMPT_KIND_LABEL[str(g.type)] || "PROMPT",
        text: str(g.promptSnapshot),
        userInstruction: str(g.userInstruction),
        provider: str(g.provider),
        shotId: g.targetId || null,
        shot,
        episodeId: shot ? shot.episodeId : null,
        sceneId: shot ? shot.sceneId : null,
      });
      addEdge(pid, gid, "prompt");
    }

    // A video generation's input IS an image — that much the record proves.
    // Nothing proves what a missing REFERENCE was (character? location?), so it
    // gets no guess.
    for (const a of arr(g.inputAssetIds)) addEdge(ensureAsset(a, g.type === "video" ? "shotImage" : null), gid, "input");
    for (const a of arr(g.referenceAssetIds)) addEdge(ensureAsset(a, null), gid, "reference");
    for (const a of arr(g.resultAssetIds)) {
      // a generation's own type tells us what it produced
      const RESULT_KIND = { render: "final", video: "shotVideo", audio: "dialogue", image: "shotImage" };
      const aid = ensureAsset(a, RESULT_KIND[str(g.type)] || null);
      addEdge(gid, aid, "result");
      // stamp the producing generation onto its result so an Asset node can
      // answer "generated by" without re-scanning the registry
      const n = nodes.get(aid);
      if (n && !n.producedBy) n.producedBy = g.generationId;
    }
  }

  // ---- the shot a generation was made FOR ---------------------------------- //
  // The Generation already records its target; drawing it makes the spine
  // continuous, so a frame can be traced back past its prompt to the shot,
  // the scene and the script that asked for it.
  for (const n of nodes.values()) {
    if (n.type !== "generation" || !n.shotId) continue;
    const sid = nodeIds.shot(n.shotId);
    if (nodes.has(sid)) addEdge(sid, n.id, "target");
  }

  // ---- shared canonical References (CP4 bindings) --------------------------- //
  // ONE node per Reference, however many shots use it. The whole reason a
  // Reference is canonical is that 林晚 Ref is a single thing ten shots point
  // at; drawing ten copies would say the opposite, and would hide the fact
  // that re-pointing the chain moves all ten at once.
  //
  // The binding names the CHAIN; the node is the chain's CURRENT version,
  // because that is what a generation launched today would actually receive.
  if (isObj(production) && isObj(production.shotProduction) && isObj(production.shotProduction.references)) {
    const currentOfChain = new Map();
    for (const a of walkAssets(assets)) {
      if (!a.isCurrent) continue;
      if (!currentOfChain.has(a.key)) currentOfChain.set(a.key, a.assetId);
    }
    const map = production.shotProduction.references;
    for (const shotId of Object.keys(map)) {
      const sid = nodeIds.shot(shotId);
      if (!nodes.has(sid)) continue; // an unassigned shot has no spine node
      for (const chainKey of arr(map[shotId])) {
        const assetId = currentOfChain.get(chainKey);
        if (!assetId) {
          // the binding survives a deleted reference; the graph reports the
          // dangling binding instead of drawing a link to nothing
          warnings.push({ kind: "danglingReference", shotId, referenceKey: chainKey });
          continue;
        }
        const aid = nodeIds.asset(assetId);
        if (nodes.has(aid)) addEdge(sid, aid, "binds");
      }
    }
  }

  // ---- recorded first frames ---------------------------------------------- //
  // The one non-Generation provenance record in the system: `firstFrames[slot]`
  // is the frame recorded for a SLOT. It is slot-level, singular, and
  // overwritten — it does NOT name a video version.
  //
  // It is overwritten at each launch, so the only version it can describe is
  // the NEWEST take in the slot. Not "every version" (that would claim three
  // imports came from one frame) and not "whichever version is selected"
  // either — selecting an older take would then invent a source image that did
  // not exist when that take was made. Every other version keeps no
  // first-frame edge at all: unknown stays unknown.
  if (isObj(assets) && isObj(assets.firstFrames) && isObj(assets.videos)) {
    for (const slot of Object.keys(assets.firstFrames)) {
      const ff = assets.firstFrames[slot];
      if (!isObj(ff) || typeof ff.assetId !== "string") continue;
      const chain = assets.videos[slot];
      if (!isObj(chain) || !Array.isArray(chain.history)) continue;
      let newest = null;
      for (const v of chain.history) {
        if (!isObj(v) || typeof v.assetId !== "string") continue;
        if (!newest || (v.version || 0) > (newest.version || 0)) newest = v;
      }
      if (!newest) continue;
      const vid = nodeIds.asset(newest.assetId);
      if (!nodes.has(vid)) continue;
      // Suppress this weaker record only when the producing Generation actually
      // recorded an input — that is the case where it "already says it, in
      // full". A Generation that produced the video but froze NO inputs
      // explains nothing about its source, and dropping the slot record there
      // left the video looking source-less when a record did exist.
      const producer = edges.find((e) => e.kind === "result" && e.to === vid);
      if (producer && edges.some((e) => e.kind === "input" && e.to === producer.from)) continue;
      addEdge(ensureAsset(ff.assetId, "shotImage"), vid, "firstFrame");
    }
  }

  // ---- render → final ------------------------------------------------------ //
  // A render Generation records its clips in `parameters.clips`; those clip
  // assets ARE its inputs and are already edged above via inputAssetIds. Here we
  // only attach the episode identity so episode scoping can see the render.
  for (const n of nodes.values()) {
    if (n.type !== "generation" || n.kind !== "render") continue;
    const p = n.parameters || {};
    if (typeof p.episodeId === "string") n.episodeId = p.episodeId;
  }
  if (isObj(timelines)) {
    for (const epId of Object.keys(timelines)) {
      const t = timelines[epId];
      for (const c of arr(isObj(t) ? t.clips : [])) {
        if (!isObj(c) || typeof c.assetId !== "string") continue;
        const n = nodes.get(nodeIds.asset(c.assetId));
        if (n && !n.timelineOf) n.timelineOf = { episodeId: epId, trackType: str(c.trackType) };
      }
    }
  }

  // ---- derive each asset node's episode/scene ------------------------------ //
  // An asset belongs where its SHOT belongs. Bible references belong to no
  // episode (they are project-level) and are pulled into a scope only by an
  // edge, never by assumption.
  const producedByGen = new Map();
  for (const e of edges) if (e.kind === "result") producedByGen.set(e.to, e.from);
  for (const n of nodes.values()) {
    if (n.type !== "asset") continue;
    let shotId = n.shotId;
    if (!shotId) {
      const gid = producedByGen.get(n.id);
      const gen = gid ? nodes.get(gid) : null;
      if (gen && gen.shotId) shotId = gen.shotId;
    }
    const s = shotId ? shots.get(shotId) : null;
    n.shotId = shotId || null;
    n.shot = s || null;
    n.episodeId = s ? s.episodeId : (n.timelineOf ? n.timelineOf.episodeId : null);
    n.sceneId = s ? s.sceneId : null;
    if (n.kind === "ambience" || n.kind === "bgm") {
      // scene/episode audio is owned by the production document, not a shot
      const owner = n.roleOwner;
      if (owner && owner.type === "scene") {
        n.sceneId = owner.id;
        for (const ep of arr(isObj(production) ? production.episodes : [])) {
          if (arr(ep.scenes).some((sc) => sc.sceneId === owner.id)) n.episodeId = ep.episodeId;
        }
      } else if (owner && owner.type === "episode") {
        n.episodeId = owner.id;
      }
    }
    if (n.kind === "final" && !n.episodeId) {
      const gid = producedByGen.get(n.id);
      const gen = gid ? nodes.get(gid) : null;
      if (gen && gen.episodeId) n.episodeId = gen.episodeId;
    }
  }
  // prompts/generations with no shot but an episode-level parameter keep it
  for (const n of nodes.values()) {
    if (n.type === "generation" && n.shot) { n.episodeId = n.shot.episodeId; n.sceneId = n.shot.sceneId; }
    if (n.type === "prompt" && n.shot) { n.episodeId = n.shot.episodeId; n.sceneId = n.shot.sceneId; }
  }

  return { nodes, edges, order: layerOrder(nodes, edges), warnings, shots };
}

/* -------------------------------------------------------------------------- */
/* layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic layered ranks, in the shape the creator reads left→right:
 *
 *   REFERENCES(0) → PROMPT(1) → GENERATION(2) → RESULT(3) → PROMPT(4) → …
 *
 * A generation therefore sits TWO columns after its furthest input, leaving the
 * column immediately before it for the prompt that drove it. Ranks come from
 * the edges alone, so the same graph always lays out identically — no force
 * simulation, no randomness, no stored positions.
 *
 * Provenance cannot contain a cycle (a result never precedes its own inputs),
 * but a hand-corrupted save could; the walk carries a visiting guard so such a
 * save renders imperfectly instead of hanging the page.
 */
export function layerOrder(nodes, edges) {
  const feeders = new Map(); // generation → assets it consumed
  const producer = new Map(); // asset → the generation that produced it
  const promptOf = new Map(); // generation → its prompt node
  // asset → asset: a recorded first frame is the ONE provenance link with no
  // generation between its ends. It still has to advance a column, or the
  // source frame and the video it produced would sit in the same column and the
  // wire between them (drawn only left→right) would be dropped entirely.
  const framedBy = new Map();
  // shot → the canonical References it binds (CP7). One reference node can be
  // bound by many shots, so its column is set by the RIGHTMOST of them — that
  // keeps the wires forward-only for every shot sharing it.
  const boundBy = new Map();
  for (const id of nodes.keys()) feeders.set(id, []);
  for (const e of edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    if (e.kind === "result") producer.set(e.to, e.from);
    else if (e.kind === "prompt") promptOf.set(e.to, e.from);
    else if (e.kind === "firstFrame") framedBy.set(e.to, e.from);
    else if (e.kind === "binds") {
      if (!boundBy.has(e.to)) boundBy.set(e.to, []);
      boundBy.get(e.to).push(e.from);
    } else feeders.get(e.to).push(e.from);
  }

  const rank = new Map();
  const visiting = new Set();
  const maxOf = (ids, base) => {
    let r = base;
    for (const f of ids) r = Math.max(r, rankOf(f));
    return r;
  };
  const rankOf = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id)) return 0; // corrupt cycle — stop, do not hang
    visiting.add(id);
    const n = nodes.get(id);
    let r = 0;
    if (n.type === "script") {
      r = 0; // the spine starts at the document that decided everything else
    } else if (n.type === "scene" || n.type === "shot") {
      // one column per step of the spine; an episode with no script text has
      // no script node, and its scenes simply start the chain instead
      r = maxOf(feeders.get(id), -1) + 1;
    } else if (n.type === "generation") {
      // -1, not -2: an inputless generation (a dialogue take, a text-only
      // image) still needs its Prompt column to its left. Clamping both to 0
      // co-locates them, and the forward-only wire renderer then drops the one
      // edge that explains the generation.
      r = maxOf(feeders.get(id), -1) + 2;
    } else if (n.type === "prompt") {
      // always immediately left of the generation it froze
      const gen = [...promptOf.entries()].find(([, p]) => p === id);
      r = gen ? Math.max(0, rankOf(gen[0]) - 1) : 0;
    } else {
      const p = producer.get(id);
      const f = framedBy.get(id);
      r = p ? rankOf(p) + 1 : 0;
      // a first-framed import lands one column right of the frame it came from
      if (f) r = Math.max(r, rankOf(f) + 1);
      // a shared Reference sits right of the shots that bind it
      const b = boundBy.get(id);
      if (b) r = Math.max(r, maxOf(b, -1) + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of nodes.keys()) rankOf(id);
  for (const [id, n] of nodes) n.rank = rank.get(id) || 0;

  return [...nodes.keys()].sort((a, b) => {
    const na = nodes.get(a), nb = nodes.get(b);
    return (na.rank - nb.rank) || String(a).localeCompare(String(b));
  });
}

/* -------------------------------------------------------------------------- */
/* scoping / tracing / search                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Restrict the graph to one episode / scene / shot.
 *
 * Scoping is by OWNERSHIP first: a node in the scope is one whose shot (or
 * scene/episode) is in it. Project-level inputs (character and location
 * references) have no episode of their own, so they are pulled in ONLY when an
 * in-scope generation actually consumes them — which is what makes an episode
 * view show 林晚 Ref v3 without leaking every other episode's work.
 */
export function scopeGraph(graph, scope) {
  const { nodes, edges } = graph;
  const kind = scope && scope.kind ? scope.kind : "project";
  if (kind === "project") return { ...graph, order: graph.order.slice(), scope: { kind: "project" } };

  const inScope = (n) => {
    if (kind === "episode") return n.episodeId === scope.id;
    if (kind === "scene") return n.sceneId === scope.id;
    if (kind === "shot") return n.shotId === scope.id;
    return true;
  };

  const keep = new Set();
  for (const n of nodes.values()) if (inScope(n)) keep.add(n.id);
  // One hop out: EVERY input an in-scope generation proves it used, whatever it
  // is — a bible reference, a shot image from another scene, or an asset the
  // registry no longer holds. Keeping only bible references would drop a real
  // recorded input from the lineage and make the generation look sourceless.
  for (const e of edges) {
    if (!keep.has(e.to)) continue;
    const from = nodes.get(e.from);
    if (!from) continue;
    if (from.type === "asset" || from.type === "prompt") keep.add(from.id);
  }
  // an in-scope generation's results always belong with it
  for (const e of edges) {
    if (e.kind === "result" && keep.has(e.from)) keep.add(e.to);
  }
  // …and so do the canonical References an in-scope shot binds. A Reference is
  // project-level (林晚 Ref belongs to 林晚, not to one episode), so ownership
  // alone would drop it from every scope — which is precisely the node a
  // creator narrowing to one shot most wants to see.
  for (const e of edges) {
    if (e.kind === "binds" && keep.has(e.from)) keep.add(e.to);
  }

  const sub = new Map();
  for (const id of graph.order) if (keep.has(id)) sub.set(id, nodes.get(id));
  return {
    ...graph,
    nodes: sub,
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    order: graph.order.filter((id) => keep.has(id)),
    scope: { kind, id: scope.id },
  };
}

/** Everything upstream of a node (its inputs, their generations, their prompts
 *  and inputs, transitively). */
export function upstreamOf(graph, nodeId) {
  return walk(graph, nodeId, (e) => e.to, (e) => e.from);
}

/** Everything downstream (what this node went on to produce). */
export function downstreamOf(graph, nodeId) {
  return walk(graph, nodeId, (e) => e.from, (e) => e.to);
}

function walk(graph, startId, matchSide, nextSide) {
  const seen = new Set();
  if (!graph.nodes.has(startId)) return seen;
  const stack = [startId];
  const guard = graph.nodes.size + 1;
  let steps = 0;
  while (stack.length && steps < guard * 4) {
    steps += 1;
    const cur = stack.pop();
    for (const e of graph.edges) {
      if (matchSide(e) !== cur) continue;
      const next = nextSide(e);
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  seen.delete(startId);
  return seen;
}

/** The focus set for a selection: upstream ∪ selected ∪ downstream. */
export function traceOf(graph, nodeId, mode = "full") {
  const set = new Set([nodeId]);
  if (mode === "full" || mode === "up") for (const id of upstreamOf(graph, nodeId)) set.add(id);
  if (mode === "full" || mode === "down") for (const id of downstreamOf(graph, nodeId)) set.add(id);
  return set;
}

/** The searchable text of a node — what the user would actually type. */
export function searchText(n) {
  const bits = [];
  if (n.type === "asset") {
    bits.push(n.kindLabel, n.roleLabel, n.slot || "", n.version ? `v${n.version}` : "", n.origin);
    if (n.shot) bits.push(n.shot.title, n.shot.sceneTitle, n.shot.episodeTitle, seqLabel(n.shot));
  } else if (n.type === "generation") {
    bits.push(n.kindLabel, n.provider, n.model, n.status, n.generationId);
    if (n.shot) bits.push(n.shot.title, seqLabel(n.shot));
  } else if (n.type === "prompt") {
    bits.push(n.kindLabel, n.text, n.userInstruction, n.provider);
    if (n.shot) bits.push(n.shot.title, seqLabel(n.shot));
  } else if (n.type === "script") {
    // the script's TEXT is searchable: "他不会来了" should find the episode it
    // was written in, which is the whole point of putting it in the graph
    bits.push(n.kindLabel, n.title, n.text);
  } else if (n.type === "scene" || n.type === "shot") {
    bits.push(n.kindLabel, n.title);
    if (n.shot) bits.push(n.shot.sceneTitle, n.shot.episodeTitle, seqLabel(n.shot));
  }
  return bits.filter(Boolean).join(" ").toLowerCase();
}

/** `SHOT 03` — the label a creator recognises, from the recorded sequence. */
export function seqLabel(shot) {
  if (!shot || shot.sequence == null) return "";
  return `SHOT ${String(shot.sequence).padStart(2, "0")}`;
}

/** Search the (already scoped) graph. Returns matching node ids in graph order. */
export function searchGraph(graph, queryText) {
  const q = String(queryText || "").trim().toLowerCase();
  if (!q) return [];
  return graph.order.filter((id) => searchText(graph.nodes.get(id)).includes(q));
}

/* -------------------------------------------------------------------------- */
/* grouping (progressive disclosure)                                           */
/* -------------------------------------------------------------------------- */

/** Scene-level summary rows for the episode overview: how much work each scene
 *  actually holds, so a 12-shot episode does not open as 200 nodes. Counts are
 *  of NODES IN THE GRAPH — they can never disagree with what expanding shows. */
export function sceneGroups(graph, production, episodeId) {
  const out = [];
  for (const ep of arr(isObj(production) ? production.episodes : [])) {
    if (episodeId && ep.episodeId !== episodeId) continue;
    for (const sc of arr(ep.scenes)) {
      const ids = graph.order.filter((id) => graph.nodes.get(id).sceneId === sc.sceneId);
      const of = (fn) => ids.filter((id) => fn(graph.nodes.get(id))).length;
      out.push({
        sceneId: sc.sceneId,
        title: str(sc.title),
        episodeId: ep.episodeId,
        shots: arr(sc.shotIds).length,
        images: of((n) => n.type === "asset" && n.kind === "shotImage"),
        videos: of((n) => n.type === "asset" && n.kind === "shotVideo"),
        audio: of((n) => n.type === "asset" && (n.kind === "dialogue" || n.kind === "sfx" || n.kind === "ambience" || n.kind === "bgm")),
        generations: of((n) => n.type === "generation"),
        failed: of((n) => n.type === "generation" && (n.status === "failed" || n.status === "cancelled")),
      });
    }
  }
  return out;
}

/** Shot rows inside a scene, in recorded sequence order. */
export function shotGroups(graph, production, sceneId) {
  const ids = new Set();
  for (const ep of arr(isObj(production) ? production.episodes : [])) {
    for (const sc of arr(ep.scenes)) {
      if (sc.sceneId !== sceneId) continue;
      for (const s of arr(sc.shotIds)) ids.add(s);
    }
  }
  const out = [];
  for (const shotId of ids) {
    const s = graph.shots.get(shotId);
    const nodeIdsHere = graph.order.filter((id) => graph.nodes.get(id).shotId === shotId);
    const of = (fn) => nodeIdsHere.filter((id) => fn(graph.nodes.get(id))).length;
    out.push({
      shotId,
      shot: s || null,
      label: s ? `${seqLabel(s)} ${s.title}`.trim() : shotId,
      images: of((n) => n.type === "asset" && n.kind === "shotImage"),
      videos: of((n) => n.type === "asset" && n.kind === "shotVideo"),
      audio: of((n) => n.type === "asset" && n.kind === "dialogue"),
      generations: of((n) => n.type === "generation"),
      failed: of((n) => n.type === "generation" && (n.status === "failed" || n.status === "cancelled")),
    });
  }
  out.sort((a, b) => {
    const sa = a.shot && a.shot.sequence != null ? a.shot.sequence : 1e9;
    const sb = b.shot && b.shot.sequence != null ? b.shot.sequence : 1e9;
    return sa - sb || String(a.shotId).localeCompare(String(b.shotId));
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* per-node explanations (what the inspectors and the AI Director read)        */
/* -------------------------------------------------------------------------- */

/**
 * The provenance story of ONE node, as records — never prose invented on top.
 * The AI Director renders this; it may summarise these facts and must not add
 * a link that is not in here.
 */
export function explainNode(graph, nodeId) {
  const n = graph.nodes.get(nodeId);
  if (!n) return null;
  const inbound = graph.edges.filter((e) => e.to === nodeId);
  const outbound = graph.edges.filter((e) => e.from === nodeId);
  const get = (id) => graph.nodes.get(id) || null;
  const story = {
    node: n,
    inputs: inbound.filter((e) => e.kind === "input").map((e) => get(e.from)).filter(Boolean),
    references: inbound.filter((e) => e.kind === "reference").map((e) => get(e.from)).filter(Boolean),
    firstFrame: inbound.filter((e) => e.kind === "firstFrame").map((e) => get(e.from)).filter(Boolean),
    prompt: inbound.filter((e) => e.kind === "prompt").map((e) => get(e.from)).filter(Boolean)[0] || null,
    producedBy: inbound.filter((e) => e.kind === "result").map((e) => get(e.from)).filter(Boolean)[0] || null,
    results: outbound.filter((e) => e.kind === "result").map((e) => get(e.to)).filter(Boolean),
    usedBy: outbound.filter((e) => e.kind === "input" || e.kind === "reference" || e.kind === "firstFrame").map((e) => get(e.to)).filter(Boolean),
    // CP7 — the creative spine around this node
    boundReferences: outbound.filter((e) => e.kind === "binds").map((e) => get(e.to)).filter(Boolean),
    boundByShots: inbound.filter((e) => e.kind === "binds").map((e) => get(e.from)).filter(Boolean),
    madeFor: inbound.filter((e) => e.kind === "target").map((e) => get(e.from)).filter(Boolean)[0] || null,
    generations: outbound.filter((e) => e.kind === "target").map((e) => get(e.to)).filter(Boolean),
    partOf: inbound.filter((e) => e.kind === "scene" || e.kind === "shot").map((e) => get(e.from)).filter(Boolean)[0] || null,
    contains: outbound.filter((e) => e.kind === "scene" || e.kind === "shot").map((e) => get(e.to)).filter(Boolean),
  };
  if (n.type === "script" || n.type === "scene" || n.type === "shot") {
    // the spine is authored, not generated — saying "import" would be as wrong
    // as saying "generated"
    story.provenance = "authored";
  } else if (n.type === "asset" && !story.producedBy) {
    // §14: be honest. An imported asset has no generation and no prompt.
    story.provenance = n.missing ? "missing" : "import";
  } else {
    story.provenance = "generated";
  }
  // the prompt of the generation that produced THIS asset (one hop further up)
  if (n.type === "asset" && story.producedBy) {
    const gid = story.producedBy.id;
    story.prompt = graph.edges
      .filter((e) => e.to === gid && e.kind === "prompt")
      .map((e) => get(e.from))
      .filter(Boolean)[0] || null;
    story.inputs = graph.edges.filter((e) => e.to === gid && e.kind === "input").map((e) => get(e.from)).filter(Boolean);
    story.references = graph.edges.filter((e) => e.to === gid && e.kind === "reference").map((e) => get(e.from)).filter(Boolean);
  }
  return story;
}
