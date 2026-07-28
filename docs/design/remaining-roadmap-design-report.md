# 剩余 Roadmap 整体设计报告（供 Codex 一次性架构审查）

- 日期：2026-07-28
- 模式：batch milestone mode（用户决策：一次整体设计审查后连续
  实施，不再逐 Step 外部审查；实施审查合并到 milestone 回归门槛）
- 状态：**Remaining roadmap design complete — single Codex
  architecture review pending**
- 提取依据：AGENTS.md、product_spec、architecture、
  implementation_plan、ADR-0001、TASK-001–004 全部文档与当前源码
  /测试（HEAD `1c2f30b`，full pytest 1667 passed）。未凭空扩大
  产品范围；每项工作均可追溯到既有 roadmap 条目或 product_spec
  成功标准。

## 1. 剩余任务全集（机械提取）

| Task | 正式名称 | 来源 | Milestone |
| --- | --- | --- | --- |
| TASK-005 | 视频文件校验、VideoAsset 登记与 QCD 事件日志基础 | 阶段 3 全部 + architecture §10 事件基础设施 | M1 |
| TASK-006 | FFmpeg 按镜头顺序合成 | 阶段 4 全部 | M1 |
| TASK-007 | 任务生成 Bootstrap、工作流驱动与最小 CLI | 阶段 2 遗留（QCD 三事件、staging 分配、GenerationTask 持久化的创建侧）+ product_spec 成功标准 1/3/4 的「一条命令」要求 | M1 |
| TASK-008 | 字幕、配音与音频合成 | 阶段 5 全部 | M2 |
| TASK-009 | QCD 汇总、指标计算与报告 | 阶段 6 全部 | M2 |
| TASK-010 | 首个 CloudVideoProvider | 阶段 7 全部 | M3（阻塞） |
| TASK-011 | LocalVideoProvider | 阶段 8 全部 | M3（阻塞） |
| TASK-012 | 基于 QCD 的自动模型路由 | 阶段 9 全部 | M3（阻塞） |

提取说明（无凭空扩大范围的论证）：

- TASK-007 的 CLI 不是新功能诉求：product_spec 成功标准 1（程序
  能生成任务清单）、3（**一条命令**合成）、4（任一步骤中断续跑）
  要求存在可执行入口；TASK-004 显式把「CLI / UI 入口」列为遗留。
  bootstrap 是 architecture §3「Orchestrator 分配 staging 路径、
  持久化 GenerationTask」中未被 TASK-004 覆盖的创建侧（TASK-004
  要求 task/manifest 文件**预先存在**，但没有任何已完成任务负责
  创建它们——这是一个必须归属的缺口）。
- QCD 事件基础设施不属于任何已完成任务（TASK-003/004 均显式
  排除），按「首个写入方交付」原则归入 TASK-005。
- 阶段 5–9 均逐字来自 implementation_plan，无新增。

## 2. 依赖图

```
TASK-002 ── TASK-003 ── TASK-004 (Step G 待 Codex final review)
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  │
         TASK-005 ──────► TASK-006               │
        (qcd+digest 先行)     │                  │
              │               │                  │
              └───────┬───────┘                  │
                      ▼                          │
                  TASK-007 ◄─────────────────────┘
                 （端到端最小闭环 = M1 完成）
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
    TASK-008（依赖 006）        TASK-009（依赖 005+007 事件流）
        └────────── M2 ────────────┘
                      │
        TASK-010 ∥ TASK-011（依赖 003/004 + 端到端链路）
                      │
                  TASK-012（依赖 009 + 010|011 至少其一）
```

**可并行/连续实施判定**：

- TASK-005 内部先行落地 `qcd` 模块与 `digests` 工具（前两个
  commit）后：TASK-006 与 TASK-005 其余部分可并行；TASK-007 的
  bootstrap/driver 部分只依赖 TASK-004+qcd，可与 TASK-006 并行；
- 单实施 Agent 现实下推荐**严格串行** 005 → 006 → 007（依赖面
  最窄、集成测试逐层加高）；
