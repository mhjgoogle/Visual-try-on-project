# TASK-109：全站三栏骨架 + 右栏改成真正的 Agent 对话框

- 状态：完成（2026-08-27）—— 三栏骨架、导演台退役、对话（后端+前端+分页）全部实现并在
  真实项目上验证过；切片 3 的「Agent 自己落改动」仍未做，如实记在下面
- Workflow：Feature · 深度：DEEP
- 关联 Requirement：[REQ-004](../../requirements/REQ-004-three-pane-shell-and-agent-conversation.md)
  **v3** 判据 1–4 + v2 的「能干活的 Agent」 + v3 的「每页一条对话」
  （v1 判据 5「面板不许消失」已被 v2 作废）
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md)（对话式写路径）
- 架构约束：`CA §3` 前后端合同（页面集合封闭 —— 本卡**不新增页面**，只改骨架）·
  `CA §1` 模块边界（改动限于 `mockups/motv-workspace/`）· `CA §4` 测试归属（前端 `.test.mjs`）
- 目标：骨架每页一致（左控制/选择 · 中工作区 · 右对话），右栏从「六段折叠面板」
  变成「对话流在上、输入框固定在底」的会话面。

## IN SCOPE

- 切片 1 ✅：`#production` 所有空间统一为**三栏**；剧集制作那根多出来的 316px 选择列
  折进左栏（页面导航在上、选择器/检查器在下）
- 切片 2 ✅：右栏结构改成会话形状 —— 上方可滚动流 + 底部固定输入框（`/` 唤能力、
  `@` 引对象沿用 `agentsession.js`，不新造第二套）
- 切片 2b ✅（REQ-004 v2）：右栏**不再渲染** AI 导演台六段面板
- 切片 3 ✅ **对话本体已实现**（ADR-0089）：`POST/GET /api/projects/<name>/conversation`；
  服务端装配项目事实 → 经 Runtime 层起 run → 线程是 run 的投影（读时对账，关页面不丢）；
  前端 `services/conversation.js` + `ui/convthread.js` + 自由文本发送 + 读运行状态的轮询
- 切片 3b ✅ 位置自动识别：每一轮带上「空间·页面 / 当前分集 / 选中的镜头」
- 切片 3c ✅ 每页一条对话线（REQ-004 v3 / ADR-0089 决策 4b）
- 切片 4 ⛔ **未做**：Agent **自己把改动落到作品上**。现在它只能**提出** edits，
  屏幕上明确写着「还没落到作品上」。落地要走创作者自己那条编辑路径（决策 2b），
  是下一张卡

## OUT OF SCOPE

- **删除** `director.js` / `directorshot.js` 模块及其测试 —— 本卡只停止渲染；
  模块退役是独立一步（见 Follow-up），一次把布局改动和模块删除做完正是能力静默消失的方式
- 新增页面或改页面集合（ADR-0066 决策：页面集合封闭）
- TASK-106 的旧端点退役（`/api/agent/*` 同步分支）—— 那是它的范围，本卡只消费它的机制
- 后端合同变更；本卡切片 1–2 是纯前端

## Impact Analysis

- 受影响模块：`mockups/motv-workspace/styles/{epprod,app}.css`、
  `src/ui/production.js`（右栏组装）、`src/ui/agentsession.js`（会话渲染）
- API / 合同：切片 1–2 无；切片 3 需要 `GET /api/runs*` 的读路径（TASK-106）
- 数据：无持久化改动（对话记录的落盘形态在切片 3 决定）
- 依赖方向：不变（前端只经 `/api/*`）
- 受影响测试：`mockups/motv-workspace/tests/*.test.mjs`（`aidirector` / `agentsession` /
  `production` 相关）；纯 CSS 部分靠人工看 + 截图
- 文档：`docs/design/creator-product-information-architecture.md`（IA 权威）需要跟着改；
  UI/UX 的 ADR 按 AGENTS.md §1 **先给可演示版本，用户看过再定**

## 架构影响

改的是固定 IA 的骨架（ADR-0066 决策 8 的页面集合**不动**，动的是每页的列结构）。
结论：等用户看过可演示版本后立 ADR 记录三栏骨架，或按他的反馈推翻重做 —— 不在他看到
之前把 IA 写成既定事实。

