# TASK-147：一个会话一棵树，以及「上一轮那句验证」不再冒充新结论

- 状态：进行中 · **切片 A / B 实现完成**（2026-09-15）。两个独立事实，分开写（AGENTS.md §1）：
  1. **实现完成** —— 代码级证据：新入口 `.claude/tools/worktree.py`
     （`new` / `list` / `json` / `drop`，登记表就是 `git worktree list`，无第二份状态文件）·
     `agent_harness.verification_inputs()` 与 `INPUTS_VERSION` · `read_snapshot` 返回
     `(快照, ok|missing|corrupt)` · `run_resume` 产出 `VALID / STALE / UNKNOWN` 三态 ·
     `_SNAPSHOT_FIELDS` 显式字段名单。
     验证：`pytest tests/tooling` **446 passed / 1 skipped** · `ruff check` + `format --check`
     干净（736 文件）· `lifecycle_check` 0 finding。
  2. **还没在真实项目上被人看过的** —— 见 §6。**这是信息，不是闸门**。
- 起因：产品负责人 2026-09-15 —— 「提升这个 repo 的开发效率，实现 level4 的 AI 驱动
  开发模式」。任务书在 `.claude/tmp/l4-claude-handoff-20260915.md`（一次性产物，
  结论已提炼进本卡，原件任务结束即删 —— AGENTS.md §26）。
  **闸：放行** —— 里程碑闸第 ②/③ 问为 Yes：本轮实测中 `visual-try-on-project-49`
  的提交因共享树归属问题被反复干扰，且 `resume` 的陈旧证据会**静默**冒充有效结论。
  这是对 [TASK-143](TASK-143-one-worktree-per-session.md) 排期的**新增依据**，
  不沿用旧结论把整个专项退回 Backlog，也不改产品 Current Milestone。
- 类型：Refactor（工装，不改产品行为）· 深度：**STANDARD**
  （U：验收判据说得出；I：只波及 agent 工装域；R：`git revert` 就够；C：无对外合同变更）
- 技术目标（本卡无产品 REQ，按 AGENTS.md §20 写技术目标）：
  **让一个会话的在制品不再是其他所有会话的红灯，并且让「上一轮跑过什么」在输入
  变了以后不能再表现为仍然成立。**
- 架构约束：`CA §1`（`.claude/` 是 agent 工装，不是产品代码）· `CA §4`（测试归属：
  工装归 `tests/tooling/`）· AGENTS.md §14/§16/§17（单一实施者、动手前查归属、
  不顺手修范围外）· §20 fail-closed
