# Screenshot Manifest

所有 UI 审计截图的登记表。报告里只引用 **Screenshot ID**，不写「看截图」。

**像素不进 Git**（`.gitignore`）：`current/` 拍的是用户自己的创作项目，`target/` 拍的是
另一家公司的产品界面 —— 与 `_agent-tools/` 同一条理由（AGENTS.md 第 23 条）。
**本清单、报告和抓图脚本进 Git**，所以审计可以从仓库复现。

重新生成 `current/`：

```bash
# 1. 起后端（真实 Connected Project）
PYTHONIOENCODING=utf-8 .venv/Scripts/python mockups/motv-workspace/server.py \
    --account-root "D:/02_Work/04_video-work/MotvProjects" --port 8791
# 2. 抓图
PYTHONIOENCODING=utf-8 .venv/Scripts/python src/ui-gap-audit/tools/capture_current.py \
    --port 8791 --project 照见未明rev2
```

## 捕获条件（两次运行可比的前提）

| 项 | 值 |
| --- | --- |
| Viewport | 1440 × 900，deviceScaleFactor 1，无缩放 |
| 浏览器 | Playwright Chromium（current）/ Firefox（target，需用户自己的登录态） |
| 项目 | `照见未明rev2` —— 真实 Connected Project，**不是** demo seed（AGENTS.md 第 20 条） |
| 后端 | `server.py --account-root D:\02_Work\04_video-work\MotvProjects --port 8791` |
| 日期 | 2026-08-16（**第二轮**，TASK-077 收口后重抓；第一轮见 Archive） |
| Commit | 工作树 = `d546b4c` + TASK-077 的改动（提交后为 TASK-077 那一条） |
| JS 异常 | **0**（`capture.json` 里逐次记录；带吞掉的异常的截图不算证据） |

## Cold start — 空项目的第一屏（**2026-08-17，TASK-094 §3**）

**为什么单独一组**：C-101…C-124 那 24 张**全是「项目里已经有 48 集内容」的样子**，
从来没有人看过一个空项目 —— 而故事开发这条链要设计的三个审阅面，**第一次出现时都是
空的**。产品负责人的原话是「这个 UI 我完全看不懂。哪里是入口哪里可以输入文本和图片。
在做哪个阶段的活。」审计把信息架构排在第五位，正是因为缺了这个视角。

**捕获条件**：viewport 1440×900 · Playwright Chromium · **新建的空项目**
（scratch account-root，不污染用户的项目目录）· **JS 异常 0**。

| ID | Screenshot | 看到了什么 |
| --- | --- | --- |
| C-000 | `00-cold-start.png` | **新建空项目的第一屏**（`story/brief`）。作品设定在 rail 第三位 —— 也就是还没有任何剧本可以派生它的时候 |
| C-000a | `00a-cold-landing.png` | 落地页 / 项目网格 |
| C-000b | `00b-cold-new-project-dialog.png` | 新建项目对话框（保存位置默认取后端 account-root） |
| C-000c | `00c-cold-brief.png` | 项目与创意：空 |
| C-000d | `00d-cold-story-outline.png` | 故事大纲：空态已经有说明 + 一个主行动，姿态本来就对 |
| C-000e | `00e-cold-settings-bible.png` | 作品设定：空态也有说明 + 「AI 剧本拆解」 |
| C-000f | `00f-cold-episode-plan.png` | **分集规划：一个新项目就已经摆出「本集要推进什么」的手填格子**（主线 / 人物 / 关系 / 世界规则），AI 一个字都不产出 —— 288 格是**结构性的**，不是 48 集的副产品。而且这一页渲染的是 `production.episodes`（「已建立 1 集 · 还没有规划条目」），这正是真实项目上显示 48 的原因 |
| C-000g | `00g-cold-episode-script.png` | 本集剧本：空 |

## Current — 第四轮（**2026-08-18，TASK-094 故事开发链收口后**）

