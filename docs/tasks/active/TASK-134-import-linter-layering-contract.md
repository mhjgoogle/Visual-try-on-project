# TASK-134：把 Provider 中立从散文变成 CI 闸门 —— import-linter 分层契约

- 状态：**实现完成**（2026-09-05 实施）· 最终全量见下方「验证」
- Workflow：Refactor（不改有效产品行为，加的是约束的执行方式）· 深度：STANDARD
- 技术目标：AGENTS.md 第 8–9 条（「核心工作流不能依赖任何具体视频厂商」「所有视频生成方法
  必须通过 `VideoProvider` 接入」）今天**只靠人读 diff 守**。散文约束在本仓库有前科：
  同类的「测试归属」在写成 `commit_gate_policy.py` 之前也一直漂。`pyproject.toml` 现在只有
  `[tool.ruff]` 与 `[tool.pytest.ini_options]`，没有任何依赖方向的机器检查。
- 架构约束：`CA §2`（依赖方向）· `CA §4`（测试归属 —— 新增闸门要落进 tooling 域）
- 来源：调研 GitHub 上的 ArcReel 时发现它把同类约束写成了 import-linter 契约。

## 要做什么

在 `pyproject.toml` 加 `[tool.importlinter]` 契约，把依赖方向变成 CI 里会红的东西。
至少两条：

1. **分层契约** —— 核心工作流层不得向上依赖具体 Provider 实现。
2. **forbidden 契约** —— 路线中立的模块不得 import 任何单一 Provider 子包。

## 值得一并抄的是它的 baseline 纪律，不只是工具

ArcReel 在契约注释里写死了三条，每条都对应本仓库踩过的坑：

- `ignore_imports` 掐的是**违规链的终端边而非首跳** —— 这样中间模块后续新增的反向依赖
  仍会被契约拦下，而不是被一条宽松的 baseline 一起放过；
- **新增 baseline 条目前先确认该边无法就地清零，清零一条即删一行**；
- 某个模块**不纳入契约**时要写明为什么，它的原话是：「纳入就要加 baseline 掩盖，
  那等于让契约声明一件它此刻并不成立的事」。

第三条尤其重要 —— 一个声明了假事实的契约比没有契约更糟，它会让人以为那条边已经被守住。

## IN SCOPE

1. 装 import-linter 进开发依赖，写首批契约（先钉住现在**已经成立**的方向，不做重构）；
2. 存量违规逐条判：能就地清零的清零，不能的进 baseline 并写明理由；
3. 接进 commit gate 的 tooling 域与 merge 前全量。

## OUT OF SCOPE

- **不做为了让契约变绿的架构重构**。契约首版只描述现状里已经成立的部分；
  想收紧的方向写成新卡，不在本卡里边改代码边改契约（那样两边都失去基准）。
- 前端侧的依赖方向（`mockups/`）不在本卡。

## 完成判据

1. `lint-imports`（或等价入口）在 CI 与本地 commit gate 里跑，绿。
2. 每条 baseline 条目都有一行注释说明为什么无法就地清零。
3. 故意加一条反向 import 能让它变红（守卫必须真的拦得住它声称要拦的东西 ——
   `tests/tooling/test_lifecycle_check.py` 头部那条纪律同样适用）。


---

## 实施摘要（2026-09-05）

| 变更 | 位置 |
| --- | --- |
| 三条契约 + baseline 纪律注释 | `pyproject.toml` `[tool.importlinter]` |
| `import-linter>=2.0` 进 dev extra | `pyproject.toml`（闸门 fail-closed 依赖它，不是可选优化） |
| `import_contracts` 判定（单一真相） | `.claude/hooks/commit_gate_policy.py` 的 `Decision` |
| 两个 shell 各自消费该 flag | `.claude/hooks/gate.ps1` · `.claude/hooks/gate.sh` |
| 契约形状与接线的守卫 | `tests/tooling/test_import_contracts.py`（10 例） |
| 字段集合同补登 | `tests/tooling/test_commit_gate_policy.py` |

三条契约（名字一律 ASCII，理由见下）：

1. `core workflow must not import a concrete video vendor` —— 23 个核心子包不得
   直接 import `providers.cloud_minimax`（AGENTS.md 第 8 条）。
2. `provider abstraction must not depend on its implementations` —— `providers.base`
   不得反向依赖 `cloud_minimax` / `manual` / `registry`（第 9 条）。
3. `workspace_shell must not bypass the Gateway` —— shell 不得直连 `providers`
   或 `orchestration`（第 4 节 Creation Workspace 边界）。

