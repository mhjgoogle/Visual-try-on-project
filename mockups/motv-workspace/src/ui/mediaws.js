// 画面 / 视频工作区 — the two shot-centric media screens.
//
// Both compose the SAME parts as 分镜 (scene strip → shot list → hero →
// variants → references), so moving between them never changes the mental
// model; only the medium in the hero and the metadata beside it differ:
//
//   画面  the active shot IMAGE + its refs/state/style + image variants
//   视频  the active shot VIDEO + its SOURCE image (recorded first frame) +
//         the motion facets + video variants
//
// Read-only over the same models the storyboard uses (storyboardModel /
// shotDetailModel). Writes go through the shared shot bindings.
import { esc } from "../util/dom.js";
import { head, empty } from "./shell.js";
import { storyboardModel, shotDetailModel, buildPortraitIndex } from "./storyboard.js";
import { episodeShots } from "./prodplan.js";
import { bindShotSelection, bindShotMedia } from "./storyboard.js";
import {
  nn, renderSceneStrip, renderShotList, renderHero, renderVariantGrid, renderRefCards, renderLineage,
  videoSourceFrame,
  curVideoVersion,
} from "./studioparts.js";
import { genCardModel, renderGenCard, bindGenCard } from "./gencard.js";
import { chainOptions, renderChainMenu } from "./chain.js";

/** 「以此生成 →」 for the shot on screen (TASK-079 §1.2). The options depend on
 *  this shot's own context — whether it has a resolvable slot, and whether its
 *  scene has a following shot — so they are derived here, per render. */
function chainMenu(ctx, ui, d, kind) {
  if (!d || !d.shot.shotId) return "";
  const shotId = d.shot.shotId;
  const nextShot = ctx.frames && typeof ctx.frames.nextShotOf === "function"
    ? ctx.frames.nextShotOf(shotId)
    : null;
  return renderChainMenu(
    kind,
    chainOptions(kind, { nextShot, slot: d.slot, inScene: !!d.scene }),
    { open: ui.chainOpen === kind, shotId },
  );
}

/** The ONE generation card for the shot on screen (TASK-078 §3).
 *
 *  Built here rather than in each workspace body so 画面 and 视频 cannot drift
 *  into two different generation surfaces — which is the state this card exists
 *  to end. A shot with no resolved identity gets nothing: a card whose submit
 *  and import both refuse is worse than none. */
function genCard(ctx, ui, d, kind) {
  if (!d || !d.shot.shotId) return "";
  const edit = ui.gcPrompt && ui.gcPrompt[d.shot.shotId]
    ? ui.gcPrompt[d.shot.shotId][kind]
    : null;
  return renderGenCard(genCardModel(d, kind, {
    paid: typeof ctx.isPaid === "function" ? ctx.isPaid() : false,
    quote: ui.gcQuote || null,
    promptEdit: edit,
  }));
}

/** Import a generated file back onto this shot, with the provenance intent the
 *  free route captured. Unchanged behaviour — the same round trip `genentry.js`
 *  performs; only its entrance moved onto the card. */
function importForShot(ctx, ui, rerender) {
  return (kind, shotId) => {
    const d = shotDetailModel(ctx.prodData(), shotId);
    if (!d || !d.slot) { ctx.toast("镜头身份未解析：无法定位媒体槽位"); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      // only an intent recorded FOR THIS SHOT counts: a stale one from another
      // shot would attribute this file to a prompt it never came from
      const intent = ui.genIntent && ui.genIntent[kind] && ui.genIntent[kind].shotId === shotId
        ? ui.genIntent[kind]
        : null;
      try {
        await ctx.media.importShotMedia(kind, d.slot, shotId, file, intent);
        if (intent && ui.genIntent && ui.genIntent[kind] === intent) delete ui.genIntent[kind];
        rerender();
      } catch (err) {
        ctx.toast("导入失败：" + err.message);
      }
    };
    input.click();
  };
}

/** Shared frame: header + scene strip + three columns. `centre`/`right` are
 *  built by the caller for the medium it owns. */
