# TASK-105：流程模板第一刀 —— 内置一份 flow，新建项目时可选

- 状态：**第一刀实现完成（2026-08-24）**。代码级证据：
  `mockups/motv-workspace/flowpkg.py`（加载器）、`product-flows/builtin/episode-from-scratch/`
  （内置一份，七步）、`server.py` 的 `_load_flow_catalog` / `GET /api/flows` /
  `_create_project` 的 `flow` 参数、`<ProjectRoot>/studio/flow.json`、
  `services/command.js` 的 `createProject(…, flow)` 与 `listFlows`、
  新建项目对话框的选择框；测试
  `tests/contract/test_motv_flowpkg_task105.py`（36 条）+
  `tests/studio/test_motv_flows_api_task105.py`（13 条）。
- 未在真实项目上被人看过的验收项：**选择框长什么样、从模板起步的项目用起来
  是什么感觉，都还没有人看过**。UI/UX 按 AGENTS.md §1 是「先做一版给他看」，
  这一版就是那个「一版」。
- workflow：Feature ｜ 深度：STANDARD
- 依据：[ADR-0084](../../adr/ADR-0084-project-flow-template-as-a-package.md)
  （Accepted 2026-08-23）「实施」节。ADR 由 [TASK-083](TASK-083-phase3-adrs-first.md)
  ADR-D 定案，实现按 AGENTS.md §2 切成垂直片，本卡是第一片。
- 缺口：GAP-21（[目标流程走查](../../../src/ui-gap-audit/reports/target-workflow-walkthrough.md)）

## 为什么现在只做这一刀

ADR-0084 定的是**机制**（模板 = `kind: "flow"` 的包，复用 ADR-0067 的三级来源、
digest、不可原地覆盖、fail-closed）。一次把三级来源、项目源、`seed.json` 的骨架
深度全做出来，用户直到最后才看得到东西 —— 那正是 AGENTS.md §2 禁的按层拆分。

**这一刀自己就能跑、能演示、能验证**：新建项目时能选一份内置流程，选了以后项目里
真的有那条流程的步骤，并且能回答「这个项目是从哪份模板起步的」。

## IN SCOPE

1. **加载器**：`kind: "flow"` 的包能被读进来并校验（manifest / `flow.md` / `seed.json`
   三件套齐全、`steps[]` 的每个 `(skillId, skillVersion)` 都能解析）。
   加载失败 fail-closed 并说出原因（ADR-0084 决策 6）。
2. **一个内置 flow**：`product-flows/builtin/` 下一份，覆盖当前四步流程。
3. **新建项目时可选**：项目创建界面能列出可用的 flow 并选一份（或不选）。
4. **`createdFrom`**：新项目的 canvas 记 `{flowId, flowVersion, flowDigest}`
   三个字段（ADR-0084 决策 5）。
5. **`product-flows/` 进 [ADR-0077](../../adr/ADR-0077-repository-path-ownership.md)
   的路径所有权表**，并让 `tests/tooling/test_repository_layout.py` 认它。
   ✅ AGENTS.md §3 表 + ADR-0077 补记 + `test_product_assets_own_their_top_level_paths`
   与 `test_the_path_ownership_table_names_both_product_asset_roots` —— 后者钉的是
   「规则写进了会被读到的那张表」，那正是 ADR-0083 落地时漏掉的形状。

## OUT OF SCOPE（明确留给第二刀）

- 项目源 `<ProjectRoot>/studio/flows/` 与用户源 `<应用数据根>/flows/`
  —— 第一刀只有内置源。三级来源的解析顺序在 ADR 里已经定死，实现它不需要
  重新决定任何事，所以推迟它不留决策债。
- **从一个已完成项目导出模板**（反方向）。
- `seed.json` 的骨架深度（几集/几场/几镜）。
- 「复制项目」（ADR-0084 决策 8 明确不在 ADR 范围内，更不在本卡）。

## 验证范围

后端 `tests/backend`（加载器与校验）+ Studio `tests/studio`（创建流程与
`createdFrom`）+ 前端 `mockups/motv-workspace/tests/`（选择界面）。
跨 py↔js 的 flow 契约断言住 `tests/contract/`（ADR-0080 决策 3）。
按 ADR-0081：改的是持久化 + 跨层合同 + 登记 → **要审**，默认 1 轮。

