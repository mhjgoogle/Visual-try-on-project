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

## 4b. Phase 1b — 三个 UX 缺陷（2026-08-12，产品负责人下发）

Phase 1 交付后，产品负责人在真实项目上用出了三个问题。范围**只有这三条**，
Phase 2 / Phase 3 不动。

### 缺陷 1 · 「故事开发 → 剧集制作」跳转不成立

实测两个独立缺陷叠在一起：

| 症状 | 真实原因 |
| --- | --- |
| 「进入剧集制作 →」点了没反应 | 按钮渲染 `data-ep-produce`，但 `bind()` 里**从未绑定过这个属性**（只绑了 `[data-ep]`），是个死按钮 |
| Episode row 反而会跳转 | row 的 `[data-ep]` 直连 `enterEpisode(id, null)`，从上游进入时 `target` 落到 `workbench` —— 「看一下 EP02」和「开始做 EP02」是同一次点击 |
| 顶栏 active 不同步 | `enterEpisode` 在 shell 闭包里改 `activeModule`，`syncTopBar()` 在 app.js 里，**没有任何通路**告诉顶栏 |

改法：

- row 改为 `data-ep-choose` → 新增 `selectEpisode()`：只切换 active episode，
  **不动 `activeModule`**。
- `data-ep-produce` 正式绑定 → `enterEpisode(id, EPISODE_DEFAULT)`。
  分集规划的两个按钮统一改为同一目标并统一文案「进入剧集制作 →」。
  「进入本集剧本 →」不变——`spaceOf("script") === "story"`，它根本不是跨空间跳转。
- `createProduction(getCtx, { onNavigate })`，在**每条 render 路径末尾**回调，
  顶栏永远从 shell 自己的状态读。放在 render 而不是放在每个「搬动创作者」的
  函数里，是为了让「新增一个入口时忘记同步顶栏」这件事不可能发生。

### 缺陷 2 · 剧集制作默认页太复杂

原本：11 个同级中央 tab（工作台 / 本集总览 / 场景 / 分镜 / 参考统筹 / 画面 /
视频 / 音频 / 审片 / 剪辑 / 生成溯源），默认落在大号 Shot Card 工作台，
创作者要**自己找**「生成溯源」。11 个同级项不是 IA，是功能清单。

改法：

- `EPISODE_DEFAULT = "provenance"`：生成溯源**就是**这个空间的中央，进入即见。
- 11 个 tab → 1 个次级「工作区 ▾」入口（`EPISODE_WORKSPACES`，由
  `EPISODE_NAV` 派生，两个面不可能不一致）。进入某个工作区时它明说自己是绕路，
  并给出「← 生成溯源」。**一个能力都没删。**
- 能力的主路径变成 **图上点节点 → 左栏 Inspector 操作**：新增
  `inspectFromNode()` 把 provenance 节点映射到操作面板（参考 / Prompt / 生成 /
  画面 / 视频 / 音频 / 镜头），下面挂该节点的「溯源」区。没有 per-shot 面板的
  节点（场景 / 剧本 / 基线 / 能力运行 / 提案 / 成片 / 审片 / 场景环境音 /
  整集配乐 / 已删除媒体）**保持只读**——为它们猜一个 shot 会让创作者的下一次
  **写入**落到记录从未连接的对象上。
- Focus Filter 只在真的过滤镜头卡的工作台渲染；图上有自己的筛选 chip，
  两套词表同屏比一套差。
- 右栏**始终**是 AI 导演（Phase 1 已保证，本轮的节点详情仍然进左栏，不回右栏）。

### 缺陷 3 · 生成溯源链不完整

在真实项目 `夜班沉默` 上实测，缺两条**真实存在但没被画出来**的链：

1. **`assets.firstFrames` 里的媒体被当成「已删除」。** 付费出图路线把结果登记为
   槽位首帧（`{assetId, url, version, origin, creativeShotId, storageState}`），
   **并没有**追加进 image chain。`walkAssets` 只走 chain + finals，于是视频自己
   记录的输入 `asset-1f8cf208` 解析成缺失节点 —— 文件一直在盘上，图片半条链却
   显示为断开。已把 firstFrames 作为第三个 seed 源（chain 记录优先；
   `isCurrent` 恒为 false，它不在 chain 里；**无 url 的存根仍然算已删除**，
   记录不能自证媒体存在时不许声称存在）。
2. **`shotProduction.reviews` 完全不在图里。** 审片通过是绑定到具体一条 take 的
   人的判断，是镜头链的最后一环。新增 `review` 节点 + `asset → review` 边，
   只在记录存在且那条 take 真的在图里时画；指向已不存在媒体的通过记录报
   `danglingReview` warning，**绝不改画到替代品上**。收起的镜头行也显示「已通过」，
   否则它只在展开时可见。

顺带修掉两个真实缺陷（都在本轮触及的代码路径上）：

- `referenceBody` 只在 `p.bound` / `p.library` 里找 refKey，**漏了
  `p.suggested`** —— picker 把库分成三段互斥列表，少查一段就让「本集推荐」的
  参考永远打不开自己的详情页（点图上「林晚 Ref」只会得到 picker 列表）。
- `scriptTextOf` 承诺返回字符串，但 `currentText` 会把版本记录的 `content`
  原样返回；手工编辑过的存档可能有版本却没有 `content` → `undefined.trim()`
  抛错 → 整页空白。已收口为 `str(...)`。

