// ⑨ 粗剪审片 · 故事板形态 (TASK-079 §1.1) — one episode's shots × three columns.
//
// WHY. The review surface was a per-shot walk with 60 page numbers along the
// bottom: one shot visible at a time. 「这一集哪些镜头有视频、分别用了哪个模型、
// 首帧来自哪张、哪些失败了」 could not be answered from any screen, in a product
// whose whole job is producing those shots. The three workspaces each offered a
// single total (`0/60`) and nothing else.
//
// NO SECOND STATE COMPUTATION. Every row's standing comes from `shotprod
// .shotStage` — the same function 审片, the rail badges and the production plan
// use — reached through `dailiesModel`, which already walks the episode's scenes
// AND the unassigned pool.
//
// WHY NOT `prodgraph`. The card names it, and it is the wrong source HERE: its
// `productionModel` scopes to the shots an episode's scenes OWN. On the real
// project every one of the 60 shots is unassigned, so a prodgraph-backed review
// page would render empty — an honest-looking screen showing nothing, for a
// project with 60 shots. `dailiesModel` reports the pool as well, and both call
// the same `shotStage`, so the single-computation rule is kept where it counts.
//
// Read-only: this page derives, and writes only through the approval path the
// walk already used.

import { esc } from "../util/dom.js";
import { head, empty } from "./shell.js";

/** The filters, in reading order. Each is a PURE predicate over a row. */
export const REVIEW_FILTERS = [
  ["all", "全部", () => true],
  ["approved", "已通过", (r) => r.stage === "approved"],
  ["review", "待审", (r) => r.stage === "todo-review"],
  ["generated", "已生成", (r) => r.hasImage || r.hasVideo],
  ["pending", "待生成", (r) => !r.hasImage && !r.hasVideo],
  ["failed", "失败", (r) => r.failed.length > 0],
];

const FILTER_BY_KEY = new Map(REVIEW_FILTERS.map(([k, , fn]) => [k, fn]));

const str = (x) => (typeof x === "string" ? x : "");

/** 「未记录」, said once and the same way everywhere. A blank cell and a value of
 *  zero look identical and only one of them is true. */
export const NOT_RECORDED = "未记录";

/** 「还没量过」—— 与「量过了，量不出来」是两回事（TASK-103 批次 C）。
 *
 *  这两个词此前都写作「未记录」，而它们要求的下一步完全不同：一个是按一下
 *  「测量」，另一个是这个文件有问题。合并它们正是本仓库反复付代价的那种
 *  「三个事实塌成一个」。 */
export const NOT_MEASURED = "未探测";

/** ffprobe 的每种失败结局，说人话。绝不退化成一个数字。 */
const MEASURE_TEXT = {
  no_ffprobe: "探不到（本机没有 ffprobe）",
  unreadable: "探不到（文件读不出画面/时长）",
  not_found: "探不到（文件不在）",
  bad_name: "探不到（文件名不合法）",
};

/** 尺寸列：量到了给真实像素，没量给「未探测」，量不到给具体原因。
 *
 *  `bytes` 是审计顺带拿到的**真实**字节数，免费且总是有 —— 但它不是尺寸，
 *  所以只作为附注出现，绝不冒充像素值。 */
export function sizeText(measured, bytes) {
  const suffix = Number.isFinite(bytes) ? ` · ${formatBytes(bytes)}` : "";
  if (!measured) return NOT_MEASURED + suffix;
  if (measured.state === "ok" && measured.width && measured.height) {
    return `${measured.width}×${measured.height}${suffix}`;
  }
  return (MEASURE_TEXT[measured.state] || "探不到") + suffix;
}