## 动手前必做的一件事（已做，结论记在这）

**先核实 ADR-0067 的加载器今天长什么样**（`skillpkg.py` / `_load_skill_catalog`），
再决定 flow 加载是复用它的哪几段。ADR-0084 说「复用同一套机制」是一个决定，
不是一句对现有代码的描述 —— 现有代码里没有任何 `kind` 的概念。

**核实结论与实际复用面**：

| 复用的 | 怎么复用的 |
| --- | --- |
| 读包文件 + 「文件不得链到包外」围栏 | 把 `load_package` 里那段**提取**成 `skillpkg.read_package_files`（纯搬运，`load_package` 行为一字节未变），flow 调同一个函数 |
| 内容散列 | 直接调 `skillpkg.compute_digest` |
| 目录发现 + 目录围栏 | 直接调 `skillpkg._package_dirs` |
| **跨来源不回退的两种粒度** | 直接调 `skillpkg._shadowed_by_broken` |
| 错误类型 | 复用 `SkillPackageError`，调用方的 `except ValueError` 一处不用改 |

有一条测试**钉住这件事本身**（`test_the_containment_fence_and_the_digest_are_skillpkgs_own`）：
把 `skillpkg` 的那两个函数换掉再看 flow 的行为变不变。变了才说明真的在用它们 ——
照抄一份不会跟着改，也就不会跟着修（TASK-084 项 4 修的正是那道围栏）。

## 第一刀交付了什么

| IN SCOPE 项 | 结果 |
| --- | --- |
| 加载器 + fail-closed | ✅ `flowpkg.load_flow` / `load_flow_catalog`；缺能力或版本对不上 → 整份不可用并**指名道姓** |
| 一个内置 flow | ✅ `episode-from-scratch`，七步，引用的每个 `(skillId, skillVersion)` 都对着真实能力目录验过 |
| 新建项目时可选 | ✅ `GET /api/flows` + 对话框选择框；不可用的模板**带原因**出现在列表里 |
| `createdFrom` | ✅ 三个字段一个不少，写进 `project.json`**与** `studio/flow.json` |
| `product-flows/` 进路径所有权 | ✅ AGENTS.md §3 表 + ADR-0077 补记 |

**选了模板真的会改变项目**，而且是整条路都通：

```
选择框 → POST /api/projects {flow} → <ProjectRoot>/studio/flow.json
       → GET /api/projects/<name>/flow → proddoc.applyFlowSeed(全新画布)
```

`studio/flow.json` 与 `canvas.json` **并列而不是塞进它** —— canvas 的 schema 由
前端拥有并带着一整条迁移链，后端往里写等于凭空多出第二个写者。

第一刀应用的是 `conventions.episodeCount`：从模板起步的项目**一打开就有 12 集的
骨架**，空项目只有 1 集。刻意只做这一条 —— 它是 seed 里唯一一个能在**不发明任何
内容**的前提下改变项目形状的约定（集数是结构，剧本是内容）。

**模板永远不覆盖创作者已经写下的东西**（第 13 条）：应用点卡在「这个项目还没有
画布」（`empty`，不是「读失败」），而 `applyFlowSeed` 自己再判一次「还是不是全新
文档」。读失败时存档还在、自动保存已停，往上套模板会把一次读错变成一次改写。

### 审查（codex，第 1 轮报了四条 P1，全是真的）

1. **选了模板什么也没发生** —— 只盖 `createdFrom` 的章，每份模板造出的项目完全
   一样。这条最重：它让第一刀不成其为垂直切片（AGENTS.md §2）。→ 落 `studio/flow.json`。
2. **seed 的禁止字段只查了顶层** —— 而 seed 天生是嵌套的（集 → 场 → 镜），
   顶层检查等于只挡住最不可能出现的那一层。→ 递归扫描，并报出**在哪一层**。
3 / 4. **跨来源不回退的两种粒度都没实现** —— 更高优先级的来源坏了（整源读不出／
   单个包坏），下面的同名流程照常合进来。屏幕上写着一个名字，跑的是另一个东西。
   → 直接调 `skillpkg._shadowed_by_broken`（本来就该复用的那一段）。

