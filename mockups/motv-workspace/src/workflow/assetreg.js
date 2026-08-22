// Asset Registration (checkpoint CP2 / ADR-0055) — the ONE place an uploaded or
// imported media file becomes a REGISTERED Asset.
//
//   Upload / Import
//     → save media (server, already collision-safe: <slug>_v<N>.<ext>)
//     → registerUpload()  ← THIS MODULE
//         · mint / carry the assetId (still via mediaref.addVersion — the single
//           media write path M3 established; this module never opens a second one)
//         · stamp the DECLARATION: what it is, what it is called, where it came
//           from, and which canonical objects it belongs to
//     → visible everywhere
//
// THE RULE: 上传 ≠ 保存文件. A file that reaches disk without a declaration is an
// orphan, and orphans are what make an asset library useless. So the declaration
// travels WITH the write, in the same call, on the same record.
//
// NOT A SECOND REGISTRY. The declaration lives on the Asset (MediaRef) record
// itself, inside the existing `assets` document field. There is no parallel index
// that could drift out of sync with the media it describes.
//
// DECLARED vs DERIVED — the distinction the whole design rests on:
//
//   DECLARED (here)   what the creator/caller SAID at import time: kind,
//                     displayName, originalFilename, links, tags, reusable.
//                     Durable creator metadata. Editable, never auto-rewritten.
//
//   DERIVED (elsewhere)  where the asset is ACTUALLY used right now — bible
//                     references, scene audio, timeline clips, generation
//                     results. Recomputed from canonical relations every time
//                     (ui/assetinbox.js tier A, and the Usage read model).
//
// Removing an image from a character's reference list does not make the image
// stop BEING a character reference; it stops it being USED as one. Conflating
// the two would let a delete silently rewrite what a file is.
//
// LAYERING: this module owns the declaration VOCABULARY and depends on nothing
// but identity minting. `mediaref.js` (chain mechanics) and `assetlib.js`
// (registry) import FROM here, never the other way round — so there is exactly
// one definition of what a declaration is, and no import cycle.
//
// Pure state + transitions — no fetch, no DOM, no clock.

import { mintId } from "./identity.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const strOrNull = (x) => (typeof x === "string" && x ? x : null);

/** The semantic types an Asset can be DECLARED as. Deliberately a closed list:
 *  an open free-text "type" would immediately fragment into 图片/image/Image and
 *  make every filter lie. `null` (unclassified) is a first-class member of the
 *  domain instead — see needsReview. */
