// 白膜视频控制器（TASK-098）—— 「预览运镜 →」按下去之后发生的事。
//
//   那句 `运镜`  →  motionpreview 解析成一组数  →  本地 ffmpeg 渲一段静音 mp4
//   →  登记成 `motionpreview` 资产（自己的链）  →  屏幕上就地能播
//
// **全程零花费**：没有 provider、没有 Gateway、没有 API key。这是本卡存在的前提
// （§6：任何付费路径改动都在范围外）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 三件事在这里是硬的：
//
// 1. **认不出就说认不出，绝不提交。** 判定用的是 `motionRow`（生产与测试同一份
//    谓词，§2.5d），不是这里重写的一个 if。这一层的价值只有一件：它是真正要发
//    请求的那一层（§2.5b-2 —— fail-closed 必须落在对方真正读的那条路上）。
//
// 2. **它是预览，不是产物。** 资产走 `motion-<slot>` 这条**自己的**链，所以
//    `mediaOf` 那个「这一镜有没有视频」的判定看不见它 —— 白膜混进镜头视频那条链，
//    60 个镜头会看起来都拍完了，而逐镜质检的成片判定读的正是那条链（§5.4）。
//
// 3. **不新增第七个 stage。** TASK-092 那六个是唯一真相；白膜没有自己的 stage，
//    它是 Keyframe 的一个附属视图（§5.5）。所以这里**不写任何 stage**。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 *   docs        `{ registry }` — GETTER（模块级 `let`，换项目会重新赋值）
 *   modules     `{ motionpreview, mediaref, assetreg }`
 *   findShot    `(shotId) => shot | null`
 *   slotOf      `(shot) => slot | null`
 *   keyframeOf  `(shotId) => { assetId, url, present, ... } | null`
 *   shotImageOf `(shotId) => { assetId, url } | null` —— 没有正式关键帧时的第二档
 *   contextOfShot `(shotId) => links`
 *   session     `{ connected, projectName }`
 *   renderMotionPreview `(project, slug, image, spec) => Promise<{url, version, sha256, ...}>`
 *   refreshType / persist / refresh / toast
 */
