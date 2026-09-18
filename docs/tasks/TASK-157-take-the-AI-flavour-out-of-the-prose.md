# TASK-157：去 AI 味 —— 一个改这一章文字的能力，以及写的时候就少带味

- 状态：进行中 · **实施中**（2026-09-18 开卡，同日开工）
- 起因：产品负责人 2026-09-18「帮我找些去AI味的写小说的skill给装上」。
  · 闸：**放行（第 ① 问：在当前里程碑交付面上）** —— 当前里程碑是 REQ-009「先把小说写出来」，
  链已经通了，产出的**文字质量**就是这条链有没有用的下一道坎。
- 类型：Feature · 深度：**STANDARD**（U=QUICK：判据写得出，「AI 味」按实测表定义；
  I=STANDARD：新增一个能力 + 一个上下文键 + 一个 intent，波及对话路由与正文写路径；
  R=QUICK：正文落地走既有路径，覆盖前存一版、可退回；C=STANDARD：可选上下文键 + 新 intent，
  都是加法）
- 成果物：[REQ-010](../requirements/REQ-010-the-prose-must-not-read-like-AI.md) · 本卡 · 提交
- 关联 Requirement：REQ-010 v1 判据 1–6
- 架构约束：`CA §3` 对话里的能力路由（模型无权指定 skillId）· `CA §5.2` 不静默覆盖 ·
  `CA §4` 测试归属 · ADR-0067（能力包三件套、版本不原地覆盖）· ADR-0091 + ADR-0106（排序键）·
  ADR-0066（不新增页面）
- L5 自动实施授权：产品负责人 2026-09-18 本次请求
- 实施 Agent：`visual-try-on-project-b0`（2026-09-18 认领）
- 工作树：`D:/02_Work/04_video-work/motv-wt/TASK-148-l5`，分支 `change/TASK-157-deslop`，
  基线 `main@cd4bce3`

## 1. 这一片交付什么

**治**：他在小说项目里说「这一章太有 AI 味了，改一下」→ 新能力 `novel-style-editor`（文字编辑）
读**这一章已有的正文**，产出**同一章的去味版** + 改了哪几处/为什么的清单；点「用它」落回那一章，
原稿先存一版、退得回去。

**防**：`novel-chapter-writer` 的提示词把实测出来的三条毛病写成硬约束（v2 → v3）。

## 2. 架构决定（结论几行，不另开 ADR）

- **「AI 味」按可数的形状定义**，写进提示词与 `reviewCriteria`：① 三短句排比（实测 61 段里
  27 处）② 明喻密度（10 处）③「不是 X，是 Y」对举 ④ 段落长度单一（平均 38 字）
  ⑤ 直陈情绪（「……得让人心慌」）⑥ 空泛形容词。**不做判分** —— 一个分数会立刻变成新的
  优化目标，而它只度量我列得出来的那几种（REQ-010 §本次边界）。
- **它是修订类，不是创作类。** `intent: "prose-revision"`（新加进 `_ROUTING_INTENTS`，并进
  `server._CONV_REVISION_INTENTS`）。这样「**改**一改这一章的文字」走它、「**写**这一章」
  走小说家 —— 靠的是既有的「修改动作匹配」那一项排序键（ADR-0091 决策 2 第 2 项），
  不是靠关键词打架。
- **新上下文键 `chapterText`（本章正文）。** 今天没有任何能力读得到「这一章写了什么」——
  `chapterPlan` 只有任务与字数、`previous` 只有上一章结尾。章号仍来自 `scope.unitNo`
  （与 `chapterPlan` 同源，**不猜**）；那一章还没有正文时给 `null`，于是必填输入缺、
  运行前就被拒并说清楚。
- **写回路径一条不新增**：产出 `chapter` → 复用 `proposeScript`（带 `form` / `unitNo` 的
  落点身份）→ `applyBodyProposal` 落回那一章，覆盖前存一版。与小说家**同一条**路。
- **只对小说**（`form: "novel"`）：剧集那侧有 `script-doctor`，不进它的地盘。

**显式假设（可逆）**：去味是**整章重写**（保留情节/人物/信息，只换写法），不是逐句标注；
想看逐条理由，改动清单里有。

## 3. 影响分析（六面，含明确不动的那一栏）

