// 交付生命周期：候选 → 质检 → **用户确认导出** → Final（TASK-074 §1.7 · 系统合同 §6.5）。
//
// WHAT WAS BROKEN. `render()` 一步既渲染又把结果登记成 `kind: "final"`，于是
// 「合成完成」与「这是成片」是同一个事件，**G4 从来没有被问过**。质检面板照常算出
// 「G4 拒绝导出」并画在屏幕上 —— 而那一版**已经是成片了**。一个只写在界面上的闸门，
// 换一条路径（Agent 动作、深链接、旧页面）就绕过去了。
//
// 所以这里守的是**数据层**的那一半：
//   1. 渲染产出的是 `cut`，不是 `final`；
//   2. `final` 只能由导出写出来，而且是 append（G5：旧候选、旧成片一字不动）；
//   3. 「候选不算成片」在读模型里也成立 —— 否则流水线会说这一集做完了。
import test from "node:test";
import assert from "node:assert/strict";

import {
  addCut, addFinal, cuts, finals, finalUrls, findAssetById,
} from "../src/workflow/assetlib.js";
import { ASSET_KINDS, KIND_DOMAIN, DELIVERY_KINDS, declarationDomainError } from "../src/workflow/assetreg.js";
import { g4Export, g5Append } from "../src/workflow/gates.js";
import * as exportMod from "../src/workflow/deliveryexport.js";
import * as flowMod from "../src/workflow/deliveryflow.js";
import { exportability, spendExportTicket } from "../src/workflow/deliveryexport.js";
import { exportCut } from "../src/workflow/deliveryflow.js";
import { runDeliveryQc } from "../src/workflow/deliveryqc.js";

/** 走**真正的导出路径**登记一版成片：闸门放行 → 签票 → `addFinal`。 */
const MEASURED = (id) => ({ assetId: id, measured: true });
/** 一份**对这一版**出的干净报告（报告带着它测的是谁 —— codex 轮 3）。 */
const OK_REPORT_FOR = (id) => ({ probeAssetId: id, issues: [] });
const OK_REPORT = OK_REPORT_FOR("cut-1");
function exportVia(r, cutRec, episodeId = "ep-1") {
  const cut = { assetId: cutRec.assetId, url: cutRec.url, kind: "cut", exportable: true, name: "x" };
  return exportCut({ reg: r, cut, probe: MEASURED(cut.assetId), report: OK_REPORT_FOR(cut.assetId), episodeId });
}
/** 唯一合法的拿票方式：让闸门放行。 */
function ticketFor(cutRec) {
  const cut = { assetId: cutRec.assetId, url: cutRec.url, kind: "cut", exportable: true, name: "x" };
  const g = exportability({ cut, probe: MEASURED(cut.assetId), report: OK_REPORT_FOR(cut.assetId) });
  assert.ok(g.ok && g.ticket, "闸门应放行并签票");
  return g.ticket;
}

const reg = () => ({ images: {}, videos: {}, audio: {}, finals: [], firstFrames: {} });

/* --- 词汇表 --------------------------------------------------------------- */

test("交付域里有两个 kind，而且它们**不能互相替代**", () => {
  assert.ok(ASSET_KINDS.includes("cut"), "候选成片要有自己的身份");
  assert.ok(ASSET_KINDS.includes("final"));
  assert.deepEqual(DELIVERY_KINDS, ["cut", "final"]);
  // 两个都住在 finals 域 —— 但住在一起不等于是一回事
  assert.equal(KIND_DOMAIN.cut, "finals");
  assert.equal(KIND_DOMAIN.final, "finals");
  assert.equal(declarationDomainError("cut", "finals"), null);
  assert.ok(declarationDomainError("cut", "videos"), "候选不许登记到别的域");
});

/* --- 渲染产出候选，不是成片 ------------------------------------------------ */

test("渲染产出的是**候选**：`addCut` 写 `kind: cut`", () => {
  const r = reg();
  const rec = addCut(r, "/media/ep1-cut_v1.mp4", "ep-1");
  assert.equal(rec.kind, "cut");
  assert.equal(rec.links.episodeId, "ep-1");
  assert.equal(rec.origin, "compose");
  assert.equal(rec.storageState, "local");
  assert.deepEqual(cuts(r).map((c) => c.assetId), [rec.assetId]);
  assert.deepEqual(finals(r), [], "还没有任何成片");
});

