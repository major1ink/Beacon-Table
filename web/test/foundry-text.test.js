// foundry-text.test.js — cleanFoundryText (см. web/src/foundry-text.js).
// Регрессия конкретного случая: карточка предмета "Ковёр-самолёт", импортированная
// одиночным JSON-файлом (в обход пакетного импорта модуля, см.
// web/src/pages/itembook.js: «Импортировать вставленный JSON»), приносила
// необработанный "[[/r d100]]{20d100}" — тот и ломался об wikiLinkRe заметок
// (см. wiki-links.test.js), и просто не был кликабельной формулой.
import test from "node:test";
import assert from "node:assert/strict";

const { cleanFoundryText } = await import("../src/foundry-text.js");

test("ссылка на компендиум — остаётся только подпись", () => {
  assert.equal(cleanFoundryText("см. @UUID[Compendium.dnd5e.rules.abc]{Скрытность}"), "см. Скрытность");
  assert.equal(cleanFoundryText("@Compendium[world.items.xyz]{Amulet}"), "Amulet");
});

test("бросок с подписью в фигурных скобках не теряет ни то, ни другое", () => {
  // Ровно случай из карточки "Ковёр-самолёт": таблица размеров ковра.
  assert.equal(cleanFoundryText("[[/r d100]]{20d100}"), "20d100 (d100)");
  assert.equal(cleanFoundryText("[[/roll 2d6 + 3]]{Урон}"), "Урон (2d6 + 3)");
});

test("бросок без подписи остаётся голой формулой — кликабельной её делает inline-rolls.js", () => {
  assert.equal(cleanFoundryText("Наносит [[/r 2d6]] урона."), "Наносит 2d6 урона.");
});

test("атака 1d20 без своей подписи вырезается целиком — рядом обычно уже посчитанный модификатор", () => {
  assert.equal(cleanFoundryText("Бонус к попаданию +5, [[/r 1d20+5]] на атаку."), "Бонус к попаданию +5, на атаку.");
});

test("атака 1d20 С подписью — подпись остаётся", () => {
  assert.equal(cleanFoundryText("[[/r 1d20+5]]{К попаданию}"), "К попаданию (1d20+5)");
});

test("отложенный бросок без команды (без ведущего /) тоже становится формулой", () => {
  assert.equal(cleanFoundryText("[[2d6]]"), "2d6");
});

test("незнакомая команда без подписи убирается, с подписью — остаётся подпись", () => {
  assert.equal(cleanFoundryText("Толкает вас: [[/check ability=str dc=12]]"), "Толкает вас:");
  assert.equal(cleanFoundryText("[[/save dex 15]]{Спасбросок Ловкости}"), "Спасбросок Ловкости");
});

test("пусто/не-строка не падают", () => {
  assert.equal(cleanFoundryText(""), "");
  assert.equal(cleanFoundryText(undefined), "");
  assert.equal(cleanFoundryText(null), "");
});

test("текст без макросов Foundry не меняется (кроме обрезки краёв)", () => {
  assert.equal(cleanFoundryText("  <p>Обычное описание.</p>  "), "<p>Обычное описание.</p>");
});
