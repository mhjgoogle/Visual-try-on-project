# TASK-151：架构依存关系由代码派生 —— 改了 X，谁会跟着受影响

- 状态：进行中
- 起因：产品负责人 2026-09-17 —— 「帮我检查一下现在这个项目可以达到自动识别任务优先
  顺位和理解架构的依存关系了吗」。核实结果：任务侧没有（→ TASK-149 已做）；架构侧
  只有 **3 条 import-linter 禁令**（pyproject.toml）+ `tests/` 根支撑模块的归属派生
  （`commit_gate_policy._domains_importing`），整体依赖图是 CA §2 **手写**的一张图，
  没有工具能回答「我改了 X，还有谁受影响」。产品负责人同日：「把能做的全都做了。」
  · 闸：**用户方向放行**（他那句话问的就是这两半；TASK-149 是前一半）。
- 类型：Refactor（工装，不改产品行为）· 深度：**STANDARD**
  （U：判据说得出；I：只波及工装域，只读代码不改代码；R：`git revert`；
  C：新增一处内部约定 —— 层的划分由 CA §2 的现有措辞派生，不新增合同）
- 成果物：本卡 · `.claude/tools/arch_deps.py` · 测试 · 提交。**无产品 REQ**。
- 技术目标：**「现在的架构长什么样」与「改了 X 影响谁」由代码派生，不靠人读 CA §2
  那张手画的图去猜。** CA §2 仍然是「应当如此」的合同；本卡给它一面从代码长出来的镜子。
- 架构约束：`CA §1`（`.claude/` 是工装）· `CA §2`（依赖方向 —— 本卡**读**它、**验**它，
  不改它）· `CA §4`（测试归 `tests/tooling/`）· AGENTS §3 平台中立 · §20 fail-closed
- 实施 Agent：`visual-try-on-project-b0`（2026-09-17 认领）
- 工作树：`motv-wt/TASK-148-l5`，分支 `change/TASK-148-l5`

## 1. 决定

**D-1：图从 `import` 语句派生，用 `ast`，不执行代码。** 范围是仓库自己的 Python：
`src/ai_video_workflow/`、`src/workspace_shell/`、`mockups/motv-workspace/*.py`
（Studio 后端）。第三方与标准库的边不进图 —— 它们不是「架构」，是依赖清单。

**D-2：层由 CA §2 现有的三个盒子派生，不另造分类。**
`core` = `ai_video_workflow.*` · `shell` = `workspace_shell.*` · `studio` = Studio 后端。
CA §2 的约束原文是「核心库永远不 import 上面任何一层」——
`check` 只验这一条方向 + 已有 import-linter 那三条不重复实现（它们已经在闸门里跑）。

**D-3：`impact X` = 反向传递闭包。** 「谁 import 了 X，谁又 import 了那些谁」——
回答的是「改 X 的接口，最多要看哪些文件」。**不判改动是否真的破坏**，那是测试的事；
本工具给的是**范围**，不是结论。输出按层分组，先近后远。

**D-4：`fail-closed` 在解析上。** 一个文件 `ast` 解析失败 → 整张图拒绝出（那意味着
影响范围少了一片，而少的那一片恰好是看不见的）。

## 2. IN SCOPE / OUT OF SCOPE

**IN**：`arch_deps.py`（`graph` / `impact <module|path>` / `layers` / `check`）· 测试 ·
对着真仓库跑 `check` 的守卫。

**OUT**：
- **不动 CA §2、不动 import-linter 契约**。发现方向违规 → 报，不改。
- **不接进 commit gate**。import-linter 已经在闸门里；本卡先给人用。要接另立卡。
- **前端 JS 的 import 图**。ES module 图是另一套解析器，另立卡。
- **不做「优先级」**：影响范围大 ≠ 该先做。

## 3. 完成判据

1. `arch_deps.py graph` 列出仓库内部每条 import 边；`layers` 把每个模块归到 core /
   shell / studio 之一，一个都不落（落不进去的报出来，不静默）。
2. `impact <模块或文件>` 给出反向传递闭包，按层分组；对一个没人 import 的模块答「无」。
3. `check` 对真仓库验 CA §2「核心库不 import 上层」，有测试对着真仓库跑。
4. 一个解析失败的文件让整张图拒绝出，有测试钉住。
5. 收口时如实写两个独立事实。

## 4. 交付记录（2026-09-17）

**一、实现完成。**

| 判据 | 证据 |
| --- | --- |
| 1 | `arch_deps.py graph` → 真仓库 **181 个模块、1181 条内部边**（含「import 子模块即依赖其祖先包」的边；第一版只记最长匹配时是 798 条，见 §5）；`layers` → core 168 · shell 4 · studio 9，**归不进任何层的：0** |
| 2 | `impact ai_video_workflow.gateway` → **15 个模块**（第一版 9 个 —— 少报的 6 个正是 import 了 `gateway.*` 子模块的人），按层分组；对无人 import 的模块答「无」；接受模块名或文件路径 |
| 3 | `check` → **「CA §2 方向约束在代码里成立」**；`test_the_real_repository_respects_the_dependency_direction` 对着真仓库跑，进 commit gate 与 CI |
| 4 | `test_a_file_that_does_not_parse_refuses_the_whole_graph` |
| 测试 | `tests/tooling/test_arch_deps.py` 11 条 |

**第三方与标准库刻意不进图**（`json` / `os` / `requests` 不是架构，是依赖清单）；
相对导入（`from . import b` / `from ..b import x`）按所在包解析，有测试钉住。

**二、还没在真实项目上被人看过的**：

1. **它只是一面镜子。** CA §2 那张手画的图与代码派生出来的图今天一致（0 违规），
   但没有任何机制在两者漂开时喊 —— 真仓库那条守卫只验方向，不验 CA §2 的**文字**。
2. **没接进 commit gate**（OUT OF SCOPE）。`impact` 现在是给人用的：改一个模块之前跑一下，
   知道要看哪些文件。要让闸门按它选测试域，是另一张卡。
3. **前端 JS 不在图里**；Studio 那 9 个后端模块在。
4. **动态导入不进图**（`importlib.import_module` / `__import__`）。2026-09-17 实测范围内
   **0 处**，所以今天 `impact` 不会因此少报；但没有机制在将来有人加了一处时喊。
5. `src/ui-gap-audit/` 里有 1 个 Python 脚本，目录名带连字符、不是可导入的包，**刻意不扫**。
6. 独立审查：见 §5。

## 5. 独立审查（codex）

| 轮 | 结论 | 买轮的那条 |
| --- | --- | --- |
| 1 | fail · 判据 1/2 `PARTIAL` · 1 BLOCKING | **只记最长匹配会少报**：`from a.b import c` 在 `a.b/__init__` 也定义了 `c` 时边只落到 `a.b.c`，丢了 `a.b`；更一般地 import 任何子模块都执行父包 `__init__`，`impact a.b` 看不见 import 了 `a.b.*` 的人 |
| 2 | 待跑 | —— |

轮 1 修法按类：`_with_ancestors()` 把命中模块**及其所有已知祖先包**一起记，`import` 与
`from … import` 两条路都走它。真仓库边 798 → 1181，`impact gateway` 9 → 15 ——
少报的 6 个正是审查者指的那类。守卫验过：退回只记最长匹配，3 条测试当场红。
