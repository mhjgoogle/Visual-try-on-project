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
import * as genintent from "./genintent.js";
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
import {
  quoteView, specRows, referenceCapability, referenceViolation,
} from "../workflow/genspec.js";
import { refMarkers } from "../workflow/refset.js";
import { gatewayCapabilityFrom, referenceRouteNote } from "../workflow/geninput.js";

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
  // FAILURES ARE WORK ITEMS, NOT ERROR MESSAGES (TASK-079 §1.3). The registry
  // already froze every input this attempt used; what it lacked was a surface
  // that reopens it. Newest first — `shotDetailModel` already reversed the
  // append-only registry.
  const failures = ((d.generations) || [])
    .filter((g) => g.type === kind && g.status === "failed")
    .map((g) => ({
      generationId: g.generationId,
      model: g.model,
      provider: g.provider,
      createdAt: g.createdAt,
      error: g.error,
      prompt: g.promptSnapshot,
      packetVersion: g.packetVersion,
    }));
  return {
    failures,
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
    // ADR-0071 决策 4/5 ON THE SURFACE THAT ACTUALLY HOLDS THE PREFLIGHT
    // (codex 轮 6, P1). The capability reading and the violation check existed but
    // nothing called them, so the studio still said 「参考图不会进模型」 unconditionally
    // and let a creator submit a set the Gateway would refuse. This card already has
    // the references, the quote and the submit, so it is where both belong.
    ...referenceStanding(d, kind, quote && quote.shotId === d.shot.shotId ? quote : null, chips),
  };
}

/**
 * 「这些参考图会怎么样」 for THIS card: what the catalog declared, and whether the
 * set as bound can actually be sent.
 *
 * Reads `genspec` (one preflight reader for quote AND capability) and `refset`
 * (marker parsing), rather than deciding anything itself — TASK-097 §2.5b: those two
 * invariants are already hardened, and re-deriving them here is how they drift.
 */
function referenceStanding(d, kind, quote, chips) {
  const capability = referenceCapability(quote);
  const text = (d.prompts[kind] || {}).text || "";
  const violation = referenceViolation(capability, {
    count: chips.length,
    markers: refMarkers(text),
    roles: chips.map((c) => c.kind),
  });
  return { refCapability: capability, refViolation: violation };
}

/** The spec block. EVERY value comes from the preflight response; nothing here
 *  is guessed, and an unquoted card says so instead of showing plausible
 *  defaults.
 *
 *  READ THROUGH `genspec.specRows` (TASK-097 §2.1). The extraction used to live
 *  here, which was fine while this was the only generation card; the chain adds
 *  four more, and four more copies of 「从 preflight 里取模型/分辨率」 is four more
 *  places that can quietly start filling in a plausible default. */
