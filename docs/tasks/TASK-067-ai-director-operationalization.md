# TASK-067：AI 导演 / Skill / Agent 的可操作化

- 状态：规划完成，实施中
- 负责 Agent：Claude Code（单一实施 Agent）
- 前置：[TASK-066](TASK-066-episode-production-shot-workbench.md) 的五区工作台已落地
- 依据：[ADR-0064](../adr/ADR-0064-ai-director-operationalization.md) +
  产品负责人 2026-08-12 下发的 §1–§23 规格
- 产品确认（2026-08-12）：
  1. 创作型 Skill 的验收走 **manual runtime**（Claude Code / Codex 的可用性仍如实显示）
  2. 资产推荐 = **确定性检索出候选 + AI 只排序与给理由**
  3. 先修 TASK-066 遗留的 3 个红守卫，未完成清单只按本轮真正需要补

## 0. 本轮要回答的唯一问题

> AI Director 现在能不能真正帮用户完成一个 Shot 的视觉制作？

一个 Shot 的核心制作链：

```
References → Image Prompt → Shot Image → Video Prompt → Shot Video
```

AI 导演必须真实参与其中每一步，且创作者始终掌握确认权。

## 1. 起点如实记录（2026-08-12 实测）

| 事实 | 值 |
| --- | --- |
| 前端测试基线 | **833 passed / 0 failed**（4 次并行 + 2 次 `--test-concurrency=1` 全绿） |
| 「3 个红守卫」 | **不存在** —— 首次测量时同机并发跑了第二个测试套件，node 并行 runner 在负载下产生的瞬时失败。已复测确认 |
| TASK-066 §3 清单 | 代码已交付（五区、`shotselect` / `shotrefs` / `refsearch` / `shotgraphview` 均已接线并有守卫），**卡上的勾选框陈旧**，本轮据实更新而不重做 |
| 本机 `claude` | **不在原生 Windows PATH 上** |
| 本机 `codex` | 在 PATH（`C:\Users\MO\AppData\Roaming\npm\codex.ps1`） |
| 真实项目 | 夜班沉默 · EP01 迷雾入城 · S01 酒吧·打烊后 · 3 镜 · 林晚(1 ref/1 state) · 暗夜酒吧(1 ref) · 32 条生成记录 |

## 2. 已存在、本轮复用不重做

Skill 目录（15 个冻结能力 + 输出契约校验）、Skill Run 注册表（run → proposal →
accept/reject → provenance + origin stamp）、Runtime 分层（claude-code / codex-cli /
manual + 真实服务端探测）、`skillapply`（proposal → Action 信封）、Action Layer 与
dispatcher、`refuse`（参考用途）、`refinterp`（解读，带版本与锁）、`promptc`
（image/video 确定性编译器，已报 gap）、`geninput`（Generation Input Set）、
`framebind`、`locks`、`provenance`、五区剧集制作工作台。

## 3. 交付清单

### Phase 0 — 基线核实
- [x] 复测确认 833/833 全绿；不存在需要修的红守卫
- [x] TASK-066 卡上的陈旧勾选框据实更新（代码已交付）

### Phase 1 — Shot Context Builder 与缓存（§3 / §15，ADR-0064 决策 1–3）
- [x] 新域 `workflow/shotctx.js`（582 行）：`buildShotContext` / `traceOf` /
      `contextRevision` / `shotReadiness` / `candidatesFor` / `summarize`
- [x] 新域 `workflow/ctxcache.js`（167 行）：revision 键缓存 + 显式 stale + 有界淘汰
- [x] `ctx.shotctx` 控制器；`ctx.skills.context(skillId, extra, scope)` 对 shot 级能力
      改读最小上下文（`skills.isShotScoped` 决定走哪一边）
- [x] `SKILL_INPUTS` += `shotContext` / `assetCandidates` / `selectedShotImage` /
      `promptUnderReview` / `neighbourShots`
- [x] `skillrun.startRun` 记录 `contextTrace`；`persist.js` `OWNED_FIELDS` += `ctxCache`；
      hydrate / serialize / 切项目清空 全部接线

