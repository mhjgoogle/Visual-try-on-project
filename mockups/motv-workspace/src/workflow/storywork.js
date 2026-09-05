// Story Development 的正式数据模型（TASK-122 第 1 步）。
//
// 产品负责人 2026-08-30 的规格：左栏严格四个入口 —— 故事核心 / 故事大纲 / 结构规划 /
// 正文创作；大纲要有**稳定的 Outline Node ID**（作者不用维护）；结构规划是固定 9 列的表
// 并能引用大纲节点；正文创作先选小说还是剧集，先定 Planned Chapters / Episodes（可增减），
// 章/集用页内选择器切换、不进左栏；**日常只留最新一版，点「定稿」才存历史版本**。
//
// 为什么单独一个模块：`storydoc.js` 是既有的创意简报 + 大纲版本 + 分集规划，那三样一条
// 都不删（ADR-0087 的「旧版本永不删除」同一条道理）。新结构住在 `story.work` 里，与它们
// 并存 —— 迁移是**加法**，不是就地改写（AGENTS.md 第 13 条）。
//
// 纯数据 + 纯函数：没有 DOM、没有 fetch、没有时钟（`at` 一律由调用方传入）。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
const int = (x, lo, hi) =>
  Number.isInteger(x) && !(typeof x === "boolean") && x >= lo && x <= hi ? x : null;

/** 结构规划那张表的列 —— **顺序即合同**（产品负责人逐列点名过）。 */
export const PLAN_COLUMNS = [
  ["unitNo", "Unit No."],
  ["scene", "Scene"],
  ["purpose", "Scene 目的"],
  ["characters", "主要人物"],
  ["goal", "人物目标"],
  ["conflict", "冲突"],
  ["turn", "关键转折"],
  ["endingState", "Ending State"],
  ["outlineRefs", "关联故事大纲"],
];

/** 作品形态。`""` = 还没选 —— 不替他默认成任何一种。 */
export const FORMS = ["novel", "episode"];

let seq = 0;
/** 稳定 id。**不用时钟**（会破坏 round-trip 的确定性），种子由调用方给。
 *
 *  `taken` 是**必须给**的那半边：种子里的中文会被 `[^a-zA-Z0-9]` 过滤成空、退化成
 *  `"x"`，而 `seq` 是模块级的、每次加载归零 —— 于是中文项目重开一次会话再加一个
 *  节点，必然又派出 `on-x1`，和已经存进 `canvas.json` 的那个撞上。id 一撞，
 *  结构规划的引用就指到别的段落，而 `danglingRefs` 还认为它有效（补审 2026-09-05）。
 *  所以这里不是「尽量避开」，是**撞了就继续往下取**。 */
