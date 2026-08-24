// 分镜表格视图 (TASK-078 §2.2/§2.3) — the whole shot list as ONE table you can
// work across horizontally.
//
// WHY. The card view answers 「这一个镜头是什么」. It cannot answer 「这 60 个镜头
// 的节奏对不对」「景别是不是全撞了」「哪几镜没写运镜」, because it shows one shot at
// a time. Those are the questions that stand between a settled shot list and the
// first generated picture, so they get a surface where every row is visible at
// once.
//
// STRICT view over the SAME state as the card view. Shots live on the scriptgen
// draft; an edit here buffers locally and commits through `ctx.shots.saveEdit`,
// which appends a NEW immutable draft version — the identical write path the
// detail editor uses. No second write path, no in-place mutation, no new
// document. `sfx` is pulled READ-ONLY from the audio workspace's document: this
// table displays it, it does not take ownership of it.
//
// The model is pure and exported for tests; only `bindShotTable` touches the DOM.

import { esc } from "../util/dom.js";
import { buildEntityIndex, findMentions, assetReadiness } from "../workflow/shotentity.js";
import { clipsOf } from "../workflow/shotaudio.js";
import { groupShotsByScene, sceneLabel, sceneCoverage, TIME_OF_DAY_HINTS } from "../workflow/sceneplan.js";

// NOTE ON DEPENDENCIES. `shotDetailModel` (the ONE prompt compiler) and
// `buildPortraitIndex` (「这个实体有参考图吗」) both live in `ui/storyboard.js`, and
// that module renders this one — so they are INJECTED rather than imported. Not
// style: importing them here would make storyboard ⇄ shottable a cycle, and the
// injection also stops a test from quietly substituting a second, simpler prompt
// compiler for the real one.

/** Row colour marks. `""` is 「无标记」 and is stored by OMITTING the field, so a
 *  project that never used them carries no new bytes (additive-field rule,
 *  AGENTS.md 第 13 条). */
export const ROW_COLORS = [
  ["", "无标记"],
  ["red", "🔴 待重写"],
  ["amber", "🟡 待确认"],
  ["green", "🟢 已定"],
  ["blue", "🔵 参考已备"],
  ["violet", "🟣 特殊处理"],
];
const COLOR_KEYS = new Set(ROW_COLORS.map(([k]) => k).filter(Boolean));

/** The columns, in the order the card specifies. `edit` names the draft-shot
 *  field an in-place edit writes; a column without one is derived or owned
 *  elsewhere and is therefore read-only HERE. */
export const COLUMNS = [
  { key: "seq", label: "镜号" },
  { key: "duration", label: "时长", edit: "duration" },
  { key: "description", label: "画面描述", edit: "description" },
  { key: "shotSize", label: "景别", edit: "shotSize" },
  { key: "lighting", label: "光影氛围", edit: "lighting" },
  { key: "dialogue", label: "台词", edit: "dialogue" },
  // 「要什么」与「有什么」并排：`sfxNote` 是创作者写下的需求（可编辑），
  // `sfx` 是这一镜现在有几条音效片段（只读，归音频工作区所有）。
  // 以前只有后者，于是逐镜质检问「这一镜要不要做音效」时无从答起
  // （TASK-087 §3.5.2）。
  { key: "sfxNote", label: "音效需求", edit: "sfxNote" },
  { key: "sfx", label: "音效" },
  { key: "cameraMotion", label: "运镜", edit: "cameraMotion" },
  { key: "prompt", label: "提示词" },
  { key: "ops", label: "操作" },
];

/** Text fields an in-place cell edit may write. `duration` is handled apart
 *  (it is a number with two legal values) and `description` too (it carries the
 *  entity links, so it has a read view). */
const TEXT_FIELDS = ["shotSize", "lighting", "dialogue", "sfxNote", "cameraMotion"];

/** Every draft-shot field this table can change, for the save path. */
export const EDITABLE_FIELDS = ["description", ...TEXT_FIELDS, "color"];

const str = (x) => (typeof x === "string" ? x : "");

/** How many audio clips this shot has on the `sfx` track. READ-ONLY — writing
 *  audio stays in 音频工作区 (`workflow/shotaudio.js` owns it). */
function sfxCount(shotAudio, shotId) {
  if (!shotAudio || typeof shotAudio !== "object" || !shotId) return 0;
  try {
    return clipsOf(shotAudio, shotId).filter((c) => c && c.trackType === "sfx").length;
  } catch {
    // a document shape this build does not understand states nothing rather
    // than taking the whole table down with it
    return 0;
  }
}