export const ASSET_KINDS = [
  "character-reference",
  "location-reference",
  "prop-reference",
  "style-reference",
  // ADR-0061 决策 4: a Reference is not image-only. These four are how a
  // director actually says what they want, and they are USEFUL even when the
  // media model cannot ingest them — a Skill reads them and compiles camera
  // language / motion rhythm / performance into the Prompt.
  "video-style-reference",
  "motion-reference",
  "camera-reference",
  "performance-reference",
  "external-reference",
  "shot-image",
  // ADR-0073 决策 7 / TASK-092 §2.7: 草图与正式关键帧是两件事，`shot-image` 一个词
  // 表达不了。没有它们，状态机眼里「一张低成本草图」与「一张正式关键帧」完全相同，
  // 于是成本阶梯（便宜档确认 → 正式档花钱）没有状态可挂。
  //
  //   storyboard  ④ 低成本草图 —— 先把镜头设计画出来看一眼，便宜是它存在的理由
  //   keyframe    ⑤ 由草图 + 角色设定图 + 场景设定图合成的正式画面，也就是视频首帧
  //
  // 加法，零迁移：真实项目只用了 `character-reference`。
  "storyboard",
  "keyframe",
  "shot-video",
  // TASK-098: 白膜视频 —— 由一张 `keyframe` + 那句 `运镜` 在本地免费渲出的运镜预览。
  //
  // **它是预览，不是产物**，所以它必须是自己的 kind 而不是又一条 `shot-video`：
  // 「这一镜有没有视频」这个判定（`mediaOf` → TASK-092 的 `video` stage → 逐镜质检
  // 的成片判定）读的是**镜头视频那条链**，一段白膜混进去会让 60 个镜头看起来都拍完了。
  // 同理它也不接 `first_frame_image` 那条付费路：白膜不是一次生成的输入。
  "motionpreview",
  // TASK-064 Phase 2 §7: a frame CUT OUT of a video take — 上一镜的尾帧 becoming
  // 下一镜的首帧. It is its own kind rather than a `shot-image`, because it is not
  // a picture generated FOR a shot: it is a still lifted out of one, its
  // provenance is a video + a timecode (workflow/framebind.js), and filing it as
  // a shot image would make 「这个镜头有几版画面」 count frames nobody designed.
  "derived-frame",
  "dialogue",
  "ambience",
  "sfx",
  // ADR-0061 决策 6: 拟音 and 旁白 are their own tracks in the shot mix, so they
  // are their own declared kinds — folding them into `sfx`/`dialogue` would make
  // every track filter lie about what it is showing.
  "foley",
  "vo",
  "bgm",
  // A Shot Mix is a DERIVED audio asset (ADR-0061 决策 6): its sources are all
  // still registered separately and are never replaced by it.
  "shot-mix",
  // TASK-065 §1: a character's BASE VOICE sample — 「林婉听起来是这样」. Its own kind
  // rather than a `dialogue` take, because it is not a line from a shot: it belongs
  // to a Character, it is reused across every episode, and filing it as dialogue
  // would make 「这一集有几条对白」 count voice samples nobody wrote a line for.
  //
  // Deliberately NOT in REFERENCE_KINDS: those are the `ref-…` chains the SHOT
  // reference picker offers, and a base voice is bound to a character, not to a
  // shot. Putting it there would list it in every shot's 「从资产库选择」.
  "voice-reference",
  "final",
];

const KIND_SET = new Set(ASSET_KINDS);

export const ASSET_KIND_LABEL = {
  "character-reference": "人物参考",
  "location-reference": "场景参考",
  "prop-reference": "道具参考",
  "style-reference": "风格参考",
  "video-style-reference": "视频风格参考",
  "motion-reference": "运动参考",
  "camera-reference": "机位参考",
  "performance-reference": "表演参考",
  "external-reference": "外部参考",
  "shot-image": "镜头图片",
  storyboard: "分镜草图",
  keyframe: "关键帧",
  "shot-video": "镜头视频",
  motionpreview: "运镜预览",
  "derived-frame": "派生帧",
  dialogue: "对白",
  ambience: "环境音",
  sfx: "音效",
  foley: "拟音",
  vo: "旁白",
  bgm: "BGM",
  "shot-mix": "镜头混音",
  "voice-reference": "基础声音",
  final: "成片",
};

/** The REFERENCE kinds that live on their own `ref-<uuid>` chain rather than on
 *  a shot slot — a canonical reference many shots share (ADR-0055 决策 3).
 *  Keeping them in the media maps means the slot namespace, the version chain
 *  and the M3 write path all keep working unchanged.
 *
 *  ADR-0061 决策 4 added the four directing references. They are references in
 *  exactly the same sense — shared, versioned, bound to many shots — so they
 *  belong on the same chain mechanism, not in a parallel one. */
export const REFERENCE_KINDS = [
  "character-reference",
  "location-reference",
  "prop-reference",
  "style-reference",
  "video-style-reference",
  "motion-reference",
  "camera-reference",
  "performance-reference",
  "external-reference",
];

/** The reference kinds whose value to a generation is INTERPRETIVE: today's
 *  media models do not ingest a motion clip, but a Skill reading it can turn it
 *  into camera language, motion rhythm, action language and performance notes
 *  that go into the Prompt (ADR-0061 决策 4).
 *
 *  This is a statement about HOW a reference is used, not about what file type
 *  it is — which is exactly why it is a separate list from KIND_DOMAIN.
 *  「Video Reference ≠ 必须直接传入 Video API」. */
