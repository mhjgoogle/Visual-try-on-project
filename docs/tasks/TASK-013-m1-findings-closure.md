# TASK-013：M1 Findings Closure（整体审查 blocker/important 收口）

> **状态：已实现并验收（IMPLEMENTED AND ACCEPTED）——M1 整体 Codex
> 审查 findings 已收口，随后 M1 milestone review 通过（2026-07-30，
> 0 blockers / 0 important）。** 7 类 blocker 根因组 + 已确认的 important
> 均已修复并各配反例测试。验收记录见
> [M1-milestone-review](../design/M1-milestone-review.md)。

## 正式名称

M1 Findings Closure: Path Containment, Recovery Determinism, Asset
Versioning, and Run Resume

## 背景

M1 batch 实施（TASK-005/006/007）通过了各自的聚焦测试（1839 passed），
但整体审查独立复现出 7 类 blocker 与若干 important：现有测试未覆盖这些
合同反例。本任务在不扩大 M1 功能范围的前提下修复它们，并补齐反例测试。

相关决策记录：[ADR-0004](../adr/ADR-0004-project-root-containment-and-symlink-policy.md)
（containment/symlink）、[ADR-0005](../adr/ADR-0005-recovery-time-and-report-identity.md)
（恢复时间与报告身份）。

## Blocker 根因组与修复合同

1. **全链路 path/symlink containment 缺失**（B/C/D/E 交叉）。
   按 ADR-0004：新增 `security/paths.py::resolve_within_root`，所有
   durable 读写与外部工具路径经它构造；ffmpeg concat 清单转义 `'`
   并拒绝换行。

2. **validation 部分提交/输出漂移恢复不成立**（B）。按 ADR-0005：
   续跑复用已落盘 JSON 报告的 `observed_at`（报告/资产/manifest/QCD
   同一时间）；no-op 强化为校验报告身份 + 媒体 SHA + 资产可载。

3. **per-shot 资产版本与 redo 不兼容**（B）。资产/媒体版本改为按
   **shot 的既有正式媒体** 决定（对已发布版本按内容探测：同 SHA 复用
   该版本，否则取下一个未占用版本），而非仅按当前 task 的 validation
   manifest 派生。补 redo→validate→compose E2E。

4. **composition 部分提交/no-op 恢复矩阵不成立**（C）。按 ADR-0005
   复用报告时间；no-op 校验 MD + 报告身份 + 媒体 SHA；实现 recovery E
   （已完成 manifest + 残留 intent 的 best-effort 清理，即使走 no-op
   分支也清理）；composer/FFmpeg 失败时写 FAILED manifest。

5. **`run` 无法从非终态断点续跑**（D）。`run` 逐步按
   `ResumeAssessment.legal_actions` 门控每个生命周期动作（已完成的
   动作不在 legal set 中即跳过），不再对非终态无条件重新 prepare。

6. **`run` 将 FAILED/CANCELLED 当作成功**（D）。终态任务在 validate/
   compose 前显式校验 `GenerationTaskStatus.DONE`；FAILED/CANCELLED
   以清晰错误中止（退出 1）。

7. **bootstrap 可覆盖/接受非等价 companion manifest**（D/E）。
   companion manifest 采用 CAS/no-replace：存在则校验身份等价
   （step_name + input_digest + config_digest + status=PENDING），
   不等价即 `TaskAlreadyExistsError`；绝不 `overwrite=True` 覆盖。

## Important 收口

- QCD 读取方 first-wins 去重（ADR-0003 §5「读取方必须去重（保留首行）」）；
  修正锁定旧行为的测试。
- QCD per-type 值域校验：SHA-256 十六进制、非负整型 ms、正整型
  version/size、固定 status/action 取值。
- composition 报告记录每个输入的 file digest；发布前后一致。
- CLI：`run` 移除有歧义的单一 `--staged-path`（多任务各用 staging
  合同路径）；单独 `validate` 在 `passed=false` 时退出 1；redo 在最高
  attempt 仍为 PENDING（未使用）时幂等复用，不再堆叠 v2→v3。
- README 尾部空行修复；TASK-005/006/007 状态同步为「已随 TASK-013
  收口」。

## 复审收口（第二轮 Codex）

第一轮修复后复审又提出 3 blocker + 5 important，均已在本卡内继续收口：

- **containment 未覆盖 bootstrap/driver/CLI**：这些层的 task/manifest/
  记录读写与 instruction 路径全部改经 `resolve_within_root`；补 bootstrap
  symlinked-records 外写反例。
- **validation/composition no-op 身份不足**：no-op 改为对磁盘 JSON+Markdown
  报告做逐字节比对（等价于全 identity + 确定性 Markdown 校验），篡改/漂移
  报告一律 conflict 而非 skip；补双侧篡改反例。
- **composition 未 inspect/未复核输入**：`run_composition_step` 现要求
  `MediaInspector`，发布后 inspect final media（不可解码 → FAILED manifest、
  同时回填 `output_duration_ms`），并在发布前复核输入摘要；补不可解码与
  输入漂移反例。
- **QCD 值域仅在 builder**：值域 + 相对路径 + 确定性 event_id 派生下沉到
  `QcdEvent.__post_init__`，直接构造与日志反序列化同样强校验；补回 ADR-0003
  的 `replay_result` action；补反序列化拒绝反例。
- **redo 崩溃恢复**：PENDING 顶层重试改经 `_ensure_task` 补齐缺失 manifest/QCD，
  不再跳过留下不可运行的 v2；补崩溃修复反例。
- **composition internal journal 公共导出 / TASK-007 `--staged-path` 合同**：
  journal 从 package `__all__` 移除；TASK-007 卡同步 `run` 无 `--staged-path`
  的最终合同。

## 验收

- 每个 blocker 与上述 important 都有对应反例测试（复现→修复→绿）。
- 全量 `pytest`、`ruff format --check`、`ruff check`、`git diff --check`
  全绿；工作树干净。
- 冻结的 TASK-004 生产文件不被本任务修改（仅 M1 层与文档）。
- 不 push；不进入 TASK-008；不宣布整体项目完成。
