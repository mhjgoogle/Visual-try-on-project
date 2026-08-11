// Reusable studio components — SceneStrip · ShotList · MediaHero ·
// VariantGallery · ReferenceCard · Lineage.
//
// Every shot-centric workspace (分镜 / 画面 / 视频) composes THESE rather than
// re-implementing its own cards, so the three screens stay visually identical
// where they show the same thing. Pure functions over the view-models exported
// by storyboard.js; no state, no DOM access, no domain writes.
import { esc } from "../util/dom.js";
import { mediaBox } from "./shell.js";

export const nn = (seq) => String(seq).padStart(2, "0");

/** Character / location context chips for a scene. */
export function refChips(refs) {
  if (!refs) return "";
  const loc = refs.location
    ? `<span class="chip">📍 ${esc(refs.location.name)}${refs.location.stateName ? ` · ${esc(refs.location.stateName)}` : ""}</span>`
    : "";
  const chars = refs.characters
    .map((c) => `<span class="chip">👤 ${esc(c.name)}${c.stateName ? ` · ${esc(c.stateName)}` : ""}</span>`)
    .join("");
  return loc + chars;
}

/** SceneStrip — the horizontal scene rail above a shot workspace. Each card
 *  previews its own shots' current frames (up to 4), so a scene reads as
 *  footage rather than a title. */
export function renderSceneStrip(scenes, selectedSceneId) {
  if (!scenes.length) return "";
  return (
    `<div class="scenestrip">` +
    scenes
      .map((sc) => {
        const strip = sc.shots
          .slice(0, 4)
          .map((s) => (s.thumb ? `<img src="${esc(s.thumb)}" alt="" loading="lazy">` : `<span class="ph"></span>`))
          .join("") || `<span class="ph"></span>`;
        const done = sc.shots.filter((s) => s.thumb).length;
        return (
          `<button class="scenecard${sc.sceneId === selectedSceneId ? " on" : ""}" data-scene="${esc(sc.sceneId)}">` +
          `<span class="strip">${strip}</span>` +
          `<span class="bd"><span class="nm">${esc(sc.title)}</span>` +
          `<span class="rw">${refChips(sc.refs)}</span>` +
          `<span class="rw"><span class="chip mute">${sc.shots.length} 镜</span>` +
          `<span class="chip${done === sc.shots.length && done ? " ok" : ""}">画面 ${done}/${sc.shots.length}</span></span>` +
          `</span></button>`
        );
      })
      .join("") +
    `</div>`
  );
}

/** ShotList — the vertical, thumbnail-led shot rail. Grouped by scene so the
 *  creator never loses the Scene › Shot hierarchy. */
export function renderShotList(scenes, unassigned, selectedShotId) {
  const item = (c) => {
    if (c.dangling) {
      return (
        `<div class="shotitem dangling"><span class="th">${mediaBox("", { missing: "", icon: "⚠" })}</span>` +
        `<span class="bd"><span class="nm">不在当前草稿</span><span class="meta">${esc(c.shotId)}</span></span></div>`
      );
    }
    return (
      `<button class="shotitem${c.shotId === selectedShotId ? " on" : ""}" data-shot="${esc(c.shotId || "")}">` +
      `<span class="th">${mediaBox(c.thumb, { missing: "", icon: "🎞" })}</span>` +
      `<span class="bd"><span class="nm"><span class="n">${esc(nn(c.seq))}</span>${esc(c.title)}</span>` +
      `<span class="rw">` +
      (c.duration != null ? `<span class="chip mute">${esc(String(c.duration))}s</span>` : "") +
      (c.hasVideo ? `<span class="chip ok">▶ 视频</span>` : "") +
      (c.unresolved ? `<span class="chip bad">⚠ 未解析</span>` : "") +
      `</span></span></button>`
    );
  };
  const blocks = scenes
    .map(
      (sc) =>
        `<div class="stack" style="gap:var(--s1)"><div class="lab" style="margin:var(--s2) 0 0">${esc(sc.title)}</div>` +
        (sc.shots.map(item).join("") || `<div class="meta">（空场景）</div>`) +
        `</div>`,
    )
    .join("");
  const pool = unassigned && unassigned.length
    ? `<div class="stack" style="gap:var(--s1)"><div class="lab" style="margin:var(--s2) 0 0">未归组</div>${unassigned.map(item).join("")}</div>`
    : "";
  return `<div class="shotlist">${blocks}${pool}</div>`;
}

