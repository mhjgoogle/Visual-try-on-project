// 审片结论怎么离开画布，进核心项目 —— TASK-103 批次 B（TASK-087 §1.2 / TASK-083 §5.1）。
//
// 在这之前：「✓ 通过」写一条 ReviewDecision 进画布，然后就没有然后了。核心项目
// 里的评价/反馈/行动闭环（`record-evaluation` / `create-feedback` / `create-action`
// / `action-transition`）**四个命令 2026-07 就实现了**，只注册在 `workspace_shell`
// 那个界面上 —— 而那个界面看不见创作者的 Studio 项目（GAP-05 / C-020）。所以能力
// 一直在，路一直不通。
//
// 本模块只做**纯的那一半**：把一次审片结论翻译成 Command 信封，以及把网关的回答
// 翻译成一句创作者读得懂的话。它不发请求、不碰 DOM、不读全局状态 —— 因此可以被
// `.test.mjs` 完整覆盖，而 app.js 里只剩「拿到结果、存起来、说出来」。
//
// **诚实优先于成功**（这是本模块存在的理由，不是修饰）：核心可能拒绝这次登记 ——
// 项目没有 WFM1 身份、镜头没有正式记录、后端根本没连上。三种情况都不是「通过失败」
// （画布上的通过已经成立），也都不许被吞掉。它们各自有自己的一句话，见 `explain`。

/** 命令名 —— 与 `src/ai_video_workflow/app/gateway_commands.py` 同名，
 *  那边是权威；这里写死是因为信封里必须出现字面量。 */
export const RECORD_EVALUATION = "record-evaluation";
export const CREATE_FEEDBACK = "create-feedback";

/** 审片通过用的评价判据。一个固定的短标识，不是给人看的标题 ——
 *  核心把它当 `criterion` 存，用来回答「这条评价评的是哪一项」。 */
export const DAILIES_CRITERION = "dailies-review";

const str = (x) => (typeof x === "string" ? x.trim() : "");

/** 目标 = 这一镜的**正式镜头记录**，而且它的三元组必须**由后端算**。
 *
 *  为什么不是视频资产：`WorkflowTargetResolver` 只认核心 QCD 日志里
 *  `asset_imported` 过的资产，而创作者手工放进来的片子从来没进过那条日志 ——
 *  拿它当目标等于让每一次审片都解析不到。镜头记录反过来是正式分镜一锁定就有的，
 *  `ShotRecordTargetResolver` 认「裸 shot id + version 1」。
 *
 *  为什么前端不自己拼：`CommandEnvelope` 要求 target 恰好是
 *  `{ref, version, content_digest}`，其中 digest 是记录文件字节的 sha256。前端
 *  算不出它，**更不许编一个** —— 编出来的后果不是「被拒」，是把一条命令绑在一个
 *  不存在的版本上。所以目标由只读路由 `/review-target` 给，与网关提交时校验的
 *  是同一个 resolver 算出来的同一个 digest；两次之间镜头被改写就 fail closed。
 *
 *  语义上也更对：创作者审的是「这一镜」，不是「这一个文件」。换了一版视频再审，
 *  仍然是对同一镜的第二条评价。 */
export function isUsableTarget(t) {
  if (!t || typeof t !== "object") return false;
  if (!str(t.ref)) return false;
  if (!Number.isInteger(t.version) || t.version <= 0) return false;
  return /^[0-9a-f]{64}$/.test(str(t.content_digest));
}

/** 一次审片结论的 id。带上 decisionId，使画布上的那条决定与核心里的那条评价
 *  一一对应 —— 重放同一条决定得到同一个 id，网关按 command_id 幂等，不会写两次。 */
export function evaluationId(decisionId) {
  const id = str(decisionId);
  return id ? `eval-${id}` : "";
}

/**
 * 把一条画布 ReviewDecision 翻译成 `record-evaluation` 的信封素材。
 *
 * 返回 `{ok:true, name, target, params, commandId}` 或 `{ok:false, error}`。
 * **拒绝先于发送**：缺 shotId / 缺 decisionId / verdict 不是本模块认识的两种之一，
 * 都在这里说清楚，而不是让网关回一个 400 让界面去猜。
 */
export function evaluationFor(dec) {
  if (!dec || typeof dec !== "object") return { ok: false, error: "没有可登记的审片结论" };
  const shotId = str(dec.targetId);
  if (!shotId) return { ok: false, error: "这条结论没有指向具体镜头，无法登记到核心" };
  const evalId = evaluationId(dec.decisionId);
  if (!evalId) return { ok: false, error: "这条结论没有 decisionId，无法与核心记录一一对应" };
  const verdict = str(dec.verdict);
  if (verdict !== "passed" && verdict !== "needs_rework") {
    return { ok: false, error: `结论 ${verdict || "(空)"} 不是可登记的审片结论` };
  }
  const passed = verdict === "passed";
  // `rationale` 是必填项。创作者没写理由时**不编一个** —— 如实写「未填写理由」，
  // 因为核心里那条记录将来会被人读，而「通过（未填写理由）」是真话，
  // 「通过（画面达标）」是我们替他说的话。
  const note = str(dec.note);
  return {
    ok: true,
    name: RECORD_EVALUATION,
    shotId,
    commandId: `cmd-${evalId}`,
    params: {
      evaluation_id: evalId,
      criterion: DAILIES_CRITERION,
      pass: passed,
      rationale: note || (passed ? "创作者审片通过（未填写理由）" : "创作者撤销通过（未填写理由）"),
    },
  };
}

