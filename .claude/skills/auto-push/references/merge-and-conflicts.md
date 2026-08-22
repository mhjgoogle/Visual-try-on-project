# auto-push — 合并与冲突处理（只在 Change 收口时读）

## 前提回顾

- Merge Gate 只有 dev-workflow 能设 PASS，且其依据必须是**用户明确指示合并**
  （`--by` 记录原话+日期）。没有 PASS，`merge` 会以 `BLOCKED_MERGE_GATE` 拒绝
  ——这不是可以绕的检查。
- 合并策略固定为 `--no-ff` merge commit：本仓库 main 此前无合并历史（无既有
  惯例），选可追溯、不改写历史的最简策略（ADR-0079 决策 5）。不做 squash、
  不做 rebase-onto-main、不做任何远端历史改写。

## premerge-sync 冲突分流

`premerge-sync` 冲突时**留在原地**（不自动 abort），返回冲突文件清单。
按下表分流；拿不准一律按更严一档处理：

| 冲突落点 | 类别 | 谁处理 |
| --- | --- | --- |
| import/依赖清单顺序、相邻但无关的行、机械重命名的两侧、纯格式 | 工程文本冲突 | auto-push 语义层（你）直接解决：逐文件编辑掉冲突标记，`git add` 后 `git commit`（gate 照常拦截），**然后必须重跑定向验证** |
| `docs/requirements/`、`docs/adr/`、`docs/design/` 合同文档、`docs/product_spec.md` | Requirement / 合同 | `merge-abort` → 交回 dev-workflow |
| API/接口签名、schema、持久化格式、业务规则分支、跨层合同（双方都改了含义） | Semantic conflict —— git 能合但行为可能错 | `merge-abort` → 交回 dev-workflow：读当前有效 Requirement + 两个 Change 的意图，裁定最终行为 |
| module boundary、shared/core、依赖方向 | Architecture conflict | `merge-abort` → dev-workflow 触发 Architecture Governance（其第 6 步），auto-push 等结果 |

**Semantic conflict 的雷达不只在文本冲突里**：premerge-sync 干净通过但
`needs_verification` 的重验证挂了，同样按 semantic conflict 交回 dev-workflow
——git 自动合并成功恰恰是它最危险的形态。

只有当 dev-workflow 判定**两个都有效的 Requirement 真正冲突**时才升级用户，
问法按 AGENTS.md §1：「我打算按 X 裁定，因为 Y，代价 Z——要拦吗？」

## merge 的状态与恢复

| 状态 | 恢复动作 |
| --- | --- |
| `BLOCKED_NOT_SYNCED` | 先 `premerge-sync` + 重验证 |
| `BLOCKED_STALE_GATE` | HEAD 已离开 Gate 绑定的 tip——在当前 tip 上重跑定向验证，然后 `merge --reverified`。**没重跑就带 --reverified 是在向清单说谎** |
| `NEEDS_WRITEBACK_COMMIT` | 跑返回的 `suggested` 命令再来 |
| `BLOCKED_MAIN_DIVERGED` | 本地 main 与 origin/main 分叉——不属于本 skill 的现场，如实报告给用户裁决 |
| `MAIN_PUSH_FAILED` | merge 已落本地 main 但 push 被拒（多半是竞态：别人刚推了 main）。**不 force。** 恢复路径：先确认 `git log origin/main..main` 里**只有**我们这次的 merge commit（它可重建、无独有内容），然后 `git switch main && git reset --hard origin/main` 把本地 main 退回远端，回到 Change 分支重走 premerge-sync → 重验证 → merge。若 origin/main..main 里还有别的东西，停下升级用户 |
| `MERGE_FAILED` | premerge-sync 后理论上不该发生；已自动 abort 并切回 Change 分支，如实报告 |

## cleanup 规则

- 只有 merge hash 确认已在 `origin/main` 上才删分支（脚本强制）。
- 本地删除用 `-d`（安全删除），永不 `-D`。
- 远端删除是默认行为；仓库若要保留历史分支（如现存 `feat/m1-minimal-loop`
  的旧习惯），传 `--keep-remote` 并在任务卡记一句。
- cleanup 之后清单最后一次变脏（closed 状态回写）——在 main 上跑一次
  `chore(auto-push)` 回写 commit 并 push，Change 才算真正归档。

## 与 skill-evolution 的联动

Change 级 merge 完成（或任一 task push 成功）后，按 skill-evolution 的
Fast Loop 记一条反馈：note 里带 commit/merge hash 与本次使用中的真实摩擦
（例如某个 BLOCKED 状态是否误报）。auto-push 不做 Evolution Review，
只供证据。
