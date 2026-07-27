# TASK-004：Provider Orchestrator 契约与基础编排（Provider Orchestrator Contract and Foundational Orchestration）

## 背景

TASK-003 已完成并通过 Codex 最终独立复审（完成基线
`01ac984 docs: complete TASK-003 implementation`），仓库已具备：

- `VideoProvider` 抽象契约（prepare → submit → poll → collect，
  显式状态快照传递，`_validate_alignment` 身份对齐）；
- `ManualVideoProvider`（无内部状态、不扫描目录、只处理显式输入）；
- Provider 数据结构（ProviderRequest、ProviderResult、
  ProviderInstruction、ArtifactReference、ProviderCostObservation、
  七状态 ProviderStatus 与规范性矩阵）；
- ProviderError 子树（四类可区分错误）；
- TASK-002 交付的六核心模型、StepManifest、确定性 JSON 序列化、
  原子持久化与 ProjectData 引用验证。

但 Provider 契约只覆盖**单次生命周期操作**。调用方目前仍需手工：

- 决定调用 prepare、submit、poll 还是 collect；
- 维护 ProviderRequest、ProviderResult、task 和 shot 的身份一致性；
- 判断允许的生命周期转换；
- 防止旧结果覆盖新状态；
- 将 ProviderResult 映射为项目级任务状态（GenerationTaskStatus）；
- 决定何时以及由谁持久化；
- 处理重复 poll、重复 collect 和进程重启后的恢复。

TASK-004 进入实施规划阶段 2 的 Orchestrator 部分：建立清晰、可测试、
无隐藏副作用的 Orchestrator 边界。architecture.md §3 定义的
Orchestrator 完整职责（含 staging 分配、媒体校验、正式资产导入、
VideoAsset 登记、QCD 事件写入）**不在本任务全部实现**——本任务只
承接其中的基础编排子集，其余职责由后续任务承接（见"固定规格约束"
与"尚待后续任务决定的事项"）。

Codex 第一轮规格审查结论为**不通过**（1 个阻塞、6 个重要问题）。
本版任务卡逐项关闭：正式资产边界固定为规格约束（不再是开放设计
问题）、persistence 与 architecture.md 的关系按"状态变更决策权 /
I/O 执行责任"区分并要求三方案比较、补充完整编排矩阵 /
GenerationTask 逐字段规则 / StepManifest 设计问题 / 三层幂等性 /
可测试的不可倒退规则 / 恢复与失败边界 / 说明文件双层边界，并同步
修订验收标准与编码门槛。

本任务工作分支：`feat/task-004-provider-orchestrator`。

## 单一目标

定义稳定、可测试的 Provider Orchestrator 契约并实现基础编排能力，
使调用方不再手工驱动 Provider 生命周期：Orchestrator 负责编排级
生命周期策略（决定下一合法动作、调用对应 Provider 方法、验证返回
状态、拒绝非法或陈旧转换）、ProviderStatus 到项目级状态的映射以及
GenerationTask / StepManifest 的更新职责，为第一阶段最小闭环的
后续任务（视频文件校验、VideoAsset 登记、FFmpeg 合成）提供稳定的
编排边界。

## 固定规格约束（不再是开放设计问题）

以下边界在规格层面固定，正式设计与实施不得重开：

1. TASK-004 **不创建 VideoAsset**；
2. TASK-004 **不把 ArtifactReference 转换成正式资产**；
3. TASK-004 **不登记正式资产**，不决定正式资产路径、版本或覆盖
   策略；
4. TASK-004 只定义 collect 成功后的 ArtifactReference 如何作为
   **显式输出**交接给后续的资产登记与媒体校验任务（交接点的数据
   形态由正式设计定义）；
5. 后续任务负责：媒体探测、正式路径决策、文件移动或复制、版本
   管理、VideoAsset 创建、正式资产登记。

## 范围内

任务实施须评估并明确以下内容（标注"设计定案"的项在正式设计文档中
确定，见"编码门槛"）：

1. Orchestrator 的公开契约（方法、参数、返回类型——设计定案）；
2. Orchestrator 的输入和输出模型；
3. Provider 生命周期调用顺序（完整编排矩阵，见对应章节——设计
   定案）；
4. ProviderStatus（七状态）到项目级状态的映射（设计定案）；
5. GenerationTask 与 StepManifest 的更新职责（逐字段规则，见对应
   章节——设计定案）；
6. 显式 observed_at / completed_at 输入（Orchestrator 不读时钟，
   时间由调用方显式传入，延续 TASK-003 原则）；
7. 调用方显式传入 ArtifactReference（Orchestrator 不自动发现
   产物）；
8. 三层幂等性规则（见对应章节——设计定案）；
9. 可测试的状态不可倒退规则（见对应章节——设计定案）；
10. 重复 poll 和重复 collect 的处理；
11. failed、cancelled 和非终态的项目级表达；
12. persistence 边界：状态变更决策权与实际 I/O 执行责任的分配
    （三候选方案比较，见对应章节——设计定案）；
13. 进程重启后的恢复边界与最小失败边界（见对应章节——设计定案）；
14. 冲突和错误分类（Orchestrator 层错误与 Provider 层错误的
    关系）；
15. 单元测试与集成测试边界。

## 范围外

明确排除：

