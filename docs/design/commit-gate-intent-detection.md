# commit gate 的意图判定：从正则读命令文本，改成用每个 shell 自己的解析器

- 状态：**已实施**（2026-08-16，[TASK-085](../tasks/TASK-085-gate-intent-detection.md)）。
  决策已固化为 [ADR-0070](../adr/ADR-0070-commit-gate-intent-by-shell-parser.md)。
  实施中与本方案的三处偏差已就地标注（§4 决策 4、§6），**以 ADR-0070 为准**。
- 来源：[待复审清单](pending-codex-rereview.md)「仍然待办」第 3 项 → [TASK-084](../tasks/TASK-084-clear-the-push-gate.md) §3
- 依据：[ADR-0050](../adr/ADR-0050-native-windows-commit-gate.md) 决策 1（两 shell 同一行为合同）、
  [ADR-0062](../adr/ADR-0062-windows-authoritative-environment.md) 决策 3（两实现必须给出相同判定）、
  [ADR-0068](../adr/ADR-0068-continuous-modification-chain.md) 决策 6/7（链令牌与 push/merge 冲突扫描）

## 0. 这份文档要回答的问题

本卡**只出方案，不实施**。要回答的是三件事：

1. PreToolUse hook **能不能拿到结构化 argv**？（先查，不假设）
2. 能 → 改造方案与影响面是什么？
3. 不能 → 退而求其次的判定是什么，它的**已知漏洞边界**在哪（诚实标注，不假装堵死）。

## 1. 根因：不是漏了一种写法

清单里这两条是症状，不是病：

- `git "commit"` —— 引号形式，gate 的 `commit` token 正则不匹配，**gate 直接不跑**，
  提交零检查通过；
- `git "-C" other commit` —— 引号形式的重定向检测不到，检查跑在**另一个仓库**的
  结论上却为这个仓库背书。

病是：**靠正则匹配命令文本判断意图**。宽了误伤（提交信息里写 push 就被拦），
窄了漏掉（加一对引号就绕过），而每加一种变体的匹配，都只是把边界往外挪一格，
不会收敛。这与 TASK-077 跨源那条是同一个教训：那次也是修了两遍拼写，第三轮才改成
断言性质。**所以不要再加第三种写法的匹配。**

gate 自己的注释其实已经承认了这一点：

> TWO INDEPENDENT TOKEN TESTS, deliberately NOT a parse of git's argument grammar.
> A regex cannot reliably parse a shell command line …

判断是对的，结论下反了：正则确实解析不了 shell 命令行——**但 shell 自己可以**。

## 2. 问题 1 的答案：harness 不给 argv，但给了「这是哪个 shell」

**实测**（不是推测）。PreToolUse 的 payload 结构从已安装的 claude CLI 二进制里读出：

```
hook_event_name:"PreToolUse",tool_name:e,tool_input:r,tool_use_id:t
```

（`C:\Users\MO\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，
2026-08-16 实测，claude 2.1.232。）

结论分两半：

- **拿不到 argv。** `tool_input.command` 是一整串**原始文本**。命令在 hook 之后才交给
  shell，此刻还不存在 argv——harness 没有可给的结构化参数。
- **但拿得到 `tool_name`**（`Bash` 或 `PowerShell`，正是 settings.json 里
  `"matcher": "Bash|PowerShell"` 匹配的那个字段）。**两个 gate 目前都只读
  `tool_input.command`，把 `tool_name` 丢掉了。**

这一半改变了结论。「解析不了」的真正原因不是文本不可解析，而是**同一段文本在两种
grammar 下含义不同**，而 gate 不知道该用哪一种。`tool_name` 正是那个缺失的输入。

## 3. 两个 shell 各自都有真解析器（实测）

### POSIX（`tool_name == "Bash"`）→ Python `shlex`

| 命令文本 | `shlex.split` 结果 | 今天的正则 |
| --- | --- | --- |
| `git "commit" -m "x"` | `['git','commit','-m','x']` | **漏**（gate 不跑） |
| `git "-C" /other commit -m y` | `['git','-C','/other','commit','-m','y']` | **漏**（重定向检测不到） |
| `g""it commit` | `['git','commit']` | **漏** |
| `git commit -m "say push here"` | `['git','commit','-m','say push here']` | **误伤**（消息里的 push 被当成 push） |

四条全部解决，含**今天两条已知漏洞**和一条已知误伤。`shlex` 是 stdlib，
`commit_gate_policy.py` 已经是 Python，零新增依赖。

### PowerShell（`tool_name == "PowerShell"`）→ PowerShell 自己的 AST

```powershell
[System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$t, [ref]$e)
# → CommandAst.CommandElements，取 .Value 得到去引号后的值
```

实测 `git "commit" -m "a b" ; git c""ommit` →
`CMD: git | commit | <CommandParameterAst> | a b` 与 `CMD: git | commit`，
即**两条命令分别切开、引号已解、拼接形式也还原**。这是 PowerShell 用来执行命令的
同一个解析器，不是又一个近似。

## 4. 方案

### 决策 1：判定输入从「命令文本」改成「(tool_name, 结构化 token)」

`commit_gate_policy.py` 已经是**唯一决策点**（TASK-076 §1.2：两个 shell 只负责转运）。
把 tokenize 也收进这条线：

```
gate.ps1 / gate.sh
  ├─ 读 payload：tool_name + tool_input.command      ← 现在多读一个字段
  ├─ tool_name == "PowerShell" → 用 PS AST 切成 argv 列表（只有 gate.ps1 会遇到）
  └─ 把 --tool-name / --command（PowerShell 时另加 --argv-json）交给 policy
        └─ policy：tool_name == "Bash" → shlex 切分（两平台同一份代码，天然一致）
           policy：在 token 上做全部判定，返回 JSON
