// BOTTOM of 剧集制作 — 参考素材库（当前 Shot）(TASK-066 §7 / §16).
//
//   参考素材库（当前 Shot）  [搜索人物 / 场景 / 风格 / 动作 / 道具…]
//   类型： 全部 人物 场景 风格 动作 道具 镜头 其它        [⊕ 上传新素材]
//   ┌────────┐┌────────┐┌────────┐ …   each with [+ 加入]
//
// WHAT IT IS, AND WHAT IT IS NOT (§7). Not the Asset Library page — that stays a
// top-level space with its own rail. This is 「当前 Shot 的视觉参考素材检索器」: find an
// existing visual asset and put it on THIS shot in one click. The whole reason it
// earns permanent screen space is that re-uploading a portrait that already exists is
// the single most common waste in this pipeline.
//
// VISUAL CONTEXT ONLY (§16). Dialogue / SFX / Foley / BGM / subtitles are a DIFFERENT
// working context that belongs to 后期制作. They share the Asset Registry underneath,
// but mixing both vocabularies into one strip would make every filter ambiguous. So
// the audio kinds are filtered out here — deliberately, and stated on screen.
//
// A SHOT'S OWN OUTPUT COMES BACK HERE (§7 last line). A generated/uploaded 主帧图 is a
// registered Asset like any other, so it shows up in this search for every OTHER shot
// — which is what makes 「复用」 real rather than aspirational.
//
// PURE PRESENTATION over ctx.assets.library().

import { esc } from "../util/dom.js";
import { ROLE_LABEL } from "../workflow/geninput.js";

/**
 * The type filters. Each maps to the DECLARED asset kinds it covers, so a chip can
 * never mean something different from what the registry holds.
 *
 * `frame` is its own chip because a derived frame is how continuity gets carried
 * between shots, and burying it under 「其它」 would hide the one asset kind whose
 * whole purpose is to be found from a neighbouring shot.
 */
export const TYPES = [
  ["all", "全部", null],
  ["character", "人物", ["character-reference"]],
  ["location", "场景", ["location-reference"]],
  ["style", "风格", ["style-reference", "video-style-reference"]],
  ["motion", "动作", ["motion-reference", "performance-reference"]],
  ["prop", "道具", ["prop-reference"]],
  ["camera", "镜头", ["camera-reference"]],
  ["frame", "帧", ["derived-frame"]],
  ["image", "已生成画面", ["shot-image"]],
  ["other", "其它", ["external-reference"]],
];

/** Kinds this strip will NEVER show — the post-production vocabulary (§16). Listed
 *  rather than derived so adding an audio kind cannot silently leak it in here. */
const AUDIO_KINDS = new Set(["dialogue", "ambience", "sfx", "foley", "vo", "bgm", "shot-mix", "voice-reference"]);

/** Every kind the strip may show, derived from TYPES so a new chip cannot claim a
 *  kind the 「全部」 view does not include. */
const VISUAL_KINDS = new Set(TYPES.flatMap(([, , kinds]) => kinds || []));

/**
 * The view model.
 *
 * @param rows      `ctx.assets.library({type:"all"}).rows`
 * @param boundKeys the reference keys already on this shot (so a row can say 已在用
 *                  instead of offering to add it twice)
 */