**捕获条件**：与第三轮同（viewport 1440×900 · Playwright Chromium · 真实项目
`照见未明rev2` · `--port 8791`）· **JS 异常 0**。

**这一轮项目状态变了一处**：批次 G 归档了 32 个零内容空壳，所以真实项目从
**48 集显示成 16 集**（文档里仍然是 48 集，一集都没删，按 id 全部可解析）。
C-105 与所有剧集相关截图都按这个前提读。

| ID | Screenshot | 这一轮的变化（TASK-094） |
| --- | --- | --- |
| C-120 | `20-accept-episode-plan.png` | **分集规划是一张表**：12 行＝本版规划的条目、九列＝产品负责人的七项、96 个就地编辑格、最后一列进得去该集；下面是「另有 4 集」与「已归档 32 集」两个折叠 |
| C-121 | `21-accept-story-outline.png` | **故事大纲是八项**；旧字段标注为「旧字段」，没写的一项如实说明而不摆空格 |
| C-122 | `22-accept-bible.png` | **作品设定排在最后**；人物关系有「AI 梳理关系（按当前剧本）」主行动 |
| C-123 | `23-accept-world.png` | **世界观有 AI 了**：`world-director`（能力目录 21 → **24**：本链还新增了 `episode-plan-reviser` 与 `story-reviser`） |

## Current — motv 创作者 Studio（**第三轮，2026-08-16 Phase 2 收口后**）

**捕获条件**：viewport 1440×900 · Playwright Chromium · 真实项目 `照见未明rev2`
（`--account-root D:_Work_video-work\MotvProjects --port 8791`）· **JS 异常 0**。

**这一轮起按地址抓图**（TASK-081）：`capture_current.py` 用
`#/<项目>/<空间>/<页面>` 直接跳页，不再点 `[data-mod]` 猜路径。
请求地址与落点地址都写进 `capture.json` 作为证据。

| ID | Screenshot | Route | 这一轮的变化 |
| --- | --- | --- | --- |
| C-101 | `01-landing-project-home.png` | 落地页 | **顶栏 `已花 — · 余额 — ⚠1`**（不再是 ¥0，TASK-077）；**项目卡有封面 + 「N 集 · N 镜 · N 已生成」**（TASK-082） |
| C-102 | `02-brief.png` | `story/brief` | 右栏变成**一个常驻会话**（TASK-080） |
| C-103 | `03-story-outline.png` | `story/story` | |
| C-104 | `04-settings-bible.png` | `story/settings/characters` | |
| C-105 | `05-episode-plan.png` | `story/episodes` | |
| C-106 | `06-episode-script.png` | `story/script` | |
| C-107 | `07a-episode-board.png` | `episode/board/overview` | **五页 rail 的第 ①**，按名字直达（TASK-077 §1.5） |
| C-108 | `07b-storyboard-design.png` | `episode/storyboard/scenes` | 第 ②；分镜表格视图（TASK-078） |
| C-109 | `07c-shot-production.png` | `episode/shotwork/prepare` | 第 ③；生成卡（TASK-078 批次 B） |
| C-110 | `07d-cut-review.png` | `episode/cutreview/review` | 第 ④ —— **此前完全不可达**，现在是三列故事板（TASK-079） |
| C-111 | `07e-post-delivery.png` | `episode/delivery/timeline` | 第 ⑤ |
| ~~C-112~~ | ~~`07-episode-workbench.png`~~ | 请求 `episode/workbench` → **实际落到 `story/brief`** | ❌ **不是证据**：`workbench` 无别名，工具没检查 `resolved` 就截了图。见 [TASK-086 §1](../../../docs/tasks/TASK-086-address-truth-and-count-scope.md) |
| ~~C-113~~ | ~~`08-provenance-graph.png`~~ | 请求 `episode/provenance` → **实际落到 `story/brief`** | ❌ 同上 |
| C-114 | `09-episode-overview.png` | `episode/board/overview` | |
| C-115 | `10-scenes.png` | `episode/storyboard/scenes` | |
| C-116 | `11-storyboard-shots.png` | `episode/storyboard/shots` | |
| C-117 | `12-reference-plan.png` | `episode/shotwork/prepare` | 别名 `refplan` → ⑧ 步骤① |
| C-118 | `13-image-workspace.png` | `episode/shotwork/image` | 别名 `frames` → ⑧ 步骤② |
| C-119 | `14-video-workspace.png` | `episode/shotwork/video` | 别名 `video` → ⑧ 步骤③ |
| C-120 | `15-audio-workspace.png` | `episode/delivery/voice` | 别名 `audio` → ⑩ 配音 |
| C-121 | `16-dailies-review.png` | `episode/shotwork/pick` | 别名 `dailies` → ⑧ 步骤④ |
| C-122 | `17-edit-console.png` | `episode/delivery/timeline` | 别名 `edit` → ⑩ 时间线 |
| C-123 | `18-asset-library.png` | `assets/assets` | 左栏七行分类删除，改**内容树**（TASK-082） |
| C-124 | `19-storage-diagnostics.png` | `story/projectsettings/storage` | **「媒体不可用 2」**（此前是 0）+ 逐行「登记 local · 文件拿不到（探测）」+ 明说「本轮只显示，不改写登记状态」（TASK-077 §1.2）；⚙ 现有 **项目信息 / 项目健康 / 成片规格 / 预算与限制 / 存储与诊断 / 能力目录** 六个分区 |

