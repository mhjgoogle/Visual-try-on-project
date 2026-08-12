// LEFT column of 剧集制作 — the Production Inspector (ADR-0061 决策 2).
//
//   左边管输入和当前对象。中间管生产执行。右边管 AI 导演。
//
// Click any card in the centre and this column becomes THAT object's operating
// panel: its preview, its versions, its inputs, its actions, its relations and
// its provenance. Before this, a node detail took over the right column and the
// AI Director had to share it; now the right column is only ever the Director.
//
// PURE PRESENTATION over the canonical documents through ctx controllers. The
// only state it reads is the shell's transient `ui.inspect` selection, and the
// only writes it triggers are the ones the creator explicitly asks for.
//
// PROGRESSIVE DISCLOSURE (ADR-0061 决策 1): assetId / generationId / storage path
// / runtime metadata live behind 「技术详情」, never as the visual subject.

import { esc } from "../util/dom.js";
import { nameWithVersion, mediaBox } from "./shell.js";
import { shotDetailModel } from "./storyboard.js";
import { SHOT_STAGE_LABEL } from "../workflow/shotprod.js";
import { REFERENCE_ROLES, ROLE_LABEL, isInterpretationRole } from "../workflow/geninput.js";
import { domainsForKind } from "../workflow/assetreg.js";
import { videoDependencies, upstreamNotice, DEP } from "../workflow/mediadep.js";

/** The object kinds this column can operate on. A selection naming anything
 *  else falls back to the shot — an inspector that renders nothing is worse
 *  than one that renders the thing the creator is standing on. */
export const INSPECT_KINDS = [
  "shot", "reference", "prompt", "generation", "image", "video", "audio", "node",
];

/** The audio node kinds a shot-level audio panel can honestly speak for. Scene
 *  ambience and episode BGM are NOT a shot's audio — they belong to the
 *  production document, so a node for one opens the read-only provenance body
 *  rather than a panel that would claim the wrong owner. */
const SHOT_AUDIO_KINDS = new Set(["dialogue", "sfx"]);

/**
 * Which operating panel a PROVENANCE NODE opens (TASK-064 Phase 1b).
 *
 * This is the mapping that makes 「点节点 → 左栏操作」 the primary path to the
 * production capabilities: before it, clicking 画面 on the graph gave a read-only
 * list of that frame's inputs, and the only way to actually replace it, switch its
 * version or approve it was to leave the graph for a stage workspace.
 *
 * Returns `null` for nodes with no per-shot operating panel — a scene, a script,
 * a canon baseline, a skill run, a proposal, a final render, a review decision, a
 * project-level asset with no shot anywhere in its records. Those keep the honest
 * read-only provenance body. Guessing a shot for them would point the creator's
 * next write at an object the records never connected.
 *
 * `fallbackShotId` is the shot the creator is already standing on; it is used ONLY
 * for a reference, which is genuinely project-level and is always operated on in
 * the context of some shot.
 *
 * Pure — exported for tests.
 */
export function inspectFromNode(node, story, fallbackShotId = null) {
  if (!node || typeof node !== "object") return null;
  const n = node;
  const shotOf = (x) => (x && typeof x.shotId === "string" && x.shotId ? x.shotId : null);
  if (n.type === "prompt" || n.type === "generation") {
    const shotId = shotOf(n);
    if (!shotId) return null; // an episode render has no shot to operate on
    return { kind: n.type, shotId, genKind: n.kind === "video" ? "video" : "image" };
  }
  if (n.type === "shot") {
    const shotId = shotOf(n);
    return shotId ? { kind: "shot", shotId } : null;
  }
  if (n.type !== "asset") return null;
  // a REFERENCE is project-level: the shot comes from the records that use it,
  // and only then from wherever the creator already is
  if (n.kind === "characterRef" || n.kind === "locationRef") {
    if (!n.chainKey) return null; // no chain key ⇒ nothing the picker can address
    const used = (story && Array.isArray(story.boundByShots) ? story.boundByShots : [])
      .map(shotOf).find(Boolean)
      || (story && Array.isArray(story.usedBy) ? story.usedBy : []).map(shotOf).find(Boolean)
      || fallbackShotId;
    return used ? { kind: "reference", shotId: used, refKey: n.chainKey } : null;
  }
  const shotId = shotOf(n);
  if (!shotId) return null;
  if (n.kind === "shotImage") return { kind: "image", shotId };
  if (n.kind === "shotVideo") return { kind: "video", shotId };
  if (SHOT_AUDIO_KINDS.has(n.kind)) return { kind: "audio", shotId };
  return null; // final / ambience / bgm / deleted media — no shot-level panel
}

const UNRECORDED = `<span class="muted">未记录</span>`;

/** Normalize the shell's transient selection. Never invents a shot: a selection
 *  for an object that no longer resolves collapses to the shot it belonged to,
 *  and a selection with no shot at all collapses to null. */
export function normalizeSelection(sel, { shotId = null } = {}) {
  const s = sel && typeof sel === "object" ? sel : {};
  const kind = INSPECT_KINDS.includes(s.kind) ? s.kind : "shot";
  const target = typeof s.shotId === "string" && s.shotId ? s.shotId : shotId;
  if (!target && kind !== "node") return { kind: "shot", shotId: null };
  return {
    kind,
    shotId: target,
    refKey: typeof s.refKey === "string" && s.refKey ? s.refKey : null,
    genKind: s.genKind === "video" ? "video" : "image",
    audioKey: typeof s.audioKey === "string" && s.audioKey ? s.audioKey : null,
  };
}

/* -------------------------------------------------------------------------- */
/* shared blocks                                                              */
/* -------------------------------------------------------------------------- */

function head(title, sub, chip = "") {
  return (
    `<div class="pi-head"><div class="pi-t">${esc(title)}</div>` +
    (chip ? `<div class="pi-chip">${chip}</div>` : "") +
    (sub ? `<div class="pi-s">${esc(sub)}</div>` : "") +
    `</div>`
  );
}

function sec(label, body, { cls = "" } = {}) {
  return `<section class="pi-sec ${cls}"><div class="lab">${esc(label)}</div>${body}</section>`;
}

