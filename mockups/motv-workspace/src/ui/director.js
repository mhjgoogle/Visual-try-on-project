// 🎬 AI 导演 — the studio's Production Control Tower.
//
// Four layers in one 300–340px column, none of which owns any state:
//
//   CURRENT CONTEXT  what the director is looking at right now (workspace-
//                    contextual: episode · scene · shot · character/state ·
//                    location/state · shot type · duration · media standing)
//   DIRECTOR         creative observation + natural-language instruction +
//                    the one real primary action this module has
//   PRODUCTION PLAN  the episode's stage standing and the single NEXT ACTION,
//                    derived at read time (ui/prodplan.js)
//   ASSET INBOX      assets whose owner is not already known, as proposals
//                    awaiting confirmation (ui/assetinbox.js)
//   GENERATION       the M10 prompt preview / provider / import flow, intact
//
// PRIORITY: exactly one section is SURFACED — the thing that most needs the
// creator right now (a blocker on the current shot → the plan; assets waiting
// on a decision → the inbox; otherwise the next production action). The
// surfaced section opens expanded and is marked; everything else collapses to
// a one-line summary the creator can open. Nothing is ever hidden.
//
// SAFETY: every action routes through ui/directorops.js, which decides what
// runs automatically and what must be confirmed first.
import { esc } from "../util/dom.js";
import { scriptStatus } from "./production.js";
import { shotDetailModel } from "./storyboard.js";
import { renderGenEntry, bindGenEntry } from "./genentry.js";
import { productionPlan, shotBlockers, episodeShots } from "./prodplan.js";
import { assetInbox, inboxLabel } from "./assetinbox.js";
import { invoke } from "./directorops.js";
import { sceneOfShot, activeEpisode } from "../workflow/proddoc.js";
import { findCharacter, resolveCharacter, findLocation, resolveLocation } from "../workflow/bibledoc.js";
import { episodeImpact, upstreamVersions } from "../workflow/canondoc.js";

const MODULE_LABEL = {
  brief: "创意", story: "故事大纲", characters: "人物", relationships: "人物关系",
  world: "世界观", episodes: "分集规划", settings: "作品设定",
  storage: "存储", assets: "资产库",
  script: "剧本", scenes: "场景", shots: "分镜", frames: "画面", video: "视频",
  audio: "音频", edit: "剪辑",
};

/** The upstream modules whose subject is the PROJECT, not one episode. The
 *  Director's per-shot machinery (blockers, prompts, media standing) is
 *  meaningless there, so those sections stay collapsed rather than empty. */
const UPSTREAM_MODULES = ["brief", "story", "characters", "relationships", "world", "episodes", "settings"];

const STATUS_ZH = { queued: "排队", generating: "生成中", success: "成功", failed: "失败", cancelled: "已取消" };
const TYPE_ICON = { image: "🖼", video: "▶", audio: "🎵", render: "🎬" };

/* -------------------------------------------------------------------------- */
/* 1 · CURRENT CONTEXT                                                        */
/* -------------------------------------------------------------------------- */