- M2：TASK-008 ∥ TASK-009（零共享文件、零合同交叉）；
- M3：TASK-010 ∥ TASK-011，TASK-012 最后。

## 3. Milestone 划分与回归门槛

### M1「第一阶段最小闭环收官」= TASK-005 + 006 + 007

回归门槛（全部满足才宣告 M1 完成）：

1. full pytest 全绿（含既有 1667 项 + 新增）；
2. `ruff format --check` / `ruff check` 全绿；
3. `tests/test_minimal_loop.py` 端到端集成测试通过（示例项目 →
   init-tasks → 放置 fixture → report/collect → validate →
   compose → final MP4 + 完整事件流）；
4. product_spec 成功标准 1–5 逐条有客观测试证据（见 §6 验收
   矩阵）；
5. 一次 milestone 级独立审查（Codex）：范围 = M1 全部 diff，
   基线 = 本报告批准的合同；
6. ADR-0002 / ADR-0003 状态 Accepted；ADR-0001 第二次增补已
   提交；architecture.md §3 最小同步已完成（见 §7）。

### M2「音画增强与度量」= TASK-008 + 009

门槛：M1 门槛项 1/2 + M1 端到端测试保持通过（回归保护）+ 各自
集成测试 + 一次 milestone 级独立审查 + TASK-008 模型增补的独立
审批证据 + ADR-0001 第三次增补。

### M3「Provider 扩展与自动路由」= TASK-010 + 011 + 012

**未排期**：三卡均为 outline，被产品级决策阻塞（厂商选型/预算、
本地模型/硬件、路由权重）。解除阻塞后须先补聚焦设计与 ADR，再按
batch 模式实施。M3 不计入本次审查的实施承诺。

## 4. 文件 ownership 总表（新增部分）

| 路径 | Owner | 说明 |
| --- | --- | --- |
| `src/ai_video_workflow/inspection/*` | TASK-005 | MediaInspector + ffprobe |
| `src/ai_video_workflow/assets/*` | TASK-005 | 校验/登记/报告/step |
| `src/ai_video_workflow/qcd/{__init__,events,log}.py` | TASK-005 | 事件基础设施 |
| `src/ai_video_workflow/qcd/{aggregation,reporting}.py` | TASK-009 | 汇总（同包不同文件） |
| `src/ai_video_workflow/digests.py` | TASK-005 | 006/007 只读复用 |
| `src/ai_video_workflow/composition/*` | TASK-006 | TASK-008 经批准扩展点新增文件 |
| `src/ai_video_workflow/app/*`、`cli.py` | TASK-007 | TASK-009 一次性授权加子命令 |
| `src/ai_video_workflow/audio/*` | TASK-008 | |
| `providers/cloud_*.py`、`providers/local_*.py` | TASK-010/011 | |
| `pyproject.toml` scripts 入口一行 | TASK-007 一次性授权 | |
| `models.py`/`serialization.py` 两模型增补 | TASK-008 独立审批 | |

**冻结（任何剩余任务禁止修改既有合同）**：`models.py`、
`manifest.py`、`serialization.py` 既有条目、`persistence.py`、
`project_data.py`、`validation.py`、`errors.py` 既有类、
`providers/`（TASK-010/011 只新增文件）、`orchestration/` 全部。
上表列出的一次性授权是仅有的例外，范围逐字锁定。

## 5. Public API 变化汇总

- 新增包级 API：`inspection`（4 类 + 错误树）、`assets`
  （policy/report/validate/step + 错误树）、`qcd`
  （QcdEvent/QcdEventType/append_event/read_events；M2 增
  aggregate/report）、`digests`（2 函数）、`composition`
  （profile/plan/composer/step + 错误树）、`app`
  （bootstrap/driver）、CLI `ai-video-workflow` 九个子命令。
  精确形态见各任务卡 Public API 节。
- **零修改**：TASK-002 七模型序列化合同、TASK-003 providers 公开
  15 名称、TASK-004 orchestration 公开 28 名称。
- 错误全部继承 `AiVideoWorkflowError`，延续既有类型化错误分类
  原则。

