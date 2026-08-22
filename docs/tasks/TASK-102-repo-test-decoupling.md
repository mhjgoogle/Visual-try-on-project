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

## 产品负责人裁决（2026-08-22，实施中追加）

1. 实施权：「本会话继续（推荐）」—— TASK-102 唯一实施 Agent 为本会话；
   并行实施者（不可见于会话列表，疑似 codex）由产品负责人停止。
2. 治理范围：「不要保留风险分集。dev-workflow 根据影响范围决定是否审查
   → 默认一轮 → P1 修复后复审一次 → P2 修复 + 定向测试，不再复审
   → P3/P4 记录但不阻塞。其他不采纳」。
3. 「风险分级和skill的内容相悖。必须修改」——codex-review-loop 与
   dev-workflow 中按风险分级的措辞随之更新。
4. 「我不要每次都全量测试。」——commit gate 由「高风险路径→全量」改为
   按测试所有权定向；全量只保留在集成检查点（CI、merge、链尾、发布/交接前）
   与真正无法归属时的 fail-closed 回退。
5. 未采纳部分维持现状：MOTV_CONTINUOUS_CHAIN（ADR-0068）保留；CLAUDE.md
   不掏空；注入 ADR-0080 的其余条目不生效（归档为证据）。

## IN SCOPE

0. 按上方裁决更新治理文档与 skills：AGENTS.md §20（测试与审查）、CLAUDE.md
   实施纪律的审查表、dev-workflow references/verification.md、
   codex-review-loop SKILL.md；commit gate 按所有权映射重设计
   （`commit_gate_policy.py` + 双 shell + 其测试）；以新 ADR 记录（取代
   ADR-0060 的风险分级语义与 ADR-0069 的按风险轮次预算；保留两者的
   fail-closed 实现原则与两阶段全量方案）。
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
- 裁决未采纳的治理变更：删除 MOTV_CONTINUOUS_CHAIN、掏空 CLAUDE.md、
  注入 ADR-0080 的其余条目——见「范围事件记录」与「产品负责人裁决」。

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

- A 批：目录重归属 + import/fixture 修复 + gate 最小路径跟随（机械移动，
  不删测试，gate 逻辑不变）。
- B 批：删 node 包装 + 删 JS 源码文本断言（测试收敛）。
- C 批：gate 按所有权映射重设计（废风险分级、日常不全量）+ gate 测试更新。
- D 批：治理文档与 skills 对齐（AGENTS.md §20、CLAUDE.md 审查表、
  verification.md、codex-review-loop）+ README 收敛 + 新 ADR + repo-contract。
- E 批：**前端架构不变量集中化**。批次 B 后仍有 107 处对前端 JS 文件名的引用，
  其中 `app.js` 被 **19 个**测试文件读 —— 那是「改 app.js 一行要碰 19 个 Python
  测试」的残留联动。根因是 app.js 是入口编排文件，`.test.mjs` 无法 import 它，
  所以这些守卫（媒体写路径必经 registry、序列化器是持久化唯一所有者、
  不得静默定稿等）只能从源码侧断言。它们本质是**跨层写路径不变量**，归
  `tests/contract/`，集中到一个文件：改一处只碰一个测试文件。
- 尾批（集成检查点）：全量两阶段 pytest + 全量前端 + ruff + 独立审查
  （新政策：默认 1 轮）+ 本卡收口。
  中间批次按任务书 §17 与「我不要每次都全量测试」的授权走 ADR-0068 链式节奏：
  定向测试收口、逐批独立提交（gate 判全量档时手写 MOTV_CONTINUOUS_CHAIN 令牌
  推迟到链尾），每批独立审查不放松。

## 批次 C 设计：gate 归属映射（实施依据）

改动路径 → 归属测试目标（并集执行；首条命中生效）：

