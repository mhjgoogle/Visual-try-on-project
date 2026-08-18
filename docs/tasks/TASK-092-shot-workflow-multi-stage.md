# TASK-092：Shot 工作流从线性状态机升级成带依赖的多 Stage

- 状态：**已完成（2026-08-18，TASK-097 批次 1 · 提交 `c94fd19` · [ADR-0073](../adr/ADR-0073-shot-multi-stage-workflow.md)）** —— codex 3 轮，轮 3 pass 零发现
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：产品负责人 2026-08-17（§0 原话）
- **前置：TASK-091 已完成并提交** —— 091 把整集九步做成 rail，本卡改 Shot 级状态
  模型；顺序反了会让 091 照着旧的 5 档线性模型把 rail 做出来，回头全要改
- **需要 ADR**：动 Shot 身份/状态的持久化形状 + 跨三个消费者的合同（AGENTS.md 第 21 条）
- 验收环境：**真实 Connected Project `照见未明rev2`**


> **位置（2026-08-17 锁定）**：本卡是
> [TASK-095](TASK-095-episode-production-wizard.md) 那条向导的**状态层** ——
> `storyboardStatus` / `keyframeStatus` 就是向导第 ④⑤ 步的进度，
> 本卡那个闸门（`skipped` 或 `completed 且草图已 approved`）就是 ④→⑤ 之间那道门。
> **因此本卡必须早于 TASK-095 落地**：否则那道门会被做成一根箭头，`skipped` 无处可存。

---

## 0. 产品负责人说了什么（原话）

> 「这三个问题其实说明一件事：**`shotStage` 不应该继续设计成单一线性状态。**」

> 「必须区分。建议每个制作环节有自己的状态：
> `not_started` / `in_progress` / `completed` / `skipped`
> …`skipped` 必须保留，因为它表示：**这个步骤经过 Workflow 判断，不需要执行。**
> 而 `not_started` 表示：**需要执行，只是还没开始。**」

> 「不要让 `shotStage = storyboard → keyframe → video → audio` 表达整个 Shot。
> 改成几个并行 Stage：
> Visual（Storyboard / Keyframe / Video）、Audio（Voice / SFX）、QC（Approval）
> …`shotStage` 可以继续存在，但只能作为 **UI 汇总状态**，不能作为真实 Workflow State。」

> 「**是独立状态，但不应该永远是 Keyframe 的硬前置条件。**
> 所以 Keyframe 的启动条件应该是：`Storyboard == approved OR Storyboard == skipped`
> 而不是单纯 `Storyboard == completed`。」

> 「一个 Shot 不再只有 `shotStage`，而是至少有：
> `storyboardStatus / keyframeStatus / videoStatus / voiceStatus / sfxStatus / qcStatus`
> 这样以后再加 Lip Sync、BGM、Retake，也不会把整个状态机推翻。
> **这是我认为现在最值得改的地方：把 Shot Workflow 从"线性状态机"升级成
> "带依赖关系的多 Stage Workflow"。**」

### 0b. 同一天给的上下文（这套状态服务于它）

最小 Shot 制作单元：

```
Shot → Shot Design → Keyframe（可选先过 Storyboard）→ Video Generation → Voice / SFX → QC / Approve
```

两种模式：
- **轻量**：Shot → Shot Design → Keyframe → Video（`storyboardStatus = skipped`）
- **规范**：Shot → Shot Design → Storyboard → Keyframe → Video

Storyboard 的定义（原话）：

> 「**Shot Design = 文字/结构化的拍摄设计；Storyboard = 把这个设计先画出来看看；
> Keyframe = 真正用于后续生成视频的高质量画面**」
> 「Storyboard 的核心价值就是：**在花高成本生成正式图和视频之前，先确认镜头设计。**」

它确认六件事：构图 / 人物站位 / 镜头角度 / 景别 / 动作方向 /
**前后 Shot 接起来是否顺**（← 最后一条不是单镜头判断，见 §2.5）。

前提（原话）：「Episode Script 已确认、Scene 已拆好、Shot 已创建」——
所以这是**单个 Shot 的制作 workflow**，不是整集 workflow（整集九步是 TASK-091）。

---

## 1. 现状（实测）

`shotprod.js` 的 `shotStage` 是一条**派生的线性链**，5 档：

```js
if (m.video && isApprovedFor(prod, shotId, m.videoAssetId)) return "approved";
if (m.video)          return "todo-review";
if (m.image)          return "generated";
if (isDesigned(shot)) return "todo-generate";
return "todo-design";
```

三处缺陷，与产品负责人的三个问题一一对应：

