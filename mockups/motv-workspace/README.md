# motv — 节点画布创作工作台（UX 原型）

**这是一个非生产的 UX 原型（mockup），不是受治理的 Workspace 实现。**

它探索一个 LibTV 式的**节点画布**创作工作视窗：落地页 → 开始创作 → 空画布 → 选一个
过程 → 工作流节点带连线**渐进长出**（剧本 → 分镜 → 资产 → 视频/音频 → 剪辑 → 成片）。
画布上的连线即"工作流之间的关系"，并映射到
[`docs/design/workflow-stage-step-io-contract.md`](../../docs/design/workflow-stage-step-io-contract.md)
的 L0–S7 输入/输出/Gate 合同。

## 治理边界（重要）

- **只读接真实数据是允许的**：ADR-0031（只读查询合同）与 ADR-0032（loopback web 拓扑）均已
  Accepted，只读原型可提前（ADR-0032:19）。可选后端 `server.py` 消费**公开**查询包
  `ai_video_workflow.workspace`（与 `src/workspace_shell/app.py` 同一公开面）——这**不是**
  "import 核心内部类型"（ADR-0032:84 只禁内部类型），且后端**只读**、不写业务状态、不持凭据、
  刻意**不放进** `src/workspace_shell/`。
- **写侧仍受门槛，保持 stub**：生成 / 发布 / Command Gateway / DB / 最终 schema 受
  CLAUDE.md、AGENTS.md、ADR-0033+ 约束。前端 `services/gateway.js` 是 client stub；连上后端时
  生成类操作显式提示"**待 Gateway（写侧 ADR 待接入）**"，不产生真实花费、不写核心文件。
- **画布持久化是原型本地 scratch**：`data/<project>.json` 只存画布自有状态（剧本草稿、节点
  位置、连线），**不是**核心事实投影、**不回写**任何 `<project>/` 核心文件，`.gitignore` 已忽略。
- 把本原型落成**生产 Workspace UI**（取代 WSM1-B）或做**真写/真生成**，须另走对应 ADR / 任务卡。
  本原型不在 `docs/adr` 或冻结合同中做任何决定。

## 运行

两种模式，ES 模块都需经 http 载入（不能 `file://` 直开）：

**演示模式（静态，纯 fixtures，零依赖）**
```bash
# 用 serve.py（显式 MIME，跨平台）；不要用 `python -m http.server`——原生 Windows
# 会按注册表给 .js/.mjs 发错误 MIME，浏览器拒绝执行 ES module（ADR-0049）。
cd mockups/motv-workspace && python serve.py --port 8000   # Windows 用 `py -3 serve.py`
# 浏览器 http://localhost:8000/  → 顶部显示「⚪ 演示模式」
```

**连接真实数据模式（同源 loopback 后端，读真实项目）**
```bash
source .venv/bin/activate            # 需已 pip install -e .
python mockups/motv-workspace/server.py --account-root examples/projects
# 浏览器 http://127.0.0.1:8770/  → 顶部显示「🟢 真实只读数据」
```

**原生 Windows（ADR-0049，NTFS）**：PowerShell 里
`.\.venv\Scripts\Activate.ps1` 激活后同样 `python mockups\motv-workspace\server.py
--account-root examples\projects`；演示模式用 `py -3 mockups\motv-workspace\serve.py`。
ffmpeg/ffprobe（渲染/探测）与可选 Piper（本地 TTS）需装好并在 `PATH`。付费模式的
`export AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1` 在 PowerShell 里是
`$env:AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1`。仓库根 `run-windows.ps1` 提供一键启动。
连接模式下：落地页列出**真实项目**（如 `wfm1-demo`）；顶部预算是**真实 WQ-14 数字（JPY）**；
点余额看**真实预算 / 阶段状态(WQ-02) / 成本(WQ-07)**；画布编辑（剧本/节点/连线）**自动存到
`data/<project>.json`，刷新不丢**；生成类操作提示"待 Gateway"。创意节点内容仍是本地草稿
（无 checked-in 的真实创意数据）。

