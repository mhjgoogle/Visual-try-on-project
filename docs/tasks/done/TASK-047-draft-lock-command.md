# TASK-047: lock-draft-plan 命令与图↔视频一致性打通

> **状态：Done（2026-08-07 实施完成）。** `lock-draft-plan` 命令
> （`src/ai_video_workflow/app/lock_gateway.py`）+ offline 单测 28 个 +
> mockup E2E 3 个 + mockup server/前端接线全部落地；ruff/pytest 全绿
> （2694 passed）。codex-review-loop 过审（2 轮，VERDICT: pass；codex 不可
> 用，回退独立 claude 会话审查——独立性降级，见 `.claude/tmp/last-review.md`）。
> 真实付费首帧验证（可选 $0.28）未执行，留待用户显式授权时进行。

- Status: Done
- Owner: 单实施 Agent（新会话）
- 依据: ADR-0047（Accepted）、ADR-0033/0041/0042/0045/0046
- 前置: 无（planning first_frame_image 链路已存在；ADR-0041 命令为范式）

## 目标

画布分镜草稿（含每镜头资产设定图）可经 Gateway 一键锁定为正式
plan/records/packet 新版本；此后付费视频生成的提示词=草稿描述、
首帧=资产图，图↔文↔视频一致。

## 实施要点

1. `src/ai_video_workflow/app/`（参照 paid_gateway.py 范式）新增
   `lock_gateway.py`：`register_lock_draft_command(registry, ...)`，
   CommandSpec `lock-draft-plan`（HIGH，preview/apply，幂等回执，
   TargetResolver 绑定项目 plan 当前版本防并发漂移）。
   - 参数校验：shots 1–20（title≤80 / description≤500 / duration∈{6,10}）、
     可选 first_frame_image data URL（`data:image/`、原图≤5.5MB，复用
     provider `_validate_first_frame_image` 的形状约束）。
   - apply：publish_story/brief/prompt（含 first_frame_image）/shot_plan、
     写 shot records、`compile_task_packets` → 新 packet_version；全部
     版本化发布，不覆盖旧版。
   - preview：完整展示将写入的镜头表与将产生的 packet_version。
2. mockup `server.py`：注册该命令（与 paid 命令同 registry；写端点已存在），
   非 paid 模式亦可注册（不花钱）——但保持 Origin/CSRF 守卫。
3. mockup 前端：分镜节点（画布+放大视窗）「锁定为正式分镜」按钮 →
   preview 模态（列出全部镜头与首帧有无）→ 确认 → 提交；成功后
   scriptgen 徽标从「未锁定」变「已锁定 v<packet_version>」，视频节点
   付费路提示"提示词/首帧来自你的草稿"。首帧图取资产槽位文件转 data URL
   （>5.5MB 明确报错"请压缩后重传"）。
4. 测试：offline 单测（命令校验/幂等/版本化/preview-apply digest 一致；
   FakeRegistry 风格照 test_paid_gateway_command.py）；mockup E2E
   （锁定→packet 含 first_frame→ generation-target params 指向新版本）。

## 验收

- 新会话中：锁定草稿 → `records/shots/*` 与 packet 新版本内容=草稿；
  packet 含 first_frame_image；付费单镜头预检显示新 packet_version；
  （可选一次真实 $0.28）生成视频首帧与资产图一致。
- ruff/pytest 全绿；codex-review-loop 过审；仅 `src/ai_video_workflow/app/`
  新文件 + tests + mockups 变更，不动冻结合同。

## 非目标

- 不改预算/审批/Provider；不做多 packet 并行编辑；不做图片压缩（超限报错）。
