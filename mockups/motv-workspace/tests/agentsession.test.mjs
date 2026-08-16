// TASK-080 §1.2 批次 A — 一个常驻的 Agent 会话.
//
// The four rules under test are the four ways this merge could go wrong:
//
//   1. `/` lists the SAME capability set ⚙ 能力目录 does. Two derivations of
//      「what can this system do」 would make one of the two a lie.
//   2. `@` reaches all SIX kinds, by the ids the documents already carry.
//   3. The context is VISIBLE and EDITABLE, and a reference whose object is gone
//      is shown as gone rather than silently dropped.
//   4. A page change does NOT reset the session — asserted against
//      `releasePageState`, which is the ONLY thing a navigation does to `ui`.
//
// Plus the migration guard §1.2 迁移纪律 1 asks for: every executable action of
// the four old panels is still EMITTED. Batch A deletes nothing, so this test
// passes trivially today — it exists so that batch B (收旧入口) cannot quietly
// take a capability with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as skills from "../src/workflow/skills.js";
import { builtinCatalogPayload, installBuiltinCatalog } from "./skillcatalog.mjs";
import { catalogRows } from "../src/ui/skillcatalog.js";
import {
  agentSessionModel, objectIndex, activeToken, stripToken, sessionState, SENT_KINDS,
  renderAgentSession, OBJECT_KINDS,
} from "../src/ui/agentsession.js";
import { releasePageState } from "../src/ui/production.js";

installBuiltinCatalog(skills);

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------------- */
/* a project with one of every referenceable kind                            */
/* ------------------------------------------------------------------------- */

const PROD = {
  episodes: [
    {
      episodeId: "ep-1",
      title: "EP01 沉默酒吧",
      scenes: [
        { sceneId: "sc-1", title: "夜·酒吧后巷", shotIds: ["sh-1"] },
        // a SECOND scene and shot, so the 「contract carries one of each」 rule
        // has something real to be tested against
        { sceneId: "sc-2", title: "日·天台", shotIds: ["sh-2"] },
      ],
    },
  ],
  characters: [{ characterId: "ch-1", name: "林晚" }],
  locations: [{ locationId: "lo-1", name: "暗夜酒吧" }],
  activeEpisodeId: "ep-1",
};

const DRAFT = [
  { shotId: "sh-1", sequence: 3, title: "擦杯子" },
  { shotId: "sh-2", sequence: 4, title: "推门" },
];

const ASSETS = [{ assetId: "as-1", name: "林晚 / 夜班 Ref", links: { characterId: "ch-1" } }];

/**
 * `scopeOf` is the REAL recording rule the session now reads its 送出 flags from,
 * so the stub reproduces the two behaviours that actually matter here (both taken
 * from `controllers/skillctl.js`): a level a capability does not read is dropped,
 * and an id the run's episode does not own is dropped. Nothing else is modelled —
 * the point of the fix is that this file no longer owns the rule.
 */
function scopeOfStub(skillId, scope) {
  const s = scope || {};
  const ep = PROD.episodes[0];
  const owned = (sceneId, shotId) => {
    if (sceneId && !ep.scenes.some((sc) => sc.sceneId === sceneId)) return false;
    if (shotId && !ep.scenes.some((sc) => sc.shotIds.includes(shotId))) return false;
    return true;
  };
  const skill = skills.findSkill(skillId);
  if (!skill) return null;
  const keys = new Set([...(skill.inputs || []), ...(skill.optionalInputs || [])]);
  const readsShot = keys.has("shots") || keys.has("shotAudio") || skills.isShotScoped(skill);
  const readsScene = keys.has("scenes") || skills.isShotScoped(skill);
  const narrow = owned(readsScene ? s.sceneId : null, readsShot ? s.shotId : null);
  const out = {
    episodeId: ep.episodeId,
    sceneId: narrow && readsScene ? s.sceneId || null : null,
    shotId: narrow && readsShot ? s.shotId || null : null,
  };
  return out.episodeId || out.sceneId || out.shotId ? out : null;
}

