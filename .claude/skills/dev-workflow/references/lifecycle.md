# 记录生命周期与仓库收敛

权威是 **AGENTS.md 第 24–27 条 + [ADR-0087](../../../../docs/adr/ADR-0087-document-lifecycle-and-default-agent-context.md)**。
本文件是**操作面**：什么时候做什么动作。目标只有一句 ——

> 一个 Change 做完之后，仓库不比之前更乱。

## 0. 三个类别（先分类，再决定动作）

| 类 | 它回答什么 | 处置 |
| --- | --- | --- |
| **A 当前事实** | 现在是什么 / 现在要做什么 | 精简、更新、默认加载 |
| **B 历史证据** | 当时为什么这么定 / 当时发生了什么 | 永久保留、默认不加载 |
| **C 一次性产物** | 这一次我是怎么查 / 怎么试的 | 任务结束即删（先提炼再删） |

判据是**过期时会不会骗人**：A 过期就是缺陷，B 不会过期，C 过期了也没人读。

**写之前先问它是哪一类**。答案是 C 就别写进 `docs/` —— 写 `.claude/tmp/`
（已 gitignore）或会话 scratchpad。

## 1. 当前事实住在哪（默认上下文的全部内容）

| 文件 | 回答 |
| --- | --- |
| `AGENTS.md` | 规则 |
| `docs/current-architecture.md` | **现在**的模块边界 / 依赖方向 / 前后端合同 / 测试归属 / 架构约束 |
| `docs/STATUS.md`（生成的） | 谁做完了、谁还没做 |
| 本次那张 `docs/tasks/active/TASK-*.md` + 它关联的 `REQ-*` | 现在要做什么 |

**不默认加载**：`tasks/done/`、`tasks/backlog/`、`design/done/`、`reports/`、
未被当前架构合同指向的历史 ADR、被取代的 REQ 版本、历史 Change 清单。
按需读历史的五种情形：**回归调查 / 架构理由 / 历史冲突 / 需求演化 /
复现一次旧决策的边界**。

## 2. 三种记录的状态动作

### Requirement（`docs/requirements/`）

- 新需求：建 `REQ-NNN-slug.md` + 在 `index.md` 加一行（状态两处必须一致，
  `lifecycle_check` 会比）。
- 需求变了：**同文件追加 `## v2 · supersedes v1`**，v1 标题补
  「（superseded by v2）」，**内容一字不动**；实施只做 v1→v2 delta。
- 整份被另一个 REQ 取代：状态改 `SUPERSEDED` 并写明取代者，文件留着。

### Change / Task（`docs/tasks/`）—— 目录即状态

```
backlog/            没人在做（需求成立、未排期）
   ↓ 开工
active/             正在做（含「部分完成」）
   ↓ Done 判定成立
done/               做完了 / 已退役
```

- **`active/` 只放正在进行的工作。** 立了卡但短期不做 → `backlog/`，
  否则「待办 = `ls active/`」会把没人做的也读成待办。
- 目标被后续决策取代 → 进 `done/`，状态行写「退役（被 X 取代）」，**不删卡**。
- 每次移动后重新生成 `STATUS.md`。

### ADR（`docs/adr/`）

`Proposed → Accepted → Superseded / Rejected`。**旧 ADR 永不删除。**

取代关系必须**双向**（`lifecycle_check` 会比，单向即红）：

```
被取代方：  - 状态：**Superseded**（日期）—— 由 [ADR-XXXX](...) 取代 <哪一部分>
取代方：    - **取代**：[ADR-YYYY](...) 的 <哪一部分>
```

部分取代写成「Accepted（决策 1/2 保留）；决策 3 被 ADR-XXXX 取代」，并在被取代的
那一条决策旁就地注明。**只改了新 ADR 就等于没写** —— 读旧 ADR 的人看不到。

两侧都必须是**带标签的头部字段**（`状态 / Status / 取代 / Supersedes /
Superseded by / Partially superseded by`）。只在正文里提一句不算：讨论历史时引用
旧 ADR 是最常见的提及方式，把「提到」当「声明」，守卫就会在它要守的东西上变绿。
换行不影响 —— 守卫按**条目**读，不按行读。

## 3. 收口时做什么（dev-workflow 第 9/10 步的展开）

### 第 9 步 · 仓库收敛（代码收敛之外的七问）

1. 这次新增的 `docs/` 文件，**每一份都是 A 或 B 吗**？C 类删掉或提炼。
2. 有 A 类文档现在在**说谎**吗？（尤其 `current-architecture.md`：
   边界、依赖方向、合同、测试归属变了没？）
3. 这次是否**取代**了某条决策？→ 双向链接补上。
4. 需求变了吗？→ REQ 追加 v2，不改 v1。**有没有重复的需求记录**
   （同一需求两份 REQ，或 REQ 与存量基线文档各写一份）？→ 留一处权威，
   另一处改成指过去的一行。
5. `active/` 里有没有**已经做完**或**根本没人在做**的卡？→ 搬 `done/` / `backlog/`。
6. 有没有已经不代表当前有效行为的**测试 / 文档 / 兼容层**？→ 删或更新。
   （测试保护 Current Valid Behavior，不保护 Historical Behavior。）
7. **当前真相还能重建吗**（AGENTS.md 第 27 条 / ADR-0101 决策 5）？六个面里
   后三面从目录派生、锚点缺失即 fail-closed，机器能替你答；**机器答不了的是
   `<!-- current-truth: milestone -->` 那一行说得还对不对** —— 这次 Change
   推进或换掉了里程碑，就在**同一个提交里**改它。

前四问是判断，后三问机器帮你查：

```
python .claude/tools/lifecycle_check.py
python .claude/tools/gen_docs_status.py     # 第 7 问：六面 + STATUS.md 重生成
```

它不判「这份文档还有没有价值」—— 那需要读者。**它漏报，不误杀**；
漏的那部分就是上面六问的第 1、2、6 问。

### 第 10 步 · Done 时的三个动作（一起做，不是可选项）

```
git mv docs/tasks/active/TASK-NNN-*.md docs/tasks/done/     # 或 backlog/
python .claude/tools/lifecycle_check.py                     # 0 finding
python .claude/tools/gen_docs_status.py                     # 重新生成总览
```

REQ 状态与「相关 Change」同时更新到终态。**merge 前**这三件必须都已完成 ——
`lifecycle_check` 已含在最终全量（`pytest tests/tooling`）里，所以它是**声明**，
不是额外一步。

## 4. 一次性产物：删，或者提炼后再删

调查笔记、临时实施计划、调试记录、原始对话、过期迁移清单、被放弃的原型笔记 ——
任务结束即删。有长期价值的，**先提炼成几行进 REQ / 任务卡 / ADR /
current-architecture，再删原件**。提炼出的那几行才是价值。

- 不建影子实现：`old/`、`old2/`、`legacy-copy/`、`backup/`、`deprecated-but-kept/`。
- 「先都留下，以后可能有用」不是节省 —— 是把成本转嫁给之后每一次读。

**两个例外，它们是 B 类不是 C 类**（别当临时产物删掉）：

- `docs/reports/` 的阶段性工作报告（产品负责人 2026-08-24 要求固定写在 docs 里，
  统一看）—— 历史证据，永久保留、默认不读。
- `docs/design/active/pending-codex-rereview.md` 的**活账**部分：条目闭合后整段
  移进 `docs/design/done/` 的历史文件，**行不删**（删掉就看不出这段时间发生过什么）。
