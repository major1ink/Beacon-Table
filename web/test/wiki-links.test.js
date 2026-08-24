// Вики-ссылки с папками: [[Глава 1/Таверна]] (см. web/src/notes/markdown.js).
// У заметок есть дерево папок (domain.Note.Folder), одноимённые записи в
// разных ветках — норма, поэтому проверяем именно правила выбора: точный
// путь, относительный, хвост пути и «ближайшая по дереву» для ссылки без пути.
import test from "node:test";
import assert from "node:assert/strict";

import { splitWikiTarget, resolveWikiTarget, wikiCreateTarget, renderNoteHtml } from "../src/notes/markdown.js";

// Библиотека-фикстура: два «Обзора» в разных главах и одна «Таверна» глубоко
// в импортированном из модуля дереве.
const notes = [
  { id: "root", title: "Кампания", folder: "" },
  { id: "c1-overview", title: "Обзор", folder: "Кампания/Глава 1" },
  { id: "c2-overview", title: "Обзор", folder: "Кампания/Глава 2" },
  { id: "margo", title: "Марго", folder: "Кампания/Глава 1/NPC" },
  { id: "tavern", title: "Таверна", folder: "Модуль/Rules/Глава 1" },
];

test("splitWikiTarget разбирает путь и чистит лишние слэши", () => {
  assert.deepEqual(splitWikiTarget("Таверна"), { folder: "", title: "Таверна" });
  assert.deepEqual(splitWikiTarget("Глава 1/Таверна"), { folder: "Глава 1", title: "Таверна" });
  assert.deepEqual(splitWikiTarget("/Кампания//Глава 1/Обзор/"), { folder: "Кампания/Глава 1", title: "Обзор" });
  assert.deepEqual(splitWikiTarget("  Глава 1/Таверна  "), { folder: "Глава 1", title: "Таверна" });
});

test("точный путь выбирает нужного тёзку", () => {
  assert.equal(resolveWikiTarget("Кампания/Глава 2/Обзор", notes).id, "c2-overview");
  assert.equal(resolveWikiTarget("кампания/глава 1/обзор", notes).id, "c1-overview");
});

test("путь без начала считается относительно папки текущей заметки", () => {
  // Из «Кампания/Глава 1» ссылка [[NPC/Марго]] ведёт в свою же подпапку.
  assert.equal(resolveWikiTarget("NPC/Марго", notes, "Кампания/Глава 1").id, "margo");
});

test("хвоста пути достаточно для глубокого дерева модуля", () => {
  assert.equal(resolveWikiTarget("Глава 1/Таверна", notes).id, "tavern");
});

test("указанный путь, которого нет, не подменяется тёзкой из другой папки", () => {
  assert.equal(resolveWikiTarget("Другая ветка/Обзор", notes), null);
});

test("ссылка без пути ведёт в свою папку, а не к первому тёзке", () => {
  assert.equal(resolveWikiTarget("Обзор", notes, "Кампания/Глава 2").id, "c2-overview");
  // Из соседней ветки — ближайший по общему пути, а не случайный.
  assert.equal(resolveWikiTarget("Обзор", notes, "Кампания/Глава 1/NPC").id, "c1-overview");
});

test("несуществующая заметка создаётся рядом или по указанному пути", () => {
  assert.deepEqual(wikiCreateTarget("Погреб", notes, "Кампания/Глава 1"), {
    title: "Погреб",
    folder: "Кампания/Глава 1",
  });
  // Относительный путь на существующую ветку — внутрь неё.
  assert.deepEqual(wikiCreateTarget("NPC/Трактирщик", notes, "Кампания/Глава 1"), {
    title: "Трактирщик",
    folder: "Кампания/Глава 1/NPC",
  });
  // Незнакомая ветка трактуется как абсолютный путь.
  assert.deepEqual(wikiCreateTarget("Новый модуль/Пролог", notes, "Кампания/Глава 1"), {
    title: "Пролог",
    folder: "Новый модуль",
  });
});

test("в тексте видно только заголовок, путь уходит в подсказку", () => {
  const html = renderNoteHtml("см. [[Кампания/Глава 2/Обзор]] и [[Марго|её]]");
  assert.match(html, />Обзор</);
  assert.doesNotMatch(html, />Кампания\/Глава 2\/Обзор</);
  assert.match(html, /title="Кампания\/Глава 2\/Обзор"/);
  assert.match(html, />её</); // своя подпись через | не тронута
  // Цель ссылки — полный путь, percent-encoded (см. renderNoteHtml).
  assert.match(html, /href="wikilink:%D0%9A/);
});

// Регрессия: инлайн-бросок Foundry "[[/r d100]]{20d100}", не разобранный
// заранее (одиночный JSON-импорт карточки, см. web/src/foundry-text.js),
// раньше матчился wikiLinkRe как обычная вики-ссылка — превращался в ссылку
// в никуда "[r d100](wikilink:%2Fr%20d100)" и на карточке предмета выглядел
// битым текстом посреди таблицы (см. также internal/foundry/rolls.go —
// пакетный импорт целого модуля эту разметку уже разбирает на сервере, здесь
// проверяем только клиентский рендер как страховку).
test("макрос Foundry [[/...]] не матчится как вики-ссылка", () => {
  const html = renderNoteHtml("[[/r d100]]{20d100}");
  assert.doesNotMatch(html, /wikilink:/);
  // Обычная вики-ссылка на заметку с "/" внутри пути по-прежнему работает —
  // условие бьёт только по ПЕРВОМУ символу цели, не по слэшам вообще.
  const withPath = renderNoteHtml("[[Кампания/Глава 1/NPC/Марго]]");
  assert.match(withPath, /wikilink:/);
});
