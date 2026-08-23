# TASK-081：URL 即状态 —— 路由与深链接（Phase 2 下半 · 之一）

- 状态：**已完成**（2026-08-16，提交 `3ca71e8`）
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：[UI Gap Audit](../../src/ui-gap-audit/) GAP-07，
  [ui-correction-plan.md](../../../src/ui-gap-audit/reports/ui-correction-plan.md) Phase 2.3
- **前置：TASK-080 已完成并提交**
- 验收环境：**真实 Connected Project `照见未明rev2`**

---

## 0. 要解决的用户问题

**刷新一次就回到落地页；把「EP07 的 SH12」发给别人做不到；浏览器后退键直接离开应用。**

全仓库 `grep pushState|replaceState|popstate` → **零命中**。
唯一的 URL 参数是 `?canvas=1`（诊断视图）。导航全是内存里的 `activeModule`。

对位 T-003：LibTV 的 `liblib.tv/canvas?spaceId=…&projectId=…`，
项目在新标签页打开，URL 是状态。

**`resolveModule()` 本来就是为深链接写的** —— 它的注释写着
「a dead deep link is a worse answer than a landing page」，
而目前**根本没有 deep link 可死**。

---

## 1. 交付

### 1.1 路由形态

```
#/<project>/<space>/<module>[/<section>]?ep=<episodeId>&scene=<sceneId>&shot=<shotId>
```

- 用 **hash 路由**，不用 History API 的 path 路由 —— 后端是
  `mockups/motv-workspace/server.py` 的静态服务，path 路由需要 catch-all 改后端，
  本卡不改后端。
- **解析一律走现成的 `resolveModule`**，不得写第二套映射。
  历史键（`characters` / `frames` / `video` / `edit` / `storage` …）必须仍能解析，
  且落到**真实页面 + 真实分区**（ADR-0063 决策 1）。
- `popstate` 驱动 `setModule`；`setModule` 反向写 URL（`replaceState` 用于
  同页内的分区/选中变化，`pushState` 用于换页 —— 否则后退键会被分区切换淹没）。

### 1.2 三条必须处理的边界

1. **未保存的编辑**：`setModule` 今天有 `ui.dirty` 守卫（`production.js:1327`
   附近的 `window.confirm`）。`popstate` 走的是**另一条路** ——
   后退键必须同样受这个守卫保护，否则浏览器后退会**静默丢弃**镜头详情的未保存修改。
   **这是本卡最可能造成数据丢失的一处。**
2. **不认识的 URL**：解析不出来时落到落地页并**说明原因**，不静默吞掉
   （`resolveModule` 已经返回 `resolved: false`，用它）。
3. **项目不存在 / 未连接**：URL 里的项目名不在 `/api/projects` 里时，
   不要试图打开一个半初始化的工作台 —— 回落地页并说明。

### 1.3 顺带（低成本，同一处改动）

- 落地页项目卡点击后进入**上次所在页**，而不是固定首页。
  上次位置存 `localStorage`，**不进 canvas.json**（那是创作数据，不是 UI 状态）。
- `capture_current.py` 改成直接按 URL 跳页，不再靠点击链路 ——
  **审计工具本身会因此变可靠**（今天它靠 `[data-mod]` / `[data-ep-ws]` 猜路径）。

---

## 2. 风险分级与检查（AGENTS.md 第 20 条）

**中风险**（导航 / 派生视图状态）→ 审查 1 轮。

**但 §1.2 第 1 条是数据丢失面** —— 若实施中发现 `ui.dirty` 的守卫覆盖不全，
或需要改持久化来保住草稿，**停下来重新分级**。

## 3. 测试

- `resolveModule` 的每个历史键：URL → 真实页面 + 真实分区（守卫测试，
  沿用 `creatornav.test.mjs` 已有的断言，**不得为通过而改断言**）
- 不认识的 URL → 落地页 + 原因，不抛异常
- **`popstate` 与 `setModule` 共用同一个 `ui.dirty` 守卫**（守卫测试）
- 往返：`setModule(k)` → 读 URL → 解析 → 得到同一个 `k`（性质测试，
  不是逐个枚举 —— 参考 TASK-077 跨源那条的教训：**断言性质，不要枚举写法**）

## 4. 验收（产品负责人看的）

1. 打开 EP07 的某个镜头，**刷新页面还在那里**。
2. 复制地址栏发给自己，另开一个标签页能到同一处。
3. 浏览器后退键回到上一页，**不离开应用**。
4. 镜头详情有未保存修改时按后退，**弹出确认**，不静默丢弃。
5. 从落地页点项目卡，回到**上次所在的页**。

## 5. 收口

- `capture_current.py` 改为 URL 驱动 —— **已做**：按 `#/<项目>/<空间>/<页面>` 跳页，
  请求地址与落点地址都写进 `capture.json` 作为证据；落回落地页的情况记为 finding
  而不是伪造一张截图。
- 重跑、归档旧图、更新 manifest —— **受阻，未做**：真实 Connected Project
  `照见未明rev2` 不在本机。留给人工验收那一次。
- 标记闭合：GAP-07 —— 代码侧已闭合，**截图证据待补**。

## 6. 实施记录

- `src/services/route.js`：`formatRoute` / `parseRoute` / `sameRoute` +
  上次所在页（localStorage）。纯函数；解析一律走 `resolveModule`，不写第二套映射。
- `production.js`：`routeLeavesObject`（后退键与 `setModule` 共用的那**一个**判断）、
  `guardsUnsavedEdit`、`route()`、`applyRoute()`；`setModule` 现在返回是否真的移动了。
- `app.js`：`writeUrl` / `honourAddress` / `restoreUrl` / `clearUrl` +
  popstate & hashchange；一次后退触发的两个事件用 `sameRoute` 吞掉第二个。
- 另跑 Playwright 浏览器烟测 11 项，覆盖单元测试盖不到的部分。

独立审查：codex 跨模型 3 轮，5 条 P1 全部已修：
`applyRoute` 问了不问都照样清草稿 / popstate+hashchange 双发在拒绝后重跑 /
只写 `?scene=` 绕过守卫把草稿挂到别的镜头 / 「返回项目列表」后按后退把人搁浅在
落地页 / `sameRoute` 漏了 `filter` 把真导航当重复事件吞掉。
最后一条因预算耗尽选择「只修 P1」未再复审，如实记在 `.claude/tmp/last-review.md`。

### Follow-up

- `honourAddress` 在等待项目加载期间会丢掉后续的 popstate/hashchange，快速连按
  前进/后退可能被先到的那条路由覆盖（P3，审查轮 2 记录）。地址最终会被 `writeUrl`
  规范成实际所在处，所以屏幕与地址不会不一致。
