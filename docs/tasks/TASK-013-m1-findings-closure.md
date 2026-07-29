# TASK-013：M1 Findings Closure（整体审查 blocker/important 收口）

> **状态：实施中（IN PROGRESS）——M1 整体 Codex 审查未通过后的收口任务。**
> 关闭 7 类 blocker 根因组 + 已确认的 important，使 M1 最小闭环达到
> 最终验收。实施 Agent 唯一；另一 Agent 仅作独立审查（AGENTS.md §14/15）。

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

## 验收

- 每个 blocker 与上述 important 都有对应反例测试（复现→修复→绿）。
- 全量 `pytest`、`ruff format --check`、`ruff check`、`git diff --check`
  全绿；工作树干净。
- 冻结的 TASK-004 生产文件不被本任务修改（仅 M1 层与文档）。
- 不 push；不进入 TASK-008；不宣布整体项目完成。
