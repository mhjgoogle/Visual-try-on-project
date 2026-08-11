// DEMO-MODE seed: a short film mid-production.
//
// Demo mode previously opened on an all-but-empty project, so every media-first
// surface rendered as an empty state and the studio could not be evaluated (or
// screenshotted) at all. This fixture seeds ONE realistic project — story →
// bible → episodes/scenes → shots → image/video/audio variants → timeline —
// through the SAME domain APIs the UI writes with, so nothing here can drift
// from the real schema: if a domain rule changes, this seed breaks with it.
//
// STRICT BOUNDARIES:
// - demo mode ONLY (guarded by the caller); connected mode never seeds.
// - no new domain concepts, no schema fields, no second source of truth — it
//   only calls proddoc / bibledoc / storydoc / scriptdoc / mediaref / genlib.
// - all media is a procedural `data:` placeholder that labels itself as such
//   (fixtures/demo-media.js) — no bytes, no network, no committed binaries.
// - deliberately UNEVEN progress (some shots have 3 image variants, some 1,
//   some none; only the first scenes have video) so the UI's real empty and
//   partial states stay visible instead of a uniformly "finished" fantasy.

import { mintId } from "../src/workflow/identity.js";
import * as proddoc from "../src/workflow/proddoc.js";
import * as bibledoc from "../src/workflow/bibledoc.js";
import * as storydoc from "../src/workflow/storydoc.js";
import * as canondoc from "../src/workflow/canondoc.js";
import * as scriptdoc from "../src/workflow/scriptdoc.js";
import * as mediaref from "../src/workflow/mediaref.js";
import * as genlib from "../src/workflow/genlib.js";
import * as assetlib from "../src/workflow/assetlib.js";
import * as timelinedoc from "../src/workflow/timeline.js";
import { placeholderFrame, placeholderWave } from "./demo-media.js";

// A fixed clock: the seed must be byte-identical across runs so screenshots
// and unit tests never differ because of wall time.
const T0 = "2026-08-04T21:12:00.000Z";
const at = (mins) => new Date(Date.parse(T0) + mins * 60000).toISOString();

export const DEMO_PROJECT_NAME = "夜班沉默 · 都市悬疑短剧";

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

const IDEA =
  "林晚在深夜酒吧打工。某个雨夜起，每个坐到吧台前的客人，都在向她讲述同一个她完全不记得的夜晚——" +
  "而那个夜晚里，她是唯一的目击者。";

const OUTLINE_V1 = {
  premise: "一个失忆的酒吧女招待，从陌生客人的讲述里，一点点拼回自己参与过的那桩命案。",
  logline: "深夜酒吧的女招待林晚发现，每个客人都在描述同一个她记不起的雨夜；当拼图接近完整，她意识到自己既是唯一的目击者，也是最后一个嫌疑人。",
  genreTone: "都市悬疑 / 心理惊悚。冷蓝夜色与酒吧暖橘对冲，潮湿、克制、低饱和。",
  world: "南方港城的雨季。一条即将拆迁的老街，街尾一家还在营业的酒吧「沉默」，对面是市立医院旧楼。",
  centralConflict: "林晚想找回记忆，但每恢复一块，她与凶案的距离就近一分——真相和自我保全彻底对立。",
  storyArc: "失忆日常 → 客人讲述的裂缝 → 主动追查 → 发现自己在场 → 与陈默对峙 → 记忆归位 → 选择说出真相。",
  ending: "林晚在天台上把录音交给陈默，雨停。她记起了一切，也失去了可以退回的位置。",
  durationNote: "6 集 × 每集 6–8 分钟，竖屏短剧。",
  characterConcepts: [
    "林晚 — 26 岁，酒吧女招待，逆行性失忆，克制、观察力极强",
    "陈默 — 34 岁，负责旧案的刑警，与林晚有未言明的旧关系",
    "苏婉 — 48 岁，酒吧老板娘，知道的比说出来的多",
    "老周 — 61 岁，老街最后的住户，命案当晚的另一个在场者",
  ],
  episodeCount: 6,
};

const OUTLINE_V2 = {
  ...OUTLINE_V1,
  logline: "在一条等待拆迁的老街上，失忆的酒吧女招待林晚从每位客人的讲述里拼回一个雨夜——直到拼图指向她自己。",
  genreTone: "都市悬疑 / 心理惊悚。冷蓝雨夜与酒吧钠灯暖橘强对冲；手持、浅景深、低饱和，克制不炫技。",
  storyArc:
    "失忆日常（EP01）→ 讲述之间的矛盾（EP02）→ 主动追查旧案（EP03）→ 发现自己在场（EP04）→ 与陈默正面对峙（EP05）→ 记忆归位与选择（EP06）。",
  ending: "天台雨夜，林晚把那卷录音交给陈默。雨停，她记起了一切，也再没有可以退回的位置。",
};

// ---------------------------------------------------------------------------
// Creative Brief · World Setting · Relationships · Episode beats (TASK-057)
// ---------------------------------------------------------------------------

const BRIEF = {
  genre: "都市悬疑 / 心理惊悚",
  tone: "潮湿、克制、低饱和。冷蓝雨夜与酒吧钠灯暖橘对冲。",
  form: "竖屏短剧，每集一个「讲述」，主线在讲述之间的矛盾里推进。",
  targetEpisodes: 6,
  episodeDuration: "6–8 分钟",
  totalDuration: "全 6 集约 40 分钟",
  notes: "不靠反转堆叠，靠同一个夜晚被反复重述时的偏差。禁忌：把林晚写成受害者叙事。",
};

const WORLD = {
  era: "当代，南方港城的雨季。故事集中在连续十一个雨夜。",
  rules:
    "1) 记忆只能被他人的讲述唤起，林晚自己无法主动回忆。2) 每一次唤起都有代价：她离「在场」更近一步。" +
    "3) 录音是这个世界里唯一不会改口的证物。",
  society: "老街等待拆迁，住户陆续搬离；旧案属于没人愿意重开的档案，警方内部也希望它继续沉默。",
  regions: "老街（酒吧「沉默」所在）· 市立医院旧楼 · 城郊的档案仓库",
  places: "创作方向：一条街 + 三个内景就够；不扩张地图，让空间反复出现产生压迫感。",
  visualTone: "手持、浅景深、低饱和。雨水与玻璃反光是常驻元素。",
  atmosphere: "每一集结束时，观众应该比林晚多知道一点，却比她更不安。",
};