function contextOf(pd, module, shotId) {
  const prod = pd.production;
  const ep = prod ? activeEpisode(prod) : null;
  const epIndex = ep && prod ? prod.episodes.findIndex((e) => e.episodeId === ep.episodeId) : -1;
  const epCode = epIndex >= 0 ? `EP${String(epIndex + 1).padStart(2, "0")}` : "";
  const shot = shotId ? (pd.draftShots || []).find((s) => s && s.shotId === shotId) : null;
  const owner = shotId && prod ? sceneOfShot(prod, shotId) : null;
  const sceneNo = owner && ep ? ep.scenes.findIndex((s) => s.sceneId === owner.scene.sceneId) : -1;
  const line1 = [epCode, sceneNo >= 0 ? `Scene${String(sceneNo + 1).padStart(2, "0")}` : "", shot ? `Shot${String(shot.sequence).padStart(2, "0")}` : ""]
    .filter(Boolean)
    .join(" · ") || (ep ? ep.title : "项目");
  const refs = [];
  if (owner) {
    for (const r of owner.scene.characterRefs || []) {
      const c = findCharacter(prod, r.characterId);
      if (!c) continue;
      const rc = resolveCharacter(c, r.stateId);
      refs.push(`👤 ${rc.name}${rc.stateName ? ` · ${rc.stateName}` : ""}`);
    }
    const lr = owner.scene.locationRef;
    const l = lr && findLocation(prod, lr.locationId);
    if (l) {
      const rl = resolveLocation(l, lr.stateId);
      refs.push(`📍 ${rl.name}${rl.stateName ? ` · ${rl.stateName}` : ""}`);
    }
  }
  const facets = shot
    ? [shot.shotSize, shot.angle, shot.duration_seconds ? `${shot.duration_seconds}s` : "", shot.emotion]
        .filter(Boolean).join(" · ")
    : MODULE_LABEL[module] || "";
  // media standing for THIS shot — the panel's "Active Image / Video status"
  const d = shotId ? shotDetailModel(pd, shotId) : null;
  const media = [];
  if (d) {
    const img = d.images.list.find((r) => r.current);
    const vid = d.videos.list.find((r) => r.current);
    media.push(img ? { k: "画面", v: `v${img.version}`, ok: true } : { k: "画面", v: "无", ok: false });
    media.push(vid ? { k: "视频", v: `v${vid.version}`, ok: true } : { k: "视频", v: "无", ok: false });
    media.push(d.voice ? { k: "配音", v: `${d.voice.versions} 版`, ok: true } : { k: "配音", v: "无", ok: false });
  }
  const lines = [line1];
  if (shot) lines.push(`${String(shot.sequence).padStart(2, "0")} ${shot.title || ""}`.trim());
  lines.push(...refs);
  if (facets) lines.push(facets);

  const html =
    `<div class="dir-ctxcard"><div class="l1">${esc(line1)}</div>` +
    (shot ? `<div class="l3">${esc(`${String(shot.sequence).padStart(2, "0")} ${shot.title || ""}`.trim())}</div>` : "") +
    (refs.length ? `<div class="l2">${refs.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : "") +
    (facets ? `<div class="l3">${esc(facets)}</div>` : "") +
    (media.length
      ? `<div class="dir-media">${media
          .map((x) => `<span class="mstat${x.ok ? " ok" : ""}"><b>${esc(x.k)}</b>${esc(x.v)}</span>`)
          .join("")}</div>`
      : "") +
    `</div>`;
  return { lines, html };
}

/* -------------------------------------------------------------------------- */
/* 2 · DIRECTOR observation                                                   */
/* -------------------------------------------------------------------------- */

/** An observation the director can actually justify from state. Every branch
 *  points at a REAL gap or inconsistency — never an aesthetic verdict on
 *  pixels it cannot see. */
export function directorNote({ module, story, doc, pd, shotId }) {
  const st = scriptStatus(doc);
  const prod = pd.production;
  if (module === "brief") {
    const b = story.brief || { versions: [], active: 0 };
    if (!story.idea.trim()) return "先写一句核心创意——一句话就够。类型、基调、形式可以之后慢慢补，不必一次填满。";
    if (!b.active) return "创意已经在了。想让下游稳定地依据它，就把当前草稿确认成一个创意版本——日常编辑我不会替你版本化。";
    return `创意 v${b.active} 已确认。下一步是把它发展成故事大纲：前提、主线、核心冲突、Story Arc、高潮、结局。`;
  }
  if (module === "story") {
    if (!story.idea.trim()) return "先写一句创意——一句话就够。我会把它发展成前提、主线、核心冲突和分集结构。";
    if (!story.versions.length) return "创意已经在了。让我把它发展成一版完整大纲，你再逐条改。";
    if (!story.approved) return `大纲已有 ${story.versions.length} 版但都没批准。批准一版，分集规划才有稳定依据。`;
    return `大纲 v${story.approved} 已批准。下一步是分集规划——把 Story Arc 切成每集的钩子和结尾拍。`;
  }
  if (module === "relationships") {
    const chars = (prod && prod.characters) || [];
    const rels = (prod && prod.relationships) || [];
    if (chars.length < 2) return "关系需要两个人物。先把主要人物立起来，我再帮你看他们之间的张力。";
    if (!rels.length) return "还没有一段人物关系。关系是独立对象：核心矛盾、权力关系、Arc 都写在关系上，不写在角色档案里。";
    const thin = rels.filter((r) => !r.profile.coreConflict.trim() || !r.profile.arc.trim());
    if (thin.length) return `${thin.length} 段关系还缺核心矛盾或 Arc。没有 Arc，我无法判断某一集的关系推进是否走偏。`;
    return "关系定义完整。记住这里写的是整部作品的走向；某一集实际发生什么，记在该集的 Relationship Beat 里。";
  }
  if (module === "world") {
    const w = (prod && prod.world) || null;
    if (!w) return "世界观文档未加载。";
    if (!w.era.trim() && !w.rules.trim()) return "世界观还是空的。先定时代与世界规则——它们决定后面每一集什么可能、什么不可能。";
    if (!w.rules.trim()) return "时代有了，但世界规则还没写。规则是连续性的地基：AI 与后续集数都靠它避免自相矛盾。";
    if (!w.visualTone.trim()) return "视觉基调还没定。它会进入画面 Prompt 的编译结果，决定整部作品看起来是否像同一部。";
    return "世界观可用。具体场景地（含日/夜状态与参考图）在「人物 · 场景地库」里，这里不重复存第二份地点数据。";
  }
  if (module === "episodes") {
    const eps = (prod && prod.episodes) || [];
    if (!story.approved) return "分集规划要基于已批准的大纲。先在「故事大纲」批准一版，我再按它拆集。";
    if (!story.confirmedPlan) return "规划还没确认。确认之后才会建立剧集实体——在那之前我不会动任何一集。";
    const noBeat = eps.filter((e) => !e.beats || !(e.beats.plot.length || e.beats.relationship.length || e.beats.character.length || e.beats.world.length));
    if (noBeat.length) return `${noBeat.length} 集还没有记录 Arc 推进。写下主线 / 人物 / 关系 / 世界揭示的 beat，我才能判断整部作品是否在前进。`;
    return "每集都有 Arc 推进记录。上游改版时我只会告诉你哪一集基于旧版本——绝不替你改写剧情。";
  }
  if (module === "settings" || module === "characters") {
    const chars = (prod && prod.characters) || [];
    const formal = chars.filter((c) => c.tier !== "bit");
    const noRef = formal.filter((c) => !c.referenceAssetIds.length);
    if (!chars.length) return "人物还是空的。用「剧本拆解」让我从剧本里提出角色和场景地，你逐条确认。";
    if (noRef.length) return `${noRef.map((c) => c.name).join("、")} 还没有参考图。跨镜头一致性靠的就是这张主参考——建议先补上。`;
    return "正式角色都有主参考了。临时角色（服务员/路人/医生）不需要完整档案，需要时再提升为正式角色。";
  }
  if (module === "script") {
    if (!st.versions && !doc.workingText) return "本集还没有剧本。我可以用创意＋已批准大纲＋本集规划直接起一版。";
    return `本集剧本 v${st.active}（共 ${st.versions} 版）。要改就说方向，我出提案，你确认后才成新版本。`;
  }
  if (!shotId) {
    if (!pd.draftShots || !pd.draftShots.length) return "还没有分镜。剧本就绪后，我可以把它拆成带景别、运镜和时长的镜头草稿。";
    return "选一个镜头，我会针对它给出构图、光线和一致性建议，并编译好可直接用的 Prompt。";
  }
  const d = shotDetailModel(pd, shotId);
  if (!d) return "选中的镜头已不在当前草稿版本里。";
  // a blocker outranks any creative note — it is why nothing can be generated
  const shot = episodeShots(pd).find((s) => s.shotId === shotId);
  const blockers = shot ? shotBlockers(pd, shot) : [];
  if (blockers.length) return `这个镜头暂时生成不了：${blockers[0].text}。补齐后 Prompt 才能锁住一致性。`;
  const gaps = d.prompts.image.missing;
  if (gaps.length) return `这个镜头的 Prompt 还缺：${gaps.join("、")}。补齐后生成的一致性会明显更稳。`;
  if (!d.images.list.length) return "这个镜头还没有画面。Prompt 已经编译好了——选一个生成方式，出图后导入即可。";
  if (module === "video" && !d.videos.list.length) {
    return d.firstFrame
      ? `首帧已记录（资产 v${d.firstFrame.version}）。视频从它生成，人物长相才不会在动起来之后漂移。`
      : "还没有记录首帧。先在「画面」把当前图片设为首帧，视频的来源才是可追溯的。";
  }
  if (!d.scene) return "这个镜头还没有归入场景，所以没有出场角色和场景地上下文——Prompt 会缺一致性锚点。";
  const chars = d.scene.characters.map((c) => c.name).join("、");
  return chars
    ? `保持 ${chars} 的脸部一致性：Prompt 已经带上了主参考与状态。改构图或光线时，别动这两项。`
    : "这个场景还没有设定出场角色。加上之后，Prompt 才能锁住人物一致性。";
}

/* -------------------------------------------------------------------------- */
/* model                                                                       */
/* -------------------------------------------------------------------------- */

/** Which section deserves the top slot right now. */
export function surfacedSection({ plan, inbox, currentBlocked, upstream, module }) {
  if (currentBlocked) return "plan";       // the shot in front of you cannot proceed
  // upstream: while the creator is UPSTREAM, canon standing (what is defined,
  // what episodes are behind) is what they are actually working on
  if (upstream && upstream.isUpstream) return upstream.stale.length ? "canon" : "canon";
  if (inbox.pending) return "inbox";        // assets are waiting on a human decision
  if (plan.next) return "plan";             // healthy: show the next production step
  return "director";
}

/** What the Director can READ about the work as a whole, and — separately —
 *  what it can not yet DO about it.
 *
 *  Everything here is a projection of real canon: brief / outline / character
 *  (with arc) / relationship (with arc) / world rules / episode plan / recorded
 *  episode facts (beats). The `capabilities` list is deliberately explicit
 *  about the supervising checks that are NOT wired: an unavailable capability is
 *  shown as unavailable, never as a button that fakes a verdict (ADR-0054). */
export function canonModel({ story, pd }) {
  const prod = pd.production;
  if (!prod || !prod.canon) return null;
  const cur = upstreamVersions(story, prod);
  const chars = prod.characters || [];
  const rels = prod.relationships || [];
  const w = prod.world || {};
  // CHANGED and UNRECORDED are counted separately: an episode with no recorded
  // baseline (every migrated one) is not behind anything, and listing it as a
  // change would assert a history the document does not contain.
  const stale = [];
  const unrecorded = [];
  for (const [i, e] of (prod.episodes || []).entries()) {
    const im = episodeImpact(prod, e.episodeId, story);
    if (!im) continue;
    const row = { episodeId: e.episodeId, code: `EP${String(i + 1).padStart(2, "0")}`, title: e.title };
    if (im.count) {
      stale.push({ ...row, count: im.count, surfaces: im.stale.map((s) => `${s.label}（${s.state === "outdated" ? "已更新" : "已回退"}）`) });
    } else if (im.unknown.length) {
      unrecorded.push({ ...row, count: im.unknown.length });
    }
  }
  const beatCount = (prod.episodes || []).reduce(
    (n, e) => n + (e.beats ? e.beats.plot.length + e.beats.world.length + e.beats.character.length + e.beats.relationship.length : 0),
    0,
  );
  return {
    versions: cur,
    reads: [
      { k: "创意 Brief", v: cur.brief ? `v${cur.brief}` : story.idea.trim() ? "草稿" : "—", ok: !!cur.brief },
      { k: "故事大纲", v: cur.outline ? `v${cur.outline}` : story.versions.length ? "未批准" : "—", ok: !!cur.outline },
      { k: "人物", v: chars.length ? `${chars.length} 个` : "—", ok: chars.length > 0 },
      { k: "人物关系", v: rels.length ? `${rels.length} 段` : "—", ok: rels.length > 0 },
      { k: "世界规则", v: w.rules && w.rules.trim() ? "已定义" : "—", ok: !!(w.rules && w.rules.trim()) },
      { k: "分集规划", v: story.confirmedPlan ? `v${story.confirmedPlan}` : "未确认", ok: !!story.confirmedPlan },
      { k: "已发生的剧集事实", v: beatCount ? `${beatCount} 条 beat` : "—", ok: beatCount > 0 },
    ],
    stale,
    unrecorded,
    // future SUPERVISING capabilities — listed, not stubbed
    capabilities: [
      "剧情一致性 / 角色 OOC 检查",
      "关系 Arc 偏离检查",
      "世界规则与揭示顺序检查",
      "跨集连续性与推进检查",
    ],
  };
}

export function directorModel({ module, doc, story, pd, sel, production = null }) {
  const st = scriptStatus(doc);
  const approved = story ? story.versions.find((x) => x.v === story.approved) || null : null;
  const shotId = sel && sel.selectedShotId ? sel.selectedShotId : null;
  const shot = shotId ? (pd.draftShots || []).find((s) => s && s.shotId === shotId) || null : null;

  // the ONE primary action this module really has today
  let primary = null;
  if (module === "story") {
    primary = story && story.versions.length
      ? { kind: "story-develop", label: "🪄 AI 修订大纲 → 生成提案", ph: "修改要求，例如：基调更黑色幽默；结局改开放式", input: true }
      : { kind: "story-develop", label: "🪄 AI 发展故事（生成大纲提案）", ph: "可补充方向，例如：偏权谋、女性主角", input: true };
  } else if (module === "episodes") {
    primary = approved
      ? { kind: "story-plan", label: "🪄 生成分集规划提案", ph: "可补充要求，例如：压缩到 4 集、每集都要钩子", input: true }
      : null;
  } else if (module === "brief") {
    // developing the outline IS the brief's forward action — the brief itself
    // has no AI capability wired, and inventing one would be a fake button
    primary = story && story.idea.trim()
      ? { kind: "story-develop", label: "🪄 由创意发展故事大纲 → 生成提案", ph: "可补充方向，例如：偏权谋、女性主角", input: true }
      : null;
  } else if (module === "script") {
    primary = st.versions || doc.workingText
      ? { kind: "script-revise", label: "AI 修订本集剧本 → 生成提案", ph: "修改要求，例如：结尾加一个反转", input: true }
      : { kind: "script-initial", label: "AI 生成本集剧本 v1", ph: "留空则使用 大纲+本集规划 组成的上下文", input: true };
  } else if (module === "shots") {
    primary = pd.draftShots && pd.draftShots.length
      ? { kind: "shots-generate", label: "↻ 重新生成分镜（新版本）", ph: "当前版本保留；重新生成产出全新草稿版本", input: false }
      : { kind: "shots-generate", label: "🎬 基于剧本生成分镜", ph: "需要剧本 — 生成走本地 Claude，免费", input: false };
  } else if (module === "settings" || module === "characters") {
    primary = { kind: "bible-breakdown", label: "🪄 剧本拆解 → 同步人物 / 场景地提案", ph: "提案逐条确认，绝不覆盖已确认档案", input: false };
  }

  const pending = {
    settings: "按设定的一致性检查（待后续检查点）",
    characters: "按设定的一致性检查（待后续检查点）",
    // These are the Director's FUTURE supervising capabilities. They are listed
    // as unavailable rather than wired to a stub: a button that pretends to
    // check relationship drift would be worse than no button (ADR-0054 决策 6).
    relationships: "关系 Arc 偏离检查（Relationship Arc / OOC）尚未接入 — 需另立 ADR",
    world: "世界规则一致性与揭示顺序检查尚未接入 — 需另立 ADR",
    brief: "创意本身没有 AI 能力接线；由创意发展大纲走上面的动作",
    episodes: approved ? null : "分集规划需要已批准的故事大纲 — 先在「故事大纲」发展并批准",
    frames: shotId ? null : "选一个镜头后可编译 Image Prompt 并生成；付费生成在工作流「资产准备」节点（ADR-0045）",
    video: shotId ? null : "选一个镜头后可编译 Video Prompt 并生成；付费生成在工作流「视频生成」节点（ADR-0041/0046）",
  }[module] || null;

  // generation history — real provenance (M5), with thumbnails resolved
  const byAsset = new Map();
  for (const map of [pd.assetUploads, pd.media && pd.media.video]) {
    for (const slot of Object.keys(map || {})) {
      const e = map[slot];
      for (const r of (e && e.history) || []) if (r && r.assetId) byAsset.set(r.assetId, r.url || "");
    }
  }
  const history = (pd.generations || [])
    .slice().reverse().slice(0, 5)
    .map((g) => ({
      icon: TYPE_ICON[g.type] || "•",
      label: `${g.type}${g.provider ? ` · ${g.provider}` : ""}`,
      status: STATUS_ZH[g.status] || g.status,
      ok: g.status === "success",
      busy: g.status === "generating" || g.status === "queued",
      thumb: (g.resultAssetIds || []).map((id) => byAsset.get(id)).find(Boolean) || "",
      when: g.createdAt ? g.createdAt.slice(5, 16).replace("T", " ") : "",
    }));

  const pend = (module === "story" || module === "episodes") && story ? story.pending : doc.pending;
  const genKind = module === "frames" ? "image"
    : module === "video" ? "video"
      : module === "shots" ? (sel.variantTab === "video" ? "video" : "image") : null;

  // --- the control-tower layers ------------------------------------------ //
  const plan = productionPlan(pd, doc);
  const inbox = assetInbox(pd);
  const currentShot = shotId ? episodeShots(pd).find((s) => s.shotId === shotId) : null;
  const currentBlockers = currentShot ? shotBlockers(pd, currentShot) : [];
  const canon = canonModel({ story: story || { idea: "", brief: { active: 0, versions: [] }, versions: [], approved: 0, confirmedPlan: 0 }, pd });
  const isUpstream = UPSTREAM_MODULES.includes(module);
  const surfaced = surfacedSection({
    plan,
    inbox,
    currentBlocked: currentBlockers.length > 0,
    upstream: canon ? { isUpstream, stale: canon.stale } : null,
    module,
  });

  const ctxOf = contextOf(pd, module, shotId);
  return {
    context: ctxOf.lines,
    contextHtml: ctxOf.html,
    // CP8/ADR-0059 要求 1: the REAL ids this observation was built from. The
    // lines above are what a person reads; these are what makes the reading
    // traceable — an observation you cannot tie to a context is an opinion.
    // Null when no unified model was passed: absent, not invented.
    contextIds: production ? production.context : null,
    // 要求 9: the one model this Director reads the production through.
    production,
    note: directorNote({ module, story: story || { idea: "", versions: [], approved: 0 }, doc, pd, shotId }),
    primary,
    pending,
    history,
    plan,
    inbox,
    canon,
    isUpstream,
    currentBlockers,
    surfaced,
    generating: !!(pend && pend.status === "generating"),
    proposal: !!(pend && pend.status === "proposed"),
    proposalGoto: pend && pend.kind === "plan" ? "episodes" : pend && pend.kind === "outline" ? "story" : "script",
    error: pend && pend.status === "failed" ? pend.error : null,
    module,
    shotId,
    shot,
    genKind: shotId ? genKind : null,
    genDetail: shotId && genKind ? shotDetailModel(pd, shotId) : null,
    genProvider: (sel && sel.genProvider && genKind && sel.genProvider[genKind]) || null,
  };
}

/* -------------------------------------------------------------------------- */
/* render                                                                      */
/* -------------------------------------------------------------------------- */

/** A collapsible section. `open` decides the body; the header always shows a
 *  summary so a collapsed section still reports its state. */
function section(key, title, summary, body, { open, surfaced }) {
  return (
    `<section class="dir-sec${open ? " open" : ""}${surfaced ? " surfaced" : ""}">` +
    `<button class="dir-sec-h" data-dsec="${key}">` +
    `<span class="tw">${open ? "▾" : "▸"}</span><span class="ti">${esc(title)}</span>` +
    (summary ? `<span class="su">${summary}</span>` : "") +
    `</button>` +
    (open ? `<div class="dir-sec-b">${body}</div>` : "") +
    `</section>`
  );
}

function planBody(m) {
  const rows = m.plan.stages
    .map((s) =>
      `<button class="pl-row ${s.state}" data-goto="${esc(s.goto)}">` +
      `<span class="mk">${s.mark}</span><span class="nm">${esc(s.label)}</span>` +
      `<span class="dt">${esc(s.detail)}</span></button>`,
    )
    .join("");
  const n = m.plan.next;
  let next = "";
  if (n) {
    const blockedLine = n.blocked
      ? `<div class="pl-block">⚠ 其中 ${n.blocked} 个镜头被阻塞${
          n.firstBlocked ? `，例如 ${esc(blockerLabel(m, n.firstBlocked))}` : ""
        }</div>`
      : "";
    next =
      `<div class="pl-next"><div class="lab">下一步</div>` +
      `<div class="nx-t">${esc(n.label)}</div><div class="nx-d">${esc(n.detail)}</div>` +
      blockedLine +
      `<div class="row tight">` +
      `<button class="btn primary sm" data-dnext="${esc(n.key)}" data-goto2="${esc(n.goto)}">执行下一步</button>` +
      `<button class="btn sm" data-dplan>查看计划</button></div></div>`;
  } else {
    next = `<div class="pl-next"><div class="nx-t">本集已完成</div>` +
      `<div class="nx-d">所有阶段都已就绪，没有待办。</div></div>`;
  }
  // the blocker on the CURRENT shot leads, because it is what stops the
  // creator right where they are standing
  const cur = m.currentBlockers.length
    ? `<div class="pl-block lead">⚠ 当前镜头被阻塞：${esc(m.currentBlockers[0].text)}` +
      `<button class="btn sm" data-goto="${esc(m.currentBlockers[0].fix)}">${esc(m.currentBlockers[0].fixLabel)}</button></div>`
    : "";
  return cur + next + `<div class="pl-rows">${rows}</div>`;
}

function blockerLabel(m, shotId) {
  const b = m.plan.blocked.find((x) => x.shotId === shotId);
  if (!b) return "";
  return `${String(b.seq).padStart(2, "0")} ${b.title} — ${b.reason.text}`;
}

/** 作品 Canon — what the supervising director actually knows about the work,
 *  plus the episodes that are provably based on older upstream versions. */
function canonBody(m) {
  const c = m.canon;
  if (!c) return `<div class="meta">生产域文档未加载。</div>`;
  // one row per surface, not chips: seven label+value pairs squeezed into a
  // 300px column wrap into unreadable vertical slivers
  const reads =
    `<div class="dir-canon">` +
    c.reads
      .map((r) => `<div class="cr${r.ok ? " ok" : ""}"><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></div>`)
      .join("") +
    `</div>`;
  const stale = c.stale.length
    ? `<div class="lab">上游变化（确定性）</div>` +
      c.stale
        .map(
          (s) =>
            `<button class="pl-row active" data-canon-ep="${esc(s.episodeId)}">` +
            `<span class="mk">⚠</span><span class="nm">${esc(s.code)} ${esc(s.title)}</span>` +
            `<span class="dt">${s.count} 项：${esc(s.surfaces.join("、"))}</span></button>`,
        )
        .join("") +
      `<div class="meta">上游变化<b>不会</b>自动改写这些剧集 —— 点开进入「分集规划」的影响审阅。</div>`
    : `<div class="meta">没有剧集基于与当前不同的上游版本。</div>`;
  // separate line, separate wording: these episodes are not behind — the
  // document simply never recorded what they were built on
  const unrec = c.unrecorded.length
    ? `<div class="lab">上游基线未记录</div>` +
      c.unrecorded
        .map(
          (s) =>
            `<button class="pl-row" data-canon-ep="${esc(s.episodeId)}">` +
            `<span class="mk">○</span><span class="nm">${esc(s.code)} ${esc(s.title)}</span>` +
            `<span class="dt">${s.count} 项未记录</span></button>`,
        )
        .join("") +
      `<div class="meta">未记录 ≠ 落后：这些剧集没有记录所基于的上游版本，因此无从判断。复核后可在「分集规划」建立当前基线。</div>`
    : "";
  return (
    reads +
    stale +
    unrec +
    `<div class="lab">监督能力（尚未接入）</div>` +
    c.capabilities.map((t) => `<div class="dir-unavail">◌ ${esc(t)}</div>`).join("") +
    `<div class="meta">这些判断需要语义检查能力，另立 ADR 后接入；现在不给伪造结论。</div>`
  );
}

function inboxBody(m) {
  const ib = m.inbox;
  if (!ib.pending) {
    return `<div class="meta">全部 ${ib.total} 个资产都能确定归属，没有待整理项。</div>`;
  }
  const PREVIEW = 2;
  const rows = ib.items
    .slice(0, PREVIEW)
    .map((it) => {
      const conf = it.confidence
        ? `<span class="chip${it.confidence >= 0.7 ? " ok" : " gate"}">把握 ${Math.round(it.confidence * 100)}%</span>`
        : `<span class="chip bad">不确定</span>`;
      const thumb = it.url
        ? `<img class="ib-th" src="${esc(it.url)}" alt="">`
        : `<span class="ib-th ph">?</span>`;
      const act = it.action === "attach" && it.proposalShotId
        ? `<button class="btn sm" data-ibattach="${esc(it.assetId)}" data-shot2="${esc(it.proposalShotId)}">确认归属</button>`
        : `<button class="btn sm" data-ibopen="${esc(it.assetId || it.taskId || "")}">查看</button>`;
      return (
        `<div class="ib-row">${thumb}<div class="ib-tx">` +
        `<div class="ib-t">${esc(inboxLabel(it))}</div>` +
        `<div class="ib-p">${it.proposal ? `建议：${esc(it.proposal)}` : "没有可用线索"}</div>` +
        `<div class="ib-e">${esc(it.evidence)}</div></div>` +
        `<div class="ib-a">${conf}${act}</div></div>`
      );
    })
    .join("");
  const more = ib.pending > PREVIEW ? `<div class="meta">另有 ${ib.pending - PREVIEW} 项待确认。</div>` : "";
  return (
    `<div class="ib-sum"><b>${ib.total}</b> 个资产 · <b>${ib.auto}</b> 已自动归属 · ` +
    `<b class="warn">${ib.pending}</b> 待确认</div>` +
    rows + more +
    `<div class="row"><button class="btn sm" data-ibopen-all>查看待整理资产</button>` +
    `<span class="chip mute" title="自动归属只用已有事实：记录的镜头身份、已有引用、生成结果。外部导入媒体的 AI 识别归类（角色 / 状态 / 场景）是后续能力，需另立 ADR——现在绝不猜。">仅按已有事实归属</span></div>`
  );
}

function directorBody(m, instruction) {
  let action = "";
  if (m.generating) {
    action = `<div class="st-skel"><i></i><i></i><i></i></div><div class="genprog"><span class="pc">AI 生成中…</span><span class="cx" data-dir-cancel="${esc(m.module)}">取消</span></div>`;
  } else if (m.proposal) {
    const jump = m.proposalGoto !== m.module
      ? `<button class="btn" data-goto="${esc(m.proposalGoto)}">→ 去处理提案</button>`
      : "";
    action = `<div class="dir-note">📝 有一份提案待处理 — 在工作区「应用」或「放弃」后可继续</div>${jump}`;
  } else if (m.primary) {
    const inputOrNote = m.primary.input
      ? `<label class="lab">指令</label>` +
        `<textarea class="field dir-input" rows="3" spellcheck="false" placeholder="${esc(m.primary.ph)}">${esc(instruction)}</textarea>`
      : `<div class="meta">${esc(m.primary.ph)}</div>`;
    action =
      (m.error ? `<div class="scripterr">⚠ 上次生成失败：${esc(m.error)}<button class="errx" data-dir-cancel="${esc(m.module)}">知道了</button></div>` : "") +
      inputOrNote +
      `<button class="btn primary" data-dir-run="${esc(m.primary.kind)}">${esc(m.primary.label)}</button>`;
  }
  return (
    `<div class="dir-note"><span class="who">导演建议</span>${esc(m.note)}</div>` +
    action +
    (m.pending ? `<div class="dir-unavail">◌ ${esc(m.pending)}</div>` : "")
  );
}

function generationBody(m) {
  const gen = m.genDetail && m.genKind ? renderGenEntry(m.genDetail, m.genKind, m.genProvider) : "";
  const history = m.history.length
    ? `<div class="lab">生成记录</div><div class="dir-hist">` +
      m.history
        .map(
          (h) =>
            `<div class="dir-hrow">` +
            (h.thumb ? `<img class="dir-hthumb" src="${esc(h.thumb)}" alt="">` : `<span>${h.icon}</span>`) +
            `<span class="l">${esc(h.label)}</span>` +
            `<span class="chip${h.ok ? " ok" : h.busy ? " gen" : " bad"}">${esc(h.status)}</span>` +
            `<span class="t">${esc(h.when)}</span></div>`,
        )
        .join("") + `</div>`
    : `<div class="lab">生成记录</div><div class="meta">还没有生成记录 — 每次 AI 生成都会记录在项目溯源里。</div>`;
  return gen + history;
}

/** Render the panel. `open` is the shell's transient per-section override. */
export function renderDirector(m, instruction, open = {}) {
  const isOpen = (key, dflt) => (key in open ? !!open[key] : dflt);
  const secs = [];

  const planSummary = m.plan.next
    ? `<span class="chip${m.currentBlockers.length || m.plan.next.blocked ? " gate" : ""}">${
        m.currentBlockers.length ? "当前镜头阻塞" : esc(m.plan.next.label)
      }</span>`
    : `<span class="chip ok">已完成</span>`;
  const inboxSummary = m.inbox.pending
    ? `<span class="chip gate">${m.inbox.pending} 待确认</span>`
    : `<span class="chip ok">已整理</span>`;
  const genSummary = m.genKind
    ? `<span class="chip">${m.genKind === "image" ? "画面" : "视频"} Prompt</span>`
    : m.history.length ? `<span class="chip">${m.history.length} 条记录</span>` : "";

  // three states, three summaries: a collapsed section must not claim
  // 「与上游一致」 for episodes whose baseline was never recorded — that is an
  // absence of information, not agreement (ADR-0054 决策 6)
  const canonSummary = m.canon
    ? m.canon.stale.length
      ? `<span class="chip gate">${m.canon.stale.length} 集基于另一版本</span>`
      : m.canon.unrecorded.length
        ? `<span class="chip mute">${m.canon.unrecorded.length} 集基线未记录</span>`
        : `<span class="chip ok">与上游一致</span>`
    : "";

  // The OPERATIONAL group is what reorders; CURRENT CONTEXT and DIRECTOR stay
  // pinned so the panel keeps a learnable shape. A blocker on the shot in
  // front of the creator is the one thing that jumps above everything — it is
  // literally why they cannot proceed.
  secs.push({
    key: "canon",
    html: (o) => section("canon", "作品 Canon", canonSummary, canonBody(m), { open: o, surfaced: m.surfaced === "canon" }),
    // open while working UPSTREAM (that is the subject there) or when something
    // is provably behind; collapsed to its one-line summary otherwise
    dflt: !!(m.isUpstream || (m.canon && m.canon.stale.length)),
  });
  secs.push({
    key: "plan",
    html: (o) => section("plan", `生产计划 · ${m.plan.episode ? m.plan.episode.code : ""}`, planSummary, planBody(m), { open: o, surfaced: m.surfaced === "plan" }),
    dflt: !!(m.plan.next || m.currentBlockers.length),
  });
  secs.push({
    key: "inbox",
    html: (o) => section("inbox", "资产收件箱", inboxSummary, inboxBody(m), { open: o, surfaced: m.surfaced === "inbox" }),
    dflt: m.inbox.pending > 0,
  });
  secs.push({
    key: "generation",
    html: (o) => section("generation", "生成", genSummary, generationBody(m), { open: o, surfaced: false }),
    dflt: false,
  });
  // the surfaced section leads the operational group; the rest keep order
  secs.sort((a, b) => (b.key === m.surfaced ? 1 : 0) - (a.key === m.surfaced ? 1 : 0));

  const blockerBanner = m.currentBlockers.length
    ? `<div class="dir-blocker"><b>⚠ 当前镜头被阻塞</b>${esc(m.currentBlockers[0].text)}` +
      `<button class="btn sm" data-goto="${esc(m.currentBlockers[0].fix)}">${esc(m.currentBlockers[0].fixLabel)}</button></div>`
    : "";

  // CP8/ADR-0059 要求 1: name the REAL context this reading was built from.
  // A `<details>` because it is evidence, not headline — but it is one click
  // away, and it is the actual ids, not a restatement of the lines above.
  const ids = m.contextIds;
  const traced = ids && (ids.episodeId || ids.sceneId || ids.shotId)
    ? `<details class="dir-trace"><summary>本次判断的依据</summary>` +
      [["剧集", ids.episodeId], ["场景", ids.sceneId], ["镜头", ids.shotId]]
        .map(([k, v]) => `<div><span>${k}</span><code>${v ? esc(v) : "—"}</code></div>`).join("") +
      `</details>`
    : "";

  return (
    `<div class="lab">当前上下文</div>` +
    m.contextHtml +
    traced +
    blockerBanner +
    section("director", "导演", "", directorBody(m, instruction), {
      open: isOpen("director", true),
      surfaced: m.surfaced === "director",
    }) +
    secs.map((s) => s.html(isOpen(s.key, s.dflt))).join("")
  );
}

/* -------------------------------------------------------------------------- */
/* bind                                                                        */
/* -------------------------------------------------------------------------- */

/** Wire the panel. Every action goes through the capability gate; the
 *  instruction text and the open/closed sections are transient shell state. */
export function bindDirector(root, ctx, state, rerender) {
  const redraw = rerender || (() => {});
  const input = root.querySelector(".dir-input");
  if (input) input.oninput = () => { state.directorText = input.value; };

  // section collapse/expand — pure UI
  root.querySelectorAll("[data-dsec]").forEach((b) => (b.onclick = () => {
    state.dirOpen = state.dirOpen || {};
    const k = b.dataset.dsec;
    const cur = b.closest(".dir-sec").classList.contains("open");
    state.dirOpen[k] = !cur;
    redraw();
  }));

  const run = root.querySelector("[data-dir-run]");
  if (run)
    run.onclick = () => {
      const kind = run.dataset.dirRun;
      const text = (state.directorText || "").trim();
      invoke(kind, () => {
        if (kind === "script-initial") {
          ctx.script.generate("initial", text || ctx.episodeScriptBrief());
        } else if (kind === "script-revise") {
          if (!text) { ctx.toast("先写修改要求"); return; }
          state.directorText = "";
          ctx.script.generate("revision", text);
        } else if (kind === "shots-generate") {
          if (!ctx.script.hasContent()) { ctx.toast("剧本为空：先生成/输入剧本"); return; }
          if (state.dirty && !window.confirm("镜头详情有未保存的修改，重新生成将丢弃？")) return;
          state.dirty = false;
          state.buffer = {};
          state.selectedShotId = null;
          if (!ctx.shots.generateDraft()) ctx.toast("已有一个生成在进行中");
        } else if (kind === "bible-breakdown") {
          ctx.breakdown.run();
        } else if (kind === "story-develop") {
          state.directorText = "";
          ctx.story.develop("outline", text);
        } else if (kind === "story-plan") {
          state.directorText = "";
          ctx.story.develop("plan", text);
        }
      });
    };

  const cancel = root.querySelector("[data-dir-cancel]");
  if (cancel)
    cancel.onclick = () => {
      const mod = cancel.dataset.dirCancel;
      if (mod === "story" || mod === "episodes") ctx.story.cancel();
      else ctx.script.cancel();
    };

  // --- PLAN: 执行下一步 / 查看计划 ---------------------------------------- //
  // "执行下一步" navigates to where that work is actually done and, for a
  // media stage, selects the first READY shot. Orchestration beyond that does
  // not exist yet, so the button proposes and positions — it never pretends to
  // have run a batch.
  const nx = root.querySelector("[data-dnext]");
  if (nx)
    nx.onclick = () => {
      invoke("navigate", () => {
        // recompute from live state at click time — the panel may have been
        // rendered before a generation landed
        const plan = productionPlan(ctx.prodData(), ctx.script.doc());
        const first = plan.next ? plan.next.firstReady : null;
        if (first && !state.dirty) state.selectedShotId = first;
        // setModule() returns early when the target IS the current module, so
        // clicking the nav button there would change the selection and never
        // repaint. Re-render directly in that case.
        const btn = root.querySelector(`[data-mod="${nx.dataset.goto2}"]`);
        if (btn && !btn.classList.contains("on")) btn.click();
        else redraw();
      });
    };
  const pl = root.querySelector("[data-dplan]");
  if (pl)
    pl.onclick = () => {
      state.dirOpen = state.dirOpen || {};
      state.dirOpen.plan = true;
      ctx.toast("生产计划由 剧本 / 设定 / 分镜 / 媒体 / 时间线 的现有状态实时推导，不另存一份进度");
      redraw();
    };

  // --- ASSET INBOX -------------------------------------------------------- //
  // attaching an asset to a shot CHANGES a reference the creator owns → the
  // capability table forces a confirmation before anything is written.
  root.querySelectorAll("[data-ibattach]").forEach((b) => (b.onclick = () => {
    invoke("attach-asset", () => {
      ctx.toast("归属写回需要 Gateway 写侧（ADR-0033+）— 本检查点只做提案与确认门，未写入");
    }, { detail: `资产 ${b.dataset.ibattach.slice(0, 12)}… → 镜头 ${b.dataset.shot2.slice(0, 12)}…` });
  }));
  // 资产 is a TOP-LEVEL mode in the studio top bar, not a rail item, so the
  // entry lives outside this panel's root.
  const openAssets = () => {
    const seg = document.getElementById("seg-assets");
    if (seg) seg.click();
    else ctx.toast("待整理资产在顶栏「资产」里逐项确认");
  };
  root.querySelectorAll("[data-ibopen]").forEach((b) => (b.onclick = () => invoke("navigate", openAssets)));
  const ibAll = root.querySelector("[data-ibopen-all]");
  if (ibAll) ibAll.onclick = () => invoke("navigate", openAssets);

  // --- 作品 CANON: open a stale episode's Impact Review --------------------- //
  // navigation only; the review itself never writes, and the re-stamp inside it
  // is the creator's explicit act.
  root.querySelectorAll("[data-canon-ep]").forEach((b) => (b.onclick = () => {
    invoke("navigate", () => {
      state.impactOpen = b.dataset.canonEp;
      state.beatsOpen = null;
      const nav = root.querySelector('[data-mod="episodes"]');
      if (nav && !nav.classList.contains("on")) nav.click();
      else redraw();
    });
  }));

  bindGenEntry(root, ctx, state, redraw);
}
