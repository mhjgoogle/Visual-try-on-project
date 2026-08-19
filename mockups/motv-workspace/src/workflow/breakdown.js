// 剧本拆解 → 作品设定同步 (M8) — the AI-assisted Production Bible workflow.
//
// The agent reads the episode script and PROPOSES bible material: new
// Characters/Locations, updates to existing ones, and States suggested by
// story progression. Everything lands as a PROPOSAL the creator explicitly
// acts on (添加 / 并入已有 / 应用更新 / 忽略) — confirmed Bible entities are
// NEVER destructively overwritten by the sync:
//   - a NEW entity is only created on 添加/并入;
//   - 应用更新 writes exactly the fields the card shows as changed;
//   - 并入已有 fills ONLY empty fields on the chosen entity (a confirmed
//     non-empty value always wins over the proposal) and adds missing states.
//
// Pure module: parsing/sanitizing the agent payload, matching proposals
// against the current bible, computing per-entity changes, and deriving
// episode appearances from Scene references. No fetch, no DOM, no writes —
// application happens in the UI through the existing ctx.bible ops.

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x.trim().slice(0, 500) : "");

/** Normalize a name for matching: trim + collapse inner whitespace. Matching
 *  is deliberately conservative (exact normalized equality) — a wrong merge
 *  would corrupt a confirmed entity, a missed match only yields a NEW
 *  proposal the creator can 并入已有. Exported for the apply path (state
 *  dedup uses the same rule). */
export function normName(s) {
  // COLLAPSE inner whitespace to one space (never remove it entirely —
  // "Ann Marie" and "AnnMarie" are different names and must not collide
  // into a wrong update target)
  return String(s || "").trim().replace(/\s+/g, " ");
}

/** Sanitize the agent's raw breakdown payload into a well-shaped proposal
 *  set. Anything malformed is dropped (fail closed) — never guessed. */
export function parseBreakdown(payload) {
  const characters = [];
  const locations = [];
  const props = [];
  const states = (list) => {
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(list) ? list : []) {
      const name = str(isObj(s) ? s.name : s);
      // dedup by NORMALIZED name — "夜 晚" and "夜  晚" are one state
      if (!name || seen.has(normName(name))) continue;
      seen.add(normName(name));
      out.push({ name, reason: str(isObj(s) ? s.reason : "") });
      if (out.length >= 6) break;
    }
    return out;
  };
  if (isObj(payload)) {
    const seenC = new Set();
    for (const c of Array.isArray(payload.characters) ? payload.characters : []) {
      if (!isObj(c)) continue;
      const name = str(c.name);
      if (!name || seenC.has(normName(name))) continue;
      seenC.add(normName(name));
      characters.push({
        name,
        appearance: str(c.appearance),
        costume: str(c.costume),
        personality: str(c.personality),
        visualInstruction: str(c.visualInstruction),
        voiceDescription: str(c.voiceDescription),
        states: states(c.states),
        // 「这个人可能已经有参考图了」 — `script-breakdown` v2's answer to the asset
        // list it is now given (TASK-090 §2.2). A CLUE, not a binding: it is
        // displayed on the proposal card and resolved against the registry there,
        // so a wrong guess costs the creator a glance and nothing else. Attaching
        // the asset is a separate, explicit act.
        existingAssetKey: str(c.existingAssetKey),
      });
      if (characters.length >= 12) break;
    }
    const seenL = new Set();
    for (const l of Array.isArray(payload.locations) ? payload.locations : []) {
      if (!isObj(l)) continue;
      const name = str(l.name);
      if (!name || seenL.has(normName(name))) continue;
      seenL.add(normName(name));
      locations.push({
        name,
        description: str(l.description),
        visualInstruction: str(l.visualInstruction),
        states: states(l.states),
        existingAssetKey: str(l.existingAssetKey),
      });
      if (locations.length >= 12) break;
    }
    // 道具（script-breakdown v3 / TASK-095 §2.2）。**没有 states** —— 一把钥匙
    // 就是一把钥匙；它被折断是剧情事件，写进描述，不拆成两个道具
    //（同一条理由写在 `bibledoc.sanitizeProp` 上，两处指的是同一个决定）。
    const seenP = new Set();
    for (const it of Array.isArray(payload.props) ? payload.props : []) {
      if (!isObj(it)) continue;
      const name = str(it.name);
      if (!name || seenP.has(normName(name))) continue;
      seenP.add(normName(name));
      props.push({
        name,
        description: str(it.description),
        visualInstruction: str(it.visualInstruction),
        existingAssetKey: str(it.existingAssetKey),
      });
      if (props.length >= 12) break;
    }
  }
  return { characters, locations, props };
}

/** The field-level changes applying a character proposal to an entity would
 *  make. mode 'update': a proposed non-empty value that DIFFERS replaces;
 *  mode 'merge': only fields currently EMPTY are filled. States: proposed
 *  names not already on the entity (both modes — states are additive). */
export function characterChanges(entity, proposal, mode) {
  const fields = [];
  const map = [
    ["appearance", entity.profile.appearance, proposal.appearance],
    ["costume", entity.profile.costume, proposal.costume],
    ["personality", entity.profile.personality, proposal.personality],
    ["visualInstruction", entity.profile.visualInstruction, proposal.visualInstruction],
    ["voiceDescription", entity.voice.description, proposal.voiceDescription],
  ];
  for (const [key, cur, next] of map) {
    if (!next) continue;
    if (mode === "merge" ? !cur : cur !== next) fields.push({ key, from: cur, to: next });
  }
  const have = new Set(entity.states.map((s) => normName(s.name)));
  const states = proposal.states.filter((s) => !have.has(normName(s.name)));
  return { fields, states };
}

