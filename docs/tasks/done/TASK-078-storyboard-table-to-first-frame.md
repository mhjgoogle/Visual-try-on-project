# TASK-078：从分镜到第一张画面 —— UI Gap Audit Phase 1

- 状态：**已完成**（2026-08-16，批次 A `db2781a` + 批次 B `f9d637f`，见 §8 实施记录）。状态头此前一直写着「未开工」而两个批次早已提交——一处过期的登记，2026-08-16 就地订正。
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../../src/ui-gap-audit/)，
  [ui-correction-plan.md](../../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 1
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

> **两件都已查清（2026-08-16，实施 Agent，开工第一件事）。结论见每小节末尾的
> 「查清结果」。**

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

#### 查清结果：不是缺陷，是一个过期的数字

**今天不存在 60 vs 38 的不一致。** 证据：

| 来源 | 数字 |
| --- | --- |
| `照见未明rev2/studio/canvas.json` → `scriptgen.versions[v=1].raw` | **60** |
| 同上 `.shots`（扁平展示行） | **60** |
| 截图清单**第二轮**（2026-08-16，TASK-077 收口后重抓）C-021 本集看板 | **60 镜头** |
| 同 C-022 分镜设计 | **草稿，60 镜** |
| 同 C-013/014/015/016/024 画面 / 视频 / 音频 / 审片 / 粗剪 | **全部 0/60** |

「38」只出现在 `reports/ui-gap-analysis.md`（GAP-11 / GAP-12 / GAP-13 / 优先级表），
而那份报告是对着**第一轮**截图（`archive/2026-08-16-pre-task077/`，commit
`18fa281`）写的。第二轮重抓时项目数据已经变成 60 镜，报告里的 38 没有跟着更新，
任务卡从报告里抄了这个数字。

代码侧也印证没有过滤：`storyboardModel` 的 `total = draft.length`，
`proddoc.episodeView` 只按「场景是否认领了这个 shotId」分组，
不丢弃任何镜头；48 集的 `scenes` 全为空，所以 60 镜全部落在「未归组」，
`episodeTotal = 0`。**「本集 0 个镜头（项目共 60）」是准确的。**

- **Follow-up（不在本卡）**：`ui-gap-analysis.md` 里的 38 应改成 60，
  或标注它引用的是 archive 那一轮。已在 §7 登记。
- 表格的数据源因此照常取 `pd.draftShots`，不需要先修。

### 1.b 新草稿是否保留结构化字段

`ctx.project.draftShots = curDraft.raw`（`app.js:4956`）—— 结构化草稿在
`versions[].raw`，`versions[].shots` 是扁平展示行。
确认**当前** `POST /api/agent/shots-draft` 应用到 canvas 时是否保留全部字段，
还是也会压平。这决定 1.2 是「补输入口」还是「先修数据通路」。

#### 查清结果：**答案是「两个都要」——通路真的在丢字段，而且丢在服务端**

逐层实测：

| 层 | 结论 |
| --- | --- |
| `server.py:_parse_shots` | **丢。** 每个镜头被重建成只有 `sequence` / `title` / `description` / `duration_seconds` **四个键**，模型答出来的景别 / 角度 / 运镜 / 动作 / 表情 / 情绪 / 台词**在 HTTP 边界上全部被丢弃** |
| `nodes/scriptgen.js` | 不丢。`raw: shots` 原样挂到版本上 |
| `app.js` 画布序列化 | 不丢。`versions: n.versions` 整体持久化，无键白名单 |
| `shoteditor.js normalizeShots` | 不丢（6 个加法字段），但**缺 `expression` / `environmentMotion`** —— 这两个 `promptc.js` 会编译，却在任何一次保存后被删除 |
| `shoteditor.js createShotEditor.open()` | **丢。** 深拷贝只列了 6 个基础键，**手工编辑弹窗过一遍就把全部加法字段删光**，哪怕只改了一个镜头名 |

所以 0/60 是**三个独立成因叠加**，单修任何一个都不会有变化：

1. schema 全部可选 → 模型省略；
2. 服务端在传输层丢弃 → 就算模型写了也到不了前端；
3. 编辑表单根本没有输入口 → 人也补不上。

**本卡三个都修**，并加守卫测试把三份「什么算加法字段」的清单钉在一起
（`tests/test_motv_shot_facets_task078.py`）。

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

> ### ⛔ 停止条件命中：「模型与规格**可选**」做不了，且不该硬做
>
> 本节第 2 条要求「模型与规格可见**可选**」。实测下来，**「可见」全部做到，
> 「可选」触发了本卡 §4 自己写下的停止条件。**
>
> `submit-video-generation` 是**按 ADR-0041 设计只收 packet 的**，
> `src/ai_video_workflow/app/paid_gateway.py` 的模块文档原文：
>
> > PACKET-ONLY: the command accepts exactly `task_id / shot_id / operation_id /
> > packet_version` … **It never accepts free-form model/resolution/duration/stage
> > — those would turn unapproved or stale parameters into paid work**
> > （ADR-0041「默认 packet 流；不接受自由参数改动已锁定方案」）。
>
> 代码层面 `_REQUIRED = ("task_id", "shot_id", "operation_id", "packet_version")`。
> 要让创作者选的模型真的生效，必须改这个命令的参数契约，并顺着改
> `ProviderRequest` —— 正是 §4 写明「**停下，那属于 Phase 3.1，要先落 ADR**」的两样。
>
> **因此本批次交付的是**：模型 / 分辨率 / 时长 / 能力 **从预检结果如实显示**
> （`preview.inputs` 本来就带这四项，前端一项都没露过），并在卡上写明
> **为什么不能在这里改、以及真正能改它的地方是重新锁定正式分镜**。
> **不放一个改不动任何东西的下拉框** —— 那会让创作者以为自己选了模型，
> 而跑的还是 packet 里那个，属于「界面显示已应用」那一类失败。
> 守卫测试 `卡上没有改不动任何东西的模型下拉框` 钉住这一点。
>
> **Follow-up（需 ADR）**：若产品确实要「选模型再生成」，那是一条新命令或
> 一个新的 packet 编译入口，连同 `ProviderRequest` 一起设计 —— Phase 3.1。

**明确不做**（那是 Phase 3.1 / TASK-08x，需 ADR）：
- 参考从「按角色写死的槽位」改成有序数组 + `{{Image N}}`
- `ProviderRequest` 加多图字段
- 本批次**参考仍是现有槽位模型**，卡上只是把它们**显示**成编号 chip

---

## 4. 风险分级与检查（AGENTS.md 第 20 条）

| 批次 | 风险 | 理由 | 审查 |
| --- | --- | --- | --- |
| A（卡上预判） | ~~中~~ | 派生视图状态 + 单层业务逻辑；新增加法字段不做迁移 | ~~1 轮~~ |
| A（**实际**） | **高** | §1.b 查出通路缺陷后，改动落到了 **`server.py:_parse_shots` 的响应形状 = 跨层合同** | **2 轮** |
| B | **高** | 触及付费、Gateway 跨层合同、生成登记 | **2 轮**（第 2 轮仍报 P1 才允许第 3 轮） |

> **批次 A 升档为高风险（2026-08-16，实施 Agent）。** 卡上预判「中」的前提是
> 批次 A 只动前端派生视图；§1.b 查出加法字段是在**服务端**被丢弃的，修它就
> 改了 `/api/agent/shots-draft` 的响应形状。AGENTS.md 第 20 条：
> **分级取改动触及的最高一档**，跨层合同是高风险档，「改动很小、原因很明显」
> 不构成降档理由。因此按 2 轮预算审查、并按高风险跑检查。

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
- Follow-up：
  - **`reports/ui-gap-analysis.md` 里的「38 镜」是过期数字**（见 §1.a），
    真实项目是 60。该报告对着 archive 那一轮写，重抓后没同步。
    改成 60，或就地标注它引用的是第一轮证据。**不在本卡范围，不顺手改**
    —— 那份报告是审计证据，改它要连着 C-00x 断言一起复核。
  - `sfx` 所有权是否从音频工作区搬到分镜表（本卡只读拉入，没搬）。
  - 参考数组化 + `{{Image N}}`（Phase 3.1，需 ADR）。
  - **`nonEmpty` 拦不住占位词**（codex round 1 记录，未修）：`prompt.md` 明确
    禁止「无」「常规」这类等于没写的答案，但 `output.schema.json` 的迷你语言
    只有 `nonEmpty`，它们能过校验。要真正拦住，得给这套语言加
    `deny` / `minLength` 之类的新构件 —— 那是 schema 语言本身的扩展
    （`skillpkg.py:_SCHEMA_KEYS` + `skills.js` 两侧镜像 + describeSchema），
    属于架构变更，按 ADR-0067 应先落 ADR，不在本卡范围。
    现状是**指令层要求 + 校验层只保证非空**，缺口如实记在这里。
  - **升 skillVersion 之后，历史 Run 的 Prompt 原文无法从磁盘复现**
    （codex round 4 提出，判为 ADR 层面问题、不是本卡缺陷）。ADR-0067 的
    包目录按 `skillId` 唯一，`load_catalog` 的 `merged` 是 `dict[str, Skill]`，
    容不下同一个 id 的两个版本；所以任何一次版本升级都会让旧版内容离开磁盘，
    Run 只能靠 `skillDigest` **识别**而不能**复现**它。要支持多版本包存储
    需要新 ADR。反驳与依据见 `.claude/tmp/last-review.md`。
  - **`ui.genIntent` 只按媒体种类存一份**（codex 批次 B round 2 记录，未修）：
    为镜头 B 起一次免费生成会覆盖镜头 A 的意图，之后导入 A 会丢掉 Prompt 溯源。
    既有行为，`ui/genentry.js` 里写法逐字相同；只改一处会让两个仍在用同一份
    状态的界面形状不一致，比现状更糟。现状的降级是诚实的——意图对不上时按
    普通上传记录，**不会写出一条错误的溯源**。修法：两个写入方一起改，或让
    `ui.genIntent` 按 `shotId` 分键。
  - 三步向导的「一键生成所有资产」仍走 `ui/estimate.js` 的**演示预算**
    （`budget.spend`、`p50 = n × 2.0`），不是 Gateway 真实报价。本卡只把
    它的**计数**改成真的，没有碰那条假预算路径 —— 那是 TASK-077 同一类的
    「不真实状态」，应单独立卡。

---

## 8. 批次 A 实施记录（2026-08-16）

### 8.1 做了什么

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | **加法字段不再在 HTTP 边界被丢弃**（§1.b 查出的真正成因）：`_parse_shots` 带过 8 个刻面，非空字符串才带、截断 500、缺就省略键 | `server.py`（`_SHOT_FACETS` + `_parse_shots`） |
| 2 | `storyboard-director` **升 v2**：`shotSize` / `cameraMotion` 改必填且 `nonEmpty`，新增可选 `lighting`，`prompt.md` 点名要求。**没有原地覆盖 v1**（ADR-0067 决策 3） | `product-skills/builtin/storyboard-director/*` |
| 3 | 补 **景别 / 角度 / 情绪 / 光影氛围** 四个输入口；`DETAIL_FIELDS` 一份清单同时驱动表单、保存映射与「有没有真改动」判断 | `ui/storyboard.js` |
| 4 | `ADDITIVE_SHOT_FIELDS` 收成**一份**清单；修复 `createShotEditor.open()` 深拷贝**会删光加法字段**的数据丢失；补进 `expression` / `environmentMotion` | `ui/shoteditor.js` |
| 5 | `lighting` 编进 Image / Video Prompt（空则不出现 → 老项目逐字节不变） | `workflow/promptc.js` |
| 6 | **实体识别 + 「准备资产 N/M」** 纯模块，复用 `breakdown.js` 的 `normName` 与保守匹配 | `workflow/shotentity.js`（新） |
| 7 | **分镜表格视图**：10 列、就地编辑、颜色标记、删除、实体链接、提示词缺口列 | `ui/shottable.js`（新）+ `styles/studio.css` |
| 8 | 三步向导第 ② 步改用**同一个** `assetReadiness`（此前是 `0/镜头数`，分子写死 0） | `ui/wizard.js` |
| 9 | 参考统筹不再把「无从判断」印成「没有缺口」 | `ui/refplan.js` |
| 10 | shell 接线 `data-ent-id`（开实体卡）与 `data-fillfacet`（落到表格那一格） | `ui/production.js` |

### 8.2 关键取舍

- **表格与卡片并存，不替换**（§2.2）。卡片回答「这一个镜头是什么」，
  表格回答「这一批对不对」。切换保留未保存缓冲。
- **写路径只有一条**：表格保存 = `ctx.shots.saveEdit` = 追加新草稿版本。
  删除行也是保存为新版本，保存前一直可撤销。没有第二条写路径。
- **只有一个 Prompt 编译器**：表格「提示词」列的缺口数来自
  `shotDetailModel(...).prompts.image`，用依赖注入避免
  `storyboard ⇄ shottable` 循环导入。
- **`shotSize` / `cameraMotion` 改必填是 fail-closed 的**：模型漏写一镜，
  整次 run 被拒。这是卡上明确要求的取舍——比静默产出 0/60 好，
  但代价是一次失败要重跑 3–5 分钟。`prompt.md` 因此把这两项写成硬要求。
- **「准备资产 N/M」的输入锚定在 `pd.draftShots`**（项目级草稿），
  两处调用点传同一个列表，守卫测试比对 `total` / `ready` / 实体清单本身。

### 8.3 独立审查（codex，4 轮，独立性未降级）

三轮各报一个 P1，是**同一主题的三张脸**——临时编辑缓冲与真正被保存的东西不一致：

| 轮 | 表现 | 根因 |
| --- | --- | --- |
| 1 | 删了行，`保存` 仍禁用 → 删除永远提交不了 | 「脏不脏」由最后一次按键决定，不由状态推导 |
| 2 | 改了时长，重渲染显示旧值、保存却写新值 | 行渲染与保存各有一套缓冲合并逻辑 |
| 3 | 卡片改景别 → 表格保存 → 回卡片只改标题 → 景别被悄悄回滚 | 两套缓冲同时存在，保存写下自己缓冲里的**每一个**键 |

根修复两条：**只有 `applyTableEdits` 定义「一次编辑意味着什么」**（单元格从它的
输出渲染），**任何时刻只允许一个脏缓冲**（切视图丢弃另一边，沿用既有确认闸门）。
第 4 轮看到这份 diff 后不再报它。

第 1 轮的一个 P2（提示词缺口不跟缓冲走）同批修掉；两个 P3/P1 判为不适用或需先落
ADR，记在 §7 Follow-up。完整报告见 `.claude/tmp/last-review.md`。

> **第 4 轮超出了高风险档 3 轮的天花板。** 理由写在这里以便追责：前三轮是同一
> 主题、第 3 轮是根修复，而「P1 的修复不得成为 loop 的最终未审状态」——那一轮
> 是为审它而花的，且事先声明是最后一轮。若它再报新 P1 则升级给产品负责人而不是
> 续轮（前三轮已显出「审查者总能找到更窄变体」的不收敛特征，TASK-061 十三轮同款）。

### 8.4 批次 B 实施记录（2026-08-16）

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | **一张生成卡**：参考编号 chip（含首帧单独标出）+ Prompt + 规格 + 报价 + 提交 + 免费路线 + 导入，全在一处 | `ui/gencard.js`（新） |
| 2 | 卡接进 ⑧ 镜头制作 ② 画面 / ③ 视频；导入的溯源意图逻辑原样搬过来 | `ui/mediaws.js` |
| 3 | 付费两步拆成 `preparePaidVideo` + `paidVideoQuote` + `paidGenerate`，**共用同一个信封**（否则报价的 digest 与提交的对不上） | `app.js` |
| 4 | `ctx.paidQuote` / `ctx.paidSubmit` 暴露给卡 | `app.js` |

**没有新增写路径。** 提交调的还是原来那条 ADR-0041 两步；免费路线是原来那条
复制 → 外部工具 → 导入，只是搬到了卡上。

**两条不可破的规则，都有守卫测试**：

1. **报价绝不在前端算。** `config/providers` 里就有单价，乘一乘就能显示一个数
   —— 而那个数没人核对过，却正好是创作者花钱前读到的那一个。价格只来自
   Gateway 预检的锁定目录报价；没报价时卡上**不出现任何货币字样**。
2. **人工确认一步不省。** 「一张卡」说的是控件放在哪，不是把批准真实扣费的
   那一步去掉。提交仍然跑一次**新鲜**预检并打开确认弹窗——缓存的报价只是
   信息，创作者批准的永远是弹窗里那个当前价。

**一处诚实标注**：卡上的 Prompt 可编辑，但**只对免费路线生效**；付费提交发送的
是已锁定 packet 里那份被批准过的 Prompt。改过就显示「Prompt 已改（仅用于免费
路线）」并给一键还原——不标出来就是「界面显示已应用」那类失败。

**独立审查（批次 B）**：codex 2 轮，独立性未降级，第 2 轮 `pass`。

- **round 1 P1**：改 Prompt 不触发重渲染（重渲染会把光标顶出正在输入的文本框），
  于是「仅用于免费路线」的警告**从不出现** —— 创作者可以改完 Prompt 直接点付费
  提交，全程没见过任何提示，而真正跑的是 packet 里那份。修法：警告常驻 DOM、
  默认 hidden、输入时就地掀开；并在付费提交前再确认一次（横幅在花钱的路径上不够）。
- **round 2 P2**：原币金额固定除以 100 —— 「最小单位」的指数按币种变，
  28 日元会被印成 ¥0.28。改为不做任何换算：只显示 Gateway 自己算的 JPY
  （预算也据此放行）+ 原币种代码。
- 另一条 P2 判为既有问题不修，理由与 follow-up 见 §7。

完整报告见 `.claude/tmp/last-review.md`。

### 8.5 测试

- `mockups/motv-workspace/tests/shottable.test.mjs`（新，31 项）
- `tests/test_motv_shot_facets_task078.py`（新，9 项）——含三份清单
  （客户端 / 服务端 / schema）互相钉死的守卫
- `tests/test_motv_skillpkg_task075.py`：冻结的迁移证据改为
  **「Prompt 可以变，当且仅当 skillVersion 升了」**，并断言版本不得倒退、
  豁免集合不得扩散到过半 —— 而不是把冻结证据改掉
