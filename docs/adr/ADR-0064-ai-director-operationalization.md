# ADR-0064：AI 导演的可操作化 —— Shot Context、检索式推荐、Prompt 能力与审核

- 状态：**Accepted（决策 1–7 与追加决策 9）；决策 8 被 ADR-0066 取代**
  —— 2026-08-13 由产品负责人在批准 ADR-0066 时一并收口
- 日期：2026-08-12（Accepted：2026-08-13）
- 实施：TASK-067，已实施并提交于 `ae0a54a`
- 相关：[ADR-0056](ADR-0056-local-ai-runtime-and-film-skills.md)（Skill / Runtime 分层）、
  [ADR-0058](ADR-0058-production-memory-library-and-episode-production.md)（Generation Input Set）、
  [ADR-0059](ADR-0059-production-graph-identity-contract.md)（身份与溯源契约）、
  [ADR-0061](ADR-0061-creator-ia-and-automated-episode-production.md)（Action Layer / 参考解读）、
  [ADR-0063](ADR-0063-creator-object-first-ia-and-shot-production-graph.md)（Shot 制作流程图）
- 任务卡：[TASK-067](../tasks/TASK-067-ai-director-operationalization.md)
- **收口裁决（2026-08-13，随 [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) 批准）**：

  | 决策 | 裁决 | 理由 |
  | --- | --- | --- |
  | 决策 1 Shot Context Builder | **保留，Accepted** | 最小上下文是 token 成本控制的全部实现方式 |
  | 决策 2 `contextTrace` | **保留，Accepted** | ADR-0066 决策 8 的 `inputVersions` 直接复用它，不新建第二份 |
  | 决策 3 缓存以 baseline revision 为键、stale 显式 | **保留，Accepted** | |
  | 决策 4 确定性检索候选 + AI 只排序 | **保留，Accepted** | 「AI 无法发明 assetId」是 ADR-0066 决策 6 四条禁令的实现之一 |
  | 决策 5 Image / Video 双 Prompt 能力 + 硬前置 | **保留，Accepted** | 硬前置迁入「镜头制作 · 步骤③」，仍在能力层拒绝而非 UI 置灰 |
  | 决策 6 Prompt Review / Continuity 只读、跑不了就 unavailable | **保留，Accepted** | ADR-0066 决策 6「Agent 只产 Issue、不产 Decision」由它支撑 |
  | 决策 7 Proposal → Action 词汇表映射 | **保留，Accepted** | ADR-0066 决策 9 的 Command 名录以此为基线 |
  | **决策 8 AI 导演常驻右栏** | **被 ADR-0066 决策 5 取代** | 改为按需打开的上下文面板；技术信息从 `<details>` 升级为统一进入结果旁的「生成记录」 |
  | 追加决策 9 Claude Code 执行 / Codex 审阅 | **保留，Accepted** | 建议式分工、创作者显式选择优先、Codex 绝不默认进创作位、Codex 缺席退回 manual —— 四条全部不变 |

  「实施后补记」的三条证据修正（`applicabilityFor` / 最新待答运行 + `abandon` /
  `reviewedPromptKind`）与 `referenceView` 的 `readingVersion` 修复**一并 Accepted**。

## 背景

CP3～TASK-066 已经把 AI 能力的**结构**建好了：Skill 是冻结的、带输出契约的能力定义；
Skill Run 记录「谁被问了什么、答案怎么被判定」；Action Layer 是 UI 与 AI 共用的唯一
变更词汇；Proposal 必须经创作者确认才写 canon。这些都不需要重做。

但在真实 Studio 里，**这套能力帮不了创作者做完一个 Shot**：

1. `ctx.skills.context` 把**整个项目**交给 runtime —— 全部草稿镜头、全部参考、全部资产、
   全部生成记录、完整时间线与字幕轨。没有任何 shot 级的最小上下文，也没有缓存。
2. AI 导演**不能针对当前 Shot 检索资产库**。`reference-planner` 是整集范围的，按
   referenceKey 说话，不带真实 `assetId`。
3. 只有一个泛用的 `prompt-director`，没有 Image / Video 两种截然不同的 Prompt 能力，
   也没有任何东西把 Video Prompt 卡在「已选定主帧图」之后。
