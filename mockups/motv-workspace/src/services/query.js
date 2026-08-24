// Read-only query seam.
//
// - CONNECTED mode: a same-origin backend (server.py) is present and exposes the
//   accepted ADR-0031 read-only query contract over real project data. We fetch it.
// - LOCAL/demo mode: no backend (or no query package) — fall back to the JS
//   fixture so the static `python3 -m http.server` demo still works.
//
// This never writes pipeline state; the only mutations are the mockup-local
// canvas saves in persist.js.

import SHENGTANG from "../../fixtures/project-shengtang.js";
import { request, attempt, legacyError } from "./apiclient.js";

let _meta = null;

/** Probe the backend once; sets the mode for the session. */
export async function detectMode() {
  const res = await attempt("/api/meta");
  // The ONLY legitimate "no backend → fall back" in this file: it is what the
  // static demo IS. Every other failure below has to reach the caller.
  _meta = res.ok && res.data ? res.data : { mode: "local", contract_version: null };
  return _meta;
}

export const meta = () => _meta || { mode: "local" };
export const isConnected = () => meta().mode === "connected";

/** Real project names (CONNECTED only), else empty. */
export async function listProjects() {
  if (!isConnected()) return [];
  // NOT swallowed into `[]`: "the backend is broken" rendered as "you have no
  // projects" is the exact failure TASK-072 §1.4 acceptance #5 names. The landing
  // screen catches this and says so.
  const j = await request("/api/projects").catch((e) => {
    throw legacyError(e, "项目列表");
  });
  return (j.projects || []).map((p) => p.name);
}

/** The capability catalog (TASK-075 §1.4).
 *
 *  The three package sources are filesystem paths and a browser cannot read a
 *  filesystem, so the BACKEND is the loader and this is the page's only way to
 *  learn what capabilities exist (§1.0). Returns `{ ok: true, payload }` or
 *  `{ ok: false, detail }` — never a fabricated empty catalog, because "no
 *  backend" and "no capabilities" are different facts and only one of them is
 *  the creator's problem (ADR-0064 决策 6).
 *
 *  Carries `X-Motv-Runtime` like `probeExecutors`: this route reads the same
 *  package tree the run path compiles from. */
export async function fetchSkillCatalog() {
  if (!isConnected()) return { ok: false, detail: "没有后端：无法加载 Skill 包" };
  const res = await attempt("/api/skills", { headers: { "X-Motv-Runtime": "1" } });
  if (res.ok) return { ok: true, payload: res.data };
  return { ok: false, detail: res.error.text };
}

/* --- project location (ADR-0051) ------------------------------------------ */
// The browser cannot hand a real absolute path to the backend, so the backend
// reports its default location and lists directories for the picker. Both are
// read-only and same-origin, like every other query here.

/** Uniform {ok, status, data, error} so callers branch without try/catch.
 *
 *  Now a thin adapter over `apiclient.attempt`: the `error` it hands back is the
 *  classified ApiError, which still exposes `.category` and `.detail` — the two
 *  fields the existing call sites read. */
async function _call(path, opts) {
  const res = await attempt(path, opts);
  if (res.ok) return { ok: true, status: res.status, data: res.data || {} };
  const backend = res.error.body && res.error.body.error ? res.error.body.error : null;
  return {
    ok: false,
    status: res.error.status,
    // the backend's own error object when it sent one, so callers keyed on codes
    // like `root_unconfirmed` keep matching
    error: backend || { category: res.error.category, detail: res.error.detail },
  };
}

/** MEASURE a rendered cut with real ffprobe/ffmpeg (TASK-074 §1.2 接线).
 *
 *  A POST that writes NOTHING — the body carries the project and file name, and
 *  the backend only reads them. It lives with the queries because a measurement
 *  is an observation, not a command (ADR-0064 决策 6 / §6.2).
 *
 *  `timeoutMs: 0` — unbounded on purpose: ebur128 + blackdetect decode the whole
 *  file, so the wall clock scales with the cut's length. The BACKEND owns the
 *  real limit (900s, then 504); a 20s client timeout would abort every scan of a
 *  full episode and report it as a network fault.
 */
export function deliveryProbe(project, name) {
  return _call("/api/delivery/probe", {
    method: "POST",
    body: { project, name },
    timeoutMs: 0,
  });
}

/** The backend's default project location (its --account-root). */
export function fsDefault() {
  return _call("/api/fs/default");
}

/** Directories under `path` (directories only — never file contents). */
export function fsList(path) {
  return _call(`/api/fs/list?path=${encodeURIComponent(path || "")}`);
}

/** One read-only query (plan/status/budget/cost/problems/approvals) as JSON. */
export async function getQuery(name, q) {
  try {
    return await request(`/api/projects/${encodeURIComponent(name)}/${q}`);
  } catch (e) {
    throw legacyError(e, q);
  }
}

/** The project's REAL shot records (CONNECTED only), [] otherwise. */
export async function getShots(name) {
  if (!isConnected()) return [];
  // A 500 here used to become `[]` — indistinguishable from a project with no
  // shots, on a page whose whole job is showing shots. The fault propagates now.
  try {
    const j = await request(`/api/projects/${encodeURIComponent(name)}/shots`);
    return j.shots || [];
  } catch (e) {
    throw legacyError(e, "镜头记录");
  }
}

