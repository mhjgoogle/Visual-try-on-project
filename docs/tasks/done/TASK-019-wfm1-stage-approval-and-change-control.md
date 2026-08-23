# TASK-019：WFM1 阶段审批与变更控制

> **状态：Implemented。** 路径 ADR 见
> [ADR-0012](../../adr/ADR-0012-wfm1-stage-planning-release-paths.md)。实现：
> `approval/workflow.py`（L0/S1–S7 registry、转换表、audit.jsonl、
> `require_stage_ready` 接入既有 `require_stage_approved` 单一入口），CLI
> `stage-plan/status/review/approve/reject/revise`；审批 v2 marker 合同
> 零改动。

## 目的

把 L0、S1-S7 的人工审批、退回修改和上游变更失效规则落为独立工作流状态，
确保未批准内容不能触发下游生成或付费，并支持逐阶段断点续做。

## 输入

- 工作流文档 §2、§9 的阶段和审批语义；
- [Creation Workspace 数据可观察性要求](../../creation_workspace_data_observability_requirements.md)
  中 workflow plan / stage approval / status reason 的语义责任；
- TASK-015 `approval/<stage>.json` v2、digest gate 和原子持久化；
- TASK-016/017 付费协调器的既有守门入口：`require_stage_approved(
  project_root, stage)` 于 reservation/Provider 调用**之前**执行
  （`PaidRequest.stage`，默认 `concept_lock`）——stage registry 必须
  接入同一入口，不得为付费链另建第二个审批检查点；
- TASK-018 的 project profile 与复用资产引用。

## 输出

- 固定的 WFM1 stage registry、前置关系和允许状态转换；
- 新项目未运行时也可由 registry 与项目 profile 派生完整阶段/步骤计划；
- 基于现有审批 v2 的 review/approve/reject/revise CLI；
- 上游 target 变化时的自动失效与下游阻断；
- 结构化 change request/audit 记录，以及状态恢复测试。

## 修改范围

`approval/` 的增量 workflow service、CLI、对应 JSON 示例和测试；如需新增
change-request 物理路径，先以配套 ADR 增补 ADR-0001，不修改既有审批文件合同。

## 明确不做

- 不把审批状态写入 GenerationTask、StepManifest、Provider 或 QCD 事件；
- 不实现 Web UI、多人权限系统或逐任务人工批准；
- 不实现 Command Gateway、Action Center、pause/cancel 或 UI 自有运行状态；
- 不自动生成创意内容，不改变 TASK-015 的 digest 守门语义；
- 不允许审批动作隐式覆盖被审批目标。

## 实施步骤

1. 定义 L0/S1-S7 stage id、前置 stage 与合法转换表。
2. 在现有 v2 marker 之上实现显式状态转换和审计记录。
3. 每次 approve 重算并锁定 target digest；下游入口统一调用 stage gate。
4. 上游内容或复用引用变化时，使依赖阶段不可继续并给出修复动作。
5. 为中断、重复命令、非法转换和损坏状态增加恢复测试。

## 测试要求

- 全部合法/非法转换、缺前置批准、stale digest、路径逃逸；
- 重复 approve 幂等，内容变化后旧批准 fail-closed；
- 阶段/步骤稳定 ID、依赖、输入输出和阻断原因可由权威文件查询；
- 任一未批准阶段均为零 Provider 调用、零 reservation；
- 状态文件损坏不被猜测修复，错误可定位。

## 验收标准

- [ ] 审批状态与运行态完全分离；
- [ ] L0/S1-S7 的前置关系和变更失效有自动化测试；
- [ ] 阶段可独立执行、退回和恢复，不覆盖已有产物；
- [ ] 完整计划和当前进度均可从 registry/profile/approval 派生；
- [ ] 保持 batch milestone review，不引入逐任务批准流程。
