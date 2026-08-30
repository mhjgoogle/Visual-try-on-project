// 对话流 —— 他说的、Agent 回的、这一轮正在做什么。
//
// SHAPE (REQ-004 v2): 上面是流，底部是输入框。像他每天用的那个对话框，而不是一叠面板。
//
// WHAT EACH TURN MUST SAY, and why:
//   * 他说的话         —— 一个答案在没有问题的情况下出现，读者无法判断它在回答什么
//   * Agent 回的话     —— 正文
//   * 这一轮的状态      —— 排队 / 正在想 / 失败，来自 RUN 状态（ADR-0089 决策 5），
//                        不是 Agent 自称的进度：自称的进度在进程死掉时会永远停在
//                        「进行中」
//   * 它想改什么        —— edits 是**待应用的意图**，由创作者自己那条编辑路径落地
//                        （决策 2b）。屏幕上必须区分「它说要改」和「已经改了」
//   * 它做不到什么      —— unsupported 保留而不是丢掉：一个被静默丢弃的意图，
//                        看起来就是「它答应了然后什么都没干」
import { esc } from "../util/dom.js";
import { actionCatalog, knownAction } from "../workflow/convactions.js";

const STATUS_ZH = {
  queued: "排队中",
  running: "正在想…",
  succeeded: "",
  failed: "失败",
  cancelled: "已取消",
  cancelling: "正在取消",
  awaiting_input: "等待输入",
  unknown: "状态未知",
};

//: 动作的中文名来自**注册表**（前端拥有那些按钮），所以屏幕上的说法与提示词里给模型的
//: 说法永远是同一份。表里没有的 kind → 「本应用还做不到」。
const ACTION_LABEL = Object.fromEntries(actionCatalog().map((a) => [a.id, a.label]));
//: 服务端**自己**处理的那几种：它们不在前端注册表里，但它们做得到，所以不能被归进
//: 「本应用还做不到」（真机上就撞见过：一条答复同时出现在两个标题下面）。
const SERVER_KINDS = new Set(["feedback.ui", "proposal.decide", "dev.request"]);
const EDIT_ZH = {
  ...ACTION_LABEL,
  "feedback.ui": "记下你的意见",
  "proposal.decide": "答复开发的提案",
  "dev.request": "让开发出方案",
};

/** Pure view model: what the column shows, from the thread the server gave. */
export function threadModel(
  turns,
  { pendingRun = null, pendingStatus = "", applied = {}, routeState = {} } = {},
) {
  const landed = applied && typeof applied === "object" ? applied : {};
  const routes = routeState && typeof routeState === "object" ? routeState : {};
  const rows = (Array.isArray(turns) ? turns : []).map((t) => ({
    turnId: String(t.turnId || ""),
    role: t.role === "agent" ? "agent" : "user",
    text: String(t.text || ""),
    runId: t.runId || null,
    status: String(t.status || ""),
    failure: t.failure ? String(t.failure) : "",
    failureCategory: t.failureCategory ? String(t.failureCategory) : "",
    // WHO DECIDES 「做得到 / 做不到」：注册表在前端，所以判定也在前端。服务端只做
    // 形状约束（它不知道界面上有哪些按钮）。`feedback.ui` 由服务端自己落地，算做得到。
    edits: (Array.isArray(t.edits) ? t.edits : []).filter(
      (e) => e && (knownAction(e.kind) || SERVER_KINDS.has(e.kind)),
    ),
    unsupported: (Array.isArray(t.unsupported) ? t.unsupported : []).concat(
      (Array.isArray(t.edits) ? t.edits : []).filter(
        (e) => e && !knownAction(e.kind) && !SERVER_KINDS.has(e.kind),
      ),
    ),
    // 这一轮识别到的能力（TASK-119）。三样东西必须分开，因为创作者的下一步不同：
    //   route          它识别到了什么、为什么
    //   routeRejected  服务端拒了它（编造的 skillId / 错的窗口）——「没启动」+ 原因
    //   routeState     真的起跑了没有、缺什么、结果在哪（由调用方从登记表算出来）
    route: t.route && typeof t.route === "object" ? t.route : null,
    routeRejected:
      t.routeRejected && typeof t.routeRejected === "object" ? t.routeRejected : null,
    // WHAT ACTUALLY LANDED, keyed by the run that proposed it. 「它说要改」 and
    // 「已经改了」 stay separate rows on screen (决策 2b): an edit that was applied
    // moves OUT of 「还没落到作品上」 and says which version it became.
    //
    // THE TURN'S OWN `applied` WINS. It is the回执 the server stored, so it survives
    // a refresh; the in-memory map only covers the moment between applying and the
    // thread's next read.
    applied: (Array.isArray(t.applied) && t.applied.length
      ? t.applied
      : (t.runId && Array.isArray(landed[t.runId]) ? landed[t.runId] : [])),
    routeState: (t.runId && routes[t.runId]) || null,
  })).map((r) => (r.applied.length
    // an edit that landed is no longer 「建议」 —— 同一条不能在两个标题下各出现一次
    ? { ...r, edits: r.edits.filter((e) => !r.applied.some((a) => a.kind === e.kind)) }
    : r));
  // The turn in flight has no agent row yet; it is shown as one so the column
  // never looks like the message vanished.
  const answered = new Set(rows.filter((r) => r.role === "agent").map((r) => r.runId));
  const waiting = pendingRun && !answered.has(pendingRun)
    ? { runId: pendingRun, status: pendingStatus || "queued" }
    : null;
  return { rows, waiting, empty: rows.length === 0 && !waiting };
}


