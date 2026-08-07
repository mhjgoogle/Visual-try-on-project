# TASK-048: motv 原型 P0 断层修复——图→视频流转、付费状态自动轮询、上传版本化

- Status: Done（2026-08-07 实施完成；按拍板顺序 2→1→3 串行交付，
  ADR-0048 已随任务 Accepted；E2E 见 `tests/test_motv_task048_e2e.py` +
  `mockups/motv-workspace/tests/frontend-units.test.mjs`）
- Owner: 单实施 Agent（新会话）
- 依据: ADR-0010/0030（Workspace 边界与治理）、ADR-0041/0045/0046/0047（原型
  付费与锁定范式）；诊断来源为 2026-08-07 工作流数据流转四维排查
- 前置: TASK-047 Done（lock-draft-plan 已落地）
- 范围: 仅 `mockups/motv-workspace/`（前端 + mockup `server.py`）。
  不改 `src/ai_video_workflow/` 任何文件，不改冻结合同，不新增付费能力，
  执行本任务不产生任何真实花费。

## 背景（诊断结论摘要）

四维排查确认：核心数据合同层（版本化、`input_digest`、fail-closed）已完备，
断层集中在原型 UI 交互层。三个 P0 断层：

1. **生图产物无法流入视频节点**：assets 节点 `node.uploads[slot]` 与 video
   节点 `uploads` 是两套独立槽位（`assets.js` / `video.js`），图像只在
   `lock-draft-plan` 锁定时才 inline 为首帧（`app.js` `lockDraft`），手工
   路线下图↔视频完全割裂。
2. **付费状态无自动反馈**：`loadPaidOps()` 只在动作后或打开 video detail
   时手动调用，1–2 分钟的真实生成期间 UI 无状态更新，用户不点开看不到
   ⏳/✓ 变化。后端只读投影 `/api/paid-ops/<project>` 已存在且够用。
3. **上传静默替换**：同 slot 重传图/视频/音频即覆盖旧文件，无版本历史
   （README「重传即替换」），与仓库「禁止静默覆盖」纪律（AGENTS.md 第 13
   条）在原型层不一致；也导致多批次生成无法暂存比选。

## 目标

手工与付费两条路线上，「文本→图→视频」链路在画布内闭环：生图产物一键
成为视频首帧输入；付费任务状态自动刷新可见；同一槽位的多批次媒体可
保留、比选、回切，不再静默覆盖。

## 实施要点

### 1. MediaRef 与「🎬 用作视频首帧」一键流转（纯前端）

- 画布层引入统一媒体引用结构（原型内部约定，非核心 schema）：
  `MediaRef { slot_id, origin: upload|paid-image|paid-video|adopted,
  version, digest }`；`digest` 用 sha256，与 lock-draft-plan 首帧绑定
  机制同源。
- assets 节点每镜头缩略图上新增「🎬 用作视频首帧」按钮：把该 slot 当前
  版本图像以 MediaRef 写入 video 节点同 slot 的 first-frame 输入位，
  video 节点显示首帧缩略图 + 来源徽标（「来自资产 v<N>」）。
- `lockDraft` 收集首帧的来源从「assets 节点私有 uploads」改为按 MediaRef
  解析（行为不变：仍 inline 为 data URL、>5.5MB fail-closed）。
- 手工路线 video prompt 模板区提示当前首帧来源，与付费路线
  「提示词/首帧来自你的草稿」的 hint 呼应。

### 2. 付费状态自动轮询 + 全局队列条（前端 + 复用只读投影）

- 存在 in-flight 付费任务（reservation held / staging 未入账）时，前端
  定时（10–15s）调用现有 `loadPaidOps()`；无在途任务时停表，不空转。
- 新增常驻全局队列条组件（画布顶栏或底栏）：聚合显示 排队/生成中/
  已入账/失败 计数与逐镜头状态，点击条目跳转对应节点 detail。