test("合成返回坏结果时不写记录 —— 一条没有地址的成片是永久的死数据", () => {
  const r = reg();
  assert.equal(addCut(r, ""), null);
  assert.equal(addCut(r, null), null);
  // `addFinal` 先验票再看 url —— 没票连坏 url 都到不了写入那一步
  assert.throws(() => addFinal(r, ""), /导出票/);
  assert.equal(r.finals.length, 0);
});

/* --- 导出才产生成片，而且是 append ---------------------------------------- */

test("导出登记 `final`，并记下它是**哪一版候选**导出的", () => {
  const r = reg();
  const cut = addCut(r, "/media/ep1-cut_v1.mp4", "ep-1");
  const fin = exportVia(r, cut);
  assert.equal(fin.kind, "final");
  assert.equal(fin.fromCutAssetId, cut.assetId);
  // G5：append。候选记录还在，成片是**新的一条**，两者身份不同。
  assert.equal(r.finals.length, 2);
  assert.notEqual(fin.assetId, cut.assetId);
  assert.ok(findAssetById(r, cut.assetId), "旧候选一条不动");
  assert.deepEqual(cuts(r).map((c) => c.assetId), [cut.assetId]);
  assert.deepEqual(finals(r).map((f) => f.assetId), [fin.assetId]);
});

test("再导出一版：旧成片**照旧在**，不是被替换掉", () => {
  const r = reg();
  const c1 = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const f1 = exportVia(r, c1);
  const c2 = addCut(r, "/media/cut_v2.mp4", "ep-1");
  const f2 = exportVia(r, c2);
  assert.deepEqual(finals(r).map((f) => f.assetId), [f1.assetId, f2.assetId]);
  assert.equal(r.finals.length, 4, "两版候选 + 两版成片，一条都没少");
  // 登记顺序就是版本顺序（finals 没有 chain）
  assert.deepEqual(finalUrls(r), [c1.url, f1.url, c2.url, f2.url]);
});

/* --- 老项目：2026-09-04 之前的记录 ----------------------------------------- */

test("老的 `final` 记录**不被改写**，它仍然算成片", () => {
  // 当时的规则就是「渲染完即成片」。改写它等于篡改创作者的档案（AGENTS.md 第 13 条）；
  // 它是历史事实，不是待迁移的脏数据。
  const r = reg();
  r.finals.push({
    assetId: "old-1", url: "/media/legacy.mp4", origin: "compose",
    storageState: "local", kind: "final", links: {},
  });
  assert.deepEqual(finals(r).map((f) => f.assetId), ["old-1"]);
  assert.deepEqual(cuts(r), []);
});

/* --- G4 就是那道闸 --------------------------------------------------------- */

test("没跑过质检 = **未知，不是通过** —— 导出被拒", () => {
  assert.equal(g4Export(null).ok, false);
  assert.equal(g4Export(undefined).ok, false);
  assert.equal(g4Export({}).ok, false, "`{}` 不是一份报告");
  assert.match(g4Export(null).reason, /还没有跑交付质检/);
});

test("有 open 的阻断问题 → 拒绝导出，并**说出是哪几条**", () => {
  const report = {
    issues: [
      { issueId: "qc-1", layer: "delivery", severity: "blocking", state: "open", text: "音画不同步 220ms" },
      { issueId: "qc-2", layer: "delivery", severity: "warning", state: "open", text: "响度偏低" },
    ],
  };
  const g = g4Export(report);
  assert.equal(g.ok, false);
  assert.deepEqual(g.blockingIssueIds, ["qc-1"]);
  assert.match(g.reason, /音画不同步/, "拒绝必须指出可以去做什么");
  assert.doesNotMatch(g.reason, /响度偏低/, "警告级不阻断，也不该混进拒绝理由");
});

test("阻断问题闭合之后放行", () => {
  const report = {
    issues: [
      { issueId: "qc-1", layer: "delivery", severity: "blocking", state: "resolved", text: "音画不同步" },
    ],
  };
  assert.equal(g4Export(report).ok, true);
});

