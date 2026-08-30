// 3D 导演台（TASK-123 / ADR-0094）。
//
// 产品负责人 2026-08-30：「帮我在剧集制作里面加入 3D 导演台让我能做白膜视频」。
//
// 两块：**左边俯视图**摆走位与机位（拖着走，不填坐标），**右边镜头里**是这一刻
// 真正拍到的画面。中间一条时间线：拖它就在起幅与落幅之间走，按「录白膜」把这一段
// 录成视频。
//
// 白膜就是白膜：没有材质、没有贴图、没有光效。它回答的是**走位与机位**，
// 长相那一步在镜头制作里（ADR-0094 决策 2 的代价，写在那里）。

import { esc } from "../util/dom.js";
import { head } from "./shell.js";
import * as bl from "../workflow/blocking.js";

export function blockingModel(pd, shotId, blocking) {
  const draft = (pd && pd.draftShots) || [];
  const shot = draft.find((s) => s && s.shotId === shotId) || null;
  return {
    shot,
    shotId,
    blocking,
    actors: blocking ? bl.visibleActors(blocking) : [],
    props: blocking ? bl.visibleProps(blocking) : [],
    ready: blocking ? bl.readiness(blocking) : { canRecord: false, gaps: ["还没有选镜头"], still: false },
    takes: blocking ? blocking.takes : [],
  };
}

function numRow(label, key, value, step = "0.1", extra = "") {
  return (
    `<label class="bk-f"><span>${esc(label)}</span>` +
    `<input type="number" step="${step}" value="${value}" data-bk-num="${esc(key)}" ${extra}></label>`
  );
}

/** 左栏：场上有谁、在哪、机位怎么摆。**填的是导演会说的词**，不是矩阵。 */
function panel(m) {
  const b = m.blocking;
  const cam = b.camera;
  const lensOpts = (cur) =>
    bl.LENSES.map(
      (mm) => `<option value="${mm}"${Math.round(cur) === mm ? " selected" : ""}>${mm}mm</option>`,
    ).join("");
  return (
    `<div class="bk-panel">` +
    `<div class="bk-sec">场地与时长</div>` +
    `<div class="bk-grid">` +
    numRow("场地（米）", "stage", b.stage, "1") +
    numRow("时长（秒）", "duration", b.duration, "0.5") +
    `</div>` +

    `<div class="bk-sec">演员<button class="btn ghost sm" data-bk-add-actor="1">＋ 加一个</button></div>` +
    (m.actors.length
      ? m.actors
          .map(
            (a) =>
              `<div class="bk-row" data-bk-actor="${esc(a.id)}">` +
              `<input class="bk-name" value="${esc(a.name)}" data-bk-actor-name="${esc(a.id)}">` +
              `<span class="meta">身高 ${a.height.toFixed(2)}m · ` +
              (a.from.x === a.to.x && a.from.z === a.to.z ? "站定" : "有走位") +
              `</span>` +
              `<button class="btn ghost sm danger" data-bk-del-actor="${esc(a.id)}">✕</button></div>`,
          )
          .join("")
      : `<div class="bk-empty">场上还没有人 —— 加一个，然后在左边的俯视图里拖他。</div>`) +

    `<div class="bk-sec">道具 / 布景<button class="btn ghost sm" data-bk-add-prop="1">＋ 加一个</button></div>` +
    (m.props.length
      ? m.props
          .map(
            (p) =>
              `<div class="bk-row" data-bk-prop="${esc(p.id)}">` +
              `<input class="bk-name" value="${esc(p.name)}" data-bk-prop-name="${esc(p.id)}">` +
              `<span class="meta">${p.w}×${p.d}×${p.h}m</span>` +
              `<button class="btn ghost sm danger" data-bk-del-prop="${esc(p.id)}">✕</button></div>`,
          )
          .join("")
      : `<div class="bk-empty">还没有道具。吧台、桌子、门框 —— 挡视线的东西最值得先摆。</div>`) +

    `<div class="bk-sec">机位</div>` +
    `<div class="bk-cam">` +
    `<div class="bk-camcol"><div class="t">起幅</div>` +
    numRow("高度（米）", "cam.from.y", cam.from.y, "0.1") +
    `<label class="bk-f"><span>焦距</span><select data-bk-lens="from">${lensOpts(cam.from.lens)}</select></label>` +
    `</div>` +
    `<div class="bk-camcol"><div class="t">落幅</div>` +
    numRow("高度（米）", "cam.to.y", cam.to.y, "0.1") +
    `<label class="bk-f"><span>焦距</span><select data-bk-lens="to">${lensOpts(cam.to.lens)}</select></label>` +
    `</div></div>` +
    `<div class="bk-hint">俯视图里拖 <b>◉</b> 是机位、拖 <b>+</b> 是它看向哪儿；` +
    `橙色是起幅，蓝色是落幅。</div>` +
    `</div>`
  );
}