function mintId(prefix, seed, taken) {
  const s = str(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  for (;;) {
    seq += 1;
    const id = `${prefix}-${s || "x"}${seq.toString(36)}`;
    if (!taken || !taken.has(id)) return id;
  }
}

/* --- 大纲节点 --------------------------------------------------------------- */

/**
 * 把作者写的一段文本切成节点，**尽量保住已有节点的 id**。
 *
 * 为什么 id 必须稳：结构规划的「关联故事大纲」引用它。作者改一个错别字就换一批 id，
 * 那张表的引用就会集体断掉 —— 那正是「作者不用手动维护 id」这条要求的真实含义。
 *
 * 匹配规则：**先把全部原文精确匹配认完，再让剩下的按位置复用**，都不匹配才发新 id。
 *
 * 两趟不是讲究，是必需的。上一版在同一趟里「先试精确、不中就吃掉 `olds[i]`」，
 * 于是在中间插一段就会整体位移（补审 2026-09-05 抓到）：
 *
 *   [A, B, C] 中间插 X → [A, X, B, C]
 *     i=1 的 X 精确匹配不到，就按位置吃掉了 **B 的 id**；
 *     i=2 的 B 这时发现自己的 id 已被占用，只好按位置吃掉 **C 的 id**；
 *     i=3 的 C 只能拿一个新 id。
 *
 * 结果：结构规划里指向「B 段」的引用，指到了新插进来的 X 上，**而且不报 dangling**。
 * 这正是「作者不用手动维护 id」这条要求存在的理由 —— 引用错行比引用断掉更坏，
 * 断掉他看得见，错行他看不见。
 */
/** 两段文字有多像（bigram Dice，0–1）。**只用来在数目对不上时消歧**。
 *
 *  为什么不用「共同前后缀」那种更简单的算法：「X段」和「B段」共享后缀「段」，
 *  会算出 0.5 —— 一个毫不相干的新段落就能凭一个字抢走旧 id。bigram 下它们是 0。 */
function grams(s) {
  const t = str(s);
  if (t.length < 2) return t ? [t] : [];
  const out = [];
  for (let i = 0; i + 1 < t.length; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return str(a) === str(b) ? 1 : 0;
  const bag = new Map();
  for (const g of ga) bag.set(g, (bag.get(g) || 0) + 1);
  let hit = 0;
  for (const g of gb) {
    const n = bag.get(g) || 0;
    if (n > 0) {
      bag.set(g, n - 1);
      hit += 1;
    }
  }
  return (2 * hit) / (ga.length + gb.length);
}

/** 低于这个相似度就不认。**宁可让引用断掉，也不要让它指错地方** ——
 *  断掉他在表格里看得见（`§?`），指错他看不见。 */
const SIM_MIN = 0.34;

export function parseOutline(text, prev = [], reserved = null) {
  const olds = Array.isArray(prev) ? prev.filter(isObj) : [];
  const blocks = str(text)
    .split(/\n{2,}/)
    .flatMap((b) => b.split(/\n(?=\s*[-*·]\s+)/))
    .map((b) => b.trim())
    .filter(Boolean);

  const keep = new Array(blocks.length).fill(null);
  const usedOld = new Set();
  const anchors = [];
  // 第一趟：原文一字不差的先认领，谁都不许靠位置把它的 id 抢走。
  // 认下来的这些同时充当**锚点**。
  //
  // **锚点必须保序** —— 用最长公共子序列（LCS）挑，不用「先到先得」也不用
  // 「取位置最近的那个」。
  //
  // 前两版都栽在同一件事上：文字一模一样的段落（他复制粘贴过一段）之间，
  // **文本里没有任何信息能把它们区分开**，所以任何 tie-break 都能被构造出反例：
  //   - 取第一个 → 改第一段时，没改的第二段抢走它的 id（第十二轮）；
  //   - 取最近的 → 在它们前面插一段，两个 id 当场互换（第十三轮）。
  //
  // 能把它们区分开的只有**顺序**：第一个 A 仍然是第一个 A。LCS 挑出的锚点天然
  // 满足「i 和 j 同时递增」，交叉配对根本构造不出来 —— 这不是第三个 tie-break，
  // 是把这一类去掉。剩下的（真被改过的那些）照旧在相邻锚点之间配。
  const n = blocks.length;
  const m = olds.length;

  // **重复组缺了人，就整组不锚。**
  //
  // `[A(a), A(b)]` 删掉其中一个只剩 `[A]` —— 文本里**没有任何信息**能说明他删的是
  // 哪一个，两种解读同样成立。硬锚一个的话，幸存的那段就会继承被删那段的 id：
  // 指向被删段的引用静默转到幸存段上，而指向幸存段的引用断掉（codex 第十四轮）。
  //
  // 所以：某段文字在旧节点里出现 k 次、在新文本里只剩 k' < k 次时，**这组一个都不锚**，
  // 交给后面的机制 —— 数目对得上就按顺序一一配（「改了其中一段」因此仍然对得上），
  // 数目对不上就互相唯一那一关卡住，谁都不认，引用变 `§?`（他看得见）。
  //
  // 这不是第四个 tie-break：它不去猜，而是**认出「这里没法判断」并交给可见的失败**。
  const oldTally = new Map();
  for (const o of olds) {
    const t = str(o.text).trim();
    oldTally.set(t, (oldTally.get(t) || 0) + 1);
  }
  const newTally = new Map();
  for (const b of blocks) newTally.set(b, (newTally.get(b) || 0) + 1);
  const ambiguous = new Set();
  for (const [t, k] of oldTally) {
    if (k > 1 && (newTally.get(t) || 0) < k) ambiguous.add(t);
  }

  const same = (i, j) =>
    str(olds[j].text).trim() === blocks[i] && !ambiguous.has(blocks[i]);
  // 段落数极多时退回「先到先得」——它不完美，但 O(n·m) 的表在那种规模下更糟。
  if (n * m <= 1000000) {
    const dp = [];
    for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = same(i, j)
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (same(i, j)) {
        usedOld.add(j);
        keep[i] = olds[j];
        anchors.push([i, j]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] > dp[i][j + 1]) {
        // 平局时**先跳过旧节点**（j++），不是跳过新块。这样同文的一组里，
        // 没被 LCS 认领的那个旧节点会留在相邻区间里，由后面的一一配对接住 ——
        // 反过来（i++）会让被改的那一段领新 id，而那个旧 id 凭空消失。
        i += 1;
      } else {
        j += 1;
      }
    }
  } else {
    // 段落数极多时不建 O(n·m) 的表，但**退路也必须保序** —— 上一版这里是
    // 「先到先得」，也就是被 LCS 取代掉的那个算法：在大纲够长时，同一个 id
    // 互换的缺陷会原样复现（codex 第十四轮）。**一条已知错误的退路不是退路，
    // 是埋在阈值后面的地雷。**
    //
    // 双指针贪心：`j` 只往前走，所以锚点天然递增、交叉配对构造不出来。
    // 它不保证锚点最多（LCS 才保证），但这一档要的是「不会错」，不是「最优」。
    let j = 0;
    for (let i = 0; i < n; i += 1) {
      let k = j;
      while (k < m && !same(i, k)) k += 1;
      if (k < m) {
        usedOld.add(k);
        keep[i] = olds[k];
        anchors.push([i, k]);
        j = k + 1;
      }
    }
  }

  // 第二趟：**在相邻锚点之间**按顺序配对，而不是拿 `olds[i]` 硬套下标。
  //
  // 下标硬套在「插一段 + 改一段」同时发生时会错（codex 补审 2026-09-05 第七轮）：
  //   [A, B, C] 改成 [X, A, B改, C]
  //     精确匹配先认走 A 和 C；`B改` 落在下标 2，而 olds[2] 是已被占用的 C，
  //     于是它拿不到 B 的 id —— 指向 B 的结构规划引用当场断掉。
  //   按锚点分段之后：A 和 C 之间，块只剩 `B改`、旧节点只剩 `B`，一对一配上。
  const segs = [[-1, -1], ...anchors, [blocks.length, olds.length]];
  for (let s = 0; s + 1 < segs.length; s += 1) {
    const [bi, oj] = segs[s];
    const [be, oe] = segs[s + 1];
    const gapBlocks = [];
    for (let i = bi + 1; i < be; i += 1) if (!keep[i]) gapBlocks.push(i);
    const gapOlds = [];
    for (let j = oj + 1; j < oe; j += 1) if (!usedOld.has(j)) gapOlds.push(j);

    if (gapBlocks.length === gapOlds.length) {
      // 数目一样 —— 一一对应没有歧义。**这一支必须按顺序配，不看像不像**：
      // 他把一整段推倒重写时，新旧文字可以毫无共同点，但那仍然是同一段。
      for (let n = 0; n < gapBlocks.length; n += 1) {
        usedOld.add(gapOlds[n]);
        keep[gapBlocks[n]] = olds[gapOlds[n]];
      }
    } else {
      // 数目对不上（插了或删了）——**按顺序配就会配错**（codex 补审第八轮）：
      //   [A, B, C] 改成 [A, X, B改, C]
      //     锚点是 A 和 C，区间里有两个块（X、B改）却只剩一个旧节点（B）；
      //     按顺序配 → **X 抢走了 B 的 id**，而 B改 领到一个新 id ——
      //     指向 B 段的结构规划引用于是静默指到了新插进来的 X 上。
      // 所以这一支按内容相似度配，并设下限：宁可断掉，也不要指错。
      // **两个方向都唯一才认。**
      //
      // 上一版只查了一个方向（「这个旧节点的候选是不是只有一个」），漏掉了反方向
      // ——**多个旧节点争同一个块**（codex 第十轮）：
      //   旧：[他走进房间, 他走出房间]；新文本删掉前者、把后者改成「他走出房间后坐下」
      //   「他走进房间」对这个新段落的相似度 ≈0.36，刚过阈值，而它排在前面，
      //   于是**先把 id 认走了** —— 新段落继承了一个已经被删掉的段落的身份，
      //   指向它的引用静默错行。
      //
      // 所以配对必须是**互相唯一**：这个旧节点只有这一个候选，且这个块也只被
      // 这一个旧节点看上。任何一边有第二人，就谁都不认（引用变 §?，他看得见）。
      const candOf = new Map();
      const claimants = new Map();
      for (const j of gapOlds) {
        const hits = [];
        for (const i of gapBlocks) {
          if (keep[i]) continue;
          if (similarity(olds[j].text, blocks[i]) >= SIM_MIN) hits.push(i);
        }
        candOf.set(j, hits);
        for (const i of hits) claimants.set(i, (claimants.get(i) || 0) + 1);
      }
      for (const j of gapOlds) {
        // **够得上的候选不止一个时，一个都不认。**
        //
        // 文字相似度分不清「把这段改了」和「在旁边插了一段很像的」。codex 第九轮
        // 给了一个直接打穿取最高分的例子：原文「他走进房间」，新文本里插入
        // 「他走进房间后坐下」（≈0.73）而原句被改成「他走出房间」（≈0.5）——
        // 取最高分就把 id 判给了**新插进来的那段**，指向原句的引用于是静默错行。
        //
        // 这种输入**本来就是有歧义的**，再调阈值也只是把反例往后推一格。所以按
        // 这个仓库一贯的偏向办：**宁可让引用断掉，也不要让它指错** ——
        // 断掉他在表格里看得见（`§?`），指错他看不见。
        const hits = candOf.get(j) || [];
        if (hits.length !== 1) continue; // 这个旧节点自己就有歧义
        const i = hits[0];
        if (keep[i]) continue;
        if ((claimants.get(i) || 0) !== 1) continue; // 这个块被不止一个旧节点看上
        usedOld.add(j);
        keep[i] = olds[j];
      }
    }
  }

  // 新 id 要避开**全部**旧 id，还要避开 `reserved` —— 那是「已经退休、但还有人
  // 指着它」的那些（结构规划的引用）。不避开的话：中文项目里 `on-x1` 被删掉、
  // 引用还留着，重开会话后新写的段落会**重新领走 on-x1**，那条本已失效的引用
  // 就静默指到一段毫不相干的文字上 —— 引用错行比引用断掉更坏，断掉他看得见。
  const taken = new Set(olds.map((o) => o.id));
  for (const id of reserved || []) if (id) taken.add(String(id));
  return blocks.map((body, i) => {
    const id = keep[i] ? keep[i].id : mintId("on", body, taken);
    taken.add(id);
    return {
      id,
      kind: /^\s*[-*·]\s+/.test(body) ? "item" : "para",
      text: body,
    };
  });
}

/** 还指着某个节点 id 的**全部**地方 —— 包括指向已经不存在的节点的那些。
 *
 *  这份名单决定「哪些 id 不许被新段落重新领走」。漏掉任何一处载体，那一处的引用
 *  就会在某天静默指到一段毫不相干的文字上（引用错行比引用断掉更坏：断掉他在表格里
 *  看得见 `§?`，指错他看不见）。
 *
 *  **载体只有两个，已穷举**（`grep outlineRefs` 全仓核对过）：
 *
 *    1. 当前的 `plan.rows` —— 软删除的行也算，它随时可能从回收区被拿回来；
 *    2. **定稿快照 `finalized.plan[].body`** —— 那是行的 JSON。上一版漏了这一处
 *       （codex 补审 2026-09-05 第十一轮）：定稿一版含 `on-x1` 的规划、把当前行的
 *       引用清掉、删掉那个节点、重开会话再写一段中文 —— `on-x1` 被重新发出去，
 *       此后**恢复那一版规划**，它那条老引用就指向了新的无关段落。
 *       软删除掉的版本同样要算：它也能被拿回来。 */
function referencedNodeIds(work) {
  const out = new Set();
  const take = (rows) => {
    for (const row of rows || []) {
      for (const ref of (row && row.outlineRefs) || []) if (ref) out.add(String(ref));
    }
  };
  take(work && work.plan && work.plan.rows);
  for (const rec of (work && work.finalized && work.finalized.plan) || []) {
    if (!isObj(rec) || typeof rec.body !== "string") continue;
    try {
      const rows = JSON.parse(rec.body);
      if (Array.isArray(rows)) take(rows);
    } catch {
      // 快照坏了就跳过这一份 —— 保留集少一条好过整个大纲编辑挂掉
    }
  }
  return out;
}

/** 节点拼回作者看到的那段文本。 */
export function outlineText(work) {
  return (work.outline.nodes || []).map((n) => n.text).join("\n\n");
}

export function setOutline(work, text) {
  work.outline.nodes = parseOutline(text, work.outline.nodes, referencedNodeIds(work));
  return work.outline.nodes;
}

/* --- 结构规划 --------------------------------------------------------------- */

/** 历史版本记录：形状不对的一律丢，但**已有的一条都不改写**。 */
function sanitizeFinals(list) {
  return (Array.isArray(list) ? list : []).filter(isObj).map((r, i) => ({
    v: int(r.v, 1, 100000) ?? i + 1,
    at: str(r.at),
    note: str(r.note).slice(0, 500),
    body: str(r.body),
    // **回收区要活过刷新。** 读盘是按白名单重建记录的，新加的 `deleted` 一旦没写在
    // 这里，就会在下一次加载时被丢掉 —— 他删掉的每一版全部复活成正常历史，
    // 回收区自己清空，而「软删除」的全部意义就是那条撤销路还在
    //（补审 2026-09-05 第三轮）。
    ...(isObj(r.deleted) ? { deleted: { at: str(r.deleted.at) } } : {}),
  }));
}

function sanitizeRow(r, i, taken) {
  const src = isObj(r) ? r : {};
  const row = { id: str(src.id) || mintId("sp", `r${i}`, taken) };
  for (const [key] of PLAN_COLUMNS) {
    if (key === "outlineRefs") {
      row.outlineRefs = (Array.isArray(src.outlineRefs) ? src.outlineRefs : [])
        .filter((x) => typeof x === "string" && x)
        .slice(0, 20);
    } else if (key === "unitNo") {
      row.unitNo = str(src.unitNo).slice(0, 40);
    } else {
      row[key] = str(src[key]).slice(0, 2000);
    }
  }
  // 软删除：删一行也要能撤销（第 13 条）
  row.hidden = isObj(src.hidden) && str(src.hidden.at) ? { at: str(src.hidden.at) } : null;
  // 出生时就带着它，否则 round-trip 会掉一个字段（第一次跑 round-trip 就撞见）
  row.createdAt = str(src.createdAt);
  return row;
}

export function addPlanRow(work, at) {
  const row = sanitizeRow({ unitNo: String(visiblePlanRows(work).length + 1) }, work.plan.rows.length);
  row.createdAt = str(at);
  work.plan.rows.push(row);
  return row;
}

export function editPlanRow(work, id, field, value) {
  if (!PLAN_COLUMNS.some(([k]) => k === field)) return false;
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row) return false;
  if (field === "outlineRefs") {
    // 收到不是数组的东西 → **拒绝**，不是清空。上一版把它写成 `[]` 还 `return true`：
    // 一次 `plan.row.edit(field="outlineRefs", value="§3")` 就能抹掉整行引用，
    // 而回执照样说「改好了」（补审 2026-09-05）。改引用只走 `plan.row.link`。
    if (!Array.isArray(value)) return false;
    row.outlineRefs = value.filter((x) => typeof x === "string" && x).slice(0, 20);
  } else {
    row[field] = str(value).slice(0, 2000);
  }
  return true;
}

