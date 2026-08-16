// 生成卡 (TASK-078 §3) — ONE card that holds everything one generation needs.
//
// WHY. Making a single picture cost eight moves across four surfaces: bind the
// references (left column) → read the compiled Prompt (centre column) → 查看/修改
// → 复制 or 自动生成 → leave for a browser tab → download → come back → upload →
// hope it lands on the right slot. The price appeared exactly once, inside the
// confirmation dialog, one click from being spent. 38 shots of that is why the
// real project sits at 0 pictures.
//
// This card puts the references, the Prompt, the spec, the quote, the submit and
// the free route in one place. It adds NO new write path: 提交 calls the same
// ADR-0041 two-step the paid route already used, and the free route is the same
// copy → external tool → import round trip, moved onto the card.
//
// TWO RULES IT MUST NOT BREAK
//
//   1. THE PRICE IS NEVER COMPUTED HERE. It comes from the Gateway preflight's
//      locked-catalog quote. `config/providers` holds prices and it would be
//      easy to multiply them in the browser — and then the number the creator
//      reads before spending would be the one nobody verified.
//   2. THE HUMAN CONFIRMATION STAYS. 「一张卡」 is about where the controls live,
//      not about removing the step where a person approves a real charge. 提交
//      still opens the confirm dialog built from a FRESH preflight.
//
// Pure render + bind; the model is derived from `shotDetailModel` output.

import { esc } from "../util/dom.js";

const KIND_LABEL = { image: "画面", video: "视频" };

/** Where the free route sends the creator. Same two entries the previous
 *  generation entry offered — this card moves them, it does not add providers. */
const FREE_ENTRIES = [
  ["manual", "复制提示词", ""],
  ["chatgpt", "ChatGPT", "https://chatgpt.com/"],
  ["gemini", "Gemini", "https://gemini.google.com/"],
];
const ENTRY_URL = Object.fromEntries(FREE_ENTRIES.map(([k, , url]) => [k, url]));

/**
 * The numbered reference chips shown INLINE with the prompt.
 *
 * They are numbered because the prompt names them by role and an external tool
 * receives a pile of files with no roles — 「①」 next to 「人物参考：林照 Ref v3」
 * is what makes the attachment order reproducible by hand.
 *
 * STILL THE SLOT MODEL (§3 明确不做). References remain per-role bindings; this
 * only DISPLAYS them as an ordered list. Turning them into a real ordered array
 * with `{{Image N}}` placeholders is Phase 3.1 and needs its own ADR.
 */
export function referenceChips(d, kind) {
  const refIn = d.refInputs || {};
  const list = kind === "video" ? refIn.videoReferences : refIn.imageReferences;
  const chips = (Array.isArray(list) ? list : []).map((r, i) => ({
    n: i + 1,
    key: r.key,
    name: r.name,
    version: r.version,
    kind: r.kind,
  }));
  // the START FRAME is an input too, and on the video side it is THE input —
  // leaving it out of the numbered list is how the wrong picture gets attached
  const start = kind === "video" && d.frames && d.frames.start ? d.frames.start : null;
  return { chips, start };
}

/**
 * The card's whole view model.
 *
 * `quote` is the cached 「⚡报价」 for THIS shot (or null). `paid` says whether the
 * Gateway write path exists at all — with it off, the card shows the free route
 * only and says so, rather than offering a submit that cannot run.
 */
export function genCardModel(d, kind, { paid = false, quote = null, promptEdit = null } = {}) {
  const p = d.prompts[kind];
  const { chips, start } = referenceChips(d, kind);
  const edited = typeof promptEdit === "string" && promptEdit !== p.text;
  return {
    kind,
    shotId: d.shot.shotId,
    label: KIND_LABEL[kind] || kind,
    prompt: typeof promptEdit === "string" ? promptEdit : p.text,
    promptCompiled: p.text,
    promptEdited: edited,
    gaps: p.missing,
    chips,
    startFrame: start,
    slot: d.slot,
    // 付费提交 is VIDEO ONLY — ADR-0038 has not admitted paid image generation,
    // so an image card that offered a submit would be promising a route that
    // does not exist (paid_gateway.py: "Paid scope is VIDEO ONLY").
    canSubmit: !!(paid && kind === "video" && d.shot.shotId),
    paid,
    quote: quote && quote.shotId === d.shot.shotId ? quote : null,
  };
}

