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
| 怎么运行 | `README.md`（Windows 权威 + Ubuntu 目标）；`run-windows.ps1` / `run.sh`；Studio mockup 见 `mockups/motv-workspace/` |
| 有效事实 | `docs/product_spec.md`、`docs/architecture.md`、两份顶层需求文档、`docs/design/creator-system-contract.md`（Studio 范围唯一权威，与信息架构文档并列） |
| Requirement | **新需求**：`docs/requirements/REQ-*.md`（本 Skill 引入，见 records.md）。**存量需求**：上一行的基线文档 + 任务卡「依据：产品负责人 YYYY-MM-DD」行 —— 不回填，不迁移 |
| Change | `docs/tasks/TASK-*.md`（STANDARD/DEEP）；QUICK 深度 = 提交信息即记录。欠账在 `docs/tasks/TASK-087-followup-ledger.md` |
| 架构边界 | `docs/architecture.md`、`docs/adr/`（决策）、`docs/design/creator-product-information-architecture.md`（页面集合封闭）、`docs/design/workflow-stage-step-io-contract.md`（L0–S7 输入输出） |
| 历史处理 | REQ 文件内追加版本（v2 supersedes v1，不篡改 v1）；任务卡改状态不删卡；ADR 用新 ADR 取代旧 ADR；follow-up 总账闭合时划掉不删行 |
| 测试 | `python -m pytest -n 8 -m "not serial"` + `python -m pytest -m serial`（全量两阶段）；前端 `node --test mockups/motv-workspace/tests/*.test.mjs`；分档运行规则 = AGENTS.md §20；本地 gate = `.claude/hooks/`（ADR-0060/0070） |
| Agent 规则 | `AGENTS.md`（全体 Agent）+ `CLAUDE.md`（决策模式 / 实施纪律 / Claude 专用） |

**缺口盘点结论**：本仓库唯一真缺的是轻量 per-requirement record（问题 3），
已由 `docs/requirements/` 补齐（ADR-0076）。其余七项复用现有机制。
