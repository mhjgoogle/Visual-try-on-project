// 脚本生成器 — turns the 剧本 into a shot list (分镜). Re-runnable; each run
// produces an immutable new version (v1, v2…) that can be compared.
import { nx } from "./shared.js";
import { esc } from "../../util/dom.js";

const SKEL9 = '<div class="skel live">' + "<i></i>".repeat(9) + "</div>";

// Each generation snapshots its own immutable shot list. The fixture ships v1/v2;
// any further regeneration derives a deterministic, distinct set so version
// selection and compare always show that version's real data.
export function shotsForVersion(project, v) {
  if (v === 1) return project.shots.v1;
  if (v === 2) return project.shots.v2;
  return project.shots.v2.map((s, i) => (i === 0 ? [s[0], `${s[1]} · v${v}`] : s));
}

function vmenuHtml(node) {
  return `<div class="vmenu">${node.versions
    .map((x) => `<button class="${x.v === node.cur ? "cur" : ""}" data-v="${x.v}">版本 v${x.v}${x.v === node.cur ? " ·当前" : ""}</button>`)
    .join("")}</div>`;
}

export default {
  type: "scriptgen",
  step: 1,
  stage: "S3 镜头拆分",
  title: "脚本生成器",
  icon: "🎞",
  init() {
    return { state: "", prog: 0, versions: [], cur: 0, vmenu: false };
  },
  render(node, ctx) {
    const sd = ctx.project.shots;
    if (node.state === "gen") {
      return `<div class="genbox">${SKEL9}<div class="genprog"><div class="pb"><i style="width:${node.prog}%"></i></div><span class="pc">生成中 ${node.prog}%</span><span class="cx">取消</span></div></div>`;
    }
    if (node.state === "done") {
      const curV = node.versions.find((x) => x.v === node.cur);
      const shots = curV ? curV.shots : sd.v1;
      const isDraft = !!(curV && curV.draft);
      const locked = curV && curV.locked;
      // Locked = this draft version was published as the OFFICIAL plan via the
      // lock-draft-plan Gateway command (ADR-0047); paid generation now derives
      // its prompts/first frames from it. Fresh shot ids → packet v1.
      const badgeText = locked
        ? `已锁定 · plan v${locked.plan_version} · packet v1`
        : curV && curV.edited
          ? "手工编辑 · 未锁定"
          : "草稿 · Claude 生成 · 未锁定";
      const badgeColor = locked ? "var(--ok)" : "var(--gate)";
      const badge = isDraft
        ? `<span style="font-size:10px;color:${badgeColor};border:1px solid color-mix(in srgb,${badgeColor} 40%,var(--line));border-radius:5px;padding:1px 6px;margin-left:6px">${badgeText}</span>`
        : "";
      const vbar = `<div class="vbar"><span class="vchip">v${node.cur} ▾</span>${node.versions.length >= 2 ? '<span class="vcmp">⇄ 对比</span>' : ""}${badge}${node.vmenu ? vmenuHtml(node) : ""}</div>`;
      // Draft rows may carry agent-generated text — escape every row uniformly.
      const rows = shots.map((s) => `<div class="shotrow"><span class="n mono">${esc(s[0])}</span><span class="nm">${esc(s[1])}</span></div>`).join("");
      const total = isDraft ? shots.length : sd.total;
      // The lock Gate (ADR-0047): connected + unlocked draft → offer the
      // preview→confirm publish; an already-locked version never re-locks.
      const lockBtn = isDraft && !locked && ctx.isConnected && ctx.isConnected()
        ? `<button class="nrun ghost" data-lock>🔒 锁定为正式分镜</button>`
        : "";
      return `<div class="genbox">${vbar}${rows}<div style="font-size:11px;color:var(--text-faint);margin:2px 2px 0">…共 ${total} 个镜头</div><div class="vbtns"><button class="nrun ghost" data-run>重新生成（新版本）</button><button class="nrun ghost" data-edit>✎ 编辑分镜</button>${lockBtn}</div>${nx([["assets", "准备资产"]])}</div>`;
    }
    return `<div class="genbox"><div class="skel"><i></i><i></i><i></i><i></i><i></i><i></i></div><button class="nrun" data-run>基于剧本生成分镜</button></div>`;
  },
  run(node, ctx) {
    // CONNECTED: the REAL creative agent (ADR-0042) — the user's canvas script
    // goes to the local Claude CLI and comes back as a structured shot DRAFT.
    if (ctx.isConnected && ctx.isConnected() && ctx.agentShotsDraft) {
      const script = ctx.getScriptText ? ctx.getScriptText() : "";
      if (!script.trim()) { ctx.toast("剧本为空：先在「剧本」节点写内容"); return; }
      node.state = "gen";
      node.prog = 15; // indeterminate — real call takes seconds to ~1min
      ctx.refresh(node);
      ctx.markIncoming(node.id, "active");
      node._pulse = setInterval(() => {
        node.prog = 15 + ((node.prog - 15 + 7) % 75);
        ctx.refresh(node);
      }, 800);
      ctx
        .agentShotsDraft(script)
        .then((shots) => {
          clearInterval(node._pulse);
          node._pulse = null;
          if (node.state !== "gen") return; // user cancelled meanwhile
          const rows = shots.map((s) => [
            String(s.sequence).padStart(2, "0"),
            `${s.title} — ${s.description}（${s.duration_seconds}s）`,
          ]);
          const v = node.versions.length + 1;
          // Stable per-shot SLOT ids: uploads attach to a shot's slot, so an
          // image can never leak onto a different shot after edits/regeneration.
          shots.forEach((s, i) => { s.slot = `v${v}-${i + 1}`; });
          // Keep the raw draft on the version so switching versions can restore
          // the matching draftShots (downstream prefill must follow selection).
          node.versions.push({ v, shots: rows, draft: true, raw: shots });
          node.cur = v;
          node.state = "done";
          ctx.project.draftShots = shots; // downstream nodes prefill from this
          ctx.refresh(node);
          ctx.markIncoming(node.id, "done");
          if (ctx.persist) ctx.persist(); // survive an immediate reload
          ctx.toast(`Claude 分镜草稿完成 · ${shots.length} 个镜头（未锁定）`);
        })
        .catch((e) => {
          clearInterval(node._pulse);
          node._pulse = null;
          node.state = "";
          node.prog = 0;
          ctx.markIncoming(node.id, "");
          ctx.refresh(node);
          ctx.toast("分镜生成失败：" + e.message);
        });
      return;
    }
    // demo mode: the offline fixture animation
    node.state = "gen";
    node.prog = 6;
    ctx.refresh(node);
    ctx.markIncoming(node.id, "active");
    node._timer = setInterval(() => {
      node.prog += Math.floor(Math.random() * 14) + 6;
      if (node.prog >= 100) {
        node.prog = 100;
        clearInterval(node._timer);
        node._timer = null;
        node.state = "done";
        const v = node.versions.length + 1;
        node.versions.push({ v, shots: shotsForVersion(ctx.project, v) });
        node.cur = v;
        ctx.refresh(node);
        ctx.markIncoming(node.id, "done");
        ctx.toast(v > 1 ? `重新生成完成 · 新版本 v${v}（可对比 v${v - 1}）` : "分镜完成 · 11 个镜头就绪。下一步：准备资产");
      } else {
        ctx.refresh(node);
      }
    }, 400);
  },
  bind(node, el, ctx) {
    const cx = el.querySelector(".cx");
    if (cx) cx.onclick = (e) => {
      e.stopPropagation();
      if (node._timer) { clearInterval(node._timer); node._timer = null; }
      if (node._pulse) { clearInterval(node._pulse); node._pulse = null; }
      node.state = ""; node.prog = 0;
      ctx.markIncoming(node.id, ""); // clear the incoming edge's "generating" state
      ctx.refresh(node);
    };
    const vch = el.querySelector(".vchip");
    if (vch) vch.onclick = (e) => { e.stopPropagation(); node.vmenu = !node.vmenu; ctx.refresh(node); };
    // Wire the version-menu buttons here — bind() re-runs on every (re)render with
    // the current body element, so this never depends on querying a stale element
    // from inside the click handler.
    const menu = el.querySelector(".vmenu");
    if (menu)
      menu.querySelectorAll("button").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        node.cur = +b.dataset.v;
        node.vmenu = false;
        // Sync downstream prefill to the SELECTED version: a draft version
        // restores its own shots, a non-draft (demo) version clears them so
        // assets falls back to fixtures — never leave stale draftShots behind.
        const sel = node.versions.find((x) => x.v === node.cur);
        ctx.project.draftShots = sel && sel.raw ? sel.raw : null;
        // the lock state follows the selected version (a locked v2 stays
        // locked when the user flips back to it; an unlocked v3 is unlocked)
        ctx.project.lockedPlan = (sel && sel.locked) || null;
        ctx.refresh(node);
        if (ctx.refreshType) ctx.refreshType("assets");
        if (ctx.refreshType) ctx.refreshType("video");
        ctx.toast(`切到版本 v${node.cur}（digest 绑定）`);
      }));
    const vcmp = el.querySelector(".vcmp");
    if (vcmp) vcmp.onclick = (e) => { e.stopPropagation(); ctx.inspector.openCompare(node); };
    // 锁定为正式分镜 (ADR-0047): preview modal → confirmed Gateway submit
    const lk = el.querySelector("[data-lock]");
    if (lk && ctx.lockDraft)
      lk.onclick = (e) => { e.stopPropagation(); ctx.lockDraft(node); };
    // Manual edit (人工 Gate): edit the CURRENT version's shots and save as a
    // NEW immutable draft version — history is never overwritten (§1.2).
    const ed = el.querySelector("[data-edit]");
    if (ed && ctx.shotEditor)
      ed.onclick = (e) => {
        e.stopPropagation();
        const curV = node.versions.find((x) => x.v === node.cur);
        if (!curV) return;
        // Draft versions carry structured raw shots; fixture versions only have
        // display rows — derive an editable structure from them.
        const initial = curV.raw
          ? curV.raw
          : curV.shots.map((r, i) => ({ sequence: i + 1, title: r[1], description: "", duration_seconds: 6 }));
        ctx.shotEditor.open(initial, {
          subtitle: `基于 v${node.cur} → 保存为 v${node.versions.length + 1}（手工编辑）`,
          // surviving shots keep their slot (their uploaded image follows them);
          // newly added shots get fresh slots under the new version's prefix.
          slotPrefix: `v${node.versions.length + 1}`,
          onSave: (edited) => {
            const rows = edited.map((s) => [
              String(s.sequence).padStart(2, "0"),
              `${s.title} — ${s.description}（${s.duration_seconds}s）`,
            ]);
            const v = node.versions.length + 1;
            node.versions.push({ v, shots: rows, draft: true, edited: true, raw: edited });
            node.cur = v;
            node.state = "done";
            ctx.project.draftShots = edited;
            ctx.refresh(node);
            if (ctx.refreshType) ctx.refreshType("assets");
            if (ctx.persist) ctx.persist();
            ctx.toast(`已保存手工编辑为 v${v} · ${edited.length} 个镜头（未锁定）`);
          },
        });
      };
  },
  next: ["assets"],
};
