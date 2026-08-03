# TASK-026：跨项目只读工作视窗骨架（WSM1-B）

> **状态：Done（2026-08-03）。** ADR-0032 已 Accepted、TASK-025 查询层可用，
> WSM1-B 只读 shell 已落地（见下「实现选型」与 `src/workspace_shell/`）并通过
> 完整质量门：codex 独立审查 9 轮、16 条 blocking 修复并复审确认（1 条按本卡
> Accepted 设计驳回，报告见 `.claude/tmp/last-review.md`）；workspace_shell
> 套件 30 用例、全仓库回归 2271 passed / 0 failed。安全加固超出原规格部分：
> 产物流式传输 + fd 泄漏防护、CSP sandbox + CORP + 活动内容类型惰化（含 SVG
> 预览取舍）、TOCTOU 二次校验、fail-closed 覆盖 discovery 与序列化。
> WSM1 生产验收仍以 TASK-023 门槛为准（已于 2026-08-02 通过）。

## 目的

实现跨项目只读日常工作视窗，展示完整计划、阶段/步骤状态、运行信息、最近产物/
问题和预算概览，验证信息架构与查询合同可支持真实创作观察。

## 输入

- TASK-024 信息架构、TASK-025 query service；
- ADR-0010、ADR-0031、ADR-0032；
- WFM1 示例项目和只读 fixture。

## 输出

- ADR-0032 选定拓扑下的本地 Workspace shell；
- 项目列表/切换、项目概览、阶段与步骤详情、状态/阻断原因、最近产物/问题、
  累计成本/剩余预算页面；
- loading/empty/error/legacy/unavailable 状态；
- 可访问性、桌面/窄屏和 query contract 集成测试。

## 修改范围

ADR-0032 授权的 workspace UI/backend adapter 目录、静态资源、测试和运行文档；
query service 只通过公开合同调用。

## 明确不做

- 不提供任何写按钮、运行/审批/重试或文件编辑；
- 不直接扫描项目文件、不导入核心内部 Python 类型；
- 不保存 credential、业务事实或 UI 私有状态机；
- 不实现谱系深钻、实验、Action 或学习页面（后续任务）。

## 聚焦设计（WSM1-B 只读 shell）

本节是 TASK-026 对 ADR-0032 的聚焦设计产出，只定信息架构与边界规格，不选具体
框架/组件库/DB、不含代码。裁决结论见 [ADR-0032](../adr/ADR-0032-workspace-runtime-and-ui-topology.md)。

- **拓扑**：按 ADR-0032 采用本地 Web 应用——loopback 只读查询后端 + 浏览器客户端，
  后端只经 ADR-0031 公开查询合同（WQ-01～WQ-14）取数。
- **后端边界**：薄查询适配层；只读、无写、不持凭据、不 import 核心内部类型；仅绑
  loopback；媒体/文件仅经查询合同标识的产物路径提供并做路径 containment。
- **统一 query client**：前端只有一个 query client 出口调用后端只读 API；页面组件
  不各自拼 URL、不直接读文件；contract_version 不匹配时按 legacy/unavailable 呈现。
- **信息架构与路由**（对应「输出」页面清单）：
  - 项目列表 / 切换（跨项目发现，WQ 跨项目查询）；
  - 项目概览（阶段/步骤计划全景，含未运行项目从 I/O 合同派生的完整计划）；
  - 阶段与步骤详情（状态、阻断原因、预期输入输出、Gate）；
  - 最近产物 / 问题；
  - 累计成本 / 剩余预算（金额按 ADR-0031：整原币 authoritative，JPY 折算为 derived）。
- **状态分类（每个数据区都须区分并有对应视图）**：
  `loading` / `empty`（真实空）/ `error`（query 失败，fail-closed，不伪装成空）/
  `legacy`（schema_unsupported 等）/ `unavailable`（source 损坏/缺失）。三分标注
  authoritative｜derived｜unavailable 须在 UI 可见，不混淆。
- **可访问性与响应式**：桌面与窄屏均可用；键盘可达、语义结构、对比度达标；本任务
  不定视觉样式。
- **守卫（须有测试固化）**：UI/后端不含任何写、运行/审批/重试、文件编辑或 Provider
  直连调用；关闭 UI/后端不影响核心运行与恢复。

## 实现选型（ADR-0032「Not decided here」在本卡裁决）

