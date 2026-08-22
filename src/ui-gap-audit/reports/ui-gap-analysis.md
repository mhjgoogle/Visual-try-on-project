# UI Gap Analysis — Current (motv Studio) vs Target (LibTV)

**日期** 2026-08-16 · **Commit** `18fa281`
**Current** = 真实 Connected Project `照见未明rev2`，截图 C-001…C-020
**Target** = 用户指定的 `liblib.tv`，用**用户自己的登录态**抓取，截图 T-001…T-007

> **数字口径更正（2026-08-16，TASK-078 §1.a 查清）**：本报告初稿写「38 镜」，
> 那是对着**第一轮**截图（`archive/2026-08-16-pre-task077/`，commit `18fa281`）写的。
> 真实项目 `照见未明rev2` 现在是 **60 镜**（`scriptgen.versions[v=1].raw` 实测 60 条），
> 不是过滤也不是缺陷 —— 是第一轮之后项目数据本身变了。全文已更正为 60。

配套阅读：[current-capabilities.md](current-capabilities.md)（现状能力盘点）、
[feature-matrix.md](feature-matrix.md)、[user-journey-matrix.md](user-journey-matrix.md)。

---

## 第 0 部分 — 目标 UI 的产品模型（先理解，不要先抄）

在提出任何改动之前，先说清 LibTV 到底是**什么形状的产品**（§20 要求）。

### T-003/T-005/T-007 编辑器 = 一块无限画布

| 维度 | LibTV 的答案 |
| --- | --- |
| **User Goal** | 「把我脑子里的一个画面/一段片子做出来」 —— 单件产出导向 |
| **核心对象** | **节点**（图片节点 / 视频节点 / 文本 / 音频 / 脚本 / 智能剪辑 / 导演台 / 逐帧拉片）。项目 = 一块画布 = 一堆节点 |
| **Primary Action** | 在画布上 **＋ 添加节点** 或对着 Agent 说话 |
| **Secondary** | 连线、分组、上传、从生成历史选择 |
| **导航模型** | **没有固定 IA。** 左栏是「画布元素树」，分组是**用户自己建的文件夹**（`#分镜`、`#风格测试`），149 个节点 |
| **状态表达** | 节点上直接标 `AI生成` 徽章 + `2752 × 1536` 尺寸；连线可显示/隐藏 |
| **进出模型** | 项目卡 → 新标签页打开 `/canvas?spaceId=…&projectId=…`，**URL 可分享可书签** |
| **为什么有效** | 创作者的心智单位是「这一张图 / 这一条视频」，而画布让「从这张再生成那张」是**一次拖拽**，不是一次跨页导航 |

### T-004 右栏 Agent = 唯一的智能入口

- 一个**常驻会话**（「新对话」+ 历史），不是每页一个不同的助手面板。
- **Skill 以 `/slash` 命令进入会话**：「Skill 就位」卡片列出 `/pixar-ani…`、
  `/viral-vid…`、`/neo-chin…`，可「换一批」。
- 输入框提示 **「开始你的创作，或者 `@` 引用工作流/节点/资源」** ——
  **对象通过 `@` 进入对话上下文**，而不是靠「你现在在哪一页」推断。
- 顶栏有一个 `CLI & Skill` 按钮 —— 承认命令行式操作是一等公民。

### T-006 `/skill` = Skill 是可浏览、可收藏、可拥有的产品资产

- 一级导航项（首页 / 项目 / **Skills** / 创作者挑战赛）。
- 分类 tab：推荐 / 专业影视 / 商业广告 / 短剧漫剧 / 动漫游戏 / 音乐MV / 自媒体创作 / 通用技能 / 发现。
- 每张卡：封面、名称、一句话说明、**作者**、**使用人数**、媒体类型徽章。
- 子 tab：Skill / **收藏** / **我的**。
- 顶部一个大输入框：「请输入你的创作灵感，或从下方挑选一个 Skill 开始」。

### T-001 项目列表

- 全局细 rail（首页/项目/Skills/挑战赛）+ 「＋新建项目」主按钮。
- 项目卡：**封面缩略图** + 名称 + 日期 + `⋯` 菜单；支持**文件夹**。
- 顶栏：积分余额 `⚡34`、会员、Blender 插件。

### §21 — 哪些不能照抄

