// 向导第 ⑤ 步 —— **一张全集清单** (TASK-095 §1.3 / §2.5 · TASK-097 批次 4G)。
//
// ⑤ 不是向导上的一个按钮：**合成要说清「哪几张图、什么顺序、每张管什么」，
// 而一个按钮表达不了这件事**。所以分工是：
//
//   向导  说清**还差哪几镜**，每行给一条「进入这一镜的画布合成 →」
//   画布  做**那一镜**（TASK-093 那块单镜画布）
//
// 闸门：`storyboardStatus == skipped` 或（`completed` 且草图已 approved）。
// **没过闸门不置灰导航**（既有纪律）：那一行照样进得去，只是如实写出缺什么，
// 并且给一条走得通的路（去 ④ 通过草图，或者把这一镜跳过）。
//
// 「批量」在这一步只能是**用同一套默认编排试一遍**，产出是提案，逐镜确认 ——
// ⑤ 是整条链上最贵的一步，一次把 60 镜按同一套编排送出去，等于把 60 次判断
// 压缩成一次点击。
//
// ─────────────────────────────────────────────────────────────────────────────
// 白膜视频挂在这一页（TASK-098 §5.3）
//
// 位置是「⑤ Keyframe 通过之后、⑥ 批量生视频之前，**每镜一个动作**」，而这张清单
// 正好就是「⑤ 之后按镜排开」的那一屏 —— 所以它是**这一行多一格**，不是第六步、
// 不是新页面（ADR-0066 决策 10 的十一页封闭集合不动）、也不是第七个 stage
// （TASK-092 那六个是唯一真相）。
//
// **挂载点核对过**（§2.5i 第二条，那处混淆已经咬过三次）：这张清单由
// `ui/production.js` 的 `storyboard:` 渲染器在 `sectionOf("storyboard") !== "scenes"`
// 那一支渲染、由同一处 `bindKeyframeList` 绑定 —— 也就是**分镜设计页的镜头一节**。
// 那一页自己切 section；模块表（`shell.MODULE_ALIAS`）里另有一个 `shots:` 键，
// 它是**别名**（→ `["storyboard", "shots"]`）而不是第二条路由，所以本次不新增任何
// 挂载点：白膜住在已经在渲染、已经在绑定的这一个节点里。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE PRESENTATION；写入全部经 ctx。

import { esc } from "../util/dom.js";

const STATE = {
  approved: ["✓", "已通过", "ok"],
  made: ["◐", "待确认", "warn"],
  skipped: ["⊘", "已跳过", "skip"],
  not_started: ["＋", "还没合成", "none"],
};

/** 能识别的词，一行说完。**派生自 `motionRow` 带回来的那份词汇表**，
 *  所以词汇表加一条不用改这里（§2.6.1）。 */
function vocabLine(vocabulary) {
  const groups = (Array.isArray(vocabulary) ? vocabulary : [])
    .filter((g) => g && Array.isArray(g.words) && g.words.length)
    .map((g) => `${g.group}：${g.words.join(" / ")}`);
  return groups.length ? `能预览的词 —— ${groups.join("；")}` : "";
}

/**
 * 一行的运镜那一格。
 *
 * 三种结局照实分开（TASK-098 §7.2）：能预览 / 认得出但做不到 / 认不出。
 * 认不出时**列出能识别的词**，而不是给一个不动的视频。
 */
