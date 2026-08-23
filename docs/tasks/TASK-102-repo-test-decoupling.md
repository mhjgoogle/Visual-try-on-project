# TASK-102：仓库集成与解耦重构 —— 测试所有权、前后端边界、文档收敛

- 状态：**本卡已完成并已合入 main（2026-08-22）** —— 独立审查 5 轮，7 条 P1
  全修，轮 5 的 finding 经范围判断 rebut 并记录残余风险；最终全量 3305 + 6
  pytest / 1763 前端 / ruff 全过。合并提交 `ee6e47a`（依据：产品负责人
  2026-08-22「合并」+「全部提交」），合并后在 main 上复跑同一套全量，全绿。
- **main 尚未 push，且当前不应 push** —— 原因**不在本卡**：合并把
  `feat/wfm1-batch-c` 的历史一并带入 main（用户明确要求「全部提交」），其中
  TASK-101 的 `ba0c8e2` 在 push 后补审中被判出 **1 条未闭合 P1**（auto-push
  `_push_gates` 的 merge commit 豁免只查「存在后位亲是 origin/main 祖先」，
  人为构造的 evil merge 可挂古老祖先当第二亲、夹带任意内容混过闸门）。
  该缺陷在 `.claude/skills/auto-push/scripts/autopush.py`，**TASK-102 一行
  未改过该文件**（`git diff --name-only efab6b1^..HEAD | grep auto-push/scripts`
  为空）。发布闸门「无未闭合 P1」因此对 main 整体不成立，push 阻塞至
  TASK-101 修复（其作者已定修法：登记制取代结构推断，v0.1.1 六项之一）。
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

## 合并与 push 的流程教训（2026-08-22，收口后追记）

**merge 前我只查了两份清单的 `verification` 字段，没查
[待复审清单](../design/pending-codex-rereview.md)** —— 而 `ba0c8e2` 的补审要求
就登记在那里（「push / merge 前必须完成补审」）。时序上它写入比本卡起卡晚不了
几分钟，我 merge 时确实不知情；但**不知情不等于流程正确**：merge 前的前置检查
本来就该包含那份清单，而不只是清单里的 verification。

后果分层如实记录：**merge 闸是无意跳过**（登记存在但我没查），
**push 闸履行了「可以推迟，不可以跳过」** —— 补审在 push 前完成并判出真 P1，
push 因此被正确阻塞。这正是 ADR-0068 决策 6 那条规则想要的效果。

已作为建议交给 auto-push 作者（v0.1.1 六项之一）：merge 子命令把「本分支历史内
是否有未闭合的待复审条目」纳入前置检查，且做成**显式声明式**（deterministic
层不解析 markdown）。

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
- F 批（用户追加范围）：**支撑层的影响范围改为从 import 图派生**。
  依据：产品负责人 2026-08-22「解耦之后就不需要分风险等级之后全测试了。
  不然不合理」。`tests/` 根的支撑模块此前一律触发全量，但它们的影响范围
  是可知的 = import 它们的那些域。实测：改 `_scan.py` 从 214s（3358 项）
  降到 21s（385 项）。只有 `conftest.py` 与 `pyproject.toml` 仍是全量——
  它们不经 import 生效，没有 import 图能收窄。同时把 `tests/e2e` 恢复为
  合法目录 target（此前排除它是过度保守：两壳定向档本就带 `-m "not serial"`）。
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
| E 前端不变量集中化 | `f4fe3a4` | **测试数守恒证明**：搬迁前后 `--collect-only` 均 **3358**，且逐个函数名计数零差异（见下）；pytest **3294 + 6 passed**、contract+studio 507 passed、ruff 全过；`app.js` 读取者 **19 → 1** |

**批次 E 的守恒验证值得单独记**（实施 Agent 中途因会话限额中断，交接时树是
半成品，我接手时先做的就是这一步）：第一次对比得出「少了 39 项」，追查发现是
**对比方法本身错了** —— `git stash push -- tests/` 默认不 stash untracked 文件，
所以「基线」里同时含新建的集中文件与尚未删除的原函数，是个重复态。改用
`git stash push -u` 拿到真基线 3358 后，实际差异是 **+2**：`story_m9` 的两个函数
已复制进新文件但尚未从原文件删除（中断点）。更严重的是那两个函数依赖的
`_SRC` 与 `import re` 已被清理掉了 —— 函数体留在原地会 `NameError`，而
`--collect-only` **不执行函数体所以照样绿**。删掉这两个已搬走的函数后守恒成立。
教训：**搬迁类改动必须用「连 untracked 一起 stash」的方式取基线，且守恒要按
函数名逐个计数比对，不能只看总数**——总数相等也可能是一边丢一边多。

**独立审查（ADR-0081 新协议：默认 1 轮，P1 修复后复审一次）**：

- 审查者 **codex**（跨模型独立，未降级）。范围：gate 逻辑 + 治理文档
  （`.claude/hooks/**`、AGENTS.md、CLAUDE.md、`.claude/skills/**`、README、
  src、server.py、pyproject）864 行。**机械搬迁部分（测试移动/删除）未送审**，
  理由是它由「函数名逐个计数守恒 + 全量逐项对齐基线」证明，比人读 5 万行 diff
  可靠——如实记录此范围决定。首次尝试 `main..HEAD` 得 `DIFF_TOO_LARGE`
  （27 万行：main 停在 Initial commit，该区间等于整个仓库历史）。
