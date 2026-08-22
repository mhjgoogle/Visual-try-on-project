# ADR-0047: 草稿锁定命令——画布分镜（含首帧资产图）转正式 packet

- Status: Accepted
- Date: 2026-08-07
- 关联: ADR-0033（Command Gateway）、ADR-0041（付费视频 packet-only 流）、
  ADR-0042（分镜草稿域）、ADR-0045/0046（付费图片/批量）、
  工作层级输入输出合同（"Agent 起草，用户确认" Gate）

## 背景

当前付费视频与用户创作内容脱节：付费管道严格 packet-only（正确），但画布
上的 Claude/手工分镜草稿与资产设定图**没有任何通道**成为正式 packet——
证据项目的 packet 是预置文本，也未设置首帧图。探查确认 planning 层已原生
支持 `first_frame_image`（prompt 文档 → `packet_to_paid_request` → provider
`_validate_first_frame_image`），缺的只是"草稿→锁定"的受治理写命令。

## 决策

1. **新增 Gateway 写命令 `lock-draft-plan`**（HIGH-risk，preview/apply，
   幂等回执），经既有 Command Gateway 端点暴露给 motv 原型：
   - 输入：草稿镜头列表（1–20 个；title ≤80、description ≤500、
     duration ∈ {6,10}）＋每镜头可选 `first_frame_image`（data URL，
     ≤5.5MB 原图以保证 base64 后不超 provider 8MB 上限）＋项目引用。
   - 行为：复用既有 planning API（publish_story/brief/prompt/shot_plan、
     写 shot records、`compile_task_packets`）发布**新版本**计划与 packet；
     不删除旧版本；人工 Gate 由 preview→确认承担（"Agent 起草，用户确认"）。
   - 锁定后 `submit-video-generation` 生成的提示词与首帧图即来自用户草稿，
     图↔文↔视频一致。
2. **边界**：命令只写本项目 planning/records 的版本化文件；不触碰预算/
   审批既有语义；付费仍走 ADR-0041/0046 的既有确认链。原型 UI 在分镜节点
   提供「锁定为正式分镜」按钮（preview 展示将写入的完整内容）。
3. **fail-closed**：校验失败/审批阶段不允许/packet 编译失败 → 拒绝并报原因；
   绝不部分写入（按 planning API 的原子发布语义）。

## 后果

- "草稿转正"打通，付费自动生成与用户创作内容对齐（含首帧图生视频）；
- 新命令是核心 `src/` 变更（命令注册＋测试），按 TASK-047 实施；
- 首帧图走 data URL 内联，超限图片需先压缩（UI 明确报错提示）。
