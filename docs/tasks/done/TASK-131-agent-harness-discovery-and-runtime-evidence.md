# TASK-131：让 Claude / Codex 找到同一套技能，并验证工装真正生效

- 状态：**实现完成**（2026-09-05）—— 三个切片 A/B/C 全部落地，证据逐条见 §7。
  **未在真实客户端观察的项目在 §7 里逐条列出**（Claude hook 事件、Codex 生命周期
  事件、Ubuntu 目标），它们是信息不是闸门（AGENTS §1）。一项 `SessionStart` 接线
  被实施 Agent 的会话权限层挡住（配置文件受保护），做法已写进
  [handoff.md](../../../.claude/skills/dev-workflow/references/handoff.md) §3。
- Workflow：Feature（Agent 工装）· 深度：STANDARD。
- 实施 Agent：Claude（2026-09-05 接手并实施）；Codex 做了来源研究、适配说明，
  以及实施后的独立审查（报出两条 P1，见 §7 切片 B）。
- 依据：用户 2026-09-05「研究一下 codex-claude-code-config。看看这个项目可以如何借鉴然后告诉 claude 如何落地。」
- 技术目标：补齐开发技能的跨客户端发现与运行证据，减少“写了规则却没加载、配置了却没执行”的静默失效；保留现有开发流程。
- 架构约束：[CA §1、§4、§5.2–3](../../current-architecture.md)；[AGENTS.md](../../../AGENTS.md) 第 4、14–20、24–26 条。

## 1. 研究结论与范围

借鉴上游的**运行接线验证、技能来源校验、有依据的会话恢复**，按本项目已有机制实现。
本项目已有单一 AGENTS 规则、按需参考文档、四闸独立审查、测试归属、任务生命周期、
auto-push 与 skill-evolution。整包装入另一套治理系统收益低，且会引入冲突。

**IN SCOPE**：项目内开发技能发现、只读工装诊断、必要的轻量恢复说明；测试归属 tooling。
**OUT OF SCOPE**：Studio / 核心库 / product-skills 产品能力；全局安装或同步上游；
重写 AGENTS；替换审查与提交闸门；新增多 Agent 实施框架、聊天档案库或付费调用。
本次交付到本卡与 STATUS；下列切片是交给 Claude 的实施计划，不是已实现能力。

## 2. 已核实的本地事实

| 本地证据 | 判断与落点 |
| --- | --- |
| `CLAUDE.md` 已通过 `@AGENTS.md` 导入唯一规则源 | 上游 cross-harness 规则的核心做法已经有了，不再复制规则 |
| `.claude/skills/` 有 auto-push、codex-review-loop、dev-workflow、product-loop、skill-evolution 共 5 个技能 | 保持这套目录为实现源；不要同步上游整套技能 |
| 项目 `.agents/skills/` 不存在；本次在用户 `.agents/skills/`、`.codex/skills/` 也未找到这 5 个同名目录入口 | 存在可验证的发现入口缺口；这不是对所有插件加载路径或会话实际行为的穷尽证明 |
| `.claude/settings.json` 项目级只登记了 `PreToolUse / Bash\|PowerShell → gate_dispatch.py` | 尚无项目级启动诊断或压缩恢复接线；不能据此断言全局客户端没有其他 hooks |
| `.claude/hooks/gate_dispatch.py` 与 `gate.ps1` / `gate.sh` 已负责原生 gate 分派 | 新诊断检查现有接线，勿另写一套 commit gate |
| `.claude/tools/motv_doctor.py` 检查真实创作项目的事实、写路径、能力输入、执行器 | 它是产品诊断；开发工装诊断另放 `.claude/tools/`，不混入其产品合同 |
| `skill-evolution/scripts/evolution.py` 的 `_revision` 只哈希 SKILL.md；`sync` 同步反馈 registry | 它没有部署技能到 Codex，也没有校验 scripts/references 全包；新工具不要复用其命令名造成误解 |
| `auto-push` 已有 verification_ref、commits 和 merge gate；任务卡与 Review Package 已有判据证据 | 恢复信息引用这些权威记录，不新增第二套 verdict / task 状态机 |

本次 PATH 可解析 python、powershell、bash、codex、claude、node；没有调用模型，
也没有实测客户端 hook 事件。可执行文件存在不代表登录、版本支持或运行成功。

## 3. 上游来源与取舍