## 第二刀

> **2026-08-24 复核并推进**：这一节原来四条都写着「未做」，其中**第一条已经不
> 成立** —— 它在第一刀收尾时就做掉了（codex 轮 3 报的那条 blocking「选了模板
> 却没应用」正是它）。又一处文档比事实旧。

| 条目 | 状态 |
| --- | --- |
| 前端**应用** `studio/flow.json` 的 conventions 与 seed | ✅ **已做（第一刀收尾时）**：`proddoc.applyFlowSeed` 应用 `conventions.episodeCount`，两处调用点（新建画布 / 迟到的 flow 回来时）。**只做 `episodeCount` 是有意的** —— 它是 seed 里唯一一个能在不发明任何内容的前提下改变项目形状的约定：集数是结构，剧本是内容 |
| **用户源** `<应用数据根>/flows/` 没有内容 | ✅ **已做（2026-08-24）**：导出就是内容出现的方式 |
| **项目源** `<ProjectRoot>/studio/flows/` 没有内容 | ❌ **仍未做**。导出只写用户源。codex 轮 2 把这一行原本写成「已做」报成 blocking —— **判得对**，那是一句假的状态声明，本仓库最贵的那一族缺陷。加载器早就支持项目源，缺的是「导到哪」这个选择；已记为下一刀 |
| 从已完成项目**导出**模板 | ✅ **已做（2026-08-24）**：`POST /api/projects/<name>/flow/export` |
| 「复制项目」 | ❌ **不做**（ADR-0084 决策 8 明确不在 ADR 范围内） |

### 导出携带什么、不携带什么（这一条的全部设计）

| 来源 | 内容 |
| --- | --- |
| 起步用的那份流程 | `steps` —— **从 `studio/flow.json` 原样 carry** |
| 这个项目最后长成什么样 | `conventions.episodeCount` —— **从结果学到的**真事实，也是导出比原模板多出来的唯一东西 |
| 创作者写的内容 | **一个字都不带**。seed 是空骨架 |

**步骤读的是项目自己那份 `flow.json`，不是去目录里查当前版本。** 第一版写的是
后者，错在我自己写下的那条理由上：「不回落到别的模板 —— 那会让导出的模板声称
自己是这个项目走过的路，而其实不是」。源模板升过版之后，「当前的步骤」同样不是
这个项目走过的路。`flow.json` 冻结的是创建那一刻的样子，那才是权威；顺带，
源模板后来被删掉 / 改名 / 升版都不影响导出。

**没有起步流程的项目导不出模板**，而且是**明确拒绝（409 + 原因）**，不是导出
一个空壳：`steps` 必须非空（flowpkg 原话「没有步骤的流程不是流程」），而一个
从零手搓的项目没有任何地方记录过它走的是什么顺序 —— 编一条出来就是发明。

**绝不覆盖**（AGENTS.md 第 13 条）：第二次导出落到带序号的新目录。
`mkdir(exist_ok=False)` 让「先查再建」之间的竞态也落到同一条路上。

**集数读不出来或出界就不写这个约定** —— 不补 0（下一个项目一集都长不出来），
也不猜 1（把「不知道」显示成一个具体答案）。

测试 9 条（`tests/studio/test_motv_flow_export_task105.py`），含**回读**：
导出的包要能被真实的 `flowpkg.load_flow` 读回来 —— 只断言文件写出去了是不够的，
一份加载不回来的模板等于没导出，而创作者会以为导出成功了。

变异验证 3 次：允许覆盖 → 红；把 canvas 塞进 seed → 红；集数出界补 1 → **第一轮
活了下来**（我的测试走的是「读不出来」那条路，它更早就 return None 了），
已补一条参数化测试覆盖 0 集 / 全归档 / 500 集三种出界形状，再跑即红。

**未做**（下一刀）：

- 前端还没有「导出模板」这个按钮 —— 端点可用，UI 是下一刀；
- 导出**只写用户源**。项目源 `<ProjectRoot>/studio/flows/` 要的是一个「导到哪」
  的选择（让项目自己带着模板走），加载器那一侧早就支持了。
