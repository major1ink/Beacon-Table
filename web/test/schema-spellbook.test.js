// Виджет заклинаний (schema-spellbook.js) и счётчик-строка (schema-layout.js).
import test from "node:test";
import assert from "node:assert/strict";

import { addDice, buildIndex, cantripTier, slotLevelsFrom, spellDamageText } from "../src/schema-spellbook.js";
import { cellPath, formatPool, parsePool } from "../src/schema-layout.js";

test("счётчик-строка: всего и потрачено", () => {
  assert.deepEqual(parsePool("4"), { total: 4, used: 0 });
  assert.deepEqual(parsePool("4/2"), { total: 4, used: 2 });
  assert.deepEqual(parsePool(" 3 / 9 "), { total: 3, used: 3 }, "потрачено не больше всего");
  assert.equal(parsePool("2 + 1 от подкласса"), null);
  assert.equal(parsePool(""), null);
  assert.equal(parsePool(undefined), null);
  assert.equal(formatPool(4, 0), "4");
  assert.equal(formatPool(4, 2), "4/2");
});

test("путь ячейки таблицы со строками", () => {
  const table = { path: "skillProf" };
  assert.equal(cellPath(table, { path: "{key}" }, { key: "stealth" }), "skillProf.stealth");
  assert.equal(cellPath({ path: "spellcasting.slotsByLevel" }, { path: "{key}" }, { key: "0" }), "spellcasting.slotsByLevel.0");
});

test("рубежи заговора и добавка кубов", () => {
  assert.deepEqual([1, 4, 5, 10, 11, 16, 17, 20].map(cantripTier), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(addDice("8к6 (огонь)", 2, "6"), "10к6 (огонь)");
  assert.equal(addDice("1к8", 1, "6"), "1к8 + 1к6");
  assert.equal(addDice("8к6", 0, "6"), "8к6");
});

test("урон заклинания: заговор, модификатор, усиление ячейкой", () => {
  const cantrip = { damage: "1к10 (огонь), +1к10 на 5/11/17 ур." };
  assert.equal(spellDamageText(cantrip, 0, 0, { level: 1 }), "1к10 (огонь)");
  assert.equal(spellDamageText(cantrip, 0, 0, { level: 11 }), "3к10 (огонь)");
  const heal = { damage: "2к8 + мод. заклинательной характеристики", upcast: "1к8" };
  assert.equal(spellDamageText(heal, 1, 1, { modifier: 3 }), "2к8+3");
  assert.equal(spellDamageText(heal, 1, 3, { modifier: -1 }), "4к8-1");
  assert.equal(spellDamageText({ damage: "" }, 1, 1), "");
  assert.equal(spellDamageText(null, 1, 1), "");
});

test("круги, с которых можно наложить", () => {
  assert.deepEqual(slotLevelsFrom(1, ["4/1", "2", "", "0"]), [1, 2]);
  assert.deepEqual(slotLevelsFrom(2, ["4", "2", "1"]), [2, 3]);
  assert.deepEqual(slotLevelsFrom(1, []), [1]);
});

test("карточка по названию: с хвостом «[English]» и без", () => {
  const index = buildIndex([{ name: "Свет [Light]", damage: "" }, { name: " ", damage: "x" }]);
  assert.equal(index.get("свет [light]").name, "Свет [Light]");
  assert.equal(index.get("свет").name, "Свет [Light]");
  assert.equal(index.size, 2);
});
