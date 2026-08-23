# TASK-089：故事大纲写这八项就够了

- 状态：**已完成（2026-08-18）** —— 由 [TASK-094](TASK-094-story-development-chain.md)
  批次 **C**（`002b571`：story-development v2 的八项 + `story-reviser` + 端点两模式）
  与批次 **D**（`87c4edf`：那一页变成审阅面）实现。
- 实施记录：§2.2 的四个清单外字段逐条落地（`episodeCount` / `durationNote` /
  `genreTone` 保留；`premise` 合并进 `storyCore` 但**保留旧字段读取**，
  `storyCoreOf()` 是那条 fallback 的唯一实现）；`logline` / `world` /
  `centralConflict` / `storyArc` / `climax` / `ending` 同样保留，因为真实项目四版
  大纲全写在它们里。
  一处比本卡更严的做法：**编辑时不去重旧字段**（读态才去重）——标题那一格绑的是空的
  `storyCore`，编辑时把旧字段藏起来会让磁盘上真实存在的内容既改不了也删不掉。
- 负责 Agent：单一实施 Agent（AGENTS.md 第 14 条）
- 依据：产品负责人 2026-08-17 的规格（§0 原话）
- **前置：TASK-088 已完成并提交** —— 同一套机制（Skill 新版本 + 表单按新 schema 重做），
  088 先走一遍，089 照它的形状做，不要并行（两卡都改 `server.py` 的
  `_PAYLOAD_TO_CONTEXT` / `_EXTRA_FENCED`，并行必撞）
- 验收环境：**真实 Connected Project `照见未明rev2`**

---

## 0. 产品负责人说了什么（原话）

> 「我建议故事大纲写这 8 项就够了：
> **故事核心** 一句话说明这个故事讲什么。
> **主角与目标** 主角是谁。她/他最开始想要什么。
> **核心冲突** 什么力量阻止主角。外部冲突 + 内部冲突分别是什么。
> **世界与核心规则** 故事发生在哪里。有哪些会直接影响剧情的重要规则。
> **主要角色关系** 主角和男主、男二、反派等分别是什么关系。关系如何变化。
> **故事主线** 开端 / 发展 / 中段重大转折 / 高潮 / 结局
> **核心秘密 / 信息揭示顺序** 哪些真相不能一开始告诉观众。大概什么时候揭露。
> **主题与最终变化** 故事最终想表达什么。主角经历整个故事后变成了怎样的人。」

同一轮还给了层级关系：
`故事大纲 → 剧集规划 → 单集剧情 → Scene → 剧本 → Shot List`
（那条的两处不一致见 TASK-088 §5，**不在本卡**。）

---

## 1. 现状对照（实测 `product-skills/builtin/story-development/output.schema.json`）

现有产出：`premise / logline / genreTone / world / centralConflict / storyArc /
climax / ending / characterConcepts[] / episodeCount / durationNote`
（required：`premise, logline, centralConflict, storyArc, climax, ending`）

| 产品负责人要的 | 现状 | 差距 |
| --- | --- | --- |
| **故事核心**（一句话） | `logline` | ✅ 改个名 |
| **主角与目标** | `characterConcepts[]` | 🟡 有角色概念，**「最开始想要什么」没有** |
| **核心冲突**（外部 + 内部分别） | `centralConflict` 单字段 | 🟡 **没分外部 / 内部** |
| **世界与核心规则** | `world` | 🟡 **「直接影响剧情的规则」没有单列** —— 这部戏的「源律」正是它 |
| **主要角色关系 + 关系如何变化** | 不在大纲里（另有「人物关系」页） | 🔴 **大纲不含关系** |
| **故事主线**（五段） | `storyArc` + `climax` + `ending` | 🟡 三个散字段，**不是五段结构** |
| **核心秘密 / 揭示顺序** | —— | 🔴 **全新** |
| **主题与最终变化** | —— | 🔴 **全新** |

