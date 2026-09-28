// Лист по схеме «Своей системы»: свободные характеристики с модификаторами
// stat.<ключ> (schema-formula.js), основы для стенда конструктора
// (universal-stats.js) и выбор вида листа по системе.
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { initiativeBase, standStats } from "../src/universal-stats.js";
import { compileSchema, createEvaluator } from "../src/schema-formula.js";
import { sheetKindOf } from "../src/system-profile.js";

const sheetSchema = compileSchema(JSON.parse(readFileSync(new URL("../../internal/schema/builtin/sheet.json", import.meta.url), "utf8")));
const statValue = (stat, mods) => createEvaluator(sheetSchema, { stats: [stat] }, mods).stat(stat.name);

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
  assert.equal(initiativeBase({ initiative: "3" }), 3);
  assert.equal(initiativeBase({ initiative: "-1" }), -1);
  assert.equal(initiativeBase({ initiative: "2d6" }), 0);
  assert.equal(initiativeBase({ initiative: "1d20 + @stat.ловкость" }), 0);
  assert.equal(initiativeBase({}), 0);
});

test("вид листа: D&D знаем поимённо, остальное — универсальный", () => {
  assert.equal(sheetKindOf("dnd5e-2014"), "dnd5e-2014");
  assert.equal(sheetKindOf("dnd5e-2024"), "dnd5e-2024");
  assert.equal(sheetKindOf("universal"), "universal");
  assert.equal(sheetKindOf("pathfinder-2e"), "universal");
  assert.equal(sheetKindOf(""), "universal");
});
