# TASK-064：创作者 IA 收口与自动初版剧集制作

- 状态：**已验收**（产品负责人 2026-08-13 随 ADR-0066 批准一并收口）
- 实施基线：`ae0a54a`
- **后续归属**：Phase 1 的三空间 IA 由
  [ADR-0066](../../adr/ADR-0066-product-refactor-fixed-ia-review-layers-and-system-contract.md)
  决策 1 保留并收敛为固定十一页；**Phase 1b 的「整集生成溯源图作为剧集制作中央」被
  ADR-0066 决策 3 撤销**，改由「本集看板」承担默认入口，溯源降级为生成记录与诊断视图。
  Phase 2 / Phase 3 的后期域（多轨音频、Shot Mix、字幕、自动初剪、Lock）**全部保留**，
  由 [TASK-074](../active/TASK-074-delivery-migration-and-legacy-retirement.md) 承接到「后期交付」页。
  界面层的替代实施在 [TASK-073](../active/TASK-073-fixed-ia-and-contextual-agent.md)。
- 负责 Agent：Claude Code（单一实施 Agent）
- 依据：[ADR-0061](../../adr/ADR-0061-creator-ia-and-automated-episode-production.md)
- 前置：TASK-062 / ADR-0059 已完成（生产图身份合同贯通，Codex `VERDICT: pass`）

> **编号说明**：产品负责人下发时称「TASK-063」。仓库中 `TASK-063` 已被
> [ADR-0060](../../adr/ADR-0060-risk-based-local-commit-gate.md) 的风险分级
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

## 4c. Phase 2 收尾 + Phase 3 全部（2026-08-12）

### 交付：Phase 2 收尾

| 交付 | 位置 |
| --- | --- |
| 参考「解读」文档（六轴 · 版本 · Lock） | `src/workflow/refinterp.js`、`ctx.refInterp` |
| Prompt 编译器真正读参考 + 解读 | `src/workflow/promptc.js`（image/video/dialogue 三个编译器）|
| 唯一编译器接线（参考 / 解读 / 首尾帧一次解析） | `src/ui/storyboard.js` `referenceInputs` / `frameInputs` → `shotDetailModel` |
| Generation Input Set 按用途分组 | `src/workflow/geninput.js`（`modelInputs` / `interpretationInputs`）+ `prodinspector.js` `inputSetSec` |
| 尾帧 → 下一镜首帧（全字段溯源 + 五态漂移 + 三个出口） | `src/workflow/framebind.js`、`ctx.frames`、`prodinspector.js` `extractSec` |
| 客户端抽帧（`<video>`+`<canvas>` → 登记为 `derived-frame`） | `src/app.js` `grabVideoFrame`、`ctx.frames.extract` |
| Lock 域（八个 scope，其中四个由各自文档持有） | `src/workflow/locks.js`、`ctx.locks` |
| `environmentMotion` 作为独立视频输入 | `promptc.compileVideoPrompt`、`shoteditor.normalizeShots` |

### 交付：Phase 3

| 交付 | 位置 |
| --- | --- |
| 后期控制台（镜头音频 / 剧集剪辑 / 成片） | `src/ui/postconsole.js`，dock 挂在剧集制作下方，`edit` 模块是同一组件的全屏形态 |
| 镜头多轨音频 UI（六轨 · 绝对/事件对位 · gain/fade/mute/换素材） | `postconsole.js` + `ctx.shotAudio` |
| Shot Mix（真实 ffmpeg，派生资产，源全保留） | `server.py` `_agent_mix_shot`、`ctx.shotAudio.mixNow` |
| 字幕轨（台词 → 字幕 Case A，编辑/合并/拆分/样式/SRT 导出） | `src/workflow/subtitle.js`、`ctx.subtitles` |
| 自动初剪（不发明、pin 版本、不覆盖人工） | `src/workflow/roughcut.js`、`ctx.timeline.buildRoughCut` |
| 时间线：foley/vo 轨 · 版本 pin · 五态漂移 · remove/restore · 转场 | `src/workflow/timeline.js` |
| Action Layer 扩到 24 个后期动作 | `src/workflow/actions.js` + `ctx.actions.dispatch` |
| 四个真实后期 Skill + 写回路径 | `src/workflow/skills.js`、`skillapply.js` |
| Final Render 可复现溯源 | `ctx.timeline.render` 的 `parameters` |

