// TASK-081 — URL 即状态.
//
// Four rules, and the fourth is the one that can lose work:
//
//   1. EVERY historical module key survives a round trip through the URL and
//      lands on a REAL page + a REAL section (ADR-0063 决策 1). The existing
//      assertions in creatornav / workspaces are reused, not rewritten.
//   2. An address this build does not understand lands somewhere real and SAYS
//      WHY — it is never swallowed.
//   3. Round trip is asserted as a PROPERTY over every page and section, not as
//      an enumeration of spellings (TASK-077's lesson).
//   4. `popstate` and `setModule` share ONE unsaved-edit guard. The back button
//      goes down a different code path, and without this it discards a shot's
//      unsaved edits silently.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PAGES, PAGE_SECTIONS, PROJECT_SETTINGS, MODULE_ALIAS, ASSET_FILTER_ALIAS,
  LEGACY_EPISODE_STAGES, resolveModule, spaceOf,
} from "../src/ui/shell.js";
import { formatRoute, parseRoute, sameRoute, loadLastRoute, saveLastRoute } from "../src/services/route.js";
import { guardsUnsavedEdit, routeLeavesObject } from "../src/ui/production.js";

const P = "照见未明rev2";

/** EVERY key a creator can actually be sitting on — DERIVED, never hand-listed.
 *
 *  TASK-086 §2: the previous spelling of this set was
 *  `MODULE_ALIAS ∪ ASSET_FILTER_ALIAS ∪ PAGES ∪ ⚙`, and `workbench` /
 *  `provenance` are in NONE of them — they are live pages with their own
 *  renderer and their own `[data-mod]` entrance in `epprod.js`. So the property
 *  below held over a set that happened to exclude the two members that broke it:
 *  the app wrote `#/…/episode/workbench` and read it back as `PAGES[0]`, and
 *  「刷新页面还在那里」 quietly did not hold there.
 *
 *  Deriving the set from `LEGACY_EPISODE_STAGES` is the point. A future stage
 *  that has a renderer but no alias joins this test by existing, instead of by
 *  someone remembering to add it here. */
const EVERY_LIVE_KEY = [...new Set([
  ...Object.keys(MODULE_ALIAS),
  ...Object.keys(ASSET_FILTER_ALIAS),
  ...PAGES,
  PROJECT_SETTINGS,
  ...LEGACY_EPISODE_STAGES.map(([stage]) => stage),
])];

/* ------------------------------------------------------------------------- */
/* 1 · 历史键 → 真实页面 + 真实分区                                             */
/* ------------------------------------------------------------------------- */

test("往返集合覆盖每一个活着的键，包括没有别名的那两个（TASK-086 §2）", () => {
  // The guard on the guard: if this set ever stops containing a key that the
  // episode space can open, the property test below goes vacuous for it again.
  for (const stage of LEGACY_EPISODE_STAGES.map(([s]) => s)) {
    assert.ok(EVERY_LIVE_KEY.includes(stage), `${stage} 不在往返测试的键集里`);
  }
  assert.ok(EVERY_LIVE_KEY.includes("workbench"));
  assert.ok(EVERY_LIVE_KEY.includes("provenance"));
});

test("每一个历史模块键都能写成 URL 并读回真实页面 + 真实分区（ADR-0063 决策 1）", () => {
  const keys = EVERY_LIVE_KEY;
  for (const key of keys) {
    const hit = resolveModule(key);
    assert.equal(hit.resolved, true, `${key} must resolve`);
    const url = formatRoute({ project: P, module: key });
    const back = parseRoute(url);
    assert.equal(back.ok, true, `${key} → ${url} did not parse`);
    assert.equal(back.project, P);
    assert.equal(back.resolved, true, `${key} → ${url} lost its resolution`);
    // …a REAL surface. Not「any string」: the address must land somewhere that
    // actually holds the content (ADR-0063 决策 1).
    //
    // TASK-086 §2 SPLIT THIS IN TWO rather than widening it. The old spelling was
    // `PAGES ∪ ⚙`, written when the key set could not contain a legacy stage; now
    // that it does, blanket-allowing any legacy landing would let a NEW page slip
    // in unnoticed. So the rule is stated per key:
    //   • a legacy stage with no alias   → may land on ITSELF, and only itself
    //   • everything else                → must land in the frozen eleven ∪ ⚙
    // The eleven-page closed set is untouched (`PAGES.length === 11` still guards
    // it in workspaces.test.mjs); this only says which keys are allowed to sit
    // outside it, and names them from the stage list instead of by hand.
    assert.equal(back.module, hit.module, key);
    const isLegacyStage = LEGACY_EPISODE_STAGES.some(([s]) => s === key);
    const hasAlias = Object.prototype.hasOwnProperty.call(MODULE_ALIAS, key);
    if (isLegacyStage && !hasAlias) {
      assert.equal(
        back.module, key,
        `${key} 没有别名，地址必须读回它自己（不得落到 ${back.module}）`,
      );
    } else {
      assert.ok(
        PAGES.includes(back.module) || back.module === PROJECT_SETTINGS,
        `${key} landed on ${back.module}, which is not a page`,
      );
    }
    // …and a REAL section of it, or none because the page has none
    const list = PAGE_SECTIONS[back.module];
    if (back.section) {
      assert.ok(list && list.includes(back.section), `${key} → section ${back.section} is not real`);
    }
  }
});

