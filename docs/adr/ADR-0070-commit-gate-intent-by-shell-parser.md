# ADR-0070：commit gate 的意图判定改由每个 shell 自己的解析器给出

- 状态：**Accepted**（2026-08-16）
- **取代**：[ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md) 决策 1 中
  「靠命令文本判定 commit 意图」的实现约定（行为合同不变）
- Accept 依据：CLAUDE.md「决策模式 → ADR 的 Accept 权」——本 ADR 属于技术范畴
  （质量门实现机制、跨层合同、两 shell 一致性），不涉及付费，也不不可逆动用户
  数据，由实施 Agent 自行 Accept 并写明理由。
- 实施：[TASK-085](../tasks/done/TASK-085-gate-intent-detection.md)
- 方案：[commit gate 的意图判定](../design/done/commit-gate-intent-detection.md)
- 修订：[ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md) 决策 1「两 shell 各自
  匹配命令文本」的**实现约定**（行为合同本身不变，见「与 ADR-0050 的关系」）
- 相关：[ADR-0062](ADR-0062-windows-authoritative-environment.md) 决策 3、
  [ADR-0068](ADR-0068-continuous-modification-chain.md) 决策 6/7、
  [ADR-0060](ADR-0060-risk-based-local-commit-gate.md)

## 背景

commit gate 用两条正则在**命令文本**上判断「这是不是一次 `git commit`」。
2026-08-16 的跨模型复审报出两条实际绕过（[待复审清单](../design/active/pending-codex-rereview.md)
「仍然待办」第 3 项）：

| 写法 | 后果 |
| --- | --- |
| `git "commit" -m x` | `commit` token 正则不匹配 → **gate 整个不跑**，提交零检查通过 |
| `git "-C" other commit` | 重定向检测不到 → 本仓库的检查结论为**另一个仓库**的提交背书 |

这不是两个拼写遗漏。**用正则读命令文本判断意图**这件事本身不收敛：宽了误伤
（提交信息里写 `push` 就被当成 push 拦下），窄了漏掉（加一对引号就绕过），
每加一种变体只是把边界往外挪一格。gate 自己的注释早已承认前半句：

> A regex cannot reliably parse a shell command line …

判断是对的，结论下反了。**正则确实解析不了 shell 命令行——但 shell 自己可以。**

## 决策

### 决策 1：判定输入从「命令文本」改成「(tool_name, 结构化 token)」

PreToolUse payload **拿不到 argv**（`tool_input.command` 是原始文本，命令在 hook
之后才交给 shell），但**拿得到 `tool_name`**——而两个 gate 此前都把它丢掉了。
这正是缺失的那个输入：同一段文本在两种 grammar 下含义不同，gate 以前不知道该用
哪一种。

- `tool_name == "Bash"` → `commit_gate_policy.py` 内用 `shlex` 切分（stdlib，
  零新增依赖）；
- `tool_name == "PowerShell"` → `gate.ps1` 用
  `System.Management.Automation.Language.Parser` 切分，把 token 以 JSON 交给策略；
- 其它 / 缺失 → 决策 4。

**POSIX 切分放在 Python 而不是各自 shell 里**，因为 ADR-0062 决策 3 要求两平台
给出相同判定，而「同一份代码」是唯一不会漂移的实现方式。两个 shell 各自匹配令牌
正是它们当初分歧的原因（`-like` 大小写不敏感 vs `grep -F` 敏感）。

### 决策 2：shell 只切分，不判定

`gate.ps1` 必须自己解析 PowerShell 语法（只有 PowerShell 能解析 PowerShell），
但它交出去的是 **token，不是结论**。切分函数里不出现 `git`、`commit`、`-C`、
五个动词中的任何一个；一旦某个 shell 自己认起判定词，两侧就又有了各自漂移的
空间。这一条由 `test_neither_shell_judges_intent_it_hands_the_payload_over`
钉住（它直接断言 gate.ps1 / gate.sh 源码里不含判定字面量）。