**通用交互**：开始创作 → 选一个过程 → 分镜(进度) → 准备资产(向导) → 视频/音频 → 剪辑合成 →
成片/质检；拖端口连线（仅相邻步骤）、拖空白新建、连线 ＋插入 / ×删、Shift 多选后 Del 删、
`v▾` 切版本 / `⇄对比`、底部进度条点击聚焦、🏠 返回主页、右上 ◐ 主题。
（演示模式下生成走**本地预算预检**；连接模式下生成为"待 Gateway"不花费。）

**制作 ⇄ 工作流 双视图（创作者优先外壳）**：顶栏 `▦ 制作 / ⛓ 工作流` 切换。
**制作视图**（进项目后默认）左侧制作导航 **全部可进**：创意/剧本/分镜/资产/视频/音频/
剪辑（带状态徽标；工作流没走到某步也照样能打开——没有数据就显示明确的空态/前置提示，
绝不置灰导航）。**剧本**是完整工作区：中间大编辑器+版本条，右侧 **AI 导演**（修改要求 →
修订稿提案 → 明确「应用为 vN（新持久版本）」/放弃，含生成中/失败态）；其余模块是
**只读现状工作区**（`src/ui/workspaces.js`）：创意=Creative Brief+剧本状态；分镜=当前
镜头（序号/标题/描述/时长/版本/锁定）；资产/视频/音频=按镜头列媒体槽位（缩略图、版本
数、来源；视频含**已记录的**首帧来源——未记录如实标「未记录」，绝不臆造血缘）+付费
状态投影；剪辑=素材就绪度+已合成成片。数据经 `ctx.prodData()` 只读快照读取现有节点
状态，**不迁移所有权、不复制成第二份持久域状态**；模块切换是纯 UI 导航（transient），
不触发生成、不改工作流；剧本手工编辑与未应用提案在模块切换间原样保留。**工作流视图**
即原节点画布，行为不变；两个视图渲染**同一个** `scriptDoc` 域文档（`src/ui/production.js`
纯展示，AI 调用仍在 ctx.script 后面），切换互见改动、不丢状态。

**Prompt 编译 + 手动生成入口（M10）**：分镜详情媒体区新增两块生成入口面板。
**Image Prompt** 由 场景地·状态 + 出场角色·状态（bibledoc 解析器输出，状态覆盖生效）+
镜头画面内容 + 大纲题材基调（confirmedPlan 的发起大纲）纯函数编译
（`src/workflow/promptc.js`），缺什么如实列出（场景地/角色/画面内容），绝不臆造；
**Video Prompt** = 当前镜头图片作首帧 + 动作 + 运镜 + 时长 + 台词。入口：📋 复制 /
↗ ChatGPT / ↗ Gemini（复制并打开）/ ⬆ 导入生成结果（连接模式；同一上传端点与
slug 命名空间，mediaref 追加版本）/ API 自动生成为诚实的「未来/可选」注记（付费
生成仍在工作流节点，ADR-0041/0045）。经入口流导入的结果**记录真实 Generation 溯源**
（promptSnapshot=复制时的编译文本，provider=chatgpt-manual/gemini-manual/manual）；
未走入口的普通导入保持普通上传，不伪造溯源。

