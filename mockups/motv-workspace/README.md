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
cd mockups/motv-workspace && python3 -m http.server 8000
# 浏览器 http://localhost:8000/  → 顶部显示「⚪ 演示模式」
```

**连接真实数据模式（同源 loopback 后端，读真实项目）**
```bash
source .venv/bin/activate            # 需已 pip install -e .
python mockups/motv-workspace/server.py --account-root examples/projects
# 浏览器 http://127.0.0.1:8770/  → 顶部显示「🟢 真实只读数据」
```
连接模式下：落地页列出**真实项目**（如 `wfm1-demo`）；顶部预算是**真实 WQ-14 数字（JPY）**；
点余额看**真实预算 / 阶段状态(WQ-02) / 成本(WQ-07)**；画布编辑（剧本/节点/连线）**自动存到
`data/<project>.json`，刷新不丢**；生成类操作提示"待 Gateway"。创意节点内容仍是本地草稿
（无 checked-in 的真实创意数据）。

**通用交互**：开始创作 → 选一个过程 → 分镜(进度) → 准备资产(向导) → 视频/音频 → 剪辑合成 →
成片/质检；拖端口连线（仅相邻步骤）、拖空白新建、连线 ＋插入 / ×删、Shift 多选后 Del 删、
`v▾` 切版本 / `⇄对比`、底部进度条点击聚焦、🏠 返回主页、右上 ◐ 主题。
（演示模式下生成走**本地预算预检**；连接模式下生成为"待 Gateway"不花费。）

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
  workflow/scriptdoc.js    剧本域文档：创意 + 追加式剧本版本链（纯状态，节点只是视图）
  workflow/nodes/*.js      **扩展点**：每种节点一个文件，导出一个 NodeType def
  services/query.js        读门面：connected 走后端真实查询，否则回退 fixture
  services/realmap.js      把 WQ-14/02/07 DTO 映射进 UI 结构
  services/persist.js      画布本地持久化（/api/canvas 或 localStorage 兜底）
  services/gateway.js      submitCommand() —— 写路径 stub（真实=loopback POST，待 ADR）
  services/budget.js       演示模式的账户/项目预算 + estimate/spend
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
