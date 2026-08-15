// The WRITE seam (系统合同 §7 / TASK-072 §1.4).
//
// Everything that changes state, spends a subscription slot, spends money, or starts
// a subprocess lives here. Everything that only READS lives in query.js. The split is
// not tidiness — it is so that a reader can answer 「这一次调用会不会改东西」 by
// looking at which module it came from, and so a future automation level can be
// enforced at one seam instead of at thirty call sites.
//
// WHAT THIS MODULE DOES NOT DO:
//
//   - it never retries. `apiclient` refuses to retry any non-GET, because a request
//     that may already have been applied must not be replayed by a transport that
//     cannot know whether it took effect (系统合同 §5.8: `sideEffect: unknown`
//     forbids automatic retry, and that rule is worthless if a layer underneath
//     retries anyway). A retry is a user decision, carried by an idempotency key.
//   - it never decides whether an operation is ALLOWED. Automation level, locks and
//     the two ⚙ hard gates are domain concerns and are checked before a call reaches
//     here; a transport that also enforced policy would be a second place to keep
//     that policy correct.
//   - it never turns a failure into a value. Every function here throws a classified
//     error, because a write that silently 「did nothing」 is the worst outcome of all.
import { request, legacyError } from "./apiclient.js";

/** POST JSON, throwing the app's legacy-shaped error on failure. */
async function post(path, body, label, { timeoutMs } = {}) {
  try {
    return await request(path, { method: "POST", body, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  } catch (e) {
    throw legacyError(e, label);
  }
}

/** Uniform {ok, status, data, error} for the callers that branch instead of throwing
 *  — project creation reports a 409 the creator must confirm, not an exception. */
async function call(path, opts) {
  try {
    const data = await request(path, opts);
    return { ok: true, status: 200, data: data || {} };
  } catch (e) {
    const backend = e && e.body && e.body.error ? e.body.error : null;
    return {
      ok: false,
      status: e && e.status,
      error: backend || { category: (e && e.category) || "error", detail: (e && e.detail) || "请求失败" },
    };
  }
}

/* --- project lifecycle ----------------------------------------------------- */

/** Create a project folder at `root`. A location never used before comes back 409
 *  `root_unconfirmed`; re-send with confirm=true. */
export function createProject(name, root, confirm) {
  return call("/api/projects", { method: "POST", body: { name, root, confirm: !!confirm } });
}

/** Copy a project's legacy repo-scratch canvas + media into the project folder
 *  (ADR-0053). Explicit by design: the studio refuses to edit an unmigrated project
 *  rather than half-migrating it. The legacy files are kept. */
export function migrateLegacy(project) {
  return call("/api/projects/migrate-legacy", { method: "POST", body: { project } });
}

/* --- creative agents (ADR-0065 五个创作端点) ------------------------------- */
//
// These SPEND: each one starts a local CLI on the creator's subscription. They are
// writes even though they return text, which is exactly why they belong here and not
// beside `getShots`.
//
// `timeoutMs: 0` — no read-sized deadline. A model answering a full episode script
// legitimately takes minutes, and cutting it off at 20s would report a timeout for a
// run that was working.

export async function generateShotsDraft(script) {
  const j = await post("/api/agent/shots-draft", { script }, "agent", { timeoutMs: 0 });
  return j.shots || [];
}

export async function generateScriptDraft({ idea, baseScript, instruction }) {
  const j = await post(
    "/api/agent/script-draft",
    instruction ? { base_script: baseScript, instruction } : { idea },
    "agent",
    { timeoutMs: 0 },
  );
  return j.script || "";
}

export async function generateBibleBreakdown(script) {
  const j = await post("/api/agent/bible-breakdown", { script }, "agent", { timeoutMs: 0 });
  return j.breakdown || { characters: [], locations: [] };
}

export async function developStory({ idea, current, instruction }) {
  const j = await post(
    "/api/agent/story-develop",
    { idea, current: current || null, instruction: instruction || "" },
    "agent",
    { timeoutMs: 0 },
  );
  return j.outline || {};
}

export async function planEpisodes({ outline, instruction }) {
  const j = await post(
    "/api/agent/episode-plan",
    { outline, instruction: instruction || "" },
    "agent",
    { timeoutMs: 0 },
  );
  return j.episodes || [];
}

/* --- local media production (ffmpeg / piper) ------------------------------- */

export function renderEpisode(project, clips, settings) {
  return post("/api/agent/render-episode", { project, clips, settings }, "render", { timeoutMs: 0 });
}

export function mixShotAudio(project, slug, clips) {
  return post("/api/agent/mix-shot", { project, slug, clips }, "mix", { timeoutMs: 0 });
}

export function composeFinal(project, spec) {
  return post("/api/agent/compose", { project, ...spec }, "compose", { timeoutMs: 0 });
}

export function ttsGenerate(project, slug, text, fitSlug, voice) {
  return post(
    "/api/agent/tts",
    {
      project,
      slug,
      text,
      ...(fitSlug ? { fit_slug: fitSlug } : {}),
      // the character's FIXED base voiceId: the server renders with a matching local
      // piper model when present, else honest fallback (M11 voice rule)
      ...(voice ? { voice } : {}),
    },
    "tts",
    { timeoutMs: 0 },
  );
}

/* --- asset bytes ----------------------------------------------------------- */

/** Delete ONE uploaded media file's bytes. The caller owns the registry semantics;
 *  this only removes bytes. */
export function deleteAssetFile(project, file) {
  return post("/api/assets/delete-file", { project, file }, "delete");
}

/** Upload a creator-generated media file for a slot. Same slot re-uploads APPEND a
 *  new version (TASK-048 / ADR-0048), never replace. */
export async function uploadAssetImage(project, slug, file) {
  try {
    return await request(
      `/api/uploads/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`,
      // a File is a Blob: it goes through as-is with its own content type, and a
      // large upload gets no read-sized deadline
      { method: "PUT", body: file, headers: { "Content-Type": file.type }, timeoutMs: 0 },
    );
  } catch (e) {
    throw legacyError(e, "upload");
  }
}

/* --- paid (ADR-0045) ------------------------------------------------------- */

/**
 * Paid image generation. `confirmUsd` echoes the catalog price the creator just
 * confirmed — the server 409s on any mismatch, so a stale price cannot be spent.
 *
 * `definitiveReject` marks the SMALL allowlist of 4xx codes that prove nothing was
 * generated and nothing was billed. Everything else — timing / conflict / rate codes,
 * all 5xx, every network failure — stays AMBIGUOUS, and the caller must not record a
 * clean failure for a possibly-billed image. This is also why no write is ever
 * retried by the transport.
 */
export async function paidImageGenerate(project, slug, prompt, confirmUsd) {
  try {
    return await request("/api/agent/image-gen", {
      method: "POST",
      body: { project, slug, prompt, confirm_usd: confirmUsd },
      timeoutMs: 0,
    });
  } catch (e) {
    const err = legacyError(e, "image");
    const DEFINITIVE_REJECT = new Set([400, 401, 403, 404, 422]);
    if (DEFINITIVE_REJECT.has(e && e.status)) err.definitiveReject = true;
    throw err;
  }
}

/* --------------------------------------------------------------------------- */
/* THE COMMAND GATEWAY's two-step write path (ADR-0033 / ADR-0041)             */
/* --------------------------------------------------------------------------- */
//
// Moved here from services/gateway.js (TASK-072 §1.4 落点表: 「command.js 只写；
// Envelope 构造 + preflight + submit」). It lived in a module of its own for
// historical reasons, which meant the one write path that can SPEND money was the
// only write not covered by this module's rules — exactly the seam §1.4 exists to
// close.
//
// `preflight` is read-only by contract, and it is still here rather than in query.js:
// it is step 1 of a WRITE, its digest is what authorises step 2, and splitting the two
// halves across two modules is how a caller ends up submitting against a digest from a
// different envelope.

/** A monotonic suffix for `command_id`, so two envelopes built in the same
 *  millisecond cannot collide. `Date.now()` alone did, in the batch path. */
let _cmdSeq = 0;

/**
 * Build the Command Envelope (系统合同 §7).
 *
 * ONE construction site, because the four fields are a contract with the backend's
 * Command Gateway and a missing `target` does not fail loudly — it fails as a command
 * the gateway cannot locate, after the creator has already confirmed a cost.
 *
 * `actor` is deliberately NOT set here: the backend forces `actor="user"` and a value
 * sent from the browser would be a claim the browser is not entitled to make.
 */
export function buildEnvelope(name, target, params, commandId) {
  if (typeof name !== "string" || !name) throw new Error("命令信封缺少 name");
  if (target === undefined || target === null || target === "") {
    throw new Error(`命令信封 ${name} 缺少 target —— 网关无法定位要改的东西`);
  }
  if (params !== undefined && params !== null && typeof params !== "object") {
    throw new Error(`命令信封 ${name} 的 params 必须是对象`);
  }
  return {
    command_id: commandId || `cmd-${Date.now().toString(36)}-${++_cmdSeq}`,
    name,
    params: params && typeof params === "object" ? params : {},
    target,
  };
}

/** Step 1: read-only preflight — never spends, never writes. Returns the
 *  `preflight_digest` step 2 must be confirmed against. */
export function preflight(project, envelope) {
  return post(
    `/api/projects/${encodeURIComponent(project)}/preflight`,
    envelope,
    "preflight",
    { timeoutMs: 0 },
  );
}

/** Step 2: the confirmed submit — the actual HIGH-risk write (may spend).
 *
 *  `confirmation` is the digest step 1 returned FOR THIS ENVELOPE. Passing a digest
 *  from a different preflight is refused by the backend, which is the whole point of
 *  the two steps: the thing the creator confirmed and the thing that runs are proven
 *  to be the same thing. */
export async function submit(project, envelope, confirmation) {
  // `async`, so the guard REJECTS rather than throwing synchronously: every other
  // call in this module returns a promise, and a caller writing `submit(…).catch(…)`
  // would meet a sync throw as an uncaught exception instead of its handler.
  if (!confirmation) throw new Error("submit 缺少 preflight 确认摘要 —— 未经确认的命令不提交");
  return post(
    `/api/projects/${encodeURIComponent(project)}/command`,
    { ...envelope, confirmation },
    "command",
    { timeoutMs: 0 }, // a confirmed command can involve a provider call
  );
}

/** Adopt a paid staging clip into a canvas upload slot (copy; no spend).
 *  An occupied slot gains a NEW version (TASK-048 — never overwritten).
 *  Returns {url, version, sha256}. */
export function adoptPaid(project, taskId, slug) {
  return post(
    "/api/agent/adopt-paid",
    { project, task_id: taskId, slug },
    "adopt",
    { timeoutMs: 0 }, // copies bytes
  );
}

/** An operation id that cannot collide with one started in the same millisecond.
 *
 *  The paid paths correlate `command_id` with `operation_id` by construction
 *  (`cmd-${opId}`), so they pass an EXPLICIT command id — which means
 *  `buildEnvelope`'s own anti-collision suffix never applies to them and only the
 *  lock path benefited from it (independent review). The uniqueness has to be in the
 *  operation id itself, which is what this is for. */
export function newOperationId(prefix = "op-ui-") {
  return `${prefix}${Date.now().toString(36)}-${++_cmdSeq}`;
}

/** Demo stub (non-paid modes): logs and resolves, changes nothing.
 *
 *  It stays a WRITE-module export even though it writes nothing: it stands where the
 *  real command goes, and moving it to the read module would make the demo path and
 *  the real path differ in which seam they come from.
 *
 *  It builds its envelope ITSELF rather than through `buildEnvelope`, because it must
 *  be able to represent 「这个演示命令没有目标」 — and refusing exactly that is the
 *  real constructor's job. Routing it through anyway meant substituting a made-up
 *  `"demo"` target, i.e. the stub narrating a target it does not have. */
export function submitCommand(cmd) {
  const envelope = {
    command_id: `cmd-${Date.now().toString(36)}-${++_cmdSeq}`,
    name: cmd.name,
    actor: "user",
    target: cmd.target || null,
    params: cmd.params || {},
  };
  // eslint-disable-next-line no-console
  console.info("[gateway:stub] submit", envelope);
  return { status: "accepted", command: envelope, note: "prototype stub — no real write" };
}