| 缺陷 | 后果 |
| --- | --- |
| **分不清 Storyboard 与 Keyframe** | `m.image` 存在即 `generated` —— 一张低成本草图与一张正式关键帧在状态机眼里是同一件事。资产的 `kind` 里**没有** `storyboard` / `keyframe`（11 种全是 `*-reference`） |
| **声音不在链上** | 一个镜头可以 `approved` 而完全没有配音 —— 状态说做完了，实际没有 |
| **没有「按设计跳过」** | `isDesigned` 是布尔；轻量模式跳过 Storyboard 会被当成缺失 |

**三个消费者**（必须全部继续工作）：故事板审片（TASK-079 `dailiesModel`）、
镜头制作、⑦ 分镜表。TASK-079 有守卫测试断言「状态取自 `prodgraph` / `shotprod`，
**不新建第二份计算**」。

---

## 2. 交付

### 2.1 六个 stage 状态字段（产品负责人的清单）

```
storyboardStatus / keyframeStatus / videoStatus / voiceStatus / sfxStatus / qcStatus
```

**加法字段**，canvas schema 版本 +1，**旧存档缺这些字段时按 §2.2 派生**——
不写迁移脚本去回填一个可以算出来的值（AGENTS.md 第 13 条：加法优先，留可回滚的旧数据）。

### 2.2 **按「谁才知道」决定存还是派生**（本卡对规格的唯一限定）

产品负责人的四态词汇**一个不改**，但它们的**来源**必须分开，否则我们在 Shot 这一级
重造 TASK-077 修过的那个谎：`storageState` 声明「文件在」而从不与磁盘核对，
于是存储页报「媒体不可用 0」而实际丢了两个文件。

| 状态 | 来源 | 理由 |
| --- | --- | --- |
| `not_started` | 默认 | 无证据、无决定 |
| `in_progress` | **派生**：`runstore` 有在途 Run | **存储的 `in_progress` 在崩溃后会永久说谎** |
| `completed` | **派生 + 要证据**：产物存在，且探针**明确答了 `PRESENT`** | 唯一能防漂移的做法。**⚠️ 本行原写「探针没有判定它 MISSING」——那句太松，是 codex 轮 5 那个缺陷的来源**：`INCONCLUSIVE`（问过、答不上来）与「从未问过」都不是 `MISSING`，于是被算成产物存在，闸门会在未经确认的媒体上打开。四态判定见 [ADR-0073](../adr/ADR-0073-shot-multi-stage-workflow.md) 决策 2 的表 |
| `skipped` | **存储** | 只有人 / Workflow 的决定能知道 —— 产品负责人说得对，这个必须存 |
| `approved` | **存储，且绑在产物上** | 见 §2.3 |

**只有 `skipped` 是真正新增的持久状态。** 其余四个是把已有证据读成一个词。
这让本卡的持久化面缩到最小，同时保住产品负责人要的表达力。

### 2.3 `approved` 复用既有机制，不进枚举

产品负责人的枚举是四态，但闸门条件用了 `approved`。系统里已经有它的正确位置——
`shotprod.js:239` 的 `isApprovedFor(prod, shotId, assetId)`：**批准是独立存储的，
而且绑在具体那个资产上，不是绑在 stage 上。**

这个先例是对的：批准的是**这一张图**，换了图批准就该失效。
所以 **Storyboard 的批准 = 那张草图上的一条 approval 记录**，不是
`storyboardStatus = "approved"`。

### 2.4 依赖关系：Keyframe 的闸门按原话实现

```
Keyframe 可启动 ⟸ storyboardStatus == skipped
                 OR （storyboardStatus == completed 且那张草图已 approved）
```

**不是** `storyboardStatus == completed` 单独成立就放行。

- **闸门不置灰导航**（既有纪律）：Keyframe 那一步仍可进入，
  但主行动显示前置未满足及**为什么**。
- 依赖关系写成**数据**（一张 stage → 前置条件表），不是散在各处的 if。
  以后加 Lip Sync / BGM / Retake 只是加一行 —— 这正是产品负责人要的
  「不会把整个状态机推翻」。

### 2.5 三个并行 Stage 组

```
Visual   Storyboard → Keyframe → Video     串行
Audio    Voice · SFX                        与 Visual 并行
QC       Approval                           两组都就位后
```

产品负责人：「**画面生成 和 音频准备 部分并行，最后再合成**」，
可提前准备的是台词文本 / Voice Design / SFX Plan。

所以 Audio 组**不以 Video 完成为前置** —— 它的前置是「台词已确认」。
（今天配音的声音身份强制来自角色基础声音档案，`bibledoc` 三重强制，**不变**。）

### 2.6 `shotStage` 降级为汇总，三个消费者一行不改

**`shotStage` 保留**，仍是那三处唯一的汇总来源，但从「一条线性链」改成
「**从六个 stage 汇总出来的一个字**」。

