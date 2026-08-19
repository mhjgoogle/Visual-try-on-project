// 第 ② 步「准备资产」的界面 (TASK-095 §2.2 图 3 / 图 4 · TASK-097 批次 4C)。
//
//   ┌ 全局风格（视觉基调，AI 写，人可改）────────────────────┐
//   │ 角色  [卡][卡][卡] ＋新增                              │
//   │ 场景  [卡][卡]     ＋新增                              │
//   │ 道具  [卡]         ＋新增                              │
//   └ 检测到 5 个人物角色和 3 个场景和 2 个道具没有设定图 ────┘
//
// 点一张卡 → 「选择图片（现代沈昭昭）」，三个 tab：
//   AI 生成 / 从资产库选 / 本地上传
//
// **不新增页面**（ADR-0066 决策 10）：它是 `shotwork · 准备` 这一节里的一块，
// 与参考统筹同屏。
//
// 关于底部那句话：**它是待办，不是阻塞**（§2.5f 第二条）。第 ② 步的全部工作就是
// 把设定图补齐，所以这句话是工作清单；把它做成一道拦住这一步的门，界面就在拦住
// 它请创作者做的事。**这里没有 disabled，也没有「还不能开始」。**
//
// 关于「AI 生成」那个 tab 里的提示词：它由 `ctx.basePrompt` 编译，而**构图规范来自
// Skill 包**（base-asset-designer 的 promptBlocks）。规范拿不到时提示词里那一段
// 就是缺的，界面**如实说出来**并说清后果（这张图之后当不成参考图用），
// 不假装它在。
//
// 报价只显示 preflight 给的数（ADR-0071 决策 6 / genspec）：界面永不自算。
//
// PURE PRESENTATION over the read model；写入全部经 ctx。

import { esc } from "../util/dom.js";
import { prepKind } from "../workflow/assetprep.js";
import { quoteView } from "../workflow/genspec.js";

const TABS = [
  ["ai", "AI 生成"],
  ["library", "从资产库选"],
  ["upload", "本地上传"],
];

/** 一张卡。**「已有设定图」与底部那句缺口话术同源**（见 assetprep 文件头第 2 条）。 */
function card(r) {
  const kind = prepKind(r.kind);
  return (
    `<button class="ap-card${r.ready ? " ok" : ""}" data-ap-open="${esc(r.kind)}:${esc(r.id)}">` +
    `<span class="ap-thumb">${r.ready ? "🖼" : "＋"}</span>` +
    `<b>${esc(r.name || `未命名${kind ? kind.label : ""}`)}</b>` +
    `<span class="ap-sum">${esc(r.summary || "还没写描述")}</span>` +
    `<span class="ap-badge">${r.ready
      ? `已有设定图${r.refCount > 1 ? ` · ${r.refCount} 张` : ""}`
      : "生成或上传设定图"}</span>` +
    `</button>`
  );
}

function group(g) {
  return (
    `<section class="ap-group" data-ap-group="${esc(g.kind)}">` +
    `<div class="ap-gh"><b>${esc(g.label)}</b>` +
    `<span class="meta">${g.ready}/${g.total} 已有设定图</span></div>` +
    `<div class="ap-cards">` +
    g.rows.map(card).join("") +
    `<button class="ap-card ap-new" data-ap-add="${esc(g.kind)}">＋ 新增${esc(g.label)}</button>` +
    `</div></section>`
  );
}

