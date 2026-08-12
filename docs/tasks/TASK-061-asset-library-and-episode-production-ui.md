# TASK-061：Asset Library + Episode Production UI

- 状态：已完成（CP5–CP7 实施 + 真实 Connected 验收）
- ADR：[ADR-0055](../adr/ADR-0055-unified-asset-registration.md)（资产登记）、
  [ADR-0057](../adr/ADR-0057-shot-production-state-and-dailies.md)（镜头生产状态）、
  [ADR-0058](../adr/ADR-0058-production-memory-library-and-episode-production.md)
- baseline：`38f1168`
- 风险级别：中（界面 + 派生读模型；无 schema 迁移）

## 0. 并发协作声明（AGENTS.md 规则 14/15）

本仓库当前有两个 agent 会话。TASK-057 会话已于 `8b03d70` / `0a1211c` 提交并结束
其批次。**本任务（TASK-061）拥有以下文件**，其他会话请勿同时修改：

    mockups/motv-workspace/src/workflow/assetusage.js      （新）
    mockups/motv-workspace/src/workflow/geninput.js        （新）
    mockups/motv-workspace/src/ui/assetlibws.js            （新）
    mockups/motv-workspace/src/ui/refplan.js               （新）
    mockups/motv-workspace/src/ui/episodews.js             （新）
    （参考选择器最终没有独立成文件：它是镜头详情里的一个面板，
      实现在 episodews.js 内，与它服务的镜头同处一个上下文）
    mockups/motv-workspace/src/app.js
    mockups/motv-workspace/src/ui/production.js
    mockups/motv-workspace/src/ui/shell.js
    mockups/motv-workspace/src/ui/wfgraph.js
    mockups/motv-workspace/src/workflow/provenance.js
    mockups/motv-workspace/styles/studio.css
    mockups/motv-workspace/tests/{assetusage,episodeprod,wfspine}.test.mjs （新）
    mockups/motv-workspace/styles/wfgraph.css
    tests/test_motv_asset_library_task061.py               （新）

**不属于本任务**（保持不动）：`services/persist.js`、`ui/fieldsync.js`、
六个上游工作区（briefws / relws / worldws / epplanws / biblews / workspaces）、
`server.py` 的写入顺序改造、TASK-049/050/052 工装。

## 1. 目标

1. **Asset Library**：从 storage manager 变成 visual-first Production Memory
   Library —— 回答「我有什么可以复用」。
2. **Episode Production**：剧本 ↔ Scene ↔ Shot 在同一创作上下文；Reference
   Planning；Generation Input Set；Prompt / 手工生成任务。
3. **Workflow**：溯源图扩展到 Reference / Prompt 层 + Episode-first 过滤。

## 2. 产品边界（用户确认）

    Creative Brief / Outline / Character / Relationship / World /
    Episode Plan / Episode Script / Scene / Shot
      = canonical domain data，必须 autosave + reload，**不是 Asset**

    Asset Registry 只登记媒体与 Reference 等资产。

Usage / Reference Planning 一律是**派生读模型**，不复制 canonical 数据。

## 3. 验收

见 ADR-0058；核心是真实 Connected Project「夜班沉默」上走通一次
Prompt → 外部生成 → 上传 → 自动登记 → Shot → provenance。

### 3.1 真实 Connected 验收结果（2026-08-12）

驱动方式：Playwright（Edge channel，无需下载 Chromium）驱动**真实 studio →
真实后端 → 真实项目**。没有 demo seed、没有 fixture、没有被 mock 的上传；
送进去的是一张真实写到磁盘上的 PNG。

| 步骤 | 结果 |
| --- | --- |
| 打开真实项目「夜班沉默」（真实项目卡） | ✅ |
| 本集制作：1 个场景 / 3 个镜头在同一视图 | ✅ |
| 镜头详情：真实 `<video controls>` 播放（0:03） | ✅ |
| 参考统筹：已存在 / 建议复用 / 缺失 | ✅ 正确识别林晚与暗夜酒吧已有参考 → 建议复用而非新建 |
| 生成任务：真实编译的 180 字 Prompt + 输入集合 | ✅ 模型/seed 明说「未知（外部生成不上报）」 |
| 参考选择器四入口 | ✅ 已绑定 / 本集推荐 / 资产库 / 临时上传 |
| **上传真实外部生成结果** | ✅ 文件落入项目 `media/`（11 → 12 个文件） |
| Generation 记录 | ✅ `type=image status=success provider='manual' model=None`，promptSnapshot 已冻结 |
| Asset 登记 | ✅ `domain=images chain=v1-1 kind='shot-image'`，links 带 episode/scene/shot + generationId，`originalFilename='external-result.png'` 保留 |
| 审片 / 资产库 / Inspector（使用·溯源·技术细节） | ✅ |
| Workflow：剧本行 + 主干节点，Inspector 明说「创作文档」 | ✅ |
| 过滤 图片 / 视频 / 失败 | ✅ 9 / 4 / 0 个节点 |
| JS 异常 | **0** |
| 失败请求 | 1 个，且是已知环境项（见下） |

