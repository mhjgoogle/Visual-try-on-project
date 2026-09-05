# TASK-132：点击界面元素写意见，并让开发 Agent 收到准确位置

- 状态：待开始；上游研究与交互建议已完成（2026-09-05），未实现点选功能。
- Workflow：Feature · 深度：STANDARD。
- 实施 Agent：待 Claude 接手；Codex 本次负责研究与适配说明。
- 依据：用户 2026-09-05 要求继续研究 agent-ui-annotation 与 design-mode，并希望点击 UI 元素写意见。
- 关联 Requirement：[REQ-006 v5 判据 4、7、9](../../requirements/REQ-006-agent-can-do-what-the-creator-can-do.md)
  是已有反馈回路；本卡建议的 delta 是元素点选、锁定及原文直存，不能把它说成 v5 已实现内容。
- 架构约束：[CA §1–4、§5.2、§5.5、§6](../../current-architecture.md)；AGENTS 第 13–20 条。
- 目标：用户不必口述“左边第几个按钮”，开发 Agent 读一条意见就知道针对哪个元素、哪一屏及相关源码。

## 1. 范围与建议

**IN SCOPE**：研究结论与 Claude 实施说明；实施时以现有“开发”对话为入口，增加元素级意见。
**OUT OF SCOPE**：本次直接改产品；全站视觉编辑器、任意网站浏览器扩展、云端 MCP 中继、
让运行中应用改仓库源码、安装第三方包或启动付费 Agent。

推荐借鉴 agent-ui-annotation 的**点选交互与定位信息**，借鉴 design-mode 的
**编号标记、结果回传与可选截图**，使用本项目已有反馈台账和开发流程。
第一版原生实现小型点选层；不把完整外部编辑器作为依赖。该选择是适配判断，不是性能实测结论。

## 2. 两个项目的源码级比较

源码固定于以下 commit（2026-09-05 查询），未安装、未执行上游项目；没有浏览器交互实测。
两者此版本 LICENSE 均为 MIT；若后续复制实现，保留对应许可与版权声明。

