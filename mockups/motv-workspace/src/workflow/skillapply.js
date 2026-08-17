// Applying a Skill Proposal to canon (ADR-0061 决策 3 / 决策 9).
//
//   Skill Run → Proposal → [应用 | 用于生成 | 忽略]
//
// This module answers exactly two questions and nothing else:
//
//   1. CAN this skill's proposal be written back at all, and to what?
//   2. WHAT would that write be, expressed as domain actions?
//
// It never writes. The caller performs the actions through the ordinary ctx
// controllers, so a proposal cannot reach a document through a second path that
// skips the guards the normal editing path enforces.
//
// HONESTY RULE (ADR-0061 「No Fake AI」): a skill whose answer has no canonical
// target says so. `continuity-reviewer` produces findings for a human to act on;
// there is no document called "the continuity verdict", and inventing one so the
// button is never greyed out would be a lie dressed as a feature. Those skills
// report `can: false` with the real reason and stay READ-ONLY advice.
//
// Pure — no fetch, no DOM, no clock, no ctx.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");

/** What 「应用」 means for each skill, or why it means nothing.
 *
 *  `target` names the canonical surface the write lands on — it is shown to the
 *  creator BEFORE they press the button, because 「应用」 with no statement of
 *  where is a request to trust an unnamed mutation. */
export const APPLY_TARGETS = {
  "story-development": {
    can: true, target: "story", label: "应用为故事大纲提案",
    detail: "落到「故事大纲」的提案位；成为正式版本仍需你在那里批准。",
  },
  "script-writer": {
    can: true, target: "script", label: "应用为本集剧本提案",
    detail: "落到本集剧本的提案位；应用后才创建新版本，旧版本全部保留。",
  },
  "script-doctor": {
    can: true, target: "script", label: "应用为本集剧本提案",
    detail: "落到本集剧本的提案位；应用后才创建新版本，旧版本全部保留。",
  },
  "script-breakdown": {
    can: true, target: "bible", label: "应用为人物 / 场景地提案",
    detail: "逐条确认，绝不覆盖已确认的档案。",
  },
  "storyboard-director": {
    can: true, target: "shots", label: "应用为新的分镜版本",
    detail: "存成新的草稿版本；当前版本保留，可随时回切。",
  },
  cinematography: {
    can: true, target: "shots", label: "应用为新的分镜版本（补运镜 / 景别）",
    detail: "只改这些镜头的设计字段，存成新的草稿版本。",
  },
  "reference-planner": {
    can: true, target: "references", label: "应用参考绑定",
    detail: "只绑定已经存在的参考资产；提案里指向不存在资产的条目会被跳过并报告。",
  },
  // --- TASK-067 §4 / §7 / §8 / §9 / §10 ----------------------------------- //
  "shot-asset-recommender": {
    can: true, target: "references", label: "应用推荐的参考绑定",
    detail: "按每条推荐绑定（或替换）这一镜的参考，并写下你为它选的用途；" +
      "指向不存在资产的条目会被跳过并报告。",
  },
  "image-prompt-director": {
    can: true, target: "prompt", label: "应用为 Image Prompt 新版本",
    detail: "存成这个镜头 Image Prompt 的新版本；旧版本保留，可回切。锁定的 Prompt 不会被覆盖。",
  },
  "video-prompt-director": {
    can: true, target: "prompt", label: "应用为 Video Prompt 新版本",
    detail: "存成这个镜头 Video Prompt 的新版本；旧版本保留，可回切。锁定的 Prompt 不会被覆盖。",
  },
  "prompt-reviewer": {
    // APPLICABLE ONLY WHEN IT OFFERED A REWRITE. A review whose issues have no
    // `suggestedText` is advice: there is nothing to write, and a button that
    // wrote 「问题列表」 into the Prompt would be worse than no button. `planApply`
    // therefore refuses that case with the real reason.
    can: true, target: "prompt", label: "应用审核建议的 Prompt",
    detail: "只有当审核给出了完整的改写版本时才能应用；应用后成为新版本，旧版本保留。" +
      "只有问题列表、没有改写建议时，这里不会伪造一次写入。",
  },
  "shot-continuity-reviewer": {
    can: false,
    reason: "这是一份连续性审阅结论，不是某个文档的新内容。没有「连续性」这份 canonical 文档可写——" +
      "按条目去改对应的镜头、状态、参考或首尾帧。",
  },
  "prompt-director": {
    can: true, target: "prompt", label: "应用为 Prompt 新版本",
    detail: "存成这个镜头 Prompt 的新版本；旧版本保留，可回切。",
  },
  "reference-interpreter": {
    can: true, target: "refInterp", label: "应用为参考解读新版本",
    detail: "存成每个参考「解读」的新版本；旧解读保留，锁定过的解读不会被覆盖。",
  },
  "editing-director": {
    can: true, target: "timeline", label: "应用剪辑调整",
    detail: "逐条改动本集时间线上的片段（修剪 / 顺序 / 换版本 / 转场）。锁定的片段会被跳过并报告。",
  },
  "sound-designer": {
    can: true, target: "audio", label: "应用声音调整",
    detail: "改动音量 / 对位 / 淡入淡出。镜头层与本集层分别定位；锁定的片段会被跳过并报告。",
  },
  "subtitle-reviewer": {
    can: true, target: "subtitles", label: "应用字幕修正",
    detail: "改动字幕文本 / 时间 / 说话人；锁定的 cue 会被跳过并报告。",
  },
  "relationship-director": {
    can: true, target: "relationships", label: "应用为人物关系",
    detail: "逐条建立 / 修改人物关系定义；指向不存在人物的条目会被跳过并报告。已锁定的关系不会被覆盖。",
  },
  "world-director": {
    can: true, target: "world", label: "应用为世界观",
    detail: "逐条写入世界观档案的对应项（时代 / 规则 / 社会 / 区域 / 地点 / 视觉基调 / 氛围）。不认识的项会被跳过并报告；没有被提到的项一个字都不动。",
  },
  "continuity-reviewer": {
    can: false,
    reason: "这是一份审阅结论，不是某个文档的新内容。没有「连续性」这份 canonical 文档可写——按条目自己去改对应的镜头或设定。",
  },
  "asset-librarian": {
    can: false,
    reason: "这是复用建议。真正的写入是「绑定到镜头」——在左侧参考面板里逐条决定，这里不批量改绑定。",
  },
};

