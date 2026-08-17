// 派生引用扫描 (TASK-097 §2.6.1) — 「这个 id 还被谁引用着」，靠走文档，不靠清单。
//
// WHY THIS IS ITS OWN MODULE. TASK-094 批次 G shipped this scan inside
// `episodecleanup.js` and it immediately paid for itself: the收口 card handed the
// implementer a four-item checklist (剧本 / 分镜 / 资产绑定 / 生成记录) and the scan
// found a FIFTH — `timelines` held entries for four episodes no item mentioned. A
// hand-written checklist archives an episode something still points at.
//
// TASK-097 has five more places with the same shape (§2.6.1 的表):
//
//   §2.5 的每个计数        「哪些登记表算作有内容」
//   ⑤ Keyframe 的输入       「哪些资产参与合成」
//   TASK-096 §2.4 的 QC 缺口 「哪些 status 算缺」
//   新增 storyboard/keyframe kind 「哪些地方消费 asset kind」
//   软删除 shot            「哪些地方引用 shotId」
//
// so the scan is lifted out of the one caller that had it. `episodecleanup.js`
// imports it and behaves identically — its own tests are the proof.
//
// THE ERROR DIRECTION IS DELIBERATE: an unexpected reference site counts as a
// reference. A new key added next year is content BY DEFAULT, and the only thing
// anybody has to maintain is the短 list of places where the id is EXPECTED and
// therefore proves nothing.
//
// PURE. Takes a serialized document, returns paths. No clock, no writes, no DOM.

/**
 * Every JSON path at which `needle` appears in `node`, INCLUDING as an object key.
 *
 * A key match matters as much as a value match: `scripts[<episodeId>]` and
 * `timelines[<episodeId>]` are references that live entirely in the key, and a
 * value-only walk reports them as absent. Key hits are marked `…<key>` so a
 * caller (and a human reading the blocker text) can tell the two apart.
 */
export function findPaths(node, needle, path = "$", out = []) {
  if (typeof node === "string") {
    if (node === needle) out.push(path);
    return out;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) findPaths(node[i], needle, `${path}[${i}]`, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (k === needle) out.push(`${path}.${k}<key>`);
      findPaths(node[k], needle, `${path}.${k}`, out);
    }
  }
  return out;
}

/**
 * The paths that are NOT one of the expected ones — i.e. the evidence that
 * something still uses this id.
 *
 * `expected` is a predicate over a path, never a list of places that count. That
 * inversion is the whole mechanism: the closed set is 「哪里不算」, which a human can
 * actually keep complete, and everything else is a reference whether or not anyone
 * remembered it existed.
 */
export function foreignReferences(doc, needle, isExpected) {
  const ok = typeof isExpected === "function" ? isExpected : () => false;
  return findPaths(doc, needle).filter((p) => !ok(p));
}

/**
 * Does anything outside the expected places point at `needle`?
 *
 * The one-line question most callers actually ask — 「能不能安全地软删除它」.
 */
export function isReferenced(doc, needle, isExpected) {
  return foreignReferences(doc, needle, isExpected).length > 0;
}

/**
 * Every DISTINCT value found at the leaves under a key name, anywhere in the
 * document — 「哪些地方消费 asset kind」 asked the derived way.
 *
 * Used to answer 「新增一个 kind 之后，还有谁在按 kind 分支」 without writing down the
 * consumers: run it over the real document and the answer is the values that are
 * actually stored, not the values somebody remembered to list.
 */
export function valuesAtKey(node, key, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) valuesAtKey(item, key, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (k === key && typeof node[k] === "string" && node[k]) out.add(node[k]);
      valuesAtKey(node[k], key, out);
    }
  }
  return out;
}