研究对象：[AnastasiyaW/codex-claude-code-config](https://github.com/AnastasiyaW/codex-claude-code-config)。
固定源码版本：`e2c14eff8397524dca7b609a3c99baf70216ff8c`（2026-09-05 查询 main tree）；
以下链接固定到此版本。研究读取了源码，没有执行它的安装器或 hooks。

| 来源 | 借鉴方式 / 不照搬的原因 |
| --- | --- |
| [runtime-wiring.md](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/docs/runtime-wiring.md) | 分开证明源文件、运行配置与真实事件；hook 必须有明确职责、正反例及噪声评估。只采纳本卡对应部分 |
| [sync_skills_to_codex.py](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/scripts/sync_skills_to_codex.py) | 借鉴默认 check、显式 apply、同名冲突检测、先保留旧版本。它复制整个目录且保留目标独有文件，不符合本项目不留影子实现的目标，不能原样搬入 |
| [generate_skills_lock.py](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/scripts/generate_skills_lock.py) | 借鉴路径+内容摘要、文本行尾规范化、零输入拒绝成功。本地校验须覆盖实际运行资产；上游只选 SKILL.md、scripts、references，不能据此宣称任意完整技能包均受保护 |
| [verify_plugin_prerequisites.py](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/scripts/verify_plugin_prerequisites.py) | 借鉴 shutil.which；不要搬其固定插件名单。其缺失/坏配置可退为空集合且最终返回 0，只是提示器，不能直接当本项目健康证明 |
| [check_harness_parity.py](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/scripts/check_harness_parity.py) | 借鉴 event+matcher+handler 检查；其部分探针仅打印响应，不能把整个脚本无异常当作断言通过。接线探针仍须经过真实客户端，不能只直调 handler |
| [session-handoff.md](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/rules/session-handoff.md) | 借鉴目标、进度、证据、下一步摘要；不采纳会话启动询问“继续哪个”、常驻增长的手写 INDEX 或原始对话归档 |
| [cross-harness-agents-md.md](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/rules/cross-harness-agents-md.md) | 共享 AGENTS + 客户端薄入口已具备；继续保持 Windows 无 symlink 安装前提 |
| [02-proof-loop.md](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/principles/02-proof-loop.md) | 持久证据与独立验证已由四闸审查承接；不增加四角色、第二套任务目录或额外审查轮数 |
| [autonomy-risk-tiers.md](https://github.com/AnastasiyaW/codex-claude-code-config/blob/e2c14eff8397524dca7b609a3c99baf70216ff8c/rules/autonomy-risk-tiers.md) | 不采纳风险分档或“顺手修复其他 bug”；服从本项目影响范围规则与不扩范围约束 |

官方依据：[Codex Build skills](https://learn.chatgpt.com/docs/build-skills) 说明 repository
`.agents/skills` 发现路径及先元数据后正文的渐进加载；[Claude hooks](https://code.claude.com/docs/en/hooks)
说明各事件输入输出与事件特定的退出码行为。实际接线须同时核对本机版本。
上游关于 Codex hooks 的映射不是本机支持证明；本次官方检索没有确认本机 Codex
生命周期事件能力，保持未知，不能把 Claude 配置直接改个文件名就宣称跨客户端有效。

## 4. Claude 按三个垂直切片落地

### A. 先交付只读工装诊断

建议入口 `.claude/tools/agent_harness.py doctor --json`（拟新增）；默认不写文件、不联网、
不启动模型、不执行任意读到的配置命令。根目录由脚本位置确定，可从子目录调用。

- 输出“源码可读 / 客户端发现入口 / 配置接线 / 真实事件证据”四个维度；
  使用 `PASS / FAIL / UNKNOWN / NOT_APPLICABLE`，附路径与理由。未观察到不能写 PASS。
- 检查上述 5 个技能 frontmatter、规范源路径、必要引用、项目 gate 目标与解释器；
  Python 包在 venv 内检查，外部命令经 shutil.which。对未知 hook 命令只报告，不解析执行。
- 配置缺失、损坏、UTF-8 BOM、无技能输入、目标不可读分别报告；零输入不得得到全绿。
- 所有检测默认项目级；若有效配置来自全局/插件且无法解析，注明覆盖范围与 UNKNOWN。
  不打印 credentials、环境变量值或完整用户配置。
- 严格检查时 required 检查的 FAIL/UNKNOWN 返回非零；启动提示适配器只提示，不阻塞普通对话。
  它不能替代既有 commit / merge gate。

验收：一个命令展示当前 5 个技能在两侧的发现差异；破坏临时 fixture 的路径/配置后能转红，
正常 fixture 转绿；不产生产品或用户目录写入。先做这一片再做 B，不先扩建审计框架。

### B. 给 Codex 加可检查的薄入口，保留一份实现

- 实施前建技术 ADR，明确 `.claude/skills/` 仍是源，`.agents/skills/` 仅是生成的客户端适配入口；
  更新 CA §1 与路径所有权约束。技术决策由实施 Agent 自行 Accept。
- 先对 `dev-workflow` 做单个原型，证实客户端能发现入口并读到规范 SKILL.md，再扩到其余 4 个。
  入口只含必要 name/description、规范文件路径和“先读取它再执行”的指令；不复制 scripts、references
  或治理正文。路径按仓库解析；现有脚本调用仍指向 `.claude/`。
- 同一工具增加 `check` 与显式 `apply`。生成清单放 `.claude/`，记录入口、来源、
  渲染版本、规范源内容摘要；摘要覆盖实际技能内容与相对路径，文本统一行尾，二进制保持原字节。
  不改 `skill-evolution` 的 revision 格式或旧数据。
- 只管理明确归属本工具的入口；遇到他人同名文件、手改生成件、越界或 symlink/junction 目标时
  停止该写入并给差异。修复使用可回滚的版本路径，不静默覆盖；不得留下第二份活动实现。
- 再次 apply 无变化；源变更时 check 转红；目标独有技能不改。目录无效或源集合为空必须非零。
- 薄入口若在真实客户端不能可靠加载，先保留失败证据，在同一卡最小调整适配方式；
  不凭文件生成成功收口，也不顺势全局复制技能。

验收：Claude、Codex 都实际发现 5 个技能，并且至少对 dev-workflow 验证读取同一规范源；
生成检查通过，Windows/Ubuntu 同内容得到相同摘要，现有 gate 与技能路径仍有效。

### C. 用已有任务卡恢复工作，只增加必要的事件适配

- 在 dev-workflow 现有流程中补小节：交接/压缩前更新**本次任务卡**的当前切片、关联判据、
  最后核实的 Git tip、未提交文件归属、已做验证与下一条可执行动作；证据引用现有 Review Package
  或 verification_ref。无任务卡的 QUICK 工作不为恢复机制强建卡。
- 启动读取当前用户意图与相关任务卡，先比对 Git status/tip；不自动恢复不相关旧任务，
  不把“上次测试 PASS”带到内容已变的树上，不新增“是否继续”询问。
- 仅在 A/B 完成后评估本机事件：Claude 可在受支持的 SessionStart 中运行小诊断，PreCompact
  最多保存简短机械状态或提示需要更新证据；不能让脚本伪造语义进度或自动宣告任务完成。
- 不支持的 Codex 事件保留 UNKNOWN/不接线，使用共享技能中的显式恢复步骤；
  不取消原有测试、独立审查和 merge 约束，不把缺失 hook 支持变成新的人工审批闸。
- 临时快照在 `.claude/tmp/` 内按任务/会话隔离；长期结论提炼进任务卡后清理，
  不落原始聊天、不建第二份 task ledger、不在每次 prompt 中遍历历史。

验收：从仓库状态与任务卡可准确复述目标、完成项、未证实项和下一步；换 tip 的旧验证被标为
需重新评估。真实客户端触发与脚本单测分别留证；未实测的客户端事件明确列出，不冒充完成。

## 5. 影响范围、验证与收口

- 修改面限制 `.claude/`、必要的 `.agents/skills/` 薄入口、`tests/tooling/` 和相关治理文档。
  不修改现有产品能力或把本卡混进正在进行的 three-pane Change 清单。
- 测试覆盖：正反例事件、坏/空输入、缺工具、非根 cwd、中文与空格路径、BOM/CRLF、
  跨平台摘要、同名冲突、手改目标保护、重复 apply、陈旧证据、无副作用检查。
- 行为变更跑 `pytest tests/tooling`、ruff、diff 检查；归属映射如受影响必须同步验证。
  独立审查沿用 codex-review-loop 和四闸，默认一轮；不搬上游 swarm 审查。
- 接线实测只能用已授权的客户端会话；如会引入额外付费调用，遵守既有付费授权。
  不能为了拿“真事件”记录私自新建付费调用。无法实测的验收项保留 NOT_EVIDENCED。
- push / merge / 实现交接前按 AGENTS §20–22 完成最终集成检查与待复审清单检查。
  本次纯研究文档不声称完成这些实现验收。
- Claude 开工时检查 Git 状态与文件归属，将本卡移 active 并生成 STATUS；各切片逐项留证。
  实现完成后移 done 并生成 STATUS，分开写“实现完成”与“尚未在真实客户端观察的项目”。

## 6. 研究阶段的交付证据（2026-09-05 上午，Codex）

> 以下是**研究阶段**的记录，一字未改。实施阶段的结果在 §7 —— 那一节里的
> 「实施状态」才是当前事实。

- 已读固定版本的上游运行合同与上述脚本/规则，结合本地配置和相关工装源码逐项对照。
- 实施状态（**当时**）：未开始；本卡是待实施说明，诊断工具、薄入口和恢复适配均未创建。
- 真实验收（**当时**）：A/B/C 全部待实施验证；没有把源码阅读算作客户端运行证据。
- 文档验证：`lifecycle_check.py` 零发现；docs_status、docs_links、lifecycle_check 三组
  定向测试 **58 passed**。首次运行因系统 pytest 临时目录权限产生 setup error，改用本任务
  `.claude/tmp/` 内隔离 basetemp、关闭 pytest cache 后通过；未修改产品或测试代码。
- 范围外观察：部分本地 Skill 参考文案仍含人工确认或旧 gate 描述；本卡实施时只处理
  触及段落与 AGENTS 的冲突，不扩成全库规则重写。当前权威仍是 AGENTS。

---

## 7. 实施记录（Claude 接手，2026-09-05）

- 状态订正：**切片 A / B / C 实现完成**（一处 `SessionStart` 接线被会话权限层挡住，见切片 C）。卡已从 `backlog/` 移入 `active/`。
- 同仓协作：本卡开工时另有两个会话在跑（`visual-try-on-project-2a` 在改
  `mockups/motv-workspace/**` 与 `tests/{studio,contract}/**` 的补审修复，
  `visual-try-on-project-56` 只读调研）。范围已互相确认，本卡只碰
  `.claude/**`、`tests/tooling/**`、`docs/**`，与它们零重叠（AGENTS §14/§16）。
- **本卡不进 three-pane 的 Change 清单**（`docs/auto-push/changes/three-pane.json`），
  这是第 5 节自己的约束。提交落在当前分支上，但不登记进那份清单。

### 切片 A —— 只读工装诊断（实现完成）

交付：`.claude/tools/agent_harness.py doctor`（新增）+
`tests/tooling/test_agent_harness.py`（新增，28 例）。

| 卡上的要求（§4A） | 落在哪 |
| --- | --- |
| 四个维度 + `PASS/FAIL/UNKNOWN/NOT_APPLICABLE` | `DIMENSIONS`、`Finding.verdict` |
| 未观察到不能写 PASS | `check_evidence()` 恒为 `UNKNOWN` 并写明理由；`test_pycache_is_never_accepted_as_proof_that_a_hook_fired` 钉住 |
| 5 个技能 frontmatter + 引用路径 | `check_source()` / `_check_links()`（名单从目录发现，不写死） |
| 项目 gate 目标与解释器 | `check_wiring()`；解释器经 `shutil.which`，**只读不执行** command |
| 缺失 / 损坏 / BOM / 零输入 / 目标不可读分别报告 | `_read_text()` 单独报 BOM；`settings/parse`；`skills-present` 零输入转红 |
| 不打印 credentials / 环境变量 / 完整用户配置 | 解释器只报名字不报解析出的绝对路径 |
| 严格检查时 required 的 FAIL/UNKNOWN 非零 | `exit_code(strict=True)` |
| 根由脚本位置解析，可从子目录调用 | `Path(__file__).resolve().parents[2]`；`test_it_runs_from_any_working_directory` |
| 不产生产品或用户目录写入 | `test_the_doctor_writes_nothing`（整棵 fixture 的 sha256 前后一致） |

**已做验证**：`pytest tests/tooling` 通过（退出码 0）；`ruff check` / `ruff format
--check` 通过；一次顺带的全量 **3860 passed / 59 skipped**（当时的 2 个失败是
本卡移卡后 STATUS.md 未重生成，已修）。

**变异验证**（本仓库的高频缺陷是「守卫看起来加了其实没接上」，所以额外做了这一步）：
分别拿掉 UTF-8 stdout 守卫、BOM 单独报、零输入转红三处实现，对应
`test_the_report_survives_a_non_utf8_console`、`test_a_bom_is_reported_as_its_own_cause`
+ `test_a_settings_file_with_a_bom_is_reported`、`test_an_empty_fixture_is_red_not_green`
**逐一转红**，实现已恢复。

**跑出来的真实结论**（这就是验收要的那份「两侧差异」）：

```
① 源文件    5 个技能 frontmatter 全绿，25 条仓库内链接全部指得着
② 客户端发现 ✗ .agents/skills 不存在 —— Claude 侧那 5 个 Codex 全都看不见
③ 接线      ✓ PreToolUse#1 解释器与目标都指得着
④ 真实证据   ? 接线通，但没有任何记录能证明它被触发过
合计：14 通过 · 1 未通过 · 1 未知
```

**顺带修掉的自身缺陷**：报告在 cp932 控制台上 `print()` 第一个中文字就抛
`UnicodeEncodeError` 并以退出码 1 结束 —— 一个因为自己崩掉而报红的体检比没有体检
更糟（`motv_doctor` 2026-08-31 栽过同一个坑）。已按同一写法加 `_utf8_stdout()`。

### 切片 B —— Codex 薄入口（实现完成，含真实客户端证据）

依据 [ADR-0097](../../adr/ADR-0097-one-skill-source-generated-client-entries.md)。
交付：`agent_harness.py` 增 `check` / `apply`（`--only` / `--prune`）·
`.agents/skills/<5 个>/SKILL.md`（生成物）· `.claude/agent-entries.json`（台账）·
`tests/tooling/test_agent_harness.py` 增 21 例（全文件 49 例）。
`docs/current-architecture.md` §1 与 [ADR-0077](../../adr/ADR-0077-repository-path-ownership.md)
的路径所有权已在同一批里更新。

| 卡上的要求（§4B） | 落在哪 |
| --- | --- |
| 实施前建技术 ADR，更新 CA §1 与路径所有权 | ADR-0097（自行 Accept）· CA §1 新增一行 · ADR-0077 补记 |
| 先对 dev-workflow 做单个原型再扩到其余 4 个 | `apply --only`；下面「真实客户端证据」是原型那一步的产物 |
| 入口只含 name/description + 规范源路径 + 「先读它再执行」 | `_ENTRY_TEMPLATE`；`test_the_entry_points_at_the_source_and_copies_no_body` 断言正文与 references **一个字都没搬** |
| `check`（默认只读）与显式 `apply` | 两个子命令；`test_check_itself_writes_nothing` |
| 清单记入口、来源、渲染版本、源内容摘要 | `.claude/agent-entries.json`，四个字段齐全 |
| 摘要覆盖实际内容与相对路径，文本统一行尾、二进制原字节 | `digest_tree()` / `_normalise()`；CRLF 与 LF 得到同一摘要有用例 |
| 不改 skill-evolution 的 revision 格式或旧数据 | 没碰；ADR-0097 决策 4 写明为什么不复用 |
| 他人同名文件 / 手改生成件 / 越界 / symlink 一律停止该写入并给差异 | `plan_entries()` 四条 `refuse`，每条都有「拒绝之后一个字都没动」的断言 |
| 不留第二份活动实现 | 入口不含正文；`test_a_codex_only_skill_is_left_alone` 保证不越权删别人的 |
| 再次 apply 无变化 / 源变更时 check 转红 / 目标独有技能不改 | 三条各一个用例 |
| 目录无效或源集合为空必须非零 | `entries_exit_code()`；`--root` 不存在 → 2 |

**真实客户端证据**（这是本片验收「Claude、Codex 都实际发现 5 个技能」那一条）：

1. 只生成 dev-workflow 一个入口后，问 codex-cli 0.153.4
   「不要搜文件系统，只按已加载的上下文回答，这个会话里你有哪些技能」——
   它列出的技能里**出现了 `dev-workflow`**，其余四个没有。
2. 全部 5 个生成之后再问同一句 —— **五个全部出现**在它的已加载列表里，
   与它自带的 imagegen / skill-creator 等并列。
3. 另一次点名提问确认它读得到规范源：它答「其 SKILL.md 明确要求完整阅读
   `.claude/skills/dev-workflow/SKILL.md`」。

第 1 与第 2 条是**自动发现**证据（提问明确禁止读文件），不是「我让它去读它就读到了」。
Claude 侧的发现由本会话自身证实：这 5 个技能就是本会话可调用的那 5 个。

**测试抓到的一个真缺陷**（记在这里，因为它正是本仓库的高频形状）：
`_escapes()` 判越界时拿相对路径 `.agents/skills` 做 `.resolve()`，而 `.resolve()`
按 **cwd** 解析。cwd 恰好等于仓库根时它是对的 —— 真仓库里 `apply` 因此一次就成功了，
**什么都没暴露**；换成 fixture 根之后，它把每一个入口都判成「跑出了 .agents/skills」
并全部拒绝。已改为 `root / allowed_parent`。这条与 Follow-up 5.22（`gate_dispatch.py`
用 cwd 解析仓库根）是同一个错误，只是那一处还没炸。

**独立审查（codex 0.153.4，2026-09-05）报了两条 P1，都已修 + 回归**：

1. **`--prune` 会删掉手改过的登记入口** —— 不校验 `entry_digest` 就 `unlink()`，
   他写在入口里的内容永久丢失（CA §5.2 / AGENTS.md 第 13 条）。改法与理由见
   ADR-0097 决策 3 新增的那两行。回归：
   `test_prune_refuses_to_delete_a_hand_edited_orphan` 与它的反方向
   `test_prune_still_removes_a_pristine_orphan`（只写前者的话，一个「什么都不删」
   的实现也能变绿）。
2. **`startswith` 判目录归属，可以写到围栏外** —— `.agents/skills-other` 被判成
   `.agents/skills` 的内部路径（当场复现），且只查末端节点，父级 junction 能绕过
   （CA §5.5）。改成 `is_relative_to` + **从仓库根逐段**核对「解析之后 == 名义位置」。
   回归三条，其中 `test_a_linked_ancestor_is_caught_even_though_the_leaf_is_not_a_link`
   用 **junction**（Windows 上不需要提权，所以它真的跑起来了而不是 skip；
   `is_symlink()` 对 junction 返回 `False`，正是最能证伪「只看末端」的形状）。

修第 2 条时自己又抓到一个：第一版把围栏锚在 `allowed_parent` 上，而它自己就是
那个 junction —— `base.resolve()` 跟着链接走出去，**外面反而成了「里面」**，围栏
正对着它本该拦住的地方。锚点因此改为仓库根。

**已做验证**：`pytest tests/tooling/test_agent_harness.py` 54 passed；
`pytest tests/tooling` 通过；ruff check / format --check 通过；
`apply` → `apply`（无变化）→ `check`（退出 0）连跑确认幂等。

### 尚未在真实客户端观察的项目（切片 B）

- 只验证了 **Codex 能自动发现并读到规范源**。**没有**验证它随后是否真的照 dev-workflow
  的流程执行（那要一次完整的 Codex 开发会话，属于另一件事）。
- 只在本机 Windows 上验证。Ubuntu 目标未实测；摘要的跨平台一致性由
  `test_the_same_content_hashes_the_same_across_line_endings` 覆盖，那是**测试证据**，
  不是在 Ubuntu 上跑过的证据。

### 尚未在真实客户端观察的项目（切片 A）

- 本工具**没有**观察到任何 hook 真实触发事件；④ 维度今天恒为 `UNKNOWN`，这是
  设计如此，不是缺陷。真事件证据属于切片 C。
- 切片 C（会话恢复与事件适配）未开始。

### 切片 C —— 接回来与事件适配（实现完成，一处接线被权限层挡住）

交付：`agent_harness.py` 增 `resume`（`--brief`）与 `handoff` ·
[dev-workflow / references/handoff.md](../../../.claude/skills/dev-workflow/references/handoff.md)（新增）·
`dev-workflow/SKILL.md` 第 0 步加一段指向它 · 测试增 12 例（全文件 66 例）。

| 卡上的要求（§4C） | 落在哪 |
| --- | --- |
| 交接/压缩前更新**本次那张卡**：切片、判据、最后核实的 tip、未提交文件归属、已做验证、下一条可执行动作 | `references/handoff.md` §1 的表；机械那半由 `handoff` 子命令代记 |
| 证据引用现有 Review Package / `verification_ref`，不建第二套 | §1 明写；快照里只有 tip/分支/跑过什么/下一步 |
| 无任务卡的 QUICK 工作不为恢复机制强建卡 | §1 末句 |
| 启动先比对 Git status/tip；不自动恢复无关旧任务 | `resume` 三段输出；§2 的四步顺序 |
| **不把「上次测试 PASS」带到内容已变的树上** | `run_resume()` 比对 tip，变了就标 `⚠ 要重新评估`；`test_a_snapshot_from_another_tip_is_flagged_stale`（做了变异验证：把 `moved` 写死 False，它当场转红） |
| 不新增「是否继续」询问 | §2 末句；`resume` **恒为退出码 0** —— 能报红就等于加了一道会被绕过去的闸，有用例钉住 |
| 不让脚本伪造语义进度或自动宣告完成 | 快照字段集写死为 tip/分支/verified/next/at；`test_a_snapshot_holds_no_semantic_progress` 断言 `done/complete/progress` 这类键**一个都不许出现** |
| 临时快照按任务隔离在 `.claude/tmp/` | `RESUME_DIR`；两条用例（不在 `docs/` 下 · 真仓库里确实被 gitignore） |
| 不支持的 Codex 事件保留 UNKNOWN、不接线 | `references/handoff.md` §3 的表，Codex 那行写的就是 `UNKNOWN` |

**`resume` 当场证明了自己**：跑第一次时它把 `AGENTS.md` 与 `.claude/tools/lifecycle_check.py`
列进「未提交」—— 那是同仓另一个会话正在写的东西。本会话今天差点覆盖掉第三个会话
未提交的补审修复，当时没有任何东西提醒（AGENTS §14/§16）。这一段就是为那件事写的。

**`--brief` 的噪声评估**（上游 runtime-wiring 的要求）：这段输出会进**每个会话**的
上下文，成本永久、收益只在确实有事时出现。所以它的规矩是**没话说就一个字都不说**，
且只说两件事：工作树里有别人的改动、某条验证记录的 tip 已经变了。干净的树 +
没有过期快照 → 输出空串，有用例钉住。

**棘轮在真仓库里生效了**：改完 `dev-workflow/SKILL.md` 之后 `check` 立刻转红
（`dev-workflow: update —— 源或渲染器变了`），`apply` 之后回绿。这不是构造出来的，
是这次改动自己触发的。

**已做验证**：`pytest tests/tooling/test_agent_harness.py` 66 passed；
`pytest tests/tooling` 通过；ruff 通过。

### 被外部限制挡住的一项（如实记，不冒充完成）

`SessionStart` 接线**没有落地**：实施 Agent 的会话权限层拒绝编辑
`.claude/settings.json`（配置文件受保护）。这是外部限制，**不绕过**。

要接的话只需往 `.claude/settings.json` 的 `hooks` 里加一段，原文在
`references/handoff.md` §3。**不接也不影响任何东西** —— `resume` 自己跑一遍是
同样的结果；缺 hook 支持不得变成一道新的人工闸（AGENTS §1）。

### 尚未在真实客户端观察的项目（切片 C）

- `SessionStart` / `PreCompact` 两个事件**一次都没有被真实触发过**，因为接线没落。
  `doctor` 的 ④ 维度因此仍然是 `UNKNOWN` —— 这是诚实的，不是缺陷。
- **Codex 的生命周期事件本机没有核实过**：不知道它支持哪些、语义是否相同。
  保留 `UNKNOWN`、不接线，用 `references/handoff.md` §1/§2 的显式步骤代替。
  「把 Claude 的配置改个文件名就宣称跨客户端有效」是本卡明令禁止的。

### Follow-up（不在本卡范围，记账不顺手修）

- `.claude/hooks/gate_dispatch.py` 用 `Path.cwd()` 解析仓库根，而不是脚本位置。
  客户端若以非仓库根为 cwd 触发 hook，它会去错误的位置找 `gate.ps1` / `gate.sh`。
  今天没观察到实际失败，但这与本卡给新工具定的「根由脚本位置解析」是同一条纪律。
  → 记入 [TASK-087 欠账总账](../active/TASK-087-followup-ledger.md)。