- 新 Provider 实现（Cloud、Local 或其他）；
- 云 API；
- 本地模型推理；
- 浏览器自动化；
- artifact / 媒体文件扫描或自动发现；
- 文件复制、移动、重命名；
- VideoAsset 创建和媒体探测（固定规格约束第 1—5 条）；
- FFmpeg / ffprobe；
- QCD 事件写入（implementation_plan 阶段 2 列出的 QCD 原始事件
  采集由后续任务承接）；
- 后台队列；
- 并发调度；
- 网络重试；
- UI；
- CLI；
- Provider 注册表和插件发现；
- 事务与并发控制（但必须定义最小失败边界，见"恢复与失败边界"）。

## 输入

- 基线文档：AGENTS.md、docs/architecture.md、
  docs/implementation_plan.md、docs/adr/ADR-0001；
- TASK-002 交付的核心模型、StepManifest、persistence 与 ProjectData；
- TASK-003 交付的 providers 包与批准设计
  `docs/design/TASK-003-provider-contract-design.md`；
- TASK-003 完成基线 `01ac984`；
- Codex 第一轮规格审查报告（1 阻塞、6 重要）；
- 本任务卡。

## 输出

- 本任务卡（修订规格）；
- 正式设计文档
  `docs/design/TASK-004-provider-orchestrator-design.md`
  （Revision r6，已通过 Codex 正式设计复审）；
- 设计审查通过后：Orchestrator 实现与测试（本轮不创建任何 Python
  文件；最终文件结构由设计文档确定）。

## persistence 与 architecture.md 的关系

任务规格明确区分两个概念：

1. **状态变更决策权**：由谁决定 GenerationTask / StepManifest 的
   下一个合法状态与字段值——这始终属于 Orchestrator 边界；
2. **实际 I/O 执行责任**：由谁调用 persistence 完成落盘——这是
   待设计定案的开放问题。

architecture.md §3 当前将 Orchestrator 描述为 GenerationTask 的
唯一写入者、manifest 的写入者、VideoAsset 的唯一登记者。TASK-004
只覆盖基础编排子集且不创建 VideoAsset。

正式设计必须至少比较以下三个候选方案并说明取舍理由：

**方案 A：Orchestrator 直接执行状态 persistence**

- Orchestrator 负责状态变更决策；
- Orchestrator 直接调用批准的 persistence 边界（TASK-002 的原子
  写入与覆盖保护）；
- 允许项目状态文件 I/O；
- 仍禁止 artifact / 媒体文件访问和目录扫描。

**方案 B：纯 planning core + 受控执行层**

- planning core 计算不可变 update plan；
- 属于 Orchestrator 边界的受控 executor 执行 persistence；
- 外部调用方不能自行改变 update plan；
- 必须定义 executor 是否仍属于架构中的 Orchestrator。

**方案 C：application service 持有 persistence port**

- Orchestrator 决定状态变化；
- application service 仅执行明确计划；
- 必须说明如何继续满足 architecture.md 的"唯一写入者"原则。

规格级约束：

- 三个方案均为**待评估方案**，规格阶段不定案；
- 文件系统禁令只针对：artifact 文件、媒体文件、目录扫描、自动
  发现；**不得用全面文件禁令预先排除合法的项目状态 persistence
  方案**；
- 若最终选择的设计与 architecture.md 当前表述不一致，
  architecture.md 必须在**最终设计批准前**完成最小同步修订——
  不得在 Codex 已批准设计后才修改架构；
- 状态变更决策权在三个方案中均不外移。

## 完整编排矩阵要求

正式设计必须提供**完整矩阵**，而不只是原则性说明。矩阵维度至少
为：

当前项目状态 × 调用动作 × Provider 方法 × 允许的 Provider 返回
状态 × GenerationTask 字段更新 × StepManifest 字段更新 ×
Orchestrator 输出 × 错误类型。

调用动作至少包括：

- prepare；
- submit；
- poll；
- report artifact（调用方显式报告产物引用）；
- collect；
- replay result（重复应用已见过的 ProviderResult）；
- resume after restart（进程重启后恢复）。

ProviderStatus 覆盖全部七状态：not_submitted、waiting_for_user、
processing、artifact_available、succeeded、failed、cancelled。

矩阵必须客观定义：

- 哪些组合允许；
- 哪些组合幂等；
- 哪些组合为陈旧输入；
- 哪些组合为冲突；
- 哪些组合抛什么错误；
- 哪些组合不调用 Provider；
- 哪些组合调用 Provider 后生成更新；
- 终态是否允许重放；
- succeeded 后重复 collect 如何处理。

## GenerationTask 完整字段更新规则

正式设计必须对以下字段逐一定义更新规则：

- status；
- updated_at；
- completed_at；
- provider_id；
- external_task_ref；
- current_artifact_ref；
- error_summary。

对每个 ProviderStatus 和每个调用动作说明：保留 / 设置 / 清空 /
禁止改变、是否必须存在、值的来源、冲突时的错误类型。

必须遵守现有模型约束（TASK-002 交付，本任务只读）：

- GenerationTaskStatus 只有 pending / in_progress / done / failed
  四个值；
- **cancelled 没有直接项目状态**；
- **不能默认把 cancelled 当 failed**；
- 非 failed 状态不能保存 error_summary（模型不变量强制）；
- 终态必须满足 completed_at 不变量（终态必填、非终态禁止）。

正式设计若认为现有模型不足以表达映射：必须**停止**，明确提出模型
变更，通过独立审批；不得在 TASK-004 实现中修改 TASK-002 模型。

## Orchestrator 与 Provider 的职责表述

明确区分两个概念：

