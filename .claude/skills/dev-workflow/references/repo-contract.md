# Repo Contract

一个 repo 必须能回答八个问题。**先识别现有结构；已满足就直接用；
只有真缺失才补齐 —— 不平行创建第二套。**

## 通用合同（八个问题）

1. 项目怎么运行？
2. 当前有效事实（现状、规格）在哪里？
3. Requirement 在哪里？
4. Change 在哪里？
5. 当前 Architecture / Module Boundary 在哪里？
6. 历史 / superseded 信息如何处理？
7. Tests 怎么运行？
8. Agent 应遵守哪些 Project Rules？

Contract 约束的是「必须能回答」，**不强制统一目录结构**。

## 本仓库的答案（2026-08-22 盘点）

| 问题 | 答案 |
| --- | --- |
| 怎么运行 | `README.md`（Windows 权威 + Ubuntu 目标）；`scripts/launch/studio.ps1` / `scripts/launch/studio.sh`；Studio 见 `mockups/motv-workspace/` |
| 有效事实 | `docs/product_spec.md`、`docs/architecture.md`、两份顶层需求文档、`docs/design/creator-system-contract.md`（Studio 范围唯一权威，与信息架构文档并列） |
| Requirement | **新需求**：`docs/requirements/REQ-*.md`（索引 `docs/requirements/index.md`；见 records.md）。**存量需求**：上一行的基线文档 + 任务卡「依据：产品负责人 YYYY-MM-DD」行 —— 不回填，不迁移 |
| Change | `docs/tasks/active/TASK-*.md`（在办）、`docs/tasks/done/`（已完成）——**目录即状态**（ADR-0083）；QUICK 深度 = 提交信息即记录。欠账在 `docs/tasks/active/TASK-087-followup-ledger.md`。总览 `docs/STATUS.md`（生成的，改完跑 `python .claude/tools/gen_docs_status.py`） |
| 架构边界 | `docs/architecture.md`、`docs/adr/`（决策）、`docs/design/creator-product-information-architecture.md`（页面集合封闭）、`docs/design/workflow-stage-step-io-contract.md`（L0–S7 输入输出） |
| 历史处理 | REQ 文件内追加版本（v2 supersedes v1，不篡改 v1）；任务卡改状态不删卡；ADR 用新 ADR 取代旧 ADR；follow-up 总账闭合时划掉不删行 |
| 测试 | `python -m pytest -n 8 -m "not serial"` + `python -m pytest -m serial`（全量两阶段）；前端 `node --test mockups/motv-workspace/tests/*.test.mjs`；分域独立运行：`pytest tests/backend` / `tests/studio` / `tests/contract` / `tests/e2e` / `tests/tooling`；归属规则 = AGENTS.md §20 + ADR-0080；本地 gate = `.claude/hooks/`（ADR-0080/0070） |
| Agent 规则 | `AGENTS.md` —— **唯一一份**，含决策模式、范围切片、技术/架构/协作/测试审查/Git 全部条款（`CLAUDE.md` 只是 Claude Code 的入口，`@AGENTS.md`）；项目背景在 `docs/project-context.md` |

**缺口盘点结论**：本仓库唯一真缺的是轻量 per-requirement record（问题 3），
已由 `docs/requirements/` 补齐（ADR-0076）。其余七项复用现有机制。

**2026-08-22 更新（TASK-102 / ADR-0080）**：测试改为按归属分域，问题 7 的答案
见上表「测试」行；README 只保留仓库根一份且面向使用者，Agent 规则在 AGENTS.md /
CLAUDE.md（问题 1、8 的答案不变，只是子目录 README 已清）。
