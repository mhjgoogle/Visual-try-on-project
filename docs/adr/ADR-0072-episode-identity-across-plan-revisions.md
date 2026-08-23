# ADR-0072：分集规划改版时剧集身份跟着走；历史空壳软归档，不删除

- 状态：**Accepted（2026-08-17，实施 Agent）**
  —— 技术 ADR（身份、持久化、迁移语义），Accept 权按 CLAUDE.md「ADR 的 Accept 权」
  在实施 Agent。**不涉及付费**，**不做不可逆删除**（本 ADR 的全部动作都是加法字段
  与可回退的归档态），因此不需要产品负责人 Accept。
  规则来源是产品负责人 2026-08-17 的原话，见「背景」。
- 实施：[TASK-094](../tasks/done/TASK-094-story-development-chain.md) 批次 **A**（成因）
  与批次 **G**（历史数据）
- 相关：[ADR-0054](ADR-0054-production-upstream-workspace.md)（规划版本 → 确认 → 建立剧集）、
  [ADR-0067](ADR-0067-product-skill-package.md)（Skill 只出提案）、
  [AGENTS.md 第 13 条](../../AGENTS.md)（禁止静默覆盖；删除做成软删除）

---

## 背景

### 产品负责人看到的事实

> 「目标集数只有 24 集分集规划竟然设计了 48 集」

真实项目 `照见未明rev2`（2026-08-17 实测）：

| 数字 | 值 | 出处 |
| --- | --- | --- |
| 创意里的目标集数 | 24 | `story.brief` |
| 每一版规划的条数 | 12 | `story.plans[*].episodes.length` |
| 规划版本数 | 4 | `story.plans.length` |
| **实际建立的剧集实体** | **48** | `production.episodes.length` |

4 × 12 = 48。**每确认一版规划就新建 12 集，一集都不复用。**

### 成因：提案一律不带身份，于是确认时全是「新的」

`storydoc.completeDevelop`：

```js
// A PROPOSAL never carries episode identities: episodeId is stamped ONLY at
// confirm time by the caller. Agent output smuggling an existing episodeId
// must not be able to silently link/rename that episode on confirmation.
const proposal = sanitizePlanEpisodes(payload).map((e) => ({ ...e, episodeId: null }));
```

**这条安全性质是对的，必须保留**：模型的答案里出现一个已存在的 `episodeId`，
不得因此静默改名/接管那一集。

但它导致的后果是：`applyProposal` 产生的每一版规划，其条目的 `episodeId` 全是
`null`；`confirmPlan` 看到 `null` 就 `addEpisode`。于是「改一版规划」在实体层面
等于「再造一部剧」。

### 产品负责人给的规则

> 「A『确认规划』时，已经存在的剧集该被更新」

---

## 决策

### 决策 1 — 身份由**系统**从基线版本推导，永远不从模型答案里读

修订一版规划时，新版本的每一条继承**基线版本对应那一条**的 `episodeId`。基线是
`beginDevelop` 在**发起时**记下的 `pending.basedOn`。

因此 `completeDevelop` 那条「提案不带身份」的规则**原样保留**：模型答案里的
`episodeId` 仍然被清空。身份是在 `applyProposal` 里由**文档自己**补上的 ——
它读的是 `doc.plans` 里的基线，不是 payload。**模型无法命名任何一集。**

#### 1a. 「是不是修订」只判断一次（`planRevisionBase`）

**「有修改要求 + 屏幕上有一版规划」= 修订；否则 = 重新写一版。**
这个判断由 `storydoc.planRevisionBase(doc, instruction)` 给出，**三层共用同一个
答案**：客户端据它决定要不要把当前规划发出去；`beginDevelop` 据它决定
`basedOn`；后端的 `_is_revision` 据同样的两个条件选 writer / reviser 包。

> 独立审查（codex，批次 A 第 2 轮）报的正是这条的反面：后端按
> 「当前规划 + 修改要求」选包，而文档只按 `activePlan` 继承身份 —— 于是
> **「🪄 重新规划」写出的一版全新规划也会继承旧身份**，确认后把已有 12 集就地
> 改名，每一份已写的剧本都留在一个不是为它写的规划条目下面。
> 「一个模式有两种定义」正是 `_is_revision` 当初被建立起来要消除的东西。

#### 1b. 匹配用**答案自己声明的** `epNumber`，且必须构成干净映射

`sanitizePlanEpisodes` 会把 `epNumber` 稠密化成数组位置，所以**存下来的那个
`epNumber` 不能作为连接键** —— 按它匹配等于按位置匹配，而 reviser 把同样 12 集
换个顺序返回时，就会把 EP01 的身份贴到 EP02 的内容上。

> 这也是独立审查（批次 A 第 1 轮）报的 blocking finding 之一。

所以连接键是**答案自己给出的** `epNumber`（reviser 的 prompt 明确要求它保持不变），
它以 `claimedEpNumber` 挂在**瞬态** `pending` 上，进文档前被剥掉 ——
它是一个**待核对的声明**，不是一个要存的事实。

