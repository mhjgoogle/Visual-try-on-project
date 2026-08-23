# TASK-001：项目基础（Project Foundation）

## 背景

项目处于阶段 0。仓库中尚无任何业务代码，Claude Code 与 Codex 将交替开发，
必须先建立两个 Agent 共同遵守的规范、产品规格、架构设计与实施规划，
作为后续所有任务的上下文来源（Agent 间不共享聊天记录，只共享仓库内容）。

## 单一目标

建立项目的规范与规划文档集，使任一 Agent 仅凭仓库内容即可理解项目目标、
架构约束与下一步工作。

## 范围内

- 创建 `AGENTS.md`（双 Agent 共同规范）；
- 创建 `CLAUDE.md`（引用 AGENTS.md + Claude Code 专用规则）；
- 创建 `docs/product_spec.md`（产品规格）；
- 创建 `docs/architecture.md`（架构设计）；
- 创建 `docs/implementation_plan.md`（阶段 0–9 实施规划）；
- 创建本任务卡。

## 范围外

- `src/` 下的任何业务代码；
- Python 数据模型、venv、依赖安装；
- 接入真实 LLM 或视频 API；
- 数据库、Web UI、Docker、云端部署配置；
- 视频生成与 FFmpeg 合成的实现；
- Git commit / push / merge。

## 输入

- 项目目标、工作流描述与协作规则——本任务的产出即其首次落盘，落盘后以
  AGENTS.md 与 docs/ 下各文档为唯一正式来源；
- 仓库现状（`main` 分支，仅 Initial commit，无业务代码）。

## 输出

- `AGENTS.md`
- `CLAUDE.md`
- `docs/product_spec.md`
- `docs/architecture.md`
- `docs/implementation_plan.md`
- `docs/tasks/TASK-001-project-foundation.md`（本文件）

## 验收标准

以下标准全部可通过仓库文件直接验证，未读取任何聊天记录的 Agent 应能独立验收：

1. "输出"一节列出的 6 个文件全部存在于约定路径；
2. AGENTS.md 包含覆盖以下全部主题的规则：
   - 项目长期目标与第一阶段目标；
   - WSL2 Ubuntu 环境与 Linux/POSIX 路径、命令约束；
   - 核心工作流与视频厂商解耦、所有视频生成方法经 VideoProvider 接口接入；
   - 第一阶段不接入付费 API；
   - Agent 协作规则（每任务单一实施 Agent、另一 Agent 独立审查、修改前检查
     git status、不越任务范围、决策落仓库文档）；
   - 测试与质量规则（新功能必须有测试；完成后运行格式化、静态检查和测试；
     重大设计变更创建 ADR）；
   - Git 与安全规则（未经用户明确要求不 commit/push/merge；不提交 API key、
     密码、生成视频或本地凭据）；
3. CLAUDE.md 简短，通过 `@AGENTS.md` 引用共同规范，并含 Claude Code 专用规则；
4. product_spec.md 说明问题、目标用户、长期工作流、第一阶段最小闭环、
   第一阶段不实现的内容、QCD 定义、成功标准；
5. architecture.md 说明工作流分层、核心概念（GenerationTask 只含当前编排状态，
   不嵌入 QCD 历史）、VideoProvider 概念生命周期与职责边界（Provider 只返回
   结构化结果、不写任何业务状态文件、媒体只落入编排器提供的 staging 或以引用
   返回；编排器唯一持久化 GenerationTask/VideoAsset/manifest/QCD 事件，并负责
   staging 分配、媒体校验与导入正式资产目录）、精确接口在阶段 2 基于阶段 1
   数据模型确定、ManualVideoProvider、未来 Provider 扩展、中间产物保存、
   目录原则、断点续跑（含步骤 manifest 与跳过条件）、覆盖保护、QCD 数据记录
   边界（append-only 事件日志为唯一事实来源）、暂不实现项；
6. implementation_plan.md 包含阶段 0–9，且阶段划分（含"阶段 1 数据模型、
   阶段 2 定接口"的边界）、Provider 职责边界、QCD 原始事件采集（阶段 2–4）
   与汇总报告（阶段 6）的分工与 product_spec.md、architecture.md 一致；
7. 未创建任何范围外文件，未执行任何 Git 提交操作。

## 测试要求

本任务为纯文档任务，无代码测试。验收方式为人工审阅 + 审查 Agent 独立检查
文档间的一致性（术语、阶段划分、规则编号无冲突）。

## 预计影响文件

- 新增：`AGENTS.md`、`CLAUDE.md`、`docs/product_spec.md`、`docs/architecture.md`、
  `docs/implementation_plan.md`、`docs/tasks/TASK-001-project-foundation.md`
  （以上文件在 Git 历史中均不存在，全部为新增）

## 实施 Agent

Claude Code

## 审查 Agent

Codex（独立审阅文档完整性与一致性，不直接修改文件，审查意见记录到本文件或新文档）

## 审查记录

- reviewer: Codex
- final review result: passed（三轮审查：第一轮有条件通过 5 项发现、
  第二轮有条件通过 3 项边界问题、第三轮聚焦复审通过）
- blocking findings: 0
- important findings: 0
- next task: TASK-002 project foundation and data models

## 当前状态

completed — implemented by Claude Code and independently reviewed and
approved by Codex after three review cycles
