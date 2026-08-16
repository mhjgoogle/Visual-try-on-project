# TASK-085：commit gate 改用 shell 自己的解析器判断意图

- 状态：**已完成**（2026-08-16）。决策固化为
  [ADR-0070](../adr/ADR-0070-commit-gate-intent-by-shell-parser.md)（Accepted）。
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 方案：[commit gate 的意图判定](../design/commit-gate-intent-detection.md)（TASK-084 §3 产出，已回答「能不能拿到结构化 argv」）
- 前置：无（方案已收口，不需要再收一轮文档）
- 风险：**高**（改的是质量门本身 + 跨层合同 + 两 shell 一致性）→ **2 轮审查 + 全量**

---

## 1. 为什么单独开卡

TASK-084 §3 只出方案，因为这改的是**质量门本身**：判定错一次的代价是一次零检查的
提交，值得单独一轮实施 + 单独的审查预算。方案已把三个问题答完（argv 拿不到、
`tool_name` 拿得到、两 shell 各有真解析器，均为实测），**开工不需要再收一轮文档**。

## 2. IN SCOPE

1. `gate.ps1` / `gate.sh` Phase A：读 `tool_name`，删掉三处意图正则，改为把
   `(tool_name, command[, argv])` 交给 policy。
2. `gate.ps1`：`tool_name == "PowerShell"` 时用
   `[System.Management.Automation.Language.Parser]::ParseInput` 切分（**只切分，
   不判定**）。
3. `commit_gate_policy.py`：新增 tokenize（Bash 走 `shlex`）+ 方案决策 2 的五个
   token 判定；`decide()` 签名扩展。
4. 解析失败 / `tool_name` 未知 → **fail-closed 跑完整检查**（方案决策 4）。
5. 测试：四条已知绕过（`git "commit"`、`git "-C" …`、`g""it commit`、
   `c""ommit`）必须被抓到；`-c key=val` 不得误判为 `-C`；解析失败 fail-closed；
   两 shell 同输入同判定。**每条新判定做变异验证**（改坏实现看它是否变红）。
6. 起草并 Accept 对应 ADR（修订 ADR-0050 决策 1 的「两 shell 各自匹配命令文本」）。

## 3. OUT OF SCOPE

- **链令牌 `MOTV_CONTINUOUS_CHAIN=1` 的判定不动**（方案决策 3：它是行首文本位置，
  PowerShell AST 反而会丢掉注释）。顺手改它是这张卡最容易犯的错。
- 仓库内的 `pre-commit` git hook（真正堵死间接调用的那一层）——另开卡。
- 任何产品代码。

## 4. 验收

- 方案 §6 表里的四条「引号形式」全部被正确判定（有测试）；
- 方案 §6「已知漏洞边界」表里的间接形式**仍然绕过，且这一点写在代码注释里**
  ——不假装堵死；
- 两 shell 对同一 payload 给出相同判定（ADR-0062 决策 3），有守卫测试；
- 全量 pytest + 全量前端 + ruff 绿；2 轮独立审查。

## 5. 结果（2026-08-16）

### 做了什么

判定输入从「命令文本」换成 `(tool_name, 结构化 token)`。三处文本预筛
（`namesGit` / `namesCommit` / 重定向正则）在两个 shell 里**全部删除**。

- `commit_gate_policy.py`：新增 `inspect_command()`——五个判定里的四个改成 token
  判定（链令牌按决策 3 不动）。Bash 由 `shlex` 在**策略内**切分，两平台共用同一份
  代码；PowerShell 由 `gate.ps1` 用自己的 AST 切分后交出 token。
- CLI 变成两个模式：`--intent`（payload 走 **stdin**）与 `--chain-mode 0|1 -- 路径`。
  命令文本不再上命令行，Windows 32767 字符预算那一整类失效模式随之消失。
- `gate.ps1`：新增 `ConvertTo-GateArgv`（BEGIN/END 标记之间，**只切分不判定**）、
  `Invoke-Bounded` 支持 stdin（写**原始 UTF-8 字节**，因为 PowerShell 5.1 所在的
  .NET Framework 没有 `StandardInputEncoding`）。
