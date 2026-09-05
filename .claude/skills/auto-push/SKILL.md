---
name: auto-push
description: >-
  Auto Push — deterministic Git execution after dev-workflow decides. INVOKE in
  exactly two cases: (1) Task-level — dev-workflow has declared the current
  task DONE with targeted verification PASS: attribute the diff, stage only
  this task's changes, hand the commit command to the shell (so the commit
  gate runs), record metadata, push the change branch — no per-push user
  confirmation; (2) Change-level — the Change is finished: its Done criteria
  hold, the FINAL FULL verification passed, no P1 is outstanding, and the
  pending-re-review ledger carries nothing covering this branch: set the merge
  gate (recording that evidence, not a user utterance — ADR-0085), sync latest
  main, re-verify, merge --no-ff into main, push main, clean up the branch.
  DO NOT invoke: to decide whether a task or requirement is done
  (dev-workflow's job), while verification is failing, before the final full
  verification has passed, for repos without a Change manifest (run
  init-change first), or to force-push / rewrite remote history (always
  forbidden).
---

# auto-push — Task 级自动 commit/push 与受控合并（v0.1）

**dev-workflow = 决策权，auto-push = Git 执行权。** 本 Skill 永不判断
「需求是否完成」，也永不改产品行为。机制决策见 ADR-0079；数据在
`docs/auto-push/changes/<change-id>.json`（一个 Change 一个清单；schema
与目录说明见 [references/manifest.md](references/manifest.md)）。

所有确定性操作走一个脚本（输出单行 JSON；`BLOCKED_*` 是合法结果，exit 0）：

```
python .claude/skills/auto-push/scripts/autopush.py <cmd> --change <id> …
```

三条铁律：**脚本永不执行 `git commit`**（commit 命令由 agent 在 shell 运行，
让 commit gate 拦截）；**永不 force push**（非 fast-forward 一律交回，改写
远端历史必须升级给用户）；**永不 `git add .`**（只 stage 归属于当前 Task 的
diff）。

## Change 生命周期

一个 Change = 一条分支 = 一个清单。新分支命名 `change/<TASK-NNN|batch>-slug`；
已有分支用 `--adopt` 收养（分支身份由 dev-workflow 定，脚本不发明分支名）。

```
init-change --change <id> --branch <name> [--base <ref>] [--adopt] [--chain]
```

新建分支**永不把共享工作树往回切**：默认 base（origin/main）落后或岔开于
HEAD 时返回 `BLOCKED_BASE_BEHIND`——要么 `--base HEAD`（在当前历史上叠加，
跨 Change 叠分支的正路），要么 `--adopt` 既有分支。

`--chain` 只在用户已按 ADR-0068 明确授权连续修改链时传；stage 结果里的
`chain_mode: true` 提醒你把链式令牌**逐次手写**在提交命令最前面
（PowerShell：首行注释，再换行写 commit）——令牌不得由任何脚本生成或存储。

## Task 循环（每个 Task 完成后，不问用户）

1. dev-workflow 判定 Task 完成、定向验证 PASS 之后：
   `task-ready --task T --verification PASS --ref "<跑了什么>" --paths <pathspec…>`
   （paths = 该 Task 的 Impact Scope，目录以 `/` 结尾，支持 glob。FAIL 也要
   如实申报——之后一切操作都会被 `PUSH_BLOCKED_BY_VERIFICATION` 拦住。）
2. `stage --task T --message "<一句话>"` —— 自动做：branch 校验、冲突/脏
   index 检查、diff 归属（mine / mixed / foreign）、宽 diff 守卫、secret 扫描，
   然后只 stage 归属文件（清单自身自动带走）。
3. 把返回的 `commit_command` **原样在 shell 运行**（gate 按 ADR-0080 归属映射跑
   检查），然后 `record-commit --task T` 回写 hash（`--hash <h>` 可补登历史
   提交；越界判定按**当前**申报范围现算，不吃登记时的快照）。
   **`stage` 每次都会重新生成那个 commit 信息文件**：要写多行正文就在 stage
   **之后**写；被 gate 拦下后重新 stage 的，正文要重写（别在没重读的情况下
   对它做字符串替换 —— 替换会静默失配，最后只剩一行标题）。
4. `push` —— 成功即完；`NEEDS_SYNC` 见下。
5. push 成功后做一次 skill-evolution Fast Loop 反馈（沿用 dev-workflow
   第 10 步的既有约定，把 commit hash 写进 note）。

对 stage 结果的反应（全部 fail-closed，别绕）：

| 状态 | 含义与动作 |
| --- | --- |
| `MIXED` / `BLOCKED_MIXED` | 文件同时命中别的 Task。**能可靠区分**（你了解每处改动属于谁）→ 自己产出只含本 Task hunk 的 patch（`git diff -U3 -- <file>` 后手工裁剪），`stage --patch-file <f>`。**不能可靠区分** → 交回 dev-workflow 先理清修改边界，不为省事整文件提交 |
| `BLOCKED_WIDE` | diff 形状超过 Task 申报范围 → 回 dev-workflow 重查 Change Scope / 架构漂移（Change Isolation 信号）；确认合法后 `--allow-wide` |
| `BLOCKED_SECRET` | 疑似凭据。**永不自动放行**；确认是误报后由人工提交，真凭据则移出并按泄露处理 |
| `BLOCKED_UNSCANNABLE` | 二进制/超大文件做不了内容扫描。**人**确认不含凭据后才 `--allow-unscanned` |
| `BLOCKED_BRANCH` / `BLOCKED_DIRTY_INDEX` / `BLOCKED_CONFLICT` | 仓库状态不是脚本造成的 → 如实报告，人/dev-workflow 先恢复。**`BLOCKED_DIRTY_INDEX` 最常见的成因是你自己刚跑的 `git mv`**（mv 会自动进 index，而「做完就 `git mv` 进 `done/`」是 ADR-0083 的日常动作）：确认 staged 条目属于本 Task 后 `git restore --staged <paths>` 再 stage。真是他人并发编辑，才交回等待 |
| `NOTHING_TO_COMMIT` | 没有归属 diff —— 检查 paths 申报是否漏了 |

`foreign` 文件（不属于任何已申报 Task）**留在工作树，不碰、不报警**——
那是别的任务的现场。

## push 失败处理

- `NEEDS_SYNC`（remote ahead）：`sync`（fetch + rebase 本地未推送提交，只改写
  本地历史）。sync 会把相关 Task 的验证置为 **STALE**——在新基底上**重跑
  定向验证**后重新 `task-ready --verification PASS`，才 push 得出去。
  rebase 冲突会自动 abort 并返回 `CONFLICT` → 交回 dev-workflow。
- `BLOCKED_UNRECORDED_COMMITS`：分支上有没出处的提交——auto-push 不代推
  没过 Gate 的东西。「出处」查的是**全部** Change 清单的登记 + sync 登记 +
  已在 origin 上的历史（跨 Change 叠分支因此天然可行）。补救：
  `record-commit --hash` 逐个归属、冲突解决型 merge 用 `record-sync`，
  或交回用户决定。
- **push 发布的是整个祖先**：分支 push 会连带发布其历史里所有未上远端的
  提交（包括别的 Change / main 的未发布历史）。出处齐全只说明「可追溯」，
  不等于「有发布授权」——祖先里含**他人未授权发布**的提交时，把 push 交给
  用户裁决，不要让它变成一次没人声明过的发布。
- `NEEDS_WRITEBACK_COMMIT`：清单元数据待提交。`record-commit` 的返回里也带
  `writeback_needed` + `writeback_commands`（不 push 的流程同样要收尾巴）。
  建议命令永远是**两条分开跑**——`git add … && git commit …` 复合形式会被
  PreToolUse gate 在执行前整条评估：add 未跑、index 空、fail-closed 跑全量。
- 其余 `PUSH_FAILED`：读 detail，能定位（如网络）就修复重试；需要改写远端
  历史的一律停下升级给用户。

## Change 收口与合并（Merge Gate）

Task 级 push 与 Change 级 merge 严格分开。merge 的前提链：

1. dev-workflow 完成 Requirement / 验证 / 架构 / 收敛 / Done 检查，**且最终
   全量通过、无未闭合 P1**，才：`set-merge-gate --gate PASS --by "<依据>"`。
   「Requirement 检查」的判定形式是审查四闸的结论（[ADR-0088](../../../docs/adr/ADR-0088-traceability-and-requirement-fulfillment-review.md)
   决策 6）：**Requirement 全 `PASS` · Architecture 无 `FAIL` · Verification
   `SUFFICIENT` · 四个缺口标签一个不挂**。任一判据 `PARTIAL` / `FAIL` /
   `NOT_EVIDENCED` → Gate 不为 PASS，交回 dev-workflow 补齐，**不是问用户**。
   「收敛」含**仓库收敛**（ADR-0087）：卡已搬进 `done/` 或 `backlog/`、
   `docs/STATUS.md` 已重新生成、`.claude/tools/lifecycle_check.py` 零发现。
   这三条**不是额外动作** —— 守卫住在 `tests/tooling/`，最终全量跑到它；
   全量绿就等于它绿。
   **merge 不再需要用户点头**（产品负责人 2026-08-24 →
   [ADR-0085](../../../docs/adr/ADR-0085-merge-is-not-a-human-gate.md)）；
   `--by` 记的是**凭什么放行**（Done 判定 + 最终全量的结果），不再是用户原话。
   Gate 的存在意义因此变成两条纯机械的：**留痕**，以及**绑 tip**（见第 3 步）。
2. `premerge-sync` —— 把 latest main 合进 Change 分支，并把该 merge commit
   **登记进清单 `sync_commits`**（merge 豁免走登记制，不做结构推断——
   evil merge 可伪造亲子关系夹带内容）；冲突自行解决后的手工 merge 用
   `record-sync` 显式登记。返回 `needs_verification: true` 就重跑定向验证。
   merge 前须带 `--ledger-checked`：先读
   [待复审清单](../../../docs/design/active/pending-codex-rereview.md)确认没有
   覆盖本分支历史的未闭合条目（TASK-102 的教训：只查 verification 不查
   清单，含未补审修复的历史被合进了 main）。
3. `merge` —— 校验 Gate=PASS、树干净、main 已是祖先，推最终 tip，
   `--no-ff` 合入 main 并 push main。Gate 的 PASS 绑定在设 Gate 时的分支
   tip 上：premerge-sync / 新提交移动 HEAD 后会得到 `BLOCKED_STALE_GATE`
   ——只有在当前 tip 上**真的重跑过定向验证**才允许带 `--reverified` 重来。
4. `cleanup` —— 确认 merge 已在 origin/main 上后删本地+远端分支
   （`--keep-remote` 可留远端；远端分支若有 origin/main 之外的并发提交会
   拒删并返回 `WARN_REMOTE_CLEANUP`——那不是成功，如实上报）；最后把清单
   的收尾回写 commit 到 main。

premerge-sync / merge 冲突的分流规则（谁裁决）→ 读
[references/merge-and-conflicts.md](references/merge-and-conflicts.md)。
一句话版：**纯工程文本冲突**（import 顺序、相邻行、机械重命名）可自行解决
后重验证；触及 Requirement / 产品行为 / API 语义 / 架构合同的冲突一律
`merge-abort` 交回 dev-workflow；只有两个有效 Requirement 真冲突才升级用户。

## 并行 Change

多个 Change 并存 = 多个清单 + 多条分支。每次调用都显式带 `--change`/`--task`，
**从清单确认所有权，不猜**（「当前目录看起来像这个任务」不是依据）。无法
可靠识别当前 Change/Task → 不自动提交。

## Token 纪律

正常使用只读：当前清单（经 `status`）+ 脚本返回的 JSON。不读全部 Requirement、
不读 Change 历史、不读其他清单；merge 冲突时才读 reference 与冲突文件本身。
