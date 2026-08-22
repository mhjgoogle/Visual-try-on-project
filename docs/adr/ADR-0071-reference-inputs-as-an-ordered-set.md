# ADR-0071：参考输入从「按角色写死的槽位」改为有序集合，Provider 声明它能吃几张

- 状态：**Accepted（2026-08-17，产品负责人）** —— 唯一悬着的那件事（多图之后
  一次生成的报价怎么算）已由产品负责人拍板：**方案 C**。CLAUDE.md 要求涉及**付费**
  的 ADR 由用户 Accept，这一条已满足。其余部分（领域形状、Prompt 引用语法、
  Provider 契约、fail-closed 降级）本来就属技术范畴，已定。
- **生效的报价口径（方案 C）**：**只支持「多图不额外计费」的 provider**；
  其余在 catalog 里标 `max: 0` 并 **fail-closed 拒绝**，我们**不替 provider 算钱**。
  可用面因此最窄 —— 这是产品负责人接受的代价。
- 实施：[TASK-083](../tasks/TASK-083-phase3-adrs-first.md) ADR-A
- 依据：[UI Gap Audit](../../src/ui-gap-audit/) GAP-27 / GAP-28
- 相关：[ADR-0041](ADR-0041-paid-generation-write-path.md)（packet-only 两步提交）、
  [ADR-0061](ADR-0061-three-spaces-and-reference-roles.md) 决策 4（八个参考角色 /
  model-input vs ai-interpretation）、[ADR-0038](ADR-0038-multimedia-provider-abstraction.md)、
  [ADR-0009](ADR-0009-minimax-provider.md)

---

## 背景

### 我们今天能送给模型的图像，只有一张

审计实测的整条链（GAP-28）：

```
shot.first_frame_image
  → packets.py:70   first_frame_image: str | None
  → ProviderRequest.provider_parameters
  → cloud_minimax.py:_payload
body = { model, prompt, duration, resolution, first_frame_image? }
```

`ProviderRequest`（`providers/models.py:251`）**没有任何多图字段**。

### 而界面说的不是这个

`geninput.js` 的 `ROLE_USE` 把四个角色标成 `"model-input"`，`ROLE_USE_LABEL`
在界面上写 **「模型直接输入」**：

```js
"character-reference": "model-input",   // 人物参考
"location-reference":  "model-input",   // 场景参考
"prop-reference":      "model-input",   // 道具参考
"style-reference":     "model-input",   // 风格参考
```

`promptc.js` 还会编出「**（作为参考图一并提供，保持一致）**」。

**在 Gateway 付费路线上这句话是假的** —— 那四类参考图没有任何字段能承载。
TASK-077 §1.3 已经把**措辞**改成如实（按 Provider 真实能力标注），
但**能力本身**仍然缺席：创作者绑了三张人物参考，模型一张也看不到。

> 免费 / 手工路线上那句话是对的 —— 那是给创作者的指示，他会自己把图拖进外部
> 网页工具。本 ADR 要消除的是**付费路线**上的那个缺口，不是把手工路线的措辞改掉。

### 目标产品的实测形态（不是猜的）

从 LibTV 自己的 API 抓的（`GET api.liblib.tv/api/canvas/project/detail`，
只读页面加载，零花费）：

```json
"params": {
  "prompt": "在 {{Image 1}} 石头两侧增加 {{Image 3}} {{Image 5}} 女人与{{Image 4}}{{Image 6}}男人…姿势参考 {{Image 2}}",
  "model": "nebula-ultra",
  "modeType": "image2image",
  "imageList": [{ "nodeId": "…", "url": "…", "label": "石头", "width": 6336, "height": 2688 }, …],
  "imageListOrder": [...],
  "textList": [], "videoList": [], "audioList": []
}
```

四个要点，本 ADR 借三个、拒一个：

| LibTV 的做法 | 借不借 | 理由 |
| --- | --- | --- |
| 参考是**有序数组**，每项带来源 id + 尺寸 | **借** | 顺序即编号，编号即 Prompt 里的指代 |
| Prompt 里用 **`{{Image N}}` 占位符** | **借**（改语法，见决策 2） | 让「哪张图起什么作用」由提示词说明，而不是由槽位名说明 |
| **顺序单独存**（`imageListOrder`） | **借** | 重排参考不必改 Prompt 文本 |
| `nodeId` 指回画布节点 | **不照抄** | 我们的对应物是 `assetId + version`，而且必须**带 digest 锁定**（ADR-0041 的既有纪律） |

---

## 决策

### 决策 1：参考输入是**有序集合**，八个角色仍然存在，但它们是**标注**不是槽位

今天的模型是「每个角色一个槽位」。它在标准镜头上够用，在试验性镜头上是墙：
创作者不能说「这一镜我要用这 3 张图 + 这段文本当输入，第 2 张只借它的姿势」。