/** 「选择图片（名字）」弹窗。三个 tab，一次只显示一个。 */
function picker(ctx, m, ui) {
  const sel = ui.apOpen;
  if (!sel) return "";
  const [kind, id] = String(sel).split(":");
  const row = (m.groups.find((g) => g.kind === kind) || { rows: [] }).rows
    .find((r) => r.id === id);
  if (!row) return "";
  const tab = ui.apTab || "ai";
  const head =
    `<div class="ap-modal-h"><b>选择图片（${esc(row.name)}）</b>` +
    `<span class="push"></span><button class="icon-btn" data-ap-close>✕</button></div>` +
    `<div class="ap-tabs">` +
    TABS.map(([k, label]) =>
      `<button class="ap-tab${k === tab ? " on" : ""}" data-ap-tab="${esc(k)}">${esc(label)}</button>`).join("") +
    `</div>`;

  let body = "";
  if (tab === "ai") {
    const p = ctx.basePrompt.effective(kind, id);
    const q = quoteView(ui.apQuote || null);
    body =
      `<div class="ap-ai">` +
      `<label class="ap-label">AI 已经写好的提示词（名称 / 描述 / 服装 / 特征 / 构图规范）</label>` +
      `<textarea class="ap-prompt" rows="10" data-ap-prompt>${esc(p.text || "")}</textarea>` +
      (p.missing && p.missing.length
        // 缺口如实列出。**其中「构图规范」那一条最要紧**：少了它这张图能生成，
        // 但之后当不成参考图用 —— 所以它必须写在创作者按「确认生成」之前的位置。
        ? `<ul class="ap-missing">` + p.missing.map((x) => `<li>${esc(x)}</li>`).join("") + `</ul>`
        : `<div class="ap-ok">这一段可以直接用来出图</div>`) +
      `<div class="ap-foot">` +
      // 报价：**只显示 preflight 给的数**（ADR-0071 决策 6 / genspec）。
      // `quoteView` 的字段是 `available` / `reason` / `cost`，没有 `text` 也没有
      // `ok` —— 第一版照着想象写成 `q.text`，真实屏幕上就印出了 "undefined"
      // （§2.6.4：测试全绿，是打开看才看到的）。
      (q.available
        ? `<span class="ap-quote">⚡ ${esc(String(q.cost.jpy))}` +
          (q.cost.originalCurrency ? `（${esc(q.cost.originalCurrency)}）` : "") + `</span>`
        : `<span class="ap-quote none">${esc(q.reason)}</span>`) +
      `<button class="btn primary" data-ap-generate="${esc(kind)}:${esc(id)}">确认生成</button>` +
      `</div>` +
      `<div class="meta">${q.available
        ? "报价来自 Gateway preflight —— 界面不自算"
        : "提交后由 Gateway 给出报价，界面不自算；每一次实际扣费仍要你在弹窗里确认两步"}</div>`;
  } else if (tab === "library") {
    // **真的列出候选并且真的能挂上。** 第一版这里只有一个按钮，点了弹一句提示 ——
    // 「tab 打得开、什么也做不了」，正是 §2.5e 里 `available` 却没有处理器的形状
    //（codex 本批 round 2 的 P1）。候选来自 `ctx.baseAssets.referenceOptions`，
    // 与基础资产面板同一份，所以两处看到的候选集不可能不同。
    const opts = ctx.assetPrep.libraryOptions(kind) || [];
    const attached = new Set(row.attachedIds || []);
    body =
      `<div class="ap-lib"><div class="meta">挂的是引用，资产不复制 ——` +
      `同一张图可以同时属于多个对象。</div>` +
      (opts.length
        ? `<ul class="ap-libs">` + opts.map((o) =>
            `<li>` +
            (o.url ? `<img src="${esc(o.url)}" alt="" loading="lazy">` : `<span class="ap-none">⃠</span>`) +
            `<span><b>${esc(o.label)}</b><small>v${esc(String(o.version))}</small></span>` +
            (attached.has(o.assetId)
              ? `<span class="chip ok">已在此</span>`
              : `<button class="btn sm" data-ap-attach="${esc(kind)}:${esc(id)}:${esc(o.assetId)}">挂上</button>`) +
            `</li>`).join("") + `</ul>`
        : `<div class="ap-none">资产库里还没有这一类的参考图 —— 先用「AI 生成」或「本地上传」`
          + `做出第一张</div>`) +
      `</div>`;
  } else {
    body =
      `<div class="ap-up"><div class="meta">上传一张你已经在外部工具出好的图。` +
      `上传即登记（ADR-0055：上传 ≠ 保存文件）。</div>` +
      `<button class="btn" data-ap-upload="${esc(kind)}:${esc(id)}">选择文件…</button></div>`;
  }
  return `<div class="ap-scrim show" data-ap-scrim><div class="ap-modal">${head}${body}</div></div>`;
}

