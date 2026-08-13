# ADR-0067：Skill 是产品资产，不是源码常量 —— Product Skill Package

- 状态：**Accepted**（产品负责人 2026-08-13 下发）
- 日期：2026-08-13
- 实施基线：`70dab40`（TASK-072 批次一）
- 实施任务：[TASK-075](../tasks/TASK-075-product-skill-package.md)
- 相关：
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)（Runtime / Skill 分层、
  能力定义不可变、不自动自学习）、
  [ADR-0065](ADR-0065-every-ai-action-through-the-runtime-layer.md)（每个 AI 动作经 Runtime 层）、
  [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  （固定 IA、Run 合同）、
  [创作者系统合同](../design/creator-system-contract.md) §5（Skill 与 Run）

## 背景

二十个 Film Skill 今天是 `src/workflow/skills.js` 里的**冻结常量**。ADR-0056 决策 6
要求「改进一个 Skill 是一次显式修订，绝不是一次好回答的副作用」——常量确实做到了
这一点，但它同时带来三个今天已经付出代价的后果：

1. **能力的边界等于源码的边界。** 想给某个项目加一条它专用的分镜规则，只能改仓库。
   创作者手里没有任何可以自己拥有的东西。
2. **版本只是一个整数。** `skillVersion: 1` 说不出「这一版的 Prompt 到底是什么」。
   历史 Run 指向 `(skillId, skillVersion)`，而那一版的实际内容早已被后来的编辑覆盖 ——
   溯源链在最关键的一环上是断的。
3. **两套编译器。** 五个 `/api/agent/*` 端点在 `server.py` 里自带 Prompt 与解析器；
   TASK-072 批次一把它们的**执行**收进了 Runtime 层，但**定义**仍然各写各的。
   同一个「分镜」能力，前端一份、后端一份。

## 决策

### 决策 1：Skill 是一个**包**，不是一个常量

一个 Skill 是一个目录，三个文件：

```
<skill-id>/
  manifest.json        身份、版本、work、scope、inputs、cost、produces、taskName
  prompt.md            指令正文（编译时与上下文拼装）
  output.schema.json   输出契约（fail-closed 校验）
```

**为什么是三个文件而不是一个 JSON**：Prompt 是要被人读、被人改、被 diff 审阅的
散文，塞进 JSON 字符串就没人愿意改它；输出契约是要被机器严格执行的结构。
两者的读者不同，编辑方式也不同。

### 决策 2：三个来源，项目 → 用户 → 内置

| 来源 | 位置 | 谁拥有 |
| --- | --- | --- |
| 项目 | `<ProjectRoot>/studio/skills/` | 这一部作品 |
| 用户 | `<应用数据根>/skills/` | 这台机器上的创作者 |
| 内置 | `<RepoRoot>/product-skills/builtin/` | 产品 |

**加载优先级：项目 → 用户 → 内置。** 同一个 `skillId` 由更靠前的来源整体覆盖，
**不做字段级合并**：半个来自项目、半个来自内置的 Prompt，没有人能预测它说了什么。

内置包放在 `product-skills/`（仓库根）而不是 `mockups/` 下面：它是**产品资产**，
不是这个原型的私有物，将来产品换外壳它也要跟着走。

### 决策 3：`skillDigest` —— 版本终于能指向内容

Run 记录 `skillId` · `skillVersion` · **`skillDigest`**（三个文件内容的稳定散列）。

`skillVersion` 回答「作者说这是第几版」，`skillDigest` 回答「那一版到底是什么」。
只有后者能让一年后的溯源链闭合：同一个 `(skillId, 1)` 在两台机器上可能是两份不同的
Prompt，而 digest 不会说谎。

**已产生运行记录的版本不得原地覆盖。** 加载器在启动时比对 digest：某个
`(skillId, skillVersion)` 已经被历史 Run 引用，而磁盘上的内容变了 → **拒绝加载并
指出冲突**，要求作者升版本号。这是 ADR-0056 决策 6 的可执行化：从「请显式修订」
变成「不显式修订就跑不起来」。

### 决策 4：Skill 只产生**提案**

一个 Skill 的输出只能成为 Proposal。**它不能定稿、不能锁定、不能付费、不能导出。**
这不是 UI 约定：`skillapply` 的动作词汇表里没有这些动作，Run 的 `kind` 恒为
`skill`，付费 `kind` 走的是另一条完全不同的路（合同 §5.9b）。

这条与 ADR-0066 决策 6 的四条禁令是同一件事，在这里落到能力层：
**可安装的第三方能力，绝不能因为「装了一个 Skill」而获得花钱或定稿的权限。**

### 决策 5：`skills.js` 降为加载器与兼容层

二十个定义迁进 `product-skills/builtin/`。`skills.js` 保留它今天的**公开函数**
（`findSkill` / `missingInputs` / `compilePrompt` / `SKILL_INPUTS` / `isShotScoped`），
但它们从加载结果读取，而不是从文件里的常量数组读取。

`prompt-director`（v1）**降级为 deprecated 兼容项**：ADR-0056 决策 6 不允许删除
历史 Run 指向的定义，但它已经不是任何入口的能力。deprecated = 仍可加载、仍可被历史
Run 指向、**不出现在任何「让 Agent 处理」列表里**。

### 决策 6：五个旧端点与前端共用同一套定义与编译器

`/api/agent/*` 的五个创作端点不再自带 Prompt 与解析器，改为读同一批 Skill 包，
用同一个编译器与同一份 `output.schema.json`。**新增 `episode-planner`** ——
`skill.episode-plan` 这个 taskType 在批次一被刻意与目录解耦，正是为了让这个决定
可以留到现在做，而 key 不必改（合同 §5.9b）。

### 决策 7：加载或校验失败一律 fail-closed

manifest 不合法、schema 不合法、digest 冲突、目录缺文件 → **该 Skill 不可用，
并说明原因**。绝不「尽力加载一部分」：一个字段缺失的能力跑出来的东西，看起来和
正常结果没有区别。

一个来源整体加载失败不影响其它来源；但一个 `skillId` 在优先级更高的来源里损坏，
**不回退到低优先级的同名 Skill** —— 那会让创作者以为自己的定制在生效。

## 后果

### 正面

- 创作者第一次可以拥有自己的能力，而不必改仓库。
- 溯源链闭合：`skillDigest` 让「这份剧本是哪一版 Prompt 写的」有确定答案。
- 一个能力一份定义：前端与五个端点不再各写各的。

### 代价

- 加载从「import 一个常量」变成「读盘 + 校验 + 冲突检测」，启动路径变长，且多了
  一类新的失败（可加载性）。这正是决策 7 要求 fail-closed 的原因。
- `product-skills/` 是仓库里的新顶层目录。
- 用户 / 项目 Skill 的 Prompt 是**用户撰写的文本**，会被内联进发给执行器的提示词。
  这与今天内联剧本文本是同一个注入面，安全姿态不变（工具全关、中立 cwd、
  无路径跨界，ADR-0056 决策 2），但**不因为「这是本地文件」就放松**。

## 明确不做

- 不做 Skill 市场、不做远程安装、不做自动更新。
- 不让 Skill 声明新页面（ADR-0066 决策 1 的封闭集合不变）。
- 不让 Skill 获得付费、定稿、锁定或导出能力（决策 4）。
- 不改 `CURRENT_LEVEL`（仍为 `suggest`）。
- 不改 Run 合同的任何状态或字段语义 —— 只新增 `skillDigest`。