/**
 * AI 导演提的「问题」→ `create-feedback` 的信封素材。
 *
 * 反馈的 actor 在服务端被强制成 `user`（浏览器无权自称 agent），所以 Agent 提出的
 * 问题登记进核心时，**由创作者署名**是准确的：是他决定把这条问题留下来的。
 * 问题本身是谁提的写进 `context.raisedBy`，不假装成人写的。
 */
export function feedbackFor(iss, { raisedBy = "agent" } = {}) {
  if (!iss || typeof iss !== "object") return { ok: false, error: "没有可登记的问题" };
  const shotId = str(iss.locatedShotId) || str(iss.targetId);
  if (!shotId) return { ok: false, error: "这条问题没有定位到镜头，无法登记到核心" };
  const id = str(iss.issueId);
  if (!id) return { ok: false, error: "这条问题没有 issueId" };
  const summary = str(iss.title) || str(iss.summary);
  if (!summary) return { ok: false, error: "这条问题没有标题" };
  return {
    ok: true,
    name: CREATE_FEEDBACK,
    shotId,
    commandId: `cmd-fb-${id}`,
    params: {
      feedback_id: `fb-${id}`,
      summary,
      // detail 必填；问题没有正文时如实说没有，不把标题复制一遍充数
      detail: str(iss.detail) || str(iss.body) || "（没有填写正文）",
      context: {
        layer: str(iss.layer) || "shot",
        severity: str(iss.severity) || "warning",
        raisedBy: str(raisedBy) || "agent",
      },
    },
  };
}

/**
 * 把网关的回答翻译成一句话 + 一个可存的同步状态。
 *
 * 三种「没登记上」被分开，因为它们的下一步动作完全不同：
 *   `blocked`      核心拒绝了（缺项目身份 / 镜头没正式记录）—— 要去补那个前提
 *   `unavailable`  后端不在 / 未连接项目 —— 换个环境再来，不是数据问题
 *   `failed`       网关报错 —— 要看错误本身
 * 全部收进 `ok:false` 会让界面只能说「登记失败」，那正是本仓库反复付代价的那种
 * 「三个事实塌成一个」。
 */
export function explain(result) {
  const r = result && typeof result === "object" ? result : {};
  if (r.state === "recorded") {
    return { state: "recorded", text: `已登记到核心项目 · ${r.recordId || "(无记录号)"}` };
  }
  if (r.state === "blocked") {
    const why = Array.isArray(r.blockers) && r.blockers.length ? r.blockers.join("；") : "核心拒绝了这次登记";
    return { state: "blocked", text: `未登记到核心：${why}` };
  }
  if (r.state === "unavailable") {
    return { state: "unavailable", text: `未登记到核心：${r.detail || "没有连接到后端项目"}` };
  }
  return { state: "failed", text: `未登记到核心：${r.detail || "网关返回了错误"}` };
}

/**
 * 走一遍网关：预检 → 有阻断就停 → 提交。
 *
 * `client` 注入（`{preflight, submit}`），所以本函数在测试里完全可驱动，也因此
 * app.js 那边不需要第二份流程。**预检是只读的**，所以「先问再写」不花任何代价，
 * 换来的是能把 `blockers` 原样说给创作者听。
 */
export async function sendThroughGateway(client, project, spec) {
  if (!spec || !spec.ok) return { state: "failed", detail: (spec && spec.error) || "信封构造失败" };
  if (
    !client
    || typeof client.preflight !== "function"
    || typeof client.submit !== "function"
    || typeof client.target !== "function"
  ) {
    return { state: "unavailable", detail: "没有连接到后端项目" };
  }
  // 先问后端「这一镜的正式记录是什么版本、什么摘要」。问不到不是故障，是
  // **这一镜还没有正式记录** —— 那是最常见的一种「登记不上」，必须说得出来。
  let target;
  try {
    target = await client.target(project, spec.shotId);
  } catch (e) {
    return { state: "blocked", blockers: [(e && e.message) || "这一镜还没有正式镜头记录"] };
  }
  if (!isUsableTarget(target)) {
    return {
      state: "blocked",
      blockers: ["这一镜还没有正式镜头记录（锁定正式分镜后才有），评价无处可挂"],
    };
  }
  const envelope = {
    command_id: spec.commandId,
    name: spec.name,
    target,
    params: spec.params,
  };
  let pf;
  try {
    pf = await client.preflight(project, envelope);
  } catch (e) {
    return { state: "failed", detail: (e && e.message) || "预检失败" };
  }
  const blockers = pf && pf.preview && Array.isArray(pf.preview.blockers) ? pf.preview.blockers : [];
  if (blockers.length) return { state: "blocked", blockers };
  try {
    const receipt = await client.submit(project, envelope, pf && pf.preflight_digest);
    if (receipt && receipt.status === "completed") {
      const oc = (receipt && receipt.outcome) || {};
      return { state: "recorded", recordId: oc.record_id || null, kind: oc.kind || null };
    }
    // AMBIGUOUS / rejected 都不是 completed。**不许当成成功** —— 一次
    // 「可能写了也可能没写」被显示成「已登记」，比没登记更糟。
    return {
      state: "failed",
      detail: `网关回执：${(receipt && receipt.status) || "未知"}${receipt && receipt.reason ? ` · ${receipt.reason}` : ""}`,
    };
  } catch (e) {
    return { state: "failed", detail: (e && e.message) || "提交失败" };
  }
}