function makeCtx({ runs = [], missing = () => [], scopeOf = scopeOfStub } = {}) {
  return {
    prodData: () => ({ production: PROD, draftShots: DRAFT }),
    assets: { library: () => ({ rows: ASSETS }) },
    skills: {
      catalog: () => skills.SKILLS,
      deprecated: () => skills.DEPRECATED,
      catalogState: () => ({ installed: true, detail: "", problems: [] }),
      missing,
      find: (id) => skills.findSkill(id),
      runs: () => runs,
      scopeOf,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* 1 · `/` 唤出的集合不得与 ⚙ 目录分叉                                          */
/* ------------------------------------------------------------------------- */

test("`/` 唤出的能力集合 == /api/skills 的集合，两处不得分叉", () => {
  const ctx = makeCtx();
  const ui = {};
  sessionState(ui).text = "/";
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.pick.trigger, "/");
  // the picker shows a window of the list; `total` is the SET, and that is what
  // must equal the catalog
  assert.equal(m.pick.total, builtinCatalogPayload().skills.length);
  assert.equal(m.skillCount, catalogRows(ctx).length);
  // and the rows it does show are drawn from that same set, never invented
  const known = new Set(catalogRows(ctx).map((s) => s.skillId));
  for (const r of m.pick.rows) assert.ok(known.has(r.id), `${r.id} is not in the catalog`);
});

test("`/` 的过滤只收窄窗口，不改变集合大小", () => {
  const ctx = makeCtx();
  const ui = {};
  sessionState(ui).text = "写一版 /storyboard";
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.pick.query, "storyboard");
  assert.ok(m.pick.rows.length >= 1);
  assert.equal(m.pick.total, builtinCatalogPayload().skills.length);
  assert.ok(m.pick.rows.every((r) => r.id.includes("storyboard") || /storyboard/i.test(r.label)));
});

test("触发符只在词边界生效——「他/她」与邮箱不会弹出选择器", () => {
  assert.equal(activeToken("他/她"), null);
  assert.equal(activeToken("a@b.com"), null);
  assert.equal(activeToken(""), null);
  assert.equal(activeToken("说明一下"), null);
  assert.deepEqual(activeToken("/sto").trigger, "/");
  assert.deepEqual(activeToken("看一下 @林").trigger, "@");
  // picking replaces exactly the token, leaving no litter behind
  assert.equal(stripToken("看一下 @林"), "看一下 ");
  assert.equal(stripToken("没有触发符"), "没有触发符");
});

/* ------------------------------------------------------------------------- */
/* 2 · `@` 六类对象，每类至少一个用例                                           */
/* ------------------------------------------------------------------------- */

test("`@` 能引用到六类对象，每类至少一个，用的是文档自己的稳定 id", () => {
  const ctx = makeCtx();
  const idx = objectIndex(ctx);
  const expected = {
    shot: "sh-1",
    character: "ch-1",
    scene: "sc-1",
    location: "lo-1",
    asset: "as-1",
    episode: "ep-1",
  };
  assert.deepEqual(OBJECT_KINDS.map((k) => k.kind).sort(), Object.keys(expected).sort());
  for (const [kind, id] of Object.entries(expected)) {
    const hits = idx.filter((o) => o.kind === kind);
    assert.ok(hits.length >= 1, `@ cannot reach any ${kind}`);
    assert.ok(hits.some((o) => o.id === id), `${kind} ${id} is not referenceable`);
    assert.ok(hits.every((o) => o.label && o.icon), `${kind} rows must be nameable`);
  }
});

test("`@` 的查询按创作者看得见的名字匹配，不按 id", () => {
  const ctx = makeCtx();
  const ui = {};
  sessionState(ui).text = "@林晚";
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.pick.trigger, "@");
  // 林晚 the CHARACTER and 「林晚 / 夜班 Ref」 the ASSET both carry the name, and
  // both are legitimate answers — the creator asked by name, so every object
  // whose visible name says 林晚 is offered, with its kind printed beside it
  assert.deepEqual(m.pick.rows.map((r) => r.id).sort(), ["asset:as-1", "character:ch-1"]);
  assert.deepEqual(
    m.pick.rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => r.sub),
    ["资产", "角色"],
  );
  // an id is NOT a name: searching by the raw id finds nothing
  sessionState(ui).text = "@ch-1";
  assert.deepEqual(agentSessionModel(ctx, ui).pick.rows, []);
  assert.equal(m.pick.total, objectIndex(ctx).length);
});

