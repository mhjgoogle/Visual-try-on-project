# ADR-0065：每一个 AI 动作都经 Runtime 层 —— 旧 `/api/agent/*` 直连路径的收口

- 状态：Proposed
- 日期：2026-08-13
- 相关：[ADR-0042](ADR-0042-draft-domain-agent-usage.md)（草稿域 agent 用法，旧路径的来源）、
  [ADR-0049](ADR-0049-native-windows-run-and-test-target.md)（外部工具一律经解析、fail-closed）、
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)（Runtime / Executor / Skill 分层）、
  [ADR-0062](ADR-0062-windows-authoritative-environment.md)（Windows 权威）、
  [ADR-0064](ADR-0064-ai-director-operationalization.md)（AI 导演可操作化）
- 任务卡：[TASK-068](../tasks/TASK-068-legacy-agent-endpoints-to-runtime.md)
- 触发：产品负责人 2026-08-13 —— 「这个项目所有需要 AI 来调整的背后都是要用现在这个订阅
  账号来完成的」，以及「不单单要接 Claude Code，还要接 Codex。Claude Code 主要是执行，
  Codex 要做审阅然后给出意见」。

## 背景

系统里有**两条**跑 AI 的路径，它们互不知道对方存在：

| | 旧路径 | Runtime 层 |
| --- | --- | --- |
| 入口 | `/api/agent/*`（server.py `_run_claude`） | `/api/skill/run`（ADR-0056） |
| 谁用它 | 「AI 发展故事」「AI 生成剧本」「生成分镜」「剧本拆解」「分集规划」 | 全部 20 个 Film Skill |
| 执行器 | **写死 `claude`**，`shutil.which("claude")` | claude-code / codex-cli / manual，可选 |
| 探测 | 无 | `/api/runtimes`，真实状态 |
| 手工兜底 | **没有** | 有（复制 Prompt → 外部跑 → 粘回） |
| 输出契约 | 每个端点各自的解析器 | 统一 outputSchema + fail-closed 校验 |
| 运行记录 | 无 Skill Run | Skill Run + Proposal + provenance |
| 并发上限 | 无 | 有（`_SKILL_RUN_MAX_CONCURRENT`） |

后果在 2026-08-13 被真实撞到：这台机器上 `claude` 没有进 PATH（订阅 CLI 被 VS Code
扩展捆绑在 `resources/native-binary/`），于是「AI 发展故事」直接报
`claude CLI not found`，**且没有任何替代路线**——而同一个能力
（`story-development`）在 Skill 目录里躺着，手工运行随时可用。

一个能力两条路，只有一条能在执行器缺席时工作，这是本仓库反复付出代价的那类重复。

## 决策

### 决策 1：`/api/agent/*` 的五个创作端点改由 Runtime 层承载

`story-develop` / `script-draft` / `shots-draft` / `bible-breakdown` / `episode-plan`
不再自己 spawn `claude`，改为经 `/api/skill/run` 的同一套执行器解析、同一套并发上限、
同一套 fail-closed 校验。它们对应的能力在目录里已经存在：

| 旧端点 | 已有能力 |
| --- | --- |
| `/api/agent/story-develop` | `story-development` |
| `/api/agent/script-draft` | `script-writer` |
| `/api/agent/shots-draft` | `storyboard-director` |
| `/api/agent/bible-breakdown` | `script-breakdown` |
| `/api/agent/episode-plan` | （需新增或复用 `story-development` 的 plan 分支） |

**不动的三个**：`render-episode` / `mix-shot` / `compose` 不是 AI 路径（ffmpeg/piper），
`tts` / `image-gen` / `adopt-paid` 属于付费 Provider 边界，由各自的 ADR 管辖。

### 决策 2：每个 AI 动作都必须有手工兜底

这是决策 1 真正要买到的东西。执行器缺席时，创作者仍然能：复制任务 Prompt → 到外部模型
跑 → 把结果粘回来 → 走同一道输出契约与确认门。**「装不上 CLI 就完全做不了」不再是一种
可接受的状态**，因为它把一个环境问题变成了产品的功能缺失。

### 决策 3：Role 的默认分工 —— Claude Code 执行，Codex 审阅

已在 TASK-067 落地（`skills.work` = `creative | review`，`EXECUTORS[].suits`，
`suggestExecutor`）。本 ADR 记录它的约束，因为旧路径收口后会继承它：

- 这是**建议，不是绑定**（ADR-0056 决策 1 不变）：创作者的显式选择永远优先，任何能力都
  能在任何可用执行器上跑。
- **Codex 绝不默认进创作位**（TASK-067 §14）。
- **Codex 缺席时，审阅退回 manual，不退回 Claude Code** —— 让写它的那个 runtime 来
  「独立复核」，独立性就是零。这一条是本决策的核心，不是实现细节。

### 决策 4：执行器的解析留在后端，PATH 的修复留在启动器

ADR-0049 第 6 条不变：产品代码一律 `shutil.which` 解析、fail-closed，**绝不猜路径**。
CLI 装在哪是**环境**问题，因此 `run-windows.ps1` 负责在启动后端前把订阅 CLI 放上 PATH
（找不到就如实说、并给出安装命令），而不是让 server.py 去遍历 VS Code 扩展目录。

推荐安装独立 CLI（`npm i -g @anthropic-ai/claude-code`）：扩展目录名带版本号，每次扩展
升级都会变，写死它是维护陷阱；启动器用通配符兜底，但那是**回退**不是主路径。

### 决策 5：codex 的 fail-closed 默认不变

`codex exec --sandbox read-only` 只挡写、不挡读，而 Skill prompt 内联用户撰写的剧本
文本 —— 这是真实的注入面。因此 `MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS` 保持默认关闭，
由运行后端的人显式开启（`run-windows.ps1 -AllowCodexReview`）。**启动器不得静默开启它。**

## 后果

- 五个端点的响应形状会变（它们目前各有各的解析器）。前端对应的
  `ctx.story.develop` / `ctx.script.generate` / `ctx.shots.generateDraft` /
  `ctx.breakdown.run` 都要改为走 Skill Run，**这是一次真实的行为变更**，需要守卫测试与
  真实项目验收，不能顺手改。
- 好处是这些动作第一次获得 Skill Run / Proposal / provenance —— 今天「AI 生成的剧本
  v3」在溯源图上没有任何运行记录可指。
- 旧端点保留一段时间还是直接删除，由 TASK-068 决定；本 ADR 倾向**直接改造而不并存**，
  因为并存正是本 ADR 要消除的东西。

## 明确不做

付费 Provider（image-gen / tts / adopt-paid）的边界不动；`render-episode` / `mix-shot` /
`compose` 不动（它们不是 AI）；自动化级别不变（`CURRENT_LEVEL` 仍为 `suggest`）。
