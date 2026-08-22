// 当前 Shot Production Graph (TASK-065 §9 / §10) — 「这一个镜头怎么被做出来」.
//
// THE QUESTION THIS ANSWERS IS NOT THE PROVENANCE QUESTION. `workflow/provenance.js`
// answers 「这个东西是怎么来的」 across a whole episode, which is the right question
// AFTER something exists. It is the wrong thing to land on: a creator opening
// 剧集制作 wants to MAKE the next shot, and a project-wide graph of everything that
// already exists buries the one shot they are on in everything they are not.
//
// So this is a second READ MODEL over the same records, scoped to ONE shot, laid
// out as the production chain actually runs (Image First → Video):
//
//   Character / Location / Style / Prop Ref + Prev End Frame ─┐
//                                                            ↓
//                                                      Image Prompt
//                                                            ↓
//                                             主帧图（当前选定，历史在二级）
//                                                            ↓
//   Camera / Motion / Video Style / Performance Ref ──────────┤
//                                                            ↓
//                                                      Video Prompt
//                                                            ↓
//                                          最终视频（当前选定，历史在二级）
//                                                            ↓
//                                                  End Frame（可选，给下一镜）
//
// ONE CARD PER STAGE, SHOWING THE SELECTED VERSION (TASK-066 §1 / §10). Generation is
// an ACTION on the media card (上传 / 自动生成 / 修改), not a card of its own, and the
// other versions are the card's history behind a secondary entry — 主界面只显示用户
// 当前选定版本. Drawing v1…v4 as peer cards made the creator's own choice the least
// prominent thing on the row.
//
// IT IS A CROSSING NETWORK, NOT FOUR COLUMNS (§9 的硬约束). A style reference feeds
// BOTH prompts. Every image version can be a video's source, and the ACTIVE one is
// only the default. A start frame comes out of ANOTHER shot's video. So this model
// emits nodes with a BAND (how far down the chain they sit) and edges with real
// endpoints, and lets the renderer measure and draw them — a layout that forced
// every edge into one left-to-right rank would have to drop the edges that make
// this a network.
//
// TWO GROUPS THE CREATOR MUST SEE APART (§10):
//
//   base    已有可复用基础资产 — 林婉 Ref v3 / 暗夜酒吧 Ref v2 / 林婉 Base Voice /
//           Project Style. These come from 故事开发 · 世界观 · 资产库 and are
//           REUSED, not remade. Each one is `bound` (already an input of this
//           shot) or `available` (exists and is not bound yet).
//   needs   当前 Shot 还需要补充 — Start Frame / Motion Ref / Camera Ref /
//           当前 Character State / 特殊 Prop.
//
// Merging them into one pile of asset nodes is exactly what makes a creator
// re-upload a portrait that already exists.
//
// EVERY NODE TRACES TO A RECORD. Nothing is drawn for a link the documents do not
// hold, an absent input is a stated GAP rather than a placeholder node, and a
// version with no bytes on disk says so instead of rendering as a picture.
//
// Pure derivation — no fetch, no DOM, no clock, no writes.

import { ROLE_LABEL, isInterpretationRole, MODEL_INPUT_ROLES, INTERPRETATION_ROLES } from "./geninput.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "./bibledoc.js";
import { listReferences, derivedLabel } from "./assetreg.js";

const s = (x) => (typeof x === "string" ? x.trim() : "");

/** The first ~110 characters of a prompt, for the card face. Line breaks collapse so
 *  the preview cannot silently take four lines of the card. */
function previewOf(text) {
  const flat = s(text).replace(/\s+/g, " ");
  return flat.length > 110 ? `${flat.slice(0, 109)}…` : flat;
}

/**
 * 制作阶段 (TASK-066 §9) — 「告诉用户当前做到哪里」, four steps, DERIVED.
 *
 * It is a LOCATOR, not four pages and not a gate: every step stays reachable at any
 * time. `doing` is the first step that is not done, so the bar always points at one
 * thing rather than lighting up everything that is incomplete.
 */
export const STAGES = [
  ["refs", "参考准备"],
  ["image", "主要画面"],
  ["video", "视频编排"],
  ["final", "最终视频"],
];

