# TASK-066：剧集制作 = 把每个 Shot 做成「选定的最终 Shot Video」

- 状态：**已验收**（产品负责人 2026-08-13 随 ADR-0066 批准一并收口）
- 实施基线：`ae0a54a`
- **后续归属**：§0 的产品定义（「剧集制作 = 把每个 Shot 做成用户选定的最终 Shot Video」）
  被 [ADR-0066](../../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  **完整继承**，成为「镜头制作」页的目标。**本卡的「五区工作台」布局被 ADR-0066 决策 3
  的四步线性流程取代**（准备输入 → 制作主画面 → 制作视频 → 对比候选并选定）；
  五个区的每一项能力都在四步里有归属，替代实施在
  [TASK-073](../done/TASK-073-fixed-ia-and-contextual-agent.md) §1.3。
- 负责 Agent：Claude Code（单一实施 Agent）
- 前置：[TASK-065](TASK-065-creator-object-first-ia.md) 已实施完成并通过 codex 审查
- 依据：产品负责人 2026-08-12 下发的 §1–§20 规格 + 参考图

## 0. 产品定义（本轮的边界）

**剧集制作的目标不是做完一整集成片。** 它只负责把 Episode 里每一个 Shot 做成
**用户选定的最终 Shot Video**。

```
Episode → Scene → Shot → Selected Shot Video
```

一个 Shot 制作完成 = 有一个用户选定的最终 Shot Video；历史版本保留；主界面只显示
当前选定版本。Scene 只是剧情分组，**不需要 Scene Video**。

**本轮不做音频与后期**：Dialogue / Base Voice 生成 / SFX / Foley / Ambience / BGM /
字幕 / Shot Mix / Rough Cut / Episode Editing / Final Mix 全部属于将来的「后期制作」。
Phase 3 的 domain **不破坏、不删除**，只是不再由剧集制作的 UI 展示。

## 1. 与 TASK-065 的关系（本轮改什么）

TASK-065 交付的三栏是对的方向，但左栏仍是「对象 Inspector」，底部仍是后期控制台。
本轮按参考图收口成五个区：

| 区 | TASK-065 现状 | 本轮 |
| --- | --- | --- |
| TOP | EP 下拉 + 场景 chip + 镜头 chip | **EP ▼ / Scene ▼ / SH ▼ 三级联动下拉 + 当前 Shot 摘要（时长 / 镜头类型 / 情绪，标题可改）** |
| LEFT | 对象 Inspector（镜头/参考/Prompt/生成/画面/视频/音频 面板） | **当前 Shot 参考输入**：两组卡片（主要画面参考 / 视频编排参考），每卡 `⋮` 控制关系 |
| CENTER | 8 个 band 的生产图，点节点 → 左栏 | **制作流程图**：参考输入簇 + Image Prompt → 主帧图 → Video Prompt → 最终视频 + End Frame，**卡片内联动作**，不弹大 Inspector |
| RIGHT | AI 导演 + 能力面板 | AI 导演 + **当前状态清单** + 建议卡（带动作按钮）+ 对话框 |
| BOTTOM | 后期控制台 dock | **参考素材库（当前 Shot）**：搜索 / 类型筛选 / 预览 / `+ 加入` |
| FOOTER | （无） | **Shot 进度**：参考准备 → 主要画面 → 视频编排 → 最终视频 |

## 2. 需要产品知晓的两个 IA 决策

### 决策 1：后期控制台离开剧集制作的底部，但一个能力都不删

§15 要求剧集制作不再展示后期，§17 把底部给了参考素材搜索，§19 又禁止新增顶级导航。
三条同时成立只有一个解：**移除底部 dock，保留 `剪辑` 工作区（工作区 ▾ 里）作为后期
控制台的全尺寸形态**。Phase 3 的多轨音频 / Shot Mix / 字幕 / 初剪 / Lock / 成片溯源
全部原样可达，只是不再占据 Shot 制作的屏幕。将来「后期制作」空间单独讨论时，它就是
那个空间的主体。

### 决策 2：「用于主要画面 / 用于视频编排」需要一份新的小文档

参考图要求每张 Reference 卡片用 `⋮` 选择它服务哪一侧。当前领域层**没有**这个信息：
`shotProduction.references[shotId]` 是一个**扁平 key 列表**，没有 per-binding 元数据；
现在哪个参考进哪个 Prompt 完全由 **ROLE 推导**（`geninput.ROLE_USE`：人物/场景/道具/
风格 → 模型直接输入；视频风格/运动/机位/表演 → AI 解读）。

因此新增 `workflow/refuse.js`（沿用 `promptdoc` / `refinterp` 的同一形状：纯
sanitize/serialize 文档 + 派生默认值 + 显式覆盖）：

- `refUse[shotId][refKey] = "image" | "video" | "both"`
- **没有记录 = 按 ROLE 推导**（与今天行为完全一致，零迁移、旧项目行为不变）
- 有记录 = 创作者的显式选择，覆盖推导
- 语义允许才提供「同时用于两者」：风格参考本来就两边都进；人物参考进 video prompt
  没有编译器读它，所以那一项不提供 —— **不给出编译器不会执行的选项**

## 3. 交付清单

- [x] 新域：`workflow/refuse.js` + `ctx.refUse`（派生默认 + 显式覆盖 + Action Layer）
- [x] TOP：三级联动选择器 + Shot 摘要（`ui/shotselect.js`）
- [x] LEFT：`ui/shotrefs.js` —— 两组参考卡 + `⋮` 关系菜单 + `+ 添加参考` + `AI 推荐`
- [x] CENTER：`ui/shotgraphview.js` 重构为参考输入簇 + 4 个主卡 + End Frame，卡片内联动作
- [x] CENTER：自动布局 / 手动布局 + 全屏
- [x] BOTTOM：`ui/refsearch.js` —— 视觉资产检索器（搜索 / 类型 / 预览 / 加入）
- [x] FOOTER：Shot 进度四步（派生）
- [x] 移除底部后期 dock；`剪辑` 工作区保留为全尺寸后期控制台
- [x] 「自动生成」的诚实边界：Prompt 卡 = 真实跑 Prompt Director skill；
      主帧图 / 最终视频卡 = **没有 media provider**，如实说明并给出「复制 Prompt +
      参考 → 外部生成 → 上传回来」的路径。**绝不假装能生成。**
- [x] targeted tests（833/833 全绿）
- [~] RIGHT：`当前状态` 清单 + 建议卡动作按钮 —— **本轮 [TASK-067](TASK-067-ai-director-operationalization.md)
      Phase 4 承接**。右栏当时仍是工作区通用的 director 面板（状态 / 计划 / 收件箱 + 能力目录），
      §1 表格里承诺的「当前状态清单 + 带动作按钮的建议卡」没有落地。这是 TASK-067 §2/§6/§18/§19
      的主体，因此不在本卡重复实施。

**据实更正（2026-08-12，TASK-067 起点核实）**：本清单在 TASK-067 开工前长期是陈旧的 ——
除上面标 `[~]` 的一项外，代码都已交付并有守卫测试覆盖，只是勾选框没有更新。

## 3b. 已落地的地基（2026-08-12，第一个 checkpoint）

`workflow/refuse.js` + 全部接线已完成并验证：

| 接线点 | 位置 |
| --- | --- |
| 文档实例 / hydrate / serialize / reset | `src/app.js`（与 `refInterp` 同一生命周期形状）|
| 持久化字段 | `src/services/persist.js` `OWNED_FIELDS` += `refUse` |
| 控制器 | `src/app.js` `ctx.refUse`（`allowed` / `effective` / `groups` / `set` / `clear`）|
| Action Layer | `actions.js` `setReferenceUse`（risk `pointer`）+ dispatcher 校验绑定与角色 |
| **编译器真的读它** | `ui/storyboard.js` `referenceInputs` 拆成 `imageReferences` / `videoReferences`（含各自的解读），两个编译器各吃自己那一侧 |
| 解绑即遗忘 | `ctx.shot.removeReference` 顺带 `refuse.forget`，避免重新绑定时复活旧选择 |

**行为默认零变化**：没有覆盖记录时按 ROLE 推导 = 今天的行为。验证：
前端 **829 passed / 0 failed**（与 TASK-065 收尾时相同）、19 个模块导入 smoke 全过、
真实 Connected 项目浏览器验收 **69/69 · 0 JS 异常**（沿用 TASK-065 的脚本，
确认新文档没有破坏现有界面）。

## 3c. 五个区已交付（2026-08-12）

| 区 | 位置 |
| --- | --- |
| TOP `EP ▼ / Scene ▼ / SH ▼` + Shot 摘要（标题可改 / 上一镜下一镜） | `src/ui/shotselect.js` |
| LEFT 两组参考 + `⋮` 关系菜单 + `+ 添加参考` + `AI 推荐` | `src/ui/shotrefs.js` |
| CENTER 参考输入簇 + 4 张主卡（卡片内联动作）+ End Frame + 自动/手动布局 + 全屏 | `src/ui/shotgraphview.js`、`src/workflow/shotgraph.js`、`src/ui/epprod.js` |
| RIGHT `当前状态` 清单（派生自同一张图）+ 既有 AI 导演 / 能力 / 对话 | `src/ui/production.js` `aiDirector` |
| BOTTOM `参考素材库（当前 Shot）`：搜索 / 类型 / 预览 / `+ 加入` / 上传 | `src/ui/refsearch.js` |
| FOOTER `Shot 进度` 四步（派生） | `shotgraph.STAGES` + `shotgraphview.renderStages` |
| 五区网格 + 全部样式 | `styles/epprod.css`（网格）、`styles/shotwork.css`（新） |

### 本轮的关键判断

1. **卡片自带动作，不再弹大 Inspector（§10）**。三个动词在每张媒体卡上统一：
   `上传新版 / 自动生成 / 修改`；历史版本是二级入口，主界面只显示当前选定版本。
2. **「自动生成」的诚实边界（§11）**：Prompt 卡真的跑 Prompt Director skill；
   主帧图 / 最终视频卡**没有接生成 API**，就把 Prompt 复制好并明说
   「拿它去外部工具生成，回来用『上传新版』传回这张卡片」。按产品负责人的答复，
   按钮保留、如实说明，不隐藏也不假装。
3. **生成卡片被取消，一张卡只显示当前选定版本**。原来 `图片生成` / `视频生成` 是
   两张独立卡片、画面 v1…v4 是四张平级卡片 —— 那让创作者自己的选择成了这一行里
   最不显眼的东西。
4. **最终视频指向它真正来自的那一版主帧图**。选定的 take 可能来自更早的一版画面；
   如实画出来，创作者才会发现。没有生成记录（导入）就什么都不声称。
5. **Focus Filter 搬进 Shot 下拉**。原来它在中央头部筛「镜头卡片墙」，而卡片墙变成了
   下拉；留在头部就成了一个什么都不筛的控件。搬到它真正能起作用的地方，
   并把被过滤掉的数量如实标出来。
6. **一旦最终视频已选定，进度条不再有「进行中」**。导入的 take 从来没有过视频编排
   参考；把「视频编排」标成进行中、而它本该产出的视频已经选定，读起来是自相矛盾的。
   被跳过的那一步保持 `todo`（它确实没做），不倒填成 done。
7. **后期控制台离开底部但一个能力都不删**（决策 1）：`剪辑` 工作区仍是它的全尺寸形态。

### 验证结果

- 前端 `node --test tests/*.test.mjs`：**833 passed / 0 failed**（TASK-065 收尾 829 → 833）
- `ruff check .`：All checks passed
- 真实 Connected Project `夜班沉默` 浏览器验收（`_agent-tools/shot066.mjs`）：
  **26 / 26 断言通过 · 0 个 JS 异常**，包含一条真正的端到端链路：
  底部素材库「+ 加入」→ 左栏参考卡出现 → 中央关系图建立关系 → `⋮` 菜单只提供
  编译器真会读的用途 → 关系控制真的落到文档 → 「解除关联」把镜头恢复原状
  （**验收不在真实项目里留痕**）。
- 测量式可见性断言：六个区全部有实测 boundingBox，不是「在 DOM 里但看不见」。

### 有意的合同变更（测试同步更新）

| 断言 | 变更 |
| --- | --- |
| `BAND_KEYS` | 8 个 → 7 个（`imageGen` / `videoGen` 取消，新增 `endFrame`） |
| 图节点 | 每个媒体阶段一张卡（`image:selected` / `video:selected`），历史在卡内 |
| `showsFocus` | 现在回答「这一层有没有 Shot 选择器」，而不是「有没有卡片墙」 |
| `renderShotGraph` | 不再渲染 A/B 摘要（那是右栏 `当前状态` 与左栏参考配置的职责） |

## 3d. Codex 审查（2026-08-12）

审查者全程是 **codex**（未回退到 claude，跨模型独立性完整）。

### 已修（都在 TASK-066 自己的代码里）

| 轮 | 级 | 位置 | 内容 |
| --- | --- | --- | --- |
| 1 | P2 | `workflow/refuse.js` `serialize` | 写侧用普通赋值而读侧用 `putKey` → 名字恰好是 `__proto__` 的 shotId / refKey 在保存时**写到原型上**，该覆盖重载后消失。**与 TASK-064 被咬过的是同一处不对称**。两侧统一用 `putKey`，并补 round-trip 守卫。 |
| 2 | **P1** | `app.js` `ctx.shotgraph.model` | 模型收 `{ review, nextShot }`，而控制器**从来没传**→ 每张 End Frame 卡的 `nextShot` 恒为 null，「接给下一镜」永远不出现。**一个看起来做好了、其实是死的功能** —— 正是本仓库反复在抓的「建好了但没有调用者」的反向版本。 |
| 2 | P2 | `ui/production.js` `openShotCard` | 参考是簇里的缩略图、没有 `⋮` 菜单，而这里给它设了 `sgMenu` → 左栏的「查看资产」点了**看得见地什么都没发生**。改为真的打开 lightbox（「查看」就该是看），并在图上高亮它。 |
| 2 | P2 | `ui/shotselect.js` | 选场景时盲取 `pool[0]`，忽略当前聚焦 → 可能选到 Shot 下拉里**根本没列出**的镜头。改为先按聚焦取；该场景全被过滤掉时回落到第一个（聚焦只收窄可选项，不让真实场景变得不可达）。 |

每条都补了守卫测试。

### 范围外，已转记到 [TASK-064 卡 §4d](TASK-064-creator-ui-consolidation.md)

- `workflow/timeline.js` `setClipRemoved` 级联移除同镜头音频时**不检查各自的锁** →
  移除一条未锁定画面会静默移除已锁定的对白 / 音效。
- `app.js` `ctx.frames.bind` 接受任意图片写进 `firstFrames`，即使它属于另一个槽位且
  不是 `derived-frame` → **canvas 校验器会拒绝，绑定之后项目打不开**（严重）。

### 跨任务冲突（不是本卡能修的）

`tests/skills.test.mjs` 断言 catalog 是 **15** 个 Skill，而 working tree 里的
`workflow/skills.js` 已经被**另一个 agent 的 TASK-067 工作**加到 **20** 个
（`shot-asset-recommender` / `image-prompt-director` / `video-prompt-director` /
`prompt-reviewer` / `shot-continuity-reviewer`）。因此**共享的前端测试套件是红的**，
红的原因不在 TASK-066。

按 AGENTS.md 第 14/15 条（一个任务一个实施 Agent、不并行改同一任务的代码），
这条合同应由 **TASK-067 的实施 Agent** 在加这五个能力时同步更新，本卡不代改 ——
代改就等于替一份我没有设计、也没有审查过的契约背书。

**排除该文件后的实测：818 passed / 0 failed。**

## 4. 明确不做

后期制作 UI、Media Provider API、Shared Library、专业 NLE / DAW、新流程系统、
新顶级导航、重写已验证的底层 Domain（Asset / Generation / Reference / Prompt /
Version / Frame Binding / Provenance / AI Director / Skill / Action Layer 全部复用）。
