# TASK-152：小说连着往下写 —— 若干章、可停、可改、不覆盖

- 状态：完成 · **实现完成（2026-09-18，开卡当日）**。两个独立事实，分开写（AGENTS.md §1）：
  1. **实现完成** —— 验收 §5 1–7 各有守卫（§6 的表），codex 两轮（轮 1 的 P1 / P2 修复，
     轮 2 判据全 `PASS`、架构全 `PASS`，剩一条纯证据缺口按协议补证收口，不再买轮）；
     代码级证据：`workflow/novelchain.js` · `storywork.chainTargets / previousWritten /
     chapterPlan.previous` · `server._conv_continuation` · `production.startNovelChain` ·
     `draftws.chainBar` · 能力包 v2。
  2. **还没在真实项目上被人看过的** —— §7 五条，尤其第 1 条：`previous` 进了提示词是
     自动化证明的，模型**真的接着写**只有真项目看得见。
- 起因：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」——
  编排后排在 REQ-009 主线上的下一片。· 闸：**放行（第 ① 问：在当前里程碑交付面上）**，
  里程碑就是 REQ-009「先把小说写出来」，切片一（TASK-146）已「实现完成」。
- 类型：Feature · 深度：**STANDARD**（U=STANDARD：「自动」的边界写成显式假设见 §2；
  I=STANDARD：只波及正文创作这一域与对话路由的一个字段；R=QUICK：每章一次版本化写入，
  `git revert` + 已有的版本历史即可退；C=STANDARD：`route` 新增一个**可选**字段、
  `chapterPlan` 新增一个**可选**子字段，都是加法）
- 成果物：本卡 · 提交 · REQ-009 切片表那一行（不建 ADR：结论几行写在 §2）
- 关联 Requirement：[REQ-009 v1 判据 4](../requirements/REQ-009-write-the-novel-first-then-film-it.md)
  「能连着往下写，也能停。他可以让它从当前进度连续写若干章；中途可停、可改，
  **已经写下的不会被重跑覆盖**」
- 架构约束：`CA §3`「对话里的能力路由」（模型无权指定 skillId；resolver 确定性）·
  `CA §5.2` 不静默覆盖 · `CA §4` 测试归属（studio / contract / 前端）· AGENTS.md §11/§12
  每步可独立执行、断点续跑 · §13 不静默覆盖 · ADR-0066 十一页闭集（不新增页面）