**已知环境项，非本次工作的缺陷**：
`GET /api/projects/夜班沉默/budget` → 403 `account_scope`。「夜班沉默」是
studio 建的项目，位于服务器 `--account-root` 之外，因此账户域的预算查询被拒。
应用本身已经处理（`REAL_STANDING` 保持 null）。**但顶栏仍然显示 fixture 的
「已花 ¥9,040 · 余额 ¥20,960」**——真实项目上显示演示数字，属于既有行为、
在本任务范围之外，记录于此，建议单独收口。

### 3.1a codex 独立审查（13 轮，两个半区都收敛）

完整差异超过审查脚本 4000 行上限，按技能规定**收窄范围**而不是抬高上限：
CP5–CP6 与 CP7 分半区送审。每一轮都由 **codex** 产出裁决（经 WSL 传输 shim），
**没有回退到 claude，跨模型独立性未降级**。

- **CP5–CP6：轮 A8 `VERDICT: pass`**（无 blocking、无 non-blocking）
- **CP7：轮 B5 无 blocking**，唯一 non-blocking 经实测为误报

循环没有固定轮数上限，由**进展**收束：每一轮都修掉至少一个新的真实缺陷。
完整记录（含 5 条误报/不适用的驳回理由与 1 条 out-of-scope）见
`.claude/tmp/last-review.md`。

**审查发现并修复的 14 处缺陷**（与 §3.2 的自查发现合并共 16 处）：参考统筹按
类型而非按对象判断已绑定、登记 kind 不校验文件、卡片嵌套交互控件、使用去重
key 漏掉主体 id、选择器把已归档参考画成破图、填补缺口后没有真正绑定、生成记录
以 prompt 为门槛、被清空的 Prompt 被顶替、存下来的 Prompt 被 trim、被取代的
参考版本仍算在用、intent 只带 entry 时溯源丢失、剧本草稿清空后图上仍显示旧版本、
文件选择器的取消猜测、守卫测试落后于实现。

### 3.2 本次自查发现并修复的真实缺陷

1. **`assetusage.js` 字面 NUL 字节**（独立审查 F2，P1 阻塞）——git 判定该文件
   为 binary，10088 字节从此不出现在任何 diff 里，且全量 pytest 失败。改为
   `JSON.stringify([...])`；**`kind` 保留在 key 里**（审查建议的片段省略了它，
   省略会让「人物参考」与「镜头参考」两种不同性质的依赖被合并，去重语义
   就变了）。
2. **`startGeneration` 静默降级未知 status**（F1，P3）——改为拒绝。
3. **三个 CSS token 从未存在**：`--card` / `--muted` / `--warn` 不在
   `tokens.css` 里，所以自 CP4 起每个 `background: var(--card)` 都是透明的、
   每个 `color: var(--muted)` 都继承正文色。改为真实词表。
4. **生成任务面板 sticky 定位穿透**——面板被钉在滚动视口底部，镜头列表从它
   身上滚过去，两边文字互相透视。改为 `relative + z-index`。
5. **版本号打印两次**——`derivedLabel` 在未命名时回退为「人物参考 v1」，
   旁边再打一个 v1 chip 就成了「人物参考 v1 v1」。新增 `nameWithVersion`。
6. **`test_motv_shotprod_task060.py` 的死断言**（`or True`）——已于 `38f1168` 修复。

### 3.2a 附带发现（不属于本任务，已记录待收口）

1. **commit gate 并非每次提交都真正拦截。** 它在本批中确实两次拦下了失败的
   测试（一次过期断言、一次被误判为写入的比较），但也放过了至少一次同样会
   失败的提交（`2374f74`）。属 TASK-050/052 工装范围。
2. **`gate.ps1` 的 `commit` 匹配可被 `git commit;` 绕过**（codex 轮 B 报告）。
   同属 TASK-050/052；AGENTS.md 规则 14/15 下不由本任务修改。
3. **真实项目顶栏仍显示 fixture 预算数字**（见 §3.1）。

### 3.3 诚实的限制

- **场景剧本定位是保守的位置匹配**。真实项目「夜班沉默」上它当前判定为
  「无法对应」并如实显示提示，因为该集剧本的场景标题数量与场景数不一致。
  这是有意的取舍：显示邻近段落会是一个看起来可信的谎言。
- 溯源图的**创作主干在 UI 上只有 script 行与 shot 节点是卡片**；scene 与 shot
  的层级本来就是 TASK-054 的渐进披露分组行，再画一遍只会是噪音。数据模型里
  三层节点与边都完整存在并被单测钉住。

## 4. Scope guard

**不做**：Media API Provider、asset-path schema 迁移、TASK-056、legacy cleanup、
项目改名 / 导出。以上均未触碰。
