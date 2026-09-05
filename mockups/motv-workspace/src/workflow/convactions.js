// Agent 的可操作面 = 创作者的可操作面。
//
// 产品负责人 2026-08-29：「用户能够操作的前端的agent都应该可以操作。」
//
// 所以这里不是「再列一批 Agent 专用的编辑种类」，而是**一份注册表**：界面上创作者能
// 做的动作，登记在这里，Agent 的词汇表**由它生成**。加一个动作 = 加一条记录，
// 提示词、白名单、落地、界面文案四处同时跟上 —— 不会出现「提示里说能做，落地却没有」。
//
// 三条硬规矩（AGENTS.md §1「回不了头才问」+ 第 13 条）：
//
//   1. **只登记可逆的动作。** 判据不是「名字里有没有 delete」，而是**撤销的那条路存不存在**：
//      版本化写入（新版本，旧版本一字不动）可逆；软删除（打标记 + 回收区）可逆；
//      真删字节、绑定实体身份不可逆 —— 那不是「Agent 不够聪明」，是那条路径本身该先被
//      做成可逆的。每条动作都要显式写 `undo`：撤销它的那个动作 id，或它为什么天然可逆。
//   2. **付费不在表里。** 花钱是唯一必须问创作者的事。
//   3. **走创作者自己那条函数。** 每个 `apply` 调的都是界面按钮调的同一个 `ctx.*`，
//      所以 Agent 做的和他自己点的，结果、版本语义、撤销方式完全一致（ADR-0089 决策 2b）。
//
// 还没进表的（有意留白，不是遗漏）：`confirmPlan`（确认规划会绑定剧集身份，反悔不干净）、
// 删除类、运行/生成类（花钱）。它们仍然由创作者自己点。

/** 长文字段的上限，与数据模型自己的上限对齐（`storywork.editUnit` 是 200000）。
 *
 *  白名单默认把字符串砍到 4000 字 —— 那个数是给**模型输出**定的护栏，没问题。
 *  出事的是 ADR-0096 之后**界面按钮也走这张表**：故事核心与正文的编辑器每敲一个字
 *  就调 `work.core` / `unit.write`（`production.js:1855/1976`），于是他自己写的正文
 *  一过 4000 字就被静默切掉、当场落库 —— `editUnit` 那个 200000 的上限形同虚设，
 *  而他看到的是「现在有 4000 字」，不是一句报错（补审 2026-09-05 第二轮）。
 *
 *  「Agent 能做的 = 他能做的」这条路打通之后，**给模型定的护栏就成了给他定的护栏**。
 *  所以长文动作必须自己说出上限，而不是继承一个为别的目的选的数。 */
const LONG_TEXT = 200000;

/** 一条动作。`args` 是**白名单**：模型报上来的其它键一律不落进文档。 */
import * as swork from "./storywork.js";
import * as bwork from "./blocking.js";
// 「加一张次要参考图不顶掉当前主图」那条纯决策。它住在 workflow 层，所以这里
// 拿得到 —— 它原先在 `ui/workspaces.js`，那时候动作表要用它就得反向 import ui
// （撞 CA §2），于是状态级参考图那四个入口一直进不了表（TASK-129 切片 2e）。
import { nextStateRefsOnAdd } from "./bibledoc.js";

/** 那一镜的白膜。**与他在俯视图里拖的是同一份数据**（ADR-0094 决策 5）。 */
function blockingOf(ctx, shotId) {
  const id = String(shotId || "");
  if (!id) throw new Error("没说要改哪一镜的白膜");
  if (!ctx.blocking || typeof ctx.blocking.of !== "function") {
    throw new Error("这个项目还没有白膜的数据模型");
  }
  const b = ctx.blocking.of(id);
  if (!b) throw new Error(`没有这一镜：${id}`);
  return b;
}


/** 人物的可写栏位。**这份名单不是我编的，是 `bibledoc.CHARACTER_PROFILE_FIELDS`** ——
 *  上一版这里写着 background / speech / note 三个文档里根本不存在的栏，
 *  而 `updateCharacterProfile` 只认自己那张表，于是那三栏**被静默丢掉**：
 *  动作报「改好了」，角色设计上什么都没多出来（2026-08-31 实测）。 */
const CHAR_FIELDS = [
  "identity", "personality", "desire", "weakness", "coreConflict", "arc",
  "appearance", "costume", "visualInstruction",
];

/** 关系的可写栏位（`canondoc.RELATIONSHIP_FIELDS`）。同上：上一版的 `nature`
 *  在文档里叫 `basis`。 */
/** 场景地的可写栏位（`bibledoc.updateLocationProfile` 只认这两个）。 */
const LOC_FIELDS = ["description", "visualInstruction"];

const REL_FIELDS = [
  "basis", "aToB", "bToA", "coreConflict", "tension", "power",
  "history", "secrets", "direction", "arc", "forbidden",
];

/** 按名字拿人物 —— **没有就新建**。
 *
 *  产品负责人 2026-08-31 让 Agent 把故事核心里的三个人物搬进角色设计，三条全落空：
 *  「人物里没有「林照」」。原因不是他写错了，是这张表**只会改、不会加** ——
 *  而他的角色设计本来就是空的，于是每一条都必然失败。
 *
 *  同一个文件里的 `blocking.actor` 早就是「没有就新建」，人物和关系只是漏了。
 *  新建可逆（角色设计里能删），所以按 AGENTS.md §1 它就该直接做。
 *  重名/错字会多出一个人物 —— 代价是他看得见、删得掉，因此 `said` 里**必须明说
 *  是新建的**，不能混在「改好了」里。 */
function ensureCharacter(ctx, who) {
  const list = (ctx.prodData().production.characters) || [];
  const rec = list.find((c) => c.characterId === who || c.name === who);
  if (rec) return { rec, created: false };
  if (!ctx.bible || typeof ctx.bible.addCharacter !== "function") {
    throw new Error(`人物里没有「${who}」，这个项目也加不了人物`);
  }
  const made = ctx.bible.addCharacter(who, "formal");
  if (!made) throw new Error(`加不了人物「${who}」`);
  return { rec: made, created: true };
}

/** 按名字或 id 找一条活着的记录，**找不到就抛**（与 `ensure*` 的差别：不新建）。
 *
 *  改名 / 删除 / 拿回来针对的是一个**已经存在**的身份。为了执行它先造一个出来，
 *  会让「删掉张三」在打错字时安静地新建一个张三又删掉它 —— 什么都没发生，
 *  回执却说成功了。 */
function mustFind(ctx, key, who, label) {
  if (!ctx.bible) throw new Error(`这个项目没有${label}`);
  const name = String(who || "").trim();
  if (!name) throw new Error(`没说是哪个${label}`);
  const idKey = key === "characters" ? "characterId" : "locationId";
  const list = (ctx.prodData().production[key]) || [];
  const rec = list.find((x) => x[idKey] === name || x.name === name);
  if (!rec) throw new Error(`${label}里没有「${name}」`);
  return rec;
}

/** 同上，但找的是**回收区**里的那些。 */
function mustFindDeleted(ctx, key, idKey, who, label) {
  if (!ctx.bible) throw new Error(`这个项目没有${label}`);
  const name = String(who || "").trim();
  if (!name) throw new Error(`没说要拿回哪个${label}`);
  const list = (ctx.prodData().production[key]) || [];
  const rec = list.find((x) => x[idKey] === name || x.name === name);
  if (!rec) throw new Error(`回收区里没有${label}「${name}」`);
  return rec;
}

/** 人物**或**场景地 —— 参考图挂在两类实体上，解析也就得认两类。
 *
 *  返回 `{ id, name }` 而不是原记录：调用方只需要这两样，返回整条会让人以为
 *  可以就地改它（那条路只有 `ctx.bible.*` 能走）。 */
function mustFindEntity(ctx, who) {
  if (!ctx.bible) throw new Error("这个项目没有作品设定");
  const name = String(who || "").trim();
  if (!name) throw new Error("没说是哪个人物或场景地");
  const prod = ctx.prodData().production;
  const c = (prod.characters || []).find((x) => x.characterId === name || x.name === name);
  if (c) return { id: c.characterId, name: c.name };
  const l = (prod.locations || []).find((x) => x.locationId === name || x.name === name);
  if (l) return { id: l.locationId, name: l.name };
  throw new Error(`人物和场景地里都没有「${name}」`);
}

/**
 * 一类实体的状态动作（add / rename / remove / restore / fields），派生出来的。
 *
 * 人物和场景地的状态是**同一套机制** —— 同一个 `stateId` 命名空间、同一组转换、
 * 同一条「状态覆盖表现，不改身份」的规矩。差别只有归属实体和可覆盖字段白名单。
 * 手写两遍的话，两边会随时间长出细微差异，而「同一件事有两处陈述」正是这个仓库
 * 反复在修的形状（TASK-087 §7）。
 *
 * `kind` 同时是动作 id 的前缀（`character.state.*` / `location.state.*`），
 * 所以合同里的前缀归属检查不用额外开口子。
 */