const RELATIONSHIPS = [
  {
    a: "linwan", b: "chenmo",
    profile: {
      basis: "三年前的旧关系，从未说明白；现在是唯一还在查这桩案子的刑警与唯一的目击者。",
      aToB: "林晚知道只有陈默不会把她当疯子，但也清楚他随时可以把她变成嫌疑人。",
      bToA: "陈默想还她一个清白，又怕查到底会证明相反的事。他一直没说自己那天也在场。",
      coreConflict: "两人都想要真相，但真相对彼此的代价方向相反。",
      tension: "长期的克制。互相递东西时会避免碰到手。",
      power: "陈默掌握案卷与传唤权；林晚掌握那卷录音。权力随录音归属反转。",
      history: "三年前那个雨夜之后，陈默主动申请调离，没有解释。",
      secrets: "陈默隐瞒了自己当晚出现在老街；林晚隐瞒录音里有第二个人的声音。",
      direction: "从各自防守，走到必须共同承担同一个结论。",
      arc: "戒备 → 有限合作 → 信任 → 决裂 → 再选择",
      forbidden: "不可以写成救赎式爱情；陈默不能变成无条件保护她的人。",
    },
  },
  {
    a: "linwan", b: "suwan",
    profile: {
      basis: "雇主与雇员，也是林晚失忆后唯一持续照顾她的人。",
      aToB: "林晚依赖苏婉的日常庇护，同时察觉她在回避某些问题。",
      bToA: "苏婉把林晚当成需要被留在原地的人——留在酒吧，就不会想起来。",
      coreConflict: "苏婉的善意，恰好是林晚恢复记忆的最大阻力。",
      tension: "越亲近越不敢问。",
      power: "苏婉掌握老街的关系网与那晚的部分事实；她用「为你好」行使权力。",
      history: "命案后是苏婉把林晚留下来的，也是她替林晚处理了那件外套。",
      secrets: "苏婉知道老周当晚在场，一直没说。",
      direction: "从庇护，走到不得不承认自己也在隐瞒。",
      arc: "庇护 → 阻挠 → 摊牌 → 有保留的和解",
      forbidden: "苏婉不能沦为反派；她的隐瞒必须始终出于保护。",
    },
  },
];

/** What each episode actually ADVANCES (Episode-level records; the project's
 *  canon above is never edited by these). Keyed by plan position. */
const EPISODE_BEATS = [
  {
    plot: ["第一位客人讲述雨夜", "林晚在自己手机里发现陌生录音"],
    character: { linwan: "从被动听讲述，到第一次意识到自己可能在场。" },
    relationship: [],
    world: ["建立规则：记忆只能被他人的讲述唤起。"],
  },
  {
    plot: ["第二个版本与第一个矛盾", "林晚开始逐条记录差异"],
    character: { linwan: "由记录者转为追查者。", suwan: "第一次出手阻止追问。" },
    relationship: [{ a: "linwan", b: "suwan", start: "被照顾者", event: "苏婉锁上后门、明确劝退", end: "察觉庇护里有隐瞒" }],
    world: ["讲述不可靠：同一个夜晚存在互相矛盾的版本。"],
  },
  {
    plot: ["林晚找到旧案卷宗的线索", "陈默出现在老街"],
    character: { linwan: "第一次主动越界取证。", chenmo: "决定重开一桩没人想碰的旧案。" },
    relationship: [{ a: "linwan", b: "chenmo", start: "利益合作", event: "陈默替林晚承担了擅自取证的风险", end: "有限信任" }],
    world: ["揭示：录音是唯一不会改口的证物。"],
  },
];

const PLAN_EPISODES = [
  {
    title: "沉默酒吧",
    synopsis: "雨夜，一个陌生客人向林晚描述了三年前的一场事故——细节精准得像她亲历过。下班后她发现自己的手机里有一段没听过的录音。",
    purpose: "建立世界、失忆设定与「他人讲述」的驱动装置。",
    hook: "客人临走时说：那天你也在场。",
    endingBeat: "林晚按下播放键，录音里是她自己的声音。",
    duration: "7 分钟",
  },
  {
    title: "两个版本",
    synopsis: "第二位客人讲了同一个雨夜，却与第一版矛盾。林晚开始记录每个版本的差异，苏婉第一次阻止她追问。",
    purpose: "让「讲述」变得不可靠，推动主角从被动接受转向主动记录。",
    hook: "两份讲述里，只有那把伞是一致的。",
    endingBeat: "苏婉锁上后门，说这条街不该再有人问了。",
    duration: "6 分钟",
  },
  {
    title: "旧楼走廊",
    synopsis: "林晚潜入医院旧楼查当年的就诊记录，遇上同样在查旧案的陈默。两人第一次正式交锋。",
    purpose: "引入调查线与陈默，建立双主角张力。",
    hook: "病历上的紧急联系人写着陈默的名字。",
    endingBeat: "走廊尽头的灯灭了，林晚闻到熟悉的雨味。",
    duration: "8 分钟",
  },
  {
    title: "我在场",
    synopsis: "第四段讲述让林晚确认自己当晚在现场。她回到老街，闪回第一次成片式涌回。",
    purpose: "把外部谜题转成内部危机——主角从调查者变成嫌疑人。",
    hook: "闪回里，她手上有血。",
    endingBeat: "林晚在雨里站着，第一次不敢回酒吧。",
    duration: "7 分钟",
  },
  {
    title: "对峙",
    synopsis: "陈默摊牌：他一直知道她在场，并替她隐瞒了三年。林晚必须决定相信谁。",
    purpose: "关系反转，把道德选择推到台前。",
    hook: "「是我让你忘的。」",
    endingBeat: "林晚拿走了那卷原始录音。",
    duration: "7 分钟",
  },
  {
    title: "雨停",
    synopsis: "天台。林晚记起全部真相：她没有动手，但她选择了沉默。她把录音交出去。",
    purpose: "记忆归位与代价——结局不是洗白，是承担。",
    hook: "她终于说出那个名字。",
    endingBeat: "雨停，老街的灯一盏盏灭掉。",
    duration: "8 分钟",
  },
];