export const INTERPRETATION_KINDS = [
  "video-style-reference",
  "motion-reference",
  "camera-reference",
  "performance-reference",
];

/**
 * 一个 SHOT 的画面，不管它处在成本阶梯的哪一档（ADR-0073 决策 7）。
 *
 * WHY A FAMILY AND NOT THREE STRINGS AT THE CALL SITE. 资产库's 「镜头图片」 filter
 * matched `kind === "shot-image"` exactly, so the two kinds added above would have
 * been登记得好好的、界面上一张也看不见 —— a new kind that no filter can find is
 * invisible, and 「新增 kind 后哪些地方消费 kind」 is precisely the hand-written
 * checklist TASK-097 §2.6.1 says will miss one. Declared here, consumed by the
 * filter, and covered by a derived guard that walks `ASSET_KINDS` and requires
 * every image-domain kind to be reachable by some filter.
 */
export const SHOT_PICTURE_KINDS = ["shot-image", "storyboard", "keyframe"];

/**
 * 一个 SHOT 的**视频域**资产，同一条理由的另一半（TASK-098）。
 *
 * 「镜头视频」这个筛选原来精确匹配 `kind === "shot-video"`，所以新增的
 * `motionpreview` 会登记得好好的、在资产库里**一段也看不见** —— 与上面那条
 * 完全同形（TASK-097 §2.6.1：新增 kind 的消费者要派生，不要手写）。
 *
 * **但它不是 `SHOT_PICTURE_KINDS` 的对称物**：那一族是「这一镜的画面，不管哪一档
 * 成本」，成员之间可以互相替代；这一族只是「都能在资产库的视频筛选里被找到」。
 * 判定「这一镜有没有视频」的地方**不读这张表**，读的是镜头视频那条链
 * —— 两者混起来正是本 kind 存在的理由被抹掉的方式。
 */
export const SHOT_VIDEO_LIBRARY_KINDS = ["shot-video", "motionpreview"];

const INTERPRETATION_SET = new Set(INTERPRETATION_KINDS);

/** True when this kind reaches a generation through AI interpretation rather
 *  than as direct model input. */
export const isInterpretationKind = (k) => INTERPRETATION_SET.has(k);

const REFERENCE_KIND_SET = new Set(REFERENCE_KINDS);

export const isReferenceKind = (k) => REFERENCE_KIND_SET.has(k);

/** Which media domain a kind belongs in. Used to VALIDATE a declaration against
 *  the map it is being written into — declaring an mp3 a `shot-image` would make
 *  every downstream filter wrong. `external-reference` is deliberately absent:
 *  an external reference can legitimately be an image, a video or an audio clip. */
export const KIND_DOMAIN = {
  "character-reference": "images",
  "location-reference": "images",
  "prop-reference": "images",
  "style-reference": "images",
  "shot-image": "images",
  storyboard: "images",
  keyframe: "images",
  "shot-video": "videos",
  motionpreview: "videos",
  "derived-frame": "images",
  dialogue: "audio",
  ambience: "audio",
  sfx: "audio",
  foley: "audio",
  vo: "audio",
  bgm: "audio",
  "shot-mix": "audio",
  "voice-reference": "audio",
  final: "finals",
};

/** Kinds that legitimately live in MORE THAN ONE media domain, with the exact
 *  set they are allowed in. Absent from `KIND_DOMAIN` on purpose: a single-value
 *  mapping cannot express 「这可以是视频，也可以是一张图」 without lying about one
 *  of the two.
 *
 *  A motion / camera / performance reference is usually a video clip but a still
 *  frame is a perfectly good camera reference, so both are allowed. `finals` is
 *  in NO set: this project's composed output re-declared as somebody's reference
 *  would misreport the one asset the whole pipeline exists to produce. */