/** 时长列：量到了给真实秒数，否则如实标「设计」值是设计值。 */
export function durationText(measured, designed) {
  if (measured && measured.state === "ok" && Number.isFinite(measured.duration)) {
    const real = `${measured.duration.toFixed(2)}s`;
    // 实测与设计不一致时**两个都说** —— 差异本身就是审片要看的东西
    return designed != null && Math.abs(measured.duration - designed) > 0.05
      ? `${real}（设计 ${designed}s）`
      : real;
  }
  if (measured) return MEASURE_TEXT[measured.state] || "探不到";
  return designed != null ? `${designed}s（设计）` : NOT_MEASURED;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Summarise a description for a list row without cutting mid-character. */
function summarize(text, max = 64) {
  const s = str(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The generation that PRODUCED `assetId`, or null.
 *
 * NOT 「the newest generation of this type」 (codex round 1, P1). A shot can have
 * a working clip from one attempt and a later attempt that failed or produced a
 * take nobody switched to — and this page's whole job is saying which model made
 * the thing on screen. Keyed by the newest-first order, so a re-run that
 * legitimately produced the same asset still reports the latest record for it.
 *
 * Same rule `shotDetailModel` already uses to prove a video's source frame
 * (`resultAssetIds.includes(...)`) — one definition of 「这条媒体是哪次生成来的」,
 * not two.
 */
function genForAsset(gens, type, assetId) {
  if (!assetId) return null;
  return gens.find((g) => g.type === type && g.resultAssetIds.includes(assetId)) || null;
}

/**
 * ONE row of the storyboard: the shot, its picture, its clip.
 *
 * `item` is a `dailiesModel` item (identity, stage, approval, playability);
 * `d` is `shotDetailModel` output (media variants, provenance, first frame).
 * Everything the registry does not record is reported as 未记录 — never filled
 * in with a plausible value (AGENTS.md 第 20 条 真实项目为主要验收环境).
 */
export function reviewRow(item, d, media = {}) {
  //: `media.measuredOf(url)` → ffprobe 的结果或 null；`media.bytesOf(url)` →
  //: 服务端审计给的真实字节数或 null。两个都注入，所以这个函数仍然是纯的。
  const measuredOf = typeof media.measuredOf === "function" ? media.measuredOf : () => null;
  const bytesOf = typeof media.bytesOf === "function" ? media.bytesOf : () => null;
  const gens = (d && d.generations) || [];
  const curImg = d ? d.images.list.find((r) => r.current) : null;
  const curVid = d ? d.videos.list.find((r) => r.current) : null;
  // bound to the CURRENT take, never merely to the shot — see `genForAsset`
  const imgGen = genForAsset(gens, "image", curImg && curImg.assetId);
  const vidGen = genForAsset(gens, "video", curVid && curVid.assetId);
  const source = curVid && d.videoSources ? d.videoSources[curVid.version] || null : null;
  return {
    shotId: item.shotId,
    index: item.index,
    seq: item.index + 1,
    title: item.title || "未命名镜头",
    sceneTitle: item.sceneTitle,
    description: summarize(item.description),
    stage: item.stage,
    stageLabel: item.stageLabel,
    approved: item.approved,
    staleApproval: item.staleApproval,
    canApprove: item.canApprove,
    hasImage: !!curImg,
    hasVideo: !!curVid,
    playable: item.playable,
    image: {
      url: curImg ? curImg.url : "",
      version: curImg ? curImg.version : null,
      origin: curImg ? curImg.origin : "",
      // MEASURED, not declared (TASK-103 批次 C / TASK-087 §4.3). The Asset
      // Registry still stores no pixel dimensions — that would be a schema
      // change with its own migration story. Instead the server probes the file
      // on request, so the column stops saying 「未记录」 about something that is
      // sitting right there. Never measured yet ≠ measured and unreadable.
      size: sizeText(measuredOf(curImg && curImg.url), bytesOf(curImg && curImg.url)),
      measured: measuredOf(curImg && curImg.url),
      model: imgGen ? imgGen.model || NOT_RECORDED : null,
      status: imgGen ? imgGen.status : curImg ? "imported" : null,
    },
    video: {
      url: curVid ? curVid.url : "",
      version: curVid ? curVid.version : null,
      origin: curVid ? curVid.origin : "",
      size: sizeText(measuredOf(curVid && curVid.url), bytesOf(curVid && curVid.url)),
      measured: measuredOf(curVid && curVid.url),
      // REAL duration when probed; otherwise the designed one, still labelled as
      // designed. When the two disagree the column says BOTH — that disagreement
      // is precisely what a reviewer is there to notice.
      duration: durationText(measuredOf(curVid && curVid.url), item.duration),
      model: vidGen ? vidGen.model || NOT_RECORDED : null,
      status: vidGen ? vidGen.status : curVid ? "imported" : null,
      // WHICH picture this clip actually came from, proven from the Generation
      // that produced this exact version — never the slot's newest still
      sourceFrame: source && source.proven
        ? { url: source.url, version: source.version, origin: source.origin }
        : null,
    },
    // every FAILED generation on this shot, so the 失败 filter is about the
    // record and not about an empty slot
    failed: gens.filter((g) => g.status === "failed"),
  };
}

/**
 * The whole board.
 *
 * `dailies` is `dailiesModel` output; `detailOf(shotId)` returns
 * `shotDetailModel` output. Injected for the same reason the shot table injects
 * its compiler: this module must not become a second place that decides what a
 * shot's media standing is.
 */
export function reviewBoardModel(dailies, detailOf, { filter = "all", media = {} } = {}) {
  const of = typeof detailOf === "function" ? detailOf : () => null;
  const rows = ((dailies && dailies.items) || []).map((it) => reviewRow(it, of(it.shotId), media));
  const pass = FILTER_BY_KEY.get(filter) || FILTER_BY_KEY.get("all");
  return {
    rows,
    visible: rows.filter(pass),
    filter: FILTER_BY_KEY.has(filter) ? filter : "all",
    total: rows.length,
    // every filter's count, so the chips can say how much each one holds rather
    // than making the creator click to find out
    counts: Object.fromEntries(REVIEW_FILTERS.map(([k, , fn]) => [k, rows.filter(fn).length])),
    approved: dailies ? dailies.approved : 0,
    playable: dailies ? dailies.playable : 0,
  };
}

// --- rendering --------------------------------------------------------------- //

function cell(k, v) {
  return `<span class="cr-kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></span>`;
}

function statusChip(status) {
  if (!status) return `<span class="chip mute">待生成</span>`;
  const cls = status === "success" ? " ok" : status === "failed" ? " bad" : status === "imported" ? "" : " gen";
  const label = status === "imported" ? "已导入" : status;
  return `<span class="chip${cls}">${esc(label)}</span>`;
}

function mediaCol(r, kind) {
  const m = kind === "video" ? r.video : r.image;
  const thumb = m.url
    ? (kind === "video"
      ? `<video class="cr-thumb" src="${esc(m.url)}" controls preload="metadata"` +
        (m.sourceFrame ? ` poster="${esc(m.sourceFrame.url)}"` : "") + `></video>`
      : `<img class="cr-thumb" src="${esc(m.url)}" alt="" loading="lazy">`)
    : `<div class="cr-thumb cr-none">${kind === "video" ? "▶" : "🖼"}</div>`;
  const rows =
    (m.model ? cell("模型", m.model) : "") +
    (kind === "video" ? cell("时长", m.duration) : "") +
    cell("尺寸", m.size) +
    (kind === "video" && m.sourceFrame
      ? `<span class="cr-kv"><span class="k">首帧来自</span>` +
        `<img class="cr-src" src="${esc(m.sourceFrame.url)}" alt="" loading="lazy">` +
        `<span class="v">Image v${esc(String(m.sourceFrame.version))}</span></span>`
      : kind === "video" && m.url
        ? cell("首帧来自", NOT_RECORDED)
        : "");
  return (
    `<div class="cr-col">${thumb}` +
    `<div class="cr-meta">${statusChip(m.status)}${rows}</div>` +
    // STAYS after a failed measurement (codex round 1, non-blocking). Hiding it on
    // any cached result meant 「探不到」 was terminal: replace or repair the file and
    // the only way to ask again was a page reload. Only a successful measure has
    // nothing left to ask.
    (m.url && !(m.measured && m.measured.state === "ok")
      ? `<button class="btn sm" data-cr-measure="${esc(m.url)}" title="只读探测，不花钱">`
        + `${m.measured ? "重新测量" : "测量"}</button>`
      : "") +
    `<button class="btn sm" data-cr-ask="${esc(r.shotId)}" data-kind="${esc(kind)}">问 Agent</button>` +
    `</div>`
  );
}

export function renderCutReview(ctx, ui) {
  const m = ctx.review.board(ui.crFilter || "all");
  if (!m.total) {
    return (
      head("粗剪审片", "一集的镜头 × 三列清单") +
      empty("👁", "这一集还没有镜头", "先在「⑦ 分镜设计」把剧本拆成镜头，再回来审。",
        `<button class="btn" data-goto="shots">去分镜设计</button>`)
    );
  }
  const chips = REVIEW_FILTERS.map(([k, label]) =>
    `<button class="chip${m.filter === k ? " gate" : ""}" data-cr-filter="${esc(k)}">` +
    `${esc(label)} ${m.counts[k]}</button>`).join("");

  const rows = m.visible.map((r) =>
    `<div class="cr-row${r.approved ? " cr-ok" : ""}" data-cr-row="${esc(r.shotId)}">` +
    `<div class="cr-col cr-text">` +
    `<div class="cr-title"><span class="mono">${esc(String(r.seq).padStart(2, "0"))}</span> ${esc(r.title)}` +
    `<span class="chip${r.approved ? " ok" : ""}">${esc(r.stageLabel)}</span></div>` +
    (r.sceneTitle
      ? `<div class="cr-scene">${esc(r.sceneTitle)}</div>`
      : `<div class="cr-scene muted">未分配到场景</div>`) +
    (r.staleApproval
      ? `<div class="cr-stale">⚠ 曾被通过，但当时通过的视频已不在了——记录保留，状态已回退</div>`
      : "") +
    `<p class="cr-desc">${esc(r.description || "（还没有画面描述）")}</p>` +
    (r.failed.length
      ? `<div class="cr-fail">✖ ${r.failed.length} 次生成失败` +
        (r.failed[0].error ? `：${esc(summarize(r.failed[0].error, 48))}` : "") + `</div>`
      : "") +
    `<div class="cr-acts">` +
    (r.approved
      ? `<button class="btn sm" data-cr-unapprove="${esc(r.shotId)}">撤销通过</button>`
      : `<button class="btn sm primary" data-cr-approve="${esc(r.shotId)}"${r.canApprove ? "" : " disabled"} ` +
        `title="${r.canApprove ? "记录：这个镜头我看过，通过了" : "还没有视频可审——生成后才能通过"}">✔ 通过</button>`) +
    `<button class="btn sm" data-cr-open="${esc(r.shotId)}" data-goto="dailies">逐镜头看 →</button>` +
    `</div></div>` +
    mediaCol(r, "image") +
    mediaCol(r, "video") +
    `</div>`).join("");

  return (
    head(
      "粗剪审片",
      `${m.total} 个镜头 · 已通过 ${m.approved} · 可播 ${m.playable}` +
        (m.counts.failed ? ` · ✖ ${m.counts.failed} 个有失败记录` : ""),
    ) +
    `<div class="cr-filters">${chips}</div>` +
    `<div class="cr-head"><span>镜头</span><span>图片</span><span>视频</span></div>` +
    (m.visible.length
      ? `<div class="cr-list">${rows}</div>`
      : `<div class="cr-empty">这个筛选下没有镜头。</div>`)
  );
}

export function bindCutReview(root, ctx, ui, render) {
  root.querySelectorAll("[data-cr-filter]").forEach((b) => (b.onclick = () => {
    ui.crFilter = b.dataset.crFilter;
    render();
  }));
  root.querySelectorAll("[data-cr-approve]").forEach((b) => (b.onclick = () => {
    if (b.disabled) return;
    // the SAME write path the per-shot walk uses — 通过 refuses without a video
    // there, and must refuse identically here
    ctx.shot.approve(b.dataset.crApprove);
    render();
  }));
  root.querySelectorAll("[data-cr-unapprove]").forEach((b) => (b.onclick = () => {
    ctx.shot.unapprove(b.dataset.crUnapprove);
    render();
  }));
  // 逐镜头看 hands the walk its position, so the two surfaces are one review and
  // not two: the storyboard finds the shot, the walk plays it.
  // 逐镜头看 hands the walk its position, so the two surfaces are one review and
  // not two: the storyboard finds the shot, the walk plays it. The jump itself
  // rides the shell's own `[data-goto]` wiring (see the button's markup) — this
  // only sets WHERE the walk should land.
  root.querySelectorAll("[data-cr-open]").forEach((b) => (b.addEventListener("click", () => {
    ui.dailiesShotId = b.dataset.crOpen;
    ui.selectedShotId = b.dataset.crOpen;
  })));
}