### Phase 1b Codex 审查抓到的两个真实缺陷

两轮都是 **P1（错误的写入目标 / 伪造的溯源）**，都不是本轮改动的表面问题，
而是「读模型正确但操作层读了另一个来源」这一类错误：

1. **轮 1 — 图上点节点后，左栏的动作打在上一个镜头上。**
   派生出来的选择只赋给了 render 内的局部变量 `s`，而 `bindInspector` 的
   `sel()` 仍读 `ui.inspect`。于是：面板显示 SHOT 02 的画面，
   `审片通过` / `上传生成结果` / `保存 Prompt` / `绑定参考` 全部落到 SHOT 01。
   同一镜头内也错：点 VIDEO PROMPT 节点，保存会写进 IMAGE prompt。
   修法是把选择抽成 `inspectorTarget(ctx, ui, node)` —— render 与 bind
   **共用同一个来源**，而不是各自推导。同一类的第二处一并修掉：未保存的
   Prompt 缓冲 `ui.piPrompt` 原先能跨节点存活，会把给 A 写的文本存到 B；
   改为在图的选择真的变化时释放（`mountProvenance` 的 rerender 回调）。
   浏览器实测确认：站在 Shot 01 上点 SHOT 02 的画面节点，面板与
   `技术详情` 都报 `slot v1-2 / asset-e118eb91…`，即 SHOT 02 自己的槽位。

2. **轮 2 — 审片通过只校验了资产存在，没校验那条 take 属于被通过的镜头。**
   一条过期/损坏的记录指向别的镜头的 take，就会把那条 take 画成
   「这个镜头已通过」——伪造的人的判断，比没有判断更糟。改为三条都成立才画：
   记录是真通过、take 真在图里、**take 的镜头等于被通过的镜头**；
   take 自己的镜头未知时同样拒绝（不算「因缺失而一致」，与 skillRun
   上下文校验、proposal origin 配对校验同一套纪律）。不一致时报
   `reviewShotMismatch` warning，绝不改画到替代品上。
   这条也要求把 review 区块移到资产归属推导**之后**——一条媒体记录的镜头
   可能来自产出它的 generation 而不是自己的 `creativeShotId`，提前校验会把
   真实的通过记录误拒。

### Phase 1b 验证结果

- 前端 `node --test tests/*.test.mjs`：**740 passed / 0 failed**
  （715 → 740；新增 `tests/creatornav.test.mjs` 25 项，全部是规则守卫，
  其中 6 项是上面两个 Codex P1 的回归守卫）
- 真实浏览器驱动验收（真实 Connected Project `夜班沉默`，非 demo seed）：
  **51 项断言全过，0 JS 异常 / 0 失败请求**
- 链路实测（`SHOT 01 招牌·雨夜`）：作品基线 → 剧本 → 场景 → 镜头 →
  人物参考 + 场景地参考 → IMAGE PROMPT → 图片生成 → 镜头画面 →
  VIDEO PROMPT → 视频生成 → 镜头视频 → **审片通过**，另有能力运行 → 提案 →
  由提案发起的生成，以及独立的成片链路。`warnings` 为空。
- 契约变更：`tests/workspaces.test.mjs` 原断言 `EPISODE_NAV[0] === "workbench"`
  已改为断言生成溯源领头 —— 这是本轮**有意**的合同变更，不是测试迁就实现。

### Phase 1b 未做（有意）

- **后期控制台（下方）没有建。** ADR-0061 决策 6 规定它的位置，但本轮范围
  第 5 条明确禁止剪辑台 / Rough Cut / 字幕 / 多轨。放一个空壳等于假承诺，
  所以只保留「剪辑」工作区入口，控制台留给 Phase 3。
- 图上一条完整镜头链约 1790px 宽，中央栏约 990px，尾部（视频结果 / 审片）
  需要横向滚动 `.wg-shotlane` 才能看到。滚动条是既有机制、也确实是宽图的正常
  解法，本轮不新增滚动 UI。

### Phase 1b 环境事实

1. **连接后端在 cp932 控制台下启动会崩**：banner 打印项目名
   `夜班沉默` 触发 `UnicodeEncodeError: 'cp932' codec`（`server.py:5095`）。
   本轮以 `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` 绕过；**这是范围外的真实缺陷**，
   已记在此处待单独修（非 ASCII 项目名在日语区 Windows 上无法启动服务）。
2. `/api/projects/<name>/budget` 对 `夜班沉默` 返回 **403 account_scope**：
   该项目在 `--account-root`（默认 `examples/projects`）之外。这是服务端**正确的
   拒绝**，不是缺陷；验收时以
   `--account-root D:/02_Work/04_video-work/MotvProjects` 启动即可。
3. `.claude/settings.json` 的 commit gate hook 原本写相对路径
   `python .claude/hooks/gate_dispatch.py`，shell 一旦 `cd` 进子目录就**全部
   工具调用被阻断**。已改为 `$CLAUDE_PROJECT_DIR` 锚定。属 agent 工装，
   与产品代码无关。
4. Playwright 在本机没有浏览器缓存，需先 `python -m playwright install chromium`。

## 5. 明确不做

Image / Video API Provider、Global Shared Asset Library、项目改名/移动/导出、
专业 NLE、完整 DAW、复杂调色、AE/Fusion 合成、multi-camera、高级遮罩与关键帧、
无关的 legacy 清理。
