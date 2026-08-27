# AGENTS.md

**这份文件是本项目所有 AI 编码 Agent（Claude Code、Codex 等）必须遵守的
唯一规范。** 只放规则，不放项目背景。

- **项目是什么、走到哪了** → [docs/project-context.md](docs/project-context.md)
- **怎么运行、入口在哪** → [README.md](README.md)（面向使用者，仓库唯一一份 README）
- **现在的架构是什么** → [docs/current-architecture.md](docs/current-architecture.md)
  （**WHAT IS TRUE NOW**，过期即缺陷）
- **某个决定为什么这么定** → `docs/adr/`（**WHY / HISTORY**；本文件只写结论，不写修订史）
- **什么做完了、什么还没做** → [docs/STATUS.md](docs/STATUS.md)（**生成的**，别手改）。
  文档按完成状态分区：`backlog/` 没人在做、`active/` 在办、`done/` 已完成，
  `adr/` 与 `design/` 根是没有「完成」这一维的稳定参考
  （[ADR-0083](docs/adr/ADR-0083-docs-partitioned-by-completion.md) ·
  [ADR-0087](docs/adr/ADR-0087-document-lifecycle-and-default-agent-context.md)）
- **默认该读哪些、不该读哪些** → 第 25 条（历史存在，但不占日常开发上下文）

`CLAUDE.md` 只是 Claude Code 的入口，内容就是本文件，没有第二份规则。
Agent 之间只通过仓库中的文档、代码和 Git 状态共享上下文，不依赖各自的聊天记录。

## 目录

