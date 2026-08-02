# WFM1 Milestone Review（TASK-023 gate）

- 日期：2026-08-02
- 审查方式：独立 reviewer Agent（非实施 Agent），只读审查两轮；实施 Agent
  仅执行机械验证与范围内最小修复。
- 审查基线：commits `55d4218..43690f5`（TASK-018～023）+ 工作树中的复审
  修复批（两轮外部 Codex 复审修复 + 本 gate 两轮修复）。
- **结论：PASS。** TASK-018～022 随本 gate 一并收口。

## 过程

1. 此前两轮外部（Codex）复审：3 Blocker + 6 Important + 1 Minor，全部修复
   并经复审确认（同 task 换 operation 二次扣费守门、packet 驱动付费入口、
   批准计划版本精确加载、packet 全内容重算校验、QC 成片探测与
   schema v2、发布四方 digest 对应、归档 symlink 拒绝等）。
2. 本 gate 独立 reviewer 第一轮：无 blocker；1 Important（示例夹具无测试
   保护）+ 3 Minor（遗留混合态 fallback 回放、packet 路径 `--stage` 静默
   忽略、`--account-root` 语义不对称）+ 1 informational（reservation 无
   签名 JSON 的威胁模型边界）。
3. 实施方最小修复后交回同一 reviewer 复审：5/5 项逐项复核通过，未引入
   新问题，判定 **PASS**。

## 验证证据（实施方执行，全部离线，零真实付费调用）

- 全量 `python -m pytest -q`：**2211 passed, 3 skipped**（skip 均为显式
  opt-in 冒烟：ffprobe 真工具、MiniMax 真实付费）；
- `ruff format --check .`：245 files already formatted；`ruff check .`：通过；
- `git diff --check`：无空白错误；
- WFM1 文档链接/路径/任务与 ADR 编号检查：15 个文档全通过；
- `tests/test_wfm1_e2e.py` 显式运行 5/5：离线全链路（6 镜头 60s、规划与
  实际成本均 ≤1200 JPY、成本事件每镜头恰好一条）、故障恢复矩阵（审批
  过期/预算拒绝/submit 二义/下载失败/中断续跑，均零多余调用零重付）、
  packet 门（篡改/FX 漂移/未审批新计划全部拒付）、双项目复用 + 月度
  在途口径、projection 逐字节确定性重建；
- `tests/test_wfm1_demo_example.py`：示例夹具与 README runbook 输出
  （8 包、p50=128、p90=256 JPY）及 catalog digest 全部钉死。

## 专项判定（reviewer 逐项核过，均无 finding）

付费边界、预算口径（整数 JPY 三级 + 跨项目月度在途 + FX 锁定 + 账户锁
原子性）、路径合同（ADR-0011/0012 与代码一一对应、resolve_within_root
一致使用）、唯一写入者（成本单一事实源，复盘仅派生）、断点续跑、禁止
静默覆盖（正式产物全部 create-only）、Provider 中立（MiniMax 仅在
providers/ 适配器）。

## 遗留（非阻断，已记录）

- reservation 文件为无签名本地 JSON：本机单用户威胁模型边界，已在
  TASK-016 卡记录，不改码。
- product spec / architecture / implementation plan 的 WFM1 状态行与并行
  Creation Workspace 批次的未提交改动重叠，本 gate 不改动这些文件；
  正式状态以任务卡与本记录为准，待并行批次提交后统一对齐。
- 本 gate 的代码修复批与本记录尚未 commit（等待用户指示）。
