# ADR-0043: 本地 Piper TTS 作为原型草稿配音的免费自动路线

- Status: Accepted
- Date: 2026-08-07
- 关联: ADR-0042（创意 Agent CLI 集成——本决策沿用其"草稿域、fail-closed、
  原型本地"模式）、ADR-0010/0030（Workspace 边界）、ADR-0038（Proposed，
  核心多媒体 Provider 合同，本决策不触碰）

## 背景

motv 原型（非生产 UX mockup）已具备全免费手工媒体流：分镜每镜头可复制文案
→ 用户在外部工具生成配音 → 上传。用户要求为配音补一条**免费的自动路线**。
Piper 是开源本地 TTS（CPU 可跑、离线、零 Provider 费、无按量计费），适合
作为草稿配音的自动生成器。

## 决策

1. motv mockup 后端新增 `POST /api/agent/tts`：接收 `{project, slug, text}`，
   调用本地 `piper` 可执行文件（argv 数组、无 shell、限时、限输入长度）将
   文本合成为 WAV，写入 `data/uploads/<project>/<slug>.wav`（与手工上传同一
   原型 scratch 存储，gitignored），返回其 URL。
2. **草稿域约束**（与 ADR-0042 同）：产物是未锁定草稿素材，不写任何核心
   `<project>/` 文件、不触碰 Provider 抽象、不产生任何费用；界面明确标注
   来源与未锁定状态。
3. **fail-closed**：`piper` 或语音模型缺失 → 503 并给出安装指引；文本超限
   （2000 字符）→ 400；合成失败/超时 → 5xx 报错，绝不伪造成功。
4. 语音模型存放于 `mockups/motv-workspace/data/tts/`（gitignored，本地下载，
   不入库）；Python 依赖 `piper-tts` 安装进项目 venv。
5. 本决策**只覆盖 motv 原型**。核心工作流的正式音频 Provider（含本地 TTS
   与任何付费 TTS）仍由 ADR-0038 合同族约束，Accepted 前不得实现。

## 后果

- 配音步骤获得"手工上传 + 本地自动"双路线，全程零费用；
- 新增本地依赖（piper-tts + onnx 语音模型 ~60MB），仅影响原型可选功能，
  缺失时手工路线不受影响；
- 音质为开源 TTS 水平，正式成片如需更高质量再按 ADR-0038 走付费 Provider。