| 节 | 回答什么 | 条款 |
| --- | --- | --- |
| [1. 怎么做决定](#1-怎么做决定) | 什么自己定、什么必须问产品负责人 | — |
| [2. 范围与切片](#2-范围与切片) | 一个任务做多大 | — |
| [3. 技术与环境](#3-技术与环境约束) | 语言、平台、路径所有权 | 1–7 |
| [4. 架构](#4-架构约束) | Provider 中立、可重跑、不静默覆盖 | 8–13 |
| [5. Agent 协作](#5-agent-协作规则) | 多 Agent 同仓怎么不打架 | 14–18 |
| [6. 测试与审查](#6-质量规则测试与审查) | 跑哪些测试、审不审、审几轮 | 19–21 |
| [7. Git 与安全](#7-git-与安全规则) | commit / push / merge、不许提交什么 | 22–23 |
| [8. 文档生命周期](#8-文档生命周期与默认上下文) | 记录活多久、默认读什么、临时产物怎么办 | 24–26 |

---

## 1. 怎么做决定

产品负责人 2026-08-15：

> 「我只能在看到最终结果有问题之后才能给出决策。中间多次询问我这种开发模式
> 应该变更。」
> 「我只负责出 UI/UX 的产品要求。」

所以决策输入点是**用户看到可运行结果之后**，不是开发中途。

**判据不是「这个决定重不重要」，而是「错了能不能重来」。**
能做出来给他看、看完不满意再改的 —— 直接做。做了回不了头的 —— 先问。

### 直接自己定，不问（绝大多数情况）

- **一切技术决策**：架构与模块边界、持久化 schema 的形状与迁移策略、数据结构、
  接口与跨层合同、依赖选型、错误处理与并发模型、测试与审查策略、工具与配置、
  命名与文件组织。定完按第 18 条写进 `docs/`，**不上交**。
- **UI/UX 也先做一版给他看**，而不是问「你要 A 还是 B」—— 用户在看到之前无法
  判断，问了等于把工作退回给他。做出来、能演示、他看完给反馈、再改。
- **技术架构变更不需要用户确认**，它就是技术决策。
- 发现的范围外问题记 `Follow-up` 或新任务卡，**不设「先问用户」这道闸门**。
- **排序类问题永远不问**（产品负责人 2026-08-23：「工程类的问题都不要再问。
  我需要你自动把所有的任务完成。你还是总是在中途问我」）：「先做哪个」
  「要不要继续」「要不要核实」「剩下这些你要哪个」——**这四类错了都能重来**，
  按本节判据就该直接做。把已经列出来的待办端回去让用户挑，是同一种浪费的往返，
  只是换了个位置。**一次任务里做到底，报告写在做完之后。**

### 「回不了头」是缺陷，先消除它，而不是拿它去问用户

产品负责人 2026-08-15：

> 「做了就回不了头的才问这一点也很奇怪。按理说不应该回不了头啊。这时候就算
> 问我我也不知道该如何回答。只能选择推荐选项。」

不可逆是**实现方式的缺陷**，不是该上交的选择题。遇到它，默认动作是**把它变成
可逆的**：

- 覆盖用户文件 → 写**带版本的新路径**（第 13 条本来就允许这条路）
- 数据迁移 → 迁移前留下可回滚的旧数据；**加法字段优先于破坏性变更**
- 删除 → 软删除 / 移入回收区，保留历史版本
- 状态机 → 留一条回退边，而不是单向门

只有**确实无法消除不可逆性**时才问，并且必须带明确推荐。

### 真正必须问的只有一件：付费 / 真实花钱

花的是用户的钱，不是技术选择；用户在这件事上有 Agent 没有的信息（预算、这次
值不值得）。ADR-0006 / ADR-0009 的窄授权不得自行扩大。

除此之外，「需要产品负责人拍板」不是一个有效的理由。
**在技术问题上停下来问，等于把工作退回给用户。**

### 不得不问的时候，问法也有要求

用户明确说过「就算问我我也不知道该如何回答，只能选择推荐选项」—— 开放式选择题
等于把判断退回给他，一次纯浪费的往返。

**正确形式：说明你打算做什么、为什么、风险是什么，让用户否决。**
不是「A 还是 B？」，而是「我打算 A，因为 X，代价是 Y —— 要拦吗？」

不得把决策包装成「有三个方案，请你选择」。开工前的文档收口只做一轮；同一批次
出现第二、第三轮纯文档收口，说明该决策已被过度前置 —— 把未定项作为显式假设
写进任务卡然后开工。

### 不得新增「要用户离开对话手动操作」的规则

产品负责人 2026-08-23：「不要加什么自己改不了自己限制的设置。这样我做什么都
不能自动化了。」

要用户拍板的事，**必须能用一句话完成**。任何需要他去编辑配置文件、点 UI、改
环境变量才能推进的机制，一律不得新增；已存在的（如 Claude Code 的权限白名单，
Agent 无权自改）如实告知并一次性解决，不要让它变成每次都要重复的动作。

### 任务卡收口不设「产品签字」闸

产品负责人 2026-08-23：「用起来不满意就再改啊没有什么更好办的方法。」

**任务卡的状态由实施 Agent 自己定，不等任何签字**（[ADR-0082](docs/adr/ADR-0082-no-signoff-gate-on-task-cards.md)）。
判据还是本节那一条：改卡片状态是纯可逆的，可逆的事直接做。
**保留人工闸的只剩「付费」一件**（产品负责人 2026-08-24：「合并。这个也不需要
保留人工」→ [ADR-0085](docs/adr/ADR-0085-merge-is-not-a-human-gate.md)）。

卡片状态必须写成**两个独立事实**，不得压成「进行中」一个词：

1. **实现是否完成** —— Agent 自己判定，但要给**代码级证据**（文件、迁移函数、
   CI job、schema 版本这类能被复核的东西），不是「我觉得做完了」。
2. **哪些验收项还没在真实项目上被人看过** —— 逐条如实列出。
   **这是信息，不是闸门**，不阻塞收口。

代价（已接受）：卡上「实现完成」不等于「产品令人满意」。这两件本来就是两回事，
不满意的路径是**再改**。实测代价见 ADR-0082 §2：九张卡因为等签字挂了十天，
其中一张的错标签把两条真缺陷盖了十天。

**里程碑**（TASK-033 / 037 / 040 这类对整个产品的声明）仍归用户判定，但形式
必须是**一句话**，不得是签字栏 —— 那正是上一节禁的东西。

### ADR 的 Accept 权

技术 ADR（架构、schema、迁移、合同、并发、测试与审查节奏、工具链）由实施 Agent
依本节授权**自行 Accept**，并在 ADR 里写明依据与理由。涉及**付费**或**不可逆
动用户数据**的 ADR 仍须用户 Accept。UI/UX 相关的 ADR 先实现出可演示的版本，
再由用户看到结果后确认或推翻。

## 2. 范围与切片

- 每个需求按**垂直切片**推进：每个切片自己就能跑、能演示、能验证。不要按技术层
  拆（schema → resolver → service → store → component → UI），那会让用户直到
  最后才看到东西。
- 任务开始时写明 **IN SCOPE / OUT OF SCOPE**。
- 非本任务 bug：一律**记录**到 `Follow-up` 或新任务卡（欠账总账在
  [TASK-087](docs/tasks/active/TASK-087-followup-ledger.md)），**不顺手修**（第 17 条）。
  唯一例外是它**阻塞当前任务** —— 那时只在最小范围内修，并在报告里写明为什么
  绕不开。P2 记录；**P3/P4 不修**。
  不要因为审查者报了 5 个小问题，把一个用户功能扩成两天重构。
- 技术基础只做 **Minimum Necessary Foundation**。基础工作开始膨胀时先问：
  「不做这个重构，当前用户功能能否安全完成？」能，就不做。
- 同一时间最多推进 1 个主要用户需求 + 1 个阻塞它的技术任务。
  **Finish before starting more.**

## 3. 技术与环境约束

1. Python 是主要开发语言。
2. **权威开发/构建/CI/agent 环境为原生 Windows + NTFS**；Ubuntu / WSL2 与 Linux
   CI runner 是**受支持目标**（[ADR-0062](docs/adr/ADR-0062-windows-authoritative-environment.md)）。
   「权威」的含义是**行为差异的裁决者**：两个环境结论不一致时以 Windows 为准；
   Ubuntu 上的失败仍然是缺陷，只是不再是裁决基准。文件系统限 NTFS 同卷（ADR-0049）。
3. **平台中立，不是 POSIX。** 路径一律走 pathlib/stdlib；**不得硬编码分隔符**，
   也不得硬编码 `C:\Users\...` 或 `/home/...`；不得使用平台专属 syscall。
   权威归属反转**不等于**「代码可以开始关心自己跑在哪」（ADR-0062 决策 2）。
   权威从 Linux 换成 Windows 后，「权威是 Linux」这个天然的可移植性执行者消失了
   —— **因此 Ubuntu CI job 必须绿这一点比以前更重要，不是更不重要。**
4. **流水线与产品代码**内不使用 PowerShell、CMD 或平台专属路径。
   **agent 工装**例外：`.claude/hooks/`、skill 脚本及其 settings 接线以
   PowerShell (`.ps1`) 为**权威实现**，`.sh` 变体服务 Ubuntu 目标，两者共享
   ADR-0050 决策 1 的同一行为合同表，**必须给出相同判定**（ADR-0062 决策 3）。
   面向 Windows 用户的 `.ps1`/`.bat` 启动器就是主入口。

   **仓库路径所有权**（[ADR-0077](docs/adr/ADR-0077-repository-path-ownership.md)）：

   | 位置 | 放什么 |
   | --- | --- |
   | 仓库根 | 只放项目元数据与治理文件（README、LICENSE、pyproject.toml、Agent 规则） |
   | `scripts/launch/` | 面向人的产品启动器：`studio.ps1`（Windows 权威）、`studio.bat`（CMD 适配器）、`studio.sh`（Ubuntu/WSL2） |
   | `.claude/` | agent 工装 |
   | `src/` | 应用与库代码 |
   | `product-skills/` · `product-flows/` | 内置的能力包与流程模板 —— **产品资产**，不是原型私有物（ADR-0067 决策 2 / ADR-0084 决策 7） |
   | `tests/` | 测试与其配置 |

   三个启动器都从**自身位置**解析仓库根，可从任意工作目录调用
   （`tests/tooling/test_repository_layout.py` 钉住这条）。

   **README 只有仓库根那一份且面向使用者**（产品负责人 2026-08-22：「Readme
   不要设计太多…在project下面有一个就可以。别的readme如果是设计给agent遵守。
   请统一到agents.md或者claude.md」）—— 给 Agent 的规则写本文件或对应权威
   docs，不再新建子目录 README。
5. 权威仓库位于 Windows NTFS（当前 `D:\02_Work\04_video-work\Visual-try-on-project`）。
   在 WSL 内对该仓库执行 git 时**必须对齐行尾语义**，否则 diff 完全失真（实测
   149,986 行 vs 1,918 行）：
   `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true`。
   不改共享配置。
6. 所有外部工具（ffmpeg/ffprobe/piper/claude/codex/node）一律经 `shutil.which`
   解析、**失败即 fail-closed**，不得裸名调用（ADR-0049 / ADR-0062 决策 2）。
   安装器改了 PATH 但早于安装启动的进程看不到新 PATH —— 正确处理是重启会话并
   **如实报告**，不是让代码去猜路径。
7. Python 依赖必须安装在项目虚拟环境（venv）内，不污染系统环境。

## 4. 架构约束

8. 核心工作流不能依赖任何具体视频厂商。
9. 所有视频生成方法必须通过 `VideoProvider` 接口接入（手工流程、云端 API、
   本地模型一视同仁）。
10. 原 M1 不接入任何付费 API；后续里程碑只有在 Accepted ADR 明确批准的范围内
    才可接入，当前窄范围授权见 ADR-0006 与 ADR-0009。
11. 工作流的每个步骤必须可以独立执行（可单独运行、单独重跑）。
12. 工作流必须支持断点续跑：中断后从已完成的步骤之后继续，不重做已完成的工作。
13. **禁止静默覆盖用户文件和已有生成结果。** 两条合规路径里**优先选带版本的
    新路径**，而不是停下来找用户确认（理由见第 1 节「回不了头是缺陷」）。
    同理：迁移留可回滚的旧数据、加法字段优先于破坏性变更、删除做成软删除。
    只有确实消除不掉不可逆性时才问，且必须带明确推荐。

**Creation Workspace 必须遵守**：不直接调用 Provider、不直接修改核心业务文件；
变更命令经 Command Gateway 和 Workflow Orchestrator 应用边界；观察数据可从权威
文件/事件重建；界面关闭不影响核心执行。未经正式任务卡与 ADR，不得提前实现 UI、
Action Center、数据库或 UI 专用状态机。图片/音频等多媒体 Provider 抽象、完整
创意/后期与 WFM3 command capability 必须分别等待 ADR-0037～0040 Accepted；
不得提前泛化 `VideoProvider` 或由 UI 发明 pause/cancel/skip 状态。
（当前可执行的任务范围见 [docs/project-context.md](docs/project-context.md)。）

## 5. Agent 协作规则

14. 每个开发任务（`docs/tasks/{active,done}/TASK-*.md`）只能有一个实施 Agent。
    **卡放在哪个目录就是它的状态**：做完了就 `git mv` 进 `done/`，并重新生成
    `docs/STATUS.md`（ADR-0083）。任务卡不得直接躺在 `docs/tasks/` 下。
15. 另一个 Agent 只能作为独立审查者，不得在同一任务上并行修改代码。
    审查范围必须**明确限定为本次 diff 及它能影响的不变量**，不得每轮重新审查
    整个架构或整个仓库。审查者判断的是**实际风险**（正确性、回归、状态一致性、
    竞态、身份），不是「还能不能继续优化」；只报 P3/P4 时不得阻塞交付。
16. 修改前必须检查 `git status` 和相关文件的当前内容，确认没有他人未提交的
    改动被破坏。
17. 不修改当前任务范围之外的代码；发现范围外问题时记录到文档或新任务，
    不顺手修改。
18. 持久性决策必须写入仓库文档（`docs/`），不得只存在于聊天记录或 Agent 记忆中。
    正式规格以仓库文档为准。

## 6. 质量规则：测试与审查

19. 新功能必须有测试。

20. **测试按所有权与影响范围运行（Test Scope = Change Impact Scope），
    不做风险分级。**

    依据：产品负责人 2026-08-22「不要保留风险分集」「我不要每次都全量测试。」
    机制见 [ADR-0080](docs/adr/ADR-0080-test-ownership-and-gate-mapping.md)
    （取代 ADR-0060 的分档语义）与
    [ADR-0081](docs/adr/ADR-0081-review-by-impact-scope.md)
    （取代 ADR-0069 的按档轮次预算）。

    **测试归属**：

    | 测试域 | 归属目录 | 独立运行命令 |
    | --- | --- | --- |
    | 后端（src 库 + workspace_shell） | `tests/backend/` | `pytest tests/backend` |
    | Studio Python 后端（暂居 mockups） | `tests/studio/` | `pytest tests/studio` |
    | 跨 py↔js 合同 | `tests/contract/` | `pytest tests/contract` |
    | 端到端关键路径 | `tests/e2e/` | `pytest tests/e2e -m "not serial"` + `pytest -m serial` |
    | Agent 工装（gate/skills/仓库结构） | `tests/tooling/` | `pytest tests/tooling` |
    | 前端 | `mockups/motv-workspace/tests/` | `node --test mockups/motv-workspace/tests/*.test.mjs` |

    共享测试支撑层（`tests/conftest.py`、scenario 构造器、假件）留在 `tests/` 根。
    **Python 测试不得对前端 JS 做源码文本断言、不得内嵌 `node --test`**；跨边界
    验证只住 `tests/contract/`（ADR-0080 决策 3；唯一例外是 node 拿不到的入口
    编排层，见 `tests/contract/test_frontend_write_path_invariants.py` 的 docstring）。

    **影响范围能推导出来的，就不许退回全量**（ADR-0080 决策 7）：支撑层模块跑的
    是 **import 它们的那些域**，由 import 图派生而非手写名单。只有
    `tests/conftest.py` 与 `pyproject.toml` 例外 —— 它们不经 import 生效，影响
    范围真的是全部。推不出来时 fail-closed 到全量。

    本地 commit gate 按同一张归属映射选择检查（`.claude/hooks/commit_gate_policy.py`）。
    **全量（两阶段 pytest + 全量前端 + ruff）是集成检查点** —— CI、连续链链尾、
    merge 前、发布/交接前 —— **不是日常提交的默认**。

    全量的两阶段写法（`serial` marker 只给**断言真实 OS 进程状态**的测试用，
    当前仅 `tests/e2e/test_motv_run_lifecycle_task072.py`，不是绕开并行的逃生口）：

    ```
    pytest -n 8 -m "not serial"     # 并行
    pytest -m serial                # 串行，真实进程树
    ```

    `-n 8` 是实测值（不用 `auto`）；耗时基线与选定理由见
    [提速与 gate 修复](docs/design/done/pending-speedup-and-gate-fix.md)。

    **审查按影响范围触发，不按档位**：

    | 改动影响 | 审查 |
    | --- | --- |
    | 纯文档、纯展示（CSS/布局/间距/文案） | **不调用** `codex-review-loop` |
    | 行为、合同、持久化、身份、登记、渲染与文件操作、付费、并发、安全、Windows 可移植性、跨层合同、跨域 | 调用，**默认 1 轮** |

    「diff 很小」「原因很明显」都不是免审理由 —— 判据是**它改的是什么**，不是改了
    多少行；拿不准就审。

    **轮次协议**（唯一一份，细则见 ADR-0081 决策 2a–2d）：

    - **P1** → 修复后**复审一次**。复审若报出**新的** P1，该 P1 同样买它自己的
      那一轮；**连续一轮无新 P1 即收口**（不是两轮，pass 后再跑一轮求稳是禁止的）。
    - 但**同一主题的更窄变体不算新 P1** —— 那时做**范围判断并记录**，不再买轮。
      判「同一主题」看**失效机理**，不看代码位置；**判不准时买那一轮**
      （误判成变体的代价是一条 P1 出门，误判成新的代价只是一轮）。
    - **P2** → 修复 + 跑归属测试即收口，**不再复审**。
    - **P3/P4** → 记 Follow-up，**不阻塞交付**。

    协议之外不得静默续轮；确需超出时显式选择 ship / 只修 P1 / escalate 并写明
    理由。历史代价：TASK-061 13 轮、TASK-062 10 轮（轮 B4 撤回了轮 A4 的修复，
    净负值）。

    **审查先答「需求做完了吗」，代码质量最后答**（[ADR-0088](docs/adr/ADR-0088-traceability-and-requirement-fulfillment-review.md)，
    触发表与上面的轮次协议**一条不改**，改的是审查**内容与顺序**）。四道闸，
    顺序即优先级 —— **普通代码问题不得盖住「需求没做完」**：

    | 闸 | 问什么 | 判词 |
    | --- | --- | --- |
    | 1 Requirement Fulfillment | 声称完成的每条验收判据真的实现了吗？证据在哪？ | `PASS` / `PARTIAL` / `FAIL` / `NOT_EVIDENCED` |
    | 2 Architecture Conformance | 停在卡引用的每条 `CA §N`（[当前架构合同](docs/current-architecture.md)的节号）之内了吗？ | `PASS` / `FAIL` / `NOT_APPLICABLE` |
    | 3 Verification Sufficiency | 证据证的是那个**行为**，还是它的周边？ | `SUFFICIENT` / `INSUFFICIENT` |
    | 4 Technical Quality | correctness / regression / edge case / security | P1–P4（不变） |

    **禁止两种 PASS**：因为实施 Agent 声称完成；因为测试全绿。**架构符合性在
    范围内，架构提案仍然禁止**（越界是 P1，重新设计交给 ADR）。审查者默认只读
    本次 **Review Package**（判据原文 + 约束原文 + diff + 证据），不扫全仓库、
    不遍历历史 ADR；包不可读/为空/超上限一律 fail-closed，宁可不审也不假装审过。

    追溯链、句柄约定（`REQ-NNN 判据 M` / `CA §N`）、Review Package 模板与四个
    缺口标签（`ORPHAN_TASK` / `ORPHAN_IMPLEMENTATION` /
    `REQUIREMENT_COVERAGE_GAP` / `ARCHITECTURE_UNKNOWN`）在 dev-workflow Skill 的
    [references/traceability.md](.claude/skills/dev-workflow/references/traceability.md)。
    **每个 Change 说得出它为哪条判据而做**；没有产品需求的工作（Bug / Refactor /
    Perf / 工装）写**技术目标**，两者皆无是 `ORPHAN_TASK`，
    `.claude/tools/lifecycle_check.py` 当场转红。

    **审查不是提交的前置门槛。** 相关测试通过、无已知 P1 即可提交；审查在提交
    之后进行，发现 P1 用后续提交修。审查者不可用时**照常提交并推进**，在提交
    信息与任务卡里如实写明「未经独立审查 + 原因」—— 不假装审过，也不用「测试
    全绿」冒充独立审查，但也不因此停下交付。codex 不可用时会自动回退到独立的
    claude 会话，此时独立性降级，必须在报告中如实注明。

    **该审而未审的改动是后移审查，不是取消。** 必须登记到
    [待复审清单](docs/design/active/pending-codex-rereview.md)，审查者恢复后立即补审，
    且 **push / merge / 交接 / 人工验收之前必须完成补审**。
    **merge 前必须把这份清单当作前置闸门查一遍**，不能只查任务卡的验证字段。

    **发布闸门 = 用户验收标准满足 + 相关测试通过 + 无未闭合 P1**，
    而不是零发现 + 全量测试 + 完美架构。`VERDICT: pass` 不是闸门。
    审查按四闸作答之后，闸门追加三项：Requirement 全 `PASS` · Architecture 无
    `FAIL` · Verification `SUFFICIENT`，且四个缺口标签一个不挂（ADR-0088 决策 6）。
    **判据不满足不等于要问用户** —— 缺实现就实现、缺证据就补、越界就改回来；
    真超出本卡范围就把缺口写成新卡并在 REQ 里记下它挪到哪，不让 `PARTIAL`
    被 merge 掉。

    **连续修改链**（[ADR-0068](docs/adr/ADR-0068-continuous-modification-chain.md)）：
    任务卡已写下批次清单与最终检查点的连续实施，其**中间**提交按「实现 → 定向
    测试 → 独立审查 → 修复时定向回归 → 立即独立 commit」执行，中间提交**不跑**
    全量（仍跑 ruff 与 diff 检查），由写在**提交命令最前面**的
    `MOTV_CONTINUOUS_CHAIN=1` 逐次显式启用（**不是环境变量**，不得持久化；
    PowerShell 写成首行注释 `# MOTV_CONTINUOUS_CHAIN=1` 再换行写命令；同一条
    命令里带 push / merge 一律拒绝提交）。
    整条链结束后**统一跑一次**全量 + 最终验收；失败则「修复 → 定向测试 → 复审
    → 修复提交 → 重新跑全量」。**push / merge / 交接 / 人工验收之前必须完成
    最终全量。** 独立审查在中间批次不放松 —— 那是敢于推迟全量的唯一理由；
    审查者不可用时不得使用本节奏，回落常规归属验证并如实报告。
    **不存在永久关闭测试的全局开关。**

    **真实 Connected Project 是主要验收环境**（2026-08-11 起）：demo seed 与 SVG
    占位素材不作为主要验收依据 —— 它们会掩盖只有真实媒体才暴露的缺陷（实例见
    [TASK-055 §5](docs/tasks/done/TASK-055-project-rooted-storage.md)：保存镜头会静默
    丢失景别/角度/情绪、视频资产被放进 `<img>`）。发现真实数据问题时**优先如实
    报告，不得用 mock 绕过**。

21. 重大设计变更必须创建 ADR（存放于 `docs/adr/`）。

## 7. Git 与安全规则

22. **`commit`、`push`、`merge` 都不需要每次征求同意。**

    commit 可回退（`revert` / `reset`），而每问一次都是一次拖慢开发的往返
    （产品负责人 2026-08-15：「这些询问到回答的过程非常影响开发进度」）。
    push 同理 —— 产品负责人 2026-08-23：「我要的就是自动push。」
    **merge 同理** —— 产品负责人 2026-08-24：「合并。这个也不需要保留人工。」
    测试通过、无未闭合 P1 即可提交、推送与合并，按第 20 条跑归属检查。

    **人工闸没有了，前置条件一条没少**（[ADR-0085](docs/adr/ADR-0085-merge-is-not-a-human-gate.md)）。
    merge 之前仍然必须全部成立，而且现在由 Agent 自己负责证明：

    - 用户验收标准满足 + **最终全量**通过（第 20 条）+ 无未闭合 P1；
    - [待复审清单](docs/design/active/pending-codex-rereview.md)里没有覆盖本分支
      历史的未闭合条目（第 20 条那句「merge 前必须把这份清单当作前置闸门查一遍」
      **不变**，而且现在它比以前更重要 —— 以前还有一个人会在合并前看一眼）；
    - Merge Gate 依旧要显式设置并留痕，只是**依据从「用户原话」换成「Done 判定
      + 最终全量的结果」**；Gate 仍然绑在设它时的分支 tip 上，tip 一动就作废。

    **唯一还必须问的是「花钱」**（第 1 节）。

23. 不得提交 API key、密码、生成的视频文件或本地凭据到 Git 仓库。

## 8. 文档生命周期与默认上下文

依据：[ADR-0087](docs/adr/ADR-0087-document-lifecycle-and-default-agent-context.md)
（产品负责人 2026-08-26：「Current truth remains small. History remains traceable.
The repo converges instead of accumulating forever.」）。
细则与操作步骤在 dev-workflow Skill 的
[references/lifecycle.md](.claude/skills/dev-workflow/references/lifecycle.md)。

24. **每份文档属于三类之一，处置由类决定。**

    | 类 | 它回答什么 | 处置 |
    | --- | --- | --- |
    | **当前事实** | 现在是什么 / 现在要做什么 | 保持精简、持续更新、默认加载 |
    | **历史证据** | 当时为什么这么定 / 当时发生了什么 | 永久保留、默认不加载 |
    | **一次性产物** | 这一次我是怎么查 / 怎么试的 | 任务结束即删（先提炼再删） |

    判据不是「重不重要」，而是**过期时会不会骗人**。各记录类型的状态机：

    - **Requirement**（`docs/requirements/`）：`DRAFT → CONFIRMED → SUPERSEDED`。
      **不篡改旧版**，同文件追加 `v2 · supersedes v1`，实施只做 delta。
    - **Change / Task**（`docs/tasks/`）：**目录即状态** ——
      `backlog/`（没人在做）→ `active/`（正在做）→ `done/`（做完了）。
      `active/` 只放**正在进行**的工作，否则「待办 = `ls active/`」会连没人做的
      一起读成待办（ADR-0083 决策 1 + ADR-0087 决策 2）。
    - **ADR**（`docs/adr/`）：`Proposed → Accepted → Superseded / Rejected`。
      **旧 ADR 永不删除**，取代关系必须**双向**：被取代方写
      `状态：Superseded by [ADR-XXXX]`，取代方写 `取代：[ADR-YYYY]`；
      部分取代写成「Accepted（决策 1/2 保留）；决策 3 被 ADR-XXXX 取代」。

25. **默认 Agent 上下文（硬要求）。**

    默认只加载：`AGENTS.md` · 当前 Change 关联的 REQ（或任务卡「依据」行）·
    [当前架构合同](docs/current-architecture.md) 及它指向的相关那一份 ·
    `docs/tasks/active/` 里**本次**这张卡 + [STATUS.md](docs/STATUS.md) ·
    影响范围内的代码与测试。

    **默认不加载**：`docs/tasks/done/`、`docs/design/done/`、`docs/reports/`、
    未被当前架构合同指向的历史 ADR、被取代的 REQ 版本、历史 Change 清单。
    只有五种情形才按需读历史：**回归调查 / 架构理由 / 历史冲突 / 需求演化 /
    复现一次旧决策的边界**。

    「现在的架构是什么」不得靠遍历全部 ADR 推导 —— 那是
    `docs/current-architecture.md` 的职责（**WHAT IS TRUE NOW**）；
    ADR 回答的是 **WHY / HISTORY**，两者不合并。

26. **一次性产物默认删除，提炼优先于保留。**

    scratch、临时实施计划、调试记录、原始对话、一次性调查笔记、过期迁移清单、
    被放弃的原型笔记 —— 任务结束即删；有长期价值的**先提炼进 REQ / 任务卡 /
    ADR / 当前架构合同，再删原件**。「先都留下，以后可能有用」不是节省，
    是把成本转嫁给之后每一次读。

    - 临时产物**不进 `docs/`**：写 `.claude/tmp/`（已 gitignore）或会话 scratchpad。
    - 不留影子实现：`old/`、`old2/`、`legacy-copy/`、`backup/`、
      `deprecated-but-kept/` 一律不要 —— 代码历史由 Git 承担。
    - 不再代表当前有效行为的**测试与文档**：删除或更新，不留作「兼容测试」。
    - 这三条由 `.claude/tools/lifecycle_check.py` 守（`tests/tooling/` 里跑，
      因此自动出现在 commit gate 与 merge 前的最终全量中）；**判不了的不判**，
      交给第 20 条的收敛检查，宁可漏报不误杀。
