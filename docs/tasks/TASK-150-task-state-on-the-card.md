# TASK-150：任务的状态住在卡上 —— 目录平铺，「在办的有哪些」由工具回答

- 状态：完成 · 实现完成并经三轮独立审查收口（2026-09-17）；随 `change/TASK-148-l5` 合并，
  合并时与 three-pane 链的路径冲突见 §5 第 1 条
- 起因：产品负责人 2026-09-17 —— 「我希望 folder 不要分 done 和 active 了。这些能在
  这个仓库的任务管理器里面找到现在在进行中的任务。」同日按其「决策前置一次问完」的
  要求提出方案（平铺 + 卡头状态行 + 三个工具改读它），产品负责人选「就这么做，现在在
  本分支上做」。· 闸：**归用户的层级（开发流程的根规则），用户已拍板**；不过四问。
- 类型：Refactor（工装与文档结构，不改产品行为）· 深度：**DEEP**
  （C=DEEP：取代 ADR-0083 决策 1 与 ADR-0087 决策 2 的载体，改 AGENTS.md 三处；
  I=DEEP：150 张卡的路径全变、几百条链接重写、五个工具改读状态行）
- 成果物：[ADR-0105](../adr/ADR-0105-task-state-lives-on-the-card.md) · 本卡 ·
  `.claude/tools/task_status.py` · 一次迁移 · 提交。**无产品 REQ**，工装按 AGENTS.md §20
  写技术目标。
- 技术目标：**「现在在进行中的任务有哪些」这个问题由工具回答，不由目录名回答；
  一张卡的路径在它整个生命周期里不变。**
- 架构约束：`CA §1`（`.claude/` 是工装）· `CA §4`（测试归 `tests/tooling/`）·
  AGENTS.md §20 fail-closed · §24 状态只能有一个真相来源（现在是卡头那一行，
  语法源是 `task_status.py`）
- 实施 Agent：`visual-try-on-project-b0`（2026-09-17 认领）
- 工作树：`motv-wt/TASK-148-l5`，分支 `change/TASK-148-l5`

## 1. 决定（结论在 ADR-0105，这里只记实施形状）

- **状态语法一个源**：`task_status.py` 提供 `STATES` / `STATE_LINE` / `cards()` /
  `by_state()`；`gen_docs_status` · `lifecycle_check` · `agent_harness resume` ·
  `task_graph` · `l5_queue` 全部 import 它。
- **迁移不丢字**：已有 `- 状态：` 行 → 枚举词前置、原文接在 `·` 后；没有的 → 补一行。
- **链接按位置重算**，不做字符串猜测：卡从三层深变两层深，卡内每条相对链接按
  「旧位置解析 → 新位置重算」逐条重写；卡外的 `tasks/(active|backlog|done)/` 折成 `tasks/`。
- **`design/active|done/` 不动**（ADR-0105 §范围）。

## 2. 迁移实测（2026-09-17）

| 项 | 数字 |
| --- | --- |
| 搬进 `docs/tasks/` 的卡 | 149 张（待办 8 · 进行中 9 · 完成 130；另 2 张 TASK-102 证据、1 张 TASK-061 审查记录、1 份 `.patch` 搬进 `docs/reports/`） |
| 卡内重写的相对链接 | 396 条 |
| 卡外改链接的文件 | 76 个 |
| 迁移中发现的坏状态 | **两组重号**：TASK-061（审查记录存成了卡名）、TASK-102（注入证据 ×2 存成了卡名）—— 三个目录让同一个号长出两张卡而没人发现，这正是本卡的立论之一 |
| 迁移中发现的漏卡 | `TASK-051A` / `TASK-051B` 带字母后缀，第一版正则 `\d+\b` 会把它们**两张都漏掉** —— 漏掉的卡在「进行中的有哪些」里静默消失，比重号更糟 |

## 3. IN SCOPE / OUT OF SCOPE

**IN**：迁移 · `task_status.py` · 五个工具改读状态行 · `lifecycle_check` 新守卫
（缺状态行 / 重号转红）· AGENTS.md §14 §24 §25 与头部措辞 · dev-workflow Skill 文本 ·
ADR-0105 与 ADR-0083 / 0087 的反向取代链接 · 所有建在目录上的测试。

**OUT**：`design/active|done/` · 看板 UI · 优先级数字 · 三条未合并分支的冲突（合并时解）。

## 4. 完成判据

1. `docs/tasks/` 下没有子目录；每张卡有且只有一行合法状态；`lifecycle_check` 0 finding。
2. `test_docs_links` 0 断链；`gen_docs_status --check` 通过。
3. `agent_harness.py resume` 列出的在办卡 = 状态为 `进行中` 的卡，一张不多一张不少。
4. `l5_queue.py list` 只认 `进行中` 的授权卡；TASK-149 的「前置完成」= 状态 `完成`。
5. 一张没有状态行的卡、一对重号的卡，`lifecycle_check` 各自转红（有测试钉住）。
6. 收口时如实写「实现完成」与「还没在真实项目上被人看过的」两个独立事实。