/* ------------------------------------------------------------------------- */
/* 3 · 上下文可见、可编辑、不会静默丢                                            */
/* ------------------------------------------------------------------------- */

test("上下文里的引用可见；对象没了就标出来，不静默丢弃", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.context = [
    { kind: "shot", id: "sh-1", label: "Shot 03 擦杯子" },
    { kind: "character", id: "ch-gone", label: "已被删掉的角色" },
  ];
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.context.length, 2);
  assert.equal(m.context[0].alive, true);
  // the LIVE label wins over the one recorded when it was picked
  assert.equal(m.context[0].label, "Shot 03 擦杯子");
  assert.equal(m.context[1].alive, false);
  const html = renderAgentSession(m);
  assert.match(html, /已不在/);
  assert.match(html, /已被删掉的角色/);
  // …and every chip carries its own remove control
  assert.match(html, /data-as-drop="shot:sh-1"/);
  assert.match(html, /data-as-drop="character:ch-gone"/);
});

test("运行范围来自会话上下文，不来自「你在哪一页」", () => {
  const ctx = makeCtx();
  const ui = { selectedShotId: "sh-other" }; // the page's implicit selection
  const st = sessionState(ui);
  st.skillId = "shot-continuity-reviewer";
  assert.ok(skills.findSkill(st.skillId), "the fixture skill left the catalog");
  // no shot in the CONTEXT → the scope is empty and a shot-scoped skill says so,
  // even though the page has one selected
  let m = agentSessionModel(ctx, ui);
  assert.equal(m.scope.shotId, null);
  assert.match(m.blocked, /镜头级能力/);
  // …stating one changes the scope
  st.context = [{ kind: "shot", id: "sh-1", label: "Shot 03" }];
  m = agentSessionModel(ctx, ui);
  assert.equal(m.scope.shotId, "sh-1");
});

test("缺少必要输入时不给运行按钮，而是说缺什么", () => {
  const ctx = makeCtx({ missing: (id) => (id === "script-writer" ? ["outline"] : []) });
  const ui = {};
  sessionState(ui).skillId = "script-writer";
  const m = agentSessionModel(ctx, ui);
  assert.match(m.blocked, /缺少必要输入/);
  const html = renderAgentSession(m);
  assert.ok(!html.includes("data-as-run"), "a blocked session must not render a run button");
  assert.match(html, /◌/);
});

test("送不出去的引用与文字被明说，不被静默丢掉（批次 A 审查 round 1 的 P1）", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "storyboard-director";
  st.context = [
    { kind: "shot", id: "sh-1", label: "Shot 03" },
    { kind: "scene", id: "sc-1", label: "夜·酒吧后巷" },
    { kind: "character", id: "ch-1", label: "林晚" },
    { kind: "asset", id: "as-1", label: "林晚 / 夜班 Ref" },
  ];
  st.text = "写得更冷一点";
  const m = agentSessionModel(ctx, ui);

  // what the run contract really carries
  assert.deepEqual(SENT_KINDS, ["shot", "scene"]);
  assert.equal(m.scope.shotId, "sh-1");
  assert.equal(m.scope.sceneId, "sc-1");
  assert.deepEqual(m.context.filter((r) => r.sent).map((r) => r.kind), ["shot", "scene"]);

  // …and what it does not — named, per reference, with a reason
  assert.deepEqual(m.notSent.map((r) => r.id), ["ch-1", "as-1"]);
  for (const r of m.notSent) assert.match(r.why, /声明式/);
  assert.equal(m.proseIgnored, "写得更冷一点");

  const html = renderAgentSession(m);
  assert.match(html, /这次运行会被记为/);
  assert.match(html, /「林晚」/);
  assert.match(html, /<b>不会<\/b>进入/);
  assert.match(html, /笔记/);
});

