// 作品设定的回收区（TASK-129）—— 删除是软删除，拿得回来。
//
// 形状与 `storywork.js` 的定稿版本**不同**：那边是原地打 `deleted` 标记 + 每个读点
// 过滤，这边是把记录移进单独的回收区数组。理由写在 `bibledoc.js` 的注释里 ——
// `prod.characters` 有约 60 个读点、跨 12 个文件，「每处都记得过滤」是六十次犯错
// 机会；移走之后那些读点天生只看得见活的。
//
// 这份测试守的是那个形状**自己的**两条代价，它们各自都会静默出错：
//
//   1. 回收区必须活过 `serialize → createProduction` 往返（两个函数都是**显式
//      重建**，不加就整个丢掉）；
//   2. 回收区里的东西必须继续占着 id（它随时可能被拿回来）。
//
// 每条都写两个方向：该在的要在，不该在的不许在。

import test from "node:test";
import assert from "node:assert/strict";

import * as pd from "../src/workflow/proddoc.js";
import * as bd from "../src/workflow/bibledoc.js";
import * as cd from "../src/workflow/canondoc.js";

const reload = (p) => pd.createProduction(JSON.parse(JSON.stringify(pd.serialize(p))));

/* --- 人物 -------------------------------------------------------------------- */

test("删掉的人物离开名单、进回收区，拿得回来", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.updateCharacterProfile(p, c.characterId, { appearance: "束发" });

  assert.equal(bd.removeCharacter(p, c.characterId, "T1"), true);
  assert.equal(p.characters.length, 0, "名单里不该还有他 —— 那 60 个读点靠这一条");
  assert.equal(bd.deletedCharacters(p).length, 1);
  assert.equal(bd.deletedCharacters(p)[0].deletedAt, "T1");
  assert.equal(bd.deletedCharacters(p)[0].profile.appearance, "束发", "档案一字不动");

  assert.equal(bd.undeleteCharacter(p, c.characterId), true);
  assert.equal(p.characters.length, 1);
  assert.equal(bd.deletedCharacters(p).length, 0);
  assert.equal(p.characters[0].profile.appearance, "束发");
  assert.ok(!("deletedAt" in p.characters[0]), "拿回来之后不该还带着删除时间");
});

test("回收区活过存盘往返 —— 这条是本形状的头号代价", () => {
  // `serialize` 与 `sanitizeBible` **都是显式重建**：少写一行，删掉的东西就会在
  // 下一次加载时消失，而「软删除」的全部意义就是那条撤销的路还在。
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.updateCharacterProfile(p, c.characterId, { appearance: "束发" });
  bd.removeCharacter(p, c.characterId, "T1");

  const back = reload(p);
  assert.equal(back.characters.length, 0);
  assert.equal(bd.deletedCharacters(back).length, 1, "回收区被读盘丢掉了");
  assert.equal(bd.deletedCharacters(back)[0].profile.appearance, "束发");
  assert.equal(bd.undeleteCharacter(back, c.characterId), true, "重开之后还得拿得回来");
  assert.equal(back.characters[0].name, "李昭");
});

test("删掉的人物仍然占着它的 id —— 否则「拿回来」会撞上一个同名身份", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.removeCharacter(p, c.characterId, "T1");

  // 手工造一份「新人物恰好用了同一个 id」的文档：水合必须让**活的**赢，
  // 回收区那条按重复 id 丢弃，而不是两条同 id 并存。
  const saved = pd.serialize(p);
  saved.characters = [{ characterId: c.characterId, name: "另一个人" }];
  const back = pd.createProduction(JSON.parse(JSON.stringify(saved)));

  assert.equal(back.characters.length, 1);
  assert.equal(back.characters[0].name, "另一个人", "活的是权威");
  assert.equal(bd.deletedCharacters(back).length, 0, "同 id 的回收区记录不该并存");
});

