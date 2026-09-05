# TASK-140：main 的 CI 连续八次全红，而没有人看见

- 状态：**进行中**（2026-09-05 接手）· 两个根因已定位并修复，其余按簇登记
- Workflow：Bug · 深度：STANDARD（先复现拿证据，再找根因；**禁止不懂根因就连环 patch**）
- 技术目标：AGENTS.md 第 20 条把**全量**定义为「集成检查点 —— CI、连续链链尾、
  merge 前、发布/交接前」。**其中 CI 这一路已经失效九天以上，而没有任何机制会喊。**
- 架构约束：`CA §4`（测试归属 —— CI 跑的是两阶段 pytest + 全量前端 + ruff）
- 来源：做 TASK-134（把依赖方向契约接进 CI）时，为取证给 `.claude/tools/gh-api.py`
  加了 `run-list` / `run-view`，第一次查就看到了这个。

## 事实（2026-09-05 用 `gh-api.py run-list --branch main` 取得）

```
33058868594  completed/failure  main  4cf84d77ee78  2026-08-27T09:30:21Z
33058454395  completed/failure  main  75290cc63b96  2026-08-27T09:24:55Z
32962933162  completed/failure  main  e43252b4271e  2026-08-26T11:21:44Z
32853209238  completed/failure  main  cf7044966de4  2026-08-25T13:25:11Z
32852625622  completed/failure  main  663a2dfd3cc9  2026-08-25T13:19:20Z
32852124063  completed/failure  main  582dd73c53be  2026-08-25T13:14:13Z
32733841589  completed/failure  main  d8ab806b4ccf  2026-08-24T13:38:03Z
32733226325  completed/failure  main  6729c8f0a681  2026-08-24T13:31:52Z
```

**连续八次，无一例外。** `run-view 33058868594` 显示两个 job（Windows 权威 /
Ubuntu 受支持目标）都停在同一步：

```
success  Ruff lint
success  Ruff format check
failure  Pytest (parallel)          ← 两个 job 都是这里
skipped  Pytest (serial process-tree tests)
skipped  Frontend unit tests (motv mockup)
```

前端测试**从未跑到**（前一步失败就 skip 了），所以「前端在 CI 上绿过」这件事，
最近九天里一次都没发生。

## 为什么没人看见（这才是要修的东西）

1. **没人看**：这个仓库的日常验证是本地 commit gate + 本地全量，merge 不经 PR
   （ADR-0085 去掉了人工闸）。CI 的结论因此**不进任何决策路径**。
2. **看不了**：本机没有 `gh`，而 `.claude/tools/gh-api.py` 在 TASK-134 之前只有
   四个 `pr-*` 子命令 —— **没有任何入口能查 workflow run**。想看也没工具。
3. **触发面窄**：`on.push.branches` 只有 `[main, "feat/**"]`，而所有开发都在
   `change/**` 分支上。开发期的每一次 push 都不会触发 CI，问题只能在 merge 之后
   才暴露，而那时已经没人在看了。

三条叠起来的效果是：**一个写在规则里的集成检查点，事实上九天没有产生过任何约束。**

## 要做什么（不预设根因）

1. **先复现拿证据**：本地能否复现 `Pytest (parallel)` 的失败？两个平台都失败说明
   多半不是平台差异。注意本地全量当前是绿的（TASK-134 收口时 3922 passed），
   **所以这大概率是 CI 环境与本地环境的差异**，而不是代码本身坏了 —— 别一上来就改代码。
2. 找到根因后再决定修法。
3. **让它以后能被看见**：至少一条 —— 把 `change/**` 纳入触发面，或在 merge 前把
   「CI 最近一次绿」列进 Merge Gate 的前置条件（第 22 条那张清单现在没有这一项）。

## OUT OF SCOPE

- 不在本卡里改 `pytest` 的并行度、超时或 marker 语义来「让它变绿」——
  那是把红灯拧掉，不是修。
- 不改 ADR-0085 的 merge 无人工闸决定；本卡只补它缺的机器证据。

## Follow-up 关联

- TASK-134 的判据 1「`lint-imports` 在 **CI** 与本地 commit gate 里跑，绿」
  因本卡而**无法闭合**：契约的 CI 接线已经写好并推送，但 `change/**` 不触发 CI，
  而 main 上的 CI 本身是红的。那张卡因此留在 `active/`。

## 取证（2026-09-05 接手，用新加的 `gh-api.py run-log`）

