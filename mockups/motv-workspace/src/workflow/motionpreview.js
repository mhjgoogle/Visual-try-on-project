// 白膜视频 —— 让「运镜」第一次有反馈 (TASK-098)。
//
// 实测依据：真实项目 60 个镜头，`cameraMotion` 填充率 **0/60**。
// TASK-093 §2.4 / ADR-0075 把它归因为「逐镜手打自由文本走不通」并加了运镜预设。
// 本卡的假设是**更根本的那一条**：填了也看不见效果 —— 创作者写「手持微晃，缓慢
// 前推」，然后什么都不会发生，直到花钱生成整镜。
//
//   预设给的是**词汇**，本模块给的是**反馈**。两者互补。
//
// ─────────────────────────────────────────────────────────────────────────────
// 本模块只做一件事：**把那句话读成一组数**。它不碰 ffmpeg、不碰网络、不碰 DOM。
//
//   `parseCameraMotion(text)`  这句话说了什么运镜 —— 三种结局，不是两种
//   `previewPlan({...})`       那组运镜 + 这一镜的时长 → 一份可渲染的数值规格
//
// **三种结局**，因为把它压成「能/不能」两种就必然在某一头说谎：
//
//   1. 认得出且做得到     推 / 拉 / 摇 / 移 / 升降 / 微晃 / 固定 → 渲染
//   2. 认得出但做不到     环绕 · 弧形 · 「摇」没说方向 → **如实说没做到那一条**
//   3. 认不出             一句都没对上 → **说认不出，并列出能识别的词**
//
// 第 2 类是这张卡最容易做错的地方：白膜是一张静态图上的仿射变换，
// **环绕做不出来**（它要背景连续变化）。静默输出一个横移冒充环绕，
// 与 TASK-097 §2.5f 那条「不知道 ≠ 放行」是同一个缺陷 —— 只是这次撒的谎有画面。
//
// 而**明写「固定机位」时输出一个不动的视频是对的**，那不是第 3 类。
// 这两个方向都要钉住（§2.5d：只钉「会拒绝」的一半，就是在造一个迟早被关掉的闸门）。
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE：无 fetch、无 DOM、无时钟、无随机。同一句话永远解析成同一组数
// —— 预览必须可复现，否则「改一个字看效果变没变」这件事就没法做。

const str = (x) => (typeof x === "string" ? x.trim() : "");

/* ========================================================================== */
/* 一、词汇表 —— 一张表，一次扫描                                              */
/* ========================================================================== */

/**
 * 运镜词汇。**白名单，闭集**，而且**速度词与幅度词也在同一张表里**。
 *
 * 为什么在同一张表：它们会互相包含。「轻微晃动」既是晃动词也含幅度词「轻微」，
 * 「略微向前推进」的幅度词与运镜词紧挨着。两张表两次扫描 → 同一段字被两边各认
 * 一次。一张表一次扫描、匹配到的字**就地消耗**，这类重复计数在结构上不可能发生。
 *
 * `kind`：
 *   move        真的能渲染的运动 —— 有 `axis` 和 `dir`
 *   static      明写「机位不动」。它是**声明**，不是运动
 *   unsupported 认得出、B1 做不到（环绕 / 弧形：静态图上没有纵深）
 *   ambiguous   认得出、但**方向没说**（「摇」/「横移」）—— 由 `satisfiedBy` 决定
 *               它是否已经被同句话里的方向词交代过
 *   speed       速度词 → 同样时长里走多远
 *   amplitude   幅度词
 *
 * `words[0]` 是这个词条的**规范说法** —— 界面上「能预览的词」那一行印的就是它，
 * 而那一行是创作者唯一会照着抄的东西，所以它得是最自然的说法，不是最长的那个。
 *
 * **`move` 一档里没有单字词，这是一条不变量**（下面有派生守卫钉着它）。
 * 第一版收了「推」「拉」，于是「固定机位，人物推门」被读成一次推镜 —— 一个**主体
 * 动作**被渲染成了相机运动。一个汉字不足以作为「把镜头动起来」的证据；
 * 而修法不是列出「推门 / 推倒 / 推搡…」那种排除清单（手写枚举不收敛，§2.5d 已经
 * 在三个领域各中一次），是**整类去掉**：真实语料里没有一条运镜只写一个字
 * （夜班沉默三镜是「上摇 / 推近 / 固定」，ADR-0075 八个预设全是 ≥2 字）。
 *
 * 单字的「摇」「移」留在 `ambiguous` 一档 —— 那一档**永远不渲染**，它只会说
 * 「没说方向」，所以「摇头」最坏的后果是一句略显奇怪的提示，不是一段错的画面。
 *
 * 顺序无关：扫描按**词长从长到短**优先，所以「拉近」永远先于「拉」被匹配到，
 * 「推近」不会被读成「推」再剩一个「近」。这一条是本表能同时收下
 * 「推」与「拉近」的全部原因 —— 两者的语义正好相反。
 */
