# WFM1 示例项目：One Fare（一次车费）

一个角色、一个场景、一个地点、8 镜头、约 48 秒的完整 WFM1 示例
（TASK-023 验收夹具）。仓库中只含 JSON 输入，不含媒体文件和任何凭据。

- 预算（`config/wfm1.json`）：单集 soft 1200 / hard 1500，月度 5000，
  单镜头 400 JPY；FX 锁定 1 USD = 160 JPY。
- 供应商目录：仓库自带 `config/providers/wfm1-default.json`
  （digest 已锁进 config；目录中的 `cloud-a`/`cloud-b` 是示例价目，
  不是真实厂商 endpoint）。
- 复用资产：`examples/reuse/character-mia/v1.json`
  （版本 + 内容 digest 锁定，见 `profile/reuse_refs.json`）。

## 离线端到端验收（默认，不产生任何费用）

真实 CLI/协调链 + Fake Provider 的完整验收（含故障恢复矩阵、双项目
复用/月度预算证据、只读 projection 重建）：

```bash
source .venv/bin/activate
python -m pytest tests/test_wfm1_e2e.py -q
```

## 手工走一遍本示例（只到任务包编译，不付费）

先把示例复制到工作目录（示例本身是只读夹具，不要在原地生成产物）：

```bash
cp -r examples/projects/wfm1-demo /tmp/demo
mkdir -p /tmp/reuse-account
cp -r examples/reuse /tmp/reuse-account/reuse  # 账户级复用资产（加载器查找 <account>/reuse/）
P="--project-root /tmp/demo --catalog-dir config/providers"
python -m ai_video_workflow.cli $P stage-review  concept_lock    --by you
python -m ai_video_workflow.cli $P stage-approve concept_lock    --by you --target planning/brief_v1.json
python -m ai_video_workflow.cli $P stage-review  screenplay_lock --by you
python -m ai_video_workflow.cli $P stage-approve screenplay_lock --by you --target planning/story_v1.json
python -m ai_video_workflow.cli $P stage-review  av_design_lock  --by you
python -m ai_video_workflow.cli $P stage-approve av_design_lock  --by you --target planning/prompts/p-mia-night/v1.json
python -m ai_video_workflow.cli $P stage-review  production_lock --by you
python -m ai_video_workflow.cli $P stage-approve production_lock --by you --target planning/shot_plan_v1.json
python -m ai_video_workflow.cli $P init-tasks
python -m ai_video_workflow.cli $P plan-compile --account-root /tmp/reuse-account
# 预期：packets: 8; episode p50=128 p90=256 JPY（远低于 1200 上限）
```

之后的 `paid-submit --packet-version <N> → paid-integrate → compose →
qc-run → qc-review → package-release → archive-project` 需要一个已注册的
Provider。WFM1 的付费入口只接受已编译且校验通过的任务包
（`--packet-version`），自由参数路径需显式 `--unplanned`，不属于 WFM1 流程。
离线验收里由 Fake Provider 走通（见上面的 E2E 测试），真实付费见下节。

## 可选：真实 MiniMax 冒烟（会实际扣费，默认关闭）

冒烟测试**绕过 catalog、审批链和预算协调器**，只验证传输层，因此每一步都
必须人工确认：

1. **预算**：冒烟实际提交的是 **`MiniMax-Hailuo-02` / `768P` / 6s**
   （该模型 T2V 不支持 512P，见 ADR-0009）。请按官网当前价格人工核对
   **这一 SKU** 的单条费用可接受；使用专用低余额 API Key，用完即弃。
2. **凭据**：Key 只放环境变量，绝不写入仓库或示例文件：
   `export WFM1_MINIMAX_API_KEY=$(cat ~/.wfm1-smoke/api-key)`
3. **记录目录**（外部任务 ID 会持久化，崩溃不丢单）：
   `export WFM1_SMOKE_DIR=~/.wfm1-smoke`
4. **单测显式 opt-in，跑完立即 unset**：

```bash
AI_VIDEO_WORKFLOW_REAL_MINIMAX=1 python -m pytest \
  tests/test_minimax_real_transport.py::test_real_minimax_smoke -q
unset AI_VIDEO_WORKFLOW_REAL_MINIMAX WFM1_MINIMAX_API_KEY
```

真实付费 API 不是 CI 或 WFM1 验收的必要条件。

## WFM1 范围外（明确 unavailable，不伪造）

图片资产、音频、字幕、发布平台、自动路由、Creation Workspace/UI。