/** Whether a proposal from this skill can be written back, and to what. An
 *  unknown skill is refused rather than assumed applicable: a capability nobody
 *  wrote an applier for must not silently do nothing while reporting success. */
export function applicability(skillId) {
  const t = APPLY_TARGETS[skillId];
  if (!t) {
    return { can: false, reason: `「${skillId}」还没有写回路径——这次运行只能阅读或用于生成。` };
  }
  return t;
}

/**
 * Whether THIS PARTICULAR proposal can be written back (TASK-067 §2).
 *
 * `applicability` answers a question about the CAPABILITY, which is all the panel
 * could ask before a run exists. But for some capabilities the answer genuinely
 * depends on the answer that came back, and offering 「应用」 for a proposal that
 * `planApply` will refuse is exactly the button-that-pretends this round is
 * supposed to remove: the creator presses it and gets an error for a decision the
 * panel should never have offered.
 *
 * Caught by the Connected acceptance on the real project: a Prompt Review that
 * lists issues WITHOUT a rewrite has nothing to write, and the panel showed 应用
 * anyway.
 *
 * Falls back to the static answer whenever there is no proposal to judge, so a
 * caller that has only a skillId keeps today's behaviour.
 */
export function applicabilityFor(skillId, proposal) {
  const base = applicability(skillId);
  if (!base.can || !isObj(proposal)) return base;
  if (skillId === "prompt-reviewer" && !str(proposal.suggestedText).trim()) {
    return {
      can: false,
      target: base.target,
      reason: "这次审核只给了问题列表，没有给出完整的改写版本——按条目自己改，或让 Prompt Director 重写一版。",
    };
  }
  return base;
}

/**
 * Translate a validated proposal into the domain actions that would apply it.
 *
 * Returns `{ ok: true, actions: [...] }` where every action is
 * `{ action: <name>, ...args }` from the ADR-0061 决策 9 Action Layer vocabulary,
 * or `{ ok: false, error }`.
 *
 * `scope` carries what the run was about — `{ shotId }` for a shot-scoped skill.
 * Nothing here guesses a scope: a shot-scoped proposal with no shot is refused,
 * because writing it to "whatever shot is selected now" would attribute the
 * answer to a context the run never read.
 */
