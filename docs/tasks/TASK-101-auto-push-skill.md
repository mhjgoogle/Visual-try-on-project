# TASK-101：auto-push Skill v0.1 —— Task 级自动 commit/push 与受控合并

- 状态：完成
- Workflow：Feature · 深度：DEEP
- 关联 Requirement：REQ-001（产品负责人 2026-08-22 原始指令）
- 目标：dev-workflow 判定 Task 完成 + 定向验证 PASS 后自动 stage（仅当前
  Task 的 diff）→ commit → push；Merge Gate = PASS 后 sync main → merge →
  push main → cleanup。机制决策见 ADR-0079。

## IN SCOPE / OUT OF SCOPE

- IN：`.claude/skills/auto-push/`（SKILL.md + references + autopush.py）、
  `docs/auto-push/`（数据目录）、REQ-001、ADR-0079、本卡、
  `tests/test_auto_push_tooling.py`、dev-workflow SKILL.md 第 10 步一处接线。
- OUT：AGENTS.md §22 正文更新（被 TASK-099 未提交改动占用，见 Follow-up）；
  PR/审批/部署/release；autostash 式脏树 sync；hunk 自动归属推断。

## Impact Analysis

纯增量 agent 工装 + 文档；不触产品代码。与 commit gate 的关系是**协作不
替代**：脚本永不执行 `git commit`（ADR-0079 决策 3）。唯一被修改的既有
文件：`docs/requirements/README.md`（索引行）、
`.claude/skills/dev-workflow/SKILL.md`（第 10 步接线）——两者当时均无
未提交改动。

## 架构影响

无产品架构影响。治理面：对 AGENTS.md §22 的窄修订（Change 分支 push 自动
化）由 ADR-0079 决策 4 承载，依据用户明确指令。

## 实施摘要

- `autopush.py`：13 个子命令（init-change / task-ready / plan / stage /
  record-commit / push / sync / set-merge-gate / premerge-sync /
  merge-abort / merge / cleanup / status），单行 JSON 输出，BLOCKED_* 为
  合法结果。实施中修掉的真缺陷：`@{u}` 会被 `switch -c X origin/main`
  自动设成 origin/main 导致漏检 remote-ahead（改为显式 origin/<branch>）；
  链式令牌不得被脚本拼接（守卫测试拦下，改为 chain_mode 提示 + agent
  逐次手写）；清单回写造成的常驻脏树（NEEDS_WRITEBACK_COMMIT 消化）；
  merge 前必须推最终 tip 否则 cleanup 的 `-d` 被 upstream 拒绝。

## 验证

- `pytest tests/test_auto_push_tooling.py`：22 passed（场景 A–L、N 全覆盖，
  含临时 bare origin + 双 clone 的 remote-ahead / 冲突 / merge / cleanup）。
- `ruff format --check` + `ruff check`：通过。
- 真实仓库 dry-run：用 auto-push 提交本任务自身（工作树同时存在 TASK-099
  的未提交改动 = 活体 Scenario B），结果记录在下方「dry-run 记录」。
- 独立审查：高风险档（文件操作/安全/Windows 可移植性）→ codex-review-loop
  2 轮，见验证附记。

## dry-run 记录（真实仓库）

见提交历史：change `wfm1-batch-c`（收养 `feat/wfm1-batch-c`）下的
TASK-101 提交。TASK-099 的 18 个脏文件全程未被触碰、未被 stage。

## Follow-up

- AGENTS.md §22 正文补写「Change 分支 push 由 auto-push 自动执行
  （ADR-0079 决策 4）」——等 TASK-099 提交后做，避免混 diff。
- sync 的 autostash（脏树同步）与 `--keep-remote` 默认值复核 → v0.2。
- 待复审清单：本任务若在审查者不可用时提交，按 CLAUDE.md 登记补审。
