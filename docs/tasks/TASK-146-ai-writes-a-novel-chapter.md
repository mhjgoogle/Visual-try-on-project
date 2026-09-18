# TASK-146：小说模式下，AI 真的能写出一章小说

- 状态：完成 · **实现完成**（2026-09-14；2026-09-18 收口 —— 切片二 / 三 / 四已由
  TASK-152 / 154 / 155 接着做完，本卡没有剩余工作；§7 三条「还没在真实项目上被人看过」
  仍是信息，不是闸门）。两个独立事实，分开写（AGENTS.md §1）：
  1. **实现完成** —— 代码级证据：新能力包 `product-skills/builtin/novel-chapter-writer/`
     三件套 · `internalRouting.form` 合同与 `skillpkg._check_internal_routing` 的
     fail-closed 校验 · `server._conv_resolve` 打分前的形态硬排除 ·
     `storywork.{targetUnitNo,applyBodyProposal,chapterPlanOf}` ·
     `skillrun.contextOf` 带上 `unitNo` · `proposeScript` action 的 `form`/`unitNo`。
     验证：`pytest tests/studio tests/contract` 968 passed ·
     前端 2314 pass · ruff 通过 · `lifecycle_check` 0 finding ·
     codex 五轮审查收口于 **BLOCKING 为空 + 六条架构全 PASS**。
  2. **还没在真实项目上被人看过的** —— 见 §7。**这是信息，不是闸门**，不阻塞收口；
     但 Change 级 merge 之前必须走查。
- 起因：产品负责人 2026-09-14 —— 「我希望这个app能先完成 AI 小说自动创作工作流，
  再将小说内容连接到视频生产流程。」· 闸：放行（这句话本身就是新里程碑，
  [project-context.md](../project-context.md) 里程碑行已在本卡同一批次改掉）
- 类型：Feature · 深度：DEEP（C=DEEP：`internalRouting` 合同新增字段、
  resolver 新增硬约束、能力包升版本）
- 成果物：[REQ-009](../requirements/REQ-009-write-the-novel-first-then-film-it.md) ·
  本卡 · 提交（ADR 见下方「架构决定」—— 本卡的决定落在既有 ADR-0067/0091 的
  合同扩展上，是加法，不新建 ADR）
- 关联 Requirement：REQ-009 v1 判据 1、2、3
- 架构约束：`CA §1–5`；ADR-0066 十一页闭集不动 · ADR-0067 能力包三件套与
  「已被历史 Run 引用的版本不得原地覆盖」· ADR-0091 前端只见三类能力、
  选哪个专业能力由服务端确定性决定 · AGENTS.md §13 不静默覆盖
- 实施 Agent：`visual-try-on-project-59`（2026-09-14 认领）

## 1. 这一片交付什么

REQ-009 切片一。他在一个**小说**项目里打开某一章，说「写这一章」——
一章小说正文被写出来：叙述、描写、对话混排的散文，不是剧本格式。

现在这句话会被直接拒绝（`app.js` 的 `proposeScript`：`work.form !== "episode"`
就返回「这是小说模式，我不知道该写第几章」），而且即使接通，跑的也会是
`script-writer` —— 产出的是可拍剧本，不是小说。

## 2. 架构决定（结论几行，理由在这里，不另开 ADR）

**问题**：「写这一章」和「写这一集」用同一批名词，靠 `selectWhen` 关键词分不开；
而小说与剧集是同一个项目里的两种**形态**（`storywork.FORMS`），不是两个 scope。
resolver 现在看不见形态，因此无法确定性地区分这两个能力。

**决定**：`internalRouting` 新增**可选**字段 `form`（`"novel"` | `"episode"`），
缺省表示「两种形态都适用」。resolver 在排序之前把与当前形态矛盾的候选**排除**
（硬约束，与既有的 `scope == "shot"` 却没有选中镜头是同一类处理）。

为什么不是别的做法：

- 不新增 scope 值（`novel`）—— scope 说的是「对着什么东西运行」（项目 / 一集 /
  一镜），形态说的是「这个项目在写什么」。两件事混进一个字段会让
  `scope: "episode"` 在小说项目里语义崩掉。
- 不靠关键词「章」vs「集」—— 「接着往下写」两边都命中不了，而那恰恰是切片二
  最主要的说法。
- 不让前端指定 skillId —— ADR-0091 决策 2 明令禁止，本卡不碰那条边界。

