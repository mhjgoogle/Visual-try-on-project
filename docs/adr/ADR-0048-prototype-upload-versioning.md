# ADR-0048: 原型上传版本化——同槽位写路径从「替换」改为「追加版本」

- Status: Accepted
- Date: 2026-08-07
- 关联: TASK-048（motv P0 断层修复）、ADR-0043～0047（原型层决策留痕惯例）、
  AGENTS.md 第 13 条（禁止静默覆盖用户文件和已有生成结果）

## 背景

motv 原型的媒体槽位（`mockups/motv-workspace/data/uploads/<project>/`）此前
采用「同 slot 重传即替换」语义：手工上传、本地 TTS、付费图片生成、付费成片
adopt 四条写路径都会 `os.replace` 覆盖旧文件，并顺带删除同 slug 其它扩展名
的旧变体。这与仓库「禁止静默覆盖」纪律在原型层不一致，也使多批次生成
（一图多版、比选回切）不可能——2026-08-07 工作流四维排查将其定为 P0 断层
之三（TASK-048）。

## 决策

1. **写路径语义变更（mockup `server.py`，仅原型层）**：同 slug 的每次写入
   （`PUT /api/uploads/`、TTS、付费图片、adopt-paid）产生带版本后缀的新文件
   `<slug>_v<N>.<ext>`，`N` 单调递增、跨扩展名统一编号，通过
   `O_CREAT|O_EXCL` 原子认领，绝不删除、绝不覆盖任何既有上传文件。既有
   校验（magic 字节、类型白名单、大小上限、路径 containment、保留 slug
   `final-cut`）全部保留。
2. **向后兼容**：旧的无后缀文件 `<slug>.<ext>` 视为该槽位的 v1，参与版本
   编号（下一次写入成为 v2），继续可读可用；不做任何迁移/重命名脚本。
   为保证版本命名空间无歧义，写路径拒绝以 `_v<N>` 结尾的 slug（历史生成的
   slug 均为连字符分隔，不受影响）。
3. **写响应携带身份**：每条写路径返回 `{url, version, sha256}`——版本号与
   内容摘要（与 lock-draft-plan 首帧绑定同源的 sha256），供画布层构造
   MediaRef。
4. **画布层版本链（前端）**：`node.uploads[slot]` 由纯 url 字符串升级为
   `{ current, history: [MediaRef...] }`（MediaRef =
   `{slot_id, origin: upload|paid-image|paid-video|adopted|tts, version,
   digest, url}`，原型内部约定，非核心 schema）。旧格式字符串读入时自动
   视为 v1（origin=upload、digest 待补算），`data/<project>.json` 向后兼容，
   不做破坏性迁移。UI 提供版本徽标与版本选择器，可浏览历史并回切当前版本。
5. **消费侧按当前版本解析**：合成（compose）、TTS fit、锁定首帧等按
   当前版本 MediaRef 的实际文件名解析，回切立即生效。adopt-paid 对已有
   成片槽位追加新版本（origin=adopted）而非拒绝/覆盖；防重复扣费护栏
   不变，仍在提交侧拦截。

## 边界

- 仅 `mockups/motv-workspace/`（前端 + mockup `server.py`）；不触碰
  `src/ai_video_workflow/` 核心层、冻结合同或任何付费能力。核心层的
  多媒体 Provider 抽象仍待 ADR-0037～0040。
- `data/uploads/` 仍是原型 scratch（gitignored），不是核心产物目录；
  compose 输出 `final-cut-v<N>.mp4` 的既有版本化命名不变。

## 后果

- 多批次生成可暂存、比选、回切；原型层与仓库反静默覆盖纪律对齐。
- 磁盘占用随版本数增长（原型 scratch 可整目录清理，可接受）；
- 旧画布数据与旧文件布局继续工作，无需用户操作。
