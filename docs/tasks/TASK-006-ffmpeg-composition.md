# TASK-006：FFmpeg 按镜头顺序合成（阶段 4）

> **状态：已实现（IMPLEMENTED），并已随 [TASK-013](TASK-013-m1-findings-closure.md)
> 收口——batch milestone mode 第一阶段产物，待整体仓库 Codex 审查。**
> 完成本任务即达成第一阶段最小闭环的合成环节（product_spec 成功标准 3）。
> 整体审查提出的 path containment、恢复时间/报告身份（含 recovery E、
> FAILED manifest、concat 转义、每输入 file digest）等 blocker 已在
> TASK-013 修复（见 [ADR-0004](../adr/ADR-0004-project-root-containment-and-symlink-policy.md)、
> [ADR-0005](../adr/ADR-0005-recovery-time-and-report-identity.md)）。

## 正式名称

FFmpeg Shot Composition into Final Deliverable

## 业务目标

把校验通过并已登记的镜头视频（`VideoAsset`）按 Scene.sequence、
Shot.sequence 顺序合成为可播放的最终 MP4，输出到 `outputs/`，带
版本化与防覆盖、可断点续跑，并采集 `composition_completed` QCD
事件。

## 前置依赖

- TASK-005：`digests` 摘要工具、`qcd` 事件模块、已登记
  `VideoAsset` 的产出流程（合同依赖；`VideoAsset` 模型本身来自
  TASK-002）；
- ADR-0002（外部媒体工具抽象边界）——ffmpeg 与 ffprobe 同属该
  ADR 的抽象边界；
- ADR-0001 第二次增补（`reports/`、`staging/composition/`、
  `outputs/` 命名合同）。

## 范围内

1. `composition` 包：
   - 合成计划器：从显式传入的 `ProjectData` 派生镜头序（scene ×
     shot sequence 排序），为每个 Shot 选取**最新版本**的已登记
     `VideoAsset`；存在无资产的 Shot → 类型化错误（列出全部缺口，
     不部分合成）；
   - `VideoComposer` 抽象基类 + `FfmpegVideoComposer` 唯一生产
     实现（subprocess、固定 argv、无 shell、显式超时）；
   - 编码统一：两阶段合成——先按固定 normalization profile
     （H.264/yuv420p/AAC-或-无声、统一分辨率与帧率）把每个输入
     转码为中间文件（`staging/composition/`），再 concat 为最终
     输出；profile 由 `CompositionProfile` 冻结数据结构显式配置，
     默认取自镜头期望规格；
   - 混合规格处理：v1 要求全部 Shot 期望规格一致，不一致 → 类型化
     错误（明确列出差异），不做静默缩放（缩放策略留待后续任务）；
2. 合成步骤：StepManifest（`composition:<project-id>`）断点续跑；
   输出 `outputs/final_v<N>.mp4` 版本化、防覆盖；
3. 合成报告：`reports/composition/final_v<N>.{json,md}`（输入
   清单、每输入的 asset 版本与 digest、profile、结果）；
4. QCD `composition_completed` 事件（经 TASK-005 的 `qcd` 模块）；
5. 单元测试与集成测试。

## 范围外

- 字幕、配音、音效、混音（TASK-008）；
- 自动内容质量检查；
- CLI 入口（TASK-007 提供 `compose` 子命令接线）；
- 修改冻结包（models/providers/orchestration/serialization 注册表
  /persistence/TASK-005 交付物的既有合同）；
- 缩放、裁剪、转场等编辑能力。

## Production ownership

新增（本任务独占写入）：

- `src/ai_video_workflow/composition/__init__.py`、`profile.py`、
  `plan.py`、`composer.py`、`ffmpeg.py`、`step.py`、`intent.py`
  （CompositionPublishIntent 数据结构 + canonical/原子写 + 恢复判定）、
  `errors.py`
- 该步骤独占写入 `records/step-intents/composition/<project-id>/`
  （project-level CompositionPublishIntent；与 TASK-004
  `records/orchestration/` 的 WAL 相互独立，互不写入）
- `tests/test_composition_plan.py`、
  `tests/test_composition_ffmpeg.py`、
  `tests/test_composition_step.py`、
  `tests/test_composition_intent.py`

只读：TASK-002/003/004/005 全部交付物。

## Public API

