# TASK-073：第三阶段 —— 前端信息架构、页面重构与上下文 Agent 交互

- 状态：**已规划，未开始**（前置 TASK-072 未完成）
- 实施基线：**`ae0a54a`** + TASK-072 的交付
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[ADR-0066](../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)、
  [创作者产品信息架构](../design/creator-product-information-architecture.md)
- 前置：[TASK-072](TASK-072-system-contract-and-persistent-runs.md) 全部验收通过
- 后续：[TASK-074](TASK-074-delivery-migration-and-legacy-retirement.md)

## 0. 本轮边界

**只做前端 IA 与交互。不改后端合同（TASK-072 已定），不删旧页面与旧接口（TASK-074）。**

一条贯穿全卡的规则：**组件复用优先于重写。** 现有 `src/ui/*.js` 的能力全部保留，
本轮改的是它们**挂在哪个页面的哪个分区**。删的是**入口**，不是能力。

## 1. 交付

### 1.1 导航收敛为固定三空间 / 十一页（IA §1 / §2）

| 常量 | 从 | 到 |
| --- | --- | --- |
| `NAV[0].items` | `brief` `story` `characters` `world` `episodes` `script` | `brief`(项目与创意) `story` `settings`(作品设定) `episodes` `script` |
| `EPISODE_NAV` | 11 项 | `board` `storyboard` `shotwork` `cutreview` `delivery` |
| `EPISODE_DEFAULT` | `workbench` | `board`（本集看板） |
| `ASSET_NAV` | 8 项 | **删除**——资产库是单页 + 筛选 |
| `MODULE_LABEL` | 现有 | 新页面 + **全部旧 key 保留为别名** |

**旧 key 的落点表**（每一条都必须落到实处，落空即回归）：

| 旧 key | 新落点 |
| --- | --- |
| `characters` / `relationships` / `world` / `settings` | ③ 作品设定的对应分区（`settings` 是本页**正式 key**）|
| `workbench` | **⑧ 镜头制作**（生产图降为该页结果旁的「生成记录」）|
| `provenance` | **⚙ 项目设置 · 存储与诊断**（整集溯源图是诊断工具，不是生产页面）|
| `episode` | ⑥ 本集看板 |
| `scenes` / `shots` | ⑦ 分镜设计 |
| `refplan` | ⑧ 镜头制作 · 步骤①（并打开资产抽屉） |
| `frames` | ⑧ 步骤② |
| `video` | ⑧ 步骤③ |
| `dailies` | ⑧ 步骤④（单镜）/ ⑨ 粗剪审片（整集），按来源上下文决定 |
| `audio` | ⑩ 后期交付 · 配音分区 |
| `edit` | ⑩ 后期交付 · 时间线分区 |
| `assets:*` | ⑪ 资产库 + 预置筛选值 |
| `storage` | ⚙ 项目设置 · 存储与诊断 |

2026-08-13 校正：`workbench` / `provenance` 原本都落 ⑥ 本集看板，而看板里**没有**
它们对应的分区——一个落到「没有该内容的页面」的旧链接，和落空是同一件事
（ADR-0063 决策 1）。改按**它们实际做的事**分派：制作台做一个镜头的生产 → ⑧；
整集溯源图是诊断 → ⚙。

**⚙ 项目设置用独立 route key `projectsettings`**，**不得复用 `settings`**：
`settings` 已经是 ③ 作品设定的正式 key，两者共用会让深链接与旧书签落到错误的页面。

守卫测试：对**每一个**旧 key 断言 `resolveModule(key)` 返回一个真实页面 + 分区，
且该分区在渲染后可见；并断言 `settings` 与 `projectsettings` 解析到**不同**页面。

### 1.2 剧集制作五页（IA §4 ⑥–⑩）

| 页面 | 主要复用 | 新增 |
| --- | --- | --- |
| ⑥ 本集看板 | `episodews.js` + `director.js` 的状态列 | 七块必显内容 + **每个异常项可跳转** |
| ⑦ 分镜设计 | `storyboard.js` + `episodews.js` 场景列表 | 三栏列表布局；镜头卡七字段 |
| ⑧ 镜头制作 | `prodinspector.js` `shotrefs.js` `refsearch.js` `mediaws.js` `dailies.js` | **四步流程条**；任务状态/耗时/成本/失败/重试/真实取消 |
| ⑨ 粗剪审片 | `dailies.js` 连播 + `timelinews.js` 版本 | 问题标记 + **定位到镜头** + 退回 + Decision |
| ⑩ 后期交付 | `postconsole.js`（full 模式） | 七分区导航 + 质检分区 + 导出记录 |

删除的入口：「工作区 ▾」菜单、制作台的自动/手动布局与全屏、后期控制台 dock、
底部常驻参考素材库、`assets:*` 七个导航项、Collections 独立入口。

### 1.3 镜头制作的四步流程（IA §4 ⑧）

```
① 准备输入 → ② 制作主画面 → ③ 制作视频 → ④ 对比候选并选定
```

