# 范围外记录（Out of Scope）—— 我们决定不做的事

**这份文件只回答「什么我们不做，以及那个决定写在哪」（WHAT WE WON'T BUILD）。**
它是**索引，不是论证** —— 论证在每条「正式裁决」指针的那一头。

为什么需要它：97 份 ADR 里**没有一份是 Rejected**（[ADR-0087](adr/ADR-0087-document-lifecycle-and-default-agent-context.md)
定义了该状态但从未使用过），被否掉的方案都埋在各 ADR 内部的方案对比表里。
结果是同一个提议隔几周被重新提一遍，每次都要重新论证一次。缺的不是论证，是**入口**。

## 收什么、不收什么

判据是仓库现成的那条 —— [ADR-0010](adr/ADR-0010-creation-workspace-boundary.md) 明文裁定：
历史任务中的「本任务不做 Web UI / 数据库」是**有效的局部范围声明，不构成对未来的永久禁止**。

- **收**：永久边界 —— 产品级、架构级的决定，不随某张卡的开合而变。
- **不收**：任务卡的 `OUT OF SCOPE`、ADR 的「本轮不做」、`Not Decided Here`。
  那些是**排期**，收进来会立刻淹掉真正的边界（今天有 105 份卡带范围排除措辞）。
- **不收**：延后而非否决的东西（「等有使用数据再说」）—— 那是待办，归任务卡。

## 怎么用它

- **它不是引用句柄**，也不进 Review Package；句柄只有 `CA §N` 与 `REQ-NNN 判据 M`。
- **删除测试（加条目前自己跑一遍）**：把你要加的那条整条删掉，问「有没有任何一条规则因此
  消失？」有 → 你在抄裁决书，把论证留在 ADR 里，这里只留一行结论加指针。
- **重访条件写得出来才写**；写不出来就写「不重访」并说明它是承诺而非取舍 —— 空话比留白更糟。
- 边界被正式推翻时（新 ADR 取代旧裁决），**改这一行**，别在这里留历史 —— 历史归 ADR。

---

## 产品身份 —— 我们不是那个东西

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| 专业 NLE / 完整 DAW（Premiere · DaVinci 的替代品：节点、专业调色、多机位、插件、无限轨道） | [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) · [ADR-0063](adr/ADR-0063-creator-object-first-ia-and-shot-production-graph.md) | 不重访 —— 产品定位是 AI 短剧流水线 |
| 全局共享资产库（跨项目自动同步） | [ADR-0063](adr/ADR-0063-creator-object-first-ia-and-shot-production-graph.md) · [ADR-0059](adr/ADR-0059-production-graph-identity-contract.md) | 出现真实的跨项目复用需求，且先有统一的项目形状 |
| 白膜 previz 引入 3D 引擎 / 模型导入 / 骨骼 / 动捕 | [ADR-0094](adr/ADR-0094-greybox-previz-is-a-section-not-a-page.md) | 不重访 —— 白膜的定义就是「有身高的方块」 |

## 信息架构 —— 页面是闭集

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| 新增一级或二级页面（三空间 / 十一页是封闭集合；新增 Skill 也不例外） | [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) · [ADR-0067](adr/ADR-0067-product-skill-package.md) | 需要新的 IA ADR 整体重开，不能单点加页 |
| 新增一级 Tab | [ADR-0092](adr/ADR-0092-story-development-is-four-entries.md) · [ADR-0094](adr/ADR-0094-greybox-previz-is-a-section-not-a-page.md) | 同上（来源是产品负责人直接指令） |

