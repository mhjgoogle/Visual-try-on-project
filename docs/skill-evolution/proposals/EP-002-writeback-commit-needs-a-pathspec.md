# EP-002：回写命令的第二条没带 pathspec，在共享工作树上必然多带走别人的东西

- Skill：auto-push @ `d8156286faf8` · 证据：fb-0016（`manifest-writeback-dirty-tree`，
  该 key 第 4 次；前三次由 [EP-001](EP-001-stage-side-effects-are-undocumented.md) 归为机理 A/B，
  **本条是第三个机理 C**，EP-001 没覆盖）
- 状态：PENDING

## Problem / Root Cause Hypothesis

`_writeback_commands()`（`scripts/autopush.py:225`）给出的两条命令是：

```
git add -A -- docs/auto-push/changes/<id>.json
git commit -m "chore(auto-push): <id> manifest writeback"
```

**第一条带 pathspec，第二条不带。** 于是提交范围不是「我刚 add 的那个路径」，
而是**当时 index 里的全部内容**。这棵工作树上常态是 7–8 个会话共用一个 index，
所以「index 里只有我刚加的东西」这个隐含前提基本不成立。

2026-09-05 实测后果（TASK-136）：我照着跑这两条，提交 `80f1e42` 带走了另一个
会话 staged 的五份在制品（`credstore.py` / `imagegen.py` / `server.py` /
TASK-139 卡 / 一个 studio 测试），6 files changed。`reset --soft` + 带 pathspec
重提交已复原，未上远端。**同一天另一个会话（2a `04d980a`）以另一种触发方式中了
同一根因**，所以这不是一次手滑。

与 EP-001 的关系：EP-001 拆出的机理 A（回写次数多，机制固有代价）与 B（`stage`
副作用没写进文档）都不解释本条 —— 本条是**脚本自己发出的命令不安全**，
即使读者完全按文档做也会中。

## Proposed Change

给第二条加上同一个 pathspec（`autopush.py:234-235`）：

```
git add -A -- <rel>
git commit -m "chore(auto-push): <id> manifest writeback" -- <rel>
```

`git commit -- <path>` 是 partial commit：只提交该路径，index 里其他条目原样保留，
别人的 staged 内容既不被带走也不被清掉。两条仍然分开（保持原 docstring 说的
「永不给复合形式」，那条理由不变）。

**净增减：script +1 处修改（1 行）+ 2 行 docstring 说明；SKILL.md 第 106 行那句
「建议命令永远是两条分开跑」后面补半句「且第二条必须带同一个 pathspec」，+1 行。
合计净增 ~4 行，不新增规则条目。**

## Expected Benefit / 为什么现在值得改

**它修的不是「谁手滑」，是让那个窗口不再有杀伤力。** 2026-09-05 当天四次事故里
有三次的形状相同：核对 index 的那一刻是干净的，**几十秒后跑 commit 时已经不是** ——
另一个会话在这中间 stage 了东西。靠「提交前再看一眼」守不住一个持续几十秒、
且由别人决定何时结束的窗口；pathspec 让窗口里发生什么都不再要紧。

不是「更严谨」，是**已经造成过实际损失且必然复发**：这条命令是 `record-commit` /
`push` / `merge` / `cleanup` 之后每次都要跑的，跑它的时机恰恰是「刚提交完、别人
也在提交」的窗口。一行 pathspec 一次性消掉整类，而当前的替代方案是「每个会话
每次都记得自己手动加」—— 靠记性守的东西迟早漏，这是本仓库反复付过的学费。

## Regression Risk

**低。** 唯一行为差异是提交范围收窄到申报路径，而那正是意图。清单文件是 tracked
的（`init-change` 建 Change 时就提交），所以 partial commit 不会遇到「untracked
文件不能 partial commit」那条限制；第一条 `git add` 仍然保留，覆盖新建清单的场景。

## Protected Behavior Impact

无（`protected` 清单为空）。

## Files Likely Affected

- `.claude/skills/auto-push/scripts/autopush.py`（`_writeback_commands`，:225–236）
- `.claude/skills/auto-push/SKILL.md`（:106 那句的半句补充）
- `tests/tooling/test_auto_push_tooling.py`（若已有断言覆盖建议命令，跟着改；
  没有就补一条：**第二条命令必须含 pathspec**）

## Validation Plan

1. 重放本次 scenario：在 index 里放一个无关文件 staged，跑新的两条命令，
   断言该文件**没有**进提交、且仍留在 index 里；
2. `pytest tests/tooling/test_auto_push_tooling.py`（tooling 归属域，ADR-0080）；
3. 真实跑一次 `record-commit` → 按返回命令提交 → `git show --stat` 只含清单。
