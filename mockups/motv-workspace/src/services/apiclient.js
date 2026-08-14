// The ONE place this page talks to the backend (系统合同 §7 / TASK-072 §1.4).
//
// Before this module every service reached for `fetch` itself, and each one
// invented its own idea of what a failure was. The shapes actually in the tree
// were: `catch → return []`, `catch → return fixture`, `!r.ok → return null`,
// and `await r.json()` with no content-type check at all. Three of those four
// turn a backend fault into *plausible emptiness* — the page renders "no
// projects", "no assets", "no runs" and the creator has no way to tell that
// apart from a project that really is empty.
//
// So the contract here is deliberately narrow:
//
//   request()   throws a CLASSIFIED ApiError. The caller must handle it.
//   attempt()   returns {ok, status, data, error} for callers that genuinely
//               branch on failure rather than propagate it.
//
// There is no third form that returns a value on failure. A fallback is a
// decision about product behaviour, so it belongs at the call site where that
// decision is legible — never hidden in the transport.

/** Error categories. Closed set: a caller can exhaustively branch on these, and
 *  anything unrecognised becomes `server` rather than a new silent shape. */
export const API_ERROR = Object.freeze({
  OFFLINE: "offline", // no backend reachable at all (static demo, dropped wifi)
  TIMEOUT: "timeout", // we gave up waiting
  ABORTED: "aborted", // the caller cancelled it
  MALFORMED: "malformed", // 2xx that is not the JSON we were promised
  CLIENT: "client", // 400 / 422 — the request itself was wrong
  UNAUTHORIZED: "unauthorized", // 401
  FORBIDDEN: "forbidden", // 403 — includes the runtime-header guard
  NOT_FOUND: "not_found", // 404 — also how cross-project access is denied
  CONFLICT: "conflict", // 409 — optimistic concurrency, digest conflicts
  UNAVAILABLE: "unavailable", // 503 — the capability/executor is not there
  SERVER: "server", // 5xx
});

const STATUS_CATEGORY = {
  400: API_ERROR.CLIENT,
  401: API_ERROR.UNAUTHORIZED,
  403: API_ERROR.FORBIDDEN,
  404: API_ERROR.NOT_FOUND,
  409: API_ERROR.CONFLICT,
  422: API_ERROR.CLIENT,
  503: API_ERROR.UNAVAILABLE,
};

/** What a failure means to a human, in the creator's language.
 *
 *  Here rather than in each panel so the same fault reads the same way wherever
 *  it surfaces — and so a panel that forgets to write a message still shows one. */
export const API_ERROR_TEXT = {
  [API_ERROR.OFFLINE]: "连不上后端。页面还在，但读不到真实数据。",
  [API_ERROR.TIMEOUT]: "后端没有在预期时间内回应。",
  [API_ERROR.ABORTED]: "请求已取消。",
  [API_ERROR.MALFORMED]: "后端回了预期之外的内容（不是 JSON）。",
  [API_ERROR.CLIENT]: "这次请求本身不合法，后端拒绝了它。",
  [API_ERROR.UNAUTHORIZED]: "需要先登录。",
  [API_ERROR.FORBIDDEN]: "这个接口拒绝了本次访问。",
  [API_ERROR.NOT_FOUND]: "找不到这个对象。",
  [API_ERROR.CONFLICT]: "有别的改动先落地了，本次没有覆盖它。",
  [API_ERROR.UNAVAILABLE]: "这个能力当前不可用。",
  [API_ERROR.SERVER]: "后端出错了。",
};

/** A backend failure, carrying enough to render an honest message. */
export class ApiError extends Error {
  constructor(category, { status = 0, detail = "", path = "", body = null } = {}) {
    super(detail || API_ERROR_TEXT[category] || category);
    this.name = "ApiError";
    this.category = category;
    this.status = status;
    this.detail = detail || API_ERROR_TEXT[category] || category;
    this.path = path;
    // the parsed error body when the backend sent one — `{error:{category,detail}}`
    // is this project's convention and callers sometimes need its `category`
    this.body = body;
  }

