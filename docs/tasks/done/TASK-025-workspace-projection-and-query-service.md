# TASK-025：可重建 Projection 与 Query Service（WSM1-A）

> **状态：Accepted（2026-08-02，独立审查两轮通过）。** 依赖
> TASK-024 完成、ADR-0031 Accepted、TASK-023 readiness 通过（2026-08-02）。
> 已实现只读 workspace query 层 `src/ai_video_workflow/workspace/`（envelope
> 三分 DTO + `io_contract` 完整 L0–S7 step 定义 + discovery + records + 五个
> 领域只读 adapter + WQ-01～WQ-14 + 单一 `WorkspaceQueryService` 入口 +
> 账户 containment）、CLI `ws-*` 只读子命令与 `to_jsonable` 序列化边界；测试
> `tests/test_workspace_queries.py` 与 `tests/test_workspace_cli.py`。
> on-demand 无持久缓存（ADR-0031 决策 2）。独立 reviewer（与实施 Agent 分离）
> 首轮提出 5 Blocker + 4 Important，全部在本任务范围内修复（WQ-01 返回完整
> I/O 合同 step 计划、谱系/成本按 ref/version/digest 连接并对账 fail-closed、
> WQ-10 全查询+digest 快照、WQ-12/14 账户级验证、三分标注修正、账户
> containment 与安全测试），复审判定 **PASS**，无残留。

## 目的

建立 UI 无关的只读查询层，从权威文件/事件确定性派生跨项目计划、进度、状态、
最近产物/问题和成本摘要，为 CLI、测试和未来界面提供唯一查询入口。

## 输入

- TASK-024 query contract 与 source mapping；
- TASK-018～023 权威数据合同；
- ADR-0001、ADR-0003、ADR-0004、ADR-0010、ADR-0031。

## 输出

- 新的 workspace query/projection 应用模块（精确包路径由 ADR-0031 决定）；
- project discovery 与领域 source adapters；
- 版本化只读 DTO/serialization 边界和 query CLI 或测试 harness；
- deterministic rebuild、错误聚合、legacy/unavailable 支持；
- 对应单元、跨项目集成和安全测试。

## 修改范围

ADR-0031 授权的新 workspace query/projection 模块、公共导出、只读 CLI/harness、
测试与示例。核心领域模块只读，不修改其写入合同。

## 明确不做

- 不创建业务事实、修复损坏文件或反向写入；
- 不实现 UI、Action、评价写入或 Command Gateway；
- 不将 projection/cache 作为权威来源；
- 不读取 credential 值或返回私有下载 URL。

## 实施步骤

1. 实现 source adapter 注册和版本兼容边界。
2. 实现 project list、workflow plan/status、recent artifacts/issues、cost summary 查询。
3. 实现跨 source 引用校验和结构化错误/legacy 标记。
4. 实现无缓存重建；如使用缓存，增加删除后等价重建。
5. 随 TASK-020～023 source 落地逐项补 adapter，不在本层臆测字段。

## 测试要求

- 空项目也返回完整计划；多项目排序确定；损坏 source fail-closed；
- projection 删除重建语义等价；重复查询无业务写入；
- containment、symlink、secret redaction 和临时 URL 排除；
- source schema 多版本、legacy/unavailable 和孤儿引用；
- 全量 M1/WFM1 回归保持通过。

## 验收标准

- [x] TASK-024 的 WSM1 基础查询均有同一只读入口
  —— `WorkspaceQueryService` 暴露 WQ-01～WQ-14；CLI `ws-*` 子命令一一对应。
- [x] projection 可重建且不是第二事实来源
  —— on-demand 无持久缓存；WQ-10 rebuild-check 验证两次求值语义等价且过程零写入
  （`test_wq10_rebuild_is_deterministic_and_read_only`、`test_queries_write_nothing`）。
- [x] query service 不导入 UI 或调用 Provider
  —— `test_service_does_not_import_ui_or_call_provider`（无 default_registry /
  VideoProvider / write_model_json）。
- [x] WFM1 source 缺口明确，不由 projection 伪造补齐
  —— 三分标注中 unavailable 显式（WQ-01 未实施步骤 run 实例、WQ-05 图片/音频/
  字幕、WQ-08 创作决定）；schema 不支持/损坏源 fail-closed
  （`test_unsupported_schema_surfaces_as_problem`、`test_corrupt_shot_plan_fails_closed`）。
- [x] TASK-023 readiness 通过后方可标记最终 Accepted
  —— readiness 已于 2026-08-02 通过；独立 reviewer 两轮审查（首轮 5 Blocker +
  4 Important，修复后复审）判定 PASS，据此 Accepted。

## 交付物与证据

- `src/ai_video_workflow/workspace/`：`envelope.py`（Provenance 三分 + Problem
  模型 + QueryResult + `to_jsonable` DTO）、`discovery.py`、`records.py`、
  `adapters/`（base + project/plan/execution/delivery 五个只读域）、`queries.py`
  （WQ-01～WQ-14）、`service.py`（单一入口）；
- CLI：`ws-plan/status/lineage-up/lineage-down/prompt/shot/cost/eval/problems/
  rebuild-check/index/reuse/approval-audit/budget`；
- 测试：`tests/test_workspace_queries.py`、`tests/test_workspace_cli.py`；
- 范围红线：只读、无持久缓存、不写业务状态、不调 Provider、不导入 UI、不实现
  Action/Gateway/写语义、不读凭据、不返回私有 URL；不接受 ADR-0032～0040。
