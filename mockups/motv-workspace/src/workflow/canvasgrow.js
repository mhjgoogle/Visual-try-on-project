// 画布上那两条「长出新东西」的能力 (TASK-093 §2.4 / TASK-097 批次 3)。
//
//   从图创建角色   ADR-0074 —— 只登记这张图给出的东西，不臆造档案
//   运镜预设       ADR-0075 —— 文本模板，落到镜头上就与预设脱钩
//
// 093 §2.4 列了 LibTV 的四样，本链只做这两样：它们**用户价值高、范围窄**，
// 而角色原型库与特效风格库需要的是使用数据与多图 provider（各自 ADR 里写明了）。
//
// 两条都是**纯判定 + 纯提案**：这里算出「能不能做、做出来是什么」，
// 实际写入由既有写路径执行（`bibledoc.addCharacter` / 分镜草稿的既有保存）。
// 于是没有第二条写路径，也不需要新的登记表。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x !== "";
const trimmed = (x) => (nonEmpty(x) ? x.trim() : "");

/* ========================================================================== */
/* ADR-0074 从图创建角色                                                       */
/* ========================================================================== */

/**
 * 能不能从这个节点创建角色，以及创建出来**恰好是什么**。
 *
 * `characters` 是 `prod.characters`（现有角色，用于重名判定）。
 *
 * 返回的 `proposal` 只有两样东西：**身份 + 一条参考绑定**（ADR-0074 决策 1）。
 * 外貌 / 服装 / 气质 / 声音 / 画面指令**一律留空** —— 这张图没告诉我们任何一项，
 * 填「一位女性」就是发明设定（M8 提案卡纪律）。创建之后角色卡会如实显示缺什么，
 * 那是真话，而且是可操作的下一步。
 */
export function characterFromImage({ node, name, characters } = {}) {
  const blockers = [];
  const n = isObj(node) ? node : null;
  const given = trimmed(name);

  // 决策 4：只从**已登记**的图创建 —— 没有 assetId 的绑定立刻是悬空引用
  if (!n || (n.type !== "image" && n.type !== "storyboard" && n.type !== "reference")) {
    blockers.push("只能从一张图创建角色");
  } else if (!nonEmpty(n.assetId)) {
    blockers.push("这张图还没有登记的资产 id —— 先上传或生成出来，再从它创建角色");
  }

  // 决策 2：名字必须由人给，不从文件名猜
  if (!given) {
    blockers.push(
      "请先给这个角色起名 —— 不从文件名猜：`IMG_2481` 这样的名字永远匹配不到任何"
      + "镜头的画面描述，而创作者会以为建好了",
    );
  }

  // 决策 5：重名不合并、不悄悄建第二个
  const clash = (Array.isArray(characters) ? characters : []).find(
    (c) => isObj(c) && trimmed(c.name) && trimmed(c.name) === given,
  );
  if (clash) {
    blockers.push(
      `已经有一个叫「${given}」的角色了 —— 不合并也不建第二个：`
      + "合并会把两个人的档案搅在一起，建第二个会让实体识别在两者之间随机命中。"
      + "把这张图绑到那个角色上，或者换个名字。",
    );
  }

  if (blockers.length) return { ok: false, blockers, proposal: null };
  return {
    ok: true,
    blockers: [],
    proposal: {
      name: given,
      // 决策 3：参考图是**引用**，不复制 —— 不产生任何新的媒体字节
      referenceAssetId: n.assetId,
      // 如实记下这条绑定是从哪儿来的，供溯源阅读
      fromNodeId: nonEmpty(n.id) ? n.id : null,
      // 明确列出**没有**填的字段，让调用方（和读代码的人）看得见这份留空是故意的
      leftBlank: ["appearance", "costume", "personality", "visualInstruction", "voice"],
    },
  };
}

/* ========================================================================== */
/* ADR-0075 运镜预设                                                           */
/* ========================================================================== */