/**
 * The description, split into plain runs and ENTITY MENTIONS.
 *
 * Returns `[{ text }, { text, entity }]` parts in order, so the renderer builds
 * links without re-running recognition and a test can assert on the structure
 * rather than on HTML.
 */
export function describeParts(index, text) {
  const src = str(text);
  const parts = [];
  let at = 0;
  for (const m of findMentions(index, src)) {
    if (m.start > at) parts.push({ text: src.slice(at, m.start) });
    parts.push({ text: src.slice(m.start, m.end), entity: m.entity });
    at = m.end;
  }
  if (at < src.length) parts.push({ text: src.slice(at) });
  return parts;
}

/**
 * The table model.
 *
 * `shots` is the project-level draft (`pd.draftShots`) — the same list the
 * three-step wizard counts over, deliberately, so 「准备资产 N/M」 cannot read
 * differently in two places (§2.3.3).
 *
 * `buffer` / `deleted` are the shell's TRANSIENT edit state; nothing here is
 * persisted until 保存为新草稿版本.
 */
export function shotTableModel(pd, { buffer = {}, deleted = [], detailOf, portraitFor, recycled = [] } = {}) {
  const shots = Array.isArray(pd && pd.draftShots) ? pd.draftShots : [];
  const prod = pd && pd.production;
  const index = buildEntityIndex(prod);
  const detail0 = typeof detailOf === "function" ? detailOf : () => null;
  const portrait = typeof portraitFor === "function" ? portraitFor : () => "";
  const gone = new Set(deleted);
  // THE SHOTS AS THE CREATOR HAS THEM RIGHT NOW — committed draft ⊕ unsaved
  // buffer (codex round 1, P2). Deletions are NOT applied: a row marked for
  // deletion is still on screen and still needs its prompt column, and readiness
  // filters it separately below. Everything downstream that must reflect a
  // pending edit — the compiled prompt, its gap count, 准备资产 N/M — reads THIS
  // list, so the table cannot show a row's new description beside the old
  // description's gap count.
  const buffered = applyTableEdits(shots, { buffer });
  const rows = shots.map((s, i) => {
    const shotId = s && typeof s.shotId === "string" ? s.shotId : null;
    // EVERY CELL READS THE SAME EFFECTIVE VALUE THE SAVE WILL WRITE (codex
    // round 2, P1). The row used to merge the buffer itself, field by field, and
    // 时长 was simply missing from that list — so changing a duration and then
    // triggering any re-render put the OLD duration back on screen while 保存
    // still committed the new one. A change the creator cannot see is a change
    // they cannot refuse.
    //
    // The fix is the class, not the one field: there is now exactly ONE function
    // that says what a buffered edit means (`applyTableEdits`), and the cells are
    // rendered from its output. A field added to the buffer in future cannot go
    // missing from this list, because there is no list.
    const eff = buffered[i] || s || {};
    const description = str(eff.description);
    // ONE compiler (ui/storyboard.js shotDetailModel). Compiling a second,
    // simpler prompt here to save a call is exactly the drift this codebase
    // keeps paying for: the column would then report a gap count for a prompt
    // nobody ever sends. Compiled against the BUFFERED draft, so filling 运镜 in
    // this row drops its gap count immediately rather than after a save.
    const detail = shotId ? detail0(shotId, buffered) : null;
    const image = detail ? detail.prompts.image : null;
    return {
      shotId,
      seq: typeof eff.sequence === "number" ? eff.sequence : i + 1,
      title: str(eff.title),
      duration: eff.duration_seconds === 10 ? 10 : 6,
      description,
      descriptionParts: describeParts(index, description),
      shotSize: str(eff.shotSize),
      lighting: str(eff.lighting),
      dialogue: str(eff.dialogue),
      sfxNote: str(eff.sfxNote),
      cameraMotion: str(eff.cameraMotion),
      color: str(eff.color),
      sfx: sfxCount(pd && pd.shotAudio, shotId),
      prompt: image
        ? { head: image.text.split("\n")[0] || "", gaps: image.missing.length }
        : null,
      hasImage: !!(detail && detail.images.list.some((r) => r.current)),
      hasVideo: !!(detail && detail.videos.list.some((r) => r.current)),
      deleted: !!(shotId && gone.has(shotId)),
    };
  });
  // Readiness is computed over the shots AS BUFFERED: a name the creator just
  // typed into a description is part of what this list needs, and reporting the
  // pre-edit number would contradict the row directly above it.
  const readiness = assetReadiness({
    index,
    shots: buffered.filter((s) => !(s && gone.has(s.shotId))),
    hasReferenceImage: (kind, id) => !!portrait(kind, id),
  });
  // SCENE GROUPING (TASK-095 §2.1.1) — 派生自 `production` 里 scene 的 `shotIds`，
  // 不在 shot 上存 sceneId。分组行本身迫使 Scene 存在，所以这也是 GAP-13
  // （真实项目 48 集全部 0 场景）的修法。
  const episodeId = prod && typeof prod.activeEpisodeId === "string" ? prod.activeEpisodeId : null;
  const byId = new Map(rows.map((r) => [r.shotId, r]));
  const groups = groupShotsByScene({ prod, episodeId, shots: buffered }).map((g) => ({
    ...g,
    label: sceneLabel(g),
    rows: g.shots.map((sh) => byId.get(sh && sh.shotId)).filter(Boolean),
  }));
  const unassignedGroup = groups.find((g) => g.unassigned) || null;
  return {
    rows,
    groups,
    // 归入场景需要知道「哪一集」与「哪些镜头」。**从模型里取，不让 bind 再算一遍**
    // （§2.5e：两处陈述同一件事实）。
    episodeId,
    unassignedShotIds: unassignedGroup
      ? unassignedGroup.rows.map((r) => r.shotId).filter(Boolean)
      : [],
    // 回收区（软删除的镜头）。它们**不在** `pd.draftShots` 里 —— 那份镜像只给存活的
    // （见 `workflow/shotdelete.js` 文件头），所以由调用方注入，不在这里重新过滤：
    // 重新过滤就会变成第二处「什么算已删除」的定义（§2.5e）。
    recycled: (Array.isArray(recycled) ? recycled : [])
      .filter((sh) => sh && typeof sh === "object")
      .map((sh, i) => ({
        shotId: typeof sh.shotId === "string" ? sh.shotId : "",
        title: str(sh.title),
        seq: typeof sh.sequence === "number" ? sh.sequence : i + 1,
        at: (sh.deleted && typeof sh.deleted.at === "string") ? sh.deleted.at : "",
      })),
    // 「N 个镜头还没分到场景」是**待办**，不是阻塞（§2.5f 第二条）——
    // 第 ① 步正是做这件事的地方，拦住它等于拦住它请创作者做的事。
    coverage: sceneCoverage({ prod, episodeId, shots: buffered }),
    readiness,
    total: rows.length,
    deletedCount: rows.filter((r) => r.deleted).length,
    // WHETHER THERE IS ANYTHING TO SAVE IS A PROPERTY OF THE STATE, NOT OF THE
    // LAST KEYSTROKE (codex round 1, P1). The bar used to read `ui.tableDirty`,
    // which only `bindShotTable`'s input handlers ever wrote — so deleting a row
    // re-rendered with a stale `false` and left 保存 disabled. A deletion could
    // therefore never be committed at all. Derived here, where the shots, the
    // buffer and the deletion set all are.
    dirty: tableDirty(shots, { buffer, deleted }),
    // how many rows have nothing in a facet — the reason to have a table at all
    gaps: {
      shotSize: rows.filter((r) => !r.deleted && !r.shotSize).length,
      lighting: rows.filter((r) => !r.deleted && !r.lighting).length,
      cameraMotion: rows.filter((r) => !r.deleted && !r.cameraMotion).length,
    },
  };
}