### 本轮的关键判断

1. **不另造 Frame 系统**：生效的首帧仍是 `assets.firstFrames[slot]`（付费路线 /
   draft lock / 溯源图都读它），`frameBindings` 只补它从来没有的「来自哪里」。
   两者在同一次调用里写，不可能各自漂移。
2. **`剪辑` 工作区被控制台取代**，不是并存：`ui/timelinews.js` 已不再挂载
   （读模型的单元测试保留）。否则同一条时间线会有两处实现、两套 guard。
3. **转场记录但本轮不渲染**：本地渲染器仍按硬切拼接。UI 与成片溯源都明说这一点
   —— 让「叠化」看起来生效而实际是硬切，就是这套代码一直在拒绝的假承诺。
4. **字幕不烧入画面**，提供 SRT 导出；ASR / 强制对齐留适配点并显式标注不可用。

### 验证结果

- 全量 pytest：**2959 passed / 56 skipped / 0 failed**
- 前端：**792 passed / 0 failed**（740 → 792；新增 `tests/postprod.test.mjs` 52 项）
- ruff：**All checks passed**
- Connected（真实项目 `夜班沉默`，真实 server.py + 真实 ffmpeg）：
  **75 项断言全过，0 JS 异常 / 0 失败请求**（`_agent-tools/accept-phase23.mjs`）
- 演示项目补测真实数据够不到的两条路径（多镜头 reorder、台词→字幕）：
  **7 项全过**（`_agent-tools/accept-demo-gaps.mjs`）
- Codex 独立审查 **9 轮**，修掉 **14 个 P1**，1 条假阳性经浏览器实测推翻；
  逐条见 `.claude/tmp/last-review.md`

### 五个既有 pytest 守卫被更新（都是本轮有意的改动，行为未变）

`test_motv_generation_m5`（混音是第 7 个真实 generation）、
`test_motv_prodgraph_task062`（`shotAudio` 也是 per-shot 输入）、
`test_motv_skills_task059`（切片边界改为真正的下一个 controller）、
`test_motv_upstream_persistence`（OWNED_FIELDS 现在跨多行）、
`test_motv_asset_library_task061`（Phase 1b 的 `str()` 包装 —— **这一条在本轮开始前
就已经是红的**，Phase 1b 只跑了前端与浏览器，没跑全量 pytest）。

### 一个只有截图能抓到的缺陷

控制台第一版**在 DOM 里、handler 全绑好、每条行为断言都过，但创作者看不见**：
`.st-main` 是滚动 flex 列且给每个子元素 `flex: none`，而 `.ep-center` 自称
`height: 100%`，于是追加在它后面的控制台被排到视口外。
浏览器驱动的断言查的是 DOM 与行为，抓不到这一类。修法是让中央列自己拥有高度
（`styles/epprod.css` `.ep-main`），并给验收脚本加了一条**测量 boundingBox 的
可见性断言**，让这一类不可能再静默复发。

### 已知的真实限制（不是绕过，是如实记录）

1. **转场不渲染**（见上）。
2. **字幕不烧入画面**，只导出 SRT。
3. **`夜班沉默` 只有 SH01 有视频**，且该镜头没有台词 → Connected 上
   「多镜头 reorder」与「台词→字幕」无法在真实数据上演示，已在演示项目补测并
   在验收脚本里如实标注为「未在 Connected 上演示」，不是绿勾。
4. **旧时间线片段是 `manual`**，自动初剪按设计不动它们，因此拿不到版本 pin。
   控制台新增「按当前素材重建…」作为唯一的显式出口（会覆盖手工调整，有确认）。
5. **Shot Mix 需要 ffprobe**：无出点或出点超长时靠它解析真实时长，缺失即 503。

## 4z. 归属结论（2026-08-13）：§4d–§4m 的转记项全部已分配

以下各节记录的 codex 发现此前**只被转记、没有归属**。2026-08-13 逐条分配完毕，
本卡不再持有它们，**本卡也不再是修复它们的地方**：

