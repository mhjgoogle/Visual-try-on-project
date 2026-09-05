# TASK-133：给「名字」和「不做」各一个落点 —— 术语表与范围外索引

- 状态：**完成**（2026-09-05）—— 两个独立事实：
  1. **实现完成**，代码级证据：`docs/glossary.md`（20 条）· `docs/out-of-scope.md`（36 条）·
     `ADR-0098` · `AGENTS.md` 四处指向（16 增 0 删）· `current-architecture.md` §7 ·
     `lifecycle_check.py::check_index_docs_are_indexes` 已注册进 `CHECKS` ·
     `tests/tooling/test_lifecycle_check.py` 11 条新用例。
     提交 `be9bfb1` + 修复提交（见下）；`pytest tests/tooling` 349 passed / 0 failed。
  2. **还没被人看过的**：这两份索引的**日常可用性** —— 下一个 Agent 查词时它是否真的
     省了翻合同的时间、收录判据是否把该收的词挡在了外面。这是信息不是闸门，不阻塞收口；
     不满意的路径是再改（条目增删纯可逆）。
- Workflow：Feature（新增仓库级文档机制）· 深度：STANDARD
- 技术目标：本仓库**当前事实找不到，于是被重新发明** —— 这是文档漂移的机理，也是
  记忆库里「一天撞五次全是过期」那条的成因。两个具体缺口：
  1. **术语没有查询入口**。仓库里已散着 80+ 条辨析（「SkillRun 不是第二份记录」
     「推荐 ≠ 绑定」「`taskType` 不得由 `taskName` 推导」），全埋在 1065 行的冻结合同与
     97 份 ADR 正文里。[TASK-128](../backlog/TASK-128-episode-side-actions-into-the-table.md)
     自己记下了这笔债：「这是**词表统一问题**，不是接线问题」；TASK-097 记录过
     `--muted` 未定义 CSS 变量的真实事故 —— 同义词漂移造成。
  2. **「决定不做 X」没有落点**。97 份 ADR **没有一份是 Rejected**（ADR-0087 定义了该状态
     但从未使用），被否的方案都埋在各 ADR 内部的方案对比表里，于是同一个提议隔几周被
     重新提一遍，每次重新论证。
- 关联 ADR：[ADR-0098](../../adr/ADR-0098-index-docs-are-not-a-second-contract.md)（本卡同批写，自行 Accept）
- 架构约束：`CA §6`（Agent 读什么）· `CA §7`（这份文件不回答什么）
- 来源：调研 GitHub 上的 ArcReel（同品类、同技术底座）后的落地项。两处**刻意偏离**原型见下。

## 为什么不是塞进当前架构合同

[current-architecture.md](../../current-architecture.md) 被 `lifecycle_check.py` 钉死 ≤200 行
（当前 144），且 §7 明列「不回答什么」。**「这个词什么意思」既不在它的职责内，也塞不进去。**
它回答 WHAT IS TRUE NOW，ADR 回答 WHY / HISTORY —— 本卡补的是第三、四种问题。

## 与 ArcReel 原型的两处刻意偏离

1. **不叫 `CONTEXT.md`、不放仓库根。** `CONTEXT` 在本仓库已被占用四次（`_conv_facts` 的
   「上下文」、`agent.context` Query、AGENTS.md「默认 Agent 上下文」、`project-context.md`）；
   且 [ADR-0077](../../adr/ADR-0077-repository-path-ownership.md) 规定仓库根只放项目元数据与
   治理文件。落点定为 `docs/glossary.md` 与 `docs/out-of-scope.md`。
2. **范围外记录做成一张索引表，不是 30 个论证文件。** ArcReel 一条边界一个文件、每份长篇
   论证；本仓库那 30 条边界的论证**已经写在 ADR 里了**，重写一遍就是第二份事实。
   真正缺的是**索引**：有人提「加个 Skill 市场吧」，今天要翻到 ADR-0067 才知道已经否过。

## IN SCOPE

1. `docs/glossary.md` —— 首版 20 条，**收录两闸**（有已写下来的漂移证据 + 叫错会改错代码或
   数据），三条不收（只出现一次的专名 / 合同里已有表在管的名录 / 正在被改名的词）。
2. `docs/out-of-scope.md` —— 只收**永久边界**（约 30 条）。判据用仓库现成的那条：
   ADR-0010 明文裁定「历史任务中的『本任务不做 X』是**有效的局部范围声明，不构成对未来的
   永久禁止**」。**不收**临时限制（105 份卡的 OUT OF SCOPE + 约 20 份 ADR 的「本轮不做」）。