function motionCell(r) {
  const m = r.motion;
  if (!m) return `<td class="kfl-motion"><span class="kfl-mnone">—</span></td>`;
  const bits = [];
  if (m.preview) {
    // `preload="none"`：60 行清单不该在打开页面时拉 60 段视频。点了才取字节。
    bits.push(
      `<video class="kfl-mvid${m.previewStale ? " stale" : ""}" src="${esc(m.preview.url)}"`
      + ` preload="none" muted controls playsinline`
      + ` title="运镜预览 v${esc(String(m.preview.version ?? ""))}"></video>`,
    );
    // **对不上就说对不上**：在新摘要旁边播旧画面，审片时看的就是错东西
    if (m.previewStale) bits.push(`<span class="kfl-mstale">${esc(m.previewStaleWhy)}</span>`);
  }
  if (m.summary) {
    const cls = m.canPreview || m.preview ? "ok" : "gate";
    bits.push(`<span class="chip ${cls}">${esc(m.summary)}</span>`);
  }
  // 退了一档要**说出来**：静默拿一张镜头图片冒充正式关键帧才是错的（SOURCE_TIERS）
  if (m.sourceNote) {
    bits.push(`<span class="chip skip" title="${esc(m.sourceNote)}">用 ${esc(m.sourceLabel)}</span>`);
  }
  for (const n of m.notApplied || []) {
    // 「没做到」是本卡最不能省的一句话：静默输出一个不动的视频冒充它，
    // 就是把「做不到」渲染成一段看起来像的画面。
    bits.push(`<span class="chip warn" title="${esc(n.why || "")}">没做到 ${esc(n.label)}</span>`);
  }
  // 一句话不是一个标签：`.chip` 是 `nowrap`，把整句「还没有画面 —— …」塞进去会把
  // 这一列撑到把「动作」那一列挤出屏幕（真实屏幕抓到，60 镜那一屏尤其明显）。
  if (m.blocked) bits.push(`<span class="kfl-mblock">${esc(m.blocked)}</span>`);
  // 待办不是阻塞（§2.5f 第二条）：这一格印的是「你现在要做的那件事」
  else if (m.todo) bits.push(`<span class="kfl-mtodo">${esc(m.todo)}</span>`);
  if (!m.empty && !m.renderable) {
    const line = vocabLine(m.vocabulary);
    if (line) bits.push(`<span class="kfl-mvocab">${esc(line)}</span>`);
  }
  if (m.preview && (m.caveats || []).length) {
    bits.push(
      `<span class="kfl-mcaveat" title="${esc((m.caveats || []).join("\n"))}">`
      + `白膜没表达的：${esc(String((m.caveats || []).length))} 条（悬停看）</span>`,
    );
  }
  return `<td class="kfl-motion">${bits.join(" ")}</td>`;
}

function row(r) {
  const [icon, label, cls] = STATE[r.state] || STATE.not_started;
  const m = r.motion;
  // **不置灰**（既有纪律）：能预览时它是主动作；不能预览时按钮**不出现**，
  // 那一格已经写清了为什么 —— 一个点下去只会弹「不行」的按钮不是导航。
  //
  // 条件是 `canPreview` **一个**，不是 `canPreview || preview`：后者会在源图没了 /
  // 时长被清空 / 运镜改成认不出的话之后，留下一个「重渲白膜 ↻」只能弹一句失败
  // ——那正是上面这句注释说不要的东西，而第一版自己没做到（codex 轮 4）。
  // 已经渲出来的那一段仍然在（`<video>` 还在，只是标着「对不上」），
  // 所以这里不出现按钮不会让创作者丢掉任何已有的东西。
  const motionBtn = m && m.canPreview
    ? `<button class="btn sm${m.previewStale ? " primary" : ""}"`
      + ` data-kfl-motion="${esc(r.shotId)}">`
      + `${m.preview ? "重渲白膜 ↻" : "预览运镜 →"}</button>`
    : "";
  return (
    `<tr class="kfl-row kfl-${esc(cls)}">` +
    `<td class="mono">${r.seq != null ? esc(String(r.seq).padStart(2, "0")) : ""}</td>` +
    `<td>${esc(r.title || r.shotId)}</td>` +
    `<td><span class="chip ${esc(cls)}">${esc(icon)} ${esc(label)}</span></td>` +
    // ④ 那一格的状态照带：清单要说得出「为什么这一镜还进不去」
    `<td class="kfl-gate">${r.gateOk
      ? `<span class="chip ok">④ 已就绪</span>`
      : `<span class="chip gate">${esc(r.gateReason)}</span>`}</td>` +
    motionCell(r) +
    `<td class="kfl-act">` +
    // **不置灰导航**：进得去看，只是能不能合成另说
    `<button class="btn sm${r.canCompose ? " primary" : ""}" data-kfl-open="${esc(r.shotId)}">` +
    `${r.canCompose ? "进入这一镜的画布合成 →" : "仍然进去看看 →"}</button>` +
    motionBtn +
    `</td></tr>`
  );
}

/** 运镜填充率那一行。**它就是 TASK-098 §4 那个假设的度量** —— 审计当时是 0/60，
 *  而这张卡赌的是「有反馈之后有人写了」。数字放在屏幕上，链尾才有东西可对照。 */
