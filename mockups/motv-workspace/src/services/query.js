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

let _meta = null;

/** Probe the backend once; sets the mode for the session. */
export async function detectMode() {
  try {
    const r = await fetch("/api/meta", { cache: "no-store" });
    if (r.ok) {
      _meta = await r.json();
      return _meta;
    }
  } catch {
    /* no backend — static demo */
  }
  _meta = { mode: "local", contract_version: null };
  return _meta;
}

export const meta = () => _meta || { mode: "local" };
export const isConnected = () => meta().mode === "connected";

/** Real project names (CONNECTED only), else empty. */
export async function listProjects() {
  if (!isConnected()) return [];
  try {
    const r = await fetch("/api/projects");
    const j = await r.json();
    return (j.projects || []).map((p) => p.name);
  } catch {
    return [];
  }
}

/* --- project location (ADR-0051) ------------------------------------------ */
// The browser cannot hand a real absolute path to the backend, so the backend
// reports its default location and lists directories for the picker. Both are
// read-only and same-origin, like every other query here.

/** Uniform {ok, status, data, error} so callers branch without try/catch. */
async function _call(path, init) {
  try {
    const r = await fetch(path, init);
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      return { ok: false, status: r.status, error: (j && j.error) || { detail: `HTTP ${r.status}` } };
    }
    return { ok: true, status: r.status, data: j || {} };
  } catch (e) {
    return { ok: false, status: 0, error: { category: "offline", detail: e.message } };
  }
}

/** The backend's default project location (its --account-root). */
export function fsDefault() {
  return _call("/api/fs/default", { cache: "no-store" });
}

/** Directories under `path` (directories only — never file contents). */
export function fsList(path) {
  return _call(`/api/fs/list?path=${encodeURIComponent(path || "")}`, { cache: "no-store" });
}

/** Ask the backend to create a project folder at `root`. A location never used
 *  before comes back 409 `root_unconfirmed`; re-send with confirm=true. */
export function createProject(name, root, confirm) {
  return _call("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, root, confirm: !!confirm }),
  });
}

/** Copy a project's legacy repo-scratch canvas + media into the project folder
 *  (ADR-0053). Explicit by design: the studio refuses to edit an unmigrated
 *  project rather than half-migrating it. The legacy files are kept. */
export function migrateLegacy(project) {
  return _call("/api/projects/migrate-legacy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
}

/** One read-only query (plan/status/budget/cost/problems/approvals) as JSON. */
export async function getQuery(name, q) {
  const r = await fetch(`/api/projects/${encodeURIComponent(name)}/${q}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j && j.error ? j.error.detail : `${q} ${r.status}`);
  return j;
}

/** The project's REAL shot records (CONNECTED only), [] otherwise. */
export async function getShots(name) {
  if (!isConnected()) return [];
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/shots`);
    const j = await r.json();
    return j.shots || [];
  } catch {
    return [];
  }
}

/** Creative agent (ADR-0042): script → structured shot DRAFT via the local
 *  Claude CLI (subscription-billed; the browser never sees a credential). */
export async function generateShotsDraft(script) {
  const r = await fetch("/api/agent/shots-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    err.rawExcerpt = e.raw_excerpt;
    throw err;
  }
  return j.shots || [];
}

/** Script drafting (Idea → Script slice): the brief (initial) or the current
 *  script + a revision instruction (revision) goes to the local Claude CLI and
 *  comes back as plain script text. Same trust posture as shots-draft. */
export async function generateScriptDraft({ idea, baseScript, instruction }) {
  const r = await fetch("/api/agent/script-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      instruction
        ? { base_script: baseScript, instruction }
        : { idea },
    ),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    throw err;
  }
  return j.script || "";
}

/** Script breakdown → Production Bible PROPOSALS (M8): the episode script
 *  goes to the local Claude CLI and comes back as proposed characters /
 *  locations / states. Same trust posture as shots-draft — the caller
 *  presents proposals; nothing is applied without an explicit user action. */
export async function generateBibleBreakdown(script) {
  const r = await fetch("/api/agent/bible-breakdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    err.rawExcerpt = e.raw_excerpt;
    throw err;
  }
  return j.breakdown || { characters: [], locations: [] };
}

/** Story development (M9): idea (+ optional current outline + instruction) →
 *  Story-Outline PROPOSAL. Same trust posture as the other agent calls. */