3. ADR-0098 —— 两份文档合用一份，四条决策。
4. 挂载：AGENTS.md 4 处、current-architecture.md §7 —— **只加指向，不改任何既有条款**。
5. 守卫：`lifecycle_check.py` 新增 `check_index_docs_are_indexes()` + `tests/tooling` 用例。

## OUT OF SCOPE

- 三项重架构借鉴只**开卡记账不实施**：[TASK-134](../backlog/TASK-134-import-linter-layering-contract.md)
  （import-linter 分层契约）· [TASK-135](../backlog/TASK-135-server-authoritative-workflow-plan.md)
  （服务端权威 next_action）· [TASK-136](../backlog/TASK-136-generation-resume-and-idempotency.md)
  （生成任务重启续跑与幂等）。
- **不改** `creator-system-contract.md`（冻结的唯一权威，只作为 `_权威_` 指针目标）、
  不改任何既有 ADR、不改 `repo-contract.md`（入口已是 current-architecture，再加一行 =
  第二处要同步的地方）。
- 不动 `mockups/`（会话 2a 在改）、不动 `agent_harness.py` 与 TASK-131/132（会话 e9 在做）。

## 承重墙：三条机制阻止它长成第二份合同

这是本卡唯一真正的风险，三条防线里两条是**物理阻断**而非自律：

1. **删除测试**（写进两份文档的前言）：把任意一条整条删掉，问「有没有任何一条规则因此
   消失？」有 → 你抄了，把那句话搬回合同，条目只留指针。
2. **禁规范性动词**（机器可判）：定义段 ≤2 行且不出现 必须 / 不得 / 禁止 / 只能 / 一律 /
   应当。抄的时候人会本能写「必须」，写不出「必须」时就只能写指称。
3. **单向叶子**：只有索引指向合同，合同不指回来；**不是引用句柄**（句柄仍只有 `CA §N` 与
   `REQ-NNN 判据 M`），**不进 Review Package**。这一句写进 AGENTS.md 第 25 条，
   它掐死了长成合同的唯一通路。

## 实施摘要（2026-09-05）

提交 `be9bfb1`（12 files, 867 insertions）+ `e008861`（manifest writeback）。

| 产出 | 规模 |
| --- | --- |
| `docs/glossary.md` | 20 条，137 行（守卫上限 170） |
| `docs/out-of-scope.md` | 35 条永久边界，98 行 |
| `docs/adr/ADR-0098` | 四条决策，自行 Accept |
| `AGENTS.md` | 4 处加指向，**16 增 0 删** |
| `docs/current-architecture.md` | §7 +2 行（147 行，上限 200） |
| `lifecycle_check.py` | `check_index_docs_are_indexes()` + 2 helper + 4 常量 + 注册 |
| `tests/tooling/test_lifecycle_check.py` | +10 用例（59 passed） |

**同仓协作**：全程三个会话共用一个工作区。TASK-133 只碰自己那 12 个文件；
`current-architecture.md` 与会话 e9 排了先后（它 §1 先落 `5ebff19`，我 §7 后补）；
`STATUS.md` 由 e9 那次提交带走（含本卡四张卡），本卡提交后重新生成确认已一致。
提交曾被 e9 的 staged index 阻塞 700 秒 —— auto-push 的 `BLOCKED_DIRTY_INDEX` 拒绝混入
他人 staged 内容，这是对的，等待是唯一正解。

## 已做验证

- **最终归属域全量**（修复后状态，收口依据）：`pytest tests/tooling` →
  **349 passed / 1 skipped / 0 failed**（4:34；skip 的是 Ubuntu CI 负责的 bash 语法检查）。
  过程中曾出现一次 `347 passed / 1 failed`，唯一失败是
  `test_agent_harness.py::test_the_real_repository_entries_are_in_sync` ——
  **会话 e9 的测试**，当时它的薄入口修复还在 index 里未提交；它 `5ebff19` 落地后该项转绿。
  本卡改动与 `.agents/skills/` 同步性无关。
- `pytest tests/tooling/test_lifecycle_check.py` → **60 passed**（含 11 条新用例）
- `ruff check` + `ruff format --check` → 全过
- `python .claude/tools/lifecycle_check.py` → **0 finding**
- **守卫反向验证**：喂七种坏数据逐个确认变红（缺 `_Avoid_` / 缺 `_权威_` / 指针指向不存在的
  文件 / 定义含「必须」/ 定义超 2 行 / 超行数上限 / 表格行无裁决链接），干净输入全绿。