- `gate.sh`：不再提取命令，payload 原样转发。

### 验收对照

| 验收项 | 结果 |
| --- | --- |
| §6 四条引号形式全部正确判定 | ✅ `test_the_four_known_bypasses_are_no_longer_invisible`（第四条即 `git c""ommit`，见下「一处澄清」） |
| 间接形式仍绕过且写在代码注释里 | ✅ 注释在 `commit_gate_policy.py`，并由 `test_the_documented_bypasses_really_do_still_bypass` **钉成可执行断言** |
| 两 shell 同 payload 同判定 | ✅ 实跑 `gate.ps1` 的切分函数比对，非源码字符串断言 |
| 全量 pytest + 全量前端 + ruff | ✅ 见「最终检查」 |
| 2 轮独立审查 | 见「审查」 |

### 一处澄清

卡里把第四条绕过简写成 `c""ommit`，方案 §3 里实为 `git c""ommit`（被拆开的
**子命令**）。单独一个 `c""ommit` 不是 git 命令，本就不该被 gate 拦——测试按
`git c""ommit` 实现，并把这点写在用例注释里。

### 超出卡面的三处修复

判定改成 token 后自然暴露，且都在本卡范围内（同属那五个判定）：

1. `git commit -am "x"` 旧正则只认 `-a`/`--all`，于是按 **index** 分类，而这条
   提交实际写 **worktree**——分类器读的是一份不描述这次提交的路径清单。
2. `git commit -C HEAD`（复用提交信息）被旧正则**误拦**成仓库重定向。重定向判定
   现在限定在**子命令之前的全局选项**。
3. 包装器：`sudo git commit` 旧正则**抓得到**，只看第一个 token 会变成抓不到——
   一次伪装成重写的倒退。已拆解 `sudo`/`env`/`nice`/`xargs` 等。

### 变异验证（卡里第 5 条要求）

15 个变异，**全部被杀死，0 存活**。首轮 3 个存活，已就地补用例：

- `#` 恢复注释语义 → 补 `-m x#1 && git push`（词中 `#` 会吞掉真实的 push）；
- 畸形 argv 被接受 → 补跨进程 argv 的形状用例；
- **读不懂的命令仍保留链减档** → 这是**真缺口**：原用例用的是不带令牌的命令，
  根本没走到那条路径。补 `MOTV_CONTINUOUS_CHAIN=1 … && echo don't`。

## 6. Follow-up

- 每次 Bash/PowerShell 工具调用多 ~126 ms（policy 冷启动，实测）。若要压这个开销，
  正确方向是常驻/内联切分，**不是**把文本预筛加回来（那会重新引入本卡消除的漏洞）。
- **仓库内的 `pre-commit` git hook 仍未做**（本卡 OUT OF SCOPE）。那是唯一能堵死
  `eval` / `bash -c` / 变量间接 / 子进程这一类的层——它在 git 进程内，无论谁怎么
  调起来都会跑。本卡把边界从「无意即可绕过」抬到「必须故意绕过」，**没有**抬到
  「不可绕过」。
- 分类器彻底不可达时（策略文件被删且机器上没有任何 python）会拦**每一条**命令，
  不只是提交。实际接线里不可达（`gate_dispatch.py` 本身就是 python 程序），
  且意图调用允许回落到 PATH 上的 python，已把影响面压到最小。

### 范围外，只记录不修（AGENTS.md 第 17 条）

- **`test_the_kill_verified_finish_PERSISTS_like_every_other_transition` 偶发失败。**
  本卡最终全量的串行阶段撞到一次：`runstore.py:363` 抛 `PersistFailed`，即
  `os.replace(tmp, self.path)` 收到 `OSError`。**单独重跑通过，整个串行阶段原样
  重跑也通过**（6 passed），因此是偶发而非回归。与本卡无关——本卡的 diff 只碰
  `.claude/hooks/` 与 `tests/test_commit_gate_policy.py`，不碰 `runstore.py`。
  形状像 NTFS 上的瞬时共享冲突（杀软/索引器占着目标文件），临时文件名已带
  `os.getpid()`，所以不是跨进程撞名。**未修，未深查**。