function stagesOf({ hasImageRefs, hasImage, hasVideoRefs, hasVideo }) {
  const done = {
    refs: hasImageRefs,
    image: hasImage,
    // 视频编排 is done when the video prompt has what it needs: a chosen main frame
    // AND at least one directing reference. A prompt with neither is not 「排好了」.
    video: hasImage && hasVideoRefs,
    final: hasVideo,
  };
  // ONCE THE SHOT IS FINISHED, NOTHING IS 「doing」. A shot whose final video is
  // selected is done, even if an earlier step was skipped — an imported take never had
  // directing references, and marking 视频编排 as 「in progress」 while the video it
  // would have produced is already chosen reads as a contradiction. The skipped step
  // stays `todo` (it honestly was not done) rather than being back-filled as done.
  const finished = done.final;
  let doing = null;
  return STAGES.map(([key, label]) => {
    let state;
    if (done[key]) state = "done";
    else if (!finished && !doing) { doing = key; state = "doing"; }
    else state = "todo";
    return { key, label, state };
  });
}

/**
 * The BANDS, top to bottom. A band is a stage of the chain, and its label is what
 * the creator is looking at — not what the system calls it internally.
 *
 * `refs` and `directing` are two different bands on purpose: the first is 「画面里
 * 有什么」 and feeds the Image Prompt, the second is 「怎么拍怎么演」 and feeds the
 * Video Prompt. Putting all eight reference roles in one row would suggest they all
 * reach the same place, which is the confusion ADR-0061 决策 4 exists to remove.
 */
export const BANDS = [
  ["refs", "参考输入", "主要画面参考 + 连续性首帧 —— 大部分应该是复用已有资产"],
  ["imagePrompt", "IMAGE PROMPT", "由镜头设计 + 上面这些参考编译"],
  ["image", "主帧图（图像）", "先把人物 / 场景 / 服装 / 构图 / 光影定下来"],
  ["directing", "视频编排参考", "运动 / 机位 / 视频风格 / 表演 —— AI 读它们并编译进 Video Prompt"],
  ["videoPrompt", "VIDEO PROMPT", "以选定的主帧图为主要视觉输入，加上运动与表演"],
  ["video", "最终视频", "用户选定哪一版，这一镜就算做完"],
  ["endFrame", "END FRAME（可选）", "从最终视频里提取，接给下一镜做首帧"],
];

export const BAND_KEYS = BANDS.map(([k]) => k);

/** Node state → what the card looks like and what it means.
 *
 *   ready    it exists and is usable
 *   active   it exists and is the CURRENT one (an ACTIVE image, a current take)
 *   partial  it exists but is not finished (a bound reference nobody read)
 *   gap      it does not exist and this shot needs it
 *   absent   it does not exist and this shot does not need it (never a gap) */
export const NODE_STATES = ["ready", "active", "partial", "gap", "absent"];

/** Where a base asset came from — printed on the card so 「复用」 is visible rather
 *  than implied. */
const ORIGIN_LABEL = {
  character: "故事开发 · 人物",
  location: "世界观 · 场景地",
  voice: "故事开发 · 人物",
  style: "资产库",
  frame: "上一镜头",
};

/**
 * Build the graph for ONE shot.
 *
 * @param pd        the production read snapshot
 * @param shotId    which shot
 * @param detail    `shotDetailModel(pd, shotId)` — passed in rather than recomputed
 *                  so this graph and the LEFT inspector read the SAME resolution of
 *                  references, frames and prompts. Recomputing it here is how the
 *                  graph ends up naming a different picture than the panel beside it.
 */