```python
# ai_video_workflow.composition
@dataclass(frozen=True, slots=True)
class CompositionProfile:
    # 无默认值字段在前（dataclass 字段顺序约束）
    width: int
    height: int
    frame_rate: float
    video_codec: str = "libx264"
    pixel_format: str = "yuv420p"
    audio_codec: str | None = "aac"


@dataclass(frozen=True, slots=True)
class CompositionPlanEntry:
    scene_id: str
    shot_id: str
    asset_id: str
    asset_path: str
    asset_version: int
    input_digest: str


@dataclass(frozen=True, slots=True)
class CompositionPlan:
    project_id: str
    entries: tuple[CompositionPlanEntry, ...]
    profile: CompositionProfile


def build_composition_plan(
    *,
    data: ProjectData,
    profile: CompositionProfile | None = None,
) -> CompositionPlan: ...


class VideoComposer(ABC):
    @abstractmethod
    def normalize(
        self, source: Path, target: Path, profile: CompositionProfile
    ) -> None: ...
    @abstractmethod
    def concatenate(self, sources: tuple[Path, ...], target: Path) -> None: ...


class FfmpegVideoComposer(VideoComposer): ...


def run_composition_step(
    *,
    project_root: Path,
    data: ProjectData,
    composer: VideoComposer,
    profile: CompositionProfile | None,
    observed_at: datetime,
) -> CompositionStepOutcome: ...


# CompositionStepOutcome: output_path、version、manifest、report、
# emitted_event_ids、skipped(bool)


class CompositionError(AiVideoWorkflowError): ...


class MissingShotAssetError(CompositionError): ...  # 列出全部缺口


class InconsistentShotSpecError(CompositionError): ...  # 列出差异


class CompositionToolError(CompositionError): ...  # ffmpeg 失败
```

## Data contracts

- **输入**：显式传入的 `ProjectData`（含全部 VideoAsset 记录）；
  不扫描 `assets/media/`——资产文件路径来自 `VideoAsset.path`；
- **镜头序**：`(scene.sequence, shot.sequence)` 升序；同 Shot 多
  资产取最高 version；
- **输出**：`outputs/final_v<N>.mp4`，N 从 1 递增，防覆盖；
- **中间文件**：`staging/composition/v<N>/<seq>_<shot-id>.mp4`，
  保留（不自动清理，属临时媒体，Git 忽略）；
- **StepManifest**：`manifests/composition-<project-id>.json`；
  `input_digest = config_digest(有序 asset (id, version,
  file_sha256) 列表)`；`relevant_config_digest =
  config_digest({"schema": "m1-composition-config-v1", "profile":
  <CompositionProfile 全字段>})`——schema 常量的唯一 owner 为本
  任务 `composition/profile.py`；**`output_paths` 必须列出全部
  durable 输出**（§8）：① 合成媒体 `outputs/final_v<N>.mp4`；
  ② versioned 合成 JSON 报告；③ 确定性 Markdown 合成报告。
  architecture §8 的 skip/no-op **必须逐一验证 output_paths 中的每个
  文件**，不得只验证媒体或只验证 JSON；
- **QCD 事件**：`composition_completed`——payload 字段集、
  event_id 派生、单位与 None 语义以 **ADR-0003 §4.7/§5 为准**
  （output_path/output_version/output_sha256/output_duration_ms/
  input_asset_ids/entry_count/profile_digest/elapsed_ms；
  `elapsed_ms` 由调用方显式传入）；合成报告须记录
  `output_sha256`（同时是幂等 NO_OP 判定输入）。

## CompositionPublishIntent 与固定落盘顺序

合成写入多个 durable 文件，故先写一份 **CompositionPublishIntent**
（durable intent，schema/路径/规则见 ADR-0001「CompositionPublishIntent」
节）。合成是 **project-level**（一个 `outputs/final_v<N>.mp4` 覆盖全部
镜头），故 intent 按**项目**分键，**不含** task_id/shot_id/operation_id：
- 路径 `records/step-intents/composition/<project_id>/<logical_version>.json`；
- 固定字段 `schema_version(1) / project_id / logical_version /
  input_digest / profile_digest / media_path / json_report_path /
  markdown_report_path`；
- identity = `(project_id, logical_version, input_digest, profile_digest)`
  + 目标路径；同 identity replay 幂等；同 path（project_id+version）不同
  digest/路径 → conflict；
- canonical JSON + 原子写；不含当前时间与任何 task/shot/operation 身份；
  不属于最终 output_paths；不由 Provider 写；不改 TASK-004 WAL。
- 三字段（project_id/logical_version/digests）全部来自
  `run_composition_step(project_root, data, composer, profile,
  observed_at)` 的 `ProjectData`，公开签名无需 task/shot/operation
  输入。

TASK-006 的**固定落盘顺序（10 步）**：

1. 确定 logical version 与全部目标路径（media / json / markdown）；
2. 写 CompositionPublishIntent；
3. compose 到 same-directory 临时 media；
4. inspect / hash 临时 media；
5. 原子 no-replace 发布最终 MP4；
6. 基于**最终 MP4 的实际 hash/metadata** 写 JSON report；
7. 写确定性 Markdown report；
8. append 确定性 QCD 事件；
9. commit StepManifest；
10. best-effort 删除 intent。

**intent-based 恢复矩阵（A–F）**：

- **A. matching intent + 最终 MP4 存在 + report 缺失**：inspect/hash
  最终 MP4 → 生成缺失的 JSON/Markdown → 继续 QCD/manifest；**不重
  compose、不选新版本**；
- **B. matching intent + 最终 MP4 不存在**：可重新 compose 到**同一**
  logical version；**不自动递增版本**；
- **C. 最终 MP4 存在但无 matching intent 且 manifest 未完成**：
  conflict——不采用、不覆盖、不生成新版本；
