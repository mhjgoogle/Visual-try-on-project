# ADR-0003: QCD Append-only Event Log Format

- Status: Accepted
- Date: 2026-07-28
- Accepted: 2026-07-28 — M1 gate 收口时随七类事件 payload schema 一并
  定稿（本次修订即第一次修订，payload 字段集为本 ADR 的一部分）。
- Revised (ADR-0008): 新增第八类 `provider_cost_recorded`（权威云成本事实）。
- Revised (TASK-008 / ADR-0039，2026-08-04): 新增第九类 `audiovisual_completed`
  （S5 音画装配 master 事实，见 §4.8）。仅扩展，不改动既有八类的 envelope、
  payload 键集或 event_id 派生；M1 `composition_completed` 及其消费计数不变。
- Scope tasks: TASK-005 (module + 3 events), TASK-006 (1 event),
  TASK-007 (3 events), TASK-009 (consumer), TASK-008 (audiovisual_completed)

## Context

architecture.md §10 规定 append-only QCD 事件日志是原始 QCD 事实
的唯一来源，第一阶段采集七类事件，阶段 6 做汇总。ADR-0001 已预留
`qcd/events/` 目录但未定义文件格式。事件由多个步骤组件在不同任务
中写入，需要一个跨任务稳定的写入合同。临时整体审查确认：仅定义
envelope 不足以让 TASK-005/006/007 的写入方与 TASK-009 的消费方
独立实施——七类事件的 payload 字段集本身是 durable 合同，必须在
实施前定案。

## Decision

1. **位置与形态**：单文件 `qcd/events/log.jsonl`（项目根相对）。
   JSON Lines：UTF-8、无 BOM、一行一个事件对象、`\n` 结尾、键
   排序、`ensure_ascii=False`（对齐 TASK-002 确定性 JSON 合同的
   单行变体）。
2. **append-only 语义**：只允许 `O_APPEND` 追加 + flush + fsync；
   任何组件不得截断、重写或删除既有行。追加不属于「覆盖已有
   文件」，不受默认防覆盖约束（本 ADR 显式授权）。
3. **事件 envelope**（全部事件统一）：

   ```json
   {
     "schema_version": 1,
     "event_id": "<见第 5 条派生表>",
     "event_type": "<七类之一>",
     "occurred_at": "<UTC ISO-8601，与 TASK-002 时间格式一致>",
     "project_id": "...",
     "shot_id": "... | null",
     "task_id": "... | null",
     "payload": { "...": "见第 4 条 per-type schema" }
   }
   ```

   M1 固定七种：`task_created`、`task_status_changed`、
   `manual_attempt_recorded`、`asset_imported`、
   `validation_completed`、`composition_completed`、
   `manual_quality_rating_recorded`；ADR-0008 修订加入第八类
   `provider_cost_recorded`，TASK-008/ADR-0039 修订加入第九类
   `audiovisual_completed`（§4.8）。新增类型须修订本 ADR。
