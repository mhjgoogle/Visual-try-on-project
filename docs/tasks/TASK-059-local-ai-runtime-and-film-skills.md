# TASK-059：Local AI Runtime + Film Skill Runtime

- 状态：进行中
- ADR：[ADR-0056](../adr/ADR-0056-local-ai-runtime-and-film-skills.md)
- baseline：TASK-058（schema v11）
- 风险级别：**高**（新增本地进程执行路径 + schema v11 → v12 + 安全边界）

## 1. 目标

把「AI 能力」从**五个硬接线端点**变成一个可换执行器、可版本化、可留痕的
能力层：

    Role ≠ Skill ≠ Runtime ≠ Executor ≠ Model

并且严格保证：AI runtime 是**文本 / 结构化推理执行器**，不是代码修改 Agent。

## 2. 实施映射

### 2.1 新增

| 模块 | 职责 |
| --- | --- |
| `src/workflow/skills.js` | 十个 Film Skill 的**不可变版本化定义**（纯数据 + 输入校验 + 输出 schema 校验） |
| `src/workflow/skillrun.js` | Skill Run provenance 注册表（状态机 + 持久化形状） |
| `src/services/runtime.js` | 客户端 runtime 目录 / 探测 / 调用（经服务端） |
| `server.py` `/api/runtimes` | 执行器可用性 + 就绪探测（只读、无副作用） |
| `server.py` `/api/skill/run` | 通过某执行器跑一次 Skill（工具全关、无 shell、中立空目录 cwd、超时杀进程树、输出上限、并发上限、自定义头 CSRF 防护） |

### 2.2 schema v12（纯追加）

    doc.skillRuns = []

迁移不伪造任何历史运行记录。

### 2.3 执行器解析（ADR-0056 决策 3）—— 结构化，不是自由命令串

    MOTV_RUNTIME_<NAME>_BIN       可执行体在它那个环境里的**绝对路径**
    MOTV_RUNTIME_<NAME>_LAUNCHER  纯传输前缀（JSON argv），说明「怎么过去」

最终 argv = `[...LAUNCHER, BIN, ...服务端的强制安全参数]`。
可执行体之后的每个参数都由服务端拥有，安全参数在结构上无法被配置掉。
前缀里出现 shell（`bash` / `sh` / `cmd`）或 shell 命令参数（`-c` / `-lc`）
一律拒绝——shell 会把追加的参数当成脚本位置参数吞掉。

解析顺序：`_BIN`(+`_LAUNCHER`) → `shutil.which(<name>)` → `unavailable`（如实上报）。

本机现实：`claude` / `codex` 只在 WSL 内，Windows PATH 上没有 →
未配置时 local_subscription 显示不可用，**这是正确的失败**。
本机实测可用配置：

    MOTV_RUNTIME_CODEX_LAUNCHER=["wsl","-e","/home/mo/.nvm/versions/node/v24.12.0/bin/node"]
    MOTV_RUNTIME_CODEX_BIN=/home/mo/.nvm/versions/node/v24.12.0/bin/codex

`codex` 没有「完全无工具」模式（`--sandbox read-only` 只挡写不挡读），
因此默认停用，需显式 `MOTV_RUNTIME_ALLOW_FS_READING_EXECUTORS=1`。

### 2.4 安全边界（必测）

- 工具全关：`claude -p … --tools ""`；`codex exec` 只读沙箱
- 无 shell（参数数组）
- 中立 cwd（**不是**项目目录，**不是**仓库）
- 输出字节上限 + 超时看门狗
- 提示词里的项目上下文是**内联数据**，不传路径 → 无 Windows/WSL 路径翻译问题
- 输出只经 schema 校验成为 Proposal；**canonical 写入只发生在用户 Accept 之后**

## 3. Film Skills v1

Story Development · Script Writer · Script Doctor · Script Breakdown ·
Storyboard Director · Cinematography · Reference Planner · Prompt Director ·
Continuity Reviewer · Asset Librarian

每个：`skillId · version · role · title · purpose · inputs[] · instruction ·
outputSchema · reviewCriteria · recommendedRuntime`。

## 4. Skill 积累（本阶段只做记录）

记录：Skill / version / 输入上下文 / runtime / executor / model / Proposal /
Director review / 用户 accept-reject。

**不做**自动 self-learning。Skill 定义是代码常量，运行记录只读它、绝不写它。

## 5. 验收

1. `/api/runtimes` 如实报告三个 runtime 的状态（含未配置 → unavailable）
2. Manual Runtime 能编译出完整任务 Prompt（Skill 指令 + 域上下文 + 输出 schema）
3. 粘贴回的结果经 **同一套** schema 校验 → Proposal
4. Proposal 未经用户 Accept 不写任何 canonical 数据
5. Skill Run 记录完整落盘，reload 后仍在
6. 输入缺失时 Skill 拒绝运行（不空跑、不编造）
7. 输出不符合 schema 时诚实失败（不改写成内容）
8. 执行器超时 / 不可用 / 未认证 三种状态可区分
9. schema v11 → v12 迁移在真实存档上 `status=ok`

## 6. Scope guard

**不做**：收编现有五个硬接线 agent 端点（保留不动）、自动 self-learning、
每个 Skill 的完整界面、传统 API Provider、图片/视频/音频生成。
