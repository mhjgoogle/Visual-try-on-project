# ADR-0080：测试所有权分域与 commit gate 的归属映射

- 状态：Accepted（技术 ADR，依 CLAUDE.md「ADR 的 Accept 权」由实施 Agent Accept；
  「日常提交不跑全量」为产品负责人 2026-08-22 明确指示：「我不要每次都全量测试。」）
- 日期：2026-08-22
- **取代**：[ADR-0060](ADR-0060-risk-based-local-commit-gate.md) 的「按风险分档选
  检查」（其 fail-closed 与「判不出来跑全量」保留，见决策 7）
- 任务：TASK-102 · 决策记录人：TASK-102 实施 Agent

## 背景

142 个 pytest 平铺在 `tests/` 根下，同时测四种不同归属的东西（src 核心库、
mockups 里的 Studio Python 后端、跨 py↔js 合同、端到端验收），另有 4 个测
Agent 工装。前后端测试通过三种机制联动：25 个 pytest 子进程内嵌 `node --test`
（29 个 `.test.mjs` 在 full 档提交时被跑两遍）、33 个 pytest 对前端 JS 做源码
文本断言（前端改一行 import 就要连改多个 Python 测试）、跨测试文件 import
私有 fixture。本地 gate 的「高风险路径 → 全量」使多数非平凡提交都要等 6 分钟
的全量 pytest。

## 决策

1. **测试按归属分域**（物理目录即所有权）：

   | 目录 | 归属 | 验证对象 |
   | --- | --- | --- |
   | `tests/backend/` | src 核心库 + workspace_shell | 领域逻辑、持久化、Gateway、CLI |
   | `tests/studio/` | `mockups/motv-workspace` 的 Python 后端 | server.py / runstore / skillpkg 的 API 与行为 |
   | `tests/contract/` | 真跨 py↔js 边界 | 两侧对同一输入必须一致的合同（skill prompt parity、refset↔paid_coordinator） |
   | `tests/e2e/` | 少量关键用户路径 | WFM1/WFM2 验收、Studio 端到端、真实进程树（唯一 serial） |
   | `tests/tooling/` | Agent 工装 | commit gate、auto-push、skill-evolution、仓库结构守卫 |
   | `tests/`（根） | 共享测试支撑层 | conftest、平台 helper（symlink/media/audio/paid 假件、_scan）、场景构造器（wfm1/gateway/paid scenario） |
   | `mockups/motv-workspace/tests/` | 前端（85 个 `.test.mjs`，node --test） | 前端纯逻辑行为 |

2. **跨测试文件不得 import 彼此的私有定义**。被复用的场景构造器抽到
   `tests/` 根的 scenario 模块（`wfm1_scenario.py`、`gateway_scenario.py`、
   `paid_scenario.py`）。新增共享 helper 仍受 dev-workflow「shared 克制规则」
   约束。

3. **Python 测试不做前端 JS 源码文本断言，不内嵌 `node --test`。** 前端行为
   由前端套件负责；跨边界只允许 `tests/contract/` 中的真合同测试（它们可以
   执行 JS 或读取两侧共享的 fixture）。

4. **分域命令**（不引入 npm/Make，直接用现有 runner）：

   - 后端：`pytest tests/backend`
   - Studio 后端：`pytest tests/studio`
   - 合同:`pytest tests/contract`
   - E2E：`pytest tests/e2e`（serial 项仍按 `-m serial` 单独阶段）
   - 工装：`pytest tests/tooling`
   - 前端：`node --test mockups/motv-workspace/tests/*.test.mjs`
   - 全量（集成检查点）：两阶段 pytest + 全量前端 + ruff

5. **commit gate 从「风险分档」改为「归属映射」**（取代 ADR-0060 的分档语义，
   保留其 fail-closed、shell 只切词、两平台同判定的实现原则）：改动路径映射到
   其归属测试域并只跑该域；映射不到的路径 fail-closed 到全量。**日常提交不再
   因「高风险」标签自动全量**（产品负责人 2026-08-22）。全量两阶段 pytest +
   全量前端保留为集成检查点：CI、链尾、merge 前、发布/交接前。

6. `mockups/motv-workspace` 的 Python 后端本次不搬迁（ADR-0077 决策 6 不变），
   `tests/studio/` 的存在正是为未来「Studio 正式应用化」预先划清测试归属。

7. **影响范围能推导出来的，就不许退回全量**（产品负责人 2026-08-22：「解耦
   之后就不需要分风险等级之后全测试了。不然不合理」）。共享测试支撑层
   （`tests/` 根的 scenario 构造器、假件、`_scan`、`symlink_support`）的影响
   范围 = **import 它们的那些域**，由 import 图**派生**，不手写名单——手写的表
   在有人加使用者时会静默漂移，且漂移方向总是「跑得比该跑的少」。
   实例：`_scan` 只被 `tests/studio` 使用，改它此前要跑 3358 项去覆盖 385 项。
   例外只有两个文件：`tests/conftest.py` 与 `pyproject.toml` —— 它们**不经
   import 生效**（pytest 自己加载 ini 选项、marker 与 basetemp 钩子），
   没有 import 图能收窄它们，所以它们的影响范围真的是全部。
   派生推不出结果时（新 helper、不认识的 import 写法）**fail-closed 到全量**：
   派生用来收窄已知的东西，不给未知的东西发通行证。

## 后果

- 前端小改不再触发任何 Python 测试；后端小改不再触发前端套件；29 个前端测试
  文件不再被跑两遍。
- 一个功能的测试修改范围 = 它的归属目录 + （若动合同）contract。
- gate 归属映射见 `.claude/hooks/commit_gate_policy.py`；其测试在
  `tests/tooling/test_commit_gate_policy.py`。
- 审查政策的对应变更见 ADR-0081。
