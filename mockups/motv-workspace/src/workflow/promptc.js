// Prompt 编译器 (checkpoint M10, extended in TASK-064 Phase 2 §21–§23) — the pure
// compilation step between a Shot's creative context and a generation entry:
//
//   IMAGE   Shot spec + Character Ref/State + Location Ref/State + Prop + Style
//   VIDEO   Active Source Image + Start/End Frame
//           + Video Style / Motion / Camera / Performance (AI-interpreted)
//           + Action + Camera Motion + Environment Motion + Expression
//           + Duration + Dialogue
//
// TWO KINDS OF REFERENCE REACH A PROMPT DIFFERENTLY (ADR-0061 决策 4):
//
//   model-input        the media model ingests the file; the prompt NAMES it so
//                      the external tool knows which attachment is which
//   ai-interpretation  the model cannot ingest it, so a Skill's READING of it
//                      (workflow/refinterp.js) is compiled in as words
//
// The second is why 「模型不吃视频参考」 does not mean 「丢掉视频参考」. A bound
// motion reference nobody has read yet is reported in `missing` with the fix —
// it is never quietly dropped, and it is never guessed at from a filename.
//
// INPUTS are already-resolved domain views (bibledoc.resolveCharacter /
// resolveLocation, the shot's raw draft fields, the outline's genre/tone, the
// shot's bound references, the active interpretation of each). This module
// composes text and reports honest GAPS (`missing`); it never invents content
// for an absent facet and never mutates any domain state.
//
// Pure functions only: no fetch, no DOM, no clock.

import { AXES, mergeAxes } from "./refinterp.js";

const s = (x) => (typeof x === "string" ? x.trim() : "");
const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);

/** A reference's display name with its version — 「林晚 Ref v3」. Kept here so a
 *  prompt names exactly the version that will be attached; a name without a
 *  version cannot be matched back to the file the creator sent. */
function refName(r) {
  const n = s(r && r.name);
  if (!n) return "";
  return r.version != null && !n.endsWith(`v${r.version}`) ? `${n} v${r.version}` : n;
}

/** Group a shot's bound references by kind, in one pass. */
function byKind(references) {
  const m = new Map();
  for (const r of arr(references)) {
    if (!isObj(r) || !s(r.kind)) continue;
    if (!m.has(r.kind)) m.set(r.kind, []);
    m.get(r.kind).push(r);
  }
  return m;
}

/** The 【参考图】 line for one model-input kind, or "" when the shot has none.
 *  It says WHAT the attachment is for, because an external tool receives a pile
 *  of images with no roles and the prompt is the only place the roles exist.
 *
 *  ROUTE-DEPENDENT, and only in its PARENTHETICAL (TASK-077 §1.3):
 *
 *    manual   「作为参考图一并提供，保持一致」 — an INSTRUCTION to the creator, who is
 *             about to attach these files by hand. Correct, and kept verbatim.
 *    gateway  the request carries one image (the first frame) and nothing else
 *             (`cloud_minimax._payload`), so the same sentence would promise an
 *             attachment that is never sent. The reference is still NAMED — the
 *             model can be told to keep 林晚 consistent with 林晚 Ref v3 even when
 *             it cannot see the file — but nothing is promised about sending it.
 *
 *  The names, versions and ordering are identical on both routes, so a project
 *  compiled before this change produces byte-identical text on the manual route. */
function modelRefLine(m, kind, label, route = "manual") {
  const rs = m.get(kind) || [];
  if (!rs.length) return "";
  const names = rs.map(refName).filter(Boolean).join("、");
  const how = route === "gateway"
    ? "（图片不随本次提交发送，仅以此描述指定，保持一致）"
    : "（作为参考图一并提供，保持一致）";
  return `【${label}】${names}${how}`;
}

/**
 * The AI-INTERPRETATION block: what the directing references SAY, per axis.
 *
 * Built from readings that a human or a named Skill Run produced — see
 * refinterp.js. Every line is attributed to the reference it came from, so two
 * references contributing different 运镜 are both visible instead of one winning
 * by precedence; a contradiction is the creator's to resolve, not ours to hide.
 *
 * Returns "" when nothing has been read. An empty heading would tell the
 * external tool there is a directing intent and then not state it.
 */
