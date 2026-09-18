# TASK-153：`test_motv_conversation_task109.py` 在 `-n 8` 并行下偶发红 —— 两天两条

- 状态：进行中 · **根因已查实并修复，待独立审查收口**（§3）· **第三次红了，放行条件成立，开工**（2026-09-18 立卡；同日 CI `main@6c627af`
  Windows job 的并行阶段第三条测试 `test_a_malformed_answer_reaches_the_creator_as_a_failure`
  红：`KeyError: 'failure'`，Ubuntu 同一提交绿 —— 那次提交是**纯文档**，所以这不是回归，
  是并行隔离缺口的第三个样本。卡上写的「再红第三次」条件成立）
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
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领，TASK-154 审查收口后开工）。
- L5 自动实施授权：产品负责人 2026-09-18「那现在能对这些任务进行编排然后一个个完成了吗」
  —— 它挡的是这条链自己的闸门（CI / 全量），属于「阻塞在办主线」。

## 3. 根因与修法（2026-09-18，实施）

**根因（一个，解释三条红）**：问题那一轮的时间戳与答案那一轮的时间戳来自**两个时钟**。
`_conversation_post` 给用户轮取 `datetime.now(timezone.utc).isoformat()` —— 微秒级、
`+00:00` 格式，而且在 `runs().create()` **之后**才取；读时对账给答案轮取 run 的 `endedAt`
—— 登记表的时钟 `_now_iso`，**秒级**、`Z` 格式。测试里的假执行器立刻答完：只要 run 的
`endedAt` 落在第 N 秒、用户轮的戳落在第 N+1 秒（跨过整秒边界），`"…:40.001+00:00" >
"…:39Z"`，线程按戳排序后**答案排在问题前面**。三条测试都拿 `turns[-1]` 当答案，于是各自
以不同样子红：顺序反了（§6.17 第 1 条）、`KeyError: 'failure'`（最后一轮是用户轮，没有
`failure`）、「答案没落进线程」（同理）。`-n 8` 下 CPU 争用把「建 run → 取戳」那个窗口
拉宽，所以只在并行阶段现身；§1 猜的「共用线程文件」不成立（`app` 夹具是 `tmp_path`，
每条测试各一份）。

**修法（两处，都在 `server.py`）**：

1. 用户轮的 `createdAt` 取 **run 自己的 `createdAt`** —— 同一个时钟、同一种格式，且
   `createdAt ≤ endedAt` 由构造保证；`datetime.now()` 只剩没有 run 戳时的兜底。
2. 读时对账的排序键 `_conv_turn_order = (createdAt, 0 if user else 1)`：同一秒内两戳
   字符串相等，次序由角色定 —— 问题在前。只靠 `sort` 稳定性不够：对账把答案 append 在
   整条线末尾，而问题可能早就在中间。

**守卫**（`tests/studio/test_motv_conversation_order_task153.py`，4 条）：问题的戳**就是**
run 的 `createdAt`（`Z` 格式）· 用一个快 5 秒的假 `datetime` 放大旧行为的窗口仍先问后答 ·
把登记表时钟钉死在一秒内（两戳相等）仍先问后答且重读不重排 · 排序键本身。
**实测**：`test_motv_conversation_task109.py` + 新文件 83 条在 `-n 8` 下连跑 3 次全绿。

**没做**：没加重试、没标 `serial`（§2 说过不做）。

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
