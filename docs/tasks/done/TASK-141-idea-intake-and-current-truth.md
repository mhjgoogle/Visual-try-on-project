# TASK-141：想法入口 —— 分层、里程碑闸与可重建的当前真相

- 状态：**已完成**（2026-09-05 开卡 · 同日收口 · codex 独立审查 2 轮 pass）
- Workflow：Feature（Agent 工装层）· 深度：DEEP
- 技术目标：dev-workflow Skill 的入口假设「这件事该做」**已经成立** —— 它从
  Requirement Understanding Gate 开始，之前没有任何一步问「这是哪一层」「这一轮
  必须做吗」。于是一个想法可以直接落成实施承诺，`active/` 长期挂着九张卡
  （AGENTS.md §2 写的是最多 1 主线 + 1 阻塞项）。本卡补上入口那两步，并让
  「当前真相」六个面在每次变更后可被重新构建
- 架构约束：`none-specific`（不碰产品代码；改的是 Agent 流程合同与文档生成工装）
- 依据：产品负责人 2026-09-05 —— 「禁止 Idea 直接进入 Coding」「每次先读 Current
  Milestone」「Requirement 与 Solution 分开」「修改之前必须做影响分析」
  「必须维护一个 Current Truth」
- 决策记录：[ADR-0101](../../adr/ADR-0101-idea-intake-level-and-milestone-gate.md)

## IN SCOPE

1. `ADR-0101`：六层模型、Requirement/Solution 分界、里程碑闸、影响分析的
   「哪些不动」、当前真相六面 —— 连同代价与被否掉的更重方案。
2. `AGENTS.md`：§2 加两条硬规则（想法不得直接进实现 / 需求不是方案），
   §8 加第 27 条（当前真相可重建）；目录表跟着改。
3. dev-workflow `SKILL.md`：新增**第 0.5 步 Idea Intake**（分层表 + 实现名词
   检验 + 里程碑闸 + Backlog 落卡最小格式）；第 5 步影响分析补六面与「哪些不动」；
   第 9 步收敛加当前真相重建检查。
4. `project-context.md`：三行带锚点的 mission / strategy / milestone。
5. `gen_docs_status.py`：生成「当前真相」节（六面），锚点缺失 **fail-closed**。
6. `tests/tooling/`：守卫 —— 锚点缺失必须转红、六面必须都在生成物里。
7. 重新生成 `STATUS.md`，`lifecycle_check` 零发现。

## OUT OF SCOPE

- 不建 traceability 数据库、不给每张卡加 metadata 文件、不按里程碑二级归档
  —— [out-of-scope.md](../../out-of-scope.md) 第 99 行那条边界不重访。
- 不改任何产品代码，不动 `mockups/` 与 `src/`。
- 不回填历史卡的层级标注（存量卡按原样，新想法按新入口）。
- 不替 TASK-125 做「当前事实收口」那一次性清理 —— 那是它的范围，本卡加的是
  **以后每次都要能重建**的机制。

## 受影响

| 面 | 文件 |
| --- | --- |
| 规则 | `AGENTS.md` |
| Agent 流程 | `.claude/skills/dev-workflow/SKILL.md` · `references/records.md` |
| 当前事实 | `docs/project-context.md`（新增锚点节） |
| 工装 | `.claude/tools/gen_docs_status.py` |
| 生成物 | `docs/STATUS.md` |
| 测试 | `tests/tooling/test_docs_status.py` |
| 决策 | `docs/adr/ADR-0101-*.md` |

## 架构影响

无产品架构影响：`docs/current-architecture.md` 的六节（模块边界 / 依赖方向 /
前后端合同 / 测试归属 / 架构约束 / Agent 读什么）一条都不变。

## 实施摘要