- **轮 1：fail，3 条 P1，全部为真缺陷，全部已修**：
  1. `gate.sh:186` —— `print(*(), sep="\n")` 对空列表仍输出一行，`mapfile` 得到
     **一个空元素**，`pytest ""` 是 usage error → **Ubuntu 上每个普通定向提交都会
     被闸门拦死**。按「修整个 class」规则连同 `pytest_targets` 一并修。
  2. `commit_gate_policy.py:957` —— 无归属路径**立即 return**，把同一次提交里的
     frontend 声明连同默认 `False` 一起丢掉 → 混合提交走 full 档却**跳过前端套件**。
  3. `gate.ps1:421`（及 `gate.sh` 对称位置）—— forced-full 分支硬写
     `frontend = $false`，于是「读不懂的命令」跑了除前端以外的一切
     → fail-closed 分支上的洞。
- 三条各配回归守卫（`tests/tooling/test_commit_gate_policy.py`，共 +3 项）并做
  **变异验证**：4 个变异全部被抓到。**第一版守卫没抓到 ps1 那条** —— 它按整段
  分支文本断言，被这段代码自己的注释骗过（注释里就写着 `frontend = $true`），
  改为只看**代码行**后才变红。这正是 TASK-087 §7「断言性质，别断言写法」的
  同一个坑，记在此处以免下次再踩。
- **轮 2：pass，零发现**（只审 P1 修复的 diff）。第一阶段收口。

**轮 3–5：F 批（派生）的审查，共 4 条 P1 全修 + 1 条 rebut**

- 轮 3（2 条 P1）：子串匹配把 `tests.foo_extra` 当成 `tests.foo`；非递归
  `glob` 看不见嵌套目录里的使用者。**两者都给出「部分域」——即跑得比该跑的
  少**，这是唯一不可接受的方向（多跑只是慢）。
- 轮 4（2 条 P1）：正则看不见 `from tests import (换行 foo,)`——括号多行是
  普通 Python，**任何面向行的模式都注定漏**，于是改用 `ast` 解析语法本身；
  探针测试往共享 `tests/` 写文件，让并行 worker 互相干扰（`-n 8` 实测 4 次
  翻 2 次），改为 `_domains_importing(root=...)` + `tmp_path` 完全隔离，
  现连跑 6 次全绿。
- 轮 5（1 条 P1，**rebut**）：运行时拼接的模块名
  （`import_module("." + stem, package="tests")`）静态不可判定。**不予追逐**：
  轮 5 的写法比轮 4 更窄，正是 ADR-0081 说的不收敛信号；后果有界且被兜住
  （本仓库零实例；真出现时只让本地 gate 少跑一个域，而 CI 每次 push 无条件
  跑全量、集成检查点同样跑全量；受影响的是极少改动的测试支撑层）。判断与
  「以后该怎么做」已写进 `commit_gate_policy.py` 的 `_BLIND_SPOT_RE` 注释。
- **轮次超支如实记录**：ADR-0081 是「1 + 1」，本卡用了 5 轮。理由是轮 3–5
  审的是**用户在轮 2 后追加的新范围**（F 批），那是一次新实现、自带额度；
  轮 5 是它的第三轮，超了一轮，因此显式记录而不是静默继续。

**变异验证抓到两个「假守卫」**（值得单独记）：12 个变异全部被抓，但其中两条
守卫的**第一版是无效的**——① forced-full 那条按整段分支文本断言，被这段代码
自己的注释骗过（注释里就写着 `frontend = $true`），把 `$false` 的变异判成绿；
② 前缀那条只断言「没人用的模块名 → 全量」，而带边界与不带边界在该输入上
恰好都给出全量，结果相同掩盖了机制不同。两条都是 TASK-087 §7「断言性质，
别断言写法」的同一个坑，且**只有变异验证能发现**——测试自己是绿的。

**解耦成果被独立应用的首个实证（2026-08-22，TASK-103 会话）**：它给「唯一
fetch 出口」写守卫时，第一版按旧习惯放进 `tests/contract/` 做 Python 源码文本
断言；据 ADR-0080 决策 3 复核后自行改正 —— 被守的 `services/*.js` 都能被 node
import，**不属于那条例外的范围**（例外只给 `.test.mjs` 拿不到的入口层，见
`tests/contract/test_frontend_write_path_invariants.py` 的 docstring），于是搬成
前端套件里的 `mockups/motv-workspace/tests/apioutlet.test.mjs`（`node:fs` 扫
`src/**.js`，成员集合**派生**而非手写），并删掉 Python 侧的重复；两次变异验证
均转红（加一个裸 `fetch` / 去掉一个 `timeoutMs: 0`）。提交 `fc5884d`。
这条记在此处是因为它验证了本卡最容易被误用的那个边界：**例外不是「Python 想
断言前端就放 contract」，而是「只有 node 拿不到的入口层才走那条路」。**

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
