// 点一个界面元素，写一句意见（TASK-132 切片 A）。
//
// 他要说的往往是「**这个**按钮太靠近删除」。今天他只能打字描述位置，而开发那边
// 收到的是页面级线索（哪一页、画它的文件），组件级定位一直是缺口（TASK-120 的
// Follow-up 记着）。这个模块补的就是「他指的是哪一个」。
//
// 分工：**判断是纯函数，DOM 交互留薄。**
//   · `targetOf` / `snapshotOf` / `cssPathOf` —— 纯的，不碰 document，可直接测；
//   · `startPicking` —— 唯一碰 DOM 的那一段，只做「挂监听 / 高亮 / 清理」。
//
// 三条硬规矩，每条都有它防的那件事：
//
//   1. **点选本身不许触发页面行为。** 用捕获阶段拦，而且不只拦 `click` ——
//      `pointerdown` / `keydown`(Enter/Space) 同样会触发按钮，只拦 click 的话，
//      他想选「生成」，结果真的生成了一次（上游 agent-ui-annotation 只拦了 click，
//      本项目的按钮有拖拽与键盘激活，照搬会漏）。
//   2. **CSS 路径只是线索，不是身份。** 跨一次重渲染它就可能不成立。稳定的那半是
//      `data-ui-id` + 实体身份（episodeId / shotId）+ 路由；`selector` 存下来只为
//      回看时多一条线索，匹配不到时**如实说定位失效**，不拿第一个凑数。
//   3. **退出要干净。** 监听、高亮、光标全部还原 —— 一个退不干净的选择模式会让
//      整个界面像坏了。

/** 一个元素上的稳定标记。渲染那边用 `data-ui-id` 打点，这里只读。 */
const UI_ID = "uiId";
const UI_COMPONENT = "uiComponent";

/** 标签最多取这么多字：`label` 是给人看的线索，不是内容搬运。
 *  整段正文进台账既没用又会把他写的作品内容带出页面。 */
const LABEL_MAX = 60;

/** 从被点中的节点往上找**该被选中的那个** —— 通常他点的是按钮里的图标或文字。
 *
 *  优先带 `data-ui-id` 的祖先（那是渲染方声明「这是一个可指认的东西」）；
 *  没有就退到最近的可交互元素；再没有就退到最近的有意义容器。
 *  **一路找不到就返回 `el` 本身**，不返回 null —— 「他确实点了个东西」是事实，
 *  假装没点中比给一个粗一点的定位更糟。
 */
export function targetOf(el, opts = {}) {
  const maxUp = typeof opts.maxUp === "number" ? opts.maxUp : 12;
  const interactive = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
  const container = new Set(["LI", "TR", "SECTION", "ASIDE", "DETAILS", "FIGURE"]);
  let node = el;
  let firstInteractive = null;
  let firstContainer = null;
  for (let i = 0; node && i < maxUp; i += 1) {
    const ds = node.dataset || {};
    if (ds[UI_ID]) return node;
    const tag = String(node.tagName || "").toUpperCase();
    if (!firstInteractive && interactive.has(tag)) firstInteractive = node;
    if (!firstContainer && container.has(tag)) firstContainer = node;
    node = node.parentElement || null;
  }
  return firstInteractive || firstContainer || el;
}

/** 一条可读的 CSS 线索。**不追求唯一**，追求「人看得懂这是哪一块」。
 *
 *  刻意不带 `:nth-child`：它对重排最敏感，而重排恰恰是这类界面每次渲染都在做的
 *  事。一条会在下次渲染后指向别的元素的 selector，比没有 selector 更坏。
 */
export function cssPathOf(el, opts = {}) {
  const depth = typeof opts.depth === "number" ? opts.depth : 3;
  const parts = [];
  let node = el;
  for (let i = 0; node && i < depth; i += 1) {
    const tag = String(node.tagName || "").toLowerCase();
    if (!tag) break;
    const cls = String((node.className && node.className.baseVal) || node.className || "")
      .split(/\s+/)
      .filter((c) => c && !/^(on|open|active|hidden|dragging)$/.test(c))
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join("");
    parts.unshift(tag + cls);
    node = node.parentElement || null;
  }
  return parts.join(" > ");
}

/** 屏幕上看得见的那几个字。取有限长度，去掉换行与多余空白。 */
export function labelOf(el) {
  const ds = el.dataset || {};
  const raw =
    ds.uiLabel ||
    el.getAttribute?.("aria-label") ||
    el.getAttribute?.("title") ||
    el.getAttribute?.("placeholder") ||
    el.textContent ||
    "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
}

/**
 * 一个元素的快照 —— 送给服务端的就是这个形状（TASK-132 §5.A 的「最小快照」）。
 *
 * `rect` 是 **CSS 像素、参照系为视口左上角**（`getBoundingClientRect`）。它随滚动
 * 与窗口尺寸变化，所以它只用于回看时把框画回去，**不是身份**。身份是
 * `uiId + 实体 id + 路由`。
 *
 * 不送整个 DOM、不送表单值、不送作品正文 —— 一条意见需要的是「他指的是哪个」，
 * 不是页面上都有什么。
 */