**本轮实测发现的两条**（已开 [TASK-086](../../../docs/tasks/TASK-086-address-truth-and-count-scope.md)）：

1. C-112 / C-113 是**误导性证据** —— 工具不检查 `resolveModule().resolved`，
   把 fallback 当成功。**这两个文件不得被引用为证据。**
2. 项目卡写 `0 镜`，本集看板写 `60 个镜头` —— 同一项目、同一次运行。
   前者数的是「场景真正拥有的镜头」（60 个全部未归组），后者数的是存在的镜头。

---

## Current — 第一轮（2026-08-16，commit `18fa281`，**已归档**）

> 像素在 `screenshots/archive/2026-08-16-pre-phase2/`。
> **数字口径**：这一轮写「38 镜」，那是当时的项目数据；现在是 60（TASK-078 §1.a）。
> 保留是为了让 Before/After 可比，**不要拿它当现状证据**。

**TASK-077 之后**。带 ✅ 的行是本轮闭合的 Gap；其余仍是待办（Phase 1/2/3）。

| ID | Screenshot | Route/View | 到达方式 | State | Notes |
| --- | --- | --- | --- | --- | --- |
| C-001 | `01-landing-project-home.png` | 落地页 | — | 2 个真实项目 | 项目卡无封面/无进度/无「上次做到哪」 |
| C-002 | `02-brief.png` | 故事开发 › 项目与创意 | `[data-mod=brief]` | 创意 v6 已确认 | 顶栏 ✅ 已改为 `已花 — · 余额 — ⚠1`（原 `¥0`） |
| C-003 | `03-story-outline.png` | 故事开发 › 故事大纲 | `[data-mod]` | v4 已批准 | |
| C-004 | `04-settings-bible.png` | 故事开发 › 作品设定 | `[data-mod]` | 6 角色，3/6 有参考图 | 分区 tab：人物/人物关系/世界观 |
| C-005 | `05-episode-plan.png` | 故事开发 › 分集规划 | `[data-mod]` | 规划 v4 已确认 | ✅ 数字带口径：`已建立 48 集 · 本版规划 12 集（差 36 集…）` |
| C-006 | `06-episode-script.png` | 故事开发 › 本集剧本 | `[data-mod]` | v2 | 右栏只剩「修改要求」，能力/CANON 消失（未闭合） |
| C-021 | `07a-episode-board.png` | 剧集制作 › **⑥ 本集看板** | ✅ `[data-mod=board]` | 60 镜头 | ✅ 面包屑不再写 `Shot 01`；标题 =「本集看板」 |
| C-022 | `07b-storyboard-design.png` | 剧集制作 › **⑦ 分镜设计** | ✅ `[data-mod=storyboard]` | 草稿，60 镜 | ✅ 头部有「→ 准备资产」（三步流水线入口） |
| C-023 | `07c-shot-production.png` | 剧集制作 › **⑧ 镜头制作** | ✅ `[data-mod=shotwork]` | 四步流程条 | ✅ 左栏参考区按路线标注，不再写「模型直接输入」 |
| C-024 | `07d-cut-review.png` | 剧集制作 › **⑨ 粗剪审片** | ✅ `[data-mod=cutreview]` | 0/60 通过 | ✅ **本轮之前完全不可达**（渲染器+绑定都在，没有入口） |
| C-025 | `07e-post-delivery.png` | 剧集制作 › **⑩ 后期交付** | ✅ `[data-mod=delivery]` | 0 片段 | ✅ 标题/面包屑跟随当前页 |
| C-007 | `07-episode-workbench.png` | 剧集制作 › 制作台（legacy） | `[data-mod=workbench]` | 已选 SH01 | 五区；rail 不高亮（IA 未命名这个面，如实留白） |
| C-008 | `08-provenance-graph.png` | 剧集制作 › 生成溯源（legacy） | `[data-mod=provenance]` | 空（0 次生成） | |
| C-009 | `09-episode-overview.png` | 剧集制作 › 本集总览（legacy 键） | `[data-ep-ws=episode]` | 全部「已设计·待生成」 | ✅ 面包屑不再写 `Shot 01` |
| C-010 | `10-scenes.png` | 剧集制作 › 场景（legacy 键） | `[data-ep-ws=scenes]` | 48 集，**每集 0 场景 0 镜头归属** | 场景层在真实项目里完全没用起来（未闭合） |
| C-011 | `11-storyboard-shots.png` | 剧集制作 › 分镜（legacy 键） | `[data-ep-ws=shots]` | 草稿 v1/1 未锁定 | |
| C-012 | `12-reference-plan.png` | 剧集制作 › 参考统筹（legacy 键） | `[data-ep-ws=refplan]` | 0 绑定参考 | |
| C-013 | `13-image-workspace.png` | 剧集制作 › 画面（legacy 键） | `[data-ep-ws=frames]` | 0/60 | |
| C-014 | `14-video-workspace.png` | 剧集制作 › 视频（legacy 键） | `[data-ep-ws=video]` | 0/60 | ✅ 中栏标题不再写「制作流程图」 |
| C-015 | `15-audio-workspace.png` | 剧集制作 › 音频（legacy 键） | `[data-ep-ws=audio]` | 0/60 | |
| C-016 | `16-dailies-review.png` | 剧集制作 › 审片（legacy 键） | `[data-ep-ws=dailies]` | 0/60 | |
| C-017 | `17-edit-console.png` | 剧集制作 › 剪辑（legacy 键） | `[data-ep-ws=edit]` | 0 片段，无初剪 | ✅ 标题跟随当前页 |
| C-018 | `18-asset-library.png` | 资产库 | `[data-mod=assets]` | 9 资产 | ✅ **2 张碎图 → 诚实占位 + 文件名**；页头 `⚠ 2 个媒体文件已不在磁盘上` |
| C-019 | `19-storage-diagnostics.png` | 项目设置 › 存储与诊断 | `[data-mod=storage]` | — | ✅ **「媒体不可用 2」**（原 0）+ 逐行 `登记 local · 文件拿不到（探测）` |
| C-020 | `20-workspace-shell.png` | Creation Workspace Shell（另一个前端，:8792） | `python -m workspace_shell` | **Portfolio 全空** | 见 Archive；本轮未重抓（另一个前端，不在 TASK-077 范围） |

