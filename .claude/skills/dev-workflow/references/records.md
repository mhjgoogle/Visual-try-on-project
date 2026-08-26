# Requirement Record 与 Change Record

生命周期（谁活多久、默认读什么、临时产物怎么办）见
[lifecycle.md](lifecycle.md)；权威是 AGENTS.md 第 24–26 条 / ADR-0087。

## Requirement Record（`docs/requirements/REQ-*.md`）

一个需求一个文件，命名 `REQ-NNN-short-slug.md`，编号取
`docs/requirements/` 下现有最大号 +1。索引在 `docs/requirements/index.md`
（一行一条，Agent 建 REQ 时同步加行）。

记录**为什么要做、用户真正要什么**。实现方案不写这里（写任务卡/ADR）。
只有产品需求建 REQ：Bug / Refactor / Perf 默认不建（见 SKILL.md 第 3 步）。

```markdown
# REQ-001：<一句话标题>

- 状态：CONFIRMED            # 整体状态 = 最新版本的状态
- 相关 Change：TASK-0XX · <commit>   # Agent 随实施追加

## v1 — CONFIRMED（2026-08-22）

- 来源：产品负责人 2026-08-22 —— 「<原话>」
- 用户真正需要什么：<一两句>
- 为什么：<一两句>
- 验收判据（产品视角，非测试清单）：
  1. <一条>
  2. <一条>
```

**判据必须是有序列表**：序号是后面对账与审查的引用句柄（`REQ-001 v1 判据 2`），
散文形式没法逐条判 `PASS / PARTIAL / FAIL / NOT_EVIDENCED`
（[traceability.md](traceability.md) §5）。

### 状态机

- `UNDERSTANDING` / `UNDERSTANDING_READY` 是实施工作流状态：前者表示产品行为理解
  尚未充分，后者表示 Requirement Understanding Check 已完整且没有实质产品歧义，
  正在等待交互式产品发现中的用户确认。二者可以只呈现在对话里，不要求为了 Gate
  单独创建 REQ 文件。
- `DRAFT` —— Agent 从探索/证据中**推断**的需求。转 CONFIRMED 的路径是
  先完成 Requirement Understanding Check，再由用户确认产品理解；不得直接进入实施。
- `CONFIRMED` —— 用户确认了 Requirement Understanding Check、已有需求原本已确认，
  或用户看到可运行结果后认可。仅描述一个新功能不自动等于 `CONFIRMED`。
- `SUPERSEDED` —— 被同文件更高版本或另一 REQ 取代（写明被谁取代）。
  **整份被另一个 REQ 取代时**：状态行改 `SUPERSEDED —— 被 REQ-NNN 取代`，
  文件留着不删，索引那一行同步改（两处状态必须一致 ——
  `.claude/tools/lifecycle_check.py` 会比，不一致即红）。

### 版本修订（真实使用后需求变化）

**不篡改已 CONFIRMED 的旧版本。** 同文件追加：

```markdown
## v2 — CONFIRMED（YYYY-MM-DD）· supersedes v1

- 来源：<原话/依据>
- 相对 v1 的 delta：<只写变化，不重抄全文>
```

后续实施只处理 **v1→v2 delta**，不从头重做整个功能。
v1 标题行就地补 `（superseded by v2）`，内容一字不动。

### 与存量机制的关系

存量需求已由 `docs/product_spec.md`、两份顶层需求文档、任务卡「依据」行
承载——**不回填成 REQ**。改到某条存量需求时，才为它建 REQ 并在 v1 里
指回原始出处；从那一刻起该需求的演化以 REQ 文件为准。

## Change Record

**一个任务一个，Agent 自动创建自动维护，用户不填。**

- **QUICK 深度**：提交信息即记录。首行写意图，正文写关联
  （`REQ-NNN`/`TASK-NNN`，如有）、做了什么验证。不建卡。
- **STANDARD / DEEP 深度**：任务卡 `docs/tasks/active/TASK-NNN-slug.md`
  （在办；做完后 `git mv` 进 `docs/tasks/done/` 并重新生成 `docs/STATUS.md`
  —— 目录即状态，ADR-0083）。**三个状态目录**（ADR-0087 决策 2）：
  `backlog/` 没人在做 → `active/` 正在做（含「部分完成」）→ `done/` 做完/已退役。
  立了卡但短期不做的放 `backlog/`，别停在 `active/`
  （编号顺延现有最大号），沿用本仓库既有卡风格，最小字段集：

```markdown
# TASK-NNN：<标题>

- 状态：未开工 | 进行中 | 完成 | 中止
- Workflow：Feature | Bug | Refactor | Perf | Migration · 深度：STANDARD | DEEP
- 关联 Requirement：REQ-NNN vK 判据 1,3（可多条；存量需求写「依据」行原话）
                    # 无产品需求时改写「技术目标：<一句，含为什么必要>」
- 架构约束：CA §2 依赖方向 · CA §5.3 fail-closed    # 或 none-specific
- 目标：<一两句>

## IN SCOPE / OUT OF SCOPE
## Impact Analysis        # 受影响模块 / API·合同 / 数据 / 依赖 / 测试 / 文档
## 架构影响               # 无，或触发了 architecture.md 哪条 + 结论/ADR 链接
## 实施摘要               # 完成时补：改了什么，在哪
## 验证                   # 逐条判据 → 命令+结果；审查四闸结论与轮次
## Follow-up              # 未解决项；跨任务的挪 TASK-087 总账
```

卡保持轻量——上面每节几行即可，不写几十页。

**卡不是调查记录本。** 调查过程、试错、原始输出属于一次性产物：留 `.claude/tmp/`
或会话 scratchpad，收口时把**结论几行**写进卡然后删原件（AGENTS.md 第 26 条）。

## 追溯链

`REQ-NNN 判据 M → TASK-NNN（或提交信息）→ CA §N → 代码 → 验证证据 → 审查 → Merge`。
双向：REQ 里追加「相关 Change」，卡里写「关联 Requirement」+「架构约束」，
提交信息里引用两者之一。

句柄约定、四个缺口标签（`ORPHAN_TASK` / `ORPHAN_IMPLEMENTATION` /
`REQUIREMENT_COVERAGE_GAP` / `ARCHITECTURE_UNKNOWN`）、Review Package 模板与
四闸判词都在 [traceability.md](traceability.md) —— **本文件不重复**。