- L5 自动实施授权：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」
  —— 方向（REQ-009）与候选（在办卡按前置排序）已由用户确定，本卡是其中排第 2 的一项
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/TASK-148-l5`（复用，TASK-148 已收口），
  分支 `change/TASK-152-novel-chain`，基线 `main@f8aa842`

## 1. 这一片交付什么

他在一个**小说**项目里说「接着往下写 3 章」（或在「正文创作」里按一下「接着往下写」）
—— 从第一章没写正文的那一章开始，一章一章写下去：每一章都是一次普通的能力运行，
写完就落进那一章；已经写过正文的章**一律跳过**，不重跑、不覆盖；中途他可以按「停止」
（写完手上这一章就停），也可以在编辑器里改前面的章 —— 后面的章接着他改过的写。

切片一之后，「写这一章」只写他此刻打开的那一章，且一次一章。这一片把它连起来。

## 2. 架构决定（结论几行，理由在这里，不另开 ADR）

**每一章是一步，链只是「下一章是谁、什么时候停」。** 没有新的运行类型、没有新的
提案类型、没有新的写路径：一章 = `ctx.skills.run("novel-chapter-writer", {scope: {unitNo}})`
→ pending 提案 → `applyProposal(runId)` → `applyBodyProposal` 落进那一章。守卫、登记、
schema 校验、版本化，与他自己点一次运行**同一条路**（ADR-0067 决策 4 / TASK-146）。

- **链的状态活在页面内存里，不进持久化。** 进度就是「哪些章已经有正文」—— 那是
  文档里的事实；刷新、关标签页之后再说一次「接着写」，从进度接着来（AGENTS.md §12
  断点续跑：不重做已完成的章）。为链另存一份「写到第几章了」会与文档打架。
- **「已经写下的不会被重跑覆盖」靠三道**：① 下一章 = **此刻**第一章没正文的
  （每步现读，不用开链时的名单）；② 他中途自己写了的章跳过并记下，链**往后补足**
  「写几章」那个数 —— `count` 是要写几章，不是盯着哪几章（codex 轮 1 的 P2：截断过的
  名单跑完就停会少写一章）；③ **运行回来之后再查一次**：他在这一章跑着的时候自己写了它
  → 不应用、他的字一个不动，AI 那一版留在「能力」面板里当 pending 提案（`held`），用不用
  由他决定（codex 轮 1 的 P1：只在开跑前查一次，运行中写的会被盖掉）。
  `applyBodyProposal` 覆盖前存一版的那道兜底仍在，但这一片的语义是**不碰**，
  不是「覆盖但存一版」。
- **自动应用是这一片的定义，不是省一步。** 「连着往下写」的意思就是写完落进去再写
  下一章；每章仍是一次登记在册、可退回上一版、可改的写入（REQ-007 判据 3 不破）。
  他要逐章审的路径没变：说「写这一章」，一次一章、落成 pending 提案。
- **后面的章接着前面的写**：`chapterPlan` 新增可选子字段 `previous`
  `{no, title, tail}` —— 第 N 章之前**最近一章已有正文**的结尾 600 字。能力包
  prompt 多一句「接着它写，不重复、不矛盾」。这就是判据里「中途改了第 3 章，第 4、5 章
  接着他改过的写」成立的机制：第 4 章开跑那一刻读的是他改过之后的第 3 章。
  能力包 `skillVersion` 1 → 2（prompt 变了；ADR-0067：已被 Run 引用的版本不原地覆盖）。
- **「接着写几章」由服务端认，前端不读他的话。** resolver 已经能选中小说家
  （`selectWhen` 里有「接着写」）；这一片在 `_conv_check_route` 里对 `intent ==
  "chapter-writing"` 的计划多判一次 `_conv_continuation(goal)`：句子带「接着 / 继续 /
  往下 / 连着 / 连续 / 再写」→ `plan.continuation = {count}`，`count` 从「N 章」读
  （阿拉伯数字或一～十几），读不到 = 写到 Planned 为止。**前端只认 `route.continuation`
  这个字段**，不自己解析句子 —— 与 ADR-0091 决策 1 同一边界：前端不从用户文本推断执行什么。
  「写这一章」没有这些词，走的仍是切片一的单章路径。
- **resolver 要先选中小说家，`continuation` 才有地方挂。** 实测「接着往下写 3 章」在
  切片一的关键词下（`接着写`）**一个词都不命中** —— 「接着往下写」不含子串「接着写」——
  于是小说项目里这句话选中的是 `episode-planner`（0 命中时按优先级）。所以 `selectWhen`
  改成 `章 · 正文 · 小说 · 接着 · 往下写 · 继续写`（上限 6 个，`skillpkg` 硬限；超了整个包
  **不加载**，静默从目录里消失 —— 实施中撞到一次，`tests/studio` 15 条转红才发现）。
  「连着写」「再写两章」靠「章」命中；「一直写到底」不命中 → 选不中小说家，也就没有连写
  —— 记为 §7 的已知边界，不为它扩关键词表。
- **停 = 写完手上这一章就停。** 不中断正在跑的那一次运行：半章正文没有可落的地方，
  而运行本来就有自己的取消路径（`runtime.cancelRun`）。停止按钮在「正文创作」页的
  连写状态条上；对话里说「停」不在本片（见 §4）。
- **手工执行器不连写。** 链要的是能自动跑完的执行器（`routeExecutor` 选出的那个）；
  本机没有时说清楚，不退化成「建 N 条等他粘答案的运行」。

**显式假设（可逆，做出来给他看）**：「若干章」默认 = 到 Planned 为止；「从当前进度」
= 从第一章没正文的开始、**中间空着的章也补**（第 2 章空着、第 3 章写了 → 先写第 2）。
他要「只往后、不补空」再改。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | REQ-009 切片表那一行填上本卡 | REQ-009 v1 判据一条不改；REQ-007 一条不改 |
| UI | `draftws.js`：小说模式下多一条**连写状态条**（「接着往下写 [N] 章」· 进度 · 停止），页内、不加页面 | 十一页闭集 · 四入口 · 章选择器 / 二级 Brief / 编辑器 · 剧集模式的一切 |
| 数据 Schema | `chapterPlan` 新增**可选** `previous`；`route` 新增**可选** `continuation`；能力包 `skillVersion` 1→2、`selectWhen` 换成 6 个词、prompt 多一段；`tests/fixtures/skill-prompt-snapshots.json` 只刷新这一个包的两处 | `story.work` 持久化结构一个字段不加；`output.schema.json` 不改；提案 / 运行记录形状不改；其余 27 个包的基线一个字节不动 |
| Workflow | 无 | `episode-from-scratch` 等流程一个字节不动 |
| 测试 | 前端 `novelchain.test.mjs`（新）· `novelchapter.test.mjs`（`previous` / `chainTargets`）· `convroute.test.mjs`（`continuation` 透传）· `tests/studio/`（`_conv_continuation` 与挂接） | `tests/backend/` · `tests/e2e/` |
| docs | 本卡 · REQ-009 切片表 · STATUS 重生成 | CA §3 那一行不改（resolver 的输入没变，只是计划多了一个可选字段；跨层合同的形状写在本卡 §2） |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`storywork.chainTargets` / `previousWritten` / `chapterPlan.previous` ·
`workflow/novelchain.js`（链状态 + 驱动，纯逻辑）· `production.js` 的链驱动与按钮接线 ·
`draftws.js` 连写状态条 · `server.py` 的 `_conv_continuation` 与挂接 · `convroute.js`
透传 · 能力包 prompt 一句 + 版本号 · 上述测试。

**OUT OF SCOPE**：对话里说「停」（本片用页内按钮停）· 「写到第 N 章」这种以终点计的说法
（只认「N 章」的数量）· 中断正在跑的那一次运行 · 章节标题（切片三）· 小说 → 剧集
（切片四）· 任何会花钱的生成 · 链状态持久化。

## 5. 验收（对应 REQ-009 判据 4）

1. 小说项目里 Planned = 12、前 2 章有正文，说「接着往下写 3 章」→ 第 3、4、5 章依次
   被写出并落进各自那一章；第 1、2 章一个字不动。
2. 链跑着的时候他在第 5 章手写了几段 → 第 5 章被**跳过**（不覆盖），链接着写第 6 章，
   状态条说出「第 5 章已有正文，跳过」。
3. 按「停止」→ 手上这一章写完落地后链停下，状态条说停在哪；再按「接着往下写」从
   下一章没正文的继续，不重写已写的。
4. 第 N 章开跑时，能力拿到的 `chapterPlan.previous` 是第 N−1 章（或更早最近一章有正文的）
   **此刻**的结尾 —— 他中途改过的那一版。
5. 「写这一章」的行为一个字节不变：仍只写他打开的那一章，仍落成 pending 提案。
6. 剧集项目一个字节不变：`continuation` 只挂在 `chapter-writing` 的计划上。
7. 本机没有可自动跑的执行器时，连写拒绝并说清；不建手工运行。

## 6. 验证

影响范围 = 前端（storywork / novelchain / production / draftws / convroute）+ studio
（server resolver 挂接）+ contract（能力包基线）。按 AGENTS.md §20 跑这三个域；
全量留到里程碑集成检查点。

**实测（2026-09-18，codex 轮 1 修复后）**：`node --test` **2339 pass / 0 fail**
（+25：`novelchain.test.mjs` 21 条、`convroute.test.mjs` 4 条）· `pytest tests/studio
tests/contract` **988 passed / 16 skipped**（+21：`test_motv_novel_chain_task152.py`）·
`ruff check .` 通过 · `lifecycle_check` 0 finding。

验收 → 守卫：

| §5 | 守卫 |
| --- | --- |
| 1 三章依次落进各自那一章、已写的不动 | `novelchain.test.mjs`「三章依次写出…」（每次运行的章号 = 目标章号；应用的是那次运行的 runId）+「真 controller：三章各是一次登记在册的运行…」（真 `skillctl` / `skillrun` / `skillapply` / `applyBodyProposal`，run 记着 `unitNo`、应用后 accepted） |
| 2 链跑着时他写了下一章 → 跳过并**往后补足** | 「链跑着的时候他自己写了下一章 → 跳过它、不覆盖、往后补足章数」（写 3 章、第 2 章被他写了 → 写 1、3、4）·「没给数 = 写到计划内没正文的都写完…」 |
| 2′ 他在**正在写的那一章**里自己写了 → 运行回来不落地 | 「他在正在写的那一章里自己写了 → 运行回来不落地…」+「真 controller：…提案留在册上 pending，他的字一个不动」（AI 那一版 pending；他之后自己按「用它」才走覆盖前存一版的既有兜底） |
| 3 停 = 写完手上这一章；再来不重写 | 「停止在两章之间生效…」+ `chainTargets` 从进度接着算 |
| 4 `previous` 是此刻的结尾 | 「本章任务带着上一章此刻的结尾…」「接着的是最近一章有正文的…」+ 真 controller 那条断言第 2 章的**提示词里**有第 1 章结尾、第 3 章的里有刚落地的第 2 章 |
| 5 「写这一章」不变 | `test_a_single_chapter_in_a_novel_has_no_continuation` + TASK-146 全部 58 条仍绿 |
| 6 剧集侧不变 | `test_an_episode_project_never_gets_a_continuation` |
| 7 无自动执行器不连写 | `novelchain.readiness`：「连写只对小说成立，且要一个能自动跑完的执行器」「手工执行器不连写：一次运行都不起」；`production.startNovelChain` 起链前问的就是它 |
| 接线 | `convroute.test.mjs`「production.js 里连写走的是链…」（源码钉接线，与该文件既有的 `routeInflight` 守法一致） |

独立审查（codex，真 codex）：轮 1 **fail** —— 1 P1 + 1 P2 + 两条 `NOT_EVIDENCED`，全部成立、全部修了：

| 轮 1 报的 | 处置 |
| --- | --- |
| P1：只在开跑前查一次「有没有正文」，他在**运行进行中**写了这一章，回来的提案会盖掉它 | `runChain` 运行回来后再查一次：有他的字就不应用，AI 那一版留成 pending（`held`）；两条守卫（假件 + 真 controller） |
| P2：`count` 截断的名单跑完就停 —— 写 3 章、他自己写了第 5 章，链在第 4 章就停，少写一章 | `count` 改为「要写几章」，每步现读第一章没正文的往后补；守卫「…往后补足章数」 |
| `NOT_EVIDENCED` §5.7（手工执行器不连写） | 闸抽成 `novelchain.readiness`，两条守卫；`startNovelChain` 调它 |
| `NOT_EVIDENCED` REQ-007 判据 3（提案登记 / 版本 / 可退） | 两条真 controller 测试：run 记 `unitNo`、应用后 accepted；被跳过的留 pending，他自己「用它」时旧版被存成一版 |

轮 2（P1 修复后复审一次）：判据 §5.1–5.7 全 `PASS`，CA §3 / §5.2 / §4、ADR-0091 / 0066 /
0067 全 `PASS`；剩**一条** `NOT_EVIDENCED`（REQ-007 判据 3：只断言有一条历史记录，没有
恢复并核对原文）。按 ADR-0081 / 本仓库审查协议，纯证据缺口 = 补证据 + 跑归属域收口，
**不买第三轮**。补的：① 被跳过的那一章他「用它」之后 `restoreFinalized` 回他的原文并逐字
核对；② 新增「连写落下的章照旧版本化、可退回」—— 链写进空章时没有旧版可存（空 ≠ 一版，
与单章路径一致），之后被别的提案覆盖时先存一版（note 含「覆盖前」），恢复后正文与连写
落下的一字不差；且那次运行有 `proposalId` 可指认。`novelchain.test.mjs` 22 条全绿。

## 8. Merge Gate（2026-09-18，ADR-0085：依据是 Done 判定 + 最终全量）

| 前置 | 证据 |
| --- | --- |
| Done 判定 | §5 验收 1–7 各有守卫（§6 表）；codex 两轮，轮 2 判据全 `PASS`、架构全 `PASS`、0 BLOCKING 代码缺陷，剩项按协议补证收口 |
| 最终全量 | 树 `ad33672`（代码最后一次改动）：pytest 并行 **4283 passed / 60 skipped**（8:34）· 串行 **6 passed** · `ruff check .` 全过；`4a1a3d1`（只加测试与文档）上前端全量 **2340 pass / 0 fail**、提交闸门 frontend 档 5 项检查过 |
| 待复审清单 | `docs/design/active/pending-codex-rereview.md` 待复审表 0 条未闭合 |
| 未闭合 P1 | 无 |
| 分支形状 | `change/TASK-152-novel-chain` 基于 `main@f8aa842`，一条直线，可 ff |

依据不是用户原话，是上面这些都成立；Gate 绑在 `4a1a3d1` 之后的收口提交 tip 上。

## 7. 还没在真实项目上被人看过的

> **2026-09-18 真实运行时走查（第 1 条已闭合）。** 用应用自己的执行器代码
> （`server._run_executor`，同一 argv `claude -p --tools ""`、同样走 stdin）把
> `novel-chapter-writer` v2 的**真实提示词**跑在真 claude 上（114s，2977 字），答案过
> 前端真正的校验器（`skills.readSkillAnswer` → schema **PASS**）、`planApply` →
> `proposeScript`、`applyBodyProposal` 落进第 2 章 2362 字。
>
> **判据 4 的那一半（`previous` 真的被用上）当场看得见**：喂进去的上一章结尾是
> 「…档案馆的**灯灭了**。走到门口她才发现，**值班表**上自己的名字也不见了」；模型写的
> 这一章开头是「林照在门檐下站了很久，**灯没有再亮**。**值班表**还挂在门内侧…第三行第二格
> 是空的」「外套内袋里那本**簿子**硌着肋骨」—— 接的是那一刻，不是从头讲起。
>
> **仍未被看过**：整条链在**浏览器里**按那个按钮跑一遍，以及「写得好不好」的审美判断。
> 走查用的是合成小说项目，没碰产品负责人的真实作品。

**这是信息，不是闸门**（AGENTS.md §1）：

1. 在真实 Connected Project 的小说项目里说「接着往下写 3 章」，看三章是否真的依次
   落进第 N、N+1、N+2 章，且第 N+1 章的开头接得上第 N 章的结尾（`previous` 有没有被
   模型真的用上 —— 自动化只能证明它进了提示词）。
2. 状态条在真实界面上的读感：「连写中：正在写第 4 章（1/3）」、停止后那一句。
3. 「一直写到底」这种不含 `章 / 接着 / 往下写 / 继续写` 的说法选不中小说家（§2 已记）。
4. 手工执行器下按「接着往下写」得到的那句拒绝，是否真的能照着做。
5. `startNovelChain` / 按钮接线是 DOM 绑定代码，只有源码级守卫；链的规则本身在
   `novelchain.js` 有 15 条行为测试。
