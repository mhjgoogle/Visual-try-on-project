# TASK-064：创作者 IA 收口与自动初版剧集制作

- 状态：进行中
- 负责 Agent：Claude Code（单一实施 Agent）
- 依据：[ADR-0061](../adr/ADR-0061-creator-ia-and-automated-episode-production.md)
- 前置：TASK-062 / ADR-0059 已完成（生产图身份合同贯通，Codex `VERDICT: pass`）

> **编号说明**：产品负责人下发时称「TASK-063」。仓库中 `TASK-063` 已被
> [ADR-0060](../adr/ADR-0060-risk-based-local-commit-gate.md) 的风险分级
> commit gate 占用，故本条工作线正式编号为 **TASK-064**。验收范围不变。

## 0. 基线

从 `377cde7` 起的 HEAD 继续。既有的 Integration / Production Graph **不重做**。

- pytest：2919 passed / 81 skipped（node 缺失导致的前端包装用例 skip）
- frontend：680 passed（`node --test tests/*.test.mjs`）
- Connected Project：夜班沉默

## 1. 已知真实缺口（实施前实测确认）

| 缺口 | 证据 |
| --- | --- |
| Skill 没有 UI 入口 | `grep -rn "ctx.skills" src/ui/` 无任何命中；domain 完整但无调用者 |
| 顶层 IA 按系统结构分层 | 顶栏 `制作 / 工作流 / 资产`；「工作流」下并列 `生成溯源 / 流程画布` 两套流程模型 |
| 单集媒体制作混在项目级 rail 里 | `shell.js` 的 `EPISODE_NAV` 嵌在「制作」的左栏 |
| Reference 事实上等于图片 | `assetreg.REFERENCE_KINDS` 五种全部 `KIND_DOMAIN → images` |
| 后期是空白工作台 | 无镜头音频多轨、无字幕轨、无自动初剪、无 Lock |
| 连接项目落在临时目录 | `data/projects.json` 中夜班沉默 root 指向会话 scratchpad |

## 2. 交付范围

### Phase 1 — IA + Workspace Consolidation

- [ ] 顶栏改为 `故事开发 / 剧集制作 / 资产库`
- [ ] 故事开发只做到 Episode Script；移除画面/视频/音频/审片/剪辑导航
- [ ] 每集 Script 提供出口「进入剧集制作 →」
- [ ] 剧集制作：Episode Selector（`EP01 ▾`）+ Scene/Shot 层级导航
- [ ] 删除主入口的「流程画布」；保留「生成溯源」
- [ ] Focus Filter（全部/图片/视频/音频/失败）保留
- [ ] 统一三栏：LEFT Inspector / CENTER 生产台 + 溯源 / RIGHT AI 导演
- [ ] LEFT Production Inspector：Reference / Prompt / Generation / Image / Video / Audio
- [ ] 关系控件（上游/下游/完整链路）从右栏移到左栏
- [ ] AI 导演真实 Skill UI：运行 Skill → Skill Run → Proposal → 应用 / 用于生成 / 忽略
- [ ] 资产库 IA 清理：左栏改为 References / Images / Videos / Audio / Final / Collections
- [ ] 资产库 AI 导演承担 Director + Asset Librarian，保留 Episode/Scene/Shot context

### Phase 2 — Shot Production Control

- [ ] Reference 扩到 9 类 + start/end frame 槽位角色
- [ ] 两种用途：`model-input` / `ai-interpretation`
- [ ] Image / Video Prompt Context 组装
- [ ] Unified Upload（所有位置直接上传，绝不产生 orphan media）
- [ ] 版本统一交互 + Set Active 只改指针
- [ ] Downstream 不静默重写 + Dependency State（legacy `basedOn=0` → `unknown`）
- [ ] Generation Input Set 正式展示

### Phase 3 — Automatic Rough Cut + Human Fine-tuning

