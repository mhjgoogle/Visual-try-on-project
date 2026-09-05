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

### D 剩下的一条

`test_gate_ps1_splits_powershell_with_powershells_own_parser` 在 Ubuntu CI 上红，
但在我的 WSL 上是 **skip**（那儿没装 PowerShell）——GitHub 的 ubuntu runner 预装了 `pwsh`，
所以那条路径**只在 CI 上存在**。取证要么装 pwsh，要么在 CI 上加一次定向跑。未做。

`test_motv_conversation_task109.py` 的两条在 Windows 与 WSL 上都**复现不了**。
CI 上多出来的是一条 `text: ""` 的失败轮次 —— 就是 ADR-0089 决策 6 那条 fail-closed 路径
（Agent 跑失败也要出声）。CI 上没有 `claude` 可执行文件，run 立刻失败并落地；
本机有，run 还在飞，`_get` 就先返回了。**所以那是一条时序断言**，
不是「CI 环境坏了」。归属在 TASK-109，未代改。

## 还欠一件事，而且它才是卡名那句话的正主

A 和 B 修完之后，CI 会不会绿**我今天无法证明** —— 它要下一次 push 到 main 才知道，
而本分支还没合。更要紧的是：**九天没人看见**这件事本身没有被修。
今天能发现，靠的是有人恰好为别的任务给工具加了 `run-list`。

真正的机制（谁在什么时候会被 CI 红叫醒）留在本卡未完成部分。