| 路径 | 目标 |
| --- | --- |
| docs/、根 md、.claude/**.md | lint（不变） |
| mockups/**.{css,html,js,mjs} | 前端套件 |
| mockups/**.py | tests/studio + tests/contract |
| src/…/workspace/、src/workspace_shell/ | 既有 workspace 精选集（新路径） |
| src/**.py 有 tests/backend/test_<stem>.py | 该文件 |
| src/**.py 其它（含核心共享文件） | tests/backend + tests/studio（core 影响两者） |
| tests/**/test_*.py | 改动的文件本身 |
| tests/ 根支撑层（conftest、scenario、fakes） | 两阶段全量 pytest（影响=全部域，罕改） |
| pyproject.toml | 两阶段全量 pytest |
| .claude/hooks/**、.claude/skills/**（非 md） | tests/tooling |
| scripts/** | tests/tooling/test_repository_layout.py |
| product-skills/** | tests/studio + tests/contract |
| examples/** | tests/backend/test_example_project.py + test_wfm1_demo_example.py |
| config/providers/** | tests/backend/test_config_catalog.py + tests/contract/test_motv_refset_adr0071.py |
| .github/workflows/** | lint（本地无对应测试，CI 自证） |
| 其它 | full（fail-closed，不变） |

Decision 增加 `frontend` 布尔（python+前端混合改动时两边都跑）；gate.ps1 与
gate.sh 同步实现（ADR-0062 决策 3 同一行为合同）；链令牌语义不变。
「高风险→全量」被上表替代（产品负责人 2026-08-22：「我不要每次都全量测试」）。

## 验证

**基线（开工前，干净树）**：pytest 3402 + 6 / 前端 1763 / ruff 干净。
（该次全量同时补上 TASK-098 卡内登记的「需在干净树重跑全量」缺口，覆盖 2cdddde。）

| 批次 | 提交 | 验证 |
| --- | --- | --- |
| A 目录重归属 | `fcbd238` | collect 3466（与基线一致，0 错误）；两阶段全量 **3402 + 6 passed**（逐项与基线一致）；域内定向：studio 519、tooling+contract 208+19、抽取域 68/39/18 全绿；ruff 全过 |
| B 删测试联动 | `c7268a7` | 前端 **1763 passed**；studio+contract 507 passed；e2e 27 passed；serial 6 passed；ruff 全过（净删 2016 行） |
| C gate 归属映射 | `9d52eca` | tooling **64 passed**（13 个钉旧行为的测试改写为新语义）；17 个路径用例逐一 spot-check 映射正确；ruff 全过 |
| D 治理与文档 | `47fb47f` | **链尾集成检查点**：pytest **3294 + 6 passed**（较基线少 108 项 = 批次 B 删除的重复测试）、前端 **1763 passed**、ruff 全过；tooling 117 passed；`git ls-files '*README.md'` = **1** |

**任务书 §16 验收项实测**：

- A/B/C/D：`pytest tests/backend` / `tests/studio` / `tests/contract` / `tests/e2e` +
  `node --test` 均可独立运行（见 AGENTS.md §20 命令表）。
- E（随机 frontend feature）：`node --test …/shotmap.test.mjs` → 13 passed，
  **0.3s**，零 Python 依赖。
- F（随机 backend module）：`pytest tests/backend/test_budget_ledger.py` →
  6 passed，**0.7s**，零前端依赖（grep `mockups|node|.mjs` = 0 处）。
- G：pytest 内嵌 `node --test` 包装 **0 处**（原 23 处）。
- H：前端 `.test.mjs` 对 Python 的引用只剩 **1 处注释**（gencard.test.mjs:181
  引用 paid_gateway.py 的规则作为合同参照，非依赖）。
- I：删除 23 个 node 包装 + 约 60 个重复的 JS 源码文本断言函数 + 2 个删空文件
  + 8 个子 README；无「旧的保留 + 新的另起一套」。

## Follow-up

- **auto-push `init-change` 会把共享工作树切成近空树**：新建分支路径用
  `git switch -c <branch> <base>` 且 base 默认 origin/main，而本仓库 main 仍停在
  Initial commit。本次实测触发（已用 `--adopt` 绕开并恢复）。归 TASK-101 /
  auto-push skill；94 号会话已按证据机制登记（fb-auto-push-0002，severity high），
  计划改为 base 落后于 HEAD 时返回 `BLOCKED_BASE_BEHIND`。
- **仍存在的架构耦合（如实记录，本卡不修）**：
  1. **Studio 的产品后端住在 `mockups/motv-workspace/`**（server.py 358KB
     单体 + runstore/skillpkg）—— 这是最大的边界错位，ADR-0077 决策 6 已登记，
     需一个「Studio 正式应用化」任务一次性处理包入口、导入与数据路径。
     本卡只把它的**测试归属**理清（`tests/studio/`），代码不动。
  2. **`src` 内的 import 环**：`app → planning` 且 `planning → app`；
     `learning → workspace → app → …` 长链。核心库对 mockups 零依赖（干净），
     但内部方向不干净。
  3. **三向合同投影**：`docs/design/workflow-stage-step-io-contract.md` ↔
     `src/…/workspace/io_contract.py` ↔ `mockups/…/src/workflow/contract.js`
     同一份 L0–S7 合同手抄三份；`product-skills/skill-inputs.json` 被前后端
     同时读取（这一份是单一来源，形状健康）。改合同要同时改三处。
  4. **前端入口不可测**：`app.js` 无法被 node import，所以它的架构不变量只能
     从源码侧断言（批次 E 已把这些守卫集中到 `tests/contract/`，从 19 个文件
     收敛到 1 个）。根治要拆 app.js 的编排层，属前端重构，另立卡。
