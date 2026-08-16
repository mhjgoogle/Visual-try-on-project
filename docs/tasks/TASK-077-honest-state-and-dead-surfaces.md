# TASK-077：诚实状态与死掉的面 —— UI Gap Audit Phase 0

- 状态：**已实现，待独立审查**（六条交付全部完成，七条验收全部在真实项目上通过）
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../src/ui-gap-audit/)（2026-08-16，commit `18fa281`），
  尤其 [ui-correction-plan.md](../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 0
- 前置：**已满足** —— 无新 ADR、无后端改动、无 schema 迁移
- 实施基线：`18fa281`（分支 `feat/wfm1-batch-c`）
- 验收环境：**真实 Connected Project `照见未明rev2`**（AGENTS.md 第 20 条），
  `D:\02_Work\04_video-work\MotvProjects`。**不得用 demo seed 验收** ——
  本卡六条里有三条只有真实项目才暴露。

---

## 0. 本轮边界

**只做两件事：① 停止显示不真实的状态；② 把已经写好但没有入口的面接回主路径。**

**不做**：新领域对象、新 Provider 能力、schema 迁移、路由系统、Skill 目录页、
分镜表格视图、生成卡合并、Agent 会话统一 —— 那些是 Phase 1/2/3。

**一个都不许顺手做**（AGENTS.md 第 17 条）。发现的范围外问题记 `Follow-up`。

---

## 1. 交付

### 1.1 顶栏预算：`unavailable` 不得渲染成 `¥0`

**现状（实测）**：真实项目的 `GET /api/projects/照见未明rev2/budget` 返回

```json
"budgets_jpy":                   {"value": "no config",      "provenance": "unavailable"},
"episode_committed_jpy":         {"value": "no config/data", "provenance": "unavailable"},
"episode_outstanding_holds_jpy": {"value": "no config/data", "provenance": "unavailable"},
"problems": [{"category": "source_corrupt",
              "detail": "config: project config does not exist: …\\config\\wfm1.json"}]
```

顶栏却渲染 **「已花 ¥0 JPY · 余额 ¥0 JPY」**。

**成因**：`src/services/realmap.js:7`
```js
const num = (v) => (typeof v === "number" ? v : 0);
```
文件头注释自己写明了「coerced to 0 here」。渲染在 `src/app.js:390-391`。

**要做**：
1. `mapStanding` 保留每个字段的 `provenance`（不要在这一层压平）。
2. `app.js:390` 的顶栏：任一字段 `unavailable` 时渲染 `—`，不渲染 `¥0`。
3. 顶栏挂一个可点的 ⚠，点开显示 `problems[]`（后端已经给了，前端从不显示）。
4. **demo 模式（`app.js:396`）不受影响** —— 那条路的数字是本地预算模型算出来的，是真的。

**为什么是 P0**：这是唯一一条用户会**据此做错决定**的缺陷。付费模式下「余额 ¥0」
读起来是「我没钱了」，真相是「这个项目没有预算配置」。

---

### 1.2 媒体缺失：诚实占位 + 存储页说真话

**现状（实测）**：`照见未明rev2` 的 Asset Registry 有 9 条，`media/` 目录只有 7 个文件。
缺 `assets-ref-c6e26bfb-…_v1.png` 与 `assets-ref-5d4cf6e2-…_v1.png`。

- 资产库（`src/ui/assetlibws.js:182`）直接 `<img src>`，两张渲染成**浏览器默认碎图**，
  裸露 alt 文本。
- 存储页（`src/ui/storagews.js:62,74`）报 **「媒体不可用 0」**。

**成因**：`missing` **是 schema 里合法的 storageState**
（`services/canvasschema.js:518,1427`、`workflow/assetlib.js:92`），
存储页也已经会显示它（`storagews.js:82` 的 `· 检测缺失`）——
**但没有任何代码路径把它设成 `missing`**：所有写入点都是
`storageState: r.storageState || "local"`。声明状态从不与磁盘核对。

**要做**：
1. `assetlibws.js:182` 与所有直接 `<img src>` 的资产卡加 `onerror`，落到
   `shell.mediaBox()` 已有的 `media-none` 诚实占位，文案说**为什么**：
   「媒体文件已不在磁盘上」+ 文件名。
2. 存储页的「媒体不可用」改为**实测计数**：本轮用**前端探测**（对每条资产的 url
   发 `HEAD`，或复用图片 `onerror` 的结果汇总），**不新增后端路由** ——
   后端探针是 Phase 3.5。
3. 探测结果**只用于显示，不写 `storageState`**。改持久状态属高风险，本卡不做；
   记 `Follow-up`。

**验收必须在真实项目上做** —— demo seed 的 SVG 占位图永远不会缺失，这个 bug 在 demo 下不可见。

---

### 1.3 参考图用途：按 catalog 真实能力标注，停止显示「模型直接输入」

**现状（代码实测）**：`src/workflow/geninput.js:52-64` 把四类参考标为 `"model-input"`，
`ROLE_USE_LABEL` 在界面上写 **「模型直接输入」**：

```js
"character-reference": "model-input",   // 人物参考
"location-reference":  "model-input",   // 场景参考
"prop-reference":      "model-input",   // 道具参考
"style-reference":     "model-input",   // 风格参考
```

`src/workflow/promptc.js:61` 还会编出：
> `【人物参考】林晚 Ref v3（作为参考图一并提供，保持一致）`

**但整条付费链路能送出的图像只有一张**：

```
shot.first_frame_image → packet.first_frame_image
  → ProviderRequest.provider_parameters
  → src/ai_video_workflow/providers/cloud_minimax.py:271-285 `_payload`
body = { model, prompt, duration, resolution, first_frame_image? }
```

`ProviderRequest`（`providers/models.py:251`）**没有任何多图字段**。
那四类参考图在付费路径上**不会被送出**，模型只收到那行文字。

**要做**：
1. `geninput.js` 的 `ROLE_USE` 从「写死的常量」改成**按当前 Provider 能力解析**：
   模型只吃 `first_frame_image` 时，这四类的有效用途是 `ai-interpretation`，
   不是 `model-input`。
2. 界面文案如实说：**「这几张参考不会进模型，只会被 AI 解读成文字」**。
3. `promptc.js:61` 的「（作为参考图一并提供，保持一致）」**分路线**：
   - 免费 / 手工路线（复制 Prompt → 外部工具）：**保留** —— 那是给创作者的指示，是对的。
   - Gateway 付费路线：改成不承诺图像会被送出的措辞。
4. **不改 Provider 契约**（那是 Phase 3.1 / GAP-27+28，需 ADR）。

---

### 1.4 三步向导接回主路径

**现状（代码实测）**：`src/ui/wizard.js` + `index.html#wz-scrim` 已经实现了完整的
三步流水线，文案一字不差：

```
① 确认镜头 · N 个镜头已就绪
② 准备资产 · 0/N 已生成 · 差 N 个
③ 合成提示词 · 0/N 已合成
1/3 · 完成后批量生视频
```

**它唯一的调用点是 `src/workflow/nodes/assets.js:94`（`ctx.wizard.open(node)`）** ——
一个挂在**节点画布**上的节点。而节点画布已被 ADR-0061 降级为 `?canvas=1` 诊断视图，
**不在任何创作路径上**。整条批量流水线的驾驶舱等于不存在。

**要做**：
1. 在 ⑦ 分镜设计 / ⑧ 镜头制作 的主路径上给它一个入口
   （建议：分镜锁定后出现的「→ 准备资产」主行动）。
2. 保留 `assets.js:94` 那条旧调用点（本卡删入口，不删能力）。
3. 第 ② 步的计数**本轮沿用 `wizard.js` 现有算法**，不做实体推导 ——
   实体链接 → 真实资产缺口是 Phase 1.2。

**这是本卡投入产出最高的一条：代码已存在且完整，只是接一根线。**

---

### 1.5 剧集制作补五页 rail；处理不可达的 `cutreview`

**现状（代码实测）**：
- `src/ui/shell.js:68-78` 导出 `EPISODE_NAV`（board / storyboard / shotwork /
  cutreview / delivery）—— **除 shell.js 自身与测试外零消费者**，没有渲染器画它。
- 剧集制作空间**没有左栏**，唯一导航是中栏的 `工作区 ▾` 下拉
  （`src/ui/epprod.js:182-203`），里面是 **11 个 LEGACY 阶段键**。
- 全仓库搜不到 `data-mod="board|storyboard|shotwork|cutreview|delivery"`，
  也搜不到 `setModule("<五页任一>")`。
- **`cutreview`（⑨ 粗剪审片）连别名都没有**：`production.js:807` 有渲染器、
  `:1562` 有绑定，`activeModule === "cutreview"` 永远不成立。**死代码。**

**要做**：
1. 剧集制作空间渲染 `EPISODE_NAV` 五页 rail（复用 `shell.renderRail`）。
2. `工作区 ▾` 旧菜单**保留**（TASK-074 才退休），两者都经 `resolveModule`，不得打架。
3. `cutreview` 二选一，**在任务卡里写明选了哪个和为什么**：
   - 给它一个真实入口（rail 第四项），或
   - 按 ADR-0063 决策 1 删除并记录 —— 但它的内容 Phase 1.4 会用，**建议保留入口**。
4. `shell.js:104-119` 那段承认缺口的注释要跟着更新，不要留下与代码不符的说明。

---

### 1.6 中栏标题 / 面包屑跟随当前页；分集规划数字加口径

**现状（截图实测）**：
- C-014（视频工作区）、C-017（后期交付）的中栏标题仍是
  `S1-01 实验室全景 / 建立镜头 制作流程图` —— 那不是当前中栏的内容。
- C-009（本集看板）面包屑是 `照见未明rev2 › EP01 › **Shot 01** › 本集看板`，
  看板是集级页面。
- C-005 分集规划一屏三个数字打架：左栏徽标 `48` / 页头 `48 集` /
  版本卡 `12 集` / AI 导演 `47 集还没有记录 Arc 推进`。
  （48 = 剧集实体数，12 = 规划 v4 条目数，47 = 缺 Arc 的集数。）

**要做**：
1. 中栏 header 随 `activeModule` 走。
2. `shell.renderCrumb` 本来就支持省略段 —— 只画当前页面**真实作用域**内的段。
3. 每个数字带口径（「已建立 48 集 / 本版规划 12 集」），两者不等时说明差异来源。

---

## 2. 风险分级与检查（AGENTS.md 第 20 条）

| 交付 | 风险 | 理由 |
| --- | --- | --- |
| 1.1 预算显示 | **中** | 派生视图状态 |
| 1.2 媒体探测 | **中** | 只读探测 + 展示；**不写 `storageState`**（写了就是高风险，本卡不做） |
| 1.3 参考用途标注 | **中** | 派生视图状态 + 跨层事实的如实呈现；**不改 Provider 契约** |
| 1.4 向导接线 | **中** | 导航 |
| 1.5 五页 rail | **中** | 导航 / IA |
| 1.6 标题面包屑 | **低** | 纯展示 |

**整卡取最高档 = 中风险** → 相关前端/单元测试 + 必要时定向 pytest；
**审查 1 轮**（`codex-review-loop`）。全量不是本卡的硬门槛。

若实施中出现任何一条被迫写持久状态或改跨层合同 —— **停下来，那条移出本卡**。

## 3. 测试

- `mockups/motv-workspace/tests/` 下补：
  - `unavailable` 预算不得渲染出 `¥0`（纯函数级）
  - `missing` 媒体渲染诚实占位而非 `<img>`
  - Provider 只支持单图时，四类参考的有效用途为 `ai-interpretation`
  - 五页 rail 的每个键都能 `resolveModule` 到真实页面 + 真实分区
  - `cutreview` 可达（若选保留入口）
  - 向导入口在主路径上存在
- 已有守卫测试 `creatornav.test.mjs` / `workspaces.test.mjs` 断言 `EPISODE_NAV`，
  **不得为了通过而修改断言** —— 它们本来就是对的，是渲染缺失。

## 4. 验收（产品负责人看的）

打开真实项目 `照见未明rev2`：

1. 顶栏**不再**显示 `¥0`，显示 `—` + 可点的 ⚠，点开看到 `config/wfm1.json` 缺失那条问题。
2. 资产库里那两张不再是浏览器碎图，是「媒体文件已不在磁盘上 + 文件名」。
3. 存储页「媒体不可用」显示 **2**，不是 0。
4. 镜头制作左栏参考区**不再**写「模型直接输入」，如实说明这几张不进模型。
5. 剧集制作**有左栏五页 rail**，⑨ 粗剪审片可达。
6. 分镜锁定后有「→ 准备资产」入口，点开是那条三步流水线。
7. 切到视频 / 后期交付页，中栏标题和面包屑说的是**当前这一页**。

## 5. 收口

- 重新跑 `src/ui-gap-audit/tools/capture_current.py`，旧图归档到
  `screenshots/archive/YYYY-MM-DD/`，更新
  [manifest](../../src/ui-gap-audit/manifests/screenshots.md)。
- 在
  [ui-gap-analysis.md](../../src/ui-gap-audit/reports/ui-gap-analysis.md)
  把 GAP-01 / 02 / 03 / 06 / 09 / 26 / 28 标为已闭合（GAP-28 只闭合「如实标注」那半）。
- Follow-up 登记：`storageState` 写入 `missing` 的持久化方案（高风险）、
  后端媒体探针路由、Provider 多图契约（Phase 3.1）。

---

## 6. 实施记录（2026-08-16）

### 6.1 六条交付都做了什么

| 交付 | 改到哪里 | 关键决定 |
| --- | --- | --- |
| 1.1 预算 | `services/realmap.js` 重写 `mapStanding`；`app.js` 顶栏；`ui/inspector.js` 明细面板 | 金额字段变成 `{value, available, provenance, note}`，`yenOf()` 印 `—`。`remaining` 只在三个输入**都**可用时才可用（用压平的 0 去减正是原缺陷）。`problems[]` 第一次有了界面。**明细面板同样改了** —— 它原本也印六个 `¥0`，是点开顶栏之后把谎言坐实的地方。 |
| 1.2 媒体 | 新增 `services/mediaprobe.js`；`ui/storagews.js`、`ui/assetlibws.js`、`ui/shell.js`、`ui/production.js` | `HEAD` 探测 + `<img onerror>` 汇入同一张 URL 表。**只读**：不写 `storageState`，不进 canvas。`data-media-url` + `production.js` 一个集中的 `onerror` 处理器，使没被改造的组件也不再显示碎图。`data:`/`blob:` 不探测（demo seed 因此永远不会被误报，这也正是该缺陷在 demo 下不可见的原因）。 |
| 1.3 参考用途 | `workflow/geninput.js` 新增 `ROUTE_CAPABILITY` / `effectiveRoleUse` / `referenceRouteMatrix`；`ui/prodinspector.js`；`workflow/promptc.js` + `ui/storyboard.js` + `app.js`（`route`） | **`ROLE_USE` 一个字没动** —— 它决定引用进哪条 Prompt（`refuse.js`）、画在生成图哪一侧（`shotgraph.js`），改它就是跨层改动。派生出「按路线的有效用途」。 |
| 1.4 向导 | `ui/storyboard.js`（渲染 + 绑定） | 入口放在 ⑦ 分镜设计 头部。`assets.js:94` 旧调用点保留。 |
| 1.5 五页 rail | `ui/shell.js` 新增 `renderEpisodeRail`（抽出共用的 `railItem`）；`ui/production.js`；`styles/epprod.css` 加第四列 | `cutreview` **选择保留入口**，见 6.2。 |
| 1.6 标题/面包屑/口径 | `ui/epprod.js`、`ui/shell.js` 新增 `crumbScope`、`ui/production.js`、`ui/epplanws.js`、`ui/workspaces.js`、`ui/director.js` | 面包屑作用域变成一张可测的纯函数表，不再是 shell 闭包里的条件。 |

### 6.2 `cutreview` 的处置：**保留入口**（rail 第四项）

任务卡 §1.5.3 要求写明选了哪个和为什么。

**选择：给它真实入口，不删。** 三条理由：

1. 它**不是废弃品，是没接上的成品**：`production.js:807` 有渲染器、`:1562` 有绑定，
   在真实项目上打开就是完整可用的整集审片（60 个镜头、通过/跳过、分页）——
   见 C-024。ADR-0063 决策 1 惩罚的是「落到一个没有该内容的页面」，
   而这里内容一直在，缺的只是那一行 `data-mod`。
2. 它是 **ADR-0066 冻结 IA 十一页中的一页**。删掉它等于让实现单方面改冻结的 IA，
   而 ADR-0066 把那份 IA 定为该范围的唯一权威。
3. 任务卡自己指出 Phase 1.4 会用它的内容（GAP-22 要把它改造成「故事板」形态）。
   这一轮删掉、下一轮重建是纯粹的返工。

### 6.3 与任务卡的两处偏差（都写在这里，不是悄悄改的）

**① 1.3 的界面文案：列出两条路线，而不是只列当前那条。**

任务卡设想「按当前 Provider 能力标注」。照字面做，验收环境（后端未 `--enable-paid`）
的当前路线是**手工路线**，那条路线上「模型直接输入」是**真的**（创作者亲手把文件附给
外部工具），于是验收标准 #4「不再写模型直接输入」在这个环境里根本无法演示 ——
而 §1.3 本身又要求「免费/手工路线的措辞保留，那是对的」。两条要求照字面同时满足不了。

处理：**同时列出两条路线的事实，标出当前在哪条**。理由写在
`geninput.referenceRouteMatrix` 的注释里 —— 这个产品同时提供两条活路线，只印当前那条
虽然此刻诚实，仍会让一个正在计划付费跑一次的人以为四张图会被送出。
要消灭的是**无条件断言**，不是其中一条事实。
结果：全库搜不到「模型直接输入」这句渲染文案（实测 `document.body.innerText` 不含它），
同时手工路线的正确指示一字未丢。

**② 1.4 的入口不以「分镜已锁定」为条件。**

任务卡建议「分镜锁定后出现」。真实项目 `照见未明rev2` **没有锁定的 plan**，
照建议做则该入口在验收环境里不出现，验收标准 #6 无法演示。
处理：**只要有分镜草稿就出现**；锁定后它变成 primary 主行动样式。
理由：向导第 ① 步本来就是「确认镜头」——那是锁定**之前**做的事，把入口挂在锁定之后
等于把工具锁在它要解决的问题后面。两种状态都有测试。

### 6.4 检查结果

| 检查 | 结果 |
| --- | --- |
| 前端全量 `node --test tests/*.test.mjs` | **1150 通过 / 0 失败**（新增 `tests/honeststate.test.mjs` 45 项） |
| 已有守卫测试 `creatornav` / `workspaces` | **未修改一个断言** —— 它们本来就是对的，缺的是渲染 |
| 真实项目验收（`照见未明rev2`，Playwright，1440×900） | 七条验收标准全部通过，**0 JS 异常** |
| `capture_current.py` 重抓 | 24 张，五页全部经 `data-mod` 直达（原先 `cutreview` 抓不到） |
| ruff | 通过（改动到的 Python 只有 `capture_current.py`） |
| 独立审查 | **待补** —— 见 6.6 |

七条验收的实测值：

1. 顶栏 `已花 — · 余额 — ⚠ 1`，点开见 `config: project config does not exist: …\config\wfm1.json` ✅
2. 资产库两张卡 = 「媒体文件已不在磁盘上」+ 文件名；`naturalWidth===0` 的 `<img>` 计数 **0** ✅
3. 存储页「媒体不可用」= **2** ✅
4. 镜头制作左栏：全页搜不到「模型直接输入」；两条路线的事实并列，当前路线标出 ✅
5. 剧集制作左栏五页 rail；⑨ 粗剪审片可达（C-024） ✅
6. 分镜设计有「→ 准备资产」，打开是三步流水线：`60 个镜头已就绪 / 0/60 已生成 · 差 60 个 / 0/60 已合成` ✅
7. 视频 / 后期交付 / 本集看板 / 粗剪审片：标题与面包屑都说当前这一页，不再挂 `Shot 01` ✅

### 6.5 Follow-up（本卡不做，AGENTS.md 第 17 条）

| # | 事项 | 风险 | 归属 |
| --- | --- | --- | --- |
| F-1 | **把 `storageState` 真的写成 `missing`** —— 声明与磁盘对齐。需要决定谁是权威、何时核对、如何回滚 | **高**（持久化 + 状态机） | 新任务卡；Phase 3.5 之后 |
| F-2 | **后端媒体存在性探针路由** —— 前端 `HEAD` 探测是本轮的权宜，一个只读探针路由能一次答完并给出更多信息（大小、mtime） | 中 | Phase 3.5 |
| F-3 | **Provider 多图契约** —— `ProviderRequest` 加 `reference_images`，catalog 声明每个 model 吃几张。GAP-27 + GAP-28 的另一半 | **高**（跨层合同） | Phase 3.1，需 ADR |
| F-4 | **CJK 项目名让后端启动崩溃**（GAP-14）—— 必须 `PYTHONIOENCODING=utf-8` 才能起，`run-windows.ps1` 没设。中文用户的必经路径 | 中 | 独立小卡 |
| F-5 | `epprod.topBar` 原本对镜头标题 `esc()` 了两次（`&` 会印成 `&amp;`）。本轮顺手改正了，因为改动就落在那一行上 —— 记录在此以免看起来是范围外改动 | 低 | 已随本卡修 |
| F-6 | 五页 rail 目前**不带徽标**。`shell.js` 自己记着为什么（「第二份计数只会和页面自己的数字打架」）；要带就得先有这五页各自的真实徽标模型 | 低 | Phase 1 |
| F-7 | `20-workspace-shell.png`（另一个前端 :8792）本轮未重抓 —— 不在本卡范围 | 低 | — |

### 6.6 审查状态

按 CLAUDE.md 实施纪律，本卡整体**中风险 → 审查 1 轮**。提交在审查之前进行
（ADR-0069 决策 5：审查不是提交的前置门槛）。

**本卡不含高风险改动**，因此不需要登记待复审清单：没有持久化写入、没有 schema/迁移、
没有身份或登记变更、没有付费路径改动、没有跨层合同变更（`ROLE_USE`、`ProviderRequest`、
`storageState` 全部原样未动）。唯一新增的持久性接触点 `mediaprobe` 是纯读、纯内存、
不进 canvas。