| LibTV 的做法 | 对我们是否适用 | 理由 |
| --- | --- | --- |
| 无固定 IA、纯用户自建分组 | ❌ **不适用** | 我们是**短剧连续剧**：48 集 × N 场 × M 镜是**客观结构**，不是用户的收纳偏好。ADR-0066 的固定 IA 是对的 |
| 项目 = 一块画布 | ❌ 不适用 | 一个 48 集项目塞进一块画布 = 149 节点 × 40 倍 |
| 积分 / 会员 / 营销条 / 挑战赛 | ❌ 不抄 | 我们不是 SaaS 平台 |
| **Skill 作为一级页面 + 可浏览目录** | ✅ **强烈适用** | 我们有 21 个真 Skill，目前**没有页面** |
| **Agent 常驻会话 + `/skill` + `@对象`** | ✅ **强烈适用** | 我们的「AI 导演」是**每页一个不同面板**，上下文靠页面猜 |
| **URL 即状态（`?projectId=`），可分享可书签** | ✅ **强烈适用** | 我们**完全没有路由** |
| **节点上直接标 `AI生成` + 尺寸** | ✅ 适用 | 我们的资产卡不说自己是怎么来的 |
| **项目卡有封面** | ✅ 适用 | 我们是灰色文件夹图标 |
| 无限画布作为**局部**工具（一个镜头的参考网络） | 🟡 部分适用 | 我们已有 `制作流程图` 和 `?canvas=1`，不必再造 |

---

## 第 1 部分 — Gap 清单

每条格式：**GAP-nn · 标题 · [Gap 类型] · [优先级] · [系统支撑] · [改动分类]**

---

### GAP-01 · 冻结 IA 的五页没有任何入口，其中一页完全不可达
`Information Architecture Gap` · **P0** · ⚪ 纯前端 · **ADD（补入口）**

> **✅ 已闭合（TASK-077 §1.5，2026-08-16）** —— 剧集制作补了 `EPISODE_NAV` 五页左栏 rail
> （`shell.renderEpisodeRail`），⑨ 粗剪审片从「全仓库搜不到入口」变成 rail 第四项。
> 证据：C-021…C-025，`capture.json` 里五页全部 `reached_via: data-mod`。
> 「工作区 ▾」旧菜单保留（TASK-074 才退休），两者都经 `resolveModule`，不会打架。
> **未闭合的另一半**：⚙ 项目设置的三个分区仍没有 rail 行；URL 路由是 GAP-07（Phase 2）。

**Current** C-009…C-017 —— 剧集制作空间**没有左栏**。唯一导航是中栏一个
`工作区 ▾` 下拉，里面是 **11 个 LEGACY 阶段键**（制作台/生成溯源/本集总览/场景/
分镜/参考统筹/画面/视频/音频/审片/剪辑）。

**Target** T-005 —— LibTV 左栏常驻「画布元素」树，一眼看到全部内容。

**Gap** ADR-0066 决策 10 冻结的「三空间 / 十一页封闭集合」在**代码里存在、在界面上不存在**：

- `EPISODE_NAV`（board / storyboard / shotwork / cutreview / delivery）在
  `shell.js` 导出，**除 shell.js 自身与测试外零消费者** —— 没有渲染器画它。
- 全仓库搜不到 `data-mod="board|storyboard|shotwork|cutreview|delivery|projectsettings"`，
  也搜不到 `setModule("<五页任一>")`。
- 这五页只能靠**历史键别名**间接落到：`episode→board`、`shots→storyboard`、
  `video→shotwork`、`edit→delivery`、`storage→projectsettings`。
- **`cutreview`（⑨ 粗剪审片）连别名都没有** —— `production.js:807` 有渲染器、
  `:1562` 有绑定，`activeModule === "cutreview"` **永远不成立**。它是死代码。

**Why it matters** 现在有**两套并存的导航词汇**（11 个旧阶段 vs 5 个新页），
用户看到的是旧的，测试断言的是新的，文档冻结的也是新的。
`shell.js:104-119` 的注释**自己承认**这是「§1.1 落点表里的真实缺口」并留给
TASK-073 §5.11 —— 那条 follow-up 至今未做。

**Existing support** 五个渲染器全都在，`resolveModule` / `PAGE_SECTIONS` /
`SECTION_LABEL` 全都在。**只缺一个画 `EPISODE_NAV` 的 rail。**

**Required change** 在剧集制作空间渲染 `EPISODE_NAV` 五页 rail（复用
`renderRail`）；`cutreview` 给出真实入口或按 ADR-0063 决策 1 删除并记录。

**Backend impact** 无。

---

### GAP-02 · 存储页说「媒体不可用 0」，实际有 2 个文件已经丢了
`State Model Gap` · **P0** · ⚪ 纯前端（校验）/ 🟡 或加一个后端探针 · **MODIFY**