test("资产库的类型别名不会在 URL 里丢掉它的筛选值", () => {
  for (const key of Object.keys(ASSET_FILTER_ALIAS)) {
    const url = formatRoute({ project: P, module: key });
    const back = parseRoute(url);
    assert.equal(back.module, "assets");
    assert.equal(back.filter, ASSET_FILTER_ALIAS[key], `${key} lost its filter`);
  }
});

/* ------------------------------------------------------------------------- */
/* 2 · 不认识的 URL：落到真实的地方，并说明原因                                   */
/* ------------------------------------------------------------------------- */

test("不认识的页面键：不抛异常，落到真实页面，并说出原因", () => {
  const r = parseRoute(`#/${encodeURIComponent(P)}/story/no-such-page`);
  assert.equal(r.ok, true);
  assert.equal(r.project, P);
  assert.equal(r.resolved, false);
  assert.ok(PAGES.includes(r.module), "an unknown key must still land on a real page");
  assert.match(r.reason, /no-such-page/);
});

test("不认识的分区：打开这一页的默认分区，并说出原因", () => {
  const r = parseRoute(`#/${encodeURIComponent(P)}/episode/shotwork/no-such-section`);
  assert.equal(r.module, "shotwork");
  assert.ok(PAGE_SECTIONS.shotwork.includes(r.section) || r.section === null);
  assert.match(r.reason, /no-such-section/);
});

test("空地址不是错误，只是「没有深链接」", () => {
  for (const h of ["", "#", "#/"]) {
    const r = parseRoute(h);
    assert.equal(r.ok, false);
    assert.equal(r.project, null);
    assert.equal(r.reason, null, `${h} must not invent a complaint`);
  }
});

test("只写了项目名的地址是合法的：打开项目，不指定页面", () => {
  const r = parseRoute(`#/${encodeURIComponent(P)}`);
  assert.equal(r.ok, true);
  assert.equal(r.project, P);
  assert.equal(r.module, null);
});

test("项目名里的斜杠、空格与中文都能原样读回", () => {
  const odd = "我的 项目 / rev2";
  const r = parseRoute(formatRoute({ project: odd, module: "brief" }));
  assert.equal(r.project, odd);
  assert.equal(r.module, "brief");
});

/* ------------------------------------------------------------------------- */
/* 3 · 往返是一条性质，不是一张拼写表                                            */
/* ------------------------------------------------------------------------- */

test("往返性质：每一页 × 每一个分区 × 选中项，写出去再读回来是同一处", () => {
  const targets = [...PAGES, PROJECT_SETTINGS];
  for (const module of targets) {
    const sections = PAGE_SECTIONS[module] || [null];
    for (const section of sections) {
      const want = {
        project: P, module, section,
        ep: "ep-7", scene: "sc-3", shot: "sh-12",
      };
      const back = parseRoute(formatRoute(want));
      assert.equal(back.module, module);
      assert.equal(back.section, section, `${module}/${section} did not survive`);
      assert.equal(back.ep, "ep-7");
      assert.equal(back.scene, "sc-3");
      assert.equal(back.shot, "sh-12");
      // …and the space in the address is only ever the derived one
      assert.match(formatRoute(want), new RegExp(`/${spaceOf(module)}/`));
    }
  }
});

test("URL 里的 space 段是派生的：它和 module 冲突时，module 说了算", () => {
  // hand-edited: 剧集制作 as the space, ① 项目与创意 as the page
  const r = parseRoute(`#/${encodeURIComponent(P)}/episode/brief`);
  assert.equal(r.module, "brief");
  assert.equal(spaceOf(r.module), "story");
  // and writing it back normalises the address rather than preserving the clash
  assert.equal(formatRoute({ project: P, module: r.module }), `#/${encodeURIComponent(P)}/story/brief`);
});