- 严格只读：不新增 server 端点、不发明 UI 状态（不做 pause/cancel/skip），
  状态枚举忠实投影 coordinator/reservation 现有状态机。
- 批量付费（ADR-0046）进行中，队列条同步显示 `N/M` 进度（复用
  `node._batchMsg` 数据源）。

### 3. 上传版本化——同 slot 不再静默替换（前端 + mockup server.py）

- 动手前先起草 `docs/adr/ADR-0048-prototype-upload-versioning.md`
  （Proposed→随本任务 Accepted），记录写路径语义从「替换」变
  「追加版本」的决策与向后兼容策略。
- mockup `server.py` 的 `PUT /api/uploads/`：同 slot 再次上传写入带版本
  后缀的新文件（如 `<slot>_v<N>.<ext>`），不删除、不覆盖旧版本；保留
  现有 magic 字节/类型/大小/containment 校验。
- 画布持久化中 `node.uploads[slot]` 由字符串升级为
  `{ current, history: [MediaRef...] }`；旧格式（纯字符串）读入时视为
  v1 自动迁移，`data/<project>.json` 向后兼容，不做破坏性迁移脚本。
- UI：slot 缩略图角标显示 v<N>，点开版本选择器（缩略图列表）可回切
  当前版本；lightbox 内可浏览历史版本。
- `adopt-paid` 桥接复制的成片同样进入版本链（origin=adopted），已有
  成片槽位再 adopt 产生新版本而非拒绝/覆盖（防重复扣费护栏不变，仍在
  提交侧拦截）。

### 4. 测试

- mockup E2E：
  - 「用作视频首帧」→ video slot 显示 MediaRef 来源 → lockDraft preview
    中该镜头 first_frame sha256 与资产图一致。
  - 同 slot 上传两次 → 两个版本文件并存 → 回切 v1 → 画布持久化重载后
    current 仍为 v1。
  - 模拟 in-flight paid-op → 轮询触发 → 队列条状态从 ⏳ 变 ✓。
- 旧版 `data/<project>.json`（字符串 uploads）加载兼容性单测。
- ruff / pytest 全绿。

## 验收

- 手工路线单镜头「文本→图→视频首帧就位」全程不离开画布、无手动
  复制文件路径操作（外站生成图/视频本身仍在，属第一阶段既定形态）。
- 付费单镜头生成期间不点开 detail 也能在队列条看到状态流转直至 ✓。
- 同 slot 三次上传后 `data/uploads/<project>/` 下三个版本文件并存，
  UI 可回切；grep 确认无任何代码路径删除或覆盖既有上传文件。
- `git diff` 仅触及 `mockups/motv-workspace/` 与本任务卡/必要文档；
  codex-review-loop 过审。

## 非目标（明确排除，属 P1/P2 另行立卡）

- storyboard 横向轨道视图、▦ 面板视图实现（P1，UI 技术受 ADR 门槛）。
- seed 字段进 shot plan / packet schema（需 ADR，涉及 input_digest）。
- SSE/websocket 推送（Gateway 边界变更，需 ADR；本任务只做前端轮询）。
- 参数条（宽高比/模型可编辑化）、失败 redo 引导（P1）。
- 任何 `src/ai_video_workflow/` 核心层改动；任何真实付费调用。

## 已拍板决策（2026-08-07 用户确认）

1. **补 ADR-0048**：上传版本化的写路径语义变更（替换→追加版本）需
   留痕，实施本任务时顺带起草 ADR-0048（原型上传版本化），与
   ADR-0043～0047 的原型层决策留痕惯例一致。ADR 起草列入实施要点
   第 3 步之前。
2. **一张卡串行实施，顺序 2→1→3**：先做付费状态自动轮询+队列条
   （见效最快、纯只读），再做图→视频一键流转（引入 MediaRef），
   最后做上传版本化（动存储布局，依赖 MediaRef）。