export function compileInterpretationBlock(inputs) {
  // Attribute by name AND VERSION. A reading is of one specific take of a
  // reference, so 「参考：机位 Ref」 would point at whichever version is current
  // when the prompt is next read — the same reason every model-input reference
  // is named with its version above.
  const merged = mergeAxes(
    arr(inputs).filter((i) => isObj(i) && i.read).map((i) => ({ ...i, name: refName(i) })),
  );
  const lines = [];
  for (const [key, label] of AXES) {
    const bits = merged[key];
    if (!bits || !bits.length) continue;
    lines.push(`- ${label}：${bits.map((b) => (b.from ? `${b.text}（参考：${b.from}）` : b.text)).join("；")}`);
  }
  if (!lines.length) return "";
  return ["【创作参考解读（视频风格 / 运动 / 机位 / 表演）】", ...lines].join("\n");
}

/** Bound interpretation references nobody has read yet, as `missing` entries.
 *  The gap names the reference AND where to close it — a gap the creator cannot
 *  act on is just a complaint. */
function unreadGaps(inputs) {
  return arr(inputs)
    .filter((i) => isObj(i) && !i.read)
    .map((i) => `${refName(i) || "一个创作参考"} 还没有被解读（在左栏该参考的「解读」里写，或运行「参考解读」能力）`);
}

/** Compile the IMAGE prompt for one shot.
 *  @param shot        raw draft shot ({title, description, …})
 *  @param characters  resolveCharacter() outputs for the scene's characterRefs
 *  @param location    resolveLocation() output for the scene's locationRef (or null)
 *  @param tone        the outline's 题材/基调 (genreTone), "" when none
 *  @param references  the shot's bound canonical References, resolved to
 *                     { key, kind, name, version } — model-input kinds are named
 *                     as attachments, interpretation kinds are read below
 *  @param interpretation  refinterp.interpretationInputs() for this shot's
 *                     interpretation references (a still image generation still
 *                     benefits from 构图 / 光线 / 机位)
 *  @returns { text, missing } — text is ready to paste into ChatGPT/Gemini;
 *  missing lists the facets that would make it better, with WHERE to fix. */
export function compileImagePrompt({ shot, characters = [], location = null, tone = "", references = [], interpretation = [] }) {
  const missing = [];
  const parts = [];
  const m = byKind(references);
  if (s(tone)) parts.push(`【风格】${s(tone)}，电影感单帧画面`);
  // A STYLE reference is a stronger statement than the outline's tone, so it is
  // stated right after it rather than buried with the other attachments.
  const styleLine = modelRefLine(m, "style-reference", "风格参考");
  if (styleLine) parts.push(styleLine);
  if (location) {
    const head = `${s(location.name)}${location.stateName ? `（${s(location.stateName)}）` : ""}`;
    parts.push(`【场景】${head}${s(location.description) ? `：${s(location.description)}` : ""}`);
    if (s(location.visualInstruction)) parts.push(`【场景画面指令】${s(location.visualInstruction)}`);
  } else {
    missing.push("场景地未设定（在「剧集」的场景上选择/新建场景地）");
  }
  const locLine = modelRefLine(m, "location-reference", "场景参考");
  if (locLine) parts.push(locLine);
  for (const c of characters) {
    const facets = [s(c.appearance), s(c.costume)].filter(Boolean).join("；");
    parts.push(`【角色】${s(c.name)}${c.stateName ? `（${s(c.stateName)}）` : ""}${facets ? `：${facets}` : ""}`);
    if (s(c.visualInstruction)) parts.push(`【角色画面指令】${s(c.visualInstruction)}`);
  }
  if (!characters.length) missing.push("出场角色未设定（在「剧集」的场景上添加出场角色）");
  const charLine = modelRefLine(m, "character-reference", "人物参考");
  if (charLine) parts.push(charLine);
  else if (characters.length) {
    missing.push("出场角色还没有绑定人物参考图（一致性会明显不稳 — 在左栏「参考」里绑定）");
  }
  const propLine = modelRefLine(m, "prop-reference", "道具参考");
  if (propLine) parts.push(propLine);
  // the SHOT SPEC — the framing decisions, stated as such rather than left to
  // be inferred from the description
  const spec = [
    ["景别", s(shot.shotSize)],
    ["机位角度", s(shot.angle)],
    // 光影氛围 (TASK-078 §2.1) — an additive draft-shot field. A shot that never
    // carried one compiles byte-identically to before, because the row is
    // filtered out when empty like every other facet here.
    ["光影氛围", s(shot.lighting)],
    ["情绪", s(shot.emotion)],
    ["表情", s(shot.expression)],
  ].filter(([, v]) => v);
  if (spec.length) parts.push(`【镜头规格】${spec.map(([k, v]) => `${k}：${v}`).join("；")}`);
  if (s(shot.description)) parts.push(`【画面】${s(shot.description)}`);
  else missing.push("画面内容为空（在镜头详情填写）");
  const interp = compileInterpretationBlock(interpretation);
  if (interp) parts.push(interp);
  missing.push(...unreadGaps(interpretation));
  parts.push("【要求】16:9 横幅构图，高细节，无文字水印，人物与场景保持一致性");
  return { text: parts.join("\n"), missing };
}