## 实施中才暴露的三件事

**一、契约首版差点声明了两件不成立的事。** 初稿把 `ai_video_workflow.gateway` 写进
契约 3 的禁列，跑出来才发现 `workspace_shell/app.py` 有一条带注释的
"gateway write path (TASK-031)" —— 经 Gateway 提交命令**正是**第 4 节要求的合规
路径，把它写进禁列等于让契约声明一件与设计相反的事。同理契约 1 初稿禁掉了间接链，
而经 `providers.registry` 间接可达是注册表模式的必然结果，禁它等于禁注册表本身。
两处都改为 `allow_indirect_imports = true` 并把合规入口移出禁列。

**这正是本卡「值得一并抄的是 baseline 纪律」那一节警告的形状**，只是它出现在
禁列而不是 baseline 里，而且是更危险的那个方向（与 56 会话对照后的提炼）：

| | 防什么 | 后果 |
| --- | --- | --- |
| baseline 纪律（原卡抄自 ArcReel） | 用 `ignore_imports` 掩盖真违规 —— 契约声明一件**此刻并不成立**的事 | 漏报：那条边其实没被守住 |
| 本次发现 | 把**合规路径**写进禁列 —— 契约声明一件**与设计相反**的事 | 更糟：会逼后来的人把对的代码改错 |

一句话：**契约必须描述设计意图，而不是描述你此刻脑子里的简化模型。**
推论也很实用 —— **baseline 是给存量违规的，不是给设计意图的**；按设计就该看见
被禁之物的模块，属于契约形状本身（排除在 source 之外），不属于 baseline。

**二、中文契约名会让 `lint-imports` 在 Windows 上直接崩掉。** 契约 name 走 rich
渲染，Windows legacy console 的活动代码页（实测 cp932）编码不了中文，
`UnicodeEncodeError` 当场崩溃；更糟的是崩溃**经管道时退出码会被下游命令盖住**
（`| tail` 之后 exit=0），闸门会把「崩了」读成「过了」。Windows 是权威环境
（第 2 条），所以契约名改为 ASCII，中文理由写在注释里（注释不渲染）。
`test_contract_names_stay_ascii` 守住这条。

**三、`python -m importlinter.cli` 是静默假绿。** 该模块没有 `__main__` 入口，
`-m` 调用打印**零字节**然后 `exit 0`。闸门若接成那样，每条契约都会被报成通过，
而且永远如此。两个 shell 都改用 console script，并由
`test_neither_gate_invokes_the_module_form` 钉死。

## 验证

- **判据 3（守卫必须真能拦住）**：往 `planning/packets.py`、`providers/base.py`、
  `workspace_shell/app.py` 各注入一条被禁的 import，三条契约**分别转红**，
  逐字还原后重新全绿（`--no-cache`，避免 grimp 缓存造成假绿）。
  两条测试守卫也做了变异验证：新增一个未登记子包 → 覆盖守卫转红；
  契约名改中文 → ASCII 守卫转红；两次变异均已还原。
- **判据 1**：`lint-imports` 裸跑（不设 `PYTHONIOENCODING`、不经管道）
  `3 kept, 0 broken`，exit=0。
- **判据 2**：本次 `ignore_imports` **一条都没有** —— 三条契约钉的都是现状已经
  成立的方向，没有需要掩盖的存量违规，因此不存在「无法就地清零」的条目。
  按设计该看见厂商的 `providers` 子包**排除在 source 之外**而非进 baseline，
  理由写在 `pyproject.toml` 注释与 `_EXEMPT_SUBPACKAGES` 旁。
- `pytest tests/tooling` 359 passed / 1 skipped；`ruff check` 与
  `ruff format --check` 均 exit=0。
- 最终全量：见提交信息。

## 独立审查（codex，轮 1）与修复

`VERDICT: fail`，`BLOCKING: none`，判据 2/3 PASS、架构四条全 PASS/NOT_APPLICABLE。
两条非通过项指向**同一个根因**，且都属实：

| 闸 | 结论 | 说的是什么 |
| --- | --- | --- |
| 1 需求完成度 · 判据 1 | `NOT_EVIDENCED` | 「裸跑 `lint-imports` 成功」不证明 **CI** 里跑过 |
| 3 证据充分性 | `INSUFFICIENT` | 那条跨平台守卫「只检查字符串出现，不检查等效的 shell 执行」 |

**修的是实现，不只是证据** —— 复核后发现判据 1 写的是「在 **CI** 与本地 commit gate
里跑」，而 `.github/workflows/ci.yml` 根本没接 `lint-imports`：这不是缺证据，是缺实现。