export function planApply(skillId, proposal, scope = {}) {
  const app = applicability(skillId);
  if (!app.can) return { ok: false, error: app.reason };
  if (!isObj(proposal)) return { ok: false, error: "这次运行没有可应用的结构化提案" };

  if (skillId === "story-development") {
    return { ok: true, actions: [{ action: "proposeOutline", proposal }] };
  }
  if (skillId === "script-writer" || skillId === "script-doctor") {
    const text = str(proposal.script) || str(proposal.revisedScript) || str(proposal.text);
    if (!text.trim()) return { ok: false, error: "提案里没有剧本正文" };
    return { ok: true, actions: [{ action: "proposeScript", text }] };
  }
  if (skillId === "script-breakdown") {
    return { ok: true, actions: [{ action: "proposeBible", proposal }] };
  }
  if (skillId === "storyboard-director") {
    const shots = collectShots(proposal);
    if (!shots.length) return { ok: false, error: "提案里没有镜头" };
    return { ok: true, actions: [{ action: "replaceShotDraft", shots }] };
  }
  if (skillId === "cinematography") {
    const patches = collectShotPatches(proposal);
    if (!patches.length) return { ok: false, error: "提案里没有可应用到镜头的设计字段" };
    return { ok: true, actions: [{ action: "patchShots", patches }] };
  }
  if (skillId === "reference-planner") {
    const binds = collectBindings(proposal);
    if (!binds.length) return { ok: false, error: "提案里没有可绑定的参考" };
    // `addReference`, not `replaceReference` (TASK-067 §12): this is what it always
    // actually did — the old `replaceReference` only ever added, and now that the
    // vocabulary has a real swap, this caller must name the one it means.
    return { ok: true, actions: binds.map((b) => ({ action: "addReference", ...b })) };
  }
  if (skillId === "shot-asset-recommender") {
    const shotId = str(scope.shotId);
    if (!shotId) {
      return { ok: false, error: "这次运行没有记录它针对哪个镜头，所以绑定无处可写——重新在某个镜头上运行" };
    }
    // ADR-0064 决策 4 是 ENFORCED HERE, not merely stated in the prompt. The candidate
    // set is what the run was allowed to pick from; without checking it, the only
    // remaining guard is 「这个 key 在注册表里存在」 — which happily binds ANY registered
    // asset, including a different character's portrait, on a model's word.
    //
    // `candidateKeys` comes from the RUN's own recorded trace, not from a fresh
    // retrieval: the question is what this answer was allowed to say, and that was
    // fixed when the run was launched.
    // FAIL CLOSED when the run recorded no candidate set.
    //
    // The first version treated a missing list as 「no constraint」 and applied
    // everything, which turned the guard into a fail-OPEN: a legacy run (one created
    // before the trace carried `candidateKeys`) or a malformed one could bind any
    // registered reference at all — exactly the boundary this check exists to hold
    // (codex review round 2). A run whose permission cannot be checked is refused,
    // and re-running it is cheap.
    if (!Array.isArray(scope.candidateKeys)) {
      return {
        ok: false,
        error: "这次运行没有记录它当时看到的候选集，无法校验推荐是否越界——重新运行一次「推荐参考资产」再应用",
      };
    }
    const allowed = new Set(scope.candidateKeys);
    const all = collectRecommendations(proposal);
    const recs = all.filter((r) => allowed.has(r.referenceKey));
    const offCandidate = all.length - recs.length;
    if (!recs.length) {
      return {
        ok: false,
        error: all.length
          ? `提案推荐的 ${all.length} 个参考都不在这次运行看到的候选集里——不予绑定（模型只能从候选里挑）`
          : "提案里没有可应用的推荐（每条都要有 referenceKey 和理由）",
      };
    }
    const out = [];
    for (const r of recs) {
      // A recommendation that names what it REPLACES is a swap; one that does not is
      // an addition. Two different actions, each with its own guard — collapsing
      // them would need a second implementation of the swap's use-side carry-over.
      out.push(r.replacesKey
        ? { action: "replaceReference", shotId, referenceKey: r.referenceKey, replacesKey: r.replacesKey }
        : { action: "addReference", shotId, referenceKey: r.referenceKey });
      // …and the side the recommender said it should serve, as its own POINTER-class
      // action. Emitted only when the answer stated one: defaulting it would
      // overwrite a derivation the creator never asked to change.
      if (r.use) out.push({ action: "setReferenceUse", shotId, referenceKey: r.referenceKey, use: r.use });
    }
    // DROPPED ITEMS ARE REPORTED, never silently omitted: 「应用了 2 条」 about a
    // 3-item proposal has to say what happened to the third.
    return offCandidate
      ? { ok: true, actions: out, dropped: `${offCandidate} 条推荐不在候选集里，已跳过` }
      : { ok: true, actions: out };
  }
  if (skillId === "image-prompt-director" || skillId === "video-prompt-director") {
    const text = str(proposal.prompt);
    if (!text.trim()) return { ok: false, error: "提案里没有 Prompt 正文" };
    const shotId = str(scope.shotId);
    if (!shotId) {
      return { ok: false, error: "这次运行没有记录它针对哪个镜头，所以 Prompt 无处可写——重新在某个镜头上运行" };
    }
    // The KIND comes from the CAPABILITY, not from `scope.genKind`. An Image Prompt
    // Director's answer is an image prompt no matter which tab happens to be open,
    // and letting the UI's current tab decide would write a video prompt into the
    // image slot (or the reverse) with no way to tell afterwards.
    return {
      ok: true,
      actions: [{ action: "updatePrompt", shotId, kind: skillId === "video-prompt-director" ? "video" : "image", text }],
    };
  }
  if (skillId === "prompt-reviewer") {
    const text = str(proposal.suggestedText);
    if (!text.trim()) {
      return {
        ok: false,
        error: "这次审核只给了问题列表，没有给出完整的改写版本——按条目自己改，或让 Prompt Director 重写一版",
      };
    }
    const shotId = str(scope.shotId);
    if (!shotId) {
      return { ok: false, error: "这次运行没有记录它针对哪个镜头，所以 Prompt 无处可写——重新在某个镜头上运行" };
    }
    // WHICH prompt was reviewed is recorded on the run's own scope (`reviewKind`),
    // because that is what the context builder actually handed the reviewer. Reading
    // the currently-open tab instead would apply an image review to the video prompt.
    return {
      ok: true,
      actions: [{ action: "updatePrompt", shotId, kind: scope.reviewKind === "video" ? "video" : "image", text }],
    };
  }
  if (skillId === "prompt-director") {
    const text = str(proposal.prompt) || str(proposal.imagePrompt) || str(proposal.text);
    if (!text.trim()) return { ok: false, error: "提案里没有 Prompt 正文" };
    const shotId = str(scope.shotId);
    if (!shotId) {
      return { ok: false, error: "这次运行没有记录它针对哪个镜头，所以 Prompt 无处可写——重新在某个镜头上运行" };
    }
    return {
      ok: true,
      actions: [{ action: "updatePrompt", shotId, kind: scope.genKind === "video" ? "video" : "image", text }],
    };
  }
  if (skillId === "reference-interpreter") {
    const readings = collectReadings(proposal);
    if (!readings.length) return { ok: false, error: "提案里没有可写入的参考解读（每条都要有 referenceKey 和至少一个轴）" };
    return { ok: true, actions: readings.map((r) => ({ action: "updateInterpretation", ...r })) };
  }
  if (skillId === "relationship-director") {
    const props = collectRelationships(proposal);
    if (!props.length) {
      return { ok: false, error: "提案里没有可写入的人物关系（每条都要指名两个不同的 characterId，并至少写一个字段）" };
    }
    return { ok: true, actions: props.map((p) => ({ action: "upsertRelationship", ...p })) };
  }

  if (skillId === "world-director") {
    const fields = collectWorldFields(proposal);
    const skipped = unknownWorldFields(proposal);
    if (!Object.keys(fields).length) {
      return {
        ok: false,
        error: skipped.length
          ? `提案里没有一条落在世界观档案的七项里（它写的是：${skipped.join("、")}）`
          : "提案里没有可写入的世界观条目（每条都要写 field + value，且 field 必须是世界观档案的七项之一）",
      };
    }
    // ONE ACTION, not one per facet: the seven facets are ONE canonical document,
    // and七 separate writes would each re-render and each be separately
    // revertible — a half-applied world setting is a state nobody asked for.
    //
    // `skipped` TRAVELS WITH THE PLAN so the caller can SAY what it dropped
    // (codex review, 批次 F2 round 1). `collectWorldFields` silently ignores a facet
    // name this document does not have — which is right, it must not reach canon —
    // but silently is only acceptable if something downstream reports it. Without
    // this the comment above claimed a report that no code produced.
    return { ok: true, actions: [{ action: "updateWorldSetting", fields }], skipped };
  }
  if (skillId === "editing-director") {
    const acts = collectEdits(proposal);
    if (!acts.length) return { ok: false, error: "提案里没有可应用的剪辑调整（每条都要有 clipId 和至少一项改动）" };
    // A VERSION SWAP IS BOUNDED BY WHAT THE RUN SAW (TASK-072 §1.9 缺陷 8).
    //
    // The dispatcher only checks that the asset exists and suits the track, so
    // without this an injected or hallucinated `replaceWithAssetId` could put ANY
    // registered video in the project onto any clip — a different scene's take,
    // another episode's footage — and it would apply cleanly and persist.
    //
    // The permission is the alternatives list this run was actually given, read
    // from its own recorded trace. FAIL CLOSED, for the same reason
    // `candidateKeys` does: a run whose permission cannot be checked (a legacy
    // record, a malformed trace) is refused rather than trusted, and re-running is
    // cheap. Non-swap edits (trim / order / transition / remove) name no asset and
    // are unaffected.
    const swaps = acts.filter((x) => x.action === "replaceTimelineAsset");
    if (swaps.length) {
      const allowed = scope.timelineAlternatives;
      if (allowed == null || typeof allowed !== "object" || Array.isArray(allowed)) {
        return {
          ok: false,
          error: "这次运行没有记录它当时看到的可替换版本，无法校验「换成哪一版」是否越界"
            + "——重新运行一次「剪辑导演」再应用",
        };
      }
      const ok = (x) => {
        const list = Object.prototype.hasOwnProperty.call(allowed, x.clipId) ? allowed[x.clipId] : null;
        return Array.isArray(list) && list.includes(x.assetId);
      };
      const kept = acts.filter((x) => x.action !== "replaceTimelineAsset" || ok(x));
      const dropped = swaps.length - kept.filter((x) => x.action === "replaceTimelineAsset").length;
      if (!kept.length) {
        return {
          ok: false,
          error: `提案要换的 ${swaps.length} 条素材都不在这次运行看到的可替换版本里——不予替换`,
        };
      }
      // DROPPED ITEMS ARE REPORTED, never silently omitted.
      return dropped
        ? { ok: true, actions: kept, dropped: `${dropped} 条版本替换不在这次运行看到的候选里，已跳过` }
        : { ok: true, actions: kept };
    }
    return { ok: true, actions: acts };
  }
  if (skillId === "sound-designer") {
    const acts = collectSoundAdjustments(proposal);
    if (!acts.length) return { ok: false, error: "提案里没有可应用的声音调整（每条都要有 layer、clipId 和至少一项改动）" };
    return { ok: true, actions: acts };
  }
  if (skillId === "subtitle-reviewer") {
    const acts = collectSubtitleFixes(proposal);
    if (!acts.length) return { ok: false, error: "提案里没有可应用的字幕修正（每条都要有 cueId 和至少一项改动）" };
    return { ok: true, actions: acts };
  }
  return { ok: false, error: `「${skillId}」的应用路径未实现` };
}

