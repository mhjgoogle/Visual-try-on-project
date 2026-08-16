// Batch asset wizard (S4 准备资产): confirm shots → prepare assets → compose
// prompts. Its "一键生成所有资产" runs the image budget preflight, then marks the
// asset node done.
import { $, $$, el, esc } from "../util/dom.js";
import { buildEntityIndex, assetReadiness } from "../workflow/shotentity.js";
import { buildPortraitIndex } from "./storyboard.js";

/**
 * 「这一批要准备多少资产，已经有多少」 — THE SAME derivation the storyboard table's
 * 「准备资产 N/M」 uses (TASK-078 §2.3.3).
 *
 * It used to be `0/${draft.length}` — one 设定图 per SHOT, and the numerator hard-
 * coded to zero. Both halves were wrong on a real project: 60 shots do not need
 * 60 reference images, they need one per distinct character and place they name;
 * and 「0 已生成」 was printed even when the bible already had six of them. Two
 * surfaces answering one question with two numbers is worse than either number
 * alone, so there is now one function and both call it.
 *
 * Exported for tests and for the guard that pins the two counts together.
 */
export function wizardReadiness(pd) {
  const portraitFor = buildPortraitIndex(pd); // built ONCE — it walks every asset chain
  return assetReadiness({
    index: buildEntityIndex(pd && pd.production),
    shots: Array.isArray(pd && pd.draftShots) ? pd.draftShots : [],
    hasReferenceImage: (kind, id) => !!portraitFor(kind, id),
  });
}

export function createWizard({ estimate, getProject, prodData, refresh }) {
  const scrim = $("#wz-scrim");
  let node = null;
  let genCount = 9; // asset count the "一键生成" estimate submits (draft-aware)
  const close = () => scrim.classList.remove("show");

  $("#wz-x").onclick = close;
  $("#wz-cancel").onclick = close;
  $("#wz-gen").onclick = () => {
    const n = genCount;
    // Nothing missing → nothing to generate. Opening a budget preflight for zero
    // assets would ask the creator to confirm spending on an empty batch.
    if (!n) { close(); return; }
    close();
    estimate.open({
      cmd: `generate_assets · ${n} 个设定图`,
      kind: "图片",
      count: n,
      p50: n * 2.0,
      p90: n * 3.0,
      actual: n * 2.0,
      label: `已提交 Gateway：批量生成 ${n} 个资产设定图`,
      after: () => {
        if (node) {
          node.state = "done";
          refresh(node);
        }
      },
    });
  };

  function open(assetNode) {
    node = assetNode;
    const project = getProject();
    const draft = project.draftShots;
    const chars = $("#wz-chars");
    const scenes = $("#wz-scenes");
    const grps = $$("#wz-scrim .wz-grp");
    const steps = $$("#wz-scrim .wz-step small");
    const warn = $("#wz-scrim .warn");

    if (Array.isArray(draft)) {
      // A draft context is active whenever draftShots is an array (even the
      // degenerate empty case) — never fall back to the fixture 角色/场景, which
      // would contradict the script. (No draft at all leaves draftShots null.)
      // Draft mode (ADR-0042): the wizard MUST reflect the same Claude shot draft
      // the assets-node preview shows — never the demo fixture's characters/
      // scenes (which would contradict the script). A draft is a shot list with
      // no structured characters/scenes yet, so render one 分镜 section and hide
      // the fixture 角色/场景 grids.
      // 「准备资产」 IS ABOUT ENTITIES, not shots (TASK-078 §2.3.3). What step ②
      // prepares is one reference image per distinct character / place the shot
      // list names — which is also exactly what the storyboard table's header
      // counts, from the same function.
      const rd = prodData ? wizardReadiness(prodData()) : { entities: [], total: 0, ready: 0, missing: [] };
      genCount = rd.missing.length;
      $("#wz-style").textContent = "未设定（分镜草稿 · 未锁定）";
      if (grps[0]) grps[0].textContent = "分镜草稿点到的人物 / 场景地";
      if (grps[1]) grps[1].style.display = "none";
      scenes.style.display = "none";
      scenes.innerHTML = "";
      chars.innerHTML = "";
      rd.entities.forEach((e) => {
        const d = el("div", "charcard");
        d.innerHTML =
          `<div class="ph">${e.ready ? "已有参考图" : "生成或上传参考图"}<span class="dots">···</span></div>` +
          `<div class="nm">${esc(e.kind === "character" ? "👤" : "📍")} ${esc(e.name)}</div>` +
          `<div class="ds">${esc(String(e.shotIds.length))} 个镜头点到它${e.ready ? " · 参考图就绪" : " · 还没有参考图"}</div>`;
        chars.appendChild(d);
      });
      if (steps[0]) steps[0].textContent = `${draft.length} 个镜头已就绪`;
      if (steps[1]) steps[1].textContent = `${rd.ready}/${rd.total} 已生成 · 差 ${rd.missing.length} 个`;
      if (steps[2]) steps[2].textContent = `0/${draft.length} 已合成`;
      if (warn) {
        warn.textContent = rd.total
          ? `⚠ 分镜草稿点到 ${rd.total} 个人物 / 场景地，其中 ${rd.missing.length} 个还没有参考图，可手动上传或 AI 批量生成。`
          : `⚠ ${draft.length} 个镜头的画面描述里没有点到任何已登记的人物 / 场景地——先在「作品设定」建立它们，或在描述里写上名字。`;
      }
      scrim.classList.add("show");
      return;
    }

    // Fixture mode (demo, no draft): show the hand-authored characters/scenes.
    genCount = 9;
    if (grps[0]) grps[0].textContent = "角色";
    if (grps[1]) grps[1].style.display = "";
    scenes.style.display = "";
    if (steps[0]) steps[0].textContent = "11 个镜头已就绪";
    if (steps[1]) steps[1].textContent = "0/9 已生成 · 差 9 个";
    if (steps[2]) steps[2].textContent = "0/11 已合成";
    if (warn) warn.textContent = "⚠ 检测到 6 个人物角色、2 个场景和 1 个道具没有设定图，可手动上传或 AI 批量生成。";
    chars.innerHTML = "";
    project.characters.forEach(([name, desc]) => {
      const d = el("div", "charcard");
      d.innerHTML = `<div class="ph">生成或上传角色图<span class="dots">···</span></div><div class="nm">${esc(name)}</div><div class="ds">名称：${esc(name)}，${esc(desc)}</div>`;
      chars.appendChild(d);
    });
    const add = el("div", "charcard add");
    add.innerHTML = `<div class="ph"><span class="p">＋</span></div><div class="nm">新增</div>`;
    chars.appendChild(add);
    scenes.innerHTML = "";
    project.scenes.forEach(([name, desc]) => {
      const d = el("div", "charcard");
      d.innerHTML = `<div class="ph">生成或上传场景图<span class="dots">···</span></div><div class="nm">${esc(name)}</div><div class="ds">${esc(desc)}</div>`;
      scenes.appendChild(d);
    });
    $("#wz-style").textContent = project.style;
    scrim.classList.add("show");
  }

  return { open, close };
}
