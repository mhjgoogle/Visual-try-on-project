# ADR-0056：Local AI Runtime 与 Film Skill Runtime

- 状态：Accepted
- 日期：2026-08-12
- 关联：[ADR-0042](ADR-0042-creative-agent-cli-integration.md)、
  [ADR-0054](ADR-0054-production-upstream-workspace.md)、
  [ADR-0055](ADR-0055-unified-asset-registration.md)、
  [TASK-059](../tasks/done/TASK-059-local-ai-runtime-and-film-skills.md)

## 背景

今天 motv 里的 AI 能力是**一次一个硬接线的端点**：
`/api/agent/script-draft`、`/api/agent/shots-draft`、`/api/agent/bible-breakdown`、
`/api/agent/story-develop`、`/api/agent/episode-plan` —— 每一个都自己拼 prompt、
自己解析输出、自己写死 `claude`。结果：

1. **能力与执行器焊死**。「剧本拆解」这件事和「用 Claude Code 跑」这件事在代码
   里是同一行。用户已经同时持有 Claude 订阅（Claude Code）与 ChatGPT 订阅
   （Codex CLI），却无法把某个能力换到另一个执行器上，也无法在两者都不可用时
   退回手工。
2. **没有能力目录**。「分镜导演」「摄影指导」「连贯性审查」这些电影制作角色不
   存在于域里，只能靠调用点的散装 prompt 文本表达，无法版本化、无法比较、
   无法改进。
3. **没有运行留痕**。一次 AI 产出用了哪个能力、哪个版本、什么输入上下文、
   哪个执行器、用户接受还是拒绝——全部丢失。这正是「Skill 积累」最需要的数据。
4. **本机现实**：`claude` / `codex` 只装在 WSL 内，Windows PATH 上都没有。
   任何「假设 CLI 在 PATH 上」的实现在这台机器上直接不可用。

## 决策

### 决策 1：Role ≠ Skill ≠ Runtime ≠ Executor ≠ Model

五个概念各自独立，域里**不允许**出现 `AI Director = Codex` 这类绑定：

| 层 | 含义 | 例 |
| --- | --- | --- |
| Role | 谁在监督这件事 | AI 导演 |
| Skill | 做什么能力（versioned） | Storyboard Director v1 |
| Runtime | 哪一类执行方式 | `local_subscription` / `manual` |
| Executor | 具体哪个可执行体 | `claude-code` / `codex-cli` |
| Model | 执行器实际用的模型 | 运行时上报，未知即 `null` |

Skill 定义里**只**声明「推荐 runtime」，不声明 executor；用户可随时改。
推荐值是提示，不是约束：Claude Code 偏创作型（story / script / storyboard /
prompt），Codex 偏独立复核（review / structured checking / second opinion）。

### 决策 2：Film AI Runtime 是**文本 / 结构化推理执行器**，不是代码修改 Agent

这是本 ADR 最重要的安全决策。

    Domain context
      → Skill（输入要求 + 任务指令 + 输出 schema + 审查标准）
      → Runtime（无工具、无文件系统、无 shell）
      → structured Proposal
      → AI Director Review
      → 用户 Accept
      → canonical controller write

- 执行器以**工具全关**方式启动（沿用 ADR-0042 `_run_claude` 的既有姿态：
  `--tools ""` / `codex exec --sandbox read-only`），**绝不**让它修改
  `canvas.json` 或任何项目文件。这些安全参数由服务端**始终追加**，
  用户配置只能指定「怎么找到可执行体」，**无法**去掉它们；
- 执行器的 cwd 是**每次运行新建的空临时目录**，运行后删除。仓库目录
  （含 `mockups/`）**不算中立**：被提示注入的执行器如果 cwd 在仓库里，
  就能读到源码并回显出来——空目录里没有东西可读；
- 提示词里的项目上下文是**内联的数据**，不是路径 —— 因此**不存在**需要在
  Windows 路径与 WSL 路径之间翻译的东西。这不是绕过问题，而是把问题消除：
  运行时从来不接触文件系统，就没有路径要转换；
