// EPISODE TIMELINE controller — extracted from app.js (TASK-073 §1.8).
//
// Same pattern as controllers/lockctl.js:
//
//   docs      GETTERS, because they are module-level `let`s that project loading
//             REASSIGNS. Capturing their values would leave this controller writing to
//             the previous project's documents — silently, forever.
//   session   getters too, for the same reason (`PROJECT_NAME` / `CONNECTED` change).
//   getCtx    a getter, because the controller calls SIBLING controllers
//             (`ctx.shot`, `ctx.locks`, `ctx.persist`, the generation registry) and
//             `ctx` does not exist yet while it is being built.
//
// SELF-REFERENCES BECAME INTERNAL. The original called `ctx.timeline.gatherRows()`
// from inside `ctx.timeline.doc()`. Since `ctx.timeline` IS this object, those become
// `api.gatherRows()` — the same function, reached without a round trip through `ctx`.
// Behaviour is identical; the dependency is now visible.
//
// Everything else is verbatim, including every comment explaining WHY a line is the
// way it is. §1.8: 「拆分是纯搬运：一次提交只移动代码不改行为」.

export function createTimelineController({
  docs, session, modules, helpers, getCtx,
}) {
  const {
    timeline, roughcut, proddoc, mediaref, assetlib, shotaudio, subtitle, command,
  } = modules;
  const {
    timelineSourceSig, buildShotSlotIndex, slotForShotId, toast, refreshProductionView,
  } = helpers;

  /** The active episode's timeline, without the auto-sync in `doc()`. */
  const raw = () => timeline.timelineFor(docs.timelines(), docs.production().activeEpisodeId);

  const api = {
    // sync a timeline from rows AND stamp the source fingerprint used by
    // sourceStale — the ONE place both fields move together
    _sync: (t, rows) => {
      timeline.syncFromRows(t, rows);
      t.sourceSig = timelineSourceSig(t.clips);
    },
    doc: () => {
      const t = raw();
      // A timeline the Rough Cut built is no longer a mirror of the source, even
      // with no hand edit on it — so the legacy auto-sync must leave it alone.
      // Checked here rather than by marking it `edited`, because `edited` means
      // 「有人工调整」 and is printed in the Final Render's provenance.
      if (!t.edited && !t.roughCutVersion) {
        const rows = api.gatherRows();
        const hasVideo = rows.some((r) => r.videoAssetId);
        if ((t.clips.length && api.sourceStale(t)) || (!t.clips.length && hasVideo)) {
          api._sync(t, rows);
          getCtx().persist();
        }
      }
      return t;
    },
    // the DEFAULT rows the timeline mirrors: active episode's scenes in
    // order (then unassigned draft shots), each shot's CURRENT video/voice/
    // sfx assets + the scene's ambience + effective BGM
    gatherRows: () => {
      const ctx = getCtx();
      const production = docs.production();
      const assetRegistry = docs.assets();
      const draft = ctx.project.draftShots || [];
      const idx = buildShotSlotIndex(draft);
      const ep = proddoc.activeEpisode(production);
      const view = ep ? proddoc.episodeView(production, ep.episodeId, draft) : null;
      const ordered = [];
      if (view) {
        for (const sc of view.scenes) {
          for (const x of sc.shots) if (x.shot) ordered.push({ shot: x.shot, sceneId: sc.sceneId });
        }
        for (const s of view.unassigned) ordered.push({ shot: s, sceneId: null });
      }
      // the CURRENT asset regardless of byte availability: a clip must keep
      // REFERENCING an archived/removed asset (the timeline UI shows it as
      // unavailable and render refuses honestly) — filtering non-local here
      // would let the unedited auto-sync silently DROP those references
      const cur = (map, key) => {
        const r = key ? mediaref.currentRef(map, key) : null;
        return r && r.assetId ? r.assetId : null;
      };
      // …and its VERSION, so a clip can be PINNED (§48). Same lookup, second
      // field — reading the version separately would let the two disagree.
      const curRef = (map, key) => (key ? mediaref.currentRef(map, key) : null);
      // the version of an asset addressed by ID rather than by chain key (scene
      // ambience / episode BGM are stored as asset ids on the production doc)
      const verOfAsset = (assetId) => {
        const hit = assetId ? assetlib.findAssetById(assetRegistry, assetId) : null;
        return hit && Number.isInteger(hit.record.version) ? hit.record.version : null;
      };
      return ordered.map(({ shot, sceneId }) => {
        const slot = shot.shotId ? slotForShotId(idx, shot.shotId) : null;
        const scene = sceneId ? proddoc.findScene(production, sceneId) : null;
        const bgm = ep ? proddoc.effectiveBgm(production, ep.episodeId, sceneId) : null;
        const vref = curRef(assetRegistry.videos, slot);
        const dref = curRef(assetRegistry.audio, slot ? `voice-${slot}` : null);
        return {
          shotId: shot.shotId || null,
          duration: shot.duration_seconds === 10 ? 10 : 6,
          videoAssetId: vref && vref.assetId ? vref.assetId : null,
          videoAssetVersion: vref && Number.isInteger(vref.version) ? vref.version : null,
          dialogueAssetId: dref && dref.assetId ? dref.assetId : null,
          dialogueAssetVersion: dref && Number.isInteger(dref.version) ? dref.version : null,
          sfxAssetId: cur(assetRegistry.audio, slot ? `sfx-${slot}` : null),
          // 拟音 / 旁白 reach the cut as themselves (§37)
          foleyAssetId: cur(assetRegistry.audio, slot ? `foley-${slot}` : null),
          voAssetId: cur(assetRegistry.audio, slot ? `vo-${slot}` : null),
          sceneId,
          ambienceAssetId: scene ? scene.scene.ambienceAssetId : null,
          bgmAssetId: bgm ? bgm.assetId : null,
          // …and EVERY track's version, so every clip the Rough Cut places can be
          // pinned (§48). Supplying it only for video and dialogue left the other
          // five tracks with `assetVersion: null`, which `clipStanding` reports as
          // UNKNOWN — so drift on a sound effect or a BGM could never be seen.
          // Scene ambience and BGM are stored as ASSET IDS on the production
          // document, so their version is looked up from the registry record.
          sfxAssetVersion: verOfAsset(cur(assetRegistry.audio, slot ? `sfx-${slot}` : null)),
          foleyAssetVersion: verOfAsset(cur(assetRegistry.audio, slot ? `foley-${slot}` : null)),
          voAssetVersion: verOfAsset(cur(assetRegistry.audio, slot ? `vo-${slot}` : null)),
          ambienceAssetVersion: verOfAsset(scene ? scene.scene.ambienceAssetId : null),
          bgmAssetVersion: verOfAsset(bgm ? bgm.assetId : null),
        };
      });
    },
    /** The rows in the shape `roughcut.planRoughCut` takes — the SAME source data
     *  as `gatherRows`, re-shaped rather than re-derived, so the automatic cut and
     *  the legacy auto-sync can never disagree about what the episode contains. */
    roughRows: () => api.gatherRows().map((r) => {
      const shot = r.shotId ? getCtx().shot.find(r.shotId) : null;
      const v = (assetId, version) => (assetId ? { assetId, version: version ?? null } : null);
      return {
        shotId: r.shotId,
        duration: r.duration,
        dialogueText: shot && typeof shot.dialogue === "string" ? shot.dialogue : "",
        video: v(r.videoAssetId, r.videoAssetVersion),
        dialogue: v(r.dialogueAssetId, r.dialogueAssetVersion),
        vo: v(r.voAssetId, r.voAssetVersion),
        sfx: v(r.sfxAssetId, r.sfxAssetVersion),
        foley: v(r.foleyAssetId, r.foleyAssetVersion),
        ambience: v(r.ambienceAssetId, r.ambienceAssetVersion),
        bgm: v(r.bgmAssetId, r.bgmAssetVersion),
      };
    }),
    /** WHAT this shot currently has ACTIVE on a track — the other half of the
     *  drift check (§48). Returns `{ assetId, version }` or null. */
    activeFor: (shotId, trackType) => {
      const ctx = getCtx();
      const production = docs.production();
      const assetRegistry = docs.assets();
      // AMBIENCE and BGM are NOT per-shot chains: they are assets the SCENE and
      // the EPISODE point at by id (proddoc). Looking them up as
      // `ambience-<slot>` always missed, so drift on a scene's ambience or the
      // episode's score was permanently 「未记录」 and could never be reported.
      if (trackType === "ambience" || trackType === "bgm") {
        const owner = proddoc.sceneOfShot(production, shotId);
        if (!owner) return null;
        const assetId = trackType === "ambience"
          ? owner.scene.ambienceAssetId
          : (proddoc.effectiveBgm(production, owner.episode.episodeId, owner.scene.sceneId) || {}).assetId;
        if (!assetId) return null;
        const hit = assetlib.findAssetById(assetRegistry, assetId);
        return { assetId, version: hit && Number.isInteger(hit.record.version) ? hit.record.version : null };
      }
      const shot = ctx.shot.find(shotId);
      const slot = shot ? ctx.shot._slotOf(shot) : null;
      if (!slot) return null;
      const map = trackType === "video" ? assetRegistry.videos : assetRegistry.audio;
      const key = trackType === "video"
        ? slot
        : trackType === "dialogue" ? `voice-${slot}` : `${trackType}-${slot}`;
      const r = mediaref.currentRef(map, key);
      return r && r.assetId ? { assetId: r.assetId, version: Number.isInteger(r.version) ? r.version : null } : null;
    },
    /** Clips whose pinned version has drifted from the shot's active one. The
     *  console renders these with 保持 / 替换 / 对比 — nothing is auto-replaced. */
    drift: () => timeline.driftedClips(
      raw(),
      (shotId, trackType) => api.activeFor(shotId, trackType),
    ),
    /**
     * BUILD (or rebuild) the Episode Rough Cut (§41).
     *
     * `roughcut.applyRoughCut` preserves every locked and hand-placed clip, so
     * re-running it after tuning is safe — that is what makes 「AI Draft → Human
     * Tune → Lock → AI Continue」 a working loop rather than a slogan.
     */
    buildRoughCut: () => {
      const ctx = getCtx();
      const t = raw();
      const rows = api.roughRows();
      if (!roughcut.canBuild(rows)) {
        return { ok: false, error: "这一集还没有任何镜头视频——初剪需要真实素材，不会生成空时间线" };
      }
      const plan = roughcut.planRoughCut(rows);
      const res = roughcut.applyRoughCut(t, plan, {
        isLocked: (clipId) => ctx.locks.is("timelineClip", clipId),
        at: helpers.now(),
      });
      // An automatic pass is NOT a hand edit. `t.edited` means 「有人工调整」 —
      // the console prints it and the Final Render freezes it — so setting it
      // here made every render claim human tuning that never happened.
      //
      // The legacy auto-sync must still not overwrite this cut, and
      // `roughCutVersion` already says a rough cut exists; `api.doc()`
      // consults BOTH, so the protection is kept without the false claim.
      t.sourceSig = timelineSourceSig(timeline.buildFromRows(api.gatherRows()));
      ctx.persist();
      refreshProductionView();
      return { ok: true, ...res, summary: roughcut.summarize(res), version: t.roughCutVersion };
    },
    // Has the SOURCE (shots / current media / scene audio) changed since this
    // timeline was last built from it? Compares the current source's default
    // build to the sourceSig STAMPED at the last sync — NOT to the (possibly
    // hand-edited) clip list, so trim/reorder/volume edits never false-report
    // "source changed". The signature carries shotId + startTime so reordering
    // equal-duration shots that reuse one asset is still detected.
    sourceStale: (t) => timelineSourceSig(timeline.buildFromRows(api.gatherRows())) !== (t.sourceSig || ""),
    resync: () => {
      const t = raw();
      api._sync(t, api.gatherRows());
      getCtx().persist();
      refreshProductionView();
      toast("时间线已按当前镜头/音频重建（此前的手工调整被本次同步覆盖）");
    },
    op: (fn, ...args) => {
      const t = raw();
      const ok = timeline[fn](t, ...args);
      if (ok) { getCtx().persist(); refreshProductionView(); }
      return ok;
    },
    setSettings: (s) => {
      const t = raw();
      timeline.setSettings(t, s);
      getCtx().persist();
      return true;
    },
    // FINAL RENDER (local FFmpeg): resolve every clip's asset to its exact
    // uploaded file (bytes must be local — missing media fails honestly, it
    // is never skipped), render server-side, register the Final Asset and a
    // durable RENDER provenance record (type "render", provider ffmpeg-local,
    // inputs = clip assetIds, parameters = settings + clip snapshot).
    render: async () => {
      const ctx = getCtx();
      const production = docs.production();
      const assetRegistry = docs.assets();
      if (!session.connected()) throw new Error("演示模式无后端，无法渲染（需连接模式 + 本地 ffmpeg）");
      const t = raw();
      // REMOVED clips are not in the cut (§46) — `liveClips` is the one definition
      // of that, shared with the layout and the duration, so the render can never
      // include a shot the console shows as taken out.
      const live = timeline.liveClips(t);
      if (!live.some((c) => c.trackType === "video")) throw new Error("时间线没有视频 clip");
      const clips = [];
      for (const c of live) {
        // a muted / zero-volume AUDIO clip contributes nothing and the backend
        // skips it — drop it here too so an unavailable (deleted) asset on such
        // a clip never blocks a render it wouldn't participate in anyway
        const silentAudio = c.trackType !== "video" && (c.muted === true || c.volume <= 0);
        if (silentAudio) continue;
        const hit = assetlib.findAssetById(assetRegistry, c.assetId);
        if (!hit) throw new Error(`clip 引用的资产已不存在（${c.trackType} · ${c.assetId}）`);
        if ((hit.record.storageState || "local") !== "local") {
          throw new Error(`clip 的媒体不可用（${c.trackType} · ${hit.record.storageState}）— 请恢复或替换后再渲染`);
        }
        clips.push({
          track: c.trackType,
          file: String(hit.record.url || "").split("/").pop(),
          start: c.startTime,
          in: c.trimIn,
          out: c.trimOut,
          volume: c.volume,
          muted: c.muted,
          fadeIn: c.fadeIn,
          fadeOut: c.fadeOut,
        });
      }
      const res = await command.renderEpisode(session.projectName(), clips, t.settings);
      // CP2: the Final belongs to the episode whose timeline was just rendered
      const rec = assetlib.addFinal(assetRegistry, res.url, production.activeEpisodeId);
      // §57: THE FINAL MUST BE REPRODUCIBLE. Everything below is what a creator
      // asking 「这条成片到底是什么做出来的」 needs, and each field is read from
      // real state at render time rather than re-derived later (the timeline moves
      // afterwards; the record must keep describing THIS render).
      const subTrack = subtitle.trackFor(docs.subtitles(), production.activeEpisodeId);
      // ONLY the Shot Mixes that ACTUALLY FED THIS RENDER — i.e. whose asset is
      // on a clip in the cut. A shot can have a mix that is not in the timeline
      // at all (the episode render mixes the individual tracks itself), and
      // listing those as inputs claimed a lineage that did not happen: the mix
      // was never sent to ffmpeg. A provenance record that overstates what went
      // in is worse than one that says less, because it is believed.
      const renderedAssetIds = new Set(live.map((c) => c.assetId));
      const shotMixes = [];
      for (const shotId of new Set(live.map((c) => c.shotId).filter(Boolean))) {
        const mix = shotaudio.mixOf(docs.shotAudio(), shotId);
        if (!mix || !renderedAssetIds.has(mix.assetId)) continue;
        shotMixes.push({ shotId, assetId: mix.assetId, at: mix.at, sources: mix.sources, settings: mix.settings });
      }
      const gen = ctx.startGeneration({
        type: "render",
        targetType: null,
        targetId: null,
        inputAssetIds: [...new Set(live.map((c) => c.assetId))],
        promptSnapshot: null,
        provider: "ffmpeg-local",
        parameters: {
          providerMode: "local",
          settings: { ...t.settings },
          episodeId: production.activeEpisodeId,
          // WHICH timeline: the automatic-pass counter plus whether a human edited
          // it afterwards. 「时间线版本」 with no edited flag would describe two
          // different cuts identically.
          timelineVersion: Number.isInteger(t.roughCutVersion) ? t.roughCutVersion : 0,
          timelineEdited: t.edited === true,
          roughCutAt: t.roughCutAt || null,
          // per-clip: WHICH asset AND WHICH VERSION played, plus its transition
          clips: live.map((c) => ({
            clipId: c.clipId, trackType: c.trackType, shotId: c.shotId,
            assetId: c.assetId, assetVersion: c.assetVersion,
            startTime: c.startTime, trimIn: c.trimIn, trimOut: c.trimOut,
            volume: c.volume, muted: c.muted, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
            ...(c.trackType === "video" ? { transition: c.transition, transitionMs: c.transitionMs } : {}),
          })),
          // the Shot Mixes that fed it, each with its own frozen source list
          shotMixes,
          // WHICH subtitle version, and the honest statement that it was not
          // burned into the picture this round — a `subtitleVersion` with no such
          // note would imply the MP4 carries it
          subtitleVersion: Number.isInteger(subTrack.version) ? subTrack.version : 0,
          subtitleCues: subTrack.cues.length,
          subtitleBurnedIn: false,
          // LOCKS in force at render time: 「这条成片里哪些是人定死的」
          // EVERY lock in force, from the one counter the console also prints —
          // `locksdoc.count` alone omits prompt / audio-clip / frame-binding /
          // reading locks, and a provenance field that under-reports protections
          // is a wrong number in a record meant to be reproducible.
          locksInForce: ctx.locks.count(),
        },
        status: "generating",
      });
      if (gen && rec) {
        ctx.completeGeneration(gen.generationId, [rec.assetId]);
        rec.links.generationId = gen.generationId;
      }
      ctx.refreshType("edit");
      ctx.persist();
      refreshProductionView();
      return { ...res, assetId: rec ? rec.assetId : null };
    },
  };

  return api;
}
