// PROMPT controller — 提示词：一份镜头提示词、一份基础资产提示词、一次批量合成。
//
// TASK-073 §1.8 第五批，沿用 `controllers/lockctl.js` 立下的模式：每一份文档都以
// GETTER 传入，因为它们是**加载项目时会被整个重新赋值**的模块级 `let`。工厂若在
// 构造时捕获它们的值，控制器就会永远读写上一个项目的文档 —— 而且是静默的。
//
// WHY THESE THREE TOGETHER. 它们是同一个域的三层，而不是三个碰巧同名的东西：
//
//   prompt        一份提示词的**版本账**（存了哪几版、哪一版在生效、锁没锁）
//   basePrompt    把「基础资产」这一类实体翻译成上面那本账的一个 key，并提供
//                 编译好的默认文本 —— 它的每一个写操作都直接委托给 `prompt`
//   promptBatch   「一键合成全部提示词」，它读的就是上面两层编译出来的结果
//
// 拆开的代价是具体的：`basePrompt.save/setActive/useCompiled/setLocked` 全部是
// `ctx.prompt.*` 的转发，而 `promptBatch.confirm` 的成败判据来自同一份编译产物。
// 分成三个模块，就是让「同一份提示词」的三层各持一段，谁也说不全。
//
// WHAT THIS MODULE OWNS AND WHAT IT DOES NOT. 它记录与派生，**不决定钱**：
// `promptBatch` 的第二步（ADR-0041 的 confirm）由创作者在界面上按下，本控制器
// 不会自己确认；报价一律来自 preflight，拿不到就停在 `draft`，绝不自己编一个数。
// 状态机、总额校验与记账都在 `promptbatch` 模块里，这里只负责「谁进这一批」
// 「预检的答复交给它」「每一镜的结果报回去」。

/**
 * @param {object} deps
 *   docs        `{ prompts, production }` — GETTERS returning the current documents
 *   batchState  `{ get, set }` — 批次状态是一个会被整体替换的模块级 `let`，
 *               所以它不能像文档那样只读：写侧也要一个显式的口子。**不是**
 *               `{ value }` 之类的持有对象——那会在 app.js 里留下第二份真相。
 *   modules     `{ bibledoc, promptdoc, baseassets, promptbatch, skills }`
 *   compileEntityBasePrompt  纯编译器（`workflow/promptc.js`）
 *   confirmedGenreTone  `() => string`
 *   shotDetailModel     `(prodData, shotId) => detail | null`
 *   prodData    `() => object` — 当前的生产数据快照
 *   wizardCounts `() => object` — 与「已合成」计数同一份口径
 *   preflight   `(batch) => Promise<answer|null>` — 真正问 Gateway 的那一步，
 *               注入是为了让测试替换它而不必碰状态机
 *   paidRoute   `() => "gateway" | "local"`
 *   projectName `() => string` — await 之后用来确认「回来还是不是同一个项目」
 *   prodOp      persists + refreshes on a truthy result, and returns it
 *   persist     `() => void`
 *   refresh     `() => void`
 *   toast       `(text) => void`
 *   now         `() => string` — the timestamp source
 */