**音频生产 + 轻量时间线 + 最终导出 + 存储管理（M11）**：画布 schema v9。
**音频工作区**重建为按 场景→镜头 的生产面：**对白**——说话人取自该镜头场景的出场角色
（bibledoc 解析，**声音身份永远来自角色基础声音档案**，状态只调表现，域层+v7 校验+
Prompt 编译三重强制），台词+声音身份+状态表现+镜头情绪纯函数编译成 Dialogue Prompt
（`compileDialoguePrompt`），入口：🤖 本地 Piper TTS（免费）/ 📋 复制（网页订阅工具，
manual_subscription）/ ⬆ 导入 / Voice API 诚实的「未来」注记；同镜头多次生成为
`voice-<slot>` 版本链变体，可回切。**场景环境音**挂在场景上（`scene.ambienceAssetId`
**引用**音频池资产，多场景复用同一资产，绝不逐镜头复制）；**镜头音效**按关键词给建议
（`sfx-<slot>` 变体链）；**BGM** 剧集级 `episode.bgmAssetId` + 场景级覆盖，`effectiveBgm`
纯函数解析。**时间线工作区**（`src/workflow/timeline.js` + `src/ui/timelinews.js`）：
5 轨（video/dialogue/ambience/sfx/bgm），TimelineClip **只引用 assetId 绝不复制媒体**；
视频轨顺序制（重排=换序+重排版，镜头锚定的音频随镜头平移），修剪/音量/静音/淡入淡出/
音频移位/替换视频变体（同链另一版本，确定性引用替换）全部持久化（v9 `timelines` 顶层
map，fail-safe 校验）；**未手工编辑**的时间线随镜头自动同步，**手工编辑过的绝不静默
覆盖**——来源变化显示横幅，明确确认「重建时间线」才重建。**预览**（播放/暂停/游标/粗略
音频同步）+ **最终渲染**：渲染设置可见（分辨率/fps/容器），`POST /api/agent/render-episode`
本地 FFmpeg 单遍合成（视频 trim/scale/pad/fps 归一 concat；音频 atrim/volume/afade/
adelay/amix；静音或零音量 clip 如实跳过），输出 `render-ep-v<N>` **原子版本化**
（O_CREAT|O_EXCL，绝不覆盖），成片进 M3 finals 成为稳定资产 + **渲染溯源**记录为 v9
新增的非 AI Generation type `"render"`（provider ffmpeg-local，参数含 clips 快照与设置，
inputAssetIds=各 clip 资产）。**存储管理工作区**（`src/ui/storagews.js`）：基于既有 M5
storageState 生命周期（**不建第二套状态**），总量/活跃/历史/未使用/已归档/不可用统计 +
每资产行动作：归档（隐藏）/ **移除本地副本**（默认推荐：删字节→storageState=deleted，
assetId/元数据/溯源/引用全保留，媒体处显示不可用）/ **永久删除**（显式破坏性：二次确认；
被 镜头首帧/角色/场景地参考图/场景环境音/剧集场景 BGM/时间线 clip 阻断性引用时**拒绝并
列明**，绝不静默断引用；Generation 溯源链接允许悬空但删除前如实提示）。

**故事发展与剧集规划（M9）**：故事工作区不再「创意→直接跳剧本」，改为真实创作路径
**创意 → AI 发展故事 → 故事大纲（versioned·批准）→ 剧集规划（versioned·确认）→ 选集
→ 该集剧本**。`story` 域文档（`src/workflow/storydoc.js`，画布 schema v8 顶层字段）持久化
大纲版本链（前提/故事线/题材基调/世界观/角色概念/核心冲突/故事弧/结局/建议集数与时长）
与规划版本链（每集 集数/标题/梗概/戏剧功能/开场钩子/结尾拍/预期时长）；AI 输出一律
**先提案**（应用才成版本，旧版本全保留），**批准大纲**是规划的前置门，**确认规划**才
建立/联结剧集实体（episodeId 显式写回规划版本，绝不按标题猜；唯一「无场景无剧本」的
初始默认集会被第一个未联结条目收养而非留孤儿）。**剧本自 v8 起按集存放**（顶层
`scripts` map，旧单一 scriptDoc 迁移到当时的当前剧集；畸形残留 fail-safe 拒绝）；剧集
规划面板每集「进入本集剧本」即切换当前集并进入剧本工作区；本集剧本 AI 生成默认使用
创意+已批准大纲+本集规划组成的上下文。大纲**绝不**自动写入作品设定（正式 Bible 同步
仍由剧集剧本拆解驱动，M8）。两个新 agent 端点 `/api/agent/story-develop`、
`/api/agent/episode-plan` 沿用 ADR-0042 姿态（本地 claude -p --tools ""、fail-closed、
零写入）；演示模式为标注的本地模板。