/** The spec block. EVERY value comes from the preflight response; nothing here
 *  is guessed, and an unquoted card says so instead of showing plausible
 *  defaults. */
function specHtml(m) {
  if (!m.canSubmit) return "";
  const q = m.quote;
  if (!q) {
    return (
      `<div class="gc-spec gc-spec-unknown">` +
      `<span class="lab">模型与规格</span>` +
      `<span class="meta">未知 —— 按「⚡报价」向 Gateway 取一次。` +
      `模型 / 分辨率 / 时长由已锁定的镜头 packet 决定，不由这张卡决定。</span></div>`
    );
  }
  const row = (k, v) =>
    `<span class="gc-kv"><span class="k">${esc(k)}</span><span class="v">${esc(v || "—")}</span></span>`;
  return (
    `<div class="gc-spec">` +
    row("模型", q.inputs.model) +
    row("分辨率", q.inputs.resolution) +
    row("时长", q.inputs.duration != null ? `${q.inputs.duration}s` : "") +
    row("能力", q.inputs.capability) +
    `</div>` +
    // THE HONEST HALF of 「模型与规格可见可选」 (§3 项 2). They are visible; they
    // are NOT selectable, because `submit-video-generation` is packet-only by
    // design — it "never accepts free-form model/resolution/duration/stage"
    // (ADR-0041). A dropdown here would change nothing about the job that runs,
    // which is worse than no dropdown.
    `<div class="gc-note">这几项来自已锁定的镜头 packet，本卡不能改：Gateway 命令按 ADR-0041 只接受 packet，` +
    `不接受自由参数。要换模型或规格，改生产方案后重新「🔒 锁定为正式分镜」。</div>`
  );
}

/** The quote, sitting next to 提交 — not buried in the confirm dialog. */
function quoteHtml(m) {
  if (!m.canSubmit) return "";
  const q = m.quote;
  if (!q) return `<button class="btn sm" data-gc-quote>⚡ 报价</button>`;
  if (q.blockers.length) {
    return (
      `<span class="gc-block">⚠ 无法生成：${esc(q.blockers[0])}` +
      (q.blockers.length > 1 ? ` 等 ${q.blockers.length} 项` : "") + `</span>` +
      `<button class="btn sm" data-gc-quote>↻ 重新报价</button>`
    );
  }
  if (!q.cost) {
    return `<span class="gc-block">⚠ 报价不可用</span>` +
      `<button class="btn sm" data-gc-quote>↻ 重新报价</button>`;
  }
  // JPY IS THE FIGURE, and it is the Gateway's own (`estimate.jpy`) — the same
  // number the budget guard admits or refuses the request against.
  //
  // The original amount is deliberately NOT divided by 100 here (codex round 2).
  // 「minor units」 has a per-currency exponent: 2 for USD, 0 for JPY, 3 for KWD.
  // A fixed ÷100 prints ¥0.28 for a ¥28 quote — a wrong number, on the surface a
  // creator reads immediately before spending. The card has no currency-exponent
  // table and must not invent one (rule 1: no price arithmetic here), so it names
  // the original CURRENCY and leaves the amount to the confirm dialog and the
  // receipt, which come from the backend.
  return (
    `<span class="gc-price" title="来自 Gateway 预检的锁定目录报价，不是前端算的">` +
    `${esc(String(q.cost.jpy))} JPY` +
    (q.cost.original_currency
      ? `<span class="gc-price-src">原始计价 ${esc(q.cost.original_currency)}</span>`
      : "") +
    `</span>` +
    `<button class="btn sm" data-gc-quote title="重新取一次报价">↻</button>`
  );
}

