# TASK-108：把「产品意图 → 验证」的追溯链与需求完成度审查接进开发流程

- 状态：完成（2026-08-26）—— 实现完成、归属域验证通过、三轮独立审查后代码里无未闭合 P1。
  **尚未提交**：同一工作树里 TASK-107 在途且共改六个文件，拆 hunk 会和另一个
  Agent 正在写的文件抢写，交给 TASK-107 先落地（详见「验证」末尾）。
- Workflow：Refactor · 深度：DEEP
- 关联 Requirement：[REQ-003](../../requirements/REQ-003-traceability-and-requirement-fulfillment-review.md) v1 判据 1–6
- 关联 ADR：[ADR-0088](../../adr/ADR-0088-traceability-and-requirement-fulfillment-review.md)
- 架构约束：`CA §4` 测试归属（工装测试住 `tests/tooling/`）·
  `CA §5.4` 平台中立（两个 shell 必须给出相同判定，ADR-0050 决策 1 / ADR-0062 决策 3）
- 目标：现有 dev-workflow / codex-review-loop / auto-push **不新建第二套流程**，
  只补上三段断链：审查看不到需求、审查看不到架构约束、卡上的关联无人校验。

## IN SCOPE

- 追溯链与引用句柄（复用 `REQ-NNN 判据 M` / `TASK-NNN` / `CA §N` / commit，不新建命名空间）
- 需求完成度审查四闸与判词，接进 codex-review-loop 的评级与两个审查脚本的 prompt
- Review Package 机制（`REVIEW_PACKAGE`，fail-closed）
- Merge Gate 追加三项 + 四个缺口标签
- `ORPHAN_TASK` 机器守卫

## OUT OF SCOPE

- 追溯数据库 / 每文件永久 metadata / 函数级 REQ ID / 大型评审文档（ADR-0088 §3「不做的」）
- 第二套 Codex 触发规则或独立 review Skill —— ADR-0081 的触发表与轮次协议**一条不改**
- 存量需求回填成 REQ（records.md 既有规则不动）
- 产品级追踪表（`docs/design/end-to-end-requirements-traceability.md` 已有一份）

## Impact Analysis

- 受影响模块：`.claude/skills/{dev-workflow,codex-review-loop,auto-push}/`、
  `.claude/tools/lifecycle_check.py`、`AGENTS.md`、`docs/{adr,requirements,current-architecture.md}`
- API / 合同：审查脚本的**输出格式**增加 `REQUIREMENT:` / `ARCHITECTURE:` /
  `VERIFICATION:` 三节；`VERDICT:` 行的解析方式不变（向后兼容）
- 数据：无持久化改动。Review Package 住 `.claude/tmp/`（gitignore，一次性产物）
- 依赖方向：不变
- 受影响测试：`tests/tooling/`（归属域，ADR-0080）
- 文档：AGENTS.md §6、current-architecture.md §5、三个 Skill 及其 references

## 架构影响

触发 architecture.md 第 3 条（跨层公共代码：两个审查脚本是同一行为合同的两侧实现）。
结论：**不新增抽象**，两侧各自实现同一段 prompt 与同一组 fail-closed 判定，
由 `tests/tooling/test_review_package_contract.py` 的字节级 parity 断言钉住 ——
共享一个生成器会给工装引入构建步骤，代价大于收益。

## 实施摘要