/**
 * Compile the BASE image prompt of ONE bible entity — 人物 or 场景地, optionally in
 * one of its States (TASK-065 §1 / §4).
 *
 * WHY IT LIVES HERE. This is the same compilation the shot's Image Prompt does,
 * minus the shot: 「这个人物长什么样」 is stated once, in the character's own words,
 * and the shot prompt then adds the framing. Compiling it in a second module
 * would let 林婉's appearance read differently in her own card than in the shot
 * that uses her, which is the inconsistency reference images exist to prevent.
 *
 * A STATE IS THE SAME PERSON. The entity is passed in ALREADY RESOLVED
 * (bibledoc.resolveCharacter / resolveLocation), so base ⊕ state overrides have
 * been merged by the one resolver — this function never reaches for `.profile`
 * and therefore cannot disagree with the resolver about what a state changes.
 *
 * `missing` names the facets that would make the prompt usable and WHERE to fill
 * them. An absent facet is never written as a plausible default: 「一位女性」 for a
 * character nobody described would be this module inventing canon.
 *
 * @param kind      "character" | "location"
 * @param entity    resolveCharacter() / resolveLocation() output
 * @param tone      the outline's 题材/基调, "" when none
 * @param worldTone the World Setting's 视觉基调, "" when none — a location's look
 *                  is a statement about the world before it is about the place
 * @returns { text, missing }
 */