**到达方式变了（GAP-01 的一半闭合）**：五页现在是 `[data-mod]` rail 行，和另外两个空间
一样，`capture_current.py` 因此直接按名字抓到它们。`[data-ep-ws=*]` 那十一行是**旧的**
「工作区 ▾」下拉，TASK-074 才退休，仍然照抓——它们如果坏了，抓图会先发现。

**仍未捕获**：`projectsettings` 的另外三个分区（项目信息 / 成片规格 / 预算与限制）——
⚙ 不属于三空间任何一个，没有 rail 行（GAP-01 的另一半，Phase 2）。
`20-workspace-shell.png` 是另一个前端（:8792），本轮没起它。

## Target — LibTV（`liblib.tv`），用户指定的目标 UI

用**用户自己的登录态**抓取（Firefox 持久 profile，凭据从未经过 agent）。
逐个 tab / 面板 / 节点点进去，走查见
[target-workflow-walkthrough.md](../reports/target-workflow-walkthrough.md)。

### 全局

| ID | Screenshot | Route/View | Notes |
| --- | --- | --- | --- |
| T-001 | `T-01-project-list.png` | `/project` | 全局细 rail：首页/项目/Skills/创作者挑战赛；项目卡**有封面**、`⋯` 菜单、新建文件夹 |
| T-002 | `T-02-home.png` / `-full.png` | `/` | 能力入口卡 + 最近项目 + Skill 推荐 + **精选画布（可「查看创作过程」）** |
| T-010 | `T-10-rail-home.png` | `/` | 同上，登录态完整文本 |
| T-011 | `T-11-rail-project.png` | `/project` | 「开始创作」卡 + 项目网格 |
| T-012 | `T-12-rail-skills.png` | `/skill` | Skill / 收藏 / 我的；8 个分类；每个 Skill 带 **`/slash-name`** + 作者 + 使用数 |
| T-006 | `T-06-skills.png` | `/skill` | 同上，首屏 |