/** Apply the buffered edits and deletions to the draft, producing the item list
 *  `ctx.shots.saveEdit` turns into a NEW version. Pure and exported: the save
 *  handler must be testable without a DOM.
 *
 *  A field edited to blank REMOVES the key rather than storing `""` — the same
 *  additive-field posture `normalizeShots` takes, so 「清空景别」 and 「从来没填过
 *  景别」 persist identically instead of as two indistinguishable-but-different
 *  shapes. */
export function applyTableEdits(shots, { buffer = {}, deleted = [], at = null } = {}) {
  const gone = new Set(deleted);
  // 删除是**软删除**（AGENTS.md 第 13 条 / TASK-095 §2.1）：打标记，不从列表里抹掉。
  // 没有时间戳就不打标记，而且**不静默跳过** —— 一条删除被悄悄忽略，创作者会以为
  // 删掉了，而下一次保存又把它带回来。
  const when = typeof at === "string" ? at.trim() : "";
  if (gone.size && !when) {
    throw new Error("applyTableEdits: 软删除需要一个时间戳（at），否则删除会被静默丢弃");
  }
  return (Array.isArray(shots) ? shots : [])
    .map((s) => {
      const out = { ...s };
      const shotId = s && typeof s.shotId === "string" ? s.shotId : null;
      const buf = (shotId && buffer[shotId]) || {};
      for (const k of EDITABLE_FIELDS) {
        if (!(k in buf)) continue;
        const v = str(buf[k]).trim();
        if (k === "color" && v && !COLOR_KEYS.has(v)) continue; // never store an unknown mark
        if (v) out[k] = v;
        else delete out[k];
      }
      if ("duration" in buf) out.duration_seconds = +buf.duration === 10 ? 10 : 6;
      if (shotId && gone.has(shotId)) out.deleted = { at: when };
      return out;
    });
}

