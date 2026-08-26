# ADR-0087：文档生命周期与默认 Agent 上下文 —— 当前事实精简，历史可追溯

- 状态：Accepted
- 日期：2026-08-26
- 决策者：产品负责人下发目标（2026-08-26），实施 Agent 依 AGENTS.md §1
  「ADR 的 Accept 权」自行 Accept 技术形状
- 关联：[REQ-002](../requirements/REQ-002-document-lifecycle.md) ·
  [TASK-107](../tasks/active/TASK-107-document-lifecycle.md) ·
  [ADR-0083](ADR-0083-docs-partitioned-by-completion.md)（目录即状态，本 ADR 扩展它）·
  [ADR-0076](ADR-0076-dev-workflow-operating-skill.md)（REQ 记录与 dev-workflow）·
  [ADR-0077](ADR-0077-repository-path-ownership.md)（仓库路径所有权）

## 1. 背景

产品负责人 2026-08-26：

> 「Current truth remains small. History remains traceable.
> The repo converges instead of accumulating forever.」
> 「目标不是简单整理一次目录，而是以后所有开发任务都自动遵守。」

ADR-0083 已经用「目录即状态」解决了**任务卡**这一类。盘点 217 份文档后，
剩下四个洞仍在按老方式漂移：

| 洞 | 实测证据（2026-08-26 盘点） |
| --- | --- |
| **ADR 没有取代状态** | 70 条 ADR 全部写着 Accepted，而 ADR-0060 的分档语义早被 ADR-0080 取代、ADR-0069 的轮次预算早被 ADR-0081 取代。取代关系只写在**新 ADR 里**，读旧 ADR 的人看不到 |
| **当前架构事实要靠遍历 ADR 推导** | 「现在的模块边界 / 依赖方向 / 前后端合同是什么」没有一份短文档回答，只能读 70 条 ADR + 70KB 的 `creator-system-contract` |
| **已完成记录仍在默认路径上** | `pending-codex-rereview.md` 35KB，其中未闭合条目为 **0**，却是 AGENTS.md §22 规定的 merge 前必读 |
| **`active/` 混着「没在做的」** | 7 张在办卡里 TASK-011 / TASK-012 是「Outline，可选 WFM3 升级」，从未开工也没人在做 |

共同根因与 ADR-0083 相同：**一个事实的载体如果是「文字」，它就要靠人记得改。**
ADR-0083 把「完成没有」换成了目录；本 ADR 把剩下四件事分别换成
**目录、双向链接、派生索引和可执行守卫**。

## 2. 决策

### 决策 1：每份文档属于三类之一，判据是「它回答什么」

| 类 | 它回答什么 | 处置 |
| --- | --- | --- |
| **A. Current Truth（当前事实）** | 「现在是什么 / 现在要做什么」 | 保持精简、持续更新、**默认加载** |
| **B. Historical Evidence（历史证据）** | 「当时为什么这么定 / 当时发生了什么」 | 永久保留、**默认不加载**、按需读 |
| **C. Temporary Artifact（一次性产物）** | 「这一次我是怎么查/怎么试的」 | 任务结束时**删除**，有长期价值的先提炼进 A 或 B |

判据不是「重不重要」，而是**它过期时会不会骗人**：A 类过期就是缺陷（会让下一个
人做错事），B 类不会过期（它记的是当时），C 类过期了也没人读 —— 所以 C 类应当
消失，而不是变成"以后可能有用"的沉淀。

**「先都留下」不是节省，是把成本转嫁给之后每一次读。**

### 决策 2：四种记录，各自的生命周期与**状态载体**

状态载体只有三种：**目录**（不会忘）、**状态行 + 双向链接**（写在被取代的一方）、
**派生索引**（`docs/STATUS.md`，不手写）。

| 记录 | 状态机 | 载体 | 取代时怎么办 |
| --- | --- | --- | --- |
| **Requirement**（`docs/requirements/REQ-*.md`） | `DRAFT` → `CONFIRMED` → `SUPERSEDED` | 文件内状态行 | **不篡改旧版**：同文件追加 `v2 · supersedes v1`，v1 标题补「（superseded by v2）」，内容一字不动；整份 REQ 被**另一个 REQ** 取代时状态改 `SUPERSEDED` 并写明取代者 |
| **Change / Task**（`docs/tasks/**/TASK-*.md`） | `backlog/` → `active/` → `done/` | **目录**（ADR-0083 决策 1，本 ADR 增加 `backlog/`） | 目标被后续决策取代 → 进 `done/`，状态行写「退役（被 X 取代）」，不删卡 |
| **ADR**（`docs/adr/ADR-*.md`） | `Proposed` → `Accepted` → `Superseded` / `Rejected` | 文件内状态行 + **双向链接** | 见决策 3 |
| **Temporary Artifact** | 无状态机 | 无 | 见决策 6 |

