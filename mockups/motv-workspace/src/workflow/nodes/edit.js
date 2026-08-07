// 剪辑合成 — assembly → rough/fine cut → mix → subtitle/grade → master candidate
// (S5). Local FFmpeg, so NO paid preflight (only paid Provider gen needs one).
// With a draft + backend, "真实合成" runs REAL ffmpeg over the uploaded shot
// videos (+ voice/music) and returns a playable versioned MP4 (ADR-0044).
import { nx } from "./shared.js";
import { esc } from "../../util/dom.js";

export default {
  type: "edit",
  step: 4,
  stage: "S5 装配后期",
  title: "剪辑合成",
  icon: "✂",
  init() {
    return { state: "", prog: 0, finals: [] };
  },
  render(node, ctx) {
    const draft = ctx.project.draftShots;
    const canReal = !!(draft && draft.length && ctx.isConnected && ctx.isConnected());
    if (canReal) {
      const media = ctx.collectMedia ? ctx.collectMedia() : { video: {}, audio: {} };
      const rows = draft
        .map((s) => {
          const v = s.slot && media.video[s.slot];
          const a = s.slot && media.audio[`voice-${s.slot}`];
          return `<div class="arow"><span class="alb">${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}</span><span class="amini" style="cursor:default">${v ? "🎞✓" : "🎞–"}</span><span class="amini" style="cursor:default">${a ? "🎤✓" : "🎤–"}</span></div>`;
        })
        .join("");
      const ready = draft.filter((s) => s.slot && media.video[s.slot]).length;
      const allReady = ready >= draft.length;
      const last = node.finals && node.finals.length ? node.finals[node.finals.length - 1] : null;
      const player = last
        ? `<video class="afinal" src="${esc(last)}" controls preload="metadata"></video><div style="font-size:11px;color:var(--ok);margin:4px 2px">✓ 成片 v${node.finals.length} · 本地 FFmpeg · 草稿级 720p</div>${nx([["master", "成片/质检"]])}`
        : "";
      const btn = node._busy
        ? `<button class="nrun" disabled>FFmpeg 合成中…（约 ${draft.length * 4}s）</button>`
        : `<button class="nrun" data-compose${allReady ? "" : " disabled"}>${last ? "重新合成（新版本）" : "真实合成（本地 FFmpeg · 免费）"}</button>`;
      const hint = allReady
        ? `<div style="font-size:11px;color:var(--text-faint);margin:6px 2px">${ready}/${draft.length} 镜头视频就绪 · 配音/音乐可选</div>`
        : `<div style="font-size:11px;color:var(--gate);margin:6px 2px">还差 ${draft.length - ready} 个镜头视频（去视频节点 ⬆ 上传）</div>`;
      return `<div>${rows}${hint}${btn}${player}</div>`;
    }
    if (node.state === "gen") {
      return `<div class="tl"><span>🎞</span><span class="tk v"><i></i></span></div><div class="tl"><span>🔊</span><span class="tk a"><i></i></span></div><div class="genprog"><div class="pb"><i style="width:${node.prog}%"></i></div><span class="pc">合成中 ${node.prog}%</span></div>`;
    }
    if (node.state === "done") {
      return `<div class="filmprev"><div class="pl"></div><div class="lb mono">master v1 · 1080p</div></div><div style="font-size:11px;color:var(--text-faint);margin-bottom:6px">粗剪→精剪→混音→字幕/调色 · master candidate v1</div>${nx([["master", "成片/质检"]])}`;
    }
    return `<div class="tl"><span>🎞</span><span class="tk v"><i></i></span><span>11</span></div><div class="tl"><span>🔊</span><span class="tk a"><i></i></span><span>混音</span></div><div style="font-size:11px;color:var(--text-faint);margin:6px 2px">本地 FFmpeg 合成 · 不产生 Provider 费用</div><button class="nrun" data-run>合成成片（FFmpeg）</button>`;
  },
  bind(node, el, ctx) {
    const btn = el.querySelector("[data-compose]");
    if (!btn) return;
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (node._busy) return;
      const draft = ctx.project.draftShots || [];
      const media = ctx.collectMedia ? ctx.collectMedia() : { video: {}, audio: {} };
      const spec = {
        shots: draft.map((s) => ({
          video: `video-${s.slot}`,
          ...(media.audio[`voice-${s.slot}`] ? { voice: `audio-voice-${s.slot}` } : {}),
        })),
        ...(media.audio["music-main"] ? { music: "audio-music-main" } : {}),
      };
      node._busy = true;
      ctx.refresh(node);
      ctx.markIncoming(node.id, "active");
      try {
        const res = await ctx.composeFinal(spec);
        node.finals = node.finals || [];
        node.finals.push(res.url);
        node.state = "done";
        ctx.toast(`成片已合成 · final-cut v${res.version}（${res.shots} 镜头${res.music ? " + 音乐" : ""} · 本地 FFmpeg · 免费）`);
        ctx.markIncoming(node.id, "done");
      } catch (err) {
        ctx.toast("合成失败：" + err.message);
        ctx.markIncoming(node.id, "");
      } finally {
        node._busy = false;
        ctx.refresh(node);
        if (ctx.persist) ctx.persist();
      }
    };
  },
  run(node, ctx) {
    if (node.state === "done") { ctx.toast("预览成片 · master candidate v1（原型）"); return; }
    node.state = "gen";
    node.prog = 8;
    ctx.refresh(node);
    ctx.markIncoming(node.id, "active");
    const t = setInterval(() => {
      node.prog += Math.floor(Math.random() * 16) + 7;
      if (node.prog >= 100) {
        node.prog = 100;
        clearInterval(t);
        node.state = "done";
        ctx.refresh(node);
        ctx.markIncoming(node.id, "done");
        ctx.toast("成片已合成 · master candidate v1（S5，本地 FFmpeg，零 Provider 费用）");
      } else {
        ctx.refresh(node);
      }
    }, 380);
  },
  next: ["master"],
};