## 6. 测试与验收矩阵（需求 → Task → 客观证据）

| 需求 | 来源 | Task | 证据（测试/检查） |
| --- | --- | --- | --- |
| 生成人工任务清单 | spec 成功标准 1 | 007 | test_bootstrap + test_minimal_loop 步骤 1 |
| 校验缺失/命名/格式/参数并报告 | 成功标准 2 | 005 | test_asset_validation、test_validation_step |
| 一条命令合成最终 MP4 | 成功标准 3 | 006+007 | test_cli(compose)、test_minimal_loop 步骤 4 |
| 全流程断点续跑、不静默覆盖 | 成功标准 4；arch §8/§9 | 005/006/007 | 各 step 幂等测试 + test_minimal_loop 步骤 5 |
| WSL2 venv 内可完成 | 成功标准 5 | 007 | README 命令 + CI 全量命令 |
| 仓库自足可续开发 | 成功标准 6 | 全部 | 本报告 + 任务卡（人工审阅项） |
| QCD 七类事件采集 | arch §10；plan 阶段 2–4 | 005/006/007 | test_qcd_* + 集成断言事件流 |
| 事件日志唯一事实来源/append-only | arch §10 | 005 | test_qcd_log（append-only、strict、去重） |
| Provider 不扫描/不写业务状态 | arch §3/§4 | 既有 | TASK-003 守卫测试持续生效 |
| 步骤独立执行/重跑 | AGENTS 11/12 | 005/006/007 | 每步独立 CLI 子命令 + 幂等测试 |
| 覆盖保护/版本化 | AGENTS 13；arch §9 | 005/006 | 防覆盖 + 版本递增测试 |
| ffprobe/ffmpeg 抽象 | AGENTS 8 延伸 | 005/006 | grep 边界检查 + 假实现测试；ADR-0002 |
| 新功能有测试/全绿交付 | AGENTS 19/20 | 全部 | milestone 回归门槛 |
| 字幕/配音混入成片 | plan 阶段 5 | 008 | 其集成测试（M2） |
| 三粒度 QCD 汇总可重算 | arch §10；plan 阶段 6 | 009 | 确定性重算测试（M2） |
| Provider 扩展零上层改动 | arch §5 | 010/011 | 端到端复用测试（M3） |
| 自动路由+人工覆盖 | plan 阶段 9 | 012 | （M3） |

## 7. 跨任务一致性检查结果

已检查项与结论：

1. **API 冲突**：无重名导出；`qcd` 包由 005/009 分文件共享，
   写入 API（events/log）与消费 API（aggregation/reporting）分离，
   合同单向依赖，无冲突。
2. **职责重复**：媒体校验只在 005；版本/覆盖策略在 005（资产）与
   006（输出）各管自己的目录，规则同源（arch §9），无重叠写入。
3. **未定义合同（已在本轮补定义）**：
   - staging 命名 `staging/shots/<task-id>.mp4`（bootstrap 分配，
     校验消费）——须写入 ADR-0001 第二次增补；
   - `reports/` 目录（validation/composition/qcd 三子目录）——
     ADR-0001 第二次增补；
   - 正式媒体命名 `assets/media/s<scene>_sh<shot>_v<N>.mp4`——
     ADR-0001 第二次增补（arch §7 已有示例，属定稿而非新增）；
   - `input_digest`/`relevant_config_digest` 算法（SHA-256 +
     canonical JSON）——arch §8 授权「首个实际使用方确定」，定于
     TASK-005。
4. **发现的两份文档张力（需最小同步，非合同矛盾）**：
   - architecture.md §3 将 Workflow Orchestrator 描述为单一
     「唯一写入者」；实际代码形态是一组步骤组件
     （ProviderOrchestrator + validation step + composition step
     + bootstrap/driver），每类业务文件仍各有唯一写入组件。需在
     M1 实施前对 §3 做最小措辞同步（「Workflow Orchestrator 是
     应用层角色，由以下步骤组件构成…」），不改变任何职责分配。
     ——这是本报告请求 Codex 确认的文档动作。
   - GenerationTask 在编排层 done 之后校验失败的表达：不回写
     任务状态，重做 = 新 GenerationTask（arch §2 已支持同 Shot
     多任务）。已写入 TASK-005/007 卡，请 Codex 确认该语义。
