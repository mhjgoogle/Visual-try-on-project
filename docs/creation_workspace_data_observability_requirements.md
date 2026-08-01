# Creation Workspace 数据可观察性要求

> **状态：Draft（WFM1 readiness baseline）。**
> 本文定义核心工作流为未来只读 Creation Workspace 必须保留的**语义信息**，
> 不定义最终 JSON schema、目录、数据库、API 或 UI。实现仍由 TASK-018～023
> 各自的批准设计决定；任何新增物理路径或冻结合同变更仍须单独 ADR。

## 1. 目的

核心工作流完成后，未来观察层必须能够仅从权威业务文件和 append-only 事件回答：

- 项目计划是什么，现在进行到哪里，为什么等待/失败/阻塞/跳过；
- 某个创意、提示词、图片、视频或成片来自哪些输入，被哪些下游使用；
- 某次运行使用了哪个版本、Provider、模型和参数，产生了哪些结果；
- 预计、预留和实际花费分别是多少，失败与重试花了多少；
- 用户为什么选择、放弃、批准或重做某个版本；
- projection/cache 删除后，以上视图是否可确定性重建。

如果信息只存在于 CLI 文本、日志、异常、文件名约定或 Agent 对话中，则不算满足。

## 2. 术语与边界

- **权威事实**：由现有唯一写入者按正式合同持久化的业务文件或 append-only 事件。
- **Projection**：从权威事实派生的查询结果、索引、缓存或未来数据库，可删除重建。
- **Ref**：对象稳定身份，不等同于显示名称或当前文件路径。
- **Version**：同一逻辑对象的不可变修订序号或等价版本身份。
- **Content digest**：对版本内容的确定性摘要，用于审批、Action 和命令绑定。
- **Lineage**：输入、生成、选择、替代、装配、评价和发布之间的可追溯关系。
- **Run/operation**：一次可计费或有外部副作用的执行身份；不得与对象版本混用。

本文不创建新的通用 Entity、Event、Graph 或 Action 模型，也不要求把所有信息写入
同一个文件。各领域保持现有唯一写入者，未来 query service 负责组合。

## 3. 通用可观察性规则

### 3.1 身份与版本

1. 可被审批、生成、选择、评价、发布或 Action 引用的对象必须有稳定 ref。
2. 可修改内容必须形成新 version 或新对象，不原地覆盖已批准/已消费版本。
3. 每个可消费版本必须有 content digest；显示名和路径变化不得改变逻辑身份。
4. 版本关系至少能表达前一版或替代来源，并保留修改原因；不要求现在固定字段名。
5. 对外部资源不能只保存临时 URL；必须同时保留内部 ref、来源和必要审计信息。

### 3.2 状态与时间

1. “计划定义”和“运行实例”分离：项目未运行也能显示完整阶段/步骤计划。
2. 每个状态必须属于明确语义域：阶段审批、运行、Provider、reservation、Action
   不得复用同一枚举冒充统一状态。
3. 非成功状态必须有结构化 reason/category 和可定位对象，不只保存自由文本。
4. 状态转换保留带时区时间和触发来源；派生“当前状态”必须可由权威记录验证。
5. skip、retry、redo、fallback、cancel 和人工终止必须可区分，不得都记为 failed。

### 3.3 输入、输出与谱系

1. 每次确定性编译或执行记录其精确输入 refs/versions/digests 和输出 refs。
2. 每个正式产物必须能反查 producing step/task/operation；不得存在无来源孤儿产物。
3. 每个输入必须能查询直接下游消费者；谱系要求双向可查询，但可只存一向、派生另一向。
4. redo/fallback 产生新 task/operation；旧关系保留，不原地改写历史。
5. 选择结果必须保留候选集合、选中对象和选择理由；未选结果不能静默消失。

### 3.4 参数、Provider 与成本

1. 运行绑定 provider、model、能力、参数版本/digest 和 catalog identity/digest。
2. quote、estimate、reservation、actual 是不同语义，不得合并成单一 `cost`。
3. actual 继续使用整数原币事实；JPY、累计值和筛选结果均为可重算派生值。
4. 成本必须能关联 project/stage/step/shot/task/operation/provider/model/time；允许通过
   稳定关系派生，不要求在成本事件中重复所有维度。
5. failed、retry、redo、fallback 和 ambiguous operation 的占额/实际成本可单独识别。

### 3.5 评价、决定与问题

1. 评价绑定目标 `ref + version + content_digest`，并区分用户与 AI 辅助来源。
2. 评分、标签、建议、pass/fail 和选择/放弃理由不能只存在于 Markdown 描述中；
   可保留 Markdown 正文，但须有可定位的结构化索引或 manifest。
3. 创作决定记录“改了什么、为什么、预期改善、实际结果和增量成本/时间”。
4. 运行错误和 QC 问题必须绑定项目、阶段/步骤、任务/operation 和对象版本上下文。
5. WFM1 只保留问题与决定证据，不提前实现未来 Action 状态机。

### 3.6 安全与隐私

- credential 值、Authorization header、私有下载 URL 和敏感响应不得进入 projection；
- 面向用户的错误可定位但必须脱敏；
- 读取 projection 不得绕过项目 containment 或扩展现有凭据权限；
- projection 重建为只读过程，不反向修复或修改权威业务状态。

## 4. 最小语义覆盖矩阵

