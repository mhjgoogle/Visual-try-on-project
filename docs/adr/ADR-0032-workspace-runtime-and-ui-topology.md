# ADR-0032: Creation Workspace 运行拓扑与 UI 技术选择

- Status: Accepted
- Date: 2026-08-02
- Decision owner: TASK-026
- Implementation scope: TASK-026～TASK-029、TASK-031～TASK-033、TASK-039、TASK-040
- Depends on: ADR-0031 Accepted

## Context

工作视窗运行于 WSL2 Ubuntu + VS Code 环境，需要展示媒体和跨项目数据，同时不能
让浏览器或界面进程直接读取凭据、调用 Provider 或拥有核心执行生命周期。本 ADR 在
以下既定约束之内裁决 Workspace 的**运行拓扑**与 **UI 技术类别**（不含最终选型）：

- ADR-0010 决策 1/3/5：Workspace 是核心之上的表现层，不是新 Orchestrator，不拥有
  Provider 生命周期，不直接修改核心业务文件；核心执行与恢复不依赖 UI 进程存活。
- ADR-0010 决策 2：所有变更命令须经未来 Command Gateway，Workspace 永不直连
  Provider（Gateway 本身由 ADR-0033 裁决，不在此定义）。
- ADR-0030：分阶段交付与门槛；WSM1-B 只读原型可提前，生产验收仍受 TASK-023 约束。
- ADR-0031（Accepted）：带版本的只读 query contract（WQ-01～WQ-14），WSM1 采用
  **on-demand 求值、无持久缓存**，projection 不写回业务状态、不持有凭据。

WSM1-B 的界面只消费 ADR-0031 的只读查询，不产生任何写操作。

## Candidates

1. **本地 Web 应用**：Python query/gateway backend 绑定 loopback，浏览器只消费受控
   只读 API；媒体展示自然，桌面/窄屏成本低。
2. **桌面应用**：可获得更强桌面集成，但打包与 WSL 文件/进程边界复杂、跨平台成本高。
3. **VS Code 扩展**：贴合开发环境，但创作体验、媒体比较与长期独立运行受限，UI 生命
   周期与编辑器进程耦合。

## Candidate Evaluation

对照 Required Decision Properties（P1–P6）评估。✅ 满足良好，△ 可满足但有代价，
⚠ 明显受限。

| 属性 | P1 生命周期分离 | P2 仅 query/gateway adapter | P3 loopback+origin/CSRF/路径 containment | P4 浏览器无凭据 | P5 不动核心状态/测试 | P6 桌面/窄屏可用 |
|---|---|---|---|---|---|---|
| 本地 Web 应用 | ✅ backend/浏览器均在核心之外，关掉不影响文件式核心 | ✅ 后端天然是薄查询适配层 | ✅ loopback + 成熟的 same-origin/CSRF 手段 | ✅ 凭据留在服务端，只读面无 Authorization | ✅ 独立目录/包，不 import 核心内部类型 | ✅ 响应式天然覆盖，媒体展示原生 |
| 桌面应用 | △ 进程可分离，但打包与 WSL 进程/文件边界更重 | △ 仍需同一后端适配层 + 打包 | △ 本地但威胁模型不同 | ✅ | ✅ | ⚠ 桌面为主，窄屏不适用；WSL 分发复杂 |
| VS Code 扩展 | ⚠ UI 生命周期与编辑器进程耦合，长期独立观察受限 | △ webview 约束下调用后端 | △ 扩展宿主模型，非标准 web 边界 | ✅ | ✅ | ⚠ 创作/媒体比较与长期独立运行受限 |

## Proposed Decision（待独立审查后 Accept）

采用 **本地 Web 应用** 拓扑：**Python 只读 query 后端绑定 loopback + 浏览器客户端**
消费 ADR-0031 版本化只读查询合同。理由：唯一在全部 P1–P6 上均为 ✅ 的候选；生命
周期分离最干净（文件式核心/CLI 独立运行与恢复，关闭 UI 或后端都不触碰已提交工作，
契合 ADR-0010 决策 5）；后端天然是薄查询适配层，不复制 Orchestrator/Provider；媒体
展示与桌面/窄屏响应式成本最低。桌面应用的 WSL 打包/分发代价与 VS Code 扩展的生命
周期耦合、长期独立观察受限，都与 Workspace 的长期观察定位相悖。