export function hidePlanRow(work, id, at) {
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row || row.hidden) return false;
  row.hidden = { at: str(at) };
  return true;
}

export function restorePlanRow(work, id) {
  const row = work.plan.rows.find((r) => r.id === id);
  if (!row || !row.hidden) return false;
  row.hidden = null;
  return true;
}

export const visiblePlanRows = (work) => work.plan.rows.filter((r) => !r.hidden);

/** 引用了一个已经不存在的大纲节点 —— **说出来**，不要静默丢掉那一格。 */
export function danglingRefs(work) {
  const live = new Set((work.outline.nodes || []).map((n) => n.id));
  const out = [];
  for (const row of visiblePlanRows(work)) {
    for (const ref of row.outlineRefs) if (!live.has(ref)) out.push({ rowId: row.id, ref });
  }
  return out;
}

/* --- 形态与单元（章 / 集）--------------------------------------------------- */

export function setForm(work, form) {
  if (!FORMS.includes(form)) return false;
  work.form = form;
  return true;
}

/** 计划写多少章 / 多少集。**可增可减**，减少时既有单元不删（只是不在计划内）。 */
export function setPlanned(work, kind, n) {
  if (!FORMS.includes(kind)) return false;
  const v = int(n, 0, 500);
  if (v === null) return false;
  work.planned[kind] = v;
  return true;
}