export async function developStory({ idea, current, instruction }) {
  const r = await fetch("/api/agent/story-develop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idea, current: current || null, instruction: instruction || "" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    throw err;
  }
  return j.outline || {};
}

/** Episode planning (M9): approved outline → Episode-Plan PROPOSAL. */
export async function planEpisodes({ outline, instruction }) {
  const r = await fetch("/api/agent/episode-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outline, instruction: instruction || "" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = j && j.error ? j.error : {};
    const err = new Error(e.detail || `agent ${r.status}`);
    err.category = e.category;
    throw err;
  }
  return j.episodes || [];
}

/** Lightweight episode render (M11): timeline clips → one MP4/WebM via the
 *  local FFmpeg endpoint. Returns {url, version, sha256, clips}. */
export async function renderEpisode(project, clips, settings) {
  const r = await fetch("/api/agent/render-episode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, clips, settings }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `render ${r.status}`);
  return j;
}

/** Shot Mix (ADR-0061 决策 6): one shot's audio clips → ONE derived audio file.
 *  `clips` carry `{ file, in, out, start, gainDb, fadeInMs, fadeOutMs, muted }`
 *  — gain in dB, the unit workflow/shotaudio.js stores, so the conversion lives
 *  in exactly one place (ffmpeg's `volume=…dB`). The SOURCES are untouched. */
export async function mixShotAudio(project, slug, clips) {
  const r = await fetch("/api/agent/mix-shot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, slug, clips }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `mix ${r.status}`);
  return j;
}

/** Delete ONE uploaded media file's bytes (M11 storage management). The
 *  caller owns the registry semantics; this only removes bytes. */
export async function deleteAssetFile(project, file) {
  const r = await fetch("/api/assets/delete-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, file }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `delete ${r.status}`);
  return j;
}

/** Manual image provider (prototype scratch): upload a user-generated media
 *  file for a slot. Same slot re-uploads APPEND a new version (TASK-048/
 *  ADR-0048), never replace. Returns {url, version, sha256}. */
export async function uploadAssetImage(project, slug, file) {
  const r = await fetch(
    `/api/uploads/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`,
    { method: "PUT", headers: { "Content-Type": file.type }, body: file },
  );
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `upload ${r.status}`);
  return j;
}

/** Local Piper TTS (ADR-0043): synthesize a draft voice-over into an upload
 *  slot — free, offline, no credential. Returns the audio URL. */
export async function ttsGenerate(project, slug, text, fitSlug, voice) {
  const r = await fetch("/api/agent/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      slug,
      text,
      ...(fitSlug ? { fit_slug: fitSlug } : {}),
      // the character's FIXED base voiceId: the server renders with a matching
      // local piper model when present, else honest fallback (M11 voice rule)
      ...(voice ? { voice } : {}),
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `tts ${r.status}`);
  return j;
}

/** Local FFmpeg draft compose (ADR-0044): stitch uploaded shot videos
 *  (+ optional voice/music) into a real MP4. Returns {url, version, shots}. */
export async function composeFinal(project, spec) {
  const r = await fetch("/api/agent/compose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, ...spec }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.detail) || `compose ${r.status}`);
  return j;
}

/** Paid image generation (ADR-0045, MiniMax image-01). confirmUsd echoes the
 *  catalog price the user just confirmed — server 409s on any mismatch. */
export async function paidImageGenerate(project, slug, prompt, confirmUsd) {
  const r = await fetch("/api/agent/image-gen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, slug, prompt, confirm_usd: confirmUsd }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((j && j.error && j.error.detail) || `image ${r.status}`);
    // Only a small ALLOWLIST of 4xx codes is treated as DEFINITIVELY
    // side-effect-free (request rejected before any generation/bill). Timing /
    // conflict / rate codes (408, 409, 425, 429, …) can arrive AFTER upstream
    // dispatch, so they stay AMBIGUOUS — as do all 5xx and network failures —
    // and the caller must not record a false failure for a possibly-billed image.
    const DEFINITIVE_REJECT = new Set([400, 401, 403, 404, 422]);
    if (DEFINITIVE_REJECT.has(r.status)) err.definitiveReject = true;
    throw err;
  }
  return j;
}

/** Fetch a same-origin upload URL and inline it as a data URL (ADR-0047:
 *  first-frame images travel to the Gateway as data URLs, never paths).
 *  Fails closed with `.tooLarge` when the original exceeds maxBytes. */
export async function fetchAsDataUrl(url, maxBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`读取图片失败 ${r.status}`);
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
