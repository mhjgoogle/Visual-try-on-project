// Prompt 编译器 (checkpoint M10) — the pure compilation step between a Shot's
// creative context and a generation entry:
//
//   Shot + Character/State + Location/State + Shot visual  →  Image Prompt
//   Shot Image + Action + Camera Motion (+duration/dialogue) →  Video Prompt
//
// INPUTS are already-resolved domain views (bibledoc.resolveCharacter /
// resolveLocation over the scene's references, the shot's raw draft fields,
// the outline's genre/tone) — this module composes text and reports honest
// GAPS (`missing`), it never invents content for absent facets and never
// mutates any domain state. Pure functions only: no fetch, no DOM, no clock.

const s = (x) => (typeof x === "string" ? x.trim() : "");

/** Compile the IMAGE prompt for one shot.
 *  @param shot        raw draft shot ({title, description, …})
 *  @param characters  resolveCharacter() outputs for the scene's characterRefs
 *  @param location    resolveLocation() output for the scene's locationRef (or null)
 *  @param tone        the outline's 题材/基调 (genreTone), "" when none
 *  @returns { text, missing } — text is ready to paste into ChatGPT/Gemini;
 *  missing lists the facets that would make it better, with WHERE to fix. */
export function compileImagePrompt({ shot, characters = [], location = null, tone = "" }) {
  const missing = [];
  const parts = [];
  if (s(tone)) parts.push(`【风格】${s(tone)}，电影感单帧画面`);
  if (location) {
    const head = `${s(location.name)}${location.stateName ? `（${s(location.stateName)}）` : ""}`;
    parts.push(`【场景】${head}${s(location.description) ? `：${s(location.description)}` : ""}`);
    if (s(location.visualInstruction)) parts.push(`【场景画面指令】${s(location.visualInstruction)}`);
  } else {
    missing.push("场景地未设定（在「剧集」的场景上选择/新建场景地）");
  }
  for (const c of characters) {
    const facets = [s(c.appearance), s(c.costume)].filter(Boolean).join("；");
    parts.push(`【角色】${s(c.name)}${c.stateName ? `（${s(c.stateName)}）` : ""}${facets ? `：${facets}` : ""}`);
    if (s(c.visualInstruction)) parts.push(`【角色画面指令】${s(c.visualInstruction)}`);
  }
  if (!characters.length) missing.push("出场角色未设定（在「剧集」的场景上添加出场角色）");
  if (s(shot.description)) parts.push(`【画面】${s(shot.description)}`);
  else missing.push("画面内容为空（在镜头详情填写）");
  parts.push("【要求】16:9 横幅构图，高细节，无文字水印，人物与场景保持一致性");
  return { text: parts.join("\n"), missing };
}

/** Compile the DIALOGUE (voice) prompt for one shot's line (M11-A).
 *  VOICE RULE embodied: the voice IDENTITY always comes from the character's
 *  BASE voice; a Character State contributes PERFORMANCE adjustments only
 *  (age feel, maturity, pace, emotional base, pitch lean, intensity).
 *  @param dialogue   the shot's line text
 *  @param character  resolveCharacter() output (voice merged base⊕state)
 *  @param baseVoice  the character's BASE voice ({voiceId, description}) —
 *                    passed separately so the identity line is explicit
 *  @param emotion    shot-level performance note (镜头情绪/表演), optional */
export function compileDialoguePrompt({ dialogue, character = null, baseVoice = null, emotion = "" }) {
  const missing = [];
  const parts = [];
  if (s(dialogue)) parts.push(`【台词】${s(dialogue)}`);
  else missing.push("台词为空（在镜头详情填写）");
  if (character) {
    parts.push(`【角色】${s(character.name)}${character.stateName ? `（${s(character.stateName)}）` : ""}`);
    const id = baseVoice || character.voice || {};
    if (s(id.voiceId) || s(id.description)) {
      parts.push(`【声音身份（固定）】${[s(id.voiceId), s(id.description)].filter(Boolean).join(" · ")}`);
    } else {
      missing.push("角色基础声音未设定（在「作品设定」填写声音档案）");
    }
    // state PERFORMANCE only — never a different voice identity. Both the
    // free-text description AND the structured performance object (pace/
    // intensity/…) are surfaced: a state can change pace without changing the
    // description, and those instructions must not silently vanish (M11 review)
    const cv = character.voice || {};
    const perfDesc = s(cv.description);
    const perfBits = [];
    if (perfDesc && baseVoice && perfDesc !== s(baseVoice.description)) perfBits.push(perfDesc);
    const perfObj = cv.performance;
    const basePerfObj = baseVoice && baseVoice.performance;
    if (perfObj && typeof perfObj === "object") {
      for (const k of Object.keys(perfObj)) {
        const v = perfObj[k];
        if (v == null || v === "") continue;
        // only STATE-differing performance facets (a state contribution)
        if (basePerfObj && typeof basePerfObj === "object" && basePerfObj[k] === v) continue;
        perfBits.push(`${k}：${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
    }
    if (perfBits.length) parts.push(`【状态表现（仅调表现，不换声音）】${perfBits.join("；")}`);
  } else {
    missing.push("出场角色未设定（在「剧集」的场景上添加，并在此选择说话人）");
  }
  if (s(emotion)) parts.push(`【本镜头情绪/表演】${s(emotion)}`);
  parts.push("【要求】单人独白干声，无背景音乐/混响，语言与台词一致");
  return { text: parts.join("\n"), missing };
}

/** Compile the VIDEO prompt for one shot. The CURRENT image is the first
 *  frame — the entry (Gemini 视频等) receives that image alongside this text.
 *  @param shot      raw draft shot ({description, action, cameraMotion,
 *                   duration_seconds, dialogue})
 *  @param hasImage  whether the shot has a current image to attach */
export function compileVideoPrompt({ shot, hasImage = false }) {
  const missing = [];
  const parts = [];
  if (hasImage) parts.push("【首帧】以所附图片为第 1 帧，人物、服装与场景保持完全一致");
  else missing.push("本镜头还没有图片（先在上方生成/导入画面 — 视频以它为首帧）");
  if (s(shot.description)) parts.push(`【画面】${s(shot.description)}`);
  if (s(shot.action)) parts.push(`【动作】${s(shot.action)}`);
  else missing.push("动作为空（在镜头详情填写）");
  if (s(shot.cameraMotion)) parts.push(`【运镜】${s(shot.cameraMotion)}`);
  else missing.push("运镜为空（在镜头详情填写）");
  parts.push(`【时长】${shot.duration_seconds === 10 ? 10 : 6} 秒`);
  if (s(shot.dialogue)) parts.push(`【台词（口型/情绪参考）】${s(shot.dialogue)}`);
  return { text: parts.join("\n"), missing };
}
