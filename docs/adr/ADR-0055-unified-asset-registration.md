# ADR-0055：统一资产登记路径（上传 = 登记 + 分类 + 关联）

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0053](ADR-0053-project-rooted-studio-storage.md)、
  [ADR-0054](ADR-0054-production-upstream-workspace.md)、
  [TASK-058](../tasks/TASK-058-asset-registration-foundation.md)

## 背景

M3 起 `assets`（Project Asset Registry）已经是创作媒体的唯一耐久 owner：
每个媒体版本是一个带 `assetId` 的 Asset 记录，节点 uploads 是它的别名视图。
这一层是对的，问题在**登记的完整性**：

1. **写入口分散**。`ctx.media.importShotMedia`、`ctx.audio.importKey`、
   `ctx.audio.ttsDialogue`、`workflow/nodes/shared.js` 的节点上传、
   `assetlib.addFinal`、付费图/视频收养各自拼一次
   `query.uploadAssetImage → mediaref.refFromResponse → mediaref.addVersion`。
   新页面要上传，只能再抄一遍；抄漏一步就产生一个**没有语义、没有上下文**的
   记录。
2. **没有语义类型**。一个 Asset 记录只知道自己在哪个 domain（images / videos /
   audio / finals）和哪个 slot。「角色参考图」「场景参考图」「道具参考图」
   「风格参考」「外部参考」在域里根本不存在——它们只能塞进 `images` 的某个
   slot，然后靠 `production.characters[].referenceAssetIds` 反查。
3. **没有上下文关联**。Episode / Scene / Shot / Character / Location /
   Generation 的归属只能由 `ui/assetinbox.js` 在**读时**推断。推断是对的
   （它明确区分「确定 / 有证据 / 不确定」），但**上传那一刻用户明明知道**
   这张图是给谁的，这个事实却没有被记下来。
4. **人类名字缺失**。UI 只能显示 `assets-slot-3 v2` 这样的槽位串，或者直接
   显示 URL；原始文件名在上传后即被丢弃。

结果就是需求里说的那句话：**上传 ≠ 保存文件**。今天它恰恰只是保存文件。

## 决策

### 决策 1：一条统一的 Import → Register 路径

新增 `src/workflow/assetreg.js`，它是**唯一**的资产登记入口：

    registerUpload({ reg, domain, key, response, declaration })
      → 铸造/沿用 assetId（仍走 mediaref.addVersion 这个既有单一写入口）
      → 在同一条 Asset 记录上盖上 declaration
      → 返回 MediaRef

`declaration` 是**上传那一刻用户/调用方所声明的事实**：

| 字段 | 含义 |
| --- | --- |
| `kind` | 语义类型（见决策 2），无法确定时为 `null` |
| `displayName` | 人类可读名字；空时 UI 用派生标签，绝不显示 URL |
| `originalFilename` | 用户机器上的原始文件名，原样保留 |
| `links` | `{episodeId, sceneId, shotId, characterId, locationId, generationId}` |
| `tags` | 创作语义标签（雨夜 / cinematic / 暖光…），CP5 使用 |
| `reusable` | 仅由用户显式标记，**不因「被用过多次」自动推断** |

**不新建第二张注册表**：declaration 直接落在既有的 Asset（MediaRef）记录上，
所以不存在「索引与实体不一致」这一整类缺陷。

### 决策 2：语义类型是**声明**，不是路径推断

    character-reference  location-reference  prop-reference
    style-reference      external-reference
    shot-image           shot-video
    dialogue             ambience            sfx            bgm
    final

规则：

- **绝不从文件路径 / 文件名推断语义**。物理文件名只保证唯一与安全。
- `kind = null` 是合法且诚实的状态，配 `needsReview: true`，
  资产照常登记、照常可见，只是等待分类——**绝不因为分类不出来就不登记**。
- `kind` 是「这是什么」；**「它被用在哪里」仍然是派生的**
  （`ui/assetinbox.js` 的确定性归属、CP5 的 Usage）。两者不得互相覆盖：
  用户把某张图从角色参考里移除，不会让这张图突然「不是角色参考图」。