const EP01_SCRIPT_V1 = `【EP01 沉默酒吧】

1. 内景 · 酒吧「沉默」· 雨夜
雨声压过爵士乐。林晚擦着杯子，吧台只剩最后一个客人。
客人（不抬头）：三年前也是这样的雨。
林晚：您常来？
客人：来过一次。就一次。

2. 内景 · 酒吧「沉默」· 雨夜 · 稍晚
客人把伞立在脚边，伞骨断了一根。
客人：那天晚上，老街尽头出了事。你应该记得。
林晚手里的杯子停住。
林晚：我不记得。
客人：（终于抬头）那天你也在场。

3. 外景 · 老街 · 雨夜
客人消失在雨里。林晚站在门口，霓虹在积水上碎成两半。

4. 内景 · 出租屋 · 深夜
林晚翻手机。相册最底下有一段三年前的录音，长度 4 分 12 秒。
她按下播放。
录音里（林晚的声音，颤抖）：我看见了……我什么都看见了。`;

const EP01_SCRIPT_V2 = EP01_SCRIPT_V1.replace(
  "客人：（终于抬头）那天你也在场。",
  "客人：（终于抬头，声音很轻）那天你也在场。而且你一直站在那儿，没有走。",
).replace(
  "录音里（林晚的声音，颤抖）：我看见了……我什么都看见了。",
  "录音里（林晚的声音，颤抖）：我看见了……我什么都看见了。\n（录音戛然而止。房间里只剩雨声。）",
);

// ---------------------------------------------------------------------------
// Production bible
// ---------------------------------------------------------------------------

const CHARACTERS = [
  {
    key: "linwan",
    name: "林晚",
    role: "主角",
    profile: {
      identity: "酒吧「沉默」的女招待，命案唯一目击者（她自己并不知道）。",
      desire: "拿回被切断的那一夜——即使代价是把自己交出去。",
      weakness: "无法主动回忆；只能等别人开口，因此永远比对方晚一步。",
      coreConflict: "每恢复一块记忆，她与凶案的距离就近一分：真相与自我保全彻底对立。",
      arc: "被动接受讲述 → 记录矛盾 → 主动追查 → 承认自己在场 → 交出录音",
      appearance: "26 岁，女。1.66m，偏瘦。黑色齐肩发常束成低马尾，左眉尾一道浅疤。眼神安静，很少直视人。",
      costume: "深灰针织衫 + 黑色围裙（工作）；旧军绿防水外套 + 帆布鞋（外出）。",
      personality: "克制、警觉、习惯性观察细节。不解释自己，也不轻易相信解释。",
      visualInstruction: "低饱和冷调，面部保持钠灯暖侧光 + 冷补光的双色对冲；浅景深，避免正面平光。",
    },
    voice: { voiceId: "voice-linwan-base", description: "偏低的女声，气声多，句尾下沉。语速慢，很少提高音量。", performance: { base: "克制 / 内敛" } },
    states: [
      { key: "girl", name: "少女时期", overrides: { appearance: "19 岁。长发未束，无疤，眼神更直接。", costume: "校服外套 + 白 T。" } },
      { key: "adult", name: "成年时期", overrides: {} },
      { key: "dark", name: "黑化时期", overrides: { appearance: "同成年，但眼下浓重青黑，唇色发白。", costume: "全黑，外套领口立起。", visualInstruction: "去掉暖侧光，只留冷顶光；对比度拉高，阴影压死。" } },
      { key: "hurt", name: "受伤", overrides: { appearance: "左额贴纱布，右手掌擦伤。头发散乱。", costume: "湿透的军绿外套。" } },
    ],
  },
  {
    key: "chenmo",
    name: "陈默",
    role: "男主 / 刑警",
    profile: {
      identity: "负责旧案的刑警，也是那一夜的另一个在场者。",
      desire: "还林晚一个清白，同时把自己从案卷里摘出去。",
      weakness: "对林晚的旧情让他一再延后该做的事。",
      coreConflict: "查到底，会证明他最想证伪的那件事。",
      arc: "回避 → 重启旧案 → 替她担责 → 与她对峙 → 接过录音",
      appearance: "34 岁，男。1.82m，肩宽。短发，右手虎口有旧疤。表情克制到近乎冷淡。",
      costume: "深蓝衬衫 + 黑色风衣（便装）；制服（出勤）。",
      personality: "沉默、精确、习惯先听完再说。对林晚有明显的保护性偏差。",
      visualInstruction: "冷调为主，几乎不给暖光；常置于画面边缘或前景虚化处。",
    },
    voice: { voiceId: "voice-chenmo-base", description: "低沉男声，共鸣厚，语速均匀，几乎无起伏。", performance: { base: "冷静 / 压抑" } },
    states: [
      { key: "uniform", name: "制服", overrides: { costume: "深蓝警用制服，肩章齐整。" } },
      { key: "plain", name: "便装", overrides: {} },
    ],
  },
  {
    key: "suwan",
    name: "苏婉",
    role: "配角 / 酒吧老板娘",
    profile: {
      identity: "酒吧老板娘，老街最后的守门人。",
      desire: "让林晚永远留在吧台后面，不要想起来。",
      weakness: "把隐瞒当成保护，因此永远无法被完全信任。",
      coreConflict: "她的善意，正是林晚恢复记忆的最大阻力。",
      arc: "庇护 → 阻挠 → 摊牌 → 有保留的和解",
      appearance: "48 岁，女。烫过的短卷发，右耳一只金色耳钉。手上常年有洗杯子留下的裂口。",
      costume: "酒红色衬衫 + 黑围裙。",
      personality: "热络的外壳，警惕的内里。所有回答都比问题短。",
      visualInstruction: "始终处在吧台暖光里；即使说重话也不给冷光。",
    },
    voice: { voiceId: "voice-suwan-base", description: "中年女声，略沙哑，笑声比语句多。", performance: { base: "熟络 / 回避" } },
    states: [{ key: "daily", name: "日常", overrides: {} }],
  },
  {
    key: "laozhou",
    name: "老周",
    role: "配角 / 老街住户",
    profile: {
      identity: "老街最后的住户，命案当晚的另一个在场者。",
      desire: "在拆迁前，把知道的事交给一个会听的人。",
      weakness: "记性时好时坏，说出来的话没人当证词。",
      coreConflict: "他想说，但没有人相信一个即将搬走的老人。",
      arc: "沉默 → 试探 → 说出关键细节 → 离开老街",
      appearance: "61 岁，男。瘦，背微驼。常年戴一顶褪色棒球帽。",
      costume: "灰蓝夹克，袖口磨白。",
      personality: "话多但绕，真正关键的事只说一遍。",
      visualInstruction: "多用中景与背影；脸部常被帽檐阴影切掉一半。",
    },
    voice: { voiceId: "voice-laozhou-base", description: "苍老男声，带方言尾音，句子拖长。", performance: { base: "絮叨 / 闪躲" } },
    states: [{ key: "daily", name: "日常", overrides: {} }],
  },
];

