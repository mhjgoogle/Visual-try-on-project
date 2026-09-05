# 术语表（Glossary）—— 一个概念一个名字

**这份文件只回答「这个名字指谁、不指谁」（WHAT THINGS ARE CALLED）。**
「它得满足什么」在每条 `_权威_` 指针的那一头 —— 两者刻意分开，因为它们是两个问题。

与邻居的分工：[当前架构合同](current-architecture.md) 答 **WHAT IS TRUE NOW**，
`docs/adr/` 答 **WHY / HISTORY**，[范围外记录](out-of-scope.md) 答 **WHAT WE WON'T BUILD**。

## 怎么用它

- **它不是引用句柄。** 引用句柄只有 `CA §N` 与 `REQ-NNN 判据 M`；没有「违反 glossary 第 N 条」
  这种说法 —— 违反的永远是它指向的那份合同。它也不进 Review Package。
- **删除测试（加条目前自己跑一遍）**：把你要加的那条整条删掉，问「**有没有任何一条规则因此
  消失**？」有 → 你在抄合同，把那句话搬回它该在的地方，条目里只留指针。没有 → 合格。
- **收录两闸**（同时成立才收）：① 仓库里指得出一处**已经写下来的**漂移证据；
  ② 叫错了会**改错代码或改错数据**。纯风格偏好（叫「镜头」还是「Shot」）不收。
- **不收**：只出现一次、没有近义词的专名；合同里已有一张表在管的名录（Command / Query /
  Artifact kind）—— 那是名录不是概念；正在被改名的词（那是任务卡的待办）。
- 一个词不再有漂移风险就**删掉它那一条**。这份表不记待办、不记计划、不记状态。

---

## A. 元术语 —— 关于名字本身

### 术语表（glossary）／ 词汇表（vocabulary）
本文件是术语表。「词汇表 / 词表」在本仓库指的是封闭的动作名或枚举集合，是另一回事。
_Avoid_：用「术语表」指动作名集合 · 用「词汇表」指本文件
_权威_：[ADR-0091](adr/ADR-0091-three-user-capabilities-and-a-server-side-resolver.md) · [ADR-0096](adr/ADR-0096-ui-and-agent-share-one-action-table.md)

### 上下文（context）
单说「上下文」在本仓库指不到东西 —— 四个不同的东西各占用过它一次。
_Avoid_：不带限定词的「上下文」 · 用 `CONTEXT.md` 命名任何新文件
_权威_：[当前架构合同 §6](current-architecture.md) · [AGENTS.md 第 25 条](../AGENTS.md) · [系统合同 §8.2](design/creator-system-contract.md)（`agent.context`）

### 权威（authoritative）
三个粒度共用这个词：权威**文档**（某范围的唯一定义处）、权威**环境**（行为差异的裁决者）、
唯一**写入者**（谁能落盘）。
_Avoid_：用「权威」指「唯一写入者」 · 把「权威环境是 Windows」读成代码可以关心自己跑在哪
_权威_：[AGENTS.md 第 2 条](../AGENTS.md) · [ADR-0062](adr/ADR-0062-windows-authoritative-environment.md)

## B. 对象与资产

### Asset（资产）／ 产品资产
进 Asset Registry 的**媒体**才叫 Asset；`product-skills/` `product-flows/` 那类叫「产品资产」，
同字不同义，不进 Registry。
_Avoid_：把 Outline / Character / Scene / Shot 叫资产 · 把 `product-skills/` 叫 Asset
_权威_：[系统合同 §1.1](design/creator-system-contract.md) · [ADR-0067](adr/ADR-0067-product-skill-package.md)

### 参考 / 参考图（reference）
在某次生成中作为条件输入的**登记资产**；它做什么用由 Binding 的 `role` 说，不由它自己说。
_Avoid_：一次性文件 · 素材 · 底图 · 把 `start-frame` / `end-frame` 说成 asset kind
_权威_：[系统合同 §1.2](design/creator-system-contract.md) · [ADR-0055](adr/ADR-0055-unified-asset-registration.md)

### 绑定（Binding）
一条「谁用什么做什么」的记录。推荐是未勾选的一行，与绑定是两回事。
_Avoid_：用「推荐」指绑定 · 把「已绑定未解读」说成 ready
_权威_：[系统合同 §1.2](design/creator-system-contract.md) · [ADR-0063](adr/ADR-0063-creator-object-first-ia-and-shot-production-graph.md)

### 上传（upload）／ 登记（register）
上传指登记 + 分类 + 关联这一整件事，不是「把文件写进磁盘」；语义类型来自声明，不来自路径推断。
_Avoid_：用「上传」指写文件 · 从文件名推断 kind
_权威_：[ADR-0055](adr/ADR-0055-unified-asset-registration.md)

## C. 运行

### Run ／ SkillRun ／ `runId`
一切长任务共用 Run，`kind` 区分种类；SkillRun 是 `kind="skill"` 的 Run —— 同一条记录的专业化。
_Avoid_：用「任务 / 作业 / job」混指 Run · 把 SkillRun 当第二份记录 · `skillRunId`（已删）
_权威_：[系统合同 §5.0](design/creator-system-contract.md) · [当前架构合同 §3](current-architecture.md)