`backlog/` 是本 ADR 对 ADR-0083 的唯一扩展：`active/` 必须只代表**正在进行**的
工作，否则「还欠什么 = `ls active/`」这条结论会连同没人在做的卡一起被读成待办。
**三个目录，不再多**（`done/` 已经是终点，不做按年份/按里程碑的二级归档）。

### 决策 3：ADR 的取代关系是**双向**的，且旧 ADR 永不删除

被取代的 ADR：

```
被取代方：  - 状态：**Superseded**（日期）—— 由 ADR-0080 取代 <哪一部分>
取代方：    - **取代**：ADR-0060 的 <哪一部分>
```

两侧都写成 markdown 链接（上面的示例故意不带链接，免得它自己变成一条断链）。

**两侧都必须是带标签的头部字段**（`状态 / Status / 取代 / Supersedes /
Superseded by / Partially superseded by`），不能只在正文里提一句 —— 「讨论历史时
引用旧 ADR」是最常见的提及方式，把「提到」当成「声明」等于让守卫在它要守的东西
上变绿。反过来，**没有标签的散文不算声明**：ADR-0006 写的
「TASK-010 后由 TASK-016/017 取代；……由 ADR-0008/0009 延续」被取代的是 TASK，
ADR-0051 写的「**无决策被取代。**」是一句否定 —— 关键词匹配会把两者都读成声明。

**部分取代**写成「Accepted（决策 1/2/3 保留）；决策 4 被 ADR-00XX 取代」——
本仓库已有四例（ADR-0001/0010/0052/0064）用的就是这个写法，本 ADR 只是把它
定为规则并补上缺失的反向链接。

**旧 ADR 不删。** 它回答的是「**当时**为什么这么定」，这个问题永远有效；删掉
它，下一个人只会把同一条弯路再走一遍。

### 决策 4：当前架构事实单独成文，与 ADR 分开

新增 [`docs/current-architecture.md`](../current-architecture.md)：**只写现在成立
的东西** —— 模块边界、前后端合同、依赖方向、测试归属、当前架构约束，每条一行，
后面挂一个「依据 ADR」链接。

- **ADR = WHY / HISTORY**（为什么当时这么定，永久保留）；
- **current-architecture.md = WHAT IS TRUE NOW**（现在是什么，过期即缺陷）。

两者**不合并**：合并的结果要么是 ADR 被改写（历史丢失），要么是当前事实里混着
已被取代的段落（正是决策 1 说的「过期就骗人」）。

它是**索引，不是副本**：细节留在既有合同文档里（`creator-system-contract.md`、
`workflow-stage-step-io-contract.md`、`architecture.md`…），这份只回答
「现在有哪些边界、每条边界的权威在哪」。**目标长度 ≤ 200 行**，超了说明在抄细节。

### 决策 5：默认 Agent 上下文（硬要求）

开发任务默认只加载：

| 默认加载 | 具体 |
| --- | --- |
| 规则 | `AGENTS.md`（`CLAUDE.md` 是它的入口） |
| 当前需求 | 当前 Change 关联的 `REQ-*`（或任务卡的「依据」行） |
| 当前架构 | `docs/current-architecture.md` + 它指向的、与本次改动相关的那一份合同 |
| 当前工作 | `docs/tasks/active/` 里**本次**这一张卡 + `docs/STATUS.md` |
| 代码与测试 | 影响范围内的 |

**默认不加载**：`docs/tasks/done/`、`docs/design/done/`、`docs/reports/`、
历史 ADR（未被 current-architecture 指向的）、被取代的 REQ 版本、
`docs/auto-push/changes/` 的历史清单。

只有五种情形才按需读历史：**回归调查 / 架构理由（why-was-this-done） /
历史冲突 / 需求演化 / 复现一次旧决策的边界**。

> Historical records exist, but historical records do not consume normal
> development context.

### 决策 6：一次性产物默认删除，提炼优先于保留

scratch notes、临时实施计划、调试记录、agent 原始对话、一次性调查笔记、
过期迁移清单、中间生成文档、被放弃的原型笔记 —— **任务结束即删**。

有长期价值的，**先提炼进 REQ / 任务卡 / ADR / current-architecture，再删原件**。
提炼后的那几行才是价值，原始材料不是。

三条配套约束：

1. **临时产物不进 `docs/`**。写在 `.claude/tmp/`（已 gitignore）或会话 scratchpad；
   要进 `docs/` 的东西，写的时候就得是 A 类或 B 类。
2. **不建影子实现**：`old/`、`old2/`、`legacy-copy/`、`backup/`、
   `deprecated-but-kept/` 一律不留 —— 代码历史由 Git 承担。
