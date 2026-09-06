# TASK-130：切片 5 —— 可重复的 Connected Project 样本 + 一条从头到尾的旅程

- 状态：**实现完成**（2026-09-05；证据见 §实施记录）。真实用户项目上产品负责人自己跑一集仍是另一件事 —— 本卡保证的是他跑之前机器已经在一个可重复的样本上跑过整条旅程
- Workflow：Feature（验收基础设施）· 深度：DEEP（跨后端 / 前端 / 浏览器）
- 关联 Requirement：[REQ-004](../../requirements/REQ-004-three-pane-shell-and-agent-conversation.md)
  判据 6（刷新后继续 —— 真实项目上看得到的那一半）· [REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  判据 3（能落的一定落）· TASK-074 §1.7 完成判据（有 open 阻断问题的候选任何路径都导不出）
  的**人工 / 浏览器**那一半
- 架构约束：`CA §2`（前端只经 HTTP）· `CA §5.5`（项目根围栏：样本只在项目根内生成）· `CA §5.3`（ffmpeg 经 `shutil.which`，没有就 skip 不伪装）
- 依据：[收敛审查](../../design/active/product-requirement-and-ux-convergence-review.md) §5.E ·
  TASK-106 / TASK-074 / TASK-127 各自挂到「切片 5」的人工走查项

## 为什么是「生成器」而不是「提交一份 JSON + 媒体」

§5.E 要「干净机器仅凭仓库内容就能复现主要 UI 状态」，并且「媒体应小而真实，不能用
SVG / 空 JSON 冒充」。仓库里今天有两样正好能拼出来：

- `fixtures/demo-project.js` 的 `seedDemoProject({story, production, scripts, assets,
  generations, timelines})` —— **走的是界面写用的同一组域 API**，所以永远不会与 schema
  漂移；缺点是媒体用 `placeholderFrame`（SVG）。
- `tests/e2e/assets_synthetic.py` 的 `make_video / make_audio / make_image` —— 用 ffmpeg 生成
  **真 H.264 / 真 WAV / 真 PNG**（真容器、真编码、真 magic bytes）。

提交二进制媒体会让仓库长胖、且一改 schema 就过期；提交 JSON 画布同理。所以样本是
**测试运行时生成**的：seed → 换真媒体 → 补 §5.E 要的状态 → `PUT /api/projects/<n>/canvas`。
确定性由 seed 的固定内容与 ffmpeg 的固定参数保证。

## IN SCOPE

1. `tests/e2e/connected_sample.py`：一个函数 `build_connected_sample(base, account, page)`，
   在一个真后端上造出样本项目「样本 · 迷雾入城」：
   - 故事四层（核心 / 大纲 / 结构规划 / 正文）、人物 / 场景地、**两集**、镜头；
   - 每镜关键帧（PNG）/ 视频（MP4）/ 对白（WAV）—— ffmpeg 生成，小而真；
   - **一个运行中的对话 run**（thread 里有问没答）、**一个失败的 run**、
     **一条未决提案**（`proposals`）、**一条 open 的审片问题**（layer delivery, blocking）、
     **一版历史 Final**（`kind: "final"`）与**一版候选**（`kind: "cut"`）；
   - 全部经 API / 域函数写入；不手写 canvas JSON。
2. `tests/e2e/test_connected_journey_task130.py`（playwright，真浏览器）：
   连接项目 → 故事核心改一句（`uiAct` 路径）→ 进剧集制作画布 → **刷新** → 那一轮运行中的
   对话被接回（「正在想…」或「状态未知」，不是空白）→ 交付质检：有 open 阻断问题的候选
   「导出成片」是 disabled 且理由可见 → 问题闭合后导出得到新 `final`、旧记录不变。
   每一步断言的是**产品的选择**（渲染了什么、按钮能不能点），不是 Chromium 的行为。
3. 没有 ffmpeg / playwright 时 **skip 并说明**，不伪装通过（`CA §5.3`）。
4. 收敛审查 §9 验收清单里可自动化的条目逐条对应到这条旅程；不能自动化的（真实项目
   人工走查）在卡上列为**信息**，不阻塞收口（ADR-0082）。

## OUT OF SCOPE

- 真实用户项目的人工浏览器验收 —— 那是产品负责人自己跑一集；本卡提供的是他跑之前
  机器已经跑过一遍的保证。
- 无障碍 / 缩放验收（收敛审查 §6 高优 2）—— 另开卡。
- 把样本做成产品里的「示例项目」入口 —— 它是测试夹具，不是产品功能。

## 完成判据

1. `pytest tests/e2e/test_connected_journey_task130.py`（装了 ffmpeg + playwright 的机器）全绿；
   干净 checkout 上仅凭仓库内容跑得起来。
2. 旅程里的四个断言各对应一张卡的人工走查项：TASK-106（刷新接回）· TASK-074 §1.7
   （阻断候选导不出 / 闭合后导出新版本）· TASK-127（`uiAct` 路径真的落到作品）· REQ-005
   （首页移除项目只改列表）。那四张卡上的「人工走查 → 切片 5」由此改为「自动化已覆盖；
   真实项目人工走查见 §9」。
3. `docs/design/active/product-requirement-and-ux-convergence-review.md` §3 里
   「从真实项目走完创意到交付」由 `NOT_EVIDENCED` 转 `PARTIAL`（自动化那一半成立）。

## 实施记录（2026-09-05）

| 件 | 在哪 | 说明 |
| --- | --- | --- |
| 画布生成器 | `mockups/motv-workspace/fixtures/connected_sample.mjs` | 用界面写用的同一组域 API（`seedDemoProject` + 各 `create*`）造出 v20 画布；占位 SVG 全部换成 `/api/uploads/<项目>/<assetId>.<ext>`；加一版 `cut` + 一版历史 `final`、一条 open 的交付层审片问题（经 `review.issue()` 造，非法就抛）、一次失败的能力运行；`deliverySpec` 设成生成媒体**必然不符**的规格；`validateCanvasDoc` 自检，**造不出合法文档就退出非零**（第一版就被它拒了一次：`platform` 是枚举） |
| 后端侧组装 | `tests/e2e/connected_sample.py` | `POST /api/projects` → node 生成器 → ffmpeg 生成 61 个真文件（43 PNG / 6 MP4 / 10 WAV / 2 成片）→ `PUT /api/canvas/<项目>` → 账户级 feedback.json 种一条未决提案（服务端自己的读写函数）→ `_run_executor` 换成卡在 Event 上的桩、发一句对话 → 线程里有问没答、runs 里有一条 running |
| 旅程 | `tests/e2e/test_connected_journey_task130.py` | 真 Chromium：深链接连接项目 → 左栏四入口 → 右栏「正在想…」→ 故事核心打字（`uiAct` → `work.core`）→ **刷新**：字在、转圈也在 → `release()` → 回答落进线程 → 交付页 · 成片 tab：候选行「导出成片」disabled + 「没被测量」→ 点「对这一版跑质检」：**真 ffprobe 量真文件**，规格不符 → 阻断，仍 disabled → 历史成片「撤回（归档）」→ 从「已导出的成片」消失。**9 秒**，每步断言产品的选择 |

**验证**：`pytest tests/e2e/test_connected_journey_task130.py` → 1 passed（9.0 s）；
`pytest tests/e2e -m "not serial" -n 8` → **37 passed**；ruff 全过、格式过；`lifecycle_check` 0。
没有 ffmpeg / node / playwright 时 skip 并说明。

**走这一遍抓到的**：
1. **持久化的交付层审片问题不进 G4** —— `g4Export` 只读探测算出的报告，`reviews.issues` 里
   `layer: "delivery"` 的阻断问题导出闸门看不见。今天没人撞到是因为界面还没有「提出问题」
   的动作（TASK-087 §5.9）；§5.9 一接通它就是缺陷。登记为 [TASK-087 §5.21](TASK-087-followup-ledger.md)。
   旅程因此用**真实测量的规格不符**触发阻断，不用种问题冒充。
2. 对话线程按 `context.module` 分（`_conv_key`），不是 `page` —— 第一版种的那一轮落到了别的线。
3. 控制台在探测结果回来时重绘，先拿到的元素句柄会失效 —— 按选择器点，轮询消失。

**完成判据**：1 ✅（干净 checkout：仓库内容 + ffmpeg + node + playwright 即可复现）；
2 ✅（TASK-106 / TASK-074 §1.7 / TASK-127 各自的人工走查项由本旅程自动化覆盖；REQ-005 由
它自己的测试覆盖，未重复）；3 ✅（收敛审查 §3 那一行改为 `PARTIAL`）。
**未做**：真实用户项目的人工浏览器验收（产品负责人本人）—— 收敛审查 §9 保留为信息。