- 汇总规则写在一处，可测。
- TASK-079 那条守卫测试（不新建第二份计算）**继续成立**——
  六个 stage 也从 `prodgraph` / `shotprod` / `runstore` / `mediaprobe` 读，
  不新建第四份真相。
- 三个消费者的调用签名不变。

### 2.7 Storyboard 需要的三件小事（由 §0b 推出，本卡内）

1. **资产 `kind` 加 `storyboard` 与 `keyframe`** —— 否则 §1 那个「草图 = 正式画面」
   的歧义消不掉。加法，零迁移（真实项目只用了 `character-reference`）。
2. **成本闸门**：Storyboard 落**免费/手工路线**（零花费），Keyframe 落付费路线。
   闸门处显示报价（`packet` 的 `quote_minor_units` 编译期就有）：
   「构图已确认。生成正式关键帧 ⚡N —— 确认后才花钱。」
3. **横着看**：「前后 Shot 接起来是否顺」不是单镜头判断，所以 Storyboard 的界面是
   **连续镜头的一条带**。**复用 ⑨ 粗剪审片的视图模型**（TASK-079 已做成
   「一集的镜头 × 三列清单」）——同一个形状，更早的位置，看草图而不是成片。

---

## 3. OUT OF SCOPE

- 整集九步 rail —— TASK-091。
- 分集规划 / 故事大纲 / 作品设定 —— TASK-088 / 089 / 090。
- Lip Sync / BGM / Retake 这些**将来的** stage —— 本卡只保证加它们不用推翻状态机。
- 参考的五个一级分类（人物｜场景｜道具｜视觉参考｜声音）—— 另记，见 §5。
- 48 集历史数据清理。

## 4. 风险分级

**高**：持久化 + schema 版本 + Shot 状态身份 + 跨三个消费者的合同
→ **2 轮审查 + 全量**，且**先落 ADR**。

分批次：
- **A**：ADR + 六个 stage 的派生/存储模型 + `shotStage` 汇总（三消费者不动）
- **B**：依赖表 + Keyframe 闸门 + `skipped` 的写入口
- **C**：`storyboard` / `keyframe` 两个 kind + 成本闸门 + 横着看的那条带

## 5. 同一轮给的、本卡不做但要记下的：参考的五个一级分类

产品负责人 2026-08-17：

> 「运动 / 机位 / 表演 / 视频风格 / 风格 都不要做一级分类，全部归到「视觉参考」，
> 然后用 `referenceType` 区分。所以最终 UI 我会建议就是：
> **人物｜场景｜道具｜视觉参考｜声音**」

**零迁移**：`kind` 数据不动，界面用派生的 `categoryOf(kind)` 分五组
（真实项目只用了 `character-reference` 一种）。

**但有一条必须保住**：要合并的那五个恰好横跨 `ROLE_USE` 的分界——
`style` 是 `model-input`（图会进模型），
`video-style` / `motion` / `camera` / `performance` 是 `ai-interpretation`
（**模型看不到图**，只有 Skill 读过它写进 Prompt 的文字）。
**合并的是归类，不是那个事实** —— TASK-077 §1.3 修的正是「界面把四类都写成
模型直接输入而付费链路一张也送不出去」这个谎。

`external-reference` 产品负责人未提。建议归进视觉参考、`referenceType: external`，
并标明**不参与生成**（`geninput.js` 注释明说它故意不在八个角色里）。**待确认。**

层级也要说清（两套词汇，不是互相取代）：

```
资产库的筛选（用途）    全部 / 参考 / 镜头图片 / 镜头视频 / 音频 / 成片
「参考」再分（这五类）  人物 / 场景 / 道具 / 视觉参考 / 声音
```

影响 TASK-090（资产准备的一级分区）、TASK-082 的资产内容树、
ADR-0071（里面写的「八个角色」要改成「五个一级分类 + `referenceType`」，
model-input / ai-interpretation 的事实原样保留）。

## 6. 测试

- 四态 × 六 stage 的来源逐条断言：`in_progress` 无在途 Run 时**不得**为真；
  `completed` **仅在探针明确答 `PRESENT` 时**为真 —— `MISSING` / `INCONCLUSIVE` / 从未问过**一律不算**（防漂移，对着 TASK-077 那个谎；措辞订正见上表 ⚠️）
- `skipped` 是唯一新增的持久状态（守卫测试：其余四个无持久写入）
- Keyframe 闸门：`skipped` 放行、`completed` 但未 approved **不放行**、
  `completed` + approved 放行
- 换掉草图后，原来的 approval **失效**（绑在产物上，不是绑在 stage 上）
- Audio 组**不以 Video 完成为前置**
- `shotStage` 汇总后，三个消费者的既有断言**全部继续通过**（回归）
- 依赖关系是**数据**：加一个假 stage 只需加一行，不改判定代码（结构测试）
- 旧存档缺六个字段时能正确派生，**不需要迁移脚本**
