# TASK-027：谱系、提示词/产物比较与成本深钻（WSM1-C）

> **状态：已完成（2026-08-24）。** part-1 + part-2a + **part-2b 三个切片全部交付**，
> 每一部分都经 codex 跨模型独立审查（part-2b 切片 1 一轮零发现；切片 2+3 两轮，
> 轮 2 pass）。
>
> **收口前逐条核实过前置**（本仓库最贵的缺陷是过期声明，所以不引用卡上的话）：
> TASK-023 在 `done/` 且 **WFM1 milestone review PASSED**（2026-08-02），
> TASK-025 / TASK-026 同样在 `done/`。原状态行写的「完整验收仍等待 TASK-023
> readiness」以及「part-2b 推迟」**都已不成立**。
>
> **仍未做、但不属于本卡**：part-2b 的两个页面已经能用，剩下的是在真实核心项目
> （`wfm1-demo` / `wfm1-minimax-evidence`）上的人工验收 —— 那是判断，不是机械
> 验证，按 ADR-0086 的后果 2 归产品负责人。
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
> **已定（2026-08-24）** → [ADR-0086](../../adr/ADR-0086-workspace-shell-serves-core-projects-only.md)：
> `workspace_shell` **保留**，主语明确为 **WFM1 核心项目**；**不**让
> `discover_projects` 接纳 Studio 项目 —— 那会让壳开始说谎（Studio 项目里没有核心
> 事实，点进去是每一页都空的谱系与成本，看起来像「功能坏了」而不是「不归这里管」）。
> **「Portfolio 不空了但每一页都是空的」严格劣于一个诚实的空 Portfolio。**
>
> **对本卡的三个直接后果**：
>
> 1. part-2b **落在 `workspace_shell`** —— 它的主语是谱系与复用，是核心事实；
> 2. 验收环境是**真实的核心项目**（如 `wfm1-demo` / `wfm1-minimax-evidence`），
>    不是 Studio 项目。AGENTS.md §20 那条「真实 Connected Project 是主要验收环境」
>    要的是「别拿 demo seed 与 SVG 占位素材当依据」，不是「一切都拿 Studio 项目验」；
> 3. C-020（Portfolio 对 Studio 项目全空）**不再算本卡的前置缺陷**。
>
> **切片 1 已做（2026-08-24）：查询合同 1.5 → 1.6，WQ-06 绑上实际媒体。**
> 这正是上面写的那个前置 —— 「候选/选中结果 DTO 只带 id/ref」。现在每个 attempt
> 额外带 `media_ref` / `media_kind` / `media_version` / `media_path` /
> `media_sha256`〔A〕与 `media_asset_count`〔D〕。
>
> **连接键是 `operation_id`，两侧都是权威事实**（`_validate_producer` 对每个
> generation 来源的资产强制要求它；reservation 本来就带），所以绑定不靠名字或
> 时间推断。手工/导入来源没有 `operation_id`，**不参与绑定也不编一个**。
> 没有已发布资产的 attempt，五个媒体字段**全部 `unavailable`** —— 空路径在界面上
> 会读成「有这个文件但打不开」，而事实是「这次尝试没有产出资产」。
>
> 测试：`tests/backend/test_workspace_queries.py` 三条（绑定的前后对照、
> 缺席不得回填、其他 attempt 不被连带绑上）。变异验证：把连接键换成 `task_id`
> 后绑定测试立刻红。夹具走**真实的** `generate_batch → record_selection →
> promote_selection` 链，不手搓 MediaAsset —— `_verify_generation_provenance`
> 本来就拒绝「绑定媒体不是所选候选的暂存文件」的资产，手搓等于测一个产品
> 永远造不出来的形状。
>
> **切片 2（2026-08-24）：`reuse_usage` 接进壳。** 查询层早就有
> `WorkspaceQueryService.reuse_usage`，但**壳里没有任何路由通向它** —— 下游使用
> 页因此拿不到数据。新增 `GET /api/reuse-usage?asset_id=&version=`，**账户级**
> （挂到 `/api/projects/<name>/…` 会暗示「这是那个项目的事实」，而它恰恰是跨项目的）。
> `version` 强制正整数：非数字 / 0 / 负数 / 小数一律 400 ——「默默当成最新那一版」
> 正是一次复用审计答到错版本上去的方式，而这个页面的全部意义就是「**这一版**
> 被谁用了」。测试 2 条；变异验证：去掉 `version < 1` 那道闸后立刻红。
>
> **切片 3（2026-08-24）：并排媒体比较页做出来了。**
> Shots 视图新增 `renderShotAttempts`：每个 attempt 一张卡，**带媒体的直接渲出
> 画面**（复用既有的 `mediaNode`，走壳自己的 `/artifact` 端点，含路径围栏），
> CSS 用 `auto-fill` 网格 —— 两条并排、六条换行、窄窗退成一列，而不是把每帧
> 压成缩略图。没有媒体的 attempt **说明原因**，不渲空播放器：一个空 `<video>`
> 是个黑框，读起来像「这次生成失败了」，而事实可能是「成功了，只是还没发布成
> 资产」—— 两件不同的事不能长一个样。
>
> 顺带修掉一条**过时注释**：`mediaViewer()` 里写着「查询合同尚未把 ref 绑到媒体
> 路径」，切片 1 之后不再成立（手工粘路径的查看器保留，它对 lineage 视图仍是
> 唯一的路子）。
>
> 测试：`tests/e2e/test_workspace_shell_compare_task027.py` 2 条，**真 Chromium
> 驱动真的 shell 前端**。为什么必须用浏览器：`static/app.js` 是浏览器脚本，
> 没有 `export`、靠 `document` 活着，`node --test` import 不了；而 AGENTS.md §20
> 禁止 Python 测试对前端 JS 做源码文本断言（断言源码里有没有某串字，证明不了
> 它跑起来会渲出什么）。变异验证：让渲染器忽略媒体（退回 part-2b 之前的样子）
> 后立刻红。
>
> **审查**：codex 跨模型，独立性未降级。切片 1 一轮 pass 零发现；切片 2+3
> 轮 1 `fail` → 轮 2 `pass` 零发现。轮 1 那条 blocking（`producer_operation_id`
> 未检查 `source == "generation"`，codex 自标 uncertain）**经证据驳回**：
> `_validate_producer` 的非 generation 分支构造的是只含 `source` + `note` 的新
> 字典（白名单，非透传），读路径每一步都过它，**无活缺陷**。仍加了显式闸 ——
> 理由不是修复，而是这条绑定决定的是**身份**，绑错等于创作者在判断某镜时看到
> 另一次操作的画面；规则该写在用它的地方，而不是靠三个模块之外、将来可能被
> 放宽的白名单。轮 1 那条 non-blocking 是**真缺口**（`?version=1&version=2`
> 静默取第一个）已修。
>
> **变异验证 3 次全部转红**：连接键换成 `task_id`、去掉 `version < 1` 那道闸、
> 让渲染器忽略媒体。
>
> **part-2b 的两个页面到此都有了。** 剩下的是真实核心项目上的人工验收
> （`wfm1-demo` / `wfm1-minimax-evidence`，见 ADR-0086 的后果 2）—— 那是判断，
> 不是机械验证。

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
