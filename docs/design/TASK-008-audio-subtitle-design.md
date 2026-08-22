# TASK-008 Focused Design — Subtitles, Voice-over, Audio (M2)

- 日期：2026-07-30
- 状态：聚焦设计定案（用户已批准 3 项产品假设「全按推荐」+ 批准
  models.py/serialization.py 冻结文件的模型增补）。
- 产品假设（已裁决，推荐落地）：配音=用户提供音频文件（不接 TTS）；
  字幕=手工 SRT + 可选从 Shot 描述生成骨架；字幕形态=默认软字幕
  `mov_text`，`--burn-in` 显式烧录。
- 依赖：TASK-006（VideoComposer + 合成步骤）、TASK-005（qcd/
  MediaInspector/digests）、ADR-0002、ADR-0003、ADR-0001（第三次
  增补，见本设计）。

## 1. 数据模型增补（冻结文件，已批准）

### 1.1 `models.py` 新增两模型（frozen, slots，__post_init__ 校验）

```python
@dataclass(frozen=True, slots=True)
class AudioAsset:
    asset_id: str  # "asset-audio-<scope>-v<n>"（scope=shot_id 或 project_id）
    shot_id: str | None  # shot 级或 project 级（None=项目级）
    source_ref: str  # 用户提供音频的 staging 逻辑引用（项目根相对）
    path: Path  # assets/audio/<...>.<ext>
    container_format: str  # 如 "wav" | "m4a" | "mp3"
    duration_seconds: float
    sample_rate: int
    channels: int
    codec: str  # 如 "aac" | "pcm_s16le"
    version: int
    validated_at: datetime


@dataclass(frozen=True, slots=True)
class SubtitleAsset:
    asset_id: str  # "asset-subtitle-<scope>-v<n>"
    shot_id: str | None
    source_ref: str
    path: Path  # assets/subtitles/<...>.srt
    subtitle_format: str  # M1/M2 固定 "srt"
    entry_count: int  # 解析出的字幕条目数
    language: str | None  # BCP-47 或 None
    version: int
    validated_at: datetime
```

`__post_init__` 校验对齐 VideoAsset：非空 stable-id、非负/正整数域、
UTC datetime、路径为项目根相对 POSIX（复用既有校验 helper）。

### 1.2 `serialization.py` 注册表扩两条目（additive）

- 新增 `_audio_asset_to_dict` / `_audio_asset_from_dict`、
  `_subtitle_asset_to_dict` / `_subtitle_asset_from_dict`；
- 更新四处 dispatch：`model_to_dict`（type 分派）、`model_from_dict`、
  `_supported_model_name` 的 supported 集合、以及模型 union 类型注解；
- **既有七模型序列化合同零改动**（TASK-002 锁定）；本次为纯新增。
- 冻结文件测试维护例外（授权）：`tests/test_serialization.py`、
  `tests/test_models.py` 的 supported-model / round-trip 锁定测试
  更新为九模型；不改既有七模型断言语义。

### 1.3 ADR-0001 第三次增补（目录合同）

- `records/audio-assets/<asset-id>.json`、
  `records/subtitle-assets/<asset-id>.json`；
- 正式媒体 `assets/audio/<...>`、`assets/subtitles/<...>`；
- 用户提供的音频/SRT 输入 staging 合同（`staging/audio/<...>`、
  `staging/subtitles/<...>`，由调用方显式放置）；
- 防覆盖、版本化，语义同 VideoAsset。

## 2. 新增/扩展包（非冻结）

- `src/ai_video_workflow/audio/`：
  - `validation.py`：SRT 结构校验（时间轴单调、序号、条目计数）+
    音频 probe（复用 `MediaInspector` 的音频维度扩展，向后兼容——
    若须扩展 `MediaProbeResult` 走 ADR-0002 独立评审，本设计**优先
    不改** MediaProbeResult，改为新增 `AudioProbeResult` + 一个
    `AudioMediaInspector` 协议以保持 TASK-005 合同冻结）；
  - `registration.py`：`register_audio_asset(...)` /
    `register_subtitle_asset(...)`（版本化、防覆盖、幂等，复用
    TASK-002 原子发布）；
  - `step.py`：音频/字幕校验+登记步骤（StepManifest 断点续跑，
    发射 `asset_imported`/`validation_completed`，payload 用
    `asset_kind` 区分——ADR-0003 §4.4 的 `asset_kind` 值域须在
    ADR-0003 追加 `"audio"`/`"subtitle"`，走 ADR-0003 修订）。
- `composition/` 内新增（不改既有文件公开合同）：
  - `mix.py`：混音（配音轨 + 音效轨 + 原视频音轨的显式增益）；
  - `subtitles.py`：软字幕挂载（`mov_text`）/ 烧录（`--burn-in`）；
  - `CompositionProfile` 扩字段 `audio_mix: AudioMixSpec | None`、
    `subtitles: SubtitleSpec | None`（默认 None → 行为与 TASK-006
    完全一致，回归保护）；`run_composition_step` 签名不变。

## 3. QCD / ADR-0003 追加

- `asset_kind` 值域追加 `"audio"`、`"subtitle"`（ADR-0003 §4.4
  修订）；事件复用既有类型（asset_imported / validation_completed /
  composition_completed），payload 以 `asset_kind` 区分资产种类；
  不新增事件类型（若设计发现必须新增，走 ADR-0003 修订）。

## 4. 失败/恢复/安全

与 TASK-005/006 同一模式：原子发布、防覆盖、版本化、manifest 五
条件跳过、路径 containment + symlink 拒绝、subprocess 固定 argv /
无 shell / 显式超时；无付费 API、无 TTS、无音频内容质量分析。

## 5. 测试与验收

- 焦点：AudioAsset/SubtitleAsset 模型 + serialization round-trip；
  SRT 校验规则；音频 probe；登记版本化/防覆盖/幂等；混音 + 字幕
  argv 构造（打桩）；profile digest 变化触发新版本；软字幕 vs
  `--burn-in`；
- 集成：假 composer 端到端（视频+配音+SRT → final_v2）、真实 ffmpeg
  冒烟（skipif + 环境开关）；
- 回归保护：TASK-006 端到端在 `audio_mix=None, subtitles=None` 下
  逐字节不变（默认路径无行为改变）；
- 验收：字幕/配音/音效可经一条命令混入成片；模型增补经独立审批
  （本设计 = 审批记录）；未接付费 API；全部测试与静态检查通过。

## 6. 实施顺序（预计 5–6 commits）

1. models.py + serialization.py 两模型 + 冻结测试更新 + ADR-0001
   第三次增补 + ADR-0003 asset_kind 追加；
2. audio 包：validation + registration；
3. audio 包：step（校验+登记+事件）；
4. composition 扩展：mix + subtitles + profile 扩字段；
5. 集成测试 + CLI 接线（`compose` 透传 profile 扩展）+ 文档状态。
