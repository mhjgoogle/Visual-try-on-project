// Batch asset wizard (S4 准备资产): confirm shots → prepare assets → compose
// prompts. Its "一键生成所有资产" runs the image budget preflight, then marks the
// asset node done.
import { $, $$, el, esc } from "../util/dom.js";

export function createWizard({ estimate, getProject, refresh }) {
  const scrim = $("#wz-scrim");
  let node = null;
  let genCount = 9; // asset count the "一键生成" estimate submits (draft-aware)
  const close = () => scrim.classList.remove("show");

  $("#wz-x").onclick = close;
  $("#wz-cancel").onclick = close;
  $("#wz-gen").onclick = () => {
    close();
    const n = genCount;
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
      genCount = draft.length;
      $("#wz-style").textContent = "未设定（分镜草稿 · 未锁定）";
      if (grps[0]) grps[0].textContent = "分镜（草稿）";
      if (grps[1]) grps[1].style.display = "none";
      scenes.style.display = "none";
      scenes.innerHTML = "";
      chars.innerHTML = "";
      draft.forEach((s) => {
        const seq = String(s.sequence).padStart(2, "0");
        const d = el("div", "charcard");
        d.innerHTML = `<div class="ph">生成或上传镜头设定图<span class="dots">···</span></div><div class="nm">${esc(seq)} ${esc(s.title)}</div><div class="ds">${esc(s.description)}（${esc(String(s.duration_seconds))}s）</div>`;
        chars.appendChild(d);
      });
      if (steps[0]) steps[0].textContent = `${draft.length} 个镜头已就绪`;
      if (steps[1]) steps[1].textContent = `0/${draft.length} 已生成 · 差 ${draft.length} 个`;
      if (steps[2]) steps[2].textContent = `0/${draft.length} 已合成`;
      if (warn) warn.textContent = `⚠ ${draft.length} 个镜头来自分镜草稿，均缺设定图，可手动上传或 AI 批量生成。`;
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