- 实施 Agent：`visual-try-on-project-49`（2026-09-15 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/l4-loop`，分支 `change/l4-loop`
  —— 本卡**自己就跑在它要交付的那条路径上**。

## 1. 这两片交付什么

**切片 A：一个任务能在自己的工作树里开始和结束。**
`worktree.py new <id>` 建树 + 建 venv + 装 `.[dev,e2e]`；`list` / `json` 看现状；
`drop` 回收，**有未交付内容时拒绝**。

**切片 B：中断后能接着做，旧证据不能冒充新证据。**
`resume` 原来只比 `tip`。于是**同一个 HEAD 下改完文件，旧的「pytest 通过」照样
显示为仍然成立** —— 最省事也最危险的一种自欺：它让人跳过验证却以为验过了。

## 2. 架构决定（结论几行，理由在这里，不另开 ADR）

本卡的决定都落在既有边界内（`.claude/` 工装 + `tests/tooling/` 归属），是加法，
不新建 ADR。三个决定：

**A-1：登记表就是 `git worktree list`，不造第二份。**
TASK-143 OUT OF SCOPE 已经写死「不引入任务分配器 / 锁服务 / 中央协调进程」。
实测支撑：worktree 的 `git rev-parse --git-path hooks` 解析到**主 `.git/hooks`**，
`git config` 也跨 worktree 共享 —— 所以 hook 与配置**装一次覆盖所有树**，
不存在「N 棵树 N 份工装要同步」这件事。

**A-2：每棵树必须有自己的 venv，而且这一步必须由工具做掉。**
不是偏好，是实测：`pip install -e .` 写进 site-packages 的
`__editable__*.pth` 是**绝对路径**。共享一份 venv 给多棵树，
`import ai_video_workflow` 会解析到建它的那棵树的 `src/` —— **测试全绿而测的是
别人的代码**。这正是本仓库反复付账的那一类（「绿 ≠ 测到了」）。
建 venv 用**跑脚本的那个解释器**（`sys.executable`），所以不需要版本探测，
也就没有「`python` 在 PATH 上解析到哪一个」的静默漂移。

**B-1：验证的身份是「这一轮真正消费的输入」，不是 `tip`。**
`verification_inputs()` 摘要五样：HEAD · 分支名 · `git diff HEAD` ·
未跟踪且未 ignore 的文件的**路径与内容** · 测试配置本身
（`pyproject.toml` / `tests/conftest.py`）。**算不出来时返回 `None`**，
调用方必须据此报 `UNKNOWN`。

为什么是三态而不是布尔：`VALID` / `STALE` / `UNKNOWN` 里，第三个是关键 ——
旧实现的 `moved = bool(tip) and ...` 在 git 拿不到 tip 时为**假**，于是渲染成
「tip 没变，仍然对得上这棵树」。**「没发现变化」被当成了「没有变化」。**
`stale` 保留为派生布尔（非 VALID 即为真），既让 fail-closed 成立，也不动渲染层
与既有测试读的那个键。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | 无（本卡写技术目标，不建 REQ —— 它不是「谁在什么时候看到什么」） | 既有 REQ-001～009 一条不改 |
| UI | **无** | 不为工装新增任何产品页面 |
| 数据 Schema | 接续快照新增 `inputs_version` / `inputs` / `inputs_note`；旧格式**保守判 UNKNOWN**，不原地解释 | 用户作品与资产 schema 一个字段不加；快照仍住 `.claude/tmp/`（已 gitignore） |
| Workflow | 开发会话的开始（建树）与接续（证据判词） | 产品视频工作流 · Provider 边界 · dev-workflow 六环 · codex-review-loop 轮次协议 · auto-push 提交/合并规则 |
| 测试 | `tests/tooling/`（新增两个文件；既有 `test_agent_harness.py` 改**一行断言**：比对 `_SNAPSHOT_FIELDS` 而不是 `_RESUME_FIELDS`） | `tests/backend/` · `tests/studio/` · `tests/contract/` · `tests/e2e/` · 前端 —— 本卡不碰 `src/` 与 `mockups/` |
| docs | 本卡 · STATUS/WORKSTATUS 重生成 | AGENTS.md **不改**（规则等这套实测稳定之后再谈，不把一次性实现步骤变成永久规则）· `docs/current-architecture.md` 不改（`.claude/` 的职责描述本来就涵盖它）· 历史 ADR / 旧卡片不动 |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`worktree.py` 四个子命令 · `agent_harness` 的证据身份与三态 ·
两个 `tests/tooling/` 文件 · 本卡。

**OUT OF SCOPE**：改 AGENTS.md / dev-workflow / codex-review-loop / auto-push 的
规则；删除任何既有 guardrail；git 原生 hook 迁移（那是另一件事，本卡不碰）；
常驻调度服务；多实施者同时改同一张卡；产品代码。

## 5. 验收判据与证据

| # | 判据（任务书原文） | 判词 | 证据 |
| --- | --- | --- | --- |
| A1 | 原树有未提交改动时，隔离会话仍能独立提交；原树内容与 index 不变 | `PASS` | 见 §7 交付记录：提交前后主树 `status` 四条一字不差、`diff --cached` 为空 |
| A2 | 含空格路径可运行 | `PASS` | `test_a_path_with_spaces_is_handled`（解析走 `Path`）+ `test_worktree_list_is_parsed_from_git_itself`（含空格的树路径不被切开）；执行侧 `_git` 走 argv 列表，不需要引号学 |
| A3 | 未提交 / 未交付的工作树不能被自动回收 | `PASS` | 实机：`worktree.py drop l4-loop` → `exit=2`，理由「工作区有 5 条未提交改动 / 分支上有 1 个提交还没推到任何 remote」。单元：`test_uncommitted_work_blocks_recycling` · `test_unpushed_commits_block_recycling` · `test_an_unreadable_state_blocks_recycling`（**读不出来也不删**） |
| A4 | 工作树内 hooks / 技能发现 / 归属测试 / auto-push 正常 | `PASS` | 本卡全程在 worktree 内完成：`pytest tests/tooling` 446 passed · `lifecycle_check` 0 finding · 提交与推送见 §7 |
| B1 | 同一 HEAD 下改动文件后，旧验证失效 | `PASS` | `test_editing_a_tracked_file_under_the_same_head_invalidates_it`（用例内**断言 HEAD 确实没变**再断言失效）+ §6 实机演示 |
| B2 | 换分支、换测试配置后失效 | `PASS` | `test_switching_branch_invalidates_it` · `test_changing_the_test_config_invalidates_it` |
| B3 | 损坏快照不能制造 PASS | `PASS` | `test_a_corrupt_snapshot_is_unknown_not_silently_absent`（并断言 `stale is True`：UNKNOWN 必须和 STALE 一样阻止复用） |
| B4 | 比较失败 / Git 不可用显示 UNKNOWN，不因「没发现变化」报有效 | `PASS` | `test_when_the_identity_cannot_be_computed_it_is_unknown_not_valid`（monkeypatch 掉 `_git`，直取旧实现的 fail-open 路径） |
| B5 | 未跟踪文件也算输入 | `PASS` | `test_a_new_untracked_file_invalidates_it` —— 它不在 `git diff` 里，但它会被 import |
| B6 | 摘要是内容的函数，不是时间的函数 | `PASS` | `test_an_unchanged_tree_does_not_drift_between_two_reads` —— 否则「永远报警的警报」会被忽略，然后真的那次也一起被忽略 |
| B7 | SessionStart / 压缩前接线并证明触发 | **`NOT_EVIDENCED`** | 见 §6 第 2 条。**没做，也没假装做** |

## 6. 还没做 / 还没在真实项目上被人看过的

**这是信息，不是闸门**（AGENTS.md §1）：

1. **切片 C / D 的真实产品任务样本**：本卡自身走完了一次「目标 → 实现 → 归属验证
   → 独立审查 → 提交 → 推送」的闭环，但它是**工装任务**，不是用户可见的产品功能。
   任务书 §4D 要求的「连续 5 个真实任务、至少 4 个无工程介入」**样本尚不足**
   —— 按任务书原文：**L4 机制已实现、持续可靠性待观察**，不冒充完成率达标。
2. **B7 SessionStart / PreCompact 接线未做。** `.claude/settings.json` 里今天只有
   `PreToolUse`。本轮**刻意不接**：同一批实测已经证明 PreToolUse 自身存在
   **静默不触发**（14 次提交尝试中 5 次 hook 未被调用，且不可由命令形状复现）。
   在调用可靠性没有观测手段之前，把接续检查挂到同一类接线上，等于把一条防线
   建在一个会安静消失的触发器上。**显式入口
   （`agent_harness.py resume` / `handoff`）已经提供同样的行为**，限制如实记在这里。
3. **git 原生 hook 迁移**：本轮调查结论是「PreToolUse 可作 early feedback，
   不能当 authoritative enforcement」。迁移方案已成形但**本卡不实施**。

## 7. 独立审查（codex，六轮）

行为 + 工装合同改动 → `codex-review-loop`。默认 1 轮，**三条新机理各买了自己的一轮**
（ADR-0081 §2a），另有三条判为同一主题的更窄变体、按 §2b 不买轮但**一次扫完整个类**。

| 轮 | 结论 | 买轮的那条（新机理） | 判为变体、不买轮的那条 |
| --- | --- | --- | --- |
| 1 | fail · 2 BLOCKING | ① detached 工作树整个跳过未推送检查 —— 回收后那些提交只剩 reflog 兜着；② `git ls-files --others` 把中文路径 **C-quote**，摘要因此永远算不出 | —— |
| 2 | fail · 1 BLOCKING | —— | `worktree list --porcelain` 的同一个引号机理。**一次把类扫完**：`-z` 的真实字节先实测再改，`status --porcelain` 只计行数故不动（加 `-z` 反而会把计行弄坏），`log --oneline` 取的是标题不是路径 |
| 3 | fail · 1 BLOCKING | ③ `--base HEAD` 在**主树**上解析 —— 从 feature 树建新树会安静地少掉提交 | —— |
| 4 | fail · 2 BLOCKING | ④ 快照只校验「是个 dict」，缺字段仍可判 VALID | `HEAD~1` 等相对量同机理。**改为一律解析**，不再枚举拼法 |
| 5 | fail · 1 BLOCKING | —— | `""` / `null` 同机理。**改为断言性质**（存在 + 类型对 + 非空），不再逐个补拼法 |
| 6 | **pass** · BLOCKING 为空 · REQUIREMENT / ARCHITECTURE / VERIFICATION 均无 finding | 收口 | —— |

**这条教训值得单独记**：六轮里有**三轮**是「我只修了被点到的那一处」换来的
（轮 2 / 4 / 5）。`codex-review-loop` 的 SKILL 写着 *Fix the whole CLASS*，
而我连续三次先修实例、被审查者用另一个拼法打回。**第三次同主题时才改为断言性质
（`resolve_base` 一律解析、`read_snapshot` 校验性质），之后一轮即 pass。**
代价可量化：三轮 ≈ 本次审查总时长的一半。

## 8. 交付记录

提交与验证证据见提交信息与 auto-push 记录。