### 编辑器（画布）

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-003 | `T-03-editor-canvas.png` | `/canvas?spaceId=…&projectId=…` | **编辑器 = 无限画布 + 类型化节点**；URL 即状态 |
| T-008 | `T-08-new-project.png` | 新建项目 | **无表单**，直接空画布 + 4 张起步工作流卡 |
| T-005 / T-030 | `T-05-editor-assets.png` / `T-30-dock-canvas.png` | 左栏 · 画布 | **画布元素树**：`#分镜` `#风格测试` `#海报` `场景测试` `分镜1(镜头1…8)`…**共 149 节点** |
| T-031 | `T-31-dock-assets.png` | 左栏 · 资产 | 个人 / Agent 两个来源 |
| T-007 / T-020 | `T-07-editor-addnode.png` / `T-20-tb-add.png` | ＋添加节点 | 文本/图片/视频/智能剪辑 Beta/导演台 NEW/逐帧拉片/音频/脚本▸/素材库▸ + 上传 + 从生成历史选择 |
| T-050 | `T-50-addnode-script.png` | 脚本 ▸ | 脚本 NEW / 脚本（旧版）Beta |
| T-051 | `T-51-addnode-library.png` | 素材库 ▸ | 素材库 / 风格库 / 特效库 |
| T-021 | `T-21-tb-select.png` | 工具 | 移动 `V` / 抓手 `H` |
| T-022 | `T-22-tb-toolbox.png` | **我的工具箱** | 运镜/特效**预设**：左弧滑行、360旋转展示、瞳孔拉近、机械臂视角、破盒而出… |
| T-023 | `T-23-tb-effects.png` | 素材库 | 风格库「新增风格节点」/ 特效库「新增特效节点」 |
| T-024 | `T-24-tb-queue.png` | **角色库** | 20+ 预设角色原型 × **全身图/面部特写/表情九宫格/人物呈现板** ×「应用至画布」+ 筛选 + 最近使用 |
| T-025 | `T-25-tb-history.png` | 历史资产 | 图片/视频/音频历史 + 时间降序 + 批量操作 |
| T-026 | `T-26-tb-shortcuts.png` | 快捷键 | 成组 / **合并分镜组** / 解组 / 连线 / **生成 `Ctrl+Enter`** / 整理画布 / 撤销重做 |
| T-027 | `T-27-tb-tutorial.png` | 帮助 | 使用教程 / 联系客服 / 联系销售 / 公众号 |

