// Pre-generation budget preflight. Any PAID Provider generation (video / image /
// audio) must pass through this before spend: shows P50/P90, current balance, the
// projected post-generation balance (by P90), and blocks when funds are short.
// Mirrors the S3/S4 P50/P90 preflight + reservation-hold discipline.
import { $, esc } from "../util/dom.js";
import * as budget from "../services/budget.js";
import { submitCommand } from "../services/command.js";

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

  /** REAL preflight confirmation (paid mode): renders the Gateway's read-only
   *  preview (locked-catalog cost, blockers, downstream) and, when clean, arms
   *  the HIGH-risk confirmed submit — this is the human confirmation step that
   *  authorizes the ~USD 0.28 spend. */
  function openReal(pf, { onConfirm }) {
    const p = pf.preview || {};
    const cost = p.estimated_cost;
    const blockers = p.blockers || [];
    const block = blockers.length > 0;
    // Every Gateway-derived value is escaped: this dialog is the SPEND CONSENT
    // surface, so project-controlled content must never inject DOM into it.
    $("#es-cmd").textContent = `${pf.name} · 真实提交（HIGH-risk）`;
    const inputRows = Object.entries(p.inputs || {})
      .map(([k, v]) => `<div class="es-row"><span class="l">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
      .join("");
    const costHtml = cost
      ? `<div class="es-row big"><span class="l">锁定目录报价</span><span class="v">${esc(cost.jpy)} JPY（${esc(cost.original_currency)} ${esc((cost.original_amount_minor_units / 100).toFixed(2))}）</span></div>`
      : `<div class="es-row"><span class="l">报价</span><span class="v">不可用</span></div>`;
    const blockHtml = block
      ? `<div class="es-blk" style="border-color:var(--bad)">${blockers.map((b) => `<div class="es-row"><span class="l" style="color:var(--bad)">阻断</span><span class="v">${esc(b)}</span></div>`).join("")}</div>`
      : `<div class="es-row"><span class="l">阻断项</span><span class="v" style="color:var(--ok)">无</span></div>`;
    $("#es-b").innerHTML = `
      <div class="es-blk">${inputRows}</div>
      <div class="es-blk">${costHtml}${blockHtml}</div>
      <div class="es-blk">${(p.downstream || []).map((d) => `<div class="es-row"><span class="l">下游</span><span class="v">${esc(d)}</span></div>`).join("")}</div>
      <div class="es-warn">确认即以 preflight digest 授权本次<b style="color:var(--text)">真实付费生成</b>（经 Command Gateway → coordinator；审批/预算/reservation 已预检）。digest: <span class="v" style="word-break:break-all">${esc(pf.preflight_digest)}</span></div>`;
    const okBtn = $("#es-ok");
    okBtn.disabled = block;
    okBtn.textContent = block ? "存在阻断项，无法提交" : "确认真实生成（付费）";
    onOk = block ? null : () => onConfirm(pf.preflight_digest);
    scrim.classList.add("show");
  }

  /** Draft-lock confirmation (ADR-0047): renders the Gateway preview of the
   *  FULL shot table the lock will publish (title/description/duration/首帧)
   *  plus the new plan/packet versions, and arms the HIGH-risk confirmed
   *  submit. Locking spends nothing — this Gate authorizes the official
   *  versioned publish, not any payment. */
  function openLock(pf, { onConfirm }) {
    const p = pf.preview || {};
    const inputs = p.inputs || {};
    const blockers = p.blockers || [];
    const block = blockers.length > 0;
    // Everything shown is Gateway-derived, agent/user-authored content —
    // escaped uniformly (this dialog is the lock CONSENT surface).
    $("#es-cmd").textContent = `${pf.name} · 锁定为正式分镜（HIGH-risk · 不花费）`;
    const shots = inputs.shots || [];
    const shotRows = shots
      .map((s) => {
        const frame = s.first_frame_sha256
          ? `<span style="color:var(--ok)">✓ 首帧图</span>`
          : `<span style="color:var(--text-faint)">无首帧</span>`;
        return `<div class="es-row"><span class="l">${esc(String(s.sequence).padStart(2, "0"))} ${esc(s.title)}</span><span class="v">${esc(s.description)}（${esc(s.duration_seconds)}s · ${frame} · ${esc(s.shot_id)} packet v${esc(s.packet_version)}）</span></div>`;
      })
      .join("");
    const blockHtml = block
      ? `<div class="es-blk" style="border-color:var(--bad)">${blockers.map((b) => `<div class="es-row"><span class="l" style="color:var(--bad)">阻断</span><span class="v">${esc(b)}</span></div>`).join("")}</div>`
      : `<div class="es-row"><span class="l">阻断项</span><span class="v" style="color:var(--ok)">无</span></div>`;
    $("#es-b").innerHTML = `
      <div class="es-blk"><div class="es-row"><span class="l">当前计划</span><span class="v">shot plan v${esc(inputs.plan_version)}</span></div><div class="es-row big"><span class="l">锁定后</span><span class="v">shot plan v${esc(inputs.new_plan_version)} · ${esc(shots.length)} 镜头（新版本，不覆盖旧版）</span></div></div>
      <div class="es-blk">${shotRows}</div>
      <div class="es-blk">${(p.downstream || []).map((d) => `<div class="es-row"><span class="l">下游</span><span class="v">${esc(d)}</span></div>`).join("")}${blockHtml}</div>
      <div class="es-warn">确认即以 preflight digest 授权把上述草稿发布为<b style="color:var(--text)">正式 plan/records/packet 新版本</b>并重批 production_lock（人工 Gate；不花费）。此后付费视频的提示词/首帧即来自该草稿。digest: <span class="v" style="word-break:break-all">${esc(pf.preflight_digest)}</span></div>`;
    const okBtn = $("#es-ok");
    okBtn.disabled = block;
    okBtn.textContent = block ? "存在阻断项，无法锁定" : "确认锁定（不花费）";
    onOk = block ? null : () => onConfirm(pf.preflight_digest);
    scrim.classList.add("show");
  }

  return { open, openReal, openLock };
}
