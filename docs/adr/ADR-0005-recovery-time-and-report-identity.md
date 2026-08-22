# ADR-0005: 恢复时间与报告身份（断点续跑字节稳定性）

- Status: Accepted
- Date: 2026-07-29
- Accepted: 2026-07-29 — M1 findings-closure（TASK-013）收口时定稿。
- Scope tasks: TASK-005（validation step）、TASK-006（composition step）

## Context

M1 整体审查复现确认一类断点续跑缺陷：validation 与 composition 的
报告（JSON/Markdown）内容里嵌入了「本次」`observed_at` 墙钟时间，而
报告发布采用 reuse-if-equal / conflict 语义（字节相同才复用，不同即
`AssetConflictError` / `CompositionConflictError`，从不静默覆盖）。

因此当一次逻辑操作 **部分提交后崩溃**（例如 JSON 报告已写、Markdown
报告未写；或资产已发布、manifest 未写），稍后以 **不同的** 墙钟时间
重跑时，重新渲染的报告字节与已落盘的旧字节不一致，稳定地触发冲突，
使本应「就地补齐」的恢复失败。VideoAsset 的 `validated_at` 也用本次
时间，存在同样问题。

architecture §9 要求多文件部分提交可安全恢复、且不重写已完成内容。
上述实现与该合同冲突。

## Decision

1. **逻辑操作时间复用**：一次逻辑操作（一个 validation 版本、一个
   composition 版本）在其全部 durable 产物中使用 **同一个** 时间值。
   续跑时，若该操作的报告已部分落盘，则 **复用已落盘 JSON 报告中的
   `observed_at`** 作为本次重新渲染的时间，而不是用调用方传入的新
   墙钟时间。
   - 复用来源：目标版本的 JSON 报告文件（若存在）。JSON 报告是该逻辑
     操作最先写出的 durable 事实源，天然携带首次时间。
   - 复用范围：报告 JSON/Markdown 的 `observed_at`、VideoAsset 的
     `validated_at`、以及本次补写的 manifest `created_at`/`completed_at`
     全部取该复用时间。
   - QCD 事件 `occurred_at` 亦取该复用时间；QCD 事件本就按确定性
     `event_id` 去重（ADR-0003 §5、保留首行），重放安全。
2. **不新增 durable schema 字段**：不在 CompositionPublishIntent 或
   StepManifest 中新增时间字段来承载「首次时间」。首次时间的唯一
   durable 载体是「已落盘 JSON 报告」。若报告尚未落盘（例如合成
   recovery A：MP4 已发布但报告缺失），则该操作的报告尚无既定字节，
   此时用传入时间新写报告不产生冲突。
3. **no-op 的内容校验强化**：一个「已完成」manifest 要被判为 no-op
   （幂等跳过），不仅要求 `output_paths` 全部存在，还必须校验：
   - JSON 报告可解析、且其 schema 版本 / 身份字段（task/shot/version 或
     project/version）与 manifest 记录一致；
   - 正式媒体文件的 SHA-256 与 manifest/资产记录中登记的摘要一致；
   - （validation）若登记为 passed，则 VideoAsset 记录存在且可解析。
   任一不满足即 **不判为 no-op**，进入恢复/冲突路径，杜绝「漂移或
   损坏的产物被静默当作完成」。

## Consequences

- validation 与 composition 的部分提交在任意稍后时间重跑，都能字节级
  稳定地就地补齐，不再误报冲突，也不重写已完成内容。
- 不扩大 durable schema；CompositionPublishIntent「无时间字段」的既有
  决定保持不变（对齐先前 Codex 意见）。
- no-op 判定成本略增（多一次 JSON 解析 + 一次媒体哈希），但换取对
  漂移/损坏产物的检出，符合防静默覆盖的安全目标。
- 失败（validation 未通过）报告同样按上述时间复用规则处理。
