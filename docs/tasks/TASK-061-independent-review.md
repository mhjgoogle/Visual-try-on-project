# TASK-061 独立审查记录（第 1 轮）

- 审查者：TASK-057 会话（独立审查角色，AGENTS.md 规则 15）
- 实施者：TASK-061 会话（唯一实施 Agent，规则 14）
- 审查基线：`38f1168`（已提交部分）
- 结论：**已提交的基础不存在阻塞缺陷**；27 项真实行为验证全部通过，1 项 P3 记录在案。

本文件是 TASK-061 的伴生审查记录，**不写进
[TASK-061 任务卡](TASK-061-asset-library-and-episode-production-ui.md)本体**：那份卡
当前未提交且正被实施会话编辑，直接改它会覆盖对方正在写的内容（AGENTS.md 规则 16）。
实施者可在自己的节奏下把本文件的结论并入任务卡。

## 1. 审查方式

不读源码断言，而是驱动真实模块、真实数据：真实 `mediaref` 版本链换 take、真实
`buildProvenanceGraph`、真实 `serialize → createProduction` 往返（等同 reload）。
脚本在审查者的 scratchpad 中，不进仓库、不改任何实现文件。

## 2. 覆盖与结果

| 风险区 | 验证项 | 结果 |
| --- | --- | --- |
| 1 Script/Scene/Shot | 未归属 Shot 不被归入 Episode/Scene（`episodeId=null`，仍在清单中） | ✅ |
| 1 | 剧本改动移除的 Shot 标为 `dangling`，不静默丢失 | ✅ |
| 1 | Episode scope 不吸收未归属镜头的 lineage | ✅ |
| 1 | Scene 与 Shot 是两个层级；Scene 分组不含别处镜头 | ✅ |
| 2 Reference Planning | 共享 Reference 是单一 canonical Asset 的 key（两个绑定、无副本） | ✅ |
| 2 | 同一 Shot 重复绑定是 no-op（不产生重复） | ✅ |
| 2 | 失效 Reference 被 prune 而非猜测；有效绑定保留 | ✅ |
| 2 | CharacterState/LocationState：未知 state 被拒、facet 白名单生效、reload 后解析正确 | ✅ |
| 3 Generation Input Set | `promptSnapshot` 冻结后不可变（调用方改动 / 完成 / reload 都不影响） | ✅ |
| 3 | 参数快照是深拷贝，密钥被脱敏、不入 canvas | ✅ |
| 3 | 手工生成不伪装成 API 生成（无 provider/model/prompt，图上无 PROMPT 节点） | ✅ |
| 3 | 输入集如实记录；没有输入不被虚构 | ✅ |
| 3 | 上传结果回到正确 Shot/Generation；失败记录不被迟到结果复活 | ✅ |
| 3 | 并发同 task 时拒绝猜测归属（宁可留 `generating`，不错连） | ✅ |
| 4 Asset Registration | 写入媒体即带 declaration（kind/links/tags/reusable 内联） | ✅ |
| 4 | 未分类媒体被诚实标为 `needsReview`（不是静默半登记） | ✅ |
| 4 | 跨域 declaration 在写字节前被拒；本域合法 kind 被接受；`external-reference` 不绑定域 | ✅ |
| 4 | `ASSET_KINDS` 12 种只覆盖媒体/Reference——Brief/剧本/Scene/Shot 等文本域没有被登记成 Asset | ✅ |
| 5 Provenance | 历史 take 不被 active 版本覆盖，各自保留 `producedBy` | ✅ |
| 5 | 首帧只归属**最新** take，旧 take 保持「未知」 | ✅ |
| 5 | 失败的生成被保留（不静默消失） | ✅ |
| 5 | 删除的媒体保留 lineage，缺失 reference 不被猜类型（显示「已删除的媒体」） | ✅ |
| 5 | 共享 reference 在图上是一个节点两条边 | ✅ |
| 5 | 成片归属到那次 render；render 不被虚构出 PROMPT 节点 | ✅ |
| 6 Asset Library | tags/reusable 不污染 canonical `links`；标签去重 | ✅ |
| 6 | active/historical 由版本链 `current` 决定；每个版本只出现一次（不 double count） | ✅ |
| 7 Playback/Review | 缺失媒体 / 空 shot 不让读模型崩溃（`media=null` 也不抛） | ✅ |
| 7 | approval 绑定具体 take、换 take 不继承、stale 不算通过、reload 保留 | ✅（见 TASK-060 §5A 验证） |