> **✅ 已闭合（TASK-077 §1.2，2026-08-16）** —— 新增 `services/mediaprobe.js`：对注册表
> 声明的 URL 发 `HEAD`，`<img>` 的 `onerror` 汇入同一张表。存储页「媒体不可用」= **2**，
> 资产库那两张卡变成「媒体文件已不在磁盘上 + 文件名」。证据：C-018 / C-019。
> **只显示，不改写 `storageState`** —— 把声明与磁盘对齐是持久化改动，见 Follow-up。

**Current** C-019 顶部统计：`资产总数 9 · 活跃 9 · 未使用 0 · 已归档 0 · **媒体不可用 0**`。
C-018 资产库里**头两张卡是浏览器默认碎图**（`naturalWidth=0`），alt 文字裸露。

**证据** `media/` 目录只有 7 个文件；注册表引用 9 个。缺失的是
`assets-ref-c6e26bfb-…_v1.png` 和 `assets-ref-5d4cf6e2-…_v1.png`。

**Gap** `storageState` 是**声明式**的：只有 App 自己执行「移除本地副本」时才置为
`deleted`。用户在文件管理器里删掉、同步工具没同步、盘挂了 —— 系统一律不知道，
并且**主动报告 0**。同时 `shell.mediaBox()` 明明有诚实占位分支
（`media-none` + 「还没有画面」），但资产卡走的是别的路径，直接 `<img src>` 裸奔。

**Why it matters** 这正是 AGENTS.md 第 20 条「真实 Connected Project 是主要验收环境」
要防的那类缺陷 —— demo seed 的 SVG 占位图永远不会缺失，所以这个 bug 在 demo 下不可见。
用户看到碎图会以为是**自己的素材坏了**，而系统在旁边说「不可用 0」。

**Existing support** `storageState` 生命周期、`mediaBox` 占位、`/api/uploads` 的 404。

**Required change**
1. 图片 `onerror` → 落到 `media-none` 诚实占位（「媒体文件已不在磁盘上」+ 文件名）；
2. 存储页的「媒体不可用」改成**实测值**（一次 HEAD/存在性校验，或后端加
   `GET /api/projects/<p>/media-audit`）。

**Backend impact** 方案 1 纯前端；方案 2 需要一个小的只读路由。

---

### GAP-03 · 后端说「不可用」，界面说「¥0」
`State Model Gap` · **P0** · ⚪ 纯前端 · **MODIFY**

> **✅ 已闭合（TASK-077 §1.1，2026-08-16）** —— `mapStanding` 不再把 `unavailable` 压成 0；
> 每个金额字段带 `{value, available, provenance, note}`，顶栏渲染 `已花 — · 余额 — ⚠1`，
> 点开「真实项目数据」能看到 `config/wfm1.json` 不存在那条 `problems[]`（后端一直在返回，
> 前端从没显示过）。证据：C-002 顶栏。demo 模式那条路径未受影响（那些数字是真的）。

**Current** 每一页顶栏都写 `已花 ¥0 JPY · 余额 ¥0 JPY`（C-002…C-019）。

**证据（实测 `GET /api/projects/照见未明rev2/budget`）**
```json
"budgets_jpy":                     {"value": "no config",      "provenance": "unavailable"},
"episode_committed_jpy":           {"value": "no config/data", "provenance": "unavailable"},
"episode_outstanding_holds_jpy":   {"value": "no config/data", "provenance": "unavailable"}
"problems": [{"category":"source_corrupt",
              "detail":"config: project config does not exist: …\\config\\wfm1.json"}]
```
`services/realmap.js:7` — `const num = (v) => (typeof v === "number" ? v : 0);`
文件头注释甚至**明说**：「some derived fields carry a human string instead of a
number when unavailable — **coerced to 0 here**」。

**Gap** ADR-0031 的整个 `{value, provenance}` 机制就是为了让「我们没测」和
「测出来是 0」不能混为一谈。前端在最后一米把这个区分**抹平**了。

**Why it matters** 这是审计里唯一一条**用户会据此做错决定**的缺陷：
「余额 ¥0」在付费模式下读起来是「我没钱了」；真相是「这个项目根本没有预算配置」。
项目里到处写着「绝不臆造」「如实标注」，而最显眼的常驻数字正是臆造出来的。

**Required change** `mapStanding` 保留 `provenance`；UI 在 `unavailable` 时渲染
`—` / 「未配置预算」，并把 `problems[]` 挂上去（一个可点的 ⚠）。

**Backend impact** 无 —— 后端已经给对了。

---

