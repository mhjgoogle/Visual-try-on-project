# TASK-083：Phase 3 —— 先落 ADR，再谈实现

- 状态：**过半已完成（2026-08-23 复查）—— ~~未开工~~ 是过期状态**。逐项核实：
  **ADR-A 已定且已实施** → [ADR-0071](../../adr/ADR-0071-reference-inputs-as-an-ordered-set.md)
  （Accepted 2026-08-17，其头部就写着「实施：TASK-083 ADR-A」；付费口径由产品负责人
  拍板方案 C），实现落在 TASK-097 批次 0/2。
  **§5.1 评价闭环接线** → 已由 [TASK-103](../done/TASK-103-frontback-and-ui-residuals.md) 批次 B 完成。
  **§5.2 后端媒体探针路由** → 已由 TASK-103 批次 C 完成。
  **ADR-B 已定且已实施** → [ADR-0075](../../adr/ADR-0075-camera-motion-presets.md)
  （Accepted 2026-08-18），实现 TASK-097 批次 3。**注意它只覆盖运镜** ——
  风格库 / 特效库（T-022 / T-023）被该 ADR 显式留下，理由写在其「后果」节：
  特效与风格**会进生成**（风格参考图是 `model-input`），需要的是资产与版本绑定，
  与「复制一段文本」的运镜预设不是同一类东西。
  **ADR-C 已定且已实施** → [ADR-0074](../../adr/ADR-0074-character-from-image.md)
  （Accepted 2026-08-18），实现 TASK-097 批次 3。
  **本卡真正剩下的只有 ADR-D（项目 / 流程模板）** —— 无 ADR、无代码，
  全仓只有审计报告提到它
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../src/ui-gap-audit/) GAP-05 / 16 / 17 / 21 / 23 / 27 / 28，
  [ui-correction-plan.md](../../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 3
- **前置：TASK-082 已完成并提交**
- 验收环境：**真实 Connected Project `照见未明rev2`**

---

## 0. 为什么这一卡长这样

Phase 3 的每一条都**新增领域对象或改跨层合同**。
AGENTS.md 第 21 条：重大设计变更必须先有 ADR。
**在 ADR 定下来之前写实现任务卡，写出来的只会是「TODO: 决定 X」。**

所以本卡的交付是 **ADR + 每个 ADR 对应的实现批次**，顺序不可倒。

技术 ADR 由实施 Agent 依 CLAUDE.md「ADR 的 Accept 权」**自行 Accept**，
并在 ADR 里写明依据。**唯一例外**：ADR-A 涉及付费调用的请求形态，
若它导致「一次生成的花费口径改变」，那一部分须产品负责人确认。

---

## 1. ADR-A：参考输入的形态与 Provider 多图契约（GAP-27 + GAP-28）

> **已闭合（2026-08-23 复查）** —— 决策见
> [ADR-0071](../../adr/ADR-0071-reference-inputs-as-an-ordered-set.md)（Accepted 2026-08-17），
> 实现见 TASK-097 批次 0/2。下面四个「必须决定」逐条对上：
> ① 有序集合 → `src/workflow/refset.js`（`ordinal` 1..N 连续、删除后重编号）；
> ② `{{Image N}}` 引用语法 → `refset.js` / `ui/gencard.js`；
> ③ `ProviderRequest.reference_images` 加法字段 + catalog 按 model 声明能力
> （`config/catalog.py` 的 `ReferenceImageCapability.max_images`）；
> ④ 不支持时 **fail-closed 拒绝而不是静默丢弃** —— `paid_coordinator.py:1045` 一道，
> `cloud_minimax.py:_payload` 边界上第二道（注释原话：静默省略正是本 ADR 要消除的
> 「界面说送了四张图」那个缺陷）。


**这是 Phase 3 里唯一必须先做的一条** —— GAP-16/17/21 都会用到它定下的形状。

### 已有的实测证据（不要重新调查）

**我们今天能送出的图像只有一张**：
```
shot.first_frame_image → packet.first_frame_image
  → ProviderRequest.provider_parameters
  → src/ai_video_workflow/providers/cloud_minimax.py:271-285 `_payload`
body = { model, prompt, duration, resolution, first_frame_image? }
```
`ProviderRequest`（`providers/models.py:251`）**没有任何多图字段**。

**目标产品的实际线上格式**（从 LibTV 自己的 API 抓的，
`GET api.liblib.tv/api/canvas/project/detail`）：
```json
"params": {
  "prompt": "在 {{Image 1}} 石头两侧增加 {{Image 3}} {{Image 5}} 女人与{{Image 4}}{{Image 6}}男人…姿势参考 {{Image 2}}",
  "model": "nebula-ultra",
  "modeType": "image2image",
  "imageList": [{ "nodeId": "…", "url": "…", "label": "石头", "width": 6336, "height": 2688 }, …],
  "imageListOrder": [...],
  "textList": [], "videoList": [], "audioList": []
}
```
要点：**有序数组 + `{{Image N}}` 占位符 + 顺序单独存**（重排不改 prompt 文本）+
`nodeId` 指回源对象（引用不复制）+ 文本/视频/音频三个平行数组。

### ADR-A 必须决定

1. **参考在领域层的形状**：现有的「按角色写死的槽位」
   （`geninput.js` `REFERENCE_ROLES` 八个角色）→ 有序数组 + 每项标注用途？
   还是**两者共存**（角色是语义、数组是顺序）？
   —— 现有八角色模型是 ADR-0061 决策 4 的产物，**不要轻率推翻**。
2. **Prompt 里的引用语法**：`{{Image N}}` 还是别的？编译在 `promptc.js`，
   反解在哪？重排时谁负责保持一致？
3. **`ProviderRequest` 加什么**：`reference_images: list` 的元素形状；
   **catalog 必须声明每个 model「支持几张 / 支不支持文本指代」**
   —— MiniMax `video_generation` 只吃 1 张，**不能一视同仁**。
4. **不支持时怎么降级**：TASK-077 §1.3 已经确立「如实标注」这条，
   ADR-A 要把它上升为契约：**Provider 能力不足时，UI 必须说这些图不进模型**，
   而不是静默丢弃。

### 实现批次

**高风险**（付费 / Provider 契约 / 跨层）→ **2 轮审查 + 全量**。
**若改动导致同一次生成的报价口径变化 —— 停下来问产品负责人**（CLAUDE.md：付费）。

---

## 2. ADR-B：预设即资产 —— 运镜 / 风格 / 特效（GAP-16）

> **运镜部分已闭合（2026-08-23 复查）** —— [ADR-0075](../../adr/ADR-0075-camera-motion-presets.md)
> （Accepted 2026-08-18，实现 TASK-097 批次 3）。它对本节四个「必须决定」的回答是：
> 预设是**内置常量不是登记表**（决策 2）、应用即**复制文本不留引用**（决策 1）——
> 于是「预设改了、已经用过它的镜头怎么办」这个最容易做错的版本语义问题
> **被设计掉了**：落到镜头上就与预设脱钩。另加「不覆盖已有内容，先问」（决策 4）
> 与「预设文本必须自足」（决策 5）。代码：`workflow/canvasgrow.js` 的
> `cameraPresetMenu` / `applyCameraPreset`。
>
> **风格库 / 特效库仍未做**，且是 ADR-0075 **明确留下**的，不是遗漏：它们会进生成
> （风格参考图是 `model-input`），需要资产与版本绑定，与文本模板不同类。


**证据**：真实项目 60 条镜头，`cameraMotion` 填充率 **0/60**
（TASK-078 §2.1 会先补输入口，但**逐镜手打自由文本这条路走不通**这一点不变）。
目标产品用「我的工具箱」预设（左弧滑行 / 360旋转展示 / 瞳孔拉近 / 机械臂视角…）
和风格库 / 特效库（T-022 / T-023）。

**ADR-B 必须决定**：项目级还是账户级？与 Asset Registry 的关系
（**只引用不复制**，同构还是另一套）？镜头引用的是 id 还是快照？
预设改了，已经用过它的镜头怎么办（**这是版本语义问题，最容易做错**）？

**排在 TASK-078 之后** —— 先看到表格视图里「运镜」这一列被真实使用的样子，
再决定预设的粒度。**不要在没有使用数据的情况下设计预设库。**

## 3. ADR-C：从图创建角色 + 角色原型（GAP-17）

> **已闭合（2026-08-23 复查）** —— [ADR-0074](../../adr/ADR-0074-character-from-image.md)
> （Accepted 2026-08-18，实现 TASK-097 批次 3）。本节那句「不得臆造档案内容」
> 被落成五条决策：只写**身份 + 一条参考绑定**（决策 1）、**名字必须由人给**、
> 不从文件名猜（决策 2）、参考图是**引用不是复制**（决策 3）、只从**已登记**的图
> 创建（决策 4）、重名**不合并**如实拒绝（决策 5）。
>
> **界面入口**：镜头画布上选中一张图 →「以此生成 →」→「从图创建角色」→
> 弹窗要名字。创建后的提示原话：「外貌 / 服装 / 画面指令仍然是空的 ——
> 这张图没告诉我们这些，需要你来写。」
> 代码：`workflow/canvasgrow.js:characterFromImage` → `app.js:2548` →
> `ui/production.js:2103`。
>
> **原型库未做**，按本节自己的建议（「先只做『从图创建』，原型库等有使用数据再说」）。


**证据**：真实项目 6 个角色里 **3 个「还没有参考图」**；
建角色的入口是**空表单**。目标产品有 T-024 角色库（20+ 预设 × 四件套 ×
「应用至画布」）和 T-048 图上右键「创建主体」。

**ADR-C 必须决定**：「从一张图创建角色」写入 `bibledoc` 的哪些字段、
不写哪些（**不得臆造档案内容** —— 这是 M8 提案卡机制的既有纪律）；
内置原型是不是要（我的建议：**先只做「从图创建」**，原型库等有使用数据再说）。

## 4. ADR-D：项目 / 流程模板（GAP-21）

**证据**：目标产品「查看创作过程」+「复制项目」（T-070）。
我们有 21 个单步 Skill，**没有「整条流程」这一级的可复用物**，新项目从空白开始。

**ADR-D 必须决定**：模板导出什么（结构，**不含媒体字节**）、
与 Skill 包（ADR-0067 三件套 + 三级来源）的关系 —— **是同一个机制的扩展，
还是第二套？** 我倾向前者，但由 ADR 定。

## 5. 不需要 ADR、可以直接排的两条

### 5.1 评价 / 反馈 / 行动闭环接进 Studio（GAP-05）

> **已闭合（2026-08-23 复查）** —— [TASK-103](../done/TASK-103-frontback-and-ui-residuals.md)
> 批次 B：四个 LOW-risk 命令从 `workspace_shell` 抽成共享缝并在 Studio 注册，
> 审片「✓通过/撤销」经网关落核心。`workspace_shell` 的去留也在该卡内决定。


四个 LOW-risk Gateway 命令（`record-evaluation` / `create-feedback` /
`create-action` / `action-transition`）**已经实现并注册在 `workspace_shell`**
（`app/gateway_commands.py:60-84`），Studio 的 `_command_gateway`
（`server.py:2422`）只注册了 `lock-draft-plan` + `submit-video-generation`。

**是注册表接线，不是新能力。** 但它是**跨层合同 + 写路径 → 高风险 → 2 轮审查**。

接线之后：TASK-079 §1.1 审片页的「✓ 通过 / 跳过」接 `record-evaluation`，
AI 导演的「问题」接 `create-feedback`。

**顺带必须决定的**：`workspace_shell` 的去留。它今天对真实 Studio 项目
**Portfolio 全空**（C-020）—— `discover_projects` 要 `config/wfm1.json`，
Studio 建的项目没有。要么让它能发现，要么在文档里明确它只服务 WFM1 核心项目。

### 5.2 后端媒体探针路由（GAP-02 的彻底解法）

> **已闭合（2026-08-23 复查）** —— TASK-103 批次 C：只读 `media-audit` 路由，
> 消除 `INCONCLUSIVE`；顺带做了 ffprobe-only 的单文件 measure。
> 「写 `storageState: missing`」那条仍未做（TASK-087 §4.1，高风险，单独评估）。


TASK-077 用前端 `HEAD` 探测 + 三态（`PRESENT / MISSING / INCONCLUSIVE`）解决了显示。
彻底解法是一个只读路由 `GET /api/projects/<p>/media-audit`，
在服务端直接看文件系统 —— **没有跨源问题，没有 INCONCLUSIVE**。

**中风险**（新只读路由）。做了之后可以顺带考虑
Follow-up 里那条「写 `storageState: missing`」（**那条是高风险，单独评估**）。

---

## 6. 建议的执行顺序

```
ADR-A（参考形态 + Provider 多图）        ← 唯一的硬前置
   ↓
5.1 评价闭环接线（高风险，独立，可与 ADR-A 并行排队）
   ↓
5.2 后端媒体探针（中风险，很小）
   ↓
ADR-C（从图创建角色）—— 用户价值高、范围窄
   ↓
ADR-B（预设库）—— 等 TASK-078 的使用数据
   ↓
ADR-D（模板）—— 最后，且可能并入 ADR-0067
```

## 7. 明确不做（重申，省得反复讨论）

逐帧拉片 / 3D 导演台 / Blender 插件 / 社区与分享 / 积分会员体系 /
Agent 自主花钱 / 用「智能剪辑」替换现有时间线 ——
理由见 [ui-correction-plan.md §0](../../../src/ui-gap-audit/reports/ui-correction-plan.md)。
