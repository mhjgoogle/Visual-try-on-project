# TASK-107：文档与记录的统一生命周期 —— 落到规则、工装与现有文档上

- 状态：完成（2026-08-26）—— 实现完成、`tests/tooling` 全域绿、codex 三轮审查后
  本卡无未闭合 P1；提交 `712c7d4`（41 个文件）
- Workflow：Refactor · 深度：DEEP
- 关联 Requirement：[REQ-002](../../requirements/REQ-002-document-lifecycle.md)
- 关联 ADR：[ADR-0087](../../adr/ADR-0087-document-lifecycle-and-default-agent-context.md)
- 目标：把「当前事实精简 / 历史可追溯 / 完成记录不进默认上下文 / 一次性产物删除」
  变成**开发流程自动执行的规则**，而不是又一次性的目录整理。

## IN SCOPE

- 三分类（Current Truth / Historical Evidence / Temporary Artifact）与各记录
  类型的生命周期状态机（ADR-0087）；
- **当前架构合同**（WHAT IS TRUE NOW）单独成文，与 ADR（WHY / HISTORY）分开；
- 默认 Agent 上下文规则（默认加载什么、什么按需读）；
- 接进 dev-workflow（收敛检查 + Done 判定 + merge 前）与 auto-push 的既有节奏；
- 可执行的收敛守卫（`.claude/tools/lifecycle_check.py` + `tests/tooling/`）；
- 存量文档按分类迁移：ADR 取代关系补链、已完成记录归档、未开工卡移出 active。

## OUT OF SCOPE

- 不改任何产品行为、不动 `src/` 与 `mockups/` 的运行代码；
- 不新建文档数据库 / 知识管理系统 / 复杂 status engine；
- 不回填存量需求为 REQ（ADR-0076 的既有决定不变）；
- 不删除任何 ADR、任务卡或已完成记录（只改状态与位置）；
- 不动 `docs/implementation_plan.md` 的阶段路线内容（只修因移动产生的链接）。

## Impact Analysis

| 维度 | 影响 |
| --- | --- |
| 受影响模块 | 仅治理层：`AGENTS.md`、`docs/`、`.claude/skills/{dev-workflow,auto-push}`、`.claude/tools/` |
| API / 合同 | 无产品合同变化；变的是**文档合同**（哪份文件是当前事实） |
| 数据 | 无持久化 schema 变化 |
| 依赖 | 无新依赖 |
| 架构 | 新增 `docs/current-architecture.md` 作为当前架构事实入口（ADR 仍是唯一决策史） |
| 受影响测试 | `tests/tooling/`（docs status / docs links / plan-status 三个守卫 + 新增 lifecycle 守卫） |
| 文档 | 见下方迁移清单 |

## 架构影响

触发 architecture.md 的「新公共抽象」一条（新增一份被所有 Agent 依赖的当前
架构合同）。结论：不引入代码抽象，只把已散落在 ADR/design 里的当前事实**收口**
到一处；决策记录见 ADR-0087。

## 存量文档分类（2026-08-26 盘点，217 份 md）

| 分类 | 内容 | 处置 |
| --- | --- | --- |
| KEEP_CURRENT | `AGENTS.md`、`README.md`、`docs/project-context.md`、`docs/product_spec.md`、`docs/architecture.md`、`docs/design/` 根七份合同、`docs/requirements/`、`docs/adr/` 全部 70 条 | 原地保留；新增 `docs/current-architecture.md` 作为当前事实入口 |
| ARCHIVE | `design/active/final-unified-milestone-review.md`（2026-08-04 已完成的评审记录）、`design/active/creation-workspace-implementation-roadmap.md`（WSM0–WSM3 已完成的规划基线）、`pending-codex-rereview.md` 的**已闭合历史**（35KB 中的 ~33KB） | 移入 `docs/design/done/` |
| SUPERSEDE | ADR-0060（被 ADR-0080 取代）、ADR-0069（被 ADR-0081 取代） | 状态改 SUPERSEDED + 双向链接，**不删** |
| BACKLOG | TASK-011 / TASK-012（Outline，可选 WFM3 升级，从未开工） | 移入新的 `docs/tasks/backlog/` |
| DELETE | 无 —— 本仓库没有 `old/`、`legacy-copy/`、`backup/` 影子目录，也没有跟踪中的 scratch 文件 | — |
| UNKNOWN | `.claude/tmp/`（未跟踪、已 gitignore 的历史 scratch，约 90 个文件） | **不删**：它在 Git 之外，删了不可逆；且既不进上下文也不进 diff。政策对**新产生**的 scratch 生效 |

