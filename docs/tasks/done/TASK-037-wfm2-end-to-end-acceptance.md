# TASK-037：WFM2 正式作品端到端验收

> **状态：里程碑 PASS（产品负责人 2026-08-24 原话「WFM2 可以了」）。**
>
> 按 [ADR-0082](../../adr/ADR-0082-no-signoff-gate-on-task-cards.md) 决策 3，
> 里程碑归用户判定、**形式是一句话**，由 Agent 记录原话与日期。
>
> **裁定当天（2026-08-24）重跑过证据**，不是引用 2026-08-04 的结论：
> `tests/e2e/test_wfm2_e2e_acceptance.py` 与 `test_final_unified_acceptance.py`
> 合计 **7 条全部通过**；同日全量两阶段 pytest 3528 + 6、node 1848、
> ruff 619 文件全绿。
>
> **这句话认下的是什么**（追踪矩阵 §4 的四条已知限制，裁定前已逐条说明）：
> ① 合同层交付 —— 身份/谱系/事实域/状态语义成立且可组合，但具体 QC 参数、
> 发布服务、scorecard 聚合、最终 JSON schema、DB/CLI 均未展开（ADR-0039
> 明确留到验收后按需细化）；② `content_digest` 自算、无外部锚定；
> ③ 无真实付费 API / 无自动发布 / 无真实剪辑软件自动化，E2E 全程离线打桩；
> ④ M1 视频链由 fake composer/inspector 驱动，不是真工具跑完。
>
> **未裁定**：[TASK-040](../active/TASK-040-final-unified-product-acceptance.md)
> 最终产品里程碑 —— 用户这一次说的是 WFM2，那张卡仍在 `active/`。
>
> ~~Evidence Ready — 等用户一句话确认（2026-08-04）。~~ WFM2 milestone gate；
> TASK-008、TASK-034～036 均 Implemented。本任务不新增产品能力，只备齐验收证据。
> 交付 `tests/test_wfm2_e2e_acceptance.py`（L0→S7 组合）+
> [追踪矩阵](../../design/done/wfm2-acceptance-traceability.md) +
> [runbook](../../design/done/wfm2-acceptance-runbook.md) +
> [里程碑评审](../../design/done/WFM2-milestone-review.md)。里程碑 PASS 属用户（runbook §5），
> 实施 Agent 不代判 —— 但形式是**一句话**，不是签字栏（[ADR-0082](../../adr/ADR-0082-no-signoff-gate-on-task-cards.md) 决策 3）。证据已备齐；后续 TASK-038/039 不被此门阻塞，继续推进。

## 目的

证明一部 8–12 镜头正式作品完整执行 L0～S7，具备正式音画、无阻断 QC、成本受控、
复盘完整，并为最终 Workspace 提供全部多媒体权威数据。

## 输入

- TASK-023 WFM1 gate；TASK-008/034～036 的合同与实现；
- ADR-0037～0039；两份顶层需求与统一追踪矩阵。
- [L0–S7 工作层级输入输出合同](../../design/workflow-stage-step-io-contract.md)。

## 输出

- 默认离线 WFM2 E2E fixture、真实工具可选 runbook 和故障矩阵；
- 完整 L0～S7、图片/视频/音频/字幕/母版谱系与成本对账证据；
- 每个步骤的 input refs → output refs → Gate evidence 验收矩阵；
- WFM2 用户验收记录、已知限制和正式文档状态收口。

## 修改范围

验收测试、fixture、runbook 和状态文档；缺陷回到 owner task 最小修正，不新增 schema。

## 明确不做

- 不要求自动发布、自动路由或 Local Provider；
- 不把真实付费 API 作为默认 CI；
- 不实现 Workspace 页面或 WFM3 自动化；
- 不以 mock-only 测试替代真实应用协调链。

## 实施步骤

1. 固定正式作品、预算、媒体和 L0～S7 完成条件。
2. 贯穿创意、设计、多媒体生成、正式后期、QC、发布包和复盘。
3. 注入版本漂移、媒体损坏、预算拒绝、ambiguous 和外部编辑中断。
4. 验证全部权威事实可重建为最终 Workspace 查询输入。
5. 完成独立 milestone review 和文档收口。

## 测试要求

- 8–12 镜头、正式音画、全部 stage targets 和人工批准；
- 单集硬预算、跨媒体成本、失败重试和对账一致；
- 全谱系无孤儿，历史版本和未选候选保留；
- 每个 required step 有输出证据；conditional/optional-data 有可审计处置；
- 全量 pytest、ruff、文档编号/链接/追踪检查。

## 验收标准

- [ ] 完整 L0～S7 和正式音画通过；
- [ ] I/O baseline 每一行均映射到 Accepted schema/owner、实现和端到端证据；
- [ ] 无阻断 QC，成本不超过 WFM2 硬上限；
- [ ] 模型表现、返工原因、观众数据缺失状态和复用候选已记录；
- [ ] 多媒体数据满足最终 Workspace source readiness；
- [ ] 独立审查通过后方可声明 WFM2 完成。