export function renderBlockingWs(ctx, ui) {
  const pd = ctx.prodData();
  const shotId = ui.selectedShotId || null;
  if (!shotId) {
    return (
      head("3D 导演台", "本集") +
      `<div class="bk-none">先在「分镜」里选一个镜头 —— 白膜是**这一镜**的走位与机位。</div>`
    );
  }
  const blocking = ctx.blocking ? ctx.blocking.of(shotId) : null;
  if (!blocking) {
    return head("3D 导演台", "本集") + `<div class="bk-none">这个项目还没有白膜的数据模型。</div>`;
  }
  const m = blockingModel(pd, shotId, blocking);
  const t = typeof ui.bkT === "number" ? ui.bkT : 0;
  const rec = ui.bkRecording;
  return (
    head("3D 导演台", m.shot ? `${esc(m.shot.title || m.shotId)}` : "本集") +
    `<div class="bk-note">白膜只回答两件事：<b>谁从哪走到哪</b>、<b>镜头怎么拍</b>。` +
    `长相不在这一步 —— 那是镜头制作。</div>` +
    `<div class="bk-wrap">` +
    `<div class="bk-left">` +
    `<div class="bk-topview"><canvas data-bk-top width="520" height="520"></canvas>` +
    `<div class="bk-scale">一格 1 米</div></div>` +
    panel(m) +
    `</div>` +
    `<div class="bk-right">` +
    `<div class="bk-view"><canvas data-bk-view width="960" height="540"></canvas></div>` +
    `<div class="bk-time">` +
    `<button class="btn sm" data-bk-play="1">${ui.bkPlaying ? "⏸ 暂停" : "▶ 预览"}</button>` +
    `<input class="bk-slider" type="range" min="0" max="1000" value="${Math.round(t * 1000)}" data-bk-t="1">` +
    `<span class="meta">${(t * m.blocking.duration).toFixed(1)}s / ${m.blocking.duration.toFixed(1)}s</span>` +
    `</div>` +
    `<div class="bk-actions">` +
    (rec
      ? `<button class="btn sm danger" data-bk-stop="1">■ 停止录制（${esc(String(rec))}）</button>`
      : `<button class="btn" data-bk-record="1"${m.ready.canRecord ? "" : " disabled"}>● 录白膜</button>`) +
    (m.ready.canRecord
      ? m.ready.still
        ? `<span class="meta">全程静止 —— 录出来会是一张不动的画面</span>`
        : ""
      : `<span class="meta">${esc(m.ready.gaps.join(" · "))}</span>`) +
    `</div>` +
    (m.takes.length
      ? `<div class="bk-takes"><div class="bk-sec">已录的白膜（${m.takes.length}）</div>` +
        m.takes
          .slice()
          .reverse()
          .map(
            (tk) =>
              `<div class="bk-row"><span class="meta">${esc(tk.at.slice(0, 19).replace("T", " "))}` +
              ` · ${tk.seconds.toFixed(1)}s</span>` +
              `<button class="btn ghost sm" data-bk-open-take="${esc(tk.assetId)}">在资产库里看</button></div>`,
          )
          .join("") +
        `</div>`
      : "") +
    `</div></div>`
  );
}

/* --- 俯视图：拖着摆位（这才是导演台该有的操作）------------------------------ */