### 节点（每种节点自己就是一个生成器）

| ID | Screenshot | Node | 表单内容 |
| --- | --- | --- | --- |
| T-047 | `T-47-node-selected.png` | 图片节点（已生成） | 顶部：人像质感调节/全景/多角度/打光/九宫格/高清/宫格切分；底部：**参考 ①②③ 内联进 Prompt** + `General image Pro` + `21:9·2K·1张` + **`⚡14`** + 提交 |
| T-048 | `T-48-node-contextmenu.png` | 图片节点右键 | 合规校验 / 保存到我的资产 / 全景预览 / **创建主体** / 复制节点 / 创建副本 / 删除 / **复制 TaskId** |
| T-061 | `T-61-node-image.png` | 图片节点（空） | 图生图 / 图片高清；`Lib Image`·`16:9 标准 2K 1张`·**`⚡18`**；智能引用 AutoLink |
| T-060 | `T-60-node-video.png` | 视频节点 | 5分钟超长/**首尾帧生成**/**首帧生成**；参考·标记·特效·**角色库**·**运镜**；`2.0 文生视频`·`16:9 720P 5s`·**`⚡135`**；自动校验素材 |
| T-065 | `T-65-node-audio.png` | 音频节点 | `Seed Audio 1.0`·`中文 24k wav`·0/2000 字·**`⚡1`**；语速/声调/音量 |
| T-062 | `T-62-node-smartedit.png` | 智能剪辑 Beta | 「空空如也，请连接视频节点后操作」；讲解视频/批量广告/素材混剪；`16:9 720P 30s` |
| T-063 | `T-63-node-directorstage.png` | 导演台 NEW | 「在 3D 空间中搭建场景并进行多视角截图」→ 打开导演台 |
| T-064 | `T-64-node-framebyframe.png` | 逐帧拉片 SD 2.5 | 上传视频 → 拆解维度 `分镜`/`动态`/`音乐` → 开始拉片 |

### 起步工作流（空画布上的 4 张卡）

| ID | Screenshot | 工作流 | 长出什么 |
| --- | --- | --- | --- |
| T-052 | `T-52-workflow-story-script.png` | 故事脚本生成 | `[剧本]──→[脚本生成器]` 两个相连节点；剧本可双击编辑；`GVLM 3.1`·**`⚡6`** |
| T-053 | `T-53-workflow-character-sheet.png` | 角色三视图 | 角色一致性三视图 |
| T-054 | `T-54-workflow-ref-to-video.png` | 全能参考生视频 `SD 2.5` | 参考 → 视频 |
| — | （未单抓） | 音频生视频 `SD 2.5` | 音频 → 视频 |

### **脚本节点 —— 分镜表 + 三步流水线**（整条链的枢纽）

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-095 | `T-95-node-script-new.png` | 添加节点 › 脚本 › **脚本 NEW** | 三条入口：**剧本生成分镜脚本** / **视频参考生成分镜脚本** / **角色生成分镜脚本**；`GVLM 3.1` · **`⚡6`** |
| T-096 | `T-96-script-from-screenplay.png` | 点「剧本生成分镜脚本」 | 画布上长出 **「预设 - 文本生剧本」** 子图 + 文本节点 —— **「尝试」条目是预设子工作流，不是单个动作** |
| **T-104** | **用户提供（未落盘）** | **脚本节点展开 = 全屏分镜表** | 十列：**镜号 / 时长 / 画面描述 / 景别 / 光影氛围 / 对白·旁白 / 音效 / 运镜 / 最终提示词 / 操作**；头部三步 **① 确认镜头 9个已就绪 → ② 准备资产 0/6 已生成、还差 6 个 → ③ 合成提示词 0/9 已合成**，「1/3 完成后可批量生视频」；**画面描述里的实体是高亮链接**（算法实验室/工位/林照/显示器/咖啡杯/触控板）→ **②的「6 个」就是它们**；行 `⋯` = 颜色标记(6色)/删除该行；底部 ＋添加镜头 / → 下一步：准备资产 |

