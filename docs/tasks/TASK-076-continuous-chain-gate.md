# TASK-076：让连续修改链在 commit gate 上真实生效

- 状态：**已实施，待 Codex 复审**（审查者降级，见 §4）
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0068](../adr/ADR-0068-continuous-modification-chain.md) 决策 7
- 实施基线：`435f839`
- 排期：**在 TASK-072 批次二之前** —— 批次二起要用这个节奏，而规则只有在 gate 里
  才算真的存在。治理文档已提交（`435f839`）；本卡只做 gate 代码与它的单测，
  **单独审查、单独提交**。

## 0. 本轮边界

**只改 `.claude/hooks/` 的 commit gate 与它的单元测试。** 不改产品代码、不改 CI、
不改 ADR-0060 的风险分级表。

## 1. 交付

### 1.1 `MOTV_CONTINUOUS_CHAIN=1`（写在提交命令最前面，不是环境变量）

| 项 | 内容 |
| --- | --- |
| 识别 | gate 从**被拦截的命令文本**里读令牌 `MOTV_CONTINUOUS_CHAIN=1`：**必须在最前面**、**大小写敏感**、**只有精确值 `1`** 启用（`true` / `yes` / `on` / `10` 一律不认——一个模糊的开关会被模糊地打开） |
| 两种写法 | Bash：`MOTV_CONTINUOUS_CHAIN=1 git commit …`；PowerShell（**权威平台**，没有内联赋值语法）：首行注释 `# MOTV_CONTINUOUS_CHAIN=1` + 换行 + `git commit …` |
| 效果 | 跳过**全量 pytest** 与**全量前端**；**仍跑** ruff（check + format）与 diff 检查 |
| 未写令牌 | 完全恢复 ADR-0060 的原行为，包括高风险 full gate |
| 同命令里有 push / merge | **拒绝提交**（ADR-0068 决策 6）：中间提交没跑全量，不能顺着 `&&` 被推出去 |
| 不可分类的改动 | 分类器的 fail-closed 兜底（无路径 / 无定向映射）**永不推迟**——把「不知道这是什么」变成「于是什么都没跑」，正是兜底存在的反面 |
| 可见性 | 启用时 gate 以 `{"systemMessage": …}` 输出跳过说明（PreToolUse hook 退出 0 时纯文本 stdout **会被丢弃**）。**不带任何 `permissionDecision`**——那会自动放行或强行弹窗。只在**放行路径**上输出；**发不出警告就拒绝提交** |

**为什么不是环境变量**：gate 是 PreToolUse hook，不是被拦截的 `git commit` 的
子进程，逐次内联赋值到不了它的环境；唯一能到达的是 session / settings 级变量，
而那正是 ADR-0068 决策 7 禁止的持久开关。完整推导见 ADR-0068 决策 7 补记。

### 1.2 两个平台行为一致（ADR-0062 决策 3）

`gate.ps1` 与 `gate.sh` 共享 `commit_gate_policy.py` 的同一判定，**必须给出相同
结论**。判定逻辑放在 policy 模块里，两个 shell 脚本只负责**把命令原样交出去**
（`--command <cmd>`；gate.ps1 的改动路径走 argv，因此再加 `--` 终止 flag，
gate.sh 的路径走 stdin，不需要）——**不得各自实现一遍令牌匹配**。两个 shell 各自匹配正是
两平台产生分歧的原因（PowerShell 的 `-like` 大小写不敏感，`grep -F` 敏感）。

### 1.3 单元测试（`tests/test_commit_gate_policy.py`）

必须覆盖：

1. 未写令牌 + 高风险改动 → 要求全量（原行为不变）；
2. 令牌 + 高风险改动 → 跳过全量，**仍要求 ruff 与 diff 检查**；
3. `0` / `true` / `yes` / `10` / 空 / 大小写不符 / 不在首位（如出现在 commit
   message 里）→ **一律不启用**；
4. 启用时输出包含明确的跳过说明与 ADR-0068 指引，且首行为 ASCII（非 UTF-8
   控制台上也必须可读——看不懂的警告等于没有警告）；
5. 低风险改动的判定与启用无关（不因为写了令牌就改变风险分级）；定向测试层级
   **照跑**，它们本来就是链要求的定向测试；
6. PowerShell 与 Bash 两条路径对同一输入得到同一 policy 结论，且**两个 shell 里
   都不出现该令牌**（有一份重复实现，就有第二次分歧）。

### 1.4 明确不做

- **不提供**任何写进 `settings.json` / profile / shell rc 的持久开关
  （ADR-0068 决策 7 的要点）。
- 不提供「跳过 ruff」或「跳过 diff 检查」的开关。
- 不提供「跳过 Codex 审查」的开关——审查不在 gate 里，它在流程里，
  而 ADR-0068 决策 2 明确不放松它。

## 2. 验收标准

