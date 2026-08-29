// SKILL controller (TASK-073 §1.8 第四批) — the ONE way a capability runs.
//
//   Domain context → Skill → Runtime → structured Proposal
//     → AI Director review → user Accept → canonical controller write
//
// The runtime NEVER writes canon. This controller records the run and holds the
// Proposal; `accept()` marks it, and the caller then applies it through the normal
// domain controllers. Nothing here can modify a document, so a model's answer
// cannot become project data without a human decision.
//
// WHY IT WAS SAFE TO MOVE, AND WHERE THE RISK ACTUALLY IS. Its dependency face was
// measured before the move: 10 documents, ALL READ, zero writes. So the failure mode
// the earlier batches had to guard against — writing into the previous project's
// document (§5.10) — cannot arise here for the canon. What CAN still go wrong is the
// mirror image: READING a stale document and recording a context the prompt never
// carried, which is a fabricated provenance and looks exactly like a real one. So the
// documents arrive as GETTERS all the same, and every one of them is called AT THE
// POINT OF USE — never hoisted to a const across an `await` (§5.14: a closure reads a
// binding, a const reads a value, and the two only diverge where there is an await).
//
// `pendingOrigin` moved IN as private state rather than being injected. It is
// session intent, not a document: `useForGeneration` records it and
// `pendingOriginFor` consumes it, and those were its only two touchpoints in
// app.js. Keeping it here makes the one piece of mutable state this controller
// owns visible in the same file as the two rules that govern it.
//
// `_clipChain` moved in for the same reason `_writeCue` followed the subtitle
// controller: it had exactly one caller (the timeline half of `context`), and it
// holds the rule that a clip's alternatives come from its OWN track's chain.

/**
 * @param {object} deps
 *   docs      `{ runs, production, story, script, registry, refInterp, timelines,
 *                shotAudio, subtitles, generations }` — GETTERS, all READ-ONLY here
 *   catalog   `{ detail, problems }` — GETTERS: they are module-level `let`s that
 *             catalog installation reassigns at boot, so a captured value would
 *             report 「能力目录尚未加载」 forever
 *   modules   `{ skills, runtime, skillrun, skillapply, shotctx, proddoc, storydoc,
 *                scriptdoc, assetreg, refinterp, timeline, subtitle, mediaref }`
 *   findShot / slotOf     one shot by id, and its media slot (for `_clipChain`)
 *   isLocked  `(kind, id) => boolean` — `ctx.locks.is`
 *   shotAudio `{ resolved, anchors }` — the shot-audio read models
 *   shotCtx   `{ build, candidates }` — the ONE-shot projection (ADR-0064 决策 1)
 *   draftShots            `() => shot[]`
 *   dispatchAction        `(act, origin) => result` — `ctx.actions.dispatch`, the one
 *                         path a proposal may reach canon through
 *   persist / refresh / now
 */