```

为什么 POSIX 切分放在 Python 而不是各自 shell 里：**两平台必须给出相同判定**
（ADR-0062 决策 3），而「同一份代码」是唯一不会漂移的实现方式——两个 shell 各自
匹配令牌，正是它们当初分歧的原因（`-like` 大小写不敏感 vs `grep -F` 敏感）。
PowerShell 语法只能由 PowerShell 解析，所以那一段留在 `gate.ps1`，但它**只做切分、
不做判定**。

### 决策 2：五个判定全部改成 token 判定

| 判定 | 今天 | 改后 |
| --- | --- | --- |
| 是不是 `git commit` | 两条正则（`namesGit` && `namesCommit`）在整串文本上找 | 存在一条简单命令，其**命令名**为 `git`/`git.exe`，且其参数中第一个非选项 token 为 `commit` |
| 是否重定向到别的仓库 | `-cmatch '(^\|\s)(-C(\s\|$)\|--git-dir…)'` | argv 中存在 token `-C` / `--git-dir` / `--git-dir=…` / `--work-tree`（**精确 token 比较，天然区分 `-c`**，不再依赖大小写敏感的正则技巧） |
| 是否 `-a/--all`（决定 diff 取 index 还是 HEAD） | 正则 | argv 中存在 token `-a` / `--all`（且在 `commit` 之后） |
| 链令牌 `MOTV_CONTINUOUS_CHAIN=1` | 行首锚定正则 `_CHAIN_RE` | **保持不变**，见决策 3 |
| push/merge 冲突扫描（ADR-0068 决策 6） | 去引号后整串找五个动词 | 每条简单命令：命令名为 git 时看它的子命令 token；并保留「任一命令名本身是这五个动词」的兜底 |

### 决策 3：链令牌**不动**——它本来就不是一条命令

`MOTV_CONTINUOUS_CHAIN=1` 在 Bash 里是赋值前缀，在 PowerShell 里写成**行首注释**
（`# MOTV_CONTINUOUS_CHAIN=1`）。而 **PowerShell 的 AST 会把注释丢掉**——用 AST 读它
反而读不到。它对 shell 本身是惰性的，靠的正是「位于命令最前面」这个文本位置，
所以行首锚定的文本匹配是**对的判定方式**，不是遗留缺陷。**这一条不要顺手改。**

### 决策 4：解析失败 = fail-closed，且这是本方案唯一放宽不了的地方

今天：Phase A 任何异常 → `exit 0`（不拦）。理由是「坏掉的探测器不能拦住无关命令」。
改后：**区分两种失败**——

- 「这不是一条 commit」→ 照常 `exit 0`（不变）；
- 「**没能判断出这是不是 commit**」（shlex `ValueError`、PS parse error、
  `tool_name` 缺失或是未知工具）→ **当成可能是 commit，跑完整检查**。

代价是偶尔多跑一次检查；今天的代价是**静默放行一次未检查的提交**。这两边不对等。

**实施补充（TASK-085）**：fail-closed 必须**能复合**，本方案原文没写到这一层——

- 读不懂的命令同时**丧失链令牌的减档授权**。令牌是文本位置判定（决策 3），
  所以它在读不懂的命令上照样匹配得上；不压掉就会出现最坏组合：**一条读不懂的
  命令拿到了跳过全量的授权**。（这一条首轮变异验证存活，是实打实的缺口。）
- 读不懂时**不去问 `git diff`**，直接全量：暂存路径回答的是关于本仓库的问题，
  而那条读不懂的命令未必是关于本仓库的。
