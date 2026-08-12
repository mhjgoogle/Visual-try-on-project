// Reference Planning (checkpoint CP6 / ADR-0058) — plan the whole episode's
// reference material at once, instead of discovering per shot that something is
// missing.
//
// It answers four things for an episode:
//
//     已存在   this reference exists and shots are bound to it
//     缺失     a shot NEEDS this kind of reference and has none
//     共用     which shots share one canonical Reference
//     建议复用 an existing reference already covers this subject
//
// TWO RULES:
//
//   1. NEVER COPY A CANONICAL ASSET. A plan row points at the reference CHAIN
//      (its key). Ten shots sharing 林照 Ref is one row with ten shots on it,
//      not ten rows — that is the entire reason references are canonical.
//   2. A "missing" row is a QUESTION, not an instruction. It says a shot has a
//      character in its scene and no character reference bound; it does not
//      create anything. Creating is the creator's, through the picker.
//
// Pure derivation over the canonical documents — no writes.

import { esc } from "../util/dom.js";
import { head, empty, nameWithVersion } from "./shell.js";
import { REFERENCE_ROLES } from "../workflow/geninput.js";
import { derivedLabel } from "../workflow/assetreg.js";

/**
 * The episode's reference plan.
 *
 * `view`       proddoc.episodeView() — scenes with their shots
 * `bindings`   (shotId) => [referenceKey]        (CP4 shared bindings)
 * `references` the canonical References that exist (assetreg.listReferences)
 * `sceneOf`    (shotId) => { sceneId, title, characterIds, locationId } | null
 * `names`      id → human name resolvers
 */
export function referencePlan({ view, bindings, references, sceneOf, names }) {
  const byKey = new Map(references.map((r) => [r.key, r]));
  const shots = [];
  for (const sc of (view && view.scenes) || []) {
    for (const entry of sc.shots || []) {
      if (entry && entry.shot) shots.push({ shot: entry.shot, sceneId: sc.sceneId, sceneTitle: sc.title });
    }
  }
  for (const s of (view && view.unassigned) || []) shots.push({ shot: s, sceneId: null, sceneTitle: null });

  // --- what each shot already points at -------------------------------------- //
  const rows = new Map(); // referenceKey → row
  const useKey = (key, shotId) => {
    const ref = byKey.get(key);
    if (!ref) return; // a dangling binding is pruned elsewhere; never rendered
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        kind: ref.kind,
        name: derivedLabel(ref),
        version: ref.version,
        url: ref.url,
        storageState: ref.storageState,
        status: "have",
        shotIds: [],
      });
    }
    rows.get(key).shotIds.push(shotId);
  };
  for (const { shot } of shots) {
    for (const key of bindings(shot.shotId) || []) useKey(key, shot.shotId);
  }

  // --- what the SCENE says a shot needs -------------------------------------- //
  // A scene names its characters and its location; a shot in it plausibly needs
  // that character's and that location's reference material. This is evidence
  // from the document, not a guess about the pixels.
  const missing = [];
  const suggest = [];
  const boundSubjects = new Set();
  for (const row of rows.values()) {
    const ref = byKey.get(row.key);
    if (ref && ref.links.characterId) boundSubjects.add(`character:${ref.links.characterId}`);
    if (ref && ref.links.locationId) boundSubjects.add(`location:${ref.links.locationId}`);
  }
  const seenNeed = new Set();
  for (const { shot } of shots) {
    const scene = sceneOf(shot.shotId);
    if (!scene) continue;
    // What this shot is bound to, BY SUBJECT — not merely by kind. Asking only
    // "does it have a character reference" made one bound reference cover every
    // character in the scene: bind 林晚's reference to a two-hander and 陈默's
    // gap silently disappeared, which is the exact question this page exists to
    // answer. The same holds for a location: a reference for a DIFFERENT
    // location is not this location's reference.
    const boundChars = new Set();
    const boundLocs = new Set();
    for (const k of bindings(shot.shotId) || []) {
      const ref = byKey.get(k);
      if (!ref || !ref.links) continue;
      if (ref.kind === "character-reference" && ref.links.characterId) boundChars.add(ref.links.characterId);
      if (ref.kind === "location-reference" && ref.links.locationId) boundLocs.add(ref.links.locationId);
    }
    for (const cid of scene.characterIds || []) {
      const need = `character:${cid}:${shot.shotId}`;
      if (seenNeed.has(need)) continue;
      seenNeed.add(need);
      if (boundChars.has(cid)) continue;
      // an existing reference already covers this character → suggest REUSE
      const existing = [...byKey.values()].find(
        (r) => r.kind === "character-reference" && r.links.characterId === cid,
      );
      const entry = {
        kind: "character-reference",
        subject: names.character(cid) || cid,
        subjectId: cid,
        shotId: shot.shotId,
        sceneTitle: scene.title,
      };
      if (existing) suggest.push({ ...entry, status: "reuse", key: existing.key, name: derivedLabel(existing), version: existing.version, url: existing.url });
      else missing.push({ ...entry, status: "missing" });
    }
    if (scene.locationId) {
      const need = `location:${scene.locationId}:${shot.shotId}`;
      if (!seenNeed.has(need)) {
        seenNeed.add(need);
        if (!boundLocs.has(scene.locationId)) {
          const existing = [...byKey.values()].find(
            (r) => r.kind === "location-reference" && r.links.locationId === scene.locationId,
          );
          const entry = {
            kind: "location-reference",
            subject: names.location(scene.locationId) || scene.locationId,
            subjectId: scene.locationId,
            shotId: shot.shotId,
            sceneTitle: scene.title,
          };
          if (existing) suggest.push({ ...entry, status: "reuse", key: existing.key, name: derivedLabel(existing), version: existing.version, url: existing.url });
          else missing.push({ ...entry, status: "missing" });
        }
      }
    }
  }

  // group the shot-level gaps by subject, so the creator sees "林晚 · 4 个镜头"
  // rather than four identical rows
  const group = (list) => {
    const m = new Map();
    for (const x of list) {
      const k = `${x.kind}:${x.subjectId}${x.key ? `:${x.key}` : ""}`;
      if (!m.has(k)) m.set(k, { ...x, shotIds: [] });
      m.get(k).shotIds.push(x.shotId);
    }
    return [...m.values()];
  };

  const have = [...rows.values()].sort((a, b) => b.shotIds.length - a.shotIds.length);
  return {
    have,
    missing: group(missing),
    reuse: group(suggest),
    shots: shots.length,
    // the reference material this episode has, grouped by role, for the summary
    byRole: REFERENCE_ROLES.map(([role, label]) => ({
      role, label, n: have.filter((r) => r.kind === role).length,
    })),
    shared: have.filter((r) => r.shotIds.length > 1),
  };
}