- **Provider-specific lifecycle operation**：单次生命周期操作的
  provider 内部语义（Manual 的人工说明生成、未来 Cloud 的远端
  调用、未来 Local 的本地推理）——属于 Provider，Orchestrator
  **不复制、不实现**；
- **Orchestration-level lifecycle policy**：编排级生命周期策略——
  属于 Orchestrator，包括：
  - 决定下一合法动作；
  - 调用哪个 Provider 方法；
  - 验证返回状态是否在允许集合内；
  - 拒绝非法或陈旧转换；
  - 映射项目级状态；
  - 生成或执行项目更新（按 persistence 定案）。

边界约束（延续 TASK-003 架构基线）：

- Provider 不扫描目录、不持久化项目状态；
- **Orchestrator 同样不得自动发现 artifact**——artifact 仍由调用
  方显式提供；
- Provider 契约（签名、状态矩阵、错误分类）在本任务中**只读**。

## 三层幂等性要求

正式设计必须**分别**定义三个层次的幂等性，不得合并为一句"重复
调用幂等"：

**层次 1：Provider 调用幂等性**

- 是否允许再次调用 prepare / submit / poll / collect；
- 哪些操作可能有外部副作用（未来 Cloud submit 等）；
- succeeded 后是否再次调用 collect；
- 如何防止重复 submit。

**层次 2：ProviderResult 应用幂等性**

- 相同 result snapshot 重复应用；
- 值相等但 identity 不同的 result；
- older / equal / newer observed_at 的各自处理；
- terminal result 重放；
- 相同 artifact 与冲突 artifact。

**层次 3：update plan / persistence 幂等性**

- 相同 plan 重复执行；
- 已执行 plan 再次执行；
- 目标状态已等于预期状态（no-op）；
- 原状态基线不匹配；
- plan 版本或 comparison baseline 不匹配。

正式设计必须为三个层次分别定义：幂等键、比较字段、当前基线、成功
结果、no-op、冲突、陈旧输入、错误类型；并至少包含以下判定矩阵：

- older timestamp；
- equal timestamp + equal payload；
- equal timestamp + conflicting payload；
- newer timestamp；
- terminal replay；
- succeeded 后重复 collect；
- equal artifact；
- conflicting artifact。

## 状态不可倒退与时间比较规则

"状态不可倒退"必须落为可测试规则。正式设计必须定义：

- 状态排序或合法转换图（哪些转换合法、哪些为倒退）；
- observed_at 比较规则；
- equal observed_at 的处理；
- payload 相同与冲突的区别（equal 时间下等价输入 = 幂等，冲突
  输入 = 拒绝）；
- terminal 状态不可逆规则；
- failed、cancelled、succeeded 的重放规则；
- artifact_available 与 succeeded 的区别性处理；
- waiting_for_user 的重复 poll；
- processing 到 waiting_for_user 是否允许（Provider 类型差异）；
- 旧 ProviderResult 的判定依据（时间序 / 状态序 / 两者结合）；
- 更新计划的 comparison baseline。

规格不接受仅写"拒绝旧结果"或"状态不可倒退"的设计。

## 恢复与失败边界

正式设计必须决定**恢复记录**是否包含以下每一项（逐项决定并说明
理由）：

ProviderRequest；ProviderResult；ProviderInstruction；
ArtifactReference；provider_id；task_id；shot_id；当前项目状态；
当前 manifest 状态；最后 applied observed_at；comparison baseline
或 version；最近已完成动作；下一合法动作；外部任务引用；错误信息；
完成时间。

并必须定义：

1. 重启输入来自哪里（何种持久化数据）；
2. 如何判断下一合法动作；
3. 如何防止重复 submit；
4. 如何识别已执行 collect；
5. 如何处理相同 snapshot 重放；
6. 如何处理陈旧 snapshot；
7. **Provider 调用已产生副作用、但项目状态 persistence 失败时
   怎么办**；
8. **persistence 成功但调用方未收到返回时怎么办**；
9. 是否需要 operation ID、result fingerprint 或 version baseline；
10. TASK-004 不实现事务和并发，但必须定义最小失败边界。

规格不接受仅写"重启后可恢复"的设计。

## 用户任务说明文件边界

区分两层：

**A. ProviderInstruction 数据生成**

- 已属于 Provider（TASK-003 交付）；
- TASK-004 可读取和传递；
- 可作为 update plan 或展示数据的一部分。

**B. 说明文件写入**

- 属于 persistence / I/O 决策；
- 是否纳入 TASK-004 取决于最终 architecture / persistence 方案
  （与"persistence 与 architecture.md 的关系"定案联动）；
- 即使允许写说明文件，也不得：扫描 artifact、自动发现文件、读取
  媒体、创建正式资产、扩大到 VideoAsset。

正式设计必须明确说明文件的：生成者、写入执行者、路径决定者、更新
时点、重启恢复关系。

## 必须解决但本轮不得定案的设计问题

以下问题必须在正式设计文档中逐项决定并说明理由，经 Codex 预实施
审查通过后方可编码；本任务卡只列出问题，不预先定案：

1. Orchestrator 是无状态服务还是有状态对象？
2. 每次调用是否显式传入当前 ProjectData、GenerationTask、
   StepManifest 和 ProviderResult？
3. persistence 责任边界：方案 A / B / C 三选一（见"persistence 与
   architecture.md 的关系"），状态变更决策权与 I/O 执行者分别
   定案；
