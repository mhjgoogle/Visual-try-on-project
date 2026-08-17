# TASK-088：分集规划是一张 AI 写好、我能改的表

- 状态：**已完成（2026-08-18）** —— 由 [TASK-094](TASK-094-story-development-chain.md)
  批次 **A**（`65a3b6c`：episode-planner v2 的七项 + `episode-plan-reviser` + 端点两模式
  + 身份继承）与批次 **B**（`3f1712c`：表格界面、288 格消失、旧字段照常可见）实现。
  §5 暴露的两件事仍未做：48 集清理已由批次 **G**（`64d4d35`）完成，
  「反馈 → Skill 提升」闭环仍未开工（需 ADR）。
- 实施记录：见那两条提交的信息与 [ADR-0072](../adr/ADR-0072-episode-identity-across-plan-revisions.md)。
  一处与本卡不同的事实：**`characterBeats` 的 `who` 存的是角色名**（模型答的就是名字），
  界面对不上人物档案时**标出「未知人物」而不丢弃**——静默丢掉答案会让创作者以为
  AI 什么都没产出。
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：产品负责人 2026-08-17 的三句话（原话见 §0）
- 验收环境：**真实 Connected Project `照见未明rev2`**

---

## 0. 产品负责人说了什么（原话，不转述）

> 「分集规划本来就应该写下面的内容：集数 / 标题、本集核心目标、主要剧情：3～6 条
> 关键事件、角色推进：谁发生了什么变化、关系怎么变化、信息揭示：观众这一集新知道了
> 什么、情绪曲线：平静 → 紧张 → 冲突 → 转折之类、结尾钩子：最后留下什么悬念，
> 推动下一集」

> 「分集规划应该是 AI 用根据故事大纲和 skill 做的。做的我不满意的话我是会手动修改的。」

> 「还有 AI 也可以根据我的修改意见修改内容的吗。一是我可以手动修改。2 是用 AI 改。
> 改过的内容我不太满意的话还可以反馈到 skill 提升上」

> 「分集规划你就列一张表格用 AI 写内容就好了。我要改也可以改」

**三层能力,本卡做前两层**：① 手动改 ② 用 AI 改。
③「反馈到 Skill 提升」**不在本卡**——它动 Skill 包的版本语义，需 ADR（§5）。

---

## 1. 为什么现在的分集规划是错的（实测，不是推测）

### 1.1 「用 AI 改」根本不是改，是重做

```js
generateScriptDraft({ idea, baseScript, instruction })   // 剧本：带 baseScript → 真修订
planEpisodes       ({ outline,          instruction })   // 规划：不带当前规划 → 从头重做
```

`server.py:_PAYLOAD_TO_CONTEXT["episode-plan"] = lambda p: {"outline": p.get("outline")}`
——**当前规划根本不进上下文**。

后果，在真实项目里可见：四个规划版本的标题**完全不同**（v1「不可被救的人」/
v4「第一集｜被抹除的核验员」），因为每一版都是新写的，不是改的。

### 1.2 而 `instruction` 走的是剧本那条路**已经废弃**的通道

`_EXTRA_FENCED["episode-plan"] = (("instruction", "修改要求"),)` —— 它是 **steer**。
`script-draft` 的注释写明为什么不能这样：

> TWO MODES, TWO CAPABILITIES. Revising is not writing … the base script is its
> **DOMAIN CONTEXT, not a steer** —— steer 会被 `compile_prompt` 丢掉，
> 「silently cost the revision mode its base script until a test caught it」。

**规划路径正在用剧本路径已知不安全的做法。**

### 1.3 Skill 产出 7 格，表单摆出 288 格

`episode-planner` 产出 `epNumber / title / synopsis / purpose / hook / endingBeat / duration`。
表单在此之外还有「本集要推进什么」：主线推进 + **每个角色一行** + 关系推进
（`epplanws.js:294-298`）。6 个角色 × 48 集 = **288 个人物推进格，AI 一个字不产出**。

产品负责人的抱怨「为什么那么多重复的内容要写呢」有精确的技术原因：**确实要他写。**

### 1.4 48 集是 1.1 的直接后果

四版规划 × 每版 12 集 = 48 个剧集实体，每次「确认」都新建而不更新。
**修 1.1 是修 48 集的前提** —— 否则修完历史数据，下次迭代又翻倍。
历史数据的清理**不在本卡**（高风险，需 ADR，规则产品负责人已定：更新已有剧集）。

---

## 2. 交付

### 2.1 新的 output schema（产品负责人的七项）

`episode-planner` **发新版本**，不原地改（ADR-0067：已被历史 Run 引用的版本
不得原地覆盖）。字段按原话命名，不用我们的内部词：

| 字段 | 原话 | 说明 |
| --- | --- | --- |
| `epNumber` / `title` | 集数 / 标题 | 保留 |
| `coreGoal` | 本集核心目标 | 取代 `purpose`（界面旧称「戏剧功能」） |
| `keyEvents[]` | 主要剧情：3～6 条关键事件 | **取代散文 `synopsis`**。3–6 条是范围，不足/超出**如实提示，不拦死** |
| `characterBeats[]` | 角色推进：谁发生了什么变化、关系怎么变化 | **AI 产出**，不再手写。`{ who, change, relationChange? }` |
| `reveals[]` | 信息揭示：观众这一集新知道了什么 | **新** |
| `emotionArc` | 情绪曲线 | **新** |
| `endingBeat` + `hook` | 结尾钩子 | **保留两个字段，界面合成一块**——真实数据里它们是两件事：`endingBeat`=最后发生了什么，`hook`=留下的问题。合并会丢一个 |
| `duration?` | —— | 不在产品负责人清单里。**保留但不逐集要求**：从创意的「单集时长方向」派生，仅偏离时填 |