/** 拿到第 no 个单元，没有就建一个（章/集共用一张表，用 kind 区分）。 */
export function ensureUnit(work, kind, no, at) {
  if (!FORMS.includes(kind)) return null;
  const n = int(no, 1, 500);
  if (n === null) return null;
  let unit = work.units.find((u) => u.kind === kind && u.no === n);
  if (!unit) {
    unit = {
      id: mintId("u", `${kind}${n}`, new Set(work.units.map((u) => u.id))),
      kind,
      no: n,
      title: "",
      brief: "",
      body: "",
      updatedAt: str(at),
      finalized: [],
    };
    work.units.push(unit);
  }
  return unit;
}

/** 一章/集正文的上限。**超了是拒绝，不是砍掉一截。**
 *
 *  上一版这里 `slice(0, 200000)`：追加一个字到一篇已经 20 万字的正文上，
 *  参数长度检查过得去，拼接之后被这里悄悄切回 20 万，而动作回执照样报
 *  「第 1 章现在有 200000 字」—— 追加的内容凭空消失（codex 第十轮）。
 *
 *  **这是这条路上最后一处静默截断**，去掉它，「不静默丢字」才是真的。 */
export const UNIT_MAX = 200000;

export function editUnit(work, id, field, value, at) {
  if (!["title", "brief", "body"].includes(field)) return false;
  const unit = work.units.find((u) => u.id === id);
  if (!unit) return false;
  const text = str(value);
  if (text.length > UNIT_MAX) return false;
  unit[field] = text;
  unit.updatedAt = str(at);
  return true;
}