| 分配到 | 条数 | 条目 |
| --- | --- | --- |
| [TASK-072](../active/TASK-072-system-contract-and-persistent-runs.md) §1.9 **批次三**（领域 / 前端） | **13**（同族合并为 10 行） | §4d 第 1 / 2 / 3 / 4 / 5 条 · §4f · §4g 第 1 / 2 条 · §4i 第 2 条 · §4j（未复现）· §4k 第 2 条 · §4l · §4m |
| [TASK-074](../active/TASK-074-delivery-migration-and-legacy-retirement.md) §1.1b（`mix-shot` 端点） | **4** | §4h 第 1 / 2 条 · §4i 第 1 条 · §4k 第 1 条 |
| **已驳回，不分配** | **1** | §4e（`reextract` 传 `force: true`）—— 假阳性，已驳回两次，理由见 §4e 与 §4d 末段 |

合并的两处（**是同族，不是漏项**）：§4d 第 1 / 4 条与 §4k 第 2 条都是
「`ctx.frames.bind` 写入前不校验」，合成 §1.9 第 1 行；§4f 与 §4m 是**同一条**
（字幕生成用 `clipsOf` 而非 `liveClips`，被两轮审查各报一次），合成第 5 行。

分配的依据是**缺陷落在谁的面上**，不是它被谁发现：领域与前端归 TASK-072 批次三
（与门槛 / 版本派生同属领域层），`mix-shot` / `render` 端点归 TASK-074
（ADR-0065 明确这三个端点不在 TASK-072 的运行链路改造范围内）。

每条的修法方向已在接收方的卡里写明，并**要求先复现再修**。
下面各节保留原文不动（AGENTS.md 第 18 条），作为这些条目的原始记录。

## 4f. 待处理：codex 在 TASK-069 审查中对 Phase 3 字幕生成的发现（范围外转入）

2026-08-13，TASK-069（分集规划手工修改）的 codex 审查在**本任务 Phase 3** 的代码上报了
一条 blocking，按 AGENTS.md 第 17 条原样转记，**未在 TASK-069 中修改**：

> `mockups/motv-workspace/src/app.js`（`ctx.subtitles.generate`）— 生成字幕时遍历
> `timeline.clipsOf(..., "video")` 而不是 **live clips** → 会给标记为已移除的片段生成
> cue，而这些片段并不在最终渲染里 → **交付的 SRT 会给成片里不存在的镜头配字幕**。

判断（供实施时参考，尚未实施）：

- 缺陷可信且影响是**交付物级别**的：`liveClips` 正是为「排除已移除片段」而存在的，
  时间线渲染与时长计算都用它，只有字幕生成这一处用了 `clipsOf`。
- 修法应当极小：把那一处换成 `timeline.liveClips(t)`，并补一条守卫测试
  「移除一个片段后重新生成字幕，不再为它产生 cue」。
- 之所以不在 TASK-069 里顺手改：字幕属于 TASK-064 Phase 3 的交付面，本轮的范围是
  故事开发的分集规划，两者没有交集（AGENTS.md 第 17 条）。

## 4g. 待处理：codex 在 TASK-067–071 批量审查中的两条 Phase 3 发现（范围外转入）

2026-08-13，TASK-067–071 批量审查在**本任务 Phase 3** 的代码上报了两条 non-blocking，
按 AGENTS.md 第 17 条原样转记，**未在那一批里修改**：

1. `workflow/skillapply.js` `collectSubtitleFixes` + `ctx.subtitles.applyFix` —— 一条
   字幕修正同时带 `mergeWithNext` 和 text / 时间字段时，dispatcher 把「合并」当成**互斥**
   分支：合并成功，而同一条里请求的其它修正被**静默丢弃**。要么把两者都执行，要么明确
   拒绝并说明，不能默默只做一半。
2. `src/app.js` `ctx.skills.context` 的 `timeline` 投影 —— `alternatives` 无论 clip 的
   `trackType` 是什么，一律去查**该镜头的视频链**：音频片段因此被投影出一串视频版本作为
   「可替换项」，Editing Director 依此提的提案会在域校验处失败。应按 `trackType` 取对应
   的链，音频取音频。

（第 1 条的 `collectSubtitleFixes` 虽然在 TASK-067 编辑过的文件里，但那个函数本身是
Phase 3 的交付面，本批次未改动它。）

## 4h. 待处理：codex 在批量审查 round 2 中对 Phase 3 `mix-shot` 端点的两条发现（范围外转入）

2026-08-13，按 AGENTS.md 第 17 条原样转记，**未在那一批里修改**：