  /** Message for the UI. Never the raw stack, never a file path: the backend
   *  deliberately keeps local absolute paths out of responses (TASK-072 round 6)
   *  and the client must not put them back in. */
  get text() {
    return this.detail || API_ERROR_TEXT[this.category] || "请求失败";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Retries are for TRANSPORT faults on reads only.
 *
 *  Never for a write: a request that may have already been applied must not be
 *  replayed by the transport, because the transport cannot know whether it took
 *  effect (系统合同 §5.8 — `sideEffect: unknown` forbids automatic retry, and
 *  that rule is worthless if a layer underneath retries anyway). A write that
 *  needs retrying is a user decision, made with the idempotency key. */
const RETRYABLE = new Set([API_ERROR.OFFLINE, API_ERROR.TIMEOUT, API_ERROR.SERVER]);

function classify(status) {
  if (STATUS_CATEGORY[status]) return STATUS_CATEGORY[status];
  if (status >= 500) return API_ERROR.SERVER;
  if (status >= 400) return API_ERROR.CLIENT;
  return API_ERROR.SERVER;
}

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);

/** A body `fetch` can already send as-is. Anything else is serialised as JSON. */
function isRawBody(body) {
  if (typeof body === "string") return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true; // File too
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  return false;
}

/** One attempt, no retry. Separated so the retry loop stays readable. */
async function once(path, opts) {
  const { method = "GET", body, headers, timeoutMs = DEFAULT_TIMEOUT_MS, signal, expect } = opts;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new ApiError(API_ERROR.ABORTED, { path });
    signal.addEventListener("abort", onAbort, { once: true });
  }
  // A hung request is indistinguishable from a slow one without this, and the
  // panels that wait on it have no way to time out on their own.
  //
  // `0` (or Infinity) means NO deadline, for the calls that legitimately run for
  // minutes — an ffmpeg render, a CLI invocation. Passing it to setTimeout would
  // fire on the next tick and abort the request immediately, i.e. the opposite of
  // what the caller asked for.
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const timer = bounded ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const wantsRaw = expect === "raw";
  // THE DEADLINE COVERS THE BODY TOO. `fetch` resolves as soon as the HEADERS
  // arrive; releasing the timer and the caller's abort listener there left
  // `.json()` / `.blob()` unbounded and no longer cancellable — a slow body could
  // hang forever despite a timeout being set. So everything below runs inside one
  // try, and both are released only in its `finally`.
  //
  // A RAW read is the exception: its body is consumed by the CALLER after this
  // function returns, so the deadline cannot cover it and the timer is released
  // before returning the Response.
  try {
    let res;
    try {
      // `no-store` belongs on JSON reads (a stale project list is a wrong answer),
      // NOT on raw BYTE reads: `fetchAsDataUrl` and `sha256OfUrl` pull whole media
      // files, and forcing a re-download on every preview/hash is pure waste. Those
      // pass `expect: "raw"`, so they keep the default caching they had before.
      const init = { method, signal: controller.signal };
      if (!wantsRaw) init.cache = "no-store";
      const hdrs = { ...(headers || {}) };
      if (body !== undefined) {
        // Pass BINARY AND PRE-ENCODED bodies through untouched. `JSON.stringify` of
        // a File yields `"{}"` — an upload that silently transmits nothing while
        // reporting success — and FormData carries its own multipart boundary that
        // an added Content-Type would break.
        if (isRawBody(body)) {
          init.body = body;
          // only what the caller explicitly set (e.g. a File's own MIME type)
        } else {
          hdrs["Content-Type"] = hdrs["Content-Type"] || "application/json";
          init.body = JSON.stringify(body);
        }
      }
      if (Object.keys(hdrs).length) init.headers = hdrs;
      res = await fetch(path, init);
    } catch (e) {
      // AbortError has two causes and they are NOT the same fact: the caller
      // cancelled, or we ran out of patience. Reporting a timeout as a
      // cancellation hides a real backend fault.
      if (e && e.name === "AbortError") {
        throw new ApiError(signal && signal.aborted ? API_ERROR.ABORTED : API_ERROR.TIMEOUT, {
          path,
        });
      }
      throw new ApiError(API_ERROR.OFFLINE, { path, detail: (e && e.message) || "" });
    }

    const ctype = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    const isJson = ctype.includes("application/json");
    // Parsed even on failure: this project's errors carry `{error:{category,detail}}`
    // and dropping it would replace a precise reason with a bare status code.
    //
    // NOT parsed for a successful raw read: a body can only be consumed once, so
    // reading it here would leave the caller's `.blob()` with nothing.
    let parsed = null;
    if (isJson && !(wantsRaw && res.ok)) {
      try {
        parsed = await res.json();
      } catch (e) {
        // AN ABORTED BODY IS NOT A MALFORMED ONE. A blanket `.catch(() => null)`
        // turned a deadline that fired mid-body into 「响应不是可解析的 JSON」 —
        // pointing the creator at the backend's data when the real fact is that we
        // stopped waiting. Only a genuine parse failure falls through to `null`.
        // `AbortError` is the browser's name for it; Node/undici rejects an aborted
        // body read as `TypeError: terminated`. Checking only the name reported a
        // timeout as MALFORMED on the Node path — the same confusion this block
        // removes for the browser (independent review, batch 2 round 2). The
        // controller's own signal is the authoritative fact.
        if ((e && e.name === "AbortError") || controller.signal.aborted) {
          throw new ApiError(
            signal && signal.aborted ? API_ERROR.ABORTED : API_ERROR.TIMEOUT,
            { path },
          );
        }
        parsed = null;
      }
    }

    if (!res.ok) {
      const err = isObj(parsed) && isObj(parsed.error) ? parsed.error : null;
      throw new ApiError(classify(res.status), {
        status: res.status,
        // the backend's own wording wins — it knows which of the several 403s this is
        detail: (err && err.detail) || `HTTP ${res.status}`,
        path,
        body: parsed,
      });
    }
    if (wantsRaw) return res;
    if (!isJson) {
      // A 200 of HTML is the signature of a dev server or proxy serving index.html
      // for an unknown /api path. Treating it as data yields nonsense downstream.
      throw new ApiError(API_ERROR.MALFORMED, {
        status: res.status,
        detail: `期望 JSON，收到 ${ctype || "未声明类型"}`,
        path,
      });
    }
    if (parsed === null) {
      throw new ApiError(API_ERROR.MALFORMED, {
        status: res.status,
        detail: "响应不是可解析的 JSON",
        path,
      });
    }
    // the REAL status travels with the body, so a caller can tell 200 from 201/204
    return { __status: res.status, data: parsed };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Call the backend. Resolves with the parsed JSON body, or THROWS an ApiError.
 *
 * @param {string} path      same-origin path, e.g. `/api/skills`
 * @param {object} [opts]
 *   method    default GET
 *   body      serialised as JSON (FormData passed through untouched)
 *   headers   extra headers, e.g. the `X-Motv-Runtime` guard
 *   timeoutMs default 20s
 *   signal    caller's AbortSignal
 *   retries   read-only transport retries; forced to 0 for non-GET
 *   expect    `"raw"` to get the Response itself (blobs, data URLs)
 */
export async function request(path, opts = {}) {
  const r = await withRetry(path, opts);
  // `once` returns `{__status, data}` for JSON so `attempt` can report the REAL
  // status; `request`'s contract is the BODY, so it is unwrapped here — once —
  // rather than at every call site. A raw read returns the Response untouched.
  return isObj(r) && "__status" in r ? r.data : r;
}

/**
 * The retry loop, shared by BOTH entry points.
 *
 * It lives here rather than inside `request` because `attempt` needs it too: an
 * earlier revision had `attempt` call `once` directly to get at the real status, and
 * that silently dropped the retry for every one of its callers — `detectMode`,
 * `fetchSkillCatalog`, `fsDefault`/`fsList`, `probeExecutors`. The worst of those is
 * `detectMode`: ONE transient fault on `/api/meta` then flips the whole session into
 * `{mode:"local"}` permanently, i.e. a backend fault rendered as 「按设计没有后端」 —
 * exactly the class of failure this module exists to remove (independent review,
 * batch 1 round 2).
 */
async function withRetry(path, opts) {
  const method = opts.method || "GET";
  // A write is never retried here. See RETRYABLE.
  const budget = method === "GET" ? Math.max(0, opts.retries ?? 1) : 0;
  let tries = 0;
  for (;;) {
    try {
      return await once(path, opts);
    } catch (e) {
      const retryable = e instanceof ApiError && RETRYABLE.has(e.category);
      if (!retryable || tries >= budget) throw e;
      tries++;
    }
  }
}

/**
 * The same call, as a value instead of an exception.
 *
 * For call sites that genuinely branch — "no backend? then this page runs in
 * local demo mode" — where a try/catch around every read would be noise. The
 * error is still the classified ApiError, so the branch cannot accidentally
 * treat "500" and "empty" as the same thing.
 *
 * @returns {Promise<{ok: boolean, status: number, data: any, error: ApiError|null}>}
 */
export async function attempt(path, opts = {}) {
  try {
    // THROUGH THE RETRY LOOP, like `request` — see `withRetry`.
    const r = await withRetry(path, opts);
    // the REAL status, not a hardcoded 200: `query.js:_call` callers branch on it,
    // and 201/204 are legitimately different answers from 200
    const wrapped = isObj(r) && "__status" in r;
    // a RAW read returns the Response itself, whose own `status` is the real one —
    // reporting 200 for it flattened 206/304 (independent review, batch 2 round 2)
    const status = wrapped ? r.__status : (r && Number.isInteger(r.status) ? r.status : 200);
    return { ok: true, status, data: wrapped ? r.data : r, error: null };
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(API_ERROR.SERVER, { detail: String(e) });
    return { ok: false, status: err.status, data: null, error: err };
  }
}

/**
 * Convert an ApiError into the error shape this app's existing call sites branch on.
 *
 * Shared by `query.js` and `command.js` so the two cannot drift: `.category` stays
 * the BACKEND's category when it sent one, because the panels' hint tables are keyed
 * on values like `unavailable` / `unauthenticated` / `invalid_output`. Replacing
 * those with a transport-level class would silently blank out every one of them.
 */
export function legacyError(e, label) {
  const backend = e && e.body && e.body.error ? e.body.error : {};
  const err = new Error((e && e.detail) || `${label} ${(e && e.status) || ""}`.trim());
  err.category = backend.category || (e && e.category) || "error";
  err.status = e && e.status;
  if (backend.raw_excerpt) err.rawExcerpt = backend.raw_excerpt;
  return err;
}

/** Did this fail because there is no backend at all?
 *
 *  The one distinction the page legitimately makes everywhere: a static demo
 *  has no backend BY DESIGN, while a 500 from a backend that is right there is a
 *  fault to show. Both are failures; only one is normal. */
export function isOffline(error) {
  return !!error && error.category === API_ERROR.OFFLINE;
}
