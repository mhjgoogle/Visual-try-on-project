// ASSET controller (TASK-073 §1.8 第三批) — 资产登记、参考链与资产库读模型.
//
// Two jobs that belong together because they read the same registry:
//
//   · WRITE — import a Reference, append a version, edit creator metadata.
//     Every write goes through `assetreg.declare` / `updateDeclaration`, so an
//     undeclared or mis-declared Asset stays structurally impossible (ADR-0055:
//     上传 = 登记 + 分类 + 关联, one entrance).
//   · READ  — the Asset Library's models (usage / library / names / provenance).
//     All DERIVED per call: the library owns no state, so it cannot disagree
//     with what the project actually holds (CP5).
//
// Same pattern as `lockctl.js` / `framectl.js`: documents arrive as GETTERS,
// because the bindings in app.js are module-level `let`s reassigned on project
// load. Capturing their VALUES at construction would leave this controller
// reading and writing the PREVIOUS project's registry forever — silently, which
// is the failure mode TASK-073 §5.10 records.
//
// `pickFile` and `uploadAssetImage` are INJECTED: one opens a file dialog, the
// other talks to the backend. Injecting them is what lets the rest of this
// module be constructed in a test at all.

/**
 * @param {object} deps
 *   docs        `{ registry, production, timelines, generations }` — GETTERS
 *   modules     `{ assetreg, assetlib, mediaref, assetusage, assetlibws }`
 *   session     `{ connected: () => boolean, projectName: () => string }`
 *   uploadAssetImage `(project, slug, file) => Promise<res>`
 *   pickFile    `(accept) => Promise<File|null>`
 *   mediaDomainOfFile `(file) => "images"|"videos"|"audio"|null`
 *   domainSlugPrefix  `(domain) => string`
 *   setCurrentVersion `(domainWord, key, version) => any` — the ONE active-pointer
 *                     write path (`ctx.media.setCurrent`), never re-implemented here
 *   draftShots  `() => shot[]`
 *   refreshType / persist / refresh / toast
 */