`run-view` 只说得出「哪一步红了」，说不出**红成什么样**。所以先给工具加了
`run-log`（与 b5 加 `run-list` / `run-view` 同一处）：

```
gh-api.py --repo <owner/name> run-log --number <run> --failed-only --grep FAILED --tail 30
```

**一条安全约束写在它的实现里**：日志端点会 302 到 GitHub 的对象存储域，而 urllib
默认会把 `Authorization` 原样重发到重定向目标 —— 那等于把 token 交给一个我们没打算
给它 token 的 host。所以 `run-log` **拦住重定向**，拿 `Location` 之后**不带任何凭据**
再取一次（那个 URL 自带签名）。

最新一次 main 的 run（`33964496844`，2026-09-05 11:52）逐条读完，**不是一个根因，
是四簇，两个 job 各自不同**：

| 簇 | 表现 | 出现在 |
| --- | --- | --- |
| **A** `datetime.UTC` | `AttributeError: module 'datetime' has no attribute 'UTC'` ×5 | 两个 job 都有 |
| **B** `/dev` 被自己的安全规则拒 | `RootRejected: 这是受保护的系统或仓库目录…：/dev` ×约 70 | 只有 Ubuntu |
| **C** main 自己的文档陈旧 | `test_docs_links` / `test_docs_status` | 只有 Ubuntu |
| **D** 零散 | skillpkg 符号链接 `KeyError`、对话分线多一条空串、gate 策略在无 PowerShell 环境下 | 各一 |

## 根因 A：本地永远绿、CI 永远红（已修）

`.claude/tools/agent_harness.py:683` 用了 `datetime.UTC` —— 那是 **Python 3.11
才有的别名**。而 CI 两个 job 都跑 **3.10**（`.github/workflows` 里写死），
`pyproject.toml` 也声明 `requires-python = ">=3.10"`。

**这是一个硬矛盾，不是环境噪音**：代码用了声明范围之外的 API。本地是 3.13，
所以它在这台机器上永远绿 —— 而「本地全量绿」正是这九天里所有人依据的东西。

修法：改用 3.10 也有的 `datetime.timezone.utc`（**不是**抬高 `requires-python`）。
理由：声明的下限是仓库对外的承诺，改代码去满足承诺，比改承诺去迁就一行代码便宜。

## 根因 B：测试的临时目录被产品自己的安全规则拒了（已修）

`tests/conftest.py` 把 pytest 的 `basetemp` 挪到 `/dev/shm`（tmpfs），为的是避开
WSL2 上每次 fsync ~85ms。它的判据是「`/dev/shm` 可写就用」，注释里写着
「CI / macOS 上没有可写 tmpfs，所以是 no-op」——

**那句话是错的。GitHub 的 ubuntu runner 有可写 `/dev/shm`。**

于是 CI 上每个 `tmp_path` 都落进 `/dev/shm/…`，而 `mockups/motv-workspace/rootadmit.py`
的保护清单里有 `/dev`（产品规则：用户资产不许放进系统目录，这条**没有错**）。
两条各自正确的规则相撞，Ubuntu job 因此 82 failed + 14 errors。

修法：把判据从「有没有 tmpfs」改成「**是不是 WSL2**」（读 `/proc/sys/kernel/osrelease`
找 `microsoft`）—— 那正是这段优化的本意，注释里本来就是这么写的。

## 还没修的（C / D），以及为什么先不修

- **C** 是 main 自己的状态：本分支上 `STATUS.md` 与链接都已修好，合并即消失。
  **先不动 main**，否则等于绕过分支去改主干。
- **D** 三条各自独立，需要各自取证（符号链接在 Windows CI 上的权限、对话分线那条空串、
  gate 策略在没有 PowerShell 的环境下的期望）。按 Bug 工作流「先复现拿证据再修」，
  不在同一批里连环 patch。

## 2026-09-06：开 PR 跑合并结果，D 里三条中的两条已取证并修掉

