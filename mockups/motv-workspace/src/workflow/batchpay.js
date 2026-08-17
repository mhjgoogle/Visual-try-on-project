// 批量付费的统一形状 (TASK-097 §2.3) — 一套代码，三处批量。
//
//   一键合成全部提示词   14 × ⚡6      TASK-095 §2.3
//   Storyboard 全集      14 张草图     TASK-095 §2.4
//   批量生视频           14 镜         TASK-095 §2.5
//
// 五条硬约束，逐条对应一个已知的失败方式：
//
//   1. 总额来自 preflight，不是单价 ×N —— 界面永不自算 (ADR-0071 决策 6)。
//      「⚡6 × 14 = 84」 looks harmless and is the first step to a number nobody
//      verified appearing on the screen a creator reads before spending.
//   2. 一次确认，ADR-0041 两步 —— preflight → 人工确认 → 提交。批量不是绕过确认的
//      理由，它恰恰是最需要确认的形状。
//   3. 可中止。
//   4. 中途失败不把整批标成成功，已花的钱如实记账。这是本仓库反复栽的那一类：
//      声明与事实脱钩（TASK-077 的 `storageState`）。
//   5. provider 未声明「多图不额外计费」→ `maxImages: 0` → fail-closed 拒绝并说明
//      原因（ADR-0071 方案 C），**不静默降级成单图**。降级会让「用了角色设定图」
//      这句话变成谎。
//
// PURE STATE MACHINE. It performs no I/O: the caller supplies the preflight
// response and reports each item's outcome back in. That is what makes 「中途失败
// 怎么记账」 testable without a provider.

import { isDisplayableAmount } from "./genspec.js";

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";

/** The lifecycle. `refused` is terminal and is reached BEFORE any spend — it is
 *  where 方案 C 的 fail-closed lands. */
export const BATCH_STATES = ["draft", "quoted", "running", "settled", "aborted", "refused"];

export const BATCH_STATE_LABEL = {
  draft: "待报价",
  quoted: "已报价 · 待确认",
  running: "进行中",
  settled: "已结束",
  aborted: "已中止",
  refused: "已拒绝（未花钱）",
};

/** One item's outcome. `pending` is the only non-terminal one. */
export const ITEM_OUTCOMES = ["pending", "success", "failed", "skipped"];

/**
 * Start a batch.
 *
 * `items` are opaque to this module beyond needing an `id`: the batch does not care
 * whether an item is a shot, a prompt or an asset — it cares that each one can be
 * named in the settlement.
 */
