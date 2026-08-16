# TASK-085：commit gate 改用 shell 自己的解析器判断意图

- 状态：**未开工**
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

## 5. Follow-up

- 每次 Bash/PowerShell 工具调用多 ~126 ms（policy 冷启动，实测）。若要压这个开销，
  正确方向是常驻/内联切分，**不是**把文本预筛加回来（那会重新引入本卡消除的漏洞）。