export function shotProductionGraph(pd, shotId, detail, { review = null, nextShot = null } = {}) {
  if (!detail || !shotId) return { empty: true, bands: [], nodes: [], edges: [], base: [], needs: [] };
  // `review` and `nextShot` are PASSED IN rather than reached for: this module stays a
  // pure derivation over `pd` + `detail`, and both of those live behind controllers
  // (`ctx.shot.review` / `ctx.frames.nextShotOf`). A model that imported a controller
  // could not be unit-tested without one.
  const ctxReview = review;
  const ctxNextShot = nextShot;
  const prod = pd.production;
  const nodes = [];
  const edges = [];
  const add = (n) => { nodes.push(n); return n.id; };
  const link = (from, to, kind) => { if (from && to) edges.push({ from, to, kind }); };

  const refs = (detail.refInputs && detail.refInputs.references) || [];
  // WHICH SIDE each reference serves (TASK-066 §5) — the same split the two prompt
  // compilers were given, so the picture cannot show an input the prompt did not get.
  // Falls back to the whole list for a caller that predates the split.
  const ri = detail.refInputs || {};
  const imageSide = ri.imageReferences || refs;
  const videoSide = ri.videoReferences || refs;
  const interp = ri.interpretation || [];
  const readingOf = (key) => interp.find((i) => i.key === key) || null;
  const images = detail.images.list;
  const videos = detail.videos.list;
  const activeImage = images.find((r) => r.current) || null;
  const gens = detail.generations || [];
  const lastGen = (kind) => gens.find((g) => g.type === kind) || null;
  const needsVideo = true; // every shot in this pipeline ends in a video take

  /* ---- band: refs (model-input references + the start frame) ------------- */
  const refNodeId = (key) => `ref:${key}`;
  const modelRefs = imageSide.filter((r) => MODEL_INPUT_ROLES.includes(r.kind));
  for (const r of modelRefs) {
    add({
      id: refNodeId(r.key),
      band: "refs",
      type: "reference",
      role: r.kind,
      refKey: r.key,
      assetId: r.assetId,
      title: r.name,
      sub: ROLE_LABEL[r.kind] || r.kind,
      version: r.version,
      domain: r.domain || "images",
      url: r.url || "",
      storageState: r.storageState || "local",
      state: "ready",
      use: "model-input",
    });
  }
  // the START FRAME sits in the same band as the references because it is an input
  // to the picture, but it is its OWN node: it is the one input that comes out of
  // another shot, and collapsing it into 「参考」 hides that.
  const start = detail.frames && detail.frames.start;
  const startId = start
    ? add({
        id: "frame:start",
        band: "refs",
        type: "frame",
        frameType: "startFrame",
        assetId: start.assetId,
        title: start.name || "首帧",
        sub: start.from || "",
        version: start.version,
        url: start.url || "",
        // a start frame that is only 「本镜头当前画面」 is a DEFAULT, not a decision —
        // the card says so, because 「已绑定」 and 「暂时用自己的画面」 are different facts
        bound: !!start.binding,
        state: start.binding ? "ready" : "partial",
        domain: "images",
      })
    : null;
  const endFrame = detail.frames && detail.frames.end;
  const endInputId = endFrame
    ? add({
        id: "frame:end",
        band: "refs",
        type: "frame",
        frameType: "endFrame",
        assetId: endFrame.assetId,
        title: endFrame.name || "尾帧",
        sub: endFrame.from || "",
        version: endFrame.version,
        url: endFrame.url || "",
        bound: !!endFrame.binding,
        state: "ready",
        domain: "images",
      })
    : null;

  /* ---- band: image prompt / generation / versions ------------------------ */
  const imgPrompt = detail.prompts.image || { text: "", missing: [] };
  const imagePromptId = add({
    id: "prompt:image",
    band: "imagePrompt",
    type: "prompt",
    genKind: "image",
    title: "Image Prompt",
    sub: imgPrompt.missing.length ? `${imgPrompt.missing.length} 项还缺` : "输入齐了",
    missing: imgPrompt.missing,
    state: imgPrompt.missing.length ? "partial" : "ready",
    chars: imgPrompt.text.length,
    // the first lines, for the card face. The full text is edited from the card's
    // 查看 / 修改 — a preview is a preview, and truncating is honest as long as the
    // card never claims to be showing all of it.
    preview: previewOf(imgPrompt.text),
  });
  for (const r of modelRefs) link(refNodeId(r.key), imagePromptId, "input");
  // A START FRAME IS NOT AN IMAGE-PROMPT INPUT. `compileImagePrompt` compiles no
  // frame and the image request attaches none (see ctx.episode.genModel, which
  // deliberately passes `frames: null` for an image). Drawing the edge anyway would
  // claim a contribution the records do not hold.
  // ONE CARD PER MEDIA STAGE, showing the SELECTED version (TASK-066 §1 / §10:
  // 「主界面只显示用户当前选定版本」). The other versions are not deleted and not
  // hidden — they are the card's `history`, reached from a secondary entry. Drawing
  // v1…v4 as four peer cards (which is what shipped first) made the creator's own
  // choice the least prominent thing on the row.
  const imgGen = lastGen("image");
  const imageId = add({
    id: "image:selected",
    band: "image",
    type: "image",
    version: activeImage ? activeImage.version : null,
    assetId: activeImage ? activeImage.assetId : null,
    url: activeImage ? activeImage.url || "" : "",
    title: activeImage ? "主帧图（图像）" : "还没有主帧图",
    sub: activeImage ? activeImage.origin || "" : "Image First：先把这一格定下来",
    state: activeImage ? "active" : "gap",
    current: !!activeImage,
    // every version, newest first — the card's 历史 entry renders this
    history: images.slice().sort((a, b) => b.version - a.version)
      .map((v) => ({ version: v.version, url: v.url || "", origin: v.origin || "", assetId: v.assetId, current: !!v.current })),
    versions: images.length,
    // the LAST generation attempt on this side, so the card can report a failure
    // instead of looking merely empty
    lastStatus: imgGen ? imgGen.status : null,
    generationId: imgGen ? imgGen.generationId : null,
    failed: !!(imgGen && (imgGen.status === "failed" || imgGen.status === "cancelled")),
  });

  /* ---- band: directing references (AI-interpretation) -------------------- */
  const directingRefs = videoSide.filter((r) => INTERPRETATION_ROLES.includes(r.kind));
  const directingIds = [];
  for (const r of directingRefs) {
    const reading = readingOf(r.key);
    directingIds.push(add({
      id: refNodeId(r.key),
      band: "directing",
      type: "reference",
      role: r.kind,
      refKey: r.key,
      assetId: r.assetId,
      title: r.name,
      sub: ROLE_LABEL[r.kind] || r.kind,
      version: r.version,
      domain: r.domain || "images",
      url: r.url || "",
      storageState: r.storageState || "local",
      // BOUND BUT UNREAD IS NOT READY. An unread directing reference contributes
      // nothing to the prompt (promptc reports it as a gap), so drawing it as ready
      // would claim an input that is not in the text.
      state: reading && reading.read ? "ready" : "partial",
      read: !!(reading && reading.read),
      readingVersion: reading && reading.read ? reading.readingVersion : null,
      use: "ai-interpretation",
    }));
  }

  /* ---- band: video prompt / generation / versions ------------------------ */
  const vidPrompt = detail.prompts.video || { text: "", missing: [] };
  const videoPromptId = add({
    id: "prompt:video",
    band: "videoPrompt",
    type: "prompt",
    genKind: "video",
    title: "Video Prompt",
    sub: vidPrompt.missing.length ? `${vidPrompt.missing.length} 项还缺` : "输入齐了",
    missing: vidPrompt.missing,
    state: vidPrompt.missing.length ? "partial" : "ready",
    chars: vidPrompt.text.length,
    preview: previewOf(vidPrompt.text),
  });
  // THE CROSSINGS. The video prompt is fed by the picture, by the directing
  // references, by the frames AND by the style reference that already fed the image
  // prompt — `compileVideoPrompt` reads all four, so all four edges are real.
  link(imagePromptId, imageId, "produces");
  // THE SELECTED main frame is the video prompt's primary visual input (§3). It is
  // one edge now because there is one card — which is also the honest picture: the
  // generation uses the version the creator chose, not all of them.
  link(imageId, videoPromptId, "source");
  for (const id of directingIds) link(id, videoPromptId, "interpretation");
  // …AND BACK UP INTO THE IMAGE PROMPT. `compileImagePrompt` compiles the SAME
  // interpretation block (a still frame genuinely benefits from 构图 / 光线 / 机位),
  // so this edge is in the records and must be drawn. Omitting it — as the first
  // version did, purely because the directing band sits BELOW the image prompt —
  // made the graph hide an input that really does affect image generation, which is
  // the one thing this picture must never do (codex review round 4).
  //
  // The renderer routes a non-downward edge around the side rather than dropping it;
  // an edge the layout cannot express is still a real dependency.
  for (const id of directingIds) link(id, imagePromptId, "interpretation");
  if (startId) link(startId, videoPromptId, "frame");
  // a BOUND end frame is an input to the video prompt (it is the last frame the tool
  // is asked to land on); the end frame this shot PRODUCES for the next one is a
  // separate node below, hanging off the finished video
  if (endInputId) link(endInputId, videoPromptId, "frame");
  for (const r of modelRefs) {
    if (r.kind === "style-reference") link(refNodeId(r.key), videoPromptId, "input");
  }
  // THE FINAL SHOT VIDEO — the whole point of 剧集制作 (§1). One card, the SELECTED
  // take; every other take is its history.
  const activeVideo = videos.find((r) => r.current) || null;
  const vidGen = lastGen("video");
  const srcOfSelected = activeVideo ? detail.videoSources[activeVideo.version] : null;
  const videoId = add({
    id: "video:selected",
    band: "video",
    type: "video",
    version: activeVideo ? activeVideo.version : null,
    assetId: activeVideo ? activeVideo.assetId : null,
    url: activeVideo ? activeVideo.url || "" : "",
    title: activeVideo ? "最终视频" : "还没有最终视频",
    sub: activeVideo ? activeVideo.origin || "" : needsVideo ? "主帧图选定后再生成视频" : "",
    state: activeVideo ? "active" : "gap",
    current: !!activeVideo,
    history: videos.slice().sort((a, b) => b.version - a.version)
      .map((v) => ({ version: v.version, url: v.url || "", origin: v.origin || "", assetId: v.assetId, current: !!v.current })),
    versions: videos.length,
    lastStatus: vidGen ? vidGen.status : null,
    generationId: vidGen ? vidGen.generationId : null,
    failed: !!(vidGen && (vidGen.status === "failed" || vidGen.status === "cancelled")),
    // WHICH main frame this take actually came from, per the generation record. Null
    // when it was an import: no record says, so nothing is claimed.
    sourceImageVersion: srcOfSelected && srcOfSelected.proven ? srcOfSelected.version : null,
    approved: !!(ctxReview && ctxReview.at),
  });
  link(videoPromptId, videoId, "produces");
  // THE SELECTED TAKE'S OWN SOURCE, when the records prove one. This is the edge that
  // keeps the picture a network rather than a pipeline: the chosen take may have come
  // from an EARLIER main frame than the one selected now, and saying so is how the
  // creator notices.
  if (srcOfSelected && srcOfSelected.proven) {
    link(imageId, videoId, "source");
  }

  // END FRAME (optional, §13) — extracted FROM the final video, handed to the next
  // shot. It hangs off the video card rather than sitting in the chain, because it is
  // not a step toward this shot's own output.
  const endOutId = add({
    id: "frame:endOut",
    band: "endFrame",
    type: "endFrame",
    title: endFrame ? "End Frame" : "End Frame（可选）",
    sub: endFrame ? endFrame.from || "已绑定" : "从最终视频里提取，接给下一镜",
    url: endFrame ? endFrame.url || "" : "",
    version: endFrame ? endFrame.version : null,
    assetId: endFrame ? endFrame.assetId : null,
    state: endFrame ? "ready" : "absent",
    nextShot: ctxNextShot,
  });
  if (activeVideo) link(videoId, endOutId, "frame");

  /* ---- A. 已有可复用基础资产 --------------------------------------------- */
  const boundKeys = new Set(refs.map((r) => r.key));
  const allRefs = pd.assets ? listReferences(pd.assets) : [];
  const refByAssetId = new Map();
  for (const r of allRefs) if (s(r.assetId)) refByAssetId.set(r.assetId, r);
  const base = [];
  /** One base-asset row. `status` is the whole point: 「有」 and 「已经在用」 are
   *  different, and only the second one means this shot benefits from it. */
  const baseRow = (row) => { base.push(row); };
  const sceneChars = (detail.scene && detail.scene.characters) || [];
  for (const sc of sceneChars) {
    const c = prod ? findCharacter(prod, sc.characterId) : null;
    if (!c) continue;
    // the reference the character (in this scene's state) actually resolves to —
    // the SAME resolver the prompt compiler uses, so the row cannot name a
    // different portrait than the generation would attach
    const scene = prod ? sceneStateOf(prod, detail.scene, sc.characterId) : null;
    const resolved = resolveCharacter(c, scene);
    const want = resolved.activeReferenceAssetId || resolved.referenceAssetIds[0] || null;
    const rec = want ? refByAssetId.get(want) || null : null;
    baseRow({
      kind: "characterRef",
      entityId: sc.characterId,
      label: sc.name + (resolved.stateName ? ` / ${resolved.stateName}` : ""),
      what: "人物参考",
      origin: ORIGIN_LABEL.character,
      refKey: rec ? rec.key : null,
      version: rec ? rec.version : null,
      url: rec ? rec.url || "" : "",
      exists: !!rec,
      status: rec ? (boundKeys.has(rec.key) ? "bound" : "available") : "missing",
      goto: "characters",
    });
    if (s(c.voice.voiceId) || s(c.voice.description)) {
      baseRow({
        kind: "baseVoice",
        entityId: sc.characterId,
        label: `${sc.name} Base Voice`,
        what: "基础声音",
        origin: ORIGIN_LABEL.voice,
        detail: s(c.voice.voiceId) || s(c.voice.description),
        exists: true,
        // a voice is not a generation input for the picture — it is available and
        // used by the shot's dialogue take, which lives in the post console
        status: "available",
        goto: "characters",
      });
    }
  }
  const sceneLoc = detail.scene && detail.scene.location;
  if (sceneLoc && prod) {
    const l = findLocation(prod, sceneLoc.locationId);
    if (l) {
      const stateId = locationStateOf(prod, detail.scene);
      const resolved = resolveLocation(l, stateId);
      const want = resolved.activeReferenceAssetId || resolved.referenceAssetIds[0] || null;
      const rec = want ? refByAssetId.get(want) || null : null;
      baseRow({
        kind: "locationRef",
        entityId: sceneLoc.locationId,
        label: sceneLoc.name + (resolved.stateName ? ` / ${resolved.stateName}` : ""),
        what: "场景参考",
        origin: ORIGIN_LABEL.location,
        refKey: rec ? rec.key : null,
        version: rec ? rec.version : null,
        url: rec ? rec.url || "" : "",
        exists: !!rec,
        status: rec ? (boundKeys.has(rec.key) ? "bound" : "available") : "missing",
        goto: "world",
      });
    }
  }
  // PROJECT STYLE — a style reference is not owned by a character or a location, so
  // it is 「这个项目的」 by being reusable and declared as a style reference. Listed
  // whether or not it is bound, because it is exactly the kind of asset a creator
  // forgets exists.
  for (const r of allRefs.filter((x) => x.kind === "style-reference")) {
    baseRow({
      kind: "styleRef",
      label: derivedLabel(r),
      what: "风格参考",
      origin: ORIGIN_LABEL.style,
      refKey: r.key,
      version: r.version,
      url: r.url || "",
      exists: true,
      status: boundKeys.has(r.key) ? "bound" : "available",
      goto: "assets:reference",
    });
  }

  /* ---- B. 当前 Shot 还需要补充 ------------------------------------------- */
  const needs = [];
  const need = (row) => needs.push(row);
  // a start frame is a VIDEO requirement, and only a real one once there is
  // something to make a video from — reporting it on a shot with no picture yet
  // would put two gaps on screen for one piece of work
  if (!start && images.length) {
    need({ kind: "startFrame", label: "Start Frame", why: "视频生成需要第 1 帧：用本镜头画面，或从上一镜视频提取尾帧", open: "video" });
  } else if (start && !start.binding && videos.length === 0 && images.length) {
    need({
      kind: "startFrame",
      label: "Start Frame（未显式绑定）",
      why: "现在用的是本镜头当前画面。要接上一镜的尾帧，在上一镜的视频节点提取并绑定",
      open: "video",
      soft: true,
    });
  }
  for (const role of INTERPRETATION_ROLES) {
    const has = directingRefs.filter((r) => r.kind === role);
    if (!has.length) {
      need({ kind: role, label: ROLE_LABEL[role], why: "没有绑定：这一镜的运动 / 机位 / 表演只能靠镜头设计的文字", open: "reference", role });
      continue;
    }
    const unread = has.filter((r) => !(readingOf(r.key) || {}).read);
    if (unread.length) {
      need({
        kind: role,
        label: `${ROLE_LABEL[role]} 还没有被解读`,
        why: `${unread.map((r) => r.name).join("、")} — 模型吃不进它，没有解读就进不了 Prompt`,
        open: "reference",
        refKey: unread[0].key,
        role,
      });
    }
  }
  // 当前 Character State — a character that HAS states but whose scene appearance
  // names none is a real gap: 林婉 / 日常 and 林婉 / 受伤 are different pictures.
  for (const sc of sceneChars) {
    const c = prod ? findCharacter(prod, sc.characterId) : null;
    if (!c || !c.states.length) continue;
    if (sceneStateOf(prod, detail.scene, sc.characterId)) continue;
    need({
      kind: "characterState",
      label: `${sc.name} 的当前状态`,
      why: `这个人物有 ${c.states.length} 个状态（${c.states.map((x) => x.name).join(" / ")}），这个场景还没有指定用哪一个`,
      goto: "scenes",
    });
  }
  if (!refs.some((r) => r.kind === "prop-reference")) {
    need({ kind: "prop-reference", label: "特殊道具参考", why: "这一镜如果有关键道具，绑一张参考图能让它跨镜头一致", open: "reference", role: "prop-reference", soft: true });
  }

  return {
    empty: false,
    shotId,
    title: detail.shot.title || `镜头 ${detail.shot.seq}`,
    seq: detail.shot.seq,
    sceneTitle: detail.scene ? detail.scene.title : null,
    bands: BANDS.map(([key, label, hint]) => ({
      key,
      label,
      hint,
      nodes: nodes.filter((n) => n.band === key),
    })),
    nodes,
    edges,
    base,
    needs,
    // the counts the header and the Director both print — one derivation, so they
    // cannot disagree
    counts: {
      reused: base.filter((b) => b.status === "bound").length,
      available: base.filter((b) => b.status === "available").length,
      missingBase: base.filter((b) => b.status === "missing").length,
      needs: needs.filter((n) => !n.soft).length,
      images: images.length,
      videos: videos.length,
    },
    activeImageVersion: activeImage ? activeImage.version : null,
    selectedVideoVersion: activeVideo ? activeVideo.version : null,
    // §1: a shot is DONE when the creator has selected a final video. Not when a
    // generation succeeded — 生成成功 ≠ 镜头完成 has been this codebase's rule since
    // ADR-0057, and it is the same rule here.
    done: !!activeVideo,
    // §9: the four-step locator, derived so the bar and the graph cannot disagree
    stages: stagesOf({
      hasImageRefs: modelRefs.length > 0 || !!start,
      hasImage: !!activeImage,
      hasVideoRefs: directingRefs.length > 0,
      hasVideo: !!activeVideo,
    }),
  };
}

