# 最终统一验收 Runbook（TASK-040）

离线、零花费的最终产品里程碑用户验收步骤。全程不接任何付费/TTS API。里程碑 PASS
由用户勾选（§5），实施 Agent 不代判。

## 1. 前置

- 已激活项目 venv；`ruff`、`pytest` 可用。
- 可选真实工具冒烟需 `ffmpeg`+`ffprobe` 且 `AI_VIDEO_WORKFLOW_REAL_TOOLS=1`。

## 2. 自动化证据（离线，零花费）

```bash
# 全量套件 + 静态检查
ruff format --check src tests
ruff check src tests
python -m pytest -q

# 最终统一验收（闭环 + 跨切面不变量）
python -m pytest tests/test_final_unified_acceptance.py -q

# 里程碑子验收（引用）
python -m pytest tests/test_wfm2_e2e_acceptance.py \
  tests/test_workspace_wfm1_acceptance.py -q
```

## 3. 验收标准 → 证据映射

| 验收标准（TASK-040） | 证据 |
|---|---|
| 两份顶层需求无未解释缺口 | [最终追踪矩阵](final-unified-acceptance-traceability.md) §3 + §4 已知限制 |
| I/O baseline 全部步骤有 requirement→owner→code→test→evidence | [追踪矩阵](final-unified-acceptance-traceability.md) §1 + [端到端矩阵](end-to-end-requirements-traceability.md) |
| 完整工作流与 Workspace 可跨项目复用 | `test_final_..::test_formal_facts_are_reusable_across_projects`；WQ-11/12/17 |
| 自动化不替代用户创作决定 | `test_final_..::test_automation_never_replaces_user_creative_judgement` |
| 所有业务事实唯一写入者且 projection 可重建 | `test_final_..::test_unique_writer_fact_domains_are_separated`；WQ-10 rebuild-check |
| UI 关闭/重建不影响核心，重复命令不重复付费 | TASK-033 验收（真实 Gateway/HTTP 链，幂等回执） |
| 损坏/stale/secret 攻击 fail-closed | `test_final_..::test_corruption..fails_closed`；TASK-033 安全验收 |

## 4. 闭环演示（观察端，离线）

`test_final_unified_acceptance.py` 贯穿 目标→运行→观察→评价/Action→复盘→学习/复用：
多媒体事实 authoritative 可观测、projection 可确定性重建、损坏 fail-closed、母版跨项目
digest 复用、自动化不占用人工创作 Gate、缺失≠零。

## 5. 最终里程碑 PASS（属用户，一句话即可）

> 实施 Agent 已备齐全部证据，不代判 PASS。
> **形式：一句话，不是表格**（[ADR-0082](../adr/ADR-0082-no-signoff-gate-on-task-cards.md)
> 决策 3）。里程碑 PASS 仍归用户判定 —— 它是对整个产品的声明 —— 但说一句
> 「这个可以了」即成立，由 Agent 记录原话与日期。原先的 `签字：____ 日期：____`
> 表格已取消：AGENTS.md §1 禁止「要用户离开对话手动操作」的机制。
>
> 下面的清单是**给用户看的证据索引**，不是要他逐项打勾的表单。

- [ ] 已运行 §2 自动化证据并全部通过（全量 pytest + ruff）。
- [ ] 已审阅 [最终追踪矩阵](final-unified-acceptance-traceability.md) §1–§3 与 §4 已知限制。
- [ ] 已确认 WFM2 gate（TASK-037）与 WFM1 数据基线（TASK-033）子验收状态。
- [ ] 认可 [最终追踪矩阵 §4 已知限制](final-unified-acceptance-traceability.md)
      （合同层后续增量、自算 digest、UI/写命令接线增量、无付费 API）。
- **最终产品基线**：由用户一句话裁定 PASS 或需返工；Agent 记录原话与日期。
  ~~PASS / 需返工（圈选），签字：________ 日期：________~~（表格形态已按 ADR-0082 决策 3 取消）