1. **（blocking）`server.py` `_agent_mix_shot`** —— 输出 basename 只校验 `_NAME_RE`，
   **没有强制 `mix-` 保留前缀**。而 `mix-` 正是 ADR-0044/TASK-064 为「合成产物」预留的
   命名空间：一个构造过的请求可以用别的 slug 占用属于对白 / 音效音频链的带版本文件名，
   造成命名空间抢占与资产混淆。其它写入路径（手工上传 / TTS / 付费生图）都已经用
   `_slug_reserved` 挡住反向情况，这一处是同一条纪律的缺口。

2. **（non-blocking）`server.py` 开放式片段的边界** —— `in == 36000` 被允许，而 `out`
   被夹到 `36000`：超过十小时的音频会产生一个**零长度片段**，混音时失败，或者在还有其它
   片段时**静默消失**。两端应当用同一个上界判定，越界即拒绝并说明。

## 4i. 待处理：codex 在批量审查 round 3 的两条 Phase 3 发现（范围外转入）

2026-08-13，按 AGENTS.md 第 17 条原样转记，**未在那一批里修改**：

1. **（blocking）`server.py` mix 端点的数值校验** —— `math.isfinite(v)` 对于**大到无法转
   float 的 JSON 整数**会抛 `OverflowError`：一个体积完全合法的构造请求能让 handler
   **崩掉**，而不是返回 400。校验应当先判类型与范围，再做 isfinite。

2. **（blocking）`src/app.js` dispatcher `replaceTimelineAsset`** —— 只要是同 domain 的
   已登记资产就接受，**不校验它是否出现在那次运行看到的 `alternatives` 里**：一份被注入
   或产生幻觉的提案可以把某个片段换成**项目里任意一段无关媒体**。

   > 这与 TASK-067 round 1 在 `shot-asset-recommender` 上修掉的是**同一类**缺陷（提案
   > 绑定了运行当时没有看到的东西）。那边的修法可以照搬：把运行看到的候选集记进
   > `contextTrace`，应用时按它过滤，**没有记录就拒绝**（fail-closed，不要 fail-open）。

## 4m. 待处理：codex 批量审查 round 7 对字幕生成的发现（范围外转入）

`src/app.js` 字幕生成遍历的是 `timeline.clipsOf` 而不是 `timeline.liveClips`：**已经被
移出成片的片段仍然会生成字幕行**。字幕于是描述了观众根本看不到的画面，而且行号与
实际剪辑对不上。

## 4l. 待处理：codex 批量审查 round 6 对 Sound Designer 应用的发现（范围外转入）

`src/workflow/skillapply.js` 的音频提案落地：`setFade` **只在 `layer === "shot"` 时**发出，
于是一份只调 episode 层淡入淡出的合法 Sound Designer 提案会被**静默忽略**——界面显示
已应用，实际什么都没改。要么支持 episode 层的 fade，要么在无法应用时如实拒绝并说明；
不能两者都不做。

## 4k. 待处理：codex 批量审查 round 5 的两条发现（范围外转入，2026-08-13）

1. **（blocking）`server.py` mix：ffprobe 在拿 `_RENDER_LOCK` 之前跑** —— 每个请求最多
   会在**锁外**起 60 个 `ffprobe` 进程。并发请求因此可以在一次 render/mix 正在进行时
   叠加出大量子进程：既是资源耗尽风险，也让「作业串行化」这个保证名存实亡。探测应当
   移到锁内，或者对锁外探测本身限流。

2. **（blocking）`src/app.js` `frames.bind` 先落库再校验** —— 它在确认目标 shot 有可解析
   的 slot（`_slotOf`）之前就持久化并返回绑定。`_slotOf` 失败时，Prompt 上显示的是新绑
   的帧，而生成实际仍在用上一帧：画面与溯源都对不上。应当先解析 slot，解析不出就
   拒绝绑定（fail-closed），不要留下一个只在界面上成立的绑定。

## 4j. 待处理：codex 批量审查 round 4 对帧提取的发现（范围外转入，未确认）

`src/app.js` 的 `"at"` 帧提取：把 `currentTime` 设到 **0 ms** 时，若视频本来就停在 0，
`currentTime` 不发生变化，而浏览器**并不保证**此时一定派发 `seeked`——于是抓第一帧会
走到超时，而不是抓到画面。codex 自己标了 uncertain，我也没有在真实项目里复现过；
处理前应先实测，不要凭报告改。