- 步骤① 复用 ADR-0063 决策 6（A/B 分区）与决策 7（可勾选生成清单）的**全部语义**：
  A 区标注来源与「已在用 / 可复用 / 没有」；B 区 `!` 计入头部数字、`○` 不计；
  **推荐永远是未勾选的一行**；勾选框读渲染时状态（`data-on`），不读 `checkbox.checked`。
- 步骤③ 保持 `video-prompt-director` 的硬前置：无已选定主帧图 → **能力层拒绝**并说明。
- 步骤④ 是**检查层 1**：并排对比 → `confirmShotVersion(video)` → 层 1 Decision。
  不建立独立审片页面。
- 每个任务行必须显示：状态 · 耗时 · 成本 · 失败原因 · 重试 · **真实取消**
  （调 `cancelRun`，不是清前端状态）。

### 1.4 上下文 Agent 面板（IA §6）

| 项 | 内容 |
| --- | --- |
| 入口 | **只有两类**：页面级「询问 Agent」（每页顶部右侧固定位）、对象级「让 Agent 处理」（卡片/行上） |
| 形态 | **按需打开的面板**，不是常驻侧栏。关闭后不占布局。 |
| 内容 | 固定七项（IA §6.3），不因能力增加而变形 |
| 隐藏 | Skill ID / Skill 版本 / Runtime / Executor / Provider / Model / 内部任务 ID / context snapshot → **全部移入生成记录** |
| 显示 | 普通用户看到 `Skill.taskName`（任务名称） |
| 不可用 | runtime 不可用 / 输入缺失 / 输出不符契约 → `unavailable` + 原因，**不显示成假按钮** |
| 兜底 | 每个 AI 动作保留手工兜底（复制 Prompt → 外部跑 → 粘回 → 同一道契约与确认门） |

保留不动：`shotctx` 投影、`contextTrace`、`ctxcache` 的 stale 显式提示、
检索式候选（AI 只在候选集内挑选）、`applicabilityFor`、`ctx.skills.abandon`、
`suggestExecutor` 的建议式分工。

### 1.5 「生成记录」（IA §5.1 #12 / #31）

- 挂在**每一个结果旁**（候选卡、版本条、粗剪版本、导出记录）。
- 内容：Skill Run / Provider / Model / 输入及输入版本 / 参数 / 成本 /
  开始结束时间 / 失败原因 / **用户确认记录**。
- 整集溯源图与流程画布移入 ⚙ 项目设置 · 存储与诊断的**诊断视图**。
  ADR-0052 的派生规则（决策 1/2/3/5/6/7）与 ADR-0063 决策 5 的边规则
  **在此继续有效**。
- **流程画布不再是执行入口**（ADR-0052 决策 4 被 ADR-0066 取代）：生成的唯一入口是
  ⑧ 镜头制作的四步流程。画布在诊断视图里是**只读**的。
- `ui/wfgraph.js` / `workflow/provenance.js` **保留，不删** —— 它们就是「生成记录」
  与诊断视图的实现。

### 1.6 资产库单页 + 抽屉（IA §4 ⑪）

- 一个页面，筛选维度：对象类 / 媒体类 / 范围 / 状态 / 已保存筛选。
- 「添加参考」抽屉与资产库页是**同一个组件的两种尺寸**——一份实现，两个触发点
  （与 `postconsole` 的 dock/full 是同一条教训）。
- Collections → 「已保存筛选」。

### 1.7 ⚙ 项目设置

route key `projectsettings`（**不是** `settings`）。
项目信息 / 成片规格 / 预算与限制 / 存储与诊断（含 `storagews` 的全部能力、
运行时探测、schema 版本、诊断视图）。**不出现在三空间导航里。**

- **成片规格与预算的唯一编辑入口就是这里**（IA §4 ①/⚙）。① 项目与创意只读展示 +
  「去设置 →」。两个页面都能改同一组字段，是 §5.2「一件事只有一个入口」的直接反例。
- **字段按 IA §4 ⚙ 的冻结清单补齐**：平台 · 画幅 · 分辨率 · 帧率 · 单集时长 ·
  目标集数 · 字幕方式 · 字幕语言 · 容器 · 视频码率 · 音频码率 ·
  项目总预算 · **单次生成上限** · **重试上限**。
- 单次生成上限与重试上限是**硬闸**：超过即拒绝并说明，不是弹窗问一句「确定吗」。
- 这份清单同时是检查层 3「规格」项（TASK-074 §1.2）的输入来源：
  取不到某一项 → 该项 `unavailable`，**绝不判定为通过**。

### 1.8 `app.js` 拆分（约束）

`app.js` 在基线上已经 6000+ 行，本轮还要接入五个新页面与上下文 Agent 面板。
不设约束的话，它会成为这次重构里唯一没有被重构的文件。

| 规则 | 内容 |
| --- | --- |
| 方向 | 按**领域控制器**切分（`ctx.skills` / `ctx.shots` / `ctx.frames` / `ctx.prompt` …），一个控制器一个模块；不按「工具函数 / 常量」这种与领域无关的维度切 |
| 结果 | `app.js` 只保留**装配**：创建状态、组装 `ctx`、挂载渲染。业务规则不留在里面 |
| 纪律 | 拆分是**纯搬运**：一次提交只移动代码不改行为，行为变更另起提交。混在一起没人能审 |
| 底线 | 本轮结束时 `app.js` 显著小于基线；**具体行数不写死**——一个凑数的阈值只会催生为过线而做的坏切分 |
| 不做 | 不引入构建工具、不引入框架、不改模块加载方式（仍是原生 ESM） |