/** The state a scene pins one of its characters to, straight off the document.
 *  `detail.scene` is a VIEW (it carries stateName, not stateId), so the id has to
 *  come from the canonical scene — resolving it from the display name would break
 *  on two states with the same name. */
function sceneStateOf(prod, sceneView, characterId) {
  if (!prod || !sceneView) return null;
  for (const e of prod.episodes || []) {
    const sc = (e.scenes || []).find((x) => x.sceneId === sceneView.sceneId);
    if (!sc) continue;
    const r = (sc.characterRefs || []).find((x) => x.characterId === characterId);
    return r ? r.stateId : null;
  }
  return null;
}

function locationStateOf(prod, sceneView) {
  if (!prod || !sceneView) return null;
  for (const e of prod.episodes || []) {
    const sc = (e.scenes || []).find((x) => x.sceneId === sceneView.sceneId);
    if (!sc) continue;
    return sc.locationRef ? sc.locationRef.stateId : null;
  }
  return null;
}

/** Which inspector selection a graph node opens — the whole point of §12 (点节点 →
 *  左侧 Inspector). Returns null for a node with no operating panel (a gap
 *  placeholder), which keeps a click from pointing the creator's next WRITE at an
 *  object that does not exist yet. */
export function inspectFromShotNode(node, shotId) {
  if (!node || !shotId) return null;
  if (node.type === "reference") {
    return node.refKey ? { kind: "reference", shotId, refKey: node.refKey } : null;
  }
  if (node.type === "prompt") return { kind: "prompt", shotId, genKind: node.genKind };
  if (node.type === "generation") return { kind: "generation", shotId, genKind: node.genKind };
  if (node.type === "image") return { kind: "image", shotId };
  if (node.type === "video") return { kind: "video", shotId };
  // BOTH frame kinds are operated on from the VIDEO card, which owns 提取 /
  // 重新提取 / 解除 (§13). Offering those actions in two places is the duplicate
  // entrance this whole round removes.
  if (node.type === "frame" || node.type === "endFrame") return { kind: "video", shotId };
  return null;
}