export function renderGenCard(m) {
  const gaps = m.gaps.length
    ? `<div class="gc-gaps">` +
      m.gaps.map((g) => `<span class="chip gate">◌ ${esc(g)}</span>`).join("") +
      `</div>`
    : "";
  const chips = m.chips.length || m.startFrame
    ? `<div class="gc-refs"><span class="lab">参考</span>` +
      (m.startFrame
        ? `<span class="gc-chip gc-chip-frame" title="${esc(m.startFrame.from || "")}">` +
          (m.startFrame.url ? `<img src="${esc(m.startFrame.url)}" alt="" loading="lazy">` : "") +
          `<b>首帧</b>${esc(m.startFrame.name || "")}</span>`
        : "") +
      m.chips.map((c) =>
        `<span class="gc-chip" title="${esc(c.kind)}">` +
        `<b>${c.n}</b>${esc(c.name)}${c.version != null ? ` v${c.version}` : ""}</span>`).join("") +
      `</div>`
    : `<div class="gc-refs"><span class="lab">参考</span>` +
      `<span class="meta">这个镜头还没有绑定参考 —— 一致性会明显不稳。` +
      `<button class="btn sm" data-goto="refplan">→ 去绑定</button></span></div>`;

  const submit = m.canSubmit
    ? `<button class="btn primary" data-gc-submit>提交生成（付费）</button>`
    : m.paid && m.kind === "image"
      ? `<span class="meta">付费图片生成尚未获批（ADR-0038 未 Accepted）——下面的免费路线是这一步的正式做法。</span>`
      : `<span class="meta">未开启付费写路径（后端 --enable-paid）——用下面的免费路线生成，再导入回来。</span>`;

  return (
    `<div class="card pad gc" data-gc="${esc(m.kind)}">` +
    // The COMPILED prompt travels with the card so the live edit check below
    // needs no second model build — and so 「改过了吗」 is answered against the
    // exact text this render compiled, not against a later recompilation.
    `<span hidden data-gc-compiled>${esc(m.promptCompiled)}</span>` +
    `<div class="st-sec"><h3>生成${esc(m.label)}</h3>` +
    `<div class="acts">` +
    `<span class="chip gate" data-gc-editflag${m.promptEdited ? "" : " hidden"}>Prompt 已改（仅用于免费路线）</span>` +
    `</div></div>` +
    chips +
    gaps +
    `<textarea class="gc-prompt" data-gc-prompt spellcheck="false" rows="7">${esc(m.prompt)}</textarea>` +
    // ALWAYS RENDERED, shown/hidden in place (codex round 1, P1). It used to be
    // emitted only when the model already said 「edited」, and typing does not
    // re-render — a re-render per keystroke would move the caret out of the very
    // textarea being typed in. So the creator could edit the prompt and press
    // 提交生成（付费） with no warning ever having appeared, while the paid job ran
    // the packet's prompt instead of the text on screen.
    `<div class="gc-note" data-gc-editnote${m.promptEdited ? "" : " hidden"}>` +
    `你改过的 Prompt 只用于「复制 / 打开外部工具」这条路线。` +
    `付费提交发送的是已锁定 packet 里的 Prompt —— 那是被批准过的那一份。` +
    `<button class="btn sm" data-gc-reset>还原为编译结果</button></div>` +
    specHtml(m) +
    `<div class="gc-actions">${quoteHtml(m)}${submit}</div>` +
    `<div class="gc-free"><span class="lab">免费路线</span>` +
    FREE_ENTRIES.map(([k, label]) =>
      `<button class="btn sm" data-gc-free="${esc(k)}">${k === "manual" ? "📋 " : "↗ "}${esc(label)}</button>`).join("") +
    `<button class="btn sm" data-gc-import>⬆ 导入生成结果</button>` +
    `</div>` +
    (m.slot ? "" : `<div class="gc-note">镜头身份未解析 —— 无法定位媒体槽位，导入会被拒绝。</div>`) +
    `</div>`
  );
}

/**
 * Wire the card.
 *
 * `ui.gcPrompt[shotId][kind]` holds the edited prompt (transient, free route
 * only). `ui.gcQuote` holds the last quote. Neither is persisted: a prompt edit
 * that outlived the session would silently diverge from the compiled one.
 */