- **出处反查**：35 条边界的裁决文档批量核验 0 条落空；ADR-0090/0067/0056/0093 逐句精确抽查。
  **抓到并修正一处真错** —— ADR-0056 原文是「**本阶段**不做自动 self-learning」，
  按 ADR-0010 判据属阶段性声明可重访，永久的那半是「不能因为模型一次输出就偷偷改变 Skill」。
- **删除测试**：抽 5 条整条删除，确认没有任何规则因此消失。
- ruff **B005 抓出一个真 bug**：`ln.rstrip("_Avoid_：: ")` 的多字符参数是字符集不是后缀，
  手工验证碰巧通过是偶然，已改为 `_AVOID_LINE` 正则。

## 独立审查（codex，轮 1 → fail：3 条 P1，已全修）

架构四闸全 PASS；判据 1/2/3/5 PASS，判据 4 `NOT_EVIDENCED`、Verification `INSUFFICIENT`。

1. **守卫能被合法 Markdown 绕过**（真 P1）。元数据行原按「以下划线开头」认，于是
   `_这一版必须由用户产生。_` 这种普通斜体被当成元数据剔出定义切片 —— **把承重墙那条规则
   用斜体写出来就能绕过动词检查和长度上限**。改为只认 `_Avoid_` / `_权威_` 两个前缀，
   加回归 `test_an_italicised_definition_cannot_bypass_the_verb_check`。
2. **索引里长出了源文档没有的禁令**（真 P1，且**同类共三处**，审查者报一处、按同一机理
   自查又找到两处）：「界面抓图」不在 AGENTS.md 第 23 条（出自 project-context.md）、
   「剪辑软件自动化」不在 ADR-0012（出自 ADR-0039）、「静默四禁」原文在 ADR-0066 而非
   我指的 ADR-0065/0089（后者「静默」出现 0 次）。三处均已拆分或改指到真正的裁决。
3. **判据 4 缺证据**。补做 36 条边界的**逐条语义反查**（不是「文档里有否定词」就算数）：
   34 条句子语义直接对应，2 条低分经人工 grep 确认原文存在；删除测试 5 条抽样结果逐条记录。

**这一轮最有价值的发现**：删除测试对术语表 5 条全部通过，但对边界表那三处合并来源
**不通过** —— 删掉它们确实会让某些禁令在索引里失去表示。**测试是有效的，是我此前只对
术语表抽样、没对边界表逐条跑。** ADR-0098 决策 3 把删除测试列为承重墙第一条，这一轮
恰好证明了它抓得住，也证明了「只抽样不逐条」会漏。

**轮 2（fail：2 条 P1，均为证据缺口，生产代码未动 → 按 ADR-0081 补证据 + 跑归属域收口，
不再买轮）**：

1. **缺一个明确的最终全绿运行** —— 此前记录停在 `347 passed / 1 failed`（那条失败属于
   会话 e9），之后只跑了单文件。已在修复后状态重跑：**349 passed / 1 skipped / 0 failed**。
2. **glossary 的出处反查是选择性的** —— 边界表做了 36 条逐条，术语表只抽查了 8 条。
   已补做 **20 条逐条**（候选句优先取带辨析标记的），18 条抽取器直接命中、7 条人工 grep
   逐条确认原文，全部落实；并补全了「上下文」那条缺失的第三个指针（`agent.context`）。

轮 2 另有三条 `NOT_EVIDENCED` 属**审查范围造成**而非真缺口：该轮审的是未提交的修复 diff，
完整索引与守卫注册在 `be9bfb1` 里、不在该 diff 内。这一点记在此处，避免下次复核时重新推导。

## 完成判据

1. 两份索引存在，各条都带 `_Avoid_` / 「正式裁决」与可解析的 `_权威_` 指针；`lifecycle_check`
   零发现（含新增检查）。
2. AGENTS.md 与 current-architecture.md 只增指向 —— `git diff` 里没有一行既有条款被改写。
3. `pytest tests/tooling` 全绿；新增用例按现有「干净必须绿 / 被破坏必须红」双向风格，
   逐条造出危害（缺 `_Avoid_` / 缺 `_权威_` / 指针指向不存在的文件 / 定义含「必须」/
   定义超 2 行 / 文件超上限）。
4. 人工两项（机器判不了）：**删除测试抽样** 5 条确认没有规则因此消失；**出处反查**逐条
   点开确认目标文档里真有那句辨析 —— 找不到 = 这条是编的，按收录闸 1 撤掉。
5. 独立审查 1 轮（改了 `lifecycle_check.py` + `tests/tooling/`，落在「行为与工装」那一行；
   判据是它改的是什么，不是改了多少行）。