test("引用了两个镜头时，只有真正送出的那个被标成送出（批次 A 审查 round 2 的 P1）", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "storyboard-director";
  st.context = [
    { kind: "shot", id: "sh-1", label: "Shot 03" },
    { kind: "shot", id: "sh-2", label: "Shot 04" },
    { kind: "scene", id: "sc-1", label: "夜·酒吧后巷" },
    { kind: "scene", id: "sc-2", label: "日·天台" },
  ];
  const m = agentSessionModel(ctx, ui);
  // only the FIRST live one of each kind rides on the scope…
  assert.equal(m.scope.shotId, "sh-1");
  assert.equal(m.scope.sceneId, "sc-1");
  // …and `sent` is read off that very selection, so it cannot claim otherwise
  assert.deepEqual(m.context.filter((r) => r.sent).map((r) => r.id), ["sh-1", "sc-1"]);
  const extra = m.context.filter((r) => !r.sent);
  assert.deepEqual(extra.map((r) => r.id), ["sh-2", "sc-2"]);
  for (const r of extra) {
    assert.equal(r.mark, "未送出");
    assert.match(r.why, /只带一个/);
  }
  // 未送出 (a reference that lost a slot) and 笔记 (a kind with no slot at all)
  // are different problems and never share a marker
  assert.match(renderAgentSession(m), /未送出/);
});

test("送出标记来自 scopeOf 本身：登记规则丢掉的，界面就不说它送出了（round 3 的 P1）", () => {
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "storyboard-director";
  st.context = [{ kind: "scene", id: "sc-foreign", label: "别集的一个场景" }];

  // the session must not decide this for itself — it asks, and a `scopeOf` that
  // drops the reference makes the chip say 未送出, with no rule restated here
  const drops = makeCtx({
    scopeOf: () => ({ episodeId: "ep-1", sceneId: null, shotId: null }),
  });
  // (the reference has to be a live object for the question to arise at all)
  st.context = [{ kind: "scene", id: "sc-2", label: "日·天台" }];
  let m = agentSessionModel(drops, ui);
  assert.equal(m.context[0].sent, false);
  assert.equal(m.context[0].mark, "未送出");
  assert.match(m.context[0].why, /放不下/);
  assert.deepEqual(m.recorded, { episodeId: "ep-1", sceneId: null, shotId: null });
  // …and the printed line is the RECORD's, so it cannot promise the scene either
  assert.ok(!renderAgentSession(m).includes("限定到一个场景"));

  // the same reference, with a `scopeOf` that keeps it
  const keeps = makeCtx({
    scopeOf: () => ({ episodeId: "ep-1", sceneId: "sc-2", shotId: null }),
  });
  m = agentSessionModel(keeps, ui);
  assert.equal(m.context[0].sent, true);
  assert.equal(m.context[0].mark, null);
  assert.match(renderAgentSession(m), /限定到一个场景/);
});

test("还没选能力时，不预告任何东西会被送出", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.context = [{ kind: "shot", id: "sh-1", label: "Shot 03" }];
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.recorded, null);
  assert.equal(m.context[0].sent, false);
  assert.equal(m.context[0].mark, "待定");
});

test("一个死掉的镜头引用不会占掉活着的那个的位置", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "storyboard-director";
  st.context = [
    { kind: "shot", id: "sh-gone", label: "已删掉的镜头" },
    { kind: "shot", id: "sh-1", label: "Shot 03" },
  ];
  const m = agentSessionModel(ctx, ui);
  assert.equal(m.scope.shotId, "sh-1");
  assert.deepEqual(m.context.filter((r) => r.sent).map((r) => r.id), ["sh-1"]);
});

test("引用里只有能送出去的东西时，不出现「不会进入」的警告", () => {
  const ctx = makeCtx();
  const ui = {};
  const st = sessionState(ui);
  st.skillId = "storyboard-director";
  st.context = [{ kind: "shot", id: "sh-1", label: "Shot 03" }];
  st.text = "/"; // a bare trigger is composing, not prose
  const m = agentSessionModel(ctx, ui);
  assert.deepEqual(m.notSent, []);
  assert.equal(m.proseIgnored, "");
  assert.ok(!renderAgentSession(m).includes("不会</b>进入"));
});

/* ------------------------------------------------------------------------- */
/* 4 · 换页不重置会话（验收 #5）                                                */
/* ------------------------------------------------------------------------- */