export function createPromptController({
  docs,
  batchState,
  modules,
  compileEntityBasePrompt,
  confirmedGenreTone,
  shotDetailModel,
  prodData,
  wizardCounts,
  preflight,
  paidRoute,
  projectName,
  prodOp,
  persist,
  refresh,
  toast,
  now,
}) {
  const { bibledoc, promptdoc, baseassets, promptbatch, skills } = modules;

  /** 落盘 + 重渲染。一处写，让每条路径（含失败路径）都用它。 */
  const save = () => {
    persist();
    refresh();
    return batchState.get();
  };

  const api = {
    // ---------------------------------------------------------------- //
    // 一份提示词的版本账
    // ---------------------------------------------------------------- //
    prompt: {
      /** The effective prompt + where it came from. `compiled` is passed in by the
       *  caller (it is a derivation of the shot design, which this module does not
       *  own) so there is one compiler, not two. */
      effective: (shotId, kind, compiled) =>
        promptdoc.effectivePrompt(docs.prompts(), shotId, kind, compiled),
      entry: (shotId, kind) => promptdoc.entryOf(docs.prompts(), shotId, kind),
      /** Record a new version. Returns the version number, or 0 when refused
       *  (a LOCKED prompt refuses everything that is not a manual edit — 决策 5). */
      save: (shotId, kind, text, opts = {}) => {
        const v = promptdoc.addVersion(docs.prompts(), shotId, kind, {
          text,
          origin: opts.origin || "manual",
          at: now(),
          skillRunId: opts.skillRunId || null,
          proposalId: opts.proposalId || null,
        });
        if (v) { persist(); refresh(); }
        return v;
      },
      setActive: (shotId, kind, version) =>
        prodOp(promptdoc.setActive(docs.prompts(), shotId, kind, version)),
      /** 「回到自动编译」 — the saved versions stay, they are just not in force. */
      useCompiled: (shotId, kind) =>
        prodOp(promptdoc.useCompiled(docs.prompts(), shotId, kind)),
      setLocked: (shotId, kind, on) =>
        prodOp(promptdoc.setLocked(docs.prompts(), shotId, kind, on)),
    },

    // ---------------------------------------------------------------- //
    // 基础资产的提示词：把一个实体翻译成上面那本账的 key
    // ---------------------------------------------------------------- //
    basePrompt: {
      key: (kind, entityId, stateId = null) =>
        baseassets.basePromptKey(kind, entityId, stateId),
      /** The compiled prompt for one entity (optionally in one state). Returns
       *  `{ text, missing }`; `{ text: "", missing: [...] }` when the entity is gone. */
      compiled: (kind, entityId, stateId = null) => {
        const production = docs.production();
        const entity = kind === "character"
          ? bibledoc.findCharacter(production, entityId)
          : kind === "prop"
            ? bibledoc.findProp(production, entityId)
            : bibledoc.findLocation(production, entityId);
        if (!entity) return { text: "", missing: ["这个对象已不存在"] };
        const resolved = kind === "character"
          ? bibledoc.resolveCharacter(entity, stateId)
          // 道具没有状态，所以「解析」就是把 profile 摊平 —— 不假装走一遍 resolver，
          // 那会让读者以为道具也有状态覆盖（`bibledoc.sanitizeProp`）
          : kind === "prop"
            ? { ...entity, ...entity.profile }
            : bibledoc.resolveLocation(entity, stateId);
        // 构图规范来自 **Skill 包**（TASK-095 §2.2 / ADR-0067）。拿不到时传 null，
        // 由编译器 fail-closed 记进 `missing` —— 这里不兜一段默认文本，
        // 因为「少了规范」的后果是产出一张当不成参考图的图，不是一次报错。
        const spec = skills.promptBlock("base-asset-designer", `compositionSpec.${kind}`);
        return compileEntityBasePrompt({
          kind,
          entity: resolved,
          tone: confirmedGenreTone(),
          // a location's look is a statement about the world before it is about the
          // place — the World Setting's 视觉基调 is a real input, not decoration
          worldTone: kind === "location" ? (production.world.visualTone || "") : "",
          compositionSpec: spec.ok ? spec.text : null,
        });
      },
      /** The EFFECTIVE prompt + where it came from — a stored version overrides the
       *  compiled default, exactly like a shot prompt. */
      effective: (kind, entityId, stateId = null) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        const compiled = api.basePrompt.compiled(kind, entityId, stateId);
        if (!key) {
          return {
            ...compiled,
            source: "compiled",
            version: 0,
            locked: false,
            compiled: compiled.text,
            key: null,
          };
        }
        const eff = promptdoc.effectivePrompt(docs.prompts(), key, "image", compiled.text);
        return { ...eff, missing: compiled.missing, compiled: compiled.text, key };
      },
      entry: (kind, entityId, stateId = null) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        return key ? promptdoc.entryOf(docs.prompts(), key, "image") : null;
      },
      // 下面四个全部委托给 `api.prompt.*`：一个基础资产的提示词和一个镜头的提示词
      // 是**同一本账里的两个 key**，不是两套存储。走对象内部引用而不是 `ctx.prompt`
      // ——同一个对象少绕一次，依赖也就看得见了（§5.10 对 `ctx.timeline` 的处理）。
      save: (kind, entityId, stateId, text) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        if (!key) return 0;
        return api.prompt.save(key, "image", text, { origin: "manual" });
      },
      setActive: (kind, entityId, stateId, version) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        return !!key && api.prompt.setActive(key, "image", version);
      },
      useCompiled: (kind, entityId, stateId = null) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        return !!key && api.prompt.useCompiled(key, "image");
      },
      setLocked: (kind, entityId, stateId, on) => {
        const key = baseassets.basePromptKey(kind, entityId, stateId);
        return !!key && api.prompt.setLocked(key, "image", on);
      },
    },

    // ---------------------------------------------------------------- //
    // 「一键合成全部提示词」 (TASK-095 §2.3 / 批次 4D)
    //
    // **付费红线**：`start` 只建批次并取报价（预检是只读的，从不扣费）；
    // `confirm` 是 ADR-0041 的第二步，由创作者在界面上按下。本控制器不会自己确认。
    // ---------------------------------------------------------------- //
    promptBatch: {
      state: () => batchState.get(),
      /** 落盘 + 重渲染。一处写，让每条路径（含失败路径）都用它。 */
      _save: save,
      model: () => promptbatch.promptBatchModel(batchState.get(), wizardCounts()),
      start: () => {
        const pd = prodData();
        const made = promptbatch.startPromptBatch({
          shots: pd.draftShots || [],
          // **与那个计数同一份口径**（§2.6.2）：谁算「已合成」只有一处定义
          promptsOf: (shotId) => {
            const d = shotId ? shotDetailModel(pd, shotId) : null;
            if (!d) return null;
            return {
              image: !!(d.prompts.image && d.prompts.image.text.trim()),
              video: !!(d.prompts.video && d.prompts.video.text.trim()),
            };
          },
        });
        // 「没有要做的」先说清楚 —— 它不是一次失败（真实屏幕上第一次点这个按钮
        // 看到的是「没能建批次」，而真相是 60/60 都已经合成了）
        if (made.nothingToDo) {
          batchState.set(null);
          // `already` 是**清单**（哪些已经齐了），不是一个数字 —— 打印数组会得到
          // 一串对象；要数目就取长度。
          toast(made.already.length
            ? `没有需要合成的镜头 —— ${made.already.length} 个镜头两份提示词都已经齐了`
            : "这一集还没有镜头 —— 先去第 ① 步确认镜头");
          save(); // 状态变了就落盘 —— 只重渲染的话，刷新之后报价与已花多少全丢
          return null;
        }
        // 拒绝是**批次自己的状态**，不是一个单独的字段（batchpay 的合同）
        if (made.batch.state === "refused") {
          toast(`没能建批次：${made.batch.refusal ? made.batch.refusal.reason : "条目不合法"}`);
          batchState.set(made.batch);
          return save();
        }
        batchState.set(made.batch);
        toast(`${made.batch.items.length} 个镜头待合成 —— 正在向 Gateway 取总额（预检只读，不扣费）`);
        api.promptBatch._quote();
        return batchState.get();
      },
      /** 取报价。**总额来自 preflight**；拿不到就停在 draft，不编一个数。 */
      _quote: async () => {
        if (!batchState.get()) return null;
        // **await 之后世界可能已经变了**（codex round 3）：换项目、重新加载、放弃这一批
        // 都会换掉批次状态。把「取报价时它是哪一批、哪个项目」记下来，
        // 回来不是同一个就丢掉这次答复 —— 否则一份报价会被贴到另一批上。
        const forBatch = batchState.get();
        const forProject = projectName();
        const stillMine = () =>
          batchState.get() === forBatch && projectName() === forProject;
        const route = paidRoute();
        let answer = null;
        if (promptbatch.localComposeIsFree(route)) {
          // 本地编译不花钱 —— 这是关于**我们自己代码**的事实，由具名谓词说出来，
          // 而且照样走 `applyPreflight` 的三道校验（条数 / 币种 / 非负金额）。
          answer = promptbatch.localComposeQuote(forBatch.items.length);
        } else {
          try {
            answer = await preflight(forBatch);
          } catch (e) {
            toast(`预检失败：${e.message}`);
            // **失败也要落盘**（codex round 7 的 non-blocking）：这一批停在 `draft`，
            // 而界面给的出路是「重新取总额」—— 不落盘的话刷新就把它丢了，
            // 那条出路等于不存在。
            if (stillMine()) save();
            return null;
          }
          if (!answer) {
            // 付费路线拿不到答复时**不补一个数**（ADR-0071 决策 6 / §2.5f 第一条）。
            // 批次停在待报价，界面显示「还没有总额」。
            toast("没能从 Gateway 取到总额 —— 批次留在待报价，界面不自算");
            if (stillMine()) save();
            return null;
          }
        }
        if (!stillMine()) return null; // 换了项目或换了批次：这份答复已经无处可贴
        const applied = promptbatch.batchOps.applyPreflight(forBatch, answer);
        batchState.set(applied);
        if (applied.state === "refused") {
          toast(applied.refusal ? applied.refusal.reason : "预检拒绝了这一批");
        }
        return save();
      },
      /**
       * ADR-0041 第二步。创作者按的那一下 —— **并且真的把活干完**。
       *
       * 第一版只把状态推到 `running` 就返回：批次永远停在「进行中」，一条也没跑
       * （codex 本批 round 2 的 P1）。这是 §2.5e 那条「亮着但点进去什么也没发生」
       * 在批量上的形状。
       *
       * 这一批的「活」是什么，说清楚：**两份提示词是派生的**（`promptc` 纯编译），
       * 所以这一批不是去问模型，而是**逐镜编译一遍并如实报告哪几镜还编不出来**
       * （缺画面描述 / 缺运镜 / 参考没有用法规则……）。编不出来的镜记 `failed`
       * 并带原因 —— 失败不算成功，这是 batchpay 的第 4 条。
       */
      confirm: () => {
        if (!batchState.get()) return null;
        batchState.set(promptbatch.batchOps.confirmBatch(batchState.get(), now()));
        if (batchState.get().state !== "running") {
          toast("还不能开始：这一批还没有总额（ADR-0041 两步 —— 先预检，再确认）");
          return save();
        }
        const pd = prodData();
        for (const item of batchState.get().items) {
          if (batchState.get().state !== "running") break; // 中止立即生效
          const d = shotDetailModel(pd, item.id);
          const img = d && d.prompts.image ? d.prompts.image : null;
          const vid = d && d.prompts.video ? d.prompts.video : null;
          // 成败判据是**那个具名谓词**（生产与测试共用一份）：文本非空**且**没有参考
          // 被 fail-closed 扣下。只看非空会让批量说「60 镜全好了」，而其中几镜的角色
          // 设定图根本没送出去（codex round 3）。
          const verdict = promptbatch.composeOutcome({ image: img, video: vid });
          batchState.set(promptbatch.batchOps.recordItem(batchState.get(), item.id, verdict.ok
            // 本地编译不花钱 —— `spent: 0` 是「确知没花」，不是「不知道」
            ? { outcome: "success", spent: 0 }
            : { outcome: "failed", spent: 0, error: verdict.reasons.join("；") }));
        }
        const st = promptbatch.batchOps.settlement(batchState.get());
        toast(st.allSucceeded
          ? `${st.total} 个镜头的两份提示词都编出来了`
          : `${st.total} 镜里有 ${st.by.failed} 镜还编不出来 —— 展开看缺什么（没有花钱）`);
        return save();
      },
      /** 预检失败之后**还能重试**：`draft` 不是死局（codex round 3）。 */
      requote: () => {
        const cur = batchState.get();
        if (!cur || cur.state !== "draft") return null;
        api.promptBatch._quote();
        return batchState.get();
      },
      /** 关掉 / 放弃这一批。**正在跑的不许一键抹掉** —— 那会把「花过钱」也抹掉。 */
      discard: () => {
        const cur = batchState.get();
        if (!cur) return null;
        if (cur.state === "running") {
          toast("这一批正在跑 —— 先中止；中止后已经花掉的会照实留在账上");
          return cur;
        }
        batchState.set(null);
        persist(); // 一次就够（codex round 6：这里曾经连写两次）
        refresh();
        return null;
      },
      abort: () => {
        if (!batchState.get()) return null;
        batchState.set(promptbatch.batchOps.abortBatch(batchState.get(), now()));
        toast("已中止 —— 已经花掉的照实记账，迟到的回执仍然会被收下");
        return save();
      },
      /** 一镜的结果报回状态机。失败**不算成功**，花掉的钱如实记。 */
      record: (shotId, { outcome, spent = null, error = null } = {}) => {
        if (!batchState.get()) return null;
        batchState.set(
          promptbatch.batchOps.recordItem(batchState.get(), shotId, { outcome, spent, error })
        );
        return save();
      },
    },
  };

  return api;
}
