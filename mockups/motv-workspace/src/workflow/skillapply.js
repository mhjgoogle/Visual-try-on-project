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
  "prompt-director": {
    can: true, target: "prompt", label: "应用为 Prompt 新版本",
    detail: "存成这个镜头 Prompt 的新版本；旧版本保留，可回切。",
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
    return { ok: true, actions: binds.map((b) => ({ action: "replaceReference", ...b })) };
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
  return { ok: false, error: `「${skillId}」的应用路径未实现` };
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