**制作工作室（Production Studio，M8）**：制作视图重建为三栏专业制片环境——左「导航/资源」
（项目级：故事/作品设定/剧集/存储；当前剧集：剧本/分镜/画面/视频/音频/时间线）+ 中「制作工作区」+
右「AI 导演（常驻）」；工作流节点画布保留在 ⛓ 标签但不再是主创作体验。**分镜工作区**
（`src/ui/storyboard.js`）：场景组（含出场角色·状态 / 场景地·状态上下文标签）→ 镜头卡 →
选中镜头详情（描述/动作/运镜/台词/时长——新创意字段加性存于草稿 raw shot，保存=追加新
不可变草稿版本）→ 当前镜头媒体区（图片/视频**变体条**·设为当前·用作首帧·配音状态·本镜头
生成记录，全部走 M3/M5 注册表与 mediaref 单一写入口，不建第二份媒体状态）。**AI 导演**
（`src/ui/director.js`）：当前上下文 + 指令 + 真实动作（剧本生成/修订、分镜生成、剧本拆解）
+ **生成历史**（真实读 M5 Generation Registry）；未接线的能力如实标注。**剧集屏**：剧集
选择卡 + 当前集六阶段进度条。空态均带前置指引与可点动作。
**AI 优先作品设定（M8 修正）**：作品设定以「🪄 剧本拆解 / 同步」为先、手工表单为辅
（`src/workflow/breakdown.js` + `/api/agent/bible-breakdown`，ADR-0042 姿态：本地
claude -p、fail-closed、服务端零写入；演示模式为标注的本地模板）。AI 从剧本提议
新角色/既有角色更新/新场景地/场景地更新/剧情阶段状态，全部以**提案卡**呈现：
添加 / 并入已有（只填空字段）/ 应用更新（只写卡上显示的变更）/ 忽略——已确认档案
**绝不被静默覆盖**。角色/场景地的**出场剧集由场景引用派生**（characterRefs/locationRef，
不维护手工出场列表）；场景设定场景地时可**选已有或当场新建**（新建立即进入作品设定，
场景≠场景地，绝不逐场景复制实体）。

**剧集 → 场景 → 镜头（生产域结构，M6）**：项目级 `production` 域文档
（`src/workflow/proddoc.js`，画布存档 schema v6 顶层字段）持久化
**Project → Episodes → Scenes → Shots** 结构：剧集（可新建/重命名/切换当前/删除空集）
拥有场景，场景按**稳定镜头身份 creativeShotId 引用**镜头（镜头内容/媒体/溯源仍分别在
分镜草稿、Asset Registry(M3)、Generation Registry(M5)，不复制第二份）。制作视图「剧集」
工作区管理结构并把当前草稿镜头归入场景（一个镜头至多属于一个场景，移动语义）；分镜卡片
显示所属场景标签。引用不再能解析（草稿重生成后镜头已不在）时**如实标「不在当前草稿」，
绝不按位置猜**，也不静默清除；删除仍有镜头归属的场景/仍有场景的剧集会被拒绝（先显式
清空）。旧存档 v5→v6 迁移只铸一个确定性的默认剧集（`ep-mig-1`），场景/归属绝不臆造。