- 输出**只**经 schema 校验后成为 Proposal。AI runtime **永远不是数据 owner**。

失败必须是**诚实的失败**：不可用 / 未认证 / 超时 / 输出不符合 schema，四种
状态各自可区分地上报，**绝不**降级成一段编造的内容。

**提示词一律走 stdin，绝不走 argv**。一条真实的 Skill 提示词内嵌本集剧本、
场景与镜头；原生 Windows 命令行上限约 32 KB，用 argv 传会让完全合法的上下文
以一个看不懂的 spawn 错误失败。stdin 没有这个限制，且对所有执行器一致。

### 决策 2A：**没有「完全无工具」模式的执行器默认停用**（fail-closed）

`claude -p --tools ""` 是真正无工具的：它只能吐文本。
`codex exec --sandbox read-only` **只挡写、不挡读**——模型仍可读取本机绝对
路径的文件并把内容写进回答。而我们的提示词内嵌**用户撰写的剧本文本**，
这正是一个注入面：一段精心构造的剧本可以要求可读文件的执行器去读本机密钥
并放进答案里。

因此：

- 标记 `reads_filesystem` 的执行器**默认报 `unavailable`**，并如实说明原因；
- 只有运行后端的人显式设置
  `MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS=1`，才启用；
- 这不是「以后再修」的 TODO，而是当前上游能力的**如实反映**：codex 今天
  没有 tool-free 模式，我们就不假装它有。

### 决策 3：统一 Runtime Adapter，启动命令可配置（含 WSL 桥）

服务端维护一张执行器表，每个执行器有：

    resolve()      解析可执行体 → 绝对路径或显式配置的 argv
    probe()        可用性 + 认证/就绪（快速、只读、无副作用）
    argv(prompt)   构造调用（无 shell，参数数组）

配置是**结构化的，不是一条自由命令串**。这一点经过 codex 两轮反复才定型：
任何「让用户写一整条启动命令、我们再去里面找安全参数」的做法都不可靠——
子串检查既会**误放**（`--sandbox danger-full-access --config x=read-only`
里也含 `read-only`），也会**误拒**（以 `exec codex "$@"` 结尾的正当前缀）。

因此操作者最多只提供两样东西：

    MOTV_RUNTIME_<NAME>_BIN       可执行体在**它那个环境里**的绝对路径
    MOTV_RUNTIME_<NAME>_LAUNCHER  纯传输前缀（JSON argv），说明「怎么过去」

最终 argv = `[...LAUNCHER, BIN, ...我们的强制安全参数]`。
**可执行体之后的每一个参数都由服务端拥有**，所以安全参数在结构上不可能被
配置掉——不需要去检查什么，因为没有可以写错的地方。

前缀必须是**纯传输**（`wsl -e …`、`docker exec …`）。前缀里出现 shell
（`bash` / `sh` / `cmd` …）或 shell 命令参数（`-c` / `-lc` / `/c`）一律拒绝：
shell 会把我们追加的参数当成脚本的位置参数吞掉，执行器就会带着工具运行。
本机可用配置（已实测跑通）：

    MOTV_RUNTIME_CODEX_LAUNCHER=["wsl","-e","/home/<用户>/.nvm/versions/node/<版本>/bin/node"]
    MOTV_RUNTIME_CODEX_BIN=/home/<用户>/.nvm/versions/node/<版本>/bin/codex

解析顺序：

1. `_BIN`（+ 可选 `_LAUNCHER`）→ 结构化 argv；
2. `shutil.which(<name>)`（ADR-0049 规则 6：一律经 which 解析，失败即
   fail-closed，不裸名调用）；
3. 都没有 → 该执行器状态为 `unavailable`，**如实上报**，界面显示为不可用，
   不伪造一个「正在思考」。