## 2. 依赖

```
TASK-072 全部验收
   ↓
1.1 导航收敛（先做——它决定其余一切的落点）
   ↓
1.2 五页重构 ──┬─→ 1.3 四步流程
               ├─→ 1.5 生成记录
               └─→ 1.6 资产库单页 + 抽屉
1.4 Agent 面板（依赖 1.1 的页面结构）
1.7 项目设置（依赖 1.1）
1.8 app.js 拆分（贯穿全卡的约束，不是一个独立步骤）
```

## 3. 迁移方案

| 项 | 策略 |
| --- | --- |
| 旧 module key | 全部保留为**可解析别名**，路由到新页面 + 分区（1.1 落点表） |
| 旧页面组件 | **不删文件**，改为被新页面组合；入口删除 |
| `ui.*` 临时界面状态 | 新增的选择态（当前步骤 / 当前分区）**只存前端**，不持久化 |
| 深链接 / 书签 | 旧 `?mod=` 值继续可用 |
| 视觉风格 | **不变**（ADR-0066 §5） |

## 4. 验收标准

| # | 标准 | 验证 |
| --- | --- | --- |
| 1 | 一级导航恰好三项，二级恰好十一页 | 常量快照测试 |
| 2 | 每个旧 module key 都解析到真实页面 + 可见分区 | 逐 key 守卫测试 |
| 3 | 三层检查各自只在其归属页面出现 | 断言 `dailies` 的整集连播不在 ⑧、`confirmShotVersion` 不在 ⑨ |
| 4 | Agent 入口恰好两类，面板恰好七项 | 结构测试 |
| 5 | 主界面不出现 Skill ID / Runtime / Provider / Model / 内部任务 ID | 渲染快照的文本断言 |
| 6 | 新增一个假 Skill 后页面数量与导航不变 | 守卫测试（系统合同 §5.10） |
| 7 | 「真实取消」调 `cancelRun` 而非清前端状态 | 交互测试 |
| 8 | 推荐永远是未勾选的一行 | 生成清单守卫测试（沿用 ADR-0063 决策 7） |
| 9 | 后端错误显示为错误，不显示为空 | 注入失败的渲染测试 |
| 10 | 视觉风格未变 | CSS 变量与配色不变 |
| 11 | 旧页面 / 旧接口未删除 | `git diff --stat` 无删除文件 |
| 12 | `settings` 与 `projectsettings` 解析到**不同**页面 | 逐 key 守卫测试 |
| 13 | 成片规格与预算只有一个编辑入口 | 断言 ① 页只读、编辑控件只存在于 ⚙ |
| 14 | `app.js` 显著小于基线，且业务规则已移出 | 行数对比 + 按控制器的模块清单 |

**风险等级：中～高**（大范围交互与导航重构，触及渲染/选择/派生视图，
但不触持久化）→ 受影响的全量前端测试 + 定向 pytest；导航与派生视图变更范围大，
按第 20 条同样要求 **Codex 独立审查**。

**真实 Connected Project 是主要验收环境**（AGENTS.md 第 20 条）：
demo seed 与 SVG 占位素材不作为主要验收依据。

---

## 5. 实施记录（2026-08-14，**§1.1 + §1.2 骨架完成，其余未做**）

前置未满足即开工：产品负责人 2026-08-14 明确要求「72-74 全部马上做」。
如实记下这一点，以及**前置 TASK-072 批次二/三仍只是部分完成**。

### 5.1 §1.1 导航收敛 —— 完成

| 落点 | 内容 |
| --- | --- |
| `NAV[0].items` | 6 → **5**：`brief`(项目与创意) `story` `settings`(作品设定) `episodes` `script`。人物 / 人物关系 / 世界观 成为 ③ 的三个分区，`作品设定` 子标题随之消失（没有东西要分组了） |
| `EPISODE_NAV` | 11 → **5**：`board` `storyboard` `shotwork` `cutreview` `delivery` |
| `EPISODE_DEFAULT` | `workbench` → **`board`** |
| `PROJECT_SETTINGS` | 新增独立 route key `projectsettings`，**不复用 `settings`** |
| `MODULE_ALIAS` + `resolveModule()` | §1.1 落点表变成**可执行的一张表**，所有旧 key 经它解析 |
| `PAGES` / `PAGE_SECTIONS` | 十一页的**封闭集合**与各页真实分区，供守卫断言 |

**`ASSET_NAV` / `renderAssetRail` / 旧 11 个 stage 全部保留**。本卡 §0 写的是
「不删旧页面与旧接口」，验收 #11 要求 `git diff --stat` 无删除文件 —— 删除是
TASK-074 §1.5 的事。实施中我一度真的删掉了 `ASSET_NAV` / `EPISODE_WORKSPACES`，
而 `epprod.js`、`production.js` 与两个测试文件仍在 import 它们，**整个前端会加载
失败**；已加回并新增 `LEGACY_EPISODE_STAGES` / `LEGACY_EPISODE_CENTRE` 承载旧语义。