4. **payload schema（per-type，durable 合同）**。通用规则：
   - 每类事件的 payload 键集**固定**：所列键全部必须出现；可空
     字段用显式 `null`，**不得省略键**；不得出现未列出的键；
   - 时长一律整数毫秒（`*_ms`，`int`）；未知为 `null`；
   - 货币金额一律整数最小货币单位（`cost_minor_units: int`）+
     ISO-4217 大写货币码（`currency: str`），两者同 `null` 或同
     非 `null`；**禁止浮点货币**；
   - `sha256` 一律 64 位小写十六进制字符串；
   - 路径一律项目根相对 POSIX 字符串；
   - payload 内如含时间戳，格式同 envelope `occurred_at`；
   - `elapsed_ms` 由**调用方显式提供**（核心库不读时钟，对齐
     TASK-004 时间权威规则），未知为 `null`。

   ### 4.1 `task_created`（writer: TASK-007 bootstrap / redo）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `initial_status` | str | 是 | 恒为 `"pending"`（GenerationTaskStatus.PENDING） |
   | `task_kind` | str | 是 | 恒为 `"generation"`（当前模型唯一任务种类） |
   | `configured_provider_id` | str | 是 | bootstrap 调用配置选定的 Provider；**不**写入初始 GenerationTask.provider_id（其必须为 None） |
   | `origin` | str | 是 | `"bootstrap"` \| `"redo"`（创建来源） |
   | `redo_of_task_id` | str \| null | 键必在 | redo 时为同 Shot 前序 task_id，否则 null |

   注：`task_created` **不含** `staging_ref`。bootstrap 只创建
   task/manifest，不写 staging_ref；staging 路径为
   `staging/shots/<task-id>.mp4` 的固定合同（ADR-0001 第二次增补），
   由 `ProviderRequestFactory` 在 prepare 时派生，不属于本事件。

   ### 4.2 `task_status_changed`（writer: TASK-007 driver）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `previous_status` | str | 是 | GenerationTaskStatus 值（`pending`/`in_progress`/`done`/`failed`/`cancelled`） |
   | `new_status` | str | 是 | 同上；仅在实际变化时发射（NO_OP 不发事件） |
   | `orchestration_action` | str | 是 | `prepare`/`submit`/`poll`/`report_artifact`/`collect`/`replay_result` |
   | `reason` | str | 是 | 变更类别；M1 固定 `"provider_transition"`（新增类别须修订本 ADR） |
   | `operation_id` | str | 是 | 触发本次 APPLIED 的编排操作身份（同 event_id 派生输入） |

   ### 4.3 `manual_attempt_recorded`（writer: TASK-007 driver）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `attempt_id` | str | 是 | uuid4（尝试身份） |
   | `provider_id` | str | 是 | 本次尝试对应 Provider |
   | `action` | str | 是 | M1 固定 `"manual_generation"`（人工在外部工具的一次制作尝试） |
   | `elapsed_ms` | int \| null | 键必在 | 尝试耗时，调用方显式提供 |
   | `cost_minor_units` | int \| null | 键必在 | 货币成本（最小货币单位） |
   | `currency` | str \| null | 键必在 | ISO-4217；与 cost_minor_units 同 null / 同非 null |
   | `outcome` | str | 是 | `"produced_candidate"` \| `"discarded"` \| `"unknown"` |
   | `note` | str \| null | 键必在 | 自由备注 |

   ### 4.4 `asset_imported`（writer: TASK-005 registration）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `asset_id` | str | 是 | `asset-<task-id>-v<version>`（TASK-005 合同） |
   | `asset_kind` | str | 是 | M1 固定 `"video"`（M2 扩展 audio/subtitle 须修订本 ADR） |
   | `sha256` | str | 是 | 导入媒体文件内容 SHA-256 |
   | `size_bytes` | int | 是 | 导入媒体字节数 |
   | `duration_ms` | int \| null | 键必在 | probe 可测时必填毫秒时长 |
   | `source_task_id` | str | 是 | 产出该媒体的 GenerationTask |
   | `source_attempt_id` | str \| null | 键必在 | 关联 manual attempt（M1 人工模式通常 null） |
   | `path` | str | 是 | 正式媒体项目根相对路径（`assets/media/...`） |
   | `version` | int | 是 | 资产版本号 |

   ### 4.5 `manual_quality_rating_recorded`（writer: TASK-005 库级 API；TASK-007 CLI 入口）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `rating_id` | str | 是 | uuid4（评分身份） |
   | `asset_id` | str \| null | 键必在 | 被评资产；未指向具体资产时 null（对 Shot 整体评分） |
   | `score` | int | 是 | 闭区间 [1, 5]，5 最优；越界为类型化错误 |
   | `scale` | str | 是 | 固定常量 `"m1-rating-1to5-v1"`（改刻度须修订本 ADR） |
   | `note` | str \| null | 键必在 | 自由备注 |

   ### 4.6 `validation_completed`（writer: TASK-005 validation step）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `passed` | bool | 是 | 整报告结论 |
   | `report_path` | str | 是 | `reports/validation/<task-id>_v<version>.json` |
   | `report_version` | int | 是 | 报告/资产版本号 `<version>` |
   | `checks_total` | int | 是 | ValidationCheck 总数 |
   | `checks_failed` | int | 是 | FAILED 检查数 |
   | `elapsed_ms` | int \| null | 键必在 | 校验耗时，调用方显式提供 |
   | `asset_id` | str \| null | 键必在 | 通过并登记时为资产 id；失败为 null |
   | `input_sha256` | str | 是 | 被检 staged 文件 SHA-256 |

   ### 4.7 `composition_completed`（writer: TASK-006 composition step）

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `output_path` | str | 是 | `outputs/final_v<N>.mp4` |
   | `output_version` | int | 是 | `<N>` |
   | `output_sha256` | str | 是 | 最终 MP4 内容 SHA-256（可追溯输出身份） |
   | `output_duration_ms` | int \| null | 键必在 | 成片时长（可测时必填） |
   | `input_asset_ids` | array[str] | 是 | 按镜头序有序的输入资产 id 列表 |
   | `entry_count` | int | 是 | `len(input_asset_ids)` |
   | `profile_digest` | str | 是 | CompositionProfile 的 config_digest |
   | `elapsed_ms` | int \| null | 键必在 | 合成耗时，调用方显式提供 |

   ### 4.8 `audiovisual_completed`（writer: TASK-008 audio-visual mux step）

   > 修订（TASK-008 / ADR-0039 clause 9，2026-08-04）新增的第九类事件。S5
   > 音画装配（配音/音效混音 + 字幕挂载/烧录）产出的成片 master 与视频-only 的
   > `composition_completed` 是**不同事实**（payload 结构与事实域不同），故按
   > 「新增类型须修订本 ADR」新增独立类型，而非复用 `composition_completed`。
   > M1 `composition_completed` 与其消费计数不受影响。

   | 键 | 类型 | 必填 | 语义 |
   | --- | --- | --- | --- |
   | `output_path` | str | 是 | `outputs/final_av_v<N>.mp4` |
   | `output_version` | int | 是 | `<N>`（音画 master 版本，独立序列） |
   | `output_sha256` | str | 是 | 音画成片内容 SHA-256（输出身份） |
   | `output_duration_ms` | int \| null | 键必在 | 成片时长（可测时必填） |
   | `base_video_path` | str | 是 | 输入的 M1 视频 master 路径 |
   | `base_video_sha256` | str | 是 | 该视频 master 内容摘要（精确输入引用） |
   | `audio_refs` | array[obj] | 是 | 混入的音频资产引用 `{media_kind, ref, version}` 有序列表 |
   | `audio_track_count` | int | 是 | `len(audio_refs)` |
   | `subtitle` | obj \| null | 键必在 | 字幕引用 `{ref, version, mode}`；无字幕记 `null`（≠ 空对象） |
   | `profile_digest` | str | 是 | AudioVisualProfile 的 config_digest |
   | `elapsed_ms` | int \| null | 键必在 | 混流耗时，调用方显式提供 |