### 决策 3：参考图是**有版本链的 canonical Reference**，不是一次性文件

角色/场景/道具/风格参考走 `images` 域下一个自己的 chain key
`ref-<uuid>`（`mintId("ref")`）。同一个参考的新版本 append 到同一条链
（v1 → v2 → v3），`current` 指针选中生效版本。

这样「SH01 / SH02 / SH05 共用 林照 Ref v3」是**一条链 + 一个版本指针**，
而不是三份复制的资产（CP4 的 Reference Planning 依赖这一点）。

slot 命名空间本来就是任意字符串，`assetlib.shotIdForKey` 对未知 key 诚实
返回 null，因此复用它不会污染既有的 slot→shot 证明。

### 决策 4：迁移只回填**可证明**的分类（schema v11）

`migrateV10ToV11` 是纯追加，并且**只在事实已经被文档记录时**才写 `kind`：

| 已记录的事实 | 回填 |
| --- | --- |
| `reg.finals` 的记录（`origin: "compose"`） | `final` |
| `production.characters[].referenceAssetIds` 命中 | `character-reference` + `links.characterId` |
| `production.locations[].referenceAssetIds` 命中 | `location-reference` + `links.locationId` |
| audio key `voice-*` | `dialogue`（前缀由**本系统**写入，是约定不是猜测） |
| audio key `sfx-*` | `sfx` |
| audio key `amb-*` | `ambience` |
| audio key `bgm-*` / `music-main` | `bgm` |
| `scene.ambienceAssetId` 命中 | `ambience` + `links.sceneId` |
| `scene.bgmAssetId` / `episode.bgmAssetId` 命中 | `bgm` + `links.sceneId/episodeId` |
| images 记录带 `creativeShotId` | `shot-image` + `links.shotId` |
| videos 记录带 `creativeShotId` | `shot-video` + `links.shotId` |

其余一律 `kind: null` + `needsReview: true`。

**`originalFilename` 迁移一律为 `null`**——它从未被持久化过，编造一个
（例如从 URL 反推 `assets-slot-3_v2.png`）会把系统生成的名字冒充成用户的
原始文件名。`displayName` 同理为 `null`，UI 显示派生标签。

`links` 里没被证明的键一律缺省为 `null`，**不猜**。

### 决策 5：项目文件夹在创建时就成型

`POST /api/projects` 除 `project.json` 外，同时创建 `studio/` 与 `media/`。
今天它们是首次写入时惰性创建的，结果是一个刚建好的项目**看不出自己的结构**。

    <Project>\
    ├─ project.json
    ├─ studio\        （canvas.json 落这里）
    └─ media\         （所有媒体字节落这里）

**不做物理分类子目录**：Asset Registry 是分类真源，`media/` 只负责稳定存储。
物理分层会立刻制造「文件在 images/ 但语义是 character-reference」这类不可能
调和的双真源。

### 决策 6：文件身份

- 物理文件名：沿用既有 `<slug>_v<N>.<ext>` 版本占位机制（ADR-0048），
  slug 受 `_NAME_RE` 约束、`_claim_version` 原子占位 → collision-safe。
- 用户看到的是 `displayName`（缺省时是派生标签：类型 + 上下文 + 版本）。
- `originalFilename` 原样保留，只用于展示与取回，**绝不参与路径构造**。

## 后果

正面：

- 任何页面新增上传只需调用一个函数，漏登记在结构上不再可能；
- 「这是什么 / 属于谁」在上传那一刻就被记下，而不是事后靠推断；
- 参考图第一次成为可共享、可版本化的 canonical 对象，CP4 的 Reference
  Planning 与 CP5 的 Usage 都建立在同一份数据上；
- 迁移不编造任何历史。

代价：

- 高风险变更（schema + 持久化 + 迁移 + 全部媒体写入口重构），
  需要 full pytest + node + ruff + Codex 独立审查；
- 既有存档里绝大多数资产会落在 `kind: null` / `needsReview`——这是**诚实的
  代价**，用户在资产库里逐个确认即可，系统不替他猜。