4. ProviderResult 是否需要成为正式恢复数据？（TASK-003 持久化
   边界明确 ProviderResult 不是第八个核心模型、是否正式序列化留给
   首个需要方——本任务即首个需要方，必须显式决定且不得静默扩大
   TASK-002 序列化注册表）
5. ProviderStatus（七状态）如何映射到 GenerationTaskStatus
   （四状态）？逐状态定案（含 waiting_for_user、artifact_available
   的映射与 cancelled 在不违反模型不变量前提下的表达）；
6. GenerationTask 逐字段更新矩阵（见对应章节）；
7. StepManifest 完整设计问题：如何选择需要更新的 StepManifest；
   当前模型没有 task_id、shot_id、provider_id 时使用什么关联键；
   是否依赖 step_name；ProjectData 中 manifest 与 GenerationTask
   的关系如何确定；每个 ProviderStatus 如何映射到 ManifestStatus
   （waiting_for_user / processing / artifact_available /
   succeeded / failed / cancelled 各自的表达）；output_paths、
   output_metadata、completed_at、error_summary 如何更新；是否
   返回新的不可变 StepManifest；是否允许修改原对象。
   既有约束必须遵守：**StepManifest 没有 task_id 或 shot_id**；
   **COMPLETED 强制要求非空 output_paths**；TASK-004 不创建正式
   资产路径，**不能为了表示 Provider succeeded 而虚构正式 output
   path**。如现有 StepManifest 无法表达 TASK-004 的项目状态，
   必须在设计阶段明确提出，模型变更需要独立批准，不得实施时自行
   猜测；
8. 三层幂等性的幂等键、比较字段与判定矩阵（见对应章节）；
9. 状态不可倒退与时间比较规则（见对应章节）；
10. 恢复记录内容、下一动作判定与重复 submit 防护（见"恢复与失败
    边界"第 1—6、9 项）；
11. Provider 副作用与 persistence 失败的最小失败边界（见"恢复与
    失败边界"第 7、8、10 项）；
12. 冲突与错误分类：Orchestrator 层错误类型体系及其与
    ProviderError 子树的关系；
13. 如何保证 Orchestrator 不访问 artifact / 媒体文件、不扫描目录
    （实现约束 + 测试手段，可复用 TASK-003 的禁令测试模式，且不
    误禁定案方案所需的项目状态 persistence I/O）；
14. 用户任务说明数据与文件写入边界（见对应章节）；
15. 单元测试与集成测试的边界划分。

## 优先评估的责任边界（推荐方案，非定案）

设计文档应优先评估以下方案；采纳与否及理由须经预实施审查确认，
不得在规格阶段直接定案：

- Orchestrator 负责纯编排和状态更新计算；
- 调用方或 Orchestrator 边界内的受控执行层负责持久化（按方案
  A / B / C 定案）；
- 当前 ProjectData、GenerationTask、StepManifest 和 ProviderResult
  由调用方显式传入；
- Orchestrator 返回新的不可变对象或明确的 update plan；
- 不在对象内部保存隐藏生命周期状态；
- 所有时间显式传入（不读时钟）；
- artifact reference 显式传入（不发现文件）；
- VideoAsset 创建和媒体验证保留给后续任务（固定规格约束）。

## 与数据模型、persistence 和未来任务的边界

- GenerationTask / StepManifest 的字段与不变量以 TASK-002 交付为
  准，本任务不修改这两个模型（如映射方案确需模型变更，必须停止并
  提出独立审批）；
- 不修改 `serialization.py` 七模型注册表的既有条目；ProviderResult
  的正式序列化决定见设计问题第 4 项；
- persistence 模块（原子写入、默认拒绝覆盖）以 TASK-002 交付为准，
  只允许作为消费方使用；
- collect 成功后的 ArtifactReference 作为显式输出交接给阶段 3
  （固定规格约束第 4 条）；
- QCD 原始事件采集留给后续任务；本任务的状态迁移设计不得阻碍未来
  事件采集（不嵌入 QCD 数据，见 architecture.md §10）。

## 验收标准

以下 20 条标准在实施完成后必须客观可验证（通过测试或文件检查），
审查 Agent 不读取任何聊天记录即可独立验收：

1. 职责分离：Orchestrator 不复制 provider-specific 操作语义、不
   实现 Manual / 云端 / 本地 Provider 内部行为；编排级生命周期
   策略（下一合法动作、调用方法选择、返回状态验证、非法与陈旧
   转换拒绝、项目状态映射、更新生成或执行）全部由 Orchestrator
   承担；Provider 契约未被修改；
2. 文件系统边界：Orchestrator 对 artifact / 媒体文件与目录扫描
   零访问，测试拦截 open / exists / glob / rglob / walk /
   listdir / scandir 于产物路径场景（monkeypatch 局部作用域）；
   测试不得误禁最终批准方案所需的项目状态 persistence I/O；
3. 无隐藏时间：不调用 `datetime.now()` 或任何时钟，所有时间显式
   传入，有测试；
4. 无隐藏可变状态：编排所需上下文全部来自显式输入或定案的持久化
   数据，无实例级隐藏生命周期状态，有测试；
5. 编排矩阵落地：设计定案的"当前项目状态 × 调用动作 × Provider
   返回状态"完整矩阵在实现与测试中全覆盖，无未定义组合，非法组合
   被类型化错误拒绝；
6. 不可倒退与时间比较：older / equal / newer observed_at、equal
   timestamp 下相同与冲突 payload、终态重放、comparison baseline
   的规则全部落地并有测试；