function stateActions(kind, spec) {
  const { label, listKey, idKey } = spec;
  const findOwner = (ctx, who) => mustFind(ctx, listKey, who, label);
  const findState = (owner, sid, where = "states") =>
    (owner[where] || []).find((s) => s.stateId === sid || s.name === sid) || null;
  /** 解析「哪个实体的哪个状态」—— 四条参考图动作都要它，抽出来免得写四遍。 */
  const mustState = (ctx, sp, a) => {
    const owner = mustFind(ctx, sp.listKey, a.name, sp.label);
    const st = findState(owner, String(a.state || ""));
    if (!st) throw new Error(`「${owner.name}」没有状态「${a.state}」`);
    return { owner, st };
  };
  /** 整份写回 overrides。写路径只有这一条 —— 四个入口各自拼一次 `ctx.bible.*`
   *  的话，哪天签名变了就会漏改其中一两个。 */
  const writeOverrides = (ctx, k, owner, sp, st, next) => {
    const fn = `set${k[0].toUpperCase() + k.slice(1)}StateOverrides`;
    if (!ctx.bible || !ctx.bible[fn]) throw new Error(`这个项目改不了${sp.label}状态`);
    if (!ctx.bible[fn](owner[sp.idKey], st.stateId, next)) {
      throw new Error(`改不了「${owner.name}」状态「${st.name}」的参考图`);
    }
  };
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  // `ctx.bible` 上的方法名是 addCharacterState / addLocationState 这种拼法
  const m = (verb) => `${verb}${cap(kind)}State`;
  return [
    {
      id: `${kind}.state.add`,
      label: `给${label}加一个状态`,
      doc: "bible",
      undo: `${kind}.state.remove（软删除，回收区里拿得回来）`,
      args: { name: `${label}名字或 id`, state: "状态名（如：少女时期 / 夜晚）" },
      apply: (ctx, a) => {
        const owner = findOwner(ctx, a.name);
        const nm = String(a.state || "").trim();
        if (!nm) throw new Error("没说状态叫什么");
        const rec = ctx.bible[m("add")](owner[idKey], nm);
        if (!rec) throw new Error(`加不了「${owner.name}」的状态「${nm}」`);
        return { said: `「${owner.name}」加了状态「${rec.name}」`, stateId: rec.stateId };
      },
    },
    {
      id: `${kind}.state.rename`,
      label: `给${label}的状态改名`,
      doc: "bible",
      undo: "改回去就行（状态身份不变，引用它的场景一个不动）",
      args: { name: `${label}名字或 id`, state: "现在的状态名或 id", to: "新名字" },
      apply: (ctx, a) => {
        const owner = findOwner(ctx, a.name);
        const st = findState(owner, String(a.state || ""));
        if (!st) throw new Error(`「${owner.name}」没有状态「${a.state}」`);
        const to = String(a.to || "").trim();
        if (!to) throw new Error("没说改成什么名字");
        if (!ctx.bible[m("rename")](owner[idKey], st.stateId, to)) {
          throw new Error(`改不了状态「${st.name}」的名字`);
        }
        return { said: `「${owner.name}」的状态「${st.name}」改名为「${to}」` };
      },
    },
    {
      id: `${kind}.state.remove`,
      label: `删掉${label}的一个状态`,
      doc: "bible",
      undo: `${kind}.state.restore —— 软删除，回收区里拿得回来`,
      args: { name: `${label}名字或 id`, state: "状态名或 id" },
      apply: (ctx, a) => {
        const owner = findOwner(ctx, a.name);
        const st = findState(owner, String(a.state || ""));
        if (!st) throw new Error(`「${owner.name}」没有状态「${a.state}」`);
        if (!ctx.bible[m("remove")](owner[idKey], st.stateId)) {
          throw new Error(`还有场景以「${st.name}」这个状态引用着「${owner.name}」，先换掉那些引用`);
        }
        return { said: `删掉了「${owner.name}」的状态「${st.name}」（回收区里还能拿回来）` };
      },
    },
    {
      id: `${kind}.state.restore`,
      label: `把删掉的${label}状态拿回来`,
      doc: "bible",
      undo: `${kind}.state.remove`,
      args: { name: `${label}名字或 id`, state: "状态名或 id" },
      apply: (ctx, a) => {
        const owner = findOwner(ctx, a.name);
        const st = findState(owner, String(a.state || ""), "deletedStates");
        if (!st) throw new Error(`「${owner.name}」的回收区里没有状态「${a.state}」`);
        if (!ctx.bible[`undelete${cap(kind)}State`](owner[idKey], st.stateId)) {
          throw new Error(`拿不回状态「${st.name}」`);
        }
        return { said: `「${owner.name}」的状态「${st.name}」回来了` };
      },
    },
    // --- 状态级参考图（TASK-129 切片 2e） ------------------------------- //
    //
    // 这四条写的都是同一个 `overrides` 对象，只是算法不同。**整份替换**是它们的
    // 本性（不像字段那样按栏合并）—— 所以每一条都得自己先读出当前 overrides、
    // 算出下一份，再整份写回去。
    {
      id: `${kind}.state.reference.add`,
      label: `给${label}的某个状态挂一张参考图`,
      doc: "bible",
      undo: `${kind}.state.reference.remove`,
      args: { name: `${label}名字或 id`, state: "状态名或 id", assetId: "资产 id" },
      apply: (ctx, a) => {
        const { owner, st } = mustState(ctx, spec, a);
        const assetId = String(a.assetId || "").trim();
        if (!assetId) throw new Error("没说挂哪张图");
        // **加次要图不顶掉当前主图** —— 那条决策住在 bibledoc，两边共用一份
        const next = nextStateRefsOnAdd(owner, st.overrides || {}, assetId);
        if (!next) throw new Error("这个状态上已经有这张图了");
        writeOverrides(ctx, kind, owner, spec, st, next);
        return { said: `「${owner.name}」的状态「${st.name}」挂上了一张参考图` };
      },
    },
    {
      id: `${kind}.state.reference.remove`,
      label: `把${label}某个状态上的参考图摘下来`,
      doc: "bible",
      undo: `${kind}.state.reference.add`,
      args: { name: `${label}名字或 id`, state: "状态名或 id", assetId: "资产 id" },
      apply: (ctx, a) => {
        const { owner, st } = mustState(ctx, spec, a);
        const assetId = String(a.assetId || "");
        const ov = st.overrides || {};
        const cur = Array.isArray(ov.referenceAssetIds) ? ov.referenceAssetIds : null;
        if (!cur || !cur.includes(assetId)) throw new Error("这个状态上没有这张图");
        const refs = cur.filter((x) => x !== assetId);
        const next = { ...ov, referenceAssetIds: refs };
        // 摘掉的正好是主图时，主图位让给下一张；一张不剩就是「没有主图」
        if (next.activeReferenceAssetId === assetId) next.activeReferenceAssetId = refs[0] ?? null;
        writeOverrides(ctx, kind, owner, spec, st, next);
        return { said: `从「${owner.name}」的状态「${st.name}」摘下了一张参考图` };
      },
    },
    {
      id: `${kind}.state.reference.reset`,
      label: `让${label}的某个状态改回继承基础参考图`,
      doc: "bible",
      undo: "重新挂上那几张就是了（覆盖一旦撤掉，原来挂了哪几张就不记得了）",
      args: { name: `${label}名字或 id`, state: "状态名或 id" },
      apply: (ctx, a) => {
        const { owner, st } = mustState(ctx, spec, a);
        const ov = st.overrides || {};
        if (!("referenceAssetIds" in ov)) throw new Error("这个状态本来就在继承基础参考图");
        // 两个键一起删 —— 只删清单留下主图指针，会得到一个指着不存在清单的主图
        const next = { ...ov };
        delete next.referenceAssetIds;
        delete next.activeReferenceAssetId;
        writeOverrides(ctx, kind, owner, spec, st, next);
        return { said: `「${owner.name}」的状态「${st.name}」改回继承基础参考图` };
      },
    },
    {
      id: `${kind}.state.reference.setActive`,
      label: `把${label}某个状态的主图换成这一张`,
      doc: "bible",
      undo: "设回原来那张（只动指针，一张图都没有增删）",
      args: { name: `${label}名字或 id`, state: "状态名或 id", assetId: "资产 id" },
      apply: (ctx, a) => {
        const { owner, st } = mustState(ctx, spec, a);
        const assetId = String(a.assetId || "");
        const ov = st.overrides || {};
        const cur = Array.isArray(ov.referenceAssetIds) ? ov.referenceAssetIds : [];
        // 只能在**这个状态自己挂着的**那几张里选：指向一张它没挂的图，
        // 等于一个指不到东西的主图指针
        if (!cur.includes(assetId)) throw new Error("这个状态上没有挂这张图，设不了主图");
        writeOverrides(ctx, kind, owner, spec, st, { ...ov, activeReferenceAssetId: assetId });
        return { said: `「${owner.name}」的状态「${st.name}」换了主图` };
      },
    },
    {
      id: `${kind}.state.fields`,
      label: `改${label}某个状态覆盖了什么`,
      doc: "bible",
      undo: "改回去就行；写空字符串 = 这一栏回到继承基础档案",
      args: { name: `${label}名字或 id`, state: "状态名或 id", ...spec.fields },
      apply: (ctx, a) => {
        const owner = findOwner(ctx, a.name);
        const st = findState(owner, String(a.state || ""));
        if (!st) throw new Error(`「${owner.name}」没有状态「${a.state}」`);
        // **合并，不整份替换**：只带来的那几栏落进去，其余原样保留。整份替换会让
        // 「补一句服装」把他手写的外貌清空 —— `updateWorldSetting` 那条同样的规矩。
        const next = { ...(st.overrides || {}) };
        let n = 0;
        for (const k of Object.keys(spec.fields)) {
          if (typeof a[k] !== "string") continue;
          n += 1;
          // `voiceDescription` 落在**嵌套**的 `voice.description` 上，不是平铺一栏。
          // 状态只能改声音的**表现**，改不了声音身份（`voiceId` 会被 bibledoc 的
          // 白名单剥掉）—— 一个人物只有一个声音，那是 VOICE RULE，不是这里能松的。
          if (k === "voiceDescription") {
            const v = { ...(next.voice || {}) };
            if (a[k]) v.description = a[k];
            else delete v.description;
            if (Object.keys(v).length) next.voice = v;
            else delete next.voice;
            continue;
          }
          if (a[k]) next[k] = a[k];
          else delete next[k]; // 空 = 回到继承，不是写一个空串
        }
        if (!n) throw new Error("没说要覆盖哪一栏");
        if (!ctx.bible[`set${cap(kind)}StateOverrides`](owner[idKey], st.stateId, next)) {
          throw new Error(`改不了「${owner.name}」状态「${st.name}」的覆盖`);
        }
        return { said: `「${owner.name}」的状态「${st.name}」改了 ${n} 栏` };
      },
    },
  ];
}

/** 一段关系的两头是不是这两个人（`characterIds`，不是 `aId/bId`）。
 *
 *  字段名值得留一句：`r.aId` / `r.aName` 在这份文档里**根本不存在**，而按它们去找
 *  会安静地永远找不到 —— 于是「就算关系已经建好也照报『没有这段关系』」。
 *  这个坑 `relationship.fields` 踩过一次，写在这里免得第三次。 */
function relBetween(ctx, aId, bId) {
  const list = (ctx.prodData().production.relationships) || [];
  const has = (r, id) => (r.characterIds || []).includes(id);
  return list.find((r) => has(r, aId) && has(r, bId)) || null;
}

/** 解析「哪一段关系」：界面给 `relationshipId`，Agent 给两个人物名字。
 *
 *  **不新建人物**（与 `relationship.add` 的差别）：删除和改方向针对的是一段
 *  已经存在的关系，为了执行它而先造一个人物出来是荒谬的。 */