| IN SCOPE | 落点（代码级证据） |
| --- | --- |
| 1 ADR | `docs/adr/ADR-0101-idea-intake-level-and-milestone-gate.md`，决策 1–6 + 代价 + 被否方案 |
| 2 规则 | `AGENTS.md` §2 前四条（想法不得直接进实现 / 里程碑闸四问 / 需求不是方案 / 影响分析要答「哪些不动」）、§8 第 27 条、目录表第 8 行 |
| 3 Skill | `SKILL.md` 第 0.5 步（0.5a 分层表 · 0.5b 实现名词检验 · 0.5c 里程碑闸四问 + Backlog 落卡最小格式）、第 5 步六面影响分析、第 9 步收敛第 7 问；`references/records.md` backlog 卡最小字段 |
| 4 当前事实 | `docs/project-context.md` 三行 `<!-- current-truth: mission \| strategy \| milestone -->` 锚点 |
| 5 工装 | `gen_docs_status.py`：`CurrentTruthError` + `_read_current_truth()`（锚点缺失/空行 → 退出非零并指出缺哪一行）+ 六面渲染（Active Requirements / Deferred / Recent Decisions 从目录派生） |
| 6 守卫 | `tests/tooling/test_docs_status.py` 新增 5 例：三个锚点各缺一个必须转红、空值必须转红、六面必须都出现在生成物里 |
| 7 生成物 | `docs/STATUS.md` 已重新生成，含「当前真相（六面）」节 |

## 验证

- `pytest tests/tooling` → **379 passed, 1 skipped**（跳过的是 Ubuntu 目标的 bash 语法检查；轮 1 审查的两条 P1 修完后由 367 增至 379）
- `python .claude/tools/lifecycle_check.py` → **0 finding**
- `ruff check` → **All checks passed**
- 归属域：本卡只改 Agent 工装与文档，`src/`、`mockups/` 一行未动 → 按 ADR-0080 跑 `tests/tooling`，不跑全量（全量留给 merge 前的集成检查点）

### 独立审查（codex，2 轮，未降级）

审的是 `c6791eb`（`run-review.ps1 HEAD~1`）。四闸结论：

| 闸 | 结论 |
| --- | --- |
| 1 Requirement Fulfillment | 七条判据**全 `PASS`** |
| 2 Architecture Conformance | `none-specific` = `NOT_APPLICABLE`；AGENTS §25 / §26 / §20 与 out-of-scope 四条 `PASS`，无 `FAIL` |
| 3 Verification Sufficiency | `SUFFICIENT` |
| 4 Technical Quality | 无 BLOCKING；1 条 NON_BLOCKING → Follow-up |

四个缺口标签一个不挂（ADR-0088 决策 6）。

**轮 1 报出的两条 P1 及其修复**（都在 `c6791eb` 里）：

1. `_active_requirements()` 不看生命周期状态 —— DRAFT / SUPERSEDED 会被印进
   「现在必须成立的产品需求」，正是这个面存在的理由的反面。修复：新增
   `_binding()` 过滤 + `_not_yet_binding()`（不进表，但列在表下一行，**不消失**
   —— 一条消失的 DRAFT 就是一条被忘掉的需求）。**状态认不出的故意保留在表里**：
   悄悄藏掉一行比多印一行更糟，与锚点缺失 fail-closed 是同一条纪律。
2. 守卫只覆盖三个锚点里的第一个 —— 三个一起删只证明了 `mission` 被守着，而
   里程碑闸每次读的是第三面 `milestone`。修复：按面参数化（3 缺失 × 3 空值
   形状：空行 / 下一个锚点 / 标题），并补 CLI 出口那条（`main()` 返回 2 且
   **不写出**残缺 STATUS.md —— fail-closed 要一直开到出口）。

**驳回 1 条**（不修）：轮 1 报 `tests/studio/test_account_image_gen_task139.py`
越界。那是同一棵树上第三方会话未提交的 TASK-139 文件，不属本卡的面；轮 1 的
exclude 漏了 `tests/studio/`，轮 2 已排除。

**一次作废的重跑**（不计轮次）：轮 2 第一次启动后，另一个会话把这批改动提交为
`c6791eb`，`run-review` 不带 base 审的是「工作树 vs HEAD」，改动进 HEAD 之后
审查者拿到空 diff，于是七条判据全 `NOT_EVIDENCED`。空 diff 的回声不是判词，
作废，改用 `HEAD~1` 审提交本身。教训已登记为 Follow-up 5.25。

## Follow-up

- 存量卡不回填层级标注（OUT OF SCOPE），新想法按新入口走 —— 若三个月后仍有卡
  说不清自己在哪一层，再考虑回填。
- [总账 5.24](../active/TASK-087-followup-ledger.md)：`gen_docs_status.py` 用定宽切片取 REQ 号，
  `REQ-1000` 会静默错配（P3，今天不可达）。
- [总账 5.25](../active/TASK-087-followup-ledger.md)：AGENTS §14「一张卡一个 Agent」没有
  提交前的发现手段 —— 本卡收口时两个会话撞车的实测代价。