## 数据所有权 —— 应用不动用户的东西

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| 应用删除用户文件（含软删除 / 回收区 / 彻底删除 / 批量移除 / 清运行历史） | [ADR-0090](adr/ADR-0090-project-removal-is-unregister-only.md)（标题即结论） | 不重访 —— 这是产品承诺：删除项目只从列表移除 |
| 静默覆盖用户文件与已有生成结果 | [AGENTS.md 第 13 条](../AGENTS.md) | 不重访 —— 合规路径是带版本的新路径 |
| 把 API key / 密码 / 生成的视频文件 / 本地凭据提交进 Git | [AGENTS.md 第 23 条](../AGENTS.md) | 不重访 |
| UI 审计抓图（像素）进 Git —— 清单、报告与脚本照进 | [项目背景「UI 差距审计工装」](project-context.md)（与第 23 条同一理由） | 不重访 |

## 花钱与自动化 —— 创作者掌控终稿与花费

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| 自行扩大付费授权（超出已 Accepted ADR 的窄范围） | [AGENTS.md 第 10 条](../AGENTS.md) · [ADR-0006](adr/ADR-0006-paid-api-boundary-lift.md) | 每次扩大都要一份新 ADR，且花钱这件事本身要问用户 |
| Agent 静默覆盖 / 静默定稿 / 静默付费 / 静默替用户完成审美决策 | [ADR-0066 决策 6](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)（四禁原文）· [创作者 IA](design/creator-product-information-architecture.md) | 不重访 —— 是核心价值主张 |
| Skill 按一次模型输出**偷偷**改自己 | [ADR-0056](adr/ADR-0056-local-ai-runtime-and-film-skills.md) | 不重访 —— 改进走 Proposal / 显式修订。注意 ADR-0056 对「自动 self-learning」写的是**本阶段**不做，那半是阶段性的、可重访 |
| 自动主观质量评分 | [ADR-0039](adr/ADR-0039-wfm2-postproduction-qc-release-contract.md) | 不重访 —— QC 是 Agent 辅助、用户下结论 |
| 自动优胜者选择 / 统计显著性判定 | [ADR-0034](adr/ADR-0034-evaluation-experiment-and-decision-contract.md) | 不重访 —— 同上，谁下结论是产品决定 |
| 按模板自动跑完整条流程 | [ADR-0084](adr/ADR-0084-project-flow-template-as-a-package.md) | 不重访 —— 那是自动化不是模板 |
| 自动决定要不要开工（在用户没看过的文本上动手） | [ADR-0093](adr/ADR-0093-approved-plans-build-themselves.md) | 不重访 —— 同意是他给的，不是模型推断的 |
| 商业发布平台 API / 剪辑软件（DaVinci 等）自动化 / 观众数据供应商接入 | [ADR-0039](adr/ADR-0039-wfm2-postproduction-qc-release-contract.md)（三项原文）· [ADR-0012](adr/ADR-0012-wfm1-stage-planning-release-paths.md)（WFM1 侧「发布平台集成」同调） | 出现明确的发布需求时另开 ADR |

## 分发与生态

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| Skill 市场 / 模板市场 / 远程安装 / 自动更新 | [ADR-0067](adr/ADR-0067-product-skill-package.md) · [ADR-0084](adr/ADR-0084-project-flow-template-as-a-package.md) | 出现真实的跨用户分发需求 |
| 用 junction / symlink 跨项目共享 Skill 包 | [ADR-0067](adr/ADR-0067-product-skill-package.md)（2026-08-16 补记，正面裁决「否」） | 不重访 —— 跨项目共享已有的机制是「用户来源」那一级 |
| Skill / Flow 三级来源的字段级合并 | [ADR-0067](adr/ADR-0067-product-skill-package.md) · [ADR-0084](adr/ADR-0084-project-flow-template-as-a-package.md) | 不重访 —— 半个项目半个内置的 Prompt 没人能预测它说了什么 |