export function renderAssetPrep(ctx, m, ui) {
  if (!m) return "";
  const rec = m.reconcile;
  return (
    `<div class="ap" data-ap="1">` +
    // 全局风格 —— 复用世界观的「视觉基调」，不是新字段（见 assetprep 文件头）
    `<section class="ap-style"><div class="ap-gh"><b>全局风格</b>` +
    `<span class="meta">= 世界观的「视觉基调」，同一份；AI 写，你可以改</span></div>` +
    `<textarea class="ap-styletext" rows="3" data-ap-style ` +
    `placeholder="这部戏看起来是什么样 —— 影调、质感、镜头语言倾向">${esc(m.style)}</textarea>` +
    `</section>` +
    // 对账：AI 抽出的清单 vs 登记表（§2.5e 那条缝）
    `<div class="ap-rec${rec.known ? "" : " unknown"}">` +
    `<span>${esc(rec.text)}</span>` +
    `<button class="btn sm" data-ap-extract>从分镜表抽取资产清单</button>` +
    `</div>` +
    m.groups.map(group).join("") +
    // 底部那句：**待办，不是阻塞**；而且是**三态** —— 「一个都没识别出来」
    // 不得显示成「都已经有设定图」（§2.5f 第一条，真实项目上抓到过）
    `<div class="ap-todo ${esc(m.todoState)}"><b>${esc(m.todo)}</b>` +
    (m.todoState === "gap"
      ? `<span class="meta">这是第 ② 步要做的活，不是拦住你的理由 —— 逐个点开生成或上传即可</span>`
      : "") +
    `</div>` +
    `</div>` +
    picker(ctx, m, ui)
  );
}

/** 绑定。写入全部走既有路径：没有任何一条新的上传 / 登记通道。 */
export function bindAssetPrep(root, ctx, ui, rerender) {
  const style = root.querySelector("[data-ap-style]");
  if (style) style.onchange = () => {
    // 一处写入：世界观的视觉基调（不是第二个 globalStyle 字段）。
    // 走的是既有的 `ctx.canon.updateWorld` —— 不新开写路径。
    ctx.canon.updateWorld({ visualTone: style.value });
    rerender();
  };
  root.querySelectorAll("[data-ap-add]").forEach((el) => (el.onclick = () => {
    const kind = el.dataset.apAdd;
    const name = window.prompt(`新增${(prepKind(kind) || {}).label || ""}的名称`, "");
    if (name == null || !name.trim()) return;
    const made = ctx.assetPrep.add(kind, name.trim());
    if (!made) ctx.toast("没能新增 —— 名称不能为空");
    rerender();
  }));
  root.querySelectorAll("[data-ap-open]").forEach((el) => (el.onclick = () => {
    ui.apOpen = el.dataset.apOpen;
    ui.apTab = "ai";
    rerender();
  }));
  root.querySelectorAll("[data-ap-tab]").forEach((el) => (el.onclick = () => {
    ui.apTab = el.dataset.apTab;
    rerender();
  }));
  root.querySelectorAll("[data-ap-close], [data-ap-scrim]").forEach((el) => (el.onclick = (ev) => {
    if (el.hasAttribute("data-ap-scrim") && ev.target !== el) return;
    ui.apOpen = null;
    rerender();
  }));
  const extract = root.querySelector("[data-ap-extract]");
  if (extract) extract.onclick = () => { ctx.breakdown.run(); rerender(); };
  root.querySelectorAll("[data-ap-generate]").forEach((el) => (el.onclick = () => {
    const [kind, id] = el.dataset.apGenerate.split(":");
    // **生成用的必须是框里那段文字。**
    //
    // 第一版无视了这个可编辑的 textarea，转头从 `ctx.basePrompt.effective` 重新取一遍
    // —— 创作者改了提示词，按下「确认生成」，生成的却是他改之前的那一版，而且没有
    // 任何提示。这与批次 4B 那条「创作者看不见的改动就是他无法拒绝的改动」是同一
    // 形状的镜像：**他看得见、以为生效了，实际被丢掉**（codex 本批 round 1 的 P1）。
    //
    // 改动经**既有的版本路径**落盘（`ctx.basePrompt.save` → promptdoc 追加新版本），
    // 不新开一个存储：于是「用来生成的那一段」与「记录下来的那一段」是同一段。
    const box = root.querySelector("[data-ap-prompt]");
    ctx.assetPrep.generate(kind, id, box ? box.value : null);
    rerender();
  }));
  root.querySelectorAll("[data-ap-attach]").forEach((el) => (el.onclick = () => {
    const [kind, id, assetId] = el.dataset.apAttach.split(":");
    ctx.assetPrep.attachFromLibrary(kind, id, assetId);
    rerender();
  }));
  root.querySelectorAll("[data-ap-upload]").forEach((el) => (el.onclick = () => {
    const [kind, id] = el.dataset.apUpload.split(":");
    ctx.assetPrep.upload(kind, id);
    rerender();
  }));
}