### GAP-04 · 21 个 Skill 是真产品资产，但没有页面
`Capability Exposure Gap` · **P1** · 🔵 后端已有 / UI 缺 · **ADD**

**Current** `GET /api/skills` 实测返回 **21 个 Skill**（+1 个 deprecated），每个都带
`role / purpose / inputs / optionalInputs / reviewCriteria / outputSchema /
recommendedRuntime / skillDigest / source`。界面上它只是右栏 AI 导演里一个
折叠行：**「能力  21 个能力」**（C-002/C-007）。没有列表页、没有搜索、没有分类、
没有「这个 Skill 需要什么输入」、没有「上次跑出什么」。

**Target** T-006 —— Skills 是**一级导航**，有封面、分类、作者、使用数、收藏、我的。
T-004 —— 在 Agent 会话里以 `/skill-name` 直接调用。

**Gap** ADR-0067 明确把 Skill 定义为「**产品资产而不是源码常量**」，三件套 +
三级来源 + `skillDigest` 版本指向。产品资产**必须有一个能被浏览的地方**。
现在创作者无法回答「系统一共能帮我做哪些事」。

**注意约束** ADR-0066 决策 10：「新增 Skill 不得新增一级或二级页面」——
这条约束的是**每个 Skill**不得各占一页，不是「Skill 目录不能有页」。
一个 Skill 目录页是**一页承载全部 21 个**，恰好是该约束想要的形状。
（若严格解读仍冲突，则落在 ⚙ 项目设置 下作为分区，或作为 AI 导演的展开态。）

**Existing support** 目录、加载、digest、fail-closed、运行、取消、Run 记录全都有。

**Required change** 一个 Skill 目录界面：分类/搜索、卡片（role + purpose +
需要哪些输入 + 是否 shot-scoped）、可用性与失败原因（`problems[]` 已经在
payload 里）、「在当前上下文运行」。

**Backend impact** 无（`/api/skills` 已返回全部所需字段）。

---

### GAP-05 · 创作闭环的后半段（评价 / 反馈 / 行动 / 复盘）在另一个界面里，而那个界面看不见项目
`Capability Exposure Gap` + `Domain Model Gap` · **P1** · 🔵 后端已有 · **MOVE + EXPOSE**

**Current** C-020 —— `workspace_shell` 对真实项目 **Portfolio 全空**。
原因实测：`discover_projects` 要求 `config/wfm1.json`，而 Studio 建的项目
`project.json` 只有 4 个字段，没有那个文件。

同时：`record-evaluation` / `create-feedback` / `create-action` /
`action-transition` 四个 Gateway 命令**只注册在 `workspace_shell`**，
Studio 的 `_command_gateway` 只注册 `lock-draft-plan` + `submit-video-generation`。

**Gap** 「做完片子之后」的一整段（评价、反馈、行动项、跨项目学习）
后端完整实现（`evaluation` / `action` / `learning` 三个包 + 10 个 CLI 命令 +
5 个查询），**创作者一个都碰不到**。审片页（C-016）的「✓ 通过 / 跳过」按下之后
没有任何东西被记录到那套闭环里。

**Required change**
1. 把四个 LOW-risk 创意事实命令注册进 Studio 的 Gateway；
2. 审片页的通过/驳回接 `record-evaluation`，AI 导演的「问题」接 `create-feedback`；
3. 决定 `workspace_shell` 的去留 —— 要么让它能发现 Studio 项目，要么明确它只服务
   WFM1 核心项目并在文档里说清。

**Backend impact** Requires small contract change（注册表接线，不是新能力）。

---

### GAP-06 · 同屏三个「集数」，没有一个说明自己是什么
`Information Architecture Gap` · **P1** · ⚪ 纯前端 · **MODIFY**

> **✅ 已闭合（TASK-077 §1.6，2026-08-16）** —— 页头 `已建立 48 集 · 本版规划 12 集（差 36 集：
> 规划条目只覆盖本版规划的剧集，其余是更早建立的）`；版本卡 `本版规划 12 集 · 项目已建立 48 集`；
> AI 导演 `已建立的 48 集里，47 集还没有记录 Arc 推进`。三个数字现在各自说明自己数的是什么。
> 证据：C-005。

**Current** C-005 一屏之内：
左栏徽标 `分集规划 48` / 页头 `48 集 · Production 的出口 · 规划 v4 已确认` /
版本卡 `剧集规划 • v4（已确认）… **12 集**` / 右上角 `共 48 集` /
AI 导演 `**47 集**还没有记录 Arc 推进`。