export function snapshotOf(el, extra = {}) {
  const ds = el.dataset || {};
  const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  const out = {
    uiId: ds[UI_ID] || "",
    component: ds[UI_COMPONENT] || "",
    label: labelOf(el),
    selector: cssPathOf(el),
    // 实体身份从元素自己或祖先上取 —— 镜头行上就带着 shotId，那比任何 CSS 路径
    // 都稳，因为它是业务身份不是渲染产物。
    shotId: nearestData(el, "shotId"),
    episodeId: nearestData(el, "episodeId"),
    ...extra,
  };
  if (rect) {
    out.rect = {
      x: round1(rect.left),
      y: round1(rect.top),
      w: round1(rect.width),
      h: round1(rect.height),
    };
  }
  // 空字段不送：服务端会丢掉它们，送过去只是噪音
  for (const k of Object.keys(out)) if (out[k] === "" || out[k] == null) delete out[k];
  return out;
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;

function nearestData(el, key) {
  let node = el;
  for (let i = 0; node && i < 12; i += 1) {
    const v = (node.dataset || {})[key];
    if (v) return String(v);
    node = node.parentElement || null;
  }
  return "";
}

/** 一次点选的 id。**由前端生成**，服务端拿它做幂等 —— 重发不产生第二条意见。
 *
 *  刻意不借用 runId：那是模型某一轮的身份。为了迁就现有去重而伪造一个，会让两条
 *  本来无关的路径共用一个命名空间，而那种耦合出问题时极难看出来。 */
export function newAnnotationId(now = Date.now, rand = Math.random) {
  return `ann-${now().toString(36)}-${Math.floor(rand() * 1e6).toString(36)}`;
}

/**
 * 进入选择模式。返回一个 `stop()` —— **调用方必须留着它**。
 *
 * `doc` 注入进来（不直接摸全局 document），so 测试可以喂一个假的。
 *
 * 事件全部挂在**捕获阶段**并且 `stopPropagation`：页面上的按钮、拖拽、输入框都在
 * 冒泡阶段监听，捕获阶段拦住就等于它们没被点到。只拦 `click` 是不够的 ——
 * `pointerdown` 会启动拖拽，`keydown` 的 Enter/Space 会激活按钮。
 */
export function startPicking(doc, handlers = {}) {
  const onHover = handlers.onHover || (() => {});
  const onPick = handlers.onPick || (() => {});
  const onCancel = handlers.onCancel || (() => {});
  let stopped = false;

  const swallow = (ev) => {
    ev.preventDefault?.();
    ev.stopPropagation?.();
  };
  const isOurs = (el) => !!(el && el.closest && el.closest("[data-ef-ui]"));

  const move = (ev) => {
    const el = ev.target;
    if (!el || isOurs(el)) return;
    onHover(targetOf(el));
  };
  const down = (ev) => {
    if (isOurs(ev.target)) return; // 自己的控件（取消按钮）不拦，否则退不出去
    swallow(ev);
  };
  const click = (ev) => {
    if (isOurs(ev.target)) return;
    swallow(ev);
    const el = targetOf(ev.target);
    stop();
    onPick(el, snapshotOf(el));
  };
  const key = (ev) => {
    if (ev.key === "Escape") {
      swallow(ev);
      stop();
      onCancel();
      return;
    }
    // Enter / Space 会激活当前焦点上的按钮 —— 选择模式下一律吞掉
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") swallow(ev);
  };

  const bind = [
    ["pointerdown", down],
    ["mousedown", down],
    ["pointermove", move],
    ["mousemove", move],
    ["click", click],
    ["keydown", key],
  ];
  for (const [name, fn] of bind) doc.addEventListener(name, fn, true);

  function stop() {
    // **幂等**：`click` 里先 stop 再回调，回调里调用方可能又 stop 一次。
    // 重复摘监听本身无害，但重复置 body 样式会盖掉别人后来设的值。
    if (stopped) return;
    stopped = true;
    for (const [name, fn] of bind) doc.removeEventListener(name, fn, true);
    if (doc.body && doc.body.classList) doc.body.classList.remove("ef-picking");
  }

  if (doc.body && doc.body.classList) doc.body.classList.add("ef-picking");
  return stop;
}

/** 引用条上显示的那一行：`分镜设计 › 镜头列表 › 生成`。
 *
 *  没有 label 时退到 uiId、再退到 selector —— **每一级都比「未知元素」有用**，
 *  而且退到哪一级他看得出来。 */
export function breadcrumbOf(snapshot, where = {}) {
  const bits = [
    where.moduleLabel || "",
    snapshot.component || "",
    snapshot.label || snapshot.uiId || snapshot.selector || "（未命名元素）",
  ].filter(Boolean);
  return bits.join(" › ");
}