/** 世界坐标 ↔ 俯视图像素。**一个换算，两个方向**，拖动和绘制不会各算各的。 */
export function topMapper(stage, size) {
  const scale = size / stage;
  return {
    toPx: (p) => ({ x: size / 2 + p.x * scale, y: size / 2 + p.z * scale }),
    toWorld: (px, py) => ({ x: (px - size / 2) / scale, z: (py - size / 2) / scale }),
    scale,
  };
}

/** 画俯视图。用 2D canvas —— 它就是一张平面图，不需要 3D。 */
export function drawTop(canvas, b, t) {
  const g = canvas.getContext("2d");
  if (!g) return false;
  const size = canvas.width;
  const map = topMapper(b.stage, size);
  const shot = bl.sampleAt(b, t);
  g.fillStyle = "#0e1014";
  g.fillRect(0, 0, size, size);

  // 一米一格
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.lineWidth = 1;
  for (let i = -b.stage / 2; i <= b.stage / 2; i += 1) {
    const a = map.toPx({ x: i, z: -b.stage / 2 });
    const z = map.toPx({ x: i, z: b.stage / 2 });
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(z.x, z.y); g.stroke();
    const c = map.toPx({ x: -b.stage / 2, z: i });
    const d = map.toPx({ x: b.stage / 2, z: i });
    g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke();
  }

  // 道具
  for (const p of shot.props) {
    const c = map.toPx(p.at);
    g.fillStyle = "rgba(140,150,165,.55)";
    g.fillRect(c.x - (p.w * map.scale) / 2, c.y - (p.d * map.scale) / 2, p.w * map.scale, p.d * map.scale);
  }

  // 演员：起点空心、终点空心、此刻实心
  for (const a of shot.actors) {
    if (a.moves) {
      const f = map.toPx(a.from);
      const to = map.toPx(a.to);
      g.strokeStyle = "rgba(110,168,254,.7)";
      g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(to.x, to.y); g.stroke();
      g.setLineDash([]);
      for (const [pt, label] of [[f, "起"], [to, "落"]]) {
        g.strokeStyle = "rgba(110,168,254,.8)";
        g.beginPath(); g.arc(pt.x, pt.y, 9, 0, Math.PI * 2); g.stroke();
        g.fillStyle = "rgba(110,168,254,.9)";
        g.font = "10px system-ui";
        g.fillText(label, pt.x - 5, pt.y + 3);
      }
    }
    const c = map.toPx(a.at);
    g.fillStyle = "#e8eaee";
    g.beginPath(); g.arc(c.x, c.y, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#0e1014";
    g.font = "600 10px system-ui";
    g.fillText(a.name.slice(0, 2), c.x - 9, c.y + 4);
  }

  // 机位：起幅橙、落幅蓝；实线连到它看向的那个点
  for (const [which, color] of [["from", "#e0a33e"], ["to", "#6ea8fe"]]) {
    const cam = b.camera[which];
    const at = map.toPx(cam.at);
    const look = map.toPx(cam.look);
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(at.x, at.y); g.lineTo(look.x, look.y); g.stroke();
    g.fillStyle = color;
    g.beginPath(); g.arc(at.x, at.y, 8, 0, Math.PI * 2); g.fill();
    g.strokeStyle = color;
    g.beginPath(); g.arc(look.x, look.y, 5, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(look.x - 4, look.y); g.lineTo(look.x + 4, look.y);
    g.moveTo(look.x, look.y - 4); g.lineTo(look.x, look.y + 4); g.stroke();
  }
  return true;
}

/** 点在哪个可拖的东西上（半径按屏幕像素算，拖起来才跟手）。 */
export function hitTest(b, px, py, size) {
  const map = topMapper(b.stage, size);
  const near = (p, r = 12) => {
    const c = map.toPx(p);
    return Math.hypot(c.x - px, c.y - py) <= r;
  };
  for (const which of ["from", "to"]) {
    if (near(b.camera[which].look)) return { kind: "camLook", which };
    if (near(b.camera[which].at)) return { kind: "camAt", which };
  }
  for (const a of bl.visibleActors(b)) {
    if (near(a.to)) return { kind: "actorTo", id: a.id };
    if (near(a.from)) return { kind: "actorFrom", id: a.id };
  }
  for (const p of bl.visibleProps(b)) {
    if (near(p.at, 14)) return { kind: "prop", id: p.id };
  }
  return null;
}