### Decided here（本 ADR 裁决）

- **拓扑类别**：本地 Web 应用 = loopback 只读查询后端 + 浏览器客户端。
- **生命周期分离（P1）**：后端与浏览器均在核心执行之外；核心文件式 Orchestrator/CLI
  独立运行与恢复；关闭其一永不取消/暂停/破坏已提交工作。
- **边界角色（P2）**：WSM1-B 后端只做 ADR-0031 只读查询适配，不复制
  Orchestrator/Provider；未来写操作一律经 Command Gateway（ADR-0033），Workspace
  永不直连 Provider。本 ADR 不定义 Gateway。
- **网络与安全姿态（P3/P4）**：仅绑 loopback；对任何状态变更端点强制 same-origin +
  CSRF 防护（WSM1-B 只读、无此类端点，但姿态在此固定供后续沿用）；浏览器不持久化
  任何 Provider 凭据、不接收私有 Authorization header；只读查询面不携带 Provider
  凭据；对外提供的文件/媒体须做路径 containment——只经查询合同标识的产物路径提供，
  禁止任意路径读取。
- **核心完整性（P5）**：Workspace UI/后端置于 ADR-0032 授权的独立目录，不 import 核心
  内部 Python 类型；核心权威状态与测试边界不变。
- **响应式（P6）**：桌面与窄屏均须可用；本 ADR 不提前设计视觉样式。

### Not decided here（延期至 TASK-026 Accepted 设计或后续 ADR）

- 具体前端框架 / 组件库 / 构建工具；
- 后端 web 框架、HTTP vs 本地 IPC 的具体协议（须满足上面 loopback + 边界约束）；
- 数据库 / 物化 projection 存储（ADR-0031 WSM1 为 on-demand 无持久缓存，本 ADR 不引入）；
- 远程/多用户部署、认证提供方、RBAC；
- Command Gateway 协议与 Action schema（ADR-0033～0036）。

## Security & Boundary Invariants（下游 026/027/031 必须遵守）

1. 后端只读：仅通过 ADR-0031 公开查询合同取数，不写业务状态、不修复数据、不持凭据。
2. 仅 loopback 监听；状态变更端点须 same-origin + CSRF（WSM1-B 无写端点）。
3. 浏览器零凭据；不向浏览器下发 Provider Authorization。
4. 媒体/文件仅经查询合同标识的产物路径提供，做路径 containment，拒绝任意路径。
5. UI/后端不 import 核心内部类型，不改变核心权威状态与测试边界。
6. 关闭 UI/后端不影响核心运行与恢复（须有守卫测试）。
7. query 错误 fail-closed，按 ADR-0031 结构化 problem 呈现，不伪装成空数据。

## Consequences

- 复用文件式核心、CLI、Provider、QCD、恢复与防覆盖能力，无需新执行层；
- 只读观察层可先落地，写能力等待 ADR-0033 Gateway 与 TASK-023 门槛；
- 选定拓扑类别但不锁死框架/组件库/DB，为 TASK-026 Accepted 设计与后续演进留出空间；
- 后端引入一个 loopback 进程，须承担 origin/CSRF/路径 containment 的安全责任。

## Acceptance Criteria（独立审查须确认后方可 Accept）

- [ ] 拓扑裁决只落在类别层，未选定具体框架/组件库/DB，未创建 UI 代码；
- [ ] 与 ADR-0010 决策 1/2/3/5 与 ADR-0031 只读合同一致，未越权定义 Gateway/Action；
- [ ] P1 生命周期分离可由守卫测试验证（关闭 UI 不影响核心）；
- [ ] loopback + origin/CSRF + 浏览器零凭据 + 路径 containment 姿态明确；
- [ ] 未提前把 Status 置为 Accepted（留待用户裁定）。

## Acceptance

- 2026-08-02：用户 Accept 本 ADR，解除其 Proposed 门槛，授权对应 owner 任务实施代码。
- 注：codex 未安装，本阶段相关代码/设计审查由 claude 回退完成，跨模型独立性降级（用户已知悉并接受）。