test("findCharacterAny 找得到回收区里的，findCharacter 找不到", () => {
  // 两类读点要的东西相反：显示/修改不该看见删掉的，解析引用必须还能找到它。
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.removeCharacter(p, c.characterId, "T1");

  assert.equal(bd.findCharacter(p, c.characterId), null);
  assert.equal(bd.findCharacterAny(p, c.characterId).name, "李昭");
  assert.equal(bd.findCharacterAny(p, "char-nope"), null);
  // 删掉的人物改不动 —— 修改器走的是 `findCharacter`
  assert.equal(bd.renameCharacter(p, c.characterId, "李昭仪"), false);
});

test("被场景引用时仍然拒删 —— 这道保护是承重的", () => {
  // 回收区这个形状依赖它：删掉的人物没有任何引用指着，所以场景引用水合
  // （拿活人物名单筛）不会把谁悄悄丢掉。它放宽的那天，这里会先红。
  const p = pd.createProduction(null);
  const scene = pd.addScene(p, p.episodes[0].episodeId, "大殿");
  const c = bd.addCharacter(p, "甲");
  assert.equal(bd.addSceneCharacter(p, scene.sceneId, c.characterId), true);
  assert.equal(bd.removeCharacter(p, c.characterId, "T1"), false);
  assert.equal(bd.deletedCharacters(p).length, 0, "拒绝了就不该往回收区里塞");
});

/* --- 状态与参考图 ------------------------------------------------------------- */

test("删掉的状态进它自己实体的回收区，并活过往返", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  const s = bd.addCharacterState(p, c.characterId, "黑化时期");
  bd.setCharacterStateOverrides(p, c.characterId, s.stateId, { appearance: "散发" });

  assert.equal(bd.removeCharacterState(p, c.characterId, s.stateId, "T1"), true);
  assert.equal(p.characters[0].states.length, 0);
  assert.equal(p.characters[0].deletedStates.length, 1);

  const back = reload(p);
  assert.equal(back.characters[0].deletedStates.length, 1, "状态回收区被读盘丢掉了");
  assert.equal(bd.undeleteCharacterState(back, c.characterId, s.stateId), true);
  assert.equal(back.characters[0].states[0].overrides.appearance, "散发");
});

test("人物进回收区时，它的状态回收区跟着一起走", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  const s = bd.addCharacterState(p, c.characterId, "黑化时期");
  bd.removeCharacterState(p, c.characterId, s.stateId, "T1");
  bd.removeCharacter(p, c.characterId, "T2");

  const back = reload(p);
  assert.equal(bd.deletedCharacters(back)[0].deletedStates.length, 1);
  bd.undeleteCharacter(back, c.characterId);
  assert.equal(bd.undeleteCharacterState(back, c.characterId, s.stateId), true);
  assert.equal(back.characters[0].states[0].name, "黑化时期");
});

test("摘下来的参考图拿得回来，但不抢回主图位", () => {
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  bd.addReferenceAsset(p, c.characterId, "asset-1");
  bd.addReferenceAsset(p, c.characterId, "asset-2");
  assert.equal(p.characters[0].activeReferenceAssetId, "asset-1");

  assert.equal(bd.removeReferenceAsset(p, c.characterId, "asset-1"), true);
  assert.equal(p.characters[0].activeReferenceAssetId, "asset-2", "主图位让给了下一张");

  const back = reload(p);
  assert.deepEqual(back.characters[0].deletedReferenceAssetIds, ["asset-1"]);
  assert.equal(bd.undeleteReferenceAsset(back, c.characterId, "asset-1"), true);
  assert.ok(back.characters[0].referenceAssetIds.includes("asset-1"));
  assert.equal(
    back.characters[0].activeReferenceAssetId,
    "asset-2",
    "撤销不该覆盖他之后做的主图选择",
  );
});

test("没删过东西的文档不会因为读了一次就长出空回收区字段", () => {
  // 加法字段的老规矩：旧 canvas.json 不该在第一次保存时产生纯噪音的 diff。
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  const back = reload(p);
  assert.ok(!("deletedStates" in back.characters[0]));
  assert.ok(!("deletedReferenceAssetIds" in back.characters[0]));
  assert.equal(c.name, "李昭");
});