export function bindGenCard(root, ctx, ui, rerender, { kind, shotId, importMedia }) {
  const card = root.querySelector(`[data-gc="${kind}"]`);
  if (!card) return;
  const area = card.querySelector("[data-gc-prompt]");
  const compiledEl = card.querySelector("[data-gc-compiled]");
  const compiled = compiledEl ? compiledEl.textContent : "";
  const promptText = () => (area ? area.value : "");
  const isEdited = () => promptText() !== compiled;
  // Reveal the warning AS THE EDIT HAPPENS, without a re-render — the caret has
  // to stay in the textarea, and a state the creator cannot see is a state they
  // cannot act on. This is the whole fix for the round-1 P1.
  const flag = card.querySelector("[data-gc-editflag]");
  const note = card.querySelector("[data-gc-editnote]");
  const syncEdited = () => {
    const on = isEdited();
    if (flag) flag.hidden = !on;
    if (note) note.hidden = !on;
  };
  if (area) {
    area.oninput = () => {
      ui.gcPrompt = ui.gcPrompt || {};
      ui.gcPrompt[shotId] = ui.gcPrompt[shotId] || {};
      ui.gcPrompt[shotId][kind] = area.value;
      syncEdited();
    };
  }
  const reset = card.querySelector("[data-gc-reset]");
  if (reset) reset.onclick = () => {
    if (ui.gcPrompt && ui.gcPrompt[shotId]) delete ui.gcPrompt[shotId][kind];
    rerender();
  };

  const quote = card.querySelector("[data-gc-quote]");
  if (quote) quote.onclick = async () => {
    quote.disabled = true;
    try {
      ui.gcQuote = await ctx.paidQuote(shotId);
    } catch (e) {
      ctx.toast("报价失败：" + e.message);
    } finally {
      quote.disabled = false;
    }
    rerender();
  };

  const submit = card.querySelector("[data-gc-submit]");
  if (submit) submit.onclick = () => {
    // A BANNER IS NOT ENOUGH ON THE SPEND PATH (codex round 1, P1). The warning
    // above now appears the instant the prompt is edited, but this button starts
    // a real charge that will use the LOCKED packet's prompt — not the text in
    // front of the creator. So the divergence is stated once more, here, where
    // the money is, and they can still proceed knowingly.
    if (isEdited() && !window.confirm(
      "卡上的 Prompt 已被你修改，但付费提交发送的是已锁定 packet 里的 Prompt——" +
      "你改的这一份只用于免费路线。仍要按 packet 的 Prompt 提交并扣费？",
    )) return;
    // NOT a shortcut past the confirmation. `ctx.paidSubmit` runs a fresh
    // preflight and opens the ADR-0041 confirm dialog; this button only decides
    // WHICH shot that is for.
    ctx.paidSubmit(shotId);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptText());
      ctx.toast("提示词已复制");
      return true;
    } catch {
      ctx.toast("复制失败：请手动选择文本复制");
      return false;
    }
  };
  card.querySelectorAll("[data-gc-free]").forEach((b) => (b.onclick = async () => {
    const entry = b.dataset.gcFree;
    const setIntent = () => {
      ui.genIntent = ui.genIntent || {};
      ui.genIntent[kind] = {
        shotId,
        prompt: promptText(),
        entry: entry === "manual" ? "manual" : `${entry}-manual`,
      };
    };
    if (entry === "manual") {
      if (await copy()) setIntent();
      return;
    }
    // open FIRST, synchronously inside the user gesture — an awaited clipboard
    // call before window.open can demote it to a blocked popup
    window.open(ENTRY_URL[entry] || "about:blank", "_blank", "noopener");
    // provenance intent ONLY when the prompt really reached the clipboard: a
    // denied copy must not fake a 「sent to ChatGPT」 record
    if (await copy()) setIntent();
  }));

  const imp = card.querySelector("[data-gc-import]");
  if (imp && typeof importMedia === "function") imp.onclick = () => importMedia(kind, shotId);
}
