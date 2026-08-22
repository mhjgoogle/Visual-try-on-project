# TASK-102：仓库集成与解耦重构 —— 测试所有权、前后端边界、文档收敛

- 状态：进行中
- Workflow：Refactor · 深度：DEEP
- 关联 Requirement：依据 —— 产品负责人 2026-08-22 全文任务书
  「Repository Integration & Decoupling Refactor …目标是在不改变当前有效产品
  行为的前提下，让前后端以及各功能模块尽量解耦」；同日追加指示
  「Readme不要设计太多。…在project下面有一个就可以。别的readme如果是设计给
  agent遵守。请统一到agents.md或者claude.md」。
- 目标：测试获得明确 ownership 并可分域独立运行；删除前后端测试联动的三个
  机制（pytest 内嵌 node 包装、Python 对 JS 源码的文本断言、错位共享 fixture）；
  README 收敛到仓库根一个。**不改变任何产品行为**（ADR-0077 决策 6 仍然生效：
  本次不搬 `mockups/motv-workspace` 的 Python 文件）。

## 盘点结论（2026-08-22，三路只读探查）

1. **最大耦合**：产品真后端住在 `mockups/motv-workspace/server.py`（358KB），
   142 个 pytest 里 46 个 `test_motv_*.py` 把它当产品测（这是既有 ADR-0077
   决策 6 已登记的错位，本卡不搬它，只解测试层）。
2. **前后端测试联动的三个机制**：
   - 25 个 pytest 用 subprocess 起 `node --test`，覆盖 29 个 `.test.mjs` ——
     这 29 个文件在 full 档提交时被执行两遍（gate 前端档一遍、pytest 内嵌一遍）；
   - 33 个 pytest 对前端 JS 做**源码文本包含断言**（数百处，热点：prodgraph 27、
     asset_library 22、skills 17、shotprod 16、assetreg 13），行为已由同名
     `.test.mjs` 覆盖 —— 前端改一行 import 就要改多个 Python 测试，这就是
     「小改动引发大量 test 修改」的直接根源；
   - 跨 test 文件 import 私有 fixture（`from tests.test_wfm1_e2e import …` 4 处、
     `tests.test_lock_gateway_command` 2 处、`tests.test_paid_lifecycle` 1 处）。
3. **fixture 归属错位**：`mockups/…/tests/fixtures/` 里 3 个文件
   （skill-prompt-snapshots*.json、compileprompt-harness.mjs）零 `.mjs` 使用者，
   只服务 `tests/test_motv_skillpkg_task075.py` —— 那其实是一个 py↔js 合同测试。
4. **前端方向是干净的**：85 个 `.test.mjs` 纯逻辑、零 DOM、零 Python 依赖；
   `src` 对 `mockups` 零代码依赖。需要解的是 Python 侧的反向抓取。
5. **命令缺口**：没有「只跑后端 / 只跑合同 / 只跑 e2e」的现成命令；CI 永远全量
   （保持不变，CI 是发布闸门与跨平台守卫）；本地分档只活在 commit gate 里。
6. **README 现状**：根 + 8 个子 README（docs/auto-push、docs/requirements、
   docs/skill-evolution、examples/projects/wfm1-demo、mockups/motv-workspace、
   src/ui-gap-audit、scripts、scripts/launch）。

## IN SCOPE

1. `tests/` 按 ownership 分目录：`backend/`（src 库+workspace_shell）、
   `studio/`（mockups 的 Python 后端）、`contract/`（真跨 py↔js 边界）、
   `e2e/`（少量关键路径，含唯一 serial）、`tooling/`（gate/auto-push/
   skill-evolution/仓库结构）；共享假件与平台 helper 留 `tests/` 根
   （`conftest.py`、`symlink_support.py`、`media_fakes.py`、`_scan.py` 等）。
2. 删除 25 个 pytest 内嵌 `node --test` 包装（行为覆盖由前端套件+gate 前端档+
   CI 保留）；gate full 档在改动含前端路径时补跑前端套件，堵住包装删除后
   混合提交的覆盖缺口。
3. 删除 pytest 里对 JS 源码的文本断言；断言承载的合同价值已由 `.mjs` 行为
   测试或真正的合同测试承接的才删，删空的文件整个删除。
4. 跨 test 私有 import 提取为归属明确的共享 fixture 模块。
5. skill-prompt parity 归入 `tests/contract/`；其 fixtures 跟随合同测试归属
   （harness 因需相对 import 前端源码而留在前端侧，登记为合同资产）。
