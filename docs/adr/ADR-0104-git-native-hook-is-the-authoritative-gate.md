# ADR-0104：权威的提交闸门是 git 原生 hook，`PreToolUse` 降级为快反馈

- 状态：**Accepted**（2026-09-16，实施 Agent 依 AGENTS.md §1 自行 Accept ——
  技术决策，不涉付费、不动用户数据，且完全可逆：删掉一个 shim 就回到今天）
- 取代：[ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md) 决策 1
  「PowerShell-native gate 是权威实现」这条**实现约定**；决策 2–4 不动
- **不取代** [ADR-0070](ADR-0070-commit-gate-intent-by-shell-parser.md)：它定的是
  `PreToolUse` 那一层怎么从命令文本判定 commit 意图，而那一层在本 ADR 之后继续存在
  （降级为 early feedback），所以它的决策原样有效。ADR-0050 决策 1 此前已被它局部
  取代过一次，本 ADR 取代的是**另一半**（权威归属），两次互不覆盖
- 关联：[TASK-148](../tasks/TASK-148-l5-continuous-autonomous-delivery.md) 切片 A ·
  [TASK-147](../tasks/TASK-147-session-isolation-and-evidence-identity.md) §6.2/§6.3 ·
  [TASK-143](../tasks/TASK-143-one-worktree-per-session.md)「第 8 种形状」

## 背景：闸门有两个洞，而且两个都是实测出来的

ADR-0050 把闸门实现成 `PreToolUse` 钩子里的原生 PowerShell 脚本。这个位置有两个
问题，都不是设计时能预见的，是跑出来的：

1. **它会静默不触发。** 14 次提交尝试中 5 次 `PreToolUse` 未被调用，**不可由命令
   形状复现**（TASK-147 §8 实测记录）。一个会安静消失的触发器**不能**是唯一防线。
2. **它只覆盖会话自己那棵树。** 钩子按会话的 `CLAUDE_PROJECT_DIR` 定根，命令里的
   `cd` 换得掉 git 的树、换不掉钩子的树。2026-09-16 实测：在 `motv-wt/pilot-143`
   里暂存一个 ruff 必报三项的文件，`cd <worktree> && git commit` **直接成功，
   闸门零输出**。

第 2 条格外要紧，因为 [TASK-147](../tasks/TASK-147-session-isolation-and-evidence-identity.md)
刚刚把「每个会话一棵工作树」变成推荐做法 —— **那个动作本身就是让闸门失效的动作。**

两条合起来还有一个更难察觉的后果：**闸门的沉默有两种含义** —— 「检查全过了」和
「它根本没跑」，从输出上分不出来。

## 决策

### 1. `.git/hooks/pre-commit` 是权威 enforcement

实现是被跟踪的 `.claude/hooks/pre_commit.py`；`.git/hooks/pre-commit` 只是一层
不含仓库路径的 shim，由 `.claude/tools/install_git_hooks.py` 写入。

这不是「多加一道检查」，是**把三个问题结构性地消掉**：

| 原来的问题 | 在 git 原生 hook 里为什么不存在 |
| --- | --- |
| 客户端可能不调用钩子 | 触发权在 git 手里，没有「要不要调用」这一层 |
| 定根定到会话那棵树 | hook 的 cwd 就是**正在被提交的那棵树**，按构造成立 |
| 要从命令文本猜意图（ADR-0070 那整层 shell 词法分析） | git 已经知道这是一次 commit、写的是 index 还是 worktree |

覆盖面靠 git 自己：`git rev-parse --git-path hooks` 在**任何** worktree 里都解析到
主仓的 `.git/hooks`（2026-09-16 实测，`tests/tooling/test_git_native_gate.py` 钉住）。
**装一次覆盖所有树** —— 不需要遍历工作树，也没有「N 棵树 N 份工装要同步」。

### 2. `PreToolUse` 不删除，降级为 early feedback

在命令真正跑起来之前给出快反馈仍然有价值（它能在 git 启动前就拦住），
`inspect_command` 那层对「同一条命令里带 push/merge」这类**命令级**约束也仍然是
唯一能看见的地方。它只是不再是**唯一**防线，因此它漏掉一次不再等于放行一次。