ADR-0032 把「具体前端框架 / 组件库 / 构建工具 / 后端 web 框架」延期给本卡 Accepted
设计。裁决如下，硬性偏好为**最少新依赖**：

- **后端 web 框架**：Python **标准库 `http.server`（`ThreadingHTTPServer` +
  `BaseHTTPRequestHandler`）**，绑 `127.0.0.1`。理由：`pyproject.toml` 运行时
  `dependencies = []`（零运行时依赖），stdlib 已满足 loopback + 只读 + 边界要求，
  无需引入 Flask/FastAPI 等新依赖或 ASGI/WSGI 运行器。协议为本地 loopback 上的
  HTTP/1.1，仅 GET/HEAD；无写端点，非 GET 谓词一律 405。
- **前端框架 / 构建工具**：**vanilla JS + 单个静态 `app.js`/`styles.css`/`index.html`**，
  由后端静态提供，**不引入 npm / bundler / 前端框架**。理由：只读观察面无需组件化
  框架；无构建链符合「最少新依赖」；CSP `script-src 'self'` 下无内联脚本、无外部源。
- **序列化 / 查询消费**：只经 TASK-025 公开合同
  （`ai_video_workflow.workspace`：`WorkspaceQueryService` / `discover_projects` /
  `to_jsonable`）取数并原样 JSON 化，后端**不 import 任何其他核心内部模块**（由
  守卫测试 `test_backend_imports_only_public_query_contract` 固化）。
- **数据库 / 缓存**：无。沿用 ADR-0031 WSM1 on-demand、无持久缓存；不引入任何 DB。

代码落点：独立包 `src/workspace_shell/`（`app.py` 传输无关路由 + fail-closed 逻辑、
`server.py` loopback 传输 + `python -m workspace_shell` 入口、`static/` 前端资源）；
测试 `tests/test_workspace_shell.py`。运行：
`python -m workspace_shell --account-root <账户根> [--port 8760]`（仅 loopback）。

- **统一 query client**：前端 `app.js` 中的 `Q` 对象是唯一构造后端 URL 并 fetch 的
  出口；页面渲染器不各自拼 URL、不直接读文件；`contract_version` 主版本不匹配按
  legacy 呈现。
- **状态分类实现**：每个数据区区分 `loading` / `empty`（真实空且无 problems）/
  `error`（HTTP 非 2xx 或网络失败，结构化 problem，不伪装空）/ `legacy`
  （contract 不匹配或 `schema_unsupported`）/ `unavailable`（字段三分 + markers）；
  三分 authoritative｜derived｜unavailable 以每字段徽章可见。
- **安全姿态实现**：仅绑 loopback；校验 `Host` 头为 loopback（抗 DNS rebinding）；
  每响应带 `Content-Security-Policy`（self-only）/`X-Content-Type-Options: nosniff`/
  `Cache-Control: no-store`/`Referrer-Policy: no-referrer`；`/artifact` 只服务落在
  已发现项目根内的文件并做 `resolve()` 后 containment，任意/穿越/绝对路径 403。

## 实施步骤

1. 在 TASK-026 聚焦设计中裁决 ADR-0032（已产出，见上「聚焦设计」；已 Accepted）。
2. 建立只读 shell、路由/导航和统一 query client。
3. 实现项目与阶段/步骤观察页面及完整状态呈现。
4. 加入断线、query 损坏、legacy 和重新加载恢复。
5. 用空项目、运行中项目和失败项目做端到端走查。

## 测试要求

- UI 不得包含 Provider/业务写入调用的守卫测试；
- 新项目完整计划、运行状态、阻断原因和预算展示；
- query 错误不被伪装成空数据；
- 关闭/重启 UI 不影响核心运行；
- localhost、安全 header/origin 等按 ADR-0032 验证。

## 验收标准

- [x] 用户可在一个窗口观察多个项目及完整阶段/步骤计划（项目列表 + 9 视图，
      走查与 `test_plan_returns_full_l0_s7_with_provenance` 等验证）；
- [x] 所有内容来自 TASK-025 query contract
      （`test_backend_imports_only_public_query_contract` 守卫固化）；
- [x] 无任何业务写入或 Provider 直连
      （`test_backend_has_no_write_or_provider_surface` + 405 全谓词拒绝）；
- [x] UI 关闭后核心工作流继续正常运行
      （`test_stopping_server_leaves_core_files_untouched`）；
- [x] ADR-0032 和运行文档与实现一致（2026-08-03 审查后核对）。
