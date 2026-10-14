// Спасброски от смерти в трекере рисуются по правилам системы
// (combat_state.zeroHp), а не «всегда у персонажа по 3».
import test from "node:test";
import assert from "node:assert/strict";

import { deathSavesFor } from "../src/combat-rules.js";

const pc = { id: "c1", characterId: "char-1" };
const monster = { id: "c2", monsterId: "mon-1" };

const dnd = {
  character: "deathSaves",
  other: "dead",
  deathSaves: { success: 3, fail: 3, stabilizeHp: 1 },
};

test("D&D: персонаж бросает спасброски 3/3, существо — нет", () => {
  assert.deepEqual(deathSavesFor(dnd, pc), { success: 3, fail: 3 });
  assert.equal(deathSavesFor(dnd, monster), null);
});

test("своя система: персонаж выбывает — спасбросков нет", () => {
  assert.equal(deathSavesFor({ character: "out", other: "dead" }, pc), null);
});

test("система со спасбросками у существ и своими числами", () => {
  const rules = { character: "none", other: "deathSaves", deathSaves: { success: 2, fail: 4 } };
  assert.deepEqual(deathSavesFor(rules, monster), { success: 2, fail: 4 });
  assert.equal(deathSavesFor(rules, pc), null);
});

test("без правил (старый сервер) — спасбросков нет", () => {
  assert.equal(deathSavesFor(undefined, pc), null);
});