export const KIND_DOMAINS = {
  "external-reference": ["images", "videos", "audio"],
  "video-style-reference": ["videos", "images"],
  "motion-reference": ["videos", "images"],
  "camera-reference": ["videos", "images"],
  // A performance reference can also be an audio take (a line read) — that is a
  // real directing reference, not a stretch of the concept.
  "performance-reference": ["videos", "images", "audio"],
};

const KIND_DOMAIN_SETS = new Map(
  Object.entries(KIND_DOMAINS).map(([k, v]) => [k, new Set(v)]),
);

/** The canonical objects an Asset can be declared to belong to. One flat list so
 *  the sanitizer, the migration and the read models can never disagree about
 *  which context keys exist. */
export const LINK_KEYS = [
  "episodeId",
  "sceneId",
  "shotId",
  "characterId",
  "locationId",
  // 道具（TASK-095 §2.2 / 批次 4C）。加一个链接键**必须走迁移** —— 校验要求
  // 每个键都在场（缺键与 null 是两种不同的「不知道」），所以 v16→v17 给每条
  // 既有资产补上 `propId: null`。
  "propId",
  "generationId",
];

export function emptyLinks() {
  const l = {};
  for (const k of LINK_KEYS) l[k] = null; // null = NOT KNOWN, never guessed
  return l;
}

/** Normalize a links object: known keys only, string-or-null values. Unknown
 *  keys are dropped rather than carried — a stray key would silently become an
 *  unqueryable context nobody filters on. */
export function sanitizeLinks(saved) {
  const src = isObj(saved) ? saved : {};
  const out = {};
  for (const k of LINK_KEYS) out[k] = strOrNull(src[k]);
  return out;
}

/** Normalize the creator tag list: non-empty strings, trimmed, de-duplicated,
 *  order preserved. Tags are CREATOR semantics (雨夜 / cinematic / 暖光); ids
 *  are never copied in as tags — that is what `links` is for. */
export function sanitizeTags(saved) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(saved) ? saved : []) {
    if (typeof t !== "string") continue;
    const v = t.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Is this declaration still waiting for a human decision?
 *
 *  TRUE when the semantic type is unknown. That is the only condition: an
 *  asset whose kind IS known but whose context is thin (a style reference
 *  belongs to no episode by nature) is completely classified — flagging it
 *  would train the creator to ignore the flag.
 *
 *  An explicit `needsReview: false` on a record the creator has confirmed is
 *  honored even without a kind, so "I looked at this and it is just a file"
 *  is expressible and sticks. */
export function computeNeedsReview(kind, saved) {
  if (saved === false) return false; // explicitly cleared by the creator
  return !KIND_SET.has(kind);
}

/** Normalize the declaration fields of ONE persisted Asset record, in place.
 *  Idempotent, total, and never invents a value:
 *
 *  - an unknown/absent kind stays `null` (unclassified is honest; guessing from
 *    the domain would declare every uploaded png a 镜头图片)
 *  - `displayName` / `originalFilename` absent stay `null` — the UI derives a
 *    label instead of inventing a filename the creator never typed
 *
 *  Returns the same record. */
export function sanitizeDeclaration(rec) {
  if (!isObj(rec)) return rec;
  const kind = KIND_SET.has(rec.kind) ? rec.kind : null;
  rec.kind = kind;
  rec.displayName = strOrNull(rec.displayName);
  rec.originalFilename = strOrNull(rec.originalFilename);
  rec.links = sanitizeLinks(rec.links);
  rec.tags = sanitizeTags(rec.tags);
  rec.reusable = rec.reusable === true; // only an EXPLICIT mark counts
  rec.needsReview = computeNeedsReview(kind, rec.needsReview);
  return rec;
}

/** Hydrate declarations across an entire registry (called from createRegistry,
 *  so every load lands on normalized records regardless of which build wrote
 *  them). */
export function sanitizeRegistryDeclarations(reg) {
  if (!isObj(reg)) return reg;
  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      for (const r of e.history) sanitizeDeclaration(r);
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) sanitizeDeclaration(f);
  // firstFrames entries ALIAS an image asset's identity (same assetId); they
  // carry the alias, not a second declaration, so they are deliberately not
  // normalized here — the image chain record is the one that owns it.
  return reg;
}

