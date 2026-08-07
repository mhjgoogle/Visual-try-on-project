// 音频生成 — manual free flow: per-shot 配音 (copy text → web/local TTS →
// upload) plus optional 音乐/音效 slots (CC0 libraries). Local Piper TTS as a
// free AUTOMATIC route is planned behind its own ADR. Feeds 剪辑合成.
import { nx, bindSlots } from "./shared.js";
import { esc } from "../../util/dom.js";

export default {
  type: "audio",
  step: 3,
  stage: "S4 素材制造",
  title: "音频生成",
  icon: "🎵",
  init() {
    return { state: "", uploads: {} };
  },
  render(node, ctx) {
    // Manual flow (免费): voice per draft shot + optional music/SFX slots.
    const draft = ctx.project.draftShots;
    if (draft && draft.length) {
      const up = node.uploads || {};
      const vkey = (s) => (s.slot ? `voice-${s.slot}` : "");
      const canTts = !!(ctx.isConnected && ctx.isConnected());
      const row = (k, label, copySeq) => {
        const player = k && up[k]
          ? `<audio class="aaud" src="${esc(up[k])}" controls preload="none"></audio>`
          : "";
        const tts = copySeq && canTts
          ? `<button class="amini" data-tts="${esc(copySeq)}" title="本地 Piper TTS 自动配音（免费）">🤖</button>`
          : "";
        return `<div class="arow"><span class="alb">${label}</span>${copySeq ? `<button class="amini" data-copy="${esc(copySeq)}" title="复制该镜头文案（用于 TTS）">📋</button>` : ""}${tts}<button class="amini" data-up="${esc(k)}" title="上传音频">⬆</button></div>${player}`;
      };
      const items = draft
        .map((s) => row(vkey(s), `🎤 ${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}`, String(s.sequence)))
        .join("");
      const extras = row("music-main", "🎼 背景音乐（可选 · CC0 曲库）", "") + row("sfx-main", "🔊 音效（可选 · CC0 库）", "");
      const done = draft.filter((s) => vkey(s) && up[vkey(s)]).length;
      const ttsAll = canTts && done < draft.length
        ? `<button class="nrun ghost" data-ttsall${node._ttsBusy ? " disabled" : ""}>${node._ttsBusy ? "自动配音中…" : "🤖 一键自动配音（本地 TTS · 免费）"}</button>`
        : "";
      const foot = done >= draft.length
        ? `<div style="font-size:11px;color:var(--ok);margin:6px 2px 0">✓ 配音 ${done}/${draft.length} · 未锁定</div>${nx([["edit", "剪辑合成"]])}`
        : `<div style="font-size:11px;color:var(--gate);margin:6px 2px 0">手工：📋 文案 → TTS → ⬆ 上传；或 🤖 本地自动（${done}/${draft.length}）</div>${ttsAll}`;
      return `<div>${items}${extras}${foot}</div>`;
    }
    if (node.state === "done") {
      // Connected mode is a placeholder-advance (no real generation, gated);
      // demo mode keeps its pretend-generated ✓.
      if (ctx && ctx.isConnected && ctx.isConnected()) {
        return `<div class="audrow">占位推进 · 未真实生成（待 Gateway）</div>${nx([["edit", "剪辑合成"]])}`;
      }
      return `<div class="audrow ok">✓ 对白配音 · 11 句</div><div class="audrow ok">✓ 背景音乐 · 3 段</div><div class="audrow ok">✓ 音效 · 8 处</div>${nx([["edit", "剪辑合成"]])}`;
    }
    return `<div class="audrow">🎤 对白配音（S4-T04）</div><div class="audrow">🎼 背景音乐（S4-T06）</div><div class="audrow">🔊 音效（S4-T06）</div><button class="nrun" data-run>生成对白/音乐/音效</button>`;
  },
  bind(node, el, ctx) {
    const draft = ctx.project.draftShots;
    if (!draft || !draft.length) return;
    bindSlots(node, el, ctx, {
      accept: "audio/mpeg,audio/wav",
      copiedMsg: "已复制镜头文案 — 用网页/本地 TTS 生成配音后 ⬆ 上传",
      uploadedMsg: "音频已上传",
      getPrompt: (seq) => {
        const s = draft.find((x) => String(x.sequence) === seq);
        return s ? s.description : "";
      },
    });
    // 🤖 automatic voice-over via local Piper TTS (ADR-0043, free, offline)
    const synth = async (s) => {
      const k = `voice-${s.slot}`;
      const url = await ctx.agentTts(`${node.type}-${k}`, s.description);
      node.uploads = node.uploads || {};
      node.uploads[k] = url;
    };
    el.querySelectorAll("[data-tts]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const s = draft.find((x) => String(x.sequence) === b.dataset.tts);
      if (!s || !s.slot || node._ttsBusy) return;
      node._ttsBusy = true;
      ctx.refresh(node);
      try {
        await synth(s);
        ctx.toast("自动配音完成（Piper 本地 · 免费）");
      } catch (err) {
        ctx.toast("自动配音失败：" + err.message);
      } finally {
        node._ttsBusy = false;
        ctx.refresh(node);
        if (ctx.persist) ctx.persist();
      }
    }));
    const all = el.querySelector("[data-ttsall]");
    if (all) all.onclick = async (e) => {
      e.stopPropagation();
      if (node._ttsBusy) return;
      node._ttsBusy = true;
      ctx.refresh(node);
      let okCount = 0;
      try {
        for (const s of draft) {
          const k = `voice-${s.slot}`;
          if (!s.slot || (node.uploads && node.uploads[k])) continue;
          await synth(s); // sequential — piper is CPU-bound
          okCount++;
          ctx.refresh(node);
        }
        ctx.toast(`自动配音完成 · 新增 ${okCount} 段（Piper 本地 · 免费）`);
      } catch (err) {
        ctx.toast(`自动配音中断（已完成 ${okCount} 段）：` + err.message);
      } finally {
        node._ttsBusy = false;
        ctx.refresh(node);
        if (ctx.persist) ctx.persist();
      }
    };
  },
  run(node, ctx) {
    ctx.estimate({
      cmd: "generate_audio · 对白/音乐/音效",
      kind: "音频",
      count: 22,
      p50: 9.2,
      p90: 14.0,
      actual: 9.2,
      label: "已提交 Gateway：音频批量生成",
      after: () => { node.state = "done"; ctx.refresh(node); ctx.markIncoming(node.id, "done"); },
    });
  },
  next: ["edit"],
};