test("带垃圾的回收区字段会被规范化，而不是原样穿过去", () => {
  // `sanitizeCharacter` 是 `{ ...c, ... }`，所以「返回空对象」不等于「清掉它」——
  // 那样只会让未规范化的原值留下。这条钉的就是那个分支。
  const p = pd.createProduction(null);
  const c = bd.addCharacter(p, "李昭");
  const saved = pd.serialize(p);
  saved.characters[0].deletedReferenceAssetIds = ["", "a", "a", 7];
  saved.characters[0].deletedStates = [{ nope: 1 }];
  const back = pd.createProduction(JSON.parse(JSON.stringify(saved)));

  assert.deepEqual(back.characters[0].deletedReferenceAssetIds, ["a"]);
  assert.deepEqual(back.characters[0].deletedStates, [], "没有 stateId 的记录不该留下");
  assert.equal(c.name, "李昭");
});

/* --- 关系 -------------------------------------------------------------------- */

test("删掉的关系拿得回来，并活过往返", () => {
  const p = pd.createProduction(null);
  const a = bd.addCharacter(p, "林照");
  const b = bd.addCharacter(p, "沈既白");
  const r = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r.relationshipId, { aToB: "旧识" });

  assert.equal(cd.removeRelationship(p, r.relationshipId, "T1"), true);
  assert.equal(p.relationships.length, 0);

  const back = reload(p);
  assert.equal(cd.deletedRelationships(back).length, 1, "关系回收区被读盘丢掉了");
  assert.equal(cd.undeleteRelationship(back, r.relationshipId), true);
  assert.equal(back.relationships[0].profile.aToB, "旧识");
});

test("同一对人物已经有一段活着的关系时，拿回来被拒绝 —— 而且不吞掉任何一份", () => {
  // 一对人物只能有一段关系。静默合并会让他写过的两份描述里有一份消失，
  // 静默替换等于拿撤销去覆盖他之后做的事。所以这里拒绝。
  const p = pd.createProduction(null);
  const a = bd.addCharacter(p, "林照");
  const b = bd.addCharacter(p, "沈既白");
  const r1 = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r1.relationshipId, { aToB: "旧识" });
  cd.removeRelationship(p, r1.relationshipId, "T1");
  const r2 = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r2.relationshipId, { aToB: "新写的" });

  assert.equal(cd.undeleteRelationship(p, r1.relationshipId), false);
  assert.equal(p.relationships.length, 1);
  assert.equal(p.relationships[0].profile.aToB, "新写的", "活着的那份没被覆盖");
  assert.equal(cd.deletedRelationships(p).length, 1, "回收区那份也还在");
});

test("被删的关系可以指着一个同样被删的人物，读盘不许把它丢掉", () => {
  // 拿活人物名单去筛回收区里的关系，等于读盘把软删除悄悄变成硬删除。
  const p = pd.createProduction(null);
  const a = bd.addCharacter(p, "林照");
  const b = bd.addCharacter(p, "沈既白");
  const r = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r.relationshipId, { aToB: "旧识" });
  cd.removeRelationship(p, r.relationshipId, "T1");
  assert.equal(bd.removeCharacter(p, a.characterId, "T2"), true, "关系已进回收区，人物可删");

  const back = reload(p);
  assert.equal(cd.deletedRelationships(back).length, 1, "它指着的人物也在回收区，不是理由");
  assert.equal(bd.deletedCharacters(back).length, 1);
});

test("回收区里可以躺着同一对人物的两段旧关系", () => {
  // 「一对一段」是对**活着的**那批说的。删了建、建了又删是正常路径。
  const p = pd.createProduction(null);
  const a = bd.addCharacter(p, "林照");
  const b = bd.addCharacter(p, "沈既白");
  const r1 = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r1.relationshipId, { aToB: "第一版" });
  cd.removeRelationship(p, r1.relationshipId, "T1");
  const r2 = cd.addRelationship(p, a.characterId, b.characterId);
  cd.updateRelationship(p, r2.relationshipId, { aToB: "第二版" });
  cd.removeRelationship(p, r2.relationshipId, "T2");

  const back = reload(p);
  assert.equal(cd.deletedRelationships(back).length, 2);
  assert.equal(cd.undeleteRelationship(back, r1.relationshipId), true);
  assert.equal(cd.undeleteRelationship(back, r2.relationshipId), false, "这一对已经有活的了");
});