7. 关联关系：不得假设 StepManifest 有 task_id；设计定义的
   GenerationTask、StepManifest、ProviderRequest、ProviderResult、
   update plan 之间可验证关联关系全部落地并有测试；
8. waiting_for_user 的项目级映射符合设计定案并有测试；
9. artifact_available 的项目级映射符合设计定案并有测试；
10. succeeded 的项目级映射（含 ArtifactReference 作为显式输出的
    交接点）符合设计定案并有测试；
11. failed 的项目级映射（error_summary、completed_at）符合设计
    定案并有测试；
12. cancelled 的项目级表达符合设计定案（不违反 TASK-002 模型
    不变量、不得默认当 failed）并有测试；
13. Provider 调用幂等性（层次 1）：重复 prepare / submit / poll /
    collect 的允许性、副作用防护与重复 submit 防护符合定案并有
    测试；
14. ProviderResult 应用幂等性（层次 2）：相同 snapshot、等值异体
    result、older / equal / newer observed_at、终态重放、相同与
    冲突 artifact 的判定矩阵全部有测试；
15. update plan / persistence 幂等性与冲突（层次 3）：重复执行、
    no-op、基线不匹配、版本不匹配的行为符合定案并有测试；
16. 映射完整：七个 ProviderStatus 到 GenerationTask 与
    StepManifest 的**逐字段矩阵**全部有定义且有测试，无未定义
    分支；
17. persistence 边界：定案方案（A / B / C 之一）落地；状态变更
    决策权与 I/O 执行者在实现中明确可辨；如定案与 architecture.md
    原表述不一致，architecture.md 已在最终设计批准前完成同步（有
    提交证据）；
18. 恢复与失败边界：恢复记录清单、下一动作判定、重复 submit
    防护、已执行 collect 识别、Provider 副作用后 persistence 失败
    的处理、comparison / version baseline 全部符合定案并有测试；
19. 无越界实现：未创建 VideoAsset、未转换或登记正式资产、未实现
    媒体校验 / FFmpeg / ffprobe / QCD 写入 / artifact 目录扫描 /
    网络访问；
20. 质量门槛：全部新增测试与现有测试通过、Ruff format 与 lint
    全绿、`git diff` 文件范围检查通过；如涉及 architecture.md 或
    模型变更，附独立审批证据。

## 编码门槛

以下 20 项按顺序全部满足后，coding gate 才改为 open；在此之前保持
closed：

1. TASK-004 修订规格通过 Codex 复审；
2. 正式设计文档完成；
3. persistence 责任边界定案（方案 A / B / C 三选一）；
4. 状态变更决策权和实际 I/O 执行者定案；
5. "当前项目状态 × 动作 × Provider 返回状态"完整矩阵完成；
6. GenerationTask 逐字段更新矩阵完成；
7. StepManifest 选择键、状态映射和字段矩阵完成；
8. 幂等性三个层次定案；
9. 状态不可倒退和时间比较规则定案；
10. 恢复记录、下一动作判定和重复 submit 防护定案；
11. Provider 副作用与 persistence 失败边界定案；
12. 用户任务说明数据与文件写入边界定案；
13. TASK-004 不创建 VideoAsset、不转换正式资产的固定边界确认；
14. 所需模型变更（如有）已经单独批准；
15. 若设计与 architecture.md 冲突，architecture.md 已在最终设计
    批准前完成最小同步；
16. Codex 对最终设计审查通过；
17. implementation agent 明确；
18. implementation review agent 明确；
19. 确认无提前实现代码；
20. coding gate 最后才改为 open。

## 预计影响文件

以下为**候选**，不视为已批准的固定设计，最终结构由设计文档确定：

- 已新增（规格复审通过后，Revision r6 已获批准）：
  `docs/design/TASK-004-provider-orchestrator-design.md`
- 新增（设计通过后）：`src/ai_video_workflow/orchestration/` 下的
  模块与 `tests/` 下的对应测试（具体拆分由设计文档提出）
- 修改（实施阶段）：本任务卡（状态更新、实施记录、验收证据）
- 视设计定案而定：architecture.md §3 最小同步修订（须在最终设计
  批准前完成，独立文档动作）
- 不修改：六核心模型、StepManifest、`serialization.py` 注册表既有
  条目、`persistence.py`、providers 包全部五个文件、
  TASK-001/002/003 文档、ADR-0001、README、pyproject.toml
  （模型变更如确有必要，走独立审批，不在本清单内静默发生）

## 审查记录

- specification agent: Claude Code
- specification review agent: Codex
- 第一轮规格审查：不通过（1 个阻塞、6 个重要问题）；修订版逐项
  关闭——正式资产边界固定、persistence 决策权 / I/O 执行分离与
  三方案比较、完整编排矩阵要求、GenerationTask 逐字段规则、
  StepManifest 设计问题与既有约束、三层幂等性、可测试不可倒退
  规则、恢复与失败边界、说明文件双层边界、验收标准与编码门槛
  同步修订；
- 最终规格复审（Codex）：
  - specification review result: passed
  - specification review baseline:
    TASK-004-provider-orchestrator-foundation.md revised
    specification；branch baseline:
    `01ac984 docs: complete TASK-003 implementation`
  - final specification findings: blockers 0 / important findings 0 /
    suggestions 0
  - closed findings:
    - VideoAsset/formal asset boundary contradiction closed
    - architecture/persistence responsibility issue closed
    - StepManifest design requirements completed
    - lifecycle and field matrix requirements completed
    - three-layer idempotency and no-regression requirements
      completed
    - recovery and failure-boundary requirements completed
    - coding gate requirements completed
  - next permitted activity: create formal TASK-004 design document
  - still prohibited: Python implementation; test implementation;
    architecture modification before the selected design requires
    it; opening the coding gate
