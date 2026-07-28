# ADR-0002: External Media Tool Boundary (ffprobe / ffmpeg)

- Status: Proposed
- Date: 2026-07-28
- Scope tasks: TASK-005 (inspection), TASK-006 (composition),
  TASK-008 (audio extension)

## Context

阶段 3 首次引入 ffprobe（媒体参数探测与可解码性检查），阶段 4
首次引入 ffmpeg（转码与拼接）。两者都是外部命令行工具依赖。
AGENTS.md 规则 8 要求核心工作流不依赖任何具体视频厂商；同一原则
应延伸到外部工具：核心校验与合成逻辑不得直接绑定 ffprobe/ffmpeg
的调用细节，否则规则引擎、报告、断点续跑逻辑都无法在没有该工具的
环境（CI、单元测试）中验证。

## Decision

1. **抽象接口**：核心逻辑只依赖两个项目内抽象：
   - `MediaInspector`（`inspection` 包）：`probe(path) ->
     MediaProbeResult`；
   - `VideoComposer`（`composition` 包）：`normalize(...)` 与
     `concatenate(...)`。
2. **生产实现**：`FfprobeMediaInspector` 与 `FfmpegVideoComposer`
   是唯一生产实现，位于各自包内的独立模块，是仓库中仅有的允许
   调用 ffprobe/ffmpeg 的位置。
3. **subprocess 纪律**：固定参数列表（list argv）、禁用 shell、
   显式超时、捕获 stdout/stderr；非零退出、超时、输出不可解析
   一律映射为类型化错误（`MediaInspectionError` /
   `CompositionToolError` 子树，根为 `AiVideoWorkflowError`）；
   工具不存在映射为 `MediaToolNotAvailableError`，错误信息包含
   安装指引。
4. **测试边界**：单元测试一律注入假实现或打桩 subprocess，不真实
   调用工具；每个引入方可提供 `skipif`（工具不可用）的真实冒烟
   测试，冒烟测试不作为回归门槛必需项。
5. **依赖声明**：ffmpeg/ffprobe 是**系统级运行时依赖**（apt 安装，
   非 Python 包），在 README 环境准备中声明；不引入 ffmpeg 的
   Python 绑定库。
6. **Provider 边界不变**：Provider 仍然禁止媒体探测（TASK-003
   D1/D4）；`MediaInspector` 只供 Workflow Orchestrator 角色的
   步骤组件（校验、合成）使用。

## Consequences

- 校验规则与合成编排可以在无 ffmpeg 环境下完整单元测试；
- 未来替换或升级媒体工具（如 gstreamer）只需新增实现类；
- 成本：多一层接口与假实现的维护；真实工具行为差异只能靠可选
  冒烟测试和实际使用发现。

## Not decided here

- 具体校验规则与容差（TASK-005 卡与实现定义）；
- 编码 profile 的取值（TASK-006 `CompositionProfile`）；
- 音频 probe 的扩展形态（TASK-008 聚焦设计定义，须保持
  `MediaInspector` 向后兼容或经独立审批扩展）。
