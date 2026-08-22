// 音频工作区 (M11-A) — Dialogue / Ambience / Foley·SFX / BGM for the selected
// Shot/Scene, following the M10 entry philosophy (manual_subscription /
// local_subscription / import / api-future).
//
// STRICT view over existing domains: dialogue takes live as variants of the
// shot's `voice-<slot>` audio chain (M3 registry, mediaref single write
// path); ambience/BGM are scene/episode REFERENCES (proddoc, M11) into
// reusable pool chains (`amb-…` / `bgm-…` keys) — one asset may serve many
// scenes; SFX is the shot's `sfx-<slot>` chain. Voice identity always comes
// from the character's BASE voice; a Character State adjusts performance
// only (M7 voice rule — surfaced verbatim in the dialogue prompt).
import { esc } from "../util/dom.js";
import { slotEntry, currentRef } from "../workflow/mediaref.js";
import { buildShotSlotIndex, slotForShotId } from "../workflow/shotmap.js";
import { sceneOfShot, activeEpisode, findEpisode, effectiveBgm } from "../workflow/proddoc.js";
import { findCharacter, findLocation, resolveCharacter, resolveLocation } from "../workflow/bibledoc.js";
import { compileDialoguePrompt } from "../workflow/promptc.js";
import { storyboardModel } from "./storyboard.js";

const nn = (seq) => String(seq).padStart(2, "0");
const ORIGIN_ZH = { upload: "导入", tts: "本地 TTS", "paid-image": "付费", adopted: "付费入槽" };

/** Foley/SFX slot suggestions from the shot's action/description — plain
 *  keyword hints, honestly labeled (no recognition system). */
export function sfxSuggestions(shot) {
  const text = `${shot.action || ""} ${shot.description || ""}`;
  const RULES = [
    [/走|跑|步|脚/, "footsteps 脚步"],
    [/门|闯|推开/, "door 开关门"],
    [/玻璃|碎|摔/, "glass/impact 碎裂撞击"],
    [/衣|袖|跪|起身/, "clothing 衣料摩擦"],
    [/剑|刀|兵|武/, "weapon 兵器"],
    [/雨|雷|风/, "weather 风雨"],
  ];
  const out = RULES.filter(([re]) => re.test(text)).map(([, label]) => label);
  return out.length ? out : ["footsteps 脚步", "clothing 衣料摩擦", "object impact 物件碰撞"];
}

/** Everything the audio panels need for ONE selected shot. Pure. */
export function audioShotModel(pd, shotId, speakerId = null) {
  const draft = pd.draftShots || [];
  const s = draft.find((x) => x && x.shotId === shotId);
  if (!s) return null;
  const idx = buildShotSlotIndex(draft);
  const slot = slotForShotId(idx, shotId) || null;
  const prod = pd.production;
  const owner = prod ? sceneOfShot(prod, shotId) : null;
  // speakers = the scene's characters (STATE-resolved); the speaker is a
  // transient pick among them — dialogue identity stays scene-driven
  const speakers = [];
  if (owner) {
    for (const r of owner.scene.characterRefs || []) {
      const c = findCharacter(prod, r.characterId);
      if (c) {
        speakers.push({
          characterId: c.characterId,
          resolved: resolveCharacter(c, r.stateId),
          baseVoice: c.voice,
        });
      }
    }
  }
  const speaker = speakers.find((x) => x.characterId === speakerId) || speakers[0] || null;
  const variants = (key) => {
    const e = key ? slotEntry(pd.media.audio, key) : null;
    if (!e) return { list: [], current: 0 };
    return {
      current: e.current,
      list: e.history.map((r) => ({
        version: r.version, url: r.url, current: r.version === e.current,
        origin: ORIGIN_ZH[r.origin] || r.origin || "", assetId: r.assetId || null,
        storageState: r.storageState || "local",
      })),
    };
  };
  const ep = prod ? activeEpisode(prod) : null;
  const location = owner && owner.scene.locationRef
    ? (() => {
        const l = findLocation(prod, owner.scene.locationRef.locationId);
        return l ? resolveLocation(l, owner.scene.locationRef.stateId) : null;
      })()
    : null;
  // hasVideo means "a video whose BYTES are present" — the TTS fit-to-video
  // path needs a real local file. A video whose local copy was removed
  // (storageState !== "local") must NOT trigger fitSlug, or TTS would fail
  // instead of falling back to unfitted synthesis (M11 review debt).
  const curVideo = slot ? currentRef(pd.media.video, slot) : null;
  const hasVideo = !!(curVideo && (curVideo.storageState || "local") === "local");
  return {
    shot: { shotId, seq: s.sequence, title: s.title || "", dialogue: s.dialogue || "", action: s.action || "", description: s.description || "" },
    slot,
    scene: owner ? { sceneId: owner.scene.sceneId, title: owner.scene.title, ambienceAssetId: owner.scene.ambienceAssetId ?? null, bgmAssetId: owner.scene.bgmAssetId ?? null } : null,
    episode: ep ? { episodeId: ep.episodeId, title: ep.title, bgmAssetId: ep.bgmAssetId ?? null } : null,
    effectiveBgm: prod && ep ? effectiveBgm(prod, ep.episodeId, owner ? owner.scene.sceneId : null) : null,
    location,
    speakers,
    speaker,
    dialogueVariants: variants(slot ? `voice-${slot}` : null),
    sfxVariants: variants(slot ? `sfx-${slot}` : null),
    sfxHints: sfxSuggestions(s),
    hasVideo,
  };
}

