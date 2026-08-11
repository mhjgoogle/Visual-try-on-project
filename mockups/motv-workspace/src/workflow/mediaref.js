// MediaRef — 画布层统一媒体引用（TASK-048；原型内部约定，非核心 schema）。
//
//   MediaRef { slot_id, origin: 'upload'|'paid-image'|'paid-video'|'adopted'|'tts',
//              version, digest, url }
//
// digest 为文件内容的 sha256（hex），与 lock-draft-plan 的首帧绑定机制同源；
// 未知时为 null，可用 sha256OfUrl 补算。url 是派生便利字段（当前后端的
// /api/uploads/ 地址），解析/展示都走它。
//
// node.uploads[slot] 槽位值有两种形态：
//   - 旧格式：纯 url 字符串（“重传即替换”时代的产物）→ 读入时视为 v1；
//   - 新格式：{ current: <version>, history: [MediaRef...] } —— 同一槽位的
//     多批次媒体全部保留，可回切当前版本，绝不静默覆盖。
// 本模块是所有读写槽位代码的唯一入口，读侧对两种形态透明。

import { mintId } from "./identity.js";
import { ensureDeclaration } from "./assetreg.js";

/** 安全写入一个可能名为 `__proto__` 的槽位键：普通对象上 `obj["__proto__"]=x`
 *  会改写原型（污染），而 slot 是外部/可损坏数据里的任意字符串。以 own 属性
 *  写入，杜绝原型污染，同时让映射保持普通对象（可 JSON 序列化、可 deepEqual）。 */
export function putKey(obj, key, val) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = val;
  }
  return obj;
}

/** 旧格式字符串 → 规范化槽位条目（自动迁移为 v1，origin 按上传保守标注）。 */
export function normalizeEntry(slotId, val) {
  if (val && typeof val === "object" && Array.isArray(val.history)) return val;
  if (typeof val === "string" && val) {
    return {
      current: 1,
      history: [
        { slot_id: slotId, origin: "upload", version: 1, digest: null, url: val },
      ],
    };
  }
  return null;
}

/** 就地把一个 uploads map 的所有旧格式条目迁移为新格式（幂等）。 */
export function migrateUploads(uploads) {
  if (!uploads) return uploads;
  for (const k of Object.keys(uploads)) {
    const norm = normalizeEntry(k, uploads[k]);
    if (norm) putKey(uploads, k, norm);
    else delete uploads[k];
  }
  return uploads;
}

/** 槽位的规范化条目（{current, history}），无媒体时 null。只读，不改原值。 */
export function slotEntry(uploads, k) {
  if (!uploads || !k) return null;
  return normalizeEntry(k, uploads[k]);
}

/** 槽位当前版本的 MediaRef，无媒体时 null。 */
export function currentRef(uploads, k) {
  const e = slotEntry(uploads, k);
  if (!e) return null;
  return e.history.find((r) => r.version === e.current) || e.history[e.history.length - 1] || null;
}

/** 槽位当前版本的 url（渲染/合成用），无媒体时空串。 */
export function slotUrl(uploads, k) {
  const r = currentRef(uploads, k);
  return r ? r.url : "";
}

/** 槽位当前版本的服务端文件名主干（不含扩展名），供 compose/tts fit 等
 *  按文件解析的后端路径使用：/api/uploads/<p>/<stem>.<ext> → <stem>。 */
export function slotStem(uploads, k) {
  const r = currentRef(uploads, k);
  if (!r || !r.url) return "";
  const base = r.url.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 追加一个新版本并把它设为当前（唯一的创作媒体写入口 — M3 起 node.uploads
 *  即项目资产注册表的别名视图，写这里就是写注册表）。每个耐久媒体版本是一个
 *  Asset：缺 assetId 的新记录在此铸造一次，此后只携带、永不重推。 */
export function addVersion(node, k, ref) {
  if (typeof ref.assetId !== "string" || !ref.assetId) ref.assetId = mintId("asset");
  // M5 storage lifecycle: a freshly written version's bytes are present locally.
  if (typeof ref.storageState !== "string" || !ref.storageState) ref.storageState = "local";
  // CP2/ADR-0055: every registered Asset carries a declaration. A caller that
  // declared one (assetreg.declare) keeps it verbatim; one that did not gets an
  // honestly UNCLASSIFIED record — so 「文件落盘却没有资产记录」 cannot happen
  // through any write path, present or future.
  ensureDeclaration(ref);
  node.uploads = node.uploads || {};
  const e = normalizeEntry(k, node.uploads[k]) || { current: 0, history: [] };
  // 同版本号重复追加（例如重放）时以新记录为准，但绝不丢历史其它版本
  e.history = e.history.filter((r) => r.version !== ref.version).concat([ref]);
  e.history.sort((a, b) => a.version - b.version);
  e.current = ref.version;
  putKey(node.uploads, k, e); // safe against a slot literally named __proto__
  return e;
}

/** 回切当前版本（版本必须存在于历史中，否则不动）。 */
export function setCurrent(node, k, version) {
  const e = slotEntry(node.uploads, k);
  if (!e || !e.history.some((r) => r.version === version)) return false;
  e.current = version;
  putKey(node.uploads, k, e);
  return true;
}

/** 由服务器写响应（{url, version, sha256}）构造 MediaRef。shotId 是该媒体
 *  可证明归属的 M2 CREATIVE 镜头身份（调用方经 assetlib.shotIdForKey 或直接
 *  持有的 draft shot 求得）；不可证明时诚实传 null，绝不猜。
 *  字段名为 `creativeShotId`（M4a）——与服务端 sequence 型 `shot_id` 属不同
 *  命名空间，故用不同字段名，杜绝跨命名空间误读。 */
export function refFromResponse(slotId, origin, res, shotId = null) {
  return {
    slot_id: slotId,
    origin,
    version: typeof res.version === "number" ? res.version : 1,
    digest: res.sha256 || null,
    url: res.url,
    creativeShotId: typeof shotId === "string" && shotId ? shotId : null,
    storageState: "local", // M5: freshly written bytes are present locally
  };
}

/** 取回同源 url 内容并计算 sha256（hex）——补齐旧条目缺失的 digest。 */
export async function sha256OfUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读取媒体失败 ${r.status}`);
  const buf = await r.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
