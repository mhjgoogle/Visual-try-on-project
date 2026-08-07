# ADR-0044: motv 原型的本地 FFmpeg 真实成片合成

- Status: Accepted
- Date: 2026-08-07
- 关联: ADR-0042/0043（草稿域 agent/TTS 模式）、ADR-0010/0030（Workspace 边界）、
  原 M1（核心 FFmpeg 合成能力——本决策不复用其内部实现、不触碰核心文件）

## 背景

motv 原型已具备全免费素材流（分镜草稿 → 手工/自动图片、视频、配音上传到
`data/uploads/` 原型 scratch）。缺最后一步：把这些草稿素材真实合成为 MP4。
核心 M1 的 FFmpeg 合成服务于正式项目目录结构，原型素材是画布本地 scratch，
两者输入形态不同。

## 决策

1. mockup 后端新增 `POST /api/agent/compose`：接收当前草稿的镜头槽位清单
   （video 槽必备、voice 槽可选、music 槽可选），在 `data/uploads/<project>/`
   内用本地 `ffmpeg`（argv 数组、无 shell、限时）逐镜头标准化（720p/25fps/AAC，
   配音与画面对齐）→ concat 合成 → 可选背景音乐低音量混入 → 输出
   `final-cut-v<N>.mp4`（**版本自增，绝不覆盖旧成片**），返回其 URL。
2. **原型 scratch 域**：输入输出都只在 `data/uploads/`（gitignored）内；
   不读写任何核心 `<project>/` 文件、不经 Provider、零费用。正式 S5 合成
   仍由核心 M1 管辖。
3. **fail-closed**：`ffmpeg` 缺失 → 503 给安装指引；槽位文件缺失/非法 → 400；
   合成失败/超时 → 5xx，附失败镜头信息；绝不伪造成功。
4. `ffmpeg` 以静态构建放入项目 venv `bin/`（不需 root、不污染系统），或使用
   系统安装，二者等价（`shutil.which` 发现）。

## 后果

- 原型达成"灵感 → 真实 MP4"全免费闭环；
- 合成为同步请求（8×6s 镜头约数十秒，线程化服务器不阻塞其它请求）；
- 分辨率/码率为草稿级预设（720p），正式成片质量参数属核心 M1/后续 ADR。