- 「分类器跑不起来」也算判断不出来，因此也 fail-closed。后果见
  [ADR-0070 后果](../adr/ADR-0070-commit-gate-intent-by-shell-parser.md#后果)。

### 决策 5：Phase A 不再做文本预筛，直接交给 policy

今天 gate 用两条正则决定「要不要往下走」。任何文本预筛都会**重新引入本方案要消除的
那类漏洞**（`g""it`、`"com"mit` 都能骗过任何 substring 预筛）。

代价已实测：`commit_gate_policy.py` 冷启动 **约 126 ms/次**（Windows，10 次平均）。
这意味着**每一次 Bash/PowerShell 工具调用**多 ~126 ms。判断：可接受——它换掉的是
「gate 静默不跑」这一类，而 gate 不跑的代价是一次零检查的提交。

（若日后要压这个开销，正确做法是让 policy 变成常驻或把切分挪进 hook 进程，
**不是**把预筛加回来。）

## 5. 影响面

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `.claude/hooks/gate.ps1` | Phase A：读 `tool_name`；PS AST 切分；删掉三处正则；把 argv 交给 policy | 高（质量门本身） |
| `.claude/hooks/gate.sh` | Phase A：同上（POSIX 交给 policy 切分）；删掉三处正则 | 高 |
| `.claude/hooks/commit_gate_policy.py` | 新增 tokenize + 五个判定；`decide()` 签名加 `tool_name` / `argv` | 高 |
| `tests/test_commit_gate_policy.py` | 新增：四条已知绕过必须被抓到；`-c` 不得误判为 `-C`；解析失败 fail-closed；两 shell 同判定 | — |
| `.claude/hooks/gate_dispatch.py` | 无（payload 原样转发） | — |

**必须有的守卫测试**（本轮教训：一条守卫的价值 = 它的构造能否让被防的那件事真的发生）：
每条新判定都要有一个**变异验证**——把实现改坏，测试必须变红。

**跨 shell 一致性**：ADR-0062 决策 3 要求同一输入同一判定。POSIX 切分在 Python 里
共用同一份代码，天然一致；PowerShell 分支只有 Windows 会遇到（Linux 上不存在
PowerShell 工具），若 `gate.sh` 真的收到 `tool_name == "PowerShell"`，按决策 4
fail-closed，两边行为仍一致。

**是否需要新 ADR**：需要。这改的是质量门的判定机制，且修订了 ADR-0050 决策 1
「两 shell 各自匹配命令文本」的实现约定。实施卡开工时一并起草。

## 6. 已知漏洞边界（诚实标注，不假装堵死）

解析器解决的是**引号与转义**，解决不了**间接**。改完之后，下列写法仍然绕过 gate：

| 形式 | 为什么仍绕过 |
| --- | --- |
| `eval "git commit -m x"` | token 是 `['eval', 'git commit -m x']`，commit 藏在字符串参数里 |
| `bash -c 'git commit …'` / `powershell -c …` | 同上，嵌套一层新 grammar |
| `$G commit`、`$(echo git) commit` | 变量与命令替换在**运行时**才展开，hook 早于运行时 |
| ~~`xargs git commit`~~、`make commit`、跑一个含提交的脚本 | 提交发生在 gate 看不见的子进程里 |
| shell 函数 / alias / `~/.gitconfig` 的 alias | 名字与真实动作的映射不在这段文本里 |

**实施偏差（2026-08-16，TASK-085）——这张表现在有两处不准，以此处为准：**

1. **`xargs git commit` 已被抓到**，连同 `sudo` / `env` / `nice` / `nohup` /
   `time` / `command` / `doas` / `stdbuf`。理由不是解析器变聪明，而是**旧正则
   本来就抓得到 `sudo git commit`**（文本里同时有 git 和 commit）——不拆开包装器
   会让这次改动对该写法成为一次伪装成重写的**倒退**。`make commit` 与脚本仍然
   绕过（那才是真正的「子进程里」）。
2. **`$G commit` 在 PowerShell 侧实际会 fail-closed**：它不是合法 PowerShell
   （变量后跟裸词是 parse error，实测 errors=1），于是走决策 4 跑全量。
   **这是运气，不是设计**——Bash 侧的 `$G commit` 照旧绕过。

其余各行仍然成立，并已由 `test_the_documented_bypasses_really_do_still_bypass`
钉成可执行断言：**那条测试断言的是漏洞仍然存在**，好让将来谁以为自己顺手堵死了
其中一条，会先看到红色、再去改文档，而不是留下一份说「已覆盖」而其实没有的注释。

这些**不是**换判定机制能修的：hook 拿到的是「将要交给 shell 的一段文本」，
凡是文本本身不足以决定行为的写法，任何静态判定都得不出结论。

**该记住的是**：本方案把「**一对引号就绕过**」这一类彻底消除（那是日常正常写法，
会被无意触发），剩下的是「**明确绕过 gate 的写法**」——需要刻意为之。
安全边界从「无意即可绕过」抬到「必须故意绕过」，但**没有抬到「不可绕过」**。

真正的堵死要靠**另一层**：仓库自己的 `pre-commit` git hook（它在 git 进程内，
无论谁怎么调起来都会跑）。那是另一张卡的事，本方案不声称覆盖它。
