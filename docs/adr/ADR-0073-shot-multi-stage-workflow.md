# ADR-0073：Shot 从线性状态机升级成带依赖的多 Stage 工作流

- 状态：**Accepted（2026-08-18，实施 Agent 依 CLAUDE.md「ADR 的 Accept 权」自行 Accept）**
  —— 本 ADR 是**架构 + schema + 跨层合同**，属技术范畴；它**不涉及付费口径**，
  也**不不可逆动用户数据**（唯一的新增持久状态是加法字段，旧存档一个字节不改）。
- 依据：产品负责人 2026-08-17 的原话（逐字见
  [TASK-092 §0](../tasks/TASK-092-shot-workflow-multi-stage.md)）
- 实施：[TASK-097](../tasks/TASK-097-episode-production-chain.md) 批次 1
- 相关：[ADR-0057](ADR-0057-shot-production-state.md)（批准绑在产物上、其余派生）、
  [ADR-0061](ADR-0061-three-spaces-and-reference-roles.md) 决策 4、
  [ADR-0072](ADR-0072-episode-identity-across-plan-revisions.md) 决策 4（软归档的形状）

---

## 背景

`shotprod.js` 的 `shotStage` 是一条**派生的线性链**，5 档：

```js
if (m.video && isApprovedFor(prod, shotId, m.videoAssetId)) return "approved";
if (m.video)          return "todo-review";
if (m.image)          return "generated";
if (isDesigned(shot)) return "todo-generate";
return "todo-design";
```

产品负责人指出三个问题，它们都是同一条链的必然后果：

| 问题 | 后果 |
| --- | --- |
| 分不清 Storyboard 与 Keyframe | `m.image` 存在即 `generated` —— 一张低成本草图与一张正式关键帧在状态机眼里是同一件事 |
| 声音不在链上 | 一个镜头可以 `approved` 而完全没有配音 —— 状态说做完了，实际没有 |
| 没有「按设计跳过」 | 轻量模式跳过 Storyboard 会被当成缺失，而不是一个决定 |

> 「**这是我认为现在最值得改的地方：把 Shot Workflow 从『线性状态机』升级成
> 『带依赖关系的多 Stage Workflow』。**」

---

## 决策

### 决策 1：六个 stage，各自有状态

```
storyboardStatus / keyframeStatus / videoStatus / voiceStatus / sfxStatus / qcStatus
```

四态词汇**一个不改**（产品负责人给定）：
`not_started` / `in_progress` / `completed` / `skipped`。

三组，Visual 内部串行、三组之间不串行：

```
Visual   Storyboard → Keyframe → Video     串行
Audio    Voice · SFX                        与 Visual 并行
QC       Approval                           两组都就位后
```

### 决策 2：**按「谁才知道」决定存还是派生**（本 ADR 最重要的一条）

产品负责人的四态词汇保留，但它们的**来源**必须分开，否则我们在 Shot 这一级
重造 TASK-077 修过的那个谎：`storageState` 声明「文件在」而从不与磁盘核对，
于是存储页报「媒体不可用 0」而实际丢了两个文件。

| 状态 | 来源 | 理由 |
| --- | --- | --- |
| `not_started` | 默认 | 无证据、无决定 |
| `in_progress` | **派生**：有在途 Run | **存储的 `in_progress` 在崩溃后会永久说谎** |
| `completed` | **派生 + 要证据**：产物存在，且探针没有判定它 MISSING | 唯一能防漂移的做法 |
| `skipped` | **存储** | 只有人 / Workflow 的决定能知道 |

**只有 `skipped` 是真正新增的持久状态。** 其余三个是把已有证据读成一个词。

这也决定了一条硬约束：**`completed` 不得写入文档**。一个被写下来的
「做完了」会在产物被删除、被换版本、被探针判定 MISSING 之后继续说做完了——
而那恰恰是本仓库已经付过学费的那一类。

### 决策 3：`approved` 不进四态枚举，复用既有机制