新形状：

```
referenceInputs: [
  { ordinal: 1, assetId, version, contentDigest, role, note },
  { ordinal: 2, assetId, version, contentDigest, role, note },
  …
]
```

- **`ordinal` 是权威的编号**，从 1 起、连续、无洞。它是 Prompt 里指代的那个数字。
- **`role`** 仍是 ADR-0061 决策 4 的八个角色之一 —— **保留，不推翻**。它现在的作用
  是「这张图是什么」（供 Skill 与人阅读、供 Provider 能力匹配），不再是「它占哪个坑」。
- **`note`** 是可选的自由文本（「只借姿势」），进 Prompt，不进契约判断。
- **`version` + `contentDigest` 必带**。这是 ADR-0041 已有的纪律
  （`reuse_assets: {asset_id, version, content_digest}`）—— 一次付费生成必须绑定
  它实际用的那个版本，否则「同参数重跑」无从定义。

**顺序与内容分开存**：重排只改 `ordinal`，不重写 Prompt 文本（决策 2 的前提）。

### 决策 2：Prompt 里的引用语法是 `[[ref:N]]`，不是 `{{Image N}}`

借机制，不借拼写。三条理由：

1. **我们的 Prompt 是编译出来的**（`promptc.js`），不是人手写的。编译器要能
   **无歧义地找回并替换**这些标记；`{{…}}` 在中文创作文本里出现的概率不低
   （创作者会写「{{}}」当占位），`[[ref:N]]` 冲突面更小。
2. **`Image` 这个词会说谎**。同一机制以后要承载文本/视频/音频引用
   （LibTV 的 `textList` / `videoList` / `audioList`）。`[[ref:N]]` 对类型中立，
   类型由 `referenceInputs[N].role` 说，**一处权威**。
3. 未被任何 `[[ref:N]]` 引用的参考**仍然要送**（它是「一并提供保持一致」那类），
   所以标记是**指代**而非**清单**——两者不能混成一个语法。

**编译与校验规则**（fail-closed）：

- 编译时：`[[ref:N]]` 的 N 必须存在于 `referenceInputs`，否则**拒绝编译**并报出
  哪一个悬空 —— 不静默删标记（那会让 Prompt 读起来仍然通顺但少了一张图）。
- 反向：`referenceInputs` 里有、Prompt 里没引用的，**不是错误**，是「一并提供」。
- 校验发生在**编译期**，不是提交期。理由与 ADR-0031 的 provenance 同源：
  越早说不知道越好。

### 决策 3：`ProviderRequest` 新增 `reference_images`，形状与 `reuse_assets` 同构

```python
reference_images: tuple[ReferenceImage, ...]  # 加法字段，默认空
# ReferenceImage = { ordinal, url_or_data, role, asset_id, version, content_digest }
```

- **加法字段，默认空元组** —— 现有 provider 与现有 packet 一行都不用改
  （AGENTS.md 第 13 条：加法字段优先于破坏性变更）。
- `first_frame_image` **保留不动**。它不是「第 0 张参考」，它是**条件帧**
  （image-to-video 的起点），语义与「参考」不同，合并会让两个概念一起变模糊。
- packet 侧同样加法：`reference_images` 与既有 `reuse_assets` 并列
  —— 后者是「这次生成用到了哪些复用包资产」（合规/审计），前者是
  「这次生成把哪些图送给了模型」（执行）。**两者都要，不能互相顶替。**

### 决策 4：**catalog 声明能力，Provider 不猜**

catalog（`config/providers`）每个 model 新增：

```yaml
reference_images:
  max: 0            # 0 = 这个 model 不吃参考图
  addressable: false # 能不能在 prompt 里用 [[ref:N]] 指代第 N 张
  roles: []          # 只接受哪些 role（空 = 不限）
```

- **MiniMax `video_generation` 是 `max: 0`**。它只吃 `first_frame_image`，
  这是实测（`cloud_minimax.py:_payload`），不是保守估计。
- **不得给 Provider 留「自己判断」的空间**。能力是 catalog 的事实，
  provider 只负责按它拼请求；不一致时 **fail-closed 拒绝提交**。

### 决策 5：能力不足时**如实降级，不静默丢弃**

这是本 ADR 与 TASK-077 §1.3 的接续，也是整条链上最容易再犯的地方。

| catalog 说 | 界面必须说 | 送出什么 |
| --- | --- | --- |
| `max: 0` | 「这 N 张参考**不会进模型**，只会被 AI 解读成 Prompt 里的文字」 | 只送 `first_frame_image` |
| `max: 3`，绑了 5 张 | **拒绝提交**，列出超出的两张，让创作者选留哪三张 | —— |
| `addressable: false`，Prompt 里有 `[[ref:N]]` | **拒绝提交**，说明这个 model 不认编号指代 | —— |

