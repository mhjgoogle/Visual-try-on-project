# TASK-119：三个用户能力 + 后端 resolver

- 状态：实现完成（2026-08-29）
- 依据：[REQ-007 判据 1–7](../../requirements/REQ-007-say-it-and-the-right-capability-runs.md)
- 架构约束：`CA §2`（依赖方向）· `CA §3`（前后端合同）· `CA §5.2`（不静默覆盖）·
  `CA §5.6`（付费边界）
- ADR：[ADR-0091](../../adr/ADR-0091-three-user-capabilities-and-a-server-side-resolver.md)

## IN SCOPE

1. 能力包格式：`routing` 拆成 `userCapability`（进提示词）+ `internalRouting`
   （只给服务端 resolver），封闭词汇表、fail-closed。
2. 三个用户能力的文案与权威名单（`user-capabilities.json` + `USER_CAPABILITIES`）。
3. 对话 route 合同：模型返回 `capability` / `goal` / `scope` / `missing`，**不返回 skillId**。
4. 服务端 resolver：facade + 他的话 + 范围 + 就绪状态 → 一个确定的内部执行计划。
5. 前端：能不能跑的最后一关、自动起跑、屏幕上说清识别到什么/跑了没有/缺什么。
6. 新增两个诊断能力包：`story-zoom`（跨层同步）、`audience-engagement-reviewer`
   （作者意图 + 观众投入）。
7. 结构性变更之后的跨层**建议**（有根 / 跨层 / 只一次）。

## OUT OF SCOPE

- 页面内的专业按钮/工作流（它们是明确入口，继续直连专业能力）。
- 外部 story-skills 的 Markdown 持久化 / watcher / CLI / 导入器。
- 付费与生成类动作的自动化。
- 把全部 26 个内置能力都接进路由 —— 只接了参与自然语言路由的 15 个，其余不路由
  （页面入口照常）。

## 外部八类意图 → 本产品的映射

| 外部（story-skills / story-zoom） | 用户能力 | 内部能力 |
| --- | --- | --- |
| story-init | story-development | `story-development` |
| plot-structure | story-development | `story-development` / `story-reviser` |
| worldbuilding | story-development | `world-director` |
| character-management | story-development | `relationship-director` |
| （分集规划） | story-development · episode-production | `episode-planner` / `episode-plan-reviser` |
| chapter-writing | episode-production | `script-writer` / `script-reviser` |
| revision-continuity | story-review | `script-doctor` / `continuity-reviewer` / `shot-continuity-reviewer` |
| story-maintenance | story-review | `story-zoom`（本产品内的确定性一致性检查） |
| story-zoom | story-review | `story-zoom` |
| （产品负责人当天追加：观众视角审读） | story-review | `audience-engagement-reviewer` |

`story-zoom` 的五层映射到 Studio 的权威对象：L1 创意简报/故事内核 · L2 大纲主线/
世界规则/分集规划 · L3 剧本场景/分镜 · L4 角色/关系/地点/世界设定 · L5 剧本文本/
镜头描述。输入来自既有权威作品数据；不存在可靠的「自上次以来变更」证据时，
`snapshotOnly: true` 且不得声称历史影响。

## 实现证据

| 判据 | 证据 |
| --- | --- |
| 1 说了就跑 | `server.py:_conv_resolve` + `production.js:runRouteFor` → `ctx.skills.run` |
| 2 不够就说缺什么 | `_conv_resolve` 的 `action: "ask"` + `convroute.js:decideRoute` 的 `blocked`；`tests/studio/test_motv_capability_routing_task119.py::test_missing_inputs_become_an_ask_not_a_silent_run` |
| 3 跑起来 ≠ 已接受 | 走既有 `skillctl.run` → `_land` → `proposeRun`（pending 提案）；`skillapply.js` 里两个新诊断能力显式 `can: false` |
| 4 开发窗口不改作品 | `_conv_check_route` 的第一道闸 + `decideRoute` 的第二道；两侧各有测试 |
| 5 一句话一个、不重复 | `skillrun.js:origin` 持久化 + `skillctl.routedRunFor`；读路径上没有起跑代码 |
| 6 只理解三类 | `_conv_capability_text` 固定 6 行；`test_the_prompt_names_no_internal_capability` |
| 7 确定性选择 | `_conv_resolve` 的六个排序键；`test_the_resolver_picks_the_right_internal_skill`（9 例）+ `test_story_zoom_does_not_swallow_a_plain_check` |

## 还没在真实项目上被人看过

- 真实 Connected Project 上说「帮我搭建世界观」是否真的起跑并产出可用提案
  （本机 `claude` 执行器可用性未在这一轮验证）。
- `story-zoom` / `audience-engagement-reviewer` 的**输出质量**（schema 与提示词已定，
  但没有一次真实运行的答案被人读过）。
- 中文关键词二级选择在真实说法上的命中率（测试用的是 9 个构造句）。

## 独立审查（codex，跨模型，独立性未降级）

5 轮，修掉 4 个 P1，0 个 P2/P3/P4。四道闸最终全绿（详见 `.claude/tmp/last-review.md`
与下面这张表）。四个 P1 是**同一族**：界面看着正常、其实什么都没发生、而且不报错。

| # | 轮 | P1 | 机理 |
| --- | --- | --- | --- |
| 1 | 1 | `routeScopeFor` 读 `skill.routing.scope` | 路由元数据拆成两半后读错一层 → `undefined` → 每处判断都得出「不是 shot」→ 镜头域能力永远起不来 |
| 2 | 2 | `suggestZoomFor` 设了状态不重画 | 它是发送链最后一步，后面没有东西会重画 → 建议永不出现 |
| 3 | 4 | 建议的点击丢掉 `trigger.key` | `origin.idempotencyKey` 从来没被写进去 → 「只跑一次」只剩页面内存，刷新即失效 |
| 4 | 5 | 起跑路径「先查后做」 | 登记表那条记录晚一个微任务才写下 → 结构性的缝（今天不可达，见提交 `a8bbea7`） |

**#3 值得单记一笔**：它之前有一条**为了错误的理由而通过**的测试 —— 手工插了一条带
`idempotencyKey` 的记录，于是证的是「`hasOriginKey` 会读这个字段」，而不是
「真实路径会写这个字段」。现在改成先用 `originForRoute`（生产代码里唯一构造 origin
的地方）造记录，并加了一条接线断言，钉住 key 在「建议 → 点击 → 发送 → 起跑 →
origin」五步里一步都没被丢掉。

## Follow-up

- **`script-doctor` 的写回路径与它的 output schema 对不上**（本次之前就存在）：
  `skillapply.js` 把它路由到 `scriptPlan`（读 `proposal.script`），而它的 schema 只有
  `findings` / `strengths`，没有 `script`。应用它的提案拿不到东西可写。不在本卡范围
  （AGENTS.md 第 17 条），记在这里。
- 其余 11 个内置能力（摄影、资产、提示词、声音、字幕、剪辑等）尚未声明
  `userCapability`，所以自然语言路由到不了它们，页面入口不受影响。要接的话是
  加 `routing` + 升版本，不需要动 resolver。