export const MOTION_TERMS = Object.freeze([
  // --- 推 / 拉：画幅缩放 ------------------------------------------------- //
  {
    id: "push", label: "推近", kind: "move", axis: "zoom", dir: 1,
    words: ["推近", "拉近", "推进", "向前推", "前推", "推轨", "推镜", "推入"],
  },
  {
    id: "pull", label: "后拉", kind: "move", axis: "zoom", dir: -1,
    words: ["后拉", "拉远", "拉出", "拉开", "后退", "拉镜"],
  },
  // --- 左 / 右：横向 ------------------------------------------------------ //
  {
    id: "pan-left", label: "向左", kind: "move", axis: "x", dir: -1,
    words: ["向左摇", "从右向左", "从右到左", "左摇", "向左移", "左移", "向左滑", "左滑", "向左"],
  },
  {
    id: "pan-right", label: "向右", kind: "move", axis: "x", dir: 1,
    words: ["向右摇", "从左向右", "从左到右", "右摇", "向右移", "右移", "向右滑", "右滑", "向右"],
  },
  // --- 上 / 下：纵向。上摇（tilt）与升降（pedestal）在一张静态图上同形 ----- //
  {
    id: "tilt-up", label: "向上", kind: "move", axis: "y", dir: -1,
    words: ["上摇", "由下向上", "从下向上", "向上摇", "摇起", "向上移", "上移", "上升", "升起", "抬起", "向上"],
  },
  {
    id: "tilt-down", label: "向下", kind: "move", axis: "y", dir: 1,
    words: ["下摇", "由上向下", "从上向下", "向下摇", "俯下", "向下移", "下移", "下降", "落下", "向下"],
  },
  // --- 微晃 -------------------------------------------------------------- //
  {
    id: "shake", label: "手持微晃", kind: "move", axis: "shake", dir: 1,
    words: ["手持微晃", "轻微晃动", "轻微抖动", "微微晃动", "手持跟随", "手持", "微晃", "晃动", "抖动", "呼吸感"],
  },
  // --- 固定：声明，不是运动 ---------------------------------------------- //
  //
  // 「固定机位」**不等于**「画面完全不动」：固定机位上摇是一句成立的话
  // （机位不移动，镜头仍然摇）。所以它只在**没有任何其它运动**时才产出一个不动
  // 的视频；有别的运动就只是一条注记。这一条与 §2.5h 第一条同源：一处不要承载
  // 两件不同的事实。
  {
    id: "locked", label: "固定机位", kind: "static",
    words: ["固定机位", "完全静止", "定机位", "锁定机位", "机位固定", "静止", "不动", "固定"],
  },
  // --- 认得出，B1 做不到 -------------------------------------------------- //
  //
  // 白膜是一张静态图上的仿射变换：**没有纵深，也没有被遮挡的背面**。
  // 环绕要求背景连续变化，弧形要求主体与背景以不同速度移动 —— 那是 B2（深度视差）
  // 之后的事，甚至更远。用横移冒充它们，就是把「做不到」渲染成一段看起来像的画面。
  {
    id: "orbit", label: "环绕 / 旋转", kind: "unsupported",
    words: ["环绕一周", "环绕", "绕主体", "旋转", "360度", "360"],
    why: "白膜是一张静态图上的平移与缩放 —— 环绕要背景连续变化，它需要纵深",
  },
  {
    id: "arc", label: "弧形滑行", kind: "unsupported",
    words: ["弧形", "弧线", "左弧", "右弧"],
    why: "弧形要主体与背景以不同速度移动，静态图上做不到（会退化成一次平移）",
  },
  // --- 认得出，方向没说 --------------------------------------------------- //
  {
    id: "pan-any", label: "摇", kind: "ambiguous",
    words: ["摇"],
    satisfiedBy: ["x", "y"],
    why: "「摇」没说方向 —— 写成「向左摇」/「向右摇」/「上摇」/「下摇」就能预览",
  },
  {
    id: "track-h", label: "横移", kind: "ambiguous",
    words: ["横移", "横向移动", "平移"],
    satisfiedBy: ["x"],
    why: "「横移」没说向左还是向右 —— 补一个方向就能预览",
  },
  {
    id: "move-any", label: "移动", kind: "ambiguous",
    words: ["移动", "移"],
    satisfiedBy: ["x", "y"],
    why: "「移动」没说往哪儿 —— 补一个方向（左/右/上/下）就能预览",
  },
  // --- 速度 / 幅度 -------------------------------------------------------- //
  { id: "very-slow", label: "极缓慢", kind: "speed", mult: 0.45, words: ["极缓慢", "极慢", "非常慢"] },
  // 单字的「慢」「快」是允许的：派生守卫只禁止**会渲染**的那一档（`move`）里出现
  // 单字词。修饰词自己渲不出任何东西，而收下它们让「不要太快推近」这类否定链接得上。
  { id: "slow", label: "缓慢", kind: "speed", mult: 0.7, words: ["缓慢", "低速", "慢速", "缓缓", "慢"] },
  { id: "even", label: "匀速", kind: "speed", mult: 1.0, words: ["匀速", "稳定器", "稳定"] },
  { id: "fast", label: "快速", kind: "speed", mult: 1.4, words: ["快速", "迅速", "快"] },
  { id: "very-fast", label: "急速", kind: "speed", mult: 1.8, words: ["急速", "极快"] },
  { id: "small", label: "轻微", kind: "amplitude", mult: 0.55, words: ["轻微", "略微", "稍微", "微幅"] },
  { id: "large", label: "大幅", kind: "amplitude", mult: 1.5, words: ["大幅", "剧烈", "强烈", "夸张"] },
]);

