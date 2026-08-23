// 审片结论离开画布进核心项目 —— TASK-103 批次 B（TASK-087 §1.2 / TASK-083 §5.1）。
//
// 被测的是 `workflow/reviewsync.js` 的**纯那一半**：信封怎么构造、网关的回答怎么
// 翻译。网关本身用注入的假件驱动，所以这里跑得起真实分支，包括三种「没登记上」。
import test from "node:test";
import assert from "node:assert/strict";

import * as rs from "../src/workflow/reviewsync.js";

const decision = (over = {}) => ({
  decisionId: "d-1",
  layer: "shot",
  targetId: "sh-7",
  verdict: "passed",
  by: "user",
  at: "2026-08-22T00:00:00.000Z",
  basedOnVersion: 3,
  ...over,
});

// --- 信封 --------------------------------------------------------------------

const DIGEST = "a".repeat(64);

test("目标三元组必须是后端算出来的，前端编不出合法的 digest", () => {
  // `CommandEnvelope` 只接受 {ref, version, content_digest}，digest 是记录字节的
  // sha256。前端拼一个的后果不是「被拒」，是把命令绑在一个不存在的版本上 ——
  // 所以这里守的是「什么样的目标才准用」，而不是「怎么拼一个目标」。
  assert.equal(rs.isUsableTarget({ ref: "sh-7", version: 1, content_digest: DIGEST }), true);
  assert.equal(rs.isUsableTarget({ ref: "sh-7", version: 1 }), false, "缺 digest 不能用");
  assert.equal(rs.isUsableTarget({ ref: "sh-7", version: 1, content_digest: "abc" }), false);
  assert.equal(rs.isUsableTarget({ ref: "", version: 1, content_digest: DIGEST }), false);
  assert.equal(rs.isUsableTarget({ ref: "sh-7", version: 0, content_digest: DIGEST }), false);
  assert.equal(rs.isUsableTarget(null), false);
});

test("同一条结论永远得到同一个 evaluation_id 与 command_id", () => {
  // 网关按 command_id 幂等：重放同一条结论不会在核心里写出第二条评价。
  const a = rs.evaluationFor(decision());
  const b = rs.evaluationFor(decision());
  assert.equal(a.params.evaluation_id, b.params.evaluation_id);
  assert.equal(a.commandId, b.commandId);
  assert.ok(a.commandId.includes("d-1"));
});

test("通过与撤销通过都能登记，且 pass 的真假不同", () => {
  assert.equal(rs.evaluationFor(decision()).params.pass, true);
  assert.equal(rs.evaluationFor(decision({ verdict: "needs_rework" })).params.pass, false);
});

test("没写理由时如实说未填写，不替创作者编一个理由", () => {
  const e = rs.evaluationFor(decision());
  assert.ok(e.params.rationale.includes("未填写理由"));
  const withNote = rs.evaluationFor(decision({ note: "光比偏硬，但可接受" }));
  assert.equal(withNote.params.rationale, "光比偏硬，但可接受");
});

test("构造不出信封时给出具体原因，而不是让网关回 400", () => {
  assert.match(rs.evaluationFor(decision({ targetId: "" })).error, /没有指向具体镜头/);
  assert.match(rs.evaluationFor(decision({ decisionId: "" })).error, /decisionId/);
  assert.match(rs.evaluationFor(decision({ verdict: "skipped" })).error, /不是可登记的审片结论/);
  assert.equal(rs.evaluationFor(null).ok, false);
});



// --- 走网关 ------------------------------------------------------------------

const spec = () => rs.evaluationFor(decision());

function fakeClient({
  blockers = [],
  status = "completed",
  recordId = "evaluation:p:e-1",
  throwOn = null,
  target = { ref: "sh-7", version: 1, content_digest: DIGEST },
} = {}) {
  const calls = [];
  return {
    calls,
    async target(project, shotId) {
      calls.push(["target", project, shotId]);
      if (throwOn === "target") throw new Error("shot record not found");
      return target;
    },
    async preflight(project, envelope) {
      calls.push(["preflight", project, envelope]);
      if (throwOn === "preflight") throw new Error("网络断了");
      return { preflight_digest: "digest-1", preview: { blockers } };
    },
    async submit(project, envelope, confirmation) {
      calls.push(["submit", project, envelope, confirmation]);
      if (throwOn === "submit") throw new Error("网关拒绝");
      return { status, outcome: { kind: "evaluation", record_id: recordId } };
    },
  };
}

