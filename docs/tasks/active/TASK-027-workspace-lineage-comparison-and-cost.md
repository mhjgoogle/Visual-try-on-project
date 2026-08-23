# TASK-027：谱系、提示词/产物比较与成本深钻（WSM1-C）

> **状态：核心已交付（part-1 + part-2a），part-2b 推迟。** 依赖 ADR-0031/0032
> Accepted、TASK-020/021/022 source contracts、TASK-025/026；完整验收仍等待
> TASK-023 readiness 与独立审查。
>
> **已交付（2026-08-03）：**
> - part-1（commit `c86061d`）：WQ-07 cost-breakdown 附加派生维度 `by_step`/
>   `by_stage`/`by_time` + per-operation `occurred_at`/`occurred_month`（JST，与
>   by_time/预算台账同源），契约 1.0→1.1，见 ADR-0031 增补；纯只读派生，不改核心
>   lineage/cost 写入器。codex 独立审查首轮 0 发现通过。
> - part-2a（commit `bd97f9e`）：shell 成本 per-operation **多维交互筛选**
>   （shot/provider/model/status/月，客户端 narrow 不重查）+ prompt **版本 diff**
>   （vs 父版本 reference_assets/generation_packets 增删 + digest 变化）。codex
>   独立审查 0 blocking（1 条 P3 _listDelta 多重性，记录不修）。
>
> **推迟（part-2b，用户决策 B，2026-08-03）：** 候选/选中**并排媒体比较**与
> `reuse_usage` 下游使用页。原因：候选/选中结果 DTO 当前仅带 id/ref，不含媒体
> artifact 路径，实现并排媒体需再扩查询合同暴露路径；决定等 WFM2 多媒体 Provider
> （ADR-0038）落地、媒体路径模型稳定后与之一并做，避免为此单独多扩一次合同后又改。
> 届时随 TASK-035/039 媒体扩展承接。
>
> **复核（2026-08-23）：推迟的那个理由已经不成立了。** part-2b 当时等的是
> 「WFM2 多媒体 Provider（ADR-0038）落地、媒体路径模型稳定」——
> ADR-0038 已 Accepted，[TASK-035](../done/TASK-035-wfm2-multimedia-generation-and-lineage.md)
> 与 [TASK-039](../done/TASK-039-workspace-multimedia-and-full-workflow-expansion.md)
> **两张卡都已在 `done/`**。所以 part-2b 现在是**可做的**，不再被媒体路径模型挡住。
>
> **但动手之前有一个必须先定的东西**：part-2b 要在 `workspace_shell` 里加两个页面
> （并排媒体比较、`reuse_usage` 下游使用），而 **`workspace_shell` 的去留至今没有
> 结论**。[TASK-083](../done/TASK-083-phase3-adrs-first.md) §5.1 要求「顺带在文档里
> 明确它的去留」，[TASK-103](../done/TASK-103-frontback-and-ui-residuals.md) 批次 B
> 声明会做，但 2026-08-23 全仓 grep **找不到任何记下来的结论**——
> 又一处「声明了却没落到文档里」。
>
> 具体的风险是实的：C-020 记着 `workspace_shell` 对真实 Studio 项目 **Portfolio
> 全空**（`discover_projects` 要 `config/wfm1.json`，Studio 建的项目没有）。
> 往一个对真实项目看不见任何东西的壳里加两个页面，**做完也没法验收**
> —— AGENTS.md §20「真实 Connected Project 是主要验收环境」。
>
> **接手顺序因此是**：先定 `workspace_shell` 的去留（技术决策，按 AGENTS.md §1
> 由实施 Agent 自行决定并写进文档），再决定 part-2b 落在哪个壳里。

## 目的

在只读工作视窗中实现双向产物谱系、提示词版本与生成结果比较，以及按阶段、步骤、
镜头、Provider、模型和时间的成本观察。

## 输入

- TASK-020 prompt/task packet identity；
- TASK-021 run/artifact/cost lineage；TASK-022 evaluation/decision evidence；
- TASK-024 query contract、TASK-025 query service、TASK-026 shell。
- ADR-0031 查询/projection 合同与 ADR-0032 UI 拓扑。

## 输出

- lineage、prompt version、generation batch、artifact comparison、cost drilldown 查询；
- 谱系图/列表、版本 diff、媒体并排比较、候选/选中关系和下游使用页面；
- quote/estimate/reservation/actual、失败/重试成本和过滤页面；
- 大图/视频懒加载、缺媒体和 unavailable 类型处理；
- 对应数据正确性与 UI 集成测试。

## 修改范围

workspace query/projection 的 WSM1 扩展、只读 UI 页面、媒体展示 adapter 和测试；
不修改核心 lineage/cost 事实写入器。

## 明确不做

- 不生成图片/视频，不选择或修改产物；
- 不实现评价写入、实验创建、Action 或自动推荐；
- 不把实际成本和派生 JPY 复制为 UI 权威数据；
- 不要求 WFM1 范围外图片/音频/字幕数据存在。

## 实施步骤

1. 补齐双向 lineage 和成本维度 query。
2. 实现 prompt 版本链、diff 和 generation batch 结果集合。
3. 实现产物上溯/下钻及候选并排比较。
4. 实现成本筛选、预算线和失败/重试归属。
5. 验证 legacy、orphan、ambiguous 和范围外类型显示。

## 测试要求

- 谱系双向查询、循环/孤儿检测、稳定排序；
- prompt v1/v2/v3 与结果/选择/后续产物关联；
- 原币、FX、JPY、hold、actual 和去重正确；
- 媒体缺失/损坏不破坏其余元数据观察；
- UI 不写业务数据、不泄露临时私有 URL。

## 验收标准

- [ ] 任意支持的正式产物可上溯来源并查看直接消费者；
- [ ] 提示词版本、修改依据和全部生成结果可比较；
- [ ] 成本可按需求维度过滤且与权威账本一致；
- [ ] unavailable/legacy 明确显示，不猜测数据；
- [ ] WSM1 经 TASK-023 readiness 与独立审查后 Accepted。