**一个必须分开的语义**：`EPISODE_DEFAULT` 原来同时表示「空间入口」和「制作台」。
改成 `board` 之后，`epprod.js`（制作台外壳）与 `production.js` 里三处
`onCentre` 判定会把**本集看板当成制作台**渲染（三级选择器 + shot graph）。已把
「制作台」语义的用法全部改指 `LEGACY_EPISODE_CENTRE`，「空间入口」语义保留
`EPISODE_DEFAULT`。`episodeEntryModule` 同理保留规则、把两个落点搬到新页
（无分镜 → ⑦ 分镜设计；有分镜 → ⑧ 镜头制作）。

### 5.2 §1.2 五页重构 —— 骨架完成（复用，未重写）

五个新页都由**现有组件组合**而成（§0 贯穿规则），渲染与 bind 逐分区对齐：

| 页面 | 分区 → 复用的组件 |
| --- | --- |
| ⑥ 本集看板 | `renderEpisodeWs` / `bindEpisodeWs` |
| ⑦ 分镜设计 | `scenes` → `ws.renderEpisodes`；`shots` → `renderStoryboard` |
| ⑧ 镜头制作 | **四步流程条**：① `renderRefPlan` ② `renderImageWs` ③ `renderVideoWs` ④ `renderDailies`（④ 即检查层 1，不另建审片页） |
| ⑨ 粗剪审片 | `renderDailies`（整集连播） |
| ⑩ 后期交付 | `renderPostConsole(mode:"full")` + 七分区导航 |
| ⚙ 项目设置 | `storage` → `renderStorageWs`；其余三个分区**诚实显示未接线**，不假装在别处 |

分区状态存 `ui.sections[module]`，**只存前端、不持久化**（§3 迁移方案）。
样式新增 `.st-secnav` / `.st-steps`（studio.css），沿用既有 token 与配色
（ADR-0066 §5 / 验收 #10 视觉不变）。

### 5.3 守卫（新增 2 项，改写 4 项）

- 验收 **#1**：`NAV[0].items` 恰好 5、`PAGES` 恰好 **11**、`projectsettings`
  **不在**十一页内、`PAGE_SECTIONS.shotwork` 恰好是四步且有序。
  这条就是 ADR-0066 决策 10「新增 Skill 不得新增页面」的**执行点**。
- 验收 **#2 + #12**：15 个旧 key 逐个断言「解析到预期页 + 预期分区，且该分区
  真的在 `PAGE_SECTIONS` 里」；6 个 `assets:*` 断言解析成资产库 + 预置筛选；
  `settings` 与 `projectsettings` 断言**解析到不同页**；每个可解析 key 都有标签；
  未知 key 落到真实页且 `resolved: false`。
- 改写（不是放宽）：`workspaces.test.mjs` 的 NAV / EPISODE_NAV / spaceOf /
  `ASSET_NAV` 段、`creatornav.test.mjs` 的制作台段（`EPISODE_DEFAULT` →
  `LEGACY_EPISODE_CENTRE`）、`upstream.test.mjs` 的 IA 段。

测试：全量前端 **939 通过 / 0 失败**；定向 pytest 14 通过。

### 5.4 本卡未做

| 项 | 状态 |
| --- | --- |
| §1.3 四步流程的任务行 | ✅ **完成**（见 5.5） |
| §1.7 的字段清单 + 校验 + 两个硬闸 + 编辑与持久化 | ✅ **完成**（见 5.6） |
| §1.4 上下文 Agent 面板 | ✅ **完成**（见 5.7） |
| §1.5 生成记录 | ✅ **完成**（见 5.7） |
| §1.6 资产库单页 + 抽屉 | ✅ **完成**（见 5.8） |
| §1.8 `app.js` 拆分 | 🟡 **已开工：验证手段已建立，两个控制器已搬出**（见 5.9 / 5.10） |

### 5.7 §1.4 Agent 面板 + §1.5 生成记录 —— 完成（2026-08-15）

两项一起做，因为 §1.4 的「隐藏技术字段」要求它们有地方去，那个地方就是 §1.5。

`src/ui/agentpanel.js`：**两类入口**（页面级「询问 Agent」固定在每页顶部右侧、
对象级「让 Agent 处理」），**七项固定内容**，按需打开、关闭后不占布局。
入口渲染**前置**在所有 workspace 之前，所以「每页顶部右侧固定位」是构造出来的，
新增页面不可能漏掉它。

`src/ui/genrecord.js`：挂在每个结果旁的折叠区，承载 §6.3 从主界面移除的全部字段
（Skill / 版本 / Runtime / Executor / Provider / Model / 内部任务 ID）+ 输入及其
版本 + 参数 + 成本 + 起止 + 失败原因 + **用户确认记录**。

三条硬规则都被守卫：

