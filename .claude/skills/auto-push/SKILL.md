---
name: auto-push
description: >-
  Auto Push — deterministic Git execution after dev-workflow decides. INVOKE in
  exactly two cases: (1) Task-level — dev-workflow has declared the current
  task DONE with targeted verification PASS: attribute the diff, stage only
  this task's changes, hand the commit command to the shell (so the commit
  gate runs), record metadata, push the change branch — no per-push user
  confirmation; (2) Change-level — the user has explicitly instructed merging
  this Change: set the merge gate, sync latest main, re-verify, merge --no-ff
  into main, push main, clean up the branch. DO NOT invoke: to decide whether
  a task or requirement is done (dev-workflow's job), while verification is
  failing, for repos without a Change manifest (run init-change first), or to
  force-push / rewrite remote history (always forbidden).
---

# auto-push — Task 级自动 commit/push 与受控合并（v0.1）

**dev-workflow = 决策权，auto-push = Git 执行权。** 本 Skill 永不判断
「需求是否完成」，也永不改产品行为。机制决策见 ADR-0079；数据在
`docs/auto-push/changes/<change-id>.json`（一个 Change 一个清单）。

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
init-change --change <id> --branch <name> [--adopt] [--chain]
```

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
3. 把返回的 `commit_command` **原样在 shell 运行**（gate 按 ADR-0060 分档跑
   检查），然后 `record-commit --task T` 回写 hash。
4. `push` —— 成功即完；`NEEDS_SYNC` 见下。
5. push 成功后做一次 skill-evolution Fast Loop 反馈（沿用 dev-workflow
   第 10 步的既有约定，把 commit hash 写进 note）。

对 stage 结果的反应（全部 fail-closed，别绕）：

| 状态 | 含义与动作 |
| --- | --- |
| `MIXED` / `BLOCKED_MIXED` | 文件同时命中别的 Task。**能可靠区分**（你了解每处改动属于谁）→ 自己产出只含本 Task hunk 的 patch（`git diff -U3 -- <file>` 后手工裁剪），`stage --patch-file <f>`。**不能可靠区分** → 交回 dev-workflow 先理清修改边界，不为省事整文件提交 |
| `BLOCKED_WIDE` | diff 形状超过 Task 申报范围 → 回 dev-workflow 重查 Change Scope / 架构漂移（Change Isolation 信号）；确认合法后 `--allow-wide` |
| `BLOCKED_SECRET` | 疑似凭据。**永不自动放行**；确认是误报后由人工提交，真凭据则移出并按泄露处理 |
| `BLOCKED_BRANCH` / `BLOCKED_DIRTY_INDEX` / `BLOCKED_CONFLICT` | 仓库状态不是脚本造成的 → 如实报告，人/dev-workflow 先恢复 |
| `NOTHING_TO_COMMIT` | 没有归属 diff —— 检查 paths 申报是否漏了 |

`foreign` 文件（不属于任何已申报 Task）**留在工作树，不碰、不报警**——
那是别的任务的现场。

## push 失败处理

- `NEEDS_SYNC`（remote ahead）：`sync`（fetch + rebase 本地未推送提交，只改写
  本地历史）→ 按返回的 `needs_verification` **重跑定向验证** → 再 `push`。
  rebase 冲突会自动 abort 并返回 `CONFLICT` → 交回 dev-workflow。
- `NEEDS_WRITEBACK_COMMIT`：清单元数据待提交，运行返回的 `suggested` 命令
  （docs-only，gate 走 lint 档）即可继续。
- 其余 `PUSH_FAILED`：读 detail，能定位（如网络）就修复重试；需要改写远端
  历史的一律停下升级给用户。

## Change 收口与合并（Merge Gate）

Task 级 push 与 Change 级 merge 严格分开。merge 的前提链：

1. dev-workflow 完成 Requirement / 验证 / 架构 / 收敛 / Done 检查，**且用户
   明确指示合并**（AGENTS.md §22 对 merge 的要求不变），才：
   `set-merge-gate --gate PASS --by "<用户原话+日期>"`。
2. `premerge-sync` —— 把 latest main 合进 Change 分支；返回
   `needs_verification: true` 就重跑定向验证。
3. `merge` —— 校验 Gate=PASS、树干净、main 已是祖先，推最终 tip，
   `--no-ff` 合入 main 并 push main。
4. `cleanup` —— 确认 merge 已在 origin/main 上后删本地+远端分支
   （`--keep-remote` 可留远端）；最后把清单的收尾回写 commit 到 main。

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