**作品设定 Production Bible（M7）**：`production` 域文档扩展（schema v7）持久化项目级
**角色库与场景地库**。角色 = 一个稳定身份（characterId）+ 规范档案（外貌/服装/性格/
画面指令）+ **参考图引用**（referenceAssetIds 指向 M3 资产注册表，只引用不复制，主参考
activeReferenceAssetId）+ **基础声音档案**（voiceId/描述/表现）+ **角色状态**
（少女时期/黑化时期/受伤时期…）：状态只**覆盖**外貌/服装/画面指令/声音表现/参考图，
**始终是同一个角色身份**；**声音规则**——状态可调表现但**不能携带自己的 voiceId**
（域层剥离 + v7 校验双重强制）。场景地（Location）对称：档案（描述/画面指令）+ 参考图 +
状态（日/夜、天气、战损、季节…）。剧集工作区的场景按 **ID+状态引用**出场角色与场景地
（`characterRefs`/`locationRef`），档案内容绝不复制进场景或镜头；仍被场景引用的
角色/场景地/状态**拒绝删除**（先释放引用）。纯解析器 `resolveCharacter/resolveLocation`
给出基础⊕状态合并后的有效呈现。v6→v7 迁移只加空库与空引用字段，绝不臆造角色/场景。
（Prompt 编译、配音生成、Provider 适配均不在本检查点。）

**创意 → 剧本（版本化，创作者优先交互的第一个纵切）**：剧本节点是「剧本文档」
的视图，不再自持内容——创意（Creative Brief）、剧本版本链与当前版本都存在画布
持久化里的 `scriptDoc` 域（`src/workflow/scriptdoc.js`，旧画布的 node.text 自动
迁移为未版本化缓冲）。流程：写一句创意 → 「AI 生成剧本 v1」；输入修改要求 →
「AI 修订」产出**修订稿提案**（不自动生效）→ 确认「应用为 v2」才落为新版本，
**旧版本全部保留、v▾ 可回切**；每个版本记录指令、来源（AI 生成/AI 修订）与状态。
连接模式走后端 `POST /api/agent/script-draft`（同 ADR-0042 姿态：本地 `claude -p`、
工具禁用、剧本/创意按纯数据框定、fail-closed）；演示模式为明确标注的本地模板，
不调用 AI。手工直接改剧本文本仍可用（显示「已手工修改」，版本本体不可变）。

**创意 Agent（ADR-0042）**：连接模式下「基于剧本生成分镜」是**真实的**——画布剧本文本
经后端 `POST /api/agent/shots-draft` 交给**本地已登录的 Claude Code CLI**（`claude -p`，
订阅计费、无 API key、约 20–60s），返回结构化分镜**草稿**（标注「草稿 · Claude 生成 ·
未锁定」），资产节点自动从草稿预填。草稿只存画布本地状态，不写核心文件；付费视频生成
仍严格按已锁定 packet 执行（草稿改不了已锁定参数）。CLI 缺失/输出不合法时 fail-closed
报错。

**手工插入/修改（人工 Gate + 手工媒体流，全免费）**：分镜节点「✎ 编辑分镜」打开编辑
器，可改标题/描述/时长（6/10s）、增删镜头，保存为**新版本**（历史不覆盖，标「手工编
辑 · 未锁定」），下游同步。资产/视频/音频节点每个镜头槽位：📋 复制提示词/文案（模板
即时生成）→ 用户在外部免费工具生成（图：Gemini 网页；视频：Gemini 動画/Hailuo 网页
免费额度；配音：网页/本地 TTS；音乐音效：CC0 库）→ ⬆ 上传结果
（`PUT /api/uploads/<项目>/<槽位>`，png/jpg/webp 8MB、mp4/webm 60MB、mp3/wav 20MB，
magic 字节校验，存 `data/uploads/` 原型 scratch；**同槽位重传追加新版本
`<slot>_v<N>.<ext>`，绝不删除/覆盖旧版本**——缩略图角标 v‹N› 打开版本选择器可回切、
lightbox 可浏览历史，ADR-0048/TASK-048）。上传绑定镜头的
稳定 slot id，增删镜头/切版本不会错挂。资产节点每镜头 `🎬→ 用作视频首帧`：把该槽位
当前版本图以 MediaRef 一键流转到视频节点首帧输入位（视频行显示首帧缩略图+「来自资产
v‹N›」，提示词模板同步提示首帧来源；锁定分镜时首帧按 MediaRef 解析，行为不变）。自动路线：视频=MiniMax 付费（`--enable-paid`）；
配音=**本地 Piper TTS（ADR-0043，免费离线）**——音频节点每镜头 🤖 或「一键自动配音」，
经 `POST /api/agent/tts` 本地合成 WAV 存入同一槽位（需 `pip install piper-tts` 并将
`zh_CN-huayan-medium.onnx(.json)` 放入 `data/tts/`，缺失时 503 且手工路不受影响）。
核心工作流的正式"手工媒体 Provider"须另走 ADR-0038。

