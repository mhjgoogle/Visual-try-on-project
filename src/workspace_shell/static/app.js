"use strict";
/* Read-only workspace shell client (TASK-026 shell + TASK-027 deep-dives).
 *
 * There is exactly ONE query client (the `Q` object below): it is the single
 * place that builds backend URLs and fetches. Page renderers never construct
 * URLs or read files themselves. Every data region distinguishes
 * loading / empty / error / legacy / unavailable, surfaces the three-way
 * authoritative|derived|unavailable provenance, and never renders a query
 * failure as empty (fail-closed). Reads are GET; the ONLY writes are POST
 * Command Gateway commands (TASK-031) via `Q.preflightCommand`/`Q.submitCommand`
 * — no other mutating verb, no Provider or file access, exists in this file.
 *
 * TASK-027 adds three read-only deep-dive views over the SAME query contract:
 *   - Lineage    (WQ-03 upstream + WQ-04 downstream of one ref)
 *   - Prompts    (WQ-05 version chain, change basis, candidates vs selected)
 *   - Shots      (WQ-06 attempt history, primary/retry/redo/fallback)
 * plus a Cost drilldown renderer (WQ-07) that keeps every currency separate
 * (amounts are never summed across currencies) and shows the WQ-14 budget line.
 */

const EXPECTED_MAJOR = "1"; // query contract major (contract_version "1.x")

// Zero-argument observation pages (WSM1-B) + the WSM1-C deep-dive pages.
const VIEWS = [
  ["plan", "Plan (L0–S7)"],
  ["status", "Progress"],
  ["approvals", "Approvals"],
  ["cost", "Cost"],
  ["budget", "Budget"],
  ["problems", "Problems"],
  ["lineage", "Lineage"],
  ["prompts", "Prompts"],
  ["shots", "Shots"],
];

// Deep-dive pages that need one identifier before they can query anything.
const PARAM_VIEWS = {
  lineage: { key: "ref", label: "Artifact / object ref", ph: "e.g. a video asset id" },
  prompts: { key: "prompt_id", label: "Prompt id", ph: "e.g. p-main" },
  shots: { key: "shot_id", label: "Shot id", ph: "e.g. shot-1" },
};

// ---- the single query client ------------------------------------------------
const Q = {
  async _get(url) {
    let resp;
    try {
      resp = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      return { kind: "error", status: 0, envelope: {
        category: "network", detail: String(e), context: {}, readiness_failed: true } };
    }
    let body = null;
    try { body = await resp.json(); } catch (_e) { body = null; }
    if (!resp.ok) {
      const env = (body && body.error) || {
        category: "http_" + resp.status, detail: "request failed",
        context: {}, readiness_failed: true };
      return { kind: "error", status: resp.status, envelope: env };
    }
    if (body && typeof body.contract_version === "string") {
      const major = body.contract_version.split(".")[0];
      if (major !== EXPECTED_MAJOR) return { kind: "legacy", data: body };
    }
    return { kind: "ok", data: body };
  },
  _p(name) { return "/api/projects/" + encodeURIComponent(name); },
  projects() { return this._get("/api/projects"); },
  view(name, view) { return this._get(`${this._p(name)}/${view}`); },
  lineageUpstream(name, ref) {
    return this._get(`${this._p(name)}/lineage-upstream?ref=${encodeURIComponent(ref)}`);
  },
  lineageDownstream(name, ref) {
    return this._get(`${this._p(name)}/lineage-downstream?ref=${encodeURIComponent(ref)}`);
  },
  promptHistory(name, id) {
    return this._get(`${this._p(name)}/prompt?prompt_id=${encodeURIComponent(id)}`);
  },
  shotAttempts(name, id) {
    return this._get(`${this._p(name)}/shot?shot_id=${encodeURIComponent(id)}`);
  },
  // A containment-guarded artifact URL (served read-only by /artifact). This is
  // the only place a media/file URL is built; it never carries a credential.
  artifactUrl(path) { return "/artifact?path=" + encodeURIComponent(path); },

  // ---- the Gateway write path (TASK-031) ------------------------------------
  // Every mutation is a Command Gateway command: preflight (read-only inputs /
  // cost / downstream / blockers + a digest) then submit (a high-risk command
  // carries a confirmation equal to that digest). POST is the only write verb;
  // the client never touches a Provider or a file directly.
  async _post(url, payload) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { kind: "error", status: 0, envelope: {
        category: "network", detail: String(e), context: {}, readiness_failed: true } };
    }
    let body = null;
    try { body = await resp.json(); } catch (_e) { body = null; }
    if (!resp.ok) {
      const env = (body && body.error) || {
        category: "http_" + resp.status, detail: "command failed",
        context: {}, readiness_failed: true };
      return { kind: "error", status: resp.status, envelope: env };
    }
    return { kind: "ok", data: body };
  },
  preflightCommand(name, envelope) {
    return this._post(`${this._p(name)}/preflight`, envelope);
  },
  submitCommand(name, envelope) {
    return this._post(`${this._p(name)}/command`, envelope);
  },
};

