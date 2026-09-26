// Универсальный лист (sheet-universal.js / universal-stats.js): свободные
// характеристики с модификаторами stat.<ключ>, инициатива-формула, основы
// для стенда конструктора и выбор вида листа по системе.
import test from "node:test";
import assert from "node:assert/strict";

import { initiativeBase, initiativeFormula, standStats, statValue } from "../src/universal-stats.js";
import { sheetKindOf } from "../src/system-profile.js";

const cursed = [{ target: "stat.удача_ночью", mode: "add", value: "-2" }];

test("значение характеристики с модификатором stat.<ключ>", () => {
  assert.equal(statValue({ name: "Удача ночью", value: 5 }, cursed), 3);
  // Другая характеристика модификатор не трогает.
  assert.equal(statValue({ name: "Сила", value: 5 }, cursed), 5);
  // Безымянная строка — просто значение.
  assert.equal(statValue({ name: "", value: 4 }, cursed), 4);
  assert.equal(statValue({ name: "Удача ночью", value: "мусор" }, []), 0);
});

test("основы характеристик для стенда", () => {
  const sheet = { stats: [{ name: "Удача ночью", value: 5 }, { name: "удача  ночью", value: 9 }, { name: "", value: 1 }, { name: "Сила", value: 3 }] };
  assert.deepEqual(standStats(sheet), { "stat.удача_ночью": 5, "stat.сила": 3 });
  assert.deepEqual(standStats({}), {});
});

test("инициатива из поля листа", () => {
  assert.equal(initiativeFormula({ initiative: " 1к20 + 2 " }), "1d20+2");
  assert.equal(initiativeFormula({}), "");
  assert.equal(initiativeBase({ initiative: "3" }), 3);
  assert.equal(initiativeBase({ initiative: "-1" }), -1);
  assert.equal(initiativeBase({ initiative: "2d6" }), 0);
});

test("вид листа: D&D знаем поимённо, остальное — универсальный", () => {
  assert.equal(sheetKindOf("dnd5e-2014"), "dnd5e-2014");
  assert.equal(sheetKindOf("dnd5e-2024"), "dnd5e-2024");
  assert.equal(sheetKindOf("universal"), "universal");
  assert.equal(sheetKindOf("pathfinder-2e"), "universal");
  assert.equal(sheetKindOf(""), "universal");
});
