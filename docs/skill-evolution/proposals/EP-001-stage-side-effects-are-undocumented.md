# EP-001：`stage` 的两个副作用没写在 SKILL.md 里，各自造成过实际损失

- Skill：auto-push @ `9e8d8cfb0bd7` · 证据：
  fb-0010（`manifest-writeback-dirty-tree`）· fb-0011（`skill-doc-flag-drift` 末段）·
  TASK-133 本次（同形状，未单独记）· fb-0014（`stage-overwrites-commit-msg`）
- 状态：PENDING

## Problem / Root Cause Hypothesis

**触发本次 Review 的 key 混装了两个机理**，这是它看起来「复发 3 次却修不动」的原因：

| 机理 | 条目 | 性质 |
| --- | --- | --- |
| **A** writeback 提交次数多（每 Change 1–4 个 chore 提交） | fb-0001 · fb-0012 | 机制的**固有代价**，要改就得动自动提交，风险高 |
| **B** `stage` 的副作用没写明，撞上才知道 | fb-0010 · fb-0011 · TASK-133 | **纯文档缺口**，修法极小 |

B 的两个具体副作用，都不在 SKILL.md 的「对 stage 结果的反应」表里：

1. **`stage` 遇到 index 已有条目就拒绝**（`BLOCKED_DIRTY_INDEX`）。最常见的成因不是
   别人的并发编辑，而是**自己刚跑过的 `git mv`** —— 而 `git mv` 正是 ADR-0083「做完了
   就 `git mv` 进 done/」的日常动作。表里那行只说「仓库状态不是脚本造成的 → 如实报告，
   人/dev-workflow 先恢复」，读起来像外部故障，不像「你自己上一步干的，`git restore
   --staged` 一下就好」。fb-0010 当时就写了「skill 该提一句」，fb-0011 又提了一次。
2. **`stage` 会重新生成 `.claude/tmp/autopush-commit-msg.txt`**。TASK-133 里我在第一次
   stage 后往该文件写了长正文，被 gate 拦下后重新 stage，文件被覆盖回一行标题；我没重读
   就做字符串替换，替换没匹配到任何内容，最终提交信息只剩标题行。amend 补救又因 index
   为空、gate fail-closed 到全量而被外部在制品挡住。

## Proposed Change（最小）

只改 `SKILL.md`，**不动任何脚本行为**：

1. 「对 stage 结果的反应」表里 `BLOCKED_DIRTY_INDEX` 那行，补一句成因与解法：
   「常见成因是**你自己刚跑的 `git mv`**（mv 会自动进 index）；确认 staged 条目属于本
   Task 后 `git restore --staged <paths>` 再 stage。真是他人并发编辑才交回等待。」
2. Task 循环第 3 步（跑 `commit_command`）补一句：
   「`stage` 每次都会**重新生成** commit 信息文件 —— 要写长正文就在 stage **之后**写，
   且中途若因 gate 拦截再次 stage，正文要重写。」

**净增：+4 行**（两处各 2 行），无删除。

**收敛必答**：本次未找到可删/可合的重复规则 —— 这两条覆盖的是既有规则**没有覆盖**的
副作用，不是已有规则的重复表述，所以是 append 而非 merge。SKILL.md 现有的
`NEEDS_WRITEBACK_COMMIT` 那条「两条分开跑」的告诫（fb-0007 的产物）与本次两条同属
「工具副作用要写明」一族，但措辞与位置都不重叠，合并反而会把三件事塞进一段。

## Expected Benefit

fb-0010 与 fb-0011 都明确写了「提示里可以直接给出 reset 建议」却一直没做，TASK-133 又
撞了同一处 —— **三次真实使用、同一个解法被提了三次**。第 2 条的代价更具体：一次提交
信息丢失 + 一次无法 amend 的补救尝试。

## Regression Risk

**低**。纯文档补充，不改脚本、不改 CLI、不改任何判定逻辑。protected 清单为空。

## Protected Behavior Impact

无（`review-context` 返回 `protected: []`）。

## Files Likely Affected

- `.claude/skills/auto-push/SKILL.md`（唯一）

## Validation Plan

1. `pytest tests/tooling/test_auto_push_tooling.py`（该 Skill 的归属测试）；
2. 重放场景：`git mv` 一张卡进 `done/` → `stage` → 确认返回的
   `BLOCKED_DIRTY_INDEX` 与新文档描述一致（脚本行为不变，验证的是文档没说错）；
3. `python .claude/tools/lifecycle_check.py` 零发现。

## 对机理 A 的处置

**不改，保持 OBSERVING。** 它是「清单要落盘 + 落盘就要提交」的固有代价，唯一的真修法是
自动 writeback，而那会让脚本自己执行 `git commit` —— 直接撞上 auto-push 的第一条铁律
（「脚本永不执行 `git commit`」，为的是让 commit gate 拦得住）。在没有更好想法之前，
把它记着比匆忙改掉好。