/** Is there anything to save? A buffer entry equal to the committed value is
 *  NOT a change — otherwise clicking into a cell and out again would arm 保存
 *  and mint an identical version. */
export function tableDirty(shots, { buffer = {}, deleted = [] } = {}) {
  if (deleted.length) return true;
  for (const s of Array.isArray(shots) ? shots : []) {
    const shotId = s && typeof s.shotId === "string" ? s.shotId : null;
    const buf = (shotId && buffer[shotId]) || {};
    for (const k of EDITABLE_FIELDS) {
      if (k in buf && str(buf[k]).trim() !== str(s[k]).trim()) return true;
    }
    if ("duration" in buf && (+buf.duration === 10 ? 10 : 6) !== (s.duration_seconds === 10 ? 10 : 6)) return true;
  }
  return false;
}

// ---------- render --------------------------------------------------------- //

function descCell(r, editing) {
  if (editing) {
    return (
      `<textarea class="sbt-area" rows="3" spellcheck="false" ` +
      `data-tf="description" data-shot="${esc(r.shotId || "")}">${esc(r.description)}</textarea>`
    );
  }
  if (!r.description) {
    return `<button class="sbt-fill" data-tedit="${esc(r.shotId || "")}">未填写 · 去填写</button>`;
  }
  const body = r.descriptionParts
    .map((p) => (p.entity
      ? `<button class="sbt-ent" data-ent-kind="${esc(p.entity.kind)}" data-ent-id="${esc(p.entity.id)}" ` +
        `title="${esc(p.entity.kind === "character" ? "人物" : "场景地")}：${esc(p.entity.name)}">${esc(p.text)}</button>`
      : esc(p.text)))
    .join("");
  return `<div class="sbt-desc" data-tedit="${esc(r.shotId || "")}">${body}</div>`;
}

function textCell(r, field, placeholder, focus) {
  const on = focus && focus.shotId === r.shotId && focus.field === field;
  return (
    `<input class="sbt-in${on ? " sbt-focus" : ""}" data-tf="${esc(field)}" data-shot="${esc(r.shotId || "")}" ` +
    `maxlength="200" placeholder="${esc(placeholder)}" value="${esc(r[field])}">`
  );
}

function promptCell(r) {
  if (!r.prompt) return `<span class="sbt-mute">身份未解析</span>`;
  return (
    `<button class="sbt-prompt" data-topen="${esc(r.shotId || "")}" title="${esc(r.prompt.head)}">` +
    `<span class="sbt-ptext">${esc(r.prompt.head || "（空）")}</span>` +
    (r.prompt.gaps
      ? `<span class="chip gate">缺 ${r.prompt.gaps}</span>`
      : `<span class="chip ok">无缺口</span>`) +
    `</button>`
  );
}

/** 分组行。**一行字就是 `S01 ｜ 便利店外 ｜ 夜`**，缺的段落整段省略（sceneLabel）。
 *
 *  时间就地可改（自由文本 + datalist 建议）。「未分配到场景」那一组给的是**动作**：
 *  新建场景、或把镜头放进已有场景 —— 否则真实项目里那 60 个镜头永远出不来。 */
