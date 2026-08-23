# Workspace WFM1 数据基线验收 Runbook（TASK-033 / WSM3-B）

> **状态：Approved acceptance evidence（2026-08-03）。** 本 runbook 让用户离线、
> 零付费地复核「Workspace on WFM1」闭环与安全门。全部命令在 WSL2 Ubuntu + 项目
> venv 内运行，不触网、不调用任何付费 Provider。

## 0. 前置

```bash
cd /home/mo/Visual-try-on-project
source .venv/bin/activate
```

## 1. 一键离线验收（推荐）

跨切面主验收 + 逐域证据一起跑：

```bash
# TASK-033 跨切面里程碑验收（观察→评价→行动→学习 + 恢复/安全对抗）
pytest tests/test_workspace_wfm1_acceptance.py -q

# 逐域细粒度证据
pytest tests/test_workspace_queries.py tests/test_workspace_shell.py \
       tests/test_workspace_write.py tests/test_gateway_service.py \
       tests/test_action_service.py tests/test_evaluation_service.py \
       tests/test_learning.py tests/test_workspace_action_query.py \
       tests/test_workspace_evaluation_query.py -q

# WFM1 生产链本身（真实付费链 fake provider，作为 Workspace 观察的数据源）
pytest tests/test_wfm1_e2e.py -q
```

预期：全部通过，零网络、零付费、零 ffmpeg。

## 2. 逐条验收标准 → 证据映射

| 验收标准 | 复核命令 / 观察点 |
| --- | --- |
| WFM1 范围内观察/运行/管理/评价/学习闭环有真实证据 | `test_wfm1_workspace_closed_loop`：真实 Gateway 写评价/Action、真实 QueryService 回读 WQ-15/16、promote 后 WQ-17/18 反映 |
| UI、projection 损坏不改变权威业务状态 | `test_projection_rebuild_readonly_and_ui_restart`：双 app 实例字节一致、读前后文件快照相同、corrupt→readiness_failed→恢复 |
| 所有写经 Gateway，Provider/UI 不写业务事实 | 写路径只用 `WorkspaceApp.handle_write`→Gateway；`test_client_actor_is_ignored_forced_to_user` 证明 UI actor 强制 user |
| 资金、版本、恢复、防覆盖、凭据安全通过对抗测试 | `test_gateway_write_safety`（幂等/stale/凭据/未注册）+ `test_fault_matrix`（双支付门/ambiguous）+ origin/traversal 测试 |
| 文档、ADR、任务状态、代码、测试一致 | 本 runbook + 追踪矩阵 + milestone review + TASK-033 卡状态收口 |
| 图片/音频/字幕/完整 WFM2·WFM3 明确由 TASK-034～040 承接 | 追踪矩阵 §3/§4「后续 owner」「已知限制」 |

## 3. 手动走查（可选，观察真实数据）

```bash
# 复制一个真实 demo 项目到工作目录，构成一个账户根
WORK=$(mktemp -d)
cp -r examples/projects/wfm1-demo "$WORK/wfm1-demo"

# 只读观察（CLI 是 WFM1 baseline 的读表面之一）
python -m ai_video_workflow.cli ws-analytics --account-root "$WORK"        # WQ-17 跨项目 KPI
python -m ai_video_workflow.cli ws-recommendations --account-root "$WORK"  # WQ-18 证据化推荐
```

> 空账户/无事实项目会返回 `insufficient_evidence`（不是伪造的零），损坏日志会返回
> `source_corrupt` 且 `readiness_failed=true` —— 这两种都是设计内的 fail-closed。

## 4. 已知限制

见追踪矩阵
[workspace-wfm1-acceptance-traceability.md](workspace-wfm1-acceptance-traceability.md) §4。
要点：WQ-15～18 的浏览器 GET 呈现、多媒体 target、全媒体证据分别由 TASK-039 承接；
本门只验收 WFM1 数据与命令范围内的 Workspace 闭环，不是两份顶层需求的最终验收
（最终验收由 TASK-040）。

## 5. 用户签字

- [x] 已运行 §1 全部命令并通过
- [x] 已抽查 §3 只读观察，确认 fail-closed 行为符合预期
- [x] 认可 §4 已知限制与后续 owner 归属
- [x] **验收结论：PASS（2026-08-03 用户签字）**
