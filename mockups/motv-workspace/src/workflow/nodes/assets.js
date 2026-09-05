// 资产准备 — character / scene / prop reference sheets (S4 母资产). Opens the
// batch wizard; on generate it flips to done and guides to video/audio.
import { nx, bindSlots, vbadge } from "./shared.js";
import { slotUrl, addVersion, refFromResponse } from "../mediaref.js";
import { declare } from "../assetreg.js";
import { esc } from "../../util/dom.js";

function labels(ctx) {
  // When a Claude shot DRAFT is active, the placeholder grid must show the
  // draft's shots — not the demo fixture's characters/scenes (which would
  // contradict the script). Demo mode (no draft) keeps the fixture labels.
  const draft = ctx.project.draftShots;
  if (draft && draft.length) {
    return draft.slice(0, 6).map((s) => `${String(s.sequence).padStart(2, "0")} ${s.title}`);
  }
  const chars = ctx.project.characters.slice(0, 5).map((c) => c[0]);
  return [...chars, ctx.project.scenes[0][0]];
}

export default {
  type: "assets",
  step: 2,
  stage: "S4 素材制造",
  title: "资产准备",
  icon: "🧑‍🎨",
  init() {
    return { state: "", uploads: {} };
  },
  render(node, ctx) {
    // Downstream auto-fill (ADR-0042): when an upstream Claude shot DRAFT
    // exists, derive the asset checklist from it instead of fixtures — each
    // shot slot supports the MANUAL image provider: 📋 copies a generation
    // prompt (paste into e.g. Gemini web, free), ⬆ uploads the result image.
    const draft = ctx.project.draftShots;
    if (draft && draft.length) {
      const up = node.uploads || {};
      // Uploads are keyed by each shot's stable SLOT id (assigned per version;
      // surviving shots keep theirs across manual edits) — stale entries from
      // other versions simply never match and are ignored in count and render.
      const key = (s) => s.slot || "";
      // Agent-generated content is UNTRUSTED — always escaped before innerHTML.
      const paid = !!(ctx.isPaid && ctx.isPaid());
      const items = draft
        .map((s) => {
          const k = key(s);
          const url = k && slotUrl(up, k);
          const thumb = url
            ? `<img class="athumb" src="${esc(url)}" alt="" data-vslot="${esc(k)}" data-vnode="${esc(String(node.id))}">`
            : `<span class="aph">无图</span>`;
          const gen = paid
            ? `<button class="amini" data-gen="${esc(String(s.sequence))}" title="自动生成（MiniMax image-01 付费 · $0.0035/张 · 每张确认；可选拼版/单幅首帧）">💳</button>`
            : "";
          // 免费自动出图（TASK-139）。**和 💳 并排但必须一眼分得开**：一个花钱
          // 一个不花钱，而它们做的是同一件事（ADR-0100「后果」第一条：三条路
          // 在界面上分不开的话，「这张图花没花钱」就会变成猜）。
          const genFree = `<button class="amini" data-genfree="${esc(String(s.sequence))}" title="自动生成（免费 · 不产生账单 · 无需确认金额；来源见 .env.local 的 IMAGE_PROVIDER）">✨</button>`;
          // 一键流转（TASK-048 第1步）：把该槽位当前版本图以 MediaRef 写入
          // video 节点同槽位的首帧输入位（手工路线图↔视频闭环）。
          const useFf = url
            ? `<button class="amini" data-usefirst="${esc(k)}" title="用作视频首帧：当前版本图流转到视频节点，成为该镜头图生视频的第一帧">🎬→</button>`
            : "";
          // Two prompt flavors per shot: 📋 multi-view reference sheet (character
          // consistency), 🎬 SINGLE-frame composition — the slot image is what
          // lock-draft-plan sends as the shot's first frame (ADR-0047), and a
          // collage first frame would put the grid itself into the video.
          return `<div class="arow">${thumb}<span class="alb">${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}</span>${vbadge(up, k)}<button class="amini" data-copy="${esc(String(s.sequence))}" title="复制「多角度拼版设定图」提示词（人物一致性参考）">📋</button><button class="amini" data-copyframe="${esc(String(s.sequence))}" title="复制「单幅首帧图」提示词（锁定后用作该镜头图生视频的第一帧）">🎬</button>${useFf}${genFree}${gen}<button class="amini" data-up="${esc(k)}" title="上传该镜头的图（同槽位重传保留旧版本，可回切）">⬆</button></div>`;
        })
        .join("");
      // Completion counts ONLY the current draft's slots — an upload belonging
      // to another version can never make this draft look ready.
      const done = draft.filter((s) => key(s) && slotUrl(up, key(s))).length;
      const complete = done >= draft.length;
      const foot = complete
        ? `<div style="font-size:11px;color:var(--ok);margin:6px 2px 0">✓ 手工图 ${done}/${draft.length} · 未锁定</div>${nx([["video", "视频生成"], ["audio", "音频生成", 150]])}`
        : `<div style="font-size:11px;color:var(--gate);margin:6px 2px 0">手工流程：📋 复制提示词 → 网页生图（免费）→ ⬆ 上传（${done}/${draft.length}）</div><button class="nrun" data-run>一键生成所有资产 →</button>`;
      return `<div>${items}${foot}</div>`;
    }
    const cells = labels(ctx)
      .map((a) => {
        const bg = node.state === "done" ? "linear-gradient(135deg,#3a2a5e,#12183a)" : "var(--elev)";
        const col = node.state === "done" ? "#fff" : "var(--text-dim)";
        return `<div class="a" style="background:${bg}"><span class="lb" style="color:${col}">${esc(a)}</span></div>`;
      })
      .join("");
    const grid = `<div class="assetgrid">${cells}</div>`;
    if (node.state === "done") {
      // Connected mode never really generates (write-side gated): say so plainly
      // instead of claiming "✓ 已生成". Demo mode keeps its pretend-generated ✓.
      const ph = ctx.isConnected && ctx.isConnected();
      const msg = ph
        ? `<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">占位推进 · 未真实生成（待 Gateway）</div>`
        : `<div style="font-size:11px;color:var(--ok);margin:9px 2px 0">✓ 9 个资产已生成</div>`;
      return `<div>${grid}${msg}${nx([["video", "视频生成"], ["audio", "音频生成", 150]])}</div>`;
    }
    return `<div>${grid}<div style="font-size:11px;color:var(--gate);margin:9px 2px 0">⚠ 9 个资产缺设定图</div><button class="nrun" data-run>一键生成所有资产 →</button></div>`;
  },
  run(node, ctx) {
    ctx.wizard.open(node); // wizard's confirm -> estimate -> marks node done
  },
  bind(node, el, ctx) {
    const draft = ctx.project.draftShots;
    if (!draft || !draft.length) return;
    // 拼版设定图: multi-view character/scene consistency reference (NOT a first
    // frame — the grid itself would become the video's opening image).
    const promptSheet = (seq) => {
      const s = draft.find((x) => String(x.sequence) === seq);
      if (!s) return "";
      const nn = String(s.sequence).padStart(2, "0");
      return `【镜头${nn}·${s.title}】${s.description}（时长约${s.duration_seconds}s）。写实电影感，16:9。请为该镜头生成一张设定图拼版：包含远景（全景/全身）、近景特写、3/4 侧面与背面等多角度视图；同一人物、服装与场景在所有视图中保持一致。`;
    };
    // 单幅首帧图: ONE full-bleed composition — exactly what the shot's first
    // frame should look like, usable via lock-draft-plan as image-to-video.
    const promptFrame = (seq) => {
      const s = draft.find((x) => String(x.sequence) === seq);
      if (!s) return "";
      const nn = String(s.sequence).padStart(2, "0");
      return `【镜头${nn}·${s.title}】首帧单幅画面：${s.description}。写实电影感，16:9 横幅，单一完整构图（不要拼版、不要分格、不要文字标注或边框），人物、服装与场景与该镜头设定图保持一致；这张图将直接作为该镜头图生视频的第一帧。`;
    };
    bindSlots(node, el, ctx, {
      accept: "image/png,image/jpeg,image/webp",
      copiedMsg: "已复制「拼版设定图」提示词 — 去 Gemini 网页生成后 ⬆ 上传",
      uploadedMsg: "图已上传（该槽位图片在锁定后会作为此镜头的视频首帧）",
      // data-copy carries the sequence (prompt is per-shot content)
      getPrompt: promptSheet,
    });
    // 🎬→ one-click flow into the video node's first-frame input (TASK-048)
    el.querySelectorAll("[data-usefirst]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      if (ctx.useAsFirstFrame) ctx.useAsFirstFrame(node, b.dataset.usefirst);
    }));
    // 🎬 second prompt flavor (single-frame first frame) — same copy handling
    el.querySelectorAll("[data-copyframe]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const text = promptFrame(b.dataset.copyframe);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        ctx.toast("已复制「单幅首帧图」提示词 — 生成后 ⬆ 上传，锁定后即为该镜头视频首帧");
      } catch {
        ctx.toast("复制失败：请手动选择文本复制");
      }
    }));
    // 💳 paid automatic generation (ADR-0045): explicit per-image price
    // confirmation BEFORE any spend; result lands in the same slot.
    // 免费自动出图（TASK-139 / ADR-0100）。与下面那颗付费按钮共用同一条溯源管线
    // （startGeneration → declare → addVersion → completeGeneration），差别只有三处，
    // 而每一处都来自「这条路不产生按次账单」这一个事实：
    //   1. **没有金额确认对话框** —— 那句话在这条路上是假的；
    //   2. provider/model 由**后端回执**说了算，不在前端写死（换来源只改 .env.local）；
    //   3. 失败时只有 `side_effect === "none"` 才敢标 failed（见 catch）。
    el.querySelectorAll("[data-genfree]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const s = draft.find((x) => String(x.sequence) === b.dataset.genfree);
      if (!s || !s.slot || node._genBusy) return;
      const wantFrame = window.confirm(
        "生成哪种图？\n确定 = 单幅首帧图（锁定后作为该镜头视频首帧）\n取消 = 多角度拼版设定图（人物一致性参考）",
      );
      const kind = wantFrame ? "单幅首帧图" : "拼版设定图";
      node._genBusy = true;
      ctx.toast("生成中…（免费来源，可能要几十秒）");
      const prompt = wantFrame ? promptFrame(b.dataset.genfree) : promptSheet(b.dataset.genfree);
      const gen = ctx.startGeneration
        ? ctx.startGeneration({
            type: "image",
            targetType: s.shotId ? "shot" : null,
            targetId: s.shotId ?? null,
            userInstruction: kind,
            promptSnapshot: prompt,
            // 真实来源等回执 —— 现在写死一个名字，就会在换来源那天变成假话
            provider: null,
            model: null,
            parameters: { kind, billing: "account-quota" },
            status: "generating",
          })
        : null;
      try {
        const res = await ctx.accountImage(`${node.type}-${s.slot}`, prompt);
        const ref = refFromResponse(s.slot, "account-image", res, s.shotId ?? null);
        declare(ref, "images", {
          kind: "shot-image",
          links: {
            ...(ctx.contextOfShot ? ctx.contextOfShot(s.shotId ?? null) : { shotId: s.shotId ?? null }),
            generationId: gen ? gen.generationId : null,
          },
        });
        addVersion(node, s.slot, ref);
        if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
        ctx.toast(`设定图已生成 v${res.version || 1}（${res.model || "免费来源"} · 未产生账单，旧版本保留）`);
      } catch (err) {
        // 具名失败要说人话，否则「额度用完」会以一句「生成失败」的样子出现，
        // 而那两件事该做的动作完全不同（ADR-0100 决策 3 · REQ-008 判据 4）。
        const why =
          err.category === "quota_exhausted"
            ? "这个来源的额度用完了 —— 换 .env.local 里的 IMAGE_PROVIDER，或稍后再试"
            : err.category === "billing_not_established"
              ? "这把 key 没声明是免费额度那一档，已拒绝（按次计费请走付费那条）"
              : err.category === "side_effect_unknown"
                ? "上一次没能确认结果 —— 要再来一次得显式确认"
                : err.message;
        // **「消耗没消耗」由 `sideEffect` 说，不由类别说**（codex 补审非阻塞项）。
        // 上一轮把 429 从 `none` 改判成 `unknown` 之后，「额度用完了，稍后再试」
        // 这句就漏了一半：稍后再试没错，但**这一次可能已经消耗过**得说出来，
        // 否则界面又在替他做「反正没花」的假设 —— 与 §5.8 第 2 条同一条纪律。
        const say =
          err.sideEffect && err.sideEffect !== "none"
            ? `${why}（这一次${err.sideEffect === "applied" ? "已经" : "可能已经"}消耗过）`
            : why;
        // **只有「确定什么都没发生」才敢标失败**：`unknown` / `applied` 标成失败，
        // 会让下一次重试看起来是干净的第一次（合同 §5.8）。
        if (gen && err && err.definitiveReject) ctx.failGeneration(gen.generationId, "failed");
        ctx.toast("自动生成失败：" + say);
      } finally {
        node._genBusy = false;
        if (ctx.refreshType) ctx.refreshType(node.type);
        else ctx.refresh(node);
        if (ctx.persist) ctx.persist();
      }
    }));
    const PRICE = 0.0035;
    el.querySelectorAll("[data-gen]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const s = draft.find((x) => String(x.sequence) === b.dataset.gen);
      if (!s || !s.slot || node._genBusy) return;
      // choose the prompt flavor BEFORE the price consent: the slot image is
      // what lock-draft-plan sends as this shot's first frame, so the single-
      // frame composition is usually what image-to-video wants
      const wantFrame = window.confirm(
        "生成哪种图？\n确定 = 单幅首帧图（锁定后作为该镜头视频首帧）\n取消 = 多角度拼版设定图（人物一致性参考）",
      );
      const kind = wantFrame ? "单幅首帧图" : "拼版设定图";
      if (!window.confirm(`将调用 MiniMax image-01 真实生成 1 张「${kind}」，费用 $${PRICE}（约 0.5 日元）。确认扣费？`)) return;
      node._genBusy = true;
      ctx.toast("MiniMax 生成中…（约 5-20 秒）");
      const prompt = wantFrame ? promptFrame(b.dataset.gen) : promptSheet(b.dataset.gen);
      // M5: freeze this generation's provenance at LAUNCH — the exact prompt,
      // model and parameters used, and the shot it targets (canonical M2 shotId,
      // never the slot). Result Asset is linked on success below.
      const gen = ctx.startGeneration ? ctx.startGeneration({
        type: "image",
        targetType: s.shotId ? "shot" : null,
        targetId: s.shotId ?? null,
        userInstruction: kind,
        promptSnapshot: prompt,
        provider: "MiniMax",
        model: "image-01",
        parameters: { kind, priceUsd: PRICE },
        status: "generating",
      }) : null;
      try {
        const res = await ctx.paidImage(`${node.type}-${s.slot}`, prompt, PRICE);
        // the draft shot in hand carries its M2 identity — provable association
        const ref = refFromResponse(s.slot, "paid-image", res, s.shotId ?? null);
        // CP2: a paid image generated FOR this shot is that shot's 镜头图片
        declare(ref, "images", {
          kind: "shot-image",
          links: {
            ...(ctx.contextOfShot ? ctx.contextOfShot(s.shotId ?? null) : { shotId: s.shotId ?? null }),
            generationId: gen ? gen.generationId : null,
          },
        });
        addVersion(node, s.slot, ref);
        if (gen) ctx.completeGeneration(gen.generationId, [ref.assetId]);
        ctx.toast(`设定图已生成 v${res.version || 1}（$${res.usd} 已扣，旧版本保留；见 data/paid-image-log.jsonl）`);
      } catch (err) {
        // only a DEFINITIVE rejection (4xx / client guard — no bill) marks the
        // generation failed. An AMBIGUOUS error (5xx / network) may have billed a
        // real image, so leave it `generating` rather than record a false failure.
        if (gen && err && err.definitiveReject) ctx.failGeneration(gen.generationId, "failed");
        ctx.toast("付费生成失败（未扣费或已在日志留痕）：" + err.message);
      } finally {
        node._genBusy = false;
        // uploads alias the shared project registry (M3) — refresh every
        // same-type node so a duplicate isn't left showing stale media
        if (ctx.refreshType) ctx.refreshType(node.type);
        else ctx.refresh(node);
        if (ctx.persist) ctx.persist();
      }
    }));
  },
  next: ["video", "audio"],
};
