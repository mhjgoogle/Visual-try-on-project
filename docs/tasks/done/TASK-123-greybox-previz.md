# TASK-123：3D 白膜导演台

- 状态：**已完成（v1）**（2026-08-30 落地，可在真实项目上摆位、预览、录白膜；2026-09-04 收口）。
  「录白膜未在真浏览器验证」已登记为 [TASK-087 §5.18](../active/TASK-087-followup-ledger.md)，
  在验过之前界面继续标为实验能力
- Workflow：Feature · 深度：DEEP
- 起因：产品负责人 2026-08-30「帮我在剧集制作里面加入 3D 导演台让我能做白膜视频」
- 关联 ADR：[ADR-0094](../../adr/ADR-0094-greybox-previz-is-a-section-not-a-page.md)
- 技术目标（没有对应的产品需求条目）：让「这一镜怎么拍」在拍之前就能看见 ——
  走位与机位在分镜阶段确定，而不是等到生成之后才发现镜头不对

## IN SCOPE

- 「分镜设计」新增第三个分区「3D 导演台」（**分区，不是第十二页**）
- 一镜一份 blocking：场地、时长、演员（起止站位 + 朝向 + 身高）、道具方块、
  机位起幅/落幅（位置 / 高度 / 看向 / 焦距）
- 俯视图**拖着摆**：机位、看向、演员起点终点、道具
- 镜头预览：手写的极小 WebGL，只画方块与地面网格
- 时间线拖动与播放；**录白膜**：录这块画布，登记成 `motionpreview` 资产
- Agent 能改它：`blocking.actor` / `blocking.camera` / `blocking.timing`

## OUT OF SCOPE

- 任何 3D 库（Three.js 等）—— 零依赖 + CSP 只允许自身来源
- 模型导入 / 骨骼 / 动捕：白膜里演员就是一个有身高的方块
- 曲线与缓动：起止两点之间线性插值，先把「谁从哪走到哪」说清楚
- 把白膜算作成片：它的 kind 是 `motionpreview`，**不参与成片判定**

## 实现

| 件 | 在哪 |
| --- | --- |
| 数据模型（纯函数） | `src/workflow/blocking.js` |
| 渲染器（手写 WebGL） | `src/ui/blockgl.js` |
| 界面 + 俯视图 | `src/ui/blockingws.js` |
| 交互 / 播放 / 录制 | `src/ui/production.js` 的 `bindBlocking` |
| 门面与资产登记 | `src/app.js` 的 `ctx.blocking` |
| 分区登记 | `src/ui/shell.js`（`storyboard: [scenes, shots, blocking]`） |
| Agent 动作 | `src/workflow/convactions.js` |
| schema | v19 → v20：`production.blocking` 一张空表（纯加法） |

**复用而不是新造**：白膜视频登记走既有的 `motionpreview` 链 —— 仓库里早就有这个
kind，注释里就叫「白膜视频」，而且它**不参与成片判定**（一段白膜混进镜头视频那条链，
会让六十个镜头看起来都拍完了）。为 3D 导演台另造一个 kind 只会有两个词表达同一件事。

**一份采样，两个读者**：预览与录制都读 `sampleAt(t)`，所以「看到的」与「录出来的」
不可能是两回事。

## 验证

- 新增 `tests/blocking.test.mjs` 20 条：走位插值、机位推拉、软删除可撤销、
  采样确定性、越界夹住、round-trip 无损、俯视图坐标两个方向自洽、拖动命中判定
- 前端全量 **2037 passed / 0 failed**
- 真浏览器（swiftshader）走通：分区出现 → 加两个演员 + 一个道具 → 拖机位 →
  拖时间线 → 读回画布中心像素 `87,91,100`（不是背景色，说明真的渲出来了）→ 无页面错误

## 还没做 / 下一步

- **录制没在真浏览器里跑通过**：`MediaRecorder` 需要一个真实的显卡合成路径，
  headless + swiftshader 下没有验证。他自己点一次「录白膜」是最快的验收。
- 没有阴影、没有柔化、没有抗锯齿之外的画质手段 —— 这是白膜该有的样子（ADR-0094 决策 2）。
- 曲线/缓动、多机位、多镜连拍：等他用过之后再说。