### Phase 2 — 五个新能力（§4 / §7 / §8 / §9 / §10，决策 4–6）
- [x] `shot-asset-recommender`（只能引用候选集里的 referenceKey，带真实 assetId）
- [x] `image-prompt-director`（输出含 assumptions / missingInputs）
- [x] `video-prompt-director`（`selectedShotImage` 为**必要输入**，能力层拒绝）
- [x] `prompt-reviewer`（image / video 两套 criteria，一个能力，`reviewKind` 说明审哪侧）
- [x] `shot-continuity-reviewer`（只做视觉范围；`unknown` 字段让「没问题」可信）
- [x] `skillapply`：五个能力的 applicability + planApply + `applicabilityFor`（提案感知）
- [x] `prompt-director` v1 保留不动（既有运行记录按 id+version 引用它）

### Phase 3 — Action 词汇表补齐（§12 / §13，决策 7）
- [x] `addReference` 新增
- [x] `replaceReference` 改为真正的替换（`replacesKey` 必填，先绑后解、用途随之迁移）
- [x] `usePreviousShotEndFrame` 新增（要求上一镜**已绑定尾帧**，不静默触发异步提取）
- [x] `skillapply` 的 reference-planner 改发 `addReference`（那才是它一直在做的事）
- [x] `CURRENT_LEVEL` 保持 `suggest`（守卫测试锁住 AI origin 不得写入）

### Phase 4 — AI 导演操作面板（§2 / §6 / §18 / §19，决策 8）
- [x] `ui/directorshot.js`（687 行）：当前判断 / 已匹配 / 缺少 / 下一步 / 提案 / 折叠详情
- [x] 六个操作真实接线（§2 的 A 是派生的，不需要按钮——见下）；不可用者显示真实原因
- [x] 技术信息（runtime / model / context snapshot / skill version / ids）进 `<details>`
- [x] 接进剧集制作右栏，替换 TASK-066 的「当前状态」清单（不并存两份同源清单）
- [x] 左栏 `⊙ AI 推荐` 与中央 Prompt 卡 `自动生成` 改为真实运行对应能力（共用
      `runOperation`，不是三份拷贝）
- [x] `ctx.skills.abandon`：卡在 `running` 的运行可以被放弃（此前无法清除）

### Phase 5 — 验收与审查
- [x] targeted tests：`tests/aidirector.test.mjs` 36 项；全量 **878 passed / 0 failed**
- [x] `ruff check .`：All checks passed
- [x] 真实项目「夜班沉默」Connected 验收（`_agent-tools/accept-task067.mjs`）：
      **48 / 48 通过 · 0 个 JS 异常**，§21 十八步全部真实点通，且不留痕
- [x] codex 独立审查 → batch fix → 复核（2 轮，全程 codex，独立性完整；
      详见 `.claude/tmp/last-review.md`）

## 4. 交付物清单

| 类型 | 文件 |
| --- | --- |
| 新域 | `src/workflow/shotctx.js`、`src/workflow/ctxcache.js` |
| 新 UI | `src/ui/directorshot.js` |
| 新能力 | `src/workflow/skills.js` 里的 5 个（catalog 15 → 20） |
| 新动作 | `addReference`、`usePreviousShotEndFrame`；`replaceReference` 语义变更 |
| 新控制器 | `ctx.shotctx`、`ctx.skills.abandon`、`ctx.skills.inputLabel` |
| 接线 | `src/app.js`、`src/ui/production.js`、`src/ui/shotrefs.js`、`src/services/persist.js` |
| 样式 | `styles/shotwork.css`（AI 导演面板一节） |
| 测试 | `tests/aidirector.test.mjs`（36 项）+ `tests/skills.test.mjs` / `tests/creatorui.test.mjs` 的有意合同更新 |
| 验收 | `_agent-tools/accept-task067.mjs`（48 项，真实项目，不留痕） |

## 5. 关键判断（供产品复核）