/** Reference readings out of a reference-interpreter proposal. A reading that
 *  answers no axis is dropped: it would append an empty version and make
 *  「已解读」 true of a reference nobody read (workflow/refinterp.js refuses it
 *  anyway; dropping it here means the count reported to the creator is right). */
function collectReadings(proposal) {
  const AXES = ["cameraLanguage", "movement", "performance", "composition", "lighting", "pacing"];
  const out = [];
  for (const r of Array.isArray(proposal.readings) ? proposal.readings : []) {
    if (!isObj(r)) continue;
    const referenceKey = str(r.referenceKey);
    if (!referenceKey) continue; // unaddressable — never applied to a neighbour
    const axes = {};
    for (const k of AXES) if (typeof r[k] === "string" && r[k].trim()) axes[k] = r[k].trim();
    if (!Object.keys(axes).length) continue;
    out.push({ referenceKey, axes });
  }
  return out;
}

/**
 * Relationship proposals out of a relationship-director answer (TASK-065 §2).
 *
 * TWO REFUSALS, both deliberate:
 *
 *   · a pair that does not name TWO DIFFERENT characterIds is dropped. The pair IS
 *     the relationship's identity, so a proposal that cannot state it has nothing
 *     to be applied to — and picking a plausible second character would write
 *     relationship canon about someone the model never mentioned.
 *   · a proposal with no non-empty facet is dropped. `upsertRelationship` would
 *     otherwise create an empty definition, and 「已定义」 would become true of a
 *     pair nobody described.
 *
 * The characterIds are NOT verified here — this module never sees the documents.
 * The dispatcher checks them against `production.characters` and skips (and
 * reports) the ones that do not resolve, exactly like `replaceReference` does for
 * a reference key.
 */