/* --- 定稿：日常只留最新，定稿才存历史 --------------------------------------- */

/** 下一个版本号 = **现有最大号 + 1**，不是 `list.length + 1`。
 *
 *  他可以手动删中间那一版（这是他点名要的能力）。用长度派号的话：删掉 v2 之后
 *  再定稿会派出第二个 v3 —— 于是「恢复 v3」恢复到旧的那一版、「删掉 v3」一次删掉
 *  两版（补审 2026-09-05）。版本号是他用来指认某一版的**名字**，重名就没有指认。 */
function nextV(list) {
  let max = 0;
  for (const x of list || []) {
    const v = Number(x && x.v);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

/**
 * 存一版历史。**日常编辑不进这里** —— 产品负责人要的是「默认只显示当前最新版」，
 * 历史只在他主动定稿时产生（可看、可恢复、可删）。
 */
export function finalizeUnit(work, id, at, note = "") {
  const unit = work.units.find((u) => u.id === id);
  if (!unit) return null;
  const live = visibleVersions(unit.finalized);
  const last = live[live.length - 1];
  if (last && last.body === unit.body && last.title === unit.title) return null;
  const rec = {
    v: nextV(unit.finalized),
    at: str(at),
    note: str(note).slice(0, 500),
    title: unit.title,
    body: unit.body,
  };
  unit.finalized.push(rec);
  return rec;
}

export function restoreFinalized(work, id, v, at) {
  const unit = work.units.find((u) => u.id === id);
  const rec = unit && visibleVersions(unit.finalized).find((x) => x.v === v);
  if (!rec) return false;
  // 同 `restoreDoc`：先把当前这一稿存起来，再覆盖
  finalizeUnit(work, id, at, "恢复前自动存档（不是你点的定稿）");
  unit.title = rec.title;
  unit.body = rec.body;
  unit.updatedAt = str(at);
  return true;
}

/** 没被删掉的那些版本。 */
export function visibleVersions(list) {
  return (Array.isArray(list) ? list : []).filter((x) => isObj(x) && !x.deleted);
}

/** 手动删一版历史 —— 他明确要求「历史版本可查看、恢复、**手动删除**」。
 *
 *  **软删除，不是真删字节。** 动作注册表只收可逆的动作（AGENTS.md §1），而上一版
 *  这条动作的 `undo` 自己写着「删掉就没有了」，却因为没声明 `reversible: false`
 *  被默认补成可逆、混过了准入检查 —— 那道检查因此形同虚设（补审 2026-09-05）。
 *  软删除让那句 `undo` 变成真的：他看到的是没了，回收区里还能拿回来。 */
export function deleteFinalized(work, id, v, at) {
  const unit = work.units.find((u) => u.id === id);
  const rec = unit && visibleVersions(unit.finalized).find((x) => x.v === v);
  if (!rec) return false;
  rec.deleted = { at: str(at) };
  return true;
}

/** 撤销「删掉某一版」。 */
export function undeleteFinalized(work, id, v) {
  const unit = work.units.find((u) => u.id === id);
  const rec = unit && (unit.finalized || []).find((x) => x.v === v && x.deleted);
  if (!rec) return false;
  delete rec.deleted;
  return true;
}

/* --- 建立 / 序列化 ---------------------------------------------------------- */

export function createWork(saved) {
  const src = isObj(saved) ? saved : {};
  const work = {
    // 形态没选就是没选：不替他默认成小说或剧集
    form: FORMS.includes(src.form) ? src.form : "",
    core: str(src.core),
    outline: { nodes: [] },
    plan: { rows: [] },
    planned: {
      novel: int(isObj(src.planned) ? src.planned.novel : null, 0, 500) ?? 0,
      episode: int(isObj(src.planned) ? src.planned.episode : null, 0, 500) ?? 0,
    },
    units: [],
    // 哪些内容已经从旧结构迁过来了 —— 只灌一次，之后他自己写的那一份才是权威
    // 定稿出来的历史版本（四样内容同一条规矩，见 finalizeDoc）
    finalized: {
      core: sanitizeFinals(isObj(src.finalized) ? src.finalized.core : null),
      outline: sanitizeFinals(isObj(src.finalized) ? src.finalized.outline : null),
      plan: sanitizeFinals(isObj(src.finalized) ? src.finalized.plan : null),
    },
    seeded: {
      core: str(isObj(src.seeded) ? src.seeded.core : ""),
      outline: str(isObj(src.seeded) ? src.seeded.outline : ""),
    },
  };
  // 读盘时补 id 也要避开这一份文档里已经有的 id —— 否则两条记录同名，
  // 后一条在界面上永远打不开（补审 2026-09-05）。
  const nodes = isObj(src.outline) && Array.isArray(src.outline.nodes) ? src.outline.nodes : [];
  const nodeIds = new Set(nodes.filter(isObj).map((n) => str(n.id)).filter(Boolean));
  work.outline.nodes = nodes.filter(isObj).map((n, i) => {
    const id = str(n.id) || mintId("on", `n${i}`, nodeIds);
    nodeIds.add(id);
    return { id, kind: n.kind === "item" ? "item" : "para", text: str(n.text) };
  });
  const rows = isObj(src.plan) && Array.isArray(src.plan.rows) ? src.plan.rows : [];
  const rowIds = new Set(rows.filter(isObj).map((r) => str(r.id)).filter(Boolean));
  work.plan.rows = rows.filter(isObj).map((r, i) => {
    const row = sanitizeRow(r, i, rowIds);
    rowIds.add(row.id);
    return row;
  });
  const rawUnits = (Array.isArray(src.units) ? src.units : []).filter(isObj);
  const unitIds = new Set(rawUnits.map((u) => str(u.id)).filter(Boolean));
  work.units = rawUnits.map((u, i) => ({
    id: str(u.id) || mintId("u", `u${i}`, unitIds),
    kind: FORMS.includes(u.kind) ? u.kind : "episode",
    no: int(u.no, 1, 500) ?? i + 1,
    title: str(u.title),
    brief: str(u.brief),
    body: str(u.body),
    updatedAt: str(u.updatedAt),
    finalized: (Array.isArray(u.finalized) ? u.finalized : [])
      .filter(isObj)
      .map((f, j) => ({
        v: int(f.v, 1, 10000) ?? j + 1,
        at: str(f.at),
        note: str(f.note),
        title: str(f.title),
        body: str(f.body),
        // 同 `sanitizeFinals`：章/集的回收区一样要活过刷新
        ...(isObj(f.deleted) ? { deleted: { at: str(f.deleted.at) } } : {}),
      })),
  }));
  return work;
}

export function serializeWork(work) {
  return {
    form: work.form,
    core: work.core,
    outline: { nodes: work.outline.nodes },
    plan: { rows: work.plan.rows },
    planned: work.planned,
    units: work.units,
    finalized: work.finalized,
    seeded: work.seeded,
  };
}

/** 迁移：现有的分集规划变成结构规划的行。**加法** —— 旧数据一条不动。 */
export function seedPlanFromEpisodes(work, episodes, at) {
  if (visiblePlanRows(work).length) return 0;
  let n = 0;
  for (const [i, ep] of (Array.isArray(episodes) ? episodes : []).entries()) {
    if (!isObj(ep)) continue;
    const row = addPlanRow(work, at);
    row.unitNo = String(i + 1);
    row.scene = str(ep.title);
    row.purpose = str(ep.logline || ep.purpose || "");
    n += 1;
  }
  return n;
}

/* --- 从旧结构迁进来（加法，不删旧的）--------------------------------------- */

/** 故事核心那一篇的分节顺序 —— 产品负责人 2026-08-30 点名的五样。 */
export const CORE_SECTIONS = [
  // 每一节列的是**所有可能承载它的字段**：他这个项目里填的是 `logline` / `themes` /
  // `characters` / `beats`，另一个项目里可能填的是那八个结构化项。两套都读 ——
  // 「旧数据还在文档里」但没出现在他眼前的编辑器里，等于没有（真项目上验出来的）。
  ["立意", ["storyCore", "premise", "logline", "themeAndChange", "themes"]],
  ["主角", ["protagonist", "characters"]],
  ["冲突", ["centralConflict", "conflict"]],
  ["世界规则", ["world", "worldAndRules", "genreTone"]],
  ["人物关系", ["keyRelationships"]],
];

/** 常见子键的中文名 —— 迁过来的那一篇要能读，不是一串 `who / initialWant`。 */
const SUBKEY_LABEL = {
  who: "谁", initialWant: "最开始想要什么", name: "姓名", role: "角色",
  want: "他要什么", obstacle: "挡在前面的", external: "外部冲突", internal: "内心冲突",
  theme: "主题", protagonistBecomes: "最后变成了谁", where: "地点", rules: "规则",
  nature: "关系", howItChanges: "怎么变的", truth: "真相", revealAround: "何时揭开",
  setup: "开端", development: "发展", midpointTurn: "中段转折", climax: "高潮", ending: "结局",
};

const line = (v) => (typeof v === "string" ? v.trim() : "");

/** 把一个大纲字段渲染成人读的文本 —— 结构化的那几个拆成小标题，列表拆成条目。 */
function fieldText(key, val) {
  if (typeof val === "string") return line(val);
  if (Array.isArray(val)) {
    return val
      .map((row) =>
        isObj(row)
          ? Object.entries(row)
              .map(([k, v]) => (line(v) ? `${SUBKEY_LABEL[k] || k}：${line(v)}` : ""))
              .filter(Boolean)
              .join("；")
          : line(row),
      )
      .filter(Boolean)
      .map((s) => `- ${s}`)
      .join("\n");
  }
  if (isObj(val)) {
    return Object.entries(val)
      .map(([k, v]) => {
        const body = Array.isArray(v) ? v.map(line).filter(Boolean).join("、") : line(v);
        return body ? `${SUBKEY_LABEL[k] || k}：${body}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 把既有的创意简报 + 大纲版本写成「故事核心」那一篇。
 *
 * 为什么要迁：他的规格说故事核心「只使用一个大型文本编辑器」。如果那个编辑器是空的，
 * 他四版大纲里写下的东西就等于从屏幕上消失了 —— **旧数据一个字不删**（第 13 条），
 * 但它得**出现在他现在看的那一页里**，否则「不删」只是技术上的说法。
 *
 * 只灌一次（`seeded.core`）：之后他自己改的那一篇才是权威，重开一次不许覆盖它。
 */
export function seedCoreFromStory(work, outlineFields, brief, at) {
  if (work.seeded.core) return false;
  const src = isObj(outlineFields) ? outlineFields : {};
  const parts = [];
  for (const [title, keys] of CORE_SECTIONS) {
    const body = keys.map((k) => fieldText(k, src[k])).filter(Boolean).join("\n");
    if (body) parts.push(`## ${title}\n${body}`);
  }
  const b = isObj(brief) ? brief : {};
  const meta = [
    b.genre ? `类型：${line(b.genre)}` : "",
    b.tone ? `基调：${line(b.tone)}` : "",
  ].filter(Boolean);
  if (meta.length) parts.push(`## 基本信息\n${meta.join("\n")}`);
  work.seeded.core = str(at) || "1";
  if (!parts.length) return false;
  work.core = parts.join("\n\n");
  return true;
}

/** 大纲主线写成节点化文本（开端 / 发展 / 中段转折 / 高潮 / 结局，顺序即信息）。 */
export function seedOutlineFromStory(work, outlineFields, at) {
  if (work.seeded.outline) return false;
  work.seeded.outline = str(at) || "1";
  const src = isObj(outlineFields) ? outlineFields : {};
  const mainline = isObj(src.mainline) ? src.mainline : {};
  const order = [
    ["setup", "开端"],
    ["development", "发展"],
    ["midpointTurn", "中段转折"],
    ["climax", "高潮"],
    ["ending", "结局"],
  ];
  const blocks = order
    .map(([k, label]) => (line(mainline[k]) ? `${label}：${line(mainline[k])}` : ""))
    .filter(Boolean);
  const tail = [fieldText("storyArc", src.storyArc), fieldText("ending", src.ending)]
    .filter(Boolean);
  // 他这个项目的 mainline 是空壳，真正写下的主线在 `beats` 里 —— 退回去读它，
  // 一条一个节点（顺序本身就是信息）。
  const beats = Array.isArray(src.beats) ? src.beats.map(line).filter(Boolean) : [];
  const text = blocks.length || tail.length
    ? [...blocks, ...tail].join("\n\n")
    : beats.join("\n\n");
  if (!text) return false;
  setOutline(work, text);
  return true;
}

/* --- 定稿（故事核心 / 故事大纲 / 结构规划）--------------------------------- */
//
// 产品负责人 2026-08-30 的版本规则不是只管正文：「日常编辑只维护当前最新版。只有用户
// 主动『定稿/保存版本』时才生成历史版本。默认 UI 只显示当前最新版。历史版本可查看、
// 恢复、手动删除。」——四样内容同一条规矩，所以这里是**一份实现**，不是四份。

export const DOC_KINDS = ["core", "outline", "plan"];

/** 某一样内容此刻的快照文本（存历史与比较用的**同一个**取值口径）。 */
export function docSnapshot(work, kind) {
  if (kind === "core") return work.core;
  if (kind === "outline") return outlineText(work);
  if (kind === "plan") return JSON.stringify(visiblePlanRows(work));
  return null;
}

/** 存一版。内容没变就不重复存（返回 null）。 */
export function finalizeDoc(work, kind, at, note = "") {
  if (!DOC_KINDS.includes(kind)) return null;
  const body = docSnapshot(work, kind);
  const list = work.finalized[kind];
  // 跟**看得见的**最后一版比。跟数组末尾比的话：删掉最后一版之后再用同样内容定稿，
  // 会被判成「没改」而什么都不存，他点了定稿却没有新版本（补审 2026-09-05 第三轮）。
  const live = visibleVersions(list);
  const last = live[live.length - 1];
  if (last && last.body === body) return null;
  const rec = {
    v: nextV(list),
    at: str(at),
    note: str(note).slice(0, 500),
    body: typeof body === "string" ? body : "",
  };
  list.push(rec);
  return rec;
}

/** 恢复前先把**当前内容**存一版。
 *
 *  「恢复到 v2」会盖掉他今天写了、但还没点定稿的正文 —— 上一版直接覆盖，一个字
 *  也找不回来（补审 2026-09-05 · AGENTS.md 第 13 条：不得静默覆盖，覆盖前留可回滚）。
 *  这一版是自动存的，`note` 里说清楚，免得他以为自己定过这一稿。 */
function archiveBeforeRestore(work, kind, at) {
  return finalizeDoc(work, kind, at, "恢复前自动存档（不是你点的定稿）");
}

/** 恢复到某一版。大纲会**重新解析**，尽量保住还在的节点 id。 */
export function restoreDoc(work, kind, v, at) {
  const rec = visibleVersions(work.finalized[kind]).find((x) => x.v === v);
  if (!rec) return false;
  if (!DOC_KINDS.includes(kind)) return false;
  // 先解析，再存档 —— 解析失败就什么都别动（存了档却没恢复成，是白留一版）
  let rows = null;
  if (kind === "plan") {
    try {
      rows = JSON.parse(rec.body);
    } catch {
      return false;
    }
    if (!Array.isArray(rows)) return false;
  }
  archiveBeforeRestore(work, kind, at);
  if (kind === "core") work.core = rec.body;
  else if (kind === "outline") setOutline(work, rec.body);
  else {
    // **回收区不能被恢复顺手清掉。** 快照里只有当时可见的行（`docSnapshot` 取的是
    // `visiblePlanRows`），上一版拿它整体替换 `work.plan.rows`，于是软删除的行
    // ——他随时能恢复的那些——在恢复任意历史版本时被永久丢弃，而软删除的全部意义
    // 就是那条撤销路还在（补审 2026-09-05 · CA §5.2）。
    // **回收区里的行原样不动。** 上一版只保住「快照里没有」的隐藏行，于是这条路
    // 会丢字（codex 补审 2026-09-05 一轮就抓到，五轮同模型自审全没看见）：
    //
    //   某行以内容 A 定稿 → 改成 B → 删进回收区 → 恢复那一版定稿
    //     快照里有这一行（内容 A），所以它不算「快照里没有」，不被保留；
    //     于是它被快照版整体替换回 A，**而且还从回收区里被拽了出来** ——
    //     B 一个字都找不回来（自动存档只存看得见的行，B 当时正躺在回收区里）。
    //
    // 正确语义是两件事分开：版本历史管「看得见的那些长什么样」，回收区管
    // 「他删掉了什么」。恢复旧版本不该顺手把他删掉的东西拽回来，更不该改写它。
    const hidden = work.plan.rows.filter((r) => r.hidden);
    const hiddenIds = new Set(hidden.map((r) => r.id));
    const takenIds = new Set(work.plan.rows.map((r) => r.id));
    const restored = rows
      .filter(isObj)
      .map((r, i) => sanitizeRow(r, i, takenIds))
      .filter((r) => !hiddenIds.has(r.id));
    work.plan.rows = restored.concat(hidden);
  }
  return true;
}

/** 手动删一版历史 —— 删历史不动当前内容。**软删除**，理由同 `deleteFinalized`。 */
export function deleteDoc(work, kind, v, at) {
  const list = work.finalized[kind];
  if (!Array.isArray(list)) return false;
  const rec = visibleVersions(list).find((x) => x.v === v);
  if (!rec) return false;
  rec.deleted = { at: str(at) };
  return true;
}

/** 撤销「删掉某一版」。 */
export function undeleteDoc(work, kind, v) {
  const list = work.finalized[kind];
  if (!Array.isArray(list)) return false;
  const rec = list.find((x) => isObj(x) && x.v === v && x.deleted);
  if (!rec) return false;
  delete rec.deleted;
  return true;
}
