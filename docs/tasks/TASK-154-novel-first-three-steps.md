# TASK-154：小说的前三步也能让 AI 来 —— 故事核心 / 大纲 / 结构规划在小说语境下成立

- 状态：进行中 · **实施中**（2026-09-18 开卡，同日开工）
- 起因：REQ-009 切片表的第三片；产品负责人 2026-09-18「对这些任务进行编排然后一个个完成」
  之后按里程碑闸排出的下一项。· 闸：**放行（第 ① 问：在当前里程碑交付面上）**。
- 类型：Feature · 深度：**STANDARD**（U=STANDARD：「在小说语境下成立」写成三件可验的事
  见 §1；I=STANDARD：故事开发四页那一域 + 对话路由多一个候选；R=QUICK：每次落地都先存一版；
  C=STANDARD：两个新的**可选**上下文键、一个新能力包、一个新 action —— 全是加法）
- 成果物：本卡 · 提交 · REQ-009 切片表那一行（不建 ADR：结论几行写在 §2）
- 关联 Requirement：[REQ-009 v1 判据 3](../requirements/REQ-009-write-the-novel-first-then-film-it.md)
  「**每一步都能让 AI 做，也都能被他改。** 故事核心 → 大纲 → 结构规划 → 章节正文，四步都有
  『让 AI 来』的路径；产出一律是提案，照旧过 schema、照旧版本化、照旧可退回」
- 架构约束：`CA §3`「对话里的能力路由」（模型无权指定 skillId；resolver 确定性）· `CA §5.2`
  不静默覆盖 · `CA §4` 测试归属 · ADR-0067（包版本不原地覆盖）· ADR-0066 十一页闭集 ·
  AGENTS.md §13
