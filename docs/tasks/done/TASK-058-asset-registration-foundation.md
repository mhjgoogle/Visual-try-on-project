# TASK-058：Asset Registration Foundation（统一资产登记）

- 状态：**已完成（2026-08-23 复查收口，ADR-0082）**
  —— ~~进行中~~ 是状态漂移。证据：canvas 迁移 `v10 → v11` 署名「checkpoint CP2 / ADR-0055」，为每条 Asset 记录加上 kind / displayName / originalFilename / links / tags / reusable / needsReview —— 正是验收项 3 与 4；`src/workflow/assetreg.js` 在位。
  当前 `CANVAS_SCHEMA_VERSION = 18`，本卡那一级迁移之上又叠了四个版本 —— 到不了 v18
  而这一级没落地。**尚未在真实 Connected Project 上逐条走过**下面 §验收 的清单 ——
  按 [ADR-0082](../../adr/ADR-0082-no-signoff-gate-on-task-cards.md) 那是**信息，不是
  闸门**：本卡就此收口，用起来不满意再改
- ADR：[ADR-0055](../../adr/ADR-0055-unified-asset-registration.md)
- baseline：`83a8054`（Production Upstream v1 / schema v10）
- 风险级别：**高**（canvas schema v10 → v11 + 全部媒体写入口 + 迁移）

## 1. 目标

把「上传」从**保存文件**变成**登记资产**：

    Upload / Import
    → save media
    → immediately register Asset
    → classify
    → link context
    → visible everywhere

任何页面（Production / Workflow / Assets / 手动生成导入 / 音频 / 渲染）产生或
接收媒体，都走同一条路径；**禁止产生 orphan media file**。

## 2. 实施映射

### 2.1 复用（不新建数据）

| 需求 | 复用 |
| --- | --- |
| Asset 身份 / 版本链 | `assets` 注册表（M3）+ `mediaref.addVersion` 单一写入口 |
| collision-safe 物理文件名 | 既有 `<slug>_v<N>.<ext>` 版本占位（ADR-0048） |
| 生成溯源 | `generations` 注册表（M5） |
| 读时归属推断 | `ui/assetinbox.js`（tier A/B/C，保持不变） |
| 存储生命周期 | `storageState`（M5） |

### 2.2 最小扩展（schema v11，纯追加）

| 新增 | 位置 |
| --- | --- |
| 语义类型 `kind`（12 种，可为 null） | 每条 Asset 记录 |
| `displayName` / `originalFilename` | 每条 Asset 记录 |
| `links{episodeId,sceneId,shotId,characterId,locationId,generationId}` | 每条 Asset 记录 |
| `tags[]` / `reusable` / `needsReview` | 每条 Asset 记录 |
| 新模块 `workflow/assetreg.js` | 声明词表 + 登记/分类/读模型 |
| canonical Reference 链 `ref-<uuid>` | `assets.images` 内（复用既有 slot 命名空间） |

**没有第二张注册表**：declaration 落在 Asset 记录本身。

### 2.3 写入口改造（全部）

| 位置 | 声明 |
| --- | --- |
| `ctx.media.importShotMedia` | shot-image / shot-video + shot/scene/episode |
| `ctx.audio.importKey` / `importPool` | 调用方声明 dialogue/ambience/sfx/bgm |
| `ctx.audio.ttsDialogue` | dialogue + 说话人 characterId |
| `ctx.assets.importReference` / `importReferenceVersion` | 四类参考 + 版本链 |
| `assetlib.addFinal` | final + episodeId |
| `adoptPaidIntoSlot` | shot-video（归属已证明稳定后） |
| `nodes/shared.js` 上传 | 按节点类型声明；音频节点诚实不声明 |
| `nodes/assets.js` 付费图 | shot-image |
| `nodes/audio.js` TTS | dialogue |
| `mediaref.addVersion`（兜底） | `ensureDeclaration` 填默认值 → 未声明即**未分类**，不是非法文档 |

### 2.4 服务端

`POST /api/projects` 创建时同时建立 `studio/` 与 `media/`（决策 5），
回滚路径同步清理。**不做物理分类子目录。**

## 3. 迁移原则（必须遵守）

    只回填文档已经记录的事实

- `originalFilename` / `displayName` 迁移后一律 `null`；
- `tags` 空、`reusable` false；
- 没有记录归属的资产 → `kind: null` + `needsReview: true`，
  **照常登记、照常可见**；
- 绝不从文件名 / 路径推断语义。

## 4. 验收

1. 新项目创建后目录含 `project.json` / `studio/` / `media/`
2. 真实存档 v10 → v11 迁移 `status=ok`，原文件未被修改
3. 迁移后角色参考 / 场景参考 / 对白 / 环境音 / BGM / 成片 / 镜头图片&视频
   自动带上正确 kind 与 links
4. 未记录归属的资产为 `needsReview`，不被猜测
5. 上传参考图 → 立即产生 Asset + 分类 + 关联
6. 同一参考的新版本 append 到同一条链（v1 → v2 → v3），不产生三份资产
7. 手动生成导入 → Asset + promptSnapshot + Generation 链接
8. reload 后全部 declaration 保留
9. Workflow / Timeline / Final lineage 未回归

## 5. 测试

高风险 → full pytest + 全量 node --test + ruff + Codex 独立审查。

新增 `mockups/motv-workspace/tests/assetreg.test.mjs`（25 项）+
`tests/test_motv_assetreg_task058.py`。

## 6. Scope guard

本批只做登记基础。**不做**：asset URL / project-relative path 迁移、
项目改名 / 移动 / 导出、TASK-056、Asset Library 界面重做（CP5）、
Reference Planning 界面（CP4）、Local AI Runtime（CP3）。