## 实施摘要

**规则层**

- [ADR-0087](../../adr/ADR-0087-document-lifecycle-and-default-agent-context.md) ——
  8 条决策：三分类、四种记录的状态机与载体、ADR 双向取代、当前架构合同与 ADR
  分离、默认上下文、临时产物、守卫化的收敛闸门、接进既有节奏（不新建 Skill）。
- `AGENTS.md` 新增 §8（条款 24–26）+ 目录行 + 头部导航两行。
- [`docs/current-architecture.md`](../../current-architecture.md) 新增 ——
  模块边界 / 依赖方向 / 前后端合同 / 测试归属 / 7 条当前不变量，107 行，每条挂权威链接。

**工装层**

- `.claude/tools/lifecycle_check.py` 新增，6 项检查（完成卡留在 active、ADR 取代
  单向、REQ 索引不符、docs 里的临时产物、影子目录、当前架构合同缺失/超长）。
- `tests/tooling/test_lifecycle_check.py` 新增 27 项断言，每条检查都写**两个方向**
  （干净树必须绿、破坏后必须红），另有一条钉真实仓库。
- `.claude/tools/gen_docs_status.py` 认识 `tasks/backlog/`，STATUS.md 新增
  「默认加载什么」一节与当前架构合同入口；`test_docs_status.py` /
  `test_plan_status_matches_folder.py` 随之扩到三个状态目录。

**Skill 层**

- dev-workflow：新增 `references/lifecycle.md`（操作面）；SKILL.md 第 0 步（默认
  上下文）、第 9 步（仓库收敛六问 + 守卫）、第 10 步（搬家→守卫→重新生成三个动作）、
  merge 前置链各自接线；`records.md` / `repo-contract.md` 更新到新形状。
- auto-push：merge 前置链第 1 步补「仓库收敛」—— 守卫住在 `tests/tooling/`，
  最终全量绿即等于它绿，**不是额外动作**。

**存量迁移**（分类见上一节）

| 动作 | 对象 |
| --- | --- |
| SUPERSEDE | ADR-0060 → ADR-0080/0081；ADR-0069 → ADR-0081（双向补链，卡的是「读旧 ADR 的人看不到它已作废」）；另补 ADR-0001 / 0050 / 0079 的部分取代声明与 ADR-0070 / 0080 / 0081 / 0085 的反向链接 |
| BACKLOG | TASK-011、TASK-012 → `docs/tasks/backlog/` |
| ARCHIVE | `final-unified-milestone-review.md`、`creation-workspace-implementation-roadmap.md` → `design/done/`（各补一条归档状态行）；`pending-codex-rereview.md` 的已闭合历史（304 行）→ `design/done/codex-rereview-history-2026-08.md`，活账压到 31 行 |
| DELETE | 无（无影子目录、无跟踪中的 scratch） |

**默认上下文的实际变化**：merge 前必读的待复审清单从 35KB → 1.5KB；`active/`
任务卡从 7 张 → 6 张（其中 2 张移出的从未开工）；「现在的架构是什么」从
「遍历 70 条 ADR + 70KB 合同」变成一份 107 行的索引。

## 验证

- `python .claude/tools/lifecycle_check.py` → **0 finding**（真实仓库）。
- `pytest tests/tooling` → 见提交记录（含新增 27 项 + 既有 docs 三个守卫）。
- `ruff check` + `ruff format --check`（`.claude/tools/`、`tests/tooling/`）→ 全绿。
- 守卫的**变异验证**：6 项检查逐条构造违规树确认转红，并逐条构造合法形状确认
  不误杀（「部分完成」的卡、`archive/` 目录、正文里提到「取代」的 ADR、
  真实文档名不被当 scratch）。
