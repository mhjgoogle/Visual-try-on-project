# TASK-057：Production Upstream Workspace v1

- 状态：进行中
- ADR：[ADR-0054](../adr/ADR-0054-production-upstream-workspace.md)
- baseline：`6879370` + `7b182a3`（Connected Studio）
- 风险级别：**高**（canvas schema v9 → v10 + 持久化 + 迁移）

## 1. 目标

把 Production 从「项目 + 本集制作六阶段」改造成
**建立整部作品创作基础的上游工作空间**：

    创意 → 故事大纲 → 作品设定 → 分集规划 → Episodes（出口）

Shot Image / Video / Audio / Edit / Render / Generation provenance 不属于
Production（见 ADR-0054 决策 1）。

## 2. 实施映射

### 2.1 复用（不新建数据）

| 需求 | 复用 |
| --- | --- |
| 故事大纲 + 版本 | `story.versions` / `active` / `approved`（storydoc.js） |
| 人物 | `production.characters`（bibledoc.js，含 states/voice/refs） |
| 地点 | `production.locations` / LocationState（保持独立域） |
| 分集规划 | `story.plans[]` + confirm→instantiate Episode |
| Episode 实体 | `production.episodes` |
| AI 导演 | director.js / prodplan.js / directorops.js |
| 剧本 / 场景 / 分镜 / 媒体 / 时间线 / Workflow / Assets | 不动 |

### 2.2 最小扩展（schema v10，纯追加）

| 新增 | 位置 |
| --- | --- |
| Creative Brief（working draft + 版本链） | `story.brief`（storydoc.js） |
| 人物关系 first-class | `production.relationships[]`（canondoc.js） |
| 世界观 Canon | `production.world`（canondoc.js） |
| 上游版本号 | `production.canon = {characters, relationships, world}` |
| 正式 / 临时角色 | `character.tier`（bibledoc.js） |
| Episode Beat | `episode.beats = {plot, character, relationship, world}` |
| 上游依赖戳 | `episode.basedOn`（五键版本戳） |

### 2.3 UI 重构

- `shell.js`：NAV → 作品开发 + Episodes；本集制作嵌入 episode 上下文
- 新增 `ui/briefws.js`（创意）、`ui/relws.js`（人物关系）、
  `ui/worldws.js`（世界观）、`ui/epplanws.js`（分集规划 + Impact Review）
- `ui/storyws.js`：显示 Based on Creative Brief vN，「故事发展」不再是一级阶段
- `ui/production.js`：模块路由 + episode 模式
- `ui/director.js`：新模块的 observation / primary action；读取 brief /
  relationship / world / beats

## 3. 版本原则（必须遵守）

    Autosave != Version

日常编辑 → Working Draft（autosave）。只有以下才产生正式 Revision：

1. 用户主动创建版本；
2. 用户确认阶段成果；
3. 下游准备基于这个版本继续；
4. AI 做了明确的大型整体修订并由用户接受。

## 4. Impact 语义（三态，见 ADR-0054 决策 6）

    Impact = episode.basedOn（基线戳） vs 当前上游版本号

| 状态 | UI 显示 | 计入变化数？ |
| --- | --- | --- |
| `unknown`（戳 = 0，未记录） | 「上游基线未记录」+「建立当前基线」 | **否** |
| `current` | 「与上游一致」 | 否 |
| `outdated`（当前 > 戳） | 「⚠ N 个上游变化」→ 审阅里「上游已更新」 | 是 |
| `diverged`（当前 < 戳，指针回退） | 「⚠ N 个上游变化」→ 审阅里「上游已回退」 | 是 |

- legacy / 迁移来的 Episode 一律 `unknown`，**绝不显示「上游已更新」**；
- 迁移**不猜**它原来基于哪一版；
- 基线只能由显式用户行为建立：「建立当前基线」/「本集已复核」/
  确认分集规划（仅对本次新建 + 收养的 pristine 集）；
- **Deterministic dependency change**：系统负责，可证明；
- **AI semantic impact proposal**：当前无成熟 checker → 显示 unavailable，
  **不伪造**；
- 上游新版本**绝不自动重写** Episode。

## 4A. schema 编号占用