- **验收 #5**：把 `skillId` / `runtime` / `executor` / `provider` / `model` /
  `runId` / `contextTrace` 全部喂进面板模型，断言渲染结果里**一个都不出现**，
  且模型对象本身不含这些键。创作者看到的是**任务名称**。
- **一个主要执行按钮**：`data-agent-run` 恰好出现一次；不可用时**渲染 0 个按钮**
  并给出真实原因（缺失输入列出具体名字、无执行器给执行器的话）。未判定的能力
  **fail closed**（不是「可用」）。
- **缺失输入逐项可点**：`MODULE_ALIAS_GOTO` 把输入 key 映射到能修它的页面；
  没有落点的输入显示「没有可跳转的位置」，不渲染死链接。
- **生成记录里「未记录」是打印出来的**：历史运行真的没有 provider / cost / 时间，
  回填一个像样的值就是伪造。手工导入的产物 `empty: true`，明说「不会编一个来源
  出来」。「还没有人确认这一版——生成成功不等于定稿」。

守卫：`tests/agentpanel.test.mjs`（9 项）。

### 5.8 §1.6 资产库单页 + 抽屉 —— 完成（2026-08-15）

`renderAssetLibrary(ctx, ui, { mode })` —— **一份实现，两种尺寸**，与
`postconsole` 的 dock/full 同一个模式（卡明确说是「同一条教训」）。
抽屉只多一件事：每张卡的「+ 加入」，因为那正是它被打开的理由。
`Collections` 改名 **「已保存筛选」**（它从来不是第二个容器，只是创作者标记过的
筛选；旧名字暗示了一个「可以往里放东西的地方」，而它不是）。

⑧ 步骤① 挂上抽屉（§1.1 落点表：`refplan` → 步骤①「并打开资产抽屉」），
「+ 加入」走**普通 action** `addReference`，所以抽屉绕不过参考面板走的那道守卫。

守卫：`tests/assetdrawer.test.mjs`（5 项）—— 逐个断言**十个筛选钩子在两种尺寸里
完全一致**（这才是「一份实现」的可检验形式）、抽屉恰好多一个 affordance、
抽屉**点名它要加到哪个镜头**（不点名就是参考落到错镜头的原因）、没选镜头时
明说、Inspector 只在页面尺寸出现（抽屉是用来挑的，不该和自己的目的竞争）。

### 5.9 §1.8 `app.js` 拆分 —— 未做，理由

`app.js` 现在 **6992 行**（本轮还因为 §1.9 修复与 §1.7 接线略有增长）。
卡要求「按领域控制器切分」且「拆分是**纯搬运**：一次提交只移动代码不改行为」。

**做不到纯搬运。** 这些控制器不是独立函数，它们闭包捕获了模块级的
`skillRunRegistry` / `productionDoc` / `assetRegistry` / `ctx` /
`refreshProductionView` 等十余个 `let` 变量。搬出去必须改成
`createXxxController(deps)` 并显式传依赖 —— 那是**改变变量捕获方式**，
不是搬运，风险与「一次提交只移动代码」的前提冲突。

**而且它是本轮唯一无法验证的改动。** 没有任何测试导入 `app.js`（它需要 DOM），
所以一次 850 行的 `skills` 控制器搬迁，我既没有独立审查（codex spend cap），
也没有任何自动化能告诉我搬坏了没有。卡自己的底线写着「具体行数不写死——
**一个凑数的阈值只会催生为过线而做的坏切分**」；在无审查、无覆盖的条件下强行
拆分，正是那种坏切分。

**本轮实际做的减法**是另一个方向且是真的：新增的五个领域模块
（`review.js` / `gates.js` / `deliveryspec.js` / `deliveryqc.js` /
`artifactversion.js`）与三个 UI 模块（`taskrow.js` / `genrecord.js` /
`agentpanel.js`）都是**本来会被写进 `app.js` 的逻辑**，它们现在在 `app.js` 之外
并各自带守卫。这不满足 §1.8 的验收 #14，如实记为未完成。

**前置条件**：要做 §1.8，先要有 (a) 可用的独立审查，(b) 至少一条能加载装配后
`ctx` 的测试（jsdom 或等价物），否则搬运的正确性无从证明。

### 5.9b 更正：验证手段换了一个方向，§1.8 因此开工了

上面那个「(b) 需要能加载 `app.js` 的测试」是**错的方向**。给 `app.js` 造 DOM stub
会极其脆弱（它在模块顶层做大量 `$("#…").onclick` 绑定），而且那条路只验证「装配
没炸」，验证不了搬运是否等价。

**正确的验证手段是让搬出去的控制器自己可构造。** 工厂接显式依赖，测试就能用假文档
直接构造它并断言行为 —— 可测性本身就是验证手段，而且它是净收益：这些控制器
在 `app.js` 里**从来没有过任何测试**。

### 5.10 §1.8 已搬出的两个控制器（2026-08-15）

| 控制器 | 落点 | 行数 | 守卫 |
| --- | --- | --- | --- |
| `ctx.locks` | `src/controllers/lockctl.js` | 78 | `tests/lockctl.test.mjs`（8 项） |
| `ctx.timeline` | `src/controllers/timelinectl.js` | 307 | `tests/timelinectl.test.mjs`（9 项） |