/** A fresh chain key for a canonical Reference (人物 / 场景 / 道具 / 风格 /
 *  外部). Versions of the SAME reference append to this one key, so 「林照
 *  Ref v3」 is one chain at version 3 — not three unrelated assets. */
export function mintReferenceKey() {
  return mintId("ref");
}

/** True when a chain key was minted as a canonical Reference. Used only for
 *  READ-side grouping; it never decides an asset's semantics — that is what the
 *  declared `kind` is for (ADR-0055 决策 2: never infer meaning from a name). */
export function isReferenceKey(key) {
  return typeof key === "string" && key.startsWith("ref-");
}

/** Validate that a declaration may be written into `domain`. Returns null when
 *  acceptable, else a reason string. `null` (unclassified) is acceptable
 *  everywhere — it asserts nothing.
 *
 *  A multi-domain kind is checked against its OWN allowed set (KIND_DOMAINS), not
 *  waved through: 「可以是视频也可以是图」 is not 「可以是任何东西」, and an mp3
 *  declared a camera reference would make every media filter wrong. A kind in
 *  neither map is refused rather than accepted unchecked — fail closed. */
export function declarationDomainError(kind, domain) {
  if (kind == null) return null;
  if (!KIND_SET.has(kind)) return `未知的资产类型 ${kind}`;
  const many = KIND_DOMAIN_SETS.get(kind);
  if (many) {
    return many.has(domain) ? null : `${ASSET_KIND_LABEL[kind]} 不能登记到 ${domain} 域`;
  }
  const want = KIND_DOMAIN[kind];
  if (!want) return `${ASSET_KIND_LABEL[kind] || kind} 没有声明允许的媒体域`;
  if (want !== domain) return `${ASSET_KIND_LABEL[kind]} 不能登记到 ${domain} 域`;
  return null;
}

/** Every media domain a kind may be registered in — one answer for both the
 *  single- and multi-domain cases, so callers (upload pickers, validators) never
 *  have to know which map a kind is in. */
export function domainsForKind(kind) {
  const many = KIND_DOMAIN_SETS.get(kind);
  if (many) return [...many];
  const one = KIND_DOMAIN[kind];
  return one ? [one] : [];
}

/** Fill DEFAULTS for any declaration field a record does not already carry.
 *
 *  Called by `mediaref.addVersion` on every media write, exactly like the
 *  assetId / storageState defaults it already applies. That is what makes an
 *  undeclared Asset structurally impossible: a write path that forgets to
 *  declare produces an honestly UNCLASSIFIED record (visible, listed, asking
 *  for review) rather than a record the v11 validator has to reject.
 *
 *  Never overwrites a declaration already present — `declare()` runs first at
 *  the real import sites. */
export function ensureDeclaration(rec) {
  if (!isObj(rec)) return rec;
  if (!("kind" in rec)) rec.kind = null;
  if (!("displayName" in rec)) rec.displayName = null;
  if (!("originalFilename" in rec)) rec.originalFilename = null;
  if (!isObj(rec.links)) rec.links = emptyLinks();
  if (!Array.isArray(rec.tags)) rec.tags = [];
  if (typeof rec.reusable !== "boolean") rec.reusable = false;
  return sanitizeDeclaration(rec);
}

/** Can this declaration be written into `domain`? Returns null when it can,
 *  else the reason.
 *
 *  Exists to be called BEFORE the bytes are uploaded. Registering after the
 *  upload means a refused declaration leaves a file on disk that no Asset
 *  record points at — precisely the orphan this whole checkpoint exists to make
 *  impossible. Checking first turns that into a refusal with nothing written.
 *  (`declare()` re-checks, so the guarantee does not depend on callers
 *  remembering to call this.) */
export function checkDeclaration(domain, declaration) {
  const d = isObj(declaration) ? declaration : {};
  if (d.kind != null && !KIND_SET.has(d.kind)) return `未知的资产类型 ${d.kind}`;
  return declarationDomainError(KIND_SET.has(d.kind) ? d.kind : null, domain);
}