3. **obsolete 测试与文档**：不再代表当前有效行为的，**删除或更新**，不留着当
   「兼容测试」。测试保护 Current Valid Behavior，不保护 Historical Behavior
   （dev-workflow 收敛清单既有条款）。

### 决策 7：收敛闸门是**可执行守卫**，不是又一份清单

`.claude/tools/lifecycle_check.py` 把决策 2/3/5 里能机器判定的部分变成断言，
由 `tests/tooling/test_lifecycle_check.py` 在**归属域测试**里跑 —— 于是它
自动出现在每次工装改动的 commit gate、每次 merge 前的最终全量里，
**不需要任何人记得执行**。

守的六件事：

1. `active/` 里没有状态写着「完成 / Done」的卡（完成却没搬走）；
2. ADR 的取代声明**双向可读且方向不矛盾**：一侧的带标签字段声明了关系，另一侧
   必须也有带标签字段声明它（仅正文提及不算），被指向的 ADR 存在，且两侧不能
   **都**声明自己取代对方（`取代 / Supersedes` 是正向，`被取代 / Superseded by`
   是反向，`状态` 行两读皆可因此不参与方向判定）；
3. `docs/requirements/index.md` 与 REQ 文件**一一对应**：链接指向自己那份 REQ、
   无重复行、索引行与文件都写了状态且两处一致（**缺状态不算通过** —— 守卫在
   记录残缺处沉默，等于没有守卫）；
4. 跟踪中的 `docs/` 里没有临时产物文件名（`scratch` / `tmp` / `wip` /
   `debug-` / `notes-` / `untitled` / `-copy`）；
5. 没有影子目录（`old*` / `legacy-copy` / `backup` / `deprecated*`）；
6. `docs/current-architecture.md` 存在且 ≤ 200 行（决策 4 的长度纪律）。

**为什么是测试而不是清单**：ADR-0083 决策 3 已经验证过一次 —— 一个「必须记得
更新」的索引和一个「必须记得执行」的清单，是同一个缺陷；只有派生与守卫不会忘。

判不了的一律**不判**（例如「这份文档是不是已经没价值了」），留给决策 8 的人工
收敛检查，宁可漏报也不误杀。

### 决策 8：接进既有节奏，不新建 Skill

- **dev-workflow 第 9 步（收敛）** 增加一节「仓库收敛」（文档面的六问）；
- **dev-workflow 第 10 步（Done）** 增加：卡搬家 → 生命周期清理 → 重新生成
  STATUS.md，三件一起做；
- **auto-push merge 前**（AGENTS.md §22 的前置链）增加一条：`lifecycle_check`
  通过 —— 它已含在最终全量里，所以这条是**声明**，不是新增动作；
- **不新建「文档清理 Skill」**（产品负责人 2026-08-26 明确要求）：清理是
  Development Lifecycle 的一部分，单独成 Skill 就等于允许「这次先不清」。

## 3. 后果

- **好的**：当前事实是四份短文档（AGENTS.md / current-architecture.md /
  STATUS.md / 本次那张卡），其余全部按需读；被取代的决策从旧 ADR 那一侧也看得见；
  漏搬、漏链、临时文件堆积会当场转红。
- **要接受的**：每个 Change 收口时多一次 `lifecycle_check`（秒级，已在测试里）；
  ADR 取代关系要改两个文件而不是一个 —— 这正是能被读到的原因。
- **不做的**：不按年份/里程碑做二级归档，不给每张卡建 metadata 文件，
  不做文档数据库。三个目录 + 状态行 + 双向链接足够。

## 4. 落地

| 位置 | 动作 |
| --- | --- |
| `docs/current-architecture.md` | 新增，当前架构合同（WHAT IS TRUE NOW） |
| `AGENTS.md` §8 | 新增条款 24–26（生命周期三分类 / 默认上下文 / 临时产物） |
| `docs/tasks/backlog/` | 新增；TASK-011、TASK-012 迁入 |
| ADR-0060 / ADR-0069 | 状态改 `Superseded by`，ADR-0080 / ADR-0081 补「取代」行 |
| `docs/design/active/` | 已完成的评审记录与规划基线迁入 `done/`；待复审清单只留活账，已闭合历史迁入 `done/` |
| `.claude/tools/lifecycle_check.py` | 新增守卫（`--check`） |
| `tests/tooling/test_lifecycle_check.py` | 新增断言 |
| `.claude/tools/gen_docs_status.py` | 认识 `backlog/`；STATUS.md 增加「默认加载什么」一节 |
| `.claude/skills/dev-workflow/` | `references/lifecycle.md` 新增；SKILL.md 第 9/10 步接线；`records.md`、`repo-contract.md` 更新 |
| `.claude/skills/auto-push/SKILL.md` | merge 前置链补一行（声明，非新动作） |
