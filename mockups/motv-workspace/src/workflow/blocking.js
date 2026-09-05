// 3D 白膜的数据模型（TASK-123 / ADR-0094 决策 3）。
//
// 产品负责人 2026-08-30：「帮我在剧集制作里面加入 3D 导演台让我能做白膜视频」。
//
// 一镜一份 blocking：**谁站在哪、走到哪，机位从哪拍、推到哪，多长**。中间线性插值。
// 先把这几件说清楚 —— 白膜要回答的就是走位与机位，不是长相。
//
// 纯数据 + 纯函数：没有 DOM、没有 WebGL、没有时钟（`at` 一律由调用方传入），
// 所以它能在 node 里被直接测，渲染器只是它的一个读者。

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x) => (typeof x === "string" ? x : "");
const num = (x, lo, hi, dflt) => {
  const v = typeof x === "number" && Number.isFinite(x) ? x : Number(x);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

/** 场地：一个矩形地面，单位是米。够放下一场戏，不做无限世界。 */
export const STAGE = { min: 2, max: 80, dflt: 12 };

/** 常用镜头焦距（毫米，35mm 等效）—— 导演说的是「广角/标准/长焦」，不是 fov 弧度。 */
export const LENSES = [18, 24, 35, 50, 85, 135];

/** 一个演员方块的默认身高（米）。 */
const ACTOR_H = 1.7;

let seq = 0;
function mintId(prefix) {
  seq += 1;
  return `${prefix}-${seq.toString(36)}`;
}

/* --- 一个点（俯视图上的站位）------------------------------------------------ */

function point(p, dflt = { x: 0, z: 0 }) {
  const src = isObj(p) ? p : {};
  return {
    x: num(src.x, -STAGE.max, STAGE.max, dflt.x),
    z: num(src.z, -STAGE.max, STAGE.max, dflt.z),
  };
}

/* --- 演员 / 道具 ------------------------------------------------------------ */

function sanitizeActor(a, i) {
  const src = isObj(a) ? a : {};
  return {
    id: str(src.id) || mintId("act"),
    name: str(src.name).slice(0, 40) || `演员 ${i + 1}`,
    height: num(src.height, 0.5, 3, ACTOR_H),
    // 起止站位：中间线性插值。**这就是「走位」**。
    from: point(src.from, { x: -2 + i, z: 0 }),
    to: point(src.to, point(src.from, { x: -2 + i, z: 0 })),
    // 朝向（度，0 = 面朝 +Z）。白膜里方向也是信息：背对镜头和面对镜头不是一回事。
    facing: num(src.facing, -360, 360, 0),
    hidden: isObj(src.hidden) && str(src.hidden.at) ? { at: str(src.hidden.at) } : null,
  };
}

function sanitizeProp(p, i) {
  const src = isObj(p) ? p : {};
  return {
    id: str(src.id) || mintId("prop"),
    name: str(src.name).slice(0, 40) || `道具 ${i + 1}`,
    at: point(src.at, { x: 0, z: 2 }),
    w: num(src.w, 0.1, 40, 1),
    d: num(src.d, 0.1, 40, 1),
    h: num(src.h, 0.05, 20, 0.8),
    hidden: isObj(src.hidden) && str(src.hidden.at) ? { at: str(src.hidden.at) } : null,
  };
}

/* --- 机位 ------------------------------------------------------------------- */

function sanitizeCam(c, dflt) {
  const src = isObj(c) ? c : {};
  return {
    at: point(src.at, dflt.at),
    // 相机高度（米）：平视 1.6、俯拍 4、贴地 0.3 —— 这一个数就能说清很多机位
    y: num(src.y, 0.05, 30, dflt.y),
    // 看向哪儿（地面上的一个点）。让相机「看着」而不是「转多少度」，是导演的说法。
    look: point(src.look, dflt.look),
    lens: LENSES.includes(num(src.lens, 8, 300, 0)) ? num(src.lens, 8, 300, 35) : num(src.lens, 8, 300, 35),
  };
}

/* --- 一镜的 blocking -------------------------------------------------------- */

export function createBlocking(saved) {
  const src = isObj(saved) ? saved : {};
  return {
    stage: num(src.stage, STAGE.min, STAGE.max, STAGE.dflt),
    // 时长（秒）：白膜的长度就是这一镜打算占的时间
    duration: num(src.duration, 0.5, 120, 4),
    actors: (Array.isArray(src.actors) ? src.actors : []).map(sanitizeActor),
    props: (Array.isArray(src.props) ? src.props : []).map(sanitizeProp),
    camera: {
      from: sanitizeCam(isObj(src.camera) ? src.camera.from : null, {
        at: { x: 0, z: -6 },
        y: 1.6,
        look: { x: 0, z: 0 },
        lens: 35,
      }),
      to: sanitizeCam(isObj(src.camera) ? src.camera.to : null, {
        at: { x: 0, z: -6 },
        y: 1.6,
        look: { x: 0, z: 0 },
        lens: 35,
      }),
    },
    // 最近一次录出来的白膜（assetId）。**不存字节**：字节归资产登记（决策 4）。
    takes: (Array.isArray(src.takes) ? src.takes : [])
      .filter(isObj)
      .map((t) => ({
        assetId: str(t.assetId),
        at: str(t.at),
        seconds: num(t.seconds, 0, 600, 0),
      }))
      .filter((t) => t.assetId),
  };
}

export function serializeBlocking(b) {
  return {
    stage: b.stage,
    duration: b.duration,
    actors: b.actors,
    props: b.props,
    camera: b.camera,
    takes: b.takes,
  };
}

/* --- 编辑（与创作者点按钮走同一组函数，ADR-0094 决策 5）--------------------- */

export function addActor(b, name, at) {
  const actor = sanitizeActor({ name, id: "" }, b.actors.length);
  actor.hidden = null;
  void at;
  b.actors.push(actor);
  return actor;
}

export function editActor(b, id, patch) {
  const a = b.actors.find((x) => x.id === id);
  if (!a || !isObj(patch)) return false;
  if (typeof patch.name === "string") a.name = patch.name.slice(0, 40);
  if (patch.height !== undefined) a.height = num(patch.height, 0.5, 3, a.height);
  if (patch.facing !== undefined) a.facing = num(patch.facing, -360, 360, a.facing);
  if (isObj(patch.from)) a.from = point(patch.from, a.from);
  if (isObj(patch.to)) a.to = point(patch.to, a.to);
  return true;
}

/** 删演员是软删除 —— 摆了半天的走位不该一点就没（第 13 条）。 */
export function hideActor(b, id, at) {
  const a = b.actors.find((x) => x.id === id);
  if (!a || a.hidden) return false;
  a.hidden = { at: str(at) };
  return true;
}

export function restoreActor(b, id) {
  const a = b.actors.find((x) => x.id === id);
  if (!a || !a.hidden) return false;
  a.hidden = null;
  return true;
}

export const visibleActors = (b) => b.actors.filter((a) => !a.hidden);
export const visibleProps = (b) => b.props.filter((p) => !p.hidden);

export function addProp(b, name) {
  const p = sanitizeProp({ name }, b.props.length);
  p.hidden = null;
  b.props.push(p);
  return p;
}

export function hideProp(b, id, at) {
  const p = b.props.find((x) => x.id === id);
  if (!p || p.hidden) return false;
  p.hidden = { at: str(at) };
  return true;
}

export function editProp(b, id, patch) {
  const p = b.props.find((x) => x.id === id);
  if (!p || !isObj(patch)) return false;
  if (typeof patch.name === "string") p.name = patch.name.slice(0, 40);
  if (isObj(patch.at)) p.at = point(patch.at, p.at);
  for (const k of ["w", "d", "h"]) {
    if (patch[k] !== undefined) p[k] = num(patch[k], 0.05, 40, p[k]);
  }
  return true;
}

/** 改机位。`which` 是 "from"（起幅）或 "to"（落幅）；`both` 时两个一起改。 */
export function setCamera(b, which, patch) {
  const targets = which === "both" ? ["from", "to"] : [which];
  if (!targets.every((w) => w === "from" || w === "to")) return false;
  if (!isObj(patch)) return false;
  for (const w of targets) {
    const c = b.camera[w];
    if (isObj(patch.at)) c.at = point(patch.at, c.at);
    if (patch.y !== undefined) c.y = num(patch.y, 0.05, 30, c.y);
    if (isObj(patch.look)) c.look = point(patch.look, c.look);
    if (patch.lens !== undefined) c.lens = num(patch.lens, 8, 300, c.lens);
  }
  return true;
}

export function setDuration(b, seconds) {
  const v = num(seconds, 0.5, 120, null);
  if (v === null) return false;
  b.duration = v;
  return true;
}

export function setStage(b, meters) {
  const v = num(meters, STAGE.min, STAGE.max, null);
  if (v === null) return false;
  b.stage = v;
  return true;
}

/* --- 采样：把 t∈[0,1] 变成这一刻的画面 -------------------------------------- */

const lerp = (a, z, t) => a + (z - a) * t;
const lerpP = (a, z, t) => ({ x: lerp(a.x, z.x, t), z: lerp(a.z, z.z, t) });

/**
 * 这一刻的场面。渲染器与录制器读的都是它 —— **一份采样，两个读者**，
 * 所以「预览里看到的」和「录出来的」不可能是两回事。
 */
export function sampleAt(b, t) {
  const k = Math.min(1, Math.max(0, typeof t === "number" && Number.isFinite(t) ? t : 0));
  return {
    stage: b.stage,
    camera: {
      at: lerpP(b.camera.from.at, b.camera.to.at, k),
      y: lerp(b.camera.from.y, b.camera.to.y, k),
      look: lerpP(b.camera.from.look, b.camera.to.look, k),
      lens: lerp(b.camera.from.lens, b.camera.to.lens, k),
    },
    actors: visibleActors(b).map((a) => ({
      id: a.id,
      name: a.name,
      height: a.height,
      facing: a.facing,
      at: lerpP(a.from, a.to, k),
      // 走了多远 —— 渲染时用它决定要不要画那条走位线
      moves: a.from.x !== a.to.x || a.from.z !== a.to.z,
      from: a.from,
      to: a.to,
    })),
    props: visibleProps(b).map((p) => ({ ...p })),
  };
}

/** 焦距（毫米）→ 垂直 fov（弧度）。35mm 画幅高 24mm。 */
export function fovOf(lens, aspect = 16 / 9) {
  const mm = num(lens, 8, 300, 35);
  const horiz = 2 * Math.atan(36 / (2 * mm));
  return 2 * Math.atan(Math.tan(horiz / 2) / aspect);
}

/** 这一镜的白膜说清楚了没有 —— **不猜**，缺什么就说什么。 */
export function readiness(b) {
  const gaps = [];
  if (!visibleActors(b).length && !visibleProps(b).length) {
    gaps.push("场上还什么都没有 —— 至少放一个演员或道具");
  }
  const c = b.camera;
  const still =
    c.from.at.x === c.to.at.x &&
    c.from.at.z === c.to.at.z &&
    c.from.y === c.to.y &&
    c.from.lens === c.to.lens &&
    c.from.look.x === c.to.look.x &&
    c.from.look.z === c.to.look.z;
  const anyoneMoves = visibleActors(b).some((a) => a.from.x !== a.to.x || a.from.z !== a.to.z);
  return {
    canRecord: gaps.length === 0,
    gaps,
    // 全程静止不是错，但要说出来：录出来会是一张不动的图
    still: still && !anyoneMoves,
  };
}