- [ ] 镜头多轨音频（Video/Dialogue/Ambience/SFX/Foley/BGM/VO）
- [ ] Audio Clip 数据 + Absolute / Anchored timing
- [ ] Shot Mix 派生 Asset + mix provenance
- [ ] 字幕轨：Dialogue → Subtitle（Case A）；ASR 未接入即显示 unavailable
- [ ] Automatic Episode Rough Cut v1
- [ ] Timeline Clip pin 到具体 assetId；active 变更不自动替换
- [ ] Episode Edit Console（video track / audio tracks / subtitle track / preview）
- [ ] Lock + Action Layer + Final Render provenance

### 收尾

- [ ] 设计版 demo 数据（供产品验收）
- [ ] 手动录入数据真实落到项目目录（连接项目迁到持久路径）
- [ ] 全量 pytest + 全量前端 + ruff + Connected smoke + Codex 终审

## 3. 测试策略（按 ADR-0060 风险分级）

开发过程只跑受影响测试；每个 Phase 结束跑受影响后端 + 前端 + lint + 定向
Connected smoke；**全部 Phase 完成后只跑一次全量**。

`.claude/hooks/gate.ps1` 若因全量 pytest 超时阻塞正常提交，按 tooling blocker
记录，不顺手重构 TASK-050 / TASK-052 的整套工装。

## 4. 进度与交接（2026-08-12）

### 已完成并验证：Phase 1

| 交付 | 位置 |
| --- | --- |
| 顶层三空间 + `spaceOf` 单一判定 | `src/ui/shell.js`、`index.html`、`src/app.js` `setTopMode` |
| 剧集制作三栏 shell | `src/ui/production.js`（按 space 分支渲染）、`styles/epprod.css` |
| CENTER 生产工作台（Episode Selector / Focus Filter / Scene→Shot 卡片 / 阶段 tab） | `src/ui/epprod.js` |
| LEFT Production Inspector（镜头/参考/Prompt/生成/画面/视频/音频 + 关系 + 溯源节点） | `src/ui/prodinspector.js` |
| RIGHT AI 导演 · 能力（真实 Skill UI） | `src/ui/skillpanel.js`、`src/workflow/skillapply.js` |
| 溯源图内嵌（节点详情移到左栏） | `src/ui/wfgraph.js` `mount({embedded})` / `setTraceMode` |
| 资产库 IA（媒体分类 rail + Collections） | `src/ui/shell.js` `renderAssetRail`、`src/ui/assetlibws.js` `RAIL_TYPE` |
| Reference 扩到 9 类 + 两种用途 | `src/workflow/assetreg.js`、`src/workflow/geninput.js` |
| 媒体依赖真相（五态，legacy → unknown） | `src/workflow/mediadep.js` |
| 每镜头 Prompt 版本 + Lock | `src/workflow/promptdoc.js`、`ctx.prompt` |
| Action Layer 词表 + 分派 | `src/workflow/actions.js`、`ctx.actions.dispatch` |
| 镜头多轨音频 domain（**尚无 UI**） | `src/workflow/shotaudio.js` |

验证结果：

- 前端 `node --test tests/*.test.mjs`：**715 passed / 0 failed**
  （基线 680 → 715；新增 `tests/creatorui.test.mjs` 35 项）
- 模块导入 smoke：16 个 UI / workflow / services 模块全部可加载
- 真实浏览器驱动验收：**41 项断言全过，0 JS 异常**，断言直接对应本卡 §72 / §73 /
  §74 / §83（脚本见 `_agent-tools/acceptance.mjs`）
- **Codex 独立审查 4 轮，最终 `VERDICT: pass`**（审查者始终是 codex，未回退到
  claude，跨模型独立性完整）。收敛：4+1 → 2+1 → 1+2 → 0+1。7 个真实缺陷全部修复，
  逐条记录见 `.claude/tmp/last-review.md`。其中三条值得记住：
  1. Prompt 版本层建好了但**没有调用者真正使用**——这正是本任务批评 Skill domain
     的同一类问题，差点在自己身上重演。
  2. `pendingOriginFor` 由「派生最近一个未认领的 accepted run」改为**只由显式
     「用于生成」产生**：派生会把「应用」接受的 run 也算进去，让一次无关生成
     被盖上从未发起它的提案——伪造的溯源比没有溯源更糟。
  3. 四类导演参考的上传按钮**是假承诺**（UI 列出来了，底层只收图片）。已改为
     由 kind 自己允许的媒体域推导 `accept` 与校验，按钮上直接标出接受什么。
