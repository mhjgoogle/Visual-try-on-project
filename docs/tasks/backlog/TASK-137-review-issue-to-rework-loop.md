# TASK-137：审片问题进入返工队列 —— 从问题定位到重新审片的闭环

- 状态：**待开始**（2026-09-05 开卡；没有 Agent 在做）
- Workflow：Feature · 深度：DEEP（审片合同、行动状态与交付闸门跨层，行为改动需独立审查）
- 实施 Agent：待 Claude 接手；Codex 本次完成上游研究与本项目适配说明。
- 依据：用户 2026-09-05 要求参考
  [AI Video Production Editor](https://github.com/LudwigKienle/ai-video-production-editor/tree/2e47f42a86ccf30641c22be4662891f0a2ed8e7c)
  的架构与 UI，并写给 Claude 的落地说明。
- 关联缺口：[TASK-087 §5.9、§5.10、§5.21](../active/TASK-087-followup-ledger.md)；
  [创作者系统合同 §6、§8](../../design/creator-system-contract.md)。
- 架构约束：`CA §1–5`；统一 `Run`、统一 `Action`、Command Gateway、版本身份、三层审片与
  G3/G4/G5 均保持权威，不增加平行状态机。
- 用户目标：审片时指出一个具体问题后，产品能说明它影响哪些镜头、把返工放进现有行动队列，
  替换素材后要求重新审片；人工标记的阻断问题不能被导出绕过。

## 1. 研究边界与证据

上游源码固定在 commit
[`2e47f42`](https://github.com/LudwigKienle/ai-video-production-editor/commit/2e47f42a86ccf30641c22be4662891f0a2ed8e7c)
（2026-09-03），本次检查了 README、First 10 Minutes、Capability Map、产品/UI/协作说明、
`workspaceNav.ts`、`types.ts`、Project Hub、Requests、Review、Edit、Activity Center 与六张界面图。
没有安装或运行上游应用；界面判断来自仓库截图和源码，运行稳定性、真实性能与多人协作能力未实测。
上游许可证为 GPL-3.0-or-later：本卡只借产品模式与合同形状，实施时独立编写，不复制其源码或视觉资产。

它的主流程是：

`剧本 → 导演概念 → 分镜 → AI 拍摄 → 连贯性审片 → 补拍队列 → 剪辑 → 导出`

对本项目最有价值的是“审片不是终点，而是返工入口”。其他可借内容必须落到本项目已有权威对象上。

## 2. 哪些值得借，落到哪里

| 上游做法 | 本项目落点 | 决定 |
| --- | --- | --- |
| Project Hub 显示完成度、阻断项和唯一 Next Best Step | [TASK-135](TASK-135-server-authoritative-workflow-plan.md) 的服务端 `steps[] / blockers[] / next_action` | **借 UI 表达，不在本卡重复实现。** 放进现有项目/分集画布，不新增 Hub 页面；百分比只有权威计划能算时才显示 |
| Review 中给镜头、首尾帧或素材写问题，Requests 汇总受影响镜头并形成补拍任务 | 现有 `ReviewIssue` + `Action` + `locatedShotId` + 版本身份 | **本卡优先实现。** 这是最短且完整的用户价值切片 |
| Edit Agent 先生成计划，逐操作显示 before/after、理由、风险和置信度；用户勾选后一次应用并能整批撤销 | 统一 Action 表、ArtifactVersion、未来时间线编辑命令 | **保留为后续任务。** 等 TASK-127 的 Action 表成为唯一真相后再做，不引入 `EditPlan` 第二总账 |
| 生成前显示 Prompt / Engine / Frame Guide / API / Cost 是否就绪 | 生成命令预检、Provider 能力、付费授权与费用估算 | **可后续借 UI。** 实际付费仍遵守 AGENTS 的唯一人工闸；“估算可见”不等于“允许扣费” |
| Activity Center 汇总 generation / export / agent task 的进度、耗时、取消和失败 | 持久 `Run` 查询的投影视图 | **只借视图。** 不新建 `StudioAgentTask`、轮询器或第二份任务状态 |
| 生成结果可一键提升为 Reference / Moodboard / Start / End | `ArtifactVersion` + `Binding` + 既有 apply outlet | **借“结果进入明确角色”的交互。** 不让 UI 直接保存 URL 或覆盖旧版本 |
| 导出页先给平台预设和 Clips / Timeline / Frame / Tracks 摘要，再展开高级规格 | 权威 `deliverySpec` + G4/G5 | **可后续借渐进披露。** 预设只改规格草稿，不能绕过质检或用户确认 |

## 3. 可借的 UI 与不能照搬的部分

值得借：

1. **一眼知道下一步。** Project Hub 顶部只给一个 Next Best Step，下面再解释哪些输入已就绪、
   哪些被阻断；比让用户阅读所有节点更直接。
2. **稳定的工作区角色。** 生成页是左侧参数、右侧最新结果/历史/素材库；剪辑页是素材、监看与时间线、
   上下文 Agent。它与本项目现有三栏结构兼容，不需要重新导航。
3. **先预览后执行。** Edit Agent 把每个操作的原因、前后值、风险和是否可执行摊开，用户只应用勾选项，
   然后整批撤销。这是未来让 Agent 改时间线时应遵守的交互合同。
4. **问题会变成工作。** Review 标记问题后，Requests 明确列出受影响镜头和 open / in progress / done，
   避免意见只停留在评论文本里。
5. **付费前有准备度。** 生成按钮旁直接呈现引擎、参考帧、API 和预计费用，缺项时不让按钮假装可用。

不能照搬：

1. 上游有 23 个 workspace、Simple / Standard / Pro 三种模式、五组导航及组内标签，层级过多。
   本项目已经冻结 11 页、三空间、Story 四入口与 Episode 单画布；不得为借鉴而新增页面。
2. 上游多个 workspace 是超大组件（Project Hub 约 1.8 万行）；本项目应把领域计算、查询、命令与薄 UI
   分开，不能继续把规则塞进页面文件。
3. 上游协作架构文档包含目标态；它自己也说明可靠 Action layer 和真正多人实时编辑仍不完整。
   不能把设计文档当成已验证能力。
4. 上游 Review 与 Requests 都有按角色名、环境名或 prompt 文本找受影响镜头的逻辑，并以 shot number
   做部分关联。这里必须用结构化 ID / Binding / `shotId`；禁止字符串猜测与显示序号身份。
5. 不增加上游的 `StudioAgentTask`。本项目已有统一 `Run`；Activity、Agent 执行与生成都只能投影它。
6. 不复制其全局顶部栏、workspace 数、presence 条、组导航与子导航的多层占高，也不同时放右侧 Agent
   和浮动 AI Tools 两个重复入口。

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：在现有单镜/整集审片面增加“提出问题”；使用结构化身份计算并预览受影响镜头；
经现有 Gateway 写 `ReviewIssue` 和 `Action`；把返工显示为 Episode 画布中的 Action 过滤视图；
修复持久化 delivery blocking issue 可绕过 G4；素材版本变化后触发 G3 并回到重新审片。

**OUT OF SCOPE**：新增 Review/Requests/Project Hub 顶级页面；实现 23-workspace 导航；新任务模型；
按 prompt 文本猜受影响镜头；Node Editor；完整 NLE/OTIO/FCPXML/VFX handoff；新的 Provider 或付费调用；
时间线 Agent 批量编辑；多人实时协作。

## 5. 给 Claude 的落地顺序

### A. 先修导出闸门这个阻塞缺陷

在暴露“提出问题”入口之前，先闭合 TASK-087 §5.21：G4 在确认 QC report 与当前候选版本绑定之后，
同时考虑持久 `reviews.issues` 中 `layer === "delivery" && state === "open" && severity === "blocking"`
的项目。最终返回全部阻断 issueId 与可读原因；不要把人工问题复制进 QCReport 形成第二份记录。

必须钉住：没有报告、报告属于旧候选、自动 QC 有 blocker、持久人工 issue 有 blocker、问题 resolved 后、
新候选使旧报告失效。任何调用 `g4Export` / `exportability` 的入口都得到同一结论。

### B. 做一个领域级“影响镜头解析器”

输入是一条已校验的 ReviewIssue 目标和当前权威项目投影，输出稳定且排序确定的 `affectedShotIds[]`、
解析依据及无法解析的原因。规则从窄到宽：

1. shot issue 只指向它的 `targetId`；episode issue 至少包含必填的 `locatedShotId`；
2. 若问题明确关联角色、场景、道具或素材，沿现有结构化 ID / Binding 找引用它的镜头；
3. 没有结构化关系时只保留已明确的镜头，不扫描 prompt、不按名字猜、不把空结果伪装成“全片受影响”；
4. 输出只是计算结果，不单独持久化成第二份镜头清单；项目变化后重新计算，并在创建 Action 时把采用的
   shotId 与依据记入 Action 参数/证据。

解析器属于领域/查询层。Review 页和返工队列不得各复制一份匹配逻辑。

### C. 在现有审片面增加最小入口

优先在 `dailies.js` 的逐镜“通过 / 撤销通过”附近增加 **提出问题**，并在整集审片复用同一表单：

- 默认带入当前 `shotId`、当前审看的 `assetId + version` 或 rough-cut 版本、正确 layer/target；
- 用户选择合同已有 category、severity 并写原文；Agent 也可提交 Issue，但不能生成 Decision；
- 提交前显示“将影响 N 个镜头”及镜头列表；无法扩散时明确“只记录当前镜头”；
- 保存成功只说“问题已记录”，不说“已返工”或“已解决”；失败保留原文，可重试；
- 卡片显示 open/resolved/ignored 与版本依据，点击可回到镜头；blocking 与 warning 视觉强度不同。

不要新增独立 Requests 页面。Episode 单画布顶部显示 `待返工 N`，点击后把现有镜头列表过滤为有关 Action；
右侧 Agent 对话继续负责解释、提案和执行。TASK-135 上线后，这些 open blocker / Action 由同一服务端计划
进入 `blockers[]` 与唯一 `next_action`，前端不再自己推下一步。

### D. 用已有 Action 接住问题

“创建返工”经 Command Gateway 使用现有 `create-feedback` / `create-action` 能力，为选定的
`affectedShotIds` 创建可追溯 Action；状态迁移只走 `action-transition`。至少保留
`sourceIssueId`、`shotId`、目标版本/素材身份、原因与创建者。不要另建 request/task 状态表。

一个 Issue 可影响多个镜头，一个镜头也可有多个 Issue；实现要明确映射关系，不能靠标题去重。
Action 完成不自动把 Issue 改成 resolved：返工产物完成后状态应是“等待重新审”，由用户审看新版本后
解决问题或作出 Decision。Agent 仍可提出 Issue，不能替用户通过。

### E. 闭合版本与重新审片

替换 confirmed video、调整 TimelineClip 顺序/入出点等既有 G3 触发项继续在领域层把整集结论改为
`needs_rereview`。返工 Action 完成后，UI 打开准确的新版本；旧 Issue 与旧 Action 保留追溯，不能静默改绑
到新素材。用户确认问题解决并重新通过后，队列清零；若仍有 open blocker，下一步仍是返工/复审。

## 6. 验收例子

1. 在真实 Connected Project 的某镜头视频上提出 `character / blocking` 问题，保存后能从问题回到同一
   `shotId` 与被审版本；嵌套列表排序后不会跳到另一个镜头。
2. 角色由三条镜头通过结构化身份引用时，预览准确列出三条；另一个同名角色不被选中；没有结构化关系时
   诚实退回当前镜头。
3. 创建返工后，Episode 画布显示三个既有 Action；刷新/重启后仍在，状态迁移走统一 Action 表。
4. 一条 Action 完成不会自动解决 Issue；新视频确认后触发 G3，整集显示“需要重新审”。
5. `delivery / blocking / open` 的人工问题会阻止当前候选导出；resolved 后只在当前版本 QC 仍有效且无其他
   blocker 时放行。旧版本报告不能给新候选放行。
6. Agent 能提出 Issue、解释受影响镜头并建议返工，不能产生 `passed` Decision，也不能绕过付费确认。
7. UI 仍是既有 11 页/三空间/单 Episode 画布，没有新增 Review、Requests 或 Activity 状态总账。

## 7. 验证与收口

- 开工用 `dev-workflow` 将本卡移入 `active/`，补 Requirement delta 与必要的合同/ADR；技术决策由实施
  Agent 依 AGENTS 授权自行收口，不把选择题退给用户。
- 前端测试覆盖表单、影响预览、过滤队列和诚实状态；backend/studio 覆盖 Issue/Action 持久化与命令；
  contract 覆盖 G4 合并两类问题及版本绑定；真实浏览器用 TASK-130 Connected Project 走完整旅程。
- 这会改行为、合同、持久化、身份和导出闸门，按 AGENTS §20 做一次独立四闸审查；实现交接前跑最终
  集成检查。验证“提出问题”不需要触发任何付费生成。
- 收口时分别更新 TASK-087 §5.9、§5.10、§5.21 的证据；若只做 UI 而没修 G4，需求仍是 PARTIAL。

## 8. 本次研究交付状态

- 实现：尚未开始；本卡只完成研究、取舍与 Claude 实施说明。
- 已核实：上游固定 commit 的文档、关键类型/工作区源码、仓库截图与许可证；本仓库现有
  ReviewIssue、G3/G4、Action/Gateway 合同及 TASK-087 三个缺口。
- 未核实：上游应用运行质量、真实协作与大项目性能；不得据文档把它们描述为已验证能力。