export function searchModel(rows, boundKeys, { query = "", type = "all" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const wanted = (TYPES.find(([k]) => k === type) || [])[2] || null;
  const bound = boundKeys instanceof Set ? boundKeys : new Set(boundKeys || []);
  const all = (Array.isArray(rows) ? rows : [])
    // VISUAL only, and only things that can actually be a reference on a shot
    .filter((r) => r.kind && !AUDIO_KINDS.has(r.kind) && VISUAL_KINDS.has(r.kind))
    .map((r) => ({
      key: r.key || null,
      assetId: r.assetId,
      kind: r.kind,
      name: r.name || r.displayName || "",
      version: r.version,
      url: r.url || "",
      domain: r.domain,
      at: r.at || "",
      storageState: r.storageState || "local",
      reusable: r.reusable === true,
      // 加入 needs a `ref-…` chain key: a shot binds a REFERENCE, not a bare asset.
      // A row without one is shown (it is real) but cannot be added, and says so.
      addable: !!r.key && bound.has(r.key) === false,
      bound: !!r.key && bound.has(r.key),
      unaddable: !r.key,
    }));
  const filtered = all.filter((r) => {
    if (wanted && !wanted.includes(r.kind)) return false;
    if (!q) return true;
    return `${r.name} ${ROLE_LABEL[r.kind] || r.kind}`.toLowerCase().includes(q);
  });
  return {
    total: all.length,
    rows: filtered,
    shown: filtered.length,
    query,
    type,
    counts: Object.fromEntries(
      TYPES.map(([k, , kinds]) => [k, kinds ? all.filter((r) => kinds.includes(r.kind)).length : all.length]),
    ),
  };
}

function cardHtml(r) {
  const th = !r.url || r.storageState !== "local"
    ? `<span class="rs-th none" title="字节不在本地（记录仍在）">⃠</span>`
    : r.domain === "videos"
      ? `<video class="rs-th" src="${esc(r.url)}" preload="metadata" muted playsinline></video>`
      : `<img class="rs-th" src="${esc(r.url)}" alt="" loading="lazy">`;
  const act = r.bound
    ? `<span class="chip ok">已在用</span>`
    : r.unaddable
      ? `<span class="chip mute" title="这个资产不是一条参考链，不能直接绑到镜头上">不可绑定</span>`
      : `<button class="btn sm primary" data-rs-add="${esc(r.key)}">＋ 加入</button>`;
  return (
    `<figure class="rs-card${r.bound ? " on" : ""}">` +
    `<button class="rs-open" data-rs-preview="${esc(r.assetId)}" title="预览">${th}</button>` +
    `<figcaption><b>${esc(r.name || ROLE_LABEL[r.kind] || r.kind)}</b>` +
    `<span class="rs-sub">${esc(ROLE_LABEL[r.kind] || r.kind)}` +
    (r.version != null ? ` · v${r.version}` : "") +
    (r.at ? ` · ${esc(String(r.at).slice(0, 10))}` : "") + `</span></figcaption>` +
    `<div class="rs-act">${act}</div>` +
    `</figure>`
  );
}

export function renderRefSearch(ctx, ui, m) {
  const chips = TYPES.map(([k, label]) =>
    `<button class="rs-chip${m.type === k ? " on" : ""}" data-rs-type="${esc(k)}">${esc(label)}` +
    (m.counts[k] ? `<span class="ct">${m.counts[k]}</span>` : "") + `</button>`).join("");
  return (
    `<section class="rs${ui.rsOpen === false ? " collapsed" : ""}">` +
    `<header class="rs-bar">` +
    `<button class="rs-toggle" data-rs-toggle title="${ui.rsOpen === false ? "展开" : "收起"}">` +
    `${ui.rsOpen === false ? "▴" : "▾"}</button>` +
    `<b class="rs-title">参考素材库（当前 Shot）</b>` +
    `<input class="rs-q" type="search" placeholder="搜索人物 / 场景 / 风格 / 动作 / 道具…" value="${esc(m.query)}">` +
    `<span class="push"></span>` +
    `<button class="btn sm" data-rs-upload>⊕ 上传新素材</button>` +
    `</header>` +
    (ui.rsOpen === false
      ? ""
      : `<div class="rs-chips"><span class="lb">类型</span>${chips}` +
        `<span class="rs-note">${m.shown} / ${m.total}</span></div>` +
        (m.rows.length
          ? `<div class="rs-strip">${m.rows.map(cardHtml).join("")}</div>`
          : `<div class="rs-none">${m.total
            ? "没有素材符合当前搜索 / 筛选。"
            : "资产库里还没有视觉参考素材。用「⊕ 上传新素材」，或在故事开发里给人物 / 场景地做基础参考图。"}</div>`) +
        `<div class="rs-foot">只显示视觉素材。对白 / 音效 / 拟音 / BGM / 字幕属于后期制作的资产语境，` +
        `底层是同一个 Asset Registry，但不在这里混在一起。镜头自己生成或上传的主帧图也会进资产库，` +
        `所以别的镜头以后能在这里搜到复用。</div>`) +
    `</section>`
  );
}

export function bindRefSearch(root, ctx, ui, render, { shotId } = {}) {
  const on = (q, fn) => { const el = root.querySelector(q); if (el) el.onclick = (ev) => { ev.stopPropagation(); fn(el); }; };
  const all = (q, fn) =>
    root.querySelectorAll(q).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));

  on("[data-rs-toggle]", () => { ui.rsOpen = ui.rsOpen === false; render(); });
  const q = root.querySelector(".rs-q");
  if (q) {
    // no re-render per keystroke: that would move the caret out of the field the
    // creator is typing in (the same rule ui/fieldsync.js exists for)
    q.oninput = () => { ui.rsQuery = q.value; };
    q.onsearch = () => { ui.rsQuery = q.value; render(); };
    q.onkeydown = (ev) => { if (ev.key === "Enter") { ui.rsQuery = q.value; render(); } };
  }
  all("[data-rs-type]", (el) => { ui.rsType = el.dataset.rsType; render(); });
  all("[data-rs-add]", (el) => {
    if (!shotId) { ctx.toast("先选一个镜头"); return; }
    if (ctx.shot.addReference(shotId, el.dataset.rsAdd)) {
      ctx.toast("已加入这一镜——左侧参考配置和中央关系图都跟着更新了");
    } else {
      ctx.toast("这个参考已经绑在这一镜上了");
    }
    render();
  });
  all("[data-rs-preview]", (el) => {
    if (ctx.lightbox) ctx.lightbox(el.dataset.rsPreview);
  });
  on("[data-rs-upload]", async () => {
    if (!shotId) { ctx.toast("先选一个镜头"); return; }
    // Upload lands as a CHARACTER reference by default only when the creator says so;
    // the strip cannot know the kind, so it asks — an upload filed under the wrong
    // kind makes every filter here lie about it afterwards.
    const roles = [
      ["character-reference", "人物参考"], ["location-reference", "场景参考"],
      ["prop-reference", "道具参考"], ["style-reference", "风格参考"],
      ["motion-reference", "运动参考"], ["camera-reference", "机位参考"],
      ["performance-reference", "表演参考"], ["video-style-reference", "视频风格参考"],
    ];
    const pick = window.prompt(
      `这份素材是什么？输入编号：\n${roles.map(([, l], i) => `${i + 1}. ${l}`).join("\n")}`,
      "1",
    );
    if (pick == null) return;
    const hit = roles[Number(pick) - 1];
    if (!hit) { ctx.toast("没有这个编号，没有上传任何文件"); return; }
    const key = await ctx.episode.uploadReference(shotId, hit[0]);
    if (key) ctx.toast(`已登记为「${hit[1]}」并绑到这一镜`);
    render();
  });
}
