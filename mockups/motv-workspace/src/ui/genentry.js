// 生成入口 (M10) — compiled prompt → pick an entry → import the result back
import * as genintent from "./genintent.js";
// onto this shot with REAL provenance.
//
// Extracted from the storyboard so the AI Director can host it (spec §3: the
// Director owns the prompt preview, the generation controls and the provider
// choice) while 画面 / 视频 reuse exactly the same flow. Behaviour is
// unchanged: the intent (compiled prompt + entry) is captured when the creator
// copies or opens an entry, and only an import that follows a real intent
// records a Generation. A plain import stays an ordinary upload.
import { esc } from "../util/dom.js";
import { shotDetailModel } from "./storyboard.js";

const ENTRY_URL = { chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/" };

/** Providers offered per media kind. `future: true` renders an honest
 *  "not wired yet" note instead of a button that pretends to generate. */
const PROVIDERS = {
  image: [
    ["chatgpt", "ChatGPT", false],
    ["gemini", "Gemini", false],
    ["manual", "复制提示词", false],
    ["api", "API 自动生成", true],
  ],
  video: [
    ["gemini", "Gemini 视频", false],
    ["manual", "复制提示词", false],
    ["api", "API 自动生成", true],
  ],
};

const KIND_LABEL = { image: "画面", video: "视频", dialogue: "对白", sfx: "音效" };

/** The Director's generation block for ONE shot: prompt preview, provider
 *  choice, primary action, import. `kind` is the media the creator is on. */
export function renderGenEntry(d, kind, chosen) {
  if (kind !== "image" && kind !== "video") {
    return (
      `<div class="dir-unavail">◌ ${esc(KIND_LABEL[kind] || kind)}生成入口在「音频」工作区：` +
      `本地 Piper TTS（免费）· 复制提示词 · 导入 · Voice/Music API（未来）</div>`
    );
  }
  const p = d.prompts[kind];
  const gaps = p.missing.map((mm) => `<div class="chip gate">◌ 缺 ${esc(mm)}</div>`).join("");
  const provs = PROVIDERS[kind]
    .map(([k, label, future]) =>
      future
        ? `<span class="chip mute" title="付费生成当前在工作流节点（ADR-0041/0045）">${esc(label)} · 未来</span>`
        : `<button class="chip${chosen === k ? " gate" : ""}" data-gp-prov="${k}" data-kind="${kind}">${esc(label)}</button>`,
    )
    .join("");
  const primaryLabel = chosen === "manual" || !chosen
    ? "📋 复制提示词"
    : `↗ 复制并打开 ${chosen === "chatgpt" ? "ChatGPT" : "Gemini"}`;
  return (
    `<div class="dir-block"><div class="lab">Prompt 预览 · ${esc(KIND_LABEL[kind])}</div>` +
    (gaps ? `<div class="row tight">${gaps}</div>` : "") +
    `<div class="dir-prompt" data-genprompt="${kind}">${esc(p.text)}</div>` +
    `<div class="lab">生成方式</div><div class="dir-provs">${provs}</div>` +
    `<button class="btn primary" data-gp-go data-kind="${kind}">${esc(primaryLabel)}</button>` +
    `<button class="btn" data-gp-import data-kind="${kind}">⬆ 导入生成结果</button>` +
    `<div class="dir-unavail">◌ API 自动生成为未来能力；付费生成当前在工作流节点（图像 ADR-0045 / 视频 ADR-0041）。` +
    `经本入口导入的结果会记录真实溯源（promptSnapshot + provider）。</div></div>`
  );
}

/** Wire the generation entry. `ui.genProvider` (transient) remembers the
 *  chosen provider per kind; `ui.genIntent` carries the provenance intent. */
export function bindGenEntry(root, ctx, ui, rerender) {
  const promptText = (kind) => {
    const el = root.querySelector(`[data-genprompt="${kind}"]`);
    return el ? el.textContent : "";
  };
  const setIntent = (kind, entry) =>
    genintent.setIntent(ui, kind, ui.selectedShotId, {
      shotId: ui.selectedShotId,
      prompt: promptText(kind),
      entry,
    });
  const copyPrompt = async (kind) => {
    try {
      await navigator.clipboard.writeText(promptText(kind));
      ctx.toast("提示词已复制");
      return true;
    } catch {
      ctx.toast("复制失败：请手动选择文本复制");
      return false;
    }
  };
  root.querySelectorAll("[data-gp-prov]").forEach((b) => (b.onclick = () => {
    ui.genProvider = ui.genProvider || {};
    ui.genProvider[b.dataset.kind] = b.dataset.gpProv;
    rerender();
  }));
  const go = root.querySelector("[data-gp-go]");
  if (go)
    go.onclick = async () => {
      const kind = go.dataset.kind;
      const prov = (ui.genProvider && ui.genProvider[kind]) || "manual";
      if (prov === "manual") {
        if (await copyPrompt(kind)) setIntent(kind, "manual");
        return;
      }
      // open FIRST, synchronously in the user gesture — an awaited clipboard
      // call before window.open can demote it to a blocked popup
      window.open(ENTRY_URL[prov] || "about:blank", "_blank", "noopener");
      // provenance intent ONLY when the prompt actually reached the clipboard:
      // a denied copy must not fake a "sent to ChatGPT" record
      if (await copyPrompt(kind)) setIntent(kind, `${prov}-manual`);
    };
  const imp = root.querySelector("[data-gp-import]");
  if (imp)
    imp.onclick = () => {
      const kind = imp.dataset.kind;
      const d = shotDetailModel(ctx.prodData(), ui.selectedShotId);
      if (!d || !d.slot) { ctx.toast("镜头身份未解析：无法定位媒体槽位"); return; }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        // keyed by (kind, shot) — see genintent.js. The shot is IN the key now, so
        // there is no second place where 「是这一镜的吗」 could be answered differently.
        const shotId = ui.selectedShotId;
        const intent = genintent.getIntent(ui, kind, shotId);
        try {
          await ctx.media.importShotMedia(kind, d.slot, shotId, file, intent);
          // consume ONLY the intent this import used — a NEWER intent set while
          // the upload was in flight belongs to the next import
          genintent.consumeIntent(ui, kind, shotId, intent);
          rerender();
        } catch (err) {
          ctx.toast("导入失败：" + err.message);
        }
      };
      input.click();
    };
}