- 附带发现（自己的守卫测试抓到）：`serialize()` 用普通赋值写 `out[shotId]`，
  当 shotId 恰好叫 `__proto__` 时写的是**原型**，该镜头整段数据被静默丢出保存。
  读侧本来就用 `putKey`，写侧漏了；两处已修并补往返测试。

### 未完成

- **Phase 2 收尾**：Prompt 编译器尚未吃新的四类导演参考（§21/§22）；新参考类型的上传入口只在 Inspector 列出角色按钮，`ctx.assets.importReference` 仍要求图片；Generation Input Set 未按 model-input / ai-interpretation 分组展示。
- **Phase 3 全部**：镜头多轨音频 UI、Shot Mix 写入、字幕轨、自动初剪、Episode 剪辑台、Lock 的 UI 面、Final Render provenance。`shotaudio.js` 是已测试的纯 domain 地基，**但没有 UI 调用者**——按本任务自己的标准（§1「不能只让 Skill Run 出现在 provenance 图上」），这还不算交付。
- 设计版 demo 数据尚未写入连接项目（见下）。

### 环境事实（不是可选项，会影响验收）

1. **node 只在 WSL**（nvm v18.20.8 / v24.12.0）→ 2026-08-12 产品负责人已在 Windows 装 LTS v24.19.0；**需重启会话** PATH 才生效，之后 commit gate 的 frontend 分支才能跑。
2. **WSL git 与 Windows git 的 `core.autocrlf` 不一致**：Windows 侧为 `true`，WSL 侧未继承，导致 WSL 里 `git diff` 把每个文本文件都算成全量改动（149k 行 vs 1.9k 行）。在 WSL 跑任何 diff/审查前必须带
   `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=true`。
3. **本环境不能后台 spawn**（Bash/PowerShell 的 `run_in_background` 报 EPERM），codex-review-loop 要求的后台运行改为 **WSL 内 `setsid nohup` 分离 + 轮询日志**。
4. **FFmpeg 9.0 已装，但不在本会话的 PATH 上**。实体位于

   ```
   C:\Users\MO\AppData\Local\Microsoft\WinGet\Packages\
     Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\
   ```

   winget 安装时改过 PATH，但 agent 进程早于那次改动启动，所以 `shutil.which`
   解析不到 → 后端会答 `503 render_unavailable`。**重启会话后即可用**，
   §84 的真实 Render 在本机是可执行的。Piper（TTS）确实没有。
   这条与既有记忆一致：连接后端必须从**能解析 ffmpeg/ffprobe 的 shell** 启动。
5. 浏览器验收用 WSL 里 playwright 缓存的 `chrome-headless-shell`，缺 `libnspr4/libnss3/libasound2`；无 sudo，故用 `apt-get download` + `dpkg-deb -x` 解到 `/tmp/pwlibs`，并以 `LD_LIBRARY_PATH` 指向它。

### 连接项目已迁到持久目录

`夜班沉默` 原先落在会话 scratchpad（临时目录，会被清）。已复制到

```
D:\02_Work\04_video-work\MotvProjects\夜班沉默
  project.json
  studio\canvas.json      画布 + 全部创作域文档
  media\                  12 个真实媒体文件（4.5 MB）
```

并把 `mockups/motv-workspace/data/projects.json`（gitignored 的本地注册表）指向它，
`confirmedRoots` 加入 `D:\02_Work\04_video-work\MotvProjects`。手工录入的数据从此
落在这个目录，不会随会话消失。

## 5. 明确不做

Image / Video API Provider、Global Shared Asset Library、项目改名/移动/导出、
专业 NLE、完整 DAW、复杂调色、AE/Fusion 合成、multi-camera、高级遮罩与关键帧、
无关的 legacy 清理。