另外确认：`ctx.shot.isApproved` / `ctx.shot.review`（app.js:1648-1649）是较弱的
「有记录即可」判定，但**全仓库没有 UI 消费者**——所有显示「已通过」的界面都走
`shotStage`（内部用 `isApprovedFor`），Episode 的「审片 N/M」徽标
（production.js:362）走 `dailies.model()`。目前没有弱路径。

## 3. 发现（交 TASK-061 owner 处理）

### F1（P3）未知 generation status 被静默降级为 `generating`

- **位置**：`mockups/motv-workspace/src/workflow/genlib.js:167`
  `status: STATUSES.has(entry.status) ? entry.status : "generating"`
- **复现**：`startGeneration(reg, {type:"video", targetId:"shot-1", status:"succeeded"})`
  （`succeeded` 不在词表里，合法值是 `queued/generating/success/failed/cancelled`）
  → 记录被写成 `status:"generating"`，返回值非 null，调用方拿不到任何错误信号。
  界面上这条任务会永远停在「生成中」。
- **期望**：与同函数对 `type` 的处理一致——未知 `type` 直接 `return null`（拒绝），
  未知 `status` 也应拒绝或至少让调用方可发现，而不是伪装成一个看起来正常的运行中记录。
- **当前影响**：**尚未发生**。现有 9 个调用点全部传 `"generating"`。但
  TASK-061 正在新增 manual generation flow / Generation Input Set 的调用点，这是
  一个会静默生效的陷阱，建议在新增调用点之前收口。
- **附带**：审查脚本本身就踩了这个坑（先用了 `"succeeded"`，静默变成
  `generating`，断言仍然通过）——这正说明它有多容易被忽略。

## 4. 本轮未审（留给最终 integrated review）

TASK-061 声明 ownership 且仍在编写中的文件，审半成品只会产生噪音：

    src/workflow/assetusage.js · geninput.js
    src/ui/assetlibws.js · refplan.js · episodews.js · refpicker.js
    src/ui/wfgraph.js（Reference/Prompt 层扩展）· workflow/provenance.js（扩展部分）

`mockups/motv-workspace/server.py` 在工作树里有未提交改动（属对方），本轮不审其
上传/登记端点；最终审查时以提交后的版本为准。

风险区 6 的 usage 计数、search/filter 是否基于真实 metadata、path/raw ID 是否
成为主 UI，以及风险区 3 的 Start/End Frame 记录，都依赖上述 in-flight 文件，
一并留到最终审查。

## 5. 最终 integrated review 的准入清单

TASK-061 提交后按以下顺序验证（每项都要真实行为，不接受源码字符串断言）：

1. 真实 Connected Project 上的 Episode → Scene → Shot 联动：改剧本后 Shot 断链
   是否显示为 `dangling` 而不是消失。
2. Reference Planning：同一 Reference 绑定到多个 Shot 后，Asset 侧仍是一个资产；
   删除该 Asset 后绑定被 prune 且 UI 不显示幻影 chip。
3. Generation Input Set：Start/End Frame、Reference、Prompt 四类输入落在
   `inputAssetIds` / `referenceAssetIds` / `promptSnapshot` 的真实字段上，
   手工任务不带 provider/model。
4. 上传 → 立即登记 → 关联：磁盘上不存在没有 Asset 记录的文件（orphan）。
5. Workflow provenance：真实多 take + 首帧 + 失败生成 + 共享 reference + 成片，
   逐项对照本文件第 2 节的同名不变量。
6. Asset Library：usage 计数不重复、active/historical 正确、search 基于真实
   metadata、主 UI 不暴露 path / raw ID。
7. real media playback：真实图片/视频/音频播放，缺失媒体不崩，approval 仍绑定
   具体 take。