开 [PR #2](https://github.com/mhjgoogle/Visual-try-on-project/pull/2)（分支 → main）
让 CI 跑**合并后的结果**。它当场推翻了上一段那句「C 合并即消失」：
`docs_links` 在合并结果上是红的 —— TASK-041 搬进 `done/` 时，引用它的 TASK-136 没跟着改
（本地两条路径都存在过所以一直是绿的）。已修（3482fbc）。

**取证手段这次换了一件**：WSL 里的 Ubuntu-22.04 是 **Python 3.10**，
与 CI 的 Ubuntu job 同一个小版本 —— 也就是说 D 里那两条「只在 CI 上跑得到」的测试，
在本机是可以真跑的，只是九天里没人在那儿跑过。

| D 的哪条 | 根因 | 结论 |
| --- | --- | --- |
| `test_a_package_file_symlinked_outside_the_package_is_refused` | **测试与 ADR-0067 决策 7 矛盾**：它断言坏掉的 project 包会回落到 builtin（`skills["story-development"].source != "project"`），而决策 7 恰恰禁止跨源回落，`load_catalog` 从来没那么做过。同族的 `test_a_broken_high_priority_package_does_not_fall_back` 写的才是对的形状 | 已修：改断言为 `not in catalog.skills`。Linux/3.10 上修前红、修后绿（同一台机器上做的反向验证） |
| `test_tts_voice_param_validated_and_falls_back_honestly` | **测试把语音模型写错了目录**：`data_dir` fixture 把 `DATA_DIR` 打到 `tmp_path/"mockdata"`，却返回 `tmp_path/"account"`（ADR-0053 之后它的职责变成账户根，名字没跟着改）。默认模型靠 `_TTS_MODEL` 打桩救回来了，per-character 那条查的是 `DATA_DIR` —— 于是它**从来没有真正验证过**那条产品逻辑 | 已修：模型写进 `server_module.DATA_DIR / "tts"`。Linux 上 7 passed |

两条的共同点值得记下来：**它们都不是产品坏了，是测试在断言一件产品从不做的事**，
而且都只在本地会 skip 的路径上（Windows 无提权建不了符号链接；TTS 那条整条 `skipif win32`）。
「本地全量绿」对这类东西**一个字都没说**。

## 2026-09-06 第二轮：簇 C 不是「合并即消失」，是三条真的平台相关缺陷

第二次 CI（Ubuntu 5 failed / Windows 1 failed）把 C 拆开了。三条都是**同一个形状**：
**判定结果取决于自己跑在哪** —— AGENTS §3「平台中立，不是 POSIX」正是禁这个。

| 红的那条 | 真正的原因 |
| --- | --- |
| `test_docs_links` | 守卫**没跳过围栏代码块**。`dev-workflow/references/lifecycle.md` 里有一段 ADR 双向取代的**模板**，写着 `[ADR-XXXX](...)`，目标字面量是三个点。Windows 会把纯点路径规范化掉（`x/...` → `x`，存在），Linux 不会。围栏里的东西根本不会被 markdown 渲染成链接，所以它不可能「断」—— 加了 `_strip_fences`（CommonMark 的同种字符 + 不短于开启的闭合规则），并留了 7 条形状用例证明它仍然抓得住真断链 |
| `test_docs_status` | **`sorted()` 比较 `Path` 时用的是 `_str_normcase`：Windows 折叠大小写，POSIX 原样比。** 于是 `docs/STATUS.md` 的生成顺序在两个平台不同，而这个文件要被逐字节比对 —— `design/done/` 里 M1-/TASK-/WFM1-/WSM3- 那 8 行的位置差异就是它。改成 `key=lambda p: p.name`，其余四处对 Path 的排序一并钉死 |
| `test_gate_ps1_splits_powershell_with_powershells_own_parser` | 断言写的是「`&&` 一定解析不了」—— 那是 **Windows PowerShell 5.1** 的事实，而 GitHub 的 ubuntu runner 预装的是 **pwsh 7**，它支持 `&&`。改成断言**结论**：两条路径都必须仍然进闸门（`check`），不因为「切开了」变成 skip |

**本机三处（Windows / WSL / worktree）都没有 pwsh**，所以第三条的 pwsh-7 分支
**只能由 CI 验证** —— 我没有本地证据，如实记在这里。前两条在 WSL 的
Ubuntu-22.04 / Python 3.10 上实跑过（同一份 `STATUS.md` 在两个平台都绿）。

顺带一条别当成 CI 问题的：在 WSL 里跑 `tests/tooling` 全量会多出 20 条红，
报的是 `set: pipefail: invalid option name` —— **Windows 检出的 CRLF**，
AGENTS §3 第 5 条早就写着。CI 用 LF 检出，与它无关。

## 2026-09-06 第三轮：Windows 的 Python 测试全绿了，露出后面那一步

第三次 CI：**Ubuntu 1 failed / Windows 的 pytest（并行 + 串行）全过**。
前两轮修的东西在 CI 上逐条消失。这一轮的两条都是新露出来的：

**1. Windows 的前端测试步骤从来没有跑过。** 它九天里一直显示 `skipped` ——
因为前面的 pytest 先红了，后面的步骤根本不执行。这一轮 pytest 绿了，它才第一次
真的执行，然后立刻失败：

```
Could not find 'D:\a\...\mockups\motv-workspace\tests\*.test.mjs'
```

Windows job 的默认 shell 是 **pwsh**，而 **PowerShell 不替原生命令展开通配符** ——
node 收到的是字面量。修法是给这一步加 `shell: bash`，让两个 job 跑**同一条命令、
同一个 shell**（ADR-0062 决策 3 要的正是这个形状）。**不**改成引号让 node 自己 glob：
那需要 Node 21+，而工作流钉的是 Node 20。

本机（Windows，Node 24）实跑那 122 个文件：**2247 passed / 0 failed**。
如实记一条缺口：**CI 用的是 Node 20，我本机是 24**，所以「Windows 上前端会绿」
这句话我只有 Node 24 的证据。

**2. 链接守卫还得跳过行内代码。** 上一轮加了围栏跳过之后，剩下的唯一一条断链
**是本卡自己造的** —— 上面那段讲「守卫漏了围栏」的表格里，把那个模板原样写了
一遍（在反引号里）。反引号里的东西同样不会被渲染成链接，是同一类。已加
`_CODE_SPAN`，并补了「孤立反引号不得吃掉整行」的用例，免得它变成一个漏报机器。

### D 剩下的一条

`test_gate_ps1_splits_powershell_with_powershells_own_parser` 在 Ubuntu CI 上红，
但在我的 WSL 上是 **skip**（那儿没装 PowerShell）——GitHub 的 ubuntu runner 预装了 `pwsh`，
所以那条路径**只在 CI 上存在**。取证要么装 pwsh，要么在 CI 上加一次定向跑。未做。

`test_motv_conversation_task109.py` 的两条在 Windows 与 WSL 上都**复现不了**。
CI 上多出来的是一条 `text: ""` 的失败轮次 —— 就是 ADR-0089 决策 6 那条 fail-closed 路径
（Agent 跑失败也要出声）。CI 上没有 `claude` 可执行文件，run 立刻失败并落地；
本机有，run 还在飞，`_get` 就先返回了。**所以那是一条时序断言**，
不是「CI 环境坏了」。归属在 TASK-109，未代改。

## 2026-09-06 收束：CI 在合并结果上全绿，触发面补上了 `change/**`

**第四次 CI 全绿**（run `33980065906`）。它跑的是**合并后的结果** —— 日志里是
`HEAD is now at f16b211 Merge ed9043e into cd9ef06`，两个 job 的**每一步**都 success，
含九天来第一次真正执行的 Windows 前端步骤。

| 轮次 | Ubuntu | Windows |
| --- | --- | --- |
| main 原状 | 82 failed + 14 errors | 7 failed |
| 只带 A/B 两修复 | 8 failed | 2 failed |
| 分支第 1 轮 | 7 failed | 3 failed |
| 第 2 轮 | 5 failed | 1 failed |
| 第 3 轮 | 1 failed | pytest 全过，前端步骤首次执行并失败 |
| **第 4 轮** | **绿** | **绿** |

### 「要做什么」第 3 条已做：触发面加了 `change/**`

此前触发面只有 `main` 与 `feat/**`，而本仓库的日常工作**全在 `change/**` 上** ——
于是一条改动**第一次遇到 CI 是在它已经合进 main 之后**。这就是「没人看见」的
机制性原因：唯一会喊的地方在最晚的时刻。公开仓库的 Actions 不计费，所以这条
不构成花钱决定（AGENTS §1）。

**这同时解开了 TASK-134 的判据 1**（`lint-imports` 在 CI 与本地 gate 里都绿）——
它此前无法闭合的两个理由（`change/**` 不触发 CI + main 上的 CI 本身是红的）
现在都不成立了。那张卡由它自己的会话收口，本卡不代改。

### 独立审查（codex 0.153.4，1 轮 + P1 复审）

第 1 轮：Requirement 8 条里 **7 条 PASS、1 条 FAIL**，Architecture `CA §3` PASS，
Verification **INSUFFICIENT**，两条 BLOCKING —— 全都落在**我自己新加的那个链接
守卫**上，而且都是真的：它会在某些形状下**变瞎**。

| P1 | 形状 | 后果 |
| --- | --- | --- |
| a | `` …链接… `（开启两个反引号、闭合一个，**不等长**） | 正则回溯成「单反引号跨」，一条**真断链**被吞掉 |
| b | 单独一行的 ```example``` | 被当成**没有闭合**的围栏，**它之后的整份文件都不再检查** |

两条都修：代码跨两侧加「前后不得再是反引号」（CommonMark 要求恰好等长）；
反引号围栏的 info 串里不得再有反引号。

**审查者还指出一件我确实做错的事**：我在 Review Package 里写「另配 7 条形状用例」，
但那 7 条**只在命令行跑过，没有进仓库** —— 那不是证据，是说法。现在 13 条形状
用例住在 `tests/tooling/test_docs_links.py` 里（`_SHAPES` + parametrize），
每一条「该跳过」旁边都钉一条「不许跳过」。

反向验证：把两条修复各自退回旧行为，**恰好**对应的那一条转红，其余 12 条不动。

#### 第 2 轮：又报一条 P1，我判它是同一主题的更窄变体，不再买轮 —— 但修掉整类

第 2 轮：P1-b PASS、触发面 PASS，P1-a **PARTIAL** 并附一条新的 BLOCKING：
一个**合法**的代码跨里含有**更长**的内部反引号串时，正则会拒掉那个跨、
改从内部那条串一路吞到行尾，真链接又被吞掉。

**范围判断（ADR-0081 §2b/§2c，判据是失效机理不是代码位置）**：这与第 1 轮的
P1-a 是**同一个机理** —— 我用正则去猜 CommonMark，猜偏了就把真链接吞掉；
两轮报的只是同一件事的两种拼法。按协议**不再买第三轮**。

**但不买轮不等于不修，而且这次修的是整类**：删掉那条正则，改成照 CommonMark
的规则**扫**（`_strip_code_spans`）—— 一条开启的反引号串必须由一条**长度完全
相同**的串闭合，找不到就只是普通文本；跨的内部允许更长或更短的串。这条规则
本身就是 CommonMark 的定义，所以它不再有「下一种拼法」。

证据（变异验证，17 条形状用例）：

| 把实现退回到 | 转红的用例 |
| --- | --- |
| 最初的正则（无等长断言） | 不等长的串 · 合法跨里的更长内部串 |
| 第 1 轮修复后的正则 | 合法跨里的更长内部串 |
| **现在的 CommonMark 扫描** | **一条都不红（17/17）** |

验证：Windows `pytest tests/tooling` **402 passed**；
WSL Ubuntu-22.04 / 3.10 `docs_links + docs_status` **42 passed**。

**四闸收口**：Requirement 全 PASS（P1-a 的 PARTIAL 由本次类修复闭合）·
Architecture `CA §3` PASS · Verification 由 17 条进仓库的用例 + 变异验证补足 ·
无未闭合 P1。

### `change/**` 当场自证了

加上触发面之后的第一次 push（`002bd01`）**同时跑出两个 run，两个都绿**：

- `33982116671` —— 分支自身（`push` 触发，这条以前不存在）
- `33982119184` —— 合并结果（`pull_request` 触发，日志：`HEAD is now at 8658caf
  Merge 002bd019… into cd9ef060…`）

**Follow-up（本卡不做，记在这里）**：同一个提交现在会跑两遍 CI。公开仓库不计费，
只是噪音 + 可能排队，加一个 `concurrency: {group: ci-${{ github.ref }},
cancel-in-progress: true}` 就能收掉（push 与 pull_request 的 `github.ref` 不同，
所以两条线各自收敛、不会互相取消）。**不在这一批扩范围。**

### 卡名那句话还剩什么

「让它以后能被看见」的另一半 —— 把「CI 最近一次绿」列进 Merge Gate 的前置 ——
**没做**。它要改 `auto-push` 的脚本，而那是别人的在办范围（EP-002 正在动它）。
本卡按「至少一条」交付触发面这一条，另一半登记在此，不顺手改别人的东西。

## 还欠一件事，而且它才是卡名那句话的正主

A 和 B 修完之后，CI 会不会绿**我今天无法证明** —— 它要下一次 push 到 main 才知道，
而本分支还没合。更要紧的是：**九天没人看见**这件事本身没有被修。
今天能发现，靠的是有人恰好为别的任务给工具加了 `run-list`。

真正的机制（谁在什么时候会被 CI 红叫醒）留在本卡未完成部分。
