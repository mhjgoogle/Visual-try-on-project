# 待补 codex 复审清单（降级审查模式的债务）

- 依据：[ADR-0068 补记](../adr/ADR-0068-continuous-modification-chain.md#补记降级审查模式2026-08-13--2026-08-18)
- 起因：codex 触到 workspace spend cap，2026-08-18 之前不可用；`claude` CLI 未安装
- **更新（2026-08-14 实测）**：
  - codex 仍是**硬 spend cap**，非速率限制。原文：
    `ERROR: You hit your spend cap set by the owner of your workspace.
    Ask an owner to increase your spend cap to continue.`
    → **要么由 workspace owner 提高上限，要么等到 2026-08-18。本清单在那之前
    无法清空，因此「不得 push / merge / 交接」这条继续生效。**
    （当日 round 1/2 还能用、round 3 就断了，说明那两轮把余额用尽。）
  - **`claude` CLI 已安装**（2.1.232，`C:\Users\MO\AppData\Roaming\npm\`），
    订阅凭据已存在，`claude -p` 实测可用 → 降级审查者**现在始终存在**，
    「两者都不可用」的死锁场景已消除（ADR-0069 决策 6 的配套要求）。
    但它与实施者同模型族，**不能**用来清掉本清单里要求跨模型复审的条目。
- 规则：**本清单清空之前，不得 push / merge / 交接 / 宣告最终验收**
- **2026-08-16：codex 恢复，本清单的原始债务已清。** 实测 `codex exec` 可用
  （无 spend cap）。九个条目全部经跨模型复审，共报 17 条 blocking，逐条验证后
  **7 条为真（全部已修）、8 条驳回（均有代码证据）、2 条记录为 follow-up**。
  详见下方「已补完」。**唯一未审的是 `a187cc8` 那一条**（纯文档规则）。

## 怎么用

每一个在降级模式下通过的中/高风险检查点，在这里加一行。补完 codex 复审后
划掉该行并注明复审提交，**不要删除行** —— 删掉就看不出这段时间发生过什么。

## 待复审

| 提交 | 内容 | 风险 | 降级模式下的审查者 | 状态 |
| --- | --- | --- | --- | --- |
| `70dab40` | TASK-072 批次一（Run 注册表 / 八态 / v15 迁移 / 五端点收口） | 高 | codex 23 轮**已审**；仅**第 23 轮的 3 个修复**未复审（第 24 轮撞上 spend cap） | **待 codex 复审**（范围：那 3 处） |
| TASK-075 批次 B1 / B2（`git log --grep "TASK-075"`） | 数据围栏 + `episode-planner` + `script-reviser` + 五个端点改跑 Skill 包 + `/api/skills` | 高（改的是五个在用端点真实问模型的问题） | 独立 Claude Opus 会话：B1 3 轮、B2 3 轮（同模型族，**无跨模型独立性**）；**B2 第三轮仍 fail**，两项已修、七项登记为债务 | **待 codex 复审**（范围：全批次 + 卡内七项债务） |
| TASK-075 批次 A（`git log --grep "TASK-075"`） | Skill 包格式 + 二十个定义逐字迁移 + 后端加载器（digest / 优先级 / fail-closed / JS 编译器镜像） | 高（新增加载路径 + 迁移 + 溯源身份） | 独立 Claude Opus 会话 3 轮，第 2、3 轮 pass（同模型族，**无跨模型独立性**） | **待 codex 复审**（范围：全批次） |
| 未提交（工作树） | **一大批未提交实施**（2026-08-14/15）：TASK-075 §1.4；TASK-072 §1.4 Query/Command 拆分 + `apiclient.js`（24/30 调用点）、§1.5 Review 三层、§1.6 门槛 G1–G5（G3 接进 dispatcher）、§1.7 六态派生、§1.9 十条缺陷中的**七条**（含 blocking #1 / #8）；TASK-073 §1.1/§1.2 IA 收敛 + §1.3 任务行与真实取消 + §1.4 Agent 面板 + §1.5 生成记录 + §1.6 资产库抽屉 + §1.7 ⚙ 十四字段与两个硬闸（含 canvas 加法字段 `deliverySpec` / `reviews`）；TASK-074 §1.1b 四条端点加固 + §1.2 交付质检领域层 | 高 | **无审查者**：产品负责人 2026-08-14/15 明确要求推进并自行判断审查；codex 全程 spend cap，claude fallback 同模型族亦不可用 | **待 codex 复审**。优先级：① `server.py` 两处 `_num` 与 `_PROBE_SEM`（可被构造请求触发的崩溃与资源耗尽）；② §1.9 #8 候选集围栏与 #1 写前校验（安全边界）；③ dispatcher 的 G3 包装（每个 action 都过它）；④ `deliverySpec` / `reviews` 两个加法持久化字段（**无 schema 版本升级**，理由见 TASK-073 §5.6）；⑤ `apiclient` 的重试/超时/body 策略 |
| `c1edb00` (TASK-076) | 连续修改链在 commit gate 上真实生效：令牌改从命令文本读取、`continuous-chain` 层级、两 shell 不再各自匹配 | 中～高（改的是质量门本身） | 独立 Claude Opus 会话 5 轮，第 5 轮 pass（同模型族，**无跨模型独立性**） | **待 codex 复审**（范围：全卡） |
| `c12d5a0` (TASK-074 §1.2 接线) | 新增只读端点 `POST /api/delivery/probe`：ffprobe + ffmpeg(ebur128/blackdetect) 测量成片，喂给交付质检的五项 | 高（新增外部进程调用 + 上传目录内的文件解析） | **无独立审查**：codex spend cap；claude fallback 同模型族 | **待 codex 复审**（范围：`_resolve_upload_file` 的路径围栏在新调用点是否仍成立、900s 超时与 fail-closed 分支、`_build_delivery_probe` 的「测不出即缺席」是否真的没有回填 0 的缝） |
| `a187cc8` + 后续文档提交（ADR-0069 / 交付流程恢复） | 审查轮次预算、P2 不再触发再审、审查不阻塞提交、分级取最高档、决策自主权、WIP=1；**改的是质量门规则本身** | 高 | codex 2 轮（round 1/2，跨模型独立）+ claude fallback 1 轮（round 3，同模型族）。5 个 blocking 全部已修，但 **round 3 的 P1 修复（`CLAUDE.md:94` 矛盾消除）未复审**——预算 3 轮耗尽且 codex 再次不可用，按 ADR-0069 决策 d 选 escalate | **待 codex 复审**（范围：**只需** round 3 的那一处 P1 修复 + 4 处 P2 修复；前两轮的修复已由 codex 复审过） |
| pytest 两阶段 + gate 修复（2026-08-15 落地，见[实施记录](pending-speedup-and-gate-fix.md)） | pytest 两阶段并行（`pyproject.toml` / `gate.ps1` / `gate.sh` / `ci.yml`）+ commit gate 两处分类缺陷（`_DOC_FILES` 漏 CLAUDE.md、`_normalise` 的 `lstrip` 吃掉 `.claude/` 与 `../`） | 高（改的是质量门与路径规范化） | **无独立审查**：codex 全程 spend cap；claude fallback 可用但同模型族，不满足本项所需的跨模型独立性 | **待 codex 复审**（范围：全批；**尤其** `_normalise` 的路径穿越语义变化） |
| `f05e477` + `ccee69b`（一集镜头数上限 20→120） | 三处写死的 `20` 统一成 `_MAX_SHOTS_PER_EPISODE=120`（解析器 / 合成路由 / 分镜编辑器）+ 三种失败分开报错 + 跨语言一致性守卫 | 中（阈值 + 单层业务逻辑；未改接口形状、文件操作或持久化） | 独立 Claude 会话 2 轮：轮 1 `fail` 报出 P1（第三处 `20`）与 2 条 P2（我自己引入的守卫缺陷），全部已修；轮 2 `pass` 且复审了这些修复（同模型族，**无跨模型独立性**） | **待 codex 复审**（范围：① 抬高上限后合成路径的资源包络——每镜 ffmpeg 300s、无聚合上限，单次请求最坏情况从 20×300s 变 120×300s；② `_parse_shots` 首个 `[`→末个 `]` 的切法在 `shots` 之后还有含 `]` 字段时会误报 JSON 语法错） |
| `e833736` (TASK-073 §1.8 第四批) | `ctx.skills`（853 行）搬到 `src/controllers/skillctl.js`；`_clipChain` 与 `pendingOrigin` 随迁；五处按文件切片的守卫改扫新文件 | 高（跨层合同 + Skill Run / Proposal 身份与溯源） | 独立 Claude 会话 1 轮，`VERDICT: pass`、0 blocking（同模型族，**无跨模型独立性**）。4 条 non-blocking 已逐条处理：2 条驳回**并有变异/静态核对证据**、1 条核实启动顺序安全、1 条是 pre-existing P3 记录不修 | **待 codex 复审**（范围：**搬迁等价性**——尤其 `run`/`cancel`/`abandon` 在 `await` 之后重读运行登记的绑定语义是否与原 `app.js` 逐字等价，以及 `context()` 里被提成 const 的四个文档读取在无 await 的同步路径上是否确实等价） |

## 已补完（2026-08-16 codex 跨模型复审）

复审方式：不重放历史 diff（脚本硬编码 `$Base...HEAD`，且大批次会撞 4000 行上限），
而是把清单里本来就写成具体问题的「范围」直接交给 codex 审**当前代码**——那些代码
现在还在，后续提交可能已经动过它们，审「现在对不对」比审「当时的 diff 对不对」
更有价值。

| 原条目 | 复审批次 | 结果 |
| --- | --- | --- |
| `70dab40` TASK-072 批次一 | F（Run 注册表并发/持久化/进程树） | 报 3 条 → **1 真已修**（`runstore.py` 唯一一处不落盘的状态转换，绕过了 `_commit_locked` 自述的不变量）+ 2 条驳回（Windows Job Object 是 KILL_ON_JOB_CLOSE 内核级兜底） |
| TASK-075 批次 A | E1 + E2 | 报 3 条 → **2 真已修**（不可读源仍回落 builtin —— 那个修复从未接上；约束类型不校验导致运行时未捕获 TypeError）+ 1 条记录 |
| TASK-075 批次 B1/B2 | H | 报 1 条 → **1 真已修**（修订跑 `script-reviser` 却用 `script-writer` 的 schema 判定答案） |
| 工作树那一大批 ①② | A（`_num` / `_PROBE_SEM` / 候选集围栏） | 报 2 条 → **全部驳回**（输入面决定围栏范围；`replacesKey` 在 dispatcher 第一行即被拒） |
| 工作树那一大批 ③④⑤ | I（dispatcher G3 / 加法字段 / apiclient） | 报 1 条 → **待修**（顶层 `reviews` 无 schema 校验，见下） |
| `c1edb00` TASK-076 | G（链令牌与冲突扫描） | 报 7 条 → **2 真已修**（引号形式绕过冲突扫描；动词表只有 push/merge）+ **1 真已修**（`gate.sh` 分类器无超时 = fail-open）+ 1 条驳回（提交信息里的令牌，实测锚定有效）+ 3 条待修（见下） |
| `c12d5a0` TASK-074 §1.2 | B（交付质检探测） | 报 1 条 → **1 真已修**（ffmpeg 扫描退出码从不检查，部分测量冒充完整测量） |
| pytest 两阶段 + gate 修复 | C | 报 2 条 → **1 真已修**（字面反斜杠骗过文档分类，Python 文件跳过 pytest）+ 1 条驳回（两 shell 超时预算差异是有意的平台耗时差异） |
| `e833736` TASK-073 §1.8 | D（搬迁等价性） | **pass，0 blocking** ✅ |
| `f05e477` + `ccee69b` 镜头数上限 | C 覆盖 gate 侧；本体为中风险且已 2 轮审 | 无新增 blocking |

## 2026-08-16：经授权在清单未清空的情况下 push（显式偏离留痕）

产品负责人 2026-08-16 明确授权：**在下方「仍然待办」四项未闭合的情况下
push `feat/wfm1-batch-c`（本地领先远端 120 个提交）**。

这是对本文件第 26 行「本清单清空之前，不得 push / merge / 交接」的**一次显式偏离**，
按该规则的本意（可以推迟，不可以跳过）留痕于此，不删除任何行。

未闭合的四项及其理由：

| 项 | 未闭合内容 | 为什么可以后置 |
| --- | --- | --- |
| `a187cc8` + 后续 | round 3 的 1 处 P1 + 4 处 P2 未经跨模型复审 | **纯文档**（CLAUDE.md / AGENTS.md 规则自洽性），无代码路径 |
| 顶层 `reviews` 无 schema 校验 | 已确认，未修 | 已识别、有明确改法（对齐 `deliverySpec` 那条规则），非未知风险 |
| gate 的命令文本判定 | 已确认，未修 | 根因是判定机制（正则读命令文本），属**待设计**而非待修；加变体不收敛 |
| `studio/skills` 无 containment | 已确认，未修 | 安全边界，但**需本地写权限才能利用**，非远程可触发；且产品语义未定（junction 共享 skill 包是否合法） |

**四项都是历史债务**，不是 TASK-077～079 引入的 —— 那三轮全程 codex 跨模型审查，
独立性未降级，链尾全量绿。

后续处理已开卡：[TASK-084](../tasks/TASK-084-clear-the-push-gate.md)。
**本偏离不解除该卡的义务**，只是把它从「push 的前置」改为「push 之后立即做」。

---

## 仍然待办

| 项 | 状态 |
| --- | --- |
| ~~`a187cc8` + 后续（ADR-0069 规则文档）~~ | ~~**未审**。纯文档（CLAUDE.md / AGENTS.md 的规则自洽性），范围：round 3 的那处 P1 修复 + 4 处 P2~~ → **已补审（2026-08-16，codex 跨模型，TASK-084 项 1）**。范围严格限定为 round 3 的 1 处 P1 + 4 处 P2，未重审整个 ADR。结果 `VERDICT: fail`：**1 blocking 已修**（ADR-0069 决策 3 要求高风险 P2 修复用掉剩余那轮复审，而 CLAUDE.md / AGENTS.md 写成无条件「P2 不再审」——两条活规则对同一情形给出相反指令，已就地限定两处表述）+ **1 non-blocking 已修**（ADR-0069 实施行仍写「尚未提交」，决策 7 实际已于 2026-08-15 落地）。round 3 那处 P1（`CLAUDE.md` 两者都不可用时的死锁）复审确认成立，无残留的活「停下」规则。提示词与原始输出：`.claude/tmp/codex-rereview/J-adr0069-round3.{md,out}` |
| 顶层 `reviews` 无 schema 校验 | **已确认，未修**。`canvasschema.js` 只校验 `production.shotProduction.reviews`；顶层 `reviews` 的 `decisions` 水合时只查「是不是数组」，元素形状不查，未校验的 decision 会喂给 G3。对照 `deliverySpec`——同为加法字段却是 present-but-wrong 即拒绝整份文档 |
| gate 的命令文本判定（shell 层） | **已确认，未修**。`git "commit"` 引号形式检测不到（gate 直接不跑）、`git "-C"` 引号形式的重定向检测不到。与本轮已修的冲突扫描是同一个根：**靠正则匹配命令文本判断意图，宽了误伤、窄了漏掉，加变体不收敛**。真正的修法是换判定机制（拿结构化 argv 而非原始文本），属独立设计改动 |
| `_load_skill_catalog` 的 `studio/skills` 无 containment | **已确认，未修**。junction 可指向项目根之外。与仓库既定纪律（`_resolve_upload_file` 有严格 symlink 检查）不一致，但需本地写权限；且改动会破坏「用 junction 共享 skill 包」这种可能合法的用法——先定这个再动 |
| POSIX 缺 parent-death 机制 | **记录**。Windows 由 Job Object 兜底；POSIX 需新增 `PR_SET_PDEATHSIG`，且对孙进程无效 |

### 本轮暴露的一个方法论问题（值得单独记）

多条真缺陷的形状是**「守卫看起来加了，其实没接上」**：

- `_package_dirs` 的注释把危害描述得很准确，代码却因为 `skill_id=""` 与按 id 索引
  的屏蔽表对不上而从未生效；
- 对应的既有测试**只传了一个 source**，下面没有 builtin，「回落到 builtin」在那个
  fixture 里根本不可能发生——docstring 说对了危害，构造没造出那个危害；
- `gate.sh` 的预算注释写着「a hung check must never fail open」，而分类器本身是
  唯一没有超时的一步。

共同教训：**一条守卫的价值等于它的构造能否让被防的那件事真的发生**，不等于它的
注释说得多准确。新增/加强守卫时一律做变异验证（改坏实现看它是否变红），本轮每
一条修复都做了。
