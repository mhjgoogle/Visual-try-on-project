// FRAME controller (ADR-0061 决策 7 / TASK-066) — 首帧 / 尾帧的提取、绑定与重提取.
//
// TASK-073 §1.8, same pattern as `lockctl.js`: documents arrive as GETTERS because
// the bindings are module-level `let`s reassigned on project load.
//
// THE RULE THIS FILE EXISTS TO HOLD: a binding either takes effect COMPLETELY or is
// refused with a sentence. `bind` runs every check before the first write, because
// the earlier order (write, then discover, then report success) produced three
// distinct silent failures at once — a binding pointing at no shot, a document that
// could no longer be opened, and a prompt showing a frame the generation did not use.
// See the comment on `bind`.
//
// `grabVideoFrame` is INJECTED rather than imported: it reads a `<video>` element,
// which is the one genuinely browser-bound step here. Injecting it is what lets the
// rest of this module be constructed in a test at all.

/**
 * @param {object} deps
 *   docs        `{ frameBindings, registry, production }` — GETTERS
 *   modules     `{ framebind, mediaref, assetreg, assetlib, proddoc }`
 *   findShot    `(shotId) => shot | null`
 *   slotOf      `(shot) => slot | null`
 *   contextOfShot `(shotId) => links`
 *   session     `{ connected: () => boolean, projectName: () => string }`
 *   uploadAssetImage `(project, key, file) => Promise<{version, url, ...}>`
 *   grabVideoFrame   `(url, {timecodeMs, pick}) => Promise<{file, timecodeMs}>`
 *   mintId      `(prefix) => string`
 *   refreshType `(type) => void`
 *   persist / refresh / toast
 *   now         `() => string`
 */
