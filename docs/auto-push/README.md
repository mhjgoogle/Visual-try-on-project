# auto-push 数据目录

`changes/<change-id>.json` —— 一个 Change 一个清单，由
`.claude/skills/auto-push/scripts/autopush.py` 创建与维护（TASK-101 /
ADR-0079）。人读任务卡（`docs/tasks/TASK-*.md`），机器读这里；两者经
commit hash 互相印证。

放 `docs/` 而不是 `.claude/` 与 skill-evolution 同理：commit gate 把
`docs/` 归 lint 档，高频元数据回写不该每次都背全量 pytest。

清单 schema v1 要点：

- `change_id` / `branch` / `status`（open → merged → closed）/ `chain_mode`
- `tasks.<TASK-ID>`：`paths`（该 Task 的 diff 归属 pathspec）、
  `verification`（PASS/FAIL，由 dev-workflow 申报）、`verification_ref`、
  `commits[]`（hash / subject / time / pushed / scope_violation）
- `merge_gate`：`status` + `by`（用户指示合并的原话+日期）+ `time`
- `merge`：merge commit hash / time / pushed
- `cleanup`：local_deleted / remote_deleted / time

清单是 Git 追溯链的机器可读端：
`REQ → TASK → commit → push → merge`，双向可查。
不要手工编辑；状态错了用脚本命令纠正，实在不行删除清单重新 `init-change`
（历史 commit 记录会丢——先确认没人引用）。