// ---------- render --------------------------------------------------------- //

function variantRows(kind, key, v) {
  if (!v.list.length) return `<div class="ws-desc">（还没有${kind}音频）</div>`;
  return v.list
    .map((r) => {
      const use = r.current
        ? `<span class="ws-tag ok">✓当前</span>`
        : `<button class="ws-chipx" data-au-setcur="${esc(key)}" data-v="${r.version}">设为当前</button>`;
      const state = r.storageState !== "local" ? `<span class="ws-tag gate">${esc(r.storageState)} · 媒体不可用</span>` : "";
      return `<div class="ws-row"><div class="ws-main"><b>v${r.version}</b> · ${esc(r.origin)} ${use} ${state}` +
        (r.storageState === "local" ? `<audio class="aaud" src="${esc(r.url)}" controls preload="metadata"></audio>` : "") +
        `</div></div>`;
    })
    .join("");
}

function poolSelect(pool, currentAssetId, attr, extraOption) {
  const opts = pool
    .map((a) => `<option value="${esc(a.assetId)}"${a.assetId === currentAssetId ? " selected" : ""}>${esc(a.label)}${a.storageState !== "local" ? "（媒体不可用）" : ""}</option>`)
    .join("");
  return `<select class="ws-assign" ${attr}><option value="">（无）</option>${opts}${extraOption || ""}</select>`;
}