**批量付费 / 状态 / 放大视窗**：付费模式下视频节点「一键批量生成（付费·总额确认）」
按 ADR-0046 一次确认总额（跳过已有成片），逐镜头 Gateway 预检并校验报价等于确认单价
（任何偏差/阻断立即中止）；付费成片经 `/api/agent/adopt-paid` **自动复制进画布槽位**
（只读桥接，不改核心文件；已有成片槽位再 adopt 追加新版本，防重复扣费护栏仍在提交侧）。
`/api/paid-ops/<项目>` 只读投影 reservations+staging，视频行内显示每镜头生成情况
（⏳/✓已付费）；存在在途任务（reservation held / 批量进行中）时前端**每 12s 自动轮询**、
无在途即停表，画布顶部常驻**全局付费队列条**聚合 生成中/已入账/已释放/需对账 计数与
逐镜头状态（点击跳到视频节点 detail；批量时同步显示 N/M 进度，TASK-048）。每个节点有「⤢ 放大编辑」打开大视窗
（同一节点体、实时同步、全部操作可用）。🤖 配音在该镜头已有视频时自动**贴合视频
时长**（Piper length-scale 加速，最低 0.65，超出部分由合成按画面截断）。

**付费写路径模式（ADR-0041 / TASK-041，真实生成，须显式授权）**
```bash
source .venv/bin/activate
python mockups/motv-workspace/stage_evidence.py        # 离线搭建证据项目（零花费）
export AI_VIDEO_WORKFLOW_ENABLE_PAID_COMMANDS=1        # 部署级 opt-in（缺省关闭）
# 真实调用还需 WFM1_MINIMAX_API_KEY（.env）；只到预检为止不花费
python mockups/motv-workspace/server.py --enable-paid \
  --account-root mockups/motv-workspace/data/evidence-account
# 浏览器 http://127.0.0.1:8770/ → 顶部「💳 真实数据 + 付费写路径」
```
在画布视频节点点「生成」→ 弹出**真实 Gateway 预检**（锁定目录报价 45 JPY / USD 0.28、
blockers、preflight digest）→ **人工确认后才真实提交**（HIGH-risk，经 Command Gateway →
coordinator：审批 / 目录锁 / 预算 reservation / 真实 MiniMax / 成本结算）。取消或存在
blockers 则零花费。图像/音频付费仍被拒（ADR-0038 未授权）。

## 架构（为什么"好扩展"）