### `taskType` ／ `taskName`
`taskType` 是稳定的机器标识（筛选、聚合、迁移读它）；`taskName` 是随文案与语言变的显示名。
_Avoid_：从 `taskName` 推导 `taskType`（或反向） · 把 `taskName` 当持久化键
_权威_：[系统合同 §5.0](design/creator-system-contract.md) · [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)

### 重试 ／ 续跑 ／ 恢复
三件事：重试开一条**新 Run**（带 `retryOfRunId`）；续跑从已完成的步骤之后继续；
恢复把已经跑完的那一轮落地。
_Avoid_：说「重跑这个 run」（旧 Run 不会复活） · 用「恢复」指重新发起
_权威_：[系统合同 §5.7](design/creator-system-contract.md) · [AGENTS.md 第 11–12 条](../AGENTS.md)

### 未知（unknown）—— 缺信息不是一个值
「问不到」「没记录」「没跑过」都落在未知这一档，与 false / 0 / idle / 通过各是各的。
_Avoid_：问不到 → 写成「没在跑」 · 没有通过记录 → 写成 `approved:false` · 没跑过质检 → 当通过 · 缺失 → 当零
_权威_：[ADR-0095](adr/ADR-0095-a-run-is-picked-up-from-the-thread-not-from-a-poller.md) · [ADR-0057](adr/ADR-0057-shot-production-state-and-dailies.md) · [ADR-0039](adr/ADR-0039-wfm2-postproduction-qc-release-contract.md)

## D. 版本 · 定稿 · 状态

### 定稿 ／ 通过 ／ final
三件事：`confirmed` 是用户在某一版上的动作；`passed` 是某道检查的结论；`final` 是交付侧的产物。
_Avoid_：用「最终版」同时指这三样 · 把质检通过读成定稿
_权威_：[系统合同 §3](design/creator-system-contract.md) · [系统合同 §6.5](design/creator-system-contract.md)

### `deprecated`
ArtifactVersion 六态之一 —— 一个 `deprecated` 版本仍然可查。
_Avoid_：把「废弃」读成「删了」 · 「五态 + deprecated」的旧口径
_权威_：[系统合同 §3](design/creator-system-contract.md)

### active
两个东西共用这个词：`docs/tasks/active/`（目录即状态）与 Artifact 的 active 指针。
_Avoid_：不带限定词的「active」
_权威_：[AGENTS.md 第 24 条](../AGENTS.md) · [系统合同 §2](design/creator-system-contract.md)

### `awaiting_input`（等你交结果）
Run 的一个状态：机器这边空着，等人把结果交进来。
_Avoid_：把它显示或记录成「运行中」/ running
_权威_：[系统合同 §5.2](design/creator-system-contract.md) · [创作者 IA](design/creator-product-information-architecture.md)

## E. AI 与能力

### Role ／ Skill ／ Runtime ／ Executor ／ Model
五层各自独立的概念，域里不出现「AI 导演 = 某个 CLI」这类绑定。这是本仓库的头号辨析。
_Avoid_：把 Skill 说成模型 · 把 Executor 说成 Runtime · 「AI 导演用的是某某」
_权威_：[ADR-0056 决策 1](adr/ADR-0056-local-ai-runtime-and-film-skills.md)

### Skill（能力包）／ 用户能力（user capability）
Skill 是 `(skillId, skillVersion)` 标识的产品资产；创作者在界面上看到的是三个用户能力，
两者不在一层。
_Avoid_：用「Skill」指对话里那三个能力 · 把 Skill 说成源码常量 · 让模型指定 `skillId`
_权威_：[ADR-0067](adr/ADR-0067-product-skill-package.md) · [ADR-0091](adr/ADR-0091-three-user-capabilities-and-a-server-side-resolver.md)

### 模板（flow template）
Skill 包机制的**第二个 kind**，同一套加载与校验，不是另起的一套。
_Avoid_：「模板系统」 · 「模板那一套」
_权威_：[ADR-0084](adr/ADR-0084-project-flow-template-as-a-package.md)

## F. 治理用词（只收名字歧义，规则仍在 AGENTS.md）

### 平台中立（platform-neutral）
指代码不关心自己跑在哪。它与「权威环境是 Windows」是两件事 —— 后者说的是分歧时谁裁决。
_Avoid_：把「平台中立」读成「写 POSIX」 · 把「权威是 Windows」读成可以用 Windows 专属 API
_权威_：[AGENTS.md 第 3 条](../AGENTS.md) · [ADR-0062 决策 2](adr/ADR-0062-windows-authoritative-environment.md)

### 全量 ／ 定向
全量是集成检查点跑的那一套；定向是按改动影响范围的归属域跑的那一套。
_Avoid_：只说「跑了测试」而不说是哪一档
_权威_：[AGENTS.md 第 20 条](../AGENTS.md) · [ADR-0080](adr/ADR-0080-test-ownership-and-gate-mapping.md)