function collectRelationships(proposal) {
  const FACETS = [
    "basis", "aToB", "bToA", "coreConflict", "tension", "power",
    "history", "secrets", "direction", "arc", "forbidden",
  ];
  const out = [];
  for (const p of Array.isArray(proposal.proposals) ? proposal.proposals : []) {
    if (!isObj(p)) continue;
    const a = str(p.aCharacterId).trim();
    const b = str(p.bCharacterId).trim();
    if (!a || !b || a === b) continue;
    const fields = {};
    for (const k of FACETS) if (typeof p[k] === "string" && p[k].trim()) fields[k] = p[k].trim();
    if (!Object.keys(fields).length) continue;
    out.push({ aCharacterId: a, bCharacterId: b, fields, reason: str(p.reason).trim() || null });
  }
  return out;
}

/**
 * The world facets a `world-director` proposal really carries (TASK-090 §2.4).
 *
 * ONLY THE SEVEN THAT EXIST. An answer naming `magicSystem` is not a facet of this
 * document, and writing it would put a key nothing reads into canon while the
 * creator believed they had accepted a world rule. Unknown names are dropped here;
 * the panel reports what it skipped, so a refused entry is visible rather than
 * silently missing.
 *
 * LAST NON-EMPTY WINS per facet: two proposals for `rules` are two opinions about
 * one field, and the alternative — concatenating them — would invent a value
 * neither the model nor the creator wrote.
 */