5. **无归属工作检查**：roadmap 各条目全部映射到 Task（§1 表）；
   未发现无法归属的工作。
6. **停止条件核查**：未触发「两份已批准合同直接矛盾」「公共 API
   无法机械确定」；触发「需要用户产品级取舍」的项全部隔离在
   M2 的 TASK-008（3 项假设已声明）与 M3（阻塞项逐条列出），
   不阻塞 M1。

## 8. 推荐实施顺序与预计 commits

顺序：**TASK-004 Step G Codex final review（并入本次整体审查）→
005 → 006 → 007 →（M1 milestone 审查）→ 008 ∥ 009 →（M2
milestone 审查）**。

**M1 commit 粒度（2026-07-28 gate 收口定案，替代早先 18–21 微步骤
计划）**：每个 commit 语义完整（可独立测试、可独立回退），目标
如下，允许因真实语义边界上下浮动 1 个：

| Task | commits | 内容（语义完整切分） |
| --- | --- | --- |
| 005 | 5 | ① digests + qcd 模块（含 payload 构造器与日志读写） ② inspection（ABC + ffprobe 实现） ③ 校验规则引擎 + ValidationCheck/报告 ④ 登记 + 导入 + 清理 ⑤ validation step + 集成测试 + 文档状态 |
| 006 | 4 | ① profile + 计划器 ② composer ABC + ffmpeg 实现 ③ composition step + 报告 + 事件 + 幂等 ④ 集成测试 + 文档状态 |
| 007 | 5 | ① contracts + clock + ids + bootstrap ② driver ③ cli + pyproject scripts ④ minimal-loop 集成（含 optional real smoke） ⑤ README + 文档状态 |
| 合计 M1 | 14（±1/Task） | |
| 008 | 5–6 | （M2，含模型增补独立审批提交） |
| 009 | 4–5 | （M2） |

**M1 测试策略定案**：

- **Mandatory CI（默认回归门槛）**：fake `MediaInspector`、fake
  `VideoComposer`、fake/manual Provider、fake-based 一条命令 CLI
  端到端（`tests/test_minimal_loop.py`）、crash/retry/幂等测试、
  CLI 退出码测试；CI 不要求安装真实 FFmpeg/ffprobe；
- **Optional real CLI smoke（非门槛）**：TASK-007 拥有——
  `pytest.mark.skipif`（工具不可用跳过）+ 显式环境开关
  `AI_VIDEO_WORKFLOW_REAL_TOOLS=1` + 最小受控媒体 fixture，仅验证
  完整命令序列可真实跑通，不做脆弱的编码字节等价断言
  （ADR-0002 第 4 条）；真实工具手工执行流程保留在 README。

## 9. 风险与未决问题

1. **TASK-004 Step G 的 Codex final review 仍 pending**——建议将
   其并入本次整体审查（同一次 Codex 会话先收口 Step G，再审本
   报告）；M1 实施以 Step G 收口为前置。
2. ffmpeg/ffprobe 环境依赖：WSL2 需 apt 安装；CI/回归不依赖真实
   工具（ADR-0002 第 4 条），风险限于冒烟层。
3. 事件缺失窗口（persistence 与事件发射之间崩溃）：ADR-0003 已
   知边界，靠 TASK-009 对账暴露；接受为第一阶段取舍。
4. 合成 v1 不做部分转码复用与混合规格缩放：性能/灵活性成本已
   记录（TASK-006），留待真实需求。
5. TASK-008 三项产品假设（用户提供音频、手工 SRT、默认软字幕）
   需用户在 M2 开始前裁决。
6. M3 全部阻塞于产品级决策（厂商/预算/本地模型/路由权重）。
7. 批量模式下实施期缺少逐 Step 外部审查：以 milestone 回归门槛
   + 冻结文件清单 + `git diff` 范围审计补偿；若 milestone 审查
   发现系统性偏离，回退为逐任务审查（显式回退条款）。