export function compileEntityBasePrompt({ kind, entity, tone = "", worldTone = "" } = {}) {
  const missing = [];
  const parts = [];
  if (!isObj(entity)) return { text: "", missing: ["没有可编译的对象"] };
  const isChar = kind === "character";
  const named = s(entity.name) || (isChar ? "未命名角色" : "未命名场景地");
  const state = s(entity.stateName);
  const styleBits = [s(tone), s(worldTone)].filter(Boolean);
  if (styleBits.length) parts.push(`【风格】${styleBits.join("；")}`);
  if (isChar) {
    parts.push(`【角色设定图】${named}${state ? `（${state}）` : ""}`);
    const look = [s(entity.appearance), s(entity.costume)].filter(Boolean);
    if (look.length) parts.push(`【外貌与服装】${look.join("；")}`);
    else {
      missing.push(
        state
          ? `${named} / ${state} 没有外貌或服装（在这个状态的「覆盖」里写，或留空表示与基础设定一致）`
          : `${named} 没有外貌或服装（在人物卡片里填写）`,
      );
    }
    if (s(entity.personality)) parts.push(`【气质】${s(entity.personality)}`);
    if (s(entity.visualInstruction)) parts.push(`【画面指令】${s(entity.visualInstruction)}`);
    else missing.push(`${named} 没有画面指令（打光 / 机位 / 色调倾向）`);
    parts.push("【要求】单人全身与半身各一张，中性背景，正面与四分之三侧面，五官清晰，无文字水印");
  } else {
    parts.push(`【场景设定图】${named}${state ? `（${state}）` : ""}`);
    if (s(entity.description)) parts.push(`【场景描述】${s(entity.description)}`);
    else {
      missing.push(
        state
          ? `${named} / ${state} 没有描述（在这个状态的「覆盖」里写）`
          : `${named} 没有场景描述（在场景地卡片里填写）`,
      );
    }
    if (s(entity.visualInstruction)) parts.push(`【画面指令】${s(entity.visualInstruction)}`);
    else missing.push(`${named} 没有画面指令（打光 / 色调 / 镜头语言）`);
    parts.push("【要求】16:9 空场，无人物，构图与光线可复用，高细节，无文字水印");
  }
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
 *  @param emotion    shot-level performance note (镜头情绪/表演), optional
 *  @param interpretation  readings of the shot's PERFORMANCE references, if any
 *                    — a line read reference is a real directing input for a
 *                    voice take, and dropping it here would lose it */
export function compileDialoguePrompt({ dialogue, character = null, baseVoice = null, emotion = "", interpretation = [] }) {
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
  // only the PERFORMANCE axis is relevant to a voice take; 运镜/构图/光线 belong
  // to the picture, and pasting them here would ask a TTS engine for a dolly-in
  const perf = mergeAxes(arr(interpretation).filter((i) => isObj(i) && i.read));
  const bits = [...(perf.performance || []), ...(perf.pacing || [])];
  if (bits.length) {
    parts.push(`【表演参考解读】${bits.map((b) => (b.from ? `${b.text}（参考：${b.from}）` : b.text)).join("；")}`);
  }
  parts.push("【要求】单人独白干声，无背景音乐/混响，语言与台词一致");
  return { text: parts.join("\n"), missing };
}

/** Compile the VIDEO prompt for one shot.
 *  @param shot      raw draft shot ({description, action, cameraMotion,
 *                   environmentMotion, expression, duration_seconds, dialogue})
 *  @param hasImage  whether the shot has a current image to attach
 *  @param startFrame  the resolved START frame `{ name, from }`, or null. `from`
 *                   is framebind.describeBinding output — 「SH01 视频 v3 · 尾帧」 —
 *                   so the prompt states which picture the tool is being handed.
 *  @param endFrame  the resolved END frame, or null
 *  @param references  the shot's bound References (model-input kinds are named)
 *  @param interpretation  readings of its interpretation references */
export function compileVideoPrompt({
  shot, hasImage = false, startFrame = null, endFrame = null,
  references = [], interpretation = [], route = "manual",
} = {}) {
  const missing = [];
  const parts = [];
  const m = byKind(references);
  // The FIRST FRAME. `startFrame` is the explicit binding when there is one and
  // is preferred over 「本镜头有图」, because a bound frame is a decision and the
  // shot's own active image is only a default — saying 「以所附图片为第 1 帧」
  // without naming which picture is how the wrong one gets attached.
  if (startFrame) {
    parts.push(
      `【首帧】以所附图片为第 1 帧（${s(startFrame.name) || "已绑定的首帧"}` +
      `${s(startFrame.from) ? ` · 来源：${s(startFrame.from)}` : ""}），人物、服装与场景保持完全一致`,
    );
  } else if (hasImage) {
    parts.push("【首帧】以所附图片为第 1 帧（本镜头当前画面），人物、服装与场景保持完全一致");
  } else {
    missing.push("本镜头还没有首帧图片（先生成/导入画面，或从上一镜视频提取尾帧作为首帧）");
  }
  if (endFrame) {
    parts.push(
      `【尾帧】以所附第二张图片为最后一帧（${s(endFrame.name) || "已绑定的尾帧"}` +
      `${s(endFrame.from) ? ` · 来源：${s(endFrame.from)}` : ""}）`,
    );
  }
  const styleLine = modelRefLine(m, "style-reference", "风格参考", route);
  if (styleLine) parts.push(styleLine);
  if (s(shot.description)) parts.push(`【画面】${s(shot.description)}`);
  if (s(shot.action)) parts.push(`【动作】${s(shot.action)}`);
  else missing.push("动作为空（在镜头详情填写）");
  if (s(shot.cameraMotion)) parts.push(`【运镜】${s(shot.cameraMotion)}`);
  else missing.push("运镜为空（在镜头详情填写）");
  // ENVIRONMENT MOTION is its own input (§22): 雨丝、霓虹闪动、人群走动 are what
  // make a generated clip stop looking like a photograph being panned across,
  // and they are not the camera's motion nor the subject's action.
  if (s(shot.environmentMotion)) parts.push(`【环境运动】${s(shot.environmentMotion)}`);
  // 光影氛围 also directs a video take (the light has to hold across the clip),
  // so it is stated here too — and, like every optional facet, only when set.
  if (s(shot.lighting)) parts.push(`【光影氛围】${s(shot.lighting)}`);
  if (s(shot.expression)) parts.push(`【表情】${s(shot.expression)}`);
  if (s(shot.emotion)) parts.push(`【情绪】${s(shot.emotion)}`);
  parts.push(`【时长】${shot.duration_seconds === 10 ? 10 : 6} 秒`);
  if (s(shot.dialogue)) parts.push(`【台词（口型/情绪参考）】${s(shot.dialogue)}`);
  const interp = compileInterpretationBlock(interpretation);
  if (interp) parts.push(interp);
  missing.push(...unreadGaps(interpretation));
  return { text: parts.join("\n"), missing };
}