test("sameRoute 认得同一处地址，用来吞掉浏览器的重复事件", () => {
  const a = parseRoute(formatRoute({ project: P, module: "shotwork", section: "image", shot: "sh-1" }));
  const b = parseRoute(formatRoute({ project: P, module: "shotwork", section: "image", shot: "sh-1" }));
  assert.equal(sameRoute(a, b), true);
  const c = parseRoute(formatRoute({ project: P, module: "shotwork", section: "video", shot: "sh-1" }));
  assert.equal(sameRoute(a, c), false);
});

/* ------------------------------------------------------------------------- */
/* 4 · 后退键与 setModule 共用同一个未保存守卫（本卡唯一的数据丢失面）              */
/* ------------------------------------------------------------------------- */

test("popstate 与 setModule 共用同一个 ui.dirty 守卫", () => {
  const clean = { dirty: false };
  const dirty = { dirty: true };
  const cur = { module: "shotwork", ep: "ep-1", shot: "sh-1" };

  // NOT dirty → nothing ever asks
  assert.equal(guardsUnsavedEdit(clean, cur, { module: "storyboard" }), false);

  // `setModule`'s own call shape: only the module moves
  assert.equal(guardsUnsavedEdit(dirty, cur, { module: "storyboard" }), true);
  assert.equal(guardsUnsavedEdit(dirty, cur, { module: "shotwork" }), false,
    "staying on the same page must not prompt");

  // the ROUTE's call shape — the back button can move any of the three, and each
  // one on its own would discard the buffer
  assert.equal(guardsUnsavedEdit(dirty, cur, { module: "shotwork", ep: "ep-2", shot: "sh-1" }), true);
  assert.equal(guardsUnsavedEdit(dirty, cur, { module: "shotwork", ep: "ep-1", shot: "sh-9" }), true);
  // …and a route that names none of them (a section-only change) does not
  assert.equal(guardsUnsavedEdit(dirty, cur, { module: "shotwork", ep: "ep-1", shot: "sh-1" }), false);
  assert.equal(guardsUnsavedEdit(dirty, cur, {}), false);
});

test("守卫只看未保存状态，不看是谁在导航", () => {
  // the same function, the same answer, whichever door the navigation came
  // through — which is the whole point: the back button used to have no door at
  // all, so it had no guard either.
  const dirty = { dirty: true };
  const want = { module: "brief" };
  const cur = { module: "shotwork" };
  assert.equal(guardsUnsavedEdit(dirty, cur, want), guardsUnsavedEdit(dirty, cur, want));
  assert.equal(guardsUnsavedEdit({ dirty: "yes" }, cur, want), false,
    "only a real boolean true is an unsaved edit");
  assert.equal(guardsUnsavedEdit(null, cur, want), false);
});

/* ------------------------------------------------------------------------- */
/* 5 · 上次所在页：记在浏览器里，不进创作数据                                     */
/* ------------------------------------------------------------------------- */

/** The smallest thing that behaves like `localStorage`. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _raw: () => Object.fromEntries(map),
  };
}

test("上次所在页按项目分别记住，互不覆盖", () => {
  const s = fakeStorage();
  saveLastRoute(s, "A", { module: "shotwork", section: "video", ep: "ep-1", shot: "sh-9" });
  saveLastRoute(s, "B", { module: "assets", section: null, ep: null, shot: null });
  assert.deepEqual(loadLastRoute(s, "A"), {
    module: "shotwork", section: "video", ep: "ep-1", scene: null, shot: "sh-9",
  });
  assert.equal(loadLastRoute(s, "B").module, "assets");
  assert.equal(loadLastRoute(s, "没打开过的项目"), null);
});

test("没有页面可记时不写；存储坏了 / 写不进去时也不报错", () => {
  const s = fakeStorage();
  assert.equal(saveLastRoute(s, "A", { module: null }), false);
  assert.equal(saveLastRoute(s, "", { module: "brief" }), false);
  assert.equal(saveLastRoute(null, "A", { module: "brief" }), false);
  // a corrupt store reads as 「不知道上次在哪」, never as a crash on boot
  const broken = fakeStorage({ "motv:lastRoute": "{not json" });
  assert.equal(loadLastRoute(broken, "A"), null);
  // …and a store that refuses writes costs one click, not a navigation failure
  const readOnly = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(saveLastRoute(readOnly, "A", { module: "brief" }), false);
});

test("记的是 UI 位置，不是创作数据——只有路由字段被写出去", () => {
  const s = fakeStorage();
  saveLastRoute(s, "A", {
    module: "storyboard", section: "shots", ep: "ep-1", scene: "sc-2", shot: "sh-3",
    // things a caller might hand over by accident: none of them may be stored
    draftShots: [{ shotId: "sh-3" }], script: "全文", dirty: true,
  });
  assert.deepEqual(Object.keys(loadLastRoute(s, "A")).sort(),
    ["ep", "module", "scene", "section", "shot"]);
});

/* ------------------------------------------------------------------------- */
/* 6 · 审查 round 1 的两条 P1                                                   */
/* ------------------------------------------------------------------------- */