### 5a. §2 的 A「分析当前 Shot」没有做成按钮

它是**派生的**。`shotctx.shotReadiness` 从文档实时算出「已匹配 / 缺少 / 当前判断」，
所以进入一个 Shot 就已经看到结论了。做成按钮意味着让创作者点一下、等一个模型、
再看一遍本来就在屏幕上的东西——那是表演，不是能力。其余九项（B–J）都是真实按钮或
真实的提案→动作路径。

### 5b. 推荐资产：检索是确定性的，模型只排序

`shotctx.candidatesFor` 从 Asset Registry 按「本场出场人物 / 场景地 / 镜头描述里提到的
道具 / 项目级可复用参考」检索候选，每条带**真实 assetId** 与「为什么它是候选」的证据。
Skill 只能引用候选集里出现过的 `referenceKey`；applier 落地前再校验一次。

两个后果都是有意的：模型**无法发明 assetId**，也**不需要看整个资产库**。
真实项目验收里这一步返回了 7 个候选，7/7 命中注册表。

### 5c. Video Prompt 的前置是能力层的拒绝，不是灰按钮

`video-prompt-director` 的 `inputs` 含 `selectedShotImage`。没有已选定主帧图时它
**缺必要输入**，因此在 `missingInputs` 就被拒绝并说明原因——UI 只是把这个原因显示出来。
把它做成 UI 上一个 disabled 按钮会让「为什么不能」只存在于界面代码里。

### 5d. Prompt Review 的「应用」是提案感知的

`applicability(skillId)` 回答的是**能力**能不能写回；但一份只列了问题、没给完整改写的
审核**这一份**无处可写。因此新增 `applicabilityFor(skillId, proposal)`：真实项目验收
第一次跑出来时，面板给了一个按下去必然失败的「应用」按钮——这正是本轮要消除的
「假装能做」。现在没有改写建议时不提供该按钮，并说明为什么。

### 5e. 一个卡在「运行中」的运行此前会永久占住这一栏

手工运行在答案回来之前保持 `running`，而答案不总会回来。此前没有任何东西能让它离开
`running`，而面板只显示**一个**待答运行——于是之后粘进去的每个答案都被拿去校验那个
旧运行的 schema（推荐不是 Prompt），创作者看到「结果未被采纳」，而他刚启动的运行永远
够不着。真实项目里已经攒了两条这样的遗留运行。

两处修复：面板显示**最新**的待答运行（不是操作顺序里第一个），并新增
`ctx.skills.abandon` —— 记为真实失败态而不是删除（那次运行确实发生过）。

### 5f. `replaceReference` 的语义变更

此前它**只会新增**（已绑定则报 satisfied），所以词汇表里「替换」这个词是假的：没有任何
提案能表达「把 A 换成 B」。现在 `addReference` 是新增，`replaceReference` 真的替换
（`replacesKey` 必填，先绑后解，创作者的用途选择随之迁移）。唯一既有调用点
（reference-planner）改为发 `addReference` —— 那才是它一直在做的事。

## 6. 真实项目验收里暴露的两个数据事实（如实记录）

1. **`shot-763b60db` 有 2 条指向已不存在参考的历史绑定。** 界面如实不画幽灵卡片，
   Prompt 编译器也不把它们算作输入。这是真实项目的数据状态，不是本轮引入的。
2. **本轮不向真实项目上传新媒体。** §21-13/14 的 Manual Upload 路径由 TASK-066 验收且
   本轮未改动；给一个真实镜头加一个 take 是生产工作，不是测试。验收改为核实该路径可达
   ＋真实项目已有的 31 条成功生成 / 10 条冻结 Prompt 的溯源链成立，并如实标注。

## 7. 明确不做（复述，未越界）

后期制作 UI、Dialogue / SFX / Foley / BGM / 字幕 / Rough Cut / Editing / Final Mix、
Image / Video Provider API、Shared Library、顶层 IA 重构、删除资产库、
提高自动化级别（`CURRENT_LEVEL` 仍为 `suggest`）、把 Skill 绑定到某个模型或执行器。

