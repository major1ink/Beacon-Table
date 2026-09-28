// inline-rolls.test.js — rollContextLabel (см. web/src/inline-rolls.js):
// подпись инлайн-броска в общем логе выводится из текста вокруг формулы.
// Проверяем именно её, а не обход DOM в enhanceRolls (jsdom в зависимостях
// нет) — вся неочевидная логика тут в чистой функции.
import test from "node:test";
import assert from "node:assert/strict";

import { rollContextLabel } from "../src/inline-rolls.js";

// Синтезированная строка атаки оружия (см. weaponAttackLine в
// monster-import.js): "Рукопашная атака оружием: +4 к попаданию,
// досягаемость 5 фт. Попадание: 5 (1к6 + 2), рубящий."
test("«+4 к попаданию» → подпись «попадание»", () => {
  assert.equal(rollContextLabel("Рукопашная атака оружием: ", " к попаданию, досягаемость 5 фт."), "попадание");
});

test("«+4 на попадание» (ручной текст ДМ) → «попадание»", () => {
  assert.equal(rollContextLabel("Дальнобойная атака оружием: ", " на попадание, дистанция 24/96 м."), "попадание");
});

test("блок урона после «Попадание:» → подпись «урон»", () => {
  assert.equal(
    rollContextLabel("Рукопашная атака оружием: +4 к попаданию, досягаемость 5 фт. Попадание: 5 (", "), рубящий."),
    "урон"
  );
});

test("второй блок урона того же удара (в том же предложении) → «урон»", () => {
  assert.equal(
    rollContextLabel("... Попадание: 5 (1к6 + 2), рубящий; 7 (", "), яд."),
    "урон"
  );
});

test("проза «получает 8к6 урона» → «урон»", () => {
  assert.equal(rollContextLabel("Существо получает ", " урона огнём."), "урон");
});

test("нет узнаваемого контекста (спасбросок в статблоке) → пусто, подписью останется формула", () => {
  assert.equal(rollContextLabel("Спасброски: Тел ", ", Мдр +2"), "");
  assert.equal(rollContextLabel("", ""), "");
});

test("«Попадание:» из прошлого предложения не липнет к следующему броску", () => {
  assert.equal(rollContextLabel("Попадание: 5 (1к6), рубящий. Существо совершает спасбросок Ловкости ", "."), "");
});

// Куб проверки системы (GET /api/system: rolls.check) и подписи по
// сокращениям из схемы (short у поля).
import { namedLabel, rollFormula, statNames } from "../src/inline-rolls.js";

test("голый модификатор бросается кубом проверки системы", () => {
  assert.equal(rollFormula("+4", "1d20"), "1d20+4");
  assert.equal(rollFormula("-1", "2к6"), "2d6-1");
  assert.equal(rollFormula("+0", "1d20"), "1d20");
  assert.equal(rollFormula("+4", ""), null, "без куба проверки голый модификатор не бросается");
  assert.equal(rollFormula("1к6 + 2", ""), "1d6+2", "формула с кубом от куба проверки не зависит");
  assert.equal(rollFormula("d100", "1d20"), "d100");
});

test("подпись по короткому или полному названию поля схемы", () => {
  const names = statNames([
    { fields: { dex: { type: "number", label: "Ловкость", short: "Лов" }, str: { type: "number", label: "Сила" } } },
    { fields: { skills: { type: "table", label: "Навыки", columns: [{ id: "x", label: "Ловкость рук", short: "ЛР" }] } } },
    null,
  ]);
  assert.equal(namedLabel("Спасброски: Лов ", names), "Ловкость");
  assert.equal(namedLabel("Спасброски: Лов +5, Мдр +2, лов. ", names), "Ловкость");
  assert.equal(namedLabel("Ловкость ", names), "Ловкость");
  assert.equal(namedLabel("Навыки: Ловкость рук ", names), "Ловкость рук");
  assert.equal(namedLabel("ЛР ", names), "Ловкость рук");
  assert.equal(namedLabel("Сила ", names), "", "без short поле в словарь не попадает");
  assert.equal(namedLabel("Лов (", names), "", "название должно стоять прямо перед формулой");
  assert.equal(namedLabel("Лов ", new Map()), "");
});