function resolveRel(ctx, x) {
  if (!ctx.canon) throw new Error("这个项目没有人物关系");
  const list = (ctx.prodData().production.relationships) || [];
  const rid = String(x.relationshipId || "").trim();
  if (rid) {
    const rec = list.find((r) => r.relationshipId === rid);
    if (!rec) throw new Error(`没有这段关系：${rid}`);
    return rec;
  }
  const an = String(x.a || "").trim();
  const bn = String(x.b || "").trim();
  if (!an || !bn) throw new Error("没说是哪一段关系（给 relationshipId，或者两个人物名字）");
  const chars = (ctx.prodData().production.characters) || [];
  const A = chars.find((c) => c.characterId === an || c.name === an);
  const B = chars.find((c) => c.characterId === bn || c.name === bn);
  if (!A || !B) throw new Error(`人物里没有「${!A ? an : bn}」`);
  const rec = relBetween(ctx, A.characterId, B.characterId);
  if (!rec) throw new Error(`「${an} — ${bn}」之间还没有关系`);
  return rec;
}

/** 按名字拿场景地 —— **没有就新建**（同 `ensureCharacter`）。 */
function ensureLocation(ctx, who) {
  const list = (ctx.prodData().production.locations) || [];
  const rec = list.find((l) => l.locationId === who || l.name === who);
  if (rec) return { rec, created: false };
  if (!ctx.bible || typeof ctx.bible.addLocation !== "function") {
    throw new Error(`场景地里没有「${who}」，这个项目也加不了场景地`);
  }
  const made = ctx.bible.addLocation(who);
  if (!made) throw new Error(`加不了场景地「${who}」`);
  return { rec: made, created: true };
}

/** 这四页的正式数据模型。写路径**只有这一条** —— 他自己点、Agent 调，走的是同一组函数
 *  （产品负责人 2026-08-30：「Agent 修改的是正式数据模型，不是只修改 UI 展示文本」）。 */
function workOf(ctx) {
  const doc = ctx && ctx.story && typeof ctx.story.doc === "function" ? ctx.story.doc() : null;
  if (!doc || !doc.work) throw new Error("这个项目还没有故事开发的数据模型");
  return doc.work;
}

