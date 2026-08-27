// 资产收件箱 survived the retirement of the AI 导演台 (REQ-004 v2) by MOVING, and this
// file is what makes that a fact rather than an intention.
//
// WHY IT NEEDS ITS OWN GUARD. The console it used to live in is deleted. The inbox
// is the ONLY surface where an asset whose owner is unknown gets confirmed — the
// creator's real project had 7 waiting — and `assetlibws.js` has no equivalent. So
// the risk is not that the section renders badly; the risk is that it QUIETLY stops
// being rendered or bound at all, which is how a capability disappears while every
// other test stays green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAssetInboxSection } from "../src/ui/assetinboxsec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "ui");

/** The smallest project shape `assetInbox()` reads: the registry is keyed by
 *  domain → slot → { history: [...] }, which is why a flat array reads as EMPTY. */
function chain(rows) {
  return { history: rows, activeVersion: rows.length ? rows[rows.length - 1].version : null };
}

function img(assetId, version, creativeShotId = null) {
  return {
    assetId, version, url: `/api/uploads/p/${assetId}.png`, origin: "import",
    storageState: "local", creativeShotId, createdAt: "2026-08-01T00:00:00Z",
  };
}

function pd({ slots = {}, shots = [] } = {}) {
  return {
    draftShots: shots,
    production: { episodes: [], characters: [], relationships: [], locations: [], scenes: [] },
    timelines: {},
    generations: [],
    assets: {
      images: slots, videos: {}, audio: {}, firstFrames: {},
      finals: [], displaced: [], unresolvedPaid: [],
    },
  };
}

test("没有任何资产时不占位置——空段落不渲染", () => {
  assert.equal(renderAssetInboxSection(pd()), "");
});

test("有待确认项时，数字与确认按钮都在", () => {
  // two imported images nobody owns → both land in the inbox as UNCERTAIN
  const html = renderAssetInboxSection(
    pd({ slots: { "v1-1": chain([img("a-1", 1)]), "v1-2": chain([img("a-2", 1)]) } }),
  );
  assert.match(html, /资产收件箱/);
  assert.match(html, /待确认/);
  // the rows themselves, not just a count
  assert.match(html, /ib-row/);
});

test("确认归属的按钮属性没变——它是收件箱唯一的写入入口", () => {
  // A rename here would leave `bindAssetInboxSection` binding nothing, and the
  // section would look right while confirming nothing.
  const src = readFileSync(join(SRC, "assetinboxsec.js"), "utf8");
  assert.match(src, /data-ibattach=/);
  assert.match(src, /data-ibopen=/);
  // and the confirmation gate it inherited from the retired console
  assert.match(src, /invoke\("attach-asset"/);
});

test("它真的被资产库工作区渲染并绑定——不是只存在于模块里", () => {
  // The failure this catches: the module survives the refactor, nobody calls it,
  // and the 7 pending assets have nowhere to be confirmed.
  const prod = readFileSync(join(SRC, "production.js"), "utf8");
  assert.match(prod, /renderAssetInboxSection\(ctx\.prodData\(\)\)/);
  assert.match(prod, /bindAssetInboxSection\(root, ctx\)/);
});

test("被退役的三个导演台模块确实不在了", () => {
  // REQ-004 v2 中「清掉」这条的机器化：文件仍在就说明只是停了渲染。
  for (const gone of ["director.js", "skillpanel.js", "agentpanel.js"]) {
    assert.throws(
      () => readFileSync(join(SRC, gone), "utf8"),
      /ENOENT/,
      `${gone} 还在仓库里——REQ-004 v2 要求删除，不是隐藏`,
    );
  }
});