`app.js` **6992 → 6682 行**（−310）。这不是 §1.8 验收 #14 所说的「显著小于基线」，
如实记为进行中。

**为什么不是「纯搬运」，以及这件事本身就是一个发现。** 这些控制器闭包捕获了
`timelinesDoc` / `productionDoc` / `assetRegistry` / `locksDoc` / `PROJECT_NAME` /
`CONNECTED` 等模块级 `let`，而**加载项目时 restore 会整个重新赋值**它们。工厂若在
构造时捕获它们的**值**，控制器就会永远读写**上一个项目**的文档 —— 静默的。所以
文档一律以 **getter** 传入（闭包读 `let` 本来也是调用时求值，语义完全一致）。
`tests/timelinectl.test.mjs` 里有一条专门测这个：换掉整个 production 文档，
`gatherRows()` 必须跟着变。

**自引用改成对象内部引用**：原来 `ctx.timeline.doc()` 内部调
`ctx.timeline.gatherRows()`；因为 `ctx.timeline` 就是这个对象，改成 `api.gatherRows()`
—— 同一个函数，少一次绕行，依赖也变得可见。

#### 搬运时被测试发现的两个既有缺陷（**本轮未修**，§1.8 纪律：只搬不改）

1. **`buildRoughCut` 会把 `t.edited` 置为 `true`，而它的注释说自己不会。**
   注释原话是「An automatic pass is NOT a hand edit… so setting it here made every
   render claim human tuning that never happened」，但 `roughcut.applyRoughCut` 通过
   `timeline.addClip` 放置片段，而 `addClip` 调 `touched()`，`touched()` 就是
   `t.edited = true`。于是**每次自动初剪之后，Final Render 的 provenance 都记
   `timelineEdited: true`** —— 声称了从未发生的人工调整，正是那段注释想避免的事。
   已在 `tests/timelinectl.test.mjs` 里以 `PRE-EXISTING` 钉住实际行为。
2. **`ctx.locks.is("prompt", "s1")`（不带 `|kind`）被读成 image 锁。**
   原码是 `kind === "video" ? "video" : "image"`，所以裸 id 解析成 image ——
   `is()` 回答了调用方没有指名的那把锁。已在 `tests/lockctl.test.mjs` 里钉住。

两条都需要独立审查后再改：#1 改动的是 provenance 的真实性，#2 有真实调用点可能
依赖裸形式。

#### 连带更新的两个既有守卫（不是放宽）

- `test_ai_paths_record_generations_with_frozen_snapshot` 原来断言
  `app.js` 里 `ctx.startGeneration` **恰好 7 次**。ffmpeg render 搬走后变 6。
  不变量是「**系统里**有七条会记录 Generation 的产出路径」，不是「这个文件里有七处」，
  所以改为统计 `app.js` + `src/controllers/*.js` —— 否则后续每搬一个控制器都会
  以错误的理由撞红它。顺带把 `timelinectl.js` 注释里的 `ctx.startGeneration`
  改写掉：**注释不该污染文本计数守卫**。
- 资产卡的两个守卫（TASK-061）用 `function card(a)` 的**精确签名**定位函数体，
  加参数后定位失效；且其中一个用「按钮数量 == 1」近似「没有嵌套」。已改为按
  **函数名**定位 + 真正的**嵌套深度**检查（数量近似既误报兄弟按钮，又抓不到真嵌套）。

#### 剩余控制器与建议顺序

按「依赖清晰 → 收益大」排：`refInterp`(41) · `subtitles`(77) · `shotAudio`(176) ·
`assets`(270) · `frames`(200) · `actions`(470) · `skills`(853)。
`skills` 与 `actions` 最好留到最后：它们跨控制器引用最多，且 `actions` 现在还包着
G3，搬它等于同时动质量门。

### 5.12 §1.8 拆分现状与仍未搬的控制器（2026-08-15）

已搬出：`controllers/lockctl.js`（78 行）、`controllers/timelinectl.js`（307 行），
用「工厂 + getter 注入」模式，因为文档是会被重新赋值的 `let`，直接传值会让控制器
永远拿着切换项目前的那一份。

**第二批搬出（2026-08-15）**：

| 控制器 | 文件 | 为什么这样分 |
| --- | --- | --- |
| 参考解读 + 参考用途 | `controllers/refctl.js` | 同一个域的两面（「读出了什么」/「服务哪一边」），键相同、由同一份绑定列表派生、被同两个编译器消费。拆开就是两个模块各持一半 |
| 字幕 | `controllers/subtitlectl.js` | `_writeCue` 跟着搬 —— 它在 app.js 里只被这个控制器用，且持有「合并+编辑要么整体生效」这条事务规则 |
| 镜头音频 | `controllers/shotaudioctl.js` | 依赖列表全组最长，正是它该被显式列出来的理由：`mixNow` 读登记、调后端、登记 Asset、记 Generation、写混音指针 |
| 首/尾帧 | `controllers/framectl.js` | `grabVideoFrame` 用**注入**而不是 import —— 它读 `<video>` 元素，是这里唯一真正绑定浏览器的一步；注入它，其余部分才能在测试里被构造 |