function collectWorldFields(proposal) {
  const FACETS = new Set([
    "era", "rules", "society", "regions", "places", "visualTone", "atmosphere",
  ]);
  const fields = {};
  for (const p of Array.isArray(proposal.proposals) ? proposal.proposals : []) {
    if (!isObj(p)) continue;
    const field = str(p.field).trim();
    const value = str(p.value).trim();
    if (!FACETS.has(field) || !value) continue;
    fields[field] = value;
  }
  return fields;
}

/** Which facet names a world proposal named that this document does not have —
 *  so the panel can SAY what it skipped instead of dropping it in silence. */
export function unknownWorldFields(proposal) {
  const FACETS = new Set([
    "era", "rules", "society", "regions", "places", "visualTone", "atmosphere",
  ]);
  const out = [];
  for (const p of Array.isArray(proposal && proposal.proposals) ? proposal.proposals : []) {
    if (!isObj(p)) continue;
    const field = str(p.field).trim();
    if (field && !FACETS.has(field) && !out.includes(field)) out.push(field);
  }
  return out;
}

const TRANSITIONS = new Set(["cut", "dissolve", "dip"]);

/**
 * Timeline edits out of an editing-director proposal, as Action Layer envelopes.
 *
 * ONE proposal entry can become SEVERAL actions (a trim and a transition are two
 * different mutations), and each goes through its own dispatcher case with its
 * own guard. Emitting one combined "editClip" action would have needed a second
 * implementation of every guard.
 *
 * A `remove` entry emits ONLY the removal: also trimming a clip that is being
 * taken out of the cut is work applied to something the creator will not see, and
 * it would report as two successes for one decision.
 */
function collectEdits(proposal) {
  const out = [];
  for (const e of Array.isArray(proposal.edits) ? proposal.edits : []) {
    if (!isObj(e)) continue;
    const clipId = str(e.clipId);
    if (!clipId) continue;
    if (e.remove === true) { out.push({ action: "removeTimelineClip", clipId }); continue; }
    if (Number.isFinite(e.trimInMs) && Number.isFinite(e.trimOutMs) && e.trimOutMs > e.trimInMs) {
      out.push({ action: "trimTimelineClip", clipId, inMs: e.trimInMs, outMs: e.trimOutMs });
    }
    if (str(e.replaceWithAssetId)) {
      out.push({ action: "replaceTimelineAsset", clipId, assetId: str(e.replaceWithAssetId) });
    }
    if (Number.isInteger(e.index) && e.index >= 0) {
      out.push({ action: "moveTimelineClip", clipId, index: e.index });
    }
    if (TRANSITIONS.has(str(e.transition))) {
      out.push({
        action: "setTransition",
        clipId,
        kind: str(e.transition),
        durationMs: Number.isFinite(e.transitionMs) ? e.transitionMs : 500,
      });
    }
  }
  return out;
}