function frame(m, ui, { title, meta, action, centre, right }) {
  const selScene = m.scenes.find((sc) => sc.shots.some((s) => s.shotId === ui.selectedShotId));
  return (
    head(title, meta, action || "") +
    renderSceneStrip(m.scenes, selScene ? selScene.sceneId : null) +
    `<div class="wsplit">` +
    `<div class="listcol">${renderShotList(m.scenes, m.unassigned, ui.selectedShotId)}</div>` +
    `<div class="maincol">${centre}</div>` +
    `<div class="refcol">${right}</div>` +
    `</div>`
  );
}

function noDraft(kind) {
  return (
    head(kind === "image" ? "画面" : "视频", "还没有分镜") +
    empty(
      kind === "image" ? "🖼" : "▶",
      "先有分镜，才有镜头可以生成",
      `${kind === "image" ? "画面" : "视频"}是按镜头组织的：每个镜头一个媒体槽位，变体全部保留、可回切。先在「分镜」把剧本拆成镜头。`,
      `<button class="btn primary" data-goto="shots">→ 去分镜工作区</button>`,
    )
  );
}

/** The project HAS a draft, this episode owns none of it, and there is no
 *  unassigned inventory either — so there is genuinely nothing to work on.
 *  When a pool DOES exist these workspaces render normally instead: those shots
 *  are real, `defaultShotId()` selects one, and a dead-end empty state would
 *  make a project whose shots are all unassigned unusable here. */
function noEpisodeShots(kind, m) {
  return (
    head(kind === "image" ? "画面" : "视频", `本集还没有镜头 · 项目草稿共 ${m.total} 个镜头`) +
    empty(
      kind === "image" ? "🖼" : "▶",
      "本集还没有镜头",
      "场景与镜头归属是按集的：先在「剧集」为本集建立场景并归入镜头，这里才会出现可生成的镜头。",
      `<div class="row"><button class="btn primary" data-goto="episodes">→ 去剧集建立场景</button>` +
        `<button class="btn" data-goto="shots">→ 去分镜</button></div>`,
    )
  );
}

function pickHint(kind) {
  return empty(
    kind === "image" ? "🖼" : "▶",
    "选一个镜头",
    kind === "image"
      ? "左侧选择镜头，这里显示它当前的画面、全部图片变体，以及生成用到的角色 / 场景地参考。"
      : "左侧选择镜头，这里显示它当前的视频、来源首帧，以及全部视频变体。",
  );
}

/* -------------------------------------------------------------------------- */
/* 画面 (Image)                                                                */
/* -------------------------------------------------------------------------- */

