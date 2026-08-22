# 五条主工作流

共同骨架（第 16 条循环）：
`Requirement → Change Record → Impact Analysis → Architecture Check(条件) →
Implementation → Targeted Verification → Convergence → Done`。
每条工作流只改变各阶段的**重点**，不强制生成完整 plan/design/task 文档。

## 1. Feature / Enhancement

- Requirement 先行：有 CONFIRMED REQ / 用户原话就直接做；只有推断时建 DRAFT。
- **垂直切片**：每片自己能跑、能演示、能验证；不按 schema→service→UI 分层推进。
- UI/UX 拿不准不问「A 还是 B」——做一版给用户看（CLAUDE.md 决策模式）。
- Discovery 产物（prototype/实验/截图）只是 Evidence；确认后按正式路径落地。
- Done 加验：REQ 的验收判据满足，用户能在真实环境看到它跑。

## 2. Bug Fix / Debugging

铁序：**reproduce → evidence → root cause → fix → regression verification**。

- 先复现。复现不了 → 先加观测/日志拿证据，不是先改代码。
- 根因没懂之前**禁止 patch**；「再试一个改法」连发两次就是违规信号，停下回到证据。
- 修复必须配一条**先红后绿**的回归测试（复现即测试的雏形）。
- 间歇性问题（如「偶尔 500」）：从日志/时序/并发/资源四个面取证据，
  记录复现条件到任务卡；确实无法稳定复现时，写明观测手段和触发假设再修。
- 修根因，不修症状；症状级 workaround 只允许作为**显式标注的临时措施**并记 Follow-up。

## 3. Refactor / Cleanup

- 目标：结构、复杂度、重复、过期实现。**默认不改有效产品行为。**
- 动手前确认行为有测试护住；没有 → 先补 characterization 测试再动。
- 行为改变一旦不可避免 → 这不再是 Refactor，回路由（Feature 或升级用户）。
- 删除遵循 convergence 规则（verification.md）：被新 CONFIRMED REQ 取代的
  旧行为，其代码/测试/文档允许删；拿不准的记 Follow-up 不硬删。
- 分片提交：每片独立绿，可随时停在任意片。

## 4. Performance Optimization

铁序：**baseline → bottleneck identification → optimization → benchmark comparison**。

- **没有 baseline 不许动手**：先在可复现实验条件下测出数字（命令、数据集、
  机器、次数写进任务卡）。
- 用证据定位瓶颈（profile/计时），不凭直觉优化。
- 改一个变量测一次；**没有同口径对比数字不许宣称改善**
  （仓库先例：AGENTS.md §20 的 469s→179s 就带完整口径）。
- 优化不得改变行为；行为变化按 Feature/升级处理。

## 5. Migration / Upgrade

覆盖：依赖升级、框架升级、API 迁移、schema 迁移、运行时/基础设施迁移。

- 先盘点：谁在用旧的（调用面/数据面）、兼容性断裂点、**回滚路径**。
- 回滚优先设计：迁移前留可回滚旧数据；加法字段优先于破坏性变更；
  软删除优先于硬删（AGENTS.md 第 13 条本来就要求）。
- 分阶段：能新旧并存就先并存，切换与清理分开两步；清理是 convergence 的一部分，
  不是「以后再说」——旧路径退役要出现在本任务或显式 Follow-up 里。
- 本仓库特有：**Windows（权威）与 Ubuntu（受支持目标）都得绿**（ADR-0062）；
  schema/持久化迁移永远跑到集成检查点（两阶段全量 pytest + 全量前端 + ruff），
  并做一轮独立审查（P1 修复后复审一次；ADR-0080/0081）。
- 深度默认 DEEP；纯 patch 版本依赖升级且测试全绿可降 STANDARD。