// ---- tiny DOM helpers (text set via textContent — no HTML injection) --------
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "text") n.textContent = attrs[k];
    else if (k === "class") n.className = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  (children || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function provBadge(prov) {
  return el("span", { class: "prov " + prov, text: prov, title: "provenance: " + prov });
}
function renderValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
// A labelled value with its provenance badge (used by the deep-dive cards).
function field(label, f) {
  const row = el("div", { class: "kv" });
  row.appendChild(el("span", { class: "k", text: label }));
  const v = el("span", { class: "v" });
  if (f && typeof f === "object" && "provenance" in f) {
    v.appendChild(document.createTextNode(renderValue(f.value)));
    v.appendChild(provBadge(f.provenance));
  } else { v.textContent = "—"; }
  row.appendChild(v);
  return row;
}

// ---- state panels (each state is visually distinct) -------------------------
function panel(kind, title, detailNode) {
  const p = el("div", { class: "state " + kind });
  p.appendChild(el("div", { class: "state-title", text: title }));
  if (detailNode) p.appendChild(detailNode);
  return p;
}
function loadingPanel() { return panel("loading", "Loading…"); }
function emptyPanel() { return panel("empty", "No records", el("p", { class: "muted",
  text: "This query returned zero items and reported no problems — genuinely empty." })); }
function errorPanel(env) {
  const box = el("div");
  box.appendChild(el("p", { text: env.detail || "query failed" }));
  const ctx = env.context || {};
  const keys = Object.keys(ctx);
  if (keys.length) box.appendChild(el("p", { class: "ctx",
    text: keys.map((k) => `${k}=${ctx[k]}`).join("  ") }));
  const t = "Query error — " + (env.category || "unknown") +
    (env.readiness_failed ? " (readiness failed)" : "");
  return panel("error", t, box);
}
function legacyPanel(data) {
  return panel("legacy", "Unsupported contract version",
    el("p", { text: `Backend contract ${data && data.contract_version} is not ` +
      `understood by this client (expects ${EXPECTED_MAJOR}.x). Shown as legacy, not empty.` }));
}
// An explicit "unavailable" panel — WFM1 does not carry this semantic, and we
// say so rather than guessing or faking a value (query contract §4, §8).
function unavailablePanel(title, reason) {
  return panel("unavailable", title, el("p", { class: "muted", text: reason }));
}

// ---- result rendering (generic over the WQ item shape) ----------------------
function markersRow(markers) {
  if (!markers || !markers.length) return null;
  const row = el("div", { class: "markers" });
  markers.forEach((m) => row.appendChild(el("span", { class: "marker", text: m })));
  return row;
}
function problemsList(problems) {
  if (!problems || !problems.length) return null;
  const wrap = el("div");
  wrap.appendChild(el("h3", { text: `Problems (${problems.length})` }));
  const ul = el("ul", { class: "problems" });
  problems.forEach((p) => {
    const li = el("li");
    li.appendChild(el("span", { class: "cat", text: p.category }));
    li.appendChild(document.createTextNode(" " + (p.detail || "")));
    if (p.readiness_failed) li.appendChild(el("span", { class: "readiness", text: "READINESS FAILED" }));
    const ctx = p.context || {};
    const ck = Object.keys(ctx);
    if (ck.length) li.appendChild(el("div", { class: "ctx",
      text: ck.map((k) => `${k}=${ctx[k]}`).join("  ") }));
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  return wrap;
}
function itemsTable(items) {
  const cols = [];
  items.forEach((it) => Object.keys(it).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const table = el("table");
  const thead = el("tr");
  cols.forEach((c) => thead.appendChild(el("th", { text: c })));
  table.appendChild(el("thead", null, [thead]));
  const tbody = el("tbody");
  items.forEach((it) => {
    const tr = el("tr");
    cols.forEach((c) => {
      const td = el("td");
      const f = it[c];
      if (f && typeof f === "object" && "provenance" in f) {
        td.appendChild(document.createTextNode(renderValue(f.value)));
        td.appendChild(provBadge(f.provenance));
      } else { td.textContent = "—"; }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}
function metaLine(data) {
  return el("p", { class: "meta",
    text: `${data.query_id} · contract ${data.contract_version} · generated ${data.generated_at}` });
}
// Render a successful DTO, choosing empty vs data, always showing problems.
function renderResult(data) {
  const box = el("div");
  const legacyProblem = (data.problems || []).some((p) => p.category === "schema_unsupported");
  if (legacyProblem) box.appendChild(panel("legacy", "Legacy / unsupported schema",
    el("p", { text: "Some sources reported schema_unsupported (see problems below)." })));

  const mk = markersRow(data.markers);
  if (mk) box.appendChild(mk);

  if (!data.items || !data.items.length) {
    if (!data.problems || !data.problems.length) { box.appendChild(emptyPanel()); return box; }
  } else {
    const card = el("div", { class: "card" });
    card.appendChild(itemsTable(data.items));
    box.appendChild(card);
  }
  const probs = problemsList(data.problems);
  if (probs) box.appendChild(probs);
  box.appendChild(metaLine(data));
  return box;
}

// dispatch a query-client result to the right panel (fail-closed).
function renderInto(target, result, heading) {
  clear(target);
  if (heading) target.appendChild(el("h2", { text: heading }));
  if (result.kind === "error") { target.appendChild(errorPanel(result.envelope)); return; }
  if (result.kind === "legacy") { target.appendChild(legacyPanel(result.data)); return; }
  target.appendChild(renderResult(result.data));
}
// Render a query result body (no heading) with a custom renderer, keeping the
// fail-closed states (error / legacy) and always appending problems + meta.
function renderCustom(target, result, renderer) {
  if (result.kind === "error") { target.appendChild(errorPanel(result.envelope)); return; }
  if (result.kind === "legacy") { target.appendChild(legacyPanel(result.data)); return; }
  const data = result.data;
  const mk = markersRow(data.markers);
  if (mk) target.appendChild(mk);
  renderer(target, data);
  const probs = problemsList(data.problems);
  if (probs) target.appendChild(probs);
  target.appendChild(metaLine(data));
}

// ---- media viewer (lazy, containment-served, missing/broken aware) ----------
const _IMG_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
const _VID_EXT = [".mp4", ".webm", ".mov", ".m4v", ".ogv"];
function _ext(p) { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i).toLowerCase(); }

// Render one contained artifact file lazily. Large images / video are loaded on
// demand (loading=lazy / preload=none); a missing or unreadable file degrades to
// a visible "media unavailable" note instead of a broken silent gap. The src is
// always the local /artifact endpoint — never a private/temporary provider URL.
function mediaNode(path) {
  const url = Q.artifactUrl(path);
  const ext = _ext(path);
  const wrap = el("figure", { class: "media" });
  const fail = () => {
    clear(wrap);
    wrap.appendChild(unavailablePanel("Media unavailable",
      `Could not load ${path} (missing, unreadable, or outside containment).`));
  };
  let node;
  if (_IMG_EXT.includes(ext)) {
    node = el("img", { loading: "lazy", alt: path, src: url });
    node.addEventListener("error", fail);
  } else if (_VID_EXT.includes(ext)) {
    node = el("video", { controls: "", preload: "none", src: url });
    node.addEventListener("error", fail);
  } else {
    node = el("a", { href: url, text: "Open file (" + (ext || "binary") + ")" });
  }
  wrap.appendChild(node);
  wrap.appendChild(el("figcaption", { class: "muted", text: path }));
  return wrap;
}

// A read-only media viewer: paste a project-relative artifact path to view it.
// WFM1's query contract does not yet bind a lineage ref to a media path (that is
// a WFM2 extension, marked unavailable), so media is fetched by contained path.
function mediaViewer() {
  const box = el("div", { class: "card mediaviewer" });
  box.appendChild(el("h3", { text: "Artifact media viewer" }));
  box.appendChild(el("p", { class: "muted",
    text: "View a committed artifact by its project-relative path (served read-only " +
      "with path containment). Ref→media binding is a WFM2 contract extension." }));
  const input = el("input", { type: "text", class: "idinput",
    placeholder: "e.g. wfm1-demo/outputs/final_v1.mp4", "aria-label": "Artifact path" });
  const out = el("div", { class: "mediaout" });
  const go = el("button", { type: "button", text: "Load" });
  const load = () => {
    clear(out);
    const p = input.value.trim();
    if (!p) { out.appendChild(el("p", { class: "muted", text: "Enter a path." })); return; }
    out.appendChild(mediaNode(p));
  };
  go.addEventListener("click", load);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  const row = el("div", { class: "idform" });
  row.appendChild(input); row.appendChild(go);
  box.appendChild(row);
  box.appendChild(out);
  return box;
}

// A small table over a list of plain objects, with a single provenance badge.
function objTable(rows, cols, prov) {
  if (!rows.length) return el("p", { class: "muted", text: "—" });
  const table = el("table");
  const head = el("tr");
  cols.forEach((c) => head.appendChild(el("th", { text: c })));
  table.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  rows.forEach((r) => {
    const tr = el("tr");
    cols.forEach((c) => tr.appendChild(el("td", { text: renderValue(r[c]) })));
    body.appendChild(tr);
  });
  table.appendChild(body);
  const wrap = el("div");
  wrap.appendChild(table);
  if (prov) wrap.appendChild(el("div", { class: "provline" }, [provBadge(prov)]));
  return wrap;
}

// ---- deep-dive: prompt version chain (WQ-05) --------------------------------
// Renders each version as a card: the change basis (previous → this, reason),
// reference assets, generation packets, ALL settled results (candidates) beside
// the SELECTED (registered) results, downstream products, and an explicit
// unavailable note for image/audio/subtitle results (out of WFM1 scope).
// The added/removed elements between two lists, compared by value (strings by
// identity, objects by their JSON shape). Used to diff one prompt version's
// reference assets / generation packets against its parent version.
function _listDelta(prevVals, curVals) {
  const key = (x) => (typeof x === "string" ? x : JSON.stringify(x));
  const prevKeys = new Set((prevVals || []).map(key));
  const curKeys = new Set((curVals || []).map(key));
  return {
    added: (curVals || []).filter((x) => !prevKeys.has(key(x))),
    removed: (prevVals || []).filter((x) => !curKeys.has(key(x))),
  };
}

// One "field: +added / -removed" diff row, or null when nothing changed.
function _deltaRow(label, prevItem, curItem, fieldName) {
  const d = _listDelta(
    prevItem[fieldName] && prevItem[fieldName].value,
    curItem[fieldName] && curItem[fieldName].value,
  );
  if (!d.added.length && !d.removed.length) return null;
  const row = el("div", { class: "delta" });
  row.appendChild(el("span", { class: "delta-label", text: `${label}: ` }));
  d.added.forEach((x) =>
    row.appendChild(el("span", { class: "added", text: `+${renderValue(x)} ` })));
  d.removed.forEach((x) =>
    row.appendChild(el("span", { class: "removed", text: `-${renderValue(x)} ` })));
  return row;
}

function renderPromptHistory(target, data) {
  if (!data.items || !data.items.length) {
    if (!data.problems || !data.problems.length) target.appendChild(emptyPanel());
    return;
  }
  const byVersion = {};
  data.items.forEach((v) => {
    if (v.version) byVersion[v.version.value] = v;
  });
  data.items.forEach((v) => {
    const card = el("div", { class: "card version" });
    const ver = v.version && v.version.value;
    const prev = v.previous_version && v.previous_version.value;
    card.appendChild(el("h3", { text: `Version ${ver}` }));
    // the recorded diff basis: which version this was derived from, and why
    const basis = el("p", { class: "basis" });
    basis.appendChild(document.createTextNode(
      prev == null ? "Initial version — no parent. " : `Derived from v${prev}. `));
    if (v.change_reason && v.change_reason.value) {
      basis.appendChild(el("strong", { text: "Change reason: " }));
      basis.appendChild(document.createTextNode(String(v.change_reason.value)));
    } else {
      basis.appendChild(el("em", { text: "no change reason recorded" }));
    }
    card.appendChild(basis);

    // explicit version-to-version diff: what actually changed from the parent
    // (added/removed reference assets and generation packets). digest change
    // is shown too so an identical-input revision is distinguishable.
    const parent = prev != null ? byVersion[prev] : undefined;
    if (parent) {
      const diff = el("div", { class: "vdiff" });
      diff.appendChild(el("h4", { text: `Changes from v${prev}` }));
      let any = false;
      ["reference_assets", "generation_packets"].forEach((f) => {
        const row = _deltaRow(f.replace("_", " "), parent, v, f);
        if (row) { diff.appendChild(row); any = true; }
      });
      const pd = parent.digest && parent.digest.value;
      const cd = v.digest && v.digest.value;
      if (pd !== cd) {
        diff.appendChild(el("div", { class: "delta",
          text: `digest: ${pd} → ${cd}` }));
        any = true;
      }
      if (!any) {
        diff.appendChild(el("p", { class: "muted",
          text: "no reference-asset, packet or digest change from the parent" }));
      }
      card.appendChild(diff);
    }
    card.appendChild(field("digest", v.digest));
    card.appendChild(field("reference assets", v.reference_assets));
    card.appendChild(field("generation packets", v.generation_packets));

    // candidates vs selected, side by side (never conflated)
    const cols = el("div", { class: "cols" });
    const cand = el("div", { class: "col" });
    cand.appendChild(el("h4", { text: "All results (candidates)" }));
    cand.appendChild(objTable((v.all_results && v.all_results.value) || [],
      ["task_id", "operation_id", "status"], v.all_results && v.all_results.provenance));
    const sel = el("div", { class: "col" });
    sel.appendChild(el("h4", { text: "Selected (registered)" }));
    sel.appendChild(objTable((v.selected_results && v.selected_results.value) || [],
      ["asset_id", "version", "shot_id"], v.selected_results && v.selected_results.provenance));
    cols.appendChild(cand); cols.appendChild(sel);
    card.appendChild(cols);

    card.appendChild(field("downstream products", v.downstream_products));
    // image/audio/subtitle results are explicitly out of WFM1 scope
    if (v.image_audio_subtitle_results) {
      card.appendChild(unavailablePanel("Image / audio / subtitle results",
        String(v.image_audio_subtitle_results.value)));
    }
    target.appendChild(card);
  });
}

// ---- deep-dive: cost drilldown (WQ-07) + budget line (WQ-14) ----------------
// Every amount stays in its original currency; amounts of different currencies
// are shown in distinct columns and NEVER summed. JPY conversion and all rollups
// are labelled derived; per-operation original amounts are authoritative.
// A per-operation cost table with read-only client-side dimension filters
// (shot / provider / model / status / month). Each <select> narrows the
// already-loaded rows — never a re-query — so the authoritative facts are
// unchanged; a running count shows how many rows the current filter keeps.
// month is derived from the operation's occurred_at (WQ-07 v1.1).
function renderCostOperations(oc, ops) {
  const dims = [
    ["shot", (op) => op.shot_id],
    ["provider", (op) => op.provider_id],
    ["model", (op) => op.model_id],
    ["status", (op) => op.status],
    // JST month from the query (occurred_month), NOT sliced from the UTC
    // occurred_at string — so this filter agrees with the by_time / budget
    // monthly rollups, which also bucket in JST.
    ["month", (op) => op.occurred_month || null],
  ];
  const state = {};
  const bar = el("div", { class: "filters" });
  dims.forEach(([name, getter]) => {
    const values = Array.from(
      new Set(ops.map(getter).filter((v) => v != null && v !== "")),
    ).sort();
    if (!values.length) return;
    const sel = el("select");
    sel.setAttribute("aria-label", `Filter by ${name}`);
    sel.appendChild(el("option", { value: "" }, [`${name}: all`]));
    values.forEach((v) =>
      sel.appendChild(el("option", { value: String(v) }, [String(v)])));
    sel.addEventListener("change", () => { state[name] = sel.value; rerender(); });
    bar.appendChild(sel);
  });
  oc.appendChild(bar);

  const cols = ["task_id", "operation_id", "shot_id", "provider_id", "model_id",
    "status", "quote", "hold_estimate_jpy", "actual", "occurred_at"];
  const count = el("p", { class: "muted" });
  oc.appendChild(count);
  const table = el("table");
  const head = el("tr");
  cols.forEach((c) => head.appendChild(el("th", { text: c })));
  table.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  table.appendChild(body);
  oc.appendChild(table);

  const keep = (op) => dims.every(([name, getter]) => {
    const want = state[name];
    if (!want) return true;
    const val = getter(op);
    return String(val == null ? "" : val) === want;
  });
  function rerender() {
    clear(body);
    const shown = ops.filter(keep);
    shown.forEach((op) => {
      const tr = el("tr");
      const flagged = op.status && op.status !== "committed" && op.status !== "settled";
      if (flagged) tr.className = "flagged";
      const quote = op.quote_minor_units == null ? "—"
        : `${op.quote_minor_units} ${op.quote_currency || ""}`.trim();
      const actual = op.actual
        ? `${op.actual.cost_minor_units} ${op.actual.currency || ""}`.trim() : "—";
      const cells = [op.task_id, op.operation_id, op.shot_id, op.provider_id,
        op.model_id, op.status, quote,
        op.hold_estimate_jpy == null ? "—" : op.hold_estimate_jpy,
        actual, op.occurred_at || "—"];
      cells.forEach((c) => tr.appendChild(el("td", { text: renderValue(c) })));
      body.appendChild(tr);
    });
    count.textContent = `showing ${shown.length} of ${ops.length} operations`;
  }
  rerender();
}

function renderCost(target, costData, budgetResult) {
  const item = (costData.items && costData.items[0]) || {};
  // 1. budget line (WQ-14), if the budget query succeeded
  if (budgetResult) {
    const bl = el("div", { class: "card" });
    bl.appendChild(el("h3", { text: "Budget line" }));
    if (budgetResult.kind !== "ok") {
      bl.appendChild(budgetResult.kind === "legacy"
        ? legacyPanel(budgetResult.data) : errorPanel(budgetResult.envelope));
    } else {
      const bdata = budgetResult.data;
      const b = (bdata.items && bdata.items[0]) || {};
      ["budgets_jpy", "episode_committed_by_currency", "episode_committed_jpy",
        "episode_outstanding_holds_jpy", "monthly_remaining_jpy"].forEach((k) => {
        if (b[k]) bl.appendChild(field(k, b[k]));
      });
      // Budget markers/problems must stay visible too — a budget DTO with a
      // partial-failure problem is not trustworthy standing (fail-closed).
      const bmk = markersRow(bdata.markers);
      if (bmk) bl.appendChild(bmk);
      const bprobs = problemsList(bdata.problems);
      if (bprobs) bl.appendChild(bprobs);
      bl.appendChild(metaLine(bdata));
    }
    target.appendChild(bl);
  }

  // 2. quotes (estimate / P50 / P90) — authoritative within the packet
  const quotes = (item.quotes && item.quotes.value) || [];
  const qc = el("div", { class: "card" });
  qc.appendChild(el("h3", { text: "Quotes / estimates" }));
  qc.appendChild(objTable(quotes,
    ["shot_id", "quote_minor_units", "quote_currency", "estimate_jpy", "p50_jpy", "p90_jpy"],
    item.quotes && item.quotes.provenance));
  target.appendChild(qc);

  // 3. per-operation facts — quote / hold / actual kept distinct, with
  //    read-only client-side dimension filters. Filtering narrows the rows
  //    already loaded; it never re-queries, so the authoritative facts stay
  //    intact. Failed/retry/redo/fallback operations are flagged.
  const ops = (item.per_operation && item.per_operation.value) || [];
  const oc = el("div", { class: "card" });
  oc.appendChild(el("h3", { text: "Per-operation cost (quote / hold / actual kept distinct)" }));
  if (!ops.length) {
    oc.appendChild(el("p", { class: "muted", text: "—" }));
  } else {
    renderCostOperations(oc, ops);
    oc.appendChild(el("div", { class: "provline" },
      item.per_operation ? [provBadge(item.per_operation.provenance)] : []));
  }
  target.appendChild(oc);

  // 4. derived rollups by dimension — stage / step / shot / provider / model /
  //    time (WQ-07 v1.1). Each currency stays in its own column, never added
  //    together across currencies (cross-currency safety). by_time is keyed by
  //    JST calendar month so it lines up with the monthly budget line.
  [
    ["by_stage", "By stage"],
    ["by_step", "By step"],
    ["by_shot", "By shot"],
    ["by_provider", "By provider"],
    ["by_model", "By model"],
    ["by_time", "By month (JST)"],
  ].forEach(([dim, title]) => {
    const f = item[dim];
    if (!f) return;
    target.appendChild(dimTable(title, f.value || {}, f.provenance));
  });

  // 5. per-currency actual totals (derived aggregate) + derived JPY rollup
  if (item.actual_by_currency) {
    target.appendChild(dimTable("actual_by_currency (totals)",
      { total: item.actual_by_currency.value || {} }, item.actual_by_currency.provenance));
  }
  if (item.actual_total_jpy) {
    const j = el("div", { class: "card" });
    j.appendChild(el("h3", { text: "Actual total (JPY)" }));
    if (item.actual_total_jpy.provenance === "unavailable") {
      j.appendChild(unavailablePanel("JPY total unavailable",
        String(item.actual_total_jpy.value)));
    } else {
      j.appendChild(field("actual_total_jpy", item.actual_total_jpy));
      j.appendChild(el("p", { class: "muted",
        text: "Derived FX conversion of authoritative original-currency amounts." }));
    }
    target.appendChild(j);
  }
}
// One dimension rollup: rows = keys, columns = the currencies seen. Different
// currencies are distinct columns and are never summed into one figure.
function dimTable(title, byKey, prov) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", { text: title }));
  const currencies = [];
  Object.values(byKey).forEach((m) => Object.keys(m || {}).forEach((c) => {
    if (!currencies.includes(c)) currencies.push(c);
  }));
  currencies.sort();
  const keys = Object.keys(byKey).sort();
  if (!keys.length || !currencies.length) {
    card.appendChild(el("p", { class: "muted", text: "no actual-cost rollup yet" }));
    return card;
  }
  const table = el("table");
  const head = el("tr");
  head.appendChild(el("th", { text: "key" }));
  currencies.forEach((c) => head.appendChild(el("th", { text: c })));
  table.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  keys.forEach((k) => {
    const tr = el("tr");
    tr.appendChild(el("td", { text: k }));
    currencies.forEach((c) => {
      const amt = (byKey[k] || {})[c];
      tr.appendChild(el("td", { text: amt == null ? "—" : String(amt) }));
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  card.appendChild(table);
  card.appendChild(el("p", { class: "muted",
    text: "Amounts are per original currency and are never summed across currencies." }));
  if (prov) card.appendChild(el("div", { class: "provline" }, [provBadge(prov)]));
  return card;
}

// ---- navigation / routing ---------------------------------------------------
let PROJECTS = [];

function projectField(item, key) {
  const f = item && item[key];
  return f && typeof f === "object" ? renderValue(f.value) : null;
}

async function loadProjectNav() {
  const nav = document.getElementById("project-nav");
  const result = await Q.projects();
  clear(nav);
  if (result.kind === "error") { nav.appendChild(errorPanel(result.envelope)); return; }
  if (result.kind === "legacy") { nav.appendChild(legacyPanel(result.data)); return; }
  const data = result.data;
  PROJECTS = (data.items || []).map((it) => ({
    name: projectField(it, "project") || projectField(it, "name"),
    stage: projectField(it, "current_stage"),
  })).filter((p) => p.name);
  if (!PROJECTS.length) { nav.appendChild(emptyPanel()); }
  else {
    const ul = el("ul", { class: "nav-list" });
    PROJECTS.forEach((p) => {
      const a = el("a", { href: `#/p/${encodeURIComponent(p.name)}/plan` });
      a.appendChild(el("span", { text: p.name }));
      if (p.stage) a.appendChild(el("div", { class: "stage", text: p.stage }));
      a.dataset.project = p.name;
      ul.appendChild(el("li", null, [a]));
    });
    nav.appendChild(ul);
  }
  const probs = problemsList(data.problems);
  if (probs) nav.appendChild(probs);
}

function renderViewNav(name, current) {
  const nav = el("nav", { class: "viewnav", "aria-label": "Project views" });
  VIEWS.forEach(([v, label]) => {
    const a = el("a", { href: `#/p/${encodeURIComponent(name)}/${v}`, text: label });
    if (v === current) a.setAttribute("aria-current", "page");
    nav.appendChild(a);
  });
  return nav;
}

function markNav(name) {
  document.querySelectorAll("#project-nav a").forEach((a) => {
    if (a.dataset.project === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// A deep-dive identifier form: typing an id navigates to the id-bearing hash,
// so the deep-dive page is linkable and back/forward works. No form submission
// (CSP form-action 'none') — the button just updates the hash.
function deepDiveForm(name, view, id) {
  const spec = PARAM_VIEWS[view];
  const box = el("div", { class: "card idform-wrap" });
  box.appendChild(el("label", { class: "k", text: spec.label, for: "dd-input" }));
  const row = el("div", { class: "idform" });
  const input = el("input", { id: "dd-input", type: "text", class: "idinput",
    placeholder: spec.ph, value: id || "", "aria-label": spec.label });
  const go = el("button", { type: "button", text: "Go" });
  const nav = () => {
    const v = input.value.trim();
    location.hash = v
      ? `#/p/${encodeURIComponent(name)}/${view}/${encodeURIComponent(v)}`
      : `#/p/${encodeURIComponent(name)}/${view}`;
  };
  go.addEventListener("click", nav);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") nav(); });
  row.appendChild(input); row.appendChild(go);
  box.appendChild(row);
  return box;
}

// Render a param view (lineage / prompts / shots) for a given id.
async function renderParamView(region, name, view, id) {
  if (!id) {
    region.appendChild(el("p", { class: "muted", text: "Enter an identifier above to begin." }));
    if (view === "lineage") region.appendChild(mediaViewer());
    return;
  }
  region.appendChild(loadingPanel());
  if (view === "lineage") {
    const [up, down] = await Promise.all([
      Q.lineageUpstream(name, id), Q.lineageDownstream(name, id),
    ]);
    clear(region);
    region.appendChild(el("h3", { text: "Upstream (sources) — WQ-03" }));
    const upBox = el("div"); renderInto(upBox, up, ""); region.appendChild(upBox);
    region.appendChild(el("h3", { text: "Downstream (direct consumers) — WQ-04" }));
    const dnBox = el("div"); renderInto(dnBox, down, ""); region.appendChild(dnBox);
    region.appendChild(mediaViewer());
    return;
  }
  const result = view === "prompts"
    ? await Q.promptHistory(name, id) : await Q.shotAttempts(name, id);
  clear(region);
  if (view === "prompts") { renderCustom(region, result, renderPromptHistory); }
  else { renderInto(region, result, ""); }
}

// Monotonic navigation token: a response that finishes after the user has
// navigated again must not render into the shared `main` region (the newer
// navigation owns it — a stale portfolio response would otherwise overwrite
// the active project view with content inconsistent with the URL).
let _navToken = 0;

async function route() {
  const token = ++_navToken;
  const main = document.getElementById("main");
  const hash = location.hash.replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean); // ["p", name, view, id?]
  if (parts[0] !== "p" || !parts[1]) {
    clear(main);
    main.appendChild(loadingPanel());
    const r = await Q.projects();
    if (token !== _navToken) return; // superseded by a newer navigation
    renderInto(main, r, "Portfolio");
    markNav(null);
    return;
  }
  const name = decodeURIComponent(parts[1]);
  const view = VIEWS.some(([v]) => v === parts[2]) ? parts[2] : "plan";
  const id = parts[3] ? decodeURIComponent(parts[3]) : "";
  clear(main);
  main.appendChild(el("h2", { text: name }));
  main.appendChild(renderViewNav(name, view));
  const region = el("div");
  main.appendChild(region);
  markNav(name);

  if (PARAM_VIEWS[view]) {
    region.appendChild(deepDiveForm(name, view, id));
    const out = el("div");
    region.appendChild(out);
    await renderParamView(out, name, view, id);
    main.focus();
    return;
  }
  region.appendChild(loadingPanel());
  if (view === "cost") {
    const [cost, budget] = await Promise.all([Q.view(name, "cost"), Q.view(name, "budget")]);
    clear(region);
    region.appendChild(el("h2", { text: "Cost" }));
    // renderCustom keeps the fail-closed states and always surfaces the cost
    // DTO's markers + problems — a partial failure must not look trustworthy.
    renderCustom(region, cost, (t, data) => renderCost(t, data, budget));
    main.focus();
    return;
  }
  const result = await Q.view(name, view);
  const label = (VIEWS.find(([v]) => v === view) || [view, view])[1];
  clear(region);
  renderInto(region, result, label);
  main.focus();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", async () => {
  await loadProjectNav();
  await route();
});