function sceneRow(g, span, collapsed, sceneOptions) {
  const cells = g.unassigned
    ? `<span class="sbt-scname">${esc(g.label)}</span>` +
      `<span class="sbt-note">这些镜头还没归到任何场景 —— 场景决定它们复用哪一套场景图</span>` +
      `<button class="sbt-mini" data-scnew="1">＋ 新建场景并放入</button>` +
      (sceneOptions.length
        ? `<select class="sbt-in sbt-scpick" data-scmove="1">` +
          `<option value="">放入已有场景…</option>` +
          sceneOptions.map((o) => `<option value="${esc(o.sceneId)}">${esc(o.label)}</option>`).join("") +
          `</select>`
        : "")
    : `<span class="sbt-scname">${esc(g.label)}</span>` +
      `<span class="sbt-note">${g.rows.length} 镜</span>` +
      `<label class="sbt-sctime">时间 <input class="sbt-in" list="sbt-tod" data-sctime="${esc(g.sceneId)}" ` +
      `maxlength="40" placeholder="未填（不猜）" value="${esc(g.timeOfDay)}"></label>`;
  return (
    `<tr class="sbt-scene${g.unassigned ? " un" : ""}" data-scrow="${esc(g.sceneId || "")}">` +
    `<td colspan="${span}"><button class="sbt-sctoggle" data-sctoggle="${esc(g.sceneId || "*none*")}" ` +
    `title="折叠 / 展开">${collapsed ? "▶" : "▼"}</button>${cells}</td></tr>`
  );
}