## 实施摘要（切片 1/2/2b 见下表；切片 3 的对话本体见「对话」一节）

**切片 1 · 三栏骨架（纯 CSS）**

| 位置 | 改了什么 |
| --- | --- |
| `styles/studio.css` | `#production` 是外壳**唯一生效**的网格（`app.css` 里同选择器那份被它整体覆盖）—— 列数写成 `minmax(200px,220px) / minmax(0,1fr) / minmax(300px,340px)`，并注明三栏是规则不是巧合 |
| `styles/epprod.css` | `space-episode` 从 **4 栏改 3 栏**：152px 页轨 + 316px 检查器合并进左栏（页轨横向换行，竖轨会浪费半个左栏）；`.st-dir` 跨完整内容行；全屏与 1440px 响应式跟着改 |

**切片 2 · 右栏改成会话形状**

| 位置 | 改了什么 |
| --- | --- |
| `src/ui/agentsession.js` | `renderAgentSession` 增加 `split`：拆成 `history`（运行记录 + 本页诊断）与 `composer`（上下文 + 说明 + 输入框）。**默认行为逐字节不变**；输入框排到 composer **最后**（说明在其上），写在框下面的行会被面板边缘裁掉 |
| `src/ui/production.js` | 右栏三带：`dir-head` 固定 + `st-dir-flow` 可滚动 + `st-dir-composer` 固定在底；剧本分支与其它分支同一对包裹，形状不因页面而异 |
| `styles/epprod.css` | `.st-dir` 三带布局 + `.st-dir-flow > * { flex: none }` —— 没有它 flex 挤压每一段，截图里每段都被切一半 |

**切片 2b · 导演台不再渲染（REQ-004 v2）**

产品负责人 2026-08-27「AI导演台不需要了。根本用不上。」→ 右栏只留会话。
`shotDirSec` / `stateSec` / `renderDirector(...)` 从右栏组装里移除；**模块与测试都还在**，
退役另立一步。

## 验证

| REQ-004 v2 判据 | 证据 |
| --- | --- |
| 1 每页恰好三栏 | 真实项目 `夜班沉默` 实测：`故事开发` `lanes=[0,220,1340]`；`剧集制作` `lanes=[0,312,1340]` · `cols=312px 1028px 340px` · `class=space-episode` —— 改之前是 4 栏 |
| 2 左栏只放控制与选择 | `剧集制作` 左栏 = 页轨（本集剧本…后期交付）+「当前对象」，同一列 |
| 3 中栏是工作区 | 中栏 = EP01 看板（三个镜头 + 真实缩略图） |
| 4 右栏是对话、输入固定在底 | 截图确认输入框是右栏最后一个元素、`st-dir-flow` 独立滚动、导演台六段已不在 |
| v2 新增「能干活的 Agent」 | **未满足**（切片 3）。现有 `/api/agent/*` 五个端点是结构化、**零写入**的草稿端点（`story-develop` / `shots-draft` / `bible-breakdown`），承不起自由对话 + 直接落改动 |

命令：`node --check`（两个改过的 JS）· `node --test mockups/motv-workspace/tests/*.test.mjs`
→ **1857 passed / 0 failed** · `pytest tests/contract` → 203 passed / 2 skipped ·
Playwright 截图 5 次（两个空间 + 三次修正复看）。

## 顺带查明的两件真实数据问题（不是本卡引入，如实上报）

1. **`GET /api/projects/夜班沉默/budget` 曾返回 403**：`account_scope` —— 项目根是
   `…\MotvProjects\夜班沉默`，而 `--account-root` 是它的上一级，预算端点要求项目是
   account root 的**直接**子目录。把根指到 `MotvProjects` 后变 **200**。
   正确启动：`./scripts/launch/studio.ps1 -Connected -AssetRoot "D:\02_Work\04_video-work\MotvProjects"`
2. **`照见未明rev2` 两个资产 404**（`assets-ref-c6e26bfb…_v1.png`、`assets-ref-5d4cf6e2…_v1.png`）：
   canvas 引用着、磁盘上没有。未改动任何数据。

## Follow-up