| # | 标准 | 验证 |
| --- | --- | --- |
| 1 | 未写令牌时行为与 ADR-0060 完全一致 | 现有 gate 测试全绿，无需修改 |
| 2 | 写令牌时跳过全量、仍跑 ruff 与 diff | 新增单测 |
| 3 | 只认首位、大小写相符的精确值 `1` | 逐值单测（含 commit message 内出现该串的反例） |
| 4 | 跳过在 gate 输出里明确可见（首行 ASCII） | 输出断言 |
| 5 | 两平台同结论，且两个 shell 都不自行匹配令牌 | policy 层单测 + 两脚本源码断言 |
| 6 | 仓库内不存在持久性跳过开关 | 全仓扫描（settings / rc / profile / 任意配置后缀） |
| 7 | 不可分类的兜底永不被推迟 | 空路径 / 无映射路径的单测 |

**风险等级：中～高**（改的是质量门本身）→ 全量 pytest + ruff + **Codex 独立审查**。
本卡**不适用**它自己引入的连续链节奏——引入规则的那次提交必须按原规则验证。

## 3. 已知风险

1. **改质量门本身是最容易自我豁免的一类改动。** 因此本卡按原规则（全量 + Codex）
   验收，且验收标准第 6 条要求全仓搜索确认没有留下持久开关。
2. **一个看得见的跳过与一个看不见的跳过差别巨大。** 交付项 1.1 的「可见性」不是
   锦上添花：它是这条规则不会悄悄变成默认状态的唯一保障。

## 4. 实施记录（2026-08-13）

### 4.1 落点

| 文件 | 内容 |
| --- | --- |
| `.claude/hooks/commit_gate_policy.py` | `chain_mode_from_command()`（锚定首位、大小写敏感）、`classify(..., chain_mode=)`、`continuous-chain` 层级、`Decision.notice`、`main()` 的 `--command <cmd> --` 解析 |
| `.claude/hooks/gate.sh` / `gate.ps1` | 把被拦截的命令原样交给 policy；新增 `continuous-chain` 分支（不跑任何测试套件）；notice 打到 **stdout** |
| `tests/test_commit_gate_policy.py` | 24 项，覆盖 §1.3 全部六条 |

### 4.2 审查者降级（如实记录，不得当作 Codex 通过）

Codex 在 2026-08-18 之前不可用（workspace spend cap）。按用户批准的降级审查模式，
本卡的中/高风险检查点由**独立的新 Claude Opus 会话**评审：

| 轮次 | 审查者 | 结论 | 关键阻断项 |
| --- | --- | --- | --- |
| 1 | 独立 Claude Opus 会话 | fail | 环境变量机制在 PreToolUse hook 下**根本不成立**（→ ADR-0068 决策 7 补记）；`classify()` 读环境会污染所有既有调用方；fail-closed 兜底被错误推迟 |
| 2 | 独立 Claude Opus 会话 | fail | `-like` 大小写不敏感 → 两平台分歧；令牌可出现在 commit message 里关闭闸门；两个 shell 各自实现匹配（违反 §1.2） |
| 3 | 独立 Claude Opus 会话 | fail | 见下 ①～⑤ |
| 4 | 独立 Claude Opus 会话 | fail（第三轮五项**逐项复核通过**，另发现两项） | 见下 ⑥⑦ |
| 5 | 独立 Claude Opus 会话 | **pass**（无 P1/P2） | 仅两项 P3（测试强度）与若干 P4，已一并收口，见下 |

**第三轮五项**：① 跳过警告**谁也看不见**（PreToolUse 退出 0 的纯文本 stdout 被丢弃，代码与测试都写反了这条契约）；② `$cmd` 进 argv 后命令行可超 32767 → `Process.Start` 抛异常 → 脚本 exit 1 → PreToolUse 视为**非阻断错误**，提交**零检查通过**（新引入的 fail-open）；③ gate.sh 未设 `PYTHONUTF8`，非 UTF-8 locale 下 notice 整个丢失而 gate.ps1 正常 → 平台分歧；④ `&& git push` 绕过决策 6；⑤ 权威平台 PowerShell **打不出**文档里的写法。

第三轮的五项已全部修复（含 ADR-0068 决策 7 补记的三点纠正）。同时收窄了两处
验证漏洞：持久开关扫描改为**全仓 + 白名单**（原先按后缀过滤，`.env` / `.bashrc`
这类 dotfile 的 `suffix` 是空串，`.claude/hooks/` 整个目录也被跳过），并新增
两项**真正执行**的测试：policy CLI 端到端，以及**直接运行 gate.sh 自己那段
内联 python** 校验它吐出的字节是合法 ASCII JSON。

