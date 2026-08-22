# ADR-0060：风险分级本地 Commit Gate

- 状态：Accepted
- 日期：2026-08-12
- 范围：仅 `.claude/hooks/` 的本地 AI-agent commit gate；不改变产品代码、CI
  必跑项或高风险改动的全量验收要求。
- 覆盖：[ADR-0050](ADR-0050-powershell-native-agent-dev-tooling.md) 决策 1 中
  「checks + order」的无条件 `pytest` 部分。
- **被 [ADR-0068](ADR-0068-continuous-modification-chain.md) 部分修订**
  （2026-08-13）：本 ADR 的风险分级表与「高风险必须跑全量」**不变**，但在**经用户
  明确授权的连续修改链**的**中间**提交上，全量 pytest / 全量前端**推迟到链尾**
  统一执行（把 `MOTV_CONTINUOUS_CHAIN=1` 逐次写在提交命令最前面；**不是环境
  变量**，见 ADR-0068 决策 7 补记）。ruff 与 diff 检查照旧。最终检查点不写该
  令牌，恢复本 ADR 的原 full gate。**不修改本 ADR 原文。**

## 背景

本地 Windows 全量 pytest 最近实测约 328 秒，测试数量已增长到 3,000。根因是
真实临时项目目录中的原子写入与 `fsync` 在 NTFS 上的成本，而不是 pytest 收集。
把全量 pytest 无条件绑定到每一次本地 commit，会让低风险 UI、文档和单元测试
修改也承担同样等待，鼓励大而难审的提交。

项目的质量规则已经按低/中/高风险分层；本地 gate 必须执行该规则，而不能把
每个 commit 误作高风险发布验收。同时，不能用不透明的「受影响测试猜测」放松
高风险路径的回归保护。

## 决策

1. 两个 gate 在 Ruff 与 whitespace 检查之间调用同一个
   `.claude/hooks/commit_gate_policy.py`。该脚本是唯一的风险分类规则；Bash 与
   PowerShell 不得各自维护一套路径判断。
2. 快速路径是**显式 allowlist**，而不是默认规则：

   | 变更集合（可同时含文档） | 本地 gate 测试 |
   |---|---|
   | 仅 `docs/`、`README.md`、`AGENTS.md`、`LICENSE` | 不跑测试 |
   | 仅 `tests/test_*.py` | 只跑已变更的测试文件 |
   | 非高风险的 Python 源码，且存在同名 `tests/test_<module>.py` | 只跑同名测试文件 |
   | `src/ai_video_workflow/workspace/`、`src/workspace_shell/` 及其专用测试 | 全部 `test_workspace_*.py` 回归集 |
   | 仅 motv 的 `.css`/`.html`/`.js`/`.mjs` | 全部 motv Node 测试 |
   | 仅 `mockups/motv-workspace/server.py` | 全部 `test_motv_*.py` Python 回归集 |

   持久化、schema、迁移、资产/生成登记、时间线、渲染/文件操作、存储生命周期、
   Windows 可移植性与安全路径一律进入 `full`，运行全量 pytest。任一混合面、
   fixture/config/hook 改动、未知路径、无同名测试的源码或无法取得 Git
   变更列表，也进入 `full`。
3. gate 对正常 `git commit` 按暂存区分类，令未暂存的其他实验不影响本次提交的
   验证层级。对于 `git commit -a` / `--all`，gate 改用 `HEAD` 差异，因为 Git 会在
   提交过程中自动暂存所有已跟踪改动。两种输入都包含删除路径；分类器或 Git 变更
   列表失败时 fail-closed（exit 2）。
4. 高风险变更仍须在合并前跑全量 pytest、全量前端测试、Ruff 与独立审查；CI 的
   Ubuntu/Windows 全量作业不因本 ADR 缩减。快速 gate 是本地反馈层，不能作为
   发布或高风险验收证据。

## 后果

- 文档、测试、受限 workspace/UI 工作与有明确同名测试的一般模块得到短反馈周期；
  高风险或分类缺口仍受全量 pytest 保护，安全边界不会因分类缺口静默变弱。
- 新增可快速验证的低/中风险表面时，必须在分类器、其单测和本 ADR 的表格中同时
  增加条目；否则自动走全量。
- Windows 的 NTFS `fsync` 成本依然存在，但不再阻塞每一个低/中风险本地 commit。
  WSL `/dev/shm` 或专用 RAM disk 仍是全量运行的独立加速手段。
- 高风险 full tier 在 Windows 允许 900 秒；外层 hook 为 1000 秒，避免已开始的
  合法全量回归在旧 600 秒边界被误报为失败。