/**
 * 内置运镜预设（ADR-0075 决策 2：不新增登记表；决策 5：文本必须自足）。
 *
 * 实测依据：真实项目 60 条镜头 `cameraMotion` 填充率 **0/60**。
 * 逐镜从零想一句运镜描述的成本，就是一次都不写。
 *
 * 每一条都是**可以直接送给外部工具**的话 —— 不含只有本项目才知道的名字或 id。
 */
export const CAMERA_PRESETS = [
  { id: "arc-left", label: "左弧滑行", text: "镜头从右向左缓慢弧形滑过主体，始终保持主体在画面中心" },
  { id: "orbit-360", label: "360 旋转展示", text: "镜头绕主体匀速环绕一周，主体保持在画面中心，背景连续变化" },
  { id: "push-in-eye", label: "瞳孔拉近", text: "镜头从中景缓慢推进到眼部特写，焦点始终在眼睛上" },
  { id: "crane-down", label: "机械臂下降", text: "镜头从高处俯视缓慢下降到与主体平视，同时略微向前推进" },
  { id: "handheld-follow", label: "手持跟随", text: "手持镜头在主体侧后方跟随行走，轻微晃动，保持主体半身在画面内" },
  { id: "static-lock", label: "固定机位", text: "镜头完全静止，不推不摇；画面内的运动全部来自被摄主体" },
  { id: "pull-back-reveal", label: "后拉揭示", text: "镜头从主体特写匀速后拉，逐步露出主体所处的环境全貌" },
  { id: "tilt-up-reveal", label: "上摇揭示", text: "镜头由下向上摇起，从局部细节摇到主体全身或环境上方" },
];

const PRESET_BY_ID = new Map(CAMERA_PRESETS.map((p) => [p.id, p]));

export const cameraPreset = (id) => PRESET_BY_ID.get(id) || null;

/**
 * 把一个预设应用到镜头的 `cameraMotion` 上。
 *
 * ADR-0075 决策 1：**复制文本，不留引用** —— 镜头上不存预设 id，应用之后这一镜与
 * 那个预设再无关系。于是「预设改了，已经用过它的镜头怎么办」这个最容易做错的问题
 * 被设计成**不会发生**：什么都不会发生，而那正是想要的语义。
 *
 * ADR-0075 决策 4：**已有内容默认追加而不是替换**。替换是一次覆盖用户内容的写入
 * （AGENTS.md 第 13 条）；追加是可逆的（删掉那一行就回去了）。
 * 要替换必须由调用方显式说 `mode: "replace"`。
 */
export function applyCameraPreset(current, presetId, { mode = "append" } = {}) {
  const preset = cameraPreset(presetId);
  if (!preset) return { ok: false, text: null, reason: `没有这个运镜预设：${presetId}` };
  const existing = typeof current === "string" ? current.trim() : "";
  if (!existing) return { ok: true, text: preset.text, replaced: false, appended: false };
  if (mode === "replace") {
    return { ok: true, text: preset.text, replaced: true, appended: false };
  }
  // 已经写着同一段话时不重复追加 —— 点两次不该得到两行一样的字
  if (existing.includes(preset.text)) {
    return { ok: true, text: existing, replaced: false, appended: false };
  }
  return { ok: true, text: `${existing}\n${preset.text}`, replaced: false, appended: true };
}

/** 预设菜单模型：告诉界面这一镜现在是空的还是已有内容，因为那决定了
 *  点下去会发生什么（新写 / 追加），而创作者有权先知道。 */
export function cameraPresetMenu(current) {
  const existing = typeof current === "string" ? current.trim() : "";
  return {
    hasExisting: !!existing,
    note: existing
      ? "这一镜已经写了运镜 —— 选一个预设会**追加**在后面，不会替换掉你写的话"
      : "这一镜还没有运镜 —— 选一个预设直接填进去，之后仍可自由编辑",
    presets: CAMERA_PRESETS.map((p) => ({ id: p.id, label: p.label, text: p.text })),
  };
}