function editList(items, { supported, runId = "" }) {
  if (!items.length) return "";
  const label = supported ? "它建议的改动（还没落到作品上）" : "它想做但本应用还做不到";
  // AN OUTSTANDING PROPOSAL NEEDS A WAY OUT. 一轮的自动落地可能没发生（页面在旧代码上、
  // 轮询超时、当时开着的是别的标签页）—— 那时屏幕上就剩「它说改好了」+「还没落到作品上」
  // 互相打脸，而他没有任何办法把它落下（产品负责人 2026-08-29:「好像是改了没显示」）。
  const canApply = supported && runId && items.some((e) => knownAction(e.kind));
  const act = canApply
    ? `<button class="cv-apply" data-cv-apply="${esc(String(runId))}">落到作品上</button>`
    : "";
  const rows = items
    .map((e) => {
      const kind = supported
        ? EDIT_ZH[e.kind] || e.kind || "改动"
        : e.kind || "未知动作";
      return (
        `<li class="cv-edit${supported ? "" : " unsup"}">` +
        `<span class="k">${esc(String(kind))}</span>` +
        `<span class="t">${esc(String(e.text || ""))}</span></li>`
      );
    })
    .join("");
  return (
    `<div class="cv-editswrap"><div class="lab">${esc(label)}${act}</div>` +
    `<ul class="cv-edits">${rows}</ul></div>`
  );
}

//: 一次运行在屏幕上的说法。与 `RUN_STATUS_LABEL` 同义但**只覆盖这里会出现的那些**
//: —— 一个自动起跑的能力永远不会停在「待确认」。
const ROUTE_RUN_ZH = {
  queued: "排队中",
  running: "正在跑…",
  awaiting_input: "等你把结果贴回来",
  cancelling: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "没跑成",
};

const SCOPE_ZH = { project: "整个项目", episode: "当前分集", shot: "当前镜头" };

//: 他看得见的是**这一类工作**，不是内部专业能力的 id（ADR-0091 决策 5）。
//: 屏幕上说「我按检查问题来处理」，而不是「我调用了 script-doctor v2」。
const CAPABILITY_ZH = {
  "story-development": "开发故事",
  "episode-production": "制作这一集",
  "story-review": "检查问题",
};

/** 「它识别到要用哪个能力」这一段。
 *
 *  三件事必须在屏幕上分开（REQ-007 判据 3 的同一条道理）：**识别到了什么**、
 *  **有没有真的起跑**、**结果在哪 / 为什么没跑**。把它们并成一句「已处理」，
 *  就是创作者看着一个什么都没发生的界面以为事情做完了。 */
