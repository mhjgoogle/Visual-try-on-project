// Right-side inspector: node → its L0–S7 contract (input/output lock binding,
// Gate, steps); version compare; account cost breakdown. Reads contract.js and
// the budget seam only — never core internals.
import { $, el } from "../util/dom.js";
import { stageOf } from "../workflow/contract.js";
import * as budget from "../services/budget.js";

export function createInspector() {
  const insp = $("#insp"), scrim = $("#scrim"), tEl = $("#insp-t"), sEl = $("#insp-s"), bEl = $("#insp-b");
  const show = () => { insp.classList.add("show"); scrim.classList.add("show"); };
  const close = () => { insp.classList.remove("show"); scrim.classList.remove("show"); };
  $("#insp-x").onclick = close;
  scrim.onclick = close;

  function openNode(node) {
    const st = stageOf(node.stage);
    tEl.textContent = node.title;
    sEl.textContent = node.stage || "";
    bEl.innerHTML = "";
    if (!st) {
      bEl.innerHTML = `<p style="color:var(--text-dim);font-size:13px">该节点为工具节点。</p>`;
      show();
      return;
    }
    // input -> output lock binding
    const io = el("div", "sec");
    io.appendChild(el("span", "eyebrow", "输入 → 输出 绑定"));
    const inr = el("div", "io-row");
    if (!st.in.length) {
      const s = el("span", null, "— 用户首次创作输入");
      s.style.cssText = "font-size:12px;color:var(--text-faint)";
      inr.appendChild(s);
    }
    st.in.forEach((l) => {
      const c = el("span", "lockchip");
      c.innerHTML = `<span class="d ok"></span>${l}`;
      inr.appendChild(c);
    });
    io.appendChild(inr);
    const ar = el("div");
    ar.style.cssText = "text-align:center;color:var(--accent);margin:7px 0;font-size:17px";
    ar.textContent = "↓";
    io.appendChild(ar);
    const outr = el("div", "io-row");
    const oc = el("span", "lockchip out");
    oc.innerHTML = `<span class="d acc"></span>🔒 ${st.lock}`;
    outr.appendChild(oc);
    io.appendChild(outr);
    const dn = el("div", "digest-note");
    dn.innerHTML = `<span class="ok">ref + version + content_digest 绑定 ✓</span> · 上游漂移则下游 readiness 失效（合同 §1.1）`;
    io.appendChild(dn);
    bEl.appendChild(io);
    // gate
    const g = el("div", "sec");
    g.appendChild(el("span", "eyebrow", "离开本阶段的 Gate（§11）"));
    const gb = el("div", "gatebox");
    gb.innerHTML = `<div class="gt">人工 Gate</div>${st.gate}`;
    g.appendChild(gb);
    bEl.appendChild(g);
    // steps
    const ss = el("div", "sec");
    ss.appendChild(el("span", "eyebrow", "关键步骤 · 输入 → 输出"));
    st.steps.forEach(([id, nm, ex, i, o]) => {
      const s = el("div", "step");
      s.innerHTML = `<div class="st"><span class="id mono">${id}</span><span class="nm">${nm}</span><span class="ex">${ex}</span></div><div class="io"><b>输入</b> ${i}<br><b>输出</b> ${o}</div>`;
      ss.appendChild(s);
    });
    bEl.appendChild(ss);
    show();
  }

  function openCompare(node) {
    tEl.textContent = "版本对比 · " + node.title;
    sEl.textContent = node.stage;
    bEl.innerHTML = "";
    // Compare the current version against the previous one, using each version's
    // own immutable shot snapshot (never a stale fixture branch).
    const vs = node.versions || [];
    const bV = vs.find((x) => x.v === node.cur) || vs[vs.length - 1];
    const aV = vs.find((x) => x.v === node.cur - 1) || vs[vs.length - 2] || vs[0];
    const sec = el("div", "sec");
    sec.appendChild(el("span", "eyebrow", `脚本生成器 · v${aV ? aV.v : "?"} ⇄ v${bV ? bV.v : "?"}（digest 各自绑定）`));
    const cmp = el("div", "cmp");
    [aV, bV].forEach((ver) => {
      const shots = ver ? ver.shots : [];
      const other = (ver === aV ? bV : aV) ? (ver === aV ? bV : aV).shots : [];
      const col = el("div", "col");
      col.innerHTML = `<div class="ch">${ver && ver.v === node.cur ? "当前" : "历史"} <span class="vc">v${ver ? ver.v : "?"}</span></div>`;
      shots.forEach((s, idx) => {
        const diff = other[idx] && other[idx][1] !== s[1];
        const r = el("div", "shotrow" + (diff ? " diff" : ""));
        r.innerHTML = `<span class="n mono">${s[0]}</span><span class="nm">${s[1]}</span>`;
        col.appendChild(r);
      });
      cmp.appendChild(col);
    });
    sec.appendChild(cmp);
    const note = el("div", "digest-note");
    note.innerHTML = "金框 = 两版差异。每次生成产生不可变新版本并保留来源，切换不覆盖历史（§1.2）。";
    sec.appendChild(note);
    bEl.appendChild(sec);
    show();
  }

  function openCost() {
    const y = budget.yuan;
    tEl.textContent = "账户预算 · 各项目花费";
    sEl.textContent = `总预算 ${y(budget.accountTotal())} · 已花 ${y(budget.totalSpent())} · 余额 ${y(budget.balance())}`;
    bEl.innerHTML = "";
    const sec = el("div", "sec");
    sec.appendChild(el("span", "eyebrow", "按项目 · 已花 / 预算（每币种独立）"));
    budget.projectsList().forEach((p) => {
      const pt = budget.projectBudget();
      const pct = Math.min(100, Math.round((p.spent / pt) * 100));
      const row = el("div", "step");
      row.innerHTML = `<div class="st"><span class="nm">${p.cur ? "▶ " : ""}${p.name}</span><span class="ex" style="border:none;color:var(--text-dim)">${y(p.spent)} / ${y(pt)}</span></div><div class="bar"><i style="display:block;height:100%;width:${pct}%;background:${p.cur ? "var(--accent)" : "var(--line-2)"}"></i></div>`;
      sec.appendChild(row);
    });
    const tot = el("div", "step");
    tot.style.borderColor = "var(--line-2)";
    tot.innerHTML = `<div class="st"><span class="nm">账户合计</span><span class="ex" style="border:none;color:var(--text)">已花 ${y(budget.totalSpent())} · 余额 ${y(budget.balance())}</span></div>`;
    sec.appendChild(tot);
    bEl.appendChild(sec);
    const note = el("div", "digest-note");
    note.innerHTML = "金额为权威成本事实的只读投影（QCD/结算）；每种货币独立不合并（WQ-07）。";
    bEl.appendChild(note);
    show();
  }

  return { openNode, openCompare, openCost, close };
}