一个直接推论：ADR-0062 决策 3 要求 `.ps1` 与 `.sh` 给出相同判定 —— 那条继续管
`PreToolUse` 那一层的两个实现。**权威这一层只有一个实现**（Python，平台中立），
所以它不需要行为合同表，也不会再出现「两个实现两个判定」。

### 3. 权威层用 Python，不用 PowerShell —— 这正是取代 ADR-0050 决策 1 的地方

ADR-0050 当初选 PowerShell-native 的理由是：从 PowerShell 钩子里调 `bash` 会唤醒
WSL 虚拟机。这个理由在新位置**不成立** —— Windows 上 git 用自带的 MSYS2 `sh.exe`
跑 hook（与 WSL 无关），而 shim 里唯一做的事就是转交给 Python。

于是原来为了躲开 WSL 而付出的「两份实现 + 一张行为合同表」不再需要付。

### 4. 连续修改链的一次性开关**不迁移**

ADR-0068 的 `MOTV_CONTINUOUS_CHAIN=1` 写在**提交命令最前面**，由 `PreToolUse` 从
命令文本里读。git 原生 hook 看不到命令文本，唯一的替代载体是环境变量 ——
而 AGENTS.md §20 写的是「**不是环境变量**，不得持久化」。

那句话不是文体偏好：命令前缀天然只活一条命令，环境变量一个 `setx` 或一行 profile
就永久生效，而同一节还写着「不存在永久关闭测试的全局开关」。

**所以不换载体，直接不实现。** 代价明确且朝严的方向：链的中间提交在权威闸门这里
拿到的是按归属映射该跑的那些测试，而不是「跳过」。快反馈那层仍按原样提供。

### 5. 检查的对象是**索引**，不是工作区

`ruff` 在「索引物化出来的快照」里跑，不在工作树里跑。

这条是 codex 2026-09-16 审查报出来的 P1，而且它正好击中本 ADR 的立论：闸门查工作区、
git 提交索引，于是**暂存一个违规版本、再在工作区把它改干净但不暂存**，违规版本就能
提交成功 —— 与本 ADR 要消灭的「闸门在场却没拦住」是同一类，只是换了个机理。

**范围仍然是全仓**：快照是 `git checkout-index -a` 出来的整棵索引，不是「只查改动的
那几个文件」—— 后者被 TASK-143 的 OUT OF SCOPE 点名为免罪符。变的只是**查哪一份全仓**。

同时**去掉了 `git diff --check`**（工作区空白字符那条），保留 `git diff --cached --check`。
这是一个**范围决定，不是放松**：前者问的是「你还没暂存的东西里有没有空白问题」，
那与这次提交无关，而且正是 TASK-143 第 2 种形状（别人的在制品挡住我的提交）的同一个
机理。`gate.ps1` 那一层两条都留，因为它本来就在看整条命令。

附带一条：git 跑 hook 时导出的仓库身份变量（`GIT_DIR` / `GIT_INDEX_FILE` /
`GIT_WORK_TREE` 等）**不传给子进程**。不摘的话，pytest 在临时仓库里建的每一条 git
都会指回正在提交的那个仓库 —— 测试要么莫名失败，要么改到真仓库上去。

### 6. 铺开的时机绑在「闸门文件在不在这棵树上」

shim 在找不到 `.claude/hooks/pre_commit.py` 时 **fail-closed**（拦住并说清楚），
因为一个安静消失的闸门就是没有闸门。推论：**在这份实现合并进 `main` 之前不得装**
—— 装了会把还没有这个文件的其他分支上的会话一起拦住。安装因此是**合并时的动作**，
不是开发时的动作。（2026-09-16 本卡开发中实测撞到：装上之后同仓另外两个会话的树
上没有这个文件，他们的提交会被拦。当场撤销。）

## 代价（已接受）

- **闸门现在会真的拦住所有人。** 这是目的，但意味着之前靠「反正它经常不触发」
  滑过去的提交不再滑得过去。这不是新增严格度 —— 是让既有严格度真的生效。
- **`.git/hooks` 不随仓库分发。** 新克隆必须跑一次安装器。因此
  `install_git_hooks.py --check` 存在，并应当进体检（`motv_doctor.py`）——
  本 ADR 只定权威归属，接线留给 TASK-148 收口。
- **一份实现只覆盖 `pre-commit`。** `pre-push` / `commit-msg` 不在本 ADR 范围内。
