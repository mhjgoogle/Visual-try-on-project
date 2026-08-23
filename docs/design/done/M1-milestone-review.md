# M1 Milestone Review Record

- 日期：2026-07-30
- 范围：M1 全部实现 diff（baseline `63aa45c` → HEAD `076b04e`），
  TASK-005 + TASK-006 + TASK-007，含 TASK-013 findings-closure 与
  第三方 fix 轮（含本轮 4 项 second-round findings 修复
  `c13dbe8` + `076b04e`）。
- 模式：batch milestone mode 的一次独立 milestone 复审（roadmap
  §3 M1 门槛第 5 项）。由四个独立对抗性审查代理并行完成，每项
  findings 均经实际复现（tempdir 复现，非仅阅读）。fix agent 与
  reviewer 分离：本轮 4 项修复由 fix agent 提交，milestone 复审由
  独立代理执行并对该 4 项修复做对抗性验证。

## 结论

**M1 milestone review: PASSED —— 0 blockers / 0 important。**

- TASK-005 acceptance: **YES**（focused 142 passed / 1 skipped）
- TASK-006 acceptance: **YES**（focused 41 passed）
- TASK-007 acceptance: **YES**（focused 33 passed / 1 skipped）
- 跨任务：frozen-file 合规 **YES**（`git diff --name-only
  63aa45c..HEAD` 覆盖 orchestration/providers/models/manifest/
  persistence/serialization/project_data/validation/errors 为空）；
  本轮 4 项修复对抗验证全部 **HOLDS**。

## 门槛核对（roadmap §3 M1）

1. full pytest 全绿：**1883 passed, 2 skipped**（skip = ffprobe 未
   安装的可选 smoke + real-tools smoke 环境开关；均为合法 real-tool
   gate，非静默失败）；
2. `ruff format --check` / `ruff check`：clean（118 files）；
   `git diff --check`：clean；
3. `tests/test_minimal_loop.py` fake-based 一条命令端到端：通过；
4. product_spec 成功标准 1–5 均有客观测试证据（标准 5 由 fake-based
   E2E 结构性满足 + real-tools smoke skipif-gated）；
5. 独立 milestone 复审：**本记录**；
6. ADR-0002 / ADR-0003：Accepted；ADR-0001 第二次增补：已提交；
   architecture.md §3 最小同步：已完成；另新增 ADR-0004（durable
   写入 project-root containment）、ADR-0005（byte-stable recovery
   单一操作时间）在实施期落地。

## 本轮 4 项修复的对抗验证结论

- (a) composition inspect/hash 先于 publish：HOLDS —— fresh /
  recovery A / redrive 三路径均无法把不可解码输出写入
  `outputs/final_v<N>.mp4` 或 COMPLETED manifest；
- (b) validation/composition 完成态 no-op 时间交叉核对：HOLDS ——
  report/asset 时间漂移一律 typed conflict，不再 silent skip；
- (c) QCD 固定域完整性：HOLDS —— 直接构造 raw `QcdEvent(...)` 违反
  §4 任一固定值/跨字段均 `InvariantViolationError`；
- (d) 统一 corrupt 映射：HOLDS —— 触发深层 TypeError/ValueError 的
  日志行一律 `CorruptEventLogError`，无裸异常泄漏。

## 非阻塞 suggestions（记录，不阻塞 gate；留作后续或 M2 顺带处理）

1. `qcd/log.py` corrupt-line 消息在 `occurred_at` 分支双前缀
   （`"...line N: ...line N: ..."`）—— 仅文案，行号与类型正确；
2. `assets/validation.py` 独立 `validate_artifact` 读取 staged 文件
   用 `_path_allowed`（resolve-containment）而非 `resolve_within_root`
   的逐组件 symlink 拒绝；`run_validation_step` 已先经
   `resolve_within_root`，无可复现逃逸；建议统一 resolver；
3. 校验容差 `<=` 在 IEEE-754 精确边界可能落在容差外（确定性、稳定）；
   建议文档化边界语义；
4. `run_composition_step` 未接受/透传 `elapsed_ms`，`composition_
   completed.elapsed_ms` 在 M1 恒为 null（schema 合规；CLI 接线时可
   补）；
5. 完成态后 intent 被清理，若之后仅报告丢失（媒体+COMPLETED 存活）
   重跑走 recovery C 冲突而非重生成报告（安全选择）；
6. `task_created`/`task_status_changed` 事件在 persist→append 间崩溃
   可缺失（ADR-0003 §9 已知边界，TASK-009 对账暴露）；
7. 若干守卫测试可加强断言（missing-asset 全缺口清单、status 守卫、
   criterion 5 显式 owner）。

以上 suggestions 无一改变已批准合同或构成安全/正确性缺陷。

## Gate 判定

- M1 final acceptance: **YES**
- M2 may begin: **YES**（TASK-008 需产品假设已定 + 模型增补独立
  审批 + ADR-0001 第三次增补；TASK-009 无产品门槛）
- M3 may begin: **NO**（TASK-010 付费 API 越第一阶段边界，需显式
  解除 + ADR；厂商/预算/凭据/本地模型/硬件/路由权重待用户裁决）
