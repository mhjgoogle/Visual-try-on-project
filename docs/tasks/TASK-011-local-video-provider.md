# TASK-011：LocalVideoProvider（阶段 8）

> **状态：大纲（OUTLINE，Milestone 3——被产品级决策阻塞）。**
> 本地模型选型与硬件约束（WSL2 GPU 直通、显存）须用户裁决并记录
> ADR 后才能进入聚焦设计。

## 正式名称

Local Video Model Provider

## 业务目标

调用本地部署的视频生成模型实现 `VideoProvider` 接口，媒体只输出
到编排器指定的 staging 路径，上层流程零改动。

## 阻塞项（用户裁决）

1. 本地模型选型与运行方式（进程内 / 独立推理服务 / 队列）；
2. WSL2 GPU/显存资源约束确认；
3. 模型权重存放位置（不进 Git）。

## 边界合同（已可锁定的部分）

- 实现 TASK-003 契约；submit 触发本地推理，poll 报告队列/推理
  进度，媒体只写编排器提供的 staging 路径（architecture.md §5）；
- 排队、显存约束、失败重试的类型化错误与状态映射；
- 推理进程管理不得污染核心库（独立模块、显式生命周期）；
- 新增 `providers/local_<model>.py` + 测试（推理全部打桩；真实
  推理冒烟 opt-in）。

## 依赖

TASK-003/004（已交付）；TASK-005/006/007（端到端验证链路）；
用户裁决 1–3。与 TASK-010 互相独立，可并行。

## 当前状态

Outline only — blocked on user product decisions
（模型/硬件/存放）；不计入 Milestone 1–2 回归门槛
