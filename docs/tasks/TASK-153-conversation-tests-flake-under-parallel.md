# TASK-153：`test_motv_conversation_task109.py` 在 `-n 8` 并行下偶发红 —— 两天两条

- 状态：待办 · **未开始**（2026-09-18 立卡；按 [TASK-087 §6.17](TASK-087-followup-ledger.md)
  「再红一次就立卡」立的）
- 起因：闸门全量的并行阶段两天里红了两次，**同一个文件、两条不同的测试**，单跑与整文件
  串行跑都绿：
  - 2026-09-17 `test_the_answer_lands_in_the_page_it_was_ASKED_on`：`['agent','user'] !=
    ['user','agent']`（两条消息落进同一页，顺序反了）
  - 2026-09-18 `test_a_finished_run_lands_in_the_thread_on_READ`（TASK-152 修复提交前的
    定向验证；单跑 3/3 绿，整文件 79 条串行绿）
  · 闸：**放行条件未满足** —— 不在 REQ-009 交付面上；不阻塞主线（每次重跑就过）；
  不会造成不可逆损害；不是几分钟的事实修正 → **待办**。
- **什么条件下它变成该做**：再红第三次；或它挡住一次 merge 前的最终全量；或有人要动
  `server.py` 的 `_conv_reconcile` / 线程文件的写路径（那时顺手把根因查了）。
- 类型：Bug · 深度：STANDARD（U=STANDARD：根因未查，但形状清楚）
- 技术目标：闸门全量的并行阶段不因测试自身的隔离缺口报红 —— 一条偶发红会训练人「重跑
  就过」，那正是把真缺陷藏起来的习惯（TASK-087 §6.2 / §6.9 / §6.15 / §6.16 同族）。
- 架构约束：`CA §4`（studio 测试归 `tests/studio/`）；AGENTS.md §20（`-n 8` 是实测值，
  不退回串行）。
- 实施 Agent：**没写** —— 动手前先认领。

## 1. 先查什么（复现优先，不懂根因不连环 patch）

1. 两条红的测试是否共用**同一个**线程文件 / 项目名（`_conv_path(name)`）：xdist 把同一
   文件的测试分到不同进程，若 fixture 用了固定项目名或模块级临时目录，两个进程会互写
   同一份 `conversations` 文档 —— 「顺序反了」与「读时没落地」都是这个形状。
2. 排序键：`_conv_reconcile` 里 `createdAt` 取 `endedAt or startedAt or now()`，同一毫秒内
   两条 turn 的次序靠 `sorted` 稳定性 —— 并行下两条来自不同进程的记录时间戳可能同刻。
3. 用 `pytest -n 8 -p no:randomly tests/studio/test_motv_conversation_task109.py --count`
   一类的方式反复跑到复现，再改。

## 2. 不做什么

- 不把这个文件标成 `serial`（那个 marker 只给断言真实 OS 进程状态的测试用）。
- 不加重试装饰器 —— 重试是把偶发红藏起来，不是修。
