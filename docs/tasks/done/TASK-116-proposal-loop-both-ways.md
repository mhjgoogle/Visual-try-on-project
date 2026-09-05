# TASK-116：提案回路 —— 我提案，他在对话里拍板，我读回他的决定

- 状态：完成（2026-08-29）
- Workflow：Feature · 深度：SHALLOW
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  **判据 6（本卡新增，见 REQ v2）**
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md) 决策 8
  （意见回路）—— 本卡把它补成**双向**
- 起因：产品负责人 2026-08-29 —— 「我还希望前端的agent能够看到你的修改提案然后告诉我，
  我通过前端agent来告诉你是否批准和修改意见」「也就是说，用户可以通过前端的agent给你
  执行修改的指令」

## 回路的三段

| 方向 | 怎么走 |
| --- | --- |
| 他 → 开发 | 对话里说「这个页面不合适」→ `feedback.ui` → 台账 `items`（TASK-114） |
| **开发 → 他** | `read_feedback.py --propose "标题" --body "…"` → 台账 `proposals` → **主动进事实** → 前端 agent 在对话里告诉他 |
| **他 → 开发** | 他说「同意 / 不要 / 可以但要改成…」→ `proposal.decide` → 提案上的 `decision`（verdict + 他的原话）→ `read_feedback.py --proposals` |

「Agent 能看到提案」**不靠他先问**：未答复的提案随每一轮进事实，提示词里明写
「他还没提过就主动用一句话告诉他有哪几条在等他拍板，别自己替他决定」。

## 形状

- 台账一个文件承载双向：`{items: [...], proposals: [{id, createdAt, title, body,
  decision: {at, verdict, note} | null}]}`。**账户级**（与意见同一份，理由见 ADR-0089
  决策 8）。旧台账没有 `proposals` 也照常加载。
- 三种答复：`approved` / `rejected` / `changes`。**`changes` 是重点** —— 他很少是
  纯粹的「同意/不同意」，多数是「可以，但要改成这样」，那句话必须原样带回开发这边。
- `proposal.decide` 与 `feedback.ui` 一样由**服务端**落地（写的是应用数据不是创作文档，
  所以不受 ADR-0089 决策 2b 约束），落在读时对账那一步 —— 他说完就记下了，不依赖那个
  标签页还开着。
- **答复一次**：已答复的提案再答复会被拒绝而不是覆盖他 —— 读时对账会反复经过同一条 run，
  这里既防重复也防「后一次悄悄改掉前一次」。

## 真机验证（隔离账户根，不碰他的项目）

1. 开发这边：`read_feedback.py --propose "把版本行收起来，只显示最新版"`
2. 他在对话里问「开发那边有什么要我拍板的吗」→ Agent 答：
   「有 1 条在等你拍板：**#1 把版本行收起来…** 你现在创意简报 3 版、故事大纲 2 版，
   版本行确实占地方。」
3. 他说「那条提案我同意，但历史版本要能一键全展开」→ 屏幕显示
   「已答复第 1 号提案：要改」
4. 开发这边 `--proposals` 读到：`#1 [要改] … 他说：同意把旧版本收进「历史版本」、
   一个版本都不删。但历史版本要能一键全展开，不要只能一条条点开。`

## 真机抓到的缺陷（已修）

`proposal.decide` 同时出现在「已落到作品上」**和**「它想做但本应用还做不到」下面 ——
前端把不在动作注册表里的 kind 一律归为「做不到」，而服务端自己处理的那几种不在表里。
现在 `SERVER_KINDS = {feedback.ui, proposal.decide}` 显式豁免，并有测试钉住。

## 验证

- `tests/studio/test_motv_conversation_task109.py` → 57 passed（新增 10 条：未答复的
  提案进事实、答复过的不再占地方、答复落到提案上、三种答复、乱写的 verdict 被拒、
  答复两次被拒而不是覆盖他、未知提案号会说、适配器带住 args、提示词教它怎么答、
  读口报还有几条等他）
- `tests/tooling/test_feedback_reader_req006.py` → 12 passed（写提案、列答复与他的原话、
  数还有几条在等、旧台账照常加载）
- `mockups/motv-workspace/tests/convapply.test.mjs` → 23 passed（含服务端处理的 kind
  不算「做不到」）
- 前端全量 / 后端归属域：见提交信息

## Follow-up

- 提案目前只能由开发在命令行写。「他在对话里直接说『帮我把这条做了』→ 变成开发这边的
  任务」还没有 —— 那是把意见变成任务卡的自动化，REQ-006 明确写了不在范围内