`app.js` 6912 → 6473 行。

**仍在 `app.js` 里**：`assets`(270) · `actions`(470) · `skills`(853)。
守卫（`test_ai_paths_record_generations_with_frozen_snapshot`）已扩到扫描
`app.js` + `src/controllers/*.js`，所以搬出去不会绕过快照断言。

### 5.11 §1.1 落点表未落地的两项（2026-08-15，独立审查批 3 发现）

落点表把 `workbench` → ⑧ 镜头制作、`provenance` → ⚙ 存储与诊断。第一次实现只
搬了**路由**，没有搬**内容**，于是两条入口都落到了「一个没有该内容的页面」——
正是 ADR-0063 决策 1 禁止的失败，和「落空」等价：

| 旧 key | 落点表写的 | 实际问题 |
| --- | --- | --- |
| `workbench` | ⑧ 镜头制作 | ⑧ 的四步里没有制作台的镜头生成图；而且改写后 `activeModule === LEGACY_EPISODE_CENTRE` 恒为假，制作台中心、`showsFocus`、`onCentre` 与整个「工作区」返回导航一起失效 |
| `provenance` | ⚙ 存储与诊断 | 溯源图挂载在 `render()` 的 **episode 空间分支**里，而 ⚙ 的 `spaceOf` 报 `story`，改写后「完整溯源 ↗」落在存储管理页且**没有图** |

**处理**：两个 key 从 `MODULE_ALIAS` 撤回，保留各自的渲染器和入口。
`resolveModule` 对它们返回 `resolved: false`，而 `setModule` 只在 `resolved` 为真
时改写 key，所以它们原样通过——这一点连同「它们必须仍在
`LEGACY_EPISODE_STAGES` 里」由 `workspaces.test.mjs` 断言（一个既不被别名、又
没有自己工作区的 key 才是真的落空）。

**未做**：把内容搬过去。做完才能重新加别名，顺序是内容先动、路由后动。
归属 TASK-074 §1.5 旧页面清理（它本来就要删这些旧组件，届时必须同时给出新家）。

### 5.5 §1.3 任务行 —— 完成（2026-08-15）

新增 `src/ui/taskrow.js`（纯读模型 + 渲染 + 绑定）与
`ctx.skills.cancel`（app.js）。一行必带六项：**状态 · 耗时 · 成本 · 失败原因 ·
重试 · 真实取消**。挂在 ⑧ 镜头制作，按当前镜头过滤。

诚实规则（每一条都对应本仓库踩过的坑）：

- **未知就是未知**：没开始 → 没有耗时（不是 `0.0s`）；没记录成本 → 「成本未记录」
  （不是 `$0.00`）。「不知道」和「不花钱」是两个答案，而创作者要靠这个差别决定
  是否重试。订阅内的运行显示「订阅内（不额外计费）」。
- **失败原因是后端自己的话**，单独一行、不截断。
- **重试只在终态提供**，否则重试会与被重试的运行竞态。重试是**新的一次运行**，
  旧记录保留（合同 §5.7 显式重试）。
- **验收 #7 的核心**：`ctx.skills.cancel` 调 `POST /api/runs/<id>/cancel`，
  并且**只记录后端确认过的东西** —— 确认终止 → `cancelled`；**未确认终止 → 停在
  `cancelling` 并原样报出原因（含残留 pid），绝不标成已取消**；运行已先完成 →
  保留真实结果，不用「已取消」覆盖它。行上按钮还会区分「取消运行」（后端铸的
  `run-*` id，真有进程可杀）与「放弃」（前端持有的记录）—— 对后者承诺「终止进程」
  是一个没人能兑现的承诺。

**这个入口此前根本不存在**：`ctx.skills.abandon` 早就写着「请用『取消运行』终止
它」，而那句话指向的东西没有实现。

守卫：`tests/artifactversion` 之外新增 `tests/taskrow.test.mjs`（7 项），覆盖六项
齐备、未知不编造、终态无取消按钮、非终态无重试、后端/前端两种取消承诺。
另把 `RUN_STATUS_LABEL` 从 `ui/skillpanel.js` 提到 `workflow/skillrun.js`：
两个面板各写一份状态文案，迟早一个说「进行中」另一个说「running」。

### 5.6 §1.7 ⚙ 成片规格与预算 —— 完成（2026-08-15）

| 落点 | 内容 |
| --- | --- |
| `workflow/deliveryspec.js` | **新增**。IA §4 ⚙ 的**十四个字段**封闭清单 + 逐项校验 + `specStanding()` + **两个硬闸** + `checkRenderedAgainstSpec()`（TASK-074 §1.2 的「规格」项直接用它，不必再推导一遍） |
| `canvasschema.js` | `deliverySpec` 作为**可选加法字段**校验：存在且类型错 → 拒绝；**缺失 → 就是「还没有设置」** |
| `app.js` | 序列化 / 水合 / 新项目重置；`ctx.deliverySpec`（读）与 `ctx.setDeliverySpecField`（**唯一写路径**） |
| ⚙ 的 spec / budget 分区 | 十四个字段**可编辑**：enum 用下拉、int/money 用数字框；留空 = 清回「还没有设置」 |