/** MediaHero — the large current-media surface.
 *  `poster` is the shot's current IMAGE: for a video hero it is the recorded
 *  first frame, so the surface stays readable before playback and honest about
 *  where the frame came from. */
export function renderHero({ url, kind = "image", poster = "", title = "", badges = [], right = [], missing = "还没有画面" }) {
  const media = !url
    ? mediaBox("", { missing, icon: kind === "video" ? "▶" : "🎞" })
    : kind === "video"
      ? `<video src="${esc(url)}" ${poster ? `poster="${esc(poster)}"` : ""} controls preload="metadata"></video>`
      : `<img class="media" src="${esc(url)}" alt="${esc(title)}">`;
  const bl = badges.length ? `<span class="badge">${badges.join("")}</span>` : "";
  const br = right.length ? `<span class="badge2">${right.join("")}</span>` : "";
  const foot = title ? `<span class="foot"><span class="ttl">${esc(title)}</span></span>` : "";
  return `<div class="herobox">${media}${bl}${br}${foot}</div>`;
}

/** VariantGallery — thumbnail cards for one media chain. `kind` drives the
 *  action verbs; `poster` supplies a video card's frame. */
export function renderVariantGrid(kind, slot, v, posterFor) {
  if (!v.list.length) {
    return `<div class="meta">（还没有${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}变体）</div>`;
  }
  return (
    `<div class="vgrid">` +
    v.list
      .map((r) => {
        const poster = posterFor ? posterFor(r) : "";
        const media = kind === "video"
          ? (poster
              ? `<img class="media" src="${esc(poster)}" alt="">`
              : `<video class="media" src="${esc(r.url)}" muted preload="metadata"></video>`)
          : `<img class="media" src="${esc(r.url)}" alt="" loading="lazy">`;
        return (
          `<button class="vcard${r.current ? " on" : ""}" ${r.current ? "" : `data-setcur="${kind}" data-slot="${esc(slot)}" data-v="${r.version}"`}>` +
          media +
          `<span class="bd"><span class="vn">${kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio"} v${r.version}` +
          (r.current ? `<span class="cur">✓ 当前</span>` : "") + `</span>` +
          `<span class="og">${esc(r.origin || "")}</span></span></button>`
        );
      })
      .join("") +
    `</div>`
  );
}

/** Variant tabs across image / video / audio / history for one shot. */
export function renderVariantTabs(active, counts) {
  const t = (k, label) =>
    `<button class="vtab${k === active ? " on" : ""}" data-vtab="${k}">${esc(label)}` +
    (counts[k] != null ? `<span class="ct">${counts[k]}</span>` : "") +
    `</button>`;
  return (
    `<div class="vtabs">${t("image", "画面")}${t("video", "视频")}${t("audio", "配音")}${t("history", "生成记录")}</div>`
  );
}