export function createSkillController({
  docs,
  catalog,
  modules,
  findShot,
  slotOf,
  isLocked,
  shotAudio,
  shotCtx,
  draftShots,
  dispatchAction,
  persist,
  refresh,
  now,
}) {
  const {
    skills, runtime, skillrun, skillapply, shotctx,
    proddoc, storydoc, scriptdoc, assetreg, refinterp, timeline, subtitle, mediaref,
  } = modules;

  // The 「用于生成」 intent. Session-scoped by design — see `pendingOriginFor`.
  let pendingOrigin = null;

  /** The version chain a timeline clip could be replaced FROM — the right one for
   *  its track (TASK-072 §1.9 缺陷 7).
   *
   *  Reads the SAME map + key vocabulary as the timeline controller's `activeFor`,
   *  so 「这条片段当前是哪一版」 and 「它还能换成哪几版」 cannot disagree.
   *  Deliberately NOT the asset controller's `chainOf`, which guesses the domain by
   *  searching images → videos → audio and therefore returns the first-frame IMAGE
   *  chain for a video slot.
   *
   *  `ambience` / `bgm` return null: they are owned by the scene / episode, not by a
   *  per-shot chain, so there is no shot-level alternative list to offer. An empty
   *  list is the honest answer — a wrong one invites a proposal that cannot apply. */
  const _clipChain = (shotId, trackType) => {
    if (!shotId) return null;
    const shot = findShot(shotId);
    const slot = shot ? slotOf(shot) : null;
    if (!slot) return null;
    const key = trackType === "video"
      ? slot
      : trackType === "dialogue"
        ? `voice-${slot}`
        : trackType === "sfx"
          ? `sfx-${slot}`
          : null;
    if (!key) return null;
    const reg = docs.registry();
    const map = trackType === "video" ? reg.videos : reg.audio;
    return mediaref.slotEntry(map, key) || null;
  };

  const self = {
    catalog: () => skills.SKILLS,
    /** The RETIRED capabilities (TASK-080 §1.1). Separate from `catalog()` on
     *  purpose: they are resolvable and listable-as-retired, never pickable. */
    deprecated: () => skills.DEPRECATED,
    /** Is a catalog loaded, and if not, why (TASK-075 §1.4)?
     *
     *  A panel must distinguish "the backend could not give us the packages"
     *  from "there are no capabilities". The first is a system state with a
     *  cause; the second would be a lie told with an empty list. */
    catalogState: () => ({
      installed: skills.catalogInstalled(),
      detail: catalog.detail(),
      problems: catalog.problems(),
    }),
    find: (skillId) => skills.findSkill(skillId),
    runtimes: () => runtime.RUNTIMES,
    executors: () => runtime.EXECUTORS,
    probe: () => runtime.probeExecutors(),
    configurationHint: (executorId) => runtime.configurationHint(executorId),
    runs: () => docs.runs(),
    stats: (skillId) => skillrun.skillStats(docs.runs(), skillId),

    /** 某一轮对话已经起过的那次运行，或 null（TASK-119 / ADR-0091 的幂等闸）。
     *
     *  问的是**登记表**，不是页面内存：那正是让「刷新 / 轮询 / 重试都不会重复启动」
     *  成立的原因 —— 登记表跟着 canvas 一起持久化，页面内存不会。 */
    routedRunFor: (conversationRunId) => {
      if (!conversationRunId) return null;
      return (docs.runs() || []).find(
        (r) => r && r.origin && r.origin.conversationRunId === conversationRunId,
      ) || null;
    },

    /** 哪些上下文键**此刻真的有内容**（TASK-119 / ADR-0091 决策 2）。
     *
     *  服务端的 resolver 要靠它判断「这个能力现在跑得起来吗」。为什么由前端报：
     *  创作文档只活在浏览器里（ADR-0089 决策 2b），服务端读 canvas 再自己判一遍
     *  等于把 `context` 那套内容判定在 Python 里重抄一份 —— 而两份判定一旦不一致，
     *  屏幕上会显示「可以跑」，跑起来却被必要输入闸拒掉。
     *
     *  用的是**同一个** `missingInputs`，所以这里说「够」的，那边一定也说够。 */
    readyInputs: (scope = null) => {
      const out = new Set();
      for (const skill of skills.SKILLS) {
        // 只算参与自然语言路由的那些：resolver 只会从它们里面选，
        // 为其余的包各建一次上下文是白花的（`context` 会把整条时间线投影出来）。
        if (!skill.routing) continue;
        const missing = new Set(self.missing(skill.skillId, {}, scope));
        for (const key of skill.inputs) if (!missing.has(key)) out.add(key);
      }
      return [...out];
    },

    /** 这个幂等 key 是否已经用掉了（结构性变更只触发一次跨层诊断）。 */
    hasOriginKey: (key) => {
      if (!key) return false;
      return (docs.runs() || []).some(
        (r) => r && r.origin && r.origin.idempotencyKey === key,
      );
    },
    /** An input key's human label. Here rather than in each panel so 「缺少必要输入」
     *  reads the same wherever it is reported. */
    inputLabel: (key) => skills.SKILL_INPUTS[key] || key,

    /**
     * The domain context for a skill, assembled from the CANONICAL documents.
     * Read-only: this builds the prompt's data, it never reaches back.
     *
     * TASK-067 §15 / ADR-0064 决策 1: a skill that declares any SHOT-SCOPED input
     * (`shotContext` / `assetCandidates` / `selectedShotImage` / `neighbourShots` /
     * `promptUnderReview`) is served from the one-shot projection — the minimal
     * projection of ONE shot — rather than from the project-wide bag below. That is
     * the whole of this round's context-cost strategy: those capabilities never see
     * every draft shot, every reference, every asset and every generation just to
     * answer a question about one shot.
     *
     * `scope.shotId` names WHICH shot. Absent, the shot-scoped keys are absent too,
     * and `missingInputs` refuses the run — a shot-scoped capability run against no
     * shot would answer about whatever happened to be selected.
     */
    context: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return {};
      const prod = docs.production();
      const storyDoc = docs.story();
      const registry = docs.registry();
      const generations = docs.generations();
      const ep = proddoc.activeEpisode(prod);
      const draft = draftShots() || [];
      const view = ep ? proddoc.episodeView(prod, ep.episodeId, draft) : null;
      const available = {
        brief: storydoc.activeBrief(storyDoc) || storyDoc.brief.draft,
        outline: (storydoc.approvedOutline(storyDoc) || storydoc.activeOutline(storyDoc) || {}).outline || null,
        characters: prod.characters,
        relationships: prod.relationships,
        world: prod.world,
        episodePlan: (() => {
          const plan = storydoc.confirmedPlan(storyDoc);
          const entry = plan && ep ? plan.episodes.find((e) => e.episodeId === ep.episodeId) : null;
          return entry || null;
        })(),
        // THE WHOLE PLAN, as `episode-plan-reviser` needs it (TASK-094 批次 A).
        // Deliberately a different key from `episodePlan` above, which is ONE
        // episode's entry: two shapes under one key is how a capability ends up
        // being asked about 12 episodes while its prompt says 「本集规划」.
        // `planForPrompt` strips episodeId — identity is re-derived from the
        // document, never read back out of an answer (ADR-0072 决策 1).
        currentPlan: (() => {
          const entries = storydoc.planForPrompt(storydoc.effectivePlanEpisodes(storyDoc));
          return entries.length ? entries : null;
        })(),
        episodeScript: scriptdoc.currentText(docs.script()),
        scenes: view ? view.scenes.map((s) => ({ sceneId: s.sceneId, title: s.title, shotIds: s.shotIds })) : [],
        shots: draft,
        references: assetreg.listReferences(registry).map((r) => ({
          key: r.key, kind: r.kind, name: assetreg.derivedLabel(r), version: r.version, links: r.links,
          // ADR-0061 决策 4: Reference Interpreter needs to see what has ALREADY
          // been read, or it re-reads references the creator settled on — and it
          // needs to know a reading is LOCKED, because proposing one that will be
          // refused wastes the run.
          interpretation: (() => {
            const reading = refinterp.activeReading(docs.refInterp(), r.key);
            return reading ? { axes: reading.axes, version: reading.version, locked: reading.locked } : null;
          })(),
        })),
        assets: assetreg.listAssets(registry).map((a) => ({
          assetId: a.assetId, kind: a.kind, name: assetreg.derivedLabel(a),
          tags: a.tags, reusable: a.reusable, links: a.links,
        })),
        generations,
        // --- POST-PRODUCTION context (ADR-0061 决策 6 / §55) ----------------- //
        // A post skill must address a CLIP or a CUE by id, so the context carries
        // the ids — an editing note that cannot be addressed cannot be applied,
        // and would come back as prose the creator has to re-do by hand.
        timeline: (() => {
          const t = timeline.timelineFor(docs.timelines(), prod.activeEpisodeId);
          const nameOf = (sid) => {
            const s = findShot(sid);
            return s ? (s.title || `镜头 ${s.sequence}`) : null;
          };
          return {
            episodeId: prod.activeEpisodeId,
            settings: t.settings,
            durationSeconds: timeline.timelineDuration(t),
            clips: timeline.liveClips(t).map((c) => ({
              clipId: c.clipId,
              trackType: c.trackType,
              shotId: c.shotId,
              shotTitle: c.shotId ? nameOf(c.shotId) : null,
              assetId: c.assetId,
              assetVersion: c.assetVersion,
              startMs: Math.round(c.startTime * 1000),
              inMs: Math.round(c.trimIn * 1000),
              outMs: Math.round(c.trimOut * 1000),
              volume: c.volume,
              muted: c.muted,
              ...(c.trackType === "video" ? { transition: c.transition, transitionMs: c.transitionMs } : {}),
              locked: isLocked("timelineClip", c.clipId),
              // the OTHER takes it could be replaced with, so 「换成 v3」 can name
              // a real assetId rather than a version number nothing resolves
              //
              // BY TRACK TYPE (TASK-072 §1.9 缺陷 7). This used to look up the
              // shot's slot with no regard for the track, so an AUDIO clip was
              // handed the shot's VIDEO version chain — and the asset controller's
              // `chainOf` searches images first, so a video clip could be offered its
              // first-frame IMAGE versions. Either way the Editing Director
              // proposes `replaceTimelineAsset` with an asset of the wrong domain
              // and the write is refused at domain validation, every time. The key
              // rules here are the SAME ones the timeline controller's `activeFor` uses.
              alternatives: (() => {
                const entry = _clipChain(c.shotId, c.trackType);
                if (!entry) return [];
                return entry.history
                  .filter((v) => v.assetId && v.assetId !== c.assetId)
                  .map((v) => ({ assetId: v.assetId, version: v.version }));
              })(),
            })),
          };
        })(),
        shotAudio: (() => {
          const out2 = [];
          for (const shotId of Object.keys(docs.shotAudio())) {
            const resolved = shotAudio.resolved(shotId);
            if (!resolved.length) continue;
            const s = findShot(shotId);
            out2.push({
              shotId,
              shotTitle: s ? (s.title || `镜头 ${s.sequence}`) : null,
              anchors: shotAudio.anchors(shotId),
              clips: resolved.map((c) => ({
                clipId: c.clipId, trackType: c.trackType, assetId: c.assetId,
                startMs: c.startMs, endMs: c.endMs, anchor: c.anchor, offsetMs: c.offsetMs,
                gainDb: c.gain, fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs,
                muted: c.muted, unresolved: c.unresolved, locked: c.locked,
              })),
            });
          }
          return out2;
        })(),
        subtitles: (() => {
          const t = subtitle.trackFor(docs.subtitles(), prod.activeEpisodeId);
          return {
            episodeId: prod.activeEpisodeId,
            version: t.version,
            style: t.style,
            generatedFrom: t.generatedFrom,
            overlaps: subtitle.overlaps(t),
            cues: t.cues.map((c) => ({
              cueId: c.cueId, startMs: c.startMs, endMs: c.endMs, text: c.text,
              speaker: c.speaker, shotId: c.shotId, origin: c.origin,
              locked: isLocked("subtitle", c.cueId),
            })),
          };
        })(),
      };

      // --- the SHOT-SCOPED half (TASK-067 §3, ADR-0064 决策 1) ------------- //
      //
      // Built ONLY when this skill declares a shot-scoped input, and only when the
      // caller named a shot. `build` is called at most once even though four keys
      // read from it, because it resolves the whole shot detail model.
      const shotId = scope && typeof scope === "object" && typeof scope.shotId === "string"
        ? scope.shotId
        : null;
      if (skills.isShotScoped(skill) && shotId) {
        const built = shotCtx.build(shotId);
        const c = built.context;
        if (c) {
          available.shotContext = c;
          available.neighbourShots = (c.neighbours.previous || c.neighbours.next) ? c.neighbours : null;
          // `describedAs` is present whenever an image is: the required-input gate
          // judges by CONTENT, and `{assetId, version}` is all identity — an object
          // of nothing but ids would read as empty and make Video Prompt Director
          // refuse a shot that really does have a selected main frame.
          // WHAT THE FIRST FRAME LOOKS LIKE, in the only form this runtime can carry.
          //
          // The runtime sends TEXT and receives TEXT (ADR-0056 决策 2) — the picture
          // itself goes to the external image/video tool, not to the model writing the
          // prompt. But 「以所附图片为第 1 帧，保持完全一致」 is an assertion about an
          // image the writer has never seen (codex review round 3), and there IS a
          // textual answer on file: the prompt that produced that exact take.
          //
          // Honestly null for an imported frame with no generation record — we do not
          // describe a picture nobody wrote a prompt for.
          available.selectedShotImage = c.media.selectedShotImage
            ? (() => {
                const sel = c.media.selectedShotImage;
                const gen = sel.assetId
                  ? (generations || []).find(
                    (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(sel.assetId),
                  )
                  : null;
                const fromPrompt = gen && typeof gen.promptSnapshot === "string" && gen.promptSnapshot.trim()
                  ? gen.promptSnapshot
                  : null;
                return {
                  ...sel,
                  describedAs: `主帧图 v${sel.version}${sel.origin ? `（${sel.origin}）` : ""}`,
                  // the frozen prompt this take was generated from — what the picture
                  // was MADE to look like
                  fromPrompt,
                  ...(fromPrompt ? {} : { appearanceNote: "这一版主帧图没有生成记录（外部导入），无从描述它的实际画面——只能依据镜头设计与参考保持一致" }),
                };
              })()
            : null;
          const cand = shotCtx.candidates(shotId);
          available.assetCandidates = cand;
          // WHICH prompt is under review is the caller's statement (`extra`), not a
          // guess: reviewing 「whichever one is non-empty」 would silently review the
          // image prompt when the creator asked about the video one.
          const reviewKind = extra && extra.reviewKind === "video" ? "video" : "image";
          const under = c.prompts[reviewKind];
          available.promptUnderReview = under && under.text
            ? { kind: reviewKind, version: under.version, text: under.text }
            : null;
        }
      }

      const out = {};
      for (const k of [...skill.inputs, ...skill.optionalInputs]) {
        if (k in extra) { out[k] = extra[k]; continue; }
        if (k in available) out[k] = available[k];
      }
      return out;
    },

    /**
     * WHICH canon a run of this skill reads, as ids (ADR-0059 要求 2).
     *
     * Derived from the SAME state `context` assembles its inputs from, so the
     * recorded context and the prompt can never name different episodes. A caller
     * narrows it by passing `scope` (a shot-scoped action passes its shotId);
     * everything it does not name stays null.
     *
     * The episode is taken from the production document's ACTIVE episode
     * because that is genuinely what the context builder read — not as a guess.
     * A skill that reads no episode-level input at all (a project-wide one)
     * records no episode: it did not look at one.
     */
    scopeOf: (skillId, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return null;
      const prod = docs.production();
      const keys = new Set([...skill.inputs, ...skill.optionalInputs]);
      // TASK-064: the post-production inputs are EPISODE-level by construction —
      // a timeline, a subtitle track and a shot-audio arrangement all belong to
      // one episode — so a run that reads any of them really did read an episode.
      // Leaving them out made an Editing Director run record no episode at all,
      // which is a run the provenance graph cannot place.
      //
      // TASK-067: a SHOT-SCOPED input is episode-level for the same reason —
      // `shotContext` projects the active episode's scene and shot, so a run that
      // read one really did read that episode. Omitting it here would leave every
      // Image Prompt Director run unplaceable on the provenance graph.
      const readsEpisode = ["episodePlan", "episodeScript", "scenes", "shots", "timeline", "subtitles", "shotAudio"]
        .some((k) => keys.has(k)) || skills.isShotScoped(skill);
      // The EPISODE is not the caller's to choose. `context` builds its inputs
      // from the ACTIVE episode and nothing else, so honouring a caller-supplied
      // episodeId would record a context the prompt never read
      // — a lie that looks exactly like provenance.
      const s = scope != null && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
      // For a SHOT-SCOPED run the episode is the one that OWNS the shot — the same
      // derivation the one-shot projection uses. Reading the active pointer here while
      // the context builder read the shot's own episode is exactly the disagreement
      // between record and prompt ADR-0059 exists to prevent (codex review).
      const shotOwner = skills.isShotScoped(skill) && typeof s.shotId === "string" && s.shotId
        ? proddoc.sceneOfShot(prod, s.shotId)
        : null;
      const ep = shotOwner
        ? shotOwner.episode
        : readsEpisode ? proddoc.activeEpisode(prod) : null;
      const episodeId = ep ? ep.episodeId : null;
      // A caller may NARROW within that episode. A scene or shot belonging to a
      // different one is dropped rather than recorded: the same inconsistency,
      // one level down.
      // Checked TOGETHER, not one at a time: a scene from S01 plus a shot from
      // S02 passes two independent membership tests and records a scene/shot
      // pairing that does not exist.
      const owns = (sceneId, shotId) => {
        if (!ep) return false;
        const scenes = ep.scenes || [];
        const scene = sceneId ? scenes.find((sc) => sc.sceneId === sceneId) || null : null;
        if (sceneId && !scene) return false;
        if (shotId) {
          const home = scene || scenes.find((sc) => (sc.shotIds || []).includes(shotId));
          if (!home || !(home.shotIds || []).includes(shotId)) return false;
        }
        return true;
      };
      // A LEVEL is recorded only when the skill actually reads that level. A
      // skill given only the outline never saw a shot, so recording one would
      // assert shot-level lineage the prompt cannot support — the same rule as
      // the episode above, one step down.
      const readsScene = keys.has("scenes") || skills.isShotScoped(skill);
      // `shotAudio` is per-shot data, so a run given it genuinely can be narrowed
      // to one shot — which is what makes a Sound Designer proposal for SH03
      // recorded as being about SH03 rather than about the whole episode. A
      // shot-scoped input is per-shot by definition (TASK-067).
      const readsShot = keys.has("shots") || keys.has("shotAudio") || skills.isShotScoped(skill);
      const wantScene = readsScene && typeof s.sceneId === "string" && s.sceneId ? s.sceneId : null;
      const wantShot = readsShot && typeof s.shotId === "string" && s.shotId ? s.shotId : null;
      const narrow = owns(wantScene, wantShot);
      // A SHOT-SCOPED run really did read the shot's own scene — `shotContext`
      // projects it — so the scene is DERIVED from the shot rather than left null.
      // Derived, not guessed: it is the scene that actually owns this shot, and a
      // shot the episode does not own has already been dropped by `owns`.
      const derivedScene = narrow && !wantScene && wantShot && skills.isShotScoped(skill) && ep
        ? ((ep.scenes || []).find((sc) => (sc.shotIds || []).includes(wantShot)) || {}).sceneId || null
        : null;
      const out = {
        episodeId,
        sceneId: narrow ? (wantScene || derivedScene) : null,
        shotId: narrow ? wantShot : null,
      };
      return out.episodeId || out.sceneId || out.shotId ? out : null;
    },

    /** The full task prompt — IDENTICAL for every runtime. Copying this into a
     *  web chat and running it locally ask exactly the same question.
     *
     *  `scope` must be the SAME one the run will use: a preview compiled without
     *  the shot would show the creator a different question from the one asked. */
    prompt: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return "";
      return skills.compilePrompt(skill, self.context(skillId, extra, scope));
    },

    /** Which required inputs are missing. A skill with missing inputs REFUSES
     *  to run — an AI asked to storyboard with no scene produces something
     *  plausible and unrelated, which is worse than an honest refusal.
     *
     *  For a shot-scoped capability this is also the gate §8 relies on: with no
     *  selected main frame, `selectedShotImage` is absent and Video Prompt Director
     *  reports it as missing rather than writing an ungrounded prompt. */
    missing: (skillId, extra = {}, scope = null) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return [];
      return skills.missingInputs(skill, self.context(skillId, extra, scope));
    },

    /**
     * Run a Skill and record the run. `executor` "manual" only OPENS the run
     * (the creator pastes the answer back via `submitManual`); a local executor
     * runs it now.
     */
    run: async (skillId, { executor = "manual", extra = {}, summary = null, scope = null, origin = null } = {}) => {
      const skill = skills.findSkill(skillId);
      if (!skill) return { ok: false, error: `未知能力 ${skillId}` };
      // A shot-scoped capability with no shot has nothing to read. Refused HERE with
      // the reason, rather than letting it run on an empty projection and answer
      // about a shot nobody named (TASK-067 §3).
      const shotScoped = skills.isShotScoped(skill);
      const scopeShotId = scope && typeof scope === "object" && typeof scope.shotId === "string"
        ? scope.shotId
        : null;
      if (shotScoped && !scopeShotId) {
        return { ok: false, error: "这个能力只针对一个镜头运行——先选一个镜头" };
      }
      const context = self.context(skillId, extra, scope);
      const missing = skills.missingInputs(skill, context);
      if (missing.length) {
        return {
          ok: false,
          error: `缺少必要输入：${missing.map((k) => skills.SKILL_INPUTS[k] || k).join("、")}`,
        };
      }
      const exec = runtime.EXECUTOR_BY_ID.get(executor);
      const rec = skillrun.startRun(docs.runs(), {
        skillId: skill.skillId,
        skillVersion: skill.version,
        runtime: exec ? exec.runtime : "manual",
        executor,
        // WHO ASKED (TASK-119). Recorded AT LAUNCH, before anything can fail:
        // that is what makes it a dedupe key rather than a report. A run that
        // errors out still carries its origin, so the sentence that started it
        // does not get to start a second one.
        origin,
        inputKeys: Object.keys(context),
        inputSummary: summary || (shotScoped && context.shotContext
          ? shotctx.summarize(context.shotContext)
          : null),
        // WHICH canon this run read, as ids (ADR-0059). Taken from the same
        // place `context` read it from, so the record and the prompt
        // can never describe different episodes. A caller may narrow it (a
        // shot-scoped skill passes its shotId); anything it does not name stays
        // null, because a null level is a fact about the run's scope.
        context: self.scopeOf(skillId, scope),
        // TASK-067 §3 / ADR-0064 决策 2: WHAT this run read, not just which level.
        // Taken from the very context object compiled into the prompt below, so the
        // record cannot describe a projection the prompt did not carry. Null for a
        // project-wide capability — it read no single shot, and inventing a trace
        // would claim a precision the run does not have.
        //
        // WHICH PROMPT A REVIEW READ is part of that trace, and it is the only place
        // it can live: the reviewer's answer does not restate it, and reading the
        // creator's currently-open tab at apply time would let an image review be
        // written into the video prompt.
        contextTrace: !shotScoped
          // TASK-072 §1.9 缺陷 8: an EPISODE-wide run needs a trace too. The
          // Editing Director is handed each clip's `alternatives`; without
          // recording them, `replaceTimelineAsset` accepted any registered asset of
          // the right domain, so an injected or hallucinated proposal could swap a
          // clip for ANY unrelated media in the project. Same shape and same
          // fail-closed rule as `candidateKeys` above — recorded at launch, because
          // that is when the permission was fixed.
          ? (context.timeline && Array.isArray(context.timeline.clips)
            ? {
                timelineAlternatives: Object.fromEntries(
                  context.timeline.clips.map((c) => [
                    c.clipId,
                    (Array.isArray(c.alternatives) ? c.alternatives : [])
                      .map((v) => v.assetId)
                      .filter((id) => typeof id === "string" && id),
                  ]),
                ),
              }
            : null)
          : context.shotContext
          ? {
              ...shotctx.traceOf(context.shotContext, {
                // WHICH candidates this run was allowed to pick from (决策 4). Recorded
                // at launch, because that is when the permission was fixed — and the
                // applier checks against it rather than against a fresh retrieval.
                candidateKeys: context.assetCandidates && Array.isArray(context.assetCandidates.candidates)
                  ? context.assetCandidates.candidates.map((c) => c.referenceKey)
                  : null,
              }),
              ...(context.promptUnderReview
                ? {
                    reviewedPromptKind: context.promptUnderReview.kind,
                    reviewedPromptVersion: context.promptUnderReview.version,
                  }
                : {}),
            }
          : null,
        createdAt: now(),
      });
      if (!rec) return { ok: false, error: "无法建立运行记录" };
      const prompt = skills.compilePrompt(skill, context);
      if (executor === "manual") {
        // FREEZE the question. The creator copies it later — possibly after editing
        // the shot — and recompiling then would hand them a prompt that no longer
        // matches the context this run recorded (codex review round 4).
        rec.promptText = prompt;
        persist();
        // the run stays OPEN until the creator brings an answer back
        return { ok: true, run: rec, prompt, manual: true };
      }
      persist();
      const res = await runtime.runOnExecutor({ executor, prompt });
      if (!res.ok) {
        // `docs.runs()` is read HERE, after the await — never hoisted (§5.14).
        skillrun.failRun(docs.runs(), rec.runId, res.kind, res.detail);
        persist();
        refresh();
        return { ok: false, error: res.detail, kind: res.kind, run: rec };
      }
      return self._land(rec, skill, res.text, res.model);
    },

    /** Bring a MANUAL answer back. Same skill, same schema, same gate — only
     *  the executor differed. */
    submitManual: (runId, text) => {
      const rec = skillrun.findRun(docs.runs(), runId);
      if (!rec) return { ok: false, error: "运行记录不存在" };
      // A run that has ALREADY landed is not open for another answer. Without
      // this, pasting a second (malformed) answer into a run that already holds
      // a good proposal would fail it and wipe the creator's result.
      // A manual run waits in `awaiting_input` — nothing is running, the system
      // is waiting for a person. `running` is still accepted so a record written
      // before v15 (and not yet migrated in memory) can still be answered.
      if (rec.status !== "awaiting_input" && rec.status !== "running") {
        return { ok: false, error: `这次运行已经是「${rec.status}」，不能再提交结果` };
      }
      // …and a LOCAL run is not a manual one. Pasting an answer into a run that
      // a local executor is still working on creates a race: whichever lands
      // second fails validation and clears the one that landed first.
      if (rec.executor !== "manual") {
        return { ok: false, error: `这次运行由「${rec.executor}」执行，不能手工提交结果` };
      }
      const skill = skills.findSkill(rec.skillId);
      if (!skill) return { ok: false, error: `未知能力 ${rec.skillId}` };
      return self._land(rec, skill, text, null);
    },

    /** Validate an answer and land it as a Proposal — or as an honest failure.
     *  A non-conforming answer NEVER becomes a partially-kept proposal. */
    _land: (rec, skill, text, model) => {
      const read = skills.readSkillAnswer(skill, text);
      if (!read.ok) {
        skillrun.failRun(docs.runs(), rec.runId, "invalid_output", read.error);
        persist();
        refresh();
        return { ok: false, error: read.error, kind: "invalid_output", run: rec };
      }
      // proposeRun REFUSES a run that is not `running`. Ignoring that refusal
      // would report success for a proposal that was never recorded, and the UI
      // would render something the document does not contain.
      const landed = skillrun.proposeRun(docs.runs(), rec.runId, read.value, {
        model,
        at: now(),
      });
      if (!landed) {
        return { ok: false, error: `这次运行已经是「${rec.status}」，结果未记录`, kind: "execution_error", run: rec };
      }
      persist();
      refresh();
      return { ok: true, run: rec, proposal: read.value };
    },

    /**
     * The origin stamp a production action carries when it is launched FROM a
     * run's proposal (ADR-0059 要求 3). Returns null for anything else.
     *
     * The caller must name the run — nothing here searches for "the proposal
     * that was probably behind this". A generation attributed by proximity
     * would read as a record of something that never happened.
     */
    originOf: (runId) => {
      const r = skillrun.findRun(docs.runs(), runId);
      if (!r) return null;
      const proposalId = skillrun.proposalIdOf(r);
      // 「从这份提案发起」 requires a proposal the creator ACCEPTED. A run still
      // waiting for an answer has none; a rejected one launched nothing; and a
      // proposal with no id cannot be pointed at. Stamping any of those would
      // let a generation claim a provenance the records never support.
      if (!skillrun.isAccepted(r) || !proposalId) return null;
      return { skillRunId: r.runId, proposalId };
    },

    /**
     * 「应用」 — write a proposal back to canon (ADR-0061 决策 3).
     *
     * The plan comes from `skillapply.planApply`, which knows WHICH canonical
     * surface each skill's answer belongs to and refuses the ones that have
     * none. Every action is then performed through the ORDINARY controller for
     * that surface, so a proposal cannot reach a document through a path that
     * skips the guards a hand edit goes through.
     *
     * The run is marked accepted only AFTER the write succeeds: a run marked
     * accepted with nothing applied would claim a decision took effect when it
     * did not.
     */
    applyProposal: (runId, scope = {}) => {
      const run = skillrun.findRun(docs.runs(), runId);
      if (!run) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isPending(run)) {
        return { ok: false, error: `这次运行是「${run.status}」，没有待应用的提案` };
      }
      // The SCOPE the run recorded wins over whatever is selected now: applying
      // a shot-scoped proposal to a different shot than the one the run read
      // would attribute the answer to a context it never saw (ADR-0059).
      const recorded = run.context || {};
      const trace = run.contextTrace || {};
      const merged = {
        shotId: recorded.shotId || scope.shotId || null,
        genKind: scope.genKind === "video" ? "video" : "image",
        // TASK-067: which prompt a REVIEW was about comes from what the run really
        // read, never from what is on screen now (see `contextTrace` in `run`).
        reviewKind: trace.reviewedPromptKind === "video" ? "video" : "image",
        // …and WHICH references this run was allowed to recommend (ADR-0064 决策 4).
        // From the run's own record, so the permission is the one that was in force
        // when the answer was produced — not whatever a fresh retrieval returns now.
        candidateKeys: Array.isArray(trace.candidateKeys) ? trace.candidateKeys : null,
        // …and WHICH takes this run was allowed to swap each clip to
        // (TASK-072 §1.9 缺陷 8). Same rule, other surface: the alternatives the run
        // actually saw, not a fresh lookup — a version added since would otherwise
        // become retroactively "allowed".
        timelineAlternatives:
          trace.timelineAlternatives != null
          && typeof trace.timelineAlternatives === "object"
          && !Array.isArray(trace.timelineAlternatives)
            ? trace.timelineAlternatives
            : null,
      };
      const plan = skillapply.planApply(run.skillId, run.proposal, merged);
      if (!plan.ok) return plan;
      // EVERY action is attempted, and the outcome of each is reported.
      //
      // Aborting on the first failure was wrong in a way that only showed on a
      // retry: a multi-reference proposal would bind two references, fail on the
      // third, and leave the run un-accepted — so pressing 应用 again failed
      // immediately on the two bindings that had already landed, and the
      // remaining ones could never be applied at all (codex review round 1).
      //
      // So: an action that is ALREADY SATISFIED counts as done rather than as an
      // error (applying a proposal twice must be safe), a genuine failure is
      // collected and reported, and the run is accepted when anything landed.
      const done = [];
      const already = [];
      const failed = [];
      for (const act of plan.actions) {
        const res = dispatchAction(act, {
          skillRunId: run.runId,
          proposalId: skillrun.proposalIdOf(run),
        });
        if (res.ok) { done.push(act.action); continue; }
        if (res.satisfied) { already.push(act.action); continue; }
        failed.push(`${act.action}：${res.error}`);
      }
      if (!done.length && !already.length) {
        return { ok: false, error: failed.length ? failed.join("；") : "提案里没有任何可应用的内容" };
      }
      const parts = [];
      if (done.length) parts.push(`${done.length} 项已应用（${[...new Set(done)].join("、")}）`);
      if (already.length) parts.push(`${already.length} 项本来就已满足`);
      // WHAT THE PLAN REFUSED TO CARRY, said out loud. `planApply` drops entries it
      // cannot map onto a real field of the target document — a `world-director`
      // answer naming `magicSystem`, for instance — and dropping them is right,
      // because a key nothing reads must not land in canon while the creator
      // believes they accepted it. But 「已应用」 with those entries missing and
      // nothing said is the same silence, one layer later (codex review, 批次 F2).
      if (Array.isArray(plan.skipped) && plan.skipped.length) {
        parts.push(`${plan.skipped.length} 项不是这份档案的字段，已跳过（${plan.skipped.join("、")}）`);
      }
      // The run is accepted ONLY when the proposal fully landed.
      //
      // Round 1 aborted on the first failure, which stranded the rest. The fix
      // for that swung too far and accepted the run whenever ANYTHING landed —
      // and `applyProposal` refuses a run that is no longer `proposed`, so the
      // failed items could never be retried once their prerequisite was fixed
      // (codex review round 2). A partial apply therefore leaves the run
      // PROPOSED: the actions that succeeded are idempotent (they now report
      // `satisfied`), so pressing 应用 again finishes the job instead of
      // re-doing it.
      if (failed.length) {
        return {
          ok: true,
          partial: true,
          detail: `${parts.join("；")}；${failed.length} 项失败，提案仍待处理（修好后可再按「应用」重试）：${failed.join("；")}`,
          failed,
        };
      }
      self.accept(runId);
      return { ok: true, partial: false, detail: parts.join("；"), failed };
    },

    /**
     * 「用于生成」 — accept the proposal and hand back the origin stamp the next
     * generation will carry (ADR-0061 决策 3 / TASK-064 §74).
     *
     * This is the half that makes the button real rather than decorative: the
     * accepted run's `{skillRunId, proposalId}` is remembered as the PENDING
     * ORIGIN, and the next generation launched for that shot freezes it into its
     * record — so the provenance graph can show that this generation was in fact
     * started from this proposal.
     */
    useForGeneration: (runId) => {
      const run = skillrun.findRun(docs.runs(), runId);
      if (!run) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isPending(run) && !skillrun.isAccepted(run)) {
        return { ok: false, error: `这次运行是「${run.status}」，没有可用于生成的提案` };
      }
      if (skillrun.isPending(run) && !self.accept(runId)) {
        return { ok: false, error: "无法标记为已接受" };
      }
      const origin = self.originOf(runId);
      if (!origin) {
        return { ok: false, error: "这份提案没有可引用的身份（proposalId 未记录）" };
      }
      // The intent is remembered EXPLICITLY, keyed to the run the creator pressed
      // it on. See `pendingOriginFor` for why it is not derived.
      pendingOrigin = { ...origin, shotId: (run.context && run.context.shotId) || null };
      persist();
      refresh();
      return { ok: true, origin, shotId: pendingOrigin.shotId };
    },

    /**
     * The origin stamp a generation for `shotId` should carry, or null.
     *
     * ONLY an explicit 「用于生成」 produces one. An earlier revision derived it
     * instead — "the newest accepted run nobody has claimed" — which silently
     * included runs accepted by 应用 (a canon write, not a generation intent), so
     * an unrelated later generation could be stamped with a proposal that never
     * launched it (codex review round 1). That is a fabricated lineage, and a
     * fabricated lineage is worse than none because it looks like a record.
     *
     * Bound to the run's OWN recorded shot: a proposal accepted for SH03 must not
     * stamp a generation launched for SH07. A run whose scope genuinely was wider
     * than one shot (no recorded shotId) can stamp any shot's generation —
     * narrowing that would invent a limit the record does not state.
     *
     * KNOWN LIMIT, deliberately accepted: this intent is session-scoped, so a
     * reload between 「用于生成」 and the upload loses it and the creator presses
     * the button again. Persisting it would need its own schema field with its own
     * "was this consumed" bookkeeping; a lost convenience is a far smaller cost
     * than a wrong provenance record.
     */
    pendingOriginFor: (shotId) => {
      if (!pendingOrigin) return null;
      if (pendingOrigin.shotId && pendingOrigin.shotId !== shotId) return null;
      // A generation that already carries this origin has consumed it — an origin
      // describes ONE launch.
      const claimed = docs.generations().some(
        (g) => g && g.origin && g.origin.skillRunId === pendingOrigin.skillRunId,
      );
      if (claimed) { pendingOrigin = null; return null; }
      return { skillRunId: pendingOrigin.skillRunId, proposalId: pendingOrigin.proposalId };
    },

    /** The creator ACCEPTS. This marks the run only — applying the proposal to
     *  canon is the caller's, through the normal domain controllers. */
    accept: (runId) => {
      const r = skillrun.acceptRun(docs.runs(), runId, now());
      if (!r) return null;
      persist();
      refresh();
      return r;
    },
    reject: (runId, reason) => {
      const r = skillrun.rejectRun(docs.runs(), runId, now(), reason);
      if (!r) return null;
      persist();
      refresh();
      return r;
    },

    /**
     * ABANDON a run that is still `running` (TASK-067).
     *
     * WHY THIS HAS TO EXIST: a manual run stays open until an answer comes back, and
     * an answer does not always come back — the creator changes their mind, or the
     * page is closed mid-run. Nothing could then move that run out of `running`, so it
     * sat in the panel's open-run slot forever and every later answer was matched
     * against it instead of against the operation just pressed. Found on the real
     * project, which had accumulated several.
     *
     * Recorded as a REAL terminal state (`execution_error` with the creator's reason),
     * not deleted: the run happened, it was asked, and it produced nothing. Deleting it
     * would leave only the flattering half of the history — the same rule that keeps
     * rejected proposals (ADR-0056 决策 6).
     */
    /**
     * REAL CANCEL — terminate a run the BACKEND owns (TASK-073 §1.3 / 验收 #7).
     *
     * `abandon` already told the creator to 「用『取消运行』终止它」 for anything not
     * executed manually, but no such entry point existed: the sentence pointed at
     * nothing. This is it.
     *
     * IT NEVER SETTLES THE RECORD ITSELF. A local executor is a real process, and
     * only `POST /api/runs/<id>/cancel` can prove it died. This calls that, and then
     * records ONLY what the backend confirmed:
     *
     *   cancelled   → the process tree is gone; mark it cancelled here too
     *   cancelling  → the kill was NOT confirmed; the run stays open and the real
     *                 reason (including any residual pid) is reported verbatim
     *   finished    → it completed before the request landed; the real outcome
     *                 stands and nothing is overwritten with 「已取消」
     *
     * Writing `cancelled` on an unconfirmed kill is exactly what 系统合同 §5.4
     * rule 3 forbids: it puts 「已取消」 on screen while the executor keeps running
     * and keeps spending.
     */
    cancel: async (runId) => {
      const r = skillrun.findRun(docs.runs(), runId);
      if (!r) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isOpen(r)) {
        return { ok: false, error: `这次运行已经是「${r.status}」，没有可取消的东西` };
      }
      // A run the FRONT END owns has no process to kill — that is `abandon`'s job,
      // and routing it here would ask the backend about an id it never minted.
      const backendOwned = typeof r.runId === "string" && r.runId.startsWith("run-");
      if (!backendOwned) return self.abandon(runId, "创作者取消了这次运行");
      const at = now();
      // park it in `cancelling` FIRST, so the row stops offering 「取消」 twice while
      // the request is in flight
      skillrun.cancelRun(docs.runs(), runId, at, "创作者取消了这次运行");
      persist();
      refresh();
      const res = await runtime.cancelRun(r.runId, r.projectId || null);
      // `docs.runs()` is re-read after the await for the same reason §5.14 records:
      // a project loaded while the request was in flight replaces the registry
      // binding, and a hoisted value would settle the ABANDONED project's record.
      if (res.ok) {
        skillrun.confirmCancelled(docs.runs(), runId, now());
        persist();
        refresh();
        return { ok: true };
      }
      // NOT cancelled. The record stays open and says why — never a fabricated
      // terminal state. `finished` is not a failure of the cancel: the run simply
      // produced its real result first, and that result is the truth.
      persist();
      refresh();
      return {
        ok: false,
        error: res.finished
          ? res.detail
          : `未能确认终止：${res.detail}。这次运行仍停在「取消中」，不会被标成已取消。`,
        finished: !!res.finished,
      };
    },
    abandon: async (runId, reason = "创作者放弃了这次运行") => {
      const r = skillrun.findRun(docs.runs(), runId);
      if (!r) return { ok: false, error: "运行记录不存在" };
      if (!skillrun.isOpen(r)) {
        return { ok: false, error: `这次运行已经是「${r.status}」，不需要放弃` };
      }
      // ABANDON IS A CANCEL, not a failure (系统合同 §5.2 迁移表). Nothing went
      // wrong — the creator chose to stop. Recording it as `failed` put a real
      // decision into the same bucket as a crashed executor.
      // ONLY runs this page owns. A run executed by a local executor is owned
      // by the BACKEND, and stopping it means terminating a real process — which
      // only `POST /api/runs/<id>/cancel` can do. Marking it `cancelled` here
      // would put 「已取消」 on screen while the executor keeps running and
      // keeps spending (codex review, round 7).
      if (r.executor && r.executor !== "manual") {
        return {
          ok: false,
          error: `这次运行由「${r.executor}」执行，请用「取消运行」终止它——放弃只用于手工运行`,
        };
      }
      // A MANUAL RUN CAN STILL BE THE BACKEND'S. The manual fallback creates a
      // durable Run in `awaiting_input`, so settling it only on the canvas left
      // the two sides permanently disagreeing — and reconciliation would then
      // read the backend's still-open state (codex review, round 20).
      //
      // So the backend is asked first. A 404 means it never knew this run
      // (local/demo mode, or a purely front-end record), which is the case the
      // canvas genuinely owns; anything else must succeed there before it is
      // recorded here.
      // WHO OWNS THIS RUN is decided from what we know, not from a 404 (codex
      // review, round 23). A record that never reached the backend has no
      // `runId` of the backend's minting; anything else must be settled THERE
      // first, because only the backend can stop a real process.
      // A BACKEND-MINTED id starts with `run-`; the front end's own runs carry
      // a `skillrun-` id it minted itself and the backend has never heard of.
      // That is the knowable difference — not a 404.
      if (typeof r.runId === "string" && r.runId.startsWith("run-")) {
        const backend = await runtime.cancelRun(r.runId, r.projectId || null);
        if (!backend.ok && !backend.unknown) {
          return { ok: false, error: `后端未能取消这次运行：${backend.detail}` };
        }
      }
      const at = now();
      // read AFTER the await, never hoisted (§5.14)
      skillrun.cancelRun(docs.runs(), runId, at, reason);
      // …AND IT MUST REACH A TERMINAL STATE HERE.
      //
      // `cancelRun` parks a `running` record in `cancelling`, which is correct
      // when a real process has to be signalled and confirmed dead. This path
      // has no such process: these are runs the FRONT END owns (a manual run
      // waiting for an answer, or one whose page was closed mid-flight), so
      // nothing would ever arrive to complete the transition and the run would
      // sit in `cancelling` forever — reintroducing the exact stuck-open run
      // this control was added to clear (codex review, round 1).
      //
      // Confirming here is not the pretence §5.4 rule 3 forbids: that rule is
      // about claiming a SUBPROCESS died without checking. A backend-owned run
      // is cancelled through `POST /api/runs/<id>/cancel`, which does the real
      // termination and only then reports `cancelled`.
      skillrun.confirmCancelled(docs.runs(), runId, at);
      persist();
      refresh();
      return { ok: true };
    },
  };
  return self;
}