4. **Prompt Review 完全不存在**。`skillRun.directorReview` 是一个从来没有人写过的字段。
5. Continuity 只有整集范围的文本检查，没有 Shot 视觉范围的版本。
6. AI 导演面板是「工作区通用的状态/计划/收件箱」列。运行一个能力意味着展开「能力」、
   在 15 个 Skill 里翻、选执行器、再点运行 —— 它是一个**目录**，不是一个操作入口。

## 决策

### 决策 1：Shot Context Builder 是一个真实的域模块；shot 级 Skill 只能经它读上下文

新增 `workflow/shotctx.js`（纯投影，无 fetch / DOM / clock / 写入），从 canonical 文档
投影出 ADR 范围内的最小必要上下文：

```
projectCanon   题材基调 · 世界视觉基调 · 视觉方向（只投影，不复制全文）
episode        code · title · 本集规划要点
scene          title · 出场人物（含 State）· 场景地（含 State）
shot           sequence · title · description · action · expression · emotion
               · shotSize · angle · cameraMotion · environmentMotion · duration · dialogue
references     本镜绑定的参考（key · kind · name · version · assetId · use · 解读）
frames         startFrame / endFrame（含来源 pin 与 drift）
media          已选定主帧图 / 已选定最终视频（version · assetId）
prompts        当前 image / video Prompt（version · text · locked）
neighbours     上一镜 / 下一镜的连续性摘要（不是完整镜头）
```

**这是一次收窄，不是一次新增。** `ctx.skills.context` 对 shot 级能力改为投影
`shotContext`，不再把 `shots` / `references` / `assets` / `generations` 全量塞进去。

### 决策 2：上下文可追踪 —— 每次 Skill Run 记录它到底读了什么

`buildShotContext` 同时产出 `contextTrace`：读到的每一层的**真实 id** 与**版本/修订标识**
（prompt version、reference key 集合、asset version、草稿版本、frame binding、解读版本）。
`skillrun.startRun` 记录它。§3「上下文必须可追踪」由此成立：Skill Run 与 Proposal
都能回答「本次到底读取了什么」，而不是只回答「读了哪一集」。

`contextTrace` 与既有的 `context: {episodeId, sceneId, shotId}` **并存、不合并**：后者是
ADR-0059 的身份契约（这次运行属于哪一层 canon），前者是本次投影的内容指纹。

### 决策 3：缓存以 baseline revision 为键；上游一变即 stale，绝不静默用旧值

新增 `workflow/ctxcache.js`：`{ key, baselineRevision, value, at, skillRunId }`。
`baselineRevision` 由决策 2 的 trace 派生 —— 它是被读文档的真实标识的函数，不是时间戳。

- revision 相同 → 命中，直接复用（资产推荐 / 连续性摘要 / 参考解读的结构化结果）。
- revision 不同 → 标记 `stale` 并**在界面上说明它过期了**，不静默返回旧值，也不
  自动重算（重算要花 token，那是创作者的决定）。

缓存**只存派生结论**，绝不存 canon 的第二份副本 —— 那会立刻变成陈旧的重复数据。

### 决策 4：资产推荐 = 确定性检索出候选 + AI 只排序与给理由

`shotctx.candidatesFor(shotId, { role })` 从 **Asset Registry 本身**检索候选：本镜所属
场景的出场人物及其 State、场景地及其 State、已绑定角色的缺口、风格/运动/机位/表演的
可复用参考。每个候选带**真实 `assetId` 与 `referenceKey`**。

Skill（`shot-asset-recommender`）**只能在候选集内挑选**，输出必须引用候选里给出的
`referenceKey`。applier 再对每个 key 校验一次注册表，不存在的**丢弃并如实报告条数**。

两个后果，都是有意的：

- **AI 无法发明 assetId。** 模型返回一个不存在的 id 时，它不会变成一条提案。
- **不需要把整个资产库塞给模型**（决策 1 的最小上下文因此成立）。

UI 侧不允许有第二条推荐路径：§4「不能从 UI 假造推荐」的执行方式是 —— 推荐只能来自
这个 Skill 的 Proposal，界面没有自己编推荐的代码路径。

### 决策 5：Image Prompt 与 Video Prompt 是两个独立能力；Video 以「已选定主帧图」为硬前置

新增 `image-prompt-director` 与 `video-prompt-director`，输入与输出按 §7 / §8 分别定义
（Video 侧的输出重点是 action sequence / camera motion / performance / environment motion /
pacing / continuity / visual stability）。