产品负责人的闸门条件用了 `approved`，但系统里已经有它的正确位置——
`shotprod.js` 的 `isApprovedFor(prod, shotId, assetId)`：**批准独立存储，
而且绑在具体那个产物上，不是绑在 stage 上。**

这个先例是对的：批准的是**这一张图**，换了图批准就该失效。
所以 **Storyboard 的批准 = 那张草图上的一条 approval 记录**，
不是 `storyboardStatus = "approved"`。

把 `approved` 塞进 stage 枚举会立刻产生第二份批准真相，并且是不绑产物的那一份。

### 决策 4：依赖关系是**数据**，不是散在各处的 `if`

一张 `stage → 前置条件` 表。Keyframe 的闸门按产品负责人的原话：

```
Keyframe 可启动 ⟸ storyboardStatus == skipped
                 OR （storyboardStatus == completed 且那张草图已 approved）
```

**不是** `completed` 单独成立就放行。

以后加 Lip Sync / BGM / Retake **只是加一行**，判定代码不动——这正是产品负责人
要的「不会把整个状态机推翻」，并且它是**可测的**：加一个假 stage 只需加一行。

**闸门不置灰导航**（既有纪律）：那一步仍可进入，但主行动显示前置未满足及**为什么**。

### 决策 5：Audio 组**不以 Video 完成为前置**

产品负责人：「**画面生成和音频准备部分并行，最后再合成**」。
Audio 的前置是「台词已确认」，不是 video。把 video 写成它的前置，会让
「音频可以先准备」这句话在界面上不成立。

（配音的声音身份仍强制来自角色基础声音档案，`bibledoc` 三重强制，**不变**。）

### 决策 6：`shotStage` 降级为**汇总**，三个消费者一行不改

`shotStage` 保留，仍是故事板审片 / 镜头制作 / ⑦ 分镜表那三处的唯一汇总来源，
但从「一条线性链」改成「**从六个 stage 汇总出来的一个字**」。

- 汇总规则写在一处，可测。
- 六个 stage 也从 `prodgraph` / `shotprod` / 生成登记 / 探针读，**不新建第四份真相**
  （TASK-079 那条守卫继续成立）。
- 三个消费者的调用签名不变，既有断言全部继续通过。

### 决策 7：`storyboard` 与 `keyframe` 是两个新的 asset kind

否则「草图 = 正式画面」的歧义消不掉。**加法，零迁移**（真实项目只用了
`character-reference`）。

**新增 kind 必须同时被它的全部消费者认识**（TASK-097 §2.6.1）：标签、允许的媒体域、
资产库的筛选。这一条写成**派生守卫**——遍历 `ASSET_KINDS`，每个图像域的 kind
都必须至少能被一个筛选找到——而不是写成一张「记得改这三处」的清单。

### 决策 8：schema 版本 +1（v16），迁移是**加法且可回滚**

新增 `production.shotProduction.stages`，只承载 `skipped` 决定。

- 旧存档缺这个字段 → 按决策 2 派生，**不写回填脚本**（回填一个可以算出来的值
  正是决策 2 要禁止的事）。
- 版本 +1 的意义不是迁移数据，而是**让旧版本的应用拒绝加载**含有 skip 决定的文档：
  旧版本读不懂 `skipped`，会把「他决定不画」显示成「他还没画」，而那正是
  产品负责人要求把 `skipped` 变成一等状态的原因。拒绝加载好过静默误读。

---

## 后果

### 好的

- 「他决定不画」与「他还没画」第一次在界面上可分。
- 声音进了链：一个没有配音的镜头不会再显示成做完了。
- 草图与正式画面分开，成本阶梯（便宜档确认 → 正式档花钱）第一次有状态可挂。
- 加 stage 是加一行。

### 代价

- 六个状态各要一份证据来源，读取面比一条链宽。
- `completed` 永远要问探针，比读一个布尔慢——这是决策 2 有意付的价。

### 风险

- 最大的风险是**汇总规则与六个 stage 漂移**。缓解：`shotStage` 只从 `stageStatuses`
  的输出汇总，没有第二条路径可以算出它；守卫测试断言这一点。