- implementation agent: not assigned until design approval
- implementation review agent: Codex
- TASK-003 completed baseline:
  `01ac984 docs: complete TASK-003 implementation`
- 正式设计审查（Codex，Revision r6）：
  - formal design review: **passed**（此前 r1–r5 五轮修订：r1 五
    阻塞四重要、r2 二阻塞三重要、r3 三阻塞四重要一建议、r4 一
    阻塞三重要、r5 三阻塞一重要，全部逐项关闭）
  - design blockers: 0；important findings: 0；suggestions: 0
  - approved design document:
    `docs/design/TASK-004-provider-orchestrator-design.md`
    （Revision r6）
  - specification approval: satisfied
  - CANCELLED design prerequisite: satisfied
  - CANCELLED code implementation: **completed in Step M**
    （committed `8d691ba`；历史：r6 设计批准时为 not started）
  - ADR-0001 prerequisite approval: satisfied
  - ADR-0001 actual synchronization: **satisfied**
  - ADR-0001 narrow review（Codex）: **passed**（ADR blockers: 0；
    ADR important findings: 0；suggestions: 0）
  - architecture synchronization: not required
  - implementation agent assignment: **satisfied — Claude Code**
  - independent review agent: **Codex**
  - coding gate: **open**

**Step M — GenerationTaskStatus.CANCELLED model evolution：
completed**：

  - independent review: **passed**（第一轮有条件通过——唯一重要
    问题为 legacy 序列化兼容测试只覆盖 PENDING，已参数化修复为
    四个旧状态双路径覆盖；第二轮通过）
  - blockers: 0；important findings: 0；suggestions: 0
  - production files: `src/ai_video_workflow/models.py`
  - test files: `tests/test_models.py`、`tests/test_serialization.py`
  - full regression: **775 passed**

**Step A — orchestration errors / enums / canonical JSON /
fingerprint / freeze utilities：completed**：

  - implementation: completed
  - independent review: **passed**（blockers: 0；important
    findings: 0；suggestions: 0）
  - production files:
    `src/ai_video_workflow/orchestration/__init__.py`、
    `errors.py`、`models.py`、`canonical.py`
  - test files: `tests/test_orchestration_models.py`、
    `tests/test_orchestration_canonical.py`
  - full regression（提交轮实际执行）: **899 passed**

**实施顺序阻塞记录（2026-07-26）**：

- Step B 实施启动时发现：已批准 r6 设计缺少 Step B–G 的正式
  implementation allocation（§21 只有按文件的 ownership plan；
  §22 的 131 项测试无 Step 字母归属；任务卡只记录 M→A→B→C→D→
  E→F→G 顺序）；
- 未保留任何 Python 试验代码；工作区已恢复干净
  （HEAD `884081c`，full pytest 899 passed）；
- 澄清为 docs-only：设计文档新增 §24（Step B–G 正式名称、文件
  分配、§22 测试编号 1–131 完整映射、文件归属矩阵、模块依赖
  顺序），不改变 r6 已批准技术合同，不新增/删除/弱化验收标准；
- coding gate 整体保持 open；
- Step B 的实施许可在 §24 澄清通过 Codex 独立设计复审、作为
  独立 docs-only 提交完成、工作区恢复干净并发出新的 Step B
  checkpoint 之前**暂停**。

**sequencing clarification 复审记录（第三次，passed；历史
记录——记录 clarification 提交轮 `5f8faf8` 当时的状态，其中
"Step B implementation: not started" 等条目不代表当前状态，
当前状态见下方 Step B 完成记录）**：

- sequencing clarification review: **passed**（第一、二次复审
  为有条件通过，三个重要问题——当前状态与历史快照冲突、
  Step M pytest case 数、gate/whitespace/checkpoint 纪律——
  已逐项关闭）
- blockers: 0；important findings: 0；suggestions: 0
- sequencing clarification: **satisfied**
- sequencing clarification docs-only commit: `5f8faf8`
  （docs: clarify TASK-004 implementation sequencing）
- global coding gate: open
- Step B implementation: not started（本轮不开始 Step B；不得
  在本提交轮创建 Python 文件）
- Step B next condition: clean worktree after this commit plus
  a new explicit checkpoint（global gate open 不代表可绕过
  checkpoint）
- TASK-004 尚未完成。

**Step B — durable record 数据合同与严格恢复解析：completed**：

- implementation: completed（Claude Code；independent review
  agent: Codex）
- independent review: **passed**（blockers: 0；important
  findings: 0；suggestions: 0；第一轮不通过的三阻塞一重要——
  stable=null 未限定首次 prepare 动作、strict parser 接受语义
  无效日历时间、wrapper 未强制 nested JSON-only、stable schema
  version 未显式恢复——已逐项修复关闭）
- production files:
  `src/ai_video_workflow/orchestration/canonical.py`（追加）、
  `src/ai_video_workflow/orchestration/_models.py`、
  `src/ai_video_workflow/orchestration/recovery.py`
- test files: `tests/test_orchestration_canonical.py`、
  `tests/test_orchestration_models.py`
- §22 design entries: Step B 归属的 44 项已客观覆盖
- focused pytest: **368 passed**；related regression:
  **611 passed**；full regression: **1143 passed**