function kv(rows) {
  return (
    `<dl class="pi-kv">` +
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v == null || v === "" ? UNRECORDED : v}</dd>`).join("") +
    `</dl>`
  );
}

/** 关系 — the relations filter, moved OFF the right column (TASK-064 §11).
 *  It drives the provenance graph's trace mode; the three buttons are the same
 *  three the graph used to carry beside its own node detail. */
function relationsBlock(mode) {
  const btn = (m, label) =>
    `<button class="pi-seg${mode === m ? " on" : ""}" data-pi-trace="${m}">${label}</button>`;
  return sec(
    "关系",
    `<div class="pi-segs">${btn("up", "上游")}${btn("down", "下游")}${btn("full", "完整链路")}</div>` +
    `<div class="meta">在中央「生成溯源」里只亮起这一条链路。它是读模型：没有记录的关联不会被画出来。</div>`,
  );
}

/** A version list with Set Active. NON-DESTRUCTIVE by construction: the only
 *  write it offers is moving the active pointer (ADR-0061 决策 5 / §25). */
function versionList({ list, domain, key, canSwitch = true }) {
  if (!list.length) return `<div class="pi-none">还没有版本。</div>`;
  return (
    `<ul class="pi-vlist">` +
    list
      .slice()
      .sort((a, b) => b.version - a.version)
      .map((v) => {
        // The DOMAIN decides the element. Rendering an audio version as <img>
        // gave every audio reference a broken-image glyph, which reads as 「出错
        // 了」 when the truth is 「这是一段声音」 (codex review round 2).
        const thumb = !v.url
          ? `<span class="pi-vth none">⃠</span>`
          : domain === "videos"
            ? `<video class="pi-vth" src="${esc(v.url)}" preload="metadata" muted playsinline></video>`
            : domain === "audio"
              ? `<audio class="pi-vth pi-vaudio" src="${esc(v.url)}" controls preload="metadata"></audio>`
              : `<img class="pi-vth" src="${esc(v.url)}" alt="" loading="lazy">`;
        const act = v.current
          ? `<span class="chip ok">ACTIVE</span>`
          : canSwitch
            ? `<button class="btn sm" data-pi-active="${v.version}" data-pi-domain="${esc(domain)}" data-pi-key="${esc(key || "")}">设为当前</button>`
            : "";
        return (
          `<li class="${v.current ? "cur" : ""}">${thumb}` +
          `<span class="pi-vmeta"><b>v${v.version}</b>` +
          (v.origin ? `<span class="pi-vorigin">${esc(v.origin)}</span>` : "") +
          `</span>${act}</li>`
        );
      })
      .join("") +
    `</ul>` +
    `<div class="meta">切换只改「当前」指针：其它版本一个都不会被删除，下游成果也不会被清掉。</div>`
  );
}

function techBlock(rows) {
  const real = rows.filter(([, v]) => v);
  if (!real.length) return "";
  return (
    `<details class="pi-tech"><summary>技术详情</summary>` +
    `<dl class="pi-kv mono">${real.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}</dl>` +
    `</details>`
  );
}

/* -------------------------------------------------------------------------- */
/* the model                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the inspector needs, resolved once from real state.
 *
 *  Returns `{ sel, shot, detail, refs, deps, notice }` — or `{ sel, empty:true }`
 *  when nothing is selected. Exported so a unit test can assert the derivation
 *  without a DOM. */
export function inspectorModel(ctx, sel) {
  const pd = ctx.prodData();
  const s = normalizeSelection(sel);
  if (!s.shotId && s.kind !== "node") return { sel: s, empty: true };
  const detail = s.shotId ? shotDetailModel(pd, s.shotId) : null;
  if (!detail) return { sel: s, empty: true, stale: !!s.shotId };
  const shot = detail.shot;
  const refs = ctx.episode.referencesOfShot(s.shotId);
  const activeImage = detail.images.list.find((r) => r.current) || null;
  const deps = videoDependencies({
    videos: detail.videos.list,
    videoSources: detail.videoSources,
    activeImage: activeImage ? activeImage.version : null,
  });
  return {
    sel: s,
    empty: false,
    shot,
    detail,
    refs,
    deps,
    activeImage,
    notice: upstreamNotice(deps, activeImage ? activeImage.version : null),
    stage: ctx.shot.stage(shot),
    review: ctx.shot.review(s.shotId),
  };
}

/* -------------------------------------------------------------------------- */
/* per-kind bodies                                                            */
/* -------------------------------------------------------------------------- */

function shotBody(ctx, m) {
  const d = m.detail;
  const design = [
    ["景别", m.shot.shotSize],
    ["角度", m.shot.angle],
    ["运镜", m.shot.cameraMotion],
    ["动作", m.shot.action],
    ["情绪", m.shot.emotion],
    ["时长", m.shot.duration ? `${m.shot.duration}s` : ""],
    ["台词", m.shot.dialogue],
  ];
  const cast = d.scene
    ? (d.scene.characters || []).map((c) => `<span class="chip">👤 ${esc(c.name)}${c.stateName ? ` · ${esc(c.stateName)}` : ""}</span>`).join("") +
      (d.scene.location ? `<span class="chip">📍 ${esc(d.scene.location.name)}${d.scene.location.stateName ? ` · ${esc(d.scene.location.stateName)}` : ""}</span>` : "")
    : "";
  return (
    head(m.shot.title || `镜头 ${m.shot.seq}`, d.scene ? d.scene.title : "未分配到场景",
      `<span class="chip${m.stage === "approved" ? " ok" : ""}">${esc(SHOT_STAGE_LABEL[m.stage] || m.stage)}</span>`) +
    (m.shot.description ? sec("描述", `<div class="pi-text">${esc(m.shot.description)}</div>`) : "") +
    sec("设计", kv(design.map(([k, v]) => [k, v ? esc(v) : ""]))) +
    (cast ? sec("出场", `<div class="pi-chips">${cast}</div>`) : "") +
    sec("输入", `<div class="pi-chips">` +
      (m.refs.length
        ? m.refs.map((r) => `<button class="pi-refchip" data-pi-open="reference" data-pi-ref="${esc(r.key)}">${nameWithVersion(r.name, r.version)}</button>`).join("")
        : `<span class="pi-none">还没有绑定参考</span>`) +
      `</div>` +
      `<div class="row tight"><button class="btn sm" data-pi-open="reference">管理参考…</button>` +
      `<button class="btn sm" data-pi-open="prompt">Prompt…</button></div>`) +
    sec("动作",
      `<div class="pi-acts">` +
      `<button class="btn" data-pi-open="generation">生成任务…</button>` +
      (d.videos.list.length
        ? m.stage === "approved"
          ? `<button class="btn" data-pi-unapprove>撤销通过</button>`
          : `<button class="btn primary" data-pi-approve>审片通过</button>`
        : "") +
      `</div>` +
      (m.review && m.review.at
        ? `<div class="meta">已通过：${esc(String(m.review.at).slice(0, 16).replace("T", " "))}` +
          (m.review.note ? ` · ${esc(m.review.note)}` : "") + `</div>`
        : `<div class="meta">生成成功 ≠ 镜头完成：通过与否由人决定，且绑定到具体这一条视频 take。</div>`)) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full") +
    techBlock([["creativeShotId", m.shot.shotId], ["slot", d.slot]])
  );
}

function referenceBody(ctx, m) {
  const p = ctx.episode.pickerModel(m.sel.shotId);
  // ALL THREE picker lists, because the picker partitions the library into three
  // disjoint ones: 已绑定 / 本集推荐 / 从资产库选择. Searching only two of them made a
  // 本集推荐 reference unopenable — it fell through to the list view, so clicking
  // 林晚 Ref on the provenance graph showed the picker instead of that reference.
  const one = m.sel.refKey
    ? p.bound.find((r) => r.key === m.sel.refKey)
      || p.suggested.find((r) => r.key === m.sel.refKey)
      || p.library.find((r) => r.key === m.sel.refKey)
      || null
    : null;
  if (!one) {
    // the LIST view: bound / suggested / library / upload — the shot's inputs
    // ADR-0061 决策 4 made a Reference able to be a video or an audio take, so the
    // thumbnail follows the reference's DOMAIN. Rendering everything as <img> gave
    // the four new directing references a broken-image glyph — which reads as
    // 「这里出错了」 when the truth is 「这是一段视频」 (codex review round 1).
    const thumb = (r) => {
      if (!r.url || r.storageState !== "local") {
        return `<span class="pi-vth none" title="字节不在本地">⃠</span>`;
      }
      if (r.domain === "videos") {
        return `<video class="pi-vth" src="${esc(r.url)}" preload="metadata" muted playsinline></video>`;
      }
      if (r.domain === "audio") return `<span class="pi-vth none" title="音频参考">🎵</span>`;
      return `<img class="pi-vth" src="${esc(r.url)}" alt="" loading="lazy">`;
    };
    const row = (r, action) =>
      `<li>` + thumb(r) +
      `<button class="pi-vmeta as-link" data-pi-ref="${esc(r.key)}" data-pi-open="reference">` +
      `${nameWithVersion(r.name, r.version)}<span class="pi-vorigin">${esc(ROLE_LABEL[r.kind] || r.kind || "未分类")}</span></button>` +
      action +
      `</li>`;
    return (
      head("参考", `${p.bound.length} 个已绑定 · 这个镜头的创作输入`) +
      sec("已绑定", p.bound.length
        ? `<ul class="pi-vlist">${p.bound.map((r) => row(r, `<button class="btn sm" data-pi-unbind="${esc(r.key)}">移除</button>`)).join("")}</ul>`
        : `<div class="pi-none">还没有绑定任何参考。</div>`) +
      sec("本集推荐", p.suggested.length
        ? `<ul class="pi-vlist">${p.suggested.map((r) => row(r, `<button class="btn sm primary" data-pi-bind="${esc(r.key)}">绑定</button>`)).join("")}</ul>`
        : `<div class="pi-none">这一集的场景里没有还缺参考的对象。</div>`) +
      sec("从资产库选择", p.library.length
        ? `<ul class="pi-vlist">${p.library.map((r) => row(r, `<button class="btn sm" data-pi-bind="${esc(r.key)}">绑定</button>`)).join("")}</ul>`
        : `<div class="pi-none">资产库里还没有可绑定的参考资产。</div>`) +
      sec("上传新参考",
        `<div class="pi-acts">` +
        REFERENCE_ROLES.map(([role, label]) => {
          // The button SAYS what it takes. A control offering 「运动参考」 that
          // only accepts a png is a control that lies about itself.
          const zh = { images: "图", videos: "视频", audio: "音频" };
          const kinds = domainsForKind(role).map((d) => zh[d] || d).join("/");
          return `<button class="btn sm" data-pi-upref="${esc(role)}" title="接受 ${esc(kinds)}">` +
            `${esc(label)}<span class="pi-vorigin"> ${esc(kinds)}</span></button>`;
        }).join("") +
        `</div>` +
        `<div class="meta">上传即登记：文件落盘的同一次调用里声明它是什么、属于谁，绝不产生孤立媒体。` +
        `视频风格 / 运动 / 机位 / 表演参考可以是视频（表演也可以是一段念白）——` +
        `媒体模型不吃它们时，Skill 会读它们并把运镜 / 节奏 / 表演编译进 Prompt。</div>`) +
      relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full")
    );
  }
  // ONE reference
  const users = ctx.shot.shotsUsingReference(one.key) || [];
  const chain = ctx.assets.chainOf ? ctx.assets.chainOf(one.key) : null;
  const bound = p.bound.some((r) => r.key === one.key);
  const interp = isInterpretationRole(one.kind);
  return (
    head(one.name, ROLE_LABEL[one.kind] || one.kind || "未分类参考",
      `<span class="chip">v${esc(String(one.version))}</span>`) +
    // The DOMAIN decides the element. An audio performance reference is PLAYED,
    // not looked at, and falling through to <img> gave it a broken-image glyph
    // (codex review round 3).
    sec("预览", one.url && one.storageState === "local"
      ? one.domain === "videos"
        ? `<video class="pi-preview" src="${esc(one.url)}" controls preload="metadata"></video>`
        : one.domain === "audio"
          ? `<audio class="pi-audio" src="${esc(one.url)}" controls preload="metadata"></audio>`
          : `<img class="pi-preview" src="${esc(one.url)}" alt="">`
      : mediaBox("", { missing: one.storageState && one.storageState !== "local" ? "字节不在本地（记录仍在）" : "没有可预览的画面", icon: "🖼" })) +
    sec("用途", interp
      ? `<div class="pi-text">AI 解读输入 —— 当前媒体模型不吃这类参考，Skill 读它并提炼成运镜 / 节奏 / 表演语言，再编译进 Prompt。</div>`
      : `<div class="pi-text">模型直接输入 —— 支持时直接作为 Generation Input 传入。</div>`) +
    sec("使用情况", users.length
      ? `<div class="pi-chips">${users.map((sid) => `<button class="pi-refchip" data-pi-goshot="${esc(sid)}">${esc(ctx.refplan.shotName(sid) || sid.slice(0, 8))}</button>`).join("")}</div>`
      : `<div class="pi-none">还没有镜头使用这个参考。</div>`) +
    sec("版本", chain
      ? versionList({ list: chain.list, domain: chain.domain, key: one.key })
      : `<div class="pi-none">当前版本 v${esc(String(one.version))}；这个参考的完整版本链暂时不可用。</div>`) +
    sec("动作",
      `<div class="pi-acts">` +
      (bound
        ? `<button class="btn" data-pi-unbind="${esc(one.key)}">从这个镜头移除</button>`
        : `<button class="btn primary" data-pi-bind="${esc(one.key)}">绑定到这个镜头</button>`) +
      `<button class="btn" data-pi-refver="${esc(one.key)}">上传新版本</button>` +
      `<button class="btn" data-pi-open="reference">← 全部参考</button>` +
      `</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full") +
    techBlock([["referenceKey", one.key], ["assetId", one.assetId]])
  );
}

