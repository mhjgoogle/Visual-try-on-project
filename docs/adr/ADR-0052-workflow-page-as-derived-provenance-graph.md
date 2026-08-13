# ADR-0052: 工作流页面改为派生的生成溯源图

- Status: Proposed
- Date: 2026-08-11
- Scope tasks: TASK-054
- 关联：ADR-0007（WFM1 文档基线）、M3 资产登记、M5 生成登记、M10 Prompt 编译器、
  M11 时间线与渲染、[ADR-0049](ADR-0049-native-windows-run-and-test-target.md)
- **被 [ADR-0066](ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  降级（不撤销）**：本 ADR 的「溯源图是派生的、不是第二套流程模型」全部继续有效；
  变的只是它在产品里的**位置** —— 不再是创作者主界面，改为具体结果旁的「生成记录」
  与项目设置下的诊断视图。

## Context

原型顶层的「工作流」一直是**节点画布**：节点即执行面，生成在那里发起。

但创作者在这个页面上真正需要回答的问题不是「流程走到哪一步」——那由「制作」
界面回答——而是：

> 哪个 Prompt、哪些参考图、哪一张源图，实际生成了这个资产？它又生成了什么？

这些事实已经全部存在，分散在四处：生成登记（`inputAssetIds` /
`referenceAssetIds` / `resultAssetIds` / `promptSnapshot` / `provider` /
`status`）、资产登记（版本链、`firstFrames`、`finals`）、制作文档（剧集→场景→
镜头、角色/场景地参考）、时间线（渲染消费了哪些 clip）。缺的不是数据，
是把它们连起来看的界面。

## Decision

### 1. 溯源图是**派生读模型**，不是第二份事实

新增 `src/workflow/provenance.js`，`buildProvenanceGraph({assets, generations,
production, timelines, draftShots})` 每次渲染重算，返回 `{nodes, edges, order,
warnings, shots}`。

- **不持久化**、不缓存、不铸造 id：节点 id 由来源记录自己的 id 派生
  （`asset:<assetId>` / `gen:<generationId>` / `prompt:<generationId>`）。
- **边只来自记录**：`inputAssetIds`（输入）、`referenceAssetIds`（参考）、
  `resultAssetIds`（产出）、`promptSnapshot`（Prompt→生成）、
  `firstFrames[slot]`（记录的首帧）。
- **绝不从当前状态反推**：不用「镜头当前选用的图片」推断视频来源，不用槽位
  相邻或序号推断关系。Image v3 变成 ACTIVE 之后，从 Image v2 生成的 Video v1
  仍然显示为来自 v2。
- **未知就是未知**：纯导入的资产没有 Prompt 节点（不是空的，也不是猜的）；
  生成记录里点名、但资产登记里已经不存在的资产，仍然作为 `missing` 节点出现，
  链条不会静默断掉。

### 2. Prompt 身份 = 生成的快照，不引入 Prompt 库

系统里没有可复用的 Prompt 实体，只有每次生成冻结下来的 `promptSnapshot`。
因此 Prompt 节点属于**它所驱动的那一次生成**。本 ADR 不创建 Prompt 库；
将来若引入，可作为独立实体再链接过来。

渲染（render）有**设置**而没有提示词，所以它没有 Prompt 节点。

### 3. `render` 进入生成类型词表（缺陷修复）

schema v9 早已接受 `type: "render"`（本地 FFmpeg 合成），`app.js` 的渲染路径
也确实写入这样一条记录——但 `workflow/genlib.js` 的 `TYPES` 仍是
`{image, video, audio}`，于是 `startGeneration` 一直**静默返回 null**，
渲染 provenance 从未被记录，成片也就没有任何上游可查。本 ADR 把 `render`
补进 `TYPES`，与 schema 对齐。这不是新能力，是让既有写入真正落盘。

### 4. 工作流下分两个视图，画布不被删除

顶层「工作流」下新增两个标签：

| 标签 | 作用 | 读/写 |
| --- | --- | --- |
| **生成溯源**（默认） | 已经发生过的生成的来源与去向 | **只读** |
| **流程画布** | 节点执行面——生成实际在这里发起 | 读写 |

溯源图**不发起任何生成**、不写任何领域文档。删除画布会移除一个执行面，
因此不删除；只是把默认视图换成创作者更常问的那个问题。

### 5. 布局是确定性的分层，不是力导向

列序由边推导：`参考(0) → PROMPT(1) → 生成(2) → 结果(3) → PROMPT(4) → …`
——生成排在其最远输入之后**两列**，把紧邻它左边的一列留给 Prompt。
同一份图永远排出同样的版式，没有随机、没有保存的坐标。

### 6. 渐进披露

剧集视图默认给出**场景摘要行**（镜头/图片/视频/音频/生成/未成功数）+ 成片链路，
而不是一次摊开整集上百个节点；展开场景→镜头，才展开完整生成链。成片的上游
按种类折叠为 `镜头视频 ×4 · 对白 ×2 · …`，点开才逐个列出。

### 7. AI 导演在此页面只做「复述」

工作流模式下右栏的 AI 导演读的是**同一份派生记录**，把选中节点的生成链按记录
复述，并最多给一条有记录支撑的观察。它不得提出图上没有的链接、不得推断原因；
没有依据时就不写。

## Consequences

- 工作流页面从「执行面」变为「**解释面 + 执行面**」两个视图；默认是解释面。
- 生成登记的价值被显著放大：它此前只被 AI 导演的历史和逐镜头 lineage 少量使用。
- 新增一处派生逻辑（约 600 行 + 21 项回归），但**没有新增任何持久化状态**，
  也没有改动 Shot / Asset / Generation / Timeline 的语义。
- 修复了 `render` 生成记录被静默丢弃的缺陷（第 3 条）——旧存档里没有渲染记录，
  这是既成事实，只能从此以后记录；界面对没有渲染记录的成片如实显示
  「没有渲染记录」。
- **不在本 ADR 范围内**：Prompt 库/模板、从溯源图直接发起重生成、
  跨项目溯源、导出溯源报告。