**Step C — instruction 逐字节渲染器：completed**：

- implementation: completed（Claude Code；independent review
  agent: Codex）
- independent review: **passed**（blockers: 0；important
  findings: 0；suggestions: 0；第一轮有条件通过的两个重要
  问题——renderer 过度拒绝合法文本、fence 注入测试未用真正
  三反引号载荷——已修复关闭）
- production file:
  `src/ai_video_workflow/orchestration/instructions.py`
- test file: `tests/test_orchestration_canonical.py`
- §22 entries: 111–113 covered
- focused pytest: **169 passed**；related regression:
  **631 passed**；full regression: **1189 passed**
- Step C pytest case increase: 46（初次实现 35 + 审查缺口修复
  11；与 3 个 §22 设计条目不是同一计数单位）
- cumulative implemented §22 entries: **52 / 131**（A 5 +
  B 44 + C 3）

**Step D — 纯 planning core：completed, independently reviewed,
committed, and finally confirmed**：

- implementation: completed（Claude Code；independent review
  agent: Codex）
- commit: `172ae2b feat: add pure orchestration planner`
- **final post-commit review: passed**（final design
  conformance: confirmed；blockers 0 / important 0 /
  suggestions 1）
- suggestion（唯一，非阻塞）: Step E 允许开始条件未显式包含
  "Step D final post-commit review 必须先通过"——已由本次
  docs-only 状态同步显式补齐，使 Step E start gate 完全
  自包含
- **historical review record（历史，已被 final post-commit
  review passed 取代，不是当前 gate 状态）**：第一轮不通过
  （4 阻塞 2 重要，已逐项修复并补负例）；第二轮有条件通过
  （blockers 0 / important 1——`instruction_before_text` 输入
  未获设计批准）；instruction carry-over 契约经两轮 docs-only
  修订正式化（第一次修订窄范围复审不通过的两处边界矛盾已由
  第二次修订消解），代码按最终契约对齐（含 stable 下
  before == committed 全等校验与 ABSENT 情形负例）
- production files: `orchestration/planning.py`（新建）、
  `orchestration/_models.py`（追加 `_ExecutablePlan`）、
  `orchestration/canonical.py`（追加 §16.3 preimage）
- test files: `tests/test_orchestration_planning.py`（新建）、
  `tests/test_orchestration_models.py`（一次性授权的 temporal
  guard 更新）
- §22 entries: Step D 归属的 14 项已客观覆盖
- focused pytest: **159 passed**；full regression:
  **1348 passed**
- Step D pytest case increase: 159（初次 139 + 审查修复 15 +
  carry-over 收口 5；与 14 个 §22 设计条目不是同一计数单位）
- cumulative implemented §22 entries: **66 / 131**（A 5 +
  B 44 + C 3 + D 14）

**Step E — `_LayoutResolver` 路径派生与安全校验：completed,
independently reviewed, committed, and finally confirmed**：

- implementation: completed（Claude Code）
- commit: `db5e178 feat: add safe orchestration layout resolver`
- temporary independent review: **passed**（temporary
  reviewer: Claude Fable 5，非 Codex；blockers 0 / important 0）
- **final Codex path-security review: passed**（reviewer:
  Codex；blockers 0 / important 0 / suggestions 1 non-blocking）
- **Step E final high-risk gate: closed**；**Step E final
  completion: confirmed**
- suggestion（唯一，non-blocking）：`layout.py` 中关于未来
  docs-sync 的过期注释；behavior impact none；security impact
  none；current disposition = **deferred cleanup**（理由：保持
  最终复审过的 `db5e178` 代码内容不变；不作为
  blocker/important/Step F 前置条件）
- **historical review record（已被 final Codex review passed
  取代，不是当前 gate 状态）**：第一轮临时审查 1 阻塞 2 重要
  （symlink + `..` 绕过整目录保护、symlink 自环 RuntimeError
  逃逸、"逃出允许根"两读法）已逐项修复并补负例；"逃出允许根"
  按保护优先读法经 §8.3 合同澄清定案，`_LayoutResolver` 接口
  经 §8.1 入档；"Codex final review pending / high-risk gate
  not yet closed"历史状态已被本轮 final review passed 取代
- production file: `orchestration/layout.py`（新建）
- test file: `tests/test_orchestration_layout.py`（新建）
- §8.1 `_LayoutResolver` 接口入档、§8.3 合同澄清随提交完成
- §22 entries: Step E 归属的 11 项（95–105）已客观覆盖并最终
  确认
- focused pytest: **75 passed**；related regression:
  **574 passed**；full regression: **1423 passed**
- Step E pytest case increase: 75（初次 68 + 修复轮 7；与 11 个
  §22 设计条目不是同一计数单位）
- cumulative implemented §22 entries: **77 / 131**（A 5 +
  B 44 + C 3 + D 14 + E 11；已完成并最终确认的累计数量，
  TASK-004 尚未完成）

**Step F — `_FileOrchestrationExecutor`（WAL/CAS/恢复执行）：
completed, independently reviewed, committed, and finally
confirmed**：

- implementation: completed（Claude Code）
- commit: `ef038ba feat: add orchestration file executor`
- production files: `orchestration/executor.py`（新建）、
  `orchestration/recovery.py`（仅追加 §14 phase-recovery 与
  §13.5 trace 分类，未改动 Step B parser/adapter 语义）