/**
 * DECLARE what a freshly-built MediaRef is — the stamping half of registration.
 *
 * `ref`         the MediaRef built from the server's write response
 *               (mediaref.refFromResponse) — url / version / digest / origin
 * `domain`      "images" | "videos" | "audio" | "finals" — the map it is
 *               destined for, so an impossible declaration is refused BEFORE
 *               anything is written
 * `declaration` { kind, displayName, originalFilename, links, tags, reusable }
 *
 * Returns { ok: true, ref } or { ok: false, error }. A refused declaration
 * stamps NOTHING, so the caller can surface the failure instead of writing a
 * mislabelled asset. The caller then hands `ref` to `mediaref.addVersion`,
 * which stays the single media write path M3 established.
 */
export function declare(ref, domain, declaration) {
  if (!isObj(ref) || typeof ref.url !== "string" || !ref.url) {
    return { ok: false, error: "上传响应没有可用的媒体地址" };
  }
  const d = isObj(declaration) ? declaration : {};
  const bad = checkDeclaration(domain, d);
  if (bad) return { ok: false, error: bad };
  const kind = KIND_SET.has(d.kind) ? d.kind : null;
  ref.kind = kind;
  ref.displayName = strOrNull(d.displayName);
  ref.originalFilename = strOrNull(d.originalFilename);
  ref.links = sanitizeLinks(d.links);
  ref.tags = sanitizeTags(d.tags);
  ref.reusable = d.reusable === true;
  ref.needsReview = computeNeedsReview(kind, d.needsReview);
  return { ok: true, ref };
}

/** Update the CREATOR metadata of an already-registered Asset. This is the only
 *  way a declaration changes after registration, and it is always an explicit
 *  user action — nothing in the system reclassifies an asset on its own.
 *  Only the keys PRESENT in `fields` are touched.
 *
 *  `domain` is the map the record LIVES in, and it is REQUIRED to change the
 *  kind: the same domain rule that guards `declare()` has to guard the edit
 *  path, or an image could be re-declared `bgm` and persist a document the v11
 *  validator then refuses to load. Without a domain a kind change is refused
 *  rather than accepted unchecked — fail closed, never "probably fine". */
export function updateDeclaration(rec, fields, domain = null) {
  if (!isObj(rec) || !isObj(fields)) return false;
  if ("kind" in fields) {
    const k = fields.kind;
    if (k != null && !KIND_SET.has(k)) return false;
    if (k != null) {
      if (!domain) return false; // unverifiable → refused
      if (declarationDomainError(k, domain)) return false;
    }
    rec.kind = k == null ? null : k;
    // classifying an asset resolves its review flag; un-classifying re-raises it
    rec.needsReview = computeNeedsReview(rec.kind, "needsReview" in fields ? fields.needsReview : undefined);
  }
  if ("displayName" in fields) rec.displayName = strOrNull(fields.displayName);
  if ("originalFilename" in fields) rec.originalFilename = strOrNull(fields.originalFilename);
  if ("links" in fields) rec.links = sanitizeLinks({ ...rec.links, ...(isObj(fields.links) ? fields.links : {}) });
  if ("tags" in fields) rec.tags = sanitizeTags(fields.tags);
  if ("reusable" in fields) rec.reusable = fields.reusable === true;
  if ("needsReview" in fields && !("kind" in fields)) {
    rec.needsReview = computeNeedsReview(rec.kind, fields.needsReview);
  }
  return true;
}

/** Add / remove one creator tag. Returns true when the tag list changed. */
export function addTag(rec, tag) {
  if (!isObj(rec) || typeof tag !== "string") return false;
  const v = tag.trim();
  if (!v) return false;
  const tags = sanitizeTags(rec.tags);
  if (tags.includes(v)) return false;
  tags.push(v);
  rec.tags = tags;
  return true;
}