- 独立审查：`codex-review-loop`，codex 跨模型（独立性未降级）。

  | 轮 | 结论 | 处理 |
  | --- | --- | --- |
  | 1 | fail：2 P1 + 1 非阻塞 | ① 反向只要「提到」这条 ADR 就算数 → 改成**必须带标签字段声明**（正文提及不算）；② REQ 索引只比对 ID、不校验链接目标 → 校验链到自己那份 REQ；③ 非阻塞的「换行会让声明失效」属同一类，一并改成**按条目读**。**这一轮当场查出 4 处真实的单向取代关系**（ADR-0049↔0001、0049↔0050、0066↔0052、0066↔0064），全部补齐 |
  | 2 | fail：3 P1 + 4 非阻塞 | ① 双向但**方向矛盾**（两份都写「取代对方」）也算通过 → 加方向判定；②③ 索引行或 REQ 文件**缺状态**被静默跳过 → 缺状态即报（守卫不得在记录残缺处沉默）。非阻塞同类一并修：重复索引行、`rglob` 会走进 `.venv`/`node_modules`（改 `os.walk` 剪枝，0.28s）、`--check` 文档里有代码里没有、`current-architecture.md` 写死「70 条 ADR」当场就不准（改为指向生成的 STATUS.md） |
  | 3 | fail：2 blocking + 1 非阻塞，**其中 2 条不属于本卡** | 两条 blocking 指向同一工作树里**另一个 Agent 正在做的 TASK-108 / ADR-0088**（Review Package 未接进 runner、`CHECKS` 缺 orphan-task —— 后者对方随后自己补上了）。属于本卡的那条非阻塞已修：REQ 索引链接未校验**目录围栏**，`../` 或绝对路径能落到 `docs/requirements/` 之外一个恰好叫 `REQ-…` 的文件上 → 加 containment 判定 + 用例 |

  **停在这里的理由**：轮 3 之后没有属于本卡的未闭合 P1；再买一轮只会重复审到
  对方那半个正在写的改动（ADR-0081「同一主题的更窄变体不算新 P1」+ 无进展 hard stop）。

## Follow-up

- **并发编辑已收口（留痕）**：2026-08-26 21:33 起，另一个 Agent 的
  [TASK-108](../done/TASK-108-traceability-and-requirement-review.md)（追溯链与需求
  兑现审查）与本卡在同一工作树、同一分支上并行，两者在 6 个文件上交叠
  （`STATUS.md`、`requirements/index.md`、`dev-workflow/SKILL.md`、
  `lifecycle_check.py`（对方加了 `orphan-task` 检查）、`test_lifecycle_check.py`、
  `verification.md`）。**违反 AGENTS.md 第 14/15 条**（一个任务一个实施 Agent、
  不并行改同一处）。结果没有丢失：两边的改动都进了同一条分支（`712c7d4` /
  `1b32047`+`453b23b`），`lifecycle_check` 与 `tests/tooling` 事后全绿。
  记在这里是因为**下次未必这么运气好** —— 交叠文件里有 `STATUS.md` 这种生成物和
  `lifecycle_check.py` 这种共享守卫，晚一步就是互相覆盖。
- `.claude/tmp/`（未跟踪、已 gitignore、约 90 个历史 scratch 文件）本次**不删**：
  它在 Git 之外，删了不可逆，且既不进上下文也不进 diff。第 26 条对**新产生**的
  scratch 生效。要清的话是一次纯人工动作，登记在 TASK-087 而不是这里。
- `docs/implementation_plan.md`（24KB 的阶段路线）与 `docs/STATUS.md` 在「谁做完了」
  上仍有部分重叠；`test_plan_status_matches_folder.py` 已经钉住「不得矛盾」，
  合并两者不在本卡范围。