| 面 | 要改的 | 明确不动的 |
| --- | --- | --- |
| Requirement | 新建 REQ-010 v1 | REQ-009 / REQ-007 一条不改 |
| UI | 无（对话驱动，结果落在既有正文编辑器） | 十一页闭集 · 正文创作页 · 版本与回收区 |
| 数据 Schema | `skill-inputs.json` +`chapterText`；新包三件套；`_ROUTING_INTENTS` +`prose-revision`；`novel-chapter-writer` v2→v3 | `story.work` 持久化结构一个字段不加；`proposeScript` 的 args 不变；输出 schema 只在新包里 |
| Workflow | 无 | `episode-from-scratch`（不引用这两个包） |
| 测试 | 前端 `deslop.test.mjs`（新）· studio `test_motv_style_editor_task157.py`（新）· contract 基线加一条 | `tests/backend` · `tests/e2e` |
| docs | REQ-010 · 本卡 · STATUS 重生成 | CA §3 那一行（机制没变，多一个候选与一个 intent） |

## 4. IN SCOPE / OUT OF SCOPE

**IN SCOPE**：`chapterText` 上下文键 · `novel-style-editor` 包 · `prose-revision` intent（含修订
动作匹配）· `planApply` 的翻译（复用 `proposeScript`）· `novel-chapter-writer` v3 的硬约束 ·
上述测试与基线。

**OUT OF SCOPE**：剧本 / 大纲 / 分集的去味 · 学他的个人文风（需要样本与风格档案，另一条需求）·
任何 AI 味判分或检测率指标 · 界面改动。

## 5. 验收（对应 REQ-010 判据 1–6）

1. 小说项目里说「这一章太有 AI 味了，改一下」→ resolver 选中 `novel-style-editor`；
   说「写这一章」仍选中 `novel-chapter-writer`。
2. 它的必填输入是 `chapterText`：那一章没有正文（或没打开哪一章）→ 运行前被拒并说清楚。
3. 提案带 `chapter`（去味后的整章）+ `changes[]`（原句 / 现句 / 为什么）；缺正文的提案被拒。
4. 落地走 `proposeScript`：写回**那一章**（`unitNo` 来自那次运行），覆盖前存一版、可恢复。
5. `novel-chapter-writer` 升到 v3，提示词里有那几条硬约束的字样。
6. 剧集项目：`form` 把它排除；「改一改这一集的剧本」仍落 `script-doctor` / `script-reviser`。

## 6. 验证

影响范围 = 前端（skillapply / skillctl / storywork 读取）+ studio（resolver）+ contract（包基线）。

**实测（2026-09-19，codex 轮 1 修复后）**：`pytest tests/studio tests/contract -n 8`
**1049 passed / 16 skipped** · `node --test` **2380 pass / 0 fail**（+22：`deslop.test.mjs` 8、
studio 14）· `ruff check .` 通过 · `lifecycle_check` 0 finding。

验收 → 守卫：

| §5 | 守卫 |
| --- | --- |
| 1 改 vs 写分得开 | studio `test_asking_to_fix_the_prose_goes_to_the_style_editor`（4 种说法）· `test_asking_to_write_still_goes_to_the_novelist`（3 种）· `test_the_new_intent_counts_as_a_revision`（漏了它整条判据塌掉） |
| 2 必填是本章正文 | 前端「chapterTextOf：…没写过就是 null」「不是小说就没有这回事」· 真 controller「那一章没有正文时必填输入就缺」 |
| 3 提案带正文 + 改动清单 | 前端「去味提案翻译成 proposeScript…」「没有正文的提案被拒」（`changes` 不进 action —— 它是说明，不是要写进作品的内容） |
| 4 落回那一章、可退回 | 真 controller「读得到正文 → 提示词带着它，且这一轮记下了是第几章」（含原稿存一版 + `restoreFinalized` 退回逐字核对）·「生成之后他翻到别的章，去味稿仍然落回原来那一章」 |
| 5 小说家升 v3 | studio `test_the_writer_is_bumped_and_says_what_not_to_sound_like` |
| 6 剧集侧不受影响 | studio `test_an_episode_project_never_gets_the_novel_style_editor` · `test_revising_a_script_still_goes_to_the_script_reviser` |

### 真实运行时的效果（同一把尺子量前后）

拿 TASK-152 §7 那次真实产出的 2362 字（真 claude 写的一章）喂给新能力，仍走
`server._run_executor`（同一 argv、同样 stdin），187 秒：

| 形状 | 改前 | 改后 |
| --- | --- | --- |
| 明喻（像 / 如同） | 10 | **1** |
| 「不是 X，是 Y」对举 | 2 | **0** |
| 「……得让人……」直陈 | 1 | **0** |
| 三短句排比（粗糙代理） | 27 | 21 |
| 段长跨度（越大越参差） | 119 | **142** |
| 字数 | 2362 | 2224（没有膨胀） |