### 决策 3：链令牌 `MOTV_CONTINUOUS_CHAIN=1` **不动**

它在 Bash 里是赋值前缀，在 PowerShell 里写成**行首注释**，而 **PowerShell 的
AST 会把注释丢掉**——用 token 读它反而读不到。它对 shell 本身是惰性的，靠的正是
「位于命令最前面」这个文本位置，所以行首锚定的文本匹配是**对的判定方式**，
不是遗留缺陷。

### 决策 4：判断不出来 = fail-closed，跑完整检查

**区分两种失败**，这是本 ADR 唯一放宽不了的地方：

- 「这不是一条 commit」→ 照常 `exit 0`（不变）；
- 「**没能判断出这是不是 commit**」（`shlex` 抛 `ValueError`、PowerShell parse
  error、`tool_name` 缺失或未知、argv 形状不合法、payload 读不出、**分类器
  跑不起来**）→ 当成可能是 commit，**跑完整检查**。

旧实现是 Phase A 任何异常一律 `exit 0`，理由是「坏掉的探测器不能拦住无关命令」。
听起来稳妥，实际后果是**探测器一坏，闸门就静默消失**。代价对比不对等：这边偶尔
多跑一次检查，那边是静默放行一次未检查的提交。

**fail-closed 必须能复合**：读不懂的命令同时也**丧失链令牌的减档授权**，否则会
出现最坏组合——一条读不懂的命令拿到了跳过全量的授权。同理，读不懂时**不去问
`git diff`**：暂存路径回答的是关于本仓库的问题，而那条读不懂的命令未必是关于
本仓库的。

### 决策 5：Phase A 不再做文本预筛

任何文本预筛都会**重新引入本 ADR 要消除的那类漏洞**（`g""it`、`c""ommit` 能骗过
任何 substring 预筛，因为**引号是 shell 的，不是文本的**）。

代价已实测：策略冷启动约 **126 ms/次**，即**每一次** Bash/PowerShell 工具调用
多这么多。判断：可接受——它换掉的是「gate 静默不跑」这一类。
**若日后要压这个开销，正确方向是常驻分类器或把切分挪进 hook 进程，不是把预筛
加回来。**

### 决策 6：命令文本改走管道，不走命令行

意图调用把 payload 从 **stdin** 送进策略，分类调用只带 `--chain-mode 0|1` 与
改动路径。此前 `--command <cmd>` 把提交信息塞进 Windows 32767 字符的命令行预算
（与改动路径清单共用），长信息 + 宽改动面会让 `Process.Start` 抛异常，而那个
终止性错误让 gate.ps1 以 1 退出——PreToolUse 把 1 读成**非阻塞**错误，于是提交在
**零检查**下落地（round 3 实测：30125 字符正常，40125 字符 Win32Exception）。
走管道把这一整类删掉。

### 决策 7：安全边界抬到「必须故意绕过」，**没有**抬到「不可绕过」

解析器解决**引号与转义**，解决不了**间接**。下列写法**仍然绕过**，且这一点写在
`commit_gate_policy.py` 的注释里、并由 `test_the_documented_bypasses_really_do_still_bypass`
钉成可执行断言（**该测试断言的是漏洞仍然存在**，是故意的）：

| 形式 | 为什么仍绕过 |
| --- | --- |
| `eval "git commit -m x"` | token 是 `['eval', 'git commit -m x']`，commit 藏在字符串参数里 |
| `bash -c '…'` / `pwsh -c …` | 同上，嵌套一层新 grammar |
| `$G commit`、`$(echo git) commit` | 变量与命令替换在**运行时**才展开，hook 早于运行时 |
| `make commit`、跑一个含提交的脚本 | 提交发生在 gate 看不见的子进程里 |
| shell 函数 / alias / `~/.gitconfig` 的 alias | 名字与真实动作的映射不在这段文本里 |

