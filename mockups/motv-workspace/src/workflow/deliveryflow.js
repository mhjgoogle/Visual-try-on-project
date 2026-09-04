// 导出成片的编排：问闸门 → 用它签的票登记（TASK-074 §1.7 第 3 步）。
//
// 单独一个文件，是因为它两头都要碰：`deliveryexport`（判定与票）和 `assetlib`（登记表）。
// 让 `deliveryexport` 自己 import `assetlib` 会形成环（assetlib 要从 deliveryexport 拿
// 验收函数）。这里没有任何判定 —— 判定全在 `exportability`，这里只是把结果接到写入上。
import { exportability } from "./deliveryexport.js";
import { addFinal } from "./assetlib.js";

/**
 * 导出成片 —— 先问闸门，再用它签的票登记（TASK-074 §1.7 第 3 步）。
 *
 * 这是 `ctx.delivery.exportCut` 背后的全部逻辑，抽出来是为了让「有 open 阻断问题时
 * **登记不了**」能被一条集成测试真的跑出来，而不是从两个单元测试推出来。
 *
 * 抛错 = 没登记，且理由就是闸门的理由（fail-closed 并说明）。
 */
export function exportCut({ reg, cut, probe, report, episodeId = null }) {
  const gate = exportability({ cut, probe, report });
  if (!gate.ok) {
    const err = new Error(gate.reason || "导出被拒绝（门槛 G4）");
    err.step = gate.step;
    err.blockingIssueIds = gate.blockingIssueIds || [];
    throw err;
  }
  const rec = addFinal(reg, cut.url, episodeId, {
    fromCutAssetId: cut.assetId,
    ticket: gate.ticket,
  });
  if (!rec) throw new Error("导出失败：候选没有可用的媒体地址");
  return rec;
}
