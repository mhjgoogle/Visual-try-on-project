# WFM2 正式作品验收 Runbook（TASK-037）

离线、零花费的 WFM2 里程碑用户验收步骤。全程不接任何付费/TTS API。里程碑 PASS
由用户勾选（§5），实施 Agent 不代判。

## 1. 前置

- 已激活项目 venv；`ruff`、`pytest` 可用。
- 可选真实工具冒烟需 `ffmpeg`+`ffprobe` 且 `AI_VIDEO_WORKFLOW_REAL_TOOLS=1`。

## 2. 自动化证据（离线，零花费）

```bash
# 全量套件 + 静态检查
ruff format --check src tests
ruff check src tests
python -m pytest -q

# WFM2 端到端验收（L0→S7 组合）
python -m pytest tests/test_wfm2_e2e_acceptance.py -q

# 各层合同/单元
python -m pytest tests/test_postproduction_index.py tests/test_av_step.py \
  tests/test_av_mux_argv.py tests/test_audio_registration.py \
  tests/test_audio_inspect.py tests/test_subtitle_validation.py \
  tests/test_media.py tests/test_creative_index.py -q
```

## 3. 可选：真实 ffmpeg 音画冒烟

```bash
AI_VIDEO_WORKFLOW_REAL_TOOLS=1 python -m pytest tests/test_av_ffmpeg_smoke.py -q
```

## 4. 验收标准 → 证据映射

| 验收标准（TASK-037） | 证据 |
|---|---|
| S4–S7 正式音画组合通过（L0–S3 见 TASK-034） | `test_wfm2_s4_to_s7_pipeline_on_creative_baseline`（creative 基线→media→AV mux→S5–S7） |
| I/O baseline 每行映射到实现和 E2E 证据 | [追踪矩阵](wfm2-acceptance-traceability.md) §2 |
| 无阻断 QC，四类 QC 域分离 | E2E `qc_domains` 四异；`release_result` 须绑全部四类 QC |
| 模型表现/返工/观众数据缺失状态/复用候选已记录 | E2E S7 链：scorecard/postmortem/performance(unavailable)/reuse/knowledge(not_applicable) |
| 多媒体数据满足 Workspace source readiness | 全部产物为 digest 绑定、可 load 重解析的权威文件 |
| 缺失≠零、人工 Gate 保留 | E2E `unavailable`/`not_applicable`+依据；human_gate 步骤保留 |
| 无孤儿谱系，历史/未选候选保留 | E2E 全产物 load 重解析通过；index create-only 版本化 |
| 未接付费 API | 全离线打桩；真实 ffmpeg 仅 skipif |

## 5. 用户签字栏（里程碑 PASS 属用户）

> 以下由用户填写。实施 Agent 已备齐全部证据，不代判 PASS。

- [ ] 已运行 §2 自动化证据并通过（全量 pytest + ruff）。
- [ ] 已审阅 [追踪矩阵](wfm2-acceptance-traceability.md) 与 §4 标准映射。
- [ ] 认可 [追踪矩阵 §4 已知限制](wfm2-acceptance-traceability.md)（合同层交付、
      自算 digest、无付费 API、M1 链复用）。
- [ ] **WFM2 里程碑：PASS / 需返工（圈选）**，签字：________ 日期：________
