# TASK-054 — 工作流页面重做：生成溯源图

- 状态：**已验收并收口**（产品负责人 2026-08-13，随 ADR-0052 / ADR-0066 一并收口）
- 实施基线：`ae0a54a`
- ADR：[ADR-0052](../../adr/ADR-0052-workflow-page-as-derived-provenance-graph.md)
  （**Accepted**：决策 1/2/3/5/6/7 保留；决策 4 被 ADR-0066 取代）
- **后续归属**：本卡交付的**读模型完整保留**（`workflow/provenance.js` 的派生规则、
  确定性布局、渐进披露、AI 导演只复述）。**只有页面归属迁移**：顶层「工作流」双视图
  取消，溯源改为呈现在**具体结果旁的「生成记录」**与**项目设置 · 存储与诊断的诊断视图**；
  流程画布不再是执行入口（生成的唯一入口是「镜头制作」四步流程）。
  迁移由 [TASK-073](../done/TASK-073-fixed-ia-and-contextual-agent.md) §1.5 与
  [TASK-074](../active/TASK-074-delivery-migration-and-legacy-retirement.md) §1.5 承接；
  `ui/wfgraph.js` / `workflow/provenance.js` **保留，不删**。
- 前置：[TASK-051](TASK-051-production-studio-ui-convergence.md)、
  [TASK-051A](TASK-051A-ai-director-production-control-tower.md)
- 触发：用户规格「Workflow Page Redesign — Generation Provenance Graph」

验收问题（用户原话）：

> “Can I visually understand exactly which prompt/assets produced this image,
> and which image/prompt then produced this video or other downstream content?”

## 1. 读模型（`src/workflow/provenance.js`）

`buildProvenanceGraph({assets, generations, production, timelines, draftShots})`
→ `{nodes, edges, order, warnings, shots}`。纯函数、每次渲染重算、**不持久化**。

节点三类：**资产**（真实缩略图/海报/波形）、**Prompt**（紫色、文本优先）、
**生成**（紧凑过程块）。边五类：`reference` / `input` / `prompt` / `result` /
`firstFrame`，全部来自记录，没有一条是推断的。

配套导出：`scopeGraph`（剧集/场景/镜头/全项目）、`upstreamOf` / `downstreamOf` /
`traceOf`、`searchGraph`、`sceneGroups` / `shotGroups`、`explainNode`、`layerOrder`。

关键的诚实性约定见 ADR-0052 第 1 条；两条最容易被做错的：

- **参考图的 “Ref v3” 是实体参考列表里的第 3 张，不是媒体版本**。每张参考图各自
  存在单版本链里，直接读 `version` 会把每一张都印成 v1 且全部标成 ACTIVE。
  当选项来自实体的 `activeReferenceAssetId`。
- **切换当前版本不改写历史**：从 Image v2 生成的 Video v1 永远显示来自 v2。

## 2. 界面（`src/ui/wfgraph.js` + `styles/wfgraph.css`）

- 顶栏：剧集选择、范围（剧集/场景/镜头/全项目）、筛选（全部/图片/视频/音频/
  渲染/失败）、搜索（镜头/角色/版本/来源/Prompt 文本/生成 id）。
- 剧集视图为**渐进披露**：场景摘要行（带画面条）→ 展开镜头行 → 展开完整生成链。
  默认展开第一个真有生成历史的场景与镜头，避免开页即空。
- 列式布局 + SVG 连线（连线在卡片**之下**，指针事件留给卡片）。
- 选中即聚焦：上游 ∪ 选中 ∪ 下游高亮，其余淡出；`仅看上游 / 仅看下游 / 完整链路`。
- 右栏 = 检查器（Prompt / 资产 / 生成三种，原始 id 只在折叠的「技术详情」里）
  ＋ AI 导演·溯源（按记录复述，最多一条有依据的观察）。
- 成片链路：上游按种类折叠（`镜头视频 ×4 · 对白 ×2 …`），点开才逐个列出。

「工作流」下现有两个视图：**生成溯源**（默认，只读）与 **流程画布**（原节点执行面，
保留不动）。

## 3. 顺带修复（在本卡范围内）

`workflow/genlib.js` 的 `TYPES` 缺 `render`，而 schema v9 接受它、`app.js` 的渲染
路径也在写它 —— 结果每一条渲染 provenance 都被 `startGeneration` 静默丢弃，成片
没有任何上游可查。补入 `render` 后 §15 的成片链路才成立。

## 4. 演示数据补强（`fixtures/demo-project.js`）

原来的种子无法体现规格要求的形态，补上：

- 图片生成记录**真实的参考图**（场景角色的状态参考 + 场景地参考）；
- 视频变体来自**不同的源图**（v1←Image v2、v2←Image v3），用于验证 §7；
- 两次**未成功**的尝试（1 失败 + 1 取消）保留在链路里（§13）；
- EP01 的**时间线**（视频/对白/环境音/配乐 clip）+ 一次 `render` 生成 + 成片（§15）。

## 5. 验收

- `node --test`：413 项全绿（新增 `tests/provenance.test.mjs` 25 项，覆盖规格
  §20 的全部 15 条 + 布局分层 + 分组计数 + 搜索 + 损坏存档不挂 + 审查发现的
  首帧归属/无输入生成分列/范围内输入保留/缺失资产不猜类型）。
- `python -m pytest`：2793 passed / 68 skipped。
- `codex-review-loop`：9 轮，reviewer 全程为 **codex**（未回退，独立性未降级）。
  17 项 in-scope P1/P2 已修，其中包含**我自己写错的一条测试**（symlink 用例在
  支持 symlink 的 CI 上必然失败）。第 9 轮 in-scope 只剩 1 条 NON_BLOCKING，
  按规则记录不改。报告：`.claude/tmp/last-review.md`。

- 1920×1080 截图（演示项目，真实种子数据，审查修复后重拍）：
  1. `01-episode-overview` — 剧集溯源总览（场景摘要 + 成片链路）
  2. `02-scene-expanded` — 展开场景到镜头行
  3. `03-shot-lineage` — 单镜头完整生成链（参考→Prompt→生成→图片→Prompt→生成→视频）
  4. `04-video-trace` / `04b-video-upstream-only` — 选中 Video v2 的上游追溯
  5. `05-final-render` — 成片链路（折叠组展开为 11 项真实素材）

### 已登记的后续项（不在本卡修）

- `src/ui/storyboard.js` 的 `defaultShotId()` 注释承诺「否则取第一个未归组镜头」，
  实现未兑现；`episodeEmpty` 分支又隐藏了未归组池，因此只有未归组镜头的项目
  无法从镜头工作区查看它们。（第 9 轮 NON_BLOCKING）

## 6. 不在本卡范围

Prompt 库/模板、从溯源图直接发起重生成、导出溯源报告、跨项目溯源，以及
Audio / Edit / 资产库 三个页面的重做（等本页视觉验收后再做）。