test("G5：版本号不许落在已有的那一个上", () => {
  assert.equal(g5Append([1, 2], 3).ok, true);
  assert.equal(g5Append([1, 2], 2).ok, false);
});

/* --- 导出闸门本身：四种拒绝 + 放行，按顺序（codex 轮 1 判证据不足）------------ */
//
// 这是 `ctx.delivery.exportability` 背后的纯函数。原来它长在 app.js 的闭包里，只能靠
// `g4Export` 与 `addFinal` 各自的单元测试间接证 —— 而四种拒绝里有三种根本不在 g4 里。

const CUT = { assetId: "cut-1", url: "/media/cut_v1.mp4", kind: "cut", exportable: true, name: "cut_v1.mp4" };
const FIN = { assetId: "fin-1", url: "/media/fin.mp4", kind: "final", exportable: false, name: "fin.mp4" };
// 报告带着它测的是谁（codex 轮 3）：不带的会被 report-mismatch 正确地拒掉
const CLEAN = { probeAssetId: "cut-1", issues: [] };
const BLOCKED = { probeAssetId: "cut-1", issues: [
  { issueId: "qc-1", layer: "delivery", severity: "blocking", state: "open", text: "缺帧" },
] };

test("闸门 · 找不到这一版 → 拒绝", () => {
  const g = exportability({ cut: null, probe: { assetId: "cut-1", measured: true }, report: CLEAN });
  assert.equal(g.ok, false);
  assert.equal(g.step, "missing");
});

test("闸门 · 已经是成片的不能再导 —— 要出新版本先渲染新候选", () => {
  const g = exportability({ cut: FIN, probe: { assetId: "fin-1", measured: true }, report: CLEAN });
  assert.equal(g.ok, false);
  assert.equal(g.step, "already-final");
  assert.match(g.reason, /先渲染一版新的候选/);
});

test("闸门 · **没对这一版测过** → 拒绝，哪怕报告是干净的", () => {
  // 没跑过质检 = 未知，不是通过（§6.5）
  const g = exportability({ cut: CUT, probe: { assetId: null, measured: false }, report: CLEAN });
  assert.equal(g.ok, false);
  assert.equal(g.step, "unmeasured");
  assert.match(g.reason, /先对它跑一次交付质检/);
});

test("闸门 · **拿另一版的测量不能放行这一版** —— 那是替一个没检查过的文件签字", () => {
  const g = exportability({ cut: CUT, probe: { assetId: "cut-0", measured: true }, report: CLEAN });
  assert.equal(g.ok, false);
  assert.equal(g.step, "unmeasured");
});

test("闸门 · 测过了、有 open 阻断问题 → G4 拒绝并列出问题 id", () => {
  const g = exportability({ cut: CUT, probe: { assetId: "cut-1", measured: true }, report: BLOCKED });
  assert.equal(g.ok, false);
  assert.equal(g.step, "g4");
  assert.deepEqual(g.blockingIssueIds, ["qc-1"]);
  assert.match(g.reason, /缺帧/);
});

test("闸门 · 测过了、没有阻断问题 → 放行", () => {
  const g = exportability({ cut: CUT, probe: { assetId: "cut-1", measured: true }, report: CLEAN });
  assert.equal(g.ok, true);
  assert.equal(g.step, "ready");
});

test("闸门 · 顺序即优先级：已是成片的不会被报成「没测过」", () => {
  const g = exportability({ cut: FIN, probe: { assetId: null, measured: false }, report: null });
  assert.equal(g.step, "already-final");
});

/* --- 第 4 条：撤回一版成片 = 归档（可逆），不再算作交付结果 ------------------ */

test("撤回（归档）过的成片不再算成片 —— 记录与字节都在，资产库里取消归档就回来", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const f = exportVia(r, c);
  assert.deepEqual(finals(r).map((x) => x.assetId), [f.assetId]);
  f.storageState = "archived";
  assert.deepEqual(finals(r), [], "归档 = 撤回");
  assert.equal(r.finals.length, 2, "什么都没被删");
  f.storageState = "local";
  assert.deepEqual(finals(r).map((x) => x.assetId), [f.assetId], "可逆");
});