**Gap** 48 = 已建立的剧集实体数，12 = 规划 v4 里的条目数，47 = 缺 Arc 的集数。
三个数指的是三件事，界面把它们并排放着，用同一个词「集」。

**Why it matters** 用户会问「我到底规划了几集」，而界面无法回答。
这也是 D-6（创作域与核心域不同步）在 UI 上的第一次显形。

**Required change** 每个数字带上它的口径（「已建立 48 集 / 本版规划 12 集」），
并在两者不等时显式说明差异来源。

---

### GAP-07 · 没有 URL 路由：不能分享、不能书签、不能后退、刷新回原点
`Interaction Gap` · **P1** · ⚪ 纯前端 · **ADD**

**Current** 全仓库 `grep pushState|replaceState|popstate` → **零命中**。
唯一的 URL 参数是 `?canvas=1`（诊断视图）。导航全是内存中的 `activeModule`。

**Target** T-003 —— `liblib.tv/canvas?spaceId=5533555&projectId=e19494ec…`。
项目在**新标签页**打开，URL 是状态，可分享、可书签、可后退。

**Gap** 创作者刷新一次就回到落地页；无法把「EP07 的 SH12」发给别人；
浏览器后退键会直接离开应用。`resolveModule()` 的整套设计（历史键 → 页面+分区）
本来就是**为深链接准备的**，注释里写着「a dead deep link is a worse answer than a
landing page」—— 但目前**根本没有 deep link 可死**。

**Required change** `#/<project>/<space>/<module>/<section>?ep=&shot=`，
用现成的 `resolveModule` 解析，`popstate` 驱动 `setModule`。

**Backend impact** 无。

---

### GAP-08 · AI 导演每页一个样，上下文靠「你在哪一页」猜
`Interaction Gap` + `Domain Model Gap` · **P2** · 🟡 需小改 · **COMBINE**

**Current** 右栏在不同页面是不同的东西：
C-002 有 导演建议 / 指令 / 能力 / 作品 CANON / 上游变化；
C-006（本集剧本）**只剩**「修改要求 + AI 修订」，能力与 CANON 全部消失；
C-007 变成「这一镜现在怎么办 + 缺少清单 + 下一步」。
另外中栏顶部还有一个**独立**的 `🤖 询问 Agent` 条。

**Target** T-004 —— **一个**常驻会话，Skill 用 `/name` 调，对象用 `@` 引用。
上下文由用户显式给出，不由页面隐式决定。

**Gap** 我们有 21 个 Skill、有 `inputs` / `shotScopedInputs` 契约、有 Run 记录，
却没有一个地方能让用户说「用 `/continuity-reviewer` 检查 `@SH01` 和 `@SH02`」。
用户必须**先导航到正确的页面**才能得到正确的能力 —— 这是把系统的内部
路由规则变成了用户的负担。

**Required change** 统一右栏为一个会话面板：`/skill` 选择器（从 `/api/skills`）+
`@` 对象引用（镜头/角色/场景/资产，都已有稳定 id）+ 当前上下文可见可编辑 +
Run 历史。页面仍可预填上下文，但不再是唯一来源。

**Backend impact** Uses Existing Backend（`/api/skills` + `/api/skill/run` +
`/api/runs` 已齐备）。

---

### GAP-09 · 中栏标题与面包屑在说谎
`Visual / Interaction Gap` · **P2** · ⚪ 纯前端 · **MODIFY**

> **✅ 已闭合（TASK-077 §1.6，2026-08-16）** —— 中栏标题跟随 `activeModule`（只有制作台保留
> 「…制作流程图」）；面包屑按新的 `shell.crumbScope(module, section)` 只画当前页真实作用域内
> 的段，所以本集看板 / 粗剪审片 / 后期交付不再挂一个 `Shot 01`。
> 证据：C-021 / C-024 / C-025 / C-014 / C-017。

**Current**
- C-014（视频工作区）和 C-017（后期交付）的中栏标题仍是
  `S1-01 实验室全景 / 建立镜头 制作流程图` —— 那不是当前中栏的内容。
- C-009（本集看板）的面包屑是 `照见未明rev2 › EP01 › **Shot 01** › 本集看板`
  —— 看板是集级页面，不是镜头级。
- C-014 / C-016 / C-017 的**左栏**仍是 S1-01 的镜头检视器，不跟随中栏。

**Required change** 中栏 header 随 `activeModule` 走；面包屑只画当前页面**真实作用域**
内的段（`renderCrumb` 本来就支持省略段）。

---