test("「要不要问」和「要不要清掉草稿」是同一个判断（round 1 的 P1-1）", () => {
  const cur = { module: "shotwork", ep: "ep-1", shot: "sh-1" };
  // A route that moves NOTHING but the section does not leave the object being
  // edited — so it neither prompts nor releases. The first version prompted with
  // one predicate and released unconditionally, which discarded a shot's unsaved
  // edits in silence on a section change: the very data loss §1.2 第 1 条 names.
  const sameObject = { module: "shotwork", ep: "ep-1", shot: "sh-1" };
  assert.equal(routeLeavesObject(cur, sameObject), false);
  assert.equal(guardsUnsavedEdit({ dirty: true }, cur, sameObject), false);

  // …and a route that omits ep / shot entirely is not claiming to move them
  assert.equal(routeLeavesObject(cur, { module: "shotwork" }), false);
  assert.equal(routeLeavesObject(cur, {}), false);

  // every route that DOES leave asks, and only those
  for (const want of [
    { module: "storyboard" },
    { module: "shotwork", ep: "ep-2" },
    { module: "shotwork", shot: "sh-2" },
  ]) {
    assert.equal(routeLeavesObject(cur, want), true, JSON.stringify(want));
    assert.equal(guardsUnsavedEdit({ dirty: true }, cur, want), true);
    // the guard adds exactly one thing to the predicate: whether there IS an edit
    assert.equal(guardsUnsavedEdit({ dirty: false }, cur, want), false);
  }
});

test("创作者拒绝离开后，地址被放回原处，同一次后退的第二个事件识别得出（round 1 的 P1-2）", () => {
  // where the application really is
  const here = parseRoute(formatRoute({
    project: P, module: "shotwork", section: "image", ep: "ep-1", shot: "sh-1",
  }));
  // the back-press pointed somewhere else; the creator declined, so the address
  // was restored to `here`
  const restored = parseRoute(formatRoute({ project: P, ...here }));
  // one press fires popstate AND hashchange — the second must recognise that the
  // address already names where we are and do nothing, or it re-applies the move
  // the creator just refused
  assert.equal(sameRoute(restored, here), true);
  // …while a genuinely different address is still honoured
  const elsewhere = parseRoute(formatRoute({ project: P, module: "brief" }));
  assert.equal(sameRoute(elsewhere, here), false);
  // a null 「where we are」 (nothing applied yet, e.g. boot) never suppresses
  assert.equal(sameRoute(restored, null), false);
});

test("只写场景的地址也要过守卫：它会换镜头（round 2 的 P1-1）", () => {
  // A `?scene=` address selects that scene's FIRST shot. The shell resolves that
  // shot BEFORE asking, so the guard sees the move that is really about to happen.
  // Resolving it afterwards left the unsaved buffer attached to one shot while the
  // shell stood on another — worse than discarding it.
  const cur = { module: "storyboard", ep: "ep-1", shot: "sh-1" };
  // what the shell computes for `?scene=sc-2` (whose first shot is sh-9)
  const resolvedFromScene = { module: "storyboard", ep: "ep-1", shot: "sh-9" };
  assert.equal(routeLeavesObject(cur, resolvedFromScene), true);
  assert.equal(guardsUnsavedEdit({ dirty: true }, cur, resolvedFromScene), true);
  // …and a scene whose first shot is the one already selected moves nothing
  const sameShot = { module: "storyboard", ep: "ep-1", shot: "sh-1" };
  assert.equal(routeLeavesObject(cur, sameShot), false);
  // the address still CARRIES the scene, so it round-trips either way
  const back = parseRoute(formatRoute({ project: P, module: "storyboard", scene: "sc-2" }));
  assert.equal(back.scene, "sc-2");
  assert.equal(back.shot, null);
});

test("资产类型别名之间的移动是一次真导航，不是重复事件（round 3 的 P1）", () => {
  const all = parseRoute(formatRoute({ project: P, module: "assets" }));
  const images = parseRoute(formatRoute({ project: P, module: "assets:image" }));
  const videos = parseRoute(formatRoute({ project: P, module: "assets:video" }));
  // they all resolve to the same PAGE …
  assert.equal(all.module, "assets");
  assert.equal(images.module, "assets");
  // … so without the filter in the comparison they would look like one place, and
  // the router would swallow the move as a duplicate event
  assert.equal(sameRoute(all, images), false);
  assert.equal(sameRoute(images, videos), false);
  assert.equal(sameRoute(images, parseRoute(formatRoute({ project: P, module: "assets:image" }))), true);
});