export function createBatch({ kind, items } = {}) {
  const list = [];
  const seen = new Set();
  let duplicate = null;
  const invalid = [];
  for (const it of Array.isArray(items) ? items : []) {
    // AN UNUSABLE ITEM IS A REFUSAL, NOT A SKIP (codex round 3, P1). Silently
    // dropping it quotes and runs a SMALLER batch than the caller asked for — the
    // creator confirms 「14 镜」 and 13 run, with nothing anywhere saying so. Same
    // shape as the duplicate-id refusal above: this module never quietly changes
    // what the batch is.
    if (!isObj(it) || !nonEmpty(it.id)) { invalid.push(it); continue; }
    // DUPLICATE IDS ARE REFUSED, NOT DE-DUPLICATED (codex round 1, P1). `recordItem`
    // matches by id, so two entries sharing one would both settle on a single
    // provider result — one real charge reported as two, or two real charges
    // reported as one. De-duplicating silently would be just as wrong: the caller
    // asked for N items and would get N-1 without being told.
    if (seen.has(it.id)) { duplicate = it.id; break; }
    seen.add(it.id);
    list.push({
      id: it.id,
      label: typeof it.label === "string" ? it.label : it.id,
      outcome: "pending",
      spent: null,
      error: null,
      // set by `abortBatch`; lets a receipt that arrives AFTER the stop still be
      // recorded against the item it belongs to (codex round 1, P1)
      abortedPending: false,
    });
  }
  const refusalReason = duplicate
    ? `这一批里有重复的条目 id「${duplicate}」—— 一次结果会同时结清两条，记账必然错`
    : invalid.length
      ? `这一批里有 ${invalid.length} 条没有可用的 id —— 跳过它们等于悄悄少跑几条，所以整批拒绝`
      : null;
  if (refusalReason) {
    return {
      kind: nonEmpty(kind) ? kind : "unknown",
      state: "refused",
      items: [],
      quote: null,
      refusal: { reason: refusalReason, blockers: [] },
      confirmedAt: null,
      abortedAt: null,
    };
  }
  return {
    kind: nonEmpty(kind) ? kind : "unknown",
    state: list.length ? "draft" : "refused",
    items: list,
    quote: null,
    refusal: list.length ? null : { reason: "这一批里没有任何条目 —— 不会为空批次开预检", blockers: [] },
    confirmedAt: null,
    abortedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/* 1 + 5. 报价与 fail-closed                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attach the Gateway preflight result.
 *
 * `preflight` MUST carry a batch TOTAL. A response that only prices one item is
 * refused rather than multiplied here — rule 1 exists because multiplying is the
 * easy, wrong thing to reach for, so the refusal has to be in the code path that
 * would do it.
 *
 * `capability` is the provider's DECLARED multi-image capability (ADR-0071 决策 4:
 * catalog 声明能力，Provider 不猜). `maxImages: 0` means this route does not carry
 * reference images at all; if the batch needs them, this is where it stops.
 */
export function applyPreflight(batch, preflight, { needsReferenceImages = false, capability = null } = {}) {
  if (!isObj(batch) || batch.state !== "draft") return batch;

  // 方案 C first: refusing costs nothing and a refusal after a quote reads as
  // 「我们报了价然后反悔」.
  if (needsReferenceImages) {
    const cap = isObj(capability) ? capability : null;
    const max = cap && Number.isInteger(cap.maxImages) ? cap.maxImages : 0;
    if (max <= 0) {
      return {
        ...batch,
        state: "refused",
        refusal: {
          reason: cap && nonEmpty(cap.providerLabel)
            ? `${cap.providerLabel} 没有声明「多图不额外计费」，所以这条多图路线在它上面不可用`
            : "这个 provider 没有声明「多图不额外计费」，所以多图路线不可用",
          detail: "ADR-0071 方案 C：我们不替 provider 算钱。目录里没有明确声明的，maxImages 记 0 并拒绝，"
            + "**不静默降级成单图** —— 降级会让「用了角色设定图」这句话变成谎。",
          blockers: [],
        },
      };
    }
    const over = batch.items.length && Number.isInteger(cap.maxImagesPerRequest)
      ? cap.maxImagesPerRequest
      : null;
    if (over !== null && over <= 0) {
      return { ...batch, state: "refused", refusal: { reason: "目录声明单次请求可带 0 张参考图", blockers: [] } };
    }
  }

  const q = isObj(preflight) ? preflight : null;
  const blockers = q && Array.isArray(q.blockers) ? q.blockers.filter(nonEmpty) : [];
  if (blockers.length) {
    return { ...batch, state: "refused", refusal: { reason: blockers[0], blockers } };
  }
  const total = q && isObj(q.total) ? q.total : null;
  // A NEGATIVE OR NON-FINITE AMOUNT IS MALFORMED, NOT CHEAP (codex rounds 1–2).
  // `isDisplayableAmount` is shared with `genspec.quoteView` — the two rounds
  // found this same defect in three different spellings, so there is now one
  // predicate and no site left that writes its own.
  if (!total || !isDisplayableAmount(total.amount)) {
    return {
      ...batch,
      state: "refused",
      refusal: {
        reason: "预检没有给出这一批的总额 —— 不按单价 ×N 自算",
        detail: "报价只来自 Gateway preflight，界面永不自算（ADR-0071 决策 6）。"
          + "拿不到总额（或拿到一个不是非负有限数的总额）时正确的动作是说拿不到，不是乘一下。",
        blockers: [],
      },
    };
  }
  // AN AMOUNT WITH NO CURRENCY CANNOT BE REPORTED HONESTLY (codex round 2, P1).
  // `settlement` prints 「已计费 X <币种>」 only when it has a currency, so an
  // unlabelled quote would run a real batch and then suppress the spend line
  // entirely — rule 4 defeated by a missing string. 84 what? is not a question a
  // creator should be answering after the money is gone.
  // Blank-after-trim counts as absent (codex round 3, P2): 「84  」 with a
  // whitespace currency prints as an amount with no unit, which is the same defect
  // wearing a space.
  if (!nonEmpty(total.currency) || !total.currency.trim()) {
    return {
      ...batch,
      state: "refused",
      refusal: {
        reason: "预检给了金额却没给币种 —— 一个说不出单位的总额，事后也报不出「花了多少」",
        blockers: [],
      },
    };
  }
  // The COUNT the Gateway priced must be the count we are about to run, and it
  // must be STATED. A quote that does not say how many items it covers cannot be
  // checked against this batch at all, so accepting it would let a total for an
  // unknown-sized job be confirmed here (codex round 1, P1) — the creator would be
  // approving a number nobody could tie to the work. Fail-closed: an unstated
  // count is a missing count.
  if (!Number.isInteger(total.count) || total.count !== batch.items.length) {
    return {
      ...batch,
      state: "refused",
      refusal: {
        reason: Number.isInteger(total.count)
          ? `预检报的是 ${total.count} 条的总额，这一批有 ${batch.items.length} 条 —— 不拿这个数字去确认`
          : `预检没有说这个总额覆盖几条 —— 无法与这一批的 ${batch.items.length} 条对上，不拿它去确认`,
        blockers: [],
      },
    };
  }
  return {
    ...batch,
    state: "quoted",
    quote: {
      amount: total.amount,
      currency: total.currency,
      count: total.count,
      preflightDigest: nonEmpty(q.preflight_digest) ? q.preflight_digest : null,
      // WHERE IT CAME FROM, recorded on the quote itself. A surface can then assert
      // 「这个数字是预检给的」 instead of trusting that it is.
      source: "gateway-preflight",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 2 + 3. 确认与中止                                                            */
/* -------------------------------------------------------------------------- */

/** The ADR-0041 second step. Refuses without a quote: confirming a batch nobody
 *  priced is the whole failure mode the two-step exists to prevent. */
export function confirmBatch(batch, at) {
  if (!isObj(batch) || batch.state !== "quoted" || !batch.quote) return batch;
  return { ...batch, state: "running", confirmedAt: nonEmpty(at) ? at : null };
}

/** 可中止 (rule 3). Items already finished keep their outcome; the rest become
 *  `skipped` — NOT `failed`. A creator's stop is not a provider error, and
 *  recording it as one would put a fake failure on every remaining shot.
 *
 *  THE STOP IS NOT THE END OF THE ACCOUNTING (codex round 1, P1). A request that
 *  was already in flight can still come back, and it can still have been charged.
 *  Each item aborted while pending is flagged `abortedPending`, and `recordItem`
 *  keeps accepting a real outcome for exactly those — otherwise a charged request
 *  would be filed as 「未执行」 with its spend dropped on the floor, which is rule 4
 *  broken in the one situation rule 3 creates. */
export function abortBatch(batch, at) {
  if (!isObj(batch) || batch.state !== "running") return batch;
  return {
    ...batch,
    state: "aborted",
    abortedAt: nonEmpty(at) ? at : null,
    items: batch.items.map((it) => (it.outcome === "pending"
      ? { ...it, outcome: "skipped", abortedPending: true, error: "创作者中止了这一批" }
      : it)),
  };
}

/* -------------------------------------------------------------------------- */
/* 4. 逐条记账                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Record ONE item's real outcome, with what it really cost.
 *
 * `spent` is the amount the receipt says, in minor units of `quote.currency`. It is
 * NOT derived from the quote: the quote is an estimate and the receipt is the fact,
 * and averaging one into the other is how 「已花的钱」 stops matching the account.
 *
 * THREE VALUES, THREE MEANINGS (codex round 5, P1 — the contract said two things at
 * once and `settlement` believed the other one):
 *
 *   0      这一条没有产生费用 —— a free route, a草图, a refusal before submit.
 *          A FACT, and it settles the accounting.
 *   n > 0  the receipt's figure.
 *   null   我们不知道它花了多少 —— no receipt came back, or it came back without a
 *          figure. NOT the same as zero, and it keeps the settlement incomplete.
 *
 * So a free item must be recorded as `spent: 0`, never omitted: 「免费」 and 「不知道」
 * are exactly the two things this module exists to keep apart.
 */
export function recordItem(batch, id, { outcome, spent = null, error = null } = {}) {
  if (!isObj(batch) || (batch.state !== "running" && batch.state !== "aborted")) return batch;
  if (!ITEM_OUTCOMES.includes(outcome) || outcome === "pending") return batch;
  let hit = false;
  const items = batch.items.map((it) => {
    // AT MOST ONE ITEM (codex round 1, P1). `createBatch` refuses duplicate ids, so
    // this can only ever match one — the `hit` guard makes that invariant hold even
    // if a batch reaches here another way, rather than trusting it.
    if (hit || it.id !== id) return it;
    // 正在等结果的：还没结的，或者中止时被记成「未执行」而实际还在飞的
    const acceptable = it.outcome === "pending" || (it.abortedPending && batch.state === "aborted");
    if (!acceptable) return it;
    hit = true;
    return {
      ...it,
      outcome,
      // A NEGATIVE 「花费」 IS MALFORMED, NOT A REFUND (codex rounds 1–2). It is
      // recorded as UNKNOWN rather than summed, so the settlement says 「至少」
      // instead of quietly understating what was spent.
      spent: isDisplayableAmount(spent) ? spent : null,
      abortedPending: false,
      error: nonEmpty(error) ? error : null,
    };
  });
  if (!hit) return batch;
  // An aborted batch stays aborted: a late receipt corrects the accounting, it does
  // not un-stop the run.
  if (batch.state === "aborted") return { ...batch, items };
  const done = items.every((it) => it.outcome !== "pending");
  return { ...batch, items, state: done ? "settled" : "running" };
}

/**
 * The honest settlement (rule 4).
 *
 * `allSucceeded` is the ONLY thing a surface may call 「整批完成」, and it is false
 * whenever anything failed, was skipped or is still pending. The three counts are
 * reported separately because they mean different things to the creator: a failure
 * needs a retry, a skip needs a decision, a pending one means the batch is still
 * running.
 *
 * `spent` sums the RECEIPTS. When some item charged without reporting a figure the
 * sum is marked incomplete instead of being presented as the total — 「至少花了 X」
 * is true, 「花了 X」 would not be.
 */
export function settlement(batch) {
  const items = isObj(batch) && Array.isArray(batch.items) ? batch.items : [];
  const by = { success: 0, failed: 0, skipped: 0, pending: 0 };
  let spent = 0;
  let unknownSpend = 0;
  for (const it of items) {
    by[it.outcome] = (by[it.outcome] || 0) + 1;
    if (it.outcome === "success" || it.outcome === "failed") {
      // A FAILED attempt can still have been charged. Counting only successes is
      // the flattering version of this number and it is wrong.
      if (Number.isFinite(it.spent)) spent += it.spent;
      else unknownSpend += 1;
    }
  }
  // Items the stop caught mid-flight: filed as 「未执行」 but a receipt may still
  // arrive for them, so the settlement is not final while any remain.
  const awaitingLate = items.filter((it) => it.abortedPending).length;
  return {
    state: batch && batch.state,
    total: items.length,
    ...by,
    allSucceeded: items.length > 0 && by.success === items.length,
    spent,
    // 「已花的钱」 is only complete once nothing can still report one — which includes
    // items that have not run yet (codex round 6, P1). A batch halfway through was
    // being marked financially complete after its first receipt, so a surface could
    // present a partial total as the final bill.
    spendComplete: unknownSpend === 0 && awaitingLate === 0 && by.pending === 0,
    unknownSpend,
    awaitingLate,
    currency: batch && batch.quote ? batch.quote.currency : null,
    quoted: batch && batch.quote ? batch.quote.amount : null,
    failures: items.filter((it) => it.outcome === "failed").map((it) => ({ id: it.id, label: it.label, error: it.error })),
  };
}

/** One sentence a surface can print verbatim. Deliberately says the awkward thing
 *  first: 「14 条里 3 条失败」 is the fact, 「11 条成功」 is the consolation. */
export function settlementLine(batch) {
  const s = settlement(batch);
  if (!s.total) return "这一批没有条目";
  // THE STATE DECIDES FIRST (codex round 6, P1). A refused batch's items are all
  // still `pending` — nothing ever ran — and testing `pending` before the state made
  // it print 「进行中」, i.e. reported a batch that was stopped before any spend as one
  // currently spending. Never-started and half-done are opposite facts.
  if (s.state === "refused") {
    const why = isObj(batch) && isObj(batch.refusal) ? batch.refusal.reason : "";
    return `未执行（已拒绝）：${why || "预检未通过"}`;
  }
  if (s.state === "draft" || s.state === "quoted") {
    return `尚未开始：共 ${s.total} 条${s.state === "quoted" ? "，已报价待确认" : "，待报价"}`;
  }
  if (s.pending) return `进行中：${s.success + s.failed + s.skipped}/${s.total} 已结束`;
  const bits = [];
  if (s.failed) bits.push(`${s.failed} 条失败`);
  if (s.skipped) bits.push(`${s.skipped} 条未执行`);
  bits.push(`${s.success} 条成功`);
  // A SETTLED TOTAL OF ZERO IS A RESULT, NOT AN ABSENCE (codex round 5, P1). The
  // line used to be gated on `s.spent` being truthy, so a batch that really cost
  // nothing printed no money line at all — indistinguishable from a batch whose
  // accounting was never done. 「已计费 0 JPY」 is the sentence a creator needs after
  // a草图 batch, and it is the one this module exists to be able to say.
  const money = s.currency && (s.spendComplete || s.unknownSpend || s.awaitingLate)
    ? `；已计费 ${s.spendComplete ? "" : "至少 "}${s.spent} ${s.currency}`
    : "";
  return `共 ${s.total} 条：${bits.join("、")}${money}`;
}
