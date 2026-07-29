# ADR-0004: 项目根 Containment 与 Symlink 安全策略

- Status: Accepted
- Date: 2026-07-29
- Accepted: 2026-07-29 — M1 findings-closure（TASK-013）收口时定稿。
- Scope tasks: TASK-005、TASK-006、TASK-007（全部 durable 读写与外部工具路径）

## Context

M1 整体审查（Codex）复现确认：QCD 日志写入、资产/报告/媒体发布、
合成输入与输出、以及 driver 对 staged 文件的检查，都没有统一执行
「目标必须落在项目根之内、且路径中不得存在指向外部的 symlink」的
约束。审查在项目根之外真实写出了 `qcd/events/log.jsonl` 与正式媒体
文件——即：若项目根下的某个子目录（如 `qcd/`、`assets/`）是一个指向
外部的目录 symlink，「写在项目根内」的相对路径会被静默地写到项目根
之外。这违反 AGENTS.md §13（禁止静默覆盖用户文件）与 architecture
的文件边界约束。

各处此前各自实现了零散的检查：`assets/validation.py` 的 `PATH_ALLOWED`
对 **staged 路径** 做了 `resolve()` + containment 判定，但所有 durable
**写入路径** 都是用字符串拼接 `project_root / rel` 后直接写，没有经过
任何 containment/symlink 校验。缺少一个统一、复用的解析器。

## Decision

1. **单一解析器**：新增 `ai_video_workflow/security/paths.py`，提供
   `resolve_within_root(project_root, relative) -> Path`。所有 durable
   读写路径与所有交给 ffprobe/ffmpeg 的输入/输出路径，都必须先经过
   它构造，不得再直接 `project_root / rel`。
2. **拒绝规则**（任一命中即抛 `PathEscapeError`，`PathEscapeError`
   继承 `AiVideoWorkflowError`）：
   - `relative` 为绝对路径；
   - `relative` 的任一路径分量为 `..`；
   - 从项目根向下，`relative` 的任一 **已存在** 分量是 symlink
     （逐分量 `is_symlink()` 检查；尚不存在的分量不算违规，允许后续
     创建真实目录/文件）；
   - 解析后（`Path.resolve()`）的目标不等于、也不在已解析项目根之下。
3. **返回值语义**：解析器返回「未解析的」`project_root / relative`
   连接路径（校验通过后），使调用方现有的 `.parent.mkdir(...)`、
   原子发布等逻辑保持不变；校验只做准入，不改变写入位置。
4. **不检查项目根自身的祖先**：项目根可能位于一个 symlink 之下
   （如 `/tmp` 在部分系统上是 symlink），这不构成逃逸；只对项目根
   **之内** 的分量做 symlink 检查，两侧均以 `resolve()` 结果比较
   containment。
5. **ffmpeg concat 列表安全**：concat demuxer 的清单文件按行解析、
   以单引号包裹路径。写入每个条目时必须把路径中的 `'` 转义为
   `'\''`，并拒绝包含换行符的路径（换行会破坏逐行解析，且不可能是
   合法的项目内媒体路径）。

## Consequences

- 一个跨模块可复用的准入点，消除了「写在根内其实写到根外」这一类
  静默逃逸；覆盖 QCD 日志、资产/报告/媒体、合成输入输出、intent、
  staged 文件检查与合成清单。
- 校验为纯路径与 `lstat` 级别操作，开销可忽略。
- 现有 `PATH_ALLOWED` staged 校验保留（它是校验步骤的一个具体检查
  项，面向报告可读性）；本 ADR 的解析器是所有 **写入** 侧的统一准入。
- 成本：所有 durable 写入点都要改为经解析器构造路径；一次性改动。