方案 §6 原表里的 `xargs git commit` **已不在此列**：连同 `sudo` / `env` / `nice`
等包装器一并拆开了。理由不是解析器变聪明，而是**旧正则本来就抓得到
`sudo git commit`**（文本里同时有 git 和 commit），不拆开会让这次改动对该写法
成为一次伪装成重写的**倒退**。

真正堵死要靠**另一层**：仓库自己的 `pre-commit` git hook（它在 git 进程内，
无论谁怎么调起来都会跑）。**本 ADR 不声称覆盖它**，另开卡。

## 与 ADR-0050 的关系

ADR-0050 决策 1 的**行为合同表**（同样的输入 → 同样的判定、同样的退出码）
**完全保留**，本 ADR 只推翻它的**实现约定**：合同不再由「两个 shell 各自匹配
命令文本」实现，而由「两个 shell 各自切分、单一策略判定」实现。
ADR-0062 决策 3 因此从一条**需要人去维护两侧一致性**的纪律，变成一条
**结构上无法违反**的性质——两侧根本没有各自的判定实现可供漂移。

诚实的表述不是「两边完全相同」，而是：**能判定的地方完全相同，判定不了的那一侧
只会更保守，绝不会更宽松**。`gate.sh` 若真的收到 PowerShell payload（现实中不
发生：Linux 上不存在 PowerShell 工具，Windows 上 `gate.sh` 按 ADR-0050 主动
让位），它没有 argv，按决策 4 跑全量。

## 附带修正的三处既有缺陷

判定改成 token 之后自然暴露、并已一并修掉：

1. `git commit -am "x"`——完全普通的写法，旧正则只认 `-a` 和 `--all`，于是按
   **index** 分类，而这条提交实际写的是 **worktree**：分类器读的是一份不描述
   这次提交的路径清单。
2. `git commit -C HEAD`（复用另一条提交的信息）被旧正则**误拦**成仓库重定向。
   重定向判定现在限定在**子命令之前的全局选项**，这才是 git 真正的语法。
3. 链冲突扫描不再需要「去掉引号后在整串里找五个动词」那个折中：`git "push"`
   抓得到，而 `git commit -m "say push here"` 不再误伤。

## 后果

- **正面**：「一对引号就绕过」这一整类消失，而那正是危险的一类——它**会被无意
  触发**（日常正常写法）。剩下的需要刻意为之。
- **负面**：每次 Bash/PowerShell 工具调用多约 126 ms（决策 5）。
- **负面**：读不懂的命令会触发一次完整检查。这类命令在两个 shell 里本来就跑不
  起来（引号不配对 / PowerShell 语法错误），所以成本落在一条本就要失败的命令上。
- **负面**：分类器彻底不可达（策略文件被删、机器上没有任何 python）时，**每一条**
  Bash/PowerShell 命令都会被拦，而不只是提交。这是决策 4 的直接推论，且有明确
  报错文本；在实际接线里不可达——`gate_dispatch.py` 本身就是 python 程序，
  hook 能跑起来就说明解释器存在。为把影响面压到最小，意图调用允许回落到 PATH 上
  的任意 python（策略是 stdlib-only），因此 `.venv` 尚未构建的仓库只有**真提交**
  会被拦，与改动前一致。

## 验证

- `tests/test_commit_gate_policy.py`：62 项。四条已知绕过、`-c` 不得误判为 `-C`、
  解析失败 fail-closed、两 shell 同判定、`decide()` 与两个 CLI 模式的等价性。
- **跨 shell 一致性是实跑的**：测试把 `gate.ps1` 里 BEGIN/END 标记之间的切分函数
  抠出来，交给真的 `powershell` 执行，再把 token 喂回策略比对——不是对源码做
  字符串断言。（本仓库此前的编码 bug 之所以能躲过整套测试，正是因为测试只断言了
  源码文本。）无 powershell 的主机跳过该项。