/**
 * Sound adjustments, as Action Layer envelopes.
 *
 * `layer` decides which document is addressed, and it is REQUIRED: the shot's
 * audio arrangement and the episode timeline are two clip namespaces, and an
 * adjustment that did not say which one it meant would land wherever the first
 * lookup happened to hit. An unknown layer is skipped, never guessed.
 *
 * GAIN UNITS. The proposal speaks dB, always, because that is the unit a sound
 * designer thinks in and mixing two units in one schema is how a −4 dB note
 * becomes a ×−4 multiplier. The shot layer stores dB natively; the timeline
 * stores LINEAR volume, so the dispatcher converts there — see app.js. This
 * module carries `gainDb` through unchanged and never converts, so there is one
 * conversion in the system rather than one per call site.
 */
function collectSoundAdjustments(proposal) {
  const out = [];
  for (const a of Array.isArray(proposal.adjustments) ? proposal.adjustments : []) {
    if (!isObj(a)) continue;
    const clipId = str(a.clipId);
    const layer = str(a.layer);
    if (!clipId || (layer !== "shot" && layer !== "episode")) continue;
    if (Number.isFinite(a.gainDb)) {
      out.push(layer === "shot"
        ? { action: "setGain", shotId: null, clipId, gain: a.gainDb, gainIsDelta: true }
        : { action: "setTimelineVolume", clipId, volume: null, gainDb: a.gainDb });
    }
    if (Number.isFinite(a.fadeInMs) || Number.isFinite(a.fadeOutMs)) {
      const fi = Number.isFinite(a.fadeInMs) ? a.fadeInMs : null;
      const fo = Number.isFinite(a.fadeOutMs) ? a.fadeOutMs : null;
      // BOTH LAYERS (TASK-072 §1.9 缺陷 9). Only the shot layer was emitted, so a
      // perfectly legal episode-layer fade — 「本集 BGM 结尾淡出 2 秒」 — was
      // silently discarded while the surface reported the proposal applied.
      out.push(layer === "shot"
        ? { action: "setFade", shotId: null, clipId, fadeInMs: fi, fadeOutMs: fo }
        : { action: "setTimelineFade", clipId, fadeInMs: fi, fadeOutMs: fo });
    }
    if (Number.isFinite(a.offsetMs) && layer === "shot") {
      // an offset is only meaningful against the clip's CURRENT timing, which
      // the dispatcher reads — the proposal states the shift, not the result
      out.push({ action: "moveAudioClip", shotId: null, clipId, timing: { offsetDeltaMs: a.offsetMs } });
    }
    if (typeof a.muted === "boolean" && layer === "shot") {
      out.push({ action: "setAudioMuted", shotId: null, clipId, muted: a.muted });
    }
  }
  return out;
}

/** Subtitle fixes, as `updateSubtitle` envelopes. A merge is its own field on
 *  the fields bag rather than a separate action name, because the dispatcher
 *  performs it through the same cue write path and the same lock check. */
function collectSubtitleFixes(proposal) {
  const out = [];
  for (const f of Array.isArray(proposal.fixes) ? proposal.fixes : []) {
    if (!isObj(f)) continue;
    const cueId = str(f.cueId);
    if (!cueId) continue;
    const fields = {};
    if (typeof f.text === "string" && f.text.trim()) fields.text = f.text;
    if (Number.isFinite(f.startMs)) fields.startMs = f.startMs;
    if (Number.isFinite(f.endMs)) fields.endMs = f.endMs;
    if (typeof f.speaker === "string" && f.speaker.trim()) fields.speaker = f.speaker;
    if (f.mergeWithNext === true) fields.mergeWithNext = true;
    if (!Object.keys(fields).length) continue;
    out.push({ action: "updateSubtitle", cueId, fields });
  }
  return out;
}

/** Shots out of a storyboard proposal, in the shape ctx.shots.saveEdit takes.
 *  Only fields the proposal really carries are copied — an absent field is left
 *  absent so `normalizeShots` supplies its own default rather than this module
 *  inventing 「中景」 for every shot the model did not describe. */
