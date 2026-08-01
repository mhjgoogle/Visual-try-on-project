# AGENTS.md

本文件是本项目所有 AI 编码 Agent（Claude Code、Codex 等）必须遵守的正式规范。
Agent 之间只通过仓库中的文档、代码和 Git 状态共享上下文，不依赖各自的聊天记录。

## 1. 项目目标

### 长期目标

构建一个在 WSL2 Ubuntu + VS Code 环境中运行的 AI 视频 / AI 短剧生产工作流，覆盖：

故事构思 → 结构化剧本 → 场景与镜头拆分 → 人物/场景/道具资产管理 → 图片生成
→ 视频生成 → 配音、音效和字幕 → FFmpeg 合成 → 质量检查
→ 质量、成本、交付周期（QCD）记录 → 最终成片。

### 第一阶段目标（最小闭环，不接入付费 API）

读取故事与镜头数据
→ 生成人工视频制作任务
→ 用户在网页视频工具中手工生成视频
→ 用户将视频放入指定目录
→ 程序检查视频文件
→ FFmpeg 按镜头顺序合成
→ 输出最终 MP4。

该第一阶段称为原 **M1**，已经完成并作为后续工作的稳定基础保留。

### WFM1 增量路线

WFM1 在原 M1 之后增量加入可复用短剧生产流程、人工创意审批、生产规划、
预算约束与云端视频默认生产路线。WFM1 不重定义原 M1，不修改既有冻结合同；
新开发任务从 `TASK-014` 起，采用现有 batch milestone review。

云端视频是 WFM1 的默认生产路线，但核心架构继续保持 Provider 中立。
付费 API 仅可在 Accepted ADR 明确批准的范围内接入。

详细规格见 [docs/product_spec.md](docs/product_spec.md)，
架构见 [docs/architecture.md](docs/architecture.md)，
WFM1 工作流见
[docs/ai_shortfilm_pipeline_workflow.md](docs/ai_shortfilm_pipeline_workflow.md)，
实施规划见 [docs/implementation_plan.md](docs/implementation_plan.md)，
文档权威关系见
[ADR-0007](docs/adr/ADR-0007-wfm1-document-baseline-and-governance.md)。

## 2. 技术与环境约束

1. Python 是主要开发语言。
2. 项目运行在 WSL2 Ubuntu 中（Windows 宿主机）。
3. 只使用 Linux/POSIX 路径和命令。
4. 不使用 PowerShell、CMD 或 Windows 路径（如 `C:\Users\...`）。
5. 仓库必须保留在 Ubuntu 文件系统 `/home` 下；未经用户明确要求，不得将活动仓库放在 `/mnt/c` 下。
6. Git、Python、FFmpeg、Claude Code、Codex 必须在 Ubuntu 内运行；不得假设 Windows 侧安装的工具在 Ubuntu 内可用。
7. Python 依赖必须安装在项目虚拟环境（venv）内，不污染系统环境。

## 3. 架构约束

8. 核心工作流不能依赖任何具体视频厂商。
9. 所有视频生成方法必须通过 `VideoProvider` 接口接入（手工流程、云端 API、本地模型一视同仁）。
10. 原 M1 不接入任何付费 API；后续里程碑只有在 Accepted ADR 明确批准的
    范围内才可接入，当前窄范围例外见 ADR-0006。
11. 工作流的每个步骤必须可以独立执行（可单独运行、单独重跑）。
12. 工作流必须支持断点续跑：中断后可从已完成的步骤之后继续，不重做已完成的工作。
13. 禁止静默覆盖用户文件和已有生成结果；覆盖前必须显式确认或采用带版本的新路径。

## 4. Agent 协作规则

14. 每个开发任务（`docs/tasks/TASK-*.md`）只能有一个实施 Agent。
15. 另一个 Agent 只能作为独立审查者，不得在同一任务上并行修改代码。
16. 修改前必须检查 `git status` 和相关文件的当前内容，确认没有他人未提交的改动被破坏。
17. 不修改当前任务范围之外的代码；发现范围外问题时记录到文档或新任务，不顺手修改。
18. 持久性决策必须写入仓库文档（docs/），不得只存在于聊天记录中。

## 5. 质量规则

19. 新功能必须有测试。
20. 每个任务完成后必须运行格式化、静态检查和测试，并确保全部通过。
21. 重大设计变更必须创建 ADR（Architecture Decision Record，存放于 `docs/adr/`）。

## 6. Git 与安全规则

22. 未经用户明确要求，不得 `commit`、`push` 或 `merge`。
23. 不得提交 API key、密码、生成的视频文件或本地凭据到 Git 仓库。