| 项目 | 适合借鉴 | 对本项目的限制 |
| --- | --- | --- |
| [agent-ui-annotation](https://github.com/YeomansIII/agent-ui-annotation/tree/1abd9997850695e2ec7ca1737133d45bc76c8f83) | 点击元素、写评论、标记；采集名称/selector/组件路径；Vanilla JS 与 Web Component 入口；创建回调可补业务上下文 | 主输出为 Markdown，localStorage 保存不是本项目开发台账；框架源码定位不自动覆盖本项目原生 JS 渲染 |
| [design-mode](https://github.com/SandeepBaskaran/design-mode/tree/6121498a3acb28b28e0674b5caddd9cfdadb5e16) | 元素/区域评论、编号、截图；样式 oldValue/newValue；Agent 读取变更并回写状态 | 完整浏览器扩展与 MCP 桥接远大于“点一下写意见”；浏览器临时样式变化不等于仓库源码已修改 |

关键源码与落地约束：

1. [annotation/events.ts](https://github.com/YeomansIII/agent-ui-annotation/blob/1abd9997850695e2ec7ca1737133d45bc76c8f83/src/core/dom/events.ts)
   用捕获阶段事件阻止页面操作，排除自身控件，退出时清除监听。
   本项目还需覆盖 pointerdown、键盘激活、嵌套图标与现有拖拽，不能只拦 click。
2. [annotation/route.ts](https://github.com/YeomansIII/agent-ui-annotation/blob/1abd9997850695e2ec7ca1737133d45bc76c8f83/src/core/annotations/route.ts)
   的 normalizeRoute 删除 `#` 后全部内容。本项目 location.hash 恰是页面/分集/镜头身份：
   据此推断原样使用其路由隔离会把不同页面归为同一路由。必须用本项目路由模型保留这些身份。
3. [annotation/path-generator.ts](https://github.com/YeomansIII/agent-ui-annotation/blob/1abd9997850695e2ec7ca1737133d45bc76c8f83/src/core/element/path-generator.ts)
   提供可读 CSS 定位线索，但 CSS 路径不是跨重渲染的稳定业务身份；不能唯一匹配时需如实显示失效。
4. [design-mode/comments.ts](https://github.com/SandeepBaskaran/design-mode/blob/6121498a3acb28b28e0674b5caddd9cfdadb5e16/packages/extension/src/content/comments.ts)
   保存 pageUrl、selector、评论、resolved 与区域坐标，按完整 URL 过滤；可借鉴编号与定位回看。
   其 saveComments 吞掉 storage 写入异常，本项目不能照搬“保存失败却像成功”。
5. [design-mode/screenshots.ts](https://github.com/SandeepBaskaran/design-mode/blob/6121498a3acb28b28e0674b5caddd9cfdadb5e16/packages/extension/src/content/screenshots.ts)
   借扩展 captureVisibleTab 捕获真实像素、隐藏覆盖层后裁剪。普通应用页面不能直接调用该扩展 API；
   不能复制文件就许诺自动截图。截图应单独验证能力与真实视频/字体/跨域素材效果。
6. [design-mode/mcp-server.ts](https://github.com/SandeepBaskaran/design-mode/blob/6121498a3acb28b28e0674b5caddd9cfdadb5e16/packages/mcp-local/src/mcp-server.ts)
   提供 get_changes、set_change_status、get_screenshot、mark_comment_resolved 等交互。
   借鉴“读意见→回传状态”的合同；本项目已有本地通道，第一版不再增加 MCP 服务。
7. [design-mode/source-detection.ts](https://github.com/SandeepBaskaran/design-mode/blob/6121498a3acb28b28e0674b5caddd9cfdadb5e16/packages/extension/src/content/source-detection.ts)
   包含 React fiber / debug source 探测；本项目不能靠它自动获得原生字符串渲染函数的行号。
   应优先记录组件标记与规范源码路径，行号只有确有映射时才带。

## 3. 本项目已有基础与真实缺口

- `src/ui/production.js` 的 conversationContext 已携带 route、section、source、分集/镜头信息，
  MODULE_SOURCE 负责页面源码映射；[TASK-120](../done/TASK-120-feedback-carries-a-locator.md)
  的 Follow-up 已明确组件级定位尚未实现。本次是对这个既有缺口的需求演化调查。
- `server.py` 的 `_conv_where` 仅允许既有页面字段；只在前端加 target 会被该白名单丢掉。
  `_file_feedback` 把模型产生的 feedback.ui 写入账户级台账，按 runId 去重。
- `.claude/tools/read_feedback.py` 已能让开发 Agent 读“在哪 / 画它的文件 / 打开它”；
  现有“开发”线程与提案回路能承接意见，无须另建评论数据库。
- 当前链路能收到页面级反馈，**不能据此声称已有元素点选**；也没有本卡要求的“不经模型直存原文”证据。

## 4. 建议给用户看到的第一版

在右侧“开发”对话输入框附近增加一个小按钮：**选择页面元素**。

1. 点击后进入选择模式；鼠标悬停显示边框与简短名称，如“按钮：生成”。
2. 点击锁定目标；点选本身不触发生成、删除、跳转、输入或拖拽。
3. 输入框上方出现引用条，例如 `已选：分镜设计 › 镜头列表 › 生成按钮`，可“重选 / 移除”。
   目标在打字期间固定；点输入框或其他普通位置不会悄悄换成另一个目标。
4. 用户写“这个按钮太靠近删除，容易误点”，点发送。
5. 本地保存成功后显示“已记录 #编号”，开发 Agent 可读原文与定位；不要求复制 Markdown，
   不需要模型成功才能记下一条意见。若另有自动整理/回复，它是保存之后的独立步骤。
6. 回看意见可高亮对应元素；找不到则显示“页面已变化，原位置暂时无法定位”，保留原文与证据。
   Esc 退出选择模式；退出后界面恢复正常操作。正常浏览不常驻全屏标记。

第一版允许选择按钮、输入区域、列表行、标题、面板；对空白布局区选择最近容器并明确标签。
自由框选区域、批量标注、截图附件、直接调整颜色/间距作为后续增强，不拖住上述闭环。

## 5. Claude 的实施切片

### A. 先打通“点选 → 原文保存 → 开发读取”

- 开工按 dev-workflow 补齐 REQ-006 的增量记录，不篡改 v1–v5；本卡移 active、生成 STATUS。
  为新增无模型反馈提交合同创建技术 ADR，保持账户级应用反馈与作品命令边界清楚。
- 拟新增小模块 `src/ui/elementfeedback.js`（相对 mockups/motv-workspace），
  负责选择、高亮、锁定和清理；production.js 仅承接入口与引用条，不继续塞入完整点选实现。
- 对关键区域添加稳定的 `data-ui-id` / `data-ui-component` 等标记（名称由实施 Agent 定），
  行内再带已有 episodeId/shotId 等身份；优先复用已有表面/动作登记信息。
  不为点击定位重建全站动作表；未知区域允许退回页面级线索，不能伪造精确源码。
- 增加薄的前端 service 提交与受校验的服务端反馈命令，复用现有账户台账写入边界；
  前端不直接写文件，服务端不运行模型或改 canvas。具体 HTTP 路由由实施 Agent 依 ADR 定。
- 将用户原文与元素快照一起提交并服务端校验；扩展 `_conv_where`/相应校验与 reader 的展示。
  不只改页面；否则元素信息会在服务端丢失，开发 Agent 依旧看不到。
- 使用独立 annotationId 处理发送重试；不要伪造业务 runId 来迁就现有模型回路去重。
  重复提交不得产生重复意见，原文不经模型改写；保存失败保留草稿并允许重试。
- 同一台账的直接提交与旧模型反馈写入须共享并发保护，避免 read-modify-write 丢意见。
  若现有 ID 分配/容量裁剪阻塞本卡的幂等性，只做最小修复，记录原因。

建议最小快照：`schemaVersion, annotationId, capturedAt, project, route, module, section,
episodeId, shotId, target{uiId, component, selector, label, source, rect}, viewport, text`。
这是拟议合同；客户端 source 只作线索，服务端校验相对路径/长度/字段，绝不据其读取任意文件。
不发送整个 DOM、表单值或整份作品正文；label 取有限可见文字。所有坐标注明 CSS 像素及参照系。

### B. 补齐回看、动态页面与处理结果

- `uiId + 实体身份 + 路由` 优先定位，selector 作为辅助；多匹配不选第一个冒充准确。
  换页、切分集、弹窗关闭、列表排序、重复渲染均不能把旧意见绑定到新对象。
- 引用条与已保存意见中的目标身份一致；点击别的元素不会更改已锁定目标，重选必须显式操作。
- 状态沿用现有反馈/提案回路；“已记录”只代表保存，“已修改”需关联实现与验证证据。
  标 resolved 或临时 DOM 样式改变均不能证明源码已落地。不要增加第二套评论状态总账。

### C. 仅作为后续增强：截图与视觉差异

截图用同一 annotationId 关联、明确拍摄时路由/视口/目标；失败如实显示，不阻塞文字意见。
先证明真实媒体可正确捕获再纳入验收；没有截图能力就保留结构化定位。
若未来需要直接调样式，再借鉴 design-mode 的 oldValue/newValue 与视口宽度，明确是临时预览。
这部分不计入 A/B 第一版 Done，也不要求用户先装扩展才能使用元素反馈。

## 6. 验收与影响范围

1. 真实 Connected Project 中点“生成/删除/切页”控件做批注，不执行其业务动作；Esc 后正常工作。
2. 嵌套图标能选到合理控件，输入意见不丢焦点；重选/移除不会丢草稿。
3. 保存后 reader 读到**原文 + 目标 + 完整 hash 路由 + 源码线索**；模型不可用仍可记录。
4. 不同页面、项目、分集、同名按钮的意见不串；重复发送、重启读取、并发提交不重复或丢失。
5. 重排/重渲染后定位准确或诚实失效，不把意见移到另一行；存储失败不报“已记录”。
6. 开发意见不写创作品内容；非法字段、超长文本、异常 selector/路径不能突破现有边界。
7. 记录处理结果与实际实现证据，用户可在原反馈回路看到；不得将已记录直接当已解决。

前端测点选/草稿/定位，Studio 测持久化/幂等/并发，contract 测字段端到端不丢失，
tooling 测 reader；关键点击路径用真实浏览器与 Connected Project 验证。
按 AGENTS §20 跑上述受影响域与一次独立四闸审查；发布/合并/实现交接前完成集成检查。
第一版真实验收中的生成按钮只测试点选不触发，不能为验证私自花钱。

## 7. 本次研究交付状态

- 实现：尚未开始；只新增本说明并生成 STATUS，没有安装两项目、接入 MCP 或修改产品代码。
- 已核实：两项目 README、以上关键源码及许可证；本地页面级反馈链路与 TASK-120 既有缺口。
- 未实测：上游 Demo/扩展交互、本项目点选体验；本卡验收项均待实施。
- 文档验证：docs_status / docs_links **9 passed**；lifecycle_check 零发现；diff 空白检查通过。