- **D. intent 的 identity/digest/path 不匹配**：conflict；
- **E. manifest 已完成但 intent 残留**：最终 outputs 验证通过后
  best-effort 清理 intent；清理失败仅 diagnostic；
- **F. report 存在但 media 缺失**：conflict——report 不作为完成证据。

## Failure / recovery semantics

- 落盘顺序遵循上「10 步」；
- 幂等重跑（NO_OP 精确条件，全部满足才跳过）：
  1. manifest COMPLETED；
  2. `input_digest` 与 `relevant_config_digest` 均匹配；
  3. `output_paths` 中全部文件存在且为常规文件；
  4. 最终 MP4 重新计算的 `file_sha256` 与合成报告记录的
     `output_sha256` **一致**（必检——仅路径存在不足以跳过）；
  5. 合成报告 JSON 可加载且版本一致。
  可选注入 `MediaInspector` 对最终文件 probe 属额外诊断，不参与
  跳过判定。
- **多文件部分提交恢复（§9 十条规则，与 ADR-0001 第二次增补、
  TASK-005、TASK-007/总报告统一）**：
  1. 逻辑 version 由 operation / input digest（有序 asset id+version
     +sha256）与 profile digest 决定；
  2. 同一 input/profile 的重跑继续使用同一目标 version；
  3. 已发布的最终 MP4 存在且其 `file_sha256` 与合成报告
     `output_sha256` 一致 → 复用，不重合成；
  4. 最终 MP4 已发布但 QCD 事件 / manifest 尚未提交 → 补齐缺失的
     QCD/manifest，不重合成；
  5. QCD 使用确定性 event_id（`composition_completed:<project>:v<N>`），
     允许等价重复行；
  6. manifest 写入幂等；
  7. 已存在同版本输出内容与预期不匹配 → 正式 conflict，不覆盖、不
     跳到新 version；
  8. 新 version（v(N+1)）**只**用于：新 input digest（资产集合/版本
     变化）、新 CompositionProfile、或显式 redo；
  9. 中间文件清理失败不回滚 durable success；
  10. no-replace 发布始终有效。
- 转码/concat 中途失败：manifest FAILED（error_summary 含 ffmpeg
  stderr 摘要），中间文件保留供检查，重跑从头重建该版本的中间文件
  （不做部分转码复用——v1 简化，记录为已知成本；已发布的最终 MP4
  按规则 3 复用）；
- ffmpeg 不可用：`MediaToolNotAvailableError` 语义对齐 ADR-0002。

## Security boundaries

- 路径 containment 与 symlink 校验同 TASK-005；
- ffmpeg 以固定参数列表 subprocess 调用，禁用 shell，显式超时；
  输入路径全部来自已登记记录，不接受任意外部路径；
- 生成媒体不进 Git（.gitignore 既有规则覆盖 outputs/staging）；
- 无网络、无凭据。

## Focused tests

1. 计划器：排序正确性、最新版本选取、缺资产/规格不一致的类型化
   错误（含完整缺口清单断言）；
2. profile 与 manifest digest 的确定性、差异敏感性；
3. 假 composer 注入下的步骤编排：落盘顺序、版本递增、防覆盖、
   幂等 no-op、FAILED 现场保留；
4. `FfmpegVideoComposer`：argv 构造（subprocess 打桩）、非零退出
   /超时 → 类型化错误、stderr 摘要截断；
5. QCD 事件载荷与 event_id。

## Integration tests

1. 假 composer 端到端：示例项目 + 两个已登记 asset → final_v1.mp4
   （由假 composer 产出占位字节）+ 报告 + 事件 + COMPLETED
   manifest；重跑 no-op；替换 asset 版本 → final_v2；
2. 可选真实 ffmpeg 冒烟测试（最小 fixture 视频 2 段合成，
   ffprobe 验证时长），skipif ffmpeg 不可用，不作为回归门槛必需。

## 验收标准

1. 按镜头顺序合成，顺序与资产选取规则有测试；
2. ffmpeg 经 `VideoComposer` 抽象接入，核心逻辑零 ffmpeg 直接
   依赖；
3. 编码统一经显式 profile，两阶段合成实现且规格不一致被类型化
   拒绝；
4. 输出版本化、防覆盖、断点续跑幂等，全部有测试；
5. `composition_completed` 事件落盘有测试；
6. 未越界（无字幕/音频混音、未修改冻结包）；
7. 全部测试通过、Ruff format/lint 全绿、`git diff` 范围检查通过。

## 实施 Agent / 审查 Agent

- 实施 Agent：Claude Code。
- 审查方式：batch milestone mode——设计随整体报告一次审查；实施
  审查合并到 Milestone 1 回归门槛。

## 当前状态

implemented (M1 batch, branch `feat/m1-minimal-loop`) — profile/plan,
VideoComposer + ffmpeg adapter, project-level CompositionPublishIntent,
and the resumable composition step (10-step order + recovery matrix
A–F) delivered across 4 commits; focused + core regression green.
Milestone-1 regression gate runs after TASK-007 (whole-repository Codex
review pending).