**形态从哪来**：前端把当前 `story.work.form` 报进会话上下文（与 `readyInputs`
同一条路，ADR-0089 决策 2b：创作文档只活在浏览器里，就绪状态由前端报）。
没报或为空 = 不限。

**章号从哪来**（codex 轮 1 的 BLOCKING 4 逼出来的第二个决定）：只选对落点不够 ——
能力还得知道**它在写第几章**，否则它拿着整份大纲写出自己挑的那一章，然后被安静地
放进他打开着的第 7 章：落点对了，内容对不上。

所以新增输入 `chapterPlan`「本章任务」（章号 + 这一章的结构规划行 + 解析成内容的
大纲引用 + 已有字数），列为小说家的**必填**输入，章号随 `scope` 从 `ui.unitNo` 送到
`skillctl.context`。`skillctl` 自己**不猜**章号：`scope` 里没有就是 `null`，于是
`missingInputs` 在**运行前**拒掉这一次并说清缺什么 —— 比跑完再拒早一步，也比
「跑出一章不知道是第几章的正文」诚实。

**没有结构规划行不是错误**：他可以只写大纲就开写，那时 `planRows` 是空的，
能力照跑，只是少一层约束。

**版本**：`script-writer` 增加 `form: "episode"` 属于 manifest 变更 →
`skillVersion` 2 → 3，`episode-from-scratch` 流程里引用的版本号同步改
（ADR-0067：已被历史 Run 引用的版本不得原地覆盖）。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | 新建 REQ-009 v1 | REQ-007 判据 1–7 一条不改 —— 本卡是在它建立的路由机制上加一个候选，不是换机制 |
| UI | 无（本片不改界面）；「写这一章」走的是右栏既有 Agent 对话 | 四入口 / 十一页闭集 / 正文创作的形态切换与 Planned Chapters 控件 / `draftws.js` 渲染 |
| 数据 Schema | `internalRouting` 新增可选 `form`；`skill-inputs.json` 新增输入键 `chapterPlan`；新增 `novel-chapter-writer/output.schema.json` | `story.work` 持久化结构一个字段不加 —— 章节正文写的是既有 `unit.body`，走既有 `editUnit` / `finalizeUnit`；`chapterPlan` 是**派生**的，不落盘 |
| Workflow | `episode-from-scratch` 只改 `script-writer` 的版本号 | 流程的步骤序列、`conventions`、seed 骨架 |
| 测试 | `tests/studio/`（resolver 形态约束）· `tests/contract/`（前后端 form 上报）· 前端 `tests/`（proposeScript 小说分支） | `tests/backend/` · `tests/e2e/` —— 本卡不碰 `src/` 与核心库 |
| docs | REQ-009 · 本卡 · project-context 里程碑行 · requirements/index · STATUS/WORKSTATUS 重生成 · `current-architecture.md` §3「对话里的能力路由」那一行（resolver 多吃一个上下文输入，属于跨层合同，同一个提交里改） | CA §1 模块边界 · §2 依赖方向 · §4 测试归属 · §5 七条不变量 · glossary · out-of-scope |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`novel-chapter-writer` 能力包三件套 · `internalRouting.form` 合同与
校验 · resolver 的形态硬约束 · 前端上报 form · `chapterPlan` 输入与它的章号来源 ·
`proposeScript` 的小说分支（写进**当前打开的那一章**，写前按 §13 先存一版）·
上述四处测试。

**OUT OF SCOPE**：连续写多章（切片二）· 故事核心 / 大纲 / 结构规划在小说语境下的
措辞与产出（切片三）· 小说 → 剧集转换（切片四）· 任何界面改动 · 任何会花钱的
生成 · 小说导出格式。

## 5. 验收

1. 小说项目里打开第 N 章说「写这一章」→ 写出小说正文，落在第 N 章，
   原有内容先存成一版（不静默覆盖）。
2. 一章都没打开时 → **不写**，并说清楚要先去「正文创作」打开哪一章（不猜章号）。
3. 产出是散文，不是「场景1 · 地点 · 时间」格式 —— 由 `novel-chapter-writer`
   的 prompt 与 schema 保证，且剧集项目里同一句话仍然落到 `script-writer`。
4. 剧集项目的行为**一个字节都没变**：「写这一集的剧本」仍然选中 `script-writer`，
   仍然写进当前集。