1. `ci.yml` 的 **windows 与 linux 两个 job** 各加一步 `run: lint-imports`，放在 ruff
   之后、pytest 之前（越界快速失败）。CI 装的是 `pip install -e ".[dev]"`，
   import-linter 已在 dev extra 里，无需另加安装步骤。
2. `test_both_gates_consume_the_flag` 原先对**全文**断言「出现 `lint-imports`」，而这两个
   字符串**在我写的注释里本来就有** —— 把可执行接线整段删掉，守卫照样绿。
   新增 `_executable_lines()` 剥掉整行注释后再断言。
3. **剥注释仍然不够**（我自己的变异验证抓到的第二层）：`gate.sh` 里
   `linter="$ROOT/.venv/bin/lint-imports"` 这条**赋值**也含该字符串，把真正的
   `run_check` 调用删掉照样绿。断言最终落在**执行动作**上 ——
   ps1 认 `Label = 'lint-imports'`（进 `$checks` 才会被跑）、sh 认 `run_check "lint-imports"`。
4. 新增 `test_ci_runs_the_contracts_on_both_platforms`（两个 job 都必须跑）；
   `test_nothing_invokes_the_module_form` 扩到覆盖 `ci.yml`。

**修复后的变异验证**（三处，逐一还原）：删掉 ps1 的 `$checks` 行 → 红；删掉 sh 的
`run_check` 调用 → 红；把 ci.yml 任一 job 的 `run: lint-imports` 换掉 → 红。
修复前的写法在后两处**都是绿的**，这正是审查指出的那件事。

回归：`ruff check` / `ruff format --check` exit 0；`pytest tests/tooling` 363 passed / 1 skipped。

## 独立审查（codex，轮 2）

**这一轮的三条 `NOT_EVIDENCED` 是我的审查调用错了，不是代码问题。** 我用了
`HEAD~2` 作 base，而我提交后另外几个会话又插入了 4 个提交，`HEAD~2` 已经是**别人的**
`d71c9fc` —— 含 `pyproject.toml` 的实现提交 `5b5fc62` 根本不在 diff 里，所以审查者说
「the supplied diff omits `pyproject.toml`」完全正确。**并发分支上不能用 `HEAD~N` 定位
自己的提交**，要用提交号本身。

两条 `NON_BLOCKING` 则是真的，都已修：

| 发现 | 修法 |
| --- | --- |
| 数「出现两次 `run: lint-imports`」不能把它们和**不同 job** 关联 —— 两步挤进同一个 job，守卫仍绿而一个平台失去覆盖 | 加 `_ci_jobs()` 按顶层 job 切分，逐个 job 断言 |
| ps1 的 `Label` 不能确立**被执行的命令** | 断言改为 `File = $linter`，并另断言 `$linter` 指向 `lint-imports.exe` |

**针对性变异验证**（复现审查描述的那个漏洞本身）：把两个 CI 步骤都挪进 windows job
（总数仍为 2）→ 守卫转红；ps1 保留 `Label` 但不再以 `$linter` 为 `File` → 守卫转红；
两处均逐字还原。

### 已知上限（不修，记录）

审查还指出执行标记「可能存活于**行内注释或不可达代码**中」。这是静态断言的固有上限 ——
真正证明 shell 会执行只能靠实跑那个 shell。当前守卫只剥**整行**注释。判断：不为此
继续加码（继续做只会得到更长的正则和同样的上限），真正的闭合手段是 CI 实跑，
而 CI 接线已在本卡内完成 —— 第一次真实运行会给出那个证据。

## 未在真实项目上被人看过

- 闸门在**真实提交**时的表现只在本机 Windows 侧验证（判定逻辑经 `classify`
  单测覆盖五类路径）；`gate.sh` 的 Ubuntu 侧只做了 `bash -n` 语法检查与字段
  一致性断言，**没有在 Linux runner 上真跑过一次带 `lint-imports` 的提交**。
- 新机器上 `.venv` 缺 import-linter 时闸门会 fail-closed 挡住提交，这条
  **只在代码上成立，没有实机演练过**。

## Follow-up

- 契约只覆盖 `src/`。`mockups/` 的前端依赖方向按本卡 OUT OF SCOPE 未纳入。
- 想收紧的方向（例如让 `workspace_shell` 连 `app` 也不得直连）需要先做真实
  重构，按本卡 OUT OF SCOPE 不在这里边改代码边改契约。
