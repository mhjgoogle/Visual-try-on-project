# TASK-078：从分镜到第一张画面 —— UI Gap Audit Phase 1

- 状态：**未开工**
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../src/ui-gap-audit/)，
  [ui-correction-plan.md](../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 1
- **前置：TASK-077 已完成并提交**（本卡的表格要挂在 TASK-077 补出来的五页 rail 上，
  向导入口也由那一卡接回主路径）
- 实施基线：TASK-077 的收口 commit
- 验收环境：**真实 Connected Project `照见未明rev2`**（AGENTS.md 第 20 条）

---

## 0. 要解决的用户问题（只有一个）

**做不出第一张画面。** 真实项目：48 集规划齐、6 个角色档案齐、**38 个分镜齐**，
**画面 0/38、视频 0/38、配音 0/38、成片未合成**。

整条链断在同一处：**做一次生成的成本太高**。今天要经过
绑参考（左栏）→ 看 Prompt（中栏）→ 复制 → 切到浏览器另开网页 → 生成 →
下载 → 回来上传 → 挂到正确的槽位。**38 次。**

本卡把这条链压到「在一张表上写清楚 → 看见缺什么 → 一张卡里生成」。

---

## 1. 实施前必须先确认的两件事（审计没查到底，不要假设）

### 1.a 分镜草稿的真实形态与 60 vs 38

实测 `照见未明rev2/studio/canvas.json`：

```
nodes[type=scriptgen].versions[v=1].raw      →  60 条
raw[0] 的键：sequence / title / description / duration_seconds / slot / shotId
填充率：shotSize 0/60 · angle 0/60 · cameraMotion 0/60 · action 0/60 ·
        emotion 0/60 · dialogue 0/60 · description 60/60
versions[v=1].shots                          →  60 行 [编号, 一整段文本]（旧展示格式）
```

**但界面（C-011）显示的是 38 个镜头**，且写「本集 0 个镜头（项目共 38）」。
**60 与 38 不一致，成因未查。** 开工第一件事是查清：
是过滤、是分集归属、还是两份数据。**在没查清之前不要动表格的数据源。**

### 1.b 新草稿是否保留结构化字段

`ctx.project.draftShots = curDraft.raw`（`app.js:4956`）—— 结构化草稿在
`versions[].raw`，`versions[].shots` 是扁平展示行。
确认**当前** `POST /api/agent/shots-draft` 应用到 canvas 时是否保留全部字段，
还是也会压平。这决定 1.2 是「补输入口」还是「先修数据通路」。

---

## 2. 批次 A（中风险）：分镜从卡片变成能横向工作的表

### 2.1 补齐字段与输入口 —— 这是 38/38「未记录」的真正成因

**现状（代码实测，三层复合）**：

| 层 | 事实 |
| --- | --- |
| Skill 产出 | `product-skills/builtin/storyboard-director/output.schema.json` 里 `shotSize` / `angle` / `cameraMotion` / `action` / `expression` / `emotion` 全是 `nonEmpty: false`（可选）→ 模型**全部省略**，真实项目填充率 0/60 |
| 编辑表单 | `src/ui/storyboard.js` 只有 6 个 `data-sf`：`title` / `description` / `action` / `cameraMotion` / `dialogue` / `duration`。**`shotSize` / `angle` / `emotion` 没有任何输入口** |
| 只读显示 | `ui/dailies.js:29-34`、`ui/episodews.js:158`、`ui/mediaws.js:121-122`、`ui/director.js:82` 四处显示它们，值为空时印「未记录」 |
| `lighting`（光影氛围） | **字段本身不存在** |

**要做**：
1. 给 `shotSize` / `angle` / `emotion` 补输入口；新增 `lighting`（光影氛围）字段
   （**加法字段，不做破坏性迁移** —— AGENTS.md 第 13 条）。
2. `storyboard-director` 的 output schema 把 `shotSize` / `cameraMotion` 改成**必填**，
   并在 `prompt.md` 里明确要求；`angle` / `emotion` / `lighting` 保持可选但在指令里点名。
   **已被历史 Run 引用的版本不得原地覆盖**（ADR-0067）——发布**新版本**。
3. 显示端不变（四处只读显示保留），但空值文案从「未记录」改成可点的
   「未记录 · 去填写」，落到表格对应单元格。

> **不修这一层，做表格视图也是空的。** 顺序不能反。

### 2.2 分镜表格视图

**现状**：C-011 —— 左边一列镜头缩略卡，选中一个在右边看详情。**一次只能看一个镜头。**
38 个镜头要对齐节奏、检查景别是否重复、看哪几镜没写运镜 —— 全做不到。

**要做**：⑦ 分镜设计增加**表格视图**，与现有卡片视图**并存**（不是替换）：

| 镜号 | 时长 | 画面描述 | 景别 | 光影氛围 | 台词 | 音效 | 运镜 | 提示词 | 操作 |

- 单元格**就地可编辑**，保存仍走「追加新草稿版本」这条既有写路径（不建第二条）。
- `sfx` 今天在音频工作区（`workflow/shotaudio.js`），**只读拉进这张表**，
  写仍留在音频工作区 —— 本卡不搬所有权。
- 「提示词」列显示 `promptc.js` 编译结果的摘要 + 缺口计数，点开进详情。
- 行操作：颜色标记 / 删除该行（删除仍是「保存为新版本」，不原地删）。

### 2.3 实体链接 → 真实的资产缺口

**现状**：「我还差什么才能开始生成」这个问题的答案散在四个页面：
分镜页（有没有描述）、参考统筹页（有没有绑参考）、作品设定页（角色有没有参考图）、
画面页（0/38）。**没有一处合起来说。** 而参考统筹页（C-012）在真实项目上说
**「没有缺口」**，实际 38 镜一个参考都没绑。

**要做**：
1. 画面描述里的角色 / 场景地做**实体识别 + 高亮 + 链接**到该实体。
   `src/workflow/breakdown.js` 已经有 `normName` / `matchProposals` / `derivedAppearances`
   —— 剧本拆解就是干这个的，**复用它，不要写第二套识别**。
2. 表头给**真实**的「准备资产 N/M」：M = 表里被引用到的实体去重数，
   N = 其中已有可用参考图的数量。
3. 这个计数**必须与 TASK-077 §1.4 接回来的三步向导第 ② 步一致**
   —— 两处不同的数字比没有数字更糟。`wizard.js` 现有算法若与此不符，
   **以本节推导为准，改 `wizard.js`**。
4. 与参考统筹页（`ui/refplan.js`）的「缺失」口径对齐，或明确说明两者算的不是一件事。

---

## 3. 批次 B（**高风险**）：一次生成 = 一张卡

**批次 A 提交并通过审查后才开工。**

**现状**：做一张图要经过 绑参考（左栏）→ 看编译出的 Image Prompt（中栏）→
`查看/修改` → `自动生成` 或 `复制` → 到别处上传结果。
**价格只在预检弹窗里出现一次。** 模型对用户**完全不可见**，也不能选。

**目标形态**（对位 T-047）：一张卡上同时有

```
[参考 ①②③ 缩略图 chip，内联在 Prompt 文本里]
[Prompt（promptc 编译，可编辑）]
[模型 ▾]  [规格 ▾]  [⚡报价]  [提交]
[高级设置]
```

**要做**：
1. 镜头制作 ② 制作主画面 / ③ 制作视频 合并成一张「生成卡」。
2. **模型与规格可见可选** —— catalog 里有 model / resolution / duration 与报价
   （`config/providers`），今天前端一个都不露。
3. **报价常驻在提交按钮旁**，不是只在预检弹窗里出现。
   报价仍来自 Gateway preflight，**不得前端自算**。
4. 提交仍走 ADR-0041 两步：preflight → 人工确认 digest → command。
   **不得为了"一张卡"把人工确认省掉。**
5. 免费路线（复制 Prompt → 外部工具 → 导入）**保留在同一张卡上**，与付费并列。

**明确不做**（那是 Phase 3.1 / TASK-08x，需 ADR）：
- 参考从「按角色写死的槽位」改成有序数组 + `{{Image N}}`
- `ProviderRequest` 加多图字段
- 本批次**参考仍是现有槽位模型**，卡上只是把它们**显示**成编号 chip

---

## 4. 风险分级与检查（AGENTS.md 第 20 条）

| 批次 | 风险 | 理由 | 审查 |
| --- | --- | --- | --- |
| A | **中** | 派生视图状态 + 单层业务逻辑；新增加法字段不做迁移 | 1 轮 |
| B | **高** | 触及付费、Gateway 跨层合同、生成登记 | **2 轮**（第 2 轮仍报 P1 才允许第 3 轮） |

- 批次 A 结束跑相关前端/单元测试 + 定向 pytest；
  **批次 B 结束跑全量 pytest（两阶段并行）+ 全量前端 + ruff**。
- 若获授权走连续修改链（ADR-0068），中间提交把 `MOTV_CONTINUOUS_CHAIN=1`
  写在提交命令最前面，链尾统一跑全量。
- **批次 B 若被迫改 `ProviderRequest` 或 Provider catalog schema —— 停下，
  那属于 Phase 3.1，要先落 ADR。**

## 5. 测试

- 表格视图的纯视图模型可测（沿用 `ui/storyboard.js` 现有的可测视图模型风格）
- `shotSize` / `angle` / `emotion` / `lighting` 可写入并持久化到**新草稿版本**，
  旧版本不变
- 实体识别复用 `breakdown.js`，同一段描述在拆解与分镜表里认出**同一批实体**
- 「准备资产 N/M」与三步向导第 ② 步**数字一致**（守卫测试）
- 生成卡的报价来自 preflight，**不是前端算的**（守卫测试）
- 生成卡提交仍触发两步确认（守卫测试）

## 6. 验收（产品负责人看的）

真实项目 `照见未明rev2`：

1. ⑦ 分镜设计可切表格视图，38 行一屏横向可比。
2. 景别 / 光影氛围 / 运镜 **能填**，填完刷新还在，旧版本还能回切。
3. 重新生成分镜草稿时，AI **产出**景别与运镜（不再 0/60）。
4. 画面描述里的「林照」「算法实验室」是**可点的链接**。
5. 表头写「准备资产 N/M」，N/M 是真的，且与三步向导第 ② 步一致。
6. 镜头制作的生成入口是**一张卡**：参考 + Prompt + **模型可选** + 规格 + **报价** + 提交。
7. 走完一次真实生成（免费路线即可），画面从 0/38 变成 1/38。

## 7. 收口

- 重跑 `src/ui-gap-audit/tools/capture_current.py`，归档旧图，更新 manifest，
  生成 `comparison/current-vs-target-storyboard.png` 与
  `comparison/current-vs-target-generation-card.png`。
- 标记闭合：GAP-15 / GAP-20 / GAP-24 / GAP-25。
- Follow-up：60 vs 38 的成因（若 §1.a 查出是缺陷）、`sfx` 所有权是否搬家、
  参考数组化（Phase 3.1）。