**两个硬闸是闸，不是确认框**（§1.7 原话「不是弹窗问一句『确定吗』」）：
`checkGenerationCost` 没有任何 `confirm` 参数可以越过它。并且**fail closed** ——
上限没设置时，付费生成与自动重试**一律不执行**：「没有上限」不等于「不限」。
免费（订阅内）操作照常通过，因为没有东西要限。

**校验拒绝、不强转**：`fps: "25"` 被悄悄变成 `25`，意味着存下来的规格和创作者
键入的是两个东西，而只有一个被校验过。被拒绝的输入会**弹回**，不会把项目
没有的值留在框里。

**一次被我自己撤回的过度设计（如实记）**：我先把 `deliverySpec` 做成**必须存在**
的 canvas **v16** 字段，还写了迁移。跑测试时 6 个用例红了 —— 因为那会让所有
手写文档和历史文档（它们都没有这个字段）**整份被拒绝**，是一次白买的破坏性变更。
`deliverySpec` 与 `refInterp` / `frameBindings` / `ctxCache` 完全同类：纯加法、
可选、缺失即空，本仓库那几个**都没有升版本**。已撤回 v16、删掉迁移，版本回到 15。

守卫：`tests/deliveryspec.test.mjs`（6 项），含十四字段清单、present-but-wrong 被
拒、三态（set / unavailable / invalid）、两个硬闸的边界与 fail-closed、以及
「`unavailable` 绝不算通过」。
| §1.5 生成记录（挂在每个结果旁） | **未做** |
| §1.6 资产库单页 + 抽屉（同一组件两个尺寸） | **未做** —— 仍是旧 rail + 库页 |
| §1.7 ⚙ 的 14 个字段与两个硬闸 | **未做** —— 只搭好路由与分区 |
| §1.8 `app.js` 拆分 | **未做** —— `app.js` 反而因 §1.9 修复略有增长 |
| 删除「工作区 ▾」菜单等旧入口 | **未做**，且按 §0/#11 本轮本就不该删文件 |
| Codex 独立审查 | **未做**（reviewer 不可用，见 `.claude/tmp/last-review-task072-075.md`） |

### 5.13 拆分带来的第一批真测试（2026-08-15）

`tests/controllers.test.mjs` 测的是**拆分前根本够不到**的东西：没有任何测试
import 得了 `app.js`（它在模块作用域碰 DOM）。

最重要的一条是 **getter 语义本身**：把文档整体换掉（切换项目）之后，控制器必须
写进**新**文档，而被离开的那个项目一个字节都不变。工厂如果捕获的是**值**，就会
一直往上一个项目里写 —— 静默，且与保存成功无法区分。这条现在有断言了。

写这批测试时抓到一个我自己造的空壳测试：`subtitle.addCue` 自己铸 cueId，
调用方传的被忽略，所以按 `"c1"` 写的合并测试是**什么都没合并**地通过的。
改成用返回的真实 id，并加了一个 `twoCues` 辅助把这件事写在注释里。

### 5.14 搬运不是零风险：一次真回归（2026-08-15）

独立审查在 `shotaudioctl.js` 抓到一条**由搬运本身引入**的缺陷：我把
`docs.registry()` 提到了 `await mixShotAudio(...)` 之前存成 const。在 `app.js` 里
那是裸标识符 `assetRegistry`，**每次使用时**解析 —— 后端返回之后的写入，落在
那一刻当前的登记上。提成 const 之后，混音途中若加载了别的项目，新版本会写进
**被抛弃**的登记，而混音指针被持久化进**新**项目，留下一个在任何登记里都不存在
的 `assetId`。

这条记在这里，因为它反驳「纯搬运没有风险」这个直觉：**闭包读的是绑定，const
读的是值**，两者只在有 `await` 的地方才分得出来。现在这三处一律在使用点读
getter，并有一条在 `mixShotAudio` 里换掉登记的回归测试。

同轮还抓到两条我造成的问题：`_writeCue` 的 JSDoc 没跟着函数走，留在 `app.js` 里
变成了 `prodOp` 的文档；以及测试里用了不存在的 `assetreg.createRegistry`
（真身在 `assetlib`），因为当时没有测试碰到那个 getter，所以它「看起来对」。
两条都已修。

**Follow-up（本轮不做，记录在案）**：跨项目落盘本身是错的，只是 `app.js` 一直
这样。混音途中切项目，结果会登记进**新**项目的登记（源片段属于旧项目），
`versionOf` 在新登记里查不到任何源，于是 `mixProvenance` 记下一串 null 版本。
正确做法是**拒绝**跨项目落盘 —— 那是行为改变而不是搬运，§1.8 是搬运轮，所以
只记录不顺手改（AGENTS.md 第 17 条）。`framectl.extract` 有完全同形的窗口
（两次 await 之后才读登记），同样是既有行为、同样记录。
