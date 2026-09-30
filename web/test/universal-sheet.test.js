// Лист по схеме «Своей системы»: свободные характеристики с модификаторами
// stat.<ключ> (schema-formula.js), основы для стенда конструктора
// (universal-stats.js) и условия видимости импорта (импортёры системы).
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { standStats } from "../src/universal-stats.js";
import { initiativeBase } from "../src/schema-summary.js";
import { compileSchema, createEvaluator } from "../src/schema-formula.js";
import { hasImporter } from "../src/system-profile.js";
import { schemaHasPath, schemaHasWidget } from "../src/schema-layout.js";

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

test("инициатива для стенда: постоянная часть формулы из поля листа", () => {
  const rule = { rollField: "initiative" };
  const base = (sheet) => initiativeBase(sheetSchema, sheet, rule);
  assert.equal(base({ initiative: "3" }), 3);
  assert.equal(base({ initiative: "-1" }), -1);
  assert.equal(base({ initiative: "2d6" }), 0);
  assert.equal(base({ initiative: "1d20 + @stat.ловкость", stats: [{ name: "Ловкость", value: 4 }] }), 4);
  assert.equal(base({}), 0);
  assert.equal(initiativeBase(sheetSchema, { initiative: "3" }, null), 0);
});

test("импортёры системы: до загрузки профиля нет ни одного", () => {
  assert.equal(hasImporter("foundry-dnd5e"), false);
  assert.equal(hasImporter("lss"), false);
});

test("схема листа: поле «Вид» в info.race только у D&D 2014, виджет заклинаний у D&D", () => {
  const sheet = (system) => JSON.parse(readFileSync(new URL(`../../cmd/beacon-table/systemdata/schemas/${system}/sheet.json`, import.meta.url), "utf8"));
  assert.equal(schemaHasPath(sheet("dnd5e-2014"), "info.race"), true);
  assert.equal(schemaHasPath(sheet("dnd5e-2024"), "info.race"), false);
  assert.equal(schemaHasWidget(sheet("dnd5e-2014"), "spellbook"), true);
  assert.equal(schemaHasWidget(sheet("dnd5e-2024"), "spellbook"), true);
  assert.equal(schemaHasPath(sheetSchema.schema, "info.race"), false);
  assert.equal(schemaHasWidget(sheetSchema.schema, "spellbook"), false);
  assert.equal(schemaHasPath(null, "info.race"), false);
});
