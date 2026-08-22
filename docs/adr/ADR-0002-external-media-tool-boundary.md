# ADR-0002: External Media Tool Boundary (ffprobe / ffmpeg)

- Status: Accepted
- Date: 2026-07-28
- Accepted: 2026-07-28 — M1 gate 收口时定稿（本次修订补充
  path/symlink 交叉引用与 optional real-tool test 的精确边界）。
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
2. **生产实现（real runner）**：`FfprobeMediaInspector` 与
   `FfmpegVideoComposer` 是唯一生产实现，位于各自包内的独立
   模块，是仓库中仅有的允许调用 ffprobe/ffmpeg 的位置。
3. **subprocess 纪律**：固定参数列表（list argv）、禁用 shell、
   显式超时、捕获 stdout/stderr；非零退出、超时、输出不可解析
   一律映射为类型化错误（`MediaInspectionError` /
   `CompositionToolError` 子树，根为 `AiVideoWorkflowError`）；
   工具不存在映射为 `MediaToolNotAvailableError`，错误信息包含
   安装指引。
4. **测试边界（fake runner vs real runner）**：
   - 单元/集成回归测试一律注入**假实现**（fake
     `MediaInspector` / fake `VideoComposer`）或打桩 subprocess，
     不真实调用工具；fake 实现是 CI 回归门槛的唯一媒体后端；
   - **optional real-tool smoke tests**：每个引入方可提供真实
     工具冒烟测试；TASK-007 另拥有一个**真实 CLI 一条命令冒烟
     测试**（完整命令序列真实跑通，不做脆弱的编码字节等价断言）。
     全部真实冒烟测试必须同时满足：`pytest.mark.skipif`
     （ffmpeg/ffprobe 不可用即跳过）+ 显式环境开关
     （`AI_VIDEO_WORKFLOW_REAL_TOOLS=1` 才启用）+ 最小受控媒体
     fixture；**不属于默认 CI 回归门槛**；
   - CI 不要求安装真实 FFmpeg/ffprobe；真实工具手工执行流程保留
     在 README。
5. **依赖声明**：ffmpeg/ffprobe 是**系统级运行时依赖**（apt 安装，
   非 Python 包），在 README 环境准备中声明；不引入 ffmpeg 的
   Python 绑定库。
6. **Provider 边界不变**：Provider 仍然禁止媒体探测（TASK-003
   D1/D4）；`MediaInspector` 只供 Workflow Orchestrator 角色的
   步骤组件（校验、合成）使用。
7. **path/symlink 安全（交叉引用）**：传给 ffprobe/ffmpeg 的全部
   输入与输出路径必须先通过项目根 containment 与 symlink 校验
   （拒绝 `..`、绝对路径替换、symlink 逃逸），安全规则以
   ADR-0001（TASK-004 增补的路径安全原则）与 TASK-005/006 卡的
   Security boundaries 节为准；本 ADR 不另行定义路径安全语义。

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