`changes` 12 条，**12/12 的 `was` 都能在原文里找到**（没有事后编的说明）。样例：
「她把手收回来，攥成拳，再松开，掌心是潮的。」→「收回手时她在裤缝上蹭了两下，蹭完还是潮的。」

**实施中撞到并修掉的一个自造缺陷**：第一版 prompt 把「改多少处」和「说明列几条」绑在了一起
（写「`changes`：3～12 条」），模型就只改了 11 处 —— 排比只从 27 降到 23。拆开写明
「改动数量由正文决定，不由说明条数决定」之后重跑，明喻 2→1、排比 23→21。

### codex 轮 1 之后重跑（同一把尺子，第三次）

轮 1 判「挑 3～12 条有代表性的说明」不满足 REQ-010 判据 2（见下一节）。改成**逐条全列**、
`maxItems` 30→80 之后，用同一段 2362 字第三次重跑（225 秒）：

| 形状 | 改前 | 取样版（12 条） | **逐条全列版（23 条）** |
| --- | --- | --- | --- |
| 明喻 | 10 | 1 | 2 |
| 对举 | 2 | 0 | **0** |
| 直陈 | 1 | 0 | **0** |
| 三短句排比 | 27 | 21 | **21** |
| 段长跨度 | 119 | 142 | 106 |
| 字数 | 2362 | 2224 | 2255 |

**我担心的事没有发生**：当初拆开「改多少 / 说明几条」，是怕「要逐条交代」会让模型少改；
实际改动数从 12 处涨到 **23 处**，那几种形状一个没回弹，`was` **23/23** 都能在原文里找到。
段长跨度回落到 106（三次分别 119 / 142 / 106），说明那一项在**单次运行的抖动范围内**，
不是这次改动造成的 —— 与排比那条同理，当温度计不当目标。

**不追那个数字**：三短句排比那条是**粗糙代理**（它也会匹配正常的三分句），按 REQ-010
「不做判分」，把它当温度计而不是目标 —— 追它等于把我自己写的正则变成优化目标。

## 7. 还没在真实项目上被人看过的

**这是信息，不是闸门**（AGENTS.md §1）：

1. **改完之后是不是更好读** —— 这是审美判断，归产品负责人。上面那张表只证明了「那几种
   可数的形状少了」，证明不了「文字变好了」。
2. 浏览器里说那一句、看提案、按「用它」、再从历史退回去 —— 整条链在界面上走一遍。
3. **它会不会改动内容**：`reviewCriteria` 第一条盯的就是这个，自动化没法判（要读懂情节），
   走查时值得对着改动清单核一遍。
4. `novel-chapter-writer` v3 的**预防效果**没单独量过 —— 这次量的是「写完之后去味」那一半。

## 8. 独立审查（codex）

### 轮 1 —— `VERDICT: fail`，两条 BLOCKING，架构四条全 PASS

**两条都成立，都当 P1 修。**

**① 判据 2：取样式的改动说明不满足「每一处改动带原句/现句/为什么」**
（`novel-style-editor/prompt.md:29`「挑 3～12 条有代表性的」+ `output.schema.json` 的
`maxItems: 30`）。

我原本是**故意**取样的：上一节那个自造缺陷让我以为「说明的条数」会反过来压住「改动的
数量」。但判据 2 的用处正是**让他逐条否决** —— 少列一处，他就少一次发现「味道之外的东西
也被改掉了」的机会。取样把这件事的成本转嫁给了他。**改判据去迁就实现是本末倒置**，所以
改的是实现：`changes` 逐条全列（同段同类的连续几处允许**合并**成一条，原文与改文都写上，
但不许省略），`maxItems` 30→80。**然后拿真机验证担心是否成立** —— 不成立，见上一节。

**② 判据 5：小说家的硬约束有一条自相矛盾、有一条没写**
（`novel-chapter-writer/prompt.md:14`）。「不用『不是 X，是 Y』对举」后面跟了一句
「一章里出现一次就够了」—— **禁令后面跟一句豁免，等于没禁**，这是我自己写岔的。删掉。
另外判据 5 点名的「结尾不升华」只写了侧面（「不必每段都收在一个金句上」），没写正面，
补一条：结尾落在动作 / 对话 / 没解决的处境上，「留下往下读的理由」靠**悬而未决**，
不靠一句漂亮话。

**守卫**（三条新断言，`test_motv_style_editor_task157.py` 12 → 14 个）：
小说家提示词里有「结尾不要升华」· **没有**「一章里出现一次就够了」（禁令不得自带豁免）·
文字编辑提示词里有「每一处改动都要列」、**没有**「代表性」、schema 上限 ≥ 60。