> T-104 **不是我抓的**，是用户在会话里提供的截图，文件未落盘。
> 我尝试跑一次 `脚本生成器`（⚡6）复现它 —— **提交按钮没点中，积分停在 361，一分未花**。
> 若要落盘为 `target/T-104-*.png`，需要用户把该图放进目录，或授权我再试一次。

### **层级：工作区 → 多块画布 → 节点**（更正第一轮的错判）

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-099 | `T-99-canvas-switcher.png` | 画布切换下拉 | 面板标题「画布」+ **`⊕` 新建画布** + 画布列表（当前项打勾）—— **一个项目可开多块画布，一集一块可行** |
| T-100 | `T-100-workspace-switcher.png` | 工作区下拉 | 回到主页 / 全部项目 / 创建新项目 / 删除项目 |

### 一条**跑完了的**工作流（精选画布「查看创作过程」，只读，零花费）

样本：《黑翼天使终章》（Jcy樂多，02:56 成片）

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-070 | `T-70-showcase-opened.png` | 只读打开 | 「只读模式，如需创建请点击 **复制项目**」 |
| T-074 | `T-74-showcase-shot-node.png` | 10% 全景 | **20 个手工复制的相同 5 节点小流水线，排成规则网格**（参考图 + 文本Prompt + 图片 + 视频）+ `天使资产` 4×4 角色参考池 + 标题卡组 |
| T-073 | `T-73-showcase-one-shot.png` | 单镜头 `8空椅子的神谕` | 1456×816；三段式 Prompt（内容 / 人物事件 / **镜头语言「35毫米镜头…」**）；高级设置 **个性化风格 · 风格化程度100 · 怪异度50 · 多样性5** |
| T-071/072/075 | `T-71-…` `T-72-…` `T-75-…` | 缩放 / 节点树 | 节点名即镜头名 `1没有日出的圣城`…`20没有神的第一场日出`，每个带 `- 副本` |

### **工作流 / 故事板 —— 同一份数据的两个视图模式**（顶栏项目名右侧两个图标）

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-091 | `T-91-workflow.png` | **工作流**（默认） | 无限画布 —— 制作面 |
| T-090 | `T-90-storyboard.png` | **故事板** | **三列清单 文本/图片/视频** —— 审阅面。每条带 **模型**（`Kling 3.0`/`Hailuo 2.3`/`Kling 2.6`/`General image Pro`）· **时长**（10秒/6秒/5秒）· **尺寸** · **首帧来源缩略图** · `对话` 按钮 |
| T-092 | `T-92-storyboard-video-filter.png` | 故事板 › 视频列筛选 | `全部` / **`成片`** / **`片段`** |
| T-093 | `T-93-storyboard-failure.png` | 故事板 › **生成失败详情** | ⚠ 生成失败 + **`TaskID: 20260330184103774304541`** + 一键复制 + `⋯` + **「添加到对话」** |
| T-094 | `T-94-storyboard-image-expanded.png` | 故事板 › 图片列展开 | 失败那次的**完整存根**：**6 张编号参考图 ①…⑥** + 内联引用它们的 Prompt + `General image Pro` + `16:9 · 2K · 4张` + **`⚡56`** |

### 链式生成与历史

| ID | Screenshot | View | Notes |
| --- | --- | --- | --- |
| T-080 | `T-80-node-output-port.png` | 节点 `⊕` 输出端口 | **「引用该节点生成」→ 文本/图片/视频/智能剪辑/导演台/逐帧拉片/音频/脚本/参考节点** —— 任意类型 → 任意类型，一个统一动作 |
| T-081 | `T-81-history-video.png` | 历史资产 › 视频历史 | 每条 **查看 / 使用 / 下载**；时间降序 + 批量操作 |

### Agent（右栏常驻会话）

