// SHOT AUDIO controller (§35–§41) — 一个镜头的声音是怎么被摆出来、混出来的.
//
//   Dialogue · VO · Ambience · SFX · Foley · BGM
//     → clips with absolute or ANCHORED timing, trim, gain, fades
//     → internal mix (local ffmpeg)
//     → ONE derived Shot Mixed Audio Asset — sources untouched, always
//
// TASK-073 §1.8, same pattern as `lockctl.js`: documents arrive as GETTERS because
// the bindings are module-level `let`s reassigned on project load.
//
// THIS ONE HAS THE LONGEST DEPENDENCY LIST IN THE SET, and that is the point rather
// than a problem with it: `mixNow` reads the registry, calls the backend, declares an
// Asset, records a Generation and writes the mix pointer. In app.js those five were
// invisible — they were just names in scope. Listing them here is what makes it
// possible to see that this is the widest-reaching operation in the audio surface,
// and what makes it constructible in a test at all.

/**
 * @param {object} deps
 *   docs        `{ shotAudio, production, registry }` — GETTERS
 *   modules     `{ shotaudio, proddoc, mediaref, assetreg, assetlib }`
 *   findShot    `(shotId) => shot | null`
 *   slotOf      `(shot) => slot | null`
 *   contextOfShot `(shotId) => links`
 *   session     `{ connected: () => boolean, projectName: () => string }`
 *   mixShotAudio  `(project, key, clips) => Promise<{version, ...}>`
 *   generations `{ start, complete }`
 *   refreshType `(type) => void`
 *   prodOp / prodNew / persist / refresh / toast
 *   now         `() => string`
 */
