# TASK-155：一本小说变成一部剧集 —— 分集提案、确认后进入剧集创作、接上已有的视频线

- 状态：完成 · **实现完成（2026-09-18，开卡当日）**。两个独立事实，分开写（AGENTS.md §1）：
  1. **实现完成** —— §5 验收 1–7 各有守卫（§6 的表）；codex 两轮（轮 1 两条 P2 + 一条可测性
     BLOCKING 全修，轮 2 **pass**：判据 5、6 与 §5.1–5.7 全 `PASS`、架构全 `PASS`、Verification
     `SUFFICIENT`、0 finding）。代码级证据：`workflow/noveladapt.js`（整步）· `storywork.
     novelChaptersForPrompt / checkChapterRanges / adoptEpisodesFromNovel` · `storydoc.addPlanVersion` ·
     新包 `novel-adapter` · `skillapply` / `actions` 的 `adaptNovelToEpisodes` · `skillctl.context.novelChapters`。
  2. **还没在真实项目上被人看过的** —— §7 五条，尤其第 1、2 条：章区间与每集目标是否真来自那几章、
     三处（剧集创作 Brief / 剧集制作 / 编剧上下文）在真实界面上是否对得上。
- 起因：REQ-009 切片表的第四片（最后一片）；产品负责人 2026-09-18「对这些任务进行编排然后
  一个个完成」之后按里程碑闸排出的下一项。· 闸：**放行（第 ① 问：在当前里程碑交付面上）**。
- 类型：Feature · 深度：**STANDARD**（U=STANDARD：「确认」是哪一步写成显式假设见 §2；
  I=STANDARD：正文创作 + 剧集规划 + 生产文档三处，都是既有写路径；R=QUICK：全是加法 ——
  规划多一版、剧集追加、小说一字不动，`git revert` / 改回小说创作即可；C=STANDARD：一个新的
  可选上下文键、一个新能力包、一个新 action、规划条目多一个可选字段 `chapters`）
- 成果物：本卡 · 提交 · REQ-009 切片表那一行（不建 ADR：结论几行写在 §2）
- 关联 Requirement：[REQ-009 v1 判据 5、6](../requirements/REQ-009-write-the-novel-first-then-film-it.md)
  —— 5「**一本小说能变成一部剧集。** 产出『哪一集对应哪几章』的分集提案，他确认后进入剧集创作；
  转换是**加法**，原小说正文与版本历史一个字不动」· 6「**转过去之后接的是已有的视频线。**
  剧本 → 拆解 → 基础资产 → 分镜 → 生成，不为小说另建一条平行生产链，不新增一级或二级页面」
- 架构约束：`CA §3`（模型无权指定 skillId）· `CA §5.2` 不静默覆盖 · `CA §4` 测试归属 ·
  ADR-0066 十一页闭集 · ADR-0067 包版本 · ADR-0072 决策 1（剧集身份由文档派生，不从答案读回）
