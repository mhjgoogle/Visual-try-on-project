# TASK-082：项目健康与资产内容树（Phase 2 下半 · 之二）

- 状态：**已完成**（2026-08-16 · 本链链尾）
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../src/ui-gap-audit/) GAP-12 / GAP-10 / GAP-11，
  [ui-correction-plan.md](../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 2.4 / 2.5 + Phase 4.1
- **前置：TASK-081 已完成并提交**
- 验收环境：**真实 Connected Project `照见未明rev2`**

> 三条彼此独立、都很小，合成一卡是为了**少开一张卡**，不是为了一起做。
> 允许分三次提交。

---

## 1.1 ⚙ 项目健康分区（GAP-12）

**现状**：三个查询**服务端路由都在跑**，前端**一次都没调**：

| 路由 | 内容（真实项目实测） |
| --- | --- |
| `/api/projects/<p>/plan` | **54 步** L0–S7 计划，含 owner / 执行类 / Gate |
| `/api/projects/<p>/problems` | 真实项目有 **1 条** `source_corrupt`（`config/wfm1.json` 缺失） |
| `/api/projects/<p>/approvals` | 审批审计 |

`services/query.js` 的 `getQuery` 只被 `status` / `cost` / `budget` 调用过。

创作者无法回答「这个项目整体在哪一步」「有什么数据问题」——
今天的进度只有各页各自的局部计数（`0/38`、`38 镜`），**没有全局**。

**要做**：⚙ 项目设置增加「项目健康」分区：
阶段推进（`status.scope`：`current_stage` / `approved` / `total` / `progress`）+
计划总览（`plan` 的 54 步）+ **问题清单**（`problems`）+ 审批审计（`approvals`）。

**与 TASK-077 §1.1 的 ⚠ 对齐**：顶栏那个 ⚠ 已经在显示 `problems[]`。
本分区是它的展开面，**同一个数据源，不得算出两个不同的问题数**（守卫测试）。

**诚实纪律**：这四个查询的每个字段都带 `{value, provenance}`。
`unavailable` 一律显示为 `—` + 原因，**不得回落到 0 或空**
（TASK-077 §1.1 已经确立这条，本卡沿用同一套渲染）。

---

## 1.2 资产库：删重复 rail，改内容树（GAP-10）

**现状**：C-018 —— 左 rail 七行（全部资产 / References / Images / Videos / Audio /
Final / Collections / 存储管理）**和**页内七个筛选 chip 同时存在，
是同一个词汇的两个入口。

TASK-073 §1.1 **已经决定** `ASSET_NAV` 删除、七行变成 `ASSET_FILTER_ALIAS`
预设筛选值。别名做了，rail 没删（`shell.js:145-161` 的注释说留给 TASK-074）。

**要做**：
1. 删 rail 的**媒体分类七行**，保留页内 chips。
2. rail 位置改**内容树**：按 **角色 / 场景地 / 剧集 / 未归属** 分组的资产
   —— 这才是 LibTV 那一栏真正提供的价值（T-030 画布元素树）。
   分组数据现成：`asset.links` 已经有 `characterId` / `locationId` /
   `episodeId` / `sceneId` / `shotId`。
3. `存储管理` 那一行**保留**（它不是媒体分类，是入口）。
4. `ASSET_FILTER_ALIAS` 的历史键**必须仍能解析**（`assets:image` 等）。

---

## 1.3 项目卡：封面 + 进度（GAP-11，Phase 4.1 提前）

**现状**：C-001 —— 灰色文件夹图标 + 项目名 + 「真实项目」徽标 + 「未记录资产位置」。

**要做**：卡片 = 首个可用参考图或成片首帧（**用 TASK-077 的探针判"可用"**，
不要拿一个已经丢失的文件当封面）+ 「48 集 · 38 镜 · 0 已生成」+ 上次编辑时间。
点击直达上次所在页（**TASK-081 §1.3 已做，本条只是把数字加上**）。

**成本很低**：数据全在 canvas + `project_status` 里，且探针已经存在。

---

## 2. 风险分级与检查

| 交付 | 风险 |
| --- | --- |
| 1.1 项目健康 | **低**（纯只读展示，数据源已有 HTTP 路由） |
| 1.2 资产内容树 | **中**（IA / 派生视图状态） |
| 1.3 项目卡 | **低**（纯展示） |

**整卡中风险 → 审查 1 轮。**

## 3. 测试

- 顶栏 ⚠ 的问题数 == 项目健康分区的问题数（守卫测试，同一数据源）
- `unavailable` 字段渲染 `—`，不渲染 0（沿用 TASK-077 的断言）
- `ASSET_FILTER_ALIAS` 的每个历史键仍解析到资产库 + 正确筛选值
- 内容树的分组来自 `asset.links`，**不新建第二份归属关系**（守卫测试）
- 项目卡封面**不选一个探针判定为 MISSING 的文件**（守卫测试）

## 4. 验收（产品负责人看的）

1. ⚙ 里能看到：这个项目在 L0–S7 的哪一步、54 步计划、**1 条数据问题**、审批记录。
2. 顶栏 ⚠ 点开的问题数，和 ⚙ 里的一致。
3. 资产库左栏不再是七行分类，是按角色/场景地/剧集分组的**内容树**；
   页内 chips 还在，功能不减。
4. 落地页项目卡有封面和「48 集 · 38 镜 · 0 已生成」，封面不是碎图。

## 5. 收口

- 重跑 `capture_current.py`（此时已是 URL 驱动），归档旧图，更新 manifest
  → **受阻，未做**：真实 Connected Project `照见未明rev2` 不在本机，后端起不来。
- 标记闭合：GAP-10 / GAP-11 / GAP-12 —— 代码侧已闭合，**截图证据待补**。

## 6. 实施记录

- §1.1 `src/ui/healthws.js` + `realmap.mapPlan / mapProblemRows / mapApprovals /
  mapProblemEnvelope / problemUnion / problemCount`：⚙ 新增「项目健康」分区，
  四个只读查询第一次被前端调用。顶栏 ⚠ 与本分区共用 `problemUnion` 这**一个**
  推导——四个查询各自的来源问题合并去重，两处不可能算出不同的数（守卫测试）。
  「数据源问题」（读不出来）与「问题记录」（跑出来有问题）分开报数，不合并。
- §1.2 `assetlibws.assetTreeModel / renderAssetTree` + `ASSET_NAV` 收缩：
  左栏七行媒体分类删除，改为按 角色 / 场景地 / 剧集 / 未归属 的内容树；
  分组只来自 `asset.links`，不新建第二份归属关系；`assets:*` 历史键仍解析到
  资产库 + 筛选值。`libraryModel` 新增 `unlinked` 筛选——「没有归属的素材」是一个
  分组，不是一个缺口。
- §1.3 `src/ui/landingcard.js`：项目卡封面（探针判定 MISSING 的文件绝不当封面，
  `<img onerror>` 会记下并换下一个候选）+「N 集 · N 镜 · N 已生成」+ 上次打开时间；
  画布读不出来时**一个数字都不写**，绝不写 0。

### 两处旧断言被改写（不是为通过而改）

- `workspaces.test.mjs`「ASSET_NAV is media categories only」→ 改写为
  「资产库 rail 只剩入口」。规则的变更由 TASK-073 §1.1 决定、本卡执行；改写后的
  断言同时钉住了另一半：七个 `assets:*` 键**仍必须解析**到资产库 + 正确筛选值。
- `renderAssetRail` 那条随之改用 `assets` / `storage` 两行。

另有一处 Python 守卫的**文本近似**被收窄（`tests/test_motv_assets_m3.py`）：
needle `.current =` 会把 `status.current == null` 这种比较一起命中。规则没变，
改的是写法——把那行改成 `status.current ?? null`，守卫一个字没动。

独立审查：codex 跨模型 2 轮，2 条 P1 已修（`HEALTH` 缓存没按项目分键，会把 A 的
健康数据显示成 B 的；只数了预算那一个 envelope，其它三个查询报的来源问题被丢掉）。
1 条 P3（审批表格 `<td>` 未闭合）带证据驳回——标签是配平的，并补了断言钉住。