export function createFrameController({
  docs, modules, findShot, slotOf, contextOfShot, session, uploadAssetImage,
  grabVideoFrame, mintId, refreshType, persist, refresh, toast, now,
}) {
  const { framebind, mediaref, assetreg, assetlib, proddoc } = modules;

  const api = {

    bindings: (shotId) => framebind.bindingsOf(docs.frameBindings(), shotId),
    binding: (shotId, type) => framebind.bindingOf(docs.frameBindings(), shotId, type),
    /** The ACTIVE video version of a shot, or null. Passed to
     *  `framebind.frameNotice` so drift is measured against real state. */
    activeVideoVersion: (shotId) => {
      const shot = findShot(shotId);
      const slot = shot ? slotOf(shot) : null;
      const ref = slot ? mediaref.currentRef(docs.registry().videos, slot) : null;
      return ref && Number.isInteger(ref.version) ? ref.version : null;
    },
    /** 「上游视频已有新版本」 — the notice and its three choices, or null. */
    notice: (shotId, type) => framebind.frameNotice(
      framebind.bindingOf(docs.frameBindings(), shotId, type),
      (sid) => api.activeVideoVersion(sid),
    ),
    /**
     * EXTRACT one frame out of a shot's current video take and register it as a
     * derived Image Asset. Returns `{ assetId, url, version, key, source }`.
     *
     * `pick` is the creator's INTENT and is stored: "last" re-seeks to the end of
     * whatever video it is re-extracted from, "at" re-seeks to the same
     * millisecond. `timecodeMs` null with `pick: "last"` means 「最后一帧」.
     *
     * The bytes are read from the video element the browser already has; nothing
     * server-side is needed beyond the ordinary upload endpoint, so this works on
     * exactly the machines the rest of the studio works on.
     */
    extract: async (sourceShotId, { timecodeMs = null, pick = "last" } = {}) => {
      if (!session.connected()) throw new Error("演示模式无后端，无法登记提取出来的帧");
      const shot = findShot(sourceShotId);
      const slot = shot ? slotOf(shot) : null;
      const ref = slot ? mediaref.currentRef(docs.registry().videos, slot) : null;
      if (!ref || !ref.url) throw new Error("这个镜头还没有视频，无法提取帧");
      if (ref.storageState && ref.storageState !== "local") {
        throw new Error("这条视频的字节不在本地（记录仍在）——先恢复本地副本再提取");
      }
      const grabbed = await grabVideoFrame(ref.url, { timecodeMs, pick });
      // its own chain key: a derived frame is not a version of the target shot's
      // 画面 (that would make 「这个镜头有几版画面」 count frames nobody designed)
      const key = mintId("frame");
      const pre = assetreg.checkDeclaration("images", { kind: "derived-frame" });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await uploadAssetImage(session.projectName(), `assets-${key}`, grabbed.file);
      // creativeShotId is the SOURCE shot: that is the shot these pixels provably
      // came from. WHERE the frame is USED is the binding's `targetShotId`, and
      // conflating the two would file the frame under a shot it was not cut from.
      const mref = mediaref.refFromResponse(key, "upload", res, sourceShotId);
      const decl = assetreg.declare(mref, "images", {
        kind: "derived-frame",
        displayName: `${(shot && shot.title) || "镜头"} 视频 v${ref.version} 的${pick === "last" ? "尾帧" : `${(grabbed.timecodeMs / 1000).toFixed(2)}s 帧`}`,
        originalFilename: null,
        links: contextOfShot(sourceShotId),
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: docs.registry().images }, key, mref);
      refreshType("assets");
      persist();
      refresh();
      return {
        key,
        assetId: mref.assetId,
        url: mref.url,
        version: mref.version,
        source: {
          sourceShotId,
          sourceVideoAssetId: ref.assetId || null,
          sourceVideoVersion: Number.isInteger(ref.version) ? ref.version : null,
          sourceTimecodeMs: grabbed.timecodeMs,
          sourceFrame: null, // fps is not knowable from a <video> element — unknown stays unknown
          pick,
        },
      };
    },
    /**
     * BIND a derived (or any registered) image as a shot's start / end frame.
     *
     * `startFrame` additionally moves `assets.firstFrames[slot]`, which is what
     * the video generation route actually reads — the binding record alone would
     * be provenance for a frame nothing used.
     */
    /**
     * The shot that FOLLOWS this one in canonical order, or null.
     *
     * Scoped to the shot's own SCENE: 「下一镜」 across a scene boundary is a cut
     * to somewhere else, and continuing its last frame into it would be a claim
     * about continuity the structure contradicts. A shot at the end of its scene
     * honestly has no next shot here.
     */
    nextShotOf: (shotId) => {
      const owner = proddoc.sceneOfShot(docs.production(), shotId);
      if (!owner) return null;
      const ids = owner.scene.shotIds || [];
      const i = ids.indexOf(shotId);
      if (i < 0 || i + 1 >= ids.length) return null;
      const nextId = ids[i + 1];
      const s = findShot(nextId);
      return s ? { shotId: nextId, title: s.title || `镜头 ${s.sequence}` } : null;
    },
    /**
     * BIND an image as a shot's start / end frame.
     *
     * `source` (an object) is the extraction provenance and makes the binding
     * `extracted`. `sourceKind` names the non-extracted cases explicitly — a
     * binding must SAY where it came from, and defaulting everything without a
     * source object to 「upload」 would file the shot's own picture as an upload.
     */
    bind: (targetShotId, bindingType, { assetId, source = null, sourceKind = "upload", force = false } = {}) => {
      // EVERY check runs BEFORE the first write (TASK-072 §1.9 缺陷 1). This used
      // to record the binding, then discover the problem, then report success:
      //   ① `targetShotId` was never resolved → a binding pointing at no shot,
      //      reported as applied;
      //   ② any image asset was accepted → an asset belonging to ANOTHER slot and
      //      not declared `derived-frame` fails `validateCanvasDoc`, and that
      //      validator rejects the WHOLE document — so binding one made the
      //      project unopenable (and unsaveable) afterwards;
      //   ③ the slot was resolved AFTER `framebind.bind` had already persisted →
      //      the prompt showed the new frame while generation still used the old.
      // Nothing is written unless all of them pass.
      const hit = assetId ? assetlib.findAssetById(docs.registry(), assetId) : null;
      if (!hit || hit.domain !== "images") { toast("只能绑定已登记的图片资产作为首/尾帧"); return null; }
      const shot = findShot(targetShotId);
      if (!shot) { toast("目标镜头不存在：没有绑定任何帧"); return null; }
      let slot = null;
      if (bindingType === "startFrame") {
        slot = slotOf(shot);
        // ③ refuse rather than record a binding whose effective pointer cannot be
        // written: 「已记录绑定，但生成仍用旧画面」 is a binding that lies.
        if (!slot) { toast("目标镜头的槽位无法解析：没有绑定任何帧"); return null; }
        // ② the exact rule `validateCanvasDoc` enforces on assets.firstFrames:
        // an image may be bound to a DIFFERENT slot only when it is the one kind
        // whose whole purpose is that (上一镜尾帧 → 下一镜首帧). Checked here so a
        // refusal is a sentence now, instead of an unloadable document later.
        if (hit.record.kind !== "derived-frame" && hit.key !== slot) {
          toast("这张图属于另一个镜头的画面，且不是提取出来的帧——不能用作本镜头的首帧");
          return null;
        }
      }
      const b = framebind.bind(docs.frameBindings(), targetShotId, bindingType, {
        derivedImageAssetId: assetId,
        source: source ? "extracted" : sourceKind,
        ...(source || {}),
        at: now(),
      }, { force });
      if (!b) { toast("这个帧槽位已锁定：先解锁再绑定"); return null; }
      if (slot) {
        mediaref.putKey(docs.registry().firstFrames, slot, {
          ...hit.record, slot_id: slot, digest: hit.record.digest || null,
        });
        refreshType("video");
      }
      persist();
      refresh();
      return b;
    },
    /** 解除绑定. The derived Asset is NOT deleted — it is a registered asset with
     *  its own provenance, and unbinding is a statement about this shot only. */
    unbind: (targetShotId, bindingType) => {
      const ok = framebind.unbind(docs.frameBindings(), targetShotId, bindingType);
      if (!ok) { toast("这个帧槽位已锁定或本来就没有绑定"); return false; }
      if (bindingType === "startFrame") {
        const shot = findShot(targetShotId);
        const slot = shot ? slotOf(shot) : null;
        // clear the EFFECTIVE pointer too, or the generation would keep using a
        // frame the record no longer claims
        if (slot && docs.registry().firstFrames && Object.prototype.hasOwnProperty.call(docs.registry().firstFrames, slot)) {
          delete docs.registry().firstFrames[slot];
          refreshType("video");
        }
      }
      persist();
      refresh();
      return true;
    },
    /** 从当前版本重新提取 — extract again from the source shot's ACTIVE take and
     *  re-bind, repeating the creator's stored intent (`pick`). */
    reextract: async (targetShotId, bindingType) => {
      const b = framebind.bindingOf(docs.frameBindings(), targetShotId, bindingType);
      if (!b || b.source !== "extracted" || !b.sourceShotId) {
        toast("这个帧不是从视频里提取的，没有可重新提取的来源");
        return null;
      }
      const out = await api.extract(b.sourceShotId, {
        timecodeMs: b.pick === "at" ? b.sourceTimecodeMs : null,
        pick: b.pick,
      });
      return api.bind(targetShotId, bindingType, {
        assetId: out.assetId, source: out.source, force: true,
      });
    },
  
  };

  return api;
}