test("换一个页面，会话不重置——releasePageState 是换页对 ui 做的全部", () => {
  const ui = {
    dirty: true,
    buffer: { title: "改了一半" },
    bibleOpen: "c:ch-1",
    bpText: { key: "x", text: "y" },
  };
  const st = sessionState(ui);
  st.context = [{ kind: "shot", id: "sh-1", label: "Shot 03" }];
  st.text = "把这一镜的画面提示词写出来";
  st.skillId = "image-prompt-director";

  releasePageState(ui);

  // what a navigation DOES release
  assert.equal(ui.dirty, false);
  assert.deepEqual(ui.buffer, {});
  assert.equal(ui.bibleOpen, null);
  assert.equal(ui.bpText, null);
  // …and what it must not touch: the session, same object, same content
  assert.equal(ui.agentSession, st);
  assert.deepEqual(st.context, [{ kind: "shot", id: "sh-1", label: "Shot 03" }]);
  assert.equal(st.text, "把这一镜的画面提示词写出来");
  assert.equal(st.skillId, "image-prompt-director");
});

/* ------------------------------------------------------------------------- */
/* 5 · 迁移守卫：四个旧面板的每个可执行动作仍被发出                               */
/* ------------------------------------------------------------------------- */

/**
 * Every `data-*` action attribute the four old panels emit, enumerated.
 *
 * WHY A SOURCE-LEVEL LIST. §1.2 迁移纪律 1 says 「四个面板的能力一个都不许丢。本卡
 * 合并的是入口，不是删功能」, and the only way to check that across a merge is to
 * name the actions and assert they are still emitted. Batch A removes nothing, so
 * this passes trivially now — it exists for batch B, where an entrance is retired
 * and the temptation is to let its actions go with it.
 *
 * `data-mod` / `data-goto` / `data-shot` are NAVIGATION bound centrally by the
 * shell, and `data-goto2` / `data-shot2` are PAYLOAD riding on another button
 * (`data-dnext` / `data-ibattach`) rather than actions of their own. Both kinds
 * are excluded so the list stays a list of things these panels can DO.
 */
const PANEL_ACTIONS = Object.freeze({
  "director.js": [
    "data-canon-ep", "data-dir-cancel", "data-dir-run", "data-dnext", "data-dplan",
    "data-dsec", "data-ibattach", "data-ibopen", "data-ibopen-all",
  ],
  "directorshot.js": [
    "data-exec", "data-sd-abandon", "data-sd-apply", "data-sd-copyprompt", "data-sd-fix",
    "data-sd-goto", "data-sd-interp", "data-sd-op", "data-sd-prepare", "data-sd-regen",
    "data-sd-reject", "data-sd-submit",
  ],
  "agentpanel.js": ["data-agent-close", "data-agent-manual", "data-agent-panel", "data-agent-run"],
  "skillpanel.js": [
    "data-sk-apply", "data-sk-back", "data-sk-copyprompt", "data-sk-pick", "data-sk-reject",
    "data-sk-run", "data-sk-showprompt", "data-sk-submit", "data-sk-usegen",
  ],
});

const NAVIGATION = new Set(["data-mod", "data-goto", "data-shot", "data-goto2", "data-shot2"]);

test("合并后，四个旧面板的每个可执行动作仍然被发出（§1.2 迁移纪律 1）", () => {
  for (const [file, expected] of Object.entries(PANEL_ACTIONS)) {
    const src = readFileSync(join(HERE, "..", "src", "ui", file), "utf8");
    // BARE attributes count too: `data-sk-run` and `data-sk-back` are emitted
    // without a value, so a regex anchored on `="` would have silently reported
    // them as already gone — a migration guard that under-reports is worse than
    // none at all.
    const found = [...new Set([...src.matchAll(/data-[a-z][a-z0-9-]*/g)].map((m) => m[0]))]
      .filter((a) => !NAVIGATION.has(a))
      .sort();
    assert.deepEqual(
      found,
      [...expected].sort(),
      `${file} 的可执行动作集合变了——合并只准搬入口，不准删能力`,
    );
  }
});