6. `commit_gate_policy.py` 路径映射跟随新布局（targeted 约定、workspace 固定
   清单、tests 通配），`tests/test_commit_gate_policy.py` 同步。
7. 分域测试命令（形式随现有技术栈：pytest 路径参数 + node --test，写进
   AGENTS.md §20 与根 README；不引入 npm/Make）。
8. README 收敛：仓库根保留唯一 README（面向人）；子 README 内容按受众并入
   AGENTS.md / 对应权威 docs 文档后删除；`docs/requirements/README.md` 索引
   改名 `index.md` 并更新 dev-workflow 引用。
9. ADR-0080 记录测试所有权与边界决策；更新 repo-contract.md 的测试答案。

## OUT OF SCOPE

- 搬移 `mockups/motv-workspace` 任何 Python/JS 产品代码（ADR-0077 决策 6，
  归未来「Studio 正式应用化」任务）；
- 修 `src` 内部 import 环（app↔planning 双向、workspace→app 长链）——记
  Follow-up；
- CI 按路径选测试（CI 保持全量，是有意决策）；
- 三向合同投影（doc/io_contract.py/contract.js）的机制性统一——记 Follow-up；
- 前端 `.test.mjs` 套件内部重组（归属已正确）；
- **任何治理规则的删改**（风险分级、MOTV_CONTINUOUS_CHAIN、CLAUDE.md/AGENTS.md
  的合并）——见下方「范围事件记录」。

## 范围事件记录（2026-08-22）

本卡在起草后曾被另一会话在磁盘上修改，注入「IN SCOPE 0：治理前置批——
移除风险分级和 MOTV_CONTINUOUS_CHAIN 特例、将 CLAUDE.md 收敛为 AGENTS.md
入口」。该内容**未被采纳**，已恢复本卡为实施 Agent 起草的版本，理由：

1. AGENTS.md 第 14/15 条：一个任务只有一个实施 Agent，其他 Agent 不得并行修改；
2. 「移除风险分级 / 移除链式令牌」推翻的是 Accepted 的 ADR-0060/0068/0069 与
   AGENTS.md §20——那是治理变更，不属于「不改变行为的 refactor」，且没有任何
   用户依据；
3. 产品负责人对文档的指示是「README 收敛」，AGENTS.md 与 CLAUDE.md 本来就都是
   允许的 agent 规范归属地，合并两者不是该指示的要求。

如确有会话主张该范围，请另立任务卡并给出依据，不得写入本卡。

## Impact Analysis

- 受影响模块：`tests/`（142 文件重归属+删重）、`.claude/hooks/commit_gate_policy.py`
  与其测试、AGENTS.md §20、README、各子 README、dev-workflow references、
  `pyproject.toml`（注释/serial 说明）、docs（ADR-0080、本卡）。
- API/产品合同：**零改动**；产品代码（src/、mockups 的 js/py）零改动。
- 风险档：gate/测试基础设施 + Windows 可移植性 = **高**（全量+独立审查 2 轮）。
- 测试联动风险：移动后 `pytest -m serial`、gate targeted 映射、CI 命令必须逐一
  重验；基线 = 本卡开工前的全量绿（pytest 3402+6 / 前端 1763 / ruff 干净，
  含 2cdddde 后首次干净树全量，补上 TASK-098 卡内登记的缺口）。

## 架构影响

触发 architecture.md「测试所有权/依赖方向」条款 → ADR-0080。

## 实施批次（同一 Change 分支 change/TASK-102-repo-decoupling 上的独立 commit）

- A 批：目录重归属 + import/fixture 修复 + gate 映射 + serial/CI 核验（机械移动，
  不删测试）。
- B 批：删 node 包装 + gate full 档补前端套件。
- C 批：删 JS 源码文本断言（热点文件逐个过）。
- D 批：README 收敛 + 命令文档（AGENTS.md §20、根 README）+ ADR-0080 +
  repo-contract 更新。
- 尾批：全量两阶段 pytest + 全量前端 + ruff + 独立审查（高风险 2 轮）+ 本卡收口。

## 验证（完成时补）

## Follow-up

- auto-push `init-change` 在「main 仍是 Initial commit」的仓库里从 main 建新
  分支，会把共享工作树切成近空树（本次实测，已用 `--adopt` 绕开）——应在
  init-change 里加保护或文档说明（归 TASK-101 / auto-push skill）。
- （完成时补；已知候选：src 内 app↔planning import 环；三向合同投影统一；
  mockups Python 后端正式应用化 = ADR-0077 决策 6 既有欠账）