export function renderImageWs(ctx, ui) {
  const pd = ctx.prodData();
  const m = storyboardModel(pd);
  if (!m.hasDraft) return noDraft("image");
  if (m.episodeEmpty && !m.unassigned.length) return noEpisodeShots("image", m);
  const portraitFor = buildPortraitIndex(pd);
  const d = ui.selectedShotId ? shotDetailModel(pd, ui.selectedShotId) : null;
  // counted over the shots THIS EPISODE owns — the same derivation the rail
  // badge and the Production Plan use, so the three cannot disagree
  const epShots = episodeShots(pd);
  const total = epShots.length;
  const done = epShots.filter((s) => s.thumb).length;

  let centre = pickHint("image");
  if (d) {
    const cur = d.images.list.find((r) => r.current);
    centre =
      `<div class="stack">` +
      renderHero({
        url: cur ? cur.url : "",
        kind: "image",
        title: `${nn(d.shot.seq)} ${d.shot.title}`,
        badges: [
          `<span class="chip solid">${esc(nn(d.shot.seq))}</span>`,
          d.shot.shotSize ? `<span class="chip">${esc(d.shot.shotSize)}</span>` : "",
          d.shot.angle ? `<span class="chip">${esc(d.shot.angle)}</span>` : "",
        ].filter(Boolean),
        right: cur ? [`<span class="chip ok">Image v${cur.version}</span>`] : [],
        missing: "这个镜头还没有画面 — 用下面的生成卡生成或导入",
      }) +
      genCard(ctx, ui, d, "image") +
      `<div class="st-sec"><h3>画面变体</h3><div class="acts">` +
      (cur ? chainMenu(ctx, ui, d, "image") : "") +
      (cur ? `<button class="btn sm" data-useff="${esc(d.slot || "")}">🎬 用作视频首帧</button>` : "") +
      `<button class="btn sm" data-goto="video">去视频 →</button></div></div>` +
      (d.slot
        ? renderVariantGrid("image", d.slot, d.images, null)
        : `<div class="meta">镜头身份未解析 — 无法定位媒体槽位。</div>`) +
      `<div class="shotmeta">` +
      `<div class="kv full"><span class="k">画面内容</span><span class="v">${esc(d.shot.description || "（未填写）")}</span></div>` +
      // same rule as `renderShotMeta` (TASK-078 §2.1): an unfilled facet points at
      // where it gets filled instead of just declaring itself unfilled
      [["景别", "shotSize"], ["角度", "angle"], ["情绪", "emotion"], ["光影氛围", "lighting"]]
        .map(([label, field]) =>
          `<div class="kv"><span class="k">${esc(label)}</span>` +
          (d.shot[field]
            ? `<span class="v">${esc(d.shot[field])}</span>`
            : `<button class="v todo" data-fillfacet="${esc(field)}" data-shot="${esc(d.shot.shotId || "")}">未填 · 去填写</button>`) +
          `</div>`).join("") +
      `</div></div>`;
  }

  const right = d
    ? renderRefCards(d.scene, portraitFor) +
      (d.scene && d.scene.location
        ? `<div><div class="lab">风格</div><div class="meta">画面指令随场景地 / 角色状态编译进 Image Prompt（右侧 AI 导演可预览完整 Prompt）。</div></div>`
        : "")
    : "";

  return frame(m, ui, {
    title: m.episode ? `画面 · ${m.episode.title}` : "画面",
    meta: `${done}/${total} 个镜头已有画面`,
    action: "",
    centre,
    right,
  });
}

export function bindImageWs(root, ctx, ui, rerender) {
  bindShotSelection(root, ctx, ui, rerender);
  bindShotMedia(root, ctx, ui);
  if (ui.selectedShotId) {
    const d = shotDetailModel(ctx.prodData(), ui.selectedShotId);
    bindGenCard(root, ctx, ui, rerender, {
      kind: "image", shotId: ui.selectedShotId, importMedia: importForShot(ctx, ui, rerender),
      // the failure tickets need the SAME records the card rendered from
      failures: d ? genCardModel(d, "image", {}).failures : [],
    });
    // 「以此生成 →」 is wired by the SHELL (ui/production.js), beside [data-goto]
    // and [data-ent-id]: every one of its branches ends in a page switch, and
    // that is a shell decision. Wiring it here too would attach two handlers to
    // one button and the later one would silently win.
  }
}

/* -------------------------------------------------------------------------- */
/* 视频 (Video)                                                                */
/* -------------------------------------------------------------------------- */

