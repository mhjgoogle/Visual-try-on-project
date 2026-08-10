// 存储管理 (M11-D) — the minimal project-storage surface, built ENTIRELY on
// the existing M5 storageState lifecycle (local/archived/missing/deleted —
// no second state system) plus the M11 reference scan.
//
// Actions: Archive（隐藏）/ Remove Local Copy（默认推荐：删字节，身份/元数据/
// 溯源/引用全保留，媒体处显示不可用）/ Permanent Delete（显式破坏性操作：
// 二次确认；被 镜头首帧/角色/场景地/时间线 等阻断性引用时拒绝——绝不静默断引用）。
import { esc } from "../util/dom.js";

const DOMAIN_ZH = { images: "图片", videos: "视频", audio: "音频", finals: "成片", firstFrames: "首帧" };

/** Pure stats + rows over the registry with reference awareness. */
export function storageModel({ reg, referencesOf }) {
  const rows = [];
  const walkChain = (domain) => {
    const m = reg[domain] || {};
    for (const key of Object.keys(m)) {
      const e = m[key];
      if (!e || !Array.isArray(e.history)) continue;
      for (const r of e.history) {
        if (!r || !r.assetId) continue;
        rows.push({
          assetId: r.assetId, domain, key, version: r.version,
          origin: r.origin || "", url: r.url || "",
          state: r.storageState || "local",
          active: r.version === e.current,
        });
      }
    }
  };
  walkChain("images");
  walkChain("videos");
  walkChain("audio");
  for (const f of Array.isArray(reg.finals) ? reg.finals : []) {
    if (f && f.assetId) rows.push({ assetId: f.assetId, domain: "finals", key: null, version: null, origin: f.origin || "compose", url: f.url || "", state: f.storageState || "local", active: true });
  }
  // standalone first-frame assets: a firstFrame normally ALIASES an image-chain
  // entry (same assetId) — already a row above — so we add ONLY assetIds not
  // yet seen (dedup avoids double-counting) so a first frame with no surviving
  // chain entry is still counted and manageable here.
  const seen = new Set(rows.map((r) => r.assetId));
  if (reg.firstFrames && typeof reg.firstFrames === "object") {
    for (const key of Object.keys(reg.firstFrames)) {
      const r = reg.firstFrames[key];
      if (!r || !r.assetId || seen.has(r.assetId)) continue;
      seen.add(r.assetId);
      rows.push({ assetId: r.assetId, domain: "firstFrames", key, version: r.version || null, origin: r.origin || "", url: r.url || "", state: r.storageState || "local", active: true });
    }
  }
  for (const r of rows) {
    const refs = referencesOf(r.assetId);
    r.blocking = refs.blocking;
    r.provenance = refs.provenance;
    r.referenced = refs.blocking.length > 0;
  }
  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.active && r.state === "local").length,
    historical: rows.filter((r) => !r.active).length,
    unused: rows.filter((r) => !r.active && !r.referenced && r.state === "local").length,
    archived: rows.filter((r) => r.state === "archived").length,
    missing: rows.filter((r) => r.state === "missing" || r.state === "deleted").length,
  };
  return { rows, stats };
}