## 10. 请 Codex 重点审查的跨任务问题

1. QCD event_id 去重合同（写入方允许重复、读取方去重）是否接受
   （ADR-0003 第 4 条）——它决定 005/006/007/009 四个任务的幂等
   实现复杂度分配；
2. 校验失败不回写 done 任务、重做走新 GenerationTask 的语义
   （§7.4）是否与 TASK-004 状态机无隐性冲突；
3. bootstrap 创建 task/manifest 是否完整满足 TASK-004 全部进入
   前置条件（TASK-007 卡 data contracts 节 vs 设计文档 §9）；
4. `staging/shots/<task-id>.mp4` 单文件合同在「用户重试同一
   任务」场景下是否充分（内容变化由 digest 触发新版本登记）；
5. architecture.md §3 的「唯一写入者」最小同步措辞（§7.4）；
6. TASK-005 一个任务承载 inspection+assets+qcd+digests 四个新包
   的规模是否需要拆分（batch 模式下我们判断收益大于风险，因为
   qcd/digests 是 006/007 的硬前置）；
7. M1 回归门槛是否足以替代逐 Step 审查（§3、§9.7 回退条款）。

## 11. Step G 与 M1 合同修复轮（2026-07-28，本轮收口）

一次合并修复轮，关闭当前 Codex 对 TASK-004 Step G 与 M1 合同的全部
blocker/important。代码改动仅限 `orchestration/executor.py`、
`orchestration/orchestrator.py` 及其测试；其余为合同文档同步。

**Step G 编排代码（executor/orchestrator + tests）**：

- **集中化 committed-state S1 verifier**：`executor.verify_committed_state`
  （raise）与 `executor.committed_state_matches`（bool）是唯一的三
  指纹（committed task wrapper / manifest wrapper / instruction
  bytes）比较入口，复用 Step F 的安全读取、containment 与指纹语义；
  orchestrator 删除其重复的 `_committed_state_matches` 与
  `_snapshot_file_fingerprint` 导入。所有 action 路径在 **Provider
  调用、INTENT 写入、MAY_HAVE_STARTED 写入、apply intent 写入之前**
  完成 S1（仅当 durable record 含 stable snapshot 时）——覆盖 direct
  PREPARE/POLL/REPORT_ARTIFACT、SUBMIT/COLLECT、INTENT same-identity
  redrive、replay/no-op admission；漂移抛既有 `PartialCommitConflictError`，
  Provider 调用 0、无新 WAL、不修复 drift。
- **resume 校验顺序定案（7 步）**：① 静态 context ② caller
  snapshot-vs-disk（stale 优先于 malformed-record，经新增
  `executor.read_business_state` 在 record 解析前判定）③ strict record
  parse ④ request consistency ⑤ identity ⑥ stable-bearing S1 ⑦
  phase-specific classification；stable-bearing INTENT/MAY/UNKNOWN 均
  不绕过 S1（漂移→CONFLICT，report-only，不 durable mutation）；
  APPLYING 走 fingerprint-authoritative recover（P9→CONFLICT）；已落盘
  RECOVERY_REQUIRED 统一 MANUAL_RECONCILIATION；transient I/O 原样
  传播；resume 永不调用 Provider。
- **§22 62/63/87/116 强化**：direct→APPLYING 边界（apply intent 落
  盘后崩溃、Provider 一次、resume 仅本地恢复不重呼 Provider）；三个
  direct 崩溃点（Provider 前 / Provider 后 apply-intent 前 / apply
  intent 后部分提交）；13×7=91 格每格断言初始相位 + 公开入口 +
  精确结果/异常类别 + Provider 调用数 + 最终 durable 相位 +
  filesystem mutation；13 状态 resume 逐项锁定 phase/disposition/
  legal_actions/preferred/requires_manual/Provider 0/durable mutation/
  重复 resume。terminal-manifest guard 因 S1 前置成为纵深防御，改由
  直接单元测试覆盖。