const ACTIONS = [
  {
    id: "brief.idea",
    label: "改核心创意",
    doc: "brief",
    undo: "写成新的一版，旧版本一字不动",
    args: { text: "一句话的核心创意" },
    apply: (ctx, a) => {
      ctx.story.setIdea(String(a.text || ""));
      return { versioned: "brief", said: `核心创意 → ${String(a.text || "").slice(0, 60)}` };
    },
  },
  {
    id: "brief.fields",
    label: "改创意简报",
    doc: "brief",
    undo: "写成新的一版，旧版本一字不动",
    fields: {
      genre: "类型/题材", tone: "基调", form: "形态",
      episodeDuration: "每集时长", totalDuration: "总时长", notes: "备注",
      targetEpisodes: "目标集数（整数 1–50）",
    },
    apply: (ctx, a) => {
      ctx.story.editBrief(a.fields);
      return { versioned: "brief", said: describe(a.fields, ACTION_BY_ID["brief.fields"].fields) };
    },
  },
  {
    id: "brief.setActive",
    label: "改用创意简报的某一版",
    doc: "brief",
    undo: "brief.setActive（指针，切回去就行）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.setActiveBrief(v)) throw new Error(`没有创意简报 v${a.v}`);
      return { said: `下游改用创意简报 v${v}` };
    },
  },
  {
    id: "brief.commit",
    label: "把创意简报存为新版本",
    doc: "brief",
    undo: "旧版本一字不动，随时切回去",
    args: { note: "这一版的说明（可选）" },
    apply: (ctx, a) => {
      // 界面「保存为新版本」按钮做的事；Agent 侧 `applyConversationEdits` 在 brief.* 之后
      // 自动做同一件事 —— 两边现在都从这张表里找得到它（TASK-127）。
      const rec = ctx.story.commitBrief("manual", String(a.note || ""));
      return rec && rec.v ? { said: `创意简报存为 v${rec.v}`, version: rec.v } : { said: "与当前版本没有差异，未新建版本" };
    },
  },
  {
    id: "outline.fields",
    label: "改故事大纲",
    doc: "outline",
    undo: "写成新的一版，旧版本一字不动",
    fields: {
      logline: "一句话故事", storyCore: "故事内核", premise: "前提",
      genreTone: "类型与调性", world: "世界", centralConflict: "核心冲突",
      storyArc: "故事弧", climax: "高潮", ending: "结局", durationNote: "时长说明",
      protagonist: "主角（who / initialWant）",
      conflict: "冲突（external / internal）",
      themeAndChange: "主题与转变（theme / protagonistBecomes）",
      mainline: "主线（setup / development / midpointTurn / climax / ending）",
      worldAndRules: "世界与规则（where）",
      episodeCount: "集数（整数 1–50）",
    },
    apply: (ctx, a, meta) => {
      const rec = ctx.story.applyManualOutline(a.fields, "developed", (meta && meta.instruction) || "");
      const said = describe(a.fields, ACTION_BY_ID["outline.fields"].fields);
      // `version` 是这次写入的**稳定身份**（TASK-119）：跨层一致性诊断以它作幂等
      // key，所以它必须是文档给的那个数，不是从 `said` 里再解析一次的字符串。
      return { said: `${said}（故事大纲 v${rec && rec.v ? rec.v : "?"}）`, version: rec && rec.v };
    },
  },
  {
    id: "outline.approve",
    label: "批准故事大纲",
    doc: "outline",
    undo: "outline.approve（改批别的版本）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.approveOutline(v)) throw new Error(`没有故事大纲 v${a.v}`);
      return { said: `已批准故事大纲 v${v}`, version: v };
    },
  },
  {
    id: "outline.setActive",
    label: "改用故事大纲的某一版",
    doc: "outline",
    undo: "outline.setActive（指针，切回去就行）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      if (!ctx.story.setActiveOutline(v)) throw new Error(`没有故事大纲 v${a.v}`);
      return { said: `下游改用故事大纲 v${v}` };
    },
  },
  {
    id: "plan.entry",
    label: "改分集规划的一条",
    doc: "plan",
    undo: "改回来；未保存前它只在工作草稿里",
    args: {
      episodeId: "这一集的 id", field: "字段名（title / logline / …）", value: "新内容",
    },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanEntry(String(a.episodeId), String(a.field), String(a.value ?? ""));
      if (!ok) throw new Error(`改不了 ${a.episodeId} 的 ${a.field}`);
      return { said: `${a.episodeId} 的 ${a.field} → ${String(a.value ?? "").slice(0, 60)}`, draft: "plan" };
    },
  },
  {
    id: "plan.save",
    label: "把分集规划的修改保存为新一版",
    doc: "plan",
    undo: "写成新的一版，旧版本一字不动",
    args: {},
    apply: (ctx) => {
      const v = ctx.story.savePlanDraft();
      if (!v) return { said: "分集规划与当前版本没有差异，未新建版本" };
      // 确认（绑定剧集）仍然由创作者自己点 —— 见文件头的留白说明
      return {
        said: `分集规划已保存为 v${v}（要让下游剧集改用它，还需你在页面上确认这一版）`,
        version: v,
      };
    },
  },
  {
    id: "plan.item.add",
    label: "分集规划的列表格加一行",
    doc: "plan",
    undo: "plan.item.remove，或 plan.discard 回到已保存的版本（草稿层）",
    args: { episodeId: "这一集的 id", field: "列表字段名（mainPlot / reveals / beats …）" },
    apply: (ctx, a) => {
      const i = ctx.story.addPlanItem(String(a.episodeId || ""), String(a.field || ""));
      if (!(i >= 0)) throw new Error("这一行不在当前这一版规划里，加不了");
      return { said: `${a.field} 加了第 ${i + 1} 行` };
    },
  },
  {
    id: "plan.item.edit",
    label: "改分集规划列表格的一行",
    doc: "plan",
    undo: "改回去就行；已保存的版本一字不动",
    args: { episodeId: "这一集的 id", field: "列表字段名", index: "第几行（从 0 起）", value: "新内容" },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanItem(
        String(a.episodeId || ""), String(a.field || ""), Number(a.index), String(a.value ?? ""),
      );
      if (!ok) throw new Error(`改不了 ${a.field} 第 ${a.index} 行`);
      return { said: `${a.field} 第 ${Number(a.index) + 1} 行改好了` };
    },
  },
  {
    id: "plan.item.beat",
    label: "改「角色推进」的一格",
    doc: "plan",
    undo: "改回去就行；已保存的版本一字不动",
    args: { episodeId: "这一集的 id", index: "第几行（从 0 起）", key: "列（who / change …）", value: "新内容" },
    apply: (ctx, a) => {
      const ok = ctx.story.editPlanBeat(
        String(a.episodeId || ""), Number(a.index), String(a.key || ""), String(a.value ?? ""),
      );
      if (!ok) throw new Error(`改不了角色推进第 ${a.index} 行的 ${a.key}`);
      return { said: `角色推进第 ${Number(a.index) + 1} 行的 ${a.key} 改好了` };
    },
  },
  {
    id: "plan.item.remove",
    label: "删分集规划列表格的一行",
    doc: "plan",
    undo: "草稿层：plan.discard 回到已保存的版本；已保存版本一字不动",
    args: { episodeId: "这一集的 id", field: "列表字段名", index: "第几行（从 0 起）" },
    apply: (ctx, a) => {
      const ok = ctx.story.removePlanItem(String(a.episodeId || ""), String(a.field || ""), Number(a.index));
      if (!ok) throw new Error(`删不了 ${a.field} 第 ${a.index} 行`);
      return { said: `${a.field} 第 ${Number(a.index) + 1} 行删了（未保存前 plan.discard 可整体回退）` };
    },
  },
  {
    id: "plan.discard",
    label: "丢弃分集规划的未保存草稿",
    doc: "plan",
    undo: "只丢草稿；已保存的版本一字不动",
    args: {},
    apply: (ctx) => {
      const ok = ctx.story.discardPlanDraft();
      return { said: ok ? "分集规划回到最近保存的那一版" : "没有未保存的草稿" };
    },
  },
  {
    id: "settings.delivery",
    label: "改交付规格",
    doc: "settings",
    undo: "settings.delivery（改回原值或留空清除）",
    args: { field: "规格字段", value: "新值（留空表示清除）" },
    apply: (ctx, a) => {
      const res = ctx.setDeliverySpecField(String(a.field), a.value);
      if (!res || !res.ok) throw new Error((res && res.error) || "改不了这个规格字段");
      return { said: `${a.field} → ${res.cleared ? "（已清除）" : String(a.value).slice(0, 60)}` };
    },
  },
  // --- 删除（一律软删除，回收区可撤销）---------------------------------- //
  //
  // 产品负责人 2026-08-29：「不管是故事还是镜头。应该都可以有删除的选项。不然画面会很乱。」
  // 他自己在界面上能删，那 Agent 就能删 —— 前提同上：**撤销那条路存在**。
  {
    id: "brief.hideVersion",
    label: "删除创意简报的某一版",
    doc: "brief",
    undo: "brief.restoreVersion（版本链一字不动，只是不再显示）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.hideBriefVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `删不掉创意简报 v${a.v}`);
      return { said: `已删除创意简报 v${v}（在回收区可以撤销）` };
    },
  },
  {
    id: "brief.restoreVersion",
    label: "撤销删除创意简报的某一版",
    doc: "brief",
    undo: "brief.hideVersion",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.restoreBriefVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `撤销不了 v${a.v}`);
      return { said: `创意简报 v${v} 回来了` };
    },
  },
  {
    id: "outline.hideVersion",
    label: "删除故事大纲的某一版",
    doc: "outline",
    undo: "outline.restoreVersion（版本链一字不动，只是不再显示）",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.hideOutlineVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `删不掉故事大纲 v${a.v}`);
      return { said: `已删除故事大纲 v${v}（在回收区可以撤销）` };
    },
  },
  {
    id: "outline.restoreVersion",
    label: "撤销删除故事大纲的某一版",
    doc: "outline",
    undo: "outline.hideVersion",
    args: { v: "版本号" },
    apply: (ctx, a) => {
      const v = Number(a.v);
      const r = ctx.story.restoreOutlineVersion(v);
      if (!r || !r.ok) throw new Error((r && r.error) || `撤销不了 v${a.v}`);
      return { said: `故事大纲 v${v} 回来了` };
    },
  },
  {
    id: "shot.hide",
    label: "删除一个镜头",
    doc: "shots",
    undo: "shot.restore（镜头进回收区，内容一字不动）",
    args: { shotId: "镜头 id" },
    apply: (ctx, a) => {
      const id = String(a.shotId || "");
      if (!ctx.shots || !ctx.shots.softDelete(id)) throw new Error(`删不掉镜头 ${id}（草稿里没有它）`);
      return { said: `已删除镜头 ${id}（在回收区可以撤销）` };
    },
  },
  {
    id: "shot.restore",
    label: "撤销删除一个镜头",
    doc: "shots",
    undo: "shot.hide",
    args: { shotId: "镜头 id" },
    apply: (ctx, a) => {
      const id = String(a.shotId || "");
      if (!ctx.shots || !ctx.shots.restoreDeleted(id)) throw new Error(`撤销不了 ${id}（回收区里没有它）`);
      return { said: `镜头 ${id} 回来了` };
    },
  },
  /* ===== 3D 导演台（TASK-123 / ADR-0094 决策 5）===========================
     「把镜头拉远一点」「让林晚从门口走到吧台」——这类话要能落成真改动，而不是一段
     建议文字。走的是他自己在俯视图里拖时的同一组函数。 */
  /* ===== 定稿版本：看得见，也要改得动（2026-08-31）=======================
     产品负责人：「你要保证服务端的 agent 可以看到所有我定稿的东西然后也可以根据我的
     意见修改。」看得见那一半在 server.py 的事实里；改得动这一半在这里 ——
     他说「回到定稿那版」「把 v2 删了」时，要能落成真动作。 */
  {
    id: "work.restoreVersion",
    label: "恢复到某一版定稿",
    doc: "work",
    undo: "所有定稿版本都还在，随时切回去",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.restoreFinalized(work, unit.id, v, at)) throw new Error(`没有 v${a.v}`);
        return { said: `第 ${a.no} 章/集回到了 v${v}` };
      }
      if (!swork.restoreDoc(work, String(a.what), v, at)) throw new Error(`没有 v${a.v}`);
      return { said: `已恢复到 v${v}（其它定稿版本一个没删）` };
    },
  },
  {
    id: "work.deleteVersion",
    label: "删掉某一版定稿",
    doc: "work",
    // **这句 `undo` 上一版是假的**：它写着「删掉就没有了」，而 `deleteDoc` 真删字节。
    // 这条动作又没声明 `reversible: false`，于是被默认补成可逆、混过了准入检查 ——
    // 那道「不可逆的不许进表」的检查因此形同虚设（补审 2026-09-05 · AGENTS.md §1）。
    // 现在删的是标记，回收区里还能拿回来，这句话才成立。
    undo: "work.undeleteVersion —— 软删除，回收区里能恢复；当前内容始终不动",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.deleteFinalized(work, unit.id, v, at)) throw new Error(`没有 v${a.v}`);
      } else if (!swork.deleteDoc(work, String(a.what), v, at)) {
        throw new Error(`没有 v${a.v}`);
      }
      ctx.persist();
      return { said: `删掉了 v${v}（当前内容没有动；回收区里还能恢复）` };
    },
  },
  {
    id: "work.undeleteVersion",
    label: "把删掉的那一版拿回来",
    doc: "work",
    undo: "work.deleteVersion",
    args: { what: "core / outline / plan / unit", v: "版本号", no: "unit 时是第几章/集" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const v = Number(a.v);
      if (String(a.what) === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        if (!swork.undeleteFinalized(work, unit.id, v)) throw new Error(`回收区里没有 v${a.v}`);
      } else if (!swork.undeleteDoc(work, String(a.what), v)) {
        throw new Error(`回收区里没有 v${a.v}`);
      }
      ctx.persist();
      return { said: `v${v} 回来了` };
    },
  },

  /* ===== 作品设定：人物 / 人物关系 / 世界观 ==============================
     他在那三页能改的，Agent 也要能改（REQ-006 判据 1）。这些是「基础财产」——
     后面写小说、做剧集都读它们。 */
  {
    id: "character.tier",
    label: "把人物设为正式 / 临时角色",
    doc: "bible",
    undo: "再切回去就行；剧情身份、参考图、出场与关系全部保留",
    args: { name: "人物名字（或 id）", tier: "formal（正式）或 bit（临时）" },
    apply: (ctx, a) => {
      const tier = a.tier === "bit" ? "bit" : a.tier === "formal" ? "formal" : null;
      if (!tier) throw new Error("tier 只能是 formal 或 bit");
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说是哪个人物");
      const list = (ctx.prodData().production.characters) || [];
      const rec = list.find((c) => c.characterId === who || c.name === who);
      if (!rec) throw new Error(`人物里没有「${who}」`);
      if (!ctx.bible.setCharacterTier(rec.characterId, tier)) throw new Error(`改不了「${rec.name}」的类型`);
      return { said: `「${rec.name}」现在是${tier === "bit" ? "临时角色" : "正式角色"}` };
    },
  },
  {
    id: "character.add",
    label: "新建人物",
    doc: "bible",
    undo: "角色设计里能删（软删除 + 回收区）",
    args: { name: "人物名", tier: "formal（正式，默认）或 bit（临时角色）" },
    apply: (ctx, a) => {
      const name = String(a.name || "").trim();
      if (!name) throw new Error("没说人物叫什么");
      const tier = a.tier === "bit" ? "bit" : "formal";
      const rec = ctx.bible.addCharacter(name, tier);
      if (!rec) throw new Error(`加不了人物「${name}」`);
      return { said: `新建了${tier === "bit" ? "临时角色" : "人物"}「${name}」`, characterId: rec.characterId };
    },
  },
  {
    id: "location.add",
    label: "新建场景地",
    doc: "bible",
    undo: "场景设计里能删（软删除 + 回收区）",
    args: { name: "场景地名" },
    apply: (ctx, a) => {
      const name = String(a.name || "").trim();
      if (!name) throw new Error("没说场景地叫什么");
      const rec = ctx.bible.addLocation(name);
      if (!rec) throw new Error(`加不了场景地「${name}」`);
      return { said: `新建了场景地「${name}」`, locationId: rec.locationId };
    },
  },
  {
    id: "character.fields",
    label: "加/改一个人物的设定（人物不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的人物在角色设计里能删",
    args: {
      name: "人物名字（或 id）—— 角色设计里没有这个人就新建一个",
      identity: "身份", personality: "性格", desire: "欲望 / 目标",
      weakness: "弱点", coreConflict: "核心矛盾", arc: "Character Arc（弧光）",
      appearance: "外貌", costume: "服装", visualInstruction: "基础视觉方向 / 画面指令",
    },
    apply: (ctx, a) => {
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说要改哪个人物");
      // 先确认改得动，再建人物。反过来的话，一次失败会留下一个空人物，
      // 而这个文件的约定是「抛错 = 没落下」（补审 2026-09-05 第二轮）。
      if (!ctx.bible || !ctx.bible.updateCharacterProfile) throw new Error("这个项目改不了人物设定");
      const { rec, created } = ensureCharacter(ctx, who);
      const fields = {};
      for (const k of CHAR_FIELDS) {
        if (typeof a[k] === "string" && a[k].trim()) fields[k] = a[k].trim();
      }
      // 落不下的栏由 `runAction` 统一说出来 —— 白名单在 `apply` 之前就把它们剥掉了，
      // 这里根本看不见（所以这段检测只能在中央那一处做）。
      if (!Object.keys(fields).length) {
        if (created) return { said: `新建了人物「${rec.name}」，但没说要写哪几栏` };
        throw new Error(`没说要把「${rec.name}」改成什么`);
      }
      ctx.bible.updateCharacterProfile(rec.characterId, fields);
      const head = created ? `新建了人物「${rec.name}」，写了` : `「${rec.name}」写了`;
      return { said: `${head} ${Object.keys(fields).length} 栏` };
    },
  },
  {
    id: "relationship.fields",
    label: "加/改一段人物关系（关系不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的关系在角色设计里能删",
    args: {
      relationshipId: "已有关系的 id（界面编辑时给；给了就不用 a / b）",
      a: "一方（人物名字）", b: "另一方（人物名字）",
      basis: "基础关系", aToB: "A 怎么看 B", bToA: "B 怎么看 A",
      coreConflict: "核心矛盾", tension: "情感张力", power: "权力关系",
      history: "共同历史", secrets: "隐藏信息 / 秘密",
      direction: "长期发展方向", arc: "Relationship Arc", forbidden: "不应发生的关系偏离",
    },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.updateRelationship) throw new Error("这个项目改不了人物关系");
      // 界面编辑的是一条**已有**的关系，手里有 id —— 直接改，不按名字反查。
      // Agent 说的是「林照和阿夏的关系」，走下面的名字路径。两条路写的是同一个函数。
      const rid = String(x.relationshipId || "").trim();
      if (rid) {
        const all = (ctx.prodData().production.relationships) || [];
        const existing = all.find((r) => r.relationshipId === rid);
        if (!existing) throw new Error(`没有这段关系：${rid}`);
        const patch = {};
        for (const k of REL_FIELDS) if (typeof x[k] === "string") patch[k] = x[k];
        if (!Object.keys(patch).length) throw new Error("没有可写的栏");
        ctx.canon.updateRelationship(rid, patch);
        return { said: `关系 ${rid} 改了 ${Object.keys(patch).join("、")}` };
      }
      const nameOf = (v) => String(v || "").trim();
      const an = nameOf(x.a);
      const bn = nameOf(x.b);
      if (!an || !bn) throw new Error("没说是哪两个人的关系");
      if (an === bn) throw new Error("一段关系要两个不同的人");
      // 两头都先落实到人物 —— 关系存的是 characterId，人物不在就没有可指的东西。
      const A = ensureCharacter(ctx, an);
      const B = ensureCharacter(ctx, bn);
      // **关系存的是 `characterIds`**（canondoc）。上一版按 r.aId / r.aName 去找 ——
      // 那四个字段在文档里根本不存在，所以就算关系已经建好，也照样报「没有这段关系」。
      const list = (ctx.prodData().production.relationships) || [];
      const has = (r, id) => (r.characterIds || []).includes(id);
      let rec = list.find((r) => has(r, A.rec.characterId) && has(r, B.rec.characterId));
      let created = false;
      if (!rec) {
        if (typeof ctx.canon.addRelationship !== "function") {
          throw new Error(`没有「${an} — ${bn}」这段关系，这个项目也加不了关系`);
        }
        rec = ctx.canon.addRelationship(A.rec.characterId, B.rec.characterId);
        if (!rec) throw new Error(`加不了「${an} — ${bn}」这段关系`);
        created = true;
      }
      const fields = {};
      for (const k of REL_FIELDS) {
        if (typeof x[k] === "string" && x[k].trim()) fields[k] = x[k].trim();
      }
      const made = [
        A.created ? `人物「${A.rec.name}」` : "",
        B.created ? `人物「${B.rec.name}」` : "",
        created ? "这段关系" : "",
      ].filter(Boolean);
      const head = made.length ? `新建了${made.join("、")}，` : "";
      if (!Object.keys(fields).length) {
        if (made.length) return { said: `${head}但没说要写哪几栏` };
        throw new Error(`没说要把「${an} — ${bn}」改成什么`);
      }
      ctx.canon.updateRelationship(rec.relationshipId, fields);
      return { said: `${head}「${an} — ${bn}」写了 ${Object.keys(fields).length} 栏` };
    },
  },
  // --- 关系的**结构**（TASK-129）：建 / 删 / 拿回来 / 改方向 --------------- //
  //
  // `relationship.fields` 管的是一段关系**写了什么**；这四条管的是**有没有这段
  // 关系、它朝哪边**。分开是因为它们的可逆性不一样：改字段改回去就行，
  // 删一段关系在切片 1 之前是不可逆的（现在是软删除 + 回收区）。
  //
  // 两种叫法都收：界面手里有 `relationshipId`，Agent 说的是「林照和阿夏的关系」。
  // 两条路解析到同一条记录，`relationship.fields` 早就是这么做的。
  {
    id: "relationship.add",
    label: "建立一段人物关系",
    doc: "bible",
    undo: "relationship.remove（软删除，回收区里拿得回来）",
    args: { a: "一方（人物名字）", b: "另一方（人物名字）" },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.addRelationship) throw new Error("这个项目加不了人物关系");
      const an = String(x.a || "").trim();
      const bn = String(x.b || "").trim();
      if (!an || !bn) throw new Error("没说是哪两个人的关系");
      if (an === bn) throw new Error("一段关系要两个不同的人");
      const A = ensureCharacter(ctx, an);
      const B = ensureCharacter(ctx, bn);
      if (relBetween(ctx, A.rec.characterId, B.rec.characterId)) {
        throw new Error(`「${an} — ${bn}」已经有一段关系了 —— 改它用 relationship.fields`);
      }
      const rec = ctx.canon.addRelationship(A.rec.characterId, B.rec.characterId);
      if (!rec) throw new Error(`加不了「${an} — ${bn}」这段关系`);
      const made = [A.created ? `人物「${an}」` : "", B.created ? `人物「${bn}」` : ""].filter(Boolean);
      const head = made.length ? `新建了${made.join("、")}，并` : "";
      return { said: `${head}建立了「${an} — ${bn}」的关系`, relationshipId: rec.relationshipId };
    },
  },
  {
    id: "relationship.remove",
    label: "删掉一段人物关系",
    doc: "bible",
    undo: "relationship.restore —— 软删除，回收区里拿得回来；各集已记的推进不受影响",
    args: { relationshipId: "关系 id（界面给）", a: "一方（人物名字）", b: "另一方" },
    apply: (ctx, x) => {
      const rec = resolveRel(ctx, x);
      if (!ctx.canon.removeRelationship(rec.relationshipId)) {
        // 唯一的拒绝原因就是它：有剧集记录了这段关系的推进。说出**怎么办**，
        // 不只说「失败」—— 那条推进是他写的创作史，得由他自己决定要不要撤。
        throw new Error("有剧集记录了这段关系的推进：先在「分集规划」移除该集的关系节拍");
      }
      return { said: "删掉了这段关系（回收区里还能拿回来）" };
    },
  },
  {
    id: "relationship.restore",
    label: "把删掉的关系拿回来",
    doc: "bible",
    undo: "relationship.remove",
    args: { relationshipId: "关系 id" },
    apply: (ctx, x) => {
      const rid = String(x.relationshipId || "").trim();
      if (!rid) throw new Error("没说要拿回哪一段关系");
      if (!ctx.canon || !ctx.canon.undeleteRelationship) throw new Error("这个项目拿不回关系");
      if (!ctx.canon.undeleteRelationship(rid)) {
        // 两种失败分开说：回收区里没有它，和这一对已经有活着的关系了。
        // 后者不是错误，是他自己后来又建了一段 —— 得由他决定留哪一段。
        const inBin = (ctx.prodData().production.deletedRelationships || [])
          .some((r) => r.relationshipId === rid);
        throw new Error(
          inBin
            ? "这两个人之间已经有一段活着的关系了 —— 一对人物只能有一段。要旧的那段，先把现在这段删掉"
            : `回收区里没有这段关系：${rid}`,
        );
      }
      return { said: "这段关系回来了" };
    },
  },
  {
    id: "relationship.swap",
    label: "调换一段关系的方向",
    doc: "bible",
    undo: "relationship.swap（再调一次就换回来）",
    args: { relationshipId: "关系 id（界面给）", a: "一方（人物名字）", b: "另一方" },
    apply: (ctx, x) => {
      const rec = resolveRel(ctx, x);
      if (!ctx.canon.swapDirection(rec.relationshipId)) throw new Error("调换不了方向");
      return { said: "已调换方向（「A 怎么看 B」与「B 怎么看 A」一起跟着换了）" };
    },
  },
  // --- 实体本身：改名 / 删 / 拿回来（TASK-129 切片 2c） -------------------- //
  //
  // `character.fields` / `location.fields` 管的是**档案里写了什么**；这几条管的是
  // **这个身份还在不在、叫什么**。删除在切片 1 之前是不可逆的，现在是软删除 + 回收区，
  // 所以它们才够格进表（AGENTS §1「回不了头是缺陷，先消除它」）。
  {
    id: "character.rename",
    label: "给人物改名",
    doc: "bible",
    undo: "改回去就行（身份不变，引用它的场景/关系/节拍一个不动）",
    args: { name: "现在的名字或 id", to: "新名字" },
    apply: (ctx, a) => {
      const rec = mustFind(ctx, "characters", a.name, "人物");
      const to = String(a.to || "").trim();
      if (!to) throw new Error("没说改成什么名字");
      if (!ctx.bible.renameCharacter(rec.characterId, to)) throw new Error(`改不了「${rec.name}」的名字`);
      return { said: `人物「${rec.name}」改名为「${to}」` };
    },
  },
  {
    id: "character.remove",
    label: "删掉一个人物",
    doc: "bible",
    undo: "character.restore —— 软删除，回收区里拿得回来",
    args: { name: "人物名字或 id" },
    apply: (ctx, a) => {
      const rec = mustFind(ctx, "characters", a.name, "人物");
      if (!ctx.bible.removeCharacter(rec.characterId)) {
        // 三种拒绝原因（场景引用 / 关系 / 剧集节拍）都是「别处还指着他」。
        // 说出**怎么办**，不只说失败 —— 那些引用是他写的，得由他决定先撤哪个。
        throw new Error(
          `「${rec.name}」还被别处指着（场景引用 / 人物关系 / 剧集节拍），先解除那些引用再删`,
        );
      }
      return { said: `删掉了人物「${rec.name}」（回收区里还能拿回来）` };
    },
  },
  {
    id: "character.restore",
    label: "把删掉的人物拿回来",
    doc: "bible",
    undo: "character.remove",
    args: { name: "人物名字或 id" },
    apply: (ctx, a) => {
      const rec = mustFindDeleted(ctx, "deletedCharacters", "characterId", a.name, "人物");
      if (!ctx.bible.undeleteCharacter(rec.characterId)) throw new Error(`拿不回「${rec.name}」`);
      return { said: `人物「${rec.name}」回来了` };
    },
  },
  {
    id: "location.rename",
    label: "给场景地改名",
    doc: "bible",
    undo: "改回去就行（身份不变）",
    args: { name: "现在的名字或 id", to: "新名字" },
    apply: (ctx, a) => {
      const rec = mustFind(ctx, "locations", a.name, "场景地");
      const to = String(a.to || "").trim();
      if (!to) throw new Error("没说改成什么名字");
      if (!ctx.bible.renameLocation(rec.locationId, to)) throw new Error(`改不了「${rec.name}」的名字`);
      return { said: `场景地「${rec.name}」改名为「${to}」` };
    },
  },
  {
    id: "location.remove",
    label: "删掉一个场景地",
    doc: "bible",
    undo: "location.restore —— 软删除，回收区里拿得回来",
    args: { name: "场景地名字或 id" },
    apply: (ctx, a) => {
      const rec = mustFind(ctx, "locations", a.name, "场景地");
      if (!ctx.bible.removeLocation(rec.locationId)) {
        throw new Error(`「${rec.name}」还被场景引用着，先在剧集工作区解除引用再删`);
      }
      return { said: `删掉了场景地「${rec.name}」（回收区里还能拿回来）` };
    },
  },
  {
    id: "location.restore",
    label: "把删掉的场景地拿回来",
    doc: "bible",
    undo: "location.remove",
    args: { name: "场景地名字或 id" },
    apply: (ctx, a) => {
      const rec = mustFindDeleted(ctx, "deletedLocations", "locationId", a.name, "场景地");
      if (!ctx.bible.undeleteLocation(rec.locationId)) throw new Error(`拿不回「${rec.name}」`);
      return { said: `场景地「${rec.name}」回来了` };
    },
  },

  // --- 状态 / 参考图 / 声音（TASK-129 切片 2d，`bindSettings` 最后 12 个） ---- //
  //
  // 人物和场景地的状态是**同一套机制**（同一个 `stateId` 命名空间、同一组
  // add/rename/remove/overrides），差别只有归属实体与可覆盖字段白名单。
  // 所以这十条由一个工厂派生，不手写两遍 —— 手写的那一版会在两边逐渐长出细微
  // 差异，而「同一件事有两处陈述」正是本仓库反复修的那个形状。
  ...stateActions("character", {
    label: "人物",
    listKey: "characters",
    idKey: "characterId",
    fields: {
      appearance: "外貌",
      costume: "服装",
      visualInstruction: "画面指令",
      voiceDescription: "这个状态下声音怎么变（只改表现，换不了声音身份）",
    },
  }),
  ...stateActions("location", {
    label: "场景地",
    listKey: "locations",
    idKey: "locationId",
    fields: { description: "描述", visualInstruction: "画面指令" },
  }),
  {
    id: "character.voice",
    label: "改一个人物的基础声音",
    doc: "bible",
    undo: "改回去就行",
    args: {
      name: "人物名字或 id",
      voiceId: "声音标识（如 piper 声音名，留空=没指定）",
      description: "声音描述（音色 / 年龄感 / 语气）",
    },
    apply: (ctx, a) => {
      const rec = mustFind(ctx, "characters", a.name, "人物");
      const patch = {};
      if (typeof a.voiceId === "string") patch.voiceId = a.voiceId;
      if (typeof a.description === "string") patch.description = a.description;
      if (!Object.keys(patch).length) throw new Error("没说要改声音的哪一栏");
      // **状态改不了声音身份** —— 一个人物只有一个声音（bibledoc 的 VOICE RULE，
      // 状态的 overrides 里 `voiceId` 会被剥掉）。所以这条只作用在基础档案上，
      // 没有 `state` 参数，那不是遗漏。
      if (!ctx.bible.setCharacterVoice(rec.characterId, patch)) {
        throw new Error(`改不了「${rec.name}」的声音`);
      }
      return { said: `「${rec.name}」的声音改了 ${Object.keys(patch).join("、")}` };
    },
  },
  {
    id: "reference.add",
    label: "给人物 / 场景地挂一张参考图",
    doc: "bible",
    undo: "reference.remove（摘下来进回收区，拿得回来）",
    args: { entity: "人物或场景地的名字 / id", assetId: "资产 id" },
    apply: (ctx, a) => {
      const rec = mustFindEntity(ctx, a.entity);
      const assetId = String(a.assetId || "").trim();
      if (!assetId) throw new Error("没说挂哪张图");
      if (!ctx.bible.addReferenceAsset(rec.id, assetId)) {
        throw new Error(`挂不上（「${rec.name}」上已经有这张图了，或者 id 不对）`);
      }
      return { said: `「${rec.name}」挂上了一张参考图` };
    },
  },
  {
    id: "reference.remove",
    label: "把一张参考图摘下来",
    doc: "bible",
    undo: "reference.restore —— 摘下来的引用进回收区；图本身在资产库里，从来没删过",
    args: { entity: "人物或场景地的名字 / id", assetId: "资产 id" },
    apply: (ctx, a) => {
      const rec = mustFindEntity(ctx, a.entity);
      if (!ctx.bible.removeReferenceAsset(rec.id, String(a.assetId || ""))) {
        throw new Error(`「${rec.name}」上没有这张图`);
      }
      return { said: `从「${rec.name}」摘下了一张参考图（回收区里还能挂回去）` };
    },
  },
  {
    id: "reference.restore",
    label: "把摘下来的参考图挂回去",
    doc: "bible",
    undo: "reference.remove",
    args: { entity: "人物或场景地的名字 / id", assetId: "资产 id" },
    apply: (ctx, a) => {
      const rec = mustFindEntity(ctx, a.entity);
      if (!ctx.bible.undeleteReferenceAsset(rec.id, String(a.assetId || ""))) {
        throw new Error(`「${rec.name}」的回收区里没有这张图`);
      }
      // 不抢回主图位（bibledoc 写明了理由：摘掉时主图已经让给了别人）。
      return { said: `「${rec.name}」挂回了一张参考图` };
    },
  },
  {
    id: "reference.setActive",
    label: "把某张参考图设为主图",
    doc: "bible",
    undo: "再设回原来那张就行（只动指针，一张图都没有增删）",
    args: { entity: "人物或场景地的名字 / id", assetId: "资产 id（留空 = 不指定主图）" },
    apply: (ctx, a) => {
      const rec = mustFindEntity(ctx, a.entity);
      const assetId = a.assetId === null || a.assetId === "" ? null : String(a.assetId);
      if (!ctx.bible.setActiveReferenceAsset(rec.id, assetId)) {
        throw new Error(`设不了主图（「${rec.name}」上没有挂这张图）`);
      }
      return { said: assetId ? `「${rec.name}」换了主图` : `「${rec.name}」不再指定主图` };
    },
  },

  // --- 分集规划里的节拍（TASK-129）：本集推进了什么 ----------------------- //
  //
  // 三条都是**改一栏内容**，可逆性与 `work.core` 同级（改回去就行）。
  // 同一批里的 `stamp`（记录本集基于的上游版本）**没有进表**，理由写在
  // `tests/contract/test_surface_manifest.py` 的 `ALLOWED_DIRECT` 里：
  // 它是裁决 —— 「我认现在这一版上游」是他的决定，而且盖下去之后旧基线就没了。
  {
    id: "beat.text",
    label: "改本集的剧情 / 世界推进",
    doc: "canon",
    undo: "改回去就行",
    args: { episodeId: "这一集的 id", kind: "plot（剧情）或 world（世界）", lines: "一行一条" },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.setTextBeats) throw new Error("这个项目改不了分集节拍");
      const kind = String(a.kind || "");
      if (kind !== "plot" && kind !== "world") throw new Error("kind 只能是 plot 或 world");
      // 收字符串也收数组：Agent 多半给一整段，界面给的是已经切好的行。
      const raw = Array.isArray(a.lines) ? a.lines : String(a.lines ?? "").split("\n");
      const list = raw.map((s) => String(s).trim()).filter(Boolean);
      if (!ctx.canon.setTextBeats(String(a.episodeId || ""), kind, list)) {
        throw new Error(`改不了 ${a.episodeId} 的${kind === "plot" ? "剧情" : "世界"}推进`);
      }
      return { said: `${a.episodeId} 的${kind === "plot" ? "剧情" : "世界"}推进写了 ${list.length} 条` };
    },
  },
  {
    id: "beat.character",
    label: "记一个人物在本集的推进",
    doc: "canon",
    undo: "改回去就行；写空字符串等于把这一条撤掉",
    args: { episodeId: "这一集的 id", character: "人物名字或 id", beat: "这一集他怎么变了" },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.setCharacterBeat) throw new Error("这个项目改不了分集节拍");
      const who = String(a.character || "").trim();
      if (!who) throw new Error("没说是哪个人物");
      // **不新建人物** —— 节拍是「这个人在这一集怎么变了」，人物不在就是他说错了名字，
      // 这时候造一个空人物出来只会让那条节拍挂在一个谁都不认识的身份上。
      const chars = (ctx.prodData().production.characters) || [];
      const rec = chars.find((c) => c.characterId === who || c.name === who);
      if (!rec) throw new Error(`人物里没有「${who}」`);
      if (!ctx.canon.setCharacterBeat(String(a.episodeId || ""), rec.characterId, String(a.beat ?? ""))) {
        throw new Error(`记不下「${rec.name}」在 ${a.episodeId} 的推进`);
      }
      return { said: `${a.episodeId}：「${rec.name}」的推进记下了` };
    },
  },
  {
    id: "beat.relationship",
    label: "记一段关系在本集的推进",
    doc: "canon",
    undo: "改回去就行",
    args: {
      episodeId: "这一集的 id", relationshipId: "关系 id（界面给）",
      a: "一方（人物名字）", b: "另一方",
      start: "本集开始时", event: "本集发生了什么", end: "本集结束时",
    },
    apply: (ctx, x) => {
      if (!ctx.canon || !ctx.canon.setRelationshipBeat) throw new Error("这个项目改不了分集节拍");
      const rec = resolveRel(ctx, x);
      // 三栏是**一条记录**：只写一栏时另外两栏必须原样带上，否则「改了开始」
      // 会把「发生了什么」和「结束时」清空（界面那边早就是这么做的）。
      const cur =
        ((ctx.prodData().production.episodes || [])
          .find((e) => e.episodeId === String(x.episodeId || "")) || {})
          .beats;
      const old = ((cur && cur.relationship) || []).find((r) => r.relationshipId === rec.relationshipId) || {};
      const pick = (k) => (typeof x[k] === "string" ? x[k] : String(old[k] ?? ""));
      const body = { start: pick("start"), event: pick("event"), end: pick("end") };
      if (!ctx.canon.setRelationshipBeat(String(x.episodeId || ""), rec.relationshipId, body)) {
        throw new Error(`记不下这段关系在 ${x.episodeId} 的推进`);
      }
      return { said: `${x.episodeId}：这段关系的推进记下了` };
    },
  },
  {
    id: "world.fields",
    label: "改世界观",
    doc: "bible",
    undo: "改回去就行",
    fields: {
      era: "时间 / 时代", rules: "世界规则", society: "社会背景",
      regions: "主要区域", places: "主要地点", visualTone: "视觉基调", atmosphere: "整体氛围",
    },
    apply: (ctx, a) => {
      if (!ctx.canon || !ctx.canon.updateWorld) throw new Error("这个项目改不了世界观");
      ctx.canon.updateWorld(a.fields);
      return { said: describe(a.fields, ACTION_BY_ID["world.fields"].fields) };
    },
  },
  {
    // 场景设计这一页**之前根本没有动作** —— 人物和世界观都能改，场景地不能。
    // 产品负责人 2026-08-31 把设定往角色设计和世界观里搬时还没走到这一步，
    // 但下一步一定会走到（「这都会成为之后小说剧集制作的基础财产」），
    // 到时候又会是一次「回执说改好了、页面上什么都没有」。
    id: "location.fields",
    label: "加/改一个场景地（场景地不存在就新建）",
    doc: "bible",
    undo: "改回去就行；新建出来的场景地在场景设计里能删",
    args: {
      name: "场景地名字（或 id）—— 场景设计里没有就新建一个",
      description: "描述",
      visualInstruction: "基础视觉方向 / 画面指令",
    },
    apply: (ctx, a) => {
      const who = String(a.name || "").trim();
      if (!who) throw new Error("没说要改哪个场景地");
      if (!ctx.bible || !ctx.bible.updateLocationProfile) throw new Error("这个项目改不了场景地");
      const { rec, created } = ensureLocation(ctx, who);
      const fields = {};
      for (const k of LOC_FIELDS) {
        if (typeof a[k] === "string" && a[k].trim()) fields[k] = a[k].trim();
      }
      if (!Object.keys(fields).length) {
        if (created) return { said: `新建了场景地「${rec.name}」，但没说要写哪几栏` };
        throw new Error(`没说要把「${rec.name}」改成什么`);
      }
      ctx.bible.updateLocationProfile(rec.locationId, fields);
      const head = created ? `新建了场景地「${rec.name}」，写了` : `「${rec.name}」写了`;
      return { said: `${head} ${Object.keys(fields).length} 栏` };
    },
  },
  {
    id: "blocking.actor",
    label: "加/改白膜里的一个演员",
    doc: "blocking",
    undo: "改回去；删是软删除，可恢复",
    args: {
      shotId: "镜头 id",
      name: "名字",
      fromX: "起点 X（米）",
      fromZ: "起点 Z（米）",
      toX: "终点 X（米）",
      toZ: "终点 Z（米）",
      facing: "朝向（度）",
    },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const name = String(a.name || "").trim();
      let actor = bwork.visibleActors(b).find((x) => x.name === name);
      if (!actor) actor = bwork.addActor(b, name || `演员 ${bwork.visibleActors(b).length + 1}`);
      const patch = {};
      if (a.fromX !== undefined || a.fromZ !== undefined) {
        patch.from = { x: Number(a.fromX ?? actor.from.x), z: Number(a.fromZ ?? actor.from.z) };
      }
      if (a.toX !== undefined || a.toZ !== undefined) {
        patch.to = { x: Number(a.toX ?? actor.to.x), z: Number(a.toZ ?? actor.to.z) };
      }
      if (a.facing !== undefined) patch.facing = Number(a.facing);
      bwork.editActor(b, actor.id, patch);
      return { said: `白膜里的「${actor.name}」摆好了` };
    },
  },
  {
    id: "blocking.camera",
    label: "改白膜的机位",
    doc: "blocking",
    undo: "改回去就行",
    args: {
      shotId: "镜头 id",
      which: "from / to / both",
      x: "机位 X（米）",
      z: "机位 Z（米）",
      y: "机位高度（米）",
      lookX: "看向 X",
      lookZ: "看向 Z",
      lens: "焦距（毫米）",
    },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const which = ["from", "to", "both"].includes(String(a.which)) ? String(a.which) : "both";
      const side = which === "both" ? "from" : which;
      const patch = {};
      if (a.x !== undefined || a.z !== undefined) {
        const cur = b.camera[side].at;
        patch.at = { x: Number(a.x ?? cur.x), z: Number(a.z ?? cur.z) };
      }
      if (a.lookX !== undefined || a.lookZ !== undefined) {
        const cur = b.camera[side].look;
        patch.look = { x: Number(a.lookX ?? cur.x), z: Number(a.lookZ ?? cur.z) };
      }
      if (a.y !== undefined) patch.y = Number(a.y);
      if (a.lens !== undefined) patch.lens = Number(a.lens);
      if (!bwork.setCamera(b, which, patch)) throw new Error("这个机位改不了");
      return {
        said: which === "both" ? "机位（起幅与落幅）改好了" : `机位（${which === "from" ? "起幅" : "落幅"}）改好了`,
      };
    },
  },
  {
    id: "blocking.timing",
    label: "改白膜的时长或场地",
    doc: "blocking",
    undo: "改回去就行",
    args: { shotId: "镜头 id", seconds: "时长（秒）", stage: "场地边长（米）" },
    apply: (ctx, a) => {
      const b = blockingOf(ctx, a.shotId);
      const said = [];
      if (a.seconds !== undefined && bwork.setDuration(b, Number(a.seconds))) {
        said.push(`时长 ${b.duration}s`);
      }
      if (a.stage !== undefined && bwork.setStage(b, Number(a.stage))) {
        said.push(`场地 ${b.stage}m`);
      }
      if (!said.length) throw new Error("没有可改的时长或场地");
      return { said: said.join(" · ") };
    },
  },
  /* ===== Story Development 的四页（TASK-122 第 6 步）=======================
     产品负责人 2026-08-30：「Agent 必须能够读取、修改以上所有当前内容。Agent 修改的是
     正式数据模型，不是只修改 UI 展示文本。」

     所以这几条动作调用的是 `storywork` 里那组函数 —— **和他自己在页面上点、在框里打字
     走的是同一条写路径**。不存在「Agent 专用的一份」。 */
  {
    id: "work.core",
    label: "改故事核心",
    doc: "work",
    undo: "改回去就行；「定稿」才产生历史版本",
    args: { text: "整篇故事核心（覆盖）", append: "追加在末尾的一段（可选）" },
    argMax: { text: LONG_TEXT, append: LONG_TEXT },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const add = typeof a.append === "string" ? a.append.trim() : "";
      if (add) work.core = work.core ? `${work.core}\n\n${add}` : add;
      else if (typeof a.text === "string") work.core = a.text;
      else throw new Error("没说要把故事核心改成什么");
      return { said: add ? `故事核心追加了 ${add.length} 字` : `故事核心改成了 ${work.core.length} 字` };
    },
  },
  {
    id: "work.outline",
    label: "改故事大纲",
    doc: "work",
    undo: "改回去就行；节点 id 会尽量保住，引用不会断",
    args: { text: "整份大纲（覆盖，空行分段）" },
    argMax: { text: LONG_TEXT },
    apply: (ctx, a) => {
      if (typeof a.text !== "string") throw new Error("没说要把大纲改成什么");
      const nodes = swork.setOutline(workOf(ctx), a.text);
      return { said: `大纲改成了 ${nodes.length} 个节点（编号已自动维护）` };
    },
  },
  {
    id: "plan.row.add",
    label: "结构规划加一行",
    doc: "work",
    undo: "plan.row.delete（软删除，可恢复）",
    args: { unitNo: "Unit No.（可选）", scene: "Scene（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const row = swork.addPlanRow(work, new Date().toISOString());
      if (typeof a.unitNo === "string" && a.unitNo) swork.editPlanRow(work, row.id, "unitNo", a.unitNo);
      if (typeof a.scene === "string" && a.scene) swork.editPlanRow(work, row.id, "scene", a.scene);
      return { said: `结构规划加了一行（${row.unitNo}）` };
    },
  },
  {
    id: "plan.row.edit",
    label: "改结构规划的一格",
    doc: "work",
    undo: "改回去就行",
    args: { rowId: "行 id", field: "列（unitNo/scene/purpose/characters/goal/conflict/turn/endingState）", value: "内容" },
    apply: (ctx, a) => {
      const ok = swork.editPlanRow(workOf(ctx), String(a.rowId || ""), String(a.field || ""), a.value);
      if (!ok) throw new Error(`改不了这一格（行 ${a.rowId} / 列 ${a.field}）`);
      return { said: `结构规划 ${a.rowId} 的「${a.field}」改好了` };
    },
  },
  {
    id: "plan.row.delete",
    label: "删结构规划的一行",
    doc: "work",
    undo: "plan.row.restore（进回收区，内容一字不动）",
    args: { rowId: "行 id" },
    apply: (ctx, a) => {
      if (!swork.hidePlanRow(workOf(ctx), String(a.rowId || ""), new Date().toISOString()))
        throw new Error(`删不掉 ${a.rowId}（表里没有它，或者已经删了）`);
      return { said: `已删除 ${a.rowId}（回收区里可以恢复）` };
    },
  },
  {
    id: "plan.row.restore",
    label: "撤销删除结构规划的一行",
    doc: "work",
    undo: "plan.row.delete",
    args: { rowId: "行 id" },
    apply: (ctx, a) => {
      if (!swork.restorePlanRow(workOf(ctx), String(a.rowId || "")))
        throw new Error(`撤销不了 ${a.rowId}（回收区里没有它）`);
      return { said: `${a.rowId} 回来了` };
    },
  },
  {
    id: "plan.row.link",
    label: "把一行关联到大纲节点",
    doc: "work",
    undo: "再调一次去掉那个引用",
    args: { rowId: "行 id", nodeId: "大纲节点 id", remove: "true 时只取消关联（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const row = work.plan.rows.find((r) => r.id === String(a.rowId || ""));
      if (!row) throw new Error(`表里没有 ${a.rowId}`);
      const nodeId = String(a.nodeId || "");
      if (!work.outline.nodes.some((n) => n.id === nodeId)) throw new Error(`大纲里没有节点 ${nodeId}`);
      // `remove: true` 只删不加（界面上「×」那个按钮的语义）；不带它就是切换。
      const has = row.outlineRefs.includes(nodeId);
      const next = a.remove === true
        ? row.outlineRefs.filter((x) => x !== nodeId)
        : has ? row.outlineRefs.filter((x) => x !== nodeId) : [...row.outlineRefs, nodeId];
      swork.editPlanRow(work, row.id, "outlineRefs", next);
      return { said: `${a.rowId} ${next.includes(nodeId) ? "关联到" : "取消关联"} ${nodeId}` };
    },
  },
  {
    id: "work.form",
    label: "选小说创作还是剧集创作",
    doc: "work",
    undo: "换回去就行，写下的内容不删",
    args: { form: "novel 或 episode" },
    apply: (ctx, a) => {
      if (!swork.setForm(workOf(ctx), String(a.form || ""))) throw new Error(`不认识的形态「${a.form}」`);
      return { said: a.form === "novel" ? "改成小说创作" : "改成剧集创作" };
    },
  },
  {
    id: "work.planned",
    label: "设 Planned Chapters / Episodes",
    doc: "work",
    undo: "改回去就行；减少不会删掉已经写下的章/集",
    args: { n: "数量（整数）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const n = Number(a.n);
      if (!swork.setPlanned(work, work.form, n)) throw new Error(`数量不对：${a.n}`);
      return { said: `计划写 ${n} ${work.form === "novel" ? "章" : "集"}（已经写下的不会删）` };
    },
  },
  {
    id: "unit.ensure",
    label: "打开第 N 章/集（没有就建一个空的）",
    doc: "work",
    undo: "建出来的是空章/集；什么都没写就什么都不用撤",
    args: { no: "第几章/集" },
    apply: (ctx, a) => {
      // 界面上的「章/集选择器」点下去做的就是这件事（TASK-127）：让第 N 章/集存在。
      // 幂等 —— 已经有的不会被动一个字。
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const unit = swork.ensureUnit(work, work.form, Number(a.no), new Date().toISOString());
      if (!unit) throw new Error(`第 ${a.no} 章/集不是一个有效的编号`);
      return { said: `第 ${a.no} ${work.form === "novel" ? "章" : "集"}已就位（${unit.body.length} 字）` };
    },
  },
  {
    id: "unit.write",
    label: "写某一章/集的正文",
    doc: "work",
    undo: "改回去就行；「定稿」才产生历史版本",
    args: { no: "第几章/集", text: "正文（覆盖）", append: "追加的一段（可选）", title: "标题（可选）" },
    argMax: { text: LONG_TEXT, append: LONG_TEXT },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      if (!work.form) throw new Error("还没选小说创作还是剧集创作");
      const at = new Date().toISOString();
      const unit = swork.ensureUnit(work, work.form, Number(a.no), at);
      if (!unit) throw new Error(`第 ${a.no} 章/集不是一个有效的编号`);
      const add = typeof a.append === "string" ? a.append.trim() : "";
      // **检查的是落地之后的长度，不是参数的长度。** 往一篇已经写满的正文后面
      // 追加一个字，参数检查当然过得去 —— 出事的是拼接之后（codex 第十轮）。
      const next = add
        ? (unit.body ? `${unit.body}\n\n${add}` : add)
        : (typeof a.text === "string" ? a.text : null);
      if (next !== null) {
        if (!swork.editUnit(work, unit.id, "body", next, at)) {
          throw new Error(
            `写不进去：这一${work.form === "novel" ? "章" : "集"}` +
              `${add ? "追加后" : ""}会有 ${next.length} 字，超过 ${swork.UNIT_MAX} 字上限` +
              "，一个字都没有写进去",
          );
        }
      }
      if (typeof a.title === "string") swork.editUnit(work, unit.id, "title", a.title, at);
      return { said: `第 ${a.no} ${work.form === "novel" ? "章" : "集"}现在有 ${unit.body.length} 字` };
    },
  },
  {
    id: "work.finalize",
    label: "定稿，存一版历史",
    doc: "work",
    undo: "存下来的历史版本可以手动删",
    args: { what: "core / outline / plan / unit", no: "unit 时是第几章/集", note: "这一版的说明（可选）" },
    apply: (ctx, a) => {
      const work = workOf(ctx);
      const at = new Date().toISOString();
      const what = String(a.what || "");
      if (what === "unit") {
        const unit = work.units.find((u) => u.kind === work.form && u.no === Number(a.no));
        if (!unit) throw new Error(`没有第 ${a.no} 章/集`);
        const rec = swork.finalizeUnit(work, unit.id, at, String(a.note || ""));
        return { said: rec ? `第 ${a.no} 章/集存为 v${rec.v}` : "内容没变，没有重复存一版" };
      }
      if (!swork.DOC_KINDS.includes(what)) throw new Error(`不知道要定稿什么：「${a.what}」`);
      const rec = swork.finalizeDoc(work, what, at, String(a.note || ""));
      return { said: rec ? `存为 v${rec.v}` : "内容没变，没有重复存一版" };
    },
  },
];

