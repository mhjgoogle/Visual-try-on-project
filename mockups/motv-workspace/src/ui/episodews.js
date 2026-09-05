// Episode Production (checkpoint CP6 / ADR-0058) — ONE creative context for
// making an episode, instead of a script that lives in one page and a
// storyboard that lives in another.
//
//     Episode Script  →  Scene  →  Shot  →  Reference  →  Prompt  →  Image
//                                                              →  Video  →  Review
//
// THE POINT: from a scene's own text you can see what it was broken into, and
// from a shot you can see what it currently looks like — without leaving. The
// creator asks "这一段被拆成了哪些镜头" and the answer is on screen, not two
// navigations away.
//
// Everything is a READ MODEL over the canonical documents (script doc, scenes,
// the scriptgen draft, the asset registry, shot production state). This module
// owns nothing durable; the only writes it triggers go through ctx controllers.

import { esc } from "../util/dom.js";
import { head, empty, mediaBox, nameWithVersion } from "./shell.js";
import { SHOT_STAGE_LABEL } from "../workflow/shotprod.js";
import { REFERENCE_ROLES } from "../workflow/geninput.js";

/** Split an episode script into its scene blocks, so a Scene can show the text
 *  it came from. Deliberately conservative: it matches the heading convention
 *  the Script Writer skill is told to use, and when a scene's text cannot be
 *  located it says so rather than showing a neighbouring scene's words. */