/** The whole table. `ui` carries { tbuf, tdel, tableEdit } — transient only. */
export function renderShotTable(ctx, m, ui) {
  const editing = ui.tableEdit || null;
  // where 「未填 · 去填写」 sent the creator, if anywhere
  const focus = ui.tableFocus && ui.tableFocus.shotId ? ui.tableFocus : null;
  const colorOf = (r) => (r.color ? ` sbt-c-${esc(r.color)}` : "");
  const head = COLUMNS.map((c) => `<th class="sbt-h-${esc(c.key)}">${esc(c.label)}</th>`).join("");
  const collapsedSet = new Set(ui.sceneCollapsed || []);
  const sceneOptions = m.groups
    .filter((g) => !g.unassigned)
    .map((g) => ({ sceneId: g.sceneId, label: g.label }));
  const renderRow = (r) => {
    const del = r.deleted;
    return (
      `<tr class="sbt-row${colorOf(r)}${del ? " sbt-del" : ""}" data-trow="${esc(r.shotId || "")}">` +
      `<td class="sbt-seq"><span class="mono">${esc(String(r.seq).padStart(2, "0"))}</span>` +
      (r.hasImage ? `<span class="chip ok" title="已有画面">🖼</span>` : "") +
      (r.hasVideo ? `<span class="chip ok" title="已有视频">🎬</span>` : "") +
      `<div class="sbt-title">${esc(r.title)}</div></td>` +
      `<td><select class="sbt-in" data-tf="duration" data-shot="${esc(r.shotId || "")}">` +
      `<option value="6"${r.duration === 10 ? "" : " selected"}>6s</option>` +
      `<option value="10"${r.duration === 10 ? " selected" : ""}>10s</option></select></td>` +
      `<td class="sbt-descc">${descCell(r, editing === r.shotId)}</td>` +
      `<td>${textCell(r, "shotSize", "如 中近景", focus)}</td>` +
      `<td>${textCell(r, "lighting", "如 冷白顶光", focus)}</td>` +
      `<td>${textCell(r, "dialogue", "如 「你是谁？」", focus)}</td>` +
      `<td>${textCell(r, "sfxNote", "如 「雨声、远处雷」", focus)}</td>` +
      `<td class="sbt-sfx">` +
      (r.sfx
        ? `<span class="chip ok">${r.sfx}</span>`
        : `<span class="sbt-mute">—</span>`) +
      `<button class="sbt-mini" data-goto="audio" title="音效归音频工作区所有，这里只读">编辑…</button></td>` +
      `<td>${textCell(r, "cameraMotion", "如 缓慢推近", focus)}</td>` +
      `<td class="sbt-promptc">${promptCell(r)}</td>` +
      `<td class="sbt-ops">` +
      `<select class="sbt-in sbt-color" data-tf="color" data-shot="${esc(r.shotId || "")}" title="颜色标记">` +
      ROW_COLORS.map(([k, label]) =>
        `<option value="${esc(k)}"${r.color === k ? " selected" : ""}>${esc(label)}</option>`).join("") +
      `</select>` +
      (del
        ? `<button class="sbt-mini" data-tundel="${esc(r.shotId || "")}">撤销删除</button>`
        : `<button class="sbt-mini sbt-danger" data-tdel="${esc(r.shotId || "")}">删除</button>`) +
      `</td></tr>`
    );
  };
  // GROUPED BODY. 每一组一行组头 + 它的镜头行；组头可折叠（60 镜的表非折不可）。
  const rows = m.groups.map((g) => {
    const key = g.sceneId || "*none*";
    const collapsed = collapsedSet.has(key);
    return sceneRow(g, COLUMNS.length, collapsed, sceneOptions) +
      (collapsed ? "" : g.rows.map(renderRow).join(""));
  }).join("");

  const rd = m.readiness;
  // The two questions this bar answers, and it says WHICH is which — 参考统筹
  // counts BINDINGS PER SHOT, this counts ENTITIES WITH A REFERENCE IMAGE. They
  // are different questions and printing one number as if it were both is how
  // 「没有缺口」 ended up on a project with nothing bound (§2.3.4).
  const bar =
    `<div class="sbt-bar">` +
    `<span class="sbt-stat${rd.total && rd.ready === rd.total ? " ok" : ""}">准备资产 ${rd.ready}/${rd.total}</span>` +
    `<span class="sbt-note">画面描述里被点到的人物 / 场景地共 ${rd.total} 个，其中 ${rd.ready} 个已有参考图` +
    (rd.missing.length ? `；还差：${esc(rd.missing.slice(0, 6).map((e) => e.name).join("、"))}${rd.missing.length > 6 ? " 等" : ""}` : "") +
    `</span>` +
    `<span class="sbt-note">缺景别 ${m.gaps.shotSize} · 缺光影 ${m.gaps.lighting} · 缺运镜 ${m.gaps.cameraMotion}</span>` +
    // 场景覆盖是**待办**，不是阻塞 —— 说清还差什么，不拦（§2.5f 第二条）
    (m.coverage.todo.length
      ? `<span class="sbt-note">${esc(m.coverage.todo.join(" · "))}</span>`
      : `<span class="sbt-stat ok">${m.coverage.scenes} 个场景都已分好</span>`) +
    `</div>`;

  const dirty = m.dirty;
  // The bar is rendered from `m.dirty` AND updated in place while typing (see
  // `bindShotTable`), because a re-render per keystroke would move the caret out
  // of the cell being typed in. Both chips carry a marker so the live update can
  // reach them without re-rendering.
  const savebar =
    `<div class="sbt-save">` +
    `<span class="chip gate" data-tflag${dirty ? "" : " hidden"}>已修改（未保存为版本）</span>` +
    `<span class="chip mute" data-tclean${dirty ? " hidden" : ""}>与草稿版本一致</span>` +
    (m.deletedCount ? `<span class="chip bad">${m.deletedCount} 行将被删除</span>` : "") +
    `<button class="btn primary sm" data-tsave${dirty ? "" : " disabled"}>保存为新草稿版本</button>` +
    `<button class="btn sm" data-tdiscard${dirty ? "" : " hidden"}>放弃修改</button>` +
    `</div>`;

  // 回收区（AGENTS.md 第 13 条）。**默认折叠、空则不出现** —— 一个永远显示
  // 「回收区（0）」的区块只是噪音。撤销是立即的：软删除本来就为了它存在。
  const recycled = Array.isArray(m.recycled) ? m.recycled : [];
  const recycleBox = recycled.length
    ? `<details class="sbt-recycle"><summary>回收区（${recycled.length}）—— 删除的镜头留在这里，可随时撤销</summary>` +
      `<ul>` + recycled.map((r) =>
        `<li><span class="mono">${esc(String(r.seq).padStart(2, "0"))}</span> ` +
        `<b>${esc(r.title || r.shotId || "")}</b>` +
        `<span class="sbt-note">删除于 ${esc(r.at || "")}</span>` +
        `<button class="sbt-mini" data-trestore="${esc(r.shotId || "")}">撤销删除</button></li>`).join("") +
      `</ul></details>`
    : "";

  return (
    bar + savebar +
    `<datalist id="sbt-tod">` +
    TIME_OF_DAY_HINTS.map((t) => `<option value="${esc(t)}"></option>`).join("") +
    `</datalist>` +
    `<div class="sbt-wrap"><table class="sbt"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` +
    recycleBox
  );
}

/**
 * Wire the table.
 *
 * Text cells buffer on `oninput` WITHOUT a re-render (a re-render per keystroke
 * moves the caret out of the field being typed in — the same reason the detail
 * editor syncs its bar by hand). The description cell is the exception: it has a
 * read view carrying entity links, so entering and leaving it re-renders once.
 */