| 位置 | 改了什么 |
| --- | --- |
| `dev-workflow/references/traceability.md` | **新增**（149 行）：链与句柄、卡上两行、四个缺口标签、Review Package 模板、四闸判词与评级映射、Merge Gate |
| `dev-workflow/SKILL.md` | 第 3 步（判据写成有序列表）、第 4 步（追溯两行，替换原「追溯链」一行）、第 8 步（备包 + 四闸）、第 10 步（Done 按判据对账 + merge 前置追加三项） |
| `dev-workflow/references/records.md` | REQ 模板判据改有序列表；卡最小字段集补「技术目标 / 架构约束」；「追溯链」节合并为指向 traceability.md |
| `dev-workflow/references/verification.md` | 审查段落接四闸；Done 判定改为逐条判据 + 证据充分性 + `CA §N` 仍成立 |
| `codex-review-loop/SKILL.md` | 开头四闸顺序；Phase 0 第 3 步备包；Phase 1 命令带 `REVIEW_PACKAGE`、错误码增 `PACKAGE_TOO_LARGE`、评级改成按闸的映射表；Ironclad 规则区分「符合性」与「提案」；Phase 2 报告增四闸结果 |
| `scripts/run-review.sh` · `run-review.ps1` | `REVIEW_PACKAGE` / `REVIEW_MAX_PACKAGE_LINES`；包不可读/为空/超上限 → `ENV_ERROR` / `PACKAGE_TOO_LARGE`（exit 0，fail-closed）；prompt 换成四闸 + 三节输出，两侧**字节一致**；**带包时缺三节 = 未完成的审查**（回退→ENV_ERROR），无包时裸 verdict 仍收口（向后兼容） |
| `auto-push/SKILL.md` | Merge Gate 第 1 步补四闸结论（声明，非新动作） |
| `AGENTS.md` §6 | 审查四闸表 + 两种禁止的 PASS + 追溯句柄 + 缺口标签；发布闸门追加三项 |
| `docs/current-architecture.md` §5 | 节号即引用句柄 |
| `.claude/tools/lifecycle_check.py` | 新增 `orphan-task` 检查：只看**卡头部**，锚点须是带标签的基础字段或显式 `REQ-NNN`；范围 = `active/` 全部 + `backlog/`·`done/` 里带 `架构约束：` 的卡（存量已完成卡豁免） |
| `docs/tasks/active/TASK-040` | 补一行「依据」—— 它是新守卫报出的唯一一处存量 `ORPHAN_TASK` |

## 验证

| REQ-003 判据 | 证据 |
| --- | --- |
| 1 追溯 + `ORPHAN_TASK` | `lifecycle_check.orphan-task`；`pytest tests/tooling/test_lifecycle_check.py`（53 项，含「只有头部算」「裸 ADR 不算依据」「搬进 done/ 仍被看着」「存量卡豁免」四条边界用例）；真实仓库那条从 1 finding → 0 |
| 2 四闸顺序 | 两个脚本的 prompt 内 `Requirement fulfilment` 位置早于 `Technical quality`（`test_the_package_and_the_diff_both_reach_the_reviewer` 断言顺序）；SKILL/AGENTS 的顺序表 |
| 3 四判词 + 禁止两种 PASS | prompt 内判词定义与 `NEVER answer PASS because …`；断言 `NOT_EVIDENCED` 在 prompt 里；**带包时缺三节的回答不算完成的审查**（`test_an_answer_missing_the_new_gates_is_not_a_completed_review`，两个 shell 都有该规则） |
| 4 Merge 阻塞 | prompt 的 `VERDICT must be fail if ANY requirement is PARTIAL, FAIL or NOT_EVIDENCED …`；SKILL 第 10 步 + auto-push 第 1 步 + AGENTS §6 三处前置 |
| 5 默认不扫仓库 | `Stay inside the package and the diff…`；`REVIEW_MAX_PACKAGE_LINES` + `test_bash_refuses_an_oversized_package`；无包时退回 gate 4（`test_without_a_package_the_review_degrades_to_gate_four_only`） |
| 6 流程自动执行 | 守卫在 `tests/tooling/` → 自动进 commit gate 与 merge 前最终全量；Review Package 由 Skill 步骤驱动，用户不填 |

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `python .claude/tools/lifecycle_check.py` | 0 finding（引入 `orphan-task` 时报出 1 处存量 ORPHAN_TASK = TASK-040，已补依据行） |
| `pytest tests/tooling/test_lifecycle_check.py` | 49 passed |
| `pytest tests/tooling/test_review_package_contract.py`（收口版） | 24 passed |
| `pytest tests/tooling/test_review_package_contract.py` | 轮 2 时 22 passed（含两个 shell 的真实执行；PowerShell 侧的闸形状函数由 AST 抽出来真跑） |
| `pytest tests/tooling`（归属域，收口重跑） | **241 passed / 1 skipped**（4m35s；跳过的那条是 Ubuntu CI 才跑的 bash 语法检查，与本卡无关） |
| `ruff check` / `ruff format --check` | All checks passed |
| `run-review.ps1` 真实 codex 审查（带 Review Package） | 轮 1 fail（3 P1 + 1 反驳）→ 轮 2 fail（3 P1，2 条新机理，架构 1 条 FAIL）→ 轮 3 fail（4 条全为已修主题的更窄变体；架构 2 条 PASS）→ 按 §2b/§2c 收口，显式 ship |