```
server.py                  可选同源 loopback 后端：只读查询(公开合同) + 画布本地持久化
index.html                 shell 标记 + <script type="module" src="src/app.js">
styles/tokens.css app.css  设计令牌（明暗双主题）+ 布局/组件
src/
  graph/engine.js          通用画布引擎：nodes/edges、render、pan、drag、连线、多选、panTo、
                           reset/序列化 —— 不含任何短剧业务知识，纯交互
  graph/registry.js        节点类型注册表 + canConnect() 相邻步骤约束（"不能跨步骤"）
  workflow/contract.js     L0–S7 阶段/步骤 I/O 合同数据（inspector 的唯一数据源）
  workflow/scriptdoc.js    剧本域文档：追加式剧本版本链（v8 起按集存放，节点只是视图）
  workflow/storydoc.js     故事域文档：创意→大纲版本链(批准)→剧集规划版本链(确认)（M9，纯状态）
  workflow/promptc.js      Prompt 编译器：镜头+状态解析→Image/Video Prompt+缺口诊断（M10，纯函数）
  workflow/proddoc.js      生产域文档：剧集→场景→镜头引用结构（M6，纯状态，镜头内容不复制）
  workflow/bibledoc.js     作品设定域：角色/场景地+状态+声音档案+参考图引用（M7，纯状态）
  workflow/timeline.js     轻量时间线域：5 轨 clip 引用 assetId、顺序制视频、edited 保护（M11，纯状态）
  workflow/breakdown.js    剧本拆解提案：解析/匹配/变更计算/出场派生（M8，纯函数，应用走 bibledoc）
  ui/storyboard.js         分镜工作区：场景组→镜头卡→详情+媒体变体区（M8，纯视图模型可测）
  ui/director.js           AI 导演常驻面板：上下文/指令/真实动作/生成历史（M8）
  ui/audiows.js            音频工作区：对白/环境音/SFX/BGM 生产面（M11，纯视图模型可测）
  ui/timelinews.js         时间线工作区：轨道/剪辑属性/预览/渲染设置（M11）
  ui/storagews.js          存储管理工作区：统计/归档/移除本地副本/永久删除（M11）
  workflow/nodes/*.js      **扩展点**：每种节点一个文件，导出一个 NodeType def
  services/query.js        读门面：connected 走后端真实查询，否则回退 fixture
  services/realmap.js      把 WQ-14/02/07 DTO 映射进 UI 结构
  services/persist.js      画布本地持久化（/api/canvas 或 localStorage 兜底）
  services/gateway.js      submitCommand() —— 写路径 stub（真实=loopback POST，待 ADR）
  services/budget.js       演示模式的账户/项目预算 + estimate/spend
  ui/production.js         制作视图外壳（左导航 activeModule + 模块分发；纯展示，读写 scriptDoc）
  ui/workspaces.js         各制作模块的只读现状工作区 + 可测的纯视图模型（读 ctx.prodData()）
  ui/*.js                  landing / inspector / stepbar / wizard / estimate 视图
  app.js                   注册节点、构建 ctx、异步 bootstrap（探测模式/拉真实数据/存取画布）
fixtures/project-shengtang.js  演示创意 fixture（画布创作内容）
data/<project>.json        画布本地持久化文件（gitignore，运行时生成）
```

引擎、进度条、inspector、连线约束**全部从注册表 + 合同数据派生**；接真实后端只替换
`services/*.js` 三个壳，视图与节点不动。

## 如何新增一个工作流步骤（节点类型）

1. 新建 `src/workflow/nodes/<type>.js`，默认导出一个 NodeType def：

   ```js
   import { nx } from "./shared.js";
   export default {
     type: "storyboard",          // 唯一 id
     step: 2,                     // 工作流顺序（决定相邻步骤约束 + 进度条位置）
     stage: "S3 生产设计",         // 映射 workflow/contract.js（inspector 读阶段/步骤/Gate）
     title: "分镜板", icon: "🗂",
     init() { return { state: "" }; },          // 可选：节点初始数据
     render(node, ctx) { return `...<button class="nrun" data-run>运行</button>${nx([["assets","准备资产"]])}`; },
     run(node, ctx) { ctx.estimate({ /* 付费则走预检 */ }); },  // 可选
     bind(node, el, ctx) { /* 节点专属交互，可选 */ },
     next: ["assets"],
   };
   ```

2. 在 `src/app.js` 顶部 `import` 它并加入 `register` 列表（一行）。

引擎自动处理拖动/连线/端口/选择，`[data-run]`→`run`、`[data-next]`→下一步指引、
`data-single`/`data-shot`/版本菜单等由各 def 的 `bind` 接管。进度条与 inspector 会自动纳入。

## 已知非目标

不接真实 Command Gateway、不做真实生成/发布、不写任何核心业务文件、不进 `workspace_shell`；
后端**只读**（消费公开查询合同），不建 DB / 物化 projection；缩略图/播放/媒体均为占位；
真实创意/多媒体数据尚不存在（运行期才产生），故创意节点内容仍为本地草稿。