function specHtml(m) {
  if (!m.canSubmit) return "";
  const spec = specRows(m.quote);
  if (!spec.known) {
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
    spec.rows.map(([k, v]) => row(k, v)).join("") +
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

/** The quote, sitting next to 提交 — not buried in the confirm dialog.
 *
 *  The reading of the preflight is `genspec.quoteView` (TASK-097 §2.1): ONE
 *  function, and one that cannot be handed a bare 「金额 × 数量」, so no generation
 *  surface in this chain has a place to compute a price. */
function quoteHtml(m) {
  if (!m.canSubmit) return "";
  if (!m.quote) return `<button class="btn sm" data-gc-quote>⚡ 报价</button>`;
  const q = quoteView(m.quote);
  if (!q.available) {
    return (
      `<span class="gc-block">⚠ ${q.blockers.length ? "无法生成：" : ""}${esc(q.reason)}` +
      (q.blockers.length > 1 ? ` 等 ${q.blockers.length} 项` : "") + `</span>` +
      `<button class="btn sm" data-gc-quote>↻ 重新报价</button>`
    );
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
    (q.cost.originalCurrency
      ? `<span class="gc-price-src">原始计价 ${esc(q.cost.originalCurrency)}</span>`
      : "") +
    `</span>` +
    `<button class="btn sm" data-gc-quote title="重新取一次报价">↻</button>`
  );
}

/**
 * The failure tickets (TASK-079 §1.3 / T-093).
 *
 * Each one states what that attempt WAS — model, provider, Run id, the exact
 * prompt it was launched with — and why it stopped. Then three actions, all of
 * which are things this product can genuinely do today:
 *
 *   重新提交       start a new paid generation for this shot, through the same
 *                 preflight → 人工确认 → submit (it spends, so it can never be a
 *                 silent re-run)
 *   按这次的 Prompt 重试  load THAT attempt's frozen prompt into the editor, so the
 *                 retry starts from what actually ran rather than from whatever
 *                 the shot compiles to now
 *   交给 AI 导演诊断  hand the failure text to the Director in context
 *
 * IT DOES NOT SAY 「同参数重试」 (codex round 1, P1). On the paid route every
 * parameter comes from the compiled packet, and a resubmit runs against the
 * CURRENT one — so after a re-lock the retry is a DIFFERENT job, and a button
 * promising 「同参数」 would be charging for something it misdescribed. A genuine
 * same-parameter redo is a domain operation this product has not defined (the
 * Gateway refuses a second paid op on the same task and asks for a redo task),
 * and inventing one here would be inventing paid semantics. So the ticket shows
 * WHICH packet the failure ran against and says plainly what a resubmit will do.
 *
 * A failure with no recorded reason says so — 「失败了」 with an invented cause
 * would be worse than the silence it replaces.
 */
function failuresHtml(m) {
  if (!m.failures.length) return "";
  return (
    `<div class="gc-fails"><span class="lab">失败的生成 ${m.failures.length}</span>` +
    m.failures.map((f) =>
      `<div class="gc-fail" data-gc-failid="${esc(f.generationId)}">` +
      `<div class="gc-fail-h">` +
      `<span class="chip bad">失败</span>` +
      `<span class="gc-kv"><span class="k">模型</span><span class="v">${esc(f.model || "未记录")}</span></span>` +
      // the PROVIDER was collected and never shown (codex round 1, P2) — 「哪家
      // 服务拒绝了它」 is half of what tells a creator whether to retry at all
      `<span class="gc-kv"><span class="k">服务</span><span class="v">${esc(f.provider || "未记录")}</span></span>` +
      (f.packetVersion != null
        ? `<span class="gc-kv"><span class="k">packet</span><span class="v">v${esc(String(f.packetVersion))}</span></span>`
        : "") +
      `<span class="gc-kv"><span class="k">Run</span><span class="v mono">${esc(f.generationId)}</span></span>` +
      (f.createdAt
        ? `<span class="gc-kv"><span class="k">时间</span><span class="v">${esc(f.createdAt.slice(0, 16).replace("T", " "))}</span></span>`
        : "") +
      `</div>` +
      `<div class="gc-fail-why">${f.error ? esc(f.error) : "没有记录失败原因（这次生成早于原因登记）"}</div>` +
      (f.prompt
        ? `<details class="gc-fail-p"><summary>当时发出的 Prompt</summary><pre>${esc(f.prompt)}</pre></details>`
        : `<div class="gc-note">这次尝试没有留下 Prompt 快照。</div>`) +
      `<div class="gc-fail-acts">` +
      (m.canSubmit
        ? `<button class="btn sm" data-gc-retry="${esc(f.generationId)}" ` +
          `title="按当前已锁定的 packet 重新提交，仍要经过预检与人工确认">重新提交（按当前 packet）</button>`
        : "") +
      (f.prompt
        ? `<button class="btn sm" data-gc-retry-edit="${esc(f.generationId)}">按这次的 Prompt 重试</button>`
        : "") +
      // WIRED BY THE SHELL (ui/production.js), like 问 Agent — it opens the
      // Director panel and narrows its scope, which this component cannot do.
      // The facts it needs ride on the button so the shell never has to reach
      // back into this card's model for them.
      `<button class="btn sm" data-gc-diagnose="${esc(f.generationId)}" ` +
      `data-shot="${esc(m.shotId || "")}" data-kind="${esc(m.kind)}" ` +
      `data-model="${esc(f.model || "")}" data-why="${esc(f.error || "")}">交给 AI 导演诊断</button>` +
      `</div>` +
      (m.canSubmit
        ? `<div class="gc-note">重新提交走的是<b>当前</b>已锁定的 packet：如果这次失败之后你重新锁定过分镜，` +
          `跑的就不是同一组参数了。真正的「同参数重放」需要一次 redo 任务，本产品还没有定义它。</div>`
        : "") +
      `</div>`).join("") +
    `</div>`
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

  // WHAT THE CATALOG SAID ABOUT THESE PICTURES (ADR-0071 决策 4/5).
  //
  // Two separate statements, deliberately:
  //   the NOTE says what this model does with reference images at all
  //   the VIOLATION says this particular set cannot be sent, and why
  //
  // The note reads the route capability DERIVED from the preflight rather than the
  // static table, so 「图不会进模型」 stops being an unconditional claim the moment the
  // catalog says otherwise — that unconditional claim is what TASK-077 §1.3 could only
  // work around, because nothing used to tell the interface the truth.
  const refNote = m.canSubmit && m.chips.length
    ? `<div class="gc-note gc-refcap">${esc(m.refCapability.note)}` +
      (m.refCapability.known
        ? `<span class="gc-refcap-route"> ${esc(referenceRouteNote(gatewayCapabilityFrom(m.refCapability)))}</span>`
        : "") +
      `</div>`
    : "";
  const refBlock = m.refViolation
    ? `<div class="gc-block gc-refblock">⚠ ${esc(m.refViolation)}</div>`
    : "";

  const submit = m.refViolation && m.canSubmit
    // 提交按钮**不置灰**（既有纪律）—— 但它必须说清为什么按下去会被拒，
    // 而不是让创作者付了一次预检的时间才知道。
    ? `<button class="btn primary" data-gc-submit disabled title="${esc(m.refViolation)}">提交生成（付费）</button>`
    : m.canSubmit
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
    refNote +
    refBlock +
    `<div class="gc-actions">${quoteHtml(m)}${submit}</div>` +
    failuresHtml(m) +
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
export function bindGenCard(root, ctx, ui, rerender, { kind, shotId, importMedia, failures = [] }) {
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
    const setIntent = () =>
      genintent.setIntent(ui, kind, shotId, {
        shotId,
        prompt: promptText(),
        entry: entry === "manual" ? "manual" : `${entry}-manual`,
      });
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

  // --- failure tickets (TASK-079 §1.3) -------------------------------------- //
  const failureOf = (id) => (failures || []).find((f) => f.generationId === id) || null;

  card.querySelectorAll("[data-gc-retry]").forEach((b) => (b.onclick = () => {
    // SAME PARAMS, SAME GATE. A retry spends exactly like a first attempt, so it
    // goes through the identical preflight → 人工确认 → submit. 「同参数」 is
    // literally true on the paid route: the job is derived from the locked
    // packet, which is what the failed attempt used too.
    ctx.paidSubmit(shotId);
  }));

  card.querySelectorAll("[data-gc-retry-edit]").forEach((b) => (b.onclick = () => {
    const f = failureOf(b.dataset.gcRetryEdit);
    if (!f || !f.prompt) { ctx.toast("这次尝试没有留下 Prompt 快照，无法据它重试"); return; }
    // Start from WHAT RAN, not from what the shot compiles to now — the shot may
    // have been edited since, and retrying from the current compilation would be
    // changing two things at once while calling it a retry.
    ui.gcPrompt = ui.gcPrompt || {};
    ui.gcPrompt[shotId] = ui.gcPrompt[shotId] || {};
    ui.gcPrompt[shotId][kind] = f.prompt;
    ctx.toast("已把那次失败的 Prompt 放回编辑框——改完用免费路线重试");
    rerender();
  }));

  // 「交给 AI 导演诊断」 is bound by the shell — see the button's markup.
}