5. **event_id 派生与去重**（全部确定性输入均为稳定 ID/摘要）：

   | 事件类型 | event_id 派生 | 幂等性来源 |
   | --- | --- | --- |
   | `task_created` | `task_created:<task_id>` | task_id 确定性 |
   | `task_status_changed` | `task_status_changed:<task_id>:<operation_id>` | 编排 operation 幂等 |
   | `manual_attempt_recorded` | `manual_attempt_recorded:<task_id>:<attempt_id>` | attempt_id = uuid4 |
   | `asset_imported` | `asset_imported:<project_id>:<shot_id>:<task_id>:<asset_id>:<sha256>` | 绑定事件类型 + 项目/镜头/任务身份 + 资产 id + 内容摘要；**同一资产的等价重复导入产生相同 event_id** |
   | `manual_quality_rating_recorded` | `manual_quality_rating_recorded:<shot_id>:<rating_id>` | rating_id = uuid4 |
   | `validation_completed` | `validation_completed:<task_id>:v<version>` | 版本确定性 |
   | `composition_completed` | `composition_completed:<project_id>:v<N>` | 版本确定性 |
   | `audiovisual_completed` | `audiovisual_completed:<project_id>:v<N>` | 版本确定性 |

   **日志中允许出现重复 event_id 的完整事件行**（断点续跑重放
   造成）；一切消费方必须按 event_id 去重（保留首行）。这是
   「写入方简单、读取方去重」的显式取舍。