- **变异验证**：15 个变异（清空重定向选项表、拼错 `commit`、解析失败返回空列表
  而非 `None`、未知 `tool_name` 当成非 commit、关掉 `-a` 检测、`-C` 不吞掉它的
  值、去掉包装器拆解、清空动词表、换行不再分隔命令、`#` 恢复注释语义、接受畸形
  argv、fail-closed 不再强制全量、读不懂却保留链减档、切分函数不再去引号、切分
  函数忽略 parse error、包装器不再越过选项值找 git）**全部被测试杀死，0 存活**。
  首轮有 3 个存活，已就地补上对应用例——其中一条是真缺口：**带着链令牌的读不懂
  命令**此前不会被测出来。

## 审查记录

**轮 1（codex，跨模型，独立性未降级）：`VERDICT: fail`，2 条 blocking。**

1. **`sudo -u builder git commit` 绕过 —— 成立，已修。** 包装器拆解只跳过 `-`
   开头的 token，于是 `-u` 的**值** `builder` 被当成命令名，判定为「不是
   commit」。这不只是新缺陷，而是**旧文本正则本来抓得到**的写法——一次伪装成
   重写的倒退，正是决策 7 里加入包装器拆解要避免的那件事，却在实现里以另一种
   形式复发。修法**修的是整个类**，不是 `sudo -u` 一个实例：不去逐个包装器建
   选项表（那是一张迟早写错的表），而是在包装器拿到的 token 里**找 `git`**。
   同类的 `nice -n 10`、`env -u NAME`、`xargs -I{}`、`sudo -H -u` 一并覆盖。
2. **`git -C/path commit` 贴写重定向 —— 不成立，已驳回。** git 的全局选项由
   `git.c` 的 `handle_options` 手工解析，`-C` 是**整 token 比较**，不接受贴着写
   的值。实测：`git -C/nonexistent-xyz status` 报 `unknown option:
   -C/nonexistent-xyz`（exit 129），与真正的未知选项 `-Z/nonexistent-xyz`
   **报同一个错**。该命令在做任何事之前就失败了，没有提交发生在任何仓库里，
   也就没有可绕过的东西。已留反向守卫
   `test_an_attached_dash_C_value_is_not_valid_git_and_is_not_a_bypass`：
   若哪天 git 接受了贴写形式，该测试变红。

**轮 2（codex，跨模型）：`VERDICT: pass`，0 blocking，2 non-blocking。**
两条都成立，都已修（预算 2/2 用尽，轮 2 无 P1，按 CLAUDE.md 不得开第 3 轮，
**因此这两处修复未经复审**，已登记[待复审清单](../design/active/pending-codex-rereview.md)，
push / merge 前补审）：

1. **`git commit -Salpha` 被读成带 `-a`。** 短选项簇里，**取值的那个选项之后
   全是它的值**：`-Salpha` 是签名密钥 `-S alpha`，不是 `-S -a -l -p -h -a`。
   把值当 flag 读会找到一个不存在的 `a`，于是拿 HEAD 去 diff——只暂存了干净
   路径的提交会被工作区里无关的坏改动拦下。原注释辩解说「过度匹配只会让 diff
   变宽，只会抬高档位」，方向是对的，但**抬高档位不是无代价的**。
   现在按簇从左往右扫，遇到取值选项即停（`-ma` 是 `-m a`，不是 `-m -a`）。
2. **`--intent` 被 `--` 之后的路径触发。** 它用的是对整个 argv 的成员测试，
   绕过了紧邻的下一个分支所遵守的 `--` 分隔符：暂存一个真名叫 `--intent` 的
   文件，**分类器调用**会切换成意图模式，shell 在返回值上找不到 `tier`，
   提交被一句莫名其妙的错误拦下。fail-closed，但令人困惑——而且
   `--chain-mode` 那条**早就有一条通过的守卫**，同一个不变量只覆盖了一半。
   已改成在同一个循环里解析。

   这一条的守卫**第一次写弱了**：`Intent` 也带 `tier` 字段，所以只断言 `tier`
   的测试分不出「分类器答对了」和「分类器整个跑错了模式」——该变异一直存活到
   测试改为断言**返回值的键集合**为止。
