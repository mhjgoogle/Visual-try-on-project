# WSM3 Workspace WFM1 数据基线里程碑评审（TASK-033 gate）

- 日期：2026-08-03
- 审查方式：独立跨模型 codex 审查（codex-review-loop skill，无降级回退）
- 审查基线：`feat/wfm1-batch-c`，TASK-024～032 已交付并各自过审之上的 TASK-033 增量
- **代码/安全审查结论：PASS**（BLOCKING 0，NON_BLOCKING 0，1 轮收敛）
- **里程碑验收结论：AWAITING USER SIGN-OFF**（验收标准勾选属于用户；见
  [验收 runbook](workspace-wfm1-acceptance-runbook.md) §5）

## 范围

Workspace-on-WFM1 数据基线门。证明工作视窗在 WFM1 已支持的产物类型和命令范围内
可跨项目观察、比较、评价、管理、运行、学习，并在关闭/重启、projection 损坏、重复
命令、stale 目标与付费二义场景下保持核心工作流安全。不新增 Provider、工作流步骤、
页面或多用户部署；不把 WFM1 范围外的图片/正式音画/完整 L0–S7 伪装为已验收。

## 过程

- 1 轮 codex 独立审查，VERDICT pass，零 blocking / 零 non-blocking。
- 无需修复轮；未触发 fallback（cross-model 独立性未降级）。

## 验证证据

- 完整套件：**2429 passed, 3 skipped**（3 为环境相关 smoke：ffprobe / real-tools /
  real-MiniMax），较 TASK-032 的 2424 新增 5 个跨切面验收。
- ruff check：全过。
- 跨切面主验收 `tests/test_workspace_wfm1_acceptance.py`（5/5）：
  1. `test_wfm1_workspace_closed_loop` —— 观察（WQ-01 完整 L0–S7 + WQ-11）→ Gateway
     写评价 →WQ-15 → Gateway 写 feedback/action/transition →WQ-16 → 账户级 promote →
     WQ-17 派生 KPI（有事实项目 derived rate；空项目 insufficient_evidence，非伪造零）
     + WQ-18 证据化推荐。
  2. `test_projection_rebuild_readonly_and_ui_restart` —— 双 app 实例（=关闭重开 UI）
     字节一致；读前后文件快照相同（零写、无缓存）；corrupt QCD →readiness_failed +
     source_corrupt；恢复权威日志后干净重建。
  3. `test_gateway_write_safety` —— 幂等 replay（一条记录）、stale target 拒写、
     context 凭据键拒写零落盘、未注册命令拒。
  4. `test_non_localhost_origin_and_path_escape_refused` —— 真实 HTTP server：跨源/
     null/异端口 POST 全 403，精确同源过 CSRF；路径逃逸与越界 artifact 拒。
  5. `test_full_episode_observe_cost_lineage_and_media_honesty` —— 真实付费链成片的
     成本（每镜头一次计费）、项目可发现性、以及 plan 对 unbuilt WFM2 媒体步骤的诚实性。
- 逐域细粒度证据与追踪见
  [验收追踪矩阵](workspace-wfm1-acceptance-traceability.md)。

## 验收标准对照

对照 TASK-033 卡 `## 验收标准` 六条：前五条（WFM1 范围内闭环真实证据、projection/UI
损坏不改权威状态、写全经 Gateway、资金/版本/恢复/防覆盖/凭据对抗、文档一致）均已备齐
自动化证据；第六条（图片/音频/字幕/完整 WFM2·WFM3 与最终验收明确由 TASK-034～040
承接）由追踪矩阵 §3/§4 显式收口。**最终勾选由用户在 runbook §5 完成。**

## 已知限制

见 [验收追踪矩阵](workspace-wfm1-acceptance-traceability.md) §4：浏览器 GET 尚未呈现
WQ-15～18（CLI/QueryService 为 baseline 读表面）、多媒体 target 与全媒体证据待
TASK-035/008/039。均在阶段边界内，`unavailable`/`insufficient_evidence` 仅用于
阶段性视图，不等于最终完成。本门不是两份顶层需求最终验收（最终由 TASK-040）。