/**
 * 否定词。**它们是同一张表里的词条，不是一个「前一个字是不是不」的判断。**
 *
 * 第一版只看紧邻的**一个字符**，于是：
 *
 *   不推不摇   ✓ 认出来了（「不」紧贴「推」）
 *   不要推近   ✗ 「推近」前面是「要」→ 被解析成一次推镜
 *   没有移动   ✗ 同上
 *
 * 也就是说**一句明确禁止的运镜会被反向渲染出来** —— 比「认不出」坏得多。
 * 单字符回看是一个**字符级**的判断，而否定是**词级**的；把否定当成词条放进同一张
 * 表、走同一次最长匹配，「不要」「没有」「无需」这些两字否定自然就被看见了。
 *
 * 否定作用于**紧接着它**的那个运动词，而且**跨过中间的速度 / 幅度词**：
 *
 *   不要推近       否定紧邻的运动词
 *   不要缓慢推近   「缓慢」不是一个运动，它没资格把这个否定用掉（轮 2 的 P1）
 *
 * 只有**运动 / 固定 / 做不到 / 说不清**这四类会把否定用掉；修饰词与几个虚词
 * （`NEGATION_CARRY`）只是把它往后传，而且必须**逐字相接**。
 *
 * 为什么不是「附近 N 个字以内」：那会让「构图**不**错，缓慢推近」里那个「不」去否定
 * 后面的推镜，也会让「**不**断推近」「**不**停推近」变成「不要推近」——
 * 而这三个词里的「不/断/停」根本不是一次否定。逐字相接 + 一小组虚词，
 * 恰好放过前者、认出后者。
 *
 * 否定一个运动词 = 一次「机位不动」的声明；
 * 否定一个「固定」或一个做不到的词 = **什么都不推断**（「不固定」不等于任何具体运动）。
 */
export const NEGATION_WORDS = Object.freeze([
  "不要", "不用", "不需", "不再", "不做", "不带", "无需", "没有", "别再", "切勿",
  "避免", "禁止", "不", "没", "无", "别", "未", "勿", "非",
]);

/**
 * 否定可以**跨过去**的虚词。一个**封闭的语法小类**，不是一张「要拦什么」的清单
 * ——所以它不会像枚举那样长出第二十条（§2.5d 那条「手写枚举不收敛」说的是后者）。
 *
 * 「不要缓慢**地**推近」里的「地」必须跨过去，否则那句明确的禁止就漏了。
 * 而「不**断**推近」「不**停**推近」里的「断 / 停」**故意不在这里**：
 * 那两个词整体是「持续地」，不是一次否定，跨过去就会把它读反。
 */
const NEGATION_CARRY = new Set(["地", "的", "得", "着", "太", "过", "很", "了"]);

const NEGATION_TERM = { id: "__negate", kind: "negate", words: NEGATION_WORDS };