function routeBlock(r) {
  if (r.routeRejected) {
    return (
      `<div class="cv-routewrap bad"><div class="lab">没有启动能力</div>` +
      `<div class="t">${esc(String(r.routeRejected.reason || ""))}</div></div>`
    );
  }
  if (!r.route) return "";
  const st = r.routeState || {};
  // 显示的是**这一类工作**（他说得出口的那三个之一），不是内部能力的 id。
  const title = esc(String(CAPABILITY_ZH[r.route.capability] || r.route.capability || ""));
  const scope = SCOPE_ZH[r.route.scope] || "";
  const why = r.route.reason ? `<div class="t">${esc(String(r.route.reason))}</div>` : "";
  let head = "按这一类来处理";
  let body = "";
  let act = "";
  if (st.status) {
    // 起跑了：状态来自**登记表**，不是它自称的进度 —— 与对话轮的状态同一条纪律
    // （ADR-0089 决策 5），进程死掉时不会永远停在「正在跑」。
    head = "已经开始做了";
    body =
      `<div class="t"><span class="chip${st.status === "failed" ? " bad" : " mute"}">` +
      `${esc(ROUTE_RUN_ZH[st.status] || st.status)}</span>` +
      (st.status === "succeeded"
        // 「能力」面板在三栏重构里已经删掉了（REQ-004 v2 只留一个对话）。
        // 让他去一个不存在的面板，等于跑完了什么也用不上 —— 产品负责人 2026-08-30
        // 因此看到「已完成」而故事大纲still是空的。**决定就在这条消息上做。**
        ? "写好了 —— 要用就点右边这个按钮，我把它写进那一页。"
        : st.status === "failed"
        ? esc(String(st.error || "没有记录失败原因"))
        : "") +
      `</div>`;
  } else if (st.reason) {
    // 没起跑：**说清为什么**，并给出他自己点的那条路（ADR-0065 决策 2 手工兜底）。
    head = "这次没有自动开始";
    body = `<div class="t">${esc(String(st.reason))}</div>`;
    if (st.canOpen) {
      act = `<button class="cv-apply" data-cv-route="${esc(String(st.skillId || ""))}">去运行</button>`;
    }
  }
  if (st.status === "succeeded" && st.runId) {
    act =
      `<button class="cv-apply" data-cv-use="${esc(String(st.runId))}">用它</button>` +
      `<button class="cv-apply ghost" data-cv-drop="${esc(String(st.runId))}">不用</button>`;
  }
  return (
    `<div class="cv-routewrap"><div class="lab">${esc(head)}${act}</div>` +
    `<div class="cv-route"><span class="k">${title}</span>` +
    (scope ? `<span class="chip mute">${esc(scope)}</span>` : "") +
    `</div>${why}${body}</div>`
  );
}

export function renderThread(m) {
  if (m.empty) {
    return (
      `<div class="cv-empty">还没有对话。<br>在下面说一句话 —— 我会先把这个项目的` +
      `现状读一遍，再回答你。</div>`
    );
  }
  const rows = m.rows
    .map((r) => {
      if (r.role === "user") {
        return `<div class="cv-turn user"><div class="cv-tx">${esc(r.text)}</div></div>`;
      }
      const status = r.status && r.status !== "succeeded"
        ? `<span class="chip${r.status === "failed" ? " bad" : " mute"}">${esc(STATUS_ZH[r.status] || r.status)}</span>`
        : "";
      const failure = r.failure
        ? `<div class="cv-fail">没能完成：${esc(r.failure)}` +
          (r.failureCategory ? `<span class="chip bad">${esc(r.failureCategory)}</span>` : "") +
          `</div>`
        : "";
      // No avatar (产品负责人 2026-08-27:「机器人的图不需要」). The turn is already
      // distinguishable by its own block; a status chip appears only when there IS
      // a status worth saying, so a normal answer carries no chrome at all.
      // 失败的那一条不许同时挂在「已落到作品上」下面 —— 它没落下
      const ok = r.applied.filter((a) => !a.error);
      const applied = ok.length
        ? `<div class="cv-editswrap"><div class="lab ok">已落到作品上</div>` +
          `<ul class="cv-edits">` +
          ok
            .map((a) => (
              `<li class="cv-edit done"><span class="k">${esc(EDIT_ZH[a.kind] || a.kind || "改动")}</span>` +
              `<span class="t">${esc(String(a.detail || a.text || ""))}</span></li>`
            ))
            .join("") +
          `</ul></div>`
        : "";
      const failedApply = r.applied.filter((a) => a.error);
      const applyFail = failedApply.length
        ? `<div class="cv-fail">有改动没能落下：` +
          esc(failedApply.map((a) => a.error).join("；")) +
          `</div>`
        : "";
      return (
        `<div class="cv-turn agent">` +
        (status ? `<div class="cv-h">${status}</div>` : "") +
        (r.text ? `<div class="cv-tx">${esc(r.text)}</div>` : "") +
        failure +
        applied +
        applyFail +
        routeBlock(r) +
        editList(r.edits, { supported: true, runId: r.runId || "" }) +
        editList(r.unsupported, { supported: false }) +
        `</div>`
      );
    })
    .join("");
  const waiting = m.waiting
    ? `<div class="cv-turn agent waiting"><div class="cv-h">` +
      `<span class="chip mute">${esc(STATUS_ZH[m.waiting.status] || m.waiting.status)}</span>` +
      `<button class="as-cx" data-cv-cancel="${esc(m.waiting.runId)}" title="取消这一轮">✕</button>` +
      `</div><div class="cv-skel"><i></i><i></i><i></i></div></div>`
    : "";
  return `<div class="cv-thread">${rows}${waiting}</div>`;
}
