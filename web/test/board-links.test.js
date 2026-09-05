// Связь элемента доски с записью журнала (см. web/src/board/links.js).
// Ссылка хранится обсидиановским [[Название]] — тем же, что кладёт в файл
// плагин Excalidraw, поэтому разбирать надо и его синтаксис с | и #.
import test from "node:test";
import assert from "node:assert/strict";

import { parseWikilink, wikilink, findEntryByTitle } from "../src/board/links.js";

const entries = [
  { id: "e1", title: "Таверна", folder: "Глава 1" },
  { id: "e2", title: "Кладбище Нортбриджа", folder: "" },
  { id: "e3", title: "Таверна", folder: "Глава 2" },
];

test("parseWikilink достаёт название", () => {
  assert.equal(parseWikilink("[[Таверна]]"), "Таверна");
  assert.equal(parseWikilink("  [[Таверна]]  "), "Таверна");
  assert.equal(parseWikilink("[[Кладбище Нортбриджа]]"), "Кладбище Нортбриджа");
});

test("parseWikilink понимает подпись и раздел", () => {
  assert.equal(parseWikilink("[[Таверна|у Марго]]"), "Таверна");
  assert.equal(parseWikilink("[[Таверна#Второй этаж]]"), "Таверна");
  assert.equal(parseWikilink("[[Таверна#Второй этаж|наверху]]"), "Таверна");
});

test("parseWikilink не трогает обычные адреса", () => {
  assert.equal(parseWikilink("https://example.com"), null);
  assert.equal(parseWikilink("/journal.html?id=e1"), null);
  assert.equal(parseWikilink("[[]]"), null);
  assert.equal(parseWikilink(""), null);
  assert.equal(parseWikilink(null), null);
  assert.equal(parseWikilink(undefined), null);
});

test("wikilink и parseWikilink обратимы", () => {
  for (const title of ["Таверна", "Кладбище Нортбриджа", "Глава 1 — начало"]) {
    assert.equal(parseWikilink(wikilink(title)), title);
  }
});

test("findEntryByTitle ищет без учёта регистра и пробелов по краям", () => {
  assert.equal(findEntryByTitle(entries, "Таверна").id, "e1");
  assert.equal(findEntryByTitle(entries, "  таверна  ").id, "e1");
  assert.equal(findEntryByTitle(entries, "КЛАДБИЩЕ НОРТБРИДЖА").id, "e2");
});

test("findEntryByTitle на одноимённых берёт первую, на чужой — null", () => {
  // Одноимённые записи в разных папках нормальны; какую имел в виду ваулт,
  // угадывать не по чему.
  assert.equal(findEntryByTitle(entries, "Таверна").folder, "Глава 1");
  assert.equal(findEntryByTitle(entries, "Крепость"), null);
  assert.equal(findEntryByTitle([], "Таверна"), null);
});