5. **显式报 `episode` 时，选择与加这个包之前完全一致** —— 剧集用户一个字节都不受影响。

   > **订正（2026-09-14，codex 轮 1 的 BLOCKING 3）。** 原文写的是「前端没报 form 时
   > resolver 的选择与今天完全一致」，那要求一件逻辑上不可能的事：往
   > `episode-production` 里加一个包，它必然出现在**没有形态约束**时的候选集合里
   > （「接着写」会命中小说家的关键词）。原判据不是一条能满足的判据，是一句错话。
   >
   > 真正要守的不变量是上面这条（剧集侧不受影响）。**没选形态的项目**另有一层
   > fail-closed 兜着，也一并测：`chapterPlan` 缺 → 运行前就被必要输入闸拒掉；
   > 即便跑到了应用那一步，`applyBodyProposal` 也会因为 `form` 为空而拒绝并让他
   > 先去选形态。所以「没选形态时选中了小说家」不会写坏任何东西。
6. 前端 Agent 的提示词里能力名仍然只有三个（REQ-007 判据 6 不被本卡破坏）。

## 6. 验证

影响范围 = studio（服务端 resolver 与包加载）+ contract（py↔js 的 form 上报）
+ 前端（`app.js` / `skillctl` / `storywork` 写路径）。按 AGENTS.md §20 跑这三个域，
不跑全量（全量留到本里程碑的集成检查点）。

**实测**：`pytest tests/studio tests/contract` 967 passed / 16 skipped ·
`node --test mockups/motv-workspace/tests/*.test.mjs` 2304 pass ·
`ruff check .` 通过 · `lifecycle_check.py` 0 finding。

### 独立审查（codex，三轮）

行为 + 合同改动 → `codex-review-loop`。默认 1 轮，**两条 P1 各买了自己的一轮**
（ADR-0081 §2a），失效机理互不相同：

| 轮 | 结论 | 买轮的那条 |
| --- | --- | --- |
| 1 | fail · 4 BLOCKING | 最重的是**能力不知道要写第几章** —— 落点对了、内容对不上。修法见 §2「章号从哪来」 |
| 2 | fail · 1 **新** P1 | **章号跟着屏幕跑**：第 5 章生成、切到第 6 章再应用，正文落进第 6 章 |
| 3 | fail · 1 P1（同类的另一半） | **形态也跟着屏幕跑**：小说模式生成、切成剧集模式再应用，一章小说写进当前集。轮 2 的修复只做了这个类的一半 |
| 4 | fail · 判据 1 与验收 4/5/6 转 **PASS**、六条架构全 PASS · 1 P1 | **反方向的同一件事，而且是我引入的回归**：剧集模式生成剧本 → 切成小说模式打开一章 → 应用，剧本写进那一章。**改动前的老代码会拒绝它** |
| 5 | **BLOCKING 为空** · 判据 1 与验收 1/2/4/5/6 **PASS** · 六条架构全 **PASS** | 不再买轮。剩余两条是 evidence-only，其中「真实 schema 拒绝」当轮补上（审查者指出它**不需要真实模型**，他是对的 —— 我前几轮把它和「产出是不是散文」混成了一件事），另一条见 §7 |

**这条教训值得单独记**：`{form, unitNo}` 是提案的**落点身份**，两样都必须从那次
运行来、都必须压过屏幕。它散在四层（`scopeOf` 记 → `skillrun.contextOf` 存 →
`applyProposal` 读 → `planApply`/handler 用），**漏掉任何一层都无声**。我分三轮
才认全，而补端到端测试时又当场发现第三处断链：`contextOf` 的白名单把 `unitNo`
整个过滤掉了 —— 前两次修复其实都没生效，纯函数测试却全绿。

**两条被判为「自动化证不了」、按 ADR-0081 §2b 不再买轮的**：模型写出来的**内容**
是不是散文、真实模型输出的 schema 拒绝路径 —— 它们由 prompt 与 `reviewCriteria`
约束，归**真实 Connected Project 人工走查**（AGENTS.md §20）。结构那一半已经测到底：
两个包必填输入不同、`output.schema.json` 的 `required` 不同、两条应用路径互斥。

## 7. 还没在真实项目上被人看过的

**这是信息，不是闸门**（AGENTS.md §1）：

1. 在真实 Connected Project 里说「写这一章」，看它产出的**是不是小说**（散文而非
   剧本格式）、内容是不是这一章该发生的事；
2. 生成后切章再应用，确认正文落回原来那一章（自动化已覆盖，但没在真实界面上走过）；
3. 没打开章时的提示在界面上读起来是否真的可操作。