**第二、三行是拒绝，不是截断。** 悄悄丢掉第 4、5 张是「界面显示已应用、实际没应用」
那一族 —— 本次审计从头到尾在修的就是它。

### 决策 6：报价 —— **本 ADR 不定，见下节**

`packet` 已经带 `quote_minor_units` / `quote_currency` / `estimate_jpy` /
`p50_jpy` / `p90_jpy`，报价在 **packet 编译期**产生，由 Gateway preflight 交给界面。
多图会不会改变这个数字，取决于每个 provider 的计费规则，而那是**花用户钱**的事。

**技术上本 ADR 只固定一条不变量**：

> **报价必须仍然只来自 Gateway preflight，前端与 provider 都不得自算。**

这条不需要产品负责人拍板，它是既有纪律（TASK-078 批次 B 已有守卫测试）。
需要拍板的是**口径**，见下。

### 决策 7：不做的（明确排除）

- **不改 `submit-video-generation` 的 packet-only 契约**。ADR-0041 的
  「不接受自由参数改动已锁定方案」保留 —— 参考集合进的是**packet 编译**，
  不是提交时的自由参数。这也回答了 TASK-078 批次 B 停下的那个问题
  （「选模型再生成」需要新的 packet 编译入口，不是给命令加参数）。
- **不动八个角色本身**（ADR-0061 决策 4）。
- **不实现文本 / 视频 / 音频引用**。语法为它们留了位置（决策 2 第 2 点），
  实现另开卡。
- **不做 LibTV 的 `nodeId` 那种「指回画布节点」**——我们指回 Asset Registry。

---

## 留给产品负责人的那一个问题

**支持多参考图之后，一次生成的报价怎么算？**

三个选项，代价不同：

| | 做法 | 代价 |
| --- | --- | --- |
| **A** | catalog 为每个 `model × 图数` 维护报价，Gateway 照表出价 | 最准。但 provider 改价我们就滞后，且要维护一张会过期的表 |
| **B** | 认为图数不影响报价（若 provider 确实如此），报价照旧 | 最简单。**风险**：一旦某个 provider 按图数计费，我们的报价就是错的 —— 而那正是这一整轮在修的「界面说的和事实不符」 |
| **C** | **只支持「多图不额外计费」的 provider**；其余在 catalog 里标 `max: 0`，fail-closed 拒绝 | 最诚实，不替 provider 算钱。可用面最窄 |

**实施 Agent 的建议：C。** 理由：与本轮姿态一致（不确定就说不确定，不猜），
且不需要我们承担「替 provider 算钱」这个必然会算错的责任。当某个 provider 的
多图计费规则确实明确了，再把它从 C 挪进 A —— 那是加法，不是返工。

### 产品负责人的答复（2026-08-17）

> 「都按你的建议来。」

**选定 C。** 因此实施时的硬约束：

1. Gateway **不得**为「多图是否加价」做任何推断或估算。
2. catalog 里没有明确声明「多图不额外计费」的 provider，其 `maxImages` 记 `0`
   —— 即在该 provider 上多图路线**不可用**，界面如实说明原因（不隐藏、不静默降级）。
3. 报价仍**只**来自 Gateway preflight（决策 6 的不变量），界面永不自算。
4. 与 ADR-0041 的 packet-only 两步提交不冲突：C 收窄的是「哪些 provider 可走多图」，
   不是提交流程。


**这一处定下来之后，本 ADR 才能从 Proposed 转 Accepted。**

---

## 后果

### 好的

- 创作者能说「用这 3 张图，第 2 张只借姿势」——今天说不了。
- 「哪张图起什么作用」由 Prompt 说明，可读、可审、可复现。
- `version + contentDigest` 让「同参数重跑」第一次有确定含义
  （TASK-079 那条 redo 语义的 follow-up 因此有了地基）。
- 界面**不再需要**在「模型直接输入」这件事上含糊：catalog 有事实，UI 照说。

### 代价

- catalog 多一组字段，每个 model 都要填 —— 漏填按 `max: 0` 处理（fail-closed）。
- `promptc.js` 要做标记编译与悬空校验，比今天纯拼接复杂。
- **迁移**：现有的槽位绑定要映射成 `ordinal`。加法迁移，旧字段保留，
  按 AGENTS.md 第 13 条留可回滚的旧数据。

### 风险

- **最大的风险不是技术，是又一次「不变量只覆盖一半」**（TASK-087 §7 那六条的形状）。
  本 ADR 有三处 fail-closed（决策 2 悬空标记、决策 5 超额、决策 5 不可指代），
  每一处都必须有**变异验证过的**守卫测试，且键集/能力表要**派生**而非手写。