export function createAssetController({
  docs,
  modules,
  session,
  uploadAssetImage,
  // 免费自动出图（TASK-139 / ADR-0100）。与 `uploadAssetImage` 一样是注入的：
  // 控制器不认识任何一家供应商，只知道「有人能把 prompt 变成一份写好的响应」。
  accountImageGenerate,
  pickFile,
  mediaDomainOfFile,
  domainSlugPrefix,
  setCurrentVersion,
  draftShots,
  refreshType,
  persist,
  refresh,
  toast,
}) {
  const { assetreg, assetlib, mediaref, assetusage, assetlibws } = modules;
  const reg = () => docs.registry();

  /** Locate a reference chain across all three media domains. */
  const chainFor = (key) =>
    mediaref.slotEntry(reg().images, key)
    || mediaref.slotEntry(reg().videos, key)
    || mediaref.slotEntry(reg().audio, key);

  const self = {
    KINDS: assetreg.ASSET_KINDS,
    KIND_LABEL: assetreg.ASSET_KIND_LABEL,
    /** Every registered Asset, flattened (the asset library / picker / Director
     *  all read this one derivation). */
    list: () => assetreg.listAssets(reg()),
    /** The canonical References — one entry per `ref-…` chain at its CURRENT
     *  version. This is the unit many shots SHARE; never copied per shot. */
    references: () => assetreg.listReferences(reg()),
    find: (assetId) => assetlib.findAssetById(reg(), assetId),

    /** Import a file as a NEW canonical Reference (人物 / 场景 / 道具 / 风格 /
     *  外部). Mints its own `ref-…` chain so later takes of the SAME reference
     *  append as v2, v3 … rather than becoming unrelated assets. */
    importReference: async ({ kind, file, links, displayName, tags, prompt } = {}) => {
      if (!session.connected()) throw new Error("演示模式无后端，无法上传参考图");
      if (!assetreg.isReferenceKind(kind)) throw new Error(`不是参考类型：${kind}`);
      // **有 prompt 就是「让它生成」，否则就是「传一个文件」** —— 两条路之后的
      // 每一步（域校验、登记、版本链、刷新）完全相同。加一个参数而不是另写一条
      // 导入路：`ref-…` 链的写入者只能有一个，否则同一个参考会有两种登记方式，
      // 而它们迟早不一致。
      const generating = !file && typeof prompt === "string" && prompt.trim() !== "";
      if (!file && !generating) throw new Error("没有选择文件");
      const key = assetreg.mintReferenceKey();
      // 生成出来的一律是图片；文件那条仍按字节判域。
      const domain = generating ? "images" : mediaDomainOfFile(file);
      // An unresolvable domain must FAIL HERE. Falling through would hand
      // addVersion a `{uploads: undefined}` map, which quietly creates a throw-
      // away object: the upload would succeed on disk and be gone after reload.
      // (The server would refuse the write anyway — its type allow-list reads
      // the same MIME — so this is the honest error, not a new restriction.)
      if (!domain) {
        throw new Error("无法识别文件类型：请上传 png/jpg/webp、mp4/webm 或 mp3/wav");
      }
      // The kind's OWN allowed domains decide (ADR-0061 决策 4), rather than
      // 「images unless external」: a motion reference is legitimately a clip, and
      // a performance reference is legitimately a line read. The declaration
      // check below re-verifies this, so the guarantee does not rest on this
      // message being right.
      const allowed = assetreg.domainsForKind(kind);
      if (!allowed.includes(domain)) {
        const zh = { images: "图片", videos: "视频", audio: "音频" };
        throw new Error(
          `${assetreg.ASSET_KIND_LABEL[kind] || kind} 只能是 ${allowed.map((d) => zh[d] || d).join(" / ")}`,
        );
      }
      // checked BEFORE the upload — see ctx.audio.importKey
      const pre = assetreg.checkDeclaration(domain, { kind });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const slug = `${domainSlugPrefix(domain)}-${key}`;
      const res = generating
        ? await accountImageGenerate(session.projectName(), slug, prompt)
        : await uploadAssetImage(session.projectName(), slug, file);
      // origin 让溯源里看得出这一版是生成的还是传上来的 —— 两者都是合法来源，
      // 但把生成说成上传，就是让登记表记一件没发生过的事。
      const ref = mediaref.refFromResponse(key, generating ? "account-image" : "upload", res, null);
      const decl = assetreg.declare(ref, domain, {
        kind,
        displayName: displayName || null,
        originalFilename: (file && file.name) || null,
        links,
        tags,
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: reg()[domain] }, key, ref);
      refreshType("assets");
      persist();
      refresh();
      // **实际发出去的那份要说出来。** 出图模型读不懂中文，所以这条路上「他写的」
      // 和「发出去的」不是同一句话；不说，就是替他换了词还不告诉他。
      const sentNote = res && res.translated && res.prompt_sent
        ? `（实际发出去的是英文改写：${String(res.prompt_sent).slice(0, 60)}…）`
        : "";
      toast(`已登记参考资产「${assetreg.derivedLabel({ ...ref, version: ref.version })}」${sentNote}`);
      return { key, ref };
    },

    /** Append a NEW VERSION to an existing canonical Reference — 林照 Ref v2,
     *  v3 … The chain, its kind and its links are the reference's; only the
     *  bytes are new. Every shot pointing at this reference follows the
     *  chain's current pointer, so nothing has to be re-pointed by hand. */
    importReferenceVersion: async (key, file) => {
      if (!session.connected()) throw new Error("演示模式无后端，无法上传参考图");
      if (!assetreg.isReferenceKey(key)) throw new Error("不是参考资产");
      const chain = chainFor(key);
      if (!chain) throw new Error("参考资产不存在");
      const head = chain.history[chain.history.length - 1] || {};
      const domain = mediaDomainOfFile(file);
      if (!domain) {
        throw new Error("无法识别文件类型：请上传 png/jpg/webp、mp4/webm 或 mp3/wav");
      }
      if (!reg()[domain] || !mediaref.slotEntry(reg()[domain], key)) {
        throw new Error("新版本的媒体类型与该参考资产不一致");
      }
      // checked BEFORE the upload — see ctx.audio.importKey
      const pre = assetreg.checkDeclaration(domain, { kind: head.kind || null });
      if (pre) throw new Error(`登记被拒绝，未上传：${pre}`);
      const res = await uploadAssetImage(session.projectName(), `${domainSlugPrefix(domain)}-${key}`, file);
      const ref = mediaref.refFromResponse(key, "upload", res, null);
      const decl = assetreg.declare(ref, domain, {
        kind: head.kind || null,
        displayName: head.displayName || null,
        originalFilename: file.name || null,
        links: head.links,
        tags: head.tags,
        reusable: head.reusable === true,
      });
      if (!decl.ok) throw new Error(`登记失败：${decl.error}`);
      mediaref.addVersion({ uploads: reg()[domain] }, key, ref);
      refreshType("assets");
      persist();
      refresh();
      toast(`参考资产已新增 v${ref.version}（旧版本保留，可回切）`);
      return ref;
    },

    /** Pick a file and append it as a new version of an existing Reference.
     *  Thin wrapper so the Production Inspector never opens its own upload path
     *  (ADR-0055: 上传 ≠ 保存文件 — one entrance, one registration). */
    uploadReferenceVersion: async (key) => {
      if (!assetreg.isReferenceKey(key)) throw new Error("不是参考资产");
      const chain = chainFor(key);
      if (!chain) throw new Error("参考资产不存在");
      const head = chain.history[chain.history.length - 1] || {};
      // Only the domains this reference's KIND is allowed in — a picker that
      // offers an mp3 for a 人物参考 invites a refusal the creator cannot
      // predict. `accept` follows the declaration, not the other way round.
      const domains = new Set(assetreg.domainsForKind(head.kind || null));
      const accept = [
        domains.has("images") ? "image/png,image/jpeg,image/webp" : "",
        domains.has("videos") ? "video/mp4,video/webm" : "",
        domains.has("audio") ? "audio/mpeg,audio/wav" : "",
      ].filter(Boolean).join(",") || "image/png,image/jpeg,image/webp";
      const file = await pickFile(accept);
      if (!file) return null;
      return self.importReferenceVersion(key, file);
    },

    /** One chain's full version list, for the version block in the Production
     *  Inspector. Read-only; the switch itself goes through ctx.media.setCurrent
     *  so there is still exactly one write path for an active pointer. */
    chainOf: (key) => {
      for (const domain of ["images", "videos", "audio"]) {
        const e = mediaref.slotEntry(reg()[domain], key);
        if (!e) continue;
        return {
          domain,
          current: e.current,
          list: e.history.map((r) => ({
            version: r.version,
            url: r.url || "",
            origin: r.origin || "",
            assetId: r.assetId || null,
            current: r.version === e.current,
            storageState: r.storageState || "local",
          })),
        };
      }
      return null;
    },

    /** Edit an Asset's CREATOR metadata. Always an explicit user action —
     *  nothing in the system reclassifies an asset on its own. */
    update: (assetId, fields) => {
      const hit = assetlib.findAssetById(reg(), assetId);
      // the record's OWN domain gates a kind change — the same rule declare()
      // applies at import, so the edit path cannot mint an invalid document
      if (!hit || !assetreg.updateDeclaration(hit.record, fields, hit.domain)) return false;
      persist();
      refresh();
      return true;
    },
    addTag: (assetId, tag) => {
      const hit = assetlib.findAssetById(reg(), assetId);
      if (!hit || !assetreg.addTag(hit.record, tag)) return false;
      persist();
      refresh();
      return true;
    },
    removeTag: (assetId, tag) => {
      const hit = assetlib.findAssetById(reg(), assetId);
      if (!hit || !assetreg.removeTag(hit.record, tag)) return false;
      persist();
      refresh();
      return true;
    },
    /** Mark / unmark 可复用. EXPLICIT only: "used many times" is never taken as
     *  consent to call something reusable (ADR-0055 决策 1). */
    setReusable: (assetId, on) => self.update(assetId, { reusable: on === true }),
    /** Switch a chain's CURRENT version — the Active variant everything reads. */
    setCurrent: (domain, key, version) => setCurrentVersion(
      domain === "images" ? "image" : domain === "videos" ? "video" : "audio", key, version,
    ),

    // --- Asset Library read models (CP5) ----------------------------------- //
    // All DERIVED per render: the library owns no state, so it cannot disagree
    // with what the project actually holds.
    /** Where every asset is used — one pass over the canonical documents. */
    usage: () => assetusage.usageIndex({
      assets: assetreg.listAssets(reg()),
      production: docs.production(),
      timelines: docs.timelines(),
      generations: docs.generations(),
    }),
    usageOf: (assetId) => {
      const hit = assetlib.findAssetById(reg(), assetId);
      // a Shot binds the CHAIN, which resolves to one version — so shot usage
      // belongs to the current take only, never to the ones it superseded
      const chain = hit && hit.key && reg()[hit.domain]
        ? mediaref.slotEntry(reg()[hit.domain], hit.key)
        : null;
      return assetusage.usageOfAsset({
        assetId,
        referenceKey: hit ? hit.key : null,
        // the version is on the left on purpose: the single-media-write-path
        // guard scans raw text for an assignment to a chain's current pointer,
        // and a comparison written the other way round is indistinguishable
        // from one by substring. This only ever reads.
        isCurrent: !chain || hit.record.version === chain.current,
        production: docs.production(),
        timelines: docs.timelines(),
        generations: docs.generations(),
      });
    },
    library: (filters) => assetlibws.libraryModel({
      assets: assetreg.listAssets(reg()),
      usage: self.usage(),
      names: self.names(),
      filters,
    }),
    /** One asset in the library's shape, even when the current filters hide it
     *  — an inspector that closes because you ticked a filter is maddening. */
    libraryOne: (assetId) => self.library({ type: "all", variant: "all" })
      .rows.find((r) => r.assetId === assetId) || null,
    /** id → human name, so search and filters work on what the creator SEES. */
    names: () => {
      const prod = docs.production();
      const ch = new Map((prod.characters || []).map((c) => [c.characterId, c.name]));
      const lo = new Map((prod.locations || []).map((l) => [l.locationId, l.name]));
      const ep = new Map();
      const sc = new Map();
      (prod.episodes || []).forEach((e, i) => {
        ep.set(e.episodeId, `EP${String(i + 1).padStart(2, "0")} ${e.title}`);
        for (const s of e.scenes || []) sc.set(s.sceneId, s.title);
      });
      const sh = new Map((draftShots() || []).map((s) => [s.shotId, s.title || ""]));
      const get = (m) => (id) => (id && m.get(id)) || "";
      return { character: get(ch), location: get(lo), episode: get(ep), scene: get(sc), shot: get(sh) };
    },
    /** The dropdown options — only canonical objects that really exist. */
    filterOptions: () => {
      const prod = docs.production();
      const sources = [...new Set(assetreg.listAssets(reg()).map((a) => a.origin).filter(Boolean))];
      return {
        characters: (prod.characters || []).map((c) => ({ id: c.characterId, name: c.name })),
        locations: (prod.locations || []).map((l) => ({ id: l.locationId, name: l.name })),
        episodes: (prod.episodes || []).map((e, i) => ({ id: e.episodeId, name: `EP${String(i + 1).padStart(2, "0")} ${e.title}` })),
        sources: sources.map((s) => ({ id: s, name: s })),
      };
    },
    /** The Generation that produced this asset, with its frozen inputs resolved
     *  to names. Honest null when nothing recorded producing it. */
    provenanceOf: (assetId) => {
      const gen = docs.generations().find(
        (g) => g && Array.isArray(g.resultAssetIds) && g.resultAssetIds.includes(assetId),
      );
      if (!gen) return null;
      const nameOf = (id) => {
        const hit = assetlib.findAssetById(reg(), id);
        if (!hit) return `${id}（已删除）`;
        return assetreg.derivedLabel({ ...hit.record, version: hit.record.version, key: hit.key });
      };
      return {
        generation: gen,
        references: [...(gen.referenceAssetIds || []), ...(gen.inputAssetIds || [])].map(nameOf),
      };
    },
  };
  return self;
}
