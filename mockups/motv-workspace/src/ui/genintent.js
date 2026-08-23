// 「这次生成是从哪条 Prompt 出去的」——生成意图的唯一存放处（TASK-103 批次 D）。
//
// 手工生成路线是：复制 Prompt → 到外部模型跑 → 把结果导回来。中间那一步发生在
// 本应用之外，所以「导进来的这个文件对应刚才那条 Prompt」只能靠一个**暂存的
// 意图**接住 —— 它就是那条媒体的 provenance。
//
// 之前它存成 `ui.genIntent[kind]`，**一种媒体只有一格**。三个消费方都会检查
// `intent.shotId === 当前镜头`，所以意图不会被张冠李戴 —— 但会被**静默覆盖**：
// 给 A 镜复制了图片 Prompt，切到 B 镜再复制一次，回到 A 镜导入，A 的意图已经
// 不在了，于是那张图落地时溯源为空。界面不会报错，创作者也不会发现。
//
// 修法是把镜头放进键里。这不只是加个后缀：`(kind, shotId)` 才是这条意图真正的
// 身份，而键一旦说出了身份，读的时候就不必再拿 `shotId` 去比对一遍 —— 那种
// 「键不完整、靠调用点补一个判断」的形状，正是 TASK-087 §7 那六条缺陷的共同
// 长相（不变量只覆盖一半，另一半在相邻那一层）。
//
// 存放位置不变：`ui.*` 是**临时界面状态**（系统合同 §7.1 规定 3），不落盘。
// 一次意图只服务一次导入，导完即弃。

/** 一条意图的身份：哪种媒体 + 哪一镜。 */
export function intentKey(kind, shotId) {
  if (typeof kind !== "string" || !kind) return null;
  if (typeof shotId !== "string" || !shotId) return null;
  return `${kind}:${shotId}`;
}

/** 记下一条意图。没有合法身份时**什么都不做** —— 存进一个 `null` 键会让它变成
 *  一条谁都能捡走的孤儿意图，那比丢掉更糟。 */
export function setIntent(ui, kind, shotId, value) {
  const key = intentKey(kind, shotId);
  if (!ui || !key) return null;
  ui.genIntent = ui.genIntent || {};
  ui.genIntent[key] = value;
  return value;
}

/** 取这一镜这一类的意图，没有就是 null。 */
export function getIntent(ui, kind, shotId) {
  const key = intentKey(kind, shotId);
  if (!ui || !key || !ui.genIntent) return null;
  return ui.genIntent[key] || null;
}

/**
 * 用掉一条意图 —— 但**只在它还是同一条**的时候。
 *
 * 导入是异步的：上传在飞的时候创作者可能又复制了一次 Prompt，那条**新**意图属于
 * 下一次导入。按身份删会把它一起删掉，所以这里比的是对象本身。
 */
export function consumeIntent(ui, kind, shotId, intent) {
  const key = intentKey(kind, shotId);
  if (!ui || !key || !ui.genIntent || !intent) return false;
  if (ui.genIntent[key] !== intent) return false;
  delete ui.genIntent[key];
  return true;
}