- L5 自动实施授权：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/TASK-148-l5`，分支 `change/TASK-155-novel-to-episodes`，
  基线 `main@a49a84c`

## 1. 这一片交付什么

小说写完（或写到一半）之后，他在对话里说「把它做成剧集」→ 得到一份**分集提案**：每一集
对应第几章到第几章、这一集的核心目标 / 主要剧情 / 结尾拍 / 钩子。他按「用它」→ 剧集规划
多一版并被确认、生产文档里建出这几集、正文创作切到「剧集创作」且每一集的二级 Brief 写着
「改编自第 X–Y 章」—— 然后就是已有的那条线：写这一集的剧本 → 拆解 → 资产 → 分镜。
小说的章、正文、版本历史一个字不动。

## 2. 架构决定（结论几行，理由在这里，不另开 ADR）

- **提案由一个新包写：`novel-adapter`（分集改编）。** 输入 `novelChapters`（新可选上下文键：
  已写正文的章 —— 章号、标题、字数、开头几百字、结构规划里这一章的目的与 Ending State）+
  `brief / outline / characters / workForm`；输出与 `episode-planner` 同一族的分集条目，**多一个
  `chapters: {from, to}`**。不复用 `episode-planner`：它读的是大纲，不知道正文写到哪、每章
  真写了什么，「哪一集对应哪几章」它答不出。`form: "novel"`：剧集项目里它根本不出现。
- **「确认」= 在「能力」面板按「用它」。** 旧的分集规划提案面板（`renderPlanPanel`）住在
  未进十一页闭集的旧工作区里，把提案落到那里等于落到他看不见的地方。所以「用它」一步做完：
  ① 规划**追加一版**（`storydoc.addPlanVersion`，`origin: "adapted"`，条目带 `chapters`）并确认
  （走既有的 `confirmPlan`：建剧集、认领洁净的默认第 1 集、盖上游基线）；② `work.form` 切到
  `episode`、`planned.episode = N`、每一集建一个单元、二级 Brief 写「改编自第 X–Y 章：核心目标」
  （`storywork.adoptEpisodesFromNovel`）。全是**加法**：小说单元与版本一字不动，规划旧版保留，
  剧集只追加。
- **不覆盖已有的剧集线。** 生产文档里已有非洁净的剧集（有场景 / 剧本 / 不止一集）时**拒绝**并
  说清 —— 改编是给「小说先写出来」的项目用的；已经在做剧集的项目，往里塞一套新集号会让
  单元 ↔ 剧集的按位对应（`produceEntry` 按 `eps[no-1]`）错位。判据 5 说的是加法，不是合并。
- **路由**：facade `story-development` + `episode-production`（他既可能在开发故事时说、也可能在
  正文创作页说）；intent `novel-adaptation`（新加进词表：同 facade 下 intent 不得重复）；
  priority 85 > `episode-planner` 的 70 —— 小说项目里「分几集、每集讲什么」两者都命中「分集」，
  按优先级落改编；剧集项目里改编包被 `form` 排除，`episode-planner` 照旧（TASK-119 不变量）。
- **接上视频线靠既有身份**：确认时 `confirmPlan` 给每条规划条目盖 `episodeId`，`skillctl.context`
  的 `episodePlan` 按 `activeEpisodeId` 取那一条 —— 编剧读到的就是这一集的核心目标 / 主要剧情 /
  钩子（从小说派生），`chapters` 跟着条目走。不为小说另建第二条链。

**显式假设（可逆）**：「确认」就是「用它」那一下（不再有第二道确认）；改编只在剧集线洁净时
可用；剧本改编时编剧读的是规划条目，不直接读整章正文（那是下一步要不要做的事，见 §7）。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | REQ-009 切片表那一行填上本卡 | REQ-009 判据一条不改 |
| UI | 无新控件（对话驱动；结果落在正文创作 · 剧集创作 + 生产文档） | 十一页闭集 · 正文创作页 · 剧集制作页 |
| 数据 Schema | `skill-inputs.json` +`novelChapters`；新包三件套；`actions.js` +`adaptNovelToEpisodes`；规划条目多可选 `chapters`（`sanitizePlanEpisodes` 的 `{...e}` 本来就让未知字段过；plan 版本 `origin` 多一个值 `adapted`） | `story.work` 结构一字段不加；小说单元 / 版本形状不变；生产文档形状不变 |
| Workflow | 无 | `episode-from-scratch` |
| 测试 | 前端 `noveladapt.test.mjs`（新）· studio `test_motv_novel_adapter_task155.py`（新）· contract 基线加一条 | `tests/backend` · `tests/e2e` |
| docs | 本卡 · REQ-009 切片表 · STATUS 重生成 | CA §3 那一行不改 |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`novelChapters` 上下文键 · `novel-adapter` 包 · `adaptNovelToEpisodes` 的翻译与落地
（`addPlanVersion` + 既有 `confirmPlan` + `adoptEpisodesFromNovel`）· 洁净剧集线的判定与拒绝 ·
intent 词表 · 上述测试与基线。

**OUT OF SCOPE**：编剧直接读整章正文改编（现在读规划条目）· 把改编合并进已有剧集线 · 任何
界面改动 · 旧分集规划面板的复活 · 会花钱的生成。

## 5. 验收（对应 REQ-009 判据 5、6）

1. 小说项目里说「把它做成剧集」/「分几集、每集讲什么」→ resolver 选中 `novel-adapter`；剧集项目
   里同一句仍选中 `episode-planner`。
2. `novelChapters` 只含**已写正文**的章，带章号 / 标题 / 字数 / 开头 / 结构规划里的目的与结尾状态；
   没写正文的项目 → `null`（必填输入缺 → 运行前拒绝并说清）。
3. 「用它」之后：规划多一版（`origin: "adapted"`，每条带 `chapters`）且被确认；生产文档里每集一个
   剧集实体、规划条目带 `episodeId`；`work.form === "episode"`、`planned.episode === N`、每集一个单元、
   Brief 写着「改编自第 X–Y 章」。
4. **加法**：小说单元的数量、正文、版本历史与改编前逐字节相等；规划旧版仍在。
5. 生产文档里已有非洁净剧集 → 拒绝，一处都不动。
6. 提案里没有一集、或有一集缺 `chapters` / 章号越界 → 拒绝。
7. 确认后 `episodePlan`（编剧的上下文）拿到的是这一集从小说派生的条目 —— 视频线不另起。

## 6. 验证

影响范围 = 前端（storywork / storydoc / skillapply / skillctl / app handler）+ studio（resolver）+
contract（基线）。跑这三个域；全量留到里程碑集成检查点。

**实测（2026-09-18）**：`node --test` **2367 pass / 0 fail**（+11：`noveladapt.test.mjs`）·
`pytest tests/studio tests/contract` **1021 passed / 16 skipped**（+10：
`test_motv_novel_adapter_task155.py`）· `ruff check .` 通过 · `lifecycle_check` 0 finding ·
目录 30 个包全部加载。

验收 → 守卫：

| §5 | 守卫 |
| --- | --- |
| 1 小说项目「把它做成剧集」/「分几集、每集讲什么」/「改编成剧集」/「拍成短剧」→ `novel-adapter`（两个 facade）；剧集项目仍 → `episode-planner`；「写这一章」仍 → 小说家 | studio `test_a_novel_project_gets_the_adapter`（4 说法 × 2 facade）· `test_an_episode_project_still_gets_the_episode_planner` · `test_writing_a_chapter_still_goes_to_the_novelist` |
| 2 `novelChapters` 只含已写正文的章；没写 → null → 必填缺 | 前端「只喂已写正文的章…」「不是小说、或一章都没写 → null」「真 controller：一章都没写时…必填输入缺；写了之后提示词带着章节」 |
| 3 「用它」之后：规划追加一版（`adapted`，带 `chapters`）；`form === episode`、Planned、每集一个单元、Brief「改编自第 X–Y 章」 | 前端「addPlanVersion：追加一版…」「采纳分集：切到剧集创作…」「真 controller：运行 → 提案 → 应用…」；建剧集实体那一步走既有 `confirmPlan`（`app.js`，见 §7） |
| 4 加法：小说逐字节不动、规划旧版仍在 | 「采纳分集…小说逐字节不动」（JSON 快照相等）·「addPlanVersion…旧版保留」·「已有的剧集单元只补空 Brief，不覆盖他写的」 |
| 5 剧集线非洁净 → 拒绝 | `noveladapt.episodeLineIsPristine`；「整步：剧集线不洁净（有场景 / 有剧本 / 不止一集 / 改过名）→ 拒绝，一处都不动」 |
| 3′ 剧集实体、身份、确认、当前集 | 「整步：认领洁净的第 1 集、追加其余、规划确认并盖上身份、第一集成为当前集…」「空的剧集线也算洁净：全部新建」 |
| 7′ 编剧上下文 | 真 controller 测试：`ctl.context("script-writer").episodePlan.chapters === {from:1,to:2}` |
| 6 空提案 / 缺章区间 / 越界 → 拒绝 | 「章区间：连续、不重叠、都是写了的章才过；错在哪一集说得出」「改编提案翻译成…缺章区间 / 空提案拒绝」「真 controller：引用了没写的章的提案落不下去，一处都不动」 |
| 7 编剧上下文接的是这一集的条目 | `confirmPlan` 给条目盖 `episodeId`，`skillctl.context.episodePlan` 按 `activeEpisodeId` 取 —— 既有路径，未新增代码 |

独立审查（codex，真 codex）：轮 1 **fail** —— §5.3 `FAIL`、§5.5 / §5.7 / 判据 6 `NOT_EVIDENCED`、
3 条 BLOCKING，全部成立、全部修了：

| 轮 1 报的 | 处置 |
| --- | --- |
| P2：`checkChapterRanges` 放过漏掉尾巴上已写章的提案（写到第 3 章、提案只到第 2 章） | 加「最后一集必须到已写的最后一章」；守卫一条 |
| P2：`adoptEpisodesFromNovel` 用 `Math.max` 保留旧的更大 Planned，与「= N」矛盾 | 改为 `setPlanned(N)`；守卫一条 |
| 洁净判定与 `confirmPlan` 那一步住在 `app.js`，测试的 dispatch 绕过了它们，证不了剧集实体、身份与下游 `episodePlan` | 整步抽成 `workflow/noveladapt.js::adaptNovel`（洁净判定 → 章区间 → 追加规划 → 认领 / 新建剧集实体并盖身份 → 确认 → 第一集设为当前 → 单元与 Brief），`app.js` 只给三样 DOM 侧才有的东西（有没有剧本文本、盖基线、persist）；新增 4 条整步测试（真 `proddoc` + 真 `storydoc`）+ 真 controller 测试断言 `ctl.context("script-writer").episodePlan` 取到从小说派生、带 `chapters` 的那一条 |

实施中撞到：「分几集」**不含**子串「分集」，第一版关键词在小说项目里漏掉了这句最常见的说法
（`episode-planner` 靠「每集」赢）—— 把「每集」加进 `selectWhen`，两包同分时 priority 85 定
胜负；剧集项目里改编包被 `form` 排除，不受影响。

## 8. Merge Gate（2026-09-18，ADR-0085：依据是 Done 判定 + 最终全量）

| 前置 | 证据 |
| --- | --- |
| Done 判定 | §5 验收 1–7 各有守卫；codex 轮 2 pass，0 finding |
| 最终全量 | `5ef8867`（含 `skillpkg.py` / 包 / 前端改动）提交闸门 **full 档 7 项检查**全过（两阶段 pytest + 全量前端 + ruff 等）；`d4205ce` 只改前端 + 测试 + 卡，frontend 档 5 项检查过，`node --test` **2372 pass / 0 fail**，`pytest tests/contract` 268 passed |
| 待复审清单 | 0 条未闭合 |
| 未闭合 P1 | 无 |
| 分支形状 | `change/TASK-155-novel-to-episodes` 基于 `main@a49a84c`，一条直线，可 ff |

## 7. 还没在真实项目上被人看过的

> **2026-09-18 真实运行时走查（第 1 条部分闭合）。** `novel-adapter` 的真实提示词跑在真
> claude 上（36s），答案过 schema **PASS** → `adaptNovelToEpisodes`；四章切成两集
> （EP1 = 第 1–2 章、EP2 = 第 3–4 章），`checkChapterRanges` **通过** —— 连续、不重叠、
> 覆盖到最后一章，正是 §5.6 那条校验要的形状。
>
> **仍未被看过**：浏览器里按「用它」之后三处（剧集创作 Brief / 剧集制作 / 编剧上下文）
> 对不对得上，以及分集切得好不好。走查用的是合成小说项目。

**这是信息，不是闸门**（AGENTS.md §1）：

1. 真实小说项目里说「把它做成剧集」→ 看提案的章区间是否合理、每集的核心目标是否真来自那几章。
2. 按「用它」之后，正文创作 · 剧集创作页每集的 Brief、剧集制作页里的集、「写这一集的剧本」拿到的
   规划条目 —— 三处是否对得上（自动化证了前两处的数据层；第三处是既有路径）。
3. `app.js` 的 handler（洁净判定 + `addPlanVersion` + `confirmPlan` + `adoptEpisodesFromNovel`）是
   DOM 侧，只有 storywork / storydoc 层的行为测试；`confirmPlan` 建剧集实体那一步在本卡没有新测试。
4. 编剧改编时只读规划条目，不读整章正文 —— 要不要把章正文喂给编剧是下一步（§4 OUT OF SCOPE）。
5. 无形态的旧项目里「分几集」现在会选中改编包（`form` 为空不过滤）；它的必填输入 `novelChapters`
   缺 → 运行前被拒并说「先写正文」—— fail-closed，但那句话对一个剧集项目读起来会奇怪。