| 领域 | 必须可观察的语义 | 权威来源/写入边界 | WFM1 责任 |
| --- | --- | --- | --- |
| Project / goals | project ref、profile version/digest、目标、预算引用、创建状态 | project/profile 文件 | TASK-018 |
| Reusable asset | asset ref、version/digest、来源、项目引用、替代关系 | reuse package + project ref | TASK-018 |
| Workflow plan | stage/step stable id、依赖、预期输入输出、是否允许 skip | stage registry + project profile | TASK-019 |
| Stage approval | stage status、target refs/versions/digests、审批人/时间、失效原因 | approval v2 + change audit | TASK-019 |
| Creative/prompt version | 内容 ref/version/digest、parent、修改原因、参考资产 | planning artifacts/index | TASK-020 |
| Task packet | stage/step/shot、锁定输入、Provider/model/参数、P50/P90 | task packet + locked catalog | TASK-020 |
| Run/attempt | task/operation、状态/原因、外部 ref、时间、retry/redo/fallback 关系 | orchestration + reservation | TASK-021 |
| Generated artifact | artifact ref/version/digest、producer、输入、候选/选中、消费者 | asset records + lifecycle adapter | TASK-021 |
| Cost | quote、estimate、hold、actual 原币、FX、派生 JPY、失败/重试归属 | catalog/reservation/QCD events | TASK-015/016/021 |
| QC/evaluation | target binding、criterion、actor、score/tag、pass、建议 | QC/evaluation evidence | TASK-022 |
| Creative decision | 候选、选择/放弃、原因、预期/实际、增量成本时间 | decision evidence | TASK-022 |
| Release/postmortem | release inputs/digests、结果、指标来源、复用建议 | release/archive manifests | TASK-022 |
| Projection readiness | 完整计划、进度、谱系、成本、评价和问题可重建 | 只读验收 fixture | TASK-023 |

“权威来源/写入边界”只指定语义所有者，不授权新增路径或修改冻结 schema。

## 5. 谱系最低关系

未来查询至少要能表达以下关系；这是语义集合，不是现在锁定的枚举：

- version/supersedes：新版本来自或替代旧版本；
- derived-from：剧本、分镜、提示词或任务包来自哪些批准输入；
- uses-reference：prompt/task 使用哪些参考或复用资产；
- generated-by：结果由哪个 task/operation/provider/model 产生；
- selected-from：选中结果来自哪个候选批次；
- redo-of/fallback-of：新执行为何产生；
- assembled-from：镜头/音频/字幕如何组成成片；
- evaluated-against：评价绑定哪个目标版本和创作目标；
- released-as：母版形成哪个发布包版本。

## 6. 必须可回答的只读查询

TASK-023 的 readiness fixture 至少验证：

1. 新项目未运行时返回完整 stage/step 计划和依赖。
2. 返回项目当前阶段、整体/阶段进度、运行中及阻塞步骤和 reason。
3. 从任意正式产物向上追溯全部输入，向下查询直接消费者。
4. 对一个 prompt 返回版本链、差异依据、生成批次、全部结果、选中结果和后续
   产物；只要求覆盖 WFM1 已支持的产物类型，范围外类型显式标为 unavailable。
5. 对一个镜头返回所有 attempt/redo/fallback、Provider/model/参数、状态和时间。
6. 按阶段、步骤、镜头、Provider、模型和时间派生预计/实际/失败重试成本。
7. 对一个评价或决定返回精确目标版本、创作目标、结论和理由。
8. 返回最近错误/QC 问题及其项目、步骤、task/operation 和对象上下文。
9. 删除 projection/cache 后，从同一权威输入重建出语义等价、排序确定的结果。

## 7. 完整性与失败规则

- ref 缺失、版本不存在、digest 不匹配或谱系指向不存在对象：readiness 失败；
- paid operation 无法关联 quote/reservation/actual 或人工对账状态：readiness 失败；
- 正式 artifact 无 producer 或 task packet 无已批准输入：readiness 失败；
- 只有日志文本、异常消息或文件名可提供关键关系：readiness 失败；
- projection 与权威事实冲突：以权威事实为准并报告 projection 损坏，不自动回写；
- 历史数据确实不具备新语义时标记 `unavailable/legacy`，不得猜测补值。
- WFM1 未实现的图片、音频、字幕或 Action 数据标记为范围外，不得为了通过
  readiness 伪造记录，也不得反向扩大 TASK-018～023。

## 8. TASK-018～023 交接规则

1. TASK-018 输出稳定 project/asset identity，TASK-019/020 不另造项目或资产身份。
2. TASK-019 输出计划和 stage identity，TASK-020～022 统一引用这些 stage/step id。
3. TASK-020 输出 versioned planning refs 和 task packet identity，TASK-021 不从自由
   文本重新推断 prompt 或输入版本。
4. TASK-021 输出 operation/artifact/cost 谱系，TASK-022 只引用，不复制运行事实。
5. TASK-022 输出评价/决定/发布/复盘证据，TASK-023 只读验证，不创建第二事实。
6. 任一任务发现前序身份或关系不足时，应回到其 owner 任务修正，不在下游补一套映射。

## 9. 当前不决定

- 字段名、JSON 文件拆分、目录、schema version 和 Python 类型；
- graph database、relational database、搜索索引或文件扫描实现；
- query API、GraphQL/REST、前端 view model 或刷新策略；
- Action schema、跨项目知识 schema 和推荐算法；
- 对历史 M1 数据的完整迁移方案。
