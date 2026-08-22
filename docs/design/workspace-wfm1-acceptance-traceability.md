# Workspace WFM1 数据基线验收追踪矩阵（TASK-033 / WSM3-B）

> **状态：Approved acceptance evidence（2026-08-03）。** 本文把
> `workspace_wfm1_baseline` 标签的需求细化到「需求 → 权威合同/ADR → owner task →
> 验收测试」四列，作为 TASK-033 里程碑门的可复核证据。它不定义新 schema、页面或
> Provider；范围外条目一律显式指向 TASK-034～040，不以 `unavailable` 冒充最终完成。
>
> 上位分配见
> [端到端需求追踪矩阵](end-to-end-requirements-traceability.md) §3；本文只做 WFM1
> 支持范围内的 test 级细化（该矩阵 §5 规则 1 将 test 级追踪推迟到 Workspace 门，即此处）。

## 1. 阅读方式

- **验收测试**列给出直接证明该需求闭环的测试；`test_workspace_wfm1_acceptance.py`
  是本门的跨切面主验收，逐域单测提供细粒度证据。
- 一个需求可由「跨切面主验收 + 逐域单测」共同覆盖；两者都是真实协调链（真实
  `WorkspaceQueryService` 读、`WorkspaceApp` → Command Gateway 写、真实 HTTP server
  做同源门），不使用 mock 纯函数替代。
- **阶段边界**列声明本基线覆盖到哪里、后续 owner 是谁。

## 2. WFM1 基线需求 → 合同/ADR → task → 测试

| 需求（WFM1 支持范围内） | 权威合同 / ADR | Owner task | 验收测试（file::test 或 query） | 阶段边界 |
| --- | --- | --- | --- | --- |
| 跨项目观察：计划、状态、阶段、进度、问题、预算 | 查询合同 WQ-01/02/09/13/14；ADR-0031 | TASK-024～026 | `test_workspace_wfm1_acceptance.py::test_wfm1_workspace_closed_loop`（WQ-01 完整 L0–S7 + WQ-11）；`test_workspace_queries.py`（WQ-01/02/09/13/14）；`test_workspace_shell.py` | 基线用 WFM1 source；WFM2 全媒体步骤由 TASK-039 |
| 双向谱系与 prompt/镜头比较 | WQ-03/04/05/06 | TASK-025/027 | `test_workspace_queries.py`（lineage upstream/downstream、prompt_history、shot_attempts）；`test_workspace_wfm1_acceptance.py::test_full_episode_...`（真实成片谱系） | WFM1 外类型允许 unavailable；最终不得 unavailable（TASK-035/039） |
| 成本：预计/预留/实际/失败重试与筛选 | WQ-07/14；QCD cost 合同；ADR-0008 | TASK-025/027 | `test_workspace_wfm1_acceptance.py::test_full_episode_...`（真实每镜头一次计费）；`test_workspace_queries.py`（WQ-07 维度） | 最终覆盖所有付费媒体 Provider（TASK-035/039） |
| 目标、评价、实验与创作决定 | 评价事实域；WQ-08/15；ADR-0034 | TASK-028/031 | `test_workspace_wfm1_acceptance.py::test_wfm1_workspace_closed_loop`（Gateway 写 → WQ-15 回读）；`test_evaluation_service.py`；`test_workspace_evaluation_query.py` | 用户最终判断；WFM2 提供完整媒体 target（TASK-039） |
| Feedback、Action 与 Action Center | Feedback/Action 事实域；WQ-16；ADR-0032 | TASK-029/031 | `test_workspace_wfm1_acceptance.py::test_wfm1_workspace_closed_loop`（feedback→action→transition → WQ-16）；`test_action_service.py`；`test_workspace_action_query.py` | 目标始终绑定 ref/version/digest |
| 运行前检查、确认、幂等、恢复、命令回执 | Command Gateway；ADR-0033 | TASK-030 | `test_workspace_wfm1_acceptance.py::test_gateway_write_safety`；`test_gateway_service.py`（preflight/digest 确认/replay/ambiguous/跨实例恢复）；`test_workspace_write.py` | Gateway 只调用已批准核心能力（TASK-038/039） |
| 受控运行：常规运行、重试、续做、选择、审批、阶段推进 | WFM1 registry；ADR-0033 | TASK-031 | `test_workspace_write.py`（每写经 Gateway 或被拒）；`test_wfm1_e2e.py::test_fault_matrix`（真实续跑/幂等） | 只暴露 capability matrix 中 supported 命令（TASK-038/039） |
| 复盘、跨项目 KPI、经验提升、证据化推荐 | 知识事实域；WQ-17/18；ADR-0036；ADR-0001 第五次增补 | TASK-032 | `test_workspace_wfm1_acceptance.py::test_wfm1_workspace_closed_loop`（promote → WQ-17/18；空项目 insufficient_evidence）；`test_learning.py` | 推荐只读，知识提升需用户确认（TASK-039 扩展媒体证据） |
| 关闭 UI 后 projection 可重建、确定性、只读 | ADR-0031 决策 2（无持久缓存） | TASK-025/033 | `test_workspace_wfm1_acceptance.py::test_projection_rebuild_readonly_and_ui_restart`（双实例字节一致 + 读零写）；`test_wfm1_e2e.py::test_projection_readiness` | 硬门槛，最终由 TASK-040 复核 |
| projection 损坏 fail-closed 且可恢复 | 查询合同 §5（problem/readiness_failed） | TASK-025/028/029/032/033 | `test_workspace_wfm1_acceptance.py::test_projection_rebuild_...`（corrupt→source_corrupt+readiness_failed→恢复）；各域 corrupt 单测 | 硬门槛 |
| 资金安全：重复命令/并发/replay 不重复付费 | Gateway 幂等 + 付费协调；ADR-0033/0008 | TASK-030/031 | `test_wfm1_e2e.py::test_fault_matrix`（ambiguous/双支付门）；`test_gateway_service.py`（replay 不重执行）；`test_paid_coordinator.py` | 硬门槛 |
| stale approval/action/target/preflight 全 fail-closed | 版本绑定；approval/evaluation/action stale | TASK-028/029/030 | `test_workspace_wfm1_acceptance.py::test_gateway_write_safety`（stale target 拒）；`test_gateway_service.py`（high-risk stale 拒）；`test_action_service.py`、`test_evaluation_service.py`（drift→stale） | 硬门槛 |
| secret / 私有 URL 不外泄 | 查询/记录凭据过滤 | TASK-025/028/029 | `test_workspace_wfm1_acceptance.py::test_gateway_write_safety`（context 凭据键拒、零落盘）；`test_workspace_queries.py::test_queries_never_expose_credentials_or_private_urls`；`test_action_service.py` | 硬门槛 |
| 路径逃逸 / symlink / 非 localhost 访问防护 | ADR-0032 不变量 4；同源 CSRF 门 | TASK-025/030/033 | `test_workspace_wfm1_acceptance.py::test_non_localhost_origin_and_path_escape_refused`；`test_workspace_shell.py`（traversal/containment）；`test_path_containment.py`；`test_workspace_write.py::test_cross_origin_post_is_refused_csrf` | 硬门槛 |
| 每写经 Gateway；Provider/UI 不写业务事实 | ADR-0032/0033 | TASK-031 | `test_workspace_wfm1_acceptance.py`（读用 QueryService、写用 Gateway，UI actor 强制 user）；`test_workspace_write.py::test_client_actor_is_ignored_forced_to_user` | 硬门槛 |