- L5 自动实施授权：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」
  —— 方向（REQ-009）与候选已由用户确定，本卡是切片二之后的下一项
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/TASK-148-l5`，分支 `change/TASK-154-novel-steps`，
  基线 `main@6c627af`

## 1. 这一片交付什么

2026-09-14 实测：四步里只有**第四步**（章节正文，TASK-146）和大纲的一半有 AI 路径 ——
「开发故事」选中 `story-development`，提案落进**故事大纲**页；**故事核心**页没有 AI 写它的
路径（提案里那句 `storyCore` 只被拼进大纲第一段）；**结构规划**那张九列的表**只能手填**；
而且 `story-development` 的提示词自称「短剧编剧」、按「集」思考 —— 一个小说项目拿到的是
一份短剧大纲。

这一片之后，在一个**小说**项目里：

1. 说「帮我把这个想法发展成故事」→ 故事核心页有了 AI 写的那一句（他的原稿先存一版），
   大纲页有了按**章**思考的小说大纲，提示词里不再有「短剧 / 集」的用语。
2. 说「帮我做结构规划」→ 结构规划表被 AI 填出**每章一行**（九列都写、引用了大纲 §N），
   原有的行先存一版、软删除可拿回。
3. 剧集项目同样两句话仍然可用：核心 / 大纲按「集」；结构规划每集一行；「分几集、每集讲什么」
   仍走 `episode-planner`，一个字节不变。

## 2. 架构决定（结论几行，理由在这里，不另开 ADR）

- **形态是上下文，不是第二个包。** 新增可选上下文键 `workForm`（`{form, word, planned}`），
  由 `skillctl.context` 从 `story.work` 报（与 `chapterPlan` 同源）；`story-development` 与
  新包声明它为**可选**输入，提示词按它切换用语（小说：按章、章数；剧集：按集、集数；缺省按剧集
  —— 旧的 `/api/agent/story-develop` 端点不传它，行为不变）。不为小说另建一个 `novel-outline`
  包：那会让「故事是什么」有两份定义，而故事本身不因形态而不同，变的只是它将被怎么切开。
- **故事核心有自己的家。** `proposeOutline` 落地时，`storyCore` 除了照旧作为大纲第一段，还写进
  `work.core`（有原稿先 `finalizeDoc("core")` 存一版）。不删大纲里那一段：结构规划的
  `§N` 引用按段计数，抽掉第一段会让既有引用集体错位。
- **结构规划由一个新包写：`structure-planner`（结构策划）。** 输入 `outline`（必填）+
  `brief / characters / world / workForm / structurePlan`（可选，`structurePlan` = 当前表，
  让「改一改」有基底）；输出 `rows[]`，九列**严格对应** `PLAN_COLUMNS`，`outlineRefs` 用
  `§N`（1 起）指大纲段落 —— 模型读不懂节点 id（TASK-146 同一条理由）。落地
  `storywork.applyPlanProposal`：有可见行先 `finalizeDoc("plan")` 存一版 → 旧行**软删除**
  （回收区可拿回，与手删同一条路）→ 新行按 `sanitizeRow` 进表，`§N` 解析成节点 id，越界的
  引用丢掉并**说出来**。不复用 `episode-planner`：它写的是旧「分集规划」文档（`storydoc`），
  不是这张表；把它的 `keyEvents / hook` 硬映射进九列是有损翻译，且会让「分集」在两个页面
  各有一份真相。
- **路由**：`structure-planner` 挂 `story-development` 用户能力，`selectWhen`
  `结构规划 · 结构表 · 每章 · 分章 · 章节规划 · 规划表`（≤ 6，`skillpkg` 硬限）。**不含**
  `分集 / 每集 / 集数`，所以「分几集、每集讲什么」照旧落 `episode-planner`（TASK-119 那条
  测试仍绿）。不声明 `form`：剧集项目的结构表同样该能让 AI 填。
- **版本**：`story-development` 3 → 4（提示词变了），`episode-from-scratch` 流程的引用同步改
  （ADR-0067）。基线 `skill-prompt-snapshots.json` 刷两处 + 加新包一条。

**显式假设（可逆）**：AI 填结构表 = **整表替换**（旧行进回收区、整表存一版），不做逐行
合并 —— 「改第 3 行」这种局部修订留给他手改或下一片；剧集项目的结构表也走同一个包。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | REQ-009 切片表那一行填上本卡 | REQ-009 判据一条不改；REQ-007 一条不改 |
| UI | 无新控件（对话驱动；结果落在既有三页） | 十一页闭集 · 四入口 · 三页的编辑器 / 定稿条 / 历史 |
| 数据 Schema | `skill-inputs.json` +`workForm` +`structurePlan`；新包三件套；`actions.js` +`proposePlanRows`；`story-development` v4 | `story.work` 持久化结构一个字段不加（行 / 版本 / 回收区都是既有形状） |
| Workflow | `episode-from-scratch` 里 `story-development` 的版本号 3 → 4 | 步骤序列不变 |
| 测试 | 前端 `structureplan.test.mjs`（新）· studio `test_motv_structure_planner_task154.py`（新）· contract 基线刷新 | `tests/backend` · `tests/e2e` |
| docs | 本卡 · REQ-009 切片表 · STATUS 重生成 | CA §3 那一行不改（resolver 机制没变，多一个候选包） |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`workForm` / `structurePlan` 两个上下文键 · `story-development` 提示词的形态
分支 + v4 · `storyCore` 落进 `work.core` · `structure-planner` 包 · `proposePlanRows` 的翻译与
落地（`applyPlanProposal`）· 上述测试与基线。

**OUT OF SCOPE**：结构表的逐行修订能力 · 任何界面改动 · 旧 `/api/agent/story-develop` /
`episode-plan` 端点的行为 · 小说 → 剧集转换（切片四）· 会花钱的生成。

## 5. 验收（对应 REQ-009 判据 3）

1. 小说项目里 `story-development` 的提示词带着「作品形态：小说 / 按章 / 章数」那一块数据，
   指令给出小说分支（按章、`episodeCount` 表示章数、`revealAround` 写第几章）；指令正文
   不再自称短剧编剧，凡举例都按形态写两种（「第 7 章前后」或「第 7 集前后」），没有只按集
   写的无条件句。（**订正**，codex 轮 1：原写「不含『集』的用语」—— 一个包一份指令，
   两个分支必然都在文本里；能做到的是无条件句一律形态中立，分支各说各的。）
   剧集项目里仍按集。
2. `proposeOutline` 落地：`work.core` = `storyCore`，他的原核心先存成一版且可恢复；大纲照旧
   落进 `work.outline`。
3. 小说项目说「帮我做结构规划」→ resolver 选中 `structure-planner`；「分几集、每集讲什么」
   仍选中 `episode-planner`。
4. `structure-planner` 的提案落地：九列一行不少、`§N` 解析成节点 id、越界引用被丢并说出；
   原有行先存一版、进回收区、可拿回。
5. 提案里 `rows` 为空 → 拒绝，不落一张空表。
6. 剧集项目走同一条路，结果按集。

## 6. 验证

影响范围 = 前端（storywork / skillapply / skillctl / app 的 action handler）+ studio（resolver）
+ contract（包基线）。跑这三个域；全量留到里程碑集成检查点。

**实测（2026-09-18）**：`node --test` **2351 pass / 0 fail**（+11：`structureplan.test.mjs`）·
`pytest tests/studio tests/contract` **1005 passed / 16 skipped**（+17：
`test_motv_structure_planner_task154.py`）· `ruff check .` 通过 · `lifecycle_check` 0 finding。

验收 → 守卫：

| §5 | 守卫 |
| --- | --- |
| 1 小说项目的提示词带「作品形态：小说 / 按章」，正文不再自称短剧 | studio `test_the_novel_form_reaches_the_compiled_prompt` · 前端「真 controller：小说项目里 story-development 的提示词带着…」（看的是 `<数据 键="workForm">` 数据块；没选形态时那一块不出现 —— 与旧端点缺省一致） |
| 2 `storyCore` 落进 `work.core`，原稿先存一版可恢复；大纲照旧 | 前端「核心提案写进 work.core…恢复得回去」「空的核心提案不落」「大纲提案落地：大纲按段进编辑器，核心同时落进自己的家；两处都先存一版」「真 controller：小说项目里跑 story-development → 提案 → 应用…」；`app.js` 的 `proposeOutline` 只剩调 `applyOutlineProposal` + persist + 重绘 |
| 3 「帮我做结构规划」→ `structure-planner`；「分几集、每集讲什么」仍 → `episode-planner` | studio `test_structure_planning_lands_on_the_structure_planner`（3 说法 × 3 形态）· `test_episode_splitting_still_goes_to_the_episode_planner` · TASK-119 全部仍绿 |
| 4 九列进表、`§N` 解析、越界丢并说出、旧行存一版进回收区可拿回 | 前端「九列一行不少地进表…」「他手填的行先存一版并进回收区…」 |
| 5 空表拒绝 | 前端「一行都没有的提案拒绝」「结构策划的提案翻译成 proposePlanRows；空表拒绝」 |
| 6 剧集项目走同一条路 | studio 参数化 `form=episode/""` 三说法全中；`formForPrompt` 剧集 → 集 |
| 加载 | studio `test_the_structure_planner_loads…`（`selectWhen` ≤ 6、intent 在词表里 —— 两条实施中都撞过一次） |

独立审查（codex，真 codex）：轮 1 **fail** —— §5.1 `FAIL`、三条 `NOT_EVIDENCED`、4 条 BLOCKING，全部成立、全部修了：

| 轮 1 报的 | 处置 |
| --- | --- |
| §5.1 写「不含『集』的用语」，而指令里两个分支都在，且三处无条件句只按集写 | 判据订正（一个包一份指令；能做到的是无条件句形态中立）；三处改中立：「第 7 章前后」或「第 7 集前后」/ 规模：小说是章数、剧集是集数 / 单章篇幅 · 单集时长；两侧守卫断言旧写法不在 |
| `formForPrompt` 在 Planned 没定时给 `planned: 0`，提示词照字面会规划零行而 schema 至少一行 | 没定 → `null`；提示词「正整数就取它；为空按故事量取；至少一行」；守卫一条 |
| schema `maxItems: 60` 与 `planned ≤ 500` 冲突 | 60 → 500 |
| 测试的 `dispatchAction` 只回 `ok:true`，证不了核心 / 大纲 / 表真的落地 | 落地逻辑搬进 `storywork.applyOutlineProposal` 等（`app.js` handler 剩三行），测试的 dispatch 真调它们；补 4 条：大纲提案落地（核心 + 大纲 + 两处存一版）· 丢弃引用的提示 · 真 controller 剧集结构表 · 真 controller 小说大纲与核心 |

实施中撞到、值得记的：① `internalRouting.intent` 是**闭集**（`skillpkg._ROUTING_INTENTS`），
新意图要先进词表，否则整个包静默不加载；② 同一 facade 下两个包**不得共用 intent**
（`test_no_two_candidates_in_one_capability_share_an_intent`）—— 借 `episode-structure`
不行，所以加了 `structure-plan`；③ `skillctl` 的 `storywork` 是可选注入，旧测试装具不给它，
新上下文键要判空。

## 7. 还没在真实项目上被人看过的

**这是信息，不是闸门**（AGENTS.md §1）：

1. 在真实小说项目里说「帮我把这个想法发展成故事」，看故事核心页那一句、大纲页是否真的
   按**章**在说话（自动化只证明形态进了提示词）。
2. 说「帮我做结构规划」，看 AI 填出的九列在表里读起来是否可用、`§N` 引用是否指对了段。
3. `proposeOutline` / `proposePlanRows` 两个 handler 住在 `app.js`（DOM 侧），只有
   `storywork` 那一层的行为测试；handler 本身是「调函数 + persist + 重绘」三行。
4. 「把大纲分章」这句会同时命中「大纲」与「分章」，按优先级落到 `story-development`
   （不是结构策划）—— 说法上的边界，记在这里，不为它调优先级。
