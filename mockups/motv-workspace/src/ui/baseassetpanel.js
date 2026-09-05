// 基础资产面板 (TASK-065 §1 / §4) — ONE component, used by BOTH 人物 and 世界观.
//
//   参考图（含每个状态自己的参考图） · 基础生图 Prompt · Base Voice（仅人物）
//
// WHY ONE COMPONENT. §1 and §4 ask for the same thing about two different entity
// kinds: 林婉 needs a portrait, a per-state portrait and a base prompt; 暗夜酒吧
// needs a plate, a per-state plate and a base prompt. Two implementations would be
// two places to fix the next bug in either, and they would drift on the detail that
// matters most — that a STATE's reference list is a separate, self-contained list
// (see workflow/baseassets.js).
//
// EVERY WRITE GOES THROUGH `ctx.baseAssets` / `ctx.basePrompt`, which in turn go
// through the ordinary registration and bible paths. Nothing here opens an upload
// path of its own, so there is no way for a file to land on disk without being
// declared (ADR-0055: 上传 ≠ 保存文件).
//
// PURE PRESENTATION over the read model.

import { esc } from "../util/dom.js";

const PROMPT_SOURCE_LABEL = {
  compiled: "自动编译（未保存版本）",
  manual: "手工版本",
  skill: "来自 Skill 提案",
};

const KIND_WORD = { character: "人物", location: "场景" };

/**
 * WHICH state this panel is operating on.
 *
 * SHARED BY RENDER AND BIND, and that is the whole reason it is a function. The
 * gallery, the prompt and every upload button target the SAME state — deriving it
 * separately in the two halves is how 「上传到少女时期」 ends up attached to the base
 * character (the same class of bug as `inspectorTarget` in the production
 * inspector: a panel that shows one object while its buttons write to another).
 *
 * A previewed state that no longer exists collapses to the base entity rather than
 * being kept: writing to a state that is gone is not a thing that can succeed.
 */
export function panelTarget(one, ui) {
  const want = (ui.bibleState && ui.bibleState[one.entityId]) || null;
  const st = want ? one.states.find((s) => s.stateId === want) || null : null;
  return {
    stateId: st ? st.stateId : null,
    state: st,
    label: st ? `${one.name} / ${st.name}` : one.name,
    refs: st ? st.refs : one.refs,
    inherited: st ? st.inherited : false,
    promptKey: st ? st.promptKey : one.promptKey,
  };
}

/** The reference gallery for the current target. */
function gallery(one, t) {
  if (!t.refs.length) {
    return (
      `<div class="ba-none">` +
      (t.state
        ? `状态「${esc(t.state.name)}」还没有参考图。`
        : `${esc(one.name)} 还没有参考图 —— 这是后续每一个镜头复用的锚点。`) +
      `</div>`
    );
  }
  return (
    `<div class="ba-gal">` +
    t.refs
      .map((r, i) => {
        const thumb = r.missing
          ? `<span class="ba-th none" title="${esc(r.assetId)}">字节已不在</span>`
          : r.url
            ? `<img class="ba-th" src="${esc(r.url)}" alt="${esc(r.name)}" loading="lazy">`
            : `<span class="ba-th none">无预览</span>`;
        return (
          `<figure class="ba-item${r.active ? " on" : ""}">${thumb}` +
          `<figcaption><b>${esc(r.name)}</b>` +
          `<span class="ba-cap">v${esc(String(r.version ?? i + 1))}${r.active ? " · 主图" : ""}</span>` +
          `</figcaption>` +
          `<div class="ba-itemacts">` +
          (r.active
            ? `<span class="chip ok">主图</span>`
            : `<button class="btn sm" data-ba-active="${esc(r.assetId)}">设为主图</button>`) +
          `<button class="btn sm" data-ba-detach="${esc(r.assetId)}">移除</button>` +
          `</div></figure>`
        );
      })
      .join("") +
    `</div>`
  );
}

/** 基础生图 Prompt — the same version semantics as a shot prompt, because it is the
 *  same document (see ctx.basePrompt). */