function collectShots(proposal) {
  const raw = Array.isArray(proposal.shots)
    ? proposal.shots
    : Array.isArray(proposal.scenes)
      ? proposal.scenes.flatMap((s) => (Array.isArray(s.shots) ? s.shots : []))
      : [];
  const out = [];
  for (const s of raw) {
    if (!isObj(s)) continue;
    const item = {};
    for (const k of ["title", "description", "shotSize", "angle", "cameraMotion", "action", "expression", "emotion", "dialogue"]) {
      if (typeof s[k] === "string" && s[k]) item[k] = s[k];
    }
    if (Number.isFinite(s.duration_seconds)) item.duration_seconds = s.duration_seconds;
    else if (Number.isFinite(s.duration)) item.duration_seconds = s.duration;
    if (!item.title && !item.description) continue; // nothing usable
    out.push(item);
  }
  return out;
}

/** Per-shot design patches out of a cinematography proposal. Each patch names
 *  the shot by its CANONICAL id: matching by position would silently apply
 *  「Shot 3 的运镜」 to a different shot after any draft edit. */
function collectShotPatches(proposal) {
  const raw = Array.isArray(proposal.shots) ? proposal.shots : [];
  const out = [];
  for (const s of raw) {
    if (!isObj(s)) continue;
    const shotId = str(s.shotId);
    if (!shotId) continue; // unaddressable — skipped, never applied by position
    const fields = {};
    for (const k of ["shotSize", "angle", "cameraMotion", "action", "expression", "emotion"]) {
      if (typeof s[k] === "string" && s[k]) fields[k] = s[k];
    }
    if (Number.isFinite(s.duration_seconds)) fields.duration_seconds = s.duration_seconds;
    if (!Object.keys(fields).length) continue;
    out.push({ shotId, fields });
  }
  return out;
}

/**
 * Recommendations out of a shot-asset-recommender answer (TASK-067 §4).
 *
 * THREE REFUSALS, all deliberate:
 *
 *   · no `referenceKey` → unaddressable. There is nothing to bind, and picking a
 *     plausible reference would bind an asset the model never named.
 *   · no `reason` → the schema requires one, and a recommendation the creator cannot
 *     evaluate is not a recommendation. Dropped here so the count reported is right.
 *   · a `use` the vocabulary does not contain → dropped rather than coerced. The
 *     dispatcher would refuse it anyway (only the sides a compiler really reads are
 *     allowed for a given role), and coercing it to a default would silently change
 *     a derivation the creator never touched.
 *
 * The keys are NOT verified here — this module never sees the registry. The
 * dispatcher checks them and skips (and reports) the ones that do not resolve,
 * exactly like `addReference` does. That is the second half of ADR-0064 决策 4: the
 * candidate set constrains what can be recommended, and this check constrains what
 * can be written.
 */
function collectRecommendations(proposal) {
  const USES = new Set(["image", "video", "both"]);
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(proposal.recommendations) ? proposal.recommendations : []) {
    if (!isObj(r)) continue;
    const referenceKey = str(r.referenceKey).trim();
    if (!referenceKey || !str(r.reason).trim()) continue;
    // the SAME reference twice is one decision, not two: the second would report a
    // spurious 「已满足」 and inflate the applied count
    if (seen.has(referenceKey)) continue;
    seen.add(referenceKey);
    const replacesKey = str(r.replacesKey).trim();
    out.push({
      referenceKey,
      // replacing ITSELF is not a swap — treated as a plain addition, which the
      // dispatcher then reports as already satisfied
      replacesKey: replacesKey && replacesKey !== referenceKey ? replacesKey : null,
      use: USES.has(str(r.use).trim()) ? str(r.use).trim() : null,
    });
  }
  return out;
}

/** Reference bindings out of a reference-planner proposal. */
function collectBindings(proposal) {
  const raw = Array.isArray(proposal.bindings)
    ? proposal.bindings
    : Array.isArray(proposal.plan) ? proposal.plan : [];
  const out = [];
  for (const b of raw) {
    if (!isObj(b)) continue;
    const shotId = str(b.shotId);
    const keys = Array.isArray(b.referenceKeys)
      ? b.referenceKeys.filter((k) => typeof k === "string" && k)
      : typeof b.referenceKey === "string" && b.referenceKey ? [b.referenceKey] : [];
    if (!shotId || !keys.length) continue;
    for (const key of keys) out.push({ shotId, referenceKey: key });
  }
  return out;
}
