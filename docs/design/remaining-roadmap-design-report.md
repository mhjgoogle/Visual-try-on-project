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

预计 commits（粒度对齐既有惯例：一功能一提交 + 文档同步）：

| Task | 预计 commits | 内容 |
| --- | --- | --- |
| 005 | 7–8 | ADR 定稿与 ADR-0001 增补 / digests / qcd 模块 / inspection / 校验规则 / 登记+导入 / step+报告 / 文档状态 |
| 006 | 5–6 | profile+plan / composer+ffmpeg / step+报告+事件 / 集成测试 / 文档 |
| 007 | 6–7 | bootstrap / driver / clock+ids / cli / minimal-loop 集成 / README+pyproject / 文档 |
| 008 | 5–6 | （M2，含模型增补独立审批提交） |
| 009 | 4–5 | （M2） |
| 合计 M1 | ≈ 18–21 | |

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

## 11. 状态

Remaining roadmap design complete —
single Codex architecture review pending