`v10` 已被本任务正式使用并写入真实项目存档。后续 asset URL /
project-relative path 迁移**必须是 v11+**（TASK-055 §4 ① 已同步更正），
本批不启动该迁移。

## 5. 验收（真实 Connected Project「夜班沉默」）

1. Production 打开后左侧是新的作品开发结构
2. Creative Brief 可编辑、autosave、reload 后仍在
3. Story Outline 使用现有版本语义（未新建第二份 Story 数据）
4. Character 可新增 / 编辑（含正式 / 临时）
5. Relationship 可建立并关联两个真实 Character
6. World Setting 可编辑
7. Episode Plan 显示 Plot / Character / Relationship / World beats
8. Episode 明确显示 Based on 上游版本
9. 上游创建新 Revision 后，已有 Episode 不被静默修改
10. UI 显示 upstream update / impact 状态
11. reload 后全部数据存在
12. Connected mode 无 demo seed
13. Workflow / Assets 未被破坏

## 5A. 验收结果（真实 Connected Project「夜班沉默」）

验收在真实项目存档
`<ProjectRoot>\studio\canvas.json`（v9，1 版大纲 / 1 版规划 / 1 集 / 1 角色 /
1 场景地 / 5 张图片资产 / 7 条生成记录）上执行，**不使用 demo seed**：

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | 左侧是新的作品开发结构 | ✅ 作品开发（创意/故事大纲/人物·人物关系·世界观/分集规划）+ Episodes；画面/视频/音频/剪辑 不在主导航 |
| 2 | Creative Brief 可编辑 / autosave / reload | ✅ 编辑只写 Working Draft，未产生版本；显式创建 v1/v2 后 reload 仍在 |
| 3 | Story Outline 使用现有版本 | ✅ 复用 `story.versions/active/approved`；未新建第二份 Story 数据 |
| 4 | Character 可新增 / 编辑 | ✅ 新增正式「陈默」「苏婉」+ 临时「值班医生」；创作层 6 个字段可编辑 |
| 5 | Relationship 关联两个真实 Character | ✅ 林晚 × 陈默、林晚 × 苏婉，11 个 facet 全部可写 |
| 6 | World Setting 可编辑 | ✅ 7 个 facet；`production.locations` 未被触碰 |
| 7 | Episode 显示四类 beat | ✅ Plot / Character / Relationship（start→event→end）/ World Reveal |
| 8 | Episode 显示 Based on 上游版本 | ✅ 创意 Brief v1 · 故事大纲 v1 · 人物 v1 · 人物关系 v1 · 世界观 v1 |
| 9 | 上游新 Revision 不静默修改 Episode | ✅ 标题 / beats / basedOn 逐字未变（deepEqual 快照比对） |
| 10 | UI 显示 upstream update / impact | ✅ 左栏「2 更新」+ 卡片「⚠ 2 个上游更新」+ 影响审阅两段分离 |
| 11 | reload 后全部数据存在 | ✅ Brief 版本链 / 关系 / 世界观 / tier / beats / basedOn / impact 全部保留 |
| 12 | Connected mode 无 demo seed | ✅ 验收数据全部来自项目存档；demo seed 仅 local 模式 |
| 13 | Workflow / Assets 未被破坏 | ✅ 节点 / 资产登记 / 生成登记 / 时间线 deepEqual 未变 |

迁移安全性（最高风险项）：`migrateToCurrent` 在真实存档上 `status=ok`，
**原文件未被修改**，迁移结果通过 v10 校验，`save → load → save` 幂等。

截图（headless Edge，1680×1150，真实项目状态渲染）：创意 / 故事大纲 / 人物 /
人物关系 / 世界观 / 分集规划 / 影响审阅。

## 6. 测试

高风险 → full pytest + 全量 node --test + ruff + Codex 独立审查。

新增 `mockups/motv-workspace/tests/upstream.test.mjs` +
`tests/test_motv_upstream_task057.py`。

## 7. Scope guard

本批只做 Production upstream。**不做**：Episode Script/Scene/Shot 新 UI、
剧本&分镜合并、Image/Video/Audio/Edit redesign、Assets redesign、
Workflow redesign、TASK-056、asset URL schema、legacy cleanup、
TASK-049/050/052 相关工装。