/** ReferenceCard column — the scene's characters and location, visually. */
export function renderRefCards(scene, portraitFor) {
  if (!scene) {
    return (
      `<div class="lab">参考</div>` +
      `<div class="meta">该镜头未归入场景 — 在「剧集」把镜头归入场景后，这里显示出场角色与场景地。</div>`
    );
  }
  const card = (icon, name, state, url) =>
    `<div class="refcard">` +
    (url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<span class="ph">${icon}</span>`) +
    `<span class="bd"><span class="nm">${esc(name)}</span>` +
    (state ? `<span class="rw"><span class="chip">${esc(state)}</span></span>` : "") +
    `</span></div>`;
  const chars = scene.characters
    .map((c) => card("👤", c.name, c.stateName, portraitFor ? portraitFor("c", c.characterId) : ""))
    .join("");
  const loc = scene.location
    ? card("📍", scene.location.name, scene.location.stateName, portraitFor ? portraitFor("l", scene.location.locationId) : "")
    : "";
  return (
    (chars ? `<div><div class="lab">出场角色</div><div class="refs">${chars}</div></div>` : "") +
    (loc ? `<div><div class="lab">场景地</div><div class="refs">${loc}</div></div>` : "") +
    (!chars && !loc ? `<div class="meta">该场景还没有设定出场角色 / 场景地。</div>` : "")
  );
}

/**
 * The image a VIDEO may legitimately be shown with — PER VERSION.
 *
 * Two records can answer this, and they are not interchangeable:
 *   · the Generation that produced THAT version names its input image. This is
 *     version-exact and is always preferred.
 *   · `firstFrames[slot]` is slot-level and overwritten at each launch, so the
 *     only take it can describe is the NEWEST one. It may stand in for that
 *     version and nothing else — using it for every version, or for whichever
 *     version happens to be selected, showed an older take as having come from
 *     an image that did not exist when it was made.
 * The shot's current image is never a substitute for either. Unrecorded → ""
 * (the caller says so rather than drawing a source that did not produce this).
 */
/** The version of the video currently selected for this shot, or null. */
export function curVideoVersion(d) {
  const cur = d && d.videos && d.videos.list.find((r) => r.current);
  return cur ? cur.version : null;
}

/** The NEWEST video version in the shot's chain, or null. */
function newestVideoVersion(d) {
  const list = (d && d.videos && d.videos.list) || [];
  return list.reduce((best, r) => (best == null || r.version > best ? r.version : best), null);
}

export function videoSourceFrame(d, version) {
  if (!d) return "";
  if (version != null) {
    const src = d.videoSources ? d.videoSources[version] : null;
    if (src && src.url) return src.url;
    if (newestVideoVersion(d) !== version) return ""; // only the newest take may borrow the slot record
  }
  return d.firstFrame && d.firstFrame.url ? d.firstFrame.url : "";
}

/** Lineage — Image v3 → Video v2, drawn from the RECORDED first frame. Never
 *  inferred: an unrecorded source says so and draws no chain. */
export function renderLineage(d) {
  const curImg = d.images.list.find((r) => r.current);
  const curVid = d.videos.list.find((r) => r.current);
  if (!curImg && !curVid) return "";
  const node = (label, sub, url, active) =>
    `<span class="lnode${active ? " active" : ""}">` +
    (url ? `<img src="${esc(url)}" alt="">` : "") +
    `<span class="tx"><b>${esc(label)}</b><span>${esc(sub)}</span></span></span>`;
  // no video yet → state the current image only; there is no chain to draw
  if (!curVid) {
    return (
      `<div class="lineage">${node(`Image v${curImg.version}`, curImg.origin || "", curImg.url, true)}` +
      `<span class="chip mute push">还没有视频</span></div>`
    );
  }
  // A video exists: its source is what THIS version's Generation recorded, and
  // only failing that the slot-level first frame (which describes the current
  // take). Either way it is a record — never the shot's current image.
  const proven = d.videoSources ? d.videoSources[curVid.version] : null;
  const ff = proven || (newestVideoVersion(d) === curVid.version ? d.firstFrame : null);
  if (!ff) {
    return (
      `<div class="lineage">${node(`Video v${curVid.version}`, curVid.origin || "", "", true)}` +
      `<span class="chip gate push">首帧来源未记录 — 不推断来源画面</span></div>`
    );
  }
  return (
    `<div class="lineage">` +
    node(`Image v${ff.version}`, `${ff.origin || ""} · 已记录首帧`, ff.url, false) +
    `<span class="arrow">→</span>` +
    node(`Video v${curVid.version}`, curVid.origin || "", ff.url, true) +
    (curImg && curImg.version !== ff.version
      ? `<span class="chip gate push">当前画面已切到 v${esc(String(curImg.version))} — 与本视频的首帧不同</span>`
      : `<span class="chip ok push">首帧：资产 v${esc(String(ff.version))}</span>`) +
    `</div>`
  );
}

/** Compact shot metadata — the read view. Fields the creator actually directs
 *  with, never full-width form rows. */
export function renderShotMeta(shot) {
  const kv = (k, v, cls = "") => (v ? `<div class="kv ${cls}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>` : "");
  return (
    `<div class="shotmeta">` +
    kv("景别", shot.shotSize || "未定") +
    kv("角度", shot.angle || "未定") +
    kv("时长", `${shot.duration}s`) +
    kv("情绪", shot.emotion || "未定") +
    kv("运镜", shot.cameraMotion, "span2") +
    kv("动作", shot.action, "span2") +
    kv("画面内容", shot.description, "full") +
    (shot.dialogue ? `<div class="kv full"><span class="k">台词</span><span class="v dlg">「${esc(shot.dialogue)}」</span></div>` : "") +
    `</div>`
  );
}