/** The whole audio workspace for the current selection. */
export function renderAudioWs(ctx, ui) {
  const pd = ctx.prodData();
  const board = storyboardModel(pd);
  if (!board.hasDraft) {
    return (
      `<div class="pm-head"><div class="pm-title">🎵 音频工作区</div><div class="pm-note">还没有分镜</div></div>` +
      `<div class="ws-empty"><div class="ic">🎵</div><div class="tt">音频按镜头/场景组织 — 先生成分镜</div>` +
      `<button class="nrun ghost" data-goto="shots">→ 去分镜工作区</button></div>`
    );
  }
  // left rail: scene groups with shot chips (selection shared with 分镜)
  const rail = board.scenes.concat(board.unassigned.length ? [{ sceneId: null, title: "未归组", refs: { characters: [], location: null }, shots: board.unassigned }] : [])
    .map(
      (sc) =>
        `<div class="au-scene"><div class="ws-lab">🎬 ${esc(sc.title)}</div>` +
        sc.shots.filter((c) => c.shotId && !c.dangling)
          .map((c) => `<button class="au-shot${c.shotId === ui.selectedShotId ? " on" : ""}" data-shot="${esc(c.shotId)}">${esc(nn(c.seq))} ${esc(c.title)}</button>`)
          .join("") +
        `</div>`,
    )
    .join("");
  const m = ui.selectedShotId ? audioShotModel(pd, ui.selectedShotId, ui.speakerId) : null;
  let main = `<div class="sb-detail sb-detail-empty ws-desc">在左侧选择镜头，编辑其 对白/环境音/SFX/BGM</div>`;
  if (m) {
    // --- Dialogue ---------------------------------------------------------- //
    const speakerSel = m.speakers.length
      ? `<select class="ws-assign" data-au-speaker>${m.speakers
          .map((x) => `<option value="${esc(x.characterId)}"${m.speaker && x.characterId === m.speaker.characterId ? " selected" : ""}>${esc(x.resolved.name)}${x.resolved.stateName ? ` · ${esc(x.resolved.stateName)}` : ""}</option>`)
          .join("")}</select>`
      : `<span class="ws-desc">（场景无出场角色 — 在「剧集」的场景上添加）</span>`;
    const voiceLine = m.speaker
      ? `<div class="ws-kv">声音身份（固定）：${esc(m.speaker.baseVoice.voiceId || "未设 voiceId")} · ${esc(m.speaker.baseVoice.description || "未设描述")}` +
        (m.speaker.resolved.stateName && m.speaker.resolved.voice.description !== m.speaker.baseVoice.description
          ? ` ｜ 状态表现（${esc(m.speaker.resolved.stateName)}）：${esc(m.speaker.resolved.voice.description)}`
          : "") + `</div>`
      : "";
    const dlgPrompt = compileDialoguePrompt({
      dialogue: m.shot.dialogue,
      character: m.speaker ? m.speaker.resolved : null,
      baseVoice: m.speaker ? m.speaker.baseVoice : null,
      emotion: ui.audioEmotion || "",
    });
    const gaps = dlgPrompt.missing.map((x) => `<div class="ws-kv gate">◌ ${esc(x)}</div>`).join("");
    const dialogue =
      `<div class="pm-head"><div class="pm-title">💬 对白 · ${esc(nn(m.shot.seq))} ${esc(m.shot.title)}</div><div class="pm-note">说话人 ${speakerSel}</div></div>` +
      `<div class="ws-kv">台词：${m.shot.dialogue ? esc(m.shot.dialogue) : "<i>（未填写 — 在分镜镜头详情编辑）</i>"}</div>` +
      voiceLine +
      `<label class="ws-lab">本镜头情绪/表演指示（进入生成上下文）</label>` +
      `<input class="ws-bibleinput" data-au-emotion placeholder="例如：压抑的颤抖，尾音上扬" value="${esc(ui.audioEmotion || "")}">` +
      variantRows("对白", `voice-${m.slot}`, m.dialogueVariants) +
      `<div class="gen-panel"><div class="ws-lab">🪄 生成对白 · Dialogue Prompt（台词+声音身份+状态表现+情绪）</div>` +
      gaps +
      `<textarea class="gen-prompt" readonly spellcheck="false" data-genprompt="dialogue">${esc(dlgPrompt.text)}</textarea>` +
      `<div class="bd-actions">` +
      `<button class="nrun ghost" data-au-tts>🤖 本地 TTS 生成（local_subscription · 免费）</button>` +
      `<button class="nrun ghost" data-gp-copy data-kind="dialogue">📋 复制（manual_subscription）</button>` +
      `<button class="nrun ghost" data-au-import="voice" data-shotbound="1">⬆ 导入结果</button></div>` +
      `<div class="ws-desc">本地 TTS 按角色基础 voiceId 选用本机 Piper 模型（data/tts/&lt;voiceId&gt;.onnx 存在时生效，否则回退默认模型并如实标注）；声音身份/状态表现随溯源记录，付费 Voice API 仍属未来</div>` +
      `<div class="pa-unavail">◌ Voice API 自动生成（未来/可选）— 架构已留 providerMode=api 槽位，未接任何付费 Voice API</div></div>`;
    // --- Ambience (scene-level, reusable) ----------------------------------- //
    const ambPool = ctx.audio.pool("amb");
    const ambRec = m.location
      ? `<div class="ws-desc">推荐上下文：${esc(m.location.name)}${m.location.stateName ? `（${esc(m.location.stateName)}）` : ""}${m.location.description ? ` — ${esc(m.location.description)}` : ""}（场景可覆盖）</div>`
      : `<div class="ws-desc">（场景未设场景地 — 无推荐上下文）</div>`;
    const ambience = m.scene
      ? `<div class="pm-head"><div class="pm-title">🌫 环境音 · ${esc(m.scene.title)}</div><div class="pm-note">场景级 · 跨镜头复用</div></div>` +
        ambRec +
        `<div class="bd-actions">${poolSelect(ambPool, m.scene.ambienceAssetId, `data-au-amb="${esc(m.scene.sceneId)}"`)}` +
        `<button class="nrun ghost" data-au-import="amb">⬆ 导入新环境音（入池）</button></div>` +
        (m.scene.ambienceAssetId && !ambPool.some((a) => a.assetId === m.scene.ambienceAssetId)
          ? `<div class="ws-kv gate">⚠ 引用的环境音资产已不在注册表（引用保留，媒体不可用）</div>`
          : "")
      : `<div class="ws-kv">镜头未归入场景 — 环境音是场景级设置（在「剧集」归组）</div>`;
    // --- SFX (shot-level) ---------------------------------------------------- //
    const sfx =
      `<div class="pm-head"><div class="pm-title">👟 Foley / SFX · ${esc(nn(m.shot.seq))}</div><div class="pm-note">镜头级</div></div>` +
      `<div class="ws-desc">建议槽位（按动作关键词提示，非自动识别）：${m.sfxHints.map((h) => `<span class="ws-tag">${esc(h)}</span>`).join(" ")}</div>` +
      variantRows("SFX", `sfx-${m.slot}`, m.sfxVariants) +
      `<div class="bd-actions"><button class="nrun ghost" data-au-import="sfx" data-shotbound="1">⬆ 导入 SFX</button></div>`;
    // --- BGM (episode + scene override) --------------------------------------- //
    const bgmPool = ctx.audio.pool("bgm");
    const bgm = m.episode
      ? `<div class="pm-head"><div class="pm-title">🎼 BGM</div><div class="pm-note">剧集级 + 场景覆盖 · 复用音乐资产，绝不逐镜头复制</div></div>` +
        `<div class="ws-kv">本集（${esc(m.episode.title)}）：${poolSelect(bgmPool, m.episode.bgmAssetId, `data-au-bgm-ep="${esc(m.episode.episodeId)}"`)}</div>` +
        (m.scene
          ? `<div class="ws-kv">本场景覆盖（${esc(m.scene.title)}）：${poolSelect(bgmPool, m.scene.bgmAssetId, `data-au-bgm-scene="${esc(m.scene.sceneId)}"`)}</div>`
          : "") +
        `<div class="ws-desc">当前生效：${m.effectiveBgm ? `${esc(m.effectiveBgm.assetId)}（${m.effectiveBgm.from === "scene" ? "场景覆盖" : "剧集级"}）` : "（无）"}</div>` +
        `<div class="bd-actions"><button class="nrun ghost" data-au-import="bgm">⬆ 导入新音乐（入池）</button></div>` +
        `<div class="pa-unavail">◌ Music API 自动生成（未来/可选）— providerMode=api 槽位已留</div>`
      : "";
    main = dialogue + ambience + sfx + bgm;
  }
  return (
    `<div class="pm-head"><div class="pm-title">🎵 音频工作区${m && m.episode ? ` · ${esc(m.episode.title)}` : ""}</div><div class="pm-note">对白按镜头 · 环境音按场景复用 · BGM 按剧集/场景</div></div>` +
    `<div class="au-layout"><aside class="au-rail">${rail}</aside><section class="au-main">${main}</section></div>`
  );
}