- test file: `tests/test_orchestration_executor.py`（新建）
- **Codex final review: passed**（reviewer: Codex；blockers 0 /
  important 0 / suggestions 0）
- **Step F high-risk gate: closed**；**Step F final completion:
  confirmed**
- 五个原阻塞最终关闭：①durable-intent CAS / identity / replay：
  closed；②read-time strict durable-record parsing：closed；
  ③clean STABLE committed-state S1：closed；④unified read/write
  symlink and per-component containment：closed；⑤durable phase
  landing and RECOVERY_REQUIRED coverage：closed。
- 最终窄范围重要问题：Provider-call 完整内容 CAS closed；
  read-time per-component containment closed；cached layout 后
  parent 被替换成 symlink 时 `_read_state_file` 保守拒绝；旧
  leaf-only 行为可错误读取 root 外 task 的缺口已由真实回归测试
  锁定并修复（test setup 顺序：先取得合法 `_StateLayout`，
  再替换 parent symlink，再使用缓存 layout 调用正式读取路径）。
- Provider 边界：Step F executor 永不调用 Provider（Provider
  调用与整体接线属 Step G）；outcome unknown 不自动重试
  Provider；recovery fingerprint-authoritative，confirmed_writes
  仅为 advisory hint；Step F 不实现 Step G facade。
- **historical review record（已被 Codex final review passed
  取代，不是当前 gate 状态）**：第一轮复审不通过（5 阻塞）；
  修复轮关闭 5 阻塞后仍有 3 阻塞 + 1 重要；再修复关闭全部阻塞
  后剩 1 重要（read-path 回归测试未锁定修复）；最终窄范围复审
  在 test setup 顺序修正并经独立验证后 passed
- §22 entries: Step F 归属的 20 项（25、26、27、29、56、64、
  65、66、67、71、73、77、86、106、107、108、109、110、114、
  128）已客观覆盖并最终确认
- focused pytest: **81 passed**；full regression:
  **1504 passed**；Ruff format 53 files already formatted；
  Ruff lint All checks passed；whitespace passed
- Step F pytest case count: 81（与 20 个 §22 设计条目不是同一
  计数单位）
- cumulative implemented §22 entries: **97 / 131**（A 5 +
  B 44 + C 3 + D 14 + E 11 + F 20；已完成并最终确认的累计数量，
  TASK-004 尚未完成）

**实施顺序状态**：

| Step | 正式名称（§24） | 状态 | 允许开始条件 |
| --- | --- | --- | --- |
| M | GenerationTaskStatus.CANCELLED model evolution | completed | —（已提交并通过独立审查） |
| A | orchestration errors / enums / canonical JSON / fingerprint / freeze utilities | completed | —（已提交并通过独立审查） |
| B | durable record 数据合同与严格恢复解析 | completed（`261ebbd`；已通过独立审查） | —（已完成） |
| C | instruction 逐字节渲染器 | completed（`71c77f5`；已通过独立审查） | —（已完成） |
| D | 纯 planning core | completed（`172ae2b`；final post-commit review passed；finally confirmed） | —（已完成） |
| E | `_LayoutResolver` 路径派生与安全校验 | **completed（`db5e178`；final Codex path-security review passed；high-risk gate closed；finally confirmed）** | —（已完成） |
| F | `_FileOrchestrationExecutor`（WAL/CAS/恢复执行） | **completed（`ef038ba`；Codex final review passed；blockers 0 / important 0 / suggestions 0；high-risk gate closed；finally confirmed）** | —（已完成） |
| G | 公开 orchestrator facade 与端到端集成 | not started；**next permitted step**；**Step G local gate closed** | ①Step F implementation commit 完成（`ef038ba`）；②**Step F Codex final review 已通过**（0/0/0）；③五个原阻塞与最终窄范围重要问题均已关闭；④Step F high-risk gate 已关闭；⑤Step F 最终完成确认；⑥本次 docs-only 最终状态同步提交完成；⑦提交后工作区干净；⑧用户发出新的明确 Step G checkpoint（全部满足） |

TASK-004 尚未完成；不声称全部 acceptance criteria 已实现；不声称
131 项计划测试已全部实现。

- 只能从 Step M 开始，不得跳过 Step M；
- 不得并行开始 A–G；
- 每一步必须遵循设计中的允许文件范围；
- 每一步完成后运行规定测试并交 Codex 独立审查；
- 未通过当前 Step 审查不得进入下一 Step；
- Claude Code 按批准 r6 设计分步实施，不得替代 Codex 声称独立
  审查通过；Codex 不直接修改实现文件。

## 当前状态

implementation in progress — Steps M–F completed and finally
confirmed — Step G not started (local gate closed; pending new
explicit checkpoint)

## 尚待后续任务决定的事项

以下明确不在 TASK-004 解决：

- 媒体探测与校验（ffprobe）、正式路径决策、文件移动或复制、版本
  管理、VideoAsset 创建、正式资产登记（固定规格约束第 5 条，
  阶段 3）；
- FFmpeg 合成（阶段 4）；
- QCD 原始事件采集与事件日志格式；
- `input_digest` / `relevant_config_digest` 计算与自动断点续跑的
  digest 匹配；
- Cloud / Local Provider 及其编排差异（含真实外部副作用下的
  submit 幂等性扩展）；
- 用户失败报告与取消输入渠道、取消传播、超时策略；
- 事务与并发控制、后台队列、网络重试；
- CLI / UI 入口；
- Provider 注册表、配置驱动的 Provider 选择与自动路由（阶段 9）。