function promptSec(ctx, one, t, ui) {
  const kind = one.kind;
  const eff = ctx.basePrompt.effective(kind, one.entityId, t.stateId);
  const entry = ctx.basePrompt.entry(kind, one.entityId, t.stateId);
  const buf = ui.bpText && ui.bpText.key === t.promptKey ? ui.bpText.text : null;
  const text = buf == null ? eff.text : buf;
  const dirty = buf != null && buf !== eff.text;
  const compiledRow =
    `<li class="${!entry || entry.active === 0 ? "cur" : ""}">` +
    `<span class="pi-vmeta"><b>自动编译</b>` +
    `<span class="pi-vorigin">由${esc(KIND_WORD[kind] || "")}设定实时推导，不会过期</span></span>` +
    (!entry || entry.active === 0
      ? `<span class="chip ok">ACTIVE</span>`
      : `<button class="btn sm" data-ba-pver="0">设为当前</button>`) +
    `</li>`;
  const versions =
    `<ul class="pi-vlist">` + compiledRow +
    (entry
      ? entry.versions.slice().sort((a, b) => b.v - a.v).map((v) =>
          `<li class="${v.v === entry.active ? "cur" : ""}">` +
          `<span class="pi-vmeta"><b>v${v.v}</b><span class="pi-vorigin">` +
          `${esc(PROMPT_SOURCE_LABEL[v.origin] || v.origin)}` +
          `${v.at ? ` · ${esc(String(v.at).slice(0, 16).replace("T", " "))}` : ""}</span></span>` +
          (v.v === entry.active
            ? `<span class="chip ok">ACTIVE</span>`
            : `<button class="btn sm" data-ba-pver="${v.v}">设为当前</button>`) +
          `</li>`).join("")
      : "") +
    `</ul>`;
  return (
    `<section class="ba-sec"><div class="lab">基础生图 Prompt · ${esc(t.label)}</div>` +
    `<div class="meta">来源：${esc(PROMPT_SOURCE_LABEL[eff.source] || eff.source)}` +
    (eff.version ? ` v${eff.version}` : "") +
    (eff.locked ? " · 已锁定" : "") +
    (dirty ? " · <b>有未保存的修改</b>" : "") + `</div>` +
    `<textarea class="field ba-prompt" rows="8" spellcheck="false">${esc(text)}</textarea>` +
    (eff.missing && eff.missing.length
      ? `<ul class="pi-missing">${eff.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
      : "") +
    `<div class="pi-acts">` +
    `<button class="btn" data-ba-pcopy>复制</button>` +
    `<button class="btn primary" data-ba-psave${dirty ? "" : " disabled"}>保存为新版本</button>` +
    `<button class="btn" data-ba-precompile>回到自动编译</button>` +
    `<button class="btn" data-ba-plock>${eff.locked ? "解锁" : "锁定"}</button>` +
    `</div>` +
    versions +
    `<div class="meta">编辑不会自动版本化：按「保存为新版本」才成为持久版本，旧版本全部保留。` +
    `这一段是给外部生图工具用的 —— 复制出去出图，回来上传成这个${esc(KIND_WORD[kind] || "")}的参考图。</div>` +
    `</section>`
  );
}

/** Base Voice — CHARACTERS ONLY. A location has no voice, and rendering an empty
 *  voice block for one would be a control that can never mean anything. */
function voiceSec(ctx, one, ui) {
  const v = one.voice;
  const opts = ui.baVoicePick === one.entityId ? ctx.baseAssets.voiceOptions(one.entityId) : null;
  return (
    `<section class="ba-sec"><div class="lab">Base Voice · 基础声音</div>` +
    `<div class="meta">一个人物只有一个声音身份。状态只能调「表现」（语速 / 情绪 / 年龄感），` +
    `不能换成另一个声音 —— 这条规则由领域层强制。</div>` +
    `<label class="ws-lab">声音标识（本地 TTS 用；可留空）</label>` +
    `<input class="ws-bibleinput" data-b-voice="${esc(one.entityId)}" data-field="voiceId" ` +
    `placeholder="如 piper 声音名" value="${esc(v.voiceId || "")}">` +
    `<label class="ws-lab">声音描述（音色 / 年龄感 / 语气）</label>` +
    `<input class="ws-bibleinput" data-b-voice="${esc(one.entityId)}" data-field="description" ` +
    `placeholder="如：偏低、克制、尾音收得很快" value="${esc(v.description)}">` +
    (v.sample
      ? `<div class="ba-voice">` +
        (v.sample.url && v.sample.storageState === "local"
          ? `<audio class="pi-audio" src="${esc(v.sample.url)}" controls preload="metadata"></audio>`
          : `<div class="ba-none">已登记声音样本，但字节不在本地（记录仍在）。</div>`) +
        `<div class="meta">样本：${esc(v.sample.key)} v${esc(String(v.sample.version))}` +
        `（共 ${esc(String(v.sample.versions))} 版）</div></div>`
      : `<div class="ba-none">还没有上传声音样本。文字描述已经能驱动外部 TTS；样本让「听起来像谁」有据可依。</div>`) +
    (v.statePerformance.length
      ? `<div class="pi-chips">${v.statePerformance
          .map((p) => `<span class="chip">${esc(p.name)} · ${esc(p.description)}</span>`).join("")}</div>`
      : "") +
    `<div class="pi-acts">` +
    `<button class="btn" data-ba-upvoice>上传声音样本…</button>` +
    `<button class="btn" data-ba-voicepick>${opts ? "收起资产库" : "从资产库选择…"}</button>` +
    `</div>` +
    (opts
      ? (opts.length
        // A take that already belongs to ANOTHER character is SHOWN and NAMED but
        // offers no button: `links.characterId` is single-valued, so re-pointing it
        // here would delete that character's only sample. Listing it with a live
        // button would be a control that destroys somebody else's canon.
        ? `<ul class="pi-vlist">${opts.map((o) =>
            `<li><span class="pi-vmeta"><b>${esc(o.label)}</b>` +
            `<span class="pi-vorigin">${esc(o.kind)}` +
            (o.takenBy ? ` · 已属于「${esc(o.takenByName || o.takenBy)}」` : "") +
            `</span></span>` +
            (o.takenBy
              ? `<span class="chip mute" title="一条样本只能属于一个人物；改挂过来会让那个人物失去它">不可改挂</span>`
              : `<button class="btn sm" data-ba-usevoice="${esc(o.assetId)}">用作基础声音</button>`) +
            `</li>`).join("")}</ul>` +
          `<div class="meta">一条样本只能属于一个人物（<code>links.characterId</code> 是单值）。` +
          `要让两个人物用同一个配音演员，请分别上传各自的样本。</div>`
        : `<div class="ba-none">资产库里还没有可用的声音资产。</div>`)
      : "") +
    `</section>`
  );
}

/**
 * The panel.
 *
 * `one` is `ctx.baseAssets.one(...)`'s output for this entity. `ui` carries only
 * transient view state (previewed state, open picker, unsaved prompt buffer).
 */
export function renderBaseAssetPanel(ctx, one, ui) {
  if (!one) return "";
  const t = panelTarget(one, ui);
  const kindWord = KIND_WORD[one.kind] || "";
  const pick = ui.baRefPick === one.entityId ? ctx.baseAssets.referenceOptions(one.kind) : null;
  const attached = new Set(t.refs.map((r) => r.assetId));
  const stateBar = one.states.length
    ? `<div class="ba-states">` +
      `<button class="ba-state${t.stateId ? "" : " on"}" data-ba-state="">基础形态</button>` +
      one.states
        .map((st) =>
          `<button class="ba-state${t.stateId === st.stateId ? " on" : ""}" data-ba-state="${esc(st.stateId)}">` +
          `${esc(st.name)}${st.inherited ? "" : ` <span class="ct">${st.refs.length}</span>`}</button>`)
        .join("") +
      `<button class="ba-state add" data-ba-addstate>＋ 添加状态</button>` +
      `</div>`
    : `<div class="ba-states"><span class="meta">还没有状态（少女时期 / 受伤状态 / 日常…）。</span>` +
      `<button class="ba-state add" data-ba-addstate>＋ 添加状态</button></div>`;
  return (
    `<div class="ba">` +
    `<div class="ba-hd"><b>基础资产</b>` +
    `<span class="meta">长期复用：这里定好了，后面每一个镜头直接引用，不重做。</span></div>` +
    (one.gaps.length
      ? `<ul class="pi-missing">${one.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`
      : `<div class="pi-ok">基础资产齐了 — 镜头可以直接复用。</div>`) +
    stateBar +
    `<section class="ba-sec"><div class="lab">${esc(kindWord)} Reference · ${esc(t.label)}</div>` +
    (t.state
      ? (t.inherited
        ? `<div class="meta">这个状态目前<b>继承</b>基础参考图。上传或选择一张后，它就有自己的列表` +
          `（「继承基础」和「这个状态没有参考图」是两件不同的事，不会被混成一个）。</div>`
        : `<div class="meta">这个状态有自己的参考图列表。` +
          `<button class="btn sm" data-ba-inherit>恢复继承基础参考图</button></div>`)
      : "") +
    gallery(one, t) +
    `<div class="pi-acts">` +
    // ✨ 自动生成（TASK-139 / REQ-008 判据 1）。产品负责人 2026-09-05：
    //「自动生图应该在我点人物进去之后就能生成」—— 参考图是「基础财产」，
    // 它就该在定义这个人物的地方长出来，而不是要他先去某一镜里绕一圈。
    //
    // 用的是**这一块自己那段编译好的提示词**（下面「提示词」小节里可见、可改、
    // 可锁定的那一份），不另编一份 —— 屏幕上显示哪一份，就用哪一份。
    `<button class="btn primary" data-ba-gen title="用下面那段提示词自动生成一张参考图（免费 · 不产生账单）">✨ 自动生成</button>` +
    `<button class="btn" data-ba-upload>上传参考图…</button>` +
    `<button class="btn" data-ba-refpick>${pick ? "收起资产库" : "从资产库选择…"}</button>` +
    `</div>` +
    (pick
      ? (pick.length
        ? `<ul class="pi-vlist">${pick.map((o) =>
            `<li>` +
            (o.url ? `<img class="pi-vth" src="${esc(o.url)}" alt="" loading="lazy">` : `<span class="pi-vth none">⃠</span>`) +
            `<span class="pi-vmeta"><b>${esc(o.label)}</b><span class="pi-vorigin">v${esc(String(o.version))}` +
            (o.kind === "external-reference" ? " · 外部参考" : "") + `</span></span>` +
            (attached.has(o.assetId)
              ? `<span class="chip ok">已在此</span>`
              : `<button class="btn sm" data-ba-attach="${esc(o.assetId)}">加入</button>`) +
            `</li>`).join("")}</ul>`
        : `<div class="ba-none">资产库里还没有可用的${esc(kindWord)}参考。</div>`)
      : "") +
    `<div class="meta">上传即登记：文件落盘的同一次调用里声明它是什么、属于谁 —— 绝不产生孤立媒体。` +
    `名称会先给出一个建议（由${esc(kindWord)}名 + 状态推导），确认后才登记。</div>` +
    `</section>` +
    promptSec(ctx, one, t, ui) +
    (one.kind === "character" ? voiceSec(ctx, one, ui) : "") +
    `</div>`
  );
}

/**
 * Bind the panel. `entityId` + `kind` name the entity; the STATE comes from
 * `panelTarget`, the same derivation render used.
 *
 * `rerender` is the workspace's own re-render. Every write here goes through a ctx
 * controller which already persists and re-renders the shell, so the extra call is
 * for the panel's own transient state (a closed picker, a dropped buffer).
 */
export function bindBaseAssetPanel(root, ctx, ui, rerender, { kind, entityId }) {
  const one = () => ctx.baseAssets.one(kind, entityId);
  const target = () => {
    const o = one();
    return o ? panelTarget(o, ui) : null;
  };
  const on = (q, fn) => { const el = root.querySelector(q); if (el) el.onclick = fn; };
  const all = (q, fn) => root.querySelectorAll(q).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); fn(el); }));

  all("[data-ba-state]", (el) => {
    const sid = el.dataset.baState || null;
    ui.bibleState[entityId] = sid;
    // the prompt buffer belongs to the state it was typed against — carrying it
    // across would offer 少女时期 the prompt written for 日常 and save it there
    ui.bpText = null;
    rerender();
  });
  on("[data-ba-addstate]", () => {
    const name = window.prompt(
      kind === "character"
        ? "状态名称（如：日常 / 少女时期 / 受伤状态）"
        : "状态名称（如：白天 / 雨夜 / 停电）",
    );
    if (name == null || !name.trim()) return;
    const rec = kind === "character"
      ? ctx.bible.addCharacterState(entityId, name.trim())
      : ctx.bible.addLocationState(entityId, name.trim());
    if (rec) { ui.bibleState[entityId] = rec.stateId; ui.bpText = null; rerender(); }
  });

  // --- references --------------------------------------------------------- //
  // ✨ 自动生成一张参考图（TASK-139 / REQ-008 判据 1）。
  //
  // 与上传那一颗**共用同一条登记路**（`uploadReference`），所以命名、目标存在性
  // 检查、挂到这个状态上、以及「登记成功却没挂上」那条诚实报告，一条都不重写。
  // 差别只有一处：不弹文件框，改把提示词交给后端。
  // 用 `all` 而不是 `on`：`on` 把**事件**交给回调，而这里要的是那颗按钮本身
  //（生成期间要把它禁掉）。`all` 传的是元素，顺带 stopPropagation。
  all("[data-ba-gen]", async (btn) => {
    const t = target();
    if (!t) return;
    const eff = ctx.basePrompt.effective(kind, entityId, t.stateId);
    const prompt = (eff && eff.text) || "";
    if (!prompt.trim()) {
      // 空提示词生成出来的是一张与这个角色无关的图 —— 那比不生成更糟
      ctx.toast("这一项还没有提示词 —— 先把设定填上，下面那段会自动编译出来");
      return;
    }
    const suggested = ctx.baseAssets.suggestName(kind, entityId, t.stateId);
    if (btn) btn.disabled = true;
    ctx.toast("生成中…（免费来源，可能要几十秒）");
    try {
      const ref = await ctx.baseAssets.uploadReference(kind, entityId, t.stateId, {
        displayName: suggested || null,
        prompt,
      });
      if (ref) ctx.toast(`已生成并挂到「${t.label}」，后续镜头可以直接复用（未产生账单）`);
    } catch (e) {
      const why =
        e.category === "quota_exhausted"
          ? "这个来源的额度用完了 —— 换 .env.local 里的 IMAGE_PROVIDER，或稍后再试"
          : e.category === "billing_not_established"
            ? "这把 key 没声明是免费额度那一档，已拒绝（按次计费请走付费那条）"
            : e.category === "side_effect_unknown"
              ? "上一次没能确认结果 —— 要再来一次得显式确认"
              : e.message;
      // 「消耗没消耗」由 sideEffect 说，不由类别说
      ctx.toast(
        `生成失败：${why}` +
          (e.sideEffect && e.sideEffect !== "none"
            ? `（这一次${e.sideEffect === "applied" ? "已经" : "可能已经"}消耗过）`
            : ""),
      );
    } finally {
      if (btn) btn.disabled = false;
    }
    rerender();
  });
  on("[data-ba-upload]", async () => {
    const t = target();
    if (!t) return;
    // The SUGGESTED name is offered, never applied: the creator confirms or edits
    // it, and 「取消」 aborts the whole upload rather than registering something
    // under a name nobody accepted (workflow/baseassets.js explains the derivation).
    const suggested = ctx.baseAssets.suggestName(kind, entityId, t.stateId);
    const name = window.prompt(
      `这张参考图叫什么？（建议名称由${KIND_WORD[kind]}名 + 状态推导，可直接改）`,
      suggested,
    );
    if (name == null) return;
    try {
      const ref = await ctx.baseAssets.uploadReference(kind, entityId, t.stateId, {
        displayName: name.trim() || suggested || null,
      });
      if (ref) ctx.toast(`已登记并挂到「${t.label}」，后续镜头可以直接复用`);
    } catch (e) {
      ctx.toast(`上传失败：${e.message}`);
    }
    rerender();
  });
  on("[data-ba-refpick]", () => {
    ui.baRefPick = ui.baRefPick === entityId ? null : entityId;
    rerender();
  });
  all("[data-ba-attach]", (el) => {
    const t = target();
    if (!t) return;
    const ok = ctx.baseAssets.attach(kind, entityId, t.stateId, el.dataset.baAttach, { active: !t.refs.length });
    if (!ok) ctx.toast("无法加入这张参考图");
    rerender();
  });
  all("[data-ba-active]", (el) => {
    const t = target();
    if (!t) return;
    if (!ctx.baseAssets.setActive(kind, entityId, t.stateId, el.dataset.baActive)) {
      ctx.toast("无法设为主图");
    }
    rerender();
  });
  all("[data-ba-detach]", (el) => {
    const t = target();
    if (!t) return;
    ctx.baseAssets.detach(kind, entityId, t.stateId, el.dataset.baDetach);
    // 移除 releases the USE, never the asset: it stops being this character's
    // reference and stays in the library as the character reference it is.
    ctx.toast("已从这里移除 —— 资产本身仍在资产库里");
    rerender();
  });
  on("[data-ba-inherit]", () => {
    if (!ctx.baseAssets.inheritRefs(kind, entityId, (target() || {}).stateId)) {
      ctx.toast("无法恢复继承");
    }
    rerender();
  });

  // --- base prompt -------------------------------------------------------- //
  const ta = root.querySelector(".ba-prompt");
  const promptKey = () => (target() || {}).promptKey || null;
  if (ta) {
    ta.oninput = () => {
      const key = promptKey();
      if (!key) return;
      ui.bpText = { key, text: ta.value };
      const save = root.querySelector("[data-ba-psave]");
      if (!save) return;
      const t = target();
      const eff = ctx.basePrompt.effective(kind, entityId, t.stateId);
      if (ta.value !== eff.text) save.removeAttribute("disabled");
      else save.setAttribute("disabled", "");
    };
  }
  const promptText = () => {
    const t = target();
    const key = t ? t.promptKey : null;
    return ui.bpText && ui.bpText.key === key
      ? ui.bpText.text
      : ctx.basePrompt.effective(kind, entityId, t ? t.stateId : null).text;
  };
  on("[data-ba-pcopy]", () => ctx.episode.copyPrompt(promptText()));
  on("[data-ba-psave]", (ev) => {
    if (ev && ev.currentTarget && ev.currentTarget.hasAttribute("disabled")) return;
    const t = target();
    if (!t || !ui.bpText || ui.bpText.key !== t.promptKey) { ctx.toast("没有未保存的修改"); return; }
    const v = ctx.basePrompt.save(kind, entityId, t.stateId, ui.bpText.text);
    if (!v) { ctx.toast("保存失败：这个 Prompt 已锁定"); return; }
    ui.bpText = null;
    ctx.toast(`已保存为 Prompt v${v}（旧版本保留，可回切）`);
    rerender();
  });
  on("[data-ba-precompile]", () => {
    const t = target();
    ui.bpText = null;
    const e = ctx.basePrompt.entry(kind, entityId, t ? t.stateId : null);
    if (e && e.active !== 0) {
      if (e.locked === true) { ctx.toast("这个 Prompt 已锁定：先解锁，再切回自动编译"); rerender(); return; }
      ctx.basePrompt.useCompiled(kind, entityId, t ? t.stateId : null);
    }
    rerender();
  });
  on("[data-ba-plock]", () => {
    const t = target();
    const cur = ctx.basePrompt.entry(kind, entityId, t ? t.stateId : null);
    if (!cur) { ctx.toast("先保存一个版本，才有可锁定的对象"); return; }
    ctx.basePrompt.setLocked(kind, entityId, t ? t.stateId : null, !(cur.locked === true));
    rerender();
  });
  all("[data-ba-pver]", (el) => {
    const t = target();
    const want = +el.dataset.baPver;
    const ok = want === 0
      ? ctx.basePrompt.useCompiled(kind, entityId, t ? t.stateId : null)
      : ctx.basePrompt.setActive(kind, entityId, t ? t.stateId : null, want);
    if (ok) ui.bpText = null;
    else if (want === 0) ctx.toast("这个 Prompt 已锁定：先解锁，再切回自动编译");
    rerender();
  });

  // --- base voice (characters only) --------------------------------------- //
  on("[data-ba-upvoice]", async () => {
    try {
      const ref = await ctx.baseAssets.uploadVoice(entityId);
      if (ref) ctx.toast("已登记为这个人物的基础声音样本");
    } catch (e) {
      ctx.toast(`上传失败：${e.message}`);
    }
    rerender();
  });
  on("[data-ba-voicepick]", () => {
    ui.baVoicePick = ui.baVoicePick === entityId ? null : entityId;
    rerender();
  });
  all("[data-ba-usevoice]", (el) => {
    // the controller answers WHY it refused — a toast that says 「失败」 with no reason
    // leaves the creator with no next step
    const res = ctx.baseAssets.useVoiceAsset(entityId, el.dataset.baUsevoice);
    if (res.ok) {
      ui.baVoicePick = null;
      ctx.toast("已设为这个人物的基础声音");
    } else {
      ctx.toast(res.error);
    }
    rerender();
  });
}