const LOCATIONS = [
  {
    key: "bar",
    name: "酒吧「沉默」",
    profile: {
      description: "老街尽头的小酒吧。十二个座位，一条实木吧台，墙上贴满褪色的演出海报。窗外是霓虹和雨。",
      visualInstruction: "钠灯暖橘为主光，窗外冷蓝反差；玻璃与积水的反射是主要质感来源。",
    },
    states: [
      { key: "night", name: "夜", overrides: {} },
      { key: "closed", name: "打烊后", overrides: { description: "只剩吧台一盏灯，椅子倒扣在桌上。", visualInstruction: "单点光源，其余压到近乎全黑。" } },
    ],
  },
  {
    key: "hospital",
    name: "医院旧楼走廊",
    profile: {
      description: "市立医院待拆的旧楼三层。绿漆墙裙，声控灯，尽头一扇永远关着的防火门。",
      visualInstruction: "冷绿荧光管为主光，色温压到极冷；走廊纵深透视是核心构图。",
    },
    states: [
      { key: "day", name: "白天", overrides: { visualInstruction: "侧窗自然光介入，冷绿减弱。" } },
      { key: "night", name: "夜晚", overrides: {} },
      { key: "rain", name: "雨夜", overrides: { description: "窗玻璃上全是雨痕，走廊尽头漏水。", visualInstruction: "雨痕投影打在墙面和人脸上。" } },
    ],
  },
  {
    key: "rooftop",
    name: "天台",
    profile: {
      description: "酒吧楼上的天台。水塔、晾衣绳、一圈半人高的护墙。可以看到整条老街。",
      visualInstruction: "开放天光，城市余晖或雨幕；人物多为剪影。",
    },
    states: [
      { key: "dusk", name: "黄昏", overrides: {} },
      { key: "rain", name: "雨夜", overrides: { description: "积水没过脚踝，霓虹在水面碎开。", visualInstruction: "逆光雨丝，人物压成剪影。" } },
    ],
  },
  {
    key: "flat",
    name: "出租屋",
    profile: {
      description: "老式一居室。床垫直接放在地上，窗帘不合缝，桌上摊着录音笔和便签。",
      visualInstruction: "只有一盏台灯，其余靠窗外街灯；大量负空间。",
    },
    states: [{ key: "night", name: "夜", overrides: {} }],
  },
];

// ---------------------------------------------------------------------------
// EP01 scenes + shots
// ---------------------------------------------------------------------------