// --- rendering ------------------------------------------------------------- //

function refCard(r, shotName) {
  const shots = r.shotIds.map(shotName).filter(Boolean);
  const thumb = r.url && r.storageState === "local"
    ? `<img class="rp-thumb" src="${esc(r.url)}" alt="${esc(r.name)}" loading="lazy">`
    : `<div class="rp-thumb rp-none">⃠</div>`;
  return (
    `<div class="rp-card">${thumb}<div class="rp-body">` +
    `<div class="rp-name">${nameWithVersion(r.name, r.version)}</div>` +
    `<div class="rp-shots">${shots.length ? `${shots.length} 个镜头共用：${esc(shots.join("、"))}` : "尚未绑定到任何镜头"}</div>` +
    `</div></div>`
  );
}

export function renderRefPlan(ctx, ui) {
  const m = ctx.refplan.model();
  const shotName = ctx.refplan.shotName;
  if (!m.shots) {
    return (
      head("参考统筹", "这一集需要哪些参考图") +
      empty("🖼", "这一集还没有镜头", "先在「分镜」里拆出镜头，再回来统筹参考",
        `<button class="btn" data-goto="shots">去分镜</button>`)
    );
  }
  const summary = m.byRole.map((r) => `${esc(r.label)} ${r.n}`).join(" · ");
  const section = (title, body, note) =>
    `<section class="rp-sec"><h3>${esc(title)}</h3>${note ? `<p class="rp-note">${esc(note)}</p>` : ""}${body}</section>`;
  const haveHtml = m.have.length
    ? `<div class="rp-grid">${m.have.map((r) => refCard(r, shotName)).join("")}</div>`
    : `<div class="rp-empty">这一集还没有任何镜头绑定参考。</div>`;
  const gapRow = (x, action) =>
    `<li><span class="chip">${esc(x.kind === "character-reference" ? "人物" : "场景")}</span>` +
    `<b>${esc(x.subject)}</b>` +
    `<span class="rp-shots">${x.shotIds.length} 个镜头：${esc(x.shotIds.map(shotName).filter(Boolean).join("、"))}</span>` +
    action + `</li>`;
  const missingHtml = m.missing.length
    ? `<ul class="rp-list">${m.missing.map((x) => gapRow(x,
        `<button class="btn" data-rp-create="${esc(x.kind)}" data-rp-subject="${esc(x.subjectId)}" data-rp-shots="${esc(x.shotIds.join(","))}">上传参考</button>`)).join("")}</ul>`
    : `<div class="rp-empty">没有缺口。</div>`;
  const reuseHtml = m.reuse.length
    ? `<ul class="rp-list">${m.reuse.map((x) => gapRow(x,
        `<button class="btn primary" data-rp-bind="${esc(x.key)}" data-rp-shots="${esc(x.shotIds.join(","))}">绑定「${esc(x.name)}」</button>`)).join("")}</ul>`
    : `<div class="rp-empty">没有可复用的建议。</div>`;
  return (
    head("参考统筹", `${m.shots} 个镜头 · ${summary}${m.shared.length ? ` · ${m.shared.length} 个参考被多镜头共用` : ""}`) +
    section("已存在", haveHtml, m.shared.length ? "共用的参考是同一条链、同一个版本指针——切到新版本，用它的镜头一起跟着走。" : "") +
    section("建议复用", reuseHtml, "这些镜头的场景里有这个对象，而项目里已经有它的参考——绑定它，不要新建一份。") +
    section("缺失", missingHtml, "场景里有这个对象，项目里还没有它的参考。这里只是提问，不会替你创建任何东西。")
  );
}

export function bindRefPlan(root, ctx, ui, render) {
  const shotsOf = (b) => (b.dataset.rpShots || "").split(",").filter(Boolean);
  const bindAll = (key, shotIds) => {
    for (const shotId of shotIds) ctx.shot.addReference(shotId, key);
  };
  root.querySelectorAll("[data-rp-bind]").forEach((b) => (b.onclick = () => {
    bindAll(b.dataset.rpBind, shotsOf(b));
    render();
  }));
  // Filling a gap FINISHES the job: the new reference is bound to exactly the
  // shots whose gap it was. Uploading and stopping there left those shots still
  // unbound — the row stayed on screen and the next generation still went out
  // without the reference the creator had just supplied for it.
  root.querySelectorAll("[data-rp-create]").forEach((b) => (b.onclick = async () => {
    const key = await ctx.refplan.uploadFor(b.dataset.rpCreate, b.dataset.rpSubject);
    if (key) bindAll(key, shotsOf(b));
    render();
  }));
}