test("顺利登记：预检 → 提交，回执带记录号", async () => {
  const c = fakeClient();
  const r = await rs.sendThroughGateway(c, "proj-1", spec());
  assert.equal(r.state, "recorded");
  assert.equal(r.recordId, "evaluation:p:e-1");
  // 顺序是 目标 → 预检 → 提交
  assert.deepEqual(c.calls.map((x) => x[0]), ["target", "preflight", "submit"]);
  // 提交带的是预检返回的那个 digest —— 确认的东西与跑的东西是同一个
  assert.equal(c.calls[2][3], "digest-1");
  // 而信封绑的是后端给的目标，不是前端拼的
  assert.deepEqual(c.calls[1][2].target, { ref: "sh-7", version: 1, content_digest: DIGEST });
});

test("这一镜还没有正式记录时说清楚，而不是绑一个编出来的版本", async () => {
  for (const c of [
    fakeClient({ throwOn: "target" }),
    fakeClient({ target: { ref: "sh-7", version: 1 } }), // 后端少给 digest
    fakeClient({ target: null }),
  ]) {
    const r = await rs.sendThroughGateway(c, "proj-1", spec());
    assert.equal(r.state, "blocked");
    assert.equal(c.calls.length, 1, "目标解析不到时不得预检、不得提交");
  }
});

test("预检有阻断时不提交，并原样转述核心给的理由", async () => {
  const c = fakeClient({ blockers: ["no project identity (project.json missing)"] });
  const r = await rs.sendThroughGateway(c, "proj-1", spec());
  assert.equal(r.state, "blocked");
  assert.equal(c.calls.length, 2, "被阻断时不得提交");
  assert.match(rs.explain(r).text, /project\.json missing/);
});

test("没有后端 = unavailable，不是失败", async () => {
  const r = await rs.sendThroughGateway(null, "proj-1", spec());
  assert.equal(r.state, "unavailable");
  assert.match(rs.explain(r).text, /未登记到核心/);
});

test("回执不是 completed 时绝不当成已登记（含 AMBIGUOUS）", async () => {
  for (const status of ["ambiguous", "rejected", "attempting"]) {
    const r = await rs.sendThroughGateway(fakeClient({ status }), "proj-1", spec());
    assert.equal(r.state, "failed", `${status} 被当成了成功`);
    assert.notEqual(rs.explain(r).state, "recorded");
  }
});

test("预检抛错与提交抛错都不冒充成功", async () => {
  const a = await rs.sendThroughGateway(fakeClient({ throwOn: "preflight" }), "p", spec());
  assert.equal(a.state, "failed");
  assert.match(a.detail, /网络断了/);
  const b = await rs.sendThroughGateway(fakeClient({ throwOn: "submit" }), "p", spec());
  assert.equal(b.state, "failed");
  assert.match(b.detail, /网关拒绝/);
});

test("信封构造失败时根本不碰网关", async () => {
  const c = fakeClient();
  const r = await rs.sendThroughGateway(c, "p", rs.evaluationFor(decision({ targetId: "" })));
  assert.equal(r.state, "failed");
  assert.equal(c.calls.length, 0);
});

test("五种状态各说各的，不塌成一句「登记失败」", () => {
  const texts = new Set(
    [
      { state: "recorded", recordId: "r-1" },
      { state: "blocked", blockers: ["缺项目身份"] },
      { state: "unavailable", detail: "没有连接到后端项目" },
      { state: "failed", detail: "网关返回了错误" },
    ].map((r) => rs.explain(r).text),
  );
  assert.equal(texts.size, 4);
});