export function createMotionPreviewController({
  docs, modules, findShot, slotOf, keyframeOf, shotImageOf, contextOfShot, session,
  renderMotionPreview, refreshType, persist, refresh, toast,
}) {
  const { motionpreview, mediaref, assetreg } = modules;

  /** 白膜自己的链键。**与镜头视频的槽位不同名**，这是 §5.4 的全部实现：
   *  `mediaOf` 查的是 `slot`，白膜住在 `motion-<slot>`，两者永不相遇。 */
  const chainKey = (slot) => `motion-${slot}`;

  /** 这一镜写下来的时长。**照原样读，读不到就是读不到**（`shotqc.durationCheck`
   *  的同一条纪律：别处那句「6 或 10，其他一律当 6」是排音频轨的兜底，放在这里
   *  会让一条 8 秒的镜头渲出 6 秒的预览，然后声称它和这一镜一样长）。 */
  const durationOf = (shot) => {
    const d = shot ? shot.duration_seconds : null;
    return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null;
  };

  /**
   * 白膜拿哪张图做。**首选正式关键帧，退一档是这一镜的镜头图片，而且退了要说。**
   *
   * 实测（2026-08-22，两个真实项目）：`keyframe` 这个 kind 一张都还没有产出过
   * —— 照见未明rev2 只有参考图，夜班沉默有 6 张 `shot-image`。只认关键帧的话，
   * 这个功能在现有真实项目上一次也跑不起来（`motionpreview.SOURCE_TIERS` 那段注释
   * 记着完整理由）。
   */
  const sourceOf = (shotId, { hasKeyframe = false } = {}) => {
    if (hasKeyframe) {
      const kf = keyframeOf(shotId);
      if (kf && kf.present && kf.url) {
        return { tier: "keyframe", url: kf.url, assetId: kf.assetId || null };
      }
    }
    const img = typeof shotImageOf === "function" ? shotImageOf(shotId) : null;
    return img && img.url
      ? { tier: "shot-image", url: img.url, assetId: img.assetId || null }
      : null;
  };

  const previewOf = (shotId) => {
    const shot = findShot(shotId);
    const slot = shot ? slotOf(shot) : null;
    if (!slot) return null;
    const ref = mediaref.currentRef(docs.registry().videos, chainKey(slot));
    return ref && ref.url
      ? {
        url: ref.url,
        version: ref.version ?? null,
        assetId: ref.assetId || null,
        // 这段白膜是拿哪一版运镜 / 哪张图渲的（加法字段；旧记录没有它 → 读作
        // 「不知道」，而不知道不读作「就是当前那一版」）
        stamp: typeof ref.motionStamp === "string" ? ref.motionStamp : null,
      }
      : null;
  };

  const api = {
    /** ⑤ 清单里这一行的运镜状态。`keyframeList` 把它当证据注入。 */
    rowOf: (shotId, ev = {}) => {
      const shot = findShot(shotId);
      return motionpreview.motionRow({
        text: shot ? shot.cameraMotion : "",
        durationSeconds: durationOf(shot),
        source: sourceOf(shotId, ev),
        preview: previewOf(shotId),
      });
    },

    /** 这一镜的白膜会拿哪张图做（画布 / 检查器复用，不必再走 `rowOf`）。 */
    sourceOf,

    /** 已经渲过的那一段（供画布 / 检查器复用，不必再走 `rowOf`）。 */
    previewOf,

    /**
     * 渲一段白膜。
     *
     * 拒绝的每一条都说出**现在真实可做的那件事**（§2.5h 第二条），因为「已提交」
     * 是一句关于未来的承诺，而这几种情形里创作者要的是一件当下能做的事。
     */
    render: async (shotId) => {
      if (!session.connected()) {
        toast("演示模式没有后端 —— 白膜是本地 ffmpeg 渲的，连上真实项目才能预览");
        return null;
      }
      const shot = findShot(shotId);
      const slot = shot ? slotOf(shot) : null;
      if (!slot) {
        toast("镜头身份未解析：定位不到这一镜的媒体槽位");
        return null;
      }
      const kf = keyframeOf(shotId);
      const hasKeyframe = !!(kf && kf.present && kf.url);
      const src = sourceOf(shotId, { hasKeyframe });
      const row = api.rowOf(shotId, { hasKeyframe });
      // **这一道就是「认不出不静默出片」那道闸门**，而且它用的是屏幕上那一份判断。
      if (!row.canPreview || !src) {
        toast(row.blocked || row.todo || "这一镜还不能预览运镜");
        return null;
      }
      const image = String(src.url).split("/").pop();
      if (!image) {
        toast("读不出那张图的文件名 —— 先在 ⑤ 重新登记一次它");
        return null;
      }
      // **等待期间项目可能被换掉。** `docs.registry()` 是一个 getter（模块级 `let`
      // 换项目时会重新赋值），所以 `await` 之后那一次 `addVersion` + `persist()` 会
      // 把这一段预览写进**另一个项目**的登记表 —— 而字节留在项目 A 的 `media/` 下，
      // 于是项目 B 里出现一条指着别人媒体的资产。`shotaudioctl.mixNow` 的文件头就为
      // 这一条留过一段警告，本卡第一版照样中了（codex 轮 1 的 P1）。
      //
      // 记下开工时是哪个项目，回来先核对；**不一致就不写**，并如实说出来。
      const startedIn = session.projectName();
      let res;
      try {
        res = await renderMotionPreview(startedIn, chainKey(slot), image, row.spec);
      } catch (e) {
        // 后端的 fail-closed 原样转达（缺 ffmpeg / 时长核对不过 / 越界）——
        // 不改写成「稍后重试」那种什么都没说的话。
        toast(`白膜没渲出来：${e.detail || e.message || "未知原因"}`);
        return null;
      }
      if (session.projectName() !== startedIn) {
        // 文件已经渲在 `startedIn` 的 media/ 下了 —— 那没关系，它是一段免费预览，
        // 下次在那个项目里重渲会得到新版本。**不能做的是把它登记到现在这个项目**。
        toast(
          `白膜渲好了，但你已经切到别的项目 —— 这一段留在「${startedIn}」里没有登记；`
          + "回到那个项目再点一次即可（它是本地免费的）",
        );
        return null;
      }
      const ref = mediaref.refFromResponse(chainKey(slot), "motion", res, shotId);
      // **印上身份**（加法字段，零迁移）：改了运镜或换了图之后，界面才说得出
      // 「这段白膜是上一版渲的」，而不是在新摘要旁边播旧画面（codex 轮 1 的 P1）。
      ref.motionStamp = row.stamp;
      const decl = assetreg.declare(ref, "videos", {
        kind: "motionpreview",
        displayName: `运镜预览 · ${(shot && shot.title) || shotId} v${res.version}`,
        originalFilename: null,
        links: contextOfShot(shotId),
      });
      if (!decl.ok) {
        toast(`预览渲好了但没登记上：${decl.error}`);
        return null;
      }
      mediaref.addVersion({ uploads: docs.registry().videos }, chainKey(slot), ref);
      // **不记 Generation**：Generation 是「一次生成」的账，用来回答花了多少钱、
      // 用了哪些参考、产出算不算这一镜的画面。白膜三条全不适用（零花费、没有参考、
      // 不是这一镜的画面），记上去只会让溯源图里多出 60 个不是产物的节点。
      refreshType("video");
      persist();
      refresh();
      toast(
        `运镜预览 v${res.version} 已渲好（${row.summary} · ${res.duration}s，与这一镜等长`
        + `，用的是${row.sourceLabel}）—— 免费、本地，不参与成片判定`,
      );
      return ref;
    },
  };

  return api;
}