`premise` / `genreTone` / `episodeCount` / `durationNote` 四个不在清单里 —— 处理见 §2.2。

## 2. 交付

### 2.1 `story-development` 发新版本（不原地改，ADR-0067）

字段按**原话命名**，不用内部词：

```
storyCore            故事核心：一句话
protagonist          { who, initialWant }        主角与目标
conflict             { external, internal }      核心冲突，分开写
worldAndRules        { where, rules[] }          世界与核心规则
keyRelationships[]   { between[], nature, howItChanges }   主要角色关系
mainline             { setup, development, midpointTurn, climax, ending }  五段
secretsAndReveals[]  { truth, whyNotUpfront, revealAround }  核心秘密 / 揭示顺序
themeAndChange       { theme, protagonistBecomes }          主题与最终变化
```

- **`mainline` 是一个五段对象**，不是三个散字段 —— 产品负责人把它列成一项。
- **`keyRelationships[].howItChanges`** 与 TASK-088 的 `characterBeats[].relationChange`
  是**同一件事的两个层级**（大纲讲总体走向，分集讲某一集发生了什么）。
  **不得互相覆盖**，也不得只留一个。
- `worldAndRules.rules[]` 是**列表** —— 「有哪些会直接影响剧情的重要规则」是可枚举的。

### 2.2 四个清单外字段怎么处理（**不许静默删**）

| 字段 | 处理 | 理由 |
| --- | --- | --- |
| `episodeCount` | **保留** | 它就是「目标集数 24」。TASK-088 之后它要与规划条数**互相校验**（今天三个数字互不校验，是 48 集那个缺陷的一部分） |
| `durationNote` | **保留** | 分集规划的 `duration` 从它派生（TASK-088 §2.1） |
| `genreTone` | **保留** | Prompt 编译在用（`promptc.js` 的「大纲题材基调」） |
| `premise` | **合并进 `storyCore`** | 与 `logline` 语义重叠；合并时**保留旧字段读取**，加法迁移 |

**逐条在卡里写明去向** —— 删一个正在被用的字段而没人发现，是本仓库反复出现的那类缺陷。

### 2.3 表单按新 schema 重做成审阅面

与 TASK-088 同一姿态：**AI 写，人改**。

- AI 写了的正常显示、可编辑；**没写的不摆成待填格子**。
- 列表字段（`worldAndRules.rules` / `keyRelationships` / `secretsAndReveals`）一行一条，可增删。
- `mainline` 五段固定顺序显示 —— 顺序本身是信息。
- 保存仍走「追加新版本」这条既有写路径，**旧版本全留**（既有纪律）。
- 「批准大纲」仍是分集规划的前置门（既有纪律，不动）。

### 2.4 「用 AI 改」照 TASK-088 的样板

`story-develop` 端点**今天已经带 `current`**（`_PAYLOAD_TO_CONTEXT` 里
`{"brief": p.get("idea"), "outline": p.get("current")}`）—— 比分集规划好，
但要确认 `instruction` 是否也走 steer（若是，按 TASK-088 同一理由改成声明输入）。

## 3. OUT OF SCOPE

- 层级关系那两处不一致（「单集剧情」这一层 / Scene 移到剧本之前）—— TASK-088 §5，需 ADR。
- 作品设定的位置与姿态 —— TASK-090。
- 48 集历史数据清理 —— 另卡。

## 4. 风险分级

**高**（Skill 包新版本 + 端点契约 = 跨层合同）→ **2 轮审查 + 全量**。
分批次：A = schema 新版本 + 端点；B = 表单。

## 5. 测试

- 八项每一项都有产出与显示（守卫测试，键集**从 schema 派生**，不手写）
- §2.2 四个字段的去向逐条断言 —— 保留的仍可读，合并的旧字段仍被接受
- `keyRelationships[].howItChanges` 与 `characterBeats[].relationChange` **互不覆盖**
- 「AI 改」带上当前大纲（不是重做）
- AI 没写的字段**不渲染成待填格子**
