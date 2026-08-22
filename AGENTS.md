# AGENTS.md

本文件是本项目所有 AI 编码 Agent（Claude Code、Codex 等）必须遵守的正式规范。
Agent 之间只通过仓库中的文档、代码和 Git 状态共享上下文，不依赖各自的聊天记录。

## 1. 项目目标

### 长期目标

构建一个 AI 视频 / AI 短剧生产工作流（权威开发/构建/CI/agent 环境为原生
Windows + NTFS，见下方第 2 节第 2 条与
[ADR-0062](docs/adr/ADR-0062-windows-authoritative-environment.md)；Ubuntu / WSL2
与 Linux CI runner 是受支持目标），覆盖：

故事构思 → 结构化剧本 → 场景与镜头拆分 → 人物/场景/道具资产管理 → 图片生成
→ 视频生成 → 配音、音效和字幕 → FFmpeg 合成 → 质量检查
→ 质量、成本、交付周期（QCD）记录 → 最终成片
→ 统一创作工作视窗中的观察、运行、评价、复盘与跨项目学习。

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

### 统一创作工作视窗（已规划路线）

跨项目 Creation Workspace 已进入分阶段建设规划。需求基线见
[docs/ai_video_creation_workspace_requirements.md](docs/ai_video_creation_workspace_requirements.md)，
安全边界见
[ADR-0010](docs/adr/ADR-0010-creation-workspace-boundary.md)，WFM1 数据准备见
[docs/creation_workspace_data_observability_requirements.md](docs/creation_workspace_data_observability_requirements.md)。
交付治理见
[ADR-0030](docs/adr/ADR-0030-creation-workspace-delivery-governance.md)，任务路线为
`TASK-024`～`TASK-033`（WFM1 数据基线）。TASK-024 可立即做 docs-only 收口，已稳定 source 的只读
能力可增量实施；Workspace 仍不属于 WFM1 验收，生产级只读验收及全部界面写能力
受 TASK-023 门槛约束。UI 技术和最终数据结构只有在对应 Proposed ADR Accepted
后才可实施。完整流程由 WFM2 TASK-008/034～037 与 WFM3 TASK-012/038 补齐，
Workspace 完整多媒体扩展和两份顶层需求最终验收分别由 TASK-039/040 承接；
统一归属见
[端到端需求追踪矩阵](docs/design/end-to-end-requirements-traceability.md)。
L0–S7 阶段/步骤的逻辑输入输出基线见
[工作层级输入输出合同](docs/design/workflow-stage-step-io-contract.md)；实现任务只能
细化获批 schema/路径，不能删除输入绑定、输出身份或人工 Gate。

### 创作者 Studio（`mockups/motv-workspace`）