export function bindShotTable(root, ctx, ui, rerender, m = null) {
  const buf = ui.tbuf || (ui.tbuf = {});
  const del = ui.tdel || (ui.tdel = []);
  const shotsNow = () => (ctx.prodData().draftShots || []);
  const put = (shotId, field, value) => {
    if (!shotId) return;
    if (!buf[shotId]) buf[shotId] = {};
    buf[shotId][field] = value;
  };
  // Reflect the CURRENT dirty state on the bar without a re-render — typing must
  // not move the caret. Every control the bar owns is updated, not just 保存:
  // a stale 「与草稿版本一致」 next to an enabled 保存 tells the creator their edit
  // was not registered.
  const syncBar = () => {
    const dirty = tableDirty(shotsNow(), { buffer: buf, deleted: del });
    const save = root.querySelector("[data-tsave]");
    const discard = root.querySelector("[data-tdiscard]");
    const flag = root.querySelector("[data-tflag]");
    const clean = root.querySelector("[data-tclean]");
    if (save) {
      if (dirty) save.removeAttribute("disabled");
      else save.setAttribute("disabled", "");
    }
    if (discard) discard.hidden = !dirty;
    if (flag) flag.hidden = !dirty;
    if (clean) clean.hidden = dirty;
  };

  root.querySelectorAll("[data-tf]").forEach((el) => {
    const shotId = el.dataset.shot;
    const field = el.dataset.tf;
    el.oninput = () => { put(shotId, field, el.value); syncBar(); };
    if (el.tagName === "SELECT") el.onchange = () => { put(shotId, field, el.value); syncBar(); };
    // leaving the description textarea returns the cell to its linked read view
    if (field === "description") {
      el.onblur = () => { ui.tableEdit = null; rerender(); };
      el.onkeydown = (e) => {
        if (e.key === "Escape") { ui.tableEdit = null; rerender(); }
      };
    }
  });

  root.querySelectorAll("[data-tedit]").forEach((el) => (el.onclick = () => {
    ui.tableEdit = el.dataset.tedit;
    rerender();
  }));

  // The entity links themselves are wired by the SHELL (`ui/production.js`),
  // beside `[data-goto]`: opening 林照's card means switching page, section and
  // drawer, which is a shell decision. Wiring it here too would attach two
  // handlers to one button, and the later one would silently win.

  root.querySelectorAll("[data-topen]").forEach((el) => (el.onclick = () => {
    ui.tableView = false;
    ui.selectedShotId = el.dataset.topen;
    rerender();
  }));

  // --- 分组行：折叠 / 场景时间 / 归入场景（TASK-095 §2.1.1–2.1.2） -------------- //
  //
  // 这些**不是**表格 buffer 的一部分：场景归属与场景时间住在 production 文档里，
  // 由 `ctx.production` 的写路径落盘；镜头字段住在草稿版本里，由「保存为新草稿版本」
  // 落盘。两者混进同一个 buffer 会让「保存」这个词在同一屏上指两件事。
  root.querySelectorAll("[data-sctoggle]").forEach((el) => (el.onclick = () => {
    const key = el.dataset.sctoggle;
    const set = new Set(ui.sceneCollapsed || []);
    if (set.has(key)) set.delete(key); else set.add(key);
    ui.sceneCollapsed = [...set];
    rerender();
  }));
  root.querySelectorAll("[data-sctime]").forEach((el) => (el.onchange = () => {
    const sceneId = el.dataset.sctime;
    if (!sceneId) return;
    // 空值是**清空**，不是「没提交」—— 写路径把它落成「删字段」
    ctx.production.setSceneTimeOfDay(sceneId, el.value);
    rerender();
  }));
  const unassignedIds = () => (m && Array.isArray(m.unassignedShotIds) ? m.unassignedShotIds : []);
  const newScene = root.querySelector("[data-scnew]");
  if (newScene) newScene.onclick = () => {
    const ids = unassignedIds();
    if (!ids.length) return;
    const episodeId = m && m.episodeId;
    if (!episodeId) { ctx.toast("先选一集 —— 场景属于某一集"); return; }
    const title = window.prompt("新场景名（例：便利店外）", "");
    if (title == null || !title.trim()) return;
    const scene = ctx.production.addScene(episodeId, title.trim());
    if (!scene) { ctx.toast("没能创建场景"); return; }
    for (const id of ids) ctx.production.assignShot(scene.sceneId, id);
    ctx.toast(`已创建场景并放入 ${ids.length} 个镜头 —— 记得填时间（白天 / 夜）`);
    rerender();
  };
  const movePick = root.querySelector("[data-scmove]");
  if (movePick) movePick.onchange = () => {
    const sceneId = movePick.value;
    if (!sceneId) return;
    const ids = unassignedIds();
    for (const id of ids) ctx.production.assignShot(sceneId, id);
    ctx.toast(`已把 ${ids.length} 个镜头放入该场景`);
    rerender();
  };

  // 回收区：撤销删除是**立即**的（软删除本来就是为它存在的）
  root.querySelectorAll("[data-trestore]").forEach((el) => (el.onclick = () => {
    const id = el.dataset.trestore;
    if (!id) return;
    if (ctx.shots.restoreDeleted(id)) {
      ctx.toast("已撤销删除 —— 镜头回到它原来的位置");
      rerender();
    } else {
      ctx.toast("没能撤销 —— 这个镜头不在回收区");
    }
  }));

  root.querySelectorAll("[data-tdel]").forEach((el) => (el.onclick = () => {
    const id = el.dataset.tdel;
    if (id && !del.includes(id)) {
      del.push(id);
      // **标记删除的那一刻就把后果说出来。** 派生扫描本来就是为这句话存在的；
      // 只导出不调用，等于「登记了一个能力，界面上永远不发生」—— 那正是
      // §2.5c 接线账要挡的东西（codex 交接前那轮的 non-blocking：
      // 「creators cannot make the informed decision the scan is intended to support」）。
      //
      // 这是**告知，不是闸门**：软删除不销毁任何东西，撤销把镜头原位放回，
      // 所以这里不拦（§2.5f 第二条）。
      const impact = typeof ctx.shots.deletionImpact === "function"
        ? ctx.shots.deletionImpact(id)
        : null;
      if (impact && impact.total > 0) {
        const areas = impact.groups.map((g) => `${g.area}(${g.paths.length})`).join("、");
        ctx.toast(`标记删除 —— 保存后 ${impact.total} 处引用会指向一个已回收的镜头：${areas}。可随时撤销`);
      }
    }
    rerender();
  }));
  root.querySelectorAll("[data-tundel]").forEach((el) => (el.onclick = () => {
    const i = del.indexOf(el.dataset.tundel);
    if (i >= 0) del.splice(i, 1);
    rerender();
  }));

  const discard = root.querySelector("[data-tdiscard]");
  if (discard) discard.onclick = () => {
    ui.tbuf = {};
    ui.tdel = [];
    ui.tableEdit = null;
    rerender();
  };

  const save = root.querySelector("[data-tsave]");
  if (save) save.onclick = () => {
    const shots = shotsNow();
    if (!tableDirty(shots, { buffer: buf, deleted: del })) { ctx.toast("没有修改 — 未创建新版本"); return; }
    const items = applyTableEdits(shots, {
      buffer: buf, deleted: del, at: new Date().toISOString(),
    });
    // 「至少保留 1 个镜头」问的是**存活的**镜头 —— 软删除之后 `items` 里仍然有
    // 被标记的那些，用 `items.length` 判断等于允许把整集删空（§2.5f 第一条的
    // 同一形状：换了语义之后旧判据说的已经不是它以为的那件事）。
    const live = items.filter((s) => !(s && s.deleted));
    if (!live.length) { ctx.toast("至少保留 1 个镜头 — 未保存"); return; }
    if (live.some((s) => !String(s.title || "").trim())) { ctx.toast("镜头名不能为空"); return; }
    if (ctx.shots.saveEdit(items)) {
      ui.tbuf = {};
      ui.tdel = [];
      ui.tableEdit = null;
      ctx.toast("已保存为新草稿版本（旧版本保留，可在工作流节点回切）");
      rerender();
    } else {
      ctx.toast("没有可保存的草稿版本");
    }
  };

  const caretTo = (el) => {
    if (!el) return;
    el.focus();
    if (typeof el.setSelectionRange === "function") el.setSelectionRange(el.value.length, el.value.length);
  };
  // keep the caret in the cell the creator just opened
  if (ui.tableEdit) {
    caretTo(root.querySelector(`[data-tf="description"][data-shot="${CSS.escape(ui.tableEdit)}"]`));
  } else if (ui.tableFocus && ui.tableFocus.shotId) {
    // arrived from a 「未填 · 去填写」 — put the caret IN the cell it named, then
    // release the pointer so a later re-render does not keep stealing focus
    const cell = root.querySelector(
      `[data-tf="${CSS.escape(ui.tableFocus.field)}"][data-shot="${CSS.escape(ui.tableFocus.shotId)}"]`,
    );
    if (cell) {
      caretTo(cell);
      if (typeof cell.scrollIntoView === "function") cell.scrollIntoView({ block: "center" });
    }
    ui.tableFocus = null;
  }
}