## 架构边界

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| Creation Workspace 直连 Provider | [ADR-0010](adr/ADR-0010-creation-workspace-boundary.md) | 不重访 —— 它是表现层，不是第二个 Orchestrator |
| Workspace 做核心业务文件的第二写入者（绕过 Command Gateway） | [ADR-0010](adr/ADR-0010-creation-workspace-boundary.md) · [ADR-0033](adr/ADR-0033-command-gateway-contract.md) | 不重访；新的写能力按命令逐个开门 |
| 持久 projection / 数据库路径 | [ADR-0031](adr/ADR-0031-workspace-query-and-projection-contract.md) · [ADR-0036](adr/ADR-0036-cross-project-learning-and-recommendation.md) | 「可重建、不是第二事实源」不重访；「当前不建 DB」可由后续 ADR 解除 |
| 让 `workspace_shell` 认 Studio 项目（一个壳统管两种项目） | [ADR-0086](adr/ADR-0086-workspace-shell-serves-core-projects-only.md) | 先要有统一的项目形状，那是它自己的 ADR |
| 跨项目学习层训练模型 / 选向量库 / 跨账户共享 / 自动优化工作流 | [ADR-0036](adr/ADR-0036-cross-project-learning-and-recommendation.md) | 不重访 |
| Prompt 库（Prompt 身份是生成的快照） | [ADR-0052](adr/ADR-0052-workflow-page-as-derived-provenance-graph.md) | 复核后显式保留，不重访 |
| 参考指回画布节点（而非 Asset Registry） | [ADR-0071](adr/ADR-0071-reference-inputs-as-an-ordered-set.md) | 不重访 —— 这是身份模型的选择 |
| 资产的物理分类子目录 | [ADR-0055](adr/ADR-0055-unified-asset-registration.md) | 不重访 —— Registry 才是分类真源 |
| 第三个存储位置 | [ADR-0053](adr/ADR-0053-project-rooted-studio-storage.md) · [ADR-0066](adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md) | 不重访 |
| 硬编码分隔符 / 平台路径 / 平台专属 syscall；流水线与产品代码里用 PowerShell 或 CMD | [AGENTS.md 第 3–4 条](../AGENTS.md) · [ADR-0062](adr/ADR-0062-windows-authoritative-environment.md) | 不重访 —— 权威归 Windows 之后这条更要紧，不是更松 |
| 子目录 README（给 Agent 的规则写 AGENTS.md 或权威 docs） | [AGENTS.md 第 4 条](../AGENTS.md) | 不重访 —— 产品负责人 2026-08-22 直接指令 |

## 流程闸门

| 不做什么 | 正式裁决 | 重访条件 |
| --- | --- | --- |
| 新增「要用户离开对话手动操作」的规则（改配置 / 点 UI / 改环境变量才能推进） | [AGENTS.md 第 1 节](../AGENTS.md) | 不重访 —— 存量的如实告知并一次性解决 |
| 签字栏 / 产品签字闸 / merge 人工闸 | [ADR-0082](adr/ADR-0082-no-signoff-gate-on-task-cards.md) · [ADR-0085](adr/ADR-0085-merge-is-not-a-human-gate.md) | 不重访 —— 保留人工闸的只剩「花钱」一件 |
| 测试与审查的风险分级 | [AGENTS.md 第 20 条](../AGENTS.md) · [ADR-0080](adr/ADR-0080-test-ownership-and-gate-mapping.md) · [ADR-0081](adr/ADR-0081-review-by-impact-scope.md) | 不重访 —— ADR-0060 / 0069 被取代正是因为它 |
| 未经 ADR 提前实现 UI / Action Center / 数据库 / UI 专用状态机 / 泛化 `VideoProvider` | [AGENTS.md 第 4 节](../AGENTS.md) | 「先有 ADR」这条程序性边界不重访；它点名的具体条目可由对应 ADR 逐个解除 |
| 文档按年份或里程碑二级归档 / 每卡一个 metadata 文件 / traceability 数据库 | [ADR-0087](adr/ADR-0087-document-lifecycle-and-default-agent-context.md) · [ADR-0088](adr/ADR-0088-traceability-and-requirement-fulfillment-review.md) | 不重访 —— 三个状态目录，不再多 |