/* --- 「唯一写入者」是结构，不是约定（codex 轮 2 P1）------------------------------ */
//
// `addFinal` 是一个导出的函数。没有票之前，「只有导出调它」是关于**谁碰巧在调**的约定，
// 任何 import 它的模块都能绕过 G4 直接登记成片。票只由 `exportability` 在放行那一刻签，
// 按身份验，用一次作废。

test("**没有票登记不了成片** —— 直接调 `addFinal` 被拒，什么都没写", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  assert.throws(() => addFinal(r, c.url, "ep-1", { fromCutAssetId: c.assetId }), /导出票/);
  assert.throws(() => addFinal(r, c.url, "ep-1", { fromCutAssetId: c.assetId, ticket: null }), /导出票/);
  assert.deepEqual(finals(r), []);
  assert.equal(r.finals.length, 1, "候选还在，成片一条没多");
});

test("伪造一张 `{ ok: true }` 过不了 —— 票按身份验，不按形状", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const forged = { ok: true, cutAssetId: c.assetId, step: "ready" };
  assert.throws(() => addFinal(r, c.url, "ep-1", { fromCutAssetId: c.assetId, ticket: forged }), /导出票/);
  assert.deepEqual(finals(r), []);
});

test("票只对**这一版**有效：拿 A 的票导 B 被拒", () => {
  const r = reg();
  const a = addCut(r, "/media/a.mp4", "ep-1");
  const b = addCut(r, "/media/b.mp4", "ep-1");
  const ticket = ticketFor(a);
  assert.throws(() => addFinal(r, b.url, "ep-1", { fromCutAssetId: b.assetId, ticket }), /不是给这一版/);
  assert.deepEqual(finals(r), []);
});

test("票用一次就作废 —— 每次导出都是一条新记录，不是拿着票反复登记（G5）", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const ticket = ticketFor(c);
  addFinal(r, c.url, "ep-1", { fromCutAssetId: c.assetId, ticket });
  assert.throws(() => addFinal(r, c.url, "ep-1", { fromCutAssetId: c.assetId, ticket }), /已经用过/);
  assert.equal(finals(r).length, 1);
  assert.equal(spendExportTicket(ticket, c.assetId) !== null, true);
});

test("放行才签票：被拒的闸门结果里**没有票**", () => {
  const CUT = { assetId: "cut-1", url: "/media/cut_v1.mp4", kind: "cut", exportable: true, name: "x" };
  assert.equal("ticket" in exportability({ cut: CUT, probe: { assetId: null, measured: false }, report: OK_REPORT }), false);
  const blocked = { probeAssetId: "cut-1", issues: [{ issueId: "qc-1", layer: "delivery", severity: "blocking", state: "open", text: "缺帧" }] };
  assert.equal("ticket" in exportability({ cut: CUT, probe: MEASURED("cut-1"), report: blocked }), false);
  const ok = exportability({ cut: CUT, probe: MEASURED("cut-1"), report: OK_REPORT });
  assert.ok(ok.ticket, "放行结果带票");
  assert.equal(ok.ticket.cutAssetId, "cut-1");
});

/* --- 集成：整条导出路径，真的登记 / 真的登记不了 ------------------------------- */

test("**有 open 阻断问题 → `exportCut` 抛错，成片一条都没登记**（完成判据）", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const cut = { assetId: c.assetId, url: c.url, kind: "cut", exportable: true, name: "x" };
  const blocked = { probeAssetId: c.assetId, issues: [
    { issueId: "qc-7", layer: "delivery", severity: "blocking", state: "open", text: "音画不同步 220ms" },
  ] };
  assert.throws(
    () => exportCut({ reg: r, cut, probe: MEASURED(c.assetId), report: blocked, episodeId: "ep-1" }),
    (e) => e.step === "g4" && e.blockingIssueIds.includes("qc-7") && /音画不同步/.test(e.message),
  );
  assert.deepEqual(finals(r), []);
  assert.equal(r.finals.length, 1, "登记表里只有那一版候选");
});