6. **并发边界（M1 single-writer）**：M1 假定**单进程、单写入方**
   （工作流步骤串行执行）；本 ADR **不支持并发写入方**，并发写入
   属合同外行为。未来引入多进程/队列时须修订本 ADR。
7. **strict 读取与损坏行语义**：
   - **corrupt middle line**（以 `\n` 终止但不可解析、未知
     event_type 或 schema_version 不支持的行）→ 立即返回类型化
     错误并报告行号，**不静默跳过**（数据完整性优先于可用性）；
   - **torn final line**（文件末尾**不以 `\n` 终止**的不完整
     片段，崩溃中断 append 的预期产物）→ 读取器**仅可忽略这一个
     尾部片段**（视为从未写入；因确定性 event_id 事件可在重跑时
     幂等重发，随机 id 事件由调用方重录）；除此之外不得忽略任何
     内容；
   - **写入方 torn-tail 防护**：追加前若文件非空且末字节不是
     `\n`，写入方**拒绝追加**并返回类型化错误（禁止在 torn 片段
     后续写导致其变成 corrupt middle line）；
   - 读取器与写入器都**不得自动改写、修补或截断**原日志；人工
     修复/恢复工具不属于 M1 范围（需要时人工处理该尾部片段）。
8. **单一事实来源**：GenerationTask 等业务文件不嵌入 QCD 数据
   （architecture.md §2/§10 既有边界）；汇总（TASK-009）是派生
   数据，必须可由本日志重算；**TASK-009 只读本日志，绝不修改**。
9. **已知边界（记录，不在第一阶段解决）**：
   - 事件在业务 persistence 之后发射，两写入间崩溃会造成事件
     缺失；TASK-009 的对账检查负责暴露缺口，不做双写事务；
   - 单文件在极大项目下的体积问题留待真实出现时再分片（届时修订
     本 ADR），第一阶段不预先设计。

## TASK-009 aggregation 使用方式（消费合同）

- Delivery：`task_created.occurred_at` →（同 task 的）
  `asset_imported.occurred_at` 为任务级交付时长；
  `composition_completed.occurred_at` 为项目级成片时点；
- Quality：`manual_quality_rating_recorded`（score/scale，最新值按
  occurred_at + event_id 全序判定，均值按去重后事件集）、
  `validation_completed`（checks_failed / passed 失败率）、重做
  次数（同 shot 的 `task_created` 计数与 `origin="redo"`）；
- Cost：`manual_attempt_recorded` 计数、`elapsed_ms` 合计、
  `cost_minor_units`/`currency` 合计（M1 人工模式通常为 null，
  字段为 TASK-010 付费 Provider 预留）。

## Consequences

- 所有写入方共享一个小而稳定的 `append_event` API（TASK-005
  交付）；payload 构造器逐类型类型化，写入方不可能写出键集不符的
  事件；
- 消费方（阶段 6、未来路由）获得可重放、可去重、可对账的事实流，
  且不需要读任何业务文件即可计算三粒度指标的事件侧输入；
- 成本：读取方必须去重；缺失事件需对账发现；torn-tail 后的新写入
  被阻断，需人工移除尾部片段（接受为 M1 取舍）。

## Not decided here

- 指标定义与汇总算法的完整字段集（TASK-009 聚焦设计定案，输入
  合同以本 ADR 为准）；
- 货币成本的进一步细化（首个付费 Provider 任务，TASK-010）。
