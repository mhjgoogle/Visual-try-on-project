# TASK-100：skill-evolution Skill v0.1 —— 受控的 Skill 演化闭环

- 状态：完成
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
- gate 全量：da4fa32 通过（3427 项并行 + 串行，0 失败）。
- codex-review-loop（Medium · 1 轮，reviewer=codex，干净 worktree 对
  HEAD~1 送审）：fail，3 blocking + 4 non-blocking。定级与处置：
  - P1 已修：skill 名未消毒可路径穿越 → `_bad_name` 白名单 + 拒 `..`。
  - P2 已修（定向测试覆盖）：PROPOSED/APPROVED 仍计为复审证据（重复触发
    Review）→ EVIDENCE_STATUSES；共享 tmp 名并发碰撞 → pid 后缀 tmp；
    `status` 不刷新 revision → 已按文档合同刷新；compact 先追加后删的
    重试重复 → 归档前按 id 去重。
  - P3 只记录：set-status 不强制状态机转移（agent 语义层职责，v0.1 不加
    刚性）；rename 摘要撞车（多个内容相同的 Skill 同时改名，保守限制已在
    reference 写明）。
  - P1 修复按预算规则花 +1 轮复审：见第 2 轮记录。
- 修复后定向测试：20 passed；ruff check + format 通过。
- 第 2 轮（P1 修复的 +1 轮，reviewer=codex）：fail，1 blocking + 1
  non-blocking，均为轮 1 主题的收窄变体。定级裁决（rebuttal 记录在案）：
  - 「compact 等未消毒」降为 **P2**：这些函数在任何文件操作前都先查
    index，而进 index 的唯一门已消毒；剩余向量需要能手改 index.json 的
    攻击者——那等于已有仓库写权限，护栏对其无意义。仍按「修整类比争论
    便宜」原则把 `_bad_name` 加到全部带 skill 参数的入口。
  - 正则 `$` 接受尾部换行：**P2 真问题**（白名单绕过 + 双平台分歧），
    改 `re.fullmatch`。
  - 按预算规则：无 P1 在场，Medium 档 P2 修复以定向测试收口（20 passed，
    含全入口消毒 + 换行名拒绝），**不再开第 3 轮**。P2 修复 reviewed-once
    如实记录。

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
