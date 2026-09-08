# 工作进度

> **这份文件是生成的，别手改** —— `python .claude/tools/gen_docs_status.py`。
>
> 一行一条需求：**做到哪了、谁在做、还差什么**。这里不写需求内容，只给链接 ——
> 需求正文在链接那一头，抄第二遍就会有两份各自漂移的真相。
>
> 进度是**从卡派生**的：卡头引用了哪条 REQ，加上卡在 `done/` `active/` `backlog/`
> 的哪一格（目录即状态）。**它衡量的是「这条需求的工作做了多少」，不是「这条需求
> 满足了多少」** —— 后者要判据级对账，而 REQ 的判据格式今天还不统一（见生成器注释）。

## 每条需求做到哪了

| 需求 | 进度（卡） | 已完成 | 在办 | 待排期 |
| --- | --- | --- | --- | --- |
| [REQ-001](requirements/REQ-001-auto-push.md) | ██████████ 卡都做完了 | TASK-101·TASK-145 | — | — |
| [REQ-002](requirements/REQ-002-document-lifecycle.md) | ██████████ 卡都做完了 | TASK-107 | — | — |
| [REQ-003](requirements/REQ-003-traceability-and-requirement-fulfillment-review.md) | ██████████ 卡都做完了 | TASK-108 | — | — |
| [REQ-004](requirements/REQ-004-three-pane-shell-and-agent-conversation.md) | █████████░ 6/7 | TASK-109·TASK-111·TASK-113·TASK-125·TASK-126·TASK-130 | TASK-106 | — |
| [REQ-005](requirements/REQ-005-remove-a-project-from-the-home-list.md) | ██████████ 卡都做完了 | TASK-110·TASK-112 | — | — |
| [REQ-006](requirements/REQ-006-agent-can-do-what-the-creator-can-do.md) | ████████░░ 13/16 | TASK-114·TASK-115·TASK-116·TASK-117·TASK-118·TASK-120·TASK-121·TASK-122·TASK-125·TASK-126·TASK-127·TASK-129·TASK-130 | TASK-132 | TASK-128·TASK-138 |
| [REQ-007](requirements/REQ-007-say-it-and-the-right-capability-runs.md) | ██████████ 卡都做完了 | TASK-119·TASK-126 | — | — |
| [REQ-008](requirements/REQ-008-images-from-my-own-account.md) | ██████████ 卡都做完了 | TASK-139 | — | — |

## 没有任何卡引用的需求

（没有 —— 每条生效需求都至少有一张卡。）

## 在办、但不服务任何需求的卡

Bug / 工装 / Refactor 这类写的是**技术目标**而不是 REQ（AGENTS §20）。列在这里，是因为一块只显示需求的板子会让人以为「没别的事在做」。

- [TASK-040](tasks/active/TASK-040-final-unified-product-acceptance.md)
- [TASK-074](tasks/active/TASK-074-delivery-migration-and-legacy-retirement.md)
- [TASK-087](tasks/active/TASK-087-followup-ledger.md)
