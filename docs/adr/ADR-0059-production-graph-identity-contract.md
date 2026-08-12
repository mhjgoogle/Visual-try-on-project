# ADR-0059：生产图身份合同（Story/Canon → Director → Skill → Proposal → Generation → Asset → QC → Final）

- 状态：Accepted
- 日期：2026-08-12
- 关联：[ADR-0052](ADR-0052-workflow-page-as-derived-provenance-graph.md)、
  [ADR-0055](ADR-0055-unified-asset-registration.md)、
  [ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)、
  [ADR-0057](ADR-0057-shot-production-state-and-dailies.md)、
  [ADR-0058](ADR-0058-production-memory-library-and-episode-production.md)、
  [TASK-062](../tasks/TASK-062-integration-production-graph.md)

## 1. 背景

到 ADR-0058 为止，七个层次各自成立、各自有测试：

    Story/Canon · AI Director · Skill Run · Proposal · Generation Input
    · Generation · Asset · Shot QC · Timeline/Final · Workflow Provenance

但它们**没有被一条真实的身份链贯通**。审阅现状后，四项已经成立：

| 已成立 | 依据 |
| --- | --- |
| Generation → Asset 的 canonical linkage | `resultAssetIds` + 资产的 `links.generationId` 回链 |
| QC 绑定具体 take 而不是镜头 | ADR-0057 的 `isApprovedFor(shotId, videoAssetId)` |
| 溯源图是 derived read model | `buildProvenanceGraph` 每次重算，拓扑从不持久化 |
| canonical story 不复制进 Asset / Skill | skill context 按需组装，资产只存 links |

六项不成立：

1. **Skill Run 没有结构化的 target context。** 它只有 `inputSummary`——一个人读的
   字符串（「EP01 · S02 · 4 个镜头」）。字符串不能被追溯：无法回答「这次运行读的
   是哪一集、哪一场、哪一个镜头」。
2. **Proposal 没有身份。** 它是 run 上的一个内嵌对象，没有 id，因此别的记录无法
   引用它。
3. **Generation 不知道自己从哪来。** 没有任何字段指向触发它的 skill run 或 proposal。
4. **溯源图缺左半边。** 图从「剧本」开始；Canon / Director / Skill / Proposal
   这一整段不在图上。
5. **Director 的读模型不统一。** 每个 module 各读各的，没有一个模型能同时读到
   QC 与 Final，也不暴露它据以判断的 context id。
6. **旧记录没有 unknown 语义。** 迁移若回填，等于凭空发明历史。

## 2. 决策

### 决策 1：三个新的身份字段，全部增量、全部可为 null

canvas schema v13 → v14，纯增量：

```
skillRun.context   = { episodeId, sceneId, shotId }    未记录 → null
skillRun.proposal  += proposalId                       旧提案 → null
generation.origin  = { skillRunId, proposalId }        旧生成 → null
```

- **`context` 是 ID，不是叙述。** `inputSummary` 保留（它给人看），但可追溯性
  由 id 承担。运行未限定到某一层时该层为 null——一次整集的 Continuity 检查
  没有 shotId，这是事实，不是缺失。
- **`proposalId` 在提案产生的那一刻铸出**，与它所属的 run 同生共死：提案在这个
  系统里没有独立于 run 的生命，单独建一个 proposals registry 只会多出一份需要
  保持同步的东西。
- **`origin` 在 launch 时冻结**，与 Generation 的其它输入字段一致：一个迟到的
  结果不会改写它启动时的来历。

### 决策 2：只在显式路径上写 linkage，绝不按邻近推断

`origin` 只有当一次 production action **确实从某个 proposal 发起**时才写。

系统**不**根据「时间接近 + 同一个 context」把 generation 认给某个 proposal。
那是猜测，而一条猜出来的血缘比没有血缘更糟：它看起来像记录。

同理，接受提案后写入 canon（改剧本、换分镜草稿）**不额外记 linkage**——
canon 文档本身就是那个结果，再记一条只会产生第二份会漂移的真相。

### 决策 3：Canon 锚点是剧集的 basedOn 基线

图最左端每个剧集一个 `canon` 节点，内容是该剧集的 `basedOn` stamp
（创意 v1 · 大纲 v2 · 人物 ×3 · 世界观 v1）——`canondoc` 已经在维护这个 stamp，
它是真实数据，本 ADR 不新增任何存储。

不为每个上游面各建一个节点：那会把最左列变成 5+ 个节点，而多出来的信息
（「本集依赖了哪几个人物」）在 Inspector 里一行就能说清。

### 决策 4：溯源图补齐左半边，仍然全部 derived

新节点类型 `canon` / `skillRun` / `proposal`，新边：

```
canon ──baseline──▶ skillRun ──proposal──▶ proposal ──origin──▶ generation
```

- 三者都从既有记录重算，**拓扑一行都不持久化**（ADR-0052 决策不变）。
- 一个 run 的 `context` 为 null 时，它在图上仍然存在，但**明说「未记录上下文」**，
  不挂到任何剧集下面。
- `origin` 为 null 的 generation 照常显示，它的左边就是空的——那是诚实的
  「不知道」，不是断链。

### 决策 5：Director 统一 Production 读模型

新增 `productionModel(ctx)`：一次读齐 Story · Episode · Scene/Shot · References ·
Generations · Assets · QC/review · Final，并**把它读到的 context id 一并返回**
（`context: {episodeId, sceneId, shotId}`）。

- Director 的 observation / decision 因此可以被追溯到它当时读的是哪一集哪一个镜头。
- 它是**读模型**：不写任何文档，不新增页面。既有的 `directorModel` 继续负责
  per-module 的主动作，改为在这个统一模型之上取数。

### 决策 6：缺失就是缺失

旧记录迁移后 `context` / `proposalId` / `origin` 一律为 null，界面显示
「未记录」。**不回填、不按剧集猜、不按时间猜。**

## 3. 后果

### 正面

- 「这一帧为什么长这样」第一次能一路回答到 Canon：
  基线 → 哪次 Skill 运行 → 哪份提案 → 哪次生成 → 哪个资产 → 谁通过了审片 → 进了哪版成片。
- Skill 运行可按剧集/场景/镜头检索，而不是靠读那句人写的摘要。
- Director 的判断有据可查。

### 负面 / 成本

- schema v14 迁移一次；旧项目的这三个字段全是 null，图上左半边对历史记录是空的。
- 溯源图再向左长两列，宽屏之外横向滚动更明显。

### 明确不做

- 不接 Media API Provider、不做 global/shared Asset Library。
- 不做 project rename / move / export、不做 TASK-056、不做 asset path 迁移。
- 不碰 TASK-049 / 050 / 052 的工装。
- 不新增页面功能——本 ADR 只贯通已有的东西。