- **切片 3（真正的对话式 Agent）**：需要一条新的会话式写路径 —— 自由文本进、Agent
  自行收集上下文、改动经 Command Gateway 落地、过程在流里逐步可见。前置：ADR（新写路径）
  + [TASK-106](../active/TASK-106-frontend-run-path-and-legacy-endpoint-retirement.md) 的运行状态
  读取循环（前端至今零处读 `GET /api/runs`）。**付费动作仍须显式确认**（AGENTS.md §1）。
- **导演台模块退役**：`director.js` / `directorshot.js` / `prodplan` 等已不再被右栏渲染，
  但模块与测试仍在仓库里。等产品负责人用过新对话框、确认不再需要那些派生结论之后再删
  （删的同时要处理它们的测试与 `directorops` 的调用方）。
- **外壳网格有两份定义**：`app.css` 与 `studio.css` 都写 `#production`（inset 56px vs 52px、
  行定义不同），后者整体覆盖前者。本卡只在生效的那份上改并注明，没删另一份 —— 删要先确认
  没有别的规则依赖 `app.css` 那份的其它属性。
- **启动器默认 asset root 对真实数据是错的**：默认「仓库的上一级」会让
  `MotvProjects/<项目>` 的预算端点一律 403。要么改默认值，要么连接后端时校验并提示。
- `照见未明rev2` 的两个 404 资产：需要产品负责人确认是不是自己挪走了媒体文件。

## 对话（切片 3，ADR-0089）

| 位置 | 内容 |
| --- | --- |
| `server.py` | `_conv_prompt` / `_conv_json_object` / `_adapt_conversation`（fail-closed 解析）；`_conv_facts` 服务端装配项目事实 + 「现在在看」；`_conv_key` 把一轮归到它自己的页面线；`_conv_load` 把 v1 单条 turns 迁进 `__legacy__`；`_conv_reconcile` 用 run 记录重建线程；两条端点 |
| `src/services/conversation.js` | 发送 / 读线程 / 读运行状态（TASK-106 缺口的最小消费面）/ 取消 |
| `src/ui/convthread.js` | 对话流：他说的、Agent 回的、这一轮状态、建议的改动、它做不到的事 |
| `src/ui/agentsession.js` | 没选能力时主动作是「发送」；Enter 发送、Shift+Enter 换行、输入法组字不误发 |
| `src/ui/production.js` | 每页一份对话状态（`ui.convByPage`）；发送前记住页面；失败一律变成可见的一条 |
| `src/app.js` | `ctx.projectName`（原本不存在，导致发送被判定「没打开项目」而静默） |

## 本轮修掉的自己引入的 bug（都是「界面看着正常、其实什么都没发生」那一族）

| # | bug | 为什么测试没拦住 |
| --- | --- | --- |
| 1 | `bindAgentPanel` 调用留着、import 已删 → 每次 bind 抛 ReferenceError | 单元测试不跑 `production.js` 的 bind |
| 2 | 发送按钮 `disabled` 写在渲染态里 → 打字不重渲染，按钮永远灰 | 只断言了源码文本，没断言行为 |
| 3 | `bindAgentSession` 签名没解构 `onSend` → 点击静默 return | 同上 |
| 4 | `ctx.projectName` 根本不存在（`ctx.project` 是 fixture 项目） | 同上 |
| 5 | 轮询 `/api/runs/<id>` 少了必需的 `?project=` → 永远等不到终态 | 真机才暴露 |
| 6 | `conversationContext` 用了未 import 的 `activeEpisode`；且发送链无 `.catch()` → 抛在本地回显之后 = 完全静默 | 真机才暴露（产品负责人：「没有回应」） |

对应补的是**行为测试**而不是文本测试：`tests/convsend.test.mjs`（真调 bind、真触发
click/keydown/input）。

## 最终验证（收口）

- `node --test mockups/motv-workspace/tests/*.test.mjs` → 见提交信息
- `pytest tests/studio tests/contract` → 见提交信息
- 真机（真实项目「夜班沉默」/「照见未明rev2」）：三栏列宽实测、发送→回答端到端、
  位置识别答对页面与镜头、两页两条历史互不串、项目切换不跳主页、主页移除不动文件
