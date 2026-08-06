// Batch asset wizard (S4 准备资产): confirm shots → prepare assets → compose
// prompts. Its "一键生成所有资产" runs the image budget preflight, then marks the
// asset node done.
import { $, el } from "../util/dom.js";

export function createWizard({ estimate, getProject, refresh }) {
  const scrim = $("#wz-scrim");
  let node = null;
  const close = () => scrim.classList.remove("show");

  $("#wz-x").onclick = close;
  $("#wz-cancel").onclick = close;
  $("#wz-gen").onclick = () => {
    close();
    estimate.open({
      cmd: "generate_assets · 9 个角色/场景/道具设定图",
      kind: "图片",
      count: 9,
      p50: 18.0,
      p90: 27.0,
      actual: 18.0,
      label: "已提交 Gateway：批量生成 9 个资产设定图",
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
    const chars = $("#wz-chars");
    chars.innerHTML = "";
    project.characters.forEach(([name, desc]) => {
      const d = el("div", "charcard");
      d.innerHTML = `<div class="ph">生成或上传角色图<span class="dots">···</span></div><div class="nm">${name}</div><div class="ds">名称：${name}，${desc}</div>`;
      chars.appendChild(d);
    });
    const add = el("div", "charcard add");
    add.innerHTML = `<div class="ph"><span class="p">＋</span></div><div class="nm">新增</div>`;
    chars.appendChild(add);
    const scenes = $("#wz-scenes");
    scenes.innerHTML = "";
    project.scenes.forEach(([name, desc]) => {
      const d = el("div", "charcard");
      d.innerHTML = `<div class="ph">生成或上传场景图<span class="dots">···</span></div><div class="nm">${name}</div><div class="ds">${desc}</div>`;
      scenes.appendChild(d);
    });
    $("#wz-style").textContent = project.style;
    scrim.classList.add("show");
  }

  return { open, close };
}
