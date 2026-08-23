# 「AI 写好、你审、你也能让 AI 再改」——这条链的共同机制

- 依据：[TASK-094](../tasks/done/TASK-094-story-development-chain.md) §1（批次 0）
- 适用范围：故事开发三段（[TASK-088](../tasks/done/TASK-088-episode-plan-as-an-ai-written-table.md) /
  [TASK-089](../tasks/done/TASK-089-story-outline-eight-items.md) /
  [TASK-090](../tasks/done/TASK-090-bible-is-derived-and-comes-last.md)），以及后续任何
  「表单变审阅面」的改动
- 状态：**批次 0 已落地**（机制存在且被 `script-draft` 用新写法重新表达了一遍）

本文件记录**做一次、用三次**的那三样东西。它不是新决策，是把已经被验证过一次的
形状写下来，避免后面两段各自重新摸索一遍。

---

## 1. 「AI 改」的形状：两个能力，两个模式

`script-draft` 已经把这件事做对过一次，而且它的注释写明了为什么：

> TWO MODES, TWO CAPABILITIES. Revising is not writing … the base script is its
> **DOMAIN CONTEXT, not a steer** —— steer 会被 `compile_prompt` 丢掉，
> 「silently cost the revision mode its base script until a test caught it」。

### 1.1 一张表，三个读者

`server.py` 的 `_TWO_MODES` 是这条规则的**唯一定义**：

```python
_TwoModes(writer=…, reviser=…, steer_key=…, base_key=…, base_decides=…)
```

三个读者：`_is_revision(slug, payload)` 判断模式，`_skill_id_for` 选包，
`_extra_fenced` 决定 steer 怎么进 prompt。**不得再写第四处判断**——三份拷贝正是
其中一份会跟另两份不一致的成因。

### 1.2 `base_decides` 为什么不是所有端点都一样

| 端点 | `base_decides` | 理由 |
| --- | --- | --- |
| `script-draft` | **False** | 初稿模式吃 `idea`，所以「带 instruction 但没有 base_script」不是一种合法请求，**必须响亮地拒**（`missingInputs` 负责），而不是悄悄写一份新剧本盖掉创作者的稿 |
| `episode-plan` / `story-develop` | **True** | 同一个 payload 形状**合法地**表示「重新生成一份，按这个方向」——今天的「🪄 重新规划」发的就是它。没有 base 时选 writer，不是报错 |

这个差异是**有意的**，写在 `_TwoModes` 的文档字符串里。抹平它会让 `script-draft`
的安全性质降级。

### 1.3 steer 的角色随模式变，所以 `_EXTRA_FENCED` 必须按模式读

同一个 `instruction`：

- **writer 模式**：它是 per-run steer，writer 的声明输入里没有它的位置 → 照旧
  进 `_EXTRA_FENCED` 的围栏。
- **reviser 模式**：它**是** reviser 的声明输入（`revisionRequest`）→ 不再另外
  围一遍，否则同一段创作者文本会以两个不同标题进 prompt 两次。

因此**一律经 `_extra_fenced(slug, payload)` 读，不得直接读 `_EXTRA_FENCED`**。
`script-draft` 当年可以把表项整条删掉，是因为它的 writer 模式**没有** steer；
另两个端点有，整条删掉等于静默丢弃 writer 模式的方向指令。

### 1.4 每段要做的四件事

1. 新增一个 `*-reviser` 能力包（三件套，见 §3），声明输入 = **当前内容 + 修改要求**
2. 在 `_TWO_MODES` 里登记这个端点
3. `_PAYLOAD_TO_CONTEXT` 按模式给不同的 context（照 `script-draft` 的样子）
4. 前端把**当前内容**真的发出去（不发，reviser 就没有可改的东西）

产出仍然是**提案**：应用才成版本，旧版本全留。这条纪律不因为「是修订」而放松。

---

## 2. 「审阅面」的姿态：`src/ui/reviewface.js`

产品负责人 2026-08-17 的原话是「为什么那么多重复的内容要写呢」。精确成因：
分集规划摆了 6 角色 × 48 集 = **288 个输入框，AI 一个字都不产出**。

所以这一层只有一条规则：

```
AI 写了的  →  正常显示、可编辑，原样呈现
AI 没写的  →  一行说明 + 一个「自己写」的入口。绝不预先摆一格一格的空框
```

模块提供：`written()` / `countNote()` / `countChip()` / `absentRow()` /
`reviewText()` / `reviewList()` / `notRunYet()` / `bindReviewFace()`。

三条不变量（有守卫测试 `tests/reviewface.test.mjs`）：

- **空列表不渲染任何一行**——这正是 288 格缺陷的形状。
- **范围是提示，不是闸门**。「主要剧情 3～6 条」不足/超出**标出来**，
  仍然能保存：写到一半的创作者不是在犯错。
- **「自己写」的 hook 和字段的写 hook 是两个不同的属性**。前者只是把控件显示
  出来（页面级 ui 状态），后者才写文档；混用会把点击绑到文本写入器上。

模块**只负责形状**：数据 hook 由调用方传入，写路径仍然是页面既有的
`bindField`（ui/fieldsync.js 拥有自动保存 / 光标 / 输入法的规则，这里不重复实现）。

保存**一律走「追加新版本」这条既有写路径，不建第二条**。

---

## 3. Skill 包发新版本的统一纪律（ADR-0067）

**已被历史 Run 引用的版本不得原地覆盖** → 改内容就**升 `skillVersion`**。

- `manifest.json` / `prompt.md` / `output.schema.json` 三件套，任一改动都算内容
  改动（`skillDigest` 覆盖三个文件）。
- 目录名必须等于 `skillId`（loader 校验）。
- `manifest.json` 不认识的字段会被**拒绝**，不是忽略。
- `inputs` 里的键必须在 `product-skills/skill-inputs.json` 里有标签，否则 prompt
  里会出现裸键名。
- schema 迷你语言只有 `object / array / string / number / boolean`，可用约束是
  `required / fields / of / minItems / maxItems / nonEmpty / values`；
  **没有「什么都接受」的写法**，这是有意的。
- 新增能力目录数会变（本链 F2 把 21 → 22），界面上「N 个能力」是从目录数来的。

### 3.1 加字段就是加字段，不是破坏性变更

新的输出字段落到持久化文档时，遵循 `canvasschema.js` 已有的那条规则
（该文件 `additivePresent` 的注释）：

> **缺失（或显式 null）合法**——早于这个字段的文档就是没有它；
> **存在但形状不对，整份文档拒收**——一个畸形的加法字段不是「可以忽略的字段」。

因此本链新增的 outline / plan 字段**不升 canvas schema 版本**，与既有加法字段
同一标准。
