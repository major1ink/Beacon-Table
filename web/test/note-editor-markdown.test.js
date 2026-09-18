// markdown → документ редактора → markdown без потерь (src/notes/editor.js).
// Без DOM: сырой HTML (<u>, catalog-ref) тут не разбирается, не проверяем.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownManager } from "@tiptap/markdown";
import { noteExtensions } from "../src/notes/editor.js";

const manager = new MarkdownManager({ extensions: noteExtensions(), markedOptions: { breaks: true, gfm: true } });
const roundTrip = (md) => manager.serialize(manager.parse(md));

test("вики-ссылки не экранируются", () => {
  const md = "# Т\n\nСм. [[Глава 1/Таверна]] и [[Марго|хозяйку]] и макрос [[/r 2d6]].";
  assert.equal(roundTrip(md), md);
});

test("метки и формулы остаются текстом", () => {
  const md = "# Т\n\n#нпс/таверна бросок 1d6+2 и +4 к попаданию.";
  assert.equal(roundTrip(md), md);
});

test("врезка «зачитать вслух» — тот же формат, что писал старый тулбар", () => {
  const md = '# Т\n\n<aside class="beacon-readaloud">\n\n**Читать** вслух.\n\nВторой абзац.\n\n</aside>\n\nДальше.';
  assert.equal(roundTrip(md), md);
});

test("врезка Foundry в одну строку разбирается в callout", () => {
  const md = '# Т\n\n<section class="beacon-dm-note">Совет Мастеру.</section>\n';
  const doc = manager.parse(md);
  const callout = doc.content.find((n) => n.type === "callout");
  assert.ok(callout);
  assert.equal(callout.attrs.kind, "dmnote");
});

test("страницы — разделы второго уровня — и перевод строки внутри абзаца", () => {
  const md = "# Т\n\nстрока раз  \nстрока два\n\n## Страница\n\n- пункт *курсив* ~~зач~~\n- ещё";
  assert.equal(roundTrip(md), md);
});

test("чекбоксы «- [ ]» из Obsidian, вложенные тоже", () => {
  const md = "# Т\n\n- [ ] купить\n- [x] сделано\n  - [ ] вложенный";
  assert.equal(roundTrip(md), md);
});