export function scriptSlices(scriptText, scenes) {
  const text = typeof scriptText === "string" ? scriptText : "";
  if (!text.trim()) return new Map();
  const lines = text.split("\n");
  // a heading is a line that names a scene: 「场景N」/「第N场」/「S01」, optionally
  // followed by location/time
  const isHeading = (ln) => /^\s*(场景\s*\d+|第\s*\d+\s*场|S\d{1,2}\b|SCENE\s*\d+)/i.test(ln);
  const blocks = [];
  let cur = null;
  for (const ln of lines) {
    if (isHeading(ln)) {
      cur = { heading: ln.trim(), body: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.body.push(ln);
    }
  }
  const out = new Map();
  scenes.forEach((sc, i) => {
    const b = blocks[i];
    // positional match ONLY when the counts line up; otherwise the honest
    // answer is "cannot locate", never a neighbouring block
    if (b && blocks.length === scenes.length) {
      out.set(sc.sceneId, { heading: b.heading, text: b.body.join("\n").trim() });
    }
  });
  return out;
}

/** The whole episode, assembled once. */
export function episodeModel(ctx) {
  const pd = ctx.prodData();
  const prod = pd.production;
  const ep = (prod.episodes || []).find((e) => e.episodeId === prod.activeEpisodeId) || prod.episodes[0] || null;
  if (!ep) return { empty: true, scenes: [], shots: 0 };
  const view = ctx.episode.view();
  const scriptText = ctx.script.currentText();
  const slices = scriptSlices(scriptText, (view && view.scenes) || []);
  const names = ctx.assets.names();

  const shotCard = (shot, sceneId, sceneTitle) => {
    const media = ctx.shot.mediaOf(shot);
    const stage = ctx.shot.stage(shot);
    const refs = ctx.episode.referencesOfShot(shot.shotId);
    return {
      shotId: shot.shotId,
      title: shot.title || "未命名镜头",
      description: shot.description || "",
      shotSize: shot.shotSize || "",
      angle: shot.angle || "",
      cameraMotion: shot.cameraMotion || "",
      action: shot.action || "",
      dialogue: shot.dialogue || "",
      duration: typeof shot.duration_seconds === "number" ? shot.duration_seconds : null,
      sceneId,
      sceneTitle,
      stage,
      stageLabel: SHOT_STAGE_LABEL[stage] || stage,
      approved: stage === "approved",
      imageUrl: ctx.episode.mediaUrl(shot, "images"),
      videoUrl: ctx.episode.mediaUrl(shot, "videos"),
      hasImage: !!media.image,
      hasVideo: !!media.video,
      references: refs,
    };
  };

  const scenes = ((view && view.scenes) || []).map((sc) => ({
    sceneId: sc.sceneId,
    title: sc.title,
    script: slices.get(sc.sceneId) || null,
    shots: (sc.shots || []).filter((x) => x && x.shot).map((x) => shotCard(x.shot, sc.sceneId, sc.title)),
    dangling: (sc.shots || []).filter((x) => x && !x.shot).length,
  }));
  const unassigned = ((view && view.unassigned) || []).map((s) => shotCard(s, null, null));

  const all = [...scenes.flatMap((s) => s.shots), ...unassigned];
  return {
    empty: false,
    episodeId: ep.episodeId,
    episodeTitle: ep.title,
    scriptText,
    hasScript: !!scriptText.trim(),
    scriptLocated: slices.size > 0,
    scenes,
    unassigned,
    shots: all.length,
    counts: ctx.shot.stageCounts(all.map((c) => ({
      shotId: c.shotId, description: c.description, shotSize: c.shotSize,
      angle: c.angle, cameraMotion: c.cameraMotion, action: c.action,
    }))),
    names,
  };
}

// --- rendering ------------------------------------------------------------- //

function refChips(refs) {
  if (!refs.length) return `<span class="ep-noref">未绑定参考</span>`;
  return refs.map((r) => `<span class="ep-refchip" title="${esc(r.name)}">${nameWithVersion(r.name, r.version)}</span>`).join("");
}

function shotRow(c, openId) {
  const open = c.shotId === openId;
  const thumb = c.hasVideo
    ? `<video class="ep-thumb" src="${esc(c.videoUrl)}" preload="metadata" muted playsinline></video>`
    : c.hasImage
      ? `<img class="ep-thumb" src="${esc(c.imageUrl)}" alt="" loading="lazy">`
      : `<div class="ep-thumb ep-nothumb">🎞</div>`;
  return (
    `<div class="ep-shot${open ? " on" : ""}${c.approved ? " ok" : ""}">` +
    `<button class="ep-shothead" data-ep-shot="${esc(c.shotId)}">` +
    thumb +
    `<span class="ep-shotmeta">` +
    `<span class="ep-shottitle">${esc(c.title)}</span>` +
    `<span class="ep-shotsub">${[c.shotSize, c.angle, c.duration ? `${c.duration}s` : ""].filter(Boolean).map(esc).join(" · ")}</span>` +
    `<span class="ep-shotrefs">${refChips(c.references)}</span>` +
    `</span>` +
    `<span class="chip${c.approved ? " ok" : ""}">${esc(c.stageLabel)}</span>` +
    `</button>` +
    (open ? shotDetail(c) : "") +
    `</div>`
  );
}

function shotDetail(c) {
  const media = c.hasVideo
    ? `<video class="ep-player" src="${esc(c.videoUrl)}" controls preload="metadata"></video>`
    : c.hasImage
      ? `<img class="ep-player" src="${esc(c.imageUrl)}" alt="">`
      : mediaBox("", { missing: "这个镜头还没有画面", icon: "🎞" });
  const design = [
    ["描述", c.description], ["景别", c.shotSize], ["角度", c.angle],
    ["运镜", c.cameraMotion], ["动作", c.action], ["台词", c.dialogue],
  ].filter(([, v]) => v && String(v).trim());
  return (
    `<div class="ep-detail">` +
    `<div class="ep-detail-media">${media}</div>` +
    `<div class="ep-detail-body">` +
    (design.length
      ? `<dl class="ep-design">${design.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
      : `<div class="ep-nodesign">这个镜头还没有设计内容——先在「分镜」里写清景别 / 动作。</div>`) +
    `<div class="ep-acts">` +
    `<button class="btn" data-ep-refs="${esc(c.shotId)}">参考…</button>` +
    `<button class="btn primary" data-ep-gen="${esc(c.shotId)}">生成任务…</button>` +
    `<button class="btn" data-goto="dailies">去审片</button>` +
    `</div></div></div>`
  );
}

export function renderEpisodeWs(ctx, ui) {
  const m = episodeModel(ctx);
  if (m.empty) {
    return head("本集制作", "") + empty("📺", "还没有剧集", "在「结构规划」确认规划后建立剧集");
  }
  if (!m.shots) {
    return (
      head(m.episodeTitle, "剧本 → 场景 → 镜头 → 参考 → Prompt → 画面 → 审片") +
      (m.hasScript
        ? empty("🎞", "剧本有了，还没有拆成镜头", "在「分镜」里拆解本集剧本",
            `<button class="btn primary" data-goto="shots">去分镜</button>`)
        : empty("📄", "这一集还没有剧本", "先写或生成本集剧本",
            `<button class="btn primary" data-goto="script">去剧本</button>`))
    );
  }
  const c = m.counts;
  const sub =
    `${m.shots} 个镜头 · 已通过 ${c.approved} · 待审 ${c["todo-review"]} · ` +
    `已生成 ${c.generated} · 待生成 ${c["todo-generate"]} · 待设计 ${c["todo-design"]}`;
  const sceneBlock = (s) => (
    `<section class="ep-scene">` +
    `<header class="ep-scenehead"><h3>${esc(s.title)}</h3>` +
    `<span class="ep-scenen">${s.shots.length} 个镜头</span></header>` +
    (s.script
      ? `<details class="ep-script" open><summary>场景剧本</summary><pre>${esc(s.script.text || s.script.heading)}</pre></details>`
      : m.hasScript
        ? `<div class="ep-scriptnote">无法把剧本里的段落对应到这个场景——剧本的场景标题数量与场景数不一致，所以这里不猜。</div>`
        : "") +
    `<div class="ep-shots">${s.shots.map((x) => shotRow(x, ui.epShotId)).join("")}</div>` +
    (s.dangling ? `<div class="ep-dangling">${s.dangling} 个镜头引用在当前草稿里找不到（草稿可能被重新生成）</div>` : "") +
    `</section>`
  );
  return (
    head(m.episodeTitle, sub,
      `<button class="btn" data-goto="refplan">参考统筹</button>` +
      `<button class="btn" data-goto="dailies">审片</button>`) +
    `<div class="ep-wrap">` +
    m.scenes.map(sceneBlock).join("") +
    (m.unassigned.length
      ? `<section class="ep-scene"><header class="ep-scenehead"><h3>未分配到场景</h3>` +
        `<span class="ep-scenen">${m.unassigned.length} 个镜头</span></header>` +
        `<div class="ep-shots">${m.unassigned.map((x) => shotRow(x, ui.epShotId)).join("")}</div></section>`
      : "") +
    `</div>` +
    (ui.epPanel === "refs" && ui.epShotId ? refPanel(ctx, ui) : "") +
    (ui.epPanel === "gen" && ui.epShotId ? genPanel(ctx, ui) : "")
  );
}

/** The Reference picker — three entrances, exactly as specified. */
function refPanel(ctx, ui) {
  const p = ctx.episode.pickerModel(ui.epShotId);
  // A reference whose bytes are archived or removed still EXISTS and can still
  // be bound — its storage state is a fact about the file, not about the
  // reference. But it must not be rendered as a picture: a broken-image glyph
  // says "something went wrong here" when the truth is "these bytes were
  // deliberately put away", and the creator cannot tell those apart.
  const STATE_LABEL = { archived: "已归档", removed: "字节已移除", missing: "字节不在" };
  const thumb = (r) =>
    r.url && r.storageState === "local"
      ? `<img class="rp-thumb sm" src="${esc(r.url)}" alt="">`
      : `<span class="rp-thumb sm rp-none" title="${esc(STATE_LABEL[r.storageState] || "没有可预览的画面")}">⃠</span>`;
  const row = (r, action) =>
    `<li>${thumb(r)}<span class="ep-pickname">${nameWithVersion(r.name, r.version)}` +
    (r.storageState && r.storageState !== "local"
      ? ` <span class="chip">${esc(STATE_LABEL[r.storageState] || r.storageState)}</span>`
      : "") +
    `</span>${action}</li>`;
  return (
    `<div class="ep-panel"><div class="ep-panelhead"><b>为这个镜头选择参考</b>` +
    `<button class="btn" data-ep-close>关闭</button></div>` +
    `<h4>已绑定</h4>` +
    (p.bound.length
      ? `<ul class="ep-picklist">${p.bound.map((r) => row(r, `<button class="btn" data-ep-unbind="${esc(r.key)}">移除</button>`)).join("")}</ul>`
      : `<div class="al-none">还没有绑定任何参考。</div>`) +
    `<h4>本集推荐</h4>` +
    (p.suggested.length
      ? `<ul class="ep-picklist">${p.suggested.map((r) => row(r, `<button class="btn primary" data-ep-bind="${esc(r.key)}">绑定</button>`)).join("")}</ul>`
      : `<div class="al-none">这一集的场景里没有还缺参考的对象。</div>`) +
    `<h4>从资产库选择</h4>` +
    (p.library.length
      ? `<ul class="ep-picklist">${p.library.map((r) => row(r, `<button class="btn" data-ep-bind="${esc(r.key)}">绑定</button>`)).join("")}</ul>`
      : `<div class="al-none">资产库里还没有参考资产。</div>`) +
    `<h4>临时上传</h4>` +
    `<div class="ep-upload">` +
    REFERENCE_ROLES.map(([role, label]) =>
      `<button class="btn" data-ep-upload="${esc(role)}">上传${esc(label)}</button>`).join("") +
    `<p class="rp-note">临时上传同样走统一登记：它会成为一个真正的 Asset 并绑定到这个镜头，绝不产生孤立文件。</p>` +
    `</div></div>`
  );
}

/** The Generation Input Set + the manual generation task. */
function genPanel(ctx, ui) {
  const g = ctx.episode.genModel(ui.epShotId, ui.epGenKind || "image");
  const set = g.set;
  const refList = REFERENCE_ROLES.map(([role, label]) => {
    const rs = set.references[role] || [];
    return (
      `<dt>${esc(label)}</dt><dd>${rs.length
        ? rs.map((r) => `<span class="ep-refchip">${nameWithVersion(r.name, r.version)}</span>`).join(" ")
        : `<span class="muted">—</span>`}</dd>`
    );
  }).join("");
  const frame = (f, label) =>
    `<dt>${esc(label)}</dt><dd>${f ? `${esc(f.name)}` : `<span class="muted">—</span>`}</dd>`;
  // Gaps in the input set are shown BEFORE the actions, not under them: a list
  // of what is missing printed below an equally-ready-looking button is a note
  // nobody reads until afterwards.
  //
  // They do NOT disable the import. A creator who already generated the video
  // elsewhere has a real take for this shot; refusing to register it because
  // this system never saw a first frame would lose real work and push them onto
  // a path with WORSE provenance. What we record instead is the truth — an
  // input the records do not prove is left empty, never invented. The one
  // refusal is structural and lives in the controller: a shot whose identity
  // cannot be resolved has nowhere to put the media at all.
  const blockers = g.missing.length
    ? `<div class="ep-blockers"><b>输入集合还缺：</b>` +
      `<ul>${g.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
      `<span>仍然可以导入已经在外部生成好的结果——缺的部分会如实记为「未记录」，不会被补全成看起来合理的值。</span></div>`
    : "";
  return (
    `<div class="ep-panel"><div class="ep-panelhead"><b>生成任务 · ${esc(set.design ? set.design.title : "")}</b>` +
    `<span class="ep-kinds">` +
    ["image", "video"].map((k) =>
      `<button class="ep-kind${(ui.epGenKind || "image") === k ? " on" : ""}" data-ep-kind="${k}">${k === "image" ? "图片" : "视频"}</button>`).join("") +
    `</span><button class="btn" data-ep-close>关闭</button></div>` +
    `<h4>输入集合</h4>` +
    `<dl class="ep-inputs">` +
    `<dt>镜头</dt><dd>${esc(set.episodeCode || "")} ${esc(set.sceneTitle || "未分配场景")} · ${esc(set.design ? set.design.title : "")}</dd>` +
    refList +
    frame(set.startFrame, "首帧") +
    frame(set.endFrame, "尾帧") +
    `<dt>来源</dt><dd>${esc(set.source || "手工外部生成")}</dd>` +
    `<dt>模型</dt><dd>${set.model ? esc(set.model) : `<span class="muted">未知（外部生成不上报）</span>`}</dd>` +
    `<dt>seed</dt><dd>${set.seed !== null ? esc(String(set.seed)) : `<span class="muted">未知</span>`}</dd>` +
    `</dl>` +
    `<h4>Prompt</h4>` +
    `<textarea class="field ep-prompt" rows="8" spellcheck="false">${esc(g.prompt)}</textarea>` +
    blockers +
    `<div class="ep-acts">` +
    `<button class="btn" data-ep-copy>复制 Prompt</button>` +
    `<button class="btn" data-ep-recompile>重新编译</button>` +
    `<label class="btn primary ep-importlbl">上传外部生成结果<input type="file" class="ep-import" accept="${(ui.epGenKind || "image") === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm"}" hidden></label>` +
    `</div>` +
    `<p class="rp-note">上传后会立刻登记为 Asset、绑定到这个镜头、冻结当前 Prompt 与参考输入，并出现在 Workflow 溯源里。</p>` +
    `</div>`
  );
}

export function bindEpisodeWs(root, ctx, ui, render) {
  root.querySelectorAll("[data-ep-shot]").forEach((b) => (b.onclick = () => {
    ui.epShotId = ui.epShotId === b.dataset.epShot ? null : b.dataset.epShot;
    ui.epPanel = null;
    render();
  }));
  root.querySelectorAll("[data-ep-refs]").forEach((b) => (b.onclick = () => {
    ui.epShotId = b.dataset.epRefs;
    ui.epPanel = "refs";
    render();
  }));
  root.querySelectorAll("[data-ep-gen]").forEach((b) => (b.onclick = () => {
    ui.epShotId = b.dataset.epGen;
    ui.epPanel = "gen";
    ui.epPrompt = null;
    render();
  }));
  const on = (sel, fn, ev = "onclick") => {
    const el = root.querySelector(sel);
    if (el) el[ev] = fn;
  };
  on("[data-ep-close]", () => { ui.epPanel = null; render(); });
  root.querySelectorAll("[data-ep-kind]").forEach((b) => (b.onclick = () => {
    ui.epGenKind = b.dataset.epKind;
    ui.epPrompt = null;
    render();
  }));
  root.querySelectorAll("[data-ep-bind]").forEach((b) => (b.onclick = () => {
    ctx.shot.addReference(ui.epShotId, b.dataset.epBind);
    render();
  }));
  root.querySelectorAll("[data-ep-unbind]").forEach((b) => (b.onclick = () => {
    ctx.shot.removeReference(ui.epShotId, b.dataset.epUnbind);
    render();
  }));
  root.querySelectorAll("[data-ep-upload]").forEach((b) => (b.onclick = () => {
    ctx.episode.uploadReference(ui.epShotId, b.dataset.epUpload).then(render);
  }));
  const prompt = root.querySelector(".ep-prompt");
  if (prompt) prompt.oninput = () => { ui.epPrompt = prompt.value; };
  on("[data-ep-copy]", () => ctx.episode.copyPrompt(prompt ? prompt.value : ""));
  on("[data-ep-recompile]", () => { ui.epPrompt = null; render(); });
  const imp = root.querySelector(".ep-import");
  if (imp) {
    imp.onchange = () => {
      const file = imp.files && imp.files[0];
      if (!file) return;
      ctx.episode
        // the field's CURRENT text, verbatim — an empty box means the creator
        // cleared it, which is an answer. `null` (no field at all) is the only
        // "I have nothing to say", and only that falls back to the compiled one.
        .importResult(ui.epShotId, ui.epGenKind || "image", file, prompt ? prompt.value : null)
        .then(render)
        .catch((e) => ctx.toast(`导入失败：${e.message}`));
    };
  }
}
