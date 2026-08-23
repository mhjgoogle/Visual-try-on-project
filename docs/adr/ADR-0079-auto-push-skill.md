# ADR-0079：auto-push Skill —— Git 执行权与开发决策权分离

- 状态：Accepted（2026-08-22，实施 Agent 依 CLAUDE.md「ADR 的 Accept 权」
  自行 Accept；其中**推送授权**部分的依据是产品负责人 2026-08-22 的明确指令，
  见决策 4 引文——不是 Agent 自行扩权）
- 关联：REQ-001、TASK-101；上游机制 ADR-0060（commit gate）、ADR-0068
  （连续修改链）、ADR-0076（dev-workflow）、ADR-0078（skill-evolution）

## 背景

产品负责人 2026-08-22 要求：Task 完成且定向验证通过后自动 commit + push，
Change 完成且 Merge Gate = PASS 后自动 sync main → merge → cleanup，全程
不再逐次询问；同时自动化不得把错误代码、无关 diff、冲突需求或危险 Git
操作推进到 main。本仓库已有的相关机制：Change 记录 = 任务卡 +（新）REQ
文件（ADR-0076）；提交质量闸门 = PreToolUse commit gate（ADR-0060/0068）；
main 此前**从未有过 merge**（全部历史在 feat 分支上），无既有合并惯例。

## 决策

1. **职责分层。** dev-workflow 拥有全部语义判断（Task 是否完成、验证是否
   充分、Merge Gate、semantic/architecture conflict 裁决）；auto-push 只拥有
   Git 执行（branch / stage / commit 命令生成 / push / sync / merge /
   cleanup / 元数据回写）。auto-push 永不判断「需求已完成」。

2. **数据形态。** 一个 Change 一个机器可读清单
   `docs/auto-push/changes/<change-id>.json`（schema v1，见
   `docs/auto-push/README.md`），承载 Requirement → Change → Branch → Task →
   Commit → Push → Merge 追溯链的机器端；人读任务卡。放 `docs/` 的理由与
   ADR-0078 决策 2 相同：commit gate 把 docs/ 归 lint 档，高频回写不背全量
   pytest。确定性操作走单脚本
   `.claude/skills/auto-push/scripts/autopush.py`（stdlib-only、单行 JSON、
   双 shell 同一条调用），沿用 evolution.py 的形态。

3. **脚本永不执行 `git commit`，永不构造 force push。** commit gate 拦截的
   是 shell 命令文本；脚本内 commit 会让 ADR-0060/0068 的质量闸门整个失明。
   因此 `stage` 只准备 index 并返回 `commit_command`，由 agent 在 shell 原样
   执行。同理，ADR-0068 的链式令牌**不得**由脚本生成或存储（守卫测试
   `test_no_persistent_switch_exists_anywhere_in_the_repo` 强制此点）——
   脚本只回报 `chain_mode: true`，令牌由 agent 逐次手写。force push 与远端
   历史改写一律升级给用户，`--force-with-lease` 也不自动执行。

4. **推送授权变更（对 AGENTS.md §22 的窄修订）。** 依据产品负责人
   2026-08-22 指令：「默认允许自动 commit、自动 push，前提：所有安全 Gate
   通过。用户不应该被频繁询问『要不要 commit？』『要不要 push？』」——
   **Change 分支的 push** 在 verification PASS + 全部安全 Gate 通过后由
   auto-push 自动执行，不再逐次征求同意。**merge / push main 的用户闸门
   保留**：Merge Gate 只能由 dev-workflow 在用户明确指示合并后设 PASS
   （`--by` 记录原话+日期），auto-push 只在 PASS 后执行合并。AGENTS.md §22
   的正文更新记为 follow-up（该文件当前被 TASK-099 未提交改动占用，
   不混 diff）。

   > **本条的后半句已被取代（2026-08-24）** →
   > [ADR-0085](ADR-0085-merge-is-not-a-human-gate.md)：产品负责人「合并。这个
   > 也不需要保留人工」，merge 的用户闸门去掉。**Merge Gate 机制本身不动** ——
   > 它仍然只能由 dev-workflow 设 PASS、仍然绑分支 tip、仍然要 `--ledger-checked`；
   > 变的只是 `--by` 记的东西：从「用户原话+日期」换成「Done 判定 + 最终全量的
   > 结果」。本条前半句（Change 分支自动 push）不变。

5. **branch 与合并策略。** 短生命周期分支 `change/<TASK-NNN|batch>-<slug>`
   （紧急修复 `hotfix/…`），长期分支只有 main；既有分支经 `--adopt` 收养，
   分支身份由 dev-workflow 决定，脚本不发明分支名。合并固定为
   `merge --no-ff`（可追溯、不改写历史；main 无既有惯例可循）。merge 前
   必须：latest main 已合入 Change 分支（premerge-sync）+ 重验证 + Change
   分支最终 tip 已推上远端。merge 确认落在 origin/main 后默认删除本地与
   远端分支（`--keep-remote` 可保留）。

6. **diff 归属与安全 Gate（全部 fail-closed）。** 只 stage 归属于当前 Task
   申报 pathspec 的文件（禁 `git add .`）；同时命中多个 Task 的文件必须
   由 agent 给出按 hunk 裁剪的 patch（`--patch-file`），无法可靠区分即
   `BLOCKED_MIXED` 交回；staged 结果逃出申报范围立即整体 reset。推前扫描
   疑似 secret（内容正则 + 危险文件名），命中即拒绝且不提供脚本级 override。
   宽 diff（>25 文件或 >6 个顶层目录）要求显式 `--allow-wide`，作为
   Change Scope / 架构漂移信号先交 dev-workflow 复查。remote ahead 用
   fetch + rebase（只改写本地未推送提交）处理，冲突自动 abort 交回。

7. **冲突裁决分流。** 纯工程文本冲突由 agent 解决并重验证；Requirement /
   产品行为 / API 语义 / 架构合同层面的冲突（包括 git 干净合并但重验证
   失败的 semantic conflict）交回 dev-workflow；只有两个有效 Requirement
   真冲突才升级用户。细则在 skill 的 references/merge-and-conflicts.md。

## 后果

- 开发主循环去掉「问一次 push 一次」的往返；提交质量仍由既有 commit gate
  把守（本 ADR 未移除任何检查）。
- 清单回写让工作树周期性变脏：以 `NEEDS_WRITEBACK_COMMIT` +
  `chore(auto-push)` docs 提交消化，是可见的、便宜的代价。
- v0.1 明确不做：PR/审批流、部署、release、force push、复杂 Git Flow、
  自动解决产品语义冲突、按 hunk 的自动归属推断（patch 由 agent 语义层
  产出）。sync 遇到脏工作树（其他任务在场）时保守拒绝，autostash 留给
  v0.2 评估。

## 验证

`tests/test_auto_push_tooling.py`（22 项）复刻需求原文 §39 的场景 A–L、N；
场景 M（semantic conflict 归 dev-workflow）是语义规则，住在 SKILL.md 与
references。真实仓库 dry-run 记录见 TASK-101。