## 7b. Codex 独立审查结果（2026-08-13）

2 轮，全程 **codex**（未回退到 claude，跨模型独立性完整）。停止原因：round 2 的三条
发现**全部不在 TASK-067 范围内**（TASK-064 ×2、TASK-065 ×1），无新的在范围内 P1/P2。

### 已修（都在 TASK-067 自己的代码里）

| 级 | 位置 | 内容 |
| --- | --- | --- |
| **P1** | `skillapply.js` `planApply("shot-asset-recommender")` | 只校验「key 在注册表里存在」，**没有校验它在本次运行看到的候选集里** → 模型可以点名任何已登记资产并被真正绑定。ADR-0064 决策 4 当时只写在 prompt 里、没有被执行。改为 `contextTrace.candidateKeys` 固化许可 + applier 过滤 + 如实报告跳过条数 |
| P2 | `shotctx.js` `traceOf` / `contextRevision` | revision 只指纹前后镜的 **id**，不含内容，也不含项目视觉方向 → 改写上一镜或改视觉基调，缓存结论仍读作 fresh。新增 `neighbourDigest` / `canonDigest` |
| P2 | `app.js` `ctx.shotctx.remember` | 用实时上下文算 baseline → 手工答案晚回来时，旧输入得出的结论被盖上新 baseline，永远读作 fresh。改为从那次运行自己的 `contextTrace` 推导 |

### 驳回 + 转记

- `ctx.frames.reextract` 的 `force: true`（两轮各报一次）—— TASK-065 已驳回过同一条：
  `force` 只由创作者自己的动作传入，锁保护自动化而非创作者。转记到 TASK-064 §4e。
- `case "upsertRelationship"` 不检查关系锁 —— **前提不成立**：`locks.js` 没有
  `relationship` scope。转记到 TASK-065 §8c。
- `ctx.frames.bind` 悬空 `targetShotId` —— 已在 TASK-064 §4d（重复报告）。

## 7c. 追加：接通两个订阅，并落实「Claude Code 执行 / Codex 审阅」（2026-08-13）

产品当天提出两点：AI 全部要跑在**当前订阅账号**上；且 **Claude Code 执行、Codex 审阅**。

### 诊断

`claude` 不在 PATH 上——订阅 CLI 被 VS Code 扩展捆绑在
`~/.vscode/extensions/anthropic.claude-code-<ver>/resources/native-binary/claude.exe`，
扩展从不把它加进 PATH。实测该二进制可用（`2.1.228`），且 server 的原样调用
`[claude, -p, <prompt>, --tools, ""]` 返回 rc=0。**所以不是代码问题，是启动环境问题。**

### 已落地