### 独立审查（dogfooding：本卡自己走新流程）

**轮 1（codex，独立性未降级）** —— 审查者按四闸逐条作答，判据 1/2/3/4 判 FAIL、
5/6 判 PASS，架构两条 PASS，VERIFICATION 判 INSUFFICIENT。三条真 P1 已修：

1. **锚点太宽** —— 任何 `ADR-NNNN` 都算依据，而几乎每张卡都会在背景里引某条 ADR
   → 改成必须是**带标签的**基础字段或显式 `REQ-NNN`。实测代价：`active/` 0 处变红。
2. **搬家即失明** —— Done 判定要求把卡搬进 `done/`，而守卫只看 `active/`，
   于是**恰好在 merge 那一刻**没人看 → 扩到 `backlog/`/`done/` 里带
   `架构约束：` 的卡；存量已完成卡显式豁免（100 张里 58 张没有依据行，
   给没人记得的旧工作编一条依据是虚构），边界写进 ADR + reference + docstring 并各有用例。
3. **裸 `VERDICT: pass` 能收口** —— 带包时审查者若忽略（或根本没收到）包，
   一行 verdict 就能关闭循环，需求那一问从未被问 → **两个 shell 同时**改成：
   带包时缺 `REQUIREMENT/ARCHITECTURE/VERIFICATION` 即视为**未完成的审查**
   （codex → claude 回退 → ENV_ERROR），与「没有 VERDICT 行」同一姿态。
   **这条把判据 2/3/4 从「程序性」变成机器可判**。

一条反驳：审查者报 `TASK-011/012` 的删除属于 `ORPHAN_IMPLEMENTATION`。那两个文件
属于 TASK-107（同一工作树在途），已在包的 Known risks 里申报；漏出来的原因是我
自己算 `REVIEW_EXTRA_EXCLUDES` 的一次性脚本把 `git status -z` 的 rename 条目解析错了
—— 修在源头（两侧路径都排除），不是改产品代码。

**轮 2（codex）** —— 判据 1/2/3/4 从 FAIL 降到 PARTIAL、5/6 PASS，**架构第 2 闸
报出一条 `FAIL`**。三条 P1，其中两条是**新机理**（按 ADR-0081 §2a 各自买轮）：

1. **`CA §5.4` FAIL：两个 shell 对空白值判得不一样** —— `REVIEW_PACKAGE="   "`
   在 `.sh` 里是「不可读的路径」→ ENV_ERROR，在 `.ps1` 里被 `IsNullOrWhiteSpace`
   读成「没给包」→ 静默只审第 4 闸。**同一环境两个 host 两个结论**，正是
   ADR-0062 决策 3 禁的。→ 两侧统一：长度 0 = 没给；非空但全空白 =
   `ENV_ERROR: REVIEW_PACKAGE is set but blank`。两个 host 都有执行级用例。
2. **「有标题但没评级」仍能收口** —— 只查三个标题在不在，于是三个空标题、
   顺序颠倒也算一次四闸审查。→ 带包时必须**按顺序**出现且第 1 闸至少给一个判词。