export function createShotAudioController({
  docs, modules, findShot, slotOf, contextOfShot, session, mixShotAudio,
  generations, refreshType, prodOp, prodNew, persist, refresh, toast, now,
}) {
  const { shotaudio, proddoc, mediaref, assetreg, assetlib } = modules;

  /** A shot's nominal length in ms. The draft carries 6 or 10 seconds; anything
   *  else is treated as 6, which is what the original expression did. */
  const shotDurationMs = (shot) =>
    Math.round(((shot && shot.duration_seconds === 10) ? 10 : 6) * 1000);

  const api = {
    TRACKS: shotaudio.TRACKS,
    TRACK_LABEL: shotaudio.TRACK_LABEL,
    clips: (shotId) => shotaudio.clipsOf(docs.shotAudio(), shotId),
    mix: (shotId) => shotaudio.mixOf(docs.shotAudio(), shotId),

    /**
     * The ANCHORS a shot's clips may sync to, resolved to milliseconds.
     *
     * Derived from what the documents really hold, so an anchor either resolves
     * or is reported unresolved — never placed at zero:
     *
     *   shot:start / shot:end        the shot's own bounds
     *   dialogue:<shotId>            where this shot's line sits (its start)
     *   action:<name>                a named beat the creator declared on the
     *                                shot (`shot.audioAnchors`), in ms
     *
     * 「AI 以后可以提出 event，但不能直接偷偷改 canonical timeline」 (§35): a Skill
     * proposes an OFFSET against one of these; it cannot mint an anchor.
     */
    anchors: (shotId) => {
      const shot = findShot(shotId);
      const durMs = shotDurationMs(shot);
      const out = { "shot:start": 0, "shot:end": durMs };
      if (shot && typeof shot.dialogue === "string" && shot.dialogue.trim()) {
        out[`dialogue:${shotId}`] = 0;
      }
      // creator-declared beats live on the draft shot as `audioAnchors`
      const declared = shot && shot.audioAnchors;
      if (declared && typeof declared === "object" && !Array.isArray(declared)) {
        for (const name of Object.keys(declared)) {
          const v = declared[name];
          if (Number.isFinite(v)) out[`action:${name}`] = Math.max(0, Math.round(v));
        }
      }
      return out;
    },

    /** Source durations, where the registry knows them. Unknown stays unknown —
     *  `resolveClips` then reports `endMs: null` rather than a guessed length. */
    durations: () => ({}),

    resolved: (shotId) => shotaudio.resolveClips(shotaudio.clipsOf(docs.shotAudio(), shotId), {
      anchors: api.anchors(shotId),
      durations: api.durations(),
    }),
    byTrack: (shotId) => shotaudio.byTrack(api.resolved(shotId)),
    standing: (shotId) => shotaudio.mixStanding(docs.shotAudio(), shotId, api.resolved(shotId)),

    add: (shotId, clip) => prodNew(shotaudio.addClip(docs.shotAudio(), shotId, clip)),
    remove: (shotId, clipId) => prodOp(shotaudio.removeClip(docs.shotAudio(), shotId, clipId)),
    move: (shotId, clipId, timing, opts) =>
      prodOp(shotaudio.moveClip(docs.shotAudio(), shotId, clipId, timing, opts)),
    trim: (shotId, clipId, inMs, outMs, opts) =>
      prodOp(shotaudio.trimClip(docs.shotAudio(), shotId, clipId, inMs, outMs, opts)),
    setGain: (shotId, clipId, gain, opts) =>
      prodOp(shotaudio.setGain(docs.shotAudio(), shotId, clipId, gain, opts)),
    setFade: (shotId, clipId, fi, fo, opts) =>
      prodOp(shotaudio.setFade(docs.shotAudio(), shotId, clipId, fi, fo, opts)),
    setMuted: (shotId, clipId, on, opts) =>
      prodOp(shotaudio.setMuted(docs.shotAudio(), shotId, clipId, on, opts)),
    replaceAsset: (shotId, clipId, assetId, opts) =>
      prodOp(shotaudio.replaceClipAsset(docs.shotAudio(), shotId, clipId, assetId, opts)),

    /** The AUTOMATIC first arrangement (§41): the shot's dialogue take, its
     *  scene's ambience, the episode's BGM. It invents nothing and never touches
     *  a locked or hand-placed clip. */
    autoArrange: (shotId) => {
      const production = docs.production();
      const shot = findShot(shotId);
      const slot = shot ? slotOf(shot) : null;
      const owner = proddoc.sceneOfShot(production, shotId);
      const dialogue = slot ? mediaref.currentRef(docs.registry().audio, `voice-${slot}`) : null;
      // scene ambience and the effective BGM are stored as ASSET IDS on the
      // production document (proddoc), not as chain keys — they are references to
      // one reusable recording that many scenes share
      const bgm = owner
        ? proddoc.effectiveBgm(production, owner.episode.episodeId, owner.scene.sceneId)
        : null;
      const res = shotaudio.autoArrange(docs.shotAudio(), shotId, {
        dialogue: dialogue ? dialogue.assetId : null,
        ambience: owner && owner.scene.ambienceAssetId ? owner.scene.ambienceAssetId : null,
        bgm: bgm ? bgm.assetId : null,
        durationMs: shotDurationMs(shot),
      });
      if (res.added.length) { persist(); refresh(); }
      return res;
    },

    /**
     * MIX the shot's audio into ONE derived Asset (§38).
     *
     * The sources are read and left completely alone; the mix is a new
     * `shot-mix` Asset on its own chain, and its provenance snapshot records
     * every source assetId, version, timing, anchor, offset, gain and fade it was
     * made with — frozen, so it keeps describing what it IS after the clips move.
     */
    mixNow: async (shotId) => {
      if (!session.connected()) throw new Error("演示模式无后端，无法混音");
      // READ AT EACH USE, never hoisted across the `await` below. In app.js this was
      // the bare identifier `assetRegistry`, resolved every time — so the writes that
      // happen AFTER the backend returns land in whatever registry is current then.
      // Hoisting it to a const changed that: a project loaded mid-mix would take the
      // new version into the ABANDONED registry while the mix pointer persisted into
      // the new project, leaving a saved assetId that exists in no registry
      // (independent review). The getter is cheap; the hoist was not a saving.
      const shot = findShot(shotId);
      const slot = shot ? slotOf(shot) : null;
      if (!slot) throw new Error("镜头身份未解析：无法定位混音槽位");
      const resolved = api.resolved(shotId);
      const audible = resolved.filter((c) => !c.muted && !c.unresolved);
      if (!audible.length) throw new Error("这个镜头没有可混的音频片段（全部静音或对位未解析）");
      const clips = [];
      for (const c of audible) {
        const hit = assetlib.findAssetById(docs.registry(), c.assetId);
        if (!hit || !hit.record.url) throw new Error(`片段引用的素材不存在或字节已移除：${c.assetId}`);
        if (hit.record.storageState && hit.record.storageState !== "local") {
          throw new Error(`片段素材的字节不在本地：${assetreg.derivedLabel({ ...hit.record, key: hit.key })}`);
        }
        const base = String(hit.record.url).split("/").pop();
        clips.push({
          file: base,
          in: c.sourceInMs / 1000,
          // THREE cases, and they mean different things:
          //
          //   no out point        「到素材结束」 — the server resolves the real
          //                       duration with ffprobe. Substituting
          //                       `sourceInMs + 1000` here truncated every
          //                       un-trimmed clip to one second and still
          //                       reported success.
          //   AUTO clip's out     a CAP the arranger derived from the shot's
          //                       length, not a request for that much audio. A
          //                       4-second ambience bed under a 6-second shot is
          //                       not an error — sent as `maxOut`, which clamps.
          //   MANUAL clip's out   the creator's own trim. Sent as `out`, and the
          //                       server REFUSES it if the file is shorter:
          //                       they asked for audio that does not exist.
          ...(c.sourceOutMs != null
            ? (c.origin === "auto"
              ? { maxOut: c.sourceOutMs / 1000 }
              : { out: c.sourceOutMs / 1000 })
            : {}),
          start: (c.startMs || 0) / 1000,
          gainDb: c.gain,
          fadeInMs: c.fadeInMs,
          fadeOutMs: c.fadeOutMs,
        });
      }
      const key = `mix-${slot}`;
      const res = await mixShotAudio(session.projectName(), key, clips);
      const ref = mediaref.refFromResponse(key, "mix", res, shotId);
      const decl = assetreg.declare(ref, "audio", {
        kind: "shot-mix",
        displayName: `${(shot && shot.title) || "镜头"} 混音 v${res.version}`,
        originalFilename: null,
        links: contextOfShot(shotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: docs.registry().audio }, key, ref);
      // the mix is a DERIVED result of real inputs, so it is a Generation like any
      // other — that is what puts it on the provenance graph with its sources
      const prov = shotaudio.mixProvenance(resolved, {
        settings: { format: "mp3", sampleRate: 44100, bitrate: "192k" },
        versionOf: (assetId) => {
          const h = assetlib.findAssetById(docs.registry(), assetId);
          return h && Number.isInteger(h.record.version) ? h.record.version : null;
        },
      });
      const gen = generations.start({
        type: "audio",
        targetType: "shot",
        targetId: shotId,
        inputAssetIds: prov.sources.map((s) => s.assetId),
        referenceAssetIds: [],
        promptSnapshot: null,
        provider: "shot-mix",
        parameters: { mix: prov.settings, sources: prov.sources, unresolved: prov.unresolved },
        status: "generating",
      });
      if (gen) generations.complete(gen.generationId, [ref.assetId]);
      shotaudio.setMix(docs.shotAudio(), shotId, {
        assetId: ref.assetId,
        at: now(),
        provenance: prov,
      });
      refreshType("audio");
      persist();
      refresh();
      toast(`镜头混音 v${res.version} 已生成（${prov.sources.length} 条源素材全部保留）`);
      return ref;
    },
  };

  return api;
}