## 3. 明确指向后续 owner（本门不虚假收口）

| 范围外条目 | 现状 | 后续 owner |
| --- | --- | --- |
| 图片候选/母资产/关键帧 | WFM1 无此事实，谱系相应 unavailable | TASK-035 产事实，TASK-039 纳入 Workspace |
| 正式音频/字幕/混音 | 用户提供文件的登记与合成尚未交付 | TASK-008；TASK-036 完整化 |
| 生成式对白/音乐/音效 | 无 Provider 抽象（未泛化 VideoProvider） | TASK-035/036（ADR-0037～0038 Accepted 后） |
| 完整 L0–S7 正式作品验收 | 仅 brief/concept 最小子集 + WFM1 付费链 | TASK-034/036/037 |
| WFM3 自动化率、自动路由、批量固定职责 | 未交付 | TASK-011/012/038 |
| 浏览器 shell 直接呈现 WQ-15～18 | 查询服务 + CLI 已支持；HTTP GET 路由未扩展 | TASK-039（Workspace 完整界面扩展） |
| 两份顶层需求最终产品验收 | 未开始 | TASK-040 |

## 4. 已知限制（诚实声明）

1. **浏览器 GET 未覆盖 WQ-15～18。** 评价/Action/跨项目分析/推荐的 baseline 读表面是
   `WorkspaceQueryService` + CLI（`ws-*` 子命令、`knowledge-promote`），HTTP shell 的
   GET 路由仍只暴露 WQ-01～14。这是 UI 表面缺口，不是数据/安全缺口，归属 TASK-039。
2. **多媒体 target 尚不存在。** 评价/Action/推荐当前只能绑定 WFM1 已产出的视频/资产；
   图片、音频、字幕作为 target 需 TASK-035/008 先产出权威事实。
3. **知识证据仅限 WFM1 事实。** WQ-18 证据 ref 目前指向 WFM1 资产 digest；扩展到全媒体
   证据由 TASK-039。
4. 上述限制均在阶段边界内，`unavailable`/`insufficient_evidence` 仅用于阶段性视图，
   不等于最终需求完成。