`characterBeats` 的 `who` 必须是**已有角色**（`characters` 已是该 Skill 的
`optionalInputs`）——AI 不得发明人物，这是既有纪律（`prompt.md` 原话
「不得发明大纲里没有的人物或转折」）。

### 2.2 「用 AI 改」照剧本那条路重做

- 新增能力 **`episode-plan-reviser`**，声明输入 `episodePlan` + `revisionRequest`
  —— **当前规划是 DOMAIN CONTEXT，不是 steer**。
- `_skill_id_for("episode-plan", payload)` 按有无当前规划选 planner / reviser
  （与 `script-draft` 完全同构）。
- `_EXTRA_FENCED` 里 `episode-plan` 的 steer **删除**——两个输入都成为声明输入，
  于是 `missingInputs` 能真的把关。
- `command.js planEpisodes` 传 `current_plan`。
- 修订的产出仍是**提案**，不自动生效（既有纪律：应用才成版本，旧版本全留）。

### 2.3 表单变成一张表

一行一集，列就是 §2.1 的字段。**单元格就地可编辑**，保存仍走「追加新版本」这条既有写路径。

- **AI 写了的**：正常显示，可改。
- **AI 没写的**：显示为空，**不摆成待填的格子**——`characterBeats` 只列 AI 实际
  推进了的角色 + 一个「加一个角色」，而不是全员平铺。这是产品负责人那句
  「为什么那么多重复的内容要写呢」的直接答复。
- 「主要剧情」不足 3 条 / 超过 6 条：**标出来，不拦**。
- `keyEvents` / `characterBeats` / `reveals` 是列表，一行一条。

---

## 3. OUT OF SCOPE

- **48 集历史数据的清理与归档**（高风险 · 需 ADR · 规则已定：更新不新建）。
- **「反馈 → Skill 提升」闭环**（§5，需 ADR）。
- **`story-development` 的八项重写**（产品负责人同一轮给了规格，另开卡）。
- **「单集剧情」这一层 / Scene 移到剧本之前**（架构变更，需 ADR，见 §5）。
- 任何 Provider / 付费改动。

---

## 4. 风险分级与检查

**高风险**：Skill 包新版本 + 端点契约（`_PAYLOAD_TO_CONTEXT` / `_EXTRA_FENCED` /
`_skill_id_for`）= **跨层合同** → **2 轮审查 + 全量 pytest + 全量前端 + ruff**。

分批次：
- **批次 A（高）**：schema 新版本 + reviser 能力 + 端点两模式 + `current_plan`
- **批次 B（中）**：表格界面

批次 A 结束跑全量；B 结束跑相关前端 + 定向 pytest。

## 5. 由本卡暴露的两件事 —— **§5.1 已被产品负责人同日修订，见 TASK-091**

> **订正（2026-08-17，同日）**：本节原写「Scene 位置反了，是架构变更 + 可能的数据迁移」
> 与「『单集剧情』这一层要新建」。产品负责人同日给出更具体的流程
> （`该集剧本 → Scene 拆分/确认 → Scene→Shot → …`）并明确「剧本是一集一份」，
> **两条结论均作废**：
>
> - **不需要迁移** —— `scripts[episodeId]` 一集一份不变；`proddoc` 的
>   Episode → Scene → Shot 本来就在剧本之后。
> - **不用新建「单集剧情」层** —— 本卡把分集规划的每一行做厚（核心目标 / 关键事件 /
>   角色推进 / 信息揭示 / 情绪曲线 / 结尾钩子），**那一行就是单集剧情**。
> - **GAP-13 的成因改写**：不是「位置反了」，而是**流程里没有「Scene 拆分/确认」
>   这一步** —— 场景是一个可以完全忽略的可选归组盒。这是小改动，见
>   [TASK-091](TASK-091-episode-production-is-a-nine-step-line.md) §1.2。
>
> 保留原文如下，因为它记录的是当时的判断依据；**执行以 TASK-091 为准。**

### 5.1 原文（已作废，勿据此实施）


产品负责人 2026-08-17 给出的层级关系：

```
故事大纲 → 剧集规划 → 单集剧情 → Scene → 剧本 → Shot List
```

与系统实际**两处不一致**：

1. **「单集剧情」这一层系统里没有** —— 今天从规划的一条梗概直接跳到写剧本。
2. **Scene 的位置反了**。产品负责人：先拆 Scene，再为 Scene 写剧本。
   系统：先写整集剧本 → 拆分镜 → Scene 事后给分镜归组。

**②解释了 GAP-13**（「场景层建了但没人用」——真实项目 48 集全部 0 场景，
60 个镜头全在「未分配到场景」）：按系统的顺序，Scene 出现得太晚，已经没有用处。
审计当时把它记为「需要用户判断的产品问题」，产品负责人现在回答了。

**这是架构变更 + 可能的数据迁移**，不塞进本卡。开工前要先答一个问题：
**剧本是一集一份，还是一个 Scene 一份？**（前者 Scene 只是分节；后者
`scripts[episodeId]` → `scripts[sceneId]`，是迁移。）产品负责人尚未回答。

另：「反馈 → Skill 提升」的地基**已经存在** ——
`skillpkg.SOURCE_ORDER = ("project", "user", "builtin")`，项目的
`studio/skills/*/prompt.md` 是 creator-authored。**机制在，入口零。**
接它需 ADR（动 Skill 包版本语义）。