**第四轮两项**：⑥ `gate.ps1` 的 `Get-ChildItem`（frontend 分支列测试文件）
**未被 try 包住**：目录不存在时终止性错误 → 脚本 exit 1 → PreToolUse 视为非阻断
→ **连 ruff 都没跑就放行**（与第三轮 ② 同一形状；移动
`mockups/motv-workspace/tests/` 的提交正好触发）；⑦ `chain-conflict` 的阻断原因
**整段中文**，经 `[Console]::Error` 按 Shift-JIS 输出后变成不可逆的 `?`——
阻断理由读不出来。

第四轮的两项已修复：`Get-ChildItem` 补 try/catch 阻断；阻断原因加 ASCII 首行
（与 notice 同一条理由）。另外按第四轮的证明收紧了两处空心断言：

- ruff 顺序断言在 `gate.ps1` 上仍是空的——在 `$checks = @(…)` **之后**插一句
  `if (tier -eq 'continuous-chain') { $checks = @() }`，ruff 与两个 diff 检查
  全部停跑而五条断言照样通过。改为断言结构不变式：`$checks` **只赋值一次、
  之后只 `+=`**。
- 「notice 只在放行路径输出」原先匹配到的是**注释**而不是输出语句，已改为锚定
  `[Console]::Out.WriteLine($payload)` / `printf '%s\n' "$NOTICE_JSON"`。
- `gate.ps1` 改回**纯 ASCII** 并加守卫测试：BOM-less `.ps1` 由 PowerShell 5.1
  按 ANSI 代码页解码，一个非 ASCII 字符落进带引号的字面量就是 **parse error →
  exit 1 → 闸门 fail open**。中文只出现在注释里，去掉零成本。

**第五轮（pass）之后仍一并收口的 P3/P4**——审查者证明它们仍是空心的，留着就是
自欺：

- 上一条「`$checks` 只赋值一次」仍可被绕过：**去掉 `=` 两侧的空格**
  （`$checks=@()`）即可让 ruff 与两个 diff 检查全部停跑而测试全绿。改为按
  **正则**匹配赋值（`\$checks\s*=`，`+=` 不匹配）；`gate.sh` 一侧的断言原先只
  覆盖 ruff **之前**的文本，而真正的插入点在 `esac` 与 diff 检查之间，现已覆盖
  两段。两处绕过都已用「打补丁 → 跑测试 → 还原」实测确认**现在会红**。
- ⑦ 的修复**没有回归测试**（删掉 ASCII 首行，24 项全绿）。已补
  `reason.splitlines()[0].isascii()`。
- 两个 shell 的 notice 触发条件不一致（`gate.ps1` 看 notice，`gate.sh` 看层级）：
  今天等价，明天分歧。`gate.sh` 改为同样看 notice。
- `[Console]::Out.WriteLine($payload)` 原先在自己的 try **之外**——唯一负责
  「宣告」的语句偏偏不被那段「宣告不出来就拒绝」的 catch 覆盖，已移入。

第六轮只审这批收口，结论 **pass，无 P1/P2**。它同时证明了**结构断言的天花板**：
在 `continuous-chain` 分支里置一个标志位、再在检查循环里 `continue`（`gate.sh`
同理用 `DEFERRED=1` + 链上一个条件），ruff 与两个 diff 检查全部停跑而 24 项全绿
——**多绕一层间接就能走过任何文本断言**。这不是本轮引入的，也不打算用更多文本
断言去追：真正的关闭方式是行为测试（拿真实临时 repo 跑整个脚本），而那被本卡
§0 明确排除。据此记录，不假装已经覆盖。

第六轮另有三项 P4 已顺手收口：`gate.ps1` 改为**先 Trim 再判断**（与 `gate.sh`
的 `.strip()` 同序，否则全空白 notice 会一边输出一边静默）；`gate.sh` 区间断言
改为锚在**层级 switch 自己的 `esac`** 上（否则将来在它之前加任何 case 块都会
误报）；§4.2 上一段的机制描述改回与代码一致。**未收口**并如实记录：`gate.sh`
为取 notice 第三次启动解释器（`gate.ps1` 复用已解析对象），失败会拦下一个本已
全绿的提交——保守方向正确，但属于可以更省的写法。

**仍存在的验证局限（如实记录）**：没有端到端执行整个 `gate.sh` / `gate.ps1` 的
测试——两者需要真实 repo、`.venv`、node 与分钟级的套件。因此「ruff 与 diff 检查
在启用时仍然跑」等断言仍是**结构断言**，不是行为断言（第四轮审查者用一个真实
临时 repo 手工验证了放行、阻断与 notice 三条路径，但那不是仓库里的自动化测试）。
这是本卡已知的覆盖上限，不假装它是别的。

**独立性已降级：同模型族评审，不具备跨模型独立性，不等同于 Codex 最终通过。**
本卡已登记到 [待 Codex 复审清单](../design/pending-codex-rereview.md)，
2026-08-18 之后必须由 Codex 复审；**该清单清空前不得 push / merge / 交接**。