| 位置 | 内容 |
| --- | --- |
| `run-windows.ps1` | 启动后端前解析两个 CLI：`claude` 不在 PATH 时用通配符回退到扩展自带的（不写死版本号）；找不到就如实报 + 给安装命令。**推荐装独立 CLI**，那样这段变成 no-op |
| `run-windows.ps1` | 新增 `-AllowCodexReview`：codex 的 fail-closed 默认**不被静默推翻**，由运行后端的人显式开启 |
| `services/runtime.js` | `WORK_KINDS` + `EXECUTORS[].suits` + `suggestExecutor(work, isRunnableFor, current)` |
| `workflow/skills.js` | 20 个能力各自声明 `work: "creative" 或 "review"`\| "review"`（14 创作 / 6 审阅） |
| `ui/directorshot.js` | 每个操作解析自己的执行器，并**把执行者名字显示在按钮上**——一次点击要花掉哪个订阅，必须在按下之前看得见 |

### 三条硬规则（守卫测试锁住）

1. **建议，不是绑定**（ADR-0056 决策 1 不变）：创作者的显式选择永远优先，双向都是；
   任何能力都能在任何可用执行器上跑。
2. **Codex 绝不默认进创作位**（§14）。
3. **Codex 缺席时，审阅退回 manual，不退回 Claude Code** —— 让写它的那个 runtime 来
   「独立复核」，独立性就是零。

### 实施中撞到的一个真实缺陷

第一次接通后，六个操作**全部**解析成「手工」。原因：旧的「能力」面板在首次选中某个
Skill 时会把 `ui.skillExecutor` 默认成 `"manual"`，而我把这个**默认值**当成了创作者的
**显式选择**，于是它压过了整套分工。修复：本面板改用独立的 `ui.sdExecutor`，只有创作者
真正点过单选框才写入。**一个默认值不是一个选择。**

## 7d. 一个花了很多时间的环境事实（务必记住）

**用 venv 的 python 启动 server，否则它悄悄退化成 demo 模式。**

`server.py` 的 `connected` = `self._svc is not None`，而 `_svc` 需要 import
`ai_video_workflow`（`pip install -e .` 装进 `.venv`）。用系统 python 启动时这个 import
失败 → `mode: local` → **首页列出的「夜班沉默」是内置示例，不是真实项目**，页面走
localStorage 而不是 `/api/canvas/`。

症状极具误导性：界面看起来完全正常、项目名字一模一样、AI 也真的会去调用订阅 CLI
（server 端确实 spawn 了 `claude -p`），但**运行记录永远不出现在真实项目文件里** ——
因为它们被写进了另一个 store。我为此反复排查了很久，先后怀疑过防抖、并发、多 server
争抢同一个 canvas.json，全都不是。

判据（一秒可查）：

```
curl -s http://127.0.0.1:<port>/api/meta
# connected ⇒ {"contract_version": "1.5", "mode": "connected", ...}
# local     ⇒ {"contract_version": "unavailable", "mode": "local", ...}
```

`run-windows.ps1` 一直用的就是 `$venvPython`，所以**用启动器就不会踩到**；手工起
server 时才会。

## 8. 已知边界（如实记录，未做）

1. **`skillRun.directorReview` / `reviewRun` 仍然没有写入者。** §9 的 Prompt Review 被实现
   为一个**独立能力**（`prompt-reviewer`），它审的是**Prompt 这份文档的当前版本**，产出
   自己的 Proposal。而 `directorReview` 的语义是「AI 导演对**另一次运行的提案**的复核」——
   那是一条不同的链路，本轮没有需要它的场景。它保持未使用，与本轮之前一致。
2. **本轮不向真实项目上传新媒体。** §21-13/14 的 Manual Upload 路径由 TASK-066 验收且本轮
   未改动。验收核实该路径可达 + 真实项目已有 31 条成功生成 / 10 条冻结 Prompt 的溯源链。
3. **`shot-continuity-reviewer` 没有写回路径**（设计如此，§10）。它的结论是只读建议；
   `unknown` 字段让「没发现问题」可信——无法判断的项不会被当成通过。
4. **~~创作型 Skill 在本机没有可用的 local runtime~~ —— 2026-08-13 已解决**，见 §7c：
   订阅 CLI 在 VS Code 扩展里，启动器现在会把它放上 PATH；codex 由 `-AllowCodexReview`
   显式开启。两个订阅都已实测跑通。**旧的 `/api/agent/*` 五个端点仍无手工兜底**，由
   [TASK-068](TASK-068-legacy-agent-endpoints-to-runtime.md) / ADR-0065 承接。
5. **真实项目 `shot-763b60db` 有 2 条指向已不存在参考的历史绑定。** 界面如实不画幽灵卡片，
   编译器也不把它们算作输入。这是既有数据状态，不是本轮引入的；清理它需要一个独立的
   「悬空绑定体检」能力，本轮未立项。
6. **缓存 revision 覆盖的是本轮能枚举的输入**（参考及其版本与解读版本、首尾帧、已选定
   媒体、Prompt 版本、镜头设计、前后镜内容摘要、项目视觉方向）。它不覆盖人物/场景地
   档案正文的改动——那需要把 bible 的内容指纹也拉进来，属于下一轮的收窄。