/** 一张扫描表：`[词, 词条]`，按词长降序。派生自 `MOTION_TERMS`，不手写第二份。
 *  否定词走同一张表 —— 于是「不动」（static，2 字）胜过「不」（negate，1 字），
 *  而「不要」（negate，2 字）胜过「不」，全部由同一条最长匹配规则决定。 */
const SCAN = [...MOTION_TERMS, NEGATION_TERM]
  .flatMap((t) => t.words.map((w) => [w, t]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * 最长匹配 + 就地消耗。
 *
 * 返回按出现顺序排列的 `{ term, negated }`。同一个词条出现多次只保留第一次
 * ——「固定机位缓慢上摇，从积水倒影摇到招牌本体」里那个第二个「摇」不是第二次
 * 指令，它是同一句话的续写。
 */
function scan(text) {
  const hits = [];
  const seen = new Set();
  let i = 0;
  // 上一个否定词结束在哪儿。`-1` = 还没遇到过。否定只作用于**紧接着它**的词条。
  let negatedUntil = -1;
  while (i < text.length) {
    let matched = null;
    for (const [word, term] of SCAN) {
      if (text.startsWith(word, i)) { matched = [word, term]; break; }
    }
    if (!matched) {
      // 否定后面紧跟一个虚词时，把否定继续往后传（「不要缓慢地推近」的「地」）
      if (i === negatedUntil && NEGATION_CARRY.has(text[i])) negatedUntil = i + 1;
      i += 1;
      continue;
    }
    const [word, term] = matched;
    if (term.kind === "negate") {
      negatedUntil = i + word.length;
      i += word.length;
      continue;
    }
    const negated = i === negatedUntil;
    if (negated && (term.kind === "speed" || term.kind === "amplitude")) {
      // 修饰词**用不掉**一个否定：「不要缓慢推近」里要否定的是「推近」，不是「缓慢」。
      // 第一版让它在这儿被吃掉，于是那句明确禁止的运镜照样渲了出来（轮 2 的 P1）。
      negatedUntil = i + word.length;
      i += word.length;
      continue;
    }
    const key = term.id + (negated ? ":n" : ":y");
    if (!seen.has(key)) { seen.add(key); hits.push({ term, negated }); }
    i += word.length;
  }
  return hits;
}

/* ========================================================================== */
/* 二、解析 —— 三种结局                                                        */
/* ========================================================================== */

/** 能识别的词，按用途分组。**派生自词汇表**，所以加一个词不用记得改这里
 *  （§2.6.1：手写的「N 项」清单总会漏一项）。 */
export function motionVocabulary() {
  const of = (kind) => MOTION_TERMS.filter((t) => t.kind === kind);
  return [
    { group: "画幅", words: of("move").filter((t) => t.axis === "zoom").map((t) => t.words[0]) },
    { group: "方向", words: of("move").filter((t) => t.axis === "x" || t.axis === "y").map((t) => t.words[0]) },
    { group: "手持", words: of("move").filter((t) => t.axis === "shake").map((t) => t.words[0]) },
    { group: "固定", words: of("static").map((t) => t.words[0]) },
    { group: "速度", words: of("speed").map((t) => t.words[0]) },
    { group: "幅度", words: of("amplitude").map((t) => t.words[0]) },
  ];
}

/**
 * 这句运镜说了什么。
 *
 * 结局在 `renderable` 上，而它只有两条成立路径：
 *
 *   有可渲染的运动           → 渲染（认不出的那几条照实列在 `notApplied`）
 *   没有运动、但明写了「固定」→ 渲染一个不动的视频（**这是对的答案**）
 *   其它一切                → 不渲染，`why` 说明为什么，`vocabulary` 给能识别的词
 *
 * 「明写固定」那条有一个例外：同句话里还有一条**做不到**的词（环绕）。
 * 那时创作者要的是环绕，不是静止 —— 输出一个不动的视频等于回答了另一个问题。
 */
export function parseCameraMotion(text) {
  const src = str(text);
  const base = {
    text: src, applied: [], notApplied: [], staticDeclared: false,
    speedMult: 1.0, ampMult: 1.0, renderable: false, summary: "", why: "",
    vocabulary: motionVocabulary(),
  };
  if (!src) {
    return { ...base, empty: true, why: "这一镜还没写运镜 —— 写一句，或者选一个运镜预设" };
  }
  const hits = scan(src);
  const moves = [];
  const recognizedNotApplied = [];
  let staticDeclared = false;
  let speedMult = null;
  let ampMult = null;

  const stronger = (cur, next) => (
    cur === null || Math.abs(next - 1) > Math.abs(cur - 1) ? next : cur
  );

  for (const { term, negated } of hits) {
    if (negated) {
      // 「不推不摇」= 一次「机位不动」的声明。否定「固定」或否定一个做不到的词
      // 什么都不说明 —— 不从否定里推断出一个具体运动。
      if (term.kind === "move" || term.kind === "ambiguous") staticDeclared = true;
      continue;
    }
    if (term.kind === "move") { moves.push(term); continue; }
    if (term.kind === "static") { staticDeclared = true; continue; }
    if (term.kind === "unsupported") {
      recognizedNotApplied.push({ id: term.id, label: term.label, why: term.why });
      continue;
    }
    if (term.kind === "ambiguous") {
      recognizedNotApplied.push({
        id: term.id, label: term.label, why: term.why,
        pending: true, satisfiedBy: term.satisfiedBy,
      });
      continue;
    }
    // 速度 / 幅度：**取最极端的那一个**，不相乘。「缓慢」与「极缓慢」同时出现是
    // 同一件事的两种说法，相乘会得到一个谁都没要求的 0.31。
    if (term.kind === "speed") speedMult = stronger(speedMult, term.mult);
    if (term.kind === "amplitude") ampMult = stronger(ampMult, term.mult);
  }

  // 同一根轴上的两个反向词 = 一次冲突。**不挑一个**（挑就是猜哪个先发生），
  // 把那根轴整条摘掉并如实说出来。
  const applied = [];
  const conflicts = [];
  for (const axis of new Set(moves.map((m) => m.axis))) {
    const onAxis = moves.filter((m) => m.axis === axis);
    if (new Set(onAxis.map((m) => m.dir)).size > 1) {
      conflicts.push({
        id: "conflict-" + axis,
        label: onAxis.map((m) => m.label).join(" + "),
        why: "同一句话里写了两个相反的方向 —— 预览不猜哪个先发生，补清顺序或拆成两镜",
      });
      continue;
    }
    applied.push(onAxis[0]);
  }

  // 方向没说的那些：**同句话里已经有同轴的方向词就不再提**。
  // 「固定机位缓慢上摇，从积水倒影摇到招牌本体」里的第二个「摇」已经被「上摇」
  // 交代过了 —— 再报一条「摇没说方向」是噪声，而噪声会让真正的提示被忽略。
  const resolvedAxes = new Set(applied.map((m) => m.axis));
  const pending = recognizedNotApplied
    .filter((n) => n.pending)
    .filter((n) => !(n.satisfiedBy || []).some((a) => resolvedAxes.has(a)))
    .map((n) => ({ id: n.id, label: n.label, why: n.why }));
  const blocked = recognizedNotApplied.filter((n) => !n.pending);
  const notApplied = [...blocked, ...conflicts, ...pending];

  const renderable = applied.length > 0 || (staticDeclared && notApplied.length === 0);
  const summary = applied.length
    ? applied.map((m) => m.label).join(" · ")
    : (staticDeclared ? "固定机位（画面不动是对的）" : "");
  let why = "";
  if (!renderable) {
    if (notApplied.length) {
      why = "这句运镜里能认出的部分白膜还做不到："
        + notApplied.map((n) => n.label + " —— " + n.why).join("；");
    } else if (speedMult !== null || ampMult !== null) {
      // 「缓慢」/「轻微」这类词**是认出来了的**，缺的是「做什么运动」。
      // 说成「一个词都没认出来」是一句假话，而且把创作者送错方向
      // （他会以为要换词，实际是要补一个动作）——codex 轮 1 的 non-blocking。
      why = "只写了速度 / 幅度，没说做什么运动 —— 补一个「推近」/「后拉」/"
        + "「向左摇」这样的动作就能预览";
    } else {
      why = "这句运镜里一个能预览的词都没认出来";
    }
  }
  return {
    ...base,
    empty: false,
    applied: applied.map((m) => ({ id: m.id, label: m.label, axis: m.axis, dir: m.dir })),
    notApplied,
    staticDeclared,
    speedMult: speedMult === null ? 1.0 : speedMult,
    ampMult: ampMult === null ? 1.0 : ampMult,
    renderable,
    summary,
    why,
  };
}

/* ========================================================================== */
/* 三、一组运镜 + 这一镜的时长 → 一份数值规格                                  */
/* ========================================================================== */

/** 基准幅度。写成命名常量而不是散在表达式里的字面量：它们是**判据**，将来要调
 *  就该有一处可调。三个数的单位都是「占画幅的比例」。 */
export const MOTION_BASE = Object.freeze({
  /** 推 / 拉：画幅相对变化 30% */
  zoom: 0.30,
  /** 摇 / 移：中心点单向偏移 11% 画幅（一趟走 22%） */
  translate: 0.11,
  /** 微晃：中心点抖动 1% 画幅 */
  shake: 0.010,
});

export const PREVIEW_FPS = 25;

/**
 * 预览时长上限，**必须与服务端那道帧数上限说同一件事**。
 *
 * 服务端拒绝超过 1800 帧（60s @ 30fps）。这一层不设上限的话，一条 3600 秒的镜头会
 * 让界面亮着「预览运镜 →」，点下去后端 400 —— 正是 §2.5e 那条缝的形状：
 * **两处在陈述同一件事实，而只有一处知道真话。** 所以这里先说，且说得出原因。
 */
export const MAX_PREVIEW_SECONDS = 60;

/** 幅度上限。中心点偏移 + 抖动超过这个数，为了留出平移空间要裁掉的画幅就多到
 *  「起止构图」本身失真了 —— 那时预览回答的已经不是创作者问的问题。 */
const MAX_OFFSET = 0.20;

const clampMult = (m) => Math.min(2.0, Math.max(0.3, m));

/**
 * 数值规格。**含 `frames`，不含 `duration`** —— 预览时长由帧数决定
 * （`frames / fps`），所以「预览和这一镜一样长」是一个可以精确成立的等式，
 * 而不是一个四舍五入之后大概相等的说法。
 *
 * `durationSeconds` **必须由调用方给出**，读不到就是读不到（返回 `ok: false`）。
 * 这里不许兜底成 6 秒 —— `shotqc.durationCheck` 已经为这条兜底付过一次代价：
 * 一条 8 秒的镜头被拿去和 6 秒比，报出一条假发现。
 */
export function previewPlan({ text, durationSeconds, fps = PREVIEW_FPS } = {}) {
  const parse = parseCameraMotion(text);
  if (!parse.renderable) {
    return { ok: false, parse, spec: null, reason: parse.why, caveats: [] };
  }
  if (!(typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0)) {
    return {
      ok: false, parse, spec: null, caveats: [],
      reason: "分镜表没写这一镜的时长 —— 预览要和它一样长，所以先把时长填上",
    };
  }
  if (durationSeconds > MAX_PREVIEW_SECONDS) {
    return {
      ok: false, parse, spec: null, caveats: [],
      reason: `这一镜写着 ${durationSeconds}s —— 白膜预览最长 ${MAX_PREVIEW_SECONDS}s`
        + "（它是一次目视确认，不是成片）；把这一镜拆短，或者直接生成整镜",
    };
  }
  const mult = clampMult(parse.speedMult * parse.ampMult);
  const dirOf = (axis) => {
    const hit = parse.applied.find((a) => a.axis === axis);
    return hit ? hit.dir : 0;
  };
  const shakeAmp = dirOf("shake") ? MOTION_BASE.shake * clampMult(parse.ampMult) : 0;
  const travel = Math.min(MAX_OFFSET, MOTION_BASE.translate * mult);
  const offX = travel * dirOf("x");
  const offY = travel * dirOf("y");
  // 平移与抖动都要**画幅之外的余量**才走得动：一张图上「摇」只能是裁一块窗口平移
  // 过去。余量由需要的最大偏移反算，所以画面永远不会被 ffmpeg 静默夹在边界上
  // ——夹住的后果是运动到中途自己停下，而视频看起来仍然是「成功」的。
  const need = Math.max(Math.abs(offX), Math.abs(offY)) + shakeAmp;
  const zBase = need > 0 ? (1 / (1 - 2 * need)) * 1.01 : 1.0;
  const zoomDir = dirOf("zoom");
  const zFar = zBase * (1 + (zoomDir ? MOTION_BASE.zoom * mult : 0));
  const spec = {
    fps,
    frames: Math.max(2, Math.round(durationSeconds * fps)),
    zoom: zoomDir > 0
      ? { from: zBase, to: zFar }
      : zoomDir < 0 ? { from: zFar, to: zBase } : { from: zBase, to: zBase },
    center: {
      fromX: 0.5 - offX, toX: 0.5 + offX,
      fromY: 0.5 - offY, toY: 0.5 + offY,
    },
    shake: shakeAmp > 0 ? { amp: shakeAmp } : null,
    still: parse.applied.length === 0,
  };
  // 白膜说得出自己**没**表达什么。这不是免责声明，是这一格在成本阶梯里的位置：
  // 它回答「运镜对不对」，不回答「画面对不对」（那是 Keyframe 那一档）。
  const caveats = [];
  if (zBase > 1.005) {
    caveats.push(
      "为了有平移空间，预览用的是关键帧 " + Math.round(100 / zBase)
      + "% 的画幅（起止构图的相对关系是真的）",
    );
  }
  const exact = spec.frames / fps;
  if (Math.abs(exact - durationSeconds) > 1e-9) {
    // 帧是整数，时长不一定。差值最多半帧（25fps → 20ms），但「与这一镜等长」
    // 是本卡写下的合同，所以不精确的时候**说出来**，而不是让那句话变成近似真话。
    caveats.push(
      `预览 ${exact.toFixed(2)}s，分镜表写 ${durationSeconds}s`
      + `（帧数取整，差 ${Math.abs(exact - durationSeconds).toFixed(3)}s）`,
    );
  }
  if (parse.applied.some((a) => a.axis === "x" || a.axis === "y")) {
    caveats.push("摇与移在一张静态图上同形 —— 白膜没有纵深，两者分不出来");
  }
  for (const n of parse.notApplied) caveats.push("没做到：" + n.label + " —— " + n.why);
  caveats.push("白膜只回答「运镜对不对」：遮挡、纵深、表演、景深、升格都不在它的能力里");
  return { ok: true, parse, spec, reason: "", caveats };
}

/**
 * 包含性不变量：任何时刻裁切窗口都必须**整个落在画面里**。
 *
 * 导出而不是写成注释里的一句话，因为服务端要在真的调 ffmpeg 之前再验一次同一条
 * （§2.5d：闸门要用生产那一份谓词），而测试要能对着**每一种词的组合**验它
 * ——不是对着我记得写下来的那几种。
 */
export function specContained(spec) {
  if (!spec || !spec.zoom || !spec.center) return false;
  const zMin = Math.min(spec.zoom.from, spec.zoom.to);
  if (!(zMin >= 1)) return false;
  const half = 0.5 / zMin;
  const amp = spec.shake ? spec.shake.amp : 0;
  const worst = (a, b) => Math.max(Math.abs(a - 0.5), Math.abs(b - 0.5)) + amp;
  return worst(spec.center.fromX, spec.center.toX) + half <= 0.5 + 1e-9
    && worst(spec.center.fromY, spec.center.toY) + half <= 0.5 + 1e-9;
}

/* ========================================================================== */
/* 四、这段白膜是拿什么渲的                                                     */
/* ========================================================================== */

/**
 * 一段白膜的**身份**：它是拿哪一句运镜、哪一份规格、哪一张图渲出来的。
 *
 * 为什么必须存下来（codex 轮 1 的 P1）：预览原来只按镜头槽位取，于是改了运镜或换了
 * 关键帧之后，界面会在**新的**运镜摘要旁边播**旧的**那段 MP4 —— 两处在陈述同一件
 * 事实而只有一处更新过，正是本仓库反复付过代价的那条缝（§2.5e）。
 * 而这里的后果是审片时看错东西：摘要说「向左摇」，画面在推近。
 *
 * 与 TASK-092 的「批准绑在具体那个产物上」同一条：**一个判断必须说得出它判的是谁。**
 *
 * FNV-1a，32 位十六进制。它是一个**新鲜度标记**，不是安全边界 —— 不需要抗碰撞，
 * 需要的是「同样的输入永远得到同一个字符串」（纯函数，无时钟、无随机）。
 */
export function motionStamp({ text, spec, sourceUrl } = {}) {
  const canonical = [
    str(text),
    str(sourceUrl),
    spec ? [
      spec.fps, spec.frames,
      spec.zoom.from.toFixed(6), spec.zoom.to.toFixed(6),
      spec.center.fromX.toFixed(6), spec.center.toX.toFixed(6),
      spec.center.fromY.toFixed(6), spec.center.toY.toFixed(6),
      spec.shake ? spec.shake.amp.toFixed(6) : "-",
      spec.still ? "still" : "moving",
    ].join(",") : "-",
  ].join(" ");
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* ========================================================================== */
/* 五、⑤ 那张清单里的一行                                                      */
/* ========================================================================== */

/**
 * 白膜的输入档次。**闭集，而且每一档都要说出自己是哪一档。**
 *
 * 卡片写的是「对 Keyframe 做仿射变换」，而正式关键帧是首选 —— 但**实测两个真实
 * 项目里一张 `keyframe` 都没有**（那个 kind 是 TASK-097 批次 4G 才加的，还没有
 * 产出过），照见未明rev2 只有参考图，夜班沉默只有 `shot-image`。只认关键帧的话
 * 这个功能在**每一个现有真实项目上都是死的**。
 *
 * 所以第二档存在，而且**它必须报出自己是第二档**（§2.5h 第二条：闸门关着时退化成
 * 真实可做的那件事 —— 而拿这一镜真的有的那张图预览运镜，就是那件事）。
 * 静默用一张草图冒充正式关键帧才是错的；说出来就不是。
 */
export const SOURCE_TIERS = Object.freeze({
  keyframe: { label: "正式关键帧", note: "" },
  "shot-image": {
    label: "镜头图片",
    note: "用的是这一镜的镜头图片，不是正式关键帧 —— 运镜看得出来，画面细节以关键帧为准",
  },
});

/**
 * 一行的视图模型。**生产与测试共用这一份**（§2.5d）—— 「这一镜现在能不能预览」
 * 藏在控制器的闭包里，测试就只能钉一份等价物，而那份等价物本身就是新的一条缝。
 *
 * 两件事分得很清（§2.5f 第二条）：
 *
 *   `blocked`  这一镜**开始不了**：没有任何画面，白膜没有输入可用
 *   `todo`     这一镜**你要做的活**：写一句运镜 / 补一个方向 / 填上时长
 *
 * 混起来，界面就会用「还不能开始」拦住它请创作者做的那件事 —— 而那件事
 * （把运镜写下来）恰好是这张卡存在的全部目的。
 */
export function motionRow({ text, durationSeconds, source = null, preview = null } = {}) {
  const plan = previewPlan({ text, durationSeconds });
  const parse = plan.parse;
  const tier = source && SOURCE_TIERS[source.tier] ? source.tier : null;
  const blocked = tier
    ? ""
    : "这一镜还没有画面 —— 白膜是拿这一镜那张图做的，先在 ⑤ 合成关键帧（或上传一张镜头图片）";
  let todo = "";
  if (!blocked) {
    if (parse.empty) {
      todo = "写一句运镜，或者选一个运镜预设 —— 写完立刻就能看到那个运动";
    } else if (!plan.ok) {
      todo = plan.reason;
    }
  }
  const sourceNote = tier ? SOURCE_TIERS[tier].note : "";
  // **这段白膜还算不算这一句运镜的预览。**
  //
  // 三态，而且「不知道」不读作「算」（§2.5f 第一条）：
  //   没有预览        → `preview: null`
  //   有，且身份对得上 → 当前的预览
  //   有，但身份对不上 / **说不出身份** → `stale`，界面照实说，并给一条重渲的路
  const want = plan.ok
    ? motionStamp({ text: parse.text, spec: plan.spec, sourceUrl: source ? source.url : "" })
    : null;
  const has = preview && typeof preview.url === "string" && preview.url ? preview : null;
  const stampOf = has && typeof has.stamp === "string" && has.stamp ? has.stamp : null;
  const stale = has
    ? (want === null || stampOf === null || stampOf !== want)
    : false;
  const staleWhy = !stale ? "" : (stampOf === null
    // 本卡之前渲的（没有印身份），或者印丢了 —— 说「不知道」，不说「是当前的」
    ? "这段白膜没有记下它是拿哪一版运镜渲的 —— 重渲一次就知道了"
    : "这段白膜是**上一版**运镜或上一张图渲的 —— 重渲一次才对得上现在这句话");
  return {
    text: parse.text,
    empty: parse.empty === true,
    renderable: parse.renderable,
    summary: parse.summary,
    notApplied: parse.notApplied,
    // 用的不是正式关键帧时，那句话进 caveats —— 白膜说得出自己是拿什么做的
    caveats: sourceNote ? [sourceNote, ...plan.caveats] : plan.caveats,
    vocabulary: parse.vocabulary,
    sourceTier: tier,
    sourceLabel: tier ? SOURCE_TIERS[tier].label : "",
    sourceNote,
    // 「能不能现在点」= 读得懂 + 有图 + 知道该渲多长。三者缺一都不是「大概可以」。
    canPreview: plan.ok && !!tier,
    spec: plan.ok ? plan.spec : null,
    blocked,
    todo,
    preview: has,
    // 派生，供界面与计数共用同一份判断 —— 不许各算一遍（§2.6.2）
    previewStale: stale,
    previewStaleWhy: staleWhy,
    previewFresh: !!has && !stale,
    // 渲这一次该印上去的身份（控制器登记时用）
    stamp: want,
  };
}
