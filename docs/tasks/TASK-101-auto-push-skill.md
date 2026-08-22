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

- `pytest tests/test_auto_push_tooling.py`：最终 **30 passed**（场景 A–L、N
  全覆盖 + 审查修复的负向用例，临时 bare origin + 双 clone 的
  remote-ahead / 冲突 / merge / cleanup）。
- `ruff format --check` + `ruff check`：通过。每次 commit 由 commit gate
  跑全量 pytest（autopush.py 属未映射非文档路径 → full 档），三次全绿。
- 真实仓库 dry-run：用 auto-push 提交本任务自身（工作树同时存在 TASK-099
  的未提交改动 = 活体 Scenario B），TASK-099 的 24 个脏文件全程未被触碰。
- 独立审查：codex 跨模型，高风险预算 2 + P1 买 1 = **3 轮全部用尽**，
  独立性未降级。轮 1：7 P1 + 2 P2 全修（548e923 → 9f21fbd）；轮 2：5 条，
  4 P1 已修 + cleanup TOCTOU 一条驳回（修复需 force-with-lease，v0.1 §14
  禁止）+ 2 P2 顺带修 + 1 P2 记 follow-up（9f21fbd → c1fad5b）；轮 3：4 条，
  3 真 P1 已修（清单元数据过 secret 扫描 / 豁免看内容不看 subject / merge
  tip push 过同一道闸）、TOCTOU 同主题维持驳回。**轮 3 的 3 处修复未经复审**
  ——已登记[待复审清单](../design/pending-codex-rereview.md)，
  **本 Change merge 前必须补审**。

## dry-run 记录（真实仓库）

见提交历史：change `wfm1-batch-c`（收养 `feat/wfm1-batch-c`）下的
TASK-101 提交。TASK-099 的 18 个脏文件全程未被触碰、未被 stage。

## v0.1.1（2026-08-22 晚，同卡追加实施）

首个多会话实战日暴露的六项缺陷一次收口（证据：skill-evolution
fb-auto-push-0002~0006 + ba0c8e2 补审）：

1. `init-change` 永不把共享工作树往回切（`BLOCKED_BASE_BEHIND`；TASK-102
   实测踩中「main=Initial commit → 切成空树」）。
2. 越界判定按**当前**申报范围现算（`_live_violations`），不吃登记时快照；
   commit 记录新增 `files` 字段。
3. Merge Gate 的 stale 判定豁免「tip 之后只有元数据回写」（内容判定，
   复用 `_is_metadata_commit`），解开 set-merge-gate → 回写 → stale 死环。
4. 出处判定全局化：`_provenance` 汇总**全部** Change 清单（跨 Change 叠
   分支可行）；排除集扩为 `--remotes=origin`；`record-commit --hash` 补登
   历史提交。
5. evil-merge P1 修复（ba0c8e2 补审的 blocking）：merge commit 豁免改为
   **登记制**——premerge-sync 自动登记 `sync_commits`，冲突解决路径
   `record-sync` 显式登记；废除「后位亲是 main 祖先」的结构推断。
6. merge 新增 `--ledger-checked` 前置：声明已核对待复审清单（TASK-102 的
   流程教训制度化）。

验证：tests/tooling/test_auto_push_tooling.py **37 passed**（新增 7 项，含
plumbing 构造的 evil merge、跨 Change 叠分支、快照重算、回写不 stale）。
另：分支 push 会连带发布整个祖先——「出处齐全 ≠ 发布授权」已写进
SKILL.md（0c 会话指出，本次 v0.1.1 提交因此**只 commit 不 push**）。

## Follow-up

- AGENTS.md §22 正文补写「Change 分支 push 由 auto-push 自动执行
  （ADR-0079 决策 4）」——等 TASK-099 提交后做，避免混 diff。
- sync 的 autostash（脏树同步）与 `--keep-remote` 默认值复核 → v0.2。
- 待复审清单：本任务若在审查者不可用时提交，按 CLAUDE.md 登记补审。