test("集成 · 没对这一版测过 → 抛错，不登记；测过且干净 → 登记一条新成片", () => {
  const r = reg();
  const c = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const cut = { assetId: c.assetId, url: c.url, kind: "cut", exportable: true, name: "x" };
  assert.throws(
    () => exportCut({ reg: r, cut, probe: { assetId: "someone-else", measured: true }, report: OK_REPORT }),
    (e) => e.step === "unmeasured",
  );
  assert.deepEqual(finals(r), []);
  const fin = exportCut({ reg: r, cut, probe: MEASURED(c.assetId), report: OK_REPORT_FOR(c.assetId), episodeId: "ep-1" });
  assert.equal(fin.kind, "final");
  assert.equal(fin.fromCutAssetId, c.assetId);
  assert.equal(fin.links.episodeId, "ep-1");
  assert.deepEqual(finals(r).map((f) => f.assetId), [fin.assetId]);
  assert.equal(r.finals.length, 2, "候选保留，成片 append");
});

test("集成 · 问题闭合后再导 → 新版本，旧候选与旧成片一字不变", () => {
  const r = reg();
  const c1 = addCut(r, "/media/cut_v1.mp4", "ep-1");
  const f1 = exportVia(r, c1);
  const before = JSON.stringify(r.finals);
  const c2 = addCut(r, "/media/cut_v2.mp4", "ep-1");
  const f2 = exportVia(r, c2);
  // 之前的两条记录逐字节不变
  assert.equal(JSON.stringify(r.finals.slice(0, 2)), before);
  assert.deepEqual(finals(r).map((f) => f.assetId), [f1.assetId, f2.assetId]);
});

/* --- 轮 3：签票函数不公开；报告绑到候选身份 ----------------------------------- */

test("**没有任何导出能拿到签票函数** —— 轮 2/3/4 三个变体一起关掉", () => {
  // writer（addFinal 裸导出）→ mint 导出 → binder 先来先得：同一机理，三种拼法。
  // 现在签票是 deliveryexport 的私有函数；两个交付模块的导出面上没有 mint、没有 bind。
  for (const [name, mod] of [["deliveryexport", exportMod], ["deliveryflow", flowMod]]) {
    for (const key of Object.keys(mod)) {
      assert.doesNotMatch(key, /mint|bind|issue/i, `${name} 导出了 ${key}`);
    }
  }
  assert.deepEqual(Object.keys(exportMod).sort(), ["exportability", "spendExportTicket"]);
  assert.deepEqual(Object.keys(flowMod).sort(), ["exportCut"]);
  // 而且旧模块已经不存在 —— 不留影子实现（AGENTS.md 第 26 条）
  return import("../src/workflow/deliveryticket.js").then(
    () => assert.fail("deliveryticket.js 应当已删除"),
    (e) => assert.equal(e.code, "ERR_MODULE_NOT_FOUND"),
  );
});

test("**A 刚测过 + 一份给 B 出的干净报告 → 导不了 A**（codex 轮 3 P1）", () => {
  const r = reg();
  const a = addCut(r, "/media/a.mp4", "ep-1");
  const cutA = { assetId: a.assetId, url: a.url, kind: "cut", exportable: true, name: "a" };
  const reportForB = { probeAssetId: "cut-B", issues: [] };
  const g = exportability({ cut: cutA, probe: MEASURED(a.assetId), report: reportForB });
  assert.equal(g.ok, false);
  assert.equal(g.step, "report-mismatch");
  assert.equal("ticket" in g, false);
  assert.throws(
    () => exportCut({ reg: r, cut: cutA, probe: MEASURED(a.assetId), report: reportForB }),
    (e) => e.step === "report-mismatch",
  );
  assert.deepEqual(finals(r), []);
});

test("没标明是给谁出的报告一律不放行 —— 老形状的报告导不出成片", () => {
  const CUT1 = { assetId: "cut-1", url: "/media/cut_v1.mp4", kind: "cut", exportable: true, name: "x" };
  const g = exportability({ cut: CUT1, probe: MEASURED("cut-1"), report: { issues: [] } });
  assert.equal(g.step, "report-mismatch");
});

test("`runDeliveryQc` 把它测的是谁写进报告", () => {
  const rep = runDeliveryQc({ probe: null, probeAssetId: "cut-9", spec: {}, assets: [], durationMs: null, deliveryId: "ep-1" });
  assert.equal(rep.probeAssetId, "cut-9");
  const none = runDeliveryQc({ probe: null, spec: {}, assets: [], durationMs: null });
  assert.equal(none.probeAssetId, null, "没测过就是 null，不编一个");
});