| ID | Screenshot | 面板 | Notes |
| --- | --- | --- | --- |
| T-004 | `T-04-editor-agent.png` | 会话主面板 | 「Skill 就位，ready when y…」+ 「换一批」；输入框「开始你的创作，或者 **`@` 引用工作流/节点/资源**」 |
| T-040 | `T-40-agent-new.png` | 新对话 | **「每个 Skill，都是一个开场」** + `/pixar-animated-ad-creator`、`/viral-video-replicator`、`/neo-chinese-aesthetic-tvc`、`/hujinquanwuxia` |
| T-041 | `T-41-agent-history.png` | 历史对话 | 会话是持久对象 |
| T-042 | `T-42-agent-share.png` | 分享 | 「新对话无法分享」—— 会话可分享 |
| T-043 | `T-43-agent-workflow.png` | **Agent 设置** | 人像安全协议；**协作模式「自动生成图片/视频 —— 开启后 Agent 可直接消耗积分，无需逐次确认」**；通知设置 |
| T-044 | `T-44-agent-cli-skill.png` | CLI & Skill | 命令行式操作是一等公民 |
| T-046 | `T-46-agent-slash.png` | 输入 `/` | **Skill 全表**：剧情广告短片创作 / 百万转场视频 / 电影级镜头生成 / 古风画卷大师 / S级女频仿真人剧一键成片 / 诺兰IMAX真人电影制作 / **小说转剧本(大师版)** / **角色、场景、分镜一键提取** … |
| T-045 | `T-45-agent-at.png` | 输入 `@` | 两个分区 —— **节点**（`#分镜`、`图片节点 4`、**`分镜组3`**、加载更多）+ **模型**（General image Pro / Lib Image / Seedream 5.0 Pro / Style Image V8.2·V8.1·V7 / General image V2 / Seedance 2.5 / Seedance 2.0 VIP / Minimax H3 / Seedance 2.0 Fast VIP / Kling O3 / Kling 3.0） |

### 未走到的部分（如实记录）

| 项 | 为什么没走 |
| --- | --- |
| **实际提交一次生成**（图片 ⚡18 / 视频 ⚡135 / 音频 ⚡1） | **会真花用户的积分**。CLAUDE.md：付费是唯一必须先问的事。等用户授权 |
| **生成中 / 排队中** 的进行态 | 同上（**失败态和完成态已在 T-093/T-090 免费拿到**） |
| 导演台 3D 界面内部 | 「打开导演台」未成功唤起独立窗口（T-82 只到入口节点） |
| 智能剪辑接上视频节点后的产出 | 需要先有生成好的视频节点，即需先花钱 |
| 逐帧拉片的实际拆解结果 | 需上传参考视频 + 消耗额度 |
| 「复制项目」 | 会在用户账号里再建一个项目，未点 |

> 顺带如实记录：走查期间账号积分从 1,534 → 421。**不是我花的** —— 本次全程未提交任何生成；
> 是用户本人在同一时间使用账号。

## Archive

| 目录 | 内容 |
| --- | --- |
| `archive/2026-08-16-pre-phase2/` | **第一轮 24 张**（commit `18fa281`，Phase 0/1/2 之前）。Before/After 对比的基线 |
| `archive/2026-08-16-pre-login/` | 登录前抓的 4 张 LibTV 页面（被「登录失效」弹窗遮挡 / 导航失败），保留作审计痕迹，不作为证据 |
| `archive/2026-08-16-pre-task077/` | **TASK-077 之前**的第一轮 current（20 张 + `capture.json`，commit `18fa281`）。GAP-01/02/03/06/09/26/28 的原始证据在这里：顶栏 `¥0`、资产库两张碎图、存储页「媒体不可用 0」、五页无入口。**不要删** —— 报告里的 C-00x 断言是对着它写的 |

## Comparison

尚未生成。等用户确认「目标 UI 里哪几点要对齐」之后再产出
`comparison/current-vs-target-<feature>.png`（§14）。