export function removeTag(rec, tag) {
  if (!isObj(rec) || typeof tag !== "string") return false;
  const tags = sanitizeTags(rec.tags);
  const next = tags.filter((t) => t !== tag);
  if (next.length === tags.length) return false;
  rec.tags = next;
  return true;
}

/** Every registered Asset, flattened, with the chain context needed to render
 *  and address it. ONE derivation, used by the asset library, the reference
 *  picker and the AI Director, so those three can never disagree about what
 *  exists.
 *
 *  `current` marks the chain's selected version — the Active variant; the rest
 *  are Historical. A final has no chain, so it is always its own current. */
export function listAssets(reg) {
  const out = [];
  if (!isObj(reg)) return out;
  for (const domain of ["images", "videos", "audio"]) {
    const m = reg[domain];
    if (!isObj(m)) continue;
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!isObj(e) || !Array.isArray(e.history)) continue;
      for (const r of e.history) {
        if (!isObj(r) || typeof r.assetId !== "string" || !r.assetId) continue;
        out.push({
          assetId: r.assetId,
          domain,
          key,
          version: typeof r.version === "number" ? r.version : 1,
          current: r.version === e.current,
          url: typeof r.url === "string" ? r.url : "",
          origin: typeof r.origin === "string" ? r.origin : "",
          storageState: typeof r.storageState === "string" ? r.storageState : "local",
          creativeShotId: strOrNull(r.creativeShotId),
          kind: KIND_SET.has(r.kind) ? r.kind : null,
          displayName: strOrNull(r.displayName),
          originalFilename: strOrNull(r.originalFilename),
          links: sanitizeLinks(r.links),
          tags: sanitizeTags(r.tags),
          reusable: r.reusable === true,
          needsReview: computeNeedsReview(KIND_SET.has(r.kind) ? r.kind : null, r.needsReview),
          record: r,
        });
      }
    }
  }
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) {
    if (!isObj(f) || typeof f.assetId !== "string" || !f.assetId) continue;
    out.push({
      assetId: f.assetId,
      domain: "finals",
      key: null,
      version: 1,
      current: true,
      url: typeof f.url === "string" ? f.url : "",
      origin: typeof f.origin === "string" ? f.origin : "",
      storageState: typeof f.storageState === "string" ? f.storageState : "local",
      creativeShotId: null,
      kind: KIND_SET.has(f.kind) ? f.kind : null,
      displayName: strOrNull(f.displayName),
      originalFilename: strOrNull(f.originalFilename),
      links: sanitizeLinks(f.links),
      tags: sanitizeTags(f.tags),
      reusable: f.reusable === true,
      needsReview: computeNeedsReview(KIND_SET.has(f.kind) ? f.kind : null, f.needsReview),
      record: f,
    });
  }
  return out;
}

/** The canonical References: one entry per `ref-…` chain, carrying its CURRENT
 *  version. This is the unit CP4's Reference Planning shares between shots —
 *  「SH01 / SH02 / SH05 → 林照 Ref v3」 is one of these at version 3, never
 *  three copies. */
export function listReferences(reg) {
  const byKey = new Map();
  for (const a of listAssets(reg)) {
    if (!isReferenceKey(a.key)) continue;
    const prev = byKey.get(a.key);
    // the chain's selected version wins; otherwise keep the highest seen, so a
    // chain with a corrupt `current` pointer still resolves to something real
    if (!prev || a.current || (!prev.current && a.version > prev.version)) byKey.set(a.key, a);
  }
  return [...byKey.values()];
}

/** A human label for an Asset that has no displayName. Derived, never
 *  persisted: the creator's own name must stay distinguishable from a fallback,
 *  and a persisted fallback would later look like something they typed. */
export function derivedLabel(a) {
  if (!isObj(a)) return "";
  if (a.displayName) return a.displayName;
  if (a.originalFilename) return a.originalFilename;
  const kind = a.kind ? ASSET_KIND_LABEL[a.kind] || a.kind : "未分类素材";
  return `${kind} v${a.version}`;
}