## 4e. 待处理：codex 在 TASK-067 审查中对 Phase 2 `ctx.frames.reextract` 的发现（范围外转入）

2026-08-13，TASK-067 的 codex 审查（本任务的 Phase 2/3 仍在 working tree 未提交，因此
一并进了那次 diff）在**本任务**的代码上报了一条 blocking，按 AGENTS.md 第 17 条原样转记
在这里，**未在 TASK-067 中修改**：

> `mockups/motv-workspace/src/app.js:3274`（`ctx.frames.reextract`）— 无条件传
> `force: true` 调用 `ctx.frames.bind` → 重新提取会覆盖一条**已锁定**的帧绑定，
> 绕过本该要求的解锁。

**这是 TASK-065 审查里已经被驳回过的同一条**（见 TASK-065 报告的「驳回（false
positive）」一节），理由未变，一并记在这里以免下一轮再花一次审查配额：

- `framebind.bind` 的文档明确 `force` 只由**创作者自己的动作**传入 —— Auto Rough Cut
  与 Skill 提案都不传，`usePreviousShotEndFrame`（TASK-067 新增）也不传。
- `framebind.js` 第 155 行 `next.locked = true` 让锁在重新绑定后继续存在。
- 锁保护的是**自动化**，不是创作者本人 —— 与 Prompt 锁、解读锁同一套语义
  （ADR-0061 决策 5）。

**若产品要改变这条语义**（让锁也拦住创作者自己的重新提取），那是一次 ADR-0061 决策 5
的语义变更，应在本任务卡内立项，而不是在一次审查循环里顺手改掉。

## 4d. 待处理：codex 在 TASK-065 审查中对 Phase 2 `ctx.frames` 的发现（范围外转入）

2026-08-12，TASK-065 的 codex 审查（本任务的 Phase 2/3 当时仍在 working tree 未提交，
因此一并进了那次 diff）在**本任务**的代码上报了一条，按 AGENTS.md 第 17 条原样转记
在这里，**未在 TASK-065 中修改**：

> `mockups/motv-workspace/src/app.js`（`ctx.frames.bind`）— 记录绑定之前没有校验
> `targetShotId` 是否解析到真实镜头 → 目标镜头已删除时会持久化一条悬空的
> frame binding，并报告成功。

判断（供实施时参考，尚未实施）：

- 缺陷可信：`framebind.bind` 只检查 `targetShotId` 是非空字符串，不检查它在当前
  draft 里存在。`ctx.frames.bind` 也没有补这一层。
- 影响有限但真实：读侧 `frameInputs` 只为它渲染的镜头解析绑定，所以一条属于已删除
  镜头的绑定不会被画出来；但它会**留在 `frameBindings` 文档里**，并且写入时报告成功。
  与本任务自己的纪律（「写入目标必须真实存在」，见 §4b Codex 轮 1）不一致。
- 建议修法与 TASK-065 的 `missingBaseTarget` 同一形状：绑定前用 `ctx.shot.find`
  校验目标镜头，解析不到就拒绝并说明原因（而不是静默写入并报成功）。

### 第二条（TASK-065 审查轮 6）：解读按 chain key 取，不按媒体版本

> `mockups/motv-workspace/src/app.js`（`ctx.skills.context` 的
> `references[].interpretation`，以及 `ctx.refInterp` 全部读路径）—— 参考解读只按
> **稳定的 `r.key`** 取，不带 asset / 媒体版本。给某个运动 / 风格 / 机位参考上传
> **新的媒体版本**之后，Prompt 会把它标成新版本（`refName` 带 `v2`），而编译进去的
> 六轴文字仍是**读 v1 时写的** → 过期的导演指令，以及 generation provenance 里
> 「用了 v2 的解读」这个不成立的说法。

判断（供实施时参考，尚未实施）：

- 缺陷可信，而且是**本任务 Phase 2 的设计选择**：`refinterp` 的文档形状是
  `refInterp[refKey]`，一条链一份解读历史，没有把解读绑到具体媒体版本。
- 影响真实但有边界：只有「同一个参考换了新媒体版本，且没有重新解读」时才发生。
  换版本本来就是创作者的显式动作，所以**可修的方向是提示而不是猜**：
  与 `mediadep` / `framebind` 已有的「上游已变化」五态提示同一套做法 ——
  记下解读是针对哪一版媒体做的，媒体版本前进后把该解读标成 `stale`，
  在 Prompt 的 `missing` 里如实报「这条解读是针对 v1 写的，当前是 v2」，
  并给三个出口（保持 / 重新解读 / 解除），**绝不自动改写创作者写过的文字**。