`video-prompt-director` 的 `inputs` 包含 `selectedShotImage`：**没有已选定主帧图时它缺
必要输入，因此拒绝运行并说明原因** —— 这不是 UI 的一个 disabled 按钮，而是能力层的拒绝。

`prompt-director` v1 **保留不动**。已有 Skill Run 记录按 `skillId + skillVersion` 引用它
（ADR-0056 决策 6：定义不可变），删掉它会让那些记录指向不存在的能力。它只是不再是
Shot 工作台的入口。

### 决策 6：Prompt Review 与 Continuity 是只读结论 + 结构化建议，永不直接覆盖

- 新增 `prompt-reviewer`：一个能力覆盖 image / video 两侧（`shotContext` 里说明本次是哪一侧，
  instruction 携带两套检查清单并要求只检查当前那一侧）。输出 = `issues[]`（问题 + 定位）
  + 每条可选的 `suggestedText`。**写回路径是 `updatePrompt`，且必须逐条经创作者确认。**
- 新增 `shot-continuity-reviewer`：只做 §10 的视觉范围（人物身份 / CharacterState / 服装 /
  场景地 / 时间天气 / 道具 / 画面方向 / Start·End Frame / 前后镜）。**没有「连续性」这份
  canonical 文档**，所以它 `can: false`、如实说明、保持只读 —— 与既有 `continuity-reviewer`
  同一条诚实规则。
- **跑不了就是 unavailable。** runtime 不可用、必要输入缺失、答案不符合契约 → 记为真实
  失败态（`unavailable` / `invalid_output` / …），绝不产生一条「通过」的结论。§10
  「不要 fake pass」在能力层而不是在 UI 层执行。

`skillRun.directorReview` 从此有真实写入者：`reviewRun` 只在 review 能力真的跑出结论时
被调用。

### 决策 7：Proposal 类型进入 Action 词汇表；不新增第二套 AI 专用业务逻辑

§12 的八种 Proposal 全部映射到 Action Layer，其中三处需要词汇表变更：

| Proposal | Action | 变更 |
| --- | --- | --- |
| addReference | `addReference` | **新增**：纯新增绑定 |
| replaceReference | `replaceReference` | **改为真正的替换**：新增必填 `replacesKey`，先解绑再绑定，用途选择随之迁移 |
| removeReference | `removeReference` | 不变 |
| updateImagePrompt | `updatePrompt` (kind=image) | 不变 |
| updateVideoPrompt | `updatePrompt` (kind=video) | 不变 |
| usePreviousShotEndFrame | `usePreviousShotEndFrame` | **新增**：把「提取上一镜尾帧 + 绑为本镜首帧」表达为一个可被提案指名的动作 |
| prepareImageGeneration | `prepareGeneration` (kind=image) | 不变 |
| prepareVideoGeneration | `prepareGeneration` (kind=video) | 不变 |

`replaceReference` 语义变更的理由：今天它其实**只是新增**（已绑定则报 satisfied），
所以「替换」这个词在词汇表里是假的 —— 一份 replaceReference 提案不可能表达
「把 A 换成 B」。既有唯一调用点（`skillapply` 的 reference-planner）改为发
`addReference`，那才是它真正在做的事。

`CURRENT_LEVEL` 仍是 `suggest`：AI origin 一律不得执行写入动作。本轮不动这一条。

### 决策 8：AI 导演在剧集制作里是操作入口，技术信息进折叠详情

右栏在剧集制作空间内呈现（§18 / §19）：

```
当前判断      这一镜现在处于什么状态（来自真实数据）
缺失项        ✓ 已有 / ! 缺少，逐项可点到修它的地方
推荐资产      Skill 提案 → [接受] [替换] [忽略]
下一步建议     一到三张建议卡，每张带真实动作按钮
Prompt Review 问题 + 修改建议 → 逐条确认
能力 / 提案    Skill Run 与 Proposal 的当前状态
```

runtime / model / context snapshot / skill version / 各类 id 一律进 `<details>`。
**不显示不存在的能力**：一个 runtime 不可用或必要输入缺失的动作，显示为
unavailable 并说明原因，不显示成一个会假装工作的按钮。

## 后果

- shot 级 Skill 的 prompt 体积从「整个项目」降到「这一镜真正需要的」。这是本轮
  token 成本控制的**全部**实现方式；没有第二个开关。