### GAP-10 · 资产库两套导航并存
`Information Architecture Gap` · **P2** · ⚪ 纯前端 · **REMOVE**

**Current** C-018 —— 左 rail 七行（全部资产 / References / Images / Videos /
Audio / Final / Collections / 存储管理）**和**页内七个筛选 chip（全部 / 参考 /
镜头图片 / 镜头视频 / 音频 / 成片 / 已保存筛选）同时存在，是同一个词汇的两个入口。

**Target** T-005 —— 左栏是**内容树**（用户自建分组），筛选是**页内**的事，两者不重复。

**Gap** TASK-073 §1.1 已经决定 `ASSET_NAV` 删除、七行变成 `ASSET_FILTER_ALIAS`
预设筛选值。别名做了，rail 没删（`shell.js:145-161` 注释说留给 TASK-074）。

**Required change** 删 rail，保留 chips；rail 位置改放**内容树**（按角色/场景/剧集
分组的资产），这才是 LibTV 那一栏真正提供的价值。

---

### GAP-11 · 项目卡没有封面、没有进度、没有「上次做到哪」
`Visual + Information Architecture Gap` · **P3** · 🟡 小改 · **MODIFY**

**Current** C-001 —— 灰色文件夹图标 + 项目名 + 「真实项目」徽标 + 「未记录资产位置」。

**Target** T-001 —— 封面缩略图 + 名称 + 日期 + `⋯` 菜单 + 文件夹分组。

**Gap** 我们**有**做封面的材料（资产库里有图、有 `finals`、有 `project.json`
的 `created_at`），也**有**做进度的材料（`project_status` 的 `progress`、
canvas 里的 `60 镜 / 0 已生成`）。只是没渲染。

**Required change** 卡片 = 首个可用参考图或成片首帧 + 「48 集 · 60 镜 · 0 已生成」+
「上次编辑 <日期>」+ 点击直达上次所在页（配合 GAP-07 的路由）。

---

### GAP-12 · 后端算好的项目健康度没有位置放
`Capability Exposure Gap` · **P3** · 🔵 后端已有 · **EXPOSE**

**Current** `plan`（54 步 L0–S7 计划）、`problems`（真实项目实测有 1 条
`source_corrupt`）、`approvals` 三个查询**服务端路由都在**，前端一次不调。

**Gap** 创作者无法回答「这个项目整体在哪一步」「有什么数据问题」。
现在的进度只有各页各自的局部计数（`0/60`、`60 镜`），没有全局。

**Required change** ⚙ 项目设置 增加「项目健康」分区：阶段推进（`status.scope`）+
计划总览（`plan`）+ 问题清单（`problems`）+ 审批审计（`approvals`）。

**Backend impact** 无。

---

### GAP-13 · 场景层建了但没人用
`Domain Model Gap` · **P3** · 观察项 · **（先不动）**

**Current** C-010 —— 48 集，**每一集都是「0 个场景 · 0 个镜头归属」**；
60 个镜头全在「未分配到场景」。C-012 参考统筹 0 绑定。

**Gap** 领域模型有 Episode → Scene → Shot 三层，真实使用只有两层。
可能是 UI 摩擦（归组要一个个点），也可能是这一层对短剧本来就不必要。

**Required change** **先不改**。这是需要用户判断的产品问题，不是缺陷。
建议做法：让 AI 剧本拆解**顺带产出场景归属提案**，看用户会不会用；
若两轮之后仍然 0，就说明该层应该是**派生**的而不是手工维护的。

---

### GAP-14 · CJK 项目名会让后端启动崩溃
`Interaction Gap` · **P2** · 🟡 后端小改 · **MODIFY**

**Current** 实测：`python server.py --account-root <含中文项目的目录>` 在
cp932 控制台上 `UnicodeEncodeError: 'cp932' codec can't encode character '沉'`
—— 崩在启动横幅 `print(f"  projects: {…}")`。必须 `PYTHONIOENCODING=utf-8` 才能起。

**Why it matters** 这是**中文用户的必经路径**（项目名就是剧名）。
`run-windows.ps1` 是主入口，没有设这个环境变量。