**超时必须杀掉整棵进程树**：`wsl → node → codex` 里只杀掉 `wsl` 会把 CLI
留在后面继续跑（Windows 用 `taskkill /T /F`，POSIX 用独立会话 + `killpg`）。
并发运行有上限（信号量），超出即 429，**不排隐形队列**。

**探测只报告能证明的事**。`--version` 在「已安装但未登录」时同样成功，
因此探测**永远不报 `ready`**，只报 `installed`（已安装 / 登录未验证）。
登录状态只能由一次**真实运行**证明：运行失败且输出形似鉴权问题时，
才记为 `unauthenticated`。状态集：

    ready（仅手工，无需安装） / installed / unauthenticated / unavailable / error

「把 scratchpad shim 当正式架构」被明确否决：shim 是审查工装的临时手段，
产品侧的正式机制是上面的 `MOTV_RUNTIME_<NAME>_CMD` 配置点。

### 决策 4：Manual Runtime 是一等公民

`manual` 不是「AI 不可用时的降级」，而是当前**主力**工作方式：

    motv 编译完整任务 Prompt（含 Skill 指令 + 域上下文 + 输出 schema）
      → 用户 Copy
      → 到 ChatGPT / Claude / Gemini 网页跑
      → 粘贴结果回 motv
      → 同一套 schema 校验
      → 同一个 Proposal 流程

manual 与 local_subscription 走**完全相同**的 Skill 定义、schema 与审查路径，
所以「换执行器」不改变结果的形状，只改变谁来产出。

### 决策 5：Film Skills v1 —— 版本化的能力定义

十个能力，每个是一条**不可变的版本化定义**：

    skillId · version · role · title · purpose
    inputs[]        需要哪些域上下文（缺失即拒绝运行，不空跑）
    instruction     任务指令（提示词的稳定部分）
    outputSchema    结构化输出契约
    reviewCriteria  AI 导演 / 用户据以判断的标准
    recommendedRuntime

v1 目录：Story Development · Script Writer · Script Doctor ·
Script Breakdown · Storyboard Director · Cinematography ·
Reference Planner · Prompt Director · Continuity Reviewer · Asset Librarian。

**每个 Skill 不必配一个巨大 UI**：本阶段先把定义层、输入要求、输出 schema 与
审查标准建立起来，界面按需要逐步接。

### 决策 6：Skill Run Provenance —— 积累的是运行记录，不是聊天记录

新增持久化 `skillRuns[]`（canvas schema v12，纯追加）：

    skillRunId · skillId · skillVersion
    inputDigest / inputSummary   运行时的域上下文（可复现，不存整段聊天）
    runtime · executor · model
    status: running|proposed|failed|accepted|rejected
    proposal                     schema 校验后的结构化输出
    directorReview               AI 导演的评述（有能力才写，没有就是 null）
    decision · decidedAt         用户 accept / reject
    error                        失败原因（诚实，不改写成内容）

这些数据**以后**用于改进 Skill。本阶段**不做**自动 self-learning：

> Skill 的改进必须是 Proposal / explicit revision。
> 不能因为模型一次输出就偷偷改变 Skill。

因此 `skills.js` 里的定义是**代码中的不可变常量**，运行记录只能读它，
永远不能写它。

## 后果

正面：

- 一个能力可以换执行器而不改域代码；两个订阅都能用上，手工路径不再是二等；
- 能力第一次可版本化、可比较、可改进；
- 每次 AI 产出都有可追溯的运行记录（用了什么、谁跑的、用户怎么判的）；
- 安全边界明确且可测试：AI 不碰文件系统，不写 canonical 数据。

代价：

- 又一次 schema 迁移（v11 → v12），高风险流程；
- 现有五个硬接线端点在本批**保留不动**（它们已经跑通且被验收过），
  Skill Runtime 与它们并存；统一收编留待后续任务，否则本批范围失控；
- 执行器探测在本机依赖显式配置（`MOTV_RUNTIME_*_CMD`），未配置时
  local_subscription 诚实显示不可用——这是正确的失败，不是缺陷。