export function renderStorageWs(ctx, ui) {
  const m = storageModel({ reg: ctx.assetRegistryView(), referencesOf: ctx.storage.referencesOf });
  const chip = (label, v) => `<span class="ws-stage"><span class="ws-stage-l">${esc(label)}</span><b>${v}</b></span>`;
  const stats =
    `<div class="ws-progress">` +
    chip("资产总数", m.stats.total) + chip("活跃（当前版本）", m.stats.active) +
    chip("历史变体", m.stats.historical) + chip("未使用", m.stats.unused) +
    chip("已归档", m.stats.archived) + chip("媒体不可用", m.stats.missing) +
    `</div>`;
  const showArchived = !!ui.stShowArchived;
  const rows = m.rows
    .filter((r) => showArchived || r.state !== "archived")
    .map((r) => {
      const stateTag = r.state === "local"
        ? ""
        : `<span class="ws-tag ${r.state === "archived" ? "" : "gate"}">${esc(r.state)}${r.state === "deleted" ? " · 字节已移除" : r.state === "missing" ? " · 检测缺失" : ""}</span>`;
      const refTag = r.referenced
        ? `<span class="ws-tag" title="${esc(r.blocking.join("；"))}">🔗 ${r.blocking.length} 处引用</span>`
        : r.active ? `<span class="ws-tag ok">当前</span>` : `<span class="ws-tag">历史</span>`;
      const prov = r.provenance ? `<span class="ws-desc">· 溯源×${r.provenance}</span>` : "";
      // archive is a local↔archived toggle only — a deleted/missing record
      // must never be offered a path back to "local" (its bytes are gone)
      const actions =
        (r.state === "local" || r.state === "archived"
          ? `<button class="ws-chipx" data-st-arch="${esc(r.assetId)}">${r.state === "archived" ? "取消归档" : "归档/隐藏"}</button>`
          : "") +
        (r.state === "local" ? `<button class="ws-chipx" data-st-rml="${esc(r.assetId)}">移除本地副本</button>` : "") +
        `<button class="ws-chipx" data-st-del="${esc(r.assetId)}">永久删除…</button>`;
      return (
        `<div class="ws-row"><div class="ws-main"><b>${esc(DOMAIN_ZH[r.domain] || r.domain)}</b> ` +
        `<span class="mono">${esc(r.key || "")}${r.version ? ` v${r.version}` : ""}</span> · ${esc(r.origin)} ` +
        `${refTag} ${stateTag} ${prov} <span class="ws-desc mono">${esc(r.assetId)}</span></div>${actions}</div>`
      );
    })
    .join("");
  return (
    `<div class="pm-head"><div class="pm-title">🗄 存储管理</div><div class="pm-note">基于既有 storageState 生命周期（M5）· 移除字节 ≠ 删除身份/溯源</div></div>` +
    stats +
    `<div class="ws-kv"><label><input type="checkbox" data-st-showarch ${showArchived ? "checked" : ""}> 显示已归档</label> · 推荐清理方式：移除本地副本（保留一切，只删字节）</div>` +
    `<div class="ws-list">${rows || `<div class="ws-desc">（没有资产）</div>`}</div>`
  );
}

export function bindStorageWs(root, ctx, ui, rerender) {
  const sa = root.querySelector("[data-st-showarch]");
  if (sa) sa.onchange = () => { ui.stShowArchived = sa.checked; rerender(); };
  root.querySelectorAll("[data-st-arch]").forEach((b) => {
    b.onclick = () => {
      const m = storageModel({ reg: ctx.assetRegistryView(), referencesOf: ctx.storage.referencesOf });
      const row = m.rows.find((r) => r.assetId === b.dataset.stArch);
      ctx.storage.archive(b.dataset.stArch, !(row && row.state === "archived"));
      rerender();
    };
  });
  root.querySelectorAll("[data-st-rml]").forEach((b) => {
    b.onclick = async () => {
      if (!window.confirm("移除本地副本：删除媒体字节；资产身份、元数据、生成溯源与全部引用保留（显示为不可用）。继续？")) return;
      try { await ctx.storage.removeLocal(b.dataset.stRml); rerender(); }
      catch (e) { ctx.toast("移除失败：" + e.message); }
    };
  });
  root.querySelectorAll("[data-st-del]").forEach((b) => {
    b.onclick = async () => {
      const refs = ctx.storage.referencesOf(b.dataset.stDel);
      if (refs.blocking.length) {
        ctx.toast(`仍被引用，已阻止删除：${refs.blocking.join("；")}`);
        return;
      }
      const impact = refs.provenance ? `\n注意：${refs.provenance} 条生成/渲染溯源记录的链接将悬空（记录本身保留）。` : "";
      if (!window.confirm(`永久删除该资产（字节 + 注册表记录）？此操作不可撤销。${impact}\n\n再次确认？`)) return;
      if (!window.confirm("最终确认：永久删除。")) return;
      try { await ctx.storage.permanentDelete(b.dataset.stDel); rerender(); }
      catch (e) { ctx.toast("删除失败：" + e.message); }
    };
  });
}