export function renderVideoWs(ctx, ui) {
  const pd = ctx.prodData();
  const m = storyboardModel(pd);
  if (!m.hasDraft) return noDraft("video");
  if (m.episodeEmpty && !m.unassigned.length) return noEpisodeShots("video", m);
  const portraitFor = buildPortraitIndex(pd);
  const d = ui.selectedShotId ? shotDetailModel(pd, ui.selectedShotId) : null;
  const epShots = episodeShots(pd);
  const total = epShots.length;
  const done = epShots.filter((s) => s.hasVideo).length;

  let centre = pickHint("video");
  if (d) {
    const curVid = d.videos.list.find((r) => r.current);
    const curImg = d.images.list.find((r) => r.current);
    // motion facets, as compact cards rather than a form
    const motion = [
      ["动作", d.shot.action],
      ["运镜", d.shot.cameraMotion],
      ["环境运动", ""],
      ["表情变化", d.shot.emotion],
      ["时长", `${d.shot.duration}s`],
    ]
      .map(([k, v]) =>
        `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v ? esc(v) : "（未填写）"}</span></div>`,
      )
      .join("");
    centre =
      `<div class="stack">` +
      renderHero({
        url: curVid ? curVid.url : "",
        kind: "video",
        poster: videoSourceFrame(d, curVideoVersion(d)), // that version's RECORDED source only
        title: `${nn(d.shot.seq)} ${d.shot.title}`,
        badges: [`<span class="chip solid">${esc(nn(d.shot.seq))}</span>`, `<span class="chip">${d.shot.duration}s</span>`],
        right: curVid ? [`<span class="chip ok">Video v${curVid.version}</span>`] : [],
        missing: curImg ? "还没有视频 — 已有首帧图片，可从它生成" : "还没有视频，也还没有画面",
      }) +
      renderLineage(d) +
      genCard(ctx, ui, d, "video") +
      `<div class="st-sec"><h3>运动设定</h3></div>` +
      `<div class="shotmeta">${motion}</div>` +
      `<div class="st-sec"><h3>视频变体</h3><div class="acts">` +
      (curVid ? chainMenu(ctx, ui, d, "video") : "") +
      `<button class="btn sm" data-goto="frames">← 回画面</button>` +
      `<button class="btn sm" data-goto="edit">去剪辑 →</button></div></div>` +
      (d.slot
        ? renderVariantGrid("video", d.slot, d.videos, (r) => videoSourceFrame(d, r.version))
        : `<div class="meta">镜头身份未解析 — 无法定位媒体槽位。</div>`) +
      `</div>`;
  }

  const right = d
    ? (d.images.list.length
        ? `<div><div class="lab">来源画面</div>` +
          // ✓首帧 marks the RECORDED first frame — the image this shot's video
          // actually came from — not merely the image that is current now
          `<div class="vgrid">${d.images.list
            .map((r) => {
              const isFrame = !!d.firstFrame && d.firstFrame.version === r.version;
              return `<button class="vcard${isFrame ? " on" : ""}" ${r.current ? "" : `data-setcur="image" data-slot="${esc(d.slot || "")}" data-v="${r.version}"`}>` +
                `<img class="media" src="${esc(r.url)}" alt="" loading="lazy">` +
                `<span class="bd"><span class="vn">Image v${r.version}` +
                (isFrame ? `<span class="cur">✓ 首帧</span>` : r.current ? `<span class="cur">当前</span>` : "") +
                `</span></span></button>`;
            })
            .join("")}</div>` +
          (d.firstFrame ? "" : `<div class="meta">还没有记录首帧 — 在「画面」把某一版设为首帧后，视频来源才可追溯。</div>`) +
          `</div>`
        : `<div><div class="lab">来源画面</div><div class="meta">还没有画面 — 视频通常从首帧图片生成。</div>` +
          `<div class="row"><button class="btn sm" data-goto="frames">→ 去画面工作区</button></div></div>`) +
      renderRefCards(d.scene, portraitFor)
    : "";

  return frame(m, ui, {
    title: m.episode ? `视频 · ${m.episode.title}` : "视频",
    meta: `${done}/${total} 个镜头已有视频`,
    action: "",
    centre,
    right,
  });
}

export function bindVideoWs(root, ctx, ui, rerender) {
  bindShotSelection(root, ctx, ui, rerender);
  bindShotMedia(root, ctx, ui);
  if (ui.selectedShotId) {
    const d = shotDetailModel(ctx.prodData(), ui.selectedShotId);
    bindGenCard(root, ctx, ui, rerender, {
      kind: "video", shotId: ui.selectedShotId, importMedia: importForShot(ctx, ui, rerender),
      // the failure tickets need the SAME records the card rendered from
      failures: d ? genCardModel(d, "video", {}).failures : [],
    });
    // 「以此生成 →」 is wired by the SHELL (ui/production.js), beside [data-goto]
    // and [data-ent-id]: every one of its branches ends in a page switch, and
    // that is a shell decision. Wiring it here too would attach two handlers to
    // one button and the later one would silently win.
  }
}
