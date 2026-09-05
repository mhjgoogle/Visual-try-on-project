# TASK-133：给「名字」和「不做」各一个落点 —— 术语表与范围外索引

- 状态：**进行中**（2026-09-05 开卡）
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