/**
 * 三个能力标签（ADR-0096 决策 2）。加载时补默认值：这张表里的动作**默认可逆、免费、
 * 不绑身份** —— 这不是宽松，是登记的门槛：一条不可逆、又不是付费、又不绑身份的动作
 * 没有资格进表（先把它做成可逆的，AGENTS.md §1「回不了头是缺陷」），所以登记时就抛。
 * 付费动作可以登记（为了让 `runAction` 在执行时按同一条规矩拒），但今天一条也没有。
 */
for (const a of ACTIONS) {
  if (typeof a.reversible !== "boolean") a.reversible = true;
  if (typeof a.paid !== "boolean") a.paid = false;
  if (typeof a.identityBinding !== "boolean") a.identityBinding = false;
  if (!a.reversible && !a.paid && !a.identityBinding) {
    throw new Error(`动作 ${a.id} 不可逆又不付费不绑身份 —— 先把它做成可逆的，再登记`);
  }
}

const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/** 「类型/题材 → 悬疑；基调 → 冷」——落了什么，用他在页面上看到的字眼说。 */
function describe(fields, labels) {
  return Object.entries(fields || {})
    .map(([k, v]) => {
      const name = (labels && labels[k]) || k;
      const val = v && typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${String(name).replace(/（.*）$/, "")} → ${val.slice(0, 80)}`;
    })
    .join("；");
}

/** 模型看到的词汇表。**它就是这张注册表**，不是另抄一份。 */
export function actionCatalog() {
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    undo: a.undo,
    reversible: a.reversible,
    paid: a.paid,
    identityBinding: a.identityBinding,
    ...(a.fields ? { fields: a.fields } : {}),
    ...(a.args ? { args: a.args } : {}),
  }));
}

export function knownAction(id) {
  return !!ACTION_BY_ID[id];
}

/** 一条动作的三个能力标签；未知 id → null。 */
export function actionTags(id) {
  const a = ACTION_BY_ID[id];
  return a ? { reversible: a.reversible, paid: a.paid, identityBinding: a.identityBinding } : null;
}

/** 白名单过滤：只留这条动作声明过的键。结构化子对象保留它自己的一层。 */
export function sanitizeArgs(id, raw) {
  const spec = ACTION_BY_ID[id];
  if (!spec) return null;
  const src = raw && typeof raw === "object" ? raw : {};
  if (spec.fields) {
    const fields = {};
    for (const key of Object.keys(spec.fields)) {
      const val = src.fields && typeof src.fields === "object" ? src.fields[key] : src[key];
      if (typeof val === "string" && val.trim()) fields[key] = val.trim().slice(0, 2000);
      else if (typeof val === "number" && Number.isInteger(val) && val > 0 && val <= 50) fields[key] = val;
      else if (val && typeof val === "object" && !Array.isArray(val)) {
        const row = {};
        for (const [sk, sv] of Object.entries(val)) {
          if (typeof sv === "string" && sv.trim()) row[sk] = sv.trim().slice(0, 2000);
        }
        if (Object.keys(row).length) fields[key] = row;
      }
    }
    return Object.keys(fields).length ? { fields } : null;
  }
  const args = {};
  for (const key of Object.keys(spec.args || {})) {
    const val = src[key] !== undefined ? src[key] : (src.args || {})[key];
    if (typeof val === "string") {
      // 长文字段（`argMax`）**一个字都不许在这里砍**：那是他自己在编辑器里敲的字。
      // 超了由 `runAction` 当场报错，而不是悄悄留下前 20 万字。
      // 没声明 `argMax` 的字段仍然砍到 4000 —— 那道护栏管的是**模型输出**，不是他的正文。
      args[key] = spec.argMax && spec.argMax[key] ? val : val.slice(0, 4000);
    }
    else if (typeof val === "number" || typeof val === "boolean") args[key] = val;
  }
  return args;
}

/**
 * 落一条动作。抛错 = 没落下，调用方要把原因说出来（决策 6：fail-closed 并说明）。
 * @returns {{said: string, versioned?: string}}
 */
/** 白名单剥掉了哪些**有内容**的键。
 *
 *  白名单本身是对的（表外的键一律不落进文档），错的是它**一声不吭**：模型报上来
 *  `background`，剥掉，动作照样回一句「改好了」—— 他以为搬完了，其实少了几栏
 *  （2026-08-31 实测：人物的 background/speech/note、世界观的 premise 全是这样没的）。
 *
 *  所以剥掉什么要说出来。放在这里而不是每条 `apply` 里，是因为 `apply` 拿到的
 *  已经是剥完的参数 —— **它看不见自己少了什么**，34 条动作都一样。 */
function strippedKeys(spec, rawArgs) {
  const src = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const known = Object.keys(spec.fields || spec.args || {});
  const pool = spec.fields
    ? (src.fields && typeof src.fields === "object" ? src.fields : src)
    : { ...(src.args && typeof src.args === "object" ? src.args : {}), ...src };
  return Object.keys(pool).filter(
    (k) => !known.includes(k)
      && !["fields", "args", "id", "action"].includes(k)
      // 只看字符串会**漏报**：模型把内容塞进一个未知的对象/数组键时，
      // 既没写进去，也不出现在「没有这些栏」里（补审 2026-09-05 第二轮）。
      && pool[k] !== undefined && pool[k] !== null
      && (typeof pool[k] !== "string" || pool[k].trim()),
  );
}

export function runAction(ctx, id, rawArgs, meta) {
  const spec = ACTION_BY_ID[id];
  if (!spec) throw new Error(`本应用没有「${id}」这个动作`);
  // 标签在这里统一判（ADR-0096 决策 2）—— 不在每条 apply 里各判一次。
  //   paid            → 谁调都拒：花钱是唯一必须问创作者的事，不由这张表替他决定
  //   identityBinding → 只有他自己点（origin "ui"）才行；Agent 反悔不干净
  const origin = meta && typeof meta.origin === "string" ? meta.origin : "agent";
  if (spec.paid) throw new Error(`「${spec.label}」要花钱 —— 这张表不替你决定花钱的事`);
  if (spec.identityBinding && origin !== "ui") {
    throw new Error(`「${spec.label}」会绑定身份，只能由你自己在界面上点`);
  }
  const args = sanitizeArgs(id, rawArgs);
  if (args === null) throw new Error(`「${spec.label}」没有收到能写的内容`);
  // 长文超上限 = **拒绝**，并说清楚超了多少。fail-closed 并说明白，而不是留下
  // 前 N 个字让他以为写进去了 —— 只把上限从 4000 抬到 20 万，是把「静默丢字」
  // 挪远一格，不是修掉它（codex 补审 2026-09-05 第九轮）。
  for (const [key, max] of Object.entries(spec.argMax || {})) {
    const v = args[key];
    if (typeof v === "string" && v.length > max) {
      throw new Error(
        `「${(spec.args && spec.args[key]) || key}」超过 ${max} 字上限` +
          `（这次是 ${v.length} 字），一个字都没有写进去 —— 先拆开再写`,
      );
    }
  }
  const out = { ...spec.apply(ctx, args, meta || {}), label: spec.label };
  const extra = strippedKeys(spec, rawArgs);
  if (extra.length) {
    out.said = `${out.said}；「${spec.label}」没有 ${extra.join("、")} 这些栏，它们没有写进去`;
  }
  return out;
}

export { ACTIONS as _ACTIONS };