/** Fetch a same-origin upload URL and inline it as a data URL (ADR-0047:
 *  first-frame images travel to the Gateway as data URLs, never paths).
 *  Fails closed with `.tooLarge` when the original exceeds maxBytes. */
export async function fetchAsDataUrl(url, maxBytes) {
  // `expect: "raw"` — this one reads BYTES, not JSON, so it takes the Response
  // itself while still going through the one transport (classification, timeout).
  let r;
  try {
    r = await request(url, { expect: "raw", timeoutMs: 0 });
  } catch (e) {
    throw new Error(`读取图片失败 ${e.status || e.detail || ""}`.trim());
  }
  const blob = await r.blob();
  if (maxBytes && blob.size > maxBytes) {
    const err = new Error(`图片 ${(blob.size / 1024 / 1024).toFixed(1)}MB 超过上限`);
    err.tooLarge = true;
    throw err;
  }
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("图片读取失败"));
    fr.readAsDataURL(blob);
  });
}

/** The demo creative fixture (used for canvas authoring content in both modes). */
export function fixtureProject() {
  return SHENGTANG;
}

/* --------------------------------------------------------------------------- */
/* Command-Gateway READ coordinates (moved from services/gateway.js, §1.4)      */
/* --------------------------------------------------------------------------- */
//
// These three only READ. They sat in gateway.js beside `preflight`/`submit` because
// they serve the same flow, but 「同一个流程」 is not the split the contract asks for:
// the split is 「这一次调用会不会改东西」, and these do not.

/** Read-only generation coordinates (target digest + suggested params). */
export function getGenerationTarget(project, shotId) {
  return _read(
    `/api/projects/${encodeURIComponent(project)}/generation-target?shot_id=${encodeURIComponent(shotId)}`,
    "target",
  );
}

/** Read-only lock coordinates (current shot-plan version + digest, ADR-0047). */
export function getLockTarget(project) {
  return _read(`/api/projects/${encodeURIComponent(project)}/lock-target`, "lock-target");
}

/** 服务端媒体存在性审计（TASK-103 批次 C · GAP-02 / TASK-087 §4.2）。
 *
 *  它是 TASK-077 那个前端 `HEAD` 探针拿不到的答案：服务端读自己的目录，所以
 *  「在 / 不在」没有第三种。`measure=<文件名>` 时额外对**一个**文件做
 *  ffprobe-only 探测（尺寸 / 时长，TASK-087 §4.3）—— 不解码，与
 *  `/api/delivery/probe` 那条重端点区分开（TASK-087 §3.5.4）。
 *
 *  读不到就抛：这个函数的调用方要能说「审计没做成」，而不是渲染成「都不在」。 */
export function getMediaAudit(project, measure) {
  const q = measure ? `?measure=${encodeURIComponent(measure)}` : "";
  return _read(
    `/api/projects/${encodeURIComponent(project)}/media-audit${q}`,
    "media-audit",
  );
}

/** 一次审片写入要绑的目标三元组（TASK-103 批次 B）。
 *
 *  与 `getLockTarget` 同类，且同样**绝不回落到假件**：编一个 digest 的后果不是
 *  被拒，是把命令绑在一个不存在的版本上。读不到就抛，让调用方如实说。 */
export async function getReviewTarget(project, shotId) {
  const j = await _read(
    `/api/projects/${encodeURIComponent(project)}/review-target`
      + `?shot_id=${encodeURIComponent(shotId)}`,
    "review-target",
  );
  return j && j.target;
}

/** Paid-op status projection (read-only; reservations + staging artifacts). */
export async function paidOps(project) {
  const j = await _read(`/api/paid-ops/${encodeURIComponent(project)}`, "ops");
  return j.ops || [];
}

/** GET, throwing the app's legacy-shaped error. Not folded into an existing helper:
 *  these three must NEVER fall back to a fixture the way the demo-mode reads do — a
 *  fabricated preflight target would send a real command at a made-up digest. */
async function _read(path, label) {
  try {
    return await request(path);
  } catch (e) {
    throw legacyError(e, label);
  }
}

/* --------------------------------------------------------------------------- */
/* COMPATIBILITY LAYER — deprecated (系统合同 §7 / TASK-072 §1.4)               */
/* --------------------------------------------------------------------------- */
//
// Every WRITE moved to services/command.js. These re-exports keep the existing call
// sites working unchanged; they are deprecated and TASK-074 §1.5 deletes them once
// nothing imports them from here.
//
// Re-exported rather than reimplemented, so there is exactly ONE implementation of
// each write and the compatibility layer cannot drift from it.
export {
  createProject, listFlows, projectFlow, migrateLegacy,
  generateShotsDraft, generateScriptDraft, generateBibleBreakdown,
  developStory, planEpisodes,
  renderEpisode, mixShotAudio, composeFinal, ttsGenerate,
  deleteAssetFile, uploadAssetImage,
  paidImageGenerate,
} from "./command.js";