/** Wire the audio workspace — every mutation through ctx.audio / ctx.media. */
export function bindAudioWs(root, ctx, ui, rerender) {
  root.querySelectorAll("[data-shot]").forEach((el) => {
    el.onclick = () => { ui.selectedShotId = el.dataset.shot; ui.speakerId = null; rerender(); };
  });
  const speaker = root.querySelector("[data-au-speaker]");
  if (speaker) speaker.onchange = () => { ui.speakerId = speaker.value; rerender(); };
  const emotion = root.querySelector("[data-au-emotion]");
  if (emotion) emotion.onchange = () => { ui.audioEmotion = emotion.value; rerender(); };
  root.querySelectorAll("[data-au-setcur]").forEach((b) => {
    b.onclick = () => ctx.media.setCurrent("audio", b.dataset.auSetcur, +b.dataset.v);
  });
  // dialogue prompt copy — records the manual_subscription intent
  root.querySelectorAll("[data-gp-copy]").forEach((b) => {
    b.onclick = async () => {
      const ta = root.querySelector(`textarea[data-genprompt="${b.dataset.kind}"]`);
      try {
        await navigator.clipboard.writeText(ta ? ta.value : "");
        ctx.toast("提示词已复制");
        ui.audioIntent = { shotId: ui.selectedShotId, prompt: ta ? ta.value : "", entry: "manual", providerMode: "manual_subscription" };
      } catch { ctx.toast("复制失败：请手动选择文本复制"); }
    };
  });
  const tts = root.querySelector("[data-au-tts]");
  if (tts)
    tts.onclick = async () => {
      const m = audioShotModel(ctx.prodData(), ui.selectedShotId, ui.speakerId);
      if (!m || !m.slot) { ctx.toast("镜头身份未解析"); return; }
      ctx.toast("本地 TTS 合成中…");
      try {
        // the speaker's FIXED voice identity + state performance + emotion
        // travel with the generation (provenance) — local piper is a single
        // model and cannot switch voices, said honestly in the panel above
        await ctx.audio.ttsDialogue(m.slot, ui.selectedShotId, m.shot.dialogue, m.hasVideo ? `video-${m.slot}` : null, {
          characterId: m.speaker ? m.speaker.characterId : null,
          voiceId: m.speaker ? m.speaker.baseVoice.voiceId : null,
          stateId: m.speaker ? m.speaker.resolved.stateId : null,
          statePerformance: m.speaker && m.speaker.resolved.stateName ? m.speaker.resolved.voice.description : null,
          emotion: ui.audioEmotion || null,
        });
        rerender();
      } catch (e) { ctx.toast("TTS 失败：" + e.message); }
    };
  root.querySelectorAll("[data-au-import]").forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.auImport; // voice | sfx | amb | bgm
      const m = audioShotModel(ctx.prodData(), ui.selectedShotId, ui.speakerId);
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "audio/wav,audio/mpeg,audio/mp3";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const intent = kind === "voice" && ui.audioIntent && ui.audioIntent.shotId === ui.selectedShotId
          ? ui.audioIntent
          : { prompt: "", entry: "import", providerMode: "import" };
        try {
          if (kind === "voice" || kind === "sfx") {
            if (!m || !m.slot) { ctx.toast("镜头身份未解析"); return; }
            await ctx.audio.importKey(`${kind === "voice" ? "voice" : "sfx"}-${m.slot}`, ui.selectedShotId, file, intent.prompt ? intent : null);
          } else {
            const ref = await ctx.audio.importPool(kind, file, null);
            // convenience: a freshly imported pool asset becomes THIS scene/
            // episode's reference immediately (explicit action, not silent)
            if (kind === "amb" && m && m.scene) ctx.audio.setSceneAmbience(m.scene.sceneId, ref.assetId);
            if (kind === "bgm" && m && m.episode) ctx.audio.setEpisodeBgm(m.episode.episodeId, ref.assetId);
          }
          if (kind === "voice" && ui.audioIntent && ui.audioIntent.shotId === ui.selectedShotId) ui.audioIntent = null;
          rerender();
        } catch (e) { ctx.toast("导入失败：" + e.message); }
      };
      input.click();
    };
  });
  root.querySelectorAll("[data-au-amb]").forEach((sel) => {
    sel.onchange = () => ctx.audio.setSceneAmbience(sel.dataset.auAmb, sel.value || null);
  });
  root.querySelectorAll("[data-au-bgm-ep]").forEach((sel) => {
    sel.onchange = () => ctx.audio.setEpisodeBgm(sel.dataset.auBgmEp, sel.value || null);
  });
  root.querySelectorAll("[data-au-bgm-scene]").forEach((sel) => {
    sel.onchange = () => ctx.audio.setSceneBgm(sel.dataset.auBgmScene, sel.value || null);
  });
}