3. **`pass` 与自己的闸自相矛盾也被接受** —— `VERDICT: pass` 上方写着
   `NOT_EVIDENCED`，而 Merge Gate 读的是 verdict。→ 两侧在 `REVIEWER:` 旁加
   `GATE_CONSISTENCY: inconsistent … treat this review as fail.`，
   **不改审查者原话**，只把矛盾说出来；控制器与 Merge Gate 据此按 fail 处理。

一条变体（§2b，修了但不买轮）：空标签 `- 依据：` 也算锚点 —— 锚点改为要求**同一行**
有内容（用水平空白类，`\s` 会匹配换行从而吃到下一行的首字符）。

一条范围判断（§2b，记录不修）：「`REQ-NNN` 不带判据号不该算锚点」。一张卡完全
可以服务整条 REQ 而不是某一条判据，强制 `判据 N` 会误杀正确的卡；判据级对账住在
审查第 1 闸（它读包），不住在正则里。

**轮 3（codex）** —— **架构两条都 PASS**（`CA §5.4` 的分歧已闭合，这是轮 2 那条
P1 修好了的直接证据）；判据 5/6 PASS，1/2/3 PARTIAL、4 FAIL。四条 blocking
**按 ADR-0081 §2c 判都是已修主题的更窄变体**（失效机理相同：守卫范围 /
形状校验 / verdict 与内容矛盾），因此**不再买轮**；其中两条是真洞，照修：

1. **三闸答完就算完成** —— 校验只要 `REQUIREMENT/ARCHITECTURE/VERIFICATION`，
   于是丢掉 `BLOCKING`/`NON_BLOCKING` 的回答也算一次四闸审查，而第 4 闸正是
   correctness 住的地方。→ 五节必须按顺序齐全。
2. **`pass` 旁边真列着 blocking 却不报矛盾** —— 一致性扫描停在 `BLOCKING` 标题上，
   不看它下面的条目。→ 扫到 `NON_BLOCKING` 之前，`- (none)` 不算条目。
   （修这条时暴露出一个 `set -e` 真 bug：`grep -v` 过滤空了返回 1 会让脚本
   在打印 `REVIEWER:` 之后直接退出 —— 被新用例当场抓到，已 `|| true` 修掉。）

两处**机器守不到、如实记下不假装守住**：

| 缺口 | 为什么不在本卡修 | 去向 |
| --- | --- | --- |
| QUICK 深度的 Change 以**提交信息**为记录，`orphan-task` 只看任务卡 | 要拦得改 commit gate 的**提交信息合同**（ADR-0070），那是另一个合同的决策，且会拦下每一条不写引用的琐碎提交 | 下方 Follow-up；同时仍被审查第 1 闸拦（没有需求的 Change 备不出声称需求的包） |
| 判据级覆盖率不由脚本数 | 解析包里的散文会误杀正确的包，而一次误杀要花掉整整一轮（7 分钟 + 配额） | 规则改为**「没被评级的判据按 `NOT_EVIDENCED` 记」**（写进 traceability.md 与 codex-review-loop），方向仍是 fail-closed |

按 ADR-0081 hard stop d 的三选一，显式选择 **ship**：代码里无未闭合 P1，
两处缺口各有去向且都不是「静默通过」。

## Follow-up

- **QUICK 深度 Change 的 `ORPHAN_TASK` 机器检测**（轮 3 findings 之一）：
  QUICK 不建卡，记录是提交信息，因此现有守卫看不到它。要机器拦住，得在
  commit gate 里加一条「提交信息必须引用 `REQ-NNN`/`TASK-NNN` 或写明技术目标」
  —— 那是 [ADR-0070](../../adr/ADR-0070-commit-gate-intent-by-shell-parser.md)
  的提交信息合同变更，需要单独一张卡与一次决策（会影响每一条琐碎提交）。
  当前状态：审查第 1 闸仍然拦得住（备不出声称需求的包），机器不拦。
- 存量：`docs/design/end-to-end-requirements-traceability.md` 的 §3b 之类逐行
  状态仍靠人维护 —— 那是产品级追踪表的既有形态，本卡不动它。
