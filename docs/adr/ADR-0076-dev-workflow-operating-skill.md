# ADR-0076：dev-workflow 操作 Skill 与轻量 Requirement Record

- 状态：**Accepted**（2026-08-22，技术/工具链 ADR，依 CLAUDE.md「ADR 的
  Accept 权」由实施 Agent 自行 Accept；不涉付费、不动用户数据）
- 依据：产品负责人 2026-08-22 委托 —— 设计一个可复用的
  Software Development Operating Skill（单一入口、内部工作流分离、
  自动交接、自动维护 Requirement/Change 关系），v0.1，
  「可实际使用 > 架构清晰 > 可演进 > 功能全面」。

## 背景

仓库已有成熟的 Change 治理（任务卡）、架构治理（ADR + 冻结合同文档）、
风险分档验证与审查（AGENTS.md §20、ADR-0060/0069、codex-review-loop）、
欠账登记（TASK-087）与决策边界（CLAUDE.md 决策模式）。缺的是：

1. **任务类型路由**：feature / bug / refactor / perf / migration 各自的
   铁律（先复现再修、先 baseline 再优化…）散落或不成文；
2. **轻量 per-requirement record**：需求散在重量级基线文档与任务卡
   「依据」行里，没有 DRAFT/CONFIRMED/SUPERSEDED 状态机，需求在真实使用后
   变化时没有「v2 supersedes v1、只做 delta」的固定处理方式；
3. impact analysis / change isolation / convergence 未收拢成可执行清单。

## 决策

1. 新增 `.claude/skills/dev-workflow/`（SKILL.md + 5 个 references）作为
   开发任务单一入口：路由五条主工作流 × 三档深度（QUICK/STANDARD/DEEP），
   维护 Requirement/Change 记录，条件触发架构治理，按 impact 定验证范围，
   完成前跑 convergence 清单。
2. **复用不重建**：Change Record = 既有任务卡（QUICK 深度 = 提交信息）；
   架构治理产出 = 既有 ADR 与「架构影响」节；审查 = codex-review-loop；
   验证分档权威 = AGENTS.md §20；欠账 = TASK-087。Skill 与既有规则冲突时
   以既有规则为准（Skill 内明文声明）。
3. 新增 `docs/requirements/`：`REQ-NNN-slug.md` 一需求一文件，文件内
   版本修订（v2 supersedes v1，不篡改旧版，实施只做 delta）。
   **存量需求不回填**，发生变化时才建 REQ 并指回原出处。
4. 深度（流程重量）与风险档（验证/审查重量）**正交**：持久化一行修 =
   QUICK 深度 + 高风险验证。深度由 Skill 定，风险档权威不变。
5. Requirement 确认路径遵循 CLAUDE.md 决策模式：用户原话 = 创建即
   CONFIRMED；Agent 推断 = DRAFT，靠「做出来给用户看」转正，
   **不新增中途提问闸门**。
6. v0.1 显式不做：部署编排、发布自动化、secrets、安全/可观测框架、
   企业审批、sprint/ticket 管理、强制多 Agent 编排、强制 TDD。

## 后果

- 好处：任务类型各自的铁律成文可执行；需求变化可追溯（REQ→TASK→代码→测试）；
  修改与验证范围有了统一判定入口；「只加不减」有了完成前的收敛闸。
- 代价：STANDARD/DEEP 任务多一次建档动作（几行）；REQ 与任务卡之间需要
  双向引用纪律。
- 不变：AGENTS.md / CLAUDE.md 的全部既有规则、gate、审查预算、提交规则。
