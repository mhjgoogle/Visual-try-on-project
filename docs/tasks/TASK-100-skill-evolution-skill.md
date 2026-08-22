# TASK-100：skill-evolution Skill v0.1 —— 受控的 Skill 演化闭环

- 状态：进行中
- Workflow：Feature · 深度：DEEP
- 关联 Requirement：依据 = 产品负责人 2026-08-22 完整指令（本卡的需求原文，
  要点：低 Token 反馈采集 / per-skill backlog / 全局轻量 index / 新 Skill
  懒注册 / 手动 Full Sync / >=3 同类或 Severe 触发 Evolution Review /
  Proposal 须批准才改核心行为 / Protected Behavior / 防膨胀收敛）。
  优先级排序：低 Token > 安全 > 基于证据 > 可追溯 > 可持续演进 > 自动化程度。
- 目标：建立 Skill Usage → Feedback → Evidence → Review → Proposal →
  Approval → Update → Validation 的受控演化循环，Token 成本随 Skill 数量
  增长保持可控。

## IN SCOPE

- `.claude/skills/skill-evolution/`：SKILL.md（控制面）、references（慢循环
  与数据模型细则）、`scripts/evolution.py`（确定性操作 CLI）。
- 数据：`docs/skill-evolution/`（index.json、backlogs/*.jsonl、archive/、
  proposals/、README.md）。
- dev-workflow 第 10 步追加一行 Post-Use Feedback 挂接。
- pytest 覆盖注册/记录/阈值/severe/sync/rename/missing/compact/protect。

## OUT OF SCOPE（v0.2+，需求原文第 34 节）

定时扫描、全局周期 Audit、自动重写、daemon/watcher、telemetry、dashboard、
embedding/vector、multi-agent committee、每次使用跑完整 eval、跨 Skill 大重构。

## Impact Analysis

- 受影响模块：仅新增 agent 工装与 docs 数据目录；产品代码零改动。
- 合同：新建 index/backlog schema（ADR-0078）；dev-workflow SKILL.md +1 行。
- 测试：新增 `tests/test_skill_evolution_tooling.py`；不动既有测试。
- gate：数据放 `docs/` 使 feedback 追加提交走 lint 档（Token/时间硬约束）。

## 架构影响

新公共机制 → ADR-0078（数据位置、单 Python 脚本、触发点、阈值、权限边界）。

## 实施摘要

- `.claude/skills/skill-evolution/`：SKILL.md（控制面：Fast Loop 5 步、
  三个触发、Token 纪律）、`references/review-and-proposal.md`（Slow Loop：
  severe 判据、十问、EP 模板、批准边界、验证）、`references/data-and-sync.md`
  （index/backlog schema、recurrence key、懒注册、sync/rename/missing）、
  `scripts/evolution.py`（单 Python CLI：status / register / record /
  set-status / protect / review-context / sync / compact）。
- 数据：`docs/skill-evolution/`（README + index.json + backlogs/*.jsonl；
  archive/、proposals/ 首次使用时产生）。已用真实 `sync` 纳管 3 个既有
  Skill，并记录第一条真实 dogfood 反馈（fb-dev-workflow-0001）。
- dev-workflow SKILL.md 第 10 步 +2 行：提交后做一次 Post-Use Feedback。
- 机制决策：ADR-0078（数据放 docs/ 的 gate 经济学、单 Python 实现、
  触发点适配 commit、身份/rename、批准边界、反膨胀）。

## 验证

- `pytest tests/test_skill_evolution_tooling.py`：16 passed（懒注册/阈值/
  severe/review-context 过滤/proposal 状态机/protect/compact/sync 纳管/
  missing 保历史/rename 迁移/MISSING 复活/CLI 往返/fail-closed）。
- `ruff check` + `ruff format`：通过。
- 真实仓库实弹：`sync` 纳管 3 Skill；`record` 落 fb-dev-workflow-0001。
- gate 全量 + codex-review-loop（Medium · 1 轮）：见提交后记录。

## Follow-up

- **跨任务阻塞修复（最小范围，绕不开）**：gate 全量在工作区跑到 TASK-098
  未提交的 `motionpreview.js` 含字面 NUL（`test_no_source_file_contains_a_nul_byte`
  失败，拦下本任务提交）。已按该测试自己的要求把字面 NUL 换成 `\u0000`
  转义（运行时字符串相同，motionpreview 36 项测试仍全绿）。修复留在
  工作区给 TASK-098 的提交携带，不进本卡提交。
- v0.2+（需求方明确出范围）：定时扫描、全局周期 Audit、telemetry、
  dashboard、embedding、每次使用完整 eval、跨 Skill 大重构、daemon。
- rename 检测限「内容未变的改名」；改名+改内容同批发生会退化为
  MISSING + 新注册，需人工并回（references/data-and-sync.md 已写明）。
