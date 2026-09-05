# TASK-120：意见自带定位情报 —— 让后端更快找到那一页

- 状态：完成（2026-08-29）
- Workflow：Feature · 深度：SHALLOW
- 关联 Requirement：[REQ-006](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  **v5 判据 9（本卡追加）**
- 关联 ADR：[ADR-0089](../../adr/ADR-0089-conversational-agent-write-path.md) 决策 8
- 让号：本卡原编号 TASK-119，与另一个会话正在做的**能力路由**撞号（他们已经把
  TASK-119 写进 `skillpkg.py` 的注释里）。我改用 TASK-120，他们的注释不必动。
- 起因：产品负责人 2026-08-29 —— 「前端agent给你的留言应该加入更详细的页面定位情报，
  还需要考虑如何能让你更快的理解问题和解决问题。所以怎么保证前端agent能够满足这些需求呢。」

## 「怎么保证」的答案：不靠模型自觉，靠结构

在这之前，位置能不能到我手里，取决于模型**记不记得**把它写进句子。写进去了就有
（意见 #4），忘了就没有（意见 #3 只写着「左边太挤」）。那不是保证。

现在每一轮的 context 里多送三样**结构化**的东西，服务端原样存进台账的 `where`：

| 字段 | 是什么 | 省掉哪一步 |
| --- | --- | --- |
| `route` | 他此刻的地址（`#/项目/空间/页面/节?ep=…&shot=…`） | 我照着它就能打开**同一屏** |
| `section` | 同一页里的哪一节（分镜设计有 场景／分镜 两节） | 不必猜他说的是哪半边 |
| `source` | **画这一页的文件** | 「这一页在哪个文件」从翻仓库变成读一行 |

加上原有的 `moduleLabel` / `spaceLabel` / `episodeLabel` / `shotTitle`。
`.claude/tools/read_feedback.py` 把它们印成「在哪 / 画它的文件 / 打开它」。

`MODULE_SOURCE` 住在 `src/ui/production.js`（页面分发表的所在地）。它的价值全在**它是准的**，
所以 `tests/prodsource.test.mjs` 钉住：每个文件真的存在、他最常待的几页必须在表里、
每个 key 都是真的模块 id。

## 实测对比

```
#3（没有定位）说的是：左边太挤了，我要简约一点。
#5（有定位）  说的是：在「剧集制作 · 分镜设计」页面…左侧的镜头列表栏太窄…
              在哪：节：shots · EP01 迷雾入城 · 选中镜头：招牌 · 雨夜
              画它的文件：mockups/motv-workspace/src/ui/storyboard.js
              打开它：#/testproj/episode/storyboard/shots?ep=…&shot=…
```

## 顺带修掉的两个缺陷

1. `dev.request` 同时出现在「已落到作品上」和「它想做但本应用还做不到」下面 ——
   前端的 `SERVER_KINDS` 漏了它（服务端已经处理，前端却当成不认识的 kind）。
2. 集号被拼了两遍：真实项目的标题常常自带「EP01」，代码无条件再拼一次，于是台账 #5 上
   记成了「EP01 EP01 迷雾入城」。现在只在标题没自带时补。

## 验证

- `tests/studio/test_motv_conversation_task109.py` → 73 passed（新增 3 条：意见带结构化
  定位、恶意 context 被截断且未知键不进、无 context 时不编造）
- `tests/tooling/test_feedback_reader_req006.py` → 14 passed（印出在哪/画它的文件/打开它；
  老条目没有 where 也不炸）
- `mockups/motv-workspace/tests/prodsource.test.mjs` → 4 passed（表指向的文件都在、
  常用页面都在表里、key 都是真模块 id、集号不拼两遍）
- 前端全量 1934 passed / 0 failed
- 真机：见上面的实测对比

## Follow-up

- `source` 目前是**页面级**（哪个文件画这一页）。他说「左边那一排」时，更准的是
  **组件级**（`renderShotList` 在 `studioparts.js`）。要做得再细，得让每个可点区域自带
  一个标记 —— 值得，但不在本卡