- 不在 TASK-065 范围内（那一轮没有触碰 `refinterp` 的读写路径），按 AGENTS.md
  第 17 条原样转记。

### 第三 / 第四条（TASK-066 审查轮 1）：Phase 3 的锁与 Phase 2 的槽位校验

> 1. `src/workflow/timeline.js`（`setClipRemoved`）—— 移除一个片段时会连带移除**同一
>    镜头的音频片段**，但不检查它们各自的 `locked`。于是移除一条未锁定的画面片段
>    （包括通过 Skill 动作移除）会**静默移除已锁定的对白 / 音效**。
> 2. `src/app.js`（`ctx.frames.bind`）—— 接受任意图片资产并写进 `assets.firstFrames`，
>    即使它属于**另一个槽位**且不是 `derived-frame`。canvas 校验器会拒绝这样保存的
>    文档 → **绑定之后项目打不开**。

两条都属于本任务（Phase 2 / Phase 3），不属于 TASK-066，按 AGENTS.md 第 17 条转记，
未在 TASK-066 中修改。

判断（供实施时参考，尚未实施）：

- 第 1 条与 Phase 3 自己的纪律直接冲突：锁的语义是「自动化不覆盖它」，而级联移除
  正是一次没有经过创作者对那条音频做决定的写入。建议修法：级联时**逐条检查锁**，
  锁定的保留并**如实报告**「N 条已锁定的音频没有跟着移除」，而不是静默处理。
- 第 2 条是**会导致文档无法加载**的严重缺陷，优先级高于第 1 条。`firstFrames[slot]`
  的校验合同要求写入的资产属于该槽位且类型正确；`ctx.frames.bind` 应在写入前用
  同一套规则校验（`assetreg` 的 kind + 槽位归属），不满足即拒绝并说明原因 ——
  与 TASK-065 的 `missingBaseTarget`、`importReference` 的「登记前校验」同一形状。

### 第五条（TASK-066 审查轮 3）：`frameInputs` 不读既有的 `firstFrames[slot]`

> `src/ui/storyboard.js`（`frameInputs`）—— 只有当 `frameBindings` 里有记录时才把首帧
> 当作「显式选择」；否则一律回落成「本镜头当前画面」。于是**已经存在的显式首帧选择**
> （付费出图路线写入的、或创作者按过「用作视频首帧」的 `assets.firstFrames[slot]`）
> 在 Prompt 与 Generation Input Set 里被**当前画面顶替** → 生成用的输入与记录下来的
> 溯源互相矛盾。

这条与**本任务自己写下的设计**直接冲突（§4c「生效的首帧仍是 `assets.firstFrames[slot]`
…两者在同一次调用里写，不可能各自漂移」）：写侧确实一起写，但**读侧 `frameInputs`
只看 `frameBindings`**，所以任何**在 frameBindings 存在之前**就已经写进 `firstFrames`
的选择（旧项目、付费路线）都读不出来。

建议修法：`frameInputs` 的 `start` 回落顺序改为
**显式 binding → `firstFrames[slot]`（解析得到的资产，`from` 如实标为「已记录的首帧
（没有来源记录）」）→ 本镜头当前画面**。中间那一层现在整个缺失。

同一轮还报了 `ctx.frames.reextract` 传 `force: true` 会「覆盖创作者锁定的帧」。
**这条是假阳性**：`framebind.bind` 的文档明确写了 `force` 只由创作者自己的动作传入
（Auto Rough Cut 与 Skill 提案都不传），并且第 155 行 `next.locked = true` 让锁在
创作者自己的重新绑定后**继续存在**。锁保护的是自动化，不是创作者本人 —— 与 Prompt
锁「锁定后自动化不会覆盖它」是同一套语义。已在 TASK-065 的审查记录里作为 rebuttal
留档，无需修改。

## 5. 明确不做

Image / Video API Provider、Global Shared Asset Library、项目改名/移动/导出、
专业 NLE、完整 DAW、复杂调色、AE/Fusion 合成、multi-camera、高级遮罩与关键帧、
无关的 legacy 清理。
