// Pre-generation budget preflight. Any PAID Provider generation (video / image /
// audio) must pass through this before spend: shows P50/P90, current balance, the
// projected post-generation balance (by P90), and blocks when funds are short.
// Mirrors the S3/S4 P50/P90 preflight + reservation-hold discipline.
import { $ } from "../util/dom.js";
import * as budget from "../services/budget.js";
import { submitCommand } from "../services/gateway.js";

export function createEstimate({ renderBudget, toast }) {
  const scrim = $("#es-scrim");
  let onOk = null;

  $("#es-cancel").onclick = () => scrim.classList.remove("show");
  $("#es-ok").onclick = () => {
    scrim.classList.remove("show");
    if (onOk) onOk();
    onOk = null;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && scrim.classList.contains("show")) scrim.classList.remove("show");
  });

  /**
   * @param {{cmd,kind,count,p50,p90,actual,label,after?}} o
   */
  function open(o) {
    const y = budget.yuan;
    const bal = budget.balance();
    const afterBal = bal - o.p90;
    const proj = budget.curProject();
    const projLeft = budget.projectBudget() - proj.spent;
    const projAfter = projLeft - o.p90;
    // Fail closed if EITHER the account balance OR the project's own budget
    // would be exceeded by P90 (mirrors per-project + account budget guards).
    const block = afterBal < 0 || projAfter < 0;
    const reason = afterBal < 0 ? "账户余额不足" : projAfter < 0 ? "超出本项目预算" : "无";
    $("#es-cmd").textContent = o.cmd;
    $("#es-b").innerHTML = `
      <div class="es-blk"><div class="es-row"><span class="l">生成内容</span><span class="v">${o.kind} × ${o.count}</span></div><div class="es-row"><span class="l">Provider</span><span class="v">minimax（经 Command Gateway）</span></div></div>
      <div class="es-blk"><div class="es-row"><span class="l">预计成本 P50</span><span class="v">${y(o.p50)}</span></div><div class="es-row"><span class="l">预计成本 P90（含重试）</span><span class="v">${y(o.p90)}</span></div></div>
      <div class="es-blk"><div class="es-row"><span class="l">本项目预算余量</span><span class="v">${y(projLeft)} / ${y(budget.projectBudget())}</span></div><div class="es-row"><span class="l">账户余额</span><span class="v">${y(bal)}</span></div><div class="es-row big"><span class="l">预计生成后（本项目，按 P90）</span><span class="v" style="color:${projAfter < 0 ? "var(--bad)" : "var(--ok)"}">${y(projAfter)}</span></div><div class="es-row"><span class="l">阻断项</span><span class="v" style="color:${block ? "var(--bad)" : "var(--ok)"}">${reason}</span></div></div>
      <div class="es-warn">先按 P90 冻结预算 hold；实际以 Provider 结算为准，超支自动阻断。此操作不直接改文件，经 Command Gateway 预检提交。</div>`;
    const okBtn = $("#es-ok");
    okBtn.disabled = block;
    okBtn.textContent = block ? reason + "，无法生成" : "确认生成";
    onOk = block
      ? null
      : () => {
          submitCommand({ name: "generate", params: { kind: o.kind, count: o.count } });
          budget.spend(o.actual);
          renderBudget();
          toast(`${o.label} · 本项目已花 ${y(budget.curProject().spent)}，账户余额 ${y(budget.balance())}`);
          if (o.after) o.after();
        };
    scrim.classList.add("show");
  }

  return { open };
}