自 [ADR-0066](docs/adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
起，创作者 Studio 的界面归属与系统边界由两份文档冻结，它们是该范围的**唯一权威**：

- [创作者产品信息架构](docs/design/creator-product-information-architecture.md)
  —— 三空间 / 十一页的**封闭集合**、完整用户流程、三层检查、页面职责、
  现状→目标映射、Agent 协作与权限边界。
- [创作者系统合同](docs/design/creator-system-contract.md)
  —— 核心对象、Artifact 版本状态机、Skill Run 状态与持久化字段、
  Command / Query 名录、「界面—命令—任务—输出—确认」矩阵、前后端交互原则。

实施分四阶段（ADR-0066 决策 10 / TASK-072～074）：**新增 Skill 不得新增一级或二级
页面**；每项功能只有一个归属页面；Agent 不得静默覆盖、静默定稿、静默付费或替用户
完成审美决策。

自 [ADR-0067](docs/adr/ADR-0067-product-skill-package.md) 起，**Skill 是产品资产
而不是源码常量**：一个 Skill 是 `manifest.json` + `prompt.md` +
`output.schema.json` 三件套，从项目 → 用户 → 内置三个来源按优先级加载，Run 记录
`skillDigest` 使版本指向确定的内容；已被历史 Run 引用的版本**不得原地覆盖**；
Skill 只产生提案，**不得定稿、锁定、付费或导出**；加载或校验失败一律 fail-closed。
实施见 [TASK-075](docs/tasks/TASK-075-product-skill-package.md)。

**Studio 原型的运行时边界**（原 `mockups/motv-workspace/README.md` 的「治理
边界」并入此处，TASK-102）：

- 它是**非生产的 UX 原型**，不是受治理的 Workspace 实现。
- **只读接真实数据是允许的**（ADR-0031/0032 已 Accepted）：可选后端
  `server.py` 消费**公开**查询包 `ai_video_workflow.workspace`（与
  `src/workspace_shell/app.py` 同一公开面），只读、不写业务状态、不持凭据，
  刻意不放进 `src/workspace_shell/`。禁的是 import 核心**内部**类型。
- **写侧受门槛、保持 stub**：生成/发布/Command Gateway/DB/最终 schema 受
  ADR-0033+ 约束；前端 `services/gateway.js` 是 client stub，连上后端时生成类
  操作显式提示「待 Gateway」，不产生真实花费、不写核心文件。
- **画布持久化是原型本地 scratch**：`data/<project>.json` 只存画布自有状态，
  不是核心事实的投影，不回写任何核心文件（已 gitignore）。
- **已知非目标**：不接真实 Command Gateway、不做真实生成/发布、不写核心业务
  文件、不进 `workspace_shell`、不建 DB 或物化 projection。要把它落成生产
  Workspace UI 或做真写/真生成，另走 ADR 与任务卡。
- 演示模式的种子项目与 SVG 占位素材不是验收依据（见第 20 条「真实 Connected
  Project 是主要验收环境」）；连接模式永不触发种子。

**UI 差距审计工装**（原 `src/ui-gap-audit/README.md`，TASK-102）：
`src/ui-gap-audit/` 放审计报告与抓图工装。**像素不进 Git**——`current/` 拍的是
用户自己的创作项目，`target/` 拍的是他人产品界面，与第 23 条同一理由；清单、
报告与脚本进 Git，使审计可复现。竞品截图需要**用户自己的登录态，凭据从不经过
Agent**。审计**不得按下任何真实付费提交**，付费才能触发的状态如实标注为未实拍。
审计判据优先级：实际运行行为 > 代码 > 测试 > schema > 注释。

## 2. 技术与环境约束

1. Python 是主要开发语言。
2. 自 [ADR-0062](docs/adr/ADR-0062-windows-authoritative-environment.md) 起，
   **权威开发/构建/CI/agent 环境为原生 Windows + NTFS**；Ubuntu / WSL2 与 Linux CI
   runner 是**受支持目标**。「权威」的含义是**行为差异的裁决者**：两个环境结论不一致
   时以 Windows 为准；Ubuntu 上的失败仍然是缺陷，只是不再是裁决基准。文件系统限
   NTFS 同卷（ADR-0049）。
3. **平台中立，不是 POSIX。** 路径一律走 pathlib/stdlib；**不得硬编码分隔符**，也不得
   硬编码 `C:\Users\...` 或 `/home/...`；不得使用平台专属 syscall。
   反转的是权威归属，**不是**「代码可以开始关心自己跑在哪」（ADR-0062 决策 2）。
   注意：权威环境从 Linux 换成 Windows 后，「权威是 Linux」这个天然的可移植性执行者
   消失了——**因此受支持目标的 Ubuntu CI job 必须绿这一点比以前更重要，不是更不重要。**
4. **流水线与产品代码**内不使用 PowerShell、CMD 或平台专属路径——这一条不变。
   变的是 **agent 工装**：`.claude/hooks/`、skill 脚本及其 settings 接线以 PowerShell
   (`.ps1`) 为**权威实现**，对应 `.sh` 变体保留以服务 Ubuntu 目标，两者共享 ADR-0050
   决策 1 的同一行为合同表，必须给出相同判定（ADR-0062 决策 3）。面向 Windows 用户的
   `.ps1`/`.bat` 启动器就是主入口，不再是「例外」。
   **仓库路径所有权**（ADR-0077；原 `scripts/README.md` 的边界声明并入此处）：
   可执行的仓库级工具放 `scripts/`，**不放仓库根**——根只留项目元数据与治理
   文件（`README.md`、`LICENSE`、`pyproject.toml`、Agent 规则）。
   `scripts/launch/` 是面向人的产品启动器：`studio.ps1`（原生 Windows 权威）、
   `studio.bat`（双击/CMD 适配器，委托前者）、`studio.sh`（Ubuntu / WSL2）。
   三者都从**自身位置**解析仓库根，可从任意工作目录调用
   （`tests/tooling/test_repository_layout.py` 钉住这条）。其余所有权不变：
   agent 工装在 `.claude/`，应用与库代码在 `src/`，测试与其配置在 `tests/`。
   **README 只有仓库根那一份且面向使用者**（产品负责人 2026-08-22：
   「Readme不要设计太多…在project下面有一个就可以。别的readme如果是设计给
   agent遵守。请统一到agents.md或者claude.md」）——给 Agent 的规则写本文件或
   对应权威 docs，不再新建子目录 README。
5. 权威仓库位于 Windows NTFS（当前 `D:\02_Work\04_video-work\Visual-try-on-project`）。
   在 WSL 内对该仓库执行 git 时**必须对齐行尾语义**，否则 diff 完全失真（实测
   149,986 行 vs 1,918 行）：
   `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true`。
   不改共享配置。
6. 所有外部工具（ffmpeg/ffprobe/piper/claude/codex/node）一律经 `shutil.which`
   解析、**失败即 fail-closed**，不得裸名调用（ADR-0049 / ADR-0062 决策 2）。
   Windows 权威下这条更容易被触发且**必须如实报告**：安装器改了 PATH，但早于安装
   启动的进程（agent shell、commit gate 的 hook）看不到新 PATH——正确处理是重启会话，
   不是让代码去猜路径。
7. Python 依赖必须安装在项目虚拟环境（venv）内，不污染系统环境。

## 3. 架构约束

8. 核心工作流不能依赖任何具体视频厂商。
9. 所有视频生成方法必须通过 `VideoProvider` 接口接入（手工流程、云端 API、本地模型一视同仁）。
10. 原 M1 不接入任何付费 API；后续里程碑只有在 Accepted ADR 明确批准的
    范围内才可接入，当前窄范围授权见 ADR-0006 与 ADR-0009。
11. 工作流的每个步骤必须可以独立执行（可单独运行、单独重跑）。
12. 工作流必须支持断点续跑：中断后可从已完成的步骤之后继续，不重做已完成的工作。
13. 禁止静默覆盖用户文件和已有生成结果。两条合规路径里**优先选带版本的新路径**，
    而不是停下来找用户确认——不可逆是实现方式的缺陷，不是该上交的选择题
    （产品负责人 2026-08-15：「按理说不应该回不了头啊。这时候就算问我我也不知道
    该如何回答」）。同理：迁移留可回滚的旧数据、加法字段优先于破坏性变更、
    删除做成软删除。只有确实消除不掉不可逆性时才问，且必须带明确推荐。

未来 Creation Workspace 必须遵守：不直接调用 Provider、不直接修改核心业务
文件；变更命令经 Command Gateway 和 Workflow Orchestrator 应用边界；观察数据
可从权威文件/事件重建；界面关闭不影响核心执行。未经正式任务卡与 ADR，不得
提前实现 UI、Action Center、数据库或 UI 专用状态机。
图片/音频等多媒体 Provider 抽象、完整创意/后期与 WFM3 command capability 必须
分别等待 ADR-0037～0040 Accepted；不得提前泛化 `VideoProvider` 或由 UI 发明
pause/cancel/skip 状态。

## 4. Agent 协作规则

14. 每个开发任务（`docs/tasks/TASK-*.md`）只能有一个实施 Agent。
15. 另一个 Agent 只能作为独立审查者，不得在同一任务上并行修改代码。
    审查范围必须**明确限定为本次 diff 及它能影响的不变量**，不得每轮重新审查
    整个架构或整个仓库。审查者判断的是**实际风险**（正确性、回归、状态一致性、
    竞态、身份），不是「还能不能继续优化」；只报 P3/P4 时不得阻塞交付。
16. 修改前必须检查 `git status` 和相关文件的当前内容，确认没有他人未提交的改动被破坏。
17. 不修改当前任务范围之外的代码；发现范围外问题时记录到文档或新任务，不顺手修改。
18. 持久性决策必须写入仓库文档（docs/），不得只存在于聊天记录中。

## 5. 质量规则

19. 新功能必须有测试。
20. **测试按所有权与影响范围运行（Test Scope = Change Impact Scope），不做
    风险分级**（产品负责人 2026-08-22：「不要保留风险分集」「我不要每次都
    全量测试。」；[ADR-0080](docs/adr/ADR-0080-test-ownership-and-gate-mapping.md)
    取代 ADR-0060 的分档语义，[ADR-0081](docs/adr/ADR-0081-review-by-impact-scope.md)
    取代 ADR-0069 的按档轮次预算）：

    | 测试域 | 归属目录 | 独立运行命令 |
    | --- | --- | --- |
    | 后端（src 库 + workspace_shell） | `tests/backend/` | `pytest tests/backend` |
    | Studio Python 后端（暂居 mockups） | `tests/studio/` | `pytest tests/studio` |
    | 跨 py↔js 合同 | `tests/contract/` | `pytest tests/contract` |
    | 端到端关键路径 | `tests/e2e/` | `pytest tests/e2e -m "not serial"` + `pytest -m serial` |
    | Agent 工装（gate/skills/仓库结构） | `tests/tooling/` | `pytest tests/tooling` |
    | 前端 | `mockups/motv-workspace/tests/` | `node --test mockups/motv-workspace/tests/*.test.mjs` |

    共享测试支撑层（`tests/conftest.py`、scenario 构造器、假件）留在 `tests/`
    根。Python 测试不得对前端 JS 做源码文本断言、不得内嵌 `node --test`；
    跨边界验证只住 `tests/contract/`（ADR-0080 决策 3）。

    本地 commit gate 按 ADR-0080 的**归属映射**选择检查：改动路径 → 它的归属
    测试域；映射不到时 fail-closed 到全量。**全量（两阶段 pytest + 全量前端 +
    ruff）是集成检查点**——CI、连续链链尾、merge 前、发布/交接前——不是日常
    提交的默认。

    **审查按影响范围触发，不按档位**（ADR-0081，产品负责人 2026-08-22：
    「dev-workflow 根据影响范围决定是否审查 → 默认一轮 → P1 修复后复审一次
    → P2 修复 + 定向测试，不再复审 → P3/P4 记录但不阻塞」）。行为/合同/
    持久化/安全/并发/跨域改动做独立审查；纯文档、纯展示改动不审。历史代价
    提醒仍然有效：TASK-061 13 轮、TASK-062 10 轮（轮 B4 撤回了轮 A4 的修复，
    净负值）——协议之外不得静默续轮。

    **发布闸门 = 用户验收标准满足 + 相关测试通过 + 无未闭合 P1**，
    而不是零发现 + 全量测试 + 完美架构。`VERDICT: pass` 不是闸门。

    **全量 pytest 改为两阶段并行跑**：

    1. `pytest -n 8 -m "not serial"` —— 并行，3186 项
    2. `pytest -m serial` —— 串行，5 项（真实进程树）

    **唯一权威基线**（原生 Windows，同一台主机，2026-08-14 同口径实测，
    3191 项）：**串行 469s → 两阶段 179s（并行 132s + 串行 47s），2.6×**。
    历史参考数字 328s / 2815 项（2026-08-10，gate.ps1 注释）测的是**更少的
    测试**，不可与上面的数字混用来判断是否回归。

    2026-08-15 在 TASK-072/073/074 那批新代码上复测两阶段：3198 项
    **210s**（并行 155s / 3137 项 + 串行 55s / 5 项），0 失败——并行安全性在
    新代码上重新证明过，没有新的并行不安全测试。该轮**未重测串行基线**，
    因此 2.6× 这个倍数仍以 2026-08-14 的同口径数字为准。

    收益来自 fsync I/O 重叠，因为 Windows 没有 `/dev/shm`，
    `tests/conftest.py` 的 tmpfs 路由在这里是 no-op。`-n 8` 是实测值，
    不用 `auto`（12）——fsync 主导后更多 worker 不再付费。
    `serial` marker 只给**断言真实 OS 进程状态**的测试用
    （当前仅 `tests/e2e/test_motv_run_lifecycle_task072.py`），
    不是绕开并行的通用逃生口。

    实施记录见[提速与 gate 修复](docs/design/pending-speedup-and-gate-fix.md)。

    **连续修改链例外**（[ADR-0068](docs/adr/ADR-0068-continuous-modification-chain.md)）：
    经用户**明确授权**、且任务卡已写下任务/批次清单与最终检查点的连续实施，其
    **中间**提交按「实现 → 定向测试 → Codex review loop → 修复时定向回归 →
    Codex 通过 → 立即独立 commit」执行，中间提交**不跑**全量 pytest 与全量前端
    （仍跑 ruff 与 diff 检查），由写在**提交命令最前面**的
    `MOTV_CONTINUOUS_CHAIN=1` 逐次显式启用（**不是环境变量**，也不得持久化；
    PowerShell 写成首行注释 `# MOTV_CONTINUOUS_CHAIN=1` 再换行写命令；同一条
    命令里带 push / merge 一律拒绝提交。见 ADR-0068 决策 7 补记）。
    整条链结束后**统一跑一次**全量 pytest + 全量前端 + ruff + 最终验收；
    最终全量失败则「修复 → 定向测试 → Codex 复审 → 修复提交 → 重新跑全量」。
    **push / merge / 交接 / 人工验收之前必须完成最终全量。**
    **Codex 独立审查在中间批次不放松**——那是敢于推迟全量的唯一理由；
    审查者不可用时不得使用本节奏，回落到本条第 20 项的常规归属验证
    （ADR-0080）并如实报告。
    **不存在永久关闭测试的全局开关。**
    UI 迭代不得每次触发 2800+ 项 pytest（一轮约 6.5 分钟，纯粹浪费用户时间）。

    **真实 Connected Project 是主要验收环境**（2026-08-11 起）：demo seed 与 SVG
    占位素材不再作为主要验收依据——它们会掩盖只有真实媒体才暴露的缺陷（实例见
    [TASK-055 §5](docs/tasks/TASK-055-project-rooted-storage.md)：保存镜头会静默
    丢失景别/角度/情绪、视频资产被放进 `<img>`）。发现真实数据问题时**优先如实
    报告，不得用 mock 绕过**。
21. 重大设计变更必须创建 ADR（Architecture Decision Record，存放于 `docs/adr/`）。
## 6. Git 与安全规则

22. **`commit` 不需要每次征求同意**——它可回退（`revert` / `reset`），而每问一次
    都是一次拖慢开发的往返（产品负责人 2026-08-15：「这些询问到回答的过程非常
    影响开发进度」）。测试通过、无未闭合 P1 即可提交，按第 20 条的分级跑检查。
    **`push` / `merge` 仍须用户明确要求**：一旦推到远端，别人可能已经拉取，
    「做出来给他看了再改」的前提就不成立了。
    （另见 CLAUDE.md「决策模式」：判据是**错了能不能重来**，不是决定的大小。）
23. 不得提交 API key、密码、生成的视频文件或本地凭据到 Git 仓库。