const SCENES = [
  {
    key: "sc1",
    title: "S01 酒吧·雨夜 — 最后一个客人",
    location: ["bar", "night"],
    characters: [["linwan", "adult"], ["suwan", "daily"]],
    ambience: true,
    shots: [
      {
        title: "雨夜街景 · 酒吧招牌",
        description: "低角度仰拍，「沉默」霓虹招牌在雨中闪烁，雨丝被灯光打亮。街面积水映出破碎的红蓝色。",
        action: "雨持续落下；招牌的一个字母间歇性熄灭。",
        cameraMotion: "固定机位缓慢上摇，从积水倒影摇到招牌本体。",
        dialogue: "",
        shotSize: "远景",
        angle: "低角度仰拍",
        emotion: "疏离 / 压抑",
        duration: 6,
        images: 3,
        videos: 2,
      },
      {
        title: "吧台 · 林晚擦杯子",
        description: "中景，林晚站在吧台内侧擦拭玻璃杯，身后是酒柜暖光。窗外冷蓝雨光落在她左脸。",
        action: "林晚机械地擦杯子，目光落在最后一个客人身上。",
        cameraMotion: "手持中景，极缓慢横移。",
        dialogue: "林晚：您常来？",
        shotSize: "中景",
        angle: "平视",
        emotion: "克制 / 观察",
        duration: 6,
        images: 3,
        videos: 2,
      },
      {
        title: "客人特写 · 断骨的伞",
        description: "特写，客人脚边立着一把伞，一根伞骨折断向外翘起，伞面还在滴水。",
        action: "水珠一滴一滴落在木地板上。",
        cameraMotion: "固定特写，浅景深。",
        dialogue: "客人：三年前也是这样的雨。",
        shotSize: "特写",
        angle: "俯视",
        emotion: "不祥",
        duration: 6,
        images: 2,
        videos: 1,
      },
    ],
  },
  {
    key: "sc2",
    title: "S02 医院旧楼·雨夜 — 走廊尽头",
    location: ["hospital", "rain"],
    characters: [["linwan", "hurt"], ["chenmo", "uniform"]],
    ambience: true,
    shots: [
      {
        title: "走廊纵深 · 声控灯逐段亮起",
        description: "走廊纵深构图，冷绿荧光管逐段亮起又熄灭，尽头的防火门始终暗着。窗上全是雨痕。",
        action: "林晚沿走廊向尽头走去，脚步声触发一段段灯光。",
        cameraMotion: "跟随背影推进，稳定器低速前推。",
        dialogue: "",
        shotSize: "远景",
        angle: "平视",
        emotion: "紧张 / 孤立",
        duration: 10,
        images: 3,
        videos: 1,
      },
      {
        title: "林晚 · 额头纱布特写",
        description: "近景，林晚左额贴着纱布，雨痕的影子横过她的脸。她停下脚步，侧头听。",
        action: "她抬手碰了一下纱布，随即放下。",
        cameraMotion: "固定近景，轻微呼吸感。",
        dialogue: "",
        shotSize: "近景",
        angle: "平视",
        emotion: "痛感 / 警觉",
        duration: 6,
        images: 2,
        videos: 0,
      },
      {
        title: "陈默出现在走廊另一端",
        description: "远景，陈默穿制服站在走廊另一端的逆光里，只剩轮廓。两人之间是整条走廊的距离。",
        action: "陈默没有走近，只是站着。",
        cameraMotion: "固定远景，长焦压缩。",
        dialogue: "陈默：这层楼三年前就封了。",
        shotSize: "远景",
        angle: "平视",
        emotion: "对峙",
        duration: 6,
        images: 1,
        videos: 0,
      },
    ],
  },
  {
    key: "sc3",
    title: "S03 酒吧·打烊后 — 第一次交锋",
    location: ["bar", "closed"],
    characters: [["linwan", "adult"], ["chenmo", "plain"]],
    ambience: true,
    shots: [
      {
        title: "打烊后的吧台 · 单灯",
        description: "全景，椅子倒扣在桌上，只有吧台一盏灯亮着。两个人分坐吧台两端。",
        action: "林晚把一杯水推过去，陈默没有碰。",
        cameraMotion: "固定全景。",
        dialogue: "",
        shotSize: "全景",
        angle: "平视",
        emotion: "克制 / 疏离",
        duration: 6,
        images: 2,
        videos: 0,
      },
      {
        title: "林晚正面近景 · 逼问",
        description: "近景，林晚正对镜头方向，暖光只照亮她半张脸，另一半沉在阴影里。",
        action: "她放下杯子，第一次直视对方。",
        cameraMotion: "固定近景，轻微推近。",
        dialogue: "林晚：你到底是谁？",
        shotSize: "近景",
        angle: "平视",
        emotion: "压抑的爆发",
        duration: 6,
        images: 1,
        videos: 0,
      },
      { title: "陈默反打 · 沉默", description: "过肩反打，陈默的脸大部分在暗处，只有眼睛被光带扫到。", action: "他停顿了很久才开口。", cameraMotion: "过肩固定。", dialogue: "陈默：一个欠你一句真话的人。", shotSize: "近景", angle: "过肩", emotion: "愧疚 / 压抑", duration: 6, images: 0, videos: 0 },
      { title: "空镜 · 窗外雨停", description: "空镜，窗玻璃上的雨痕开始变慢，霓虹的倒影逐渐清晰。", action: "雨渐停。", cameraMotion: "固定空镜。", dialogue: "", shotSize: "特写", angle: "平视", emotion: "留白", duration: 6, images: 0, videos: 0 },
    ],
  },
  {
    key: "sc4",
    title: "S04 天台·雨夜 — 录音",
    location: ["rooftop", "rain"],
    characters: [["linwan", "dark"]],
    ambience: true,
    shots: [
      { title: "天台全景 · 雨中剪影", description: "远景，林晚站在护墙边，整个人压成剪影，背后是老街零星的灯。", action: "她把录音笔举到耳边。", cameraMotion: "固定远景，缓慢升格。", dialogue: "", shotSize: "远景", angle: "平视", emotion: "决断", duration: 10, images: 1, videos: 0 },
      { title: "录音笔特写", description: "特写，录音笔的红色指示灯在雨里一闪一闪，屏幕显示 04:12。", action: "指示灯闪烁；水珠落在屏幕上。", cameraMotion: "固定特写。", dialogue: "", shotSize: "特写", angle: "俯视", emotion: "紧迫", duration: 6, images: 0, videos: 0 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Register one placeholder media version through the SINGLE media write path
 *  (mediaref.addVersion writes straight into the Asset Registry). */
function addMedia(map, key, { origin, version, url, shotId }) {
  const holder = { uploads: map };
  const ref = {
    slot_id: key,
    origin,
    version,
    digest: null,
    url,
    creativeShotId: shotId || null,
    storageState: "local",
  };
  mediaref.addVersion(holder, key, ref);
  return ref;
}

/**
 * Seed the demo project into the live domain documents.
 *
 * Every argument is the app's own live object; this mutates them in place via
 * the domain APIs, exactly as the UI would. Returns the shots draft so the
 * caller can install it on the scriptgen node + ctx.project.draftShots.
 */
export function seedDemoProject({ story, production, scripts, assets, generations, timelines }) {
  // -- Creative Brief: a working draft, committed as ONE formal revision -----
  // (TASK-057) The demo shows the version rule in action: the draft is edited
  // freely, and exactly one explicit commit creates 创意 v1 — the revision the
  // outline below records as its 「Based on」.
  storydoc.setIdea(story, IDEA);
  storydoc.editBriefDraft(story, BRIEF);
  storydoc.commitBrief(story, "manual", "");

  // -- Story: two outline versions (v2 approved) → confirmed plan -----------
  storydoc.applyManualOutline(story, OUTLINE_V1);
  storydoc.applyManualOutline(story, OUTLINE_V2);
  storydoc.approveOutline(story, 2);
  story.plans.push({
    id: mintId("plan"),
    v: 1,
    origin: "proposed",
    instruction: "按已批准大纲 v2 分成 6 集，每集留一个钩子",
    outlineVersionId: story.versions[1].id,
    episodes: PLAN_EPISODES.map((e, i) => ({ ...e, epNumber: i + 1, episodeId: null })),
  });
  story.activePlan = 1;

  // -- Episodes: the plan's confirmation is what mints/links the entities ----
  // (mirrors ctx.story.confirmPlan: one episode entity per planned entry, the
  // pre-existing default episode adopted by the first unlinked entry)
  const plan = story.plans[0];
  const episodeIds = [];
  plan.episodes.forEach((entry, i) => {
    let ep;
    if (i === 0) {
      ep = production.episodes[0];
      ep.title = `EP01 ${entry.title}`;
    } else {
      ep = proddoc.addEpisode(production, `EP${String(i + 1).padStart(2, "0")} ${entry.title}`);
    }
    entry.episodeId = ep.episodeId;
    episodeIds.push(ep.episodeId);
  });
  storydoc.confirmPlan(story, 1);
  proddoc.setActiveEpisode(production, episodeIds[0]);

  // -- Production Bible ------------------------------------------------------
  const charId = {};
  const charStateId = {};
  for (const c of CHARACTERS) {
    const rec = bibledoc.addCharacter(production, c.name);
    charId[c.key] = rec.characterId;
    bibledoc.updateCharacterProfile(production, rec.characterId, c.profile);
    bibledoc.setCharacterVoice(production, rec.characterId, c.voice);
    for (const st of c.states) {
      const s = bibledoc.addCharacterState(production, rec.characterId, st.name);
      charStateId[`${c.key}:${st.key}`] = s.stateId;
      if (Object.keys(st.overrides).length) {
        bibledoc.setCharacterStateOverrides(production, rec.characterId, s.stateId, st.overrides);
      }
    }
  }
  const locId = {};
  const locStateId = {};
  for (const l of LOCATIONS) {
    const rec = bibledoc.addLocation(production, l.name);
    locId[l.key] = rec.locationId;
    bibledoc.updateLocationProfile(production, rec.locationId, l.profile);
    for (const st of l.states) {
      const s = bibledoc.addLocationState(production, rec.locationId, st.name);
      locStateId[`${l.key}:${st.key}`] = s.stateId;
      if (Object.keys(st.overrides).length) {
        bibledoc.setLocationStateOverrides(production, rec.locationId, s.stateId, st.overrides);
      }
    }
  }

  // -- Project-level canon: World Setting + first-class Relationships -------
  // (TASK-057) Both are confirmed as ONE revision each, so every episode below
  // can be stamped against real upstream versions.
  canondoc.updateWorld(production, WORLD);
  const relId = {};
  for (const r of RELATIONSHIPS) {
    const rec = canondoc.addRelationship(production, charId[r.a], charId[r.b]);
    if (!rec) continue;
    relId[`${r.a}:${r.b}`] = rec.relationshipId;
    canondoc.updateRelationship(production, rec.relationshipId, r.profile);
  }
  canondoc.confirmCanon(production, "characters");
  canondoc.confirmCanon(production, "relationships");
  canondoc.confirmCanon(production, "world");

  // -- Episode beats + the upstream stamp -----------------------------------
  // Beats record what each episode ACTUALLY advances; the stamp records which
  // upstream versions it was built on. Only the first three episodes are
  // written — the later ones honestly show "还没有记录", exactly as a real
  // project in progress would.
  EPISODE_BEATS.forEach((b, i) => {
    const epId = episodeIds[i];
    if (!epId) return;
    canondoc.setEpisodeTextBeats(production, epId, "plot", b.plot);
    canondoc.setEpisodeTextBeats(production, epId, "world", b.world);
    for (const [key, beat] of Object.entries(b.character)) {
      canondoc.setEpisodeCharacterBeat(production, epId, charId[key], beat);
    }
    for (const r of b.relationship) {
      const id = relId[`${r.a}:${r.b}`];
      if (id) canondoc.setEpisodeRelationshipBeat(production, epId, id, r);
    }
    canondoc.stampEpisodeUpstream(production, epId, story);
  });

  // -- Bible reference images (real Assets in the registry, referenced by id) --
  // The chosen reference of each entity/state is remembered here so the image
  // generations seeded below can record the references they ACTUALLY used —
  // provenance the Workflow graph then reads back (TASK-054). Nothing is
  // inferred later from "whatever is active now".
  const activeCharRef = {};   // charKey        → assetId
  const charStateRef = {};    // `charKey:state` → assetId
  const activeLocRef = {};    // locKey         → assetId
  let refVersion = 0;
  const addRefImage = (entityId, label, sub, kind) => {
    refVersion += 1;
    const key = `ref-${entityId}-${refVersion}`;
    const ref = addMedia(assets.images, key, {
      origin: "upload",
      version: 1,
      url: placeholderFrame({ label, sub, kind, w: 720, h: 960 }),
      shotId: null,
    });
    bibledoc.addReferenceAsset(production, entityId, ref.assetId);
    return ref.assetId;
  };
  for (const c of CHARACTERS) {
    const id = charId[c.key];
    const ids = [
      addRefImage(id, c.name, "Reference v1 · 正面", "portrait"),
      addRefImage(id, c.name, "Reference v2 · 侧光", "portrait"),
    ];
    // 林晚 is the lead: a third, chosen reference makes "Reference v3" real
    if (c.key === "linwan") ids.push(addRefImage(id, c.name, "Reference v3 · 定妆", "portrait"));
    bibledoc.setActiveReferenceAsset(production, id, ids[ids.length - 1]);
    activeCharRef[c.key] = ids[ids.length - 1];
    // one state carries its own look reference
    const darkState = charStateId[`${c.key}:dark`];
    if (darkState) {
      refVersion += 1;
      const key = `ref-${id}-state-${refVersion}`;
      const r = addMedia(assets.images, key, {
        origin: "upload",
        version: 1,
        url: placeholderFrame({ label: `${c.name} · 黑化`, sub: "State Reference v1", kind: "portrait", w: 720, h: 960 }),
        shotId: null,
      });
      bibledoc.setCharacterStateOverrides(production, id, darkState, {
        referenceAssetIds: [r.assetId],
        activeReferenceAssetId: r.assetId,
      });
      charStateRef[`${c.key}:dark`] = r.assetId;
    }
  }
  for (const l of LOCATIONS) {
    const id = locId[l.key];
    const ids = [
      addRefImage(id, l.name, "Reference v1", "location"),
      addRefImage(id, l.name, "Reference v2", "location"),
    ];
    bibledoc.setActiveReferenceAsset(production, id, ids[1]);
    activeLocRef[l.key] = ids[1];
  }

  // -- Scenes + shots --------------------------------------------------------
  const ep01 = episodeIds[0];
  const draftShots = [];
  let seq = 0;
  // A couple of shots carry a real abandoned attempt before the take that
  // worked — the Workflow graph must keep that history visible (TASK-054 §13).
  let failuresSeeded = 0;
  const genAt = () => at(seq * 7);

  for (const sc of SCENES) {
    const scene = proddoc.addScene(production, ep01, sc.title);
    bibledoc.setSceneLocation(production, scene.sceneId, locId[sc.location[0]], locStateId[`${sc.location[0]}:${sc.location[1]}`]);
    for (const [ck, sk] of sc.characters) {
      bibledoc.addSceneCharacter(production, scene.sceneId, charId[ck], charStateId[`${ck}:${sk}`]);
    }
    // scene ambience: one reusable audio Asset per scene
    if (sc.ambience) {
      const akey = `ambience-${scene.sceneId}`;
      const aref = addMedia(assets.audio, akey, {
        origin: "upload",
        version: 1,
        url: placeholderWave({ label: `ambience:${sc.key}`, tone: "#6fcf9a" }),
        shotId: null,
      });
      proddoc.setSceneAmbience(production, scene.sceneId, aref.assetId);
    }

    for (const s of sc.shots) {
      seq += 1;
      const shotId = mintId("shot");
      const slot = `v1-${seq}`;
      const nn = String(seq).padStart(2, "0");
      draftShots.push({
        sequence: seq,
        title: s.title,
        description: s.description,
        action: s.action,
        cameraMotion: s.cameraMotion,
        dialogue: s.dialogue,
        duration_seconds: s.duration,
        // creative facets the storyboard surfaces as compact metadata
        shotSize: s.shotSize,
        angle: s.angle,
        emotion: s.emotion,
        slot,
        shotId,
      });
      proddoc.assignShot(production, scene.sceneId, shotId);

      // The references this shot's画面 generations actually consumed: the
      // scene's characters (through their state look where one exists) plus the
      // scene's location. Recorded on the Generation, so the Workflow graph can
      // show them without guessing.
      const shotRefs = [];
      for (const [ck, sk] of sc.characters) {
        shotRefs.push(charStateRef[`${ck}:${sk}`] || activeCharRef[ck]);
      }
      if (activeLocRef[sc.location[0]]) shotRefs.push(activeLocRef[sc.location[0]]);
      const refIds = shotRefs.filter(Boolean);

      // image variants
      const imageAssetIds = [];
      for (let v = 1; v <= s.images; v++) {
        const origin = v === 1 ? "upload" : "paid-image";
        const ref = addMedia(assets.images, slot, {
          origin,
          version: v,
          url: placeholderFrame({ label: `EP01 · ${sc.key.toUpperCase()} · SHOT ${nn}`, sub: `${s.shotSize} · ${s.duration}s · Image v${v}`, kind: "frame" }),
          shotId,
        });
        imageAssetIds.push(ref.assetId);
        if (origin === "paid-image") {
          // one shot in the episode shows a real failed attempt BEFORE the take
          // that worked — that history is provenance, not noise (TASK-054 §13)
          if (v === s.images && s.images >= 3 && failuresSeeded < 2) {
            failuresSeeded += 1;
            genlib.startGeneration(generations, {
              type: "image",
              targetId: shotId,
              referenceAssetIds: refIds,
              userInstruction: "再冷一点，别让脸糊掉",
              promptSnapshot: `${s.description}\n${s.shotSize} · ${s.angle}\n【要求】更强的冷侧光`,
              provider: "chatgpt-manual",
              model: null,
              status: failuresSeeded === 2 ? "cancelled" : "failed",
              resultAssetIds: [],
              createdAt: genAt(),
            });
          }
          genlib.startGeneration(generations, {
            type: "image",
            targetId: shotId,
            referenceAssetIds: refIds,
            userInstruction: v === 3 ? "收紧构图，加冷侧光" : "",
            promptSnapshot: `${s.description}\n${s.shotSize} · ${s.angle}`,
            provider: "chatgpt-manual",
            model: null,
            status: "success",
            resultAssetIds: [ref.assetId],
            createdAt: genAt(),
          });
        }
      }
      const lastImageAssetId = imageAssetIds[imageAssetIds.length - 1] || null;
      // Video variants, each from the image it was ACTUALLY built on. A second
      // take is normally a retry on the newer image, so v1 keeps the older
      // source — the graph must be able to show that divergence honestly rather
      // than re-pointing every video at whatever image is active now.
      for (let v = 1; v <= s.videos; v++) {
        const src = v < s.videos && imageAssetIds.length > 1
          ? imageAssetIds[imageAssetIds.length - 2]
          : lastImageAssetId;
        const vref = addMedia(assets.videos, slot, {
          origin: "paid-video",
          version: v,
          url: placeholderFrame({ label: `EP01 · ${sc.key.toUpperCase()} · SHOT ${nn}`, sub: `Video v${v} · ${s.duration}s`, kind: "video" }),
          shotId,
        });
        genlib.startGeneration(generations, {
          type: "video",
          targetId: shotId,
          inputAssetIds: src ? [src] : [],
          userInstruction: "",
          promptSnapshot: `${s.action}\n运镜：${s.cameraMotion}\n时长：${s.duration}s`,
          provider: "gemini-manual",
          model: null,
          status: "success",
          resultAssetIds: [vref.assetId],
          createdAt: genAt(),
        });
      }
      // the recorded first frame — only where a video actually derives from one
      if (s.videos && lastImageAssetId) {
        const cur = mediaref.currentRef(assets.images, slot);
        if (cur) {
          assets.firstFrames[slot] = { ...cur, slot_id: slot, creativeShotId: shotId };
        }
      }
      // dialogue take where the shot has a line
      if (s.dialogue) {
        const vkey = `voice-${slot}`;
        const aref = addMedia(assets.audio, vkey, {
          origin: "tts",
          version: 1,
          url: placeholderWave({ label: `voice:${slot}`, tone: "#f0b23f" }),
          shotId,
        });
        genlib.startGeneration(generations, {
          type: "audio",
          targetId: shotId,
          userInstruction: "",
          promptSnapshot: s.dialogue,
          provider: "piper-local",
          model: null,
          status: "success",
          resultAssetIds: [aref.assetId],
          createdAt: genAt(),
        });
      }
    }
  }

  // one generation still in flight, so the "generating" state is visible
  genlib.startGeneration(generations, {
    type: "image",
    targetId: draftShots[6] ? draftShots[6].shotId : null,
    userInstruction: "换一个更冷的色温",
    promptSnapshot: "打烊后的吧台 · 单灯",
    provider: "chatgpt-manual",
    status: "generating",
    createdAt: at(120),
  });

  // -- Assets that genuinely need a human decision (Asset Inbox, TASK-051A) --
  // Real states the registry can legitimately be in — not synthetic filler:
  //  · two externally imported files with no recorded shot identity and no
  //    reference anywhere (tier C: no owner, no evidence);
  //  · one upload that landed on a REAL shot's slot without recording the shot
  //    id, so the slot itself is the evidence (tier B, high confidence);
  //  · one paid result the M4d bridge could not map to a creative shot.
  addMedia(assets.images, "inbox-import-1", {
    origin: "upload",
    version: 1,
    url: placeholderFrame({ label: "外部导入", sub: "未记录归属 · 01", kind: "frame" }),
    shotId: null,
  });
  addMedia(assets.images, "inbox-import-2", {
    origin: "upload",
    version: 1,
    url: placeholderFrame({ label: "外部导入", sub: "未记录归属 · 02", kind: "portrait", w: 720, h: 960 }),
    shotId: null,
  });
  if (draftShots[8]) {
    // shot 09 has no images of its own, so this upload is that slot's FIRST
    // version — landed on a real shot's slot but with no shot id recorded,
    // which is exactly the evidence tier B proposes from
    addMedia(assets.images, draftShots[8].slot, {
      origin: "upload",
      version: 1,
      url: placeholderFrame({ label: "手工上传", sub: "槽位已知 · 身份未记录", kind: "frame" }),
      shotId: null,
    });
  }
  assetlib.recordUnresolvedPaid(assets, {
    taskId: "task-9f21c0",
    serverShotId: "shot-004",
    creativeShotId: null,
    reason: "锁定计划已重锁，服务端 shot_id 无法映射到当前草稿的创作镜头",
  });

  // -- Episode BGM -----------------------------------------------------------
  const bgm = addMedia(assets.audio, "music-ep01-theme", {
    origin: "upload",
    version: 1,
    url: placeholderWave({ label: "bgm:ep01", tone: "#b98ce0" }),
    shotId: null,
  });
  proddoc.setEpisodeBgm(production, ep01, bgm.assetId);

  // -- EP01 timeline + one rendered cut -------------------------------------
  // A real cut assembled from the media that exists: every shot that HAS a
  // video, its dialogue take where there is one, each scene's ambience, and the
  // episode BGM. The render Generation records exactly those clip Assets as its
  // inputs, which is what gives the Final a readable lineage (TASK-054 §15)
  // instead of a Final that appears out of nowhere.
  const tl = timelinedoc.timelineFor(timelines, ep01);
  const renderInputs = [];
  let cursor = 0;
  for (const s of draftShots) {
    const vid = mediaref.currentRef(assets.videos, s.slot);
    if (!vid) continue;
    const dur = s.duration_seconds === 10 ? 10 : 6;
    timelinedoc.addClip(tl, { trackType: "video", assetId: vid.assetId, shotId: s.shotId, startTime: cursor, duration: dur });
    renderInputs.push(vid.assetId);
    const voice = mediaref.currentRef(assets.audio, `voice-${s.slot}`);
    if (voice) {
      timelinedoc.addClip(tl, { trackType: "dialogue", assetId: voice.assetId, shotId: s.shotId, startTime: cursor, duration: dur });
      renderInputs.push(voice.assetId);
    }
    cursor += dur;
  }
  for (const scene of proddoc.findEpisode(production, ep01).scenes) {
    if (!scene.ambienceAssetId) continue;
    timelinedoc.addClip(tl, { trackType: "ambience", assetId: scene.ambienceAssetId, startTime: 0, duration: cursor || 6 });
    renderInputs.push(scene.ambienceAssetId);
  }
  timelinedoc.addClip(tl, { trackType: "bgm", assetId: bgm.assetId, startTime: 0, duration: cursor || 6 });
  renderInputs.push(bgm.assetId);

  if (renderInputs.length) {
    const final = assetlib.addFinal(assets, placeholderFrame({
      label: "EP01 迷雾入城", sub: "Final v1 · 粗剪", kind: "video",
    }));
    const renderGen = genlib.startGeneration(generations, {
      type: "render",
      targetId: null,
      inputAssetIds: [...new Set(renderInputs)],
      promptSnapshot: null, // a render has SETTINGS, not a prompt — never invent one
      provider: "ffmpeg-local",
      model: null,
      parameters: {
        providerMode: "local",
        episodeId: ep01,
        settings: { ...tl.settings },
        clips: tl.clips.map((c) => ({ clipId: c.clipId, trackType: c.trackType, assetId: c.assetId, startTime: c.startTime })),
      },
      status: "success",
      resultAssetIds: final ? [final.assetId] : [],
      createdAt: at(150),
    });
    void renderGen;
  }

  // -- EP01 script: two versions, v2 active ---------------------------------
  const doc = scriptdoc.createDoc();
  scriptdoc.setBrief(doc, IDEA);
  scriptdoc.editText(doc, EP01_SCRIPT_V1);
  doc.versions.push({ id: mintId("sv"), v: 1, content: EP01_SCRIPT_V1, origin: "generated", instruction: "", basedOn: null, status: "done" });
  doc.versions.push({ id: mintId("sv"), v: 2, content: EP01_SCRIPT_V2, origin: "revision", instruction: "客人那句台词再压一点，结尾留白", basedOn: 1, status: "done" });
  doc.active = 2;
  doc.workingText = null;
  scripts[ep01] = doc;

  return { draftShots, activeEpisodeId: ep01, timelines };
}