/** Same for a location proposal. */
export function locationChanges(entity, proposal, mode) {
  const fields = [];
  const map = [
    ["description", entity.profile.description, proposal.description],
    ["visualInstruction", entity.profile.visualInstruction, proposal.visualInstruction],
  ];
  for (const [key, cur, next] of map) {
    if (!next) continue;
    if (mode === "merge" ? !cur : cur !== next) fields.push({ key, from: cur, to: next });
  }
  const have = new Set(entity.states.map((s) => normName(s.name)));
  const states = proposal.states.filter((s) => !have.has(normName(s.name)));
  return { fields, states };
}

/** Same for a prop proposal. **No states**, so there is no state list to diff —
 *  and that difference is stated HERE rather than by passing an empty array
 *  around, because an empty `states` would read as 「这个道具的状态都已存在」. */
export function propChanges(entity, proposal, mode) {
  const fields = [];
  const map = [
    ["description", entity.profile.description, proposal.description],
    ["visualInstruction", entity.profile.visualInstruction, proposal.visualInstruction],
  ];
  for (const [key, cur, next] of map) {
    if (!next) continue;
    if (mode === "merge" ? !cur : cur !== next) fields.push({ key, from: cur, to: next });
  }
  return { fields, states: [] };
}

/** Match a parsed breakdown against the CURRENT bible. Returns proposal
 *  cards, each classified:
 *  - { kind:'new-character'|'new-location', proposal }               — no match
 *  - { kind:'update-character'|'update-location', proposal,
 *      entityId, entityName, changes }                               — matched
 *  A matched proposal with NO effective change is omitted (already in sync).
 *  Every card gets a stable index-based id for the transient review UI. */
export function matchProposals(prod, breakdown) {
  const out = [];
  let n = 0;
  for (const p of breakdown.characters) {
    const hit = (prod.characters || []).find((c) => normName(c.name) === normName(p.name));
    if (!hit) {
      out.push({ id: `bp-${++n}`, kind: "new-character", proposal: p });
    } else {
      const changes = characterChanges(hit, p, "update");
      if (changes.fields.length || changes.states.length) {
        out.push({ id: `bp-${++n}`, kind: "update-character", proposal: p, entityId: hit.characterId, entityName: hit.name, changes });
      }
    }
  }
  for (const p of breakdown.locations) {
    const hit = (prod.locations || []).find((l) => normName(l.name) === normName(p.name));
    if (!hit) {
      out.push({ id: `bp-${++n}`, kind: "new-location", proposal: p });
    } else {
      const changes = locationChanges(hit, p, "update");
      if (changes.fields.length || changes.states.length) {
        out.push({ id: `bp-${++n}`, kind: "update-location", proposal: p, entityId: hit.locationId, entityName: hit.name, changes });
      }
    }
  }
  for (const p of breakdown.props || []) {
    const hit = (prod.props || []).find((x) => normName(x.name) === normName(p.name));
    if (!hit) {
      out.push({ id: `bp-${++n}`, kind: "new-prop", proposal: p });
    } else {
      const changes = propChanges(hit, p, "update");
      if (changes.fields.length) {
        out.push({ id: `bp-${++n}`, kind: "update-prop", proposal: p, entityId: hit.propId, entityName: hit.name, changes });
      }
    }
  }
  return out;
}

/** Gate a card's DISPLAYED update against the CURRENT entity: only fields
 *  whose value still equals the card's "from" are written — a field manually
 *  edited after the card was computed is an UNSEEN difference and is skipped
 *  (reported via `skipped`), never overwritten. States dedup by normalized
 *  name against the entity's current states. Pure. */
export function gateUpdate(entity, changes) {
  const current = (key) =>
    key === "voiceDescription" ? (entity.voice || {}).description : entity.profile[key];
  const fields = changes.fields.filter((f) => current(f.key) === f.from);
  // 道具没有 states（`bibledoc.sanitizeProp`），所以这里读的是「有没有这份清单」，
  // 不是「清单是不是空的」—— 把缺席当成空数组会让「道具的状态都已存在」成为一句
  // 关于一个不存在的概念的判断。
  const have = new Set((Array.isArray(entity.states) ? entity.states : []).map((s) => normName(s.name)));
  return {
    fields,
    skipped: changes.fields.length - fields.length,
    states: changes.states.filter((s) => !have.has(normName(s.name))),
  };
}

/** DERIVED episode appearances (M8 rule: never a manually maintained list).
 *  A character appears in an episode iff one of that episode's scenes
 *  references it (characterRefs); a location iff a scene's locationRef points
 *  at it. Returns { characters: Map<id, [{episodeId,title}]>, locations: … }. */
export function derivedAppearances(prod) {
  const characters = new Map();
  const locations = new Map();
  const add = (map, id, ep) => {
    if (!map.has(id)) map.set(id, []);
    const list = map.get(id);
    if (!list.some((x) => x.episodeId === ep.episodeId)) {
      list.push({ episodeId: ep.episodeId, title: ep.title });
    }
  };
  for (const ep of prod.episodes || []) {
    for (const sc of ep.scenes || []) {
      for (const r of sc.characterRefs || []) add(characters, r.characterId, ep);
      if (sc.locationRef) add(locations, sc.locationRef.locationId, ep);
    }
  }
  return { characters, locations };
}
