# motv — 节点画布创作工作台（UX 原型）

**这是一个非生产的 UX 原型（mockup），不是受治理的 Workspace 实现。**

它探索一个 LibTV 式的**节点画布**创作工作视窗：落地页 → 开始创作 → 空画布 → 选一个
过程 → 工作流节点带连线**渐进长出**（剧本 → 分镜 → 资产 → 视频/音频 → 剪辑 → 成片）。
画布上的连线即"工作流之间的关系"，并映射到
[`docs/design/workflow-stage-step-io-contract.md`](../../docs/design/workflow-stage-step-io-contract.md)
的 L0–S7 输入/输出/Gate 合同。

## 治理边界（重要）

- 与生产级只读 shell（`src/workspace_shell/`）**物理与运行时隔离**：本目录不被任何
  Python 服务引用或托管，不 import 核心 Python 类型，不直接调用 Provider。
- 所有写操作走一层 **Command Gateway stub**（`src/services/gateway.js`），所有读数据走
  **只读 query stub**（`src/services/query.js`）——**演示但不实现** ADR-0033 / ADR-0031
  的真实边界。生成前必过**预算预检**（P50/P90，余额不足阻断）。
- 正式 Workspace UI、最终数据结构与 UI 状态机受 ADR-0031/0032/0033 与对应任务卡约束；
  把本原型的节点图落成生产实现需先走对应 ADR。本原型不在 `docs/adr` 或冻结合同中做任何决定。

## 运行

仓库无前端构建工具，用任意静态服务器即可（ES 模块需经 http 载入，不能 `file://` 直开）：

```bash
cd mockups/motv-workspace
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

走一遍：开始创作 → 故事脚本生成 → 「基于剧本生成分镜」(进度) → 准备资产(向导) →
视频生成(**预算预检** → 批量/单个) → 音频生成 → 剪辑合成(本地 FFmpeg 免费) → 成片/质检。
试：拖节点右侧端口连线（仅相邻步骤，跨步骤会被拒）、拖到空白新建下游、悬停连线 ＋插入 /
×删除、Shift 多选连线后 Del 删、脚本生成器 `v▾` 切版本 / `⇄对比`、点顶部余额看各项目花费、
底部进度条点击聚焦、🏠 返回主页、右上 ◐ 切换主题。

## 架构（为什么"好扩展"）

```
index.html                shell 标记 + <script type="module" src="src/app.js">
styles/tokens.css app.css  设计令牌（明暗双主题）+ 布局/组件
src/
  graph/engine.js          通用画布引擎：nodes/edges、render、pan、drag、连线、多选、panTo
                           —— 不含任何短剧业务知识，纯交互
  graph/registry.js        节点类型注册表 + canConnect() 相邻步骤约束（"不能跨步骤"）
  workflow/contract.js     L0–S7 阶段/步骤 I/O 合同数据（inspector 的唯一数据源）
  workflow/nodes/*.js      **扩展点**：每种节点一个文件，导出一个 NodeType def
  services/gateway.js      submitCommand()  —— 唯一写路径（stub → 真实=loopback POST）
  services/budget.js       账户/项目、estimate、spend（stub → 真实=只读查询+结算）
  services/query.js        读门面（stub → 真实=ADR-0031 只读查询）
  ui/*.js                  landing / inspector / stepbar / wizard / estimate 视图
  app.js                   注册节点、构建 ctx、把引擎接到工作流
fixtures/project-shengtang.js  样例项目数据
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

不实现真实 loopback 后端、不接 Provider、不写核心业务文件、不进 `workspace_shell`；
缩略图/播放/媒体均为占位；预算与项目数据为内存 fixtures。