- 多了一个必须维护的投影层：`shotctx` 与 `promptc` 必须对「这一镜有什么」保持一致。
  两者都从同一批已解析域视图读，且都不反向写入，这是可控的代价。
- 缓存引入了 stale 这个新状态。它是**显式可见**的，不是自动重算 —— 界面必须能说
  「这条结论基于已经变过的上游」。
- `replaceReference` 的语义变更是一次**行为变更**，需要守卫测试与迁移说明（唯一
  既有调用点同步改为 `addReference`）。
- Codex 仍然不是 Creative Director：它的 `goodAt` 保持「独立复核 / 结构化检查」，
  且本轮不把任何 Skill 绑定到任何执行器（Role ≠ Skill ≠ Runtime ≠ Model 不变）。

## 实施后补记（2026-08-13）

三处决策在实施与真实项目验收中被证据修正过，记在这里而不是悄悄改上面的文字：

1. **决策 6 需要一条「提案感知」的补充。** `applicability(skillId)` 回答的是能力层的
   问题，但一份只有问题列表、没有完整改写的 Prompt Review **这一份**无处可写。真实
   项目验收第一次跑出来时，面板给了一个按下去必然失败的「应用」按钮。因此新增
   `applicabilityFor(skillId, proposal)`：静态答案 + 这份提案本身。
2. **一个卡在 `running` 的 Skill Run 此前会永久占住面板的待答槽位**，并让之后每个粘回
   来的答案都被拿去校验那个旧运行的 schema。真实项目里已攒了两条。修复：面板显示
   **最新**的待答运行，并新增 `ctx.skills.abandon`（记为真实失败态，不删记录）。
3. **`contextTrace` 额外携带 `reviewedPromptKind`。** 审核审的是哪一侧 Prompt 只存在于
   本次投影里；应用时去读「界面上当前打开的那个 tab」会把 image 审核写进 video Prompt。

`shotctx.referenceView` 还有一处实施期缺陷由本轮自己的守卫测试抓到：读了参考自己的
`version` 而不是解读的 `readingVersion`，会让**重新解读一个参考对 `contextRevision`
不可见**——缓存因此在解读文字变了之后仍然「fresh」，正是决策 3 要防的那件事。

## 追加决策 9（2026-08-13）：Claude Code 执行，Codex 审阅

产品当天补充：AI 全部跑在当前订阅账号上；且 **Claude Code 主要执行，Codex 做审阅并给出
意见**。这是对 ADR-0056 决策 1 的一层**建议**，不是绑定：

- 每个能力声明它做哪种活：`skills.work = "creative" | "review"`（关于**工作**的事实）。
- 每个执行器声明它适合哪种活：`EXECUTORS[].suits`（关于**执行器**的事实）。
- 两者在渲染时由 `suggestExecutor` 配对，创作者随时可改 —— 任何能力都能在任何可用执行器
  上跑，radio 永远是自由的。

三条硬规则：**创作者的显式选择永远优先（双向）**；**Codex 绝不默认进创作位**；
**Codex 缺席时审阅退回 manual，不退回 Claude Code**——让写它的那个 runtime 来「独立复核」，
独立性就是零。

实施中撞到一个真实缺陷：旧「能力」面板会把 `ui.skillExecutor` 默认成 `"manual"`，而把这个
**默认值**当成创作者的**显式选择**会压过整套分工（六个操作全部解析成手工）。本面板因此改用
独立的 `ui.sdExecutor`，只有真正点过单选框才写入。**一个默认值不是一个选择。**

CLI 的位置属于**环境**，不属于产品代码：ADR-0049 第 6 条不变（`shutil.which` 解析、
fail-closed、绝不猜路径），PATH 的修复留在 `run-windows.ps1`。旧的 `/api/agent/*` 五个
端点仍然直连 `claude` 且没有手工兜底，由 [ADR-0065](ADR-0065-every-ai-action-through-the-runtime-layer.md)
与 TASK-068 承接。

## 明确不做

后期制作 UI、Dialogue / SFX / Foley / BGM / 字幕 / Rough Cut / Editing / Final Mix、
Image / Video Provider API、Shared Library、顶层 IA 重构、删除资产库、
提高自动化级别（`CURRENT_LEVEL` 保持 `suggest`）。