/** The EFFECTIVE prompt for one shot+kind, plus everything the inspector needs to
 *  say where it came from. The compiled prompt is the honest default; a stored
 *  version (a hand edit, or an applied Prompt Director proposal) overrides it.
 *  Exported so the Generation inspector and the import path resolve it the SAME
 *  way — the bug this replaces was two call sites reading the compiled text while
 *  a saved version sat unused. */
export function effectivePromptOf(ctx, shotId, kind) {
  const g = ctx.episode.genModel(shotId, kind);
  const eff = ctx.prompt.effective(shotId, kind, g.prompt);
  return { ...eff, compiled: g.prompt, set: g.set, missing: g.missing };
}

const PROMPT_SOURCE_LABEL = {
  compiled: "自动编译（未保存版本）",
  manual: "手工版本",
  skill: "来自 Skill 提案",
};

function promptBody(ctx, m, ui) {
  const kind = m.sel.genKind;
  const eff = effectivePromptOf(ctx, m.sel.shotId, kind);
  const entry = ctx.prompt.entry(m.sel.shotId, kind);
  const compiled = kind === "video" ? m.detail.prompts.video : m.detail.prompts.image;
  // `null` means「显示当前生效的那一段」; a string — including "" — is the
  // creator's own unsaved edit and is shown verbatim.
  const text = ui.piPrompt == null ? eff.text : ui.piPrompt;
  const dirty = ui.piPrompt != null && ui.piPrompt !== eff.text;
  // 自动编译 is the FIRST row and is selectable: it is a state the creator can
  // return to, not merely "what you get before you save anything".
  const compiledRow =
    `<li class="${!entry || entry.active === 0 ? "cur" : ""}">` +
    `<span class="pi-vmeta"><b>自动编译</b>` +
    `<span class="pi-vorigin">由镜头设计与参考实时推导，不会过期</span></span>` +
    (!entry || entry.active === 0
      ? `<span class="chip ok">ACTIVE</span>`
      : `<button class="btn sm" data-pi-pver="0">设为当前</button>`) +
    `</li>`;
  const versions =
    `<ul class="pi-vlist">` + compiledRow +
    (entry
      ? entry.versions.slice().sort((a, b) => b.v - a.v).map((v) =>
          `<li class="${v.v === entry.active ? "cur" : ""}">` +
          `<span class="pi-vmeta"><b>v${v.v}</b>` +
          `<span class="pi-vorigin">${esc(PROMPT_SOURCE_LABEL[v.origin] || v.origin)}` +
          (v.at ? ` · ${esc(String(v.at).slice(0, 16).replace("T", " "))}` : "") + `</span></span>` +
          (v.v === entry.active
            ? `<span class="chip ok">ACTIVE</span>`
            : `<button class="btn sm" data-pi-pver="${v.v}">设为当前</button>`) +
          `</li>`).join("")
      : "") +
    `</ul>` +
    (entry
      ? `<div class="meta">切换只改「当前」指针；每一版都保留，随时可以回到自动编译。</div>`
      : `<div class="meta">还没有保存过版本——当前用的是自动编译结果。</div>`);
  return (
    head("Prompt", `${kind === "video" ? "视频" : "图片"} Prompt · ${m.shot.title || `镜头 ${m.shot.seq}`}`,
      eff.version
        ? `<span class="chip${eff.locked ? " gate" : " ok"}">v${eff.version}${eff.locked ? " 已锁定" : ""}</span>`
        : `<span class="chip mute">自动编译</span>`) +
    sec("类型", `<div class="pi-segs">` +
      ["image", "video"].map((k) =>
        `<button class="pi-seg${kind === k ? " on" : ""}" data-pi-genkind="${k}">${k === "image" ? "图片" : "视频"}</button>`).join("") +
      `</div>`) +
    sec("来源", `<div class="meta">${esc(PROMPT_SOURCE_LABEL[eff.source] || eff.source)}` +
      (dirty ? ` · <b>有未保存的修改</b>` : "") + `</div>`) +
    sec("上游上下文", kv([
      ["剧集", eff.set.episodeCode ? esc(eff.set.episodeCode) : ""],
      ["场景", eff.set.sceneTitle ? esc(eff.set.sceneTitle) : ""],
      ["镜头设计", eff.set.design ? esc(eff.set.design.title) : ""],
    ])) +
    sec("参考", m.refs.length
      ? `<div class="pi-chips">${m.refs.map((r) => `<button class="pi-refchip" data-pi-open="reference" data-pi-ref="${esc(r.key)}">${nameWithVersion(r.name, r.version)}</button>`).join("")}</div>`
      : `<div class="pi-none">没有绑定参考——一致性会明显不稳。</div>`) +
    sec("Prompt", `<textarea class="field pi-prompt" rows="10" spellcheck="false">${esc(text)}</textarea>`) +
    ((compiled && compiled.missing && compiled.missing.length)
      ? sec("还缺", `<ul class="pi-missing">${compiled.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`)
      : "") +
    sec("版本", versions) +
    sec("动作",
      `<div class="pi-acts">` +
      `<button class="btn primary" data-pi-psave${dirty ? "" : " disabled"}>保存为新版本</button>` +
      `<button class="btn" data-pi-copy>复制</button>` +
      `<button class="btn" data-pi-recompile>回到自动编译</button>` +
      `<button class="btn" data-pi-plock>${eff.locked ? "解锁" : "锁定"}</button>` +
      `<button class="btn" data-pi-optimize>AI 优化…</button>` +
      `</div>` +
      `<div class="meta">编辑不会自动版本化：按「保存为新版本」才成为持久版本，旧版本全部保留。` +
      `锁定后自动化（Auto Mix / 重新初剪 / Skill 提案）不会覆盖它。</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full")
  );
}

function generationBody(ctx, m, ui) {
  const kind = m.sel.genKind;
  const eff = effectivePromptOf(ctx, m.sel.shotId, kind);
  const g = { prompt: eff.text, set: eff.set, missing: eff.missing };
  const set = g.set;
  const refRows = REFERENCE_ROLES.map(([role, label]) => {
    const rs = set.references[role] || [];
    return [label, rs.length
      ? rs.map((r) => `<span class="pi-refchip static">${nameWithVersion(r.name, r.version)}</span>`).join(" ")
      : ""];
  });
  const last = (m.detail.generations || [])[0] || null;
  return (
    head("生成任务", `${kind === "video" ? "视频" : "图片"} · ${m.shot.title || `镜头 ${m.shot.seq}`}`) +
    sec("类型", `<div class="pi-segs">` +
      ["image", "video"].map((k) =>
        `<button class="pi-seg${kind === k ? " on" : ""}" data-pi-genkind="${k}">${k === "image" ? "图片" : "视频"}</button>`).join("") +
      `</div>`) +
    sec("输入集合", kv([
      ["镜头", `${esc(set.episodeCode || "")} ${esc(set.sceneTitle || "未分配场景")}`],
      ...refRows,
      ["首帧", set.startFrame ? esc(set.startFrame.name) : ""],
      ["尾帧", set.endFrame ? esc(set.endFrame.name) : ""],
    ])) +
    sec("Prompt 快照", `<pre class="pi-pre">${esc(ui.piPrompt == null ? g.prompt : ui.piPrompt)}</pre>` +
      `<div class="meta">导入结果时冻结的就是这一段文本，逐字保存。当前来源：` +
      `${esc(PROMPT_SOURCE_LABEL[eff.source] || eff.source)}${eff.version ? ` v${eff.version}` : ""}。</div>`) +
    sec("运行时", kv([
      ["来源", esc(set.source || "手工外部生成")],
      ["模型", set.model ? esc(set.model) : ""],
      ["参数", set.parameters ? esc(JSON.stringify(set.parameters)) : ""],
      ["seed", set.seed !== null && set.seed !== undefined ? esc(String(set.seed)) : ""],
    ])) +
    sec("状态", last
      ? kv([["最近一次", `${esc(last.type)} · ${esc(last.status)}`], ["时间", esc(String(last.createdAt || "").slice(0, 16).replace("T", " "))]])
      : `<div class="pi-none">这个镜头还没有生成记录。</div>`) +
    (g.missing.length
      ? sec("还缺", `<ul class="pi-missing">${g.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
          `<div class="meta">仍然可以导入已在外部生成好的结果——缺的部分如实记为「未记录」，不会补成看起来合理的值。</div>`)
      : "") +
    sec("动作",
      `<div class="pi-acts">` +
      `<button class="btn" data-pi-copy>复制 Prompt</button>` +
      `<label class="btn primary pi-implbl">上传生成结果` +
      `<input type="file" class="pi-import" accept="${kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm"}" hidden></label>` +
      `</div>` +
      `<div class="meta">上传即登记：成为 Asset、绑定到这个镜头、冻结当前 Prompt 与参考输入，并出现在生成溯源里。</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full")
  );
}

function imageBody(ctx, m) {
  const d = m.detail;
  const cur = m.activeImage;
  return (
    head("画面", `${m.shot.title || `镜头 ${m.shot.seq}`} · ${d.images.list.length} 个版本`,
      cur ? `<span class="chip ok">v${cur.version} ACTIVE</span>` : `<span class="chip">还没有画面</span>`) +
    sec("预览", cur && cur.url
      ? `<img class="pi-preview" src="${esc(cur.url)}" alt="">`
      : mediaBox("", { missing: "这个镜头还没有画面", icon: "🎨" })) +
    sec("版本", versionList({ list: d.images.list, domain: "images", key: d.slot })) +
    sec("下游", d.videos.list.length
      ? `<ul class="pi-deps">${m.deps.map((v) =>
          `<li class="dep-${esc(v.state)}"><b>视频 v${v.version}</b>` +
          `<span class="chip${v.state === DEP.CURRENT ? " ok" : v.state === DEP.UNKNOWN ? " mute" : " gate"}">${esc(v.label)}</span>` +
          (v.proven ? `<span class="meta">基于画面 v${v.sourceVersion}</span>` : `<span class="meta">没有生成记录说明它基于哪一版</span>`) +
          `</li>`).join("")}</ul>`
      : `<div class="pi-none">还没有视频从这张图生成。</div>`) +
    sec("动作",
      `<div class="pi-acts">` +
      `<label class="btn pi-implbl">上传新版本<input type="file" class="pi-import" accept="image/png,image/jpeg,image/webp" hidden></label>` +
      (cur ? `<button class="btn" data-pi-firstframe>用作视频首帧</button>` : "") +
      `<button class="btn" data-pi-open="generation" data-pi-genkind2="image">生成任务…</button>` +
      `</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full") +
    techBlock([["slot", d.slot], ["assetId", cur ? cur.assetId : null]])
  );
}

function videoBody(ctx, m) {
  const d = m.detail;
  const cur = d.videos.list.find((r) => r.current) || null;
  const dep = m.deps.find((x) => x.current) || null;
  const src = cur ? d.videoSources[cur.version] : null;
  return (
    head("视频", `${m.shot.title || `镜头 ${m.shot.seq}`} · ${d.videos.list.length} 个 take`,
      cur ? `<span class="chip ok">v${cur.version} ACTIVE</span>` : `<span class="chip">还没有视频</span>`) +
    sec("预览", cur && cur.url
      ? `<video class="pi-preview" src="${esc(cur.url)}" controls preload="metadata"></video>`
      : mediaBox("", { missing: "这个镜头还没有视频", icon: "▶" })) +
    (m.notice
      ? sec("上游已变化",
          `<div class="pi-warn"><b>${esc(m.notice.label)}</b>` +
          `<div>当前视频 v${m.notice.videoVersion} 基于画面 ` +
          (m.notice.sourceVersion != null ? `v${m.notice.sourceVersion}` : "未记录的版本") +
          `；当前 ACTIVE 画面是 ` +
          (m.notice.activeImage != null ? `v${m.notice.activeImage}` : "无") + `。</div>` +
          `<div class="pi-acts">` +
          m.notice.resolutions.map((r) =>
            r.action === "revert-upstream" && r.version != null
              ? `<button class="btn sm" data-pi-active="${r.version}" data-pi-domain="images" data-pi-key="${esc(d.slot || "")}">${esc(r.label)}</button>`
              : r.action === "regenerate"
                ? `<button class="btn sm primary" data-pi-open="generation" data-pi-genkind2="video">${esc(r.label)}</button>`
                : `<button class="btn sm" data-pi-dismiss>${esc(r.label)}</button>`).join("") +
          `</div>` +
          `<div class="meta">这条视频不会被自动替换或删除——三个出口都由你选。</div></div>`, { cls: "warn" })
      : "") +
    sec("审片", m.stage === "approved"
      ? `<div class="pi-ok">已通过（绑定到这一条 take）</div><button class="btn" data-pi-unapprove>撤销通过</button>`
      : `<div class="pi-none">还没有通过。</div>` + (cur ? `<button class="btn primary" data-pi-approve>审片通过</button>` : "")) +
    sec("版本", versionList({ list: d.videos.list, domain: "videos", key: d.slot })) +
    sec("来源", src && src.proven
      ? kv([["源画面", `v${src.version}`], ["依赖状态", dep ? esc(dep.label) : ""]])
      : `<div class="pi-none">没有生成记录说明它的源画面——这是一次导入，来源如实记为未记录。</div>`) +
    sec("动作",
      `<div class="pi-acts">` +
      `<label class="btn pi-implbl">上传新版本<input type="file" class="pi-import" accept="video/mp4,video/webm" hidden></label>` +
      `<button class="btn" data-pi-open="prompt" data-pi-genkind2="video">Prompt…</button>` +
      `<button class="btn" data-pi-open="image">源画面…</button>` +
      `</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full") +
    techBlock([["slot", d.slot], ["assetId", cur ? cur.assetId : null]])
  );
}

function audioBody(ctx, m) {
  const d = m.detail;
  return (
    head("音频", `${m.shot.title || `镜头 ${m.shot.seq}`}`,
      d.voice ? `<span class="chip ok">${d.voice.versions} 版</span>` : `<span class="chip">还没有配音</span>`) +
    sec("播放", d.voice && d.voice.url
      ? `<audio class="pi-audio" src="${esc(d.voice.url)}" controls preload="metadata"></audio>`
      : `<div class="pi-none">这个镜头还没有配音。</div>`) +
    sec("类型与轨道", kv([
      ["类型", d.voice ? "对白 / 配音" : ""],
      ["轨道", d.voice ? "Dialogue" : ""],
      ["来源", d.voice ? esc(d.voice.origin) : ""],
      ["台词", m.shot.dialogue ? esc(m.shot.dialogue) : ""],
    ])) +
    sec("动作",
      `<div class="pi-acts">` +
      `<button class="btn" data-goto="audio">去音频工作区</button>` +
      `</div>` +
      `<div class="meta">多轨摆放、timing、gain / fade 与 Shot Mix 在下方「后期控制台」。</div>`) +
    relationsBlock(ctx.relationsMode ? ctx.relationsMode() : "full")
  );
}

/** The provenance-graph node's detail, rendered HERE rather than in an aside
 *  beside the graph (TASK-064 §11 / §73: RIGHT stays the AI Director). */
/** A provenance node's human name. Assets carry a ROLE and a version; everything
 *  else carries a kind label. Never the raw id — nobody recognises one. */
function nodeName(n) {
  if (!n) return "";
  if (n.type === "asset") {
    return `${n.roleLabel || n.kindLabel || "资产"}${n.version != null ? ` v${n.version}` : ""}`;
  }
  return n.kindLabel || n.type || "";
}

const PROV_LABEL = {
  authored: "创作者写的（不是生成的）",
  generated: "由一次生成产出",
  import: "外部导入 —— 没有生成记录，来源如实记为未知",
  missing: "字节不在本地（记录仍在）",
};

/** The 溯源 facts of the selected graph node, as a section that can sit UNDER an
 *  operating panel. Same derived story the graph draws — it can never state a
 *  link the graph does not show, and it states nothing where there is no record. */
function provenanceSec(story) {
  if (!story || !story.node) return "";
  const n = story.node;
  const row = (list, none) => (list && list.length
    ? `<div class="pi-chips">${list.map((x) => `<button class="pi-refchip" data-pi-node="${esc(x.id)}">${esc(nodeName(x))}</button>`).join("")}</div>`
    : `<div class="pi-none">${esc(none)}</div>`);
  const lines = [
    story.producedBy ? ["由谁生成", row([story.producedBy], "")] : null,
    story.launchedBy ? ["从哪份提案发起", row([story.launchedBy], "")] : null,
    story.approval ? ["审片", row([story.approval], "")] : null,
    ["输入", row(story.inputs, "没有记录输入")],
    ["下游", row(story.usedBy, "还没有被任何后续生成使用")],
  ].filter(Boolean);
  return (
    `<details class="pi-prov" open><summary>溯源 · ${esc(PROV_LABEL[story.provenance] || "")}</summary>` +
    lines.map(([k, v]) => `<div class="pi-provrow"><span class="lab">${esc(k)}</span>${v}</div>`).join("") +
    `</details>` +
    techBlock([["nodeId", n.id], ["assetId", n.assetId], ["generationId", n.generationId]])
  );
}

function nodeBody(ctx, story, mode) {
  if (!story || !story.node) {
    return (
      head("溯源", "在中央的图上点任意节点") +
      `<div class="pi-none">点任意画面、Prompt 或生成记录，这里会显示它的完整来源与去向；图上只亮起这一条链路。</div>` +
      relationsBlock(mode)
    );
  }
  const n = story.node;
  const row = (list, none) => (list && list.length
    ? `<div class="pi-chips">${list.map((x) => `<button class="pi-refchip" data-pi-node="${esc(x.id)}">${esc(nodeName(x))}</button>`).join("")}</div>`
    : `<div class="pi-none">${esc(none)}</div>`);
  return (
    head(nodeName(n), PROV_LABEL[story.provenance] || "") +
    (n.type === "review"
      ? sec("审片通过", kv([
          ["镜头", n.title ? esc(n.title) : ""],
          ["时间", n.approvedAt ? esc(String(n.approvedAt).slice(0, 16).replace("T", " ")) : ""],
          ["备注", n.note ? esc(n.note) : ""],
        ]) + `<div class="meta">生成成功 ≠ 镜头完成：这条记录是人的判断，且绑定到具体那一条 take。</div>`)
      : "") +
    (story.prompt ? sec("Prompt 快照", `<pre class="pi-pre">${esc(story.prompt.text || "")}</pre>`) : "") +
    (story.producedBy ? sec("由谁生成", row([story.producedBy], "")) : "") +
    (story.launchedBy ? sec("从哪份提案发起", row([story.launchedBy], "")) : "") +
    (story.approved ? sec("通过的是这一条", row([story.approved], "")) : "") +
    sec("参考", row(story.references, "没有记录参考")) +
    sec("输入", row(story.inputs, "没有记录输入")) +
    sec("产出", row(story.results, "还没有产出")) +
    sec("下游", row(story.usedBy, "还没有被任何后续生成使用")) +
    (story.approval ? sec("审片", row([story.approval], "")) : "") +
    (n.shotId
      ? sec("动作", `<div class="pi-acts"><button class="btn" data-pi-selshot="${esc(n.shotId)}">在左栏打开这个镜头</button></div>`)
      : "") +
    relationsBlock(mode) +
    techBlock([["nodeId", n.id], ["assetId", n.assetId], ["generationId", n.generationId]])
  );
}

/* -------------------------------------------------------------------------- */
/* render + bind                                                              */
/* -------------------------------------------------------------------------- */

/**
 * WHAT THIS COLUMN IS OPERATING ON — the single source of truth for both
 * `renderInspector` and `bindInspector`.
 *
 * It MUST be shared. Deriving the selection inside render only (as this first
 * shipped) renders shot B's panel while every binding still resolves the shell's
 * own `ui.inspect`, i.e. shot A: 审片通过, 上传生成结果, 保存 Prompt and 绑定参考
 * would all land on the shot the creator was standing on BEFORE they clicked the
 * node — a wrong-target write with a panel that says otherwise. The same applies
 * within one shot, where a VIDEO PROMPT node would save into the IMAGE prompt
 * (codex review round 1).
 *
 *   mode "derived"  a graph node that HAS an operating panel, and it resolves
 *   mode "node"     a graph node with no per-shot panel → read-only provenance
 *   mode "own"      no node: the shell's own selection
 *
 * Pure. Exported for tests.
 */
export function inspectorTarget(ctx, ui, node) {
  const own = normalizeSelection(ui.inspect, { shotId: ui.selectedShotId || null });
  if (node && node.node) {
    const d = inspectFromNode(node.node, node, ui.selectedShotId || null);
    // The derived selection must actually RESOLVE against the documents. A shot
    // recorded on a generation but dropped from the current draft would otherwise
    // put the column into an operating panel for an object that is not there.
    if (d && !inspectorModel(ctx, d).empty) return { mode: "derived", sel: normalizeSelection(d) };
    return { mode: "node", sel: own };
  }
  if (own.kind === "node") return { mode: "node", sel: own };
  return { mode: "own", sel: own };
}

/** `node` is the provenance graph's selected-node story, passed in ONLY while the
 *  centre is showing 生成溯源. When one is selected it IS the current object, so it
 *  wins over the shot: the creator just clicked it. With none selected the column
 *  falls back to the shot, which keeps the relations controls (§11) reachable
 *  instead of leaving the column empty.
 *
 *  A selected node opens that object's OPERATING panel wherever one exists
 *  (`inspectFromNode`) with its 溯源 facts underneath — clicking 画面 on the graph
 *  has to give the creator the version list, Set Active and the upload, not a
 *  read-only description of a frame they cannot touch. Nodes with no per-shot
 *  panel keep the read-only provenance body. */
export function renderInspector(ctx, ui, { node = null, traceMode = "full" } = {}) {
  const t = inspectorTarget(ctx, ui, node);
  if (t.mode === "node") return `<aside class="pi">${nodeBody(ctx, node, traceMode)}</aside>`;
  const s = t.sel;
  const prov = t.mode === "derived" ? provenanceSec(node) : "";
  const m = inspectorModel(ctx, s);
  if (m.empty) {
    return (
      `<aside class="pi empty">` +
      head("当前对象", "还没有选中镜头") +
      `<div class="pi-none">` +
      (m.stale
        ? "选中的镜头已不在当前草稿版本里——它可能被重新生成过。"
        : "在中央选一个镜头，这里会显示它的输入、版本、动作与关系。") +
      `</div></aside>`
    );
  }
  const body =
    s.kind === "reference" ? referenceBody(ctx, m)
    : s.kind === "prompt" ? promptBody(ctx, m, ui)
    : s.kind === "generation" ? generationBody(ctx, m, ui)
    : s.kind === "image" ? imageBody(ctx, m)
    : s.kind === "video" ? videoBody(ctx, m)
    : s.kind === "audio" ? audioBody(ctx, m)
    : shotBody(ctx, m);
  const tabs = ["shot", "reference", "prompt", "generation", "image", "video", "audio"]
    .map((k) => `<button class="pi-tab${s.kind === k ? " on" : ""}" data-pi-open="${k}">${
      { shot: "镜头", reference: "参考", prompt: "Prompt", generation: "生成", image: "画面", video: "视频", audio: "音频" }[k]
    }</button>`)
    .join("");
  return `<aside class="pi"><nav class="pi-tabs">${tabs}</nav>${body}${prov}</aside>`;
}

/** `node` is the SAME provenance-node story `renderInspector` was given. Both must
 *  resolve the target through `inspectorTarget`, or every action here would be
 *  bound to a different object than the panel above it shows — see that function.
 *
 *  When the target came from a node, an explicit choice made in this column also
 *  has to RELEASE that node: otherwise the very next render re-derives the panel
 *  from the node and the creator's own click — a tab, a reference, a genKind —
 *  appears to do nothing. */
export function bindInspector(root, ctx, ui, render, { node = null } = {}) {
  const target = () => inspectorTarget(ctx, ui, node);
  const sel = () => target().sel;
  const fromNode = () => target().mode === "derived";
  const setInspect = (patch) => {
    ui.inspect = { ...sel(), ...patch };
    ui.piPrompt = null;
    if (fromNode() && ctx.focusProvenanceNode) {
      // clearing the graph selection re-renders through the graph's own
      // selection-change path, so this must not render a second time
      ctx.focusProvenanceNode(null);
      return;
    }
    render();
  };

  root.querySelectorAll("[data-pi-open]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation();
    const patch = { kind: b.dataset.piOpen };
    if (b.dataset.piRef) patch.refKey = b.dataset.piRef;
    else if (b.dataset.piOpen === "reference") patch.refKey = null;
    if (b.dataset.piGenkind2) patch.genKind = b.dataset.piGenkind2;
    setInspect(patch);
  }));
  root.querySelectorAll("[data-pi-genkind]").forEach((b) => (b.onclick = () => setInspect({ genKind: b.dataset.piGenkind })));

  // --- relations (TASK-064 §11) ------------------------------------------- //
  root.querySelectorAll("[data-pi-trace]").forEach((b) => (b.onclick = () => {
    if (ctx.setRelationsMode) ctx.setRelationsMode(b.dataset.piTrace);
    render();
  }));
  root.querySelectorAll("[data-pi-node]").forEach((b) => (b.onclick = () => {
    if (ctx.focusProvenanceNode) ctx.focusProvenanceNode(b.dataset.piNode);
  }));

  // --- versions: Set Active only moves the pointer (§25) ------------------ //
  root.querySelectorAll("[data-pi-active]").forEach((b) => (b.onclick = () => {
    const domain = b.dataset.piDomain;
    const key = b.dataset.piKey;
    if (!key) { ctx.toast("这个镜头的媒体槽位无法解析，无法切换版本"); return; }
    ctx.media.setCurrent(domain === "images" ? "image" : domain === "videos" ? "video" : "audio", key, +b.dataset.piActive);
  }));

  // --- references ---------------------------------------------------------- //
  root.querySelectorAll("[data-pi-bind]").forEach((b) => (b.onclick = () => {
    ctx.shot.addReference(sel().shotId, b.dataset.piBind);
    render();
  }));
  root.querySelectorAll("[data-pi-unbind]").forEach((b) => (b.onclick = () => {
    ctx.shot.removeReference(sel().shotId, b.dataset.piUnbind);
    render();
  }));
  root.querySelectorAll("[data-pi-upref]").forEach((b) => (b.onclick = () => {
    ctx.episode.uploadReference(sel().shotId, b.dataset.piUpref).then(render);
  }));
  root.querySelectorAll("[data-pi-refver]").forEach((b) => (b.onclick = async () => {
    const key = b.dataset.piRefver;
    try {
      await ctx.assets.uploadReferenceVersion(key);
    } catch (e) {
      ctx.toast(`上传新版本失败：${e.message}`);
    }
    render();
  }));
  root.querySelectorAll("[data-pi-goshot]").forEach((b) => (b.onclick = () => {
    if (ctx.openShotInProduction) ctx.openShotInProduction(b.dataset.piGoshot);
  }));
  // 「在左栏打开这个镜头」 — stay on the graph and move only this column. Navigating
  // to a stage workspace instead would pull the creator off the map they were
  // reading, which is the opposite of what the graph-first centre is for.
  root.querySelectorAll("[data-pi-selshot]").forEach((b) => (b.onclick = () => {
    ui.selectedShotId = b.dataset.piSelshot;
    setInspect({ kind: "shot", shotId: b.dataset.piSelshot, refKey: null });
  }));

  // --- prompt -------------------------------------------------------------- //
  const pt = root.querySelector(".pi-prompt");
  if (pt) pt.oninput = () => { ui.piPrompt = pt.value; };
  const on = (q, fn) => { const el = root.querySelector(q); if (el) el.onclick = fn; };
  /** The text a prompt action operates on: the creator's unsaved edit when there
   *  is one, otherwise the effective prompt. */
  const promptText = () => {
    const s = sel();
    return ui.piPrompt == null ? effectivePromptOf(ctx, s.shotId, s.genKind).text : ui.piPrompt;
  };
  on("[data-pi-copy]", () => ctx.episode.copyPrompt(promptText()));
  // 「回到自动编译」 drops the unsaved buffer AND puts the compiled prompt back in
  // force. Clearing only the buffer left an active saved override in place, so
  // the button said one thing and the next generation used another (codex review
  // round 2). No version is deleted — the list can switch back to any of them.
  on("[data-pi-recompile]", () => {
    const s = sel();
    ui.piPrompt = null;
    const e = ctx.prompt.entry(s.shotId, s.genKind);
    if (e && e.active !== 0) {
      if (e.locked === true) {
        ctx.toast("这个 Prompt 已锁定：先解锁，再切回自动编译");
        render();
        return;
      }
      ctx.prompt.useCompiled(s.shotId, s.genKind);
    }
    render();
  });
  on("[data-pi-psave]", (ev) => {
    if (ev && ev.currentTarget && ev.currentTarget.hasAttribute("disabled")) return;
    const s = sel();
    if (ui.piPrompt == null) { ctx.toast("没有未保存的修改"); return; }
    const v = ctx.prompt.save(s.shotId, s.genKind, ui.piPrompt, { origin: "manual" });
    if (!v) { ctx.toast("保存失败"); return; }
    ui.piPrompt = null;
    ctx.toast(`已保存为 Prompt v${v}（旧版本保留，可回切）`);
    render();
  });
  root.querySelectorAll("[data-pi-pver]").forEach((b) => (b.onclick = () => {
    const s = sel();
    const want = +b.dataset.piPver;
    // 0 is the 自动编译 row, not a version number
    const ok = want === 0
      ? ctx.prompt.useCompiled(s.shotId, s.genKind)
      : ctx.prompt.setActive(s.shotId, s.genKind, want);
    if (ok) ui.piPrompt = null;
    else if (want === 0) ctx.toast("这个 Prompt 已锁定：先解锁，再切回自动编译");
    render();
  }));
  on("[data-pi-plock]", () => {
    const s = sel();
    const cur = ctx.prompt.entry(s.shotId, s.genKind);
    if (!cur) { ctx.toast("先保存一个版本，才有可锁定的对象"); return; }
    ctx.prompt.setLocked(s.shotId, s.genKind, !(cur.locked === true));
    render();
  });
  on("[data-pi-optimize]", () => {
    // The Prompt Director is a real Skill on the right; this only OPENS it with
    // this shot as its scope. Nothing here rewrites the prompt.
    ui.dirOpen = { ...(ui.dirOpen || {}), skills: true };
    ui.skillId = "prompt-director";
    ctx.toast("在右侧「AI 导演 · 能力」里运行 Prompt Director：它出提案，你决定用不用");
    render();
  });
  on("[data-pi-dismiss]", () => { ui.piDismissUpstream = sel().shotId; render(); });

  // --- review -------------------------------------------------------------- //
  on("[data-pi-approve]", () => { ctx.shot.approve(sel().shotId, ""); render(); });
  on("[data-pi-unapprove]", () => { ctx.shot.unapprove(sel().shotId); render(); });
  on("[data-pi-firstframe]", () => {
    const m = inspectorModel(ctx, sel());
    if (m.empty || !m.detail.slot) { ctx.toast("这个镜头的槽位无法解析"); return; }
    ctx.media.useAsFirstFrame(m.detail.slot);
  });

  // --- unified upload (§23): every entrance registers, none orphans -------- //
  const imp = root.querySelector(".pi-import");
  if (imp) {
    imp.onchange = () => {
      const file = imp.files && imp.files[0];
      if (!file) return;
      const s = sel();
      const kind = s.kind === "image" ? "image" : s.kind === "video" ? "video" : s.genKind;
      // The prompt frozen into the Generation record is the EFFECTIVE one (a
      // saved version when there is one), or the creator's unsaved edit when they
      // have one open — never the compiled text while a saved version is active.
      const text = ui.piPrompt == null
        ? effectivePromptOf(ctx, s.shotId, kind).text
        : ui.piPrompt;
      ctx.episode
        .importResult(s.shotId, kind, file, text)
        .then(render)
        .catch((e) => ctx.toast(`导入失败：${e.message}`));
    };
  }
}