**M1 合同文档（TASK-005/006/007、ADR-0001、总报告）**：

- **WorkflowDriver 输入合同（§4）**：显式依赖 `provider_id / provider
  / request_factory / inspector / composer / project_root / clock`；
  `ProviderRequestFactory` 为 TASK-007 拥有的正式 Protocol，用现有公开
  `Project/Shot/GenerationTask` 类型、无平行 DTO、纯函数（不读文件/不
  扫描/不碰 executor/不用 cwd/env/registry/不改输入）；初始
  `GenerationTask.provider_id` 恒 None，配置 provider_id 只用于选择/
  request 构造/config digest，durable binding 由首次成功 PREPARE 形成。
- **CLI 生命周期（§5）**：`init-tasks/prepare/submit/report-artifact/
  collect/validate/compose/status/create-redo-task/run`；`run` 固定
  顺序 bootstrap→prepare→submit→report-artifact→collect→validate→
  compose，Manual 下必须显式 artifact，不得从 NOT_SUBMITTED 直接
  report-artifact；mandatory fake E2E 与 optional real smoke 均走完整
  生命周期。
- **bootstrap 与 redo（§6）**：确定性 task identity；同身份 task 已存在
  （任一态）不自动新建；校验 companion 文件并补齐缺失；不等价→冲突；
  new attempt 仅经 `create-redo-task`（`redo_of_task_id` + 新 task_id +
  新 manifest + 新 operation identity），绝不基于「无未完成 task」自动
  redo。
- **status 范围（§7）**：只输出 `ResumeAssessment`（phase/disposition/
  legal_actions/preferred_next_action/requires_manual_reconciliation +
  一行诊断）；删除「展示资产/合成状态」承诺；不扫描、不读 private
  executor、不新增 record accessor、不推断资产/合成状态。
- **output_paths 全量（§8）**：TASK-005 output_paths = JSON 报告 +
  Markdown 报告 + 正式媒体 + VideoAsset 记录；TASK-006 = 合成媒体 +
  JSON 报告 + Markdown 报告；architecture §8 skip/no-op 逐一验证
  output_paths 全部文件。
- **多文件部分提交恢复（§9）**：十条规则（版本由 digest 决定、同
  operation 续用同版本、已发布匹配即复用、补齐缺失 QCD/manifest、确定
  event_id 允许等价重复、manifest 幂等、内容不匹配→conflict 不跳版、
  新版本仅限新 digest/profile/显式 redo、清理失败不回滚、no-replace
  始终有效）统一写入 ADR-0001 第二次增补、TASK-005、TASK-006、
  TASK-007/本报告。

**6 blockers + 3 important 映射（本轮关闭）**：

| # | 类别 | 关闭方式 |
| --- | --- | --- |
| B1 | Step G 集中 committed-state S1 verifier | executor 单一 verifier + 全 action 路径前置 S1；orchestrator 去重（代码 + 测试） |
| B2 | Step G resume 校验顺序 | 7 步定案 + read_business_state 分离 + 全 stable-bearing 相位 S1（代码 + 测试） |
| B3 | §22 62/63 direct-path APPLYING 边界与崩溃点 | 强化 entry 62/63（代码测试） |
| B4 | §22 87 13×7 六元组断言 | 91 格强化断言（测试） |
| B5 | §22 116 全 13 状态 resume 锁定 | 逐状态 resume 断言 + MAY/UNKNOWN 补齐（测试） |
| B6 | M1 多文件部分提交恢复未定义 | §9 十条规则统一入 ADR-0001/TASK-005/006/007/报告（文档） |
| I1 | WorkflowDriver 输入合同 / ProviderRequestFactory | §4 定案（TASK-007 + 报告） |
| I2 | CLI 生命周期与 run/redo | §5/§6 定案（TASK-007） |
| I3 | status 范围（ResumeAssessment-only） | §7 定案（TASK-007 + 报告） |

## 12. 状态

Step G and M1 contract fixes committed —
single Codex combined re-review pending
