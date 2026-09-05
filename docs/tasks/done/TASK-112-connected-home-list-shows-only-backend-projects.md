# TASK-112：已连接后端时，主页只显示后端真的有的项目

- 状态：完成（2026-08-29）
- Workflow：Bug · 深度：SHALLOW
- 关联 Requirement：[REQ-005](../../requirements/REQ-005-remove-a-project-from-the-home-list.md)
  判据 5「说了移除，列表里就不许再有它」的邻居缺陷 —— 列表里有的，磁盘和后端却没有
- 技术目标：连接模式下项目列表只有一个真相来源（后端），浏览器里的旧条目不再冒充项目卡
- 起因：产品负责人 2026-08-29:「画面不对啊。有很多不存在的项目」

## 查明的事实

1. `projectCards()` 无条件把 `localStorage` 的 `motv.projects.v1` 里每一行都画成卡片
   （`kind: "canvas"`）。**连接模式下**这些行没有后端项目撑着 —— 它们是几个月的原型
   使用留在浏览器里的残渣，于是主页上「不存在的项目」比真的还多。
   后端 `/api/projects` 当时只报 2 个，真机验证（Playwright，全新 profile）画出 0 张
   幽灵卡 —— 证实来源是他那台浏览器的 localStorage，不是服务端。
2. `renderLanding` 的清场只删 `.pcard`，而 ✕ 按钮在 REQ-005 里被放成了 `.pcardwrap`
   的**兄弟**节点 —— 于是每次重绘都留下一个空壳 wrapper 和它的孤儿 ✕。

## 改动

| 位置 | 改法 |
| --- | --- |
| `src/services/projects.js` | `projectCards({ …, includeCanvas = true })`；`false` 时不再产出 canvas-only 卡片，但**保留**这些行给真实卡片供 `assetRoot` / `openedAt` |
| `src/app.js` | 主页与左上项目切换菜单都传 `includeCanvas: !CONNECTED`；清场改成 `.pcardwrap, .pcard` |

**没有删任何东西**：localStorage 里的行原样留着（demo 模式仍然按老样子显示它们），
磁盘文件更是从头到尾没被碰过。

## 验证

- `mockups/motv-workspace/tests/projects.test.mjs` 新增 2 条（残留行不出卡但元数据仍并入
  真实卡片；demo 模式不受影响）
- 前端全量 `node --test mockups/motv-workspace/tests/*.test.mjs` → 1876 passed / 0 failed
- 真机（Playwright，往 localStorage 塞 3 行、其中 2 行是幽灵）：画出 2 张真实卡片、
  `.pcardwrap` 与 `.pdel` 各 2 个 —— 幽灵不见了，孤儿 ✕ 也不见了

## 同时恢复的用户数据（不是本卡的改动，是善后）

他在这一版上点 ✕ 时把两个**真实项目**也从列表里移掉了（账户注册表 2026-08-29 13:57
被改空，`confirmedRoots` 保留 —— 正是 unregister 的形状）。磁盘上 `夜班沉默` 与
`照见未明rev2` 两个目录一字未动（ADR-0090 决策 1：这条路径零文件系统写操作），
按备份把两行写回注册表即恢复。
