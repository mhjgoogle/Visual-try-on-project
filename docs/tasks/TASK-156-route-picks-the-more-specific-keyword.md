# TASK-156：命中更具体的那个词就该赢 —— 「请填充内容」在结构规划页落到了别的能力

- 状态：完成 · **实现完成（2026-09-18，开卡当日）**。两个独立事实，分开写（AGENTS.md §1）：
  1. **实现完成** —— §5 验收 1–6 各有守卫（§6 的表）；codex 两轮：轮 1 三条 BLOCKING 全修
     （其中一条逼出了排序顺序本身的订正），轮 2 **四闸全 `PASS`、0 BLOCKING**，`VERDICT: pass`。
     代码级证据：`server._conv_specificity` 与排序键 · `ADR-0106`（部分取代 ADR-0091 决策 2，
     双向链接）· `tests/studio/test_motv_route_specificity_task156.py`（11）·
     `tests/contract/test_motv_route_to_apply_task156.py`（3）。
  2. **还没在真实项目上被人看过的** —— §7：他要在真实项目上再说一次「请填充内容」，
     看结构规划表是否真的被填上（自动化只证到「选对能力」+「这个能力写得回那张表」）。

> **轮 2 的 `GATE_CONSISTENCY: inconsistent` 是误报，按 codex-review-loop hard-stop (a) 记录
> 反驳、不当成发现**：扫描区间里唯一的 `PARTIAL` 族词，是审查者散文里的
> 「Explicit **partial** supersession is bidirectional」，而那一行的判词是 `PASS`
> （`-match` 大小写不敏感、`-` 算词边界）。全文没有任何一条闸给出非 PASS 判词，
> `BLOCKING: (none)`。同一族误报的第二次，已登记 [TASK-087 §5.38](TASK-087-followup-ledger.md)。
- 起因：产品负责人 2026-09-18 在**真实项目**「照见未明」的结构规划页说「请填充内容」，
  界面回「好，我来填结构规划表……」，然后**表完全是空的**（他的原话：「说是写好了但是内容
  完全没有」）。· 闸：**放行（第 ① 问：在当前里程碑交付面上）** —— REQ-009 判据 3 说
  「结构规划这一步也能让 AI 做」，TASK-154 把能力做出来了，但在真实项目上**够不着**：
  判据 3 在真实项目上不成立，这是刚交付的东西的缺陷，不是新功能。
- 类型：Bug · 深度：**STANDARD**（U=QUICK：判据一句话说得清；**I=STANDARD**：改的是
  resolver 的排序键，波及每一次对话路由；R=QUICK：`git revert`；C=QUICK：无对外合同变更）
- 成果物：本卡 · [ADR-0106](../adr/ADR-0106-the-more-specific-keyword-hit-wins.md) · 提交
- 关联 Requirement：[REQ-009 v1 判据 3](../requirements/REQ-009-write-the-novel-first-then-film-it.md)
  「每一步都能让 AI 做」—— 结构规划那一步在真实项目上够不着，就是这条判据没成立。
- 架构约束：`CA §3`「对话里的能力路由」（模型只做一级分流，选哪个内部能力由**服务端确定性
  规则**决定，且**可复核**）· ADR-0091 决策 2（排序键是那套确定性规则本身）
- L5 自动实施授权：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」
  + 本次真实项目反馈
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/TASK-148-l5`，分支 `change/TASK-156-route-specificity`，
  基线 `main@6f5c8b4`

## 1. 查实的根因（不是猜的，是用真实那一轮的 goal 跑真 resolver 跑出来的）

线程记录（`照见未明/studio/conversation.json`，thread=`episodes` 即结构规划页）：

```
[user]  请填充内容
[agent] 好，我来填结构规划表：依据故事大纲和三个人物的设定，把 12 行九列…逐行填上
        route: cap=story-development skill=story-development scope=project
        goal='请填充内容：把结构规划表的 12 行（九列）按故事大纲和人物设定填上…'
        reason='你说的话里点到了「故事、大纲」；范围是整个项目'