function motionBar(mo) {
  if (!mo || !mo.total) return "";
  const chips = [
    `<span class="chip${mo.written ? " ok" : " none"}">运镜 ${mo.written}/${mo.total} 已写</span>`,
  ];
  if (mo.previewable) chips.push(`<span class="chip">${mo.previewable} 可预览</span>`);
  if (mo.previewed) chips.push(`<span class="chip ok">${mo.previewed} 已看过白膜</span>`);
  if (mo.previewStale) chips.push(`<span class="chip warn">${mo.previewStale} 段白膜对不上现在的运镜</span>`);
  // 三种结局，三个数（不并成一个「认不出」）
  if (mo.unreadable) chips.push(`<span class="chip warn">${mo.unreadable} 认不出</span>`);
  if (mo.unsupported) {
    chips.push(`<span class="chip gate">${mo.unsupported} 认得出但白膜做不到</span>`);
  }
  return (
    `<div class="kfl-mbar" data-kfl-mbar="1">${chips.join(" ")}` +
    `<span class="kfl-mnote">白膜视频：本地渲、零花费 —— 写完运镜点一下就能看到那个运动，`
    + `不必先花钱生成整镜。它只回答「运镜对不对」，不参与成片判定。</span></div>`
  );
}

export function renderKeyframeList(m) {
  if (!m) return "";
  if (!m.total) {
    return (
      `<div class="kfl kfl-empty"><b>这一集还没有镜头</b>` +
      `<span class="meta">⑤ 是按镜头合成的 —— 先在第 ① 步确认镜头</span></div>`
    );
  }
  return (
    `<div class="kfl" data-kfl="1">` +
    `<div class="kfl-h"><b>⑤ Keyframe 合成</b>` +
    `<span class="meta">草图给构图 · 角色设定图给身份 · 场景图给环境 · 分镜提示词给描述与风格` +
    ` —— 它是合成，不是又一次文生图</span>` +
    `<span class="push"></span>` +
    `<span class="chip">${m.approved}/${m.total} 已通过</span>` +
    (m.made ? `<span class="chip warn">${m.made} 待确认</span>` : "") +
    (m.skipped ? `<span class="chip skip">${m.skipped} 已跳过</span>` : "") +
    (m.notStarted ? `<span class="chip none">${m.notStarted} 还没合成</span>` : "") +
    `<button class="btn sm" data-kfl-try>用同一套默认编排试一遍</button>` +
    `</div>` +
    motionBar(m.motion) +
    // 待办，不是阻塞（§2.5f 第二条）
    (m.todo ? `<div class="kfl-todo">${esc(m.todo)}</div>` : "") +
    `<table class="kfl-t"><thead><tr>` +
    `<th>镜号</th><th>镜头</th><th>⑤ 状态</th><th>④→⑤ 闸门</th><th>运镜 · 白膜</th><th>动作</th>` +
    `</tr></thead><tbody>${m.rows.map(row).join("")}</tbody></table>` +
    `</div>`
  );
}

export function bindKeyframeList(root, ctx, ui, rerender) {
  root.querySelectorAll("[data-kfl-open]").forEach((el) => (el.onclick = () => {
    // 「进入这一镜的画布」= 选中这一镜并切到它的画布 —— 那才是做合成的地方
    ctx.keyframe.openCanvas(el.dataset.kflOpen);
    rerender();
  }));
  root.querySelectorAll("[data-kfl-motion]").forEach((el) => (el.onclick = () => {
    // 白膜是异步的（本地 ffmpeg 要几秒），按钮就地说出它在做什么 —— 不然
    // 创作者会以为没反应而连点，而每一次连点都是一段新版本的文件。
    el.disabled = true;
    const was = el.textContent;
    el.textContent = "正在渲白膜…";
    // `render` 只捕获了发请求那一段；登记 / 持久化 / 刷新抛错会变成一条**未处理的
    // Promise rejection** —— 屏幕上什么都不说，按钮却复原了（codex 轮 1 的
    // non-blocking）。`catch` 在这里，因为这是唯一的调用点。
    Promise.resolve(ctx.motionPreview.render(el.dataset.kflMotion))
      .catch((e) => ctx.toast(`白膜出错了：${(e && (e.detail || e.message)) || e}`))
      .finally(() => {
        el.disabled = false;
        el.textContent = was;
        rerender();
      });
  }));
  const tryAll = root.querySelector("[data-kfl-try]");
  if (tryAll) tryAll.onclick = () => {
    // 报价由界面手上那一份 preflight 提供（`ui.gcQuote`）—— 没有就是没有，
    // 控制器会据此拒绝提交（不知道 ≠ 可以送）
    ctx.keyframe.tryAll({ preflight: ui.gcQuote || null });
    rerender();
  };
}