**声明不干净时，一条都不继承**（全有或全无）：缺号、重号、非正整数一律视为
「说不清」。两种错误不对称：

| | 后果 |
| --- | --- |
| 接错集 | 一份剧本悄悄挂到别的一集下面，**没人看得出来，事实上不可逆** |
| 一条都不接 | 多建几集，**看得见**，而且可归档（决策 4） |

因此说不清时降级为「这些是新的集」，并由界面**明确说出来**（`applyProposal` 的
提示语），沉默会把 48 集那个意外原样重演。

### 决策 2 — 比基线长的部分**没有**身份；比基线短的部分**不删除**

- 新版本第 N+1 条起（基线只有 N 条）→ `episodeId: null` → 确认时新建。
  真的多规划了几集，就该多几集。
- 基线里被新版本丢掉的那些条目 → **对应剧集实体保留**，只是不再被这一版引用。
  它们可能已经有剧本、分镜、资产。**删除它们是不可逆的，禁止**（AGENTS.md 第 13 条）。
  界面如实说明「这一集不在当前规划版本里」，而不是假装它不存在。

### 决策 3 — 手工保存（`savePlanDraft`）本来就带身份，不变

草稿是从基线 `{...e}` 复制出来的，`episodeId` 一直在。这条路径**没有**这个缺陷；
本 ADR 只修 AI 提案那条路径，两条路径由此**汇合到同一语义**。

### 决策 4 — 归档是**加法字段 + 可回退的状态**，不是删除

`production.episodes[i].archived`：

```
archived: null                                  // 常态
archived: { at: "<ISO8601>", reason: "<为什么>" } // 已归档
```

- **缺失 / null 合法**（早于这个字段的文档就是没有它）；
- **存在但形状不对 → 整份文档拒收**（`canvasschema.js` 的 `additivePresent` 规则）；
- 因此**不升 canvas schema 版本**，与既有加法字段同一标准。

归档态的语义：

| | 归档后 |
| --- | --- |
| 文档里 | **仍然在** `production.episodes` 里，位置不变 |
| 按 id 解析 | **仍然可解析**（历史 Run / 剧本 / 提案指向它，不得变成悬空引用） |
| 分集规划 / 剧集列表 | **不显示**（除非显式「显示已归档」） |
| 取消归档 | **随时可以**，把字段置回 null 即可 —— 这是敢做这一步的前提 |
| `activeEpisodeId` | **不得指向已归档的一集**；若是，先改指向再归档 |

### 决策 5 — 归档前的「真的是零内容」由**引用扫描**判定，不由规划表判定

规划表上的空 **不是**证据。判据是这一集的 `episodeId` 在整份文档里**除了下面两处
之外没有任何出现**：

1. `production.episodes[i].episodeId` 自己；
2. `story.plans[*].episodes[*].episodeId`（规划条目的联结）。

出现在**任何**其它位置——`scripts` 映射的键、`timelines`、`shotAudio`、
`subtitles`、`prompts`、`refUse`、`frameBindings`、`generations`、`locks`、
`reviews`、`skillRuns.context`、`production.shotProduction`——即视为**有内容**，
**不归档**，并如实列出来交给产品负责人看。

为什么用全文档引用扫描而不是手写一张登记表清单：**手写清单会漏**，而本仓库反复
栽的就是「守卫看起来加了，其实只覆盖了一半」。扫描的漏报方向是**偏保守**的
（多留一集，不是多删一集），这个方向的错误是可接受的。

另外三条硬约束：

- 该集 `scenes` 必须为空（有场景就有下游镜头）；
- 该集不得是 `activeEpisodeId`；
- 该集不得被**已确认**的那一版规划引用（那是创作者当前正在用的 12 集）。

### 决策 6 — 一次性收口先在副本上跑，前后对比进报告

历史数据的批量归档在**真实项目的副本**上先跑一遍，把前后计数与逐集判定贴进任务
报告，再动本体（TASK-094 §5）。本体操作前保留一份可回滚的副本。

---

## 后果

**好的**：

- 「用 AI 改规划」在实体层面真的是改：12 集还是 12 集，已写的剧本仍然挂在原来那一集上。
- 三个数字（目标集数 / 本版条数 / 已建立集数）第一次有可解释的关系。
- 历史 48 集可以收敛到 12 集**而不删除任何东西**，且随时可回退。

**代价 / 风险**：

- `applyProposal` 现在会写 `episodeId`，而它以前不写 —— 这是本 ADR 唯一的行为
  变化点，也是批次 A 审查的重点。安全性质靠「身份来自文档、不来自 payload」保住。
- 归档态是一个新的可见状态，所有列剧集的界面都要决定显示不显示。本链只处理
  分集规划与剧集列表；其它页面按「按 id 仍可解析」继续工作。
- 引用扫描是保守的：一个 `episodeId` 出现在某处无关紧要的缓存里也会阻止归档。
  宁可留着。
