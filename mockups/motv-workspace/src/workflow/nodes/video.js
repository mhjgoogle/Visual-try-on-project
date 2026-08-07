// 视频生成 — manual free flow (copy prompt → generate in a web tool → upload)
// per draft shot, or the automatic PAID MiniMax route (batch/single) via the
// pre-generation budget preflight before any spend.
import { nx, bindSlots } from "./shared.js";
import { esc } from "../../util/dom.js";

const SINGLE_SHOTS = ["01", "02", "03", "04", "05", "06"];

export default {
  type: "video",
  step: 3,
  stage: "S4 素材制造",
  title: "视频生成",
  icon: "▶",
  init() {
    return { state: "", pickSingle: false, uploads: {} };
  },
  render(node, ctx) {
    // Manual flow (免费): one slot per draft shot — 📋 copy a video prompt for
    // Gemini 動画/Hailuo web (free tiers), ⬆ upload the resulting clip.
    const draft = ctx.project.draftShots;
    if (draft && draft.length) {
      const up = node.uploads || {};
      const key = (s) => s.slot || "";
      const ops = ctx.paidOps || {};
      const items = draft
        .map((s) => {
          const k = key(s);
          const thumb = k && up[k]
            ? `<video class="athumb" src="${esc(up[k])}" muted preload="metadata"></video>`
            : `<span class="aph">无片</span>`;
          // 生成情况: paid-op status projection for this shot (read-only)
          const op = ops[`shot-${s.sequence}`];
          const st = op
            ? op.status === "committed"
              ? `<span style="font-size:10px;color:var(--ok)" title="已付费 ${esc(op.quote || "")} · ${esc(op.operation_id || "")}">✓已付费</span>`
              : `<span style="font-size:10px;color:var(--gate)" title="${esc(op.status || "")}">⏳${esc(op.status || "生成中")}</span>`
            : "";
          return `<div class="arow">${thumb}<span class="alb">${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}</span>${st}<button class="amini" data-copy="${esc(String(s.sequence))}" title="复制该镜头的视频提示词">📋</button><button class="amini" data-up="${esc(k)}" title="上传该镜头的视频">⬆</button></div>`;
        })
        .join("");
      const done = draft.filter((s) => key(s) && up[key(s)]).length;
      // The automatic route stays available alongside the manual one: batch
      // data-run keeps its pre-existing behavior (PAID → per-shot-only refusal
      // toast; connected non-paid → placeholder-advance), and PAID adds the
      // per-shot real Gateway picker.
      // Paid picker is built from the DRAFT itself (every shot, not a fixed
      // 01-06 list); a shot whose slot already holds a clip is marked ✓已有 —
      // clicking it explains the anti-double-pay guard instead of hitting it.
      const pick = node.pickSingle
        ? `<div class="shotpick">${draft.map((s) => {
            const nn = String(s.sequence).padStart(2, "0");
            const has = s.slot && up[s.slot];
            return `<button data-shot="${esc(nn)}"${has ? ' data-has="1"' : ""}>镜头 ${esc(nn)}${has ? " ✓已有" : ""}</button>`;
          }).join("")}</div>`
        : "";
      const paidBtns = ctx.isPaid && ctx.isPaid()
        ? `<div class="vbtns"><button class="nrun ghost" data-run${node._batchBusy ? " disabled" : ""}>${node._batchBusy ? esc(node._batchMsg || "批量生成中…") : "一键批量生成（付费 · 总额确认）"}</button><button class="nrun ghost" data-single>单镜头（MiniMax 付费）▾</button></div>${pick}`
        : `<div class="vbtns"><button class="nrun ghost" data-run>批量生成（自动 · 占位）</button></div><div style="font-size:10.5px;color:var(--text-faint);margin-top:4px">真实自动：MiniMax 付费（约 $0.28/6s）· 需 --enable-paid</div>`;
      const complete = done >= draft.length || node.state === "done";
      const foot = complete
        ? `<div style="font-size:11px;color:var(--ok);margin:6px 2px 0">${done >= draft.length ? `✓ 手工视频 ${done}/${draft.length}` : "占位推进 · 未真实生成"} · 未锁定</div>${nx([["edit", "剪辑合成"]])}`
        : `<div style="font-size:11px;color:var(--gate);margin:6px 2px 0">手工流程：📋 提示词 → Gemini 動画/Hailuo 网页（免费额度）→ ⬆ 上传（${done}/${draft.length}）</div>`;
      return `<div>${items}${foot}${paidBtns}</div>`;
    }
    const total = ctx.project.shots.total;
    if (node.state === "done") {
      // Connected mode is a placeholder-advance (no real generation, gated);
      // demo mode keeps its pretend-generated ✓.
      const ph = ctx.isConnected && ctx.isConnected();
      const lb = ph ? `${total} 镜头 · 占位` : `${total} 镜头 · 已生成`;
      const msg = ph
        ? `<div style="font-size:11px;color:var(--gate);margin-bottom:2px">占位推进 · 未真实生成（待 Gateway）</div>`
        : `<div style="font-size:11px;color:var(--ok);margin-bottom:2px">✓ 批量视频已生成</div>`;
      return `<div class="filmprev"><div class="pl"></div><div class="lb mono">${lb}</div></div>${msg}${nx([["edit", "剪辑合成"]])}`;
    }
    const pick = node.pickSingle
      ? `<div class="shotpick">${SINGLE_SHOTS.map((s) => `<button data-shot="${s}">镜头 ${s}</button>`).join("")}</div>`
      : "";
    return `<div style="font-size:11.5px;color:var(--text-dim);width:220px">${total} 个镜头 · 首帧图生视频<br><span style="color:var(--text-faint);font-size:11px">Provider: minimax · 经 Command Gateway</span></div>
      <div class="vbtns"><button class="nrun" data-run>批量生成 ${total} 镜头</button><button class="nrun ghost" data-single>生成单个 ▾</button></div>${pick}`;
  },
  run(node, ctx) {
    // PAID + draft: the batch button runs the REAL one-total-confirmation
    // batch (ADR-0046) instead of the placeholder estimate flow.
    const draft = ctx.project.draftShots;
    if (draft && draft.length && ctx.isPaid && ctx.isPaid() && ctx.batchPaid) {
      if (!node._batchBusy) ctx.batchPaid(node);
      return;
    }
    const total = ctx.project.shots.total;
    ctx.estimate({
      cmd: `generate_videos · 批量 ${total} 镜头`,
      kind: "视频",
      count: total,
      p50: 46.2,
      p90: 62.4,
      actual: 46.2,
      label: `已提交 Gateway：批量视频生成 ${total} 镜头`,
      after: () => { node.state = "done"; ctx.refresh(node); ctx.markIncoming(node.id, "done"); },
    });
  },
  bind(node, el, ctx) {
    const draft = ctx.project.draftShots;
    if (draft && draft.length) {
      bindSlots(node, el, ctx, {
        accept: "video/mp4,video/webm",
        copiedMsg: "已复制视频提示词 — 去 Gemini 動画/Hailuo 网页生成后 ⬆ 上传",
        uploadedMsg: "镜头视频已上传",
        getPrompt: (seq) => {
          const s = draft.find((x) => String(x.sequence) === seq);
          if (!s) return "";
          const nn = String(s.sequence).padStart(2, "0");
          return `【镜头${nn}·${s.title}】${s.description}。时长约 ${s.duration_seconds} 秒，写实电影感，16:9，镜头运动自然流畅，与前后镜头保持同一人物与场景。`;
        },
      });
    }
    const sg = el.querySelector("[data-single]");
    if (sg) sg.onclick = (e) => { e.stopPropagation(); node.pickSingle = !node.pickSingle; ctx.refresh(node); };
    el.querySelectorAll("[data-shot]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const shot = b.dataset.shot;
      if (b.dataset.has) {
        ctx.toast(`镜头 ${shot} 已有成片（防重复扣费护栏会拒绝再次付费；要重做需先建 redo 任务）`);
        return;
      }
      ctx.estimate({
        cmd: `generate_video · 单镜头 ${shot}`,
        kind: "视频",
        count: 1,
        // paid mode binds the REAL generation to exactly this shot
        shot: `shot-${Number(shot)}`,
        p50: 4.2,
        p90: 6.0,
        actual: 4.2,
        label: `已提交 Gateway：单镜头 ${shot} 生成`,
        after: () => { node.pickSingle = false; ctx.refresh(node); },
      });
    }));
  },
  next: ["edit"],
};
