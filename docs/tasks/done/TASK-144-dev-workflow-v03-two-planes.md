# TASK-144：dev-workflow v0.3 —— 压成「人类控制面 / Agent 执行面」两层

- 起因：产品负责人 2026-09-08 —— 「不是继续增加开发规则，而是把现有规则压缩成
  「人类控制面」和「Agent 执行面」两层，并让 QUICK / STANDARD / DEEP 自动决定需要
  展开到哪一层。」· 闸：**用户直接指示**（Milestone 层归用户，AGENTS §1）——
  按四问它不在切片 ② 的交付面上，但改不改流程是他的决定权，不是我的排序题。
- 类型：Refactor · 深度：**DEEP**（C=DEEP：本 Skill 是所有 Agent 的合同；
  U/I/R = QUICK / DEEP / QUICK，取最高）
- 成果物：[ADR-0103](../../adr/ADR-0103-two-planes-and-cost-based-depth.md) ·
  本卡 · `references/depth.md` · 提交（**不建 REQ** —— 工装无产品需求）
- 技术目标：v0.2 的 SKILL.md 一份正文同时承担路由 + 需求治理 + 架构治理 + 文档
  生命周期 + 测试治理 + 审查治理 + Git 治理，381 行**每次开发任务都要读一遍**。
  规则本身没错，错在都堆在入口；而深度分档按「单模块 / 多文件 / 跨模块」判，会把
  「schema 改一行」判成小任务。这两件都直接推高每次任务的判断成本与判错概率。
- 架构约束：`CA §4` 测试归属（本次只引用，不改）· `none-specific`（Skill 文档不
  参与模块依赖图）

## 范围与影响

**IN SCOPE**：`.claude/skills/dev-workflow/**` 的正文重构 · 深度判定换成四变量 ·
Decision Brief 落进卡头 · 控制面/执行面分层写成规则 · 仓库里指向旧步号的**当前
事实类**文档对齐 · ADR-0103。

**OUT OF SCOPE**：AGENTS.md 的**规则内容**（只改两处指向旧步号的措辞）·
ADR-0080/0081/0087/0088/0101 的正文（历史证据，不回改）· 其余 Skill 的核心行为 ·
`gen_docs_status.py` / `STATUS.md` / `WORKSTATUS.md`（另一个会话的在制品，
已按 AGENTS §16 认领分工）。

六面：

| 面 | 要改 / 不动 |
| --- | --- |
| Requirement | **不动** —— 工装任务，无产品需求（走「技术目标」行） |
| UI | **不动** |
| 数据 Schema | **不动** —— 卡头新增两行是 Markdown 约定，不是被程序解析的 schema |
| Workflow | 改：`.claude/skills/dev-workflow/**`（正文 + 8 份 references + 新增 depth.md） |
| 测试 | **不新增测试**，跑既有 `tests/tooling`（`lifecycle_check` / `docs_links` / `agent_harness` 三道守卫都覆盖本次改动面） |
| docs | 改：`AGENTS.md`（2 处步号措辞）· `docs/current-architecture.md`（1 处）· auto-push Skill（2 处）· 新增 ADR-0103 |

架构决策与理由在 ADR-0103，本卡不复制。

## 结果与验证

- 实现：完成。
  - `SKILL.md` 381 → 六环结构（Intake / Classify / Depth / Contract / Execute /
    Close），条件规则全部下沉 `references/`；末尾留「旧步号 → 新环节」映射表，
    因为 `docs/adr/` 是历史证据、不回改，那里的「第 9 步」必须仍然解析得出来。
  - `references/depth.md`（新增）：U × I × R × C 四变量、取最高、边界情形、
    「深度 ≠ 验证强度」。
  - `references/records.md`：新增「控制面与执行面」四层表 + 「Decision Brief
    逐字段」；卡模板加 `起因` / `成果物` 两行。
  - `references/handoff.md` §2 新增第 0 步（`ListAgents` 先于 `git status`）。
  - `references/workflows.md` 骨架换成六环。
  - 前置提交 `18cdcac`（dev-workflow 记录最小化）没有卡，本次一并登记在本卡下 ——
    它是同一条治理线上紧邻的上一步，没有别的卡覆盖它。
- 验证：
  - 技术目标 → `pytest tests/tooling`（`test_docs_links` 钉住新增/改写的每条
    链接、`test_lifecycle_check` 钉住卡与 ADR 的形状、`test_agent_harness` 钉住
    `.agents/` 生成入口与 `.claude/skills/` 源同步）。
  - `python .claude/tools/lifecycle_check.py` 零发现。
  - `python .claude/tools/agent_harness.py apply` 后 `check` PASS（frontmatter
    description 改了，生成入口必须跟着重出）。
  - 纯文档改动，按 AGENTS §20 触发表**不调** `codex-review-loop`。
- 真实项目尚未由人看过的验收项：**下一次真实开发任务是否真的更轻**。这是信息，
  不是闸门 —— 用得不满意就再改（AGENTS §1）。
- 剩余：无。范围外问题走 [TASK-087](../active/TASK-087-followup-ledger.md)。