```

**模型没错**：它把 capability 报成「开发故事」（结构规划确实归这一类），goal 也精确地说了
「把结构规划表…填上」。错在**服务端的排序**。拿这条 goal 跑真 resolver：

| 候选 | 命中 | 命中数 | 最长命中词 | priority |
| --- | --- | --- | --- | --- |
| `story-development` | 故事、大纲 | 2 | 2 | **80 → 赢** |
| `structure-planner` | **结构规划、规划表** | 2 | **4** | 75 |

命中数打平 → 修订匹配打平 → scope 打平 → 就绪打平 → **落到 priority，泛的那个赢了**。

**机理一句话**：他的话里既有**对象**（结构规划表）也有**输入材料**（故事大纲），而排序键把
「点到了输入的名字」和「点到了对象的名字」当成**同等证据**，再交给 priority 决胜负。于是
跑的是 `story-development`，产出是大纲提案（界面上那句「我把它写进**另一页**」），
结构规划表当然一个字都没有。

## 2. 架构决定 → [ADR-0106](../adr/ADR-0106-the-more-specific-keyword-hit-wins.md)

**命中得更具体的赢过命中得更多的**：新键 `_conv_specificity`（最长命中词的字数）排在
**命中数之前**、`priority` 之上。理由与代价写在 ADR-0106；它**部分取代 ADR-0091 决策 2**
的排序键第 1 项（双向链接已补）。

> **订正（codex 轮 1）**：本卡第一版把新键放在命中数**之后**，说法是「靠命中数分出胜负的
> 既有选择一条不动」。审查者要我给出能判别这两种顺序的用例 —— 构造出来的那条
> 「按故事大纲做一版结构规划」（开发故事 2 个短命中 vs 结构策划 1 个长命中）在
> 「命中数优先」下落到开发故事，**而那是错的**，与本卡开头那个缺陷是同一个机理、
> 只是换了个配比。所以顺序改成具体度优先，判据 4 一并订正。

- **不调任何包的 `priority`**：那是把个案焊进配置，换个说法又坏。
- **不引入页面（`module`）作路由信号**：服务端确实拿得到（线程 key 就是它），但要让它有意义
  得给 30 个包各标一个「主页」，而今天只有这一条真实证据支持那么大的改动。记为 follow-up
  （TASK-087 §6.19），不在本卡做。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | 无（判据 3 本来就要求这件事成立） | REQ-009 / REQ-007 一条不改 |
| UI | 无 | 路由说明条（它说的还是同一套：点到了哪些词、什么范围） |
| 数据 Schema | 无 —— 排序键不写进任何文档，也不改 manifest 形状 | `internalRouting` 的字段集、priority 的语义 |
| Workflow | 无 | — |
| 测试 | `tests/studio/` 新增一份（真实那条 goal 的回归 + 排序键本身） | 前端 · `tests/backend` · `tests/e2e` |
| docs | 本卡 · TASK-087 §6.19 · STATUS 重生成 | `current-architecture.md`（CA §3 那一行说的机制没变：仍是服务端确定性规则） |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`_conv_specificity` 与排序键接入 · 上述测试。

**OUT OF SCOPE**：页面（`module`）参与路由（→ TASK-087 §6.19）· 模型回复文字与实际路由到的
能力不一致时的对账（→ TASK-087 §6.20）· 任何 manifest 的 priority 调整（调 priority 是把
个案焊进配置，本卡修的是**规则**）。

## 5. 验收

1. 真实那条 goal（「请填充内容：把结构规划表的 12 行…按故事大纲和人物设定填上…」）在
   `form=episode` 与 `form=novel` 下都选中 `structure-planner`。
2. 泛问仍归泛能力：「根据故事核心来生成大纲」「帮我把这个想法发展成一个故事」→
   `story-development`。
3. 既有路由不变量一条不破：TASK-119（分集 / 各 facade）· TASK-146（写这一章 / 剧集侧）·
   TASK-154（结构规划 / 分集）· TASK-155（改编 / 剧集侧）全绿。
4. **一个长命中赢过两个短命中**（订正见 §2）：「按故事大纲做一版结构规划」→
   `structure-planner`（开发故事命中 2 个短词，结构策划只命中 1 个长词）。
5. 一个词都没命中时行为不变（仍按 scope / 就绪 / priority），且理由里不冒出「点到了某某」。
6. **选出来的能力，跑完要有人能把它用上**：resolver 对那句真实的话选出的 skillId，在前端
   `APPLY_TARGETS` 里是 `can: true` 且写回目标是「结构规划」那张表（跨边界，住 `tests/contract/`）。

## 6. 验证

影响范围 = studio（resolver）+ contract（跨边界的那道缝）。

**实测（2026-09-18）**：`pytest tests/studio tests/contract -n 8` **1034 passed / 16 skipped**
（含 TASK-119 / 146 / 154 / 155 的全部路由不变量）· `ruff check .` 通过 ·
`lifecycle_check` 0 finding（ADR 取代关系双向由它守）。

验收 → 守卫：

| §5 | 守卫 |
| --- | --- |
| 1 真实那条 goal → `structure-planner`（三种 form） | studio `test_the_real_goal_now_lands_on_the_structure_planner` + `test_the_two_candidates_really_were_tied_on_hit_count`（把「当初确实打平」的前提钉住） |
| 2 泛问仍归泛能力 | studio `test_a_plain_story_request_still_goes_to_story_development`（3 条说法） |
| 3 既有路由不变量不破 | TASK-119 / 146 / 154 / 155 全绿（1034 passed） |
| 4 一个长命中赢过两个短命中 | studio `test_one_specific_hit_beats_two_generic_ones`（先钉 2 vs 1 的前提，再断言选中结构策划 —— 把键放回命中数之后就红） |
| 5 零命中时行为与理由不变 | studio `test_with_no_hits_at_all_the_old_order_decides` · `test_specificity_only_speaks_when_it_has_a_hit` |
| 6 选中的能力写得回那张表 | contract `test_the_capability_chosen_for_the_real_goal_can_be_written_back` · `test_every_capability_this_chain_added_has_a_write_back_path` · **`test_the_slice_cannot_borrow_a_neighbours_answer`**（守卫自己的守卫，见下） |

轮 2 的 NON_BLOCKING（P3）**当场修了**（协议不为 P3 买轮，但一个红不了的守卫比没有守卫更糟）：
`_apply_block` 原来按 400 字截，切片会捎上后一条条目 —— 把 `structure-planner` 改成
`can: false` 也能从**邻居**读到 `can: true`。改成切到这一条自己的收尾，并加一条合成用例证明
它现在真的会红。实测：改坏之后按收尾切 `can: true in block = False`，按 400 字截 `= True`。

## 7. 还没在真实项目上被人看过的

**这是信息，不是闸门**（AGENTS.md §1）：

1. **他在真实项目上再说一次「请填充内容」**，看结构规划表是否真的被填上 —— 自动化证到的是
   「选对了能力」+「这个能力写得回那张表」+「提案按九列落进表」（后者在 TASK-154 的真
   controller 测试里），但这三段在真实项目上串起来跑，只有他能看见。
2. 那张表是**整表替换**（旧行进回收区、可拿回）：他现有的 12 行只填了 Unit No. 与 Scene，
   替换后要确认回收区里拿得回来。
3. 零关键词的说法（如只说「填一下」）仍然靠 priority 兜底 —— 页面不参与路由（TASK-087 §6.19）。

## 8. Merge Gate（2026-09-18，ADR-0085：依据是 Done 判定 + 最终全量）

| 前置 | 证据 |
| --- | --- |
| Done 判定 | §5 验收 1–6 各有守卫；codex 轮 2 四闸全 PASS、0 BLOCKING；`GATE_CONSISTENCY` 那行是已登记的散文误报（见卡头） |
| 最终全量 | 提交闸门按归属跑 `pytest-targeted` 5 项检查全过；`tests/studio` + `tests/contract` **1034 passed**；`ruff check .` 全过；前端未动（本卡不碰 JS，唯一读 JS 的是 contract 那条只读断言） |
| 待复审清单 | 0 条未闭合 |
| 未闭合 P1 | 无（轮 2 的 P3 已当场修并自证会红） |
| 分支形状 | `change/TASK-156-route-specificity` 基于 `main@6f5c8b4`，一条直线，可 ff |