**Required change** 启动横幅用 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`
或对项目名做 `errors="replace"`；`run-windows.ps1` 设 `$env:PYTHONIOENCODING="utf-8"`。

---

## 第 2 部分 — UI Problems TOP 10（按用户价值，不按像素差距）

排序依据是 §26：**用户完不成任务 > 用户误解状态 > 已有能力被藏 > 流程低效 > 信息架构 > 视觉**。

> GAP-15…GAP-21 由第二、三轮走查产出（逐 tab 点进去 + 走完一条**跑完了的**工作流），
> 写在 [target-workflow-walkthrough.md](target-workflow-walkthrough.md) §2.5 / §4。

| # | 问题 | Gap | 优先级 | 分类 | 后端影响 |
| --- | --- | --- | --- | --- | --- |
| 1 | 顶栏把「预算不可用」渲染成「¥0」 | GAP-03 | **P0** | MODIFY | 无 |
| 2 | 存储页报「媒体不可用 0」，实际丢了 2 个文件；资产库显示浏览器碎图 | GAP-02 | **P0** | MODIFY | 无（或加只读探针） |
| 3 | 冻结 IA 的五页没有入口，⑨ 粗剪审片完全不可达 | GAP-01 | **P0** | ADD | 无 |
| 3b | **「确认镜头→准备资产→合成提示词→批量生视频」整条流水线有实现、无入口** —— 只挂在已下线的节点画布上 | GAP-26 | **P0** | EXPOSE | 无 |
| 3c | **分镜是卡片不是表**（60 镜的景别/运镜/情绪全「未记录」）；**画面描述里的实体没链接 → 资产缺口算不出来** | GAP-24 / GAP-25 | **P1** | MODIFY / ADD | 无 / 小改 |
| 4 | **一次生成被拆在四个地方，价格藏在最后** —— 真实项目 0/60 卡在这里 | GAP-15 | **P1** | COMBINE | 无 |
| 5 | **没有「整集拍平成一张可审阅清单」的视图** —— 审片是 60 个页码逐个翻 | GAP-22 | **P1** | ADD | 无 |
| 5b | **没有通用的「从这个生成下一个」** —— 只有「用作视频首帧」一条特例 | GAP-19 | **P1** | ADD | 无 |
| 6 | 21 个 Skill 没有页面，用户不知道系统能做什么 | GAP-04 | **P1** | ADD | 无 |
| 7 | 评价/反馈/行动闭环在另一个看不见项目的界面里 | GAP-05 | **P1** | MOVE+EXPOSE | 小改（注册表） |
| 8 | 没有 URL 路由：刷新回原点、不能分享、不能后退 | GAP-07 | **P1** | ADD | 无 |
| 9 | 分集规划同屏三个矛盾的「集数」 | GAP-06 | **P1** | MODIFY | 无 |
| 10 | 运镜/风格/特效自由文本 60 镜全空；模型对用户完全不可见；AI 导演每页一个样 | GAP-16 / GAP-20 / GAP-08 | **P2** | ADD / EXPOSE / COMBINE | 部分需 ADR |

---

## 第 3 部分 — Frontend-only Opportunities

**不用动后端就能明显变好**（按投入产出排序）：

1. **GAP-03** 预算诚实化 —— 改 `realmap.js` + 顶栏渲染，约 30 行。
2. **GAP-01** 补五页 rail —— `renderRail` 已存在，`EPISODE_NAV` 已存在，接线即可。
3. **GAP-02(1)** 图片 `onerror` → 诚实占位 —— `mediaBox` 的分支已存在。
4. **GAP-09** header/面包屑跟随 —— 纯展示。
5. **GAP-06** 数字加口径 —— 纯文案。
6. **GAP-12** 项目健康分区 —— 三个查询的 HTTP 路由已经在跑。
7. **GAP-04** Skill 目录页 —— `/api/skills` 已返回全部字段。
8. **GAP-07** hash 路由 —— `resolveModule` 已经是为它写的。
9. **GAP-11** 项目卡封面/进度 —— 数据都在 canvas + `project_status` 里。
10. **GAP-10** 删资产库 rail —— TASK-073 已决定。

## 第 4 部分 — Backend-blocked UI Changes

| 想做的事 | 为什么改 UI 不够 |
| --- | --- |
| 记录评价 / 反馈 / 行动 | Studio 的 Gateway 注册表里没有这四个命令（GAP-05） |
| 「媒体不可用」显示实测值 | 需要一个只读的存在性探针路由（GAP-02 方案 2） |
| 跨项目复盘 / 学习建议 | `cross_project_*` / `recommendations` 没有 HTTP 路由 |
| 血缘 / Prompt 版本史 / 镜头尝试史 进 Studio | 这四个 param 查询只在 `workspace_shell` 的路由表里 |
| 真实付费生成 | 需 `--enable-paid` + env + API key —— **这是唯一必须问用户的事**（CLAUDE.md：花钱） |
| 让 `workspace_shell` 看见 Studio 项目 | `discover_projects` 要 `config/wfm1.json`，Studio 不写；属于领域模型决策 |

---

## 第 5 部分 — Recommended UI Correction Order

按 §35 分阶段。**每个 Checkpoint 都是可见、可截图、可比较、可回滚的垂直切片。**

### Phase 0 — 修「界面在说谎」+ 接回两个死掉的面（P0，全部纯前端）
- CP0.1 预算 `unavailable` → `—` + 问题提示（GAP-03）
- CP0.2 媒体缺失 → 诚实占位 + 存储页实测计数（GAP-02）
- CP0.3 中栏 header / 面包屑跟随当前页（GAP-09）
- CP0.4 分集规划数字加口径（GAP-06）
- **CP0.5 把三步流水线接回主路径**（GAP-26）—— `wizard.js` 已经写好了，
  只是唯一入口挂在已下线的节点画布上。**这是全部改动里投入产出最高的一条：
  代码已存在，接一根线。**

### Phase 1 — 打通「做出第一张画面」+ 露出已有能力（P0/P1）
- **CP1.0 一次生成 = 一张卡**（GAP-15 + GAP-20）—— 参考 chip 内联进 Prompt +
  **可选模型** + 规格 + **报价** + 提交同屏。**这一条的用户价值最高**：真实项目
  0/60 就卡在这里
- **CP1.0b 「以此生成 →」通用菜单**（GAP-19）—— 任意媒体卡 → 下游类型，
  落到对应工作区并预填该项为输入
- **CP1.1 剧集制作五页 rail + ⑨ 粗剪审片做成「故事板」形态**（GAP-01 + GAP-22）——
  **一条改动同时解决死页面和缺失的审阅视图**：一集的镜头 × 图片/视频/音频三列，
  每条带模型 / 时长 / 尺寸 / 首帧来源 / 状态，可按 成片/片段 筛
- **CP1.1b ⑦ 分镜设计增加表格视图 + 实体链接**（GAP-24 + GAP-25）——
  十列一屏横向可比（补 `lighting` 字段，把 `sfx` 与编译出的 Prompt 拉进同一张表）；
  画面描述里的角色/场景地做实体识别并链接，表头给真实的「准备资产 N/M」。
  **`breakdown.js` 已经认得出这些实体，`promptc.js` 已经算得出缺什么** —— 只是没连到表上
- CP1.2 Skill 目录界面（GAP-04）
- CP1.3 ⚙ 项目健康分区：plan / status / problems / approvals（GAP-12）
- CP1.4 hash 路由 + 深链接（GAP-07）

### Phase 2 — 核心工作流重构（P1/P2）
- CP2.1 右栏统一为一个 Agent 会话：`/skill` + `@对象`（GAP-08）
- CP2.2 资产库删 rail、改内容树（GAP-10）
- CP2.3 评价/反馈/行动接进 Studio Gateway（GAP-05，需小契约改动）

### Phase 3 — 缺失的产品能力（需前后端 + ADR）
- CP3.1 运镜 / 风格 / 特效 预设库（GAP-16）
- CP3.2 「从一张图创建角色」+（可选）角色原型库（GAP-17）
- CP3.3 媒体存在性探针路由（GAP-02 方案 2）
- CP3.4 血缘 / Prompt 史 / 镜头尝试史 接进 Studio
- CP3.5 逐帧拉片 / 3D 导演台（GAP-18，暂不做）

### Phase 4 — 视觉统一
- CP4.1 项目卡封面 + 进度（GAP-11）
- CP4.2 空态、密度、层级统一

---

## 第 6 部分 — 一个必须说清楚的判断

用户问的是「把 UI 改成 LibTV 那样」。审计后的诚实回答是：

> **LibTV 的形状不适合我们的产品，但 LibTV 的三个机制非常适合。**

- **不适合**：LibTV 是「一块画布做一条片子」，没有固定 IA。我们是
  **48 集连续剧**，Episode → Scene → Shot 是客观结构。照抄画布会让 149 个节点变成
  6000 个，并且把 ADR-0066 冻结的 IA 推翻 —— 而那份 IA 的方向是对的，
  **它的问题是没有被实现**（GAP-01），不是它错了。
- **强烈适合**：① Skill 是可浏览的一级资产（T-006）；
  ② Agent 是一个常驻会话，用 `/skill` 和 `@对象` 显式给上下文（T-004）；
  ③ URL 即状态（T-003）。这三条我们**后端全都支撑得起**，只是界面没做。

所以最有用户价值的下一步不是「重做界面」，而是
**Phase 0 + Phase 1：先别说谎，再把已经做好的东西露出来。**
