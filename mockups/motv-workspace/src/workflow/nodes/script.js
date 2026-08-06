// 剧本 — editable screenplay text. Feeds the 脚本生成器 (分镜).
import { nx } from "./shared.js";
import { esc } from "../../util/dom.js";

export default {
  type: "script",
  step: 0,
  stage: "S1 剧本",
  title: "剧本",
  icon: "📄",
  init() {
    return { text: null }; // falls back to project fixture on first render
  },
  render(node, ctx) {
    const text = node.text ?? ctx.project.script;
    return `<div class="scriptbox"><textarea class="scripttext" spellcheck="false">${esc(text)}</textarea>${nx([["scriptgen", "生成分镜"]])}</div>`;
  },
  // editing is handled globally in app.js (input on .scripttext -> node.text)
  next: ["scriptgen"],
};