## 5. 交付记录（2026-09-17）

**一、实现完成。**

| 判据 | 证据 |
| --- | --- |
| 1 | `docs/tasks/` 无子目录（`test_task_cards_are_not_split_into_state_folders`）；149 张卡各有合法状态行（`test_the_real_repository_has_exactly_one_legal_state_per_card`）；`lifecycle_check` **0 finding** |
| 2 | `test_docs_links` **0 断链**（迁移后修了两轮：卡对卡的 40 条半截路径、我自己卡里一条示例链接）；`gen_docs_status --check` **up to date** |
| 3 | `agent_harness.py resume` 在真仓库上列出 **10 张** `进行中` 的卡，与 `task_status.by_state()` 一致 |
| 4 | `l5_queue.candidates()` 只取 `进行中`；TASK-149 的 `blocked_by` 只问 `.done` |
| 5 | `test_a_card_without_a_legal_state_line_turns_red` · `test_two_cards_sharing_one_id_turn_red` |
| 测试 | 工装域 **548 passed / 2 skipped**（新增 `test_task_status.py` 12 条；`test_plan_status_matches_folder.py` 整体重写为 `…_card_state.py`）· `ruff` 干净 752 文件 |

**迁移中撞出、并且各自留下了守卫的三条**：

1. **重号**：TASK-061 与 TASK-102 各两张「卡」—— 其实是审查记录与注入证据存成了卡名。
   三个目录让它们长在不同地方而没人发现。已搬进 `docs/reports/`；`cards()` 遇重号抛出。
2. **漏卡**：`TASK-051A/B` 字母后缀，第一版正则两张都认不出。
3. **CRLF**：`agent_harness` 按字节读卡，行尾是 `\r\n`，状态行正则的行尾断言只认 `\n`，
   于是 `resume` 在 Windows 工作树上一张都列不出来 —— 文本模式读的四个工具看不见这个坑。
   `task_status.STATE_LINE` 的字符类加了 `\r`，`test_a_crlf_card_is_read_the_same` 钉住。

**二、还没在真实项目上被人看过的**：

1. **与 `change/TASK-109-three-pane` 的合并冲突还没解**。那条链 54 个提交动过
   `docs/tasks/active|done/` 下的卡，本分支把它们全搬了 —— 合并时每一张都是 rename/modify
   冲突。产品负责人选了「现在做，冲突我来解」；解法是**以本分支的路径为准、以他们的内容
   为准**，但那要等到合并那一刻。
2. `resume` 的「最近谁动过」用 `git log -- docs/tasks/<name>`，**没有 `--follow`**，
   所以迁移之后它看到的是搬家那一次提交，不是卡内容上一次真正被改的时间。TASK-087 记账。
3. 三张新卡（148 / 149 / 150）的卡头写的是 `实施 Agent：`，而 `resume` 读的是
   `负责 Agent：` —— 于是它们显示「负责：没写」。字段名该统一，不在本卡改。
4. `design/active|done/` 仍按目录分区（ADR-0105 §范围）。

## 6. 独立审查（codex 全程，独立性未降级；与 TASK-149 合并审）

| 轮 | 结论 | 买轮的那条（新机理） |
| --- | --- | --- |
| 1 | fail · 149/1 `FAIL` · 149/3 与 150/1 `PARTIAL` · 2 BLOCKING | ① **正则认的写法比仓库里的窄**：`- **前置：…**` 粗体标签整行漏掉，真仓库 15 张卡，边 17 → 32；② 状态解析整篇 `search`，卡头缺状态时正文示例会顶上，两行状态静默取第一条 |
| 2 | fail · 150/4 `FAIL` · 1 BLOCKING | ③ **修类时开的反向口**：放宽标签允许 `**` 后，空的 `- **L5 自动实施授权：**` 被 `\S` 吃掉一个 `*` 当成有依据 |
| 3 | **pass** · 四闸全 PASS · BLOCKING 为空 · SUFFICIENT | 收口。输出里的 `GATE_CONSISTENCY: inconsistent` 是 `fail-closed` 一词触发的已知误报（TASK-087 §5.38），无任何闸非 PASS |

三轮各买其所：三条机理互不相同，且第 ③ 条是我自己修第 ① 条时引入的 ——
「放宽正则」与「收紧正则」两个方向各错一次，最后靠**内容判定**（依据剥掉定界符后必须
非空）而不是靠正则边界收口。轮 1 的三条 NON_BLOCKING（标点、glossary、ADR-0087 §5
被迁移折叠坏的一句）一并修了。

**收口状态**：150 的判据 1–5、149 的判据 1–4 全 `PASS`；`CA §1` `CA §4` §20 §24 §3
ADR-0101 §4 全 `PASS`；无未闭合 P1/P2。工装域 **566 passed / 2 skipped**。
提交链：`17c1a40` → `3c1d445` → `9578db4`。
